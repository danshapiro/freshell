import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  runClaudeHaikuT2,
  claudeHaikuT2Available,
  CLAUDE_HAIKU_MODEL,
  DEFAULT_CLAUDE_T2_SENTINEL,
  type ClaudeT2Run,
} from '../../../../port/oracle/harness/t2-live-claude.js'
import { assertT2Invariants, summarizeT2ForBaseline } from '../../../../port/oracle/harness/invariants.js'

/** Supplemental, explicitly gated Rust provider contract for Claude/Haiku. */

const gateEnabled = !!process.env.FRESHELL_RUN_REAL_PROVIDER_CONTRACTS
const availability = await claudeHaikuT2Available()
const shouldRun = gateEnabled && availability.available
if (!shouldRun) {
  const why = !gateEnabled
    ? 'FRESHELL_RUN_REAL_PROVIDER_CONTRACTS not set'
    : `claude/Haiku unavailable: ${availability.reason}`
  // eslint-disable-next-line no-console
  console.warn(`[T2-claude-rust] SKIPPED — ${why}`)
}

const describeLive = shouldRun ? describe.sequential : describe.skip

describeLive('T2 Rust provider contract (freshclaude + Claude Haiku)', () => {
  let run: ClaudeT2Run | null = null

  afterAll(async () => {
    if (run) await run.teardown().catch(() => {})
  })

  it('completes one isolated turn and satisfies the Rust behavioral contract', async () => {
    run = await runClaudeHaikuT2({ verbose: !!process.env.FRESHELL_T2_VERBOSE })
    const pid = run.handle.pid
    expect(run.handle.port).not.toBe(3001)
    expect(pid).toBeGreaterThan(0)
    expect(run.observation.sessionCreated).toBe(true)

    const cleanup = await run.teardown()
    const observation = run.observation
    run = null
    const report = assertT2Invariants(observation)
    const projection = summarizeT2ForBaseline(observation, report)

    expect(observation.provider).toBe('claude')
    expect(observation.model).toBe(CLAUDE_HAIKU_MODEL)
    expect(observation.liveModelCalls).toBeGreaterThanOrEqual(1)
    expect(observation.liveModelCalls).toBeLessThanOrEqual(2)
    expect(observation.turnAccepted).toBe(true)
    expect(observation.turnCompleteEventObserved).toBe(true)
    expect(observation.turnCompleted).toBe(true)
    expect(observation.captureContainsSentinel).toBe(true)
    expect(observation.captureText).toContain(DEFAULT_CLAUDE_T2_SENTINEL)
    expect(observation.dbPath.startsWith(os.tmpdir())).toBe(true)
    expect(observation.dbPath).not.toContain(path.join(os.homedir(), '.claude'))
    expect(projection.shapes.wsServerMessageTypes.length).toBeGreaterThan(0)
    expect(cleanup.serverPidGone).toBe(true)
    expect(cleanup.strayOwnedPidsAfter).toEqual([])
    expect(cleanup.ownedCleanupOk).toBe(true)
    expect(report.ok, report.summary).toBe(true)
  }, 240_000)
})
