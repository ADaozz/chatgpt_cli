# 实施方案整理

请根据当前已经确认的分析结论或 Code Review Findings，整理一份可以直接交给 Coding Agent 执行的修改计划。

本轮不是重新进行架构分析。

不要扩大已经确认的工作范围。

## 项目信息

Project：

`{{project_name}}`

Milestone：

`{{milestone}}`

Current Commit：

`{{commit_sha}}`

## 已确认问题或方案

{{accepted_plan}}

## 必须维持的 Invariants

{{invariants}}

## 实施原则

按照当前项目真实代码结构给出修改方案。

优先使用文件级组织：

```text
path/to/file
    修改什么
    为什么修改
    行为如何变化
    保持什么 Invariant
    需要什么测试
```

必须明确：

- 修改范围
- 修改顺序
- 哪些代码不应该改
- API 是否变化
- Protocol 是否变化
- State / Lifecycle 是否变化
- 是否需要 Migration
- 需要哪些 Regression Tests
- 需要哪些 Full Tests
- 需要哪些 Smoke Tests

## 禁止事项

不要：

- 重新讨论已经决定的架构
- 添加当前目标不需要的新抽象
- 做无关重构
- 顺便升级依赖
- 顺便替换技术栈
- 因代码风格扩大修改范围

## 输出格式

# Implementation Plan

## 修改目标

简要说明本轮要解决的问题。

## 文件级修改

### `path/to/file`

修改：

原因：

保持的 Invariant：

测试：

## 新增或修改测试

列出必须增加的 Regression Tests。

## 执行顺序

按照依赖关系给出明确实施顺序。

## 验证步骤

列出：

- targeted tests
- regression tests
- full tests
- smoke tests

## 完成条件

明确说明达到哪些条件后，可以认为本轮实施完成。

输出内容应该适合直接提供给：

```text
Cursor
Codex
其它 Coding Agent
```

执行。
