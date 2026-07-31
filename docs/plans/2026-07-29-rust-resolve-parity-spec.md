# SYNC-06: Rust server parity for session resume-by-id resolve

## Goal

Deliver the Rust-server half of checklist item **SYNC-06** in
`docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md:803` (the item itself
stays unchecked until its `PW-TAURI-WIN` native-Windows validation, out of scope here,
also lands — see Requirement 8): implement
`POST /api/sessions/resolve` in the **Rust server** (`crates/freshell-server`) with full
behavior parity to the Node implementation, and declare the `sessionResolve` feature flag
from the Rust server so the shared client shows the pinned sidebar Resume button on
Rust/Tauri builds.

The client is SHARED between both servers and must not change behavior-detectably: the
Rust endpoint's JSON must be wire-compatible with what the client already consumes.

## Source of truth (parity references — read these first)

- Contract: `shared/resume-resolve-contract.ts` AT THIS WORKTREE'S HEAD — the HARDENED
  (#586) shape (request `{ input: string, 1..20000, strict }`;
  response `{ status: 'ready'|'warming'|'degraded', matches: ResumeResolveMatch[], hint: {provider, source: 'command'|'word'|'id-shape'}|null, providerErrors: {provider, code?, message?}[], unsearchedProviders: string[], homeDir?: string }`;
  match fields `provider, sessionId, cwd?, sessionType?, title?, firstUserMessage?, lastActivityAt?, matchKind: 'exact'|'prefix'`).
  A failing provider surfaces as `status: 'degraded'` + a `providerErrors` entry — never a
  silent empty "not found". Rust serde must emit the exact same field names (camelCase)
  and types.
- Node behavior: `server/sessions-router.ts` (routing, validation, error shapes/status
  codes, auth) and `server/coding-cli/resolve-session.ts` (matching semantics, ordering,
  result cap, fallbacks).
- Input parsing + hints: `shared/resume-input-parser.ts` (token shapes: full UUIDs any
  case; known `xxx_`-prefixed id families — the NINE prefixes
  `ses|sess|session|thread|thr|run|msg|task|amp` each followed by an 8–64-char
  `[0-9A-Za-z]` suffix (`PREFIXED_ID_RE`), of which `ses_` + 26 base62 is opencode's
  first-class shape [CORRECTED 2026-07-31: this line originally named only the `ses_`
  family]; short hex prefixes 8–32 chars containing ≥1 digit; noise stripping for
  command lines/quotes/prompts; candidate ordering; provider hints from command shapes,
  agent words, and id-shape heuristics).
- Existing Rust infra: the session index and existence machinery in
  `crates/freshell-server/src/existence.rs` (exact-match `IndexExistenceProbe`, opencode
  by-id DB fallback `session_exists_by_id`, Unknown/warming states) and the per-provider
  session sources in `crates/freshell-sessions` (claude/codex/opencode/amplifier).
- Node flag: `server/platform-router.ts` `detectFeatureFlags()` → `sessionResolve: true`.

## Requirements

1. **Endpoint parity.** `POST /api/sessions/resolve` on the Rust server: same path, same
   auth requirements as the Rust server's other API routes, same response schema, and —
   for JSON-object bodies — the same request validation (reject missing/empty/oversized
   `input` and unknown body keys with the same status codes/error shapes the Node
   router uses). [CORRECTED 2026-07-31: the original blanket "same validation and error
   shapes" wording overstated what was required and what landed. Three narrow
   divergences are DELIBERATE and ledgered in the "Accepted deviations" module doc of
   `crates/freshell-server/src/resolve.rs` — all preserve status-code parity, differ
   only in bodies/routing unreachable by any known client (the dialog treats any
   non-2xx as request-failed without reading the body): (a) payloads Express's strict
   body parser rejects with an HTML 400 before zod runs (malformed JSON; JSON scalars
   string/number/bool/null) get a zod-shaped JSON 400 from Rust; (b) axum's default
   2 MB body-size limit vs Express `json({limit:'1mb'})`; (c) `PATCH`/`GET
   /api/sessions/resolve` answer 405 on the merged Rust router where Express would
   dispatch `:sessionId="resolve"` to another route. Everything else in this
   requirement is met identically.]
   [ERRATA 2026-07-31: a FOURTH divergence existed unrecorded until the
   Content-Type gating fix — the Rust route parsed the body as JSON regardless of
   `Content-Type`, so a valid object under e.g. `text/plain` resolved on Rust while
   Node's `express.json()` (default `type: 'application/json'`) skips it and 400s
   with the missing-`input` issue; the Rust route now gates parsing on the same
   matcher (parity restored, not ledgered as accepted).]
2. **Parser parity.** Port `shared/resume-input-parser.ts` semantics to Rust exactly:
   token extraction, candidate ordering, and hint derivation must produce the same
   results for the same inputs. To prevent silent drift between the TS and Rust parsers,
   drive both from **shared cross-language test fixtures** (e.g. a committed JSON table
   of input → expected candidates/hint consumed by both the existing TS unit tests and
   the new Rust tests). If the planner finds a materially better anti-drift mechanism,
   use it — the requirement is a single fixture source both implementations must pass.
3. **Matching parity.** Exact + prefix matching across all four providers
   (claude/codex/opencode/amplifier) against the Rust session index; same match ordering
   (most-recent first) and the same result cap as the Node implementation; same
   `matchKind` semantics.
4. **Fallback parity.** The Node side consults exact-id fallbacks on index miss (claude
   transcript locator in `server/coding-cli/claude-transcript-locator.ts`; opencode
   by-id DB query). Investigate what equivalents the Rust side already has (the
   existence machinery has an opencode by-id query; recent zero-turn-claude-existence
   work may cover claude). Reuse what exists; implement what's missing. If a specific
   fallback is genuinely impractical in Rust right now, that is a plan-level decision
   that must be surfaced explicitly with evidence and recorded (checklist + code
   comment), NOT silently omitted — user-visible behavior differences between servers
   are the thing this task exists to eliminate.
5. **Metadata parity.** Matches carry the same metadata the Node side returns (cwd,
   sessionType, title, firstUserMessage, lastActivityAt) with the same optionality —
   the client's resume path needs cwd/sessionType to open the tab correctly.
6. **Warming parity.** When the Rust index is not ready/unknown, return
   `status: 'warming'` with empty matches (same as Node), so the dialog's retry state
   works identically.
7. **Feature flag.** Declare `sessionResolve` in the Rust server's feature-flags payload
   (its equivalent of `detectFeatureFlags()`), so the shared client renders the Resume
   button. Do not gate it on anything else.
8. **Checklist update.** Record the SYNC-06 parity evidence in
   `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md` as a `PARTIAL`
   bullet following the file's existing entry conventions (the SYNC-05/SAFE-11
   precedent), and KEEP the SYNC-06 checkbox UNCHECKED (`- [ ]`): the `PW-TAURI-WIN`
   (native Windows WebView2) half of its named validation is explicitly out of scope
   for this work, so the item cannot be marked done — the bullet must name what is
   green and list `PW-TAURI-WIN` as `MISSING`. (This matches the implementation plan,
   `docs/plans/2026-07-30-rust-resolve-parity-hardened.md` Task 7 Step 4, and the
   checklist's current state. An earlier revision of this requirement said "Mark
   SYNC-06 done", contradicting the out-of-scope declaration above — corrected
   2026-07-31.)

## Verification

- **Rust tests:** unit/integration coverage mirroring
  `test/integration/server/sessions-resolve-router.test.ts` (exact, prefix, ambiguous,
  missing, warming, validation errors, auth) against fixture session stores for all four
  providers. `cargo clippy` clean (CI-gated) and `cargo fmt` clean.
- **Cross-language parity:** the shared parser fixtures (Requirement 2) pass in both the
  TS and Rust test suites.
- **E2E:** enable `test/e2e-browser/specs/resume-button.spec.ts` for the
  **rust-chromium** project — remove the legacy-only routing and the defensive
  "endpoint missing" skip guard added when the Node-only feature landed — and get it
  green on BOTH projects (legacy-chromium and rust-chromium). This is the checklist's
  PW-RUST validation and feeds GATE-01's "no Rust-only skips for a user-visible
  feature" rule.
- **Client suite** stays green (no client changes expected; the flag flip exercises the
  existing button/dialog against the Rust server in e2e).

## Constraints

- Follow AGENTS.md conventions (test coordination via `npm run test:vitest -- …`,
  process safety, worktree/branch model; never commit to main).
- Do not modify the shared client contract (`shared/resume-resolve-contract.ts`) or the
  Node implementation's behavior — this task brings Rust up to them. Refactors that
  extract shared fixtures for tests are fine; behavior changes are not.
- Preserve unrelated uncommitted changes in the main repo working tree (other agents
  are active there); all work happens in a dedicated worktree.
