# Title Model Bump + 1k/1k Prompt Input Trim Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Bump the Rust server's pinned Gemini session-title model from `gemini-2.5-flash-lite` to `gemini-3.5-flash-lite`, and change the title-prompt input windowing so a first user message over 2000 chars contributes its first 1000 chars + `\n...[trimmed]...\n` + last 1000 chars instead of its first 2000 chars.

### Explicit constraints
- Only the two changes above; explicitly do NOT rewrite the default title prompt, do NOT add low-signal-opener deferral or second-message waiting, do NOT add an opencode placeholder grace window, and do NOT touch the no-op rename `user`-source behavior.
- Rust-only changes: `server/` (Node, obsolete) and its tests must not be modified, including `test/unit/server/ai-prompts.test.ts` and `test/e2e-browser/helpers/harness-06/fake-ai.test.ts`.
- Work entirely in `.worktrees/title-gemini-35-trim` on branch `the-usual/title-gemini-35-trim`; never in the main checkout.
- Red-green-refactor TDD with focused tests; repo test coordinator rules honored; never run Playwright e2e or `npm run build` from the main checkout.
- No PR creation, no merge, no production restart or deploy.

### Accepted tradeoffs and residuals
- `GEMINI_MODEL` is shared by the title and terminal-summary calls; the bump therefore changes the summarization model too — accepted; a single pinned model is the existing design.
- The vague "Agent X" title attractor is accepted as mitigated by the model bump alone (empirical: same prompt, gemini-2.5-flash-lite drew `Agent Design` 1/3 and `Agent Status` 2/3 against the two production inputs; gemini-3.5-flash-lite produced topic-first titles 5/5 and honest low-signal titles 3/3 on the same inputs). Prompt rewrite remains deferred and out of scope.
- `gemini-3.5-flash-lite` availability for the configured Gemini key was verified empirically this session (models list + five generateContent replays); no availability/fallback handling changes are in scope.
- The explicit pin `gemini-3.5-flash-lite` is chosen over the `gemini-flash-lite-latest` alias for reproducibility.

**Goal:** New coding-agent sessions are titled by `gemini-3.5-flash-lite`, and title prompts built from over-2000-char first messages carry both ends of the message with an explicit `[trimmed]` marker instead of a blind prefix truncation.

**Architecture:** Two surgical changes inside `crates/freshell-server/src/ai_title.rs`. (1) One pinned constant (`GEMINI_MODEL`) changes. Its only consumers are the Gemini `generateContent` URL builder in `GeminiHttp` and the tests; the Playwright fake-Gemini spec pins the same path and follows. (2) `build_session_title_prompt` swaps its prefix-cap for a head+tail window helper (`window_prompt_body`), unchanged for inputs ≤2000 chars. No interface changes; the two call sites (`auto_title_sweep.rs:435`, `sessions.rs:434`) are untouched.

**Tech Stack:** Rust 1.96 workspace (`freshell-server` crate, axum loopback test, rusqlite elsewhere — unaffected), Vitest/Playwright e2e (rust-chromium project) for the fake-Gemini pin.

## Global Constraints

- All commands run from `/home/dan/code/freshell/.worktrees/title-gemini-35-trim` unless noted. `npm ci --no-audit --no-fund` already completed in the worktree.
- Rust toolchain is host cargo/rustc 1.96.0 (matches workspace `rust-version = "1.96"` and CI pin; do not bump toolchains).
- Never run `npm run build` / Playwright e2e / globalSetup from the main checkout (it stomps `dist/` under the live port-3001 server). The e2e spec below runs from this worktree only.
- `server/`, `test/unit/server/ai-prompts.test.ts`, `test/e2e-browser/helpers/harness-06/fake-ai.test.ts`, and `docs/plans/2026-08-08-naming-persistence-sweep.md` are frozen — do not modify (see plan header constraints).
- Model-id pins to change are exactly four: `crates/freshell-server/src/ai_title.rs:6`, `crates/freshell-server/src/ai_title.rs:287` (loopback route literal), `test/e2e-browser/specs/auto-title-rust.spec.ts:39` (`GEMINI_GENERATE_PATH`) and `:57` (doc comment). Verified exhaustive via scoped grep (`gemini-2.5-flash-lite`, `flash-lite`, `GEMINI_MODEL` across `crates/ test/ server/ src/ config/ scripts/ shared/ port/ docs/ .github/ installers/ docker/ electron/ extensions/`); all other hits are Node-frozen or deliberately non-lite (`harness-06-misc-fixtures.spec.ts:265` uses `gemini-2.5-flash`).
- Green-base evidence: `scripts/base-gate.sh test` exit 0 at origin/main `0910d8b0`; branch point advanced to `6d5b5394c` by one test-only merge (PR #681 removes a broken e2e canary suite; no production code). Baseline ledger in run-state.
- No `docs/index.html` change (internal-only).
- Lint/format gates for the delta: `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` must pass.

---

### Task 1: Bump the pinned Gemini model to gemini-3.5-flash-lite

**Files:**
- Modify: `crates/freshell-server/src/ai_title.rs:6` (`GEMINI_MODEL` const) and `:287` (loopback route literal, inside `gemini_http_posts_expected_body_and_parses_candidates_excluding_thoughts`)
- Modify (pin-following, not production): `test/e2e-browser/specs/auto-title-rust.spec.ts:39` and `:57`

**Interfaces:**
- Consumes: existing `GeminiHttp::generate_content` URL builder `format!("{}/models/{GEMINI_MODEL}:generateContent", ...)` (`ai_title.rs:147-150`); no signature or type changes.
- Produces: unchanged interfaces. New constant value `gemini-3.5-flash-lite`.

- [ ] **Step 1: Write the failing behavioral test**

In `crates/freshell-server/src/ai_title.rs` test `gemini_http_posts_expected_body_and_parses_candidates_excluding_thoughts` (lines 283-319), change the axum route literal to the new model path:

```rust
let app = Router::new().route(
    "/v1beta/models/gemini-3.5-flash-lite:generateContent",
    post(/* existing handler body unchanged */),
);
```

No other test code changes in this step (assertions, handler body, and expected title `"Flux repair"` stay).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-server ai_title`

Expected: FAIL — `gemini_http_posts_expected_body_and_parses_candidates_excluding_thoughts` panics at `.unwrap()` because the client (still pinned to 2.5) POSTs `/v1beta/models/gemini-2.5-flash-lite:generateContent`, which the router no longer serves; `generate_content` returns `Err("gemini http 404 Not Found")` (reqwest's `StatusCode` Display appends the canonical reason) and the test's `.unwrap()` fails. The failure exists because the production URL embeds the old model id.

- [ ] **Step 3: Add the minimal production implementation**

`crates/freshell-server/src/ai_title.rs:6`:

```rust
pub const GEMINI_MODEL: &str = "gemini-3.5-flash-lite";
```

Also update the e2e pin in the same task (same behavioral surface): `test/e2e-browser/specs/auto-title-rust.spec.ts:39`

```ts
const GEMINI_GENERATE_PATH = '/v1beta/models/gemini-3.5-flash-lite:generateContent'
```

and the companion doc comment at `:57` referencing the same path (`gemini-2.5-flash-lite` → `gemini-3.5-flash-lite`).

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-server ai_title`

Expected: PASS (all `ai_title` tests including the loopback wire test).

- [ ] **Step 5: Refactor while green**

No refactor: the route literal stays hardcoded on purpose — it is the behavioral pin that goes red production-side if the URL construction regresses, and both constants must move together. `cargo fmt --all --check` afterwards.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: whole `freshell-server` crate (const is crate-visible); the changed e2e spec (its fake 404s any other path, so it directly proves the server now posts to the 3.5 path); TS typecheck for the edited spec. No other suite asserts the model id (see Global Constraints exhaustiveness note); `server/`-side pins are frozen by constraint.

Run, in order, from the worktree:

```bash
cargo test -p freshell-server
cargo build --release -p freshell-server   # mandatory pre-warm — see Expected below
npm run test:e2e -- --local --project=rust-chromium test/e2e-browser/specs/auto-title-rust.spec.ts
```

Expected: crate tests PASS; e2e spec (5 tests) PASS against the fake-Gemini pinned at the 3.5 path. Two corrections from load-bearing validation: **(a)** `npm run typecheck:server` does NOT cover `test/` (`tsconfig.server.json` includes only `server/**`+`shared/**`; no repo tsconfig typechecks e2e specs, deliberately), so it is dropped — the spec run itself is the correctness gate (esbuild load failure is loud; the fake 404s a wrong model path); **(b)** the pre-warm is mandatory: at base state the cold first e2e run fails 5/5 because the helper's release build takes ~4m45s , exceeding the 120s per-test timeout (plus a concurrent-cargo race in `test/e2e-browser/helpers/rust-server.ts:107`); the same run passes warm. The pre-warm also protects staleness: the worktree's existing release binary predates this task's edits.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-server/src/ai_title.rs test/e2e-browser/specs/auto-title-rust.spec.ts
git commit -m "feat(rust-server): pin Gemini title model to gemini-3.5-flash-lite"
```

---

### Task 2: Head+tail windowing for over-2000-char title inputs

**Files:**
- Modify: `crates/freshell-server/src/ai_title.rs` (`build_session_title_prompt` at :23-35; the char-cap note at :28-29; test `session_title_prompt_uses_default_then_custom_and_caps_message_at_2000` at :236-248)

**Interfaces:**
- Consumes: existing `build_session_title_prompt(first_message: &str, custom_prompt: Option<&str>) -> String`; existing const `PROMPT_MESSAGE_CHAR_CAP: usize = 2000` (retained as the windowing threshold).
- Produces: unchanged signature. New private items (below). New observable behavior only when `first_message.chars().count() > 2000`.

- [ ] **Step 1: Write the failing behavioral tests**

Replace the body of `session_title_prompt_uses_default_then_custom_and_caps_message_at_2000` with windowing assertions (rename the test to `session_title_prompt_windows_long_messages_and_keeps_custom_legs`):

```rust
    #[test]
    fn session_title_prompt_windows_long_messages_and_keeps_custom_legs() {
        // ≤ 2000 chars: passthrough, no marker.
        let exact = "x".repeat(PROMPT_MESSAGE_CHAR_CAP);
        let p = build_session_title_prompt(&exact, None);
        assert!(p.starts_with("Generate a title for a tab"));
        assert!(p.contains("\n\nFirst message from the user:\n"));
        assert!(!p.contains("...[trimmed]..."));
        let body = p.rsplit('\n').next().unwrap();
        assert_eq!(body.chars().count(), PROMPT_MESSAGE_CHAR_CAP);

        // 2500 chars of distinct runs: first 1000 + marker + last 1000.
        let long = format!("{}{}{}", "a".repeat(1000), "b".repeat(500), "c".repeat(1000));
        let p2 = build_session_title_prompt(&long, None);
        let expected = format!("{}\n...[trimmed]...\n{}", "a".repeat(1000), "c".repeat(1000));
        assert!(p2.ends_with(&expected));
        assert!(!p2.contains(&"b".repeat(10)));
        assert_eq!(expected.chars().count(), 2017); // 1000 + 17 + 1000

        // Char-accurate (not byte-accurate) windowing with multibyte input.
        let mb = format!("{}{}{}", "a".repeat(1500), "é".repeat(400), "z".repeat(600));
        let p3 = build_session_title_prompt(&mb, None);
        let tail_expected = format!("{}{}", "é".repeat(400), "z".repeat(600));
        assert!(p3.ends_with(&tail_expected));
        assert!(p3.contains(&format!("{}\n...[trimmed]...\n", "a".repeat(1000))));

        // Custom-prompt legs unchanged (build: customPrompt?.trim() || default).
        let c = build_session_title_prompt("hi", Some("  Custom prompt  "));
        assert!(c.starts_with("Custom prompt"));
        let d = build_session_title_prompt("hi", Some("   "));
        assert!(d.starts_with("Generate a title for a tab"));
    }
```

Note for the implementer: `rsplit('\n').next()` on the passthrough case returns the trailing message line (default prompt ends in `explanation.` and the message is injected after the last `\n`).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-server ai_title`

Expected: FAIL — the new test panics (today's prefix cap yields 2000 chars of `a…b`, no `...[trimmed]...` marker, no `c` tail). The missing behavior is the head+tail window.

- [ ] **Step 3: Add the minimal production implementation**

In `crates/freshell-server/src/ai_title.rs`:

```rust
/// Over `PROMPT_MESSAGE_CHAR_CAP` chars, keep the first and last 1000 chars of
/// the message with an explicit elision marker instead of prefix-truncating.
/// NOTE: char-counted, not byte/UTF-16 — the same deliberate divergence as the
/// heuristic truncation in `extract_title_from_message` (sessions.rs),
/// consistent across surfaces.
const PROMPT_MESSAGE_WINDOW_EDGE_CHARS: usize = 1000;
const TRIMMED_MARKER: &str = "\n...[trimmed]...\n";

fn window_prompt_body(first_message: &str) -> String {
    let total = first_message.chars().count();
    if total <= PROMPT_MESSAGE_CHAR_CAP {
        return first_message.to_string();
    }
    let head: String = first_message
        .chars()
        .take(PROMPT_MESSAGE_WINDOW_EDGE_CHARS)
        .collect();
    let tail: String = first_message
        .chars()
        .skip(total - PROMPT_MESSAGE_WINDOW_EDGE_CHARS)
        .collect();
    format!("{head}{TRIMMED_MARKER}{tail}")
}

pub fn build_session_title_prompt(first_message: &str, custom_prompt: Option<&str>) -> String {
    let head = custom_prompt
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(SESSION_TITLE_DEFAULT_PROMPT);
    let body = window_prompt_body(first_message);
    format!("{head}\n\nFirst message from the user:\n{body}")
}
```

This replaces the old body construction at `:28-33` (including its NOTE comment, superseded by the new one).

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-server ai_title`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Remove the now-dead intermediate `body` binding style if the old code left an unused comment line; confirm `window_prompt_body` is the single place windowing policy lives. Then `cargo fmt --all --check` and `cargo clippy -p freshell-server --all-targets -- -D warnings`.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: the full `freshell-server` crate (both call sites — `auto_title_sweep.rs:435`, `sessions.rs:434` — consume only the returned `String`; behavior changes solely for >2000-char inputs). E2e specs make no prompt-body assertions (fake Gemini asserts key header and request counts only; `fake-ai.test.ts` prompt-content assertion uses an input far under 1000 chars and is untouched) — the e2e set from Task 1 is not re-affected. The Node `test/unit/server/ai-prompts.test.ts` remains green by constraint (Node keeps its prefix cap deliberately).

Run:

```bash
cargo test -p freshell-server
```

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-server/src/ai_title.rs
git commit -m "feat(rust-server): window over-2000-char title inputs to first/last 1000 chars"
```

---

### Task 3: Final broad gate (verification-only)

**Files:** none (verification only; any discovered fix lands in its own focused commit before re-running the gate step that exposed it).

**Interfaces:** none.

- [ ] **Step 1: Format gate**

Run: `cargo fmt --all --check`
Expected: PASS (no diff).

- [ ] **Step 2: Workspace clippy gate (matches CI)**

Run: `cargo clippy --workspace --all-targets -- -D warnings`
Expected: PASS.

- [ ] **Step 3: Coordinated full suite from the worktree**

Run: `FRESHELL_TEST_SUMMARY="title-gemini-35-trim final gate" npm run check`

Expected: PASS — typechecks plus the coordinated full suite (vitest dispatches to the configured cloud backend per machine env). Pass criterion: green excluding baseline-ledger-recorded pre-existing failures; baseline recorded `none`, so any failure must be reproduced at `base_ref` before being excepted.

- [ ] **Step 4: Affected e2e spec on the configured backend (pre-PR receipt)**

The repo rule ("ensure the affected e2e specs actually pass on the configured FRESHELL_E2E_BACKEND" — `cloud` on this machine; a spec sitting in `CLOUD_SKIP_SPECS` is not coverage) applies at PR time; collect the receipt now. Task 1's local run was the fast iteration; this is the configured-backend pass. `auto-title-rust.spec.ts` is not in `CLOUD_SKIP_SPECS`.

Run: `npm run test:e2e -- --project=rust-chromium test/e2e-browser/specs/auto-title-rust.spec.ts`

Expected: PASS on the cloud backend.

- [ ] **Step 5: Commit**

Nothing to commit for this task itself (verification only). If a fix was required, its commit precedes the passing gate and is described in the run record.
