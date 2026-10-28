'use strict';

/**
 * url-utils.test.js — URL/ID 解析（含 /c/local-chatgpt 占位过滤）
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractConversationId,
  isUsableConversationId,
  extractProjectId,
  extractProjectPath,
  normalizeProjectHomePath,
} = require('../url-utils');

describe('conversation ids', () => {
  it('extracts conversation id from chat URL', () => {
    assert.equal(
      extractConversationId('https://chatgpt.com/c/6ae18529-aa30-83e9-8a50-d0ebadfd0e35'),
      '6ae18529-aa30-83e9-8a50-d0ebadfd0e35'
    );
    assert.equal(
      extractConversationId('https://chatgpt.com/g/g-p-abc/c/6ae18529-aa30-83e9-8a50-d0ebadfd0e35'),
      '6ae18529-aa30-83e9-8a50-d0ebadfd0e35'
    );
  });

  it('rejects local placeholder ids', () => {
    assert.equal(isUsableConversationId('local-chatgpt'), false);
    assert.equal(isUsableConversationId('new'), false);
    assert.equal(isUsableConversationId(''), false);
    assert.equal(isUsableConversationId(null), false);
    assert.equal(isUsableConversationId('6ae18529-aa30-83e9-8a50-d0ebadfd0e35'), true);
  });
});

describe('project urls', () => {
  it('extracts gizmo id and home path', () => {
    const url = 'https://chatgpt.com/g/g-p-6aa25691c3408191ba27c50a0eccb9ae-slug/project';
    assert.equal(extractProjectId(url), 'g-p-6aa25691c3408191ba27c50a0eccb9ae');
    assert.equal(extractProjectPath(url), '/g/g-p-6aa25691c3408191ba27c50a0eccb9ae-slug/project');
    assert.equal(normalizeProjectHomePath('g-p-6aa25691c3408191ba27c50a0eccb9ae'), '/g/g-p-6aa25691c3408191ba27c50a0eccb9ae/project');
  });
});
