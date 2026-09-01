/**
 * session.js — 会话状态管理
 *
 * 集中持有 CLI 运行期间的所有可变状态：
 *   - 连接（ChatGPTClient）
 *   - 当前项目（Project）
 *   - 当前对话（Conversation）
 *   - 当前模型名
 *
 * 不做 I/O，只做状态读写 + 状态摘要。
 */

class Session {
  constructor() {
    this.browserURL = null;
    this.client = null;
    this.project = null;
    this.projectName = null;
    this.conversation = null;
    this.conversationId = null;
    this.modelName = null;
    this.modelSlug = null;
  }

  get connected() {
    return Boolean(this.client);
  }

  get hasProject() {
    return Boolean(this.project);
  }

  get hasConversation() {
    return Boolean(this.conversation);
  }

  setClient(client, browserURL) {
    this.client = client;
    this.browserURL = browserURL;
  }

  setProject(project, name) {
    this.project = project;
    this.projectName = name;
    this.conversation = null;
    this.conversationId = null;
  }

  setConversation(conversation) {
    this.conversation = conversation;
    this.conversationId = conversation?.id || null;
  }

  setModel(name, slug = null) {
    this.modelName = name;
    this.modelSlug = slug;
  }

  clearConversation() {
    this.conversation = null;
    this.conversationId = null;
  }

  clearProject() {
    this.project = null;
    this.projectName = null;
    this.conversation = null;
    this.conversationId = null;
  }

  disconnect() {
    this.client = null;
    this.browserURL = null;
    this.project = null;
    this.projectName = null;
    this.conversation = null;
    this.conversationId = null;
    this.modelName = null;
    this.modelSlug = null;
  }

  summary() {
    const parts = [];
    if (this.connected) {
      parts.push(this.browserURL);
    } else {
      parts.push('disconnected');
    }
    if (this.modelName) parts.push(this.modelName);
    if (this.projectName) parts.push(this.projectName);
    if (this.conversationId) parts.push(`conv:${this.conversationId.slice(0, 8)}`);
    return parts;
  }
}

module.exports = Session;
