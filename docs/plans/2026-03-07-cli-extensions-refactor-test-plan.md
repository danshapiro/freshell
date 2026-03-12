# CLI Extensions Refactor -- Test Plan

## Strategy Reconciliation

The user explicitly stated: "You should actually make sure this works. main is currently being served on port :5173 so you can open a chrome window to that and test it. You should exchange messages with both claude and codex, you should close and reopen them, and do all the other things through the UX to really test them."

The implementation plan's testing strategy (Task 11) aligns: "No unit tests only. Full E2E validation through the live UI on port :5173."

**Reconciliation notes:**

1. The plan touches ~15 source files and removes hardcoded constants from 5+ locations. The risk surface is wide -- a single broken import or mismatched function signature will crash the server or break the UI. The existing vitest suite (`npm test`) serves as the **regression harness** and must pass in its entirety before any E2E validation.

2. E2E testing through the live UI on port :5173 requires that the worktree server be started (on a separate port, e.g., 3344) to validate server-side changes, then the final merged code be validated against the production server on :5173. Since main is live, the E2E tests are manual validation steps performed by the implementing agent -- not automated test files.

3. The implementation plan reveals callers not mentioned in the original strategy: `TabsView.tsx` imports `CODING_CLI_PROVIDERS` (for `parseSessionLocator`), `session-type-utils.ts` imports `CODING_CLI_PROVIDER_LABELS`, and `ws-handler.ts` uses `CodingCliProviderSchema.safeParse()` in two places. These are additional interaction boundaries to test.

4. The plan specifies no new external dependencies or paid API calls. Claude and Codex CLIs must be installed on the system for E2E testing (they already are since this is running inside Freshell).

**No strategy changes requiring user approval.**

---

## Harness Requirements

### Harness 1: Vitest Regression Harness (existing)

- **What it does:** Runs the full `npm test` suite covering unit, integration, and e2e tests
- **What it exposes:** Pass/fail for ~90+ test files covering server WS protocol, terminal lifecycle, settings API, pane picker CLI flow, extension system, and client components
- **Estimated complexity:** Zero -- already exists
- **Tests that depend on it:** All regression tests (Tests 13-16)

### Harness 2: Worktree Dev Server

- **What it does:** Starts the server from the worktree on port 3344 to validate server-side extension loading, API responses, and WS protocol changes
- **What it exposes:** HTTP endpoints (`/api/extensions`, `/api/platform`, `/api/settings`) and WS protocol
- **Estimated complexity:** Low -- `PORT=3344 npm run dev:server`
- **Tests that depend on it:** Tests 7-12 (API and server validation)

### Harness 3: Live UI on Port :5173

- **What it does:** The production Freshell server running on main, validated through Chrome browser
- **What it exposes:** Full UI -- PanePicker, SettingsView, terminal panes, context menus, sidebar
- **Estimated complexity:** Zero -- already running
- **Tests that depend on it:** Tests 1-6 (scenario tests)

---

## Test Plan

### Scenario Tests

#### Test 1: Create Claude pane, exchange messages, close, and reopen

- **Name:** Opening a Claude pane through the picker allows exchanging messages, and reopening after close works identically
- **Type:** scenario
- **Harness:** Live UI on port :5173
- **Preconditions:** Main branch has been fast-forwarded with the refactored code. Server is running on :5173. Claude CLI is installed and available.
- **Actions:**
  1. Open pane picker (Ctrl+N or click +)
  2. Observe that "Claude CLI" appears in the picker with shortcut "L"
  3. Click Claude CLI
  4. Observe that directory picker appears
  5. Select a working directory
  6. Observe that a terminal pane opens with Claude Code starting
  7. Wait for Claude to initialize (prompt appears)
  8. Type a simple message (e.g., "Say hello") and press Enter
  9. Wait for Claude to respond with text
  10. Close the tab (click X or Ctrl+W)
  11. Open a new Claude pane (repeat steps 1-6)
  12. Verify Claude starts fresh in the new pane
- **Expected outcome:**
  - Step 2: Claude CLI appears once in the picker (not twice -- not duplicated with an `ext:` prefix entry). Source of truth: implementation plan, "PanePicker routing: bare names, not `ext:` prefix" section.
  - Step 4: Directory picker appears (routing through `isCodingCliProviderName` to directory step). Source of truth: existing PanePicker behavior preserved by plan.
  - Step 6: Terminal pane opens with mode 'claude'. The pane header shows "Claude CLI". Source of truth: extension manifest `extensions/claude-code/freshell.json` label field.
  - Step 9: Claude produces a text response (proves PTY spawn worked correctly via extension-derived `CodingCliCommandSpec`). Source of truth: Claude CLI's documented behavior.
  - Step 12: New Claude instance starts (proves terminal lifecycle is not broken). Source of truth: existing terminal creation flow.
- **Interactions:** Extension manifest loading, `registerCodingCliCommands()`, `resolveCodingCliCommand()`, PTY spawn, WS protocol `terminal.create` with dynamic schema validation, xterm.js rendering.

#### Test 2: Create Codex pane, exchange messages, close, and reopen

- **Name:** Opening a Codex pane through the picker allows exchanging messages, and reopening after close works identically
- **Type:** scenario
- **Harness:** Live UI on port :5173
- **Preconditions:** Main branch has been fast-forwarded with the refactored code. Codex CLI is installed and available.
- **Actions:**
  1. Open pane picker
  2. Click Codex CLI (or press "X" shortcut)
  3. Select a working directory
  4. Wait for Codex to initialize
  5. Type a message and press Enter
  6. Wait for Codex to respond
  7. Close the tab
  8. Open a new Codex pane and repeat steps 2-4
  9. Verify Codex starts fresh
- **Expected outcome:**
  - Step 2: Codex CLI appears in the picker with shortcut "X". Source of truth: extension manifest `extensions/codex-cli/freshell.json` picker.shortcut.
  - Step 6: Codex produces a response (proves PTY spawn with correct command and env var resolution). Source of truth: Codex CLI's documented behavior.
  - Step 9: New instance starts. Source of truth: existing terminal lifecycle.
- **Interactions:** Extension manifest for codex, `codingCliCommands.get('codex')`, `CODEX_CMD` env var resolution, WS `terminal.create` mode='codex' passing dynamic schema validation.

#### Test 3: Claude and Codex running side by side

- **Name:** Opening Claude and Codex in side-by-side panes allows independent operation
- **Type:** scenario
- **Harness:** Live UI on port :5173
- **Preconditions:** Both CLI tools installed and available.
- **Actions:**
  1. Open a Claude pane in a tab
  2. Split the pane horizontally
  3. In the new pane, select Codex from the picker
  4. Select a working directory for Codex
  5. Send a message to Claude (click its pane, type, enter)
  6. While Claude is responding, click the Codex pane
  7. Send a message to Codex
  8. Verify both produce independent responses
- **Expected outcome:**
  - Both panes operate independently with separate PTY processes. Source of truth: existing pane system architecture -- each pane gets its own `createRequestId` and `terminalId`.
  - No cross-contamination of input/output between the two terminals. Source of truth: WS protocol terminal isolation.
- **Interactions:** Pane splitting, independent PTY spawning, concurrent WS `terminal.input` messages, `terminal.output` routing to correct panes.

#### Test 4: Resume command works from sidebar context menu

- **Name:** Right-clicking a Claude session in the sidebar offers "Copy resume command" that produces the correct command string
- **Type:** scenario
- **Harness:** Live UI on port :5173
- **Preconditions:** At least one Claude session exists in the sidebar (from Test 1).
- **Actions:**
  1. Locate a Claude session in the sidebar
  2. Right-click it to open the context menu
  3. Click "Copy resume command"
  4. Paste the clipboard contents and verify the format
- **Expected outcome:**
  - The copied command is `claude --resume <sessionId>`. Source of truth: extension manifest's `cli.resumeArgs: ["--resume", "{{sessionId}}"]` processed by `buildResumeCommand()` which uses `resumeCommandTemplate` from `ClientExtensionEntry.cli`.
- **Interactions:** `buildResumeCommand()` now derives from extension entries, `isResumeCommandProvider()` checks `ext.cli.supportsResume`, clipboard API.

#### Test 5: Settings view shows all CLI extensions with correct toggle and config controls

- **Name:** Settings view displays enable/disable toggles for all CLI extensions and shows model/sandbox settings for Codex
- **Type:** scenario
- **Harness:** Live UI on port :5173
- **Preconditions:** Server running with all 5 extension manifests loaded.
- **Actions:**
  1. Open Settings (gear icon or context menu)
  2. Scroll to "Coding CLIs" section
  3. Observe the list of enable/disable toggles
  4. Observe the provider-specific settings (permission mode for Claude, model/sandbox for Codex)
  5. Disable Codex
  6. Close Settings
  7. Open pane picker
  8. Verify Codex no longer appears
  9. Reopen Settings, re-enable Codex
  10. Open pane picker
  11. Verify Codex appears again
- **Expected outcome:**
  - Step 3: All CLI extensions that have `getCliProviderConfigs()` results appear as toggles. Initially, all 5 (claude, codex, opencode, gemini, kimi) appear in SettingsView even though only claude and codex are in `enabledProviders`. Source of truth: implementation plan Task 7 -- `getCliProviderConfigs(extensions)` returns all CLI extensions; Task 9 analysis.
  - Step 4: Claude shows a "permission mode" dropdown (manifest: `supportsPermissionMode: true`). Codex shows "model" text field and "sandbox" dropdown (manifest: `supportsModel: true, supportsSandbox: true`). OpenCode/Gemini/Kimi show only the starting directory field. Source of truth: extension manifest fields.
  - Step 8: Codex is hidden from PanePicker after disabling. Source of truth: `enabledProviders` gating in PanePicker.
  - Step 11: Codex reappears after re-enabling. Source of truth: settings persistence.
- **Interactions:** `getCliProviderConfigs()` derives from Redux `extensions.entries`, `updateSettingsLocal()`, settings API PATCH, PanePicker filtering.

#### Test 6: Enable a previously-hidden CLI (e.g., OpenCode) via Settings

- **Name:** Enabling a CLI that was not in the default enabledProviders makes it appear in the PanePicker
- **Type:** scenario
- **Harness:** Live UI on port :5173
- **Preconditions:** Default settings (`enabledProviders: ['claude', 'codex']`).
- **Actions:**
  1. Open pane picker -- verify OpenCode does NOT appear
  2. Open Settings
  3. Find "Enable OpenCode" toggle -- enable it
  4. Close Settings
  5. Open pane picker -- verify OpenCode now appears
- **Expected outcome:**
  - Step 1: OpenCode absent from picker (not in `enabledProviders`). Source of truth: plan Task 9, `knownProviders` migration seeds all 5 names, preserving existing `enabledProviders`.
  - Step 5: OpenCode appears in picker after enabling. Source of truth: `getCliProviderConfigs()` returns it, `enabledProviders` now includes 'opencode', `availableClis.opencode` may be false if not installed -- in that case it still won't appear (availability gate).
- **Interactions:** Settings persistence, `knownProviders` migration safety, PanePicker option filtering.

### Integration Tests

#### Test 7: Extension scan discovers all 5 CLI manifests

- **Name:** Server startup extension scan finds and validates all 5 CLI extension manifests
- **Type:** integration
- **Harness:** Worktree dev server (port 3344)
- **Preconditions:** Worktree has all 5 extension manifest files in `extensions/*/freshell.json`.
- **Actions:**
  1. Start worktree dev server: `PORT=3344 npm run dev:server > /tmp/freshell-3344.log 2>&1 &`
  2. Wait for startup
  3. `curl http://localhost:3344/api/extensions | jq '.[].name'`
- **Expected outcome:**
  - Response includes `"claude"`, `"codex"`, `"opencode"`, `"gemini"`, `"kimi"`. Source of truth: the 5 extension manifest files created in Task 2.
  - All entries have `category: "cli"`. Source of truth: manifest files.
- **Interactions:** `ExtensionManager.scan()`, `ExtensionManifestSchema` validation, `toClientRegistry()` with new `cli` field.

#### Test 8: CLI availability detection derives from extensions

- **Name:** The /api/platform endpoint includes availableClis entries for all registered CLI extensions
- **Type:** integration
- **Harness:** Worktree dev server (port 3344)
- **Preconditions:** Server running on port 3344.
- **Actions:**
  1. `curl http://localhost:3344/api/platform | jq '.availableClis'`
- **Expected outcome:**
  - Response includes keys for all 5 CLI extension names (`claude`, `codex`, `opencode`, `gemini`, `kimi`) with boolean values indicating availability. Source of truth: `detectAvailableClis(cliDetectionSpecs)` built from extensions.
- **Interactions:** `detectAvailableClis()` now takes a parameter derived from extension manifests, `createPlatformRouter` deps.

#### Test 9: WS terminal.create accepts extension-registered modes and rejects unknown ones

- **Name:** WebSocket terminal.create message passes validation for registered CLI modes and fails for unregistered ones
- **Type:** integration
- **Harness:** Worktree dev server (port 3344)
- **Preconditions:** Server running with WsHandler that builds dynamic schema.
- **Actions:**
  1. Connect WS client
  2. Send hello with token
  3. Send `terminal.create` with `mode: 'claude'` -- expect `terminal.created` response
  4. Send `terminal.create` with `mode: 'nonexistent'` -- expect error response
- **Expected outcome:**
  - Step 3: Server accepts mode 'claude' because it's a registered extension. Source of truth: dynamic `refine()` validation in WsHandler constructor.
  - Step 4: Server rejects mode 'nonexistent' with an error message containing "Invalid terminal mode". Source of truth: `refine()` error message format.
- **Interactions:** `CodingCliProviderSchema` widened to `z.string().min(1)`, dynamic `TerminalCreateSchema` in WsHandler, extension registry.

#### Test 10: Settings API accepts dynamically-registered provider names

- **Name:** PATCH /api/settings accepts enabledProviders and provider configs for extension-registered CLI names
- **Type:** integration
- **Harness:** Worktree dev server (port 3344)
- **Preconditions:** Server running on port 3344.
- **Actions:**
  1. `curl -X PATCH http://localhost:3344/api/settings -H 'Content-Type: application/json' -d '{"codingCli":{"enabledProviders":["claude","codex","opencode"]}}'`
  2. Verify 200 response
  3. `curl -X PATCH http://localhost:3344/api/settings -H 'Content-Type: application/json' -d '{"codingCli":{"enabledProviders":["invalid_provider"]}}'`
  4. Verify 400 response
- **Expected outcome:**
  - Step 2: Settings accepted with all 3 providers. Source of truth: dynamic `SettingsPatchSchema` accepts extension-registered names.
  - Step 4: Settings rejected for unknown provider. Source of truth: `z.string().refine()` validation against `validProviderNames` set.
- **Interactions:** `createSettingsRouter` deps with `validProviderNames`, `SettingsPatchSchema` built dynamically.

#### Test 11: knownProviders migration preserves existing enabledProviders

- **Name:** First run after refactor seeds knownProviders without modifying enabledProviders
- **Type:** integration
- **Harness:** Worktree dev server (port 3344)
- **Preconditions:** Config file has `enabledProviders: ['claude', 'codex']` and no `knownProviders` field.
- **Actions:**
  1. Start server on port 3344
  2. Read config: `curl http://localhost:3344/api/settings | jq '.codingCli'`
  3. Verify `enabledProviders` is still `['claude', 'codex']`
  4. Verify `knownProviders` contains all 5 CLI names
- **Expected outcome:**
  - `enabledProviders` unchanged at `['claude', 'codex']`. Source of truth: migration logic in plan Task 9 -- when `knownProviders` is absent, seed it with ALL CLI names but don't modify `enabledProviders`.
  - `knownProviders` contains `['claude', 'codex', 'opencode', 'gemini', 'kimi']`. Source of truth: migration code seeds from `extensionManager.getAll()`.
- **Interactions:** `configStore.patchSettings()`, extension scan, server startup sequence.

#### Test 12: New extension auto-enables on subsequent server restart

- **Name:** Dropping a new extension folder and restarting adds it to both knownProviders and enabledProviders
- **Type:** integration
- **Harness:** Worktree dev server (port 3344)
- **Preconditions:** Server has run once (knownProviders exists). A new extension `test-cli` is added.
- **Actions:**
  1. Create `extensions/test-cli/freshell.json` with `{"name":"testcli","version":"1.0.0","label":"Test CLI","description":"Test","category":"cli","cli":{"command":"echo"}}`
  2. Restart server on port 3344
  3. `curl http://localhost:3344/api/settings | jq '.codingCli'`
  4. Verify `testcli` is in both `knownProviders` and `enabledProviders`
  5. Clean up: remove `extensions/test-cli`
- **Expected outcome:**
  - `testcli` appears in both arrays. Source of truth: auto-enable logic -- new CLI not in `knownProviders` gets added to both.
- **Interactions:** Extension scan, `knownProviders` comparison, `configStore.patchSettings()`.

### Regression Tests

#### Test 13: Full vitest suite passes

- **Name:** All existing tests pass after the refactoring
- **Type:** regression
- **Harness:** Vitest regression harness
- **Preconditions:** All code changes committed to the worktree.
- **Actions:**
  1. `cd /home/user/code/freshell/.worktrees/extensions-system && npm test`
- **Expected outcome:**
  - All tests pass (0 failures). Source of truth: existing test suite is the regression baseline.
- **Interactions:** All changed modules: `terminal-registry.ts`, `platform.ts`, `ws-protocol.ts`, `ws-handler.ts`, `coding-cli-utils.ts`, `coding-cli-types.ts`, `settingsSlice.ts`, `settings-router.ts`, `PanePicker.tsx`, `PaneContainer.tsx`, `SettingsView.tsx`, `derivePaneTitle.ts`, `deriveTabName.ts`, `session-type-utils.ts`, `session-utils.ts`, `TabsView.tsx`, `PaneIcon.tsx`, `menu-defs.ts`, `ContextMenuProvider.tsx`.

#### Test 14: TypeScript compilation succeeds

- **Name:** `tsc --noEmit` produces no type errors
- **Type:** regression
- **Harness:** TypeScript compiler
- **Preconditions:** All code changes committed.
- **Actions:**
  1. `npx tsc --noEmit`
- **Expected outcome:**
  - Zero type errors. Source of truth: TypeScript compiler is the authority on type safety.
- **Interactions:** `TerminalMode` widened to `'shell' | string`, `CodingCliProviderName` widened to `string`, function signatures changed to accept `extensions` parameter.

#### Test 15: Extension manifest validation rejects invalid manifests

- **Name:** ExtensionManifestSchema rejects manifests with invalid CLI fields
- **Type:** regression
- **Harness:** Vitest (existing extension-system.test.ts pattern)
- **Preconditions:** Updated `CliConfigSchema` with new fields.
- **Actions:**
  1. Parse a manifest with `supportsPermissionMode: "yes"` (wrong type) -- expect failure
  2. Parse a manifest with `resumeArgs: "not-array"` (wrong type) -- expect failure
  3. Parse a manifest with valid optional fields -- expect success
- **Expected outcome:**
  - Invalid manifests rejected by Zod strict schema. Source of truth: `CliConfigSchema` definition.
- **Interactions:** `z.strictObject()` rejects unknown keys, `.optional()` allows omission.

#### Test 16: Existing extension system test still passes

- **Name:** The integration test for server extensions (discover, start, query, stop) still works
- **Type:** regression
- **Harness:** Vitest
- **Preconditions:** `test/integration/extension-system.test.ts` exists.
- **Actions:**
  1. Run `npx vitest run test/integration/extension-system.test.ts`
- **Expected outcome:**
  - Both test cases pass. Source of truth: existing test assertions.
- **Interactions:** `ExtensionManager.scan()`, `toClientRegistry()` (now with `cli` field).

### Boundary Tests

#### Test 17: CLI extension with no resumeArgs has no resume support

- **Name:** A CLI extension without resumeArgs does not offer resume functionality
- **Type:** boundary
- **Harness:** Live UI on port :5173
- **Preconditions:** OpenCode extension has no `resumeArgs` in its manifest.
- **Actions:**
  1. If OpenCode is available and enabled, create an OpenCode session
  2. Find the session in the sidebar
  3. Right-click the session
  4. Verify "Copy resume command" is NOT available (or grayed out)
- **Expected outcome:**
  - Resume command not available for OpenCode. Source of truth: OpenCode manifest lacks `resumeArgs`, so `isResumeCommandProvider()` returns false and `buildResumeCommand()` returns null.
- **Interactions:** `ClientExtensionEntry.cli.supportsResume` is false for OpenCode.

#### Test 18: PanePicker does not show CLI extensions with ext: prefix

- **Name:** CLI extensions appear only in the CLI options section, never with the ext: prefix
- **Type:** boundary
- **Harness:** Live UI on port :5173
- **Preconditions:** Server running with CLI and possibly non-CLI extensions.
- **Actions:**
  1. Open pane picker
  2. Inspect all visible options
  3. Count how many times "Claude CLI" appears
- **Expected outcome:**
  - "Claude CLI" appears exactly once. No option labeled "Claude CLI" has an `ext:` prefix. Source of truth: implementation plan -- `extensionOptions` filters out `category === 'cli'`.
- **Interactions:** PanePicker `extensionOptions` builder, `cliOptions` builder.

### Invariant Tests

#### Test 19: codingCliCommands map contains all 5 expected entries at startup

- **Name:** After server startup, the codingCliCommands map has entries for all hardcoded CLIs that were migrated
- **Type:** invariant
- **Harness:** Worktree dev server log inspection
- **Preconditions:** Server starting with all 5 extension manifests.
- **Actions:**
  1. Check server startup logs for "Extension scan complete"
  2. Verify the log shows `count: 5` (or more, if additional extensions exist) and names include all 5
- **Expected outcome:**
  - Log entry shows all 5 names. Source of truth: `ExtensionManager.scan()` log output.
- **Interactions:** Extension scanning, manifest validation, registration.

---

## Coverage Summary

### Covered areas:
- **Extension manifest loading and validation** (Tests 7, 15, 16, 19)
- **CLI command registration from extensions** (Tests 7, 8, 19)
- **PanePicker UI with extension-derived options** (Tests 1, 2, 5, 6, 18)
- **Terminal creation via WS protocol** (Tests 1, 2, 3, 9)
- **PTY spawning with extension-derived commands** (Tests 1, 2, 3)
- **Settings persistence and migration** (Tests 5, 6, 10, 11, 12)
- **Resume command derivation** (Tests 4, 17)
- **Side-by-side independent operation** (Test 3)
- **Full regression suite** (Tests 13, 14)
- **Existing extension system tests** (Test 16)
- **Dynamic WS schema validation** (Test 9)
- **Settings API schema validation** (Test 10)

### Explicitly excluded per strategy:
- **Automated browser tests:** The user specified manual UI validation via Chrome. No Playwright or browser_use automation is built. Risk: manual tests are non-repeatable. Mitigation: the existing vitest regression suite catches most regressions; manual tests validate the integration layer.
- **Session indexing tests:** Session file parsing (`server/coding-cli/providers/`) is orthogonal to the extension system and unchanged. Risk: minimal.
- **Non-CLI extension tests:** The refactoring does not modify client or server extension behavior. Risk: minimal; Test 16 covers the existing server extension lifecycle.
- **Performance benchmarks:** The refactoring replaces static record lookups with Map lookups (same O(1) complexity) and adds a startup scan. No performance risk warranting benchmarks.
