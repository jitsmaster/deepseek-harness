# @deepseek-ai/dsh-client-runtime（兼容 shim）

[English](README.md) | 中文

**遗留包。不要基于它构建新代码。**

旧的 client runtime 已在 `dsh` 0.1.2-alpha.1 中迁移：它原先提供的 `sessions` 与 `workspaces` 客户端服务，现在归 `@deepseek-ai/dsh-api-session-controller` 与 `@deepseek-ai/dsh-api-workspace-controller` 所有。针对旧 harness 发布的第三方客户端 bundle（例如 `@linxin666/dsh-web-ui-all` 0.1.x）仍会从浏览器模块表中 `require("@deepseek-ai/dsh-client-runtime/client")`，因此本 shim 提供一个模块表行，恰好导出这些 bundle 所使用的成员：

- `createSnapshotStore(init, opts)`——快照存储，提供 `getSnapshot`、`subscribe`、`update`（immer 风格的 draft 变更）与 `set`，并可选支持整值 `localStorage` 持久化（`opts.persist.name`）和按 `requestAnimationFrame` 批处理的通知（`opts.flush === "raf"`）。
- `defineStore(decl)`——声明式存储构建器（`{ init, actions, persist }`），返回 `{ spec, create(scopeKey) }`。

本 shim **不**注册 `sessions`／`workspaces` 服务，因此不会与当前拥有这些名称的 api controller 冲突。它的客户端入口 `apply` 是空操作。
