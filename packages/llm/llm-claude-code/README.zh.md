---
description: "基于 Claude Code 的 ctx.llm LLM 适配器：部署如何通过用户自己的无头 Claude Code 登录处理每次模型调用，而不是使用 Anthropic API 密钥。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-claude-code

[English](README.md) | 中文

## 摘要

使用 `dsh-llm-claude-code` 时，harness 通过以无头模式运行用户自己的 Claude Code 来处理每次模型调用，因此直接使用机器上已有的 Claude 订阅登录，DSH 不持有任何 Anthropic 密钥。当 Claude Code 已安装并登录、且希望以 Claude 作为会话模型时选择它。每次 `stream()` 调用对应一个无状态的 `claude -p` 进程，其输出被解码为 harness 的流，其中包括由 DSH 自身循环执行的原生工具调用。路由 id 为 `claude-code`；实际对话的是未经修改的真实 `claude` 二进制文件。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

在已加载 LLM 服务和子进程运行时的组合中挂载该适配器；它会注册 `claude-code` 提供方路由。像其他路由一样选择它：提供方为 `claude-code`，再指定模型 id 或别名。

### 何时选择

当机器上装有已登录 Claude 订阅的官方 `claude` 可执行文件，并且希望会话通过它运行在 Claude 上时，选择此后端。可执行文件无法解析时，调用会以 `PROVIDER_UNAVAILABLE` 失败；该检查在本地完成，不会启动进程。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-subprocess-local'
- name: '@deepseek-ai/dsh-llm-claude-code'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `executable` | `PATH` 中的 `claude`，否则 `~/.local/bin/claude` | 用户 `claude` 可执行文件的绝对路径或 `PATH` 名称；Windows 上需要原生 `.exe`，因为不使用 shell 垫片 |
| `nodeExecutable` | harness 自身的 Node | 运行工具 schema MCP 桩的 Node 可执行文件 |
| `timeoutMs` | `1800000` | 单次调用的整体期限 |
| `defaultContextWindow` | `200000` | 目录中未列出的模型 id 所假定的上下文窗口 |
| `credential` | （未设置） | 凭据记录键（例如 `llm-pi-ai/anthropic`），其保存的访问令牌或 API 密钥用于认证 `claude` 子进程；未设置时 Claude Code 使用它自己的登录 |
| `models` | （无） | 追加到内置目录或覆盖其条目的 `{ id, name, contextWindow?, description? }` |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-claude-code)是所有可接受字段及其 JSDoc 的完整来源。

### 模型与请求控制

`listModels` 返回当前的 Claude 模型（`claude-sonnet-5-5`、`claude-opus-5-5`、`claude-haiku-5-5`）以及别名 `sonnet`、`opus`、`haiku`。该目录仅供参考：任何模型 id 都会被接受并原样传给 `--model`，未列出的 id 使用 `defaultContextWindow`。每个模型都只声明文本输入（运行时会为这类路由把图片和文件转成文本），并提供 `low`、`medium`、`high`、`xhigh`、`max` 这几档强度，通过 `--effort` 传入；不声明默认强度，因此沿用配置档案自己的强度。`maxTokens` 会变成本次运行的环境变量 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`。`temperature` 和 `stop` 在 `claude -p` 中没有对应项，会被忽略。

### 一次调用做了什么

每次调用都会创建一个全新的临时目录（即进程工作目录，结束后删除），其中保存 `system.txt`；带工具的请求还会保存 `tools.json` 和 `mcp.json`。它运行 `claude -p --output-format stream-json --verbose --include-partial-messages --no-session-persistence --setting-sources "" --strict-mcp-config --tools "" --permission-mode dontAsk --system-prompt-file <dir>/system.txt --model <model>`，选择了强度时追加 `--effort <effort>`，带工具的请求再追加 `--mcp-config <dir>/mcp.json --allowedTools mcp__dsh`。提示词通过 stdin 传入，因此没有命令行长度限制。`--setting-sources ""` 让用户的全局 `CLAUDE.md` 不进入运行，`--tools ""` 移除所有内置工具。

对话由 DSH 持有，所以运行是无状态的：历史被写成 `<conversation>` 转录（`<user>`、含 `<tool_call>` 元素的 `<assistant>`、`<tool_result>`、`<developer>`），DSH 系统提示词前面加一段说明该约定的简短文字，作为 `system.txt`。消息文本会被转义，内容无法伪造转录元素；更早轮次的推理内容会被省略。

工具通过用 `node -e` 启动的 stdio MCP 桩提供给 Claude，该桩的 `tools/call` 永远不应答，因此 Claude 只能发出调用而无法执行。Claude 看到的每个工具名为 `mcp__dsh__<name>`；不符合 Claude 64 字符规则的名称会得到确定性的安全别名，并在返回时映射回来。一旦某条消息以 `tool_use` 结束，适配器立即发出 usage 和 `tool-calls` 结束事件并终止进程，不再等待 Claude 的下一轮。

### 使用已保存的 DSH 凭据认证

将 `credential` 设为凭据记录键（例如 `llm-pi-ai/anthropic`），即可让 Claude Code 使用 DSH 已保存的 Anthropic 凭据运行。每次启动子进程前，适配器通过可选的凭据服务读取该记录。剩余有效期超过 60 秒的 pi-ai OAuth 授权，只会把**访问令牌**以 `CLAUDE_CODE_OAUTH_TOKEN` 交给子进程；`api-key` 记录则以 `ANTHROPIC_API_KEY` 交出其密钥。刷新令牌从不共享，因为 Claude Code 刷新会轮换它，并使 DSH 保存的副本失效。

此路由从不刷新授权。授权已过期、格式错误或缺失，未挂载凭据服务，或读取失败时，调用不会失败：子进程不带额外环境启动，使用 Claude Code 自己的登录，并且每种不同原因只记录一条警告（绝不含密钥）。`llm-pi-ai` 路由关闭期间没有任何一方刷新令牌，因此授权约 6 小时后会过期，此路由随即回退到 Claude Code 自己的登录。

### 失败与恢复

失败以 `LlmError` 抛出，运行时会将其规范化为终止性的错误结束事件：`AUTH`（未登录）、`QUOTA`（用量上限）、`RATE_LIMIT`、`SERVER`（过载或 5xx）、`CONTEXT_WINDOW_EXCEEDED`（提示词过长）、`EMPTY_RESPONSE`、`timeoutMs` 到期时的 `TIMEOUT`、调用方中止时的 `ABORTED`、可执行文件缺失或启动失败时的 `PROVIDER_UNAVAILABLE`，以及其余情况（结果失败、非零退出并引用 stderr 尾部、没有结果行）的 `PROVIDER_ERROR`。消息中从不包含提示词。超时或中止会通过子进程接缝终止子进程，并在删除目录前等待其整个进程范围结束。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 设计理念

- **使用用户自己的客户端。** 适配器像交互式 `claude -p` 一样启动未经修改的 `claude` 二进制文件，订阅只通过 Anthropic 自己的客户端使用，不读取也不转发任何凭据。
- **Claude 提议，DSH 执行。** Claude 自带工具已关闭，其 MCP 工具永不应答，因此一次运行唯一能做的就是发出工具调用；权限、执行和历史仍由 DSH 的循环负责。
- **无状态运行。** 恢复 Claude 会话会让历史分属两个所有者，所以每次调用都重新发送完整转录。
- **共享进程所有者。** 启动、终止和进程范围清理都通过 `ctx.subprocess`，从不使用 `node:child_process`。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、默认值、路由注册 |
| [`src/adapter.ts`](src/adapter.ts) | `ClaudeCodeLlmAdapter`：argv、临时文件、运行生命周期、失败映射、模型元数据 |
| [`src/decoder.ts`](src/decoder.ts) | stream-json 解码器：块重编号、usage、停止原因、结果行 |
| [`src/transcript.ts`](src/transcript.ts) | 经过转义的对话转录和 `system.txt` 文本 |
| [`src/names.ts`](src/names.ts) | `mcp__dsh__` 前缀和安全的工具名别名 |
| [`src/stub.ts`](src/stub.ts) | 永不应答的 MCP 桩的内联源码 |
| [`src/models.ts`](src/models.ts) | 内置模型目录和强度 |
| [`src/credential.ts`](src/credential.ts) | 已保存凭据记录到子进程环境的映射 |
| [`src/executable.ts`](src/executable.ts) | 同步的可执行文件查找 |

### 运行流程

`stream()` 先拒绝已中止的信号，定位可执行文件，创建临时目录，并设置与调用方信号融合的 `dsh-timeout` 期限。它写入文件，带着融合后的信号启动子进程（中止时由接缝终止它），并随到随解码 stdout 行：始终为空的思考块会消失（其 token 仍计入 `reasoningTokens`），块索引按首次发出的顺序重新编号，usage 则是把 Claude 的累计计数映射为互不重叠的输入、缓存读取、缓存写入和输出计数。`tool_use` 消息会立即结束调用；其他消息则等待 `result` 行，由它决定成功或失败代码。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-llm](../llm/README.zh.md) — 该适配器注册到的 LLM 服务及其发出的流式词汇。
- [dsh-web-search-claude-code](../../web/web-search-claude-code/README.zh.md) — 通过同一个无头 Claude Code 提供网页搜索的同级包。
- [dsh-subagent-claude-code](../../subagent/subagent-claude-code/README.zh.md) — 把任务委派给同一个无头 Claude Code 的同级包。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-claude-code) — 所有可接受的配置字段及其源码声明。

-----

<a id="model-experience"></a>
## 模型体验

### 通过 Claude Code 的提供方请求

#### 模型看到什么

Claude 收到的系统提示词由一段说明转录约定的简短文字加上 DSH 系统提示词（开头的 system 消息，否则是一次性的 `GenerateOptions.system`）组成；stdin 中是作为单个 `<conversation>` 转录的对话，包含 `<user>`、`<assistant>`（可见文本加带原始 JSON 参数的 `<tool_call id name>` 元素）、`<tool_result id name [error]>` 和 `<developer>` 轮次，并以 `Continue as the assistant.` 结尾。消息文本会被转义，内容无法伪造这些元素。更早轮次的推理、后续的 system 消息以及工具变更块都不会被渲染；图片和文件以文本占位符形式到达。请求的完整工具列表作为原生 `mcp__dsh__<name>` 工具暴露，Claude 工具名规则不接受的名称会得到确定性别名；Claude 自带工具、设置以及用户的全局 `CLAUDE.md` 对本次运行都不可用。

#### Token 影响

每次调用都会在用户订阅上把完整转录作为输入重新发送，由 Claude 自己的分词器计数，另加转录说明、标签和工具定义的少量固定开销。usage 以互不重叠的输入、缓存读取、缓存写入和输出计数返回，思考 token 单独作为 `reasoningTokens` 报告。

#### KV 缓存影响

每次调用都会重建转录，只有在较早消息未变时其前缀才保持字节稳定：追加轮次可复用 Claude Code 的提示缓存，而压缩或分叉会改写前缀，缓存从变化处重新开始。

### 提供方响应

#### 模型看到什么

Claude 的文本、非空思考和 `tool_use` 块按首次发出的顺序变成 harness 的文本、推理和工具调用块；始终为空的思考块会被丢弃。工具调用携带 Claude 的 id、DSH 工具名（别名已映射回来）和 Claude 的原始 JSON 参数。运行在第一条以 `tool_use` 结束的消息处停止，因此只记录该消息的内容，工具由 DSH 的循环执行。

#### Token 影响

生成的内容只有在循环记录之后才会影响后续输入，随后会被重新渲染进下一份转录；推理内容不会出现在后续转录中，因此不增加后续输入。

#### KV 缓存影响

记录下来的响应内容追加到下一份转录，不改变其较早的前缀；省略推理的渲染在每次调用中都一致，因此不会使可复用前缀失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明了适配器何时不适合使用，它们是当前包的约束。

- **仅文本输入** — 该路由不声明图片输入；图片和文件以文本形式到达。
- **没有 `temperature` 或 `stop`** — `claude -p` 两者都不提供，因此这些请求字段被忽略；`maxTokens` 仅通过 `CLAUDE_CODE_MAX_OUTPUT_TOKENS` 生效。
- **依赖用户的 `claude` 可执行文件和登录** — 登录缺失或过期时，调用以 `AUTH` 失败。子进程接缝会清除形似凭据的环境变量，因此只使用 Claude Code 保存在磁盘上的登录，或由 `credential` 选定的已保存凭据。
- **受订阅速率限制** — 每次调用都是一条 Claude 消息，所以配额和速率限制失败会表现为 `QUOTA` 或 `RATE_LIMIT`。
- **进程启动开销** — 每次调用都会启动一个 `claude` 进程（有工具时还有一个 Node MCP 桩），所以每次调用在首个 token 之前都有固定的启动延迟。
- **stream-json 格式不是带版本的契约** — Claude Code 的某个版本若改变它，调用可能以 `PROVIDER_ERROR` 失败或返回空内容。
