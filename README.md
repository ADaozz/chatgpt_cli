# ChatGPT CLI (v2)

通过 Chrome 远程调试协议（CDP）驱动网页版 ChatGPT 的命令行工具。**无需 OpenAI API Key**，复用浏览器登录态，支持交互式 REPL 与脚本化非交互调用。

> **v2 破坏性重构（2026-10-28）**：网页适配层已按当前 ChatGPT Web 实机契约重写。
> 不再支持旧版 DOM / 旧会话读取协议 / 按版本号自动选模型。升级前请阅读
> [v2 变更](#v2-变更破坏性) 与 [已知边界](#已知边界)。

## 它能做什么

- 在终端里与网页版 ChatGPT 对话，或使用 `--json` 供其他工具集成
- 管理 ChatGPT **项目**（创建、切换、上传/删除 Sources 文件）
- 模型与思考强度按当前账号真实菜单选择（默认：最新模型 + 最高强度）
- 协议确认的回复完成判定（Thinking / 工具调用期间绝不误报完成）
- 导出对话快照（分页读全；未读全明确标记 `partial`）
- 内置实机诊断工具（`npm run probe:chatgpt` / `npm run check:selectors`）

```
Node.js (chatgpt-cli)
    │  WebSocket (CDP)
    ▼
Chrome (--remote-debugging-port=9224)
    │  Cookie / Session（已登录 chatgpt.com）
    ▼
chatgpt.com  ← DOM 操作 + 现行 backend-api 协议
```

## 架构（v2）

```
CLI / REPL  (cli.js · commands.js)
    │
ChatGPTClient  (client.js：调度、会话上下文、错误处理)
    ├── BrowserSession      browser.js（CDP 连接，Puppeteer）
    ├── PageController      page-controller.js（DOM 操作 + 采样器）
    ├── WebProtocol         web-protocol.js（现行请求/响应 + 分页 + 错误映射）
    ├── ModelController     model-controller.js（模型 + 思考强度，UI 验证）
    ├── ProjectController   project-controller.js（项目导航/创建）
    ├── FileController      file-controller.js（对话附件 / 项目 Sources）
    └── ResponseTracker     response-tracker.js（协议确认的状态机）
                │
        conversation-parser.js（线性 messages → 快照/分支/完成信号）
        selectors.js（唯一 DOM 选择器来源，全部来自实机采集）
```

边界约束：业务模块不得直接 `querySelector` 或调用 backend-api；DOM 定位失败抛
`DOM_CHANGED`，协议失败抛类型化 `ProtocolError`，不静默返回空结果。

## 安装

```bash
git clone git@github.com:ADaozz/chatgpt_cli.git
cd chatgpt_cli
npm install
npm link      # 可选：全局 chatgpt-cli 命令
```

环境要求：Node.js ≥ 18、Google Chrome（已登录 chatgpt.com）。
WSL2 下通过 CDP 连接宿主机 Chrome（自动启动/端口转发逻辑保留在 `auto-connect.js`）。

## 快速开始

```bash
node cli.js                 # 交互 REPL
chatgpt-cli send "你好"     # 非交互
```

首次启动会自动：解析 WSL 宿主机 IP → 查找/启动 Chrome（独立 profile + 调试端口）
→ 必要时配置端口转发 → 确认登录态。

若 Chrome 已在调试模式运行：

```bash
export CHATGPT_BROWSER_URL=http://127.0.0.1:9224
chatgpt-cli
```

## 模型与思考强度（v2）

- **默认策略**：不指定 `--model` / `--effort` 时，自动选择**当前账号菜单中的最新模型 + 最高思考强度**（实测：GPT-6 + 高强度 → 请求 `model=gpt-6-thinking`、`thinking_effort=extended`）。
- **显式指定**：按真实菜单匹配并验证；不存在的模型/档位直接报错，**不降级、不静默切换**。
- 模型与强度是一组耦合配置（不同强度对应不同请求模型），以页面实际选择为准。

```bash
chatgpt-cli send "你好"                                  # 默认：最新 + 最高
chatgpt-cli --model GPT-6 --effort high send "分析代码"   # 显式配置
chatgpt-cli --model GPT-6 --effort pro send "..."        # 无权限 → 直接失败
```

`--effort` 合法值由当前账号实际档位决定：`none|instant|medium|high|max` 或档位序号。

## 非交互命令

```bash
chatgpt-cli [options] <command> [args]
```

| 命令 | 说明 |
|------|------|
| `start <message>` | 发送消息，立即返回 `conversationId`（不等待回复） |
| `send <message>` | 发送消息，协议确认完成后输出回复 |
| `status <conv_id> [--wait]` | 查看状态；`--wait` 阻塞到协议确认终态 |
| `messages <conv_id>` | 列出对话消息 |
| `snapshot <conv_id> [-o file]` | 导出对话快照（分页读全，或标记 `partial`） |
| `upload <path> [--project]` | 上传文件（默认对话附件；`--project` 写入 Sources） |

全局选项：`--project <name>`、`--new-project`、`--model`、`--effort`、
`--conversation <id>`、`--json`、`--timeout-ms`、`--poll-ms`、
`-h/--help`、`-v/--version`（打印版本号后立即退出，不建立浏览器连接）。

### JSON 结果（v2）

```json
{
  "conversationId": "example-id",
  "state": "completed",
  "completionSource": "protocol",
  "model": { "name": "GPT-6", "effort": "high" },
  "reply": {
    "text": "最终回复",
    "blocks": [],
    "hasUnsupportedContent": false
  },
  "partial": false,
  "error": null
}
```

`completionSource` 表示完成判定来源：

- `protocol`：协议确认终态（首选）；
- `dom`：协议不可用（网络断开/5xx/429/401 等）时，使用 DOM 证据
  （turn 完成 + 停止按钮消失 + 复制按钮挂载 + 文本稳定）交付。这是
  v1.2.2「复制按钮 + 发送按钮恢复」判定路径的回归，`partial: true` 且
  `error` 会说明协议失败原因；协议明确「仍在生成」时绝不会走此路径。

`state` 取值：

| state | 含义 |
|-------|------|
| `completed` | 协议确认：当前 turn 已终止，最终回复读取成功 |
| `cancelled` | 协议显示思考中断且无最终回复，DOM 也已停止生成（保守启发式） |
| `timeout` | 超时且无可用部分文本 |
| `unknown` | 超时/协议持续失败，但保留了部分文本（**不声称成功**） |

`send` 与 `status --wait` 在非 `completed` 时返回**非零退出码**（JSON 仍输出完整结果）。
`reply.blocks` 记录已识别的结构化内容标记（如 `<WritingBlock>`）；无法渲染的富内容通过
`hasUnsupportedContent: true` 显式报告，不会静默丢弃。

## 交互模式示例

```
$ chatgpt-cli

  ChatGPT CLI
  Drive ChatGPT directly from your terminal.

✔ Chrome DevTools Protocol connected  http://<host>:9224
✔ 模型配置  GPT-6 · 思考强度 high

● > /newproject my-app
✓ 已创建并进入项目: my-app

● > /model
当前配置: 思考强度 高
可用模型（按菜单顺序，最新在前）:
  GPT-6 ✓
  GPT-5.6 Sol
思考强度档位: 0..2（当前 2）

● > 分析这段代码的性能瓶颈
...
```

| 命令 | 说明 |
|------|------|
| `/project <name>` | 切换或查看当前项目 |
| `/newproject <name>` | 创建新项目并进入 |
| `/model [name] [effort]` | 查看/切换模型与强度（默认最新+最高） |
| `/new [message]` | 开启新对话（带消息则发送并等待） |
| `/open <id \| url>` | 打开已有对话 |
| `/upload <path> [--project]` | 上传文件（默认对话附件，`--project` 写入 Sources） |
| `/delete <name \| id>` | 删除项目文件 |
| `/snapshot [path]` | 导出当前对话快照 |
| `/status` | 查看对话状态 |
| `/messages` | 显示对话消息列表 |

多行输入以 `{{` 开始、`}}` 结束；输入 `/` 后按 **Tab** 补全；**Ctrl+C** 退出。

## v2 变更（破坏性）

- **会话读取**：改用 `GET /backend-api/conversations/{id}?num_turns=N&include_has_versions=true`
  （需 Bearer）。响应为线性 `messages[]` + `page_info` 游标；当前分支通过
  `current_node` + `metadata.parent_id` 回溯，**不再按时间排序假设完整会话**。
  向前翻页用 `before=`，向后用 `after=`；未读全显式标记 `partial`。
- **完成判定**：首选协议确认（`channel="final"` + `end_turn=true` +
  `status="finished_successfully"` + 无 open reasoning + `async_status` 空闲）
  且最终结果读取成功；协议不可用时回退到 DOM 证据（turn complete + stop 消失 +
  复制按钮挂载 + 文本稳定）交付并标记 `completionSource: "dom"`。
  协议明确仍在生成时，DOM 信号不会提前判完成。
- **DOM 选择器**：`#prompt-textarea`、`data-message-author-role`、`article/section[data-turn]`、
  旧模型菜单等历史选择器已删除；新选择器来自 2026-10-28 实机采集
  （`docs/contracts/chatgpt-web-contract.md`）。
- **模型选择**：删除 `parseModelVersion/rankModelSlug/pickBestModelSlug` 与
  `CHATGPT_AUTO_MODEL`；改为「菜单最新 + 最高强度」默认策略。
- **模型注入**：删除 CDP 拦截后强制改写请求 `model` 字段；模型只通过页面菜单选择。
  （附件注入仍保留，标注 probe-pending。）
- **消息发送**：发送按钮不存在/不可用时返回 `DOM_CHANGED`，不再按 Enter 盲发。
- **429**：遵循 `Retry-After` 退避，不快速重试；持续失败返回 `unknown` 而不是假成功。
- **空快照**：协议失败不再静默返回空快照，而是抛出带类型的错误。
- **占位会话 id**：新会话在服务端 id 就绪前 URL 会短暂出现
  `/c/local-chatgpt`，v2 只接受 UUID 形式的真实 id，禁止用它读取协议。

## 诊断工具

```bash
# 只读探针：DOM / API / 模型菜单 / 请求捕获（需已登录 Chrome）
npm run probe:chatgpt -- --dom --api
npm run probe:chatgpt -- --model-menu --json
node scripts/probe-chatgpt.js --capture-request   # 等你手动发一条消息后抓请求体

# 选择器/契约诊断（只读，不发送消息）
npm run check:selectors
npm run check:selectors -- --inspect-menu --expect-effort high
```

采集数据默认**脱敏**（JWT/邮箱/账号 ID/会话内容），可提交的 fixtures 位于
`test/fixtures/`；原始抓包请勿提交到仓库。

## 测试

```bash
npm test
# 可选：在真实浏览器中对 DOM fixtures 验证选择器/采样器（不触碰用户对话）
CHATGPT_TEST_BROWSER_URL=http://<CDP地址> node --test test/dom-selectors.test.js
```

- CI/无浏览器：fixtures 驱动的纯逻辑测试（解析器、状态机、模型策略、协议分页）。
- 真实登录态：`npm run check:selectors` 与手动全链路回归。

## 已知边界

以下能力标注为 **probe-pending**，当前实现保守可用但尚未完成实机复核：

- 429 `Retry-After` 的真实触发行为（客户端已实现退避，未在实机强制复现）
- 用户主动停止生成后的协议终态字段（`cancelled` 为 DOM+协议双停滞的保守启发式）
- 项目 Sources 上传 / `gizmos/snorlax/upsert` 写载荷（沿用 v1.2.2 已验证实现）
- 侧栏项目行导航选择器（继承 v1.2.2，需下次实机采集复核）
- 附件 `metadata.attachments` 注入（沿用 v1.2.2）
- 无法识别的服务端新字段：解析层通过 `unknownFields` 报告，诊断工具会提示

## License

ISC
