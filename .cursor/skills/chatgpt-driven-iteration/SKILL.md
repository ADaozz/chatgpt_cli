---
name: chatgpt-driven-iteration
description: 通过 chatgpt-cli 驱动网页版 ChatGPT 对项目进行迭代式分析和修改。当用户要求用 ChatGPT 分析代码、提交迭代轮次、上传项目到 ChatGPT、等待 ChatGPT 对话完成、或执行 ChatGPT 给出的修改方案时使用。
---

# ChatGPT 驱动的迭代工作流

通过 chatgpt-cli 将项目源码上传至网页版 ChatGPT 项目，发起分析对话，等待完成后获取修改方案并执行。

## 前置条件

- chatgpt-cli 已安装并可用（`chatgpt-cli --help`）
- Chrome 已启动且 ChatGPT 已登录

## 约定与占位符

本技能中以下占位符由执行者按实际项目替换，**不要写死**：

| 占位符 | 含义 |
|--------|------|
| `<parent_dir>` | 含项目根目录的父路径 |
| `<project>` / `<project_name>` | 项目根目录名或 ChatGPT 侧边栏中的项目名 |
| `<archive_name>` | 上传用压缩包文件名（如 `MyApp_Iteration_N.zip`） |
| `<conversation_id>` | `send` 返回 JSON 中的 `conversationId` |
| `<model_name>` | 可选。模型显示名或别名（`best` / `auto` / `highest`）；省略时 CLI 自动选账号最高级 |
| `<turn_N>` / `N` | 迭代轮次编号 |

WSL 下若连接宿主机 Chrome 调试端口失败，可设置（示例）：

```bash
export NO_PROXY="${NO_PROXY},<WSL_HOST_IP>,localhost,127.0.0.1,::1"
```

**模型选择（默认自动）**：未指定 `--model` 时，CLI 会调用 `/backend-api/models` 并自动选用账号可用的最高级模型（如 `gpt-5-6-thinking`），发送时通过 API 注入 `model` 字段。若要关闭自动选择，设置 `CHATGPT_AUTO_MODEL=0`。交互模式中可用 `/model` 查看列表（★ 为最高级）或 `/model best` 切换。

## 工作流步骤

### 1. 打包项目源码

将目标目录压缩，排除构建产物和无关文件：

```bash
cd <parent_dir>
tar czf <archive_name>.tar.gz \
  --exclude='<project>/.git' \
  --exclude='<project>/node_modules' \
  --exclude='<project>/.build' \
  --exclude='<project>/build' \
  --exclude='<project>/.artifacts' \
  <project>
```

用户未指定排除项时，默认排除 `.git/`、`node_modules/`、`build/`、`.build/`、`dist/`、`.artifacts/`。

### 2. 上传到 ChatGPT 项目

先删除旧文件（如有），再上传新文件：

```bash
# 交互模式中删除旧文件
chatgpt-cli
> /project <project_name>
> /delete <old_file_name>

# 上传新文件到项目 Sources
chatgpt-cli --project <project_name> upload <archive_path> --project
```

### 3. 发起分析对话

指定项目并发送分析提示词。**模型可省略**（默认自动选最高级）；需要固定模型时再传 `--model`：

```bash
# 推荐：自动最高级模型
chatgpt-cli --json \
  --project <project_name> \
  send "<prompt>"

# 可选：显式指定模型或别名 best
chatgpt-cli --json \
  --project <project_name> \
  --model <model_name> \
  send "<prompt>"
```

从返回的 JSON 中提取 `conversationId`，后续步骤需要。

### 4. 等待对话完成

轮询检查状态，直到 `isResponding` 为 `false`：

```bash
chatgpt-cli --json status <conversation_id>
```

返回示例：

```json
{
  "state": "completed",
  "isResponding": false,
  "messageCount": 2,
  "assistantMessageCount": 1
}
```

**关键约束**：对话仍在生成时（`isResponding: true`），不得提取结果或开始下一步。长对话可能需要 30-50 分钟，持续轮询直到完成。

轮询脚本参考：

```bash
while true; do
  status=$(chatgpt-cli --json status <conversation_id> 2>/dev/null)
  responding=$(echo "$status" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).isResponding" 2>/dev/null)
  if [ "$responding" = "false" ]; then
    echo "对话已完成"
    break
  fi
  echo "等待中..."
  sleep 30
done
```

### 5. 获取结果并保存

对话完成后，获取完整消息或快照：

```bash
# 获取消息列表
chatgpt-cli --json messages <conversation_id> > messages.json

# 或导出完整快照
chatgpt-cli --json snapshot <conversation_id> -o snapshot.json
```

将 assistant 的最终回复写入指定文件（如 `turn_N.md`）。

**约束**：必须保存原始消息内容，不得改写为摘要。

### 6. 执行修改方案

基于 ChatGPT 返回的方案执行修改。具体执行方式取决于用户的工具链：

```bash
# 示例：用 codex 执行
codex exec "按以下方案修改: $(cat turn_N.md)"

# 示例：直接在当前 agent 中执行
# 读取 turn_N.md 并按其中的步骤操作
```

### 7. 提交改动

修改完成后提交：

```bash
git add -A
git commit -m "iteration turn N: <summary>"
```

### 7b. 用 GitHub CLI 同步到远端（建议每轮结束后执行）

在仓库根目录检查状态并推送当前分支：

```bash
gh repo view                    # 确认当前仓库与 GitHub 是否一致
git status
git push -u origin HEAD
```

若尚无 PR，可由当前分支创建草稿 PR，便于记录各轮 skill/代码变更：

```bash
gh pr create --draft --fill --title "Iteration N: ChatGPT-driven workflow" \
  --body "第 N 轮：更新 chatgpt-driven-iteration skill / 相关实现。关联对话见 conversation_links.md。"
```

查看与合并（在审阅通过后）：

```bash
gh pr view
gh pr merge --squash           # 或使用 GitHub 网页合并
```

### 8. 关联 GitHub Issue（可选）

便于跨轮次追踪「第 N 轮分析完成 / 待 Codex 执行」：

```bash
gh issue create --title "Iteration N: pending implementation" --body "快照: snapshot_N.json，分支: $(git branch --show-current)"
gh issue list
```

**说明**：`gh` 需已安装并登录（`gh auth login`）。若仅在本地维护 skill，可不创建 PR/Issue。

## 每轮 Git 分支命名（与 gh 协作）

建议「一轮迭代 = 一条开发线」，便于 `gh pr create` 与 ChatGPT 对话一一对应：

| 阶段 | 分支名示例 |
|------|------------|
| 分析 / 落盘 | `feat/iteration-<N>-chatgpt-review` |
| 按方案实现 | 同一分支继续提交，或 `feat/iteration-<N>-implement` |

```bash
git checkout main
git pull origin main
git checkout -b feat/iteration-3-chatgpt-review
# ... 本地修改后 ...
git push -u origin feat/iteration-3-chatgpt-review
gh pr create --fill
```

## 迭代轮次管理

多轮迭代时，维护以下结构：

```
docs/iterations/
├── conversation_links.md    # 轮次 → 对话链接映射
├── turn_1.md                # 第 1 轮 assistant 原始回复
├── turn_2.md                # 第 2 轮 assistant 原始回复
└── ...
```

`conversation_links.md` 格式：

```markdown
# Conversation Links

| 轮次 | 链接 |
|------|------|
| 1 | https://chatgpt.com/c/xxx |
| 2 | https://chatgpt.com/c/yyy |
```

## 提示词模板（泛用）

将下列模板中的 `<...>` 替换为实际值后，通过 `chatgpt-cli send` 发出（建议配合 `--project`；`--model` 可选，默认最高级）：

**首轮或换题：**

```text
请深度分析附带的 <archive_name>（已上传至本项目 Sources）。关注点：<关注领域，如架构/收敛性/测试缺口>。请给出可执行的修改建议，必要时按文件与步骤列出。
```

**第 N+1 轮（接续迭代）：**

```text
接下来进入第 <N+1> 轮迭代。请在已上传的 <archive_name> 基础上，结合上一轮结论，从 <角度> 判断是否还有优化空间，并给出详细修改建议。
```

**仅在对话内继续（同一 `conversation_id`）：**

```bash
chatgpt-cli --json --conversation <conversation_id> send "请在上条回复基础上补充边界情况与风险。"
```

## 工作流约束（必须遵守）

1. **不得提前获取结果** — `isResponding: true` 时禁止提取消息或开始下一步
2. **保存原始内容** — `turn_N.md` 必须是 assistant 原始消息，不得摘要化
3. **链接单独管理** — 对话 URL 写入 `conversation_links.md`，不混入 `turn_N.md`
4. **阻塞时报告** — 对话长时间无响应应报告阻塞，不得用中间态替代最终结果

## 每轮操作检查表（Agent 按序执行）

1. [ ] 打包 `<project>` → `<archive_name>`，排除体积与无用目录
2. [ ] `--project` 上传至 ChatGPT Sources；旧包按需 `/delete`（交互）或保留由人工清理
3. [ ] `send` 发起对话（默认自动最高级模型），记录 `conversationId`；必要时把对话 URL 写入 `conversation_links.md`（不入 `turn_N.md`）
4. [ ] 轮询 `status` 至 `isResponding: false`
5. [ ] `messages` / `snapshot` 落盘；将 assistant **原文**写入 `docs/iterations/turn_<N>.md`
6. [ ] `git checkout -b feat/iteration-<N>-...` → 提交 skill/代码 → `git push` → `gh pr create`
7. [ ] （可选）`gh issue` 标记待办或关闭

## chatgpt-cli 命令速查

| 用途 | 命令 |
|------|------|
| 发消息（默认最高级模型） | `chatgpt-cli [--json] [--project P] send "msg"` |
| 发消息（指定模型） | `chatgpt-cli [--json] [--project P] [--model M\|best] send "msg"` |
| 继续对话 | `chatgpt-cli --conversation ID send "msg"` |
| 查看/切换模型（REPL） | `/model` · `/model best` · `/model <name>` |
| 上传到项目 | `chatgpt-cli --project P upload file.zip --project` |
| 查状态 | `chatgpt-cli --json status <conv_id>` |
| 取消息 | `chatgpt-cli --json messages <conv_id>` |
| 导快照 | `chatgpt-cli --json snapshot <conv_id> -o out.json` |
| 管道输入 | `echo "text" \| chatgpt-cli --json send` |

## GitHub CLI（gh）常用

| 用途 | 命令 |
|------|------|
| 查看仓库 | `gh repo view` |
| 创建 PR | `gh pr create [--draft] --fill` |
| 查看 PR | `gh pr view` / `gh pr list` |
| 合并 | `gh pr merge`（需权限） |
| 创建 Issue | `gh issue create` |
| 登录 | `gh auth login` |
