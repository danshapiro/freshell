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

type Step = {
  id: string
  title: string
  /** Receipt env vars this step produces. */
  produces: string[]
  run: (env: NodeJS.ProcessEnv, logPath: string) => number
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
    run: playwright('test/e2e-browser/specs/runtime-opencode-provider-qualification-rust.spec.ts', {
      FRESHELL_RUNTIME_OPENCODE_QUALIFICATION_LIVE: '1',
    }),
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
    run: (env, logPath) => run(
      mise,
      ['exec', 'node@22', '--', 'node_modules/.bin/tsx', 'scripts/testing/runtime-gate.ts',
        'gate', 'landing', '--require-live'],
      env,
      logPath,
    ),
  },
  {
    id: 'production-gate',
    title: 'Full production Gate 5 (expected BLOCKED while providers are deferred)',
    produces: [],
    run: (env, logPath) => run(
      mise,
      ['exec', 'node@22', '--', 'node_modules/.bin/tsx', 'scripts/testing/runtime-gate.ts',
        'gate', 'phase-5', '--require-live'],
      env,
      logPath,
    ),
  },
]

/** Steps whose non-zero exit is the expected, recorded outcome. */
const EXPECTED_EXIT: Record<string, number> = { 'production-gate': 2 }

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
  for (const step of STEPS) {
    for (const name of step.produces) {
      receiptEnv[name] = path.join(receiptDir, `${name.toLowerCase()}.json`)
    }
  }

  const results: Array<{ id: string; title: string; exitCode: number; expected: number; ok: boolean; log: string }> = []
  for (const step of STEPS) {
    if (only && !only.includes(step.id)) continue
    const logPath = path.join(logDir, `${step.id}.log`)
    console.log(`\n### ${step.id}: ${step.title}`)
    const exitCode = step.run({ ...process.env, ...receiptEnv }, logPath)
    const expected = EXPECTED_EXIT[step.id] ?? 0
    const ok = exitCode === expected
    results.push({ id: step.id, title: step.title, exitCode, expected, ok, log: path.relative(repoRoot, logPath) })
    if (!ok) {
      console.error(`step ${step.id} exited ${exitCode}, expected ${expected}`)
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
    status: results.every((row) => row.ok) && (!only ? results.length === STEPS.length : true) ? 'PASS' : 'FAIL',
  }
  fs.writeFileSync(path.join(campaignRoot, 'campaign.json'), JSON.stringify(campaign, null, 2))
  console.log(JSON.stringify(campaign, null, 2))
  return campaign.status === 'PASS' ? 0 : 1
}

process.exitCode = main()
