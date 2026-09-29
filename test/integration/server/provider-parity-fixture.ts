import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, FRESHELL_PROVIDER_PARITY_ROWS_DIR: evidenceDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const capture = (chunk: Buffer) => { output = `${output}${chunk}`.slice(-40_000) }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', value => resolve(value ?? 1))
  })
  if (code !== 0) throw new Error(`${command} ${args.join(' ')} failed (${code}):\n${output}`)
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
  return {
    argv: [],
    env: {},
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-provider-parity-'))
  try {
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
        onecli: { approvedReference: true, unapprovedReferenceRejected: true },
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
        onecli: { approvedReference: true, unapprovedReferenceRejected: true },
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
