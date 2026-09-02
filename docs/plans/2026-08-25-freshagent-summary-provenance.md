# Fresh-Agent Summary Provenance Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Re-layer fresh-agent turn summaries in one the-usual run, delivering all of: (1) the Rust server tags every fresh-agent turn summary with a provenance field (`summaryKind: 'echo' | 'authored'`) — echo means the summary is a mechanical projection of the turn's own items, authored means provider-written prose (currently only codex reasoning summaries); (2) Rust-side summary dialects are unified across providers: one truncation policy (140 characters), one tool-result label, and consistent claude fallback chains across producer paths; (3) the shared fresh-agent client consumes the provenance tag instead of reverse-engineering producer recipes — the client echo classifier (`itemEchoes`, `SUMMARY_LABEL_BY_KIND`, segment-matching/tiling logic) and the write-only client-side summarizer path are deleted, the synthetic coalescing join is kept with provenance recomputed as echo only if both sides are echo; (4) foldable captions in the fresh-agent transcript UI: echo captions render between turns until superseded by later activity, then fold into the expanded activity line, authored prose remains a permanent boundary, and stashed captions are visible inside a line's expansion.

### Explicit constraints
- Only the Rust server is in scope; do not change the Node/TypeScript server or its adapters.
- Work happens in the dedicated git worktree; no behavior changes committed directly to main; no PR creation without explicit user approval.
- Never silently fall back from the configured cloud test backends to local.
- Provenance tagging, dialect unification, client classifier deletion, and the foldable-captions feature are all delivered together in this single run.

### Accepted tradeoffs and residuals
- `summaryKind` is an optional schema field; a client talking to a server that does not emit it treats unknown provenance as `authored` (conservative: no folding).
- Echo captions disappear from the live stream with a one-time fold transition when superseded, instead of remaining painted permanently (accepted behavior change vs. the previously shipped model).
- Folding applies to echo captions only; authored prose summaries are never folded.

**Goal:** Fresh-agent turn summaries carry a server-tagged provenance (`echo` vs `authored`) that the client consumes directly — echo captions fold into activity-line expansions when superseded, authored prose stays a permanent boundary — with one Rust-side summary dialect across providers.

**Architecture:** The Rust `freshell-freshagent` crate is the single summary producer: a new `summary.rs` module owns the dialect policy (140-char truncation, `Tool result`/`Tool error` labels, the two provenance constants) — applied to every summary arm, tool names included — and the claude/codex/opencode snapshot builders tag every turn. The shared zod contract gains an optional `summaryKind` field plus a `turnSummaryIsAuthored` helper (missing tag = authored, conservative). The React transcript deletes its echo classifier, painted-summary store, and the write-only client summarizer, and drives line-absorb boundaries, caption folding into activity-strip expansions, and display-filter handling purely from the tag. Captions are pure PER-FRAME derivations of the turn list (no paint history): the final open activity line paints its last member's gated echo caption in-stream after the line, and every SUPERSEDED member of a completed line stashes its gated caption as a caption row inside the line's expansion at the item position where its turn entered — so a caption lives in exactly one place (`fresh-agent-tail-caption` in-stream, or the expansion) and folds deterministically on the frame where its turn is superseded. Paint and stash gates are identical (echo AND non-blank AND fully-visible — no display-filtered items — so hidden thinking/reasoning text can neither paint nor leak into an expansion, LB-1). Zero-item turns never carry non-blank summaries (LB-4): they hard-close the open line and render their own article, folding nothing.

**Tech Stack:** Rust (freshell-freshagent crate, cargo test/clippy/fmt), TypeScript/React 18 (FreshAgentTranscript, freshAgentSlice), Zod shared contract (`shared/`), Vitest (unit), Playwright (e2e, routed-snapshot freshcodex panes).

## Global Constraints

- **Worktree only.** All work in `/home/dan/code/freshell/.worktrees/freshagent-summary-provenance` on branch `the-usual/freshagent-summary-provenance` (base `233f3ad28c8e641bef85b5b98d15a7f9887b5a6c`, whose full coordinated suite is green per `reports/workspace-baseline.md`). No direct commits to `main`; no PR creation without explicit user approval.
- **Rust server only.** Do not modify `server/` (the Node/TypeScript server) or its adapters. The client under `src/` is shared and in scope; `test/unit/server/rust-claude-snapshot-contract.test.ts` is a Rust-output contract test and stays green via Tasks 1–2.
- **Process safety.** Never restart or stop the production Rust server on port 3001. Scratch servers only via `scripts/launch-rust.sh --port 3499` (or another unique port), stopped via the same script. Never use broad kill patterns.
- **Test backends.** Never silently fall back from a configured cloud test backend to local. Check `printenv FRESHELL_E2E_BACKEND` / `printenv FRESHELL_VITEST_BACKEND` before broad runs; if unset, ask the user before running cloud tests. Commit before any cloud run (a dirty tree is non-addressable and pays a ~13 min cold rebuild). Use repo-owned test paths: `npm run test:vitest -- ...`, `npm test` / `npm run check` for the coordinated suite; check `npm run test:status` before broad runs and set `FRESHELL_TEST_SUMMARY`.
- **Environment setup** (per `reports/workspace-baseline.md`): fresh worktree needs `npm ci` before any npm test command. Rust toolchain 1.96.x; Rust gates are `cargo test --workspace --exclude freshell-tauri`, `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`.
- **Server/ESM note:** relative imports under `server/` need `.js` extensions (not touched here); `shared/` imports already use `.js` (`shared/fresh-agent-turns.ts` imports `./fresh-agent-contract.js`) — match that style.
- **A11y:** caption rows are non-interactive text (`<div>`, no role/tabIndex); `npm run lint` (eslint-plugin-jsx-a11y) must pass.
- **`summaryKind` is optional everywhere**; a missing tag is treated as `authored` (conservative) by the client.

---

## Planning decisions and deviations

1. **DEVIATION — opencode reasoning excerpts tag `echo`, not `authored`.** The coordination input suggested opencode `reasoning.summary[0]` could tag `authored`. The user request defines authored as "provider-written prose (currently only codex reasoning summaries)", and the producer inventory (`reports/plan-rust-producers.md`) found opencode's `summary[0]` is the adapter's own mechanical projection of the part's full reasoning text (`crates/freshell-freshagent/src/lib.rs:1395-1439`), not provider summary prose. Tagging it `authored` would permanently paint full hidden reasoning in default-config (`showThinking=false`) opencode transcripts — an unrequested regression. **Every opencode summary tags `echo`.** This deviation is called out in the run's final report.
2. **The `freshAgent.assistant` reducer is KEPT; only its summary write dies.** `addAssistantMessage` (`src/store/freshAgentSlice.ts:580-601`) also clears `streamingText`/`streamingActive`, which is live-read through `pane-activity.ts`. The write-only piece is `summarizeFreshAgentItems` (`freshAgentSlice.ts:130-143`) — the summary it computes has no remaining reader once the classifier is gone — so the reducer writes `summary: ''` and the function is deleted. The WS dispatch path (`src/lib/fresh-agent-ws.ts:269-275`) is untouched.
3. **Fold gates: superseded members stash, the live tail paints — fully-visible captions only.** The fold is a pure per-frame function of the turn list (the painted-summary store stays DELETED — Task 3). Each activity line tracks its member turns in order. A member's caption (its `summary`) is a fold candidate iff it is non-blank, tagged `echo`, and the turn was FULLY VISIBLE — display filtering removed none of its items (`filterTurnsForDisplay` stamps `hadFilteredItems: true` on every removal path). When a member is superseded (a later turn absorbs, a visible/content item or zero-item turn closes the line), its candidate caption is stashed as a caption row inside the line's expansion, anchored before the item where that turn entered. The FINAL line's last member is not superseded: its candidate caption instead paints in-stream as the transcript's tail caption (`data-testid="fresh-agent-tail-caption"`), visible while the line is live and after the session settles. One invariant guards all of this: **a caption's text renders in exactly ONE place per frame** — a multi-line turn ([tool, text, tool]; claude/opencode both interleave) TRANSFERS its caption to the turn's next line at the text boundary instead of stashing it (`transferTurnIndex`), because stashing there plus painting at the new line would duplicate the same turn summary in one frame (fresh-eyes round 3, Finding 1, pinned by the caption-transfer test). Partially-filtered turns (e.g. a claude `[thinking, tool_use]` turn under the default `showThinking=false`, whose echo summary derives from the hidden thinking item) and fully-filtered turns NEITHER paint nor stash their summaries — the user chose to hide that content (LB-1 closes both directions). With the zero-item fold deleted (LB-4, see the validation subsection below), this supersession-stash is the ONLY fold source; zero-item turns render their own article and never fold THEIR OWN caption — a zero-item close still supersedes the line's last member normally (round 2, Finding 3).
4. **E2e lives in the existing `test/e2e-browser/specs/fresh-agent.spec.ts` (default chromium project).** The specs route the snapshot REST response and inject `freshAgent.session.changed` through the test harness — they never need a real Rust server — so no `RUST_ONLY_SPECS`/`testMatch` registration in `test/e2e-browser/playwright.config.ts` is required. `fresh-agent-control-rust.spec.ts` (rust-chromium) runs as impacted surface.
5. **`docs/index.html` and `AGENTS.md` need no change** (Task 6 re-verifies): the docs mock renders a settled activity strip and no streaming echo captions; `AGENTS.md` references none of the deleted machinery. The historical plan `docs/plans/2026-08-23-freshagent-activity-line.md` is not modified.
6. **Codex reasoning fallback keeps its shipped order — `authored` needs no reorder.** `map_codex_item` (`codex.rs:3315-3322`) constructs a reasoning item's `text` as the joined provider `summary` array whenever that array is non-empty (else the joined raw `content`), so the shipped selection order (direct `text` → provider `summary` array → `content`) already returns the provider prose in exactly the authored case. The rule Task 2 implements: `authored` is emitted IFF the returned summary string IS the provider-written reasoning `summary` join; every other selection order stays byte-identical to today's, so tagging changes no visible summary text. Task 2 pins both the construction-shaped case (authored) and a divergent synthetic case (echo).

### Load-bearing validation

Four plan-critical claims were validated against the worktree after this plan's first commit (all high confidence). Evidence stays in the validator reports (in the run's logs dir); only the resolutions are recorded here.

- **LB-1** (`reports/load-bearing-validator-LB-1.md`): the absorb-stash as first planned also fired for partially-filtered turns, leaking hidden thinking/reasoning text into expansions (reachable in BOTH the claude and codex lanes under the default `showThinking=false`). **Resolution:** the fold gate is fully-visible-only on BOTH sides of the fold (tail paint AND expansion stash) — decision 3, Task 3 item 5, Task 4. The validator's server-marked-source alternative was rejected: the `hadFilteredItems` display marker adds no contract surface and revives no classifier.
- **LB-2** (`reports/load-bearing-validator-LB-2.md`): three legacy merge tests (`FreshAgentTranscript.test.tsx:460`, `:577`, `:895`) relied on untagged exact-echo merges but were missing from Task 3's update list — Task 3 Step 4's "Expected: PASS" was unreachable as written. **Resolution:** Task 3 step (f) now covers all three with the prescribed tagging, and the absorb guard is null-safe (`(turn.summary ?? '')`).
- **LB-3** (`reports/load-bearing-validator-LB-3.md`): `fresh-agent-control-rust.spec.ts` is absorb-independent in all four lanes. **No plan change;** Task 5 Step 6 remains as the confirming run.
- **LB-4** (`reports/load-bearing-validator-LB-4.md`): no Rust producer emits a zero-item turn with a non-blank summary (exhaustively verified, including streaming/partial paths), so the planned zero-item `pendingCaptions` fold was synthetic-only. **Resolution:** the machinery is deleted from Task 4; Task 4 pins benign zero-item blank-summary rendering instead; Task 2 pins the claude zero-item drop guard that keeps the non-blank `'[claude turn]'` fallback unreachable, and corrects the stale `build_codex_turn_json` doc comment. LB-1's side finding (codex fallback-order) resolved as decision 6.

Fresh-eyes plan review round 1 returned FAILED with 3 Major + 2 Minor findings (report `reports/usual-fresheyes-20260825T190016Z-268691.md`; dispositions in `plan-review-log.md`). The round-1 correction is recorded here because it re-anchored the fold design on reachable producer shapes: **Finding 1 confirmed that "paint only when a turn has no rendered blocks" made the fold's painted phase unreachable for real data** (zero-item turns never carry non-blank summaries — LB-4 — and item-bearing turns never painted captions, so nothing could ever fold; the superseded-member + tail-paint model in decision 3 is the correction, and LB-4's own verdict is what makes the correction necessary and sufficient). The other round-1 fixes are local: claude `tool_use` names route through the shared 140-char truncation (Task 2), the Task 6 docs-reference scan excludes `docs/plans/**` (historical plans are records, not live docs), Task 5 commits its task before the configured-backend e2e run, and the strip derives its live row from the last NON-caption row.

## File responsibility map

| File | Responsibility | Task |
| --- | --- | --- |
| `shared/fresh-agent-contract.ts` | Turn schema: optional `summaryKind` enum | 1 |
| `shared/fresh-agent-turns.ts` | `turnSummaryIsAuthored` provenance helper | 1 |
| `test/unit/shared/fresh-agent-turns.test.ts` | Schema + helper pins | 1 |
| `test/unit/shared/fresh-agent-contract.test.ts` | Snapshot round-trip carries `summaryKind` | 1 |
| `test/fixtures/fresh-agent/claude/contract-fixtures.ts` | Claude contract turn carries `summaryKind: 'echo'` | 1 |
| `test/fixtures/fresh-agent/codex/contract-fixtures.ts` | Codex contract turn carries `summaryKind: 'echo'` | 1 |
| `crates/freshell-freshagent/src/summary.rs` | NEW: shared dialect policy (truncation, labels, kind constants) | 2 |
| `crates/freshell-freshagent/src/claude_snapshot.rs` | 140-char truncation, shared labels, `summaryKind: "echo"` on every turn | 2 |
| `crates/freshell-freshagent/src/codex.rs` | `summarize_codex_items` returns `(String, kind)`; authored iff codex reasoning `summary[]` | 2 |
| `crates/freshell-freshagent/src/lib.rs` | `mod summary;`; opencode summary tuple + tag | 2 |
| `test/fixtures/fresh-agent/claude-snapshot-golden.json` | Golden snapshot regenerated with `summaryKind` + `Tool result` | 2 |
| `src/components/fresh-agent/FreshAgentTranscript.tsx` | Provenance consumption + gated tail-caption paint (3); superseded-member caption fold into expansions (4) | 3–4 |
| `src/store/freshAgentSlice.ts` | Delete write-only summarizer; `summary: ''` | 3 |
| `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx` | Retagged merge pins (3); rewritten pins + fold-gate/no-leak tests (3–4) | 3–4 |
| `test/unit/client/lib/fresh-agent-ws.test.ts` | `summary: ''` expectation | 3 |
| `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` | `summary: ''` expectation | 3 |
| `test/e2e-browser/specs/fresh-agent.spec.ts` | `foldable echo captions` describe | 5 |
| `docs/index.html` | Re-assessed; no change (recorded) | 6 |
| `AGENTS.md` | Re-checked; no change (recorded) | 6 |

**Interfaces between tasks**

- Task 1 produces `FreshAgentTurn['summaryKind']?: 'echo' | 'authored'` (zod-optional) and `turnSummaryIsAuthored(turn: Pick<FreshAgentTurn, 'summaryKind'>): boolean` (`=== 'echo'` → false; missing/`'authored'` → true).
- Task 2 emits `summaryKind: "echo" | "authored"` on every turn of every Rust snapshot; consumes Task 1's schema (the golden-fixture contract test parses strictly).
- Task 3 consumes Task 1's helper; produces the null-safe provenance absorb guard, the marked `DisplayTurn` + `filterTurnsForDisplay` rules, `appendTurnItems` kind recomputation (`echo` only when both sides are `'echo'`), `LineMember`/`LineCaption` records, the `foldCaption` gate, and the painted `tailCaption` (`data-testid="fresh-agent-tail-caption"`).
- Task 4 consumes Task 3's members/gate; produces `ActivityRow` caption rows, `buildActivity(items, captions)`, the superseded-member stash into expansions, and `data-testid="fresh-agent-activity-caption"`.
- Task 5 consumes Tasks 3-4's UI (both caption testids and the fold transition).

### Task 1: Contract `summaryKind` field + `turnSummaryIsAuthored` helper

**Files:**
- Modify: `shared/fresh-agent-contract.ts:164-175`
- Modify: `shared/fresh-agent-turns.ts`
- Modify: `test/fixtures/fresh-agent/claude/contract-fixtures.ts:3-19`
- Modify: `test/fixtures/fresh-agent/codex/contract-fixtures.ts:3-21`
- Test: `test/unit/shared/fresh-agent-turns.test.ts`
- Test: `test/unit/shared/fresh-agent-contract.test.ts`

**Interfaces:**
- Consumes: existing `FreshAgentTurnSchema` (strict), existing helper module.
- Produces: `FreshAgentTurn['summaryKind']?: 'echo' | 'authored'`; `turnSummaryIsAuthored(turn: Pick<FreshAgentTurn, 'summaryKind'>): boolean`.

- [ ] **Step 1: Write the failing behavioral test**

Append to `test/unit/shared/fresh-agent-turns.test.ts` inside the existing `describe('fresh-agent display turn helpers')`, and extend the import from `../../../shared/fresh-agent-turns.js` with `turnSummaryIsAuthored`:

```ts
  it('accepts an optional summaryKind provenance tag on turn schema', () => {
    const base = { id: '1', turnId: 't-1', summary: 'summary', items: [] }
    expect(FreshAgentTurnSchema.parse({ ...base, summaryKind: 'echo' }).summaryKind).toBe('echo')
    expect(FreshAgentTurnSchema.parse({ ...base, summaryKind: 'authored' }).summaryKind).toBe('authored')
    // Graceful absence: a server that does not emit the field still parses.
    expect(FreshAgentTurnSchema.parse(base).summaryKind).toBeUndefined()
    // The enum is closed and the object stays strict.
    expect(() => FreshAgentTurnSchema.parse({ ...base, summaryKind: 'bogus' })).toThrow()
  })

  it('treats only an explicit echo tag as non-authored (missing is conservative)', () => {
    expect(turnSummaryIsAuthored({ summaryKind: 'echo' })).toBe(false)
    expect(turnSummaryIsAuthored({ summaryKind: 'authored' })).toBe(true)
    expect(turnSummaryIsAuthored({})).toBe(true)
  })
```

Add to `test/unit/shared/fresh-agent-contract.test.ts` at the end of the `it('parses Claude and Codex snapshots through one shared durable contract', ...)` body (after the existing assertions, which bind the parsed claude snapshot as `claudeSnapshot`):

```ts
    expect(claudeSnapshot.turns[0].summaryKind).toBe('echo')
    expect(FreshAgentSnapshotSchema.parse(codexContractSnapshot).turns[0].summaryKind).toBe('echo')
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/shared/fresh-agent-turns.test.ts test/unit/shared/fresh-agent-contract.test.ts`

Expected: FAIL because `FreshAgentTurnSchema` is `.strict()` and rejects the unknown `summaryKind` key, `turnSummaryIsAuthored` does not exist (import/type error), and the contract fixtures carry no `summaryKind` — not because of a syntax or setup accident.

- [ ] **Step 3: Add the minimal production implementation**

In `shared/fresh-agent-contract.ts`, add one field to `FreshAgentTurnSchema` after `summary: z.string(),` (line 173):

```ts
  summary: z.string(),
  // Provenance of `summary`: 'echo' = mechanical projection of the turn's own
  // items (foldable caption); 'authored' = provider-written prose (permanent
  // boundary). Optional: a server that predates the field omits it and the
  // client treats unknown provenance as authored (conservative).
  summaryKind: z.enum(['echo', 'authored']).optional(),
```

In `shared/fresh-agent-turns.ts`, append:

```ts
/**
 * A turn summary is "authored" — provider-written prose that must remain a
 * permanent transcript boundary — unless the server explicitly tagged it as an
 * 'echo' of the turn's own items. A missing tag is conservative (authored):
 * no absorb, no folding.
 */
export function turnSummaryIsAuthored(turn: Pick<FreshAgentTurn, 'summaryKind'>): boolean {
  return turn.summaryKind !== 'echo'
}
```

In `test/fixtures/fresh-agent/claude/contract-fixtures.ts`, add `summaryKind: 'echo',` after `summary: 'Workspace is clean.',` (line 12). In `test/fixtures/fresh-agent/codex/contract-fixtures.ts`, add `summaryKind: 'echo',` after `summary: 'Codex finished a review pass',` (line 10). (Both fixtures model mechanical projections: claude summarizes from the first text item; codex from the first item's kind-specific text.)

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/shared/fresh-agent-turns.test.ts test/unit/shared/fresh-agent-contract.test.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

No refactor needed: one schema field, one two-line helper, two fixture keys. The helper is deliberately placed beside `getFreshAgentDisplayTurnKey` so all turn-display semantics live in one shared module.

- [ ] **Step 6: Run impacted-test verification**

The schema is shared by every fresh-agent surface; the fixtures feed the contract test, `test/fixtures/fresh-agent/contract-traceability.ts`, and the fetch-mock tests in `test/unit/client/lib/api.test.ts` (the additive optional key must not break them). Impacted set: all shared-contract consumers plus the strict-schema Rust golden-fixture contract test, plus typecheck (the new optional field must not break existing turn construction).

Run (the repo coordinator silently drops `test/unit/server/**` from the default-config run — the contract test runs as a second, explicit server-config invocation; observed during Task 1 execution): `npm run test:vitest -- run test/unit/shared/ test/unit/client/lib/api.test.ts && npm run test:vitest -- run test/unit/server/rust-claude-snapshot-contract.test.ts && npm run typecheck`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add shared/fresh-agent-contract.ts shared/fresh-agent-turns.ts test/unit/shared/fresh-agent-turns.test.ts test/unit/shared/fresh-agent-contract.test.ts test/fixtures/fresh-agent/claude/contract-fixtures.ts test/fixtures/fresh-agent/codex/contract-fixtures.ts
git commit -m "feat(freshagent): add optional summaryKind provenance to turn contract"
```

### Task 2: Rust provenance tagging + summary dialect unification

**Files:**
- Create: `crates/freshell-freshagent/src/summary.rs`
- Modify: `crates/freshell-freshagent/src/lib.rs` (mod decl between `spawn_gate` and `target_resolver`, ~line 52; `opencode_turn_summary` :1395-1439; `build_opencode_turn_json` :1491)
- Modify: `crates/freshell-freshagent/src/claude_snapshot.rs` (`summarize` :515-550; turn insert :495)
- Modify: `crates/freshell-freshagent/src/codex.rs` (`summarize_codex_items` :3485-3567; turn json :3793-3801)
- Modify: `test/fixtures/fresh-agent/claude-snapshot-golden.json`
- Test: in-module `#[cfg(test)]` suites of the three modified Rust files

**Interfaces:**
- Consumes: Task 1's `summaryKind` schema field (the strict-schema contract test parses the golden fixture).
- Produces: every Rust-emitted turn carries `summaryKind: "echo" | "authored"`; the shared policy constants `SUMMARY_MAX_CHARS` (140), `TOOL_RESULT_LABEL` (`"Tool result"`), `TOOL_ERROR_LABEL` (`"Tool error"`), `SUMMARY_KIND_ECHO`, `SUMMARY_KIND_AUTHORED`, and `truncate_summary`.

- [ ] **Step 1: Write the failing behavioral test**

Add to the `#[cfg(test)]` module of `crates/freshell-freshagent/src/claude_snapshot.rs`:

```rust
#[test]
fn claude_turns_tag_every_summary_echo() {
    let built = build_claude_snapshot_json("freshclaude", "t", SAMPLE_TRANSCRIPT, 0);
    let turns = built["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 6);
    for turn in turns {
        assert_eq!(turn["summaryKind"], json!("echo"), "turn {:?}", turn["turnId"]);
    }
}

#[test]
fn summarize_unifies_truncation_and_tool_result_labels() {
    let long_text = "x".repeat(200);
    let items = vec![json!({ "kind": "text", "text": long_text })];
    assert_eq!(summarize(&items).chars().count(), 140);

    let ok = vec![json!({ "kind": "tool_result", "content": "out", "isError": false })];
    assert_eq!(summarize(&ok), "Tool result");
    let err = vec![json!({ "kind": "tool_result", "content": "boom", "isError": true })];
    assert_eq!(summarize(&err), "Tool error");

    // Tool names count as summaries: a >140-char tool_use name truncates
    // through the same shared policy (fresh-eyes round 1, Finding 2 — this is
    // the arm a `return name.to_string()` would bypass).
    let long_name = "mcp__server__".to_string() + &"n".repeat(200);
    let tools = vec![json!({ "kind": "tool_use", "name": long_name.clone() })];
    let expected: String = long_name.chars().take(140).collect();
    assert_eq!(summarize(&tools), expected);
}

#[test]
fn claude_zero_item_messages_are_dropped_before_summarizing() {
    // Preservation pin (passes immediately — it guards an EXISTING invariant,
    // see Step 2): `summarize`'s final fallback is the non-blank literal
    // "[claude turn]", so the `if items.is_empty() { continue; }` guard ahead
    // of it is the only thing keeping zero-item non-blank-summary turns
    // unreachable (load-bearing validation LB-4). A message whose blocks are
    // all unrecognized yields no items and must emit NO turn at all.
    let transcript: &str = concat!(
        r#"{"type":"assistant","message":{"content":[{"type":"future_block","data":"x"}]}}"#,
        "\n",
        r#"{"type":"assistant","message":{"id":"msg_ok","content":[{"type":"text","text":"real answer"}]}}"#,
        "\n",
    );
    let built = build_claude_snapshot_json("freshclaude", "t", transcript, 0);
    let turns = built["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0]["summary"], json!("real answer"));
    assert!(turns
        .iter()
        .all(|turn| !turn["items"].as_array().unwrap().is_empty()));
}
```

Add to `crates/freshell-freshagent/src/codex.rs` tests (its `tests` module gains `use crate::summary::{SUMMARY_KIND_AUTHORED, SUMMARY_KIND_ECHO};`; update the existing `summarize_codex_items_uses_first_items_kind_specific_text_not_a_join` at :9837 to the tuple shape):

```rust
#[test]
fn summarize_codex_items_uses_first_items_kind_specific_text_not_a_join() {
    let items = vec![
        json!({ "id": "a", "kind": "reasoning", "summary": ["thinking hard"], "content": [], "text": "thinking hard" }),
        json!({ "id": "b", "kind": "command", "command": "ls", "status": "completed", "output": null, "exitCode": null, "extensions": {} }),
    ];
    // A reasoning item carrying a provider summary array is the only authored
    // case; `text` is CONSTRUCTED as the joined provider summary by
    // `map_codex_item`, so the authored value is exactly today's value.
    assert_eq!(
        summarize_codex_items(&items),
        ("thinking hard".to_string(), SUMMARY_KIND_AUTHORED)
    );
}

#[test]
fn summarize_codex_items_keeps_the_shipped_reasoning_fallback_order() {
    // Planning decision 6: the reasoning fallback order is UNCHANGED (direct
    // `text` -> provider `summary` array -> `content`); the reorder first
    // drafted here was reverted by load-bearing validation (LB-1 side
    // finding). Authored iff the RETURNED STRING is the provider summary
    // join. Construction-shaped items (`text` == the join, as `map_codex_item`
    // builds them) tag authored with an unchanged value:
    let construction_shaped = vec![json!({
        "id": "a", "kind": "reasoning",
        "summary": ["provider prose"], "content": ["raw chain"], "text": "provider prose",
    })];
    assert_eq!(
        summarize_codex_items(&construction_shaped),
        ("provider prose".to_string(), SUMMARY_KIND_AUTHORED)
    );

    // Direct text empty: the provider summary array supplies the value, so
    // the string IS provider prose -> authored (authored stays reachable
    // under the untouched order).
    let no_direct_text = vec![json!({
        "id": "b", "kind": "reasoning",
        "summary": ["provider prose"], "content": ["raw chain"], "text": "",
    })];
    assert_eq!(
        summarize_codex_items(&no_direct_text),
        ("provider prose".to_string(), SUMMARY_KIND_AUTHORED)
    );

    // A synthetic item whose direct text diverges from the provider summary
    // keeps today's value (the direct text) and tags echo — the value was not
    // taken from the provider array.
    let divergent = vec![json!({
        "id": "c", "kind": "reasoning",
        "summary": ["provider prose"], "content": [], "text": "direct text",
    })];
    assert_eq!(
        summarize_codex_items(&divergent),
        ("direct text".to_string(), SUMMARY_KIND_ECHO)
    );
}

#[test]
fn summarize_codex_items_tags_reasoning_without_a_provider_summary_echo() {
    let items = vec![
        json!({ "id": "a", "kind": "reasoning", "summary": [], "content": ["raw chain"], "text": "raw chain" }),
    ];
    assert_eq!(
        summarize_codex_items(&items),
        ("raw chain".to_string(), SUMMARY_KIND_ECHO)
    );
}

#[test]
fn summarize_codex_items_tags_tool_previews_echo() {
    let items = vec![
        json!({ "id": "c", "kind": "command", "command": "cat a.txt", "status": "completed", "output": null, "exitCode": null, "extensions": {} }),
    ];
    assert_eq!(
        summarize_codex_items(&items),
        ("cat a.txt".to_string(), SUMMARY_KIND_ECHO)
    );
}
```

Also add to the existing `get_snapshot_renders_tool_reasoning_and_file_change_items_end_to_end` (:9846), after the summary assertion at :9911:

```rust
        assert_eq!(turns[0]["summaryKind"], json!("authored"));
        assert_eq!(turns[1]["summaryKind"], json!("echo"));
```

and to `get_snapshot_returns_a_schema_shaped_snapshot_with_turn_text` (:9389), next to its turn assertions:

```rust
        assert_eq!(snapshot["turns"][0]["summaryKind"], json!("echo"));
```

Add to `crates/freshell-freshagent/src/lib.rs` tests:

```rust
#[test]
fn opencode_turn_summary_truncates_the_text_join_and_tags_echo() {
    let long = "y".repeat(200);
    let items = vec![
        json!({ "id": "p-0", "kind": "text", "text": long }),
    ];
    let (summary, kind) = opencode_turn_summary(&items);
    assert_eq!(summary.chars().count(), 140);
    assert_eq!(kind, SUMMARY_KIND_ECHO);

    // The reasoning fallback is the adapter's own projection of full reasoning
    // text — echo, NOT authored (see the plan's deviation note).
    let reasoning_only = vec![
        json!({ "id": "p-1", "kind": "reasoning", "summary": ["full reasoning text"], "content": [], "text": "full reasoning text" }),
    ];
    assert_eq!(
        opencode_turn_summary(&reasoning_only),
        ("full reasoning text".to_string(), SUMMARY_KIND_ECHO)
    );
}
```

Also add `assert_eq!(turns[1]["summaryKind"], json!("echo"));` beside the summary assertion at lib.rs:3355, and `assert_eq!(turn["summaryKind"], json!("echo"));` beside :3846.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent`

Expected: FAIL because no turn carries a `summaryKind` key, `summarize` still caps at 120 and emits the `'[tool result]'` dialect, and `summarize_codex_items`/`opencode_turn_summary` return `String` rather than the `(String, &'static str)` tuple (a compile error in the new tests counts as the intended red: the missing behavior is the tuple+tag). One exception by design: `claude_zero_item_messages_are_dropped_before_summarizing` is a PRESERVATION pin — the `if items.is_empty() { continue; }` guard exists today, so that test is green even at red time (its red would come from someone deleting the guard while touching the fallback chain). Not a syntax/setup accident.

- [ ] **Step 3: Add the minimal production implementation**

Create `crates/freshell-freshagent/src/summary.rs`:

```rust
//! Shared fresh-agent turn-summary dialect policy. Every provider adapter's
//! snapshot builder produces a per-turn `summary` plus a `summaryKind`
//! provenance tag:
//!
//! - [`SUMMARY_KIND_ECHO`] — the summary is a mechanical projection of the
//!   turn's own items (a tool name, a command line, a text excerpt, a
//!   tool-result label). It carries no content beyond what the items render,
//!   so the client may treat it as a foldable caption.
//! - [`SUMMARY_KIND_AUTHORED`] — provider-written summary prose with no item
//!   counterpart (today: ONLY codex `reasoning` items with a non-empty
//!   provider `summary` array). The client treats it as a permanent
//!   transcript boundary and never folds it.
//!
//! One truncation policy (140 chars) and one tool-result label set apply to
//! every producer. 140 matches the reference TS codex normalizer's
//! `.slice(0, 140)`; char-based (not UTF-16 code-unit) is the documented,
//! acceptable divergence for non-BMP text.

/// Character cap for every fresh-agent turn summary, all providers.
pub(crate) const SUMMARY_MAX_CHARS: usize = 140;

/// Char-safe truncation to [`SUMMARY_MAX_CHARS`].
pub(crate) fn truncate_summary(text: &str) -> String {
    text.chars().take(SUMMARY_MAX_CHARS).collect()
}

/// The single tool-result summary label (unifies codex's `"Tool result"` and
/// claude's `"[tool result]"` dialects).
pub(crate) const TOOL_RESULT_LABEL: &str = "Tool result";

/// Error variant of [`TOOL_RESULT_LABEL`].
pub(crate) const TOOL_ERROR_LABEL: &str = "Tool error";

/// `summaryKind` value for mechanical projections of the turn's own items.
pub(crate) const SUMMARY_KIND_ECHO: &str = "echo";

/// `summaryKind` value for provider-written summary prose.
pub(crate) const SUMMARY_KIND_AUTHORED: &str = "authored";
```

In `crates/freshell-freshagent/src/lib.rs`, declare the module between `pub mod spawn_gate;` (:52) and `pub mod target_resolver;` (:53):

```rust
pub mod spawn_gate;
pub(crate) mod summary;
pub mod target_resolver;
```

and add `use crate::summary::{truncate_summary, SUMMARY_KIND_ECHO};` to lib.rs's own `use` block (the opencode functions reference both).

In `crates/freshell-freshagent/src/claude_snapshot.rs`: import the policy (`use crate::summary::{truncate_summary, SUMMARY_KIND_ECHO, TOOL_ERROR_LABEL, TOOL_RESULT_LABEL};` with the existing crate imports), replace `summarize` (:515-550) with:

```rust
/// Turn summary: first non-empty `text` item's text, falling back to the first
/// non-empty `thinking` item's text (char-safe truncate to the shared
/// [`SUMMARY_MAX_CHARS`] policy), else a tool label -- `FreshAgentTurnSchema.summary`
/// is REQUIRED. Text is preferred over thinking so an assistant turn's summary
/// is its visible answer, not its reasoning preamble (golden fixture turn 1:
/// items `[thinking "pondering", text "first answer"]` must summarize to
/// `"first answer"`). Every claude summary is a mechanical projection of the
/// turn's own items, so every claude turn tags `summaryKind: "echo"`.
fn summarize(items: &[Value]) -> String {
    let first_text_of = |kind: &str| -> Option<String> {
        items.iter().find_map(|item| {
            if item.get("kind").and_then(Value::as_str) != Some(kind) {
                return None;
            }
            let trimmed = item.get("text").and_then(Value::as_str)?.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(truncate_summary(trimmed))
            }
        })
    };
    if let Some(summary) = first_text_of("text").or_else(|| first_text_of("thinking")) {
        return summary;
    }
    for item in items {
        match item.get("kind").and_then(Value::as_str) {
            Some("tool_use") => {
                if let Some(name) = item.get("name").and_then(Value::as_str) {
                    // Tool names count as summaries too: the shared 140-char
                    // policy MUST apply here (one Rust-side truncation policy
                    // for every summary arm — fresh-eyes round 1, Finding 2).
                    return truncate_summary(name);
                }
            }
            Some("tool_result") => {
                let is_error = item
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                return if is_error { TOOL_ERROR_LABEL } else { TOOL_RESULT_LABEL }.to_string();
            }
            _ => {}
        }
    }
    "[claude turn]".to_string()
}
```

and tag the turn at the insert site (:495):

```rust
        turn.insert("summary".into(), json!(summary));
        turn.insert("summaryKind".into(), json!(SUMMARY_KIND_ECHO));
        turn.insert("items".into(), json!(items));
```

**Preserve the zero-item drop guard.** The `if items.is_empty() { continue; }` at :467-469 runs BEFORE `summarize` and MUST stay: the new `summarize` still ends in the non-blank `"[claude turn]"` fallback, so without the guard claude would start emitting zero-item turns with non-blank echo summaries — a shape load-bearing validation (LB-4) proved never occurs today and Task 4's client design relies on never occurring. The Step-1 preservation pin covers it.

In `crates/freshell-freshagent/src/codex.rs`: import the policy, then replace `summarize_codex_items` (:3485-3567) with the tuple-returning version — every arm identical except `truncate140` → `truncate_summary`, the reasoning arm KEEPS ITS SHIPPED selection order and gains the authored check (planning decision 6), and returns gain the kind:

```rust
/// `summarizeFreshAgentItems(items)` (`normalize.ts:168-207`): the turn's `summary` string is
/// the FIRST item's kind-specific preview text (NOT a concatenation of every item) -- e.g. a
/// turn with a `reasoning` item followed by a `command` item summarizes from the reasoning
/// alone. Truncation is the shared 140-char policy (`crate::summary`).
///
/// Provenance: the summary is AUTHORED only when it comes from a `reasoning`
/// item's provider-written `summary` array (codex is the one provider that
/// ships provider-written summary prose). Everything else — including a
/// reasoning item reduced to its raw `content` text — is a mechanical
/// projection and tags ECHO. The value SELECTION ORDER is the shipped one
/// (direct `text` → provider `summary` → `content`), deliberately NOT
/// reordered: `map_codex_item` (:3315-3322) constructs a reasoning item's
/// `text` as the joined provider summary exactly when one exists, so authored
/// is reachable with no visible-text change (planning decision 6).
fn summarize_codex_items(items: &[Value]) -> (String, &'static str) {
    for item in items {
        let kind = item.get("kind").and_then(Value::as_str).unwrap_or("");
        let text = match kind {
            "text" | "thinking" => item.get("text").and_then(Value::as_str).map(truncate_summary),
            "reasoning" => {
                // Shipped order: direct `text` first, then the provider
                // `summary` array, then raw `content`.
                let provider_summary = item
                    .get("summary")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .filter(|joined| !joined.is_empty());
                let direct = item
                    .get("text")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                let text = direct.map(str::to_string).unwrap_or_else(|| {
                    provider_summary.clone().unwrap_or_else(|| {
                        item.get("content")
                            .and_then(Value::as_array)
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(Value::as_str)
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            })
                            .unwrap_or_default()
                    })
                });
                // Authored iff the RETURNED string is the provider summary
                // join. For `map_codex_item`-built items that holds exactly
                // when a provider summary exists; a synthetic item whose
                // direct text diverges stays echo (the value came from text).
                let summary_kind = match &provider_summary {
                    Some(joined) if *joined == text => SUMMARY_KIND_AUTHORED,
                    _ => SUMMARY_KIND_ECHO,
                };
                return (truncate_summary(&text), summary_kind);
            }
            "command" => item.get("command").and_then(Value::as_str).map(truncate_summary),
            "file_change" => Some("File change".to_string()),
            "mcp_tool" => {
                let server = item.get("server").and_then(Value::as_str).unwrap_or("");
                let tool = item.get("tool").and_then(Value::as_str).unwrap_or("");
                Some(truncate_summary(&format!("{server}:{tool}")))
            }
            "dynamic_tool" | "collab_agent" => {
                item.get("tool").and_then(Value::as_str).map(truncate_summary)
            }
            "web_search" => item.get("query").and_then(Value::as_str).map(truncate_summary),
            "image_view" => item.get("path").and_then(Value::as_str).map(truncate_summary),
            "image_generation" => item.get("result").and_then(Value::as_str).map(truncate_summary),
            "review_mode" => {
                let event = item.get("event").and_then(Value::as_str).unwrap_or("");
                Some(truncate_summary(&format!("{event} review mode")))
            }
            "context_compaction" => Some("Context compacted".to_string()),
            "tool_use" => item.get("name").and_then(Value::as_str).map(truncate_summary),
            "tool_result" => {
                let is_error = item
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                Some(if is_error {
                    TOOL_ERROR_LABEL.to_string()
                } else {
                    TOOL_RESULT_LABEL.to_string()
                })
            }
            _ => None,
        };
        if let Some(text) = text {
            return (text, SUMMARY_KIND_ECHO);
        }
    }
    (String::new(), SUMMARY_KIND_ECHO)
}
```

and the turn builder (:3793-3801):

```rust
            let (summary, summary_kind) = summarize_codex_items(&row.items);
            json!({
                "id": row_turn_id,
                "turnId": row_turn_id,
                "ordinal": ordinal,
                "source": "durable",
                "role": row.role,
                "summary": summary,
                "summaryKind": summary_kind,
                "items": row.items,
            })
```

Also correct two stale doc comments (neither matches the code; found by load-bearing validation LB-4). In `build_codex_turn_json`'s comment (:3682-3685), replace the false skipping claim:

> DELIBERATE DEVIATION: an unrecognized item type no longer fails the turn -- per [`map_codex_item`]'s doc comment, it maps to an empty item list, **and this loop skips it entirely (no role/row bookkeeping touched) so it can never manufacture a spurious empty display row**. Every other item in the turn still renders normally.

with the true behavior:

> DELIBERATE DEVIATION: an unrecognized item type no longer fails the turn -- per [`map_codex_item`]'s doc comment, it maps to an empty item list. The loop does NOT skip it: its role is still classified (the catch-all arm of [`classify_codex_item_role`] yields `assistant`) and folded into `has_assistant_output`/`has_user_output`/`all_items_are_user`, and when that role differs from the previous row's a new row is pushed whose `items` is the empty list -- a ZERO-ITEM display row with a BLANK summary (`summarize_codex_items(&[])` returns `""`). When the role matches the previous row, `row.items.extend(mapped)` extends by nothing and no empty row appears. Every other item in the turn still renders normally.

and in [`classify_codex_item_role`]'s comment (:3443-3447) drop the twin false claim that the caller only reaches it for non-empty mappings (the catch-all IS reachable for unrecognized types and decides whether the zero-item row appears); state instead that the caller classifies every raw item including unrecognized ones.

In `crates/freshell-freshagent/src/lib.rs`, change `opencode_turn_summary` (:1395-1439) to return `(String, &'static str)`. Keep the `text_items` collection (:1396-1404) and the source-id grouping loop (:1405-1429) byte-for-byte; only the two return sites change — the text-join return becomes `return (truncate_summary(&groups.join("\n\n")), SUMMARY_KIND_ECHO);` and the reasoning fallback becomes:

```rust
    let reasoning_excerpt = items
        .iter()
        .find(|item| item.get("kind").and_then(Value::as_str) == Some("reasoning"))
        .and_then(|item| item.get("summary").and_then(Value::as_array))
        .and_then(|arr| arr.first())
        .and_then(Value::as_str)
        .unwrap_or("");
    (truncate_summary(reasoning_excerpt), SUMMARY_KIND_ECHO)
}
```

Tag the turn in `build_opencode_turn_json` (:1491):

```rust
    let (summary, summary_kind) = opencode_turn_summary(&items);
    turn.insert("summary".to_string(), json!(summary));
    turn.insert("summaryKind".to_string(), json!(summary_kind));
    turn.insert("items".to_string(), json!(items));
```

Finally regenerate `test/fixtures/fresh-agent/claude-snapshot-golden.json` to the new builder output — every turn gains `"summaryKind": "echo"` and turn 5's summary becomes the unified label (complete file):

```json
{
  "sessionType": "freshclaude",
  "provider": "claude",
  "threadId": "44444444-4444-4444-8444-444444444444",
  "sessionId": "44444444-4444-4444-8444-444444444444",
  "revision": 1753437600000,
  "latestTurnId": "44444444-4444-4444-8444-444444444444:5",
  "status": "idle",
  "capabilities": { "send": true, "interrupt": true, "approvals": false, "questions": false, "fork": false },
  "tokenUsage": { "inputTokens": 0, "outputTokens": 0, "totalTokens": 0 },
  "pendingApprovals": [],
  "pendingQuestions": [],
  "worktrees": [],
  "diffs": [],
  "childThreads": [],
  "turns": [
    {
      "id": "44444444-4444-4444-8444-444444444444:0",
      "turnId": "44444444-4444-4444-8444-444444444444:0",
      "ordinal": 0,
      "source": "durable",
      "role": "user",
      "timestamp": "2026-07-25T10:00:00.000Z",
      "summary": "first question",
      "summaryKind": "echo",
      "items": [
        { "id": "44444444-4444-4444-8444-444444444444:0-i0", "kind": "text", "text": "first question" }
      ]
    },
    {
      "id": "44444444-4444-4444-8444-444444444444:1",
      "turnId": "44444444-4444-4444-8444-444444444444:1",
      "messageId": "msg_01",
      "ordinal": 1,
      "source": "durable",
      "role": "assistant",
      "timestamp": "2026-07-25T10:00:01.000Z",
      "model": "claude-opus-4-6",
      "summary": "first answer",
      "summaryKind": "echo",
      "items": [
        { "id": "44444444-4444-4444-8444-444444444444:1-i0", "kind": "thinking", "text": "pondering" },
        { "id": "44444444-4444-4444-8444-444444444444:1-i1", "kind": "text", "text": "first answer" }
      ]
    },
    {
      "id": "44444444-4444-4444-8444-444444444444:2",
      "turnId": "44444444-4444-4444-8444-444444444444:2",
      "ordinal": 2,
      "source": "durable",
      "role": "user",
      "timestamp": "2026-07-25T10:00:02.000Z",
      "summary": "plain string question",
      "summaryKind": "echo",
      "items": [
        { "id": "44444444-4444-4444-8444-444444444444:2-i0", "kind": "text", "text": "plain string question" }
      ]
    },
    {
      "id": "44444444-4444-4444-8444-444444444444:3",
      "turnId": "44444444-4444-4444-8444-444444444444:3",
      "ordinal": 3,
      "source": "durable",
      "role": "user",
      "timestamp": "2026-07-25T10:00:02.500Z",
      "summary": "cli string content question",
      "summaryKind": "echo",
      "items": [
        { "id": "44444444-4444-4444-8444-444444444444:3-i0", "kind": "text", "text": "cli string content question" }
      ]
    },
    {
      "id": "44444444-4444-4444-8444-444444444444:4",
      "turnId": "44444444-4444-4444-8444-444444444444:4",
      "ordinal": 4,
      "source": "durable",
      "role": "assistant",
      "timestamp": "2026-07-25T10:00:03.000Z",
      "summary": "bash",
      "summaryKind": "echo",
      "items": [
        { "id": "44444444-4444-4444-8444-444444444444:4-i0", "kind": "tool_use", "toolUseId": "toolu_01", "name": "bash", "input": { "command": "ls" } }
      ]
    },
    {
      "id": "44444444-4444-4444-8444-444444444444:5",
      "turnId": "44444444-4444-4444-8444-444444444444:5",
      "ordinal": 5,
      "source": "durable",
      "role": "user",
      "timestamp": "2026-07-25T10:00:04.000Z",
      "summary": "Tool result",
      "summaryKind": "echo",
      "items": [
        { "id": "44444444-4444-4444-8444-444444444444:5-i0", "kind": "tool_result", "toolUseId": "toolu_01", "content": "file-a\nfile-b", "isError": false }
      ]
    }
  ],
  "extensions": {}
}
```

(Note the sequencing truthfully in the commit: the golden-fixture test goes red the moment the builder tags turns, and returns to green when the fixture lands — both inside this task.)

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Delete the now-dead inner `truncate140` helper in `codex.rs` (fully replaced by `truncate_summary`); verify `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` are clean (unused-import and dead-code lints included).

- [ ] **Step 6: Run impacted-test verification**

The turn JSON shape is a shared contract crossing into the freshell-server routes and the TS strict-schema test. Impacted set: the whole Rust workspace suite (the contract type is workspace-shared) plus the TS contract tests that parse the golden fixture and the shared schema.

Run (two invocations — same routing caveat as Task 1 Step 6): `cargo test --workspace --exclude freshell-tauri && npm run test:vitest -- run test/unit/shared/ && npm run test:vitest -- run test/unit/server/rust-claude-snapshot-contract.test.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/summary.rs crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/src/claude_snapshot.rs crates/freshell-freshagent/src/codex.rs test/fixtures/fresh-agent/claude-snapshot-golden.json
git commit -m "feat(freshagent): tag rust snapshot summaries with echo/authored provenance, unify dialect"
```

### Task 3: Client consumes provenance; classifier, painted store, and write-only summarizer deleted

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx` (delete :223-311 classifier block, :456-465 `DisplayTurn`, :467-501 painted store, :903-906 ref, :923-935 recording effect, :1067-1069 placeholder branch; rewrite `filterTurnsForDisplay` :503-525 with the new `DisplayTurn` marker, `appendTurnItems` :412-421, absorb guard :343-359; `buildTranscriptLayout` drops the painted param and gains member tracking + `tailCaption`; render the tail caption after the last article)
- Modify: `src/store/freshAgentSlice.ts` (delete `summarizeFreshAgentItems` :130-143; `summary: summarizeFreshAgentItems(items)` → `summary: ''` at :595)
- Test: `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`
- Test: `test/unit/client/lib/fresh-agent-ws.test.ts:462-466`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx:1215-1219`

**Interfaces:**
- Consumes: `turnSummaryIsAuthored` and `FreshAgentTurn['summaryKind']` (Task 1).
- Produces: `type DisplayTurn = FreshAgentTurn & { hadFilteredItems?: boolean }` stamped by `filterTurnsForDisplay` on every removal path; the null-safe absorb guard (`absorb iff open.originIndex === turnIndex || (turn.summary ?? '').trim() === '' || !turnSummaryIsAuthored(turn)`); `appendTurnItems` kind recomputation; per-line member records and the gated `tailCaption` the component paints in-stream (`data-testid="fresh-agent-tail-caption"`). Task 4 builds the superseded-member stash + expansion caption rows on these.

- [ ] **Step 1: Write the failing behavioral test**

In `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`:

(a) NEW test, anywhere in `describe('activity line collapse')`:

```tsx
    it('treats an explicit authored summary as a boundary even when its text echoes an item', () => {
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[
            { id: 'turn-a', turnId: 'turn-a', role: 'assistant', summary: '',
              items: [{ id: 'tool-c1', kind: 'tool_use', toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } }] },
            { id: 'turn-c', turnId: 'turn-c', role: 'assistant', summary: 'Read', summaryKind: 'authored',
              items: [{ id: 'tool-c2', kind: 'tool_use', toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }] },
          ]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
    })
```

(b) NEW coalescing-provenance tests (they REPLACE the classifier-era `'merges a follower whose coalesced summary carries the Rust claude [tool result] label'` at :1802 — delete that test):

```tsx
    it('keeps a coalesced synthetic tool-result turn echo when both sides are echo', () => {
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[
            toolTurn('turn-x', [['c1', 'src/a.ts']]),
            { id: 'turn-b', turnId: 'turn-b', role: 'assistant', summary: 'Read', summaryKind: 'echo',
              items: [{ id: 'tool-c2', kind: 'tool_use', toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }] },
            { id: 'turn-r', turnId: 'turn-r', role: 'user', summary: 'Tool result', summaryKind: 'echo',
              items: [{ id: 'result-c2', kind: 'tool_result', toolUseId: 'c2', content: 'file body', isError: false }] },
          ]}
        />,
      )
      // turn-r coalesces into turn-b (echo + echo stays echo), which absorbs
      // into turn-x's line.
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
      expect(screen.getByRole('region', { name: 'Activity strip' })).toHaveTextContent('2 tools used')
    })

    it('tags a coalesced synthetic tool-result turn authored when either side is authored', () => {
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[
            toolTurn('turn-x', [['c1', 'src/a.ts']]),
            { id: 'turn-b', turnId: 'turn-b', role: 'assistant', summary: 'Read', summaryKind: 'echo',
              items: [{ id: 'tool-c2', kind: 'tool_use', toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }] },
            { id: 'turn-r', turnId: 'turn-r', role: 'user', summary: 'Tool result', summaryKind: 'authored',
              items: [{ id: 'result-c2', kind: 'tool_result', toolUseId: 'c2', content: 'file body', isError: false }] },
          ]}
        />,
      )
      // echo + authored -> authored: the coalesced turn is a boundary and
      // keeps its own line.
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
    })
```

(c) REWRITE `'pins the hidden-thinking cadence: ...'` (:1859) — the fold model drops the superseded echo caption instead of leaving an invisible permanent boundary:

```tsx
    it('drops a superseded hidden-thinking echo caption instead of holding a permanent boundary', () => {
      const turnA = {
        id: 'turn-a', turnId: 'turn-a', role: 'assistant' as const, summary: '',
        items: [{ id: 'tool-c1', kind: 'tool_use' as const, toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } }],
      }
      const thinkingTurn = {
        id: 'turn-thinking', turnId: 'turn-thinking', role: 'assistant' as const,
        summary: 'Considering options', summaryKind: 'echo' as const,
        items: [{ id: 'think-1', kind: 'thinking' as const, text: 'Considering options' }],
      }
      // Frame 1 (showThinking=false, the production default): the thinking-only
      // streaming tail is fully filtered — it MUST NOT paint its echo caption:
      // the summary derives from a hidden item, and the paint gate matches the
      // stash gate (LB-1 closes both directions).
      const { rerender } = render(
        <FreshAgentTranscript isStreaming showThinking={false} turns={[turnA, thinkingTurn]} />,
      )
      expect(screen.queryByText('Considering options')).not.toBeInTheDocument()

      // Frame 2: the next tool arrives in a NEW turn. The echo caption is
      // superseded: it disappears from the stream and the tool runs merge —
      // no permanent boundary, and the hidden thinking text is NOT stashed
      // into the expansion (the user chose to hide it).
      const turnB = {
        id: 'turn-b', turnId: 'turn-b', role: 'assistant' as const, summary: 'Read', summaryKind: 'echo' as const,
        items: [{ id: 'tool-c2', kind: 'tool_use' as const, toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }],
      }
      rerender(<FreshAgentTranscript isStreaming showThinking={false} turns={[turnA, thinkingTurn, turnB]} />)
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
      expect(screen.queryByText('Considering options')).not.toBeInTheDocument()
    })
```

(d) REWRITE `'keeps the hidden-thinking boundary after the session goes idle'` (:1888) — same scenario as (c), then a third frame with `isStreaming={false}` (same turns) STILL expects one strip and no caption:

```tsx
    it('keeps the fold after the session goes idle (isStreaming flips false)', () => {
      const turnA = {
        id: 'turn-a', turnId: 'turn-a', role: 'assistant' as const, summary: '',
        items: [{ id: 'tool-c1', kind: 'tool_use' as const, toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } }],
      }
      const thinkingTurn = {
        id: 'turn-thinking', turnId: 'turn-thinking', role: 'assistant' as const,
        summary: 'Considering options', summaryKind: 'echo' as const,
        items: [{ id: 'think-1', kind: 'thinking' as const, text: 'Considering options' }],
      }
      const turnB = {
        id: 'turn-b', turnId: 'turn-b', role: 'assistant' as const, summary: 'Read', summaryKind: 'echo' as const,
        items: [{ id: 'tool-c2', kind: 'tool_use' as const, toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }],
      }
      const { rerender } = render(
        <FreshAgentTranscript isStreaming showThinking={false} turns={[turnA, thinkingTurn]} />,
      )
      // The fully-filtered thinking-only tail never paints its hidden-derived
      // caption (task (c)); the placeholder article renders nothing.
      expect(screen.queryByText('Considering options')).not.toBeInTheDocument()
      rerender(<FreshAgentTranscript isStreaming showThinking={false} turns={[turnA, thinkingTurn, turnB]} />)
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
      expect(screen.queryByText('Considering options')).not.toBeInTheDocument()
      // The session completes (FreshAgentView passes isStreaming=isBusy). The
      // fold is a layout function of the turn list, not of paint history, so
      // the idle flip changes nothing.
      rerender(<FreshAgentTranscript isStreaming={false} showThinking={false} turns={[turnA, thinkingTurn, turnB]} />)
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
      expect(screen.queryByText('Considering options')).not.toBeInTheDocument()
    })
```

(e) REWRITE `'keeps a painted summary boundary when the same turn later gains items that echo it'` (:1979) — provenance replaces paint history; Task 4 extends this test with expansion-stash assertions. The painting mechanism is the TAIL CAPTION: an item-bearing turn's gated echo caption paints in-stream while its line is the transcript tail. No zero-item phase is involved (LB-4 proved that shape unreachable — fresh-eyes round 1, Finding 1):

```tsx
    it('paints an echo caption at the transcript tail and drops it from the stream when superseded (fold baseline)', () => {
      const turnA = {
        id: 'turn-a', turnId: 'turn-a', role: 'assistant' as const, summary: '',
        items: [{ id: 'tool-c1', kind: 'tool_use' as const, toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } }],
      }
      const turnB = {
        id: 'turn-b', turnId: 'turn-b', role: 'assistant' as const,
        summary: 'Wrapping up shortly', summaryKind: 'echo' as const,
        items: [{ id: 'tool-c2', kind: 'tool_use' as const, toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }],
      }
      // Frame 1: turnB is the tail of the final open line — its echo caption
      // paints in-stream after the line.
      const { rerender } = render(
        <FreshAgentTranscript isStreaming turns={[turnA, turnB]} />,
      )
      expect(screen.getByTestId('fresh-agent-tail-caption')).toHaveTextContent('Wrapping up shortly')
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)

      // Frame 2: turnC absorbs into the line; turnB is superseded — the
      // caption leaves the stream (Task 4 stashes it into the expansion).
      const turnC = {
        id: 'turn-c', turnId: 'turn-c', role: 'assistant' as const, summary: '',
        items: [{ id: 'tool-c3', kind: 'tool_use' as const, toolUseId: 'c3', name: 'Read', input: { file_path: 'src/c.ts' } }],
      }
      rerender(<FreshAgentTranscript isStreaming turns={[turnA, turnB, turnC]} />)
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
      expect(screen.queryByText('Wrapping up shortly')).not.toBeInTheDocument()
    })
```

(f) Tag-only updates: :1759 (`summaryKind: 'echo'` on turn-c), :1774 (`summaryKind: 'authored'` on `turnCEmpty` — assertions unchanged), :1917 (`summaryKind: 'echo'` on the thinking turn — it now drops via the echo rule rather than "never painted"), :1938 and :1961 (`summaryKind: 'echo'` on turn-b), and the `thinkingOnly` helper in the jp70 describe (:1094) gains `summaryKind: 'echo' as const` (keeps `'drops a non-streaming turn when all items are filtered out'` :1223 green under the new filter rules; the streaming-tail siblings are unaffected). Rename :1741 to `'permanently separates tool runs when the follower turn carries an untagged (unknown-provenance) summary'` — fixtures unchanged (untagged = conservative authored), with an updated comment: `// Conservative rule: a server that does not emit summaryKind leaves every non-blank summary authored — no absorb, no folding.`

Also in (f) — the three legacy merge tests found by LB-2 that relied on untagged exact-echo merges (each goes red under the new guard until tagged):

- `:460` `'collapses consecutive activity-only assistant turns into one live strip'`: add `summaryKind: 'echo'` inline to each of the three `summary: 'Read'` assistant turns (the `'request'` user turn stays untagged — role changes never absorb). Assertions unchanged.
- `:577` `'coalesces adjacent Claude tool-use/result exchanges without rendering synthetic You turns'`: add `summaryKind: 'echo'` to both `summary: 'Read'` assistant turns AND to both `summary: 'Tool result'` user turns — the result turns coalesce via `appendTurnItems`, which keeps echo only when BOTH sides are echo, so the synthetic side needs the tag for the merge to survive. Assertions unchanged.
- `:895` `'merges adjacent activity-only display turns into one line actionable from the line end'`: both thinking turns are inline literals (not built by a helper), so add inline `summaryKind: 'echo' as const` to each (`summary: 'first thought'` / `'second thought'`). Assertions unchanged (they render under the component's `showThinking` prop default `true`, so both turns are fully visible).

(g) DELETE the classifier/painted-era pins whose machinery no longer exists: :1822 (`'merges a follower whose live summary space-joins several item echoes'` — the live summarizer is deleted), :1843 (`'merges a codex image-generation follower whose summary echoes its result'` — classifier-specific; generic echo coverage is the :1759 pin plus the server-side tags), :2008 (`'does not let a painted summary mark a different turn that shares its turnId'`), :2042 (`'keeps the painted boundary when a streaming summary grows after painting'`) — the painted-summary store is deleted; folding is deterministic per the turn list, so there is no paint-history identity to confuse.

(h) In `test/unit/client/lib/fresh-agent-ws.test.ts:462-466`, change the expectation to `summary: ''`. In `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx:1215-1219`, change `summary: 'Final answer'` to `summary: ''`.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

Expected: FAIL on the intended behaviors: the explicit-authored echo-text pin merges under the old classifier (expects 2 strips, gets 1); the echo+authored coalescing pin merges (expects 2, gets 1); the fold-baseline rewrite reds on frame 1 (`fresh-agent-tail-caption` does not exist yet); the superseded-caption pins hold the painted placeholder boundary (expect 1 strip/caption gone, get 2 strips); the slice pins still compute a summary (expect `''`). Not syntax/setup accidents. (The tag-only updates in (f) may already pass — they are pins, not reds.)

- [ ] **Step 3: Add the minimal production implementation**

In `src/components/fresh-agent/FreshAgentTranscript.tsx`:

1. Import: `import { getFreshAgentDisplayTurnKey, turnSummaryIsAuthored } from '@shared/fresh-agent-turns'`.
2. DELETE the classifier block (:223-311: the echo/authored comment, `SUMMARY_LABEL_BY_KIND`, `itemEchoes`, `segmentMatchesEchoes`, `summaryIsAuthoredContent`), the `DisplayTurn` type + doc (:440-465), and the painted store (:467-501: comment, `PaintedSummaryStore`, `recordPaintedSummary`, `paintedSummaryMatches`).
3. Replace `filterTurnsForDisplay` with the marker-stamping version. `DisplayTurn` is the new minimal replacement for the deleted one — the fold gate needs it on BOTH sides (paint and, in Task 4, stash):

```ts
/**
 * A display turn stamped by `filterTurnsForDisplay` when display filtering
 * removed ANY of its items. The fold gate reads the marker: a turn's echo
 * caption paints/stashes ONLY when the turn was fully visible — every item
 * rendered — because the echo summary may derive from a filtered-out (hidden)
 * thinking/reasoning item, and showing it would leak content the user chose
 * to hide (LB-1).
 */
type DisplayTurn = FreshAgentTurn & { hadFilteredItems?: boolean }

function filterTurnsForDisplay(
  turns: FreshAgentTurn[],
  options: TranscriptDisplayOptions,
  isStreaming: boolean,
): DisplayTurn[] {
  return turns
    .map((turn, index): DisplayTurn | null => {
      const items = turn.items.filter((item) => shouldDisplayTranscriptItem(item, options))
      if (turn.items.length > 0 && items.length === 0) {
        // The streaming tail keeps its (invisible-bodied) article so the busy
        // affordance does not flash out and back while the turn produces only
        // hidden items.
        if (isStreaming && index === turns.length - 1) {
          return { ...turn, items: [], hadFilteredItems: true }
        }
        // Blank summary: nothing to show — drop the turn outright.
        if ((turn.summary ?? '').trim().length === 0) return null
        // Authored prose is real content: keep it painted as a summary-only
        // article (a permanent boundary between the surrounding lines).
        if (turnSummaryIsAuthored(turn)) return { ...turn, items: [], hadFilteredItems: true }
        // Echo caption of now-hidden items: superseded — drop it. Its content
        // stays hidden, matching the user's showThinking choice.
        return null
      }
      if (items.length === turn.items.length) return turn
      return { ...turn, items, hadFilteredItems: true }
    })
    .filter((turn): turn is DisplayTurn => turn !== null)
}
```

4. `appendTurnItems` recomputes provenance:

```ts
function appendTurnItems(previous: FreshAgentTurn, next: FreshAgentTurn): FreshAgentTurn {
  return {
    ...previous,
    id: `${previous.id}:${next.id}`,
    summary: [previous.summary, next.summary].filter(Boolean).join('\n\n'),
    // Echo only when BOTH sides are echo: an authored segment must never be
    // laundered into a foldable caption, and an untagged side is conservative.
    summaryKind: previous.summaryKind === 'echo' && next.summaryKind === 'echo' ? 'echo' : 'authored',
    items: [...previous.items, ...next.items],
    model: next.model ?? previous.model,
    timestamp: next.timestamp ?? previous.timestamp,
  }
}
```

5. `buildTranscriptLayout(turns: DisplayTurn[])` — full replacement. Drops the painted param, gains per-line member tracking and the gated in-stream tail caption. (Captions are computed per frame from the turn list — no paint history; the painted store stays deleted.) Also `LineCaption` is defined here; Task 4's expansion consumes it.

```ts
/** One gated echo caption, positioned by the line's ITEM index where its turn entered. */
type LineCaption = { id: string; text: string; atItemIndex: number }

/** A turn that materially contributes items to an activity line. */
type LineMember = { turnIndex: number; atItemIndex: number; caption: LineCaption | null }

function buildTranscriptLayout(
  turns: DisplayTurn[],
): {
  layouts: TurnLayout[]
  lineEndIndex: Map<number, number>
  tail: { blockId: string; turnIndex: number } | null
  tailCaption: LineCaption | null
} {
  const layouts: TurnLayout[] = []
  let open: {
    originIndex: number
    role: FreshAgentTurn['role']
    items: FreshAgentTranscriptItem[]
    members: LineMember[]
  } | null = null
  const lineEndIndex = new Map<number, number>()
  let lineSeq = 0
  let captionSeq = 0
  let tailCaption: LineCaption | null = null

  /** echo AND non-blank AND fully visible — the one gate for paint and stash (LB-1). */
  const foldCaption = (turn: DisplayTurn, atItemIndex: number): LineCaption | null => {
    const text = (turn.summary ?? '').trim()
    if (text.length === 0 || turn.hadFilteredItems || turnSummaryIsAuthored(turn)) return null
    const id = `caption:${captionSeq++}`
    return { id, text, atItemIndex }
  }

  const flushOpen = () => {
    if (!open) return
    const rows = buildActivity(open.items)
    if (rows.length > 0) {
      const id = `line:${lineSeq++}`
      layouts[open.originIndex].blocks.push({ kind: 'activity', id, rows })
    }
    open = null
  }

  for (const [turnIndex, turn] of turns.entries()) {
    const layout: TurnLayout = { blocks: [] }
    layouts.push(layout)
    if (turn.items.length === 0) {
      // Zero-item turns hard-close any open line and render their own article;
      // they never carry a caption OF THEIR OWN (no Rust producer emits a
      // zero-item turn with a non-blank summary, LB-4). The close itself is a
      // later-activity boundary: Task 4's stash treats it as superseding the
      // closing line's last member.
      flushOpen()
      continue
    }
    for (const item of turn.items) {
      if (isActivityLike(item)) {
        // The boundary guard applies only to absorbing into a PREVIOUS turn's
        // line. Once this turn has opened its own line, its later activity
        // items chain into it normally. A non-blank AUTHORED summary (or an
        // untagged one — conservative) is "something between": it can render,
        // so the runs behind it are permanently separated. Blank and
        // echo-tagged summaries carry no extra rendering and never block a
        // merge. (The `?? ''` is defensive — the zod schema requires `summary`
        // on the wire, but ported fixtures may omit it.)
        if (
          open
          && open.role === turn.role
          && (
            open.originIndex === turnIndex
            || (turn.summary ?? '').trim().length === 0
            || !turnSummaryIsAuthored(turn)
          )
        ) {
          // Record the turn as a member once, at its first activity item —
          // Task 4's stash anchors the member's caption there.
          if (open.originIndex !== turnIndex && !open.members.some((m) => m.turnIndex === turnIndex)) {
            open.members.push({ turnIndex, atItemIndex: open.items.length, caption: foldCaption(turn, open.items.length) })
          }
          const taken = new Set(open.items.map((openItem) => openItem.id))
          let displayItem = item
          let counter = 2
          while (taken.has(displayItem.id)) {
            displayItem = { ...item, id: `${item.id}:d${counter}` }
            counter += 1
          }
          open.items.push(displayItem as FreshAgentTranscriptItem)
          lineEndIndex.set(open.originIndex, turnIndex)
        } else {
          flushOpen()
          open = { originIndex: turnIndex, role: turn.role, items: [item], members: [{ turnIndex, atItemIndex: 0, caption: foldCaption(turn, 0) }] }
        }
        continue
      }
      if (!rendersVisibly(item)) {
        // Invisible content only. Same-role turns merge freely (nothing renders
        // between the lines). A different-role turn still paints its header, so
        // it closes the open line and keeps its (invisible-bodied) block.
        if (open && turn.role !== open.role) {
          flushOpen()
          layout.blocks.push({ kind: 'item', item })
        }
        continue
      }
      flushOpen()
      layout.blocks.push({ kind: 'item', item })
    }
  }
  // The final open line's LAST member is not superseded: its pre-gated
  // caption paints in-stream as the transcript tail (while streaming and
  // after the session settles — the caption stays until later activity
  // supersedes it). Task 4 stashes the superseded members' captions.
  tailCaption = open?.members.at(-1)?.caption ?? null
  flushOpen()

  // tail = last rendered block overall when it is an activity line; null when
  // the transcript visibly ends in a message.
  let tail: { blockId: string; turnIndex: number } | null = null
  for (let i = layouts.length - 1; i >= 0; i--) {
    const blocks = layouts[i].blocks
    if (blocks.length === 0) continue
    const last = blocks[blocks.length - 1]
    if (last.kind === 'activity') tail = { blockId: last.id, turnIndex: i }
    break
  }
  return { layouts, lineEndIndex, tail, tailCaption }
}
```

6. In the component: delete `paintedSummaryKeysRef` (:903-906), the recording effect (:923-935), and the `turn.filteredPlaceholder` render branch (:1067-1069). The `displayTurns` memo calls `filterTurnsForDisplay(coalesceSyntheticToolResultTurns(turns), displayOptions, isStreaming)`; the layout memo calls `buildTranscriptLayout(displayTurns)`. Two render rules:

   - The zero-item article renders its summary ONLY when it is real content: `blocks.length === 0` AND NOT (`hadFilteredItems && echo`) — a display-filtered echo placeholder (hidden items, superseded caption) renders nothing visible; authored placeholders keep painting their prose.
   - After the last turn article, paint the gated tail caption in-stream:

```tsx
        {layoutResult.tailCaption ? (
          <div
            key={layoutResult.tailCaption.id}
            data-testid="fresh-agent-tail-caption"
            className="fresh-agent-activity-caption my-0.5 px-2 py-0.5 text-xs italic text-muted-foreground"
          >
            {layoutResult.tailCaption.text}
          </div>
        ) : null}
```

In `src/store/freshAgentSlice.ts`: delete `summarizeFreshAgentItems` (:130-143) and write `summary: ''` at :595 (the reducer stays — it still clears `streamingText`/`streamingActive`, which `pane-activity.ts` live-reads).

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Confirm no dead references remain: `rg -n "echoItems|filteredPlaceholder|paintedSummary|itemEchoes|segmentMatchesEchoes|summaryIsAuthoredContent|SUMMARY_LABEL_BY_KIND|summarizeFreshAgentItems" src/ test/` returns zero hits (`DisplayTurn` is NOT in the list — Task 3 replaces the deleted type with its new minimal marker version). `npm run typecheck` and `npm run lint` clean.

- [ ] **Step 6: Run impacted-test verification**

The transcript and slice are consumed by every fresh-agent view (desktop + mobile) and the WS layer. Impacted set: the whole fresh-agent client test surface plus typecheck.

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/ test/unit/client/lib/ test/unit/client/store/freshAgentSlice.test.ts && npm run typecheck && npm run lint`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentTranscript.tsx src/store/freshAgentSlice.ts test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git commit -m "refactor(freshagent): consume server summaryKind; delete client echo classifier and painted-summary store"
```

### Task 4: Foldable echo captions (superseded-member stash + expansion rendering)

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx` (`ActivityRow` :91-93, `buildActivity` :95-157, `buildTranscriptLayout` flush paths, `FreshAgentActivityStrip` expansion :719-723 and `lastRow` derivation, `selectLiveActivityBlockIdFromLayout` settled branch :582-585)
- Test: `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`

**Interfaces:**
- Consumes: Task 3's null-safe provenance absorb guard, Task 3's `DisplayTurn`/`hadFilteredItems` marker, per-line member records, `LineCaption`/`foldCaption`, the gated `tailCaption`, and `turnSummaryIsAuthored`.
- Produces: `ActivityRow` gains `{ type: 'caption'; id: string; text: string }`; `buildActivity(items, captions?)`; the superseded-member stash (`flushOpen(stashLastMember)`); the in-expansion caption testid `data-testid="fresh-agent-activity-caption"`.

- [ ] **Step 1: Write the failing behavioral test**

Add a `describe('foldable echo captions')` inside `describe('activity line collapse')` (it reuses the `toolTurn` helper):

```tsx
    it('stashes a superseded echo caption only when its turn was fully visible (claude lane)', () => {
      // Claude lane (LB-1): [thinking "secret", tool_use] under the production
      // default showThinking=false. The echo summary derives from the HIDDEN
      // thinking item; the turn is partially filtered, so its caption is
      // NEITHER painted at the tail NOR stashed into the expansion.
      const secretTurn = {
        id: 'turn-secret', turnId: 'turn-secret', role: 'assistant' as const,
        summary: 'secret plans', summaryKind: 'echo' as const,
        items: [
          { id: 'think-secret', kind: 'thinking' as const, text: 'secret plans' },
          { id: 'tool-c2', kind: 'tool_use' as const, toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } },
        ],
      }
      // Positive control: a fully-visible superseded echo turn DOES stash. The
      // same test therefore red-flags BOTH failure modes — no stash machinery
      // at all (zero captions) and an ungated stash (the hidden text leaks).
      const visibleTurn = {
        id: 'turn-visible', turnId: 'turn-visible', role: 'assistant' as const,
        summary: 'Read', summaryKind: 'echo' as const,
        items: [{ id: 'tool-c3', kind: 'tool_use' as const, toolUseId: 'c3', name: 'Read', input: { file_path: 'src/c.ts' } }],
      }
      render(
        <FreshAgentTranscript
          isStreaming
          showThinking={false}
          turns={[toolTurn('turn-a', [['c1', 'src/a.ts']]), secretTurn, visibleTurn, toolTurn('turn-z', [['c4', 'src/d.ts']])]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
      // turn-z is the blank-captioned tail, so nothing paints in-stream…
      expect(screen.queryByTestId('fresh-agent-tail-caption')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      const captions = screen.getAllByTestId('fresh-agent-activity-caption')
      expect(captions).toHaveLength(1)
      expect(captions[0]).toHaveTextContent('Read')
      // The hidden thinking text appears NOWHERE — not in the stream, not in
      // the expansion.
      expect(screen.queryByText('secret plans')).not.toBeInTheDocument()
      // The visible item from the partially-filtered turn still absorbed.
      expect(screen.getByText('src/b.ts')).toBeInTheDocument()
      expect(screen.getByText('src/c.ts')).toBeInTheDocument()
    })

    it('stashes a superseded echo caption only when its turn was fully visible (codex lane)', () => {
      // Codex lane (LB-1): [reasoning{summary: [], text: "secret"}, command]
      // under showThinking=false — the reasoning item is hidden, the command
      // item renders; the echo summary derives from the hidden reasoning.
      const secretTurn = {
        id: 'turn-secret', turnId: 'turn-secret', role: 'assistant' as const,
        summary: 'secret plans', summaryKind: 'echo' as const,
        items: [
          { id: 'reason-secret', kind: 'reasoning' as const, summary: [] as string[], content: ['secret plans'], text: 'secret plans' },
          { id: 'cmd-c2', kind: 'command' as const, command: 'ls src', status: 'completed' as const },
        ],
      }
      const visibleTurn = {
        id: 'turn-visible', turnId: 'turn-visible', role: 'assistant' as const,
        summary: 'ls test', summaryKind: 'echo' as const,
        items: [{ id: 'cmd-c3', kind: 'command' as const, command: 'ls test', status: 'completed' as const }],
      }
      render(
        <FreshAgentTranscript
          isStreaming
          showThinking={false}
          turns={[toolTurn('turn-a', [['c1', 'src/a.ts']]), secretTurn, visibleTurn, toolTurn('turn-z', [['c4', 'src/d.ts']])]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      const captions = screen.getAllByTestId('fresh-agent-activity-caption')
      expect(captions).toHaveLength(1)
      expect(captions[0]).toHaveTextContent('ls test')
      expect(screen.queryByText('secret plans')).not.toBeInTheDocument()
    })

    it('treats a zero-item blank-summary turn as a benign line boundary (opencode structural-message shape)', () => {
      // Routine in opencode (LB-4): a message whose parts are all structural
      // (step-start/step-finish) arrives as a turn with items: [] and
      // summary: ''. It renders nothing, stashes nothing, and still
      // hard-closes the open line.
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[
            toolTurn('turn-a', [['c1', 'src/a.ts']]),
            { id: 'turn-empty', turnId: 'turn-empty', role: 'assistant', summary: '', summaryKind: 'echo', items: [] },
            toolTurn('turn-b', [['c2', 'src/b.ts']]),
          ]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
      for (const toggle of screen.getAllByRole('button', { name: 'Toggle activity details' })) {
        fireEvent.click(toggle)
      }
      expect(screen.queryByTestId('fresh-agent-activity-caption')).not.toBeInTheDocument()
    })

    it('a zero-item structural turn closes the line and folds its last member caption into the expansion', () => {
      // Supersede semantics (fresh-eyes round 2, Finding 3): the zero-item
      // opencode structural turn contributes nothing itself — but its ARRIVAL
      // is a later-activity boundary that closes the open line, so the closing
      // line's last member is superseded and its gated echo caption stashes.
      // Without this, a caption painted moments ago would vanish with nowhere
      // to go — the exact failure the fold feature exists to fix.
      const captionTurn = {
        id: 'turn-caption', turnId: 'turn-caption', role: 'assistant' as const,
        summary: 'Considering options', summaryKind: 'echo' as const,
        items: [{ id: 'tool-c2', kind: 'tool_use' as const, toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }],
      }
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[
            toolTurn('turn-a', [['c1', 'src/a.ts']]),
            captionTurn,
            { id: 'turn-empty', turnId: 'turn-empty', role: 'assistant' as const, summary: '', summaryKind: 'echo' as const, items: [] },
            toolTurn('turn-b', [['c3', 'src/c.ts']]),
          ]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
      expect(screen.queryByTestId('fresh-agent-tail-caption')).not.toBeInTheDocument()
      expect(screen.queryByText('Considering options')).not.toBeInTheDocument()
      fireEvent.click(screen.getAllByRole('button', { name: 'Toggle activity details' })[0])
      expect(screen.getByTestId('fresh-agent-activity-caption')).toHaveTextContent('Considering options')
    })

    it('a multi-line echo turn paints/stashes its caption in exactly ONE place (caption transfer)', () => {
      // Real producer shape (fresh-eyes round 3, Finding 1): one assistant turn
      // interleaves [tool, visible text, tool], which spans TWO activity lines.
      // The turn's caption must transfer to the turn's next line at the text
      // boundary, never appearing in two places in one frame.
      const multiLineTurn = {
        id: 'turn-multi', turnId: 'turn-multi', role: 'assistant' as const,
        summary: 'Reading the config files', summaryKind: 'echo' as const,
        items: [
          { id: 'tool-m1', kind: 'tool_use' as const, toolUseId: 'm1', name: 'Read', input: { file_path: 'src/a.ts' } },
          { id: 'text-mid', kind: 'text' as const, text: 'Both files read fine.' },
          { id: 'tool-m2', kind: 'tool_use' as const, toolUseId: 'm2', name: 'Read', input: { file_path: 'src/b.ts' } },
        ],
      }
      const { rerender } = render(
        <FreshAgentTranscript isStreaming turns={[multiLineTurn]} />,
      )
      // Live frame: the caption paints ONCE, as the tail caption of the turn's
      // SECOND line (the final open line) — not in the first line's expansion.
      const streamMatches = screen.getAllByText('Reading the config files')
      expect(streamMatches).toHaveLength(1)
      expect(screen.getByTestId('fresh-agent-tail-caption')).toHaveTextContent('Reading the config files')
      for (const toggle of screen.getAllByRole('button', { name: 'Toggle activity details' })) {
        fireEvent.click(toggle)
      }
      expect(screen.queryByTestId('fresh-agent-activity-caption')).not.toBeInTheDocument()

      // A later turn supersedes the second line: the caption folds into THAT
      // line's expansion — still exactly one visible place.
      rerender(
        <FreshAgentTranscript
          isStreaming
          turns={[multiLineTurn, toolTurn('turn-z', [['c9', 'src/z.ts']])]}
        />,
      )
      expect(screen.queryByText('Reading the config files')).not.toBeInTheDocument()
      const strips = screen.getAllByRole('region', { name: 'Activity strip' })
      expect(strips).toHaveLength(2)
      expect(screen.queryByTestId('fresh-agent-tail-caption')).not.toBeInTheDocument()
      fireEvent.click(strips[1].querySelector('button[aria-label="Toggle activity details"]')!)
      const caption = screen.getByTestId('fresh-agent-activity-caption')
      expect(caption).toHaveTextContent('Reading the config files')
      // First line's expansion stays caption-free (the transfer happened).
      fireEvent.click(strips[0].querySelector('button[aria-label="Toggle activity details"]')!)
      expect(screen.getAllByTestId('fresh-agent-activity-caption')).toHaveLength(1)
    })

    it('never folds authored prose: it stays painted and keeps the lines separate', () => {
      const proseTurn = {
        id: 'turn-prose', turnId: 'turn-prose', role: 'assistant' as const,
        summary: 'Pausing to plan the next step', summaryKind: 'authored' as const, items: [],
      }
      const { rerender } = render(
        <FreshAgentTranscript isStreaming turns={[toolTurn('turn-a', [['c1', 'src/a.ts']]), proseTurn]} />,
      )
      expect(screen.getByText('Pausing to plan the next step')).toBeInTheDocument()
      rerender(
        <FreshAgentTranscript isStreaming turns={[toolTurn('turn-a', [['c1', 'src/a.ts']]), proseTurn, toolTurn('turn-b', [['c2', 'src/b.ts']])]} />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
      expect(screen.getByText('Pausing to plan the next step')).toBeInTheDocument()
      fireEvent.click(screen.getAllByRole('button', { name: 'Toggle activity details' })[1])
      expect(screen.queryByTestId('fresh-agent-activity-caption')).not.toBeInTheDocument()
    })
```

Post-review list addition (task-004 review finding M1 — the list above pins the fold lifecycle but prescribed no liveness test):

- `'keeps liveness pinned to the last non-caption row when a stashed caption trails a merged thinking row'` — pins the caption-skip liveness guards (settled branch + strip `lastRow`): a `[tool, thinking]` member plus an absorbed turn entering on a merged thinking row leaves the line's last ROW a stashed caption, and the `Thinking` live marker/spinner must survive both streaming and settled judging the last NON-caption row.

And EXTEND the Task-3 fold-baseline test — after the existing frame-2 assertions, add the stash assertions and rename it `'stashes a superseded tail caption into the line expansion when the next turn absorbs'`. This is the POSITIVE fully-visible case: all turns are item-bearing and `showThinking` is on, display filtering removes nothing, and the caption stashes:

```tsx
      // ...existing frame-2 assertions (1 strip, 'Wrapping up shortly' gone from the stream)...
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      const caption = screen.getByTestId('fresh-agent-activity-caption')
      expect(caption).toHaveTextContent('Wrapping up shortly')
      // The stash anchors where turnB entered the line: after turnA's row,
      // before turnB's tool row.
      const toolB = screen.getByText('src/b.ts')
      expect(caption.compareDocumentPosition(toolB) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
```

Also extend `'drops a superseded hidden-thinking echo caption instead of holding a permanent boundary'` with the no-leak assertion at the end — the lane tests above cover the PARTIALLY-filtered absorb case; this keeps the FULLY-filtered case pinned:

```tsx
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(screen.queryByText('Considering options')).not.toBeInTheDocument()
```

Re-check, no edit: `'treats a zero-item turn as a boundary between tool lines'` (:1611) stays green unchanged under this design — a zero-item turn still hard-closes the open line and renders its own article (blank summary → nothing visible), so its 2-strip assertion holds; Step 4's full-file run includes it.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`

Expected: FAIL because the superseded-member stash does not exist yet — `fresh-agent-activity-caption` matches nothing, so the extended fold-baseline test, the zero-item-close supersede pin, the multi-line caption-transfer pin (its frame-2 expansion assertion), and both fully-visible-gate lane tests red on their positive caption assertions (`getByTestId`/`getAllByTestId` find zero caption rows). The transfer pin has a second, stronger red mode: run against a stash WITHOUT the `transferTurnIndex` skip (the natural first cut), frame 1 already shows the caption TWICE (stashed into line one AND re-painted after line two) — the red that pins the one-caption/one-place invariant for multi-line turns. Each lane test likewise reds against an ungated stash by finding the hidden text stashed — the red that pins LB-1's leak shut (both directions: the Task-3 paint gate already passed it, the Task-4 stash gate is what these tests add). Green from the start BY DESIGN: the authored-boundary test and the zero-item benign-boundary test pin behavior the pre-fold layout already has. Not syntax/setup accidents.

- [ ] **Step 3: Add the minimal production implementation**

In `src/components/fresh-agent/FreshAgentTranscript.tsx`:

1. No changes to `DisplayTurn`/`filterTurnsForDisplay` — Task 3 owns the marker, the fold gate, and the member records this task consumes. (The gate marker is set on EVERY filter path that removes items, so the stash adds no contract surface and revives no classifier.)

2. Extend `ActivityRow` and `buildActivity` (captions interleave by ITEM index; stitching/merging keep the first contributing item's index). `LineCaption` comes from Task 3:

```ts
type ActivityRow =
  | { type: 'thinking'; id: string; text: string }
  | { type: 'tool'; tool: FreshAgentToolDisplay }
  | { type: 'caption'; id: string; text: string }

function buildActivity(
  items: FreshAgentTranscriptItem[],
  captions: LineCaption[] = [],
): ActivityRow[] {
  const rows: ActivityRow[] = []
  // First item index that produced each row (tool_use/tool_result stitching and
  // thinking merges keep the FIRST contributing item's index) so captions
  // interleave at the position where they painted.
  const rowStartItemIndexes: number[] = []
  const toolIndexById = new Map<string, number>()
  // Providers stream thinking in chunks; consecutive thinking/reasoning items
  // merge into one row instead of stacking N "Thinking:" fragments.
  const pushThinking = (id: string, text: string, itemIndex: number) => {
    if (!text) return
    const last = rows[rows.length - 1]
    if (last?.type === 'thinking') {
      rows[rows.length - 1] = { ...last, text: `${last.text}\n\n${text}` }
      return
    }
    rowStartItemIndexes.push(itemIndex)
    rows.push({ type: 'thinking', id, text })
  }
  for (const [itemIndex, item] of items.entries()) {
    if (item.kind === 'thinking') {
      pushThinking(item.id, stripSystemReminders(item.text), itemIndex)
      continue
    }
    if (item.kind === 'reasoning') {
      pushThinking(item.id, item.summary.length > 0 ? item.summary.join('\n') : (item.text ?? ''), itemIndex)
      continue
    }
    if (item.kind === 'tool_result') {
      const index = toolIndexById.get(item.toolUseId)
      if (index !== undefined) {
        const existing = rows[index] as Extract<ActivityRow, { type: 'tool' }>
        rows[index] = {
          type: 'tool',
          tool: {
            ...existing.tool,
            output: formatJson(item.content),
            isError: item.isError,
            status: 'complete',
          },
        }
      } else {
        toolIndexById.set(item.id, rows.length)
        rowStartItemIndexes.push(itemIndex)
        rows.push({
          type: 'tool',
          tool: {
            id: item.id,
            name: 'Result',
            output: formatJson(item.content),
            isError: item.isError,
            status: 'complete',
          },
        })
      }
      continue
    }
    const tool = itemToToolDisplay(item)
    if (!tool) continue
    const existingIndex = toolIndexById.get(tool.id)
    if (existingIndex !== undefined) {
      rows[existingIndex] = { type: 'tool', tool }
    } else {
      toolIndexById.set(tool.id, rows.length)
      rowStartItemIndexes.push(itemIndex)
      rows.push({ type: 'tool', tool })
    }
  }
  if (captions.length === 0) return rows
  const withCaptions: ActivityRow[] = []
  const ordered = [...captions].sort((a, b) => a.atItemIndex - b.atItemIndex)
  let captionIndex = 0
  for (const [rowIndex, row] of rows.entries()) {
    while (
      captionIndex < ordered.length
      && ordered[captionIndex].atItemIndex <= rowStartItemIndexes[rowIndex]
    ) {
      withCaptions.push({ type: 'caption', id: ordered[captionIndex].id, text: ordered[captionIndex].text })
      captionIndex += 1
    }
    withCaptions.push(row)
  }
  for (; captionIndex < ordered.length; captionIndex++) {
    withCaptions.push({ type: 'caption', id: ordered[captionIndex].id, text: ordered[captionIndex].text })
  }
  return withCaptions
}
```

3. `buildTranscriptLayout` — flush paths gain the superseded-member stash (changes vs Task 3's member-tracking version: `flushOpen(stashLastMember)` stashes members' pre-gated captions into the line's `captions` before `buildActivity`; the final post-loop flush passes `false` and yields `tailCaption`). Also update the layout doc comment (:216-218): zero-item turns still hard-close any open line and render their own article; no Rust producer emits a zero-item turn with a non-blank summary (LB-4), so a zero-item turn never folds ITS OWN caption — but the close itself is a later-activity boundary: it supersedes the closing line's last member, whose gated caption folds into THAT LINE's expansion (never cross-line). The supersession stash is the only fold source; the final open line's last member paints in-stream instead.

```ts
  const flushOpen = (stashLastMember: boolean, transferTurnIndex?: number) => {
    if (!open) return
    // Every superseded member's pre-gated caption folds into the expansion.
    // The LAST member stashes only when a later visible turn superseded it
    // (stashLastMember) — otherwise its caption paints in-stream via
    // tailCaption and must not double-render here. `transferTurnIndex` skips
    // the closing boundary's OWN turn when that turn has more activity items
    // coming: a multi-line turn ([tool, text, tool], claude/opencode both
    // interleave them) would otherwise stash its caption into the first line
    // AND paint it again after the second — violating the one-caption/one-place
    // invariant (fresh-eyes round 3, Finding 1). Transferred captions are
    // re-created by the turn's next line-open member record.
    const stash = (stashLastMember ? open.members : open.members.slice(0, -1))
      .filter((member) => member.turnIndex !== transferTurnIndex)
    for (const member of stash) {
      if (member.caption) open.captions.push(member.caption)
    }
    const rows = buildActivity(open.items, open.captions)
    if (rows.length > 0) {
      const id = `line:${lineSeq++}`
      layouts[open.originIndex].blocks.push({ kind: 'activity', id, rows })
    }
    if (!stashLastMember) {
      tailCaption = open.members.at(-1)?.caption ?? null
    }
    open = null
  }
```

Every in-loop flush call site becomes `flushOpen(true)` (zero-item hard-close, role-change invisible boundary, line-open replace) EXCEPT the visible-content boundary, which computes the transfer:

```ts
      // `itemIndex` comes from `for (const [itemIndex, item] of turn.items.entries())`.
      const hasLaterActivity = turn.items.slice(itemIndex + 1).some(isActivityLike)
      flushOpen(true, hasLaterActivity ? turnIndex : undefined)
      layout.blocks.push({ kind: 'item', item })
```

(The Task-3 loop header becomes an `entries()` loop to expose `itemIndex`.) The zero-item/role-change/line-open closes are all caused by a DIFFERENT turn or by nothing, so they take the plain `flushOpen(true)`; a same-turn activity item while a line is open always takes the absorb clause (first guard condition), so line-open never needs the transfer. Note the zero-item semantics precisely (round 2, Finding 3): a zero-item structural turn contributes no caption of its own (LB-4), but its arrival IS a later-activity boundary that supersedes the closing line's last member — without stashing there, a just-painted caption would vanish with nowhere to go (the exact failure this feature fixes). The post-loop flush is the only `flushOpen(false)`: its last member's caption becomes the painted tail caption (`tailCaption` initialized `null` before the loop). Also add the stash buffer to the accumulator (fresh-eyes round 2, Finding 2): the `open` record gains `captions: LineCaption[]`, initialized `captions: []` at the line-open site and reset by every flush. Nothing else changes from Task 3: the absorb branch still only records the member (Task 3 snippet) and pushes the (deduped) item; the absorb guard is byte-identical to Task 3's.

4. Render caption rows in the strip expansion (replace the `displayRows.map` at :719-723; caption rows are non-interactive text — a11y-clean):

```tsx
          {displayRows.map((row) => {
            if (row.type === 'caption') {
              return (
                <div
                  key={row.id}
                  data-testid="fresh-agent-activity-caption"
                  className="fresh-agent-activity-caption my-0.5 px-2 py-0.5 text-xs italic text-muted-foreground"
                >
                  {row.text}
                </div>
              )
            }
            return row.type === 'thinking'
              ? <FreshAgentThinkingRow key={row.id} text={row.text} />
              : <FreshAgentToolBlock key={row.tool.id} tool={row.tool} initialExpanded={initialExpanded || singleToolExpand} />
          })}
```

5. Liveness: caption rows are not activity, in BOTH places (fresh-eyes round 1, Finding 4).

   The settled branch judges the last NON-caption row (replace :582-585):

```ts
    const candidate = [...layouts.flatMap((l) => l.blocks)].find((b) => b.kind === 'activity' && b.id === candidateId)
    if (candidate?.kind !== 'activity') return null
    const contentRows = candidate.rows.filter((row) => row.type !== 'caption')
    return contentRows.at(-1)?.type === 'thinking' ? candidate.id : null
```

   And the strip derives its live row the same way — a caption positioned after a merged thinking row must not kill `thinkingLive`/the spinner:

```ts
  // In FreshAgentActivityStrip:
  const lastRow = [...displayRows].reverse().find((row) => row.type !== 'caption') ?? null
```

One caption's text renders in exactly ONE place per frame: the final open line's last member paints in-stream as the tail caption (`fresh-agent-tail-caption`, Task 3) and is excluded from its own line's stash; superseded members render only inside the expansion; the `absorbed` check (:1064-1066) still suppresses absorbed turns' articles. Zero-item turns are never line members and always render their own article.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Verify `activityTools` and `settledSummary` need no caption awareness (never count caption rows as tools/thinking — confirm by reading; `lastRow` is already fixed in Step 3 item 5, and `normalizeActivityRows` must pass caption rows through — if it narrows to thinking/tool rows, teach the passthrough and note it here). `npm run typecheck && npm run lint` clean.

- [ ] **Step 6: Run impacted-test verification**

Same surface as Task 3 (the strip renders in desktop and mobile fresh-agent views).

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/ && npm run typecheck && npm run lint`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentTranscript.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx
git commit -m "feat(freshagent): fold superseded echo captions into activity line expansions"
```

### Task 5: E2E fold-transition coverage

**Files:**
- Modify: `test/e2e-browser/specs/fresh-agent.spec.ts` (extract `toolTurn` + the leaf-walk from the `activity line collapse` describe to file scope; add `describe('foldable echo captions')` after :1153)
- Test: `test/e2e-browser/specs/fresh-agent.spec.ts` (the spec IS the test)

**Interfaces:**
- Consumes: Task 3's in-stream tail caption (`data-testid="fresh-agent-tail-caption"`), Task 4's expansion caption (`data-testid="fresh-agent-activity-caption"`) and fold behavior; the existing routed-snapshot seeding pattern (`seedCollapsePane`, :1007-1097) and harness injection (`harness.receiveWsMessage`, wired `test/e2e-browser/helpers/test-harness.ts:120-126` → `ws.receiveMessageForTest` → `handleFreshAgentMessage`; `freshAgent.session.changed` ∈ `SNAPSHOT_INVALIDATING_FRESH_AGENT_EVENTS`, `FreshAgentView.tsx:82-83`, so the pane re-fetches the routed snapshot).
- Produces: e2e proof of the two user-visible fold outcomes. No `RUST_ONLY_SPECS`/`testMatch` registration: the spec stays in the default chromium project because the snapshot is routed (no real Rust server involved).

- [ ] **Step 1: Write the failing behavioral test**

Extract to file scope (after `suppressFreshAgentNetworkForActivePane`, :44): the `toolTurn` helper (moved verbatim from :1099-1113) and the leaf-pointer below; update `seedCollapsePane` to call the leaf-pointer (its :1053-1096 body is replaced by `await pointActiveFreshcodexLeafAtSession(page, sessionId)`), and delete the describe-local `toolTurn`.

```ts
async function pointActiveFreshcodexLeafAtSession(page: any, sessionId: string) {
  await expect.poll(async () => page.evaluate((sid) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    const state = harness?.getState()
    const findFreshcodexLeaf = (node: any): any => {
      if (!node) return null
      if (
        node.type === 'leaf'
        && node.content?.kind === 'fresh-agent'
        && node.content.sessionType === 'freshcodex'
      ) {
        return node
      }
      if (node.type === 'split') {
        return findFreshcodexLeaf(node.children?.[0]) ?? findFreshcodexLeaf(node.children?.[1])
      }
      return null
    }
    let tabId: string | null = null
    let leaf: any = null
    for (const [candidateTabId, layout] of Object.entries(state?.panes?.layouts ?? {})) {
      const candidateLeaf = findFreshcodexLeaf(layout)
      if (candidateLeaf) {
        tabId = candidateTabId
        leaf = candidateLeaf
      }
    }
    if (!tabId || !leaf) return false
    harness?.dispatch({
      type: 'panes/updatePaneContent',
      payload: {
        tabId,
        paneId: leaf.id,
        content: {
          ...leaf.content,
          sessionId: sid,
          sessionRef: { provider: 'codex', sessionId: sid },
          resumeSessionId: sid,
          status: 'idle',
          settingsDismissed: true,
        },
      },
    })
    return true
  }, sessionId), { timeout: 10_000 }).toBe(true)
}
```

Append the new describe at the end of the file:

```ts
test.describe('foldable echo captions', () => {
  async function seedFoldablePane(
    page: Parameters<typeof openPanePicker>[0],
    terminal: { waitForTerminal: () => Promise<void> },
    harness: { receiveWsMessage: (message: unknown) => Promise<void> },
    sessionId: string,
    initialTurns: unknown[],
  ) {
    // Same freshcodex picker flow as 'activity line collapse' above, but the
    // routed snapshot body is MUTABLE: pushSnapshot swaps the turn list, bumps
    // the revision, and injects a freshAgent.session.changed frame so the pane
    // re-fetches — the live-stream seam a real sidecar would drive.
    let turns = initialTurns
    let revision = 1
    await terminal.waitForTerminal()
    await enableClaudeAndCodex(page)

    const picker = await openPanePicker(page)
    await suppressFreshAgentNetworkForActivePane(page)
    await picker.getByRole('button', { name: /^Freshcodex$/i }).click({ force: true })
    await page.getByRole('option').first().click()
    await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({ timeout: 10_000 })

    await page.route(`**/api/fresh-agent/threads/freshcodex/codex/${sessionId}*`, async (route) => {
      const lastTurnId = ((turns[turns.length - 1] as { id?: string } | undefined)?.id) ?? ''
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionType: 'freshcodex',
          provider: 'codex',
          threadId: sessionId,
          sessionId,
          revision,
          latestTurnId: lastTurnId,
          status: 'idle',
          summary: '',
          capabilities: { send: true, interrupt: true, approvals: true, questions: true, fork: true },
          settings: { model: 'gpt-5.4-flash', permissionMode: 'on-request', effort: 'high', plugins: [] },
          tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          pendingApprovals: [],
          pendingQuestions: [],
          worktrees: [],
          diffs: [],
          turns,
        }),
      })
    })
    await pointActiveFreshcodexLeafAtSession(page, sessionId)

    return async function pushSnapshot(nextTurns: unknown[]) {
      turns = nextTurns
      revision += 1
      await harness.receiveWsMessage({
        type: 'freshAgent.event',
        sessionType: 'freshcodex',
        provider: 'codex',
        sessionId,
        event: { type: 'freshAgent.session.changed', sessionId },
      })
    }
  }

  test('an echo caption folds into the expanded activity line when a later turn supersedes it', async ({ freshellPage: _freshellPage, page, harness, terminal }) => {
    // The one real fold path: the tail line's last member paints its gated echo
    // caption in-stream; a LATER turn absorbs and supersedes it, so the caption
    // leaves the stream and lives only in the line's expansion. EVERY turn is
    // item-bearing — the zero-item/non-blank shape never occurs in Rust output
    // (LB-4; fresh-eyes round 1, Finding 1 — do not reintroduce it here).
    const captionTurn = {
      id: 'turn-caption', turnId: 'turn-caption', role: 'assistant',
      summary: 'Considering options', summaryKind: 'echo',
      items: [{ id: 'tool-c2', kind: 'tool_use', toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }],
    }
    const pushSnapshot = await seedFoldablePane(page, terminal, harness, 'fold-thread', [
      toolTurn('turn-a', [['c1', 'src/a.ts']]),
      captionTurn,
    ])
    const pane = page.locator('[data-context="fresh-agent"]').last()
    // Painted at the tail: visible in-stream, one merged strip.
    await expect(pane.getByTestId('fresh-agent-tail-caption')).toContainText('Considering options', { timeout: 10_000 })
    await expect(pane.getByRole('region', { name: 'Activity strip' })).toHaveCount(1)

    await pushSnapshot([
      toolTurn('turn-a', [['c1', 'src/a.ts']]),
      captionTurn,
      toolTurn('turn-c', [['c3', 'src/c.ts']]),
    ])
    // Superseded: the caption left the stream (blank-captioned turn-c paints
    // nothing) and lives only in the line's expansion.
    await expect(pane.getByText('Considering options')).toHaveCount(0, { timeout: 10_000 })
    await expect(pane.getByTestId('fresh-agent-tail-caption')).toHaveCount(0)
    await expect(pane.getByRole('region', { name: 'Activity strip' })).toHaveCount(1)
    await pane.getByRole('button', { name: 'Toggle activity details' }).click()
    const caption = pane.getByTestId('fresh-agent-activity-caption')
    await expect(caption).toHaveCount(1)
    await expect(caption).toContainText('Considering options')
    await expect(pane.getByText('src/b.ts')).toBeVisible()
    // (Anchor order — caption row precedes the superseded turn's first item row —
    // is pinned by the unit test's compareDocumentPosition assertion.)
  })

  test('authored prose never folds', async ({ freshellPage: _freshellPage, page, harness, terminal }) => {
    // Real codex authored shape: a turn whose reasoning item carries a
    // provider-written summary (`summaryKind: 'authored'`) plus a command item.
    // The prose lives in the (showThinking-gated) reasoning row; what THIS
    // spec pins is the fold boundary: the authored turn keeps its own line and
    // contributes no caption — painted or stashed — anywhere.
    const proseTurn = {
      id: 'turn-prose', turnId: 'turn-prose', role: 'assistant',
      summary: 'Pausing to plan the next step', summaryKind: 'authored',
      items: [
        { id: 'reason-p1', kind: 'reasoning', summary: ['Pausing to plan the next step'], content: ['Pausing to plan the next step'], text: 'Pausing to plan the next step' },
        { id: 'cmd-p1', kind: 'command', command: 'ls src', status: 'completed' },
      ],
    }
    const pushSnapshot = await seedFoldablePane(page, terminal, harness, 'fold-authored-thread', [
      toolTurn('turn-a', [['c1', 'src/a.ts']]),
      proseTurn,
    ])
    const pane = page.locator('[data-context="fresh-agent"]').last()
    await expect(pane.getByRole('region', { name: 'Activity strip' })).toHaveCount(2, { timeout: 10_000 })

    await pushSnapshot([
      toolTurn('turn-a', [['c1', 'src/a.ts']]),
      proseTurn,
      toolTurn('turn-b', [['c2', 'src/b.ts']]),
    ])
    await expect(pane.getByRole('region', { name: 'Activity strip' })).toHaveCount(2, { timeout: 10_000 })
    await expect(pane.getByTestId('fresh-agent-tail-caption')).toHaveCount(0)
    await pane.getByRole('button', { name: 'Toggle activity details' }).nth(0).click()
    await pane.getByRole('button', { name: 'Toggle activity details' }).nth(1).click()
    await expect(pane.getByTestId('fresh-agent-activity-caption')).toHaveCount(0)
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/fresh-agent.spec.ts --grep "foldable echo captions"`

Expected: FAIL. Against the pre-Task-3 client, frame 1 reds first (`fresh-agent-tail-caption` does not exist; the old painted model never painted an item-bearing turn's caption anyway). Against a Tasks-3-only client, frame 1 passes (the tail paints) but frame 2 reds (nothing stashes — `fresh-agent-activity-caption` matches nothing). (Skip this red run if Tasks 3–4 already landed — the red was then observed in Task 4's unit step; state which in the task record.)

- [ ] **Step 3: Add the minimal production implementation**

No production code — the implementation is Tasks 1–4; this task adds only the spec. (The helper extraction inside the spec file is the whole change.)

- [ ] **Step 4: Run the focused test**

Run: `npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/fresh-agent.spec.ts --grep "foldable echo captions|activity line collapse"`

Expected: PASS (the grep also re-runs the neighboring collapse specs that share the extracted helpers).

- [ ] **Step 5: Refactor while green**

Confirm the extraction is behavior-preserving: the two collapse specs still pass unchanged (Step 4's grep covers them). No other refactor.

- [ ] **Step 6: Commit the task**

The commit MUST precede Step 7's configured-backend run: a dirty tree is non-addressable by the cloud image tag and forces the ~13-minute paid `-dirty` cold rebuild (repo rule; fresh-eyes round 1, Finding 5).

```bash
git add test/e2e-browser/specs/fresh-agent.spec.ts
git commit -m "test(freshagent): e2e coverage for foldable echo captions"
```

- [ ] **Step 7: Run impacted-test verification**

Impacted e2e surface: the full fresh-agent spec on the default project, plus the Rust-control spec on its own project (it exercises real-server snapshot flow the routed specs bypass). Check `printenv FRESHELL_E2E_BACKEND` first; if unset, ask the user which backend to configure before any cloud run.

Run: `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/fresh-agent-control-rust.spec.ts && npm run test:e2e -- --project=chromium test/e2e-browser/specs/fresh-agent.spec.ts`

Expected: PASS (the second command uses the configured `FRESHELL_E2E_BACKEND`).

### Task 6: Docs reassessment + final full gate

**Files:**
- Modify: none (verification task — the docs decision is recorded here)
- Test: none new

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: the green full-suite gate the PR needs.

- [ ] **Step 1: Write the failing behavioral test**

Not applicable — this task adds no behavior. Its checks are the documentation-reference scan and the full gate below (each with its expected output).

- [ ] **Step 2: Run the documentation scan and verify no stale references**

Run: `rg -n "itemEchoes|paintedSummary|filteredPlaceholder|summarizeFreshAgentItems|segmentMatchesEchoes|summaryIsAuthoredContent|SUMMARY_LABEL_BY_KIND|pendingCaptions|captionFolded" -g '!docs/plans/**' AGENTS.md docs/ README.md || true`

Expected: no hits (zero matches). The `-g '!docs/plans/**'` exclusion is load-bearing (fresh-eyes round 1, Finding 3): plans are historical records — this plan names every searched symbol and the historical `docs/plans/2026-08-23-freshagent-activity-line.md` contains the deleted machinery's names; scanning them is expected-HIT and never actionable. The scan covers only live doc surfaces (AGENTS.md, README.md, and docs/ outside plans/). The docs mock (`docs/index.html:836-845`) renders a settled activity strip with no streaming echo captions, so the foldable-captions change does not alter what the mock shows — no `docs/index.html` update. `AGENTS.md` documents none of the deleted machinery — no update. The historical plan stays untouched. If the scan DOES find a hit, update that reference in this task.

- [ ] **Step 3: Add the minimal production implementation**

None — no doc changes required (per Step 2's expected result).

- [ ] **Step 4: Run the coordinated full suite**

Check `npm run test:status` first (coordinator gate); set `FRESHELL_TEST_SUMMARY='freshagent-summary-provenance final gate'`.

Run: `npm run check`

Expected: PASS (typecheck + coordinated full suite, on the configured vitest backend).

- [ ] **Step 5: Refactor while green**

Nothing to refactor — verification task.

- [ ] **Step 6: Run impacted-test verification (Rust workspace + e2e impacted set)**

Run: `cargo test --workspace --exclude freshell-tauri && cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings`

Expected: PASS

- [ ] **Step 7: Commit the task**

Nothing to commit if Step 2 found no stale references (the expected case) — state that in the task record. If Step 2 did surface a doc fix:

```bash
git add AGENTS.md docs/
git commit -m "docs: update fresh-agent summary references for provenance tagging"
```
