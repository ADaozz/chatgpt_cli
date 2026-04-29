/**
 * client.js — 公开 API 层（用户唯一需要 require 的文件）
 *
 * 架构约束：
 *   - 所有方法返回 Promise，调用方用 async/await
 *   - `page` 对象永远不泄漏到这一层之外
 *   - 新功能必须以 Project 或 Conversation 为载体挂载
 *
 * 收敛机制：
 *   - Project 是 Conversation 的工厂，依赖方向不可反转
 *   - ChatGPTClient 是 Project 的工厂，同上
 */

const { connect } = require('./browser');
const adapter = require('./adapter');
const path = require('path');
const fs = require('fs');

function isTextLikeMime(mimeType = '') {
  return /^(text\/|application\/(json|xml|javascript)|image\/svg\+xml)/i.test(
    String(mimeType)
  );
}

function isTextLikeName(name = '') {
  return /\.(txt|md|json|csv|xml|ya?ml|js|ts|py|html|css|svg|log)$/i.test(
    String(name)
  );
}

function readLocalFileContent(absPath, uploaded = {}) {
  const fileName = uploaded.fileName || path.basename(absPath);
  const mimeType = uploaded.mimeType || '';
  if (!isTextLikeMime(mimeType) && !isTextLikeName(fileName)) {
    return null;
  }

  const content = fs.readFileSync(absPath, 'utf8');
  return content.length <= 100_000
    ? content
    : `${content.slice(0, 100_000)}\n\n...[truncated]`;
}

function buildKnownFileRecord(uploaded, absPath) {
  const fileName = uploaded.fileName || path.basename(absPath);
  return {
    id: uploaded.fileId || null,
    name: fileName,
    mimeType: uploaded.mimeType || null,
    size: uploaded.fileSize || null,
    url: null,
    content: readLocalFileContent(absPath, {
      fileName,
      mimeType: uploaded.mimeType || null,
    }),
  };
}

function fileCacheKey(file) {
  return `${file?.id || ''}|${file?.name || ''}`;
}

function mergeKnownFilesIntoSnapshot(snapshot, knownFiles) {
  if (!knownFiles || !knownFiles.size) return snapshot;

  const byName = new Map();
  for (const file of knownFiles.values()) {
    if (file.name) byName.set(file.name, file);
  }

  const enrich = (file) => {
    const known =
      (file.id && knownFiles.get(`${file.id}|${file.name || ''}`)) ||
      (file.name && byName.get(file.name)) ||
      null;

    if (!known) return file;

    return {
      ...file,
      mimeType: file.mimeType || known.mimeType || null,
      size: file.size ?? known.size ?? null,
      content: file.content || known.content || null,
    };
  };

  snapshot.messages = (snapshot.messages || []).map((message) => ({
    ...message,
    files: (message.files || []).map(enrich),
  }));

  const mergedFiles = new Map();
  for (const file of (snapshot.files || []).map(enrich)) {
    mergedFiles.set(fileCacheKey(file), file);
  }
  for (const file of knownFiles.values()) {
    const existing = mergedFiles.get(fileCacheKey(file));
    mergedFiles.set(
      fileCacheKey(file),
      existing
        ? {
            ...existing,
            mimeType: existing.mimeType || file.mimeType || null,
            size: existing.size ?? file.size ?? null,
            content: existing.content || file.content || null,
          }
        : file
    );
  }

  snapshot.files = Array.from(mergedFiles.values());
  return snapshot;
}

// ── Conversation ──────────────────────────────────────────────────────────────

class Conversation {
  /**
   * @param {Page} page
   * @param {string} id         conversation id
   * @param {string|null} projectId  项目 hex ID（用于构建正确的 URL）
   * @param {string|null} projectPath 项目页面路径（优先用于构建项目对话 URL）
   */
  constructor(page, id, projectId, projectPath, knownFiles = []) {
    this._page = page;
    this.id = id;
    this._projectId = projectId || null;
    this._projectPath = projectPath || null;
    this._knownFiles = new Map();
    this._rememberFiles(knownFiles);
  }

  _rememberFiles(files) {
    for (const file of files || []) {
      this._knownFiles.set(fileCacheKey(file), file);
    }
  }

  /**
   * 发送消息，等待回复完全生成后返回。
   * @param {string} message
   * @returns {Promise<string>} 完整的 assistant 回复文本
   */
  async send(message) {
    await adapter.navigateToConversation(
      this._page,
      this.id,
      this._projectPath || this._projectId
    );
    return adapter.sendMessage(this._page, message);
  }

  /**
   * 在当前对话中切换模型。
   * @param {string} modelName
   * @returns {Promise<string>} 实际选中的模型文案
   */
  async selectModel(modelName) {
    await adapter.navigateToConversation(
      this._page,
      this.id,
      this._projectPath || this._projectId
    );
    return adapter.selectModel(this._page, modelName);
  }

  /**
   * 发送消息并附带文件。
   * @param {string} message          消息文本
   * @param {string[]} filePaths      本地文件路径数组
   * @returns {Promise<string>}       assistant 回复文本
   */
  async sendWithFiles(message, filePaths) {
    await adapter.navigateToConversation(
      this._page,
      this.id,
      this._projectPath || this._projectId
    );
    const attachments = [];
    const knownFiles = [];
    for (const fp of filePaths) {
      const abs = path.resolve(fp);
      const uploaded = await adapter.apiUploadConversationAttachment(
        this._page,
        abs
      );
      attachments.push(uploaded);
      knownFiles.push(buildKnownFileRecord(uploaded, abs));
    }
    this._rememberFiles(knownFiles);
    return adapter.sendMessageWithFiles(this._page, message, attachments);
  }

  /**
   * 发送消息，等待回复完成后返回回复和完整对话快照。
   * @param {string} message
   * @returns {Promise<{ reply: string, snapshot: object }>}
   */
  async sendAndGetSnapshot(message) {
    const reply = await this.send(message);
    const snapshot = await this.getSnapshot();
    return { reply, snapshot };
  }

  /**
   * 发送消息并附带文件，等待回复完成后返回回复和完整对话快照。
   * @param {string} message
   * @param {string[]} filePaths
   * @returns {Promise<{ reply: string, snapshot: object }>}
   */
  async sendWithFilesAndGetSnapshot(message, filePaths) {
    const reply = await this.sendWithFiles(message, filePaths);
    const snapshot = await this.getSnapshot();
    return { reply, snapshot };
  }

  /**
   * 获取当前对话的运行状态。
   * @returns {Promise<{ conversationId: string|null, url: string, state: string, isResponding: boolean, messageCount: number, assistantMessageCount: number, lastMessageRole: string|null, lastAssistantText: string, checkedAt: string }>}
   */
  async getStatus() {
    await adapter.navigateToConversation(
      this._page,
      this.id,
      this._projectPath || this._projectId
    );
    return adapter.getConversationStatus(
      this._page,
      this.id,
      this._projectPath || this._projectId
    );
  }

  /**
   * 等待当前对话完成生成。
   * @param {{ timeout?: number, pollInterval?: number, stablePolls?: number }} options
   * @returns {Promise<{ conversationId: string|null, url: string, state: string, isResponding: boolean, messageCount: number, assistantMessageCount: number, lastMessageRole: string|null, lastAssistantText: string, checkedAt: string }>}
   */
  async waitUntilComplete(options = {}) {
    await adapter.navigateToConversation(
      this._page,
      this.id,
      this._projectPath || this._projectId
    );
    return adapter.waitForConversationCompletion(
      this._page,
      this.id,
      this._projectPath || this._projectId,
      options
    );
  }

  /**
   * 获取当前对话的完整快照，包括消息列表和文件信息。
   * @returns {Promise<{ id: string|null, title: string|null, messages: Array, files: Array, source: string }>}
   */
  async getSnapshot() {
    await adapter.navigateToConversation(
      this._page,
      this.id,
      this._projectPath || this._projectId
    );
    const snapshot = await adapter.getConversationSnapshot(this._page, this.id);
    return mergeKnownFilesIntoSnapshot(snapshot, this._knownFiles);
  }

  /**
   * 获取当前对话的消息列表。
   * @returns {Promise<Array>}
   */
  async getMessages() {
    const { messages } = await this.getSnapshot();
    return messages;
  }

  /**
   * 获取当前对话里识别出的文件列表；文本类文件会尽量补齐 content。
   * @returns {Promise<Array>}
   */
  async getFiles() {
    const { files } = await this.getSnapshot();
    return files;
  }
}

// ── Project ───────────────────────────────────────────────────────────────────

class Project {
  /**
   * @param {Page} page
   * @param {string} name         项目名称
   * @param {string} projectId    项目 hex ID
   * @param {string} projectPath  项目页面路径 (e.g. "/g/g-p-xxx-slug/project")
   */
  constructor(page, name, projectId, projectPath) {
    this._page = page;
    this.name = name;
    this._projectId = projectId;
    this._projectPath = projectPath;
    this._projectFiles = new Map();
    this._conversationFiles = new Map();
  }

  _getKnownFilesForConversation(conversationId, extraFiles = []) {
    const known = new Map(this._projectFiles);
    const conversationFiles = this._conversationFiles.get(conversationId);
    for (const file of conversationFiles?.values?.() || []) {
      known.set(fileCacheKey(file), file);
    }
    for (const file of extraFiles) {
      known.set(fileCacheKey(file), file);
    }
    return Array.from(known.values());
  }

  _rememberProjectFiles(files) {
    for (const file of files || []) {
      this._projectFiles.set(fileCacheKey(file), file);
    }
  }

  _forgetProjectFiles(files) {
    const names = new Set((files || []).map((file) => file.fileName || file.name).filter(Boolean));
    const ids = new Set((files || []).map((file) => file.fileId || file.id).filter(Boolean));

    for (const [key, file] of this._projectFiles.entries()) {
      if ((file.id && ids.has(file.id)) || (file.name && names.has(file.name))) {
        this._projectFiles.delete(key);
      }
    }
  }

  _rememberConversationFiles(conversationId, files) {
    const cache = new Map();
    for (const file of this._getKnownFilesForConversation(conversationId, files)) {
      cache.set(fileCacheKey(file), file);
    }
    this._conversationFiles.set(conversationId, cache);
  }

  // ── 文件管理 ────────────────────────────────────────────────────────────────

  /**
   * 上传文件为后续对话附件（3 步 API 上传），返回文件信息。
   * @param {string} filePath  本地文件路径
   * @returns {Promise<{ fileId: string, fileName: string, fileSize: number, mimeType: string }>}
   */
  async uploadConversationAttachment(filePath) {
    const abs = path.resolve(filePath);
    const uploaded = await adapter.apiUploadConversationAttachment(this._page, abs);
    return {
      ...uploaded,
      content: readLocalFileContent(abs, uploaded),
    };
  }

  /**
   * 上传文件到当前项目文件区。
   * @param {string} filePath  本地文件路径
   * @returns {Promise<{ fileId: string|null, fileName: string, fileSize: number, mimeType: string }>}
   */
  async uploadProjectFile(filePath) {
    const abs = path.resolve(filePath);
    await adapter.navigateToProjectHome(this._page, this._projectPath);
    const uploaded = await adapter.uploadProjectFile(this._page, abs);
    const knownFile = buildKnownFileRecord(uploaded, abs);
    this._rememberProjectFiles([knownFile]);
    return {
      ...uploaded,
      content: knownFile.content,
    };
  }

  /**
   * 从当前项目文件区彻底删除文件。
   * @param {string} fileRef  file_id 或文件名
   * @returns {Promise<Array<{ fileId: string, fileName: string, fileSize: number|null, mimeType: string|null }>>}
   */
  async deleteProjectFile(fileRef) {
    await adapter.navigateToProjectHome(this._page, this._projectPath);
    const removed = await adapter.deleteProjectFile(this._page, fileRef);
    this._forgetProjectFiles(removed);
    return removed;
  }

  /**
   * 在当前项目页切换模型。
   * @param {string} modelName
   * @returns {Promise<string>} 实际选中的模型文案
   */
  async selectModel(modelName) {
    await adapter.navigateToProjectHome(this._page, this._projectPath);
    return adapter.selectModel(this._page, modelName);
  }

  // ── 对话管理 ────────────────────────────────────────────────────────────────

  /**
   * 在当前项目中开启新对话，发送第一条消息，等待完整回复。
   *
   * @param {string} firstMessage
   * @returns {Promise<{ conversation: Conversation, reply: string, snapshot: object }>}
   */
  async newConversation(firstMessage) {
    await adapter.navigateToProjectHome(this._page, this._projectPath, {
      forceReload: true,
    });
    const reply = await adapter.sendMessage(this._page, firstMessage);
    const id = await adapter.waitForConversationId(this._page);
    const conversation = new Conversation(
      this._page,
      id,
      this._projectId,
      this._projectPath,
      this._getKnownFilesForConversation(id)
    );
    const snapshot = await conversation.getSnapshot();
    this._rememberConversationFiles(id, conversation._knownFiles.values());
    return { conversation, reply, snapshot };
  }

  /**
   * 开启新对话并附带文件。
   *
   * @param {string} firstMessage  消息文本
   * @param {string[]} filePaths   本地文件路径数组
   * @returns {Promise<{ conversation: Conversation, reply: string, snapshot: object }>}
   */
  async newConversationWithFiles(firstMessage, filePaths) {
    await adapter.navigateToProjectHome(this._page, this._projectPath, {
      forceReload: true,
    });
    const attachments = [];
    const knownFiles = [];
    for (const fp of filePaths) {
      const abs = path.resolve(fp);
      const uploaded = await adapter.apiUploadConversationAttachment(
        this._page,
        abs
      );
      attachments.push(uploaded);
      knownFiles.push(buildKnownFileRecord(uploaded, abs));
    }
    const reply = await adapter.sendMessageWithFiles(this._page, firstMessage, attachments);
    const id = await adapter.waitForConversationId(this._page);
    const conversation = new Conversation(
      this._page,
      id,
      this._projectId,
      this._projectPath,
      this._getKnownFilesForConversation(id, knownFiles)
    );
    const snapshot = await conversation.getSnapshot();
    this._rememberConversationFiles(id, conversation._knownFiles.values());
    return { conversation, reply, snapshot };
  }

  /**
   * 打开已有对话但不发送消息。
   *
   * @param {string} conversationId
   * @returns {Promise<Conversation>}
   */
  async openConversation(conversationId) {
    const conversation = new Conversation(
      this._page,
      conversationId,
      this._projectId,
      this._projectPath,
      this._getKnownFilesForConversation(conversationId)
    );
    await adapter.navigateToConversation(
      this._page,
      conversationId,
      this._projectPath || this._projectId
    );
    return conversation;
  }

  /**
   * 恢复已有对话并继续发送消息。
   *
   * @param {string} conversationId
   * @param {string} message
   * @returns {Promise<{ conversation: Conversation, reply: string, snapshot: object }>}
   */
  async continueConversation(conversationId, message) {
    const conversation = new Conversation(
      this._page,
      conversationId,
      this._projectId,
      this._projectPath,
      this._getKnownFilesForConversation(conversationId)
    );
    const { reply, snapshot } = await conversation.sendAndGetSnapshot(message);
    this._rememberConversationFiles(conversationId, conversation._knownFiles.values());
    return { conversation, reply, snapshot };
  }
}

// ── ChatGPTClient ─────────────────────────────────────────────────────────────

class ChatGPTClient {
  constructor(page, browser = null) {
    this._page = page;
    this._browser = browser;
  }

  /**
   * 工厂方法：连接到远程浏览器，返回 ChatGPTClient 实例。
   * @param {string} browserURL  e.g. "http://192.168.1.62:9224"
   */
  static async create(browserURL) {
    const { browser, page } = await connect(browserURL);
    return new ChatGPTClient(page, browser);
  }

  /**
   * 断开与远程浏览器的连接，不关闭实际 Chrome。
   */
  async disconnect() {
    if (!this._browser) return;
    await this._browser.disconnect();
    this._browser = null;
  }

  /**
   * 选中某个项目，返回 Project 实例。
   * @param {string} projectName  侧边栏中的项目名称
   */
  async selectProject(projectName) {
    const { projectId, projectPath } = await adapter.navigateToProject(
      this._page,
      projectName
    );
    return new Project(this._page, projectName, projectId, projectPath);
  }
}

module.exports = { ChatGPTClient, Project, Conversation };
