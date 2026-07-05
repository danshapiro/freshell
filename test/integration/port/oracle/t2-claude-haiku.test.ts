import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  runClaudeHaikuT2,
  claudeHaikuT2Available,
  claudeVersion,
  claudeCredPaths,
  CLAUDE_HAIKU_MODEL,
  DEFAULT_CLAUDE_T2_SENTINEL,
  type ClaudeT2Run,
} from '../../../../port/oracle/harness/t2-live-claude.js'
import { assertT2Invariants, summarizeT2ForBaseline } from '../../../../port/oracle/harness/invariants.js'

/**
 * T2 — LIVE behavioral-invariant conformance, freshclaude + Claude Haiku slice.
 *
 * Boots the ORIGINAL freshell server isolated + credential-seeded, drives ONE real
 * (cheap) Haiku turn through the real fresh-agent WS surface, and asserts the T2
 * BEHAVIORAL invariants (shape / presence / persistence / parseability / the
 * discrete freshAgent.turn.complete completion edge / wire) — never LLM-text
 * equality. The captured original-side observation is projected into
 * `port/oracle/baselines/t2/claude-haiku.json`, the baseline the Rust port is
 * later diffed against.
 *
 * COMPLETION EDGE: the PRIMARY signal is the discrete `freshAgent.turn.complete`
 * wire event, emitted ONLY on the Claude SDK result with `subtype === 'success'`
 * (server/sdk-bridge.ts → sdk.turn.complete → server/fresh-agent/sdk-events.ts →
 * freshAgent.turn.complete). The persisted `<uuid>.jsonl` transcript corroborates.
 *
 * COST: exactly ONE live model call per run, pinned to the cheapest Haiku tier.
 *
 * GATE: skips ONLY when the gate is off OR the claude binary + ~/.claude/.credentials.json
 * are genuinely absent. When the gate is ON and creds are present it runs for real
 * and FAILS LOUDLY on any regression (never silently skips). Never wired into the
 * shared suite — run via `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:oracle:t2`.
 *
 * SAFETY: only reaps processes carrying this run's ownership sentinel (the server +
 * the spawned claude CLI + any MCP grandchild); asserts the user's live server
 * (:3001) survives untouched AND the user's real ~/.claude/.credentials.json is
 * only READ (mtime unchanged) — all session data lands in the isolated HOME.
 */

const GATE_ENV = 'FRESHELL_RUN_REAL_PROVIDER_CONTRACTS'
const gateEnabled = !!process.env[GATE_ENV]
const availability = await claudeHaikuT2Available()
const shouldRun = gateEnabled && availability.available

if (!shouldRun) {
  const why = !gateEnabled ? `${GATE_ENV} not set` : `claude/Haiku unavailable: ${availability.reason}`
  // eslint-disable-next-line no-console
  console.warn(`[T2-claude] SKIPPED — ${why}`)
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../../../..')
const BASELINE_PATH = path.join(PROJECT_ROOT, 'port/oracle/baselines/t2/claude-haiku.json')

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitForPidGone(pid: number, budgetMs = 10_000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < budgetMs) {
    if (!pidAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return !pidAlive(pid)
}

/** Best-effort: pids listening on :3001 (the user's live freshell), via ss. */
function listenersOn3001(): number[] {
  const r = spawnSync('bash', ['-lc', "ss -ltnp 2>/dev/null | grep ':3001 ' || true"], { encoding: 'utf8' })
  if (r.status !== 0 || !r.stdout) return []
  const pids = new Set<number>()
  for (const m of r.stdout.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]))
  return [...pids]
}

/** mtime (ms) of the user's real credential file, or -1 if absent. */
function credentialMtimeMs(): number {
  try { return fs.statSync(claudeCredPaths().userCredentials).mtimeMs } catch { return -1 }
}

const describeLive = shouldRun ? describe.sequential : describe.skip

describeLive('T2 live freshclaude + Claude Haiku behavioral invariants (original server)', () => {
  let run: ClaudeT2Run | null = null
  const liveBefore = listenersOn3001()
  const userCredMtimeBefore = credentialMtimeMs()

  afterAll(async () => {
    // Safety net if a test threw before its own teardown ran.
    if (run) await run.teardown().catch(() => {})
  })

  it(
    'drives one live Haiku turn through the fresh-agent WS surface and satisfies every T2 invariant',
    async () => {
      run = await runClaudeHaikuT2({ verbose: !!process.env.FRESHELL_T2_VERBOSE })
      const spawnedPid = run.handle.pid

      // Never the live instance.
      expect(run.handle.port).not.toBe(3001)
      expect(spawnedPid).toBeGreaterThan(0)
      for (const livePid of liveBefore) expect(spawnedPid).not.toBe(livePid)
      expect(pidAlive(spawnedPid)).toBe(true)

      // Ownership-safe teardown, then fold the ownership facts into the obs.
      const cleanup = await run.teardown()
      const observation = run.observation
      run = null

      // eslint-disable-next-line no-console
      console.log('[T2-claude] observation:', JSON.stringify({
        ...observation,
        captureText: observation.captureText.slice(0, 200),
      }, null, 2))

      const report = assertT2Invariants(observation)
      // eslint-disable-next-line no-console
      console.log(`[T2-claude] ${report.summary}`)
      for (const r of report.results) {
        // eslint-disable-next-line no-console
        console.log(`[T2-claude]   ${r.ok ? 'PASS' : 'FAIL'} ${r.name} — ${r.detail}`)
      }

      // ── INFRA invariants — isolated+seeded boot, real WS surface, ownership-safe
      //    reaping, live :3001 untouched ──────────────────────────────────────────
      expect(observation.model).toBe(CLAUDE_HAIKU_MODEL)
      expect(observation.sessionCreated, 'freshclaude session must be created').toBe(true)
      expect(cleanup.serverPidGone, `spawned server pid ${spawnedPid} must be reaped`).toBe(true)
      expect(await waitForPidGone(spawnedPid)).toBe(true)
      expect(cleanup.strayOwnedPidsAfter, 'no sentinel-owned strays may remain').toEqual([])

      // ── BEHAVIORAL invariants — FAIL LOUDLY (never skip) once the gate is on ─────
      // The gate already guaranteed the claude binary + credential are present, so a
      // stalled / incomplete / unaccepted turn is a genuine regression, not an
      // expected condition — there is nothing left to defer.
      expect(observation.liveModelCalls, 'exactly one live model call').toBe(1)
      expect(
        observation.turnAccepted,
        'turn MUST be accepted (durable Claude session UUID materialized)',
      ).toBe(true)
      expect(
        observation.turnCompleteEventObserved,
        'turn MUST complete on the DISCRETE freshAgent.turn.complete edge (SDK result subtype=success)',
      ).toBe(true)
      expect(
        observation.turnCompleted,
        'assistant reply MUST persist to the .jsonl transcript with the sentinel (corroborates the edge)',
      ).toBe(true)
      expect(
        observation.captureContainsSentinel,
        `assistant reply MUST contain the pinned sentinel "${DEFAULT_CLAUDE_T2_SENTINEL}"`,
      ).toBe(true)
      expect(report.ok, report.summary).toBe(true)

      // ── Persist the LLM-text-free original-side baseline (only on full green) ────
      const baseline = {
        ...summarizeT2ForBaseline(observation, report),
        provenance: {
          capturedAt: new Date().toISOString(),
          capturedBy: 'test/integration/port/oracle/t2-claude-haiku.test.ts',
          model: observation.model,
          claudeVersion: claudeVersion(),
          completionSignal: 'freshAgent.turn.complete/subtype=success',
          drivePath: 'ws freshAgent.create + freshAgent.send',
          transcript: 'isolated <CLAUDE_HOME>/.claude/projects/<cwd-hash>/<uuid>.jsonl',
          note:
            'Structural, LLM-text-free baseline. The Rust port drives the identical WS fresh-agent ' +
            'surface and its T2 observation is projected via summarizeT2ForBaseline() and diffed against ' +
            'this file. Claude is SDK-driven: completion is the discrete freshAgent.turn.complete edge, ' +
            'NOT opencode\'s idle poll; the durable id is the Claude session UUID (from session.init ' +
            'cliSessionId + the persisted .jsonl name); the placeholder is the SDK bridge\'s bare nanoid.',
        },
      }
      fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true })
      fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
      // eslint-disable-next-line no-console
      console.log(`[T2-claude] baseline persisted → ${BASELINE_PATH}`)
    },
    220_000,
  )

  it('left the user\'s live server (:3001) untouched', () => {
    for (const livePid of liveBefore) {
      expect(pidAlive(livePid), `live server pid ${livePid} must still be alive`).toBe(true)
    }
    if (liveBefore.length > 0) {
      const after = listenersOn3001()
      expect(after.length, ':3001 must still have a listener').toBeGreaterThan(0)
    }
  })

  it('only READ the user\'s real ~/.claude/.credentials.json (mtime unchanged)', () => {
    const after = credentialMtimeMs()
    expect(after, 'user credential must still exist').toBeGreaterThan(0)
    // copyFile only reads the source; the isolated HOME gets the writable copy.
    expect(after, 'user ~/.claude/.credentials.json must NOT be modified').toBe(userCredMtimeBefore)
  })
})
