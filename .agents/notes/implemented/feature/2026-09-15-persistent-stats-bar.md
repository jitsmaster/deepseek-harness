# Agent Note: Persistent stats bar

Status: implemented

English | [中文](2026-09-15-persistent-stats-bar.zh.md)

## Problem

`StatsPills` renders turns/steps/decode-speed and token/cache-hit figures docked to the composer, but that reading disappears whenever the composer scrolls out of view or another panel occupies `'main'`. There was no frame-wide, always-on readout of the current session's whole-log stats, and no root-scoped source of session stats for one to read from: `StatsPills` reads its figures through `useProjection`, a session-scoped slot hook, which a root-scoped component cannot call.

## Decision

`packages/client/ui-chat` adds a root-scoped, always-visible `PersistentStatsBar`, fixed bottom-right via a `shell.overlay` registration (`id: 'persistent-stats'`, `order: 0`) in `packages/client/ui-chat/src/client/apply.ts`. It coexists with the pre-existing composer-scoped `StatsPills`, which is unchanged.

`packages/client/ui-chat/src/client/chat/active-session-stats.ts` bridges root scope to session data: `createActiveSessionStatsSource(sessions, sessionList)` builds a `HostObservable<ActiveSessionStatsSnapshot>` that reads the current session id's `sessionStats`/`tokenUsage` projection faces through `ISessions.binding(id).projections.faceOf(...)`, and re-subscribes its two face subscriptions whenever the current session id changes. `apply.ts` constructs one instance and publishes it via `ctx.slots.provideRoot({ hooks: { activeSessionStats } })`; `packages/client/ui-chat/src/client/contract/slots.ts` declares `useActiveSessionStats` on `GlobalStandardProps` so any root-scoped component can select from it.

`syncFaceSubscriptions()` re-checks binding resolution on every `getSnapshot()` call, not only on a session-list change event. A session can be listed before its binding resolves; without the per-read check, a `getSnapshot()` taken while the binding was still unresolvable would leave the face subscriptions stale even after the binding became resolvable, because no further session-list notify would occur to retrigger the sync. This mirrors the "re-resolve on next access" precedent already used by `ui-session`'s `resolve()`.

`PersistentStatsBar.tsx` renders `null` when there is no current session, and again when the current session's window carries neither steps nor billed tokens — the same emptiness gate `StatsPills` applies to its own row. It reuses `StatsPills.tsx`'s `billedInputTokens`, `cacheHitPercent`, and `formatDuration` helpers rather than reimplementing token/duration formatting, and lays out via `PersistentStatsBar.module.css`.

## Alternatives considered

**Replace `StatsPills` with the new bar.** Rejected; kept as a coexisting addition instead. This was an explicit product decision, not a technical default — the composer-docked row and the frame-wide bar serve different visibility needs, and nothing about the new bar's data source requires retiring the old one.

**Move `AppFrame.tsx`'s slot scope so a session-scoped hook could reach the frame.** Rejected in favor of bridging root scope to session data with `ISessions.binding(id).projections.faceOf(...)` inside `ui-chat`'s `apply.ts`. Widening `AppFrame.tsx`'s scope boundary would have been a broader, riskier structural change than adding one root-scoped source; the same `sessions.binding(id)` reach-through already exists as a precedent in `ui-workspace` (`packages/client/ui-workspace/src/client/index.ts`).

**Give the bar a popover, dialog, or window-fold fallback**, matching how `StatsPills` can expand into more detail. Rejected: root scope has no `useChat` node-window access, so there is nothing bindable to fold into. The bar deliberately shows nothing beyond its two readouts until durable-log projections populate.

## Consequences

- The current session's stats/cache-hit readout is visible frame-wide regardless of which panel occupies `'main'` or whether the composer is scrolled into view.
- Two components now read overlapping session stats data through two different mechanisms (`useProjection` for `StatsPills`, the new root `activeSessionStats` hook for `PersistentStatsBar`); both stay session-scoped in effect, but only `StatsPills` is confined to the composer's `'session'` slot scope.
- `active-session-stats.ts` adds one more `ISessions.binding` consumer outside `ui-workspace`, reinforcing `binding().projections.faceOf(...)` as the standard bridge for reading session projections from root scope.
- The bar shows nothing until `sessionStats`/`tokenUsage` projections populate; a session with no steps and no billed tokens yet renders no bar at all, not an empty or placeholder one.
- Unit coverage pins `createActiveSessionStatsSource`'s no-session, unresolved-binding, face-read, session-switch resubscription, either-face-notifies, snapshot reference-stability, and re-check-on-later-read behaviors, plus `PersistentStatsBar`'s null-render, both-empty, steps-only, tokens-only, and stable-selector-attribute cases.
