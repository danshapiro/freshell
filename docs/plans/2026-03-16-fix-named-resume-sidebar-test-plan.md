# Test Plan: Fix Named Resume Session Sidebar Visibility

## Strategy reconciliation

The approved testing strategy assumed:
- The fix would involve changes to `normalizeResumeSessionId`, `buildSpawnSpec`, `bindSession`, and sidebar selectors
- Existing harnesses (direct API, programmatic state, interaction/e2e, output capture) would be sufficient
- No reference implementation exists for differential testing
- No performance testing is needed

The finalized implementation plan confirms all of these assumptions. It introduces two additional changes not explicitly anticipated by the strategy:
1. A new `pendingResumeName` field on `TerminalRecord` -- this is a minor extension within the existing programmatic state harness
2. Changes to `panesSlice.ts` `buildPaneContent` and `layoutMirrorMiddleware.ts` `buildTabFallbackSessionRef` -- these are additional client-side defense-in-depth changes that are within the agreed scope (relaxing `isValidClaudeSessionId` gates in display paths)

These additions do not change the cost, scope, or verification approach. The strategy holds without adjustment.

---

## Test plan

### Test 1: Existing test update -- `buildSpawnSpec` passes `--resume` with non-UUID Claude name

- **Name**: Claude terminal spawn includes `--resume` with a human-readable session name
- **Type**: regression
- **Disposition**: extend (update existing test `'omits --resume when resumeSessionId is invalid'` at `test/unit/server/terminal-registry.test.ts` line 764)
- **Harness**: Direct API harness -- calls exported `buildSpawnSpec()` directly
- **Preconditions**: `process.env.CLAUDE_CMD` is deleted (so the default Claude binary is used); process platform is Linux/macOS
- **Actions**: Call `buildSpawnSpec('claude', '/Users/john', 'system', 'not-a-uuid')`
- **Expected outcome**: `spec.args` contains `'--resume'` and `'not-a-uuid'`. Source of truth: Claude Code supports `--resume <name>` with human-readable strings (documented in codebase at `coding-cli/providers/claude.ts`); the user's bug report confirms `"137 tour"` is a valid resume name.
- **Interactions**: Tests the `normalizeResumeForSpawn` path inside `buildSpawnSpec`. Verifies the split from the old `normalizeResumeSessionId` that rejected non-UUID Claude names.

### Test 2: New test -- `buildSpawnSpec` passes `--resume` with space-containing resume name

- **Name**: Claude terminal spawn includes `--resume` with a name containing spaces
- **Type**: regression
- **Disposition**: new (in `test/unit/server/terminal-registry.test.ts`)
- **Harness**: Direct API harness
- **Preconditions**: `process.env.CLAUDE_CMD` is deleted; Linux platform
- **Actions**: Call `buildSpawnSpec('claude', '/home/user', 'system', '137 tour')`
- **Expected outcome**: `spec.args` contains `'--resume'` and `'137 tour'`. Source of truth: user's reproduction case with resume name "137 tour".
- **Interactions**: Same as Test 1.

### Test 3: Existing test update -- `buildSpawnSpec` omits `--resume` for empty string

- **Name**: Claude terminal spawn omits `--resume` when resume ID is empty
- **Type**: boundary
- **Disposition**: extend (rename existing test at line 764, add companion for empty string)
- **Harness**: Direct API harness
- **Preconditions**: `process.env.CLAUDE_CMD` is deleted
- **Actions**: Call `buildSpawnSpec('claude', '/Users/john', 'system', '')`
- **Expected outcome**: `spec.args` does NOT contain `'--resume'`. Source of truth: empty string is not a valid resume target for any provider.
- **Interactions**: Tests the `normalizeResumeForSpawn` empty-string guard.

### Test 4: New integration test -- named resume terminal gets associated with UUID after discovery

- **Name**: A Claude terminal created with a human-readable resume name gets bound to the real UUID when the session indexer discovers the JSONL file
- **Type**: integration
- **Disposition**: new (in `test/server/session-association.test.ts`)
- **Harness**: Interaction harness -- exercises `TerminalRegistry`, `SessionAssociationCoordinator`, and `TerminalMetadataService` together with mocked PTY
- **Preconditions**: A `TerminalRegistry` instance with a terminal created via `{ mode: 'claude', cwd: '/home/user/project', resumeSessionId: '137 tour' }`. No session binding exists yet.
- **Actions**:
  1. Verify `terminal.resumeSessionId` is `undefined` (non-UUID name is not used as a binding key)
  2. Verify `terminal.pendingResumeName` is `'137 tour'`
  3. Call `coordinator.associateSingleSession()` with a valid UUID session matching the same project path
- **Expected outcome**: The coordinator returns `{ associated: true, terminalId }`. `terminal.resumeSessionId` is now the UUID. A `terminal.session.bound` event is emitted. Source of truth: the implementation plan's Design Decision 1 (the association coordinator discovers the UUID from the JSONL file and binds it).
- **Interactions**: Exercises the boundary between terminal registry's `findUnassociatedTerminals` (which must include terminals with `pendingResumeName` but no `resumeSessionId`) and `bindSession` (which must accept valid UUIDs via `normalizeResumeForBinding`).

### Test 5: Existing test update -- sidebar `hasTab` for non-UUID Claude resume name

- **Name**: A Claude tab with a non-UUID resume name is recognized as having a tab in the sidebar
- **Type**: regression
- **Disposition**: extend (update assertion in `test/unit/client/store/selectors/sidebarSelectors.test.ts` at line 174)
- **Harness**: Programmatic state harness -- calls `buildSessionItems` with synthetic Redux state
- **Preconditions**: A project list containing a session with ID `'not-a-uuid'` (provider: `'claude'`). A tab and pane with `resumeSessionId: 'not-a-uuid'` and `mode: 'claude'`.
- **Actions**: Call `buildSessionItems(projects, tabs, panes, emptyTerminals, emptyActivity)`
- **Expected outcome**: `hasTab` for the `'not-a-uuid'` session is `true`. Source of truth: the user's bug report -- a tab with a non-UUID Claude resume name should appear in the sidebar.
- **Interactions**: Tests the full chain from `collectSessionRefsFromTabs` -> `extractSessionLocators` -> `isValidSessionRef` through to `buildSessionItems` merging fallback items. This is the client-side manifestation of the bug.

### Test 6: New test -- fallback sidebar item created for Claude pane with human-readable resume name

- **Name**: A Claude tab with a human-readable resume name creates a fallback sidebar item even when not in the sessions list
- **Type**: integration
- **Disposition**: new (in `test/unit/client/store/selectors/sidebarSelectors.test.ts`)
- **Harness**: Programmatic state harness
- **Preconditions**: An empty project list (no server-side sessions). A single tab with a Claude pane where `resumeSessionId: '137 tour'`.
- **Actions**: Call `buildSessionItems([], tabs, panes, emptyTerminals, emptyActivity)`
- **Expected outcome**: One item returned with `sessionId: '137 tour'`, `provider: 'claude'`, `hasTab: true`. Source of truth: the user's bug report -- even before the server discovers the UUID, the sidebar should show something for this active tab.
- **Interactions**: Tests `collectFallbackItemsFromNode` and the tab fallback loop in `sidebarSelectors.ts`, both of which currently reject non-UUID Claude names.

### Test 7: New test -- fallback sidebar item for Claude pane with special characters in resume name

- **Name**: A Claude tab with special characters in the resume name still creates a fallback sidebar item
- **Type**: boundary
- **Disposition**: new (in `test/unit/client/store/selectors/sidebarSelectors.test.ts`)
- **Harness**: Programmatic state harness
- **Preconditions**: An empty project list. A single tab with a Claude pane where `resumeSessionId: "fix: can't parse (issue #42)"`.
- **Actions**: Call `buildSessionItems([], tabs, panes, emptyTerminals, emptyActivity)`
- **Expected outcome**: One item returned with `sessionId: "fix: can't parse (issue #42)"`, `hasTab: true`. Source of truth: Claude Code supports arbitrary human-readable strings for `--resume`; there is no character restriction.
- **Interactions**: Same as Test 6, but exercises string handling at boundaries.

### Test 8: Existing test update -- WS terminal.create passes non-UUID resume ID through and skips session repair

- **Name**: Creating a Claude terminal via WebSocket with a non-UUID resume name passes it through to the registry and skips session repair
- **Type**: regression
- **Disposition**: extend (update `test/server/ws-terminal-create-session-repair.test.ts` test at line 829)
- **Harness**: Interaction harness -- full Express/WS server with mocked PTY
- **Preconditions**: A running test server with mocked `SessionRepairService`.
- **Actions**: Send `{ type: 'terminal.create', requestId, mode: 'claude', resumeSessionId: 'not-a-uuid' }` over WebSocket.
- **Expected outcome**:
  1. `registry.lastCreateOpts?.resumeSessionId` is `'not-a-uuid'` (passed through, not stripped)
  2. `created.effectiveResumeSessionId` is `'not-a-uuid'` (reflected in the `terminal.created` message)
  3. `sessionRepairService.waitForSessionCalls` does NOT contain `'not-a-uuid'` (session repair skipped for non-UUID)
  Source of truth: implementation plan Design Decision 1 (pass raw resume arg through) and Task 1 Step 3 (session repair guard requires `isValidClaudeSessionId`).
- **Interactions**: Exercises the WS handler -> terminal registry create path, plus the session repair guard. This is the primary server-side integration boundary.

### Test 9: Existing test update -- Windows `buildSpawnSpec` passes `--resume` with non-UUID name (cmd.exe)

- **Name**: Claude terminal spawn on Windows cmd.exe includes `--resume` with a non-UUID name
- **Type**: regression
- **Disposition**: extend (update `test/unit/server/terminal-registry.test.ts` line 1581)
- **Harness**: Direct API harness
- **Preconditions**: `process.platform` set to `'win32'`
- **Actions**: Call `buildSpawnSpec('claude', 'C:\\tmp', 'cmd', 'not-a-uuid')`
- **Expected outcome**: `spec.args.join(' ')` contains `'--resume'` and `'not-a-uuid'`. Source of truth: same as Test 1, platform-independent behavior.
- **Interactions**: Tests Windows cmd.exe command string construction with non-UUID resume names.

### Test 10: Existing test update -- Windows `buildSpawnSpec` passes `--resume` with non-UUID name (PowerShell)

- **Name**: Claude terminal spawn on Windows PowerShell includes `--resume` with a non-UUID name
- **Type**: regression
- **Disposition**: extend (update `test/unit/server/terminal-registry.test.ts` line 1587)
- **Harness**: Direct API harness
- **Preconditions**: `process.platform` set to `'win32'`
- **Actions**: Call `buildSpawnSpec('claude', 'C:\\tmp', 'powershell', 'not-a-uuid')`
- **Expected outcome**: `spec.args.join(' ')` contains `'--resume'` and `'not-a-uuid'`.
- **Interactions**: Tests Windows PowerShell command construction.

### Test 11: Existing test update -- Windows `buildSpawnSpec` passes `--resume` with non-UUID name (WSL)

- **Name**: Claude terminal spawn on Windows WSL includes `--resume` with a non-UUID name
- **Type**: regression
- **Disposition**: extend (update `test/unit/server/terminal-registry.test.ts` line 1593)
- **Harness**: Direct API harness
- **Preconditions**: `process.platform` set to `'win32'`
- **Actions**: Call `buildSpawnSpec('claude', 'C:\\tmp', 'wsl', 'not-a-uuid')`
- **Expected outcome**: `spec.args` contains `'--resume'` and `'not-a-uuid'`.
- **Interactions**: Tests Windows WSL arg array construction.

### Test 12: New E2E test -- named resume session appears in sidebar

- **Name**: A Claude tab with a human-readable resume name appears in the sidebar's session list
- **Type**: scenario
- **Disposition**: new (in `test/e2e/open-tab-session-sidebar-visibility.test.tsx`)
- **Harness**: Interaction harness -- React Testing Library rendering full `App` component with Redux store, mocked WS/API
- **Preconditions**: Store initialized with one tab (`mode: 'claude'`, `resumeSessionId: '137 tour'`) and corresponding pane layout. `fetchSidebarSessionsSnapshot` returns an empty project list.
- **Actions**: Render `<Provider store={store}><App /></Provider>`. Wait for the sidebar to populate.
- **Expected outcome**: `screen.getAllByText('137 tour')` finds at least one element. Source of truth: the user's bug report -- "The session with resume name '137 tour' is active in this session but isn't showing up in the left hand panel."
- **Interactions**: Exercises the full rendering pipeline: Redux state -> `selectSidebarItems` selector -> `buildSessionItems` -> `collectSessionRefsFromTabs`/`collectFallbackItemsFromNode` -> React component rendering. This is the highest-fidelity test of the user-visible behavior.

### Test 13: New test -- `buildSpawnSpec` with various edge-case resume names

- **Name**: Claude terminal spawn handles edge-case resume names correctly (partial UUID, special chars, empty)
- **Type**: boundary
- **Disposition**: new (describe block in `test/unit/server/terminal-registry.test.ts`)
- **Harness**: Direct API harness
- **Preconditions**: `process.env.CLAUDE_CMD` deleted
- **Actions and expected outcomes**:
  1. `buildSpawnSpec('claude', '/home/user', 'system', '550e8400-e29b')` -- partial UUID: `args` contains `'--resume'` and the partial UUID
  2. `buildSpawnSpec('claude', '/home/user', 'system', "fix: can't parse")` -- special chars: `args` contains `'--resume'` and the name
  3. `buildSpawnSpec('claude', '/home/user', 'system', VALID_CLAUDE_SESSION_ID)` -- valid UUID: `args` contains `'--resume'` and the UUID (regression guard)
  4. `buildSpawnSpec('claude', '/home/user', 'system', '')` -- empty string: `args` does NOT contain `'--resume'`
  Source of truth: Claude Code accepts any non-empty string for `--resume`; empty string is a no-op.
- **Interactions**: Tests `normalizeResumeForSpawn` through `buildSpawnSpec` across the input boundary.

### Test 14: New test -- `collectSessionRefsFromNode` returns refs for non-UUID Claude panes

- **Name**: Session ref collection includes Claude panes with non-UUID resume names
- **Type**: unit
- **Disposition**: new (in `test/unit/client/lib/session-utils.test.ts`)
- **Harness**: Direct API harness -- calls `collectSessionRefsFromNode` directly
- **Preconditions**: A leaf pane node with `{ kind: 'terminal', mode: 'claude', resumeSessionId: '137 tour' }`.
- **Actions**: Call `collectSessionRefsFromNode(node)`
- **Expected outcome**: Returns an array containing `{ provider: 'claude', sessionId: '137 tour' }`. Source of truth: the implementation plan's Design Decision 3 -- the display/fallback path should accept non-UUID Claude session refs.
- **Interactions**: Tests `extractSessionLocators` -> `isValidSessionRef` chain in `session-utils.ts`. This is the root client-side function that the sidebar and layout mirror middleware depend on.

### Test 15: Invariant -- agent-chat path still rejects non-UUID Claude session IDs

- **Name**: Agent-chat panes with non-UUID Claude session IDs are not included in session refs
- **Type**: invariant
- **Disposition**: new (in `test/unit/client/lib/session-utils.test.ts`)
- **Harness**: Direct API harness
- **Preconditions**: A leaf pane node with `{ kind: 'agent-chat', provider: 'freshclaude', resumeSessionId: 'not-a-uuid' }`.
- **Actions**: Call `collectSessionRefsFromNode(node)`
- **Expected outcome**: Returns an empty array (or array without `'not-a-uuid'`). Source of truth: implementation plan's note that agent-chat sessions always use UUIDs from the SDK bridge, not user-typed resume names; the `isValidClaudeSessionId` check on the agent-chat path (line 106 in `session-utils.ts`) is intentionally preserved.
- **Interactions**: Verifies that the fix is scoped: relaxing validation for terminal panes does not affect agent-chat panes.

---

## Coverage summary

### Covered areas

| Area | Tests | Coverage type |
|------|-------|--------------|
| Server `buildSpawnSpec` with non-UUID Claude names | 1, 2, 3, 9, 10, 11, 13 | Regression + boundary |
| Server `normalizeResumeForSpawn` / `normalizeResumeForBinding` split | 1, 2, 3, 4, 13 | Regression + boundary (indirect via `buildSpawnSpec` and `create`) |
| Server terminal creation with pending resume name | 4, 8 | Integration |
| Server session association flow for named resume | 4 | Integration |
| Server WS handler non-UUID pass-through | 8 | Integration |
| Server session repair skip for non-UUID | 8 | Regression |
| Client `isValidSessionRef` relaxation | 5, 6, 14 | Regression + integration |
| Client `extractSessionLocators` non-UUID handling | 5, 6, 14 | Regression + integration |
| Client `collectFallbackItemsFromNode` for non-UUID Claude | 6, 7 | Integration + boundary |
| Client sidebar tab fallback loop for non-UUID Claude | 5, 6 | Integration |
| Client `buildTabFallbackSessionRef` relaxation | 12 (via E2E) | Scenario |
| Client `buildPaneContent` non-UUID preservation | 12 (via E2E store initialization) | Scenario |
| Client agent-chat path unchanged | 15 | Invariant |
| Full E2E sidebar visibility for named resume | 12 | Scenario |
| Windows platform spawn variants | 9, 10, 11 | Regression |
| Edge cases (empty string, special chars, partial UUID) | 3, 7, 13 | Boundary |

### Explicitly excluded per strategy

- **Performance testing**: No measurable performance impact expected (validation logic changes only). Low risk.
- **Session indexer/JSONL parsing tests**: The indexer itself is unchanged. The integration test (Test 4) covers the boundary between the indexer output and the association coordinator.
- **Visual/screenshot tests**: The sidebar rendering is verifiable through DOM assertions; no visual regression risk beyond element presence.
- **`hideEmptySessions` interaction with named resume**: The strategy identified this as lower priority. The risk is low because `hideEmptySessions` operates on session title presence, which is orthogonal to how the session got into the sidebar. The E2E test (Test 12) uses an empty project list, which implicitly tests the "no server-side session data" scenario.
- **Multiple terminals with different named resumes**: Lower priority edge case. The association coordinator's cwd-based matching is unchanged and already tested in `test/server/session-association.test.ts` with multiple terminals.

### Risks from exclusions

- The exact behavior of Claude Code when it receives `--resume "<invalid-name>"` (a name that doesn't match any existing session) is not tested. This is external to Freshell and handled by Claude Code's own error handling, which propagates as a terminal exit event.
- The `server/spawn-spec.ts` dead code update (mentioned in the plan) has no test because the file is not imported. Risk: near zero.
