/**
 * response-tracker.js — 回复跟踪状态机（send 与 status --wait 共用）
 *
 * 完成判定（PR04 + 2026-10-28 实机修订）：
 *   1. 首选：协议确认终态（async_status 空闲 + 当前分支最后 assistant 消息
 *      channel="final" + end_turn===true + 无 open reasoning）且最终结果读取成功
 *      → completed（completionSource: "protocol"）。
 *   2. DOM 证据：最新 turn `data-talvt-turn-state="complete"`、停止按钮消失、
 *      复制按钮已挂载、最后回复文本非空且稳定 → 视为「DOM 已确认完成」。
 *      - 协议明确仍在生成（async/reasoning）→ 继续等待，DOM 不得提前成功；
 *      - 协议暂时不可用（网络/5xx/401/429）且 DOM 证据稳定 → completed
 *        （completionSource: "dom"）。这是 v1.2.2 的「复制按钮 + 发送按钮恢复」
 *        判定路径，用于协议读取失败时仍能正确接收回复。
 *   3. 超时：有 DOM 证据 → completed(dom)；否则 timeout/unknown，保留部分文本。
 *
 * 状态：completed | cancelled | timeout | unknown
 */

'use strict';

const { getLastAssistantFromSnapshot } = require('./conversation-parser');
const { extractConversationId, isUsableConversationId } = require('./url-utils');

const DEFAULT_TIMEOUT_MS = Number(process.env.CHATGPT_REPLY_TIMEOUT_MS) || 600_000;
const POLL_INTERVAL_MS = Number(process.env.CHATGPT_TRACKER_POLL_MS) || 2_000;
const MAX_CONSECUTIVE_ERRORS = Number(process.env.CHATGPT_TRACKER_MAX_ERRORS) || 12;
const MAX_RATE_LIMIT_WAITS = 10;
const RATE_LIMIT_WAIT_CAP_MS = 60_000;
const PROTOCOL_CALL_TIMEOUT_MS = Number(process.env.CHATGPT_PROTOCOL_CALL_TIMEOUT_MS) || 15_000;
const DOM_CONFIRM_MS = Number(process.env.CHATGPT_DOM_CONFIRM_MS) || 2_000;
const WATCHDOG_INTERVAL_MS = 1_000;

/** 单次协议调用加超时，避免 CDP evaluate 卡死拖垮整个跟踪。 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class ResponseTracker {
  /**
   * @param {object} deps
   * @param {import('./page-controller').PageController} deps.pageController
   * @param {import('./web-protocol').WebProtocol} deps.protocol
   * @param {string|null} deps.conversationId
   * @param {object} [options]
   * @param {number} [options.timeoutMs]
   * @param {number} [options.pollIntervalMs]
   * @param {boolean} [options.requireNewTurn] send 流程要求观察到本轮新 turn
   * @param {number} [options.baselineTurnCount] 发送前的 turn 数
   * @param {Function} [options.onState] UI 状态回调
   */
  constructor({ pageController, protocol, conversationId, timeoutMs, pollIntervalMs, requireNewTurn, baselineTurnCount, onState }) {
    this.pages = pageController;
    this.protocol = protocol;
    this.conversationId = conversationId || null;
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollIntervalMs = pollIntervalMs ?? POLL_INTERVAL_MS;
    this.requireNewTurn = requireNewTurn === true;
    this.baselineTurnCount = baselineTurnCount ?? null;
    this.onState = typeof onState === 'function' ? onState : null;

    this.state = 'running';
    this.startedAt = 0;
    this._resolved = false;
    this._timer = null;
    this._watchdog = null;
    this._bridgeListener = null;
    this._polling = false;
    this._errorStreak = 0;
    this._rateLimitWaits = 0;
    this._lastActivityAt = 0;
    this._lastText = '';
    this._lastBlocks = [];
    this._lastHasUnsupported = false;
    this._lastError = null;
    this._sawNewTurn = !this.requireNewTurn;
    this._lastDomTurnState = null;
    this._lastDomTurnInProgress = null;
    this._lastDomUiComplete = null;
    this._lastDomStopVisible = null;
    this._lastDomCopyAction = null;
    this._stalledTicks = 0;
    // 最近一次成功的协议判定（null=无判定 / true=完成 / false=未完成）
    this._lastProtocolVerdict = null;
    this._lastProtocolVerdictAt = 0;

    // DOM 完成证据
    this._domCandidateSince = 0;
    this._domCandidateText = '';
    this._fullSampleInFlight = false;
    this._lastFullSampleAt = 0;

    this._promise = new Promise((resolve) => { this._resolve = resolve; });
  }

  async start() {
    this.startedAt = Date.now();
    this._lastActivityAt = this.startedAt;

    const { bridge } = await this.pages.installObserver();
    if (bridge && bridge.exposed) {
      this._bridgeListener = (sample) => this._onDomSample(sample);
      bridge.listeners.add(this._bridgeListener);
    }
    const baseline = await this.pages.sampleDom();
    if (baseline) {
      this._onDomSample(baseline, true);
      if (this.baselineTurnCount == null) this.baselineTurnCount = baseline.turnCount;
      if (this.requireNewTurn && baseline.turnCount > this.baselineTurnCount) {
        this._sawNewTurn = true;
      }
    }

    this._timer = setInterval(() => {
      this._tick('timer').catch(() => {});
    }, this.pollIntervalMs);
    // 独立看门狗：即使某次协议调用挂起（_polling 卡住），也保证超时终态。
    this._watchdog = setInterval(() => this._watchdogTick(), WATCHDOG_INTERVAL_MS);

    this._tick('start').catch(() => {});
    return this;
  }

  waitForComplete() {
    return this._promise;
  }

  async stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
    if (this._bridgeListener) {
      const bridge = this.pages.page.__chatgptCliDomBridge;
      if (bridge) bridge.listeners.delete(this._bridgeListener);
      this._bridgeListener = null;
    }
    await this.pages.uninstallObserver().catch(() => {});
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  /** DOM 是否给出了可信的「本轮已完成」证据（复制按钮 + 停止消失 + 文本稳定）。 */
  _domEvidence() {
    if (!this._sawNewTurn) return null;
    if (this._lastDomUiComplete !== true) return null;
    if (this._lastDomStopVisible === true) return null;
    if (this._lastDomCopyAction !== true) return null;
    const text = (this._lastText || '').trim();
    if (!text) return null;
    return { text };
  }

  _onDomSample(sample, isBaseline = false) {
    if (!sample || this._resolved) return;
    this._lastActivityAt = Date.now();
    this._lastDomTurnState = sample.turnState ?? this._lastDomTurnState;
    this._lastDomTurnInProgress = sample.turnInProgress ?? this._lastDomTurnInProgress;
    this._lastDomUiComplete = sample.uiTurnComplete ?? this._lastDomUiComplete;
    this._lastDomStopVisible = sample.stopVisible ?? this._lastDomStopVisible;
    this._lastDomCopyAction = sample.copyActionInLastTurn ?? this._lastDomCopyAction;
    if (sample.turnCount != null && this.baselineTurnCount != null && sample.turnCount > this.baselineTurnCount) {
      this._sawNewTurn = true;
    }

    // 观察器事件只携带轻量签名（无 lastText）；当它命中「完成特征」时
    // 拉取一次完整采样，取得 DOM 文本作为协议不可用时的完成证据。
    const looksComplete =
      sample.uiTurnComplete === true &&
      sample.copyActionInLastTurn === true &&
      sample.stopVisible === false;
    if (sample.lastText !== undefined) {
      if (sample.lastText.trim()) this._lastText = sample.lastText.trim();
    } else if (looksComplete && !isBaseline) {
      this._refreshFullSample();
    }

    const evidence = this._domEvidence();
    if (!evidence) {
      this._domCandidateSince = 0;
      this._domCandidateText = '';
    } else if (evidence.text !== this._domCandidateText) {
      this._domCandidateSince = Date.now();
      this._domCandidateText = evidence.text;
    }

    if (!isBaseline) {
      this._emit({ type: 'dom-activity', turnState: sample.turnState, stopVisible: sample.stopVisible });
      // DOM 证据就绪 → 立即触发一次协议确认（不必等下一个轮询周期）
      if (this._domCandidateSince && this._polling === false) {
        this._tick('dom-event').catch(() => {});
      }
    }
  }

  _domStableMs() {
    return this._domCandidateSince ? Date.now() - this._domCandidateSince : 0;
  }

  /** 拉取完整 DOM 采样（带文本），用于完成证据；节流避免高频 evaluate。 */
  async _refreshFullSample() {
    if (this._fullSampleInFlight || this._resolved) return;
    if (Date.now() - this._lastFullSampleAt < 300) return;
    this._lastFullSampleAt = Date.now();
    this._fullSampleInFlight = true;
    try {
      const full = await this.pages.sampleDom();
      if (full) this._onDomSample(full);
    } catch {
    } finally {
      this._fullSampleInFlight = false;
    }
  }

  /**
   * 协议不可用时是否允许用 DOM 证据交付：
   * 最近一次协议判定不是「明确仍在生成」，或该判定已过期（DOM 比协议新）。
   */
  _domFallbackAllowed() {
    if (this._lastProtocolVerdict !== false) return true;
    return Date.now() - this._lastProtocolVerdictAt > DOM_CONFIRM_MS;
  }

  _emit(event) {
    if (!this.onState) return;
    try { this.onState(event); } catch {}
  }

  _elapsed() {
    return Date.now() - this.startedAt;
  }

  /** 独立看门狗：超时兜底（即使协议调用挂起也保证终态）。 */
  _watchdogTick() {
    if (this._resolved) return;
    if (this._elapsed() <= this.timeoutMs) return;
    const domEvidence = this._domEvidence();
    if (domEvidence && this._domFallbackAllowed()) {
      this._finish(this._completedFromDom(domEvidence.text, '超时兜底：DOM 证据稳定，协议未确认'));
      return;
    }
    this._finish(
      this._partialResult(
        this._lastText ? 'unknown' : 'timeout',
        `超时（${this.timeoutMs}ms）：协议未确认终态且 DOM 无完整证据`
      )
    );
  }

  _finish(result) {
    if (this._resolved) return;
    this._resolved = true;
    this.state = result.state;
    this.stop().catch(() => {});
    this._resolve(result);
  }

  _completedFromDom(text, note) {
    return {
      state: 'completed',
      completionSource: 'dom',
      conversationId: this.conversationId,
      text: text || this._lastText || '',
      blocks: this._lastBlocks || [],
      hasUnsupportedContent: this._lastHasUnsupported || false,
      partial: true,
      turnState: this._lastDomTurnState,
      partialTextPreserved: true,
      error: note || null,
    };
  }

  _partialResult(state, reason) {
    return {
      state,
      completionSource: null,
      conversationId: this.conversationId,
      text: this._lastText || '',
      blocks: this._lastBlocks || [],
      hasUnsupportedContent: this._lastHasUnsupported || false,
      turnState: this._lastDomTurnState,
      partialTextPreserved: Boolean(this._lastText),
      error: reason || this._lastError || null,
    };
  }

  async _tick(source) {
    if (this._resolved || this._polling) return;
    this._polling = true;
    try {
      if (!this.conversationId) {
        const id = extractConversationId(this.pages.url());
        // 新会话占位 id（如 /c/local-chatgpt）不可用于协议读取，继续等真实 UUID。
        if (id && isUsableConversationId(id)) this.conversationId = id;
        else if (this._elapsed() > this.timeoutMs) {
          this._finish(this._partialResult('timeout', `等待 conversationId 超时（${this.timeoutMs}ms）`));
          return;
        } else return;
      }

      const { snapshot } = await withTimeout(
        this.protocol.fetchConversation(this.conversationId, { numTurns: 4 }),
        PROTOCOL_CALL_TIMEOUT_MS,
        'fetchConversation'
      );
      this._errorStreak = 0;
      this._lastActivityAt = Date.now();
      const completion = snapshot.completion;
      this._lastProtocolVerdict = completion ? completion.turnComplete : null;
      this._lastProtocolVerdictAt = Date.now();
      const partialText = getLastAssistantFromSnapshot(snapshot);
      if (partialText) {
        this._lastText = partialText;
        const lastFinal = completion && completion.lastFinal;
        this._lastBlocks = (lastFinal && lastFinal.blocks) || [];
        this._lastHasUnsupported = (lastFinal && lastFinal.hasUnsupportedContent) || false;
      }

      if (completion && completion.turnComplete === true) {
        // 完成 final 优先于 async_status（async 可能因后处理持久非空）
        if (!this._sawNewTurn) {
          if (this._elapsed() > Math.min(this.timeoutMs, 60_000)) {
            this._finish(this._partialResult('timeout', '协议显示对话已完成，但未观察到本轮新回复（消息可能未发送成功）'));
            return;
          }
        } else {
          const final = await this._readFinalResult();
          this._finish({
            state: 'completed',
            completionSource: 'protocol',
            conversationId: this.conversationId,
            text: final.text,
            blocks: final.blocks,
            hasUnsupportedContent: final.hasUnsupportedContent,
            partial: final.partial,
            turnState: this._lastDomTurnState,
            error: null,
          });
          return;
        }
      } else if (completion && completion.asyncInProgress) {
        this._stalledTicks = 0;
        this._emit({ type: 'generating', elapsed: this._elapsed(), textPreview: this._lastText.slice(-120) });
      } else if (completion && completion.hasOpenReasoning) {
        if (
          this._lastDomUiComplete === true &&
          this._lastDomTurnInProgress === false &&
          this._sawNewTurn
        ) {
          this._stalledTicks += 1;
          if (this._stalledTicks >= 3) {
            this._finish(
              this._partialResult(
                'cancelled',
                '协议显示思考中断且无最终回复（疑似生成被停止/中断），不声称成功'
              )
            );
            return;
          }
        } else {
          this._stalledTicks = 0;
        }
        this._emit({ type: 'thinking', elapsed: this._elapsed(), textPreview: this._lastText.slice(-120) });
      } else {
        // 协议信号不足（turnComplete === null）或未完成：DOM 证据稳定时兜底
        this._stalledTicks = 0;
        this._emit({ type: 'waiting', elapsed: this._elapsed(), textPreview: this._lastText.slice(-120) });
      }
    } catch (err) {
      this._lastError = `${err && err.name ? err.name + ': ' : ''}${err && err.message ? err.message : err}`;
      if (err && err.kind === 'rate_limited') {
        this._rateLimitWaits += 1;
        const waitMs = Math.min(err.retryAfterMs || 5_000, RATE_LIMIT_WAIT_CAP_MS);
        this._emit({ type: 'rate-limited', retryAfterMs: waitMs });
        if (this._rateLimitWaits > MAX_RATE_LIMIT_WAITS) {
          // 限流期间若 DOM 已完成 → 用 DOM 证据交付，而不是空等
          const domEvidence = this._domEvidence();
          if (domEvidence && this._domStableMs() >= DOM_CONFIRM_MS && this._domFallbackAllowed()) {
            this._finish(this._completedFromDom(domEvidence.text, '429 持续限流，使用 DOM 完成证据'));
          } else {
            this._finish(this._partialResult('unknown', `限流等待次数过多（${this._rateLimitWaits} 次 429），停止跟踪`));
          }
          return;
        }
        await new Promise((r) => setTimeout(r, waitMs));
      } else {
        this._errorStreak += 1;
        this._emit({ type: 'protocol-error', streak: this._errorStreak, message: this._lastError });

        // 关键路径（v1.2.2 行为回归）：协议不可用时，DOM 证据稳定
        // （turn complete + stop 消失 + 复制按钮挂载 + 文本非空）即可交付。
        const domEvidence = this._domEvidence();
        if (domEvidence && this._domStableMs() >= DOM_CONFIRM_MS && this._domFallbackAllowed()) {
          this._finish(this._completedFromDom(domEvidence.text, `协议不可用，使用 DOM 完成证据：${this._lastError}`));
          return;
        }

        await new Promise((r) => setTimeout(r, Math.min(this.pollIntervalMs * this._errorStreak, 15_000)));
        if (this._errorStreak >= MAX_CONSECUTIVE_ERRORS) {
          if (domEvidence && this._domStableMs() >= DOM_CONFIRM_MS && this._domFallbackAllowed()) {
            this._finish(this._completedFromDom(domEvidence.text, `协议连续失败 ${this._errorStreak} 次，使用 DOM 完成证据`));
          } else {
            this._finish(this._partialResult('unknown', `协议连续失败 ${this._errorStreak} 次：${this._lastError}`));
          }
          return;
        }
      }
      if (this._elapsed() > this.timeoutMs) {
        this._finish(this._partialResult(this._lastText ? 'unknown' : 'timeout'));
      }
    } finally {
      this._polling = false;
      void source;
    }
  }

  async _readFinalResult() {
    try {
      const { snapshot } = await withTimeout(
        this.protocol.readConversation(this.conversationId, { numTurns: 4, maxPages: 3 }),
        PROTOCOL_CALL_TIMEOUT_MS * 2,
        'readConversation'
      );
      const text = getLastAssistantFromSnapshot(snapshot);
      if (text) this._lastText = text;
      const completion = snapshot.completion || {};
      const lastFinal = completion.lastFinal || null;
      return {
        text,
        blocks: (lastFinal && lastFinal.blocks) || this._lastBlocks || [],
        hasUnsupportedContent: (lastFinal && lastFinal.hasUnsupportedContent) || false,
        partial: Boolean(snapshot.partial),
      };
    } catch {
      // 最终读取失败：保留轮询期间已取得的文本，但显式标记 partial
      return { text: this._lastText, blocks: this._lastBlocks, hasUnsupportedContent: this._lastHasUnsupported, partial: true };
    }
  }
}

module.exports = { ResponseTracker, DEFAULT_TIMEOUT_MS };
