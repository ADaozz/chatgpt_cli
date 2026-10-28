'use strict';

/**
 * model-selection.test.js — v2 模型策略：默认 = 菜单最新 + 最高强度；
 * 显式指定必须命中，不降级、不按 slug 版本号排序。
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ModelController, EFFORT_ALIASES } = require('../model-controller');

function makeController({ models, effort, current = { label: 'GPT-6 · 高', effort: 'high' } }) {
  const calls = { select: [], effort: [], closed: 0 };
  const ctl = new ModelController({ pageController: {} });
  ctl.listAvailable = async () => ({ models, effort });
  ctl.selectModelByIndex = async (i) => { calls.select.push(i); };
  ctl.setEffortPosition = async (p) => { calls.effort.push(p); };
  ctl.readCurrent = async () => current;
  ctl.closeMenu = async () => { calls.closed += 1; };
  return { ctl, calls };
}

const MODELS = [
  { label: 'GPT-6', selected: false },
  { label: 'GPT-5.6 Sol', selected: false },
];
const EFFORT = { position: 0, min: 0, max: 2 };

describe('default policy: latest model + highest effort', () => {
  it('selects the first menu model (newest first) and max effort', async () => {
    const { ctl, calls } = makeController({ models: MODELS, effort: EFFORT });
    const result = await ctl.applySelection({});
    assert.deepEqual(calls.select, [0]);
    assert.deepEqual(calls.effort, [2]);
    assert.equal(calls.closed, 1);
    assert.equal(result.effortPosition, 2);
    assert.equal(result.modelLabel, 'GPT-6'); // 模型名来自菜单，而非强度触发器文本
  });

  it('does not reselect when the newest model is already active', async () => {
    const models = [{ label: 'GPT-6', selected: true }, { label: 'GPT-5.6 Sol', selected: false }];
    const { ctl, calls } = makeController({ models, effort: EFFORT });
    await ctl.applySelection({});
    assert.deepEqual(calls.select, []);
    assert.deepEqual(calls.effort, [2]);
  });
});

describe('explicit selection', () => {
  it('matches model label case/spacing-insensitively', async () => {
    const { ctl, calls } = makeController({ models: MODELS, effort: EFFORT });
    await ctl.applySelection({ model: 'gpt 5.6 sol', effort: 'medium' });
    assert.deepEqual(calls.select, [1]);
    assert.deepEqual(calls.effort, [1]);
  });

  it('accepts effort aliases and numeric positions', async () => {
    assert.equal(EFFORT_ALIASES.high, 2);
    assert.equal(EFFORT_ALIASES.extended, 2);
    assert.equal(EFFORT_ALIASES.instant, 0);
    assert.equal(EFFORT_ALIASES['中'], 1);

    const { ctl, calls } = makeController({ models: MODELS, effort: EFFORT });
    await ctl.applySelection({ model: 'GPT-6', effort: 'instant' });
    assert.deepEqual(calls.effort, [0]);
    const second = makeController({ models: MODELS, effort: EFFORT });
    await second.ctl.applySelection({ model: 'GPT-6', effort: '1' });
    assert.deepEqual(second.calls.effort, [1]);
  });

  it('fails loudly for an unknown model (no downgrade)', async () => {
    const { ctl } = makeController({ models: MODELS, effort: EFFORT });
    await assert.rejects(
      () => ctl.applySelection({ model: 'GPT-9 Ultra' }),
      /模型不可用: GPT-9 Ultra.*GPT-6 \| GPT-5\.6 Sol/
    );
  });

  it('fails loudly when effort exceeds the account max (no downgrade)', async () => {
    const { ctl } = makeController({ models: MODELS, effort: EFFORT });
    await assert.rejects(
      () => ctl.applySelection({ model: 'GPT-6', effort: 'pro' }),
      /无效的思考强度/
    );
    await assert.rejects(
      () => ctl.applySelection({ model: 'GPT-6', effort: '3' }),
      /超出账号可用档位: 3 → 档位 3（当前账号最高 2）/
    );
  });
});
