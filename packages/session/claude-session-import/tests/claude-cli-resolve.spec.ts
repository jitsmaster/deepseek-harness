import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { parseCmdShimTarget, resolveClaudeCliArgv } from '../src/claude-cli-resolve.ts'

/** The real npm-generated shim content found on a Windows dev machine (nvm-managed Node install). */
const REAL_CMD_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  String.raw`"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*`,
  '',
].join('\r\n')

function stubbedCtx(resolveExecutable: (command: string) => Promise<string>): Context {
  const ctx = new Context()
  ctx.provide('subprocess', { resolveExecutable } as unknown as Context['subprocess'])
  return ctx
}

describe('parseCmdShimTarget', () => {
  it('extracts the target path from a real npm-generated cmd shim', () => {
    expect(parseCmdShimTarget(REAL_CMD_SHIM)).toBe(String.raw`node_modules\@anthropic-ai\claude-code\bin\claude.exe`)
  })

  it('returns undefined for content that does not match the shim template', () => {
    expect(parseCmdShimTarget('@ECHO off\r\nnode "%~dp0\\cli.js" %*\r\n')).toBeUndefined()
  })
})

describe('resolveClaudeCliArgv', () => {
  it('returns the resolved path unchanged when it is not a .cmd/.bat shim (POSIX, or an .exe already)', async () => {
    const ctx = stubbedCtx(async () => '/home/u/.nvm/versions/node/v22/bin/claude')
    await expect(resolveClaudeCliArgv(ctx, new AbortController().signal)).resolves.toEqual([
      '/home/u/.nvm/versions/node/v22/bin/claude',
    ])
  })

  it('spawns a shim-declared native executable target directly, no process.execPath prefix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-cli-resolve-'))
    try {
      const exeDir = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin')
      const shimPath = join(dir, 'claude.cmd')
      writeFileSync(shimPath, REAL_CMD_SHIM)
      const ctx = stubbedCtx(async () => shimPath)
      const argv = await resolveClaudeCliArgv(ctx, new AbortController().signal)
      expect(argv).toEqual([join(exeDir, 'claude.exe')])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prefixes process.execPath when the shim declares a .js entry point', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-cli-resolve-'))
    try {
      const shimPath = join(dir, 'claude.cmd')
      const shim = [
        '@ECHO off',
        'GOTO start',
        ':find_dp0',
        'SET dp0=%~dp0',
        'EXIT /b',
        ':start',
        'SETLOCAL',
        'CALL :find_dp0',
        String.raw`"%dp0%\node_modules\@anthropic-ai\claude-code\cli.js"   %*`,
        '',
      ].join('\r\n')
      writeFileSync(shimPath, shim)
      const ctx = stubbedCtx(async () => shimPath)
      const argv = await resolveClaudeCliArgv(ctx, new AbortController().signal)
      expect(argv).toEqual([process.execPath, join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the resolved shim path when the shim file cannot be read', async () => {
    const ctx = stubbedCtx(async () => join(tmpdir(), 'claude-cli-resolve-nonexistent', 'claude.cmd'))
    const argv = await resolveClaudeCliArgv(ctx, new AbortController().signal)
    expect(argv).toEqual([join(tmpdir(), 'claude-cli-resolve-nonexistent', 'claude.cmd')])
  })

  it('falls back to the bare "claude" command name, without throwing, when resolveExecutable itself fails', async () => {
    const ctx = stubbedCtx(async () => { throw new Error('subprocess-local: command "claude" was not found on PATH') })
    await expect(resolveClaudeCliArgv(ctx, new AbortController().signal)).resolves.toEqual(['claude'])
  })

  it('falls back to the resolved shim path when its content does not match the known template', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-cli-resolve-'))
    try {
      const shimPath = join(dir, 'claude.bat')
      writeFileSync(shimPath, '@ECHO off\r\nnode "%~dp0\\cli.js" %*\r\n')
      const ctx = stubbedCtx(async () => shimPath)
      const argv = await resolveClaudeCliArgv(ctx, new AbortController().signal)
      expect(argv).toEqual([shimPath])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
