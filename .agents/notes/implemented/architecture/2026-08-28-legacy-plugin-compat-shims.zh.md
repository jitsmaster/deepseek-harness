# Agent Note: 为 0.1.2 之前的插件提供遗留包兼容 shim

Status: implemented

[English](2026-08-28-legacy-plugin-compat-shims.md) | 中文

## Problem

`dsh` 0.1.2-alpha.1 迁移了两个第三方插件仍然依赖的接口面：

- Host API Proxy（`@deepseek-ai/dsh-host-apiproxy`，以及 `apiProxy` 服务）被移除；一元操作迁移到了各自所属的业务 Remote（[迁移说明](2026-08-10-unary-apiproxy-remote-migration.md)）。
- client runtime（`@deepseek-ai/dsh-client-runtime`，以及它的 `sessions` 与 `workspaces` 客户端服务）被拆分到 api controller（`@deepseek-ai/dsh-api-session-controller`、`@deepseek-ai/dsh-api-workspace-controller`）。

外部已发布的插件 bundle（例如 `@linxin666/dsh-web-ui-all` 0.1.x，以及仍面向旧接口面的 0.3.x 线）硬导入 `@deepseek-ai/dsh-host-apiproxy/api/rpc`，硬注入 `apiProxy` 服务，并从浏览器模块表中 `require("@deepseek-ai/dsh-client-runtime/client")`。在未修改的 0.1.2-alpha.1 代码树上，这些插件会失败：服务端启动因 `ERR_MODULE_NOT_FOUND` 而终止，web 启动页则报告 loader fiber 失败。

升级插件也无济于事：`@linxin666/dsh-remote-web-ui` 的每个已发布版本（0.1.20 到 0.3.6）仍然导入 `dsh-host-apiproxy`，`@linxin666/dsh-client-ui-web-ui-settings` 0.3.6 仍然导入 `dsh-client-runtime`。安装旧的 npm 包同样行不通：它们会把旧的 `0.1.1-rc.2`／`0.1.0-rc.6` 依赖闭包拖进 profile，遮蔽新 harness 的包。

## Decision

在 `packages/compat/` 下提供两个私有的遗留兼容包，只提供第三方 bundle 实际使用的接口面，不带依赖闭包：

- `packages/compat/host-apiproxy`——`@deepseek-ai/dsh-host-apiproxy`。
  - 零依赖的 `api/*` 约定层（仅依赖 zod），原样引入自已发布的 `0.1.0-rc.6`（插件构建时所针对的版本）：`api/rpc`、`api/rpc.schema`、`api/events.schema`、传递依赖的 schema 模块，以及类型声明。
  - `lib/compat-provider.js`——一个 profile 条目，注册桩 `apiProxy` 服务。每次方法调用都会抛出明确的“unavailable”错误，因此 cordis 注入得以成功，而远程／移动端数据通道保持禁用。`apiProxy` 服务被有意不实现：harness 不再拥有该服务。
- `packages/compat/client-runtime`——`@deepseek-ai/dsh-client-runtime`。
  - 一个浏览器模块表行（`dsh.client` 声明，无注入），其 bundle 恰好导出 `createSnapshotStore` 与 `defineStore`，保持旧的可观察语义（带 getSnapshot／subscribe／update／set 的快照存储，可选的 localStorage 持久化，可选的 rAF 批处理；声明式存储构建器）。客户端入口 `apply` 是空操作：它不得注册 `sessions`／`workspaces`，这两项如今由 api controller 所有——安装完整旧 runtime 的原始失败模式恰恰就是这种服务冲突（web 启动页随后报告 `@deepseek-ai/dsh-api-session-controller` 与 `@deepseek-ai/dsh-api-workspace-controller` 的 fiber 失败）。

profile 通过 `link:` 依赖使用这些包（与 `dsh-cost-balance` 等树外用户插件相同的模式），并通过两个 `cordis.patch.yml` 插入项启用它们：`dsh-host-apiproxy-compat` 与 `client-runtime`。

## Consequences

- 面向已移除接口面的第三方插件得以激活并加载；它们对旧 API 的运行时调用会平稳降级（例如移动端通道与任务看板预设名册只记录错误，而不会使启动崩溃）。
- 这些 shim 是私有的，从不发布；它们是针对插件生态的权宜之计，而非受支持的接口面。待插件作者完成迁移后，删除 `packages/compat/` 与 profile 条目。
- api/ 约定文件是引入后冻结在 `0.1.0-rc.6` 的；不要用新的 API 接口面扩展它们。
