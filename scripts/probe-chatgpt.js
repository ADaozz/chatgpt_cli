#!/usr/bin/env node
'use strict';

/**
 * probe-chatgpt.js — PR01 只读探针脚本
 *
 * 用途：对当前已登录的 ChatGPT 页面做只读探测，输出 DOM / 模型菜单 / backend API
 * 的结构快照，用于维护 docs/contracts/chatgpt-web-contract.md 契约文档，
 * 并为 test/fixtures/ 下的脱敏 fixtures 重新采样。
 *
 * 安全边界（与 scripts/check-selectors.js 一致）：
 *   - 只附着现有 Chrome，不导航、不输入、不发送消息、不安装 Observer。
 *   - 默认对输出做脱敏（token / 邮箱 / 账号 ID / UUID / 长文本），
 *     仅在本机调试确有需要时使用 --no-sanitize。
 *   - --model-menu 会临时展开模型菜单并恢复，不切换模型、不修改思考强度。
 *   - --capture-request 为被动监听：由用户在浏览器里手动发送消息，
 *     脚本只观察经过 /backend-api/f/conversation 的请求，自身不触发发送。
 *
 * 用法:
 *   node scripts/probe-chatgpt.js [--dom] [--model-menu] [--api] [--capture-request]
 *        [--conversation ID] [--project GIZMO_ID] [--wait-ms N] [--no-sanitize]
 *        [--out FILE] [--browser-url URL] [--page-url URL] [--json]
 *
 * 退出码: 0 所有 section 正常（允许 empty）；1 section 内检测错误；2 无法运行。
 */

const fs = require('node:fs');
const puppeteer = require('puppeteer-core');
const { resolveBrowserURL } = require('./check-selectors');
const S = require('../selectors');

// ── 脱敏 ─────────────────────────────────────────────────────────────────────

const REDACTED = '<redacted>';

const SANITIZE_RULES = [
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, to: '<jwt-redacted>' },
  { name: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, to: '<email-redacted>' },
  { name: 'uuid', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, to: '<uuid-redacted>' },
  { name: 'account-id', re: /\b(?:user|org|g-p)-[A-Za-z0-9]{8,}\b/gi, to: (m) => m.slice(0, m.indexOf('-') + 1) + 'redacted' },
  { name: 'bearer', re: /Bearer\s+\S+/gi, to: 'Bearer <redacted>' },
];

const SENSITIVE_KEYS = /^(authorization|cookie|set-cookie|accesstoken|access_token|refresh_?token|id_?token|session_?token|token)$/i;
const MAX_STRING = 300;

function sanitize(value, depth = 0) {
  if (depth > 12) return '<deep>';
  if (typeof value === 'string') {
    let out = value;
    for (const rule of SANITIZE_RULES) {
      if (typeof rule.to === 'function') out = out.replace(rule.re, rule.to);
      else out = out.replace(rule.re, rule.to);
    }
    if (out.length > MAX_STRING) out = out.slice(0, MAX_STRING) + `…(truncated ${value.length})`;
    return out;
  }
  if (Array.isArray(value)) return value.slice(0, 40).map((v) => sanitize(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SENSITIVE_KEYS.test(key) ? REDACTED : sanitize(val, depth + 1);
    }
    return out;
  }
  return value;
}

// ── DOM 探针（只读）──────────────────────────────────────────────────────────

const COMPOSER_BUTTON_ARIA = [
  '添加文件等内容', '选择 ChatGPT 模型', '听写', '开始语音', '使用语音模式',
  'Add files and more', 'Choose ChatGPT model', 'Dictate', 'Start voice',
];

async function probeDom(page) {
  return page.evaluate((buttonAria, S) => {
    const attrs = (el) => {
      if (!el) return null;
      return {
        tag: el.tagName?.toLowerCase() || null,
        id: el.id || null,
        testid: el.getAttribute('data-testid'),
        role: el.getAttribute('role'),
        ariaLabel: el.getAttribute('aria-label'),
        contenteditable: el.getAttribute('contenteditable'),
        cls: typeof el.className === 'string' ? el.className.slice(0, 120) : null,
        disabled: el.hasAttribute('disabled') ? true : null,
        ariaDisabled: el.getAttribute('aria-disabled'),
      };
    };
    // v2：composer 选择器唯一来源 selectors.js（实机采集）
    const composer = document.querySelector(S.composer.textbox)
      || document.querySelector(S.composer.textboxLoose);
    const form = composer?.closest('form') || document.querySelector('form[data-chatgpt-composer]');
    const buttons = [...(form?.querySelectorAll('button') || [])]
      .map(attrs)
      .filter((b) => b && (b.ariaLabel || '').length > 0)
      .filter((b) => buttonAria.some((aria) => (b.ariaLabel || '').includes(aria)));
    const testids = [...document.querySelectorAll('[data-testid]')]
      .map((el) => el.getAttribute('data-testid')).filter(Boolean).slice(0, 30);

    // Turn / 回复结构
    const turns = [...document.querySelectorAll('[data-turn-key]')];
    const lastTurn = turns.at(-1) || null;
    const turnState = lastTurn?.querySelector('[data-talvt-turn-state]')?.getAttribute('data-talvt-turn-state') || null;
    const roles = lastTurn
      ? [...lastTurn.querySelectorAll('[data-conversation-role]')].map((el) => el.getAttribute('data-conversation-role'))
      : [];
    const searchUnits = lastTurn
      ? [...lastTurn.querySelectorAll('[data-chatgpt-search-unit-key]')].map((el) => ({
          unitKey: el.getAttribute('data-chatgpt-search-unit-key'),
          messageIds: (el.getAttribute('data-chatgpt-search-message-ids') || '').split(' ').filter(Boolean).length,
        }))
      : [];
    const actionBarLabels = lastTurn
      ? [...lastTurn.querySelectorAll('button[aria-label]')].map((el) => el.getAttribute('aria-label')).slice(0, 12)
      : [];

    // 最后一条 assistant 内容容器
    const assistants = [...document.querySelectorAll(S.response.assistantUnits)];
    const lastAssistant = assistants.at(-1) || null;
    const markdown = lastAssistant?.querySelector(S.response.markdownRoot) || null;
    return {
      status: 'ok',
      composer: attrs(composer),
      composerHasForm: Boolean(form),
      formAttrs: form ? { testid: form.getAttribute('data-testid'), cls: (form.className || '').slice(0, 80) } : null,
      composerButtons: buttons,
      pageTestids: testids,
      turn: {
        turnCount: turns.length,
        lastTurnKey: lastTurn?.getAttribute('data-turn-key') || null,
        turnState,
        conversationRoles: roles,
        searchUnits,
        actionBarLabels,
      },
      assistantContent: markdown ? {
        tag: markdown.tagName?.toLowerCase(),
        markdownStyle: markdown.getAttribute('data-markdown-text-style'),
        markdownTone: markdown.getAttribute('data-markdown-text-tone'),
        textLength: (markdown.innerText || '').trim().length,
        textPreview: (markdown.innerText || '').trim().slice(0, 80),
      } : { present: false },
    };
  }, COMPOSER_BUTTON_ARIA, S);
}

// ── 模型菜单探针（临时展开并恢复）────────────────────────────────────────────

async function probeModelMenu(page) {
  const opened = await page.evaluate(() => {
    const trigger = document.querySelector(
      '[data-testid="model-switcher-dropdown-button"], [data-testid="model-switcher-popover-button"], ' +
      '[data-codex-intelligence-trigger]'
    );
    if (!trigger) return { opened: false, reason: 'trigger 不存在' };
    const before = {
      expanded: trigger.getAttribute('aria-expanded'),
      effort: trigger.getAttribute('data-selected-reasoning-effort'),
      label: (trigger.innerText || '').replace(/\n/g, '|').slice(0, 60),
    };
    trigger.click();
    return { opened: true, before };
  });
  if (!opened.opened) return { status: 'empty', ...opened };

  await new Promise((r) => setTimeout(r, 600));
  const menu = await page.evaluate(() => {
    const container = document.querySelector(
      '[data-radix-popper-content-wrapper] [role="menu"], [role="menu"][data-radix-menu-content]'
    );
    if (!container) return { found: false };
    const pick = (el) => ({
      role: el.getAttribute('role'),
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      ariaChecked: el.getAttribute('aria-checked'),
      ariaNow: el.getAttribute('aria-valuenow'),
      ariaMin: el.getAttribute('aria-valuemin'),
      ariaMax: el.getAttribute('aria-valuemax'),
      dataModel: el.getAttribute('data-model'),
      selected: el.getAttribute('data-model-selected'),
      dataAttrs: [...el.attributes].map((a) => `${a.name}=${a.value}`)
        .filter((a) => a.startsWith('data-model') || a.startsWith('data-reasoning') || a === 'data-interactive=true')
        .slice(0, 6),
    });
    const items = [...container.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="slider"], [role="status"]')].map(pick);
    const views = [...container.querySelectorAll('[data-model-picker-view]')]
      .map((el) => el.getAttribute('data-model-picker-view'));
    return {
      found: true,
      containerAttrs: [...container.attributes].map((a) => `${a.name}=${a.value}`).filter((a) => a.startsWith('data-')).slice(0, 8),
      views: [...new Set(views)],
      items,
    };
  });

  // 恢复：Escape 关闭菜单，并确认 trigger 状态未变
  await page.keyboard.press('Escape').catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  const restored = await page.evaluate((before) => {
    const trigger = document.querySelector('[data-codex-intelligence-trigger], [data-testid="model-switcher-dropdown-button"]');
    const menuGone = !document.querySelector('[data-radix-popper-content-wrapper] [role="menu"][data-state="open"]');
    const after = {
      expanded: trigger?.getAttribute('aria-expanded') ?? null,
      effort: trigger?.getAttribute('data-selected-reasoning-effort') ?? null,
    };
    return { menuGone, before, after, unchanged: before.effort === after.effort };
  }, opened.before);

  return {
    status: menu.found ? 'ok' : 'error',
    triggerBefore: opened.before,
    menu: menu.found ? menu : '菜单未出现（可能已在首页或选择器失效）',
    restored,
  };
}

// ── Backend API 探针（只读 GET）──────────────────────────────────────────────

async function probeApi(page, options) {
  return page.evaluate(async (opts) => {
    const sessionResp = await fetch('/api/auth/session');
    const session = await sessionResp.json().catch(() => ({}));
    const H = { Authorization: `Bearer ${session.accessToken || ''}` };
    const shape = async (url, headers) => {
      try {
        const resp = await fetch(url, { headers });
        let json = null;
        try { json = await resp.json(); } catch {}
        return {
          url: url.split('?')[0], status: resp.status,
          topKeys: json && typeof json === 'object' ? Object.keys(json).slice(0, 40) : null,
          detail: json?.detail?.message || json?.detail || undefined,
        };
      } catch (error) {
        return { url: url.split('?')[0], status: 'fetch-error', detail: String(error && error.message) };
      }
    };

    const out = {};
    out.session = {
      status: sessionResp.status,
      keys: Object.keys(session).slice(0, 20),
      hasAccessToken: Boolean(session.accessToken),
      expires: typeof session.expires,
    };
    out.conversationsList = await shape('/backend-api/conversations?offset=0&limit=3&order=updated', H);

    if (opts.conversationId) {
      // 新版复数端点：线性化 messages[] + page_info（2026-10-28 已验证）
      const plural = await shape(
        `/backend-api/conversations/${opts.conversationId}?num_turns=10&include_has_versions=true`, H);
      // 旧版单数端点：mapping 树
      const singular = await shape(`/backend-api/conversation/${opts.conversationId}`, H);
      out.conversation = { plural, singular };
      try {
        const resp = await fetch(`/backend-api/conversations/${opts.conversationId}?num_turns=10`, { headers: H });
        const json = await resp.json();
        out.conversation.pluralShape = {
          hasMapping: json.mapping != null,
          messagesCount: Array.isArray(json.messages) ? json.messages.length : null,
          pageInfo: json.page_info || null,
          asyncStatus: json.async_status !== undefined ? json.async_status : '<absent>',
          defaultModelSlug: json.default_model_slug || null,
          currentNode: json.current_node || null,
          lastMessage: Array.isArray(json.messages) ? (() => {
            const m = json.messages.filter((x) => x.author?.role === 'assistant').at(-1);
            return m ? {
              role: m.author.role, channel: m.channel, status: m.status, endTurn: m.end_turn,
              contentType: m.content?.content_type,
              modelSlug: m.metadata?.model_slug, effort: m.metadata?.thinking_effort,
              reasoningStatus: m.metadata?.reasoning_status || undefined,
              finishType: m.metadata?.finish_details?.type || undefined,
              isComplete: m.metadata?.is_complete || undefined,
            } : null;
          })() : null,
        };
      } catch (error) {
        out.conversation.pluralShape = { error: String(error && error.message) };
      }
    }

    if (opts.projectId) {
      const gizmo = await shape(`/backend-api/gizmos/${opts.projectId}?include_file_limits=true`, H);
      out.gizmo = gizmo;
      try {
        const resp = await fetch(`/backend-api/gizmos/${opts.projectId}?include_file_limits=true`, { headers: H });
        const json = await resp.json();
        out.gizmo.files = Array.isArray(json.files)
          ? json.files.map((f) => ({ name: f.name, size: f.size, mimeType: f.mimeType || f.type || null }))
          : null;
        out.gizmo.gizmoKeys = json.gizmo ? Object.keys(json.gizmo).slice(0, 30) : null;
      } catch {}
    }
    return { status: 'ok', ...out };
  }, {
    conversationId: options.conversationId || null,
    projectId: options.projectId || null,
  });
}

// ── 发送请求被动捕获 ─────────────────────────────────────────────────────────

async function captureSendRequest(page, waitMs) {
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(null, '等待超时：期间没有捕获到 f/conversation 请求'), waitMs);
    let done = false;
    function finish(result, note) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cdp.detach().catch(() => {});
      resolve(result
        ? { status: 'ok', capturedAt: new Date().toISOString(), ...result }
        : { status: 'empty', note });
    }
    cdp.on('Network.requestWillBeSent', (event) => {
      const { request } = event;
      if (!request || !request.url.includes('/backend-api/f/conversation') || request.method !== 'POST') return;
      let body = null;
      try { body = JSON.parse(request.postData || 'null'); } catch {}
      finish({
        requestTemplate: {
          method: request.method,
          url: request.url,
          mimeType: 'text/event-stream (SSE 响应)',
          headers: Object.fromEntries(Object.entries(request.headers || {}).filter(([k]) =>
            !/^(cookie|authorization|token)$/i.test(k))),
          body,
        },
      });
    });
  });
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

function parseArgs(args) {
  const opts = { sections: [], waitMs: 30000, sanitize: true };
  const valued = { '--browser-url': 'browserURL', '--page-url': 'pageURL', '--conversation': 'conversationId',
    '--project': 'projectId', '--out': 'out', '--wait-ms': 'waitMs' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (valued[arg]) {
      if (!args[i + 1] || args[i + 1].startsWith('--') && valued[arg] !== 'out') throw new Error(`${arg} 缺少参数`);
      if (arg === '--wait-ms') opts.waitMs = Number(args[++i]) || opts.waitMs;
      else opts[valued[arg]] = args[++i];
    } else if (arg === '--dom') opts.sections.push('dom');
    else if (arg === '--model-menu') opts.sections.push('modelMenu');
    else if (arg === '--api') opts.sections.push('api');
    else if (arg === '--capture-request') opts.sections.push('captureRequest');
    else if (arg === '--no-sanitize') opts.sanitize = false;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!opts.sections.length) opts.sections = ['dom', 'api'];
  return opts;
}

async function main(args = process.argv.slice(2)) {
  const opts = parseArgs(args);
  if (opts.help) {
    console.log(
      '用法: node scripts/probe-chatgpt.js [--dom] [--model-menu] [--api] [--capture-request]\n' +
      '      [--conversation ID] [--project GIZMO_ID] [--wait-ms N] [--no-sanitize] [--out FILE]\n' +
      '      [--browser-url URL] [--page-url URL] [--json]\n\n' +
      'section（缺省 = --dom --api）:\n' +
      '  --dom              只读探测 composer / turn / assistant 内容结构\n' +
      '  --model-menu       临时展开模型菜单并恢复，不切换模型\n' +
      '  --api              只读 GET：auth session / conversations 列表；\n' +
      '                     配合 --conversation 对比新旧会话端点；配合 --project 读 gizmo 配置\n' +
      '  --capture-request  被动监听 f/conversation 请求（需用户在浏览器中手动发送一条消息）\n\n' +
      '退出码: 0 正常（允许 empty），1 section 检测错误，2 无法运行。\n' +
      '默认脱敏：token/邮箱/账号ID/UUID/长文本；--no-sanitize 仅限本机调试。');
    return;
  }

  const browser = await puppeteer.connect({ browserURL: resolveBrowserURL(opts.browserURL),
    defaultViewport: null, protocolTimeout: 20000 });
  try {
    const pages = (await browser.pages()).filter((p) => {
      try { return new URL(p.url()).hostname === 'chatgpt.com'; } catch { return false; }
    });
    const page = opts.pageURL ? pages.find((p) => p.url() === opts.pageURL)
      : pages.find((p) => /\/c\//.test(p.url())) || pages[0];
    if (!page) throw new Error('没有匹配的 ChatGPT 标签页；请打开目标页面后重试。');

    const report = { probedAt: new Date().toISOString(), url: page.url(), sanitized: opts.sanitize, sections: {} };
    for (const section of opts.sections) {
      let result;
      if (section === 'dom') result = await probeDom(page);
      else if (section === 'modelMenu') result = await probeModelMenu(page);
      else if (section === 'api') result = await probeApi(page, opts);
      else if (section === 'captureRequest') result = await captureSendRequest(page, opts.waitMs);
      report.sections[section] = opts.sanitize ? sanitize(result) : result;
    }

    const failed = Object.values(report.sections).some((s) => s && s.status === 'error');
    if (opts.out) {
      fs.writeFileSync(opts.out, JSON.stringify(report, null, 2) + '\n');
      console.log(`探针报告已写入 ${opts.out}`);
    } else {
      console.log(JSON.stringify(report, null, 2));
    }
    process.exitCode = failed ? 1 : 0;
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

module.exports = { parseArgs, sanitize, SANITIZE_RULES, main };
