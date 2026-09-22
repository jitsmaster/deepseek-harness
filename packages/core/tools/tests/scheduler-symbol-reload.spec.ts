/**
 * Regression test for the HMR module-reload bug: `packages/boot/hmr` clears
 * both the ESM and CJS module caches and re-`import()`s plugin modules,
 * including this package's own module when it is swept up as a shared
 * dependency of some other plugin being reloaded. `TOOL_RUNTIME_SCHEDULER`
 * must stay the identical symbol across such a re-evaluation, or a consumer
 * that imported it before the reload (e.g. `dsh-agent-loop`) silently loses
 * access to the scheduler on the freshly-reloaded `ToolRuntime` instance.
 */

import { describe, expect, it, vi } from 'vitest'
import { TOOL_RUNTIME_SCHEDULER } from '../src/index.ts'

describe('TOOL_RUNTIME_SCHEDULER symbol identity across a simulated module reload', () => {
  it('is the same symbol after the module is re-evaluated', async () => {
    vi.resetModules()
    const first = await import('../src/index.ts')
    vi.resetModules()
    const second = await import('../src/index.ts')

    expect(second.TOOL_RUNTIME_SCHEDULER).toBe(first.TOOL_RUNTIME_SCHEDULER)
  })

  it('is keyed off the global symbol registry, not a fresh per-module Symbol()', () => {
    // If this ever regresses to a plain `Symbol()`, this assertion fails
    // immediately instead of only surfacing as a confusing runtime
    // "cannot read properties of undefined" deep inside the tool scheduler.
    expect(Symbol.keyFor(TOOL_RUNTIME_SCHEDULER)).toBe('@deepseek-ai/dsh-tools.scheduler')
  })
})
