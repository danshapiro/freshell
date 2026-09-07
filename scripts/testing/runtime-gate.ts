import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { RuntimeHarness } from './runtime-sandbox.js'
import { PHASE1_CASE_IDS, runPhase1Gate, validateRequiredCoverage } from '../../test/runtime/gates/phase-1.test.js'
import { PHASE2_CASE_IDS, runPhase2Gate } from '../../test/runtime/gates/phase-2.test.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')

type GatePhase = 'phase-1' | 'phase-2'

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const phase = args[0] === 'gate' && (args[1] === 'phase-1' || args[1] === 'phase-2')
    ? args[1] as GatePhase
    : null
  if (!phase) {
    console.error('usage: npm run test:runtime -- gate <phase-1|phase-2> --require-live')
    return 1
  }
  if (!args.includes('--require-live')) {
    console.error(`BLOCKED: ${phase} may only pass through the live Docker/IPC gate; add --require-live.`)
    return 2
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'test/runtime/gate-manifest.json'), 'utf8'))
  const phaseManifest = manifest.phases.find((candidate: any) => candidate.id === phase)
  if (!phaseManifest) {
    console.error(`FAIL: ${phase} is absent from test/runtime/gate-manifest.json`)
    return 1
  }
  const requiredCases = phaseManifest.cumulative_required_case_ids as string[]
  const codeCases = phase === 'phase-1'
    ? [...PHASE1_CASE_IDS]
    : [...PHASE1_CASE_IDS, ...PHASE2_CASE_IDS]
  if (JSON.stringify([...requiredCases].sort()) !== JSON.stringify([...codeCases].sort())) {
    console.error(`FAIL: gate implementation/manifest mismatch. manifest=${[...requiredCases].sort().join(',')} code=${[...codeCases].sort().join(',')}`)
    return 1
  }

  const harness = new RuntimeHarness(repoRoot, undefined, phase === 'phase-2' ? 2 : 1)
  const executed: string[] = []
  let blockedCases: Array<{ caseId: string; message: string; evidence?: unknown }> = []
  let primaryError: unknown
  let cleanup = { ok: false, errors: ['cleanup not attempted'] }
  const startedAt = new Date().toISOString()
  try {
    await harness.prepare()
    await runPhase1Gate(harness, (caseId) => executed.push(caseId))
    validateRequiredCoverage(PHASE1_CASE_IDS, executed.filter((id) => id.startsWith('P1-')))

    if (phase === 'phase-2') {
      const result = await runPhase2Gate(harness, (caseId) => executed.push(caseId))
      blockedCases = result.blocked
    }

    const safetyCase = phase === 'phase-2' ? 'P2-G11' : 'P1-G10'
    harness.assert(
      safetyCase,
      harness.broker.unsafeAttempts().length === 0,
      'no unsafe destructive Docker request occurred anywhere in the cumulative live gate',
      harness.broker.unsafeAttempts(),
    )
  } catch (error) {
    primaryError = error
  } finally {
    try {
      cleanup = await harness.cleanup()
    } catch (error) {
      cleanup = { ok: false, errors: [`cleanup threw: ${String(error)}`] }
      primaryError ??= error
    }
  }

  const failed = primaryError !== undefined || !cleanup.ok
  const blocked = !failed && blockedCases.length > 0
  const status = failed ? 'FAIL' : blocked ? 'BLOCKED' : 'PASS'
  const summary = {
    phase,
    status,
    startedAt,
    finishedAt: new Date().toISOString(),
    candidateSha: harness.candidateSha,
    runId: harness.runId,
    requiredCases,
    executedCases: executed,
    blockedCases,
    cleanup,
    unsafeDockerAttempts: harness.broker?.unsafeAttempts?.() ?? [],
    error: primaryError instanceof Error
      ? { message: primaryError.message, stack: primaryError.stack }
      : primaryError === undefined ? null : String(primaryError),
  }
  harness.writeSummary(summary)
  console.log(JSON.stringify({ ...summary, evidenceDir: harness.evidenceDir }, null, 2))
  return failed ? 1 : blocked ? 2 : 0
}

process.exitCode = await main()
