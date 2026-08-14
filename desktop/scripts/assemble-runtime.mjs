#!/usr/bin/env node
/**
 * Assemble the self-contained dsh runtime closure that the packaged app ships
 * as an extra resource. The runtime is a flat node_modules (npm-install
 * layout) built from the workspace's own installed dependency graph, so the
 * installer never touches npm and the result works from another machine:
 *
 * - @deepseek-ai/dsh's own files (lib/, config/) and its closure nest under
 *   dsh/; the shell spawns <runtime>/dsh/lib/bin.js.
 * - The production closure (dependencies, optionalDependencies, and
 *   peerDependencies that the code imports at runtime) is copied from the
 *   workspace into a hoisted dsh/node_modules, dereferencing every symlink, so
 *   `link:`-overridden vendor packages (cosmokit, schemastery, the cordis
 *   plugin family) become real copies.
 * - A name that resolves to a second real location nests under the requiring
 *   package's runtime dir, mirroring npm's conflict layout.
 *
 * A plain `pnpm deploy` cannot be used: this checkout's registry mirror is
 * stale for versions the deploy re-resolves, and deploy's virtual-store
 * layout leaves the link:-overridden packages as symlinks into this checkout.
 * electron-builder's extraResources copy drops a ROOT-level node_modules
 * directory, which is why the closure nests under dsh/ instead.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const target = join(repoRoot, 'desktop', 'build', 'dsh-runtime')
// The dsh package and its closure nest under dsh/: electron-builder's
// extraResources copy drops a root-level node_modules directory (it is meant
// to prevent double-packaging the app's own deps), so the closure lives one
// level down where it copies normally.
const runtimeModules = join(target, 'dsh', 'node_modules')

rmSync(target, { recursive: true, force: true })
mkdirSync(runtimeModules, { recursive: true })

/** Resolve a dependency name from a source package dir, Node-style (walks upward). */
function resolveFrom(packageDir, name) {
  let dir = packageDir
  while (true) {
    const candidate = basename(dir) === 'node_modules'
      ? join(dir, name)
      : join(dir, 'node_modules', name)
    if (existsSync(candidate)) return realpathSync(candidate)
    const parent = resolve(dir, '..')
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Provider SDKs that @earendil-works/pi-ai ships as eager dependencies but
 * only ever imports through its lazy ./providers/* subpaths. The Web profile
 * mounts pi-ai dormant (zero routes until a llm-pi-ai settings section
 * configures a provider), so these ~120 MB of SDKs would only be dead weight
 * on every cold start; a user who configures a non-DeepSeek provider gets a
 * clear missing-dependency error instead. The only other closure member
 * referencing any of them (subagent-claude-code) is not part of the dsh
 * production closure.
 */
const EXCLUDED_DEPENDENCIES = [
  'openai',
  '@mistralai/mistralai',
  '@google/genai',
  '@aws-sdk',
  '@anthropic-ai/sdk',
  // shiki (and its @shikijs/* core) is the browser-side syntax highlighter:
  // the client bundle built by apps/web already inlines it, and the node half
  // of dsh-client-ui-primitives never imports it.
  'shiki',
  '@shikijs',
]

/** The dsh package's own entry: apps/cli resolves its deps from its own node_modules. */
const cliDir = realpathSync(join(repoRoot, 'apps', 'cli'))
const rootManifest = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8'))

/** Real source location → runtime copy location, so one version copies once. */
const realToCopy = new Map()
/** name → hoisted runtime path, for conflict detection. */
const hoistedBy = new Map()

function copyInto(sourceReal, destination) {
  if (existsSync(destination)) return
  mkdirSync(dirname(destination), { recursive: true })
  // Exclude nested node_modules: their links belong to the workspace install
  // and dereferencing them would materialize entire dependency trees inside
  // each copy. The closure walk places every dependency itself.
  cpSync(sourceReal, destination, {
    recursive: true,
    filter: source => {
      if (source === sourceReal) return true
      return !source.slice(sourceReal.length + 1).split('/').includes('node_modules')
    },
  })
  // node-pty ships prebuilt binaries for every platform; keep only the
  // current one so the installer does not carry ~57 MB of foreign builds.
  if (basename(sourceReal) === 'node-pty') {
    const prebuilds = join(destination, 'prebuilds')
    if (existsSync(prebuilds)) {
      for (const entry of readdirSync(prebuilds)) {
        if (entry !== `${process.platform}-${process.arch}`) {
          rmSync(join(prebuilds, entry), { recursive: true, force: true })
        }
      }
    }
  }
}

/** Decide where one dependency lands in the runtime and copy it there. */
function place(name, real, requirerName) {
  if (realToCopy.has(real)) return realToCopy.get(real)
  const hoisted = join(runtimeModules, name)
  const destination = !requirerName || !hoistedBy.has(name) || hoistedBy.get(name) === real
    ? hoisted
    : join(runtimeModules, requirerName, 'node_modules', name)
  if (destination === hoisted) hoistedBy.set(name, real)
  copyInto(real, destination)
  realToCopy.set(real, destination)
  return destination
}

/** Walk the production closure of the dsh package, copying as it goes. */
function assembleClosure() {
  const queue = [{ sourceDir: cliDir, requirerName: undefined, manifest: rootManifest }]
  // The workspace has dependency cycles (cordis ↔ cordis-plugin-include,
  // api-remotes ↔ gateway, ...); a visited set keeps the walk from looping.
  const visited = new Set([cliDir])
  while (queue.length > 0) {
    const { sourceDir, requirerName, manifest } = queue.shift()
    for (const [section, names] of [
      ['dependencies', manifest.dependencies ?? {}],
      ['peerDependencies', manifest.peerDependencies ?? {}],
      ['optionalDependencies', manifest.optionalDependencies ?? {}],
    ]) {
      for (const name of Object.keys(names)) {
        if (name.startsWith('node:')) continue
        if (EXCLUDED_DEPENDENCIES.some(excluded => name === excluded || name.startsWith(`${excluded}/`))) {
          continue
        }
        const real = resolveFrom(sourceDir, name)
        if (real === undefined) {
          // Optional deps are platform-cropped by the package manager: the
          // manifest names every platform's native build, but only the current
          // one is installed. Missing optionals are fine; a missing required or
          // peer dependency is a broken closure.
          if (section === 'optionalDependencies') continue
          throw new Error(`assemble-runtime: cannot resolve ${name} from ${sourceDir}`)
        }
        place(name, real, requirerName)
        if (visited.has(real)) continue
        visited.add(real)
        const nextManifest = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8'))
        queue.push({ sourceDir: real, requirerName: name, manifest: nextManifest })
      }
    }
  }
}

assembleClosure()

// The dsh package itself sits at the runtime root, matching the layout the
// shell resolves (dsh/lib/bin.js, dsh/config/ beside it; bin.js reads
// ../package.json for its version).
const dshDir = join(target, 'dsh')
cpSync(join(cliDir, 'lib'), join(dshDir, 'lib'), { recursive: true })
cpSync(join(cliDir, 'config'), join(dshDir, 'config'), { recursive: true })
cpSync(join(cliDir, 'package.json'), join(dshDir, 'package.json'))

const binPath = join(dshDir, 'lib', 'bin.js')
if (!existsSync(binPath)) {
  throw new Error(`assemble-runtime: dsh bin missing at ${binPath}; run pnpm run build first`)
}

console.log(`assemble-runtime: dsh runtime closure at ${target}`)
