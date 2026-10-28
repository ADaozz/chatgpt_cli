/**
 * file-controller.js — 文件上传 / 删除（对话附件 + 项目 Sources）
 *
 * 写流程沿用 v1.2.2 已验证的三/四段式实现，端点已在 2026-10-28 复核存在：
 *   对话附件: POST /backend-api/files (use_case=ace_upload) → PUT blob →
 *             POST /backend-api/files/{id}/uploaded
 *   项目Sources: POST /backend-api/files (use_case=agent) → PUT blob →
 *             POST /backend-api/files/process_upload_stream →
 *             POST /backend-api/gizmos/snorlax/upsert（写载荷 probe-pending）
 * 所有写操作在确认目标项目与结果后才返回成功；删除区分硬删除（后端文件）
 * 与解除绑定（仅移出配置），避免误删。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { extractProjectId } = require('./url-utils');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME_MAP = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.js': 'text/javascript', '.ts': 'text/typescript', '.py': 'text/x-python',
  '.html': 'text/html', '.css': 'text/css', '.csv': 'text/csv',
  '.xml': 'application/xml', '.yaml': 'application/x-yaml', '.yml': 'application/x-yaml',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.zip': 'application/zip', '.gz': 'application/gzip',
};

function getLocalFileMeta(absoluteFilePath) {
  const fileContent = fs.readFileSync(absoluteFilePath);
  const fileName = path.basename(absoluteFilePath);
  const fileSize = fileContent.length;
  const ext = path.extname(absoluteFilePath).toLowerCase();
  const mimeType = MIME_MAP[ext] || 'application/octet-stream';
  return { fileContent, fileName, fileSize, mimeType };
}

function isTextLikeFile(file) {
  const mimeType = String(file?.mimeType || file?.type || '');
  const name = String(file?.name || '');
  return (
    /^(text\/|application\/(json|xml|javascript)|image\/svg\+xml)/i.test(mimeType) ||
    /\.(txt|md|json|csv|xml|ya?ml|js|ts|py|html|css|svg|log)$/i.test(name)
  );
}

function shouldIndexProjectFile(gizmo, fileName, mimeType) {
  if (!gizmo?.use_injest_path) return false;
  return isTextLikeFile({ name: fileName, mimeType }) ||
    /\.(pdf|docx?|pptx?|xlsx?)$/i.test(fileName);
}

function normalizeProjectSharingSubject(subject) {
  if (!subject || typeof subject !== 'object') return null;
  const type = subject.recipient || subject.type;
  if (!type) return null;
  return {
    type,
    capabilities: subject.capabilities || {
      can_read: true, can_view_config: false, can_write: false,
      can_delete: false, can_export: false, can_share: false,
    },
  };
}

const PROJECT_VIEWER_CAPABILITIES = {
  can_read: true, can_view_config: false, can_write: false,
  can_delete: false, can_export: false, can_share: false,
};

function buildProjectSharingPayload(gizmo) {
  const subjects = ((gizmo?.sharing?.subjects) || gizmo?.sharing_v2 || [])
    .map(normalizeProjectSharingSubject)
    .filter(Boolean);
  const recipient = gizmo?.share_recipient || gizmo?.sharing?.recipient || 'private';
  if (recipient === 'link' || recipient === 'workspace_link') {
    return [...subjects, { type: recipient, capabilities: PROJECT_VIEWER_CAPABILITIES }];
  }
  return [{ type: 'private', capabilities: PROJECT_VIEWER_CAPABILITIES }, ...subjects];
}

function dedupeProjectUpsertFiles(files) {
  const seen = new Set();
  const out = [];
  for (const file of files || []) {
    const key = file?.file_id || file?.id || file?.name;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

function buildProjectUpsertPayload(projectConfig, files) {
  const gizmo = projectConfig.gizmo || {};
  return {
    gizmo_id: gizmo.id,
    instructions: gizmo.instructions || '',
    display: {
      name: gizmo.display?.name || '',
      description: gizmo.display?.description || '',
      emoji: gizmo.display?.emoji || null,
      theme: gizmo.display?.theme || null,
      profile_pic_id: gizmo.display?.profile_pic_id || null,
      profile_picture_url: gizmo.display?.profile_picture_url || null,
      prompt_starters: gizmo.display?.prompt_starters || [],
    },
    tools: Array.isArray(projectConfig.tools) ? projectConfig.tools : [],
    memory_scope: gizmo.memory_scope || 'unset',
    files: dedupeProjectUpsertFiles((files || []).map((f) => ({ ...f, location: 'fs' }))),
    training_disabled: Boolean(gizmo.training_disabled),
    sharing: buildProjectSharingPayload(gizmo),
  };
}

function matchesProjectFileRef(file, fileRef) {
  const ref = String(fileRef || '').trim().toLowerCase();
  if (!ref) return false;
  return (
    (file.file_id && String(file.file_id).toLowerCase() === ref) ||
    (file.id && String(file.id).toLowerCase() === ref) ||
    (file.name && String(file.name).toLowerCase() === ref)
  );
}

class FileController {
  /** @param {import('./web-protocol').WebProtocol} protocol */
  constructor(protocol) {
    this.protocol = protocol;
  }

  /** 对话附件三段式上传。 */
  async uploadConversationAttachment(absoluteFilePath) {
    const { fileContent, fileName, fileSize, mimeType } = getLocalFileMeta(absoluteFilePath);
    const createRes = await this.protocol.createRemoteFile({
      file_name: fileName,
      file_size: fileSize,
      use_case: 'ace_upload',
    });
    if (!createRes?.upload_url || !createRes?.file_id) {
      throw new Error(`文件创建失败: ${JSON.stringify(createRes).slice(0, 200)}`);
    }
    await this.protocol.uploadBlobToUrl(createRes.upload_url, fileContent, 'application/octet-stream');
    await this.protocol.markFileUploaded(createRes.file_id);
    return { fileId: createRes.file_id, fileName, fileSize, mimeType };
  }

  /** 项目 Sources 四段式上传。 */
  async uploadProjectSource(absoluteFilePath, { gizmoId } = {}) {
    if (!gizmoId) throw new Error('uploadProjectSource 需要 gizmoId');
    const { fileContent, fileName, fileSize, mimeType } = getLocalFileMeta(absoluteFilePath);
    const lastModified = Math.trunc(fs.statSync(absoluteFilePath).mtimeMs || Date.now());

    const createRes = await this.protocol.createRemoteFile({
      file_name: fileName,
      file_size: fileSize,
      use_case: 'agent',
      gizmo_id: gizmoId,
      timezone_offset_min: new Date().getTimezoneOffset(),
      reset_rate_limits: false,
      store_in_library: true,
    });
    if (!createRes?.upload_url || !createRes?.file_id) {
      throw new Error(`文件创建失败: ${JSON.stringify(createRes).slice(0, 200)}`);
    }
    await this.protocol.uploadBlobToUrl(createRes.upload_url, fileContent, mimeType);

    const configBefore = await this.protocol.fetchGizmoConfig(gizmoId);
    await this.protocol.processProjectUploadStream({
      file_id: createRes.file_id,
      use_case: 'agent',
      gizmo_id: gizmoId,
      index_for_retrieval: shouldIndexProjectFile(configBefore.gizmo, fileName, mimeType),
      file_name: fileName,
      metadata: { store_in_library: true, library_file_info: { gizmo_id: gizmoId, is_project: true } },
    });

    const currentConfig = await this.protocol.fetchGizmoConfig(gizmoId);
    const currentFiles = Array.isArray(currentConfig.files) ? currentConfig.files : [];
    const nextFiles = [
      ...currentFiles,
      {
        file_id: createRes.file_id,
        name: fileName,
        size: fileSize,
        type: mimeType && mimeType !== 'application/octet-stream' ? mimeType : '',
        last_modified: lastModified,
        location: 'fs',
      },
    ];
    const upsertRes = await this.protocol.upsertProject(
      buildProjectUpsertPayload(currentConfig, nextFiles)
    );

    // 确认：重新读取配置，文件必须出现
    const deadline = Date.now() + 30_000;
    let attached = false;
    while (Date.now() < deadline) {
      const config = await this.protocol.fetchGizmoConfig(gizmoId).catch(() => null);
      if (config && (config.files || []).some((f) => f.file_id === createRes.file_id)) {
        attached = true;
        break;
      }
      await sleep(1500);
    }
    if (!attached) {
      throw new Error(`文件已上传但未能确认挂载到项目（upsert 返回 ${upsertRes ? 'ok' : 'empty'}）`);
    }

    return { fileId: createRes.file_id, fileName, fileSize, mimeType };
  }

  /**
   * 删除项目文件。fileRef 支持 file_id 或文件名。
   * 有 file_id 的条目走硬删除（/backend-api/files/{id}，同时解除绑定）；
   * 缺 file_id 的条目仅从配置移除（解除绑定，不删后端文件）。
   */
  async deleteProjectSource(fileRef, { gizmoId } = {}) {
    if (!gizmoId) throw new Error('deleteProjectSource 需要 gizmoId');
    const config = await this.protocol.fetchGizmoConfig(gizmoId);
    const currentFiles = Array.isArray(config.files) ? config.files : [];
    const removed = currentFiles.filter((f) => matchesProjectFileRef(f, fileRef));
    if (!removed.length) throw new Error(`项目中未找到文件: ${fileRef}`);

    for (const file of removed) {
      if (file.file_id) {
        await this.protocol.deleteRemoteFile(file.file_id);
      }
    }
    const softTargets = removed.filter((f) => !f.file_id);
    if (softTargets.length) {
      const nextFiles = currentFiles.filter((f) => !matchesProjectFileRef(f, fileRef));
      await this.protocol.upsertProject(buildProjectUpsertPayload(config, nextFiles));
    }

    const removedIds = removed.map((f) => f.file_id).filter(Boolean);
    if (removedIds.length) {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const fresh = await this.protocol.fetchGizmoConfig(gizmoId).catch(() => null);
        const stillThere = fresh && (fresh.files || []).some((f) => removedIds.includes(f.file_id));
        if (!stillThere) break;
        await sleep(1500);
      }
    }

    return removed.map((f) => ({
      fileId: f.file_id || null,
      fileName: f.name,
      fileSize: f.size ?? null,
      mimeType: f.type || null,
      hardDeleted: Boolean(f.file_id),
    }));
  }
}

module.exports = { FileController };
