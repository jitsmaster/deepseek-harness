import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

/**
 * Compatibility package: emits the vendored api/ contract layer (plain ESM
 * modules served by the `./api/*` exports) plus the compat-provider entry.
 * Bare imports (zod, @deepseek-ai/cordis) stay external and resolve from the
 * consuming profile.
 */
const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  entry: [
    join(here, 'src/index.ts'),
    join(here, 'src/compat-provider.ts'),
    join(here, 'src/api/*.js'),
  ],
  outDir: join(here, 'lib'),
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  clean: false,
  dts: false,
  sourcemap: true,
})
