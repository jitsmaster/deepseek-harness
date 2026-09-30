---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-30-command-origin

English | [中文](2026-09-30-command-origin.zh.md)

## Summary

Adds an optional origin to the log-only command/run event, and records the log-only web/anthropic-search-llm-request event that the Anthropic web search provider already appends.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Both are same-version additions. command/run.data.origin is optional and written only for a command imported from another agent tool (currently 'claude-code'); existing logs omit it and stay valid, and a native command never writes it. The client reads it so a new session whose first action is an imported command opens the conversation instead of staying on the blank hero. web/anthropic-search-llm-request is a new root that no earlier log contains; readers that predate it refuse a log carrying it, as with every required-on-read event.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/interaction/commands packages/interaction/claude-skill-commands packages/client/ui-chat packages/client/ui-conversation: 905 tests passed, including the origin-on-run and imported-command-activity specs; pnpm run build:lib passed for both faces.

<a id="dev-note"></a>
## Dev Note

None.
