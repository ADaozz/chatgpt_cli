'use strict';

/**
 * web-protocol.test.js — 分页读取 / 错误映射 / Retry-After（不依赖浏览器）
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  WebProtocol,
  ProtocolError,
  protocolErrorFromResponse,
  parseRetryAfterMs,
} = require('../web-protocol');

function linearPage(messages, { hasPrevious = false, startCursor = null } = {}) {
  return {
    conversation_id: 'conv-1',
    title: 'T',
    current_node: messages.length ? messages[messages.length - 1].id : null,
    async_status: null,
    messages,
    page_info: {
      start_cursor: startCursor || (messages[0] && messages[0].id),
      end_cursor: messages.length ? messages[messages.length - 1].id : null,
      has_previous_page: hasPrevious,
      has_next_page: false,
    },
  };
}

function msg(id, text, parent, extra = {}) {
  return {
    id,
    author: { role: 'assistant' },
    content: { content_type: 'text', parts: [text] },
    status: 'finished_successfully',
    end_turn: true,
    channel: 'final',
    weight: 1,
    metadata: { parent_id: parent || null, working_turn_id: 'turn-' + id },
    ...extra,
  };
}

describe('readConversation pagination', () => {
  it('merges backward pages into chronological order and reads fully', async () => {
    const proto = new WebProtocol({});
    const calls = [];
    proto._authFetch = async (path) => {
      calls.push(path);
      if (path.includes('before=B1')) {
        return linearPage([msg('A1', 'old1', null), msg('A2', 'old2', 'A1')], {
          hasPrevious: false,
          startCursor: 'A1',
        });
      }
      return linearPage([msg('B1', 'new1', 'A2', { channel: 'final' })], {
        hasPrevious: true,
        startCursor: 'B1',
      });
    };

    const { snapshot, pagesFetched } = await proto.readConversation('conv-1', { numTurns: 1, maxPages: 5 });
    assert.equal(pagesFetched, 2);
    assert.deepEqual(snapshot.messages.map((m) => m.id), ['A1', 'A2', 'B1']);
    assert.equal(snapshot.partial, false);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].includes('before=B1'));
  });

  it('marks partial when maxPages is exhausted', async () => {
    const proto = new WebProtocol({});
    proto._authFetch = async () => linearPage([msg('M1', 'text', null)], {
      hasPrevious: true,
      startCursor: 'M1',
    });
    const { snapshot, pagesFetched } = await proto.readConversation('conv-1', { numTurns: 1, maxPages: 2 });
    assert.equal(pagesFetched, 2);
    assert.equal(snapshot.partial, true);
  });
});

describe('auth fetch headers', () => {
  it('adds Content-Type for JSON bodies (regression: 422 on POST)', async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (path, opts) => {
      calls.push({ path, opts });
      if (path === '/api/auth/session') {
        return { json: async () => ({ accessToken: 'test-token' }), status: 200, ok: true, headers: { get: () => null }, text: async () => '{}' };
      }
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => '{"ok":true}' };
    };
    try {
      const proto = new WebProtocol({ evaluate: async (fn, ...args) => fn(...args) });
      await proto._authFetch('/backend-api/files', { method: 'POST', body: '{"a":1}' });
      const filesCall = calls.find((c) => c.path === '/backend-api/files');
      assert.ok(filesCall, 'should call the endpoint');
      assert.equal(filesCall.opts.headers['Content-Type'], 'application/json');
      assert.equal(filesCall.opts.headers.Authorization, 'Bearer test-token');
      assert.equal(filesCall.opts.body, '{"a":1}');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('does not add Content-Type for GET requests', async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (path, opts) => {
      calls.push({ path, opts });
      if (path === '/api/auth/session') {
        return { json: async () => ({ accessToken: 't' }), status: 200, ok: true, headers: { get: () => null }, text: async () => '{}' };
      }
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => '{"ok":true}' };
    };
    try {
      const proto = new WebProtocol({ evaluate: async (fn, ...args) => fn(...args) });
      await proto._authFetch('/backend-api/models');
      const call = calls.find((c) => c.path === '/backend-api/models');
      assert.equal(call.opts.headers['Content-Type'], undefined);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('error mapping', () => {
  it('maps 401/403/404/429/5xx to typed errors', () => {
    assert.equal(protocolErrorFromResponse('/x', 401, '{}').kind, 'auth');
    assert.equal(protocolErrorFromResponse('/x', 403, '{}').kind, 'forbidden');
    assert.equal(protocolErrorFromResponse('/x', 404, '{}').kind, 'not_found');
    assert.equal(protocolErrorFromResponse('/x', 500, '{}').kind, 'server');
    const limited = protocolErrorFromResponse('/x', 429, '{"detail":{"message":"slow down"}}', { 'retry-after': '7' });
    assert.equal(limited.kind, 'rate_limited');
    assert.equal(limited.retryAfterMs, 7000);
    assert.match(limited.message, /slow down/);
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    assert.equal(parseRetryAfterMs('3'), 3000);
    assert.equal(parseRetryAfterMs(null), null);
    const future = new Date(Date.now() + 5000).toUTCString();
    assert.ok(parseRetryAfterMs(future) > 1000);
  });

  it('auth failure surfaces as ProtocolError auth', async () => {
    const proto = new WebProtocol({});
    proto.page = {
      evaluate: async () => ({ authError: true }),
    };
    await assert.rejects(
      () => proto.fetchConversation('conv-1'),
      (err) => err instanceof ProtocolError && err.kind === 'auth'
    );
  });
});
