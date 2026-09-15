# Agent Note: 常驻统计栏

Status: implemented

[English](2026-09-15-persistent-stats-bar.md) | 中文

## Problem

`StatsPills` 在 composer 旁渲染 turns/steps、解码速度以及 token/cache 命中率等数字，但只要 composer 滚出可见区域，或另一个面板占据了 `'main'`，这份读数就会消失。此前没有面向整个 frame、始终可见的当前 session 整份 log 统计读数，也没有可供其读取的 root scope session 统计来源：`StatsPills` 通过 `useProjection`（一个 session-scoped 的 slot hook）读取数字，而 root-scoped 组件无法调用它。

## Decision

`packages/client/ui-chat` 新增一个 root-scoped、始终可见的 `PersistentStatsBar`，通过 `packages/client/ui-chat/src/client/apply.ts` 中的 `shell.overlay` 注册（`id: 'persistent-stats'`，`order: 0`）固定在右下角。它与既有的 composer-scoped `StatsPills` 共存，后者不做改动。

`packages/client/ui-chat/src/client/chat/active-session-stats.ts` 把 root scope 与 session 数据连接起来：`createActiveSessionStatsSource(sessions, sessionList)` 构建一个 `HostObservable<ActiveSessionStatsSnapshot>`，通过 `ISessions.binding(id).projections.faceOf(...)` 读取当前 session id 的 `sessionStats`/`tokenUsage` projection face，并在当前 session id 变化时重新订阅这两个 face。`apply.ts` 构造一个实例，并通过 `ctx.slots.provideRoot({ hooks: { activeSessionStats } })` 发布；`packages/client/ui-chat/src/client/contract/slots.ts` 在 `GlobalStandardProps` 上声明 `useActiveSessionStats`，使任何 root-scoped 组件都能从中选取数据。

`syncFaceSubscriptions()` 在每次 `getSnapshot()` 调用时都会重新检查 binding 能否解析，而不仅在 session 列表变化事件发生时检查。一个 session 可能先出现在列表中，其 binding 之后才能解析；如果没有这一逐次读取的检查，在 binding 尚未解析时取得的 `getSnapshot()` 会让 face 订阅保持陈旧，即使 binding 之后变为可解析，也不会因为没有新的 session 列表 notify 事件而重新触发同步。这与 `ui-session` 的 `resolve()` 中"下次访问时重新解析"的既有做法一致。

`PersistentStatsBar.tsx` 在没有当前 session 时渲染 `null`；当当前 session 的窗口既没有 steps 也没有已计费 token 时同样渲染 `null`——与 `StatsPills` 对自身行使用的空态判定相同。它复用 `StatsPills.tsx` 的 `billedInputTokens`、`cacheHitPercent`、`formatDuration` 等 helper，而不是重新实现 token/时长格式化，并通过 `PersistentStatsBar.module.css` 完成布局。

## Alternatives considered

**用新统计栏替换 `StatsPills`。** 不采用；改为让新栏与旧栏共存。这是一项明确的产品决定，而非技术默认选择——composer 旁的行与 frame 级的栏满足不同的可见性需求，新栏的数据来源本身也不要求淘汰旧栏。

**改动 `AppFrame.tsx` 的 slot scope，让 session-scoped hook 能触达 frame。** 不采用，改为在 `ui-chat` 的 `apply.ts` 内用 `ISessions.binding(id).projections.faceOf(...)` 把 root scope 与 session 数据连接起来。放宽 `AppFrame.tsx` 的 scope 边界会是一次比新增一个 root-scoped 数据源更大、更有风险的结构性改动；同样的 `sessions.binding(id)` 穿透方式已经作为先例存在于 `ui-workspace`（`packages/client/ui-workspace/src/client/index.ts`）中。

**为该栏提供 popover、dialog 或 window-fold 回退**，与 `StatsPills` 可展开出更多细节的方式一致。不采用：root scope 没有 `useChat` node-window 访问权限，没有可折叠展开的内容。该栏刻意只显示两项读数，在 durable-log projection 填充之前不显示其他内容。

## Consequences

- 无论哪个面板占据 `'main'`，也无论 composer 是否滚动到可见区域，当前 session 的统计/cache 命中率读数都会在整个 frame 范围内保持可见。
- 现在有两个组件通过两种不同机制读取重叠的 session 统计数据（`StatsPills` 使用 `useProjection`，`PersistentStatsBar` 使用新的 root `activeSessionStats` hook）；两者实际上都仍是 session-scoped 的，但只有 `StatsPills` 被限制在 composer 的 `'session'` slot scope 内。
- `active-session-stats.ts` 在 `ui-workspace` 之外新增了一个 `ISessions.binding` 消费方，进一步确立 `binding().projections.faceOf(...)` 作为从 root scope 读取 session projection 的标准桥接方式。
- 在 `sessionStats`/`tokenUsage` projection 填充之前该栏不显示任何内容；一个既没有 steps 也没有已计费 token 的 session 完全不渲染该栏，而不是渲染一个空的或占位的栏。
- 单元测试覆盖了 `createActiveSessionStatsSource` 的无 session、binding 未解析、face 读取、session 切换重新订阅、任一 face 触发 notify、快照引用稳定性，以及"稍后读取时重新检查"等行为，也覆盖了 `PersistentStatsBar` 的空渲染、两者皆空、仅 steps、仅 tokens，以及稳定的 selector 属性等场景。
