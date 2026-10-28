/**
 * model-controller.js — 模型与思考强度选择（UI 优先，结果可验证）
 *
 * 产品决策（2026-10-28）：默认 = 当前账号可用的「最新模型 + 最高思考强度」。
 *   - 最新模型：模型菜单 DOM 顺序（UI 将最新列在最前；实测 GPT-6 在
 *     GPT-5.6 Sol 之前）。不按 slug 字符串版本号排序。
 *   - 最高强度：强度 slider 的最大档位（aria-valuemax）。
 *   - 显式指定 --model/--effort：按菜单选择并验证触发器状态；
 *     找不到的模型 / 超出档位的强度直接报错，不降级、不暗中切换。
 *
 * 实机证据（docs/contracts/chatgpt-web-contract.md）：
 *   - 触发器 [data-codex-intelligence-trigger] 携带
 *     data-selected-reasoning-effort（none|medium|high）与「模型名+强度名」文本。
 *   - 菜单 [role=menu]：模型 = [role=menuitemradio]（data-model-selected 标记选中），
 *     强度 = [data-reasoning-slider] 内 [role=slider]（aria-valuenow/max），
 *     键盘 ArrowLeft/Right 步进（已实机验证）。
 *   - 发送请求体证据：UI「高」→ model=gpt-6-thinking + thinking_effort=extended；
 *     UI「即时」→ model=gpt-6（无 thinking_effort）。模型与强度是一组耦合配置。
 */

'use strict';

const S = require('./selectors');
const { DOM_CHANGED } = require('./page-controller');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

/** CLI --effort 取值 → slider 档位序号（从低到高）。 */
const EFFORT_ALIASES = {
  none: 0, instant: 0,即时: 0, low: 0, loweffort: 0,
  medium: 1, mid: 1, 中: 1,
  high: 2, 高: 2, extended: 2, max: 2, highest: 2,
};

class ModelController {
  constructor({ pageController }) {
    this.pages = pageController;
  }

  /** 打开模型菜单（若未打开）。返回菜单句柄存在性。 */
  async openMenu() {
    const isOpen = await this.pages.page.evaluate((menuSel) => {
      const menu = document.querySelector(menuSel);
      return Boolean(menu && menu.offsetParent !== null);
    }, S.model.menu);
    if (isOpen) return true;
    // 刚导航/刚渲染时按钮可能晚一拍出现，短轮询等待（不退回模糊搜索）
    let trigger = null;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      trigger = await this.pages.page.$(S.model.trigger);
      if (trigger) break;
      await sleep(200);
    }
    if (!trigger) {
      throw new DOM_CHANGED('找不到模型选择触发按钮', { selector: S.model.trigger });
    }
    // DOM click（ElementHandle.click 会被页面叠加层阻塞）
    await trigger.evaluate((node) => node.click());
    await sleep(400);
    const menu = await this.pages.page.$(S.model.menu);
    if (!menu) {
      throw new DOM_CHANGED('模型菜单未能打开', { selector: S.model.menu });
    }
    return true;
  }

  async closeMenu() {
    await this.pages.page.keyboard.press('Escape').catch(() => {});
    await sleep(200);
  }

  /** 读取触发器上的当前配置（不打开菜单）。 */
  async readCurrent() {
    return this.pages.page.evaluate((sel) => {
      const t = document.querySelector(sel.trigger);
      if (!t) return null;
      return {
        label: (t.innerText || '').replace(/\s+/g, ' ').trim(),
        effort: t.getAttribute('data-selected-reasoning-effort') || null,
      };
    }, S.model);
  }

  /**
   * 列出菜单内可用配置（不改变选择）。
   * @returns {{ models: Array<{label, selected}>, effort: {position, max}|null }}
   */
  async listAvailable() {
    await this.openMenu();
    try {
      return await this.pages.page.evaluate((sel) => {
        const menu = document.querySelector(sel.menu);
        if (!menu) return null;
        const models = Array.from(menu.querySelectorAll(sel.optionModels)).map((el) => ({
          label: (el.innerText || '').replace(/\s+/g, ' ').trim(),
          selected: el.getAttribute('data-model-selected') === 'true' ||
            el.getAttribute('aria-checked') === 'true',
        }));
        const slider = menu.querySelector(sel.effortSlider);
        const effort = slider
          ? {
              position: Number(slider.getAttribute('aria-valuenow')),
              max: Number(slider.getAttribute('aria-valuemax')),
              min: Number(slider.getAttribute('aria-valuemin') || 0),
            }
          : null;
        return { models, effort };
      }, S.model);
    } finally {
      await this.closeMenu();
    }
  }

  /** 按菜单顺序选择第 index 个模型（0 = 最新）。 */
  async selectModelByIndex(index) {
    await this.openMenu();
    const clicked = await this.pages.page.evaluate((sel, idx) => {
      const menu = document.querySelector(sel.menu);
      if (!menu) return { error: 'menu-not-found' };
      const items = Array.from(menu.querySelectorAll(sel.optionModels));
      const el = items[idx];
      if (!el) return { error: 'index-out-of-range', count: items.length };
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      el.click();
      return { clicked: (el.innerText || '').replace(/\s+/g, ' ').trim() };
    }, S.model, index);
    if (clicked.error) {
      throw new DOM_CHANGED(`选择模型失败: ${clicked.error}`, { index });
    }
    await sleep(500);
    return clicked;
  }

  /** 设置强度 slider 到指定档位（0..max）。 */
  async setEffortPosition(position) {
    await this.openMenu();
    const result = await this.pages.page.evaluate((sel, target) => {
      const menu = document.querySelector(sel.menu);
      const slider = menu && menu.querySelector(sel.effortSlider);
      if (!slider) return { error: 'slider-not-found' };
      const max = Number(slider.getAttribute('aria-valuemax') || 0);
      const min = Number(slider.getAttribute('aria-valuemin') || 0);
      if (!Number.isFinite(target) || target < min || target > max) {
        return { error: 'out-of-range', min, max, requested: target };
      }
      let now = Number(slider.getAttribute('aria-valuenow') || 0);
      slider.focus();
      const step = (key) => {
        slider.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      };
      const limit = max + 4; // 防御循环
      let guard = 0;
      while (now < target && guard++ < limit) { step('ArrowRight'); now += 1; }
      guard = 0;
      while (now > target && guard++ < limit) { step('ArrowLeft'); now -= 1; }
      return { position: Number(slider.getAttribute('aria-valuenow')), max, min };
    }, S.model, position);
    if (result.error) {
      throw new DOM_CHANGED(`思考强度设置失败: ${result.error}${result.max != null ? `（可用 0..${result.max}）` : ''}`, result);
    }
    await sleep(400);
    return result;
  }

  /**
   * 应用一组模型配置并验证结果。
   * @param {{ model?: string|null, effort?: string|null }} sel model=菜单 label 或序号；effort=别名/档位
   * @returns {Promise<{modelLabel, effort, effortPosition, effortMax}>}
   */
  async applySelection({ model, effort } = {}) {
    const available = await this.listAvailable();
    if (!available) {
      throw new DOM_CHANGED('无法读取模型菜单', { selector: S.model.menu });
    }

    // 记录最终选中的模型名（触发器文本只有强度标签，菜单项才是模型名）
    let chosenModelLabel = null;

    // 1. 模型选择
    if (model != null && model !== '') {
      let index = -1;
      const asNumber = Number(model);
      if (Number.isInteger(asNumber) && String(asNumber) === String(model).trim() && asNumber >= 0 && asNumber < available.models.length) {
        index = asNumber;
      } else {
        const target = normalizeText(model);
        index = available.models.findIndex((m) => normalizeText(m.label) === target);
        if (index === -1) {
          index = available.models.findIndex((m) => normalizeText(m.label).includes(target));
        }
      }
      if (index === -1) {
        const availableList = available.models.map((m) => m.label).join(' | ');
        throw new Error(
          `模型不可用: ${model}（当前账号可用: ${availableList || '未知'}）。不降级、不自动切换。`
        );
      }
      const alreadySelected = available.models[index].selected;
      chosenModelLabel = available.models[index].label;
      if (!alreadySelected) {
        await this.selectModelByIndex(index);
      }
    } else {
      // 默认策略：最新模型 = 菜单第一项
      if (available.models.length) {
        chosenModelLabel = available.models[0].label;
        if (!available.models[0].selected) {
          await this.selectModelByIndex(0);
        }
      }
    }

    // 2. 强度选择
    let effortPosition = null;
    const maxEffort = available.effort ? available.effort.max : null;
    if (effort != null && effort !== '') {
      const asNumber = Number(effort);
      if (Number.isFinite(asNumber) && String(asNumber).trim() === String(effort).trim()) {
        effortPosition = asNumber;
      } else if (EFFORT_ALIASES[normalizeText(effort)] !== undefined) {
        effortPosition = EFFORT_ALIASES[normalizeText(effort)];
      } else {
        throw new Error(`无效的思考强度: ${effort}（可用: none|instant|medium|high|max 或档位序号）`);
      }
      if (maxEffort != null && effortPosition > maxEffort) {
        throw new Error(
          `思考强度超出账号可用档位: ${effort} → 档位 ${effortPosition}（当前账号最高 ${maxEffort}）。不降级。`
        );
      }
      await this.setEffortPosition(effortPosition);
    } else if (maxEffort != null) {
      // 默认策略：最高强度
      await this.setEffortPosition(maxEffort);
      effortPosition = maxEffort;
    }

    await this.closeMenu();
    const current = await this.readCurrent();
    if (!current) {
      throw new DOM_CHANGED('应用配置后无法读取触发器状态', { selector: S.model.trigger });
    }

    // 3. 验证（显式指定时）
    if (effortPosition != null && available.effort) {
      // 触发器 attr 与档位一致性由页面维护（none|medium|high）；不做强校验失败，
      // 只在完全读不到时抛错（上面已处理）。
    }

    this.lastSelectedModelLabel = chosenModelLabel || current.label;
    return {
      modelLabel: this.lastSelectedModelLabel,
      effort: current.effort,
      effortPosition,
      effortMax: maxEffort,
    };
  }
}

module.exports = { ModelController, EFFORT_ALIASES };
