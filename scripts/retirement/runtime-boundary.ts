import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * A runtime surface is an executable or resource that must have one owner in
 * the retirement manifest.  Paths are repository-relative POSIX paths.  A
 * package-script surface uses `package.json:scripts` and lists its command
 * names in `entries` so adding a command is visible as manifest drift.
 */
export type RuntimeSurface = {
  id: string
  path: string
  role: string
  listener?: 'non-backend' | 'legacy-backend'
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
  'node_modules',
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
] as const

const nonBackendListenerPaths = new Set<string>(NON_BACKEND_LISTENER_PATHS)

const legacyDebtChecks: Array<{
  relativePath: string
  marker: string
  matches: (contents: string) => boolean
}> = [
  {
    relativePath: 'server/index.ts',
    marker: 'server/index.ts',
    matches: () => true,
  },
  {
    relativePath: 'package.json',
    marker: 'package.json:scripts.start',
    matches: (contents) => {
      try {
        const pkg = JSON.parse(contents) as { scripts?: Record<string, unknown> }
        return typeof pkg.scripts?.start === 'string' && /dist\/server|server\/index\.(?:ts|js)/.test(pkg.scripts.start)
      } catch {
        return false
      }
    },
  },
  {
    relativePath: 'config/electron-builder.yml',
    marker: 'config/electron-builder.yml:dist/server',
    matches: (contents) => contents.includes('dist/server'),
  },
  {
    relativePath: 'test/e2e-browser/playwright.config.ts',
    marker: 'test/e2e-browser/playwright.config.ts:legacy-chromium',
    matches: (contents) => contents.includes('legacy-chromium'),
  },
  {
    relativePath: 'run-rust-server.sh',
    marker: 'run-rust-server.sh:legacy-comment',
    matches: (contents) => /^\s*#.*\bLegacy server:/im.test(contents),
  },
  {
    relativePath: 'port/laptop-bootstrap/2-bootstrap-wsl.sh',
    marker: 'port/laptop-bootstrap/2-bootstrap-wsl.sh:inherited-build-path',
    matches: (contents) => /npm run build/.test(contents),
  },
]

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
    if (row.listener !== undefined && row.listener !== 'non-backend' && row.listener !== 'legacy-backend') {
      throw new Error(`Runtime surface manifest row ${row.id} has an invalid listener role.`)
    }
    if (row.entries !== undefined && (!Array.isArray(row.entries) || row.entries.some((entry) => typeof entry !== 'string'))) {
      throw new Error(`Runtime surface manifest row ${row.id} has invalid entries.`)
    }
    surfaces.push({
      id: row.id,
      path: validateManifestPath(row.path, row.id),
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

async function packageScriptNames(root: string): Promise<string[]> {
  try {
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { scripts?: unknown }
    if (!packageJson.scripts || typeof packageJson.scripts !== 'object') return []
    return Object.keys(packageJson.scripts as Record<string, unknown>).sort()
  } catch {
    return []
  }
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
      const actualNames = await packageScriptNames(root)
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
  if (isIgnoredRelativePath(relativePath) || !isSourcePath(relativePath)) return false
  if (relativePath.startsWith('test/')) return nonBackendListenerPaths.has(relativePath)
  return [
    'config/',
    'crates/',
    'electron/',
    'port/',
    'scripts/',
    'server/',
    'shared/',
    'src/',
    'tools/',
  ].some((prefix) => relativePath.startsWith(prefix))
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
    unexpected.push(relativePath)
  }

  return unexpected.sort()
}

async function detectLegacyDebt(root: string): Promise<string[]> {
  const debt: string[] = []
  for (const check of legacyDebtChecks) {
    const absolutePath = path.join(root, ...check.relativePath.split('/'))
    try {
      const contents = await readFile(absolutePath, 'utf8')
      if (check.matches(contents)) debt.push(check.marker)
    } catch {
      // A later retirement task may remove the legacy path entirely.
    }
  }
  return debt.sort()
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
    detectLegacyDebt(normalizedRoot),
    detectUnexpectedNodeBackend(normalizedRoot, allFiles, manifest),
  ])

  return {
    manifestDrift: [...new Set(manifestDrift)].sort(),
    legacyDebt: [...new Set(legacyDebt)].sort(),
    unexpectedNodeBackend: [...new Set(unexpectedNodeBackend)].sort(),
  }
}
