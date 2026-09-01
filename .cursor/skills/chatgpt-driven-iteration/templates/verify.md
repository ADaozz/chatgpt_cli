# Review Finding 修复验收

请基于当前已上传源码，对上一轮 Code Review Findings 的修复结果进行定向验收。

本轮属于：

> Verify

不是新的无边界 Full Review。

## 项目信息

Project：

`{{project_name}}`

Iteration：

`{{iteration}}`

Milestone：

`{{milestone}}`

Branch：

`{{branch}}`

## 原 Review Baseline

Base Commit：

`{{base_commit}}`

## 当前修复版本

Fix Commit：

`{{fix_commit}}`

## 上一轮 Findings

{{previous_findings}}

## 本轮修改

{{changes}}

## 测试结果

{{test_results}}

## 必须维持的 Invariants

{{invariants}}

## Verify 目标

重点验证：

- 原 Finding 是否真正解决
- 原 Trigger Path 是否已经关闭
- 原 Invariant 是否恢复
- Regression Test 是否直接验证原问题
- Regression Test 是否只覆盖 Happy Path
- 修复是否只是绕过测试
- 修复是否产生新的 P0 / P1
- 新增状态、分支或资源生命周期是否产生新缺陷

## 范围限制

本轮重点范围：

```text
原 Finding
+
对应 Fix
+
对应 Regression Test
+
Fix 产生的直接副作用
```

不要重新：

- 全项目架构重构
- 展开下一 Milestone 设计
- 制造大量无关 P2
- 因风格问题重新设计稳定模块

如果发现新的独立 P0 / P1，可以作为 New Finding 提出。

未来优化优先放到 Observation。

## Finding 状态

上一轮每个 Finding 必须标记为：

- `FIXED`
- `PARTIAL`
- `OPEN`
- `NOT_REPRODUCIBLE`
- `ACCEPTED_RISK`
- `DEFERRED`

## 输出格式

# Verification Verdict

Result：

`PASS` / `PASS WITH P2` / `FAIL`

## Finding Verification

| Finding | Status | 修复证据 | Regression Test | 备注 |
|---|---|---|---|---|
| ... | FIXED / PARTIAL / OPEN | ... | ... | ... |

## New Findings

如果没有：

```text
New Findings: none
```

如果存在新问题，使用标准 Finding Format。

## Test Assessment

明确说明：

- 关键 Regression Tests 是否充分
- Full Test 是否通过
- Required Smoke Test 是否通过
- 是否仍缺少 Runtime Validation

## Final Decision

明确说明：

```text
P0 = ?
P1 = ?
P2 = ?
```

并判断当前 Milestone：

```text
可以继续
```

或者：

```text
仍需修复
```

达到 Exit Criteria 后必须收敛。

不要为了进一步优化而人为开启下一轮 Full Review。
