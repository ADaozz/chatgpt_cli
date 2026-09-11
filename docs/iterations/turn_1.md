> **历史记录（Iteration 1）**：本文记录的是当时解包的 `ChatGPTCLI_Iteration_1.tar.gz` 静态审查结论，不代表当前工作树或当前发布版本。请以根目录 `README.md`、源码和 `package.json` 为当前行为的唯一依据。

## 范围说明

我已解包并静态检查 `ChatGPTCLI_Iteration_1.tar.gz`。`file_search` 当前只暴露到项目里的 Python 原型入口，例如 `demo.py` 是 `SkillRegistry → DS_LLM → AgentManager` 的循环式 agent 入口，和这次 Node CLI 包是两个对象；下面的结论基于 tar 包内 JS/SH 文件的本地解包检查。fileciteturn2file0

我执行过：

```bash
tar -tzf ChatGPTCLI_Iteration_1.tar.gz
node --check *.js
npm test
npm pack --dry-run
```

结果：

- `node --check *.js`：全部语法通过。
- `npm test`：仍是 `"Error: no test specified"` 占位脚本。
- `npm pack --dry-run`：不会打包 `.env`，但会打包 `.cursor/skills/chatgpt-driven-iteration/SKILL.md`。

---

# 总体结论

这个项目的核心思路是成立的：

```text
cli.js / commands.js
  → session.js
  → client.js: ChatGPTClient / Project / Conversation
  → adapter.js
  → browser.js / puppeteer-core / ChatGPT Web DOM + private backend API
```

但当前最大问题是：

1. **adapter 太大且职责混杂**  
   `adapter.js` 同时做 DOM 操作、ChatGPT 私有 API 调用、文件上传、项目配置 upsert、模型选择、快照归一化、CDP 请求拦截、等待生成完成。它已经不是单纯 adapter，而是核心业务层。

2. **Puppeteer 等待逻辑容易误判旧回复为新回复**  
   `_waitForReply()` 在 stop 按钮缺失或 ChatGPT UI 改版时，可能降级到读取最后一条 assistant 消息；如果新消息没有出现，它仍可能返回旧消息。

3. **错误处理不成体系**  
   大量 `catch {}` 吞错，`process.exit()` 分散在业务函数里，非交互模式和交互模式错误格式不一致，JSON 模式下也没有结构化错误。

4. **CLI 与 public API 边界破坏**  
   `client.js` 注释说 page 不泄漏，但 `cli.js`、`commands.js`、`wait-conversation.js` 多处直接访问 `session.client._page` 或 `client._page`。

5. **测试基本为空**  
   没有单元测试、mock Puppeteer 测试、CLI 参数解析测试、错误分支测试、文件上传 payload 测试、快照归一化测试。

---

# 架构分析

## 1. CLI 层

### 当前状态

`cli.js` 同时承担：

- 参数解析：`parseArgs()`
- session 初始化：`initSession()`
- 非交互命令执行：`runNonInteractive()`
- REPL：`runInteractive()`
- 消息发送：`handleMessage()`
- 进程退出：`process.exit()`

主要问题：

| 问题 | 位置 | 影响 |
|---|---:|---|
| `parseArgs()` 手写且语义不稳定 | `cli.js:44-80` | flags 放在子命令后时行为不直观；路径、消息中含 `--xxx` 时可能被过滤 |
| `initSession()` 在 `try/finally` 外 | `cli.js:133-134` | 初始化中途失败时可能无法清理 browser 连接 |
| 非交互与交互逻辑重复 | `cli.js:106-119`, `206-282`, `commands.js:93-115` | 打开 conversation 的逻辑重复，后续容易分叉 |
| 业务函数内直接 `process.exit()` | `cli.js:148-150`, `185-190`, `296-299` | 难以单测；库调用方无法接管错误 |
| 直接访问 `session.client._page` | 多处 | 破坏 `client.js` 声称的 page 封装 |

### 建议

新增：

```text
src/args.js
src/run-non-interactive.js
src/run-interactive.js
src/open-conversation.js
src/errors.js
```

或在现有根目录先低成本拆分：

```text
args.js
runner.js
errors.js
conversation-utils.js
```

---

## 2. Public API 层：`client.js`

### 当前状态

`client.js` 设计了三个抽象：

```js
ChatGPTClient
Project
Conversation
```

这是合理的。`Project` 作为 `Conversation` 工厂也合理。

主要问题：

| 问题 | 位置 | 影响 |
|---|---:|---|
| `ChatGPTClient._page` 被外部大量使用 | `cli.js`, `commands.js`, `wait-conversation.js` | public API 边界失效 |
| 文件内容读取为同步 `fs.readFileSync()` | `client.js:31-42` | 大文件阻塞事件循环 |
| `uploadConversationAttachment()` 只上传但不绑定到后续消息 | `client.js:348-355`, `commands.js:117-140` | `/upload` 默认“对话附件”语义不完整 |
| `Project` 缓存只存在内存 | `client.js:300-338` | CLI 重启后快照补全能力消失，可接受但需文档化 |

### 建议

给 `ChatGPTClient` 补齐 public 方法，移除 CLI 对 `_page` 的依赖：

```js
class ChatGPTClient {
  async send(message) {}
  async selectModel(modelName) {}
  async openConversation(conversationId) {}
  async getConversationStatus(conversationId) {}
  async getConversationSnapshot(conversationId) {}
}
```

之后把 `cli.js` 里的：

```js
adapter.sendMessage(session.client._page, message)
```

改成：

```js
session.client.send(message)
```

---

## 3. Adapter 与 Puppeteer 层

## 当前 `adapter.js` 职责过重

`adapter.js` 目前包含：

- URL 解析：`extractProjectId()`, `extractConversationId()`
- 页面导航：`navigateToProject()`, `navigateToConversation()`
- ChatGPT access token：`getAccessToken()`
- backend API：`/backend-api/files`, `/backend-api/gizmos/...`
- Azure Blob 上传
- Project Sources upsert/delete
- 模型选择
- DOM 快照解析
- 对话状态检查
- 等待完成
- 消息发送
- CDP Fetch 拦截附件注入

这会导致三个问题：

1. **无法单元测试**：大部分函数必须 mock 整个 Puppeteer page。
2. **错误定位困难**：DOM 失败、HTTP 失败、业务校验失败都混在普通 `Error`。
3. **ChatGPT Web 改版时风险集中**：一个文件变成高耦合故障点。

---

# 关键问题与修改建议

## A. `auto-connect.js` 忽略 `CHATGPT_BROWSER_URL`

### 问题

`setup-and-verify.sh` 会写入：

```bash
CHATGPT_BROWSER_URL=http://...
```

但 `auto-connect.js` 里实际只用：

```js
const PORT = process.env.CHATGPT_PORT || '9224';
...
const browserURL = `http://${hostIP}:${PORT}`;
```

也就是说，CLI 主流程不会优先使用 `CHATGPT_BROWSER_URL`。这会让非 WSL、macOS、Linux、Docker、远程 Chrome 用户很难使用。

### 修改步骤

**文件：`auto-connect.js`**

1. 增加 URL 优先级：

```js
function getExplicitBrowserURL() {
  return process.env.CHATGPT_BROWSER_URL || null;
}
```

2. 在 `autoConnect()` 开头加入：

```js
const explicitURL = getExplicitBrowserURL();
if (explicitURL) {
  const client = await checkLoginState(explicitURL);
  if (!client) {
    throw new Error(`无法连接或未登录: ${explicitURL}`);
  }
  log('ChatGPT 登录态已确认');
  return { client, browserURL: explicitURL };
}
```

3. 再进入 WSL/PowerShell 自动化路径。

4. 可选：新增 `config.js`，集中读取 env。

---

## B. `sendMessageWithFiles()` 清理不可靠

### 问题

`adapter.js:1388-1458` 里创建 CDP session 后，只有成功走到末尾才会：

```js
await cdp.send('Fetch.disable').catch(() => {});
await cdp.detach().catch(() => {});
```

如果中途 `_waitForReply()` 超时、点击失败、页面关闭，CDP Fetch 可能保持启用。

另外，代码没有验证 `injected === true`。如果 endpoint 变了，消息可能已经发出，但附件没有注入。

### 修改步骤

**文件：`adapter.js`**

把结构改为：

```js
async function sendMessageWithFiles(page, text, fileAttachments, options = {}) {
  const prevAssistantCount = await getAssistantCount(page);
  const cdp = await page.createCDPSession();
  let injected = false;

  try {
    await setComposerText(page, text);
    await waitForSendReady(page);

    await cdp.send('Fetch.enable', {
      patterns: [{
        urlPattern: '*backend-api/*conversation*',
        requestStage: 'Request',
      }],
    });

    cdp.on('Fetch.requestPaused', async (event) => {
      try {
        const handled = await maybeInjectAttachments(cdp, event, fileAttachments);
        if (handled) injected = true;
      } catch (err) {
        await cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
      }
    });

    await clickSend(page);

    const reply = await waitForNewReply(page, prevAssistantCount, options);

    if (!injected) {
      throw new AdapterError(
        'ATTACHMENT_INJECTION_MISSED',
        '消息已发送，但未拦截到 conversation 请求，附件可能未绑定'
      );
    }

    return reply;
  } finally {
    await cdp.send('Fetch.disable').catch(() => {});
    await cdp.detach().catch(() => {});
  }
}
```

---

## C. `_waitForReply()` 可能返回旧 assistant 消息

### 问题

`adapter.js:1467-1507` 的降级路径：

1. 尝试等待新 assistant 消息。
2. 如果失败，吞掉异常。
3. 再轮询最后一条 assistant 文本稳定。
4. 返回最后一条 assistant 文本。

这意味着如果发送失败、按钮没点上、ChatGPT 要求登录、429、UI 变了，函数仍可能返回旧回复。

### 修改步骤

**文件：`adapter.js`**

改成必须满足至少一个条件：

- assistant 数量增加；
- 或最后 assistant message id 改变；
- 或 conversation status 明确完成且 last message role 是 assistant。

伪代码：

```js
async function waitForNewReply(page, prevAssistantCount, options = {}) {
  const timeout = options.timeout ?? REPLY_TIMEOUT;

  const started = await Promise.race([
    waitForStopButtonCycle(page, timeout),
    waitForAssistantCountIncrease(page, prevAssistantCount, timeout),
    waitForChatGPTError(page, timeout),
  ]);

  if (started?.type === 'error') {
    throw new AdapterError('CHATGPT_UI_ERROR', started.message);
  }

  const stable = await waitForAssistantTextStable(page, {
    minAssistantCount: prevAssistantCount + 1,
    timeout,
  });

  if (!stable.text) {
    throw new AdapterError('EMPTY_REPLY', '未检测到新的 assistant 回复');
  }

  return stable.text;
}
```

最低成本修复：

```js
const newCount = await page.evaluate(
  (sel) => document.querySelectorAll(sel).length,
  S.response.assistantMsgs
);

if (newCount <= prevAssistantCount) {
  throw new Error('发送后未检测到新的 assistant 消息');
}
```

放在返回 content 前。

---

## D. Composer 输入方式脆弱

### 问题

`sendMessage()` 和 `sendMessageWithFiles()` 都使用：

```js
document.execCommand('selectAll')
document.execCommand('insertText')
```

并且没有检查：

```js
const el = document.querySelector('#prompt-textarea');
```

是否为空。

### 修改步骤

**文件：`adapter.js`**

新增：

```js
async function setComposerText(page, text) {
  await page.waitForSelector(S.composer.textarea, { timeout: DEFAULT_TIMEOUT });

  const ok = await page.evaluate((selector, value) => {
    const el = document.querySelector(selector);
    if (!el) return false;

    el.focus();

    // ProseMirror/contenteditable path
    if (el.isContentEditable) {
      el.innerText = '';
      el.dispatchEvent(new InputEvent('input', {
        inputType: 'deleteContentBackward',
        bubbles: true,
        cancelable: true,
      }));

      document.execCommand('insertText', false, value);

      el.dispatchEvent(new InputEvent('input', {
        inputType: 'insertText',
        data: value,
        bubbles: true,
        cancelable: true,
      }));

      return true;
    }

    // textarea fallback
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, S.composer.textarea, text);

  if (!ok) {
    throw new SelectorNotFoundError('COMPOSER_NOT_FOUND', S.composer.textarea);
  }
}
```

然后 `sendMessage()` 和 `sendMessageWithFiles()` 复用它。

---

## E. `adapter.js` 注释与实际行为不一致

### 问题

文件头写着：

```js
// 不抛出业务错误，只抛出操作错误
```

但实际抛出大量业务错误，例如：

- `当前页面不是项目页面，无法上传项目文件`
- `项目中未找到文件`
- `找不到模型`
- `项目文件处理未完成`

### 修改步骤

二选一：

### 方案 1：保留 adapter 为低层，只抛操作错误

拆出：

```text
chatgpt-api.js        // backend-api/files, gizmos upsert/delete
project-service.js    // uploadProjectFile/deleteProjectFile 业务流程
conversation-dom.js   // sendMessage, waitForReply
snapshot-normalizer.js
```

### 方案 2：承认 adapter 是 service 层

修改文件头注释，明确：

```js
/**
 * adapter.js — ChatGPT Web + private backend API 适配层
 *
 * 允许抛出：
 * - SelectorNotFoundError
 * - AuthError
 * - BackendApiError
 * - TimeoutError
 * - ChatGPTUiError
 */
```

我建议先用方案 2，后续再拆文件。

---

## F. 文件上传内存风险

### 问题

`getLocalFileMeta()` 会：

```js
const fileContent = fs.readFileSync(absoluteFilePath);
```

随后 `uploadBlobToUrl()` 又把 buffer base64 传入 browser：

```js
fileContent.toString('base64')
```

大文件会造成：

- Node 内存占用一份；
- base64 放大约 33%；
- browser context 再复制一份；
- Puppeteer protocol 传输一份。

### 修改步骤

**文件：`adapter.js`**

短期：

```js
const MAX_INLINE_UPLOAD = 50 * 1024 * 1024;
if (fileSize > MAX_INLINE_UPLOAD) {
  throw new Error(`文件过大，当前上传实现限制 ${MAX_INLINE_UPLOAD} bytes`);
}
```

中期：Node 侧直接 PUT 到 `upload_url`，避免通过 `page.evaluate()` 传大 buffer。

Node 18+ 可用：

```js
const { openAsBlob } = require('fs');

async function uploadBlobToUrlNode(uploadUrl, absoluteFilePath, mimeType) {
  const blob = await openAsBlob(absoluteFilePath, {
    type: mimeType || 'application/octet-stream',
  });

  const resp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType || 'application/octet-stream',
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-version': '2020-04-08',
    },
    body: blob,
  });

  if (!resp.ok && resp.status !== 201) {
    throw new BackendApiError('BLOB_UPLOAD_FAILED', await resp.text());
  }
}
```

---

# 按文件修改清单

## 1. `package.json`

### 当前问题

- `test` 是占位失败脚本。
- 没有 devDependencies。
- 没有 `files` 白名单。
- 可能把 `.cursor/skills/...` 打进 npm 包。
- 没有 `engines` 声明。

### 修改

```json
{
  "scripts": {
    "check": "node --check *.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "pack:dry": "npm pack --dry-run"
  },
  "devDependencies": {
    "vitest": "^2.1.0"
  },
  "engines": {
    "node": ">=20"
  },
  "files": [
    "adapter.js",
    "auto-connect.js",
    "browser.js",
    "cli.js",
    "client.js",
    "commands.js",
    "index.js",
    "renderer.js",
    "selectors.js",
    "session.js",
    "package.json",
    "README.md",
    "LICENSE"
  ]
}
```

可执行步骤：

```bash
npm i -D vitest
npm pkg set scripts.check="node --check *.js"
npm pkg set scripts.test="vitest run"
npm pkg set scripts.test:watch="vitest"
npm pkg set scripts.pack:dry="npm pack --dry-run"
```

---

## 2. 新增 `errors.js`

### 目标

统一 CLI、adapter、backend API、Puppeteer timeout 的错误表达。

### 建议实现

```js
class ChatGPTCliError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.cause = options.cause;
    this.context = options.context || {};
    this.retryable = Boolean(options.retryable);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        context: this.context,
      },
    };
  }
}

class UserInputError extends ChatGPTCliError {}
class AdapterError extends ChatGPTCliError {}
class AuthError extends ChatGPTCliError {}
class BackendApiError extends ChatGPTCliError {}
class TimeoutError extends ChatGPTCliError {}
class SelectorNotFoundError extends ChatGPTCliError {}

module.exports = {
  ChatGPTCliError,
  UserInputError,
  AdapterError,
  AuthError,
  BackendApiError,
  TimeoutError,
  SelectorNotFoundError,
};
```

然后在 `cli.js` 里统一处理：

```js
function printError(err, json = false) {
  if (json && typeof err.toJSON === 'function') {
    console.error(JSON.stringify(err.toJSON(), null, 2));
    return;
  }
  console.error(`错误: ${err.message}`);
}
```

---

## 3. `cli.js`

### 修改目标

- 可测试；
- 不在业务函数里 `process.exit()`；
- 参数解析稳定；
- 连接清理可靠；
- JSON 错误结构化。

### 步骤

1. 把入口包起来：

```js
if (require.main === module) {
  main(process.argv).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  runNonInteractive,
  runInteractive,
  initSession,
};
```

2. 把 `initSession()` 放进 `try/finally`：

```js
async function runNonInteractive(opts) {
  loadModules();

  try {
    await initSession(opts, log);
    return await dispatchNonInteractive(opts);
  } finally {
    await session?.client?.disconnect?.().catch(() => {});
  }
}
```

3. 把重复打开 conversation 的代码抽成：

```js
async function openConversationIntoSession(session, adapter, convRef) {
  const convId = convRef.includes('/')
    ? adapter.extractConversationId(convRef)
    : convRef;

  if (session.hasProject) {
    session.setConversation(await session.project.openConversation(convId));
  } else {
    const conversation = await session.client.openConversation(convId);
    session.setConversation(conversation);
  }

  return convId;
}
```

4. 增加 `send --file`：

```bash
chatgpt-cli send "分析这个文件" --file ./a.txt --file ./b.md
```

对应逻辑：

```js
if (files.length) {
  if (session.hasConversation) {
    reply = await session.conversation.sendWithFiles(message, files);
  } else if (session.hasProject) {
    const result = await session.project.newConversationWithFiles(message, files);
    reply = result.reply;
    session.setConversation(result.conversation);
  } else {
    throw new UserInputError('PROJECT_REQUIRED_FOR_FILES', '发送文件需要先指定 --project 或 --conversation');
  }
}
```

---

## 4. `commands.js`

### 当前问题

`/upload <file>` 默认上传为“对话附件”，但并不会自动附加到下一条消息。用户体验上这是危险的：用户以为已经给对话上传了文件，但后续消息未必引用它。

### 修改方案

二选一。

### 方案 A：删除“仅上传为对话附件”命令

只保留：

```bash
/upload <file> --project
```

附件发送走：

```bash
/new --file ./a.txt 问题
/send --file ./a.txt 问题
```

### 方案 B：增加 staged attachments

**文件：`session.js`**

```js
constructor() {
  ...
  this.pendingAttachments = [];
}

stageAttachment(file) {
  this.pendingAttachments.push(file);
}

consumeAttachments() {
  const files = this.pendingAttachments;
  this.pendingAttachments = [];
  return files;
}
```

然后 `/upload` 默认变成“暂存到下一条消息”：

```js
const result = await session.project.uploadConversationAttachment(absPath);
session.stageAttachment({ path: absPath, uploaded: result });
print(R.ok(`已暂存附件，将随下一条消息发送: ${result.fileName}`));
```

发送消息时消费 staged attachments。

我建议方案 A，语义更清楚，测试成本更低。

---

## 5. `adapter.js`

### 优先修改点

| 优先级 | 修改 | 原因 |
|---|---|---|
| P0 | `sendMessageWithFiles()` 用 `try/finally` 清理 CDP | 避免 Fetch 拦截残留 |
| P0 | `_waitForReply()` 必须确认新 assistant 消息 | 避免返回旧回复 |
| P0 | `getAccessToken()` 检查空 token | 登录过期时给明确错误 |
| P1 | 提取 `setComposerText()` | 减少重复和 DOM 空指针 |
| P1 | backend API 错误统一成 `BackendApiError` | 方便 CLI JSON 输出 |
| P1 | 文件上传加大小限制或改 Node 侧上传 | 避免内存暴涨 |
| P2 | 拆成多个文件 | 降低维护成本 |

### 推荐拆分

```text
adapter/
  index.js
  navigation.js
  composer.js
  model.js
  status.js
  snapshot.js
  files-api.js
  project-files.js
  normalize.js
  selectors-utils.js
```

短期可以不移动路径，先导出内部函数用于测试：

```js
module.exports._private = {
  normalizeFileCandidate,
  normalizeConversationApiPayload,
  mergeConversationSnapshots,
  buildProjectUpsertPayload,
  shouldIndexProjectFile,
};
```

测试稳定后再拆文件。

---

## 6. `selectors.js`

### 当前问题

选择器集中是好事，但还缺少：

- 错误 toast/banner 选择器；
- 登录状态选择器；
- disabled composer 状态；
- selector fallback 工具；
- selector contract tests。

### 修改

```js
errors: {
  toast: '[data-testid="toast"], [role="alert"]',
  loginRequired: 'a[href*="/auth/login"], button:has-text("Log in")'
},
composer: {
  textarea: '#prompt-textarea, [contenteditable="true"][data-testid="prompt-textarea"]',
  sendBtn: '[data-testid="send-button"], button[aria-label*="Send"]',
  stopBtn: '[data-testid="stop-button"], button[aria-label*="Stop"]'
}
```

注意：原生 CSS 不支持 `:has-text()`，如果放在 `querySelector` 会报错。应把“文本匹配 fallback”放进 `page.evaluate()`，不要写进普通 CSS selector。

---

## 7. `browser.js`

### 当前问题

`connect()` 只复用第一个 ChatGPT tab 或 pages[0]，没有检查：

- 目标 page 是否已关闭；
- 是否登录；
- 是否在 unsupported browser/profile；
- 多个 ChatGPT tab 时选择哪个。

### 修改

```js
async function connect(browserURL, options = {}) {
  const browser = await puppeteer.connect(...);
  const pages = await browser.pages();

  let page = pages.find((p) => p.url().startsWith('https://chatgpt.com'));
  if (!page) {
    page = await browser.newPage();
    await page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded' });
  }

  page.setDefaultTimeout(options.timeout ?? 30_000);
  page.setDefaultNavigationTimeout(options.navigationTimeout ?? 30_000);

  return { browser, page };
}
```

---

## 8. `auto-connect.js`

### 当前问题

- 强假设 WSL + Windows + PowerShell。
- `PORT` 未严格校验，进入 shell 命令。
- 大量 `catch {}` 吞掉系统命令失败原因。
- 不支持 `CHATGPT_BROWSER_URL` 快速路径。
- 不加载 `.env`。

### 修改

1. 增加 `config.js`：

```js
function loadConfig() {
  return {
    browserURL: process.env.CHATGPT_BROWSER_URL || null,
    port: assertPort(process.env.CHATGPT_PORT || '9224'),
    profileDir: process.env.CHATGPT_PROFILE_DIR || 'C:\\chrome-cdp-profile',
    chromeWin: process.env.CHROME_WIN || null,
  };
}
```

2. 校验端口：

```js
function assertPort(value) {
  if (!/^\d{2,5}$/.test(value)) throw new Error(`非法端口: ${value}`);
  const n = Number(value);
  if (n < 1 || n > 65535) throw new Error(`非法端口: ${value}`);
  return String(n);
}
```

3. 保留 WSL 自动化，但只在未显式指定 browser URL 时启用。

---

## 9. `wait-conversation.js`

### 当前问题

- 内置真实 conversation URL：`wait-conversation.js:19-23`
- 直接访问 `client._page`：`wait-conversation.js:112-117`
- 更像调试脚本，不应进入正式 npm 包。

### 修改

1. 删除默认真实 URL，改成必填参数：

```js
if (!process.argv[2]) {
  throw new UserInputError('CONVERSATION_REQUIRED', '请提供 conversation URL 或 ID');
}
```

2. 走 public API：

```js
const conversation = await client.openConversation(conversationId, { projectPath });
```

3. 如果保留为调试脚本，放到：

```text
scripts/wait-conversation.js
```

并从 npm `files` 里排除。

---

## 10. `example.js`

### 当前问题

硬编码：

```js
const BROWSER_URL = 'http://192.168.1.62:9224';
const PROJECT_NAME = 'GhostVM';
const MODEL_NAME = 'GPT-5';
```

### 修改

```js
const BROWSER_URL = process.env.CHATGPT_BROWSER_URL;
const PROJECT_NAME = process.env.CHATGPT_PROJECT;
const MODEL_NAME = process.env.CHATGPT_MODEL || 'GPT-4o';

if (!BROWSER_URL || !PROJECT_NAME) {
  throw new Error('请设置 CHATGPT_BROWSER_URL 和 CHATGPT_PROJECT');
}
```

并把文件移动到：

```text
examples/basic.js
```

---

## 11. `setup-and-verify.sh`

### 当前问题

`.gitignore` 排除了它，但 tar 包里包含了它。它还硬编码了 Windows Chrome 路径：

```bash
CHROME_WIN="${CHROME_WIN:-C:\\Users\\25129\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe}"
```

### 修改

1. 不写死用户名路径：

```bash
CHROME_WIN="${CHROME_WIN:-}"
if [[ -z "$CHROME_WIN" ]]; then
  CHROME_WIN="$(powershell.exe -NoProfile -Command "(Get-ChildItem 'C:\Users\*\AppData\Local\Google\Chrome\Application\chrome.exe' -ErrorAction SilentlyContinue | Select-Object -First 1).FullName" | tr -d '\r')"
fi
```

2. 如果项目不加载 `.env`，不要只写 `.env`，还要在输出中明确：

```bash
export CHATGPT_BROWSER_URL="${BROWSER_URL}"
```

3. 或者在 Node 项目中正式引入 dotenv。

---

# 测试缺口与可执行测试计划

## 1. 新建测试目录

```text
test/
  args.test.js
  session.test.js
  url.test.js
  normalize.test.js
  snapshot.test.js
  adapter-send.test.js
  adapter-files.test.js
  cli-json.test.js
  renderer.test.js
  fixtures/
    conversation-api.json
    conversation-dom.html
```

---

## 2. 立即可写的纯单元测试

### `test/url.test.js`

覆盖：

- `extractConversationId()`
- `extractProjectId()`
- `extractProjectPath()`

场景：

```js
expect(extractConversationId('https://chatgpt.com/c/abc-123')).toBe('abc-123');
expect(() => extractConversationId('https://chatgpt.com/')).toThrow();
```

### `test/session.test.js`

覆盖：

- `setClient()`
- `setProject()` 会清空 conversation
- `setConversation()`
- `clearProject()`
- `summary()`

### `test/normalize.test.js`

需要先导出 `_private`：

- `normalizeFileCandidate()`
- `normalizeConversationApiPayload()`
- `mergeConversationSnapshots()`
- `dedupeFiles()`
- `buildProjectUpsertPayload()`

---

## 3. Puppeteer mock 测试

不需要真 Chrome，做 fake page：

```js
function createFakePage(overrides = {}) {
  return {
    url: () => overrides.url || 'https://chatgpt.com/',
    waitForSelector: vi.fn(),
    waitForFunction: vi.fn(),
    evaluate: vi.fn(),
    keyboard: { press: vi.fn() },
    createCDPSession: vi.fn(),
    ...overrides,
  };
}
```

重点测试：

| 测试 | 预期 |
|---|---|
| `sendMessage()` 发送后 assistant 数量不增加 | 抛错，不返回旧消息 |
| `sendMessage()` send button 不存在 | fallback Enter 后仍等待新消息 |
| `sendMessageWithFiles()` `_waitForReply` 抛错 | CDP `Fetch.disable` 和 `detach` 仍被调用 |
| `sendMessageWithFiles()` 没有拦截到 request | 抛 `ATTACHMENT_INJECTION_MISSED` |
| `getAccessToken()` 返回空 | 抛 `AuthError` |
| backend 401/403/429 | 抛 `BackendApiError`，带 status |

---

## 4. CLI 测试

需要 `cli.js` 不再顶层自动执行。

测试：

```bash
chatgpt-cli --help
chatgpt-cli send "hello"
chatgpt-cli --json send "hello"
chatgpt-cli send --file a.txt "summarize"
chatgpt-cli --project P upload a.txt --project
chatgpt-cli snapshot abc -o out.json
```

断言：

- stdout/stderr 分离；
- JSON 模式 stdout 只输出 JSON；
- 错误时 exit code 为 1；
- JSON 错误格式稳定；
- 不连接真实浏览器时可 mock runner。

---

# 建议执行顺序

## 第 1 步：先建立测试地基

修改：

- `package.json`
- 新增 `test/`
- 让 `cli.js` 可被 `require()` 而不自动运行

完成标准：

```bash
npm test
npm run check
```

都能跑。

---

## 第 2 步：修复高风险运行时问题

修改：

- `adapter.js`
  - CDP cleanup 放进 `finally`
  - `_waitForReply()` 不允许返回旧消息
  - `getAccessToken()` 检查 token
- `auto-connect.js`
  - 优先使用 `CHATGPT_BROWSER_URL`

完成标准：

```bash
npm test
node --check *.js
```

并手动跑：

```bash
CHATGPT_BROWSER_URL=http://127.0.0.1:9224 node cli.js --json send "ping"
```

---

## 第 3 步：整理 CLI 与 API 边界

修改：

- `client.js`
  - 增加 `send()`, `openConversation()`, `selectModel()` 等 public 方法
- `cli.js`
- `commands.js`
- `wait-conversation.js`

目标：删除所有外部直接访问：

```js
._page
```

完成标准：

```bash
grep -R "_page" cli.js commands.js wait-conversation.js
```

应无结果。

---

## 第 4 步：修复文件附件语义

选择一种：

- 推荐：新增 `send --file`，弱化或删除 `/upload` 默认附件语义。
- 或：实现 staged attachments。

完成标准：

```bash
chatgpt-cli --project MyProject send "总结这个文件" --file ./README.md
```

返回中应包含真实附件上下文。

---

## 第 5 步：拆分 adapter

最后再拆：

```text
adapter.js
→ adapter/navigation.js
→ adapter/composer.js
→ adapter/files-api.js
→ adapter/project-files.js
→ adapter/snapshot.js
→ adapter/status.js
```

不要第一步就拆，否则会在没有测试的情况下扩大变更面。
