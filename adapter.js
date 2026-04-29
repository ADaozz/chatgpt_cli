/**
 * adapter.js — ChatGPT DOM 操作的隔离层
 *
 * 架构约束：
 *   - 这一层是唯一允许直接操作 `page` 的层
 *   - 不持有状态，所有操作都是 page + 参数 → 结果 的纯函数形式
 *   - 不抛出业务错误，只抛出操作错误（超时、元素不存在）
 */

const S = require('./selectors');
const path = require('path');
const fs = require('fs');

const DEFAULT_TIMEOUT = 15_000;
const REPLY_TIMEOUT = 600_000; // GPT-5-4-Pro extended thinking can take 5+ minutes
const PROJECT_VIEWER_CAPABILITIES = {
  can_read: true,
  can_view_config: false,
  can_write: false,
  can_delete: false,
  can_export: false,
  can_share: false,
};

// ── 内部工具 ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitAndClick(page, selector, timeout = DEFAULT_TIMEOUT) {
  const el = await page.waitForSelector(selector, { timeout });
  await el.click();
  return el;
}

async function waitForAbsent(page, selector, timeout = DEFAULT_TIMEOUT) {
  await page.waitForSelector(selector, { hidden: true, timeout });
}

async function waitForEnabled(page, selector, timeout = DEFAULT_TIMEOUT) {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      return !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    },
    { timeout },
    selector
  );
}

function getLocalFileMeta(absoluteFilePath) {
  const fileContent = fs.readFileSync(absoluteFilePath);
  const fileName = path.basename(absoluteFilePath);
  const fileSize = fileContent.length;

  const ext = path.extname(absoluteFilePath).toLowerCase();
  const mimeMap = {
    '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
    '.js': 'text/javascript', '.ts': 'text/typescript', '.py': 'text/x-python',
    '.html': 'text/html', '.css': 'text/css', '.csv': 'text/csv',
    '.xml': 'application/xml', '.yaml': 'application/x-yaml', '.yml': 'application/x-yaml',
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.zip': 'application/zip', '.gz': 'application/gzip',
  };
  const mimeType = mimeMap[ext] || 'application/octet-stream';

  return { fileContent, fileName, fileSize, mimeType };
}

async function getProjectFileInput(page) {
  const existingHandle = await page.evaluateHandle((sel) => {
    const inputs = Array.from(document.querySelectorAll(sel));
    return inputs.find((el) => el.closest('[role="dialog"]')) || null;
  }, S.files.fileInput);
  const existingInput = existingHandle.asElement();
  if (existingInput) {
    return existingInput;
  }

  const beforeCount = await page.evaluate(
    (sel) => document.querySelectorAll(sel).length,
    S.files.fileInput
  );

  await waitAndClick(page, S.files.projectModalTrigger);

  try {
    await page.waitForFunction(
      (sel, prevCount) => {
        const inputs = Array.from(document.querySelectorAll(sel));
        return (
          inputs.length > prevCount ||
          inputs.some((el) => Boolean(el.closest('[role="dialog"]')))
        );
      },
      { timeout: DEFAULT_TIMEOUT },
      S.files.fileInput,
      beforeCount
    );
  } catch {
    // 某些版本不会新增 input，而是直接复用已存在的隐藏 input。
  }

  const handle = await page.evaluateHandle((sel) => {
    const inputs = Array.from(document.querySelectorAll(sel));
    return (
      inputs.find((el) => el.closest('[role="dialog"]')) ||
      inputs[inputs.length - 1] ||
      null
    );
  }, S.files.fileInput);

  const input = handle.asElement();
  if (!input) {
    throw new Error('找不到项目文件上传输入框');
  }
  return input;
}

function normalizeLookupText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

function isLikelyFilename(value) {
  return /[a-z0-9][a-z0-9._ -]*\.(txt|md|json|csv|xml|ya?ml|pdf|png|jpe?g|gif|svg|zip|gz|py|js|ts|html|css|docx?|xlsx?|pptx?|rtf)$/i
    .test(String(value || '').trim());
}

function isTextLikeFile(file) {
  const mimeType = String(file?.mimeType || '');
  const name = String(file?.name || '');
  return (
    /^(text\/|application\/(json|xml|javascript)|image\/svg\+xml)/i.test(
      mimeType
    ) ||
    /\.(txt|md|json|csv|xml|ya?ml|js|ts|py|html|css|svg|log)$/i.test(name)
  );
}

function dedupeFiles(files) {
  const seen = new Set();
  const out = [];
  for (const file of files || []) {
    const key = [file?.id || '', file?.url || '', file?.name || ''].join('|');
    if (!key.replace(/\|/g, '')) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

function getAttachmentContent(value) {
  if (!value || typeof value !== 'object') return null;
  const chunks = [
    value.content,
    value.text,
    value.preview_text,
    value.extracted_text,
    value.excerpt,
    value.summary,
  ]
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim());
  return chunks.length ? chunks.join('\n\n') : null;
}

function normalizeFileCandidate(value) {
  if (!value || typeof value !== 'object') return null;

  const name =
    [
      value.name,
      value.file_name,
      value.filename,
      value.display_name,
      value.title,
    ].find((item) => typeof item === 'string' && item.trim()) || null;

  const url =
    [
      value.download_url,
      value.downloadUrl,
      value.url,
      value.href,
    ].find((item) => typeof item === 'string' && item.trim()) || null;

  const mimeType =
    [
      value.mimeType,
      value.mime_type,
      value.content_type,
    ].find((item) => typeof item === 'string' && item.trim()) || null;

  const rawId =
    value.file_id ??
    value.fileId ??
    value.asset_pointer ??
    null;

  const rawSize = value.file_size ?? value.fileSize ?? value.size ?? null;
  const size =
    typeof rawSize === 'number'
      ? rawSize
      : Number.isFinite(Number(rawSize))
        ? Number(rawSize)
        : null;

  const hasFileSignal = Boolean(
    value.file_id ||
      value.asset_pointer ||
      value.mimeType ||
      value.mime_type ||
      value.file_size != null ||
      (url && /\/files\/|download|blob:/i.test(url)) ||
      (name && isLikelyFilename(name))
  );

  if (!hasFileSignal) return null;

  return {
    id: rawId == null ? null : String(rawId),
    name,
    mimeType: mimeType ? String(mimeType) : null,
    size,
    url,
    content: getAttachmentContent(value),
  };
}

function extractFilesFromValue(value, bucket = []) {
  if (!value) return bucket;
  if (Array.isArray(value)) {
    for (const item of value) extractFilesFromValue(item, bucket);
    return bucket;
  }
  if (typeof value !== 'object') return bucket;

  const candidate = normalizeFileCandidate(value);
  if (candidate) bucket.push(candidate);

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      extractFilesFromValue(child, bucket);
    }
  }

  return bucket;
}

function normalizeContentParts(parts) {
  if (!Array.isArray(parts)) return [];

  const chunks = [];
  for (const part of parts) {
    if (typeof part === 'string' && part.trim()) {
      chunks.push(part.trim());
      continue;
    }
    if (!part || typeof part !== 'object') continue;

    if (typeof part.text === 'string' && part.text.trim()) {
      chunks.push(part.text.trim());
      continue;
    }
    if (typeof part.content === 'string' && part.content.trim()) {
      chunks.push(part.content.trim());
      continue;
    }
    if (Array.isArray(part.parts)) {
      chunks.push(...normalizeContentParts(part.parts));
    }
  }

  return chunks;
}

function normalizeConversationApiPayload(payload) {
  if (!payload || typeof payload !== 'object' || !payload.mapping) {
    return null;
  }

  const nodes = Object.values(payload.mapping)
    .filter((node) => node?.message)
    .sort((a, b) => {
      const aTime = a.message?.create_time ?? 0;
      const bTime = b.message?.create_time ?? 0;
      return aTime - bTime;
    });

  const messages = nodes
    .map((node) => {
      const message = node.message;
      const files = dedupeFiles(
        extractFilesFromValue({
          content: message.content,
          metadata: message.metadata,
          attachments: message.attachments,
        })
      );

      return {
        id: message.id || node.id || null,
        role: message.author?.role || 'unknown',
        text: normalizeContentParts(message.content?.parts).join('\n\n').trim(),
        files,
        createTime: message.create_time || null,
      };
    })
    .filter((message) => message.text || message.files.length);

  if (!messages.length) {
    return null;
  }

  return {
    id: payload.conversation_id || payload.id || null,
    title: payload.title || null,
    messages,
    files: dedupeFiles(messages.flatMap((message) => message.files)),
    source: 'api',
  };
}

function mergeConversationSnapshots(primary, secondary) {
  if (!primary) return secondary;
  if (!secondary) return primary;

  const mergedMessages = [];
  const maxLen = Math.max(primary.messages.length, secondary.messages.length);

  for (let i = 0; i < maxLen; i++) {
    const a = primary.messages[i];
    const b = secondary.messages[i];
    if (a && b) {
      mergedMessages.push({
        id: a.id || b.id || null,
        role: a.role !== 'unknown' ? a.role : b.role,
        text: a.text || b.text || '',
        files: dedupeFiles([...(a.files || []), ...(b.files || [])]),
        createTime: a.createTime ?? b.createTime ?? null,
      });
      continue;
    }
    if (a || b) mergedMessages.push(a || b);
  }

  return {
    id: primary.id || secondary.id || null,
    title: primary.title || secondary.title || null,
    messages: mergedMessages,
    files: dedupeFiles(mergedMessages.flatMap((message) => message.files || [])),
    source:
      primary.source === secondary.source
        ? primary.source
        : `${primary.source}+${secondary.source}`,
  };
}

// ── URL 解析 ──────────────────────────────────────────────────────────────────

/**
 * 从 URL 提取项目 hex ID。
 * e.g. "/g/g-p-69a4014b9f5881919b68c81a6bbeda3d-ghostvm/project" → "69a4014b9f5881919b68c81a6bbeda3d"
 */
function extractProjectId(url) {
  const match = url.match(/\/g\/g-p-([a-f0-9]+)/i);
  return match ? match[1] : null;
}

/**
 * 从 URL 提取项目页面完整路径（含 slug）。
 * e.g. "https://chatgpt.com/g/g-p-69a...3d-ghostvm/project" → "/g/g-p-69a...3d-ghostvm/project"
 */
function extractProjectPath(url) {
  const match = url.match(/(\/g\/g-p-[a-z0-9-]+\/project)/i);
  return match ? match[1] : null;
}

/**
 * 从 ChatGPT 对话 URL 中提取 conversation id。
 * e.g. ".../c/69b118d5-4ca4-83a8-8752-b1af35c9c742" → "69b118d5-4ca4-83a8-8752-b1af35c9c742"
 */
function extractConversationId(url) {
  const match = url.match(/\/c\/([a-z0-9-]+)/i);
  if (!match) throw new Error(`无法从 URL 提取 conversation id: ${url}`);
  return match[1];
}

// ── 导航 ──────────────────────────────────────────────────────────────────────

/**
 * 在侧边栏中找到名为 `projectName` 的项目并点击进入。
 * 返回 { projectId, projectPath } 供后续构建 URL。
 */
async function navigateToProject(page, projectName) {
  // 在侧边栏中查找项目链接（href 以 /project 结尾的 <a>）
  const href = await page.evaluate((name) => {
    const links = document.querySelectorAll('nav a[href$="/project"]');
    for (const link of links) {
      if (link.textContent.trim().includes(name)) {
        return link.getAttribute('href');
      }
    }
    return null;
  }, projectName);

  if (!href) throw new Error(`找不到名为 "${projectName}" 的项目`);

  await page.goto(`https://chatgpt.com${href}`, {
    waitUntil: 'domcontentloaded',
    timeout: DEFAULT_TIMEOUT,
  });
  await page.waitForSelector(S.composer.textarea, { timeout: DEFAULT_TIMEOUT });

  const url = page.url();
  return {
    projectId: extractProjectId(url),
    projectPath: extractProjectPath(url),
  };
}

/**
 * 导航到项目主页（用于开始新对话）。
 * projectPath 格式: "/g/g-p-{id}-{slug}/project"
 */
async function navigateToProjectHome(page, projectPath, options = {}) {
  const { forceReload = false } = options;
  const currentUrl = page.url();
  const currentPathname = new URL(currentUrl).pathname;
  // 如果已在项目主页且没有 /c/（即不在对话中），则无需重新导航
  if (
    !forceReload &&
    currentPathname === projectPath &&
    !currentUrl.includes('/c/')
  ) {
    return;
  }
  await page.goto(`https://chatgpt.com${projectPath}`, {
    waitUntil: 'domcontentloaded',
    timeout: DEFAULT_TIMEOUT,
  });
  await page.waitForSelector(S.composer.textarea, { timeout: DEFAULT_TIMEOUT });
}

/**
 * 导航到已有对话。
 * @param {string} projectRef  项目路径或项目 hex ID（可选，无则为非项目对话）
 */
async function navigateToConversation(page, conversationId, projectRef) {
  let target;
  if (projectRef) {
    const projectBase = projectRef.startsWith('/g/')
      ? projectRef.replace(/\/project$/, '')
      : `/g/g-p-${projectRef}`;
    target = `https://chatgpt.com${projectBase}/c/${conversationId}`;
  } else {
    target = `https://chatgpt.com/c/${conversationId}`;
  }

  if (!page.url().includes(conversationId)) {
    await page.goto(target, {
      waitUntil: 'domcontentloaded',
      timeout: DEFAULT_TIMEOUT,
    });
    // 等待消息加载和输入框就绪
    await page.waitForSelector(S.composer.textarea, { timeout: DEFAULT_TIMEOUT });
    // 额外等待消息渲染
    await sleep(2000);
  }
}

// ── 文件操作 ──────────────────────────────────────────────────────────────────

/**
 * 获取 ChatGPT access token（从 session API）。
 */
async function getAccessToken(page) {
  return page.evaluate(async () => {
    const resp = await fetch('/api/auth/session');
    return (await resp.json()).accessToken;
  });
}

async function createRemoteFile(page, accessToken, payload) {
  const res = await page.evaluate(async (body, token) => {
    const resp = await fetch('/backend-api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: resp.status, ok: resp.ok, text, json };
  }, payload, accessToken);

  if (!res.ok || !res.json?.upload_url || !res.json?.file_id) {
    throw new Error(`文件创建失败: ${res.text || JSON.stringify(res.json || {})}`);
  }

  return res.json;
}

async function deleteRemoteFile(page, accessToken, fileId) {
  const res = await page.evaluate(async (id, token) => {
    const resp = await fetch(`/backend-api/files/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await resp.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: resp.status, ok: resp.ok, text, json };
  }, fileId, accessToken);

  if (!res.ok || res.json?.success === false) {
    throw new Error(`项目文件删除失败: ${res.text || JSON.stringify(res.json || {})}`);
  }
}

async function uploadBlobToUrl(page, uploadUrl, fileContent, mimeType) {
  const res = await page.evaluate(async (url, b64, contentType) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const resp = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-version': '2020-04-08',
      },
      body: bytes,
    });
    const text = await resp.text().catch(() => '');
    return { status: resp.status, ok: resp.ok, text };
  }, uploadUrl, fileContent.toString('base64'), mimeType || 'application/octet-stream');

  if (!res.ok && res.status !== 201) {
    throw new Error(`Blob 上传失败: ${res.status} ${res.text || ''}`.trim());
  }
}

async function processProjectUpload(page, accessToken, payload) {
  const res = await page.evaluate(async (body, token) => {
    const resp = await fetch('/backend-api/files/process_upload_stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    return { status: resp.status, ok: resp.ok, text };
  }, payload, accessToken);

  if (!res.ok) {
    throw new Error(`项目文件处理失败: ${res.status} ${res.text || ''}`.trim());
  }
  if (!/"event":"file\.processing\.completed"/.test(res.text)) {
    throw new Error(`项目文件处理未完成: ${res.text || 'missing completion event'}`);
  }
}

async function fetchProjectConfig(page, accessToken, gizmoId) {
  const config = await page.evaluate(async (id, token) => {
    const resp = await fetch(`/backend-api/gizmos/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    return resp.json();
  }, gizmoId, accessToken);

  if (!config?.gizmo?.id) {
    throw new Error(`读取项目配置失败: ${gizmoId}`);
  }
  return config;
}

function normalizeProjectSharingSubject(subject) {
  if (!subject) return null;

  switch (subject.type) {
    case 1:
    case 'user':
      return {
        type: 'user',
        user_id: subject.user_id,
        user_name: subject.user_name,
        user_email: subject.user_email,
        avatar_url: subject.avatar_url ?? null,
        capabilities: subject.capabilities || PROJECT_VIEWER_CAPABILITIES,
      };
    case 2:
    case 'group':
      return {
        type: 'group',
        group_id: subject.group_id,
        group_name: subject.group_name,
        capabilities: subject.capabilities || PROJECT_VIEWER_CAPABILITIES,
      };
    case 3:
    case 'workspace':
    case 'workspace_link':
      return {
        type: 'workspace_link',
        capabilities: subject.capabilities || PROJECT_VIEWER_CAPABILITIES,
      };
    case 4:
    case 'all':
    case 'link':
      return {
        type: 'link',
        capabilities: subject.capabilities || PROJECT_VIEWER_CAPABILITIES,
      };
    default:
      return null;
  }
}

function buildProjectSharingPayload(gizmo) {
  const subjects = (gizmo?.sharing?.subjects || [])
    .map(normalizeProjectSharingSubject)
    .filter(Boolean);
  const recipient = gizmo?.share_recipient || gizmo?.sharing?.recipient || 'private';

  if (recipient === 'link' || recipient === 'workspace_link') {
    return [
      ...subjects,
      { type: recipient, capabilities: PROJECT_VIEWER_CAPABILITIES },
    ];
  }

  return [{ type: 'private', capabilities: PROJECT_VIEWER_CAPABILITIES }, ...subjects];
}

function shouldIndexProjectFile(gizmo, fileName, mimeType) {
  if (!gizmo?.use_injest_path) {
    return false;
  }

  return (
    isTextLikeFile({ name: fileName, mimeType }) ||
    /\.(pdf|docx?|pptx?|xlsx?)$/i.test(fileName)
  );
}

function normalizeProjectFileForUpsert(file) {
  return {
    ...file,
    location: 'fs',
  };
}

function dedupeProjectUpsertFiles(files) {
  const seen = new Set();
  const out = [];

  for (const file of files || []) {
    const key = file?.file_id || file?.id || file?.name;
    if (!key) continue;
    if (seen.has(key)) continue;
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
    files: dedupeProjectUpsertFiles((files || []).map(normalizeProjectFileForUpsert)),
    training_disabled: Boolean(gizmo.training_disabled),
    sharing: buildProjectSharingPayload(gizmo),
  };
}

async function upsertProject(page, accessToken, payload) {
  const res = await page.evaluate(async (body, token) => {
    const resp = await fetch('/backend-api/gizmos/snorlax/upsert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: resp.status, ok: resp.ok, text, json };
  }, payload, accessToken);

  if (!res.ok || res.json?.error) {
    throw new Error(`项目配置回写失败: ${res.text || JSON.stringify(res.json || {})}`);
  }
}

async function waitForProjectFileAttachment(page, accessToken, gizmoId, fileId, timeout = 30_000) {
  await page.waitForFunction(
    async (id, token, targetFileId) => {
      const resp = await fetch(`/backend-api/gizmos/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) return false;
      const data = await resp.json();
      return Boolean((data.files || []).some((file) => file.file_id === targetFileId));
    },
    { timeout },
    gizmoId,
    accessToken,
    fileId
  );
}

async function waitForProjectFileRemoval(page, accessToken, gizmoId, fileIds, timeout = 30_000) {
  const targets = Array.from(new Set((fileIds || []).filter(Boolean)));
  await page.waitForFunction(
    async (id, token, targetIds) => {
      const resp = await fetch(`/backend-api/gizmos/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) return false;
      const data = await resp.json();
      const currentIds = new Set((data.files || []).map((file) => file.file_id).filter(Boolean));
      return targetIds.every((targetId) => !currentIds.has(targetId));
    },
    { timeout },
    gizmoId,
    accessToken,
    targets
  );
}

function matchesProjectFileRef(file, fileRef) {
  return file?.file_id === fileRef || file?.name === fileRef;
}

/**
 * 通过 API 上传文件为后续对话附件（3 步流程）。
 *
 * 流程：
 *   1. POST /backend-api/files → 获取 upload_url + file_id
 *   2. PUT upload_url（Azure Blob）→ 上传文件内容
 *   3. POST /backend-api/files/{id}/uploaded → 确认上传
 *
 * @returns {{ fileId: string, fileName: string, fileSize: number, mimeType: string }}
 */
async function apiUploadConversationAttachment(page, absoluteFilePath) {
  const accessToken = await getAccessToken(page);
  const { fileContent, fileName, fileSize, mimeType } =
    getLocalFileMeta(absoluteFilePath);

  // Step 1: 创建上传
  const createRes = await createRemoteFile(page, accessToken, {
    file_name: fileName,
    file_size: fileSize,
    use_case: 'ace_upload',
  });

  // Step 2: 上传到 Azure Blob
  await uploadBlobToUrl(page, createRes.upload_url, fileContent, 'application/octet-stream');

  // Step 3: 确认上传
  await page.evaluate(async (fid, token) => {
    await fetch(`/backend-api/files/${fid}/uploaded`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
    });
  }, createRes.file_id, accessToken);

  return {
    fileId: createRes.file_id,
    fileName,
    fileSize,
    mimeType,
  };
}

/**
 * 通过项目内部 API 上传文件到项目 Sources。
 *
 * 真实链路：
 *   1. POST /backend-api/files 创建 file entry
 *   2. PUT blob URL 上传文件内容
 *   3. POST /backend-api/files/process_upload_stream 让项目库完成处理
 *   4. POST /backend-api/gizmos/snorlax/upsert 把文件挂到项目配置
 *
 * @returns {{ fileId: string, fileName: string, fileSize: number, mimeType: string }}
 */
async function uploadProjectFile(page, absoluteFilePath) {
  const accessToken = await getAccessToken(page);
  const projectHexId = extractProjectId(page.url());
  if (!projectHexId) {
    throw new Error('当前页面不是项目页面，无法上传项目文件');
  }

  const gizmoId = `g-p-${projectHexId}`;
  const { fileContent, fileName, fileSize, mimeType } = getLocalFileMeta(absoluteFilePath);
  const lastModified = Math.trunc(fs.statSync(absoluteFilePath).mtimeMs || Date.now());

  const createRes = await createRemoteFile(page, accessToken, {
    file_name: fileName,
    file_size: fileSize,
    use_case: 'agent',
    gizmo_id: gizmoId,
    timezone_offset_min: new Date().getTimezoneOffset(),
    reset_rate_limits: false,
    store_in_library: true,
  });

  await uploadBlobToUrl(page, createRes.upload_url, fileContent, mimeType);

  const configBeforeUpsert = await fetchProjectConfig(page, accessToken, gizmoId);
  await processProjectUpload(page, accessToken, {
    file_id: createRes.file_id,
    use_case: 'agent',
    gizmo_id: gizmoId,
    index_for_retrieval: shouldIndexProjectFile(
      configBeforeUpsert.gizmo,
      fileName,
      mimeType
    ),
    file_name: fileName,
    metadata: {
      store_in_library: true,
      library_file_info: {
        gizmo_id: gizmoId,
        is_project: true,
      },
    },
  });

  const currentProjectConfig = await fetchProjectConfig(page, accessToken, gizmoId);
  const nextFiles = [
    ...(Array.isArray(currentProjectConfig.files) ? currentProjectConfig.files : []),
    {
      file_id: createRes.file_id,
      name: fileName,
      size: fileSize,
      type:
        mimeType && mimeType !== 'application/octet-stream'
          ? mimeType
          : '',
      last_modified: lastModified,
      location: 'fs',
    },
  ];
  await upsertProject(
    page,
    accessToken,
    buildProjectUpsertPayload(currentProjectConfig, nextFiles)
  );
  await waitForProjectFileAttachment(page, accessToken, gizmoId, createRes.file_id);

  return {
    fileId: createRes.file_id,
    fileName,
    fileSize,
    mimeType,
  };
}

/**
 * 从当前项目中彻底删除文件。
 *
 * 说明：
 *   - 优先调用 /backend-api/files/{file_id}，同时删除项目 Sources 绑定和后端文件条目。
 *   - 若个别条目缺少 file_id，则回退到仅从项目配置里移除。
 *   - fileRef 支持 file_id 或文件名。
 *
 * @returns {Array<{ fileId: string, fileName: string, fileSize: number|null, mimeType: string|null }>}
 */
async function deleteProjectFile(page, fileRef) {
  const accessToken = await getAccessToken(page);
  const projectHexId = extractProjectId(page.url());
  if (!projectHexId) {
    throw new Error('当前页面不是项目页面，无法删除项目文件');
  }

  const gizmoId = `g-p-${projectHexId}`;
  const currentProjectConfig = await fetchProjectConfig(page, accessToken, gizmoId);
  const currentFiles = Array.isArray(currentProjectConfig.files) ? currentProjectConfig.files : [];
  const removedFiles = currentFiles.filter((file) => matchesProjectFileRef(file, fileRef));

  if (!removedFiles.length) {
    throw new Error(`项目中未找到文件: ${fileRef}`);
  }

  const hardDeleteTargets = removedFiles.filter((file) => file.file_id);
  for (const file of hardDeleteTargets) {
    await deleteRemoteFile(page, accessToken, file.file_id);
  }

  const softDeleteTargets = removedFiles.filter((file) => !file.file_id);
  if (softDeleteTargets.length) {
    const nextFiles = currentFiles.filter((file) => !matchesProjectFileRef(file, fileRef));
    await upsertProject(
      page,
      accessToken,
      buildProjectUpsertPayload(currentProjectConfig, nextFiles)
    );
  }

  const removedFileIds = removedFiles.map((file) => file.file_id).filter(Boolean);
  if (removedFileIds.length) {
    await waitForProjectFileRemoval(
      page,
      accessToken,
      gizmoId,
      removedFileIds
    );
  }

  return removedFiles.map((file) => ({
    fileId: file.file_id,
    fileName: file.name,
    fileSize: file.size ?? null,
    mimeType: file.type || null,
  }));
}

// ── 模型选择 ──────────────────────────────────────────────────────────────────

/**
 * 在当前页面选择模型。
 * 兼容策略：
 *   1. 优先使用已知 data-testid 入口
 *   2. 回退到按钮文本 / aria-haspopup 启发式查找
 */
async function selectModel(page, modelName) {
  const target = normalizeLookupText(modelName);
  if (!target) {
    throw new Error('modelName 不能为空');
  }

  const current = await page.evaluate((triggerSelector) => {
    const trigger = document.querySelector(triggerSelector);
    return trigger ? trigger.innerText.trim() : null;
  }, S.model.trigger);

  if (current && normalizeLookupText(current).includes(target)) {
    return current;
  }

  const trigger = (await page.$(S.model.trigger)) || null;
  if (trigger) {
    await trigger.click();
  } else {
    const opened = await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll('button, [role="button"]')
      );
      const triggerLike = candidates.find((el) => {
        const text = (el.innerText || '').trim();
        if (!text) return false;
        const normalized = text.toLowerCase();
        const hasModelText =
          /gpt|o1|o3|o4|4o|4\.1|mini|pro/.test(normalized);
        const hasPopup = el.getAttribute('aria-haspopup') === 'menu';
        return hasModelText && (hasPopup || Boolean(el.closest('header, form')));
      });

      if (!triggerLike) return false;
      triggerLike.click();
      return true;
    });

    if (!opened) {
      throw new Error('找不到模型选择器');
    }
  }

  await page.waitForFunction(
    (optionSelector, normalizedTarget) => {
      const normalize = (value) =>
        String(value || '')
          .toLowerCase()
          .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      return Array.from(document.querySelectorAll(optionSelector)).some(
        (el) =>
          isVisible(el) &&
          normalize(el.innerText).includes(normalizedTarget)
      );
    },
    { timeout: DEFAULT_TIMEOUT },
    S.model.options,
    target
  );

  const selected = await page.evaluate((optionSelector, normalizedTarget) => {
    const normalize = (value) =>
      String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const options = Array.from(document.querySelectorAll(optionSelector));
    const targetOption = options.find(
      (el) =>
        isVisible(el) &&
        normalize(el.innerText).includes(normalizedTarget)
    );

    if (!targetOption) return null;
    targetOption.click();
    return (targetOption.innerText || '').trim();
  }, S.model.options, target);

  if (!selected) {
    throw new Error(`找不到模型: ${modelName}`);
  }

  await sleep(500);
  return selected;
}

// ── 对话快照 ──────────────────────────────────────────────────────────────────

async function fetchConversationApiPayload(page, conversationId) {
  const accessToken = await getAccessToken(page);
  return page.evaluate(async (id, token) => {
    try {
      const resp = await fetch(`/backend-api/conversation/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      return null;
    }
  }, conversationId, accessToken);
}

async function getConversationSnapshotFromDom(page) {
  return page.evaluate((allMsgSelector, markdownSelector) => {
    const normalizeText = (value) =>
      String(value || '').replace(/\u200b/g, '').trim();

    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const looksLikeFile = (value) =>
      /[a-z0-9][a-z0-9._ -]*\.(txt|md|json|csv|xml|ya?ml|pdf|png|jpe?g|gif|svg|zip|gz|py|js|ts|html|css|docx?|xlsx?|pptx?|rtf)$/i
        .test(String(value || '').trim());

    const messages = Array.from(document.querySelectorAll(allMsgSelector))
      .map((messageEl, index) => {
        const role =
          messageEl.getAttribute('data-message-author-role') || 'unknown';
        const root = messageEl.closest('article') || messageEl;
        const markdown = messageEl.querySelector(markdownSelector) || messageEl;
        const text = normalizeText(markdown.innerText || messageEl.innerText);

        const seen = new Set();
        const files = Array.from(
          root.querySelectorAll('a, button, [role="button"], div, span')
        )
          .filter(isVisible)
          .map((el) => {
            const href = el.getAttribute('href') || null;
            const download = el.getAttribute('download') || null;
            const label = normalizeText(
              download ||
                el.getAttribute('aria-label') ||
                el.innerText ||
                ''
            );
            const testId = String(el.getAttribute('data-testid') || '').toLowerCase();
            const match = label.match(
              /[a-z0-9][a-z0-9._ -]*\.[a-z0-9]{1,10}/i
            );
            const name = download || (match ? match[0].trim() : null);
            const isFileLike = Boolean(
              download ||
                (href && /\/files\/|download|blob:/i.test(href)) ||
                testId.includes('attachment') ||
                testId.includes('file') ||
                (name && looksLikeFile(name))
            );

            if (!isFileLike) return null;

            const key = [href || '', name || '', label].join('|');
            if (seen.has(key)) return null;
            seen.add(key);

            return {
              id: null,
              name,
              mimeType: null,
              size: null,
              url: href,
              content: label && label !== name ? label : null,
            };
          })
          .filter(Boolean);

        return {
          id: `dom-${index}`,
          role,
          text,
          files,
        };
      })
      .filter((message) => message.text || message.files.length);

    const fileSeen = new Set();
    const files = [];
    for (const message of messages) {
      for (const file of message.files) {
        const key = [file.id || '', file.url || '', file.name || ''].join('|');
        if (fileSeen.has(key)) continue;
        fileSeen.add(key);
        files.push(file);
      }
    }

    return {
      id: null,
      title: document.title || null,
      messages,
      files,
      source: 'dom',
    };
  }, S.response.allMessages, S.response.messageContent);
}

async function tryReadTextFile(page, file) {
  if (!file?.url || !isTextLikeFile(file)) {
    return null;
  }

  return page.evaluate(async (url) => {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const text = await resp.text();
      if (text.length <= 100_000) return text;
      return `${text.slice(0, 100_000)}\n\n...[truncated]`;
    } catch {
      return null;
    }
  }, file.url);
}

async function hydrateConversationSnapshotFiles(page, snapshot) {
  const cache = new Map();

  for (const message of snapshot.messages) {
    const hydrated = [];
    for (const file of message.files || []) {
      const key = [file.id || '', file.url || '', file.name || ''].join('|');
      if (!cache.has(key)) {
        const fetchedContent = await tryReadTextFile(page, file);
        cache.set(key, {
          ...file,
          content:
            fetchedContent ||
            (file.content && file.content !== file.name ? file.content : null),
        });
      }
      hydrated.push(cache.get(key));
    }
    message.files = hydrated;
  }

  snapshot.files = dedupeFiles(
    snapshot.messages.flatMap((message) => message.files || [])
  );
  return snapshot;
}

async function getConversationSnapshot(page, conversationId) {
  const apiPayload = conversationId
    ? await fetchConversationApiPayload(page, conversationId).catch(() => null)
    : null;
  const apiSnapshot = normalizeConversationApiPayload(apiPayload);
  const domSnapshot = await getConversationSnapshotFromDom(page).catch(
    () => null
  );

  const snapshot =
    mergeConversationSnapshots(apiSnapshot, domSnapshot) ||
    {
      id: conversationId || null,
      title: null,
      messages: [],
      files: [],
      source: 'empty',
    };

  snapshot.id = snapshot.id || conversationId || null;
  return hydrateConversationSnapshotFiles(page, snapshot);
}

async function getConversationStatus(
  page,
  conversationId = null,
  projectRef = null
) {
  if (
    conversationId &&
    !page.url().includes(`/c/${conversationId}`)
  ) {
    await navigateToConversation(page, conversationId, projectRef);
  }

  const domStatus = await page.evaluate(
    (stopSel, allMsgSel, assistantSel, mdSel) => {
      const normalizeText = (value) =>
        String(value || '').replace(/\u200b/g, '').trim();

      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const allMessages = Array.from(document.querySelectorAll(allMsgSel));
      const assistantMessages = Array.from(document.querySelectorAll(assistantSel));
      const lastMessage = allMessages[allMessages.length - 1] || null;
      const lastAssistant = assistantMessages[assistantMessages.length - 1] || null;
      const lastAssistantMarkdown =
        lastAssistant?.querySelector(mdSel) || lastAssistant;

      return {
        url: location.href,
        isResponding: isVisible(document.querySelector(stopSel)),
        messageCount: allMessages.length,
        assistantMessageCount: assistantMessages.length,
        lastMessageRole:
          lastMessage?.getAttribute('data-message-author-role') || null,
        lastAssistantText: normalizeText(
          lastAssistantMarkdown?.innerText || lastAssistant?.innerText || ''
        ),
      };
    },
    S.composer.stopBtn,
    S.response.allMessages,
    S.response.assistantMsgs,
    S.response.messageContent
  );

  let resolvedConversationId = conversationId || null;
  if (!resolvedConversationId) {
    try {
      resolvedConversationId = extractConversationId(domStatus.url);
    } catch {
      resolvedConversationId = null;
    }
  }

  return {
    conversationId: resolvedConversationId,
    url: domStatus.url,
    state: domStatus.isResponding ? 'running' : 'completed',
    isResponding: domStatus.isResponding,
    messageCount: domStatus.messageCount,
    assistantMessageCount: domStatus.assistantMessageCount,
    lastMessageRole: domStatus.lastMessageRole,
    lastAssistantText: domStatus.lastAssistantText,
    checkedAt: new Date().toISOString(),
  };
}

async function waitForConversationCompletion(
  page,
  conversationId = null,
  projectRef = null,
  options = {}
) {
  const {
    timeout = REPLY_TIMEOUT,
    pollInterval = 2_000,
    stablePolls = 2,
  } = options;

  const deadline = Date.now() + timeout;
  let stableCount = 0;
  let lastSignature = null;

  while (Date.now() <= deadline) {
    const status = await getConversationStatus(
      page,
      conversationId,
      projectRef
    );
    const signature = [
      status.state,
      status.assistantMessageCount,
      status.lastAssistantText,
      status.lastMessageRole,
    ].join('|');

    if (status.state === 'completed') {
      stableCount = signature === lastSignature ? stableCount + 1 : 1;
      if (stableCount >= stablePolls) {
        return status;
      }
    } else {
      stableCount = 0;
    }

    lastSignature = signature;
    await sleep(pollInterval);
  }

  throw new Error(`等待对话完成超时: ${timeout}ms`);
}

/**
 * 发送消息并附带文件。
 *
 * 策略：通过 CDP Fetch.enable 拦截 /backend-api/f/conversation 请求，
 * 注入 metadata.attachments 后放行。
 *
 * @param {Page} page
 * @param {string} text           消息文本
 * @param {Array} fileAttachments 文件附件信息数组 [{ fileId, fileName, fileSize, mimeType }]
 * @returns {Promise<string>}     assistant 回复文本
 */
async function sendMessageWithFiles(page, text, fileAttachments) {
  // 记录发送前的 assistant 消息数量
  const prevAssistantCount = await page.evaluate(
    (sel) => document.querySelectorAll(sel).length,
    S.response.assistantMsgs
  );

  // 输入消息
  await page.evaluate((msg) => {
    const el = document.querySelector('#prompt-textarea');
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, msg);
  }, text);
  await sleep(800);

  // 等待 send 按钮就绪
  await page.waitForSelector(S.composer.sendBtn, { timeout: 5000 });
  await waitForEnabled(page, S.composer.sendBtn, 30_000);

  // 启用 CDP Fetch 拦截
  const cdp = await page.createCDPSession();
  await cdp.send('Fetch.enable', {
    patterns: [{
      urlPattern: '*backend-api/f/conversation',
      requestStage: 'Request',
    }],
  });

  let injected = false;
  cdp.on('Fetch.requestPaused', async (event) => {
    const { requestId, request } = event;
    if (request.method === 'POST' && !injected && request.postData) {
      injected = true;
      try {
        const payload = JSON.parse(request.postData);
        if (payload.messages?.[0]) {
          const msg = payload.messages[0];
          if (!msg.metadata) msg.metadata = {};
          msg.metadata.attachments = [
            ...(msg.metadata.attachments || []),
            ...fileAttachments.map((f) => ({
              id: f.fileId,
              name: f.fileName,
              size: f.fileSize,
              mimeType: f.mimeType,
            })),
          ];
        }
        await cdp.send('Fetch.continueRequest', {
          requestId,
          postData: Buffer.from(JSON.stringify(payload)).toString('base64'),
        });
      } catch {
        await cdp.send('Fetch.continueRequest', { requestId });
      }
    } else {
      await cdp.send('Fetch.continueRequest', { requestId });
    }
  });

  // 用 evaluate 点击发送（puppeteer handle.click() 会卡住）
  await page.evaluate((sel) => document.querySelector(sel).click(), S.composer.sendBtn);

  // 等待回复
  const content = await _waitForReply(page, prevAssistantCount);

  // 清理 CDP session
  await cdp.send('Fetch.disable').catch(() => {});
  await cdp.detach().catch(() => {});

  return content;
}

// ── 对话 ──────────────────────────────────────────────────────────────────────

/**
 * 内部：等待 assistant 回复完成并返回文本。
 */
async function _waitForReply(page, prevAssistantCount) {
  try {
    // 主路径：等待 stop 按钮出现 → 消失
    await page.waitForSelector(S.composer.stopBtn, { timeout: 30_000 });
    await waitForAbsent(page, S.composer.stopBtn, REPLY_TIMEOUT);
  } catch {
    // 降级路径：等待新 assistant 消息出现 + 文本稳定
    try {
      await page.waitForFunction(
        (sel, prev) => document.querySelectorAll(sel).length > prev,
        { timeout: 120_000 },
        S.response.assistantMsgs,
        prevAssistantCount
      );
    } catch {
      // 可能消息已出现在 stop 按钮出现前
    }
    let prevText = '';
    for (let i = 0; i < 120; i++) {
      await sleep(3_000);
      const curText = await page.evaluate((sel) => {
        const msgs = document.querySelectorAll(sel);
        const last = msgs[msgs.length - 1];
        return last ? last.textContent : '';
      }, S.response.assistantMsgs);
      if (curText === prevText && curText.length > 0) break;
      prevText = curText;
    }
  }

  await sleep(500);

  const content = await page.evaluate((msgSel, mdSel) => {
    const msgs = document.querySelectorAll(msgSel);
    const last = msgs[msgs.length - 1];
    if (!last) return '';
    const md = last.querySelector(mdSel);
    return md ? md.innerText.trim() : last.innerText.trim();
  }, S.response.assistantMsgs, S.response.messageContent);

  return content;
}

/**
 * 在当前对话中发送消息，等待完整回复后返回文本。
 *
 * 完成检测策略：
 *   1. 主路径：stop 按钮出现（流式开始）→ stop 按钮消失（流式结束）
 *   2. 降级：等待新的 assistant 消息出现 + 文本内容稳定
 */
async function sendMessage(page, text) {
  const prevAssistantCount = await page.evaluate(
    (sel) => document.querySelectorAll(sel).length,
    S.response.assistantMsgs
  );

  // 输入消息（ProseMirror contenteditable）
  await page.evaluate((msg) => {
    const el = document.querySelector('#prompt-textarea');
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, msg);
  }, text);
  await sleep(800);

  // 用 evaluate 点击发送（puppeteer handle.click() 会卡住）
  try {
    await page.waitForSelector(S.composer.sendBtn, { timeout: 5_000 });
    await waitForEnabled(page, S.composer.sendBtn, 15_000);
    await page.evaluate((sel) => document.querySelector(sel).click(), S.composer.sendBtn);
  } catch {
    await page.keyboard.press('Enter');
  }

  return _waitForReply(page, prevAssistantCount);
}

/**
 * 等待 URL 中出现 /c/{id} 并提取 conversation id。
 */
async function waitForConversationId(page, timeout = 30_000) {
  await page.waitForFunction(() => location.href.includes('/c/'), { timeout });
  return extractConversationId(page.url());
}

module.exports = {
  // URL 解析
  extractProjectId,
  extractProjectPath,
  extractConversationId,
  // 导航
  navigateToProject,
  navigateToProjectHome,
  navigateToConversation,
  selectModel,
  // 文件
  apiUploadConversationAttachment,
  uploadProjectFile,
  deleteProjectFile,
  sendMessageWithFiles,
  // 对话
  getConversationStatus,
  waitForConversationCompletion,
  getConversationSnapshot,
  sendMessage,
  waitForConversationId,
};
