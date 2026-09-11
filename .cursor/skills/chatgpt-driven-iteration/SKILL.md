---
name: chatgpt-driven-iteration
description: 通过 chatgpt-cli 驱动网页版 ChatGPT 对项目进行工程分析、独立代码审查、修复验收和实施方案整理。当用户要求用 ChatGPT 分析项目、进行 Code Review、验收上一轮修复、上传项目到 ChatGPT、等待对话完成或执行多轮项目迭代时使用。
---

# ChatGPT 驱动的项目迭代工作流

本 Skill 通过 `chatgpt-cli` 将当前项目源码上传至网页版 ChatGPT 项目，并根据用户当前目标选择对应工作模式。

角色原则：

```text
Cursor / 当前 Coding Agent = Builder
ChatGPT                    = Analyst / Reviewer
自动化测试                  = Judge
Git                        = Audit Trail
```

除非用户明确要求，否则不要让 ChatGPT 在 Code Review 阶段直接承担源码修改职责。

---

## 前置条件

执行前确认：

- `chatgpt-cli` 已安装
- Chrome 已启动
- Chrome 中 ChatGPT 已登录
- 当前项目是有效 Git 仓库
- 已明确要使用的 ChatGPT Project

检查：

```bash
chatgpt-cli --help
git rev-parse --show-toplevel
git status
```

WSL 下如果无法连接 Windows 宿主机 Chrome 调试端口，可以根据实际环境设置：

```bash
export NO_PROXY="${NO_PROXY},<WSL_HOST_IP>,localhost,127.0.0.1,::1"
```

不得写死 `<WSL_HOST_IP>`。

---

## 工作模式

本 Skill 支持以下模式：

| 模式 | 用途 | 模板 |
|---|---|---|
| `analysis` | 架构分析、设计讨论、风险分析、下一阶段规划 | `templates/analysis.md` |
| `review` | 对当前冻结版本进行独立代码审查 | `templates/review.md` |
| `verify` | 对上一轮 Review Finding 的修复结果进行验收 | `templates/verify.md` |
| `implementation` | 将已确认结论整理成 Coding Agent 可执行计划 | `templates/implementation.md` |

---

## 模式确认（必须先执行）

Coding Agent 在调用 `chatgpt-cli`（upload / send / start）、打包上传或读取模板之前，**必须先完成模式确认**。

### 流程

1. 根据用户请求推断**推荐模式**（可参考下方「模式路由」）。
2. 向用户发起**四选一**确认，说明推荐项及理由。
3. 收到用户明确选择后，记录本轮模式，再进入后续步骤。
4. **未确认前**不得执行 upload、send、start 或构造最终 Prompt。

### 四选一选项

| 选项 | 适用场景（简述） |
|---|---|
| `analysis` | 架构分析、方案比较、风险与下一阶段规划 |
| `review` | 对当前冻结版本做独立 Code Review |
| `verify` | 验收上一轮 Review Finding 的修复结果 |
| `implementation` | 将已确认结论整理成可执行实施计划 |

### 确认方式

优先使用结构化提问（如 AskQuestion），四个选项固定为上述四模式，并将推荐项标为 `(Recommended)`。

示例话术：

```text
本次 ChatGPT 驱动迭代建议使用 review 模式（对当前 commit 做独立代码审查）。
请确认本次使用的模式：
- analysis
- review (Recommended)
- verify
- implementation
```

### 例外

仅当用户消息**已明确指定**四模式之一（如「做一次 review」「verify 上一轮 P0」）时，可简要复述所选模式并**请用户确认或纠正**，不必重复解释各模式含义。

用户纠正或改选模式后，以最终确认的模式为准，并读取对应模板与 rules。

---

## 模式路由

### analysis

以下请求优先进入 `analysis`：

- 深度分析项目
- 分析架构
- 下一阶段怎么设计
- 技术方案比较
- 风险评估
- 是否应该重构
- 里程碑规划
- 新模块怎么设计

该模式允许：

- 比较多种方案
- 提出架构调整
- 讨论长期风险
- 提出下一阶段实施顺序

该模式不强制使用 P0 / P1 / P2。

---

### review

以下请求优先进入 `review`：

- code review
- 代码审查
- 验收当前阶段
- 检查当前实现
- 看当前 commit 有没有问题
- 找 bug
- 安全审查
- 检查测试缺口

该模式下 ChatGPT 的角色是独立 Reviewer。

必须读取：

```text
templates/review.md
rules/review-severity.md
rules/finding-format.md
rules/exit-criteria.md
```

重点检查：

- correctness
- lifecycle
- state machine
- concurrency
- race condition
- resource cleanup
- API / RPC / protocol contract
- permission boundary
- trust boundary
- sandbox boundary
- failure path
- regression risk
- tests
- implementation 与 requirement / ADR / docs 是否一致

Review 阶段默认不要让 ChatGPT 直接修改源码。

---

### verify

以下请求优先进入 `verify`：

- 上一轮问题已经修复
- 验收修复结果
- 检查 Finding 是否关闭
- Verify 上一轮 P0/P1
- 修复后重新检查
- 确认是否可以 DONE

必须读取：

```text
templates/verify.md
rules/review-severity.md
rules/finding-format.md
rules/exit-criteria.md
```

Verify 的目标是：

```text
原 Finding
+
对应修复
+
Regression Test
+
修复引入的直接副作用
```

不要默认重新启动一次无边界 Full Review。

---

### implementation

以下请求优先进入 `implementation`：

- 根据审查结论给出修改步骤
- 整理实施计划
- 按文件说明怎么修改
- 把 Findings 转换成开发任务
- 给 Cursor / Codex 可执行方案

该模式只整理已经确认的工作范围。

不要在 implementation 阶段重新扩大架构范围。

---

## 推荐迭代链路

标准开发阶段：

```text
Cursor 开发
    ↓
本地测试
    ↓
Commit A
    ↓
ChatGPT Review
    ↓
P0 / P1 / P2 / Observation
    ↓
Cursor 修复
    ↓
Regression Tests
    ↓
Full Tests
    ↓
Commit B
    ↓
ChatGPT Verify
    ↓
PASS
```

对于新模块或新 milestone：

```text
ChatGPT Analysis
    ↓
确定方案
    ↓
Cursor 开发
    ↓
Review
    ↓
Fix
    ↓
Verify
```

---

## Review Baseline

进行正式 Review 前，应尽量使用冻结版本。

执行：

```bash
git rev-parse HEAD
git branch --show-current
git status --short
git log -1 --oneline
```

收集：

- Branch
- HEAD Commit
- 当前 Milestone
- 当前 Iteration
- 本轮完成内容
- 必须维持的 Invariants
- 工作区是否 clean

推荐：

```text
开发完成
→ 测试通过
→ Commit
→ 打包
→ ChatGPT Review
```

如果工作区不是 clean 状态，必须在 Prompt 中明确：

```text
当前 Review baseline 包含未提交修改。
```

不得假设上传源码和 HEAD 完全一致。

---

## 项目打包

进入目标项目父目录：

```bash
cd <parent_dir>
```

默认：

```bash
tar czf <archive_name>.tar.gz \
  --exclude='<project>/.git' \
  --exclude='<project>/node_modules' \
  --exclude='<project>/.build' \
  --exclude='<project>/build' \
  --exclude='<project>/dist' \
  --exclude='<project>/.artifacts' \
  <project>
```

用户没有指定时默认排除：

- `.git/`
- `node_modules/`
- `.build/`
- `build/`
- `dist/`
- `.artifacts/`

不要默认排除：

- `tests/`
- `docs/`
- ADR
- protocol definitions
- migration
- 配置示例

这些内容可能是分析和 Review 的必要证据。

---

## 上传到 ChatGPT Project

上传：

```bash
chatgpt-cli \
  --project <project_name> \
  upload <archive_path> \
  --project
```

如果需要删除旧包，可使用交互模式：

```text
chatgpt-cli

/project <project_name>
/delete <old_file_name>
```

不得未经需要删除用户明确保留的历史 Iteration 包。

---

## Prompt 构造

根据当前模式读取对应模板。

例如 Review：

```text
templates/review.md
+
rules/review-severity.md
+
rules/finding-format.md
+
rules/exit-criteria.md
+
本轮项目动态上下文
```

动态上下文可能包括：

- `{{project_name}}`
- `{{archive_name}}`
- `{{iteration}}`
- `{{milestone}}`
- `{{branch}}`
- `{{commit_sha}}`
- `{{working_tree_status}}`
- `{{changes}}`
- `{{invariants}}`
- `{{constraints}}`
- `{{previous_findings}}`
- `{{test_results}}`

模板中的 `{{...}}` 是语义占位符。

执行 Agent 根据当前项目真实信息替换。

不得伪造无法获得的信息。

无法确认时明确写：

```text
未提供
```

---

## 发送 Prompt

短 Prompt：

```bash
chatgpt-cli --json \
  --project <project_name> \
  send "<final_prompt>"
```

长 Prompt 优先通过 stdin：

```bash
cat <prompt_file> | \
chatgpt-cli --json \
  --project <project_name> \
  send
```

默认不显式指定模型。

由 `chatgpt-cli` 自己选择账号当前可用模型。

只有用户明确要求固定模型时才增加：

```bash
--model <model_name>
```

`send` 会等待生成完成并返回最终 `reply`。需要先取得 `conversationId`、在后台继续其他工作时，改用：

```bash
chatgpt-cli --json \
  --project <project_name> \
  start "<final_prompt>"
```

---

## Conversation 记录

从返回 JSON 中记录：

```text
conversationId
```

对话 URL 单独维护在：

```text
docs/iterations/conversation_links.md
```

推荐格式：

```markdown
# Conversation Links

| 轮次 | 模式 | Commit | 链接 |
|---|---|---|---|
| 7 | review | abc1234 | <url> |
| 8 | verify | def5678 | <url> |
```

对话 URL 不要写入 `turn_N.md` 原始回复。

---

## 等待 ChatGPT 完成

使用 `send` 时，CLI 已经等待最终回复，不需要再调用 `status --wait`。

仅当使用 `start` 后需要等待时：

不得在：

```json
"isResponding": true
```

时把当前内容当作最终结果。

推荐：

```bash
chatgpt-cli --json \
  status <conversation_id> \
  --wait
```

或者轮询：

```bash
chatgpt-cli --json status <conversation_id>
```

只有状态明确完成后，才能进入结果提取和下一阶段。

如果等待超时：

- 报告阻塞
- 保留 conversationId
- 不得使用中间态回复代替最终结果

---

## 保存原始回复

对话完成后：

```bash
chatgpt-cli --json messages <conversation_id> > messages.json
```

或者：

```bash
chatgpt-cli --json snapshot <conversation_id> -o snapshot.json
```

Assistant 最终回复原样保存：

```text
docs/iterations/turn_<N>.md
```

`turn_<N>.md` 必须保存原始 Assistant 内容。

不得把摘要覆盖到该文件。

如果需要 Coding Agent 执行摘要，可以创建单独文件。

---

## Review 修复规则

Review 返回：

```text
P0
P1
P2
Observation
```

默认处理策略：

```text
P0          当前 Iteration 必须处理
P1          原则上当前 Iteration 必须处理
P2          默认进入 backlog
Observation 不阻塞当前 milestone
```

每个 P0 / P1 应尽量形成：

```text
Finding
    ↓
Code Fix
    ↓
Regression Test
```

---

## Finding 状态

修复后，每个 Finding 应标记：

- `FIXED`
- `PARTIAL`
- `OPEN`
- `NOT_REPRODUCIBLE`
- `ACCEPTED_RISK`
- `DEFERRED`

约束：

- P0 不允许 `DEFERRED`
- P0 原则上不得 `ACCEPTED_RISK`
- P1 使用 `ACCEPTED_RISK` 必须由用户明确确认
- P2 可以 `DEFERRED`

---

## Verify 输入

Verify 应尽量提供：

- 原 Review Commit
- Fix Commit
- 上一轮 Findings
- 本轮修改说明
- Regression Test 结果
- Full Test 结果
- Smoke Test 结果
- 必须维持的 Invariants

如有必要，可读取：

```bash
git diff <base_commit>..<fix_commit>
```

---

## 退出原则

当前 Review / Fix / Verify Loop 达到以下条件后应停止：

```text
P0 = 0
P1 = 0
关键 Regression Tests = PASS
Full Test Suite = PASS
Required Smoke Tests = PASS
```

如果只剩 P2：

```text
PASS WITH P2
```

如果没有阻塞问题：

```text
PASS
```

不要因为：

- 可以增加日志
- 可以进一步抽象
- 可以减少重复
- 可以调整命名
- 可以未来重构

而无限开启新 Review。

---

## Git 提交

修改完成并验证后：

```bash
git add -A
git commit -m "<scope>: <summary>"
```

Finding 修复可以使用：

```text
fix(runtime): resolve Turn 7 review findings
```

或者：

```text
fix(runtime): resolve R3.1b-P1-01 and R3.1b-P1-02
```

不强制固定 Commit Message 格式。

---

## GitHub 同步

只有用户要求或项目流程明确要求时才执行：

```bash
gh repo view
git status
git push -u origin HEAD
```

需要 PR：

```bash
gh pr create --draft --fill
```

GitHub PR / Issue 不是每个 Iteration 的强制步骤。

---

## 操作检查表

### 通用

- [ ] 模式确认（四选一：analysis / review / verify / implementation，用户已确认）
- [ ] 判断当前模式
- [ ] 获取 Git Baseline
- [ ] 收集本轮 Changes
- [ ] 收集关键 Invariants
- [ ] 打包项目
- [ ] 上传 Sources
- [ ] 读取对应 Template
- [ ] 读取必要 Rules
- [ ] 构造最终 Prompt
- [ ] 发起对话
- [ ] 记录 conversationId
- [ ] 等待 ChatGPT 完成
- [ ] 保存 Assistant 原始回复
- [ ] 更新 conversation_links.md

### Review

- [ ] Baseline 已冻结，或明确 dirty
- [ ] 提供 Changes
- [ ] 提供 Invariants
- [ ] P0/P1 必须有代码证据
- [ ] P0/P1 必须给出 Regression Test

### Fix

- [ ] P0 已全部处理
- [ ] P1 已全部处理或获得明确风险接受
- [ ] 已新增必要 Regression Tests
- [ ] 已执行 Full Tests

### Verify

- [ ] 提供上一轮 Findings
- [ ] 提供 Base Commit
- [ ] 提供 Fix Commit
- [ ] 提供 Tests
- [ ] 优先验证原 Finding
- [ ] 检查修复直接副作用
- [ ] 达到 Exit Criteria 后停止

---

## 核心约束

整个 Skill 始终保持：

```text
chatgpt-cli = Transport
Skill       = Orchestration
Templates   = Task Protocol
Rules       = Review Policy
```

不要把软件工程模式逻辑下沉到 `chatgpt-cli`。
