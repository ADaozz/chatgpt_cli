/**
 * web-protocol.js — ChatGPT 网页现行协议层（唯一允许调用 backend-api 的模块）
 *
 * 契约依据：docs/contracts/chatgpt-web-contract.md（2026-10-28 实机抓取）
 *   - 会话读取：GET /backend-api/conversations/{id}?num_turns=N&include_has_versions=true
 *     需要 Bearer token（裸 fetch 返回 401/404 conversation_inaccessible）。
 *   - 分页：响应 page_info { start_cursor, end_cursor, has_previous_page,
 *     has_next_page }；向前翻页用 &before={start_cursor}，向后用 &after=。
 *   - 列表：GET /backend-api/conversations?limit&offset&order=updated
 *     （items + total，offset 分页；列表项仍是 mapping 形态）。
 *   - 模型目录：GET /backend-api/models?history_and_training_excluded=false
 *     （model_picker_version 2；UI label ↔ slug 不一一对应，选择须以页面为准）。
 *   - 项目：GET /backend-api/gizmos/{id}?include_file_limits=true
 *     （files[] 直接在响应上；gizmo_type=snorlax）。
 *
 * 错误处理约定（不得静默吞掉）：
 *   401→auth、403→forbidden、429→rate_limited（携带 retryAfterMs）、
 *   5xx→server、fetch 失败→network、JSON 解析失败→parse。
 *   429 必须遵循 Retry-After；调用方不得无限快速重试。
 */

'use strict';

const {
  parseConversationPayload,
  mergePagedMessages,
} = require('./conversation-parser');

class ProtocolError extends Error {
  /**
   * @param {string} kind  auth | forbidden | rate_limited | server | network | parse | not_found
   * @param {string} message
   * @param {object} [details] { status, retryAfterMs, endpoint }
   */
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'ProtocolError';
    this.kind = kind;
    this.status = details.status ?? null;
    this.retryAfterMs = details.retryAfterMs ?? null;
    this.endpoint = details.endpoint ?? null;
  }
}

function parseRetryAfterMs(headerValue) {
  if (!headerValue) return null;
  const asSeconds = Number(headerValue);
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1000);
  const asDate = Date.parse(headerValue);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

function protocolErrorFromResponse(endpoint, status, text, headers = {}) {
  let detailMessage = '';
  try {
    const j = JSON.parse(text);
    const detail = j.detail;
    if (typeof detail === 'string') detailMessage = detail;
    else if (detail && typeof detail === 'object') detailMessage = JSON.stringify(detail).slice(0, 400);
    else detailMessage = j.message || '';
  } catch {}
  const retryAfterMs = parseRetryAfterMs(
    headers['retry-after'] ?? headers['Retry-After'] ?? null
  );
  if (status === 401) return new ProtocolError('auth', `未登录或会话过期 (${endpoint}): ${detailMessage || status}`, { status, endpoint });
  if (status === 403) return new ProtocolError('forbidden', `无权访问 (${endpoint}): ${detailMessage || status}`, { status, endpoint });
  if (status === 404) return new ProtocolError('not_found', `不存在 (${endpoint}): ${detailMessage || status}`, { status, endpoint });
  if (status === 429) return new ProtocolError('rate_limited', `触发限流 (${endpoint}): ${detailMessage || status}`, { status, retryAfterMs, endpoint });
  if (status >= 500) return new ProtocolError('server', `服务端错误 (${endpoint}): ${detailMessage || status}`, { status, endpoint });
  return new ProtocolError('server', `请求失败 (${endpoint}): HTTP ${status} ${detailMessage}`.trim(), { status, endpoint });
}

/**
 * 页面内执行带 Bearer 的 fetch（由 Puppeteer 序列化，不能用字符串函数）。
 * 返回 { status, ok, text, headers, authError?, networkError? }
 */
async function authFetchInPage(path, optionsJson) {
  const options = JSON.parse(optionsJson);
  const readSession = async (refresh) => {
    const url = refresh ? '/api/auth/session?refresh=true' : '/api/auth/session';
    const resp = await fetch(url, { cache: 'no-store' });
    return resp.json().catch(() => ({}));
  };
  const doFetch = async (token) => {
    const headers = Object.assign(
      { Authorization: 'Bearer ' + token },
      // JSON body 必须带 Content-Type，否则 FastAPI 按空 body 解析 → 422
      options.body ? { 'Content-Type': 'application/json' } : {},
      options.headers || {}
    );
    try {
      const resp = await fetch(path, {
        method: options.method || 'GET',
        headers,
        body: options.body || undefined,
      });
      const text = await resp.text().catch(() => '');
      const headersOut = {};
      for (const h of ['retry-after']) {
        const v = resp.headers && resp.headers.get && resp.headers.get(h);
        if (v) headersOut[h] = v;
      }
      return { status: resp.status, ok: resp.ok, text, headers: headersOut };
    } catch (e) {
      return { networkError: String((e && e.message) || e) };
    }
  };

  let s = await readSession(false);
  if (!s.accessToken) return { authError: true };
  let res = await doFetch(s.accessToken);
  // 长任务期间 accessToken 可能被服务端轮换：401 时刷新一次并重试。
  if (res && res.status === 401) {
    const refreshed = await readSession(true);
    if (refreshed.accessToken && refreshed.accessToken !== s.accessToken) {
      res = await doFetch(refreshed.accessToken);
    }
  }
  return res;
}

class WebProtocol {
  /** @param {import('puppeteer-core').Page} page */
  constructor(page) {
    this.page = page;
  }

  async _authFetchRaw(path, { method = 'GET', body = null, headers = {} } = {}) {
    let res;
    try {
      res = await this.page.evaluate(
        authFetchInPage,
        path,
        JSON.stringify({ method, body, headers })
      );
    } catch (err) {
      // 页面跳转导致的 execution context 销毁等
      throw new ProtocolError('network', `页面请求执行失败 (${path}): ${err && err.message}`, { endpoint: path });
    }
    if (res.authError) {
      throw new ProtocolError('auth', `无法获取 accessToken（未登录 chatgpt.com？）(${path})`, { endpoint: path });
    }
    if (res.networkError) {
      throw new ProtocolError('network', `网络错误 (${path}): ${res.networkError}`, { endpoint: path });
    }
    if (!res.ok) {
      throw protocolErrorFromResponse(path, res.status, res.text, res.headers || {});
    }
    return res;
  }

  async _authFetch(path, { method = 'GET', body = null, headers = {} } = {}) {
    const res = await this._authFetchRaw(path, { method, body, headers });
    // 部分写接口（如 files/process_upload_stream）成功时返回空响应体
    if (!String(res.text || '').trim()) return null;
    try {
      return JSON.parse(res.text);
    } catch {
      throw new ProtocolError('parse', `响应不是合法 JSON (${path})`, { endpoint: path });
    }
  }

  // ── 会话读取 ────────────────────────────────────────────────────────────────

  /**
   * 读取一页会话。
   * @param {object} [opts] { numTurns, before, after }
   * @returns {Promise<{payload, snapshot}>} snapshot 为 parseConversationPayload 结果
   */
  async fetchConversation(conversationId, opts = {}) {
    const params = new URLSearchParams();
    params.set('num_turns', String(opts.numTurns ?? 10));
    params.set('include_has_versions', 'true');
    if (opts.before) params.set('before', opts.before);
    if (opts.after) params.set('after', opts.after);
    const path = `/backend-api/conversations/${conversationId}?${params.toString()}`;
    const payload = await this._authFetch(path);
    return { payload, snapshot: parseConversationPayload(payload, { conversationId }) };
  }

  /**
   * 完整读取会话（按 page_info.has_previous_page 向前翻页直到读全或达页数上限）。
   * 返回 snapshot.partial=false 表示已读全；true 表示仍有历史未读。
   */
  async readConversation(conversationId, { numTurns = 10, maxPages = 20 } = {}) {
    const first = await this.fetchConversation(conversationId, { numTurns });
    const pages = [first.snapshot];
    let cursor = first.snapshot.pageInfo && first.snapshot.pageInfo.startCursor;
    let fetched = 1;
    while (
      first.snapshot.pageInfo &&
      first.snapshot.pageInfo.hasPreviousPage &&
      cursor &&
      fetched < maxPages
    ) {
      const page = await this.fetchConversation(conversationId, {
        numTurns,
        before: cursor,
      });
      pages.push(page.snapshot);
      fetched += 1;
      const pi = page.snapshot.pageInfo;
      cursor = pi && pi.hasPreviousPage ? pi.startCursor : null;
      if (!page.snapshot.messages.length) break;
    }

    // pages 按「最新页 → 更旧页」抓取；合并时反转为时间序（旧 → 新）。
    // mergePagedMessages 按 id 去重且保持首见顺序，禁止按下标合并。
    const messages = mergePagedMessages(
      pages.slice().reverse().map((p) => p.messages)
    );
    const latest = pages[0]; // 第一页是最新状态（completion / pageInfo / branch 以此为准）
    const oldest = pages[pages.length - 1];
    const stillPartial = Boolean(
      oldest.pageInfo && oldest.pageInfo.hasPreviousPage && cursor
    );
    return {
      snapshot: {
        ...latest,
        id: latest.id || conversationId,
        messages,
        visibleMessages: messages.filter(
          (m) => m.weight !== 0 && !m.hidden && (m.text || m.files.length)
        ),
        pageInfo: latest.pageInfo,
        partial: stillPartial,
        pagesFetched: fetched,
      },
      pagesFetched: fetched,
    };
  }

  // ── 列表 ────────────────────────────────────────────────────────────────────

  async listConversations({ limit = 20, offset = 0, gizmoId = null, order = 'updated' } = {}) {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    params.set('order', order);
    if (gizmoId) {
      params.set('exclude_conversation_origin', 'tpp');
      const items = await this._authFetch(`/backend-api/gizmos/${gizmoId}/conversations?limit=${limit}&owned_only=false`);
      return items;
    }
    const payload = await this._authFetch(`/backend-api/conversations?${params.toString()}`);
    return payload;
  }

  // ── 模型目录（仅用于展示与解析；选择以页面 UI 为准）─────────────────────────

  async fetchModelsCatalog() {
    return this._authFetch('/backend-api/models?history_and_training_excluded=false');
  }

  // ── 项目 ────────────────────────────────────────────────────────────────────

  async fetchGizmoConfig(gizmoId) {
    return this._authFetch(`/backend-api/gizmos/${gizmoId}?include_file_limits=true`);
  }

  // ── 文件（三段式上传；写契约 probe-pending，沿用 v1.2.2 已验证实现）──────────

  async createRemoteFile(payload) {
    return this._authFetch('/backend-api/files', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async deleteRemoteFile(fileId) {
    return this._authFetch(`/backend-api/files/${fileId}`, { method: 'DELETE' });
  }

  async uploadBlobToUrl(uploadUrl, fileContent, mimeType) {
    // blob 上传不在页面上下文做（跨域 + 大体积），走 Node Buffer + page fetch 的
    // base64 桥（与 v1.2.2 相同的已验证路径）。
    const res = await this.page.evaluate(
      async (url, b64, contentType) => {
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
      },
      uploadUrl,
      Buffer.from(fileContent).toString('base64'),
      mimeType || 'application/octet-stream'
    );
    if (!res.ok && res.status !== 201) {
      throw new ProtocolError('server', `Blob 上传失败: ${res.status} ${res.text || ''}`.trim(), { status: res.status });
    }
    return res;
  }

  async markFileUploaded(fileId) {
    await this._authFetch(`/backend-api/files/${fileId}/uploaded`, {
      method: 'POST',
      body: '{}',
    });
  }

  /**
   * 项目文件处理：响应为 text/event-stream（逐行 JSON 事件）。
   * 读取完整流（等待 processing/indexing 结束）并解析事件数组。
   */
  async processProjectUploadStream(payload) {
    const res = await this._authFetchRaw('/backend-api/files/process_upload_stream', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const events = String(res.text || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
    return { events, last: events[events.length - 1] || null };
  }

  async upsertProject(body) {
    // ⚠ 写契约 probe-pending：v1.2.2 实现保留，PR06 实机复核后移除本标记。
    return this._authFetch('/backend-api/gizmos/snorlax/upsert', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

}

module.exports = { WebProtocol, ProtocolError, protocolErrorFromResponse, parseRetryAfterMs };
