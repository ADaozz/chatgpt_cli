'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const { pickBestModelSlug } = require('../adapter');

const best = (...slugs) => pickBestModelSlug({
  models: slugs.map((slug) => ({ slug })),
});

it('selects GPT-6 Thinking over GPT-5.6 Thinking', () => {
  assert.equal(best('gpt-5-6-thinking', 'gpt-6', 'gpt-6-instant', 'gpt-6-thinking'), 'gpt-6-thinking');
});

it('treats a missing minor version as zero', () => {
  assert.equal(best('gpt-6-thinking', 'gpt-6-0-thinking'), 'gpt-6-thinking');
  assert.equal(best('gpt-6-0-thinking', 'gpt-6-thinking'), 'gpt-6-0-thinking');
  assert.equal(best('gpt-6-thinking', 'gpt-6-1-instant'), 'gpt-6-1-instant');
});

it('compares major versions before minor versions and numeric minors before lanes', () => {
  assert.equal(best('gpt-5-100-thinking', 'gpt-6-thinking'), 'gpt-6-thinking');
  assert.equal(best('gpt-6-9-thinking', 'gpt-6-10-instant'), 'gpt-6-10-instant');
});

it('preserves the original model slug and catalog default fallback', () => {
  assert.equal(best('gpt-6'), 'gpt-6');
  assert.equal(pickBestModelSlug({ models: [], default_model_slug: 'gpt-6' }), 'gpt-6');
});
