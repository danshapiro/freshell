import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

export const P2_G01_SPEC = 'test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts'
export const P2_G01_TITLE = 'P2-G01: real browser shell survives ten graceful/abrupt web replacements'
export const P2_G01_SANDBOX_OPT_IN = 'FRESHELL_RUNTIME_EXTERNAL_LOCAL_SANDBOX'
export const P2_G01_HANDOFF_CONTAINER_PATH = '/run/freshell-external-target.json'
const P2_G01_ARTIFACT_ROOT = '/tmp/freshell-p2g01-artifacts'

export function p2G01PlaywrightArtifactPaths(environment: NodeJS.ProcessEnv): {
  outputDir: string
  htmlReportDir: string
} | undefined {
  if (environment.FRESHELL_RUNTIME_EXTERNAL_SPEC !== P2_G01_SPEC
    || environment.FRESHELL_RUNTIME_EXTERNAL_GREP !== P2_G01_TITLE) return undefined
  return {
    outputDir: path.join(P2_G01_ARTIFACT_ROOT, 'test-results'),
    htmlReportDir: path.join(P2_G01_ARTIFACT_ROOT, 'html-report'),
  }
}

export function p2G01PnpmStoreVolume(runId: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId)) {
    throw new Error('invalid P2-G01 run identity for the disposable pnpm store')
  }
  return `freshell-p2g01-pnpm-${runId}`
}

const HandoffSchema = z.object({
  FRESHELL_E2E_TARGET_URL: z.string().min(1),
  FRESHELL_E2E_TARGET_WS_URL: z.string().min(1),
  FRESHELL_E2E_TARGET_TOKEN: z.string().min(1).max(4096),
  FRESHELL_RUNTIME_EXTERNAL_RUN_ID: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
  FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: z.string().regex(/^[a-f0-9]{40}$/),
  FRESHELL_RUNTIME_EXTERNAL_SPEC: z.literal(P2_G01_SPEC),
  FRESHELL_RUNTIME_EXTERNAL_GREP: z.literal(P2_G01_TITLE),
}).strict()

export type P2G01SandboxHandoff = z.infer<typeof HandoffSchema>
export type P2G01ManagedDescriptor = {
  baseUrl: string
  wsUrl: string
  token: string
  runId: string
  candidateSha: string
}

export type P2G01Selection = { spec: string; grep?: string; provider?: string; mode?: string }

export function isExactP2G01Selection(selection: P2G01Selection): boolean {
  return selection.spec === P2_G01_SPEC && selection.grep === P2_G01_TITLE
    && selection.provider === undefined && selection.mode === undefined
}

export function createP2G01SandboxHandoff(
  selection: P2G01Selection,
  descriptor: P2G01ManagedDescriptor,
): P2G01SandboxHandoff {
  if (!isExactP2G01Selection(selection)) throw new Error('local sandbox dispatch requires the exact P2-G01 spec and title')
  return parseP2G01SandboxHandoff({
    FRESHELL_E2E_TARGET_URL: descriptor.baseUrl,
    FRESHELL_E2E_TARGET_WS_URL: descriptor.wsUrl,
    FRESHELL_E2E_TARGET_TOKEN: descriptor.token,
    FRESHELL_RUNTIME_EXTERNAL_RUN_ID: descriptor.runId,
    FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: descriptor.candidateSha,
    FRESHELL_RUNTIME_EXTERNAL_SPEC: selection.spec,
    FRESHELL_RUNTIME_EXTERNAL_GREP: selection.grep,
  })
}

export function parseP2G01SandboxHandoff(value: unknown): P2G01SandboxHandoff {
  const parsed = HandoffSchema.safeParse(value)
  if (!parsed.success) throw new Error('invalid P2-G01 external browser descriptor')
  let httpUrl: URL
  let websocketUrl: URL
  try {
    httpUrl = new URL(parsed.data.FRESHELL_E2E_TARGET_URL)
    websocketUrl = new URL(parsed.data.FRESHELL_E2E_TARGET_WS_URL)
  } catch {
    throw new Error('invalid P2-G01 external browser origin')
  }
  if (httpUrl.protocol !== 'https:' || websocketUrl.protocol !== 'wss:'
    || httpUrl.host !== websocketUrl.host || httpUrl.pathname !== '/' || websocketUrl.pathname !== '/ws'
    || [httpUrl, websocketUrl].some((url) => url.username || url.password || url.search || url.hash)) {
    throw new Error('invalid P2-G01 external browser origin')
  }
  return parsed.data
}

export function p2G01PlaywrightInvocation(
  value: unknown,
  hostEnvironment: NodeJS.ProcessEnv,
): { command: 'pnpm'; args: string[]; environment: NodeJS.ProcessEnv } {
  const handoff = parseP2G01SandboxHandoff(value)
  const home = hostEnvironment.HOME || '/home/sandbox'
  return {
    command: 'pnpm',
    args: [
      'exec', 'playwright', 'test', '--config', 'test/e2e-browser/playwright.cloud.config.ts',
      '--project=chromium-external-target', '--workers=1', '--retries=0', '--timeout=7200000',
      P2_G01_SPEC, '--grep', P2_G01_TITLE,
    ],
    environment: {
      HOME: home,
      PATH: hostEnvironment.PATH || '/usr/local/bin:/usr/bin:/bin',
      TMPDIR: hostEnvironment.TMPDIR || '/tmp',
      npm_config_store_dir: hostEnvironment.npm_config_store_dir || path.join(home, '.local/share/pnpm/store'),
      ...handoff,
    },
  }
}

function readHandoff(): P2G01SandboxHandoff {
  try {
    return parseP2G01SandboxHandoff(JSON.parse(fs.readFileSync(P2_G01_HANDOFF_CONTAINER_PATH, 'utf8')))
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('invalid P2-G01')) throw error
    throw new Error('P2-G01 external browser descriptor could not be read')
  }
}

async function run(): Promise<void> {
  if (process.argv.length !== 2 || process.cwd() !== '/workspace') {
    throw new Error('P2-G01 browser runner requires its fixed sandbox worktree and invocation')
  }
  const invocation = p2G01PlaywrightInvocation(readHandoff(), process.env)
  const child = spawn(invocation.command, invocation.args, {
    cwd: '/workspace', env: invocation.environment, stdio: 'inherit',
  })
  const forwardSignal = (signal: NodeJS.Signals) => {
    if (child.pid && !child.killed) child.kill(signal)
  }
  const onInterrupt = () => forwardSignal('SIGINT')
  const onTerminate = () => forwardSignal('SIGTERM')
  const onHangup = () => forwardSignal('SIGHUP')
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)
  process.on('SIGHUP', onHangup)
  try {
    const status = await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)))
    })
    process.exitCode = status
  } finally {
    process.removeListener('SIGINT', onInterrupt)
    process.removeListener('SIGTERM', onTerminate)
    process.removeListener('SIGHUP', onHangup)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run().catch((error) => {
    const message = error instanceof Error ? error.message : 'P2-G01 sandbox runner failed'
    process.stderr.write(`${JSON.stringify({ severity: 'error', event: 'p2_g01_sandbox_runner_failed', message })}\n`)
    process.exitCode = 1
  })
}
