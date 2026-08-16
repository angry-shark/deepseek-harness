import { defineConfig } from 'tsdown'

/**
 * The dsh CLI ships two entries: the `bin` referenced by package.json `bin`,
 * and the terminal front door exported as `@deepseek-ai/dsh/tui` (the profile
 * bundle's `tui` row loads it). The root tsdown builds only
 * `lib/types/index.js`, so this override points at the CLI's own entries;
 * their reachable mode modules bundle with them. Declarations come from
 * `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/bin.js', 'lib/types/tui/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
