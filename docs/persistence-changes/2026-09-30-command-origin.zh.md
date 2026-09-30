---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-30-command-origin

[English](2026-09-30-command-origin.md) | 中文

## 概述

为仅日志的 command/run 事件新增可选的 origin 字段，并登记 Anthropic 网页搜索提供方已在追加的仅日志事件 web/anthropic-search-llm-request。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-command-origin
baseline: false
changes:
  - root: "event:command/run"
    previous: "2026-09-11-initial"
    after: "29b2478167a9119247a76f813f2166b0af969f94d1b6109be020cdb95d7c613e"
    decision: same-version
  - root: "event:web/anthropic-search-llm-request"
    previous: null
    after: "4fd4e6e96fce699a145b91ad7d54912edbd907430c260fd267ad12dec68d3303"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

两者均为同版本内的新增。command/run.data.origin 为可选字段，仅在命令来自其他代理工具（目前为 'claude-code'）时写入；已有日志不含该字段且仍然有效，原生命令从不写入它。客户端读取该字段，使首个操作即为导入命令的新会话打开对话视图，而不是停留在空白首页。web/anthropic-search-llm-request 是此前任何日志都不包含的新根；早于它的读取方会拒绝含有该事件的日志，与所有读取时必需的事件一致。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/interaction/commands packages/interaction/claude-skill-commands packages/client/ui-chat packages/client/ui-conversation：905 个测试通过，包括 run 事件携带 origin 与导入命令视为可见活动的用例；pnpm run build:lib 在两个端面均通过。

<a id="dev-note"></a>
## 开发备注

无。
