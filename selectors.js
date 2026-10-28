/**
 * selectors.js — ChatGPT DOM 选择器的唯一真相来源
 *
 * 所有选择器必须来自真实页面采集（scripts/probe-chatgpt.js），
 * 每条标注验证日期与来源。没有实机证据的选择器不得进入本文件；
 * 无法确认的能力在调用侧显式返回 DOM_CHANGED / unsupported，
 * 禁止模糊按钮搜索、Enter 盲发或旧选择器回退。
 *
 * 采集环境：2026-10-28 · Chrome 155 · chatgpt.com（zh-CN 账号）
 * 契约详情：docs/contracts/chatgpt-web-contract.md
 *
 * 注意：本页面几乎不使用 data-testid（整页仅 2 个），且 aria-label
 * 随界面语言本地化。选择器优先使用结构性语义标记（data-* 属性、
 * role、表单结构），仅在无结构标记时使用 aria-label 并标注语言风险。
 */

const S = {
  // ── Composer（消息输入区）──────────────────────────────────────────────────
  // 证据 2026-10-28：ProseMirror contenteditable，无 #prompt-textarea、无 testid。
  // aria-label 随上下文/语言变化（「询问 ChatGPT」/「开始写作」），不可依赖。
  composer: {
    // 输入框本体（ProseMirror 富文本编辑器）
    textbox: 'form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]',
    // 无输入框时的兜底（项目页等场景 form 可能在晚一拍渲染）
    textboxLoose: '[contenteditable="true"][role="textbox"].ProseMirror',
    // 发送按钮：仅在输入框有内容时出现；无 testid，用 type=submit 锚定
    sendBtn: 'form[data-chatgpt-composer] button[type="submit"]',
    // 停止生成：流式期间出现在 composer 按钮区，aria-label 本地化（zh:「停止」en:「Stop」）
    // 仅作 DOM 响应中启发信号，绝不作为完成判定依据（完成判定以协议为准）。
    stopBtn:
      'form[data-chatgpt-composer] button[aria-label="停止"], ' +
      'form[data-chatgpt-composer] button[aria-label="Stop"], ' +
      'form[data-chatgpt-composer] button[aria-label="停止生成"], ' +
      'form[data-chatgpt-composer] button[aria-label="Stop streaming"]',
    // 隐藏 file input（附件上传）
    fileInput: 'input[type="file"]',
  },

  // ── Turn（一轮对话容器：用户问题 + 思考 + 回复）────────────────────────────
  // 证据 2026-10-28：一轮 = div[data-turn-key="{userMessageId}"]，
  // 内部含 data-talvt-turn-state（in_progress | complete）。
  // 旧版 article/section[data-turn] 与 data-message-author-role 已消失。
  turn: {
    containers: '[data-turn-key]',
    state: '[data-talvt-turn-state]',
    // 状态值：in_progress（生成中，含 thinking）| complete（已结束）。
    // 其他取值（如取消/失败）尚未实机捕获，标记 probe-pending：
    // 遇到未知值一律按「未完成」处理，不得当作完成信号。
    knownStates: ['in_progress', 'complete'],
  },

  // ── Response（消息内容区）──────────────────────────────────────────────────
  // 证据 2026-10-28：assistant 内容在
  //   div[data-chatgpt-search-unit-key$=":assistant"] 内，
  //   markdown 根 = [data-markdown-text-style="assistant-message"]；
  //   消息 id 列表在 data-chatgpt-search-message-ids；
  //   角色标题 h4[data-conversation-role="user"|"assistant"]。
  // Genui/Intelligent UI 渲染层使用 data-d-component / data-d-text-flow 标记。
  response: {
    assistantUnits: '[data-chatgpt-search-unit-key$=":assistant"]',
    userBubbles: '[data-user-message-bubble]',
    roleHeaders: '[data-conversation-role]',
    markdownRoot: '[data-markdown-text-style="assistant-message"]',
    // 思考过程摘要（弱信号，可能与最终回复同根；tone=tertiary 证据 probe-pending）
    thinkingTone: '[data-markdown-text-style="assistant-message"][data-markdown-text-tone="tertiary"]',
    // 最后一轮 assistant 操作栏（复制按钮 aria-label 本地化，仅辅助判定）
    turnActions: 'button[aria-label="复制"], button[aria-label="Copy"]',
  },

  // ── Model Picker（模型 + 思考强度）─────────────────────────────────────────
  // 证据 2026-10-28：触发按钮 data-codex-intelligence-trigger，携带
  //   data-selected-reasoning-effort（none|medium|high，账号相关），
  //   按钮文本 = 模型名 + 当前强度名（本地化）。
  model: {
    trigger: '[data-codex-intelligence-trigger]',
    // Radix 弹层内的菜单容器
    menu: '[data-radix-popper-content-wrapper] [role="menu"]',
    // 模型候选项
    optionModels: '[data-radix-popper-content-wrapper] [role="menuitemradio"]',
    // 选中的模型项
    modelSelected: '[data-model-selected="true"]',
    // 思考强度 slider（aria-valuemin/valuenow/valuemax；步进枚举强度档位）
    effortSliderItem: '[data-reasoning-slider]',
    effortSlider: '[data-reasoning-slider] [role="slider"]',
    // 当前强度可读状态（「高，第 3 项，共 3 项。」）
    effortStatus: '[data-radix-popper-content-wrapper] [role="status"]',
  },

  // ── Project / Sidebar ────────────────────────────────────────────────────────
  // 证据 2026-10-28：项目会话链接形如 /g/g-p-{hex}-slug/c/{id}，
  // 项目主页 /g/{gizmoId}-{slug}/project。侧栏无稳定 testid。
  project: {
    sidebarLinks: 'a[href*="/g/g-p-"]',
    fileInput: 'input[type="file"]',
  },
};

module.exports = S;
