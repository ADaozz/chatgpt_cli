# Code Review Finding 格式

所有 P0 / P1 / P2 Finding 使用统一格式。

---

## Finding ID

推荐：

```text
<Milestone>-<Severity>-<Number>
```

例如：

```text
R3.1b-P1-01
R3.1b-P1-02
R3.1b-P2-01
```

如果当前没有合适 Milestone：

```text
TURN7-P1-01
TURN7-P2-01
```

同一次 Review 中 Finding ID 不得重复。

---

## 标准 Finding

```text
[FINDING-ID] P1 — 简短标题

Confidence:
Confirmed / Likely / Hypothesis

Location:
- path/to/file.py:123
- ClassName.methodName()

Evidence:
描述当前实现中的具体代码事实。

Trigger:
说明触发条件。

Impact:
说明触发之后产生的实际后果。

Invariant violated:
说明违反的 Invariant。
没有明确 Invariant 时填写 N/A。

Recommended fix:
说明推荐的修复方向。

Required regression test:
说明必须新增或强化的测试。
```

---

## Confidence

### Confirmed

当前代码可以直接证明问题成立。

### Likely

存在明确代码路径，但依赖特定运行条件。

### Hypothesis

目前只有推测，需要运行时实验才能验证。

P0 / P1 原则上不得仅依据 Hypothesis。

如果证据不足，应优先降级为 Observation。

---

## Location

尽量给出：

- 文件路径
- 类
- 函数
- 方法
- 关键代码位置

不要只写：

```text
PTY 模块
```

应该尽量写：

```text
runtime/src/wsl_deck_runtime/pty.py
PtyManager.close()
```

---

## Evidence

Evidence 描述：

> 当前代码到底做了什么。

不要写：

```text
这里可能有 Race。
```

应该描述具体路径，例如：

```text
natural exit 路径和 explicit close 路径都可能进入 finalize，
但当前 ownership guard 无法证明 exactly-once，因此两条路径并发时可能重复发出 exit。
```

---

## Trigger

Trigger 描述：

> 什么条件下会进入这个问题路径。

例如：

```text
PTY 子进程 natural exit 与用户同时调用 pty.close()。
```

不要只写：

```text
并发情况下。
```

---

## Impact

必须说明真实影响，例如：

```text
同一 session 可能出现两次 exit event。
```

不要只写：

```text
行为不稳定。
```

---

## Invariant

优先引用项目真实 Invariant，例如：

```text
Exactly one exit event per PTY session.
```

```text
CLOSING sessions reject input and resize.
```

```text
Output seq remains contiguous.
```

如果项目中不存在明确 Invariant：

```text
N/A
```

不要编造。

---

## Recommended Fix

描述修复方向。

Review 阶段不要求直接提供完整代码实现。

例如：

```text
统一 natural exit 和 explicit close 的 finalize ownership，
并为 finalize 路径增加 exactly-once guard。
```

不要默认输出整个文件重写。

---

## Required Regression Test

测试要求必须可执行。

推荐：

```text
创建 PTY，
让子进程 natural exit，
同时并发调用 close()，
最终 assert exit frame count == 1。
```

不要只写：

```text
增加相关测试。
```

---

## Observation 格式

Observation 不要求完整 Finding Schema。

推荐：

```text
[OBS-01] 标题

说明：
...

证据：
...

后续建议：
...

是否阻塞：
否
```
