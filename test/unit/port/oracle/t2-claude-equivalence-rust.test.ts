import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  runClaudeHaikuT2,
  claudeHaikuT2Available,
  claudeCredPaths,
  CLAUDE_HAIKU_MODEL,
  DEFAULT_CLAUDE_T2_SENTINEL,
  type ClaudeT2Run,
} from '../../../../port/oracle/harness/t2-live-claude.js'
import { assertT2Invariants, summarizeT2ForBaseline } from '../../../../port/oracle/harness/invariants.js'

/**
 * T2 — the claude PRIZE: `original ≡ rust` at the live behavioral-invariant tier.
 *
 * Drives ONE real (cheap) claude/Haiku turn through the **Rust** `freshell-server`
 * (`target:'rust'`) over the identical fresh-agent WS surface the original uses —
 * `freshAgent.create {sessionType:'freshclaude'}` spawns the ONE sanctioned Node claude
 * sidecar (wrapping @anthropic-ai/claude-agent-sdk, which has NO Rust equivalent; ADR
 * Decision 2), which starts the SDK session and surfaces the SDK bridge's BARE nanoid
 * placeholder id (claude has NO placeholder→durable materialization — its send returns
 * void); `freshAgent.send` drives the turn; the durable id is the Claude CLI session UUID
 * (from session.init cliSessionId + the persisted `.jsonl` name); completion is the
 * DISCRETE `freshAgent.turn.complete` wire event (emitted ONLY when the SDK `result`
 * carries subtype==='success') — and proves:
 *
 *   1. every FATAL T2 invariant PASSES (`assertT2Invariants`), FAILING LOUDLY on
 *      turnAccepted / success-edge completion / persistence regressions (never a silent
 *      skip); and
 *   2. the Rust observation's structural projection (`summarizeT2ForBaseline`) is
 *      DEEP-EQUAL to the ORIGINAL baseline `port/oracle/baselines/t2/claude-haiku.json`
 *      (minus its `provenance`) — original ≡ rust at T2.
 *
 * SAME DRIVER, DIFFERENT SUT: the exact `runClaudeHaikuT2` that captured the original
 * baseline drives the Rust port here (only `target` differs), so this is a true
 * differential-equivalence result, not a re-implementation. Both spawn the SAME real
 * `claude` CLI under the isolated CLAUDE_HOME (the Rust path via the Node sidecar).
 *
 * COST: at most TWO live claude calls (asserted ≤ 2; this run makes exactly ONE). GATE:
 * skips ONLY when the gate is off OR the claude binary + ~/.claude/.credentials.json are
 * genuinely absent; when the gate is on and creds are present it runs for real and FAILS
 * LOUDLY on any regression.
 *
 * SAFETY: only reaps this run's sentinel-owned pids (the Rust server + the Node sidecar +
 * the claude CLI grandchild it spawned); asserts the user's live :3001 survives and the
 * claude transcript wrote to the ISOLATED CLAUDE_HOME (the transcript path is under a temp
 * HOME). The user's real ~/.claude/.credentials.json is a READ-ONLY seed source; its mtime
 * is INFORMATIONAL only — the user may have live claude sessions (OAuth token refresh
 * rewrites `.credentials.json`) concurrently, so isolation is proven by the isolated
 * transcript path, not user-store mtime-equality.
 */

const GATE_ENV = 'FRESHELL_RUN_REAL_PROVIDER_CONTRACTS'
const gateEnabled = !!process.env[GATE_ENV]
const availability = await claudeHaikuT2Available()
const shouldRun = gateEnabled && availability.available

if (!shouldRun) {
  const why = !gateEnabled ? `${GATE_ENV} not set` : `claude/Haiku unavailable: ${availability.reason}`
  // eslint-disable-next-line no-console
  console.warn(`[T2-claude-rust] SKIPPED — ${why}`)
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

/** mtime (ms) of a file, or -1 if absent. */
function mtimeMs(filePath: string): number {
  try { return fs.statSync(filePath).mtimeMs } catch { return -1 }
}

const describeLive = shouldRun ? describe.sequential : describe.skip

describeLive('T2 equivalence — original ≡ rust (freshclaude + Claude Haiku, Node claude-sidecar)', () => {
  let run: ClaudeT2Run | null = null
  const liveBefore = listenersOn3001()

  // The user's real ~/.claude/.credentials.json seed source (READ-ONLY) — mtime is
  // informational (below).
  const { userCredentials } = claudeCredPaths()
  const userCredMtimeBefore = mtimeMs(userCredentials)

  afterAll(async () => {
    // Safety net if a test threw before its own teardown ran.
    if (run) await run.teardown().catch(() => {})
  })

  it(
    'drives one live claude turn through the RUST server (+sidecar) and matches the original T2 baseline',
    async () => {
      // SAME driver, Rust SUT. Both spawn the REAL claude CLI under the isolated CLAUDE_HOME
      // (the Rust path routes through the ONE sanctioned Node sidecar).
      run = await runClaudeHaikuT2({
        target: 'rust',
        verbose: !!process.env.FRESHELL_T2_VERBOSE,
      })
      const spawnedPid = run.handle.pid

      // Never the live instance.
      expect(run.target).toBe('rust')
      expect(run.handle.target).toBe('rust')
      expect(run.handle.port).not.toBe(3001)
      expect(spawnedPid).toBeGreaterThan(0)
      for (const livePid of liveBefore) expect(spawnedPid).not.toBe(livePid)
      expect(pidAlive(spawnedPid)).toBe(true)

      // Ownership-safe teardown, then fold the ownership facts into the obs.
      const cleanup = await run.teardown()
      const observation = run.observation
      run = null

      // eslint-disable-next-line no-console
      console.log('[T2-claude-rust] observation:', JSON.stringify({
        ...observation,
        captureText: observation.captureText.slice(0, 200),
      }, null, 2))

      const report = assertT2Invariants(observation)
      // eslint-disable-next-line no-console
      console.log(`[T2-claude-rust] ${report.summary}`)
      for (const r of report.results) {
        // eslint-disable-next-line no-console
        console.log(`[T2-claude-rust]   ${r.ok ? 'PASS' : 'FAIL'} ${r.name} — ${r.detail}`)
      }

      // ── INFRA invariants — isolated+seeded boot, real WS surface, safe reaping ──
      expect(observation.provider).toBe('claude')
      expect(observation.model).toBe(CLAUDE_HAIKU_MODEL)
      expect(observation.sessionCreated, 'freshclaude session must be created').toBe(true)
      expect(cleanup.serverPidGone, `spawned Rust server pid ${spawnedPid} must be reaped`).toBe(true)
      expect(await waitForPidGone(spawnedPid)).toBe(true)
      expect(
        cleanup.strayOwnedPidsAfter,
        'no sentinel-owned strays (server + Node sidecar + claude CLI) may remain',
      ).toEqual([])
      expect(observation.ownedCleanupOk, 'ownership-safe teardown').toBe(true)

      // ── BEHAVIORAL invariants — FAIL LOUDLY (never skip) once the gate is on ──
      expect(observation.liveModelCalls, 'at most two live model calls (one turn)').toBeLessThanOrEqual(2)
      expect(observation.liveModelCalls, 'at least one live model call').toBeGreaterThanOrEqual(1)
      expect(
        observation.turnAccepted,
        'turn MUST be accepted (durable Claude UUID surfaced via session.init + the .jsonl)',
      ).toBe(true)
      expect(
        observation.turnCompleteEventObserved,
        'turn MUST complete on the DISCRETE success-guarded freshAgent.turn.complete edge (SDK result subtype=success)',
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

      // ── THE PRIZE: original ≡ rust at the structural level ───────────────────
      // summarizeT2ForBaseline(rust) must be deep-equal to the ORIGINAL baseline MINUS its
      // provenance (capture timestamp / claude version — legitimately per-run).
      expect(fs.existsSync(BASELINE_PATH), `original claude T2 baseline missing at ${BASELINE_PATH}`).toBe(true)
      const baselineRaw = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Record<string, unknown>
      const { provenance: _provenance, ...baselineCore } = baselineRaw
      const rustProjection = summarizeT2ForBaseline(observation, report)

      // eslint-disable-next-line no-console
      console.log('[T2-claude-rust] structural projection:', JSON.stringify(rustProjection, null, 2))
      expect(
        rustProjection,
        'the Rust claude T2 observation must structurally match the original baseline (original ≡ rust)',
      ).toEqual(baselineCore)

      // ── USER STORE UNTOUCHED — the transcript wrote to the ISOLATED CLAUDE_HOME ──
      // PROOF OF ISOLATION (rock-solid): the Rust server ran with HOME=<temp> and
      // CLAUDE_HOME=<temp>/.claude, so the claude CLI the sidecar spawned wrote its
      // `<uuid>.jsonl` transcript there — never the user's ~/.claude. The transcript path
      // proves it.
      expect(
        observation.dbPath.startsWith(os.tmpdir()),
        `isolated claude transcript must be under a temp HOME, got ${observation.dbPath}`,
      ).toBe(true)
      expect(observation.dbPath).not.toContain(path.join(os.homedir(), '.claude'))

      // The user's ~/.claude/.credentials.json was READ-ONLY seeded (copyFile-read, never
      // written). Its mtime is INFORMATIONAL only: the user may have LIVE claude sessions
      // concurrently (a claude OAuth token refresh rewrites `.credentials.json`), so it is
      // NOT a valid isolation signal — isolation is proven by the isolated transcript path.
      const credAfter = mtimeMs(userCredentials)
      if (credAfter !== userCredMtimeBefore) {
        // eslint-disable-next-line no-console
        console.warn(
          `[T2-claude-rust] note: user ~/.claude/.credentials.json mtime moved during the run ` +
            `(${userCredMtimeBefore} → ${credAfter}); attributable to the user's own live claude ` +
            `(OAuth token refresh) — this test only READ it and wrote ONLY under the isolated ${observation.dbPath}.`,
        )
      } else {
        // eslint-disable-next-line no-console
        console.log('[T2-claude-rust] user ~/.claude/.credentials.json mtime unchanged (read-only seed, untouched).')
      }

      // eslint-disable-next-line no-console
      console.log('[T2-claude-rust] original ≡ rust: structural projection deep-equal ✓ (Node claude-sidecar over the wire)')
    },
    240_000,
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
})
