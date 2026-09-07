import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { RuntimeHarness } from './runtime-sandbox.js'
import { PHASE1_CASE_IDS, runPhase1Gate, validateRequiredCoverage } from '../../test/runtime/gates/phase-1.test.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args[0] !== 'gate' || args[1] !== 'phase-1') {
    console.error('usage: npm run test:runtime -- gate phase-1 --require-live')
    return 1
  }
  if (!args.includes('--require-live')) {
    console.error('BLOCKED: Phase 1 may only pass through the live Docker/IPC gate; add --require-live.')
    return 2
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'test/runtime/gate-manifest.json'), 'utf8'))
  const manifestCaseIds = [...collectCaseIds(manifest)].sort()
  const codeCaseIds = [...PHASE1_CASE_IDS].sort()
  if (JSON.stringify(manifestCaseIds) !== JSON.stringify(codeCaseIds)) {
    console.error(`FAIL: gate implementation/manifest mismatch. manifest=${manifestCaseIds.join(',')} code=${codeCaseIds.join(',')}`)
    return 1
  }

  const harness: RuntimeHarness = new RuntimeHarness(repoRoot)
  let executed: string[] = []
  let primaryError: unknown
  let cleanup = { ok: false, errors: ['cleanup not attempted'] }
  const startedAt = new Date().toISOString()
  try {
    await harness.prepare()
    await runPhase1Gate(harness, (caseId) => executed.push(caseId))
    validateRequiredCoverage(PHASE1_CASE_IDS, executed)
    harness.assert('P1-G10', harness.broker.unsafeAttempts().length === 0, 'no unsafe destructive Docker request occurred anywhere in the live gate', harness.broker.unsafeAttempts())
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

  const passed = primaryError === undefined && cleanup.ok
  const summary = {
    phase: 'phase-1',
    status: passed ? 'PASS' : 'FAIL',
    startedAt,
    finishedAt: new Date().toISOString(),
    candidateSha: harness.candidateSha,
    runId: harness.runId,
    requiredCases: PHASE1_CASE_IDS,
    executedCases: executed,
    cleanup,
    unsafeDockerAttempts: harness.broker?.unsafeAttempts?.() ?? [],
    error: primaryError instanceof Error ? { message: primaryError.message, stack: primaryError.stack } : primaryError === undefined ? null : String(primaryError),
  }
  harness.writeSummary(summary)
  console.log(JSON.stringify({ ...summary, evidenceDir: harness.evidenceDir }, null, 2))
  return passed ? 0 : 1
}

function collectCaseIds(value: unknown, output = new Set<string>()): Set<string> {
  if (typeof value === 'string' && /^P1-G\d{2}$/.test(value)) output.add(value)
  else if (Array.isArray(value)) for (const item of value) collectCaseIds(item, output)
  else if (value && typeof value === 'object') for (const item of Object.values(value as Record<string, unknown>)) collectCaseIds(item, output)
  return output
}

process.exitCode = await main()
