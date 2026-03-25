# Test Plan: Kimi First-Class CLI

**Feature:** Make Kimi a first-class Freshell CLI: accurate picker/settings controls, persisted launch settings, indexed sessions in the sidebar and session directory, live association, and restart resume.

**Strategy reconciliation:** The implementation plan does not change the agreed testing strategy's cost or tooling. It stays inside the existing Vitest unit/integration/e2e stack and reuses the current React Testing Library + Redux, Express + supertest, and chokidar-backed indexer harnesses. Two non-material refinements are needed so the highest-value checks are actually writable: extract manifest-to-command-spec compilation into a pure helper, and add a realistic Kimi share-dir fixture corpus. No strategy changes require user approval.

---

## Harness Requirements

1. **Harness:** `Manifest-to-command-spec compiler seam`
- **What it does:** Moves extension-manifest -> `CodingCliCommandSpec` compilation out of `server/index.ts` into a pure helper so manifest-driven Kimi launch behavior can be asserted without booting the full server.
- **What it exposes:** A pure API such as `buildCliCommandSpecsFromEntries(entries)` that returns runtime specs with compiled `modelArgs`, `permissionModeArgsByValue`, and `resumeArgs`.
- **Estimated complexity to build:** Low to medium.
- **Tests that depend on it:** 8, 9, 11.

2. **Harness:** `Kimi fixture share-dir corpus`
- **What it does:** Provides a realistic `KIMI_SHARE_DIR` tree with `kimi.json`, hashed session directories, modern `context.jsonl`, legacy flat transcripts, `wire.jsonl`, `metadata.json`, and ignored rotated/subagent transcript files.
- **What it exposes:** A reusable on-disk fixture rooted at `test/fixtures/coding-cli/kimi/...`, authoritative transcript paths for `sourceFile`, and fixture cases for metadata precedence, named session IDs, hidden-content filtering, and live file mutation.
- **Estimated complexity to build:** Medium.
- **Tests that depend on it:** 5, 6, 7.

All other required harnesses already exist and should be reused as-is: the RTL/Redux `ExtensionsView` harness, the RTL/Redux `directory-picker-flow` and `open-tab-session-sidebar-visibility` app harnesses, the `CodingCliSessionIndexer` temp-dir harness, the `SessionAssociationCoordinator` + `TerminalRegistry` integration harness, and the Express + supertest `session-directory-router` harness.

---

## Test Plan

### 1. Restored Kimi sessions reappear in the left sidebar after server reset

- **Name:** Restored Kimi tab bootstrap shows the indexed Kimi session exactly once under the correct project after server reset
- **Type:** scenario
- **Disposition:** extend
- **Harness:** Existing app bootstrap/sidebar harness in `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
- **Preconditions:** A restored tab/pane exists with `mode: 'kimi'`, `resumeSessionId: 'kimi-session-1'`, and a pane title from the prior session. `fetchSidebarSessionsSnapshot()` returns an indexed Kimi project containing the same session ID and title.
- **Actions:** Render `App`, let `/api/bootstrap` complete, and let the sidebar snapshot fetch resolve.
- **Expected outcome:**
  Source of truth: user bug report ("Kimi sessions don't appear ... or restore when the server is reset") plus the implementation plan "User-Visible Target" bullets for indexed Kimi sessions and restored panes.
  The sidebar renders the indexed Kimi session title, not only the tab fallback title.
  The title appears once in the sidebar's project list, under the Kimi session's project label.
  The sidebar also renders other indexed sessions from the snapshot, proving it is using indexed data rather than only restored tab state.
  Supporting diagnostic assertion: the restored Kimi pane retains its `resumeSessionId`, so the visible sidebar row is anchored to the indexed session identity.
- **Interactions:** Bootstrap API, sidebar snapshot fetch, sessions slice hydration, sidebar selectors, restored pane/tab state.

### 2. Live Kimi terminals gain durable session binding when the indexed session appears

- **Name:** A running Kimi terminal binds to the indexed Kimi session as soon as indexing discovers it
- **Type:** integration
- **Disposition:** extend
- **Harness:** Existing `TerminalRegistry` + `SessionAssociationCoordinator` integration harness in `test/server/session-association.test.ts`
- **Preconditions:** A terminal exists with `mode: 'kimi'` and `cwd: '/repo/root/packages/app'`, but no `resumeSessionId`. A later indexer update contains a Kimi session with the same `cwd`, project, and a recent `lastActivityAt`.
- **Actions:** Run the association flow against the indexed projects/update.
- **Expected outcome:**
  Source of truth: implementation plan "User-Visible Target" bullet "New Kimi terminals get durable session binding once the indexed Kimi session appears" and "Contracts And Invariants" 1, 3, 11, and 13.
  The Kimi terminal gains `resumeSessionId: 'kimi-session-1'`.
  The binding is recorded as an association event, not a fallback-only visual artifact.
  The association does not require Claude-only repair/history code paths.
- **Interactions:** `modeSupportsResume`, `SessionAssociationCoordinator`, `TerminalRegistry`, binding authority, terminal session events.

### 3. Kimi can be launched from the pane picker with a persisted starting directory

- **Name:** Picking Kimi from the pane picker launches a Kimi terminal in the chosen directory and persists that directory
- **Type:** scenario
- **Disposition:** extend
- **Harness:** Existing RTL/Redux picker flow harness in `test/e2e/directory-picker-flow.test.tsx`
- **Preconditions:** The extension registry includes Kimi, `availableClis.kimi === true`, and `enabledProviders` contains `kimi`.
- **Actions:** Open the picker, choose Kimi, enter a directory, confirm it, and complete directory validation.
- **Expected outcome:**
  Source of truth: implementation plan "User-Visible Target" bullets for Kimi appearing in the picker and saved Kimi settings affecting later launches.
  The picker pane is replaced with `{ kind: 'terminal', mode: 'kimi', initialCwd: <confirmed path> }`.
  The settings patch persists `codingCli.providers.kimi.cwd` to the confirmed path.
  No other provider's settings are mutated as a side effect.
- **Interactions:** PanePicker option filtering, directory validation API, pane reducer path, settings thunk persistence.

### 4. Kimi settings expose only supported permission modes and provider-appropriate copy

- **Name:** Kimi's Extensions settings card shows starting directory, model, only `Default` and `Bypass permissions`, and saving bypass mode patches Kimi settings
- **Type:** integration
- **Disposition:** extend
- **Harness:** Existing RTL/Redux `ExtensionsView` harness in `test/unit/client/components/ExtensionsView.test.tsx`
- **Preconditions:** The client extension registry contains a Kimi CLI entry with `supportsModel: true`, `supportsPermissionMode: true`, and `supportedPermissionModes: ['default', 'bypassPermissions']`.
- **Actions:** Render `ExtensionsView`, expand the Kimi card, inspect the fields, choose `bypassPermissions`, and enter a Kimi model value.
- **Expected outcome:**
  Source of truth: implementation plan "User-Visible Target" bullets for the Kimi settings card and "Contracts And Invariants" 11 and 12.
  The card renders `Kimi starting directory`, `Kimi model`, and a permission-mode select with only `Default` and `Bypass permissions`.
  The model input placeholder uses Kimi-appropriate or provider-neutral copy, not Claude-specific copy.
  Changing the permission mode patches `codingCli.providers.kimi.permissionMode` to `bypassPermissions`.
  Changing the model patches `codingCli.providers.kimi.model`.
- **Interactions:** Managed-items selector output, `ExtensionsView` field rendering, debounced settings save path, server settings patch shape.

### 5. Kimi transcript search works through the real session-directory HTTP route

- **Name:** Session-directory search finds Kimi by visible user and assistant transcript text while honoring metadata title and archive state
- **Type:** integration
- **Disposition:** extend
- **Harness:** Existing Express + supertest router harness in `test/integration/server/session-directory-router.test.ts`, backed by the new Kimi fixture corpus
- **Preconditions:** The indexed projects include a Kimi session whose `sourceFile` points to a real Kimi transcript fixture. The fixture includes a visible user message token, a visible assistant message token, hidden `_system_prompt`, `_checkpoint`, `_usage`, or `think` content that should not be searchable, and `metadata.json` title/archive state.
- **Actions:** Issue three GETs:
  1. `/api/session-directory?...&tier=userMessages&query=<visible-user-token>`
  2. `/api/session-directory?...&tier=fullText&query=<visible-assistant-token>`
  3. `/api/session-directory?...&tier=fullText&query=<hidden-token>`
- **Expected outcome:**
  Source of truth: implementation plan "User-Visible Target" bullet for Kimi session-directory search and "Contracts And Invariants" 5, 7, 8, 9, and 14.
  Request 1 returns the Kimi session with `matchedIn: 'userMessage'`.
  Request 2 returns the Kimi session with `matchedIn: 'assistantMessage'`.
  Request 3 returns no Kimi result, proving hidden/system content is excluded from search.
  The returned row's title and archived state match `metadata.json` precedence, not weaker fallbacks.
- **Interactions:** Sessions router, session-directory service, file-based search, Kimi `parseEvent()`, transcript `sourceFile` lookup.

### 6. Kimi direct-provider refresh updates live sidebar data without a full rescan

- **Name:** Kimi indexer refresh updates title/archive state and transcript lookup when metadata or wire files change
- **Type:** invariant
- **Disposition:** extend
- **Harness:** Existing temp-dir + chokidar `CodingCliSessionIndexer` harness in `test/unit/server/coding-cli/session-indexer.test.ts`, backed by the new Kimi fixture corpus
- **Preconditions:** The indexer is started with a Kimi provider whose fixture session initially has a fallback title and an authoritative `context.jsonl` `sourceFile`.
- **Actions:** Refresh once, then mutate Kimi title/archive sources on disk:
  1. edit `metadata.json`
  2. edit `wire.jsonl`
  3. optionally touch the authoritative transcript file
  and let the watcher-driven refresh complete without forcing a full scan.
- **Expected outcome:**
  Source of truth: implementation plan "User-Visible Target" bullet for persisted metadata behavior and "Contracts And Invariants" 5, 7, 9, 14, 15, and 18.
  `getFilePathForSession('kimi-session-1', 'kimi')` returns the authoritative transcript path.
  The indexed title and archived flag update after the file change without manual full-scan intervention.
  A `wire.jsonl` title outranks the context fallback after it appears.
  Rotated backup/subagent transcripts never become standalone indexed sessions.
- **Interactions:** Direct-provider dirty-provider invalidation, `sessionKeyToFilePath` cache, chokidar watcher, project diffing, sidebar/session-directory consumers of indexed data.

### 7. Kimi provider reads real share-dir layouts and strips hidden transcript noise

- **Name:** Kimi provider lists modern and legacy sessions, preserves named session IDs, and only emits visible message text
- **Type:** unit
- **Disposition:** new
- **Harness:** New fixture-backed provider harness in `test/unit/server/coding-cli/kimi-provider.test.ts`
- **Preconditions:** The Kimi fixture share-dir includes `kimi.json` workdir metadata, modern `<sessionDir>/context.jsonl`, legacy `<sessionsDir>/<sessionId>.jsonl`, `wire.jsonl`, optional `metadata.json`, named/non-UUID session IDs, and hidden/system/think transcript records.
- **Actions:** Instantiate `KimiProvider` against the fixture root, call `listSessionsDirect()`, and feed representative transcript lines to `parseEvent()`.
- **Expected outcome:**
  Source of truth: implementation plan "User-Visible Target" bullets for disk discovery and search plus "Contracts And Invariants" 2 through 10.
  `listSessionsDirect()` returns Kimi sessions with opaque session IDs unchanged, correct `cwd`, correct `projectPath`, and authoritative `sourceFile`.
  `metadata.json` title/archive wins when present and not `"Untitled"`.
  `wire.jsonl` title is used before transcript fallback when metadata is absent.
  Legacy flat transcripts are still returned as sessions.
  `parseEvent()` emits user/assistant events for visible text only and drops `_system_prompt`, `_checkpoint`, `_usage`, and assistant `think` blocks.
  `supportsLiveStreaming()` stays `false`; `supportsSessionResume()` is `true`.
- **Interactions:** Filesystem layout helpers, workdir hashing, title utils, git-root resolution, normalized event contract.

### 8. CLI manifests accept Kimi's value-specific permission mapping

- **Name:** The extension manifest schema accepts Kimi's permission-mode subset and resume template without widening the generic client contract
- **Type:** unit
- **Disposition:** extend
- **Harness:** Existing manifest schema unit harness in `test/unit/server/extension-manifest.test.ts`
- **Preconditions:** A CLI manifest object declares `permissionModeArgsByValue`, `modelArgs`, and `resumeArgs` for Kimi.
- **Actions:** Parse the manifest with `ExtensionManifestSchema.safeParse(...)`.
- **Expected outcome:**
  Source of truth: implementation plan "User-Visible Target" launch/settings bullets and "Contracts And Invariants" 11 through 13 and 17.
  The schema accepts `permissionModeArgsByValue` for canonical permission values only.
  The manifest still rejects unrelated unknown keys, preserving the extension manifest contract.
- **Interactions:** Zod schema validation, canonical permission-mode value set.

### 9. Manifest-driven command compilation and spawn specs produce Kimi `--model`, `--yolo`, and `--session`

- **Name:** Kimi launch and resume args come from manifest-compiled runtime specs, not ad hoc server fallbacks
- **Type:** regression
- **Disposition:** new
- **Harness:** New compiler seam in `test/unit/server/coding-cli/command-specs.test.ts`, plus existing spawn-spec assertions in `test/unit/server/terminal-registry.test.ts`
- **Preconditions:** A Kimi CLI extension entry declares `modelArgs`, `permissionModeArgsByValue.bypassPermissions`, and `resumeArgs`.
- **Actions:** Compile runtime command specs from the manifest entry, register or use them, and build a Kimi spawn spec with `model`, `permissionMode: 'bypassPermissions'`, and `resumeSessionId`.
- **Expected outcome:**
  Source of truth: implementation plan "User-Visible Target" bullets for saved Kimi settings and restored Kimi panes plus "Contracts And Invariants" 3, 11, 13, and 17.
  The compiled runtime spec generates `['--model', <model>]`, `['--yolo']`, and `['--session', <sessionId>]`.
  The resulting spawn args contain all three Kimi-specific behaviors together in one launch.
  The proof comes from manifest-compiled runtime specs; fallback specs remain compatibility-only.
- **Interactions:** Extension entries, command-spec compiler seam, terminal-registry spawn logic, fallback command spec compatibility.

### 10. Client registry and selector coerce Kimi to supported permission values only

- **Name:** Kimi client registry exposes only supported permission modes and stale unsupported saved values render as `default`
- **Type:** regression
- **Disposition:** extend
- **Harness:** Existing `ExtensionManager` and `managed-items` unit harnesses in `test/unit/server/extension-manager.test.ts` and `test/unit/client/store/managed-items.test.ts`
- **Preconditions:** A scanned Kimi manifest exposes only `default` and `bypassPermissions`, while saved settings still contain an unsupported value such as `plan`.
- **Actions:** Scan the manifest into the client registry and run the managed-items selector over settings containing the stale value.
- **Expected outcome:**
  Source of truth: implementation plan "Contracts And Invariants" 11 and 12.
  The client registry exposes `supportedPermissionModes: ['default', 'bypassPermissions']`.
  The selector returns `permissionMode: 'default'` as the rendered field value.
  The rendered options include only the supported subset.
- **Interactions:** Extension scan and serialization, client extension registry shape, settings selector coercion.

### 11. Resume-capable manifests and registered providers stay in lockstep

- **Name:** Any built-in CLI that advertises resume support must also have a registered session provider, including Kimi
- **Type:** invariant
- **Disposition:** new
- **Harness:** New provider-registry guardrail in `test/unit/server/coding-cli/provider-registry.test.ts`
- **Preconditions:** The builtin extensions directory is scanned and the builtin provider registry module is loaded.
- **Actions:** Compute the set of builtin CLI manifests with `resumeArgs` and compare it to the registered provider names.
- **Expected outcome:**
  Source of truth: implementation plan "Contracts And Invariants" 1 and 13.
  Every resume-capable builtin CLI name is present in the provider registry.
  Kimi is included only after provider registration and manifest resume support land together.
- **Interactions:** Builtin extension scan, centralized provider registry, startup invariants.

### 12. Repo-wide regression gates stay green

- **Name:** Kimi first-class CLI changes pass lint, typecheck, and the coordinated repo suite
- **Type:** regression
- **Disposition:** existing
- **Harness:** Repo coordinator and build/lint scripts
- **Preconditions:** All targeted Kimi tests above are green.
- **Actions:** Run:
  1. `npm run test:status`
  2. `npm run lint`
  3. `FRESHELL_TEST_SUMMARY="Kimi first-class CLI" npm run check`
- **Expected outcome:**
  Source of truth: repo merge policy in `AGENTS.md` and implementation plan Task 3 final verification.
  The coordinator is available or respected before the broad run.
  Lint passes.
  Typecheck and the coordinated full test suite pass.
- **Interactions:** Whole-repo static analysis, default and server test configs, shared coordinator state.

---

## Coverage Summary

### Covered action space

- Kimi picker availability, directory selection, and launch-state persistence.
- Kimi settings UI and selector behavior, including supported permission subset, model copy, and saved provider settings.
- Manifest-driven runtime launch and resume compilation for `--model`, `--yolo`, and `--session`.
- Kimi provider disk discovery across modern and legacy layouts, opaque session IDs, title/archive precedence, and visible-text normalization.
- Direct-provider indexing behavior: `sourceFile` lookup, live invalidation on metadata/title inputs, and ignored rotated transcript files.
- Live terminal-to-session association and restored-sidebar bootstrap behavior, covering both original user-reported failures.
- Session-directory HTTP search for Kimi across `userMessages` and `fullText`.
- Provider-registry invariants that prevent future "resume without provider" partial integrations.
- Full repo lint, typecheck, and regression gates.

### Explicit exclusions

- Claude-only repair, history loading, and live session-manager streaming remain excluded, per the implementation plan's out-of-scope section.
- No browser screenshot-diff coverage is added because the relevant user-visible surfaces already have stable structured assertions through DOM text, Redux state, and HTTP JSON.
- `docs/index.html` is not given a separate automated assertion. It is a nonfunctional mock and low-risk documentation surface; the risk is stale copy, not functional regression.

### Residual risks from exclusions

- If `docs/index.html` is updated incorrectly, the shipped mock experience could drift from reality without automated detection.
- Because Kimi remains terminal-mode only, any future attempt to infer live Kimi sessions from stdout would need a separate test strategy; this plan deliberately does not cover that unsupported surface.
