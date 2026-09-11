/** Direct Durable Souls test execution. Results describe only what ran. */
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

type Suite = 'deterministic' | 'live' | 'stress' | 'all'
export type VerificationSelection = { suite?: Suite; only?: string[]; list?: boolean }
export type VerificationStep = {
  id: string; lane: Exclude<Suite, 'all'>; browser: boolean; args: string[]; env: Record<string, string>
}
const spec = (name: string) => `test/e2e-browser/specs/${name}-rust.spec.ts`
const browser = (id: string, lane: Exclude<Suite, 'all'>, name: string, env: Record<string, string> = {}): VerificationStep => ({
  id, lane, browser: true, args: ['run', 'test:e2e:local', '--', '--project=rust-chromium', '--reporter=json', spec(name)], env: { ...env, FRESHELL_E2E_BACKEND: 'local' },
})
const STEPS: VerificationStep[] = [
  { id: 'runtime', lane: 'deterministic', browser: false, args: ['run', 'test:runtime', '--', 'gate', 'phase-5', '--require-live'], env: {} },
  browser('fresh-agent-fixtures', 'deterministic', 'runtime-fresh-agent-fixture', { FRESHELL_RUNTIME_FRESH_AGENT_FIXTURE_TEST: '1' }),
  browser('continuity', 'live', 'runtime-terminal-continuity'),
  browser('resurrection', 'live', 'runtime-provider-resurrection', { FRESHELL_RUNTIME_PHASE3_LIVE: '1' }),
  browser('opencode-qualification', 'live', 'runtime-opencode-provider-qualification', { FRESHELL_RUNTIME_OPENCODE_QUALIFICATION_LIVE: '1' }),
  browser('managed-provider-qualification', 'live', 'runtime-managed-provider-qualification', {
    FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE: '1',
    FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_PROVIDERS: 'claude,codex,opencode,amplifier',
  }),
  browser('fresh-agent-qualification', 'live', 'runtime-fresh-agent-qualification', {
    FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_LIVE: '1',
    FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_MODES: 'freshclaude,kilroy,freshcodex,freshopencode',
  }),
  browser('rehydrate', 'live', 'runtime-tabs-rehydrate'),
  browser('loss-notice', 'live', 'runtime-lost-soul-notice', { FRESHELL_RUNTIME_PHASE5_LIVE: '1' }),
  browser('chaos', 'stress', 'runtime-chaos', { FRESHELL_RUNTIME_PHASE5_CHAOS_LIVE: '1' }),
  { id: 'soak', lane: 'stress', browser: false, args: ['run', 'test:runtime:phase5:soak'], env: {} },
]

export function verificationSteps(selection: VerificationSelection): VerificationStep[] {
  if (selection.only) {
    if (selection.only.length === 0 || new Set(selection.only).size !== selection.only.length) throw new Error('select unique test step IDs')
    return selection.only.map(id => {
      const step = STEPS.find(s => s.id === id)
      if (!step) throw new Error(`unknown runtime test step: ${id}`)
      return step
    })
  }
  const suite = selection.suite ?? 'deterministic'
  return STEPS.filter(step => suite === 'all' || step.lane === suite)
}

export function parseVerificationArgs(args: string[]): VerificationSelection {
  if (args.length === 0) return { suite: 'deterministic' }
  if (args.length === 1 && args[0] === '--list') return { list: true, suite: 'all' }
  if (args.length === 2 && args[0] === '--suite' && ['deterministic', 'live', 'stress', 'all'].includes(args[1])) return { suite: args[1] as Suite }
  if (args[0] === '--only') {
    const selection = { only: args.slice(1) }
    verificationSteps(selection)
    return selection
  }
  throw new Error('usage: npm run test:runtime:verify -- [--suite deterministic|live|stress|all | --only <step> ... | --list]')
}

export function playwrightReportEnvironment(reportFile: string): { PLAYWRIGHT_JSON_OUTPUT_FILE: string } {
  return { PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile }
}

const VERIFICATION_OVERRIDE_KEYS = new Set([
  'FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_PROVIDERS',
  'FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_MODES',
])

export function verificationStepEnvironment(
  step: VerificationStep,
  overrides: Record<string, string>,
  reportFile: string,
): NodeJS.ProcessEnv {
  for (const key of Object.keys(overrides)) {
    if (!VERIFICATION_OVERRIDE_KEYS.has(key)) {
      throw new Error(`unsupported verification override: ${key}`)
    }
  }
  return {
    ...process.env,
    ...step.env,
    ...overrides,
    ...playwrightReportEnvironment(reportFile),
  }
}

export function playwrightFailure(report: unknown): string | null {
  const stats = (report as { stats?: Record<string, number> } | null)?.stats
  if (!stats || !Number.isSafeInteger(stats.expected) || stats.expected <= 0) return 'Playwright ran no passing tests'
  if (stats.unexpected !== 0 || stats.skipped !== 0 || stats.flaky !== 0) return 'Playwright reported failed, skipped, or retry-masked tests'
  return null
}

export function verificationOutcome(results: Array<'PASS' | 'FAIL' | 'BLOCKED'>): {status: 'PASS'|'FAIL'|'BLOCKED'; exitCode: number} {
  if (!results.length || results.includes('FAIL')) return { status: 'FAIL', exitCode: 1 }
  return results.includes('BLOCKED') ? { status: 'BLOCKED', exitCode: 2 } : { status: 'PASS', exitCode: 0 }
}


async function execute(args: string[], env: NodeJS.ProcessEnv, log: string): Promise<number> {
  const fd = fs.openSync(log, 'wx', 0o600)
  try {
    fs.writeSync(fd, `command=npm ${args.join(' ')}\n`)
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { env, stdio: ['ignore', fd, fd] })
      child.once('error', reject)
      child.once('exit', (code) => resolve(code ?? 1))
    })
  } finally { fs.closeSync(fd) }
}

export async function runVerification(selection: VerificationSelection, overrides: Record<string, string> = {}): Promise<number> {
  const steps = verificationSteps(selection)
  if (selection.list) { for (const step of steps) console.log(`${step.id}\t${step.lane}`); return 0 }
  const root = path.join(process.cwd(), '.runtime-evidence', 'verification', randomUUID())
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  // Informational build identification, not a clean-tree or receipt prerequisite.
  let commit = 'unknown'
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch {}
  const results: Array<{id: string; status: 'PASS'|'FAIL'|'BLOCKED'; exitCode: number; error: string|null; log: string}> = []
  for (const step of steps) {
    const log = path.join(root, `${step.id}.log`)
    const reportFile = path.join(root, `${step.id}.playwright.json`)
    const env = verificationStepEnvironment(step, overrides, reportFile)
    console.log(`RUN ${step.id}: ${log}`)
    let exitCode = 1, error: string|null = null
    try {
      exitCode = await execute(step.args, env, log)
      if (step.browser && exitCode === 0) {
        let report: unknown
        try { report = JSON.parse(fs.readFileSync(reportFile, 'utf8')) } catch {}
        error = playwrightFailure(report)
        if (error) exitCode = 1
      }
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure) }
    const status = exitCode === 0 ? 'PASS' : exitCode === 2 ? 'BLOCKED' : 'FAIL'
    results.push({ id: step.id, status, exitCode, error, log })
    console.log(`${status} ${step.id}`)
  }
  const outcome = verificationOutcome(results.map(r => r.status))
  const report = { ...outcome, scope: selection, buildCommit: commit, completedAt: new Date().toISOString(), results }
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ ...report, logDir: root }, null, 2))
  return outcome.exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await runVerification(parseVerificationArgs(process.argv.slice(2))) }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
