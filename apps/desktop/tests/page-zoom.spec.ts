import { describe, expect, it } from 'vitest'
import { nextZoomLevel, zoomActionForInput } from '../src/page-zoom.ts'

const press = (key: string, extra: Partial<{ control: boolean; meta: boolean; alt: boolean; type: 'keyDown' | 'keyUp' }> = {}) =>
  ({ type: 'keyDown' as const, key, control: true, meta: false, alt: false, ...extra })

describe('page zoom', () => {
  it('steps in and out and resets', () => {
    expect(nextZoomLevel(0, 'in')).toBe(0.5)
    expect(nextZoomLevel(0, 'out')).toBe(-0.5)
    expect(nextZoomLevel(2, 'reset')).toBe(0)
  })

  it('clamps to the supported range', () => {
    expect(nextZoomLevel(5, 'in')).toBe(5)
    expect(nextZoomLevel(-3, 'out')).toBe(-3)
  })

  it('maps Ctrl or Cmd plus equals, plus, minus, and zero', () => {
    expect(zoomActionForInput(press('='))).toBe('in')
    expect(zoomActionForInput(press('+'))).toBe('in')
    expect(zoomActionForInput(press('-'))).toBe('out')
    expect(zoomActionForInput(press('0'))).toBe('reset')
    expect(zoomActionForInput(press('=', { control: false, meta: true }))).toBe('in')
  })

  it('ignores other keys, key releases, Alt chords, and unmodified presses', () => {
    expect(zoomActionForInput(press('a'))).toBeUndefined()
    expect(zoomActionForInput(press('=', { type: 'keyUp' }))).toBeUndefined()
    expect(zoomActionForInput(press('=', { alt: true }))).toBeUndefined()
    expect(zoomActionForInput(press('=', { control: false }))).toBeUndefined()
  })
})
