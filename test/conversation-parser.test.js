'use strict';

/**
 * conversation-parser.test.js — 线性 messages 解析 / 分支恢复 / 分页 / 结构化内容
 * 依据：2026-10-28 实机契约（docs/contracts/chatgpt-web-contract.md）
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseConversationPayload,
  extractTurnCompletion,
  isAsyncStatusInProgress,
  linearizeLinearMessages,
  mergePagedMessages,
  getLastAssistantFromSnapshot,
  extractStructuredBlocks,
  normalizeContentParts,
} = require('../conversation-parser');

function msg(id, role, text, extra = {}) {
  return {
    id,
    author: { role },
    content: { content_type: 'text', parts: text == null ? [''] : [text] },
    status: 'finished_successfully',
    end_turn: null,
    weight: 1,
    channel: null,
    create_time: 1,
    metadata: { parent_id: null, working_turn_id: 'turn-1' },
    ...extra,
    metadata: { parent_id: null, working_turn_id: 'turn-1', ...(extra.metadata || {}) },
  };
}

describe('isAsyncStatusInProgress', () => {
  it('treats idle values as not running', () => {
    for (const v of [null, undefined, 0, '0', '']) {
      assert.equal(isAsyncStatusInProgress(v), false, `value=${v}`);
    }
  });
  it('treats positive numbers / strings as running', () => {
    for (const v of [3, '3', 1]) assert.equal(isAsyncStatusInProgress(v), true, `value=${v}`);
  });
});

describe('linearizeLinearMessages', () => {
  it('walks from current_node to root via parent_id', () => {
    const messages = [
      msg('a', 'user', 'q1'),
      msg('b', 'assistant', 'a1', { metadata: { parent_id: 'a' } }),
      msg('c', 'user', 'q2', { metadata: { parent_id: 'b' } }),
      msg('d', 'assistant', 'a2', { metadata: { parent_id: 'c' } }),
    ];
    assert.deepEqual(linearizeLinearMessages(messages, 'd').map((m) => m.id), ['a', 'b', 'c', 'd']);
    // 分支：current_node 指向 c 时不应包含 d
    assert.deepEqual(linearizeLinearMessages(messages, 'c').map((m) => m.id), ['a', 'b', 'c']);
  });

  it('falls back to array tail when current_node is absent', () => {
    const messages = [msg('a', 'user', 'q')];
    assert.deepEqual(linearizeLinearMessages(messages, null).map((m) => m.id), ['a']);
  });
});

describe('parseConversationPayload (linear)', () => {
  const base = () => ({
    conversation_id: 'conv-1',
    title: 'Title',
    current_node: 'b',
    async_status: null,
    messages: [
      msg('sys', 'system', '', { weight: 0, metadata: { is_visually_hidden_from_conversation: true } }),
      msg('a', 'user', '1+1=?'),
      msg('r', 'assistant', 'thinking...', {
        end_turn: false,
        channel: null,
        metadata: { parent_id: 'a', reasoning_status: 'is_reasoning' },
      }),
      msg('b', 'assistant', '1 + 1 = **2**', {
        end_turn: true,
        channel: 'final',
        metadata: { parent_id: 'r', is_complete: true, finish_details: { type: 'stop' } },
      }),
    ],
    page_info: {
      start_cursor: 'a',
      end_cursor: 'b',
      has_previous_page: true,
      has_next_page: false,
    },
  });

  it('parses linear shape and filters hidden scaffolding', () => {
    const parsed = parseConversationPayload(base());
    assert.equal(parsed.shape, 'linear');
    assert.equal(parsed.id, 'conv-1');
    assert.equal(parsed.messages.length, 4);
    // system weight=0 与 hidden 被 visible 过滤
    assert.ok(!parsed.visibleMessages.some((m) => m.role === 'system'));
    assert.equal(parsed.visibleMessages.at(-1).text, '1 + 1 = **2**');
  });

  it('marks pagination as partial when has_previous_page', () => {
    const parsed = parseConversationPayload(base());
    assert.equal(parsed.partial, true);
    assert.equal(parsed.pageInfo.hasPreviousPage, true);

    const full = base();
    full.page_info.has_previous_page = false;
    assert.equal(parseConversationPayload(full).partial, false);
  });

  it('does not complete while reasoning is open (no final yet)', () => {
    const payload = base();
    payload.current_node = 'r';
    payload.messages = payload.messages.filter((m) => m.id !== 'b');
    const parsed = parseConversationPayload(payload);
    assert.equal(parsed.completion.hasOpenReasoning, true);
    assert.equal(parsed.completion.turnComplete, false);
  });

  it('completes when historical reasoning keeps is_reasoning (live regression)', () => {
    // 实机形态：turn 内先有 is_reasoning 消息，随后 final 完成；
    // is_reasoning 标记不会清除，不能据此阻塞完成。
    const parsed = parseConversationPayload(base());
    assert.equal(parsed.completion.hasOpenReasoning, false);
    assert.equal(parsed.completion.finalComplete, true);
    assert.equal(parsed.completion.turnComplete, true);
  });

  it('completes only with final + end_turn + finished + no reasoning', () => {
    const payload = base();
    payload.messages = payload.messages.filter((m) => m.id !== 'r');
    const parsed = parseConversationPayload(payload);
    assert.equal(parsed.completion.finalComplete, true);
    assert.equal(parsed.completion.turnComplete, true);
    assert.equal(parsed.completion.lastFinal.id, 'b');
  });

  it('does not complete when async_status is in progress and no final exists', () => {
    const payload = base();
    payload.messages = payload.messages.filter((m) => m.id === 'sys' || m.id === 'a' || m.id === 'r');
    payload.current_node = 'r';
    payload.async_status = 3;
    const parsed = parseConversationPayload(payload);
    assert.equal(parsed.completion.asyncInProgress, true);
    assert.equal(parsed.completion.finalComplete, false);
    assert.equal(parsed.completion.turnComplete, false);
  });

  it('completes when a final exists even if async_status stays non-null (live: async=4)', () => {
    const payload = base();
    payload.async_status = 4;
    const parsed = parseConversationPayload(payload);
    assert.equal(parsed.completion.asyncInProgress, true);
    assert.equal(parsed.completion.finalComplete, true);
    assert.equal(parsed.completion.turnComplete, true);
  });

  it('does not complete when final message lacks end_turn', () => {
    const payload = base();
    payload.messages = payload.messages.filter((m) => m.id !== 'r');
    payload.messages.at(-1).end_turn = false;
    assert.equal(parseConversationPayload(payload).completion.turnComplete, false);
  });

  it('reports structured Genui content instead of silently treating it as text', () => {
    const payload = base();
    payload.messages = payload.messages.filter((m) => m.id !== 'r');
    payload.messages.at(-1).content.parts = ['<WritingBlock id="1" variant="document">正文'];
    const parsed = parseConversationPayload(payload);
    const last = parsed.visibleMessages.at(-1);
    assert.equal(last.hasUnsupportedContent, true);
    assert.equal(last.blocks[0].type, 'WritingBlock');
    // 原始文本保留，不被静默丢弃
    assert.ok(last.text.includes('<WritingBlock'));
  });

  it('keeps empty/invalid payload explicit rather than pretending success', () => {
    const parsed = parseConversationPayload(null);
    assert.equal(parsed.shape, 'invalid');
    assert.equal(parsed.messages.length, 0);
    assert.equal(parsed.completion, null);
  });

  it('reports unknown top-level fields for probe follow-up', () => {
    const payload = base();
    payload.new_future_field = { a: 1 };
    const parsed = parseConversationPayload(payload);
    assert.ok(parsed.unknownFields.includes('new_future_field'));
  });
});

describe('parseConversationPayload (mapping legacy shape)', () => {
  it('restores branch from current_node and completes', () => {
    const payload = {
      conversation_id: 'conv-2',
      current_node: 'b',
      async_status: null,
      mapping: {
        a: { message: msg('a', 'user', 'q'), parent: null, children: ['b'] },
        b: {
          message: msg('b', 'assistant', 'answer', {
            end_turn: true,
            channel: 'final',
            metadata: { parent_id: 'a', is_complete: true },
          }),
          parent: 'a',
          children: [],
        },
        stale: {
          message: msg('stale', 'assistant', 'old branch', { end_turn: true }),
          parent: 'a',
          children: [],
        },
      },
    };
    const parsed = parseConversationPayload(payload);
    assert.equal(parsed.shape, 'mapping');
    assert.deepEqual(parsed.branchMessageIds, ['a', 'b']);
    assert.equal(parsed.completion.turnComplete, true);
    assert.equal(parsed.completion.lastFinal.id, 'b');
  });
});

describe('mergePagedMessages', () => {
  it('dedupes by id and preserves order, never joins by index', () => {
    const page1 = [msg('a', 'user', 'q1'), msg('b', 'assistant', 'a1')];
    const page2 = [msg('b', 'assistant', 'a1'), msg('c', 'user', 'q2')];
    const merged = mergePagedMessages([page1, page2]);
    assert.deepEqual(merged.map((m) => m.id), ['a', 'b', 'c']);
  });
});

describe('helpers', () => {
  it('getLastAssistantFromSnapshot returns last non-empty assistant text', () => {
    const snapshot = {
      messages: [
        { role: 'user', text: 'q' },
        { role: 'assistant', text: 'first' },
        { role: 'assistant', text: 'second' },
      ],
    };
    assert.equal(getLastAssistantFromSnapshot(snapshot), 'second');
    assert.equal(getLastAssistantFromSnapshot(null), '');
  });

  it('normalizeContentParts flattens text/code and marks unknown content types', () => {
    assert.deepEqual(normalizeContentParts(['a', { text: 'b' }, { content_type: 'code', code: 'c' }, { content_type: 'image' }]), ['a', 'b', 'c', '[image]']);
  });

  it('extractStructuredBlocks ignores plain markdown/code fences', () => {
    assert.deepEqual(extractStructuredBlocks('```js\nconst x = 1;\n```'), { blocks: [], hasUnsupportedContent: false });
    const withComponent = extractStructuredBlocks('前 <Chart type="bar"> 后');
    assert.equal(withComponent.hasUnsupportedContent, true);
    assert.equal(withComponent.blocks[0].type, 'Chart');
  });

  it('extractTurnCompletion handles empty branch', () => {
    const c = extractTurnCompletion([], null);
    assert.equal(c.turnComplete, null);
    assert.equal(c.finalComplete, false);
  });
});
