import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { type SkillCandidate } from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import * as SkillClaude from '../src/index.ts'

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-skill-claude-${name}-`))
  tempDirs.push(dir)
  return await realpath(dir)
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

async function writeSkill(root: string, name: string, description: string, body = 'Skill body.'): Promise<void> {
  await writeText(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
}

async function setup(
  config: Partial<SkillClaude.Config>,
  filesystem?: Partial<SkillFileSystem.Config>,
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  if (filesystem !== undefined) await ctx.plugin(SkillFileSystem, { watch: false, ...filesystem })
  await ctx.plugin(SkillClaude, { watch: false, ...config })
  return ctx
}

describe('dsh-skill-claude plugin exports', () => {
  it('declares stable plugin metadata', () => {
    expect(SkillClaude.name).toBe('skill-claude')
    expect(SkillClaude.inject).toEqual(['skills'])
  })
})

describe('ClaudeSkillProvider', () => {
  it('registers user skills, command files, and enabled plugin skills as DSH skills', async () => {
    const home = await tempDir('home')
    await writeSkill(join(home, 'skills'), 'grill-me', 'A relentless interview.')
    await writeText(join(home, 'commands', 'modes', 'sparc.md'), '# Boomerang Commander\n\nOrchestrate phases.\n')
    const plugin = join(home, 'plugins', 'cache', 'superpowers')
    await writeSkill(join(plugin, 'skills'), 'brainstorming', 'Explore intent first.')
    await writeText(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({
      plugins: { 'superpowers@claude-plugins-official': [{ scope: 'user', installPath: plugin }] },
    }))
    await writeText(join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'superpowers@claude-plugins-official': true } }))
    const ctx = await setup({ claudeHome: home })

    const skills = await ctx.skills.list()

    expect(skills.map(skill => skill.name)).toEqual(['grill-me', 'modes-sparc', 'superpowers-brainstorming'])
    expect(skills.map(skill => skill.provider)).toEqual(['claude', 'claude', 'claude'])
    const sparc = await ctx.skills.get('modes-sparc')
    expect(sparc?.content).toBe('# Boomerang Commander\n\nOrchestrate phases.')
    expect(sparc?.resourceBase).toEqual({ kind: 'directory', path: join(home, 'commands', 'modes') })
    expect((await ctx.skills.get('superpowers-brainstorming'))?.content).toBe('Skill body.')
  })

  it('uses a custom provider name', async () => {
    const home = await tempDir('home-name')
    await writeSkill(join(home, 'skills'), 'one', 'd')
    const ctx = await setup({ claudeHome: home, providerName: 'cc' })

    expect((await ctx.skills.list()).map(skill => skill.provider)).toEqual(['cc'])
  })

  it('loads with claudeHome omitted and reads CLAUDE_CONFIG_DIR instead', async () => {
    const home = await tempDir('home-env')
    await writeSkill(join(home, 'skills'), 'from-env', 'd')
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = home
    try {
      const ctx = await setup({})

      expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['from-env'])
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
    }
  })

  it('scans the project .claude directory only when includeProject is on and a cwd is given', async () => {
    const home = await tempDir('home-project')
    const project = await tempDir('project')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeSkill(join(project, '.claude', 'skills'), 'project-only', 'd')
    const withProject = await setup({ claudeHome: home })
    const withoutProject = await setup({ claudeHome: home, includeProject: false })

    expect((await withProject.skills.list({ cwd: join(project, 'src') })).map(skill => skill.name)).toEqual(['project-only'])
    expect(await withProject.skills.list()).toEqual([])
    expect(await withoutProject.skills.list({ cwd: join(project, 'src') })).toEqual([])
  })

  it('resolves a relative cwd against the process directory before looking for the project root', async () => {
    const home = await tempDir('home-relative')
    const project = await tempDir('project-relative')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeSkill(join(project, '.claude', 'skills'), 'project-only', 'd')
    const ctx = await setup({ claudeHome: home })
    // The relative lookup must use the process directory the path resolves against, not the real one.
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(project)
    try {
      const skills = await ctx.skills.list({ cwd: 'src' })
      expect(skills.map(skill => skill.name)).toEqual(['project-only'])
      expect((await ctx.skills.get('project-only', { cwd: 'src' }))?.path).toBe(join(project, '.claude', 'skills', 'project-only', 'SKILL.md'))
    } finally {
      cwd.mockRestore()
    }
  })

  it('skips plugins when includePlugins is off', async () => {
    const home = await tempDir('home-noplugins')
    const plugin = join(home, 'cache', 'p')
    await writeSkill(join(plugin, 'skills'), 'x', 'd')
    await writeText(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'p@m': [{ scope: 'user', installPath: plugin }] } }))
    await writeText(join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'p@m': true } }))
    const ctx = await setup({ claudeHome: home, includePlugins: false })

    expect(await ctx.skills.list()).toEqual([])
  })

  it('applies documented defaults when constructed directly with an empty config', async () => {
    const home = await tempDir('home-direct')
    await writeSkill(join(home, 'skills'), 'direct', 'd')
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = home
    const controller = new AbortController()
    const provider = new SkillClaude.ClaudeSkillProvider({}, { signal: controller.signal, invalidate: () => {} }, () => {})
    try {
      expect(provider.name).toBe('claude')
      const listed = await provider.list({})
      expect('candidates' in listed).toBe(false)
      expect((listed as readonly SkillCandidate[]).map(candidate => candidate.name)).toEqual(['direct'])
    } finally {
      await provider.dispose()
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
    }
  })

  it('reports an unreadable configuration file once per message across repeated listings', async () => {
    const home = await tempDir('home-warn')
    await mkdir(join(home, 'settings.json'), { recursive: true })
    const warnings: string[] = []
    const provider = new SkillClaude.ClaudeSkillProvider(
      { claudeHome: home, watch: false },
      { signal: new AbortController().signal, invalidate: () => {} },
      (message) => { warnings.push(message) },
    )

    await provider.list({})
    await provider.list({})

    expect(warnings.filter(message => message.startsWith('skill-claude: ') && message.includes('settings.json'))).toHaveLength(1)
  })

  it('rejects list() when the caller aborts the signal', async () => {
    const home = await tempDir('home-abort')
    await writeSkill(join(home, 'skills'), 'one', 'd')
    const controller = new AbortController()
    const provider = new SkillClaude.ClaudeSkillProvider(
      { claudeHome: home, watch: false },
      { signal: controller.signal, invalidate: () => {} },
      () => {},
    )
    controller.abort(new Error('stop'))

    await expect(provider.list({ signal: controller.signal })).rejects.toThrow('stop')
  })

  it('lets a workspace skill override a global skill and ranks the six sources', async () => {
    const claudeHome = await tempDir('prec-claude-home')
    const dshHome = await tempDir('prec-dsh-home')
    const agentsHome = await tempDir('prec-agents-home')
    const project = await tempDir('prec-project')
    await mkdir(join(project, '.git'), { recursive: true })

    await writeSkill(join(project, '.agents', 'skills'), 'dsh-ws-over-claude-ws', 'dsh workspace')
    await writeSkill(join(project, '.claude', 'skills'), 'dsh-ws-over-claude-ws', 'claude workspace')

    await writeSkill(join(project, '.claude', 'skills'), 'claude-ws-over-dsh-global', 'claude workspace')
    await writeSkill(join(agentsHome, 'skills'), 'claude-ws-over-dsh-global', 'dsh global')

    await writeSkill(join(project, '.claude', 'skills'), 'claude-ws-over-claude-global', 'claude workspace')
    await writeSkill(join(claudeHome, 'skills'), 'claude-ws-over-claude-global', 'claude global')

    await writeSkill(join(agentsHome, 'skills'), 'dsh-global-over-claude-global', 'dsh global')
    await writeSkill(join(claudeHome, 'skills'), 'dsh-global-over-claude-global', 'claude global')

    await writeText(join(project, '.claude', 'commands', 'command-ws-over-skill-global.md'), 'claude workspace command\n')
    await writeSkill(join(claudeHome, 'skills'), 'command-ws-over-skill-global', 'claude global skill')

    await writeSkill(join(project, '.claude', 'skills'), 'skill-over-command-same-tier', 'project skill')
    await writeText(join(project, '.claude', 'commands', 'skill-over-command-same-tier.md'), 'project command\n')

    const ctx = await setup({ claudeHome }, { dshHome, agentsHome })

    const skills = await ctx.skills.list({ cwd: join(project, 'src') })
    const description = (name: string): string | undefined => skills.find(skill => skill.name === name)?.description
    expect(description('dsh-ws-over-claude-ws')).toBe('dsh workspace')
    expect(description('claude-ws-over-dsh-global')).toBe('claude workspace')
    expect(description('claude-ws-over-claude-global')).toBe('claude workspace')
    expect(description('dsh-global-over-claude-global')).toBe('dsh global')
    expect(description('command-ws-over-skill-global')).toBe('claude workspace command')
    expect(description('skill-over-command-same-tier')).toBe('project skill')
  })
})
