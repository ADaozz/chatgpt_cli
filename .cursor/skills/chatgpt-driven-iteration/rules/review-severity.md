# Code Review 严重级别规则

严重级别表示：

> 如果当前问题不处理，对当前版本和当前 Milestone 的实际影响有多大。

严重级别不用于评价代码是否优雅。

---

## P0 — Blocker

满足以下任一条件时可以考虑 P0：

- 数据损坏
- 不可恢复状态
- 明确安全边界绕过
- Trust fail-open
- Permission fail-open
- Sandbox fail-open
- 未授权写入
- 权限提升
- Deadlock
- Permanent Hang
- 核心 Runtime 无法安全退出
- 核心协议严重失效
- 状态机进入不可恢复状态
- 当前 Milestone 无法安全交付

P0 必须：

- 当前 Iteration 修复
- 有明确代码证据
- 有明确 Trigger
- 有明确 Impact
- 尽量有 Regression Test

以下问题不能仅凭自身成为 P0：

- 命名不好
- 日志不够
- 抽象不够
- 重复代码
- 风格问题
- 可选性能优化

---

## P1 — Must Fix

P1 表示明确工程缺陷，例如：

- Correctness Bug
- 明确 Race Condition
- Lifecycle Violation
- State Transition 错误
- Exactly-once Invariant 被破坏
- 重复关键事件
- 丢失关键事件
- Resource Leak
- Error Path Cleanup 不完整
- Timeout 行为错误
- Queue / Backpressure 导致功能错误
- API Contract 不一致
- RPC Contract 不一致
- Protocol Contract 不一致
- Persistence Consistency 问题
- 可稳定触发的异常路径
- 关键 Requirement 未真正实现
- 关键 Regression Test 缺失

P1 原则上必须在当前 Iteration 修复。

P1 如果标记：

```text
ACCEPTED_RISK
```

必须由用户明确确认。

---

## P2 — Should Fix

P2 是非阻塞问题，例如：

- Robustness 改进
- Diagnostics 不充分
- Logging 不完整
- 可维护性问题
- 非关键 Edge Case
- 长期技术债
- 当前 Milestone 非核心路径问题
- 可以简化但当前实现仍然正确的结构

P2 默认：

```text
不阻塞当前 Milestone
```

可以进入 Backlog。

---

## Observation

Observation 用于：

- 架构观察
- 未来优化方向
- 当前证据不足的问题
- 需要 Runtime Validation 的假设
- 未来 Milestone 可以考虑的能力
- 不影响当前版本交付的建议

Observation 不是正式阻塞 Finding。

不得作为 FAIL 的唯一原因。

---

## Verdict 规则

```text
P0 > 0
→ FAIL
```

```text
P0 = 0
P1 > 0
→ FAIL
```

```text
P0 = 0
P1 = 0
P2 > 0
关键测试通过
→ PASS WITH P2
```

```text
P0 = 0
P1 = 0
关键测试通过
且没有阻塞项
→ PASS
```

不要为了表现 Review 深度而人为提高严重级别。
