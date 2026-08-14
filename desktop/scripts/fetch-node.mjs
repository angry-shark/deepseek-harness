#!/usr/bin/env node
/**
 * Download the Node.js binary that the packaged desktop app bundles as the
 * harness runtime, into desktop/build/node/. The Tauri shell spawns this
 * binary (not an embedded one) with `--expose-internals`, so the download
 * must be verifiable: the SHASUMS256.txt file from the same mirror is checked,
 * and the extracted binary must report a version inside the harness engine
 * floor (^22.19 || >=24).
 *
 * The mirror defaults to the npmmirror CDN because the upstream nodejs.org
 * distribution is slow from CN networks; NODE_MIRROR overrides it. NODE_VERSION
 * overrides the pinned version.
 */

import { createHash } from 'node:crypto'
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NODE_VERSION = process.env.NODE_VERSION ?? '24.14.0'
const NODE_MIRROR = process.env.NODE_MIRROR ?? 'https://npmmirror.com/mirrors/node/'
const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const targetDir = join(repoRoot, 'desktop', 'build', 'node')
const platform = process.argv[2] === undefined ? process.platform : process.argv[2]

/** The harness engine floor, mirroring desktop/src-tauri/src/server.rs. */
function satisfiesNodeEngine(version) {
  const match = /^v(\d+)\.(\d+)\.(\d+)/u.exec(version.trim())
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major === 22 ? minor >= 19 : major >= 24
}

/** nodejs.org dist platform and archive names for one host platform. */
function distNames(platform) {
  const os = platform === 'win32' ? 'win' : platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const ext = platform === 'win32' ? 'zip' : 'tar.gz'
  return { os, arch, ext }
}

async function download(url, file) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`fetch ${url}: HTTP ${response.status}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file))
}

async function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

const { os, arch, ext } = distNames(platform)
const versionDir = `v${NODE_VERSION}`
const archiveName = platform === 'win32'
  ? `node-v${NODE_VERSION}-win-${arch}.${ext}`
  : `node-v${NODE_VERSION}-${os}-${arch}.${ext}`
const archiveUrl = `${NODE_MIRROR}${versionDir}/${archiveName}`
const sumsUrl = `${NODE_MIRROR}${versionDir}/SHASUMS256.txt`
const binaryName = platform === 'win32' ? 'node.exe' : 'node'

rmSync(targetDir, { recursive: true, force: true })
mkdirSync(targetDir, { recursive: true })
const archiveFile = join(targetDir, archiveName)

console.log(`fetch-node: downloading ${archiveUrl}`)
await download(archiveUrl, archiveFile)
console.log(`fetch-node: downloading ${sumsUrl}`)
const sums = await (await fetch(sumsUrl, { redirect: 'follow' })).text()

const expected = sums
  .split('\n')
  .map((line) => line.trim())
  .find((line) => line.endsWith(archiveName))
if (expected === undefined) throw new Error(`fetch-node: ${archiveName} missing from SHASUMS256.txt`)
const actual = await sha256(archiveFile)
if (!expected.startsWith(actual)) {
  throw new Error(`fetch-node: sha256 mismatch for ${archiveName}: expected ${expected.split(' ')[0]}, got ${actual}`)
}
console.log('fetch-node: sha256 ok')

if (ext === 'zip') {
  const result = spawnSync('tar', ['-xf', archiveFile, '-C', targetDir], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`fetch-node: extracting ${archiveName} failed`)
} else {
  const result = spawnSync('tar', ['-xzf', archiveFile, '-C', targetDir], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`fetch-node: extracting ${archiveName} failed`)
}

const extractedDir = join(
  targetDir,
  platform === 'win32' ? `node-v${NODE_VERSION}-win-${arch}` : `node-v${NODE_VERSION}-${os}-${arch}`,
)
const final = join(targetDir, binaryName)
renameSync(join(extractedDir, platform === 'win32' ? binaryName : join('bin', binaryName)), final)
rmSync(extractedDir, { recursive: true, force: true })
if (platform !== 'win32') chmodSync(final, 0o755)

const version = execFileSync(final, ['--version'], { encoding: 'utf8' }).trim()
if (version !== `v${NODE_VERSION}`) throw new Error(`fetch-node: extracted ${final} reports ${version}, expected v${NODE_VERSION}`)
if (!satisfiesNodeEngine(version)) throw new Error(`fetch-node: ${version} is below the harness engine floor (^22.19 || >=24)`)

rmSync(join(targetDir, archiveName), { force: true })
console.log(`fetch-node: ${final} (${version})`)
