# First-class Google coding CLI support in Freshell — Implementation Plan

Date: 2026-10-29. Status: executable implementation plan (restructured from the committed first draft; research findings folded into Global Constraints and the Provider Contract Record below).
Worktree: `.worktrees/google-cli-plan`, branch `docs/google-cli-first-class-plan`, base_ref `4da47fd9aed84d3f8f6c71bed1eb0ab6419ebd17`.

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task.
> Progress is tracked in the the-usual SDD ledger — per-task reports and
> reviews under `.worktrees/.the-usual-logs/google-cli-plan/`, plus the
> round fix reports in the worktree's `usual-sdd/` — NOT in the checkbox
> steps below. The checkboxes remain unchecked as the plan's original step
> text; check the ledger for what actually shipped and what changed.

## User Request

### Requested result
- First-class Google coding CLI support in Freshell, implemented in the existing `.worktrees/google-cli-plan` worktree: make Antigravity CLI (`agy`, provider ID `antigravity`) a first-class terminal agent across launch, native history/search, exact identity/resume, naming/activity/attention, and qualified managed recovery, while preserving the existing Gemini CLI (`gemini`) entry.

### Explicit constraints
- Use the committed plan document `docs/plans/2026-10-29-google-cli-first-class-support.md` as the first draft plan and start from there.
- Run the full the-usual workflow in that worktree: plan, load-bearing validation, independent plan review, task-by-task TDD execution with per-task review, independent delta review, recap.
- Follow repo rules: red/green/refactor TDD, unit + e2e coverage, pnpm 10.34.5, coordinator gate for broad runs with `GCLOUD_ROBOT_REQUIRE=1`, destructive tests in the disposable sandbox, focused commits; no PR creation without explicit approval; never restart the live self-hosted server on port 3001 without the user's explicit "APPROVED".
- Never silently send a saved Gemini session to `agy`, alias their IDs, or run Google's configuration migration on the user's behalf.

### Accepted tradeoffs and residuals
- The plan's Stage-1 provider-contract probes require a real pinned `agy` binary; neither `agy` nor `gemini` was on PATH during planning. Unproven contract details stay named blockers with honest recorded limitations; a launch-only milestone may ship with accurate limitations. Paid real-provider probes are opt-in and bounded and were not executed during planning.

**Goal:** A user with Antigravity CLI installed sees "Antigravity CLI" in the pane picker and settings, launches it in a chosen directory with model/effort passthrough, gets exact per-pane conversation identity with concurrent same-directory panes staying separate, finds native conversations in sidebar/history/search, resumes the exact conversation after exit/restart with continued content, gets unified names and busy/turn-completion attention, and never has a Gemini session silently handed to `agy` — with every unproven native-contract claim recorded as a named limitation instead of assumed.

**Architecture:** Register `antigravity` as a seventh bundled CLI extension (manifest-expressible launch + resume templates, no resolver code changes), add a native session source in `freshell-sessions` (codex-style JSONL parser + amplifier-style own-file source over the documented `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl` store), bind live identity with a codex-style disk locator (no provider hooks are installed — no shared-file writes, inactive in external shells by construction), drive busy/turn-completion attention from an amplifier-style read-only transcript tailer with a conservative pure tracker, join the unified-naming provider lists with honest `unsupported` native rename, and add the managed-runtime capability row in the fully blocked/disabled state until real-binary qualification evidence exists. Gemini's existing entry, settings, and saved panes remain valid and untouched.

**Tech Stack:** Rust workspace (`freshell-extensions`, `freshell-platform`, `freshell-sessions`, `freshell-ws`, `freshell-activity`, `freshell-protocol`, `freshell-freshagent`, `freshell-server`, `freshell-agent-runtime`), React/Redux/Zod client, Vitest + Cargo tests, Playwright browser specs with contract-faithful fake CLIs, pnpm 10.34.5.

## Global Constraints

1. **Product identity:** provider ID `antigravity`, label `Antigravity CLI`, command `agy`, env override `ANTIGRAVITY_CMD`. `gemini`/`GEMINI_CMD` stay intact and valid.
2. **Never do:** send a saved Gemini session to `agy`; alias Gemini/Antigravity IDs; run Google's configuration migration on the user's behalf; use `--continue` or the `~/.gemini/antigravity-cli/cache/last_conversations.json` cache for exact-session resume or identity evidence; edit provider transcripts to rename; overwrite any shared user/project configuration (`.agents/hooks.json`, `~/.gemini/config/hooks.json` included); claim recovery from a display-only transcript; copy live credential stores into fixtures.
3. **No silent replacement:** missing native state, authentication failure, and transient store errors remain distinct outcomes; a failed resume must never pretend the resumed pane still IS the requested conversation. The resume gate (`VALIDATED_PROVIDERS`) stays OFF for antigravity until real-binary transcript evidence exists (Provider Contract Record): a stale id passes through ungated and the CLI's own PROBED behavior surfaces in-pane — it prints `warning: conversation "<id>" not found` and continues into a FRESH interactive session (no failure exit; argv/PTY probes v1.4.10 + v1.4.12). Freshell adds no substitution of its own: the pane stays alive with its identity still naming the requested (dead) id until the pane's next clean prompt proves the CLI's fresh conversation, at which point the pane REBINDS old→new transparently through the existing rebind machinery (the loud warning + transparent rebind IS the no-silent-substitution mechanism; what is forbidden is pretending the fresh conversation is the requested one — round 7 correction of the earlier "surfaces an error in-pane" wording, which contradicted the record's own probe receipts). Once evidence lands, gate activation follows the repo's validated-provider policy (user-create `Absent` → SpawnFresh + visible notice; managed recovery: fail closed).
4. **Candidate-contract honesty:** every native-contract fact not validated against a real pinned binary is a NAMED BLOCKER (see Provider Contract Record). Code built on candidate contracts must work end-to-end against the checked-in fixtures and carry a `// Stage-1 candidate contract:` comment at the seam, and the limitation must be recorded in the Provider Contract Record and README. No capability flag, qualification entry, or recovery claim may be enabled on candidate evidence.
5. **Hooks:** install NO antigravity hooks and write NO antigravity config anywhere until a launch-scoped, user-preserving mechanism is proven against a real binary (named blocker). Freshell's integration is read-only over the provider's own store. Identity/activity therefore use the codex locator and amplifier tailer precedents (both hook-free).
6. **Repo rules:** red/green/refactor TDD for every behavior change (tests must execute readers, launches, routes, or user interactions — never assert that source/docs/config contain strings); pnpm 10.34.5 with `--frozen-lockfile`; narrowed Cargo selectors are delegated lanes; broad gates only through the coordinator with `GCLOUD_ROBOT_REQUIRE=1`, `FRESHELL_RUST_TEST_SANDBOX=1`, and a `FRESHELL_TEST_SUMMARY`; process-kill/restart-storm suites only in the disposable sandbox; browser specs must pass on the configured `FRESHELL_E2E_BACKEND` (cloud) and not sit in `CLOUD_SKIP_SPECS`; TypeScript relative imports need `.js` extensions; no PR creation without explicit user approval; never restart the live port 3001 server without "APPROVED"; commit `.kata.toml` if modified.
7. **Structured logging:** emit JSONL severity-tagged events (launch outcomes, identity bind/rebind/refusals, discovery/parse failures, resume decisions, activity transitions) correlating provider, terminal id, and native conversation id; omit prompt/transcript contents and credentials; rate-limit repeated failures per repo conventions.
8. **Documentation:** `README.md` is the only end-user doc (env var row, provider row, limitations); `docs/index.html` mock updated only for the new visible provider experience; agent-facing notes link from `AGENTS.md`.
9. **Preserve frozen provenance:** never edit `crates/freshell-extensions/fixtures/manifest-oracle.json` or `port/**`; the bundled-manifests test covers the real new file.
10. **A11y:** new UI rows follow the repo's semantic-HTML/aria rules (`pnpm run lint` introduces no new findings on this plan's delta — the repo-wide gate's pre-existing red baseline is ledger-recorded; see Verification gate 4).

## Requirements → Tasks map

| # | User-visible requirement (from the first draft §1) | Tasks |
|---|---|---|
| 1 | Picker/settings entry, launches in selected directory, model/effort controls, CLI/MCP launch | 2, 3, 11 |
| 2 | Exact per-pane conversation identity; concurrent same-dir panes separate; in-CLI switches update identity | 6, 12, 13 |
| 3 | Sidebar/history/search show native conversations; click focuses live pane or resumes exact conversation | 5, 12 |
| 4 | Names agree across surfaces; states reflect provider evidence | 8, 9, 13 |
| 5 | Refresh/reconnect retain the terminal; managed execution only after qualification | 7, 12, 14 |
| 6 | Missing executable/auth/history produce useful errors without replacement conversations | 3, 7, 11, 12 |

## Provider Contract Record (documented facts, validation status, named blockers)

Every row's status is one of: `documented` (source: Google docs), `fixture-validated` (proven against our checked-in fake), `blocked` (needs a real pinned binary; candidate contract in use), or a compound `documented+validated (<layer>, <date>)` accumulating each validation layer as it lands. Task 1 updates this record; later tasks must not flip a `blocked` row without real-binary evidence.

| Contract fact | Status | Evidence / blocker |
|---|---|---|
| Google's consumer successor to Gemini CLI is Antigravity CLI, invoked `agy`; Gemini CLI continues for Standard/Enterprise/API-key | documented | https://developers.googleblog.com/en/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ |
| CLI flags: `--model`, `--effort`, `--mode`, `-i`/`--prompt-interactive`, `-p` (aliases `--print`/`--prompt`), exact resume `--conversation <id>` | documented+validated (docs, 2026-10-29; real pinned binary v1.4.10 `--help`, 2026-10-29; real binaries v1.4.10 AND v1.4.12 argv probes, 2026-11-01) | Docs layer: all 6/6 confirmed against https://antigravity.google/docs/cli/reference/ (validator report load-bearing-validator-G1.md). Real-binary layer (Task 1 probe, full `--help` in contract-probe.md): all 6/6 confirmed — `--model` "Model for the current CLI session"; `--effort` "Reasoning effort for the current CLI session (low\|medium\|high\|xhigh\|max)"; `--mode` "Set the agent execution mode for this session (accept-edits, auto, plan)"; `-i` "Short alias for --prompt-interactive"; `--prompt-interactive` "Run an initial prompt interactively and continue the session"; `-p` "Short alias for --print"; `--prompt` "Alias for --print"; `--conversation` "Resume a previous conversation by ID". The binary shows a concrete effort enum `(low\|medium\|high\|xhigh\|max)`, resolving the docs inconsistency; per-model acceptance stays unvalidated (no model calls) — the manifest template still passes user values through, never hardcodes. `--mode` defaults to `""` (docs layer; the binary help shows no default value) — emit only for non-default values (no `--mode` template shipped). Binary also confirms `--print-timeout` default `0s` and `--input-format` (text, stream-json). ARGV-BEHAVIOR layer (round 6, 2026-11-01; probes of BOTH the original pinned v1.4.10 (re-acquired, SHA512-matched) and the then-current pinned v1.4.12 — identical results on every probe; disposable HOME + black-holed egress, no auth, no model calls): `-i`/`--prompt-interactive` TAKE A PROMPT VALUE — bare `-i` → `flag needs an argument: -i` + usage, exit 2; `-i --conversation <id>` → exit 2 with the LOUD misparse error (below) — the CLI never silently substitutes; bare `agy` with NO flags IS the interactive default (full TUI on a PTY); `--conversation <unknown-id>` prints `warning: conversation "<id>" not found` to stderr and CONTINUES into a FRESH interactive session (the CLI's own missing-id behavior is a warning + fresh session, NOT an error — Freshell passes ids through ungated and the README records this honestly); the interactive TUI enables bracketed paste on startup (`CSI ?2004h` observed in the PTY probe receipts — evidence for the association's paste-envelope parsing). |
| Interactive panes launch BARE — `agy` with NO launch flag is the interactive default; `-i`/`--prompt-interactive` (prompt-taking) are never sent; `-p` is never used for panes | documented+validated (real binaries v1.4.10 AND v1.4.12 argv probes, 2026-11-01; fakes + goldens pin the shape) | ROUND-6 CORRECTION of the original claim (which overstated `--help`-only evidence as "presence and semantics binary-confirmed"): the argv probes proved bare `agy` starts the interactive TUI (PTY probe; without a TTY it prints `CLI error: bubbletea: error opening TTY: bubbletea: could not open TTY: open /dev/tty: no such device or address`, exit 0) while the first draft's `-i` pin would have broken every launch. The manifest therefore ships NO static args (`extensions/antigravity/freshell.json`), and the fakes argv-validate the probed shapes (`test/e2e-browser/fixtures/fake-agy-terminal.mjs`, the rebind suite's sh fake, `cli_launch_goldens.rs` G-AN*, `antigravity_launch_e2e.rs`). VERBATIM RECEIPTS (identical on both binaries; full raw transcripts in the round-6 fix report): `agy -i` → stderr `flag needs an argument: -i` + usage, exit 2; `agy --prompt-interactive` → stderr `flag needs an argument: -prompt-interactive` + usage, exit 2; `agy -i --conversation <id>` → stderr `Error: -i took "--conversation" as its prompt, so the intended prompt was left as an argument and ignored.` / `Attach the prompt to the flag (-i='your prompt') and move --conversation elsewhere on the command line.`, exit 2 — the LOUD misparse guard (a resume never silently becomes a seeded fresh prompt); `agy` bare (PTY) → TUI: ` Welcome to the Antigravity CLI. You are currently not signed in.` (+ `CSI ?2004h` bracketed-paste enable); `agy --conversation <unknown-id>` (PTY) → stderr `warning: conversation "<id>" not found` then the same fresh TUI. Probe method: disposable HOME (`mktemp -d`), `env -i`, egress black-holed via dead local proxies, `timeout -k` bounded, no login, no model calls, no authenticated operation; the disposable HOME (not the user's) received the CLI's own store init. |
| Transcript at `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl`; hook inputs `conversationId`, `workspacePaths`, `transcriptPath` | documented+validated (path + hook inputs, 2026-10-29; real binary transcripts — agy 1.2.11 + 1.4.12 corpus, store-log-attributed, schemas identical, plus fresh 1.4.12 receipts — 2026-11-02; corrected schema below — the candidate record vocabulary is disproven) | Hooks docs quote verbatim (validator report G1). RECORD SCHEMA real-binary-validated 2026-11-02 (Task 1, docs/plans/2026-11-02-antigravity-transcript-validation.md): five record types — `USER_INPUT`/`PLANNER_RESPONSE`/`GENERIC`/`SYSTEM_MESSAGE`/`CHECKPOINT` — and nothing else; every record carries `type`/`source`/`status`/`step_index`/`created_at` (RFC3339 UTC, SECOND granularity); optional `content`/`thinking`/`tool_calls`/`media`/`error`/`truncated_fields` + the flat `input_tokens`/`output_tokens`/`cache_read_tokens`; NO `conversationId`/`workspacePaths`/`at`/`text`/`usage` field exists anywhere (the conversation id IS the `brain/<id>` directory name). Evidence: `.worktrees/.the-usual-logs/antigravity-transcript-validation/reports/real-binary-transcript-evidence.md` (fresh receipts: OAuth path, no settings overlay — diagnostic branch; the corpus evidence is auth-independent) |
| Hook events `SessionStart`, `PreInvocation`, `PostInvocation`, `Stop` (`Stop` carries `fullyIdle`, an error, a termination reason) | documented, blocked | We install no hooks (Global Constraint 5); semantics encoded only in the fake for spec assertions |
| Hook config sources: `.agents/hooks.json`, `~/.gemini/config/hooks.json`, plugins — all SHARED files; no launch-scoped overlay is known | documented | BLOCKER: no hook producer until a real binary proves a launch-scoped mechanism that preserves user hooks. Task 1 lead (v1.4.10 `--help`, contract-probe.md): `--settings` "Settings for this session only, never saved: a JSON object of settings.json keys, inline or as a file path" — a session-scoped, never-saved overlay EXISTS, but docs say hooks are not loaded from settings.json, so whether it can carry or merge hooks is unvalidated; blocker stands. |
| `--conversation <id>` resumes the exact prior conversation and continues its content; `-c`/`--continue` + `cache/last_conversations.json` are the distinct, weaker workspace-cache mechanism (silently fresh if the key is missing) | documented+validated (docs layer; flag presence on real binary v1.4.10, 2026-10-29; binary-level content continuation — headless `--conversation` resume probe, agy 1.4.12, 2026-11-02) | Resume + headless docs quotes (validator report G1); `--conversation` "Resume a previous conversation by ID" and `-c`/`--continue` "Continue the most recent conversation" both binary-confirmed in v1.4.10 `--help` (contract-probe.md). CONTENT CONTINUATION binary-proven 2026-11-02 (Task 1 resume probe, agy 1.4.12): a separate headless process `agy --conversation <id> -p='<prompt>'` resumed the exact prior conversation and answered a question about turn 1's content with turn 1's secret nonce string — exit 0, zero `warning: conversation` output (no silent fresh start); a further back-to-back turn continued the same conversation (USER_INPUT step_index 0→2→5 across three processes). Receipts: `.worktrees/.the-usual-logs/antigravity-transcript-validation/reports/real-binary-transcript-evidence.md` — auth path: branch-(2b) OAuth, no settings overlay (the binary rejects the overlay under OAuth auth; diagnostic for the Task 3 gate flip per GC13 — the flip waits for overlay-conformant evidence; the resume mechanic itself is a binary fact). Freshell never uses `--continue` for resume (Global Constraint 2) |
| Distribution: non-interactive Linux artifact EXISTS — per-platform manifest JSON (`version`/`url`/`sha512`) → GCS tarball → SHA512-verified; latest stable 1.4.10 (2026-10-29) → 1.4.12 (2026-11-01 re-fetch); no npm package | documented+validated (docs layer; acquisition executed against the real artifact, 2026-10-29; re-acquired 2026-11-01) | Docs layer: install page + release manifest (validator report G1). Task 1 executed the acquisition end-to-end (contract-probe.md): manifest fetched (v1.4.10), tarball downloaded (66,762,005 bytes), SHA512 exact-matched the manifest, member `antigravity` unpacked and run as `agy` from a disposable prefix with a disposable HOME; `--version` → `1.4.10`, exit 0. Round 6 (2026-11-01) re-fetched the release manifest: it now serves v1.4.12 (sha512 `ea01c73b…4b7f4`, tarball 68,051,214 bytes, SHA512 exact-matched, unpacked and probed from a disposable prefix with a disposable HOME). Self-update check (Task 1): version identical before/after the short probe; the background self-update risk during regular runs STANDS — any managed pin (deferred) must version-stamp. DEV-MACHINE NOTE (2026-11-01, recorded honestly): the on-PATH `agy` here is a `~/.local/bin/agy` sh wrapper (adds `--dangerously-skip-permissions`) exec'ing the SNAP binary (antigravity-cli 1.4.12); snap confinement pins the CLI's `HOME` to `$SNAP_USER_COMMON` (`~/snap/antigravity-cli/common`), so a snap install's store root differs from the raw binary's `$HOME/.gemini/antigravity-cli` (probe-created under the disposable HOME) — Freshell's store-root resolution (`antigravity_home`, `FRESHELL_ANTIGRAVITY_HOME` override) must account for snap installs or the locator misses their transcripts (remaining concern, round-6 report). ROUND-7 RESOLUTION (2026-11-01, read-only probe of the real snap install + implemented fallback): `ls ~/snap/antigravity-cli/common/` → `.gemini/` + `permission-verification.log`; the store lives at `~/snap/antigravity-cli/common/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl` (THREE real conversations confirmed by `find ~/snap/antigravity-cli/common -name transcript.jsonl`), while `~/.gemini/antigravity-cli` EXISTS on this machine with an EMPTY `brain/`. `antigravity_home` therefore resolves `FRESHELL_ANTIGRAVITY_HOME` (as-is) > the default root (when its `brain/` holds conversations) > the snap fallback `<home>/snap/antigravity-cli/common/.gemini/antigravity-cli` (considered when the default is absent or conversation-less), announcing the chosen root at boot (`antigravity_store_root_resolved`; both-absent logs `antigravity_store_root_missing`) — Global Constraint 7; the residual (one watched root per boot) is Known limitation 7. |
| API-key auth needs `modelProvider: "gemini"` in settings AND `GEMINI_API_KEY`; OS keyring for local sign-in; CLI does not load `.env` | documented, blocked | https://antigravity.google/docs/install/?tab=cli ; managed-auth projection unproven |
| Native titles, complete conversation enumeration, retention/deletion, transcript recovery authority, independent-process/backend ownership | blocked | Task 1 executed (2026-10-29, v1.4.10): nothing obtainable within the authorized `--version`/`--help` scope (subcommands `models`/`changelog`/`mcp`/`plugin`/`update` exist but were not run — no authenticated operation; full subcommand list in contract-probe.md); everything stays a named blocker |
| Candidate transcript record schema (fixtures + parser + fake agree on this) | real-binary-validated (corrected schema; agy 1.2.11 + 1.4.12 corpus, store-log-attributed, plus fresh 1.4.12 receipts, 2026-11-02) | The candidate vocabulary is DISPROVEN by real transcripts: no `session_start`/`user_message`/`assistant_message`/`turn_settled` record exists; the real format is the five-type step-indexed discipline in the corrected schema block below. Evidence: `.worktrees/.the-usual-logs/antigravity-transcript-validation/reports/real-binary-transcript-evidence.md`. Task 2 of docs/plans/2026-11-02-antigravity-transcript-validation.md implements the correction across every consumer and test double |
| Real-binary follow-up for the candidate schema: (a) the CLI's `turn_settled.at` timestamp granularity must be fine enough that two genuine turns can never share one `at` value (the per-settle replay dedupe treats equal-`at` as the same settle); (b) whether the per-`assistant_message` `usage` envelope is PER-MESSAGE or CUMULATIVE is unknown — the parser takes the LAST assistant envelope (a documented choice, parse/antigravity.rs; under a per-message reading a multi-turn conversation reports only the final message's envelope) | real-binary-answered (a) and (b), agy 1.2.11 + 1.4.12 corpus + fresh 1.4.12 receipts, 2026-11-02 | (a) BINARY ANSWER: `turn_settled` does not exist in the real format (corpus + scratch candidate-key grep 0 everywhere) — the per-settle dedupe has no real referent to swallow; real `created_at` is SECOND-granularity and demonstrably collides (4 records/second in the corpus; 3 records/second twice in the run-owned scratch conversation), so ANY dedupe keyed on wall-clock alone WOULD collide; the corrected dedupe keys on the record identity `(created_at, step_index)` — `step_index` binary-evidenced unique per record, strictly increasing across turns AND across resumed processes (fresh receipts: USER_INPUT steps 0→2→5 over three turns in three separate processes; duplicate check empty; no disproof — the GC13 disproof branch did not fire). (b) BINARY ANSWER: exactly ONE token-bearing record per turn, values PER-TURN (not cumulative — scratch turn 3 input 2373 < turn 2's 13130, cache_read 11081 accounting for prior context); in a multi-step turn the token-bearing record can be the turn's EARLY planner record (corpus: step 1, content null) while the turn-final reply record carries NO token fields; the parser's LAST-wins therefore reads the latest turn's per-turn usage — the documented under-report residual stands, binary-evidenced. Receipts: `.worktrees/.the-usual-logs/antigravity-transcript-validation/reports/real-binary-transcript-evidence.md` (fresh receipts: OAuth path, no settings overlay — diagnostic branch) |
| Resume-gate activation for antigravity (`VALIDATED_PROVIDERS`) | deferred (blocked on A2) | A wrong store schema would make real conversations answer `Absent`, activating a misleading SpawnFresh-on-restore chain; per Global Constraint 4 the gate stays OFF (gemini-style passthrough) until real-binary transcript evidence exists. Task 7 builds the gate-independent plumbing and records the activation criterion. |

**Candidate transcript record schema — SUPERSEDED (2026-11-02; disproven against real binary transcripts — no `session_start`/`user_message`/`assistant_message`/`turn_settled` record exists in any real transcript; retained for history only)** (was used by Task 4 fixtures, Task 5 parser, Task 8 tailer, Task 10 fake — first line is the ownership record, codex `session_meta` style):

```jsonl
{"type":"session_start","conversationId":"<uuid>","workspacePaths":["/abs/cwd"],"model":"<model>","startedAt":"<RFC3339>"}
{"type":"user_message","conversationId":"<uuid>","text":"<prompt>","at":"<RFC3339>"}
{"type":"assistant_message","conversationId":"<uuid>","text":"<reply>","at":"<RFC3339>","usage":{"inputTokens":10,"outputTokens":20,"cachedTokens":0,"totalTokens":30}}
{"type":"turn_settled","conversationId":"<uuid>","at":"<RFC3339>","outcome":"completed"|"errored","fullyIdle":true|false}
```

Multi-workspace conversations: `workspacePaths` may carry several paths; the parser keeps them all and uses the first recorded one as the evidenced primary cwd (never the current terminal's cwd). Unknown record types are ignored; malformed lines are skipped; a truncated final line is skipped.

**Corrected transcript record schema (real-binary-validated, 2026-11-02; agy 1.2.11 + 1.4.12 corpus, store-log-attributed, schemas identical, plus fresh 1.4.12 receipts; evidence: `.worktrees/.the-usual-logs/antigravity-transcript-validation/reports/real-binary-transcript-evidence.md`):**

```jsonl
{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":<int>,"created_at":"<RFC3339 seconds>","content":"<prompt>"}
{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":<int>,"created_at":"<RFC3339 seconds>","content":"<reply>","input_tokens":<int|null>,"output_tokens":<int|null>,"cache_read_tokens":<int|null>}
{"type":"GENERIC","source":"MODEL","status":"DONE"|"ERROR","step_index":<int>,"created_at":"<RFC3339 seconds>","content":"<step output>","error":"<message on ERROR records>"}
{"type":"SYSTEM_MESSAGE","source":"SYSTEM","status":"DONE","step_index":<int>,"created_at":"<RFC3339 seconds>","content":"<system text>"}
{"type":"CHECKPOINT","source":"SYSTEM","status":"DONE","step_index":<int>,"created_at":"<RFC3339 seconds>","content":"<checkpoint summary>"}
```

Binary facts (all shape-only receipts, 2026-11-02): the conversation id IS the `brain/<id>` directory name (no record carries an id); every record carries `type`/`source`/`status`/`step_index`/`created_at`; `source` ∈ {`USER_EXPLICIT`,`MODEL`,`SYSTEM`}; `status` ∈ {`DONE`,`ERROR`}; `created_at` is RFC3339 UTC at SECOND granularity and collides routinely within one second; `step_index` is unique per record within a conversation, strictly increases across turns (and across resumed processes), and is NOT monotonic in file order (out-of-order appends observed); optional fields are `content`/`thinking`/`tool_calls`/`media`/`error`/`truncated_fields` plus the flat `input_tokens`/`output_tokens`/`cache_read_tokens` (null on almost all records; no `totalTokens` key exists); there is NO ownership/workspace/settle record of any kind (no `conversationId`, `workspacePaths`, `at`, `text`, `usage`, `startedAt`, `fullyIdle`, or `outcome` field anywhere); a turn is `USER_INPUT` → a run of MODEL records, with the user-facing reply on the turn-final `PLANNER_RESPONSE` (multi-step turns: intermediate planner records carry null content — 42/45 corpus planner records are empty; exactly one token-bearing record per turn, per-turn values; in a multi-step turn the token-bearing record can be the turn's early planner record while the turn-final reply record carries none); an errored turn shows `status:"ERROR"` + `error` on its failing record; an executor-level failure (e.g. auth/quota death at request time) can leave a transcript with ONLY the `USER_INPUT` record; `transcript.jsonl` carries ~4KB `truncated_fields` content prefixes, with `transcript_full.jsonl` (same vocabulary, full values) + `chunks/` as store siblings — Freshell reads `transcript.jsonl`.

Two structures the candidate schema invented are retained ONLY as explicitly-labeled fake-contract test extensions (NO real referent — real transcripts carry none of these): the `session_start` ownership record (the locator's cwd/ownership anchor; real transcripts carry no ownership or workspace evidence, so transcript-driven identity binding does not engage on real-format sessions — recorded limitation) and the `turn_settled` settle record (the attention machinery's settle signal — real transcripts carry none; recorded limitation). Both extensions carry the real-shaped field discipline (`created_at`, `step_index`) so the corrected `(created_at, step_index)` dedupe is exercised end to end.

---

### Task 1: Probe the real provider contract (acquire a pinned `agy` or record the blocker)

**Files:**
- Modify: `docs/plans/2026-10-29-google-cli-first-class-support.md` (Provider Contract Record rows only)
- Create: `/home/dan/code/freshell/.worktrees/.the-usual-logs/google-cli-plan/reports/contract-probe.md` (evidence log, outside the tracked tree)

**Interfaces:**
- Consumes: the documented URLs in the Provider Contract Record.
- Produces: updated Contract Record statuses (Task 2/3 flags decisions cite this); possibly sanitized launch evidence (version/help output). No product code.

- [ ] **Step 1: Research the distribution mechanism (read-only)**

Web-fetch https://antigravity.google/docs/cli/reference/ , https://antigravity.google/docs/install/?tab=cli , and https://antigravity.google/docs/cli/headless/ . Record: the exact install mechanism for Linux, the latest stable version string, and whether a non-interactive artifact (downloadable tarball/package with checksum) exists. Write findings to the evidence log.

- [ ] **Step 2: Attempt an isolated acquisition (bounded, disposable)**

The documented non-interactive path (validated at the docs layer, Contract Record): the public per-platform release manifest JSON carries `version`/`url`/`sha512` per platform; fetch the Linux manifest, download the tarball into a disposable prefix (e.g. `/tmp/opencode/agy-probe/`; NEVER a global install, NEVER `~/.local`/npm-global, NEVER touching `~/.gemini` or any user config), verify the SHA512 against the manifest, unpack, and run `<prefix>/agy --version` and `<prefix>/agy --help` with `HOME=/tmp/opencode/agy-probe-home` (disposable home). Record the exact version string. RISK (Contract Record): the binary self-updates in the background — re-run `--version` at the end of the probe and record whether it changed; treat a changed version as evidence the probe's flag findings may be version-drifted. If any step fails or the manifest is unreachable, record that and stop — the blocker stands.

- [ ] **Step 3: Validate the launch contract against the binary (only if Step 2 succeeded)**

From `--help`/`--version` output, confirm or correct each documented flag: `--model`, `--effort`, `--mode`, `-i`/`--prompt-interactive`, `-p`, `--conversation`. Record the exact spelling of each. Record the `--effort` value enumeration shown (docs say it is model-dependent — never hardcode an enum in Freshell; the manifest template passes user values through). Do NOT attempt login, model calls, or any authenticated operation (paid/interactive probes stay opt-in per the Accepted tradeoffs), and do NOT let the probe run long enough for a background self-update to invalidate the record.

- [ ] **Step 4: Update the Provider Contract Record**

Flip statuses only for facts now validated against the real binary (e.g. flags row: `blocked` → `documented+validated (<version>, <date>, <help excerpt>)`). If acquisition failed, append one line to each affected row: "blocked: no non-interactive artifact available as of <date>". Self-review the record for honesty: no status may claim more than the evidence shows.

- [ ] **Step 5: Commit the record update**

```bash
git add docs/plans/2026-10-29-google-cli-first-class-support.md
git commit -m "docs(plan): record antigravity contract-probe evidence"
```

**Note:** This is an investigation task; there is no Red step (nothing is executed by product code). The deliverable is the honest record. If flags were corrected in Step 3, Task 3's manifest templates follow the corrected spellings; if the binary was unobtainable, Tasks 2–14 proceed on the documented candidate contract with the blocker recorded (exactly what the Accepted tradeoffs authorize).

---

### Task 2: Register the `antigravity` extension end to end

**Files:**
- Create: `extensions/antigravity/freshell.json`
- Modify: `crates/freshell-server/src/extensions.rs:588-601` (bundled-names test), `src/components/icons/provider-icons.tsx` (icon + map), `src/components/settings/CodingAgentsSettings.tsx:25-34` (AGENT_ROWS), `crates/freshell-terminal/src/registry.rs:2161-2165` (`is_agent_mode`) and its test list at `registry.rs:13032`, `README.md:209` (env-var table), `shared/coding-cli-defaults.ts:3` (`DEFAULT_ENABLED_CLI_PROVIDERS` gains `'antigravity'` — fresh installs seed `knownProviders` with discovered names but take `enabledProviders` from the defaults, so WITHOUT this a fresh install never shows the picker tile even with `agy` installed; only existing installs auto-enable via the append-and-enable migration), `crates/freshell-server/src/settings.rs:33` (`default_server_settings()` — the Rust fresh-install default `coding_cli.enabled_providers`, comment explicitly mirrors `DEFAULT_ENABLED_CLI_PROVIDERS`; gains `"antigravity"`), `crates/freshell-server/src/settings_store.rs:222` (legacy-migration `DEFAULTS` const gains `"antigravity"`)
- Test: `crates/freshell-server/src/extensions.rs` (in-file), `test/unit/client/components/icons/provider-icons.test.tsx`, `test/unit/client/components/SettingsView.agent-chat.test.tsx`, `test/unit/client/components/panes/PanePicker.test.tsx`, `test/unit/shared/settings.test.ts` + `test/unit/client/store/settingsSlice.test.ts` (fresh-install default includes antigravity), `crates/freshell-server/src/settings_store.rs` in-file tests (default + legacy migration gain antigravity)

**Interfaces:**
- Consumes: `ExtensionRegistry::scan` (extensions.rs:89), `detect_available_clis` env-var override (extensions.rs:324), `AGENT_ROWS` shape, `PROVIDER_ICONS` map.
- Produces: registered provider `antigravity` with label `Antigravity CLI`, command `agy`, override `ANTIGRAVITY_CMD`; `availableClis.antigravity` derived by the existing PATH probe; fresh-install enablement through `shared/coding-cli-defaults.ts` (`DEFAULT_ENABLED_CLI_PROVIDERS` gains `'antigravity'` — the delta DOES change that file) and its Rust mirrors (`settings.rs` fresh-install default, `settings_store.rs` legacy-migration `DEFAULTS`); existing installs auto-enable via the append-and-enable migration.

- [ ] **Step 1: Write the failing tests**

1. In `crates/freshell-server/src/extensions.rs`, update `all_bundled_manifests_validate_and_register_through_scan` (line 588) — add a red assertion first: the expected list becomes `["amplifier","antigravity","claude","codex","gemini","kimi","opencode"]` (sorted). Run and watch it fail with the missing name.
2. Add to `test/unit/client/components/icons/provider-icons.test.tsx`: assert `PROVIDER_ICONS.antigravity` is defined and renders a distinct testid (`provider-icon-antigravity`), model: `provider-icons.test.tsx:14-40`.
3. Add to `test/unit/client/components/SettingsView.agent-chat.test.tsx`: with `availableClis: { antigravity: true }`, an `Antigravity CLI` switch row renders and toggling writes `codingCli.enabledProviders` (model: lines 92-158).
4. Add to `test/unit/client/components/panes/PanePicker.test.tsx`: with an antigravity registry entry + `availableClis.antigravity: true` + enabled, a picker tile labelled `Antigravity CLI` renders and is keyboard-activatable (model: lines 277-366).

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-server --bin freshell-server extensions && pnpm run test:vitest run test/unit/client/components/icons/provider-icons.test.tsx test/unit/client/components/SettingsView.agent-chat.test.tsx test/unit/client/components/panes/PanePicker.test.tsx --config config/vitest/vitest.config.ts`

Expected: FAIL — bundled list missing `antigravity`; icon undefined; no settings row; no picker tile.

- [ ] **Step 3: Add the minimal production implementation**

Create `extensions/antigravity/freshell.json` (strict schema — no unknown keys, no nulls):

```json
{
  "name": "antigravity",
  "version": "1.0.0",
  "label": "Antigravity CLI",
  "description": "Google's Antigravity CLI agent",
  "category": "cli",
  "cli": {
    "command": "agy",
    "envVar": "ANTIGRAVITY_CMD"
  },
  "picker": {
    "group": "agents"
  }
}
```

In `src/components/icons/provider-icons.tsx`: add a mono-color `AntigravityIcon` (pattern: `GeminiIcon` at lines 61-73) — a four-pointed star distinct from Gemini's, e.g. `<path d="M12 2c.9 4.06 3.04 7.2 6.9 8.6-3.86 1.4-6 4.54-6.9 8.6-.9-4.06-3.04-7.2-6.9-8.6C8.96 9.2 11.1 6.06 12 2Z"/><path d="M18.5 14.5c.45 2.03 1.52 3.6 3.45 4.3-1.93.7-3 2.27-3.45 4.3-.45-2.03-1.52-3.6-3.45-4.3 1.93-.7 3-2.27 3.45-4.3Z"/>` with `viewBox="0 0 24 24"`, `fill="currentColor"`, `data-testid="provider-icon-antigravity"`; add `antigravity: AntigravityIcon` to `PROVIDER_ICONS` (line 236). In `CodingAgentsSettings.tsx` add `{ kind: 'cli', id: 'antigravity', label: 'Antigravity CLI', icon: AntigravityIcon }` to `AGENT_ROWS` (import the icon). In `crates/freshell-terminal/src/registry.rs` add `"antigravity"` to the `is_agent_mode` closed list (line 2162) and to the test list at line 13032 — antigravity turns must not be idle-reaped. In `README.md` env-var table add `| ANTIGRAVITY_CMD | No | Antigravity CLI command override |`. In `shared/coding-cli-defaults.ts` add `'antigravity'` to `DEFAULT_ENABLED_CLI_PROVIDERS`; mirror it in the Rust fresh-install default for `codingCli.enabledProviders` and in the settings_store.rs:222 legacy-migration `DEFAULTS` const. Add settings tests pinning both: the TS fresh-install default list (`test/unit/shared/settings.test.ts`) and the Rust settings-store default + legacy-migration rows.

Deliberately NOT done here (each gated on its own task): `resumeArgs`/`modelArgs` (Task 3), any naming/identity/activity list (Tasks 6–9), MCP injection (no arm — unknown modes already get no injection), `is_session_provider_mode` (Task 7 decides), managed rows (Task 14).

- [ ] **Step 4: Run the focused tests**

Run: same command as Step 2. Expected: PASS.

- [ ] **Step 5: Refactor while green**

Check for duplication only (icon pattern is already shared); none expected. Explicitly verify the picker shortcut behavior: antigravity sets no `picker.shortcut`, so its tile defaults to `'A'` colliding with amplifier — cosmetic (first-match-wins); leave as-is and record in the task report.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: extension scan/settings auto-discovery (`cargo test -p freshell-server --bin freshell-server settings_store`), icon consumers (`test/unit/client/components/icons/PaneIcon.test.tsx`, `test/unit/client/deck/provider-icon-svg.test.ts`, `test/unit/client/deck/tile-renderer.test.ts`), settings hydration (`test/unit/shared/settings.test.ts`), launch goldens referencing bundled manifests (`cargo test -p freshell-platform --lib cli_launch`).

Run: `cargo test -p freshell-server --bin freshell-server extensions && cargo test -p freshell-server --bin freshell-server settings_store && cargo test -p freshell-platform --lib cli_launch && pnpm run test:vitest run test/unit/client/components/icons/ test/unit/client/deck/provider-icon-svg.test.ts test/unit/client/deck/tile-renderer.test.ts test/unit/shared/settings.test.ts test/unit/client/store/settingsSlice.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS (the new manifest must not break any golden — it has no templates yet).

- [ ] **Step 7: Commit the task**

```bash
git add extensions/antigravity/freshell.json crates/freshell-server/src/extensions.rs src/components/icons/provider-icons.tsx src/components/settings/CodingAgentsSettings.tsx crates/freshell-terminal/src/registry.rs README.md shared/coding-cli-defaults.ts crates/freshell-server/src/settings.rs crates/freshell-server/src/settings_store.rs test/unit/client/components/icons/provider-icons.test.tsx test/unit/client/components/SettingsView.agent-chat.test.tsx test/unit/client/components/panes/PanePicker.test.tsx test/unit/shared/settings.test.ts test/unit/client/store/settingsSlice.test.ts
git commit -m "feat(antigravity): register Antigravity CLI extension"
```

---

### Task 3: Launch correctly — manifest templates + argv proof

**Files:**
- Modify: `extensions/antigravity/freshell.json` (add templates), `crates/freshell-platform/src/cli_launch_goldens.rs` (new goldens), `crates/freshell-ws/tests/` (new integration test file `antigravity_launch_e2e.rs`)
- Test: `crates/freshell-platform/src/cli_launch_goldens.rs`, `crates/freshell-ws/tests/antigravity_launch_e2e.rs`

**Interfaces:**
- Consumes: `CliCommandSpec` templates (`resumeArgs` first-occurrence `{{sessionId}}`, `modelArgs`/`effortArgs` replace-all, `cli.args` static — cli_launch.rs:34-61, 366-381); `resolve_coding_cli_command` generic provider branch (cli_launch.rs:414-432, 491-505); WS fake-executable harness (`tests/common/mod.rs` `sleeper_cli_spec`, `auto_resume_e2e.rs` `write_executable`).
- Produces: manifest `resumeArgs: ["--conversation","{{sessionId}}"]`, `modelArgs: ["--model","{{model}}"]`, `effortArgs: ["--effort","{{effort}}"]`, `supportsModel: true`, `supportsEffort: true`, and NO static `args` (round 6: the argv probes proved bare `agy` is the interactive default and a fixed bare `-i` exits 2 on every launch — the originally planned `"args": ["-i"]` shipped in the first delta and was removed by the round-6 fix; see the Provider Contract Record). (If Task 1 corrected flag spellings, use those.)

- [ ] **Step 1: Write the failing tests**

Goldens (in `cli_launch_goldens.rs`, model: `gemini_env_injection_passes_through_command_env` at 1052 and amplifier goldens at 1128-1243):

```rust
// (Round 6: this step's original text pinned `-i`; the argv probes
// disproved it — see the Provider Contract Record. The shipped golden is
// `antigravity_fresh_launch_is_bare_interactive_by_default`, which pins
// the BARE argv plus the probed-binary contract validator.)
#[test]
fn antigravity_fresh_launch_is_bare_interactive_by_default() {
    let launch = resolve_for_manifest_spec("antigravity", inputs("antigravity", None, LaunchIntent::Start))
        .expect("registered");
    assert_eq!(launch.command, "agy");
    assert!(launch.args.is_empty()); // bare `agy` — the interactive default
    assert!(!launch.args.iter().any(|a| a == "-p"));
}

#[test]
fn antigravity_resume_uses_conversation_flag_adjacent_pair() {
    let launch = resolve_for_manifest_spec("antigravity",
        inputs("antigravity", Some("conv-1234"), LaunchIntent::Resume)).expect("registered");
    let i = launch.args.iter().position(|a| a == "--conversation").expect("resume flag");
    assert_eq!(launch.args[i + 1], "conv-1234");
    assert!(!launch.args.iter().any(|a| a == "--continue"));
}

#[test]
fn antigravity_model_and_effort_templates_apply() { /* fresh launch + settings model "m"/effort "e" ⇒ argv contains --model m and --effort e, in the settings segment */ }

#[test]
fn antigravity_env_var_command_override_wins() { /* env ANTIGRAVITY_CMD=/custom/agy ⇒ command == /custom/agy */ }
```

(Adapt helper names to the file's existing spec/inputs helpers; the golden file's `specs()` mirrors shipped manifests, so the new manifest fields flow automatically once the manifest is edited — write the assertions against a manifest-loaded spec the way amplifier's `amplifier_manifest_matches_legacy_cli_block` reads the real file.)

WS integration (new `crates/freshell-ws/tests/antigravity_launch_e2e.rs`, model: `auto_resume_e2e.rs` `counting_crashing_claude_spec` + `resume_validation_gate.rs` argv capture): spawn the real server with an `antigravity` spec whose executable is an `#!/bin/sh` script appending its argv to a capture file; create a terminal with `mode: "antigravity"` over raw WS; then create with `session_ref {provider:"antigravity", session_id:"conv-9"}`; assert both argv rows (round 6: BARE fresh — no `-i`, no `--conversation`; the originally asserted `-i` would exit 2 on the probed binaries): fresh row is empty and carries no `--conversation`; resume row contains the adjacent pair `--conversation` `conv-9`; and an unknown-mode create (`mode: "antigravityy"`) answers `Invalid terminal mode` with `antigravity` in the valid list.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-platform --lib cli_launch && cargo test -p freshell-ws --test antigravity_launch_e2e`

Expected: FAIL — no `--conversation`/`--model` in argv (manifest has no templates yet); the WS resume row lacks `--conversation`. (Round 6: the original text also expected a missing `-i`; the probed binaries require a prompt VALUE for `-i`, so the shipped manifest pins NO static args.)

- [ ] **Step 3: Add the minimal production implementation**

Edit `extensions/antigravity/freshell.json` (Task 1 spellings; documented spellings if Task 1 was blocked):

```json
{
  "name": "antigravity",
  "version": "1.0.0",
  "label": "Antigravity CLI",
  "description": "Google's Antigravity CLI agent",
  "category": "cli",
  "cli": {
    "command": "agy",
    "envVar": "ANTIGRAVITY_CMD",
    "resumeArgs": ["--conversation", "{{sessionId}}"],
    "modelArgs": ["--model", "{{model}}"],
    "effortArgs": ["--effort", "{{effort}}"],
    "supportsModel": true,
    "supportsEffort": true
  },
  "picker": { "group": "agents" }
}
```

No resolver changes: the generic branch already applies templates in segment order `[remote, provider, base, settings, resume]`; `cli.args` rides `base`. Missing executable surfaces through the existing ENOENT wrapper (`wrap_terminal_spawn_error`, terminal.rs:8814) whose message names `ANTIGRAVITY_CMD` — add one golden assertion for that message in the WS test if not already covered generically.

- [ ] **Step 4: Run the focused tests**

Run: same as Step 2. Expected: PASS.

- [ ] **Step 5: Refactor while green**

None expected — manifest-only. Confirm `client_entry` now reports `supportsResume: true` and `resumeCommandTemplate: ["agy","--conversation","{{sessionId}}"]` to the client (derived, extensions.rs:296-301) — assert via the extensions scan test from Task 2 if not already.

- [ ] **Step 6: Run impacted-test verification**

Impacted: all launch goldens (`cargo test -p freshell-platform --lib`), extension scan (`cargo test -p freshell-server --bin freshell-server extensions`), client resume-command rendering (`test/unit/client/lib/coding-cli-utils.test.ts` — add a case: antigravity registry entry renders `agy --conversation <id>`; registry entry wins, no builtin fallback).

Run: `cargo test -p freshell-platform --lib && cargo test -p freshell-server --bin freshell-server extensions && pnpm run test:vitest run test/unit/client/lib/coding-cli-utils.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add extensions/antigravity/freshell.json crates/freshell-platform/src/cli_launch_goldens.rs crates/freshell-ws/tests/antigravity_launch_e2e.rs test/unit/client/lib/coding-cli-utils.test.ts
git commit -m "feat(antigravity): launch templates with exact --conversation resume"
```

---

### Task 4: Native history part 1 — home, layout, parser, candidate fixtures

**Files:**
- Create: `crates/freshell-sessions/src/parse/antigravity.rs`, `crates/freshell-sessions/tests/antigravity_fixture_parity.rs`, `test/fixtures/coding-cli/antigravity/fresh.sanitized.jsonl`, `test/fixtures/coding-cli/antigravity/resumed.sanitized.jsonl`, `test/fixtures/coding-cli/antigravity/tool-use.sanitized.jsonl`, `test/fixtures/coding-cli/antigravity/errored.sanitized.jsonl`, `test/fixtures/coding-cli/antigravity/zero-turn.sanitized.jsonl`, `test/fixtures/coding-cli/antigravity/two-same-dir.sanitized.jsonl`, `test/fixtures/coding-cli/antigravity/malformed-tail.sanitized.jsonl`
- Modify: `crates/freshell-sessions/src/parse/mod.rs` (module + re-export), `crates/freshell-sessions/src/lib.rs` (re-export), `crates/freshell-sessions/src/provider_layout.rs` (AntigravityLayout + tests)
- Test: the new parity test + in-file parser/layout tests

**Interfaces:**
- Consumes: `ParsedSessionMeta` (meta.rs:51 — `session_id`, `cwd`, `created_at`, `last_activity_at`, `first_user_message`, `token_usage: Option<TokenSummary>`, `message_count`), codex parser structure (parse/codex.rs:273-533), `ProviderLayout` trait (provider_layout.rs:34), the codex multi-base watch pattern (provider_layout.rs:148-170).
- Produces: `pub fn parse_antigravity_session_content(content: &str) -> Option<ParsedSessionMeta>` (`None` when no ownership record yields an id — the R10b-style exclusion); `pub struct AntigravityLayout;` impl `ProviderLayout` whose `home` parameter is the ALREADY-RESOLVED antigravity home (codex pattern: `CodexLayout::session_root(home) = home.join("sessions")` treats the passed home as the provider root — `antigravity_home()` must NOT be re-applied inside the layout, or the watcher double-expands to `~/.gemini/antigravity-cli/.gemini/antigravity-cli/brain`): `name() = "antigravity"`, `session_root(home) = home.join("brain")`, **`watch_bases(home) = [home.to_path_buf(), home.join("brain")]` with `watch_mode_for_base` NonRecursive on the home + Recursive on `brain`** (codex `[home, sessions, archived]` pattern — a single-base spec would never arm an existing `brain/`), `qualifies(path)` = file named `transcript.jsonl` with an ancestor chain `brain/<conversationId>/.system_generated/logs/`, and a **`watch_change_scope` override** returning `Some(File)` for qualifying transcripts, `Some(Provider)` for any other path under `brain/` (whole-delta review round 5, Major 2: a fresh conversation's directory cascade precedes its transcript write and the inotify cascade miss can suppress the file event, so the brain-root directory event must provider-dirty the index for a prompt reconcile — the amplifier-default discipline bounded to the brain root), and `None` for everything outside `brain/` (so `cache/last_conversations.json` churn never marks the provider dirty; codex override model provider_layout.rs:167-196). `pub fn antigravity_home(home: &Path) -> PathBuf` (env `FRESHELL_ANTIGRAVITY_HOME` used as-is — amplifier precedent amplifier.rs:57 — else `home.join(".gemini").join("antigravity-cli")`; NEVER bare `~/.gemini`) is applied ONLY at the wiring seams: `AntigravitySource::new`, the `WatchedProvider` home, and the existence `provider_roots` — never inside the layout.

- [ ] **Step 1: Write the failing tests**

Create the fixture corpus first (each file exercises the candidate schema; `fresh.sanitized.jsonl` in full):

```jsonl
{"type":"session_start","conversationId":"11111111-2222-3333-4444-555555555555","workspacePaths":["/home/u/proj"],"model":"gemini-3-pro","startedAt":"2026-10-29T20:00:00.000Z"}
{"type":"user_message","conversationId":"11111111-2222-3333-4444-555555555555","text":"Fix the flaky test","at":"2026-10-29T20:00:01.000Z"}
{"type":"assistant_message","conversationId":"11111111-2222-3333-4444-555555555555","text":"Fixed the test.","at":"2026-10-29T20:00:05.000Z","usage":{"inputTokens":10,"outputTokens":20,"cachedTokens":0,"totalTokens":30}}
{"type":"turn_settled","conversationId":"11111111-2222-3333-4444-555555555555","at":"2026-10-29T20:00:05.500Z","outcome":"completed","fullyIdle":true}
```

Variants: `resumed` (same conversationId, an extra `session_start` with `"source":"resume"` — parser keeps first id, no double-count), `tool-use` (extra unknown-typed records `{"type":"tool_call",...}` between user and assistant — ignored, message_count still counts non-empty lines), `errored` (`turn_settled` `outcome:"errored"`), `zero-turn` (ownership record only — id + cwd known, empty first_user_message), `two-same-dir` (two conversation ids, same workspacePaths), `malformed-tail` (one garbage line, one truncated final line — both skipped; valid prefix parsed).

Then `antigravity_fixture_parity.rs` (model: `codex_fixture_parity.rs`), asserting per fixture: session_id, cwd, created_at/last_activity_at folds (min/max over semantic records only: session_start/user_message/assistant_message/turn_settled), first_user_message, title derivation from the first user message (via `extract_title_from_message`, 200 chars), `token_usage` mapping with missing-usage ⇒ `None` (zero-turn), and `message_count` = non-empty line count. Plus in-file parser unit tests: malformed-line tolerance, unknown-record tolerance, multi-workspace `workspacePaths` (primary = first recorded), and `None` for content with no extractable conversationId. Plus layout tests in `provider_layout.rs`'s `mod tests` (model: codex set at 290-534): `name`, `session_root`, `qualifies` accept/reject shapes (`brain/<id>/.system_generated/logs/transcript.jsonl` yes; `brain/<id>/notes.md` no; `cache/last_conversations.json` no), the TWO-base watch spec (`watch_bases` returns home AND brain; per-base mode NonRecursive/Recursive), the `watch_change_scope` override (transcript → `Some(File)`, other `brain/` descendants → `Some(Provider)`, `cache/last_conversations.json` write → `None`), and `antigravity_home` env override (use the `HOME_ENV_TEST_TEST_LOCK` pattern, lib.rs:42-49).

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-sessions antigravity`

Expected: FAIL — no `antigravity` module (compile error is the red here: the missing behavior is the absent parser/layout). If preferred, stub empty files first and watch the assertions fail instead of the build.

- [ ] **Step 3: Add the minimal production implementation**

`parse/antigravity.rs` (core; follow codex's per-line `serde_json::from_str` + `continue`, unknown records ignored, `// Stage-1 candidate contract:` header comment):

```rust
pub fn parse_antigravity_session_content(content: &str) -> Option<ParsedSessionMeta> {
    let mut meta = ParsedSessionMeta::default();
    let mut have_id = false;
    let mut have_cwd = false;
    let mut first_user: Option<String> = None;
    let mut summary: Option<String> = None;
    let mut count = 0i64;
    for line in content.split('\n') {
        let line = line.trim_end_matches('\r');
        if line.is_empty() { continue; }
        count += 1;
        let Ok(obj) = serde_json::from_str::<serde_json::Value>(line) else { continue }; // malformed ⇒ skip
        let conv = obj.get("conversationId").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
        match obj.get("type").and_then(|v| v.as_str()) {
            Some("session_start") => {
                if !have_id { if let Some(id) = conv { meta.session_id = Some(id.to_string()); have_id = true; } }
                if !have_cwd {
                    if let Some(paths) = obj.get("workspacePaths").and_then(|v| v.as_array()) {
                        if let Some(primary) = paths.iter().find_map(|p| p.as_str()) {
                            if looks_like_path(primary) { meta.cwd = Some(primary.to_string()); have_cwd = true; }
                        }
                    }
                }
                fold_ts(&mut meta, obj.get("startedAt"));
            }
            Some("user_message") => {
                let text = obj.get("text").and_then(|v| v.as_str());
                if first_user.is_none() { if let Some(t) = text { first_user = Some(crate::text::normalize_first_user_message(t)); } }
                fold_ts(&mut meta, obj.get("at"));
            }
            Some("assistant_message") => {
                if summary.is_none() { summary = obj.get("text").and_then(|v| v.as_str()).map(|s| s.chars().take(240).collect()); }
                fold_ts(&mut meta, obj.get("at"));
                if let Some(u) = obj.get("usage") { meta.token_usage = parse_antigravity_token_envelope(u).or(meta.token_usage.take()); }
            }
            Some("turn_settled") => { fold_ts(&mut meta, obj.get("at")); }
            _ => {} // unknown record types are ignored
        }
    }
    if !have_id { return None; } // no ownership evidence ⇒ excluded row (R10b-style)
    meta.message_count = count;
    meta.first_user_message = first_user;
    if let Some(f) = &meta.first_user_message {
        meta.title = Some(crate::text::extract_title_from_message(f, 200)); // helper names follow parse/codex.rs:401-427
        meta.title_provider_generated = false;
    }
    meta.summary = summary;
    Some(meta)
}
```

`parse_antigravity_token_envelope` maps `inputTokens/outputTokens/cachedTokens/totalTokens` into `TokenSummary` with plausibility coercion (model: `parse_codex_token_envelope`, parse/codex.rs:184); missing usage stays `None`. `fold_ts` folds `created_at` = min, `last_activity_at` = max over the four semantic record types only (model: parse/codex.rs:303-308). Add `pub mod antigravity;` + re-export in `parse/mod.rs` and `lib.rs:55`. Add `AntigravityLayout` + `antigravity_home` to `provider_layout.rs`.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-sessions antigravity && cargo test -p freshell-sessions --test antigravity_fixture_parity`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Extract the timestamp-fold and title helpers into shared use of `crate::text` if codex's helpers are reusable as-is; otherwise keep local and note the duplication for a later sweep. Rerun the focused tests.

- [ ] **Step 6: Run impacted-test verification**

Impacted: the whole `freshell-sessions` crate (parse/mod provider additions are additive but the crate compiles as one unit) and the pre-push-relevant fixture path (`test/fixtures/**` changes route the pre-push gate to broad cargo — noted, not run here).

Run: `cargo test -p freshell-sessions`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-sessions/src/parse/antigravity.rs crates/freshell-sessions/src/parse/mod.rs crates/freshell-sessions/src/lib.rs crates/freshell-sessions/src/provider_layout.rs crates/freshell-sessions/tests/antigravity_fixture_parity.rs test/fixtures/coding-cli/antigravity/
git commit -m "feat(antigravity): native transcript parser, layout, and candidate fixtures"
```

---

### Task 5: Native history part 2 — source, index wiring, search, server routes

**Files:**
- Create: `crates/freshell-sessions/src/antigravity.rs` (source module, amplifier pattern)
- Modify: `crates/freshell-sessions/src/lib.rs` (`pub mod antigravity;`), `crates/freshell-sessions/src/search.rs:177` (`extract_message` arm + `extract_antigravity_message`), `crates/freshell-server/src/main.rs:164-186` (`build_session_sources`), `crates/freshell-server/src/main.rs:1856-1874` (watcher list), `crates/freshell-server/src/main.rs:2069-2084` (`provider_roots`), `crates/freshell-server/src/existence.rs:42` (`KNOWN_PROVIDERS`), `crates/freshell-server/src/resolve.rs:238` (`KNOWN_RESUME_PROVIDERS`), `crates/freshell-server/src/session_directory.rs:2286` (file-search provider gate), `crates/freshell-ws/src/existence.rs:92` (`NoIndexProbe::default` known-providers mirror — the ws-side existence fallback must answer for antigravity or pane-reconcile mis-adjudicates), `crates/freshell-server/src/session_metadata.rs:54` (session-metadata `VALID_PROVIDERS` — the sessionType write surface rejects unknown providers by default)
- Test: in-file source tests, `session_watcher_tests.rs`-style temp-dir tests, `session_directory.rs`/`resolve.rs`/`existence.rs` in-file route tests

**Interfaces:**
- Consumes: `SessionSource` trait (directory_index.rs:223-332: `discover`, `discover_checked`, `parse`, `provider_name`, default `stat_scoped`), `open_root_dir` (directory_index.rs:355), `item_from_meta` (directory_index.rs:554), `AntigravityLayout` + `parse_antigravity_session_content` + `antigravity_home` (Task 4).
- Produces: `pub struct AntigravitySource { antigravity_home: PathBuf }` with `new(home)`; indexed rows with `source_file: Some(transcript path)` (searchable); `KNOWN_PROVIDERS`/`KNOWN_RESUME_PROVIDERS` gain `"antigravity"` (5 entries); watcher + existence roots registered; file-tier search extracts user/assistant text.

- [ ] **Step 1: Write the failing tests**

1. Source/index (in `antigravity.rs` `mod tests`, model: amplifier.rs in-file tests + `session_watcher_tests.rs:105/161/215`): temp home seeded with two `brain/<id>/.system_generated/logs/transcript.jsonl` files (fixture content) → discover finds both; `parse` maps id/cwd/title/first message/usage and `source_file: Some`; a rename/delete event prunes; a mid-write truncated tail keeps the last valid row — the row survives because the parse SUCCEEDS on the intact prefix (the truncated final line is skipped by the parser), NOT via any "preserve-on-error" rule (the file-backed cache stores `None` when `parse` returns `None` on a changed file, directory_index.rs:2489-2514 — a genuinely id-less or unreadable file DOES drop the row until the next successful sweep, the same behavior class as claude/codex; assert this honestly and require a JSONL `antigravity_parse_failed {path, error}` event on read/parse failure so absence is never silent); a header-less/zero-record transcript is excluded (R10b) while a valid-ownership transcript with an empty first message stays; `discover_checked` returns `Ok(Vec::new())` for a MISSING root (genuinely empty — the signature is `Result<Vec<FileStat>, io::Error>`, there is no `Ok(None)`) and `Err` for an UNLISTABLE root (EACCES/EIO — a recorded scan failure, cache preserved).
2. Search: `search_session_file(path, "antigravity", "flaky", UserMessages)` hits the `user_message` record; `FullText` hits assistant text; extract snippets are case-insensitive.
3. Routes (`session_directory.rs` in-file tests, model: codex route tests at 3962-4233 and `same_raw_session_id_from_different_providers_is_legal` at 5678): with a seeded index, `GET /api/session-directory` lists antigravity rows (title/cwd/first message); `tier=userMessages` search finds the fixture text (proving the provider gate at session_directory.rs:2286 now admits `"antigravity"`); a claude session with the SAME raw id stays distinct (`antigravity:<id>` vs `claude:<id>` keys); resolve route: exact-id input resolves the antigravity row and reports the provider; `unsearchedProviders` honesty when disabled in settings.
4. Existence (`existence.rs` in-file tests, model: 568-1244): warm index → `Present`; absent id → `Absent`; cold index + missing antigravity root → `ProviderUnavailable`; unknown provider still `Absent` (never `Unknown`).

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-sessions antigravity && cargo test -p freshell-server --bin freshell-server session_directory && cargo test -p freshell-server --bin freshell-server resolve && cargo test -p freshell-server --bin freshell-server existence`

Expected: FAIL — source unwired (no rows, no search arm, provider gate skips antigravity, existence unknown-provider).

- [ ] **Step 3: Add the minimal production implementation**

`crates/freshell-sessions/src/antigravity.rs` (amplifier own-file pattern; `// Stage-1 candidate contract:` header):

```rust
pub struct AntigravitySource { antigravity_home: PathBuf }
impl AntigravitySource {
    pub fn new(antigravity_home: PathBuf) -> Self { Self { antigravity_home } }
}
impl SessionSource for AntigravitySource {
    fn discover(&self) -> Vec<FileStat> { self.discover_checked().unwrap_or_default() }
    fn discover_checked(&self) -> Result<Vec<FileStat>, std::io::Error> {
        let root = self.antigravity_home.join("brain");
        match crate::directory_index::open_root_dir(&root)? {
            None => Ok(Vec::new()),
            Some(_) => Ok(crate::directory_index::walk_jsonl_recursive(&root)), // codex recursion model, depth-bounded as in directory_index.rs:678-722
        }
    }
    fn parse(&self, path: &Path) -> Option<IndexedSession> {
        let content = std::fs::read(path).ok().map(|b| String::from_utf8_lossy(&b).into_owned())?;
        let meta = crate::parse::parse_antigravity_session_content(&content)?;
        let mut item = crate::directory_index::item_from_meta("antigravity", &meta, path); // cwd gate inside: meta.cwd required
        item.source_file = Some(path.to_path_buf());
        Some(item)
    }
    fn provider_name(&self) -> Option<&'static str> { Some("antigravity") }
}
```

(Adapt to the real signatures — `item_from_meta`'s actual parameters and `walk_jsonl_recursive` visibility are crate-internal and reusable exactly as codex/amplifier do; keep `source_file: Some`.) Wire `search.rs`: `extract_antigravity_message(obj)` returns user text for `type=="user_message"` (`text` field) and assistant text for `type=="assistant_message"` (model: `extract_codex_message`, search.rs:214-229) + the `"antigravity" =>` arm. Extend the session_directory.rs:2286 gate to `matches!(item.provider.as_str(), "claude" | "codex" | "antigravity")`. Server wiring in `main.rs`: `build_session_sources` adds `Arc::new(AntigravitySource::new(antigravity_home(&home)))`; watcher list adds `WatchedProvider { layout: Box::new(AntigravityLayout), home: antigravity_home(&home) }`; `provider_roots` adds `("antigravity".to_string(), antigravity_home(&h))`. `existence.rs` and `resolve.rs` lists gain `"antigravity"`; the ws-side `NoIndexProbe::default` known-providers mirror (crates/freshell-ws/src/existence.rs:92) gains `"antigravity"`; the session-metadata `VALID_PROVIDERS` (session_metadata.rs:54) gains `"antigravity"` so sessionType writes for antigravity sessions are accepted.

- [ ] **Step 4: Run the focused tests**

Run: same as Step 2. Expected: PASS.

- [ ] **Step 5: Refactor while green**

Check `discover`/`discover_checked` duplication against codex's pair (directory_index.rs:678-728); if a shared recursive-walk helper already exists, use it directly instead of re-wrapping. Rerun.

- [ ] **Step 6: Run impacted-test verification**

Impacted: whole `freshell-sessions`, `freshell-server` route suites touched, watcher behavior, and the settings auto-discovery interplay (`cargo test -p freshell-server --bin freshell-server settings_store`).

Run: `cargo test -p freshell-sessions && cargo test -p freshell-server --bin freshell-server session_directory && cargo test -p freshell-server --bin freshell-server resolve && cargo test -p freshell-server --bin freshell-server existence && cargo test -p freshell-server --bin freshell-server settings_store`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-sessions/src/antigravity.rs crates/freshell-sessions/src/lib.rs crates/freshell-sessions/src/search.rs crates/freshell-server/src/main.rs crates/freshell-server/src/existence.rs crates/freshell-server/src/resolve.rs crates/freshell-server/src/session_directory.rs crates/freshell-ws/src/existence.rs crates/freshell-server/src/session_metadata.rs
git commit -m "feat(antigravity): native session source, search, and server wiring"
```

---

### Task 6: Exact live identity — disk locator, association, MARKER_MODES

**Files:**
- Create: `crates/freshell-sessions/src/antigravity_locator.rs` (codex_locator model), `crates/freshell-ws/src/antigravity_association.rs` (codex_association model)
- Modify: `crates/freshell-sessions/src/lib.rs` (module), `crates/freshell-ws/src/lib.rs` (module + state field), `crates/freshell-ws/src/terminal.rs:209` (`MARKER_MODES`), `crates/freshell-ws/src/auto_resume.rs:19` (`AUTO_RESUME_MODES` 4→5 — crash auto-resume parity with claude/codex/opencode/amplifier), `crates/freshell-ws/src/activity.rs` (association hub wiring point for the sweep, mirroring the codex association sweep), `crates/freshell-server/src/main.rs:2746-2759` (boot sweep registration beside claude/opencode), `crates/freshell-protocol/src/session_names.rs` (NamedProvider::Antigravity — prerequisite of this task's naming-bind call), `crates/freshell-protocol/src/native_location.rs` (NativeLocation::Antigravity — same prerequisite)
- Test: `crates/freshell-ws/tests/antigravity_session_rebind.rs` (model: `claude_session_rebind.rs` + `codex_fork_rebind.rs`), in-file locator/association tests

**Interfaces:**
- Consumes: `MARKER_MODES` pending-marker branch (terminal.rs:7250-7300 → `ledger.record_pending`), the codex locator pattern (`codex_locator.rs`: `arm` :231, `note_submit` :279 — snapshots the buffered line strictly BEFORE the Enter byte, `tick` :322 refuse-on-ambiguity, `watch_fork` :470), codex association guards (`codex_association.rs:118-178`: unknown/not-Running/wrong-mode/already-bound rejected, fork watch BEFORE adoption tail), the shared adoption/rebind tail (`codex_identity.rs::adopt_codex_identity` :60-131 / `rebind_codex_identity` :138-238 with A13 live-owner and A8 ledger guards).
- Produces: `AntigravityLocator { arm(terminal_id, cwd), note_submit(terminal_id, line_text, at) — the ASSOCIATION consumes `ActivityEvent::Input` data (the same input stream the activity hub already routes per-terminal; the BEL classifiers in `freshell-activity/signal.rs` show the seam — NOT a codex `note_submit` reuse: that precedent snapshots file paths with no prompt-text buffer, and terminal input arrives as byte chunks with Enter commonly alone), maintaining a per-pane line buffer flushed at the Enter byte (`is_submit_input`-style classification), tick() -> Vec<(terminal_id, conversation_id, transcript_path)> }`. A tick considers ONLY transcripts whose ownership record's `workspacePaths` contain the pane's cwd, whose LATEST user-authored record's text equals the pane's captured submit line (normalized, bounded comparison), AND whose latest record was written at/after that submit (recency window — a transcript whose newest record predates the submit can never match, which is what rejects re-typed old prompts and dead-launch late writes alike). This one rule covers BOTH transitions: a fresh CLI conversation writes its FIRST user record at submit time, and an in-CLI `/resume <existing id>` (Google's documented switch) lands the user's next prompt as the LATEST record of the EXISTING conversation's transcript. Outcomes per tick per pane: exactly one matching candidate that is the pane's current id ⇒ no-op; exactly one matching candidate with a DIFFERENT id ⇒ FIRST-BIND (unbound pane, adopt) or REBIND (bound pane — supersede through the shared rebind tail with the A13 live-owner and A8 ledger guards, `follow_identity_switch`; note `classify_and_mark_resume_target` is opencode-only and is deliberately NOT part of this tail); more than one matching candidate ⇒ REFUSE all and log `antigravity_association_refused {reason:"ambiguous"}` — never a guess (this is also the codex fork-watch analogue for bound panes: the rebind path is the SAME rule, not a separate mechanism). Guard ladder before adoption/rebind: unknown terminal → retain; mode mismatch → discard; then the shared tail's guards, ledger-first `ledger_resolve_identity`, `identity.upsert`, naming bind via `bind_pending_naming` (constructing the `NativeAcquisition` with the antigravity location variant this task adds), `registry.set_meta`, broadcast `terminal.session.associated`. `MARKER_MODES: [&str; 4] = ["codex","opencode","amplifier","antigravity"]`; `AUTO_RESUME_MODES: [&str; 5]` including `"antigravity"` — a crashed antigravity pane auto-respawns with the retained identity's `--conversation <id>` argv (crash parity with the other agent CLIs; the auto-resume lane's no-resumable-identity grace and 2-retry/10s backoff apply unchanged).
- Also produces (moved here from Task 9 so this task's naming-bind call compiles and its tests pass — the protocol enums are prerequisites of the adoption tail): `NamedProvider::Antigravity` (wire string `"antigravity"`, `display_label() == "Antigravity CLI"`) in `crates/freshell-protocol/src/session_names.rs:23-50` and `NativeLocation::Antigravity { home: String, conversation_id: String, transcript_path: Option<String> }` in `crates/freshell-protocol/src/native_location.rs:21-61` (closed enum — `bind_pending` at naming.rs:875 carries the acquisition location, so the verified durable bind cannot exist without the variant; serde camelCase per its siblings), each with an in-file round-trip/pin unit test. Task 9 consumes these variants; it does not add them.

**Design decision (recorded per the identity report's honest finding):** there is no per-launch generation token on any existing terminal-CLI signal path; antigravity follows the claude/codex residual-risk profile (liveness + provider-match + A13 live-owner + A8 ledger + retired-pane guards) rather than inventing new generation machinery. A respawned pane re-seeds identity at create; late events from a dead launch evaluate against the new row and are rejected by those guards. This matches every shipped provider; the residual risk is recorded here and in the task report.

- [ ] **Step 1: Write the failing tests**

New `crates/freshell-ws/tests/antigravity_session_rebind.rs` (one multi-phase tokio test, model: `claude_session_rebind.rs` / `codex_fork_rebind.rs`; fake agy = `#!/bin/sh` script writing the fixture-format transcript for a fixed id then sleeping):
1. create antigravity pane with cwd A → Enter (submit "first prompt for A") → fake writes `brain/<id1>/` transcript whose first user record is that text → sweep adopts: pane leaf gains `sessionRef {provider:"antigravity", sessionId:id1}` (frames `terminal.session.associated`); a transcript with a DIFFERENT first-user text in the same cwd is never adopted by pane A.
2. true-concurrency separation: a second pane in the SAME cwd A submits its own distinct nonce BEFORE pane A's tick adopts — both panes' locators see both transcripts, and content matching adopts each pane's own conversation (pane A → id1, pane B → id2); no cross-bind. THEN the honest-refusal case: a third fresh pane in cwd A submits a prompt text IDENTICAL to a concurrently-appearing unbound transcript's latest-user text twice over (or replays the same text) ⇒ the locator refuses (no adoption, `antigravity_association_refused {reason:"ambiguous"}` logged) — never a guess. Also: re-typing a PREVIOUS prompt (text identical to an OLD transcript's latest user record) does NOT adopt that old transcript — the recency window rejects records older than the submit.
3. in-CLI switch, both documented forms: (a) `/switch:` mints a NEW conversation and the pane's next prompt lands as its latest user record → rebind: sessionRef becomes id3, supersede recorded, naming follows (`follow_identity_switch`), the OLD id stays bound-elsewhere-safe (a third pane targeting id1 gets a live-owner refusal). (b) `/resume <existing id>` — the fake switches the active transcript to the EXISTING conversation's `brain/<id>/` and the pane's next prompt is appended as that transcript's LATEST user record → rebind to the existing id (Google's documented in-CLI conversation switch; new-directory-only evidence could never catch it). Both forms assert: sessionRef updated to the NEW id and the old id never resurrected after exit.
4. restart: `server.restart()` (same home) → the restored pane resumes with the adjacent `--conversation <id>` argv (fake echoes resumed marker) and identity persists.
5. zero-turn pane (created, no submit): no sessionRef, no association frame.
6. late-event rejection: pane C submits (adopts id4), its process dies, the pane respawns fresh (no resume id); a transcript write for a NEW conversation carrying pane C's OLD prompt text (the dead launch's late write) is NOT adopted by the respawned row (content mismatch + baseline), while the respawned pane's own subsequent submit with its own text adopts its own new conversation.
7. crash auto-resume parity: a bound pane whose process crashes mid-turn auto-respawns (within the auto-resume lane's grace/backoff) with the ADJACENT `--conversation <bound id>` argv — the crash did not silently start a fresh conversation; the crash turn rings the unified attention edge exactly once.

- [ ] **Step 2: Run the tests and verify the intended failure**

This suite kills its own spawned fake-CLI processes and exercises crash respawn — a process-kill suite, so it runs inside the disposable Docker sandbox, never bare on the host (repo rule; the killed processes are only the suite's own tempdir children, per the `RustServer` ownership contract):

Run: `scripts/sandbox-test.sh "cargo test -p freshell-ws --test antigravity_session_rebind"`

Expected: FAIL — `antigravity` not in MARKER_MODES, no locator/association modules (no adoption happens; the sessionRef assertions fail).

- [ ] **Step 3: Add the minimal production implementation**

Add `"antigravity"` to `MARKER_MODES` (terminal.rs:209, base `[&str; 3]` growing to 4, doc comment updated: antigravity resolves via the disk locator) and to `AUTO_RESUME_MODES` (auto_resume.rs:19, base `[&str; 4]` growing to 5). Add the protocol prerequisites: `NamedProvider::Antigravity` (session_names.rs) and `NativeLocation::Antigravity { home, conversation_id, transcript_path }` (native_location.rs, serde camelCase), each with an in-file unit test. Create `antigravity_locator.rs` in freshell-sessions (codex_locator module shape, `// Stage-1 candidate contract:` header; candidate discovery via `AntigravityLayout` root, reading each transcript's ownership record and its LATEST user-authored record with the record's timestamp — bounded file-head/tail reads, extract conversationId + workspacePaths + latest-user text + latest-record time). Create `antigravity_association.rs` in freshell-ws (codex_association module shape): arm at create (antigravity mode, non-managed); a per-pane line buffer fed from `ActivityEvent::Input` bytes (the hub already routes per-terminal input data — the same stream the activity trackers classify), capturing the line content at the Enter byte (`is_submit_input`-style submit classification); `drain_and_associate` rejecting unknown terminal / mode mismatch, then the shared adoption tail — provider-parameterized reuse of the codex tail's guard ladder (A13 `registry.live_session_owner`, A8 `find_by_session_including_retired`, ledger-first `ledger_resolve_identity`, `identity.upsert`, naming bind via `bind_pending_naming` constructing the antigravity `NativeAcquisition`, `registry.set_meta`, broadcast `terminal.session.associated`). Candidate selection = cwd-in-workspacePaths + LATEST-user-record text == captured submit line + latest-record-at/after-submit, with the same-id no-op / first-bind / rebind / refuse-on-ambiguity outcomes exactly as specified in Interfaces. Register the boot sweep beside main.rs:2746-2759 (channel-deferred like the amplifier association, activity.rs:654). JSONL log events: `antigravity_identity_bound`, `antigravity_identity_rebound`, `antigravity_association_refused {reason}`.

- [ ] **Step 4: Run the focused tests**

Run: `scripts/sandbox-test.sh "cargo test -p freshell-ws --test antigravity_session_rebind"` plus the non-destructive in-file units on host: `cargo test -p freshell-ws --lib antigravity && cargo test -p freshell-sessions antigravity_locator && cargo test -p freshell-protocol --lib session_names && cargo test -p freshell-protocol --lib native_location`. Expected: PASS.

- [ ] **Step 5: Refactor while green**

If the shared adoption tail cannot be provider-parameterized without touching codex paths, keep a thin antigravity-specific tail that CALLS the same helpers (naming bind, ledger resolve) — do not fork duplicated guard logic beyond the minimum; note any residual duplication in the report.

- [ ] **Step 6: Run impacted-test verification**

Impacted: identity module units (`cargo test -p freshell-ws --lib identity`), the codex/opencode association suites (shared helpers touched: `cargo test -p freshell-ws --lib codex_association && cargo test -p freshell-ws --lib opencode_signal`), the session-rebind siblings — kill/crash suites, sandboxed (`scripts/sandbox-test.sh "cargo test -p freshell-ws --test codex_fork_rebind"` and the same for `claude_session_rebind`), the protocol enum tests (`cargo test -p freshell-protocol --lib session_names native_location`), and `resume_validation` (marker list changed: `cargo test -p freshell-ws --test resume_validation_gate`).

Run: `cargo test -p freshell-ws --lib identity && cargo test -p freshell-ws --lib codex_association && cargo test -p freshell-ws --lib opencode_signal && cargo test -p freshell-ws --lib antigravity && cargo test -p freshell-protocol --lib session_names && cargo test -p freshell-protocol --lib native_location && scripts/sandbox-test.sh "cargo test -p freshell-ws --test codex_fork_rebind" && cargo test -p freshell-ws --test resume_validation_gate`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-sessions/src/antigravity_locator.rs crates/freshell-sessions/src/lib.rs crates/freshell-ws/src/antigravity_association.rs crates/freshell-ws/src/lib.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/src/auto_resume.rs crates/freshell-ws/src/activity.rs crates/freshell-protocol/src/session_names.rs crates/freshell-protocol/src/native_location.rs crates/freshell-server/src/main.rs crates/freshell-ws/tests/antigravity_session_rebind.rs
git commit -m "feat(antigravity): disk-locator identity binding with rebind guards"
```

---

### Task 7: Exact resume plumbing — by-id existence, REST mapping, honest gate deferral

**Files:**
- Create: `crates/freshell-server/src/antigravity_existence_by_id.rs` (or extend `existence_by_id.rs` — follow the file's existing layout)
- Modify: `crates/freshell-server/src/existence.rs` (extend `IndexExistenceProbe`: new antigravity locator field + builder parameter + by-id lookup arm beside the codex-specific branch at :434-455), `crates/freshell-ws/src/resume_validation.rs` (passthrough pin), `crates/freshell-freshagent/src/terminal_tabs.rs:155-160` (`is_session_provider_mode` — add antigravity), `crates/freshell-server/src/main.rs` (wire the by-id locator into the extended probe, model: codex at main.rs:2125-2127), `crates/freshell-sessions/src/resume_input.rs` + `shared/resume-input-parser.ts` (advisory COMMAND_HINTS rows) + `test/fixtures/resume-input/parser-cases.json` (fixture rows FIRST — both twins consume it)
- Test: `resume_validation.rs` in-file tests, `crates/freshell-ws/tests/resume_validation_gate.rs` extension, `terminal_tabs.rs` in-file tests

**Interfaces:**
- Consumes: `SessionExistenceProbe` and its by-id locator pattern — NOTE the current by-id branch is codex-specific (`existence.rs:434-455`): the plan requires extending `IndexExistenceProbe` with an antigravity locator field + builder parameter + lookup arm (model the codex field/builder/wiring exactly), which `main.rs` then populates with the new locator (codex wiring model at main.rs:2125-2127); `accepted_session_ref_for_mode` (terminal_tabs.rs:110-115, provider-generic), the resume-gate policy vocabulary (resume_gate.rs) WITHOUT joining it.
- Produces: a deterministic by-id locator (walk `brain/<id>/.system_generated/logs/transcript.jsonl`: exists+readable ⇒ `Present`; missing dir ⇒ `Absent`; unreadable ⇒ unknown) wired into the extended `IndexExistenceProbe` by-id path — it improves existence answers for pane-reconcile dead-session adjudication and later gate activation; `is_session_provider_mode` includes `"antigravity"` (with the plausibility gate's honest minimum for its opaque ids: non-empty, no whitespace — the gemini/kimi arm) so a caller-supplied provider-matched `sessionRef` promotes into the launch resume path (bare wire-level `resumeSessionId` stays refused at the REST door — unchanged); advisory resume-input hints for `agy`/`antigravity`.

**Decision (load-bearing A2, Global Constraint 4):** antigravity stays OUT of `resume_gate.rs VALIDATED_PROVIDERS`. Gate activation rides on the store-contract claim, which is fixture-validated only; a wrong record schema would make real conversations answer `Absent` and visibly SpawnFresh every restore with a misleading "not found on disk" notice. Until real-binary transcript evidence exists, a stale resume id passes through ungated (gemini-style passthrough) and the CLI's own PROBED behavior surfaces in-pane — honest, never a Freshell-side replacement: the real CLI (argv/PTY probes, v1.4.10 + v1.4.12) prints `warning: conversation "<id>" not found` and continues into a FRESH interactive session (no failure exit; round 7 corrected the earlier "error surfaces in-pane" wording, which contradicted the Provider Contract Record's own receipts), so the pane stays alive under its requested id until its next clean prompt proves the CLI's fresh conversation and rebinds the pane identity to it. The activation criterion is recorded in the Provider Contract Record row "Resume-gate activation".

- [ ] **Step 1: Write the failing tests**

1. `resume_validation.rs`: extend the unvalidated-passthrough pin at :308 with `"antigravity"` — a stale antigravity resume id is NEVER blocked and NEVER SpawnFresh-substituted (mirror the gemini row of the assertion).
2. By-id locator tests (model: existence_by_id.rs suites): seeded `brain/<id>/` ⇒ `Present`; missing id ⇒ `Absent` (only when both index and walk agree); unreadable dir ⇒ unknown/`Proceed`.
3. `resume_validation_gate.rs` extension: create with a sessionRef whose `brain/<id>/` exists → argv contains `--conversation <id>` (ungated passthrough); create with an absent id → the pane still launches with `--conversation <absent id>` (the fake errors visibly; assert the error text surfaces in the pane and NO fresh replacement spawns — `assert_never_captured` on a second spawn).
4. REST/MCP exact-resume routing (the wire facts: kata ejh6 — a bare `resumeSessionId` field in `POST /api/tabs` is REFUSED at the REST door-top; `is_session_provider_mode` + `plausible_resume_session_id` promote only ids derived from an accepted `sessionRef`): `terminal_tabs.rs` in-file test — `POST /api/tabs` with `mode:"antigravity"` + `sessionRef {provider:"antigravity", session_id:"conv-1"}` accepts the ref (provider-matched) and the created tab's restore/launch carries the resume id; a sessionRef with a MISMATCHED provider (`provider:"gemini"`) is refused for an antigravity pane (the never-alias rule at the door); a bare `resumeSessionId` body keeps the existing refusal (pin it so the plan never relies on the dead path). Client-mapping unit tests: `test/unit/cli/commands.test.ts` + `test/unit/mcp/` — the CLI/MCP client maps a `--resume conv-1` (or `resume` param) with mode antigravity to a POST body carrying `sessionRef {provider:'antigravity', sessionId:'conv-1'}` (model the claude/kilroy mapping tests).
5. Resume-input parser: add `agy`/`antigravity` COMMAND_HINTS rows + parity fixture rows in `test/fixtures/resume-input/parser-cases.json` FIRST, then both twins.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-ws --lib resume_validation && cargo test -p freshell-ws --test resume_validation_gate && cargo test -p freshell-freshagent --lib terminal_tabs && cargo test -p freshell-sessions resume_input`

Expected: FAIL — no by-id locator (Present cases fail), no `is_session_provider_mode` entry, no hint rows, passthrough pin missing the antigravity row.

- [ ] **Step 3: Add the minimal production implementation**

Add the by-id locator; extend `IndexExistenceProbe` with the antigravity locator field, builder parameter, and by-id lookup arm (modeled on the codex branch, existence.rs:434-455) and wire the locator in `main.rs` (codex model at 2125-2127). Add `"antigravity"` to `is_session_provider_mode` (terminal_tabs.rs:156) and to the plausibility gate's opaque-id arm. Add the passthrough pin row in `resume_validation.rs` tests. Add the advisory hint rows (fixture file FIRST, then `resume_input.rs` + `shared/resume-input-parser.ts`). Do NOT touch `VALIDATED_PROVIDERS`.

- [ ] **Step 4: Run the focused tests**

Run: same as Step 2. Expected: PASS.

- [ ] **Step 5: Refactor while green**

Check the by-id locator against the amplifier/codex locators for a shareable "deterministic path probe" helper; keep the antigravity one thin. Rerun.

- [ ] **Step 6: Run impacted-test verification**

Impacted: `resume_input` parity (fixture moved first), `existence`/`resolve` route tests, the REST create-path suites, and the launch e2e from Task 3.

Run: `cargo test -p freshell-sessions resume_input && cargo test -p freshell-server --bin freshell-server existence && cargo test -p freshell-server --bin freshell-server resolve && cargo test -p freshell-freshagent --lib terminal_tabs && cargo test -p freshell-ws --test antigravity_launch_e2e && pnpm run test:vitest run test/unit/shared/resume-input-parser.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-server/src/antigravity_existence_by_id.rs crates/freshell-server/src/main.rs crates/freshell-freshagent/src/terminal_tabs.rs crates/freshell-ws/src/resume_validation.rs test/fixtures/resume-input/parser-cases.json crates/freshell-sessions/src/resume_input.rs shared/resume-input-parser.ts crates/freshell-ws/tests/resume_validation_gate.rs
git commit -m "feat(antigravity): exact-resume plumbing with honest gate deferral"
```

---

### Task 8: Activity, turn completion, and attention

**Files:**
- Create: `crates/freshell-activity/src/antigravity.rs` (pure tracker + record classification), the transcript-tail read helper in the same module (amplifier `tailer` pattern)
- Modify: `crates/freshell-activity/src/lib.rs` (module + `TrackerEffect` reuse), `crates/freshell-ws/src/activity.rs` (Created/Input/Output/Exit dispatch arms :1106/:1247/:1341/:1436, inotify lane ownership modeled on the amplifier lane :16/:122-129, `*_frames` mapper, `next_deadline` aggregation, `attach_antigravity_association` seam from Task 6), `crates/freshell-ws/src/lib.rs`/state wiring, the turn-complete frame's provider enum in BOTH twins (`crates/freshell-protocol` `AgentProvider` and `shared/ws-protocol.ts` `TerminalTurnCompleteSchema.provider` — both currently admit only claude/codex/opencode/amplifier; without the `antigravity` member the frame cannot be minted correctly), the new activity record in BOTH twins (`freshell-protocol` + `shared/ws-protocol.ts`, model: the amplifier record), `src/store/antigravityActivitySlice.ts` (model: an existing activity slice) **registered in `src/store/appReducers.ts`**, `src/lib/pane-activity.ts:209` (`TRULY_IDLE_CLI_MODES` + `resolvePaneActivity` branch :150-184), `src/App.tsx` (frame ingestion dispatching into the new slice, model: the amplifier activity record fold), and every existing consumer that reads the sibling activity records — survey with ripgrep where `codexActivityByTerminalId`/`claudeActivityByTerminalId`-shaped records flow (pane activity resolution, sidebar status tiers `src/store/selectors/sessionStatusTiers.ts`, tab-registry busy keys/busySessionKeys stamping) and wire the antigravity record into each (an unregistered slice or an unwired consumer means the busy state never reaches the UI)
- Test: in-file tracker tests (`crates/freshell-activity`), hub tests (`crates/freshell-ws --lib activity`), client vitest (`pane-activity.test.ts`, `turnCompletionSlice.test.ts`), and the Task 6 rebind suite's activity phases

**Interfaces:**
- Consumes: `TrackerEffect` enum (lib.rs:41-57: `Changed`/`TurnComplete`/`ForceRead`/`AttentionBoundary`), `TurnCompletionLedger` (completion_seq), `IdleGate` (`IDLE_GRACE_MS = 2_000`, `terminal.idle` reason enum `grace|queue-empty` — closed, do not extend), the amplifier lane wiring (inotify watcher + offset lanes + `attach_amplifier_association`, activity.rs:114-129/:408-425), `terminal.turn.complete` frame minting (activity.rs:2271), death-bell semantics (activity.rs:1389-1420).
- Produces: `AntigravityActivityTracker` — `note_record(record)` from the tailer lane: `user_message` ⇒ Busy (a new submit); `turn_settled{fullyIdle:true}` ⇒ exactly one `TurnComplete` (deduped per settle); `turn_settled{fullyIdle:false}` ⇒ stay Busy (outstanding async work — invocation completion is NOT turn completion); `turn_settled{outcome:"errored"}` ⇒ `TurnComplete` (attention is outcome-uniform); deadman `ANTIGRAVITY_BUSY_DEADMAN_MS = 120_000` ⇒ `ForceRead` (re-read latest transcript records; a found settle completes, else stays busy). The tailer reads ONLY the pane's bound transcript (from Task 6's bound path — never the last-conversations cache). `supports_turn_signal` stays claude|codex only (antigravity is NOT a BEL mode; no `turn-complete-signal` change, no `normalizeTurnCompleteSignalMode` change). Client: busy/blue resolves from the new activity record; `terminal.idle` drives attention via the existing mode-agnostic `recordTerminalIdle` path once the server mints it.

- [ ] **Step 1: Write the failing tests**

1. Tracker units (in `antigravity.rs`): submit-then-settle ⇒ Busy then exactly one TurnComplete with monotonic completion_seq; `fullyIdle:false` settle ⇒ no TurnComplete, still Busy; errored settle ⇒ TurnComplete; deadman fires ForceRead after 120 s quiet while busy; untracked terminal ⇒ no effects; exit while busy ⇒ hub death-bell path emits one `terminal.idle` (hub test).
2. Hub tests (`cargo test -p freshell-ws --lib activity`): antigravity Created arms the tracker (add `antigravity_and_gemini_kimi_split` asserting antigravity is tracked while gemini/kimi stay inert — extend `gemini_and_kimi_are_status_inert` :2996); Input submit arms; a scripted settle drives `terminal.turn.complete` then exactly one `terminal.idle{reason:"grace"}` (model: `claude_submit_bel_turn_complete_and_terminal_idle_flow` :2404 but record-fed, not BEL-fed).
3. Client vitest: `pane-activity.test.ts` — antigravity pane resolves BUSY when the activity record exists and IDLE otherwise; `TRULY_IDLE_CLI_MODES` contains antigravity; `turnCompletionSlice.test.ts` unchanged semantics (terminal.idle path is mode-agnostic — add an antigravity record ingestion case); the turn-complete frame's provider schema accepts `antigravity` (protocol parity); AND the projection tests that catch the registration/wiring gaps the reviewer flagged: the new slice is present in the registered reducer state (a store-level test asserting `store.getState().antigravityActivity` exists after dispatch) and the sidebar status-tier/tab-registry busy projections (`sessionStatusTiers` tests + the tab-registry busy-key stamping tests) reflect an antigravity busy record the way they reflect a codex busy record.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-activity antigravity && cargo test -p freshell-ws --lib activity && pnpm run test:vitest run test/unit/client/lib/pane-activity.test.ts test/unit/client/store/turnCompletionSlice.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL — no tracker module; hub `_ => {}` arm leaves antigravity inert; client has no branch.

- [ ] **Step 3: Add the minimal production implementation**

Implement the pure tracker + record classifier in `crates/freshell-activity/src/antigravity.rs` (`// Stage-1 candidate contract:` header — classification is conservative: only `turn_settled` records mint completions). Add the tail-read helper (amplifier `tailer` pattern: attach-at offset, bounded reads, degrade reasons). In the hub: add the four dispatch arms, the per-terminal transcript lane (attach on association — Task 6's `attach_antigravity_association` now binds the lane), the `*_frames` mapper emitting `antigravity.activity.updated`, and `expire_due`/death-bell reuse. Protocol: new `AntigravityActivityUpdated` record in `freshell-protocol` + zod twin in `shared/ws-protocol.ts` (additive). Client: new slice, `resolvePaneActivity` branch, `TRULY_IDLE_CLI_MODES` gains `'antigravity'`, `App.tsx` fold (model: the amplifier record's ingestion path).

- [ ] **Step 4: Run the focused tests**

Run: same as Step 2. Expected: PASS.

- [ ] **Step 5: Refactor while green**

Confirm no BEL code path gained antigravity (`supports_turn_signal` unchanged — add one assertion in `test/unit/shared/turn-complete-signal.test.ts` that antigravity is NOT signal-supported, mirroring the gemini pin at :16-17). Rerun.

- [ ] **Step 6: Run impacted-test verification**

Impacted: all activity suites (`cargo test -p freshell-activity`), the full hub lib suite (`cargo test -p freshell-ws --lib activity`), the rebind suite from Task 6 (association now also binds lanes), the full attention vitest set (`turn-complete-signal`, `turnCompletion*`).

Run: `cargo test -p freshell-activity && cargo test -p freshell-ws --lib activity && scripts/sandbox-test.sh "cargo test -p freshell-ws --test antigravity_session_rebind" && pnpm run test:vitest run test/unit/shared/turn-complete-signal.test.ts test/unit/client/lib/pane-activity.test.ts test/unit/client/store/turnCompletionSlice.test.ts test/unit/client/store/turnCompletionAttention.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-activity/src/antigravity.rs crates/freshell-activity/src/lib.rs crates/freshell-ws/src/activity.rs crates/freshell-ws/src/lib.rs crates/freshell-protocol/src/ shared/ws-protocol.ts src/store/antigravityActivitySlice.ts src/lib/pane-activity.ts src/App.tsx test/unit/shared/turn-complete-signal.test.ts test/unit/client/lib/pane-activity.test.ts
git commit -m "feat(antigravity): transcript-tail activity with turn-completion attention"
```

---

### Task 9: Unified naming across every surface

**Files:**
- Modify: `shared/session-names.ts:20,24-31,221-222,232-240` (`NamedProviderSchema`, `UnifiedAgentModeSchema`, `TERMINAL_UNIFIED_MODES`, `isUnifiedAgentMode`), `src/store/selectors/sessionNameSelectors.ts:64-66` (`isNamedProvider`), `crates/freshell-protocol/src/session_names.rs:23-50` (consume the `NamedProvider::Antigravity` variant landed in Task 6 — verify-only here, extend `display_label` wiring if the variant left any consumer unmatched), `crates/freshell-freshagent/src/naming.rs:264-306` (`TERMINAL_UNIFIED_MODES`, `named_provider_for`), `crates/freshell-freshagent/src/layout_store_content.rs:63-67` (mode label map), `shared/name-evidence.ts:77-96` + `crates/freshell-sessions/src/name_evidence.rs:46-60` (label rows) + `test/fixtures/name-evidence/cases.json` (fixture rows FIRST, both twins consume it), `crates/freshell-server/src/session_metadata.rs` (`KNOWN_SESSION_METADATA_TYPES` gains the antigravity session-type row if the schema requires it), `src/lib/coding-cli-utils.ts` (no change — verify only)
- Test: `test/unit/shared/session-names.test.ts`, `crates/freshell-freshagent` naming in-file tests (:1091-1137), `test/unit/shared/name-evidence.test.ts` + `crates/freshell-sessions/tests/name_evidence.rs`, naming store/selector tests, `crates/freshell-protocol` native_location tests

**Interfaces:**
- Consumes: the pending-handle → durable-bind chain (`admit_pending_projection`/`ensure_pending` naming.rs:588-611; `bind_pending_naming` via Task 6's adoption tail, which already constructs a `NativeAcquisition` with the `NativeLocation::Antigravity` variant landed in Task 6), `NamedProvider` wire enum (variant landed in Task 6), name-evidence label fixtures.
- Produces: antigravity joins the unified ONE-durable-name regime across every consumer (pane header, tab, sidebar row, history row, terminal presentation, API projections); the TS `NamedProviderSchema` widens to accept the variant; native rename WRITEBACK stays honest-`unsupported` (`NativeNameDispatch::backend_for` answers `Unsupported` for the variant — no `NativeNameBackend` adapter, which is the modeled, displayable state; transcript edits forbidden).

- [ ] **Step 1: Write the failing tests**

1. `test/unit/shared/session-names.test.ts`: `isUnifiedAgentMode('antigravity') === true`; `NamedProviderSchema` accepts `'antigravity'`; the scope test at :65 gains antigravity true (and keeps gemini/kimi/amplifier false).
2. `cargo test -p freshell-freshagent naming`: update `unified_agent_scope_matches_exactly_the_six_modes` (:1091 — now seven modes) and `named_provider_answers_the_scoped_provider_only` (:1120 — antigravity maps to `NamedProvider::Antigravity`; gemini still does not).
3. Name-evidence: add fixture rows to `test/fixtures/name-evidence/cases.json` proving an `Antigravity CLI` title is a default label (never name evidence), then run both twins.
4. `src/store/selectors/sessionNameSelectors` tests: pane header/history row resolve the antigravity saved name (`selectSessionRowRecord` no longer drops provider `antigravity`).
5. Store tests: a rename via `PATCH /api/session-names` for `{provider:'antigravity', sessionId}` persists and propagates to tab title mirror (model: `sessionNames.test.ts`, `savedNameTabTitleMirror.test.ts`).

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/shared/session-names.test.ts test/unit/shared/name-evidence.test.ts test/unit/client/store/sessionNames.test.ts --config config/vitest/vitest.config.ts && cargo test -p freshell-freshagent naming && cargo test -p freshell-sessions --test name_evidence`

Expected: FAIL — antigravity out of every list/schema/enum.

- [ ] **Step 3: Add the minimal production implementation**

Widen every list (exact edits): `NamedProviderSchema = z.enum(['claude','codex','opencode','antigravity'])`; `UnifiedAgentModeSchema` + `TERMINAL_UNIFIED_MODES` gain `'antigravity'`; `isNamedProvider` gains the check; naming.rs `TERMINAL_UNIFIED_MODES` (`[&str; 4]`) + `"antigravity" => NamedProvider::Antigravity` arm (the protocol enum variants themselves landed in Task 6 — verify, do not re-add); layout_store_content label `"antigravity" => "Antigravity CLI"`; name-evidence label rows `antigravity`/`antigravity cli` in BOTH twins (fixture file first). The naming-bind lane in Task 6's adoption tail constructs the `NativeAcquisition` with `NativeLocation::Antigravity` on the verified-persistence path; native writeback keeps NO adapter (unsupported is the honest modeled state — the plan forbids transcript edits).

- [ ] **Step 4: Run the focused tests**

Run: same as Step 2. Expected: PASS.

- [ ] **Step 5: Refactor while green**

None expected — list extension. Verify `src/lib/session-names.ts` needs no edit (inherits the shared schema — the wholesale-400 guard now accepts antigravity refs).

- [ ] **Step 6: Run impacted-test verification**

Impacted: all naming suites (shared + Rust twins + store/selector tests + the batched-read 400 guard) and the cross-mode gemini preservation pins.

Run: `pnpm run test:vitest run test/unit/shared/session-names.test.ts test/unit/shared/name-evidence.test.ts test/unit/shared/session-flavor.test.ts test/unit/client/lib/session-names.test.ts test/unit/client/store/sessionNames.test.ts test/unit/client/store/sessionNameLifecycle.test.ts test/unit/client/store/savedNameTabTitleMirror.test.ts test/unit/client/store/storedTabTitleHeal.test.ts test/unit/client/components/UnifiedAgentRename.test.tsx --config config/vitest/vitest.config.ts && cargo test -p freshell-freshagent naming && cargo test -p freshell-server --bin freshell-server session_name`

Expected: PASS (gemini's legacy pins must stay green — gemini is NOT added to any unified list).

- [ ] **Step 7: Commit the task**

```bash
git add shared/session-names.ts src/store/selectors/sessionNameSelectors.ts crates/freshell-protocol/src/session_names.rs crates/freshell-freshagent/src/naming.rs crates/freshell-freshagent/src/layout_store_content.rs shared/name-evidence.ts crates/freshell-sessions/src/name_evidence.rs test/fixtures/name-evidence/cases.json test/unit/shared/session-names.test.ts
git commit -m "feat(antigravity): unified durable naming with native location evidence"
```

---

### Task 10: Contract-faithful fake `agy` fixtures

**Files:**
- Create: `test/e2e-browser/fixtures/providers/fake-agy.mjs` (thin adapter), `test/e2e-browser/fixtures/fake-agy-terminal.mjs` (contract-faithful store-writing fake)
- Modify: `test/e2e-browser/specs/harness-03-provider-fixtures.spec.ts` (provider loop row + resume argv shape)
- Test: the harness-03 spec rows; helper unit tests colocated if any helper is added

**Interfaces:**
- Consumes: HARNESS-03 engine (`fixture-core.mjs`, `terminal-cli.mjs` with `detectLaunch` override seam), the fake-codex-terminal contract shape (`fake-codex-terminal.mjs`: argv log, Enter-anchored store write, resume verification, race gate).
- Produces: a fake `agy` that (a) records argv to `FAKE_AGY_TERMINAL_ARGV_LOG` JSONL; (b) on first Enter mints `conversationId = crypto.randomUUID()` and writes `$HOME/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl` in the candidate schema (first line the ownership record), plus `cache/last_conversations.json` (so specs can prove Freshell NEVER resumes from it); (c) per stdin line: busy marker → append user+assistant records → bare BEL + `turn done.` → appends `turn_settled{fullyIdle:true}`; a line matching `/^async:/` appends `turn_settled{fullyIdle:false}` (no completion); `/^switch:/` mints a NEW conversation dir and subsequent prompts append there (new-conversation rebind path); `/^resume:<id>$/` switches the active transcript to the EXISTING `brain/<id>/` (non-zero exit with a greppable error if missing) and subsequent prompts append there as the latest user records (the documented in-CLI switch to a previous conversation — required for the Task 6 existing-conversation rebind test); `/^explode:/` exits mid-turn; `/^approval:/` renders a greppable approval prompt; a nonce after `remember:` is echoed on later turns (resume-content proof); (d) `--conversation <id>` resume: missing `brain/<id>/` ⇒ non-zero exit with greppable error, else `agy: resumed conversation <id>` and transcript continues; (e) optional `FAKE_AGY_STORE_GATE_PATH` race gate (copy fake-codex:195-208).

- [ ] **Step 1: Write the failing test**

Add the antigravity rows to `harness-03-provider-fixtures.spec.ts` (provider list + resume argv `--conversation <id>` shape, model: lines 64, 102-111). Run: `pnpm run test:e2e --local --project=chromium test/e2e-browser/specs/harness-03-provider-fixtures.spec.ts` — Expected: FAIL (no fake-agy adapter).

- [ ] **Step 2: Implement the fixtures**

`fake-agy.mjs` (adapter, model: fake-gemini.mjs but with `detectLaunch` handling `--conversation`/`--session-id`); `fake-agy-terminal.mjs` (model: fake-codex-terminal.mjs line-for-line with the store layout above). Wire the harness-03 rows.

- [ ] **Step 3: Run the focused test**

Run: same as Step 1. Expected: PASS.

- [ ] **Step 4: Refactor while green**

Share nothing new with codex's fake beyond the existing engine; keep the fake hermetic (env allowlist discipline from fixture-core so credentials can never leak).

- [ ] **Step 5: Run impacted-test verification**

Impacted: the harness-03/06 fixture specs (full files) and the e2e helper unit lane.

Run: `pnpm run test:e2e --local --project=chromium test/e2e-browser/specs/harness-03-provider-fixtures.spec.ts test/e2e-browser/specs/harness-06-misc-fixtures.spec.ts && pnpm run test:e2e:helpers`

Expected: PASS.

- [ ] **Step 6: Commit the task**

```bash
git add test/e2e-browser/fixtures/providers/fake-agy.mjs test/e2e-browser/fixtures/fake-agy-terminal.mjs test/e2e-browser/specs/harness-03-provider-fixtures.spec.ts
git commit -m "test(antigravity): contract-faithful fake agy fixtures"
```

---

### Task 11: Browser spec — launch (picker, REST, CLI/MCP, errors, gemini preserved)

**Files:**
- Create: `test/e2e-browser/specs/google-cli-launch-rust.spec.ts`
- Test: the spec itself (cloud-legal: deterministic fakes, no wall-clock-sensitive waits)

**Interfaces:**
- Consumes: `RustServer` fixture (per-test server, `env: { ANTIGRAVITY_CMD: <fake>, GEMINI_CMD: <fake-gemini.mjs> }`, `setupHome` seeding `codingCli.enabledProviders: ['antigravity','gemini']` — model: `codex-terminal-restore-rust.spec.ts:59-198`), `openPanePicker`, `harness.getTerminalBuffer`, `harness.getPaneLayout`, `postJsonRetry429`, `installFakeCli` copy-then-chmod pattern, `fake-agy-terminal.mjs` argv log.
- Produces: proof of requirement 1 + the launch half of requirement 6.

- [ ] **Step 1: Write the spec (red)**

Scenarios (all in one spec, per-test servers): picker shows and launches `Antigravity CLI` (tile → directory combobox → leaf `content.mode === 'antigravity'`, buffer shows `agy> `); REST `POST /api/tabs {mode:'antigravity', cwd}` creates a pane; argv log asserts the BARE interactive shape (no prompt-taking `-i` — round 6), `-p` absent, `--model m` only when a model setting was configured; `ANTIGRAVITY_CMD=/nonexistent/agy` create answers a visible error mentioning `ANTIGRAVITY_CMD` with NO pane and no silent shell fallback; CLI client `new-tab --mode antigravity` (mirror `test/unit/cli/commands.test.ts` POST shape — assert the request body in the CLI unit test if the e2e lane is local-only); gemini preservation: a gemini pane still launches via `GEMINI_CMD` fake and its legacy behavior is unchanged.

Run: `pnpm run test:e2e --local --project=chromium test/e2e-browser/specs/google-cli-launch-rust.spec.ts` — Expected: FAIL at the first antigravity assertion before Task 2-3 land (with them landed it should pass; write it after Task 3 in sequence so red comes from the spec's own gaps: e.g. run it red against a server booted WITHOUT the extension seeded to see honest failure, then green with it).

- [ ] **Step 2: Make it green**

No product changes expected (Tasks 2-10 already landed); fix spec bugs only. Expected: PASS locally.

- [ ] **Step 3: Verify cloud legality**

Confirm the spec is NOT in `CLOUD_SKIP_SPECS` (it should not need to be — deterministic fakes, generous polls) and run it on the configured backend: `pnpm run test:e2e --cloud --project=chromium test/e2e-browser/specs/google-cli-launch-rust.spec.ts` (sharded run covers it; verify nonzero execution in the report). Expected: PASS on cloud.

- [ ] **Step 4: Impacted-test verification**

New-spec parse gate: create `test/e2e-browser/tsconfig.google-cli-spec-parse-check.json` per the `tsconfig.<slug>-spec-parse-check.json` convention, including `specs/google-cli-launch-rust.spec.ts` (Tasks 12/13 append their specs to this include list), then `pnpm exec tsc -p test/e2e-browser/tsconfig.google-cli-spec-parse-check.json`. Expected: zero error lines attributed to the included specs.

- [ ] **Step 5: Commit the task**

```bash
git add test/e2e-browser/specs/google-cli-launch-rust.spec.ts test/e2e-browser/tsconfig.google-cli-spec-parse-check.json
git commit -m "test(antigravity): browser launch spec incl. gemini preservation"
```

---

### Task 12: Browser spec — history, search, exact resume across restart

**Files:**
- Create: `test/e2e-browser/specs/google-cli-history-resume-rust.spec.ts`

**Interfaces:**
- Consumes: Task 10 fake (store writes, nonce recall, missing-store error), `server.restart()` (same home/port/token), session-directory HTTP routes, sidebar/history selectors, `WsCapture` where frames matter.

- [ ] **Step 1: Write the spec (red)**

Scenarios: two concurrent panes in the SAME cwd submit distinct nonces → each leaf gains its own `sessionRef {provider:'antigravity'}` with distinct ids; `/api/session-directory` lists both (right cwd/title/first message); a `userMessages`-tier search hits the normalized conversation (not raw JSON grep); stop the owned fixture process → pane `exited`, identity retained; `server.restart()` → the restored pane respawns with the ADJACENT argv pair `--conversation <sessionId>` and the fake echoes the remembered nonce on a second turn (continued content, not just id match); `--continue` NEVER appears in any captured argv; zero-turn pane restores FRESH (no sessionRef, no resume argv); delete `brain/<id>/` under the isolated HOME → resume attempt surfaces the fake's missing-store error distinctly (no replacement conversation).

- [ ] **Step 2: Run and verify**

Run: `pnpm run test:e2e --local --project=chromium test/e2e-browser/specs/google-cli-history-resume-rust.spec.ts` — Expected: PASS after Tasks 4-7 (red first for any gap they left). Then cloud: `pnpm run test:e2e --cloud --project=chromium test/e2e-browser/specs/google-cli-history-resume-rust.spec.ts` — Expected: PASS, nonzero cases. Append the spec to `test/e2e-browser/tsconfig.google-cli-spec-parse-check.json` and rerun `pnpm exec tsc -p test/e2e-browser/tsconfig.google-cli-spec-parse-check.json` — Expected: zero errors.

- [ ] **Step 3: Commit the task**

```bash
git add test/e2e-browser/specs/google-cli-history-resume-rust.spec.ts test/e2e-browser/tsconfig.google-cli-spec-parse-check.json
git commit -m "test(antigravity): browser history and exact-resume spec"
```

---

### Task 13: Browser spec — identity, activity, attention, naming agreement

**Files:**
- Create: `test/e2e-browser/specs/google-cli-identity-activity-rust.spec.ts`

**Interfaces:**
- Consumes: `WsCapture` (frames `terminal.session.associated`, `terminal.turn.complete`, `terminal.idle`), the Task 10 fake's async/switch/explode/approval commands, naming helpers (`expectSharedName` from `helpers/unified-agent-names.ts`), Task 8's activity record, Task 9's naming surfaces.

- [ ] **Step 1: Write the spec (red)**

Scenarios: association frame after the store write binds identity; busy while a turn runs; exactly one `terminal.turn.complete` + one `terminal.idle{reason:'grace'}` per settled turn; `/async:` turn (settle without fullyIdle) → NO completion, busy persists, follow-up settle completes once; scripted approval prompt → waiting treatment (if the waiting edge is not implemented for terminal antigravity panes, assert the honest broader state and record it — do not fake evidence); `/resume:` to an EXISTING conversation and `/switch:` to a new one both rebind: sessionRef updates to the new id and stale old-launch writes are rejected (no second association for the old id); duplicate settle records replayed by the fake → no double completion, one bell; `/explode:` mid-turn crash → the unified attention edge rings once AND the pane auto-respawns with the adjacent `--conversation <bound id>` argv (crash parity pinned in Task 6 — assert both); naming: pane header, tab title, sidebar row, and history row agree after reload, and manual Rename wins (antigravity is in the unified store — explicitly NOT the gemini legacy pin).

- [ ] **Step 2: Run and verify**

Run: `pnpm run test:e2e --local --project=chromium test/e2e-browser/specs/google-cli-identity-activity-rust.spec.ts` — Expected: PASS after Tasks 6/8/9. Cloud: `pnpm run test:e2e --cloud --project=chromium test/e2e-browser/specs/google-cli-identity-activity-rust.spec.ts` — Expected: PASS, nonzero cases. Append the spec to `test/e2e-browser/tsconfig.google-cli-spec-parse-check.json` and rerun `pnpm exec tsc -p test/e2e-browser/tsconfig.google-cli-spec-parse-check.json` — Expected: zero errors.

- [ ] **Step 3: Commit the task**

```bash
git add test/e2e-browser/specs/google-cli-identity-activity-rust.spec.ts test/e2e-browser/tsconfig.google-cli-spec-parse-check.json
git commit -m "test(antigravity): browser identity/activity/naming spec"
```

---

### Task 14: Managed-runtime row (honest blocked state), real-provider smoke, docs

**Files:**
- Modify: `crates/freshell-agent-runtime/src/lib.rs:107-254` (`PROVIDER_CAPABILITIES` antigravity row) and its fail-closed tests (2420/2466-2478 — antigravity NOT added to deferred/certified lists), `crates/freshell-ws/src/terminal.rs:3768-3784` (manifest parity test), `docs/development/runtime-provider-capabilities.json` (mirror row + NOT in `deferredProviders`), `README.md` (provider row + limitations), `docs/index.html` (picker mock gains an Antigravity tile if the mock shows provider tiles), `AGENTS.md` (one-line link note already present — verify)
- Create: `test/integration/real/antigravity-launch-smoke.test.ts`
- Test: `cargo test -p freshell-agent-runtime --locked`, the smoke (environment-optional), runtime gate classification

**Interfaces:**
- Consumes: the `ProviderCapability` schema (lib.rs:75-102), the gemini row as the disabled template (lib.rs:218-235), the amplifier smoke's three-tier gating (`amplifier-launch-smoke.test.ts:24-64`), `scripts/testing/provider-certification.ts` classification (not_applicable rows outside managed scope).
- Produces: an `antigravity` capability row in the fully disabled state — `certification_state: NotApplicable` (today), `qualification_ready: false`, `managed_enabled: false`, `durable_recovery_enabled: false`, `recovery_paths: &[]`, `managed_modes: &["antigravity"]`, `execution_boundary: "legacy-extension"`, `identity_capture: "terminal locator (candidate contract; managed identity unimplemented)"`, `state_store: "$HOME/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl (candidate)"`, `resume_command: None` (no managed claim), `zero_turn_policy: "no-continuity-claim"`, `checkpoint_policy: "none"`, `bootstrap: "extension-owned"`, `live_gate: "not-enabled"`, `blocked_reason: Some("BLOCKED_RECOVERY_IMPLEMENTATION")`. The qualification spec, `QUALIFIABLE_TERMINAL_PROVIDERS`, Docker image pin, `ProviderPreparation`/secret/bootstrap arms, and any managed doorway are explicitly NOT added — they are the named blocker chain gated on Task 1's real-binary evidence + a live qualification receipt (per the first draft's gate 5). The smoke: version probe always-runs when `agy` (or `ANTIGRAVITY_CMD`) is on PATH, skip-never-fail otherwise; the headless tier is double-gated (`FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1` + antigravity key) and never runs in default CI.

- [ ] **Step 1: Write the failing tests**

1. `cargo test -p freshell-agent-runtime --locked`: add a red test `antigravity_row_is_fully_blocked_and_not_applicable` asserting the row's fields exactly as above AND that `deferred`/`certified_durable` lists are UNCHANGED (`["claude","codex","amplifier"]` / `["opencode"]`) and `qualification_policy` rejects `"antigravity"` (model: the gemini rejection test at qualification_policy.rs:95-111).
2. `crates/freshell-ws/src/terminal.rs` manifest parity test: `managed_runtime_mode("antigravity") == false` follows the mirror row.
3. Docs mirror parity test (`checked_in_manifest_publishes_the_same_certification_states`) — add the mirror row to the fixture the test reads (`docs/development/runtime-provider-capabilities.json`) with `certificationState: "not_applicable"`.
4. Smoke skeleton red: `test/integration/real/antigravity-launch-smoke.test.ts` with a version-probe assertion against a stub binary via `ANTIGRAVITY_CMD` (proves the probe logic without the real CLI).

- [ ] **Step 2: Run and verify the intended failure**

Run: `cargo test -p freshell-agent-runtime --locked && cargo test -p freshell-ws --lib managed_modes_follow`

Expected: FAIL — no row.

- [ ] **Step 3: Add the minimal production implementation**

Add the row (fields above) to `PROVIDER_CAPABILITIES`; add the docs-mirror row; update `README.md` with the provider row, `ANTIGRAVITY_CMD` (already added in Task 2 — verify), and a limitations paragraph (candidate contracts, no managed execution, no hook installation, native rename unsupported, real-binary validation pending); `docs/index.html` picker mock gains the Antigravity tile only if provider tiles are mocked there. Implement the smoke per the amplifier three-tier pattern with `ANTIGRAVITY_CMD` resolution.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-agent-runtime --locked && cargo test -p freshell-ws --lib managed_modes_follow && FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 pnpm run test:vitest run test/integration/real/antigravity-launch-smoke.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS (smoke skips with a clear reason when no binary).

- [ ] **Step 5: Refactor while green**

None — static row + docs. Verify the runtime gate classifier treats the row as outside managed scope: `pnpm run test:vitest run test/runtime/gates/provider-certification.test.ts --config config/vitest/vitest.config.ts` (PC gates must not demand a receipt for a not_applicable row).

- [ ] **Step 6: Run impacted-test verification**

Impacted: the supervisor qualification-scope test (`crates/freshell-supervisor/src/service.rs:4212` — antigravity must NOT be in scope), provider inventory (`cargo test -p freshell-agent-runtime provider_inventory` — the inventory list stays 4), and the docs sweep.

Run: `cargo test -p freshell-supervisor --lib service && cargo test -p freshell-agent-runtime`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-agent-runtime/src/lib.rs crates/freshell-ws/src/terminal.rs docs/development/runtime-provider-capabilities.json README.md docs/index.html test/integration/real/antigravity-launch-smoke.test.ts
git commit -m "feat(antigravity): blocked managed row, real-provider smoke, docs"
```

---

## Verification and completion gates

1. Per task: the focused commands above, red first, green after, impacted set rerun.
2. End of execution: run the broad gate from the implementation worktree:
   `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_RUST_TEST_SANDBOX=1 FRESHELL_VITEST_BACKEND=cloud FRESHELL_E2E_BACKEND=cloud FRESHELL_TEST_SUMMARY='the-usual google-cli plan full-suite gate' pnpm run check`
   Pass criterion: the suite is GREEN at the final HEAD. A failure that reproduces at base_ref with a ledger-recorded pre-existing receipt is first RETRIED after the run (flakes are load-sensitive and the receipt shows this one passing in isolation); if it recurs, the repo's flake policy applies — diagnose and fix the flaky test within the run rather than excusing it. Only if the flake fix is demonstrably out of this run's reach does the recap carry it as an explicit unresolved blocker with the reproduction evidence, instead of a pass.
3. The three new browser specs must pass with nonzero case counts on the configured cloud backend — full stop; a `CLOUD_SKIP_SPECS` entry does not satisfy this gate and is NOT a fallback. They must be written cloud-legal (deterministic fakes, poll-based assertions, generous timeouts, no wall-clock-sensitive waits): unlike the existing provider-lifecycle skips (which time REAL CLI boot behavior), these specs drive deterministic fixtures, so timing fragility is a spec bug to fix in the spec, never a skip to record. If cloud infrastructure (not the spec) is the failure cause, rerun after the infra issue clears and record the attempt. The runtime qualification spec for antigravity is deliberately NOT created (managed adapter blocked) — this deviation from the first draft's Stage-7 file list is required by the honesty discipline (Global Constraints 4/5) and recorded in the Provider Contract Record.
4. `pnpm run lint` clean ON THE DELTA (a11y rules for the new settings row): this plan's changes must introduce zero new lint findings, and the new `Antigravity CLI` settings row, picker tile, and icon introduce no a11y violations. The repo-WIDE `pnpm run lint` gate was already red at base_ref 4da47fd9a (exit 1: 10 errors + 19 warnings, byte-identical finding sets at base and at this plan's HEAD — verified by running lint at both trees; every finding is pre-existing and outside this plan's scope), so repo-wide exit 0 is not an honest completion criterion for this plan. The pre-existing set is ledger-recorded (progress ledger's baseline-ledger entry, with the per-finding classification evidence); fixing those out-of-scope files is deliberately NOT part of this plan.
5. Commit focused changes per task; push the branch only when the user asks; PR creation requires explicit user approval. The live 3001 server is never restarted by this work (no deploy steps exist in this plan).

## Known limitations this plan deliberately ships (recorded, not hidden)

1. All native-contract behavior (transcript record schema, store authority) is candidate-contract until a real-binary probe validates it; every seam carries a `Stage-1 candidate contract` comment and the README says so. (The transcript PATH, hook inputs, flags, and resume semantics ARE documented+validated at the docs layer — see the Provider Contract Record.)
2. No antigravity hooks are installed anywhere; identity/activity are read-only disk integrations (the hook producer stays a named blocker).
3. Managed execution, durable recovery, qualification, and the runtime image pin for antigravity are NOT built; the capability row fails closed and says why.
4. Native rename writeback is `unsupported` (no proven provider rename operation; transcript edits forbidden).
5. Approval/question distinction is only surfaced to the extent the transcript tailer can prove it; otherwise the broader busy/idle state is shown.
6. The resume gate stays OFF for antigravity (gemini-style passthrough) until real-binary transcript evidence exists: a stale resume id reaches the CLI verbatim, and the probed CLI (v1.4.10 + v1.4.12) prints `warning: conversation "<id>" not found` and continues into a FRESH interactive session (no failure exit); the pane keeps naming the requested id until its next clean prompt, which rebinds the pane to the fresh conversation transparently (round 7: the earlier "its own error surfaces in-pane" wording contradicted the Provider Contract Record's probe receipts). Freshell never substitutes an id of its own. Activation requires the A2 blocker to clear and is a follow-up change, not part of this plan's claims.
7. Store-root resolution (round 7, Major 2 — handled, with a residual): `antigravity_home` resolves `FRESHELL_ANTIGRAVITY_HOME` (as-is) > `<home>/.gemini/antigravity-cli` (when its `brain/` holds conversations) > the snap install's `<home>/snap/antigravity-cli/common/.gemini/antigravity-cli` (the probed snap layout — see the Provider Contract Record's distribution row), and announces the chosen root at boot (`antigravity_store_root_resolved`; total absence logs `antigravity_store_root_missing`). Residual: only the CHOSEN root is watched/indexed, decided at wiring time — a machine whose OTHER root gains its first conversation after boot keeps reading the boot-time root until a restart or `FRESHELL_ANTIGRAVITY_HOME` switches it. A machine whose two roots BOTH hold conversations follows the default.
