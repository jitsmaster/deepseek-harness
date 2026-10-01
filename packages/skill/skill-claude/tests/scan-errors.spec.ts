import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillRoot, Warn } from '../src/types.ts'

const fsHarness = vi.hoisted(() => ({ denied: new Set<string>() }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async readdir(...args: Parameters<typeof actual.readdir>) {
      if (fsHarness.denied.has(String(args[0]))) throw Object.assign(new Error('access denied'), { code: 'EACCES' })
      return await actual.readdir(...args)
    },
  }
})

const { scanRoot } = await import('../src/scan.ts')

const tempDirs: string[] = []
afterEach(async () => {
  fsHarness.denied.clear()
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('scanRoot when a directory cannot be listed', () => {
  it('warns once for the denied directory and returns no candidates', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-skill-claude-denied-')))
    tempDirs.push(dir)
    fsHarness.denied.add(dir)
    const messages: string[] = []
    const warn: Warn = (_key, message) => { messages.push(message) }
    const root: SkillRoot = { kind: 'skills', dir, rank: 530, source: 'claude-user' }

    expect(await scanRoot(root, 'claude', warn)).toEqual([])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain(dir)
    expect(messages[0]).toContain('access denied')
  })
})
