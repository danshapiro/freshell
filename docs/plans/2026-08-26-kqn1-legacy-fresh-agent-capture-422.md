# Legacy fresh-agent pane capture 422 (kqn1) Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
`GET /api/panes/:id/capture` must return HTTP 422 with JSON body
`{ status: 'error', message: containing 'pane kind "fresh-agent"' }` for panes
whose normalized pane kind is `fresh-agent` but which have no capturable
backing session on this server (the legacy/remote-layout-sync case), instead
of the current unhandled 500 on the Node server; the Rust server must reach
the same observable outcome (it currently returns 404 for the same pane). The
pinned expectation at
`test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts:420`
(`message: expect.stringContaining('pane kind "fresh-agent"')`) must pass.
Runtime-backed fresh-agent panes must keep returning `200` text transcripts.

### Explicit constraints
- Check both Node and Rust servers for parity.
- Do not regress the runtime-backed fresh-agent capture path (200 text/plain
  transcript), pinned by
  `test/server/agent-api-fresh-agent.test.ts:197-216` (`'renders the
  transcript text for a fresh-agent pane'`).
- Red/green/refactor TDD; unit-plus-e2e coverage of the behavior change.
- The work item is a genuine server bug (pre-existing on main; fails
  identically at the fork point); fix the server, not the test.
- Fix the system over the symptom; keep error semantics disciplined (a 422 is
  a pane-kind validation answer, not a shield over operational failures).

### Accepted tradeoffs and residuals
- Scope is the capture route only. `wait-for` and `send-keys` have the same
  layout-only legacy-pane hazard on Node (unmapped 500s); they are out of
  scope for this work item and noted as a follow-up.
- On Node, only the `RESTORE_NOT_FOUND` history-resolution failure maps to
  the 422 kind gate. `RESTORE_UNAVAILABLE` / `RESTORE_INTERNAL` /
  `RESTORE_DIVERGED` and all other runtime errors keep their existing
  `agentRouteErrorStatus` mapping (503/502/409/404/500) inside the capture
  branch.
- On Rust, runtime-registered fresh-agent (opencode) panes still hit the
  transcript path first; the layout-consult only fires when no runtime pane
  map claims the pane id, so no existing passing behavior changes.
- Baseline-recorded unrelated failures (`test/unit/vite-config.test.ts`
  `getNetworkHost`, 3 cases) are pre-existing on `main` and are not repaired
  by this work.

**Goal:** Legacy/layout-only `fresh-agent` panes answered by
`GET /api/panes/:id/capture` receive a clean 422 pane-kind validation error on
both servers, while runtime-backed fresh-agent panes keep their 200 text
transcripts.

**Architecture:** On the Node server, the capture route's `fresh-agent`
branch keeps consulting the runtime manager; its `catch` maps the claude
history resolution error with code `RESTORE_NOT_FOUND` (the
"no such session anywhere on this server" signal, i.e. a legacy/foreign
layout-only pane) to the existing generic 422 pane-kind validation response
instead of letting it fall through `agentRouteErrorStatus`'s 500 default. On
the Rust server, the capture handler's `panes`-map miss consults the shared
layout store before answering 404: any layout-visible non-`terminal` kind
(including normalized legacy `fresh-agent` content) is answered with the same
422 pane-kind validation message the Rust `content_panes` branch and the Node
generic gate already emit. Both fixes reuse the exact existing message
wording: `pane kind "<kind>" does not support capture-pane; use
screenshot-pane`.

**Tech Stack:** Node/Express (TypeScript, NodeNext ESM) for the legacy server;
Rust (axum, tokio) `freshell-freshagent` crate for the Rust server; Vitest+
supertest for Node server tests; in-crate `#[tokio::test]` tower oneshot tests
for Rust; Playwright for the kata's e2e oracle.

## Global Constraints

- Server uses NodeNext/ESM; relative imports must include `.js` extensions.
- Test commands use the repo-owned coordinated path:
  `npm run test:vitest -- run <files> --config config/vitest/vitest.server.config.ts`
  (`test/server/**` belongs to the server config). Raw `npx vitest` is not a
  coordinated workflow.
- Rust changes must pass `cargo fmt --all --check` and
  `cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings`
  (both are part of the full QA gate).
- The full QA gate is `darkforge qa --repo '/home/dan/code/freshell' --id
  'kqn1'` and runs `npm run check` (typecheck + coordinated full vitest suite)
  plus the cargo gates above.
- Error envelope is `fail(message)` → `{ status: 'error', message }` on Node
  (`server/agent-api/response.ts:6`) and `fail_json(status, message)` on Rust
  (`crates/freshell-freshagent/src/lib.rs:1624-1630`). Reuse them.
- The 422 message text must be exactly the existing wording:
  `pane kind "<kind>" does not support capture-pane; use screenshot-pane`
  (Node: `server/agent-api/router.ts:942-946`; Rust:
  `crates/freshell-freshagent/src/terminal_tabs.rs:2490-2508`).
- Truly unknown panes keep their existing 404 `pane not found` answer on both
  servers; runtime-backed fresh-agent panes keep 200 transcripts.
- No user-facing feature or docs change; `docs/index.html` and README are
  untouched.

---

### Task 1: Node capture route maps RESTORE_NOT_FOUND to the 422 pane-kind gate

**Files:**
- Modify: `server/agent-api/router.ts` (imports at `:34-41`; capture handler
  fresh-agent branch catch at `:917-919`)
- Test: `test/server/agent-capture-pane.test.ts`

**Interfaces:**
- Consumes:
  - `ClaudeFreshAgentHistoryResolutionError` from
    `../fresh-agent/history/claude/history-service.js` — class fields:
    `code: 'RESTORE_NOT_FOUND' | 'RESTORE_UNAVAILABLE' | 'RESTORE_INTERNAL' |
    'RESTORE_DIVERGED'` (`history-service.ts:54-62`). The claude adapter's
    `getSnapshot` throws this error unwrapped with code `RESTORE_NOT_FOUND`
    for any freshclaude/claude pane whose session resolves to
    `kind: 'missing'` in history
    (`server/fresh-agent/adapters/claude/adapter.ts:228-233`,
    `server/fresh-agent/history/claude/history-service.ts:136-139`). (The
    distinct unconfigured-history-source sub-case throws a plain `Error` one
    level up at `adapter.ts:109-112` and keeps its existing 500 mapping;
    production wiring always configures the source, so no behavior depends on
    that sub-case.)
  - `agentRouteErrorStatus(error)` (`server/agent-api/router.ts:54-69`) — the
    existing status mapper for every other error.
  - `fail(message)` (`server/agent-api/response.ts:6`).
- Produces: unchanged public route API; a new observable status/body for the
  legacy-pane capture case:
  `422` + `{ status: 'error', message: 'pane kind "fresh-agent" does not
  support capture-pane; use screenshot-pane' }`.

- [ ] **Step 1: Write the failing behavioral test**

Add to `test/server/agent-capture-pane.test.ts` (follow the file's existing
style — no `.js` extensions in test imports):

```ts
import { ClaudeFreshAgentHistoryResolutionError } from '../../server/fresh-agent/history/claude/history-service'
import { FreshAgentRuntimeUnavailableError } from '../../server/fresh-agent/runtime-manager'
```

```ts
  it('returns 422 pane-kind validation for a legacy fresh-agent pane with no backing session', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', createAgentApiRouter({
      layoutStore: {
        resolvePaneToTerminal: () => undefined,
        getPaneSnapshot: () => ({
          kind: 'fresh-agent',
          paneContent: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            sessionId: '11111111-1111-4111-8111-111111111111',
          },
        }),
      } as any,
      registry,
      freshAgentRuntimeManager: {
        getSnapshot: async () => {
          throw new ClaudeFreshAgentHistoryResolutionError('RESTORE_NOT_FOUND', 'Restore session not found')
        },
      } as any,
    }))
    const res = await request(app).get('/api/panes/pane-legacy-agent/capture')
    expect(res.status).toBe(422)
    expect(res.body).toMatchObject({
      status: 'error',
      message: expect.stringContaining('pane kind "fresh-agent"'),
    })
  })

  it('keeps the existing status mapping for other fresh-agent capture failures', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', createAgentApiRouter({
      layoutStore: {
        resolvePaneToTerminal: () => undefined,
        getPaneSnapshot: () => ({
          kind: 'fresh-agent',
          paneContent: {
            kind: 'fresh-agent',
            sessionType: 'freshopencode',
            provider: 'opencode',
            sessionId: 'ses_gone',
          },
        }),
      } as any,
      registry,
      freshAgentRuntimeManager: {
        getSnapshot: async () => {
          throw new FreshAgentRuntimeUnavailableError('runtime down')
        },
      } as any,
    }))
    const res = await request(app).get('/api/panes/pane-live-agent/capture')
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ status: 'error', message: expect.stringContaining('runtime down') })
  })
```

(`FreshAgentRuntimeUnavailableError` verifies the catch did not become a
blanket-422; it is a plain `Error` subclass with no custom constructor, so the
message is passed to `super(...)` — `server/fresh-agent/runtime-manager.ts:26-28`.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/server/agent-capture-pane.test.ts --config config/vitest/vitest.server.config.ts`

Expected: FAIL — the first new test receives `500` (the unmapped
`ClaudeFreshAgentHistoryResolutionError` falls through
`agentRouteErrorStatus`'s default) with body
`{ status: 'error', message: 'Restore session not found' }` instead of the
expected `422`. The second new test PASSES already (current behavior is
unchanged for other errors) — it is a guard pinning the existing mapping, not
a red test.

- [ ] **Step 3: Add the minimal production implementation**

In `server/agent-api/router.ts`, add to the existing value-import block from
`'../fresh-agent/runtime-manager.js'` a sibling import:

```ts
import { ClaudeFreshAgentHistoryResolutionError } from '../fresh-agent/history/claude/history-service.js'
```

Then change the capture handler's fresh-agent `catch` (`:917-919`) from:

```ts
      } catch (err: any) {
        return res.status(agentRouteErrorStatus(err)).json(fail(err?.message || 'fresh-agent capture failed'))
      }
```

to:

```ts
      } catch (err: any) {
        // A RESTORE_NOT_FOUND resolution means no session by this id exists on
        // this server (a legacy/foreign layout-sync pane): answer with the
        // generic pane-kind validation gate wording instead of an unhandled
        // 500. Every other failure keeps its documented status mapping.
        if (err instanceof ClaudeFreshAgentHistoryResolutionError && err.code === 'RESTORE_NOT_FOUND') {
          return res.status(422).json(
            fail(`pane kind "${paneSnapshot.kind}" does not support capture-pane; use screenshot-pane`),
          )
        }
        return res.status(agentRouteErrorStatus(err)).json(fail(err?.message || 'fresh-agent capture failed'))
      }
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/server/agent-capture-pane.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS (all five tests in the file: 3 pre-existing + 2 new).

- [ ] **Step 5: Refactor while green**

No refactor needed: the change is one narrow conditional inside an existing
branch, reuses the generic gate's exact message construction, and introduces
no shared code worth extracting.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: every suite that exercises the agent-API router's
capture/fresh-agent behavior and error mapping — the fresh-agent REST agent-API
specs and the screenshot route specs (the only other 422 user). The
`server/fresh-agent/router.ts` read-model parity suite
(`test/integration/server/fresh-agent-claude-history-route-parity.test.ts`)
pins `RESTORE_NOT_FOUND → 404` on a DIFFERENT router that this task does not
touch; it is covered by the full-suite gate instead.

Run: `npm run test:vitest -- run test/server/agent-capture-pane.test.ts test/server/agent-api-fresh-agent.test.ts test/server/agent-screenshot-api.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add server/agent-api/router.ts test/server/agent-capture-pane.test.ts
git commit -m "fix(agent-api): return 422 pane-kind validation for legacy fresh-agent capture"
```

### Task 2: Rust capture route 422s layout-only non-terminal panes

**Files:**
- Modify: `crates/freshell-freshagent/src/lib.rs` (capture handler `panes`-map
  miss arm at `:2432-2443`)
- Test: `crates/freshell-freshagent/src/terminal_tabs.rs` (tests module, next
  to `capture_browser_pane_is_422_use_screenshot_pane` at `:6610-6629`)

**Interfaces:**
- Consumes:
  - `state.layout: layout_store::LayoutStore` (`lib.rs:307`) and
    `LayoutStore::get_pane_snapshot(&self, pane_id: &str) -> Option<PaneSnapshot>`
    (`layout_store.rs:656-682`), with
    `PaneSnapshot { tab_id, pane_id, kind: Option<String>, terminal_id: Option<String>, pane_content: Option<Value> }`
    (`layout_store.rs:208-216`). `rename_pane` (`lib.rs:2149`) is the existing
    REST-route precedent for this read.
  - `LayoutStore::update_from_ui(&self, sync: &freshell_protocol::UiLayoutSync,
    source_connection_id: &str)` (`layout_store.rs:235`) — runs the legacy
    `agent-chat` → `fresh-agent` content migration on ingestion
    (`migrate_legacy_fresh_agent_node`,
    `layout_store_content.rs:372-399`), exactly like the e2e's WS sync path.
  - `terminal_tabs::maybe_capture` stays first in dispatch order
    (terminal/content bookkeeping maps are disjoint).
- Produces: for a pane id absent from `panes`/`terminal_panes`/
  `content_panes` but present in the layout store with a non-`terminal` kind:
  `422 UNPROCESSABLE_ENTITY` + `{ status: 'error', message: 'pane kind
  "fresh-agent" does not support capture-pane; use screenshot-pane' }`
  (matching `terminal_tabs.rs:2490-2508` wording). Layout-visible `terminal`
  kinds and unknown ids keep the existing `404 pane not found`.

- [ ] **Step 1: Write the failing behavioral test**

In the `tests` module of `crates/freshell-freshagent/src/terminal_tabs.rs`,
immediately after `capture_browser_pane_is_422_use_screenshot_pane`
(`:6610-6629`, the module's closing `}` follows at `:6630`), add:

```rust
    #[tokio::test]
    async fn capture_layout_synced_legacy_fresh_agent_pane_is_422() {
        // Mirrors the e2e kata scenario
        // (test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts:402-424):
        // a legacy `agent-chat` pane arrives through the layout sync path, is
        // normalized to `fresh-agent` by the layout store's migration, and
        // exists in NO runtime pane map.
        let state = state_with_registry();
        state.layout.update_from_ui(
            &serde_json::from_value::<freshell_protocol::UiLayoutSync>(json!({
                "tabs": [{ "id": "t1" }],
                "activeTabId": "t1",
                "layouts": {
                    "t1": {
                        "type": "leaf",
                        "id": "pane-legacy-agent",
                        "content": {
                            "kind": "agent-chat",
                            "provider": "claude",
                            "resumeSessionId": "11111111-1111-4111-8111-111111111111"
                        }
                    }
                },
                "activePane": { "t1": "pane-legacy-agent" },
                "timestamp": 1
            }))
            .expect("UiLayoutSync parses"),
            "conn-1",
        );
        let router = app(state);

        let (status, body) = get(router, "/api/panes/pane-legacy-agent/capture", true).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(
            body["message"]
                .as_str()
                .unwrap()
                .contains("pane kind \"fresh-agent\""),
            "expected the fresh-agent pane-kind validation message, got: {body}"
        );
    }

    #[tokio::test]
    async fn capture_unknown_pane_still_404s_pane_not_found() {
        // Guard: no layout sync, no runtime maps — the pre-existing unknown-pane
        // answer is unchanged by the layout consult.
        let state = state_with_registry();
        let (status, body) = get(app(state), "/api/panes/nope/capture", true).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["message"], json!("pane not found"));
    }
```

`serde_json::from_value::<freshell_protocol::UiLayoutSync>` is the same
deserialization the `layout_store_tests.rs` `sync_from` helper (`:8-10`)
performs; `freshell_protocol` and `json!` are already in scope in this crate's
test modules, and `state_with_registry()`/`app()`/`get()` are the existing
helpers (`:2647`, `:2656`, `:2690`).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent capture_`

(The `capture_` filter selects every in-crate capture test, including the two
new ones and the neighboring `capture_browser_pane_is_422_use_screenshot_pane`.)

Expected: FAIL for `capture_layout_synced_legacy_fresh_agent_pane_is_422`
because the current handler answers `404 pane not found` for a pane that
exists only in the layout store (the 500 path is Rust-unreachable; the
divergence predates this plan). `capture_unknown_pane_still_404s_pane_not_found`
PASSES already (guard pinning the unchanged unknown-pane answer).

- [ ] **Step 3: Add the minimal production implementation**

In `crates/freshell-freshagent/src/lib.rs`, replace the `panes`-map miss arm
(`:2432-2443`):

```rust
    let pane = match state
        .panes
        .lock()
        .expect("panes mutex")
        .get(&pane_id)
        .cloned()
    {
        Some(pane) => pane,
        None => return fail_json(StatusCode::NOT_FOUND, "pane not found".to_string()),
    };
```

with:

```rust
    let pane = match state
        .panes
        .lock()
        .expect("panes mutex")
        .get(&pane_id)
        .cloned()
    {
        Some(pane) => pane,
        None => {
            // Layout-only panes (e.g. a legacy `agent-chat` pane normalized to
            // `fresh-agent` by a remote client's layout sync): mirror the Node
            // capture route's pane-kind gate (router.ts:942-946) — every
            // non-terminal layout kind answers the 422 validation wording the
            // `content_panes` branch in terminal_tabs.rs already emits, rather
            // than falling through to an unhandled 500 (Node, pre-fix) or a
            // misleading 404. Runtime-backed fresh-agent panes resolved above;
            // layout-visible terminal kinds and unknown ids keep 404
            // `pane not found`.
            if let Some(snap) = state.layout.get_pane_snapshot(&pane_id) {
                if let Some(kind) = snap.kind.as_deref().filter(|k| *k != "terminal") {
                    return fail_json(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        format!(
                            "pane kind \"{kind}\" does not support capture-pane; use screenshot-pane"
                        ),
                    );
                }
            }
            return fail_json(StatusCode::NOT_FOUND, "pane not found".to_string());
        }
    };
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent capture_`

Expected: PASS (every selected capture test, including the two new ones).

- [ ] **Step 5: Refactor while green**

No refactor needed: the new arm reuses the verbatim message wording already
duplicated between `terminal_tabs.rs:2490-2508` and Node's generic gate; a
third call site does not yet justify a shared constant across the two
dispatch layers (the arm depends on `state.layout` while the `content_panes`
branch does not).

- [ ] **Step 6: Run impacted-test verification**

Impacted set: all capture/send-keys/wait-for route tests in this crate plus
the layout-store suites (the handler now reads the layout store on the miss
path, and the test module grew):
`cargo test -p freshell-freshagent` (whole crate — it is the crate under test
and the capture tests live in two of its modules).

Then the two QA-gate Rust checks scoped to the touched workspace:

Run: `cargo fmt --all --check`
Run: `cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings`

Expected: PASS every command. (`cargo fmt` must be run as `cargo fmt --all`
first — i.e. APPLY formatting — if the check reports a diff; re-verify after.)

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/src/terminal_tabs.rs
git commit -m "fix(freshagent): 422 pane-kind gate for layout-only capture panes"
```

### Task 3: Oracle verification — passing kata e2e spec on the local e2e backend

**Files:**
- Create: none
- Modify: none
- Test: `test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts`
  (existing kata oracle; no edits — the work item judged the test correct and
  the server buggy)

**Interfaces:**
- Consumes: Task 1's Node fix and the production build of the Node server
  (the e2e fixture spawns the built server entry with an isolated HOME).
- Produces: evidence that the exact pinned expectation at spec line 420 —
  `GET /api/panes/pane-legacy-agent/capture` → `422` +
  `message stringContaining('pane kind "fresh-agent"')` — passes end to end.

- [ ] **Step 1: Build the production server and client**

Run: `npm run build`

(Executing from this worktree; the `npm run build` production-server guard
does not apply to a worktree whose `.env`-configured port has no production
server.)

Expected: build succeeds (`typecheck:client` + `vite build` + `tsc -p
tsconfig.server.json`).

- [ ] **Step 2: Run the kata oracle spec on the local e2e backend**

Run: `bash scripts/e2e-cloud.sh run --local --project=chromium test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts`

(`FRESHELL_E2E_BACKEND` is unset on this host; the documented default is the
local backend, and selecting it explicitly with `--local` is the safe,
reversible default.)

Expected: PASS — all tests in the spec, including `'normalizes remote legacy
layout sync before exposing server pane snapshots'` whose line-420 capture
assertion failed with 500 before Task 1.

- [ ] **Step 3: Evaluate and run the work-source candidate oracle**

The work source supplied `npm run check` as its candidate verification
command. It is plausible and safe for this work item (it is exactly the
repo's canonical Node gate, and the change touches Node server code), so run
it as an extra observation:

Run: `npm run check`

Expected: exit non-zero ONLY with the three baseline-ledger identity failures
(`test/unit/vite-config.test.ts > getNetworkHost > …`), which are
pre-existing on `main` and excluded from this work by the baseline ledger;
zero exit is also an acceptable surprise if the host environment resolves
them. This observation does not replace the full QA gate, which runs the same
command (`darkforge qa` wraps `npm run check` plus the cargo gates) at the
required full-suite gate in the execution stage.

- [ ] **Step 4: Refactor while green**

No production code changes in this task; nothing to refactor.

- [ ] **Step 5: Run impacted-test verification**

The whole plan's impacted set is deliberately re-verified by the adjacent
commands already run in this task (`npm run check` runs the full coordinated
vitest suites; `cargo test -p freshell-freshagent` ran in Task 2; the cargo
fmt/clippy checks ran in Task 2 and re-run unchanged). No additional command.

Expected: PASS (subject to the baseline identity exception for the three
`vite-config` failures).

- [ ] **Step 6: Commit the task**

Nothing to commit — this task produces verification evidence only. If any
incidental fix was required to make the e2e run (it should not be), that fix
would be committed in its own focused commit here with this task named in the
message.

---

## Mandatory self-review

[DONE at authoring time]

1. **Spec coverage:** The work item's required behavior (422 with the exact
   message for the legacy `fresh-agent` capture case, on the pinned e2e) is
   covered by Task 1 (Node status+body), Task 2 (Rust parity), and Task 3
   (the pinned e2e itself). "Check both Node and Rust servers for parity" is
   discharged by Tasks 1+2 with shared message wording. The "do not regress
   runtime-backed capture" constraint is pinned by the pre-existing
   `test/server/agent-api-fresh-agent.test.ts:197-216` (run in Task 1 Step 6)
   and by Task 2's dispatch order (runtime `panes` map checked before the
   layout consult).
2. **No silent deferrals:** No stubs, mocks, or deferred outcomes: the Node
   unit test stubs only the router's existing collaborator boundaries
   (`layoutStore`, `freshAgentRuntimeManager`) exactly like the file's three
   pre-existing tests; the e2e exercises the real built server.  The
   wait-for/send-keys same-pattern hazard is documented as an accepted
   residual, not hidden future work — the work item scopes to capture only.
3. **File and interface consistency:** All paths, line anchors, class names,
   and signatures were read from the tree at authoring time
   (`explorer report: <logs_dir>/reports/plan-capture-validation.md` plus
   direct reads). `ClaudeFreshAgentHistoryResolutionError` constructor/code —
   (`history-service.ts:54-62`); `PaneSnapshot` fields —
   (`layout_store.rs:208-216`); `get_pane_snapshot` — (`layout_store.rs:656`);
   `update_from_ui` — (`layout_store.rs:235`); test helpers `sync_from`/`leaf`
   — (`layout_store_tests.rs:8-14`), `state_with_registry`/`app`/`get` —
   (`terminal_tabs.rs:2647/2656/2690`).
4. **Executable tests:** Task 1 Step 2 red state verified against the current
   code path (unmapped error → `agentRouteErrorStatus` → 500 at `router.ts:68`).
   Task 2 Step 2 red state verified against current dispatch (`maybe_capture`
   None → `panes` miss → 404 at `lib.rs:2442`). Each test passes after its
   shown implementation: Node via the new instanceof+code branch; Rust via the
   layout consult before 404. Guards (Node 503 mapping, Rust 404 unknown)
   assert pre-existing behavior and must pass both before and after.
5. **Placeholder scan:** No TBD/TODO/generic directions; every command is
   literal; every commit lists exact files.
6. **Operational completeness:** No setup/migration needed (server-side HTTP
   semantics only). Error logging already exists upstream of the routes.
   Nothing here duplicates documented repo process. No docs change (bug fix).
