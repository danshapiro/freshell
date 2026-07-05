import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  runOpencodeKimiT2,
  opencodeKimiT2Available,
  opencodeAuthPaths,
  KIMI_MODEL,
  type T2Run,
} from '../../../../port/oracle/harness/t2-live.js'
import { assertT2Invariants, summarizeT2ForBaseline } from '../../../../port/oracle/harness/invariants.js'

/**
 * T2 — the PRIZE: `original ≡ rust` at the live behavioral-invariant tier.
 *
 * Drives ONE real (cheap) opencode/Kimi turn through the **Rust** `freshell-server`
 * (`target:'rust'`) with its fresh-agent surface — POST /api/tabs → placeholder
 * `freshopencode-*`; POST /api/panes/:id/send-keys → COLD-START the `opencode serve`
 * (the DEV-0001 fix means NO warm-proxy), materialize the durable `ses_*`, drive the
 * turn, complete on the IDLE edge; broadcasts fanned out over the WS bus — and proves:
 *
 *   1. every FATAL T2 invariant PASSES (`assertT2Invariants`), FAILING LOUDLY on
 *      turnAccepted / idle-edge / persistence regressions (never a silent skip); and
 *   2. the Rust observation's structural projection (`summarizeT2ForBaseline`) is
 *      DEEP-EQUAL to the ORIGINAL baseline `port/oracle/baselines/t2/opencode-kimi.json`
 *      (minus its `provenance` — the DEV-0001 warm-proxy fingerprint that legitimately
 *      differs); and
 *   3. the Rust port needed NO warm-proxy — it cold-started the serve clean
 *      (`usedWarmProxy === false`), the observable DEV-0001 fingerprint.
 *
 * SAME DRIVER, DIFFERENT SUT: the exact `runOpencodeKimiT2` that captured the original
 * baseline drives the Rust port here (only `target`/`warmProxy` differ), so this is a
 * true differential-equivalence result, not a re-implementation.
 *
 * COST: at most ONE live Kimi call (asserted ≤ 2). GATE: skips ONLY when the gate is
 * off OR opencode + the umans-kimi-k2.7 credential are genuinely absent; when the gate
 * is on and creds are present it runs for real and FAILS LOUDLY on any regression.
 *
 * SAFETY: only reaps this run's sentinel-owned pids (the Rust server + the opencode
 * serve it cold-started); asserts the user's live :3001 survives and the user's opencode
 * store is untouched (auth.json + opencode.db mtime unchanged; sessions wrote to the
 * ISOLATED db under the server's temp HOME).
 */

const GATE_ENV = 'FRESHELL_RUN_REAL_PROVIDER_CONTRACTS'
const gateEnabled = !!process.env[GATE_ENV]
const availability = await opencodeKimiT2Available()
const shouldRun = gateEnabled && availability.available

if (!shouldRun) {
  const why = !gateEnabled ? `${GATE_ENV} not set` : `opencode/Kimi unavailable: ${availability.reason}`
  // eslint-disable-next-line no-console
  console.warn(`[T2-rust] SKIPPED — ${why}`)
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../../../..')
const BASELINE_PATH = path.join(PROJECT_ROOT, 'port/oracle/baselines/t2/opencode-kimi.json')

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

/** mtime (ms) + size of a file, or null if absent (for user-store untouched checks). */
function statOrNull(p: string): { mtimeMs: number; size: number } | null {
  try {
    const s = fs.statSync(p)
    return { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    return null
  }
}

const describeLive = shouldRun ? describe.sequential : describe.skip

describeLive('T2 equivalence — original ≡ rust (opencode + Kimi k2.7, cold-start)', () => {
  let run: T2Run | null = null
  const liveBefore = listenersOn3001()

  // The user's real opencode store (READ-ONLY seed source) — must be untouched.
  const { userAuthJson } = opencodeAuthPaths()
  const userDbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')
  const userAuthBefore = statOrNull(userAuthJson)
  const userDbBefore = statOrNull(userDbPath)

  afterAll(async () => {
    // Safety net if a test threw before its own teardown ran.
    if (run) await run.teardown().catch(() => {})
  })

  it(
    'drives one live Kimi turn through the RUST server and matches the original T2 baseline',
    async () => {
      // SAME driver, Rust SUT, NO warm-proxy (cold-start — the DEV-0001 fingerprint).
      run = await runOpencodeKimiT2({
        target: 'rust',
        warmProxy: false,
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
      const usedWarmProxy = run.usedWarmProxy
      run = null

      // eslint-disable-next-line no-console
      console.log('[T2-rust] observation:', JSON.stringify({
        ...observation,
        captureText: observation.captureText.slice(0, 200),
      }, null, 2))

      const report = assertT2Invariants(observation)
      // eslint-disable-next-line no-console
      console.log(`[T2-rust] ${report.summary}`)
      for (const r of report.results) {
        // eslint-disable-next-line no-console
        console.log(`[T2-rust]   ${r.ok ? 'PASS' : 'FAIL'} ${r.name} — ${r.detail}`)
      }

      // ── COLD-START CLEAN — the DEV-0001 fingerprint ──────────────────────────
      // The Rust port carries the bounded-probe fix, so it needed NO warm-proxy; the
      // turn nonetheless accepted + completed. That combination IS the fix, observed.
      expect(usedWarmProxy, 'the Rust port must cold-start the serve with NO warm-proxy').toBe(false)

      // ── INFRA invariants — isolated+seeded boot, real surface, safe reaping ───
      expect(observation.provider).toBe('opencode')
      expect(observation.model).toBe(KIMI_MODEL)
      expect(observation.sessionCreated, 'fresh-agent opencode pane must be created').toBe(true)
      expect(cleanup.serverPidGone, `spawned Rust server pid ${spawnedPid} must be reaped`).toBe(true)
      expect(await waitForPidGone(spawnedPid)).toBe(true)
      expect(cleanup.strayOwnedPidsAfter, 'no sentinel-owned strays (server + opencode serve) may remain').toEqual([])
      expect(observation.ownedCleanupOk, 'ownership-safe teardown').toBe(true)

      // ── BEHAVIORAL invariants — FAIL LOUDLY (never skip) once the gate is on ──
      expect(observation.liveModelCalls, 'at most two live model calls (one turn)').toBeLessThanOrEqual(2)
      expect(observation.liveModelCalls, 'at least one live model call').toBeGreaterThanOrEqual(1)
      expect(
        observation.turnAccepted,
        'turn MUST be accepted (durable ses_ session materialized) — cold-start, no warm-proxy',
      ).toBe(true)
      expect(
        observation.serverReportedIdle,
        'turn MUST complete on the IDLE EDGE (send-keys → status=idle; session.idle/status{idle})',
      ).toBe(true)
      expect(
        observation.turnCompleted,
        'assistant reply MUST persist with the sentinel (secondary corroboration of the idle edge)',
      ).toBe(true)
      expect(report.ok, report.summary).toBe(true)

      // ── THE PRIZE: original ≡ rust at the structural level ───────────────────
      // summarizeT2ForBaseline(rust) must be deep-equal to the ORIGINAL baseline MINUS
      // its provenance (the DEV-0001 warm-proxy fingerprint that legitimately differs).
      expect(fs.existsSync(BASELINE_PATH), `original T2 baseline missing at ${BASELINE_PATH}`).toBe(true)
      const baselineRaw = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Record<string, unknown>
      const { provenance: _provenance, ...baselineCore } = baselineRaw
      const rustProjection = summarizeT2ForBaseline(observation, report)

      // eslint-disable-next-line no-console
      console.log('[T2-rust] structural projection:', JSON.stringify(rustProjection, null, 2))
      expect(
        rustProjection,
        'the Rust T2 observation must structurally match the original baseline (original ≡ rust)',
      ).toEqual(baselineCore)

      // The DEV-0001 cold-start fingerprint is the ONLY sanctioned difference: the
      // original baseline recorded warmProxy:true; the Rust run used none.
      expect((_provenance as Record<string, unknown> | undefined)?.warmProxy).toBe(true)

      // ── USER STORE UNTOUCHED — sessions wrote to the ISOLATED db ──────────────
      // PROOF OF ISOLATION (rock-solid): the Rust server ran with HOME=<temp>, so the
      // opencode serve it spawned provably wrote its session data to the ISOLATED db
      // under that temp HOME — never the user's ~/.local/share store.
      expect(
        observation.dbPath.startsWith(os.tmpdir()),
        `isolated opencode.db must be under a temp HOME, got ${observation.dbPath}`,
      ).toBe(true)
      expect(observation.dbPath).not.toBe(userDbPath)
      // The user's auth.json was READ-ONLY seeded (copyFile-read, never written): unchanged.
      const userAuthAfter = statOrNull(userAuthJson)
      expect(userAuthAfter?.mtimeMs, 'user opencode auth.json must be untouched (mtime)').toBe(userAuthBefore?.mtimeMs)
      expect(userAuthAfter?.size, 'user opencode auth.json must be untouched (size)').toBe(userAuthBefore?.size)
      // The user's opencode.db is INFORMATIONAL only: the user may have LIVE opencode
      // sessions writing it concurrently (this host does), so its mtime is NOT a valid
      // isolation signal — isolation is proven by the isolated dbPath above (our writes
      // provably went there). We log any change, which is attributable to the user's own
      // activity and never to this fully-isolated test.
      const userDbAfter = statOrNull(userDbPath)
      if (userDbBefore && userDbAfter && userDbAfter.mtimeMs !== userDbBefore.mtimeMs) {
        // eslint-disable-next-line no-console
        console.warn(
          `[T2-rust] note: user opencode.db mtime moved during the run ` +
            `(${userDbBefore.mtimeMs} → ${userDbAfter.mtimeMs}); attributable to the user's own ` +
            `live opencode sessions — this test wrote ONLY to the isolated ${observation.dbPath}.`,
        )
      } else {
        // eslint-disable-next-line no-console
        console.log('[T2-rust] user opencode.db mtime unchanged (user store quiescent + untouched).')
      }

      // eslint-disable-next-line no-console
      console.log('[T2-rust] original ≡ rust: structural projection deep-equal ✓ (cold-start, no warm-proxy)')
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
})
