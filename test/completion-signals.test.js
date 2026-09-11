'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractConversationCompletion,
  isConversationTurnComplete,
} = require('../conversation-completion');

function msg({
  id = 'm1',
  role = 'assistant',
  createTime = 1,
  text = 'hello',
  contentType = 'text',
  endTurn = false,
  reasoningStatus,
  turnId = 'turn-1',
} = {}) {
  const parts = text ? [text] : [];
  return {
    id,
    message: {
      id,
      author: { role },
      create_time: createTime,
      content: { content_type: contentType, parts },
      end_turn: endTurn,
      metadata: {
        turn_exchange_id: turnId,
        working_turn_id: turnId,
        ...(reasoningStatus ? { reasoning_status: reasoningStatus } : {}),
      },
    },
  };
}

describe('extractConversationCompletion', () => {
  it('marks thinking progress as incomplete via async_status=3', () => {
    const payload = {
      conversation_id: 'c1',
      async_status: 3,
      mapping: {
        a: msg({ id: 'a', text: '先定位文档…', createTime: 1 }),
        b: msg({
          id: 'b',
          text: '',
          contentType: 'thoughts',
          reasoningStatus: 'is_reasoning',
          createTime: 2,
        }),
      },
    };
    const completion = extractConversationCompletion(payload);
    assert.equal(completion.asyncStatus, 3);
    assert.equal(completion.hasReasoning, true);
    assert.equal(isConversationTurnComplete(completion), false);
  });

  it('marks completed conversation when async_status is null', () => {
    const payload = {
      conversation_id: 'c2',
      async_status: null,
      mapping: {
        a: msg({ id: 'a', text: '# Review Verdict', endTurn: true }),
      },
    };
    const completion = extractConversationCompletion(payload);
    assert.equal(completion.hasAsyncStatusField, true);
    assert.equal(isConversationTurnComplete(completion), true);
  });

  it('does not treat async_status null as complete while is_reasoning remains', () => {
    const payload = {
      async_status: null,
      mapping: {
        a: msg({ id: 'a', text: '进度说明', endTurn: false, createTime: 2 }),
        b: msg({
          id: 'b',
          text: '',
          contentType: 'thoughts',
          reasoningStatus: 'is_reasoning',
          createTime: 3,
        }),
      },
    };
    assert.equal(isConversationTurnComplete(extractConversationCompletion(payload)), false);
  });

  it('blocks on is_reasoning when async_status field is missing', () => {
    const payload = {
      mapping: {
        a: msg({
          id: 'a',
          text: '',
          contentType: 'thoughts',
          reasoningStatus: 'is_reasoning',
        }),
      },
    };
    const completion = extractConversationCompletion(payload);
    assert.equal(completion.hasAsyncStatusField, false);
    assert.equal(isConversationTurnComplete(completion), false);
  });

  it('returns unknown when there is no completion signal', () => {
    const payload = {
      mapping: {
        a: msg({ id: 'a', text: 'plain reply', endTurn: true }),
      },
    };
    const completion = extractConversationCompletion(payload);
    assert.equal(completion.hasReasoning, false);
    assert.equal(isConversationTurnComplete(completion), null);
  });

  it('only inspects the latest working turn for reasoning', () => {
    const payload = {
      mapping: {
        old: msg({
          id: 'old',
          turnId: 'turn-old',
          contentType: 'thoughts',
          reasoningStatus: 'is_reasoning',
          text: '',
          createTime: 1,
        }),
        neu: msg({
          id: 'neu',
          turnId: 'turn-new',
          text: 'done',
          createTime: 9,
        }),
      },
    };
    const completion = extractConversationCompletion(payload);
    assert.equal(completion.workingTurnId, 'turn-new');
    assert.equal(completion.hasReasoning, false);
    assert.equal(isConversationTurnComplete(completion), null);
  });

  it('returns null for empty payload', () => {
    assert.equal(extractConversationCompletion(null), null);
    assert.equal(isConversationTurnComplete(null), null);
  });
});
