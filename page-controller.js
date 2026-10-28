/**
 * page-controller.js — 页面 DOM 操作层（唯一允许直接操作 page DOM 的模块）
 *
 * 约束（PR02，2026-10-28 实机证据）：
 *   - 选择器全部来自 selectors.js（真实页面采集）。
 *   - 定位不到控件 → 抛 DOM_CHANGED（带诊断信息），禁止：
 *       模糊按钮搜索、按 Enter 盲发、旧选择器回退。
 *   - 文本输入与发送使用 Puppeteer 输入事件（keyboard / click）。
 */

'use strict';

const S = require('./selectors');
const { extractConversationId } = require('./url-utils');

const DEFAULT_TIMEOUT = 15_000;

class DOM_CHANGED extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DOM_CHANGED';
    this.code = 'DOM_CHANGED';
    this.details = details;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 页面内 DOM 采样脚本（MutationObserver + 采样函数）。
 * 事件只携带轻量签名，完整文本由 Node 侧按需调用
 * window.__chatgptCliSampleDom() 获取。
 */
function installObserverScript(sel, throttleMs, tailLength) {
  const observerSignature = JSON.stringify({ version: 3, sel, throttleMs, tailLength });
  if (window.__chatgptCliObserverInstalled) {
    if (window.__chatgptCliObserverSignature !== observerSignature) {
      window.__chatgptCliObserverUninstall?.();
      window.__chatgptCliObserverInstalled = false;
    } else {
      let sample = null;
      try { sample = window.__chatgptCliSampleDom ? window.__chatgptCliSampleDom() : null; } catch {}
      return { status: 'already', sample };
    }
  }

  const normalizeText = (value) => String(value || '').replace(/\u200b/g, '').trim();
  const isVisible = (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      rect.width > 0 &&
      rect.height > 0
    );
  };
  const isSendReady = (el) => {
    if (!el) return false;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    return true;
  };

  const sample = (wantFull) => {
    const turns = Array.from(document.querySelectorAll(sel.turn.containers));
    const lastTurn = turns[turns.length - 1] || null;
    const lastStateEl = lastTurn && lastTurn.querySelector(sel.turn.state);
    const turnState = lastStateEl ? lastStateEl.getAttribute('data-talvt-turn-state') : null;
    // 未知状态值一律按「未完成」处理（已知值见 selectors.turn.knownStates）
    const turnKnown = sel.turn.knownStates.includes(turnState);
    const uiTurnComplete = turnState === 'complete';
    const assistantUnits = document.querySelectorAll(sel.response.assistantUnits);
    const lastAssistant = assistantUnits[assistantUnits.length - 1] || null;
    const markdownRoot = lastAssistant
      ? lastAssistant.querySelector(sel.response.markdownRoot) || lastAssistant
      : null;
    const userBubbles = document.querySelectorAll(sel.response.userBubbles);
    const lastText = normalizeText((markdownRoot && markdownRoot.innerText) || '');
    const stopVisible = isVisible(document.querySelector(sel.composer.stopBtn));
    const sendReady = isSendReady(document.querySelector(sel.composer.sendBtn));
    const copyActionInLastTurn = Boolean(
      lastTurn && lastTurn.querySelector(sel.response.turnActions)
    );

    const out = {
      url: location.href,
      turnCount: turns.length,
      turnState,
      turnStateKnown: turnKnown,
      uiTurnComplete,
      turnInProgress: turnState === 'in_progress' || (turnState && !uiTurnComplete),
      assistantUnitCount: assistantUnits.length,
      userBubbleCount: userBubbles.length,
      stopVisible,
      sendReady,
      copyActionInLastTurn,
      hasComposer: Boolean(document.querySelector(sel.composer.textbox) || document.querySelector(sel.composer.textboxLoose)),
      lastTextLength: lastText.length,
      lastTextTail: lastText.slice(-tailLength),
      sampledAt: Date.now(),
    };
    if (wantFull) {
      out.lastText = lastText.length <= 200_000 ? lastText : lastText.slice(-200_000);
    }
    return out;
  };

  window.__chatgptCliSampleDom = () => sample(true);

  let lastSig = '';
  let throttleTimer = null;
  const signatureOf = (s) =>
    [
      s.url, s.turnState, s.turnCount, s.assistantUnitCount, s.userBubbleCount,
      s.stopVisible ? 1 : 0, s.sendReady ? 1 : 0, s.copyActionInLastTurn ? 1 : 0,
      s.lastTextLength, s.lastTextTail,
    ].join('|');

  const notify = () => {
    if (typeof window.__chatgptCliDomEvent !== 'function') return;
    let s;
    try { s = sample(false); } catch { return; }
    const next = signatureOf(s);
    if (next === lastSig) return;
    lastSig = next;
    try { Promise.resolve(window.__chatgptCliDomEvent(s)).catch(() => {}); } catch {}
  };

  const observer = new MutationObserver(() => {
    if (throttleTimer !== null) return;
    throttleTimer = setTimeout(() => { throttleTimer = null; notify(); }, throttleMs);
  });

  try {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'data-testid', 'aria-label', 'aria-disabled', 'disabled', 'hidden', 'class', 'style',
        'data-talvt-turn-state', 'data-chatgpt-search-unit-key', 'data-user-message-bubble',
        'data-markdown-text-tone',
      ],
    });
  } catch {}

  window.__chatgptCliObserverUninstall = () => {
    try { observer.disconnect(); } catch {}
    if (throttleTimer !== null) { clearTimeout(throttleTimer); throttleTimer = null; }
    window.__chatgptCliObserverInstalled = false;
    delete window.__chatgptCliObserverSignature;
    delete window.__chatgptCliSampleDom;
    delete window.__chatgptCliObserverUninstall;
  };

  window.__chatgptCliObserverInstalled = true;
  window.__chatgptCliObserverSignature = observerSignature;
  notify();
  return { status: 'installed', sample: sample(true) };
}

class PageController {
  constructor(page) {
    this.page = page;
    this.observerThrottleMs = 150;
    this.tailLength = 160;
  }

  url() {
    try { return this.page.url(); } catch { return ''; }
  }

  async goto(url, { timeout = 30_000 } = {}) {
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  }

  async ensureChatLoaded(timeout = DEFAULT_TIMEOUT) {
    try {
      await this.page.waitForSelector(S.composer.textbox, { timeout: 8000 });
      return;
    } catch {}
    try {
      await this.page.waitForSelector(S.composer.textboxLoose, { timeout });
    } catch {
      throw new DOM_CHANGED('页面未出现消息输入框（未登录或页面结构变化？）', { url: this.url() });
    }
  }

  /** 打开已有对话页并等待加载。 */
  async gotoConversation(conversationId, projectPath = null) {
    if (extractConversationId(this.url()) === conversationId) {
      await this.ensureChatLoaded();
      return;
    }
    const base = projectPath
      ? `https://chatgpt.com${projectPath.replace(/\/project$/, '')}`
      : 'https://chatgpt.com';
    await this.goto(`${base}/c/${conversationId}`);
    await this.ensureChatLoaded();
  }

  async gotoProjectHome(projectPath) {
    await this.goto(`https://chatgpt.com${projectPath}`);
    await this.ensureChatLoaded();
  }

  // ── Composer ────────────────────────────────────────────────────────────────

  async _composerHandle(timeout = DEFAULT_TIMEOUT) {
    try {
      return await this.page.waitForSelector(S.composer.textbox, { timeout });
    } catch {
      try {
        return await this.page.waitForSelector(S.composer.textboxLoose, { timeout: 3000 });
      } catch {
        return null;
      }
    }
  }

  /**
   * 把文本写入 composer（替换已有内容），并回读校验。
   *
   * 实机结论（2026-10-28）：Puppeteer keyboard.type 在 ProseMirror 上会
   * 丢失 ASCII 数字（中文输入法上下文），不可用于消息输入；
   * document.execCommand('insertText') 单次写入保真（v1.2.2 生产路径）。
   * 写入后必须回读；不一致先尝试 Input.insertText 兜底，仍不一致则抛
   * DOM_CHANGED —— 绝不静默发送残缺消息。
   */
  async typeIntoComposer(text) {
    const el = await this._composerHandle();
    if (!el) throw new DOM_CHANGED('找不到消息输入框', { selector: S.composer.textbox });
    const value = String(text);

    await el.evaluate((node, v) => {
      node.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, v);
    }, value);
    await sleep(120);

    const readBack = async () => {
      try {
        return await el.evaluate((node) => String(node.innerText || '').trim());
      } catch {
        return '';
      }
    };

    let actual = await readBack();
    const expected = value.trim();
    if (actual !== expected) {
      // 兜底：整段 Input.insertText（IME 提交语义）
      await el.evaluate((node) => node.focus());
      await this.page.keyboard.sendCharacter(value);
      await sleep(120);
      actual = await readBack();
    }
    if (actual !== expected) {
      throw new DOM_CHANGED('输入内容校验失败（页面只接受了部分文本）', {
        expected: expected.slice(0, 120),
        actual: actual.slice(0, 120),
      });
    }
  }

  async clearComposer() {
    const el = await this._composerHandle(3000);
    if (!el) return;
    await el.evaluate((node) => {
      node.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    });
    await sleep(80);
  }

  /**
   * 点击发送按钮。按钮不存在或不可用 → DOM_CHANGED（不回退 Enter）。
   */
  async clickSend({ timeout = 5000 } = {}) {
    let el = null;
    try {
      el = await this.page.waitForSelector(S.composer.sendBtn, { timeout });
    } catch {}
    if (!el) {
      throw new DOM_CHANGED('发送按钮未出现（输入未生效或页面结构变化）', {
        selector: S.composer.sendBtn,
      });
    }
    const disabled = await el.evaluate((node) => {
      if (node.disabled || node.getAttribute('aria-disabled') === 'true') {
        return node.getAttribute('aria-label') || 'unknown';
      }
      return false;
    });
    if (disabled) {
      throw new DOM_CHANGED(`发送按钮不可用（aria-label=${disabled}）`, { selector: S.composer.sendBtn });
    }
    // 精确元素 DOM click：ElementHandle.click 会被页面叠加层阻塞而长时间挂起。
    await el.evaluate((node) => node.click());
  }

  // ── 观察器 / 采样 ───────────────────────────────────────────────────────────

  /**
   * page 级 DOM 事件桥（exposeFunction 每 page 只能注册一次）。
   */
  async ensureDomEventBridge() {
    if (this.page.__chatgptCliDomBridge) return this.page.__chatgptCliDomBridge;
    const bridge = { listeners: new Set(), exposed: false };
    try {
      await this.page.exposeFunction('__chatgptCliDomEvent', (payload) => {
        for (const listener of Array.from(bridge.listeners)) {
          try { listener(payload); } catch {}
        }
      });
      bridge.exposed = true;
    } catch {
      bridge.exposed = false;
    }
    this.page.__chatgptCliDomBridge = bridge;
    return bridge;
  }

  async installObserver() {
    const bridge = await this.ensureDomEventBridge();
    let result = null;
    try {
      result = await this.page.evaluate(
        installObserverScript,
        S,
        this.observerThrottleMs,
        this.tailLength
      );
    } catch {
      result = null;
    }
    return { bridge, result };
  }

  async sampleDom(wantFull = true) {
    try {
      return await this.page.evaluate(() => {
        if (typeof window.__chatgptCliSampleDom === 'function') {
          return window.__chatgptCliSampleDom();
        }
        return null;
      });
    } catch {
      // 观察器未安装时直接内联采样
      try {
        return await this.page.evaluate(installObserverScript, S, this.observerThrottleMs, this.tailLength);
      } catch {
        return null;
      }
    } finally {
      void wantFull;
    }
  }

  async uninstallObserver() {
    try {
      await this.page.evaluate(() => {
        if (typeof window.__chatgptCliObserverUninstall === 'function') {
          window.__chatgptCliObserverUninstall();
        }
      });
    } catch {}
  }

}

module.exports = { PageController, DOM_CHANGED };
