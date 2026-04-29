/**
 * selectors.js — 所有 ChatGPT DOM 选择器的唯一真相来源
 *
 * 收敛机制：ChatGPT 改版时，只改这一个文件。
 * 所有选择器按 UI 区域分组，不按功能分组 —— 因为改版是按区域发生的。
 *
 * 验证日期：2026-03-11（基于真实 DOM 探测）
 */

const S = {
  // ── Sidebar / Navigation ──────────────────────────────────────────────────
  sidebar: {
    // "New chat" 按钮（注意：此按钮导航到 /，会离开项目上下文）
    newChatBtn: '[data-testid="create-new-chat-button"]',
  },

  // ── Project File Panel ────────────────────────────────────────────────────
  files: {
    // "Add files and more" 按钮（composer 旁边的 + 号）
    addFilesBtn: '[data-testid="composer-plus-btn"]',
    // 项目设置/文件面板触发按钮
    projectModalTrigger: '[data-testid="project-modal-trigger"]',
    // 隐藏的 file input
    fileInput: 'input[type="file"]',
  },

  // ── Conversation / Message Input ─────────────────────────────────────────
  composer: {
    // 主输入框（ProseMirror contenteditable div）
    textarea: '#prompt-textarea',
    // 发送按钮（仅在输入文字后出现）
    sendBtn: '[data-testid="send-button"]',
    // 停止生成按钮（流式过程中存在）
    stopBtn: '[data-testid="stop-button"]',
  },

  // ── Model Picker ──────────────────────────────────────────────────────────
  model: {
    // 已知模型切换器入口；不同版本可能命名不同
    trigger:
      '[data-testid="model-switcher-dropdown-button"], ' +
      '[data-testid="model-switcher-popover-button"]',
    // 下拉/弹层中的候选项
    options:
      '[role="menuitem"], [role="option"], [cmdk-item], ' +
      '[data-testid*="model-switcher"] button, [data-testid*="model-switcher"] [role="button"]',
  },

  // ── Response / Output ─────────────────────────────────────────────────────
  response: {
    // 当前对话中的所有消息
    allMessages: '[data-message-author-role]',
    // 所有 assistant 消息容器（<div>，在 <article> 内部）
    assistantMsgs: '[data-message-author-role="assistant"]',
    // 所有 assistant turn 容器（<article>）
    assistantTurns: 'article[data-turn="assistant"]',
    // 消息内的 markdown 内容区
    messageContent: '.markdown',
  },
};

module.exports = S;
