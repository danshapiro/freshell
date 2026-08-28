import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * A runtime surface is an executable or resource that must have one owner in
 * the retirement manifest.  Paths are repository-relative POSIX paths.  A
 * package-script surface uses `package.json:scripts` and lists its command
 * names in `entries`. The analyzer checks the behavior of the server/build
 * commands directly; unrelated script text is not treated as drift.
 */
export type RuntimeSurface = {
  id: string
  path: string
  role: string
  listener?: 'non-backend' | 'legacy-backend' | 'assertion-only'
  entries?: string[]
}

export type RuntimeSurfaceManifest = {
  version: 1
  surfaces: RuntimeSurface[]
}

export type RuntimeBoundaryAnalysis = {
  manifestDrift: string[]
  legacyDebt: string[]
  unexpectedNodeBackend: string[]
}

const MANIFEST_RELATIVE_PATH = 'scripts/retirement/runtime-surfaces.json'
const PACKAGE_SCRIPTS_PATH = 'package.json:scripts'

const ignoredDirectoryNames = new Set([
  '.git',
  '.claude',
  '.worktrees',
  'dist',
  'electron-runtime',
  'node_modules',
  'release',
  'target',
])

const ignoredPathPrefixes = [
  'docs/plans/',
  'docs/reports/',
  'docs/evidence/',
] as const

const sourceExtensions = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx'])

/**
 * These files are deliberately allowed to bind a local port.  They are test
 * coordination, fake targets, or probes; none owns Freshell PTYs or backend
 * state.  Keep this list exact instead of allowing an entire directory.
 */
export const NON_BACKEND_LISTENER_PATHS = [
  'scripts/testing/coordinator-endpoint.ts',
  'test/e2e-browser/helpers/echo-ws-fixture.ts',
  'test/e2e-browser/helpers/harness-06/target-server.ts',
  'test/e2e-browser/helpers/harness-06/update-feed.ts',
  'test/e2e-browser/helpers/harness-06/fake-ai.ts',
  'test/e2e-browser/fixtures/providers/fake-codex-app-server.mjs',
  'test/e2e-browser/fixtures/providers/fake-opencode-server.mjs',
  'test/e2e-browser/fixtures/fake-opencode.cjs',
  'scripts/proofs/browser-background-visibility-probe.ts',
  'scripts/proofs/browser-freeze-lifecycle-probe.ts',
  'scripts/proofs/browser-process-suspend-probe.ts',
  'electron/port-check.ts',
  'test/e2e-browser/helpers/server-fixture-support.ts',
  'examples/extensions/live-counter/server.js',
  'examples/extensions/status-dashboard/server.js',
  'test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs',
] as const

const nonBackendListenerPaths = new Set<string>(NON_BACKEND_LISTENER_PATHS)

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join('/').replace(/^\.\//, '')
}

function validateManifestPath(relativePath: string, id: string): string {
  const normalized = normalizeRelativePath(relativePath)
  if (
    path.posix.isAbsolute(normalized)
    || /^[A-Za-z]:\//.test(normalized)
    || normalized === '..'
    || normalized.startsWith('../')
  ) {
    throw new Error(`Runtime surface manifest row ${id} must use a repository-relative path.`)
  }
  return normalized
}

function isIgnoredRelativePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath)
  return ignoredPathPrefixes.some((prefix) => normalized.startsWith(prefix))
}

function isSourcePath(relativePath: string): boolean {
  return sourceExtensions.has(path.posix.extname(relativePath))
}

function isTestFilePath(relativePath: string): boolean {
  return /\.(?:test|spec)\.(?:cjs|js|jsx|mjs|ts|tsx)$/.test(relativePath)
}

function isExecutableMode(mode: number): boolean {
  return (mode & 0o111) !== 0
}

function isServiceResourcePath(relativePath: string): boolean {
  return relativePath.startsWith('installers/')
    && /\.(?:service|plist|xml)(?:\.template)?$/.test(relativePath)
}

function isContainerResourcePath(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath)
  return /^Dockerfile(?:\..*)?$/.test(basename)
    || (relativePath.startsWith('docker/') && /\.(?:yml|yaml)$/.test(relativePath))
}

function isReleaseJobPath(relativePath: string): boolean {
  return relativePath.startsWith('.github/workflows/') && /\.ya?ml$/.test(relativePath)
}

function isFixtureServerPath(relativePath: string): boolean {
  if (!relativePath.startsWith('test/')) return false
  const basename = path.posix.basename(relativePath)
  if (!/(?:^|[-_.])server(?:[-_.]|$)/i.test(basename)) return false
  if (!/\.(?:cjs|js|mjs|ts|tsx)$/.test(relativePath)) return false
  if (/\.(?:test|spec)\.(?:cjs|js|mjs|ts|tsx)$/.test(basename)) return false
  return relativePath.startsWith('test/fixtures/')
    || relativePath.startsWith('test/e2e-browser/helpers/')
}

function isExampleExtensionServerPath(relativePath: string): boolean {
  return /^examples\/extensions\/[^/]+\/server\.(?:cjs|js|mjs|ts|tsx)$/.test(relativePath)
}

/** Read and validate the manifest without allowing malformed rows to vanish. */
export async function loadRuntimeSurfaceManifest(root: string): Promise<RuntimeSurfaceManifest> {
  const manifestPath = path.join(root, ...MANIFEST_RELATIVE_PATH.split('/'))
  const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as Partial<RuntimeSurfaceManifest>
  if (raw.version !== 1 || !Array.isArray(raw.surfaces)) {
    throw new Error(`Runtime surface manifest must have version 1 and a surfaces array: ${manifestPath}`)
  }

  const surfaces: RuntimeSurface[] = []
  for (const [index, candidate] of raw.surfaces.entries()) {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error(`Runtime surface manifest row ${index} is not an object.`)
    }
    const row = candidate as Partial<RuntimeSurface>
    if (typeof row.id !== 'string' || !row.id || typeof row.path !== 'string' || !row.path || typeof row.role !== 'string' || !row.role) {
      throw new Error(`Runtime surface manifest row ${index} requires id, path, and role.`)
    }
    if (row.listener !== undefined && row.listener !== 'non-backend' && row.listener !== 'legacy-backend' && row.listener !== 'assertion-only') {
      throw new Error(`Runtime surface manifest row ${row.id} has an invalid listener role.`)
    }
    if (row.entries !== undefined && (!Array.isArray(row.entries) || row.entries.some((entry) => typeof entry !== 'string'))) {
      throw new Error(`Runtime surface manifest row ${row.id} has invalid entries.`)
    }
    const normalizedPath = validateManifestPath(row.path, row.id)
    if (normalizedPath === PACKAGE_SCRIPTS_PATH && row.entries === undefined) {
      throw new Error(`Runtime surface manifest package script row ${row.id} requires entries.`)
    }
    if (row.listener === 'assertion-only' && (
      row.role !== 'test-listener-assertion'
      || !normalizedPath.startsWith('test/')
      || !isTestFilePath(normalizedPath)
    )) {
      throw new Error(`Runtime surface manifest assertion-only row ${row.id} must classify a test implementation.`)
    }
    surfaces.push({
      id: row.id,
      path: normalizedPath,
      role: row.role,
      ...(row.listener ? { listener: row.listener } : {}),
      ...(row.entries ? { entries: [...row.entries].sort() } : {}),
    })
  }

  return { version: 1, surfaces }
}

async function walkFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    if (entry.isSymbolicLink() && entry.name === 'node_modules') continue
    if (entry.isDirectory() && ignoredDirectoryNames.has(entry.name)) continue

    const absolutePath = path.join(current, entry.name)
    const relativePath = normalizeRelativePath(path.relative(root, absolutePath))
    if (isIgnoredRelativePath(relativePath)) continue

    if (entry.isDirectory()) {
      files.push(...await walkFiles(root, absolutePath))
      continue
    }
    if (entry.isFile()) files.push(relativePath)
  }

  return files.sort()
}

/**
 * Discover launch/resource owners conservatively from executable bits and
 * known launch categories.  The closed manifest then supplies the ownership
 * decision; discovery must never silently accept a new executable.
 */
async function discoverOwners(root: string, allFiles: string[]): Promise<string[]> {
  const owners = new Set<string>()

  for (const relativePath of allFiles) {
    const absolutePath = path.join(root, ...relativePath.split('/'))
    const fileStat = await stat(absolutePath)
    const rootLauncher = !relativePath.includes('/') && relativePath.endsWith('.sh')
    const portBootstrap = relativePath.startsWith('port/')
      && /\.(?:sh|cmd|ps1)$/.test(relativePath)
    if (
      isExecutableMode(fileStat.mode)
      || rootLauncher
      || portBootstrap
      || isServiceResourcePath(relativePath)
      || isContainerResourcePath(relativePath)
      || isReleaseJobPath(relativePath)
      || isFixtureServerPath(relativePath)
      || isExampleExtensionServerPath(relativePath)
    ) {
      owners.add(relativePath)
    }
    if (nonBackendListenerPaths.has(relativePath)) owners.add(relativePath)
  }

  const packagePath = path.join(root, 'package.json')
  try {
    const packageContents = await readFile(packagePath, 'utf8')
    const packageJson = JSON.parse(packageContents) as { scripts?: unknown }
    if (packageJson.scripts && typeof packageJson.scripts === 'object') {
      owners.add(PACKAGE_SCRIPTS_PATH)
    }
  } catch {
    // A synthetic tree may intentionally omit package.json.
  }

  return [...owners].sort()
}

function rowPath(row: RuntimeSurface): string {
  return normalizeRelativePath(row.path)
}

async function pathExists(root: string, relativePath: string): Promise<boolean> {
  try {
    await stat(path.join(root, ...relativePath.split('/')))
    return true
  } catch {
    return false
  }
}

type PackageScripts = Record<string, string>

async function packageScripts(root: string): Promise<PackageScripts | undefined> {
  try {
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { scripts?: unknown }
    if (!packageJson.scripts || typeof packageJson.scripts !== 'object' || Array.isArray(packageJson.scripts)) return undefined
    const entries = Object.entries(packageJson.scripts as Record<string, unknown>)
    if (entries.some(([, command]) => typeof command !== 'string')) return undefined
    return Object.fromEntries(entries) as PackageScripts
  } catch {
    return undefined
  }
}

type ShellToken = {
  value: string
  separator: boolean
  quoted: boolean
}

/**
 * Tokenize enough shell syntax to inspect package commands without executing
 * them. Quotes are removed, escaped path separators are retained, and shell
 * command separators prevent a later command from being attributed to an
 * earlier Node invocation.
 */
function tokenizeShellCommand(command: string): ShellToken[] {
  const tokens: ShellToken[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let currentWasQuoted = false

  const flush = (): void => {
    if (current.length > 0) {
      tokens.push({ value: current, separator: false, quoted: currentWasQuoted })
      current = ''
      currentWasQuoted = false
    }
  }

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]

    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined
      } else if (character === '\\' && quote === '"' && index + 1 < command.length) {
        const next = command[index + 1]
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          current += next
          index += 1
        } else {
          current += character
        }
      } else {
        current += character
      }
      continue
    }

    if (character === '"' || character === "'") {
      quote = character
      currentWasQuoted = true
      continue
    }

    if (character === '\\' && index + 1 < command.length) {
      const next = command[index + 1]
      if (/\s/.test(next) || next === '"' || next === "'" || next === '\\') {
        current += next
        index += 1
      } else {
        // Keep Windows path separators and other non-shell escapes intact.
        current += character
      }
      continue
    }

    if (/\s/.test(character)) {
      flush()
      continue
    }

    if (character === ';' || character === '&' || character === '|' || character === '(' || character === ')') {
      flush()
      const next = command[index + 1]
      if ((character === '&' || character === '|') && next === character) index += 1
      tokens.push({ value: character, separator: true, quoted: false })
      continue
    }

    current += character
  }

  flush()
  return tokens
}

function isRetiredNodeBackendPath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/')
  return /(?:^|\/)(?:(?:dist|build)\/)?server\/index(?:\.[cm]?[jt]sx?)?$/i.test(normalized)
}

const NODE_RUNTIME_COMMAND = /(?:^|\/)(?:node|tsx)(?:\.(?:cmd|exe))?$/i
const CONCURRENTLY_COMMAND = /(?:^|\/)concurrently(?:\.(?:cmd|exe))?$/i
const SHELL_COMMAND = /(?:^|\/)(?:sh|bash|zsh|dash|ksh|fish|cmd|powershell|pwsh)(?:\.(?:cmd|exe))?$/i

function isShellCommandFlag(value: string): boolean {
  return value === '-c'
    || value === '--command'
    || /^-[a-z]*c$/i.test(value)
    || /^\/c$/i.test(value)
}

function containsRetiredNodeBackendCommand(command: string, depth = 0): boolean {
  if (depth > 4) return false

  let nodeRuntimeCommand = false
  let concurrentCommand = false
  let shellCommand = false
  let inspectNextQuotedCommand = false

  for (const token of tokenizeShellCommand(command)) {
    if (token.separator) {
      nodeRuntimeCommand = false
      concurrentCommand = false
      shellCommand = false
      inspectNextQuotedCommand = false
      continue
    }

    if (nodeRuntimeCommand) {
      if (isRetiredNodeBackendPath(token.value)) return true
      continue
    }

    const normalized = token.value.replace(/\\/g, '/')
    if (NODE_RUNTIME_COMMAND.test(normalized)) {
      nodeRuntimeCommand = true
      continue
    }

    if (shellCommand) {
      shellCommand = false
      inspectNextQuotedCommand = isShellCommandFlag(token.value)
      continue
    }

    if (SHELL_COMMAND.test(normalized)) {
      shellCommand = true
      continue
    }

    if (concurrentCommand && token.quoted) {
      if (containsRetiredNodeBackendCommand(token.value, depth + 1)) return true
      continue
    }

    if (inspectNextQuotedCommand) {
      inspectNextQuotedCommand = false
      if (token.quoted && containsRetiredNodeBackendCommand(token.value, depth + 1)) return true
    }

    if (CONCURRENTLY_COMMAND.test(normalized)) {
      concurrentCommand = true
    }
  }

  return false
}

const RETIRED_NODE_BACKEND_COMMAND = (command: string): boolean => (
  containsRetiredNodeBackendCommand(command)
)

const REQUIRED_RUST_SCRIPT_BEHAVIORS: Readonly<Record<string, (command: string) => boolean>> = {
  start: (command) => command.includes('scripts/start-rust-server.ts')
    && command.includes('target/release/freshell-server')
    && !RETIRED_NODE_BACKEND_COMMAND(command),
  dev: (command) => command.includes('cargo run -p freshell-server --locked')
    && !RETIRED_NODE_BACKEND_COMMAND(command),
  'dev:server': (command) => command.includes('cargo run -p freshell-server --locked')
    && !RETIRED_NODE_BACKEND_COMMAND(command),
  build: (command) => command.includes('build:client')
    && command.includes('build:tools')
    && command.includes('build:rust')
    && !RETIRED_NODE_BACKEND_COMMAND(command),
  'test:source-runtime': (command) => command.includes('scripts/testing/run-source-runtime-tests.ts')
    && !RETIRED_NODE_BACKEND_COMMAND(command),
}

function packageScriptBehaviorDrift(scripts: PackageScripts, expectedNames: readonly string[]): string[] {
  const drift: string[] = []
  for (const [name, requirement] of Object.entries(REQUIRED_RUST_SCRIPT_BEHAVIORS)) {
    if (!expectedNames.includes(name)) {
      drift.push(`manifest missing required package script: ${name}`)
    }
    const command = scripts[name]
    if (command === undefined || !requirement(command)) {
      drift.push(`invalid package script behavior: ${name}`)
    }
  }
  for (const [name, command] of Object.entries(scripts)) {
    if (RETIRED_NODE_BACKEND_COMMAND(command)) {
      drift.push(`retired Node backend command: package.json:scripts.${name}`)
    }
  }
  return drift
}

async function reconcileManifest(root: string, manifest: RuntimeSurfaceManifest, discoveredOwners: string[]): Promise<string[]> {
  const drift: string[] = []
  const rowsByPath = new Map<string, RuntimeSurface[]>()

  for (const row of manifest.surfaces) {
    const normalizedPath = rowPath(row)
    const rows = rowsByPath.get(normalizedPath) ?? []
    rows.push(row)
    rowsByPath.set(normalizedPath, rows)
  }

  for (const [relativePath, rows] of rowsByPath) {
    if (rows.length > 1) {
      const ids = rows.map((row) => row.id).sort().join(', ')
      drift.push(`duplicate ownership: ${relativePath} (${ids})`)
    }
  }

  for (const row of manifest.surfaces) {
    const relativePath = rowPath(row)
    if (relativePath === PACKAGE_SCRIPTS_PATH) {
      const scripts = await packageScripts(root)
      const actualNames = scripts ? Object.keys(scripts).sort() : []
      const expectedNames = row.entries ?? []
      const expected = new Set(expectedNames)
      for (const name of actualNames) {
        if (!expected.has(name)) drift.push(`unlisted owner: package.json:scripts.${name}`)
      }
      for (const name of expectedNames) {
        if (!actualNames.includes(name)) drift.push(`stale manifest row: package.json:scripts.${name}`)
      }
      if (!await pathExists(root, 'package.json')) {
        drift.push(`stale manifest row: ${row.id} -> ${relativePath}`)
      } else if (scripts === undefined) {
        drift.push(`invalid package script commands: ${row.id}`)
      } else {
        drift.push(...packageScriptBehaviorDrift(scripts, expectedNames))
      }
      continue
    }

    if (!await pathExists(root, relativePath)) {
      drift.push(`stale manifest row: ${row.id} -> ${relativePath}`)
    }
  }

  for (const owner of discoveredOwners) {
    const rows = rowsByPath.get(owner) ?? []
    if (rows.length === 0) drift.push(`unlisted owner: ${owner}`)
  }

  return drift
}

function hasListenerCapability(contents: string): boolean {
  // Require an actual networking/listener API rather than treating every
  // object with a `server` property as a backend.  Comments are intentionally
  // retained: a newly documented launch path should still be reviewed.
  return /(?:\b(?:http|https|net|tls)\.createServer\s*\(|\bcreateServer\s*\(|\bnew\s+WebSocketServer\b|\.listen\s*\(|\bserver\.listen\s*\()/.test(contents)
}

function isCapabilityScanPath(relativePath: string): boolean {
  // Source need not be executable to be launched by a manifest-listed package
  // command. Scan every non-ignored Node source file so a root launcher target
  // (or a target in a future source directory) cannot evade the boundary.
  return !isIgnoredRelativePath(relativePath) && isSourcePath(relativePath)
}

function isReviewedAssertionOnlyListener(row: RuntimeSurface | undefined, relativePath: string): boolean {
  return row?.listener === 'assertion-only'
    && row.role === 'test-listener-assertion'
    && relativePath.startsWith('test/')
    && isTestFilePath(relativePath)
}

async function detectUnexpectedNodeBackend(
  root: string,
  allFiles: string[],
  manifest: RuntimeSurfaceManifest,
): Promise<string[]> {
  const unexpected: string[] = []
  const rowsByPath = new Map(manifest.surfaces.map((row) => [rowPath(row), row]))

  for (const relativePath of allFiles) {
    if (!isCapabilityScanPath(relativePath)) continue
    const contents = await readFile(path.join(root, ...relativePath.split('/')), 'utf8')
    if (!hasListenerCapability(contents)) continue

    const row = rowsByPath.get(relativePath)
    // The allowlist is intentionally closed.  A manifest row cannot broaden
    // it by relabeling an arbitrary listener as non-backend.
    if (nonBackendListenerPaths.has(relativePath)) continue
    if (row?.listener === 'legacy-backend') continue
    if (isReviewedAssertionOnlyListener(row, relativePath)) continue
    unexpected.push(relativePath)
  }

  return unexpected.sort()
}

function detectLegacyDebt(manifest: RuntimeSurfaceManifest): string[] {
  // Legacy debt is executable/runtime evidence only. Every legacy backend
  // listener must remain explicitly visible in the manifest until it is
  // retired; there is no prose or path allowlist that can silently preserve
  // one after the final Rust cutover.
  return manifest.surfaces
    .filter((row) => row.listener === 'legacy-backend')
    .map(rowPath)
    .sort()
}

/**
 * Reconcile the checked-in runtime surface inventory and return deterministic
 * evidence for the three retirement gates.  This function is read-only and
 * never contacts a server, starts a process, or reads environment secrets.
 */
export async function analyzeRuntimeBoundary(root: string): Promise<RuntimeBoundaryAnalysis> {
  const normalizedRoot = path.resolve(root)
  const manifest = await loadRuntimeSurfaceManifest(normalizedRoot)
  const allFiles = await walkFiles(normalizedRoot)
  const discoveredOwners = await discoverOwners(normalizedRoot, allFiles)

  const [manifestDrift, legacyDebt, unexpectedNodeBackend] = await Promise.all([
    reconcileManifest(normalizedRoot, manifest, discoveredOwners),
    detectLegacyDebt(manifest),
    detectUnexpectedNodeBackend(normalizedRoot, allFiles, manifest),
  ])

  return {
    manifestDrift: [...new Set(manifestDrift)].sort(),
    legacyDebt: [...new Set(legacyDebt)].sort(),
    unexpectedNodeBackend: [...new Set(unexpectedNodeBackend)].sort(),
  }
}
