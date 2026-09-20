'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  ResponseTracker,
  BACKEND_RECHECK_MS,
  computeIsResponding,
} = require('../response-tracker');

function makeSample(overrides = {}) {
  const text = Object.prototype.hasOwnProperty.call(overrides, 'text')
    ? overrides.text
    : 'OK';
  const textStr = text == null ? '' : String(text);
  const stopVisible = Object.prototype.hasOwnProperty.call(overrides, 'stopVisible')
    ? Boolean(overrides.stopVisible)
    : Boolean(overrides.isResponding);
  const hasCopyAction = Boolean(overrides.hasCopyAction);
  const sendReady = Boolean(overrides.sendReady);
  const uiTurnComplete =
    overrides.uiTurnComplete != null
      ? Boolean(overrides.uiTurnComplete)
      : hasCopyAction;
  const isResponding = Object.prototype.hasOwnProperty.call(overrides, 'isResponding')
    ? Boolean(overrides.isResponding)
    : computeIsResponding({ stopVisible, hasCopyAction });
  return {
    url: 'https://chatgpt.com/c/conv-1',
    messageCount: 2,
    assistantMessageCount: 1,
    lastMessageRole: 'assistant',
    sampledAt: Date.now(),
    ...overrides,
    text: textStr,
    textLength: textStr.length,
    textTail: textStr.slice(-400),
    stopVisible,
    hasCopyAction,
    sendReady,
    uiTurnComplete,
    isResponding,
  };
}

function createFakePage(getSample) {
  return {
    url: () => {
      const s = getSample();
      return (s && s.url) || 'https://chatgpt.com/c/conv-1';
    },
    async exposeFunction() {
      throw new Error('fake page: exposeFunction unavailable');
    },
    async evaluate(fn, ...args) {
      const sample = { ...getSample() };
      if (args.length > 0) {
        return { status: 'installed', sample };
      }
      return sample;
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fastOpts(extra = {}) {
  return {
    conversationId: 'conv-1',
    quietWindowMs: 40,
    shortBackendConfirmedQuietMs: 25,
    fallbackQuietMs: 90,
    backendRecheckMs: 20,
    stablePolls: 2,
    watchdogIntervalMs: 10_000,
    emptyTextBackendCheckMs: 5,
    timeout: 8_000,
    completeSettleMs: 0,
    ...extra,
  };
}

function createBackend({ turnComplete, text = 'OK', messages } = {}) {
  const snapshot = {
    messages:
      messages ||
      [{ role: 'assistant', content: text }],
    text,
  };
  return {
    getSnapshot: async () => snapshot,
    getLastAssistantText: (s) => (s && s.text) || text,
    isTurnComplete: () => turnComplete,
  };
}

describe('ResponseTracker completion policy', { concurrency: false }, () => {
  /** @type {import('../response-tracker').ResponseTracker[]} */
  let trackers = [];

  beforeEach(() => {
    trackers = [];
  });

  afterEach(async () => {
    const list = trackers.splice(0, trackers.length);
    for (const t of list) {
      try {
        await t.stop();
      } catch {}
      if (t._result == null && typeof t._finish === 'function') {
        try {
          t._finish({ state: 'timeout', text: '', source: 'test-cleanup' });
        } catch {}
      }
    }
  });

  async function startTracker(page, options) {
    const tracker = new ResponseTracker(page, options);
    trackers.push(tracker);
    await tracker.start();
    return tracker;
  }

  it('I1: backend=running never completes even after DOM quiet', async () => {
    let sample = makeSample({ text: 'progress…' });
    const page = createFakePage(() => sample);
    const tracker = await startTracker(page, {
      ...fastOpts({ requireNewActivity: false, timeout: 400 }),
      backend: createBackend({ turnComplete: false, text: 'progress…' }),
    });

    await sleep(200);
    assert.equal(tracker._result, null);
    assert.notEqual(tracker.state, 'COMPLETE');

    await tracker._finalizeTimeout();
    assert.ok(tracker._result);
    assert.equal(tracker._result.state, 'timeout');
    assert.equal(tracker._result.source, 'timeout-still-running');
  });

  it('I2: backend=completed + DOM quiet finishes without long settle', async () => {
    const sample = makeSample({ text: 'ACK' });
    const page = createFakePage(() => sample);
    const started = Date.now();
    const tracker = await startTracker(page, {
      ...fastOpts({ requireNewActivity: false }),
      backend: createBackend({ turnComplete: true, text: 'ACK' }),
    });

    const result = await tracker.waitForComplete();
    const elapsed = Date.now() - started;
    assert.equal(result.state, 'completed');
    assert.equal(result.text, 'ACK');
    assert.ok(elapsed < 2_000, `expected fast complete, got ${elapsed}ms`);
  });

  it('I3: backend=unknown requires fallback quiet and stable streak', async () => {
    const sample = makeSample({ text: 'maybe done' });
    const page = createFakePage(() => sample);
    const scheduled = [];
    const tracker = await startTracker(page, {
      ...fastOpts({
        requireNewActivity: false,
        fallbackQuietMs: 120,
        stablePolls: 2,
        backendRecheckMs: 25,
      }),
      backend: createBackend({ turnComplete: null, text: 'maybe done' }),
    });

    const orig = tracker._scheduleQuietCheck.bind(tracker);
    tracker._scheduleQuietCheck = (delayMs) => {
      scheduled.push(delayMs);
      return orig(delayMs);
    };

    const result = await tracker.waitForComplete();
    assert.equal(result.state, 'completed');
    assert.ok(
      scheduled.some((d) => d >= 50),
      `expected fallback quiet schedule, got ${JSON.stringify(scheduled)}`
    );
    assert.ok(
      scheduled.some((d) => d === 25 || d === tracker.backendRecheckMs),
      `expected backend recheck after !stable, got ${JSON.stringify(scheduled)}`
    );
  });

  it('I4: !stable actively reschedules instead of bare return', async () => {
    const sample = makeSample({ text: 'stable?' });
    const page = createFakePage(() => sample);
    const tracker = await startTracker(page, {
      ...fastOpts({
        requireNewActivity: false,
        quietWindowMs: 20,
        fallbackQuietMs: 20,
        stablePolls: 3,
        backendRecheckMs: 30,
      }),
      backend: createBackend({ turnComplete: null, text: 'stable?' }),
    });

    const delays = [];
    const orig = tracker._scheduleQuietCheck.bind(tracker);
    tracker._scheduleQuietCheck = (delayMs) => {
      delays.push(delayMs);
      return orig(delayMs);
    };

    // Force confirm once quiet elapsed
    await sleep(40);
    await tracker._confirmComplete();
    assert.ok(
      delays.includes(30) || delays.includes(tracker.backendRecheckMs),
      `expected recheck schedule, got ${JSON.stringify(delays)}`
    );
    assert.ok(tracker._quietTimer != null || tracker._result, 'timer or progress expected');
    assert.notEqual(tracker._result && tracker._result.state, 'completed');
  });

  it('I5: empty DOM + backend text + completed advances without watchdog-only wait', async () => {
    let sample = makeSample({
      text: '',
      textLength: 0,
      textTail: '',
      assistantMessageCount: 1,
    });
    const page = createFakePage(() => sample);
    const scheduled = [];
    const tracker = await startTracker(page, {
      ...fastOpts({
        requireNewActivity: false,
        emptyTextBackendCheckMs: 0,
        shortBackendConfirmedQuietMs: 30,
      }),
      backend: createBackend({ turnComplete: true, text: 'from-backend' }),
    });

    const orig = tracker._scheduleQuietCheck.bind(tracker);
    tracker._scheduleQuietCheck = (delayMs) => {
      scheduled.push(delayMs);
      return orig(delayMs);
    };

    await tracker._runBackendEmptyCheck();
    assert.equal(tracker.lastText, 'from-backend');
    assert.ok(
      scheduled.some((d) => d === 30 || d === tracker.shortBackendConfirmedQuietMs),
      `expected short quiet schedule, got ${JSON.stringify(scheduled)}`
    );

    sample = makeSample({ text: 'from-backend' });
    const result = await tracker.waitForComplete();
    assert.equal(result.state, 'completed');
    assert.match(result.text, /from-backend/);
  });

  it('I6: timeout fallback respects backend=running', async () => {
    const sample = makeSample({ text: 'still thinking' });
    const page = createFakePage(() => sample);
    const tracker = await startTracker(page, {
      ...fastOpts({
        requireNewActivity: false,
        timeout: 80,
        watchdogIntervalMs: 25,
      }),
      backend: createBackend({ turnComplete: false, text: 'still thinking' }),
    });

    const result = await tracker.waitForComplete();
    assert.equal(result.state, 'timeout');
    assert.equal(result.source, 'timeout-still-running');
  });

  it('I7: send vs wait share settle policy when evidence is present', async () => {
    const sharedBackend = createBackend({ turnComplete: true, text: 'same' });
    const opts = fastOpts({
      quietWindowMs: 35,
      shortBackendConfirmedQuietMs: 20,
      fallbackQuietMs: 200,
    });

    async function run(requireNewActivity) {
      const sample = makeSample({ text: 'same', assistantMessageCount: 2 });
      const page = createFakePage(() => sample);
      const started = Date.now();
      const tracker = await startTracker(page, {
        ...opts,
        requireNewActivity,
        previousAssistantCount: requireNewActivity ? 1 : null,
        backend: sharedBackend,
      });
      const result = await tracker.waitForComplete();
      return { result, elapsed: Date.now() - started, tracker };
    }

    const a = await run(true);
    const b = await run(false);
    assert.equal(a.result.state, 'completed');
    assert.equal(b.result.state, 'completed');
    assert.equal(a.result.text, b.result.text);
    assert.ok(
      Math.abs(a.elapsed - b.elapsed) < 500,
      `policy delays should match closely: send=${a.elapsed}ms wait=${b.elapsed}ms`
    );
    assert.ok(a.elapsed < 1_500 && b.elapsed < 1_500);
  });

  it('exports policy helpers used by decision path', () => {
    const tracker = new ResponseTracker(createFakePage(() => makeSample()), {
      requireNewActivity: false,
    });
    trackers.push(tracker);
    const running = tracker._getCompletionDecision({
      snapshot: {},
      sample: makeSample({ isResponding: false }),
      text: 'x',
    });
    // without isTurnComplete → unknown
    assert.equal(running.backendState, 'unknown');

    tracker.backend = createBackend({ turnComplete: false });
    const d = tracker._getCompletionDecision({
      snapshot: {},
      sample: makeSample({ isResponding: true, stopVisible: true }),
      text: 'x',
    });
    assert.equal(d.backendState, 'running');
    assert.equal(d.domState, 'responding');
    assert.equal(tracker._nextAction(d).action, 'veto');

    tracker.backend = createBackend({ turnComplete: true });
    const done = tracker._getCompletionDecision({
      snapshot: {},
      sample: makeSample({ isResponding: false, text: 'OK' }),
      text: 'OK',
    });
    assert.equal(done.backendState, 'completed');
    assert.equal(tracker._policyQuietMs('completed'), tracker.shortBackendConfirmedQuietMs);
    assert.ok(tracker._policyQuietMs('unknown') >= FALLBACK_FLOOR(tracker));
    assert.equal(typeof BACKEND_RECHECK_MS, 'number');
  });

  it('Copy + sendReady overrides lingering stop button', () => {
    assert.equal(
      computeIsResponding({ stopVisible: true, hasCopyAction: false }),
      true
    );
    assert.equal(
      computeIsResponding({ stopVisible: true, hasCopyAction: true }),
      false
    );
    assert.equal(
      computeIsResponding({ stopVisible: false, hasCopyAction: true }),
      false
    );

    const tracker = new ResponseTracker(createFakePage(() => makeSample()), {
      requireNewActivity: false,
    });
    trackers.push(tracker);
    const decision = tracker._getCompletionDecision({
      sample: makeSample({
        stopVisible: true,
        hasCopyAction: true,
        sendReady: false,
        text: 'final',
      }),
      text: 'final',
    });
    assert.equal(decision.domState, 'quiet');
    assert.equal(decision.uiTurnComplete, true);
    assert.equal(tracker._nextAction(decision).action, 'confirm');
  });
});

function FALLBACK_FLOOR(tracker) {
  return Math.max(tracker.fallbackQuietMs, tracker.quietWindowMs, tracker.completeSettleMs);
}
