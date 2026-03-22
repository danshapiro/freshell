# Kimi First-Class CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Kimi a fully supported terminal-mode CLI in Freshell: it must show accurate launch controls in picker/settings, index its sessions into the sidebar and session directory, and restore/resume correctly after server restart.

**Architecture:** Keep Freshell's current split between extension manifests (launch-time capabilities) and handwritten session providers, but complete both layers for Kimi. Implement Kimi as a direct session provider that reads `KIMI_SHARE_DIR` / `~/.kimi`, indexes `context.jsonl` transcripts plus optional web metadata, and exposes searchable `sourceFile` paths. Extend the launch compiler minimally with value-specific permission-mode args for `--yolo`, and preserve direct-provider file-path lookup in the session indexer so Kimi participates in the same search and lookup paths as file-backed providers.

**Tech Stack:** Node.js, TypeScript, Express, React, Redux Toolkit, Vitest, React Testing Library

---

**Execution note:** Use @trycycle-executing and keep the red-green-refactor order below. Execute in `/home/user/code/freshell/.worktrees/trycycle-kimi-first-class-cli`.

## User-Visible Target

After this lands:

- Kimi appears in the pane picker when its CLI is available and enabled.
- The Extensions settings card for Kimi shows starting directory, model, and only the permission modes Kimi actually supports: `Default` and `Bypass permissions`.
- Saved Kimi settings affect later launches: model adds `--model`, bypass mode adds `--yolo`.
- New Kimi terminals get durable session binding once the indexed Kimi session appears, so the left sidebar shows the live session under the correct project and marks it running.
- Indexed Kimi sessions show up after server restart because Freshell can discover them from disk, not just from live terminals.
- Restored Kimi panes reuse their saved `resumeSessionId`, launch `kimi --session <id>` from the original working directory, and reconnect to the same indexed session instead of creating an orphaned terminal.
- Session-directory `title`, `userMessages`, and `fullText` search works for Kimi by scanning persisted session transcripts.
- Kimi session-directory rows honor persisted `metadata.json` state where present: pinned titles win over wire-derived fallbacks, archived sessions stay archived, and transcript search only indexes visible user/assistant text instead of `_system_prompt`, `_checkpoint`, `_usage`, or hidden `think` blocks.
- Claude-only repair/history behavior remains Claude-only. This task does not widen `sessionRepairService`, `session-history-loader`, or `CodingCliSessionManager` support for Kimi.

## Contracts And Invariants

1. A CLI is not "first class" unless both layers exist: manifest launch metadata and a registered `CodingCliProvider`.
2. Kimi share-dir resolution uses `process.env.KIMI_SHARE_DIR` when present, otherwise `~/.kimi`. Do not invent `KIMI_HOME`.
3. Kimi resume is `(cwd, sessionId)` sensitive. Freshell must preserve the original launch working directory when resuming `kimi --session <id>`, because upstream session lookup is scoped by work directory.
4. Kimi session IDs are opaque strings. Do not coerce them to UUIDs or reject named sessions; Freshell must resume exactly the ID Kimi created.
5. Indexed Kimi sessions must carry `sourceFile` pointing at the persisted transcript file used for search:
   - modern layout: `<sessionDir>/context.jsonl`
   - legacy layout: `<sessionsDir>/<sessionId>.jsonl`
6. Kimi workdir hashing must match upstream exactly: `md5(path)` for local entries, `${kaos}_${md5(path)}` for non-local entries. Do not approximate the sessions directory path.
7. Kimi titles and archive state must prefer persisted session metadata when available:
   - optional `metadata.json` title when it is present and not `"Untitled"` (Kimi Web writes this file; plain CLI sessions may not have it)
   - optional `metadata.json` archived flag when it is present
   - otherwise first `TurnBegin` user input from `wire.jsonl`
   - otherwise first visible user message from the context transcript
8. Kimi transcript parsing must flatten both string content and array content blocks into visible text. `_system_prompt`, `_checkpoint`, `_usage`, and `assistant` `think` blocks are internal noise and must not become searchable message content.
9. Rotated backup and subagent transcript files such as `context_N.jsonl` and `context_sub_N.jsonl` are not top-level sessions. Only `context.jsonl` (or the legacy flat transcript) is authoritative for indexing/search.
10. Kimi remains terminal-mode only in this task. Upstream `--print --output-format stream-json` does not expose the session-identifying event stream Freshell would need for `CodingCliSessionManager`, so `supportsLiveStreaming()` stays `false`.
11. The generic permission-mode UI must never advertise unsupported Kimi choices. Kimi may only surface `default` and `bypassPermissions`; `bypassPermissions` must launch `--yolo`.
12. `modeSupportsResume('kimi')` must not become true until the same task that registers the Kimi session provider. Do not create a mid-plan state where built-in Kimi advertises resume support but still lacks provider wiring.
13. Direct-provider invalidation must trigger when Kimi workdir metadata or any indexed Kimi transcript/title source changes.
14. Direct-provider sessions with `sourceFile` must populate `CodingCliSessionIndexer`'s `sessionKeyToFilePath` lookup, or Kimi's transcript-backed lookup paths will stay broken even after the provider exists.
15. This task does not change `server/session-history-loader.ts`, `server/session-scanner/service.ts`, or `server/coding-cli/session-manager.ts`.
16. The fallback command specs in `server/terminal-registry.ts` are only a compatibility seed for tests and pre-bootstrap instances. Kimi-specific launch behavior must be proven against the manifest-compiled command specs that server startup actually registers.
17. "First class" includes live index refresh, not only cold-start discovery. Updating `metadata.json`, `wire.jsonl`, or the authoritative transcript path must trigger a direct-provider refresh quickly enough for sidebar visibility and association, rather than relying on the periodic full scan.

## Root Cause Summary

- Kimi currently exists only as a spawnable extension manifest, so it can open a terminal but never enters the session indexer/session manager/provider stack.
- The manifest does not describe Kimi's permission-mode subset or `--yolo` launch mapping, so Freshell cannot expose accurate settings even though the extension is visible.
- Kimi session discovery depends on Kimi-owned metadata (`kimi.json`) plus session files. That workdir mapping is not representable in Freshell's current manifest schema, so a handwritten provider is required.
- Kimi's persisted session contract is richer than a bare `context.jsonl`: titles and archived state may live in `metadata.json`, session IDs are not UUID-only, and real transcripts contain internal/system records plus assistant content arrays that must be normalized before search.
- The sidebar mostly renders indexed sessions, not raw open terminals. Without a Kimi provider, Kimi terminals disappear from the left panel after restart even if the tabs come back.

## Strategy Gate

**Chosen approach:** implement Kimi as a real direct session provider, and keep the launch-contract change minimal.

- A direct provider fits Kimi's storage model because project-path resolution depends on `kimi.json` workdir metadata, not only on transcript paths.
- A single new manifest/runtime field, `permissionModeArgsByValue`, is enough to express Kimi's `--yolo` behavior.
- The client should receive derived `supportedPermissionModes`, not raw launch-compiler details. That keeps the client registry small and avoids redundant manifest state.
- Resume support and provider registration land together in the final runtime task, so the built-in "resume-capable CLI implies provider exists" invariant is never broken between commits.

**Rejected approaches:**

- **Manifest-only fix:** adding `resumeArgs` alone would make `modeSupportsResume('kimi')` true, but the sidebar/session directory would still never discover Kimi sessions because the provider layer would remain absent.
- **Pretend Kimi has a Claude/Codex-style live JSON event stream:** upstream print mode emits assistant messages and notifications, not a session-identifying wire protocol. Designing the provider around fake `TurnBegin` stdout events would backfire.
- **Hardcode `--yolo` in `terminal-registry.ts` without manifest support:** fixes one CLI but repeats the architecture bug. Launch behavior must continue to flow from extension metadata.
- **Add both `supportedPermissionModes` and `permissionModeArgsByValue` to the manifest:** redundant. The client-facing subset should be derived from launch metadata, not stored twice.
- **Generalize all session discovery into manifests right now:** that is the broader architecture issue already filed separately. It is larger than this feature and would delay landing Kimi's requested end state.
- **Touch Claude-only repair/history code:** unnecessary and risky. Kimi restore needs provider plus resume wiring, not Claude's orphan-repair subsystem.

No user decision is required.

## File Structure

### Files to Create

1. `server/coding-cli/providers/kimi.ts`
   Kimi direct provider: share-dir resolution, workdir-hash lookup, session enumeration, metadata synthesis, persisted-context parsing, and title/activity derivation.
2. `server/coding-cli/providers/index.ts`
   Single export point for session-aware providers and provider-name lookup used by server bootstrap and invariant tests.
3. `server/coding-cli/command-specs.ts`
   Shared manifest-to-runtime compiler for CLI command specs so startup wiring is unit-testable instead of living inline in `server/index.ts`.
4. `test/unit/server/coding-cli/command-specs.test.ts`
   Guardrail for manifest-compiled runtime command specs, including Kimi's value-specific permission args and later resume args.
5. `test/unit/server/coding-cli/kimi-provider.test.ts`
   Provider contract coverage for share-dir resolution, title/archived precedence, non-UUID session IDs, legacy-layout handling, direct listing, and persisted-context parsing.
6. `test/unit/server/coding-cli/provider-registry.test.ts`
   Guardrail that every built-in resume-capable CLI manifest has a registered session provider.
7. `test/fixtures/coding-cli/kimi/...`
   Fixture share-dir tree with `kimi.json`, hashed session directories, `context.jsonl`, `wire.jsonl`, optional `metadata.json`, rotated backup/subagent context files that must be ignored, and at least one legacy flat transcript.

### Files to Modify

1. `extensions/kimi/freshell.json`
2. `server/extension-manifest.ts`
3. `shared/extension-types.ts`
4. `server/extension-manager.ts`
5. `src/store/managed-items.ts`
6. `server/index.ts`
7. `server/terminal-registry.ts`
8. `server/spawn-spec.ts`
   Dead-code consistency only. This file is not imported in production, but keep it aligned with `server/terminal-registry.ts`.
9. `server/coding-cli/session-indexer.ts`
10. `test/unit/server/extension-manifest.test.ts`
11. `test/unit/server/extension-manager.test.ts`
12. `test/unit/client/store/managed-items.test.ts`
13. `test/unit/client/components/ExtensionsView.test.tsx`
14. `test/e2e/directory-picker-flow.test.tsx`
15. `test/unit/server/coding-cli/session-indexer.test.ts`
16. `test/unit/server/session-directory/service.test.ts`
17. `test/integration/server/session-directory-router.test.ts`
18. `test/unit/server/terminal-registry.test.ts`
19. `test/server/session-association.test.ts`
20. `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
21. `docs/index.html`

### Files Expected To Stay Unchanged

- `server/session-history-loader.ts`
- `server/session-scanner/service.ts`
- `server/coding-cli/session-manager.ts`
- `src/store/selectors/sidebarSelectors.ts`

Those paths already consume provider/indexed-session data generically or are explicitly out of scope.

## Task 1: Land Kimi Launch Settings And Accurate Permission-Mode UI

**Files:**
- Create: `server/coding-cli/command-specs.ts`
- Create: `test/unit/server/coding-cli/command-specs.test.ts`
- Modify: `extensions/kimi/freshell.json`
- Modify: `server/extension-manifest.ts`
- Modify: `shared/extension-types.ts`
- Modify: `server/extension-manager.ts`
- Modify: `src/store/managed-items.ts`
- Modify: `server/index.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `server/spawn-spec.ts`
- Test: `test/unit/server/extension-manifest.test.ts`
- Test: `test/unit/server/coding-cli/command-specs.test.ts`
- Test: `test/unit/server/extension-manager.test.ts`
- Test: `test/unit/client/store/managed-items.test.ts`
- Test: `test/unit/client/components/ExtensionsView.test.tsx`
- Test: `test/unit/server/terminal-registry.test.ts`

- [ ] **Step 1: Add the failing manifest, runtime-compiler, client-registry, UI, and launch-arg tests**

Add red coverage for the missing launch contract:

```ts
// test/unit/server/extension-manifest.test.ts
it('accepts value-specific permission args for CLI manifests', () => {
  const result = ExtensionManifestSchema.safeParse({
    ...validCliManifest,
    cli: {
      command: 'kimi',
      modelArgs: ['--model', '{{model}}'],
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
// test/unit/server/coding-cli/command-specs.test.ts
it('compiles Kimi value-specific permission args into the runtime command map used by server startup', () => {
  const specs = buildCliCommandSpecsFromEntries([
    makeCliEntry({
      name: 'kimi',
      label: 'Kimi',
      cli: {
        command: 'kimi',
        modelArgs: ['--model', '{{model}}'],
        permissionModeArgsByValue: {
          bypassPermissions: ['--yolo'],
        },
        supportsPermissionMode: true,
        supportsModel: true,
      },
    }),
  ])

  const spec = specs.get('kimi')
  expect(spec?.modelArgs?.('moonshot-k2')).toEqual(['--model', 'moonshot-k2'])
  expect(spec?.permissionModeArgsByValue?.bypassPermissions).toEqual(['--yolo'])
})
```

```ts
// test/unit/server/extension-manager.test.ts
it('derives supported permission modes for client registry entries', async () => {
  await writeExtension(extDir1, 'cli', cliManifest({
    name: 'kimi',
    label: 'Kimi',
    cli: {
      command: 'kimi',
      modelArgs: ['--model', '{{model}}'],
      permissionModeArgsByValue: {
        bypassPermissions: ['--yolo'],
      },
      supportsPermissionMode: true,
      supportsModel: true,
    },
  }))

  const mgr = new ExtensionManager()
  mgr.scan([extDir1])

  expect(mgr.toClientRegistry()[0].cli).toEqual(expect.objectContaining({
    supportsModel: true,
    supportsPermissionMode: true,
    supportedPermissionModes: ['default', 'bypassPermissions'],
  }))
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
    },
  }

  const items = selectManagedItems(makeState({
    entries: [kimiExt],
    enabledProviders: ['kimi'],
    providers: { kimi: { model: 'moonshot-k2', permissionMode: 'bypassPermissions' } },
  }))

  const permission = items[0].config.find((field) => field.key === 'permissionMode')
  expect(permission?.options?.map((option) => option.value)).toEqual(['default', 'bypassPermissions'])
})
```

```ts
// test/unit/server/terminal-registry.test.ts
it('adds Kimi model and yolo args when configured', () => {
  const spec = buildSpawnSpec('kimi', '/repo/root', 'system', undefined, {
    model: 'moonshot-k2',
    permissionMode: 'bypassPermissions',
  })

  expect(spec.args).toEqual(expect.arrayContaining(['--model', 'moonshot-k2', '--yolo']))
})
```

Add `ExtensionsView` coverage that expanding the Kimi card shows model, permission mode, and starting directory, and that choosing `bypassPermissions` PATCHes `codingCli.providers.kimi.permissionMode`.

- [ ] **Step 2: Run the new tests and confirm they are red**

Run:

```bash
npm run test:vitest -- --run test/unit/server/extension-manifest.test.ts test/unit/server/coding-cli/command-specs.test.ts test/unit/server/extension-manager.test.ts test/unit/client/store/managed-items.test.ts test/unit/client/components/ExtensionsView.test.tsx test/unit/server/terminal-registry.test.ts
```

Expected:

- `extension-manifest` fails because `permissionModeArgsByValue` is unknown.
- `command-specs` fails because server startup still has no tested path that compiles `permissionModeArgsByValue` into runtime command specs.
- `extension-manager` fails because the client registry does not expose `supportedPermissionModes`.
- `managed-items` and `ExtensionsView` fail because Kimi still shows only the default permission list or only the starting-directory field.
- `terminal-registry` fails because Kimi does not emit `--model` / `--yolo`.

- [ ] **Step 3: Implement the minimal launch/settings contract**

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
    "modelArgs": ["--model", "{{model}}"],
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

Implementation rules:

- `server/extension-manifest.ts`: add `permissionModeArgsByValue?: Partial<Record<ClaudePermissionMode, string[]>>` and validate its keys against the canonical permission-mode set.
- `server/coding-cli/command-specs.ts`: move the manifest-to-`CodingCliCommandSpec` compiler out of `server/index.ts`, including `compileArgTemplate()` and `permissionModeArgsByValue` support, so startup wiring is unit-testable.
- `server/index.ts`: stop compiling CLI command specs inline; instead call the helper from `server/coding-cli/command-specs.ts` and register its result.
- `server/terminal-registry.ts` and `server/spawn-spec.ts`: honor `permissionModeArgsByValue`, preferring it over generic `permissionModeArgs` when both exist.
- `server/extension-manager.ts`: derive `supportedPermissionModes` for the client registry:
  - if a CLI has `permissionModeArgsByValue`, use `['default', ...mapped values in canonical order]`
  - else if it has `permissionModeValues` but no generic arg template, use `['default', ...mapped values in canonical order]`
  - else if `supportsPermissionMode` is true, expose the full canonical list
- `shared/extension-types.ts`: add `supportedPermissionModes?: string[]` to the serialized client CLI block. Do not expose raw `permissionModeArgsByValue` to the client.
- `src/store/managed-items.ts`: build permission options from `ext.cli.supportedPermissionModes ?? CLAUDE_PERMISSION_MODE_VALUES`.
- `server/terminal-registry.ts`: update the Kimi fallback spec with `modelArgs` and `permissionModeArgsByValue`.
- `server/spawn-spec.ts`: mirror the same Kimi fallback changes with a comment noting it is dead-code consistency only.

Do **not** add `resumeArgs` yet in this task.

- [ ] **Step 4: Re-run the targeted tests and make sure they pass**

Run:

```bash
npm run test:vitest -- --run test/unit/server/extension-manifest.test.ts test/unit/server/coding-cli/command-specs.test.ts test/unit/server/extension-manager.test.ts test/unit/client/store/managed-items.test.ts test/unit/client/components/ExtensionsView.test.tsx test/unit/server/terminal-registry.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Refactor and verify the launch-capability layer**

Refactor for clarity only:

- keep permission-mode derivation in one helper in `server/extension-manager.ts`
- keep the client registry shape minimal
- confirm Kimi settings now affect launch args without changing resume behavior

Then re-run the task suite:

```bash
npm run test:vitest -- --run test/unit/server/extension-manifest.test.ts test/unit/server/coding-cli/command-specs.test.ts test/unit/server/extension-manager.test.ts test/unit/client/store/managed-items.test.ts test/unit/client/components/ExtensionsView.test.tsx test/unit/server/terminal-registry.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add extensions/kimi/freshell.json server/coding-cli/command-specs.ts server/extension-manifest.ts shared/extension-types.ts server/extension-manager.ts src/store/managed-items.ts server/index.ts server/terminal-registry.ts server/spawn-spec.ts test/unit/server/extension-manifest.test.ts test/unit/server/coding-cli/command-specs.test.ts test/unit/server/extension-manager.test.ts test/unit/client/store/managed-items.test.ts test/unit/client/components/ExtensionsView.test.tsx test/unit/server/terminal-registry.test.ts
git commit -m "feat: add Kimi launch settings metadata"
```

## Task 2: Implement The Kimi Session Provider And Searchable Session Metadata

**Files:**
- Create: `server/coding-cli/providers/kimi.ts`
- Create: `test/unit/server/coding-cli/kimi-provider.test.ts`
- Create: `test/fixtures/coding-cli/kimi/...`
- Modify: `server/coding-cli/session-indexer.ts`
- Modify: `test/unit/server/coding-cli/session-indexer.test.ts`
- Modify: `test/unit/server/session-directory/service.test.ts`
- Modify: `test/integration/server/session-directory-router.test.ts`

- [ ] **Step 1: Add the failing provider, indexer, and search tests**

Add fixture-backed tests that pin the actual Kimi disk contract:

```ts
// test/unit/server/coding-cli/kimi-provider.test.ts
it('lists Kimi sessions from kimi.json workdir metadata, preserves named session ids, and prefers metadata.json title/archive state', async () => {
  process.env.KIMI_SHARE_DIR = fixtureShareDir
  const provider = new KimiProvider()

  const sessions = await provider.listSessionsDirect()

  expect(sessions).toContainEqual(expect.objectContaining({
    provider: 'kimi',
    sessionId: 'kimi-session-1',
    cwd: '/repo/root/packages/app',
    projectPath: '/repo/root',
    sourceFile: expect.stringContaining('context.jsonl'),
    title: 'Pinned title from metadata',
    archived: true,
  }))

  expect(sessions.find((s) => s.sessionId === 'named-kimi-session')?.sessionId).toBe('named-kimi-session')
})

it('falls back from metadata.json to wire.jsonl title, then to first user message', async () => {
  process.env.KIMI_SHARE_DIR = fixtureShareDir
  const provider = new KimiProvider()

  const sessions = await provider.listSessionsDirect()

  expect(sessions.find((s) => s.sessionId === 'wire-title-session')?.title).toBe('Fix the left sidebar refresh bug')
  expect(sessions.find((s) => s.sessionId === 'context-title-session')?.title).toBe('Message-only fallback title')
  expect(sessions.find((s) => s.sessionId === 'legacy-flat-session')?.sourceFile).toMatch(/legacy-flat-session\.jsonl$/)
})

it('flattens visible transcript content and ignores internal records', () => {
  const provider = new KimiProvider('/tmp/.kimi')

  expect(provider.parseEvent('{\"role\":\"user\",\"content\":\"List files\"}')).toEqual([
    expect.objectContaining({
      type: 'message.user',
      message: expect.objectContaining({ content: 'List files' }),
    }),
  ])
  expect(provider.parseEvent('{\"role\":\"assistant\",\"content\":[{\"type\":\"think\",\"think\":\"hidden\"},{\"type\":\"text\",\"text\":\"Visible answer\"}]}')).toEqual([
    expect.objectContaining({
      type: 'message.assistant',
      message: expect.objectContaining({ content: 'Visible answer' }),
    }),
  ])
  expect(provider.parseEvent('{\"role\":\"_system_prompt\",\"content\":\"hidden\"}')).toEqual([])
  expect(provider.parseEvent('{\"role\":\"_checkpoint\",\"id\":3}')).toEqual([])
  expect(provider.parseEvent('{\"role\":\"_usage\",\"token_count\":42}')).toEqual([])
  expect(provider.supportsLiveStreaming()).toBe(false)
  expect(provider.supportsSessionResume()).toBe(true)
})
```

Add a `session-directory/service` test that uses `providers: [kimiProvider]`, a Kimi `sourceFile`, and `tier: 'userMessages'` / `tier: 'fullText'` to prove Kimi becomes searchable once indexed.

Add a `session-directory-router` integration test that mounts `createSessionsRouter()` with `codingCliProviders: [kimiProvider]` and proves `/api/session-directory?query=...&tier=fullText` finds assistant text from a real Kimi transcript fixture. This catches route-level provider wiring and the real `parseEvent()` path together.

Add a `session-indexer` test that uses a direct-provider Kimi session and asserts `getFilePathForSession('kimi-session-1', 'kimi')` returns the transcript path, proving direct providers now populate the same lookup map that file-backed providers use.

Add watcher-backed `session-indexer` coverage that starts a real `CodingCliSessionIndexer` with `KimiProvider` and proves direct-provider refresh happens on file changes that matter to live sidebar state:

- changing `metadata.json` updates the indexed title / archived flag without a manual full scan
- changing `wire.jsonl` upgrades a context-fallback title to the first `TurnBegin` title

Also add fixture-backed tests that:

- a legacy flat transcript (`sessions/<hash>/<sessionId>.jsonl`) is still indexed as a Kimi session
- rotated backup/subagent files (`context_1.jsonl`, `context_sub_1.jsonl`) are ignored as top-level sessions

- [ ] **Step 2: Run the new tests and confirm they are red**

Run:

```bash
npm run test:vitest -- --run test/unit/server/coding-cli/kimi-provider.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/session-directory/service.test.ts test/integration/server/session-directory-router.test.ts
```

Expected:

- `kimi-provider` fails because the provider file does not exist yet.
- `session-directory/service` fails because no Kimi provider can parse the transcript.
- `session-directory-router` fails because the route cannot yet search Kimi transcript files through a real provider.
- `session-indexer` direct-provider file-path test fails because there is no Kimi direct-provider path to index.

- [ ] **Step 3: Implement `KimiProvider` as a direct provider**

Build `server/coding-cli/providers/kimi.ts` with these exact responsibilities:

```ts
export class KimiProvider implements CodingCliProvider {
  readonly name = 'kimi' as const
  readonly displayName = 'Kimi'

  constructor(readonly homeDir = defaultKimiShareDir()) {}

  async listSessionsDirect(): Promise<CodingCliSession[]> { /* enumerate workdirs from kimi.json; read modern + legacy session layouts */ }
  getSessionGlob(): string { /* broad enough to catch kimi.json, sessions/**, optional metadata.json, and wire.jsonl */ }
  getSessionRoots(): string[] { /* include homeDir and sessions root for late creation */ }
  async listSessionFiles(): Promise<string[]> { return [] }
  async parseSessionFile(): Promise<ParsedSessionMeta> { return {} }
  async resolveProjectPath(_filePath: string, meta: ParsedSessionMeta): Promise<string> { /* resolve repo root from cwd */ }
  extractSessionId(filePath: string, meta?: ParsedSessionMeta): string { /* session dir name or legacy file stem */ }

  getCommand(): string { return process.env.KIMI_CMD || 'kimi' }
  getStreamArgs(_options: SpawnOptions): string[] { return [] }
  getResumeArgs(sessionId: string): string[] { return ['--session', sessionId] }
  parseEvent(line: string): NormalizedEvent[] { /* parse persisted Message JSON only */ }

  supportsLiveStreaming(): boolean { return false }
  supportsSessionResume(): boolean { return true }
}
```

Implementation requirements:

- Resolve the share dir from `KIMI_SHARE_DIR` first, then `~/.kimi`.
- Read `kimi.json` and reconstruct each workdir's hashed sessions directory the same way upstream does, including the `${kaos}_` prefix for non-local entries.
- Watch the real Kimi title/archive inputs, not only the transcript: `getSessionGlob()` must cover `kimi.json`, `wire.jsonl`, `metadata.json`, modern `context.jsonl`, and legacy flat `*.jsonl` files so live direct-provider refresh works before the periodic full scan.
- Support both upstream layouts:
  - modern: `<sessionsDir>/<sessionId>/context.jsonl`
  - legacy: `<sessionsDir>/<sessionId>.jsonl`
- Treat session IDs as opaque strings throughout; do not require UUIDs.
- Use the real transcript path as `sourceFile`.
- Derive the session title in this order:
  - optional `metadata.json` title if present and not `"Untitled"`
  - first `TurnBegin` user input from `wire.jsonl` (skip the wire metadata header line)
  - first visible user message from the transcript
- Use existing title helpers for wire/context fallbacks so Kimi titles are truncated consistently with the other providers instead of dumping whole prompts into the sidebar.
- Copy `metadata.json` archived state onto `CodingCliSession.archived` when present.
- Derive `lastActivityAt` from the transcript file's `mtime`, matching Kimi's own session indexing semantics. If you also expose `createdAt`, derive it from the earliest wire-record timestamp only when that is straightforward and clearly correct; otherwise leave it undefined.
- Ignore `_system_prompt`, `_checkpoint`, `_usage`, empty/internal messages, and hidden `think` blocks when computing titles and `parseEvent()` results.
- Flatten both string and array-form `content` into visible text so `fullText` search works on real Kimi assistant replies.
- Ignore rotated backup/subagent transcripts (`context_N.jsonl`, `context_sub_N.jsonl`) when enumerating top-level sessions.
- Reuse existing git helpers for `projectPath`, branch, and dirty-state enrichment.
- Do **not** attempt Kimi live-stream session-manager support in this provider.
- Update `server/coding-cli/session-indexer.ts` so `updateDirectCacheEntry()` mirrors file-backed behavior for sessions that carry `sourceFile`: remove any previous mapping for the same cache entry, set `sessionKeyToFilePath` for the new `(provider, sessionId)`, and let `deleteCacheEntry()` clean it up on removal.

- [ ] **Step 4: Re-run the targeted tests and make sure they pass**

Run:

```bash
npm run test:vitest -- --run test/unit/server/coding-cli/kimi-provider.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/session-directory/service.test.ts test/integration/server/session-directory-router.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Refactor and verify the provider contract**

Refactor for clarity and resilience:

- keep Kimi path/layout helpers in one place in `kimi.ts`
- split parsing into small helpers such as `loadKimiMetadata`, `listKimiSessionFiles`, `deriveKimiTitle`, and `parseKimiContextLine`
- make incomplete sessions fail closed by skipping them rather than fabricating fake `cwd` / `projectPath`

Then re-run the task suite:

```bash
npm run test:vitest -- --run test/unit/server/coding-cli/kimi-provider.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/session-directory/service.test.ts test/integration/server/session-directory-router.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add server/coding-cli/providers/kimi.ts server/coding-cli/session-indexer.ts test/unit/server/coding-cli/kimi-provider.test.ts test/fixtures/coding-cli/kimi test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/session-directory/service.test.ts test/integration/server/session-directory-router.test.ts
git commit -m "feat: add Kimi session provider"
```

## Task 3: Wire Kimi Into Runtime Registration, Restore, Association, And Docs

**Files:**
- Create: `server/coding-cli/providers/index.ts`
- Create: `test/unit/server/coding-cli/provider-registry.test.ts`
- Modify: `extensions/kimi/freshell.json`
- Modify: `server/index.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `server/spawn-spec.ts`
- Modify: `test/unit/server/coding-cli/command-specs.test.ts`
- Modify: `test/unit/server/terminal-registry.test.ts`
- Modify: `test/server/session-association.test.ts`
- Modify: `test/e2e/directory-picker-flow.test.tsx`
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
- Modify: `docs/index.html`

- [ ] **Step 1: Add the failing runtime, association, and guardrail tests**

Add these red tests:

```ts
// test/unit/server/terminal-registry.test.ts
it('returns true for kimi once resumeArgs are registered', () => {
  expect(modeSupportsResume('kimi')).toBe(true)
})

it('adds Kimi session resume args when resuming', () => {
  const spec = buildSpawnSpec('kimi', '/repo/root', 'system', 'kimi-session-1', {
    model: 'moonshot-k2',
    permissionMode: 'bypassPermissions',
  })

  expect(spec.args).toEqual(expect.arrayContaining([
    '--model', 'moonshot-k2',
    '--yolo',
    '--session', 'kimi-session-1',
  ]))
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
// test/unit/server/coding-cli/command-specs.test.ts
it('compiles Kimi resumeArgs from the manifest into the runtime command map', () => {
  const specs = buildCliCommandSpecsFromEntries([
    makeCliEntry({
      name: 'kimi',
      label: 'Kimi',
      cli: {
        command: 'kimi',
        resumeArgs: ['--session', '{{sessionId}}'],
        modelArgs: ['--model', '{{model}}'],
        permissionModeArgsByValue: {
          bypassPermissions: ['--yolo'],
        },
        supportsPermissionMode: true,
        supportsModel: true,
      },
    }),
  ])

  expect(specs.get('kimi')?.resumeArgs?.('kimi-session-1')).toEqual(['--session', 'kimi-session-1'])
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

  for (const providerName of resumeCapable) {
    expect(codingCliProvidersByName.has(providerName)).toBe(true)
  }
})
```

Extend `test/e2e/directory-picker-flow.test.tsx` with a Kimi scenario that proves the user can pick Kimi, choose a directory, and persist that directory under `codingCli.providers.kimi.cwd`. If that scenario is already green once Task 1 lands, keep it as the required end-to-end proof rather than forcing an unnecessary code change.

Extend `test/e2e/open-tab-session-sidebar-visibility.test.tsx` with a restored-Kimi bootstrap scenario using the existing HTTP-owned sidebar harness:

- restore a Kimi tab/pane with `resumeSessionId`
- return an indexed Kimi session row from the bootstrapped sidebar snapshot
- assert the indexed Kimi title is visible exactly once after bootstrap, under the correct project, instead of relying on raw fallback tab state alone

This is the user-visible regression proof for the original "left hand panel after server reset" complaint.

- [ ] **Step 2: Run the new tests and confirm the red failures**

Run:

```bash
npm run test:vitest -- --run test/unit/server/coding-cli/command-specs.test.ts test/unit/server/terminal-registry.test.ts test/server/session-association.test.ts test/unit/server/coding-cli/provider-registry.test.ts test/e2e/directory-picker-flow.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected:

- `command-specs` fails because the manifest-compiled Kimi runtime spec still drops `resumeArgs`.
- `terminal-registry` still says Kimi does not support resume and does not emit `--session`.
- `session-association` fails because Kimi is still outside the runtime provider registry.
- `provider-registry` fails because there is no centralized provider registry, and Kimi is not yet included.
- `open-tab-session-sidebar-visibility` fails because the restored Kimi session cannot yet rely on indexed sidebar data after bootstrap.

- [ ] **Step 3: Wire Kimi through runtime registration and restore**

Implement the wiring in one steady-state pass:

- Create `server/coding-cli/providers/index.ts` exporting `codingCliProviders` and `codingCliProvidersByName`.
- Update `server/index.ts` to import that registry instead of hand-building `[claudeProvider, codexProvider, opencodeProvider]`. After this change, there should be exactly one built-in provider list in the server codepath.
- Add `resumeArgs` to `extensions/kimi/freshell.json` now:

```json
"resumeArgs": ["--session", "{{sessionId}}"]
```

- Keep the manifest-driven registration path in `server/index.ts`, but make sure `server/coding-cli/command-specs.ts` now compiles Kimi `resumeArgs`.
- Extend the `server/coding-cli/command-specs.ts` test coverage so manifest-compiled runtime specs, not fallback specs alone, prove Kimi resume support.
- Update the Kimi fallback specs in `server/terminal-registry.ts` and `server/spawn-spec.ts`:

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

- Update `docs/index.html` so the mock UI reflects Kimi as a first-class agent: include it in the settings copy and session examples instead of leaving it implied.

- [ ] **Step 4: Re-run the targeted tests and make sure they pass**

Run:

```bash
npm run test:vitest -- --run test/unit/server/coding-cli/command-specs.test.ts test/unit/server/terminal-registry.test.ts test/server/session-association.test.ts test/unit/server/coding-cli/provider-registry.test.ts test/e2e/directory-picker-flow.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: all PASS.

- [ ] **Step 5: Final refactor and full verification**

Refactor for durability:

- keep provider registration in exactly one module
- keep Kimi resume support manifest-driven, with no sidebar/restore special cases
- confirm `server/coding-cli/session-manager.ts` remains untouched and Kimi stays terminal-mode only
- keep the dead `server/spawn-spec.ts` copy aligned with a comment, not new production logic

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
git add server/coding-cli/providers/index.ts extensions/kimi/freshell.json server/index.ts server/terminal-registry.ts server/spawn-spec.ts test/unit/server/coding-cli/command-specs.test.ts test/unit/server/terminal-registry.test.ts test/server/session-association.test.ts test/unit/server/coding-cli/provider-registry.test.ts test/e2e/directory-picker-flow.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx docs/index.html
git commit -m "feat: wire Kimi session registration and resume"
```
