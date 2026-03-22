# Kimi First-Class CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Kimi a fully supported terminal-mode CLI in Freshell: it must appear in picker/settings with accurate launch controls, its sessions must index into the sidebar/session directory, and restored Kimi tabs must resume after server restart.

**Architecture:** Keep Freshell's current split between extension manifests (launch-time capabilities) and handwritten session providers, but close the two gaps that made Kimi partial. Add a real `KimiProvider` wired through a centralized provider registry for session discovery/search/binding, and extend the CLI manifest launch compiler with value-specific permission-mode mappings plus supported-mode subsets so Kimi can expose accurate model and permission settings without special UI branches. This lands Kimi in the same steady-state contract as Claude/Codex/OpenCode while adding one invariant test that any built-in CLI extension advertising resume support also has a registered session provider.

**Tech Stack:** Node.js, TypeScript, Express, React, Redux Toolkit, Vitest, React Testing Library

---

**Execution note:** Use @trycycle-executing and keep the red-green-refactor order below. Execute in `/home/user/code/freshell/.worktrees/trycycle-kimi-first-class-cli`.

## User-Visible Target

After this lands:

- Kimi appears in the pane picker when its CLI is available and enabled.
- The Extensions settings card for Kimi shows starting directory, model, and only the permission modes Kimi actually supports: `Default` and `Bypass permissions`.
- Saved Kimi settings affect later launches: model adds `--model`, bypass mode adds `--yolo`, and restored tabs resume via `--session <id>`.
- New Kimi terminals get durable session binding once the indexed Kimi session appears, so the left sidebar shows the live session under the correct project and marks it running.
- After a server restart, restored Kimi panes reuse their saved `resumeSessionId`, spawn a resumed Kimi session, and rehydrate into the same sidebar session instead of becoming orphaned terminals.
- Session-directory `title`, `userMessages`, and `fullText` search works for Kimi by scanning persisted session transcripts.
- Claude-only repair/history behavior remains Claude-only. This task does not widen `sessionRepairService` or `session-history-loader` to non-Claude providers.

## Contracts And Invariants

1. A CLI is not "first class" unless both layers exist: manifest launch metadata and a registered `CodingCliProvider`.
2. Kimi home resolution uses `process.env.KIMI_SHARE_DIR` when present, otherwise `~/.kimi`. Do not invent or rely on `KIMI_HOME`.
3. Indexed Kimi sessions must carry `sourceFile` pointing at the persisted message transcript (`context.jsonl`), because session-directory search reuses `provider.parseEvent(...)` against that file.
4. Kimi titles and timestamps must come from semantic session data (`context.jsonl` plus sibling wire/event data), not directory names or filesystem mtimes alone.
5. The generic permission-mode UI must never advertise unsupported Kimi choices. Kimi may only surface `default` and `bypassPermissions`; `bypassPermissions` must launch `--yolo`.
6. `modeSupportsResume('kimi')` must become true through the same manifest-driven path as other CLIs. Do not special-case Kimi in sidebar or restore consumers.
7. Direct-provider invalidation must trigger when Kimi session transcripts or Kimi workdir metadata change; otherwise new sessions will still disappear from the sidebar until a manual refresh.
8. This task does not change `server/session-history-loader.ts` or `server/session-scanner/service.ts`. If a later feature needs non-Claude repair/history, treat that as separate work.

## Root Cause Summary

- Kimi currently exists only as a spawnable extension manifest, so it can open a terminal but never enters the session indexer/session manager/provider stack.
- Because the manifest omits `resumeArgs`, `modeSupportsResume('kimi')` is false. That blocks restart restore, automatic session association, and durable `resumeSessionId` propagation.
- The current manifest schema can only say "template the selected permission mode into a flag" or "map it into one env var". Kimi needs "only `bypassPermissions` emits `--yolo`", and the UI should only offer the supported subset.
- The sidebar mostly renders indexed sessions, not raw open terminals. Without a Kimi provider, server restart drops Kimi from the left panel even if the user still has restored Kimi panes.

## Strategy Gate

**Chosen approach:** implement Kimi as a real direct session provider and slightly strengthen the manifest launch contract.

- A direct provider fits Kimi's storage model better than a file-glob parser because project-path resolution depends on Kimi's workdir metadata, not only on transcript paths.
- A small manifest/runtime extension, `supportedPermissionModes` plus value-specific permission args, solves the picker/settings parity gap without adding Kimi-specific UI branches.
- Centralizing provider registration in one module plus a guardrail invariant test closes the exact ergonomics hole that allowed Kimi to ship as launch-only support.

**Rejected approaches:**

- **Manifest-only fix:** adding `resumeArgs` alone would make `modeSupportsResume('kimi')` true, but the sidebar/session directory would still never discover Kimi sessions because the provider layer would remain absent.
- **Hardcode `--yolo` in `terminal-registry.ts` without manifest changes:** fixes one CLI but repeats the architecture bug. Launch behavior must continue to flow from extension metadata.
- **Generalize all session discovery into manifests right now:** that is the broader architecture issue already filed separately. It is larger than this feature and would delay landing Kimi's requested end state.
- **Reuse Claude's full permission dropdown unchanged for Kimi:** misleading. Kimi does not have distinct plan/accept-edits modes, so the UI must surface only the supported subset.
- **Touch Claude-only repair/history code:** unnecessary and risky. Kimi restore needs provider plus resume wiring, not Claude's orphan-repair subsystem.

No user decision is required.

## File Structure

### Files to Create

1. `server/coding-cli/providers/kimi.ts`
   Kimi direct provider: share-dir resolution, workdir-hash lookup, session enumeration, metadata synthesis, and dual-format event parsing for live stream output plus persisted context transcripts.
2. `server/coding-cli/providers/index.ts`
   Single export point for session-aware providers and provider-name lookup used by server bootstrap and invariant tests.
3. `test/unit/server/coding-cli/kimi-provider.test.ts`
   Provider contract coverage for share-dir resolution, direct listing, semantic metadata, and `parseEvent()` behavior.
4. `test/unit/server/coding-cli/provider-registry.test.ts`
   Guardrail that built-in resume-capable CLI manifests have registered session providers.
5. `test/fixtures/coding-cli/kimi/...`
   Fixture share-dir tree with Kimi session directories, `context.jsonl`, wire/event transcript(s), and workdir metadata.

### Files to Modify

1. `extensions/kimi/freshell.json`
   Upgrade Kimi from launch-only metadata to first-class launch capabilities: resume, model, supported permission modes, and `--yolo` mapping.
2. `server/extension-manifest.ts`
   Add CLI manifest fields for supported permission-mode subsets and value-specific permission-mode args.
3. `shared/extension-types.ts`
   Send the new CLI capability fields to the client registry.
4. `server/extension-manager.ts`
   Serialize the new manifest capability fields into `ClientExtensionEntry`.
5. `src/store/managed-items.ts`
   Build Kimi's settings controls from extension metadata, including filtering permission options to the supported subset.
6. `server/index.ts`
   Use the centralized provider registry and compile the new launch-capability fields into `CodingCliCommandSpec`.
7. `server/terminal-registry.ts`
   Add Kimi fallback launch metadata and extend runtime command resolution to honor value-specific permission args.
8. `server/spawn-spec.ts`
   Keep the standalone spawn-spec path in sync with runtime launch resolution.
9. `test/unit/server/extension-manifest.test.ts`
10. `test/unit/server/extension-manager.test.ts`
11. `test/unit/client/store/managed-items.test.ts`
12. `test/unit/client/components/ExtensionsView.test.tsx`
13. `test/e2e/directory-picker-flow.test.tsx`
14. `test/unit/server/coding-cli/session-indexer.test.ts`
15. `test/unit/server/session-directory/service.test.ts`
16. `test/unit/server/terminal-registry.test.ts`
17. `test/server/session-association.test.ts`
18. `docs/index.html`

### Files Expected To Stay Unchanged

- `server/session-history-loader.ts`
- `server/session-scanner/service.ts`
- `src/store/selectors/sidebarSelectors.ts`

Those paths already consume provider/indexed-session data generically. If they fail after the provider work lands, fix the actual contract break instead of preemptively editing them.

## Task 1: Extend The Launch-Capability Contract For Kimi Settings

**Files:**
- Modify: `extensions/kimi/freshell.json`
- Modify: `server/extension-manifest.ts`
- Modify: `shared/extension-types.ts`
- Modify: `server/extension-manager.ts`
- Modify: `src/store/managed-items.ts`
- Test: `test/unit/server/extension-manifest.test.ts`
- Test: `test/unit/server/extension-manager.test.ts`
- Test: `test/unit/client/store/managed-items.test.ts`
- Test: `test/unit/client/components/ExtensionsView.test.tsx`

- [ ] **Step 1: Add the failing manifest and settings-surface tests**

Add red coverage for the missing capability contract:

```ts
// test/unit/server/extension-manifest.test.ts
it('accepts supportedPermissionModes and value-specific permission args for CLI manifests', () => {
  const result = ExtensionManifestSchema.safeParse({
    ...validCliManifest,
    cli: {
      command: 'kimi',
      resumeArgs: ['--session', '{{sessionId}}'],
      modelArgs: ['--model', '{{model}}'],
      supportedPermissionModes: ['default', 'bypassPermissions'],
      permissionModeArgsByValue: {
        bypassPermissions: ['--yolo'],
      },
      supportsPermissionMode: true,
      supportsModel: true,
    },
  })
  expect(result.success).toBe(true)
})
```

```ts
// test/unit/client/store/managed-items.test.ts
it('filters Kimi permission options to the supported subset while still exposing model and cwd', () => {
  const kimiExt: ClientExtensionEntry = {
    name: 'kimi',
    version: '1.0.0',
    label: 'Kimi',
    description: 'Kimi CLI agent',
    category: 'cli',
    cli: {
      supportsModel: true,
      supportsPermissionMode: true,
      supportedPermissionModes: ['default', 'bypassPermissions'],
      supportsResume: true,
      resumeCommandTemplate: ['kimi', '--session', '{{sessionId}}'],
    },
  }

  const items = selectManagedItems(makeState({
    entries: [kimiExt],
    enabledProviders: ['kimi'],
    providers: { kimi: { model: 'moonshot-k2', permissionMode: 'bypassPermissions' } },
  }))

  const permission = items[0].config.find((field) => field.key === 'permissionMode')
  const model = items[0].config.find((field) => field.key === 'model')
  expect(permission?.options?.map((option) => option.value)).toEqual(['default', 'bypassPermissions'])
  expect(model?.value).toBe('moonshot-k2')
})
```

Add `ExtensionsView` coverage that expanding the Kimi card shows model, permission mode, and starting directory, and that choosing `bypassPermissions` PATCHes `codingCli.providers.kimi.permissionMode`.

- [ ] **Step 2: Run the new tests and confirm they are red**

Run:

```bash
npm run test:vitest -- --run test/unit/server/extension-manifest.test.ts test/unit/server/extension-manager.test.ts test/unit/client/store/managed-items.test.ts test/unit/client/components/ExtensionsView.test.tsx
```

Expected:

- `extension-manifest` fails because `supportedPermissionModes` and `permissionModeArgsByValue` are unknown keys.
- `extension-manager` fails because the client registry omits the new capability fields.
- `managed-items` and `ExtensionsView` fail because Kimi still exposes only the starting-directory field.

- [ ] **Step 3: Implement the launch-capability metadata and Kimi manifest**

Make these concrete changes:

```json
// extensions/kimi/freshell.json
{
  "name": "kimi",
  "version": "1.0.0",
  "label": "Kimi",
  "description": "Kimi CLI agent",
  "category": "cli",
  "cli": {
    "command": "kimi",
    "envVar": "KIMI_CMD",
    "resumeArgs": ["--session", "{{sessionId}}"],
    "modelArgs": ["--model", "{{model}}"],
    "supportedPermissionModes": ["default", "bypassPermissions"],
    "permissionModeArgsByValue": {
      "bypassPermissions": ["--yolo"]
    },
    "supportsPermissionMode": true,
    "supportsModel": true
  },
  "picker": {
    "group": "agents"
  }
}
```

Implement the corresponding contract changes:

- `server/extension-manifest.ts`: add `supportedPermissionModes?: Array<'default' | 'plan' | 'acceptEdits' | 'bypassPermissions'>` and `permissionModeArgsByValue?: Record<permissionMode, string[]>`.
- `shared/extension-types.ts`: expose those two fields on `ClientExtensionEntry['cli']`.
- `server/extension-manager.ts`: serialize `supportedPermissionModes` to the client registry.
- `src/store/managed-items.ts`: when a CLI supports permission mode, derive the dropdown options from `ext.cli.supportedPermissionModes ?? CLAUDE_PERMISSION_MODE_VALUES`.

Do not add Kimi-only branches in the React component tree; keep this metadata-driven.

- [ ] **Step 4: Re-run the targeted tests and make sure they pass**

Run:

```bash
npm run test:vitest -- --run test/unit/server/extension-manifest.test.ts test/unit/server/extension-manager.test.ts test/unit/client/store/managed-items.test.ts test/unit/client/components/ExtensionsView.test.tsx
```

Expected: all PASS.

- [ ] **Step 5: Refactor and verify the capability layer**

Refactor for clarity only:

- keep the new permission-mode fields adjacent to the existing `permissionModeArgs` and `permissionModeValues` manifest fields
- keep the client registry shape minimal, with no server-only launch compiler details
- confirm Kimi needs no settings migration because it never exposed model/permission settings before

Then re-run the task suite:

```bash
npm run test:vitest -- --run test/unit/server/extension-manifest.test.ts test/unit/server/extension-manager.test.ts test/unit/client/store/managed-items.test.ts test/unit/client/components/ExtensionsView.test.tsx
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add extensions/kimi/freshell.json server/extension-manifest.ts shared/extension-types.ts server/extension-manager.ts src/store/managed-items.ts test/unit/server/extension-manifest.test.ts test/unit/server/extension-manager.test.ts test/unit/client/store/managed-items.test.ts test/unit/client/components/ExtensionsView.test.tsx
git commit -m "feat: add Kimi launch capability metadata"
```

## Task 2: Implement The Kimi Session Provider And Searchable Session Metadata

**Files:**
- Create: `server/coding-cli/providers/kimi.ts`
- Create: `test/unit/server/coding-cli/kimi-provider.test.ts`
- Create: `test/fixtures/coding-cli/kimi/...`
- Modify: `test/unit/server/coding-cli/session-indexer.test.ts`
- Modify: `test/unit/server/session-directory/service.test.ts`

- [ ] **Step 1: Add the failing provider, indexer, and search tests**

Add fixture-backed tests that pin the actual Kimi contract:

```ts
// test/unit/server/coding-cli/kimi-provider.test.ts
it('lists Kimi sessions directly from the share dir and resolves cwd via KIMI_SHARE_DIR metadata', async () => {
  process.env.KIMI_SHARE_DIR = fixtureShareDir
  const provider = new KimiProvider()

  const sessions = await provider.listSessionsDirect()

  expect(sessions).toContainEqual(expect.objectContaining({
    provider: 'kimi',
    sessionId: 'kimi-session-1',
    cwd: '/repo/root/packages/app',
    projectPath: '/repo/root',
    sourceFile: expect.stringContaining('context.jsonl'),
    title: 'Fix the left sidebar refresh bug',
  }))
})

it('parses persisted Kimi context lines and live stream-json lines', () => {
  const provider = new KimiProvider('/tmp/.kimi')
  expect(provider.parseEvent('{"role":"user","content":"List files"}')[0].type).toBe('message.user')
  expect(provider.parseEvent('{"type":"TurnBegin","session_id":"abc","cwd":"/repo"}')[0].type).toBe('session.start')
})
```

Add a `session-directory/service` test that uses `providers: [kimiProvider]`, a Kimi `sourceFile`, and `tier: 'userMessages'` / `tier: 'fullText'` to prove Kimi becomes searchable once indexed.

Add a `session-indexer` test that uses a direct provider session with `sourceFile` and asserts `getFilePathForSession('kimi-session-1', 'kimi')` returns the context transcript path.

- [ ] **Step 2: Run the new tests and confirm they are red**

Run:

```bash
npm run test:vitest -- --run test/unit/server/coding-cli/kimi-provider.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/session-directory/service.test.ts
```

Expected:

- `kimi-provider` fails because the provider file does not exist yet.
- `session-directory/service` fails because no Kimi provider can parse the transcript.
- `session-indexer` direct-provider file-path test fails because there is no Kimi direct-provider path to index.

- [ ] **Step 3: Implement `KimiProvider` as a direct provider**

Build `server/coding-cli/providers/kimi.ts` with these exact responsibilities:

```ts
export class KimiProvider implements CodingCliProvider {
  readonly name = 'kimi' as const
  readonly displayName = 'Kimi'

  constructor(readonly homeDir = defaultKimiShareDir()) {}

  async listSessionsDirect(): Promise<CodingCliSession[]> { /* enumerate session dirs, resolve cwd map, build semantic metadata */ }
  getSessionGlob(): string { /* watch Kimi session + workdir-metadata roots */ }
  getSessionRoots(): string[] { /* same roots, explicit for late creation */ }
  async listSessionFiles(): Promise<string[]> { return [] }
  async parseSessionFile(): Promise<ParsedSessionMeta> { return {} }
  async resolveProjectPath(_filePath: string, meta: ParsedSessionMeta): Promise<string> { return meta.cwd ? resolveGitRepoRoot(meta.cwd) : 'unknown' }
  extractSessionId(filePath: string, meta?: ParsedSessionMeta): string { return meta?.sessionId ?? path.basename(path.dirname(filePath)) }

  getCommand(): string { return process.env.KIMI_CMD || 'kimi' }
  getStreamArgs(options: SpawnOptions): string[] { /* --output-format stream-json, prompt, optional --session, --model, --yolo */ }
  getResumeArgs(sessionId: string): string[] { return ['--session', sessionId] }
  parseEvent(line: string): NormalizedEvent[] { /* context.jsonl parser OR stream-json parser */ }

  supportsLiveStreaming(): boolean { return true }
  supportsSessionResume(): boolean { return true }
}
```

Implementation requirements:

- Resolve the share dir from `KIMI_SHARE_DIR` first, then `~/.kimi`.
- Enumerate sessions from the Kimi session tree and the workdir-metadata mapping Kimi itself uses. Do not guess project paths from the hashed directory names.
- Use `context.jsonl` as `sourceFile` so session-directory search sees complete user/assistant messages.
- Read sibling wire/event data to derive the title and richer timestamps the same way Kimi does, with first-user-message fallback when the wire title is absent.
- Ignore non-semantic checkpoint/usage records when computing `lastActivityAt`.
- Keep `parseEvent()` dual-format: it must understand both persisted context records and live `--output-format stream-json` records because session search and live coding-cli streaming share this parser.
- Reuse existing git helpers for `projectPath`, branch, and dirty-state enrichment.

- [ ] **Step 4: Re-run the targeted tests and make sure they pass**

Run:

```bash
npm run test:vitest -- --run test/unit/server/coding-cli/kimi-provider.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/session-directory/service.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Refactor and verify the provider contract**

Refactor for clarity and resilience:

- keep Kimi path constants and metadata-path discovery in one place in `kimi.ts`
- split transcript parsing into small helpers such as `parseKimiContextLine`, `parseKimiStreamLine`, and `summarizeKimiSession`
- make incomplete sessions fail closed by skipping them rather than fabricating fake `cwd` / `projectPath`

Then re-run the task suite:

```bash
npm run test:vitest -- --run test/unit/server/coding-cli/kimi-provider.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/session-directory/service.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add server/coding-cli/providers/kimi.ts test/unit/server/coding-cli/kimi-provider.test.ts test/fixtures/coding-cli/kimi test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/session-directory/service.test.ts
git commit -m "feat: add Kimi session provider"
```

## Task 3: Wire Kimi Into Runtime Registration, Restore, Association, And Docs

**Files:**
- Create: `server/coding-cli/providers/index.ts`
- Create: `test/unit/server/coding-cli/provider-registry.test.ts`
- Modify: `server/index.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `server/spawn-spec.ts`
- Modify: `test/unit/server/terminal-registry.test.ts`
- Modify: `test/server/session-association.test.ts`
- Modify: `test/e2e/directory-picker-flow.test.tsx`
- Modify: `docs/index.html`

- [ ] **Step 1: Add the failing runtime, association, and guardrail tests**

Add these red tests:

```ts
// test/unit/server/terminal-registry.test.ts
it('returns true for kimi once resumeArgs are registered', () => {
  expect(modeSupportsResume('kimi')).toBe(true)
})

it('adds Kimi model, yolo, and session resume args when configured', () => {
  const spec = buildSpawnSpec('kimi', '/repo/root', 'system', 'kimi-session-1', {
    model: 'moonshot-k2',
    permissionMode: 'bypassPermissions',
  })
  expect(spec.args).toEqual(expect.arrayContaining(['--model', 'moonshot-k2', '--yolo', '--session', 'kimi-session-1']))
})
```

```ts
// test/server/session-association.test.ts
it('associates a kimi terminal from onUpdate when the indexed kimi session appears', () => {
  const term = registry.create({ mode: 'kimi', cwd: '/repo/root/packages/app' })
  associateOnUpdate(registry, [{
    projectPath: '/repo/root',
    sessions: [{
      provider: 'kimi',
      sessionId: 'kimi-session-1',
      projectPath: '/repo/root',
      cwd: '/repo/root/packages/app',
      lastActivityAt: Date.now(),
    }],
  }], broadcasts)

  expect(registry.get(term.terminalId)?.resumeSessionId).toBe('kimi-session-1')
})
```

```ts
// test/unit/server/coding-cli/provider-registry.test.ts
it('registers every built-in CLI manifest that advertises resumeArgs as a session provider', () => {
  const manager = new ExtensionManager()
  manager.scan([path.join(process.cwd(), 'extensions')])

  const resumeCapable = manager.getAll()
    .filter((entry) => entry.manifest.category === 'cli' && entry.manifest.cli?.resumeArgs)
    .map((entry) => entry.manifest.name)
    .sort()

  expect(Array.from(codingCliProvidersByName.keys()).sort()).toEqual(resumeCapable)
})
```

Extend `test/e2e/directory-picker-flow.test.tsx` with a Kimi scenario that proves the user can pick Kimi, choose a directory, and persist that directory under `codingCli.providers.kimi.cwd`. If that scenario is already green once Task 1 lands, keep it as the required e2e proof rather than forcing an unnecessary code change.

- [ ] **Step 2: Run the new tests and confirm the red failures**

Run:

```bash
npm run test:vitest -- --run test/unit/server/terminal-registry.test.ts test/server/session-association.test.ts test/unit/server/coding-cli/provider-registry.test.ts test/e2e/directory-picker-flow.test.tsx
```

Expected:

- `terminal-registry` still says Kimi does not support resume and does not emit Kimi launch args.
- `session-association` fails because Kimi is still outside the provider/indexer runtime.
- `provider-registry` fails because there is no centralized provider registry, and Kimi is not yet included.

- [ ] **Step 3: Wire Kimi through the runtime and document it**

Implement the wiring in one steady-state pass:

- Create `server/coding-cli/providers/index.ts` exporting `codingCliProviders` and `codingCliProvidersByName`.
- Update `server/index.ts` to import that registry instead of hand-building `[claudeProvider, codexProvider, opencodeProvider]`.
- Extend `CodingCliCommandSpec` plus the manifest compiler in `server/index.ts`, `server/terminal-registry.ts`, and `server/spawn-spec.ts` with `permissionModeArgsByValue?: Record<string, string[]>`.
- In command resolution, prefer value-specific permission args when present, otherwise fall back to templated `permissionModeArgs`. Keep env-based permission mapping unchanged.
- Update Kimi fallback specs in `terminal-registry.ts` and `spawn-spec.ts` so standalone tests and early bootstrap instances stay aligned with the manifest:

```ts
kimi: {
  label: 'Kimi',
  envVar: 'KIMI_CMD',
  defaultCommand: 'kimi',
  resumeArgs: (sessionId) => ['--session', sessionId],
  modelArgs: (model) => ['--model', model],
  permissionModeArgsByValue: {
    bypassPermissions: ['--yolo'],
  },
},
```

- Update `docs/index.html` so the mock UI reflects Kimi as a first-class agent: include it in the provider/settings copy and session examples instead of leaving it implied by "and more".

- [ ] **Step 4: Re-run the targeted tests and make sure they pass**

Run:

```bash
npm run test:vitest -- --run test/unit/server/terminal-registry.test.ts test/server/session-association.test.ts test/unit/server/coding-cli/provider-registry.test.ts test/e2e/directory-picker-flow.test.tsx
```

Expected: all PASS.

- [ ] **Step 5: Final refactor and full verification**

Refactor for durability:

- keep provider registration in exactly one module
- keep launch capability compilation in manifest-driven codepaths rather than Kimi-specific conditionals
- confirm `sessionRepairService` remains Claude-only and untouched

Then run the final verification sequence:

```bash
npm run test:status
npm run lint
FRESHELL_TEST_SUMMARY="Kimi first-class CLI" npm run check
```

Expected:

- `test:status` shows the coordinator is free or tells you to wait.
- `lint` passes.
- `check` passes typecheck plus the coordinated full test suite.

- [ ] **Step 6: Commit**

```bash
git add server/coding-cli/providers/index.ts server/index.ts server/terminal-registry.ts server/spawn-spec.ts test/unit/server/terminal-registry.test.ts test/server/session-association.test.ts test/unit/server/coding-cli/provider-registry.test.ts test/e2e/directory-picker-flow.test.tsx docs/index.html
git commit -m "feat: land first-class Kimi CLI"
```
