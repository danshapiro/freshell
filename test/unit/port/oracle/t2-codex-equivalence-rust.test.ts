import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  runCodexGptMiniT2,
  codexGptMiniT2Available,
  codexCredPaths,
  CODEX_GPTMINI_MODEL,
  DEFAULT_CODEX_T2_SENTINEL,
  type CodexT2Run,
} from '../../../../port/oracle/harness/t2-live-codex.js'
import { assertT2Invariants, summarizeT2ForBaseline } from '../../../../port/oracle/harness/invariants.js'

/**
 * T2 — the codex PRIZE: `original ≡ rust` at the live behavioral-invariant tier.
 *
 * Drives ONE real (cheap) codex/GPT turn (gpt-5.3-codex-spark, effort low) through the
 * **Rust** `freshell-server` (`target:'rust'`) over the identical fresh-agent WS surface
 * the original uses — `freshAgent.create {sessionType:'freshcodex'}` spawns the REAL
 * `codex app-server` sidecar under the isolated CODEX_HOME and starts a thread (a STABLE
 * UUID id — codex has NO placeholder→durable materialization); `freshAgent.send` drives the
 * turn; completion is the DISCRETE, STATUS-GUARDED `freshAgent.turn.complete` wire event
 * (emitted only when the codex `turn/completed` carries status `completed`) — and proves:
 *
 *   1. every FATAL T2 invariant PASSES (`assertT2Invariants`), FAILING LOUDLY on
 *      turnAccepted / completion-edge / persistence regressions (never a silent skip); and
 *   2. the Rust observation's structural projection (`summarizeT2ForBaseline`) is
 *      DEEP-EQUAL to the ORIGINAL baseline `port/oracle/baselines/t2/codex-gptmini.json`
 *      (minus its `provenance`) — original ≡ rust at T2.
 *
 * SAME DRIVER, DIFFERENT SUT: the exact `runCodexGptMiniT2` that captured the original
 * baseline drives the Rust port here (only `target` differs), so this is a true
 * differential-equivalence result, not a re-implementation.
 *
 * COST: at most ONE live codex call (asserted ≤ 2). GATE: skips ONLY when the gate is off
 * OR the codex binary + ~/.codex/{auth.json,config.toml} are genuinely absent; when the
 * gate is on and creds are present it runs for real and FAILS LOUDLY on any regression.
 *
 * SAFETY: only reaps this run's sentinel-owned pids (the Rust server + the codex app-server
 * it spawned); asserts the user's live :3001 survives and the codex rollout wrote to the
 * ISOLATED CODEX_HOME (the transcript path is under a temp HOME). The user's real ~/.codex/
 * {auth.json,config.toml} are READ-ONLY seed sources; their mtime is INFORMATIONAL only —
 * the user may have live codex sessions (OAuth token refresh rewrites auth.json)
 * concurrently, so isolation is proven by the isolated transcript path, not user-store
 * mtime-equality.
 */

const GATE_ENV = 'FRESHELL_RUN_REAL_PROVIDER_CONTRACTS'
const gateEnabled = !!process.env[GATE_ENV]
const availability = await codexGptMiniT2Available()
const shouldRun = gateEnabled && availability.available

if (!shouldRun) {
  const why = !gateEnabled ? `${GATE_ENV} not set` : `codex/GPT unavailable: ${availability.reason}`
  // eslint-disable-next-line no-console
  console.warn(`[T2-codex-rust] SKIPPED — ${why}`)
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../../../..')
const BASELINE_PATH = path.join(PROJECT_ROOT, 'port/oracle/baselines/t2/codex-gptmini.json')

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

describeLive('T2 equivalence — original ≡ rust (freshcodex + cheap-GPT, codex app-server)', () => {
  let run: CodexT2Run | null = null
  const liveBefore = listenersOn3001()

  // The user's real ~/.codex seed sources (READ-ONLY) — mtime is informational (below).
  const { userAuth, userConfig } = codexCredPaths()
  const userAuthMtimeBefore = mtimeMs(userAuth)
  const userConfigMtimeBefore = mtimeMs(userConfig)

  afterAll(async () => {
    // Safety net if a test threw before its own teardown ran.
    if (run) await run.teardown().catch(() => {})
  })

  it(
    'drives one live codex turn through the RUST server and matches the original T2 baseline',
    async () => {
      // SAME driver, Rust SUT. Both spawn the REAL codex app-server under the isolated home.
      run = await runCodexGptMiniT2({
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
      console.log('[T2-codex-rust] observation:', JSON.stringify({
        ...observation,
        captureText: observation.captureText.slice(0, 200),
      }, null, 2))

      const report = assertT2Invariants(observation)
      // eslint-disable-next-line no-console
      console.log(`[T2-codex-rust] ${report.summary}`)
      for (const r of report.results) {
        // eslint-disable-next-line no-console
        console.log(`[T2-codex-rust]   ${r.ok ? 'PASS' : 'FAIL'} ${r.name} — ${r.detail}`)
      }

      // ── INFRA invariants — isolated+seeded boot, real WS surface, safe reaping ──
      expect(observation.provider).toBe('codex')
      expect(observation.model).toBe(CODEX_GPTMINI_MODEL)
      expect(observation.sessionCreated, 'freshcodex session must be created').toBe(true)
      expect(cleanup.serverPidGone, `spawned Rust server pid ${spawnedPid} must be reaped`).toBe(true)
      expect(await waitForPidGone(spawnedPid)).toBe(true)
      expect(
        cleanup.strayOwnedPidsAfter,
        'no sentinel-owned strays (server + codex app-server) may remain',
      ).toEqual([])
      expect(observation.ownedCleanupOk, 'ownership-safe teardown').toBe(true)

      // ── BEHAVIORAL invariants — FAIL LOUDLY (never skip) once the gate is on ──
      expect(observation.liveModelCalls, 'at most two live model calls (one turn)').toBeLessThanOrEqual(2)
      expect(observation.liveModelCalls, 'at least one live model call').toBeGreaterThanOrEqual(1)
      expect(
        observation.turnAccepted,
        'turn MUST be accepted (freshAgent.send.accepted → codex turn/start dispatched)',
      ).toBe(true)
      expect(
        observation.turnCompleteEventObserved,
        'turn MUST complete on the DISCRETE status-guarded freshAgent.turn.complete edge',
      ).toBe(true)
      expect(
        observation.turnCompleted,
        'assistant reply MUST persist to the rollout .jsonl with the sentinel (corroborates the edge)',
      ).toBe(true)
      expect(
        observation.captureContainsSentinel,
        `assistant reply MUST contain the pinned sentinel "${DEFAULT_CODEX_T2_SENTINEL}"`,
      ).toBe(true)
      expect(report.ok, report.summary).toBe(true)

      // ── THE PRIZE: original ≡ rust at the structural level ──────────────────
      // summarizeT2ForBaseline(rust) must be deep-equal to the ORIGINAL baseline MINUS its
      // provenance (capture timestamp / codex version — legitimately per-run).
      expect(fs.existsSync(BASELINE_PATH), `original codex T2 baseline missing at ${BASELINE_PATH}`).toBe(true)
      const baselineRaw = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Record<string, unknown>
      const { provenance: _provenance, ...baselineCore } = baselineRaw
      const rustProjection = summarizeT2ForBaseline(observation, report)

      // eslint-disable-next-line no-console
      console.log('[T2-codex-rust] structural projection:', JSON.stringify(rustProjection, null, 2))
      expect(
        rustProjection,
        'the Rust codex T2 observation must structurally match the original baseline (original ≡ rust)',
      ).toEqual(baselineCore)

      // ── USER STORE UNTOUCHED — the rollout wrote to the ISOLATED CODEX_HOME ──
      // PROOF OF ISOLATION (rock-solid): the Rust server ran with HOME=<temp>, so the codex
      // app-server it spawned resolved CODEX_HOME=<temp>/.codex and wrote its rollout .jsonl
      // there — never the user's ~/.codex. The transcript path proves it.
      expect(
        observation.dbPath.startsWith(os.tmpdir()),
        `isolated codex rollout must be under a temp HOME, got ${observation.dbPath}`,
      ).toBe(true)
      expect(observation.dbPath).not.toContain(path.join(os.homedir(), '.codex'))

      // The user's ~/.codex/{auth.json,config.toml} were READ-ONLY seeded (copyFile-read,
      // never written). Their mtime is INFORMATIONAL only: the user may have LIVE codex
      // sessions concurrently (a codex OAuth token refresh rewrites auth.json), so it is NOT
      // a valid isolation signal — isolation is proven by the isolated transcript path above.
      const authAfter = mtimeMs(userAuth)
      const configAfter = mtimeMs(userConfig)
      if (authAfter !== userAuthMtimeBefore) {
        // eslint-disable-next-line no-console
        console.warn(
          `[T2-codex-rust] note: user ~/.codex/auth.json mtime moved during the run ` +
            `(${userAuthMtimeBefore} → ${authAfter}); attributable to the user's own live codex ` +
            `(token refresh) — this test only READ it and wrote ONLY to the isolated ${observation.dbPath}.`,
        )
      } else {
        // eslint-disable-next-line no-console
        console.log('[T2-codex-rust] user ~/.codex/auth.json mtime unchanged (read-only seed, untouched).')
      }
      if (configAfter !== userConfigMtimeBefore) {
        // eslint-disable-next-line no-console
        console.warn(
          `[T2-codex-rust] note: user ~/.codex/config.toml mtime moved (${userConfigMtimeBefore} → ${configAfter}); ` +
            `attributable to the user's own codex activity — this test only READ it.`,
        )
      }

      // eslint-disable-next-line no-console
      console.log('[T2-codex-rust] original ≡ rust: structural projection deep-equal ✓ (codex app-server over the wire)')
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
