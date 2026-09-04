# Recovery Offer Excludes Never-Open Sessions — Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Freshell's restore-from-server-memory path (the "Restore N panes from server memory?" recovery offer and its inventory→plan→rebuild pipeline) no longer offers or recreates sessions that were not actually open in the user's tabs; accepting the prompt restores exactly the sessions that were genuinely open, in their original tabs, instead of dumping never-open sessions into the last tab.

### Explicit constraints
- Investigate and fix the restore path itself (the recovery inventory and plan pipeline), not merely the visible symptom.
- Work happens in the dedicated worktree `the-usual/restore-open-sessions-only`; use the repository's coordinated test commands for verification.
- No pull request is created without explicit user approval.

### Accepted tradeoffs and residuals
- None stated.

**Goal:** The recovery offer's ledger-derived rows are only ever sessions whose OWN browser client could not yet have told the server they were closed — everything provably not-open (the 30-day tail of closed fresh-agent panes, natural CLI exits, plain-detach closes, headless REST/MCP rows) is never offered and never dumped into a trailing tab; surviving kill-window rows restore into their original tab.

**Architecture:**
The junk enters server-side: `build_inventory` (`crates/freshell-server/src/recovery_inventory.rs:254-265`) emits as `ledgerOnly` every Bound ledger row unreferenced by the newest-per-client snapshot unions and not live — with no notion of *whose* session it was. Ledger rows survive 30 days and were, before this task's work (including the delta-round-5 retire-on-kill continuation, which made `freshAgent.kill` retire its row `Closed`), retired only by the WS `terminal.kill` path; fresh-agent pane closes, natural CLI exits, plain pane-X closes (`terminal.detach`), and headless REST/MCP binds never retired rows, so every such session accumulated (a live probe measured 301 rows). The client (`build-recovery-plan.ts:62-70`) dumps the bucket into ONE trailing "Recovered sessions" tab, which also becomes the active tab.

Two review rounds established that no aggregate recency heuristic can fix this: a cohort MIN inherits any older surviving client's clock (page reloads mint a new clientInstanceId per session, so stale clocks coexist in ordinary usage), and a cohort MAX drops a lost window's genuine kill-window rows whenever a second window keeps pushing. Parentage is the only exact key, so (**D8**) the ledger learns provenance:

1. **Stamp.** `BindingRow` gains optional `client_instance_id`, `device_id`, `tab_key` (additive serde-optional fields — production-proven compatible: the live store already holds 75 rows of which 72 predate the last optional field, zero quarantined). Connection-scoped lanes stamp them: the WS `hello` learns additive optional `deviceId`/`clientInstanceId` (non-strict on both server sides; no version canary trip), `terminal.create` already carries `tabId` (no wire change; tabKey composes as `deviceId:tabId` exactly like snapshot records), and `freshAgent.create` gains additive optional `tabId`. Conn-less record paths (auto-resume respawn, locator/adoption, rollback fork chains) never invent provenance: both ledger upsert bodies merge keep-when-None so re-binds preserve it. REST/headless lineage rows stay unattributed.
2. **Judge.** `ledgerOnly` keeps a row only when ALL of: it is Bound, unreferenced, not-live; it HAS attribution; its attributed device is the offer's primary device; its attributed client survives the existing A15/A16 selection in that device dir; and `row_time + 7_000 >= newest(parent_client)`, where [final, after delta-r4 + focused-ep4-r4] `row_time = last_attributed_at` — the row's last browser-asserted attribution time, NEVER `updated_at` (conn-less maintenance refreshes it without a browser assertion) and never `created_at` (row-keeping metadata; resolution-time birth for marker-derived rows) — with NO `created_at` fallback for fieldless stamped rows (stamps and the field were introduced together in this branch; a stamped-but-fieldless row can only be an intermediate-branch-build artifact with a possibly invented-late `created_at`, so it is excluded exactly like an unattributed row), and `newest(parent_client)` is the capturedAt of the parent's revision-first winner generation — the same ranking the union composition uses, so the judgment and the offered unions agree by construction; [final after focused-ep4-r5 Finding 3:] within the final revision the winner's capturedAt is the FIRST matching entry on the route's (revision, capturedAt)-descending feed — that revision's capturedAt-max, identical to the union composition's per-client winner key there, so judgment and offered union can never disagree on equal-revision ties (residual recorded below). Unattributed rows and everything failing a clause are never offered (pre-upgrade 301-row tails die in place). Keep-side degenerate check: a kill-window row's bind postdates its parent's last retained push, so it satisfies the rule unconditionally.
3. **Place.** Each kept row carries its `tab_key`; the client joins it into the restored tab whose source `tabKey` matches (the layout join happens at plan time, one dispatch), and the offer lists it under that tab's name. [Amended after delta review round 2:] the server offers a kept row ONLY when its stamped tabKey names an OPEN, non-empty tab in the offered unions; rows without a matching open tab are excluded outright (their original placement is unknowable from retained data), and the trailing "Recovered sessions" tab machinery is removed entirely — nothing is ever restored into a synthetic tab.

**Tech Stack:** Rust workspace crates (`freshell-ws` ledger/protocol/ws dispatch, `freshell-freshagent` provider lanes, `freshell-server` inventory), TS client (protocol types, create payloads, recovery plan/panel), Vitest/Playwright e2e (`test/e2e-browser/specs/recover-my-panes-rust.spec.ts` + `restore-contract-wall-rust.spec.ts`, rust-chromium project).

## Global Constraints

- Work ONLY in `/home/dan/code/freshell/.worktrees/restore-open-sessions-only` on branch `the-usual/restore-open-sessions-only`. Never commit to or push `main`. No PR creation (user approval gate stays with the orchestrator).
- TDD red→green→refactor for every behavior change; never weaken, skip, or delete tests to obtain a green run. A deliberately-flipped contract pin is rewritten to assert the NEW contract, never vacated, and never asserted vacuously (a pin whose scenario cannot produce the junk row pre-fix is a test bug, not a pass).
- Test commands: no raw `npx vitest` — use `npm run test:vitest -- ...`; cargo tests run from the worktree root and are NOT behind the coordinator gate; broad suites only via `npm run check`/`npm test` (coordinator-aware); check the coordinator with `npm run test:status` first and never kill a foreign holder. Broad runs STRIP ambient proxy env (`env -u FRESHELL_BIND_HOST -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy` prefix) — ambient proxy currently breaks 5 stderr-sensitive tests pre-existingly (documented environment flake, not code). Set `FRESHELL_TEST_SUMMARY` for broad runs.
- Rust CI parity: `cargo clippy --workspace --all-targets -- -D warnings` must be clean.
- Never set `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1`. Never restart the live production server (port 3001) or any server this run did not start. E2E servers use the RustServer helper's ephemeral loopback ports only.
- Follow repo comment/doc conventions: comments that describe behavior this change removes must be re-worded to stay truthful (`docs/index.html` and `AGENTS.md` are checked and only touched if they actually describe the old behavior; historical plan docs under `docs/plans/` are never rewritten).
- NEVER weaken Node/Rust protocol tolerance: only additive optional fields on non-strict surfaces (`hello`, `freshAgent.create`); `terminal.create` needs NO new field (its `tabId` already exists) — the strict TerminalCreateSchema stays untouched.
- Commits use the repo's existing git identity; commit messages follow the repo's conventional-commit style.

### Contract supersession note (for reviewers)

`docs/plans/2026-07-26-recover-my-panes.md` D4 defined `ledgerOnly` as "all bound rows referenced by no device union and not live". D8 replaces the blanket rule with the stamped, parent-relative judgment above. Pinned tests encoding the old blanket rule are rewritten — listed by name in Task 3. Deliberate residuals stated honestly:

- A row whose bind raced its own parent's next push (physically under ~one 5s cadence window within that client) keeps the benefit of the doubt, and the SIGKILL-within-5s e2e contract requires keep-side behavior there. Such a row stays Bound and is re-offer-eligible at future storage-loss boots (the user's decline is remembered by contentId dismissal). [Amended after delta review round 5 (the retire-on-kill continuation):] the closed-in-window subclass no longer exists for fresh-agent panes — an explicit `freshAgent.kill` now retires the pane's row `Closed` at kill time (every provider's kill handler, awaited before the killed broadcast), so an explicitly-closed row never survives to be judged in the window; terminal-pane explicit kills already retired (`handle_kill`'s `retire_closed`, trigger (e)). The one remaining keep-in-window case is the pure creation crash-race — the browser died between create/fork/marker-resolution and the next push with NO close event at all — which is indistinguishable from "creation had not completed" by design (per-row open/closed provenance at sub-cadence resolution is not retained by anything), plus natural CLI exits in the window (their rows stay Bound on purpose: Bound-after-natural-exit is load-bearing for auto-resume). Headless rows were never offerable here (the attribution gate drops them). [Amended after focused-episode-5 round 2:] two ordinary close paths could still leave a Bound row — a kill arriving after the sidecar's exit-eviction (the bare placeholder no longer resolved to the durable id, and the round-5 retire set silently missed the durable-keyed row; now the demoted alias tombstones preserve placeholder→durable resolution for kills, TTL'd in-memory) and a kill racing an in-flight binding write (an aborted consumer's orphaned `spawn_blocking` closure could land after both round-5 retire passes; now `retire_closed` folds a durable, TTL'd kill tombstone into the ledger and the ONE fresh-agent binder choke point `record_fresh_agent_binding` consults it under the same index guard — the write suppresses itself, or force-retires a stale Bound remnant, by consulting state instead of task-abort ordering). The tombstone's lifecycle exit is pinned: an explicit resume/attach of the killed identity (the only GENUINE CLAIM lanes) clears it before that claim's own binding write.
- A pane whose parent client left NO retained generation at all (its very first boot died before its WS-ready push reached the server, or its generations were count-cap-evicted after a reload storm) is not offered — undecidable from retained data.
- Rows bound before this change ships (no stamped provenance) and rows from REST/MCP lanes (unattributable — no client connection exists at bind time) are never offered via `ledgerOnly`. Anything pre-upgrade that WAS genuinely open is in snapshot unions anyway (referenced → restored through the layout path, not the bucket). REST/MCP-orchestrated panes that DO appear in a user's browser become referenced by that browser's pushes within one cadence; the only unrecoverable case is the conjunction (REST/MCP create → server dies within ~5s before any push → AND a storage-loss boot) — documented, with the adopable-fix noted (a browser-side adopt/re-bind with connection context would stamp such rows through the replace rule).
- [Amended after delta review round 2:] when a kept row's original tab vanished from all retained evidence (the whole tab was created and lost inside the sub-cadence window), the row is EXCLUDED — no retained data can name its tab, and restoring it anywhere else would recreate the dump-into-another-tab behavior the user reported. The trailing tab machinery is deleted.
- After this lands, a previously-dismissed offer's `contentId` changes once; a dismissed offer may re-appear at most once.
- [Added after delta-r4:] `row_time` is the row's last browser-asserted attribution time (`last_attributed_at`), never `updated_at` and never `created_at`; [added after focused-ep4-r4:] with NO `created_at` fallback for a stamped-but-fieldless row (stamps and the field were introduced together in this branch — a fieldless stamped row is an intermediate-branch-build dev artifact whose `created_at` can be invented late, so it is excluded exactly like an unattributed row).
- [Added after focused-ep4-r4:] the parent's evidence clock is the freshest assertion of its final revision, not a capturedAt-max over the retained entries at that revision — with monotone clocks nothing changes outside a backward-step window. [Superseded in the equal-revision tie-break after focused-ep4-r5 Finding 3:] the key within the final revision is the FIRST matching entry on the route's (revision, capturedAt)-descending feed — that revision's capturedAt-max, identical to the union's `newest_per_client` winner key, so the judgment and the offered union can never disagree about the parent's clock (the r4 rule kept the LAST array entry — the run's LOWEST stamp on that feed — and the two disagreed by construction for re-delivered same-revision sets). A greater revision still wins outright, so across a backward wall-clock step the client's first REAL post-step push (revision-bumping) re-keys the clock immediately, and the r4 keep-side extension is unchanged from there on (a row within grace of the post-step stamp keeps until post-step pushes outrun row_time + 7s). The remaining skew residual: within ONE revision during the jump, a retained pre-step entry holds the key HIGH (union-consistently) until that push lands — a row judged in the window can be dropped up to the skew magnitude EARLIER than the parent's true freshest assertion would allow.
- [Added after focused-ep4-r5 Finding 1:] a legacy client (an older WS build whose `freshAgent.create`/`freshAgent.fork` omits the additive/optional `tabId`) still ATTACHES its provenance at create/fork/marker-resolution when no prior attribution exists — client+device+the assertion time, tab `None`; the full-triple+monotonic gate applies only to ADVANCING an existing attribution. CEILING for legacy clients: such an attached-but-tab-less row is still never offered — the placement clause (unchanged) requires the stamped tabKey to name an OPEN, paned tab in the offer's union, and no retained data can name it.
- [Added after focused-ep4-r5 Finding 2:] a `Clear` provenance write (the explicitly-headless lanes) erases the identity stamps but RAISES the attribution-floor clock to `max(existing, clear_now)` instead of erasing it, so a delayed pre-Clear assertion can never pass a no-prior-attribution arm and resurrect the cleared stamps (the row stays unofferable while its stamps are `None` — the judgment gates on the stamps first). Residual: the row-side monotonic compare is wall-clock, like the evidence-side clock — after a backward server-clock step a genuinely-later assertion can compare as older and be rejected for up to the skew magnitude (until real time outruns the stored value). No sequence counter is built for either side; the skew magnitude is the accepted bound.

---

### Task 1: E2E contract pin — a stale never-open session never reaches the inventory's ledgerOnly or the offer

**Files:**
- Modify: `test/e2e-browser/specs/recover-my-panes-rust.spec.ts` (extend the shared `beforeAll` seed/env; copy the freshclaude donor helpers per the file's per-spec-ownership convention; append ONE scenario LAST in the existing serial describe)

**Interfaces:**
- Consumes: existing spec helpers (`installFakeCli`, `seedConfig`, `selectShellIfPickerShowing`, `connect`, `openFreshContextWithOffer`, `waitForSnapshotContaining`, `waitForRecoverable`, `readArgvLog` idioms) plus helpers copied from `test/e2e-browser/specs/hidden-pane-rebind-rust.spec.ts`: `createFreshclaudePane` (:153-182), the `findFreshAgentLeaf` walker (:118-128), and the `connection/setAvailableClis` dispatch + durable-UUID poll idioms (:159-164, :311-318) — all re-verified unchanged at the rebased base (validator-v8).
- Producer recipe (validator-proven; reports/load-bearing-validator-v1-recipe.md): a freshclaude pane split beside the boot shell pane, closed via the PLAIN pane-X, leaves its pane-ledger row Bound (the fresh-agent identity sink has NO retire method — `crates/freshell-freshagent/src/identity_sink.rs:46-72`; `retire_closed`'s only caller is WS `terminal.kill`, re-verified at the rebased base) and unreferenced after the client's next push. Fallback if and only if the primary is blocked (never silently substitute): recipe (b) natural-exit claude pane via SIGTERM to the argv-log pid with `FRESHELL_AUTO_RESUME_MAX_CYCLES=0` in the shared env + plain-X close (validator report lines 384-391); see the implementer brief for the full safety gates.

- [ ] **Step 1: Write the failing behavioral test**

1. Suite `beforeAll` amendments (inert for scenarios 1-4 — nothing in them issues a fresh-agent create, and `FRESHELL_CLAUDE_SIDECAR` is read only at freshclaude sidecar spawn):
   - `seedConfig()` (:66-82): add `"freshAgent": { "enabled": true }` beside `codingCli.enabledProviders` (donor shape: hidden-pane-rebind :84-96).
   - Env (:311-312): add `FRESHELL_CLAUDE_SIDECAR: path.resolve(__dirname, '../fixtures/fake-claude-sidecar.mjs')` and `FAKE_CLAUDE_SIDECAR_LOG: path.join(sharedRoot, 'claude-sidecar-requests.jsonl')`.
   - Copy in (per-spec-ownership header convention): `createFreshclaudePane`, `findFreshAgentLeaf`, and the durable-UUID poll idiom from hidden-pane-rebind.
2. Append the scenario LAST in the existing serial describe, with `test.setTimeout(240_000)` (budget: 15s timing-gate wait + <=120s generation poll + restart + two boots):

```ts
test('stale never-open ledger rows are never offered', async ({ browser, e2eServerKind }) => {
  expect(e2eServerKind).toBe('rust')
  test.setTimeout(240_000)
  // 1. Re-base the evidence base: earlier scenarios' clients hold frozen
  //    generations whose clocks would co-survive selection with this scenario's
  //    junk row's parent. No client is connected at this point in the serial
  //    suite, so wiping the generation store is safe; this scenario's own
  //    context rebuilds the evidence (and keeps the offer recoverable via the
  //    surviving shell tab).
  await fs.rm(path.join(capturedHome, '.freshell', 'tabs-snapshots'), { recursive: true, force: true })
  // 2. Context A: boot shell pane, then SPLIT a freshclaude pane beside it
  //    (never close a tab's only pane — that collapses to closeTab, whose
  //    closed-tab record would re-reference the row forever).
  //    ctxA = browser.newContext(FRESH_CONTEXT_OPTIONS); connect(pageA, info);
  //    selectShellIfPickerShowing(pageA); expect .xterm visible.
  //    markerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'junk-freshclaude-'))
  //    await createFreshclaudePane(pageA, harnessA, markerDir)
  // 3. Acquire SESSION_ID via the harness poll (sessionRef/resumeSessionId
  //    durable-UUID regex idiom), disk-wait the binding row
  //    <capturedHome>/.freshell/pane-ledger/bindings/claude/<SESSION_ID>.json
  //    and read bindMs (row JSON createdAt — serde camelCase).
  // 4. Prove it WAS snapshot-open: await waitForSnapshotContaining([SESSION_ID]).
  // 5. Timing gate: bounded-wait until Date.now() >= bindMs + 15_000, THEN
  //    close — the final post-close push (lands within one 5s tick) then stamps
  //    capturedAt > bindMs + 14_000 deterministically, strictly past the 7s
  //    grace (post-fix: parent's newest > row_time + grace => dropped).
  // 6. Close via the PLAIN pane-X — never shift+close, never the Stop button
  //    (terminal.kill would retire the row and vacate the pin):
  //    pageA.locator("[data-pane-id][data-context='pane']:has([data-context='fresh-agent']) button[title='Close pane']").click()
  //    (shell sibling keeps the tab alive; closePane, not closeTab, fires).
  // 7. Evidence-advance: poll the newest generation per client under
  //    <capturedHome>/.freshell/tabs-snapshots/ (ranking idiom generalized to
  //    every device dir) until for EVERY client the newest generation has
  //    capturedAt > bindMs + 14_000 AND its content does not contain SESSION_ID
  //    (timeout 120s).
  // 8. await ctxA.close(); await waitForRecoverable(info) (file's close→restart
  //    discipline parity); info = await server.restart()  (reassign info).
  // 9. RED/GREEN inventory assertion via a STANDALONE probe — never page.request,
  //    never a navigated page (it would register as a tabs.sync client):
  //    const req = await request.newContext({ baseURL: info.baseUrl,
  //      extraHTTPHeaders: { 'x-auth-token': info.token } })
  //    const body = await (await req.get(
  //      '/api/recovery/inventory?clientInstanceId=freshell-test-probe&bootAgoMs=0')).json()
  //    await req.dispose()
  //    expect(body.ledgerOnly.every((e) => e.sessionId !== SESSION_ID)).toBe(true)
  //    (membership-absence, NOT emptiness — other legit rows may exist)
  // 10. Offer assertion (the panel renders ledgerOnly rows as
  //    "{mode} session — {cwd}", never the sessionId, so the marker cwd
  //    discriminates): const { ctx: ctxB, page: pageB } =
  //    await openFreshContextWithOffer(browser, 'junk-exclusion')
  //    const panel = pageB.getByTestId('recovery-offer-panel')
  //    await expect(panel.locator('ul li', { hasText: 'junk-freshclaude-' })).toHaveCount(0)
  // 11. Do NOT click accept on the junk-account alone: with the bucket empty of
  //    this row there is no junk tab to form (Task 4 pins that surviving rows
  //    join their original tab and that [as-executed] any row without a
  //    matching open tab is excluded instead of forming a synthetic tab).
  // 12. await ctxB.close() (finally-style cleanup consistent with the file).
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/recover-my-panes-rust.spec.ts -g 'stale never-open ledger rows'`

Expected: FAIL — step 9's probe assertion trips because the stale row IS in `ledgerOnly` today (and step 10's list assertion would trip on the rendered `junk-freshclaude-` marker line). A failure from the row being retired (wrong close affordance), from the offer not appearing, or from timing is NOT acceptable red: iterate the recipe until the failure is exactly "stale row present".

- [ ] **Step 3: Minimal production implementation**

None in this task — the pin lands RED against the unfixed server by design; Task 3 turns it green.

- [ ] **Step 4: Run the focused test**

Same command as Step 2. Expected: FAIL (the pinned red). Record the failure output excerpt in the implementer report as the RED evidence for Task 3's green.

- [ ] **Step 5: Refactor while green**

No green refactor here; ensure the scenario matches the file's conventions (helper reuse, comment style, serial ordering — it MUST remain LAST in the describe so the evidence wipe cannot corrupt earlier scenarios' assertions).

- [ ] **Step 6: Run impacted-test verification**

The scenario is additive; the beforeAll seed/env additions must be proven inert for the earlier scenarios:

Run: `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/recover-my-panes-rust.spec.ts`

Expected: scenarios 1-4 PASS; ONLY the new scenario FAILS (the pinned red, recorded in the progress ledger as intentional red-until-Task-3). Any broad suite is NOT run at this stage.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/recover-my-panes-rust.spec.ts
git commit -m "test(recovery): pin that stale never-open ledger rows are never offered

Red e2e contract pin: the recovery inventory's ledgerOnly bucket (and the
recovery offer built from it) currently includes Bound ledger rows from
sessions that were not actually open when their client's newest snapshot
evidence was captured (freshAgent.kill closes, natural exits, headless
REST/MCP rows) — they get dumped into a trailing 'Recovered sessions' tab.
This scenario asserts the new contract (D8 stamped, parent-relative
judgment); it is RED until the server-side filter lands."
```

---

### Task 2: Ledger provenance — stamp client/tab identity on every connection-scoped bind lane

**Files:**
- Modify: shared wire types — `shared/ws-protocol.ts` (hello type + `freshAgent.create` optional `tabId`), `crates/freshell-protocol/src/client_messages.rs` (`Hello` gains optional `device_id`/`client_instance_id`, serde-optional)
- Modify: `src/lib/ws-client.ts` (hello payload stamps `getCurrentTabRegistryClientInstanceId()` + deviceId) and `src/components/fresh-agent/FreshAgentView.tsx` `buildCreateMessage` (:1207-1226, add `tabId`)
- Modify: `crates/freshell-ws/src/lib.rs` handshake (:639-652) + the WS connection state (store the per-connection `(deviceId, clientInstanceId)` where `tabs.sync` push handling already resolves them — `terminal.rs` `:651/:671-678` region)
- Modify: `crates/freshell-ws/src/pane_ledger.rs` (`BindingRow` + `BindingWrite` gain the three optional stamp fields; BOTH upsert bodies merge keep-when-None for them), `crates/freshell-freshagent/src/*` + `crates/freshell-server/src/identity_sink.rs` (`FreshAgentBindingWrite`/`FreshAgentBindingUpsert` gain the fields; sink maps them)
- Modify: fresh-agent creation threading — the WS `freshAgent.create` dispatch (`terminal.rs:976-1005` region) carries the connection identity down the provider `handle_create` chain so the identity-sink writes are stamped (`claude.rs`, `codex.rs`, `opencode_ws.rs` runtimes)
- Modify: `crates/freshell-ws/src/terminal.rs` `handle_create` bind sites (:3394/:3713 — stamp from connection identity + message `tabId`), the auto-resume respawn site (:4379 — passes nothing; merge keeps it), the resolution hook (:1065 area + callers) — merge keeps prior stamps
- Modify: `crates/freshell-ws/src/pane_identity_binder.rs` (the binder helper: stamps nothing for REST lineage — these rows stay unattributed by design; comment the why) and the REST cold-start materialization call site in `crates/freshell-freshagent/src/lib.rs` (:2288-2309 region, agent-materialization binder — comment parity)
- Test: `crates/freshell-ws/src/pane_ledger_tests.rs` (stamp/merge/compat matrix)

**Interfaces:**
- Consumes: clientInstanceId getter (`src/store/tabRegistrySync.ts:53`), deviceId from the client registry slice, tab id in scope at both create paths; connection id (`conn_id`) in scope at every WS bind site.
- Produces: `BindingRow{..., client_instance_id: Option<String>, device_id: Option<String>, tab_key: Option<String>}`; stamping lanes listed above; merge-keep-when-None semantics in both upsert bodies for exactly these fields (all REPLACES-advisory-fields behavior elsewhere untouched).

- [ ] **Step 1: Write the failing behavioral tests (ledger-layer)**

In `crates/freshell-ws/src/pane_ledger_tests.rs` add:

```rust
#[test]
fn bind_stamps_provenance_and_rebind_without_provenance_preserves_it() {
    // write with stamps; rebind same identity with stamps=None (respawn-fail
    // shape); assert the row keeps every original stamp; assert updated_at
    // advanced, created_at preserved.
}

#[test]
fn rebind_with_newer_provenance_replaces_it() {
    // an adoption/fork lane that KNOWS newer identity replaces the stamps.
}

#[test]
fn legacy_row_without_stamps_reads_back_with_none_provenance() {
    // hand-craft the pre-D8 JSON shape (no stamp keys) in a temp dir; boot the
    // ledger; assert Some state, None stamps, zero quarantine.
}
```

Plus the LANE-REACH matrix (review-round-3 requirement — schema fields being optional means a lane could silently keep writing `None`, and Task 3 would then DROP that provider's genuinely-open sessions; every lane must prove its stamps arrive):
- WS terminal.create lane: extend (or add beside) the trigger-test idiom in `crates/freshell-ws/tests/pane_ledger_triggers.rs` driving a create over a real test WS connection with stamped hello identity + `tabId`, then assert the row's `clientInstanceId`/`deviceId`/`tabKey`.
- Fresh-agent sink lanes, one per provider family (`freshclaude`, `freshcodex`, `freshopencode`): in the freshagent crate's existing fake-sidecar test harness, drive a create and assert the sink upsert reaching `record_fresh_agent_binding` carries the stamps (follow each provider's existing identity-event test idiom).
- Inheritance: conn-less re-bind via the shared resolution hook keeps prior stamps (already in the merge matrix above), and an adoption lane that KNOWS newer identity replaces them.

Plus sink-level coverage near `crates/freshell-server/src/identity_sink.rs` tests if that file has a test module (follow its idiom): `FreshAgentBindingUpsert` carries the stamps into `record_fresh_agent_binding`.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-ws pane_ledger`

Expected: FAIL — the stamp fields do not exist yet (compile-era failure is acceptable red for schema work ONLY at this step; the behavioral assertions must then fail/pass on field behavior, not compilation).

- [ ] **Step 3: Add the minimal production implementation**

Implement the schema fields, the merge-keep-when-None rule in both upsert bodies, the wire type additions (hello + freshAgent.create `tabId`), client senders (hello, freshAgent create), the connection-identity store, the WS/fresh-agent stamping lanes, and the REST binder's intentional non-stamp comment. Keep every existing call compiling — stamp parameters are `Option` and additive; no existing message shape changes for `terminal.create`.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-ws pane_ledger && cargo test -p freshell-freshagent`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Check field naming against the row's existing camelCase serde convention (`clientInstanceId`, `deviceId`, `tabKey` on the wire/JSON; snake in Rust), and the merge rule reads identically in both upsert bodies. Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

No fallback-chained commands here — each line must pass on its own so a failure can never be masked:

```bash
cargo test -p freshell-ws
cargo test -p freshell-freshagent
cargo test -p freshell-server recovery_inventory
npm run test:vitest -- run test/unit/client/store/tabRegistrySync.test.ts
npm run test:vitest -- run test/unit/server
npm run typecheck
```

Expected: PASS (the inventory still ignores the new fields — Task 3 consumes them; typecheck covers the client wire types; the two vitest commands cover the hello/sender and server-protocol paths — if a command matches no files, record that in the report and run the nearest broader file list instead).

- [ ] **Step 7: Commit the task**

```bash
git add shared/ws-protocol.ts crates/freshell-protocol/src/client_messages.rs src/lib/ws-client.ts src/components/fresh-agent/FreshAgentView.tsx crates/freshell-ws/src/lib.rs crates/freshell-ws/src/pane_ledger.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/src/pane_ledger_tests.rs crates/freshell-ws/src/pane_identity_binder.rs crates/freshell-server/src/identity_sink.rs crates/freshell-freshagent/
git commit -m "feat(ledger): stamp binding rows with client/tab provenance (D8 groundwork)

BindingRow gains optional clientInstanceId/deviceId/tabKey, stamped by
connection-scoped bind lanes (hello now carries deviceId/clientInstanceId;
terminal.create's tabId composes the tabKey; freshAgent.create gains an
optional tabId). Conn-less re-bind lanes (respawn, locator/adoption, fork
chains) inherit stamps: both upsert bodies merge keep-when-None for exactly
these fields. REST/headless lineage rows intentionally stay unattributed —
they were never open in a tab, and the D8 offer rule will lean on that."
```

---

### Task 3: Parent-relative offer judgment (+ comment truthfulness)

**Files:**
- Modify: `crates/freshell-server/src/recovery_inventory.rs` (selection layer surfaces per-client revision-first-winner capturedAt for surviving clients; `read_foreign_unions` returns per-device maps; `build_inventory` judges each row against its stamped parent; D8 constant + comments + debug line)
- Modify: `crates/freshell-server/src/recovery_inventory_tests.rs` (contract rewrite — listed below)
- Modify: `crates/freshell-ws/src/pane_ledger.rs:668-676` (`delete_binding` doc comment)
- Modify: `crates/freshell-ws/src/terminal.rs:3446-3464` (spawn-failure comment)
- Modify: `crates/freshell-ws/src/pane_ledger_tests.rs:494` area (comment)
- Modify: `crates/freshell-ws/tests/pane_ledger_triggers.rs:124` area (comment)

**Interfaces:**
- Consumes: the stamps from Task 2 (`BindingRow.client_instance_id/device_id/updated_at/created_at`); the selection layer's per-client survivor predicate (`recovery_inventory.rs:35-61`); `generation_rank` revision-first ordering (`crates/freshell-ws/src/tabs_persist.rs:129-140`) so each client's newest is its union-WINNER generation's capturedAt.
- Produces (additive; response shape gains only optional fields later consumed by Task 4):
  - `const UNSNAPSHOTTED_BINDING_GRACE_MS: u64 = 7_000;` (one 5s diff-push cadence + 2s slack; both stamps are server-clock)
  - Selection struct: selected generation ids + per-surviving-client winner capturedAt for that device dir.
  - `read_foreign_unions` returns `(Vec<DeviceUnion>, Vec<(String, Vec<(String, u64)>)>)` — unions plus per-device (device_id -> [(client_instance_id, winner_capturedAt)]) evidence maps.
  - `build_inventory(device_unions, bindings, live_session_keys, evidence: ...)` — after `primary_idx`, the judgment per row: attributed? device == primary? client present in the primary map? `row_time + grace >= map[client]`?
  - `ledgerOnly` row JSON gains optional `tabKey` (forwarded from the stamp) for Task 4's join.

- [ ] **Step 1: Write the failing behavioral tests (unit + route contract rewrite)**

In `recovery_inventory_tests.rs` (fixture builders `union_doc` :20-26 / `binding_row_at` :54-81 exist; rows now need attribution knobs — extend the fixture builder minimally). The D8 matrix:

```rust
#[test]
fn attributed_row_within_grace_of_its_parent_is_offered() {
    // parent client "c1" on primary "d1", winner capturedAt = 1_000_000;
    // row stamps (c1,d1), updated_at = 993_000 (== 1_000_000 - 7_000) => KEPT.
}

#[test]
fn attributed_row_before_its_parents_evidence_is_dropped() {
    // same but updated_at = 992_999 => dropped; recoverable false when it was
    // the only candidate.
}

#[test]
fn unattributed_rows_are_never_offered() {
    // THE USER'S BUG CLASS: Bound, unreferenced, not live, NO stamps
    // (headless REST/MCP + every pre-upgrade row) => never in ledgerOnly.
}

#[test]
fn row_attributed_to_a_non_primary_device_is_dropped() {
    // stamps point at "d0" while "d1" is primary => dropped even though d0's
    // client has retained evidence. (Review-round-1 cross-device pin, now in
    // parent-relative form.)
}

#[test]
fn row_whose_parent_client_left_no_surviving_evidence_is_dropped() {
    // stamps name a client absent from the surviving set (evicted/capped) => dropped.
}

#[test]
fn backward_clock_step_cannot_drop_a_kill_window_row() {
    // REVIEW-ROUND-2 ranking pin: parent "c1" has rev1@capturedAt=1_000_000 and
    // rev2@capturedAt=900_000 (clock stepped back); the union winner is rev2,
    // so the judgment uses 900_000; row stamped c1 with updated_at=900_100 is KEPT.
}
```

Route contract rewrite: `route_serves_ledger_only_recovery_without_snapshots` (:514-536) → new contract: one unattributed Bound row, plus (second case) one attributed row whose parent has no snapshot content => 200 with `recoverable == false`, `device == null`, `ledgerOnly == []`. NEW route-level positive: one generation for client c1 (write via the existing snapshot-write helper; fields per validator V4: deviceId/clientInstanceId/serverInstanceId/deviceLabel/capturedAt/snapshotRevision/records with status "open") + an attributed row (stamps c1) with `updated_at = CAP - 5_000` => offered, recoverable, and the row JSON carries `tabKey`.

KEEP behaviorally, passing evidence maps that preserve each test's meaning: `bound_row_referenced_by_non_primary_device_is_not_ledger_only` (:234 — the cross-device REFERENCED rule is unchanged and orthogonal), `live_effective_ref_marks_pane_live_and_live_rows_never_ledger_only` (:267), the empty-bucket asserts (:145, :195), and `:308` (evidence aligned per its fixture). `content_id_is_stable_and_input_sensitive` (:300-306) repair: both fixtures' rows attributed and within-grace of their parents => `assert_ne` stays non-vacuous. All other `build_inventory` call sites (~12): evidence maps preserving current meaning; record per-site choices in the implementer report.

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `cargo test -p freshell-server recovery_inventory`

Expected: FAIL — the new judgment-matrix and route rewrites trip on the blanket bucket / pre-map signatures; the within-grace keep-test passes already.

- [ ] **Step 3: Add the minimal production implementation**

In `crates/freshell-server/src/recovery_inventory.rs`:

1. Selection: `select_foreign_recent_generation_ids` additionally surfaces, per surviving client, the capturedAt of its REVISION-FIRST-winner generation (apply the same `generation_rank` ordering the union path uses; struct return per the file's idiom). `read_foreign_unions` aggregates the per-device evidence maps; route passes them in.
2. `build_inventory`:
   - `const UNSNAPSHOTTED_BINDING_GRACE_MS: u64 = 7_000;` with the D8 comment: stamped rows judged against their own parent; unattributed rows (headless / pre-upgrade) never offered [and, after focused-ep4-r4: stamped rows lacking `last_attributed_at` are never offered either]; grace is one push cadence (+2s) within the parent; kill-window binds postdate the parent's last push, so they keep unconditionally; the parent's newest uses the union's revision-first winner [and, after focused-ep4-r4, that winner's capturedAt is the LAST final-revision entry in push order, the freshest assertion], so judgment and offered unions can never disagree about which generation is newest.
   - After `primary_idx`, resolve the primary device's evidence map, and give the `ledger_only` chain (:254-265) the judgment:

```rust
.filter(|r| {
    let (Some(client), Some(device)) =
        (r.client_instance_id.as_deref(), r.device_id.as_deref()) else {
        return false; // D8: unattributed (headless/pre-upgrade) rows are never offered
    };
    let Some(primary) = ... else { return false };   // no primary device => no evidence at all
    if device != primary_device_id { return false; }
    let Some(parent_newest) = primary_map.get(client) else { return false };
    // [Final, after delta-r4 + focused-ep4-r4:] the judgment key is the row's
    // last browser-asserted attribution time ONLY — a stamped-but-fieldless row
    // is excluded exactly like an unattributed one (no `created_at` fallback;
    // stamps and the field were introduced together in this branch, so
    // fieldless stamped rows are intermediate-branch-build artifacts whose
    // `created_at` can be invented late).
    let Some(attributed_at) = r.last_attributed_at else { return false };
    let row_time = attributed_at.max(0) as u64;
    row_time.saturating_add(UNSNAPSHOTTED_BINDING_GRACE_MS) >= *parent_newest
})
```

   - `ledgerOnly` row JSON gains `tabKey` (forwarded). After the filter, the observability line (counts + primary presence, never payloads):

```rust
tracing::debug!(target: "freshell_server::recovery_inventory",
    dropped, primary = primary_device_id.is_some(), "D8 excluded stale/unattributed ledger rows");
```

3. Re-word the four staleness-affected comments (the four files listed above): ghost rows can now only surface within the parent's own grace window (and never if unattributed); the durable-ledger truthfulness rationale stays. Delete NOTHING — comments only.
4. Docs sweep (record in report): `rg -n 'ledgerOnly|recovery inventory|Recovered sessions' docs/ README.md AGENTS.md` — edit only files that document the old blanket behavior (expected: none).

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-server recovery_inventory`

Expected: PASS.

Then confirm Task 1's red pin turns green:

Run: `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/recover-my-panes-rust.spec.ts -g 'stale never-open ledger rows'`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Coherence pass over the judgment block (naming, ordering vs A4/D7 filters); no dead imports; struct names match file conventions. Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

```bash
cargo test -p freshell-server
cargo test -p freshell-ws
cargo test -p freshell-freshagent
cargo clippy --workspace --all-targets -- -D warnings
npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/restore-contract-wall-rust.spec.ts -g 'SIGKILL-within-5s'
npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/recover-my-panes-rust.spec.ts
npm run test:vitest -- run test/unit/client/lib/recovery test/unit/client/components/RecoveryOfferPanel.test.tsx test/unit/client/components/RecoveryOfferPanel.persisted-boot.test.tsx
npm run typecheck
npm run lint
```

Expected: all PASS. Wall note: a kill-window row keeps unconditionally (its bind postdates its parent's last retained push), and if the old page's reconnect push lands first it re-references the pane into the union — either way the two-path poll stays green; if the offer never appears, the judgment mishandled frozen evidence — fix the filter, never the pin's intent.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-server/src/recovery_inventory.rs crates/freshell-server/src/recovery_inventory_tests.rs crates/freshell-ws/src/pane_ledger.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/src/pane_ledger_tests.rs crates/freshell-ws/tests/pane_ledger_triggers.rs
git commit -m "fix(recovery): offer only parent-evidenced ledger rows (D8)

The recovery inventory offered every Bound ledger row referenced by no
snapshot union and not live, dumping a 30-day tail of never-retired
bindings (closed fresh-agent panes, natural exits, detach closes,
headless REST/MCP rows) into a trailing 'Recovered sessions' tab.

With provenance stamped (clientInstanceId/deviceId/tabKey), a row is now
offered only while its OWN parent's evidence cannot yet have observed its
absence: attributed, on the offer's primary device, its client surviving
selection, and row_time within 7s of the parent's newest retained
(revision-first-winner) generation. Unattributed rows are never offered.
Kill-window rows (SIGKILL-within-5s contract) keep unconditionally."
```

---

### Task 4: Placement — restored rows join their original tab; offer lists them under it

**Files:**
- Modify: `src/lib/recovery/types.ts` (`LedgerOnlyEntry` gains optional `tabKey`)
- Modify: `src/lib/recovery/build-recovery-plan.ts` (per-tab plans record `sourceTabKey`; join logic at leaf-list time before `chain()`; kept `ledgerOnly` rows join their matching restored tab — geometry: rightmost leaf of the right-leaning chain, matching the plan's existing chain convention; [as-executed amendment] rows without a join target are NOT placed and no trailing tab is built — the server excludes them upstream)
- Modify: `src/components/RecoveryOfferPanel.tsx` (render joined rows inside their tab's list section using the same `{tab.tabName}: {mode} — {cwd}` line format as device panes; [as-executed amendment] the flat trailing-row rendering was removed with the trailing tab)
- Test: `test/unit/client/lib/recovery/build-recovery-plan.test.ts` (join matrix: matching-tab join; [as-executed amendment] unmatched/missing tabKey rows produce no junk tab; mixed cohort; `countRecoverablePanes` unchanged totals)
- Test: `test/e2e-browser/specs/restore-contract-wall-rust.spec.ts` (extend the tail of `SIGKILL-within-5s-of-pane-creation` (:1799-1912) with an UNCONDITIONAL placement proof: the existing two-path poll's auto-restore branch is unreachable in this scenario — the init script clears storage before navigation, so the boot has no persisted layout to auto-restore FROM; the offer is the only reachable evidence. The tail therefore hard-expects the offer visible (`getByTestId('recovery-offer-panel')`), clicks `recovery-accept`, and asserts (a) the restored claude pane lands in the SAME restored tab as the shell pane — walk `state.panes.layouts` for the restored tab(s) and compare tab membership via the harness — and (b) NO tab titled 'Recovered sessions' exists. If the offer ever does NOT appear here, that is a regression in kill-window keep behavior — fail loud, never skip the tail)

**Interfaces:**
- Consumes: Task 3's `ledgerOnly[*].tabKey`; `RecoveryTab.tabKey` already in types (:28); `RecoveryOfferPanel.accept` loop unchanged (one dispatch per tab plan; `restoreLayout` no-ops on pre-existing layouts — the join MUST happen at plan time).
- Produces: `RecoveryTabPlan` gains `sourceTabKey?: string` (internal to the plan/panel pair — not a server contract); joined `PaneNode` leaf built by the same `paneContent` path as today (`armRecoveredTerminalRestores` works unchanged).

- [ ] **Step 1: Write the failing behavioral tests**

Extend `build-recovery-plan.test.ts`: device tab with tabKey `d1:t1` + one `ledgerOnly` row stamped `tabKey: "d1:t1"` → the restored plan for `d1:t1`'s tab contains BOTH the union panes and the joined row (assert leaf count + the joined leaf's sessionRef); [as-executed amendment] rows stamped to absent/unmatched tabs produce NO additional tab (no 'Recovered sessions' tab exists anywhere in the rebuilt layout — behavior-asserted, not string-matched); mixed cohort yields exactly one restored tab per device tab.

Then the wall-spec tail step (write it asserting the CURRENT junk behavior is absent — it fails pre-Task-3-4 because the bucket row lands in a synthetic placement-orphaned tab) — details in the file list above; this tail RED here is intentional (implementation in Steps 3-4 turns it green).

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `npm run test:vitest -- run test/unit/client/lib/recovery/build-recovery-plan.test.ts`

Expected: FAIL — the join does not exist (joined leaf missing; ledger rows land outside any original tab).

(The wall-spec tail runs at Step 4's e2e command; recording its RED once during this task's early loop is required if feasible, but its full reliable RED/GREEN pair requires Tasks 2-3 present — if run pre-Task-3 code, it fails on multi-cause junk: record exactly that as the tail's pre-fix evidence.)

- [ ] **Step 3: Add the minimal production implementation**

Types + join + panel rendering per the Files/Interfaces contract. The panel's per-row data source for joined rows comes from the inventory (mode/cwd on the `ledgerOnly` entry, tabName from the matched union tab).

- [ ] **Step 4: Run the focused tests**

Run: `npm run test:vitest -- run test/unit/client/lib/recovery/build-recovery-plan.test.ts`
Expected: PASS.

Run: `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/restore-contract-wall-rust.spec.ts -g 'SIGKILL-within-5s'`
Expected: PASS (whole scenario including the new placement tail).

- [ ] **Step 5: Refactor while green**

Keep the join code beside `chain()`'s conventions; no exported helpers duplicated from panesSlice; re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

```bash
npm run test:vitest -- run test/unit/client/lib/recovery test/unit/client/components/RecoveryOfferPanel.test.tsx test/unit/client/components/RecoveryOfferPanel.persisted-boot.test.tsx
npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/recover-my-panes-rust.spec.ts
npm run typecheck
npm run lint
```

Expected: all PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/lib/recovery/types.ts src/lib/recovery/build-recovery-plan.ts src/components/RecoveryOfferPanel.tsx test/unit/client/lib/recovery/build-recovery-plan.test.ts test/e2e-browser/specs/restore-contract-wall-rust.spec.ts
git commit -m "feat(recovery): restored ledger rows rejoin their original tab (D8 placement)

Kept kill-window rows carry their stamped tabKey; the recovery plan joins
each into the restored tab with the matching source tabKey (one dispatch,
rightmost leaf of the existing chain), and the offer lists it under that
tab's name. Rows whose tab vanished from all retained evidence do not fall
back to any synthetic tab — unplaceable rows are excluded upstream. The
wall SIGKILL-5s scenario now pins original-tab placement end to end."
```

---

## Final verification (executed by the orchestrator after Task 4 review closes)

The coordinated full-suite gate (run by the orchestrator, not the task implementers):

```bash
FRESHELL_TEST_SUMMARY='restore-open-sessions-only full-suite gate' env -u FRESHELL_BIND_HOST -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy npm run check
cargo test -p freshell-server -p freshell-ws -p freshell-freshagent
```

plus re-confirmation of the two rust e2e specs above if the gate's suite does not include them. Gate passes = green run at final HEAD; pre-existing-failure exceptions require reproduction at base_ref `db8e09cb67e08a1028ab50b71b99b160a2e7f35f`.
