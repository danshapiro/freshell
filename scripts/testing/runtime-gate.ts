/** Run actual Docker/IPC scenarios. Browser/provider/stress scenarios run directly
 * through runtime-verify.ts, never through imported receipts or approval modes. */
import { RuntimeHarness } from './runtime-sandbox.js'
import { parseGateArgs } from './runtime-gate-args.js'
import { PHASE1_CASE_IDS, runPhase1Gate } from '../../test/runtime/gates/phase-1.test.js'
import { PHASE2_CASE_IDS, runPhase2Gate } from '../../test/runtime/gates/phase-2.test.js'
import { PHASE3_CASE_IDS, runPhase3Gate } from '../../test/runtime/gates/phase-3.test.js'
import { PHASE4_CASE_IDS, runPhase4Gate } from '../../test/runtime/gates/phase-4.test.js'
import { PHASE5_CASE_IDS, runPhase5Gate } from '../../test/runtime/gates/phase-5.test.js'

async function main(): Promise<number> {
  const args = parseGateArgs(process.argv.slice(2))
  if ('error' in args) { console.error(args.error); return args.exitCode }
  const phase = Number(args.phase.slice(-1)) as 1|2|3|4|5
  const groups = [PHASE1_CASE_IDS, PHASE2_CASE_IDS, PHASE3_CASE_IDS, PHASE4_CASE_IDS, PHASE5_CASE_IDS]
  const required = groups.slice(0, phase).flat().filter(id => !args.only || id === args.only)
  if (!required.length) { console.error('No deterministic scenario matches the selection.'); return 1 }
  if (args.list) { console.log(required.join('\n')); return 0 }
  const h = new RuntimeHarness(process.cwd(), undefined, phase)
  const executed: string[] = []
  const blocked: Array<{caseId: string; message: string}> = []
  const only = new Set(required)
  const startedAt = new Date().toISOString()
  let failure: unknown
  let cleanup = { ok: false, errors: ['cleanup not attempted'] }
  try {
    await h.prepare()
    const passed = (id: string) => { executed.push(id); console.log(`PASS ${id}`) }
    await runPhase1Gate(h, passed, only)
    if (phase >= 2) blocked.push(...(await runPhase2Gate(h, passed, only)).blocked)
    if (phase >= 3) blocked.push(...(await runPhase3Gate(h, passed, only)).blocked)
    if (phase >= 4) blocked.push(...(await runPhase4Gate(h, passed, only)).blocked)
    if (phase >= 5) blocked.push(...(await runPhase5Gate(h, passed, only)).blocked)
  } catch (error) { failure = error }
  finally {
    try { cleanup = await h.cleanup() }
    catch (error) { cleanup = { ok: false, errors: [String(error)] } }
  }
  const unsafeAttempts = h.broker?.unsafeAttempts?.() ?? []
  const missing = required.filter(id => !executed.includes(id) && !blocked.some(row => row.caseId === id))
  const exitCode = failure || !cleanup.ok || unsafeAttempts.length || missing.length ? 1 : blocked.length ? 2 : 0
  const result = {
    scope: 'deterministic-runtime', phase: args.phase, status: exitCode === 0 ? 'PASS' : exitCode === 2 ? 'BLOCKED' : 'FAIL',
    startedAt, finishedAt: new Date().toISOString(), buildCommit: h.candidateSha, image: h.imageRef,
    required, executed, blocked, missing, cleanup, unsafeAttempts,
    error: failure instanceof Error ? failure.message : failure ? String(failure) : null,
    // This result is not an all-provider or browser verification result.
  }
  h.writeSummary(result)
  console.log(JSON.stringify({ ...result, logDir: h.evidenceDir }, null, 2))
  return exitCode
}
process.exitCode = await main()
