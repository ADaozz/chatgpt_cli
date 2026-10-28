'use strict';

/**
 * response-tracker-policy.test.js — 协议驱动的完成状态机策略
 *
 * 核心约束（PR04）：
 *   - 只有协议确认终态才返回 completed；
 *   - thinking / 部分回复 / DOM 静默都不是完成；
 *   - 429 遵循 Retry-After，不无限快速重试；
 *   - 超时/协议持续失败 → timeout/unknown，保留部分文本，不声称成功。
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
// DOM 证据稳定窗口在模块加载时读取，测试里缩短（默认 2000ms）
process.env.CHATGPT_DOM_CONFIRM_MS = '40';
const { ResponseTracker } = require('../response-tracker');
const { ProtocolError } = require('../web-protocol');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makePages({ turnCount = 1 } = {}) {
  const listeners = new Set();
  const page = { __chatgptCliDomBridge: { listeners, exposed: true } };
  return {
    page,
    async installObserver() {
      return { bridge: { listeners, exposed: true }, result: null };
    },
    async sampleDom() {
      return {
        turnCount,
        turnState: 'complete',
        turnComplete: true,
        uiTurnComplete: true,
        turnInProgress: false,
        stopVisible: false,
        sendReady: true,
        copyActionInLastTurn: true,
        assistantUnitCount: 1,
        userBubbleCount: 1,
        lastTextLength: 10,
        lastTextTail: 'tail',
        url: 'https://chatgpt.com/c/conv-1',
      };
    },
    async uninstallObserver() {},
    async waitForConversationId() { return 'conv-1'; },
  };
}

function snapshot({ turnComplete, text = '', asyncInProgress = false, openReasoning = false, partial = false }) {
  const messages = text
    ? [{ id: 'm1', role: 'assistant', channel: 'final', status: 'finished_successfully', endTurn: true, text, files: [], blocks: [], hasUnsupportedContent: false }]
    : [];
  return {
    id: 'conv-1',
    messages,
    visibleMessages: messages,
    completion: {
      asyncInProgress,
      hasOpenReasoning: openReasoning,
      finalComplete: turnComplete === true,
      turnComplete,
      lastFinal: messages[0] || null,
    },
    pageInfo: null,
    partial,
  };
}

describe('completion requires protocol confirmation', () => {
  it('completes when protocol confirms the final turn', async () => {
    const pages = makePages();
    const protocol = {
      async fetchConversation() {
        return { snapshot: snapshot({ turnComplete: true, text: 'final answer' }) };
      },
      async readConversation() {
        return { snapshot: snapshot({ turnComplete: true, text: 'final answer' }) };
      },
    };
    const tracker = new ResponseTracker({
      pageController: pages,
      protocol,
      conversationId: 'conv-1',
      requireNewTurn: false,
      pollIntervalMs: 10,
      timeoutMs: 2000,
    });
    await tracker.start();
    const result = await tracker.waitForComplete();
    await tracker.stop().catch(() => {});
    assert.equal(result.state, 'completed');
    assert.equal(result.text, 'final answer');
    assert.equal(result.error, null);
  });

  it('never completes while reasoning is open (thinking phase)', async () => {
    const pages = makePages();
    // DOM 显示仍在生成（活跃 thinking）：不应误判取消，只能超时/unknown
    pages.sampleDom = async () => ({
      turnCount: 1,
      turnState: 'in_progress',
      uiTurnComplete: false,
      turnInProgress: true,
      stopVisible: true,
      sendReady: false,
      assistantUnitCount: 0,
      userBubbleCount: 1,
      lastTextLength: 0,
      lastTextTail: '',
      url: 'https://chatgpt.com/c/conv-1',
    });
    const protocol = {
      async fetchConversation() {
        return {
          snapshot: snapshot({
            turnComplete: false,
            text: 'partial thinking text',
            openReasoning: true,
          }),
        };
      },
      async readConversation() {
        return { snapshot: snapshot({ turnComplete: false, text: 'partial thinking text', openReasoning: true }) };
      },
    };
    const tracker = new ResponseTracker({
      pageController: pages,
      protocol,
      conversationId: 'conv-1',
      requireNewTurn: false,
      pollIntervalMs: 10,
      timeoutMs: 150,
    });
    await tracker.start();
    const result = await tracker.waitForComplete();
    await tracker.stop().catch(() => {});
    assert.notEqual(result.state, 'completed');
    assert.ok(['unknown', 'timeout'].includes(result.state));
    // 部分文本必须保留
    assert.equal(result.text, 'partial thinking text');
    assert.equal(result.partialTextPreserved, true);
  });

  it('does not treat DOM completion as success when protocol never confirms', async () => {
    const pages = makePages(); // DOM 显示 complete
    const protocol = {
      async fetchConversation() {
        throw new ProtocolError('server', 'HTTP 503', { status: 503 });
      },
      async readConversation() {
        throw new ProtocolError('server', 'HTTP 503', { status: 503 });
      },
    };
    const tracker = new ResponseTracker({
      pageController: pages,
      protocol,
      conversationId: 'conv-1',
      requireNewTurn: false,
      pollIntervalMs: 10,
      timeoutMs: 3000,
    });
    await tracker.start();
    const result = await tracker.waitForComplete();
    await tracker.stop().catch(() => {});
    assert.notEqual(result.state, 'completed');
    assert.equal(result.error !== null, true);
  });

  it('times out without claiming success when no new turn appears', async () => {
    const pages = makePages();
    const protocol = {
      async fetchConversation() {
        // 协议显示完成，但本轮没有新 turn（消息可能没发出去）
        return { snapshot: snapshot({ turnComplete: true, text: 'old answer' }) };
      },
      async readConversation() {
        return { snapshot: snapshot({ turnComplete: true, text: 'old answer' }) };
      },
    };
    const tracker = new ResponseTracker({
      pageController: pages,
      protocol,
      conversationId: 'conv-1',
      requireNewTurn: true,
      baselineTurnCount: 1, // DOM turnCount 也是 1 → 未观察到新 turn
      pollIntervalMs: 10,
      timeoutMs: 200,
    });
    await tracker.start();
    const result = await tracker.waitForComplete();
    await tracker.stop().catch(() => {});
    assert.equal(result.state, 'timeout');
    assert.match(result.error, /未观察到本轮新回复/);
  });
});

describe('rate limiting', () => {
  it('honors Retry-After and continues polling', async () => {
    const pages = makePages();
    let calls = 0;
    const waits = [];
    const protocol = {
      async fetchConversation() {
        calls += 1;
        if (calls === 1) {
          const err = new ProtocolError('rate_limited', 'HTTP 429', { status: 429, retryAfterMs: 20 });
          throw err;
        }
        return { snapshot: snapshot({ turnComplete: true, text: 'ok' }) };
      },
      async readConversation() {
        return { snapshot: snapshot({ turnComplete: true, text: 'ok' }) };
      },
    };
    const tracker = new ResponseTracker({
      pageController: pages,
      protocol,
      conversationId: 'conv-1',
      requireNewTurn: false,
      pollIntervalMs: 10,
      timeoutMs: 3000,
      onState: (e) => { if (e.type === 'rate-limited') waits.push(e.retryAfterMs); },
    });
    await tracker.start();
    const result = await tracker.waitForComplete();
    await tracker.stop().catch(() => {});
    assert.equal(result.state, 'completed');
    assert.deepEqual(waits, [20]);
    assert.ok(calls >= 2);
  });
});

describe('cancelled / interrupted turns', () => {
  it('returns cancelled when protocol shows open reasoning but no async work and DOM stopped', async () => {
    const pages = makePages({ turnCount: 2 }); // DOM 显示已结束
    const protocol = {
      async fetchConversation() {
        return {
          snapshot: snapshot({
            turnComplete: false,
            openReasoning: true,
            text: '',
          }),
        };
      },
      async readConversation() {
        return { snapshot: snapshot({ turnComplete: false, openReasoning: true }) };
      },
    };
    const tracker = new ResponseTracker({
      pageController: pages,
      protocol,
      conversationId: 'conv-1',
      requireNewTurn: true,
      baselineTurnCount: 1, // 已观察到新 turn（turnCount=2）
      pollIntervalMs: 10,
      timeoutMs: 5000,
    });
    await tracker.start();
    const result = await tracker.waitForComplete();
    await tracker.stop().catch(() => {});
    assert.equal(result.state, 'cancelled');
    assert.match(result.error, /中断/);
  });

  it('does not cancel while DOM still shows generation in progress', async () => {
    const pages = makePages({ turnCount: 2 });
    // DOM 显示仍在生成（turn-state=in_progress）
    pages.sampleDom = async () => ({
      turnCount: 2,
      turnState: 'in_progress',
      uiTurnComplete: false,
      turnInProgress: true,
      stopVisible: true,
      sendReady: false,
      assistantUnitCount: 1,
      userBubbleCount: 2,
      lastTextLength: 3,
      lastTextTail: '...',
      url: 'https://chatgpt.com/c/conv-1',
    });
    const protocol = {
      async fetchConversation() {
        return { snapshot: snapshot({ turnComplete: false, openReasoning: true }) };
      },
      async readConversation() {
        return { snapshot: snapshot({ turnComplete: false, openReasoning: true }) };
      },
    };
    const tracker = new ResponseTracker({
      pageController: pages,
      protocol,
      conversationId: 'conv-1',
      requireNewTurn: true,
      baselineTurnCount: 1,
      pollIntervalMs: 10,
      timeoutMs: 120,
    });
    await tracker.start();
    const result = await tracker.waitForComplete();
    await tracker.stop().catch(() => {});
    assert.notEqual(result.state, 'cancelled');
    assert.notEqual(result.state, 'completed');
  });
});

describe('DOM-confirmed completion (v1.2.2 behavior restored)', () => {
  function domCompletePages({ turnCount = 2, text = 'reply from DOM' } = {}) {
    const pages = makePages({ turnCount });
    pages.sampleDom = async () => ({
      turnCount,
      turnState: 'complete',
      turnStateKnown: true,
      uiTurnComplete: true,
      turnInProgress: false,
      stopVisible: false,
      sendReady: false,
      copyActionInLastTurn: true,
      assistantUnitCount: 1,
      userBubbleCount: turnCount,
      lastTextLength: text.length,
      lastTextTail: text.slice(-20),
      lastText: text,
      url: 'https://chatgpt.com/c/conv-1',
    });
    return pages;
  }

  it('completes from DOM evidence when the protocol is unreachable', async () => {
    const pages = domCompletePages();
    const protocol = {
      async fetchConversation() {
        const err = new ProtocolError('network', 'net::ERR_CONNECTION_TIMED_OUT');
        throw err;
      },
      async readConversation() {
        throw new ProtocolError('network', 'net::ERR_CONNECTION_TIMED_OUT');
      },
    };
    const tracker = new ResponseTracker({
      pageController: pages,
      protocol,
      conversationId: 'conv-1',
      requireNewTurn: true,
      baselineTurnCount: 1,
      pollIntervalMs: 10,
      timeoutMs: 5000,
    });
    await tracker.start();
    const result = await tracker.waitForComplete();
    await tracker.stop().catch(() => {});
    assert.equal(result.state, 'completed');
    assert.equal(result.completionSource, 'dom');
    assert.equal(result.text, 'reply from DOM');
    assert.match(result.error, /DOM 完成证据/);
  });

  it('does not complete from DOM while the protocol confirms generation is running', async () => {
    const pages = domCompletePages();
    const protocol = {
      async fetchConversation() {
        return {
          snapshot: snapshot({ turnComplete: false, openReasoning: false, asyncInProgress: true, text: 'partial' }),
        };
      },
      async readConversation() {
        return { snapshot: snapshot({ turnComplete: false, asyncInProgress: true, text: 'partial' }) };
      },
    };
    const tracker = new ResponseTracker({
      pageController: pages,
      protocol,
      conversationId: 'conv-1',
      requireNewTurn: true,
      baselineTurnCount: 1,
      pollIntervalMs: 10,
      timeoutMs: 300,
    });
    await tracker.start();
    const result = await tracker.waitForComplete();
    await tracker.stop().catch(() => {});
    assert.notEqual(result.state, 'completed');
  });

  it('reports completionSource=protocol on protocol-confirmed completion', async () => {
    const pages = makePages({ turnCount: 2 });
    const protocol = {
      async fetchConversation() {
        return { snapshot: snapshot({ turnComplete: true, text: 'final' }) };
      },
      async readConversation() {
        return { snapshot: snapshot({ turnComplete: true, text: 'final' }) };
      },
    };
    const tracker = new ResponseTracker({
      pageController: pages,
      protocol,
      conversationId: 'conv-1',
      requireNewTurn: true,
      baselineTurnCount: 1,
      pollIntervalMs: 10,
      timeoutMs: 2000,
    });
    await tracker.start();
    const result = await tracker.waitForComplete();
    await tracker.stop().catch(() => {});
    assert.equal(result.state, 'completed');
    assert.equal(result.completionSource, 'protocol');
  });
});

describe('conversation id resolution', () => {
  it('ignores /c/local-chatgpt placeholder until a real UUID appears', async () => {
    const pages = makePages({ turnCount: 2 });
    let url = 'https://chatgpt.com/c/local-chatgpt';
    pages.url = () => url;
    const asked = [];
    const protocol = {
      async fetchConversation(id) {
        asked.push(id);
        return { snapshot: snapshot({ turnComplete: true, text: 'ok' }) };
      },
      async readConversation(id) {
        asked.push(id);
        return { snapshot: snapshot({ turnComplete: true, text: 'ok' }) };
      },
    };
    const tracker = new ResponseTracker({
      pageController: pages,
      protocol,
      conversationId: null,
      requireNewTurn: true,
      baselineTurnCount: 1,
      pollIntervalMs: 10,
      timeoutMs: 2000,
    });
    await tracker.start();
    // 第一拍：URL 还是占位 id → 不得发起协议请求
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(asked, []);
    // 服务端 id 就绪
    url = 'https://chatgpt.com/c/6ae18529-aa30-83e9-8a50-d0ebadfd0e35';
    await new Promise((r) => setTimeout(r, 80));
    const result = await tracker.waitForComplete();
    await tracker.stop().catch(() => {});
    assert.equal(result.state, 'completed');
    assert.equal(result.conversationId, '6ae18529-aa30-83e9-8a50-d0ebadfd0e35');
    assert.ok(asked.every((id) => id === '6ae18529-aa30-83e9-8a50-d0ebadfd0e35'));
  });
});

describe('partial results', () => {
  it('keeps last known text and blocks on final read failure', async () => {
    const pages = makePages();
    const protocol = {
      async fetchConversation() {
        return {
          snapshot: snapshot({ turnComplete: true, text: 'full answer' }),
        };
      },
      async readConversation() {
        throw new ProtocolError('network', 'disconnected');
      },
    };
    const tracker = new ResponseTracker({
      pageController: pages,
      protocol,
      conversationId: 'conv-1',
      requireNewTurn: false,
      pollIntervalMs: 10,
      timeoutMs: 2000,
    });
    await tracker.start();
    const result = await tracker.waitForComplete();
    await tracker.stop().catch(() => {});
    assert.equal(result.state, 'completed');
    assert.equal(result.text, 'full answer');
    assert.equal(result.partial, true);
  });
});

void sleep;
