# Iteration Exit Criteria

本规则用于决定：

> 当前 Review / Fix / Verify Loop 是否已经可以结束。

目标不是追求无限优化。

目标是在关键问题关闭后及时收敛。

---

## PASS 的最低前提

必须满足：

```text
P0 = 0
P1 = 0
```

同时关键 Regression Tests 必须：

```text
PASS
```

如果项目存在完整测试集：

```text
Full Test Suite = PASS
```

如果本轮涉及：

- Runtime
- Process
- Platform Integration
- WSL
- Windows
- IPC
- 外部工具链

则相应 Required Smoke Tests 也必须通过。

---

## PASS

满足：

```text
P0 = 0
P1 = 0
关键 Regression Tests = PASS
Full Tests = PASS
Required Smoke Tests = PASS
```

则：

```text
Result: PASS
```

---

## PASS WITH P2

满足：

```text
P0 = 0
P1 = 0
P2 > 0
关键测试通过
```

则：

```text
Result: PASS WITH P2
```

P2 默认进入 Backlog。

除非用户明确提高优先级，否则 P2 不阻塞当前 Milestone。

---

## FAIL

以下任一条件成立：

```text
P0 > 0
```

或者：

```text
P1 > 0
```

或者：

```text
关键 Regression Test 失败
```

则：

```text
Result: FAIL
```

---

## 测试无法执行

如果因为环境限制导致必要测试无法执行，不得直接判定：

```text
PASS
```

应该明确：

```text
需要运行时验证
```

或者：

```text
Conditionally Pass
```

并列出未验证项。

最终是否接受由用户决定。

---

## 防止无限 Review Loop

达到 Exit Criteria 后，应停止当前 Review / Fix / Verify Loop。

以下内容默认不能继续阻塞当前 Iteration：

- 可以进一步抽象
- 可以增加日志
- 可以优化命名
- 可以减少重复代码
- 可以未来重构
- 可以升级技术方案
- 可以做没有证据支持的性能优化

这些内容应该进入：

```text
P2
```

或者：

```text
Observation
```

---

## Review 与 Verify 的边界

Review：

```text
寻找冻结版本中的真实问题。
```

Verify：

```text
确认上一轮真实问题是否已经解决。
```

修复后优先：

```text
Fix
→ Verify
```

而不是：

```text
Fix
→ 再做一次无限范围 Full Review
```

---

## 推荐闭环

```text
Frozen Commit A
      ↓
Review
      ↓
P0 / P1 Findings
      ↓
Fix
      ↓
Regression Tests
      ↓
Commit B
      ↓
Verify
      ↓
P0 = 0
P1 = 0
Tests PASS
      ↓
DONE
```

进入 `DONE` 后，开始下一阶段或下一 Milestone。
