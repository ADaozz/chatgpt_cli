/**
 * conversation-parser.js — 会话 payload → 结构化快照的纯函数解析层
 *
 * 实现依据（2026-10-28 实机抓取，docs/contracts/chatgpt-web-contract.md）：
 *   GET /backend-api/conversations/{id}?num_turns=N&include_has_versions=true
 *   返回线性 `messages[]`（不再是 mapping 树）+ `page_info` 游标分页。
 *   当前分支通过 current_node + metadata.parent_id 回溯，不能按时间排序假设。
 *   完成信号：最后 assistant 消息 channel="final" + end_turn===true +
 *   status==="finished_successfully"，且本 turn 无 reasoning_status==="is_reasoning"，
 *   且 async_status 不在进行中。
 *
 * 兼容说明：/backend-api/conversations?limit 列表项仍携带 mapping 树，
 * 本模块同时支持两种形态（shape: 'linear' | 'mapping'），但这不是旧页面
 * DOM 兼容 —— 两种都是服务端协议响应。
 *
 * 不依赖 Puppeteer / 不做 I/O。
 */

'use strict';

// ── 内容与附件工具 ──────────────────────────────────────────────────────────────

function normalizeContentParts(parts) {
  if (!Array.isArray(parts)) return [];
  const out = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      if (part.trim()) out.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string' && part.text.trim()) {
      out.push(part.text);
      continue;
    }
    if (part.content_type === 'code' && typeof part.code === 'string') {
      out.push(part.code);
      continue;
    }
    if (part.content_type && typeof part.content_type === 'string') {
      out.push(`[${part.content_type}]`);
    }
  }
  return out;
}

function isLikelyFilename(value) {
  return /[a-z0-9][a-z0-9._ -]*\.(txt|md|json|csv|xml|ya?ml|pdf|png|jpe?g|gif|svg|zip|gz|py|js|ts|html|css|docx?|xlsx?|pptx?|rtf)$/i
    .test(String(value || '').trim());
}

function isTextLikeFile(file) {
  const mimeType = String(file?.mimeType || file?.type || '');
  const name = String(file?.name || '');
  return (
    /^(text\/|application\/(json|xml|javascript)|image\/svg\+xml)/i.test(mimeType) ||
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
  const url = typeof value.url === 'string' ? value.url : null;
  const id = value.id || value.file_id || value.fileId || null;
  if (!name && !url && !id) return null;
  const size = Number(value.size ?? value.file_size ?? value.fileSize);
  return {
    id: id || null,
    name,
    url,
    mimeType: value.mimeType || value.mime_type || value.type || null,
    size: Number.isFinite(size) && size >= 0 ? size : null,
    content: getAttachmentContent(value),
  };
}

function extractFilesFromValue(value, bucket = []) {
  if (!value || typeof value !== 'object') return bucket;
  const candidateKeys = [
    'files',
    'attachments',
    'file_sources',
    'search_result_files',
    'content_references',
  ];
  for (const key of candidateKeys) {
    const list = value[key];
    if (Array.isArray(list)) {
      for (const item of list) {
        const file = normalizeFileCandidate(item);
        if (file) bucket.push(file);
      }
    }
  }
  if (value.metadata && typeof value.metadata === 'object') {
    extractFilesFromValue(value.metadata, bucket);
  }
  if (Array.isArray(value.attachments)) {
    for (const item of value.attachments) {
      const file = normalizeFileCandidate(item);
      if (file) bucket.push(file);
    }
  }
  return dedupeFiles(bucket);
}

// ── 结构化内容（Genui / Intelligent UI）────────────────────────────────────────

/**
 * 证据 2026-10-28：text parts 中会出现 Genui 组件标记
 * （如 `<WritingBlock id=".." variant="document">`），渲染层为 DilRenderer。
 * 无法在 CLI 内渲染的组件标记必须显式报告（hasUnsupportedContent），
 * 不允许静默丢弃后伪装成空回复。
 */
const GENUI_TAG_RE = /<([A-Z][A-Za-z0-9_]*)\b[^>]*>/g;

function extractStructuredBlocks(text) {
  if (!text || text.indexOf('<') === -1) return { blocks: [], hasUnsupportedContent: false };
  const blocks = [];
  const seen = new Set();
  let match;
  GENUI_TAG_RE.lastIndex = 0;
  while ((match = GENUI_TAG_RE.exec(text)) !== null) {
    const type = match[1];
    if (seen.has(type)) continue;
    seen.add(type);
    blocks.push({ type, tag: match[0].slice(0, 120), index: match.index });
  }
  return { blocks, hasUnsupportedContent: blocks.length > 0 };
}

// ── 消息节点归一化 ──────────────────────────────────────────────────────────────

function normalizeMessageNode(message, nodeId, parentHint) {
  if (!message || typeof message !== 'object') return null;
  const meta = message.metadata || {};
  const parts = normalizeContentParts(message.content && message.content.parts);
  const text = parts.join('\n\n').trim();
  const { blocks, hasUnsupportedContent } = extractStructuredBlocks(text);
  return {
    id: message.id || nodeId || null,
    role: (message.author && message.author.role) || 'unknown',
    channel: message.channel ?? null,
    contentType: (message.content && message.content.content_type) || null,
    text,
    blocks,
    hasUnsupportedContent,
    files: extractFilesFromValue({
      content: message.content,
      metadata: meta,
      attachments: message.attachments,
    }),
    createTime: message.create_time ?? null,
    updateTime: message.update_time ?? null,
    status: message.status ?? null,
    endTurn: message.end_turn ?? null,
    weight: message.weight ?? null,
    hidden: Boolean(meta.is_visually_hidden_from_conversation),
    reasoningStatus: meta.reasoning_status ?? null,
    modelSlug: meta.model_slug ?? meta.resolved_model_slug ?? null,
    thinkingEffort: meta.thinking_effort ?? null,
    parentId: meta.parent_id ?? parentHint ?? null,
    workingTurnId: meta.working_turn_id ?? meta.turn_exchange_id ?? null,
    isComplete: meta.is_complete === true,
    finishType: (meta.finish_details && meta.finish_details.type) ?? null,
  };
}

const ASYNC_STATUS_IDLE_VALUES = new Set([null, undefined, 0, '0']);

function isAsyncStatusInProgress(asyncStatus) {
  if (ASYNC_STATUS_IDLE_VALUES.has(asyncStatus)) return false;
  if (typeof asyncStatus === 'number') return asyncStatus > 0;
  if (typeof asyncStatus === 'string') {
    const n = Number(asyncStatus);
    if (Number.isFinite(n)) return n > 0;
    return asyncStatus !== '' && asyncStatus !== 'none';
  }
  return Boolean(asyncStatus);
}

// ── 线性 messages 形态（/backend-api/conversations/{id}，2026-10-28）───────────

/**
 * 从线性 messages 数组恢复当前分支：从 current_node 沿 metadata.parent_id
 * 回溯到根，再反转。返回的 branch 是当前可见路径（服务端已按当前树分支展开）。
 */
function linearizeLinearMessages(messages, currentNodeId) {
  const byId = new Map();
  for (const m of messages) {
    if (m && m.id) byId.set(m.id, m);
  }
  const branch = [];
  const seen = new Set();
  let cursor = currentNodeId || (messages.length ? messages[messages.length - 1].id : null);
  while (cursor && byId.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    const m = byId.get(cursor);
    branch.push(m);
    cursor = (m.metadata && m.metadata.parent_id) || null;
  }
  return branch.reverse();
}

function parseLinearPayload(payload) {
  const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];
  const nodes = rawMessages
    .map((m, i) => normalizeMessageNode(m, m && m.id, null))
    .filter(Boolean);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const branchIds = linearizeLinearMessages(
    rawMessages,
    payload.current_node || null
  ).map((m) => m.id);
  const branchNodes = branchIds.map((id) => byId.get(id)).filter(Boolean);

  const pageInfoRaw = payload.page_info || null;
  const pageInfo = pageInfoRaw
    ? {
        startCursor: pageInfoRaw.start_cursor ?? null,
        endCursor: pageInfoRaw.end_cursor ?? null,
        hasPreviousPage: Boolean(pageInfoRaw.has_previous_page),
        hasNextPage: Boolean(pageInfoRaw.has_next_page),
      }
    : null;

  return {
    shape: 'linear',
    nodes,
    branchNodes,
    pageInfo,
    partial: pageInfo ? pageInfo.hasPreviousPage : false,
  };
}

// ── mapping 形态（列表项 / 旧端点仍返回）───────────────────────────────────────

function parseMappingPayload(payload) {
  const mapping = payload.mapping && typeof payload.mapping === 'object' ? payload.mapping : {};
  const nodes = [];
  for (const [nodeId, node] of Object.entries(mapping)) {
    if (!node || !node.message) continue;
    const normalized = normalizeMessageNode(node.message, nodeId, node.parent || null);
    if (normalized) nodes.push(normalized);
  }

  // 当前分支：从 current_node 沿 parent 链回溯；无 current_node 时退回按时间排序。
  let branchNodes = nodes;
  if (payload.current_node) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const branch = [];
    const seen = new Set();
    let cursor = payload.current_node;
    while (cursor && byId.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      branch.push(byId.get(cursor));
      const parent = byId.get(cursor)?.parentId || null;
      cursor = parent;
    }
    if (branch.length) branchNodes = branch.reverse();
  } else {
    branchNodes = [...nodes].sort(
      (a, b) => (a.createTime ?? 0) - (b.createTime ?? 0)
    );
  }

  return { shape: 'mapping', nodes, branchNodes, pageInfo: null, partial: false };
}

// ── 完成判定（协议口径）────────────────────────────────────────────────────────

/**
 * 从当前分支提取 turn 完成信号。
 * 返回：
 *   asyncStatus        服务端 async_status 原值
 *   asyncInProgress    async_status 是否在进行中
 *   workingTurnId      当前 turn id
 *   lastFinal          最后一条 channel==="final" 的 assistant 消息（或 null）
 *   hasOpenReasoning   当前 turn 是否仍有 is_reasoning
 *   finalComplete      lastFinal 是否满足终态（status+end_turn）
 *   turnComplete       true=完成 / false=未完成 / null=信号不足
 */
function extractTurnCompletion(branchNodes, asyncStatus) {
  const asyncInProgress = isAsyncStatusInProgress(asyncStatus);
  if (!branchNodes.length) {
    return {
      asyncStatus: asyncStatus ?? null,
      asyncInProgress,
      workingTurnId: null,
      lastFinal: null,
      hasOpenReasoning: false,
      finalComplete: false,
      turnComplete: null,
    };
  }

  let workingTurnId = null;
  for (let i = branchNodes.length - 1; i >= 0; i--) {
    const tid = branchNodes[i].workingTurnId;
    if (tid) {
      workingTurnId = tid;
      break;
    }
  }

  const turnNodes = workingTurnId
    ? branchNodes.filter((n) => !n.workingTurnId || n.workingTurnId === workingTurnId)
    : branchNodes;

  let lastFinal = null;
  for (let i = turnNodes.length - 1; i >= 0; i--) {
    const n = turnNodes[i];
    if (n.role === 'assistant' && n.channel === 'final') {
      lastFinal = n;
      break;
    }
  }

  // 实机事实（2026-10-28）：已完成的 turn 中，历史 reasoning 消息的
  // reasoning_status 仍保持 "is_reasoning"（后接 "reasoning_ended"），
  // 因此只有「尚无已完成 final」时 reasoning 才算仍在进行。
  const rawHasReasoning = turnNodes.some((n) => n.reasoningStatus === 'is_reasoning');
  const finalComplete = Boolean(
    lastFinal &&
      lastFinal.status === 'finished_successfully' &&
      lastFinal.endTurn === true &&
      lastFinal.reasoningStatus !== 'is_reasoning'
  );
  const hasOpenReasoning = !finalComplete && rawHasReasoning;

  let turnComplete;
  // 实机事实（2026-10-28）：会话完成审阅后 async_status 可能持久为 4
  // （非生成中，旧会话为 null），因此当前 turn 的完成 final 优先于
  // async_status；async 只在其未完成时作为「仍在生成」的证据。
  if (finalComplete) turnComplete = true;
  else if (asyncInProgress) turnComplete = false;
  else if (lastFinal || hasOpenReasoning || turnNodes.some((n) => n.role === 'assistant')) {
    // 分支上已有 assistant 输出但未满足终态：视为未完成（不得伪装成功）。
    turnComplete = false;
  } else turnComplete = null;

  return {
    asyncStatus: asyncStatus === undefined ? null : asyncStatus,
    asyncInProgress,
    workingTurnId,
    lastFinal,
    hasOpenReasoning,
    finalComplete,
    turnComplete,
  };
}

// ── 对外主入口 ─────────────────────────────────────────────────────────────────

/**
 * 解析 conversations/{id} 响应为快照。
 * @returns {{ id, title, gizmoId, defaultModelSlug, asyncStatus, messages,
 *   visibleMessages, branchMessageIds, completion, pageInfo, partial, shape,
 *   unknownFields }}
 */
function parseConversationPayload(payload, { conversationId } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      id: conversationId || null,
      title: null,
      gizmoId: null,
      defaultModelSlug: null,
      asyncStatus: null,
      messages: [],
      visibleMessages: [],
      branchMessageIds: [],
      completion: null,
      pageInfo: null,
      partial: false,
      shape: 'invalid',
      unknownFields: [],
    };
  }

  const parsed = Array.isArray(payload.messages)
    ? parseLinearPayload(payload)
    : parseMappingPayload(payload);

  const messages = parsed.nodes;
  const branchIds = new Set(parsed.branchNodes.map((n) => n.id));
  const visibleMessages = messages.filter(
    (m) => m.weight !== 0 && !m.hidden && (m.text || m.files.length)
  );

  const knownTopKeys = new Set([
    'title', 'create_time', 'update_time', 'conversation_id', 'gizmo_id',
    'gizmo_type', 'default_model_slug', 'async_status', 'current_node',
    'messages', 'mapping', 'page_info', 'sectioned_conversation',
    'context_truncation_continuation', 'is_archived', 'is_starred',
    'is_temporary_chat', 'conversation_origin', 'moderation_results',
    'plugin_ids', 'safe_urls', 'blocked_urls', 'voice', 'disabled_tool_ids',
    'is_do_not_remember', 'memory_scope', 'context_scopes', 'owner',
    'conversation_template_id', 'atlas_mode_enabled', 'is_read_only',
  ]);
  const unknownFields = Object.keys(payload).filter((k) => !knownTopKeys.has(k));

  return {
    id: payload.conversation_id || conversationId || null,
    title: payload.title || null,
    gizmoId: payload.gizmo_id || null,
    defaultModelSlug: payload.default_model_slug || null,
    asyncStatus: payload.async_status === undefined ? null : payload.async_status,
    messages,
    visibleMessages,
    branchMessageIds: parsed.branchNodes.map((n) => n.id),
    completion: extractTurnCompletion(parsed.branchNodes, payload.async_status),
    pageInfo: parsed.pageInfo,
    partial: parsed.partial,
    shape: parsed.shape,
    unknownFields,
  };
}

/** 从快照取最后一条非空 assistant 文本（优先当前分支的 channel=final）。 */
function getLastAssistantFromSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.messages)) return '';
  for (let i = snapshot.messages.length - 1; i >= 0; i--) {
    const msg = snapshot.messages[i];
    if (msg && msg.role === 'assistant') {
      const text = String(msg.text || '').trim();
      if (text) return text;
    }
  }
  return '';
}

/**
 * 跨页合并：同一会话的分页结果按消息 id 去重拼接。
 * 这是唯一的合并路径 —— 禁止按数组下标合并 API 与 DOM 两侧消息。
 */
function mergePagedMessages(pages) {
  const byId = new Map();
  const order = [];
  for (const page of pages || []) {
    for (const msg of page || []) {
      if (!msg || !msg.id || byId.has(msg.id)) continue;
      byId.set(msg.id, msg);
      order.push(msg.id);
    }
  }
  return order.map((id) => byId.get(id));
}

module.exports = {
  // 内容解析（测试与内部共用）
  normalizeContentParts,
  extractStructuredBlocks,
  // 协议解析
  parseConversationPayload,
  extractTurnCompletion,
  isAsyncStatusInProgress,
  linearizeLinearMessages,
  mergePagedMessages,
  getLastAssistantFromSnapshot,
};
