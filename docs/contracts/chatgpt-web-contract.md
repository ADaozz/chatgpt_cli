# ChatGPT Web 契约（PR01）

> 本文档是 `chatgpt-cli` 所依赖的 ChatGPT 网页版 **DOM 结构 + backend API + 完成信号** 契约的唯一快照。
> 由 PR01 探针脚本（`scripts/probe-chatgpt.js`）与脱敏 fixtures（`test/fixtures/`）共同维护：
> 改版后先重跑探针，再对照本文档与 fixtures 定位失效点，最后更新 `selectors.js` / 解析层。
>
> - 观测时间：**2026-10-28**
> - 观测环境：Chrome 155.0.8059.85 · chatgpt.com · zh-CN UI · CDP attach（WSL → Windows Chrome 调试端口）
> - 数据来源：只读探针 + DevTools 手工抓包；所有样例均已脱敏（规则见下）
> - 未标注「未复核」的结论均为本轮实测；标注「未复核」的为本轮未覆盖、沿用旧结论的项

---

## 1. 脱敏规则（fixtures 与探针输出共用）

| 对象 | 处理 |
|---|---|
| Authorization / JWT / accessToken / cookie | 全部删除或替换为 `<redacted>` / `<jwt-redacted>` |
| 邮箱 | `<email-redacted>` |
| `user-*` / `org-*` 账号 ID、`file-*` 文件 ID、16 位文件句柄 | 前缀 + `redacted` |
| `g-p-*` 项目 ID | `g-p-redacted0000000000000000000000`（保留格式） |
| 消息 / 会话 / 请求 / 游标 UUID | `00000000-0000-4000-8000-0000000000NN` 固定占位 |
| `model_dil_v2.code` 等渲染代码体 | 删除，仅保留结构键与 `fallbackMarkdown` |
| 上传文件名 | `project-archive-1.tar.gz` / `iteration-2.tar.gz` |
| 模型 slug、完成信号字段、aria-label、role/aria-* 属性 | **保留**（契约必需） |

探针默认脱敏输出，仅本机调试可用 `--no-sanitize`。

---

## 2. DOM 契约

### 2.1 Composer（消息输入区）

实测于首页（无会话状态）：

| 项 | 值 | 说明 |
|---|---|---|
| 容器 | `div[role="textbox"][contenteditable="true"]`，class 含 `ProseMirror` | **无 `#prompt-textarea` id、无 data-testid**；旧 ID 仅作兼容保留 |
| aria-label | 首页 `询问 ChatGPT`；会话页观测为 `开始写作` | **随上下文变化，不得作为唯一选择器依据** |
| 外层表单 | `form`（class `relative flex flex-col gap-2`），**无 `data-chatgpt-composer` testid 观测值** | 该 testid 属性本轮未在 form 上出现，选择器使用时不得依赖其存在 |
| 按钮 | `aria-label`：`添加文件等内容`、`选择 ChatGPT 模型`、`听写`、`开始语音` | 模型切换按钮 id 为 radix 动态值（`radix-_r_if_`），**不可依赖** |
| 页面级 testid | 仅 `app-shell-header-context-menu-surface`、`avatar-overlay-voice-orb` 等少量 | composer 区域无可用 testid |

对应 fixtures：`test/fixtures/composer-dom.json`。

### 2.2 Turn / 回复结构（完成判定依据）

| 项 | 值 | 说明 |
|---|---|---|
| turn 容器 | `div[data-turn-key="<uuid>"]` | 每轮问答一个；实测**不嵌套**（nestedTurns=0） |
| turn 状态 | 容器内 `div[data-talvt-turn-state]`，观测值 `complete` | 新版整段 turn（用户消息+思考+回复）的状态标记 |
| 角色标记 | `h4[data-conversation-role="user"|"assistant"]` | zh-CN 下 user 侧文案 `你说：`/`You`；同一 turn 同时含 user+assistant 两组 |
| 检索单元 | `[data-chatgpt-search-unit-key$=":assistant"]` | assistant 内容容器；`data-chatgpt-search-message-ids` 以**空格分隔多个消息 ID**（思考+最终回复） |
| turn 起点 | `span[data-chatgpt-agent-turn-start]` | |
| 思考摘要 | `[data-markdown-text-style="assistant-message"][data-markdown-text-tone="tertiary"]` | **必须排除**，否则会把思考进度当正文 |
| 最终正文 | `[data-markdown-text-style="assistant-message"]`（无 tertiary tone） | `innerText` 即回复文本；Genui/DIL 渲染时文本拆为 `span[data-d-stream-word]`，innerText 仍聚合完整 |
| 助手侧操作栏 | turn 内 `button[aria-label]`：`复制`、`评价回复`、`朗读`、`分享`、`重新生成回复`、`更多操作` | 无 copy testid；完成判定认助手侧「复制」 |
| 用户侧操作栏 | 同一 turn 内：`复制消息`、`共享提示`、`编辑消息` | 与助手侧操作栏共存于一个 turn；存在 canvas 时另有「打开编辑器」 |
| 可视性 | 操作栏默认 mask，hover 才亮起 | **完成判定按「存在于最新 turn DOM」而非可视性** |

对应 fixtures：`test/fixtures/turn-dom.json`、`test/fixtures/assistant-content-dom.json`。

### 2.3 Model Picker（模型菜单）

| 项 | 值 | 说明 |
|---|---|---|
| 触发按钮 | `[data-codex-intelligence-trigger]`，aria-label `选择 ChatGPT 模型` | 两个旧 `data-testid="model-switcher-*"` 本轮**未观测到**，仅作后备 |
| 思考强度 | trigger 的 `data-selected-reasoning-effort`（观测值 `high`） | 展开菜单不改变该值，可作恢复校验 |
| 菜单容器 | `div[role="menu"]`，`data-radix-menu-content`、`data-state="open"`、`data-orientation=vertical` | **无 testid**；外层为 `[data-radix-popper-content-wrapper]` |
| 视图标记 | 容器内 `data-model-picker-view="simple"|"advanced"` | flat 结构另见 fixture |
| 思考强度滑杆 | `div[role="slider"]`，`aria-valuemin=0`、`aria-valuemax=2`、`aria-valuenow=2` | 键盘 ArrowLeft/Right 可调整；`menuitem[data-reasoning-slider=true]` 为「强度」项 |
| 模型候选项 | `div[role="menuitemradio"]` + `data-model-selected="true"`（同时 `aria-checked="true"`） | 观测项：`GPT-6`、`GPT-5.6 Sol`；文本随语言变化，匹配依赖属性 |

对应 fixture：`test/fixtures/model-picker-menu.json`。

---

## 3. Backend API 契约

鉴权来源：`GET /api/auth/session` → `accessToken`（JWT，用于 `Authorization: Bearer`）。session 另含 `expires`；探针只记录键集合，不落 token 值。

### 3.1 会话读取：新旧端点并存（2026-10-28 双端点实测）

**复数端点** `GET /backend-api/conversations/{id}?num_turns=10&include_has_versions=true` → 200：

- **线性化 `messages[]` + `page_info` 游标**（`start_cursor` / `end_cursor` / `has_previous_page` / `has_next_page`）；
- **无 `mapping` 字段**（探针确认 `hasMapping: false`，实测 15 条消息线性返回）；
- 顶层键（完整列表见 fixture）：`conversation_id`、`title`、`current_node`、`async_status`、`default_model_slug`、`sectioned_conversation`、`context_truncation_continuation` 等 34 个；
- 消息对象关键字段（见 fixture `messageSample`）：
  - `author.role`（system/user/assistant）、`status`（`finished_successfully`）、`end_turn`（assistant 最终回复为 `true`）、`weight`（system=0，正文=1）、`channel`（assistant 最终回复为 `final`）；
  - `metadata.model_slug` / `resolved_model_slug`（观测 `gpt-6-thinking`，**thinking slug 不在目录 models 列表中**）、`metadata.thinking_effort`（观测 `extended`）、`metadata.cot_version`（`v5`）；
  - `metadata.finish_details`：`{ type: "stop", stop_tokens: [200002] }` + `is_complete: true`；
  - `metadata.turn_exchange_id` / `working_turn_id`（同轮消息共享）、`parent_id`；
  - system 消息 `is_visually_hidden_from_conversation: true`，快照解析需过滤。

**单数端点** `GET /backend-api/conversation/{id}` → 200（本轮实测复核）：

- 顶层键与复数端点高度一致，但**含 `mapping`**（树状节点），**无 `messages` / `page_info`**；
- v2 的 `conversation-parser.js` 同时支持两种响应形态（`shape: "linear" | "mapping"`），但运行时只调用复数端点；
- 风险：两套结构并存意味着 ChatGPT 正在向线性结构迁移；新版 UI 读取的是复数端点。后续 PR 应让解析层同时兼容两种形态（`test/fixtures/conversation-api-plural.json` 已固化复数端点样本）。

### 3.2 会话发送：`POST /backend-api/f/conversation`（实测）

- 响应：`text/event-stream`（SSE）；
- 请求头（观测）：`authorization: Bearer …`、`x-openai-web-sse-compression: gzip`、`oai-did`（设备 UUID）、`oai-language: zh-CN`；
- 请求体模板（完整见 fixture）：`action: "next"`、`model`、`parent_message_id`（新会话首条 `client-created-root`）、`thinking_effort`、`messages[]`（`author.role=user`、`content.content_type=text`、客户端生成 UUID）、`supported_encodings: ["v1"]`、`turn_attribution.turn_trigger=composer`、`client_contextual_info.app_surface=codex_browser`。

CLI 介入方式（v2）：**不再拦截改写 `model` / `thinking_effort`**，模型只通过页面菜单选择；仅在带附件发送时由 `client._sendWithAttachments` 通过 CDP `Fetch.enable`（`urlPattern: '*backend-api/f/conversation'`，Request 阶段）向 `messages[0].metadata.attachments` 注入附件；**只改第一条匹配请求**，结束后 `Fetch.disable` + `detach` 清理。其余字段（含 `model`）以页面原生值为准。附件注入契约仍为 probe-pending。

### 3.3 模型目录（两种观测形态）

| 形态 | 顶层键 | 说明 |
|---|---|---|
| models 列表 | `models[]`（slug/title/desc）、`categories[]`（cat/default_model/effort）、`versions[]`、`default_model_slug`、`model_picker_version` | `default_model_slug` 首页观测为 `auto` |
| picker state | `categories[]`（category/default_model/supported_models/supported_features/model_version）、`versions[]`（slugs/intelligence_presets）、`picker_version: 2`、`default_slug: auto` | `intelligence_presets[].model_slug` + `lane` 描述 preset→slug 映射 |

已确认事实（v2 已删除 slug 版本号排序；默认策略 = 菜单最新 + 强度 slider 最高档）：

1. thinking 系列模型（`gpt-6-thinking` 等）**不出现在目录 models 列表**，但真实回复的 `resolved_model_slug` 会返回它们——不能只靠目录 slug 排序选择；v2 改为 UI 菜单选择 + 发送请求验证；
2. 目录存在 title 复用（`GPT-5.6 Luna` 同时标注 `gpt-5-6` 与 `gpt-5-6-mini`）——不能只依赖 title 匹配；
3. UI 菜单里 thinking 强度以 slider 呈现，菜单项只有 `GPT-6` / `GPT-5.6 Sol` 等 base 模型名。

对应 fixture：`test/fixtures/model-catalog.json`。

### 3.4 项目（Gizmo）

`GET /backend-api/gizmos/{gizmo_id}?include_file_limits=true` → 200，顶层键：`gizmo`、`tools`、`files`、`product_features`、`has_tpp_conversation`、`is_space_backing`、`project_file_limits`、`project_connector_scope_limits`。

- `gizmo.id` 即 `--project` 匹配的项目 ID（`g-p-` 前缀）；
- `files[]`（顶层）元素含 `id/name/size/type`（或 `mimeType`）——项目 Sources 上传后在此可见；
- 项目 upsert 走 `POST /backend-api/gizmos/snorlax/upsert`（`adapter.buildProjectUpsertPayload`）——**本轮未复核**。

对应 fixture：`test/fixtures/gizmo-config.json`。

---

## 4. 完成信号契约

### 4.1 backend 信号（`conversation-parser.js` · v2 已合并实现）

| 信号 | 值 | 语义 |
|---|---|---|
| `async_status` | `null`（空闲）/ 非空（观测 3=生成中，4=完成后持久非空） | **不单独作为完成门控**：当前 turn 存在完成 final 时以 final 为准；无 final 时非空按未完成处理 |
| `metadata.reasoning_status` | `is_reasoning` / `reasoning_ended` | 已完成 turn 中历史 `is_reasoning` 会保留；仅「尚无完成 final」时才算思考中 |
| `end_turn` | assistant 最终回复 `true` | 与 `status: finished_successfully` 联合判定 |
| `metadata.finish_details.type` | `stop`（+`stop_tokens: [200002]`） | 正常结束标记 |
| `channel` | assistant 最终回复 `final` | thinking 中间消息非 final |
| `working_turn_id` / `turn_exchange_id` | 同轮共享 | 完成判定限定当前 turn，避免旧分支干扰 |

### 4.2 DOM 信号（`response-tracker.js` + `selectors.js`）

| 信号 | 判定 |
|---|---|
| 停止按钮 | `composer.stopBtn` 消失 —— DOM 兜底条件之一，**不是**协议成功依据 |
| turn 状态 | 最新 turn 的 `data-talvt-turn-state="complete"` |
| 操作栏 | 最新 turn 存在复制按钮（aria-label `复制`/`Copy`） |
| 兜底门控 | 协议不可用（network/5xx/429）且 DOM 证据稳定 ≥ `CHATGPT_DOM_CONFIRM_MS` → `completed(dom)`；协议明确仍生成时**不得**兜底成功 |

**门控优先级（v2）**：`finalComplete`（当前 turn 完成的 final）> `async_status`（仅在其无 final 时阻塞）> `reasoning_status`（仅在其无 final 时阻塞）。协议不可用时才启用 DOM 兜底，结果携带 `completionSource:"dom"`、`partial:true` 与协议错误。

**已知缺口（Review V2.0.0-P1-02）**：当前实现仍允许 401/403/404/parse 进入 DOM 兜底，Fix 轮将收紧为 allowlist（network/server/rate_limited）。

**取消语义**：协议没有可靠的“用户停止”终态字段；当前以「协议无 final + 无 async 活动 + DOM 已停止生成」持续 3 个周期作为 `cancelled` 保守启发式（probe-pending）。

---

## 5. 探针脚本使用说明

```bash
# 默认：DOM + API（session / conversations 列表）
node scripts/probe-chatgpt.js --json

# 会话端点对比（复数 vs 单数）+ 项目配置
node scripts/probe-chatgpt.js --api --conversation <conv_id> --project <gizmo_id> --out /tmp/probe.json

# 模型菜单结构（临时展开并恢复，不切换模型）
node scripts/probe-chatgpt.js --model-menu --json

# 被动捕获发送请求体（在浏览器中手动发一条消息即可，脚本不发送）
node scripts/probe-chatgpt.js --capture-request --wait-ms 60000 --out /tmp/send-template.json
```

- 浏览器地址解析与 `check-selectors.js` 一致：`--browser-url` > `CHATGPT_BROWSER_URL` > `CHATGPT_PORT`（WSL 自动取默认网关）；
- `--page-url` 可指定现有标签页，脚本不导航；
- 退出码：`0` 正常（允许 `empty`）、`1` section 检测错误、`2` 无法运行；
- 默认脱敏输出，`--no-sanitize` 仅限本机调试。

## 6. Fixtures 清单

| 文件 | 内容 | 主要消费方 |
|---|---|---|
| `fixtures.manifest.json` | 采集环境、脱敏规则、清单 | 人读 + 契约测试 |
| `composer-dom.json` | composer/表单/按钮结构 | 选择器契约测试 |
| `turn-dom.json` | turn 结构与完成标记 | 选择器契约测试 |
| `assistant-content-dom.json` | markdown 容器与流式结构 | 选择器契约测试 |
| `model-picker-menu.json` | 菜单三种视图结构 | 模型选择契约测试 |
| `model-catalog.json` | 目录两种形态 | 模型目录契约测试 |
| `conversation-api-plural.json` | 复数端点结构与消息样本 | 快照解析 / 完成判定契约测试 |
| `f-conversation-request.json` | 发送请求体模板（页面原生） | 发送请求契约测试 |
| `gizmo-config.json` | 项目配置结构 | 项目/文件契约测试 |

契约测试入口：`npm test`（`test/fixtures-contract.test.js`）。

## 7. 已知缺口（更新于 PR02–PR07 实施后）

1. ~~单数端点 mapping 未复核~~ **已复核（2026-10-28）**：带 Bearer 时仍返回 200 + `mapping`；复数端点（SPA 实际使用）返回线性 `messages`。v2 只调用复数端点，解析层同时兼容两种响应形态（均属服务端协议，不是旧 DOM 兼容）。
2. ~~thinking 消息序列未采样~~ **已采样（2026-10-28，PR03/04）**：`role=assistant, channel=null, end_turn=false, metadata.reasoning_status` 取 `is_reasoning` / `reasoning_ended`；最终回复 `channel="final"`。**重要**：已完成 turn 中历史 `is_reasoning` 标记不会清除，完成判定不得以「存在 is_reasoning」直接否决 final。
3. **文件附件请求体未抓包**——`f/conversation` 的 attachments 注入字段需 `--capture-request` 配合带附件发送补采（当前沿用 v1.2.2）。
4. ~~分页游标语义未验证~~ **已验证（2026-10-28）**：`before={start_cursor}` 向历史翻页，`after={end_cursor}` 向新翻页；`cursor/start_cursor/end_cursor` 查询参数无效；`num_turns` 按 turn 计数（非消息数）。
5. **gizmo upsert / 文件上传端点未复核**——沿用 2026-10-08 结论（写操作标记 probe-pending）。
6. **用户主动停止生成的协议终态未抓取**——v2 以「协议无 final + 无 async 活动 + DOM 已停止生成」双停滞 3 个周期作为 `cancelled` 保守启发式。
7. **429 Retry-After 未实机强制复现**——客户端已实现退避与上限。
8. **输入保真（2026-10-28 实机结论）**：Puppeteer `keyboard.type` 在 ProseMirror composer 上会丢失 ASCII 数字（中文输入法上下文），`keyboard.sendCharacter` 逐字符也不可靠；`document.execCommand('insertText', false, 全文)` 单次写入保真（v1.2.2 生产路径）。v2 采用 execCommand + 回读校验，不一致则尝试 Input.insertText 兜底，仍不一致抛 DOM_CHANGED，绝不静默发送残缺消息。


## 8. 完成判定实现（v2 修订，2026-10-28）

1. **协议优先**：`channel="final"` + `end_turn=true` + `status="finished_successfully"` + 无 open reasoning + `async_status` 空闲 → `completed`（`completionSource: "protocol"`）。
2. **DOM 兜底**（协议不可用：网络/5xx/429/401）：最新 turn `data-talvt-turn-state="complete"`、停止按钮消失、复制按钮已挂载、最后回复文本非空且稳定 ≥ `CHATGPT_DOM_CONFIRM_MS`（默认 2s）→ `completed`（`completionSource: "dom"`，`partial: true`，error 记录协议失败原因）。对应 v1.2.2「复制按钮 + 发送按钮恢复」判定。
3. **防误判**：协议明确 `asyncInProgress=true` 或存在 open reasoning 时，DOM 信号不得提前完成；协议判定存在时以协议为准。
4. **占位 id**：新会话 URL 会短暂出现 `/c/local-chatgpt`（协议读取返回 400 `Invalid conversation`），只接受 UUID 形式 id。
5. **超时看门狗**：单次协议调用设超时（默认 15s），另有 1s 看门狗保证超时终态；DOM 证据稳定时超时兜底交付 `completed(dom)`，否则 `timeout`/`unknown` 并保留部分文本。

## 9. 实现状态（PR01–PR07）

| PR | 状态 | 落地模块 |
|----|------|----------|
| PR01 实机采集与基线 | ✅ 完成（2026-10-28） | `scripts/probe-chatgpt.js`、`test/fixtures/`、本文档 |
| PR02 页面控制层 | ✅ 完成 | `selectors.js`（v2 实机选择器）、`page-controller.js`、`DOM_CHANGED` |
| PR03 会话协议与快照 | ✅ 完成 | `web-protocol.js`（复数端点 + before/after 分页 + 类型化错误）、`conversation-parser.js`（线性/映射双形态、分支回溯、partial） |
| PR04 回复状态机 | ✅ 完成 | `response-tracker.js`（协议确认终态；thinking/工具/部分回答不算完成；429 退避；partial 文本保留；cancelled 启发式） |
| PR05 模型与强度 | ✅ 完成 | `model-controller.js`（默认最新+最高；菜单选择+验证；无版本号排序/无静默降级/无 model 注入） |
| PR06 Project / Sources | ✅ 实现（写契约 probe-pending） | `project-controller.js`、`file-controller.js` |
| PR07 CLI 整合与文档 | ✅ 完成 | `cli.js`、`client.js`、`commands.js`、`README.md`、测试 |

回归记录（2026-10-28，真实 Chrome 155 / 已登录 Plus 账号）：
- DOM 采样：`data-turn-key`、`data-talvt-turn-state`（in_progress/complete）、
  `data-chatgpt-search-unit-key$=":assistant"`、`data-markdown-text-style="assistant-message"` 全部命中；
- 模型菜单：GPT-6（选中）/ GPT-5.6 Sol；强度档位 0..2（即时/中/高）；
  打开菜单读取后触发器 effort 不变（`data-selected-reasoning-effort=high`）；
- 协议：分页 3 页读全（15 条消息 / 6 条可见），`turnComplete=true`；
- 结构化内容：`<WritingBlock>` / `<Link>` 标记被识别并写入 `reply.blocks`，
  `hasUnsupportedContent=true`（不误判为空回复）。
