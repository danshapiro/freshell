import os from 'node:os'
import { afterAll, describe, expect, it } from 'vitest'
import {
  runOpencodeKimiT2,
  opencodeKimiT2Available,
  KIMI_MODEL,
  type T2Run,
} from '../../../../port/oracle/harness/t2-live.js'
import { assertT2Invariants, summarizeT2ForBaseline } from '../../../../port/oracle/harness/invariants.js'

/**
 * Supplemental, explicitly gated Rust provider contract for OpenCode/Kimi.
 * It checks lifecycle, positive completion evidence, persistence, isolation,
 * request bounds, and exact owned-child cleanup. Historical provider captures
 * are provenance only and are not read by this active contract.
 */

const gateEnabled = !!process.env.FRESHELL_RUN_REAL_PROVIDER_CONTRACTS
const availability = await opencodeKimiT2Available()
const shouldRun = gateEnabled && availability.available
if (!shouldRun) {
  const why = !gateEnabled
    ? 'FRESHELL_RUN_REAL_PROVIDER_CONTRACTS not set'
    : `opencode/Kimi unavailable: ${availability.reason}`
  // eslint-disable-next-line no-console
  console.warn(`[T2-opencode-rust] SKIPPED — ${why}`)
}

const describeLive = shouldRun ? describe.sequential : describe.skip

describeLive('T2 Rust provider contract (opencode + Kimi)', () => {
  let run: T2Run | null = null

  afterAll(async () => {
    if (run) await run.teardown().catch(() => {})
  })

  it('completes one isolated turn and satisfies the Rust behavioral contract', async () => {
    run = await runOpencodeKimiT2({ verbose: !!process.env.FRESHELL_T2_VERBOSE })
    const pid = run.handle.pid
    expect(run.handle.port).not.toBe(3001)
    expect(pid).toBeGreaterThan(0)
    expect(run.observation.sessionCreated).toBe(true)

    const cleanup = await run.teardown()
    const observation = run.observation
    run = null
    const report = assertT2Invariants(observation)
    const projection = summarizeT2ForBaseline(observation, report)

    expect(observation.provider).toBe('opencode')
    expect(observation.model).toBe(KIMI_MODEL)
    expect(observation.liveModelCalls).toBeGreaterThanOrEqual(1)
    expect(observation.liveModelCalls).toBeLessThanOrEqual(2)
    expect(observation.turnAccepted).toBe(true)
    expect(observation.serverReportedIdle).toBe(true)
    expect(observation.turnCompleted).toBe(true)
    expect(observation.captureNonEmpty).toBe(true)
    expect(observation.captureContainsSentinel).toBe(true)
    expect(observation.dbPath.startsWith(os.tmpdir())).toBe(true)
    expect(projection.shapes.wsServerMessageTypes.length).toBeGreaterThan(0)
    expect(cleanup.serverPidGone).toBe(true)
    expect(cleanup.strayOwnedPidsAfter).toEqual([])
    expect(cleanup.ownedCleanupOk).toBe(true)
    expect(report.ok, report.summary).toBe(true)
  }, 220_000)
})
