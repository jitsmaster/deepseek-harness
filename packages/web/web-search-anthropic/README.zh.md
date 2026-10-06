---
description: "ctx.web 的 Anthropic 订阅搜索提供方：使用聊天已保存的 Claude OAuth 授权调用原生 web_search，而非另行计费的 API 密钥。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-anthropic

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-anthropic`，harness 通过 Anthropic 自己的原生 `web_search_20250305` 服务端工具搜索 web，并使用 `llm-pi-ai` 已为聊天保存的同一份 Claude 订阅 OAuth 授权（默认路由 `anthropic`）进行认证——无需单独的计量计费 API 密钥。Anthropic 的 OAuth 认证端点只接受表现为 Claude Code 的请求，因此每次搜索都带有与 Claude Code 自身发送的相同的 `anthropic-beta` 特性、身份请求头和系统提示词身份块。本提供方不自行刷新 OAuth：授权过期时，与聊天相同的方式刷新（在该路由上发送一条消息，或重新登录），本提供方会以可操作的错误呈现，而不是静默失败。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

## 目录

- [使用本包](#use-this-package)
- [搜索返回什么](#what-a-search-returns)
- [失败与恢复](#failures-and-recovery)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 web 服务、且 `llm-pi-ai` 的 `anthropic` 路由已登录的组合中挂载本提供方；它以 `anthropic-subscription` 搜索提供方身份注册。

### 何时选择

当部署已在某个 `llm-pi-ai` 路由中登录了 Claude 订阅（设置 > 模型），并希望 web 搜索计入该订阅、而不是单独的 Exa、Perplexity 或 DeepSeek 密钥时，选择此后端。没有可解析的已保存授权、也没有配置字面 token 时，提供方不可用。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-anthropic'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `route` | `anthropic` | 要复用其已保存 OAuth 授权的 `llm-pi-ai` 提供方路由 |
| `baseURL` | `https://api.anthropic.com/v1` | Anthropic Messages 端点基址；追加 `/messages` |
| `model` | `claude-sonnet-5` | Anthropic 模型 id |
| `apiVersion` | `2023-06-01` | `anthropic-version` 请求头的值 |
| `maxTokens` | `4096` | Messages 请求生成 token 数的正整数上限 |
| `maxUses` | `5` | 每次请求中 `web_search` 服务端工具使用次数的正整数上限 |

<a id="what-a-search-returns"></a>
### 搜索返回什么

每项结果映射为 `WebSearchSource`：`url`、`title`、由引用拼接而成的 `snippet`，以及作为 `publishedAt` 的 `page_age`。对于本提供方的请求形状，Anthropic 不返回生成答案，因此结果不携带 `content`。

<a id="failures-and-recovery"></a>
### 失败与恢复

提供方失败——HTTP 错误、网络失败、响应体无法解析或结构不符——以 `WebError` `WEB_PROVIDER_ERROR` 呈现；中止请求以 `WEB_ABORTED` 呈现；完全没有已保存授权则以 `WEB_PROVIDER_CREDENTIAL_MISSING` 呈现。授权过期是一个独立的 `WEB_PROVIDER_ERROR`，会说明本提供方自身不会刷新它——请在同一路由上发送一条聊天消息，或重新登录，然后重试。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **不自行刷新。** 本提供方读取已保存的授权但从不轮换它；过期 token 会以可操作的错误呈现，而不是挂起或静默失败。
- **OAuth 帧由手工维护，而非委托。** Anthropic 的 OAuth beta 请求头与 Claude Code 身份帧在此直接复现（对照 `@earendil-works/pi-ai` 的内部客户端），因为 `pi-ai` 没有 seam 可用来透传原始的提供方原生服务端工具；`pi-ai` 升级若改变了这套帧，此处需要同步更新。
- **双语／生成文档尚未与同级 `web-search-*` 包对齐**（`README.zh.md`、`README.i18n.yaml` 以及生成的配置目录条目）——在将本包视为文档完整之前，请通过仓库的 `gen-config-catalog`／doc-sync 脚本重新生成。
