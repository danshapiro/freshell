import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runtimeCargoBuildAndCopy } from './runtime-cargo-artifacts.js'

export const RUNTIME_BUILD_MANIFEST_ENV = 'FRESHELL_RUNTIME_TEST_BUILD_MANIFEST'
export type RuntimeBinary = 'supervisor-test' | 'host-test' | 'supervisor-release' | 'host-release'
  | 'supervisor-qualification' | 'server-managed-provider-qualification' | 'server-managed-fresh-agent-fixtures'
export type RuntimeBuildRecipe = 'test-hosts' | 'release-hosts' | 'qualification-supervisor' | 'qualification-server' | 'fresh-fixture-server'
export type RuntimeBuildCommand = { program: string; args: string[] }

type BuildManifest = {
  version: 1
  repoRoot: string
  revision: string
  binaries: Partial<Record<RuntimeBinary, string>>
}

const recipes: Record<RuntimeBuildRecipe, { args: string[]; profile: string; outputs: Partial<Record<RuntimeBinary, string>> }> = {
  'test-hosts': {
    args: ['-p', 'freshell-supervisor', '-p', 'freshell-session-host', '--features', 'freshell-supervisor/runtime-test-faults,freshell-session-host/fresh-agent-fixtures'],
    profile: 'debug', outputs: { 'supervisor-test': 'freshell-supervisor', 'host-test': 'freshell-session-host' },
  },
  'release-hosts': {
    args: ['--release', '-p', 'freshell-supervisor', '-p', 'freshell-session-host'],
    profile: 'release', outputs: { 'supervisor-release': 'freshell-supervisor', 'host-release': 'freshell-session-host' },
  },
  'qualification-supervisor': {
    args: ['--release', '-p', 'freshell-supervisor', '--features', 'provider-qualification'],
    profile: 'release', outputs: { 'supervisor-qualification': 'freshell-supervisor' },
  },
  'qualification-server': {
    args: ['--release', '-p', 'freshell-server', '--features', 'managed-provider-qualification'],
    profile: 'release', outputs: { 'server-managed-provider-qualification': 'freshell-server' },
  },
  'fresh-fixture-server': {
    args: ['--release', '-p', 'freshell-server', '--features', 'managed-fresh-agent-fixtures'],
    profile: 'release', outputs: { 'server-managed-fresh-agent-fixtures': 'freshell-server' },
  },
}

/** Match discovered files, so focused unit runs and cloud images prepare nothing. */
export function runtimeBuildRecipesForFiles(repoRoot: string, files: string[], env: NodeJS.ProcessEnv): RuntimeBuildRecipe[] {
  const selected = new Set(files.map(file => path.relative(repoRoot, file).split(path.sep).join('/')))
  const contract = selected.has('test/integration/server/provider-parity-contract.test.ts')
  const terminal = contract || selected.has('test/integration/server/managed-provider-parity.test.ts')
  const fresh = contract || selected.has('test/integration/server/fresh-agent-parity.test.ts')
  const crash = env.FRESHELL_RUNTIME_PHASE3_STARTUP_CRASH_SMOKE === '1'
    && selected.has('test/integration/server/testing/runtime-phase3-startup-crash.real.test.ts')
  if (!terminal && !fresh && !crash) return []
  return [
    'test-hosts', 'release-hosts',
    ...(terminal ? ['qualification-supervisor', 'qualification-server'] as const : []),
    ...(fresh ? ['fresh-fixture-server'] as const : []),
  ]
}

function revision(repoRoot: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
}

function readManifest(repoRoot: string, env: NodeJS.ProcessEnv): BuildManifest | undefined {
  const file = env[RUNTIME_BUILD_MANIFEST_ENV]
  if (!file) return undefined
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as BuildManifest
  if (manifest.version !== 1 || manifest.repoRoot !== fs.realpathSync(repoRoot) || manifest.revision !== revision(repoRoot)) {
    throw new Error('prepared runtime build manifest belongs to another checkout or revision')
  }
  return manifest
}

export function preparedRuntimeBinary(repoRoot: string, binary: RuntimeBinary, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const manifest = readManifest(repoRoot, env)
  if (!manifest) return undefined
  const file = manifest.binaries[binary]
  if (!file) throw new Error(`runtime binary variant was not prepared: ${binary}`)
  if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) throw new Error(`prepared runtime binary is not a file: ${binary}`)
  fs.accessSync(file, fs.constants.X_OK)
  return file
}

export function hasPreparedRuntimeBuilds(repoRoot: string, selected: RuntimeBuildRecipe[], env: NodeJS.ProcessEnv): boolean {
  if (!readManifest(repoRoot, env)) return false
  for (const recipe of selected) for (const binary of Object.keys(recipes[recipe].outputs) as RuntimeBinary[]) {
    preparedRuntimeBinary(repoRoot, binary, env)
  }
  return true
}

/** Build before suite hooks and freeze each variant before Cargo overwrites it. */
export function prepareRuntimeBuilds(
  repoRoot: string,
  selected: RuntimeBuildRecipe[],
  { env = process.env, command = { program: path.join(os.homedir(), '.local/bin/mise'), args: ['exec', 'rust@1.96', '--', 'cargo'] } }: {
    env?: NodeJS.ProcessEnv
    command?: RuntimeBuildCommand
  } = {},
): { manifestPath: string; cleanup: () => void } {
  const root = fs.realpathSync(repoRoot)
  const directory = path.join(root, '.runtime-build', `preflight-${randomUUID()}`)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const manifest: BuildManifest = { version: 1, repoRoot: root, revision: revision(root), binaries: {} }
  const target = path.resolve(root, env.CARGO_TARGET_DIR || 'target')
  const jobs = Math.max(1, Math.min(3, Number.parseInt(env.CARGO_BUILD_JOBS || '3', 10) || 3))
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true })
  let activeRecipe: RuntimeBuildRecipe | undefined
  try {
    for (const name of selected) {
      activeRecipe = name
      const recipe = recipes[name]
      const started = Date.now()
      process.stderr.write(`${JSON.stringify({ severity: 'info', event: 'runtime_build.preflight.started', at: new Date().toISOString(), recipe: name })}\n`)
      const copies = Object.entries(recipe.outputs).map(([binary, crate]) => ({
        source: path.join(target, recipe.profile, `${crate}${process.platform === 'win32' ? '.exe' : ''}`),
        target: path.join(directory, `${binary}${process.platform === 'win32' ? '.exe' : ''}`),
      }))
      runtimeCargoBuildAndCopy(root, command.program, [...command.args, 'build', '--locked', ...recipe.args],
        copies, { ...env, CARGO_BUILD_JOBS: String(jobs) }, 900_000)
      for (const binary of Object.keys(recipe.outputs)) {
        const destination = path.join(directory, `${binary}${process.platform === 'win32' ? '.exe' : ''}`)
        manifest.binaries[binary as RuntimeBinary] = destination
      }
      process.stderr.write(`${JSON.stringify({ severity: 'info', event: 'runtime_build.preflight.completed', at: new Date().toISOString(), recipe: name, durationMs: Date.now() - started })}\n`)
    }
    const manifestPath = path.join(directory, 'manifest.json')
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 })
    return { manifestPath, cleanup }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ severity: 'error', event: 'runtime_build.preflight.failed', at: new Date().toISOString(), recipe: activeRecipe, error: String(error) })}\n`)
    cleanup()
    throw error
  }
}
