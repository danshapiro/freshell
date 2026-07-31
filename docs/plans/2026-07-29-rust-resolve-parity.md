# SYNC-06: Rust Server Resume-Resolve Parity Implementation Plan

> ## ⚠️ ARCHIVED / SUPERSEDED — DO NOT EXECUTE ⚠️
>
> **This plan is superseded by
> [`docs/plans/2026-07-30-rust-resolve-parity-hardened.md`](2026-07-30-rust-resolve-parity-hardened.md).**
> It is retained only as a historical record of the first (pre-#586) pass.
>
> - It implements the **RETIRED pre-#586 resolve contract**, including the
>   retired OpenCode parent-chain resolver (`resolveOpencodeSessionRoots`
>   parent-walk) that main's hardened Node implementation replaced with a
>   direct by-id row query — while claiming full parity it does not deliver.
> - Its "Parity reference — Node behavior being ported" section (lines ~62-72)
>   describes the **obsolete pre-#586 Node behavior**, not the hardened
>   contract (`degraded` status, `providerErrors`, `unsearchedProviders`,
>   `homeDir` are all absent).
> - Its expected test counts (line ~3103, "32 passed; 14 passed") are **stale**
>   and do not match the current tree.
> - Its own final checklist step confirms this plan targeted the retired
>   implementation; the completion checklist's SYNC-06 `PARTIAL / REOPENED
>   (2026-07-30)` entry records the reopening.
>
> **DO NOT EXECUTE.** Re-executing this plan would reintroduce defects already
> resolved by the hardened plan, and its indexed-Codex E2E gate could still
> pass while doing so. Execute the hardened plan instead.

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Implement `POST /api/sessions/resolve` in the Rust server (`crates/freshell-server`) with full behavior parity to the Node implementation, declare the `sessionResolve` feature flag from the Rust server so the shared client shows the pinned sidebar Resume button on Rust builds, and prove it with cross-language parser fixtures plus the `resume-button` e2e spec green on BOTH Playwright projects.

**Architecture:** A pure Rust port of `shared/resume-input-parser.ts` and the resolve matching core live in `crates/freshell-sessions` (`resume_input.rs`, `resume_resolve.rs`), pinned to the TS implementation by a shared JSON fixture table both test suites consume. A new focused axum module `crates/freshell-server/src/resolve.rs` owns the HTTP route (auth → zod-shaped validation → resolve core), reading the existing `SessionIndex` for evidence (filtered through the settings store's `deleted` session overrides, exactly like the Rust sidebar), the `SessionMetadataStore` for the `sessionType` overlay, and two exact-id fallbacks built on existing Rust machinery (the claude transcript locator paired with its exported cwd reader; a bug-for-bug port of Node's opencode by-id sqlite parent-chain walk).

**Tech Stack:** Rust (axum 0.8, tokio, serde/serde_json with `preserve_order`, `regex`, rusqlite), TypeScript (vitest, zod), Playwright.

## Global Constraints

- Work ONLY inside the worktree `/home/dan/code/freshell/.worktrees/rust-resolve-parity` on branch `feat/rust-resolve-parity`. Never commit to `main`. Never push to `origin/main`. Do NOT create a PR (requires explicit user approval).
- Git author for every commit: `Dan Shapiro <3732858+danshapiro@users.noreply.github.com>`. Verify with `git log -1 --format='%an <%ae>'` after the first commit; if wrong, amend and prefix subsequent commits with `git -c user.name="Dan Shapiro" -c user.email="3732858+danshapiro@users.noreply.github.com" commit …`.
- Do NOT modify `shared/resume-resolve-contract.ts`, `shared/resume-input-parser.ts` behavior, or any Node server behavior. Allowed exceptions: refactoring `test/unit/shared/resume-input-parser.test.ts` to consume the shared fixture (behavior-identical), and a comment-only update in `server/platform-router.ts`.
- Wire parity is byte-shape parity: response JSON field ORDER matches the Node object literals (`serde_json` `preserve_order` is on workspace-wide; struct field order controls serde output order), optional match fields are OMITTED when absent (`skip_serializing_if`), and `hint` is `null` (never omitted) when absent.
- Constants copied from Node: result cap `RESOLVE_MATCH_CAP = 20`; request `input` length `1..=20000` counted in UTF-16 code units (zod `.min(1).max(20000)` semantics); validation failure is `400 { "error": "Invalid resolve request", "details": [...] }`; "not found" is NEVER 404 — it is `200 { "status": "ready", "matches": [] }`.
- 400 `details` parity: the issue literals (field set, key ORDER, message wording) must match the ACTUAL zod 4.3.6 wire output as probed against the real `ResumeResolveRequestSchema` — e.g. `"Invalid input: expected string, received undefined"`, double-quoted `"Unrecognized keys: \"a\", \"b\""` (singular `"Unrecognized key: \"a\""`), `origin`/`inclusive` fields on `too_small`/`too_big`, and `expected`/`origin` emitted BEFORE `code` (the workspace-wide `preserve_order` feature + `json!` insertion order provide this). Recorded facts: (a) NO consumer reads `details` — the client resume dialog treats any non-2xx as request-failed without inspecting the body, and the Node integration test asserts only status + `error` — so this is test-pinned parity, not consumer-load-bearing; (b) the literals are pinned to zod 4.3.6 and are VERSION-FRAGILE: any future zod bump requires re-probing the real wire output and updating both the Rust literals and Task 6's tests. Accepted deviations (status parity only): payloads Express's strict body parser rejects with an HTML 400 BEFORE zod runs — malformed JSON and JSON scalar bodies (string/number/bool/null) — get the zod-shaped JSON 400 from Rust instead; axum's default 2 MB body limit vs Express `json({ limit: '1mb' })`; and `PATCH`/`GET /api/sessions/resolve` answer 405 on the merged Rust router where Express would dispatch `:sessionId="resolve"` (unreachable by any known client).
- Vitest: NEVER run raw `npx vitest`. Use `npm run test:vitest -- --config <config> <file> --run`. Before any broad run, check `npm run test:status`; set `FRESHELL_TEST_SUMMARY="SYNC-06 rust resolve parity"` on broad runs.
- Rust gates (CI-enforced): `cargo fmt --all -- --check` clean, `cargo clippy --workspace --all-targets -- -D warnings` clean. `cargo test --workspace` requires `node_modules` present (`test -d node_modules || npm ci --no-audit --no-fund`).
- Process safety: never use broad kill patterns (`pkill -f node`, `pkill -f vite`, …). The live self-hosted Rust server on port 3002 must NEVER be restarted (building is fine). The Playwright harness manages its own server PIDs — let it.
- Rust toolchain: workspace `rust-version = "1.96"` (`std::sync::LazyLock` is available). axum 0.8 path syntax is `{param}`, not `:param`.
- Keep files focused: do not grow `sessions.rs` (944 lines) — the new endpoint gets its own module. Structural limits: ≤1K lines/file.
- README.md is the only end-user markdown doc; this plan and the parity-checklist edit are working/agent docs (allowed). Create no other markdown files.
- Commits: Conventional Commits with scope, one focused commit per task step where marked.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `test/fixtures/resume-input/parser-cases.json` | Create | Single source of truth for parser behavior — consumed by BOTH the TS unit test and the Rust parity test (spec Requirement 2's anti-drift mechanism) |
| `test/unit/shared/resume-input-parser.test.ts` | Rewrite | TS parser test, now fixture-driven |
| `crates/freshell-sessions/Cargo.toml` | Modify | Add `regex = "1"` dependency |
| `crates/freshell-sessions/src/lib.rs` | Modify | Register `resume_input` + `resume_resolve` modules |
| `crates/freshell-sessions/src/resume_input.rs` | Create | Rust port of `shared/resume-input-parser.ts` (pure, no IO) |
| `crates/freshell-sessions/tests/resume_input_parser_parity.rs` | Create | Fixture-driven parser parity test |
| `crates/freshell-sessions/src/parse/opencode.rs` | Modify | Add `opencode_session_directory_by_id` (bug-for-bug port of Node's by-id parent-walk, incl. legacy-schema early hit + truthy-directory filter) |
| `crates/freshell-sessions/src/parse/mod.rs` | Modify | Re-export the new helper + type |
| `crates/freshell-sessions/tests/opencode_directory_by_id.rs` | Create | Sqlite fixture test for the new helper |
| `crates/freshell-freshagent/src/claude_snapshot.rs` | Modify | Promote `transcript_cwd` to `pub` |
| `crates/freshell-freshagent/src/lib.rs` | Modify | Re-export `transcript_cwd` |
| `crates/freshell-freshagent/tests/transcript_cwd_export.rs` | Create | Proves the export + first-non-empty-cwd semantics |
| `crates/freshell-sessions/src/resume_resolve.rs` | Create | Resolve core: wire types (serde) + matching/dedupe/cap/fallback logic over `IndexedSession` |
| `crates/freshell-sessions/tests/resume_resolve.rs` | Create | Logic tests mirroring `test/integration/server/sessions-resolve-router.test.ts` |
| `crates/freshell-server/src/session_metadata.rs` | Modify | Un-gate the `get_all` read (`#[cfg(test)]` → production); `get` stays test-gated (no production caller) |
| `crates/freshell-server/src/resolve.rs` | Create | HTTP endpoint: `ResolveState`, router, auth, validation, handler + in-file oneshot tests |
| `crates/freshell-server/src/main.rs` | Modify | `mod resolve;` + wiring (index clone, metadata clone, settings-store clone for the deleted-override filter, fallback closures) + `sessionResolve` feature flag + flag test updates |
| `server/platform-router.ts` | Modify | Comment-only: the "Rust omits this key" note is now stale |
| `test/e2e-browser/specs/resume-button.spec.ts` | Modify | Delete the `RUST_SKIP` guard (3 call sites + const) |
| `test/e2e-browser/playwright.config.ts` | Modify | Add `resume-button.spec.ts` to `MATRIX_SPECS` |
| `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md` | Modify | SYNC-06 evidence entry |

Reference sources (read-only, do not modify): `shared/resume-resolve-contract.ts`, `shared/resume-input-parser.ts`, `server/sessions-router.ts:243-257`, `server/coding-cli/resolve-session.ts`, `server/coding-cli/claude-transcript-locator.ts`, `test/integration/server/sessions-resolve-router.test.ts`.

## Parity reference — Node behavior being ported (read once, keep handy)

- Handler (`server/sessions-router.ts:243-257`): zod `ResumeResolveRequestSchema.safeParse(req.body ?? {})`; failure → `400 { error: 'Invalid resolve request', details: issues }`; success → `res.json(await resolveResumeInput(input, deps))` (always 200).
- Core (`server/coding-cli/resolve-session.ts`): parse input → if index not ready return `{status:'warming', matches:[], hint}` → if no candidates return `{status:'ready', matches:[], hint}` → per candidate (priority order): case-insensitive exact-else-prefix bucket over ALL sessions (all four providers, one flat list from `getProjects().flatMap(g => g.sessions)` — which is Node's POST-deleted-override-filter project groups, `session-indexer.ts:209,1155-1156`; the hint never filters); exact wins wholesale; first candidate with any match short-circuits; sort `lastActivityAt` DESC (missing=0, stable), dedupe by `provider:sessionId` (first survivor = most recent), cap 20. Only if EVERY candidate missed: fallback loop per candidate (BOTH fallbacks bypass the index and its overrides) — (a) `prefixed-id` starting `ses_` → opencode by-id parent-chain WALK (`providers/opencode.ts:239-323`), NOT a bare row read: legacy schema without `parent_id` → EVERY requested id hits with cwd omitted (early return, no row query, no existence check, `opencode.ts:246-250`); modern schema → fetch the row (missing row = miss), keep its `directory` only if TRUTHY (empty string ⇒ cwd omitted, `opencode.ts:265-267,281`), walk `parent_id` with a seen-set — missing parent or cycle ⇒ MISS even though the row exists (`opencode.ts:283-303`, `resolve-session.ts:66`); a hit yields exactly ONE match `{provider:'opencode', sessionId:<token as typed>, cwd?:<the row's OWN directory>, sessionType:'opencode', matchKind:'exact'}` (`cwd` omitted when none collected); (b) `uuid` → claude transcript locator, hit yields exactly ONE match `{provider:'claude', sessionId:<lowercased id>, cwd:<first cwd line>, sessionType:'claude', matchKind:'exact'}`. Nothing found → `{status:'ready', matches:[], hint}`.
- Index-match metadata (`toMatch`): `{provider, sessionId, cwd: session.cwd ?? session.projectPath, sessionType: session.sessionType, title, firstUserMessage, lastActivityAt, matchKind}` — in Node, `sessionType` comes from a SessionMetadataStore overlay (`session-indexer.ts:1159-1161`) and is usually `undefined`; the client falls back to `sessionType ?? provider`.
- Flag (`server/platform-router.ts`): `detectFeatureFlags()` returns unconditional `sessionResolve: true`; the client gate is strict `featureFlags?.sessionResolve === true`.
- Recorded deviations (accepted — none observable under the e2e harness or default config; each line states the direction):
  - enabledProviders config gate: Node skips providers disabled in `settings.codingCli.enabledProviders` (`session-indexer.ts:1140`); the Rust snapshot has no provider filter — Rust returns a disabled provider's sessions where Node wouldn't.
  - 256 KiB cwd snippet window: Node's full parse reads a head+tail snippet (`session-indexer.ts:20,228-270`) and permanently excludes a >256 KiB transcript whose only `cwd` line sits mid-file; Rust reads whole files — Rust returns such sessions where Node wouldn't.
  - Cold-start transient window: right after boot Node's lightweight scan (4 KiB head, top-150 enrichment) can miss sessions until its next full rescan; Rust's `warm()` fully parses before publishing — Rust returns sessions transiently where Node wouldn't.
  - Tie-order / recency-fallback deltas: among equal `lastActivityAt` the match order and dedupe survivor can differ (Node group-sorted flatMap order vs Rust `lastActivityAt DESC, key() DESC` pre-sort); Node falls back to `createdAt`/mtime for a missing recency value, Rust sorts it as 0 — different ORDER (not membership) on ties.
  - Claude-locator deltas (Task 4's reuse, per the A6 validation): multi-root scan incl. `CLAUDE_CONFIG_DIR` and one-subdir-deeper layouts — Rust hits (exact match) where Node misses, bug-fix-flavored since the real claude CLI honors `CLAUDE_CONFIG_DIR`; cwd found past Node's 64 KiB read cap — Rust supplies `cwd` where Node omits it; invalid-UTF-8 line before the first cwd line — Node supplies `cwd` where Rust omits it.
  - Transport: malformed-JSON and JSON-scalar bodies get a zod-shaped JSON 400 from Rust where Express emits an HTML 400 (status parity only); axum's default 2 MB body cap vs Express 1 MB; `PATCH`/`GET /api/sessions/resolve` → 405 on Rust where Express dispatches `:sessionId="resolve"`.

---

### Task 1: Shared cross-language parser fixtures

Extract the TS parser test table into a JSON fixture that both suites will consume. This is spec Requirement 2's anti-drift mechanism: one committed table, two implementations that must pass it.

**Files:**
- Create: `test/fixtures/resume-input/parser-cases.json`
- Modify: `test/unit/shared/resume-input-parser.test.ts` (full rewrite, behavior-identical assertions)

**Interfaces:**
- Consumes: `parseResumeInput(text: string): { candidates: {token, kind}[], hint: {provider, source} | null }` from `@shared/resume-input-parser` (unchanged).
- Produces: `test/fixtures/resume-input/parser-cases.json` with shape `{ "cases": [{ "name", "input", "candidates": [{"token","kind"}], "hint": {"provider","source"} | null }] }` — Task 2's Rust test reads this exact file at this exact path.

- [ ] **Step 0: Install node deps in the worktree (precondition for EVERY npm/vitest step in this plan)**

The worktree starts with NO `node_modules`. `npm run test:vitest` shells through `tsx` (an uninstalled devDependency), so Step 3 below — and every later npm/typecheck/vitest step, and any `cargo test -p freshell-server` run that spawns the committed Node fixture `fake-app-server.mjs` (it imports `ws`) — needs deps installed first:

```bash
cd /home/dan/code/freshell/.worktrees/rust-resolve-parity
test -d node_modules || npm ci --no-audit --no-fund
```

This guard is idempotent; later tasks repeat it defensively for fresh-implementer safety, but it MUST run here first.

- [ ] **Step 1: Write the fixture**

Every case asserts BOTH candidates and hint (a strict superset of the current suite's per-case assertions — the current suite checks one or the other). Cases 1–25 are the existing suite's inputs verbatim — including the bare-v7-uuid case ("bare v7 uuid" below, the existing suite's `['uuid v7 shape', V7, { provider: 'codex', source: 'id-shape' }]` row), which is the ONLY case exercising the `version === '7' → codex` id-shape branch of `deriveHint` with a bare id (the other V7 inputs are `codex resume …` command-source hints, so dropping it would leave that branch uncovered in both languages); 26–31 pin previously-untested port hazards (stable hex sort, non-`ses_` prefixed ids, uuid versions other than 4/7, case preservation, sub-8-char hex, `-rf` command-shape miss).

Create `test/fixtures/resume-input/parser-cases.json`:

```json
{
  "$comment": "SYNC-06 shared parser fixture. Consumed by test/unit/shared/resume-input-parser.test.ts AND crates/freshell-sessions/tests/resume_input_parser_parity.rs. Both implementations of the resume-input parser must pass every case. Add cases here, never inline, so the TS and Rust parsers cannot drift.",
  "cases": [
    {
      "name": "bare short hex",
      "input": "417e8345",
      "candidates": [{ "token": "417e8345", "kind": "hex-prefix" }],
      "hint": { "provider": "amplifier", "source": "id-shape" }
    },
    {
      "name": "bare v4 uuid",
      "input": "ed2afda6-a340-443e-ba60-024a1b3554b4",
      "candidates": [{ "token": "ed2afda6-a340-443e-ba60-024a1b3554b4", "kind": "uuid" }],
      "hint": { "provider": "claude", "source": "id-shape" }
    },
    {
      "name": "bare v7 uuid",
      "input": "019fac27-69d7-78a0-b972-b339d551042e",
      "candidates": [{ "token": "019fac27-69d7-78a0-b972-b339d551042e", "kind": "uuid" }],
      "hint": { "provider": "codex", "source": "id-shape" }
    },
    {
      "name": "bare opencode id",
      "input": "ses_root0000000000000000000000",
      "candidates": [{ "token": "ses_root0000000000000000000000", "kind": "prefixed-id" }],
      "hint": { "provider": "opencode", "source": "id-shape" }
    },
    {
      "name": "codex resume command",
      "input": "codex resume 019fac27-69d7-78a0-b972-b339d551042e",
      "candidates": [{ "token": "019fac27-69d7-78a0-b972-b339d551042e", "kind": "uuid" }],
      "hint": { "provider": "codex", "source": "command" }
    },
    {
      "name": "claude --resume command",
      "input": "claude --resume ed2afda6-a340-443e-ba60-024a1b3554b4",
      "candidates": [{ "token": "ed2afda6-a340-443e-ba60-024a1b3554b4", "kind": "uuid" }],
      "hint": { "provider": "claude", "source": "command" }
    },
    {
      "name": "claude -r command with prompt",
      "input": "$ claude -r ed2afda6-a340-443e-ba60-024a1b3554b4",
      "candidates": [{ "token": "ed2afda6-a340-443e-ba60-024a1b3554b4", "kind": "uuid" }],
      "hint": { "provider": "claude", "source": "command" }
    },
    {
      "name": "opencode --session command",
      "input": "opencode --session ses_root0000000000000000000000",
      "candidates": [{ "token": "ses_root0000000000000000000000", "kind": "prefixed-id" }],
      "hint": { "provider": "opencode", "source": "command" }
    },
    {
      "name": "amplifier --resume short id",
      "input": "amplifier --resume 417e8345",
      "candidates": [{ "token": "417e8345", "kind": "hex-prefix" }],
      "hint": { "provider": "amplifier", "source": "command" }
    },
    {
      "name": "quoted and padded",
      "input": "  \"claude --resume ed2afda6-a340-443e-ba60-024a1b3554b4\"  ",
      "candidates": [{ "token": "ed2afda6-a340-443e-ba60-024a1b3554b4", "kind": "uuid" }],
      "hint": { "provider": "claude", "source": "command" }
    },
    {
      "name": "backticks",
      "input": "`417e8345`",
      "candidates": [{ "token": "417e8345", "kind": "hex-prefix" }],
      "hint": { "provider": "amplifier", "source": "id-shape" }
    },
    {
      "name": "id embedded in a path",
      "input": "/home/x/.claude/projects/foo/ed2afda6-a340-443e-ba60-024a1b3554b4.jsonl",
      "candidates": [{ "token": "ed2afda6-a340-443e-ba60-024a1b3554b4", "kind": "uuid" }],
      "hint": { "provider": "claude", "source": "word" }
    },
    {
      "name": "trailing punctuation",
      "input": "session 417e8345.",
      "candidates": [{ "token": "417e8345", "kind": "hex-prefix" }],
      "hint": { "provider": "amplifier", "source": "id-shape" }
    },
    {
      "name": "ansi codes",
      "input": "\u001b[32m417e8345\u001b[0m",
      "candidates": [{ "token": "417e8345", "kind": "hex-prefix" }],
      "hint": { "provider": "amplifier", "source": "id-shape" }
    },
    {
      "name": "multi-line noise",
      "input": "To continue:\n$ codex resume 019fac27-69d7-78a0-b972-b339d551042e\nor open the app",
      "candidates": [{ "token": "019fac27-69d7-78a0-b972-b339d551042e", "kind": "uuid" }],
      "hint": { "provider": "codex", "source": "command" }
    },
    {
      "name": "english hex-looking word",
      "input": "decade",
      "candidates": [],
      "hint": null
    },
    {
      "name": "facade sentence",
      "input": "I spent a decade behind a facade",
      "candidates": [],
      "hint": null
    },
    {
      "name": "hex without digits",
      "input": "deadbeef",
      "candidates": [],
      "hint": null
    },
    {
      "name": "garbage",
      "input": "hello world!! no ids here",
      "candidates": [],
      "hint": null
    },
    {
      "name": "empty",
      "input": "",
      "candidates": [],
      "hint": null
    },
    {
      "name": "orders prefixed ids, then uuids, then hex prefixes longest-first",
      "input": "417e8345 ed2afda6-a340-443e-ba60-024a1b3554b4 ses_root0000000000000000000000 417e8345abcd",
      "candidates": [
        { "token": "ses_root0000000000000000000000", "kind": "prefixed-id" },
        { "token": "ed2afda6-a340-443e-ba60-024a1b3554b4", "kind": "uuid" },
        { "token": "417e8345abcd", "kind": "hex-prefix" },
        { "token": "417e8345", "kind": "hex-prefix" }
      ],
      "hint": { "provider": "opencode", "source": "id-shape" }
    },
    {
      "name": "dedupes repeated tokens case-insensitively keeping the first casing",
      "input": "ed2afda6-a340-443e-ba60-024a1b3554b4 ED2AFDA6-A340-443E-BA60-024A1B3554B4",
      "candidates": [{ "token": "ed2afda6-a340-443e-ba60-024a1b3554b4", "kind": "uuid" }],
      "hint": { "provider": "claude", "source": "id-shape" }
    },
    {
      "name": "caps hex tokens at 32 chars so git shas do not match",
      "input": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      "candidates": [],
      "hint": null
    },
    {
      "name": "agent word only",
      "input": "the claude session ed2afda6-a340-443e-ba60-024a1b3554b4",
      "candidates": [{ "token": "ed2afda6-a340-443e-ba60-024a1b3554b4", "kind": "uuid" }],
      "hint": { "provider": "claude", "source": "word" }
    },
    {
      "name": "returns null hint for prose without ids or agent words",
      "input": "nothing to see",
      "candidates": [],
      "hint": null
    },
    {
      "name": "equal-length hex tokens keep text order (stable sort)",
      "input": "417e8345 88997766",
      "candidates": [
        { "token": "417e8345", "kind": "hex-prefix" },
        { "token": "88997766", "kind": "hex-prefix" }
      ],
      "hint": { "provider": "amplifier", "source": "id-shape" }
    },
    {
      "name": "non-ses prefixed id yields no id-shape hint",
      "input": "abc_12345678",
      "candidates": [{ "token": "abc_12345678", "kind": "prefixed-id" }],
      "hint": null
    },
    {
      "name": "uuid version other than 4 or 7 yields no id-shape hint",
      "input": "ed2afda6-a340-143e-ba60-024a1b3554b4",
      "candidates": [{ "token": "ed2afda6-a340-143e-ba60-024a1b3554b4", "kind": "uuid" }],
      "hint": null
    },
    {
      "name": "uppercase uuid token is preserved as written",
      "input": "ED2AFDA6-A340-443E-BA60-024A1B3554B4",
      "candidates": [{ "token": "ED2AFDA6-A340-443E-BA60-024A1B3554B4", "kind": "uuid" }],
      "hint": { "provider": "claude", "source": "id-shape" }
    },
    {
      "name": "seven hex chars are not a candidate",
      "input": "417e834",
      "candidates": [],
      "hint": null
    },
    {
      "name": "claude -rf does not match the -r command shape but the word still hints",
      "input": "claude -rf ed2afda6-a340-443e-ba60-024a1b3554b4",
      "candidates": [{ "token": "ed2afda6-a340-443e-ba60-024a1b3554b4", "kind": "uuid" }],
      "hint": { "provider": "claude", "source": "word" }
    }
  ]
}
```

- [ ] **Step 2: Rewrite the TS test to consume the fixture**

Replace the entire contents of `test/unit/shared/resume-input-parser.test.ts` with:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseResumeInput } from '@shared/resume-input-parser'

// SYNC-06 anti-drift mechanism: the SAME fixture table is consumed by
// crates/freshell-sessions/tests/resume_input_parser_parity.rs. Every case
// asserts BOTH candidates and hint. Add cases to the fixture, never inline.
interface FixtureCase {
  name: string
  input: string
  candidates: Array<{ token: string; kind: string }>
  hint: { provider: string; source: string } | null
}

const { cases } = JSON.parse(
  readFileSync(new URL('../../fixtures/resume-input/parser-cases.json', import.meta.url), 'utf8'),
) as { cases: FixtureCase[] }

describe('parseResumeInput — shared fixture parity', () => {
  it('fixture is non-trivial', () => {
    expect(cases.length).toBeGreaterThanOrEqual(31)
  })

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const parsed = parseResumeInput(c.input)
    expect(parsed.candidates).toEqual(c.candidates)
    expect(parsed.hint).toEqual(c.hint)
  })
})
```

- [ ] **Step 3: Run the TS test — must pass without touching the parser**

```bash
cd /home/dan/code/freshell/.worktrees/rust-resolve-parity
npm run test:vitest -- --config config/vitest/vitest.config.ts test/unit/shared/resume-input-parser.test.ts --run
```

Expected: 32 passed (31 cases + the non-trivial guard), 0 failed. If any case fails, the FIXTURE is wrong (the TS parser is the reference — do not change it); re-derive the expected value from `shared/resume-input-parser.ts` semantics and fix the fixture.

- [ ] **Step 4: Commit**

```bash
git add test/fixtures/resume-input/parser-cases.json test/unit/shared/resume-input-parser.test.ts
git commit -m "test(shared): extract resume-input parser cases into cross-language fixture (SYNC-06)"
```

---

### Task 2: Rust parser port (`resume_input.rs`)

Port `shared/resume-input-parser.ts` to Rust, exactly. The fixture from Task 1 is the oracle.

**Files:**
- Modify: `crates/freshell-sessions/Cargo.toml` (add `regex`)
- Modify: `crates/freshell-sessions/src/lib.rs` (register module)
- Create: `crates/freshell-sessions/src/resume_input.rs`
- Test: `crates/freshell-sessions/tests/resume_input_parser_parity.rs`

**Interfaces:**
- Consumes: `test/fixtures/resume-input/parser-cases.json` (Task 1).
- Produces (used by Task 5's resolve core and Task 6's handler):
  - `freshell_sessions::resume_input::parse_resume_input(text: &str) -> ResumeInputParse`
  - `pub struct ResumeInputParse { pub candidates: Vec<ResumeCandidate>, pub hint: Option<ResumeHint> }`
  - `pub struct ResumeCandidate { pub token: String, pub kind: ResumeCandidateKind }`
  - `pub enum ResumeCandidateKind { PrefixedId, Uuid, HexPrefix }` (serde: `"prefixed-id" | "uuid" | "hex-prefix"`)
  - `pub struct ResumeHint { pub provider: ResumeHintProvider, pub source: ResumeHintSource }` (serde: `{"provider": "claude|codex|opencode|amplifier", "source": "command|word|id-shape"}`)

- [ ] **Step 1: Write the failing fixture-parity test**

Create `crates/freshell-sessions/tests/resume_input_parser_parity.rs`:

```rust
//! SYNC-06 cross-language parser parity: the SAME fixture table that pins
//! `shared/resume-input-parser.ts` (via `test/unit/shared/resume-input-parser.test.ts`)
//! pins this port. If either implementation changes behavior, exactly one of
//! the two suites goes red — silent drift is impossible.

use freshell_sessions::resume_input::parse_resume_input;

#[derive(serde::Deserialize)]
struct Fixture {
    cases: Vec<Case>,
}

#[derive(serde::Deserialize)]
struct Case {
    name: String,
    input: String,
    candidates: serde_json::Value,
    hint: serde_json::Value,
}

#[test]
fn parser_matches_every_shared_fixture_case() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/resume-input/parser-cases.json");
    let raw = std::fs::read_to_string(&path).expect("read shared parser fixture");
    let fixture: Fixture = serde_json::from_str(&raw).expect("parse fixture json");
    assert!(
        fixture.cases.len() >= 31,
        "shared fixture unexpectedly small: {}",
        fixture.cases.len()
    );
    for case in &fixture.cases {
        let parsed = parse_resume_input(&case.input);
        let candidates = serde_json::to_value(&parsed.candidates).expect("serialize candidates");
        let hint = serde_json::to_value(&parsed.hint).expect("serialize hint");
        assert_eq!(
            candidates, case.candidates,
            "candidates mismatch for case '{}' (input {:?})",
            case.name, case.input
        );
        assert_eq!(
            hint, case.hint,
            "hint mismatch for case '{}' (input {:?})",
            case.name, case.input
        );
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /home/dan/code/freshell/.worktrees/rust-resolve-parity
cargo test -p freshell-sessions --test resume_input_parser_parity
```

Expected: COMPILE ERROR — `unresolved import freshell_sessions::resume_input` (module does not exist yet).

- [ ] **Step 3: Add the `regex` dependency and register the module**

In `crates/freshell-sessions/Cargo.toml`, under `[dependencies]`, after the `rusqlite` entry, add:

```toml
# SYNC-06 resume-resolve parity: the `shared/resume-input-parser.ts` port's
# candidate-extraction regexes + hint tables (`resume_input.rs`). `(?-u:\b)`
# keeps JS's ASCII \b word-boundary semantics. Same major already a direct
# dep of freshell-server (logging.rs redaction scrub).
regex = "1"
```

In `crates/freshell-sessions/src/lib.rs`, after the existing `pub mod parse;` line in the module list, add (keeping the list alphabetical: `resume_input` and `resume_resolve` sort after `parse`, before `search`):

```rust
pub mod resume_input;
pub mod resume_resolve;
```

> Note: `resume_resolve` is created in Task 5. To keep this task compiling on its own, add ONLY `pub mod resume_input;` now; Task 5 adds `pub mod resume_resolve;`.

- [ ] **Step 4: Write the parser**

Create `crates/freshell-sessions/src/resume_input.rs`:

```rust
//! Rust port of `shared/resume-input-parser.ts` — a pure, dependency-free
//! parser that extracts candidate session ids and an advisory provider hint
//! from arbitrary pasted text. Hints only assist the UI — session-store
//! evidence decides the provider.
//!
//! PARITY-PINNED: both this port and the TS original are driven by the shared
//! fixture `test/fixtures/resume-input/parser-cases.json`
//! (`tests/resume_input_parser_parity.rs` here,
//! `test/unit/shared/resume-input-parser.test.ts` there). Behavior changes go
//! through the fixture first.
//!
//! Port notes (things that look odd but are load-bearing):
//! - `(?-u:\b)` everywhere a JS `\b` appears: JS word boundaries are ASCII
//!   (`[A-Za-z0-9_]`); Rust's default `\b` is Unicode-aware and would diverge
//!   on inputs like `é417e8345`.
//! - The ANSI CSI strip replaces each escape with ONE space (length-changing);
//!   hint derivation reads that `sanitized` text, so earliest-match indices
//!   shift with it. Do not "fix" this to a length-preserving mask.
//! - Extraction masks each match with `' '.repeat(len)` (length-preserving)
//!   so UUID hex groups never re-match as hex prefixes. All matched chars are
//!   ASCII, so byte length == char length.
//! - Hex tokens sort by length DESC with a STABLE sort (JS `Array.sort` is
//!   stable): equal-length tokens keep extraction (text) order.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ResumeCandidateKind {
    #[serde(rename = "prefixed-id")]
    PrefixedId,
    #[serde(rename = "uuid")]
    Uuid,
    #[serde(rename = "hex-prefix")]
    HexPrefix,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ResumeCandidate {
    pub token: String,
    pub kind: ResumeCandidateKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResumeHintProvider {
    Claude,
    Codex,
    Opencode,
    Amplifier,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum ResumeHintSource {
    #[serde(rename = "command")]
    Command,
    #[serde(rename = "word")]
    Word,
    #[serde(rename = "id-shape")]
    IdShape,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ResumeHint {
    pub provider: ResumeHintProvider,
    pub source: ResumeHintSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumeInputParse {
    /// Candidate tokens in resolution-priority order.
    pub candidates: Vec<ResumeCandidate>,
    pub hint: Option<ResumeHint>,
}

static ANSI_ESCAPE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[0-9A-Za-z]").expect("static regex"));
static UUID_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
        .expect("static regex")
});
// ses_ + 26 base62 is the first-class shape; the generic form also accepts
// other known xxx_-prefixed id families.
static PREFIXED_ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)[a-z]{2,10}_[0-9A-Za-z]{8,40}(?-u:\b)").expect("static regex"));
// >=8 hex chars, <=32; must contain a digit (filters decade/facade/deadbeef).
static HEX_PREFIX_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)[0-9a-fA-F]{8,32}(?-u:\b)").expect("static regex"));

static COMMAND_HINTS: LazyLock<Vec<(Regex, ResumeHintProvider)>> = LazyLock::new(|| {
    vec![
        (
            Regex::new(r"(?i)(?-u:\b)claude\s+(?:--resume|-r)(?-u:\b)").expect("static regex"),
            ResumeHintProvider::Claude,
        ),
        (
            Regex::new(r"(?i)(?-u:\b)codex\s+resume(?-u:\b)").expect("static regex"),
            ResumeHintProvider::Codex,
        ),
        (
            Regex::new(r"(?i)(?-u:\b)opencode\s+--session(?-u:\b)").expect("static regex"),
            ResumeHintProvider::Opencode,
        ),
        (
            Regex::new(r"(?i)(?-u:\b)amplifier\s+(?:--resume|resume)(?-u:\b)").expect("static regex"),
            ResumeHintProvider::Amplifier,
        ),
    ]
});

static WORD_HINTS: LazyLock<Vec<(Regex, ResumeHintProvider)>> = LazyLock::new(|| {
    vec![
        (
            Regex::new(r"(?i)(?-u:\b)claude(?-u:\b)").expect("static regex"),
            ResumeHintProvider::Claude,
        ),
        (
            Regex::new(r"(?i)(?-u:\b)codex(?-u:\b)").expect("static regex"),
            ResumeHintProvider::Codex,
        ),
        (
            Regex::new(r"(?i)(?-u:\b)opencode(?-u:\b)").expect("static regex"),
            ResumeHintProvider::Opencode,
        ),
        (
            Regex::new(r"(?i)(?-u:\b)amplifier(?-u:\b)").expect("static regex"),
            ResumeHintProvider::Amplifier,
        ),
    ]
});

/// `extractAndMask`: push every match, replace it with a same-length run of
/// spaces so later passes cannot re-match inside it.
fn extract_and_mask(text: &str, re: &Regex, out: &mut Vec<String>) -> String {
    re.replace_all(text, |caps: &regex::Captures<'_>| {
        let m = caps.get(0).expect("group 0 always present").as_str();
        out.push(m.to_string());
        " ".repeat(m.len())
    })
    .into_owned()
}

/// `earliestHint`: run every regex, keep the provider with the smallest match
/// start. Ties break by table order (strict `<`, first entry wins) — same as
/// the TS original. Byte offsets vs UTF-16 offsets order matches identically
/// (the mapping is monotonic).
fn earliest_hint(text: &str, table: &[(Regex, ResumeHintProvider)]) -> Option<ResumeHintProvider> {
    let mut best: Option<ResumeHintProvider> = None;
    let mut best_index = usize::MAX;
    for (re, provider) in table {
        if let Some(m) = re.find(text) {
            if m.start() < best_index {
                best_index = m.start();
                best = Some(*provider);
            }
        }
    }
    best
}

fn derive_hint(text: &str, candidates: &[ResumeCandidate]) -> Option<ResumeHint> {
    if let Some(provider) = earliest_hint(text, &COMMAND_HINTS) {
        return Some(ResumeHint {
            provider,
            source: ResumeHintSource::Command,
        });
    }
    if let Some(provider) = earliest_hint(text, &WORD_HINTS) {
        return Some(ResumeHint {
            provider,
            source: ResumeHintSource::Word,
        });
    }
    let top = candidates.first()?;
    match top.kind {
        ResumeCandidateKind::PrefixedId => {
            if top.token.starts_with("ses_") {
                Some(ResumeHint {
                    provider: ResumeHintProvider::Opencode,
                    source: ResumeHintSource::IdShape,
                })
            } else {
                None
            }
        }
        // charAt(14) is the uuid version nibble (0-based). Real-store caveat:
        // amplifier TOP-LEVEL session ids are also UUIDv4, so v4 => claude is
        // a heuristic, not an invariant — acceptable because hints are
        // advisory only.
        ResumeCandidateKind::Uuid => match top.token.as_bytes().get(14) {
            Some(b'7') => Some(ResumeHint {
                provider: ResumeHintProvider::Codex,
                source: ResumeHintSource::IdShape,
            }),
            Some(b'4') => Some(ResumeHint {
                provider: ResumeHintProvider::Claude,
                source: ResumeHintSource::IdShape,
            }),
            _ => None,
        },
        ResumeCandidateKind::HexPrefix => Some(ResumeHint {
            provider: ResumeHintProvider::Amplifier,
            source: ResumeHintSource::IdShape,
        }),
    }
}

fn push_candidate(
    token: &str,
    kind: ResumeCandidateKind,
    seen: &mut HashSet<String>,
    out: &mut Vec<ResumeCandidate>,
) {
    // Dedup key: prefixed ids verbatim (case-sensitive); uuid/hex lowercased.
    // All token classes are ASCII by construction, so to_ascii_lowercase()
    // is equivalent to JS toLowerCase() here.
    let key = match kind {
        ResumeCandidateKind::PrefixedId => token.to_string(),
        _ => token.to_ascii_lowercase(),
    };
    if !seen.insert(key) {
        return;
    }
    out.push(ResumeCandidate {
        token: token.to_string(),
        kind,
    });
}

pub fn parse_resume_input(text: &str) -> ResumeInputParse {
    // Each CSI escape collapses to ONE space (length-changing, matches TS).
    let sanitized = ANSI_ESCAPE_RE.replace_all(text, " ").into_owned();

    let mut uuids: Vec<String> = Vec::new();
    let mut prefixed: Vec<String> = Vec::new();
    let mut raw_hex: Vec<String> = Vec::new();

    // Mask each class as it is extracted so uuid segments never re-match as hex.
    let masked = extract_and_mask(&sanitized, &UUID_RE, &mut uuids);
    let masked = extract_and_mask(&masked, &PREFIXED_ID_RE, &mut prefixed);
    extract_and_mask(&masked, &HEX_PREFIX_RE, &mut raw_hex);

    let mut hex_tokens: Vec<String> = raw_hex
        .into_iter()
        .filter(|token| token.bytes().any(|b| b.is_ascii_digit()))
        .collect();
    // STABLE sort (like JS Array.sort): equal lengths keep text order.
    // NOTE: sort_by_key(Reverse(len)) — not sort_by(|a, b| b.len().cmp(&a.len())),
    // which trips clippy's warn-by-default `unnecessary_sort_by` under the
    // -D warnings gate. Vec::sort_by_key is equally stable; behavior identical.
    hex_tokens.sort_by_key(|t| std::cmp::Reverse(t.len()));

    let mut seen: HashSet<String> = HashSet::new();
    let mut candidates: Vec<ResumeCandidate> = Vec::new();
    for token in &prefixed {
        push_candidate(token, ResumeCandidateKind::PrefixedId, &mut seen, &mut candidates);
    }
    for token in &uuids {
        push_candidate(token, ResumeCandidateKind::Uuid, &mut seen, &mut candidates);
    }
    for token in &hex_tokens {
        push_candidate(token, ResumeCandidateKind::HexPrefix, &mut seen, &mut candidates);
    }

    let hint = derive_hint(&sanitized, &candidates);
    ResumeInputParse { candidates, hint }
}
```

- [ ] **Step 5: Run the parity test — must pass**

```bash
cargo test -p freshell-sessions --test resume_input_parser_parity
```

Expected: `test parser_matches_every_shared_fixture_case ... ok` — 1 passed. If a case fails, the RUST port is wrong (the fixture passed against TS in Task 1); fix the port, not the fixture.

- [ ] **Step 6: Format, lint, commit**

```bash
cargo fmt --all
cargo clippy -p freshell-sessions --all-targets -- -D warnings
git add crates/freshell-sessions/Cargo.toml crates/freshell-sessions/src/lib.rs crates/freshell-sessions/src/resume_input.rs crates/freshell-sessions/tests/resume_input_parser_parity.rs
git commit -m "feat(sessions): port resume-input parser to Rust, pinned by shared fixture (SYNC-06)"
```

---

### Task 3: Opencode by-id directory lookup

The existing `session_exists_by_id` selects only `1` and never walks parents. Node's resolve fallback (`deps.resolveOpencodeSessionIds` → `OpencodeProvider.resolveOpencodeSessionRoots`, `server/coding-cli/providers/opencode.ts:239-323`) is NOT a bare row read — it is a parent-chain WALK with legacy-schema and truthy-directory quirks, all of them wire-observable, so the port replicates them bug for bug:

- LEGACY schema (`session` lacks `parent_id`, detected the same way the listing code detects it): Node returns EARLY (`opencode.ts:246-250`) — every requested id "resolves" as its own root with NO row query at all, so even a NONEXISTENT id is a HIT, and an existing row's `directory` is never read (`cwd` omitted on the wire).
- MODERN schema: the requested row is fetched (missing row = miss); its own `directory` is kept only if TRUTHY (`opencode.ts:265-267, 281` — empty string ⇒ no cwd); then the `parent_id` chain is walked with a `seen` set (`opencode.ts:283-303`): a missing parent row or a cycle marks the requested id UNRESOLVED (`resolve-session.ts:66` ⇒ MISS) even though the row itself exists and its directory was already collected.

Add a sibling helper with `session_exists_by_id`'s open/error conventions that implements exactly that walk.

**Files:**
- Modify: `crates/freshell-sessions/src/parse/opencode.rs`
- Modify: `crates/freshell-sessions/src/parse/mod.rs`
- Test: `crates/freshell-sessions/tests/opencode_directory_by_id.rs`

**Interfaces:**
- Consumes: existing `OpencodeReadError`, `Connection::open_with_flags(READ_ONLY|URI)`, `EXISTENCE_BY_ID_BUSY_TIMEOUT_MS`, and the listing code's `PRAGMA table_info(session)` parent-id detection pattern (all already in `opencode.rs`).
- Produces (used by Tasks 5–6):
  - `freshell_sessions::parse::opencode_session_directory_by_id(data_home: &Path, session_id: &str) -> Result<Option<OpencodeSessionDirectory>, OpencodeReadError>`
  - `pub struct OpencodeSessionDirectory { pub directory: Option<String> }` — `Ok(Some(hit))` = Node's walk would resolve the id; `hit.directory` is the requested row's own truthy `directory` (spawn cwd), `None` when it is empty/NULL or on ANY legacy-schema hit. `Ok(None)` = miss (no DB file, no row, orphaned parent chain, or parent cycle). `Err` = unreadable (callers treat as a resolve miss, never 5xx).

- [ ] **Step 1: Write the failing test**

Create `crates/freshell-sessions/tests/opencode_directory_by_id.rs`:

```rust
//! SYNC-06 resolve fallback: by-id `directory` (spawn cwd) lookup — a
//! bug-for-bug port of Node's `resolveOpencodeSessionRoots` walk
//! (`server/coding-cli/providers/opencode.ts:246-250, 265-267, 281,
//! 283-303`, consumed by `resolve-session.ts:59-85`):
//! - LEGACY schema (no `parent_id` column): EVERY requested id HITS with
//!   `directory: None` — Node's early return does no row query, so even a
//!   nonexistent id resolves and an existing row's directory is never read;
//! - MODERN schema: the requested row's OWN `directory` is kept only if
//!   truthy (empty string ⇒ `None`), then the parent chain is walked — a
//!   missing parent row or a cycle is a MISS despite the row existing.

use freshell_sessions::parse::{opencode_session_directory_by_id, OpencodeSessionDirectory};

fn temp_data_home(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "freshell-dir-by-id-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("mkdir temp data home");
    dir
}

fn seed_schema(data_home: &std::path::Path) -> rusqlite::Connection {
    let conn =
        rusqlite::Connection::open(data_home.join("opencode.db")).expect("open fixture db");
    conn.execute_batch(
        "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
         CREATE TABLE session (
            id TEXT PRIMARY KEY, directory TEXT, title TEXT,
            time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
            project_id TEXT, parent_id TEXT
         );",
    )
    .expect("create schema");
    conn
}

fn seed_legacy_schema(data_home: &std::path::Path) -> rusqlite::Connection {
    // The pre-`parent_id` opencode schema (identical minus that column).
    let conn =
        rusqlite::Connection::open(data_home.join("opencode.db")).expect("open fixture db");
    conn.execute_batch(
        "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
         CREATE TABLE session (
            id TEXT PRIMARY KEY, directory TEXT, title TEXT,
            time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
            project_id TEXT
         );",
    )
    .expect("create legacy schema");
    conn
}

fn insert(conn: &rusqlite::Connection, id: &str, directory: Option<&str>, parent: Option<&str>) {
    conn.execute(
        "INSERT INTO session (id, directory, parent_id) VALUES (?1, ?2, ?3)",
        rusqlite::params![id, directory, parent],
    )
    .expect("insert row");
}

#[test]
fn child_hit_returns_the_childs_own_directory() {
    let home = temp_data_home("child");
    let conn = seed_schema(&home);
    insert(&conn, "ses_root0000000000000000000000", Some("/repo/root"), None);
    insert(
        &conn,
        "ses_child000000000000000000000",
        Some("/repo/child"),
        Some("ses_root0000000000000000000000"),
    );
    // Node collects the REQUESTED row's directory (`opencode.ts:265-267`),
    // NOT the root's, then walks the chain to prove a root is reachable.
    let hit = opencode_session_directory_by_id(&home, "ses_child000000000000000000000")
        .expect("query ok");
    assert_eq!(
        hit,
        Some(OpencodeSessionDirectory {
            directory: Some("/repo/child".to_string())
        })
    );
}

#[test]
fn root_row_hits_with_its_directory() {
    let home = temp_data_home("root");
    let conn = seed_schema(&home);
    insert(&conn, "ses_plain000000000000000000000", Some("/repo/plain"), None);
    let hit = opencode_session_directory_by_id(&home, "ses_plain000000000000000000000")
        .expect("query ok");
    assert_eq!(
        hit,
        Some(OpencodeSessionDirectory {
            directory: Some("/repo/plain".to_string())
        })
    );
}

#[test]
fn archived_row_still_resolves() {
    let home = temp_data_home("archived");
    let conn = seed_schema(&home);
    conn.execute(
        "INSERT INTO session (id, directory, time_archived) VALUES (?1, ?2, ?3)",
        rusqlite::params!["ses_arch0000000000000000000000", "/repo/old", 123_i64],
    )
    .expect("insert row");
    let hit = opencode_session_directory_by_id(&home, "ses_arch0000000000000000000000")
        .expect("query ok");
    assert_eq!(
        hit,
        Some(OpencodeSessionDirectory {
            directory: Some("/repo/old".to_string())
        })
    );
}

#[test]
fn missing_row_is_a_miss() {
    let home = temp_data_home("missing");
    let _conn = seed_schema(&home);
    let hit = opencode_session_directory_by_id(&home, "ses_missing0000000000000000000")
        .expect("query ok");
    assert_eq!(hit, None);
}

#[test]
fn orphaned_parent_chain_is_a_miss_despite_the_row_existing() {
    let home = temp_data_home("orphan");
    let conn = seed_schema(&home);
    insert(
        &conn,
        "ses_orphan00000000000000000000",
        Some("/repo/orphan"),
        Some("ses_gone00000000000000000000000"),
    );
    // Node's missing-parent guard (`opencode.ts:292-295`) marks the REQUESTED
    // id unresolved -> `resolve-session.ts:66` -> miss.
    let hit = opencode_session_directory_by_id(&home, "ses_orphan00000000000000000000")
        .expect("query ok");
    assert_eq!(hit, None);
}

#[test]
fn parent_cycle_is_a_miss() {
    let home = temp_data_home("cycle");
    let conn = seed_schema(&home);
    insert(
        &conn,
        "ses_cyca000000000000000000000a",
        Some("/repo/cyca"),
        Some("ses_cycb000000000000000000000b"),
    );
    insert(
        &conn,
        "ses_cycb000000000000000000000b",
        Some("/repo/cycb"),
        Some("ses_cyca000000000000000000000a"),
    );
    // Node's seen-set cycle guard (`opencode.ts:287-290`) -> miss.
    let hit = opencode_session_directory_by_id(&home, "ses_cyca000000000000000000000a")
        .expect("query ok");
    assert_eq!(hit, None);
}

#[test]
fn empty_string_directory_hits_with_directory_none() {
    let home = temp_data_home("emptydir");
    let conn = seed_schema(&home);
    insert(&conn, "ses_empty000000000000000000000", Some(""), None);
    // Truthy filter (`opencode.ts:265`): '' is dropped -> Node omits `cwd`.
    let hit = opencode_session_directory_by_id(&home, "ses_empty000000000000000000000")
        .expect("query ok");
    assert_eq!(hit, Some(OpencodeSessionDirectory { directory: None }));
}

#[test]
fn null_directory_hits_with_directory_none() {
    let home = temp_data_home("nulldir");
    let conn = seed_schema(&home);
    insert(&conn, "ses_dirless0000000000000000000", None, None);
    let hit = opencode_session_directory_by_id(&home, "ses_dirless0000000000000000000")
        .expect("query ok");
    assert_eq!(hit, Some(OpencodeSessionDirectory { directory: None }));
}

#[test]
fn legacy_schema_existing_id_hits_with_directory_none() {
    let home = temp_data_home("legacy");
    let conn = seed_legacy_schema(&home);
    conn.execute(
        "INSERT INTO session (id, directory) VALUES (?1, ?2)",
        rusqlite::params!["ses_legacy00000000000000000000", "/repo/legacy"],
    )
    .expect("insert row");
    // Node's early return (`opencode.ts:246-250`) never reads the row: the
    // directory exists in sqlite but `cwd` is still omitted on the wire.
    let hit = opencode_session_directory_by_id(&home, "ses_legacy00000000000000000000")
        .expect("query ok");
    assert_eq!(hit, Some(OpencodeSessionDirectory { directory: None }));
}

#[test]
fn legacy_schema_nonexistent_id_still_hits() {
    let home = temp_data_home("legacyghost");
    let _conn = seed_legacy_schema(&home);
    // Bug-for-bug: Node fabricates a hit with ZERO existence check on the
    // legacy schema (`opencode.ts:247-250` resolves every requested id).
    let hit = opencode_session_directory_by_id(&home, "ses_ghostleg000000000000000000")
        .expect("query ok");
    assert_eq!(hit, Some(OpencodeSessionDirectory { directory: None }));
}

#[test]
fn missing_db_file_is_ok_none() {
    let home = temp_data_home("nodb");
    let hit = opencode_session_directory_by_id(&home, "ses_root0000000000000000000000")
        .expect("benign");
    assert_eq!(hit, None);
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cargo test -p freshell-sessions --test opencode_directory_by_id
```

Expected: COMPILE ERROR — `opencode_session_directory_by_id` / `OpencodeSessionDirectory` not found in `freshell_sessions::parse`.

- [ ] **Step 3: Implement the helper**

In `crates/freshell-sessions/src/parse/opencode.rs`, directly AFTER the existing `session_exists_by_id` function, add:

```rust
/// A resume-resolve by-id fallback HIT: Node's `resolveOpencodeSessionRoots`
/// walk resolved the requested id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpencodeSessionDirectory {
    /// The requested row's OWN `directory` column — the SPAWN cwd opencode
    /// resumes in (`resolve-session.ts:77-84`: NOT the project root) — kept
    /// only when TRUTHY (`opencode.ts:265-267, 281`). `None` for an empty or
    /// NULL `directory` and for EVERY legacy-schema hit (Node's early return
    /// never reads the row). `None` ⇒ the wire match OMITS `cwd`.
    pub directory: Option<String>,
}

/// One row of the walk: `(directory, parent_id)` for an id, `None` = no row.
fn fetch_session_row(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<(Option<String>, Option<String>)>, OpencodeReadError> {
    match conn.query_row(
        "SELECT directory, parent_id FROM session WHERE id = ?1",
        rusqlite::params![session_id],
        |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
            ))
        },
    ) {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(OpencodeReadError(e.to_string())),
    }
}

/// Resume-resolve by-id lookup — a bug-for-bug port of Node's
/// `OpencodeProvider.resolveOpencodeSessionRoots`
/// (`server/coding-cli/providers/opencode.ts:239-323`, consumed by
/// `resolve-session.ts:59-85`). This is deliberately NOT the attach-arm
/// existence probe: Node walks the `parent_id` chain, and every quirk of
/// that walk is wire-observable, so all are replicated:
///
/// - LEGACY schema (`session` lacks `parent_id`, detected with the same
///   `PRAGMA table_info(session)` probe the listing uses): return a HIT with
///   `directory: None` for ANY requested id — Node returns early
///   (`opencode.ts:246-250`) with NO row query and NO existence check, so
///   even nonexistent ids hit and existing directories are never read.
/// - MODERN schema: fetch the requested row (missing row ⇒ `Ok(None)`);
///   keep its OWN `directory` only if non-empty (truthy filter,
///   `opencode.ts:265-267, 281`); then walk `parent_id` with a `seen` set —
///   a missing parent row (`opencode.ts:292-295`) or a cycle
///   (`opencode.ts:287-290`) marks the requested id unresolved ⇒ `Ok(None)`
///   even though the row exists; reaching a root (`parent_id` NULL) ⇒ HIT.
///
/// Same read-only open and short busy timeout as [`session_exists_by_id`].
/// `Err` for ANY read failure — the resolve endpoint treats `Err` as a miss
/// (empty matches), never a 5xx (Node likewise degrades: 3 retries then all
/// ids unresolved, `opencode.ts:239-322`).
pub fn opencode_session_directory_by_id(
    data_home: &Path,
    session_id: &str,
) -> Result<Option<OpencodeSessionDirectory>, OpencodeReadError> {
    let db_path = data_home.join("opencode.db");
    if !db_path.exists() {
        return Ok(None);
    }
    let conn = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| OpencodeReadError(e.to_string()))?;
    conn.busy_timeout(std::time::Duration::from_millis(
        EXISTENCE_BY_ID_BUSY_TIMEOUT_MS,
    ))
    .map_err(|e| OpencodeReadError(e.to_string()))?;

    // PRAGMA table_info(session) -> hasParentId (same detection as the
    // listing's `run_opencode_query_inner`).
    let has_parent_id = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(session)")
            .map_err(|e| OpencodeReadError(e.to_string()))?;
        let names = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| OpencodeReadError(e.to_string()))?;
        let mut found = false;
        for name in names {
            if name.map_err(|e| OpencodeReadError(e.to_string()))? == "parent_id" {
                found = true;
            }
        }
        found
    };
    if !has_parent_id {
        // Node's legacy early return (`opencode.ts:246-250`): every requested
        // id resolves as its own root — no row query, no existence check, no
        // directory read. Bug-for-bug: nonexistent ids HIT, `cwd` omitted.
        return Ok(Some(OpencodeSessionDirectory { directory: None }));
    }

    let Some((directory, first_parent)) = fetch_session_row(&conn, session_id)? else {
        return Ok(None);
    };
    // Truthy filter (`opencode.ts:265-267, 281`): empty string ⇒ no cwd.
    let directory = directory.filter(|d| !d.is_empty());

    // Parent walk (`opencode.ts:283-303`): a missing parent or a cycle marks
    // the REQUESTED id unresolved (`resolve-session.ts:66`) ⇒ miss, even
    // though its own row exists and its directory was already collected.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    seen.insert(session_id.to_string());
    let mut parent = first_parent;
    while let Some(current) = parent {
        if !seen.insert(current.clone()) {
            return Ok(None); // cycle guard (`opencode.ts:287-290`)
        }
        match fetch_session_row(&conn, &current)? {
            None => return Ok(None), // missing parent (`opencode.ts:292-295`)
            Some((_, next_parent)) => parent = next_parent,
        }
    }
    Ok(Some(OpencodeSessionDirectory { directory }))
}
```

In `crates/freshell-sessions/src/parse/mod.rs`, extend the existing `pub use opencode::{...}` re-export list to also include `opencode_session_directory_by_id` and `OpencodeSessionDirectory` (keep the list alphabetical within the braces):

```rust
pub use opencode::{
    default_opencode_data_home, opencode_session_directory_by_id, run_opencode_listing_query,
    session_exists_by_id, OpencodeDegrade, OpencodeListing, OpencodeListingResult,
    OpencodeProvider, OpencodeReadError, OpencodeSession, OpencodeSessionDirectory,
    OpencodeSessionRow, THREE_VIEWS_MARKER_SQL_PATTERN,
};
```

- [ ] **Step 4: Run tests — must pass**

```bash
cargo test -p freshell-sessions --test opencode_directory_by_id
cargo test -p freshell-sessions --test opencode_exists_by_id
```

Expected: 11 passed in the new test; the existing exists-by-id suite still fully green.

- [ ] **Step 5: Format, lint, commit**

```bash
cargo fmt --all
cargo clippy -p freshell-sessions --all-targets -- -D warnings
git add crates/freshell-sessions/src/parse/opencode.rs crates/freshell-sessions/src/parse/mod.rs crates/freshell-sessions/tests/opencode_directory_by_id.rs
git commit -m "feat(sessions): opencode by-id directory lookup for resume-resolve fallback (SYNC-06)"
```

---

### Task 4: Export the claude transcript cwd reader

`freshell_freshagent::locate_transcript(id) -> Option<PathBuf>` already exists and is exported; its cwd companion `transcript_cwd(path) -> Option<String>` is `pub(crate)`. The resolve fallback needs both (Node's locator returns `{sessionId, cwd?}`). Promote and re-export — do NOT re-implement the scan.

**Files:**
- Modify: `crates/freshell-freshagent/src/claude_snapshot.rs` (visibility only)
- Modify: `crates/freshell-freshagent/src/lib.rs` (re-export)
- Test: `crates/freshell-freshagent/tests/transcript_cwd_export.rs`

**Interfaces:**
- Consumes: existing `transcript_cwd` implementation (first non-empty `cwd` field among the transcript's JSONL lines; malformed lines skipped).
- Produces (used by Task 6's wiring): `freshell_freshagent::transcript_cwd(path: &Path) -> Option<String>` — crate-root export alongside `locate_transcript`.

- [ ] **Step 1: Write the failing test**

Create `crates/freshell-freshagent/tests/transcript_cwd_export.rs`:

```rust
//! SYNC-06: the resume-resolve claude fallback needs the transcript's
//! original cwd (`claude-transcript-locator.ts` parity: first line carrying a
//! non-empty string `cwd`, malformed lines skipped). This pins the crate-root
//! export and the first-non-empty-cwd semantics.

use std::io::Write;

fn temp_transcript(lines: &[&str]) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "freshell-transcript-cwd-{}-{}.jsonl",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut file = std::fs::File::create(&path).expect("create fixture transcript");
    for line in lines {
        writeln!(file, "{line}").expect("write fixture line");
    }
    path
}

#[test]
fn first_non_empty_cwd_wins_and_malformed_lines_are_skipped() {
    let path = temp_transcript(&[
        "not json at all {",
        r#"{"type":"summary","cwd":""}"#,
        r#"{"type":"user","cwd":"/repo/gamma","message":{}}"#,
        r#"{"type":"assistant","cwd":"/repo/other"}"#,
    ]);
    assert_eq!(
        freshell_freshagent::transcript_cwd(&path),
        Some("/repo/gamma".to_string())
    );
}

#[test]
fn transcript_without_cwd_yields_none() {
    let path = temp_transcript(&[r#"{"type":"summary"}"#, r#"{"leafUuid":"x"}"#]);
    assert_eq!(freshell_freshagent::transcript_cwd(&path), None);
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cargo test -p freshell-freshagent --test transcript_cwd_export
```

Expected: COMPILE ERROR — `transcript_cwd` is private (or not found at the crate root).

- [ ] **Step 3: Promote and re-export**

In `crates/freshell-freshagent/src/claude_snapshot.rs`, change the signature line of `transcript_cwd` from:

```rust
pub(crate) fn transcript_cwd(path: &Path) -> Option<String> {
```

to:

```rust
pub fn transcript_cwd(path: &Path) -> Option<String> {
```

In `crates/freshell-freshagent/src/lib.rs`, change:

```rust
// Kata 09v1: the ONE claude_snapshot item visible outside this crate — the
// raw-file existence check freshell-server's IndexExistenceProbe shares with
// the attach arm. Keep the rest of claude_snapshot crate-private.
pub use claude_snapshot::locate_transcript;
```

to:

```rust
// Kata 09v1 + SYNC-06: the TWO claude_snapshot items visible outside this
// crate — the raw-file existence check freshell-server's IndexExistenceProbe
// shares with the attach arm, and the original-cwd reader the resume-resolve
// claude fallback pairs with it (`claude-transcript-locator.ts` parity).
// Keep the rest of claude_snapshot crate-private.
pub use claude_snapshot::{locate_transcript, transcript_cwd};
```

**Recorded deviations (accepted).** Reusing the attach-arm locator (`locate_transcript` + `transcript_cwd`) instead of porting Node's `claude-transcript-locator.ts` carries these deltas (A6 validation). All are production-only — the e2e harness sets `HOME`/`CLAUDE_HOME` and DELETES `CLAUDE_CONFIG_DIR`, collapsing the Rust root list to the single `<home>/.claude` root Node scans — so no in-plan test can trip them, and NO code change is made for them:

- Multi-root scan: Rust honors `CLAUDE_CONFIG_DIR` > `CLAUDE_HOME` > `$HOME/.claude`; Node scans only `(CLAUDE_HOME || ~/.claude)/projects`. Rust returns the exact match where Node returns `matches: []` — bug-fix-flavored, since the real claude CLI honors `CLAUDE_CONFIG_DIR`.
- One-subdir-deeper layouts (`<project>/<subdir>/<id>.jsonl`): Rust hits, Node misses. (Claude SUBAGENT transcripts live TWO levels down — `<project>/<session-dir>/subagents/` — and are missed by BOTH locators.)
- cwd window: Node reads only the first 64 KiB (a cwd past the cap, or a first cwd-bearing line straddling the boundary, is dropped); Rust reads the whole file and supplies `cwd` where Node omits it (Rust richer).
- Invalid-UTF-8 line before the first cwd line: Rust's `BufRead::lines()` stops scanning and yields no cwd; Node's lossy decode keeps scanning and can still find one (Node richer).

- [ ] **Step 4: Run tests — must pass**

```bash
cargo test -p freshell-freshagent --test transcript_cwd_export
```

Expected: 2 passed.

- [ ] **Step 5: Format, lint, commit**

```bash
cargo fmt --all
cargo clippy -p freshell-freshagent --all-targets -- -D warnings
git add crates/freshell-freshagent/src/claude_snapshot.rs crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/tests/transcript_cwd_export.rs
git commit -m "feat(freshagent): export transcript_cwd for resume-resolve claude fallback (SYNC-06)"
```

---

### Task 5: Resolve core (`resume_resolve.rs`)

The provider-agnostic matching engine: wire types (serde, camelCase, Node field order) + the exact algorithm from `resolve-session.ts`. Pure and synchronous — the HTTP layer supplies the snapshot, the sessionType overlay map, and fallback closures.

**Files:**
- Create: `crates/freshell-sessions/src/resume_resolve.rs`
- Modify: `crates/freshell-sessions/src/lib.rs` (add `pub mod resume_resolve;`)
- Test: `crates/freshell-sessions/tests/resume_resolve.rs`

**Interfaces:**
- Consumes: `parse_resume_input`, `ResumeCandidateKind`, `ResumeHint` (Task 2); `IndexedSession` (existing, `directory_index.rs` — fields `session_id, provider, project_path, title, summary, first_user_message, last_activity_at: i64, created_at, cwd, is_subagent, is_non_interactive, source_file`); `OpencodeSessionDirectory` (Task 3).
- Produces (used by Task 6):
  - `pub const RESOLVE_MATCH_CAP: usize = 20;`
  - `pub struct ClaudeTranscriptHit { pub session_id: String, pub cwd: Option<String> }`
  - `pub struct ResolveDeps<'a> { pub sessions: Option<&'a [IndexedSession]>, pub session_types: &'a HashMap<String, String>, pub opencode_dir_by_id: Option<&'a (dyn Fn(&str) -> Option<OpencodeSessionDirectory> + Send + Sync)>, pub locate_claude_transcript: Option<&'a (dyn Fn(&str) -> Option<ClaudeTranscriptHit> + Send + Sync)> }`
  - `pub fn resolve_resume_input(input: &str, deps: &ResolveDeps<'_>) -> ResumeResolveResponse`
  - `pub struct ResumeResolveResponse { pub status: ResumeResolveStatus, pub matches: Vec<ResumeResolveMatch>, pub hint: Option<ResumeHint> }` (Serialize; `hint: None` → JSON `null`)
  - `pub struct ResumeResolveMatch` (Serialize, camelCase, optional fields omitted when `None`)
  - `sessions: None` ⇒ `status: "warming"`; `session_types` is keyed `"{provider}:{session_id}"`.

- [ ] **Step 1: Write the failing tests**

Create `crates/freshell-sessions/tests/resume_resolve.rs` (mirrors `test/integration/server/sessions-resolve-router.test.ts` at the logic level, plus serialization-shape pins):

```rust
//! SYNC-06 resolve-core parity tests — a 1:1 mirror of the Node integration
//! suite `test/integration/server/sessions-resolve-router.test.ts` (matching,
//! ordering, cap, dedupe, warming, fallbacks) at the logic level, plus
//! wire-shape pins the Node suite leaves implicit (camelCase field names,
//! omitted optionals, hint null).

use std::collections::HashMap;

use freshell_sessions::directory_index::IndexedSession;
use freshell_sessions::parse::OpencodeSessionDirectory;
use freshell_sessions::resume_resolve::{
    resolve_resume_input, ClaudeTranscriptHit, ResolveDeps, ResumeResolveResponse,
    RESOLVE_MATCH_CAP,
};

const CLAUDE_ID: &str = "ed2afda6-a340-443e-ba60-024a1b3554b4";
const CODEX_ID: &str = "019fac27-69d7-78a0-b972-b339d551042e";
const OPENCODE_ID: &str = "ses_root0000000000000000000000";
const AMP_ID_NEW: &str = "417e8345-aaaa-4bbb-8ccc-000000000001";
const AMP_ID_OLD: &str = "417e8345-bbbb-4ccc-8ddd-000000000002";

fn session(provider: &str, id: &str, project: &str, last_activity_at: i64) -> IndexedSession {
    IndexedSession {
        session_id: id.to_string(),
        provider: provider.to_string(),
        project_path: project.to_string(),
        title: None,
        summary: None,
        first_user_message: None,
        last_activity_at,
        created_at: None,
        cwd: Some(project.to_string()),
        is_subagent: false,
        is_non_interactive: false,
        source_file: None,
    }
}

/// The Node suite's fixtureProjects(), flattened.
fn fixture_sessions() -> Vec<IndexedSession> {
    let mut claude = session("claude", CLAUDE_ID, "/repo/alpha", 400);
    claude.title = Some("Fix the parser".to_string());
    claude.first_user_message = Some("fix the parser".to_string());
    vec![
        claude,
        session("codex", CODEX_ID, "/repo/alpha", 300),
        session("opencode", OPENCODE_ID, "/repo/beta", 200),
        session("amplifier", AMP_ID_NEW, "/repo/beta", 900),
        session("amplifier", AMP_ID_OLD, "/repo/beta", 100),
    ]
}

fn no_types() -> HashMap<String, String> {
    HashMap::new()
}

fn resolve(input: &str, sessions: &[IndexedSession]) -> ResumeResolveResponse {
    let types = no_types();
    resolve_resume_input(
        input,
        &ResolveDeps {
            sessions: Some(sessions),
            session_types: &types,
            opencode_dir_by_id: None,
            locate_claude_transcript: None,
        },
    )
}

fn as_json(response: &ResumeResolveResponse) -> serde_json::Value {
    serde_json::to_value(response).expect("serialize response")
}

#[test]
fn exact_uuid_resolves_to_single_exact_match() {
    let sessions = fixture_sessions();
    for (input, provider, id) in [
        (CLAUDE_ID.to_string(), "claude", CLAUDE_ID),
        (format!("codex resume {CODEX_ID}"), "codex", CODEX_ID),
        (
            format!("opencode --session {OPENCODE_ID}"),
            "opencode",
            OPENCODE_ID,
        ),
    ] {
        let body = as_json(&resolve(&input, &sessions));
        assert_eq!(body["status"], "ready", "input {input:?}");
        assert_eq!(body["matches"].as_array().unwrap().len(), 1, "input {input:?}");
        assert_eq!(body["matches"][0]["provider"], provider);
        assert_eq!(body["matches"][0]["sessionId"], id);
        assert_eq!(body["matches"][0]["matchKind"], "exact");
    }
}

#[test]
fn match_carries_full_resume_metadata() {
    let body = as_json(&resolve(CLAUDE_ID, &fixture_sessions()));
    let m = &body["matches"][0];
    assert_eq!(m["provider"], "claude");
    assert_eq!(m["sessionId"], CLAUDE_ID);
    assert_eq!(m["cwd"], "/repo/alpha");
    assert_eq!(m["title"], "Fix the parser");
    assert_eq!(m["firstUserMessage"], "fix the parser");
    assert_eq!(m["lastActivityAt"], 400);
    // sessionType absent (no metadata-store overlay entry): key OMITTED,
    // not null — the client and the Node contract treat undefined as omitted.
    assert!(m.get("sessionType").is_none());
}

#[test]
fn session_type_overlays_from_metadata_map() {
    let sessions = fixture_sessions();
    let mut types = HashMap::new();
    types.insert(format!("claude:{CLAUDE_ID}"), "freshclaude".to_string());
    let response = resolve_resume_input(
        CLAUDE_ID,
        &ResolveDeps {
            sessions: Some(&sessions),
            session_types: &types,
            opencode_dir_by_id: None,
            locate_claude_transcript: None,
        },
    );
    let body = as_json(&response);
    assert_eq!(body["matches"][0]["sessionType"], "freshclaude");
}

#[test]
fn prefix_matches_short_hex_most_recent_first() {
    let body = as_json(&resolve("417e8345", &fixture_sessions()));
    assert_eq!(body["status"], "ready");
    let ids: Vec<&str> = body["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["sessionId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![AMP_ID_NEW, AMP_ID_OLD]);
    assert_eq!(body["matches"][0]["matchKind"], "prefix");
    assert_eq!(body["matches"][0]["provider"], "amplifier");
}

#[test]
fn caps_ambiguous_prefix_matches_at_20() {
    let many: Vec<IndexedSession> = (0..25)
        .map(|i| {
            session(
                "amplifier",
                &format!("417e8345-0000-4000-8000-{i:012}"),
                "/repo/many",
                i,
            )
        })
        .collect();
    let body = as_json(&resolve("417e8345", &many));
    assert_eq!(body["matches"].as_array().unwrap().len(), RESOLVE_MATCH_CAP);
    assert_eq!(body["matches"][0]["lastActivityAt"], 24); // most recent first
}

#[test]
fn dedupes_duplicate_provider_session_id_keeping_most_recent() {
    let mut older = session("claude", CLAUDE_ID, "/repo/alpha", 100);
    older.title = Some("older file".to_string());
    let mut newer = session("claude", CLAUDE_ID, "/repo/alpha", 500);
    newer.title = Some("newer file".to_string());
    let body = as_json(&resolve(CLAUDE_ID, &[older, newer]));
    assert_eq!(body["matches"].as_array().unwrap().len(), 1);
    assert_eq!(body["matches"][0]["title"], "newer file");
    assert_eq!(body["matches"][0]["lastActivityAt"], 500);
}

#[test]
fn reports_hint_alongside_evidence() {
    let body = as_json(&resolve(&format!("codex resume {CODEX_ID}"), &fixture_sessions()));
    assert_eq!(
        body["hint"],
        serde_json::json!({ "provider": "codex", "source": "command" })
    );
}

#[test]
fn unknown_id_is_ready_with_empty_matches() {
    let body = as_json(&resolve("019fffff-ffff-7fff-bfff-ffffffffffff", &fixture_sessions()));
    assert_eq!(body["status"], "ready");
    assert_eq!(body["matches"], serde_json::json!([]));
}

#[test]
fn warming_when_no_snapshot_with_hint_and_empty_matches() {
    let types = no_types();
    let response = resolve_resume_input(
        &format!("claude --resume {CLAUDE_ID}"),
        &ResolveDeps {
            sessions: None,
            session_types: &types,
            opencode_dir_by_id: None,
            locate_claude_transcript: None,
        },
    );
    assert_eq!(
        as_json(&response),
        serde_json::json!({
            "status": "warming",
            "matches": [],
            "hint": { "provider": "claude", "source": "command" }
        })
    );
}

#[test]
fn opencode_by_id_fallback_uses_row_directory_as_cwd() {
    let unknown = "ses_child000000000000000000000";
    let lookup = |id: &str| {
        assert_eq!(id, unknown);
        Some(OpencodeSessionDirectory {
            directory: Some("/repo/beta".to_string()),
        })
    };
    let types = no_types();
    let sessions = fixture_sessions();
    let response = resolve_resume_input(
        unknown,
        &ResolveDeps {
            sessions: Some(&sessions),
            session_types: &types,
            opencode_dir_by_id: Some(&lookup),
            locate_claude_transcript: None,
        },
    );
    // Node asserts strict equality: exactly these five keys, nothing else.
    assert_eq!(
        as_json(&response)["matches"],
        serde_json::json!([{
            "provider": "opencode",
            "sessionId": unknown,
            "cwd": "/repo/beta",
            "sessionType": "opencode",
            "matchKind": "exact"
        }])
    );
}

#[test]
fn opencode_fallback_hit_without_directory_omits_cwd() {
    // Legacy-schema and empty-string-directory walk hits carry
    // `directory: None` (Task 3): the wire match must OMIT `cwd` entirely —
    // matching Node, where `cwd: undefined` is dropped by `res.json` — not
    // emit `"cwd": null` or `"cwd": ""`.
    let unknown = "ses_legacy00000000000000000000";
    let lookup = |id: &str| {
        assert_eq!(id, unknown);
        Some(OpencodeSessionDirectory { directory: None })
    };
    let types = no_types();
    let sessions = fixture_sessions();
    let response = resolve_resume_input(
        unknown,
        &ResolveDeps {
            sessions: Some(&sessions),
            session_types: &types,
            opencode_dir_by_id: Some(&lookup),
            locate_claude_transcript: None,
        },
    );
    assert_eq!(
        as_json(&response)["matches"],
        serde_json::json!([{
            "provider": "opencode",
            "sessionId": unknown,
            "sessionType": "opencode",
            "matchKind": "exact"
        }])
    );
}

#[test]
fn claude_transcript_fallback_on_exact_id_index_miss() {
    let unknown = "aaaaaaaa-1111-4222-8333-444444444444";
    let locate = |id: &str| {
        Some(ClaudeTranscriptHit {
            session_id: id.to_string(),
            cwd: Some("/repo/gamma".to_string()),
        })
    };
    let types = no_types();
    let sessions = fixture_sessions();
    let response = resolve_resume_input(
        unknown,
        &ResolveDeps {
            sessions: Some(&sessions),
            session_types: &types,
            opencode_dir_by_id: None,
            locate_claude_transcript: Some(&locate),
        },
    );
    assert_eq!(
        as_json(&response)["matches"],
        serde_json::json!([{
            "provider": "claude",
            "sessionId": unknown,
            "cwd": "/repo/gamma",
            "sessionType": "claude",
            "matchKind": "exact"
        }])
    );
}

#[test]
fn fallbacks_are_not_consulted_when_the_index_matches() {
    // Node only reaches the fallback loop when EVERY candidate missed the index.
    let locate = |_id: &str| -> Option<ClaudeTranscriptHit> {
        panic!("locate_claude_transcript must not run on an index hit")
    };
    let types = no_types();
    let sessions = fixture_sessions();
    let response = resolve_resume_input(
        CLAUDE_ID,
        &ResolveDeps {
            sessions: Some(&sessions),
            session_types: &types,
            opencode_dir_by_id: None,
            locate_claude_transcript: Some(&locate),
        },
    );
    assert_eq!(as_json(&response)["matches"].as_array().unwrap().len(), 1);
}

#[test]
fn garbage_input_is_ready_empty_with_null_hint() {
    let response = resolve("hello decade facade!!", &fixture_sessions());
    assert_eq!(
        as_json(&response),
        serde_json::json!({ "status": "ready", "matches": [], "hint": null })
    );
}

#[test]
fn matching_is_case_insensitive_but_returns_stored_ids() {
    let body = as_json(&resolve(&CLAUDE_ID.to_uppercase(), &fixture_sessions()));
    assert_eq!(body["matches"][0]["sessionId"], CLAUDE_ID);
    assert_eq!(body["matches"][0]["matchKind"], "exact");
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cargo test -p freshell-sessions --test resume_resolve
```

Expected: COMPILE ERROR — `resume_resolve` module does not exist.

- [ ] **Step 3: Implement the core**

Add to `crates/freshell-sessions/src/lib.rs` after `pub mod resume_input;`:

```rust
pub mod resume_resolve;
```

Create `crates/freshell-sessions/src/resume_resolve.rs`:

```rust
//! Rust port of `server/coding-cli/resolve-session.ts` — the resume-by-id
//! resolve core. Pure and synchronous: the HTTP layer
//! (`crates/freshell-server/src/resolve.rs`) supplies the index snapshot, the
//! sessionType overlay map, and the two exact-id fallback closures, then
//! serializes the returned response verbatim.
//!
//! Wire parity notes:
//! - Field ORDER in `ResumeResolveMatch` matches the Node object literals
//!   (`toMatch` / the fallback literals) — `serde_json` has `preserve_order`
//!   on workspace-wide and struct field order drives serde output order.
//! - Optional match fields are OMITTED when `None` (Node/JSON.stringify drop
//!   `undefined`); `hint` is `null` when absent (zod `.nullable()`), so it is
//!   deliberately NOT `skip_serializing_if`.

use std::collections::{HashMap, HashSet};

use crate::directory_index::IndexedSession;
use crate::parse::OpencodeSessionDirectory;
use crate::resume_input::{parse_resume_input, ResumeCandidateKind, ResumeHint};

/// `RESOLVE_MATCH_CAP` (`resolve-session.ts:9`).
pub const RESOLVE_MATCH_CAP: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResumeResolveStatus {
    Ready,
    Warming,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResumeMatchKind {
    Exact,
    Prefix,
}

/// One resolve match (`ResumeResolveMatchSchema`,
/// `shared/resume-resolve-contract.ts`). Field order = Node's `toMatch`.
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

/// `ResumeResolveResponseSchema`: `{ status, matches, hint }` — `hint` is
/// `null` (present) when absent.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ResumeResolveResponse {
    pub status: ResumeResolveStatus,
    pub matches: Vec<ResumeResolveMatch>,
    pub hint: Option<ResumeHint>,
}

/// The claude transcript fallback's answer (`ClaudeTranscriptHit` in
/// `claude-transcript-locator.ts`, minus `sourceFile` which the API never
/// surfaces). `session_id` is the LOWERCASED id (the Node locator lowercases).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeTranscriptHit {
    pub session_id: String,
    pub cwd: Option<String>,
}

/// Dependencies for one resolve call (`ResolveResumeDeps` in
/// `resolve-session.ts`).
pub struct ResolveDeps<'a> {
    /// The flattened session list (Node: `getProjects().flatMap(g => g.sessions)`,
    /// which is the POST-deleted-override-filter project groups,
    /// `session-indexer.ts:209,1155-1156`). The slice the Rust server passes is
    /// likewise the DELETED-FILTERED snapshot (the HTTP layer drops sessions
    /// whose `"{provider}:{session_id}"` override says `deleted: true` before
    /// calling in — see `resolve.rs`); this core stays filter-free on purpose.
    /// `None` = the index has never published a snapshot ⇒ `status: "warming"`
    /// (Node's `isIndexReady() === false`).
    pub sessions: Option<&'a [IndexedSession]>,
    /// sessionType overlay keyed `"{provider}:{session_id}"` (Node:
    /// `session-indexer.ts:1159-1161` overlays the SessionMetadataStore).
    pub session_types: &'a HashMap<String, String>,
    /// opencode `ses_*` exact-id fallback (`resolveOpencodeSessionIds` →
    /// Node's by-id parent-walk): `Some(hit)` = the walk resolved the id —
    /// `hit.directory` is the row's own TRUTHY `directory` (spawn cwd), and
    /// is `None` for empty/NULL directories and ALL legacy-schema hits (the
    /// wire match then omits `cwd`). `None` = miss (no row, orphaned chain,
    /// cycle). Read errors are mapped to `None` by the caller — never a 5xx.
    pub opencode_dir_by_id:
        Option<&'a (dyn Fn(&str) -> Option<OpencodeSessionDirectory> + Send + Sync)>,
    /// claude transcript exact-id fallback (`locateClaudeTranscript`).
    pub locate_claude_transcript:
        Option<&'a (dyn Fn(&str) -> Option<ClaudeTranscriptHit> + Send + Sync)>,
}

/// `resolveResumeInput` (`resolve-session.ts:24-107`), step for step.
pub fn resolve_resume_input(input: &str, deps: &ResolveDeps<'_>) -> ResumeResolveResponse {
    // Parse BEFORE the warming gate: the warming response still carries the hint.
    let parsed = parse_resume_input(input);
    let hint = parsed.hint;

    let Some(sessions) = deps.sessions else {
        return ResumeResolveResponse {
            status: ResumeResolveStatus::Warming,
            matches: Vec::new(),
            hint,
        };
    };
    if parsed.candidates.is_empty() {
        return ResumeResolveResponse {
            status: ResumeResolveStatus::Ready,
            matches: Vec::new(),
            hint,
        };
    }

    // Evidence pass: one scan answers all providers at once. Candidates are
    // tried in priority order until one resolves. The hint NEVER filters.
    for candidate in &parsed.candidates {
        let needle = candidate.token.to_ascii_lowercase();
        let mut exact: Vec<ResumeResolveMatch> = Vec::new();
        let mut prefix: Vec<ResumeResolveMatch> = Vec::new();
        for session in sessions {
            let id = session.session_id.to_ascii_lowercase();
            if id == needle {
                exact.push(to_match(session, ResumeMatchKind::Exact, deps.session_types));
            } else if id.starts_with(&needle) {
                prefix.push(to_match(session, ResumeMatchKind::Prefix, deps.session_types));
            }
        }
        // Exact wins wholesale — exact and prefix are never mixed.
        let mut matches = if !exact.is_empty() { exact } else { prefix };
        if !matches.is_empty() {
            // Sort BEFORE dedupe (stable), so the dedupe survivor is the
            // most-recent entry. Missing lastActivityAt sorts as 0 in Node;
            // the Rust index always has a value.
            matches.sort_by(|a, b| {
                b.last_activity_at
                    .unwrap_or(0)
                    .cmp(&a.last_activity_at.unwrap_or(0))
            });
            let matches: Vec<ResumeResolveMatch> =
                dedupe(matches).into_iter().take(RESOLVE_MATCH_CAP).collect();
            return ResumeResolveResponse {
                status: ResumeResolveStatus::Ready,
                matches,
                hint,
            };
        }
    }

    // Exact-id fallbacks for sessions the index cannot see (opencode child
    // sessions; cwd-less claude transcripts skipped by the R10b cwd gate) —
    // only reached when EVERY candidate missed the index.
    for candidate in &parsed.candidates {
        if candidate.kind == ResumeCandidateKind::PrefixedId
            && candidate.token.starts_with("ses_")
        {
            if let Some(lookup) = deps.opencode_dir_by_id {
                if let Some(hit) = lookup(&candidate.token) {
                    return ResumeResolveResponse {
                        status: ResumeResolveStatus::Ready,
                        matches: vec![ResumeResolveMatch {
                            provider: "opencode".to_string(),
                            session_id: candidate.token.clone(),
                            // opencode resumes in the SPAWN cwd (the sqlite
                            // row's own `directory` column), not the project
                            // root. `None` (empty-string directory, or any
                            // legacy-schema hit) serializes with `cwd`
                            // OMITTED — matching Node, whose `cwd: undefined`
                            // is dropped by `res.json`.
                            cwd: hit.directory,
                            session_type: Some("opencode".to_string()),
                            title: None,
                            first_user_message: None,
                            last_activity_at: None,
                            match_kind: ResumeMatchKind::Exact,
                        }],
                        hint,
                    };
                }
            }
        }
        if candidate.kind == ResumeCandidateKind::Uuid {
            if let Some(locate) = deps.locate_claude_transcript {
                if let Some(hit) = locate(&candidate.token) {
                    return ResumeResolveResponse {
                        status: ResumeResolveStatus::Ready,
                        matches: vec![ResumeResolveMatch {
                            provider: "claude".to_string(),
                            session_id: hit.session_id,
                            cwd: hit.cwd,
                            session_type: Some("claude".to_string()),
                            title: None,
                            first_user_message: None,
                            last_activity_at: None,
                            match_kind: ResumeMatchKind::Exact,
                        }],
                        hint,
                    };
                }
            }
        }
    }

    ResumeResolveResponse {
        status: ResumeResolveStatus::Ready,
        matches: Vec::new(),
        hint,
    }
}

/// `toMatch` (`resolve-session.ts:109-119`): `cwd: session.cwd ?? projectPath`;
/// `sessionType` overlays from the metadata map (usually absent).
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
        session_type: session_types.get(&session.key()).cloned(),
        title: session.title.clone(),
        first_user_message: session.first_user_message.clone(),
        last_activity_at: Some(session.last_activity_at),
        match_kind,
    }
}

/// `dedupe` (`resolve-session.ts:121-133`): first `provider:sessionId` wins —
/// which, post-sort, is the most recent entry.
fn dedupe(matches: Vec<ResumeResolveMatch>) -> Vec<ResumeResolveMatch> {
    let mut seen: HashSet<String> = HashSet::new();
    matches
        .into_iter()
        .filter(|m| seen.insert(format!("{}:{}", m.provider, m.session_id)))
        .collect()
}
```

- [ ] **Step 4: Run tests — must pass**

```bash
cargo test -p freshell-sessions --test resume_resolve
cargo test -p freshell-sessions
```

Expected: 15 passed in the new suite; the whole `freshell-sessions` crate green.

- [ ] **Step 5: Format, lint, commit**

```bash
cargo fmt --all
cargo clippy -p freshell-sessions --all-targets -- -D warnings
git add crates/freshell-sessions/src/lib.rs crates/freshell-sessions/src/resume_resolve.rs crates/freshell-sessions/tests/resume_resolve.rs
git commit -m "feat(sessions): resume-resolve matching core with Node-parity semantics (SYNC-06)"
```

---

### Task 6: HTTP endpoint (`resolve.rs`) + wiring

The axum route: auth → zod-shaped validation → readiness gate → resolve core (in `spawn_blocking`, because the fallbacks do sqlite/filesystem IO). New focused module — do not touch `sessions.rs`.

**Files:**
- Modify: `crates/freshell-server/src/session_metadata.rs` (un-gate the `get_all` read)
- Create: `crates/freshell-server/src/resolve.rs`
- Modify: `crates/freshell-server/src/main.rs` (module registration + wiring)

**Interfaces:**
- Consumes: `resolve_resume_input`, `ResolveDeps`, `ClaudeTranscriptHit` (Task 5); `OpencodeSessionDirectory` + `opencode_session_directory_by_id` (Task 3); `freshell_freshagent::{locate_transcript, transcript_cwd}` (Task 4); `SessionIndex::{peek, snapshot}` + `IndexedSession::key`, `crate::boot::{is_authed, unauthorized}`, `SessionMetadataStore::{new, get_all}`, `crate::settings_store::SettingsStore` (the SYNC `session_overrides()` read, `settings_store.rs:673-679` — the same overlay source the sidebar's `apply_session_overrides` uses).
- Produces: `POST /api/sessions/resolve` and:
  - `pub struct ResolveState { pub auth_token: Arc<String>, pub settings: SettingsStore, pub session_index: Option<Arc<SessionIndex>>, pub session_metadata: SessionMetadataStore, pub opencode_dir_by_id: Option<OpencodeDirLookup>, pub locate_claude_transcript: Option<ClaudeLocator> }`
  - `pub type OpencodeDirLookup = Arc<dyn Fn(&str) -> Option<OpencodeSessionDirectory> + Send + Sync>;`
  - `pub type ClaudeLocator = Arc<dyn Fn(&str) -> Option<ClaudeTranscriptHit> + Send + Sync>;`
  - `pub fn router(state: ResolveState) -> Router`

- [ ] **Step 1: Un-gate the session-metadata `get_all` read**

In `crates/freshell-server/src/session_metadata.rs`:
1. Around lines 30-31, the `use std::collections::HashMap;` import is gated behind `#[cfg(test)]` — remove the gate so it is a plain import (`get_all`'s return type needs it in the non-test build now; merge into the top-level use block if rustfmt prefers).
2. Remove the `#[cfg(test)]` attribute from `pub async fn get_all(...)` (line ~137) ONLY. Do NOT un-gate `pub async fn get(...)` (line ~121): this plan gives it no production caller, and `freshell-server` is a binary crate (no lib target, no `dead_code` allowances), so an un-gated `get` would trip rustc's `dead_code` lint on the non-test build and fail the `cargo clippy ... -D warnings` gates in Step 6 and Task 9. Its existing doc comment ("when that lands, the compiler will force this gate off") remains accurate — leave it as is.
3. `get_all`'s body is unchanged. Replace its stale doc line `/// Test-only today — see \`get\` above.` with:

```rust
    /// Production read (SYNC-06): the resolve endpoint overlays match
    /// `sessionType` from this store, mirroring Node's
    /// `session-indexer.ts:1159-1161` overlay. Keyed `"{provider}:{session_id}"`.
```

Verify: `cargo test -p freshell-server session_metadata` still green (the existing tests already call `get`/`get_all`; `get` stays available to them under `#[cfg(test)]`, and `resolve.rs`'s test module in this same crate can also see it if needed).

- [ ] **Step 2: Write the endpoint module with its tests**

Create `crates/freshell-server/src/resolve.rs`. Write the WHOLE file in this step — types, router, validation, handler, and the in-file test module — then prove behavior in Step 3/4. (The handler is small enough that the test module is the larger half; tests below are the authority if any divergence creeps in.)

```rust
//! `POST /api/sessions/resolve` — SYNC-06 parity port of
//! `server/sessions-router.ts:243-257` + `server/coding-cli/resolve-session.ts`.
//!
//! Behavior contract (mirrors Node exactly):
//! - auth: same `x-auth-token` / `freshell-auth` cookie check as every other
//!   `/api` route (`boot::is_authed`), 401 `{"error":"Unauthorized"}`.
//! - validation: strict body `{ input: string 1..=20000 }` (UTF-16 code
//!   units); any failure → 400
//!   `{"error":"Invalid resolve request","details":[issues]}` where the
//!   issue literals replicate the ACTUAL zod 4.3.6 wire output — field set,
//!   key ORDER (`expected`/`origin` before `code`; `preserve_order` + `json!`
//!   insertion order provide it), and message wording, probed against the
//!   real `ResumeResolveRequestSchema`. NOTHING reads `details` (the client
//!   dialog treats any non-2xx as request-failed without inspecting the
//!   body), so this is test-pinned parity; the literals are pinned to zod
//!   4.3.6 and MUST be re-probed on any zod bump.
//! - membership: the index snapshot is filtered through `deleted: true`
//!   session overrides before matching — Node's resolve reads the
//!   post-filter project groups (`session-indexer.ts:209,1155-1156`) and the
//!   Rust sidebar applies the same overlay (`session_directory.rs`
//!   `apply_session_overrides`). The exact-id fallbacks BYPASS the filter,
//!   as Node's do (`resolve-session.ts:59-103`).
//! - success is ALWAYS 200 — "not found" is `{status:"ready",matches:[]}`,
//!   cold index is `{status:"warming",matches:[],hint}` (never 404/5xx).
//!
//! Accepted deviations (status parity only, recorded): payloads Express's
//! strict body parser rejects with an HTML 400 before zod runs (malformed
//! JSON; JSON scalars string/number/bool/null) get the zod-shaped JSON 400
//! here; axum's default 2 MB body limit vs express `json({limit:'1mb'})`;
//! `PATCH`/`GET /api/sessions/resolve` answer 405 on the merged Rust router
//! where Express would dispatch `:sessionId="resolve"` (unreachable by any
//! known client).
//!
//! Readiness: `SessionIndex::peek()` `None` = never-published = Node's
//! `isIndexReady() === false`. A machine with no resolvable provider home
//! (`session_index: None`) also answers `warming` — the same honest-Unknown
//! convention `NoIndexProbe` uses for existence.

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Map, Value};

use freshell_sessions::directory_index::{IndexedSession, SessionIndex};
use freshell_sessions::parse::OpencodeSessionDirectory;
use freshell_sessions::resume_resolve::{
    resolve_resume_input, ClaudeTranscriptHit, ResolveDeps, ResumeResolveResponse,
    ResumeResolveStatus,
};

use crate::boot::{is_authed, unauthorized};
use crate::session_metadata::SessionMetadataStore;
use crate::settings_store::SettingsStore;

/// zod `.max(20000)` on `input` (`shared/resume-resolve-contract.ts`).
const RESOLVE_INPUT_MAX_UTF16: usize = 20000;

/// opencode `ses_*` by-id fallback: `Some(hit)` = Node's by-id parent-walk
/// resolved the id (`hit.directory` is the row's own truthy `directory` —
/// the spawn cwd — and `None` for empty/NULL directories and legacy-schema
/// hits), `None` = walk miss (no row, orphaned chain, cycle) OR unreadable
/// DB (read errors are a miss here — the endpoint never 5xxes).
pub type OpencodeDirLookup = Arc<dyn Fn(&str) -> Option<OpencodeSessionDirectory> + Send + Sync>;

/// claude transcript exact-id fallback: lowercased id + original cwd.
pub type ClaudeLocator = Arc<dyn Fn(&str) -> Option<ClaudeTranscriptHit> + Send + Sync>;

/// Shared state for the resolve surface.
#[derive(Clone)]
pub struct ResolveState {
    pub auth_token: Arc<String>,
    /// `config.sessionOverrides` reader (`settings_store.rs`): the resolve
    /// read model drops `deleted: true` sessions exactly like the sidebar's
    /// `apply_session_overrides` and Node's post-filter `getProjects()`.
    pub settings: SettingsStore,
    pub session_index: Option<Arc<SessionIndex>>,
    pub session_metadata: SessionMetadataStore,
    pub opencode_dir_by_id: Option<OpencodeDirLookup>,
    pub locate_claude_transcript: Option<ClaudeLocator>,
}

pub fn router(state: ResolveState) -> Router {
    Router::new()
        .route("/api/sessions/resolve", post(resolve_session))
        .with_state(state)
}

/// zod v4's received-type word for a JSON value.
fn received_type(value: &Value) -> &'static str {
    match value {
        Value::Array(_) => "array",
        Value::String(_) => "string",
        Value::Number(_) => "number",
        Value::Bool(_) => "boolean",
        Value::Null => "null",
        Value::Object(_) => "object",
    }
}

/// Validate the request body against `ResumeResolveRequestSchema` semantics:
/// strict object, `input: string`, 1..=20000 UTF-16 code units. Returns the
/// input on success, or the `details` issue array on failure — every literal
/// (field set, key ORDER, message wording) is the ACTUAL zod 4.3.6 wire
/// output, probed against the real schema; see the module doc for the
/// version-fragility and no-consumer notes. `json!` insertion order IS the
/// serialized key order (workspace-wide `preserve_order`).
fn validate_resolve_body(body: &Value) -> Result<String, Value> {
    let Value::Object(map) = body else {
        // zod 4.3.6: `expected` precedes `code`; message carries the
        // received type: `[1,2]` -> "...received array", `"x"` ->
        // "...received string", etc.
        return Err(json!([{
            "expected": "object",
            "code": "invalid_type",
            "path": [],
            "message": format!("Invalid input: expected object, received {}", received_type(body))
        }]));
    };
    let mut issues: Vec<Value> = Vec::new();
    // zod emits the shape (`input`) issue BEFORE `unrecognized_keys`
    // (probed: `{foo:1}` -> [invalid_type(input), unrecognized_keys]).
    match map.get("input") {
        Some(Value::String(s)) => {
            let len = s.encode_utf16().count();
            if len < 1 {
                issues.push(json!({
                    "origin": "string",
                    "code": "too_small",
                    "minimum": 1,
                    "inclusive": true,
                    "path": ["input"],
                    "message": "Too small: expected string to have >=1 characters"
                }));
            } else if len > RESOLVE_INPUT_MAX_UTF16 {
                issues.push(json!({
                    "origin": "string",
                    "code": "too_big",
                    "maximum": RESOLVE_INPUT_MAX_UTF16,
                    "inclusive": true,
                    "path": ["input"],
                    "message": "Too big: expected string to have <=20000 characters"
                }));
            }
        }
        other => {
            // Missing (`received undefined`) and non-string values both
            // surface zod's invalid_type, with the actual received type.
            let received = other.map_or("undefined", received_type);
            issues.push(json!({
                "expected": "string",
                "code": "invalid_type",
                "path": ["input"],
                "message": format!("Invalid input: expected string, received {received}")
            }));
        }
    }
    let unknown: Vec<&str> = map
        .keys()
        .map(String::as_str)
        .filter(|k| *k != "input")
        .collect();
    if !unknown.is_empty() {
        // zod 4.3.6: double-quoted names, singular/plural noun.
        let listed = unknown
            .iter()
            .map(|k| format!("\"{k}\""))
            .collect::<Vec<_>>()
            .join(", ");
        let noun = if unknown.len() == 1 { "key" } else { "keys" };
        issues.push(json!({
            "code": "unrecognized_keys",
            "keys": unknown,
            "path": [],
            "message": format!("Unrecognized {noun}: {listed}")
        }));
    }
    if issues.is_empty() {
        Ok(map
            .get("input")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string())
    } else {
        Err(Value::Array(issues))
    }
}

/// `POST /api/sessions/resolve`. Body taken as raw bytes (never an
/// axum-flavored rejection): an ABSENT or UNPARSEABLE body becomes `{}` —
/// the same value Express's `req.body ?? {}` hands zod for an absent body —
/// so it 400s with the missing-`input` issue. Parsed non-object values
/// (array/string/number/bool/null) flow to the invalid_type-object branch.
/// Recorded deviation (module doc): Express's strict body parser answers
/// malformed JSON and JSON scalars with an HTML 400 before zod ever runs;
/// this port answers those with the zod-shaped JSON 400 (status parity only
/// — no consumer reads 400 bodies). Arrays reach zod on both sides.
async fn resolve_session(
    State(state): State<ResolveState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let parsed: Value =
        serde_json::from_slice(&body).unwrap_or_else(|_| Value::Object(Map::new()));
    let input = match validate_resolve_body(&parsed) {
        Ok(input) => input,
        Err(details) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "Invalid resolve request", "details": details })),
            )
                .into_response();
        }
    };

    // Readiness gate = Node's `getIndexReadiness()`: a never-published (or
    // absent) index answers `warming`. When a snapshot exists, `snapshot()`
    // returns it immediately (stale-while-revalidate) — it only blocks when
    // truly cold, which `peek()` has already excluded.
    let snapshot = match state.session_index.as_ref() {
        Some(index) => match index.peek() {
            Some(_) => Some(index.snapshot().await),
            None => None,
        },
        None => None,
    };

    // Deleted-override filter: Node's resolve reads the POST-filter project
    // groups (`session-indexer.ts:209,1155-1156`) and the Rust sidebar
    // applies the same overlay (`session_directory.rs`
    // `apply_session_overrides`) — the resolve read model must agree with
    // both. Composite key `"{provider}:{session_id}"` ONLY: Node's extra
    // bare-id/legacy-claude override keys are a pre-existing accepted
    // divergence (the Rust sidebar does not consult them either). The
    // exact-id FALLBACKS below intentionally BYPASS this filter — Node's
    // fallbacks read sqlite/the filesystem directly and never consult
    // overrides (`resolve-session.ts:59-103`) — bug-for-bug.
    let snapshot: Option<Vec<IndexedSession>> = snapshot.map(|sessions| {
        let overrides = state.settings.session_overrides();
        sessions
            .iter()
            .filter(|session| {
                overrides
                    .get(&session.key())
                    .and_then(Value::as_object)
                    .is_none_or(|ov| {
                        !ov.get("deleted").and_then(Value::as_bool).unwrap_or(false)
                    })
            })
            .cloned()
            .collect()
    });

    // sessionType overlay (Node: `session-indexer.ts:1159-1161`), keyed
    // `"{provider}:{session_id}"`. Only needed when we can match at all.
    let session_types: HashMap<String, String> = if snapshot.is_some() {
        state
            .session_metadata
            .get_all()
            .await
            .into_iter()
            .filter_map(|(key, entry)| {
                entry
                    .get("sessionType")
                    .and_then(Value::as_str)
                    .map(|t| (key, t.to_string()))
            })
            .collect()
    } else {
        HashMap::new()
    };

    let opencode = state.opencode_dir_by_id.clone();
    let claude = state.locate_claude_transcript.clone();
    let joined = tokio::task::spawn_blocking(move || {
        let deps = ResolveDeps {
            // as_deref (Option<Vec<T>> -> Option<&[T]>): as_ref().map(|s| s.as_slice())
            // trips clippy's warn-by-default `option_as_ref_deref` under -D warnings.
            sessions: snapshot.as_deref(),
            session_types: &session_types,
            opencode_dir_by_id: opencode.as_deref(),
            locate_claude_transcript: claude.as_deref(),
        };
        resolve_resume_input(&input, &deps)
    })
    .await;

    // JoinError = the resolve task panicked. Express would 500 here; this
    // port answers a benign ready-empty (Global Constraint: never 5xx) and
    // the panic is already on stderr for diagnosis.
    let response = joined.unwrap_or(ResumeResolveResponse {
        status: ResumeResolveStatus::Ready,
        matches: Vec::new(),
        hint: None,
    });
    Json(response).into_response()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    use freshell_sessions::directory_index::{
        FileStat, IndexedSession, SessionIndex, SessionSource,
    };

    const CLAUDE_ID: &str = "ed2afda6-a340-443e-ba60-024a1b3554b4";

    /// A file-less, direct-listed source: `discover()` empty, `direct_list()`
    /// serves the fixture rows — a hermetic SessionIndex with zero disk IO.
    struct FixtureSource(Vec<IndexedSession>);

    impl SessionSource for FixtureSource {
        fn discover(&self) -> Vec<FileStat> {
            Vec::new()
        }
        fn parse(&self, _path: &std::path::Path) -> Option<IndexedSession> {
            None
        }
        fn direct_change_token(&self) -> Option<i64> {
            Some(1)
        }
        fn direct_list(&self) -> Result<Vec<IndexedSession>, String> {
            Ok(self.0.clone())
        }
    }

    async fn fixture_index(sessions: Vec<IndexedSession>) -> Arc<SessionIndex> {
        let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(FixtureSource(sessions)) as Arc<dyn SessionSource>],
            std::time::Duration::from_secs(3600),
            None,
        ));
        index.warm().await;
        index
    }

    fn claude_fixture() -> IndexedSession {
        IndexedSession {
            session_id: CLAUDE_ID.to_string(),
            provider: "claude".to_string(),
            project_path: "/repo/alpha".to_string(),
            title: Some("Fix the parser".to_string()),
            summary: None,
            first_user_message: Some("fix the parser".to_string()),
            last_activity_at: 400,
            created_at: None,
            cwd: Some("/repo/alpha".to_string()),
            is_subagent: false,
            is_non_interactive: false,
            source_file: None,
        }
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "frs-resolve-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("mkdir temp dir");
        dir
    }

    fn state(
        dir: &std::path::Path,
        index: Option<Arc<SessionIndex>>,
    ) -> super::ResolveState {
        super::ResolveState {
            auth_token: Arc::new("tok".into()),
            // Isolated home: overrides read/write under `<dir>/.freshell/`,
            // never the developer's real config (same pattern as the
            // session_directory router tests).
            settings: crate::settings_store::SettingsStore::load(
                Some(dir),
                vec!["claude".into()],
            ),
            session_index: index,
            session_metadata: crate::session_metadata::SessionMetadataStore::new(dir),
            opencode_dir_by_id: None,
            locate_claude_transcript: None,
        }
    }

    async fn post(
        state: super::ResolveState,
        body: serde_json::Value,
        with_auth: bool,
    ) -> (StatusCode, serde_json::Value) {
        let app = super::router(state);
        let mut builder = Request::builder()
            .method("POST")
            .uri("/api/sessions/resolve")
            .header("content-type", "application/json");
        if with_auth {
            builder = builder.header("x-auth-token", "tok");
        }
        let request = builder.body(Body::from(body.to_string())).unwrap();
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        (status, value)
    }

    #[tokio::test]
    async fn rejects_unauthenticated_requests() {
        let dir = temp_dir("auth");
        let (status, body) = post(
            state(&dir, None),
            serde_json::json!({ "input": CLAUDE_ID }),
            false,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body, serde_json::json!({ "error": "Unauthorized" }));
    }

    #[tokio::test]
    async fn rejects_unknown_keys_with_the_zod_4_3_6_literal() {
        // `input` valid, two unknown keys: exactly ONE issue, plural noun,
        // double-quoted names, key order code/keys/path/message.
        let dir = temp_dir("strict");
        let (status, body) = post(
            state(&dir, None),
            serde_json::json!({ "input": "x", "foo": 1, "bar": 2 }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Invalid resolve request");
        assert_eq!(
            body["details"],
            serde_json::json!([{
                "code": "unrecognized_keys",
                "keys": ["foo", "bar"],
                "path": [],
                "message": "Unrecognized keys: \"foo\", \"bar\""
            }])
        );
    }

    #[tokio::test]
    async fn multi_issue_order_is_input_issue_then_unrecognized_keys() {
        // Probed zod 4.3.6 behavior for `{foo:1}`: the `input` invalid_type
        // issue comes FIRST, `unrecognized_keys` (singular form) SECOND.
        let dir = temp_dir("multi");
        let (status, body) =
            post(state(&dir, None), serde_json::json!({ "foo": 1 }), true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body["details"],
            serde_json::json!([
                {
                    "expected": "string",
                    "code": "invalid_type",
                    "path": ["input"],
                    "message": "Invalid input: expected string, received undefined"
                },
                {
                    "code": "unrecognized_keys",
                    "keys": ["foo"],
                    "path": [],
                    "message": "Unrecognized key: \"foo\""
                }
            ])
        );
    }

    #[tokio::test]
    async fn zod_details_literals_match_zod_4_3_6_wire_output() {
        // One case per failure class; expectations are the EXACT zod 4.3.6
        // `parsed.error.issues` output probed against the real schema. The
        // scalar bodies (`null` here) are the recorded deviation: Express's
        // strict body parser HTML-400s them before zod, Rust answers the
        // zod-shaped issue for the parsed value instead.
        let dir = temp_dir("bounds");
        let cases: Vec<(serde_json::Value, serde_json::Value)> = vec![
            (
                serde_json::json!({ "input": "" }),
                serde_json::json!([{
                    "origin": "string",
                    "code": "too_small",
                    "minimum": 1,
                    "inclusive": true,
                    "path": ["input"],
                    "message": "Too small: expected string to have >=1 characters"
                }]),
            ),
            (
                serde_json::json!({}),
                serde_json::json!([{
                    "expected": "string",
                    "code": "invalid_type",
                    "path": ["input"],
                    "message": "Invalid input: expected string, received undefined"
                }]),
            ),
            (
                serde_json::json!({ "input": 123 }),
                serde_json::json!([{
                    "expected": "string",
                    "code": "invalid_type",
                    "path": ["input"],
                    "message": "Invalid input: expected string, received number"
                }]),
            ),
            (
                serde_json::json!({ "input": "x".repeat(20001) }),
                serde_json::json!([{
                    "origin": "string",
                    "code": "too_big",
                    "maximum": 20000,
                    "inclusive": true,
                    "path": ["input"],
                    "message": "Too big: expected string to have <=20000 characters"
                }]),
            ),
            (
                serde_json::json!([1, 2]),
                serde_json::json!([{
                    "expected": "object",
                    "code": "invalid_type",
                    "path": [],
                    "message": "Invalid input: expected object, received array"
                }]),
            ),
            (
                serde_json::json!(null),
                serde_json::json!([{
                    "expected": "object",
                    "code": "invalid_type",
                    "path": [],
                    "message": "Invalid input: expected object, received null"
                }]),
            ),
        ];
        for (body, details) in cases {
            let (status, response) = post(state(&dir, None), body.clone(), true).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "body {body}");
            assert_eq!(response["error"], "Invalid resolve request", "body {body}");
            assert_eq!(response["details"], details, "body {body}");
        }
        // Key ORDER is part of the wire shape (zod v4 emits `expected` /
        // `origin` BEFORE `code`). `Value` equality is order-insensitive, so
        // pin one case as a serialized string — `preserve_order` makes the
        // parsed order round-trip the wire order.
        let (_, response) =
            post(state(&dir, None), serde_json::json!({ "input": 123 }), true).await;
        assert_eq!(
            serde_json::to_string(&response["details"]).unwrap(),
            r#"[{"expected":"string","code":"invalid_type","path":["input"],"message":"Invalid input: expected string, received number"}]"#
        );
    }

    #[tokio::test]
    async fn input_of_exactly_20000_chars_is_accepted() {
        let dir = temp_dir("maxok");
        let (status, body) =
            post(state(&dir, None), serde_json::json!({ "input": "x".repeat(20000) }), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "warming"); // no index in this state
    }

    #[tokio::test]
    async fn warming_with_hint_when_index_never_published() {
        let dir = temp_dir("warming");
        let (status, body) = post(
            state(&dir, None),
            serde_json::json!({ "input": format!("claude --resume {CLAUDE_ID}") }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            serde_json::json!({
                "status": "warming",
                "matches": [],
                "hint": { "provider": "claude", "source": "command" }
            })
        );
    }

    #[tokio::test]
    async fn exact_match_returns_full_metadata_via_the_index() {
        let dir = temp_dir("exact");
        let index = fixture_index(vec![claude_fixture()]).await;
        let (status, body) = post(
            state(&dir, Some(index)),
            serde_json::json!({ "input": CLAUDE_ID }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ready");
        assert_eq!(
            body["matches"],
            serde_json::json!([{
                "provider": "claude",
                "sessionId": CLAUDE_ID,
                "cwd": "/repo/alpha",
                "title": "Fix the parser",
                "firstUserMessage": "fix the parser",
                "lastActivityAt": 400,
                "matchKind": "exact"
            }])
        );
    }

    #[tokio::test]
    async fn session_type_overlays_from_the_metadata_store_file() {
        let dir = temp_dir("stype");
        std::fs::write(
            dir.join("session-metadata.json"),
            serde_json::json!({
                "version": 1,
                "sessions": {
                    "claude": {
                        CLAUDE_ID: { "sessionType": "freshclaude", "sessionTypeSource": "explicit" }
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        let index = fixture_index(vec![claude_fixture()]).await;
        let (_, body) = post(
            state(&dir, Some(index)),
            serde_json::json!({ "input": CLAUDE_ID }),
            true,
        )
        .await;
        assert_eq!(body["matches"][0]["sessionType"], "freshclaude");
    }

    #[tokio::test]
    async fn unknown_id_is_ready_empty_never_404() {
        let dir = temp_dir("miss");
        let index = fixture_index(vec![claude_fixture()]).await;
        let (status, body) = post(
            state(&dir, Some(index)),
            serde_json::json!({ "input": "019fffff-ffff-7fff-bfff-ffffffffffff" }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ready");
        assert_eq!(body["matches"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn opencode_fallback_answers_with_row_directory() {
        let dir = temp_dir("ocfb");
        let index = fixture_index(vec![claude_fixture()]).await;
        let unknown = "ses_child000000000000000000000";
        let mut st = state(&dir, Some(index));
        st.opencode_dir_by_id = Some(Arc::new(|_id: &str| {
            Some(freshell_sessions::parse::OpencodeSessionDirectory {
                directory: Some("/repo/beta".to_string()),
            })
        }));
        let (status, body) = post(st, serde_json::json!({ "input": unknown }), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body["matches"],
            serde_json::json!([{
                "provider": "opencode",
                "sessionId": unknown,
                "cwd": "/repo/beta",
                "sessionType": "opencode",
                "matchKind": "exact"
            }])
        );
    }

    #[tokio::test]
    async fn claude_transcript_fallback_answers_on_index_miss() {
        let dir = temp_dir("clfb");
        let index = fixture_index(vec![claude_fixture()]).await;
        let unknown = "aaaaaaaa-1111-4222-8333-444444444444";
        let mut st = state(&dir, Some(index));
        st.locate_claude_transcript = Some(Arc::new(move |id: &str| {
            Some(freshell_sessions::resume_resolve::ClaudeTranscriptHit {
                session_id: id.to_ascii_lowercase(),
                cwd: Some("/repo/gamma".to_string()),
            })
        }));
        let (status, body) = post(st, serde_json::json!({ "input": unknown }), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body["matches"],
            serde_json::json!([{
                "provider": "claude",
                "sessionId": unknown,
                "cwd": "/repo/gamma",
                "sessionType": "claude",
                "matchKind": "exact"
            }])
        );
    }

    #[tokio::test]
    async fn deleted_override_hides_the_session_from_resolve() {
        // Node's resolve reads the post-deleted-filter project groups
        // (`session-indexer.ts:209,1155-1156`) and the Rust sidebar filters
        // the same way (`session_directory.rs::apply_session_overrides`) —
        // the resolve read model must agree with both. Written through the
        // REAL override write path (`patch_session_override`, the same call
        // `PATCH /api/sessions/{id}` lands on).
        let dir = temp_dir("deleted");
        let index = fixture_index(vec![claude_fixture()]).await;
        let st = state(&dir, Some(index));
        st.settings
            .patch_session_override(
                &format!("claude:{CLAUDE_ID}"),
                &[("deleted", Some(serde_json::json!(true)))],
            )
            .await;
        let (status, body) = post(st, serde_json::json!({ "input": CLAUDE_ID }), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ready");
        assert_eq!(body["matches"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn malformed_json_body_degrades_to_the_missing_input_400() {
        // Express's strict body parser answers malformed JSON with an HTML
        // 400 before zod runs; this port treats an unparseable body as `{}`
        // (Node's absent-body `req.body ?? {}`) and answers the zod-shaped
        // missing-`input` 400 — status parity only, a recorded deviation.
        let dir = temp_dir("badjson");
        let app = super::router(state(&dir, None));
        let request = Request::builder()
            .method("POST")
            .uri("/api/sessions/resolve")
            .header("content-type", "application/json")
            .header("x-auth-token", "tok")
            .body(Body::from("{not json"))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "Invalid resolve request");
        assert_eq!(
            body["details"],
            serde_json::json!([{
                "expected": "string",
                "code": "invalid_type",
                "path": ["input"],
                "message": "Invalid input: expected string, received undefined"
            }])
        );
    }
}
```

- [ ] **Step 3: Register the module and run the new tests — RED then GREEN**

In `crates/freshell-server/src/main.rs`, add `mod resolve;` to the module declaration list (lines ~19-45, alphabetical: after `recovery_inventory`/`repo_icon*`... place it between `rate_limit` and `recovery_inventory` — keep whatever ordering the list actually uses).

```bash
cargo test -p freshell-server resolve::
```

Expected on first run: everything compiles and the tests PASS if Step 2 was transcribed faithfully (the handler was written alongside its tests). If any test fails, fix the handler — the tests in Step 2 are the parity contract. Also confirm no route-collision panic: the static `/api/sessions/resolve` coexists with `sessions.rs`'s `PATCH /api/sessions/{session_id}` (different router, merged; matchit prefers static segments).

- [ ] **Step 4: Wire production dependencies in `main.rs`**

(a) Immediately BEFORE the `let diag_session_index = session_index.clone();` line (~line 900), add:

```rust
    // SYNC-06: the resolve endpoint reads the SAME session index the History
    // surfaces read (clone before the move below into `session_directory_state`).
    let resolve_session_index = session_index.clone();
```

(b) At the `session_metadata::router(...)` state construction (~line 983), the store is MOVED (`store: session_metadata_store`). Change that field to `store: session_metadata_store.clone(),` so the binding survives for the resolve state.

(c) In the app assembly (~line 1074), directly after the `.merge(sessions::router(...))` block, add:

```rust
        .merge(resolve::router(resolve::ResolveState {
            auth_token: Arc::clone(&auth_token),
            // SYNC-06 deleted-override filter: the SAME settings store the
            // sidebar overlay (`SessionDirectoryState.settings`) and
            // `PATCH /api/sessions/{id}` write path use (constructed once
            // at ~line 196; Clone shares the Arc-backed innards).
            settings: settings_store.clone(),
            session_index: resolve_session_index,
            // SYNC-06 sessionType overlay: the SAME store `POST
            // /api/session-metadata` writes (Node overlays it in
            // `session-indexer.ts:1159-1161`).
            session_metadata: session_metadata_store.clone(),
            // opencode `ses_*` exact-id fallback: the SAME data home the
            // OpencodeSource uses. Read errors (`Err`) are a resolve miss,
            // never a 5xx — the endpoint's never-5xx contract.
            opencode_dir_by_id: Some(std::sync::Arc::new(|session_id: &str| {
                let data_home = freshell_sessions::parse::default_opencode_data_home();
                freshell_sessions::parse::opencode_session_directory_by_id(
                    &data_home, session_id,
                )
                .ok()
                .flatten()
            })),
            // claude transcript exact-id fallback: the SAME ordered-roots scan
            // the attach arm and IndexExistenceProbe trust
            // (CLAUDE_CONFIG_DIR > CLAUDE_HOME > $HOME/.claude), paired with
            // the original-cwd reader. Node's locator lowercases the id
            // before scanning and returns the lowercased id — mirrored here.
            locate_claude_transcript: Some(std::sync::Arc::new(|session_id: &str| {
                let lowered = session_id.to_ascii_lowercase();
                let path = freshell_freshagent::locate_transcript(&lowered)?;
                Some(freshell_sessions::resume_resolve::ClaudeTranscriptHit {
                    session_id: lowered,
                    cwd: freshell_freshagent::transcript_cwd(&path),
                })
            })),
        }))
```

Note: `session_metadata_store` is constructed at ~line 980, i.e. AFTER `resolve_session_index` is cloned at ~line 900 but BEFORE the app assembly at ~line 1074 — both are in scope at the merge site. If the compiler disagrees about ordering, move the resolve-state construction into a `let resolve_state = ...` binding placed after line 983 and merge that.

- [ ] **Step 5: Build + full crate test**

Node deps must be present (`tests/safe11_term22_shutdown_reaping.rs` spawns the committed Node fixture `fake-app-server.mjs`, which imports `ws`) — the guard is a no-op if Task 1 Step 0 already ran:

```bash
test -d node_modules || npm ci --no-audit --no-fund
cargo test -p freshell-server
```

Expected: all green, including the pre-existing `session_metadata` and `sessions` suites.

- [ ] **Step 6: Format, lint, commit**

```bash
cargo fmt --all
cargo clippy -p freshell-server --all-targets -- -D warnings
git add crates/freshell-server/src/resolve.rs crates/freshell-server/src/session_metadata.rs crates/freshell-server/src/main.rs
git commit -m "feat(server): POST /api/sessions/resolve with Node-parity behavior (SYNC-06)"
```

---

### Task 7: Declare the `sessionResolve` feature flag

Unconditional `true`, exactly like Node. Test-first: the two whole-object flag assertions in `main.rs` are the RED.

**Files:**
- Modify: `crates/freshell-server/src/main.rs` (`build_platform_payload` + its two tests)
- Modify: `server/platform-router.ts` (comment only)

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /api/platform` / `GET /api/bootstrap` featureFlags now include `"sessionResolve": true` — the shared client's `s.connection?.featureFlags?.sessionResolve === true` gate (Sidebar.tsx) starts rendering the Resume button on Rust builds. No client change.

- [ ] **Step 1: Update the two flag tests to expect the new flag (RED)**

In `crates/freshell-server/src/main.rs` tests (~lines 2179-2199), update BOTH assertions:

```rust
    #[test]
    fn platform_payload_feature_flags_shape_matches_legacy() {
        // `server/platform-router.ts#detectFeatureFlags`: `{ kilroy, aiEnabled,
        // sessionResolve }`, camelCase, no extra fields — mirrored 1:1 in the
        // Rust payload. `sessionResolve` is an unconditional literal on both
        // servers (SYNC-06).
        let env = MapEnv::new().with("GOOGLE_GENERATIVE_AI_API_KEY", "sk-live-abc123");
        let payload = build_platform_payload(serde_json::json!({}), &env);
        assert_eq!(
            payload["featureFlags"],
            serde_json::json!({ "kilroy": false, "aiEnabled": true, "sessionResolve": true })
        );
    }

    #[test]
    fn platform_payload_ai_enabled_false_without_key() {
        let env = MapEnv::new();
        let payload = build_platform_payload(serde_json::json!({}), &env);
        assert_eq!(
            payload["featureFlags"],
            serde_json::json!({ "kilroy": false, "aiEnabled": false, "sessionResolve": true })
        );
    }
```

- [ ] **Step 2: Run to verify both fail**

```bash
cargo test -p freshell-server platform_payload
```

Expected: 2 FAILED (payload lacks `sessionResolve`).

- [ ] **Step 3: Declare the flag**

In `build_platform_payload` (~line 1553), change the featureFlags line to:

```rust
        "featureFlags": { "kilroy": false, "aiEnabled": ai_enabled(env), "sessionResolve": true },
```

and extend the function's doc comment with one line:

```rust
/// `featureFlags.sessionResolve` is the unconditional literal both servers
/// declare now that `POST /api/sessions/resolve` exists here too (SYNC-06).
```

- [ ] **Step 4: Run to verify both pass**

```bash
cargo test -p freshell-server platform_payload
```

Expected: 2 passed.

- [ ] **Step 5: Retire the stale Node comment**

In `server/platform-router.ts` (inside `detectFeatureFlags`), replace:

```ts
    // Resume-by-id UI: only the Node server implements POST /api/sessions/resolve.
    // The Rust server's featureFlags parity (crates/freshell-server/src/boot.rs)
    // intentionally omits this key, hiding the Sidebar Resume button there.
    sessionResolve: true,
```

with:

```ts
    // Resume-by-id UI (SYNC-06): BOTH servers implement POST
    // /api/sessions/resolve and declare this flag — the Rust side in
    // build_platform_payload (crates/freshell-server/src/main.rs).
    sessionResolve: true,
```

Comment-only change; verify with (deps guard is a no-op if Task 1 Step 0 already ran):

```bash
test -d node_modules || npm ci --no-audit --no-fund
npm run typecheck
npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/integration/server/sessions-resolve-router.test.ts --run
```

Expected: typecheck clean; 14 passed (Node suite untouched, still green).

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-server/src/main.rs server/platform-router.ts
git commit -m "feat(server): declare sessionResolve feature flag from the Rust server (SYNC-06)"
```

---

### Task 8: Enable the resume-button e2e spec on BOTH Playwright projects

The checklist's PW-RUST validation. Two coupled edits — doing only one produces a silent false green: (1) delete the defensive skip guard, (2) register the spec in `MATRIX_SPECS`.

**Files:**
- Modify: `test/e2e-browser/specs/resume-button.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts`

**Interfaces:**
- Consumes: the Rust endpoint + flag (Tasks 6–7). The spec's `bootResumeScenario(e2eServerKind)` already parameterizes server kind, seeds an isolated HOME with 45 codex `~/.codex/sessions/*.jsonl` fixtures (first line `{type:'session_meta', payload:{id, cwd}}` — indexable by Rust's `CodexSource`, which honors the harness's `CODEX_HOME`), and boots via `createE2eServerHandle`.
- Produces: 3 tests × 2 projects green — the GATE-01 "no Rust-only skips for a user-visible feature" evidence.

- [ ] **Step 0: Install node deps in the worktree (Playwright precondition)**

The worktree starts with NO `node_modules` and no `dist/client`. Playwright's `globalSetup` builds the client but does NOT install dependencies, and the legacy leg's `fake-app-server.mjs` imports `ws` — so ANY Playwright invocation below (even `--list`) needs deps installed first:

```bash
cd /home/dan/code/freshell/.worktrees/rust-resolve-parity
test -d node_modules || npm ci --no-audit --no-fund
```

- [ ] **Step 1: Delete the skip guard**

In `test/e2e-browser/specs/resume-button.spec.ts`:
1. Delete the `RUST_SKIP` constant (lines ~46-50):

```ts
const RUST_SKIP =
  'KNOWN DIVERGENCE: the Rust server has no POST /api/sessions/resolve and does not ' +
  'declare the sessionResolve feature flag (button hidden there by design) — ' +
  'out of scope, see docs/plans/2026-07-29-resume-session-button.md.'
```

2. Delete all three `test.skip(e2eServerKind !== 'legacy', RUST_SKIP)` lines (the first statement of each test, at ~lines 233, 264, 284). Keep the `e2eServerKind` fixture parameter in each test signature — it still drives `createE2eServerHandle`/`bootResumeScenario`.

- [ ] **Step 2: Register the spec in `MATRIX_SPECS`**

In `test/e2e-browser/playwright.config.ts`, add to the `MATRIX_SPECS` array (alphabetical near the other `resume`/`sidebar` entries, following the file's one-comment-per-entry convention):

```ts
  // SYNC-06 -- resume-by-id parity: the pinned sidebar Resume button and the
  // paste-then-Enter resume path against BOTH servers (POST /api/sessions/resolve
  // + sessionResolve flag now exist on the Rust server too).
  /resume-button\.spec\.ts$/,
```

- [ ] **Step 3: Verify collection is non-zero on BOTH projects (silent-false-green guard)**

```bash
cd /home/dan/code/freshell/.worktrees/rust-resolve-parity
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium --list specs/resume-button.spec.ts
npx playwright test --config test/e2e-browser/playwright.config.ts --project=legacy-chromium --list specs/resume-button.spec.ts
```

Expected: each lists exactly 3 tests ("resume button stays visible at top/middle/bottom scroll", "resume button is visible in fullWidth mobile mode", "paste-then-Enter resumes the session with the right agent"). Zero collected = the config edit is wrong; stop and fix.

- [ ] **Step 4: Build the release server and run the rust leg**

```bash
cargo build --release -p freshell-server
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium specs/resume-button.spec.ts
```

Expected: 3 passed (NOT skipped — verify the summary says "3 passed", not "3 skipped"). Debugging notes if red:
- Button not visible → check `GET /api/bootstrap` from the harness server includes `featureFlags.sessionResolve: true` (Task 7).
- Dialog finds no match → the Rust `CodexSource` didn't index the seeded fixtures; confirm the harness env sets `CODEX_HOME=<home>/.codex` (`helpers/rust-server.ts` `applyIsolatedHomeEnvironment`) and that the fixture's first line carries `payload.cwd` (Rust's `parse_codex_file` requires `meta.cwd`).
- `status: warming` forever → the index never warmed; check the server booted with a resolvable `HOME` (the harness sets one).
- The dual-mode `CODEX_CMD` wrapper is harmless on the Rust leg (falls through to TUI mode); the argv-log assertion still applies.

- [ ] **Step 5: Run the legacy leg (regression)**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=legacy-chromium specs/resume-button.spec.ts
```

Expected: 3 passed.

- [ ] **Step 6: Run both legs once more (flake check), then commit**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium --project=legacy-chromium specs/resume-button.spec.ts
git add test/e2e-browser/specs/resume-button.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): run resume-button spec on both server kinds (SYNC-06 PW-RUST)"
```

Expected: 6 passed.

---

### Task 9: Full verification sweep + checklist evidence

**Files:**
- Modify: `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the SYNC-06 closure entry with evidence; a fully green tree on the branch.

- [ ] **Step 1: Rust gates**

```bash
cd /home/dan/code/freshell/.worktrees/rust-resolve-parity
test -d node_modules || npm ci --no-audit --no-fund
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
FRESHELL_TEST_SUMMARY="SYNC-06 rust resolve parity" cargo test --workspace
```

Expected: fmt clean, clippy clean, workspace tests 0 failed. Record the per-crate pass counts for the evidence entry.

- [ ] **Step 2: TS gates (focused files + typecheck)**

```bash
npm run typecheck
npm run test:vitest -- --config config/vitest/vitest.config.ts test/unit/shared/resume-input-parser.test.ts --run
npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/integration/server/sessions-resolve-router.test.ts --run
```

Expected: typecheck clean; 32 passed; 14 passed.

- [ ] **Step 3: Checklist evidence entry**

Follow the checklist's OWN convention for items with outstanding platform legs: the checkbox stays UNCHECKED (`- [ ]`) and the evidence lands as a `PARTIAL` bullet that names what is green and what is `MISSING`. That is the SYNC-05/SAFE-11 precedent — the file's existing entry (~line 276) reads, verbatim:

> - PARTIAL (2026-07-18): `crates/freshell-server/tests/safe11_term22_shutdown_reaping.rs` (commits edf1e93d, a8d43d9d) boots the real binary, […] proven RED before the fix, green after (including sandboxed runs). MISSING: this is a Rust integration test, not a `PW-RUST`/stress-project Playwright spec — it does not cover […] (that slice is `SYNC-05`, itself only partial).

In `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md`, KEEP the SYNC-06 checkbox (~line 803) as `- [ ]` — the linux Playwright legs are green but the `PW-TAURI-WIN` half of its named validation is outstanding — and rewrite the entry as below, following the `file :: test title — assertion — projects/runs` convention. Substitute the real date, commit sha, and pass counts observed in Steps 1–2 and Task 8:

```markdown
- [ ] **SYNC-06 — Session resume-by-id parity: `POST /api/sessions/resolve` + `sessionResolve` feature flag.** The Node server (`server/sessions-router.ts`) resolves pasted session ids/resume commands across claude/codex/opencode/amplifier and gates the sidebar Resume button via the `sessionResolve` flag in `detectFeatureFlags()`. See `docs/plans/2026-07-29-resume-session-button.md`.
  - **Playwright validation (`PW-RUST`, `PW-TAURI-WIN`):** With the flag declared, the sidebar shows the pinned Resume button; pasting a known session id resumes it in a tab (mirror `test/e2e-browser/specs/resume-button.spec.ts`).
  - PARTIAL (<date>, commit `<sha>`): Rust endpoint `crates/freshell-server/src/resolve.rs` (`POST /api/sessions/resolve`: auth/400-validation pinned to zod 4.3.6 wire literals/warming/exact/prefix/cap-20/dedupe/deleted-override filter/opencode-walk+claude exact-id fallbacks) + `crates/freshell-sessions/{resume_input.rs,resume_resolve.rs}`; flag declared in `build_platform_payload` (`main.rs`). Cross-language anti-drift: `test/fixtures/resume-input/parser-cases.json` (31 cases) consumed by BOTH `test/unit/shared/resume-input-parser.test.ts` (32 passed) and `crates/freshell-sessions/tests/resume_input_parser_parity.rs` (green). Logic parity: `crates/freshell-sessions/tests/resume_resolve.rs` mirrors `test/integration/server/sessions-resolve-router.test.ts` (14 passed, unchanged). `cargo test --workspace`: <counts> passed, 0 failed; `cargo fmt --all -- --check` / `cargo clippy --workspace --all-targets -- -D warnings` clean. E2E (`PW-RUST` half): `test/e2e-browser/specs/resume-button.spec.ts` moved into `MATRIX_SPECS` with the legacy-only skip guard DELETED — all 3 tests (pinned visibility at scroll, fullWidth mobile visibility, paste-then-Enter real resume with argv proof) green on BOTH projects (legacy-chromium and rust-chromium), 2 runs each. MISSING: the `PW-TAURI-WIN` (native Windows WebView2) half of the named validation — left to dependent tickets, per the SYNC-05/SAFE-11 PARTIAL convention.
```

- [ ] **Step 4: Final commit**

```bash
git add docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md
git commit -m "docs: record SYNC-06 rust resolve parity evidence in completion checklist"
git log --oneline origin/main..HEAD
```

Expected: the branch carries one focused commit per task (≈10). Do NOT push/PR without explicit user approval.

---

## Self-Review Record

**1. Spec coverage.** R1 endpoint parity → Task 6 (same path, same auth helper as all Rust API routes, zod-shaped strict validation with the exact 400 body, always-200 semantics). R2 parser parity + shared fixtures → Tasks 1–2 (one committed JSON table, both suites consume it). R3 matching parity (four providers, exact+prefix, most-recent-first, cap 20, matchKind) → Task 5 (+ HTTP-level pins in Task 6). R4 fallback parity → Task 3 ports Node's opencode by-id parent-walk bug for bug (legacy early hit, truthy-directory filter, orphan/cycle miss); Task 4 reuses the existing claude `locate_transcript` + its already-written cwd companion via export, with the locator's known deltas RECORDED as accepted deviations (Task 4 note + Parity Reference list) rather than claimed as parity. R5 metadata parity → Task 5 `to_match` + the sessionType overlay from the metadata store (Task 6 Step 1 un-gates the read; Node's overlay source is the same store, and absence is the normal case on both servers — the client falls back to `sessionType ?? provider`). R6 warming parity → Task 5/6 (peek-gated; hint still populated; `session_index: None` also warms, documented). R7 feature flag, ungated → Task 7. R8 checklist update with PW-TAURI-WIN out-of-scope note → Task 9. Verification section: Rust tests mirroring the Node suite (Task 5 + Task 6 tests), clippy/fmt (Tasks 2–9), cross-language fixtures (Tasks 1–2), e2e on both projects with guard removal + MATRIX_SPECS registration (Task 8), client suite untouched (comment-only TS changes; typecheck + the two vitest files re-run in Task 9).

**1b. No silent deferrals.** Every requirement lands as production behavior proven by an observable outcome: the e2e paste-then-Enter test spawns a REAL CLI with `resume <id>` argv against the REAL Rust server binary (no stub); fallback closures in production wiring call the real sqlite/filesystem code (test doubles appear only inside unit tests, with the production path covered by Task 3/4's direct tests + Task 8's e2e). The single intentional error-path divergence (Rust answers ready-empty where Express would 500 on a thrown dependency) is recorded in code comments (Task 5/6) and follows the Rust port's existing never-5xx convention; it is unobservable by the client's happy path and untested on the Node side.

**2. Placeholder scan.** No TBDs; every code step carries complete code; commands carry expected outputs. Two deliberate "verbatim-context" dependencies remain (main.rs line numbers drift; the implementer anchors on the quoted surrounding code, which is provided), and Task 9's evidence entry contains `<date>/<sha>/<counts>` placeholders that are explicitly instructed to be substituted with observed values — they cannot be known at plan time.

**3. Type consistency.** `ResumeCandidateKind/{PrefixedId,Uuid,HexPrefix}`, `ResumeHint{provider,source}` (Task 2) are consumed with those exact names in Tasks 5–6. `OpencodeSessionDirectory{directory}` (Task 3) is the closure payload in Tasks 5–6. `ClaudeTranscriptHit{session_id,cwd}` (Task 5) is constructed in Task 6's wiring and tests. `ResolveDeps` field names/borrow shapes match between definition (Task 5) and use (Task 6: `as_deref()` against `Arc<dyn Fn ... + Send + Sync>` matches the `&(dyn Fn ... + Send + Sync)` field type). `RESOLVE_MATCH_CAP` is defined once (Task 5) and asserted in tests. `SessionMetadataStore::new(dir)` appends `session-metadata.json` — Task 6's overlay test writes that exact filename into the dir it passes.

**4. Load-bearing-assumption revision (2026-07-29).** A validation pass falsified four assumptions; this plan was revised accordingly and the self-review items above were re-applied to every edited task. A2 (V2-zod-truth): Task 6's 400 `details` literals were zod v3 wording — rewritten to the probed zod 4.3.6 wire output (received-type message suffixes via a `received_type` helper, `origin`/`inclusive` fields, double-quoted singular/plural `Unrecognized key(s)` form, `expected`/`origin`-before-`code` key order pinned by a serialized-string test, input-issue-before-`unrecognized_keys` array order pinned by a new multi-issue test), the body parse-failure path now degrades to `{}` (Node's absent-body `req.body ?? {}`) instead of `Null`, and the Global Constraints/module doc now record that NO consumer reads `details`, that the literals are zod-4.3.6-version-fragile (re-probe on bumps), and the accepted Express-HTML-400 / body-limit / 405-method deviations. A3 (V3-opencode-sqlite): Task 3's bare `SELECT directory` diverged from Node on 4 of 9 executed variants (D1-D4) — replaced with a bug-for-bug port of `resolveOpencodeSessionRoots` (legacy-schema early HIT with no existence check, truthy-directory filter, orphan/cycle ⇒ miss via a seen-set parent walk) plus an 11-case fixture suite covering every probed variant; Task 5's fallback docs and a new omitted-`cwd` test cover the `directory: None` hit. A4 + A14 (V4-semantics-diff, V7-deleted-overrides): the raw-snapshot membership claim was falsified — the Task 6 handler now drops `deleted`-overridden sessions via the SYNC `SettingsStore::session_overrides()` read (composite-key-only, matching Node's post-filter `getProjects()` AND the Rust sidebar's own `apply_session_overrides`; the exact-id fallbacks bypass the filter as Node's do, per comment), with `ResolveState.settings` wired from the same `settings_store.clone()` pattern as `SessionDirectoryState` and pinned by a new handler test; the remaining membership/ordering/locator deltas (enabledProviders gate, 256 KiB snippet window, cold-start window, tie-order/recency, A6 claude-locator deltas) are recorded as accepted deviations in the Parity Reference and Task 4 rather than silently claimed as parity. Also folded in: V1's 405-method note, V1's warmed-empty-index note (already honored — warming tests keep `session_index: None`), and Task 8's `npm ci` precondition (the worktree ships without `node_modules`; Playwright's globalSetup builds but does not install).
