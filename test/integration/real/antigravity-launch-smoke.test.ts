// @vitest-environment node
//
// Real Antigravity CLI launch smoke test.
//
// - "launches the real agy binary" always runs when `agy` (or the
//   `ANTIGRAVITY_CMD` override) is available — it skips with a clear reason
//   otherwise, never fails. This is the "actually launch the real CLI" proof:
//   it spawns the binary and asserts the version shape the Task 1 real-binary
//   probe recorded (`agy --version` prints a bare semver, e.g. `1.4.10`).
// - "rejects a bare -i" also always runs when available (round 6, whole-
//   delta review Major): the argv probes (2026-11-01, binaries v1.4.10 AND
//   v1.4.12, receipts in the plan's Provider Contract Record) proved
//   `-i`/`--prompt-interactive` TAKE A PROMPT VALUE — a bare `-i` exits 2
//   at flag parse (`flag needs an argument: -i`), BEFORE any TTY, auth, or
//   store work. Freshell panes therefore launch BARE (the manifest ships no
//   static args); this smoke is the early warning that a future CLI version
//   changed that argv shape (re-open the launch-contract record if it ever
//   fails). It runs with a disposable HOME for hygiene parity with the
//   probe, bounded by a timeout, and performs no authenticated operation.
// - "completes a headless turn" is opt-in: it makes a real model call and is
//   DOUBLE-gated by FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 AND a Google API
//   key in the env. It skips (never fails) otherwise, and never runs in the
//   default suite — the whole test/integration/real/ tree is excluded from the
//   default config without the opt-in.
// - "resumes a real conversation headlessly and appends to the same
//   transcript" is the fourth tier, opt-in under the same double gate: it
//   mints one fresh real conversation, resumes it with `--conversation <id>`,
//   pins the transcript continuity receipts (same brain/<id> growth; unique,
//   strictly-increasing USER_INPUT step indexes), and removes the
//   conversation it created (brain/<id> + conversations/<id>.db) in a finally
//   sweep — one real conversation created and then removed per gated run.
//   The store scan is exhaustive: the binary's write root is not
//   necessarily the seam's read root (the snap binary pins its store under
//   $HOME/snap while the default root can also hold conversations, and a
//   fresh install creates its root mid-run), so the tier snapshots,
//   scans, and sweeps EVERY candidate root (the env override, the default
//   root, and the snap root — deduplicated).
//
//   To run the gated tiers 3-4 (CLI settings precondition: both tiers pass
//   the session-scoped `--settings '{"modelProvider":"gemini"}'` overlay for
//   API-key auth per the plan's Provider Contract Record — the shared
//   settings.json is never mutated, and the binary REQUIRES GEMINI_API_KEY
//   in the env for that overlay; argv shape: `--settings` earlier in argv,
//   the prompt attached to its flag as `-p='<prompt>'` — the bare positional
//   `-p <prompt>` form misparses and exits 2):
//     FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 GEMINI_API_KEY=... \
//       pnpm run test:vitest run test/integration/real/antigravity-launch-smoke.test.ts \
//       --config config/vitest/vitest.config.ts
//
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, it, expect } from 'vitest'

const execFileAsync = promisify(execFile)

// Provider contract (plan docs/plans/2026-10-29-google-cli-first-class-support.md,
// Provider Contract Record): command `agy`, env override `ANTIGRAVITY_CMD`;
// `-p` is the short alias for `--print` (headless prompt).
const agyCommand = process.env.ANTIGRAVITY_CMD || 'agy'

async function agyAvailable(): Promise<boolean> {
  try {
    await execFileAsync(agyCommand, ['--version'], { timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

const available = await agyAvailable()
const realEnabled = process.env.FRESHELL_RUN_REAL_PROVIDER_CONTRACTS === '1'
const hasProviderKey = Boolean(process.env.GEMINI_API_KEY)

describe('antigravity real launch smoke', () => {
  const itIfAvailable = available
    ? it
    : it.skip
  itIfAvailable('launches the real agy binary (agy --version)', async () => {
    const { stdout } = await execFileAsync(agyCommand, ['--version'], { timeout: 20_000 })
    // The real binary prints a bare version ("1.4.10" — Task 1 probe,
    // contract-probe.md), not a product name, so assert that exact shape.
    expect(stdout.trim()).toMatch(/^\d+\.\d+(\.\d+)?/)
  }, 30_000)

  itIfAvailable('rejects a bare -i exactly as the round-6 argv probes recorded', async () => {
    // `flag needs an argument: -i` + usage on stderr, exit 2, at flag
    // parse — before any TTY/auth/store work. Disposable HOME for hygiene
    // parity with the probe; bounded timeout; no authenticated operation.
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-agy-smoke-home-'))
    try {
      const res = await execFileAsync(agyCommand, ['-i'], {
        env: { ...process.env, HOME: tmpHome },
        timeout: 20_000,
      }).then(
        (r) => ({ code: 0, stderr: String(r.stderr ?? '') }),
        (err: NodeJS.ErrnoException & { code?: number | string; stderr?: string }) => ({
          code: typeof err.code === 'number' ? err.code : -1,
          stderr: String(err.stderr ?? ''),
        }),
      )
      expect(res.code, `agy -i stderr: ${res.stderr}`).toBe(2)
      expect(res.stderr).toContain('flag needs an argument: -i')
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {})
    }
  }, 30_000)

  const runTurn = available && realEnabled && hasProviderKey
  const itTurn = runTurn
    ? it
    : it.skip
  itTurn('completes a headless turn and echoes the nonce', async () => {
    const nonce = `antigravity-smoke-ok-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const beforeByRoot = await snapshotBeforeByRoot()
    try {
      const { stdout } = await execFileAsync(
        agyCommand,
        // GC15: the session-scoped API-key-auth overlay — the shared settings.json
        // is never mutated. Argv shape per the Task 1 receipts: --settings earlier
        // in argv, the prompt attached to its flag (-p='<prompt>'); the bare
        // positional form misparses and exits 2. The nonce is run-unique so the
        // tier can own and sweep its conversation (a 2026-11-03 gated run leaked
        // exactly this tier's conversation: a fixed nonce with no sweep).
        ['--settings', '{"modelProvider":"gemini"}', `-p=Reply with exactly: ${nonce}`],
        { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
      )
      expect(stdout).toContain(nonce)
    } finally {
      // The tier owns its conversation in every candidate root: a
      // creation-then-failure (or a passing run) must not leave scratch
      // data in the live store — the same sweep discipline as the resume
      // tier below.
      await sweepNonceBearingFresh(nonce, beforeByRoot)
    }
  }, 200_000)

  // Candidate store roots, in preference order. The SEAM resolves ONE
  // root (crates/freshell-sessions provider_layout.rs antigravity_home:
  // FRESHELL_ANTIGRAVITY_HOME override > default root when it holds
  // conversations > snap root), but the binary's WRITE root is not
  // necessarily the seam's read root: the snap binary pins its store
  // under $HOME/snap regardless of a disposable HOME (the contract-probe
  // receipts), while the same host can also hold conversations in the
  // default root (or vice versa) — and a root that does not exist yet is
  // created by the binary mid-run on a fresh install. The tier therefore
  // scans EVERY candidate (deduplicated) instead of betting on one: a
  // missing root simply contributes an empty snapshot/scan (the readdir
  // catch), so a write root that materializes during the run is still
  // found and still swept by the cleanup.
  function agyStoreRootCandidates(): string[] {
    const home = os.homedir()
    const candidates = [
      process.env.FRESHELL_ANTIGRAVITY_HOME,
      path.join(home, '.gemini', 'antigravity-cli'),
      path.join(home, 'snap', 'antigravity-cli', 'common', '.gemini', 'antigravity-cli'),
    ].filter((root): root is string => Boolean(root))
    return [...new Set(candidates)]
  }

  const brainDirOf = (root: string) => path.join(root, 'brain')

  // Per-root `before` snapshots over every candidate root (the run owns
  // what it creates; the freshness filter is scoped per root).
  async function snapshotBeforeByRoot(): Promise<Map<string, Set<string>>> {
    const beforeByRoot = new Map<string, Set<string>>()
    for (const root of agyStoreRootCandidates()) {
      beforeByRoot.set(root, new Set(await fs.readdir(brainDirOf(root)).catch(() => [] as string[])))
    }
    return beforeByRoot
  }

  // Sweep every FRESH conversation carrying THIS run's unique nonce in
  // every candidate root — success or any failure. The nonce gate stays:
  // this run removes only conversations carrying its own unique nonce,
  // never a concurrent user conversation.
  async function sweepNonceBearingFresh(
    nonce: string,
    beforeByRoot: Map<string, Set<string>>,
  ): Promise<void> {
    const nonceBearing = new Set<string>()
    for (const [root, before] of beforeByRoot) {
      const brainDir = brainDirOf(root)
      const nowIds = await fs.readdir(brainDir).catch(() => [] as string[])
      for (const id of nowIds) {
        if (before.has(id)) continue
        const body = await fs
          .readFile(path.join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl'), 'utf8')
          .catch(() => '')
        if (body.includes(nonce)) nonceBearing.add(id)
      }
    }
    for (const id of nonceBearing) {
      for (const root of beforeByRoot.keys()) {
        await fs.rm(path.join(brainDirOf(root), id), { recursive: true, force: true }).catch(() => {})
        await fs.rm(path.join(root, 'conversations', `${id}.db`), { force: true }).catch(() => {})
      }
    }
  }

  const runResume = available && realEnabled && hasProviderKey
  const itResume = runResume ? it : it.skip
  itResume(
    'resumes a real conversation headlessly and appends to the same transcript',
    async () => {
      const nonce = `antigravity-smoke-resume-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      // The binary's write root is not necessarily the seam's read root —
      // scan EVERY candidate root (see agyStoreRootCandidates).
      const roots = agyStoreRootCandidates()
      // Per-root `before` snapshots: the freshness filter is scoped to
      // each root's own pre-run conversation set.
      const beforeByRoot = new Map<string, Set<string>>()
      for (const root of roots) {
        beforeByRoot.set(root, new Set(await fs.readdir(brainDirOf(root)).catch(() => [] as string[])))
      }
      // EVERY fresh conversation whose transcript carries the nonce — the
      // cleanup sweep must remove them all even if the id resolution or any
      // later assertion fails (a failed tier run must not leave its scratch
      // data in the live store).
      const nonceBearing = new Set<string>()
      try {
      // Turn 1: a fresh scratch conversation this run owns.
      const first = await execFileAsync(
        agyCommand,
        ['--settings', '{"modelProvider":"gemini"}', `-p=Reply with exactly: ${nonce}`],
        { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
      )
      expect(first.stdout).toContain(nonce)

      // Find the NEW conversation(s) whose transcripts carry the nonce —
      // in EVERY candidate root (the binary wrote to whichever root its
      // installation pins; ids are root-independent, so the resume below
      // works regardless of which root produced the hit).
      let convId: string | undefined
      let transcriptPath: string | undefined
      let freshCount = 0
      for (const root of roots) {
        const brainDir = brainDirOf(root)
        const before = beforeByRoot.get(root) ?? new Set<string>()
        const after = await fs.readdir(brainDir).catch(() => [] as string[])
        const freshIds = after.filter((id) => !before.has(id))
        freshCount += freshIds.length
        for (const id of freshIds) {
          const body = await fs
            .readFile(path.join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl'), 'utf8')
            .catch(() => '')
          if (body.includes(nonce)) {
            nonceBearing.add(id)
            convId ??= id
            transcriptPath ??= path.join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl')
          }
        }
      }
      expect(freshCount).toBeGreaterThanOrEqual(1)
      expect(convId, 'the new conversation whose transcript carries the nonce').toBeTruthy()

      // Binary record-schema pins on the run-owned transcript (the
      // corrected contract; evidence: real-binary-transcript-evidence.md).
      const readRecords = async () =>
        (await fs.readFile(transcriptPath!, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      const lines = await readRecords()
      expect(lines[0].type).toBe('USER_INPUT')
      expect(lines.some((r: { type: string }) => r.type === 'PLANNER_RESPONSE')).toBe(true)
      const version = (await execFileAsync(agyCommand, ['--version'], { timeout: 15_000 })).stdout.trim()
      const KNOWN_TYPES = new Set(['USER_INPUT', 'PLANNER_RESPONSE', 'GENERIC', 'SYSTEM_MESSAGE', 'CHECKPOINT'])
      const unknownTypes = new Set<string>()
      for (const record of lines) {
        if (!KNOWN_TYPES.has(record.type)) { unknownTypes.add(record.type); continue }
        // Stamps are asserted on the FIVE validated record types only: the contract
        // says these types carry step_index and second-granularity created_at — it does
        // not forbid a future CLI version from adding a sixth type. A stamp change on
        // a KNOWN type still fails, and that failure is the drift alarm doing its job:
        // record the version receipt and re-open the Provider Contract Record; never
        // loosen the known-type assertions to get green.
        expect(typeof record.step_index, `${record.type} step_index (agy ${version})`).toBe('number')
        expect(record.created_at, `${record.type} created_at (agy ${version})`).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      }
      if (unknownTypes.size > 0) console.log(`[tier4] unknown record types (recorded, not failed): ${[...unknownTypes].join(', ')} (agy ${version})`)

      // THE real resume: same conversation, follow-up recall.
      const linesBefore = lines.length
      const second = await execFileAsync(
        agyCommand,
        ['--settings', '{"modelProvider":"gemini"}', '--conversation', convId!, '-p=Reply with exactly the string I asked you to reply with in the first message.'],
        { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
      )
      expect(second.stdout).toContain(nonce)
      expect(String(second.stderr ?? '')).not.toContain('warning: conversation')

      // Continuity is transcript-level too: the SAME brain/<id> gained
      // records, the USER_INPUT step indexes stay unique, and the
      // resumed turn's are strictly greater (the collision-proof key).
      const linesAfter = await readRecords()
      expect(linesAfter.length).toBeGreaterThan(linesBefore)
      const userSteps = linesAfter
        .filter((r: { type: string }) => r.type === 'USER_INPUT')
        .map((r: { step_index: number }) => r.step_index)
      expect(new Set(userSteps).size).toBe(userSteps.length)
      expect(userSteps[userSteps.length - 1]).toBeGreaterThan(userSteps[0])

      // Cleanup (finally): this run owns every conversation it created (the
      // contract-probe hygiene precedent). Remove BOTH store trees for EVERY
      // nonce-bearing fresh conversation in EVERY candidate root — success or
      // any failure (Task 1 Step 7 parity).
      } finally {
        // Re-scan fresh conversations in the finally, in EVERY candidate
        // root (the binary's write root is not necessarily the seam's read
        // root — a single-root re-scan can miss this run's scratch
        // conversation on a host whose roots are split): a failure AFTER
        // the CLI already created a conversation (the exact
        // creation-then-429 mode the Task 1 receipts recorded on a
        // quota-dead key) can throw before the in-try scan populates
        // nonceBearing — without this re-scan that scratch conversation
        // would leak in the live store. The nonce gate stays: this run
        // removes only conversations carrying THIS run's unique nonce,
        // never a concurrent user conversation.
        for (const root of roots) {
          const brainDir = brainDirOf(root)
          const before = beforeByRoot.get(root) ?? new Set<string>()
          const nowIds = await fs.readdir(brainDir).catch(() => [] as string[])
          for (const id of nowIds) {
            if (before.has(id) || nonceBearing.has(id)) continue
            const body = await fs
              .readFile(path.join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl'), 'utf8')
              .catch(() => '')
            if (body.includes(nonce)) nonceBearing.add(id)
          }
        }
        for (const id of nonceBearing) {
          for (const root of roots) {
            await fs.rm(path.join(brainDirOf(root), id), { recursive: true, force: true }).catch(() => {})
            await fs.rm(path.join(root, 'conversations', `${id}.db`), { force: true }).catch(() => {})
          }
        }
      }
    },
    420_000,
  )
})
