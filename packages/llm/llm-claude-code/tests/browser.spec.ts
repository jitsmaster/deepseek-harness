import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { launcherFileName, launcherScript, pickPrivateBrowser, writeLauncher } from '../src/browser.ts'
import type { PrivateBrowser } from '../src/browser.ts'

const WIN_ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
}

const CHROME = win32.join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe')
const EDGE = win32.join('C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
const FIREFOX = win32.join('C:\\Program Files', 'Mozilla Firefox', 'firefox.exe')

const present = (...paths: string[]) => (path: string): boolean => paths.includes(path)

describe('pickPrivateBrowser', () => {
  it('prefers Chrome, then Edge, then Firefox, with each one\'s private flag', () => {
    expect(pickPrivateBrowser('win32', WIN_ENV, present(CHROME, EDGE, FIREFOX))).toEqual({ name: 'Chrome', executable: CHROME, args: ['--incognito'] })
    expect(pickPrivateBrowser('win32', WIN_ENV, present(EDGE, FIREFOX))).toEqual({ name: 'Edge', executable: EDGE, args: ['--inprivate'] })
    expect(pickPrivateBrowser('win32', WIN_ENV, present(FIREFOX))).toEqual({ name: 'Firefox', executable: FIREFOX, args: ['-private-window'] })
  })

  it('finds a per-user Chrome under LOCALAPPDATA', () => {
    const local = win32.join('C:\\Users\\me\\AppData\\Local', 'Google', 'Chrome', 'Application', 'chrome.exe')
    expect(pickPrivateBrowser('win32', WIN_ENV, present(local))?.executable).toBe(local)
  })

  it('finds nothing when no browser is installed or the environment names no roots', () => {
    expect(pickPrivateBrowser('win32', WIN_ENV, () => false)).toBeUndefined()
    expect(pickPrivateBrowser('win32', {}, () => true)).toBeUndefined()
  })

  it('knows the usual macOS and Linux locations', () => {
    expect(pickPrivateBrowser('linux', {}, present('/usr/bin/firefox'))).toMatchObject({ name: 'Firefox', args: ['-private-window'] })
    expect(pickPrivateBrowser('linux', {}, present('/usr/bin/chromium'))).toMatchObject({ name: 'Chrome' })
    expect(pickPrivateBrowser('darwin', {}, present('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'))).toMatchObject({ name: 'Edge' })
  })
})

describe('launcherScript', () => {
  const chrome: PrivateBrowser = { name: 'Chrome', executable: CHROME, args: ['--incognito'] }

  it('quotes the program and the URL argument in a Windows batch file', () => {
    expect(launcherScript('win32', chrome)).toBe(`@echo off\r\nstart "" "${CHROME}" --incognito "%~1"\r\n`)
  })

  it('doubles a percent sign in the program path and refuses a path it cannot quote', () => {
    expect(launcherScript('win32', { ...chrome, executable: 'C:\\100%\\chrome.exe' })).toContain('"C:\\100%%\\chrome.exe"')
    expect(launcherScript('win32', { ...chrome, executable: 'C:\\a"b\\chrome.exe' })).toBe('@echo off\r\nstart "" "%~1"\r\n')
  })

  it('opens the default browser when none was found', () => {
    expect(launcherScript('win32', undefined)).toBe('@echo off\r\nstart "" "%~1"\r\n')
    expect(launcherScript('linux', undefined)).toBe('#!/bin/sh\nexec xdg-open "$1"\n')
    expect(launcherScript('darwin', undefined)).toBe('#!/bin/sh\nexec open "$1"\n')
  })

  it('single-quotes the program in a shell script, escaping a quote inside it', () => {
    expect(launcherScript('linux', { name: 'Firefox', executable: '/usr/bin/firefox', args: ['-private-window'] })).toBe('#!/bin/sh\nexec \'/usr/bin/firefox\' -private-window "$1"\n')
    expect(launcherScript('linux', { name: 'Chrome', executable: '/opt/it\'s/chrome', args: ['--incognito'] })).toContain('\'/opt/it\'\\\'\'s/chrome\'')
  })

  it('names the file by platform', () => {
    expect(launcherFileName('win32')).toBe('open-private.cmd')
    expect(launcherFileName('linux')).toBe('open-private.sh')
  })
})

describe('writeLauncher', () => {
  it('writes the script for the picked browser and starts nothing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-claude-browser-'))
    try {
      const written = await writeLauncher(directory, 'win32', WIN_ENV, present(EDGE))
      expect(written.path).toBe(join(directory, 'open-private.cmd'))
      expect(written.browser?.name).toBe('Edge')
      expect(readFileSync(written.path, 'utf8')).toBe(`@echo off\r\nstart "" "${EDGE}" --inprivate "%~1"\r\n`)
      const shell = await writeLauncher(directory, 'linux', {}, () => false)
      expect(shell.browser).toBeUndefined()
      if (process.platform !== 'win32') expect(statSync(shell.path).mode & 0o111).not.toBe(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
