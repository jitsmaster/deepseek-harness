# @deepseek-ai/dsh-host-apiproxy（兼容 shim）

[English](README.md) | 中文

**遗留包。不要基于它构建新代码。**

Host API Proxy 已在 `dsh` 0.1.2-alpha.1 中移除——一元操作迁移到了各自所属的业务 Remote（见[迁移 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-10-unary-apiproxy-remote-migration.md)）。针对旧 harness 发布的第三方插件（例如 `@linxin666/dsh-web-ui-all` 0.1.x）仍会硬导入本包，因此本 shim 恰好提供它们所触及的接口面：

- `@deepseek-ai/dsh-host-apiproxy/api/rpc`、`api/rpc.schema`、`api/events.schema` 以及其他 `api/*` 约定模块，原样引入自已发布的 `0.1.0-rc.6`（这些插件构建时所针对的版本）。api/ 约定层不依赖任何 Node 模块（仅依赖 zod）。
- `lib/compat-provider.js`——一个 cordis 入口，提供桩 `apiProxy` 服务，使硬注入它的插件得以激活。每次调用 `apiProxy` 方法都会抛出“unavailable”错误：由于该服务确实已不存在，远程／移动端数据通道实际上处于禁用状态。

服务端的 `apiProxy` 服务有意**不**实现。当插件作者不再要求 `apiProxy` 时，移除本 shim 以及 `dsh-host-apiproxy-compat` profile 条目。
