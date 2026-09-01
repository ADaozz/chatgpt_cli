# ChatGPT CLI

通过 Chrome 远程调试协议（CDP）驱动网页版 ChatGPT 的命令行工具。**无需 OpenAI API Key**，复用浏览器登录态，支持交互式 REPL 与脚本化非交互调用。

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

## 它能做什么

- 在终端里与网页版 ChatGPT 对话，或使用 `--json` 供 Codex、Cursor 等工具集成
- 管理 ChatGPT **项目**（创建、切换、上传/删除 Sources 文件）
- 自动选用账号可用的**最高级模型**，也可手动指定或模糊匹配
- 导出对话快照、轮询生成状态、管道 stdin 输入

```
Node.js (chatgpt-cli)
    │  WebSocket (CDP)
    ▼
Chrome (--remote-debugging-port=9224)
    │  Cookie / Session（已登录 chatgpt.com）
    ▼
chatgpt.com  ← DOM 操作 + backend-api 调用
```

## 两种模式

| 模式 | 启动方式 | 适用场景 |
|------|----------|----------|
| **交互 REPL** | `chatgpt-cli` | 人工对话、斜杠命令、Tab 补全、多行输入 |
| **非交互** | `chatgpt-cli send "..."` | 脚本、CI、被其他 CLI 单次调用，`--json` 结构化输出 |

## 安装

```bash
git clone git@github.com:ADaozz/chatgpt_cli.git
cd chatgpt_cli
npm install
```

全局命令（可选）：

```bash
npm link
# 之后可直接运行 chatgpt-cli
```

## 环境要求

- **Node.js** ≥ 18
- **Google Chrome**（Windows 上安装；WSL2 下通过 CDP 连接宿主机 Chrome）
- 已在 Chrome 中登录 [chatgpt.com](https://chatgpt.com)

## 快速开始

```bash
node cli.js
# 或
chatgpt-cli
```

首次启动会自动：

1. 解析 WSL 宿主机 IP，设置 `NO_PROXY` 绕过
2. 查找/启动 Chrome（独立 profile + 远程调试端口）
3. 必要时配置 `netsh` 端口转发与防火墙规则（Chrome 147+ 默认只监听 localhost）
4. 轮询等待 ChatGPT 登录态，然后进入 REPL

若 Chrome 已在其他环境以调试模式运行，可跳过自动启动：

```bash
export CHATGPT_BROWSER_URL=http://127.0.0.1:9224
chatgpt-cli
```

## 交互模式示例

```
$ chatgpt-cli

  ChatGPT CLI  — 通过 Chrome 驱动网页版 ChatGPT

✔ 已连接 ChatGPT
自动选择最高级模型...
使用模型: GPT-5.6 Thinking (gpt-5-6-thinking)

● > /newproject my-app
[OK] 已创建并进入项目: my-app

● (my-app) > /model
当前模型: GPT-5.6 Thinking (gpt-5-6-thinking)
可用模型:
  GPT-5.6 Thinking (gpt-5-6-thinking) ★
  GPT-4o (gpt-4o)
  ...

● (my-app) > 分析这段代码的性能瓶颈
对话 ID: 69f173d4-...

● (my-app · 69f173d4) > /upload ./data.csv --project
[OK] data.csv (1234 bytes)

● (my-app · 69f173d4) > /snapshot output.json
[OK] 已保存: output.json
```

直接输入文本即发送消息。多行输入以 `{{` 开始、`}}` 结束。输入 `/` 后按 **Tab** 补全命令。**Ctrl+C** 退出。

### 斜杠命令

| 命令 | 说明 |
|------|------|
| `/project <name>` | 切换或查看当前项目（名称模糊匹配、hex id、完整 URL） |
| `/newproject <name>` | 创建新项目并进入 |
| `/model [name\|best]` | 列出可用模型（★ 为最高级）、切换模型；`best`/`auto`/`highest` 自动选最高级 |
| `/new [message]` | 开启新对话 |
| `/open <id \| url>` | 打开已有对话 |
| `/upload <path> [--project]` | 上传文件（默认对话附件，`--project` 写入项目 Sources） |
| `/delete <name \| id>` | 删除项目文件 |
| `/snapshot [path]` | 导出当前对话快照为 JSON |
| `/status` | 查看对话生成状态 |
| `/messages` | 显示对话消息列表 |
| `/files` | 列出对话涉及的文件 |
| `/help [command]` | 帮助（可查看单条命令详情） |

## 非交互模式

```bash
chatgpt-cli send <message>              # 发送消息，输出回复
chatgpt-cli upload <path> [--project]   # 上传文件
chatgpt-cli snapshot <conv_id> [-o file]
chatgpt-cli status <conv_id> [--wait]
chatgpt-cli messages <conv_id>
```

### 全局选项

| 选项 | 说明 |
|------|------|
| `--project <name>` | 指定项目（侧边栏名、hex id、完整路径均可） |
| `--new-project` | 与 `--project` 搭配，强制创建新项目 |
| `--model <name>` | 指定模型；支持 `best` / `auto` / `highest` |
| `--conversation <id>` | 在已有对话中继续 |
| `--json` | JSON 格式输出 |
| `-h, --help` | 显示帮助 |

### 示例

```bash
# 单次提问（自动选最高级模型）
chatgpt-cli send "1+1 等于几？"

# 指定项目，JSON 输出
chatgpt-cli --json --project my-app send "分析架构"

# 固定模型
chatgpt-cli --project my-app --model GPT-4o send "写单元测试"

# 继续已有对话
chatgpt-cli --json --conversation 69f17f25-... send "继续"

# 等待对话生成完成
chatgpt-cli --json status 69f17f25-... --wait

# 管道输入
echo "总结这段代码" | chatgpt-cli --json send
```

`--json` 模式下 `send` 返回示例：

```json
{
  "reply": "回复内容",
  "conversationId": "69f17f25-...",
  "project": "my-app",
  "model": "GPT-5.6 Thinking"
}
```

退出码：`0` 成功，`1` 失败（错误信息在 stderr）。

## 模型选择

未指定 `--model` 时，CLI 会调用 `/backend-api/models`，按版本与能力评分自动选用账号可用的**最高级模型**（如 `gpt-5-6-thinking`），发送时通过 CDP 拦截 `f/conversation` 请求注入 `model` 字段。

| 方式 | 说明 |
|------|------|
| 默认 | 启动后自动选最高级 |
| `/model best` 或 `--model best` | 显式选最高级 |
| `/model GPT-4o` | 按显示名模糊匹配 |
| `CHATGPT_AUTO_MODEL=0` | 关闭自动选择，沿用页面当前模型 |

REPL 中执行 `/model`（无参数）可查看完整列表，最高级模型旁标有 **★**。

## 项目匹配规则

`--project` / `/project` 按以下优先级匹配：

1. **完整 URL** — `https://chatgpt.com/g/g-p-69a.../project`
2. **路径** — `/g/g-p-69a.../project`
3. **Project hex id** — `69a4014b9f5881919b68c81a6bbeda3d`
4. **侧边栏名称** — 在链接 slug 与显示文案中模糊匹配（不区分大小写）

找不到时会列出侧边栏可见项目名，便于排查。新版 ChatGPT 侧边栏（`.project-unfurl-row`）亦已适配。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `CHATGPT_PORT` | Chrome 远程调试端口 | `9224` |
| `CHATGPT_BROWSER_URL` | 已有 Chrome 调试地址（跳过自动启动） | — |
| `CHATGPT_PROFILE_DIR` | Chrome 独立 profile 目录 | `C:\chrome-cdp-profile` |
| `CHATGPT_AUTO_MODEL` | 设为 `0` 关闭自动选最高级模型 | 启用 |
| `CHROME_WIN` | Chrome 可执行文件路径 | 自动探测 |
| `CHROME_PROXY` | 传给 Chrome 的代理 | 读取 `HTTPS_PROXY` |
| `POWERSHELL_EXE` | WSL 下 PowerShell 路径（netsh/防火墙） | 自动探测 |

WSL 连接宿主机 Chrome 失败时，可将宿主机 IP 加入代理绕过：

```bash
export NO_PROXY="${NO_PROXY},<WSL_HOST_IP>,localhost,127.0.0.1,::1"
```

## 项目结构

```
chatgpt_cli/
├── cli.js              # 入口：REPL + 非交互子命令
├── commands.js         # 斜杠命令
├── session.js          # 会话状态
├── auto-connect.js     # Chrome 启动、端口转发、登录检测
├── client.js           # 公开 API（ChatGPTClient / Project / Conversation）
├── adapter.js          # DOM 操作、backend-api、模型与项目导航
├── browser.js          # puppeteer 连接
├── selectors.js        # DOM 选择器
├── renderer.js         # Markdown 终端渲染
├── wait-conversation.js
├── index.js            # npm 包入口
└── package.json
```

## 作为库使用

```js
const { ChatGPTClient } = require('chatgpt-cli');

const client = await ChatGPTClient.create('http://<WSL_HOST_IP>:9224');

const project = await client.createProject('my-project');
// 或: await client.selectProject('my-project');

const { conversation, reply } = await project.newConversation('Hello!');
console.log(reply);

await client.disconnect();
```

## 技术栈

- **运行时**: Node.js (CommonJS)
- **浏览器控制**: puppeteer-core + Chrome DevTools Protocol
- **终端**: readline, chalk, ora, marked + marked-terminal
- **典型环境**: WSL2 + Windows Chrome

## 相关文档

仓库内 `.cursor/skills/chatgpt-driven-iteration/` 提供了用本 CLI 驱动 ChatGPT 做项目迭代分析的工作流技能（打包上传、轮询状态、落盘回复等）。

## License

[ISC](LICENSE)
