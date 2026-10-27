---
description: "模型设置页底部的 Claude Code 账号卡片：按套餐用量选择 DSH 以哪个 Claude 账号运行 Claude Code，登录账号，并把其中一个设为本机所有 Claude Code 的默认账号。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-claude-accounts

[English](README.md) | 中文

## 概述

打开**设置**，进入**模型**，滚动到 **Claude Code 账号**，即可选择 DSH 以哪个 Claude 账号运行 Claude Code。列出你要来回切换的每个邮箱，各登录一次，再选套餐余量最多的那个；每一行都显示会话与每周用量，选择有据可依。只有 Host 提供 `llm-claude-code` 插件时才会出现这张卡片。

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

先添加邮箱：在**添加邮箱**中输入并点击**添加**；卡片会检查它是否像一个邮箱地址、是否已在列表中。每个邮箱占一行。**登录**（已有登录的账号则是**重新登录**）会打开插件的登录对话框：它询问要登录哪个邮箱，打开 Claude 登录页，并接收页面显示的代码。**移除**把邮箱从列表中拿掉；它已保存的登录仍留在磁盘上。

单选组决定 DSH 自己调用 Claude Code 时使用的账号：点一下邮箱就把它写为 `activeAccount`，下一次调用即以该账号运行。只有已登录的账号可以被选中，任何时候都不会自动切换。

每个已登录的行以进度条显示五小时会话窗口和七天每周窗口，并给出已用百分比、窗口何时重置、读数何时更新。读数只有在该账号完成过一次调用后才存在，所以新账号显示**暂无读数**；读数之后窗口已重置的也会说明。用量最低的账号标记为**用量最少**：账号按两个窗口中较大者排序，再按每周窗口排序，且仅当至少有两个已登录账号带有可比较的读数时才显示该标记。其他标记有 **DSH 使用中**、**Claude Code 默认**和**未登录**。

**设为所有 Claude Code 的默认账号**会把该账号的登录换入默认的 Claude Code 配置，之后新启动的每个 Claude Code 进程（终端、编辑器、其他工具）都以它登录。确认框会先说明：已在运行的 Claude Code 会话可能仍使用旧账号，或在刷新登录时把它写回，因此应重启它们；并说明当前的登录文件会先备份。卡片打开期间每 15 秒重新读取一次状态，每次操作后也会重读。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

Host 一侧是一个空的 `apply`，只是让本包在 Loader 中有一行，客户端模块系统据此提供浏览器一侧。浏览器一侧向模型设置页的 `settings.models.footer` 插槽注册一个条目。`ClaudeAccountsController` 汇合两个 Host 答复：设置条目 `llm-claude-code`（用 `settings.describe` 读取，用 `settings.mutate` 按所读修订写入，路径为 `accounts` 与 `activeAccount`）以及 `claudeAccounts.status()` 的读数。卡片挂载期间它每 15 秒轮询一次状态，把重叠的读取合并为一次后续读取，并在 `settings/document-updated`、`authorization/settled` 和连接重置时重读设置。登录使用现有的授权 Remote，键为 `llm-claude-code/claude-account`；`SignInDialog` 是本包自带的模型设置页对话框副本，因为客户端包不能导入另一个插件的界面。`accounts-model.ts` 保存纯规则（邮箱检查从插件复述而来，因此不导入 Host 代码；用量最少的排序；百分比与时长格式化），而设置条目被提供之前卡片不渲染任何内容。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-settings-models](../ui-settings-models/README.zh.md) — 模型设置页及卡片注册其中的底部插槽。
- [llm-claude-code](../../llm/llm-claude-code/README.zh.md) — 拥有账号、用量读数和默认登录切换的插件。
- [api-settings-controller](../../api/settings-controller/README.zh.md) — 卡片用来读取和切换的 `claudeAccounts` Remote 命名空间。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包是浏览器侧设置界面，不注册任何模型相关内容。

#### KV 缓存影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **卡片沿用配置文件的条目 ID** — 它在条目 ID `llm-claude-code` 下读取设置；以其他 ID 挂载该插件的配置文件不会显示卡片。
- **用量只和上一次调用一样新** — 读数在账号完成一次 DSH 调用时写入，所以只在终端里使用的账号显示的是旧读数或没有读数。
- **正在运行的 Claude Code 会话不会被切换** — 设为默认只影响新启动的进程。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作背景 — 点击展开</summary>

无。

</details>
