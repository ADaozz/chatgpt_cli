'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const S = require('../selectors');
const { ResponseTracker } = require('../response-tracker');
const { inspectPageDom } = require('../scripts/check-selectors');

// 在独立 about:blank 标签页放置 DOM fixture，不操作用户对话、不发送消息。
// CHATGPT_TEST_BROWSER_URL=http://<CDP地址> node --test test/dom-selectors.test.js
it('validates DOM detection and completion against browser fixtures', {
  skip: !process.env.CHATGPT_TEST_BROWSER_URL,
}, async (t) => {
  const browser = await puppeteer.connect({ browserURL: process.env.CHATGPT_TEST_BROWSER_URL,
    defaultViewport: null, protocolTimeout: 20000 });
  const page = await browser.newPage();
  const trackers = [];
  const start = async (options = {}) => {
    const tracker = new ResponseTracker(page, { requireNewActivity: false,
      quietWindowMs: 25, fallbackQuietMs: 40, shortBackendConfirmedQuietMs: 20,
      watchdogIntervalMs: 25, timeout: 1000, ...options });
    trackers.push(tracker);
    await tracker.start();
    return tracker;
  };
  const cleanup = async () => {
    for (const tracker of trackers.splice(0)) await tracker.stop();
  };
  try {
    await t.test('legacy DOM remains supported', async () => {
      await page.setContent('<section data-turn="assistant"><div data-message-author-role="assistant">' +
        '<div class="markdown">legacy answer</div></div><button data-testid="copy-turn-action-button">Copy</button></section>');
      const tracker = await start();
      assert.equal(tracker.lastSample.text, 'legacy answer');
      assert.equal(tracker.lastSample.hasCopyAction, true);
      assert.equal((await tracker.waitForComplete()).state, 'completed');
      await cleanup();
    });
    await t.test('new DOM excludes thought summaries and detects stale selectors', async () => {
      await page.setContent('<div data-turn-key="new"><div data-talvt-turn-state="complete">' +
        '<div data-user-message-bubble>question</div><div data-chatgpt-search-unit-key="turn:2:assistant">' +
        '<h6 data-conversation-role="assistant">ChatGPT says:</h6>' +
        '<div data-markdown-text-style="assistant-message" data-markdown-text-tone="tertiary">thinking summary</div>' +
        '<div data-markdown-text-style="assistant-message">final answer</div></div>' +
        '<div class="turn-action-controls"><button aria-label="复制">Copy</button></div></div></div>' +
        '<form data-chatgpt-composer><div contenteditable="true" role="textbox" data-composer-markdown></div></form>');
      const tracker = await start();
      assert.equal(tracker.lastSample.text, 'final answer');
      assert.equal(tracker.lastSample.messageCount, 2);
      assert.equal(tracker.lastSample.assistantMessageCount, 1);
      assert.equal(tracker.lastSample.turnState, 'complete');
      assert.equal((await tracker.waitForComplete()).state, 'completed');
      const outdated = structuredClone(S);
      outdated.composer.textarea = '#obsolete-input';
      const report = await page.evaluate(inspectPageDom, outdated);
      assert.equal(report.checks.find(c => c.name === 'composer.input').status, 'stale');
      assert.equal(report.checks.find(c => c.name === 'composer.stop').status, 'unverified');
      await cleanup();
    });
    await t.test('old turn Copy and code Copy cannot finish a streaming new turn', async () => {
      await page.setContent('<div data-turn-key="old"><div data-talvt-turn-state="complete">' +
        '<div class="turn-action-controls"><button aria-label="复制">Copy</button></div></div></div>' +
        '<div data-turn-key="new"><div data-talvt-turn-state="streaming">' +
        '<div data-chatgpt-search-unit-key="new:2:assistant"><div data-markdown-text-style="assistant-message">partial answer' +
        '<div data-markdown-copy="code-block"><button aria-label="复制">Copy code</button></div></div></div></div></div>' +
        '<form data-chatgpt-composer><button aria-label="停止">Stop</button></form>');
      const tracker = await start({ timeout: 120 });
      assert.equal(tracker.lastSample.hasCopyAction, false);
      assert.equal(tracker.lastSample.isResponding, true);
      const result = await tracker.waitForComplete();
      assert.equal(result.state, 'timeout');
      assert.equal(result.source, 'timeout-still-running');
      assert.equal(tracker._watchdog, null);
      await cleanup();
    });
    await t.test('turn state attribute changes notify completion without watchdog polling', async () => {
      const tracker = await start({ watchdogIntervalMs: 10000, timeout: 2000 });
      await page.evaluate(() => document.querySelector('[data-turn-key="new"] [data-talvt-turn-state]')
        .setAttribute('data-talvt-turn-state', 'complete'));
      const result = await tracker.waitForComplete();
      assert.equal(result.state, 'completed');
      assert.ok(result.elapsedMs < 2000);
      assert.equal(tracker._watchdog, null);
      assert.equal(tracker._quietTimer, null);
      await cleanup();
      assert.equal(await page.evaluate(() => Boolean(window.__chatgptCliSampleDom)), false);
    });
    await t.test('stale cached observers are replaced', async () => {
      await page.evaluate(() => {
        window.__chatgptCliObserverInstalled = true;
        window.__chatgptCliSampleDom = () => ({ messageCount: 0 });
        window.__chatgptCliObserverUninstall = () => { window.staleUninstalled = true; };
      });
      const tracker = await start();
      assert.equal(await page.evaluate(() => window.staleUninstalled), true);
      assert.equal(tracker.lastSample.assistantMessageCount, 1);
      assert.equal((await tracker.waitForComplete()).state, 'completed');
      await cleanup();
    });
  } finally {
    await cleanup();
    await page.close();
    await browser.disconnect();
  }
});
