# Antigravity Transcript Validation Implementation Plan

Date: 2026-11-02. Status: executable implementation plan.
Worktree: `.worktrees/antigravity-transcript-validation`, branch `the-usual/antigravity-transcript-validation`, base_ref `520626c46b7e5bfcbdddd85480fd375cdc9cb783` (do not rebase or merge).

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
- Validate the Antigravity (`agy`) transcript record schema (currently a Stage-1 CANDIDATE contract, fixture-validated only) against real transcript.jsonl records produced by real binary sessions, and prove — with binary evidence — that `turn_settled.at` granularity can never collide across two turns. On success, flip the deferred conversation-resume gate in resume_validation.rs, remove the corresponding README limitation, and extend the real-provider smoke to cover a real resume. (Source: kata yhqb in the shared KataTracker.)

### Explicit constraints
- The conversation-restore gate stays OFF until real-binary transcript evidence exists (plan Global Constraint 4).
- Real agy sessions require the settings precondition modelProvider "gemini" (API-key auth) per the smoke runbook.
- The `turn_settled.at` collision question needs binary evidence, not fixture inference: the per-settle dedupe in crates/freshell-activity/src/antigravity.rs treats equal-at-as-a-replay.
- Work happens in a dedicated worktree on a branch from origin/main; no PR creation without explicit user approval.

### Accepted tradeoffs and residuals
- The transcript record schema is a Stage-1 candidate; this run may promote or correct it against real evidence.

**Goal:** Real `agy` transcript evidence (the on-machine 1.2.11 + 1.4.12 corpus — store-log-attributed, schemas identical across both — plus fresh 1.4.12 receipts this run mints) pins the REAL record schema (correcting the disproven Stage-1 candidate), Freshell's antigravity transcript consumers and fixtures are corrected to that schema with a collision-proof settle dedupe, the deferred conversation-resume gate is activated on that evidence together with a proven real resume, the README limitation is replaced with the validated behavior, and the real-provider smoke gains a real-resume tier.

**Architecture:** Investigation first: Task 1 re-derives the record schema from the three on-machine real conversations plus a fresh scratch conversation this run owns (including a real `--conversation` resume probe and back-to-back turns), records verbatim shape-only receipts, and flips the Provider Contract Record rows. Task 2 then corrects the record vocabulary in one atomic change across every consumer and test double: the sessions parser/fixtures/source/search go fully real (step-indexed `USER_INPUT`/`PLANNER_RESPONSE`/`GENERIC`/`SYSTEM_MESSAGE`/`CHECKPOINT` records, conversation id from the `brain/<id>` directory, flat token fields), the activity classifier and the locator's user-record arm adopt the real `USER_INPUT` shape, and the per-settle dedupe is re-keyed from wall-clock `at` alone to the record identity `(created_at, step_index)` — binary-evidenced collision-proof — while the two structures reality disproves (the ownership record the locator anchors on, the settle record the attention machinery consumes) are retained as explicitly-labeled fake-contract test extensions. Only after the corrected schema is implemented and the real resume is proven does Task 3 flip the gate (`VALIDATED_PROVIDERS` plus every deliberately-red deferral pin rewritten to the gated contract, README rewritten, the e2e dead-session scenario re-pinned), and Task 4 adds the triple-gated real-resume smoke tier and runs the final verification sweep. If the authenticated session cannot run (no `GEMINI_API_KEY` and no live alternative auth), Task 3's flip does not happen — the blocker is recorded and the run reports the miss honestly.

**Tech Stack:** Rust workspace (`freshell-sessions`, `freshell-activity`, `freshell-protocol`, `freshell-platform`, `freshell-ws`, `freshell-freshagent`, `freshell-server`, `freshell-agent-runtime`), Vitest for the real-provider smoke, Playwright (chromium project) for the google-cli e2e specs, focused cargo lanes (the rebind suite only inside `scripts/sandbox-test.sh`), pnpm 10.34.5, real `agy` 1.4.12 (snap) with the `--settings '{"modelProvider":"gemini"}'` overlay.

## Global Constraints

Copied from `docs/plans/2026-10-29-google-cli-first-class-support.md` (the plan doc's own Global Constraints), where they apply to this work:

1. **Product identity:** provider ID `antigravity`, label `Antigravity CLI`, command `agy`, env override `ANTIGRAVITY_CMD`. `gemini`/`GEMINI_CMD` stay intact and valid.
2. **Never do:** send a saved Gemini session to `agy`; alias Gemini/Antigravity IDs; run Google's configuration migration on the user's behalf; use `--continue` or the `~/.gemini/antigravity-cli/cache/last_conversations.json` cache for exact-session resume or identity evidence; edit provider transcripts to rename; overwrite any shared user/project configuration (`.agents/hooks.json`, `~/.gemini/config/hooks.json`, the CLI's shared `settings.json` included); claim recovery from a display-only transcript; copy live credential stores into fixtures.
3. **No silent replacement:** missing native state, authentication failure, and transient store errors remain distinct outcomes; a failed resume must never pretend the resumed pane still IS the requested conversation. The resume gate (`VALIDATED_PROVIDERS`) stays OFF for antigravity until real-binary transcript evidence exists. Once evidence lands, gate activation follows the repo's validated-provider policy (user-create `Absent` → SpawnFresh + visible notice; managed recovery: fail closed).
4. **Candidate-contract honesty:** every native-contract fact not validated against a real pinned binary is a NAMED BLOCKER (see Provider Contract Record). Code built on candidate contracts must work end-to-end against the checked-in fixtures and carry a `// Stage-1 candidate contract:` comment at the seam, and the limitation must be recorded in the Provider Contract Record and README. No capability flag, qualification entry, or recovery claim may be enabled on candidate evidence.
5. **Hooks:** install NO antigravity hooks and write NO antigravity config anywhere. Freshell's integration is read-only over the provider's own store.
6. **Repo rules:** red/green/refactor TDD for every behavior change (tests must execute readers, launches, routes, or user interactions — never assert that source/docs/config contain strings); pnpm 10.34.5 with `--frozen-lockfile`; narrowed Cargo selectors are delegated lanes; broad gates only through the coordinator with `GCLOUD_ROBOT_REQUIRE=1`, `FRESHELL_RUST_TEST_SANDBOX=1`, and a `FRESHELL_TEST_SUMMARY`; process-kill/restart-storm suites only in the disposable sandbox; browser specs must pass on the configured `FRESHELL_E2E_BACKEND` and not sit in `CLOUD_SKIP_SPECS`; TypeScript relative imports need `.js` extensions; no PR creation without explicit user approval; never restart the live port 3001 server without "APPROVED"; commit `.kata.toml` if modified.
7. **Structured logging:** emit JSONL severity-tagged events correlating provider, terminal id, and native conversation id; omit prompt/transcript contents and credentials; rate-limit repeated failures per repo conventions.
8. **Documentation:** `README.md` is the only end-user doc; agent-facing notes link from `AGENTS.md`.
9. **Preserve frozen provenance:** never edit `crates/freshell-extensions/fixtures/manifest-oracle.json` or `port/**`.
10. **A11y** (adapted): this delta changes no UI components; `pnpm run lint` must gain no findings from any changed file.

Run-specific constraints (this plan's own, binding):

11. **Out of scope — baseline:** the pre-existing managed fresh-agent parity failures (katas fy2w/smp2/8p6f; the run-state baseline ledger: `fresh-agent-parity.test.ts` freshcodex/freshopencode/installed-Codex legs and the `provider-parity-contract.test.ts` suite-setup cascade) are NOT this run's work. No task touches them; green means green excluding those ledger-recorded failures.
12. **Real-transcript hygiene:** real transcripts are private user data. Evidence and fixtures record SHAPES ONLY — field names, types, enum values, timestamps, token counts, and minimal structural exemplars with values replaced by placeholders. Never copy real `content`/`thinking`/`tool_calls`/`media` values into fixtures, this plan, the repo, or reports. Committed fixtures are hand-written SYNTHETIC real-shaped records. Run-created scratch conversations are identified, recorded, and removed from the store after the receipts land.
13. **Gate-flip precondition ordering (Global Constraint 4's intent):** the resume-gate flip lands only AFTER (a) the real schema is pinned with binary evidence (Task 1), (b) the parser corrections implement it (Task 2), and (c) a real resume probe proves binary-level content continuity (Task 1). If the authenticated session cannot run, the flip does NOT happen; record the blocker and report the miss.
14. **Command lanes:** repo-owned vitest is `pnpm run test:vitest run <paths> --config config/vitest/vitest.config.ts`; focused cargo selectors run directly (delegated lanes); `cargo test -p freshell-ws --test antigravity_session_rebind` runs ONLY inside `scripts/sandbox-test.sh "..."` (its own header's rule); the real-provider smoke is opt-in (`FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1` + `GEMINI_API_KEY`) and never runs in the default suite.
15. **Real-session auth:** headless real turns pass the session-scoped never-saved settings overlay `--settings '{"modelProvider":"gemini"}'` with `GEMINI_API_KEY` exported (the CLI does not load `.env`; never write the shared `settings.json` — GC2). If the key is unavailable, the machine's live OAuth sign-in is the documented fallback evidence source (it produced the existing real conversations) — real-binary authenticated evidence either way, version-stamped in every receipt.

---

## The corrected record contract (what Task 1 pins, Tasks 2-3 implement)

The three on-machine real conversations (produced by agy 1.2.11 and 1.4.12 — store-log-attributed, schemas identical across both; paths in the explorer reports under the run's logs dir) and the fresh scratch conversations Task 1 mints establish, as shape-only binary facts:

- Record types: `USER_INPUT`, `PLANNER_RESPONSE`, `GENERIC`, `SYSTEM_MESSAGE`, `CHECKPOINT` — and NOTHING else. No `session_start`, `user_message`, `assistant_message`, or `turn_settled` record exists in any real transcript.
- Every record carries `type`, `source` (`USER_EXPLICIT` | `MODEL` | `SYSTEM`), `status` (`DONE` | `ERROR`), `step_index` (int), `created_at` (RFC3339 UTC, **second** granularity). Optional: `content`, `thinking`, `tool_calls`, `media`, `error`, `truncated_fields`, and the flat token fields `input_tokens`/`output_tokens`/`cache_read_tokens` (null on almost all records; no `totalTokens` key exists).
- No `conversationId`, `workspacePaths`, `at`, `text`, `usage`, `startedAt`, `fullyIdle`, or `outcome` field exists anywhere. The conversation id IS the `brain/<id>` directory name.
- `created_at` collides routinely within one second (observed: records sharing `08:09:26Z`, `18:28:56Z`, and more); `step_index` is unique per record within a conversation, strictly increases across turns, and is NOT monotonic in file order (out-of-order appends observed).
- There is NO turn-settle record of any kind: a turn is `USER_INPUT` → a run of MODEL records; an errored turn shows `status:"ERROR"` (with `error`) on its final record.
- Store siblings: `transcript.jsonl` (carries `truncated_fields` markers) + `transcript_full.jsonl` (same vocabulary, full values) + `chunks/`; Freshell reads `transcript.jsonl`.

Consequences this plan owns (sanctioned by the Accepted tradeoffs — correction, not promotion):

1. The kata's `turn_settled.at` question is unanswerable as literally posed: no such record exists. The binary answer is: (i) no real settle record exists, so the per-settle dedupe has no real referent to swallow; (ii) real `created_at` is second-granularity and demonstrably collides, so ANY dedupe keyed on wall-clock alone WOULD collide; (iii) `step_index` is the collision-proof per-record identity (unique per record, strictly increasing across turns). The corrected dedupe therefore keys on the record identity `(created_at, step_index)`, and the property "two genuine turns can never share a dedupe key" holds by construction. THE BINARY PROOF is the receipts — the corpus facts (Task 1 Step 2) plus the fresh same-conversation receipts (Task 1 Step 6: step_index unique per record, strictly increasing across turns, on a conversation this run minted) — NOT any test. The Task 2 tracker test `same_second_settles_with_distinct_step_indexes_both_complete` pins the dedupe MACHINERY against today's swallowing rule using the labeled fake-contract `turn_settled` extension (Consequence 2); it exercises the code path end to end but supplies no binary evidence about records the binary does not produce, and the gate-flip citation (Task 3) rests on the receipts alone.
2. Two structures the candidate schema invented are retained ONLY as explicitly-labeled fake-contract test extensions (the e2e/rebind fakes append them to drive the locator and attention machinery): the `session_start` ownership record (the locator's cwd/ownership anchor — real transcripts carry no ownership or workspace evidence, so transcript-driven identity binding does not engage on real-format sessions; recorded limitation) and the `turn_settled` settle record (the attention machinery's settle signal — real transcripts carry none; recorded limitation). Both carry the real-shaped field discipline (`created_at`, `step_index`) so the corrected dedupe is exercised end to end.
3. The resume path itself parses NO transcript records: the gate consults the path-anchored by-id locator (`crates/freshell-server/src/antigravity_existence_by_id.rs` — `File::open(brain/<id>/.system_generated/logs/transcript.jsonl)`), which the real corpus validates. CAVEATS the flip must close (Task 3, plan-review rounds 2-3 findings 1): the production probe answers `Present` from a warm-index hit without touching the disk (`existence.rs:325-328`) and `Unknown` while the index is cold (every startup, before warm-up) — both windows would pass a stale id to `agy`, whose documented missing-ID behavior silently starts a fresh conversation (GC3 violation), and the cold window passes ANY id through on `Unknown → Proceed`. The activation therefore adds a gate-variant validation: for antigravity, BOTH `Present` and `Unknown` answers are validated against the same on-disk by-id walk before the gate trusts them (disk Present confirms; disk Absent corrects to the typed refusal; disk Unreadable defers as Unknown, G28 fail-open). With that validation in place the flip is safe for on-disk conversations the moment the corrected schema lands and a real resume is proven — the sequencing this plan enforces.
4. The real format carries no workspace evidence, so real conversations index with cwd `None` (project "unknown"). The Task 2 removal of the antigravity cwd gate is the decided tradeoff that makes real conversations visible in history at all.

---

### Task 1: Real-binary transcript evidence (corpus + scratch conversation + real resume proof)

**Files:**
- Create: `/home/dan/code/freshell/.worktrees/.the-usual-logs/antigravity-transcript-validation/reports/real-binary-transcript-evidence.md` (evidence log, outside the tracked tree)
- Modify: `docs/plans/2026-10-29-google-cli-first-class-support.md:67` (row 67: record-schema blocker clause), `:70` (row 70: content continuation), `:74` (candidate schema row), `:75` (real-binary follow-up row (a)/(b)), `:78-87` (candidate schema block superseded)
- Modify (bookkeeping, untracked): `.worktrees/.the-usual-logs/antigravity-transcript-validation/run-state.md` (baseline ledger: the focused Rust lanes)

**Interfaces:**
- Consumes: the real snap store at `~/snap/antigravity-cli/common/.gemini/antigravity-cli` (three real conversations under `brain/<id>/.system_generated/logs/transcript.jsonl`); `agy` on PATH (the `~/.local/bin/agy` wrapper exec'ing the snap 1.4.12 binary); `GEMINI_API_KEY` in the env (fallback: the machine's live OAuth — GC15).
- Produces: the validated record schema (the "corrected record contract" above, confirmed or corrected by the fresh receipts), verbatim evidence receipts, the Contract Record row flips with version+date stamps, and the real-resume proof the gate flip cites. No production code.

No Red step: this is an investigation/evidence task (the google-cli plan's Task 1 precedent — the deliverable is the honest record). Every probe is bounded (`timeout`), read-only over user data (shape-only), and cleans up what it creates (GC12).

- [ ] **Step 1: Record the focused Rust baseline lanes (the run-state's pending item)**

Run (from the worktree root):

```bash
cargo test -p freshell-sessions && cargo test -p freshell-activity && cargo test -p freshell-platform
cargo test -p freshell-ws --lib antigravity
cargo test -p freshell-ws --test resume_validation_gate && cargo test -p freshell-ws --test antigravity_launch_e2e
scripts/sandbox-test.sh "cargo test -p freshell-ws --test antigravity_session_rebind"
cargo test -p freshell-server antigravity && cargo test -p freshell-agent-runtime antigravity
```

Expected: PASS for every lane (the baseline ledger's known failures are vitest-only, in the out-of-scope parity legs). Any red here is a NEW pre-existing failure: record it in `run-state.md`'s baseline ledger before proceeding (do not fix it in this run unless it blocks this delta's lanes).

- [ ] **Step 2: Re-derive the schema from the real corpus (read-only, shape-only)**

```bash
mkdir -p /tmp/opencode/yhqb
AGY_STORE="$HOME/snap/antigravity-cli/common/.gemini/antigravity-cli"
find "$AGY_STORE/brain" -name transcript.jsonl | sort
for f in $(find "$AGY_STORE/brain" -name transcript.jsonl | sort); do jq -r '.type' "$f" | sort | uniq -c; done
jq -r '[.type,.source,.status] | @tsv' "$AGY_STORE"/brain/*/.system_generated/logs/transcript.jsonl | sort | uniq -c
grep -c -E '"conversationId"|"workspacePaths"|"turn_settled"|"session_start"|"user_message"|"assistant_message"|"fullyIdle"' "$AGY_STORE"/brain/*/.system_generated/logs/transcript.jsonl
jq -r 'keys[]' "$AGY_STORE"/brain/*/.system_generated/logs/transcript.jsonl | sort | uniq -c
jq -r '.created_at' "$AGY_STORE"/brain/*/.system_generated/logs/transcript.jsonl | sort | uniq -c | sort -rn | head -8
BIG="$AGY_STORE/brain/1dacceee-75aa-4116-9ae3-a5b6d1532485/.system_generated/logs/transcript.jsonl"
jq -r '.step_index' "$BIG" | sort -n | uniq -d
jq -r 'select(.type=="USER_INPUT") | [.step_index, .created_at] | @tsv' "$BIG"
jq -r 'select(.input_tokens != null) | [.type, .step_index, .input_tokens, .output_tokens, .cache_read_tokens] | @tsv' "$AGY_STORE"/brain/*/.system_generated/logs/transcript.jsonl
```

Expected (record every output verbatim in the evidence report): only the five real types; `source` ∈ {USER_EXPLICIT, MODEL, SYSTEM}; `status` ∈ {DONE, ERROR}; the candidate-key grep prints `0` for every file; the key union is exactly the real field set; the `created_at` histogram shows same-second groups (counts > 1); the step-index duplicate check prints nothing (unique per record); the multi-turn conversation's `USER_INPUT` records show strictly increasing step indexes (0 and 116) with second-granularity stamps; the token scan shows flat snake_case fields on a sparse subset of `PLANNER_RESPONSE` records. Also record per-type content-presence stats: how many `PLANNER_RESPONSE` records carry null/empty `content` (corpus: 42/45), the ~4KB truncated-content prefix lengths where `truncated_fields` includes `content`, and the fact that only the turn-final planner record of each multi-step turn carries the reply. The parser's first-NON-EMPTY summary read therefore selects turn 1's final reply — record that reading as evidenced by this shape (the naive "first PLANNER_RESPONSE carries the reply" is false in real multi-step turns). Record the store-log version lines that attribute the corpus (bounding receipts, re-quoted 2026-11-02: `I1030 01:09:09.367593 146 server.go:1631] Language server version: 1.2.11`; `I1031 11:29:14.566956 147 server.go:1953] Language server version: 1.4.12`).

- [ ] **Step 3: Version-stamp the binary (self-update risk)**

```bash
agy --version
```

Expected: `1.4.12`. Record it; re-run after all probes and record again (a drifted version means the receipts may be version-mixed — record honestly).

- [ ] **Step 3b: Fence the shared config (checksum guard around every probe)**

```bash
AGY_STORE="$HOME/snap/antigravity-cli/common/.gemini/antigravity-cli"
mkdir -p /tmp/opencode/yhqb
sha256sum "$AGY_STORE/settings.json" | cut -d' ' -f1 > /tmp/opencode/yhqb/settings.sha.base
stat -c '%y %s' "$AGY_STORE/settings.json" > /tmp/opencode/yhqb/settings.stat.base
cp "$AGY_STORE/settings.json" /tmp/opencode/yhqb/settings.json.backup
fence() {
  now=$(sha256sum "$AGY_STORE/settings.json" | cut -d' ' -f1)
  if [ "$now" != "$(cat /tmp/opencode/yhqb/settings.sha.base)" ]; then
    # GC2: never blindly overwrite the shared settings.json. Attribute the
    # change by CONTENT, not by key presence: restore only when the current
    # file equals the baseline plus EXACTLY a modelProvider insertion
    # (stripping the key reproduces the baseline byte-for-byte). Any other
    # diff — including a concurrent legitimate change that adds modelProvider
    # alongside anything else — is left untouched, recorded verbatim, and the
    # run aborts.
    if jq -S 'del(.modelProvider)' "$AGY_STORE/settings.json" > /tmp/opencode/yhqb/settings.now.stripped 2>/dev/null &&
       jq -S . /tmp/opencode/yhqb/settings.json.backup > /tmp/opencode/yhqb/settings.base.sorted &&
       cmp -s /tmp/opencode/yhqb/settings.now.stripped /tmp/opencode/yhqb/settings.base.sorted; then
      cp /tmp/opencode/yhqb/settings.json.backup "$AGY_STORE/settings.json"
      echo "settings.json MUTATED by the last invocation with this run's exact damage signature (baseline + modelProvider insertion only) — byte-exact backup restored; ABORT (GC2 violation: record the diff and mtime in the evidence report)"
    else
      echo "settings.json CHANGED (not this run's exact damage signature — possibly a concurrent legitimate change) — left untouched; ABORT and record the diff and mtime verbatim in the evidence report"
    fi
    exit 1
  fi
  stat -c '%y %s' "$AGY_STORE/settings.json"
}
cat /tmp/opencode/yhqb/settings.sha.base
```

Expected: the printed sha256 is `134d65225f7cacfc1bfbfbfe29e6289363b6f5914d88cae206ff2ddd591b78b1` (baseline captured 2026-11-02; mtime 2026-10-30 01:04:06, 443 B). Run `fence` after EVERY agy invocation in Steps 4-5 — the `--settings` key form AND the OAuth-fallback form both touch the live store — and record the before/after checksums in the evidence report. On mismatch the guard attributes the change by CONTENT: it restores the byte-exact backup (which lives OUTSIDE the store) ONLY when the current file equals the baseline plus exactly a `modelProvider` insertion (stripping the key reproduces the baseline byte-for-byte); any other diff — including a concurrent legitimate change that adds `modelProvider` alongside anything else — is left untouched, with the diff + mtime + which invocation recorded verbatim and the run aborted. Never papered over, never clobbered. The binary's own `--help` claims the overlay is "Settings for this session only, never saved" — this fence is the on-host proof, not a restatement of that claim.

- [ ] **Step 4: Mint a fresh scratch conversation this run owns (headless turn)**

```bash
ls "$AGY_STORE/brain" | sort > /tmp/opencode/yhqb/brain-before.txt
for f in settings.json cache/last_conversations.json history.jsonl conversation_summaries.db cli.log; do
  stat -c "%n %y %s" "$AGY_STORE/$f"; sha256sum "$AGY_STORE/$f" | cut -d' ' -f1
done > /tmp/opencode/yhqb/shared-files-before.txt
cat /tmp/opencode/yhqb/shared-files-before.txt
NONCE1="freshell-yhqb-$(date -u +%Y%m%dT%H%M%SZ)"
timeout 240 env GEMINI_API_KEY="${GEMINI_API_KEY:?export GEMINI_API_KEY first (else use the OAuth fallback)}" \
  agy --settings '{"modelProvider":"gemini"}' -p="Reply with exactly: $NONCE1" \
  > /tmp/opencode/yhqb/turn1.out 2> /tmp/opencode/yhqb/turn1.err
echo "exit=$?"; grep -c "$NONCE1" /tmp/opencode/yhqb/turn1.out
fence
ls "$AGY_STORE/brain" | sort > /tmp/opencode/yhqb/brain-after.txt
comm -13 /tmp/opencode/yhqb/brain-before.txt /tmp/opencode/yhqb/brain-after.txt
```

Shared-file pre-run baselines (2026-11-02, strategist receipts): settings.json `134d6522…b78b1` (Oct 30 01:04:06, 443 B — must NOT move; the Step 3b fence guards it); cache/last_conversations.json `28feeb29…30da` (Oct 31 11:47:14, 230 B — expected to move: the pointer); history.jsonl `1f7334be…39387` (Oct 31 11:28:56, 1741 B — expected display lines); conversation_summaries.db `2ceb7213…236c` (Oct 31 11:29:45, 20480 B — possible ghost row); cli.log `03924560…7f3a` (Oct 31 11:29:14, 27 B). Re-run the same stat+sha256 loop after every scratch turn and record all deltas in the evidence report — record, do not "fix"; these are the CLI's own files.

Expected: exit 0; the nonce echoed; the fence passes (settings.json unchanged); exactly one new `<uuid>` under `brain/`. Auth ordering (strategist receipts, 2026-11-02; overlay-first on BOTH paths — the modelProvider precondition is the User Request's explicit constraint, not an API-key-only nicety): (1) if the coordinator obtains a key (user-approved source: the Freshell config's `settings.ai.geminiApiKey`, OneCLI after `onecli auth login`, or a user-supplied key), run the primary command as written (`--settings` overlay + the key exported into the probe env only, never printed); (2) on ANY key-path failure (invalid key, CLI-setup error) or no key, run the same invocations WITH the `--settings` overlay and without the env guard (the machine's live OAuth sign-in — GC15) — the fallback invocation is itself the OAuth-liveness probe (the token file carries no readable expiry; `auth_method` is `consumer`; last refreshed 2026-10-31) — and record which auth produced the evidence; (2b) ONLY if the binary rejects the `--settings '{"modelProvider":"gemini"}'` overlay under OAuth auth (a CLI-setup error naming the combination), retry once WITHOUT the overlay to diagnose the binary's behavior — those receipts are DIAGNOSTIC ONLY and CANNOT support the gate flip: the User Request's explicit settings precondition is unsatisfied on that path, so if ONLY branch (2b) succeeds the run records the constraint conflict and the flip does NOT happen (GC13) — the receipts record the deviation honestly and the flip waits for overlay-conformant evidence; (3) if the OAuth path also fails, STOP: record the blocker in the evidence report and `run-state.md`, and do NOT run Task 3's flip (GC13) — Task 2 still lands (the correction is warranted by the corpus evidence alone), and the run reports the gate item as blocked. A key-path failure is "try OAuth", never an immediate STOP.

Resolve the conversation id — assign the DIRECTORY name directly (the loop body confirms which fresh conversation carries the nonce; `grep -l` would print a transcript path, not an id, so do not parse command output by hand):

```bash
CONV_ID=""
for id in $(comm -13 /tmp/opencode/yhqb/brain-before.txt /tmp/opencode/yhqb/brain-after.txt); do
  if grep -q "$NONCE1" "$AGY_STORE/brain/$id/.system_generated/logs/transcript.jsonl" 2>/dev/null; then
    CONV_ID="$id"
  fi
done
case "$CONV_ID" in
  ''|*[!0-9a-fA-F-]*) echo "CONV_ID unresolved or not a UUID shape — REFUSING every store deletion; resolve manually before ANY rm"; exit 1;;
esac
echo "CONV_ID=$CONV_ID" | tee /tmp/opencode/yhqb/conv-id.txt
```

The UUID-shape guard is MANDATORY (Critical load-bearing finding C1): if the nonce-grep prints nothing (auth failure, transcript lag, store-root divergence), an empty `CONV_ID` would otherwise expand the Step 7 cleanup to the user's ENTIRE `brain/` tree — irreversible loss of every real conversation. Never bypass the guard. Cleanup is NOT gated on receipt success: once `CONV_ID` is validated, the scratch conversation is this run's litter and MUST be removed even when Steps 4-6's receipts fail or the STOP branch fires — record the receipts (or their failure) FIRST, then clean up. The only legitimate cleanup-preventing condition is an unresolvable `CONV_ID` (the guard refuses): in that case record the residue honestly (the new `brain/<uuid>` path(s), the nonce, and why resolution failed) in the evidence report and `run-state.md`. The receipts gate the GATE FLIP (GC13), never the cleanup.

- [ ] **Step 5: Real resume probe + back-to-back turns (the never-probed headless resume)**

Read-only de-risk (2026-11-02): the binary's `--help` documents both flags independently (`--conversation  Resume a previous conversation by ID`; `-p`, short alias of `--print  Run a single prompt non-interactively and print the response`) with no mutual-exclusion note, and the store's 17 CLI logs record no argv at all (no `--conversation` or `--print` lines), so this step remains the first-ever probe of the combination — on rejection, the bounded-PTY fallback is `agy --conversation <id>` on a pty (the documented `--prompt-interactive` middle shape also exists), recording whichever shape the binary actually supports. Keep the `--settings` overlay on the OAuth path too (overlay-first per the Step 4 auth ordering); the no-overlay form exists only as branch (2b)'s diagnostic retry, whose receipts cannot support the flip.

```bash
timeout 240 agy --settings '{"modelProvider":"gemini"}' --conversation "$CONV_ID" \
  -p="Reply with exactly the string I asked you to reply with in the first message." \
  > /tmp/opencode/yhqb/turn2.out 2> /tmp/opencode/yhqb/turn2.err
echo "exit=$?"; grep -c "$NONCE1" /tmp/opencode/yhqb/turn2.out; grep -c 'warning: conversation' /tmp/opencode/yhqb/turn2.err
fence
NONCE2="$NONCE1-b"
timeout 240 agy --settings '{"modelProvider":"gemini"}' --conversation "$CONV_ID" \
  -p="Reply with exactly: $NONCE2" > /tmp/opencode/yhqb/turn3.out 2> /tmp/opencode/yhqb/turn3.err
echo "exit=$?"; grep -c "$NONCE2" /tmp/opencode/yhqb/turn3.out
fence
```

Expected: exit 0 each; turn 2's stdout contains `NONCE1` (content continuity — the resume hit the SAME conversation); no `warning: conversation` on stderr; turn 3 echoes `NONCE2`. If the headless `-p --conversation <id>` combination is REJECTED by the binary (never probed before), record the exact rejection verbatim and re-probe resume through a bounded PTY session instead (the probed interactive shape: `agy --conversation <id>` on a pty, one prompt, exit) — the requirement is binary-level content continuity, not a specific flag combination; record whichever shape the binary actually supports.

- [ ] **Step 6: Pin the collision and token receipts from the scratch transcript**

```bash
T="$AGY_STORE/brain/$CONV_ID/.system_generated/logs/transcript.jsonl"
jq -r 'select(.type=="USER_INPUT") | [.step_index, .created_at] | @tsv' "$T"
jq -r '.step_index' "$T" | sort -n | uniq -d
jq -r '.created_at' "$T" | sort | uniq -c | sort -rn | head -5
jq -r 'select(.input_tokens != null) | [.step_index, .input_tokens, .output_tokens, .cache_read_tokens] | @tsv' "$T"
```

Expected: three `USER_INPUT` records with strictly increasing step indexes across the turns; the duplicate check prints nothing (step_index unique per record — the collision-proof identity); any same-second groups recorded (the corpus already proves second-granularity collisions; these receipts add the run-owned witness); the token-bearing records recorded with values. The token receipts settle Contract Record row 75(b): if one token-bearing record appears PER TURN, the fields are per-turn usage records and the parser's LAST-wins reads the latest turn's usage (record that reading); if only the conversation-final turn bears tokens, per-turn-vs-cumulative stays underdetermined — record that honestly (the LAST-wins choice and its under-report residual stay documented either way). If the fresh receipts DISPROVE the collision-proof identity — a duplicate `step_index` within the scratch transcript, or USER_INPUT steps that do not strictly increase across the three turns (e.g. the binary resets steps per process) — the run does NOT proceed to Task 3: record the receipts verbatim in the evidence report and `run-state.md` as a named blocker, re-key the Task 2 dedupe design on an identity the receipts actually support (or record the collision question as unresolved), and the gate flip does not happen (GC13) — the flip's `step_index`-based "collision-proof by construction" claim would be unsound.

- [ ] **Step 7: Cleanup, write the report, flip the Contract Record rows, commit**

```bash
case "$CONV_ID" in
  ''|*[!0-9a-fA-F-]*) echo "CONV_ID unresolved or not a UUID shape — REFUSING cleanup"; exit 1;;
esac
rm -rf "$AGY_STORE/brain/$CONV_ID" "$AGY_STORE/conversations/$CONV_ID.db"
grep -rl "$NONCE1" "$AGY_STORE"/brain/*/.system_generated/logs/transcript.jsonl 2>/dev/null
agy --version
fence
```

NOTE the ordering: the evidence report below is written from the receipts retained under `/tmp/opencode/yhqb` (turn outputs, errors, shared-file deltas, checksums) — that directory is removed ONLY AFTER the report exists. Never `rm -rf /tmp/opencode/yhqb` before the report is written; if the run aborts early, leave the directory for the resumed session.

Expected: the final grep prints nothing (every run-created conversation removed; record the created/removed paths, and any `history.jsonl` display lines the CLI wrote, in the report — do not edit the user's `history.jsonl`); the closing `agy --version` matches the opening stamp (or the drift is recorded).

Write `reports/real-binary-transcript-evidence.md` (under the run's logs dir): verbatim commands + outputs, the version stamps, the auth path used, the schema shape tables, the collision/step/token receipts, the resume proof, the cleanup record. Follow the `contract-probe.md` model (hygiene section included). Only now — with the report written — remove the retained receipts: `rm -rf /tmp/opencode/yhqb`.

Then update `docs/plans/2026-10-29-google-cli-first-class-support.md`:

- Row `:67`: the record-schema blocker clause flips to `documented+validated (real binary transcripts — agy 1.2.11 + 1.4.12 corpus, store-log-attributed, schemas identical, plus fresh 1.4.12 receipts — 2026-11-02; corrected schema below — the candidate record vocabulary is disproven)`.
- Row `:70`: the content-continuation half flips to cite the Task 1 resume probe receipts (headless `--conversation` continuation proven, or the PTY shape the binary actually supported — whichever the receipts show).
- Row `:74`: flips to `real-binary-validated (corrected schema; agy 1.2.11 + 1.4.12 corpus, store-log-attributed, plus fresh 1.4.12 receipts, 2026-11-02)` with a pointer to the evidence report and the note that Task 2 implements the correction.
- Row `:75`: item (a) flips to the binary answer — `turn_settled` does not exist in the real format; `created_at` is second-granularity and collides; the corrected dedupe keys on `(created_at, step_index)`, step_index binary-evidenced unique per record and strictly increasing across turns. Item (b) flips to the token receipts' reading (per-turn vs underdetermined).
- The candidate-schema block `:78-87` gains a `SUPERSEDED (2026-11-02)` header and the corrected schema block:

```jsonl
{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":<int>,"created_at":"<RFC3339 seconds>","content":"<prompt>"}
{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":<int>,"created_at":"<RFC3339 seconds>","content":"<reply>","input_tokens":<int|null>,"output_tokens":<int|null>,"cache_read_tokens":<int|null>}
{"type":"GENERIC","source":"MODEL","status":"DONE"|"ERROR","step_index":<int>,"created_at":"<RFC3339 seconds>","content":"<step output>","error":"<message on ERROR records>"}
{"type":"SYSTEM_MESSAGE","source":"SYSTEM","status":"DONE","step_index":<int>,"created_at":"<RFC3339 seconds>","content":"<system text>"}
{"type":"CHECKPOINT","source":"SYSTEM","status":"DONE","step_index":<int>,"created_at":"<RFC3339 seconds>","content":"<checkpoint summary>"}
```

plus the binary facts (id = `brain/<id>` dir name; no ownership/workspace/settle records; step_index unique per record, strictly increasing across turns, not file-order monotonic) and the two fake-contract extensions (`session_start` ownership anchor, `turn_settled` settle record) with their no-real-referent labels.

```bash
git add docs/plans/2026-10-29-google-cli-first-class-support.md
git commit -m "docs(plan): record real-binary antigravity transcript evidence"
```

Also update `run-state.md` (untracked): the baseline-ledger entry for the Step 1 lanes and the Task 1 completion with the evidence-report path.

---

### Task 2: Correct the antigravity record vocabulary across every consumer and test double

**Files:**
- Replace: `test/fixtures/coding-cli/antigravity/fresh.sanitized.jsonl`, `resumed.sanitized.jsonl`, `errored.sanitized.jsonl`, `malformed-tail.sanitized.jsonl`, `zero-turn.sanitized.jsonl`; Create: `test/fixtures/coding-cli/antigravity/steps-and-seconds.sanitized.jsonl`, `fake-contract.sanitized.jsonl`; Delete: `test/fixtures/coding-cli/antigravity/tool-use.sanitized.jsonl`, `two-same-dir.sanitized.jsonl` (their candidate premises — unknown tool-record vocabulary, two ids in one file — are disproven; their pins are replaced by `steps-and-seconds` and `fake-contract`)
- Modify: `crates/freshell-sessions/src/parse/antigravity.rs` (full parser correction + module doc + in-file tests)
- Modify: `crates/freshell-sessions/src/antigravity.rs:70-99` (source: id from path, cwd-gate removal, `parse_failed` reasons), `:181-243` (`parse_failed`, `indexed_from_meta` doc), in-file tests (`:643`, `:707`, `:823` plants and the cwd-gate tests)
- Modify: `crates/freshell-sessions/src/provider_layout.rs:280-285` (the `AntigravityLayout` Stage-1 candidate note → real-binary-validated path; add `conversation_id_from_path`), `crates/freshell-sessions/src/provider_layout_antigravity_home_tests.rs` (only if it pins the moved text)
- Modify: `crates/freshell-sessions/src/search.rs:232-246` (`extract_antigravity_message`) + antigravity search tests `:338-465`
- Modify: `crates/freshell-sessions/tests/antigravity_fixture_parity.rs` (rewritten pins)
- Modify: `crates/freshell-sessions/src/antigravity_locator.rs:15-29` (evidence-rule doc), `:31-54` (tolerance note — the Stage-1 granularity UNKNOWN resolves to binary-evidenced seconds), `:71-79` (candidate header), `:755-830` (the tail-window reader: `USER_INPUT`/`content`/`created_at`), in-file test plants `:865`, `:1044`, `:1143`, `:1255-1259`
- Modify: `crates/freshell-protocol/src/common.rs:471` (the tolerance doc's `user_message`/`at` wording → `USER_INPUT`/`created_at` + the binary-evidenced granularity)
- Modify: `crates/freshell-activity/src/antigravity.rs:1-98` (module doc), `:127-145` (kind enum + record struct), `:150-167` (classifier), `:172-180` (`record_at_ms` doc), `:199-206` (prefilter), the tailer's record extraction (`value.get("at")` at ~`:418`), `:479-488` (state fields), `:715-827` (`note_attach_baseline`), `:831-932` (`note_record` + the dedupe at `:886-894`), in-file tests `:1132-2363`
- Modify: `crates/freshell-ws/src/antigravity_association.rs:1852-1859` (in-file test plants)
- Modify: `crates/freshell-ws/src/activity.rs` (the antigravity hub tests' planted transcripts, in-file `mod tests` `:3760-5100`)
- Modify: `crates/freshell-ws/tests/antigravity_session_rebind.rs` (`write_fake_agy`'s record writes ~`:180-210`, `plant_transcript:459-487`)
- Modify: `test/e2e-browser/fixtures/fake-agy-terminal.mjs:13-18` (header), `:79-112` (turn program/verb docs), `:257-285` (the `/remember:` recovery reader), `:351-380` (`appendUserMessage`/`appendAssistantMessage`/`appendTurnSettled`)
- Modify: `test/e2e-browser/specs/google-cli-identity-activity-rust.spec.ts:1068-1076` (stale-write plant), `:1118-1130` (existing-conversation plant)
- Modify: `test/e2e-browser/specs/google-cli-history-resume-rust.spec.ts:40-48` (structural-search premise), `:652-668` (the structural search)

**Interfaces:**
- Produces: `parse_antigravity_session_content(content: &str, conversation_id: &str) -> Option<ParsedSessionMeta>` (signature change: the id is the `brain/<id>` directory name — real records carry no id).
- Produces: `AntigravityLayout::conversation_id_from_path(path: &Path) -> Option<String>` (the `brain/<id>/.system_generated/logs/transcript.jsonl` shape authority).
- Produces: `AntigravityRecordKind::{UserInput, TurnSettled}` (`UserMessage` renamed to the real vocabulary; `TurnSettled` retained as the labeled fake-contract settle) and `AntigravityTranscriptRecord { kind: AntigravityRecordKind, at: Option<i64>, step_index: Option<i64> }` (`at` now read from `created_at`).
- Produces: `SettleIdentity { at: i64, step_index: Option<i64> }` with pair ordering (`None` = `i64::MIN` stand-in) — the dedupe key.
- Unchanged: `ParsedSessionMeta`, `TokenSummary`, `IndexedSession`, `note_record`/`note_attach_baseline` signatures, the wire `AntigravityActivityRecord`/`TerminalTurnComplete` shapes (the step stays tracker-internal), `TurnCompletionLedger` (its at-watermark folds in as the `(at, None)` defense-in-depth branch).

This change is deliberately ONE atomic task: the classifier, locator, parser, and every test double consume the same records, so any partial landing leaves a red suite (the e2e fake feeds both the parser and the tracker; the rebind fake feeds the locator).

- [ ] **Step 1: Write the failing behavioral tests**

**1a — the rewritten fixture-parity tests** (`crates/freshell-sessions/tests/antigravity_fixture_parity.rs`, replacing the whole test set):

```rust
//! Fixture-parity for the antigravity (Antigravity CLI, `agy`) transcript
//! `.jsonl` parser — the REAL-BINARY record contract (agy 1.2.11 + 1.4.12,
//! store-log-attributed, schemas identical, plus fresh 1.4.12 receipts;
//! corrected 2026-11-02 against real transcripts; evidence:
//! .worktrees/.the-usual-logs/antigravity-transcript-validation/reports/
//! real-binary-transcript-evidence.md). Every fixture is a SYNTHETIC
//! real-shaped transcript: step-indexed records with second-granularity
//! `created_at`, no ownership record, id = the brain/<id> directory
//! (passed explicitly). `fake-contract.sanitized.jsonl` additionally
//! pins the labeled fake-contract ownership anchor the e2e/rebind fakes
//! append (real transcripts carry no such record).

use freshell_sessions::meta::ParsedSessionMeta;
use freshell_sessions::{parse_antigravity_session_content, TokenSummary};
use std::path::PathBuf;

fn antigravity_fixture(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/coding-cli/antigravity")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// The `TokenSummary` the real format's FLAT token fields map to
/// (input_tokens/output_tokens/cache_read_tokens; total = input+output —
/// the real format has no totalTokens key; no context-meter trio).
fn usage(input: i64, output: i64, cached: i64, total: i64) -> TokenSummary {
    TokenSummary {
        input_tokens: input,
        output_tokens: output,
        cached_tokens: cached,
        total_tokens: total,
        context_tokens: None,
        model_context_window: None,
        compact_threshold_tokens: None,
        compact_percent: None,
    }
}

#[test]
fn fresh_fixture_matches_the_real_binary_contract() {
    let meta = parse_antigravity_session_content(
        &antigravity_fixture("fresh.sanitized.jsonl"),
        "11111111-2222-3333-4444-555555555555",
    )
    .expect("real-shaped records parse");
    let expected = ParsedSessionMeta {
        session_id: Some("11111111-2222-3333-4444-555555555555".to_string()),
        cwd: None, // real records carry no workspace evidence
        created_at: Some(1_793_304_001_000), // 2026-10-29T20:00:01Z, seconds
        last_activity_at: Some(1_793_304_005_000),
        title: Some("Fix the flaky test".to_string()),
        title_provider_generated: false,
        summary: Some("Fixed the test.".to_string()),
        first_user_message: Some("Fix the flaky test".to_string()),
        message_count: 2,
        token_usage: Some(usage(10, 20, 0, 30)),
        ..Default::default()
    };
    assert_eq!(meta.title_source, None);
    assert_eq!(meta, expected);
}

#[test]
fn resumed_fixture_parses_both_turns_and_last_token_record_wins() {
    let meta = parse_antigravity_session_content(
        &antigravity_fixture("resumed.sanitized.jsonl"),
        "22222222-3333-4444-5555-666666666666",
    )
    .expect("real-shaped records parse");
    let expected = ParsedSessionMeta {
        session_id: Some("22222222-3333-4444-5555-666666666666".to_string()),
        cwd: None,
        created_at: Some(1_793_307_601_000), // turn 1's USER_INPUT (min fold)
        last_activity_at: Some(1_793_469_604_000), // turn 2's reply (max fold)
        title: Some("First prompt before exit".to_string()),
        title_provider_generated: false,
        summary: Some("First reply.".to_string()),
        first_user_message: Some("First prompt before exit".to_string()),
        message_count: 5,
        // The LAST token-bearing record wins (turn 2's; turn 1's 15/25
        // never survives) — the documented reading per the evidence
        // receipts (Provider Contract Record row 75(b)).
        token_usage: Some(usage(40, 5, 2, 45)),
        ..Default::default()
    };
    assert_eq!(meta, expected);
}

#[test]
fn errored_fixture_parses_the_real_error_shape() {
    let meta = parse_antigravity_session_content(
        &antigravity_fixture("errored.sanitized.jsonl"),
        "44444444-5555-6666-7777-888888888888",
    )
    .expect("an errored turn still parses");
    let expected = ParsedSessionMeta {
        session_id: Some("44444444-5555-6666-7777-888888888888".to_string()),
        cwd: None,
        created_at: Some(1_793_314_801_000),
        last_activity_at: Some(1_793_314_802_000),
        title: Some("Do the failing thing".to_string()),
        title_provider_generated: false,
        summary: None, // no PLANNER_RESPONSE: a GENERIC ERROR record is not a reply
        first_user_message: Some("Do the failing thing".to_string()),
        message_count: 2,
        token_usage: None,
        ..Default::default()
    };
    assert_eq!(meta, expected);
}

#[test]
fn steps_and_seconds_fixture_pins_out_of_order_steps_and_same_second_stamps() {
    let meta = parse_antigravity_session_content(
        &antigravity_fixture("steps-and-seconds.sanitized.jsonl"),
        "33333333-4444-5555-6666-777777777777",
    )
    .expect("real-shaped records parse");
    let expected = ParsedSessionMeta {
        session_id: Some("33333333-4444-5555-6666-777777777777".to_string()),
        cwd: None,
        created_at: Some(1_793_347_766_000), // 2026-10-30T08:09:26Z (min)
        last_activity_at: Some(1_793_347_768_000), // 08:09:28Z (max)
        title: Some("Run the suite and report".to_string()),
        title_provider_generated: false,
        summary: Some("Tests pass.".to_string()),
        first_user_message: Some("Run the suite and report".to_string()),
        message_count: 5,
        token_usage: None,
        ..Default::default()
    };
    assert_eq!(meta, expected);
}

#[test]
fn zero_turn_fixture_has_identity_but_no_messages() {
    let meta = parse_antigravity_session_content(
        &antigravity_fixture("zero-turn.sanitized.jsonl"),
        "55555555-6666-7777-8888-999999999999",
    )
    .expect("a system-only transcript is still a conversation");
    let expected = ParsedSessionMeta {
        session_id: Some("55555555-6666-7777-8888-999999999999".to_string()),
        cwd: None,
        created_at: Some(1_793_318_400_000),
        last_activity_at: Some(1_793_318_400_000),
        title: None,
        title_provider_generated: false,
        summary: None,
        first_user_message: None,
        message_count: 1,
        token_usage: None,
        ..Default::default()
    };
    assert_eq!(meta, expected);
}

#[test]
fn fake_contract_fixture_takes_cwd_from_the_ownership_record_and_the_dir_id_wins() {
    let meta = parse_antigravity_session_content(
        &antigravity_fixture("fake-contract.sanitized.jsonl"),
        "11111111-2222-3333-4444-555555555555",
    )
    .expect("the fake-contract extension records still parse");
    let expected = ParsedSessionMeta {
        // The DIRECTORY id (the caller's parameter) is the authority —
        // the fake's ownership record carries a DIFFERENT id and never
        // reassigns it (real binary: the id IS the dir name).
        session_id: Some("11111111-2222-3333-4444-555555555555".to_string()),
        cwd: Some("/home/u/fake".to_string()), // from the session_start anchor
        created_at: Some(1_793_322_000_000), // the ownership anchor's startedAt folds (min)
        last_activity_at: Some(1_793_322_003_000),
        title: Some("Prompt in the fake contract".to_string()),
        title_provider_generated: false,
        summary: Some("Reply from the fake.".to_string()),
        first_user_message: Some("Prompt in the fake contract".to_string()),
        message_count: 3,
        token_usage: Some(usage(100, 50, 25, 150)),
        ..Default::default()
    };
    assert_eq!(meta, expected);
}

#[test]
fn malformed_tail_fixture_parses_the_valid_prefix() {
    let meta = parse_antigravity_session_content(
        &antigravity_fixture("malformed-tail.sanitized.jsonl"),
        "77777777-8888-4999-aaaa-111111111111",
    )
    .expect("the intact prefix still owns the row");
    let expected = ParsedSessionMeta {
        session_id: Some("77777777-8888-4999-aaaa-111111111111".to_string()),
        cwd: None,
        created_at: Some(1_793_325_601_000),
        last_activity_at: Some(1_793_325_602_000),
        title: Some("Survives the corrupt tail".to_string()),
        title_provider_generated: false,
        summary: Some("Valid reply before corruption.".to_string()),
        first_user_message: Some("Survives the corrupt tail".to_string()),
        // 4 non-empty lines: the garbage and truncated lines COUNT
        // (they are real bytes on disk).
        message_count: 4,
        token_usage: Some(usage(3, 4, 0, 7)),
        ..Default::default()
    };
    assert_eq!(meta, expected);
}

#[test]
fn title_derives_from_first_user_input_content_at_200_chars() {
    let long_prompt = "A".repeat(250);
    let content = format!(
        r#"{{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":0,"created_at":"2026-10-29T20:00:01Z","content":"{long_prompt}"}}"#,
    );
    let meta = parse_antigravity_session_content(&content, "t1").expect("parses");
    assert_eq!(meta.first_user_message.as_deref(), Some(long_prompt.as_str()));
    assert_eq!(meta.title.as_deref(), Some("A".repeat(200).as_str()));
    assert!(!meta.title_provider_generated);
}
```

**1b — the new fixtures** (`test/fixtures/coding-cli/antigravity/`, all SYNTHETIC real-shaped — synthetic placeholder content only, never real user content):

`fresh.sanitized.jsonl`:

```jsonl
{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":0,"created_at":"2026-10-29T20:00:01Z","content":"Fix the flaky test"}
{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":1,"created_at":"2026-10-29T20:00:05Z","content":"Fixed the test.","input_tokens":10,"output_tokens":20,"cache_read_tokens":0}
```

`resumed.sanitized.jsonl` (the REAL resumed shape — no second ownership record; a later turn days after):

```jsonl
{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":0,"created_at":"2026-10-29T21:00:01Z","content":"First prompt before exit"}
{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":1,"created_at":"2026-10-29T21:00:05Z","content":"First reply.","input_tokens":15,"output_tokens":25,"cache_read_tokens":0}
{"type":"CHECKPOINT","source":"SYSTEM","status":"DONE","step_index":2,"created_at":"2026-10-29T21:00:06Z","content":"<checkpoint summary placeholder>"}
{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":3,"created_at":"2026-10-31T18:00:01Z","content":"Second prompt after restart"}
{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":4,"created_at":"2026-10-31T18:00:04Z","content":"Second reply.","input_tokens":40,"output_tokens":5,"cache_read_tokens":2}
```

`errored.sanitized.jsonl`:

```jsonl
{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":0,"created_at":"2026-10-29T23:00:01Z","content":"Do the failing thing"}
{"type":"GENERIC","source":"MODEL","status":"ERROR","step_index":1,"created_at":"2026-10-29T23:00:02Z","content":"<step output placeholder>","error":"<permission-check failure placeholder>"}
```

`steps-and-seconds.sanitized.jsonl` (out-of-order step appends, same-second stamps, extra fields, real noise types):

```jsonl
{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":0,"created_at":"2026-10-30T08:09:26Z","content":"Run the suite and report"}
{"type":"GENERIC","source":"MODEL","status":"DONE","step_index":2,"created_at":"2026-10-30T08:09:26Z","content":"<tool step placeholder>","tool_calls":[{"name":"run_command","args":"<placeholder>"}],"media":[]}
{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":3,"created_at":"2026-10-30T08:09:27Z","content":"Tests pass.","thinking":"<thinking placeholder>"}
{"type":"GENERIC","source":"MODEL","status":"DONE","step_index":1,"created_at":"2026-10-30T08:09:26Z","content":"<earlier step appended late placeholder>","truncated_fields":["content"]}
{"type":"SYSTEM_MESSAGE","source":"SYSTEM","status":"DONE","step_index":4,"created_at":"2026-10-30T08:09:28Z","content":"<system notice placeholder>"}
```

`zero-turn.sanitized.jsonl`:

```jsonl
{"type":"SYSTEM_MESSAGE","source":"SYSTEM","status":"DONE","step_index":0,"created_at":"2026-10-30T00:00:00Z","content":"<system notice placeholder>"}
```

`fake-contract.sanitized.jsonl`:

```jsonl
{"type":"session_start","conversationId":"99999999-0000-4111-8222-333333333333","workspacePaths":["/home/u/fake"],"model":"gemini-3-pro","startedAt":"2026-10-30T01:00:00.000Z"}
{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":0,"created_at":"2026-10-30T01:00:01Z","content":"Prompt in the fake contract"}
{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":1,"created_at":"2026-10-30T01:00:03Z","content":"Reply from the fake.","input_tokens":100,"output_tokens":50,"cache_read_tokens":25}
```

`malformed-tail.sanitized.jsonl` (the final line is truncated mid-write — no closing quote or brace):

```jsonl
{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":0,"created_at":"2026-10-30T02:00:01Z","content":"Survives the corrupt tail"}
{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":1,"created_at":"2026-10-30T02:00:02Z","content":"Valid reply before corruption.","input_tokens":3,"output_tokens":4,"cache_read_tokens":0}
totally not json garbage
{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":2,"created_at":"2026-10-30T0
```

**1c — the parser in-file tests** (`crates/freshell-sessions/src/parse/antigravity.rs` `mod tests`, rewritten set):

```rust
#[test]
fn content_with_no_parseable_records_is_excluded() {
    // No recognized record at all (garbage-only, empty, or blank) yields
    // no row — the dir name alone proves nothing parseable happened.
    assert!(parse_antigravity_session_content("not json\n{oops", "c1").is_none());
    assert!(parse_antigravity_session_content("", "c1").is_none());
    assert!(parse_antigravity_session_content("\n \n", "c1").is_none());
}

#[test]
fn second_granularity_created_at_folds_to_ms() {
    // Real binary stamps are RFC3339 with NO fractional part
    // (2026-10-29T20:00:01Z) — the shared coercion must read them.
    let content = concat!(
        r#"{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":0,"created_at":"2026-10-29T20:00:01Z","content":"Prompt"}"#,
        "\n",
        r#"{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":1,"created_at":"2026-10-29T20:00:02Z","content":"Reply."}"#,
    );
    let meta = parse_antigravity_session_content(content, "c2").expect("parses");
    assert_eq!(meta.created_at, Some(1_793_304_001_000));
    assert_eq!(meta.last_activity_at, Some(1_793_304_002_000));
}

#[test]
fn unknown_record_types_are_ignored_but_counted() {
    // A future record type with a NEWER stamp moves nothing.
    let content = concat!(
        r#"{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":0,"created_at":"2026-10-29T20:00:01Z","content":"Prompt"}"#,
        "\n",
        r#"{"type":"FUTURE_RECORD","source":"MODEL","status":"DONE","step_index":9,"created_at":"2026-10-29T20:00:09Z","content":"noise"}"#,
    );
    let meta = parse_antigravity_session_content(content, "c3").expect("parses");
    assert_eq!(meta.last_activity_at, Some(1_793_304_001_000));
    assert_eq!(meta.message_count, 2);
    assert_eq!(meta.summary, None);
}

#[test]
fn system_authored_user_input_folds_the_clock_but_never_a_title() {
    // The title read is source-gated to USER_EXPLICIT (the pane's own
    // prompt); a SYSTEM-authored USER_INPUT is still activity.
    let content = concat!(
        r#"{"type":"USER_INPUT","source":"SYSTEM","status":"DONE","step_index":0,"created_at":"2026-10-29T20:00:01Z","content":"injected prompt"}"#,
    );
    let meta = parse_antigravity_session_content(content, "c4").expect("parses");
    assert_eq!(meta.first_user_message, None);
    assert_eq!(meta.title, None);
    assert_eq!(meta.created_at, Some(1_793_304_001_000));
}

#[test]
fn non_path_workspace_entry_is_rejected_for_cwd() {
    let content = concat!(
        r#"{"type":"session_start","conversationId":"c5","workspacePaths":["https://example.com/x"],"startedAt":"2026-10-29T20:00:00.000Z"}"#,
        "\n",
        r#"{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":0,"created_at":"2026-10-29T20:00:01Z","content":"Prompt"}"#,
    );
    let meta = parse_antigravity_session_content(content, "c5").expect("parses");
    assert_eq!(meta.cwd, None);
}

#[test]
fn missing_token_fields_stay_none() {
    let content = concat!(
        r#"{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":0,"created_at":"2026-10-29T20:00:01Z","content":"Prompt"}"#,
        "\n",
        r#"{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":1,"created_at":"2026-10-29T20:00:02Z","content":"Reply."}"#,
        "\n",
        // Null token fields (the real format's sparse shape) stay unknown.
        r#"{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":2,"created_at":"2026-10-29T20:00:03Z","content":"Reply two.","input_tokens":null,"output_tokens":null,"cache_read_tokens":null}"#,
    );
    let meta = parse_antigravity_session_content(content, "c6").expect("parses");
    assert_eq!(meta.token_usage, None);
}
```

**1d — the tracker dedupe RED tests** (`crates/freshell-activity/src/antigravity.rs` `mod tests`; the `user_message`/`settled` helpers change shape with the record struct, and every existing call site updates mechanically — the existing `completions(&effects)` and `phases(&effects)` assertion helpers stay):

```rust
fn user_input(at: Option<i64>, step: Option<i64>) -> AntigravityTranscriptRecord {
    AntigravityTranscriptRecord {
        kind: AntigravityRecordKind::UserInput,
        at,
        step_index: step,
    }
}

fn settled(
    fully_idle: bool,
    errored: bool,
    at: Option<i64>,
    step: Option<i64>,
) -> AntigravityTranscriptRecord {
    AntigravityTranscriptRecord {
        kind: AntigravityRecordKind::TurnSettled { fully_idle, errored },
        at,
        step_index: step,
    }
}

#[test]
fn same_second_settles_with_distinct_step_indexes_both_complete() {
    // THE binary-evidenced collision pin: real created_at is
    // SECOND-granularity and collides within one second, so two genuine
    // turns CAN settle at the same wall-clock value. The dedupe key is
    // the record identity (created_at, step_index) — step_index is
    // unique per record and strictly increases across turns (binary
    // evidence, real-binary-transcript-evidence.md) — so the second
    // genuine settle rings, where the at-only watermark swallowed it.
    let mut tracker = AntigravityActivityTracker::new();
    tracker.track_terminal("t1", Some("conv"), 0);
    let second = 1_793_304_005_000i64;
    tracker.note_record("t1", &user_input(Some(second), Some(0)), second);
    let first = tracker.note_record("t1", &settled(true, false, Some(second), Some(1)), second + 1);
    assert_eq!(completions(&first), vec![1]);
    // The next turn's user record lands in the SAME second.
    tracker.note_record("t1", &user_input(Some(second), Some(2)), second + 1);
    let second_settle =
        tracker.note_record("t1", &settled(true, false, Some(second), Some(3)), second + 2);
    assert_eq!(
        completions(&second_settle),
        vec![2],
        "a genuine same-second settle with a fresh step_index is NEVER a replay"
    );
}

#[test]
fn byte_faithful_settle_replay_shares_the_identity_and_stays_inert() {
    // The /dup: shape: a byte-faithful duplicate shares BOTH identity
    // components (created_at AND step_index) — still a replay, never a
    // second ring, even while the replay's own Enter armed busy.
    let mut tracker = AntigravityActivityTracker::new();
    tracker.track_terminal("t1", Some("conv"), 0);
    let at = 5_000i64;
    tracker.note_record("t1", &user_input(Some(at), Some(0)), at);
    let first = tracker.note_record("t1", &settled(true, false, Some(at), Some(1)), at);
    assert_eq!(completions(&first), vec![1]);
    tracker.note_record("t1", &user_input(Some(at + 10), Some(2)), at + 10);
    let replay = tracker.note_record("t1", &settled(true, false, Some(at), Some(1)), at + 11);
    assert_eq!(
        completions(&replay),
        Vec::<i64>::new(),
        "the byte-faithful duplicate settle is inert"
    );
    // The next GENUINE settle (new step) still rings.
    let genuine = tracker.note_record("t1", &settled(true, false, Some(at + 10), Some(3)), at + 12);
    assert_eq!(completions(&genuine), vec![2]);
}

#[test]
fn replayed_pre_submit_settle_after_respawn_stays_inert_via_the_baseline_pair() {
    // The attach baseline seeds the (created_at, step_index) pair of the
    // last completing HISTORICAL settle; a byte-faithful re-append of
    // that historical record (equal at AND equal step) never rings —
    // proven while BUSY, so the swallow is the dedupe watermark, not
    // the idle-phase no-op. The next genuine settle still rings.
    let mut tracker = AntigravityActivityTracker::new();
    tracker.track_terminal("t1", Some("conv"), 0);
    let submit_at = 100_000i64;
    let history = vec![
        user_input(Some(10_000), Some(0)),
        settled(true, false, Some(30_000), Some(1)),
    ];
    let _ = tracker.note_attach_baseline("t1", &history, submit_at, Some(submit_at));
    // The respawned pane's user submits again — the turn is live.
    tracker.note_record("t1", &user_input(Some(submit_at + 10), Some(2)), submit_at + 10);
    // A byte-faithful replay of the HISTORICAL settle (same at AND step):
    let replay =
        tracker.note_record("t1", &settled(true, false, Some(30_000), Some(1)), submit_at + 11);
    assert_eq!(completions(&replay), Vec::<i64>::new());
    // The next GENUINE settle (fresh identity) still rings.
    let genuine =
        tracker.note_record("t1", &settled(true, false, Some(120_000), Some(3)), submit_at + 12);
    assert_eq!(completions(&genuine), vec![1]);
}
```

**1e — the locator RED test** (`crates/freshell-sessions/src/antigravity_locator.rs` `mod tests`; call the existing `probe_transcript(&Path) -> Option<TranscriptSummary>` helper at `:715` and reuse the file's `unique_temp_dir` helper — the plant shape is the contract):

```rust
#[test]
fn user_input_content_and_created_at_drive_the_latest_user_match() {
    // Real binary v1.4.12 vocabulary: the latest user record is a
    // USER_INPUT{source:USER_EXPLICIT, content, created_at} — no
    // user_message/text/at record exists (binary evidence). The
    // ownership anchor (session_start) stays the fake-contract cwd/id
    // evidence; the USER-record arm is real vocabulary.
    let dir = unique_temp_dir("user-input-record");
    let conv = "11111111-2222-3333-4444-555555555555";
    let logs = dir.join("brain").join(conv).join(".system_generated").join("logs");
    std::fs::create_dir_all(&logs).unwrap();
    let transcript = logs.join("transcript.jsonl");
    std::fs::write(
        &transcript,
        concat!(
            r#"{"type":"session_start","conversationId":"11111111-2222-3333-4444-555555555555","workspacePaths":["/w"]}"#,
            "\n",
            r#"{"type":"GENERIC","source":"MODEL","status":"DONE","step_index":1,"created_at":"2026-10-29T20:00:02Z","content":"<noise>"}"#,
            "\n",
            r#"{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":2,"created_at":"2026-10-29T20:00:03Z","content":"the real submitted prompt"}"#,
            "\n",
        ),
    )
    .unwrap();
    let summary = probe_transcript(&transcript).expect("the transcript binds");
    assert_eq!(summary.conversation_id, conv);
    assert_eq!(summary.workspace_paths, vec!["/w".to_string()]);
    assert_eq!(summary.latest_user_text, "the real submitted prompt");
    assert_eq!(summary.latest_user_at, Some(1_793_304_003_000));
    let _ = std::fs::remove_dir_all(&dir);
}
```

Also update the existing locator test plants (`:865`, `:1044`, `:1143`, `:1255-1259`) from `{"type":"user_message","conversationId":...,"text":...,"at":...}` to the real-shaped `USER_INPUT` records (`content` + `created_at` + `step_index` + `source`), keeping their `session_start` anchors.

- [ ] **Step 2: Run the tests and verify the intended failure**

The parity tests call the NEW two-argument signature. To keep the red behavioral rather than syntactic, the red commit carries BOTH the new tests AND the minimal signature change (add the `conversation_id: &str` parameter, store it as `meta.session_id`, keep the candidate parse body) AND the minimal call-site updates so the whole library still compiles — every existing caller of `parse_antigravity_session_content` (the `AntigravitySource::parse` call in `crates/freshell-sessions/src/antigravity.rs` and any other in-tree caller, found by grep, not line anchors) passes the directory-derived id or an empty-string placeholder in this same commit. The failure is then the `None` return, not a compile error.

Run: `cargo test -p freshell-sessions --test antigravity_fixture_parity`

Expected: FAIL — every parity test's `expect("real-shaped records parse")` is unmet: the candidate parse body still requires a `session_start` ownership record, which the real-shaped fixtures do not carry, so `parse_antigravity_session_content` returns `None`.

Run: `cargo test -p freshell-activity same_second_settles_with_distinct_step_indexes_both_complete`

Expected: FAIL — the second genuine settle is swallowed (an empty completion list) because the dedupe at `antigravity.rs:886-894` treats `at <= last_completed_at` as a replay.

Run: `cargo test -p freshell-sessions user_input_content_and_created_at_drive_the_latest_user_match`

Expected: FAIL — the locator's latest-user match finds no `user_message` record, so `probe_transcript` returns `None` and the `expect("the transcript binds")` is unmet.

- [ ] **Step 3: Add the minimal production implementation**

**3a — the sessions parser** (`crates/freshell-sessions/src/parse/antigravity.rs`; replace the module doc, `parse_antigravity_token_envelope`, and the parse body; the `Usage`-envelope helper is replaced by the flat-fields helper):

```rust
//! Antigravity CLI (`agy`) conversation transcript `.jsonl` parser.
//!
//! REAL-BINARY record contract (corrected 2026-11-02 against real agy
//! 1.4.12 transcripts; evidence:
//! .worktrees/.the-usual-logs/antigravity-transcript-validation/reports/
//! real-binary-transcript-evidence.md): step-indexed records —
//! USER_INPUT / PLANNER_RESPONSE / GENERIC / SYSTEM_MESSAGE /
//! CHECKPOINT — every record carrying `source`, `status`, `step_index`,
//! and a SECOND-granularity RFC3339 `created_at`. Real records carry NO
//! conversation id and NO workspace evidence: the conversation id IS
//! the `brain/<id>` directory name (passed in by the caller), and `cwd`
//! is `None` for real transcripts (rows group under an unknown project).
//! The e2e/rebind fakes additionally append ONE labeled fake-contract
//! extension this parser tolerates: the `session_start` ownership anchor
//! (cwd evidence for the fake contract — real transcripts carry none).
//!
//! Corruption tolerance (unchanged): a malformed line is skipped, never
//! panicking the process; unknown record types are ignored; and
//! `message_count` counts every non-empty line (including unparseable
//! ones). A transcript with NO recognized record is excluded (`None`) —
//! absence is never silent upstream (`antigravity_parse_failed`).

use serde_json::Value;

use crate::meta::{ParsedSessionMeta, TokenSummary};
use crate::text::{extract_title_from_message, looks_like_path, normalize_first_user_message};
use crate::time::{parse_timestamp_ms, to_finite_number};

/// The title bound for user-derived titles (codex/claude parity).
const ANTIGRAVITY_TITLE_MAX_CHARS: usize = 200;
/// The assistant-summary bound (first PLANNER_RESPONSE content; codex parity).
const ANTIGRAVITY_SUMMARY_MAX_CHARS: usize = 240;

fn finite_i64(v: Option<&Value>) -> Option<i64> {
    v.and_then(to_finite_number).map(|f| f as i64)
}

/// The real format's FLAT token fields (binary v1.4.12): sparse
/// snake_case counts on a subset of PLANNER_RESPONSE records — null on
/// almost all records, and no `totalTokens` key exists (total falls
/// back to input+output). An all-null/all-zero read stays `None`
/// (missing usage is unknown, never a zeroed summary). The LAST
/// token-bearing record wins — the documented reading per the evidence
/// receipts (Provider Contract Record row 75(b)).
fn parse_antigravity_token_fields(obj: &Value) -> Option<TokenSummary> {
    let input = finite_i64(obj.get("input_tokens")).unwrap_or(0);
    let output = finite_i64(obj.get("output_tokens")).unwrap_or(0);
    let cached = finite_i64(obj.get("cache_read_tokens")).unwrap_or(0);
    let total = input + output;
    if input == 0 && output == 0 && cached == 0 {
        return None;
    }
    Some(TokenSummary {
        input_tokens: input,
        output_tokens: output,
        cached_tokens: cached,
        total_tokens: total,
        context_tokens: None,
        model_context_window: None,
        compact_threshold_tokens: None,
        compact_percent: None,
    })
}

/// Fold one recognized record's `created_at` into the meta clock:
/// `created_at` = min, `last_activity_at` = max (codex semantic-fold
/// model). The real vocabulary is closed (all five types carry real
/// stamps), so every recognized record folds.
fn fold_ts(meta: &mut ParsedSessionMeta, value: Option<&Value>) {
    if let Some(at) = value.and_then(parse_timestamp_ms) {
        meta.created_at = Some(meta.created_at.map_or(at, |c| c.min(at)));
        meta.last_activity_at = Some(meta.last_activity_at.map_or(at, |l| l.max(at)));
    }
}

/// Parse one antigravity conversation transcript into
/// [`ParsedSessionMeta`], or `None` when no recognized record parses —
/// an empty/garbage-only file is an excluded row (it proves nothing
/// happened; the directory alone carries no message evidence).
///
/// `conversation_id` is the `brain/<id>` directory name (real records
/// carry no id — binary v1.4.12); it is authoritative and never
/// reassigned by record content.
pub fn parse_antigravity_session_content(
    content: &str,
    conversation_id: &str,
) -> Option<ParsedSessionMeta> {
    let mut meta = ParsedSessionMeta::default();
    meta.session_id = Some(conversation_id.to_string());
    let mut have_cwd = false;
    let mut first_user: Option<String> = None;
    let mut summary: Option<String> = None;
    let mut count = 0i64;
    let mut parsed_semantic = 0i64;

    for line in content.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            continue;
        }
        count += 1;
        let Ok(obj) = serde_json::from_str::<Value>(line) else {
            continue; // malformed ⇒ skip (a truncated mid-write tail lands here)
        };
        let Some(record_type) = obj.get("type").and_then(Value::as_str) else {
            continue;
        };
        match record_type {
            // Fake-contract extension (the e2e/rebind fakes' ownership
            // anchor): cwd evidence only — its conversationId never
            // reassigns the directory id, and real transcripts carry no
            // such record (binary evidence).
            "session_start" => {
                parsed_semantic += 1;
                if !have_cwd {
                    if let Some(paths) = obj.get("workspacePaths").and_then(Value::as_array) {
                        if let Some(primary) = paths.iter().find_map(|p| p.as_str()) {
                            if looks_like_path(primary) {
                                meta.cwd = Some(primary.to_string());
                                have_cwd = true;
                            }
                        }
                    }
                }
                fold_ts(&mut meta, obj.get("startedAt"));
            }
            "USER_INPUT" => {
                parsed_semantic += 1;
                if first_user.is_none()
                    && obj.get("source").and_then(Value::as_str) == Some("USER_EXPLICIT")
                {
                    if let Some(text) = obj.get("content").and_then(Value::as_str) {
                        first_user = normalize_first_user_message(text);
                    }
                }
                fold_ts(&mut meta, obj.get("created_at"));
            }
            "PLANNER_RESPONSE" => {
                parsed_semantic += 1;
                if summary.is_none() {
                    if let Some(text) = obj.get("content").and_then(Value::as_str) {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            summary = Some(
                                trimmed
                                    .chars()
                                    .take(ANTIGRAVITY_SUMMARY_MAX_CHARS)
                                    .collect(),
                            );
                        }
                    }
                }
                fold_ts(&mut meta, obj.get("created_at"));
                meta.token_usage = parse_antigravity_token_fields(&obj).or(meta.token_usage.take());
            }
            "GENERIC" | "SYSTEM_MESSAGE" | "CHECKPOINT" => {
                parsed_semantic += 1;
                fold_ts(&mut meta, obj.get("created_at"));
            }
            _ => {} // unknown record types are ignored (forward-compat)
        }
    }

    if parsed_semantic == 0 {
        return None; // nothing recognized ⇒ excluded row
    }
    meta.message_count = count;
    meta.first_user_message = first_user;
    if let Some(f) = &meta.first_user_message {
        meta.title = Some(extract_title_from_message(f, ANTIGRAVITY_TITLE_MAX_CHARS));
        meta.title_provider_generated = false;
    }
    meta.summary = summary;
    Some(meta)
}
```

**3b — the path helper** (`crates/freshell-sessions/src/provider_layout.rs`, on `AntigravityLayout`; also update the `:280-285` Stage-1 candidate note to record the transcript path as real-binary-validated 2026-11-02 and the record schema as the corrected contract):

```rust
    /// The conversation id from a canonical transcript path — the
    /// `brain/<conversationId>/.system_generated/logs/transcript.jsonl`
    /// directory component. Real records carry NO id field (binary
    /// v1.4.12): the directory name IS the conversation identity.
    pub fn conversation_id_from_path(path: &std::path::Path) -> Option<String> {
        let mut components = path.components().rev();
        // Reversed walk of brain/<conversationId>/.system_generated/logs/transcript.jsonl:
        // consume the file name first, then each directory component in reverse order.
        if components.next()?.as_os_str().to_str()? != "transcript.jsonl" {
            return None;
        }
        for expected in ["logs", ".system_generated"] {
            if components.next()?.as_os_str().to_str()? != expected {
                return None;
            }
        }
        let id = components.next()?.as_os_str().to_str()?;
        if components.next()?.as_os_str().to_str()? != "brain" {
            return None;
        }
        if id.is_empty() {
            return None;
        }
        Some(id.to_string())
    }
```

**3c — the source** (`crates/freshell-sessions/src/antigravity.rs:70-99`; the cwd gate is REMOVED — real transcripts carry no workspace evidence, and gating on it excluded every real conversation; update the module doc's exclusion list and both `parse_failed` reasons):

```rust
    fn parse(&self, path: &Path) -> Option<IndexedSession> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(err) => {
                parse_failed(path, format!("read failed: {err}"));
                return None;
            }
        };
        let content = String::from_utf8_lossy(&bytes).into_owned();
        let Some(conversation_id) = AntigravityLayout::conversation_id_from_path(path) else {
            parse_failed(
                path,
                "transcript path does not carry a brain/<id> conversation directory",
            );
            return None;
        };
        let meta = match parse_antigravity_session_content(&content, &conversation_id) {
            Some(meta) => meta,
            None => {
                parse_failed(path, "no parseable records (real binary vocabulary)");
                return None;
            }
        };
        // No cwd gate: the real record schema carries no workspace
        // evidence (binary v1.4.12), so real conversations index with
        // cwd None (project "unknown"); the fake contract's ownership
        // anchor supplies cwd for fake-driven tests when present.
        Some(indexed_from_meta(&meta, path))
    }
```

Update the source's in-file tests: the planted-store tests (`:643` area) plant real-shaped transcripts under `brain/<id>/.system_generated/logs/transcript.jsonl` and assert rows keyed by the DIRECTORY id; the orphan-message test (`:707`) becomes the no-parseable-records exclusion pin (`parse_failed` with the new reason, still asserted via the child-process event capture); the empty test (`:823`) stays; the cwd-gate tests are REMOVED (the gate is gone) and replaced by a pin that a real-shaped transcript with no ownership record indexes with `cwd: None` and `project_path: "unknown"`.

**3d — search** (`crates/freshell-sessions/src/search.rs:232-246`):

```rust
/// The antigravity transcript's message records (real binary v1.4.12
/// contract): `type=="USER_INPUT"` (source USER_EXPLICIT) and
/// `type=="PLANNER_RESPONSE"`, each carrying its text in the top-level
/// `content` field. GENERIC/SYSTEM_MESSAGE/CHECKPOINT records are step
/// or system noise, not searchable messages.
fn extract_antigravity_message(obj: &Value) -> Option<(&'static str, String)> {
    let role: &'static str = match obj.get("type").and_then(Value::as_str)? {
        "USER_INPUT" => "user",
        "PLANNER_RESPONSE" => "assistant",
        _ => return None,
    };
    let text = obj.get("content").and_then(Value::as_str)?;
    Some((role, text.trim().to_string()))
}
```

Update the antigravity search tests (`:338-465`) to real-shaped `USER_INPUT`/`PLANNER_RESPONSE` records with `content` fields (same assertion intents: role tiers, case-insensitive `userMessages` matching, assistant-only scoping).

**3e — the activity classifier/tailer** (`crates/freshell-activity/src/antigravity.rs`): rename `AntigravityRecordKind::UserMessage` → `UserInput`, classifying `{"type":"USER_INPUT"}` with `source == "USER_EXPLICIT"` (absent source ⇒ not classified — conservative); keep the `TurnSettled` arm for `{"type":"turn_settled"}` unchanged in shape, documented as the labeled fake-contract settle record (real transcripts carry NO settle record — binary evidence; the deadman/exit/submit-grace paths keep real panes honest); widen `AntigravityTranscriptRecord` with `step_index: Option<i64>`; read `at` from `created_at` in the tailer loop (`value.get("created_at").and_then(record_at_ms)` — keep `record_at_ms`'s numeric+ISO coercion, documented: ISO `created_at` is the real shape); set `LIFECYCLE_TYPE_PREFIXES = ["USER_INPUT", "turn_settled"]`; update the module header (`:1-98`) to the corrected contract with the binary facts and the labeled fake-contract extensions.

```rust
pub fn parse_transcript_record(value: &serde_json::Value) -> Option<AntigravityRecordKind> {
    let kind = value.get("type")?.as_str()?;
    match kind {
        "USER_INPUT"
            if value.get("source").and_then(serde_json::Value::as_str)
                == Some("USER_EXPLICIT") =>
        {
            Some(AntigravityRecordKind::UserInput)
        }
        "turn_settled" => Some(AntigravityRecordKind::TurnSettled {
            fully_idle: value
                .get("fullyIdle")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            errored: value
                .get("outcome")
                .and_then(serde_json::Value::as_str)
                .map(|outcome| outcome == "errored")
                .unwrap_or(false),
        }),
        _ => None,
    }
}
```

**3f — the dedupe re-keying** (the same file): add the identity type and replace the watermark fields/comparison:

```rust
/// The identity of one settling record: (created_at_ms, step_index) —
/// a per-record pair two GENUINE turns can never share (binary v1.4.12
/// evidence: step_index is unique per record and strictly increases
/// across turns, while created_at is SECOND-granularity and collides
/// routinely within one second — an at-only watermark swallows a
/// genuine same-second settle as a replay). A byte-faithful re-append
/// shares BOTH components. Records without a step_index (none exist in
/// the corrected contract) compare through the MIN stand-in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SettleIdentity {
    pub at: i64,
    pub step_index: Option<i64>,
}

impl SettleIdentity {
    fn order_key(self) -> (i64, i64) {
        (self.at, self.step_index.unwrap_or(i64::MIN))
    }
    /// `self` is the same (replayed) record as `watermark`, or older.
    fn is_replay_of(self, watermark: SettleIdentity) -> bool {
        self.order_key() <= watermark.order_key()
    }
}
```

In `TerminalActivity`: rename `attach_baseline_completed_at: Option<i64>` to `attach_baseline_settle: Option<SettleIdentity>` and add `last_completed_settle: Option<SettleIdentity>` (set when a settle rings). In `note_attach_baseline`'s history fold, replace the `baseline_completed_at` max with the pair max:

```rust
                    if fully_idle || errored {
                        in_flight = false;
                        let id = SettleIdentity { at, step_index: record.step_index };
                        baseline_settle = Some(baseline_settle.map_or(id, |prev: SettleIdentity| {
                            if id.order_key() > prev.order_key() { id } else { prev }
                        }));
                    }
```

seed `state.attach_baseline_settle = baseline_settle;`, and in `note_record`'s `TurnSettled` arm replace the `:886-894` block:

```rust
                // Per-settle dedupe, keyed on the record identity
                // (created_at, step_index): a record whose identity is
                // at/before ANY known watermark (the last settle this
                // track consumed, the attach-baseline seed, or the
                // ledger's at-only defense-in-depth) is a REPLAY of an
                // already-consumed settle — inert in every phase. Two
                // genuine turns can never share an identity (step_index
                // is unique per record — binary evidence), so a genuine
                // same-second settle with a fresh step RINGS where the
                // old at-only rule swallowed it.
                let record_id = SettleIdentity { at, step_index: record.step_index };
                let watermarks = [
                    state.last_completed_settle,
                    state.attach_baseline_settle,
                    self.ledger
                        .last_completion_at(terminal_id)
                        .map(|at| SettleIdentity { at, step_index: None }),
                ];
                if watermarks
                    .iter()
                    .flatten()
                    .any(|w| record_id.is_replay_of(*w))
                {
                    return Vec::new();
                }
```

and after `record_turn_completion` at the ring site set `state.last_completed_settle = Some(record_id);`. The ledger stays unchanged: its at-watermark folds in as the `(at, None)` branch — a genuine stepped equal-at settle compares greater than it and rings; a stepless legacy replay against it stays swallowed (documented residual; no stepless settle records exist in the corrected contract).

**3g — the locator's user-record arm** (`crates/freshell-sessions/src/antigravity_locator.rs:755-830`): the tail-window reader takes `at` from `created_at` (falling back to the ownership anchor's `startedAt` for `session_start` records), and the latest-user match reads the real vocabulary:

```rust
        let at = obj
            .get("created_at")
            .or_else(|| obj.get("startedAt"))
            .and_then(parse_timestamp_ms);
        // ... the session_start workspacePaths collection arm is unchanged ...
        if obj.get("type").and_then(|v| v.as_str()) == Some("USER_INPUT") {
            if let Some(text) = obj.get("content").and_then(serde_json::Value::as_str) {
                // Text and its OWN timestamp move together (unchanged
                // rule): recency is proven by the matching record.
                latest_user_text = Some(normalize_prompt_text(text));
                latest_user_at = at;
            }
        }
```

Update the module docs: `:15-29` (the evidence rule names the real `USER_INPUT` records), `:31-54` (the tolerance note records the binary-evidenced SECOND granularity — the 5 s tolerance is correctly sized, no longer an unknown), `:71-79` (the candidate header names the ownership anchor as the labeled fake-contract extension: real transcripts carry no ownership/workspace evidence, so binding does not engage on real-format sessions — recorded limitation).

**3h — the test doubles**:

- `crates/freshell-ws/tests/antigravity_session_rebind.rs` — in `write_fake_agy`, every transcript record write switches to the corrected shapes: the `session_start` ownership anchor stays; the per-prompt user record becomes `{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":<n>,"created_at":"$(now)","content":"<prompt>"}`; any settle write becomes `{"type":"turn_settled","step_index":<n>,"created_at":"$(now)","outcome":"completed","fullyIdle":true}` (the labeled fake-contract settle, real-shaped field discipline); keep the sh `now()` ms-ISO form (synthetic precision for the recency boundary tests — the coercion accepts fractional; the real binary writes seconds). `plant_transcript(:459-487)` becomes:

```rust
    let body = format!(
        concat!(
            r#"{{"type":"session_start","conversationId":"{conv}","workspacePaths":["{cwd}"],"startedAt":{at}}}"#,
            "\n",
            r#"{{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":0,"created_at":{at},"content":"{text}"}}"#,
            "\n",
        ),
        conv = conv,
        cwd = cwd,
        text = text,
        at = at_ms,
    );
```

(numeric epoch-ms `created_at` — the shared coercion's documented second form).

- `crates/freshell-ws/src/antigravity_association.rs:1852-1859` and every antigravity test plant in `crates/freshell-ws/src/activity.rs`'s `mod tests` (grep `"user_message"` and `"turn_settled"` within the file): switch user records to real-shaped `USER_INPUT` (with `content` + `created_at` + `step_index` + `source`) and settle records to `turn_settled` with `created_at` + `step_index`, keeping the `session_start` anchors.
- `test/e2e-browser/fixtures/fake-agy-terminal.mjs` — add a per-conversation step counter to the fake's state (incremented per appended record; reset per conversation mint) and correct the writers:

```js
function appendUserMessage(line) {
  appendRecord(state.conversationId, {
    type: 'USER_INPUT',
    source: 'USER_EXPLICIT',
    status: 'DONE',
    step_index: nextStepIndex(),
    created_at: now(),
    content: line,
  })
}

function appendAssistantMessage(text) {
  appendRecord(state.conversationId, {
    type: 'PLANNER_RESPONSE',
    source: 'MODEL',
    status: 'DONE',
    step_index: nextStepIndex(),
    created_at: now(),
    content: text,
    input_tokens: 1,
    output_tokens: 1,
    cache_read_tokens: 0,
  })
}

function appendTurnSettled(fullyIdle) {
  // The fake-contract settle record: the real binary writes NO settle
  // record (binary evidence, real-binary-transcript-evidence.md); the
  // fake appends this extension so the attention machinery has a
  // settle signal — real-shaped field discipline (created_at +
  // step_index) so the tracker's identity-pair dedupe is exercised.
  appendRecord(state.conversationId, {
    type: 'turn_settled',
    step_index: nextStepIndex(),
    created_at: now(),
    outcome: fullyIdle ? 'completed' : 'async-outstanding',
    fullyIdle,
  })
}
```

The `/dup:` verb stays a byte-faithful copy of the last `turn_settled` record (same `created_at` AND `step_index` — update its doc comment to name both identity components). The `/remember:` recovery reader (`:279`) matches `obj?.type !== 'USER_INPUT'` and reads `obj?.content`. The `session_start` ownership write stays (the locator's labeled fake-contract anchor) with an updated comment. Update the header comment block (`:13-18`) to the corrected contract with the evidence pointer.
- `test/e2e-browser/specs/google-cli-identity-activity-rust.spec.ts:1068-1076` (the stale-write plant) and `:1118-1130` (the existing-conversation plant): switch the planted user records to the real-shaped `USER_INPUT` form (`content`/`created_at`/`step_index`/`source`), keeping the `session_start` anchors.
- `test/e2e-browser/specs/google-cli-history-resume-rust.spec.ts:40-48` (the premise) and `:652-668` (the assertion): the structural record-type string becomes `USER_INPUT` (present in every raw transcript line as `"type":"USER_INPUT"`, present in no user-authored text) — `runSearch('USER_INPUT', 'userMessages')` must return nothing; keep the case-insensitive nonce assertions unchanged.

- [ ] **Step 4: Run the focused tests**

```bash
cargo test -p freshell-sessions
cargo test -p freshell-activity
```

Expected: PASS (the new parity/parser/locator/dedupe tests and every updated in-file test).

- [ ] **Step 5: Refactor while green**

Consolidate the fixture-record literals behind the existing test helpers where the files already have them (the tracker's `user_input`/`settled`, the locator's plant formatters); re-check that every corrected seam comment names the evidence report path once and cites the binary version; no behavioral change.

- [ ] **Step 6: Run impacted-test verification**

This change spans every consumer of the antigravity record vocabulary — the impacted set is all antigravity lanes across the Rust workspace, the google-cli e2e trio, and the client resume-command unit pin:

```bash
cargo test -p freshell-protocol && cargo test -p freshell-server antigravity
cargo test -p freshell-ws --lib antigravity
cargo test -p freshell-ws --test antigravity_launch_e2e
scripts/sandbox-test.sh "cargo test -p freshell-ws --test antigravity_session_rebind"
pnpm run test:vitest run test/unit/client/lib/coding-cli-utils.test.ts --config config/vitest/vitest.config.ts
pnpm run typecheck
pnpm exec playwright test --config test/e2e-browser/playwright.config.ts --project=chromium \
  test/e2e-browser/specs/google-cli-launch-rust.spec.ts \
  test/e2e-browser/specs/google-cli-history-resume-rust.spec.ts \
  test/e2e-browser/specs/google-cli-identity-activity-rust.spec.ts
```

Expected: PASS for every lane (the e2e trio on the local chromium project; the repo-level cloud-backend constraint applies at PR time — confirm none of the trio sits in `CLOUD_SKIP_SPECS`).

- [ ] **Step 7: Commit the task**

```bash
git add test/fixtures/coding-cli/antigravity crates/freshell-sessions crates/freshell-activity \
  crates/freshell-protocol/src/common.rs crates/freshell-ws/src/antigravity_association.rs \
  crates/freshell-ws/src/activity.rs crates/freshell-ws/tests/antigravity_session_rebind.rs \
  crates/freshell-server/tests test/e2e-browser/fixtures/fake-agy-terminal.mjs \
  test/e2e-browser/specs/google-cli-identity-activity-rust.spec.ts \
  test/e2e-browser/specs/google-cli-history-resume-rust.spec.ts
git commit -m "fix(antigravity): correct transcript record schema to the real binary contract"
```

(Step 7 list amended post-execution: the `crates/freshell-server/tests` fixture-consumer files were required by Step 6's server-antigravity lane under the atomicity note — the task-review recorded the original list's omission as a plan defect, resolved by the implementer's declared deviation and this amendment.)

---

### Task 3: Activate the conversation-resume gate (VALIDATED_PROVIDERS) and rewrite every deferral pin

Run only after Task 1's evidence exists and Task 2's corrections are green (GC13). If Task 1 recorded the cannot-authenticate blocker, SKIP this task and record why.

**Files:**
- Modify: `crates/freshell-platform/src/resume_gate.rs:19` (the constant), in-file tests `:135-255`
- Modify: `crates/freshell-ws/src/resume_validation.rs:295-330` (the A2 deferral pin test + comment; new gated unit tests)
- Modify: `crates/freshell-ws/tests/resume_validation_gate.rs:1079-1098` (section banner), `:1297-1392` (brain-on-disk scenario), `:1407-1509` (absent-id scenario); reuse the harness helpers at `:427`, `:447`, `:464` and the refusal precedent at `:504-530`
- Modify: `crates/freshell-server/src/existence.rs:499-520` (the `exists_for_gate` gate variant) + its tests module: the PRODUCTION probe must validate an antigravity `Present` against the on-disk by-id locator before the gate trusts it — a warm-index hit for a conversation whose transcript was deleted must NOT pass the gate (the CLI's documented missing-ID behavior silently starts a fresh conversation, violating GC3's no-silent-replacement rule)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs:6686-6712` (the door-3 deferral pin)
- Modify: `crates/freshell-server/src/antigravity_existence_by_id.rs:17-22` (the gate-deferral doc comment → activated, evidence-cited)
- Modify: `crates/freshell-agent-runtime/src/lib.rs:588-592` (the capability row's `(candidate)` annotations; update the row-pinning test at `lib.rs:4589-4651` only if it asserts those exact strings)
- Modify: `README.md:275-279` (candidate-contract limitation → validated-schema outcome), `:289-295` (busy/completion claims scoped to the fake contract — see Step 3g), `:296-303` (resume-gate limitation → gated behavior)
- Modify: `docs/plans/2026-10-29-google-cli-first-class-support.md:76` (row 76: activation flip) and the Known limitations items that mirror it (`:925`, `:930`)
- Modify: `test/e2e-browser/specs/google-cli-history-resume-rust.spec.ts:860-1000` (scenario 8: the dead-session direct-resume contract)

**Interfaces:**
- Consumes: `evaluate_resume_gate`/`provider_validated` (`freshell-platform::resume_gate`), `validate_wire_resume`/`validate_rest_resume`, the `SessionExistenceProbe` trait, `TerminalLaunchFailureCard`'s typed SESSION_MISSING surface (`src/components/TerminalLaunchFailureCard.tsx:27,100`).
- Produces: `VALIDATED_PROVIDERS: [&str; 5]` including `"antigravity"`; the gated user-create contract for antigravity (Present/Unknown → proceed with the exact id; Absent → the typed SESSION_MISSING refusal: `resume_session_id: None` + `stale_session_id` + notice, no fresh-id minting — the `_` SpawnFresh arm at `resume_validation.rs:130-146` already produces this shape); managed recovery stays fail-closed. No other signatures change.

- [ ] **Step 1: Write the failing behavioral test — the deliberately-red pins**

The flip itself turns the existing deferral pins red BY DESIGN (each documents that activation must be an evidenced decision). Change `crates/freshell-platform/src/resume_gate.rs:19`:

```rust
pub const VALIDATED_PROVIDERS: [&str; 5] = ["claude", "codex", "opencode", "amplifier", "antigravity"];
```

Then add the NEW post-activation pins (they pass once the constant lands — they document the gated contract every rewrite must converge to):

In `resume_gate.rs` in-file tests:

```rust
    #[test]
    fn antigravity_absent_spawns_fresh_and_present_proceeds() {
        // Activated 2026-11-02 on real-binary transcript evidence + a
        // proven real resume (Provider Contract Record rows 74/75/76;
        // evidence: real-binary-transcript-evidence.md).
        assert_eq!(evaluate_resume_gate("antigravity", Absent, true), SpawnFresh);
        assert_eq!(evaluate_resume_gate("antigravity", Absent, false), SpawnFresh);
        assert_eq!(evaluate_resume_gate("antigravity", Present, false), Proceed);
        assert_eq!(evaluate_resume_gate("antigravity", Unknown, false), Proceed);
    }
```

In `resume_validation.rs` tests:

```rust
    #[test]
    fn antigravity_absent_refuses_with_notice_and_never_mints_a_fresh_id() {
        let out = validate_wire_resume(
            "antigravity",
            Some("stale-agy".into()),
            LaunchIntent::Resume,
            &absent(),
        );
        // The `_` SpawnFresh arm: no fresh id minted (unlike
        // claude/amplifier), the stale id is named, and the notice rides
        // for the consumer's typed SESSION_MISSING refusal.
        assert_eq!(out.resume_session_id, None);
        assert_eq!(out.launch_intent, LaunchIntent::Resume);
        assert!(!out.claude_fresh_prealloc);
        assert_eq!(out.stale_session_id.as_deref(), Some("stale-agy"));
        let notice = out.notice.expect("notice set");
        assert!(notice.contains("stale-agy"));
        assert!(notice.contains("could not be found"));
    }
```

And in `crates/freshell-server/src/existence.rs`'s tests module — the PRODUCTION-probe red (a warm-index hit must NOT answer Present for a conversation whose transcript is gone; today it does, so the gate would pass a deleted id through to `agy`, which silently starts a fresh conversation — GC3 violation):

```rust
    #[test]
    fn antigravity_warm_index_present_is_disk_validated_by_the_gate_variant() {
        // Gate variant (exists_for_gate) must validate an antigravity
        // Present against the on-disk by-id locator: a stale warm-index
        // entry (transcript deleted, index not yet rescanned) is corrected
        // to Absent BEFORE the gate trusts it. Activated with the resume
        // gate 2026-11-02 — GC3's no-silent-replacement rule.
        let home = temp_antigravity_home("gate_present_validation");
        let id = seed_antigravity_conversation(&home, "gate-present");
        let index = warm_index_with(vec![indexed_antigravity_session(&id)]);
        let probe = IndexExistenceProbe::new(index).with_antigravity_transcript_locator(
            antigravity_transcript_locator(home.clone()),
        );
        std::fs::remove_file(conversation_transcript_path(&home, &id).unwrap()).unwrap();
        assert_eq!(
            probe.exists_for_gate("antigravity", &id),
            SessionExistence::Absent
        );
    }

    #[test]
    fn antigravity_warm_index_present_with_disk_present_stays_present() {
        let home = temp_antigravity_home("gate_present_kept");
        let id = seed_antigravity_conversation(&home, "gate-present-kept");
        let index = warm_index_with(vec![indexed_antigravity_session(&id)]);
        let probe = IndexExistenceProbe::new(index).with_antigravity_transcript_locator(
            antigravity_transcript_locator(home.clone()),
        );
        assert_eq!(
            probe.exists_for_gate("antigravity", &id),
            SessionExistence::Present
        );
    }

    #[test]
    fn antigravity_cold_index_absent_id_is_disk_refused_not_unknown_proceed() {
        // The cold window (every startup, before the index warms) must not
        // pass a stale id through as Unknown → Proceed: the gate variant
        // validates cold Unknowns against the disk too. Absent on disk ⇒
        // the typed refusal, not a silent fresh conversation.
        let home = temp_antigravity_home("gate_cold_absent");
        let id = seed_antigravity_conversation(&home, "gate-cold");
        let probe = IndexExistenceProbe::new(None).with_antigravity_transcript_locator(
            antigravity_transcript_locator(home.clone()),
        );
        std::fs::remove_file(conversation_transcript_path(&home, &id).unwrap()).unwrap();
        assert_eq!(
            probe.exists_for_gate("antigravity", &id),
            SessionExistence::Absent
        );
    }

    #[test]
    fn antigravity_cold_index_present_id_resumes() {
        let home = temp_antigravity_home("gate_cold_present");
        let id = seed_antigravity_conversation(&home, "gate-cold-kept");
        let probe = IndexExistenceProbe::new(None).with_antigravity_transcript_locator(
            antigravity_transcript_locator(home.clone()),
        );
        assert_eq!(
            probe.exists_for_gate("antigravity", &id),
            SessionExistence::Present
        );
    }
```

Build the seeding helpers next to the existing `temp_*` helpers in that tests module (a temp antigravity home + one `brain/<id>/.system_generated/logs/transcript.jsonl` file + one warm-index item whose provider is `antigravity`), following the module's existing fixture style.

- [ ] **Step 2: Run the tests and verify the intended failure**

```bash
cargo test -p freshell-platform resume_gate
cargo test -p freshell-ws --lib unvalidated_providers_and_empty_ids_never_consult_probe
cargo test -p freshell-ws --test resume_validation_gate antigravity
cargo test -p freshell-freshagent antigravity_is_a_session_provider_mode
cargo test -p freshell-server antigravity
```

Expected: the two NEW `antigravity_absent_*` unit tests PASS immediately (the constant flip is their entire subject). The DESIGNED reds are the three deferral pins plus the two production-probe reds, and each fails exactly as its own comment promised: `unvalidated_providers_and_empty_ids_never_consult_probe` FAILS (the `PanickingProbe` consult panics on the antigravity row); the two `resume_validation_gate` antigravity scenarios FAIL (the `AbsentButObservedProbe` now gates: the brain-on-disk create answers the typed refusal instead of `terminal.created`, and the absent-id pane no longer spawns); the `terminal_tabs` door-3 pin FAILS (the stale id no longer passes through: `resume_session_id` is `None`, not `"stale-agy"`); `antigravity_warm_index_present_is_disk_validated_by_the_gate_variant` FAILS (the warm-index hit answers `Present` for the deleted transcript) and `antigravity_cold_index_absent_id_is_disk_refused_not_unknown_proceed` FAILS (the cold window answers `Unknown` for the deleted transcript, which the gate passes through) — the two GC3 holes. Record these reds — they are the activation being deliberate.

- [ ] **Step 3: Rewrite every pin to the post-activation contract**

**3a — `resume_validation.rs:295-330`:** remove `"antigravity"` from the unvalidated mode row (keep `gemini`, `kimi`, `shell`, `third-party`), and replace the deferral comment with the activation record: antigravity IS validated (real-binary transcript evidence + proven real resume, 2026-11-02; evidence report path); the probe IS consulted; a stale id answers the typed refusal at the spawn doors. Add the Step-1 unit test.

**3a′ — the production probe's gate variant** (`crates/freshell-server/src/existence.rs`, `exists_for_gate` at `:499-520`): for antigravity, validate BOTH a warm-index `Present` AND a cold/other `Unknown` against the on-disk by-id locator BEFORE the gate trusts them — the warm hit can be stale for a conversation deleted from disk, and the cold window (every startup, before the index warms) would otherwise pass any id through on `Unknown → Proceed` (the production wiring already hands the probe the locator via `with_antigravity_transcript_locator`, `main.rs:2204`). Append after `let base = self.exists(provider, session_id);`:

```rust
        // Antigravity gate validation (activated 2026-11-02): neither a
        // warm-index hit nor a cold-index Unknown is sufficient evidence
        // for the resume gate — the index can be stale for a conversation
        // deleted from disk, and the cold window precedes every warm-up,
        // while the CLI's documented missing-ID behavior silently starts
        // a FRESH conversation (GC3 violation). Validate both against the
        // same on-disk by-id walk the Absent arm uses: disk Present
        // confirms (and feeds the observed set — module-doc invariant),
        // disk Absent corrects to Absent (typed refusal), disk Unreadable
        // defers as Unknown (G28 fail-open). Absent itself needs no
        // re-check — the warm-Absent arm at :444 already disk-verified it.
        if provider == "antigravity" {
            if let Some(locator) = &self.antigravity_transcript_locator {
                match base {
                    SessionExistence::Present | SessionExistence::Unknown => {
                        return match locator(session_id) {
                            ByIdAnswer::Present => {
                                self.observed
                                    .lock()
                                    .expect("observed set lock")
                                    .insert(format!("{provider}:{session_id}"));
                                SessionExistence::Present
                            }
                            ByIdAnswer::Absent => SessionExistence::Absent,
                            ByIdAnswer::Unreadable => SessionExistence::Unknown,
                        };
                    }
                    _ => {}
                }
            }
        }
```

This runs inside the gate variant only (gate callers already run it under `spawn_blocking` per the A13 note), and `exists()` — the inline reconcile path with its ~250ms IO discipline — is untouched. The one `File::open` is far cheaper than the codex by-id walk the same variant already tolerates.

**3b — `resume_validation_gate.rs`:** replace the section banner (`:1079-1098`) with the activation record. Add a disk-wired probe so the gate consults the same evidence production uses (the harness cannot depend on `freshell-server`; this mirrors the by-id walk's shape):

```rust
/// A gate probe wired to the harness's seeded brain tree — the
/// production by-id walk's shape: exists+readable ⇒ Present, missing ⇒
/// Absent, anything else ⇒ Unknown. Counts consultations so the tests
/// can prove the gate is ACTIVE (the probe is consulted), not
/// passthrough.
struct DiskWiredAntigravityProbe {
    brain_root: std::path::PathBuf,
    consulted: std::sync::atomic::AtomicUsize,
}
impl DiskWiredAntigravityProbe {
    fn over(base: &std::path::Path) -> Self {
        Self {
            brain_root: base.join("brain"),
            consulted: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}
impl SessionExistenceProbe for DiskWiredAntigravityProbe {
    // Mirror AbsentButObservedProbe's method set at :68-88 exactly.
    fn exists(&self, _provider: &str, session_id: &str) -> SessionExistence {
        self.consulted
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let path = self
            .brain_root
            .join(session_id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        match std::fs::File::open(&path) {
            Ok(_) => SessionExistence::Present,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => SessionExistence::Absent,
            Err(_) => SessionExistence::Unknown,
        }
    }
    fn ever_observed(&self, _: &str, _: &str) -> bool {
        true
    }
    fn ever_observed_on_disk(&self, _: &str, _: &str) -> bool {
        true
    }
}
```

Rewrite `antigravity_restore_with_brain_on_disk_resumes_ungated_never_substituted` (`:1297`) as the GATED pin — spawn with `DiskWiredAntigravityProbe::over(&base)`, keep every existing assertion (terminal.created with the exact id, no notice, the adjacent `--conversation <conv>` argv row, the fake's resumed marker, no second spawn, the Bound row survives), and ADD the consulted-count assertion (`consulted.load(...) >= 1` — the gate is active). Rename it `antigravity_restore_with_brain_on_disk_resumes_through_the_active_gate`.

Rewrite `antigravity_restore_with_absent_id_warns_in_pane_stays_alive_never_replaces` (`:1407`) as the refusal pin, mirroring `restore_true_amplifier_absent_answers_the_typed_missing_refusal` (`:504-530`) — spawn with `DiskWiredAntigravityProbe::over(&base)` (no seeded id ⇒ Absent):

```rust
/// The gated honest failure mode: a stale id with positive absence is
/// REFUSED before the CLI ever sees it — the typed SESSION_MISSING
/// error naming the stale id, the stale-resume notice, ZERO spawns (the
/// fake never runs — the capture file stays empty), and the ledger row
/// retired as SessionMissing. The pre-activation contract (the CLI's
/// own warning surfacing in a live pane) is gone by design: the gate
/// catches the stale id first.
#[tokio::test(flavor = "multi_thread")]
async fn antigravity_restore_with_absent_id_answers_the_typed_missing_refusal() {
    let conv = "00000000-1111-2222-3333-444444444444"; // never seeded
    // ... same base/fake/capture setup as today ...
    let probe = Arc::new(DiskWiredAntigravityProbe::over(&base));
    let (url, registry, ledger, _state) = spawn_antigravity_server_with_probe(probe.clone(), &fake).await;
    seed_bound_row(&ledger, "antigravity", conv);
    // ... connect, send restore_create_with_session_ref("req-agy-gone", "antigravity", conv) ...
    let frame = next_created_or_error(&mut ws, "req-agy-gone").await;
    assert_eq!(frame["type"], "error", "the gated restore refuses: {frame}");
    assert_eq!(frame["code"], json!("SESSION_MISSING"), "{frame}");
    assert!(
        frame["message"].as_str().unwrap_or_default().contains(conv),
        "the refusal names the stale id: {frame}"
    );
    // ZERO spawns, forever — the CLI never sees the stale id.
    assert_no_extra_spawn_rows(&capture, 0);
    // The stale row is retired as SessionMissing — never retried forever.
    let stale_row = ledger
        .load_binding("antigravity", conv)
        .expect("stale row still exists (retired, not deleted)");
    assert_eq!(stale_row.state, RowState::Retired);
    assert_eq!(stale_row.retired_reason, Some(RetiredReason::SessionMissing));
    // The gate actually consulted the probe (active, not passthrough).
    assert!(probe.consulted.load(std::sync::atomic::Ordering::SeqCst) >= 1);
    registry.kill_all();
    let _ = std::fs::remove_dir_all(&base);
}
```

(Mirror the refusal flow from `restore_true_amplifier_absent_answers_the_typed_missing_refusal` (`:504-530`) — the typed error frame assertions, the capture-file check, and the ledger retirement; `RowState::Retired` + `RetiredReason::SessionMissing` are the existing ledger shapes it asserts.)

**3c — `terminal_tabs.rs:6686-6712`:** rewrite the door-3 pin:

```rust
    /// Antigravity is a session-provider mode with opaque plausible ids
    /// (the gemini/kimi class minimum: non-empty, no whitespace), and
    /// door 3 is GATED for it (activated 2026-11-02 on real-binary
    /// transcript evidence + a proven real resume): a stale antigravity
    /// id against positive absence answers SpawnFresh with NO fresh id
    /// minted — the consumer's typed-refusal shape, never passthrough.
    #[test]
    fn antigravity_is_a_session_provider_mode_with_opaque_plausible_ids_and_gated_resume() {
        use freshell_platform::resume_gate::{ResumeExistence, ResumeIntent};
        assert!(is_session_provider_mode("antigravity"));
        assert!(plausible_resume_session_id("antigravity", "conv-1"));
        assert!(!plausible_resume_session_id("antigravity", ""));
        assert!(!plausible_resume_session_id("antigravity", "conv 1"));
        assert!(!is_session_provider_mode("shell"));
        assert!(!is_session_provider_mode("codex"));
        let probe = probe_answering(ResumeExistence::Absent, true);
        let out = validate_rest_resume(
            "antigravity",
            Some("stale-agy".into()),
            LaunchIntent::Resume,
            Some(&probe),
            ResumeIntent::UserCreate,
        );
        assert_eq!(out.resume_session_id, None);
        assert_eq!(out.stale_session_id.as_deref(), Some("stale-agy"));
        assert!(out.notice.is_some());
        assert!(!out.blocked_recovery);
    }
```

**3d — advisory test updates:** in `resume_gate.rs` in-file tests, add `"antigravity"` to `managed_recovery_never_spawns_fresh`'s hardcoded provider list (`:186-194`); `managed_recovery_requires_positive_supported_evidence` (`:213`) and the validated-provider suite (`:135-172`) iterate `VALIDATED_PROVIDERS` and cover antigravity automatically; `unvalidated_providers_never_blocked` (`:178`) keeps its non-antigravity list unchanged.

**3e — `antigravity_existence_by_id.rs:17-22`:** replace the gate-deferral doc paragraph with the activation record (consulted by the spawn doors through the gate since 2026-11-02; evidence-cited; the pane-reconcile role unchanged).

**3f — `freshell-agent-runtime/src/lib.rs:588-592`:** update the capability row's candidate annotations — `identity_capture: "terminal locator (store real-binary-validated 2026-11-02; managed identity unimplemented)"` and `state_store: "$HOME/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl (real-binary-validated 2026-11-02)"` — keeping the row fully blocked/`not_applicable` (managed execution stays out of scope; README:281-282 is untouched). Update the row-pinning test only if it asserts the exact old strings.

**3g — README** (`README.md`): replace `:275-279` with the validated-schema outcome and replace `:296-303` with the gated behavior:

> Freshell's view of Antigravity's on-disk conversation format was
> validated against real `agy` 1.4.12 sessions on 2026-11-02:
> conversations are step-indexed records (`USER_INPUT`, `PLANNER_RESPONSE`,
> `GENERIC`, `SYSTEM_MESSAGE`, `CHECKPOINT`) with second-granularity
> timestamps, and Freshell's parser follows that validated format. Because
> the real format carries no workspace or ownership fields, native
> conversations group under an unknown project, and per-pane conversation
> binding and transcript-driven busy/turn-completion state do not engage
> on real-format sessions — recorded limitations. Freshell installs no
> Antigravity hooks and writes no Antigravity configuration anywhere;
> identity and activity are read-only views over the CLI's own files.

> Resuming a saved conversation validates the id against the on-disk
> store before launching: a conversation whose transcript still exists
> resumes exactly (`agy --conversation <id>`), while a stale id is
> refused with a visible notice and nothing is spawned in its place —
> start a new conversation explicitly instead.

Keep `:281-282` (the managed-row limitation) and `:285-289` (the keystroke-binding limitation — transcript-independent, still true for real sessions) unchanged. REPLACE `:289-295` (the busy-after-restore and completion claims) with honest scoping, because those claims are driven by the fake-contract machinery and would otherwise contradict the validated-schema text above:

> On a resumed or restored pane of a REAL `agy` session, transcript-driven
> busy and turn-completion signals never engage: the real transcript format
> carries no settle record, so Freshell marks no turn completion and rings
> no completion bell for real Antigravity turns (real panes use the generic
> terminal busy/idle treatment). The end-to-end busy/completion machinery
> exists and is exercised by Freshell's own integration fixtures, which
> append a labeled test-only settle record the real binary never writes.
> An approval or question is only marked separately when the transcript
> tailer can prove it; terminal Antigravity panes show only the broader
> busy/idle state and have no waiting-for-approval attention signal (the
> same treatment as other terminal CLI panes).

(Re-anchor all README ranges by text at implementation time — the file drifts.)

**3h — the plan doc + e2e:** flip Provider Contract Record row `:76` to `activated (real-binary evidence 2026-11-02)` citing rows 67/70/74/75 and the evidence report; update the two Known-limitations items that mirror the deferral (`:925`, `:930`) to the activation outcome. Rewrite e2e scenario 8 (`test/e2e-browser/specs/google-cli-history-resume-rust.spec.ts:860-1000`, including the `:966` "DEFERRED by design" assertion) to the gated contract: the dead session's row click (or the direct resume create) produces the typed launch-failure card — `SESSION_MISSING`, naming the stale id, with the start-fresh action (`TerminalLaunchFailureCard.tsx:100` arm) — NO pane spawns, NO replacement conversation mints in the fake store, and clicking start-fresh launches a fresh conversation (the only new-session path). Verify the exact selectors/labels from `TerminalLaunchFailureCard.tsx` at implementation time and follow the typed-refusal wire-line precedent in `test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts:187`.

- [ ] **Step 4: Run the focused tests**

```bash
cargo test -p freshell-platform resume_gate
cargo test -p freshell-ws --lib resume_validation
cargo test -p freshell-ws --test resume_validation_gate
cargo test -p freshell-freshagent antigravity
cargo test -p freshell-agent-runtime antigravity
cargo test -p freshell-server antigravity
```

Expected: PASS (the rewritten pins, the advisory updates, and the two new production-probe gate-variant tests; the by-id locator's own unit tests are untouched behavior — the Present-validation lives in `exists_for_gate`).

- [ ] **Step 5: Refactor while green**

Re-read every rewritten pin's comment for the activation record (version + date + evidence path, once per file); no behavioral change.

- [ ] **Step 6: Run impacted-test verification**

The flip's blast radius is every spawn door and every resume-shaped e2e flow for antigravity:

```bash
cargo test -p freshell-ws --lib antigravity
cargo test -p freshell-ws --test antigravity_launch_e2e
scripts/sandbox-test.sh "cargo test -p freshell-ws --test antigravity_session_rebind"
pnpm run test:vitest run test/unit/client/lib/coding-cli-utils.test.ts --config config/vitest/vitest.config.ts
pnpm exec playwright test --config test/e2e-browser/playwright.config.ts --project=chromium \
  test/e2e-browser/specs/google-cli-launch-rust.spec.ts \
  test/e2e-browser/specs/google-cli-history-resume-rust.spec.ts \
  test/e2e-browser/specs/google-cli-identity-activity-rust.spec.ts
```

Expected: PASS (the restart-restore e2e scenarios 4-7 consult the probe against the fake store's existing `brain/<id>` dirs and proceed; scenario 8 asserts the new refusal; the rebind suite's in-CLI `/resume` flows never pass through the spawn door and are unchanged).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-platform/src/resume_gate.rs crates/freshell-ws/src/resume_validation.rs \
  crates/freshell-ws/tests/resume_validation_gate.rs crates/freshell-freshagent/src/terminal_tabs.rs \
  crates/freshell-server/src/antigravity_existence_by_id.rs crates/freshell-server/src/existence.rs \
  crates/freshell-agent-runtime/src/lib.rs \
  README.md docs/plans/2026-10-29-google-cli-first-class-support.md \
  test/e2e-browser/specs/google-cli-history-resume-rust.spec.ts
git commit -m "feat(antigravity): activate the validated conversation-resume gate"
```

---

### Task 4: Extend the real-provider smoke with a real-resume tier and run the final verification

**Files:**
- Modify: `test/integration/real/antigravity-launch-smoke.test.ts` (the header runbook `:26-32` + the new tier-4 test)
- Also align the existing tier-3 test (`completes a headless turn`) to pass the same session-scoped `--settings '{"modelProvider":"gemini"}'` overlay (GC15): as written it omits the overlay and implicitly relies on the operator having mutated the shared `settings.json` — which GC2 forbids and this host's settings.json does not have (no `modelProvider` key, verified 2026-11-02) — so the first key-bearing gated run would fail on tier 3 at CLI setup before tier 4 ever executes. Minimal same-file fix, in the ARGV SHAPE Task 1's receipts evidenced (`real-binary-transcript-evidence.md` §Headless argv receipt — `-p` TAKES the prompt as its value; `--settings` earlier in argv; the bare `-p <prompt>` positional form misparses and exits 2): `['--settings', '{"modelProvider":"gemini"}', '-p=Reply with exactly: antigravity-smoke-ok']`, and update the header's runbook note accordingly (document the `-p='<prompt>'` shape).
- Test: the same file (the opt-in gated run)

**Interfaces:**
- Consumes: the smoke's existing gating convention (`available && realEnabled && hasProviderKey`, `:58-60`, `:96-99`), `execFileAsync` with `--settings '{"modelProvider":"gemini"}'` (GC15), the store-root resolution order from `crates/freshell-sessions/src/provider_layout.rs` (`FRESHELL_ANTIGRAVITY_HOME` > default-when-conversation-bearing > snap root).
- Produces: the real-resume smoke tier — the standing, opt-in, never-default proof that `agy --settings '{"modelProvider":"gemini"}' --conversation <id> -p='<prompt>'` continues a real conversation's content and appends to the same `brain/<id>` transcript with strictly-increasing step indexes. No production code.

- [ ] **Step 1: Write the failing behavioral test**

This is a contract probe pinning behavior Task 1 already evidenced (the google-cli plan's Task 14 smoke precedent — there is no Red step against product code; the test is new coverage whose first gated run must match the Task 1 receipts). Add to `test/integration/real/antigravity-launch-smoke.test.ts` (after the existing tier-3 test, reusing the module's imports):

```ts
  // Resolves the store root the way the server's seam does
  // (crates/freshell-sessions provider_layout.rs antigravity_home):
  // FRESHELL_ANTIGRAVITY_HOME override > default root when it holds
  // conversations > snap root when it does. The snap binary pins its
  // store under $HOME/snap regardless of a disposable HOME, so the live
  // store is the snap root on this host (the contract-probe receipts).
  async function resolveAgyStoreRoot(): Promise<string> {
    if (process.env.FRESHELL_ANTIGRAVITY_HOME) return process.env.FRESHELL_ANTIGRAVITY_HOME
    const home = os.homedir()
    const defaultRoot = path.join(home, '.gemini', 'antigravity-cli')
    const snapRoot = path.join(home, 'snap', 'antigravity-cli', 'common', '.gemini', 'antigravity-cli')
    const hasConversations = async (root: string): Promise<boolean> => {
      const brain = path.join(root, 'brain')
      return await fs.readdir(brain).then((ids) => ids.length > 0).catch(() => false)
    }
    if (await hasConversations(defaultRoot)) return defaultRoot
    if (await hasConversations(snapRoot)) return snapRoot
    return defaultRoot
  }

  const runResume = available && realEnabled && hasProviderKey
  const itResume = runResume ? it : it.skip
  itResume(
    'resumes a real conversation headlessly and appends to the same transcript',
    async () => {
      const nonce = `antigravity-smoke-resume-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const brainDir = path.join(await resolveAgyStoreRoot(), 'brain')
      const before = new Set(await fs.readdir(brainDir).catch(() => [] as string[]))
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

      // Find the NEW conversation(s) whose transcripts carry the nonce.
      const after = await fs.readdir(brainDir)
      const freshIds = after.filter((id) => !before.has(id))
      let convId: string | undefined
      for (const id of freshIds) {
        const body = await fs
          .readFile(path.join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl'), 'utf8')
          .catch(() => '')
        if (body.includes(nonce)) {
          nonceBearing.add(id)
          convId ??= id
        }
      }
      expect(freshIds.length).toBeGreaterThanOrEqual(1)
      expect(convId, 'the new conversation whose transcript carries the nonce').toBeTruthy()

      // Binary record-schema pins on the run-owned transcript (the
      // corrected contract; evidence: real-binary-transcript-evidence.md).
      const transcriptPath = path.join(brainDir, convId!, '.system_generated', 'logs', 'transcript.jsonl')
      const readRecords = async () =>
        (await fs.readFile(transcriptPath, 'utf8'))
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
      // nonce-bearing fresh conversation — success or any failure (Task 1
      // Step 7 parity): brain/<id> (the transcript) and
      // conversations/<id>.db (the per-conversation sidecar db — verified
      // present per conversation in the real store).
      } finally {
        const storeRoot = await resolveAgyStoreRoot()
        for (const id of nonceBearing) {
          await fs.rm(path.join(brainDir, id), { recursive: true, force: true }).catch(() => {})
          await fs.rm(path.join(storeRoot, 'conversations', `${id}.db`), { force: true }).catch(() => {})
        }
      }
    },
    420_000,
  )
```

Update the file's header runbook block (`:26-32`) to document the fourth tier (same opt-in command; the tier creates and then removes one real conversation per run).

- [ ] **Step 2: Run the gated probe and verify it matches the Task 1 receipts**

This tier is a contract probe pinning behavior Task 1 already evidenced (the google-cli plan's Task 14 smoke precedent — there is no Red step against product code). The key for the gated run, if used, is sourced with the user's explicit approval from one of: `~/.freshell/config.json` `settings.ai.geminiApiKey` (present on this host, verified 2026-11-02), OneCLI after `onecli auth login`, or a user-supplied value — exported only into the probe/test process environment, never printed, never committed; the evidence report records the source by name only. Run:

```bash
FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 GEMINI_API_KEY="$GEMINI_API_KEY" \
  pnpm run test:vitest run test/integration/real/antigravity-launch-smoke.test.ts \
  --config config/vitest/vitest.config.ts
```

Expected: PASS — all four tiers, with the tier-4 receipts matching Task 1's (content recall, same-`brain/<id>` growth, unique and strictly-increasing USER_INPUT step indexes). If Task 1 recorded that the headless `-p --conversation <id>` combination is rejected by the binary, this tier's shape follows that evidence instead (the PTY-resume form), keeping the transcript/step assertions. Without the gates the suite skips the tier (never fails, never runs in the default suite — `config/vitest/vitest.config.ts:59` exclusion). If no `GEMINI_API_KEY` is obtainable on this host (env unset; OneCLI requires `onecli auth login`; the user declines the Freshell-config key), the gated run still passes via `it.skip` — that outcome MUST be recorded in the evidence report and `run-state.md` as 'tier 4 delivered but not exercised on this host (no GEMINI_API_KEY)', and the run's success claim for the real-resume smoke item is downgraded to 'delivered; exercised only on a key-bearing host'. A skip is never counted as coverage.

- [ ] **Step 3: Add the minimal production implementation**

None — this task changes test code only (the probe tier IS the deliverable). If the run reveals a smoke-harness gap (e.g. `os`/`path` imports already present at `:37-38` — verify), fix the harness minimally.

- [ ] **Step 4: Run the focused test**

Run: the Step 2 command.

Expected: PASS (tiers 1-4; tiers 1-2 always-run when the binary is present, tiers 3-4 gated).

- [ ] **Step 5: Refactor while green**

Extract the shared `resolveAgyStoreRoot`/record-reading helpers only if the file grows a third consumer; otherwise leave flat. No behavioral change.

- [ ] **Step 6: Run impacted-test verification — the final sweep**

```bash
pnpm run typecheck
cargo fmt --check
cargo clippy -p freshell-sessions -p freshell-activity -p freshell-platform -p freshell-ws --tests
cargo test -p freshell-sessions && cargo test -p freshell-activity && cargo test -p freshell-platform
cargo test -p freshell-ws --lib antigravity
cargo test -p freshell-ws --test resume_validation_gate && cargo test -p freshell-ws --test antigravity_launch_e2e
scripts/sandbox-test.sh "cargo test -p freshell-ws --test antigravity_session_rebind"
cargo test -p freshell-freshagent antigravity && cargo test -p freshell-server antigravity && cargo test -p freshell-agent-runtime antigravity
pnpm run test:vitest run test/unit/client/lib/coding-cli-utils.test.ts --config config/vitest/vitest.config.ts
pnpm exec playwright test --config test/e2e-browser/playwright.config.ts --project=chromium \
  test/e2e-browser/specs/google-cli-launch-rust.spec.ts \
  test/e2e-browser/specs/google-cli-history-resume-rust.spec.ts \
  test/e2e-browser/specs/google-cli-identity-activity-rust.spec.ts
```

Expected: PASS everywhere. The full-suite gate (broad `pnpm run test` through the coordinator with `GCLOUD_ROBOT_REQUIRE=1`, `FRESHELL_RUST_TEST_SANDBOX=1`, and a `FRESHELL_TEST_SUMMARY`) runs once at the workflow's Stage 5 per the the-usual process — green excluding the ledger-recorded pre-existing parity failures (GC11); record the entry in `run-state.md`.

- [ ] **Step 7: Commit the task**

```bash
git add test/integration/real/antigravity-launch-smoke.test.ts
git commit -m "test(antigravity): add the real-resume tier to the launch smoke"
```

---

## Requirements → Tasks map

| # | Requirement (from the User Request) | Task | Verification |
|---|---|---|---|
| 1 | Validate the candidate record schema against real binary transcripts (→ correct it: the Accepted tradeoff authorizes correction) | Task 1 (evidence + Contract Record flips), Task 2 (parser/fixtures/source/search/locator/classifier corrections) | Task 1 receipts + flipped rows; Task 2's parity/parser/locator tests + the e2e trio |
| 2 | Prove the `turn_settled.at` collision question with binary evidence (per-settle dedupe, equal-at = replay) | Task 1 (the binary receipts: no settle record; second-granularity collides; step_index unique + increasing), Task 2 (the dedupe re-keying + `same_second_settles_with_distinct_step_indexes_both_complete`) | Task 1 Step 6 receipts; Task 2 Step 1d/Step 2 red→green |
| 3 | Flip the deferred resume gate in resume_validation.rs | Task 3 (VALIDATED_PROVIDERS + every deferral pin rewritten) | Task 3 Steps 2 (designed reds) and 4-6 (green + impacted sweep) |
| 4 | Remove the corresponding README limitation | Task 3 (README:296-303 replaced; :275-279 rewritten with the schema outcome) | Task 3 Step 3g; no stale limitation text remains |
| 5 | Extend the real-provider smoke to cover a real resume | Task 4 (tier 4) | Task 4 Step 2 gated run; if the tier was skipped for want of a key on this host, the verification record must say 'delivered, not exercised' — a skip is not coverage |
| 6 | Gate stays OFF until real-binary evidence exists (GC4) | Task 1 → Task 2 → Task 3 ordering (GC13); the STOP branch in Task 1 Step 4 | Task sequencing + the honest-blocker branch |
| 7 | Settings precondition modelProvider "gemini" per the smoke runbook | GC15; Task 1 Steps 4-5; Task 4's `--settings` overlay | The receipts record the auth path used |
| 8 | Worktree on a branch from origin/main; no PR without approval | Run setup (already done) + GC6/Task discipline | No task creates a PR |

## Known pre-existing failures (NOT this run's work)

The run-state baseline ledger records the managed fresh-agent parity failures (katas fy2w/smp2/8p6f) and the provider-parity suite-setup cascade. They are out of scope (GC11): no task touches `fresh-agent-parity.test.ts`, `provider-parity-contract.test.ts`, or their harnesses, and every green claim in this plan excludes exactly those ledger-recorded failures.

## Self-review record

Self-review performed before commit (per the usual-writing-plans contract): spec coverage, no silent deferrals (the two retained fake-contract extensions are explicitly labeled with their no-real-referent binary evidence and their limitation records — not silent), file/interface consistency (all paths/line anchors verified against the worktree at base_ref), executable tests (every red step names its intended failure; every command is runnable as written), placeholder scan (no TBD/TODO/vague directions), and operational completeness (cleanup, logging, README, e2e/smoke coverage). No `UNRESOLVED COVERAGE GAP`: the one conditional outcome — the authenticated session being unavailable — is handled by the explicit STOP branch (Task 1 Step 4 / GC13), not deferred.

Load-bearing amendments (Stage 2, 2026-11-02, after the finder/strategist audit — reports under the run's logs dir): the Critical cleanup guard (UUID-shape `CONV_ID` assertion before first use and before every store deletion — an unguarded empty expansion would have deleted the user's entire `brain/` tree); the Step 3b settings.json checksum fence around every probe (sha256 + stat, byte-exact out-of-store backup, abort-on-mismatch) with the captured baseline `134d6522…b78b1`; the shared-file stat+sha256 residue receipts (last_conversations.json / history.jsonl / conversation_summaries.db / cli.log — record, do not fix) and the tier-4 cleanup extended to `conversations/<id>.db`; the H3 failure clause (fresh receipts that disprove step-index uniqueness/increase block the flip per GC13); the auth-ordering replacement (key path → OAuth fallback → STOP; key-path failure is "try OAuth", never an immediate STOP) with the key-source decision (the Freshell config's `settings.ai.geminiApiKey`, present on this host — recorded by name only, never printed); the corpus version stamps corrected to "agy 1.2.11 + 1.4.12 (store-log-attributed, schemas identical)" with bare 1.4.12 reserved for fresh receipts; the PLANNER_RESPONSE empty-content nuance (42/45 corpus records null/empty; only the turn-final planner record carries the reply) added to the evidence requirements; the tier-3 `--settings` overlay fix (its omission would fail the first key-bearing gated run at tier 3 before tier 4 executes) and the smoke's known-type-scoped stamp assertions with a version receipt; the tier-4 delivered-not-exercised honesty rule (a skip is never coverage); and grep-driven sweeps preferred over line anchors for the fake-writer plant sites (the rebind fake-writer anchors drifted; two locator plant sites sit outside the plan's listed anchors). The auditor's R1-R6 verifications (resume path never consults the transcript parser; the gate flip's blast radius is exactly the enumerated set with the `NoIndexProbe`/Unknown→Proceed behavior keeping the rebind suite green; the fixture-consumer set is complete; no google-cli spec sits in `CLOUD_SKIP_SPECS`; the refusal-notice shape; the doc anchors) are carried as settled facts into the evidence report.

Plan-review round 1 remediation (2026-11-02): six Major findings CLEARED in the plan (see the run's plan-review-log.md) — the binary proof is the receipts, not the synthetic test (Consequence 1); `conversation_id_from_path` consumes `transcript.jsonl` first (the draft always returned `None`); the Task 2 red commit carries the call-site updates so the red is behavioral, not a compile error; the settings fence restores only this run's own damage signature and otherwise leaves a concurrent change untouched (GC2); the `--settings` overlay is passed on BOTH auth paths, with the no-overlay form only as the evidenced recorded deviation of branch (2b); cleanup runs unconditionally (tier-4 `finally`; Task 1 cleanup not gated on receipt success — receipts gate the flip, never cleanup).

Plan-review round 2 remediation (2026-11-02): four Major + one Minor findings CLEARED (see the run's plan-review-log.md) — the gate-variant Present-validation (production `exists_for_gate` consults the by-id disk locator for antigravity Present answers, closing the stale-warm-index hole that would let a deleted conversation pass to `agy` and silently mint a fresh one; red test drives the production probe); the fence attributes damage by CONTENT (jq strip-and-compare against the baseline — key presence alone is not attribution); branch (2b) receipts are diagnostic-only and CANNOT support the flip (the settings precondition is unsatisfied on that path); the evidence report is written from the retained `/tmp/opencode/yhqb` receipts BEFORE that directory is removed; README `:289-295`'s busy/completion claims are replaced with honest fake-contract scoping instead of contradicting the validated-schema text.

Plan-review round 3 remediation (2026-11-02, the cap round — loop ended FAILED/non-converged with every finding CLEARED): the gate-variant validation extended to the COLD window (both `Present` and `Unknown` answers are disk-validated for antigravity — every startup's cold index would otherwise pass any stale id through on Unknown→Proceed); two cold-path production-probe tests added; the Task 1 conversation-id assignment made executable (directory-name assignment in the loop, not a placeholder redirect); the tier-4 cleanup try/finally now opens before the first invocation and sweeps every nonce-bearing fresh conversation.
