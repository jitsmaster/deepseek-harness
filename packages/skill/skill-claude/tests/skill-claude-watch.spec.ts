import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'

interface FakeWatcher {
  readonly emitter: EventEmitter & { close(): Promise<void> }
  readonly path: string
  readonly options: Record<string, unknown>
  closeCalls: number
}

const harness = vi.hoisted(() => ({ watchers: [] as FakeWatcher[], watchThrows: false }))

vi.mock('chokidar', () => ({
  default: {
    watch(path: unknown, options: Record<string, unknown>) {
      if (harness.watchThrows) throw new Error('native watch unavailable')
      const emitter = new EventEmitter() as FakeWatcher['emitter']
      const control: FakeWatcher = { emitter, path: String(path), options, closeCalls: 0 }
      emitter.close = async () => { control.closeCalls += 1 }
      harness.watchers.push(control)
      return emitter
    },
  },
}))

const SkillClaude = await import('../src/index.ts')

const tempDirs: string[] = []
beforeEach(() => {
  harness.watchers.length = 0
  harness.watchThrows = false
})
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-skill-claude-wire-')))
  tempDirs.push(dir)
  return dir
}

async function writeSkill(root: string, name: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\nBody\n`)
}

describe('skill-claude change watching', () => {
  it('watches existing roots deeply and configuration directories shallowly with default options', async () => {
    const home = await tempDir()
    await writeSkill(join(home, 'skills'), 'one')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillClaude, { claudeHome: home })

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['one'])

    const byPath = new Map(harness.watchers.map(entry => [entry.path, entry]))
    expect(byPath.get(join(home, 'skills'))?.options.depth).toBeUndefined()
    expect(byPath.get(home)?.options.depth).toBe(0)
    expect(byPath.get(home)?.options).toMatchObject({
      usePolling: false,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    })
    await fiber.dispose()
  })

  it('honors explicit watch options', async () => {
    const home = await tempDir()
    await writeSkill(join(home, 'skills'), 'one')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillClaude, {
      claudeHome: home,
      watchUsePolling: true,
      watchStabilityThresholdMs: 7,
      watchPollIntervalMs: 9,
    })

    await ctx.skills.list()

    expect(harness.watchers[0]?.options).toMatchObject({ usePolling: true, awaitWriteFinish: { stabilityThreshold: 7, pollInterval: 9 } })
    await fiber.dispose()
  })

  it('refreshes the catalog and notifies observers when a watched path changes', async () => {
    const home = await tempDir()
    await writeSkill(join(home, 'skills'), 'one')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillClaude, { claudeHome: home })
    let changes = 0
    ctx.on('skills/change', () => { changes += 1 })
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['one'])

    await writeSkill(join(home, 'skills'), 'two')
    harness.watchers.find(entry => entry.path === join(home, 'skills'))?.emitter.emit('all', 'addDir', join(home, 'skills', 'two'))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(changes).toBeGreaterThan(0)
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['one', 'two'])
    await fiber.dispose()
  })

  it('closes its watchers when the plugin is disposed', async () => {
    const home = await tempDir()
    await writeSkill(join(home, 'skills'), 'one')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillClaude, { claudeHome: home })
    await ctx.skills.list()

    await fiber.dispose()

    expect(harness.watchers.length).toBeGreaterThan(0)
    expect(harness.watchers.every(entry => entry.closeCalls === 1)).toBe(true)
  })

  it('forwards provider warnings to the context logger', async () => {
    const home = await tempDir()
    await mkdir(join(home, 'settings.json'), { recursive: true })
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const fiber = await ctx.plugin(SkillClaude, { claudeHome: home })

    await ctx.skills.list()
    await ctx.skills.list()

    expect(warnings.filter(message => message.startsWith('skill-claude: ') && message.includes('settings.json'))).toHaveLength(1)
    await fiber.dispose()
  })

  it('still serves the scanned skills, with one warning, when opening a watcher throws', async () => {
    const home = await tempDir()
    await writeSkill(join(home, 'skills'), 'one')
    harness.watchThrows = true
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const fiber = await ctx.plugin(SkillClaude, { claudeHome: home })

    const first = await ctx.skills.list()
    const second = await ctx.skills.snapshot()

    expect(first.map(skill => skill.name)).toEqual(['one'])
    expect(second.skills.map(skill => skill.name)).toEqual(['one'])
    expect(second.complete).toBe(true)
    expect(warnings.filter(message => message.includes('native watch unavailable'))).toHaveLength(1)
    await fiber.dispose()
  })
})
