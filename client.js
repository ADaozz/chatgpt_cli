/**
 * client.js — 公开 API 层（调度：BrowserSession → PageController →
 * WebProtocol / ModelController / FileController / ResponseTracker）
 *
 * 结果结构（v2）：
 *   send / start 返回 { conversationId, state, model: {name, effort},
 *   reply: { text, blocks, hasUnsupportedContent }, error }
 *
 * 约束：
 *   - page 对象不泄漏到本层之外；业务模块不得直接 querySelector。
 *   - 协议失败不静默：抛 ProtocolError / DOM_CHANGED，不返回空快照伪装成功。
 */

'use strict';

const path = require('path');
const { connect } = require('./browser');
const { PageController, DOM_CHANGED } = require('./page-controller');
const { WebProtocol } = require('./web-protocol');
const { ModelController } = require('./model-controller');
const { FileController } = require('./file-controller');
const { ProjectController } = require('./project-controller');
const { ResponseTracker } = require('./response-tracker');
const { getLastAssistantFromSnapshot } = require('./conversation-parser');
const {
  extractProjectId,
  extractConversationId,
  isUsableConversationId,
} = require('./url-utils');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readLocalFileContent(absPath, uploaded = {}) {
  const fileName = uploaded.fileName || path.basename(absPath);
  const mimeType = uploaded.mimeType || '';
  const isTextLike =
    /^(text\/|application\/(json|xml|javascript)|image\/svg\+xml)/i.test(mimeType) ||
    /\.(txt|md|json|csv|xml|ya?ml|js|ts|py|html|css|svg|log)$/i.test(fileName);
  if (!isTextLike) return null;
  const content = fsReadSafe(absPath);
  if (content == null) return null;
  return content.length <= 100_000
    ? content
    : `${content.slice(0, 100_000)}\n\n...[truncated]`;
}

function fsReadSafe(absPath) {
  try {
    // eslint-disable-next-line global-require
    const fs = require('fs');
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

// ── Conversation ──────────────────────────────────────────────────────────────

class Conversation {
  /** @param {ChatGPTClient} client */
  constructor(client, id, projectId = null, projectPath = null, knownFiles = []) {
    this._client = client;
    this.id = id;
    this._projectId = projectId || null;
    this._projectPath = projectPath || null;
    this._knownFiles = new Map();
    for (const file of knownFiles || []) {
      this._knownFiles.set(`${file.id || ''}|${file.name || ''}`, file);
    }
  }

  _rememberFiles(files) {
    for (const file of files || []) {
      this._knownFiles.set(`${file.id || ''}|${file.name || ''}`, file);
    }
  }

  /** 打开对话页。 */
  async open() {
    await this._client.pages.gotoConversation(this.id, this._projectPath);
  }

  /**
   * 发送消息并等待协议确认的最终回复。
   * @returns {Promise<{conversationId, state, model, reply, error}>}
   */
  async send(message, options = {}) {
    return this._client.sendInConversation({
      text: message,
      conversationId: this.id,
      projectPath: this._projectPath,
      onState: options.onState,
      timeoutMs: options.timeoutMs,
    });
  }

  async sendWithFiles(message, filePaths, options = {}) {
    const attachments = [];
    for (const fp of filePaths || []) {
      const abs = path.resolve(fp);
      const uploaded = await this._client.files.uploadConversationAttachment(abs);
      uploaded.content = readLocalFileContent(abs, uploaded);
      attachments.push(uploaded);
      this._rememberFiles([{
        id: uploaded.fileId,
        name: uploaded.fileName,
        mimeType: uploaded.mimeType,
        size: uploaded.fileSize,
        content: uploaded.content,
      }]);
    }
    return this._client.sendInConversation({
      text: message,
      conversationId: this.id,
      projectPath: this._projectPath,
      fileAttachments: attachments,
      onState: options.onState,
      timeoutMs: options.timeoutMs,
    });
  }

  async sendAndGetSnapshot(message, options = {}) {
    const result = await this.send(message, options);
    const snapshot = await this.getSnapshot();
    return { ...result, snapshot };
  }

  /** 完整快照（协议权威；分页读全或标记 partial）。 */
  async getSnapshot() {
    const { snapshot } = await this._client.protocol.readConversation(this.id, {
      numTurns: Number(process.env.CHATGPT_SNAPSHOT_NUM_TURNS) || 50,
      maxPages: Number(process.env.CHATGPT_SNAPSHOT_MAX_PAGES) || 20,
    });
    return this._client.enrichSnapshot(snapshot, this._knownFiles);
  }

  async getMessages() {
    const snapshot = await this.getSnapshot();
    return snapshot.messages;
  }

  async getFiles() {
    const snapshot = await this.getSnapshot();
    return snapshot.files || [];
  }

  /** 状态（协议 + DOM 概览；不做完成判定承诺）。 */
  async getStatus() {
    return this._client.getConversationStatus(this.id);
  }

  /** status --wait 共用状态机。 */
  async waitUntilComplete(options = {}) {
    return this._client.waitConversationComplete(this.id, options);
  }

  /** 显式切换模型/强度（走 UI 菜单并验证）。 */
  async selectModel(model, effort = null) {
    await this.open();
    return this._client.models.applySelection({ model, effort });
  }
}

// ── Project ───────────────────────────────────────────────────────────────────

class Project {
  /** @param {ChatGPTClient} client */
  constructor(client, name, projectId, projectPath) {
    this._client = client;
    this.name = name;
    this._projectId = projectId || null;
    this._projectPath = projectPath || null;
  }

  get projectPath() {
    return this._projectPath;
  }

  async open() {
    if (this._projectPath) {
      await this._client.pages.gotoProjectHome(this._projectPath);
    }
  }

  /** 在项目内发送（新对话）。 */
  async newConversation(message, options = {}) {
    return this._client.sendInConversation({
      text: message,
      projectPath: this._projectPath,
      onState: options.onState,
      timeoutMs: options.timeoutMs,
    });
  }

  async openConversation(conversationId) {
    const conv = new Conversation(
      this._client,
      conversationId,
      this._projectId,
      this._projectPath
    );
    await conv.open();
    return conv;
  }

  async selectModel(model, effort = null) {
    await this.open();
    return this._client.models.applySelection({ model, effort });
  }

  async uploadProjectFile(absPath) {
    if (!this._projectId) throw new Error('项目未打开');
    return this._client.files.uploadProjectSource(path.resolve(absPath), {
      gizmoId: this._projectId,
    });
  }

  async deleteProjectFile(fileRef) {
    if (!this._projectId) throw new Error('项目未打开');
    return this._client.files.deleteProjectSource(fileRef, { gizmoId: this._projectId });
  }

  async listFiles() {
    if (!this._projectId) throw new Error('项目未打开');
    return this._client.projects.listProjectFiles(this._projectId);
  }

  async listConversations(limit = 20) {
    if (!this._projectId) throw new Error('项目未打开');
    return this._client.projects.listProjectConversations(this._projectId, { limit });
  }

  /** 项目内对话附件上传（等价 v1.2.2 uploadConversationAttachment）。 */
  async uploadConversationAttachment(absPath) {
    const uploaded = await this._client.files.uploadConversationAttachment(path.resolve(absPath));
    uploaded.content = readLocalFileContent(path.resolve(absPath), uploaded);
    return uploaded;
  }
}

// ── ChatGPTClient ─────────────────────────────────────────────────────────────

class ChatGPTClient {
  /**
   * @param {import('puppeteer-core').Page} page
   * @param {import('puppeteer-core').Browser|null} browser
   */
  constructor(page, browser = null) {
    this.page = page;
    this.browser = browser;
    this.pages = new PageController(page);
    this.protocol = new WebProtocol(page);
    this.models = new ModelController({ pageController: this.pages });
    this.files = new FileController(this.protocol);
    this.projects = new ProjectController({
      pageController: this.pages,
      protocol: this.protocol,
      files: this.files,
    });
    this.modelSelection = null; // 最近一次应用的 {modelLabel, effort, ...}
  }

  static async create(browserURL) {
    const { browser, page } = await connect(browserURL);
    return new ChatGPTClient(page, browser);
  }

  async disconnect() {
    try {
      if (this.browser && typeof this.browser.disconnect === 'function') {
        await this.browser.disconnect();
      } else if (this.browser && typeof this.browser.close === 'function') {
        await this.browser.close();
      }
    } catch {}
  }

  /**
   * 应用模型配置。默认策略（产品决策 2026-10-28）：
   * 不指定时 = 账号最新模型 + 最高思考强度。
   */
  async applyModelConfig({ model = null, effort = null, useDefaultPolicy = true } = {}) {
    const selection = await this.models.applySelection(
      useDefaultPolicy ? { model, effort } : { model, effort: effort ?? undefined }
    );
    this.modelSelection = selection;
    return selection;
  }

  /**
   * 项目会话在服务端 id 就绪前 URL 为 `/c/local-chatgpt%3A<uuid>`，
   * 无法直接从 URL 取到可用 UUID。这里通过项目会话列表解析：
   * 发送前记录已有 id 集合，发送后轮询直到出现新会话。
   */
  async _resolveProjectConversationId(projectPath, beforeIds, since, { timeoutMs = 30_000 } = {}) {
    const gizmoId = extractProjectId(projectPath || this.pages.url());
    if (!gizmoId) return null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const payload = await this.protocol.listConversations({ limit: 10, gizmoId });
        const items = Array.isArray(payload?.items) ? payload.items : [];
        const fresh = items.find((item) => item.id && !beforeIds.has(item.id));
        if (fresh) return fresh.id;
      } catch {}
      await sleep(2000);
    }
    void since;
    return null;
  }

  /** 发送前项目会话 id 快照（用于识别新会话）。 */
  async _snapshotProjectConversationIds(projectPath) {
    const gizmoId = extractProjectId(projectPath || '');
    const beforeIds = new Set();
    if (!gizmoId) return beforeIds;
    try {
      const payload = await this.protocol.listConversations({ limit: 10, gizmoId });
      for (const item of payload?.items || []) {
        if (item.id) beforeIds.add(item.id);
      }
    } catch {}
    return beforeIds;
  }

  /**
   * 核心发送流程。
   * @returns {Promise<{conversationId, state, model, reply, error}>}
   */
  async sendInConversation({
    text,
    conversationId = null,
    projectPath = null,
    fileAttachments = null,
    onState = null,
    timeoutMs = null,
  }) {
    // 1. 导航（项目会话：发送前记录已有会话 id，用于识别新会话）
    const beforeIds = projectPath
      ? await this._snapshotProjectConversationIds(projectPath)
      : new Set();

    if (conversationId) {
      await this.pages.gotoConversation(conversationId, projectPath);
    } else if (projectPath) {
      await this.pages.gotoProjectHome(projectPath);
    } else {
      await this.pages.goto('https://chatgpt.com/');
    }
    await this.pages.ensureChatLoaded();

    // 2. 发送前基线
    const baseline = await this.pages.sampleDom();
    const baselineTurnCount = baseline ? baseline.turnCount : null;

    // 3. 附件（CDP 注入 metadata；模型注入已移除）
    const haveAttachments = Array.isArray(fileAttachments) && fileAttachments.length > 0;

    // 4. 输入 + 发送（tracker 先装观察器再发送）
    const tracker = new ResponseTracker({
      pageController: this.pages,
      protocol: this.protocol,
      conversationId: conversationId || null,
      requireNewTurn: true,
      baselineTurnCount,
      timeoutMs: timeoutMs ?? undefined,
      onState,
    });
    await tracker.start();

    try {
      await this.pages.typeIntoComposer(text);
      if (haveAttachments) {
        await this._sendWithAttachments(async () => this.pages.clickSend(), fileAttachments);
      } else {
        await this.pages.clickSend();
      }
    } catch (err) {
      await tracker.stop().catch(() => {});
      throw err;
    }

    // 项目会话 URL 可能是 local-chatgpt:<uuid> 占位；通过列表解析真实 id，
    // 解析成功后注入 tracker，让协议确认路径可用。
    let resolveIdPromise = Promise.resolve(null);
    if (!conversationId) {
      resolveIdPromise = (async () => {
        const urlId = extractConversationId(this.pages.url());
        if (isUsableConversationId(urlId)) return urlId;
        if (projectPath) {
          return this._resolveProjectConversationId(projectPath, beforeIds, Date.now());
        }
        return null;
      })();
      resolveIdPromise
        .then((id) => {
          if (id && !tracker.conversationId) tracker.conversationId = id;
        })
        .catch(() => {});
    }

    const result = await tracker.waitForComplete();

    // 5. conversationId：只接受真实 UUID（过滤 /c/local-chatgpt 占位）
    const fromResult = isUsableConversationId(result.conversationId) ? result.conversationId : null;
    const fromUrlRaw = extractConversationId(this.pages.url());
    const fromUrl = isUsableConversationId(fromUrlRaw) ? fromUrlRaw : null;
    const resolvedId = await Promise.race([
      resolveIdPromise.catch(() => null),
      sleep(5000).then(() => null),
    ]);
    const finalConvId = fromResult || resolvedId || fromUrl || null;

    // 模型信息：名称取自菜单选择（触发器文本只有强度），强度取自触发器属性
    let modelInfo = null;
    try {
      const current = await this.models.readCurrent();
      const name = this.modelSelection && this.modelSelection.modelLabel
        ? this.modelSelection.modelLabel
        : (current ? current.label : null);
      modelInfo = { name, effort: current ? current.effort : (this.modelSelection?.effort || null) };
    } catch {
      modelInfo = this.modelSelection
        ? { name: this.modelSelection.modelLabel, effort: this.modelSelection.effort }
        : null;
    }

    return {
      conversationId: finalConvId,
      state: result.state,
      completionSource: result.completionSource || null,
      model: modelInfo,
      reply: {
        text: result.text || '',
        blocks: result.blocks || [],
        hasUnsupportedContent: Boolean(result.hasUnsupportedContent),
      },
      partial: Boolean(result.partial),
      error: result.error || null,
    };
  }

  /** start：只发送不等回复，尽快返回 conversationId。 */
  async startMessage({ text, conversationId = null, projectPath = null }) {
    const beforeIds = projectPath
      ? await this._snapshotProjectConversationIds(projectPath)
      : new Set();
    if (conversationId) {
      await this.pages.gotoConversation(conversationId, projectPath);
    } else if (projectPath) {
      await this.pages.gotoProjectHome(projectPath);
    } else {
      await this.pages.goto('https://chatgpt.com/');
    }
    await this.pages.ensureChatLoaded();
    const baseline = await this.pages.sampleDom();
    const tracker = new ResponseTracker({
      pageController: this.pages,
      protocol: this.protocol,
      conversationId: null,
      requireNewTurn: true,
      baselineTurnCount: baseline ? baseline.turnCount : null,
      timeoutMs: Number(process.env.CHATGPT_START_CONV_ID_TIMEOUT_MS) || 90_000,
    });
    await tracker.start();
    try {
      await this.pages.typeIntoComposer(text);
      await this.pages.clickSend();
    } catch (err) {
      await tracker.stop().catch(() => {});
      throw err;
    }
    let newConversationId = conversationId;
    if (!newConversationId) {
      // 先等 URL 出现可用 UUID（普通会话），项目会话回退到会话列表解析
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const urlId = extractConversationId(this.pages.url());
        if (isUsableConversationId(urlId)) {
          newConversationId = urlId;
          break;
        }
        if (projectPath) {
          const resolved = await this._resolveProjectConversationId(projectPath, beforeIds, Date.now(), { timeoutMs: 5000 });
          if (resolved) {
            newConversationId = resolved;
            break;
          }
        } else {
          await sleep(500);
        }
      }
    }
    await tracker.stop().catch(() => {});
    if (!newConversationId) {
      throw new Error('消息已发送但未能获取 conversationId（URL 未跳转/会话列表未同步）');
    }
    return { conversationId: newConversationId, url: this.pages.url(), state: 'started' };
  }

  /**
   * 附件注入：CDP Fetch 拦截 f/conversation 请求，把已上传附件写入
   * messages[0].metadata.attachments。仅注入附件，不改 model 字段。
   * （写契约 probe-pending，v1.2.2 已验证路径。）
   */
  async _sendWithAttachments(sendAction, fileAttachments) {
    const cdp = await this.page.createCDPSession();
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*backend-api/f/conversation', requestStage: 'Request' }],
    });
    let patched = false;
    const onPaused = async (event) => {
      const { requestId, request } = event;
      if (request.method === 'POST' && request.postData && !patched) {
        patched = true;
        try {
          const payload = JSON.parse(request.postData);
          if (payload.messages && payload.messages[0]) {
            const msg = payload.messages[0];
            if (!msg.metadata) msg.metadata = {};
            msg.metadata.attachments = [
              ...(msg.metadata.attachments || []),
              ...fileAttachments.map((f) => ({
                id: f.fileId,
                name: f.fileName,
                size: f.fileSize,
                mimeType: f.mimeType,
              })),
            ];
          }
          await cdp.send('Fetch.continueRequest', {
            requestId,
            postData: Buffer.from(JSON.stringify(payload)).toString('base64'),
          });
          return;
        } catch {}
      }
      await cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
    };
    cdp.on('Fetch.requestPaused', onPaused);
    try {
      return await sendAction();
    } finally {
      cdp.off('Fetch.requestPaused', onPaused);
      await cdp.send('Fetch.disable').catch(() => {});
      await cdp.detach().catch(() => {});
    }
  }

  /** 快照补齐本地已知文件信息。 */
  enrichSnapshot(snapshot, knownFiles = new Map()) {
    const files = [];
    const enrich = (file) => {
      const key = `${file.id || ''}|${file.name || ''}`;
      const known =
        knownFiles.get(key) ||
        Array.from(knownFiles.values()).find((k) => k.name === file.name) ||
        null;
      return {
        ...file,
        mimeType: file.mimeType || (known && known.mimeType) || null,
        size: file.size ?? (known && known.size) ?? null,
        content: file.content || (known && known.content) || null,
      };
    };
    for (const msg of snapshot.visibleMessages || snapshot.messages || []) {
      for (const file of msg.files || []) files.push(enrich(file));
    }
    return {
      id: snapshot.id,
      title: snapshot.title,
      gizmoId: snapshot.gizmoId || null,
      defaultModelSlug: snapshot.defaultModelSlug || null,
      asyncStatus: snapshot.asyncStatus ?? null,
      messages: snapshot.visibleMessages || snapshot.messages || [],
      files: files.filter((f, i, arr) => arr.findIndex((x) => x.id === f.id && x.name === f.name) === i),
      completion: snapshot.completion,
      pageInfo: snapshot.pageInfo,
      partial: Boolean(snapshot.partial),
      shape: snapshot.shape,
      source: 'protocol',
      fetchedAt: new Date().toISOString(),
    };
  }

  /** 会话状态（协议优先，DOM 兜底展示；不承诺完成）。 */
  async getConversationStatus(conversationId) {
    const domSample = await this.pages.sampleDom();
    let snapshot = null;
    let snapshotError = null;
    if (conversationId) {
      try {
        snapshot = (await this.protocol.fetchConversation(conversationId, { numTurns: 4 })).snapshot;
      } catch (err) {
        snapshotError = `${err && err.message ? err.message : err}`;
      }
    }

    const turnComplete = snapshot && snapshot.completion ? snapshot.completion.turnComplete : null;
    const domResponding = Boolean(
      domSample && (domSample.turnInProgress || (domSample.stopVisible && !domSample.uiTurnComplete))
    );
    const stillGenerating =
      turnComplete === false || (turnComplete !== true && domResponding);

    const vis = snapshot ? (snapshot.visibleMessages || []) : [];
    const lastRole = vis.length ? vis[vis.length - 1].role : (domSample ? domSample.lastMessageRole || null : null);

    return {
      conversationId: conversationId || (domSample ? extractConversationId(domSample.url) : null),
      url: domSample ? domSample.url : this.pages.url(),
      state: stillGenerating ? 'running' : turnComplete === true ? 'completed' : 'unknown',
      isResponding: stillGenerating,
      turnState: domSample ? domSample.turnState : null,
      messageCount: snapshot
        ? snapshot.messages.length
        : domSample ? domSample.assistantUnitCount + domSample.userBubbleCount : null,
      assistantMessageCount: snapshot
        ? snapshot.messages.filter((m) => m.role === 'assistant').length
        : domSample ? domSample.assistantUnitCount : null,
      lastMessageRole: lastRole,
      lastAssistantText: snapshot
        ? getLastAssistantFromSnapshot(snapshot)
        : domSample ? domSample.lastTextTail || '' : '',
      partial: snapshot ? Boolean(snapshot.partial) : null,
      snapshotError,
      checkedAt: new Date().toISOString(),
    };
  }

  /** status --wait：与 send 共用 ResponseTracker。 */
  async waitConversationComplete(conversationId, { timeout, pollInterval, onState } = {}) {
    const tracker = new ResponseTracker({
      pageController: this.pages,
      protocol: this.protocol,
      conversationId,
      requireNewTurn: false,
      timeoutMs: timeout,
      pollIntervalMs: pollInterval,
      onState,
    });
    await tracker.start();
    const result = await tracker.waitForComplete();
    await tracker.stop().catch(() => {});
    return result;
  }

  /** 新对话（非项目）。 */
  async newConversation(message, options = {}) {
    return this.sendInConversation({ text: message, ...options });
  }

  /** 打开项目并返回 Project 上下文。 */
  async selectProject(name) {
    const opened = await this.projects.openProject(name);
    return new Project(this, name, opened.projectId, opened.projectPath);
  }

  /** 创建项目并进入。 */
  async createProject(name) {
    const created = await this.projects.createProject(name);
    return new Project(this, name, created.projectId, created.projectPath);
  }
}

module.exports = { ChatGPTClient, Conversation, Project, DOM_CHANGED, sleep };
