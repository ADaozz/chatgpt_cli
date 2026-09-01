# 独立代码审查

请基于当前 ChatGPT Project Sources 中已经上传的：

`{{archive_name}}`

对当前冻结版本进行独立 Code Review。

本轮角色：

> Reviewer

不是实现者。

不要直接修改源码。

## Review Baseline

Project：

`{{project_name}}`

Iteration：

`{{iteration}}`

Milestone：

`{{milestone}}`

Branch：

`{{branch}}`

Commit：

`{{commit_sha}}`

Working Tree：

`{{working_tree_status}}`

## 本轮实现内容

{{changes}}

## 必须维持的 Invariants

{{invariants}}

## 已确定设计约束

{{constraints}}

这些约束已经由当前项目确认。

除非发现明确 correctness 或 security 问题，否则不要反复建议推翻。

## Review 重点

重点检查：

- Requirement 是否真正实现
- Correctness
- Lifecycle
- State Machine
- Concurrency
- Race Condition
- Exactly-once / At-most-once
- Resource Cleanup
- Shutdown
- Restart
- Cancellation
- Error Handling
- Timeout
- Backpressure
- Queue / Buffer
- API Contract
- RPC Contract
- Protocol Contract
- Permission Boundary
- Trust Boundary
- Sandbox Boundary
- Fail-open / Fail-closed
- Persistence Consistency
- Regression Risk
- Test Coverage
- Implementation 与 Requirement / ADR / Docs 是否一致

## Review 范围

优先级按照：

```text
本轮修改代码
    ↓
本轮直接关联模块
    ↓
必要时检查全局影响
```

直接关联模块包括：

- caller
- callee
- shared state
- startup path
- shutdown path
- persistence
- protocol
- tests

全局问题只有满足以下条件时才升级为正式 Finding：

- 明确存在 correctness 风险
- 明确存在 security 风险
- 会阻塞当前 Milestone
- 与本轮改动存在明确因果关系

不要无边界扩大 Review 范围。

## 测试审查

不要只判断：

```text
是否存在测试
```

还必须判断：

```text
测试是否直接验证目标 Invariant
```

例如：

如果 Invariant 是：

```text
Exactly one exit event per session.
```

测试应该直接验证：

```text
exit event count == 1
```

如果 Invariant 是：

```text
Output seq must remain contiguous.
```

测试应该直接验证序号连续。

如果 Invariant 是：

```text
CLOSING state rejects input.
```

测试必须直接验证 CLOSING 状态下 input 被拒绝。

根据模块实际职责重点考虑：

- natural exit
- explicit close
- duplicate close
- concurrent close
- shutdown
- cancellation
- timeout
- queue full
- no consumer
- slow consumer
- backpressure
- restart
- revoke
- partial initialization
- initialization failure
- cleanup failure

不要机械要求所有模块覆盖所有场景。

## 证据规则

Finding 必须区分：

### Confirmed

当前代码可以直接证明问题存在。

### Likely

存在明确代码路径，但依赖特定运行条件。

### Hypothesis

目前只能提出假设，需要运行时验证。

P0 / P1 原则上不得仅基于 Hypothesis。

证据不足时应该降级为 Observation，并明确：

```text
需要运行时验证。
```

## 禁止事项

不要：

- 为代码风格提出大量无关重构
- 因个人偏好要求更换技术栈
- 重复挑战 ADR 已接受的 Trade-off
- 将 P2 当成 Blocker
- 将 Observation 当成 Blocker
- 因测试通过就推断实现必然正确
- 因代码看起来正确就推断并发一定正确
- 为了填充内容制造 Finding
- 对没有读取到的实现进行猜测
- 无限制扩大 Review 范围

## 共享规则

严格遵守附带的：

- `review-severity.md`
- `finding-format.md`
- `exit-criteria.md`

## 输出格式

# Review Verdict

Result：

`PASS` / `PASS WITH P2` / `FAIL`

Baseline：

- Project:
- Iteration:
- Milestone:
- Branch:
- Commit:

## P0

没有则：

```text
P0: none
```

## P1

没有则：

```text
P1: none
```

## P2

没有则：

```text
P2: none
```

## Observations

没有则：

```text
Observations: none
```

## Required Regression Tests

汇总必须新增或强化的 Regression Tests。

## Exit Criteria

说明当前版本距离通过还缺少哪些条件。

你的目标不是产生尽可能多的 Finding。

你的目标是给 Coding Agent 提供：

```text
准确
+
有证据
+
可复现
+
可验证
+
可执行
```

的 Code Review 结果。
