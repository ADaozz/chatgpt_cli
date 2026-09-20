/**
 * response-tracker.js — 事件驱动的回复完成跟踪器
 *
 * 设计目标（替代旧的 2s 轮询 × 5 轮稳定判定）：
 *   - 主路径：页面内 MutationObserver → exposeFunction → Node 事件，
 *     低成本实时采集 assistant 文本 / stop 按钮 / 消息计数变化；
 *   - 完成判定：backend completion signal 驱动的统一策略（非入口参数博弈）；
 *   - 兜底：backend snapshot（/backend-api/conversation/{id}）只在
 *     「确认完成」「DOM 空文本」「DOM 事件长时间静默」「超时」时调用，
 *     不做高频轮询；
 *   - 状态机：IDLE → RESPONDING → CANDIDATE_COMPLETE → COMPLETE。
 *
 * Completion policy（send 与 status --wait 共用）：
 *   - backend=running  → 禁止 COMPLETE（含 timeout）
 *   - backend=completed + DOM quiet → 短 quiet，不要求 stablePolls
 *   - backend=unknown  → conservative quiet + stablePolls
 *   - DOM responding   → 永不完成
 *   - DOM：stop 可见通常表示生成中；最新 turn 出现 Copy 且 send 可点时
 *     覆盖残留 stop（uiTurnComplete），按 quiet 处理
 *   send / wait 仅 requireNewActivity 初始语义不同，settle 不再分叉。
 *
 * Thinking / 极快回复兼容：
 *   1. assistant 新消息出现但内容暂时为空 → 不判完成，限速查 backend；
 *   2. stop 短暂消失后重新出现 → 撤销 CANDIDATE_COMPLETE；
 *   3. DOM 空文本但 backend 已完成 → 主动 schedule 短 quiet 后完成；
 *   4. backend 暂时 5xx → streak，持续失败且 DOM 空 → unknown；
 *   5. conversationId 从 URL 持续提取；
 *   6. 极快模型：sawNewAssistant / 文本变化同样构成完成证据。
 *
 * 架构约束：
 *   - 不依赖 renderer / theme / cli（业务执行层）
 *   - 不发送消息、不管理项目、不选择模型
 *   - backend 能力通过 options.backend 注入（避免与 adapter 循环依赖）
 */

'use strict';

const S = require('./selectors');

const DEFAULT_TIMEOUT = 600_000;
/** DOM 进入 candidate 前的 debounce（backend 未知时的第一道闸） */
const DEFAULT_QUIET_WINDOW_MS = 600;
/** backend 已明确完成后，仅再等 DOM 最后一拍同步 */
const SHORT_BACKEND_CONFIRMED_QUIET_MS = 400;
/** backend 无法判断时的 conservative quiet */
const FALLBACK_QUIET_MS = 2_500;
/** !stable / backend 需再确认时的主动重试间隔（不依赖 watchdog） */
const BACKEND_RECHECK_MS = 250;
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
 * DOM 完成启发式：stop 可见通常表示生成中，但 ChatGPT 常在正文已定后仍残留 stop。
 * 最新 assistant turn 的 DOM 中已挂上 Copy（操作栏可能仍被 mask/hover 隐藏）→
 * 视为该 turn UI 已完成，覆盖残留 stop。
 */
function computeIsResponding({ stopVisible, hasCopyAction }) {
  return Boolean(stopVisible) && !Boolean(hasCopyAction);
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
  const isSendReady = (el) => {
    if (!isVisible(el)) return false;
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    return true;
  };

  const sample = (wantFull) => {
    const all = document.querySelectorAll(sel.allMessages);
    const assistants = document.querySelectorAll(sel.assistant);
    const turns = sel.assistantTurns
      ? document.querySelectorAll(sel.assistantTurns)
      : [];
    const lastMessage = all[all.length - 1] || null;
    const lastAssistant = assistants[assistants.length - 1] || null;
    const lastTurn =
      turns.length > 0
        ? turns[turns.length - 1]
        : lastAssistant && lastAssistant.closest
          ? lastAssistant.closest(
              'section[data-turn="assistant"], article[data-turn="assistant"], [data-testid^="conversation-turn-"]'
            )
          : null;
    const markdown =
      (lastAssistant && lastAssistant.querySelector(sel.markdown)) || lastAssistant;
    const text = normalizeText(
      (markdown && markdown.innerText) || (lastAssistant && lastAssistant.innerText) || ''
    );
    const stopVisible = isVisible(document.querySelector(sel.stop));
    // Copy 操作栏默认 mask + pointer-events-none，不能用 isVisible；看最新 turn DOM 是否已挂载
    const copyEl =
      (lastTurn && sel.copy && lastTurn.querySelector(sel.copy)) || null;
    const hasCopyAction = Boolean(copyEl);
    const sendReady = isSendReady(document.querySelector(sel.send));
    const uiTurnComplete = hasCopyAction;
    // stop 残留时，最新 turn 已有 Copy → 覆盖 isResponding
    const isResponding = stopVisible && !uiTurnComplete;
    const out = {
      url: location.href,
      isResponding,
      stopVisible,
      hasCopyAction,
      sendReady,
      uiTurnComplete,
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
      s.stopVisible ? 1 : 0,
      s.hasCopyAction ? 1 : 0,
      s.sendReady ? 1 : 0,
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
   * @param {number} [options.quietWindowMs]        DOM 进入 candidate 的 debounce
   * @param {boolean} [options.requireNewActivity]  是否要求观察到新活动（send=true, status --wait=false）
   * @param {string|null} [options.conversationId]  已知对话 ID
   * @param {{ getSnapshot: Function, getLastAssistantText: Function, isTurnComplete?: Function }} [options.backend]
   * @param {Function} [options.onState]            UI 状态回调（renderer 层由调用方接线）
   */
  constructor(page, options = {}) {
    this.page = page;
    this.previousAssistantCount =
      options.previousAssistantCount != null ? options.previousAssistantCount : null;
    this.timeoutMs = options.timeout ?? envNumber('CHATGPT_REPLY_TIMEOUT_MS', DEFAULT_TIMEOUT);
    this.quietWindowMs =
      options.quietWindowMs ?? envNumber('CHATGPT_QUIET_WINDOW_MS', DEFAULT_QUIET_WINDOW_MS);
    this.shortBackendConfirmedQuietMs =
      options.shortBackendConfirmedQuietMs ??
      envNumber('CHATGPT_SHORT_BACKEND_QUIET_MS', SHORT_BACKEND_CONFIRMED_QUIET_MS);
    this.fallbackQuietMs =
      options.fallbackQuietMs ?? envNumber('CHATGPT_FALLBACK_QUIET_MS', FALLBACK_QUIET_MS);
    this.backendRecheckMs =
      options.backendRecheckMs ?? envNumber('CHATGPT_BACKEND_RECHECK_MS', BACKEND_RECHECK_MS);
    this.watchdogIntervalMs = options.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;
    this.domEventGapMs = options.domEventGapMs ?? DEFAULT_DOM_EVENT_GAP_MS;
    this.emptyTextBackendCheckMs =
      options.emptyTextBackendCheckMs ?? DEFAULT_EMPTY_TEXT_BACKEND_CHECK_MS;
    this.maxSnapshotErrorStreak =
      options.maxSnapshotErrorStreak ?? DEFAULT_MAX_SNAPSHOT_ERROR_STREAK;
    this.requireNewActivity = options.requireNewActivity !== false;
    this.stablePolls = Math.max(
      1,
      Number(options.stablePolls) || envNumber('CHATGPT_STABLE_POLLS', 2)
    );
    // 仅作用于 backend=unknown 的 fallback；默认 0，不再作为路径硬地板
    this.completeSettleMs = Math.max(
      0,
      options.completeSettleMs ?? envNumber('CHATGPT_COMPLETE_SETTLE_MS', 0)
    );
    this.backend = options.backend || null;
    this.conversationId = options.conversationId || null;
    this.onState = typeof options.onState === 'function' ? options.onState : null;
    this.selectors = options.selectors || {
      stop: S.composer.stopBtn,
      send: S.composer.sendBtn,
      copy: S.turn.copyAction,
      allMessages: S.response.allMessages,
      assistant: S.response.assistantMsgs,
      assistantTurns: S.response.assistantTurns,
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
    this.lastInactiveAt = 0;
    this.lastAssistantCountChangeAt = 0;
    this.lastUiTurnCompleteAt = 0;
    this.lastSampleWasResponding = false;
    this._lastUiTurnComplete = false;
    this._lastAssistantCount = null;
    this.sawNewAssistant = false;
    this.sawUiTurnComplete = false;
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
    this._backendStable = { text: null, count: null, streak: 0 };
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
      this._clearQuietTimer();
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
      this.lastRespondingTrueAt = Date.now();
      this._clearQuietTimer();
    } else if (this.lastSampleWasResponding) {
      this.lastInactiveAt = Date.now();
    }
    this.lastSampleWasResponding = Boolean(sample.isResponding);

    const uiTurnComplete = Boolean(
      sample.uiTurnComplete || sample.hasCopyAction
    );
    if (uiTurnComplete) {
      this.sawUiTurnComplete = true;
      if (!this._lastUiTurnComplete) {
        this.lastUiTurnCompleteAt = Date.now();
        // Copy+send 就绪视作 UI 完成沿；即便 stop 残留也推进 quiet 锚点
        this.lastInactiveAt = Math.max(this.lastInactiveAt, this.lastUiTurnCompleteAt);
      }
    }
    this._lastUiTurnComplete = uiTurnComplete;

    const countBase =
      this.previousAssistantCount != null
        ? this.previousAssistantCount
        : this.baselineAssistantCount;
    if (countBase != null && sample.assistantMessageCount > countBase) {
      this.sawNewAssistant = true;
    }
    if (
      this._lastAssistantCount != null &&
      sample.assistantMessageCount > this._lastAssistantCount
    ) {
      this.lastAssistantCountChangeAt = Date.now();
      this._backendStable.streak = 0;
      this._clearQuietTimer();
    }
    if (typeof sample.assistantMessageCount === 'number') {
      this._lastAssistantCount = sample.assistantMessageCount;
    }

    const textSig = `${sample.textLength}|${sample.textTail}`;
    const changeSig = [
      sample.assistantMessageCount,
      sample.lastMessageRole,
      textSig,
      sample.hasCopyAction ? 1 : 0,
      sample.sendReady ? 1 : 0,
      sample.stopVisible ? 1 : 0,
    ].join('|');

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

  // ── 状态机 / completion policy ─────────────────────────────────────────────

  _hasEvidence() {
    return (
      !this.requireNewActivity ||
      this.sawResponding ||
      this.sawNewAssistant ||
      this.sawUiTurnComplete ||
      this.textChangedFromBaseline
    );
  }

  /**
   * 统一 completion 信号视图。
   * @returns {{ backendState: 'running'|'completed'|'unknown', domState: 'responding'|'quiet', textState: 'present'|'empty', uiTurnComplete: boolean }}
   */
  _getCompletionDecision({ snapshot, sample, text } = {}) {
    let backendState = 'unknown';
    if (snapshot !== undefined) {
      const turnComplete = this._backendTurnComplete(snapshot);
      if (turnComplete === false) backendState = 'running';
      else if (turnComplete === true) backendState = 'completed';
    }

    const activeSample = sample || this.lastSample;
    const uiTurnComplete = Boolean(
      activeSample &&
        (activeSample.uiTurnComplete || activeSample.hasCopyAction)
    );
    // 优先用采样时已计算的 isResponding（含 Copy 覆盖残留 stop）
    let responding = Boolean(activeSample && activeSample.isResponding);
    if (activeSample && (activeSample.stopVisible != null || uiTurnComplete)) {
      responding = computeIsResponding({
        stopVisible: Boolean(activeSample.stopVisible ?? activeSample.isResponding),
        hasCopyAction: Boolean(activeSample.hasCopyAction),
      });
    }
    const domState = responding ? 'responding' : 'quiet';

    const textValue =
      text != null
        ? text
        : this.lastText ||
          (activeSample && typeof activeSample.text === 'string' ? activeSample.text : '');
    const textFromSample = activeSample && activeSample.textLength > 0;
    const textState =
      (textValue && String(textValue).trim()) || textFromSample ? 'present' : 'empty';

    return { backendState, domState, textState, uiTurnComplete };
  }

  /** backend 已知后的 quiet 要求（running 不应调用） */
  _policyQuietMs(backendState) {
    if (backendState === 'completed') {
      return this.shortBackendConfirmedQuietMs;
    }
    return Math.max(this.fallbackQuietMs, this.quietWindowMs, this.completeSettleMs);
  }

  /**
   * @returns {{ action: 'veto'|'wait'|'schedule'|'confirm', delayMs?: number }}
   */
  _nextAction(decision) {
    if (decision.domState === 'responding' || decision.backendState === 'running') {
      return { action: 'veto' };
    }
    if (decision.textState === 'empty') {
      return { action: 'wait' };
    }
    const quietMs = this._policyQuietMs(decision.backendState);
    const remaining = this._quietAnchor() + quietMs - Date.now();
    if (remaining > 0) {
      return { action: 'schedule', delayMs: remaining };
    }
    return { action: 'confirm' };
  }

  /**
   * quiet 判定锚点：取「文本最后变化」「stop 最后一次可见」「stop 刚消失」
   * 「assistant 气泡计数变化」「Copy+send UI 完成」的较晚者。
   */
  _quietAnchor() {
    return Math.max(
      this.lastChangeAt,
      this.lastRespondingTrueAt,
      this.lastInactiveAt,
      this.lastAssistantCountChangeAt,
      this.lastUiTurnCompleteAt
    );
  }

  _clearQuietTimer() {
    if (this._quietTimer) {
      clearTimeout(this._quietTimer);
      this._quietTimer = null;
    }
  }

  _backendTurnComplete(snapshot) {
    if (!this.backend || typeof this.backend.isTurnComplete !== 'function') {
      return null;
    }
    try {
      const value = this.backend.isTurnComplete(snapshot);
      if (value === true) return true;
      if (value === false) return false;
      return null;
    } catch {
      return null;
    }
  }

  _noteBackendStable(text, assistantCount) {
    const count = assistantCount == null ? null : assistantCount;
    if (this._backendStable.text === text && this._backendStable.count === count) {
      this._backendStable.streak += 1;
    } else {
      this._backendStable = { text, count, streak: 1 };
    }
    return this._backendStable.streak >= this.stablePolls;
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
      this._maybeBackendEmptyCheck();
      return;
    }

    // DOM 第一道 debounce：进入 confirm 后再用 backend policy 决定短/长 quiet
    const wait = this._quietAnchor() + this.quietWindowMs - Date.now();
    if (wait > 0) {
      this.state = STATES.CANDIDATE_COMPLETE;
      this._scheduleQuietCheck(wait);
      return;
    }
    this.state = STATES.CANDIDATE_COMPLETE;
    this._confirmComplete().catch(() => {});
  }

  _scheduleQuietCheck(delayMs) {
    this._clearQuietTimer();
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
      const fresh = await this._directSample();
      if (this._result) return;
      if (fresh) this._applySample(fresh, { viaEvent: false });

      const sample = this.lastSample;
      if (!sample) return;
      if (sample.isResponding) {
        this.state = STATES.RESPONDING;
        return;
      }

      let finalText =
        fresh && typeof fresh.text === 'string' && fresh.text.trim()
          ? fresh.text
          : this.lastText;
      let source = this.observerActive ? 'dom-observer' : 'dom-poll';
      let backendState = 'unknown';

      const convId =
        this.conversationId ||
        extractConversationIdSafe(typeof this.page.url === 'function' ? this.page.url() : '');
      if (convId && this.backend) {
        try {
          const snapshot = await this.backend.getSnapshot(convId);
          if (this._result) return;
          this.snapshotErrorStreak = 0;
          this.lastSnapshotError = null;

          const decision = this._getCompletionDecision({
            snapshot,
            sample,
            text: finalText,
          });
          backendState = decision.backendState;

          if (decision.backendState === 'running') {
            this._backendStable.streak = 0;
            this.state = STATES.RESPONDING;
            this._clearQuietTimer();
            return;
          }

          const backendText = this.backend.getLastAssistantText(snapshot);
          const assistantCount = Array.isArray(snapshot && snapshot.messages)
            ? snapshot.messages.filter((m) => m && m.role === 'assistant').length
            : null;

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

          const next = this._nextAction(
            this._getCompletionDecision({ snapshot, sample: this.lastSample, text: finalText })
          );
          if (next.action === 'veto') {
            this._backendStable.streak = 0;
            this.state = STATES.RESPONDING;
            return;
          }
          if (next.action === 'schedule') {
            this.state = STATES.CANDIDATE_COMPLETE;
            this._scheduleQuietCheck(next.delayMs);
            return;
          }

          // backend=completed：跳过 stablePolls；unknown：要求稳定 streak
          if (backendState === 'unknown') {
            const stable = this._noteBackendStable(finalText, assistantCount);
            if (!stable) {
              this.state = STATES.CANDIDATE_COMPLETE;
              this._scheduleQuietCheck(this.backendRecheckMs);
              return;
            }
          } else {
            this._backendStable = {
              text: finalText,
              count: assistantCount,
              streak: this.stablePolls,
            };
          }
        } catch (err) {
          this.snapshotErrorStreak += 1;
          this.lastSnapshotError = String(err && err.message ? err.message : err);
          backendState = 'unknown';
          const quietMs = this._policyQuietMs('unknown');
          const remaining = this._quietAnchor() + quietMs - Date.now();
          if (remaining > 0) {
            this.state = STATES.CANDIDATE_COMPLETE;
            this._scheduleQuietCheck(remaining);
            return;
          }
        }

        const afterBackend = await this._directSample();
        if (this._result) return;
        if (afterBackend) this._applySample(afterBackend, { viaEvent: false });
        if (this.lastSample && this.lastSample.isResponding) {
          this.state = STATES.RESPONDING;
          return;
        }
        const quietMs = this._policyQuietMs(backendState);
        if (Date.now() - this._quietAnchor() < quietMs) {
          this._scheduleQuietCheck(this._quietAnchor() + quietMs - Date.now());
          return;
        }
      } else {
        // 无 backend：保守 quiet
        const quietMs = this._policyQuietMs('unknown');
        if (Date.now() - this._quietAnchor() < quietMs) {
          this._scheduleQuietCheck(this._quietAnchor() + quietMs - Date.now());
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
          const turnComplete = this._backendTurnComplete(snapshot);
          this.lastText = text;
          this.textChangedFromBaseline = true;
          if (turnComplete === false) {
            this.state = STATES.RESPONDING;
            return;
          }
          this.state = STATES.CANDIDATE_COMPLETE;
          if (turnComplete === true) {
            this._scheduleQuietCheck(this.shortBackendConfirmedQuietMs);
          } else {
            this._scheduleQuietCheck(this._policyQuietMs('unknown'));
          }
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

      const decision = this._getCompletionDecision({
        snapshot,
        sample: this.lastSample,
        text,
      });
      if (decision.backendState === 'running') {
        this._backendStable.streak = 0;
        if (text !== this.lastText) {
          this.lastText = text;
          this.lastChangeAt = Date.now();
          this.textChangedFromBaseline = true;
        }
        this.state = STATES.RESPONDING;
        return;
      }

      const assistantCount = Array.isArray(snapshot.messages)
        ? snapshot.messages.filter((m) => m && m.role === 'assistant').length
        : null;

      if (decision.backendState === 'unknown') {
        const stable = this._noteBackendStable(text, assistantCount);
        if (!stable) {
          this._lastWatchdogBackendText = text;
          this.state = STATES.CANDIDATE_COMPLETE;
          this._scheduleQuietCheck(this.backendRecheckMs);
          return;
        }
      }

      const quietMs = this._policyQuietMs(decision.backendState);
      const evidence =
        !this.requireNewActivity ||
        this.sawResponding ||
        this.sawNewAssistant ||
        this.textChangedFromBaseline;

      if (!evidence) {
        this._lastWatchdogBackendText = text;
        if (text !== this.lastText) {
          this.lastText = text;
          this.lastChangeAt = Date.now();
          this.textChangedFromBaseline = true;
        }
        return;
      }

      if (Date.now() - this._quietAnchor() < quietMs) {
        this._lastWatchdogBackendText = text;
        this.state = STATES.CANDIDATE_COMPLETE;
        this._scheduleQuietCheck(this._quietAnchor() + quietMs - Date.now());
        return;
      }

      const fresh = await this._directSample();
      if (fresh) this._applySample(fresh, { viaEvent: false });
      if (this.lastSample && this.lastSample.isResponding) return;

      this._finish({ state: 'completed', text, source: 'backend-fallback' });
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
        const install = await this._installObserver();
        sample = install && install.sample ? install.sample : await this._directSample();
      }
      if (sample) {
        this._applySample(sample, { viaEvent: false });
        this._evaluate();
        return;
      }
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
        const turnComplete = this._backendTurnComplete(snapshot);
        // I1/I6: backend 明确未完成时不得以 completed 结束
        if (turnComplete === false) {
          this._finish({
            state: 'timeout',
            text: (text && text.trim()) || this.lastText || '',
            source: 'timeout-still-running',
          });
          return;
        }
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
    this._clearQuietTimer();
    if (this._resolve) this._resolve(this._result);
  }

  _emit(event) {
    if (!this.onState) return;
    try {
      this.onState(event);
    } catch {}
  }
}

module.exports = {
  ResponseTracker,
  STATES,
  computeIsResponding,
  SHORT_BACKEND_CONFIRMED_QUIET_MS,
  FALLBACK_QUIET_MS,
  BACKEND_RECHECK_MS,
  DEFAULT_QUIET_WINDOW_MS,
};
