import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  runOpencodeKimiT2,
  opencodeKimiT2Available,
  KIMI_MODEL,
  type T2Run,
} from '../../../../port/oracle/harness/t2-live.js'
import { assertT2Invariants, summarizeT2ForBaseline } from '../../../../port/oracle/harness/invariants.js'

/**
 * T2 — LIVE behavioral-invariant conformance, opencode + Kimi k2.7 slice.
 *
 * Boots the ORIGINAL freshell server isolated + auth-seeded, WARMS the opencode
 * serve via the `OPENCODE_CMD` warm-proxy (steps past DEV-0001's cold-accept race
 * with ZERO source mutation — see port/oracle/notes/t2-opencode-stall.md), drives
 * ONE real (cheap) Kimi turn through the real fresh-agent surface, and asserts the
 * T2 BEHAVIORAL invariants (shape/presence/persistence/parseability/idle-edge/wire)
 * — never LLM-text equality. The captured original-side observation is projected
 * into `port/oracle/baselines/t2/opencode-kimi.json`, the baseline the Rust port
 * will later be diffed against.
 *
 * COST: exactly ONE live model call per run, pinned to the cheapest wired model.
 *
 * GATE: skips ONLY when the gate is off OR opencode + the umans-kimi-k2.7
 * credential are genuinely absent. When the gate is ON and creds are present it
 * runs for real and FAILS LOUDLY on any regression (never silently skips). Never
 * wired into the shared suite — run via `npm run test:oracle:t2`.
 *
 * SAFETY: only reaps processes carrying this run's ownership sentinel (the server,
 * the warm-proxy shim, and the inner opencode serve); asserts the user's live
 * server (:3001) and its pid survive untouched.
 */

const GATE_ENV = 'FRESHELL_RUN_REAL_PROVIDER_CONTRACTS'
const gateEnabled = !!process.env[GATE_ENV]
const availability = await opencodeKimiT2Available()
const shouldRun = gateEnabled && availability.available

if (!shouldRun) {
  const why = !gateEnabled
    ? `${GATE_ENV} not set`
    : `opencode/Kimi unavailable: ${availability.reason}`
  // eslint-disable-next-line no-console
  console.warn(`[T2] SKIPPED — ${why}`)
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

/** The opencode CLI version string (recorded in the baseline provenance). */
function opencodeVersion(): string {
  const r = spawnSync('opencode', ['--version'], { encoding: 'utf8', timeout: 10_000 })
  return r.status === 0 ? r.stdout.trim().split('\n')[0] : 'unknown'
}

const describeLive = shouldRun ? describe.sequential : describe.skip

describeLive('T2 live opencode + Kimi k2.7 behavioral invariants (original server)', () => {
  let run: T2Run | null = null
  const liveBefore = listenersOn3001()

  afterAll(async () => {
    // Safety net if a test threw before its own teardown ran.
    if (run) await run.teardown().catch(() => {})
  })

  it(
    'drives one live Kimi turn through the warm-proxied server and satisfies every T2 invariant',
    async () => {
      run = await runOpencodeKimiT2({ verbose: !!process.env.FRESHELL_T2_VERBOSE })
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
      console.log('[T2] observation:', JSON.stringify({
        ...observation,
        captureText: observation.captureText.slice(0, 200),
      }, null, 2))

      const report = assertT2Invariants(observation)
      // eslint-disable-next-line no-console
      console.log(`[T2] ${report.summary}`)
      for (const r of report.results) {
        // eslint-disable-next-line no-console
        console.log(`[T2]   ${r.ok ? 'PASS' : 'FAIL'} ${r.name} — ${r.detail}`)
      }

      // ── INFRA invariants — the T2 spine (isolated+seeded boot, real fresh-agent
      //    surface, ownership-safe reaping, live :3001 untouched) ──────────────
      expect(observation.model).toBe(KIMI_MODEL)
      expect(observation.sessionCreated, 'fresh-agent opencode pane must be created').toBe(true)
      expect(cleanup.serverPidGone, `spawned server pid ${spawnedPid} must be reaped`).toBe(true)
      expect(await waitForPidGone(spawnedPid)).toBe(true)
      expect(cleanup.strayOwnedPidsAfter, 'no sentinel-owned strays may remain').toEqual([])

      // ── BEHAVIORAL invariants — FAIL LOUDLY (never skip) once the gate is on ──
      // DEV-0001 is stepped around by the warm-proxy, so a stalled/incomplete turn
      // is now a genuine regression, not an expected condition. The gate already
      // guaranteed opencode + creds are present, so there is nothing left to defer.
      expect(observation.liveModelCalls, 'exactly one live model call').toBe(1)
      expect(
        observation.turnAccepted,
        'turn MUST be accepted (durable ses_ session materialized) — warm-proxy removed the DEV-0001 stall',
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

      // ── Persist the LLM-text-free original-side baseline (only on full green) ──
      const baseline = {
        ...summarizeT2ForBaseline(observation, report),
        provenance: {
          capturedAt: new Date().toISOString(),
          capturedBy: 'test/integration/port/oracle/t2-opencode-kimi.test.ts',
          opencodeVersion: opencodeVersion(),
          warmProxy: true,
          warmProxyReason:
            'DEV-0001 cold-serve health-probe wedge; warmed via OPENCODE_CMD passthrough (zero source mutation). ' +
            'The Rust port implements the probe fix natively and needs NO warm-proxy.',
          note:
            'Structural, LLM-text-free baseline. The Rust port drives the identical surface and its T2 ' +
            'observation is projected via summarizeT2ForBaseline() and diffed against this file.',
        },
      }
      fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true })
      fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
      // eslint-disable-next-line no-console
      console.log(`[T2] baseline persisted → ${BASELINE_PATH}`)
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
