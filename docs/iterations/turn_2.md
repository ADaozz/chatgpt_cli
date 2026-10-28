:::writing{variant="document" id="58321" title="chatgpt_cli v2.0.0 独立 Code Review"}
# Review Verdict

Result：

`FAIL`

Baseline：

- Project: `chatgpt_cli`
- Iteration: `v2.0.0 — PR01–PR07 现代化重构`
- Milestone: `v2 核心版本（PR01–PR05 核心 + PR06 写入链路 + PR07 CLI 整合）`
- Branch: `master`
- Commit: `1b1252f5f792aea29ee64d0e24bea7571a525cdf`
- Working Tree: `dirty`，本 Review 基于上传归档中的冻结工作区

独立检查结果：

- `node --check *.js test/*.js scripts/*.js`：PASS
- 非浏览器逻辑/契约测试：`88/88 PASS`
- 完整 `npm test`：当前 Review 容器无法完成 `dom-selectors.test.js`，原因是归档根目录没有可用的 `puppeteer-core`；尝试 `npm ci --ignore-scripts` 超时。该项属于 Review 环境限制，不单独作为 Finding。
- 对关键状态机、协议、模型、Project/File 错误路径进行了额外 stub 级复现；以下若标记 `Confirmed` 均有直接代码路径或独立复现证据。

## P0

[V2.0.0-P0-01] P0 — 自动 CDP 端口被无认证暴露到所有入站网络接口

Confidence:
`Confirmed`

Location:
- `auto-connect.js:147-155`
- `auto-connect.js:169-170`
- `auto-connect.js:206-254`

Evidence:

`setupPortProxy()` 创建：

```text
listenaddress=0.0.0.0
```

同时创建：

```text
New-NetFirewallRule ... -Direction Inbound -Protocol TCP -LocalPort 9224 -Action Allow
```

自动启动 Chrome 时又显式使用：

```text
--remote-debugging-address=0.0.0.0
```

CDP 本身没有 ChatGPT 登录层面的授权隔离；取得 `9224/json/version` 后即可建立 CDP 控制连接。

Trigger:

使用默认 WSL `autoConnect` 路径，而不是显式 `CHATGPT_BROWSER_URL`，并且宿主机网络上存在能够访问 TCP/9224 的其他主机。

Impact:

远程攻击者可以直接获得 Chrome DevTools 控制能力，进而控制已登录的 ChatGPT 浏览器，包括：

- 读取当前页面；
- 访问 ChatGPT 会话内容；
- 操作已登录账号；
- 发消息、上传文件；
- 通过浏览器上下文访问可见的会话/站点数据。

这是明确的浏览器控制信任边界暴露，不是普通诊断端口。

Invariant violated:

`N/A` — 属于 P0 明确安全边界绕过。

Recommended fix:

默认情况下不要把 CDP 暴露到 `0.0.0.0`。

至少应：

- 将 Windows Firewall RemoteAddress 限制到实际 WSL 虚拟网络范围；
- 或使用仅本机/受限接口的端口转发；
- 不允许任意 LAN/公网地址访问 9224；
- 对自动创建的防火墙/portproxy 生命周期进行明确管理。

Required regression test:

在真实 WSL/Windows 环境：

1. CLI 自动启动/连接 Chrome；
2. WSL 内 CLI 能正常访问 CDP；
3. Windows LAN 其他主机访问 `host:9224/json/version` 必须失败；
4. 防火墙规则必须只允许预期来源地址。

---

## P1

[V2.0.0-P1-01] P1 — 协议曾明确处于生成状态超过 2 秒后，DOM 仍可能提前返回 `completed`

Confidence:
`Confirmed`

Location:
- `response-tracker.js:216-223`
- `response-tracker.js:302-311`
- `response-tracker.js:390-401`

Evidence:

当前：

```text
_lastProtocolVerdict === false
```

只表示最近一次协议判定不是完成。

`_domFallbackAllowed()` 在该状态下又允许：

```text
Date.now() - _lastProtocolVerdictAt > DOM_CONFIRM_MS
```

也就是说，协议明确返回：

```text
asyncInProgress=true
turnComplete=false
```

之后，只要后续协议请求连续失败超过 2 秒，DOM fallback 就重新获得成功资格。

我用 stub 独立复现：

```text
第一次协议读取：明确 asyncInProgress=true
之后协议读取：network error
DOM：complete + copy + stop 消失 + 文本稳定
```

最终得到：

```text
state=completed
completionSource=dom
```

这直接违反当前契约。

Trigger:

协议最近一次成功读取明确表示仍在生成，随后协议暂时不可用超过 `DOM_CONFIRM_MS`，同时 DOM 显示完成。

Impact:

Thinking / generation 尚未真正结束时，CLI 可以把 DOM 中间状态当成最终回复。

Invariant violated:

> 协议明确仍在生成时 DOM 证据不得提前成功。

Recommended fix:

区分至少：

```text
PROTOCOL_GENERATING
PROTOCOL_NOT_CONFIRMED
PROTOCOL_UNAVAILABLE
PROTOCOL_COMPLETED
```

而不是只保存 `true/false/null`。

一旦最近一次可信协议状态为“正在生成”，协议没有重新证明终止之前，DOM 不得 fallback 成功。

Required regression test:

新增场景：

```text
first fetch => asyncInProgress=true
subsequent fetch => network error
DOM => complete
wait > DOM_CONFIRM_MS
assert result.state !== 'completed'
```

---

[V2.0.0-P1-02] P1 — `403 forbidden` / `404 not_found` 被错误允许通过 DOM fallback 变成成功

Confidence:
`Confirmed`

Location:
- `response-tracker.js:369-405`
- `response-tracker.js:220-223`

Evidence:

所有非 `rate_limited` 的 `ProtocolError` 都进入统一错误路径。

当前没有根据：

```text
err.kind
```

限制 DOM fallback。

因此 `forbidden`、`not_found` 同样可以进入：

```text
_completedFromDom(...)
```

我独立用 `ProtocolError('forbidden', ..., {status:403})` + 完整 DOM 证据复现，结果为：

```text
state: completed
completionSource: dom
```

Trigger:

协议返回 403/404，而页面 DOM 仍有完整回复。

Impact:

CLI 将明确的权限/资源错误转换为成功结果，调用方无法区分：

```text
真正完成
```

和：

```text
协议拒绝访问
```

Invariant violated:

- 协议失败必须保留类型化错误；
- DOM fallback 只能用于允许的“协议暂时不可用”路径。

Recommended fix:

对 fallback 使用明确 allowlist。

至少：

```text
network
server
rate_limited
auth
```

与：

```text
forbidden
not_found
```

严格分离。

Required regression test:

分别模拟：

```text
403 + DOM complete => 非 completed
404 + DOM complete => 非 completed
401 + DOM complete => 按既定 401 fallback 契约验证
503 + DOM complete => completed(dom)
network + DOM complete => completed(dom)
```

---

[V2.0.0-P1-03] P1 — JSON POST 请求仍未设置 `Content-Type: application/json`

Confidence:
`Confirmed`

Location:
- `web-protocol.js:75-99`
- `web-protocol.js:236-240`
- `web-protocol.js:277-288`
- `web-protocol.js:291-296`

Evidence:

`authFetchInPage()` 构造 fetch 时：

```text
headers = Authorization + options.headers
body = options.body
```

没有为 JSON body 自动增加：

```text
Content-Type: application/json
```

而以下调用全部传入 JSON string：

```text
createRemoteFile()
markFileUploaded()
processProjectUploadStream()
upsertProject()
```

浏览器 Fetch 对普通 string body 默认使用 `text/plain;charset=UTF-8`，不是 JSON。

这与本轮描述的“已修复 `_authFetch` 缺少 Content-Type 导致 422”不一致。

Trigger:

执行任意上述 JSON POST。

Impact:

依赖严格 JSON Content-Type 的 endpoint 可以返回 422/400，尤其直接影响 PR06 Project/Sources 写入链路。

Invariant violated:

`N/A` — API Contract / RPC Contract。

Recommended fix:

`_authFetch` 在 `body` 为 JSON string 且调用方未显式指定 Content-Type 时，统一设置：

```text
Content-Type: application/json
```

同时不要影响非 JSON body。

Required regression test:

stub `page.evaluate()` 捕获 `_authFetch` 参数，验证：

```text
createRemoteFile() => Content-Type=application/json
processProjectUploadStream() => Content-Type=application/json
upsertProject() => Content-Type=application/json
```

---

[V2.0.0-P1-04] P1 — `process_upload_stream` 的 NDJSON 响应仍被当作普通 JSON 解析

Confidence:
`Confirmed`

Location:
- `web-protocol.js:284-288`
- `web-protocol.js:126-133`

Evidence:

`processProjectUploadStream()` 调用 `_authFetch()`。

而 `_authFetch()` 最终固定执行：

```text
JSON.parse(res.text)
```

如果响应为 NDJSON：

```text
{"event":"start"}
{"event":"done"}
```

整个字符串无法被 `JSON.parse()` 解析。

我独立用多行 NDJSON response 复现，得到：

```text
ProtocolError(kind="parse")
响应不是合法 JSON
```

Trigger:

ChatGPT 的 `process_upload_stream` 返回多个 NDJSON event。

Impact:

项目 Sources 上传在：

```text
create file
→ blob upload
→ process_upload_stream
```

阶段失败，即使前面的文件已经上传成功。

同时会产生 orphan remote file 的后续清理问题。

Invariant violated:

`N/A` — Project/Sources API Contract。

Recommended fix:

为 streaming endpoint 单独实现：

```text
text/event-stream / NDJSON parser
```

而不是复用强制 `JSON.parse()` 的普通 JSON transport。

Required regression test:

输入：

```text
{"event":"start"}\n
{"event":"processing"}\n
{"event":"done"}\n
```

验证：

- 不抛 parse error；
- 正确识别最终完成事件；
- malformed NDJSON 才返回 `parse` error。

---

[V2.0.0-P1-05] P1 — 项目创建失败时可能错误返回当前已有项目

Confidence:
`Confirmed`

Location:
- `project-controller.js:174-184`
- `project-controller.js:197-204`

Evidence:

创建请求：

```text
this.protocol.upsertProject(payload).catch(() => null)
```

直接吞掉错误。

如果 upsert 失败，代码继续执行：

```text
projectPath = normalizeProjectHomePath(this.pages.url())
```

因此当前页面如果恰好已经位于某个旧项目主页，会被当成“新项目创建结果”。

我用现有代码 stub 复现：

```text
当前 URL = /g/g-p-...-old/project
upsertProject() => throw Error
```

`createProject("new")` 仍返回旧项目的：

```text
projectId
projectPath
```

Trigger:

创建项目时 API upsert 失败，同时 Chrome 当前页面已经位于一个项目页面。

Impact:

`--new-project` / `/newproject` 可以静默切换到错误的已有项目，而调用方得到成功结果。

Invariant violated:

`N/A` — Project creation correctness / persistence consistency。

Recommended fix:

不要吞掉 upsert 错误。

只有以下路径才允许成功：

```text
upsert 成功并返回 project id
```

或：

```text
明确观察到由本次创建触发的新 project navigation
```

不能使用“当前 URL 已经是项目”作为创建成功证据。

Required regression test:

```text
current URL = existing project
upsertProject rejects
waitForNavigation = none
assert createProject rejects
assert existing project is not returned
```

---

[V2.0.0-P1-06] P1 — 项目文件删除的验证失败会被当成删除成功

Confidence:
`Confirmed`

Location:
- `file-controller.js:239-248`

Evidence:

删除后的验证：

```text
fetchGizmoConfig(...).catch(() => null)
```

随后：

```text
const stillThere = fresh && ...
if (!stillThere) break;
```

因此：

```text
fetchGizmoConfig() 抛错
→ fresh = null
→ stillThere = null
→ !stillThere === true
→ break
→ return success
```

我独立 stub 复现该路径，`deleteProjectSource()` 最终正常返回 `hardDeleted: true`。

此外，如果 30 秒内始终看到文件，循环结束后也没有抛错，仍然返回成功。

Trigger:

硬删除完成后，删除验证请求失败，或 30 秒内无法确认文件消失。

Impact:

CLI 可以报告：

```text
已删除
```

但实际状态是未知，甚至仍然存在。

Invariant violated:

“所有写操作在确认目标项目与结果后才返回成功。”

Recommended fix:

把：

```text
读取失败
```

和：

```text 文件不存在
```

严格区分。

验证超时或读取失败必须返回非成功结果。

Required regression test:

覆盖：

```text
deleteRemoteFile succeeds
fetchGizmoConfig verification throws
=> assert deleteProjectSource rejects

deleteRemoteFile succeeds
file remains after deadline
=> assert deleteProjectSource rejects

file disappears
=> success
```

---

[V2.0.0-P1-07] P1 — 显式模型选择允许模糊 substring 命中，且没有真正验证选择结果

Confidence:
`Confirmed`

Location:
- `model-controller.js:177-199`
- `model-controller.js:235-250`

Evidence:

精确匹配失败后：

```text
normalizeText(m.label).includes(target)
```

因此：

```text
--model "GPT-6"
```

在没有精确 `GPT-6`、但存在 `GPT-6 Pro` 时，会选择：

```text
GPT-6 Pro
```

而不是报“不存在”。

同时所谓“验证”实际上只检查：

```text
readCurrent() 是否返回非 null
```

没有比较：

```text
实际模型 == requested model
实际 effort == requested effort
```

我独立 stub 复现了：

```text
requested = GPT-6
available = GPT-6 Pro
```

结果直接选择 `GPT-6 Pro`。

Invariant violated:

> 模型/思考强度不存在或无权限时直接失败；不得降级、不得静默切换。

Recommended fix:

显式 `--model`：

- 只接受唯一 exact normalized match；
- 不接受 substring fallback；
- 点击后重新读取菜单选中项；
- 实际选择与 requested 不一致直接失败。

Required regression test:

```text
available = ["GPT-6 Pro", "GPT-5.6 Sol"]
request = "GPT-6"
=> reject

selection click succeeds but selected flag remains old
=> reject

selection succeeds and exact selected model matches
=> pass
```

---

[V2.0.0-P1-08] P1 — 交互模式模型策略失败后仍继续接受消息

Confidence:
`Confirmed`

Location:
- `cli.js:648-656`

Evidence:

交互模式初始化：

```text
try {
  applyModelConfig(...)
} catch (e) {
  spinner.warn(...)
}
```

异常只变成 warning，没有阻止进入 REPL。

因此默认模型策略失败时，CLI 仍然允许用户继续发送消息。

Trigger:

模型菜单失效、模型选择失败、DOM_CHANGED、账号权限异常等导致 `applyModelConfig()` reject。

Impact:

用户以为 CLI 已应用：

```text
最新模型 + 最高强度
```

实际可能继续使用 Chrome 当前已有模型/强度。

Invariant violated:

模型不存在/无权限时不得静默降级或继续使用未知配置。

Recommended fix:

初始化模型策略失败应进入失败状态，不进入可发送 REPL。

如果产品明确允许“连接成功但模型策略未验证”，则必须显式进入 degraded state，且发送前再次拒绝或要求用户确认；不能仅打印 warning。

Required regression test:

```text
applyModelConfig rejects
=> interactive session must not accept/send a message
=> process/session enters failure state
```

---

[V2.0.0-P1-09] P1 — 非法协议 JSON schema 会被解析成“空 mapping”，违反禁止静默空快照

Confidence:
`Confirmed`

Location:
- `web-protocol.js:143-151`
- `conversation-parser.js:394-415`

Evidence:

`fetchConversation()` 对 HTTP 200 JSON 只执行：

```text
parseConversationPayload(payload)
```

而：

```text
parseConversationPayload({})
```

不会报错，而会进入：

```text
parseMappingPayload({})
```

最终产生：

```text
shape: "mapping"
messages: []
completion.turnComplete: null
```

我独立执行：

```text
HTTP 200 body = {}
```

得到上述空快照，而不是 `ProtocolError(kind="parse")`。

Trigger:

ChatGPT backend schema 发生变化、返回错误 JSON object、或 endpoint 返回非预期 object。

Impact:

协议结构已经失效，但 CLI 看起来仍获得了一个“合法 snapshot”，之后可能：

- 等待到 timeout；
- 或使用 DOM fallback；
- 或向上层返回空消息。

Invariant violated:

> 协议失败不得静默返回空快照/空回复；必须抛出类型化错误。

Recommended fix:

对 conversation payload 做最小 schema validation：

```text
messages[] + page_info
```

或：

```text
mapping object
```

二者都不存在时直接：

```text
ProtocolError('parse')
```

Required regression test:

```text
{}
{"foo":"bar"}
{"messages":"invalid"}
```

均必须产生 `ProtocolError(kind="parse")`。

---

[V2.0.0-P1-10] P1 — 最终协议读取失败被吞掉，仍返回 `completed` 且 `error=null`

Confidence:
`Confirmed`

Location:
- `response-tracker.js:343-361`
- `response-tracker.js:417-436`

Evidence:

协议第一次读取确认：

```text
turnComplete === true
```

之后 `_readFinalResult()` 失败时：

```text
catch {
  return {
    text: this._lastText,
    ...
    partial: true
  };
}
```

随后 `_tick()` 无条件：

```text
state: 'completed'
error: null
```

我独立复现：

```text
fetchConversation => completed
readConversation => ProtocolError('forbidden')
```

最终仍为：

```text
state=completed
completionSource=protocol
partial=true
error=null
```

Trigger:

完成信号已经确认，但最终完整读取请求失败。

Impact:

协议最终读取失败被隐藏，调用方收到“completed”且没有错误信息。

Invariant violated:

- 最终回复成功读取才应作为完整 `completed`；
- 协议失败必须保留/传播类型化错误。

Recommended fix:

最终读取失败时：

- 传播 `ProtocolError`，或
- 返回非 `completed` 的 partial/unknown 结果，并保留 `kind/status/endpoint`。

不要以 `completed + error=null` 表示读取失败。

Required regression test:

```text
fetchConversation => completed
readConversation => ProtocolError(network/403)
=> assert result is not a clean completed result
=> assert error.kind/type is preserved
```

---

[V2.0.0-P1-11] P1 — 发送请求 fixture 仍把已删除的 model 注入逻辑当成必须行为

Confidence:
`Confirmed`

Location:
- `test/fixtures-contract.test.js:281-306`
- `test/fixtures/f-conversation-request.json:16-66`
- `docs/contracts/chatgpt-web-contract.md:109`

Evidence:

当前 v2 Requirement 明确：

> 删除 CDP 拦截注入 `model` 字段。

但测试仍断言：

```text
assert.ok(body.model, 'model 字段是 CDP 注入目标，必须存在')
```

fixture 甚至明确记录：

```text
adapter.withConversationFetchPatch ... 改写 model 字段
```

因此，如果未来有人错误地恢复 model request mutation，这个测试反而会继续通过。

Invariant violated:

> 不得改写请求 model 字段；模型只通过页面菜单选择。

Recommended fix:

删除旧的 injection contract。

重新定义 fixture/test 为：

```text
页面原生请求中的 model/effort 保持不变
```

并对 `_sendWithAttachments()` 做直接回归测试：

```text
附件注入可以修改 attachments
但不得修改 model / thinking_effort
```

Required regression test:

模拟 `Fetch.requestPaused`：

```text
original model = X
original thinking_effort = Y
attachment injection
=> model === X
=> thinking_effort === Y
=> attachments 增加
```

---

## P2

[V2.0.0-P2-01] P2 — JSON 结果中的模型名可能滞后于当前 UI 选择

Confidence:
`Confirmed`

Location:
- `commands.js:81-90`
- `client.js:351-362`

Evidence:

`/model` 在已有 Conversation/Project 中直接调用：

```text
conversation.selectModel()
project.selectModel()
```

但没有同步：

```text
client.modelSelection
```

随后 `sendInConversation()` 生成 JSON model 信息时：

```text
this.modelSelection.modelLabel
```

优先级高于刚刚读取的当前 UI 状态。

Trigger:

长生命周期 REPL 中：

```text
初始化 GPT-6
→ /model GPT-5.6 Sol
→ send
```

Impact:

实际请求可能使用新模型，但 JSON 结果仍报告旧模型。

是否阻塞：

否。属于结果 metadata correctness，当前核心发送链路仍可能正确。

Recommended fix:

统一模型状态 ownership；发送结果优先使用刚刚验证过的实际当前选择。

Required regression test:

```text
initial model = GPT-6
switch UI = GPT-5.6 Sol
send
=> result.model.name === GPT-5.6 Sol
```

---

## Observations

[OBS-01] 协议/DOM 兜底状态机的主要风险集中在“协议错误分类”和“最近一次协议状态的 freshness”两个维度。

证据：

- `_lastProtocolVerdict` 只有 `true/false/null`；
- DOM fallback 同时依赖错误路径、时间窗口和该值；
- 403/404 与 network/server 没有独立 gate。

后续建议：

将 protocol state 与 protocol error class 显式建模，而不是继续增加 boolean 条件。

是否阻塞：

是——当前已由 P1 Finding 覆盖。

---

[OBS-02] PR06 写链路仍存在明显的 runtime contract 未闭环区域。

已确认的代码缺口包括：

- JSON POST Content-Type；
- NDJSON parser；
- 删除验证失败处理；
- Project create failure handling。

这与当前文档中的 `probe-pending` 状态一致，但这些路径已经进入 v2 核心 Milestone，因此不能再仅依赖成功路径实机验证。

是否阻塞：

是——当前由 P1 Findings 覆盖。

---

[OBS-03] 当前归档的自动化测试无法在本 Review 容器完成真实 DOM 测试。

证据：

```text
test/dom-selectors.test.js
```

加载时需要：

```text
puppeteer-core
```

当前归档工作目录没有可用 root `node_modules/puppeteer-core`；尝试 `npm ci --ignore-scripts` 超时。

非浏览器逻辑测试独立执行结果：

```text
88 passed / 0 failed
```

这不是代码 Finding，但意味着本 Review 无法独立重跑真实 Chrome selector smoke。

是否阻塞：

否；用户提供的 Chrome 155 实机结果可作为外部验证证据，但不能替代上述 P0/P1 修复后的回归测试。

---

[OBS-04] `docs/contracts/chatgpt-web-contract.md` 中仍存在旧 `adapter.js` / model injection 描述。

例如：

```text
3.2 adapter.withConversationFetchPatch
```

与 v2 已删除 `adapter.js` 的实现状态不一致。

是否阻塞：

否。

---

## Required Regression Tests

修复后至少新增/强化以下测试：

1. **CDP exposure security smoke**
   - WSL 能连接；
   - 非授权 LAN 主机不能连接 9224；
   - firewall/portproxy 规则限制在预期来源。

2. **Protocol-running + outage**
   - 首次协议明确 `asyncInProgress=true`；
   - 后续协议请求全部 network error；
   - DOM complete；
   - 最终不得 `completed(dom)`。

3. **Forbidden / not_found fallback**
   - `403` + DOM complete → 不得 completed；
   - `404` + DOM complete → 不得 completed。

4. **JSON POST headers**
   - `createRemoteFile`；
   - `markFileUploaded`；
   - `processProjectUploadStream`；
   - `upsertProject`；
   - 均验证 `Content-Type: application/json`。

5. **NDJSON upload stream**
   - 多行 NDJSON；
   - 多 event；
   - malformed event；
   - 正确区分完成和 parse failure。

6. **Project creation failure**
   - upsert reject；
   - 当前页面已在旧项目；
   - 必须 reject，不能返回旧项目。

7. **Project deletion verification**
   - verification request failure；
   - file remains after deadline；
   - 两者都不得报告成功。

8. **Exact model selection**
   - substring-only match 必须 reject；
   - click 后实际 selected 状态不一致必须 reject；
   - exact model + exact effort 才成功。

9. **Interactive model initialization**
   - `applyModelConfig()` reject；
   - REPL 不得进入可发送状态。

10. **Protocol schema validation**
    - `{}`；
    - unknown object；
    - malformed `messages`；
    - 均必须 `ProtocolError(kind="parse")`。

11. **Final result read failure**
    - 初次 fetch confirmed；
    - final read network/403；
    - 不得返回 clean `completed/error=null`。

12. **No model injection regression**
    - attachment injection 只能改变附件字段；
    - 不得修改 `model`；
    - 不得修改 `thinking_effort`。

13. **Model result metadata**
    - `/model` 后再次 send；
    - JSON 中必须报告当前实际模型。

## Exit Criteria

当前版本**尚未达到 Review PASS 条件**。

原因不是测试数量，而是存在：

```text
P0 = 1
P1 = 11
P2 = 1
```

因此当前：

```text
Result = FAIL
```

必须优先关闭：

```text
P0-01
P1-01 ~ P1-11
```

然后执行：

```text
Fix
→ Required Regression Tests
→ npm test
→ Chrome 155 实机 smoke
→ Project/Sources failure-path smoke
→ Verify
```

至少需要达到：

```text
P0 = 0
P1 = 0
Full Test Suite = PASS
Required Chrome/WSL smoke = PASS
```

之后才可以结束本轮 Review / Fix / Verify Loop。

本轮仅进行了独立审查和验证，没有修改源码。
:::
