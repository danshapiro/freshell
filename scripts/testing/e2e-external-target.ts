import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const EXTERNAL_TARGET_SPECS = {
  'managed-environment': 'managed-provider-environment-external.spec.ts',
  'code-checkpoint': 'code-checkpoint-workspace-external.spec.ts',
} as const

export type ManagedEnvironmentFixture = {
  candidateSha: string
  runId: string
  remoteWorkspacePath: string
  expectedNonce: string
}
export type CodeCheckpointFixture = {
  candidateSha: string
  runId: string
  syntheticWorkspacePath: string
  linkedWorktreePath: string
  syntheticHomePath: string
  nonGitWorkspacePath: string
  restrictedUid: number
  expectedNonce: string
}
export type PairedExternalFixture = {
  kind: keyof typeof EXTERNAL_TARGET_SPECS
  spec: string
  targetUrl: string
  targetToken: string
} & ({ kind: 'managed-environment'; fixture: ManagedEnvironmentFixture }
  | { kind: 'code-checkpoint'; fixture: CodeCheckpointFixture })

function fail(field: string): never {
  // Fixed field names only: token and fixture contents never enter errors.
  throw new Error(`External browser fixture is incomplete or invalid at ${field}`)
}

export function externalFixtureRequested(args: string[]): boolean {
  return args.some((arg, index) => arg === '--project=chromium-external-target'
    || (arg === '--project' && args[index + 1] === 'chromium-external-target')
    || Object.values(EXTERNAL_TARGET_SPECS).some(spec => path.basename(arg) === spec))
}

export function resolvePairedExternalFixture(
  env: NodeJS.ProcessEnv = process.env,
  requested = false,
): PairedExternalFixture | undefined {
  const kind = env.FRESHELL_E2E_EXTERNAL_FIXTURE_KIND
  if (!requested && !kind && !env.FRESHELL_MANAGED_ENVIRONMENT_FIXTURE && !env.FRESHELL_CODE_CHECKPOINT_FIXTURE) return
  if (kind !== 'managed-environment' && kind !== 'code-checkpoint') fail('fixture kind')
  const matching = kind === 'managed-environment' ? 'FRESHELL_MANAGED_ENVIRONMENT_FIXTURE' : 'FRESHELL_CODE_CHECKPOINT_FIXTURE'
  const other = kind === 'managed-environment' ? 'FRESHELL_CODE_CHECKPOINT_FIXTURE' : 'FRESHELL_MANAGED_ENVIRONMENT_FIXTURE'
  if (!env[matching] || env[other]) fail('matching fixture pair')
  let value: Record<string, unknown>
  try { value = JSON.parse(env[matching]!) } catch { fail('fixture JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('fixture JSON')
  const paths = kind === 'managed-environment' ? ['remoteWorkspacePath']
    : ['syntheticWorkspacePath', 'linkedWorktreePath', 'syntheticHomePath', 'nonGitWorkspacePath']
  const fields = ['candidateSha', 'runId', 'expectedNonce', ...paths, ...(kind === 'code-checkpoint' ? ['restrictedUid'] : [])]
  if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) fail('fixture fields')
  if (typeof value.candidateSha !== 'string' || !/^[a-f0-9]{40}$/.test(value.candidateSha)) fail('candidate SHA')
  if (typeof value.runId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.runId)) fail('run ID')
  if (typeof value.expectedNonce !== 'string' || !value.expectedNonce.trim()) fail('expected nonce')
  for (const field of paths) {
    const selected = value[field]
    if (typeof selected !== 'string' || !path.posix.isAbsolute(selected) || selected.includes('\0')
      || selected.split('/').some(part => part === '.' || part === '..')) fail(field)
  }
  if (kind === 'code-checkpoint' && (!Number.isSafeInteger(value.restrictedUid) || Number(value.restrictedUid) <= 0)) fail('restricted UID')
  const targetUrl = env.FRESHELL_E2E_TARGET_URL
  const targetToken = env.FRESHELL_E2E_TARGET_TOKEN
  if (!targetUrl || !targetToken?.trim()) fail('target URL/token pair')
  let url: URL
  try { url = new URL(targetUrl) } catch { fail('target URL') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || (url.pathname !== '/' && url.pathname !== '')) fail('target URL')
  if (env.FRESHELL_E2E_TARGET_WS_URL) {
    let ws: URL
    try { ws = new URL(env.FRESHELL_E2E_TARGET_WS_URL) } catch { fail('target WebSocket URL') }
    if (ws.host !== url.host || ws.protocol !== (url.protocol === 'https:' ? 'wss:' : 'ws:')
      || ws.username || ws.password || ws.search || ws.hash || ws.pathname !== '/ws') fail('target WebSocket URL')
  }
  if (env.FRESHELL_E2E_TARGET_TIMEOUT_MS && (!/^\d+$/.test(env.FRESHELL_E2E_TARGET_TIMEOUT_MS)
    || Number(env.FRESHELL_E2E_TARGET_TIMEOUT_MS) <= 0)) fail('target timeout')
  return { kind, spec: EXTERNAL_TARGET_SPECS[kind], targetUrl, targetToken, fixture: value } as PairedExternalFixture
}

export function validateExternalSelection(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const paired = resolvePairedExternalFixture(env, externalFixtureRequested(args))
  if (!paired) return
  const projects = args.flatMap((arg, index) => arg.startsWith('--project=') ? [arg.slice('--project='.length)]
    : arg === '--project' ? [args[index + 1]] : [])
  if (projects.length !== 1 || projects[0] !== 'chromium-external-target') fail('dedicated project selection')
  const externalSpecs = args.filter(arg => Object.values(EXTERNAL_TARGET_SPECS).some(spec => path.basename(arg) === spec))
  if (externalSpecs.some(arg => path.basename(arg) !== paired.spec)) fail('matching spec selection')
  return paired
}

export function appendExternalTargetEnvironment(file: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  if (!validateExternalSelection(args, env)) return
  const names = ['FRESHELL_E2E_TARGET_URL', 'FRESHELL_E2E_TARGET_WS_URL', 'FRESHELL_E2E_TARGET_TOKEN',
    'FRESHELL_E2E_TARGET_TIMEOUT_MS', 'FRESHELL_E2E_EXTERNAL_FIXTURE_KIND',
    'FRESHELL_MANAGED_ENVIRONMENT_FIXTURE', 'FRESHELL_CODE_CHECKPOINT_FIXTURE']
  // JSON quoted strings are YAML scalars, preserving newlines/metacharacters.
  fs.appendFileSync(file, names.filter(name => env[name] !== undefined)
    .map(name => `${name}: ${JSON.stringify(env[name])}\n`).join(''))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [operation, ...args] = process.argv.slice(2)
    if (operation === 'validate') validateExternalSelection(args)
    else if (operation === 'append-env') {
      const [file, ...selectors] = args
      if (!file) fail('private env file')
      appendExternalTargetEnvironment(file, selectors)
    } else fail('operation')
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'External browser fixture validation failed')
    process.exitCode = 1
  }
}
