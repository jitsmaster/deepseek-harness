/** Rebuild Desktop's primary runtime payload only when its inputs changed since the last successful build. */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import lock from '../../../scripts/primary-runtime/lock.json' with { type: 'json' }
import { primaryRuntimePayloadDigest, type PrimaryRuntimeTarget } from '../../../scripts/primary-runtime/prepare.ts'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { preparePrimaryRuntime } from './prepare-primary-runtime.ts'

const STAMP_FILE = '.ensure-stamp.json'
const require = createRequire(import.meta.url)

interface Stamp {
  readonly fingerprint: string
}

/** Seams for isolated tests; the launcher passes none. */
export interface EnsureOptions {
  readonly runtimeDirectory?: string
  readonly fingerprint?: () => string
  readonly prepare?: () => Promise<void>
}

function readVersion(manifestPath: string): string {
  return (JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string }).version
}

function directoryFingerprint(root: string): string {
  const hash = createHash('sha256')
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(path)
        continue
      }
      const stat = statSync(path)
      hash.update(`${relative(root, path)}\0${String(stat.size)}\0${String(stat.mtimeMs)}\n`)
    }
  }
  visit(root)
  return hash.digest('hex')
}

/**
 * Compute the identity of everything the prepared payload is built from.
 * @returns SHA-256 over the locked payload digest, Desktop version, and Office skill asset files.
 */
export function primaryRuntimeFingerprint(): string {
  const target = resolveDesktopBuildTarget()
  const pnpmVersion = readVersion(require.resolve('pnpm'))
  const desktopVersion = readVersion(fileURLToPath(new URL('../package.json', import.meta.url)))
  const assets = join(dirname(require.resolve('@deepseek-ai/dsh-skill-office/package.json')), 'assets')
  return createHash('sha256').update(JSON.stringify({
    payload: primaryRuntimePayloadDigest(target as PrimaryRuntimeTarget, lock, pnpmVersion),
    desktopVersion,
    assets: directoryFingerprint(assets),
  })).digest('hex')
}

/** Tell a launcher splash which phase is running, through the file named by DSH_DESKTOP_STATUS_FILE when it sets one. */
function reportStatus(text: string): void {
  const path = process.env.DSH_DESKTOP_STATUS_FILE
  if (path === undefined || path === '') return
  try {
    writeFileSync(path, text)
  } catch {
    // The splash is cosmetic; never fail a launch over it.
  }
}

/**
 * Prepare and smoke-test the primary runtime unless the last successful build used identical inputs.
 * Set DSH_DESKTOP_FORCE_RUNTIME=1 to rebuild regardless.
 * @returns Resolves after the payload is current.
 */
export async function ensurePrimaryRuntime(options: EnsureOptions = {}): Promise<void> {
  const runtime = options.runtimeDirectory ?? resolveDesktopTargetBuildPaths().runtime
  const prepare = options.prepare ?? preparePrimaryRuntime
  const stampPath = join(runtime, STAMP_FILE)
  const fingerprint = (options.fingerprint ?? primaryRuntimeFingerprint)()
  const present = existsSync(join(runtime, 'primary-runtime', 'runtime.json')) && existsSync(join(runtime, 'office-skills'))
  if (present && process.env.DSH_DESKTOP_FORCE_RUNTIME !== '1' && existsSync(stampPath)) {
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8')) as Stamp
    if (stamp.fingerprint === fingerprint) {
      console.log('desktop development: primary runtime is up to date, skipping rebuild')
      reportStatus('Starting DSH...')
      return
    }
  }
  reportStatus('Building DSH...')
  await prepare()
  writeFileSync(stampPath, `${JSON.stringify({ fingerprint } satisfies Stamp)}\n`)
}

if (import.meta.main) await ensurePrimaryRuntime()
