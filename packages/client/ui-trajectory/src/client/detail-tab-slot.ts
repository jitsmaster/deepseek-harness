/**
 * Plugin detail tabs for the Trajectory details panel: the projection of the
 * `conversation.trajectory.detail.tabs` registrations into tab rows, the
 * per-record visibility filter, and the record description handed to tabs.
 */

import { useCallback, useSyncExternalStore } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SlotLabel, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { TrajectoryDetailTabRecord } from './trajectory-contract.ts'

/** The slot key every plugin detail tab registers into. */
export const DETAIL_TAB_SLOT = 'conversation.trajectory.detail.tabs'

/** Tab id of a plugin tab; the prefix keeps it from colliding with a built-in tab id. */
export type PluginDetailTabId = `slot:${string}`

/** One plugin tab as the table needs it. */
export interface TrajectoryDetailTabRow {
  /** Registration id, used to address the entry when rendering. */
  readonly slotId: string
  /** Tab id in the details panel (`slot:<registration id>`). */
  readonly tabId: PluginDetailTabId
  readonly order: number
  readonly label: SlotLabel | undefined
  readonly when: ((record: TrajectoryDetailTabRecord) => boolean) | undefined
}

/** Live tab rows, ascending by `order`. */
export type TrajectoryDetailTabSource = ObservableSnapshot<readonly TrajectoryDetailTabRow[]>

/** The slice of the slot registry the tab source reads. */
export interface DetailTabSlotRegistry {
  entries(key: string): readonly StoredEntry[]
  getVersion(key: string): number
  subscribe(key: string, listener: () => void): () => void
}

const NO_ROWS: readonly TrajectoryDetailTabRow[] = []
const NO_TAB_SOURCE: TrajectoryDetailTabSource = {
  getSnapshot: () => NO_ROWS,
  subscribe: () => () => {},
}

/**
 * Project the detail-tab registrations into rows. The snapshot is cached until
 * the slot's ledger version moves, as `useSyncExternalStore` requires.
 * @param slots - slot registry (or a slice of it).
 * @returns a source of rows, one per registration id, ascending by `order`.
 */
export function createDetailTabSource(slots: DetailTabSlotRegistry): TrajectoryDetailTabSource {
  let version = -1
  let rows = NO_ROWS
  return {
    getSnapshot: () => {
      const current = slots.getVersion(DETAIL_TAB_SLOT)
      if (current !== version) {
        version = current
        const seen = new Set<string>()
        rows = slots.entries(DETAIL_TAB_SLOT).flatMap((entry) => {
          const slotId = entry.options.id
          if (slotId === undefined || seen.has(slotId)) return []
          seen.add(slotId)
          const rawWhen = entry.custom?.['when']
          const when = typeof rawWhen === 'function'
            ? rawWhen as NonNullable<TrajectoryDetailTabRow['when']>
            : undefined
          return [{
            slotId,
            tabId: `slot:${slotId}` as const,
            order: entry.options.order ?? 0,
            label: entry.options.label,
            when,
          }]
        }).sort((left, right) => left.order - right.order)
      }
      return rows
    },
    subscribe: listener => slots.subscribe(DETAIL_TAB_SLOT, listener),
  }
}

/**
 * Subscribe to a tab source.
 * @param source - tab source, or undefined when the host supplies none.
 * @returns the current rows.
 */
export function useDetailTabRows(
  source: TrajectoryDetailTabSource | undefined,
): readonly TrajectoryDetailTabRow[] {
  const resolved = source ?? NO_TAB_SOURCE
  const subscribe = useCallback((listener: () => void) => resolved.subscribe(listener), [resolved])
  const getSnapshot = useCallback(() => resolved.getSnapshot(), [resolved])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/**
 * Rows whose predicate accepts the record. A throwing predicate hides its tab:
 * the predicate is plugin code and must not take the details panel down.
 * @param rows - all tab rows.
 * @param record - the selected record.
 * @returns the rows visible for the record, in row order.
 */
export function visibleDetailTabRows(
  rows: readonly TrajectoryDetailTabRow[],
  record: TrajectoryDetailTabRecord,
): readonly TrajectoryDetailTabRow[] {
  return rows.filter((row) => {
    if (row.when === undefined) return true
    try {
      return row.when(record)
    } catch {
      // Plugin predicate failure: the tab stays hidden rather than crashing the panel.
      return false
    }
  })
}

/**
 * Resolve a row's label at read time so locale thunks follow the active locale.
 * @param row - tab row.
 * @returns the label, or the registration id when none was given.
 */
export function detailTabRowLabel(row: TrajectoryDetailTabRow): string {
  try {
    const label = typeof row.label === 'function' ? row.label() : row.label
    return label ?? row.slotId
  } catch {
    // Plugin label failure: show the registration id rather than crashing the table.
    return row.slotId
  }
}
