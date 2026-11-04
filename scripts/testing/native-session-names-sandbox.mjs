#!/usr/bin/env node
// native-session-names-sandbox.mjs — the host-side wrapper for the required
// native session-names contract runner (unified-agent-names plan, Task 8).
//
// Validates a CLOSED input list (the five fixed roles below, optionally
// relocated by a version-1 manifest — never discovered, never installed),
// then runs the runner read-only inside an OWNED disposable
// versioned `freshell-sandbox` container. There is no skip/opt-in success
// state: exit 0 only when the Claude, Codex and OpenCode real metadata
// contracts all ran and passed; exit 1 for a contract failure (including a
// missing/skipped provider result); exit 2 for a missing prerequisite,
// reported BEFORE any Docker mutation (a missing image or prepared
// artifact fails before launch and is never improvised around).
//
// Container containment (all asserted by the unit tests):
//   - the image's normal npm-installing entrypoint is BYPASSED: the image's
//     own Node runs the mounted runner directly as the invoking non-root
//     user (numeric --user), with no root-node_modules cache and no
//     source-home/worktree configuration mount;
//   - `--network none` (a private network namespace with no external
//     egress), `--pids-limit`/`--memory` matching the sandbox defaults, and
//     a private PID namespace (`--rm` container it fully owns);
//   - only the prepared artifact/runner/fixed tools are mounted, READ-ONLY,
//     plus explicit writable scratch and receipt directories — no corpus,
//     credentials, or operator home is ever mounted;
//   - Docker argv is built as an argv ARRAY (never shell interpolation).

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..')

export const NATIVE_ROLES = Object.freeze([
  'claude-cli',
  'codex',
  'opencode',
  'runtime',
  'runner',
])

export const IMAGE_TAG = process.env.FRESHELL_SANDBOX_IMAGE || JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'docker/sandbox/protocol.json'), 'utf8')).image

/** The fixed host inputs (the plan's Step 3 table). An optional --manifest
 * may RELOCATE these inputs (absolute roots/entries), never widen the set
 * of tools or the discovery scope. */
export function fixedInputs(env = process.env) {
  const nodeModules = '/home/dan/.nvm/versions/node/v22.21.1/lib/node_modules'
  return [
    {
      role: 'claude-cli',
      root: `${nodeModules}/@anthropic-ai/claude-code`,
      entryRelativePath: 'bin/claude.exe',
      optionalEntry: true,
      containerMount: '/opt/freshell-native/claude-code',
    },
    {
      role: 'codex',
      root: `${nodeModules}/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl`,
      entryRelativePath: 'bin/codex',
      versionFile: 'codex-package.json',
      containerMount: '/opt/freshell-native/codex',
    },
    {
      role: 'opencode',
      root: `${nodeModules}/opencode-ai/node_modules/opencode-linux-x64`,
      entryRelativePath: 'bin/opencode',
      versionFile: 'package.json',
      containerMount: '/opt/freshell-native/opencode',
    },
    {
      role: 'runtime',
      root: path.join(REPO_ROOT, 'electron-runtime'),
      requiredFiles: [
        'bin/freshell-server',
        'client/index.html',
        'node/bin/node',
        'claude-sidecar/session-names.mjs',
        'claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk/package.json',
      ],
      containerMount: '/opt/freshell-runtime',
    },
    {
      role: 'runner',
      root: path.join(REPO_ROOT, 'scripts', 'testing'),
      entryRelativePath: 'native-session-names.mjs',
      containerMount: '/opt/freshell-native/native-session-names.mjs',
      mountFile: true,
    },
  ]
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

export class ManifestError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ManifestError'
  }
}

/** Validate a parsed --manifest document: a version-1 object whose inputs
 * cover EXACTLY the five roles, once each, with absolute roots and
 * non-escaping relative entries. Anything else is an exit-2 prerequisite
 * failure. */
export function parseManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManifestError('the manifest must be a JSON object')
  }
  if (value.version !== 1) {
    throw new ManifestError('the manifest version must be exactly 1')
  }
  if (!Array.isArray(value.inputs)) {
    throw new ManifestError('the manifest must carry an inputs array')
  }
  const seen = new Set()
  const inputs = []
  for (const entry of value.inputs) {
    if (!entry || typeof entry !== 'object') {
      throw new ManifestError('each manifest input must be an object')
    }
    if (typeof entry.role !== 'string' || !NATIVE_ROLES.includes(entry.role)) {
      throw new ManifestError(`unknown manifest role: ${JSON.stringify(entry.role)}`)
    }
    if (seen.has(entry.role)) {
      throw new ManifestError(`duplicate manifest role: ${entry.role}`)
    }
    seen.add(entry.role)
    if (typeof entry.root !== 'string' || !path.isAbsolute(entry.root)) {
      throw new ManifestError(`manifest role ${entry.role}: root must be an absolute path`)
    }
    if (entry.entryRelativePath !== undefined) {
      if (typeof entry.entryRelativePath !== 'string' || entry.entryRelativePath === '') {
        throw new ManifestError(`manifest role ${entry.role}: entryRelativePath must be a non-empty string`)
      }
      const resolved = path.resolve('/', entry.entryRelativePath)
      if (resolved !== `/${entry.entryRelativePath}` || entry.entryRelativePath.includes('..')) {
        throw new ManifestError(`manifest role ${entry.role}: entryRelativePath escapes its root`)
      }
    }
    if (entry.expectedVersion !== undefined && typeof entry.expectedVersion !== 'string') {
      throw new ManifestError(`manifest role ${entry.role}: expectedVersion must be a string`)
    }
    if (entry.expectedHash !== undefined && typeof entry.expectedHash !== 'string') {
      throw new ManifestError(`manifest role ${entry.role}: expectedHash must be a string`)
    }
    inputs.push({
      role: entry.role,
      root: entry.root,
      entryRelativePath: entry.entryRelativePath,
      expectedVersion: entry.expectedVersion,
      expectedHash: entry.expectedHash,
    })
  }
  const missing = NATIVE_ROLES.filter((role) => !seen.has(role))
  if (missing.length > 0) {
    throw new ManifestError(`the manifest is missing role(s): ${missing.join(', ')}`)
  }
  return { version: 1, inputs }
}

// ---------------------------------------------------------------------------
// Input validation (exit-2 class)
// ---------------------------------------------------------------------------

/** Validate the resolved inputs against the (injectable) filesystem.
 * Returns { problems, observed } — an empty problems list authorizes the
 * launch; every entry is the exact fixed role (or its manifest relocation). */
export function validateInputs(inputs, deps) {
  const problems = []
  const observed = { versions: {}, hashes: {} }
  if (deps.platform !== 'linux' || deps.arch !== 'x64') {
    problems.push(`the native smoke requires linux/x64 (host is ${deps.platform}/${deps.arch})`)
  }
  for (const input of inputs) {
    const root = input.root
    if (!deps.fs.existsSync(root)) {
      problems.push(`${input.role}: root does not exist: ${root}`)
      continue
    }
    const entryPath = input.entryRelativePath ? path.join(root, input.entryRelativePath) : null
    if (entryPath && !input.optionalEntry && !deps.fs.existsSync(entryPath)) {
      problems.push(`${input.role}: entry does not exist: ${entryPath}`)
    }
    for (const required of input.requiredFiles ?? []) {
      if (!deps.fs.existsSync(path.join(root, required))) {
        problems.push(`${input.role}: required file missing: ${path.join(root, required)}`)
      }
    }
    if (input.versionFile) {
      try {
        const raw = deps.fs.readFileSync(path.join(root, input.versionFile), 'utf8')
        observed.versions[input.role] = JSON.parse(raw).version ?? null
      } catch {
        problems.push(`${input.role}: could not read ${input.versionFile}`)
      }
    }
    if (input.expectedVersion !== undefined && observed.versions[input.role] !== undefined) {
      if (observed.versions[input.role] !== input.expectedVersion) {
        problems.push(
          `${input.role}: version mismatch — manifest expected ${input.expectedVersion}, found ${observed.versions[input.role]}`,
        )
      }
    }
    if (input.entryRelativePath && !input.optionalEntry) {
      try {
        const bytes = deps.fs.readFileSync(path.join(root, input.entryRelativePath))
        observed.hashes[`${input.role}:entry`] = createHash('sha256').update(bytes).digest('hex')
      } catch {
        // existence already reported above
      }
    }
    if (input.expectedHash !== undefined && observed.hashes[`${input.role}:entry`]) {
      if (observed.hashes[`${input.role}:entry`] !== input.expectedHash) {
        problems.push(`${input.role}: entry hash mismatch (expected ${input.expectedHash})`)
      }
    }
  }
  return { problems, observed }
}

// ---------------------------------------------------------------------------
// Docker argv construction (no shell interpolation, read-only mounts)
// ---------------------------------------------------------------------------

// The container-side fixed paths the runner consumes.
const CLAUDE_ROOT = '/opt/freshell-native/claude-code'
const CODEX_ROOT = '/opt/freshell-native/codex'
const OPENCODE_ROOT = '/opt/freshell-native/opencode'
const RUNTIME_ROOT = '/opt/freshell-runtime'
const RUNNER_PATH = '/opt/freshell-native/native-session-names.mjs'

/** The full in-container runner command (after the image name in argv). */
export function runnerArgs() {
  return [
    RUNNER_PATH,
    '--claude-root', CLAUDE_ROOT,
    '--codex-root', CODEX_ROOT,
    '--opencode-root', OPENCODE_ROOT,
    '--runtime-root', RUNTIME_ROOT,
    '--scratch', '/scratch',
    '--receipt', '/receipts/native-session-names.json',
  ]
}

/** The complete `docker` argv for the native smoke. */
export function nativeDockerArgv(inputs, dirs) {
  const byRole = new Map(inputs.map((input) => [input.role, input]))
  const argv = [
    'run',
    '--rm',
    '--network', 'none',
    '--pids-limit', '512',
    '--memory', '8g',
    '--user', `${dirs.uid}:${dirs.gid}`,
    '--entrypoint', '/usr/local/bin/node',
  ]
  const mounts = []
  for (const role of ['claude-cli', 'codex', 'opencode']) {
    const input = byRole.get(role)
    mounts.push([input.root, input.containerMount, 'ro'])
  }
  const runtime = byRole.get('runtime')
  mounts.push([runtime.root, RUNTIME_ROOT, 'ro'])
  const runner = byRole.get('runner')
  // Mount the PER-RUN STAGED COPY (dirs.runnerStagedPath), never the
  // repo file itself: WSL docker caches file-bind inodes across runs, and
  // an in-place runner edit otherwise keeps executing the STALE bytes
  // inside the container while the host sees the new code (observed
  // end-to-end). A fresh per-run path defeats the cache by construction.
  mounts.push([dirs.runnerStagedPath, RUNNER_PATH, 'ro'])
  mounts.push([dirs.scratchDir, '/scratch', 'rw'])
  mounts.push([dirs.receiptDir, '/receipts', 'rw'])
  for (const [source, target, mode] of mounts) {
    argv.push('-v', `${source}:${target}:${mode}`)
  }
  argv.push(IMAGE_TAG, ...runnerArgs())
  return argv
}

// ---------------------------------------------------------------------------
// Receipt classification
// ---------------------------------------------------------------------------

/** Classify an executed runner receipt. There is NO skip/opt-in success
 * state: a missing or failed provider result is a failure (exit 1). A
 * `not_measured` liveRedraw never fails the gate. */
export function classifyReceipt(document) {
  if (!document || typeof document !== 'object') {
    return { overall: 'fail', exitCode: 1, reason: 'the receipt is not an object' }
  }
  const providers = document.providers ?? {}
  for (const role of ['claude', 'codex', 'opencode']) {
    if (!providers[role]) {
      return { overall: 'fail', exitCode: 1, reason: `the ${role} provider contract did not run` }
    }
    if (providers[role].outcome !== 'pass') {
      return {
        overall: 'fail',
        exitCode: 1,
        reason: `the ${role} provider contract failed: ${providers[role].failure ?? providers[role].outcome}`,
      }
    }
  }
  return { overall: 'pass', exitCode: 0, reason: 'all three provider contracts passed' }
}

// ---------------------------------------------------------------------------
// The run (injectable boundaries)
// ---------------------------------------------------------------------------

export function defaultDeps() {
  return {
    platform: process.platform,
    arch: process.arch,
    fs,
    spawn: (file, argv, options) => spawn(file, argv, options),
    imageIdentity: async () => {
      const result = await new Promise((resolve) => {
        const child = spawn('docker', ['image', 'inspect', IMAGE_TAG, '--format', '{{.Id}}'])
        let stdout = ''
        child.stdout.on('data', (chunk) => { stdout += String(chunk) })
        child.on('close', (code) => resolve({ code, stdout: stdout.trim() }))
        child.on('error', () => resolve({ code: 1, stdout: '' }))
      })
      if (result.code !== 0 || !result.stdout) return null
      return result.stdout
    },
    uid: process.getuid?.(),
    gid: process.getgid?.(),
  }
}

/**
 * Run the native smoke end to end with injectable boundaries. Returns
 * { exitCode, overall, reason } and never throws for contract failures —
 * only unexpected infrastructure errors propagate.
 */
export async function runNativeSessionNamesSandbox(options = {}, deps = defaultDeps()) {
  const output = options.output ? path.resolve(options.output) : null
  if (!output) {
    return { exitCode: 2, reason: '--output <receipt-path> is required' }
  }
  fs.mkdirSync(path.dirname(output), { recursive: true })

  let inputs = fixedInputs()
  if (options.manifest) {
    let document
    try {
      document = JSON.parse(deps.fs.readFileSync(options.manifest, 'utf8'))
    } catch (error) {
      return { exitCode: 2, reason: `the manifest could not be read: ${error.message}` }
    }
    let manifest
    try {
      manifest = parseManifest(document)
    } catch (error) {
      return { exitCode: 2, reason: error.message }
    }
    // Relocate the fixed roles onto the manifest's roots (the set of tools
    // and the discovery scope never change).
    const byRole = new Map(manifest.inputs.map((entry) => [entry.role, entry]))
    inputs = inputs.map((input) => {
      const entry = byRole.get(input.role)
      const relocated = {
        ...input,
        root: entry.root,
        expectedVersion: entry.expectedVersion,
        expectedHash: entry.expectedHash,
      }
      if (entry.entryRelativePath !== undefined) relocated.entryRelativePath = entry.entryRelativePath
      return relocated
    })
  }

  const { problems, observed } = validateInputs(inputs, deps)
  if (problems.length > 0) {
    return { exitCode: 2, reason: `missing prerequisites:\n${problems.map((problem) => `  - ${problem}`).join('\n')}` }
  }

  const image = await deps.imageIdentity()
  if (!image) {
    return {
      exitCode: 2,
      reason: `the ${IMAGE_TAG} image is missing — report and stop; do not improvise a substitute`,
    }
  }

  // WSL-backed Docker squashes binds under /tmp to root:root 0700
  // in-container — the non-root runner user then cannot write its receipt
  // (EACCES observed end-to-end). FRESHELL_NATIVE_SMOKE_RUN_ROOT names the
  // run root DIRECTLY (the operator passes a unique per-run path;
  // home-tree binds keep the operator's ownership in the container).
  const runRoot = process.env.FRESHELL_NATIVE_SMOKE_RUN_ROOT
    ?? deps.fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-native-smoke-'))
  const scratchDir = path.join(runRoot, 'scratch')
  const receiptDir = path.join(runRoot, 'receipts')
  deps.fs.mkdirSync(scratchDir, { recursive: true })
  deps.fs.mkdirSync(receiptDir, { recursive: true })
  // The per-run runner copy (see nativeDockerArgv for the stale-file-bind
  // rationale). Copied from the repo's live file every run.
  const runnerSource = path.join(REPO_ROOT, 'scripts', 'testing', 'native-session-names.mjs')
  const runnerStagedPath = path.join(runRoot, 'native-session-names-runner.mjs')
  // The injected test seam may model the copy itself; the real host fs
  // is the default.
  ;(deps.fs.copyFileSync ?? fs.copyFileSync)(runnerSource, runnerStagedPath)
  try {
    deps.fs.chmodSync(runnerStagedPath, 0o777)
  } catch {
    // The injected test filesystem may not model chmod.
  }
  // Docker Desktop's WSL userns remap shifts container uid 1000 to a
  // DIFFERENT host uid — an operator-owned 0755 bind is then NOT writable
  // by the non-root runner (EACCES observed end-to-end). These two dirs
  // are disposable per-run mounts holding only the runner's own outputs;
  // open their mode so the non-root container user can always write.
  for (const dir of [scratchDir, receiptDir]) {
    try {
      deps.fs.chmodSync(dir, 0o777)
    } catch {
      // The injected test filesystem may not model chmod; the real host
      // path always supports it.
    }
  }

  const argv = nativeDockerArgv(inputs, {
    uid: deps.uid,
    gid: deps.gid,
    scratchDir,
    receiptDir,
    runnerStagedPath,
  })

  const dockerExit = await new Promise((resolve) => {
    const child = deps.spawn('docker', argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.on('data', (chunk) => process.stdout.write(chunk))
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk))
    child.on('error', (error) => resolve({ code: 1, error: error.message }))
    child.on('close', (code) => resolve({ code }))
  })

  const containerReceiptPath = path.join(receiptDir, 'native-session-names.json')
  let document = null
  if (deps.fs.existsSync(containerReceiptPath)) {
    try {
      document = JSON.parse(deps.fs.readFileSync(containerReceiptPath, 'utf8'))
    } catch {
      document = null
    }
  }
  const classified = classifyReceipt(document)
  if (document) {
    deps.fs.writeFileSync(output, `${JSON.stringify({ ...document, imageIdentity: image, inputs: { ...document.inputs, ...observed } }, null, 2)}\n`)
  } else {
    deps.fs.writeFileSync(output, `${JSON.stringify({
      version: 1,
      overall: 'fail',
      imageIdentity: image,
      dockerExitCode: dockerExit.code,
      reason: dockerExit.error ?? 'the runner produced no receipt',
      inputs: observed,
    }, null, 2)}\n`)
  }
  // The scratch cleanup is best-effort: the WSL userns remap presents
  // container-created entries host-side with modes the operator cannot
  // always remove (observed: a CLI-created 0700 subdir under the codex
  // home). Leftovers are per-run disposable noise under the operator's
  // run root — a cleanup failure must never mask the receipt.
  try {
    deps.fs.rmSync(scratchDir, { recursive: true, force: true })
  } catch (error) {
    process.stderr.write(`[native-session-names-sandbox] scratch cleanup left entries behind (${error.code ?? error.message})\n`)
  }
  if (classified.exitCode !== 0) {
    process.stderr.write(`[native-session-names-sandbox] ${classified.reason}\n`)
  }
  process.stderr.write(`[native-session-names-sandbox] receipt: ${output}\n`)
  return { ...classified, dockerExitCode: dockerExit.code, receiptPath: output }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function cliMain(argv = process.argv.slice(2)) {
  function argValue(name) {
    const index = argv.indexOf(name)
    if (index === -1 || index === argv.length - 1) return undefined
    return argv[index + 1]
  }
  const options = {
    manifest: argValue('--manifest'),
    output: argValue('--output'),
    requireAll: argv.includes('--require-all'),
  }
  if (!options.requireAll) {
    process.stderr.write('[native-session-names-sandbox] --require-all is mandatory: there is no skip/opt-in success state\n')
    process.exit(2)
  }
  const result = await runNativeSessionNamesSandbox(options, defaultDeps())
  process.exit(result.exitCode)
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  cliMain().catch((error) => {
    process.stderr.write(`[native-session-names-sandbox] unhandled failure: ${error?.stack ?? error}\n`)
    process.exit(1)
  })
}
