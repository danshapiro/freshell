# Exact Durable Session Contract Test Plan

## Strategy Reconciliation
No strategy changes requiring user approval are needed.

The approved strategy and the implementation plan still line up on the core approach: prove real provider behavior first, make live reattach and durable restore separate state axes, refuse silent fallback-to-fresh behavior, and drive the work with red/green/refactor TDD from the highest-value contract failures downward.

The reconciliation against the current tree adds three execution refinements, but none of them expand scope beyond what the user already approved:

- Migration preservation must be treated as an early gate, not a late cleanup. The current [`src/store/storage-migration.ts`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/src/store/storage-migration.ts) still clears Freshell local state wholesale, so migration tests must fail before any schema cutover lands.
- `agent-api` and MCP are not just downstream read-model consumers. [`server/agent-api/router.ts`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/server/agent-api/router.ts) and [`server/mcp/freshell-tool.ts`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/server/mcp/freshell-tool.ts) originate tab and pane creation flows and currently pass `resumeSessionId` through launch paths, so the contract suite must cover them explicitly before sign-off.
- The repo already has useful harness assets for this work: the fake Codex app-server fixture, websocket integration harnesses, storage/bootstrap tests, and OpenCode startup probe captures. The test plan reuses and extends those instead of inventing parallel harnesses.

Task 1 remains the authoritative behavior lock. Planning-time observations from the transcript are strong evidence, but after Task 1 the checked-in lab note and executable real-provider suite become the only allowed source of truth for provider behavior.

## Sources Of Truth
- `S1 User-approved contract`: persist only replay-safe durable provider identity; keep live reattach handles separate; do not silently fall back from restore to fresh create; surface explicit restore-unavailable failures.
- `S2 Implementation plan`: [`docs/plans/2026-04-19-exact-durable-session-contract.md`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/docs/plans/2026-04-19-exact-durable-session-contract.md), especially the Strategy Gate, Wire Contract Rule, Restore-Unavailable Rule, and Tasks 1 through 9.
- `S3 Real provider behavior`: the Task 1 lab note plus the opt-in real-provider suite. These supersede planning-time assumptions.
- `S4 Current shipped breakage`: fresh Codex `thread/start` ids are still treated as durable resume ids by [`server/coding-cli/codex-app-server/launch-planner.ts`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/server/coding-cli/codex-app-server/launch-planner.ts), [`server/ws-handler.ts`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/server/ws-handler.ts), and the current Codex integration tests.
- `S5 Existing live-vs-durable split for agent chat`: [`src/store/agentChatTypes.ts`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/src/store/agentChatTypes.ts), [`src/components/agent-chat/AgentChatView.tsx`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/src/components/agent-chat/AgentChatView.tsx), and [`server/agent-timeline/ledger.ts`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/server/agent-timeline/ledger.ts) already distinguish live SDK state from canonical durable Claude identity.
- `S6 Existing authoritative binding/control surfaces`: [`server/session-binding-authority.ts`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/server/session-binding-authority.ts), [`server/session-association-coordinator.ts`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/server/session-association-coordinator.ts), and [`server/coding-cli/opencode-activity-tracker.ts`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/server/coding-cli/opencode-activity-tracker.ts).

## Current Risk Concentrations
- `R1` Fresh Codex thread ids are still collapsed into durable restore ids in [`server/coding-cli/codex-app-server/launch-planner.ts`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/server/coding-cli/codex-app-server/launch-planner.ts:1), [`server/ws-handler.ts`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/server/ws-handler.ts:1447), and [`test/integration/server/codex-session-flow.test.ts`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/test/integration/server/codex-session-flow.test.ts).
- `R2` The wire contract still overloads durable identity and locality in [`shared/ws-protocol.ts`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/shared/ws-protocol.ts), where `SessionLocatorSchema` still carries optional `serverInstanceId` and `terminal.created` still emits `effectiveResumeSessionId`.
- `R3` Client persistence and sync code still synthesizes canonical identity from raw `resumeSessionId` in [`src/store/panesSlice.ts`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/src/store/panesSlice.ts), [`src/store/tabsSlice.ts`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/src/store/tabsSlice.ts), [`src/store/layoutMirrorMiddleware.ts`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/src/store/layoutMirrorMiddleware.ts), [`src/store/crossTabSync.ts`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/src/store/crossTabSync.ts), and [`src/lib/tab-registry-snapshot.ts`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/src/lib/tab-registry-snapshot.ts).
- `R4` `storage-migration.ts` still full-clears persisted state, which directly violates the implementation plan’s preservation rule.
- `R5` Read models and external surfaces still expose or consume raw `resumeSessionId` in [`server/terminals-router.ts`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/server/terminals-router.ts), [`server/terminal-view/service.ts`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/server/terminal-view/service.ts), [`server/terminal-metadata-service.ts`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/server/terminal-metadata-service.ts), [`server/agent-api/router.ts`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/server/agent-api/router.ts), and [`server/mcp/freshell-tool.ts`](/home/user/code/freshell/.worktrees/exact-durable-session-contract/server/mcp/freshell-tool.ts).

## Action Space
- Provider contract proof: new lab note, new real-provider harness, opt-in real-binary integration suite, and `package.json` script wiring.
- Server launch and binding flow: `ws-handler`, `terminal-registry`, Codex app-server client/runtime/planner, OpenCode activity wiring, session binding and association.
- Shared contract and wire types: `shared/ws-protocol.ts` plus the new `shared/session-contract.ts`.
- Client persistence and hydration: `persistedState`, `storage-migration`, `persistMiddleware`, `layoutMirrorMiddleware`, `crossTabSync`, `tabsSlice`, `panesSlice`, `persistControl`, `session-utils`, and `tab-registry-snapshot`.
- Client runtime flows: `TerminalView`, `AgentChatView`, `TabsView`, `BackgroundSessions`, `Sidebar`, `TabContent`, `PaneContainer`, and related selectors/helpers.
- Read models and external APIs: terminal directory services, metadata services, agent API routes, MCP tool surface, and tab-registry snapshots.

## Harness Requirements
| Harness | What it exercises | Reuse / new work |
| --- | --- | --- |
| `H1 Real-provider contract harness` | Real `codex`, `claude`, and `opencode` binaries under isolated temp homes, artifact polling, control-surface capture, and provenance-gated cleanup. | New: `test/helpers/coding-cli/real-session-contract-harness.ts` and `test/integration/real/coding-cli-session-contract.test.ts`. |
| `H2 Server websocket launch harness` | `WsHandler`, `TerminalRegistry`, session repair, duplicate create suppression, same-server reuse, and terminal create/restore flows. | Reuse and extend existing integration/server websocket tests. |
| `H3 Client terminal lifecycle harness` | `TerminalView` websocket behavior, `terminal.created`, `terminal.session.associated`, `INVALID_TERMINAL_ID`, refresh/rehydrate, and persistence flush behavior. | Reuse existing jsdom/ws harnesses in `TerminalView` and `codex-refresh-rehydrate` tests. |
| `H4 Persistence and bootstrap harness` | Migration, persisted layout parsing, cross-tab sync, layout mirror payloads, and app bootstrap hydration. | Reuse existing client store tests plus new `shared/session-contract` tests. |
| `H5 Codex app-server fixture harness` | JSON-RPC contracts, notification handling, stdio flooding, per-sidecar ownership, and sidecar failure cases. | Reuse `fake-app-server.mjs`, `client.test.ts`, `runtime.test.ts`, and add sidecar tests. |
| `H6 Claude/FreshClaude restore harness` | Session association, SDK attach/create, ledger restore resolution, named resume, canonical UUID promotion, and restore failure surfacing. | Reuse `session_association`, `ws-handler-sdk`, `AgentChatView`, and ledger tests. |
| `H7 OpenCode authoritative-control harness` | OpenCode health/events stream, startup state, durable promotion, and cleanup. | Reuse `opencode-activity-tracker`, `ws-opencode-activity`, and startup probe fixtures. |
| `H8 Read-model and external-surface harness` | Terminal directory, sidebar/background sessions, tab-registry snapshots, agent routes, and MCP tool actions. | Reuse existing router/UI tests and extend where needed. |
| `H9 Broad verification harness` | Lint, typecheck, focused regression sweeps, opt-in real-provider rerun, and coordinated full suite. | Use repo coordinator workflows from `package.json`. |

## Test Plan
### Task 1: Lock Down Real Provider Contracts
1. **Name:** Real-provider harness discovers binaries, isolates temp homes, and enforces provenance-gated cleanup.
   **Type:** scenario
   **Harness:** `H1`
   **Preconditions:** Unique temp homes and sentinel metadata per provider section.
   **Actions:** Resolve binaries with `command -v`, record exact paths and versions, start probes, emit dry-run ownership reports, then run cleanup.
   **Expected outcome:** Missing binaries produce per-provider Vitest skips by executable name; auth/config/runtime failures fail the section rather than skipping; cleanup refuses to kill any PID lacking the temp-home prefix plus harness sentinel.

2. **Name:** Codex fresh create, thread allocation, durable artifact creation, and restore timing are recorded exactly.
   **Type:** scenario
   **Harness:** `H1`
   **Preconditions:** Real `codex` binary available.
   **Actions:** Probe fresh remote startup, observe any thread notifications, poll provider-owned artifacts, restart the runtime, and attempt restore with the observed durable token.
   **Expected outcome:** The lab note and executable suite agree on the exact sequence of live-only state, thread allocation, artifact durability, and resumability. If a fresh thread id appears before artifact durability, the tests lock that down as non-durable state.

3. **Name:** Claude fresh create, transcript durability, named resume, and rename/title semantics are recorded exactly.
   **Type:** scenario
   **Harness:** `H1`
   **Preconditions:** Real `claude` binary available.
   **Actions:** Probe fresh create with exact id, named resume, transcript creation, and any rename/title surface.
   **Expected outcome:** The suite proves when Claude gains canonical UUID-backed durability and whether names/titles are mutable metadata or absent in the tested mode.

4. **Name:** OpenCode startup, authoritative session creation, restore contract, and rename/title semantics are recorded exactly.
   **Type:** scenario
   **Harness:** `H1`
   **Preconditions:** Real `opencode` binary available.
   **Actions:** Probe bare startup, wait for authoritative control-surface session creation, observe restore behavior, and check whether a mutable name/title surface exists.
   **Expected outcome:** The suite proves whether bare startup is live-only, which control event creates durable identity, and whether names/titles can drift independently from canonical ids.

5. **Name:** The checked-in lab note and opt-in real-provider suite are mutually executable.
   **Type:** invariant
   **Harness:** `H1`
   **Preconditions:** Task 1 artifacts exist.
   **Actions:** Run `npm run test:real:coding-cli-contracts` and compare the asserted facts against the checked-in lab note.
   **Expected outcome:** Every factual claim in the lab note is executable; later reruns fail if the note and tests drift apart.

### Task 2: Lock Down The Live-Versus-Durable State Machine
6. **Name:** Same-server reconnect reattaches by live handle even when no canonical durable identity exists yet.
   **Type:** scenario
   **Harness:** `H2`, `H3`
   **Preconditions:** A running terminal or SDK session exists and persisted state still has a valid local live handle.
   **Actions:** Rehydrate the tab on the same server instance before any durable promotion arrives.
   **Expected outcome:** Freshell reattaches the live terminal/session, does not recreate from provider identity, and does not invent a durable restore target.

7. **Name:** Dead or stale live handles only fall through to durable restore when canonical identity exists.
   **Type:** scenario
   **Harness:** `H2`, `H3`
   **Preconditions:** Persisted state contains a stale `serverInstanceId` or dead live handle.
   **Actions:** Rehydrate with and without canonical durable identity present.
   **Expected outcome:** With canonical durable identity, Freshell performs provider restore. Without it, Freshell surfaces restore-unavailable rather than starting fresh.

8. **Name:** A dead non-durable session becomes explicit `RESTORE_UNAVAILABLE`.
   **Type:** scenario
   **Harness:** `H2`, `H3`, `H6`
   **Preconditions:** A pane previously existed only in live state and the backing process is gone.
   **Actions:** Rehydrate the pane or tab after process loss.
   **Expected outcome:** The persisted/read-model state carries a `RESTORE_UNAVAILABLE` error shape; UI recovery does not silently create a new session.

9. **Name:** Mutable names and titles never affect identity matching or restore routing.
   **Type:** differential
   **Harness:** `H2`, `H6`, `H7`
   **Preconditions:** A session already has canonical durable identity.
   **Actions:** Change display names or titles where the provider allows it, then rehydrate and match against sidebar/open-session state.
   **Expected outcome:** Canonical identity, binding, and restore behavior remain unchanged while only metadata changes.

10. **Name:** FreshClaude keeps live SDK `sessionId` separate from durable Claude identity across reload and restore.
    **Type:** scenario
    **Harness:** `H6`
    **Preconditions:** A FreshClaude pane has live SDK state and later receives canonical Claude ids.
    **Actions:** Reload before and after canonical promotion, then exercise attach and history hydration.
    **Expected outcome:** Live SDK attach uses the SDK id; durable history and future restores use canonical Claude identity; no flattening occurs.

### Task 3: Shared Contract And Migration
11. **Name:** Legacy raw `resumeSessionId` persistence migrates to canonical durable identity or explicit restore-unavailable state.
    **Type:** integration
    **Harness:** `H4`
    **Preconditions:** Persisted layouts include terminal tabs, terminal panes, and agent-chat panes from current-main shapes.
    **Actions:** Load persisted layout through migration and hydration.
    **Expected outcome:** Repairable entries gain canonical durable identity; irreparable entries gain explicit restore-unavailable state; raw terminal/tab `resumeSessionId` persistence does not survive as durable truth.

12. **Name:** Canonical `sessionRef` never carries `serverInstanceId`, while live handles remain separate and preserved.
    **Type:** unit
    **Harness:** `H4`
    **Preconditions:** Shared contract helpers and migrated payloads are available.
    **Actions:** Parse, build, and serialize session locators across tabs, panes, layout sync, and bootstrap paths.
    **Expected outcome:** `sessionRef` is provider plus session id only; locality lives in explicit live-handle/runtime fields.

13. **Name:** Storage migration preserves restorable layouts and does not use schema-bump wipe as the feature mechanism.
    **Type:** invariant
    **Harness:** `H4`
    **Preconditions:** Local storage contains recoverable session-bearing tabs and panes.
    **Actions:** Run the storage migration path from old persisted versions into the new contract.
    **Expected outcome:** Recoverable entries survive; only truly unrecoverable legacy values become restore-unavailable; no blanket localStorage clear occurs.

14. **Name:** `ui.layout.sync`, `clientHello`, `fallbackSessionRef`, and bootstrap consumers honor the live-versus-durable split.
    **Type:** integration
    **Harness:** `H4`
    **Preconditions:** Client and server bootstrap paths are wired to the new contract.
    **Actions:** Serialize layout mirror payloads, cross-tab sync messages, and websocket hello payloads, then hydrate them.
    **Expected outcome:** No path smuggles `serverInstanceId` through canonical identity or revives a raw persisted resume string.

15. **Name:** Session utilities, pane construction, and tab snapshot helpers stop synthesizing canonical identity from arbitrary strings.
    **Type:** integration
    **Harness:** `H4`, `H8`
    **Preconditions:** Shared contract helpers exist.
    **Actions:** Exercise `session-utils`, `session-type-utils`, `tab-registry-snapshot`, `TabsView`, and pane construction with mixed local/remote and legacy payloads.
    **Expected outcome:** Canonical identity comes only from the explicit durable contract; same-server live state remains separate; invalid legacy strings do not become session refs.

### Task 4: Make Durable Promotion Authoritative
16. **Name:** `terminal.created` preserves only live launch state and never persists a non-durable provider id.
    **Type:** integration
    **Harness:** `H2`, `H3`
    **Preconditions:** A terminal is being created for each provider mode that supports restore.
    **Actions:** Observe `terminal.created` handling on server and client.
    **Expected outcome:** The event carries live creation outcome only; it does not promote durable identity on its own.

17. **Name:** `terminal.session.associated` is the only terminal durable-promotion event.
    **Type:** integration
    **Harness:** `H2`, `H3`
    **Preconditions:** The terminal binding path is active and a provider-specific durable signal arrives.
    **Actions:** Trigger association/promotion and inspect server broadcasts, client persistence, and flush behavior.
    **Expected outcome:** Canonical durable identity is persisted only on `terminal.session.associated`; there is no second promotion plane.

18. **Name:** Running-terminal reuse and duplicate create locking follow the canonical/live split.
    **Type:** integration
    **Harness:** `H2`
    **Preconditions:** Matching running sessions exist for same request id, same live handle, and same canonical durable identity cases.
    **Actions:** Send duplicate or overlapping `terminal.create` requests.
    **Expected outcome:** Same-server reuse beats recreate; durable matching uses canonical identity only; non-durable fresh ids do not steal ownership.

19. **Name:** `INVALID_TERMINAL_ID` recovery respects live-handle-first restore and surfaces restore-unavailable cleanly.
    **Type:** integration
    **Harness:** `H3`
    **Preconditions:** A previously attached pane loses its live terminal id across reconnect/reload.
    **Actions:** Trigger `INVALID_TERMINAL_ID` and allow the client recovery path to run.
    **Expected outcome:** The client either reattaches/recreates using valid durable identity or surfaces restore-unavailable; it never loops indefinitely or starts fresh implicitly.

### Task 5: Codex Sidecar Ownership And Durable Artifact Promotion
20. **Name:** Fresh Codex create launches with the exact real-provider form and stays live-only until durability is proven.
    **Type:** integration
    **Harness:** `H5`, `H2`
    **Preconditions:** Codex sidecar architecture is in place.
    **Actions:** Create a fresh Codex terminal and inspect spawned CLI args, sidecar state, notifications, and persistence.
    **Expected outcome:** Fresh create uses the exact Task 1 contract, currently expected to be `codex --remote <ws>` without `resume`; no durable id is persisted until provider-owned durability is proven.

21. **Name:** Codex restore launches with the exact durable restore form only after canonical identity exists.
    **Type:** integration
    **Harness:** `H5`, `H2`
    **Preconditions:** A Codex session has already been durably promoted.
    **Actions:** Rehydrate or recreate the pane via durable restore.
    **Expected outcome:** Restore uses the exact Task 1 durable form, currently expected to be `codex --remote <ws> resume <durable-token>`; sidecar `thread/resume` is not part of the restore path.

22. **Name:** Two live Codex panes own isolated sidecars, loopback endpoints, and cleanup.
    **Type:** scenario
    **Harness:** `H5`
    **Preconditions:** Two Codex terminals run concurrently.
    **Actions:** Start both, drive notifications/artifacts separately, then exit them in different orders.
    **Expected outcome:** Each terminal owns its own sidecar and endpoint; cleanup is isolated; no shared singleton runtime remains.

23. **Name:** Codex durable promotion occurs only after provider notifications plus durable artifact proof.
    **Type:** scenario
    **Harness:** `H5`, `H2`
    **Preconditions:** Sidecar can observe thread notifications before durability and can poll the durable artifact.
    **Actions:** Emit provisional notifications, delay artifact creation, then create the artifact.
    **Expected outcome:** Exact thread ids observed before durability remain launch-only state; durable promotion does not happen until artifact proof exists.

24. **Name:** Codex sidecar startup failure, invalid initialize payloads, transport death, and post-launch sidecar death fail clearly with no fallback.
    **Type:** boundary
    **Harness:** `H5`
    **Preconditions:** Fake app-server fixture can ignore methods, flood stdio, return malformed payloads, or die.
    **Actions:** Trigger initialization failures, late reply timeouts, sidecar death after launch, and transport loss.
    **Expected outcome:** Failures are explicit and user-facing; no fallback to a shared runtime, heuristic launch path, or silent fresh session.

### Task 6: Claude And FreshClaude Canonical Durable Identity
25. **Name:** Terminal Claude named resume remains launch-only until canonical UUID-backed transcript identity is proven.
    **Type:** integration
    **Harness:** `H6`, `H2`
    **Preconditions:** A terminal Claude pane is created from a non-UUID named resume token.
    **Actions:** Launch, wait for session repair or association, and then rehydrate.
    **Expected outcome:** The name is not treated as canonical identity; canonical promotion occurs only when a UUID-backed transcript is proven.

26. **Name:** Persisted invalid Claude restore candidates are rejected on read rather than reused as durable identity.
    **Type:** integration
    **Harness:** `H4`, `H6`
    **Preconditions:** Persisted terminal or agent-chat state contains non-canonical Claude restore values.
    **Actions:** Migrate, hydrate, and attempt restore.
    **Expected outcome:** Invalid durable candidates become restore-unavailable; named or mutable values are not treated as canonical on read.

27. **Name:** FreshClaude reload and restore keep SDK attach separate from canonical timeline and CLI identity.
    **Type:** integration
    **Harness:** `H6`
    **Preconditions:** A FreshClaude pane has combinations of `sessionId`, `timelineSessionId`, `cliSessionId`, and stale restore revisions.
    **Actions:** Exercise reload, lost-session recovery, stale-revision retry, and visible timeline hydration.
    **Expected outcome:** SDK attach uses live state; durable history uses canonical Claude identity; stale-revision recovery and fatal restore errors remain explicit.

28. **Name:** Agent timeline ledger handles durable-only, live-only, merged, and fatal restore states deterministically.
    **Type:** unit
    **Harness:** `H6`
    **Preconditions:** Durable history and live SDK message sets are available in controlled combinations.
    **Actions:** Resolve restore history under each state and compare signatures, aliases, and failure codes.
    **Expected outcome:** Ledger outputs stable `RESTORE_UNAVAILABLE`/`RESTORE_INTERNAL`/`RESTORE_DIVERGED` semantics and never relies on mutable names.

### Task 7: OpenCode Promotion From Authoritative Control Data Only
29. **Name:** OpenCode startup remains live-only until authoritative control-surface session creation.
    **Type:** scenario
    **Harness:** `H7`
    **Preconditions:** OpenCode pane starts with startup probe traffic but no authoritative session event yet.
    **Actions:** Replay startup probe/output frames and then emit authoritative control events.
    **Expected outcome:** Probe bytes and title text do not create durable identity; authoritative control data does.

30. **Name:** OpenCode durable promotion, activity, and cleanup consume only authoritative control events.
    **Type:** integration
    **Harness:** `H7`
    **Preconditions:** Tracker/controller wiring is connected.
    **Actions:** Emit busy, idle, reconnect, and terminal-exit flows through the authoritative OpenCode event surface.
    **Expected outcome:** Durable session ids, activity state, and cleanup follow the authoritative event stream only.

31. **Name:** OpenCode restore and sidebar matching use canonical durable identity only.
    **Type:** integration
    **Harness:** `H7`, `H8`
    **Preconditions:** One OpenCode pane has canonical durable identity and another only has live state.
    **Actions:** Rehydrate tabs, drive sidebar/open-session matching, and trigger restore.
    **Expected outcome:** Canonical `sessionRef` governs restore and open-session matching; titles and live-only startup state do not.

### Task 8: Read Models, UI Consumers, Agent Routes, And MCP
32. **Name:** Terminal directory and background-session surfaces preserve explicit live-versus-durable identity.
    **Type:** integration
    **Harness:** `H8`
    **Preconditions:** Terminal records include detached/live-only, detached/durable, and exited terminals.
    **Actions:** Query terminal directory APIs, background sessions UI, and terminal metadata services.
    **Expected outcome:** Same-server attach uses live terminal ids; durable restore identity is separate and explicit; raw fallback strings are not the contract.

33. **Name:** Sidebar, TabsView, TabContent, PaneContainer, and pane activity do not revive stale raw resume strings.
    **Type:** integration
    **Harness:** `H8`, `H3`, `H4`
    **Preconditions:** Tabs, pane layouts, and remote tab-registry snapshots contain mixes of canonical identity, live handles, and legacy values.
    **Actions:** Render/open the tabs and panes, sync remote snapshots, and inspect selector output and pane runtime metadata.
    **Expected outcome:** Canonical durable identity plus explicit live handles drive UI state; stale raw strings and mutable titles do not.

34. **Name:** Agent API write paths and MCP actions follow the explicit contract for create, split, and resume flows.
    **Type:** integration
    **Harness:** `H8`
    **Preconditions:** Server write routes and MCP client are wired to the new contract.
    **Actions:** Create tabs, split panes, and invoke MCP `new-tab`/resume-style actions for terminal and agent-chat cases.
    **Expected outcome:** These surfaces neither demand nor leak raw durable `resumeSessionId` strings; Codex create/split paths honor sidecar and canonical identity rules.

35. **Name:** Remote tab-registry snapshots and same-server sanitization preserve only the right identity on the right axis.
    **Type:** integration
    **Harness:** `H8`, `H4`
    **Preconditions:** Snapshot payloads include local and remote device records with session-bearing panes.
    **Actions:** Build registry snapshots, open remote copies locally, and merge cross-tab state.
    **Expected outcome:** Same-server reopen may preserve local live handles where appropriate; cross-device snapshots preserve canonical durable identity only.

### Task 9: Final Verification And Invariants
36. **Name:** Session-domain public contracts no longer leak the old hybrid semantics.
    **Type:** invariant
    **Harness:** `H9`
    **Preconditions:** The contract cutover is complete.
    **Actions:** Run targeted grep and schema/type tests across `shared`, `server`, `src`, and `test`.
    **Expected outcome:** Canonical durable identity no longer depends on raw terminal/tab `resumeSessionId`, and canonical `sessionRef` never carries `serverInstanceId`.

37. **Name:** Lint and typecheck remain green after the contract cut.
    **Type:** verification
    **Harness:** `H9`
    **Actions:** Run `npm run lint` and `npm run typecheck`.
    **Expected outcome:** PASS.

38. **Name:** The opt-in real-provider contract suite re-runs cleanly after implementation.
    **Type:** verification
    **Harness:** `H9`, `H1`
    **Actions:** Run `npm run test:real:coding-cli-contracts`.
    **Expected outcome:** PASS with all three provider sections executed on the implementation machine; an all-skipped run is a failure.

39. **Name:** Focused cross-cutting regressions pass across the new contract seams.
    **Type:** verification
    **Harness:** `H9`
    **Actions:** Run the focused regression sweep from Task 9 of the implementation plan.
    **Expected outcome:** PASS across Codex, Claude/FreshClaude, OpenCode, shared contract, migration, and consumer cutover suites.

40. **Name:** Coordinated full-suite verification passes under the repo test gate.
    **Type:** verification
    **Harness:** `H9`
    **Actions:** Run `FRESHELL_TEST_SUMMARY="exact durable session contract" npm test` after checking the coordinator status.
    **Expected outcome:** PASS. No task is complete until the coordinated full suite is green.

## Sequencing Rules
- Write the highest-value red tests first for each task. Do not implement through a greenfield helper and backfill assertions later.
- Treat Task 1 and Task 3 as hard prerequisites. Do not cut product code to the new model until the real-provider contract is documented and migration-preservation failures are captured.
- Reuse the existing fake Codex app-server, websocket harnesses, startup probe captures, and jsdom lifecycle tests whenever they already exercise the correct seam.
- Do not spend the broad-suite budget early. Use focused `npm run test:vitest -- ...` runs during Tasks 1 through 8, then run the final coordinated suite in Task 9.

## Definition Of Good Coverage
- The suite proves exactly when a provider is live-only, exactly when it becomes durably restorable, and exactly which identifier becomes canonical.
- The suite proves that same-server reattach, durable restore, and restore-unavailable are three different outcomes with different triggers.
- The suite proves that mutable names and titles are metadata only.
- The suite proves that migration preserves repairable user state instead of wiping it.
- The suite proves that all external entrypoints and read models use the same explicit contract, not private fallback semantics.
