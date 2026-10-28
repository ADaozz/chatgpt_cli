#!/usr/bin/env node
/**
 * check-selectors.js — 实机诊断工具（只读）
 *
 * 检查当前页面是否仍匹配 selectors.js 的实机契约：
 *   - composer / send / turn / assistant / model trigger 的存在性与数量；
 *   - data-talvt-turn-state 是否在已知值域内；
 *   - 协议完成信号（WebProtocol.fetchConversation）与 DOM 状态是否一致；
 *   - 可选：临时展开模型菜单读取模型/强度档位（不切换、不输入、不发送）。
 *
 * 用法:
 *   node scripts/check-selectors.js [--browser-url URL] [--page-url URL] [--json]
 *   --inspect-menu          临时展开模型菜单并恢复
 *   --expect-effort LEVEL   验证触发器 data-selected-reasoning-effort（如 high）
 * 退出码: 0 无失效；1 失效/预期不符；2 无法运行。
 */

'use strict';

const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');
const S = require('../selectors');
const { WebProtocol } = require('../web-protocol');
const { parseConversationPayload } = require('../conversation-parser');
const { extractConversationId } = require('../url-utils');

function inspectPageDom(sel) {
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const count = (s) => document.querySelectorAll(s).length;
  const checks = [];
  const check = (name, selector, minVisible = 1) => {
    const els = [...document.querySelectorAll(selector)];
    const visibleCount = els.filter(visible).length;
    // minVisible=0 表示该控件「允许不存在」（如空输入框没有发送/停止按钮），
    // 不存在时应为 unverified 而不是 stale（skill 语义）。
    const status = els.length === 0
      ? (minVisible === 0 ? 'unverified' : 'stale')
      : (minVisible && visibleCount < minVisible) ? 'hidden' : 'ok';
    checks.push({ name, status, count: els.length, visibleCount });
  };

  check('composer.textbox', sel.composer.textbox);
  check('composer.send', sel.composer.sendBtn, 0);
  check('turn.containers', sel.turn.containers, 0);
  check('turn.state', sel.turn.state, 0);
  check('response.assistantUnits', sel.response.assistantUnits, 0);
  check('response.markdownRoot', sel.response.markdownRoot, 0);
  check('model.trigger', sel.model.trigger);

  const turns = [...document.querySelectorAll(sel.turn.containers)];
  const lastTurn = turns.at(-1);
  const stateEl = lastTurn?.querySelector(sel.turn.state);
  const turnState = stateEl ? stateEl.getAttribute('data-talvt-turn-state') : null;
  const stateKnown = turnState == null ? null : sel.turn.knownStates.includes(turnState);
  const assistantUnits = [...document.querySelectorAll(sel.response.assistantUnits)];
  const lastAssistant = assistantUnits.at(-1);
  const markdown = lastAssistant?.querySelector(sel.response.markdownRoot) || lastAssistant;
  const trigger = document.querySelector(sel.model.trigger);
  const url = location.href;

  return {
    url,
    readyState: document.readyState,
    conversation: /\/c\/[a-z0-9-]+/i.test(url),
    checks,
    completion: {
      turnCount: turns.length,
      turnState,
      turnStateKnown: stateKnown,
      uiTurnComplete: turnState === 'complete',
      turnInProgress: turnState != null && turnState !== 'complete',
      stopVisible: visible(document.querySelector(sel.composer.stopBtn)),
      textLength: (markdown?.innerText || '').trim().length,
    },
    model: {
      label: trigger ? trigger.innerText.replace(/\s+/g, ' ').trim() : null,
      reasoningEffort: trigger?.getAttribute('data-selected-reasoning-effort') || null,
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
      if (host && /microsoft/i.test(require('os').release())) return `http://${host}:${port}`;
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
      if (openedMenu) {
        await page.waitForFunction(
          () => Boolean(document.querySelector('[role="menuitemradio"]')),
          { timeout: 5000 }
        ).catch(() => {});
      }
    }

    const dom = await page.evaluate(inspectPageDom, S);
    checks.push(...dom.checks);

    if (dom.completion.turnState && dom.completion.turnStateKnown === false) {
      checks.push({
        name: 'turn.unknownStateValue',
        status: 'stale',
        detail: `未知 data-talvt-turn-state 值: ${dom.completion.turnState}`,
      });
    }

    if (options.expectEffort) {
      checks.push({
        name: 'model.reasoningEffort',
        status: dom.model.reasoningEffort === options.expectEffort
          ? 'ok'
          : dom.model.reasoningEffort ? 'stale' : 'unverified',
        detail: `expected=${options.expectEffort}, actual=${dom.model.reasoningEffort || 'unknown'}`,
      });
    }
    if (options.expectModel) {
      const label = (dom.model.label || '').toLowerCase();
      checks.push({
        name: 'model.label',
        status: label.includes(String(options.expectModel).toLowerCase()) ? 'ok' : 'stale',
        detail: `expected=${options.expectModel}, actual=${dom.model.label || 'unknown'}`,
      });
    }

    const report = {
      checkedAt: new Date().toISOString(),
      url: dom.url,
      checks,
      dom: dom.completion,
      model: dom.model,
      observer: dom.observer,
    };

    if (options.inspectMenu) {
      const menu = await page.evaluate((sel) => {
        const root = document.querySelector(sel.menu);
        if (!root) return null;
        const models = [...root.querySelectorAll(sel.optionModels)].map((el) => ({
          label: el.innerText.replace(/\s+/g, ' ').trim(),
          selected: el.getAttribute('data-model-selected') === 'true',
        }));
        const slider = root.querySelector(sel.effortSlider);
        return {
          models,
          effort: slider
            ? {
                position: Number(slider.getAttribute('aria-valuenow')),
                min: Number(slider.getAttribute('aria-valuemin') || 0),
                max: Number(slider.getAttribute('aria-valuemax') || 0),
              }
            : null,
        };
      }, S.model).catch(() => null);
      report.menu = menu;
      if (menu) {
        checks.push({ name: 'model.menu', status: menu.models.length ? 'ok' : 'stale',
          detail: `${menu.models.length} models` });
      }
    }

    if (dom.conversation) {
      const id = extractConversationId(dom.url);
      if (id) {
        try {
          const protocol = new WebProtocol(page);
          const { payload } = await protocol.fetchConversation(id, { numTurns: 4 });
          const snapshot = parseConversationPayload(payload, { conversationId: id });
          report.backend = {
            shape: snapshot.shape,
            partial: snapshot.partial,
            turnComplete: snapshot.completion ? snapshot.completion.turnComplete : null,
            asyncStatus: snapshot.asyncStatus,
          };
          const backendComplete = report.backend.turnComplete;
          checks.push({
            name: 'completion.backend',
            status: backendComplete == null ? 'unverified' : 'ok',
            detail: `turnComplete=${backendComplete}, async=${snapshot.asyncStatus}`,
          });
          checks.push({
            name: 'completion.consistency',
            status: backendComplete == null ? 'unverified'
              : (dom.completion.uiTurnComplete === backendComplete) ? 'ok' : 'stale',
            detail: `dom=${dom.completion.turnState}, backend=${backendComplete}`,
          });
        } catch (error) {
          checks.push({ name: 'completion.backend', status: 'error', detail: error.message });
        }
      }
    }

    report.status = checks.some((c) => c.status === 'stale' || c.status === 'error')
      ? 'failed'
      : checks.some((c) => c.status === 'unverified' || c.status === 'hidden') ? 'partial' : 'ok';
    return report;
  } finally {
    if (openedMenu) {
      await page.keyboard.press('Escape').catch(() => {});
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

function parseArgs(args) {
  const opts = {};
  const valued = { '--browser-url': 'browserURL', '--page-url': 'pageURL', '--expect-model': 'expectModel', '--expect-effort': 'expectEffort' };
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
    console.log(
      '用法: node scripts/check-selectors.js [--browser-url URL] [--page-url URL] [--json]\n' +
      '  --inspect-menu          临时展开模型菜单并恢复，不切换模型\n' +
      '  --expect-model LABEL    验证触发器显示的模型\n' +
      '  --expect-effort LEVEL   验证页面思考强度（如 high）\n' +
      '退出码: 0 无已确认失效（可能有未验证项），1 选择器失效/预期不符/检测错误，2 无法运行。'
    );
    return;
  }
  const browser = await puppeteer.connect({
    browserURL: resolveBrowserURL(opts.browserURL),
    defaultViewport: null,
    protocolTimeout: 20000,
  });
  try {
    const pages = (await browser.pages()).filter((p) => {
      try { return new URL(p.url()).hostname === 'chatgpt.com'; } catch { return false; }
    });
    const page = opts.pageURL
      ? pages.find((p) => p.url() === opts.pageURL)
      : pages.find((p) => /\/c\//.test(p.url())) || pages[0];
    if (!page) throw new Error('没有匹配的 ChatGPT 标签页；请打开目标页面后重试。');
    const report = await diagnosePage(page, opts);
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`页面: ${report.url}\n结果: ${report.status}`);
      for (const c of report.checks) {
        console.log(`[${c.status}] ${c.name}: ${c.detail || `匹配 ${c.count} 个，可见 ${c.visibleCount} 个`}`);
      }
      console.log(`模型: ${report.model.label || 'unknown'}；思考强度: ${report.model.reasoningEffort || 'unknown'}`);
      if (report.backend) console.log(`协议: shape=${report.backend.shape} turnComplete=${report.backend.turnComplete} async=${report.backend.asyncStatus}`);
      console.log('unverified 表示当前状态未出现该控件；不代表选择器正常或过时。');
    }
    process.exitCode = report.status === 'failed' ? 1 : 0;
  } finally {
    await browser.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: 'error', error: error.message }));
    process.exitCode = 2;
  });
}

module.exports = { inspectPageDom, diagnosePage, parseArgs, main, resolveBrowserURL };
