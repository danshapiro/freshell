import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  startExternalServer,
  type ExternalServerHandle,
} from '../../../../port/oracle/harness/external-server.js'
import { WsCaptureClient } from '../../../../port/oracle/harness/ws-capture-client.js'
import { ContractValidator } from '../../../../port/oracle/harness/contract-validator.js'
import { capturePtyScenario, hexDiff } from '../../../../port/oracle/harness/pty-capture.js'
import { scenarioByName } from '../../../../port/oracle/fixtures/pty-scenarios.js'

/**
 * MUTATION-VALIDATION SUITE (end-to-end pipeline) — proves the oracle catches a
 * REAL divergence through the FULL capture→detect pipeline, not just at the data
 * layer.
 *
 * For each mutation we:
 *   1. Patch the BUILT `dist/server/**` (NEVER the pristine source) to inject a
 *      controlled divergence — a T0 handshake defect (drop a required field) and
 *      a T1 pty-output defect (corrupt the emitted bytes).
 *   2. Boot the MUTATED server via the isolated external harness, drive the real
 *      wire, and assert the relevant oracle check goes RED (divergence detected).
 *   3. RESTORE `dist` by rebuilding from the pristine source (`npm run
 *      build:server`) and assert the SAME check goes GREEN again.
 *
 * Restoration is GUARANTEED in a finally + afterAll (rebuild from pristine
 * source, with an exact-bytes fallback) so a mid-run failure can never leave a
 * mutated dist behind.
 *
 * SAFETY: only ever boots its own isolated node servers on ephemeral loopback
 * ports and reaps them by tracked pid; it NEVER binds :3001 and NEVER touches the
 * user's live freshell (pid 1262455). It only writes under `dist/` (a gitignored
 * build artifact) and leaves it rebuilt from pristine source.
 *
 * This test is heavier than the data-level suite (it boots servers and rebuilds
 * dist), so give it room; it is still fully deterministic (no live model call).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../../../..')
const DIST_SERVER = path.join(REPO_ROOT, 'dist', 'server')
const SERVER_BUILDINFO = path.join(REPO_ROOT, 'node_modules', '.cache', 'tsconfig.server.tsbuildinfo')
const PTY_BASELINE_DIR = path.join(REPO_ROOT, 'port', 'oracle', 'baselines', 'pty')
const LIVE_SERVER_PID = 1262455 // the user's live freshell — must never be us

// ── process helpers ──────────────────────────────────────────────────────────

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForPidGone(pid: number, budgetMs = 10_000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < budgetMs) {
    if (!pidAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return !pidAlive(pid)
}

// ── dist mutation + pristine-rebuild plumbing ────────────────────────────────

function distPath(rel: string): string {
  return path.join(DIST_SERVER, rel)
}
function readDist(rel: string): string {
  return readFileSync(distPath(rel), 'utf8')
}
function writeDist(rel: string, content: string): void {
  writeFileSync(distPath(rel), content, 'utf8')
}

/**
 * Rebuild dist from the PRISTINE source. The server tsconfig is incremental, so
 * a hand-edit to a dist output would otherwise survive a rebuild (source is
 * unchanged). Deleting the buildinfo forces a full, clean re-emit from source —
 * making `npm run build:server` the authoritative restore. Validated to
 * reproduce the pre-mutation bytes exactly.
 */
function rebuildServerFromPristineSource(): void {
  rmSync(SERVER_BUILDINFO, { force: true })
  const result = spawnSync('npm', ['run', 'build:server'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
    env: process.env,
    timeout: 180_000,
  })
  if (result.status !== 0) {
    throw new Error(
      `\`npm run build:server\` failed (exit ${result.status ?? 'signal ' + result.signal}).\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
  }
}

interface MutationSpec {
  /** dist-relative file to patch. */
  file: string
  /** transform the pristine file content into the mutated content (must differ). */
  mutate: (src: string) => string
  /** a human tag for logs. */
  label: string
}

/** Files we have touched this run (for the afterAll guaranteed-restore net). */
const touchedFiles = new Set<string>()
/** Exact pristine bytes captured before the first mutation of each file. */
const pristineBytes = new Map<string, string>()

function capturePristine(rel: string): string {
  if (!pristineBytes.has(rel)) pristineBytes.set(rel, readDist(rel))
  return pristineBytes.get(rel)!
}

/** Apply a mutation, asserting it actually changed the file (else a stale anchor = false green). */
function applyMutation(spec: MutationSpec): { pristine: string; mutated: string } {
  const pristine = capturePristine(spec.file)
  const mutated = spec.mutate(pristine)
  if (mutated === pristine) {
    throw new Error(
      `mutation "${spec.label}" did not change ${spec.file} — the dist anchor is stale ` +
        `(a compiler/source change moved it). Refusing to run a no-op mutation (would be a false GREEN).`,
    )
  }
  touchedFiles.add(spec.file)
  writeDist(spec.file, mutated)
  return { pristine, mutated }
}

/** Guarantee a file is back to pristine: rebuild from source, then byte-restore as a fallback. */
function restoreFile(rel: string): void {
  const pristine = pristineBytes.get(rel)
  // Rebuild from pristine source (the required restore path).
  rebuildServerFromPristineSource()
  if (pristine !== undefined && readDist(rel) !== pristine) {
    // Belt-and-suspenders: if a rebuild ever fails to reproduce the exact bytes,
    // fall back to the captured pristine bytes so dist is never left mutated.
    writeDist(rel, pristine)
  }
}

// ── the divergences we plant into the built server ───────────────────────────

/**
 * T0 defect: drop the REQUIRED `timestamp` field from the `ready` handshake
 * message (anchored on the unique `type: 'ready',` literal). A port that forgot
 * to emit `ready.timestamp` is exactly this bug; the frozen contract requires it.
 */
const T0_MUTATION: MutationSpec = {
  file: 'ws-handler.js',
  label: 'drop ready.timestamp (T0 required-field defect)',
  mutate: (src) => src.replace(/type: 'ready',\s*\n\s*timestamp: nowIso\(\),/, "type: 'ready',"),
}

/**
 * T1 defect: corrupt the pty output bytes by upper-casing everything node-pty
 * emits (both onData ingest sites). The all-uppercase sentinels survive (so the
 * capture still completes), but the lower-case payload (`hello`) becomes `HELLO`,
 * diverging from the committed golden byte-for-byte.
 */
const T1_MUTATION: MutationSpec = {
  file: 'terminal-registry.js',
  label: 'uppercase pty output (T1 byte-stream defect)',
  mutate: (src) =>
    src.replaceAll(
      'ptyProc.onData((data) => {',
      "ptyProc.onData((data) => { data = (typeof data === 'string' ? data.toUpperCase() : data);",
    ),
}

// ── pipeline drivers (boot mutated/pristine server → run the oracle check) ────

interface T0Outcome {
  pid: number
  port: number
  conformant: boolean
  readyPresent: boolean
  readyNonconformant: boolean
  detail: string
}

async function bootAndCheckT0(tag: string): Promise<T0Outcome> {
  const server: ExternalServerHandle = await startExternalServer({ provider: `oracle-mut-e2e-t0-${tag}` })
  try {
    expect(server.pid, 'must have spawned our own server').toBeGreaterThan(0)
    expect(server.pid).not.toBe(LIVE_SERVER_PID)
    expect(server.port).not.toBe(3001)
    const client = new WsCaptureClient(server.wsUrl, server.token)
    let report
    try {
      await client.connect()
      const handshake = await client.captureHandshake(60_000)
      const validator = new ContractValidator()
      report = validator.assertTranscriptConformant(handshake)
      const readyPresent = handshake.some((m) => m.dir === 'in' && m.type === 'ready')
      const readyNonconformant = report.nonconformant.some((n) => n.type === 'ready')
      return {
        pid: server.pid,
        port: server.port,
        conformant: report.allConformant,
        readyPresent,
        readyNonconformant,
        detail:
          `conformant=${report.allConformant}; serverMsgs=${report.serverMessageCount}; ` +
          `nonconformant=${JSON.stringify(report.nonconformant.map((n) => ({ type: n.type, reason: n.reason })))}`,
      }
    } finally {
      await client.close().catch(() => {})
    }
  } finally {
    await server.stop()
  }
}

interface T1Outcome {
  pid: number
  port: number
  matchesGolden: boolean
  goldenText: string
  detail: string
}

async function bootAndCheckT1(tag: string): Promise<T1Outcome> {
  const scenario = scenarioByName('echo-hello')
  if (!scenario) throw new Error('missing echo-hello scenario')
  const committed = readFileSync(path.join(PTY_BASELINE_DIR, 'echo-hello.golden'))
  const server: ExternalServerHandle = await startExternalServer({ provider: `oracle-mut-e2e-t1-${tag}` })
  try {
    expect(server.pid).toBeGreaterThan(0)
    expect(server.pid).not.toBe(LIVE_SERVER_PID)
    expect(server.port).not.toBe(3001)
    const capture = await capturePtyScenario(server, scenario, { cols: 120, rows: 30 })
    const matchesGolden = capture.goldenBytes.equals(committed)
    return {
      pid: server.pid,
      port: server.port,
      matchesGolden,
      goldenText: capture.goldenText,
      detail:
        `capturedGolden=${JSON.stringify(capture.goldenText)} committed=${JSON.stringify(committed.toString('utf8'))}` +
        (matchesGolden ? '' : `\n${hexDiff(capture.goldenBytes, committed)}`),
    }
  } finally {
    await server.stop()
  }
}

// ── the suite ────────────────────────────────────────────────────────────────

describe('oracle mutation-validation (end-to-end pipeline)', () => {
  let liveAliveAtStart = false
  const spawnedPids: number[] = []

  beforeAll(() => {
    liveAliveAtStart = pidAlive(LIVE_SERVER_PID)
    // Pre-flight: the built server must exist (the harness would build it, but we
    // want a known-pristine starting point before we mutate anything).
    if (!existsSync(distPath('ws-handler.js')) || !existsSync(distPath('terminal-registry.js'))) {
      rebuildServerFromPristineSource()
    }
    // Snapshot pristine bytes up front so the guaranteed-restore net always has them.
    capturePristine(T0_MUTATION.file)
    capturePristine(T1_MUTATION.file)
  }, 200_000)

  afterAll(() => {
    // GUARANTEED restore: rebuild from pristine source and byte-verify every file
    // we touched, even if a test above threw before its own finally ran.
    rebuildServerFromPristineSource()
    for (const rel of touchedFiles) {
      const pristine = pristineBytes.get(rel)
      if (pristine !== undefined && readDist(rel) !== pristine) writeDist(rel, pristine)
    }
    for (const rel of [T0_MUTATION.file, T1_MUTATION.file]) {
      const pristine = pristineBytes.get(rel)
      if (pristine !== undefined) {
        expect(readDist(rel), `dist/${rel} must be restored to pristine source after the run`).toBe(pristine)
      }
    }
  }, 200_000)

  it('T0 e2e: mutated `ready` (dropped required timestamp) goes RED, rebuild goes GREEN', async () => {
    const { mutated } = applyMutation(T0_MUTATION)
    try {
      // sanity: the mutation really dropped the timestamp from the ready literal.
      expect(mutated).toContain("type: 'ready',")
      expect(mutated).not.toMatch(/type: 'ready',\s*\n\s*timestamp: nowIso\(\),/)

      // RED — the full pipeline detects the divergence against the frozen contract.
      const red = await bootAndCheckT0('red')
      spawnedPids.push(red.pid)
      // eslint-disable-next-line no-console
      console.log(`[e2e-T0] RED   (mutated dist)  → ${red.detail}`)
      expect(red.conformant, 'MUTATED server handshake must be flagged NON-conformant (RED)').toBe(false)
      expect(
        red.readyPresent && red.readyNonconformant,
        'the dropped-timestamp defect must surface as a `ready` schema-violation',
      ).toBe(true)

      // GREEN — rebuild from pristine source, same check now passes.
      rebuildServerFromPristineSource()
      const green = await bootAndCheckT0('green')
      spawnedPids.push(green.pid)
      // eslint-disable-next-line no-console
      console.log(`[e2e-T0] GREEN (rebuilt dist)  → ${green.detail}`)
      expect(green.conformant, 'REBUILT (pristine) server handshake must be fully conformant (GREEN)').toBe(true)
    } finally {
      restoreFile(T0_MUTATION.file)
      expect(readDist(T0_MUTATION.file)).toBe(pristineBytes.get(T0_MUTATION.file))
    }
  }, 200_000)

  it('T1 e2e: corrupted pty output (uppercased bytes) goes RED, rebuild goes GREEN', async () => {
    const { mutated } = applyMutation(T1_MUTATION)
    try {
      expect(mutated).toContain('data.toUpperCase()')

      // RED — the captured golden diverges from the committed byte baseline.
      const red = await bootAndCheckT1('red')
      spawnedPids.push(red.pid)
      // eslint-disable-next-line no-console
      console.log(`[e2e-T1] RED   (mutated dist)  → capturedGolden=${JSON.stringify(red.goldenText)} (expected "hello\\r\\n")`)
      expect(red.matchesGolden, 'MUTATED pty bytes must NOT match the committed golden (RED)').toBe(false)
      expect(red.goldenText, 'the corruption should upper-case the payload').toBe('HELLO\r\n')

      // GREEN — rebuild from pristine source, capture matches the golden again.
      rebuildServerFromPristineSource()
      const green = await bootAndCheckT1('green')
      spawnedPids.push(green.pid)
      // eslint-disable-next-line no-console
      console.log(`[e2e-T1] GREEN (rebuilt dist)  → capturedGolden=${JSON.stringify(green.goldenText)}`)
      expect(green.matchesGolden, 'REBUILT (pristine) pty bytes must match the committed golden (GREEN)').toBe(true)
      expect(green.goldenText).toBe('hello\r\n')
    } finally {
      restoreFile(T1_MUTATION.file)
      expect(readDist(T1_MUTATION.file)).toBe(pristineBytes.get(T1_MUTATION.file))
    }
  }, 200_000)

  it('SAFETY: every spawned server was reaped and the live :3001 was never touched', async () => {
    for (const pid of spawnedPids) {
      expect(pid).not.toBe(LIVE_SERVER_PID)
      const gone = await waitForPidGone(pid)
      expect(gone, `spawned server pid ${pid} must be reaped`).toBe(true)
    }
    if (liveAliveAtStart) {
      expect(
        pidAlive(LIVE_SERVER_PID),
        'the user live freshell (pid 1262455) must remain alive — we must not have touched it',
      ).toBe(true)
    }
  })
})
