# ChatGPT CLI

通过 Chrome 远程调试协议驱动网页版 ChatGPT 的命令行工具。无需 API Key，复用浏览器登录态。

## 简介

ChatGPT CLI 利用 Chrome DevTools Protocol（CDP）附着到已登录的 Chrome 浏览器实例，将网页版 ChatGPT 的全部能力封装为程序化接口。支持交互式 REPL 和非交互式单次调用两种模式，可作为独立工具使用，也可被 Codex、Cursor 等 AI CLI 工具集成。

```
Node.js (puppeteer-core)
    │  WebSocket (CDP)
    ▼
Chrome (--remote-debugging-port=9224)
    │  已登录的 Cookie / Session
    ▼
chatgpt.com
```

## 两种使用模式

| 模式 | 启动方式 | 适用场景 |
|------|----------|----------|
| **交互模式（REPL）** | `chatgpt-cli` | 人工在终端中对话，支持斜杠命令、Tab 补全、多行输入 |
| **非交互模式** | `chatgpt-cli send "..."` | 被 Codex、Cursor 等 AI CLI 工具调用，单次执行后退出，支持 `--json` 结构化输出和 stdin 管道 |

## 功能特性

- **零配置启动** — 自动探测环境、启动 Chrome、设置端口转发、等待登录
- **项目管理** — 创建新项目、切换项目、上传/删除项目文件（Sources）
- **对话操作** — 新建、打开、发送消息、导出快照
- **模型切换** — 模糊匹配选择模型（GPT-4o、GPT-5 等）
- **文件上传** — 支持对话附件和项目 Sources 两种模式
- **非交互模式** — 被 Codex / Cursor 等工具在终端中直接调用，`--json` 输出便于程序解析
- **stdin 管道** — `echo "问题" | chatgpt-cli --json send`
- **Tab 补全** — 输入 `/` 后按 Tab 自动补全命令

## 技术栈

- **运行时**: Node.js (CommonJS)
- **浏览器控制**: puppeteer-core + Chrome DevTools Protocol
- **终端 UI**: readline, chalk, ora, marked + marked-terminal
- **平台**: WSL2 + Windows Chrome

## 安装

```bash
git clone git@github.com:ADaozz/chatgpt_cli.git
cd chatgpt_cli
npm install
```

全局安装（可选）：

```bash
npm link
```

## 环境要求

- Node.js >= 18
- Windows 上安装有 Google Chrome
- WSL2（如果在 Linux 端运行）

## 运行

```bash
node cli.js
```

或全局安装后：

```bash
chatgpt-cli
```

启动后自动完成：

1. 探测 WSL 宿主机 IP，设置代理排除
2. 查找并启动 Chrome（独立 profile，带远程调试端口）
3. 设置 netsh 端口转发（Chrome 147+ 强制绑 localhost）
4. 添加防火墙入站规则
5. 轮询等待 ChatGPT 登录态

首次使用需要在弹出的 Chrome 窗口中登录 ChatGPT，之后会自动检测到登录态并进入交互界面。

## 使用说明

### 交互模式（REPL）

直接运行 `chatgpt-cli` 进入交互式对话界面：

```
$ chatgpt-cli

  ChatGPT CLI  — 通过 Chrome 驱动网页版 ChatGPT

✔ 已连接 ChatGPT

● > /newproject graduation-project
[OK] 已创建并进入项目: graduation-project

● (graduation-project) > /model GPT-4o
[OK] 模型: GPT-4o

● (GPT-4o · graduation-project) > 帮我分析这段代码的性能瓶颈
对话 ID: 69f173d4-...

这段代码主要有以下几个性能问题：
...

● (GPT-4o · graduation-project · 69f173d4) > /upload ./data.csv --project
[OK] data.csv (1234 bytes)

● (GPT-4o · graduation-project · 69f173d4) > /snapshot output.json
[OK] 已保存: output.json (5 messages, 1 files)
```

可用命令：

| 命令 | 说明 |
|------|------|
| `/project <name>` | 切换或查看当前项目（支持名称模糊匹配、hex id、完整 URL） |
| `/newproject <name>` | 创建新项目并切换进去 |
| `/model <name>` | 切换或查看当前模型（模糊匹配） |
| `/new [message]` | 开启新对话 |
| `/open <id \| url>` | 打开已有对话 |
| `/upload <path> [--project]` | 上传文件（默认对话附件，`--project` 上传到项目 Sources） |
| `/delete <name \| id>` | 删除项目文件 |
| `/snapshot [path]` | 导出当前对话快照为 JSON |
| `/status` | 查看对话生成状态 |
| `/messages` | 显示对话消息列表 |
| `/files` | 列出对话涉及的文件 |
| `/help [command]` | 显示帮助，可查看单个命令详情 |

直接输入文本即发送消息。多行输入以 `{{` 开始、`}}` 结束。Tab 键补全命令。Ctrl+C 退出。

### 非交互模式（供外部工具调用）

适用于脚本调用、CI/CD 或被 Codex/Cursor 等工具集成，单次执行后退出。

```bash
chatgpt-cli send <message>                    # 发送消息，输出回复
chatgpt-cli upload <path> [--project]         # 上传文件
chatgpt-cli snapshot <conv_id> [-o file]      # 导出对话快照
chatgpt-cli status <conv_id>                  # 查看对话状态
chatgpt-cli messages <conv_id>                # 列出对话消息
```

全局选项：

| 选项 | 说明 |
|------|------|
| `--project <name>` | 指定项目（侧边栏模糊匹配、hex id、完整路径均可） |
| `--new-project` | 与 `--project` 搭配，强制创建新项目而非匹配已有项目 |
| `--model <name>` | 指定模型 |
| `--conversation <id>` | 在已有对话中继续 |
| `--json` | JSON 格式输出（适合程序解析） |
| `-h, --help` | 显示帮助 |

示例：

```bash
# 单次提问
chatgpt-cli send "1+1等于几？"

# 指定项目和模型
chatgpt-cli --project GhostVM --model GPT-5 send "分析架构"

# 在已有对话中继续，JSON 输出
chatgpt-cli --json --conversation 69f17f25-... send "继续"

# 导出对话快照
chatgpt-cli --json snapshot 69f17f25-... -o out.json

# 管道输入
echo "总结一下这段代码" | chatgpt-cli --json send
```

`--json` 模式下 `send` 返回：

```json
{
  "reply": "回复内容",
  "conversationId": "69f17f25-...",
  "project": "GhostVM",
  "model": "GPT-5"
}
```

退出码：`0` 成功，`1` 失败（错误信息输出到 stderr）。

### 项目匹配规则

`--project` 参数支持多种输入格式，按以下优先级匹配：

1. **完整 URL** — `https://chatgpt.com/g/g-p-69a...3d-myproj/project`
2. **路径** — `/g/g-p-69a...3d-myproj/project`
3. **Project hex id** — `69a4014b9f5881919b68c81a6bbeda3d`
4. **侧边栏名称** — 在链接 href slug 和显示文案中模糊匹配（不区分大小写）

找不到时会列出当前页面可见的项目名和路径，便于排查。

## 项目结构

```
ChatGPTCLI/
├── cli.js             # 入口，REPL 主循环 + 非交互模式
├── commands.js        # 斜杠命令定义与执行
├── renderer.js        # Markdown 终端渲染
├── session.js         # 会话状态管理
├── auto-connect.js    # 启动自动化（Chrome 启动、端口转发、登录检测）
├── client.js          # 公开 API 层（ChatGPTClient / Project / Conversation）
├── adapter.js         # ChatGPT DOM 操作 + backend-api 调用
├── browser.js         # puppeteer 连接传输层
├── selectors.js       # DOM 选择器集中管理
├── index.js           # 包入口，re-export client
├── package.json
└── README.md
```

## 配置

通过环境变量自定义行为：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `CHATGPT_PORT` | Chrome 远程调试端口 | `9224` |
| `CHATGPT_PROFILE_DIR` | Chrome 独立 profile 目录 | `C:\chrome-cdp-profile` |
| `CHROME_WIN` | Chrome 可执行文件路径 | 自动探测 |
| `CHROME_PROXY` | 传递给 Chrome 的代理地址 | 读取 `HTTPS_PROXY` |

## 作为库使用

```js
const { ChatGPTClient } = require('chatgpt-cli');

const client = await ChatGPTClient.create('http://<WSL_HOST_IP>:9224');

// 创建新项目
const project = await client.createProject('my-project');

// 或选择已有项目
const existing = await client.selectProject('GhostVM');

// 发起对话
const { conversation, reply } = await project.newConversation('Hello!');
console.log(reply);

await client.disconnect();
```

## License

ISC
