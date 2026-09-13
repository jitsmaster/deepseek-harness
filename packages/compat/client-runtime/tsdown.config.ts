import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

/**
 * The browser module-table row for this package is a hand-maintained loader
 * registration artifact (`src/client-bundle.js`, see README), not a tsdown
 * emit: its factory format is fixed by the client-modules loader. The server
 * entry builds normally; the client artifact is copied into `lib/` so the
 * package's `./client` export serves it. The copy is a deliberate build
 * side-effect (idempotent).
 */
const here = dirname(fileURLToPath(import.meta.url))
mkdirSync(join(here, 'lib'), { recursive: true })
cpSync(join(here, 'src/client-bundle.js'), join(here, 'lib/client.js'))

export default defineConfig({
  entry: [join(here, 'src/index.ts')],
  outDir: join(here, 'lib'),
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  clean: false,
  dts: false,
  sourcemap: true,
})
