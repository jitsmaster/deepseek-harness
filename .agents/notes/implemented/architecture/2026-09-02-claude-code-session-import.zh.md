# Agent Note: Claude Code 会话导入与由 skill 派生的斜杠命令

Status: implemented

[English](2026-09-02-claude-code-session-import.md) | 中文

## Problem

DSH 现在通过 `llm-pi-ai` 拥有一条可用的 Claude（Anthropic）路由（浏览器 OAuth 登录；见[浏览器授权与免密钥 web 搜索](../../proposed/architecture/2026-09-01-browser-authorization-and-keyless-web-search.zh.md)）。同时在同一台机器上使用 Claude Code CLI 会话的用户，希望把一段 Claude Code 对话带入 DSH 并继续，无需重新交代上下文；并希望在 Claude 支持的 DSH 会话中，同样可以把他们在 Claude Code 中使用的 Claude Code Skills 当作 DSH 斜杠命令使用。

本 note 之前曾考虑并否决了两个相邻的需求：

- **实时附着到正在运行的 `claude --bg` 会话。**原则上可行（用 `claude agents --json` 做发现／状态），但读取实时会话的轮次或注入新输入的唯一途径，是 transcript JSONL（Anthropic 自己的文档：内部格式，版本之间会变化）以及一个未公开文档的跨会话消息 socket。让 DSH 在附着会话的整个生命周期内持续耦合这两者，是对 DSH 无法控制的接口面的长期维护负担。
- **逐字节结构化回放到 DSH 的会话日志。**把 Claude Code 自己的 tool-call 内容块映射到 DSH 的 `SessionEventMap`，需要一个庞大且对版本脆弱的翻译层，还可能为一种 DSH 并不拥有的外来事件形状而提升 `SESSION_FORMAT_VERSION`。

## Decision

交付两项相互独立、仅在服务端的能力。完成其一次性工作后，两者都不保持与 Claude Code 的实时连接。

### 1. `claude-session-import`（`packages/session/claude-session-import`，`@deepseek-ai/dsh-claude-session-import`）

这是一次性导入，而不是实时桥接：

- **发现**：`listClaudeCodeSessions()` 通过 `ctx.subprocess.spawn` 调用 `claude agents --json --all`（stdout 上限 4 MiB，stderr 上限 64 KiB，5 秒关闭宽限期），并把每个原始条目映射为 `DiscoveredSession {id, name, cwd, status, startedAt}`，供 DSH 会话创建界面中新的“Import from Claude Code”入口使用。`kind: 'background'` 条目的 `state`（例如 `done`／`stopped`／`failed`／`blocked`）在两者同时存在时优先于 `status`；`kind: 'interactive'` 条目只带 `status`（例如 `idle`／`busy`）。id 不是 UUID、`cwd` 为空或非绝对路径、或 `startedAt` 无法解析的条目，会被丢弃并记录警告，而不是被下游信任（纵深防御：`cwd` 为新会话的工作目录范围提供种子，id 会进入 transcript 文件名）。`claude` 二进制缺失／无法启动、退出码非零或 stdout 无法解析，都会使发现降级为空列表，并各自记录日志。
- **导入**：`ClaudeSessionImportController.createFrom(sessionId, signal)` 把所选会话的 `cwd` 映射到其 Claude Code 项目目录，并**只读取一次** `~/.claude/projects/<project>/<id>.jsonl`，上限为 `RAW_TRANSCRIPT_MAX_BYTES`（800,000 字节，通过越过 `stat()` 的流式读取来强制执行，以堵住 CLI 仍在向文件追加内容的 TOCTOU 缺口）。`parseClaudeCodeTranscript`／`renderImportedTranscript` 提取用户／助手的文本轮次，并把可识别的 `tool_use`／`tool_result` 块渲染为可读的文本摘要（例如“ran `ls -la`, output: …”），渲染字符数上限为 200,000；无法识别的块会降级为文本摘要，而不是使导入失败。
- **会话创建**：新的 DSH 会话以重建出的轮次作为开场上下文，并固定使用 `IMPORTED_SESSION_MODEL`（`provider: 'anthropic', model: 'claude-sonnet-5'`）。从这一刻起，该会话完全是 DSH 原生的——此后发生的一切由它自己的 agent loop 与工具负责。不再与 Claude Code、`claude` 二进制或源 JSONL 发生任何联系。
- **RPC 接口面**：`ClaudeSessionImportController`（`ctx.claudeSessionImportController`，以 `ctx.remote.claudeSessionImport` 对外暴露）提供 `list(signal)` → `ClaudeSessionImportListValue` 与 `createFrom(sessionId, signal)` → `ClaudeSessionImportCreateValue`，沿用 OAuth 功能中的 `AuthorizationController` 模式（`@Remote`／`TypertRemoteService` RPC 方法加协议类型，不使用定制传输）。两个稳定的 `RemoteErrorDetailsMap` 错误码覆盖失败路径：`claude-session-import/not-found` 与 `claude-session-import/transcript-unreadable`。5 分钟的发现缓存让 `createFrom()` 可以复用同一个选择器操作先前 `list()` 的快照，TTL 过后则回退到一次新的发现。
- **选择器界面中的 Running／Done 分组**：`groupAndSortSessions()`（`packages/client/ui-session-import`）把已发现的会话拆成两个分区，而不是一个扁平列表——`running` 组与 `done` 组，各自在 `ImportDialog` 中有一个支持 ARIA 的分区标题行——每个分区内按 `startedAt` 降序排序（最新的在前）。分类依据是一份固定的、不区分大小写的终态白名单——`done`、`cancelled`、`completed`、`failed`、`error`、`stopped`——不在该集合中的（包括本代码库尚未见过的状态）默认归入 `running`。这份白名单仍是一个刻意的、尚未经 CLI 验证的设计选择：`claude agents --json --all` 的状态词汇仍未公开文档，本代码库自己的 fixture 中只有 `'done'`／`'working'` 作为已确认的真实值出现，因此分类器有意对“running”保持宽松，而不是冒会话被静默归入错误分组的风险。

### 2. `claude-skill-commands`（`packages/interaction/claude-skill-commands`，`@deepseek-ai/dsh-claude-skill-commands`）

- 在 `agent/created` 时**按 agent** 挂载（agent 作用域，与 `dsh-plan-mode` 的形态相同），读取该 agent 会话的 `cwd`。
- 通过 `scanSkillDirectories` 扫描 `<cwd>/.claude/skills/` 与 `~/.claude/skills/` 中的 `SKILL.md` 文件，并解析每个文件的 frontmatter（`name`、`description`）。项目层 skill 遮蔽同名的用户层 skill；skill 不能注册到已存在的命令名之上，包括本插件自己保留的 `/refresh-skills`——此时会跳过并记录警告。
- 通过现有的 `dsh-commands` 注册表，为每个 skill 调用一次 `ctx.commands.register()`——不引入新的命令基础设施。调用 `/skill-name [args]` 会把 skill 正文以 `kind: 'plugin'` 消息 steer 进去（绝不使用 `kind: 'user'`，因此仓库编写的 skill 内容不会在下游被误认为宿主证明过的人类输入）；如果操作者输入了参数，则把这些参数另外以 `kind: 'user'` 消息 steer 进去——与 `/plan [message]` 对自己的正文／参数拆分所用的两条消息机制相同。项目层 skill 的正文在首次未经确认就 steer 之前，会展示一次供确认，按 tier+name+sha256(body) 作为身份键；用户层 skill 立即 steer。
- **仅限 Claude 支持的会话**：`agent/pre-step` 监听器在每一步通过 `currentProviderOf()` 重新推导该 agent 的*当前*模型提供商，并在提供商进入或离开 `anthropic` 时，注册／dispose 整套命令（外加 `/refresh-skills`，它在门打开时无论 skill 数量如何都会注册，因此即使初次扫描一个都没找到也仍可使用）。命令处理器在调用时会再次检查提供商，以堵住提供商切换与下一次门检查之间那一步的滞后。会话中途把模型切换离开 `anthropic` 会再次移除这些命令——它们是被重新评估的，而不是在挂载时一次性决定的。Claude Code Skills 是按 Claude 自身的约定编写的，不会悄然适用于由 DeepSeek 支持的 agent。

### Error handling

- `claude` 二进制缺失／不在 PATH 中：发现返回空列表，并给出清晰的“Claude Code CLI not found”消息，而不是崩溃。
- transcript JSONL 缺失、无法读取或其形状已漂移：导入以明确的特定错误大声失败，绝不静默地部分导入或导入出乱码。
- 格式错误或缺少 frontmatter 的 `SKILL.md`：跳过并记录警告；扫描的其余部分仍会完成——这是对 DSH 并不拥有的文件所做的外来、尽力而为的发现，而不是 DSH 自己的配置。

## Testing

- `packages/session/claude-session-import/tests/transcript.spec.ts` 基于 fixture JSONL 覆盖 transcript 解析器／渲染器：纯文本轮次、`tool_use`／`tool_result` 块，以及格式错误／无法识别的块形状。
- `packages/session/claude-session-import/tests/discovery.spec.ts` 基于桩子进程覆盖 `claude agents --json --all` 包装行为：二进制缺失、JSON 格式错误、空列表、格式正确的列表，以及条目校验拒绝（非 UUID id、非绝对 cwd、无效 `startedAt`）。
- `packages/session/claude-session-import/tests/claude-cli-resolve.spec.ts` 与 `tests/transcript-path.spec.ts` 覆盖 CLI argv 解析与 transcript 路径推导。
- `packages/session/claude-session-import/tests/controller.host.spec.ts` 覆盖 `ClaudeSessionImportController` 的 RPC 接口面，对照 `authorization-controller.host.spec.ts`。
- `packages/interaction/claude-skill-commands/tests/skill-scanner.spec.ts` 覆盖有效 skill、格式错误的 frontmatter、项目层与用户层的优先级，以及缺失目录。
- `packages/interaction/claude-skill-commands/tests/model-gate.spec.ts` 与 `tests/plugin.spec.ts` 覆盖：选择了 `anthropic` 的 agent 拥有 skill 命令、否则没有，在模型切换时与调用时重新评估，以及 `/refresh-skills` 在门打开时的注册。
- `packages/client/ui-session-import/tests/session-grouping.spec.ts` 覆盖 running／done 拆分与排序顺序；`tests/import-dialog.client.spec.tsx` 与 `tests/import-flow.client.spec.tsx` 覆盖选择器的列表渲染、选择后触发 RPC 调用，以及错误状态。

## Alternatives considered

- **实时附着桥接（JSONL tail + 跨会话消息 socket）。**已否决：它在每个附着会话的整个生命周期内，让 DSH 持续耦合 Anthropic 自己的文档所称的两个内部／未公开文档的接口面，而不是只在导入时耦合一次。
- **逐字节结构化导入到 DSH 自己的会话日志事件类型。**已否决：Claude Code 的 tool-call 内容块与 `SessionEventMap` 之间没有清晰的映射；需要庞大且对版本脆弱的翻译层，还可能为一种外来事件形状提升格式版本。
- **仅纯文本导入，完全丢弃 tool call／result 内容。**已否决，转而把可识别的工具块渲染为可读的文本摘要：几乎同样简单且健壮，却能保留导入之前 Claude Code 实际做过的更多内容，而不是直接丢掉。
- **无头中继（每条消息执行 `claude -p --resume <id> --output-format json`）以取代一次性导入。**已否决：这确实是文档齐全且稳定的接口，但它不是“在 DSH 中继续”——它让此后的每个轮次都依赖 Claude Code CLI，并且可能与同一会话在别处运行或被附着相冲突。
- **不设门控的 skill 命令（无论会话使用什么模型都可用）。**已否决：Claude Code Skills 是按 Claude 自身的约定编写的；无条件地呈现它们，有让由 DeepSeek 支持的 agent 收到按另一个模型行为编写的指令的风险。
- **随着 `claude agents --json --all` 产出结果而增量地流式呈现 Running／Done 选择器，而不是在完整列表解析完成后一次性分组／排序。**已否决：该 CLI 命令没有可供流式处理的增量数据源——它只在进程退出时把完整结果作为一个原子 JSON 数组打印出来——因此没有地方可以挂接 SSE 风格的渐进渲染；发现调用本就一次性解析出完整列表，在客户端对该列表分组／排序严格来说更简单。

## Consequences

- 用户可以在 DSH 的会话创建界面中打开“Import from Claude Code”，看到按 running／done 分组的 `claude agents --json --all` 会话列表，选择一个，并进入一个新的 DSH 会话，其开场上下文反映该 Claude Code 对话此前的轮次（包括它运行过的任何工具调用的可读摘要）。从这一刻起，导入的会话完全运行在 DSH 自己的 agent loop 与工具之上；创建之后它所做的一切都不会触及 Claude Code、`claude` 二进制或源 transcript 文件。
- 当会话当前的模型提供商是 `anthropic` 时，输入 `/` 会把该会话的 Claude Code Skills（来自其 `cwd` 和用户主目录的 skills 目录）作为命令呈现；切换到非 Claude 模型后，它们会在一个 `agent/pre-step` tick 之内被移除，命令处理器自己的再次检查则堵住调用时剩余的滞后。
- `claude` 缺失、transcript 损坏／过大，或 skill 文件格式错误，各自都会以可预期的方式失败（空列表／大声的导入错误／带警告地跳过 skill），且不会破坏 DSH 的其他任何部分。
- Claude Code 的 JSONL transcript 格式被明确记载为内部格式，版本之间可能变化；解析器在其漂移时需要维护。这一点受范围限制：transcript 只在导入时读取一次，而不是实时 tail，因此格式变化表现为一个大声而受限的导入失败，而不会破坏进行中的会话。
- `claude agents --json --all` 自身的输出形状是 DSH 无法控制的 CLI 接口面依赖；那里的破坏性变更会使发现降级为空列表而非崩溃（见上文的错误处理一节），但在调整之前该功能不可用。
- 把 `tool_use`／`tool_result` 块渲染为文本摘要，是一种有损、尽力而为且没有固定规范的翻译；对于实践中尚未见过的工具形状，摘要可能读起来很别扭。之所以接受，是因为按上文的替代方案，另外的做法（丢弃它们，或试图做到完整结构保真）都严格更差。
- `session-grouping.ts` 中的终态白名单仍未针对 CLI 真实的状态词汇做验证，只有 `'done'`／`'working'` 例外——本代码库尚未见过的状态继续默认归入 `running`，而不是冒会话被静默归入错误分组的风险，代价是实际上已完成的会话有时会一直归在 running 下，直到其状态与白名单匹配。
- skill 命令的门控在每个 `agent/pre-step` tick 以及调用时都会读取 agent 的*当前*模型选择，而不是在挂载时缓存——代价是每一步和每次调用多一次检查，换来的是堵住这样的缺口：若采用挂载时一次性决定的实现，Claude 编写的指令就可能泄漏到之后的非 Claude 轮次中。
