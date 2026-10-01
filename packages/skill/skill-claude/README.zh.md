---
description: "Claude skill 提供方，面向把 skill 放在 Claude Code 目录里并希望 DSH 直接运行它们的用户，以及维护 Claude skill、命令文件与插件 skill 发现逻辑的维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-claude

[English](README.md) | 中文

## 概述

你已为 Claude Code 准备好的 skill（技能）可以直接在 DSH 会话中运行：该提供方把项目 `.claude` 目录、`~/.claude` 以及已启用的 Claude Code 插件中的 `SKILL.md` bundle 和命令文件注册为普通的 DSH skill。它会监视这些目录，因此编辑后无需重启即可到达 agent（智能体）。skill 在当前会话内通过 `skill` 工具或 `/name` 手势运行，不会启动任何 Claude 进程。skill 存放在 Claude Code 目录时选择它；`dsh-skill-filesystem` 负责 DSH 自己的 `.dsh/skills` 和 `.agents/skills`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

挂载插件即可让 Claude Code 的 skill、命令文件和插件 skill 对 agent 可用。它扫描下方的 Claude 根目录，把每个文件的 frontmatter 解析为目录条目，并按需加载正文。

### 何时选择

当 skill、`commands/*.md` 文件或插件 skill 已存在于 `.claude` 下时选择它。skill 只在 DSH 自己的根目录时，单独使用 `dsh-skill-filesystem` 即可；两个提供方也可以同时挂载。

### skill 格式

skill 是目录 `<root>/<dir>/SKILL.md`，带 YAML frontmatter：`name`（省略时取目录名）、`description`（必填），以及可选的 `when_to_use`、`disable-model-invocation` 和 `user-invocable`。命令是 `commands` 根目录下任意层级的 `*.md` 文件，名称取自路径（`commands/modes/sparc.md` 即 `modes:sparc`），描述依次取 frontmatter 的 `description`、第一个 Markdown 标题、第一行非空文本。没有描述的文件会被跳过。

YAML 拒绝但 Claude Code 接受的值（例如 `description: a: b`）由逐行解析器读取。两个调用键接受 `true` 和 `false`（YAML 布尔值或不区分大小写的文本）；其他任何值都会让该接口保持允许调用。

名称转为小写，`a-z0-9` 之外的每一段连续字符替换为 `-`，因此 `modes:sparc` 注册为 `modes-sparc`。插件的 skill 和命令以插件名为前缀：插件 `superpowers@marketplace` 的 skill `brainstorming` 注册为 `superpowers-brainstorming`。不含字母或数字的标识符会随警告被跳过。

目录与正文具有独立的生命周期：发现阶段把 frontmatter 解析进目录条目，每次加载都会重新读取当前文件，因此编辑 skill 正文无需缓存失效。

### 根目录与优先级

各根目录并行扫描；rank 只决定同名时哪个条目胜出，rank 较低者胜出：

| Rank | 来源 | 根目录 |
|---|---|---|
| 210 | `claude-project` skill | `<project>/.claude/skills` |
| 220 | `claude-project` 命令 | `<project>/.claude/commands` |
| 530 | `claude-user` skill | `<claudeHome>/skills` |
| 540 | `claude-user` 命令 | `<claudeHome>/commands` |
| 550 | `claude-plugin` skill | `<installPath>/skills` |
| 560 | `claude-plugin` 命令 | `<installPath>/commands` |

项目根目录是会话工作目录的最近一个包含 `.git` 的祖先目录；不存在时使用工作目录本身。当 `<project>/.claude` 与 `claudeHome` 是同一目录时，会跳过项目来源和项目设置，避免同一项被列出两次。

与 `dsh-skill-filesystem` 处于同一层时（rank 100 至 500，随包根目录为 600），同名项按以下顺序取第一个：DSH 项目 skill（100、200）、Claude 项目 skill 与命令（210、220）、DSH 自定义与用户 skill（300 至 500）、Claude 用户 skill 与命令（530、540）、Claude 插件 skill 与命令（550、560）、随包 skill（600）。rank 相同时由先注册的提供方胜出，注册表不会为落选条目发出警告。

插件来自 `<claudeHome>/plugins/installed_plugins.json`，仅限 `enabledPlugins` 在 `<claudeHome>/settings.json`、其后的项目 `settings.json` 与 `settings.local.json` 中启用的键，后者依次覆盖前者。只有带 `scope: "user"` 和 `installPath` 的已安装条目才会加载。

### 挂载与配置

在 skill 注册表和本地提供方之后加载该插件，使两者共用同一注册层；随产品提供的预设把它直接挂在 `skill-filesystem` 之后：

```yaml
- id: skill-claude
  name: '@deepseek-ai/dsh-skill-claude'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `claude` | 注册到 `ctx.skills` 的唯一提供方名称 |
| `claudeHome` | `$CLAUDE_CONFIG_DIR` 或 `~/.claude` | Claude 配置根目录；读取其 `skills`、`commands`、`plugins` 和 `settings.json` |
| `includeProject` | `true` | 扫描项目的 `.claude/skills` 和 `.claude/commands`，并读取其设置文件 |
| `includePlugins` | `true` | 扫描已启用的用户级插件的 skill 和命令 |
| `watch` | `true` | 监视根目录和配置文件，并在目录可能变化时使提供方失效 |

其余 `watch*` 字段用于调节 Chokidar：轮询、稳定窗口和轮询间隔。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-skill-claude)完整列出了所有字段，是这些字段的真源。

### 变更检测

已存在的根目录被递归监视，`node_modules` 除外。`<claudeHome>`、`<claudeHome>/plugins` 和 `<project>/.claude` 只监视一层，并且只关注可能改变目录的条目，使新增的根目录、插件安装或设置变更都能进入目录：`<claudeHome>` 下的 `skills`、`commands`、`plugins` 和 `settings.json`；`<claudeHome>/plugins` 下的 `installed_plugins.json`；`<project>/.claude` 下的 `skills`、`commands`、`settings.json` 和 `settings.local.json`。这些目录中 Claude Code 自己的日志与历史文件不会使目录失效。不存在的目标会在下一次列举时重试。同一事件循环轮次内到达的事件只触发一次失效。

### 可观察的成功与失败

配置正确时，会话的 skill 目录和 `/` 菜单会列出这些 Claude skill。下列每种情况都会按路径和消息各记录一条警告，其余目录仍照常加载：无法读取的文件或目录、没有描述的文件、不含字母或数字的名称、无法读取或 JSON 无效的 `settings.json` 或 `installed_plugins.json`、已启用但未安装的插件，以及没有 `scope: "user"` 条目的已安装插件。根目录不存在，或 skill 目录中没有 `SKILL.md`，则静默处理。监视器失败只会损失实时更新，扫描仍会提供目录，但结果按未完成返回、注册表不会缓存，下一次查询会重新扫描。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释发现与监视如何组织；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

Claude 的文件只作为数据读取。提供方返回携带文件路径的注册表候选项，skill 注册表、`tool-skill` 和 `/name` 手势像对待其他 skill 一样运行它们。发现与监视相互分离：`list()` 负责扫描，监视对象负责 Chokidar 句柄与失效。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口、`Config` 与提供方 |
| [`src/sources.ts`](src/sources.ts) | rank、项目根、设置、已启用插件 |
| [`src/scan.ts`](src/scan.ts) | 目录扫描、候选项构造、正文加载 |
| [`src/frontmatter.ts`](src/frontmatter.ts) | 严格与宽松的 frontmatter 解析、调用策略 |
| [`src/names.ts`](src/names.ts) | 名称规范化 |
| [`src/watch.ts`](src/watch.ts) | Chokidar 监视器与合并后的失效通知 |
| — | 不发布运行时不变式伴生入口；本包没有独立事件序列或可变数据关系，相关约定在所属 seam 强制执行。 |

### 发现流程

`list()` 查找项目根，解析根目录与已启用插件，同步监视器，并并行扫描每个根目录。skill 根目录贡献每个直接子目录的 `SKILL.md`（包括符号链接目录）；命令根目录贡献其下的每个 `.md` 文件。`get()` 重新读取文件并返回 frontmatter 之后的正文，文件已不存在时返回 `undefined`。

### 监视与失效

每个深层根目录和每个浅层配置目录各有一个监视器。监视器等待变更的文件保持 `watchStabilityThresholdMs` 不变后才上报，一批事件在每个微任务批次合并为一次 `control.invalidate()`。释放时关闭所有监视器。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从注册表约定逐步进入与本提供方共用同一层的本地提供方，以及渲染已发现 skill 的消费方。

- [skill 子系统参考](../../../docs/subsystems/skills.zh.md)——注册表约定与发现优先级表。
- [skill 包](../skill/README.zh.md)——该提供方注册到的注册表。
- [skill-filesystem 包](../skill-filesystem/README.zh.md)——DSH 自己的 skill 根目录，与本包的根目录一同排序。
- [tool-skill 包](../tool-skill/README.zh.md)——已发现 skill 如何到达会话目录与模型。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-skill` 间接影响模型；它把该提供方的可调用名称和有长度上限的描述渲染到初始目录或替换目录中，并把所选的当前指令正文与资源基底指引渲染到已保留工具历史中；路径、提供方 rank 与已禁用 skill 仍被隐藏。skill 正文原样加载，因此提到 Claude Code 工具（如 `Skill`、`Bash` 或 `Task`）的文字所指的工具 DSH 可能没有。

#### KV Cache 影响

watcher 触发的失效可促使上述消费方在现有请求历史中追加替换目录。仅涉及正文的编辑不会改变目录 digest。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明该提供方何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是任务积压。

- **插件范围**——只加载 `scope: "user"` 的插件条目；项目级和本地级安装会随警告被跳过。
- **Claude Code 工具名不会被翻译**——已加载的正文保留对 Claude Code 工具的引用，`$ARGUMENTS` 占位符也保持原样。
- **名称冲突是静默的**——规范化后相同的名称（`a:b` 与 `a-b`）按 rank 再按提供方顺序决出胜负，注册表不会报告落选者。
- **skill 的发现深度为一层**——只识别 `<root>/<dir>/SKILL.md`；忽略嵌套的 skill 树。
- **根目录存在后才会被监视**——直接在 `<claudeHome>` 下创建 `skills`、`commands` 或 `plugins`，或在 `<project>/.claude` 下创建 `skills` 或 `commands`，会到达目录；新建的 `<project>/.claude` 或插件新建的 `skills` 目录，要等其他变更使目录失效后才会被附加。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
