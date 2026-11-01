import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runtimeCargoCommand } from '../../../scripts/testing/runtime-cargo-artifacts.js'

import {
  readProviderParityReceipt,
  writeProviderParityRow,
  type ProviderParityReceipt,
  type ProviderParityRow,
  type ProviderVisibleTrace,
} from '../../../scripts/testing/provider-parity-receipt.js'

const terminalProviders = ['claude', 'codex', 'opencode', 'amplifier'] as const
const freshProviders = ['claude', 'codex', 'opencode'] as const

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeFixtureRow(directory: string, row: ProviderParityRow): void {
  const serialized = JSON.stringify(row)
  for (const sentinel of ['nested-secret-byte', 'fixture-secret-byte']) {
    if (serialized.includes(sentinel)) throw new Error(`${row.caseId} emitted secret fixture bytes`)
  }
  writeProviderParityRow(directory, row)
}

async function run(command: string, args: string[], cwd: string, evidenceDir: string): Promise<void> {
  // These Cargo tests also publish ordinary session-host executables. Share
  // the runtime builder's lock so they cannot replace a feature build between
  // its compilation and its run-private snapshot.
  const sandboxed = command === 'cargo' && args[0] === 'test' && process.env.FRESHELL_RUST_TEST_SANDBOX === '1'
  const executable = sandboxed
    ? { command: path.join(cwd, 'scripts/sandbox-test.sh'), args: ['--runtime-suite', cargoSandboxCommand(cwd, args, evidenceDir)] }
    : command === 'cargo' ? runtimeCargoCommand(cwd, command, args) : { command, args }
  const child = spawn(executable.command, executable.args, {
    cwd,
    env: { ...process.env, FRESHELL_PROVIDER_PARITY_ROWS_DIR: evidenceDir,
      ...(sandboxed ? { FRESHELL_SANDBOX_OWNER_GUARD: '1' } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const capture = (chunk: Buffer) => { output = `${output}${chunk}`.slice(-40_000) }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  if (sandboxed) {
    child.stdout.pipe(process.stdout, { end: false })
    child.stderr.pipe(process.stderr, { end: false })
  }
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', value => resolve(value ?? 1))
  })
  if (code !== 0) throw new Error(`${command} ${args.join(' ')} failed (${code}):\n${output}`)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function cargoSandboxCommand(repoRoot: string, args: string[], evidenceDir: string): string {
  const relativeRows = path.relative(repoRoot, evidenceDir)
  if (path.isAbsolute(relativeRows) || relativeRows === '..' || relativeRows.startsWith(`..${path.sep}`)) {
    throw new Error('Sandbox parity rows must remain in the owned checkout directory')
  }
  const guestRows = path.posix.join('/workspace', ...relativeRows.split(path.sep))
  const target = `/freshell-test-artifacts/targets/${createHash('sha256').update(repoRoot).digest('hex').slice(0, 12)}`
  return `set -e
test "$FRESHELL_SANDBOX_MODE" = runtime-suite
owned_tmp="$(mktemp -d /freshell-test-artifacts/XXX)"
trap 'rm -rf -- "$owned_tmp"' EXIT
export TMPDIR="$owned_tmp" FRESHELL_TEST_EXECUTABLE_TMP_DIR="$owned_tmp"
export CARGO_TARGET_DIR=${shellQuote(target)} CARGO_BUILD_JOBS=3 RUST_TEST_THREADS=4 TOKIO_WORKER_THREADS=2 FRESHELL_RUST_TEST_SANDBOX=0
export FRESHELL_PROVIDER_PARITY_ROWS_DIR=${shellQuote(guestRows)}
printf '{"severity":"info","event":"provider_parity.rust_sandbox_started","mode":"runtime-suite"}\\n'
${['cargo', 'test', '--locked', ...args.slice(1)].map(shellQuote).join(' ')}
`
}

function terminalTrace(record: any, route: 'direct' | 'managed'): ProviderVisibleTrace {
  const launch = record[route].launch
  const mcp = record[route].mcp
  if (mcp.error && mcp.error !== 'missing_recipe') {
    throw new Error(`${record.provider} ${route} MCP operation failed: ${mcp.error}`)
  }
  const plugins = [launch.providerPlugin, launch.projectPlugin]
    .filter((value): value is string => typeof value === 'string')
  return {
    provider: record.provider,
    argv: launch.argv,
    env: launch.env,
    config: {
      providerConfig: launch.providerConfig,
      projectedProjectConfig: launch.projectedProjectConfig,
      projectConfig: launch.projectConfig,
      tuiConfig: launch.tuiConfig,
      inlineConfig: launch.inlineConfig,
    },
    plugins,
    mcp: mcp.error
      ? { exposed: false, tools: [], call: null }
      : { exposed: true, tools: mcp.tools, call: mcp.call },
    operations: mcp.error ? ['create', 'send', 'mcp.absent'] : ['create', 'send', 'mcp.list', 'mcp.call'],
    nativeSessionId: '<provider-session-id>',
  }
}

function freshTrace(record: any, route: 'direct' | 'managed'): ProviderVisibleTrace {
  const observed = record[route]
  const profile = observed.profile
  const createRequest = observed.operations.find((row: any) => row.operation === 'provider_create_request')?.input
  const transportStart = observed.operations.find((row: any) => row.operation === 'create_resume')?.input
  if (!createRequest || !transportStart || !Array.isArray(transportStart.providerSecretReferences)
    || transportStart.providerSecretReferences.length === 0) {
    throw new Error(`${record.provider} ${route} has no provider transport input evidence`)
  }
  return {
    provider: record.provider,
    // This deterministic fresh fixture observes the provider transport call.
    // Keep every start field; JSON object key order has no meaning here.
    argv: ['transport.start', ...Object.entries(transportStart)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)],
    env: {
      providerSecretReferences: transportStart.providerSecretReferences,
      providerLaunchContext: transportStart.providerLaunchContext,
    },
    config: {
      cwd: profile.cwd,
      model: profile.model,
      effort: profile.effort,
      permissionMode: profile.permissionMode,
      sandbox: profile.sandbox,
      modelSelection: profile.modelSelection,
      providerLaunchContext: profile.providerLaunchContext,
      providerSecretReferences: profile.providerSecretReferences,
    },
    plugins: profile.plugins ?? [],
    mcp: { exposed: observed.mcpExposed, tools: [], call: null },
    operations: observed.operations,
    nativeSessionId: profile.nativeSessionId,
  }
}

export async function runProviderParityFixture(repoRoot: string, eventsTarget?: string): Promise<ProviderParityReceipt> {
  // dist is ignored, traversable and unshadowed by the sandbox's cache mounts.
  // Rootless Docker maps the guest UID separately; only this run's synthetic
  // output directory needs cross-UID writes. Private input directories stay sealed.
  const sandboxed = process.env.FRESHELL_RUST_TEST_SANDBOX === '1'
  const base = sandboxed ? path.join(repoRoot, 'dist') : os.tmpdir()
  fs.mkdirSync(base, { recursive: true })
  const directory = fs.mkdtempSync(path.join(base, 'freshell-provider-parity-'))
  try {
    if (sandboxed) fs.chmodSync(directory, 0o777)
    await run('cargo', ['test', '-p', 'freshell-session-host', 'direct_and_hosted_provider_transport_operations_have_matching_rows'], repoRoot, directory)
    await run('cargo', ['test', '-p', 'freshell-runtime-protocol', 'raw_secret_payload_and_unapproved_config_paths_are_rejected'], repoRoot, directory)
    await run('cargo', ['test', '-p', 'freshell-runtime-protocol', 'onecli_profiles_match_only_their_named_provider'], repoRoot, directory)
    await run('cargo', ['test', '-p', 'freshell-session-host', 'provider_secret_profiles_accept_only_their_provider_and_keep_controls_out_of_child'], repoRoot, directory)
    // The outer integration test or runtime gate already owns coordination.
    await run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
      'test/integration/server/fresh-agent-parity.test.ts',
      '--testNamePattern', 'retains create settings and exact native resume',
      '--config', 'config/vitest/vitest.config.ts'], repoRoot, directory)
    await run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
      'test/integration/server/managed-provider-parity.test.ts',
      '--testNamePattern', 'preserves provider-visible launch and MCP behavior',
      '--config', 'config/vitest/vitest.config.ts'], repoRoot, directory)
    for (const provider of terminalProviders) {
      const record = readJson(path.join(directory, `terminal-${provider}.json`))
      const row: ProviderParityRow = {
        caseId: `PC-PARITY-${provider.toUpperCase()}` as ProviderParityRow['caseId'],
        direct: terminalTrace(record, 'direct'), managed: terminalTrace(record, 'managed'),
        secretHygiene: record.secretHygiene,
        onecli: record.onecli,
        recovery: record.recovery,
      }
      writeFixtureRow(directory, row)
    }
    for (const provider of freshProviders) {
      const record = readJson(path.join(directory, `fresh-${provider}.json`))
      const hosted = readJson(path.join(directory, `fresh-hosted-${provider}.json`))
      if (hosted.configCount < 1 || !hosted.nativeSessionId) {
        throw new Error(`${provider} hosted config or native identity evidence is missing`)
      }
      const row: ProviderParityRow = {
        caseId: `FA-PARITY-FRESH${provider.toUpperCase()}` as ProviderParityRow['caseId'],
        direct: freshTrace(record, 'direct'), managed: freshTrace(record, 'managed'),
        secretHygiene: hosted.secretHygiene,
        onecli: hosted.onecli,
        recovery: record.recovery,
      }
      writeFixtureRow(directory, row)
    }
    const receipt = readProviderParityReceipt(directory)
    if (eventsTarget) {
      fs.mkdirSync(path.dirname(eventsTarget), { recursive: true, mode: 0o700 })
      fs.writeFileSync(eventsTarget, fs.readFileSync(path.join(directory, 'events.jsonl')), { flag: 'wx', mode: 0o600 })
    }
    return receipt
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
