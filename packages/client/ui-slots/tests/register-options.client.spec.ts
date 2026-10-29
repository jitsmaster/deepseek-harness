import { describe, expect, it } from 'vitest'
import type { SlotComponent } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'test.options': {
      kind: 'list'
      scope: 'root'
      registerOptions: { when?: (value: number) => boolean }
    }
  }
}

const Comp: SlotComponent<object> = () => null

function mountFrame(core: SlotCore) {
  return core.register({
    name: 'root',
    children: { 'test.options': { kind: 'list', scope: 'root' } },
  }, Comp as never)
}

describe('slot-declared register options', () => {
  it('stores options beyond the common set verbatim on the entry', () => {
    const core = new SlotCore()
    mountFrame(core)
    const when = (value: number) => value > 0
    core.register({ name: 'test.options', id: 'a', label: 'A', order: 3, when }, Comp)
    const [entry] = core.entries('test.options')
    expect(entry?.custom).toEqual({ when })
    expect(entry?.options).toEqual({ id: 'a', label: 'A', order: 3 })
  })

  it('leaves custom absent when no extra option is passed', () => {
    const core = new SlotCore()
    mountFrame(core)
    core.register({ name: 'test.options', id: 'a' }, Comp)
    expect(core.entries('test.options')[0]?.custom).toBeUndefined()
  })
})
