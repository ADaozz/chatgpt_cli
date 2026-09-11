/**
 * response-tracker.js — 事件驱动的回复完成跟踪器
 *
 * 设计目标（替代旧的 2s 轮询 × 5 轮稳定判定）：
 *   - 主路径：页面内 MutationObserver → exposeFunction → Node 事件，
 *     低成本实时采集 assistant 文本 / stop 按钮 / 消息计数变化；
 *   - 完成判定：基于时间的 debounce（quiet window），而不是固定轮次；
 *   - 兜底：backend snapshot（/backend-api/conversation/{id}）只在
 *     「确认完成」「DOM 空文本」「DOM 事件长时间静默」「超时」时调用，
 *     不做高频轮询；
 *   - 状态机：IDLE → RESPONDING → CANDIDATE_COMPLETE → COMPLETE。
 *
 * Thinking 模型兼容（继承旧 _waitForReply 的经验）：
 *   1. assistant 新消息出现但内容暂时为空 → 不判完成，限速查 backend；
 *   2. stop 按钮短暂消失后重新出现 → quiet window 内重新进入 RESPONDING
 *      即撤销 CANDIDATE_COMPLETE；长响应（>20s）自动放大 quiet window；
 *   3. DOM 没拿到最终文本但 backend 有 → backend-fallback 完成；
 *   4. backend 暂时 5xx → 记录 streak，DOM 主路径继续；持续失败且 DOM
 *      空文本 → 返回 unknown，不无限等待；
 *   5. conversationId 获取较慢 → 从每次采样的 URL 持续尝试提取；
 *   6. 极快模型从未被观察到 responding → sawNewAssistant / 文本变化
 *      同样构成完成证据。
 *
 * 架构约束：
 *   - 不依赖 renderer / theme / cli（业务执行层）
 *   - 不发送消息、不管理项目、不选择模型
 *   - backend 能力通过 options.backend 注入（避免与 adapter 循环依赖）
 */

'use strict';

const S = require('./selectors');

const DEFAULT_TIMEOUT = 600_000;
const DEFAULT_QUIET_WINDOW_MS = 600;
const LONG_RESPONSE_QUIET_WINDOW_MS = 2_500; // thinking 长任务更保守
const LONG_RESPONSE_THRESHOLD_MS = 20_000;
const DEFAULT_WATCHDOG_INTERVAL_MS = 2_000;
const DEFAULT_DOM_EVENT_GAP_MS = 4_000;
const DEFAULT_EMPTY_TEXT_BACKEND_CHECK_MS = 3_000;
const DEFAULT_MAX_SNAPSHOT_ERROR_STREAK = 8;
const DEFAULT_TAIL_LENGTH = 400;
const DEFAULT_OBSERVER_THROTTLE_MS = 120;

const STATES = {
  IDLE: 'IDLE',
  RESPONDING: 'RESPONDING',
  CANDIDATE_COMPLETE: 'CANDIDATE_COMPLETE',
  COMPLETE: 'COMPLETE',
};

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function extractConversationIdSafe(url) {
  const match = String(url || '').match(/\/c\/([a-z0-9-]+)/i);
  return match ? match[1] : null;
}

/**
 * browser 侧：安装 MutationObserver + 采样函数。
 * 事件通知只携带轻量签名（textLength + tail），完整文本由 Node 侧
 * 按需调用 window.__chatgptCliSampleDom() 获取。
 */
function installObserverScript(sel, throttleMs, tailLength) {
  if (window.__chatgptCliObserverInstalled) {
    let sample = null;
    try {
      sample = window.__chatgptCliSampleDom ? window.__chatgptCliSampleDom() : null;
    } catch {}
    return { status: 'already', sample };
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

  const sample = (wantFull) => {
    const all = document.querySelectorAll(sel.allMessages);
    const assistants = document.querySelectorAll(sel.assistant);
    const lastMessage = all[all.length - 1] || null;
    const lastAssistant = assistants[assistants.length - 1] || null;
    const markdown =
      (lastAssistant && lastAssistant.querySelector(sel.markdown)) || lastAssistant;
    const text = normalizeText(
      (markdown && markdown.innerText) || (lastAssistant && lastAssistant.innerText) || ''
    );
    const out = {
      url: location.href,
      isResponding: isVisible(document.querySelector(sel.stop)),
      messageCount: all.length,
      assistantMessageCount: assistants.length,
      lastMessageRole: lastMessage
        ? lastMessage.getAttribute('data-message-author-role')
        : null,
      textLength: text.length,
      textTail: text.slice(-tailLength),
      sampledAt: Date.now(),
    };
    if (wantFull) {
      out.text = text.length <= 200_000 ? text : text.slice(-200_000);
    }
    return out;
  };

  window.__chatgptCliSampleDom = () => sample(true);

  let lastSig = '';
  let throttleTimer = null;
  const signatureOf = (s) =>
    [
      s.url,
      s.isResponding ? 1 : 0,
      s.assistantMessageCount,
      s.messageCount,
      s.textLength,
      s.textTail,
      s.lastMessageRole,
    ].join('|');

  const notify = () => {
    if (typeof window.__chatgptCliDomEvent !== 'function') return;
    let s;
    try {
      s = sample(false);
    } catch {
      return;
    }
    const next = signatureOf(s);
    if (next === lastSig) return;
    lastSig = next;
    try {
      Promise.resolve(window.__chatgptCliDomEvent(s)).catch(() => {});
    } catch {}
  };

  const observer = new MutationObserver(() => {
    if (throttleTimer !== null) return;
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      notify();
    }, throttleMs);
  });

  try {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-testid', 'aria-disabled', 'style'],
    });
  } catch {}

  window.__chatgptCliObserverUninstall = () => {
    try {
      observer.disconnect();
    } catch {}
    if (throttleTimer !== null) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    window.__chatgptCliObserverInstalled = false;
    delete window.__chatgptCliSampleDom;
    delete window.__chatgptCliObserverUninstall;
  };

  window.__chatgptCliObserverInstalled = true;
  notify();
  return { status: 'installed', sample: sample(true) };
}

/**
 * page 级 browser→Node 事件桥。exposeFunction 每个 page 只允许注册一次，
 * 用 dispatcher + listener 集合支持同一 page 上的多个顺序 tracker。
 */
async function ensureDomEventBridge(page) {
  if (page.__chatgptCliDomBridge) return page.__chatgptCliDomBridge;
  const bridge = { listeners: new Set(), exposed: false };
  try {
    await page.exposeFunction('__chatgptCliDomEvent', (payload) => {
      for (const listener of Array.from(bridge.listeners)) {
        try {
          listener(payload);
        } catch {}
      }
    });
    bridge.exposed = true;
  } catch {
    // exposeFunction 失败（已注册/页面异常）→ tracker 自动降级为轮询模式
    bridge.exposed = false;
  }
  page.__chatgptCliDomBridge = bridge;
  return bridge;
}

class ResponseTracker {
  /**
   * @param {import('puppeteer-core').Page} page
   * @param {object} options
   * @param {number|null} options.previousAssistantCount 发送前的 assistant 消息数
   * @param {number} [options.timeout]              总超时（ms）
   * @param {number} [options.quietWindowMs]        完成 debounce 窗口
   * @param {boolean} [options.requireNewActivity]  是否要求观察到新活动（send=true, status --wait=false）
   * @param {string|null} [options.conversationId]  已知对话 ID
   * @param {{ getSnapshot: Function, getLastAssistantText: Function }} [options.backend]
   * @param {Function} [options.onState]            UI 状态回调（renderer 层由调用方接线）
   */
  constructor(page, options = {}) {
    this.page = page;
    this.previousAssistantCount =
      options.previousAssistantCount != null ? options.previousAssistantCount : null;
    this.timeoutMs = options.timeout ?? envNumber('CHATGPT_REPLY_TIMEOUT_MS', DEFAULT_TIMEOUT);
    this.quietWindowMs =
      options.quietWindowMs ?? envNumber('CHATGPT_QUIET_WINDOW_MS', DEFAULT_QUIET_WINDOW_MS);
    this.watchdogIntervalMs = options.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;
    this.domEventGapMs = options.domEventGapMs ?? DEFAULT_DOM_EVENT_GAP_MS;
    this.emptyTextBackendCheckMs =
      options.emptyTextBackendCheckMs ?? DEFAULT_EMPTY_TEXT_BACKEND_CHECK_MS;
    this.maxSnapshotErrorStreak =
      options.maxSnapshotErrorStreak ?? DEFAULT_MAX_SNAPSHOT_ERROR_STREAK;
    this.requireNewActivity = options.requireNewActivity !== false;
    this.backend = options.backend || null;
    this.conversationId = options.conversationId || null;
    this.onState = typeof options.onState === 'function' ? options.onState : null;
    this.selectors = options.selectors || {
      stop: S.composer.stopBtn,
      allMessages: S.response.allMessages,
      assistant: S.response.assistantMsgs,
      markdown: S.response.messageContent,
    };
    this.tailLength = DEFAULT_TAIL_LENGTH;
    this.observerThrottleMs = DEFAULT_OBSERVER_THROTTLE_MS;

    // ── 运行状态 ──
    this.state = STATES.IDLE;
    this.observerActive = false;
    this.sawResponding = false;
    this.respondingStartedAt = null;
    this.lastRespondingTrueAt = 0;
    this.sawNewAssistant = false;
    this.textChangedFromBaseline = false;
    this.lastText = '';
    this.lastSample = null;
    this.baselineTextSig = null;
    this.baselineAssistantCount = null;
    this._currentTextSig = null;
    this._currentChangeSig = null;
    this.startedAt = 0;
    this.deadline = 0;
    this.lastChangeAt = 0;
    this.lastEventAt = 0;
    this.lastEmptyBackendCheckAt = 0;
    this.lastWatchdogBackendAt = 0;
    this._lastWatchdogBackendText = null;
    this.snapshotErrorStreak = 0;
    this.lastSnapshotError = null;
    this._snapshotCounts = null;

    this._result = null;
    this._confirming = false;
    this._emptyCheckRunning = false;
    this._watchdog = null;
    this._quietTimer = null;
    this._bridge = null;
    this._bridgeListener = null;

    this._promise = new Promise((resolve) => {
      this._resolve = resolve;
    });
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────────

  async start() {
    this.startedAt = Date.now();
    this.deadline = this.startedAt + this.timeoutMs;
    this.lastChangeAt = this.startedAt;
    this.lastEventAt = this.startedAt;

    try {
      this._bridge = await ensureDomEventBridge(this.page);
      this._bridgeListener = (payload) => this._onDomEvent(payload);
      this._bridge.listeners.add(this._bridgeListener);
    } catch {
      this._bridge = null;
    }

    const install = await this._installObserver();
    let baseline = install && install.sample ? install.sample : null;
    if (!baseline) baseline = await this._directSample();
    if (baseline) {
      this._applySample(baseline, { initial: true });
      this.baselineTextSig = this._currentTextSig;
      if (this.previousAssistantCount == null) {
        this.baselineAssistantCount = baseline.assistantMessageCount;
      }
      // 发送与 start 之间回复已经出现（极快回答）也算新活动
      if (
        this.previousAssistantCount != null &&
        baseline.assistantMessageCount > this.previousAssistantCount
      ) {
        this.sawNewAssistant = true;
      }
    }

    this._watchdog = setInterval(() => {
      this._watchdogTick().catch(() => {});
    }, this.watchdogIntervalMs);
    if (typeof this._watchdog.unref === 'function') this._watchdog.unref();

    this._evaluate();
  }

  waitForComplete() {
    return this._promise;
  }

  async stop() {
    if (this._watchdog) {
      clearInterval(this._watchdog);
      this._watchdog = null;
    }
    if (this._quietTimer) {
      clearTimeout(this._quietTimer);
      this._quietTimer = null;
    }
    if (this._bridge && this._bridgeListener) {
      this._bridge.listeners.delete(this._bridgeListener);
      this._bridgeListener = null;
    }
    try {
      await this.page.evaluate(() => {
        if (typeof window.__chatgptCliObserverUninstall === 'function') {
          window.__chatgptCliObserverUninstall();
        }
      });
    } catch {}
  }

  // ── 采样 ────────────────────────────────────────────────────────────────────

  async _installObserver() {
    try {
      const result = await this.page.evaluate(
        installObserverScript,
        this.selectors,
        this.observerThrottleMs,
        this.tailLength
      );
      if (result && result.status) {
        this.observerActive = Boolean(this._bridge && this._bridge.exposed);
      }
      return result;
    } catch {
      return null;
    }
  }

  async _directSample() {
    try {
      return await this.page.evaluate(() => {
        if (typeof window.__chatgptCliSampleDom === 'function') {
          try {
            return window.__chatgptCliSampleDom();
          } catch {
            return null;
          }
        }
        return null;
      });
    } catch {
      return null;
    }
  }

  _onDomEvent(payload) {
    if (this._result || !payload) return;
    this._applySample(payload, { viaEvent: true });
    this._evaluate();
  }

  _applySample(sample, { viaEvent = false, initial = false } = {}) {
    if (!sample || this._result) return;
    this.lastSample = sample;
    if (viaEvent) this.lastEventAt = Date.now();
    if (!this.conversationId && sample.url) {
      this.conversationId = extractConversationIdSafe(sample.url);
    }

    if (sample.isResponding && !this.sawResponding) {
      this.sawResponding = true;
      this.respondingStartedAt = Date.now();
      this._emit({ type: 'responding' });
    }
    if (sample.isResponding) {
      this.state = STATES.RESPONDING;
      // 记录最后一次观察到 responding 的时刻，作为 quiet 判定锚点之一
      this.lastRespondingTrueAt = Date.now();
    }

    const countBase =
      this.previousAssistantCount != null
        ? this.previousAssistantCount
        : this.baselineAssistantCount;
    if (countBase != null && sample.assistantMessageCount > countBase) {
      this.sawNewAssistant = true;
    }

    const textSig = `${sample.textLength}|${sample.textTail}`;
    const changeSig = `${sample.assistantMessageCount}|${sample.lastMessageRole}|${textSig}`;

    if (typeof sample.text === 'string') {
      this.lastText = sample.text;
    } else if (
      typeof sample.textTail === 'string' &&
      sample.textLength <= this.tailLength
    ) {
      // 短文本时 tail 即全文
      this.lastText = sample.textTail;
    }

    if (initial) {
      this._currentTextSig = textSig;
      this._currentChangeSig = changeSig;
      return;
    }

    let changed = false;
    if (textSig !== this._currentTextSig) {
      this._currentTextSig = textSig;
      if (this.baselineTextSig != null && textSig !== this.baselineTextSig) {
        this.textChangedFromBaseline = true;
      }
      changed = true;
      this._emit({
        type: 'generating',
        textLength: sample.textLength,
        elapsedMs: Date.now() - this.startedAt,
      });
    }
    if (changeSig !== this._currentChangeSig) {
      this._currentChangeSig = changeSig;
      changed = true;
    }
    if (changed) {
      this.lastChangeAt = Date.now();
    }
  }

  // ── 状态机 ──────────────────────────────────────────────────────────────────

  _hasEvidence() {
    return (
      !this.requireNewActivity ||
      this.sawResponding ||
      this.sawNewAssistant ||
      this.textChangedFromBaseline
    );
  }

  _effectiveQuietWindow() {
    // thinking 长任务：stop 按钮中途短暂消失的概率更高，放大 debounce 窗口
    if (this.sawResponding && this.respondingStartedAt) {
      const elapsed = Date.now() - this.respondingStartedAt;
      if (elapsed > LONG_RESPONSE_THRESHOLD_MS) {
        return Math.max(this.quietWindowMs, LONG_RESPONSE_QUIET_WINDOW_MS);
      }
    }
    return this.quietWindowMs;
  }

  /**
   * quiet 判定锚点：取「文本最后变化」与「最后观察到 responding」的较晚者。
   * stop 按钮消失后必须再静默 quietWindow 才确认完成；若期间 stop 重新出现，
   * lastRespondingTrueAt 前移且 state 回到 RESPONDING，CANDIDATE_COMPLETE 被撤销。
   * 这是防止 thinking 模型「短暂停止 → 再次 thinking」被误判完成的关键。
   */
  _quietAnchor() {
    return Math.max(this.lastChangeAt, this.lastRespondingTrueAt);
  }

  _evaluate() {
    if (this._result) return;
    const sample = this.lastSample;
    if (!sample) return;

    if (sample.isResponding) {
      this.state = STATES.RESPONDING;
      return;
    }
    if (!this._hasEvidence()) {
      this.state = STATES.IDLE;
      return;
    }
    if (!(sample.textLength > 0) && !String(this.lastText || '').trim()) {
      // assistant 消息出现但文本为空：thinking 模型 DOM 失真场景，限速查 backend
      this._maybeBackendEmptyCheck();
      return;
    }

    const wait = this._quietAnchor() + this._effectiveQuietWindow() - Date.now();
    if (wait > 0) {
      this.state = STATES.CANDIDATE_COMPLETE;
      this._scheduleQuietCheck(wait);
      return;
    }
    this.state = STATES.CANDIDATE_COMPLETE;
    this._confirmComplete().catch(() => {});
  }

  _scheduleQuietCheck(delayMs) {
    if (this._quietTimer) clearTimeout(this._quietTimer);
    const delay = Math.max(0, delayMs);
    // 注意：quiet timer 在完成判定的关键路径上，绝不能 unref——
    // 否则事件循环空闲时（readline 已关闭 / 测试环境）timer 不触发，
    // waitForComplete() 的 Promise 会永久悬挂。watchdog 才是可 unref 的兜底。
    this._quietTimer = setTimeout(() => {
      this._quietTimer = null;
      try {
        this._evaluate();
      } catch {}
    }, delay);
  }

  async _confirmComplete() {
    if (this._confirming || this._result) return;
    this._confirming = true;
    this._emit({ type: 'candidate' });
    try {
      // 1) 直接采样复核（拿完整文本，确认没有重新进入 responding）
      const fresh = await this._directSample();
      if (this._result) return;
      if (fresh) this._applySample(fresh, { viaEvent: false });

      const sample = this.lastSample;
      if (!sample) return;
      if (sample.isResponding) {
        this.state = STATES.RESPONDING;
        return;
      }
      if (Date.now() - this._quietAnchor() < this._effectiveQuietWindow()) {
        this._scheduleQuietCheck(
          this._quietAnchor() + this._effectiveQuietWindow() - Date.now()
        );
        return;
      }

      let finalText =
        fresh && typeof fresh.text === 'string' && fresh.text.trim()
          ? fresh.text
          : this.lastText;
      let source = this.observerActive ? 'dom-observer' : 'dom-poll';

      // 2) backend snapshot 校验（只在确认完成时调用一次，不做高频轮询）
      const convId =
        this.conversationId ||
        extractConversationIdSafe(typeof this.page.url === 'function' ? this.page.url() : '');
      if (convId && this.backend) {
        try {
          const snapshot = await this.backend.getSnapshot(convId);
          if (this._result) return;
          this.snapshotErrorStreak = 0;
          this.lastSnapshotError = null;
          const backendText = this.backend.getLastAssistantText(snapshot);
          if (backendText && backendText.trim()) {
            if (!finalText || backendText.length >= finalText.length) {
              finalText = backendText;
              source = 'backend-confirmed';
            }
          }
          if (snapshot && Array.isArray(snapshot.messages)) {
            this._snapshotCounts = {
              messageCount: snapshot.messages.length,
              assistantMessageCount: snapshot.messages.filter(
                (m) => m && m.role === 'assistant'
              ).length,
            };
          }
        } catch (err) {
          // backend 暂时失败：DOM 主路径继续，用 DOM 文本完成
          this.snapshotErrorStreak += 1;
          this.lastSnapshotError = String(err && err.message ? err.message : err);
        }
        // backend 往返期间 thinking 模型可能恢复生成
        if (this.lastSample && this.lastSample.isResponding) {
          this.state = STATES.RESPONDING;
          return;
        }
      }

      if (!finalText || !finalText.trim()) {
        this._maybeBackendEmptyCheck();
        return;
      }
      this._finish({ state: 'completed', text: finalText, source });
    } finally {
      this._confirming = false;
    }
  }

  // ── backend 兜底 ────────────────────────────────────────────────────────────

  _maybeBackendEmptyCheck() {
    if (!this.backend || !this.conversationId || this._emptyCheckRunning) return;
    const now = Date.now();
    if (now - this.lastEmptyBackendCheckAt < this.emptyTextBackendCheckMs) return;
    this.lastEmptyBackendCheckAt = now;
    this._emptyCheckRunning = true;
    this._runBackendEmptyCheck().catch(() => {}).finally(() => {
      this._emptyCheckRunning = false;
    });
  }

  async _runBackendEmptyCheck() {
    if (this._result) return;
    try {
      const snapshot = await this.backend.getSnapshot(this.conversationId);
      if (this._result) return;
      this.snapshotErrorStreak = 0;
      this.lastSnapshotError = null;
      const text = this.backend.getLastAssistantText(snapshot);
      if (text && text.trim()) {
        const sample = this.lastSample;
        if (!sample || !sample.isResponding) {
          // DOM 空文本但 backend 已有最终答案（thinking 模型选择器漂移）
          this._finish({ state: 'completed', text, source: 'backend-fallback' });
        }
        return;
      }
    } catch (err) {
      this.snapshotErrorStreak += 1;
      this.lastSnapshotError = String(err && err.message ? err.message : err);
    }
    this._checkBackendUnavailable();
  }

  _checkBackendUnavailable() {
    const sample = this.lastSample;
    const noText = !(sample && sample.textLength > 0) && !String(this.lastText || '').trim();
    if (
      this.snapshotErrorStreak >= this.maxSnapshotErrorStreak &&
      (!sample || !sample.isResponding) &&
      noText
    ) {
      this._finish({ state: 'unknown', text: '', backendUnavailable: true });
    }
  }

  async _watchdogBackendCheck() {
    const now = Date.now();
    if (now - this.lastWatchdogBackendAt < this.domEventGapMs) return;
    this.lastWatchdogBackendAt = now;
    if (!this.backend) return;
    const convId =
      this.conversationId ||
      extractConversationIdSafe(typeof this.page.url === 'function' ? this.page.url() : '');
    if (!convId) return;

    try {
      const snapshot = await this.backend.getSnapshot(convId);
      if (this._result) return;
      this.snapshotErrorStreak = 0;
      this.lastSnapshotError = null;
      const text = this.backend.getLastAssistantText(snapshot);
      if (!text || !text.trim()) return;

      if (!this.requireNewActivity) {
        this._finish({ state: 'completed', text, source: 'backend-fallback' });
        return;
      }
      const evidence =
        this.sawResponding || this.sawNewAssistant || this.textChangedFromBaseline;
      if (evidence && text === this._lastWatchdogBackendText) {
        // DOM 不可用，但连续两次 backend 快照文本一致 → 视为完成
        this._finish({ state: 'completed', text, source: 'backend-fallback' });
        return;
      }
      this._lastWatchdogBackendText = text;
      if (text !== this.lastText) {
        this.lastText = text;
        this.lastChangeAt = Date.now();
        this.textChangedFromBaseline = true;
      }
    } catch (err) {
      this.snapshotErrorStreak += 1;
      this.lastSnapshotError = String(err && err.message ? err.message : err);
      this._checkBackendUnavailable();
    }
  }

  // ── watchdog / 超时 ─────────────────────────────────────────────────────────

  async _watchdogTick() {
    if (this._result) return;
    const now = Date.now();
    if (now >= this.deadline) {
      await this._finalizeTimeout();
      return;
    }

    const eventsStale = now - this.lastEventAt > this.domEventGapMs;
    if (!this.observerActive || eventsStale) {
      let sample = await this._directSample();
      if (!sample) {
        // 页面可能经历过整页导航，observer 丢失 → 尝试重装
        const install = await this._installObserver();
        sample = install && install.sample ? install.sample : await this._directSample();
      }
      if (sample) {
        this._applySample(sample, { viaEvent: false });
        this._evaluate();
        return;
      }
      // DOM 完全不可用 → backend 兜底
      await this._watchdogBackendCheck();
    }
    if (!this._result) this._evaluate();
  }

  async _finalizeTimeout() {
    if (this._result) return;
    const convId =
      this.conversationId ||
      extractConversationIdSafe(typeof this.page.url === 'function' ? this.page.url() : '');
    if (convId && this.backend) {
      try {
        const snapshot = await this.backend.getSnapshot(convId);
        const text = this.backend.getLastAssistantText(snapshot);
        if (text && text.trim()) {
          this._finish({ state: 'completed', text, source: 'snapshot-timeout-fallback' });
          return;
        }
      } catch {}
    }
    const evidence =
      this.sawResponding || this.sawNewAssistant || this.textChangedFromBaseline;
    if (!this.requireNewActivity && this.lastText) {
      this._finish({ state: 'completed', text: this.lastText, source: 'timeout-fallback' });
      return;
    }
    if (evidence && this.lastText && this.lastText.trim()) {
      this._finish({ state: 'completed', text: this.lastText, source: 'timeout-fallback' });
      return;
    }
    this._finish({ state: 'timeout', text: '', source: 'timeout' });
  }

  // ── 结束 / 事件 ─────────────────────────────────────────────────────────────

  _finish(partial) {
    if (this._result) return;
    const sample = this.lastSample || {};
    this.state = STATES.COMPLETE;
    this._result = {
      state: partial.state,
      text: partial.text || '',
      source: partial.source || null,
      backendUnavailable: Boolean(partial.backendUnavailable),
      conversationId: this.conversationId,
      sawResponding: this.sawResponding,
      sawNewAssistant: this.sawNewAssistant,
      snapshotErrorStreak: this.snapshotErrorStreak,
      snapshotError: this.lastSnapshotError,
      elapsedMs: Date.now() - this.startedAt,
      checkedAt: new Date().toISOString(),
      sample: {
        url: sample.url || (typeof this.page.url === 'function' ? this.page.url() : null),
        isResponding: Boolean(sample.isResponding),
        messageCount: this._snapshotCounts
          ? this._snapshotCounts.messageCount
          : sample.messageCount ?? 0,
        assistantMessageCount: this._snapshotCounts
          ? this._snapshotCounts.assistantMessageCount
          : sample.assistantMessageCount ?? 0,
        lastMessageRole: sample.lastMessageRole ?? (partial.text ? 'assistant' : null),
      },
    };
    this._emit({
      type: partial.state === 'completed' ? 'complete' : partial.state,
      elapsedMs: this._result.elapsedMs,
      source: this._result.source,
    });
    if (this._watchdog) {
      clearInterval(this._watchdog);
      this._watchdog = null;
    }
    if (this._quietTimer) {
      clearTimeout(this._quietTimer);
      this._quietTimer = null;
    }
    if (this._resolve) this._resolve(this._result);
  }

  _emit(event) {
    if (!this.onState) return;
    try {
      this.onState(event);
    } catch {}
  }
}

module.exports = { ResponseTracker, STATES };
