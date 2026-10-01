import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLAUDE_RANK, findProjectRoot, resolveClaudeHome, resolveSources, samePath } from '../src/sources.ts'
import type { Warn } from '../src/types.ts'

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-skill-claude-${name}-`))
  tempDirs.push(dir)
  return await realpath(dir)
}

function collector(): { warn: Warn; messages: string[] } {
  const messages: string[] = []
  return { warn: (_key, message) => { messages.push(message) }, messages }
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, JSON.stringify(value))
}

function homeDir(path: string): { path: string; names: readonly string[] } {
  return { path, names: ['skills', 'commands', 'plugins', 'settings.json'] }
}

function pluginsDir(home: string): { path: string; names: readonly string[] } {
  return { path: join(home, 'plugins'), names: ['installed_plugins.json'] }
}

function projectDir(project: string): { path: string; names: readonly string[] } {
  return { path: join(project, '.claude'), names: ['skills', 'commands', 'settings.json', 'settings.local.json'] }
}

describe('resolveClaudeHome', () => {
  it('prefers the configured directory, then CLAUDE_CONFIG_DIR, then ~/.claude', () => {
    expect(resolveClaudeHome('/configured', { CLAUDE_CONFIG_DIR: '/env' })).toBe('/configured')
    expect(resolveClaudeHome(undefined, { CLAUDE_CONFIG_DIR: '/env' })).toBe('/env')
    expect(resolveClaudeHome(undefined, { CLAUDE_CONFIG_DIR: '' })).toBe(join(homedir(), '.claude'))
    expect(resolveClaudeHome(undefined, {})).toBe(join(homedir(), '.claude'))
  })
})

describe('findProjectRoot', () => {
  it('returns the nearest ancestor containing .git', async () => {
    const root = await tempDir('git-root')
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(join(root, 'src', 'deep'), { recursive: true })
    expect(await findProjectRoot(join(root, 'src', 'deep'))).toBe(root)
  })

  it('returns the starting directory when no ancestor has .git', async () => {
    const root = await tempDir('no-git')
    expect(await findProjectRoot(root)).toBe(root)
  })
})

describe('samePath', () => {
  it('normalises paths and ignores case only for win32', () => {
    expect(samePath(join('/a', 'b', '..', 'c'), join('/a', 'c'), 'linux')).toBe(true)
    expect(samePath('/a/C', '/a/c', 'linux')).toBe(false)
    expect(samePath('/a/C', '/a/c', 'win32')).toBe(true)
    expect(samePath('/a/c', '/a/d', 'win32')).toBe(false)
  })
})

describe('resolveSources', () => {
  it('lists project and user roots with their ranks and the shallow watch directories', async () => {
    const home = await tempDir('home')
    const project = await tempDir('project')
    const { warn, messages } = collector()

    const sources = await resolveSources({ claudeHome: home, projectRoot: project, includePlugins: false, warn })

    expect(sources.roots.map(root => [root.kind, root.dir, root.rank, root.source])).toEqual([
      ['skills', join(project, '.claude', 'skills'), CLAUDE_RANK.projectSkills, 'claude-project'],
      ['commands', join(project, '.claude', 'commands'), CLAUDE_RANK.projectCommands, 'claude-project'],
      ['skills', join(home, 'skills'), CLAUDE_RANK.userSkills, 'claude-user'],
      ['commands', join(home, 'commands'), CLAUDE_RANK.userCommands, 'claude-user'],
    ])
    expect(sources.shallowDirs).toEqual([homeDir(home), projectDir(project)])
    expect(messages).toEqual([])
  })

  it('omits project roots without a project and plugin roots when plugins are off', async () => {
    const home = await tempDir('home-only')
    const { warn } = collector()
    const sources = await resolveSources({ claudeHome: home, projectRoot: undefined, includePlugins: false, warn })
    expect(sources.roots.map(root => root.rank)).toEqual([CLAUDE_RANK.userSkills, CLAUDE_RANK.userCommands])
    expect(sources.shallowDirs).toEqual([homeDir(home)])
  })

  it('resolves enabled user-scope plugins from installed_plugins.json', async () => {
    const home = await tempDir('plugins')
    const { warn, messages } = collector()
    const cache = (name: string): string => join(home, 'plugins', 'cache', name)
    await writeJson(join(home, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'superpowers@claude-plugins-official': [{ scope: 'user', installPath: cache('superpowers') }],
        'disabled@market': [{ scope: 'user', installPath: cache('disabled') }],
        'scoped@market': [{ scope: 'project', installPath: cache('scoped') }],
        bare: [{ scope: 'user', installPath: cache('bare') }],
      },
    })
    await writeJson(join(home, 'settings.json'), {
      enabledPlugins: {
        'superpowers@claude-plugins-official': true,
        'disabled@market': false,
        'scoped@market': true,
        'ghost@market': true,
        bare: true,
        ignored: 'yes',
      },
    })

    const sources = await resolveSources({ claudeHome: home, projectRoot: undefined, includePlugins: true, warn })

    const plugins = sources.roots.filter(root => root.plugin !== undefined)
    expect(plugins.map(root => [root.plugin, root.kind, root.rank, root.dir, root.source])).toEqual([
      ['bare', 'skills', CLAUDE_RANK.pluginSkills, join(cache('bare'), 'skills'), 'claude-plugin'],
      ['bare', 'commands', CLAUDE_RANK.pluginCommands, join(cache('bare'), 'commands'), 'claude-plugin'],
      ['superpowers', 'skills', CLAUDE_RANK.pluginSkills, join(cache('superpowers'), 'skills'), 'claude-plugin'],
      ['superpowers', 'commands', CLAUDE_RANK.pluginCommands, join(cache('superpowers'), 'commands'), 'claude-plugin'],
    ])
    expect(sources.shallowDirs).toEqual([homeDir(home), pluginsDir(home)])
    expect(messages).toEqual([
      'plugin ghost@market is enabled but not installed',
      'plugin scoped@market skipped: only scope "user" entries are supported',
    ])
  })

  it('lets project settings override user settings in order', async () => {
    const home = await tempDir('override-home')
    const project = await tempDir('override-project')
    const { warn } = collector()
    await writeJson(join(home, 'plugins', 'installed_plugins.json'), {
      plugins: {
        'on@market': [{ scope: 'user', installPath: join(home, 'cache', 'on') }],
        'off@market': [{ scope: 'user', installPath: join(home, 'cache', 'off') }],
      },
    })
    await writeJson(join(home, 'settings.json'), { enabledPlugins: { 'on@market': false, 'off@market': true } })
    await writeJson(join(project, '.claude', 'settings.json'), { enabledPlugins: { 'on@market': true } })
    await writeJson(join(project, '.claude', 'settings.local.json'), { enabledPlugins: { 'off@market': false } })

    const sources = await resolveSources({ claudeHome: home, projectRoot: project, includePlugins: true, warn })

    expect([...new Set(sources.roots.flatMap(root => root.plugin === undefined ? [] : [root.plugin]))]).toEqual(['on'])
    expect(sources.shallowDirs).toEqual([homeDir(home), pluginsDir(home), projectDir(project)])
  })

  describe('when the project .claude directory is the Claude home', () => {
    async function homeProject(): Promise<{ project: string; home: string }> {
      const project = await tempDir('home-project')
      return { project, home: join(project, '.claude') }
    }

    it('lists user roots, plugin roots, and watch directories once', async () => {
      const { project, home } = await homeProject()
      const { warn, messages } = collector()
      await writeJson(join(home, 'plugins', 'installed_plugins.json'), {
        plugins: { 'one@market': [{ scope: 'user', installPath: join(home, 'cache', 'one') }] },
      })
      await writeJson(join(home, 'settings.json'), { enabledPlugins: { 'one@market': true } })

      const sources = await resolveSources({ claudeHome: home, projectRoot: project, includePlugins: true, warn })

      expect(sources.roots.map(root => root.rank)).toEqual([
        CLAUDE_RANK.userSkills,
        CLAUDE_RANK.userCommands,
        CLAUDE_RANK.pluginSkills,
        CLAUDE_RANK.pluginCommands,
      ])
      expect(sources.shallowDirs).toEqual([homeDir(home), pluginsDir(home)])
      expect(messages).toEqual([])
    })

    it('reads settings.json once', async () => {
      const { project, home } = await homeProject()
      const { warn, messages } = collector()
      await writeText(join(home, 'settings.json'), '{not json')

      await resolveSources({ claudeHome: home, projectRoot: project, includePlugins: true, warn })

      expect(messages).toHaveLength(1)
    })

    it.runIf(process.platform === 'win32')('matches paths that differ only in case on Windows', async () => {
      const { project, home } = await homeProject()
      const { warn } = collector()

      const sources = await resolveSources({ claudeHome: home.toUpperCase(), projectRoot: project, includePlugins: false, warn })

      expect(sources.roots.map(root => root.rank)).toEqual([CLAUDE_RANK.userSkills, CLAUDE_RANK.userCommands])
      expect(sources.shallowDirs).toEqual([homeDir(home.toUpperCase())])
    })
  })

  it('tolerates absent files, wrong shapes, and invalid JSON without throwing', async () => {
    const home = await tempDir('shapes')
    const { warn, messages } = collector()
    await writeText(join(home, 'settings.json'), '{not json')
    await writeJson(join(home, 'plugins', 'installed_plugins.json'), ['not', 'an', 'object'])

    const sources = await resolveSources({ claudeHome: home, projectRoot: undefined, includePlugins: true, warn })

    expect(sources.roots.every(root => root.plugin === undefined)).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('invalid JSON')
    expect(messages[0]).toContain(join(home, 'settings.json'))
  })

  it('reads settings and the plugin registry that start with a UTF-8 byte order mark', async () => {
    const home = await tempDir('bom')
    const { warn, messages } = collector()
    const bom = '﻿'
    await writeText(join(home, 'settings.json'), bom + JSON.stringify({ enabledPlugins: { 'a@b': true } }))
    await writeText(
      join(home, 'plugins', 'installed_plugins.json'),
      bom + JSON.stringify({ plugins: { 'a@b': [{ scope: 'user', installPath: join(home, 'x') }] } }),
    )

    const sources = await resolveSources({ claudeHome: home, projectRoot: undefined, includePlugins: true, warn })

    expect(sources.roots.filter(root => root.plugin === 'a').map(root => root.dir)).toEqual([join(home, 'x', 'skills'), join(home, 'x', 'commands')])
    expect(messages).toEqual([])
  })

  it('reads enabledPlugins only when it is an object', async () => {
    const home = await tempDir('enabled-shape')
    const { warn, messages } = collector()
    await writeJson(join(home, 'settings.json'), { enabledPlugins: ['a@b'] })
    await writeJson(join(home, 'plugins', 'installed_plugins.json'), { plugins: { 'a@b': [{ scope: 'user', installPath: join(home, 'x') }] } })

    const sources = await resolveSources({ claudeHome: home, projectRoot: undefined, includePlugins: true, warn })

    expect(sources.roots.every(root => root.plugin === undefined)).toBe(true)
    expect(messages).toEqual([])
  })

  it('warns when a settings file cannot be read for a reason other than absence', async () => {
    const home = await tempDir('unreadable')
    const { warn, messages } = collector()
    await mkdir(join(home, 'settings.json'), { recursive: true })

    await resolveSources({ claudeHome: home, projectRoot: undefined, includePlugins: true, warn })

    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain(join(home, 'settings.json'))
  })
})
