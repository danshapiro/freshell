import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  runCodexGptMiniT2,
  codexGptMiniT2Available,
  CODEX_GPTMINI_MODEL,
  DEFAULT_CODEX_T2_SENTINEL,
  type CodexT2Run,
} from '../../../../port/oracle/harness/t2-live-codex.js'
import { assertT2Invariants, summarizeT2ForBaseline } from '../../../../port/oracle/harness/invariants.js'

/** Supplemental, explicitly gated Rust provider contract for Codex. */

const gateEnabled = !!process.env.FRESHELL_RUN_REAL_PROVIDER_CONTRACTS
const availability = await codexGptMiniT2Available()
const shouldRun = gateEnabled && availability.available
if (!shouldRun) {
  const why = !gateEnabled
    ? 'FRESHELL_RUN_REAL_PROVIDER_CONTRACTS not set'
    : `codex/GPT unavailable: ${availability.reason}`
  // eslint-disable-next-line no-console
  console.warn(`[T2-codex-rust] SKIPPED — ${why}`)
}

const describeLive = shouldRun ? describe.sequential : describe.skip

describeLive('T2 Rust provider contract (freshcodex + GPT)', () => {
  let run: CodexT2Run | null = null

  afterAll(async () => {
    if (run) await run.teardown().catch(() => {})
  })

  it('completes one isolated turn and satisfies the Rust behavioral contract', async () => {
    run = await runCodexGptMiniT2({ verbose: !!process.env.FRESHELL_T2_VERBOSE })
    const pid = run.handle.pid
    expect(run.handle.port).not.toBe(3001)
    expect(pid).toBeGreaterThan(0)
    expect(run.observation.sessionCreated).toBe(true)

    const cleanup = await run.teardown()
    const observation = run.observation
    run = null
    const report = assertT2Invariants(observation)
    const projection = summarizeT2ForBaseline(observation, report)

    expect(observation.provider).toBe('codex')
    expect(observation.model).toBe(CODEX_GPTMINI_MODEL)
    expect(observation.liveModelCalls).toBeGreaterThanOrEqual(1)
    expect(observation.liveModelCalls).toBeLessThanOrEqual(2)
    expect(observation.turnAccepted).toBe(true)
    expect(observation.turnCompleteEventObserved).toBe(true)
    expect(observation.turnCompleted).toBe(true)
    expect(observation.captureContainsSentinel).toBe(true)
    expect(observation.captureText).toContain(DEFAULT_CODEX_T2_SENTINEL)
    expect(observation.dbPath.startsWith(os.tmpdir())).toBe(true)
    expect(observation.dbPath).not.toContain(path.join(os.homedir(), '.codex'))
    expect(projection.shapes.wsServerMessageTypes.length).toBeGreaterThan(0)
    expect(cleanup.serverPidGone).toBe(true)
    expect(cleanup.strayOwnedPidsAfter).toEqual([])
    expect(cleanup.ownedCleanupOk).toBe(true)
    expect(report.ok, report.summary).toBe(true)
  }, 240_000)
})
