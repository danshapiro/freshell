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
//   strictly-increasing USER_INPUT step indexes), and removes EVERY
//   conversation it created (brain/<id> + conversations/<id>.db) in a
//   finally sweep — the turn-1 conversation, plus any fresh conversation
//   the binary mints by REJECTING the resume id (the documented
//   missing-id passthrough): the resume prompt carries a run-unique
//   marker, so the sweep identifies that minted conversation as this
//   run's scratch too and never leaks it in the live store.
//   The store scan is exhaustive: the binary's write root is not
//   necessarily the seam's read root (the snap binary pins its store under
//   $HOME/snap while the default root can also hold conversations, and a
//   fresh install creates its root mid-run), so the tier snapshots,
//   scans, and sweeps EVERY candidate root (the env override, the default
//   root, and the snap root — deduplicated).
//   A removal that FAILS is never silent on either cleanup path (the
//   headless-turn tier's sweep and this tier's finally re-scan): a
//   loud stderr line names the leaked ids, and the removal failure
//   becomes the test's failure when the body itself succeeded — a
//   body failure is never masked by a cleanup error (then the log line
//   alone reports the leak).
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
    // Set only after the body's last assertion: a cleanup removal
    // failure becomes THIS test's failure only when the body succeeded
    // (surfaceRemovalFailures) — a body failure must never be masked
    // by a finally-thrown cleanup error.
    let bodySucceeded = false
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
      bodySucceeded = true
    } finally {
      // The tier owns its conversation in every candidate root: a
      // creation-then-failure (or a passing run) must not leave scratch
      // data in the live store — the same sweep discipline as the resume
      // tier below, and a removal that fails is visible, never a silent
      // leak.
      const leaked = await sweepNonceBearingFresh([nonce], beforeByRoot)
      surfaceRemovalFailures(leaked, bodySucceeded)
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

  // Sweep every FRESH conversation this run OWNS in every candidate
  // root — success or any failure. OWNED = the transcript carries ANY
  // of this run's unique markers: the tier's nonce, or the tier-4
  // resume marker (the run-unique string embedded in the resume
  // prompt, so a conversation the binary MINTS by rejecting the
  // resume id is still identifiable as this run's scratch). The
  // ownership gate stays: this run removes only conversations
  // carrying its own run-unique markers, never a concurrent user
  // conversation. Returns the per-id removal failures for the caller
  // to surface (removeOwnedFromAllRoots).
  async function sweepNonceBearingFresh(
    ownedMarkers: string[],
    beforeByRoot: Map<string, Set<string>>,
  ): Promise<string[]> {
    const owned = new Set<string>()
    for (const [root, before] of beforeByRoot) {
      const brainDir = brainDirOf(root)
      const nowIds = await fs.readdir(brainDir).catch(() => [] as string[])
      for (const id of nowIds) {
        if (before.has(id)) continue
        const body = await fs
          .readFile(path.join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl'), 'utf8')
          .catch(() => '')
        if (ownedMarkers.some((marker) => body.includes(marker))) owned.add(id)
      }
    }
    return removeOwnedFromAllRoots(owned, [...beforeByRoot.keys()])
  }

  // Remove BOTH store trees (brain/<id> and conversations/<id>.db) of
  // every owned conversation in EVERY candidate root, COLLECTING
  // per-id removal failures instead of swallowing them: a failed
  // removal (permissions, a racing handle) leaves this run's scratch
  // in the live store, and that leak must be visible — never a silent
  // `.catch(() => {})` pass. An id counts as failed when ANY of its
  // removals rejected (the sweep removes defensively from every root;
  // `force` already ignores not-found, so a rejection is a real
  // failure). Returns the ids whose removal failed.
  async function removeOwnedFromAllRoots(owned: Set<string>, roots: string[]): Promise<string[]> {
    const failedIds: string[] = []
    for (const id of owned) {
      let failed = false
      for (const root of roots) {
        await fs.rm(path.join(brainDirOf(root), id), { recursive: true, force: true }).catch(() => {
          failed = true
        })
        await fs.rm(path.join(root, 'conversations', `${id}.db`), { force: true }).catch(() => {
          failed = true
        })
      }
      if (failed) failedIds.push(id)
    }
    return failedIds
  }

  // Make cleanup removal failures visible WITHOUT masking the test
  // body's own failure: the loud stderr line ALWAYS prints (a
  // passing-but-leaky run is visible in the output), and the removal
  // failure becomes the test's failure only when the body itself
  // succeeded — a finally-thrown removal error must NOT replace the
  // body's original failure, so when the body already failed the log
  // line alone reports the leak. The same discipline on both cleanup
  // paths (the headless-turn tier's sweep and the resume tier's
  // finally re-scan). The line goes straight to stderr because this
  // suite's setup spies console.error into a capture-only
  // implementation: a literal console.error would either be swallowed
  // (never printed) or add a misleading "Unexpected console.error"
  // failure — raw stderr is the one channel that is both loud and
  // actually visible in this suite's output.
  function surfaceRemovalFailures(failedIds: string[], bodySucceeded: boolean): void {
    if (failedIds.length === 0) return
    process.stderr.write(
      `[antigravity-smoke] LEAK: cleanup failed to remove run-owned scratch conversation(s) ` +
        `from the live store — ids: ${failedIds.join(', ')} (remove them manually)\n`,
    )
    if (bodySucceeded) {
      throw new Error(
        `cleanup failed to remove this run's scratch conversation(s) from the live store: ${failedIds.join(', ')}`,
      )
    }
  }

  const runResume = available && realEnabled && hasProviderKey
  const itResume = runResume ? it : it.skip
  itResume(
    'resumes a real conversation headlessly and appends to the same transcript',
    async () => {
      const nonce = `antigravity-smoke-resume-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      // The resume prompt's run-unique marker: if the binary REJECTS the
      // --conversation id (the documented missing-id passthrough — a
      // future CLI contract change), it mints a FRESH conversation whose
      // USER_INPUT carries the resume prompt, which contains NO nonce.
      // The marker makes that minted conversation identifiable as THIS
      // run's scratch so the finally sweep owns and removes it — without
      // it, the exact regression this tier exists to catch (a broken
      // --conversation) would leak its minted conversation in the live
      // store. Run-unique like the nonce, so the never-delete-a-user-
      // conversation gate holds unchanged.
      const resumeMarker = `freshell-smoke-resume-mark-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      // A fresh conversation is OWNED by this run when its transcript
      // carries ANY of these run-unique markers (the invariant the
      // in-try scan and the finally sweep both apply).
      const ownedMarkers = [nonce, resumeMarker]
      // The binary's write root is not necessarily the seam's read root —
      // scan EVERY candidate root (see agyStoreRootCandidates).
      const roots = agyStoreRootCandidates()
      // Per-root `before` snapshots: the freshness filter is scoped to
      // each root's own pre-run conversation set.
      const beforeByRoot = new Map<string, Set<string>>()
      for (const root of roots) {
        beforeByRoot.set(root, new Set(await fs.readdir(brainDirOf(root)).catch(() => [] as string[])))
      }
      // EVERY fresh conversation this run owns (a transcript carrying the
      // nonce OR the resume marker) — the cleanup sweep must remove them
      // all even if the id resolution or any later assertion fails (a
      // failed tier run must not leave its scratch data in the live
      // store).
      const owned = new Set<string>()
      // Set only after the body's last assertion: a cleanup removal
      // failure becomes THIS test's failure only when the body
      // succeeded (surfaceRemovalFailures) — a body failure must never
      // be masked by a finally-thrown cleanup error.
      let bodySucceeded = false
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
            owned.add(id)
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
      // The SIX contract record types (Provider Contract Record row 67): the
      // five success-path types plus the evidenced failure-path ERROR_MESSAGE
      // (src=SYSTEM, status=DONE, carries `error` + `step_index` + a
      // second-granularity `created_at`; observed on API/network failure
      // retries — the overlay-conformant receipts' ERROR_MESSAGE note,
      // 2026-11-03). Promoting it here is a STRENGTHENING: its stamps are
      // asserted like every other known type.
      const KNOWN_TYPES = new Set(['USER_INPUT', 'PLANNER_RESPONSE', 'GENERIC', 'SYSTEM_MESSAGE', 'CHECKPOINT', 'ERROR_MESSAGE'])
      const unknownTypes = new Set<string>()
      for (const record of lines) {
        if (!KNOWN_TYPES.has(record.type)) { unknownTypes.add(record.type); continue }
        // Stamps are asserted on the SIX contract record types only: the contract
        // says these types carry step_index and second-granularity created_at — it does
        // not forbid a future CLI version from adding a seventh type. A stamp change on
        // a KNOWN type still fails, and that failure is the drift alarm doing its job:
        // record the version receipt and re-open the Provider Contract Record; never
        // loosen the known-type assertions to get green.
        expect(typeof record.step_index, `${record.type} step_index (agy ${version})`).toBe('number')
        expect(record.created_at, `${record.type} created_at (agy ${version})`).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      }
      if (unknownTypes.size > 0) console.log(`[tier4] unknown record types (recorded, not failed): ${[...unknownTypes].join(', ')} (agy ${version})`)

      // THE real resume: same conversation, follow-up recall. The prompt
      // carries the run-unique resume marker (parenthesized, so the
      // recall instruction stays intact — the stdout assertion still
      // checks the NONCE): a binary that rejects the id mints a fresh
      // conversation whose USER_INPUT carries THIS text, and the marker
      // ties that minted conversation to this run for the finally sweep.
      const linesBefore = lines.length
      const second = await execFileAsync(
        agyCommand,
        ['--settings', '{"modelProvider":"gemini"}', '--conversation', convId!, `-p=Reply with exactly the string I asked you to reply with in the first message. (${resumeMarker})`],
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
      bodySucceeded = true

      // Cleanup (finally): this run owns every conversation it created (the
      // contract-probe hygiene precedent). Remove BOTH store trees for EVERY
      // owned fresh conversation in EVERY candidate root — success or
      // any failure (Task 1 Step 7 parity) — and a removal that FAILS is
      // visible (surfaceRemovalFailures), never a silent leak.
      } finally {
        // Re-scan fresh conversations in the finally, in EVERY candidate
        // root (the binary's write root is not necessarily the seam's read
        // root — a single-root re-scan can miss this run's scratch
        // conversation on a host whose roots are split): a failure AFTER
        // the CLI already created a conversation (the exact
        // creation-then-429 mode the Task 1 receipts recorded on a
        // quota-dead key, or the resume invocation failing after the
        // binary minted a fresh conversation) can throw before the in-try
        // scan populates `owned` — without this re-scan that scratch
        // conversation would leak in the live store. Owned is nonce OR
        // resume marker (see ownedMarkers): a resume the binary rejects
        // mints a conversation whose transcript carries only the marker.
        // The ownership gate stays: this run removes only conversations
        // carrying THIS run's unique markers, never a concurrent user
        // conversation.
        for (const root of roots) {
          const brainDir = brainDirOf(root)
          const before = beforeByRoot.get(root) ?? new Set<string>()
          const nowIds = await fs.readdir(brainDir).catch(() => [] as string[])
          for (const id of nowIds) {
            if (before.has(id) || owned.has(id)) continue
            const body = await fs
              .readFile(path.join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl'), 'utf8')
              .catch(() => '')
            if (ownedMarkers.some((marker) => body.includes(marker))) owned.add(id)
          }
        }
        const leaked = await removeOwnedFromAllRoots(owned, roots)
        surfaceRemovalFailures(leaked, bodySucceeded)
      }
    },
    420_000,
  )
})
