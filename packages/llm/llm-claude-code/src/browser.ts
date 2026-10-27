/**
 * A private-window browser launcher for the sign-in page. The user's normal
 * browser profile is usually already signed in to some other claude.ai account,
 * which would silently authorize the wrong one, so the login child is given a
 * `BROWSER` command that opens the page in a private window of the first
 * installed Chrome, Edge, or Firefox, and in the default browser when none is
 * found. Selection and script text are pure; only `writeLauncher` touches disk.
 * @module @deepseek-ai/dsh-llm-claude-code/browser
 */

import { chmod, writeFile } from 'node:fs/promises'
import { join, win32 } from 'node:path'

/** A browser found on this machine, with the flag that makes its window private. */
export interface PrivateBrowser {
  name: 'Chrome' | 'Edge' | 'Firefox'
  executable: string
  args: readonly string[]
}

/** Where one browser usually lives, and how it is told to open a private window. */
interface Candidate {
  name: PrivateBrowser['name']
  args: readonly string[]
  paths: readonly string[]
}

type Environment = Readonly<Record<string, string | undefined>>

/** The usual install locations, in preference order: Chrome, then Edge, then Firefox. */
function candidates(platform: NodeJS.Platform, env: Environment): Candidate[] {
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.LOCALAPPDATA]
      .filter((root): root is string => root !== undefined && root.length > 0)
    const under = (...parts: string[]): string[] => roots.map(root => win32.join(root, ...parts))
    return [
      { name: 'Chrome', args: ['--incognito'], paths: under('Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Edge', args: ['--inprivate'], paths: under('Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { name: 'Firefox', args: ['-private-window'], paths: under('Mozilla Firefox', 'firefox.exe') },
    ]
  }
  if (platform === 'darwin') {
    return [
      { name: 'Chrome', args: ['--incognito'], paths: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] },
      { name: 'Edge', args: ['--inprivate'], paths: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] },
      { name: 'Firefox', args: ['-private-window'], paths: ['/Applications/Firefox.app/Contents/MacOS/firefox'] },
    ]
  }
  return [
    {
      name: 'Chrome',
      args: ['--incognito'],
      paths: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
    },
    { name: 'Edge', args: ['--inprivate'], paths: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'] },
    { name: 'Firefox', args: ['-private-window'], paths: ['/usr/bin/firefox'] },
  ]
}

/**
 * Pick the browser to open the sign-in page in a private window.
 * @param platform - the operating system.
 * @param env - the environment whose program-directory variables name the install roots.
 * @param exists - whether a path is an installed file; injected so selection needs no disk.
 * @returns the first installed Chrome, Edge, or Firefox, or `undefined` when none is found.
 */
export function pickPrivateBrowser(
  platform: NodeJS.Platform,
  env: Environment,
  exists: (path: string) => boolean,
): PrivateBrowser | undefined {
  for (const candidate of candidates(platform, env)) {
    const executable = candidate.paths.find(path => exists(path))
    if (executable !== undefined) return { name: candidate.name, executable, args: candidate.args }
  }
  return undefined
}

/**
 * The launcher's file name for a platform.
 * @param platform - the operating system.
 * @returns a batch file on Windows, a shell script elsewhere.
 */
export function launcherFileName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'open-private.cmd' : 'open-private.sh'
}

/** Quote a path for a batch file, or refuse one that cannot be quoted safely. */
function cmdQuote(path: string): string | undefined {
  if (/["\r\n]/u.test(path)) return undefined
  return `"${path.replaceAll('%', '%%')}"`
}

/** Quote a word for a POSIX shell. */
function shQuote(word: string): string {
  return `'${word.replaceAll('\'', '\'\\\'\'')}'`
}

/**
 * The text of the launcher the login child runs with the sign-in URL as its one argument.
 * @param platform - the operating system.
 * @param browser - the private-window browser to use; `undefined` opens the default browser.
 * @returns the script text; the default-browser script when the browser's path cannot be quoted safely.
 */
export function launcherScript(platform: NodeJS.Platform, browser: PrivateBrowser | undefined): string {
  if (platform === 'win32') {
    const executable = browser === undefined ? undefined : cmdQuote(browser.executable)
    const open = browser === undefined || executable === undefined
      ? 'start "" "%~1"'
      : `start "" ${executable} ${browser.args.join(' ')} "%~1"`
    return `@echo off\r\n${open}\r\n`
  }
  const opener = platform === 'darwin' ? 'open' : 'xdg-open'
  const open = browser === undefined
    ? `exec ${opener} "$1"`
    : `exec ${shQuote(browser.executable)} ${browser.args.join(' ')} "$1"`
  return `#!/bin/sh\n${open}\n`
}

/**
 * Write the launcher into a directory.
 * @param directory - where to write it; the caller removes it afterwards.
 * @param platform - the operating system.
 * @param env - the environment whose program-directory variables name the install roots.
 * @param exists - whether a path is an installed file.
 * @returns the launcher's path (the value for `BROWSER`) and the browser it opens, if any.
 */
export async function writeLauncher(
  directory: string,
  platform: NodeJS.Platform,
  env: Environment,
  exists: (path: string) => boolean,
): Promise<{ path: string; browser?: PrivateBrowser }> {
  const browser = pickPrivateBrowser(platform, env, exists)
  const path = join(directory, launcherFileName(platform))
  await writeFile(path, launcherScript(platform, browser))
  if (platform !== 'win32') await chmod(path, 0o755)
  return { path, ...browser === undefined ? {} : { browser } }
}
