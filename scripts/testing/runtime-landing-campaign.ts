/**
 * Candidate-bound Durable Souls qualification campaign.
 *
 * Produces one self-contained evidence run for the commit currently checked
 * out: every receipt producer, then the landing gate, then the full production
 * gate (whose BLOCKED verdict is itself part of the evidence).
 *
 * The campaign refuses to start with tracked modifications in the worktree,
 * because every receipt is bound to the exact candidate SHA. A tracked edit
 * after receipt generation invalidates the whole run.
 *
 *   npm run test:runtime:campaign                 # full campaign
 *   npm run test:runtime:campaign -- --only soak  # rerun one step
 *   npm run test:runtime:campaign -- --list       # show the step ids
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const mise = path.join(os.homedir(), '.local', 'bin', 'mise')

type GateExpectation = {
  gateArgs: string[]
  status: 'PASS' | 'BLOCKED'
  blockedReason?: string
}

type Step = {
  id: string
  title: string
  /** Receipt env vars this step produces. */
  produces: string[]
  /** Providers emitted together by a qualification receipt producer. */
  qualificationProviders?: string[]
  /** Omitted from the default landing campaign until explicitly selected. */
  explicitLiveOnly?: boolean
  requiredLiveEnv?: string
  run?: (env: NodeJS.ProcessEnv, logPath: string) => number
  /**
   * Gate steps are judged by the summary they write, not by an exit code that
   * has to survive npm/coordinator plumbing. A BLOCKED production gate is the
   * expected, recorded outcome of this landing — never a pass.
   */
  expectGateStatus?: GateExpectation
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

function playwright(spec: string, extraEnv: Record<string, string>) {
  return (env: NodeJS.ProcessEnv, logPath: string): number => run(
    mise,
    ['exec', 'node@22', '--', 'node_modules/.bin/playwright', 'test',
      '--config', 'test/e2e-browser/playwright.config.ts',
      '--project=rust-chromium', spec],
    { ...env, ...extraEnv },
    logPath,
  )
}

/** Every gate summary currently on disk for this candidate, newest last. */
function gateSummaryPaths(candidateSha: string): string[] {
  const root = path.join(repoRoot, '.runtime-evidence', candidateSha)
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root)
    .map((runId) => path.join(root, runId, 'summary.json'))
    .filter((candidate) => fs.existsSync(candidate))
    .sort((left, right) => fs.statSync(left).mtimeMs - fs.statSync(right).mtimeMs)
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, logPath: string): number {
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const started = new Date().toISOString()
  fs.appendFileSync(logPath, `\n=== ${started} ${command} ${args.join(' ')}\n`)
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  })
  fs.appendFileSync(logPath, result.stdout ?? '')
  fs.appendFileSync(logPath, result.stderr ?? '')
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  return result.status ?? 1
}

const STEPS: Step[] = [
  {
    id: 'continuity',
    title: 'Phase 2 real browser + free-tier OpenCode continuity',
    produces: ['FRESHELL_RUNTIME_BROWSER_RECEIPT', 'FRESHELL_RUNTIME_OPENCODE_RECEIPT'],
    run: playwright('test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts', {}),
  },
  {
    id: 'resurrection',
    title: 'Phase 3 live provider resurrection with a real permission prompt',
    produces: ['FRESHELL_RUNTIME_PHASE3_BROWSER_RECEIPT'],
    run: playwright('test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts', {
      FRESHELL_RUNTIME_PHASE3_LIVE: '1',
    }),
  },
  {
    id: 'opencode-qualification',
    title: 'OpenCode free-tier provider certification receipt',
    produces: ['FRESHELL_RUNTIME_PHASE3_PROVIDER_RECEIPT', 'FRESHELL_RUNTIME_PHASE5_PROVIDER_RECEIPT'],
    qualificationProviders: ['opencode'],
    run: playwright('test/e2e-browser/specs/runtime-opencode-provider-qualification-rust.spec.ts', {
      FRESHELL_RUNTIME_OPENCODE_QUALIFICATION_LIVE: '1',
    }),
  },
  {
    id: 'managed-provider-qualification',
    title: 'Combined Claude/Codex/OpenCode/Amplifier provider certification receipt',
    produces: ['FRESHELL_RUNTIME_PHASE3_PROVIDER_RECEIPT', 'FRESHELL_RUNTIME_PHASE5_PROVIDER_RECEIPT'],
    qualificationProviders: ['claude', 'codex', 'opencode', 'amplifier'],
    explicitLiveOnly: true,
    requiredLiveEnv: 'FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE',
    run: playwright('test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts', {}),
  },
  {
    id: 'rehydrate',
    title: 'Phase 4 tab/view rehydration',
    produces: ['FRESHELL_RUNTIME_PHASE4_BROWSER_RECEIPT'],
    run: playwright('test/e2e-browser/specs/runtime-tabs-rehydrate-rust.spec.ts', {}),
  },
  {
    id: 'loss-notice',
    title: 'Phase 5 real isolated OpenCode loss notice',
    produces: ['FRESHELL_RUNTIME_PHASE5_LOSS_RECEIPT'],
    run: playwright('test/e2e-browser/specs/runtime-lost-soul-notice-rust.spec.ts', {
      FRESHELL_RUNTIME_PHASE5_LIVE: '1',
    }),
  },
  {
    id: 'chaos',
    title: 'Phase 5 100-web/20-controller chaos',
    produces: ['FRESHELL_RUNTIME_PHASE5_CHAOS_RECEIPT'],
    run: playwright('test/e2e-browser/specs/runtime-chaos-rust.spec.ts', {
      FRESHELL_RUNTIME_PHASE5_CHAOS_LIVE: '1',
    }),
  },
  {
    id: 'soak',
    title: '>=30 minute, >=50 soul CPU/memory/PID pressure soak',
    produces: ['FRESHELL_RUNTIME_PHASE5_SOAK_RECEIPT'],
    run: (env, logPath) => run(
      mise,
      ['exec', 'node@22', '--', 'node_modules/.bin/tsx', 'scripts/testing/runtime-phase5-soak.ts'],
      env,
      logPath,
    ),
  },
  {
    id: 'landing-gate',
    title: 'Landing / pre-certification gate (expected PASS)',
    produces: [],
    expectGateStatus: { gateArgs: ['gate', 'landing', '--require-live'], status: 'PASS' },
  },
  {
    id: 'production-gate',
    title: 'Full production Gate 5 (expected BLOCKED while providers are deferred)',
    produces: [],
    expectGateStatus: {
      gateArgs: ['gate', 'phase-5', '--require-live'],
      status: 'BLOCKED',
      blockedReason: 'pending_live_provider_certification',
    },
  },
]

function main(): number {
  const args = process.argv.slice(2)
  if (args.includes('--list')) {
    for (const step of STEPS) console.log(`${step.id}\t${step.title}`)
    return 0
  }
  const onlyIndex = args.indexOf('--only')
  const only = onlyIndex === -1 ? null : args.slice(onlyIndex + 1).filter((value) => !value.startsWith('--'))
  if (only && only.some((id) => !STEPS.some((step) => step.id === id))) {
    console.error(`unknown step; valid ids: ${STEPS.map((step) => step.id).join(', ')}`)
    return 1
  }

  const selectedSteps = only
    ? STEPS.filter((step) => only.includes(step.id))
    : STEPS.filter((step) => !step.explicitLiveOnly)

  const dirty = git(['status', '--porcelain', '--untracked-files=no'])
  if (dirty && !args.includes('--allow-dirty')) {
    console.error('BLOCKED: tracked modifications present. Every receipt is bound to the exact candidate SHA;')
    console.error('commit first, or pass --allow-dirty for an explicitly non-qualifying rehearsal run.')
    console.error(dirty)
    return 2
  }

  const candidateSha = git(['rev-parse', 'HEAD'])
  const campaignRoot = path.join(repoRoot, '.runtime-evidence', candidateSha, 'campaign')
  const receiptDir = path.join(campaignRoot, 'receipts')
  const logDir = path.join(campaignRoot, 'logs')
  fs.mkdirSync(receiptDir, { recursive: true })
  fs.mkdirSync(logDir, { recursive: true })

  const receiptEnv: Record<string, string> = {}
  for (const step of selectedSteps) {
    for (const name of step.produces) {
      receiptEnv[name] = path.join(receiptDir, `${name.toLowerCase()}.json`)
    }
  }

  type StepResult = {
    id: string
    title: string
    exitCode: number
    ok: boolean
    log: string
    qualificationProviders?: string[]
    gate?: { status: string; blockedReason: string | null; expected: string; summaryPath: string } | { error: string }
  }
  const results: StepResult[] = []
  for (const step of selectedSteps) {
    const logPath = path.join(logDir, `${step.id}.log`)
    console.log(`\n### ${step.id}: ${step.title}`)
    const env = { ...process.env, ...receiptEnv }

    if (step.requiredLiveEnv && process.env[step.requiredLiveEnv] !== '1') {
      const message = `step ${step.id} requires ${step.requiredLiveEnv}=1; a skipped live qualification is never a pass`
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      fs.writeFileSync(logPath, `${message}\n`)
      console.error(message)
      results.push({
        id: step.id,
        title: step.title,
        exitCode: 2,
        ok: false,
        log: path.relative(repoRoot, logPath),
        ...(step.qualificationProviders ? { qualificationProviders: step.qualificationProviders } : {}),
      })
      break
    }

    if (step.expectGateStatus) {
      const before = gateSummaryPaths(candidateSha)
      // Route the gate through the repo's coordinator so a broad destructive
      // run still respects the shared test gate.
      const exitCode = run(
        mise,
        ['exec', 'node@22', '--', 'npm', 'run', 'test:runtime', '--', ...step.expectGateStatus.gateArgs],
        env,
        logPath,
      )
      const summaryPath = gateSummaryPaths(candidateSha).find((candidate) => !before.includes(candidate))
      let gate: StepResult['gate']
      let ok = false
      if (!summaryPath) {
        gate = { error: 'the gate wrote no new summary.json' }
      } else {
        const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
        gate = {
          status: summary.status,
          blockedReason: summary.blockedReason ?? null,
          expected: step.expectGateStatus.status,
          summaryPath: path.relative(repoRoot, summaryPath),
        }
        ok = summary.status === step.expectGateStatus.status
          && (!step.expectGateStatus.blockedReason
            || summary.blockedReason === step.expectGateStatus.blockedReason)
      }
      results.push({
        id: step.id,
        title: step.title,
        exitCode,
        ok,
        log: path.relative(repoRoot, logPath),
        gate,
        ...(step.qualificationProviders ? { qualificationProviders: step.qualificationProviders } : {}),
      })
      if (!ok) {
        console.error(`step ${step.id}: gate outcome ${JSON.stringify(gate)} is not the expected ${step.expectGateStatus.status}`)
        break
      }
      continue
    }

    const exitCode = step.run!(env, logPath)
    const ok = exitCode === 0
    results.push({
      id: step.id,
      title: step.title,
      exitCode,
      ok,
      log: path.relative(repoRoot, logPath),
      ...(step.qualificationProviders ? { qualificationProviders: step.qualificationProviders } : {}),
    })
    if (!ok) {
      console.error(`step ${step.id} exited ${exitCode}`)
      break
    }
  }

  const campaign = {
    schemaVersion: 1,
    candidateSha,
    startedAt: new Date().toISOString(),
    receiptDir: path.relative(repoRoot, receiptDir),
    receipts: Object.fromEntries(
      Object.entries(receiptEnv).map(([name, target]) => [
        name,
        { path: path.relative(repoRoot, target), present: fs.existsSync(target) },
      ]),
    ),
    steps: results,
    status: results.every((row) => row.ok) && results.length === selectedSteps.length ? 'PASS' : 'FAIL',
  }
  fs.writeFileSync(path.join(campaignRoot, 'campaign.json'), JSON.stringify(campaign, null, 2))
  console.log(JSON.stringify(campaign, null, 2))
  return campaign.status === 'PASS' ? 0 : 1
}

process.exitCode = main()
