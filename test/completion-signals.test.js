'use strict';

/**
 * completion-signals.test.js — 协议完成信号门控（thinking 不得提前完成）
 * 依据：2026-10-28 实机契约。旧的 conversation-completion.js 已并入
 * conversation-parser.extractTurnCompletion，本文件覆盖其判定矩阵。
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractTurnCompletion } = require('../conversation-parser');

function node(overrides = {}) {
  return {
    id: 'id',
    role: 'assistant',
    channel: 'final',
    status: 'finished_successfully',
    endTurn: true,
    reasoningStatus: null,
    workingTurnId: 'turn-1',
    ...overrides,
  };
}

describe('extractTurnCompletion', () => {
  it('completes only when final message is fully finished', () => {
    const c = extractTurnCompletion([node()], null);
    assert.equal(c.turnComplete, true);
    assert.equal(c.finalComplete, true);
  });

  it('blocks completion while reasoning is open (thinking phase)', () => {
    const c = extractTurnCompletion(
      [node({ channel: null, endTurn: false, reasoningStatus: 'is_reasoning' })],
      null
    );
    assert.equal(c.hasOpenReasoning, true);
    assert.equal(c.turnComplete, false);
  });

  it('ignores reasoning from previous turns', () => {
    const c = extractTurnCompletion(
      [
        node({ id: 'old', workingTurnId: 'turn-0', reasoningStatus: 'is_reasoning', channel: null, endTurn: false }),
        node({ id: 'new', workingTurnId: 'turn-1' }),
      ],
      null
    );
    assert.equal(c.hasOpenReasoning, false);
    assert.equal(c.turnComplete, true);
  });

  it('blocks completion while async_status is running and no final exists', () => {
    const c = extractTurnCompletion(
      [node({ channel: null, endTurn: null, status: 'in_progress' })],
      3
    );
    assert.equal(c.asyncInProgress, true);
    assert.equal(c.turnComplete, false);
  });

  it('lets a completed final win over a persistent async_status (live: async=4)', () => {
    // 实机：审阅完成后 async_status 持久为 4，但当前 turn 的 final 已完成
    const c = extractTurnCompletion([node()], 4);
    assert.equal(c.asyncInProgress, true);
    assert.equal(c.finalComplete, true);
    assert.equal(c.turnComplete, true);
  });

  it('does not complete when the last assistant message is not final', () => {
    const c = extractTurnCompletion(
      [node({ channel: null, endTurn: null, status: 'in_progress' })],
      null
    );
    assert.equal(c.lastFinal, null);
    assert.equal(c.turnComplete, false);
  });

  it('does not complete when end_turn is missing/false', () => {
    const c = extractTurnCompletion([node({ endTurn: false })], null);
    assert.equal(c.finalComplete, false);
    assert.equal(c.turnComplete, false);
  });

  it('does not complete when status is not finished_successfully', () => {
    const c = extractTurnCompletion([node({ status: 'in_progress' })], null);
    assert.equal(c.turnComplete, false);
  });

  it('returns null when there is no signal at all', () => {
    const c = extractTurnCompletion([], null);
    assert.equal(c.turnComplete, null);
  });
});
