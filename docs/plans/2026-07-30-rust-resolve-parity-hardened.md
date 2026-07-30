# Rust Resolve-Session Parity with the Hardened (#586) Resume Contract — Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Bring the existing, rebased 16-commit Rust resolve-parity foundation (branch `feat/rust-resolve-parity`) up to the HARDENED resume contract that landed on main in PR #586 (merge `f903e8a6`), so the Rust `POST /api/sessions/resolve` is wire- and behavior-identical to the hardened Node implementation.

**Architecture:** This is an ADOPT-AND-EXTEND delta, not a rebuild. The rebase onto `f903e8a6` is already done (merge-base verified == `f903e8a6`); conflicts were resolved favoring main's hardened TS. The Node code AT THIS WORKTREE'S HEAD is therefore the authoritative truth to mirror: `shared/resume-resolve-contract.ts`, `shared/resume-input-parser.ts`, `server/coding-cli/resolve-session.ts`, `server/coding-cli/resolve-fallbacks.ts`, `server/coding-cli/providers/opencode-by-id-query.ts`, `server/sessions-router.ts` (lines 255–316). The Rust side to extend: `crates/freshell-sessions/src/{resume_input.rs,resume_resolve.rs}`, `crates/freshell-sessions/src/parse/opencode.rs`, `crates/freshell-sessions/src/directory_index.rs`, `crates/freshell-server/src/resolve.rs`, `crates/freshell-server/src/main.rs`. The cross-language fixture `test/fixtures/resume-input/parser-cases.json` is the anti-drift keystone: it gets EXTENDED to the hardened parser behavior and BOTH implementations must pass it (the rebase silently dropped the TS side's fixture consumption — Task 2 restores it).

**Tech Stack:** Rust (axum, serde with `preserve_order`, rusqlite, regex, tokio), TypeScript (Node server, zod 4.3.6, vitest), Playwright e2e matrix (legacy-chromium + rust-chromium).

## Global Constraints

- NEVER touch ports 3001/3002 or any process you did not spawn (production server + live tabs run there). All server testing on ephemeral ports with throwaway HOMEs. Repeat this constraint to any subagent you dispatch.
- The MAIN checkout `/home/dan/code/freshell` has ~15 dirty files + untracked files from OTHER live sessions — never stage, stash, clean, or modify them. ALL work happens in the worktree `/home/dan/code/freshell/.worktrees/rust-resolve-parity` on branch `feat/rust-resolve-parity`.
- TS imports use NodeNext ESM: relative imports carry the `.js` extension.
- Coordinated tests: run `npm run test:status` before any broad vitest run; use `npm run test:vitest -- --config <config> <paths> --run` for focused runs; `cargo test -p <crate>` for Rust.
- Conventional commits, focused and atomic, each with the Amplifier footer:

  ```
  🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

  Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
  ```

- Wire-shape parity constants (copy these EXACT values): `RESOLVE_MATCH_CAP = 20`, `MAX_RESUME_CANDIDATES = 8`, `FALLBACK_BUDGET_PER_REQUEST = 2`, opencode by-id busy timeout `500` ms, known resume providers `["claude", "codex", "opencode", "amplifier"]`, scan-failure message literal `"session scan failed"`.
- `serde_json` has `preserve_order` enabled workspace-wide: struct field order IS wire key order. Field order in Rust wire structs must match the Node object literals.
- README.md is the only end-user markdown doc; this plan and the SYNC-06 checklist/spec under `docs/plans/` are working/agent docs.
- Branch may be pushed to origin at the end (Task 7). NO pull request without explicit user approval.

---

### Task 1: Verify post-rebase reality and the committed spec doc

The rebase resolved TS conflicts favoring main's hardened semantics. Before changing anything, pin down what actually compiles and passes NOW — the failures and drift found here are the worklist the later tasks close. The SYNC-06 spec doc is ALREADY COMMITTED (`docs/plans/2026-07-29-rust-resolve-parity-spec.md`, aligned to the hardened contract during plan review) — verify it, do not re-commit it.

**Files:**
- Read (already committed): `docs/plans/2026-07-29-rust-resolve-parity-spec.md`
- No file changes and NO commit in this task.

**Interfaces:**
- Consumes: the rebased worktree at `feat/rust-resolve-parity` (merge-base == `f903e8a6`).
- Produces: a verified baseline (recorded in this task's completion report; later tasks' commit bodies may cite it): cargo workspace state, which resume suites pass, and the confirmed drift findings listed below.

- [ ] **Step 1: Confirm worktree identity and cleanliness**

Run:
```bash
cd /home/dan/code/freshell/.worktrees/rust-resolve-parity
git branch --show-current && git merge-base HEAD f903e8a6f5e2e0e926890e38c28e775776fec7de && git status --porcelain
```
Expected: branch `feat/rust-resolve-parity`; merge-base prints `f903e8a6f5e2e0e926890e38c28e775776fec7de`; `git status --porcelain` prints NOTHING (clean tree — the spec doc is already committed). If there ARE dirty/untracked files or lock files, STOP and surface it — the worktree is not idle.

- [ ] **Step 2: Rust baseline**

Run (from the worktree root):
```bash
set -o pipefail
cargo test -p freshell-sessions -p freshell-server 2>&1 | tail -20
cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -5
```
(`set -o pipefail` is load-bearing on every piped cargo command in this plan: without it a failing `cargo` exits through `tail`'s success status.)
Expected: all tests pass and fmt/clippy are clean. The Rust side compiled at the old base and the rebase touched no Rust files' dependencies, so a failure here means the rebase broke something — investigate before proceeding (do not "fix forward" blind).

- [ ] **Step 3: TS baseline for the resume suites**

Run:
```bash
npm run test:status
npm run test:vitest -- --config config/vitest/vitest.config.ts test/unit/shared/resume-input-parser.test.ts --run
npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/resolve-session.test.ts test/unit/server/coding-cli/resolve-fallbacks.test.ts test/integration/server/sessions-resolve-router.test.ts --run
```
Expected: ALL PASS (these are main's hardened tests, untouched by the branch).

- [ ] **Step 4: Confirm the drift findings (read, don't fix — fixes are Tasks 2–6)**

Verify each of these against the code; they are the delta worklist:
1. `test/unit/shared/resume-input-parser.test.ts` does NOT read `test/fixtures/resume-input/parser-cases.json` (the rebase kept main's inline version) — the anti-drift keystone is broken on the TS side even though both suites are green.
2. `crates/freshell-sessions/src/resume_input.rs` still has the generic `[a-z]{2,10}_[0-9A-Za-z]{8,40}` prefixed-id regex and NO candidate cap; the hardened TS parser (`shared/resume-input-parser.ts:29,37`) has the known-family regex and `MAX_RESUME_CANDIDATES = 8`.
3. `crates/freshell-sessions/src/resume_resolve.rs` has status `Ready|Warming` only (no `Degraded`), no `providerErrors`, lowercases ALL tokens (ses_ ids must be case-SENSITIVE), does not exclude subagents from prefix discovery, runs the index pass for ALL tokens before ANY fallback (hardened order is per-token exact → fallback → prefix), has no fallback shape gates or per-request budget, and maps fallback read errors to a silent miss (the incident class).
4. `crates/freshell-sessions/src/parse/opencode.rs::opencode_session_directory_by_id` is the OLD #583 parent-walk; hardened Node (`opencode-by-id-query.ts`) is a direct by-id row query (archived + child sessions included, full row returned, errors PROPAGATE).
5. `crates/freshell-server/src/resolve.rs` response is `{status, matches, hint}` only; hardened wire adds `providerErrors`, `unsearchedProviders`, `homeDir` (`server/sessions-router.ts:306-314`), plus scan-failure merge, disabled-provider reporting, and degraded fire-and-forget refresh.

- [ ] **Step 5: Verify the committed spec doc and record the baseline**

Run: `git log --oneline -1 -- docs/plans/2026-07-29-rust-resolve-parity-spec.md`
Expected: one commit line (the spec is tracked, nothing uncommitted). Open the spec and confirm its "Contract" bullet describes the HARDENED response (`ready|warming|degraded`, `providerErrors`, `unsearchedProviders`, `homeDir`) — it was aligned during plan review; if it still describes a `{status, matches, hint}`-only response, STOP and surface it. Record the Step 2–4 baseline findings (workspace state, suite results, confirmed drift list) in this task's completion report. NO commit in this task.

---

### Task 2: Extend the shared parser fixture to the hardened parser; both parsers pass it

The fixture table is the anti-drift mechanism. Extend it to the hardened TS parser's behavior, restore fixture consumption on the TS side, and port the hardened parser rules (known-family prefix regex, candidate cap 8) to Rust. One task because the fixture change necessarily goes red on one side until both parsers agree — the task is done only when BOTH suites are green against the SAME table.

**Files:**
- Modify: `test/fixtures/resume-input/parser-cases.json`
- Rewrite: `test/unit/shared/resume-input-parser.test.ts`
- Modify: `crates/freshell-sessions/src/resume_input.rs`
- Existing (unchanged): `crates/freshell-sessions/tests/resume_input_parser_parity.rs` (already fixture-driven)

**Interfaces:**
- Consumes: `parseResumeInput` / `parse_resume_input` as they exist today.
- Produces: `pub const MAX_RESUME_CANDIDATES: usize = 8` exported from `crates/freshell-sessions/src/resume_input.rs` (Task 3's core relies on the parser capping candidates; nothing else changes in the parser's public signature). TS `MAX_RESUME_CANDIDATES` already exists.

- [ ] **Step 1: Rewrite the TS test to be fixture-driven (this is the failing test)**

Replace the ENTIRE contents of `test/unit/shared/resume-input-parser.test.ts` with:

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseResumeInput, MAX_RESUME_CANDIDATES } from '@shared/resume-input-parser'

interface FixtureCase {
  name: string
  input: string
  candidates: Array<{ token: string; kind: string }>
  hint: { provider: string; source: string } | null
}

const fixturePath = fileURLToPath(
  new URL('../../fixtures/resume-input/parser-cases.json', import.meta.url),
)
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { cases: FixtureCase[] }

describe('parseResumeInput — shared cross-language fixture (SYNC-06 anti-drift)', () => {
  it('fixture is non-trivial', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(31)
  })

  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const parsed = parseResumeInput(testCase.input)
    expect(parsed.candidates).toEqual(testCase.candidates)
    expect(parsed.hint).toEqual(testCase.hint)
  })
})

describe('parseResumeInput — TS-only invariants', () => {
  // The cap VALUE is part of the server work-budget contract; the capping
  // BEHAVIOR is pinned by the fixture's cap case in both languages.
  it('MAX_RESUME_CANDIDATES is 8', () => {
    expect(MAX_RESUME_CANDIDATES).toBe(8)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL (proves the keystone pins the TS parser again)**

Run: `npm run test:vitest -- --config config/vitest/vitest.config.ts test/unit/shared/resume-input-parser.test.ts --run`
Expected: FAIL on exactly one case — `non-ses prefixed id yields no id-shape hint` (`abc_12345678`): the hardened TS parser rejects unknown `abc_` families, so it returns NO candidates while the stale fixture expects one. Every other case passes.

- [ ] **Step 3: Update the fixture to the hardened parser's behavior**

In `test/fixtures/resume-input/parser-cases.json`:

3a. REPLACE the case named `"non-ses prefixed id yields no id-shape hint"` (the `abc_12345678` one) with:

```json
    {
      "name": "arbitrary snake_case prefix is not a known id family",
      "input": "abc_12345678",
      "candidates": [],
      "hint": null
    },
```

3b. APPEND these cases before the closing `]` (after the `"claude -rf ..."` case, adding a comma to that case's closing brace):

```json
    {
      "name": "arbitrary snake_case identifiers never match",
      "input": "my_function123 snake_casedword9",
      "candidates": [],
      "hint": null
    },
    {
      "name": "known thread_ id family",
      "input": "thread_abc123456",
      "candidates": [{ "token": "thread_abc123456", "kind": "prefixed-id" }],
      "hint": null
    },
    {
      "name": "known task_ id family with a long 46-char suffix",
      "input": "task_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V2w3",
      "candidates": [
        { "token": "task_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V2w3", "kind": "prefixed-id" }
      ],
      "hint": null
    },
    {
      "name": "candidates are capped at 8 (server work budget)",
      "input": "417e83450a00 417e83450a01 417e83450a02 417e83450a03 417e83450a04 417e83450a05 417e83450a06 417e83450a07 417e83450a08 417e83450a09 417e83450a10 417e83450a11",
      "candidates": [
        { "token": "417e83450a00", "kind": "hex-prefix" },
        { "token": "417e83450a01", "kind": "hex-prefix" },
        { "token": "417e83450a02", "kind": "hex-prefix" },
        { "token": "417e83450a03", "kind": "hex-prefix" },
        { "token": "417e83450a04", "kind": "hex-prefix" },
        { "token": "417e83450a05", "kind": "hex-prefix" },
        { "token": "417e83450a06", "kind": "hex-prefix" },
        { "token": "417e83450a07", "kind": "hex-prefix" }
      ],
      "hint": { "provider": "amplifier", "source": "id-shape" }
    }
```

(Verification notes for the case authors above, against `shared/resume-input-parser.ts`: `thread_abc123456` has an 9-char suffix within `{8,64}` and no agent word → prefixed-id candidate, no `ses_` prefix → hint null. The 46-char `task_` suffix is within `{8,64}` and beyond the OLD Rust regex's 40 cap. The 12 hex tokens are equal-length so the stable length sort keeps text order; the cap keeps the first 8; top candidate is a hex-prefix → amplifier id-shape hint.)

- [ ] **Step 4: Run the TS suite — expect PASS**

Run: `npm run test:vitest -- --config config/vitest/vitest.config.ts test/unit/shared/resume-input-parser.test.ts --run`
Expected: PASS (all fixture cases + TS-only invariants).

- [ ] **Step 5: Run the Rust parity suite — expect FAIL (the fixture now leads the Rust parser)**

Run: `cargo test -p freshell-sessions --test resume_input_parser_parity`
Expected: FAIL on `arbitrary snake_case prefix is not a known id family` (old generic regex still matches `abc_12345678`), `arbitrary snake_case identifiers never match`, `known task_ id family with a long 46-char suffix` (old regex caps the suffix at 40), and `candidates are capped at 8` (no cap yet).

- [ ] **Step 6: Port the hardened parser rules to Rust**

In `crates/freshell-sessions/src/resume_input.rs`:

6a. Replace the `PREFIXED_ID_RE` definition (and its comment) with:

```rust
// Known xxx_-prefixed id families only (ses_ + 26 base62 is opencode's,
// first-class). Arbitrary snake_case identifiers must NOT match: they would
// rank FIRST and waste resolver passes on non-ids. Mirrors
// `shared/resume-input-parser.ts:37`.
static PREFIXED_ID_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)(?:ses|sess|session|thread|thr|run|msg|task|amp)_[0-9A-Za-z]{8,64}(?-u:\b)")
        .expect("static regex")
});
```

6b. Add the cap constant right below the type definitions (near `ResumeInputParse`):

```rust
/// Work budget: candidates are capped so one pasted blob can never trigger
/// unbounded server-side scans/DB lookups in the resolve endpoint.
/// Mirrors `MAX_RESUME_CANDIDATES` (`shared/resume-input-parser.ts:29`).
pub const MAX_RESUME_CANDIDATES: usize = 8;
```

6c. In `parse_resume_input`, replace the final two lines

```rust
    let hint = derive_hint(&sanitized, &candidates);
    ResumeInputParse { candidates, hint }
```

with:

```rust
    // Cap = work budget: bounds resolver scans + exact-id fallback lookups
    // per request. The hint derives from the CAPPED list (TS parity:
    // `deriveHint(sanitized, capped)`).
    candidates.truncate(MAX_RESUME_CANDIDATES);
    let hint = derive_hint(&sanitized, &candidates);
    ResumeInputParse { candidates, hint }
```

Also update the doc comment on the `candidates` field of `ResumeInputParse` to say "capped at `MAX_RESUME_CANDIDATES`".

- [ ] **Step 7: Run both sides — expect PASS**

Run:
```bash
cargo test -p freshell-sessions --test resume_input_parser_parity
npm run test:vitest -- --config config/vitest/vitest.config.ts test/unit/shared/resume-input-parser.test.ts --run
```
Expected: both PASS. Also run `cargo test -p freshell-sessions` and `cargo test -p freshell-server` — expect PASS (the old resolver consumes the parser output shape unchanged; if a resolver test relied on >8 candidates, fix the TEST input, not the cap).

- [ ] **Step 8: Commit**

```bash
git add test/fixtures/resume-input/parser-cases.json test/unit/shared/resume-input-parser.test.ts crates/freshell-sessions/src/resume_input.rs
git commit -m "feat(sessions): align resume-input parser to hardened #586 rules via the shared fixture

Fixture extended to the hardened parser (known-family prefix regex,
MAX_RESUME_CANDIDATES=8 cap); TS test restored to fixture-driven form
(the rebase had kept main's inline version, silently unpinning the
keystone); Rust parser ported to the same rules. Both suites pass the
same table. (SYNC-06)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 3: Hardened resolve core — ranking, case rules, subagents, sessionType default, provider-health channel, budgeted fallbacks

Rewrite `crates/freshell-sessions/src/resume_resolve.rs` as a step-for-step port of the HARDENED `server/coding-cli/resolve-session.ts` + the budget/shape-gate logic of `resolve-fallbacks.ts`. This is the core of the delta.

**Files:**
- Rewrite: `crates/freshell-sessions/src/resume_resolve.rs`
- Rewrite: `crates/freshell-sessions/tests/resume_resolve.rs` (mirror the hardened `test/unit/server/coding-cli/resolve-session.test.ts`)
- Modify (compile only): `crates/freshell-server/src/resolve.rs` — minimal adaptation so the workspace compiles; the full wire upgrade is Task 6.

**Interfaces:**
- Consumes: `parse_resume_input` + `MAX_RESUME_CANDIDATES` (Task 2), `IndexedSession` (`directory_index.rs`, has `is_subagent: bool`, `key() -> "{provider}:{session_id}"`).
- Produces (Tasks 4 and 6 depend on these EXACT names):
  - `pub enum ResumeResolveStatus { Ready, Warming, Degraded }` (serde lowercase)
  - `pub struct ResumeResolveProviderError { pub provider: String, pub code: Option<String>, pub message: Option<String> }` (camelCase wire, `code`/`message` omitted when `None`)
  - `pub struct ProviderFailure { pub code: Option<String>, pub message: String }`
  - `pub struct ClaudeTranscriptHit { pub session_id: String, pub cwd: Option<String> }` (unchanged)
  - `pub struct OpencodeByIdHit { pub session_id: String, pub cwd: Option<String>, pub title: Option<String>, pub last_activity_at: Option<i64> }`
  - `pub struct ResolveDeps<'a>` with fallback fields typed `Option<&'a (dyn Fn(&str) -> Result<Option<...Hit>, ProviderFailure> + Send + Sync)>`
  - `pub struct ResumeResolveOutcome { pub status: ResumeResolveStatus, pub matches: Vec<ResumeResolveMatch>, pub hint: Option<ResumeHint>, pub provider_errors: Vec<ResumeResolveProviderError> }`
  - `pub fn resolve_resume_input(input: &str, deps: &ResolveDeps<'_>) -> ResumeResolveOutcome`
  - `pub const RESOLVE_MATCH_CAP: usize = 20;` and `pub const FALLBACK_BUDGET_PER_REQUEST: usize = 2;`
  - The old `ResumeResolveResponse` struct is DELETED from this module (the wire response moves to `resolve.rs` in Task 6).

- [ ] **Step 1: Write the failing tests (rewrite `crates/freshell-sessions/tests/resume_resolve.rs`)**

Mirror the hardened Node core suite `test/unit/server/coding-cli/resolve-session.test.ts` test-for-test (23 `it(...)` tests, no `it.each` — count verified at this worktree's HEAD; read it side-by-side while writing). Start the file with this header and helpers:

```rust
//! SYNC-06 logic-parity mirror of the HARDENED Node core suite
//! `test/unit/server/coding-cli/resolve-session.test.ts` (post-#586),
//! test-for-test. The HTTP wire (auth/validation/router merge) is pinned in
//! `crates/freshell-server/src/resolve.rs`.

use std::collections::HashMap;

use freshell_sessions::directory_index::IndexedSession;
use freshell_sessions::resume_resolve::{
    resolve_resume_input, ClaudeTranscriptHit, OpencodeByIdHit, ProviderFailure, ResolveDeps,
    ResumeResolveOutcome, ResumeResolveStatus, RESOLVE_MATCH_CAP,
};

const CLAUDE_ID: &str = "ed2afda6-a340-443e-ba60-024a1b3554b4";
const OTHER_UUID: &str = "aaaaaaaa-1111-4222-8333-444444444444";
const SES_ID: &str = "ses_root0000000000000000000000";

fn session(provider: &str, id: &str, last: i64) -> IndexedSession {
    IndexedSession {
        session_id: id.to_string(),
        provider: provider.to_string(),
        project_path: format!("/repo/{provider}"),
        title: Some(format!("{provider} title")),
        summary: None,
        first_user_message: Some("hello".to_string()),
        last_activity_at: last,
        created_at: None,
        cwd: Some(format!("/repo/{provider}")),
        is_subagent: false,
        is_non_interactive: false,
        source_file: None,
    }
}

fn resolve(
    input: &str,
    sessions: Option<&[IndexedSession]>,
    claude: Option<&(dyn Fn(&str) -> Result<Option<ClaudeTranscriptHit>, ProviderFailure> + Send + Sync)>,
    opencode: Option<&(dyn Fn(&str) -> Result<Option<OpencodeByIdHit>, ProviderFailure> + Send + Sync)>,
) -> ResumeResolveOutcome {
    let session_types: HashMap<String, String> = HashMap::new();
    resolve_resume_input(
        input,
        &ResolveDeps {
            sessions,
            session_types: &session_types,
            locate_claude_transcript: claude,
            opencode_session_by_id: opencode,
        },
    )
}
```

Then write the tests. The COMPLETE code for the tests covering NEW hardened behavior (write these verbatim); for behaviors that already had a green mirror test in the old file (exact-wins-over-prefix, priority order of candidates, cap-20, dedupe-most-recent, warming, ready-empty, hint-alongside-evidence), carry the old test bodies over, adapting only the deps construction to the `resolve(...)` helper above and expected `session_type` values per the new default rule (index matches now ALWAYS carry `sessionType`, defaulting to the provider name):

```rust
#[test]
fn ses_ids_are_case_sensitive_a_case_variant_does_not_match() {
    let sessions = vec![session("opencode", SES_ID, 100)];
    let variant = SES_ID.to_uppercase().replace("SES_", "ses_");
    let out = resolve(&variant, Some(&sessions), None, None);
    assert_eq!(out.status, ResumeResolveStatus::Ready);
    // Not exact — but it IS a prefix miss too (different chars), so empty.
    assert!(out.matches.is_empty());
}

#[test]
fn exact_id_match_is_case_insensitive_for_uuid_hex_tokens() {
    let sessions = vec![session("claude", CLAUDE_ID, 100)];
    let out = resolve(&CLAUDE_ID.to_uppercase(), Some(&sessions), None, None);
    assert_eq!(out.matches.len(), 1);
    assert_eq!(out.matches[0].match_kind, freshell_sessions::resume_resolve::ResumeMatchKind::Exact);
}

#[test]
fn an_exact_id_finds_a_subagent_child_session() {
    let mut child = session("claude", CLAUDE_ID, 100);
    child.is_subagent = true;
    let out = resolve(CLAUDE_ID, Some(&[child]), None, None);
    assert_eq!(out.matches.len(), 1);
}

#[test]
fn prefix_discovery_does_not_surface_subagent_sessions() {
    let mut child = session("claude", CLAUDE_ID, 100);
    child.is_subagent = true;
    let top = session("claude", "ed2afda6-a340-443e-ba60-024a1b3554b5", 90);
    let out = resolve("ed2afda6", Some(&[child, top]), None, None);
    assert_eq!(out.matches.len(), 1);
    assert_eq!(out.matches[0].session_id, "ed2afda6-a340-443e-ba60-024a1b3554b5");
}

#[test]
fn session_type_defaults_to_the_provider_name_when_the_overlay_has_none() {
    let sessions = vec![session("claude", CLAUDE_ID, 100)];
    let out = resolve(CLAUDE_ID, Some(&sessions), None, None);
    assert_eq!(out.matches[0].session_type.as_deref(), Some("claude"));
}

#[test]
fn an_exact_fallback_hit_beats_an_indexed_prefix_match_of_the_same_token() {
    // Index holds a session whose id merely STARTS WITH the pasted full id.
    let longer = session("claude", &format!("{CLAUDE_ID}0"), 100);
    let hits = |id: &str| -> Result<Option<ClaudeTranscriptHit>, ProviderFailure> {
        Ok(Some(ClaudeTranscriptHit { session_id: id.to_ascii_lowercase(), cwd: Some("/repo/x".into()) }))
    };
    let out = resolve(CLAUDE_ID, Some(&[longer]), Some(&hits), None);
    assert_eq!(out.matches.len(), 1);
    assert_eq!(out.matches[0].session_id, CLAUDE_ID);
    assert_eq!(out.matches[0].provider, "claude");
}

#[test]
fn a_fallback_exact_hit_for_a_higher_priority_token_beats_an_indexed_exact_of_a_lower_one() {
    // Candidate order: ses_ (prefixed) outranks the uuid. The ses_ id resolves
    // only via the opencode fallback; the uuid has an indexed exact hit.
    let indexed = vec![session("claude", CLAUDE_ID, 100)];
    let oc = |id: &str| -> Result<Option<OpencodeByIdHit>, ProviderFailure> {
        Ok(Some(OpencodeByIdHit { session_id: id.to_string(), cwd: Some("/repo/oc".into()), title: None, last_activity_at: None }))
    };
    let out = resolve(&format!("{SES_ID} {CLAUDE_ID}"), Some(&indexed), None, Some(&oc));
    assert_eq!(out.matches.len(), 1);
    assert_eq!(out.matches[0].provider, "opencode");
    assert_eq!(out.matches[0].session_id, SES_ID);
}

#[test]
fn a_failing_fallback_never_fails_the_resolve_it_degrades_with_a_provider_error() {
    // Node production parity: the opencode worker boundary serializes only
    // {name, message} (`opencode-by-id.worker.ts:41-42`) and the runner
    // rebuilds the Error WITHOUT `.code` (`opencode-by-id-runner.ts:103-106`),
    // so opencode provider errors are message-only on the wire — `code` is
    // None here. (Code passthrough-when-present is exercised by the claude
    // fallback's EACCES endpoint test in Task 6.)
    let broken = |_id: &str| -> Result<Option<OpencodeByIdHit>, ProviderFailure> {
        Err(ProviderFailure { code: None, message: "unable to open database file".into() })
    };
    let out = resolve(SES_ID, Some(&[]), None, Some(&broken));
    assert_eq!(out.status, ResumeResolveStatus::Degraded);
    assert!(out.matches.is_empty());
    assert_eq!(out.provider_errors.len(), 1);
    assert_eq!(out.provider_errors[0].provider, "opencode");
    assert_eq!(out.provider_errors[0].code, None);
    assert_eq!(out.provider_errors[0].message.as_deref(), Some("unable to open database file"));
}

#[test]
fn a_failed_fallback_does_not_hide_a_later_lower_priority_match_but_marks_degraded() {
    // ses_ token fails in the fallback; the later hex token prefix-matches the index.
    let indexed = vec![session("amplifier", "417e8345aaaa", 50)];
    let broken = |_id: &str| -> Result<Option<OpencodeByIdHit>, ProviderFailure> {
        Err(ProviderFailure { code: None, message: "locked".into() })
    };
    let out = resolve(&format!("{SES_ID} 417e8345"), Some(&indexed), None, Some(&broken));
    assert_eq!(out.status, ResumeResolveStatus::Degraded);
    assert_eq!(out.matches.len(), 1);
    assert_eq!(out.matches[0].session_id, "417e8345aaaa");
    assert_eq!(out.provider_errors[0].provider, "opencode");
}

#[test]
fn a_healthy_resolve_reports_no_provider_errors_and_stays_ready() {
    let sessions = vec![session("claude", CLAUDE_ID, 100)];
    let out = resolve(CLAUDE_ID, Some(&sessions), None, None);
    assert_eq!(out.status, ResumeResolveStatus::Ready);
    assert!(out.provider_errors.is_empty());
}

#[test]
fn shape_gates_wrong_shape_tokens_do_no_fallback_work() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static CALLS: AtomicUsize = AtomicUsize::new(0);
    let counting = |_id: &str| -> Result<Option<OpencodeByIdHit>, ProviderFailure> {
        CALLS.fetch_add(1, Ordering::SeqCst);
        Ok(None)
    };
    // "ses_short001" matches the parser's prefixed-id family but NOT the
    // full-id shape ^ses_[0-9a-zA-Z]{26}$ — the fallback must not run.
    let out = resolve("ses_short001", Some(&[]), None, Some(&counting));
    assert_eq!(CALLS.load(Ordering::SeqCst), 0);
    assert_eq!(out.status, ResumeResolveStatus::Ready);
}

#[test]
fn fallback_work_is_budgeted_to_two_calls_per_request_per_provider() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static CALLS: AtomicUsize = AtomicUsize::new(0);
    let counting = |_id: &str| -> Result<Option<OpencodeByIdHit>, ProviderFailure> {
        CALLS.fetch_add(1, Ordering::SeqCst);
        Ok(None)
    };
    // Four full-shape ses_ ids in one paste: only the first TWO may do work.
    let ids = [
        "ses_aaaaaaaaaaaaaaaaaaaaaaaaaa",
        "ses_bbbbbbbbbbbbbbbbbbbbbbbbbb",
        "ses_cccccccccccccccccccccccccc",
        "ses_dddddddddddddddddddddddddd",
    ];
    let _ = resolve(&ids.join(" "), Some(&[]), None, Some(&counting));
    assert_eq!(CALLS.load(Ordering::SeqCst), 2);
}

#[test]
fn wrong_shape_tokens_consume_no_budget() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static CALLS: AtomicUsize = AtomicUsize::new(0);
    let counting = |_id: &str| -> Result<Option<ClaudeTranscriptHit>, ProviderFailure> {
        CALLS.fetch_add(1, Ordering::SeqCst);
        Ok(None)
    };
    // Two ses_ tokens (wrong shape for claude) then a valid uuid: the uuid
    // must still reach the claude fallback (shape gate runs BEFORE budget).
    let input = format!("ses_aaaaaaaaaaaaaaaaaaaaaaaaaa ses_bbbbbbbbbbbbbbbbbbbbbbbbbb {OTHER_UUID}");
    let _ = resolve(&input, Some(&[]), Some(&counting), None);
    assert_eq!(CALLS.load(Ordering::SeqCst), 1);
}

#[test]
fn opencode_fallback_hit_carries_title_and_floored_last_activity() {
    let oc = |id: &str| -> Result<Option<OpencodeByIdHit>, ProviderFailure> {
        Ok(Some(OpencodeByIdHit {
            session_id: id.to_string(),
            cwd: Some("/repo/beta".into()),
            title: Some("beta work".into()),
            last_activity_at: Some(1234),
        }))
    };
    let out = resolve(SES_ID, Some(&[]), None, Some(&oc));
    let m = &out.matches[0];
    assert_eq!(m.provider, "opencode");
    assert_eq!(m.title.as_deref(), Some("beta work"));
    assert_eq!(m.last_activity_at, Some(1234));
    assert_eq!(m.session_type.as_deref(), Some("opencode"));
}

#[test]
fn provider_identity_travels_with_the_fallback_not_its_position() {
    // BOTH fallbacks present; only claude's fails on a uuid token.
    let broken_claude = |_id: &str| -> Result<Option<ClaudeTranscriptHit>, ProviderFailure> {
        Err(ProviderFailure { code: Some("EACCES".into()), message: "denied".into() })
    };
    let quiet_oc = |_id: &str| -> Result<Option<OpencodeByIdHit>, ProviderFailure> { Ok(None) };
    let out = resolve(OTHER_UUID, Some(&[]), Some(&broken_claude), Some(&quiet_oc));
    assert_eq!(out.provider_errors.len(), 1);
    assert_eq!(out.provider_errors[0].provider, "claude");
    assert_eq!(out.provider_errors[0].code.as_deref(), Some("EACCES"));
}
```

The COMPLETE 23-test mapping to the Node suite (every `it(...)` title in `test/unit/server/coding-cli/resolve-session.test.ts` at this worktree's HEAD, in file order — the Rust suite must cover ALL 23; legend: ✎ = verbatim body given above, ↻ = carry over/adapt the old Rust test body, ✚ = write new from the stated expectation):

1. `exact match wins across all providers at once (claude UUID, no hint needed)` ✚ — index sessions for several providers, input = CLAUDE_ID → exactly 1 exact match; `hint` is the parser's id-shape derivation, `Some(ResumeHint { provider: Claude, source: IdShape })` — a bare v4 UUID ALWAYS derives the claude id-shape hint on both parsers (`shared/resume-input-parser.ts:88-94`, `resume_input.rs:194-202`). Do NOT assert `hint == None`: the Node title's "no hint needed" means no explicit command hint is required in the INPUT (the id shape alone suffices); the Node test body never asserts on `hint` at all.
2. `short hex prefix matches the amplifier session (spec row: 417e8345)` ✚ — index an amplifier session `417e8345aaaa`, input `417e8345` → 1 prefix match.
3. `exact-id match is case-insensitive for UUID/hex tokens` ✎ `exact_id_match_is_case_insensitive_for_uuid_hex_tokens`
4. `ses_ ids are case-SENSITIVE (base62): a case-variant does NOT match` ✎ `ses_ids_are_case_sensitive_a_case_variant_does_not_match`
5. `opencode ses_ id resolves to opencode even though other providers exist` ✚ — index sessions for all four providers incl. the SES_ID opencode row, input = SES_ID → 1 exact opencode match.
6. `exact match takes precedence over prefix matches of the same token` ↻
7. `ambiguous prefix returns all matches most-recent first, capped` ↻ — build 25 sessions with a shared prefix, assert 20 back (`RESOLVE_MATCH_CAP`), sorted by `last_activity_at` desc.
8. `tries candidates in priority order until one resolves` ↻
9. `an EXACT id finds a subagent/child session (spec: scan ALL sessions)` ✎ `an_exact_id_finds_a_subagent_child_session`
10. `prefix DISCOVERY does not surface subagent sessions` ✎ `prefix_discovery_does_not_surface_subagent_sessions`
11. `an exact FALLBACK hit beats an indexed PREFIX match of the same token` ✎ `an_exact_fallback_hit_beats_an_indexed_prefix_match_of_the_same_token`
12. `sessionType defaults to the provider name when the index has none` ✎ `session_type_defaults_to_the_provider_name_when_the_overlay_has_none`
13. `index miss consults exact-id fallbacks (claude transcript locator)` ✚ — empty index, input = OTHER_UUID, claude fallback returns a hit with cwd → 1 exact `claude` match carrying the cwd.
14. `index miss consults opencode by-id fallback` ✎ `opencode_fallback_hit_carries_title_and_floored_last_activity` (covers it with richer asserts — keep them)
15. `zero matches when nothing resolves anywhere` ↻ — ready-empty for garbage input.
16. `a THROWING fallback never fails the request: it degrades with a provider error summary` ✎ `a_failing_fallback_never_fails_the_resolve_it_degrades_with_a_provider_error`
17. `provider identity in providerErrors comes from the fallback PAIR, not its position` ✎ `provider_identity_travels_with_the_fallback_not_its_position`
18. `a typed ClaudeTranscriptLocatorError surfaces its errno code in the provider error` ✚ — claude fallback returns `Err(ProviderFailure { code: Some("EACCES"), .. })` on a uuid token → `provider_errors[0].code == Some("EACCES")` (Rust models Node's typed error as `ProviderFailure.code`).
19. `a healthy resolve reports NO provider errors` ✎ `a_healthy_resolve_reports_no_provider_errors_and_stays_ready`
20. `a failed exact-id fallback does NOT hide a later lower-priority match — but marks the response degraded` ✎ `a_failed_fallback_does_not_hide_a_later_lower_priority_match_but_marks_degraded`
21. `a fallback exact hit for a HIGHER-priority token beats an indexed exact hit of a LOWER-priority token` ✎ `a_fallback_exact_hit_for_a_higher_priority_token_beats_an_indexed_exact_of_a_lower_one`
22. `dedupes duplicate (provider, sessionId) snapshot entries, keeping the most recent` ↻
23. `returns warming (not "not found") while the index is not ready` ↻ — `sessions: None`, assert `provider_errors` empty too.

ALSO keep the Rust-only additions given verbatim above that have no Node twin (`shape_gates_wrong_shape_tokens_do_no_fallback_work`, `fallback_work_is_budgeted_to_two_calls_per_request_per_provider`, `wrong_shape_tokens_consume_no_budget`) and the old file's hint-alongside-evidence carryover — the suite therefore ends up with MORE than 23 tests; the 23 above are the mirror contract.

- [ ] **Step 2: Run — expect compile FAILURE (new API does not exist yet)**

Run: `cargo test -p freshell-sessions --test resume_resolve`
Expected: compile errors (`OpencodeByIdHit`, `ProviderFailure`, `ResumeResolveOutcome`, `Degraded` unknown).

- [ ] **Step 3: Rewrite `crates/freshell-sessions/src/resume_resolve.rs`**

Replace the whole file with (keep the existing module doc, updating its second paragraph to note the hardened contract):

```rust
//! Rust port of the HARDENED (#586) `server/coding-cli/resolve-session.ts` +
//! the shape-gate/budget logic of `resolve-fallbacks.ts` — the resume-by-id
//! resolve core. Pure and synchronous: the HTTP layer
//! (`crates/freshell-server/src/resolve.rs`) supplies the index snapshot, the
//! sessionType overlay map, and the two exact-id fallback closures, then
//! merges router-level fields (scan failures, unsearchedProviders, homeDir)
//! and serializes.
//!
//! Wire parity notes:
//! - Field ORDER in `ResumeResolveMatch` matches the Node object literals —
//!   `serde_json` `preserve_order` + struct field order drive output order.
//! - Optional match fields are OMITTED when `None` (Node drops `undefined`);
//!   `hint` is `null` when absent (zod `.nullable()`), so NOT skip-serialized.
//! - Per-token resolution order (resolve-session.ts:56-70): exact index hits
//!   (ALL sessions, subagents included) → exact-id fallbacks → prefix
//!   discovery (top-level only). A prefix match must NEVER outrank any exact
//!   resolution of the same or a higher-priority token.
//! - UUID/hex-family tokens (hex digits + dashes only) match
//!   case-INSENSITIVELY; everything else — notably ses_ base62 ids — matches
//!   case-SENSITIVELY (base62 case-folding could resolve the WRONG session).
//! - Provider failure ≠ not found: a failing fallback records a per-provider
//!   error and the result becomes `degraded` — never a silent empty miss.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;

use crate::directory_index::IndexedSession;
use crate::resume_input::{parse_resume_input, ResumeHint};

/// `RESOLVE_MATCH_CAP` (`resolve-session.ts:12`).
pub const RESOLVE_MATCH_CAP: usize = 20;

/// `FALLBACK_BUDGET_PER_REQUEST` (`resolve-fallbacks.ts:34`): each fallback
/// may do REAL work at most this many times per request; beyond that it
/// reports a miss without doing work. Shape gates run FIRST and consume no
/// budget (`resolve-fallbacks.ts:46-48` — order is load-bearing).
pub const FALLBACK_BUDGET_PER_REQUEST: usize = 2;

/// `FALLBACK_ID_SHAPES` (`resolve-fallbacks.ts:22-25`): FULL-id gates.
static CLAUDE_FALLBACK_ID_SHAPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
        .expect("static regex")
});
static OPENCODE_FALLBACK_ID_SHAPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^ses_[0-9a-zA-Z]{26}$").expect("static regex"));

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResumeResolveStatus {
    Ready,
    Warming,
    Degraded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResumeMatchKind {
    Exact,
    Prefix,
}

/// One resolve match (`ResumeResolveMatchSchema`). Field order = Node's
/// `toMatch` / fallback literals.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeResolveMatch {
    pub provider: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_user_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<i64>,
    pub match_kind: ResumeMatchKind,
}

/// `ResumeResolveProviderErrorSchema`: a provider that could not be searched
/// is 'degraded' — NEVER "not found". Node builds `{provider, ...code, message}`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeResolveProviderError {
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// A fallback failure as reported by the closure (the Rust analog of a Node
/// fallback rejection; typed locator errors carry an errno-ish `code`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderFailure {
    pub code: Option<String>,
    pub message: String,
}

/// The claude transcript fallback's answer. `session_id` is the LOWERCASED
/// id (the locator lowercases before scanning, Node parity).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeTranscriptHit {
    pub session_id: String,
    pub cwd: Option<String>,
}

/// The opencode by-id fallback's answer (hardened Node: the full sqlite row
/// from `opencode-by-id-query.ts`, archived + child sessions included).
/// `last_activity_at` is already floored to integer ms by the producer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpencodeByIdHit {
    pub session_id: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub last_activity_at: Option<i64>,
}

/// Dependencies for one resolve call (`ResolveResumeDeps`). Fallbacks return
/// `Err(ProviderFailure)` when the provider store could not be searched —
/// the core records it and continues (provider unavailable ≠ not found).
pub struct ResolveDeps<'a> {
    /// Deleted-filtered index snapshot; `None` = never published ⇒ warming.
    pub sessions: Option<&'a [IndexedSession]>,
    /// sessionType overlay keyed `"{provider}:{session_id}"`.
    pub session_types: &'a HashMap<String, String>,
    /// claude transcript exact-id fallback (`locateClaudeTranscript`).
    #[allow(clippy::type_complexity)]
    pub locate_claude_transcript: Option<
        &'a (dyn Fn(&str) -> Result<Option<ClaudeTranscriptHit>, ProviderFailure> + Send + Sync),
    >,
    /// opencode `ses_*` exact-id fallback (hardened by-id row query).
    #[allow(clippy::type_complexity)]
    pub opencode_session_by_id: Option<
        &'a (dyn Fn(&str) -> Result<Option<OpencodeByIdHit>, ProviderFailure> + Send + Sync),
    >,
}

/// Core result (`ResolveResumeResult` in `resolve-session.ts:31-36`).
/// `provider_errors` carries FALLBACK failures only; the HTTP layer merges in
/// index scan failures and adds `unsearchedProviders`/`homeDir`.
#[derive(Debug, Clone, PartialEq)]
pub struct ResumeResolveOutcome {
    pub status: ResumeResolveStatus,
    pub matches: Vec<ResumeResolveMatch>,
    pub hint: Option<ResumeHint>,
    pub provider_errors: Vec<ResumeResolveProviderError>,
}

/// `isCaseInsensitiveToken` (`resolve-session.ts:51-53`).
fn is_case_insensitive_token(token: &str) -> bool {
    !token.is_empty()
        && token
            .bytes()
            .all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// `resolveResumeInput` (`resolve-session.ts:72-170`), step for step.
pub fn resolve_resume_input(input: &str, deps: &ResolveDeps<'_>) -> ResumeResolveOutcome {
    // Parse BEFORE the warming gate: the warming response still carries the hint.
    let parsed = parse_resume_input(input);
    let hint = parsed.hint;

    let Some(sessions) = deps.sessions else {
        return ResumeResolveOutcome {
            status: ResumeResolveStatus::Warming,
            matches: Vec::new(),
            hint,
            provider_errors: Vec::new(),
        };
    };
    if parsed.candidates.is_empty() {
        return ResumeResolveOutcome {
            status: ResumeResolveStatus::Ready,
            matches: Vec::new(),
            hint,
            provider_errors: Vec::new(),
        };
    }

    // First-error-per-provider, insertion order (Node's Map semantics).
    let mut errors: Vec<ResumeResolveProviderError> = Vec::new();
    // Per-REQUEST budgets (`withRequestBudget` wraps once, before the loop).
    let mut claude_used = 0usize;
    let mut opencode_used = 0usize;

    for candidate in &parsed.candidates {
        let ci = is_case_insensitive_token(&candidate.token);
        let norm = |value: &str| {
            if ci {
                value.to_ascii_lowercase()
            } else {
                value.to_string()
            }
        };
        let target = norm(&candidate.token);

        // 1. Exact index hits — scan ALL sessions, subagent children included.
        let exact: Vec<ResumeResolveMatch> = sessions
            .iter()
            .filter(|session| norm(&session.session_id) == target)
            .map(|session| to_match(session, ResumeMatchKind::Exact, deps.session_types))
            .collect();
        if !exact.is_empty() {
            return finish(exact, hint, errors);
        }

        // 2. Exact-id fallbacks BEFORE prefix matching. Shape FIRST, budget
        // SECOND (wrong-shape tokens are free no-ops); iterated claude-then-
        // opencode so a failure is attributed to the RIGHT provider.
        let mut hits: Vec<ResumeResolveMatch> = Vec::new();
        if let Some(locate) = deps.locate_claude_transcript {
            if CLAUDE_FALLBACK_ID_SHAPE.is_match(&candidate.token)
                && claude_used < FALLBACK_BUDGET_PER_REQUEST
            {
                claude_used += 1;
                match locate(&candidate.token) {
                    Ok(Some(hit)) => hits.push(ResumeResolveMatch {
                        provider: "claude".to_string(),
                        session_id: hit.session_id.clone(),
                        // cwd may legitimately be missing — the CLIENT then
                        // asks for a working directory instead of auto-opening.
                        cwd: hit.cwd,
                        session_type: Some(overlay_or(
                            deps.session_types,
                            "claude",
                            &hit.session_id,
                        )),
                        title: None,
                        first_user_message: None,
                        last_activity_at: None,
                        match_kind: ResumeMatchKind::Exact,
                    }),
                    Ok(None) => {}
                    Err(failure) => record_error("claude", failure, &mut errors),
                }
            }
        }
        if let Some(lookup) = deps.opencode_session_by_id {
            if OPENCODE_FALLBACK_ID_SHAPE.is_match(&candidate.token)
                && opencode_used < FALLBACK_BUDGET_PER_REQUEST
            {
                opencode_used += 1;
                match lookup(&candidate.token) {
                    Ok(Some(hit)) => hits.push(ResumeResolveMatch {
                        provider: "opencode".to_string(),
                        session_id: hit.session_id.clone(),
                        // opencode resumes in the SPAWN cwd (the row's own
                        // `directory`); empty ⇒ omitted (Node `row.cwd || undefined`).
                        cwd: hit.cwd.filter(|c| !c.is_empty()),
                        session_type: Some(overlay_or(
                            deps.session_types,
                            "opencode",
                            &hit.session_id,
                        )),
                        title: hit.title.filter(|t| !t.is_empty()),
                        first_user_message: None,
                        last_activity_at: hit.last_activity_at,
                        match_kind: ResumeMatchKind::Exact,
                    }),
                    Ok(None) => {}
                    Err(failure) => record_error("opencode", failure, &mut errors),
                }
            }
        }
        if !hits.is_empty() {
            return finish(hits, hint, errors);
        }

        // 3. Prefix DISCOVERY — top-level sessions only; exact ids above
        // still reach subagent children.
        let prefix: Vec<ResumeResolveMatch> = sessions
            .iter()
            .filter(|session| {
                !session.is_subagent && norm(&session.session_id).starts_with(&target)
            })
            .map(|session| to_match(session, ResumeMatchKind::Prefix, deps.session_types))
            .collect();
        if !prefix.is_empty() {
            return finish(prefix, hint, errors);
        }
    }

    finish(Vec::new(), hint, errors)
}

/// Node's `finish` closure (`resolve-session.ts:100-109`): sort most-recent
/// first (stable, like JS), dedupe keeping the survivor with the most recent
/// activity, cap, and derive degraded-ness from recorded errors.
fn finish(
    mut matches: Vec<ResumeResolveMatch>,
    hint: Option<ResumeHint>,
    errors: Vec<ResumeResolveProviderError>,
) -> ResumeResolveOutcome {
    matches.sort_by(|a, b| {
        b.last_activity_at
            .unwrap_or(0)
            .cmp(&a.last_activity_at.unwrap_or(0))
    });
    let matches: Vec<ResumeResolveMatch> =
        dedupe(matches).into_iter().take(RESOLVE_MATCH_CAP).collect();
    ResumeResolveOutcome {
        status: if errors.is_empty() {
            ResumeResolveStatus::Ready
        } else {
            // Even with matches: a failed HIGHER-priority exact search may
            // have hidden the right session — the client must not auto-resume.
            ResumeResolveStatus::Degraded
        },
        matches,
        hint,
        provider_errors: errors,
    }
}

/// First error per provider wins (Node: `if (!errorsByProvider.has(provider))`).
fn record_error(
    provider: &str,
    failure: ProviderFailure,
    errors: &mut Vec<ResumeResolveProviderError>,
) {
    if errors.iter().any(|e| e.provider == provider) {
        return;
    }
    errors.push(ResumeResolveProviderError {
        provider: provider.to_string(),
        code: failure.code,
        message: Some(failure.message),
    });
}

/// sessionType resolution shared by index and fallback matches: overlay map
/// (keyed `"{provider}:{id}"`) → provider-name default
/// (`toMatch`'s `session.sessionType ?? session.provider` and
/// `resolve-fallbacks.ts`'s `sessionTypeFor`).
fn overlay_or(session_types: &HashMap<String, String>, provider: &str, id: &str) -> String {
    session_types
        .get(&format!("{provider}:{id}"))
        .cloned()
        .unwrap_or_else(|| provider.to_string())
}

/// `toMatch` (`resolve-session.ts:172-183`).
fn to_match(
    session: &IndexedSession,
    match_kind: ResumeMatchKind,
    session_types: &HashMap<String, String>,
) -> ResumeResolveMatch {
    ResumeResolveMatch {
        provider: session.provider.clone(),
        session_id: session.session_id.clone(),
        cwd: Some(
            session
                .cwd
                .clone()
                .unwrap_or_else(|| session.project_path.clone()),
        ),
        session_type: Some(overlay_or(
            session_types,
            &session.provider,
            &session.session_id,
        )),
        title: session.title.clone(),
        first_user_message: session.first_user_message.clone(),
        last_activity_at: Some(session.last_activity_at),
        match_kind,
    }
}

/// `dedupe` (`resolve-session.ts:189-197`): first `provider:sessionId` wins —
/// which, post-sort, is the most recent entry.
fn dedupe(matches: Vec<ResumeResolveMatch>) -> Vec<ResumeResolveMatch> {
    let mut seen: HashSet<String> = HashSet::new();
    matches
        .into_iter()
        .filter(|m| seen.insert(format!("{}:{}", m.provider, m.session_id)))
        .collect()
}
```

Note the key `overlay_or` uses `IndexedSession.key()`'s format; if `key()` exists use `session.key()` for the index path (it does — `directory_index.rs:86`) — either spelling is fine as long as the format is `"{provider}:{session_id}"`.

- [ ] **Step 4: Minimal compile adaptation of the HTTP layer (behavior parity deferred to Task 6)**

`crates/freshell-server/src/resolve.rs` no longer compiles (old `ResumeResolveResponse`, `OpencodeDirLookup` closure types). Make the smallest change that keeps current wire behavior while compiling against the new core, so this task stays reviewable on its own:

- Change the two lookup type aliases to the new fallible forms:
  ```rust
  pub type OpencodeByIdLookup =
      Arc<dyn Fn(&str) -> Result<Option<OpencodeByIdHit>, ProviderFailure> + Send + Sync>;
  pub type ClaudeLocator =
      Arc<dyn Fn(&str) -> Result<Option<ClaudeTranscriptHit>, ProviderFailure> + Send + Sync>;
  ```
  and rename the state field `opencode_dir_by_id` → `opencode_session_by_id` (imports: `OpencodeByIdHit`, `ProviderFailure`, `ResumeResolveOutcome` from `freshell_sessions::resume_resolve`; drop the now-unused `OpencodeSessionDirectory` import).
- In the handler, build `ResolveDeps` with the renamed fields and serialize a TEMPORARY wire struct locally so today's `{status, matches, hint}` shape is preserved until Task 6:
  ```rust
  #[derive(serde::Serialize)]
  struct LegacyWire {
      status: freshell_sessions::resume_resolve::ResumeResolveStatus,
      matches: Vec<freshell_sessions::resume_resolve::ResumeResolveMatch>,
      hint: Option<freshell_sessions::resume_input::ResumeHint>,
  }
  ```
  mapping the outcome's fields into it (drop `provider_errors` for now) — and mark it `// TASK-6: replaced by the full hardened wire response`.
- In `crates/freshell-server/src/main.rs`, update the two closures to the new signatures MINIMALLY (same silent-miss behavior for now, full health channel in Task 6):
  ```rust
  opencode_session_by_id: Some(std::sync::Arc::new(|session_id: &str| {
      let data_home = freshell_sessions::parse::default_opencode_data_home();
      Ok(freshell_sessions::parse::opencode_session_directory_by_id(&data_home, session_id)
          .ok()
          .flatten()
          .map(|hit| freshell_sessions::resume_resolve::OpencodeByIdHit {
              session_id: session_id.to_string(),
              cwd: hit.directory,
              title: None,
              last_activity_at: None,
          }))
  })),
  locate_claude_transcript: Some(std::sync::Arc::new(|session_id: &str| {
      let lowered = session_id.to_ascii_lowercase();
      Ok(freshell_freshagent::locate_transcript(&lowered).map(|path| {
          freshell_sessions::resume_resolve::ClaudeTranscriptHit {
              session_id: lowered.clone(),
              cwd: freshell_freshagent::transcript_cwd(&path),
          }
      }))
  })),
  ```
- Update `resolve.rs`'s in-module tests only as far as compilation requires (closure signatures gain `Ok(...)`; the exact-match test's expected JSON gains `"sessionType": "claude"` — the new provider-name default is intentionally visible on the wire NOW, it matches hardened Node).

- [ ] **Step 5: Run the suites**

Run: `cargo test -p freshell-sessions --test resume_resolve && cargo test -p freshell-server && cargo test -p freshell-sessions`
Expected: ALL PASS. Then `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings` — clean.

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-sessions/src/resume_resolve.rs crates/freshell-sessions/tests/resume_resolve.rs crates/freshell-server/src/resolve.rs crates/freshell-server/src/main.rs
git commit -m "feat(sessions): hardened #586 resolve core — per-token ranking, case rules, provider-health channel, budgeted fallbacks

Per-token exact→fallback→prefix order (a prefix match never outranks an
exact resolution); ses_ ids case-SENSITIVE, uuid/hex case-folded;
subagents excluded from prefix discovery; sessionType defaults to the
provider name; fallbacks are shape-gated + budgeted (2/request/provider)
and their failures surface as degraded + providerErrors — never a silent
empty not-found. Mirrors test/unit/server/coding-cli/resolve-session.test.ts.
(SYNC-06)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 4: Hardened opencode exact-id lookup — direct by-id row query replacing the parent walk

Hardened Node replaced the #583 `resolveOpencodeSessionRoots` parent-walk with a direct by-id sqlite row query (`server/coding-cli/providers/opencode-by-id-query.ts`): archived and CHILD sessions included, full row returned (title/timestamps), errors PROPAGATE (provider unavailable ≠ not found). Port it.

**Files:**
- Modify: `crates/freshell-sessions/src/parse/opencode.rs` (add `OpencodeByIdRow` + `opencode_session_row_by_id`; DELETE `opencode_session_directory_by_id`, its `SessionRow`/`fetch_session_row` helpers, and the `OpencodeSessionDirectory` struct once nothing references them — grep first: `grep -rn "OpencodeSessionDirectory\|opencode_session_directory_by_id" crates/ --include=*.rs`)
- Rewrite: `crates/freshell-sessions/tests/opencode_directory_by_id.rs` → delete and create `crates/freshell-sessions/tests/opencode_row_by_id.rs`
- Modify: `crates/freshell-sessions/src/parse/mod.rs` (export the new names, drop the old)

**Interfaces:**
- Consumes: rusqlite (already a dependency; the pinned 0.31.0 exposes `Error::sqlite_error_code()`) and the existing `to_opt_string`/`to_opt_i64` helpers in the same file.
- Produces (Task 6 wires this): `pub fn opencode_session_row_by_id(data_home: &Path, session_id: &str) -> Result<Option<OpencodeByIdRow>, OpencodeByIdError>`, `pub struct OpencodeByIdError { pub code: Option<String>, pub message: String }` (code-preserving — see Step 2; the existing `OpencodeReadError` stays untouched for its other consumers), and `pub struct OpencodeByIdRow { pub session_id: String, pub cwd: Option<String>, pub title: Option<String>, pub created_at: Option<i64>, pub last_activity_at: Option<i64>, pub project_path: Option<String> }`.

- [ ] **Step 1: Write the failing tests (`crates/freshell-sessions/tests/opencode_row_by_id.rs`)**

Reuse the DB-fixture helpers from the old `opencode_directory_by_id.rs` (it builds real sqlite files in temp dirs — copy its `temp dir` + schema-setup helpers verbatim, adjusting the schema to include `time_created`, `time_updated`, `time_archived`, `title` columns and a `project` table). Test set (complete expectations; adapt helper names to what you copied):

```rust
//! Hardened (#586) opencode exact-id lookup parity: mirrors
//! `server/coding-cli/providers/opencode-by-id-query.ts` — a DIRECT by-id
//! row query. Unlike the #583 parent-walk it includes ARCHIVED and CHILD
//! sessions, returns the full row (title/timestamps), and PROPAGATES read
//! errors (provider unavailable ≠ not found).

use freshell_sessions::parse::{opencode_session_row_by_id, OpencodeByIdRow};

// helpers: create_db(dir) -> PathBuf building
//   CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT,
//     title TEXT, project_id TEXT, time_created INTEGER, time_updated INTEGER,
//     time_archived INTEGER);
//   CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
// plus insert_session(...) / insert_project(...) row insert helpers.

#[test]
fn resolves_a_root_row_with_full_metadata() { /* insert root row with title
    "beta", directory "/repo/beta", time_updated 1234, project worktree
    "/repo"; expect Ok(Some(row)) with session_id, cwd Some("/repo/beta"),
    title Some("beta"), last_activity_at Some(1234), project_path Some("/repo") */ }

#[test]
fn resolves_a_child_row_the_listing_hides() { /* insert parent + child with
    parent_id set; query the CHILD id; expect Ok(Some(..)) — NO parent walk */ }

#[test]
fn resolves_an_archived_row() { /* time_archived NOT NULL still resolves */ }

#[test]
fn missing_row_is_ok_none() { /* valid db, unknown id → Ok(None) */ }

#[test]
fn db_without_a_session_table_is_ok_none() { /* db with only an unrelated
    table → Ok(None) (Node: `if (!tableNames.has('session')) return null`) */ }

#[test]
fn db_without_a_project_table_still_resolves_with_null_project_path() { /* session
    table only; expect Ok(Some(row)) with project_path None */ }

#[test]
fn missing_db_file_is_an_error_not_a_silent_miss() { /* empty temp dir →
    Err(OpencodeByIdError) with code Some("SQLITE_CANTOPEN") (Node:
    DatabaseSync open throws SQLITE_CANTOPEN; the provider is
    present-but-unreadable, and silence here is the incident class). The
    code is INTERNAL — kept for structured logs and message fidelity; the
    wire deliberately omits it for opencode (Node's worker boundary strips
    `.code` before the wire — see Task 6 Step 3b) */ }

#[test]
fn corrupt_db_file_is_an_error() { /* write 64 bytes of garbage to
    opencode.db → Err with code Some("SQLITE_NOTADB") */ }

#[test]
fn locked_db_is_an_error_after_the_busy_timeout() { /* REAL contention proof
    for the load-bearing 500 ms busy timeout: build a valid fixture db with
    one row, open a SECOND rusqlite Connection to the same file and run
    `BEGIN EXCLUSIVE` (hold the txn open, do not commit); now call
    opencode_session_row_by_id → expect Err with code Some("SQLITE_BUSY")
    (the busy error surfaces as OpencodeByIdError once the 500 ms
    busy_timeout expires — the read-only open cannot acquire the shared
    lock). Optionally assert the call took
    >= ~400 ms to show the timeout (not an instant failure), then ROLLBACK/
    drop the writer connection so the temp dir cleans up. */ }

#[test]
fn real_time_updated_is_floored_to_integer_ms() { /* insert with
    time_updated = 1234.9 (REAL) → last_activity_at Some(1234) */ }
```

Write each body out fully using the copied helpers (they are short rusqlite calls; the old test file shows the pattern). Run: `cargo test -p freshell-sessions --test opencode_row_by_id` — expected: compile FAILURE (function does not exist).

- [ ] **Step 2: Implement `opencode_session_row_by_id`**

In `crates/freshell-sessions/src/parse/opencode.rs`, add:

```rust
/// SHORT busy timeout (`opencode-by-id-query.ts:12`): a locked DB must fail
/// FAST — the failure surfaces as provider-unavailable, never "not found".
const OPENCODE_BYID_BUSY_TIMEOUT_MS: u64 = 500;

/// Code-PRESERVING error for the by-id query (the plain `OpencodeReadError`
/// stays for its other consumers). Node's thrown sqlite errors carry a
/// `.code` like `SQLITE_CANTOPEN` at the QUERY layer — but Node's production
/// worker boundary then STRIPS it (`opencode-by-id.worker.ts:41-42`
/// serializes only `{name, message}`; `opencode-by-id-runner.ts:103-106`
/// rebuilds the Error without `.code`), so the code never reaches the wire.
/// We keep the code HERE for structured logging and precise messages; the
/// production closure (Task 6 Step 3b) deliberately maps it to
/// `ProviderFailure { code: None, .. }` — wire parity is message-only for
/// opencode.
#[derive(Debug, Clone, PartialEq)]
pub struct OpencodeByIdError {
    pub code: Option<String>,
    pub message: String,
}

/// Map a rusqlite error to the Node-style `SQLITE_*` code name via
/// `rusqlite::Error::sqlite_error_code()` (available in the pinned 0.31.0).
fn by_id_err(e: rusqlite::Error) -> OpencodeByIdError {
    use rusqlite::ffi::ErrorCode as C;
    let code = e.sqlite_error_code().and_then(|c| match c {
        C::CannotOpen => Some("SQLITE_CANTOPEN"),
        C::DatabaseBusy => Some("SQLITE_BUSY"),
        C::DatabaseLocked => Some("SQLITE_LOCKED"),
        C::NotADatabase => Some("SQLITE_NOTADB"),
        C::PermissionDenied => Some("SQLITE_PERM"),
        C::ReadOnly => Some("SQLITE_READONLY"),
        _ => None,
    });
    OpencodeByIdError { code: code.map(str::to_string), message: e.to_string() }
}

/// The hardened exact-id row (`OpencodeSessionRow` subset the by-id query
/// selects). `last_activity_at` floored to integer ms (REAL columns possible).
#[derive(Debug, Clone, PartialEq)]
pub struct OpencodeByIdRow {
    pub session_id: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub created_at: Option<i64>,
    pub last_activity_at: Option<i64>,
    pub project_path: Option<String>,
}

/// Hardened (#586) exact-id lookup — 1:1 port of
/// `runOpencodeSessionByIdQuery` (`opencode-by-id-query.ts`). Deliberately
/// includes ARCHIVED and CHILD sessions: an exact id pasted by the user must
/// resolve even when the listing hides it. Errors PROPAGATE (a missing or
/// unreadable DB file is `Err`, matching Node's throwing `DatabaseSync`
/// open — provider unavailable ≠ not found).
pub fn opencode_session_row_by_id(
    data_home: &Path,
    session_id: &str,
) -> Result<Option<OpencodeByIdRow>, OpencodeByIdError> {
    let db_path = data_home.join("opencode.db");
    let conn = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(by_id_err)?;
    conn.busy_timeout(std::time::Duration::from_millis(
        OPENCODE_BYID_BUSY_TIMEOUT_MS,
    ))
    .map_err(by_id_err)?;

    let table_names: std::collections::HashSet<String> = {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .map_err(by_id_err)?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(by_id_err)?;
        let mut set = std::collections::HashSet::new();
        for r in rows {
            set.insert(r.map_err(by_id_err)?);
        }
        set
    };
    if !table_names.contains("session") {
        return Ok(None);
    }
    let has_project = table_names.contains("project");
    let project_select = if has_project { "p.worktree" } else { "NULL" };
    let project_join = if has_project {
        "LEFT JOIN project p ON p.id = s.project_id"
    } else {
        ""
    };
    let sql = format!(
        "SELECT s.id, s.directory, s.title, s.time_created, s.time_updated, \
         {project_select} FROM session s {project_join} WHERE s.id = ?1 LIMIT 1"
    );
    match conn.query_row(&sql, rusqlite::params![session_id], |row| {
        Ok(OpencodeByIdRow {
            session_id: match row.get::<_, SqlValue>(0)? {
                SqlValue::Text(s) => s,
                other => to_opt_string(&other).unwrap_or_default(),
            },
            cwd: to_opt_string(&row.get::<_, SqlValue>(1)?),
            title: to_opt_string(&row.get::<_, SqlValue>(2)?),
            created_at: to_opt_i64(&row.get::<_, SqlValue>(3)?),
            last_activity_at: to_opt_i64(&row.get::<_, SqlValue>(4)?),
            project_path: to_opt_string(&row.get::<_, SqlValue>(5)?),
        })
    }) {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(by_id_err(e)),
    }
}
```

(`to_opt_i64` already truncates REAL toward zero via `as i64`; epoch-ms values are positive so truncation == `Math.floor` — same note the listing query carries.)

- [ ] **Step 3: Delete the old walk**

Grep consumers: `grep -rn "OpencodeSessionDirectory\|opencode_session_directory_by_id" crates/ --include=*.rs`. Expected remaining consumers after Task 3: only `parse/mod.rs` exports and possibly a leftover import in `resolve.rs`'s doc comments/tests. Delete `opencode_session_directory_by_id`, `fetch_session_row`, the `SessionRow` alias, and `OpencodeSessionDirectory`; delete `crates/freshell-sessions/tests/opencode_directory_by_id.rs`; update `parse/mod.rs` exports (`opencode_session_row_by_id`, `OpencodeByIdRow` in; old names out). Update the Task-3 temporary closure in `main.rs` to the new query:

```rust
opencode_session_by_id: Some(std::sync::Arc::new(|session_id: &str| {
    let data_home = freshell_sessions::parse::default_opencode_data_home();
    match freshell_sessions::parse::opencode_session_row_by_id(&data_home, session_id) {
        Ok(row) => Ok(row.map(|r| freshell_sessions::resume_resolve::OpencodeByIdHit {
            session_id: r.session_id,
            cwd: r.cwd,
            title: r.title,
            last_activity_at: r.last_activity_at,
        })),
        // TASK-6 upgrades this to Err(ProviderFailure{..}) once the wire
        // carries providerErrors; until then a read failure stays a miss.
        Err(_) => Ok(None),
    }
})),
```

Also update `resolve.rs`'s in-module opencode fallback test to return an `OpencodeByIdHit` (the old `OpencodeSessionDirectory` literal no longer exists) and extend its expected match JSON with the row-borne fields it now passes (`title`, `lastActivityAt`) if the test supplies them.

- [ ] **Step 4: Run**

Run: `cargo test -p freshell-sessions && cargo test -p freshell-server && cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings`
Expected: ALL PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-sessions/src/parse/ crates/freshell-sessions/tests/ crates/freshell-server/src/ 
git commit -m "feat(sessions): hardened opencode exact-id lookup — direct by-id row query (archived+child included, errors propagate)

Ports opencode-by-id-query.ts, replacing the #583 parent-walk. Full row
(title/timestamps) feeds the resolve match; a missing/locked/corrupt DB
is Err — provider unavailable ≠ not found. (SYNC-06)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 5: SessionIndex scan-failure channel + fire-and-forget refresh + settings enabled-providers getter

Node's route merges `codingCliIndexer.getScanFailures()` into `providerErrors` and fire-and-forgets `requestRefresh()` on degraded (`sessions-router.ts:293-305`). Give the Rust `SessionIndex` the same two capabilities, and `SettingsStore` an enabled-providers reader.

**Files:**
- Modify: `crates/freshell-sessions/src/directory_index.rs`
- Modify: `crates/freshell-sessions/src/amplifier.rs` (provider_name + discover_checked on the amplifier source)
- Modify: `crates/freshell-server/src/settings_store.rs` (getter below, AND: the legacy-default migration's hard-coded `const DEFAULTS: [&str; 3] = ["claude", "codex", "opencode"]` (`settings_store.rs`, load-time migration ~lines 180-196) widens to `[&str; 4]` adding `"amplifier"` — it must mirror Node's four-provider `DEFAULT_ENABLED_CLI_PROVIDERS` (`shared/coding-cli-defaults.ts:1-3`), otherwise a persisted legacy `["claude", "codex"]` list gains amplifier on Node but stays amplifier-less on Rust, leaving the provider unsearched and its indexed sessions filtered out; the migration's existing exact-legacy-match + gating logic is otherwise UNCHANGED)
- Modify: `crates/freshell-server/src/settings.rs` (default `enabled_providers` gains `"amplifier"` — Node-default parity)
- Test: unit tests inside `directory_index.rs`'s existing `#[cfg(test)]` module (follow its current test patterns) and `settings_store.rs`'s.

**Interfaces:**
- Consumes: existing `SessionSource` trait, `refresh_snapshot` free function, `spawn_background_refresh`.
- Produces (Task 6 depends on these EXACT names):
  - `SessionSource::provider_name(&self) -> Option<&'static str>` (default `None`; the FOUR real sources all participate: `ClaudeSource` → `Some("claude")`, `CodexSource` → `Some("codex")`, `OpencodeSource` → `Some("opencode")`, the amplifier source in `amplifier.rs` → `Some("amplifier")`)
  - `SessionSource::discover_checked(&self) -> Result<Vec<FileStat>, std::io::Error>` (default `Ok(self.discover())`; the file-backed sources override it to PROPAGATE a root-listing failure — see Step 2)
  - `SessionIndex::scan_failures(&self) -> Vec<String>` (sorted, deduped)
  - `SessionIndex::request_refresh(&self)` (non-blocking, no-op if a sweep is already running)
  - `SettingsStore::coding_cli_enabled_providers(&self) -> Vec<String>` — **async** (`pub async fn`): `ServerSettings` lives in a `tokio::sync::RwLock`, so the getter mirrors `get()` (`self.inner.read().await...`); a sync getter is impossible without `blocking_read`, which can panic inside the runtime. (`session_overrides()` is NOT the pattern here — it reads a separate `std::sync::Mutex`.)

- [ ] **Step 1: Write the failing tests**

In `directory_index.rs`'s test module (reuse its existing fixture-source pattern — the file has test sources; model on them):

```rust
#[tokio::test]
async fn a_failing_direct_list_records_a_scan_failure_and_recovery_clears_it() {
    // A direct-listed source whose direct_list() can be toggled to Err.
    struct FlakySource(std::sync::Arc<std::sync::atomic::AtomicBool>);
    impl SessionSource for FlakySource {
        fn discover(&self) -> Vec<FileStat> { Vec::new() }
        fn parse(&self, _p: &Path) -> Option<IndexedSession> { None }
        fn provider_name(&self) -> Option<&'static str> { Some("opencode") }
        // A CHANGING token each call, so every sweep re-queries.
        fn direct_change_token(&self) -> Option<i64> {
            use std::sync::atomic::{AtomicI64, Ordering};
            static N: AtomicI64 = AtomicI64::new(0);
            Some(N.fetch_add(1, Ordering::SeqCst))
        }
        fn direct_list(&self) -> Result<Vec<IndexedSession>, String> {
            if self.0.load(std::sync::atomic::Ordering::SeqCst) {
                Err("unable to open database file".to_string())
            } else {
                Ok(Vec::new())
            }
        }
    }
    let broken = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let index = SessionIndex::with_ttl_and_cache_path(
        vec![std::sync::Arc::new(FlakySource(std::sync::Arc::clone(&broken))) as _],
        std::time::Duration::ZERO, // every snapshot() sweeps
        None,
    );
    // COLD cache: the first snapshot() sweeps INLINE, so this assert is
    // deterministic.
    let _ = index.snapshot().await;
    assert_eq!(index.scan_failures(), vec!["opencode".to_string()]);
    broken.store(false, std::sync::atomic::Ordering::SeqCst);
    // WARM-but-stale cache: snapshot() returns stale data immediately and
    // refreshes DETACHED (stale-while-revalidate) — recovery must be observed
    // by POLLING. Reuse the module's existing `wait_until` test helper.
    let _ = index.snapshot().await;
    assert!(
        wait_until(std::time::Duration::from_secs(2), || index.scan_failures().is_empty()).await,
        "scan failure must clear once the source recovers"
    );
}

#[tokio::test]
async fn a_failing_file_backed_root_listing_records_a_scan_failure_too() {
    // FILE-BACKED parity (Node records listSessionFiles() throws for claude/
    // codex/amplifier in scanFailures — session-indexer.ts:1250-1262 — and the
    // route turns them into degraded providerErrors): a source whose
    // discover_checked() errs must be recorded, NOT silently treated as an
    // empty listing.
    struct FlakyFileSource(std::sync::Arc<std::sync::atomic::AtomicBool>);
    impl SessionSource for FlakyFileSource {
        fn discover(&self) -> Vec<FileStat> { Vec::new() }
        fn discover_checked(&self) -> Result<Vec<FileStat>, std::io::Error> {
            if self.0.load(std::sync::atomic::Ordering::SeqCst) {
                Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied"))
            } else {
                Ok(Vec::new())
            }
        }
        fn parse(&self, _p: &Path) -> Option<IndexedSession> { None }
        fn provider_name(&self) -> Option<&'static str> { Some("claude") }
    }
    let broken = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let index = SessionIndex::with_ttl_and_cache_path(
        vec![std::sync::Arc::new(FlakyFileSource(std::sync::Arc::clone(&broken))) as _],
        std::time::Duration::ZERO,
        None,
    );
    let _ = index.snapshot().await; // cold sweep is INLINE — deterministic
    assert_eq!(index.scan_failures(), vec!["claude".to_string()]);
    broken.store(false, std::sync::atomic::Ordering::SeqCst);
    let _ = index.snapshot().await; // stale-while-revalidate: poll for recovery
    assert!(
        wait_until(std::time::Duration::from_secs(2), || index.scan_failures().is_empty()).await,
        "file-backed scan failure must clear once the root is listable again"
    );
}
```

And for the settings getter (in `settings_store.rs` tests, following its temp-home pattern; `#[tokio::test]` since the getter is async): load a store from a temp home whose `<home>/.freshell/config.json` contains the WRAPPED document `{"version":1,"settings":{"codingCli":{"enabledProviders":["claude","opencode"]}}}` (SettingsStore reads `config.json` and unwraps the top-level `settings` key — see `load_full_settings`; there is NO `settings.json`), assert `coding_cli_enabled_providers().await` returns exactly that; and for a FRESH temp home (no config file) assert the returned list is exactly `["claude", "codex", "opencode", "amplifier"]` — Node's authoritative `DEFAULT_ENABLED_CLI_PROVIDERS` (`shared/coding-cli-defaults.ts:3`). This assertion FAILS against today's Rust default, which omits `amplifier` (`crates/freshell-server/src/settings.rs:38-44`) — that is a live parity defect this task closes in Step 2; do NOT weaken the assert to whatever the store currently returns. ALSO add a legacy-MIGRATION test in the same module (same temp-home pattern): persist a config whose `enabledProviders` is exactly the legacy pair `["claude", "codex"]`, load the store, and assert the migrated list gains `"amplifier"` under exactly the same conditions it already gains `"opencode"` (same availability gating the existing migration applies — mirror whatever the current opencode migration test asserts, extended to amplifier). This test FAILS against today's three-item `const DEFAULTS` in `settings_store.rs` — the second half of the same parity defect (Node migrates legacy lists using the four-provider `DEFAULT_ENABLED_CLI_PROVIDERS`, `server/settings-migrate.ts:35-46`).

Run: `cargo test -p freshell-sessions directory_index && cargo test -p freshell-server settings_store` — expected: compile FAILURE (methods missing).

- [ ] **Step 2: Implement**

- `SessionSource` trait: add
  ```rust
  /// Provider identity for scan-failure reporting (`getScanFailures` parity).
  /// `None` (default) = this source does not participate in failure tracking.
  fn provider_name(&self) -> Option<&'static str> {
      None
  }

  /// Discovery with ROOT-listing failure propagation (Node parity: a
  /// throwing `listSessionFiles()` is RECORDED in scanFailures —
  /// `session-indexer.ts:1250-1262` — never silently treated as empty).
  /// Default wraps the infallible `discover()` for test sources.
  fn discover_checked(&self) -> Result<Vec<FileStat>, std::io::Error> {
      Ok(self.discover())
  }
  ```
  Implement `provider_name` = `Some("claude")`/`Some("codex")`/`Some("opencode")`/`Some("amplifier")` on the FOUR real sources (the amplifier source lives in `amplifier.rs`). Override `discover_checked` on the file-backed sources (claude `directory_index.rs:204-208`, codex `directory_index.rs:374-377`, amplifier `amplifier.rs:108-111`) to PROPAGATE the top-level root `read_dir` error instead of the current `else { return Vec::new() }` swallow (a missing root — `NotFound`/`NotADirectory` — stays `Ok(vec![])`: an absent provider is a genuine empty, matching Node's ENOENT tolerance; EACCES/EIO propagate). Per-file/nested errors stay tolerant — corruption-tolerance within a listable root is preserved.
- `SessionIndex`: add field `scan_failures: Arc<StdMutex<HashSet<String>>>` (init empty in `with_ttl_and_cache_path`); pass `Arc::clone` of it into both `refresh_snapshot` call sites (inline + background — extend the free function's parameter list). Inside `refresh_snapshot`, for every source whose `provider_name()` is `Some(name)`: in the direct-listed branch, on `Ok` `set.remove(name)` / on `Err` `set.insert(name.to_string())`; in the file-backed branch, call `discover_checked()` instead of `discover()` — on `Ok(stats)` `set.remove(name)` and proceed as today, on `Err(_)` `set.insert(name.to_string())` and treat the listing as empty for this sweep. NODE PARITY NOTE (document in a comment on `scan_failures()`): Node behaves exactly this way — a throwing `listSessionFiles()` also yields an empty file list and lets the full-scan prune drop that provider's cached entries (`session-indexer.ts:1467-1475`, `:1499-1504`); what makes the outage VISIBLE is the recorded scan failure, which the route merges into `providerErrors` and marks the response `degraded` — never a silent healthy `ready + matches: []`. Both direct-listed (opencode) and file-backed (claude/codex/amplifier) outages must therefore be recorded.
- Public accessors on `SessionIndex`:
  ```rust
  /// Providers whose MOST RECENT listing attempt failed (unsearchable, not
  /// empty) — `codingCliIndexer.getScanFailures()` parity.
  pub fn scan_failures(&self) -> Vec<String> {
      let mut names: Vec<String> = self.scan_failures.lock().unwrap().iter().cloned().collect();
      names.sort();
      names
  }

  /// Fire-and-forget refresh (`requestRefresh` parity): gives a degraded
  /// response's Retry a chance to converge once a failed provider recovers.
  /// No-op if a sweep is already running.
  pub fn request_refresh(&self) {
      if let Ok(guard) = Arc::clone(&self.refresh_lock).try_lock_owned() {
          self.spawn_background_refresh(guard);
      }
  }
  ```
- `SettingsStore` getter — ASYNC, mirroring `get()` (`ServerSettings` lives in `Arc<tokio::sync::RwLock<..>>`; `session_overrides()` is NOT the pattern — it reads a separate `std::sync::Mutex`, and `blocking_read` in an async context can panic):
  ```rust
  /// The enabled coding-CLI provider names (`settings.codingCli.enabledProviders`)
  /// — the resolve route's unsearched-provider computation reads this. Async
  /// because the settings tree is behind a tokio RwLock (same as `get()`).
  pub async fn coding_cli_enabled_providers(&self) -> Vec<String> {
      self.inner.read().await.coding_cli.enabled_providers.clone()
  }
  ```
  (Adjust the field path to `ServerSettings`' actual field names for `codingCli.enabledProviders` — verify in `crates/freshell-server/src/settings.rs`.)

- [ ] **Step 3: Run**

Run: `cargo test -p freshell-sessions && cargo test -p freshell-server && cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings`
Expected: ALL PASS, clean. (Every test `SessionSource` impl in the workspace compiles unchanged thanks to the defaulted trait method.)

- [ ] **Step 4: Commit**

```bash
git add crates/freshell-sessions/src/directory_index.rs crates/freshell-sessions/src/amplifier.rs crates/freshell-server/src/settings_store.rs crates/freshell-server/src/settings.rs
git commit -m "feat(sessions): scan-failure tracking + fire-and-forget refresh on SessionIndex; enabled-providers reader + Node-parity default on SettingsStore

getScanFailures()/requestRefresh() parity plumbing for the hardened
resolve route (SYNC-06). All four real sources participate in failure
tracking: direct-listed (opencode) and file-backed (claude/codex/
amplifier) root-listing failures are recorded, never silently treated
as an empty listing. Default enabledProviders now includes amplifier
(DEFAULT_ENABLED_CLI_PROVIDERS parity).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 6: Hardened wire response + route merge + production fallback wiring (degraded-path proof)

Upgrade `POST /api/sessions/resolve` to the full hardened wire shape and route semantics (`sessions-router.ts:255-316`), wire the production fallbacks to REPORT failures instead of swallowing them, and prove the degraded path on the wire. Includes the async-hygiene verification (context §5).

**Files:**
- Modify: `crates/freshell-server/src/resolve.rs` (wire struct, route merge, tests)
- Modify: `crates/freshell-server/src/main.rs` (state wiring: home_dir from the OS user home, ALWAYS-wired failure-reporting fallback closures — settings do not gate fallbacks)
- Modify: `crates/freshell-freshagent/src/claude_snapshot.rs` + `lib.rs` (add `locate_transcript_checked`)

**Interfaces:**
- Consumes: Task 3's `ResumeResolveOutcome`/`ProviderFailure`, Task 4's `opencode_session_row_by_id`, Task 5's `scan_failures()`/`request_refresh()`/`coding_cli_enabled_providers()`.
- Produces: the final wire response `{status, matches, hint, providerErrors, unsearchedProviders, homeDir}`; `freshell_freshagent::locate_transcript_checked(projects_roots: &[PathBuf], session_id: &str) -> Result<Option<PathBuf>, std::io::Error>` (roots supplied by the caller — see Step 3).

- [ ] **Step 1: Write the failing endpoint tests (in `resolve.rs`'s `#[cfg(test)]`)**

Add these; also UPDATE the existing full-body asserts (`warming_with_hint_when_index_never_published`, `exact_match_returns_full_metadata_via_the_index`, fallback tests) to the new shape — every 200 body now carries `providerErrors` (array, default empty), `unsearchedProviders` (array), and `homeDir` (present when the state carries one). To keep expectations deterministic, extend the test `state()` helper: construct `SettingsStore::load(Some(dir), vec!["claude".into(), "codex".into(), "opencode".into(), "amplifier".into()])` and set `home_dir: Some(Arc::new("/home/tester".to_string()))`. Baseline `unsearchedProviders` is `[]`: Task 5 aligned the fresh-store default to Node's four-provider `DEFAULT_ENABLED_CLI_PROVIDERS` (and its settings test asserts exactly that), so with all four enabled nothing is unsearched — assert `body["unsearchedProviders"] == serde_json::json!([])` explicitly in the first new test so a regression fails loudly.

```rust
#[tokio::test]
async fn wire_shape_carries_the_hardened_provider_health_fields() {
    let dir = temp_dir("wire");
    let index = fixture_index(vec![claude_fixture()]).await;
    let (status, body) = post(state(&dir, Some(index)), serde_json::json!({ "input": CLAUDE_ID }), true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ready");
    assert_eq!(body["providerErrors"], serde_json::json!([]));
    assert!(body["unsearchedProviders"].is_array());
    assert_eq!(body["homeDir"], "/home/tester");
}

#[tokio::test]
async fn broken_opencode_store_degrades_with_a_provider_error_never_silent_not_found() {
    // THE acceptance test (context §4): an unreadable provider store yields
    // degraded + providerErrors on the wire — matches stay empty, status is
    // NOT "ready".
    let dir = temp_dir("degraded");
    let index = fixture_index(vec![claude_fixture()]).await;
    let mut st = state(&dir, Some(index));
    // Node production parity (`sessions-resolve-router.test.ts:308-320`): the
    // opencode worker boundary strips `.code`, so the wire entry is
    // message-only — `code` must be ABSENT, not null-with-key. The production
    // closure (Step 3b) maps OpencodeByIdError to code: None accordingly.
    st.opencode_session_by_id = Some(Arc::new(|_id: &str| {
        Err(freshell_sessions::resume_resolve::ProviderFailure {
            code: None,
            message: "unable to open database file".into(),
        })
    }));
    let (status, body) = post(st, serde_json::json!({ "input": "ses_aaaaaaaaaaaaaaaaaaaaaaaaaa" }), true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "degraded");
    assert_eq!(body["matches"], serde_json::json!([]));
    assert_eq!(
        body["providerErrors"],
        serde_json::json!([{ "provider": "opencode", "message": "unable to open database file" }])
    );
}

#[tokio::test]
async fn degraded_even_with_matches_when_a_higher_priority_fallback_failed() {
    // ses_ fallback fails; the later hex token still prefix-matches the index
    // — the response carries the match AND stays degraded (no auto-resume).
    let dir = temp_dir("degmatch");
    let mut amp = claude_fixture();
    amp.provider = "amplifier".to_string();
    amp.session_id = "417e8345aaaa".to_string();
    let index = fixture_index(vec![amp]).await;
    let mut st = state(&dir, Some(index));
    st.opencode_session_by_id = Some(Arc::new(|_id: &str| {
        Err(freshell_sessions::resume_resolve::ProviderFailure { code: None, message: "locked".into() })
    }));
    let (_, body) = post(st, serde_json::json!({ "input": "ses_aaaaaaaaaaaaaaaaaaaaaaaaaa 417e8345" }), true).await;
    assert_eq!(body["status"], "degraded");
    assert_eq!(body["matches"][0]["sessionId"], "417e8345aaaa");
}

#[tokio::test]
async fn a_provider_scan_failure_reports_degraded_with_the_scan_failed_literal() {
    // Index whose direct-listed source errs → scan_failures ["opencode"] →
    // degraded + {provider:"opencode", message:"session scan failed"} even
    // though no fallback ran. Build the index from a FailingDirectSource
    // (provider_name Some("opencode"), direct_list Err) alongside the claude
    // fixture source, warm it, then post a claude-uuid input.
    /* ... assert status "degraded", providerErrors == 
       [{"provider":"opencode","message":"session scan failed"}] ... */
}

#[tokio::test]
async fn disabled_providers_are_reported_unsearched_never_as_errors() {
    // Settings with enabledProviders ["claude"]: unsearchedProviders lists
    // the other three; a scan failure for DISABLED opencode is excluded from
    // providerErrors and the response stays "ready".
    /* build the settings file under dir/.freshell/ the way settings_store
       tests do, with codingCli.enabledProviders = ["claude"]; reuse the
       FailingDirectSource index; assert status "ready", providerErrors [],
       unsearchedProviders containing "codex","opencode","amplifier" */
}

#[tokio::test]
async fn disabled_provider_indexed_sessions_do_not_resolve() {
    // Node's INDEX excludes disabled providers (session-indexer.ts:1454-1467),
    // so its resolution never sees their sessions (resolve-session.ts:85).
    // Rust must filter the snapshot by the live enabled set BEFORE core
    // resolution — a disabled provider's session resolving while that provider
    // is listed in unsearchedProviders would be self-contradictory.
    /* settings file with codingCli.enabledProviders = ["claude"]; index a
       CODEX session under a v4 UUID; post that UUID (no fallbacks wired) →
       status "ready", matches [], unsearchedProviders contains "codex" */
}

#[tokio::test]
async fn a_disabled_provider_exact_id_still_resolves_via_fallback_node_parity() {
    // Node wires ALL FOUR providers' exact-id fallbacks unconditionally
    // (server/index.ts wiring; resolve-session.ts:127-156 invokes them
    // regardless of settings) — settings gate INDEXING only. A disabled
    // opencode's exact ses_ id must therefore still resolve via the fallback,
    // while "opencode" stays listed in unsearchedProviders.
    /* settings file with codingCli.enabledProviders = ["claude"]; empty index;
       wire st.opencode_session_by_id returning a hit for SES_ID; post SES_ID →
       status "ready", matches[0].sessionId == SES_ID,
       unsearchedProviders contains "opencode" */
}

#[tokio::test]
async fn degraded_response_schedules_a_refresh_and_retry_converges() {
    // request_refresh() wiring proof END-TO-END (sessions-router.ts:293-305
    // parity): a degraded response fire-and-forgets a refresh, so once the
    // provider recovers, a client Retry converges back to ready.
    /* reuse the FailingDirectSource index with its AtomicBool `broken` handle;
       post once → assert status "degraded" (this response called
       request_refresh()); set broken=false; then POLL: re-post the same input
       (each degraded response re-schedules a refresh) until status == "ready"
       with providerErrors [] within 2s (wait_until-style loop over posts);
       assert convergence rather than sleeping once */
}
```

For the five commented tests (`a_provider_scan_failure_reports_degraded_with_the_scan_failed_literal`, `disabled_providers_are_reported_unsearched_never_as_errors`, `disabled_provider_indexed_sessions_do_not_resolve`, `a_disabled_provider_exact_id_still_resolves_via_fallback_node_parity`, `degraded_response_schedules_a_refresh_and_retry_converges`), write the bodies fully in the same style as the snippets above — the `FailingDirectSource` is the Task-5 `FlakySource` test source (keep its toggleable `AtomicBool` so the refresh-convergence test can flip it to recovered; the tests that only need a fixed failure just leave it broken), and the settings file seeding writes `dir/.freshell/config.json` containing the WRAPPED document `{"version":1,"settings":{"codingCli":{"enabledProviders":["claude"]}}}` (`SettingsStore` reads `<home>/.freshell/config.json` and unwraps the top-level `settings` key — see `load_full_settings` in `settings_store.rs`; there is NO `settings.json` and a bare `codingCli` object would be ignored, silently reading defaults).

Run: `cargo test -p freshell-server` — expected FAIL/compile-error (new state fields, wire fields missing).

- [ ] **Step 2: Implement the wire + route merge in `resolve.rs`**

- Extend `ResolveState`:
  ```rust
  pub home_dir: Option<Arc<String>>,
  ```
- Replace the Task-3 `LegacyWire` with the final wire struct (field order = the Node route's object literal, `sessions-router.ts:306-314`):
  ```rust
  /// Wire response (`ResumeResolveResponseSchema`): the core outcome plus the
  /// router-level provider-health fields. `providerErrors`/`unsearchedProviders`
  /// are always present (zod defaults exist for legacy tolerance, but Node
  /// always sends them); `homeDir` is omitted only when the server has no
  /// resolvable home.
  #[derive(serde::Serialize)]
  #[serde(rename_all = "camelCase")]
  struct ResolveWireResponse {
      status: ResumeResolveStatus,
      matches: Vec<ResumeResolveMatch>,
      hint: Option<ResumeHint>,
      provider_errors: Vec<ResumeResolveProviderError>,
      unsearched_providers: Vec<String>,
      #[serde(skip_serializing_if = "Option::is_none")]
      home_dir: Option<String>,
  }
  ```
- After the `spawn_blocking` join: a `JoinError` means the resolver PANICKED — return `500 INTERNAL_SERVER_ERROR` with a JSON error body (the router's standard error shape), NOT a fabricated ready-empty result. The hardened contract forbids presenting an unsearchable state as a healthy "not found"; masking a crashed locator/query as ready-empty is exactly the incident class this plan closes. RECORDED DEVIATION (state it in the module doc): Node has no defined behavior here — a top-level resolver throw becomes an unhandled rejection in the async Express 4 handler (no response at all), so the explicit 500 is the honest port, not a wire mismatch. Update the pre-existing panic-fallback test (it currently pins ready-empty-on-JoinError) to assert the 500. Then, on the `Ok(outcome)` path, merge exactly like the Node route:
  ```rust
  /// `KNOWN_RESUME_PROVIDERS` = `DEFAULT_ENABLED_CLI_PROVIDERS`
  /// (`shared/coding-cli-defaults.ts:3`).
  const KNOWN_RESUME_PROVIDERS: [&str; 4] = ["claude", "codex", "opencode", "amplifier"];

  // Read the enabled set BEFORE dispatching the core resolve, and FILTER the
  // snapshot with it: Node's index EXCLUDES disabled providers at scan time
  // (session-indexer.ts:1454-1467), so its resolution never sees their
  // sessions (resolve-session.ts:85). The Rust SessionIndex is built with all
  // four sources unconditionally, so the route must apply the equivalent gate
  // — otherwise a disabled provider's indexed session resolves while the same
  // response lists that provider under unsearchedProviders. Fallbacks stay
  // UNGATED (Node invokes all wired exact-id fallbacks regardless of
  // settings — resolve-session.ts:127-156).
  let enabled: std::collections::HashSet<String> =
      state.settings.coding_cli_enabled_providers().await.into_iter().collect();
  // ... before the spawn_blocking call: if the snapshot is Some(sessions),
  // retain only sessions whose provider is in `enabled` (warming stays None);
  // pass the FILTERED list into resolve_resume_input ...
  let unsearched_providers: Vec<String> = KNOWN_RESUME_PROVIDERS
      .iter()
      .filter(|name| !enabled.contains(**name))
      .map(|name| (*name).to_string())
      .collect();
  // Scan failures: enabled-only, fallback errors win the dedupe (more
  // specific code/message). Disabled+failed must NOT stick degraded forever.
  let mut provider_errors = outcome.provider_errors;
  if let Some(index) = state.session_index.as_ref() {
      for name in index.scan_failures() {
          if !enabled.contains(&name) || provider_errors.iter().any(|e| e.provider == name) {
              continue;
          }
          provider_errors.push(ResumeResolveProviderError {
              provider: name,
              code: None,
              message: Some("session scan failed".to_string()),
          });
      }
  }
  let status = match outcome.status {
      ResumeResolveStatus::Warming => ResumeResolveStatus::Warming,
      _ if !provider_errors.is_empty() => ResumeResolveStatus::Degraded,
      _ => ResumeResolveStatus::Ready,
  };
  if status == ResumeResolveStatus::Degraded {
      if let Some(index) = state.session_index.as_ref() {
          index.request_refresh();
      }
  }
  Json(ResolveWireResponse {
      status,
      matches: outcome.matches,
      hint: outcome.hint,
      provider_errors,
      unsearched_providers,
      home_dir: state.home_dir.as_ref().map(|h| h.as_str().to_string()),
  })
  .into_response()
  ```
- Update the module doc's behavior-contract bullet list with the new fields and the degraded semantics (one bullet each).

- [ ] **Step 3: Failure-reporting production closures + checked claude locator**

3a. `crates/freshell-freshagent/src/claude_snapshot.rs` — add alongside `locate_transcript` (which stays, other consumers depend on it):

```rust
/// Error-AWARE variant of [`locate_transcript`] for the resolve endpoint's
/// provider-health channel (#586 parity): an unreadable claude store must
/// surface as a provider error, never a silent miss. A missing projects dir
/// (`NotFound`) is a genuine miss for that root; any OTHER io error
/// propagates.
///
/// The projects roots are a PARAMETER, exactly like Node's locator takes
/// `projectsDir` (`claude-transcript-locator.ts:65-67`) — the CALLER resolves
/// the environment. Do NOT resolve roots via `claude_home_candidates()`
/// here: that helper adds `CLAUDE_CONFIG_DIR` and bare-`CLAUDE_HOME` roots
/// that Node's resolver (`getSessionRoots()` = `getClaudeHome()/projects`,
/// `providers/claude.ts:524-535`, `server/claude-home.ts:4-7`) and the Rust
/// session index intentionally exclude — with an explicit `CLAUDE_HOME`
/// override it would expose transcripts from a root Node never searches.
/// Parameterizing the roots also keeps the unit tests hermetic: they pass
/// temp dirs and never mutate process-global env.
///
/// Traversal order is Node's GLOBAL two-pass order
/// (`claude-transcript-locator.ts:69-88`): PASS 1 probes the DIRECT layout
/// across ALL roots, then PASS 2 probes the subagent layout across all roots
/// — NOT per-root direct+subagent. (With roots `[A, B]`: A direct, B direct,
/// A subagent, B subagent.)
pub fn locate_transcript_checked(
    projects_roots: &[PathBuf],
    session_id: &str,
) -> Result<Option<PathBuf>, std::io::Error> {
    // PASS 1 — direct layout across all roots.
    for projects in projects_roots {
        if let Some(path) = find_transcript_checked_direct(projects, session_id)? {
            return Ok(Some(path));
        }
    }
    // PASS 2 — subagent layout, only when the direct layout missed everywhere.
    for projects in projects_roots {
        if let Some(path) = find_transcript_checked_subagent(projects, session_id)? {
            return Ok(Some(path));
        }
    }
    Ok(None)
}
```

and `find_transcript_checked_direct` / `find_transcript_checked_subagent` helpers (one per Node layout pass) that are `find_transcript` with error propagation: same id-shape guard (returns `Ok(None)`), then

```rust
/// Node parity (`claude-transcript-locator.ts:33-37`): expected absence is
/// `ENOENT || ENOTDIR` — a missing dir OR a non-directory path component is
/// a genuine miss; everything else is a provider failure.
fn is_expected_absence(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
    )
}

let entries = match std::fs::read_dir(&projects) {
    Ok(entries) => entries,
    Err(e) if is_expected_absence(&e) => return Ok(None),
    Err(e) => return Err(e),
};
```

and the scan must construct the AUTHORITATIVE Node candidate layouts (`server/coding-cli/claude-transcript-locator.ts:39-48`): the direct helper probes `<projects>/<project-dir>/<id>.jsonl`, the subagent helper probes `<projects>/<project-dir>/<parent-session>/subagents/<id>.jsonl` — and the caller runs the direct pass across ALL roots before ANY subagent probing (Node's global two-pass order above). CAUTION: the existing `find_transcript` probes `<project-dir>/<subdir>/<id>.jsonl` WITHOUT the `subagents` segment — that diverges from Node and misses child sessions; do NOT mirror it. The checked variant uses the Node layout (leave `find_transcript` itself untouched for its other consumers). Propagate errors that are not expected-absence (`is_expected_absence` above — NotFound OR NotADirectory, Node's `ENOENT || ENOTDIR`) from every `read_dir`, and probe candidate files with `std::fs::metadata` (expected absence ⇒ miss for that candidate; any OTHER error propagates) instead of the error-swallowing `Path::is_file()`.

Also add `transcript_cwd_checked(path: &Path) -> Result<Option<String>, std::io::Error>` beside `transcript_cwd` (which stays for other consumers): open error of expected-absence kind ⇒ `Ok(None)` (a raced deletion keeps the hit, cwd-less — Node behaves the same); any OTHER open/read error PROPAGATES (Node wraps these in `ClaudeTranscriptLocatorError`); malformed JSON lines are still skipped. BOUNDED READ (Node parity — `CWD_SCAN_BYTES = 64 * 1024`, `claude-transcript-locator.ts:30-31,131-135`): read AT MOST the first 64 KiB of the file (e.g. `std::io::Read::take(64 * 1024)` into a buffer), split that prefix on `\n`, and attempt to parse EVERY segment INCLUDING the final one — Node's `head.split('\n')` loop (`claude-transcript-locator.ts:141-149`) has no discard-the-truncated-tail rule: a fragment cut off at the 64 KiB boundary simply fails `JSON.parse` and is skipped by the `catch`, while a COMPLETE final line with no trailing newline (e.g. the last line of a small transcript) still parses. Do NOT drop the final segment. Parse each segment as JSON and return the first non-empty string `cwd`. Do NOT mirror the existing `transcript_cwd`'s unbounded `BufRead::lines()` loop — one resolve request against a multi-GB transcript (or a single enormous line) must not allocate or scan past the 64 KiB prefix. The 3b wiring below uses the checked variant — without it the "no longer swallowed" commit claim would be false, since `transcript_cwd` converts read errors to `None`.

Re-export `locate_transcript_checked` and `transcript_cwd_checked` from `lib.rs` next to `locate_transcript`. Unit tests in the same file's test module — HERMETIC BY CONSTRUCTION: every test builds a temp projects dir and passes it via the `projects_roots` parameter; NO test mutates process-global env (`CLAUDE_HOME`/`CLAUDE_CONFIG_DIR`/`HOME`), so there is nothing to race against the crate's many existing env-mutating claude tests. (If a future test ever DOES need env mutation, it must hold the crate's shared `CLAUDE_ENV_LOCK` (`claude.rs`) and use the panic-safe `EnvVarsRestore` Drop-guard pattern (`claude_snapshot.rs:531-569`) — but none of the tests below need it.) The tests: (a) gate the permission test with `#[cfg(unix)]` (`std::os::unix::fs::PermissionsExt` does not exist on Windows — an ungated test would not COMPILE there): chmod the projects dir to `0o000`, then FIRST probe `std::fs::read_dir(&projects)` directly — if the probe unexpectedly SUCCEEDS (running as root / CAP_DAC_OVERRIDE bypasses mode bits), restore permissions, `eprintln!("skipping: euid bypasses permission checks");` and `return`; otherwise assert `locate_transcript_checked` yields `Err` with `kind() == PermissionDenied`; restore permissions afterward so cleanup works; (b) a missing projects dir yields `Ok(None)`; (c) a transcript placed at `<projects>/<project>/<parent>/subagents/<id>.jsonl` IS found by `locate_transcript_checked` (the child-session layout); (d) ENOTDIR absence parity: a candidate path whose component is a REGULAR FILE (e.g. `<projects>/<project>` created as a file, so descending into it fails with `NotADirectory`) yields `Ok(None)`, not `Err` — Node reports a normal miss for `ENOTDIR` (`claude-transcript-locator.ts:33-37`); (e) bounded cwd scan: a transcript whose only `cwd`-bearing JSON line starts BEYOND the first 64 KiB (pad with ~65 KiB of valid no-cwd JSONL first) makes `transcript_cwd_checked` return `Ok(None)` — proving the 64 KiB prefix bound, Node parity; (f) two-pass precedence: the SAME id present at BOTH the direct layout in one root AND the subagent layout — with a single root, and again with two roots where root A holds only the subagent copy and root B holds the direct copy — `locate_transcript_checked` returns the DIRECT path (B's direct copy beats A's subagent copy: pass 1 exhausts ALL roots first, Node's global order); (g) final-fragment parse parity: a transcript SMALLER than 64 KiB whose ONLY `cwd`-bearing JSON line is the LAST line and has NO trailing newline → `transcript_cwd_checked` returns `Ok(Some(cwd))` (Node's `split('\n')` parses the final segment); (h) truncated-tail tolerance: a JSON object that STRADDLES the 64 KiB boundary (starts inside the prefix, ends beyond it) is skipped without error — `Ok(None)` when no earlier line carries a cwd.

3b. `crates/freshell-server/src/main.rs` — final wiring (replaces the Task-3/4 temporaries). Above the router construction:

```rust
// Resolve fallbacks mirror Node's buildResolveFallbacks over the FIXED
// provider registry (server/index.ts wires ALL FOUR codingCliProviders into
// it unconditionally): settings do NOT gate the exact-id fallbacks — they
// only gate INDEXING and feed unsearchedProviders. Both closures are
// therefore ALWAYS wired; gating them on boot-time settings would produce
// false misses after a live settings change and diverge from Node for
// disabled-provider exact IDs.

/// Wire error code for a provider-error summary. Node preserves the ORIGINAL
/// `cause.code` VERBATIM (`ClaudeTranscriptLocatorError`,
/// `claude-transcript-locator.ts:19-27`): EPERM stays EPERM, EIO stays EIO.
/// So derive the symbolic errno name from the RAW OS errno — do NOT map from
/// `ErrorKind`, which would collapse EPERM into EACCES and drop EIO/EMFILE
/// entirely. `libc` is already a freshell-server dependency
/// (`crates/freshell-server/Cargo.toml`).
#[cfg(unix)]
fn errno_code(err: &std::io::Error) -> Option<String> {
    let raw = err.raw_os_error()?;
    let name = match raw {
        libc::EACCES => "EACCES",
        libc::EPERM => "EPERM",
        libc::ENOENT => "ENOENT",
        libc::ENOTDIR => "ENOTDIR",
        libc::EIO => "EIO",
        libc::EMFILE => "EMFILE",
        libc::ENFILE => "ENFILE",
        libc::ELOOP => "ELOOP",
        libc::ENAMETOOLONG => "ENAMETOOLONG",
        libc::EBADF => "EBADF",
        libc::EINVAL => "EINVAL",
        _ => return None, // unknown errno ⇒ omit code, keep the message
    };
    Some(name.to_string())
}

/// Non-unix fallback: `raw_os_error()` is a Win32 code there, not an errno;
/// map the coarse kinds Node's libuv also names. (The resolve fallbacks'
/// primary target is unix; parity of the fine-grained codes is a unix
/// concern.)
#[cfg(not(unix))]
fn errno_code(err: &std::io::Error) -> Option<String> {
    match err.kind() {
        std::io::ErrorKind::PermissionDenied => Some("EACCES".to_string()),
        std::io::ErrorKind::NotFound => Some("ENOENT".to_string()),
        _ => None,
    }
}
```

Unit tests for `errno_code` in `main.rs`'s (or the module's) `#[cfg(test)]` module, `#[cfg(unix)]`-gated: `io::Error::from_raw_os_error(libc::EPERM)` → `Some("EPERM")` (NOT `"EACCES"` — both map to `ErrorKind::PermissionDenied`, which is exactly why the kind-based mapping was wrong), `from_raw_os_error(libc::EACCES)` → `Some("EACCES")`, `from_raw_os_error(libc::EIO)` → `Some("EIO")`, and a synthetic `io::Error::new(ErrorKind::PermissionDenied, "no raw errno")` → `None`.

State fields:

```rust
// Node sends os.homedir() (`sessions-router.ts:306-314`) — the USER's home.
// Do NOT reuse resolve_home(): it prefers FRESHELL_HOME, a config/storage
// root that can differ from the real home, and the dialog would prefill a
// cwd-less resume into the wrong directory.
home_dir: std::env::var_os("HOME")
    .or_else(|| std::env::var_os("USERPROFILE"))
    .map(|h| Arc::new(h.to_string_lossy().into_owned())),
opencode_session_by_id: Some({
    std::sync::Arc::new(|session_id: &str| {
        let data_home = freshell_sessions::parse::default_opencode_data_home();
        freshell_sessions::parse::opencode_session_row_by_id(&data_home, session_id)
            .map(|row| {
                row.map(|r| freshell_sessions::resume_resolve::OpencodeByIdHit {
                    session_id: r.session_id,
                    cwd: r.cwd,
                    title: r.title,
                    last_activity_at: r.last_activity_at,
                })
            })
            .map_err(|e| {
                // Node production parity: the opencode worker boundary STRIPS
                // `.code` — the worker serializes only {name, message}
                // (`opencode-by-id.worker.ts:41-42`) and the runner rebuilds
                // the Error without it (`opencode-by-id-runner.ts:103-106`),
                // so Node's wire entry is message-only
                // (`sessions-resolve-router.test.ts:308-320`). Emitting
                // SQLITE_* codes here would DIVERGE from Node. Task 4's
                // OpencodeByIdError still carries the code — log it
                // (structured, with provider + code) for diagnosability,
                // then drop it from the wire.
                tracing::warn!(provider = "opencode", code = ?e.code, message = %e.message, "opencode by-id lookup failed");
                freshell_sessions::resume_resolve::ProviderFailure {
                    code: None,
                    message: e.message,
                }
            })
    }) as crate::resolve::OpencodeByIdLookup
}),
locate_claude_transcript: Some({
    std::sync::Arc::new(|session_id: &str| {
        let lowered = session_id.to_ascii_lowercase();
        // Node-parity root (`server/claude-home.ts:4-7` +
        // `providers/claude.ts:524-535`): CLAUDE_HOME (non-empty) else
        // $HOME/.claude, joined with "projects" — the SAME root the Rust
        // session index uses (`session_directory::claude_home`). Note
        // CLAUDE_HOME alone suffices even when HOME is unset (Node's
        // getClaudeHome() honors it directly); no root ⇒ Ok(None), a miss.
        let claude_home = match std::env::var("CLAUDE_HOME").ok().filter(|v| !v.is_empty()) {
            Some(v) => Some(std::path::PathBuf::from(v)),
            None => std::env::var("HOME")
                .ok()
                .filter(|v| !v.is_empty())
                .map(|h| std::path::PathBuf::from(h).join(".claude")),
        };
        let roots: Vec<std::path::PathBuf> = match claude_home {
            Some(h) => vec![h.join("projects")],
            None => return Ok(None),
        };
        match freshell_freshagent::locate_transcript_checked(&roots, &lowered) {
            Ok(Some(path)) => match freshell_freshagent::transcript_cwd_checked(&path) {
                Ok(cwd) => Ok(Some(freshell_sessions::resume_resolve::ClaudeTranscriptHit {
                    cwd,
                    session_id: lowered,
                })),
                Err(e) => Err(freshell_sessions::resume_resolve::ProviderFailure {
                    code: errno_code(&e),
                    message: format!("Claude transcript read failed: {e}"),
                }),
            },
            Ok(None) => Ok(None),
            Err(e) => Err(freshell_sessions::resume_resolve::ProviderFailure {
                code: errno_code(&e),
                message: format!("Claude transcript scan failed: {e}"),
            }),
        }
    }) as crate::resolve::ClaudeLocator
}),
```

- [ ] **Step 4: Async-hygiene verification (context §5 — verify, don't assume)**

Confirm and record (in the commit message body): the ENTIRE `resolve_resume_input` call — including both blocking fallback closures (rusqlite query, transcript directory walk) — runs inside `tokio::task::spawn_blocking` (`resolve.rs`, the Task-3-preserved block), so no DB/FS wait ever blocks the async runtime; per-request work is bounded by `MAX_RESUME_CANDIDATES (8) × FALLBACK_BUDGET_PER_REQUEST (2 per provider)` fallback calls + one index scan per token. Grep that no OTHER call path invokes these closures outside `spawn_blocking`: `grep -rn "opencode_session_by_id\|locate_claude_transcript" crates/freshell-server/src/ --include=*.rs`. Add one sentence to `resolve.rs`'s module doc stating this invariant so future edits keep it.

- [ ] **Step 5: Run**

Run:
```bash
set -o pipefail
cargo test -p freshell-server && cargo test -p freshell-freshagent
cargo test --workspace 2>&1 | grep -E '^test result:'
cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings
```
Expected: ALL PASS (every `test result:` line shows `0 failed`), fmt/clippy clean. (`set -o pipefail` keeps a failing `cargo test` from exiting through `grep`'s success status.)

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-server/src/resolve.rs crates/freshell-server/src/main.rs crates/freshell-freshagent/src/
git commit -m "feat(server): hardened resolve wire — providerErrors/unsearchedProviders/homeDir, scan-failure merge, degraded fire-and-forget refresh

POST /api/sessions/resolve now emits the full #586 contract; production
fallbacks report failures (checked claude locator, propagating opencode
by-id) instead of swallowing them; degraded-path proven on the wire
(broken store -> degraded + providerErrors, never silent not-found).
Async hygiene verified: all blocking fallback IO runs inside the
endpoint's spawn_blocking; work bounded by cap-8 candidates x budget-2
fallbacks. (SYNC-06)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 7: Full verification, shared e2e 2× both projects, SYNC-06 checklist evidence, push

The `sessionResolve` flag and the shared client dialog's resume HAPPY PATH are proven by the SHARED e2e spec running against BOTH server kinds. Scope honesty: `resume-button.spec.ts` has exactly 3 tests (pinned-button visibility at scroll positions, mobile visibility, paste-then-Enter exact resume) — it does NOT exercise degraded UI, manual retry, or homeDir prefill. Those hardened behaviors are proven at the WIRE level by Task 6's endpoint tests, and by the shared client's own #586 coverage (unchanged by this branch, but EXECUTED here — Step 2 runs `test:client`, which includes `ResumeSessionDialog.test.tsx`'s degraded/retry/homeDir/unsearched tests, and the shared contract test). Then record the evidence and push.

**Files:**
- Modify: `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md` (SYNC-06 entry, line ~803)
- No source changes expected; any failure discovered here is fixed by amending the responsible earlier area with its own test-first micro-cycle.

**Interfaces:**
- Consumes: all previous tasks' work, committed.
- Produces: green full-matrix evidence + updated checklist + pushed branch.

- [ ] **Step 1: Rust full gate**

Run:
```bash
set -o pipefail
cargo test --workspace 2>&1 | grep -E '^test result:'
cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings
```
Expected: every `test result:` line shows `0 failed`; fmt/clippy clean. (`set -o pipefail` keeps a failing `cargo test` from exiting through the pipe with `grep`'s success status.) Cargo prints one `test result:` line PER TEST BINARY and no workspace aggregate — record the checklist's total passed count by SUMMING the `N passed` figures across the printed lines.

- [ ] **Step 2: Coordinated TS suites**

Run:
```bash
npm run test:status
npm run test:vitest -- --config config/vitest/vitest.config.ts test/unit/shared/resume-input-parser.test.ts test/unit/shared/resume-resolve-contract.test.ts --run
npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/resolve-session.test.ts test/unit/server/coding-cli/resolve-fallbacks.test.ts test/integration/server/sessions-resolve-router.test.ts --run
npm run test:client
```
Expected: ALL PASS (the branch did not modify Node server or client code; these prove no accidental TS regressions). The last two runs are VERIFICATION EVIDENCE for the hardened UI claims, not optional: `resume-resolve-contract.test.ts` proves the shared wire contract (degraded/providerErrors/unsearchedProviders/homeDir/legacy tolerance) the Rust server now emits, and `test:client` (the coordinator's `test/unit/client` suite) EXECUTES `ResumeSessionDialog.test.tsx` — warming/manual retry, degraded display + no auto-resume, homeDir prefill, unsearched-provider messaging. Citing those tests without running them is not evidence. If `test:status` reports another session's run in progress, WAIT — never kill processes you did not spawn.

- [ ] **Step 3: Shared e2e, both projects, twice**

Sanity-check first that the flag declaration still stands: `grep -n "sessionResolve" crates/freshell-server/src/main.rs` — expected: present in `build_platform_payload`.

Run TWICE (the config's own server management uses ephemeral ports/HOMEs — verify no `--port 3001/3002` style overrides leak in via env before running). The explicit `--project` filters are REQUIRED: without them the default `chromium` project also matches this spec and each run would be 9 tests, not 6:
```bash
npm run test:e2e -- resume-button.spec.ts --project=legacy-chromium --project=rust-chromium
npm run test:e2e -- resume-button.spec.ts --project=legacy-chromium --project=rust-chromium
```
Expected: all 3 tests × both projects (legacy-chromium AND rust-chromium) pass, both runs — 6/6 each run. This is the acceptance proof that the shared dialog's resume happy path (paste-then-Enter exact resume) and the `sessionResolve` flag work identically against the Rust server; the hardened degraded/retry/homeDir behaviors are proven at the wire level by Task 6's endpoint tests (this spec does not exercise them).

- [ ] **Step 4: Update the SYNC-06 checklist entry (PARTIAL convention)**

In `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md`, append a NEW `PARTIAL` bullet under the SYNC-06 item, directly after the existing `PARTIAL (2026-07-30, commit c38422a0)` bullet, following that bullet's exact style:

```markdown
  - PARTIAL (2026-07-30, hardened-contract follow-up, commit `<HEAD short sha>`): rebased onto `f903e8a6` (#586) and closed the hardening delta. Contract: `status` gains `degraded`; `providerErrors`/`unsearchedProviders`/`homeDir` on the wire (`crates/freshell-server/src/resolve.rs`). Ranking: per-token exact→fallback→prefix, ses_ case-SENSITIVE, subagents excluded from prefix discovery, sessionType provider-default. Parser: known-family prefix regex + MAX_RESUME_CANDIDATES=8, pinned by the EXTENDED shared fixture `test/fixtures/resume-input/parser-cases.json` (<N> cases; TS test restored to fixture-driven form) green on BOTH parsers. Provider health: broken opencode store → degraded + providerErrors on the wire (never silent not-found), scan-failure channel + disabled→unsearched, degraded fire-and-forget refresh; hardened by-id row query (archived+child, errors propagate). Async hygiene: all fallback IO inside spawn_blocking, work bounded by cap-8×budget-2. `cargo test --workspace`: <N> passed, 0 failed; fmt+clippy clean. E2E: `resume-button.spec.ts` green on BOTH projects, 2 runs each (<N>/<N> per run). MISSING: the `PW-TAURI-WIN` (native Windows WebView2) half remains out of scope, per the SYNC-05/SAFE-11 PARTIAL convention.
```

Replace every `<N>`/`<HEAD short sha>` with the REAL numbers/sha from Steps 1–3 (they are evidence, not boilerplate — copy them from the actual command output).

- [ ] **Step 5: Commit and push (NO PR)**

```bash
git add docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md
git commit -m "docs: record SYNC-06 hardened-contract parity evidence in completion checklist

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
git push -u origin feat/rust-resolve-parity
```

Expected: push succeeds (the branch was local-only; this creates the remote branch). Do NOT open a pull request — that requires explicit user approval.

---

## Self-Review Record

**1. Spec coverage** (context §"The delta to close" → tasks): §1 CONTRACT (degraded/providerErrors/unsearchedProviders/homeDir, camelCase, backward-tolerant) → Tasks 3+6. §2 RANKING (per-token exact→fallback→prefix, ses_ case-sensitive, subagents, sessionType default) → Task 3. §3 PARSER (known-family regex, cap-8, fixture extended, both sides pass) → Task 2. §4 PROVIDER HEALTH (degraded never-silent, disabled→unsearched, degraded-even-with-matches, match-cap verified: hardened Node keeps `RESOLVE_MATCH_CAP = 20`, so the branch's cap-20 pin stands) → Tasks 3+5+6. §5 ASYNC HYGIENE → Task 6 Step 4. §6 WARMING (core + wire tests, Tasks 3+6) + shared dialog happy-path via shared e2e → Task 7 (degraded/retry/homeDir UI proven at the wire by Task 6 AND by the EXECUTED shared client suite — Task 7 Step 2 runs `test:client`, which includes `ResumeSessionDialog.test.tsx`, plus the shared contract test; the e2e spec covers visibility + exact resume only). Acceptance items: rebase done (verified Task 1), fixture both-sides (Task 2), mirror suite updated (Task 3), degraded-path wire test (Task 6), e2e 2× both (Task 7), cargo+TS green (Tasks 1–7), SYNC-06 PARTIAL update (Task 7), branch pushed / no PR (Task 7). No unresolved coverage gaps.

**1b. No silent deferrals:** Injected-closure tests in Tasks 3/6 are complemented by production-behavior proof: Task 4 tests hit REAL sqlite files (corrupt/missing/locked classes, with the SQLITE_* codes asserted on the INTERNAL `OpencodeByIdError` — the wire deliberately carries message-only opencode errors, matching Node's worker boundary which strips `.code` in production (`opencode-by-id.worker.ts:41-42`, `opencode-by-id-runner.ts:103-106`); the endpoint test asserts the code-ABSENT wire shape and the internal code feeds structured logs), Task 6 Step 3 wires the REAL closures with failure reporting and tests the checked locator against a real unreadable directory, and Task 7's shared e2e exercises the full production path against the real Rust server. The one intentionally-remaining gap (PW-TAURI-WIN) is the checklist's long-standing recorded convention, explicitly restated — not a new deferral introduced by this plan.

**2. Placeholder scan:** Task 4 Step 1 and Task 6 Step 1 contain two test bodies described by full behavioral specification + fixture pattern reference rather than verbatim code (`scan_failure` literal test, disabled-provider test, opencode row-fixture bodies); each names the exact fixture pattern file to copy, the exact inputs, and the exact expected JSON/values — the implementer writes mechanical rusqlite/axum plumbing only. Checklist `<N>` slots are run-time evidence by design. No TBD/TODO/"handle edge cases" items remain.

**3. Type consistency check:** `ResumeResolveOutcome{status,matches,hint,provider_errors}` produced in Task 3 = consumed in Task 6. `OpencodeByIdHit{session_id,cwd,title,last_activity_at}` (Task 3) is built from `OpencodeByIdRow` (Task 4) in Task 6's closure — field names verified 1:1. `ProviderFailure{code,message}` used identically in Tasks 3/4/6. `scan_failures()->Vec<String>`, `request_refresh()`, `async coding_cli_enabled_providers()->Vec<String>` (Task 5) match Task 6's call sites (awaited in the async route/main). `MAX_RESUME_CANDIDATES` (Task 2) referenced in Task 6's hygiene note. State field `opencode_session_by_id` renamed once in Task 3 and used consistently after.
