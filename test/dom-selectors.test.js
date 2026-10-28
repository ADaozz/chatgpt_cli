'use strict';

/**
 * dom-selectors.test.js — 在真实浏览器中对 DOM fixture 验证 v2 选择器与采样器
 *
 * 运行：CHATGPT_TEST_BROWSER_URL=http://<CDP地址> node --test test/dom-selectors.test.js
 * 只操作 about:blank 新标签页，不触碰用户对话。
 */

const { it } = require('node:test');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const S = require('../selectors');
const { PageController } = require('../page-controller');

const COMPLETE_FIXTURE = `
<form data-chatgpt-composer>
  <div contenteditable="true" role="textbox" class="ProseMirror"></div>
  <button type="submit" aria-label="发送"></button>
</form>
<div data-turn-key="u1">
  <div data-talvt-turn-state="complete">
    <div data-chatgpt-search-unit-key="t:0:user">
      <div data-user-message-bubble>question</div>
    </div>
    <div data-chatgpt-search-unit-key="t:1:assistant">
      <h4 data-conversation-role="assistant">ChatGPT 说：</h4>
      <div data-markdown-text-style="assistant-message"><p>final answer</p></div>
    </div>
    <button aria-label="复制">Copy</button>
  </div>
</div>`;

const RUNNING_FIXTURE = `
<form data-chatgpt-composer>
  <div contenteditable="true" role="textbox" class="ProseMirror"></div>
  <button type="button" aria-label="停止"></button>
</form>
<div data-turn-key="u2">
  <div data-talvt-turn-state="in_progress">
    <div data-chatgpt-search-unit-key="t:0:user">
      <div data-user-message-bubble>long question</div>
    </div>
    <div data-chatgpt-search-unit-key="t:1:assistant">
      <h4 data-conversation-role="assistant">ChatGPT 说：</h4>
      <div data-markdown-text-style="assistant-message"><p>partial</p></div>
    </div>
  </div>
</div>`;

it('validates v2 selectors and sampler against browser fixtures', {
  skip: !process.env.CHATGPT_TEST_BROWSER_URL,
}, async (t) => {
  const browser = await puppeteer.connect({
    browserURL: process.env.CHATGPT_TEST_BROWSER_URL,
    defaultViewport: null,
    protocolTimeout: 20000,
  });
  const page = await browser.newPage();
  const controllers = [];
  try {
    await t.test('selectors resolve against current DOM markers', async () => {
      await page.setContent(COMPLETE_FIXTURE);
      const found = await page.evaluate((sel) => ({
        textbox: document.querySelectorAll(sel.composer.textbox).length,
        send: document.querySelectorAll(sel.composer.sendBtn).length,
        turns: document.querySelectorAll(sel.turn.containers).length,
        state: document.querySelector(sel.turn.state)?.getAttribute('data-talvt-turn-state'),
        assistants: document.querySelectorAll(sel.response.assistantUnits).length,
        markdown: document.querySelectorAll(sel.response.markdownRoot).length,
        model: document.querySelectorAll(sel.model.trigger).length,
      }), S);
      assert.equal(found.textbox, 1);
      assert.equal(found.send, 1);
      assert.equal(found.turns, 1);
      assert.equal(found.state, 'complete');
      assert.equal(found.assistants, 1);
      assert.equal(found.markdown, 1);
      assert.equal(found.model, 0);
    });

    await t.test('sampler reads completed turn and final text', async () => {
      await page.setContent(COMPLETE_FIXTURE);
      const controller = new PageController(page);
      controllers.push(controller);
      await controller.installObserver();
      const sample = await controller.sampleDom();
      assert.equal(sample.hasComposer, true);
      assert.equal(sample.turnCount, 1);
      assert.equal(sample.turnState, 'complete');
      assert.equal(sample.turnStateKnown, true);
      assert.equal(sample.turnInProgress, false);
      assert.equal(sample.assistantUnitCount, 1);
      assert.equal(sample.lastText, 'final answer');
      assert.equal(sample.copyActionInLastTurn, true);
    });

    await t.test('sampler detects in-progress generation', async () => {
      await page.setContent(RUNNING_FIXTURE);
      const controller = new PageController(page);
      controllers.push(controller);
      await controller.installObserver();
      const sample = await controller.sampleDom();
      assert.equal(sample.turnState, 'in_progress');
      assert.equal(sample.turnInProgress, true);
      assert.equal(sample.stopVisible, true);
      assert.equal(sample.sendReady, false);
    });

    await t.test('unknown turn state is never treated as complete', async () => {
      await page.setContent(`
        <div data-turn-key="u3"><div data-talvt-turn-state="paused">
          <div data-chatgpt-search-unit-key="t:1:assistant">
            <div data-markdown-text-style="assistant-message">maybe</div>
          </div>
        </div></div>`);
      const controller = new PageController(page);
      controllers.push(controller);
      await controller.installObserver();
      const sample = await controller.sampleDom();
      assert.equal(sample.turnState, 'paused');
      assert.equal(sample.turnStateKnown, false);
      assert.equal(sample.uiTurnComplete, false);
      assert.equal(sample.turnInProgress, true);
    });
  } finally {
    for (const controller of controllers) {
      await controller.uninstallObserver().catch(() => {});
    }
    await page.close();
    await browser.disconnect();
  }
});
