---
description: "ctx.web 的 Claude Code 搜索提供方：部署方如何把 web 搜索固定到用户自己的无头 Claude Code 登录，而不是搜索 API 密钥。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-claude-code

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-claude-code`，harness 通过以无头模式运行用户自己的 Claude Code 来回答每次 web 搜索，因此使用机器上已有的 Claude 订阅登录，无需搜索 API 密钥。当用户已安装并登录 Claude Code、并希望会话使用 Claude 的搜索时选择它。每次搜索都会启动一个仅限 WebSearch 工具的 `claude -p` 进程，结果以 `content` 携带 Claude 简短的带引用回答，并以来源携带搜索得到的链接。它只做搜索：没有页面抓取。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 web 服务与子进程运行时的组合中挂载本提供方；它以 `claude-code` 搜索提供方身份注册。当另有搜索提供方同样可用时，服务会报告 `WEB_PROVIDER_AMBIGUOUS`，因此请在 `dsh-web` 上用 `searchProvider: claude-code` 固定它。

### 何时选择

当机器上有已登录 Claude 订阅的官方 `claude` 可执行文件、并且会话应通过它搜索时选择此后端。当可执行文件无法解析时，提供方不可用——固定它的搜索会以 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` 失败。该检查在本地完成，不启动任何进程。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-subprocess-local'
- name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: claude-code
- name: '@deepseek-ai/dsh-web-search-claude-code'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `executable` | `PATH` 上的 `claude`，否则 `~/.local/bin/claude` | 用户 `claude` 可执行文件的绝对路径或 `PATH` 名称；Windows 上由于不使用 shell 垫片，需要原生 `.exe` |
| `model` | （未设置） | 作为 `--model` 传入；未设置时使用 Claude Code 默认值 |
| `timeoutMs` | `120000` | 一次搜索的整体期限 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-claude-code)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 搜索返回什么

每次搜索在一个全新的空临时目录中运行 `claude -p --output-format stream-json --verbose --no-session-persistence --tools WebSearch --allowedTools WebSearch --strict-mcp-config --permission-mode dontAsk --disallowedTools AskUserQuestion`，提示词通过 stdin 传入，运行结束后该目录被删除。运行只能使用 WebSearch，因此全局的 Claude Code 启动流程无法写文件。来源取自 WebSearch 工具结果中的 `Links: [...]` 数组，保持顺序，各带 `url` 与 `title`；最终结果文本是 `content`。请求的 `maxResults` 会截断来源并设置 `truncated`。

### 失败与恢复

失败以 `WebError` 呈现：结果行失败或缺失、运行从未搜索、WebSearch 工具报错、非零退出（引用 stderr 尾部）或启动失败为 `WEB_PROVIDER_ERROR`；`timeoutMs` 耗尽为 `WEB_SEARCH_TIMEOUT`；调用方中止为 `WEB_ABORTED`；空查询在启动任何进程之前以 `WEB_INVALID_QUERY` 拒绝。超时或中止会通过子进程 seam 终止子进程，并在删除目录之前等待其进程范围结束。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

- **使用用户自己的客户端。** 提供方像交互式 `claude -p` 一样启动未经修改的 `claude` 二进制文件，因此订阅只通过 Anthropic 自己的客户端使用，不读取也不转发任何凭据。
- **限制而非信任。** 运行只暴露 WebSearch、没有 MCP 服务器，且提示词禁止启动流程与文件访问，因此用户的全局指令没有可用的工具。对真实二进制文件的探测表明，`--tools WebSearch --allowedTools WebSearch --permission-mode dontAsk` 可无权限拒绝地完成搜索，而要求 Write 或 Bash 调用的提示词两者都得不到。
- **共享进程所有者。** 启动、终止与范围清理都经由 `ctx.subprocess`，绝不使用 `node:child_process`。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、默认值、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `ClaudeCodeSearchProvider`：参数、提示词、运行生命周期、失败映射 |
| [`src/stream.ts`](src/stream.ts) | 宽容的 stream-json 解码器：WebSearch 调用、`Links` 来源、结果行 |
| [`src/executable.ts`](src/executable.ts) | `available()` 背后的同步可执行文件查找 |

### 运行流程

`search()` 拒绝空查询，创建临时目录，设置与调用方信号融合的 `dsh-timeout` 期限，并携带该信号启动子进程，使 seam 在中止时终止它。stdout 行随到随解码；格式错误的行与链接条目被跳过。子进程退出后依次检查：取消、退出状态、结果行，最后是 WebSearch 证据。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [web 子系统](../../../docs/subsystems/web.zh.md)——搜索请求／结果词汇与错误码。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方结果的面向模型 `web_search` 工具。
- [dsh-subagent-claude-code](../../subagent/subagent-claude-code/README.zh.md)——把任务委派给同一无头 Claude Code 的同级包。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-claude-code)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-web` 间接影响模型体验。该工具保留本提供方的回答文本、经 `maxResults` 限制的链接与标题，或在消费方的错误包装层内保留其原样失败消息。每个查询会启动一个无头 Claude Code 进程，约需十秒并消耗一条 Claude 订阅消息；一次 `web_search` 调用中的各个查询（至多到其查询数上限）作为并发进程运行。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明提供方在哪些情况下不合适。它们是当前包约束。

- **只搜索，不抓取**——运行仅限 WebSearch，因此没有页面抓取提供方，结果也不含每个来源的 snippet。
- **依赖用户的 `claude` 可执行文件与登录**——没有可执行文件时提供方不可用；登录缺失或过期时运行以 `WEB_PROVIDER_ERROR` 失败。子进程 seam 会清除形似凭据的环境变量，因此只会使用 Claude Code 保存在磁盘上的登录。
- **受订阅速率限制**——每次搜索消耗一条 Claude 消息，因此配额或速率限制失败以 `WEB_PROVIDER_ERROR` 呈现，并发查询共同消耗配额。
- **`Links` 文本格式不是带版本的契约**——Claude Code 某个版本若改变它，结果将只有回答而没有来源。
