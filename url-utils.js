/**
 * url-utils.js — ChatGPT URL / 路径解析（纯函数）
 * 证据 2026-10-28：对话页 /c/{uuid}；项目主页 /g/{gizmoId}-{slug}/project；
 * 项目会话 /g/{gizmoId}-{slug}/c/{uuid}。
 */

'use strict';

function extractProjectId(url) {
  const match = String(url || '').match(/\/g\/(g-p-[a-f0-9]+)/i);
  return match ? match[1] : null;
}

function extractProjectPath(url) {
  const match = String(url || '').match(/\/g\/g-p-[a-f0-9]+[^?#]*\/project/i);
  return match ? match[0] : null;
}

function extractConversationId(url) {
  const match = String(url || '').match(/\/c\/([a-z0-9-]+)/i);
  return match ? match[1] : null;
}


/**
 * 是否为可用的会话 id。
 * 实机事实（2026-10-28）：新会话在服务端 id 就绪前，URL 会短暂出现
 * `/c/local-chatgpt` 占位 id；它不能用于协议读取（返回 400
 * Invalid conversation）。真实 id 为 UUID 形式。
 */
function isUsableConversationId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(id || '').trim()
  );
}

/** 把项目 URL 归一为项目主页路径（/g/{id}-{slug}/project）。 */
function normalizeProjectHomePath(input) {
  const s = String(input || '');
  const m = s.match(/\/g\/(g-p-[a-f0-9]+(?:-[^/?#]*)?)\/project/i);
  if (m) return `/g/${m[1]}/project`;
  // 只有 gizmo id（无 slug）也能构造
  const gizmo = s.match(/(g-p-[a-f0-9]+)/i);
  if (gizmo) return `/g/${gizmo[1]}/project`;
  return null;
}


module.exports = {
  extractProjectId,
  extractProjectPath,
  extractConversationId,
  isUsableConversationId,
  normalizeProjectHomePath,
};
