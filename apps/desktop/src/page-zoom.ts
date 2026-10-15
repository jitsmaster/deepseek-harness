/** Browser-style page zoom for the Desktop window: Ctrl/Cmd plus, minus, zero, and Ctrl+wheel. */

import type { Input, WebContents } from 'electron'

const ZOOM_STEP = 0.5
const MIN_ZOOM_LEVEL = -3
const MAX_ZOOM_LEVEL = 5

/** A zoom request: step in, step out, or return to 100%. */
export type ZoomAction = 'in' | 'out' | 'reset'

/**
 * Compute the zoom level after one request.
 * @param level - Current Chromium zoom level (0 is 100%, each 1 is a 1.2x factor).
 * @param action - Requested change.
 * @returns The new level, clamped to the supported range.
 */
export function nextZoomLevel(level: number, action: ZoomAction): number {
  if (action === 'reset') return 0
  const next = level + (action === 'in' ? ZOOM_STEP : -ZOOM_STEP)
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, next))
}

/**
 * Map a key press to a zoom request.
 * @param input - Electron keyboard input.
 * @returns The requested action, or undefined when the key is not a zoom shortcut.
 */
export function zoomActionForInput(input: Pick<Input, 'type' | 'key' | 'control' | 'meta' | 'alt'>): ZoomAction | undefined {
  if (input.type !== 'keyDown' || input.alt || !(input.control || input.meta)) return undefined
  if (input.key === '=' || input.key === '+') return 'in'
  if (input.key === '-' || input.key === '_') return 'out'
  if (input.key === '0') return 'reset'
  return undefined
}

/**
 * Let a window's page zoom with the usual browser shortcuts. Electron enables none of them without a View menu.
 * @param contents - The window's main web contents.
 */
export function attachPageZoom(contents: WebContents): void {
  const apply = (action: ZoomAction): void => {
    if (!contents.isDestroyed()) contents.setZoomLevel(nextZoomLevel(contents.getZoomLevel(), action))
  }
  contents.on('before-input-event', (event, input) => {
    const action = zoomActionForInput(input)
    if (action === undefined) return
    event.preventDefault()
    apply(action)
  })
  // Fired for Ctrl+wheel on Windows and Linux.
  contents.on('zoom-changed', (_event, direction) => { apply(direction) })
}
