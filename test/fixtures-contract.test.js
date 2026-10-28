'use strict';

/**
 * fixtures-contract.test.js — PR01 契约测试
 *
 * 用脱敏 fixtures（test/fixtures/）验证：
 *   1. fixtures 与 docs/contracts/chatgpt-web-contract.md 记录的结构一致；
 *   2. selectors.js / conversation-completion.js 的关键假设仍被 fixture 支持；
 *   3. 脱敏规则未被破坏（无 token / 邮箱 / 账号 ID / 随机 UUID 残留）。
 * 全部为纯数据断言，不连接浏览器。
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../selectors');
const { parseConversationPayload, extractTurnCompletion } = require('../conversation-parser');

const FIXTURES = path.join(__dirname, 'fixtures');
const PLACEHOLDER_UUID = /^0{8}-0000-4000-8000-0{10}[0-9a-f]{2}$/;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

const MANIFEST = load('fixtures.manifest.json');
const FIXTURE_FILES = Object.keys(MANIFEST.fixtures);

describe('PR01 fixtures manifest', () => {
  it('declares capture metadata and sanitization rules', () => {
    assert.equal(MANIFEST.pr, 'PR01');
    assert.equal(MANIFEST.capturedAt, '2026-10-28');
    assert.ok(MANIFEST.sanitization.length >= 3);
    assert.ok(MANIFEST.observedEnv.chrome && MANIFEST.observedEnv.site);
  });

  it('references only existing fixture files', () => {
    for (const name of FIXTURE_FILES) {
      assert.ok(fs.existsSync(path.join(FIXTURES, name)), `${name} 不存在`);
    }
  });
});

describe('sanitization holds for every fixture', () => {
  for (const name of FIXTURE_FILES) {
    it(`${name} carries capture info and contains no sensitive data`, () => {
      const raw = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
      const data = JSON.parse(raw);
      assert.ok(data.capturedAt, '缺少 capturedAt');
      assert.ok(data.source, '缺少 source');

      assert.doesNotMatch(raw, /eyJ[A-Za-z0-9_-]{8,}\./, '疑似 JWT 残留');
      assert.doesNotMatch(raw, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, '疑似邮箱残留');
      assert.doesNotMatch(raw, /"accessToken"\s*:\s*"(?!<redacted>)/, 'accessToken 未脱敏');
      assert.doesNotMatch(raw, /Bearer\s+(?!<redacted>)[A-Za-z0-9._-]{10,}/, 'Bearer 未脱敏');
      assert.doesNotMatch(raw, /\b(?:user|org)-[A-Za-z0-9]{12,}\b/, '账号 ID 未脱敏');

      for (const match of raw.match(UUID_RE) || []) {
        assert.match(match, PLACEHOLDER_UUID, `随机 UUID 未脱敏: ${match}`);
      }
    });
  }
});

describe('composer contract (composer-dom.json)', () => {
  const fixture = load('composer-dom.json');

  it('matches the documented composer structure', () => {
    assert.equal(fixture.composer.tag, 'div');
    assert.equal(fixture.composer.role, 'textbox');
    assert.equal(fixture.composer.contenteditable, 'true');
    assert.equal(fixture.composer.id, null, '新版不再有 #prompt-textarea id');
    assert.equal(fixture.composer.testid, null, 'composer 无 data-testid');
    assert.ok(fixture.composer.cls.includes('ProseMirror'));
  });

  it('is addressable by selectors.js without legacy id fallback', () => {
    assert.ok(!S.composer.textbox.includes('#prompt-textarea'),
      'v2 明确删除 #prompt-textarea 兼容分支');
    assert.ok(S.composer.textbox.includes('[contenteditable="true"]'),
      '选择器应锚定 contenteditable textbox');
    assert.ok(S.composer.textbox.includes('data-chatgpt-composer'),
      '选择器应锚定 form[data-chatgpt-composer]');
    assert.ok(S.composer.sendBtn.includes('button[type="submit"]'),
      '发送按钮无 testid，需以 type=submit 锚定');
  });

  it('records the model trigger button by aria-label', () => {
    const labels = fixture.buttons.map((b) => b.ariaLabel);
    assert.ok(labels.includes('选择 ChatGPT 模型'));
    assert.ok(fixture.buttons.every((b) => !b.id || b.id.startsWith('radix-')),
      '按钮 id 均为 radix 动态值');
  });
});

describe('turn contract (turn-dom.json)', () => {
  const fixture = load('turn-dom.json');
  const turn = fixture.turn;

  it('marks completion on the whole-turn container', () => {
    assert.equal(turn.kids[0].kids[0]['data-talvt-turn-state'], 'complete');
    assert.ok(S.turn.state.includes('data-talvt-turn-state'));
  });

  it('labels user and assistant blocks with conversation roles', () => {
    const roles = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node['data-conversation-role']) roles.push(node['data-conversation-role']);
      for (const value of Object.values(node)) walk(value);
    };
    walk(turn);
    assert.ok(roles.includes('user') && roles.includes('assistant'), `roles=${roles}`);
  });

  it('records the copy action only as a weak signal (never completion authority)', () => {
    const inner = turn.kids[0].kids[0];
    const actionBar = (inner.kids || []).find((block) => block.actionBar)?.actionBar;
    assert.ok(actionBar, 'fixture 缺少 actionBar 块');
    const labels = actionBar.buttons.map((b) => b['aria-label']);
    assert.ok(labels.includes('复制'), `操作栏按钮: ${labels}`);
    assert.ok(S.response.turnActions.includes('aria-label="复制"'));
  });
});

describe('assistant content contract (assistant-content-dom.json)', () => {
  const fixture = load('assistant-content-dom.json');

  it('places final text in the assistant-message markdown style', () => {
    assert.equal(fixture.content.markdownRoot['data-markdown-text-style'], 'assistant-message');
    assert.ok(/tertiary/.test(fixture.content.markdownRoot.excludedTone),
      '必须记录 tertiary tone 排除规则（思考摘要）');
    assert.ok(S.response.markdownRoot.includes('data-markdown-text-style="assistant-message"'));
    assert.ok(S.response.thinkingTone.includes('data-markdown-text-tone="tertiary"'));
  });

  it('documents DIL stream-word splitting', () => {
    const words = fixture.content.dilRenderer.streamWords;
    assert.ok(words.length > 0 && words.every((w) => 'data-d-stream-word' in w));
  });
});

describe('model picker menu contract (model-picker-menu.json)', () => {
  const fixture = load('model-picker-menu.json');

  it('exposes the effort slider with aria value bounds', () => {
    for (const view of [fixture.flatView, fixture.simpleView, fixture.advancedView]) {
      const slider = (view.items || view.nodes || view.efforts).find((item) => item.role === 'slider');
      assert.ok(slider, '缺少 slider');
      assert.equal(slider.ariaMin ?? slider['ariaMin'], '0');
      assert.equal(slider.ariaMax ?? slider['ariaMax'], '2');
    }
  });

  it('marks the selected model with data-model-selected', () => {
    const items = [...fixture.flatView.items, ...fixture.simpleView.nodes];
    const selected = items.filter((item) =>
      (item.dataAttrs || []).includes('data-model-selected=true') || item.selected === 'true');
    assert.ok(selected.length >= 1);
    assert.ok(S.model.optionModels.includes('menuitemradio'));
  });

  it('keeps trigger effort attribute as restore signal', () => {
    assert.equal(fixture.trigger.observed.dataSelectedReasoningEffort, 'high');
    assert.ok(S.model.trigger.includes('data-codex-intelligence-trigger'));
  });
});

describe('model catalog contract (model-catalog.json)', () => {
  const fixture = load('model-catalog.json');

  it('keeps both observed catalog shapes', () => {
    assert.ok(fixture.modelsListShape.topKeys.includes('default_model_slug'));
    assert.ok(fixture.modelsListShape.topKeys.includes('model_picker_version'));
    assert.equal(fixture.pickerStateShape.picker_version, 2);
    assert.ok(fixture.pickerStateShape.versions.every((v) => Array.isArray(v.slugs)));
  });

  it('category defaults resolve to listed slugs', () => {
    const slugs = new Set(fixture.modelsListShape.models.map((m) => m.slug));
    for (const category of fixture.modelsListShape.categories) {
      assert.ok(slugs.has(category.default_model),
        `category ${category.cat} default_model ${category.default_model} 不在 models 列表`);
    }
  });

  it('documents that thinking slugs stay outside the catalog', () => {
    const slugs = fixture.modelsListShape.models.map((m) => m.slug);
    assert.ok(!slugs.includes('gpt-6-thinking'),
      '目录不含 thinking slug（该断言固定此契约事实）');
    assert.equal(load('conversation-api-plural.json').messageSample.lastAssistantMessage.metadata.model_slug,
      'gpt-6-thinking');
  });
});

describe('conversation API contract (conversation-api-plural.json)', () => {
  const fixture = load('conversation-api-plural.json');

  it('exposes the linearized plural endpoint shape', () => {
    for (const key of ['messages', 'current_node', 'page_info', 'async_status', 'default_model_slug']) {
      assert.ok(fixture.topKeys.includes(key), `顶层缺少 ${key}`);
    }
    assert.equal(fixture.shape.has_mapping_field, false, '复数端点无 mapping');
    assert.ok(fixture.shape.page_info.start_cursor && fixture.shape.page_info.end_cursor);
  });

  it('last assistant message carries final completion markers', () => {
    const msg = fixture.messageSample.lastAssistantMessage;
    assert.equal(msg.status, 'finished_successfully');
    assert.equal(msg.end_turn, true);
    assert.equal(msg.channel, 'final');
    assert.equal(msg.metadata.finish_details.type, 'stop');
    assert.equal(msg.metadata.is_complete, true);
    assert.equal(msg.metadata.thinking_effort, 'extended');
  });

  it('system messages are hidden scaffolding (weight 0)', () => {
    const system = fixture.messageSample.firstMessage;
    assert.equal(system.author.role, 'system');
    assert.equal(system.weight, 0);
    assert.equal(system.metadata.is_visually_hidden_from_conversation, true);
  });

  it('feeds conversation-parser.js with a valid completion state', () => {
    // 线性 messages 形态（复数端点真实结构）
    const first = fixture.messageSample.firstMessage;
    const last = fixture.messageSample.lastAssistantMessage;
    const payload = {
      conversation_id: fixture.shape.conversation_id,
      current_node: last.id,
      async_status: fixture.shape.async_status,
      messages: [first, last],
      page_info: { start_cursor: first.id, end_cursor: last.id, has_previous_page: false, has_next_page: false },
    };

    const parsed = parseConversationPayload(payload);
    assert.equal(parsed.shape, 'linear');
    assert.equal(parsed.completion.finalComplete, true);
    assert.equal(parsed.completion.turnComplete, true);
    assert.equal(parsed.partial, false);

    // 思考中的 turn 不得判定完成
    const thinkingPayload = structuredClone(payload);
    thinkingPayload.messages[1].metadata.reasoning_status = 'is_reasoning';
    assert.equal(parseConversationPayload(thinkingPayload).completion.turnComplete, false);

    // backend 进行中（数值 async_status 且无完成 final）不得判定完成
    const runningPayload = structuredClone(payload);
    runningPayload.async_status = 3;
    runningPayload.messages[1].end_turn = false;
    runningPayload.messages[1].channel = null;
    runningPayload.messages[1].status = 'in_progress';
    assert.equal(parseConversationPayload(runningPayload).completion.turnComplete, false);

    // 实机：完成后 async_status 可能持久非空（4），final 优先
    const postProcessPayload = structuredClone(payload);
    postProcessPayload.async_status = 4;
    assert.equal(parseConversationPayload(postProcessPayload).completion.turnComplete, true);

    // 缺少终态字段时：final 不存在 → 不得完成
    const openPayload = structuredClone(payload);
    openPayload.messages[1].end_turn = false;
    assert.equal(parseConversationPayload(openPayload).completion.turnComplete, false);

    // mapping 形态（列表项 / 旧端点）兼容
    const mappingPayload = {
      conversation_id: fixture.shape.conversation_id,
      current_node: 'node-last',
      async_status: fixture.shape.async_status,
      mapping: {
        'node-first': { message: first, parent: null },
        'node-last': { message: last, parent: 'node-first' },
      },
    };
    const mappingParsed = parseConversationPayload(mappingPayload);
    assert.equal(mappingParsed.shape, 'mapping');
    assert.equal(mappingParsed.completion.turnComplete, true);

    // 分页：has_previous_page=true → partial
    const paged = structuredClone(payload);
    paged.page_info.has_previous_page = true;
    assert.equal(parseConversationPayload(paged).partial, true);
    assert.equal(typeof extractTurnCompletion, 'function');
  });
});

describe('send request contract (f-conversation-request.json)', () => {
  const fixture = load('f-conversation-request.json');
  const body = fixture.request.bodyTemplate;

  it('matches the captured f/conversation body template', () => {
    assert.equal(fixture.request.method, 'POST');
    assert.ok(fixture.request.url.endsWith('/backend-api/f/conversation'));
    assert.equal(fixture.request.responseMimeType, 'text/event-stream');
    assert.equal(body.action, 'next');
    assert.equal(body.parent_message_id, 'client-created-root');
    // v2 契约：model 是页面原生字段，CLI 不得改写（模型只经菜单选择）
    assert.ok(body.model, '页面原生请求必须包含 model');
    assert.equal(typeof body.thinking_effort, 'string', '页面原生请求应包含 thinking_effort（观测值）');
    assert.ok(body.supported_encodings.includes('v1'));
  });

  it('carries a user text message with client-generated id', () => {
    const [message] = body.messages;
    assert.equal(message.author.role, 'user');
    assert.equal(message.content.content_type, 'text');
    assert.match(message.id, PLACEHOLDER_UUID);
    assert.equal(message.metadata.automation_creation_attribution.flow_id, message.id);
  });

  it('records headers without values', () => {
    assert.ok(fixture.request.headerNamesObserved.some((h) => h.startsWith('authorization')));
    assert.ok(!('authorization' in (fixture.request.headers || {})));
  });
});

describe('gizmo contract (gizmo-config.json)', () => {
  const fixture = load('gizmo-config.json');

  it('matches the gizmo endpoint shape', () => {
    for (const key of ['gizmo', 'tools', 'files', 'product_features', 'project_file_limits']) {
      assert.ok(fixture.topKeys.includes(key), `顶层缺少 ${key}`);
    }
  });

  it('lists project files with size and type', () => {
    assert.ok(Array.isArray(fixture.files) && fixture.files.length >= 1);
    for (const file of fixture.files) {
      assert.ok(file.name && typeof file.size === 'number' && file.type);
      assert.match(file.id, /^file-redacted/);
    }
  });

  it('keeps the g-p- project id format after redaction', () => {
    assert.match(fixture.gizmoShape.id, /^g-p-redacted0+$/);
  });
});
