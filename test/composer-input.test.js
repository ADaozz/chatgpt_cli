'use strict';

/**
 * composer-input.test.js — composer 写入/回读校验（回归：换行与 URL 导致的误判、兜底重复写入）
 *
 * 实机缺陷（2026-10-28）：
 * 1. 回读用 innerText 与输入逐字比较。ProseMirror 把每个段落渲染成独立节点，
 *    输入 "a\nb" 回读为 "a\n\nb"；行内 URL 转链接还会额外引入换行，
 *    于是任何多行或含链接的消息都被判成「页面只接受了部分文本」而无法发送。
 * 2. 兜底分支直接用 keyboard.sendCharacter 追加写入，未先清空 composer，
 *    失败后残留内容翻倍，反而永不通过校验。
 *
 * 这里用桩替代 DOM 层，验证编排逻辑；真实 DOM 行为由实机 smoke 覆盖。
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PageController, DOM_CHANGED, normalizeComposerText } = require('../page-controller');

/**
 * 构造被测控制器：只替换 DOM 相关私有方法，保留 typeIntoComposer 的真实编排逻辑。
 * insert/append 由用例注入，模拟页面真实写入行为。
 */
function makeController(state, { insert, append }) {
  const page = {
    keyboard: {
      sendCharacter: async (value) => {
        state.sendCharacterCalls += 1;
        append(value);
      },
    },
  };
  const controller = new PageController(page);
  controller._composerHandle = async () => ({ evaluate: async () => {} });
  controller._insertComposerText = async (_el, value) => insert(value);
  controller._clearComposerElement = async () => {
    state.text = '';
  };
  controller._readComposerText = async () => state.text;
  return controller;
}

const newState = () => ({ text: '', sendCharacterCalls: 0 });

describe('normalizeComposerText', () => {
  it('treats ProseMirror paragraph splits as equivalent', () => {
    assert.equal(normalizeComposerText('a\nb'), normalizeComposerText('a\n\nb'));
    assert.equal(normalizeComposerText('a\n\n\nb'), normalizeComposerText('a b'));
  });

  it('treats URL-induced line breaks as equivalent', () => {
    const input = '见 https://example.com/x 这';
    const readBack = '见 \nhttps://example.com/x 这';
    assert.equal(normalizeComposerText(readBack), normalizeComposerText(input));
  });

  it('drops zero-width characters and collapses nbsp', () => {
    assert.equal(normalizeComposerText('a\u200bb'), 'ab');
    assert.equal(normalizeComposerText('a\u00a0b'), 'a b');
    assert.equal(normalizeComposerText('  a\t\tb  '), 'a b');
  });

  it('keeps visible differences visible', () => {
    assert.notEqual(normalizeComposerText('abcdef'), normalizeComposerText('abc'));
    assert.notEqual(normalizeComposerText('abc'), normalizeComposerText('abd'));
  });

  it('handles empty input', () => {
    assert.equal(normalizeComposerText(''), '');
    assert.equal(normalizeComposerText(null), '');
    assert.equal(normalizeComposerText(undefined), '');
  });
});

describe('typeIntoComposer', () => {
  it('accepts a read-back that differs only in whitespace', async () => {
    const state = newState();
    const controller = makeController(state, {
      // 模拟 ProseMirror：段落分隔被渲染成额外换行
      insert: (value) => { state.text = value.replace(/\n/g, '\n\n'); },
      append: (value) => { state.text += value; },
    });

    await controller.typeIntoComposer('第一行\n第二行\n\nhttps://example.com/x');

    assert.equal(state.sendCharacterCalls, 0, '不应走到兜底写入');
    assert.equal(state.text, '第一行\n\n第二行\n\n\n\nhttps://example.com/x');
  });

  it('clears the composer before the fallback write (no duplicated text)', async () => {
    const state = newState();
    const value = '一条需要完整写入的长消息';
    const controller = makeController(state, {
      insert: (text) => { state.text = text.slice(0, 3); }, // 首次写入只落了一部分
      append: (text) => { state.text += text; },            // sendCharacter 是追加语义
    });

    await controller.typeIntoComposer(value);

    assert.equal(state.sendCharacterCalls, 1);
    assert.equal(state.text, value, '兜底前必须清空，否则内容重复');
  });

  it('still fails loudly when the page drops text in both paths', async () => {
    const state = newState();
    const controller = makeController(state, {
      insert: (text) => { state.text = text.slice(0, 3); },
      append: (text) => { state.text = text.slice(0, 2); },
    });

    await assert.rejects(
      () => controller.typeIntoComposer('一条写到页面上的消息'),
      (error) => {
        assert.ok(error instanceof DOM_CHANGED);
        assert.equal(error.code, 'DOM_CHANGED');
        assert.equal(error.details.expectedLength, 10);
        assert.equal(error.details.actualLength, 2);
        return true;
      }
    );
  });
});
