# Agent Note: 检查 LLM 请求载荷

Status: implemented

[English](2026-10-28-inspect-llm-request-payload.md) | 中文

## 问题

Trajectory 的一行只显示模型的回答，不显示 DSH 发出了什么：系统提示、工具 schema，以及 Claude Code 适配器渲染进 `claude -p` stdin 的对话记录。每次调用的 token 用量是可见的，但没有任何地方说明这些 token 花在了哪里，缓存未命中和提示膨胀只能靠猜。

## 决定

在 Trajectory 账本中右键点击助手行，会打开一个带“Inspect request”的小菜单，随后在账本旁停靠一个面板，按类别（对话记录约定、系统提示、工具、对话记录）和条目展示该次调用的确切载荷，附带字节数，以及按提供方报告的用量折算的 token 估算。

- **捕获。** `GenerateOptions.onRequest` 是可选钩子；只有 Claude Code 适配器会调用它，传入即将启动进程所用的 argv、环境变量名（绝不含值）、系统文本、工具定义和 stdin。上报的 stdin 省略图片字节。钩子失败从不使调用失败。
- **存储。** 每次调用之后，Agent 循环把载荷写成 gzip 旁路文件 `<session directory>/payloads/<turn or header seq>-<step>-<attempt>.json.gz`（先写临时文件再重命名，名称已存在时加 `-rN` 后缀），并追加一个指明该 blob 的 `request/payload` 事件。JSON 上限 5 MB：依次把 `stdin`、`system`、`tools`，再到 `argv` 和 `envKeys` 替换为占位符，同时保留它们的原始字节长度（`stdinBytes`、`systemBytes`、`toolsBytes`、`argvBytes`、`envKeysBytes`）和 `truncated: true`。写入尽力而为并记录日志。目录由 `SessionPersistence.sessionDirectory` 提供；没有该目录的后端不记录任何内容。
- **读取。** Session 控制器暴露 `requestPayload({ sessionId, blob })`，对客户端表现为 `Session.readRequestPayload`。它只接受匹配 `^\w[\w.-]*\.json\.gz$`、长度不超过 255 个字符且不是 Windows 设备名的名称；目录取自已存储的 Session 头而不是请求；已存储文件和解压输出都以 8 MB 为界，并检查载荷形状。缺失的 Session 或 blob 读为 `undefined`；线上类型是它自己的 JSON 类型形状。
- **界面。** 请求视图从事件携带 `payloadBlob`/`payloadTruncated`；`TrajectoryTable` 接受可选的 `onInspectRequest`，只在带该属性的助手行上显示共享的 `Menu`；`TrajectoryView` 按需加载 blob，忽略过期结果，并显示加载中、“未捕获”或就绪的面板。`composeRequest` 是纯函数；超过 64,000 个字符的条目只预览，并带“Show all”控件。文案位于全部八个语言的 `inspect.*` 键中。

## 考虑过的替代方案

- **从提示快照重建载荷。** 已否决：那会是被标成精确的近似值，而目的恰恰是看到发出的精确内容。这次改动之前记录的 Session 只显示“未捕获”。
- **把载荷内联存入 Session 日志。** 已否决：单次调用的载荷可达数 MB 且重复整个对话记录，会让每次重放都要读取的日志膨胀；旁路文件只按需读取。
- **为每个提供方上报载荷。** 暂时否决：只有 Claude Code 适配器构造进程载荷，其确切字节与 DSH 已持有的消息不同；其他适配器以后可以采用该钩子。
- **手写的右键菜单。** 评审中已否决，改用共享的 `Menu`，它已经处理了定位、关闭和焦点。

## 后果

- 每次调用的确切请求都可检查，被截断的载荷仍会报告原始大小，代价是上限会隐藏超大条目的正文。
- 每次调用写出最多 5 MB 压缩后的 blob，并在下一步之前等待该写入；blob 随对话记录增长，且没有每个 Session 的磁盘预算。它们存放在 Session 旁边，随 Session 一起走。
- blob 含完整对话，包括工具结果；暴露面与 Session 日志相同，Remote 方法除了知道 Session id 之外没有逐调用方检查，与相邻方法一致。
- 检查时仍在运行的请求显示“未捕获”，因为事件在流结束后才追加；读取失败也显示同样的消息。
- `request/payload` 是第一方事件，所以旧版本无法打开包含它的 Session。
- 分叉的 Session 不复制 blob，所以在分叉中检查父 Session 的调用会显示“未捕获”。

## 测试

写入侧覆盖往返、上限顺序、原始字节大小、名称拒绝，以及重复名称不覆盖。读取侧覆盖不安全名称和设备名、跨 Session 隔离、形状拒绝、损坏的 blob 和解压上限。循环侧覆盖事件、失败的接收端和缺失的载荷。客户端覆盖组合、面板（预览上限、记忆化的用量、截断提示）、仅在助手行上的行菜单，以及视图的加载中、缺失和就绪状态。

## 相关记录

[`llm-claude-code`](../../../../packages/llm/llm-claude-code) 承载上报载荷的适配器；请求视图来自 Trajectory 的助手定义。
