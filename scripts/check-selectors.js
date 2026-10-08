#!/usr/bin/env node
'use strict';

// 只连接现有 Chrome；不导航、不输入、不发送，不安装或卸载回复 Observer。
const { execFileSync } = require('node:child_process');
const puppeteer = require('puppeteer-core');
const S = require('../selectors');
const adapter = require('../adapter');
const { ResponseTracker } = require('../response-tracker');

function inspectPageDom(selectors) {
  const visible = (el) => Boolean(el && el.getClientRects().length &&
    getComputedStyle(el).visibility !== 'hidden');
  const checks = [];
  const check = (name, selector, alternative, expected = false) => {
    const elements = [...document.querySelectorAll(selector)];
    const alternatives = alternative ? [...document.querySelectorAll(alternative)] : [];
    const status = elements.length ? 'ok' : alternatives.length || expected ? 'stale' : 'unverified';
    checks.push({ name, status, selector, count: elements.length,
      visibleCount: elements.filter(visible).length, alternativeCount: alternatives.length });
  };
  const conversation = /\/c\//.test(location.pathname);
  check('composer.input', selectors.composer.textarea,
    'form[data-chatgpt-composer] [contenteditable="true"][role="textbox"], #prompt-textarea');
  check('composer.send', selectors.composer.sendBtn,
    'form[data-chatgpt-composer] button[type="submit"]');
  check('composer.stop', selectors.composer.stopBtn,
    'form[data-chatgpt-composer] button[aria-label="停止"], form[data-chatgpt-composer] button[aria-label="停止生成"], ' +
    'form[data-chatgpt-composer] button[aria-label="Stop"], form[data-chatgpt-composer] button[aria-label="Stop generating"]');
  check('response.messages', selectors.response.allMessages,
    '[data-user-message-bubble], [data-chatgpt-search-unit-key$=":assistant"]');
  check('response.assistant', selectors.response.assistantMsgs,
    '[data-chatgpt-search-unit-key$=":assistant"]');
  check('response.turns', selectors.response.assistantTurns, '[data-turn-key]');
  check('response.body', selectors.response.messageContent,
    '[data-markdown-text-style="assistant-message"]:not([data-markdown-text-tone="tertiary"])');
  check('turn.copy', selectors.turn.copyAction,
    '.turn-action-controls button[aria-label="复制"], .turn-action-controls button[aria-label="Copy"]');
  check('turn.state', selectors.turn.state, '[data-talvt-turn-state]');
  check('model.trigger', selectors.model.trigger, '[data-codex-intelligence-trigger]');
  check('model.options', selectors.model.options,
    '[role="menuitemradio"][data-model-selected]', false);
  const turns = [...document.querySelectorAll(selectors.response.assistantTurns)];
  const lastTurn = turns.at(-1);
  const assistants = [...document.querySelectorAll(selectors.response.assistantMsgs)];
  const lastAssistant = assistants.at(-1);
  const body = lastAssistant?.querySelector(selectors.response.messageContent) ||
    (lastAssistant?.matches('[data-message-author-role]') ? lastAssistant : null);
  const turnState = lastTurn?.querySelector(selectors.turn.state)?.getAttribute('data-talvt-turn-state') || null;
  const hasCopyAction = Boolean(lastTurn?.querySelector(selectors.turn.copyAction));
  const stopVisible = [...document.querySelectorAll(selectors.composer.stopBtn)].some(visible);
  const uiTurnComplete = hasCopyAction || turnState === 'complete';
  const selectedModel = document.querySelector('[data-model-selected="true"], [role="menuitemradio"][aria-checked="true"]');
  return {
    url: location.href, readyState: document.readyState, conversation, checks,
    completion: { stopVisible, hasCopyAction, turnState, uiTurnComplete,
      isResponding: stopVisible && !uiTurnComplete, textLength: body?.innerText.trim().length || 0 },
    model: {
      reasoningEffort: document.querySelector('[data-selected-reasoning-effort]')?.getAttribute('data-selected-reasoning-effort') || null,
      selectedLabel: selectedModel?.innerText.trim() || null,
      menuInspected: Boolean(selectedModel),
    },
    observer: {
      installed: Boolean(window.__chatgptCliObserverInstalled),
      signature: window.__chatgptCliObserverSignature || null,
    },
  };
}

function resolveBrowserURL(explicit) {
  if (explicit || process.env.CHATGPT_BROWSER_URL) return explicit || process.env.CHATGPT_BROWSER_URL;
  const port = process.env.CHATGPT_PORT || '9224';
  if (process.platform === 'linux') {
    try {
      const route = execFileSync('ip', ['route', 'show', 'default'], { encoding: 'utf8', timeout: 3000 });
      const host = route.match(/default via (\S+)/)?.[1];
      if (host && /microsoft/i.test(require('node:os').release())) return `http://${host}:${port}`;
    } catch {}
  }
  return `http://127.0.0.1:${port}`;
}

async function diagnosePage(page, options = {}) {
  let openedMenu = false;
  const checks = [];
  try {
    if (options.inspectMenu) {
      openedMenu = await page.evaluate((sel) => {
        const button = document.querySelector(sel);
        if (!button || button.getAttribute('aria-expanded') === 'true') return false;
        button.click();
        return true;
      }, S.model.trigger);
      if (openedMenu) await page.waitForFunction(() =>
        Boolean(document.querySelector('[role="menuitemradio"], [role="menuitem"], [role="option"]')),
      { timeout: 5000 }).catch(() => {});
    }
    const dom = await page.evaluate(inspectPageDom, S);
    checks.push(...dom.checks);
    const report = { checkedAt: new Date().toISOString(), url: dom.url, checks,
      dom: dom.completion, model: dom.model, observer: { installed: dom.observer.installed } };

    if (dom.observer.installed) {
      let cachedSelectors = null;
      try { cachedSelectors = JSON.parse(dom.observer.signature).sel; } catch {}
      const currentSelectors = new ResponseTracker(page).selectors;
      checks.push({ name: 'observer.cachedSelectors',
        status: JSON.stringify(cachedSelectors) === JSON.stringify(currentSelectors) ? 'ok' : 'stale',
        detail: '检查现有 Observer 是否仍缓存旧选择器；检测脚本不会替换 Observer。' });
    }

    try {
      const selection = await adapter.resolveModelSelection(page, 'best');
      report.model.autoSlug = selection.slug;
      report.model.autoTitle = selection.title;
      report.model.defaultSlug = selection.catalog.default_model_slug || null;
      report.model.available = (selection.catalog.models || []).map(m => ({ slug: m.slug, title: m.title }));
      checks.push({ name: 'model.catalog', status: 'ok', detail: selection.slug });
      const probes = [
        [['gpt-5-6-thinking', 'gpt-6-thinking'], 'gpt-6-thinking'],
        [['gpt-6-thinking', 'gpt-6-1-instant'], 'gpt-6-1-instant'],
        [['gpt-5-100-thinking', 'gpt-6-thinking'], 'gpt-6-thinking'],
      ];
      const valid = probes.every(([slugs, expected]) =>
        adapter.pickBestModelSlug({ models: slugs.map(slug => ({ slug })) }) === expected);
      checks.push({ name: 'model.versionOrder', status: valid ? 'ok' : 'stale',
        detail: '主版本优先；次版本缺省为 0；版本相同再比较模型类型。' });
      if (options.expectModel) checks.push({ name: 'model.expected',
        status: selection.slug === options.expectModel ? 'ok' : 'stale',
        detail: `expected=${options.expectModel}, actual=${selection.slug}` });
    } catch (error) {
      checks.push({ name: 'model.catalog', status: 'error', detail: error.message });
    }
    if (options.expectEffort) checks.push({ name: 'model.reasoningEffort',
      status: dom.model.reasoningEffort === options.expectEffort ? 'ok' : dom.model.reasoningEffort ? 'stale' : 'unverified',
      detail: `expected=${options.expectEffort}, actual=${dom.model.reasoningEffort || 'unknown'}` });
    if (dom.conversation) {
      try {
        const id = adapter.extractConversationId(dom.url);
        const snapshot = await adapter.getConversationSnapshot(page, id);
        const complete = adapter.isConversationTurnComplete(snapshot.completion);
        report.backend = { complete, completion: snapshot.completion,
          textLength: adapter.getLastAssistantFromSnapshot(snapshot).length };
        checks.push({ name: 'completion.backend', status: complete == null ? 'unverified' : 'ok',
          detail: `complete=${complete}` });
        checks.push({ name: 'completion.consistency',
          status: complete == null || (dom.completion.uiTurnComplete && complete === false) ||
            (dom.completion.isResponding && complete === true) ? 'unverified' : 'ok',
          detail: 'DOM 与后端不同步时需复测；后端仍生成时不能退出等待。' });
      } catch (error) {
        checks.push({ name: 'completion.backend', status: 'error', detail: error.message });
      }
    }
    report.status = checks.some(c => c.status === 'stale' || c.status === 'error') ? 'failed' :
      checks.some(c => c.status === 'unverified') ? 'partial' : 'ok';
    return report;
  } finally {
    if (openedMenu) await page.keyboard.press('Escape').catch(() => {});
  }
}

function parseArgs(args) {
  const opts = {};
  const valued = { '--browser-url': 'browserURL', '--page-url': 'pageURL',
    '--expect-model': 'expectModel', '--expect-effort': 'expectEffort' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (valued[arg]) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} 缺少参数`);
      opts[valued[arg]] = args[++i];
    } else if (arg === '--json') opts.json = true;
    else if (arg === '--inspect-menu') opts.inspectMenu = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return opts;
}

async function main(args = process.argv.slice(2)) {
  const opts = parseArgs(args);
  if (opts.help) {
    console.log('用法: node scripts/check-selectors.js [--browser-url URL] [--page-url URL] [--json]\n' +
      '  --inspect-menu          临时展开模型菜单并恢复，不切换模型\n' +
      '  --expect-model SLUG     验证 CLI 自动选中的模型\n' +
      '  --expect-effort LEVEL   验证页面思考强度（如 high）\n' +
      '退出码: 0 无已确认失效（可能有未验证项），1 选择器失效/预期不符/检测错误，2 无法运行。');
    return;
  }
  const browser = await puppeteer.connect({ browserURL: resolveBrowserURL(opts.browserURL),
    defaultViewport: null, protocolTimeout: 20000 });
  try {
    const pages = (await browser.pages()).filter(p => {
      try { return new URL(p.url()).hostname === 'chatgpt.com'; } catch { return false; }
    });
    const page = opts.pageURL ? pages.find(p => p.url() === opts.pageURL) :
      pages.find(p => /\/c\//.test(p.url())) || pages[0];
    if (!page) throw new Error('没有匹配的 ChatGPT 标签页；请打开目标页面后重试。');
    const report = await diagnosePage(page, opts);
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`页面: ${report.url}\n结果: ${report.status}`);
      for (const c of report.checks) console.log(`[${c.status}] ${c.name}: ${c.detail || `匹配 ${c.count} 个，可见 ${c.visibleCount} 个`}`);
      console.log(`自动模型: ${report.model.autoSlug || 'unknown'}；思考强度: ${report.model.reasoningEffort || 'unknown'}`);
      console.log('unverified 表示当前状态未出现该控件；不代表选择器正常或过时。');
    }
    process.exitCode = report.status === 'failed' ? 1 : 0;
  } finally { await browser.disconnect(); }
}

if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ status: 'error', error: error.message }));
  process.exitCode = 2;
});

module.exports = { inspectPageDom, diagnosePage, parseArgs, main };
