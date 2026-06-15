# Fresh Agent Centralization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the obsolete agent-chat client/runtime surface in one migration so all agent panes, settings, history, and browser smoke coverage use the fresh-agent path.

**Architecture:** Treat `fresh-agent` as the only live agent UI and WebSocket contract. Keep only one-time migration at persistence/config boundaries so already-saved Freshell layouts and config records become fresh-agent records before render; do not keep live `agentChat` Redux state, UI branches, `/api/agent-chat/*`, `/api/agent-sessions/*`, or top-level `sdk.*` client messages. Move still-useful Claude history code and shared transcript widgets to fresh-agent-owned modules before deleting old paths.

**Tech Stack:** React 18, TypeScript, Redux Toolkit, Express, ws, Zod, Vitest, Testing Library, Playwright browser e2e, Tailwind CSS.

---

## Scope Check

This is intentionally one comprehensive migration. It touches client UI, Redux state, persisted layout migration, settings/config normalization, WebSocket protocol, server REST routes, Claude history internals, tests, and browser smoke coverage in the same branch. The implementation must land as a single cohesive PR because partial compatibility is exactly the state being removed.

Do not keep old live clients working. These are allowed because they are migration boundaries, not live obsolete infrastructure:

- Reading old persisted pane content with `kind: "agent-chat"` and converting it to `kind: "fresh-agent"` before render.
- Reading old stored config/local-settings keys named `agentChat` and converting them to `freshAgent` before the app sees settings.
- Internal Claude history code that still restores durable Claude transcripts, after it is renamed/moved under `server/fresh-agent/history/claude`.

Everything else named `agent-chat`, `agentChat`, `AgentChat`, or top-level client `sdk.*` should either be deleted or renamed to fresh-agent ownership.

## Load-Bearing Corrections From Validation

The load-bearing pass found several assumptions that were false in the first draft. The implementation must satisfy these corrections before deleting the old surfaces:

- **Pane migration must cover every ingress.** Normalize or reject legacy `agent-chat` pane content in local persisted state, storage migration, tab reopen/closed-tab snapshots, cross-tab sync, `ui.layout.sync`, server `agent-api` layout schemas/stores, MCP/tooling layout inputs, and any tab registry path. A migration helper must never return live `kind: "agent-chat"` content after a migration boundary. If a legacy pane cannot be mapped, return a `fresh-agent` pane with `restoreError: buildRestoreError('invalid_legacy_restore_target')` instead of a blank or legacy pane.
- **Tab registry is a live pane-content ingress, not display-only metadata.** Normalize legacy `agent-chat` records in `src/lib/tab-registry-snapshot.ts`, `src/store/tabRegistrySync.ts`, `src/store/tabRegistrySlice.ts`, `server/tabs-registry/types.ts`, and `server/tabs-registry/store.ts`. Pulling or reopening a tab-registry record must never reintroduce `kind: "agent-chat"`.
- **Legacy pane shapes are broader than `provider: "freshclaude"`.** Tests must cover `provider: "freshclaude"`, `provider: "kilroy"`, old `provider: "claude"`, missing provider, missing identity, canonical Claude IDs, non-canonical aliases, `cliSessionId`/`timelineSessionId`, and split trees. Old `provider: "claude"` should migrate to `sessionType: "freshclaude"` and `provider: "claude"` when the durable identity is valid; otherwise it should become a restore-error fresh-agent pane.
- **Legacy Claude `sessionRef` cannot bypass canonical-ID validation.** `migrateLegacyFreshAgentContent` must validate legacy `agent-chat.sessionRef` the same way it validates `resumeSessionId`, `cliSessionId`, and `timelineSessionId`. A `sessionRef: { provider: "claude", sessionId: "named-alias" }` is not a durable restore target and must become a restore-error fresh-agent pane.
- **Legacy pane display overrides must be preserved or explicitly retired with tests.** Existing `agent-chat` panes may carry `showThinking`, `showTools`, or `showTimecodes`. The migration must either preserve these as fresh-agent pane overrides that `FreshAgentView` honors, or intentionally retire them with a test proving global fresh-agent settings still determine the visible behavior.
- **Storage migration must be recoverable.** Before rewriting `freshell.layout.v3`, write a versioned backup key and use a commit marker so quota/partial-write failures leave the previous layout readable. The required order is: write backup, write migrated layout, write marker, then mark the storage version. Recovery must run before any slice parses layout and before cleanup can remove backup keys. Use the real storage key and shape in tests. Add failure-injection tests for backup write failure, migrated-layout write failure, missing marker after reload, stale marker, and multi-tab interleaving. Add a synthetic large-layout migration test with an explicit pane-count/depth bound; if the synchronous path cannot meet the bound, change the design before implementation.
- **Settings migration is load-only.** `agentChat` is accepted only while loading stored config/local/browser preference seeds. Live `PATCH /api/settings` must accept `freshAgent` only and reject or drop top-level `agentChat` without mirroring it into responses. When both aliases exist in stored settings, `freshAgent` wins, provider entries are field-merged, and explicit empty arrays such as `freshAgent.defaultPlugins: []` must be preserved.
- **Stored settings migration must use one canonical helper.** Replace `normalizeFreshAgentCompatSettings` and every alias-merging path with `migrateLegacyFreshAgentSettingsInput`. Browser preference persistence must write only `freshAgent`. Internal direct `configStore.patchSettings` callers must ignore or reject `agentChat` the same way the HTTP route does.
- **History ownership is fresh-agent-owned, not adapter-private.** Durable Claude history should move to an adapter-neutral fresh-agent history namespace such as `server/fresh-agent/history/claude/*`, because `sdk-bridge`, `ws-handler`, and `session-history-loader` still need clean server-side access. Fresh-agent routes must preserve the old timeline error codes and semantics before `/api/agent-sessions/*` is removed: `RESTORE_NOT_FOUND`, `RESTORE_UNAVAILABLE`, `RESTORE_DIVERGED`, `RESTORE_STALE_REVISION`, required revision, cursor revision mismatch, `includeBodies`, turn body lookup, recent-first ordering, and default/max limits.
- **Public `sdk.*` removal requires more than renaming five events.** Split internal SDK bridge event types from the public browser protocol, map every UI-relevant event (`assistant`, `stream`, `result`, `permission`, `question`, `status`, `error`, `exit`, `killed`, cancellation, snapshot/init/metadata), make the no-op fresh-agent reducers mutate real state, port create/attach replay and restore gates, and add per-connection fresh-agent authorization checks before deleting top-level `sdk.*`. Create/attach must grant mutation rights deliberately; subscription alone is not enough unless tests prove subscription is mandatory and reliable for every mutating path.
- **Codex/OpenCode event parity must be explicit.** If Codex or OpenCode are snapshot/status-only live providers, state that as the contract and prove snapshot refresh covers their UI needs. Otherwise, normalize their live adapter events to fresh-agent event names before they reach the browser.
- **WebSocket protocol removal must bump and enforce the version.** Bump `WS_PROTOCOL_VERSION` in the same change that removes public `sdk.*`. A stale loaded bundle must fail closed before it can flush queued `sdk.*` or legacy `ui.layout.sync` messages, and the client must actively reload or present a non-reconnecting hard-stop state that cannot silently continue with stale code.
- **Old tests are a coverage inventory, not disposable trash.** Legacy agent-chat tests for restore races, session-lost recovery, input history, mobile approvals/questions, capability settings, tool coalescing, markdown/XSS, activity state, scroll/new-message badge behavior, mobile keyboard layout, status text, tool block/strip rendering, and context-menu copy actions must be converted to fresh-agent coverage or explicitly superseded by stronger fresh-agent tests before deletion.
- **Architecture guard must be path-aware.** A raw regex for `sdk\.` either misses removed public events or blocks legitimate internal SDK bridge modules. The guard must scan `src`, `server`, and `shared` with allowlisted internal server SDK files and explicit migration-boundary names. Rename or allow `migrateLegacyAgentChatDurableState`; do not leave it as an accidental guard failure.
- **Model/settings capabilities are distinct from runtime capabilities.** Existing `FreshAgentCapabilitiesSchema` means runtime booleans such as `send` and `interrupt`. The old `/api/agent-chat/capabilities` model catalog must move to a separately named fresh-agent model/settings capability contract and route, not reuse that runtime schema name.
- **Browser smoke must use the real harness safely.** Seed available fresh clients and storage through the existing e2e-browser harness, mock fresh-agent history/model-capability routes, suppress real provider side effects before the first React render, and use `freshell.layout.v3` rather than a made-up storage key. Storage-restored panes must not be able to send `freshAgent.create` or `freshAgent.attach` before suppression is installed.
- **Manual smoke must be process-group safe.** Start the worktree dev server in its own process group, record the group leader PID, verify `/proc/<pid>/cwd` is this worktree before stopping, and kill only that process group. Do not rely on killing the `npm run dev` wrapper PID alone.

## File Structure

- Move/modify: `src/components/agent-chat/DiffView.tsx` -> `src/components/fresh-agent/shared/DiffView.tsx`
  - Shared diff renderer used by fresh-agent tool and approval cards.
- Move/modify: `src/components/agent-chat/SlotReel.tsx` -> `src/components/fresh-agent/shared/SlotReel.tsx`
  - Small activity-strip animation used by `FreshAgentTranscript`.
- Move/modify: `src/components/agent-chat/tool-preview.ts` -> `src/components/fresh-agent/shared/tool-preview.ts`
  - Tool input preview helpers used by fresh-agent transcript components.
- Modify: `src/components/fresh-agent/FreshAgentItemCard.tsx`
  - Import fresh-agent-owned shared helpers.
- Modify: `src/components/fresh-agent/FreshAgentApprovalCard.tsx`
  - Import fresh-agent-owned `DiffView`.
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx`
  - Import fresh-agent-owned `SlotReel` and tool preview helper.
- Delete: `src/components/agent-chat/`
  - Remove `AgentChatView`, composer, banners, message bubbles, collapsed turns, old tool components, and old debounce hook after shared pieces are moved.
- Delete: `src/store/agentChatSlice.ts`, `src/store/agentChatThunks.ts`, `src/store/agentChatTypes.ts`
  - Remove legacy Redux state.
- Modify: `src/store/store.ts`
  - Remove `agentChat` reducer.
- Delete: `src/lib/sdk-message-handler.ts`
  - Remove top-level legacy `sdk.*` client message handling.
- Modify: `src/lib/fresh-agent-ws.ts`
  - Handle fresh-agent transport events only, with fresh-agent event names.
- Modify: `shared/ws-protocol.ts`
  - Remove legacy client/server `sdk.*` messages and define fresh-agent transport event payloads.
- Modify: `server/ws-handler.ts`
  - Remove client-facing `sdk.*` handlers and call the fresh-agent SDK event normalizer before sending provider events.
- Rename/modify: `shared/agent-chat-plugins.ts` -> `shared/fresh-agent-plugins.ts`
  - Rename plugin sanitization helpers to fresh-agent-owned names such as `sanitizeFreshAgentPluginPaths`.
- Rename/modify: `shared/agent-chat-capabilities.ts` -> `shared/fresh-agent-model-capabilities.ts`
  - Fresh-agent model/settings capability contracts. Do not reuse `FreshAgentCapabilitiesSchema`, which is already the runtime-command capability contract.
- Rename/modify: `src/lib/agent-chat-capabilities.ts` -> `src/lib/fresh-agent-model-capabilities.ts`
  - Client model/settings capability cache helpers against `/api/fresh-agent/model-capabilities`.
- Rename/modify: `server/agent-chat-capability-registry.ts` -> `server/fresh-agent/model-capability-registry.ts`
  - Server model/settings capability cache registry.
- Rename/modify: `server/agent-chat-capabilities-router.ts` -> `server/fresh-agent/model-capabilities-router.ts`
  - Mount at `/api/fresh-agent/model-capabilities`.
- Modify: `server/index.ts`
  - Remove `/api/agent-chat/capabilities` and `/api/agent-sessions/*`; mount fresh-agent model-capabilities route.
- Move/modify: `server/agent-timeline/history-source.ts` -> `server/fresh-agent/history/claude/history-source.ts`
- Move/modify: `server/agent-timeline/ledger.ts` -> `server/fresh-agent/history/claude/history-ledger.ts`
- Move/modify: `server/agent-timeline/service.ts` -> `server/fresh-agent/history/claude/history-service.ts`
- Move/modify: `server/agent-timeline/types.ts` -> `server/fresh-agent/history/claude/history-types.ts`
  - Claude durable history remains, but is no longer exposed as the legacy agent-timeline API.
- Delete: `server/agent-timeline/router.ts`
  - Remove legacy `/api/agent-sessions/:sessionId/timeline` and `/turns/:turnId`.
- Modify: `server/fresh-agent/adapters/claude/adapter.ts`
  - Import moved Claude history service/types.
- Modify: `server/sdk-bridge.ts`, `server/session-history-loader.ts`, `server/ws-handler.ts`
  - Import moved Claude history source/ledger helpers.
- Modify: `shared/settings.ts`, `server/config-store.ts`, `server/settings-router.ts`, `src/lib/browser-preferences.ts`, `src/store/settingsSlice.ts`
  - Return fresh-agent settings as canonical. Accept `freshAgent` only on live settings APIs. Read old `agentChat` only during stored config/local/browser-seed load migration; never mirror it into responses.
- Modify: `src/components/settings/WorkspaceSettings.tsx`, `src/components/fresh-agent/FreshAgentSettingsButton.tsx`, `src/components/fresh-agent/FreshAgentView.tsx`, `src/components/panes/PanePicker.tsx`, `src/components/panes/PaneContainer.tsx`, `src/components/Sidebar.tsx`, `src/components/TabBar.tsx`, `src/components/MobileTabStrip.tsx`, `src/hooks/useAgentSessionTurnCompletion.ts`, `src/lib/pane-activity.ts`, `src/lib/session-type-utils.ts`, `src/lib/session-utils.ts`, `src/lib/derivePaneTitle.ts`, `src/lib/deriveTabName.ts`, `src/lib/coding-agent-detection.ts`, `src/lib/tab-directory-preference.ts`, `src/lib/tab-fallback-identity.ts`, `src/store/panesSlice.ts`, `src/store/tabsSlice.ts`, `src/store/persistMiddleware.ts`, `src/store/persistedState.ts`, `src/store/storage-migration.ts`, `src/store/paneTreeValidation.ts`
  - Remove live `agent-chat` branches and selectors; keep fresh-agent migration helpers only where persisted unknown input enters.
- Rename/modify: `src/components/context-menu/agent-chat-copy.ts` -> `src/components/context-menu/fresh-agent-copy.ts`
  - Keep copy helpers, but remove production file paths with `agent-chat` names.
- Modify: `src/lib/tab-registry-snapshot.ts`, `src/store/tabRegistrySync.ts`, `src/store/tabRegistrySlice.ts`, `server/tabs-registry/types.ts`, `server/tabs-registry/store.ts`
  - Normalize tab-registry snapshots and records so pulling/reopening a remote tab cannot reintroduce `agent-chat` pane content.
- Modify: `server/agent-api/layout-schema.ts`, `server/agent-api/layout-store.ts`, `shared/ws-protocol.ts`
  - Normalize or reject legacy `agent-chat` content on remote/server layout sync before storage or broadcast.
- Modify: `src/lib/ws-client.ts`
  - Bump protocol/version handling and actively reload or hard-stop stale bundles before queued removed messages can flush.
- Modify: `src/lib/test-harness.ts`, `src/components/fresh-agent/FreshAgentView.tsx`
  - Add pre-render global fresh-agent side-effect suppression for e2e-browser migration smoke.
- Modify tests under `test/unit`, `test/integration`, `test/e2e`, and `test/e2e-browser`
  - Delete legacy-only agent-chat tests or convert their user-story coverage to fresh-agent tests.
- Create: `test/unit/architecture/fresh-agent-only-runtime.test.ts`
  - Runtime source architecture guard that fails if legacy live paths reappear.
- Create: `test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts`
  - Browser smoke test covering freshclaude, freshcodex, freshopencode, settings, migration, route removal, and absence of legacy UI/message paths.

---

### Task 1: Move Shared Transcript Widgets Out Of `agent-chat`

**Files:**
- Create: `src/components/fresh-agent/shared/DiffView.tsx`
- Create: `src/components/fresh-agent/shared/SlotReel.tsx`
- Create: `src/components/fresh-agent/shared/tool-preview.ts`
- Modify: `src/components/fresh-agent/FreshAgentItemCard.tsx:1-5`
- Modify: `src/components/fresh-agent/FreshAgentApprovalCard.tsx:1-8`
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx:1-6`
- Test: `test/unit/client/components/fresh-agent/FreshAgentSharedWidgets.test.tsx`

- [ ] **Step 1: Write the failing shared-widget import test**

Create `test/unit/client/components/fresh-agent/FreshAgentSharedWidgets.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import DiffView from '@/components/fresh-agent/shared/DiffView'
import SlotReel from '@/components/fresh-agent/shared/SlotReel'
import { getToolPreview } from '@/components/fresh-agent/shared/tool-preview'

describe('fresh-agent shared transcript widgets', () => {
  it('renders the moved diff view from the fresh-agent namespace', () => {
    render(<DiffView oldStr={'alpha\nbeta'} newStr={'alpha\ngamma'} filePath="src/example.ts" />)
    expect(screen.getByText('src/example.ts')).toBeInTheDocument()
    expect(screen.getByText(/gamma/)).toBeInTheDocument()
  })

  it('renders the moved slot reel from the fresh-agent namespace', () => {
    render(<SlotReel toolName="Bash" previewText="$ npm test" />)
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.getByText('$ npm test')).toBeInTheDocument()
  })

  it('keeps tool previews available without importing agent-chat modules', () => {
    expect(getToolPreview('Read', { file_path: '/tmp/example.txt' })).toBe('/tmp/example.txt')
    expect(getToolPreview('Bash', { command: 'npm test' })).toBe('$ npm test')
  })
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm run test:vitest -- test/unit/client/components/fresh-agent/FreshAgentSharedWidgets.test.tsx --run
```

Expected: FAIL because `@/components/fresh-agent/shared/DiffView`, `SlotReel`, and `tool-preview` do not exist yet.

- [ ] **Step 3: Move the three shared files**

Run:

```bash
mkdir -p src/components/fresh-agent/shared
git mv src/components/agent-chat/DiffView.tsx src/components/fresh-agent/shared/DiffView.tsx
git mv src/components/agent-chat/SlotReel.tsx src/components/fresh-agent/shared/SlotReel.tsx
git mv src/components/agent-chat/tool-preview.ts src/components/fresh-agent/shared/tool-preview.ts
```

- [ ] **Step 4: Update fresh-agent imports**

In `src/components/fresh-agent/FreshAgentItemCard.tsx`, replace the imports at the top with:

```tsx
import DiffView from '@/components/fresh-agent/shared/DiffView'
import { getToolPreview } from '@/components/fresh-agent/shared/tool-preview'
```

In `src/components/fresh-agent/FreshAgentApprovalCard.tsx`, replace the `DiffView` import with:

```tsx
import DiffView from '@/components/fresh-agent/shared/DiffView'
```

In `src/components/fresh-agent/FreshAgentTranscript.tsx`, replace the shared imports with:

```tsx
import SlotReel from '@/components/fresh-agent/shared/SlotReel'
import { getToolPreview } from '@/components/fresh-agent/shared/tool-preview'
```

- [ ] **Step 5: Run the focused test and existing fresh-agent transcript tests**

Run:

```bash
npm run test:vitest -- test/unit/client/components/fresh-agent/FreshAgentSharedWidgets.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx --run
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/fresh-agent/FreshAgentItemCard.tsx src/components/fresh-agent/FreshAgentApprovalCard.tsx src/components/fresh-agent/FreshAgentTranscript.tsx src/components/fresh-agent/shared test/unit/client/components/fresh-agent/FreshAgentSharedWidgets.test.tsx
git commit -m "Move transcript widgets into fresh-agent"
```

---

### Task 2: Make Settings Canonically `freshAgent`

**Files:**
- Move: `shared/agent-chat-plugins.ts` -> `shared/fresh-agent-plugins.ts`
- Modify: `shared/settings.ts:156-220`
- Modify: `shared/settings.ts:300-330`
- Modify: `shared/settings.ts:560-590`
- Modify: `shared/settings.ts:690-810`
- Modify: `shared/settings.ts:240-250`
- Modify: `shared/settings.ts:850-865`
- Modify: `shared/settings.ts:1015-1080`
- Modify: `shared/settings.ts:1145-1220`
- Modify: `shared/settings.ts:1250-1420`
- Modify: `server/config-store.ts:270-330`
- Modify: `server/settings-router.ts:70-80`
- Modify: `src/lib/browser-preferences.ts`
- Modify: `src/store/settingsSlice.ts`
- Modify: `src/components/settings/WorkspaceSettings.tsx:265-310`
- Modify: `src/components/fresh-agent/FreshAgentSettingsButton.tsx:55-75`
- Modify: `src/components/fresh-agent/FreshAgentView.tsx:300-325`
- Test: `test/unit/shared/settings.test.ts`
- Test: `test/unit/server/config-store.fresh-agent-settings.test.ts`
- Test: `test/integration/server/settings-api.test.ts`

- [ ] **Step 0: Lock the settings migration contract**

Use this contract throughout the task:

- Stored config/local/browser-seed input may contain `agentChat`; live HTTP settings patches may not.
- When stored input contains both `freshAgent` and `agentChat`, merge in this order: legacy `agentChat` first, canonical `freshAgent` second.
- Provider settings are field-merged per provider, not shallow-replaced by the whole provider object.
- `freshAgent.defaultPlugins: []` is an explicit canonical value and must override any non-empty legacy `agentChat.defaultPlugins`.
- Server responses, Redux state, browser-local resolved settings, and persisted browser preferences must expose only `freshAgent`.
- `server/config-store.ts` must delete or replace `normalizeFreshAgentCompatSettings`; that helper currently loses explicit empty plugin arrays and shallow-replaces provider records.
- `mergeServerSettings`, `configStore.patchSettings`, `settingsSlice`, and browser preference save/load code must not mirror `agentChat` back into memory or storage.

- [ ] **Step 1: Rewrite settings tests to require fresh-agent canonical output**

In `test/unit/shared/settings.test.ts`, replace old alias expectations with these tests:

```ts
it('migrates stored legacy agentChat input to canonical freshAgent settings', () => {
  const parsed = migrateLegacyFreshAgentSettingsInput({
    agentChat: {
      enabled: true,
      defaultPlugins: ['/tmp/plugin'],
      providers: {
        freshcodex: { style: 'serif', effort: 'high' },
      },
    },
  } as never)

  expect(parsed).toEqual({
    freshAgent: {
      enabled: true,
      defaultPlugins: ['/tmp/plugin'],
      providers: {
        freshcodex: { style: 'serif', effort: 'high' },
      },
    },
  })
  expect('agentChat' in parsed).toBe(false)
})

it('merges server settings into freshAgent without mirroring agentChat', () => {
  const merged = mergeServerSettings(defaultSettings, {
    freshAgent: {
      enabled: true,
      providers: {
        freshclaude: { defaultPermissionMode: 'acceptEdits' },
      },
    },
  })

  expect(merged.freshAgent.enabled).toBe(true)
  expect(merged.freshAgent.providers.freshclaude).toEqual({ defaultPermissionMode: 'acceptEdits' })
  expect('agentChat' in merged).toBe(false)
})

it('resolves browser-local fresh-agent settings without exposing agentChat', () => {
  const resolved = resolveLocalSettings({
    agentChat: { showTools: true, showThinking: true, fontScale: 1.25 },
  } as never)

  expect(resolved.freshAgent.showTools).toBe(true)
  expect(resolved.freshAgent.showThinking).toBe(true)
  expect(resolved.freshAgent.fontScale).toBe(1.25)
  expect('agentChat' in resolved).toBe(false)
})

it('gives canonical freshAgent stored values precedence over legacy agentChat values', () => {
  const parsed = migrateLegacyFreshAgentSettingsInput({
    agentChat: {
      defaultPlugins: ['/legacy/plugin'],
      providers: {
        freshcodex: { style: 'sans', effort: 'high' },
      },
    },
    freshAgent: {
      defaultPlugins: [],
      providers: {
        freshcodex: { style: 'serif' },
      },
    },
  } as never)

  expect(parsed.freshAgent.defaultPlugins).toEqual([])
  expect(parsed.freshAgent.providers.freshcodex).toEqual({ style: 'serif', effort: 'high' })
  expect('agentChat' in parsed).toBe(false)
})
```

In `test/integration/server/settings-api.test.ts`, add:

```ts
it('rejects live legacy agentChat settings patches', async () => {
  await request(app)
    .patch('/api/settings')
    .send({
      agentChat: {
        enabled: true,
        defaultPlugins: ['/tmp/plugin'],
        providers: { freshcodex: { style: 'serif' } },
      },
    })
    .expect(400)
})

it('returns only freshAgent settings after a canonical freshAgent patch', async () => {
  const res = await request(app)
    .patch('/api/settings')
    .send({
      freshAgent: {
        enabled: true,
        defaultPlugins: ['/tmp/plugin'],
        providers: { freshcodex: { style: 'serif' } },
      },
    })
    .expect(200)

  expect(res.body.freshAgent.enabled).toBe(true)
  expect(res.body.freshAgent.defaultPlugins).toEqual(['/tmp/plugin'])
  expect(res.body.freshAgent.providers.freshcodex).toEqual({ style: 'serif' })
  expect(res.body.agentChat).toBeUndefined()
})
```

In `test/unit/server/config-store.fresh-agent-settings.test.ts`, add a stored-config migration test that writes a raw config containing both aliases, `agentChat.providers.freshcodex.effort`, `freshAgent.providers.freshcodex.style`, `agentChat.defaultPlugins: ['/legacy/plugin']`, and `freshAgent.defaultPlugins: []`. Assert the loaded config has only `freshAgent`, preserves the explicit empty plugin list, and field-merges provider settings to `{ style: 'serif', effort: 'high' }`. Add a second test proving the old `normalizeFreshAgentCompatSettings` behavior cannot survive: a canonical empty plugin array and canonical provider partial must not be overwritten by legacy values.

In `test/unit/client/browser-preferences.fresh-agent-settings.test.ts`, add coverage that browser-local settings seeded with `agentChat` load as `freshAgent`, and that saving browser preferences writes only `freshAgent` with no `agentChat` alias.

- [ ] **Step 2: Run focused settings tests and verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/shared/settings.test.ts test/unit/server/config-store.fresh-agent-settings.test.ts test/integration/server/settings-api.test.ts --run
```

Expected: FAIL because current settings still include and mirror `agentChat`, the HTTP route still accepts the alias, and stored-config conflict precedence is shallow/ambiguous.

- [ ] **Step 3: Remove `agentChat` from exported settings types and defaults**

Move plugin sanitization out of the old namespace:

```bash
git mv shared/agent-chat-plugins.ts shared/fresh-agent-plugins.ts
```

Rename `sanitizeAgentChatPluginPaths` to `sanitizeFreshAgentPluginPaths` and update imports in `shared/settings.ts`, `server/sdk-bridge.ts`, and any tests.

In `shared/settings.ts`, remove `agentChat` from `ServerSettings`, `ServerSettingsPatch`, `LocalSettings`, `LocalSettingsPatch`, `ResolvedSettings`, schemas, and default objects. Keep an input-only migration helper for stored config/local/browser seeds:

```ts
type LegacyFreshAgentSettingsInput = Partial<ServerSettings['freshAgent'] & LocalSettings['freshAgent']> & {
  providers?: Record<string, unknown>
}

function readLegacyFreshAgentSettingsInput(candidate: Record<string, unknown>): LegacyFreshAgentSettingsInput | null {
  return isRecord(candidate.agentChat)
    ? candidate.agentChat as LegacyFreshAgentSettingsInput
    : null
}
```

First replace the existing private `mergeFreshAgentAliasObjects(agentChatInput, freshAgentInput)` implementation with an options-aware implementation whose parameters are named for their role, such as `legacyFreshAgentInput` and `canonicalFreshAgentInput`, not `agentChatInput`. Its default options must preserve existing current behavior, while `migrateLegacyFreshAgentSettingsInput` uses `{ canonicalWins: true, fieldMergeProviders: true, preserveExplicitEmptyArrays: true }`. Do not call a helper that has not been defined in this task.

Extract the current `sanitizeServerSettingsPatch` fresh-agent block into a reusable helper such as:

```ts
function sanitizeFreshAgentSettingsPatchInput(rawFreshAgent: Record<string, unknown>): ServerSettingsPatch['freshAgent'] {
  const freshAgent: ServerSettingsPatch['freshAgent'] = {}
  if (hasOwn(rawFreshAgent, 'enabled')) {
    freshAgent.enabled = !!rawFreshAgent.enabled
  }
  if (hasOwn(rawFreshAgent, 'initialSetupDone') && typeof rawFreshAgent.initialSetupDone === 'boolean') {
    freshAgent.initialSetupDone = rawFreshAgent.initialSetupDone
  }
  if (hasOwn(rawFreshAgent, 'defaultPlugins') && Array.isArray(rawFreshAgent.defaultPlugins)) {
    freshAgent.defaultPlugins = sanitizeFreshAgentPluginPaths(rawFreshAgent.defaultPlugins)
  }
  if (isRecord(rawFreshAgent.providers)) {
    const providers: NonNullable<ServerSettingsPatch['freshAgent']>['providers'] = {}
    // Move the existing provider-patch parsing loop here unchanged.
    if (Object.keys(providers).length > 0) {
      freshAgent.providers = providers
    }
  }
  return Object.keys(freshAgent).length > 0 ? freshAgent : undefined
}
```

Then add an exported helper for tests and config-store load paths:

```ts
export function migrateLegacyFreshAgentSettingsInput(candidate: Record<string, unknown>): Pick<ServerSettingsPatch & LocalSettingsPatch, 'freshAgent'> {
  const legacy = readLegacyFreshAgentSettingsInput(candidate)
  const canonical = isRecord(candidate.freshAgent) ? candidate.freshAgent : null
  const merged = mergeFreshAgentAliasObjects(legacy, canonical, {
    canonicalWins: true,
    fieldMergeProviders: true,
    preserveExplicitEmptyArrays: true,
  })
  const freshAgent = merged ? sanitizeFreshAgentSettingsPatchInput(merged) : undefined
  return freshAgent ? { freshAgent } : {}
}
```

Update `sanitizeServerSettingsPatch` so it reads only `candidate.freshAgent`; do not read `candidate.agentChat` there. Update the result assignment from:

```ts
sanitized.freshAgent = freshAgent
sanitized.agentChat = freshAgent
```

to:

```ts
sanitized.freshAgent = freshAgent
```

Update `server/config-store.ts` load migration to call `migrateLegacyFreshAgentSettingsInput` before `mergeServerSettings`, then drop `agentChat` from the loaded settings object. Update older migration helpers such as `migrateLegacyFreshClaudeSettings` so they write only `freshAgent` and never assign `migrated.agentChat`. Remove or stop using `normalizeFreshAgentCompatSettings`; do not keep a second alias merge path. Do not mirror `agentChat` back into the saved config.

Update `server/settings-router.ts` so a live HTTP PATCH with a top-level `agentChat` key returns `400` before lower-level sanitization:

```ts
if (Object.prototype.hasOwnProperty.call(req.body || {}, 'agentChat')) {
  res.status(400).json({ error: 'agentChat settings have been migrated; use freshAgent' })
  return
}
```

Update `mergeServerSettings` so it uses only:

```ts
const freshAgentPatch = normalizedPatch.freshAgent as Partial<ServerSettings['freshAgent']> | undefined
```

and remove the returned `agentChat` property entirely.

Update `configStore.patchSettings` so internal callers cannot persist `agentChat` through a non-HTTP path. Either sanitize it with the same live-patch helper as the route or explicitly reject it with a structured warning/error.

Update `resolveLocalSettings` so it uses:

```ts
const migratedFreshAgentPatch = patch
  ? migrateLegacyFreshAgentSettingsInput(patch as Record<string, unknown>).freshAgent
  : undefined
const freshAgentPatch = patch?.freshAgent ?? migratedFreshAgentPatch
```

and returns only:

```ts
freshAgent: normalizeLocalFreshAgent(mergeDefined(defaultLocalSettings.freshAgent, freshAgentPatch)),
```

Update `extractLegacyLocalSettingsSeed`, `stripLocalSettings`, `src/lib/browser-preferences.ts`, and `src/store/settingsSlice.ts` so legacy browser seeds are migrated on read through `readLegacyFreshAgentSettingsInput` or `migrateLegacyFreshAgentSettingsInput`, but every write and every Redux state shape uses only `freshAgent`. Do not leave separate `raw.agentChat`, `patch.agentChat`, or `agentChatInput` settings paths outside those helper functions.

- [ ] **Step 4: Update UI settings reads and writes**

In `src/components/settings/WorkspaceSettings.tsx`, replace the Fresh Agent section toggles so they read and write only `freshAgent`:

```tsx
checked={settings.freshAgent?.enabled ?? false}
onChange={(checked) => {
  applyServerSetting({ freshAgent: { enabled: checked } })
}}
```

```tsx
checked={settings.freshAgent?.showThinking ?? false}
onChange={(checked) => {
  applyLocalSetting({ freshAgent: { showThinking: checked } })
}}
```

```tsx
checked={settings.freshAgent?.showTools ?? false}
onChange={(checked) => {
  applyLocalSetting({ freshAgent: { showTools: checked } })
}}
```

```tsx
checked={settings.freshAgent?.showTimecodes ?? false}
onChange={(checked) => {
  applyLocalSetting({ freshAgent: { showTimecodes: checked } })
}}
```

In `src/components/fresh-agent/FreshAgentView.tsx`, replace provider settings fallback with:

```ts
const providerSettings = useAppSelector((state) =>
  state.settings.settings.freshAgent?.providers?.[paneContent.sessionType]
  ?? state.settings.serverSettings?.freshAgent?.providers?.[paneContent.sessionType]
)
const defaultShowTimecodes = useAppSelector((state) =>
  state.settings.localSettings.freshAgent?.showTimecodes
  ?? state.settings.settings.freshAgent?.showTimecodes
  ?? false
)
```

In `src/components/fresh-agent/FreshAgentSettingsButton.tsx`, replace any `agentChat` settings access with:

```ts
const freshAgentSettings = settings.freshAgent
const providerSettings = freshAgentSettings?.providers?.[sessionType]
```

- [ ] **Step 5: Run focused settings tests**

Run:

```bash
npm run test:vitest -- test/unit/shared/settings.test.ts test/unit/server/config-store.fresh-agent-settings.test.ts test/integration/server/settings-api.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared server/config-store.ts server/settings-router.ts server/sdk-bridge.ts src/lib/browser-preferences.ts src/store/settingsSlice.ts src/components/settings/WorkspaceSettings.tsx src/components/fresh-agent/FreshAgentSettingsButton.tsx src/components/fresh-agent/FreshAgentView.tsx test/unit/shared/settings.test.ts test/unit/server/config-store.fresh-agent-settings.test.ts test/unit/client/browser-preferences.fresh-agent-settings.test.ts test/integration/server/settings-api.test.ts
git commit -m "Make fresh-agent settings canonical"
```

---

### Task 3: Remove `agent-chat` Pane Type From Live Client State

**Files:**
- Modify: `src/store/paneTypes.ts:153-204`
- Modify: `shared/fresh-agent.ts:104-151`
- Modify: `src/store/persistedState.ts:249-262`
- Modify: `src/store/storage-migration.ts:107-130`
- Modify: `src/store/persistMiddleware.ts:141-165`
- Modify: `src/store/panesSlice.ts:127-170`
- Modify: `src/store/paneTreeValidation.ts:95-112`
- Modify: `src/components/TabsView.tsx:150-205`
- Modify: `src/lib/tab-registry-snapshot.ts`
- Modify: `src/store/tabRegistrySync.ts`
- Modify: `src/store/tabRegistrySlice.ts`
- Modify: `server/tabs-registry/types.ts`
- Modify: `server/tabs-registry/store.ts`
- Modify: `server/agent-api/layout-schema.ts`
- Modify: `server/agent-api/layout-store.ts`
- Modify: `shared/ws-protocol.ts`
- Test: `test/unit/client/fresh-agent-pane-migration.test.ts`
- Test: `test/unit/server/agent-layout-schema.test.ts`
- Test: `test/unit/server/agent-api/layout-store.fresh-agent.test.ts`
- Test: `test/unit/client/store/storage-migration.fresh-agent.test.ts`
- Test: `test/unit/client/store/persisted-state.fresh-agent.test.ts`
- Test: `test/unit/client/tab-registry-fresh-agent-migration.test.ts`
- Test: `test/unit/server/tabs-registry/fresh-agent-migration.test.ts`

- [ ] **Step 1: Write the failing pane migration tests**

Create `test/unit/client/fresh-agent-pane-migration.test.ts`:

```ts
import { migrateLegacyFreshAgentContent } from '@shared/fresh-agent'
import { validatePaneTree } from '@/store/paneTreeValidation'

describe('fresh-agent pane migration', () => {
  it('converts legacy agent-chat pane content to fresh-agent before render', () => {
    const migrated = migrateLegacyFreshAgentContent({
      kind: 'agent-chat',
      provider: 'freshclaude',
      sessionId: 'live-1',
      createRequestId: 'req-1',
      status: 'idle',
      resumeSessionId: '00000000-0000-4000-8000-000000000001',
      initialCwd: '/work',
      permissionMode: 'acceptEdits',
      effort: 'high',
      plugins: ['/tmp/plugin'],
    })

    expect(migrated).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      sessionId: 'live-1',
      createRequestId: 'req-1',
      status: 'idle',
      resumeSessionId: '00000000-0000-4000-8000-000000000001',
      initialCwd: '/work',
      permissionMode: 'acceptEdits',
      effort: 'high',
      plugins: ['/tmp/plugin'],
    })
  })

  it('rejects agent-chat as a live pane tree kind after migration boundaries', () => {
    const tree = {
      type: 'leaf',
      id: 'pane-1',
      content: {
        kind: 'agent-chat',
        provider: 'freshclaude',
        createRequestId: 'req-1',
        status: 'idle',
      },
    }

    expect(validatePaneTree(tree as never).valid).toBe(false)
  })

  it('migrates old claude-provider agent-chat records to freshclaude when the durable id is canonical', () => {
    const migrated = migrateLegacyFreshAgentContent({
      kind: 'agent-chat',
      provider: 'claude',
      createRequestId: 'req-old',
      status: 'idle',
      resumeSessionId: '00000000-0000-4000-8000-000000000123',
    })

    expect(migrated).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      sessionRef: { provider: 'claude', sessionId: '00000000-0000-4000-8000-000000000123' },
    })
  })

  it('converts incomplete legacy agent-chat records into fresh-agent restore errors', () => {
    const migrated = migrateLegacyFreshAgentContent({
      kind: 'agent-chat',
      provider: 'claude',
      createRequestId: 'req-bad',
      status: 'idle',
      resumeSessionId: 'named-alias',
    })

    expect(migrated).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'invalid_legacy_restore_target' },
    })
  })

  it('rejects non-canonical Claude sessionRef aliases in legacy agent-chat records', () => {
    const migrated = migrateLegacyFreshAgentContent({
      kind: 'agent-chat',
      provider: 'claude',
      createRequestId: 'req-alias',
      status: 'idle',
      sessionRef: { provider: 'claude', sessionId: 'named-alias' },
    })

    expect(migrated).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'invalid_legacy_restore_target' },
    })
    expect((migrated as { sessionRef?: unknown }).sessionRef).toBeUndefined()
  })

  it('preserves or intentionally retires legacy display overrides', () => {
    const migrated = migrateLegacyFreshAgentContent({
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-display',
      status: 'idle',
      showThinking: false,
      showTools: true,
      showTimecodes: true,
      resumeSessionId: '00000000-0000-4000-8000-000000000456',
    })

    expect(migrated).toMatchObject({
      kind: 'fresh-agent',
      showThinking: false,
      showTools: true,
      showTimecodes: true,
    })
  })
})
```

In `test/unit/server/agent-layout-schema.test.ts` and `test/unit/server/agent-api/layout-store.fresh-agent.test.ts`, add coverage that `ui.layout.sync` and `LayoutStore.updateFromUi()` normalize split trees containing legacy `agent-chat` leaves before storing or broadcasting. Include a nested split with one `agent-chat` leaf and one terminal leaf, and assert the stored layout contains no `kind: "agent-chat"`.

In `test/unit/client/store/storage-migration.fresh-agent.test.ts` and `test/unit/client/store/persisted-state.fresh-agent.test.ts`, add coverage for the real `freshell.layout.v3` shape and legacy pane records with `freshclaude`, `kilroy`, old `claude`, missing provider, missing identity, canonical Claude IDs, non-canonical aliases, `cliSessionId`, and `timelineSessionId`.

Create `test/unit/client/tab-registry-fresh-agent-migration.test.ts` and `test/unit/server/tabs-registry/fresh-agent-migration.test.ts`. Cover:

- `src/lib/tab-registry-snapshot.ts` serializes fresh-agent records, not `agent-chat`.
- `src/store/tabRegistrySync.ts` and `src/store/tabRegistrySlice.ts` normalize pulled records before they can reach `initLayout`.
- `server/tabs-registry/types.ts` and `server/tabs-registry/store.ts` accept stale persisted `agent-chat` records only as migration input and store fresh-agent output.
- Reopening a registry tab with an old `agent-chat` leaf produces a fresh-agent pane or a fresh-agent restore-error pane.

- [ ] **Step 2: Run the focused migration test and verify it fails**

Run:

```bash
npm run test:vitest -- test/unit/client/fresh-agent-pane-migration.test.ts test/unit/server/agent-layout-schema.test.ts --run
```

Expected: FAIL because `agent-chat` is still accepted as a live pane kind.

- [ ] **Step 3: Remove `AgentChatPaneContent` from live pane types**

In `src/store/paneTypes.ts`, delete both `AgentChatPaneContent` and `AgentChatPaneInput`, then update the union to:

```ts
export type PaneContent = TerminalPaneContent | BrowserPaneContent | EditorPaneContent
  | PickerPaneContent | FreshAgentPaneContent | ExtensionPaneContent
```

Where code needs to accept legacy raw input, use `Record<string, unknown>` and `migrateLegacyFreshAgentContent` before casting to `PaneContent`.

- [ ] **Step 4: Keep one migration helper and make its output fresh-agent only**

In `shared/fresh-agent.ts`, keep `migrateLegacyFreshAgentContent` but make the legacy branch total: once `input.kind === 'agent-chat'`, it must return `kind: 'fresh-agent'` for every valid object, never the original legacy input. Widen `FreshAgentCompatibilityShape` or introduce a dedicated raw legacy pane input type so the helper can legally read `timelineSessionId`, `cliSessionId`, `showThinking`, `showTools`, `showTimecodes`, and other display/restore fields before returning fresh-agent content.

```ts
if (input.kind !== 'agent-chat') {
  return input
}

const sessionType = normalizeFreshAgentSessionType(input.provider)
  ?? (input.provider === 'claude' ? 'freshclaude' : undefined)
const provider = resolveFreshAgentRuntimeProvider(sessionType)
  ?? (input.provider === 'claude' ? 'claude' : undefined)
const durableState = migrateLegacyFreshAgentDurableState({
  provider,
  sessionRef: input.sessionRef,
  resumeSessionId: input.resumeSessionId ?? input.timelineSessionId ?? input.cliSessionId,
  rejectNonCanonicalClaudeSessionRef: true,
})
const hasUsableIdentity = !!durableState.sessionRef || !!input.sessionId

return {
  ...input,
  kind: 'fresh-agent',
  sessionType: sessionType ?? 'freshclaude',
  provider: provider ?? 'claude',
  sessionRef: durableState.sessionRef,
  restoreError: durableState.restoreError
    ?? (!sessionType || !provider || !hasUsableIdentity ? buildRestoreError('invalid_legacy_restore_target') : undefined),
}
```

Add `migrateLegacyFreshAgentDurableState` instead of calling `migrateLegacyAgentChatDurableState` directly from pane migration. It must validate legacy `sessionRef` values, not only `resumeSessionId`/`cliSessionId`/`timelineSessionId`. If the legacy pane has neither a usable `sessionRef`, a canonical durable id, nor a live `sessionId`, preserve display metadata such as `initialCwd`, `modelSelection`, `permissionMode`, `effort`, `plugins`, `settingsDismissed`, `showThinking`, `showTools`, and `showTimecodes`, but attach `restoreError: buildRestoreError('invalid_legacy_restore_target')` so the user sees a recoverable fresh-agent pane instead of a blank pane.

If the implementation intentionally retires `showThinking`, `showTools`, or `showTimecodes` as per-pane overrides, replace the preservation assertion above with tests proving fresh-agent global settings control those views after migration. Do not silently drop them.

- [ ] **Step 5: Remove live `agent-chat` branches from pane normalization**

In `src/store/panesSlice.ts`, remove `sanitizeAgentChatContent` and every branch that returns `{ kind: 'agent-chat' }`. While touching this sanitizer, rename/import model helper symbols used by pane content to fresh-agent names (`normalizeFreshAgentModelSelection`, `normalizeFreshAgentEffortOverride`) so Task 3 can compile before Task 5 moves the broader capability module paths. In `sanitizePaneContent`, keep this fresh-agent branch after migration:

```ts
if (input.kind === 'fresh-agent') {
  const style = normalizeFreshAgentStyleOverride(input.style)
  return {
    kind: 'fresh-agent',
    sessionType: input.sessionType,
    provider: input.provider,
    sessionId: input.sessionId,
    createRequestId: input.createRequestId || nanoid(),
    status: input.status || 'creating',
    resumeSessionId: input.resumeSessionId,
    sessionRef: sanitizeSessionRef(input.sessionRef),
    serverInstanceId: typeof input.serverInstanceId === 'string' ? input.serverInstanceId : undefined,
    restoreError: RestoreErrorSchema.safeParse(input.restoreError).success
      ? RestoreErrorSchema.parse(input.restoreError)
      : undefined,
    initialCwd: input.initialCwd,
    createError: input.createError,
    modelSelection: normalizeFreshAgentModelSelection(input.modelSelection, input.model),
    model: input.model,
    permissionMode: input.permissionMode,
    sandbox: input.sandbox,
    effort: normalizeFreshAgentEffortOverride(input.effort),
    plugins: input.plugins,
    ...(style ? { style } : {}),
    settingsDismissed: input.settingsDismissed,
    showThinking: typeof input.showThinking === 'boolean' ? input.showThinking : undefined,
    showTools: typeof input.showTools === 'boolean' ? input.showTools : undefined,
    showTimecodes: typeof input.showTimecodes === 'boolean' ? input.showTimecodes : undefined,
  }
}
```

- [ ] **Step 6: Remove live `agent-chat` acceptance from validation**

In `src/store/paneTreeValidation.ts`, delete the `case 'agent-chat'` branch. The `fresh-agent` branch must validate `sessionType`, `provider`, `createRequestId`, and `status`.

- [ ] **Step 7: Normalize server and remote layout ingresses**

In `server/agent-api/layout-schema.ts`, remove `agent-chat` from the accepted stored pane union after adding a preprocessing step that calls `migrateLegacyFreshAgentNode` on unknown input before validation. In `server/agent-api/layout-store.ts`, call the same normalizer in every method that accepts supplied pane content, including `updateFromUi()` and any attach/closed-tab/import helper.

In `shared/ws-protocol.ts`, keep `UiLayoutSyncSchema.layouts` permissive enough for stale clients, but ensure the server normalizes `m.layouts` before storing or rebroadcasting. Do not reject stale layout sync messages before the normalizer has a chance to convert them.

Normalize tab-registry ingress in the same step:

- `src/lib/tab-registry-snapshot.ts` must emit fresh-agent pane snapshots.
- `src/store/tabRegistrySync.ts` must normalize incoming registry records before dispatching them.
- `src/store/tabRegistrySlice.ts` must reject or normalize any reducer payload containing `kind: "agent-chat"`.
- `server/tabs-registry/types.ts` may parse legacy records only through a preprocess/migration schema.
- `server/tabs-registry/store.ts` must normalize before persistence and before serving records back to clients.

- [ ] **Step 8: Add recoverable localStorage migration safeguards**

In `src/store/storage-migration.ts` and `src/store/persistedState.ts`, use the real layout storage key `freshell.layout.v3`. Before rewriting it, write a backup key such as `freshell.layout.v3.backup-before-fresh-agent-centralization` and a commit marker. If the backup write fails, abort before touching the original key and log a structured warning. If the migrated-layout write fails, leave the original key untouched. Write the commit marker only after the migrated layout write succeeds. If the commit marker is absent on the next load, prefer the original value or backup instead of a partially migrated value.

Add a synthetic layout-size test using a generated layout with at least 100 tabs, 1,000 leaves, and depth at the supported maximum. Set a generous CI-safe timing budget, for example 500 ms in the Vitest/jsdom environment. If that budget is not reliable, replace synchronous startup migration with a lazy or chunked design before proceeding.

- [ ] **Step 9: Run pane tests**

Run:

```bash
npm run test:vitest -- test/unit/client/fresh-agent-pane-migration.test.ts test/unit/server/agent-layout-schema.test.ts test/unit/server/agent-api/layout-store.fresh-agent.test.ts test/unit/client/store/storage-migration.fresh-agent.test.ts test/unit/client/store/persisted-state.fresh-agent.test.ts test/unit/client/tab-registry-fresh-agent-migration.test.ts test/unit/server/tabs-registry/fresh-agent-migration.test.ts test/unit/client/store/panesSlice.test.ts --run
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add shared/fresh-agent.ts shared/ws-protocol.ts src/store/paneTypes.ts src/store/panesSlice.ts src/store/paneTreeValidation.ts src/store/persistedState.ts src/store/storage-migration.ts src/store/persistMiddleware.ts src/components/TabsView.tsx src/lib/tab-registry-snapshot.ts src/store/tabRegistrySync.ts src/store/tabRegistrySlice.ts server/tabs-registry/types.ts server/tabs-registry/store.ts server/agent-api/layout-schema.ts server/agent-api/layout-store.ts test/unit/client/fresh-agent-pane-migration.test.ts test/unit/server/agent-layout-schema.test.ts test/unit/server/agent-api/layout-store.fresh-agent.test.ts test/unit/client/store/storage-migration.fresh-agent.test.ts test/unit/client/store/persisted-state.fresh-agent.test.ts test/unit/client/tab-registry-fresh-agent-migration.test.ts test/unit/server/tabs-registry/fresh-agent-migration.test.ts
git commit -m "Remove live agent-chat pane type"
```

---

### Task 4: Remove Legacy Agent Redux And UI Branches

**Files:**
- Modify: `src/store/store.ts:1-64`
- Modify: `src/components/panes/PaneContainer.tsx:1-890`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/TabBar.tsx`
- Modify: `src/components/MobileTabStrip.tsx`
- Modify: `src/hooks/useAgentSessionTurnCompletion.ts:1-118`
- Modify: `src/lib/pane-activity.ts:1-360`
- Modify: `src/lib/derivePaneTitle.ts`
- Modify: `src/lib/deriveTabName.ts`
- Modify: `src/lib/coding-agent-detection.ts`
- Modify: `src/lib/tab-directory-preference.ts`
- Modify: `src/lib/tab-fallback-identity.ts`
- Delete: `src/components/agent-chat/AgentChatView.tsx`
- Delete: `src/components/agent-chat/AgentChatSettings.tsx`
- Delete: `src/components/agent-chat/ChatComposer.tsx`
- Delete: `src/components/agent-chat/CollapsedTurn.tsx`
- Delete: `src/components/agent-chat/MessageBubble.tsx`
- Delete: `src/components/agent-chat/PermissionBanner.tsx`
- Delete: `src/components/agent-chat/QuestionBanner.tsx`
- Delete: `src/components/agent-chat/ThinkingIndicator.tsx`
- Delete: `src/components/agent-chat/ToolBlock.tsx`
- Delete: `src/components/agent-chat/ToolStrip.tsx`
- Delete: `src/components/agent-chat/useStreamDebounce.ts`
- Delete: `src/store/agentChatSlice.ts`
- Delete: `src/store/agentChatThunks.ts`
- Delete: `src/store/agentChatTypes.ts`
- Rename/modify: `src/components/context-menu/agent-chat-copy.ts` -> `src/components/context-menu/fresh-agent-copy.ts`
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `src/components/context-menu/menu-defs.ts`
- Delete: `test/unit/client/agentChatSlice.test.ts`
- Delete: `test/unit/client/ws-client-sdk.test.ts`
- Delete: `test/e2e/agent-chat-polish-flow.test.tsx`
- Delete: `test/e2e/agent-chat-capability-settings-flow.test.tsx`
- Delete: `test/e2e/agent-chat-restore-flow.test.tsx`
- Delete: `test/e2e/tool-coalesce.test.tsx`
- Convert before deleting: `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
- Convert before deleting: `test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx`
- Convert before deleting: `test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx`
- Convert before deleting: `test/unit/client/components/agent-chat/ChatComposer.test.tsx`
- Convert before deleting: `test/unit/client/components/agent-chat/MessageBubble.test.tsx`
- Convert before deleting: `test/unit/client/components/agent-chat/PermissionBanner.test.tsx`
- Convert before deleting: `test/unit/client/components/agent-chat/QuestionBanner.test.tsx`
- Convert before deleting: `test/unit/client/components/agent-chat/AgentChatSettings.test.tsx`

- [ ] **Step 1: Write the failing no-agent-chat Redux/UI test**

Create `test/unit/client/fresh-agent-only-ui-state.test.ts`:

```ts
import { store } from '@/store/store'
import { isCodingAgentPane } from '@/lib/coding-agent-detection'

describe('fresh-agent only UI state', () => {
  it('does not mount legacy agentChat Redux state', () => {
    expect(Object.keys(store.getState())).not.toContain('agentChat')
  })

  it('recognizes fresh-agent panes as coding agents without accepting agent-chat panes', () => {
    expect(isCodingAgentPane({ kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude' } as never)).toBe(true)
    expect(isCodingAgentPane({ kind: 'agent-chat', provider: 'freshclaude' } as never)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm run test:vitest -- test/unit/client/fresh-agent-only-ui-state.test.ts --run
```

Expected: FAIL because `store.getState()` still includes `agentChat`.

- [ ] **Step 3: Create the behavior coverage map before deleting legacy tests**

Create `test/unit/client/fresh-agent-legacy-behavior-coverage.test.ts` that maps old agent-chat tests to fresh-agent replacements. This must be an executable Vitest gate, not a markdown checklist. The mapping must include:

```text
test/unit/client/agentChatSlice.test.ts -> freshAgentSlice + freshAgentThunks restore/history/stream/result/permission tests
test/unit/client/sdk-message-handler.test.ts -> fresh-agent-ws event parity tests for every old sdk.* server event
test/unit/client/ws-client-sdk.test.ts -> fresh-agent websocket client contract tests and stale-protocol reload tests
test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx -> FreshAgentView reload restore tests
test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx -> FreshAgentView INVALID_SESSION_ID/session-lost recovery tests
test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx -> FreshAgentView split-pane restore tests
test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx -> FreshAgentView settings/setup/provider-default behavior tests
test/unit/client/components/agent-chat/AgentChatView.mobile-keyboard.test.tsx -> FreshAgentComposer/FreshAgentView mobile keyboard inset tests
test/unit/client/components/agent-chat/AgentChatView.scrollToBottom.test.tsx -> FreshAgentTranscript scroll-to-bottom and new-message badge tests
test/unit/client/components/agent-chat/AgentChatView.status.test.tsx -> FreshAgentView pending-answer/running/status-text tests
test/unit/client/components/agent-chat/ChatComposer.test.tsx -> FreshAgentComposer draft/history/tab-shortcut/mobile keyboard tests
test/unit/client/components/agent-chat/MessageBubble.test.tsx -> FreshAgentTranscript and item-card markdown/XSS/tool/toggle tests
test/unit/client/components/agent-chat/PermissionBanner.test.tsx -> FreshAgentApprovalCard mobile and desktop touch-target tests
test/unit/client/components/agent-chat/QuestionBanner.test.tsx -> FreshAgentQuestionBanner mobile and desktop touch-target tests
test/unit/client/components/agent-chat/AgentChatSettings.test.tsx -> FreshAgentSettingsButton capability/model/effort/default persistence tests
test/unit/client/components/agent-chat/ToolBlock.test.tsx -> FreshAgentItemCard tool input/output/copy-target tests
test/unit/client/components/agent-chat/ToolStrip.test.tsx -> FreshAgentTranscript activity-strip/tool-coalescing tests
test/unit/client/components/context-menu/agent-chat-actions.test.ts -> fresh-agent context-menu copy helper tests
test/unit/client/components/context-menu/menu-defs.test.ts -> fresh-agent context target menu-definition tests
test/e2e/agent-chat-context-menu-flow.test.tsx -> fresh-agent context-menu e2e flow
test/e2e/agent-chat-polish-flow.test.tsx -> fresh-agent polish e2e flow
test/e2e/agent-chat-capability-settings-flow.test.tsx -> fresh-agent model-capability/settings e2e flow
test/e2e/agent-chat-restore-flow.test.tsx -> fresh-agent restore e2e flow
test/e2e/tool-coalesce.test.tsx -> fresh-agent tool coalescing e2e flow
```

Do not `git rm` a legacy test file until either:

- its user-story behavior has an equivalent fresh-agent test that fails before the port and passes after it, or
- the behavior is intentionally obsolete and the architecture guard or browser smoke proves the new behavior.

The coverage test must fail if any file under `test/unit/client/components/agent-chat`, `test/unit/client/agentChatSlice.test.ts`, `test/unit/client/sdk-message-handler.test.ts`, `test/unit/client/ws-client-sdk.test.ts`, `test/unit/client/components/context-menu/*agent-chat*`, or `test/e2e/agent-chat-*.tsx` is missing from the matrix. Category-only mapping is not sufficient.

- [ ] **Step 4: Remove `agentChat` reducer from root store**

In `src/store/store.ts`, delete:

```ts
import agentChatReducer from './agentChatSlice'
```

and delete this reducer entry:

```ts
agentChat: agentChatReducer,
```

- [ ] **Step 5: Remove `AgentChatView` render path**

In `src/components/panes/PaneContainer.tsx`, delete the `AgentChatView` import and delete this branch:

```tsx
if (content.kind === 'agent-chat') {
  return (
    <ErrorBoundary key={paneId} label="Chat">
      <AgentChatView
        tabId={tabId}
        paneId={paneId}
        paneContent={content}
        hidden={hidden}
      />
    </ErrorBoundary>
  )
}
```

Keep the existing `content.kind === 'fresh-agent'` branch unchanged except for any type errors caused by removed agent-chat types.

- [ ] **Step 6: Remove `agentChatSessions` selectors and branches from activity surfaces**

In `src/hooks/useAgentSessionTurnCompletion.ts`, remove `ChatSessionState`, `EMPTY_AGENT_CHAT_SESSIONS`, `agentChatSessions`, and the `else if (content.kind === 'agent-chat')` block. The loop should only handle:

```ts
if (content.kind !== 'fresh-agent') {
  continue
}
const session = content.sessionId
  ? freshAgentSessions[makeFreshAgentSessionKey({
    sessionType: content.sessionType,
    provider: content.provider,
    sessionId: content.sessionId,
  })]
  : undefined
sessionKey = resolveFreshAgentSessionKey(content, session)
isBusy = isFreshAgentBusy(content, session)
hasPending = hasWaitingItems(session)
```

In `src/lib/pane-activity.ts`, remove `ChatSessionState`, `isAgentChatBusy`, `resolveAgentChatSessionKey`, and the `content.kind === 'agent-chat'` branches. The projection input should no longer include `agentChatSessions`.

- [ ] **Step 7: Delete old UI and store files**

Run:

```bash
git rm -r src/components/agent-chat
git rm src/store/agentChatSlice.ts src/store/agentChatThunks.ts src/store/agentChatTypes.ts
git mv src/components/context-menu/agent-chat-copy.ts src/components/context-menu/fresh-agent-copy.ts
```

Rename the exported helper functions from `copyAgentChatCodeBlock`, `copyAgentChatToolInput`, `copyAgentChatToolOutput`, `copyAgentChatDiffNew`, `copyAgentChatDiffOld`, and `copyAgentChatFilePath` to `copyFreshAgentCodeBlock`, `copyFreshAgentToolInput`, `copyFreshAgentToolOutput`, `copyFreshAgentDiffNew`, `copyFreshAgentDiffOld`, and `copyFreshAgentFilePath`. Update `src/components/context-menu/ContextMenuProvider.tsx`, `src/components/context-menu/menu-defs.ts`, and related tests to import and call the renamed `fresh-agent-copy` helper. After this step, `rg -n "copyAgentChat|agent-chat-copy" src/components/context-menu test/unit/client/components/context-menu` must have no hits except deleted-test coverage inventory text.

- [ ] **Step 8: Convert legacy tests, then delete only the superseded files**

After the behavior coverage map is green, move reusable tests into fresh-agent files and delete the superseded legacy files. At minimum, do not delete these files until their mapped fresh-agent replacements exist:

```bash
git rm test/unit/client/agentChatSlice.test.ts test/unit/client/ws-client-sdk.test.ts test/e2e/agent-chat-polish-flow.test.tsx test/e2e/agent-chat-capability-settings-flow.test.tsx test/e2e/agent-chat-restore-flow.test.tsx test/e2e/tool-coalesce.test.tsx
```

Run the converted fresh-agent coverage, not just the existing narrow tests:

```bash
npm run test:vitest -- test/unit/client/fresh-agent-legacy-behavior-coverage.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx test/unit/client/components/fresh-agent/FreshAgentApprovalCard.test.tsx test/unit/client/components/fresh-agent/FreshAgentQuestionBanner.test.tsx test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx test/unit/client/components/context-menu/fresh-agent-actions.test.ts test/unit/client/components/context-menu/menu-defs.test.ts test/unit/client/lib/fresh-agent-ws.test.ts --run
```

- [ ] **Step 9: Run client typecheck and focused UI tests**

Run:

```bash
npm run typecheck:client
npm run test:vitest -- test/unit/client/fresh-agent-only-ui-state.test.ts test/unit/client/fresh-agent-legacy-behavior-coverage.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx test/unit/client/components/context-menu/fresh-agent-actions.test.ts --run
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src test
git commit -m "Remove legacy agent-chat UI state"
```

---

### Task 5: Move Model Capabilities To Fresh-Agent And Remove `/api/agent-chat/capabilities`

**Files:**
- Move: `shared/agent-chat-capabilities.ts` -> `shared/fresh-agent-model-capabilities.ts`
- Move: `src/lib/agent-chat-capabilities.ts` -> `src/lib/fresh-agent-model-capabilities.ts`
- Move: `server/agent-chat-capability-registry.ts` -> `server/fresh-agent/model-capability-registry.ts`
- Move: `server/agent-chat-capabilities-router.ts` -> `server/fresh-agent/model-capabilities-router.ts`
- Modify: `src/components/fresh-agent/FreshAgentSettingsButton.tsx`
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/lib/api.ts`
- Modify: `server/index.ts`
- Test: `test/integration/server/fresh-agent-model-capabilities-router.test.ts`
- Test: `test/unit/server/fresh-agent/model-capability-registry.test.ts`
- Delete: `test/integration/server/agent-chat-capabilities-router.test.ts`
- Delete: `test/unit/server/agent-chat-capability-registry.test.ts`

- [ ] **Step 0: Keep model/settings capabilities separate from runtime capabilities**

Do not reuse `FreshAgentCapabilitiesSchema` from `shared/fresh-agent-contract.ts`; that schema already describes runtime command support such as `send`, `interrupt`, and approvals. The moved agent-chat capability route is a model/settings catalog for model options, effort levels, cache status, and errors.

Use these canonical names:

```text
FreshAgentModelCapabilities
FreshAgentModelCapabilitiesResponse
FreshAgentModelCapabilitiesState
FreshAgentModelCapabilityRegistry
createFreshAgentModelCapabilitiesRouter
parseFreshAgentModelCapabilitiesResponse
```

Expose this route family:

```text
GET  /api/fresh-agent/model-capabilities/:sessionType
POST /api/fresh-agent/model-capabilities/:sessionType/refresh
```

The response should include both `sessionType` and `runtimeProvider`. `freshclaude` and `kilroy` may share the Claude model catalog, but `freshcodex` and `freshopencode` must have explicit provider-specific behavior: either a real model catalog or an `ok: false`/`unavailable` response with a documented code. Do not silently reuse Claude data for non-Claude providers.

- [ ] **Step 1: Write the failing fresh-agent model-capabilities route test**

Create `test/integration/server/fresh-agent-model-capabilities-router.test.ts` by adapting the existing agent-chat capabilities router test to this route:

```ts
import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createFreshAgentModelCapabilitiesRouter } from '../../../server/fresh-agent/model-capabilities-router.js'
import { FreshAgentModelCapabilityRegistry } from '../../../server/fresh-agent/model-capability-registry.js'

describe('fresh-agent model capabilities router', () => {
  it('serves model capabilities from /api/fresh-agent/model-capabilities/:sessionType', async () => {
    const app = express()
    const registry = new FreshAgentModelCapabilityRegistry()
    app.use('/api/fresh-agent/model-capabilities', createFreshAgentModelCapabilitiesRouter({ registry }))

    const res = await request(app).get('/api/fresh-agent/model-capabilities/freshclaude').expect(200)

    expect(res.body.sessionType).toBe('freshclaude')
    expect(res.body.runtimeProvider).toBe('claude')
    expect(res.body.status).toMatch(/fresh|cached|unavailable/)
  })

  it('does not reuse Claude model data for non-Claude fresh-agent session types', async () => {
    const app = express()
    const registry = new FreshAgentModelCapabilityRegistry()
    app.use('/api/fresh-agent/model-capabilities', createFreshAgentModelCapabilitiesRouter({ registry }))

    const res = await request(app).get('/api/fresh-agent/model-capabilities/freshopencode').expect(200)

    expect(res.body.sessionType).toBe('freshopencode')
    expect(res.body.runtimeProvider).toBe('opencode')
    expect(res.body).not.toMatchObject({
      runtimeProvider: 'opencode',
      models: expect.arrayContaining([
        expect.objectContaining({ provider: 'claude' }),
      ]),
    })
    expect(res.body.status === 'unavailable' || res.body.models.every((model: { provider?: string }) => model.provider === 'opencode')).toBe(true)
  })
})
```

- [ ] **Step 2: Run the route test and verify it fails**

Run:

```bash
npm run test:vitest -- test/integration/server/fresh-agent-model-capabilities-router.test.ts --run
```

Expected: FAIL because `server/fresh-agent/model-capabilities-router.js` does not exist.

- [ ] **Step 3: Move capability modules**

Run:

```bash
git mv shared/agent-chat-capabilities.ts shared/fresh-agent-model-capabilities.ts
git mv src/lib/agent-chat-capabilities.ts src/lib/fresh-agent-model-capabilities.ts
git mv server/agent-chat-capability-registry.ts server/fresh-agent/model-capability-registry.ts
git mv server/agent-chat-capabilities-router.ts server/fresh-agent/model-capabilities-router.ts
```

Rename exported symbols:

```ts
AgentChatCapabilityRegistry -> FreshAgentModelCapabilityRegistry
createAgentChatCapabilitiesRouter -> createFreshAgentModelCapabilitiesRouter
AgentChatProviderCapabilities -> FreshAgentModelCapabilities
AgentChatProviderCapabilitiesState -> FreshAgentModelCapabilitiesState
AgentChatModelSelection -> FreshAgentModelSelection
AgentChatModelSelectionSchema -> FreshAgentModelSelectionSchema
normalizeAgentChatModelSelection -> normalizeFreshAgentModelSelection
normalizeAgentChatEffortOverride -> normalizeFreshAgentEffortOverride
isAgentChatModelSelection -> isFreshAgentModelSelection
```

Keep `shared/fresh-agent-contract.ts` runtime `FreshAgentCapabilitiesSchema` unchanged except for import updates elsewhere. Update `shared/settings.ts`, `src/store/paneTypes.ts`, `src/store/tabsSlice.ts`, fresh-agent components, and tests to import and use the fresh-agent model-selection names above. After this task, `rg -n "AgentChatModelSelection|normalizeAgentChat|isAgentChatModelSelection|agent-chat-capabilities" src server shared` must have no hits.

- [ ] **Step 4: Update API route helpers**

In `src/lib/api.ts`, replace legacy capability helper URLs with:

```ts
export async function getFreshAgentModelCapabilities(sessionType: string, options?: ApiRequestOptions) {
  return parseFreshAgentModelCapabilitiesResponse(
    await api.get(`/api/fresh-agent/model-capabilities/${encodeURIComponent(sessionType)}`, options),
  )
}

export async function refreshFreshAgentModelCapabilities(sessionType: string, options?: ApiRequestOptions) {
  return parseFreshAgentModelCapabilitiesResponse(
    await api.post(`/api/fresh-agent/model-capabilities/${encodeURIComponent(sessionType)}/refresh`, {}, options),
  )
}
```

- [ ] **Step 5: Update server mount**

In `server/index.ts`, replace:

```ts
app.use('/api/agent-chat/capabilities', createAgentChatCapabilitiesRouter({
  registry: agentChatCapabilityRegistry,
}))
```

with:

```ts
app.use('/api/fresh-agent/model-capabilities', createFreshAgentModelCapabilitiesRouter({
  registry: freshAgentModelCapabilityRegistry,
}))
```

Rename the local registry variable:

```ts
const freshAgentModelCapabilityRegistry = new FreshAgentModelCapabilityRegistry()
```

- [ ] **Step 6: Delete legacy capability tests**

Run:

```bash
git rm test/integration/server/agent-chat-capabilities-router.test.ts test/unit/server/agent-chat-capability-registry.test.ts
```

- [ ] **Step 7: Run focused capability tests**

Run:

```bash
npm run test:vitest -- test/integration/server/fresh-agent-model-capabilities-router.test.ts test/unit/server/fresh-agent/model-capability-registry.test.ts --run
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add shared src server test
git commit -m "Rename capabilities to fresh-agent"
```

---

### Task 6: Move Claude History Internals Under Fresh-Agent And Delete Legacy Timeline Route

**Files:**
- Move: `server/agent-timeline/history-source.ts` -> `server/fresh-agent/history/claude/history-source.ts`
- Move: `server/agent-timeline/ledger.ts` -> `server/fresh-agent/history/claude/history-ledger.ts`
- Move: `server/agent-timeline/service.ts` -> `server/fresh-agent/history/claude/history-service.ts`
- Move: `server/agent-timeline/types.ts` -> `server/fresh-agent/history/claude/history-types.ts`
- Delete: `server/agent-timeline/router.ts`
- Modify: `server/fresh-agent/adapters/claude/adapter.ts`
- Modify: `server/fresh-agent/router.ts`
- Modify: `server/fresh-agent/runtime-manager.ts`
- Modify: `server/sdk-bridge.ts`
- Modify: `server/session-history-loader.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/index.ts`
- Move/modify tests from `test/unit/server/agent-timeline-*` to `test/unit/server/fresh-agent/claude-history-*`
- Modify: `test/unit/server/fresh-agent/claude-restore-contract.test.ts`
- Test: `test/integration/server/fresh-agent-claude-history-route-parity.test.ts`
- Delete: `test/integration/server/agent-timeline-router.test.ts`

- [ ] **Step 0: Preserve the old route semantics in the new route family first**

Before removing `/api/agent-sessions/*`, prove the fresh-agent route family can express the same restore outcomes:

```text
RESTORE_NOT_FOUND -> HTTP 404
RESTORE_UNAVAILABLE -> HTTP 503
RESTORE_DIVERGED -> HTTP 409
RESTORE_STALE_REVISION -> HTTP 409 with currentRevision
missing revision for paged/turn body reads -> HTTP 400
cursor revision mismatch -> HTTP 409
includeBodies=true -> bodies keyed by turnId
turn body route -> one full turn body or 404
recent-first ordering -> same chronological contract as AgentTimelineService
default/max limits -> same defaults and caps as AgentTimelineService
```

The response shape does not need to be byte-compatible with `/api/agent-sessions/*`, but error bodies must keep the `RESTORE_*` codes above so existing UI branches and tests can distinguish not-found, unavailable, diverged, and stale-revision states. The meaning, ordering, cursor, limits, and error-code contract must be covered by fresh-agent tests before the old route is deleted.

- [ ] **Step 1: Write the failing route-parity integration test**

Create `test/integration/server/fresh-agent-claude-history-route-parity.test.ts`:

```ts
import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createFreshAgentRouter } from '../../../server/fresh-agent/router.js'
import { FreshAgentRuntimeManager } from '../../../server/fresh-agent/runtime-manager.js'
import { createFreshAgentProviderRegistry } from '../../../server/fresh-agent/provider-registry.js'
import { RestoreResolutionError, RestoreStaleRevisionError } from '../../../server/agent-timeline/service.js'
import type { FreshAgentRuntimeAdapter } from '../../../server/fresh-agent/runtime-adapter.js'

function makeClaudeHistoryParityAdapter(): FreshAgentRuntimeAdapter {
  return {
    runtimeProvider: 'claude',
    async create() {
      return { sessionId: 'created' }
    },
    async getSnapshot({ threadId }) {
      if (threadId === 'not-found') throw new RestoreResolutionError('RESTORE_NOT_FOUND', 'Restore session not found')
      if (threadId === 'unavailable') throw new RestoreResolutionError('RESTORE_UNAVAILABLE', 'Restore source unavailable')
      if (threadId === 'diverged') throw new RestoreResolutionError('RESTORE_DIVERGED', 'Restore history diverged')
      if (threadId === 'stale') throw new RestoreStaleRevisionError(1, 2)
      return { threadId, revision: 1, turns: [] }
    },
  }
}

describe('fresh-agent route centralization', () => {
  it('maps Claude restore errors through fresh-agent thread routes before legacy route removal', async () => {
    const app = express()
    const registry = createFreshAgentProviderRegistry([{
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      adapter: makeClaudeHistoryParityAdapter(),
    }])
    const runtimeManager = new FreshAgentRuntimeManager({ registry })
    app.use('/api', createFreshAgentRouter({ runtimeManager }))

    await request(app).get('/api/fresh-agent/threads/freshclaude/claude/not-found?revision=1').expect(404)
    await request(app).get('/api/fresh-agent/threads/freshclaude/claude/unavailable?revision=1').expect(503)
    await request(app).get('/api/fresh-agent/threads/freshclaude/claude/diverged?revision=1').expect(409)
    await request(app).get('/api/fresh-agent/threads/freshclaude/claude/stale?revision=1').expect(409)
  })
})
```

For each response above, assert the body `code` is the legacy `RESTORE_*` code, not a generic fresh-agent or HTTP error code. Add a second test in the same file for `GET /api/fresh-agent/threads/:sessionType/:provider/:threadId/turns?includeBodies=true&revision=...` and `/turns/:turnId`, asserting `nextCursor`, `revision`, `turns`, `bodies`, recent-first order, missing revision `400`, cursor revision mismatch `409`, and default/max limit semantics.

- [ ] **Step 2: Run the route-parity test and verify it fails on missing fresh history error mapping**

Run:

```bash
npm run test:vitest -- test/integration/server/fresh-agent-claude-history-route-parity.test.ts --run
```

Expected: FAIL until fresh-agent route error mapping and Claude history imports are updated.

- [ ] **Step 3: Move Claude history files**

Run:

```bash
mkdir -p server/fresh-agent/history/claude
git mv server/agent-timeline/history-source.ts server/fresh-agent/history/claude/history-source.ts
git mv server/agent-timeline/ledger.ts server/fresh-agent/history/claude/history-ledger.ts
git mv server/agent-timeline/service.ts server/fresh-agent/history/claude/history-service.ts
git mv server/agent-timeline/types.ts server/fresh-agent/history/claude/history-types.ts
git rm server/agent-timeline/router.ts
rmdir server/agent-timeline
```

Use `server/fresh-agent/history/claude`, not `server/fresh-agent/adapters/claude`, so `sdk-bridge`, `ws-handler`, and `session-history-loader` do not import through adapter implementation internals.

- [ ] **Step 4: Rename exported history symbols**

In moved files, rename these public symbols:

```ts
AgentHistorySource -> ClaudeFreshAgentHistorySource
createAgentHistorySource -> createClaudeFreshAgentHistorySource
AgentTimelineService -> ClaudeFreshAgentHistoryService
createAgentTimelineService -> createClaudeFreshAgentHistoryService
AgentTimelinePage -> ClaudeFreshAgentHistoryPage
AgentTimelineTurn -> ClaudeFreshAgentHistoryTurn
AgentTimelineItem -> ClaudeFreshAgentHistoryItem
RestoreResolutionError -> ClaudeFreshAgentHistoryResolutionError
RestoreStaleRevisionError -> ClaudeFreshAgentStaleHistoryRevisionError
```

Keep the cursor, revision, and chronological behavior identical to the existing service unless a fresh-agent test already expects a different order.

- [ ] **Step 5: Update imports**

Use this search to drive import updates:

```bash
rg -n "agent-timeline|createAgentTimelineService|AgentTimelineService|createAgentHistorySource|AgentHistorySource|RestoreStaleRevisionError|RestoreResolutionError|synthesizeDeterministicMessageId|createDurableMessageFingerprint|synthesizeLiveMessageId" server test shared src
```

Every production hit should import from `server/fresh-agent/history/claude/*` or use the new symbol names.

Update `test/integration/server/fresh-agent-claude-history-route-parity.test.ts` too: after the move it must import `ClaudeFreshAgentHistoryResolutionError` and `ClaudeFreshAgentStaleHistoryRevisionError` from `server/fresh-agent/history/claude/history-service.js`, not the old `server/agent-timeline/service.js` path. The test must continue throwing the real moved error classes, not plain `Error` objects with copied `code` fields.

In `server/fresh-agent/adapters/claude/adapter.ts`, the top imports should become:

```ts
import {
  ClaudeFreshAgentHistoryResolutionError,
  ClaudeFreshAgentStaleHistoryRevisionError,
  createClaudeFreshAgentHistoryService,
  type ClaudeFreshAgentHistoryService,
} from '../../history/claude/history-service.js'
import type { ClaudeFreshAgentHistorySource } from '../../history/claude/history-source.js'
import { synthesizeLiveMessageId, type RestoreResolution } from '../../history/claude/history-ledger.js'
```

In `server/sdk-bridge.ts`, `server/session-history-loader.ts`, and `server/ws-handler.ts`, import from `server/fresh-agent/history/claude/*`, not from `server/fresh-agent/adapters/claude/*`.

- [ ] **Step 6: Port old timeline error mapping into fresh-agent route/runtime**

In `server/fresh-agent/router.ts` and `server/fresh-agent/runtime-manager.ts`, map the moved Claude history errors to the same HTTP meanings and `RESTORE_*` body codes listed in Step 0. Keep the fresh-agent response shape (`turns`, `bodies`, `threadId`, `sessionType`, `provider`) but preserve revision, cursor, includeBodies, turn-body, recent-first order, default/max limits, and stale-revision behavior.

The moved `server/fresh-agent/history/claude/*` modules must stay adapter-neutral. Add an architecture assertion or import scan proving these modules do not import `server/fresh-agent/router`, `server/fresh-agent/runtime-manager`, or `server/fresh-agent/adapters/claude`.

- [ ] **Step 7: Remove legacy route mount**

In `server/index.ts`, delete:

```ts
app.use('/api', createAgentTimelineRouter({
  service: createAgentTimelineService({
    agentHistorySource,
  }),
}))
```

and delete imports for `createAgentTimelineRouter` and `createAgentTimelineService`. Remove the old route only after `test/integration/server/fresh-agent-claude-history-route-parity.test.ts` is passing.

Create `test/integration/server/fresh-agent-removes-legacy-routes.test.ts` after the route is removed. It should mount the production app/router wiring and assert `/api/agent-sessions/:sessionId/timeline` and `/api/agent-sessions/:sessionId/turns/:turnId` return 404 while `/api/fresh-agent/threads/:sessionType/:provider/:threadId` still reaches the fresh-agent router.

- [ ] **Step 8: Move and update history tests**

Run:

```bash
mkdir -p test/unit/server/fresh-agent
git mv test/unit/server/agent-timeline-history-source.test.ts test/unit/server/fresh-agent/claude-history-source.test.ts
git mv test/unit/server/agent-timeline-include-bodies.test.ts test/unit/server/fresh-agent/claude-history-include-bodies.test.ts
git mv test/unit/server/agent-timeline-ledger.test.ts test/unit/server/fresh-agent/claude-history-ledger.test.ts
git mv test/unit/server/agent-timeline/service.test.ts test/unit/server/fresh-agent/claude-history-service.test.ts
git rm test/integration/server/agent-timeline-router.test.ts
```

Update imports in every moved test to the new paths and symbol names from Step 4. Convert the old route integration assertions into the new route-parity file before deleting `agent-timeline-router.test.ts`; do not simply drop them. After this step, `rg -n "server/agent-timeline|agent-timeline" test/unit test/integration` must have no hits except the fresh-agent route-parity test description text.

- [ ] **Step 9: Run focused server history tests**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/fresh-agent/claude-history-source.test.ts test/unit/server/fresh-agent/claude-history-include-bodies.test.ts test/unit/server/fresh-agent/claude-history-ledger.test.ts test/unit/server/fresh-agent/claude-history-service.test.ts test/unit/server/fresh-agent/claude-restore-contract.test.ts test/integration/server/fresh-agent-claude-history-route-parity.test.ts test/integration/server/fresh-agent-removes-legacy-routes.test.ts --run
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server test
git commit -m "Move Claude history under fresh-agent"
```

---

### Task 7: Remove Legacy Top-Level `sdk.*` Client WebSocket Contract

**Files:**
- Modify: `shared/ws-protocol.ts:465-970`
- Create/modify: `server/fresh-agent/sdk-events.ts`
- Modify: `server/sdk-bridge-types.ts`
- Modify: `src/App.tsx:60-72`
- Modify: `src/App.tsx:1119-1123`
- Modify: `src/lib/ws-client.ts`
- Modify: `src/lib/fresh-agent-ws.ts:1-186`
- Modify: `src/lib/create-cancellation.ts`
- Modify: `src/store/freshAgentSlice.ts`
- Delete: `src/lib/sdk-message-handler.ts`
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify/delete: tests that import `@/lib/sdk-message-handler`
- Modify: `server/ws-handler.ts`
- Modify: `shared/ws-version.ts`
- Test: `test/unit/client/fresh-agent-ws.test.ts`
- Test: `test/unit/client/ws-client-protocol-reload.test.ts`
- Test: `test/unit/server/ws-fresh-agent-contract.test.ts`
- Test: `test/unit/server/ws-handler-fresh-agent-ownership.test.ts`
- Test: `test/unit/server/ws-handler-fresh-agent-lifecycle-parity.test.ts`
- Delete: `test/unit/server/ws-sdk-session-history-cache.test.ts`

- [ ] **Step 0: Split internal SDK bridge events from the public browser protocol**

Before deleting public top-level `sdk.*` messages from `shared/ws-protocol.ts`, move the internal Claude SDK bridge event union to a server-owned module:

```ts
// server/fresh-agent/sdk-events.ts
export type FreshAgentProviderEvent =
  | { type: 'freshAgent.session.snapshot'; sessionId: string; latestTurnId: string | null; status: SdkSessionStatus; timelineSessionId?: string; revision: number; streamingActive?: boolean; streamingText?: string }
  | { type: 'freshAgent.session.init'; sessionId: string; cliSessionId?: string; model?: string; cwd?: string; tools?: Array<{ name: string }> }
  | { type: 'freshAgent.session.metadata'; sessionId: string; cliSessionId?: string; model?: string; cwd?: string; tools?: Array<{ name: string }> }
  | { type: 'freshAgent.assistant'; sessionId: string; content: ContentBlock[]; model?: string; usage?: Usage }
  | { type: 'freshAgent.stream'; sessionId: string; event: unknown; parentToolUseId?: string | null }
  | { type: 'freshAgent.result'; sessionId: string; result?: string; durationMs?: number; costUsd?: number; usage?: Usage }
  | { type: 'freshAgent.permission.request'; sessionId: string; requestId: string; subtype: string; tool?: { name: string; input?: Record<string, unknown> }; toolUseID?: string; suggestions?: unknown[]; blockedPath?: string; decisionReason?: string }
  | { type: 'freshAgent.permission.cancelled'; sessionId: string; requestId: string }
  | { type: 'freshAgent.question.request'; sessionId: string; requestId: string; questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }> }
  | { type: 'freshAgent.status'; sessionId: string; status: SdkSessionStatus }
  | { type: 'freshAgent.error'; sessionId: string; message: string; code?: string }
  | { type: 'freshAgent.exit'; sessionId: string; exitCode?: number }
  | { type: 'freshAgent.killed'; sessionId: string; success: boolean }
```

`server/sdk-bridge.ts` may continue to emit its internal SDK-shaped events temporarily, but `server/ws-handler.ts` must normalize them to `FreshAgentProviderEvent` before sending to the browser. After this task, no browser-facing type or handler should require top-level `SdkServerMessage`.

Bump `WS_PROTOCOL_VERSION` in `shared/ws-version.ts` in this task. Add a client test proving a stale bundle that receives `PROTOCOL_MISMATCH` does not flush queued `sdk.*`, `freshAgent.*`, or `ui.layout.sync` messages. The client must either call the existing reload path automatically or enter an intentional, non-reconnecting hard-stop state with clear reload UI.

- [ ] **Step 1: Write the fresh-agent transport client test**

Create `test/unit/client/fresh-agent-ws.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { handleFreshAgentMessage } from '@/lib/fresh-agent-ws'
import {
  sessionSnapshotReceived,
  sessionInit,
  setSessionStatus,
} from '@/store/freshAgentSlice'

describe('fresh-agent websocket transport', () => {
  it('handles fresh-agent session events without top-level sdk message handling', () => {
    const dispatch = vi.fn()

    const handled = handleFreshAgentMessage(dispatch as never, {
      type: 'freshAgent.event',
      sessionId: 'sess-1',
      sessionType: 'freshclaude',
      provider: 'claude',
      event: {
        type: 'freshAgent.session.snapshot',
        latestTurnId: 'turn-1',
        status: 'idle',
        revision: 4,
      },
    })

    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledWith(sessionSnapshotReceived({
      sessionId: 'sess-1',
      sessionType: 'freshclaude',
      provider: 'claude',
      latestTurnId: 'turn-1',
      status: 'idle',
      revision: 4,
      timelineSessionId: undefined,
      streamingActive: undefined,
      streamingText: undefined,
    }))
  })

  it('ignores legacy top-level sdk messages', () => {
    const dispatch = vi.fn()
    expect(handleFreshAgentMessage(dispatch as never, {
      type: 'sdk.session.init',
      sessionId: 'sess-1',
    })).toBe(false)
    expect(dispatch).not.toHaveBeenCalledWith(sessionInit(expect.anything()))
    expect(dispatch).not.toHaveBeenCalledWith(setSessionStatus(expect.anything()))
  })
})
```

Also create `test/unit/client/ws-client-protocol-reload.test.ts` for the stale-bundle behavior named above. The test must drive the real `src/lib/ws-client.ts` protocol-mismatch path, enqueue representative `freshAgent.*`, legacy `sdk.*`, and `ui.layout.sync` messages before the mismatch, then assert no queued message is sent after `PROTOCOL_MISMATCH`.

- [ ] **Step 2: Run the client transport test and verify it fails**

Run:

```bash
npm run test:vitest -- test/unit/client/fresh-agent-ws.test.ts --run
```

Expected: FAIL because `freshAgent.session.snapshot` is not handled yet, `freshAgentSlice` still has no-op live-event reducers, and `App` still imports `sdk-message-handler`.

- [ ] **Step 3: Update fresh-agent event names**

In `src/lib/fresh-agent-ws.ts`, change handled inner event names and cover every UI-relevant event formerly handled by `sdk-message-handler`:

```ts
case 'freshAgent.session.snapshot':
case 'freshAgent.session.init':
case 'freshAgent.session.metadata':
case 'freshAgent.assistant':
case 'freshAgent.stream':
case 'freshAgent.result':
case 'freshAgent.permission.request':
case 'freshAgent.permission.cancelled':
case 'freshAgent.question.request':
case 'freshAgent.status':
case 'freshAgent.error':
case 'freshAgent.exit':
case 'freshAgent.killed':
```

Map them to the existing `freshAgentSlice` actions or add missing fresh-agent actions before deleting `sdk-message-handler`. The existing no-op reducers for user/assistant messages, streaming, and turn results must become real state updates or be replaced by real reducers. The tests must prove assistant text, streamed text, result/cost/usage, permission/question prompts, cancellation, exit, killed, duplicate interactive request de-dupe, and lost-session errors still update fresh-agent state.

- [ ] **Step 4: Remove top-level SDK handling from `App`**

In `src/App.tsx`, delete:

```ts
import { handleSdkMessage } from '@/lib/sdk-message-handler'
```

and replace:

```ts
handleFreshAgentMessage(dispatch, msg as Record<string, unknown>, ws)
// Legacy SDK message handling
handleSdkMessage(dispatch, msg as Record<string, unknown>, ws)
```

with:

```ts
handleFreshAgentMessage(dispatch, msg as Record<string, unknown>, ws)
```

- [ ] **Step 4.5: Move create-cancellation imports out of `sdk-message-handler`**

Before deleting `src/lib/sdk-message-handler.ts`, update every remaining `cancelCreate`, `consumeCancelledCreate`, or `_resetCancelledCreates` import to come from `@/lib/create-cancellation` or the equivalent relative path. This includes production imports such as `src/components/panes/PaneContainer.tsx` and fresh-agent tests that still import cancellation helpers through `sdk-message-handler`.

After the import move, run:

```bash
rg -n "sdk-message-handler" src test
```

Expected before Step 8: no production hits and no fresh-agent test hits. Legacy tests that are being ported or deleted in this task may remain only until their replacement tests pass.

- [ ] **Step 5: Translate server provider events before sending to clients**

In `server/fresh-agent/sdk-events.ts`, add:

```ts
export function normalizeFreshAgentProviderEvent(event: unknown): unknown {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return event
  const record = event as Record<string, unknown>
  switch (record.type) {
    case 'sdk.session.snapshot':
      return { ...record, type: 'freshAgent.session.snapshot' }
    case 'sdk.session.init':
      return { ...record, type: 'freshAgent.session.init' }
    case 'sdk.session.metadata':
      return { ...record, type: 'freshAgent.session.metadata' }
    case 'sdk.assistant':
      return { ...record, type: 'freshAgent.assistant' }
    case 'sdk.stream':
      return { ...record, type: 'freshAgent.stream' }
    case 'sdk.result':
      return { ...record, type: 'freshAgent.result' }
    case 'sdk.permission.request':
      return { ...record, type: 'freshAgent.permission.request' }
    case 'sdk.permission.cancelled':
      return { ...record, type: 'freshAgent.permission.cancelled' }
    case 'sdk.question.request':
      return { ...record, type: 'freshAgent.question.request' }
    case 'sdk.status':
      return { ...record, type: 'freshAgent.status' }
    case 'sdk.error':
      return { ...record, type: 'freshAgent.error' }
    case 'sdk.exit':
      return { ...record, type: 'freshAgent.exit' }
    case 'sdk.killed':
      return { ...record, type: 'freshAgent.killed' }
    default:
      return event
  }
}
```

Then import `normalizeFreshAgentProviderEvent` into `server/ws-handler.ts` and in `freshAgentEventMessage`, change:

```ts
event,
```

to:

```ts
event: normalizeFreshAgentProviderEvent(event),
```

Add Codex and OpenCode adapter tests. If their live event contract remains snapshot/status-only, write that down in the tests and assert snapshots/status reach the UI after normalization. Otherwise normalize every emitted live event to `freshAgent.*` names before it leaves `server/ws-handler.ts`.

- [ ] **Step 6: Port lifecycle and ownership guarantees to fresh-agent**

Before deleting the top-level SDK handlers in `server/ws-handler.ts`, port the guarantees currently covered by `test/unit/server/ws-handler-sdk.test.ts`:

- `freshAgent.create` for Claude must not send `freshAgent.created` until coherent restore state exists.
- create/attach must drain the replay gate/watermark before success when durable history is involved.
- delayed metadata must not downgrade a newer snapshot.
- duplicate interactive requests must not produce duplicate permission/question UI.
- `freshAgent.send`, `freshAgent.interrupt`, `freshAgent.compact`, `freshAgent.approval.respond`, `freshAgent.question.respond`, `freshAgent.fork`, `freshAgent.kill`, and setting changes must require the current WebSocket to own or be explicitly authorized for the fresh-agent session.
- image attachments, plugins, model/modelSelection, effort, permission decisions, question answers, interrupts, kills, compact, and fork payloads must have adapter-specific parity tests.

Create `test/unit/server/ws-handler-fresh-agent-lifecycle-parity.test.ts` by porting the relevant old SDK tests, and create `test/unit/server/ws-handler-fresh-agent-ownership.test.ts` for unauthorized mutating commands. These must fail before the server changes and pass before Step 7.

Implement an explicit authorization model, for example `state.freshAgentAuthorizedSessions`, separate from event subscription bookkeeping. `freshAgent.create` and successful `freshAgent.attach` must grant authorization to the current connection. A connection that never created, attached, or was explicitly subscribed with mutation rights must receive an unauthorized error for every mutating command. Multi-client attach/recover flows must prove each attached client can still mutate the session it attached to.

- [ ] **Step 7: Remove legacy top-level `sdk.*` message schemas and handlers**

In `shared/ws-protocol.ts`, remove client message schemas for:

```ts
sdk.create
sdk.attach
sdk.send
sdk.interrupt
sdk.kill
sdk.permission.respond
sdk.question.respond
sdk.set-model
sdk.set-permission-mode
```

Remove server message union variants for:

```ts
sdk.created
sdk.create.failed
sdk.session.snapshot
sdk.session.init
sdk.session.metadata
sdk.assistant
sdk.stream
sdk.result
sdk.permission.request
sdk.question.request
sdk.status
sdk.exit
sdk.error
sdk.killed
```

In `server/ws-handler.ts`, delete the switch cases that handle those top-level client messages and remove all `sdk.*` string literals from the file. Keep SDK bridge internals only in server-owned modules such as `server/sdk-bridge.ts`, `server/sdk-bridge-types.ts`, and `server/fresh-agent/sdk-events.ts`; `ws-handler.ts` should call fresh-agent-owned helpers and send only `freshAgent.*` browser messages.

In `shared/ws-protocol.ts`, remove every browser-facing `sdk.*` variant, not only `sdk.create`, `sdk.send`, and `sdk.attach`. The architecture guard in Task 9 must catch `sdk.kill`, `sdk.permission.respond`, `sdk.question.respond`, `sdk.session.*`, and any other public `sdk.*` reintroduction.

- [ ] **Step 8: Delete legacy client handler**

Run:

```bash
git rm src/lib/sdk-message-handler.ts
git rm test/unit/server/ws-sdk-session-history-cache.test.ts
```

If any legacy client tests still import `src/lib/sdk-message-handler.ts`, port their asserted behavior to `test/unit/client/fresh-agent-ws.test.ts`, `test/unit/client/ws-client-protocol-reload.test.ts`, or the server lifecycle/ownership tests before deleting them. Do not leave a deleted-module import for typecheck to find.

- [ ] **Step 9: Run websocket focused tests and typechecks**

Run:

```bash
npm run typecheck
npm run test:vitest -- test/unit/client/fresh-agent-ws.test.ts test/unit/client/ws-client-protocol-reload.test.ts test/unit/server/ws-fresh-agent-contract.test.ts test/unit/server/ws-handler-fresh-agent-lifecycle-parity.test.ts test/unit/server/ws-handler-fresh-agent-ownership.test.ts test/unit/server/fresh-agent/codex-adapter.test.ts test/unit/server/fresh-agent/opencode-adapter.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --run
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add shared/ws-protocol.ts shared/ws-version.ts server/fresh-agent/sdk-events.ts server/sdk-bridge-types.ts src/App.tsx src/components/panes/PaneContainer.tsx src/lib/ws-client.ts src/lib/fresh-agent-ws.ts src/lib/create-cancellation.ts src/store/freshAgentSlice.ts server/ws-handler.ts test src/lib
git commit -m "Remove legacy sdk websocket surface"
```

---

### Task 8: Update Fresh-Agent Creation, Picker, Sidebar, And Naming Code

**Files:**
- Modify: `src/components/panes/PanePicker.tsx:119-160`
- Modify: `src/components/panes/PaneContainer.tsx:575-665`
- Modify: `src/store/tabsSlice.ts:580-745`
- Modify: `src/lib/session-type-utils.ts:1-135`
- Modify: `src/lib/agent-chat-utils.ts` -> `src/lib/fresh-agent-provider-utils.ts`
- Modify: `src/lib/agent-chat-types.ts` -> `src/lib/fresh-agent-provider-types.ts`
- Modify: `src/lib/tab-fallback-identity.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Modify: `src/components/context-menu/menu-defs.ts`
- Modify: `server/mcp/freshell-tool.ts`
- Test: `test/unit/client/components/panes/PanePicker.test.tsx`
- Test: `test/unit/client/store/tabsSlice.test.ts`
- Test: `test/unit/server/mcp/freshell-tool.test.ts`

- [ ] **Step 1: Write the picker and resume behavior tests**

In `test/unit/client/components/panes/PanePicker.test.tsx`, add:

```tsx
it('labels fresh clients without any agent-chat live option wording', () => {
  renderPanePicker({
    settings: {
      freshAgent: { enabled: true, defaultPlugins: [], providers: {} },
    },
    availableClis: { claude: true, codex: true, opencode: true },
    enabledProviders: ['claude', 'codex', 'opencode'],
  })

  expect(screen.getByRole('button', { name: /Freshclaude/i })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Freshcodex/i })).toBeInTheDocument()
  expect(screen.queryByText(/agent chat/i)).not.toBeInTheDocument()
})
```

In `test/unit/client/store/tabsSlice.test.ts`, add an async thunk test using the existing `createOpenSessionStore` helper:

```ts
it('opens Claude agent sessions as fresh-agent panes', async () => {
  const store = createOpenSessionStore()

  await store.dispatch(openSessionTab({
    provider: 'claude',
    sessionId: '00000000-0000-4000-8000-000000000111',
    sessionType: 'freshclaude',
    cwd: '/repo',
  }))

  const state = store.getState()
  const activeTab = state.tabs.tabs.find((tab) => tab.id === state.tabs.activeTabId)
  const layout = activeTab ? state.panes.layouts[activeTab.id] : undefined
  const content = layout?.type === 'leaf' ? layout.content : undefined
  expect(content).toMatchObject({
    kind: 'fresh-agent',
    sessionType: 'freshclaude',
    provider: 'claude',
    resumeSessionId: '00000000-0000-4000-8000-000000000111',
    initialCwd: '/repo',
  })
})
```

Add non-Claude reopen coverage in the same file:

```ts
it('opens non-Claude fresh-agent sessions with explicit sessionRef instead of Claude fallback inference', async () => {
  const store = createOpenSessionStore()

  await store.dispatch(openSessionTab({
    provider: 'opencode',
    sessionId: 'opencode-thread-1',
    sessionType: 'freshopencode',
    cwd: '/repo',
  }))

  const state = store.getState()
  const activeTab = state.tabs.tabs.find((tab) => tab.id === state.tabs.activeTabId)
  const layout = activeTab ? state.panes.layouts[activeTab.id] : undefined
  const content = layout?.type === 'leaf' ? layout.content : undefined
  expect(content).toMatchObject({
    kind: 'fresh-agent',
    sessionType: 'freshopencode',
    provider: 'opencode',
    sessionRef: { provider: 'opencode', sessionId: 'opencode-thread-1' },
  })
  expect(content).not.toMatchObject({ resumeSessionId: 'opencode-thread-1' })
})
```

- [ ] **Step 2: Run focused tests and verify failures**

Run:

```bash
npm run test:vitest -- test/unit/client/components/panes/PanePicker.test.tsx test/unit/client/store/tabsSlice.test.ts --run
```

Expected: FAIL on stale `agentChat` naming/imports or missing helper renames.

- [ ] **Step 3: Rename provider helper modules**

Run:

```bash
git mv src/lib/agent-chat-utils.ts src/lib/fresh-agent-provider-utils.ts
git mv src/lib/agent-chat-types.ts src/lib/fresh-agent-provider-types.ts
```

Rename exported names:

```ts
AgentChatProviderName -> FreshAgentProviderName
AgentChatProviderConfig -> FreshAgentProviderConfig
AgentChatProviderSettings -> FreshAgentProviderSettings
isAgentChatProviderName -> isFreshAgentProviderName
getAgentChatProviderConfig -> getFreshAgentProviderConfig
getAgentChatProviderLabel -> getFreshAgentProviderLabel
```

- [ ] **Step 4: Update picker naming and settings sources**

In `src/components/panes/PanePicker.tsx`, rename local variables:

```ts
const visibleFreshAgentConfigs = freshClientsEnabled ? getVisibleFreshAgentConfigs(featureFlags) : []
const freshAgentOptions: PickerOption[] = visibleFreshAgentConfigs
```

and update comments to use "fresh-agent" or "fresh clients", not "agent chat".

In `src/components/panes/PaneContainer.tsx`, use only:

```ts
const freshAgentSettings = useAppSelector(
  (s) => s.settings?.settings?.freshAgent
    ?? s.settings?.serverSettings?.freshAgent
)
```

and set:

```ts
const providerSettings = freshAgentSettings?.providers?.[type]
plugins: freshAgentType.runtimeProvider === 'claude' ? freshAgentSettings?.defaultPlugins : undefined,
```

- [ ] **Step 5: Update MCP instructions**

In `server/mcp/freshell-tool.ts`, replace the pane-kind sentence with:

```ts
- Pane kinds: terminal, editor, browser, fresh-agent (Claude/Codex/OpenCode/etc.), picker (transient).
```

In `src/lib/tab-fallback-identity.ts`, remove Claude-only inference for non-Claude fresh-agent panes. Freshcodex and Freshopencode reopen/sidebar/fallback paths must carry `sessionRef` explicitly.

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm run test:vitest -- test/unit/client/components/panes/PanePicker.test.tsx test/unit/client/store/tabsSlice.test.ts test/unit/server/mcp/freshell-tool.test.ts --run
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src server test
git commit -m "Update agent creation to fresh-agent naming"
```

---

### Task 9: Add Runtime Architecture Guard Against Legacy Agent Infrastructure

**Files:**
- Create: `test/unit/architecture/fresh-agent-only-runtime.test.ts`

- [ ] **Step 1: Create the architecture guard**

Create `test/unit/architecture/fresh-agent-only-runtime.test.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

function rgContent(pattern: string, paths: string[]): string[] {
  try {
    return execFileSync('rg', ['-n', pattern, ...paths], {
      encoding: 'utf8',
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split('\n')
      .filter(Boolean)
  } catch (error) {
    const status = (error as { status?: number }).status
    if (status === 1) return []
    throw error
  }
}

function rgFiles(paths: string[]): string[] {
  try {
    return execFileSync('rg', ['--files', ...paths], {
      encoding: 'utf8',
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split('\n')
      .filter(Boolean)
  } catch (error) {
    const status = (error as { status?: number }).status
    if (status === 1) return []
    throw error
  }
}

describe('fresh-agent-only runtime architecture', () => {
  it('has no live agent-chat runtime imports, routes, pane kinds, or Redux state', () => {
    const forbidden = String.raw`agent-chat|agentChat|AgentChat|/api/agent-chat|/api/agent-sessions|createAgentTimelineRouter`
    const contentHits = rgContent(forbidden, ['src', 'server', 'shared'])
      .filter((line) => !line.includes('migrateLegacyFreshAgentContent'))
      .filter((line) => !line.includes('migrateLegacyFreshAgentDurableState'))
      .filter((line) => !line.includes('migrateLegacyAgentChatDurableState'))
      .filter((line) => !line.includes('readLegacyFreshAgentSettingsInput'))
      .filter((line) => !line.includes('candidate.agentChat'))
      .filter((line) => !line.includes('legacy agentChat input'))
    const pathHits = rgFiles(['src', 'server', 'shared'])
      .filter((path) => /agent-chat|agentChat|AgentChat/.test(path))

    expect([...contentHits, ...pathHits]).toEqual([])
  })

  it('keeps sdk-prefixed events server-internal only', () => {
    const allowedSdkInternalPaths = [
      'server/sdk-bridge.ts:',
      'server/sdk-bridge-types.ts:',
      'server/fresh-agent/sdk-events.ts:',
      'server/fresh-agent/adapters/claude/',
      'server/fresh-agent/adapters/codex/',
      'server/fresh-agent/adapters/opencode/',
    ]
    const output = rgContent(String.raw`sdk\.`, ['src', 'server', 'shared'])
      .filter((line) => !allowedSdkInternalPaths.some((path) => line.includes(path)))

    expect(output).toEqual([])
  })
})
```

This is an architecture contract, not a copy test: it prevents the deleted runtime surface from being reintroduced.
The implementation may rename `migrateLegacyAgentChatDurableState` to `migrateLegacyFreshAgentDurableState` instead of allowlisting it. If it stays, the allowlist must be explicit so the old name cannot hide unrelated live runtime references.

- [ ] **Step 2: Run the guard and verify it fails before cleanup is complete**

Run:

```bash
npm run test:vitest -- test/unit/architecture/fresh-agent-only-runtime.test.ts --run
```

Expected before Tasks 2-8 are complete: FAIL with remaining legacy references. Expected after Tasks 2-8: PASS.

- [ ] **Step 3: Remove remaining production references reported by the guard**

For every guard hit in `src`, `server`, or `shared`, either:

- Rename it to fresh-agent ownership if the code is still needed.
- Delete it if it supports only the removed live agent-chat UI, routes, Redux state, or top-level `sdk.*` WebSocket surface.
- Keep it only if it is one of the three explicit migration-boundary names allowed in the filter.

- [ ] **Step 4: Run the guard**

Run:

```bash
npm run test:vitest -- test/unit/architecture/fresh-agent-only-runtime.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/unit/architecture/fresh-agent-only-runtime.test.ts src server shared
git commit -m "Guard fresh-agent-only runtime architecture"
```

---

### Task 10: Build Thorough Browser Smoke Coverage

**Files:**
- Create: `test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts`
- Modify: `test/e2e-browser/helpers/test-server.ts` only if route mocks need fresh-agent capabilities support
- Modify: `test/e2e-browser/helpers/test-harness.ts` if a remote layout-sync helper is needed
- Modify: `src/lib/test-harness.ts`
- Modify: `src/components/fresh-agent/FreshAgentView.tsx`

- [ ] **Step 1: Add harness-backed browser smoke tests**

Create `test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts`. Use the existing helpers from `test/e2e-browser/specs/fresh-agent.spec.ts`, `fresh-agent-mobile.spec.ts`, and `pane-activity-indicator.spec.ts`; do not depend on real Claude/Codex/OpenCode CLIs or external APIs.

The spec must include these tests:

1. **Fresh pane creation with no legacy UI or routes**
   - Seed available fresh clients through the e2e-browser harness.
   - Mock `/api/fresh-agent/model-capabilities/**` and `/api/fresh-agent/threads/**`.
   - Open Freshclaude, Freshcodex, and Freshopencode panes.
   - Assert `[data-context="fresh-agent"]` is visible for each pane and `[data-context="agent-chat"]` has count `0`.
   - Capture requests and assert none include `/api/agent-chat` or `/api/agent-sessions`.

2. **Real persisted-layout migration**
   - Seed `window.localStorage` with the real key `freshell.layout.v3`.
   - Use the real persisted shape: `{ version: 3, tabs: [...], panes: { layouts: { [tabId]: node }, activePane: { [tabId]: paneId } } }`.
   - Put a legacy `kind: "agent-chat"` leaf in a nested split tree, including one old `provider: "claude"` record with a canonical Claude `resumeSessionId`.
   - Install global fresh-agent network suppression with `page.addInitScript` before navigation, not a per-pane flag set after render.
   - Load the app and assert every migrated pane renders as fresh-agent, localStorage no longer contains `kind: "agent-chat"`, and no blank screen appears.
   - Assert no `freshAgent.create` or `freshAgent.attach` websocket message is sent before the suppression hook is active.

3. **Remote/server layout normalization**
   - Use the harness to send or simulate a `ui.layout.sync` payload containing an `agent-chat` leaf.
   - Assert the server-stored/broadcast layout normalizes to fresh-agent before the page renders it.
   - If the current harness only exposes low-level websocket send primitives, add a helper with a clear name such as `sendLegacyLayoutSyncForMigrationSmoke`.

4. **Settings and route removal**
   - `PATCH /api/settings` with `freshAgent` succeeds and returns no `agentChat`.
   - `PATCH /api/settings` with top-level `agentChat` returns `400`.
   - `/api/agent-chat/capabilities/*` and `/api/agent-sessions/*` return `404`.
   - `/api/fresh-agent/model-capabilities/*` and `/api/fresh-agent/threads/*` remain reachable.
   - Opening Settings shows "Fresh agent" and no "agent chat" copy.

If a lower-level Redux harness dispatch is needed, keep it in this smoke file with one short comment explaining why the browser path cannot create that state directly.

Add a global test harness switch in `src/lib/test-harness.ts`, for example `suppressAllFreshAgentNetworkEffects`, and check it in `FreshAgentView` before any create/attach effect can send over the websocket. Per-pane suppression remains useful for existing tests, but the migration smoke must use the global pre-render suppression path.

- [ ] **Step 2: Run the new browser smoke test and verify it fails before implementation is complete**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts
```

Expected before Tasks 2-9 are complete: FAIL on legacy routes, legacy settings field, or legacy UI branch. Expected after Tasks 2-9: PASS.

- [ ] **Step 3: Run existing fresh-agent browser specs**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent.spec.ts test/e2e-browser/specs/fresh-agent-mobile.spec.ts test/e2e-browser/specs/freshopencode-db-history.spec.ts test/e2e-browser/specs/pane-activity-indicator.spec.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts test/e2e-browser/helpers/test-server.ts test/e2e-browser/helpers/test-harness.ts src/lib/test-harness.ts src/components/fresh-agent/FreshAgentView.tsx
git commit -m "Add fresh-agent centralization smoke coverage"
```

---

### Task 11: Full Cleanup Verification And Documentation Sweep

**Files:**
- Modify: `docs/index.html` if the mock still references old agent-chat naming or routes
- Modify: `README.md` only if it documents `/api/agent-chat/*`, `/api/agent-sessions/*`, or agent-chat pane behavior
- Modify or delete stale tests reported by the commands below

- [ ] **Step 1: Run production-source legacy scans**

Run:

```bash
rg -n "agent-chat|agentChat|AgentChat|/api/agent-chat|/api/agent-sessions|createAgentTimelineRouter" src server shared docs/index.html README.md
rg --files src server shared | rg "agent-chat|agentChat|AgentChat"
rg -n "sdk\\." src shared
```

Expected: no production-source content hits except explicit one-time migration helper names, and no production file-path hits:

```text
migrateLegacyFreshAgentContent
migrateLegacyFreshAgentDurableState
migrateLegacyAgentChatDurableState
migrateLegacyFreshAgentSettingsInput
readLegacyFreshAgentSettingsInput
candidate.agentChat
legacy agentChat input
```

- [ ] **Step 2: Run focused fresh-agent and settings tests**

Run:

```bash
npm run test:vitest -- test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx test/unit/client/fresh-agent-pane-migration.test.ts test/unit/client/fresh-agent-only-ui-state.test.ts test/unit/client/fresh-agent-legacy-behavior-coverage.test.ts test/unit/client/store/storage-migration.fresh-agent.test.ts test/unit/client/store/persisted-state.fresh-agent.test.ts test/unit/client/tab-registry-fresh-agent-migration.test.ts test/unit/shared/settings.test.ts test/unit/architecture/fresh-agent-only-runtime.test.ts --run
```

Expected: PASS.

- [ ] **Step 3: Run focused server tests**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/fresh-agent/claude-history-source.test.ts test/unit/server/fresh-agent/claude-history-include-bodies.test.ts test/unit/server/fresh-agent/claude-restore-contract.test.ts test/unit/server/fresh-agent/claude-adapter.test.ts test/unit/server/fresh-agent/codex-adapter.test.ts test/unit/server/fresh-agent/opencode-adapter.test.ts test/unit/server/ws-handler-fresh-agent-lifecycle-parity.test.ts test/unit/server/ws-handler-fresh-agent-ownership.test.ts test/unit/server/agent-api/layout-store.fresh-agent.test.ts test/unit/server/tabs-registry/fresh-agent-migration.test.ts test/integration/server/fresh-agent-model-capabilities-router.test.ts test/integration/server/fresh-agent-claude-history-route-parity.test.ts test/integration/server/fresh-agent-removes-legacy-routes.test.ts test/integration/server/settings-api.test.ts --run
```

Expected: PASS.

- [ ] **Step 4: Run typecheck, lint, and coordinated test suite**

Run:

```bash
npm run typecheck
npm run lint
FRESHELL_TEST_SUMMARY="fresh-agent centralization cleanup" npm run test
```

Expected: PASS.

- [ ] **Step 5: Run browser smoke**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts test/e2e-browser/specs/fresh-agent.spec.ts test/e2e-browser/specs/fresh-agent-mobile.spec.ts test/e2e-browser/specs/freshopencode-db-history.spec.ts test/e2e-browser/specs/pane-activity-indicator.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 7: Manual smoke on a worktree test server**

Start a disposable server from this worktree only:

```bash
setsid bash -lc 'PORT=3388 VITE_PORT=5188 npm run dev' > /tmp/freshell-agent-cleanup-3388.log 2>&1 & echo $! > /tmp/freshell-agent-cleanup-3388.pid
```

Open it in Windows Chrome from WSL:

```bash
cmd.exe /c start "" chrome --new-tab http://localhost:5188
```

Exercise these flows manually:

```text
1. Open Freshclaude from the picker. Confirm the pane body has fresh-agent styling and no "agent-chat" UI text.
2. Open Freshcodex in a split. Confirm settings show the per-pane style dropdown and saving a style does not affect Freshclaude.
3. Open Freshopencode in a split. Confirm the pane initializes and no request to /api/agent-chat or /api/agent-sessions appears in DevTools Network.
4. Send a short user turn in one available fresh-agent pane. Confirm activity status appears, the transcript appends in styled fresh-agent UI, and the tab attention state changes on completion.
5. Hard refresh. Confirm all panes restore as fresh-agent panes and no white screen appears.
6. Open Settings. Confirm the section is named "Fresh agent" and the response body from /api/settings has freshAgent but no agentChat.
```

Before stopping, verify the recorded PID belongs to this worktree and is its own process group leader:

```bash
pid="$(cat /tmp/freshell-agent-cleanup-3388.pid)"
ps -fp "$pid"
test "$(readlink -f "/proc/$pid/cwd")" = "/home/dan/code/freshell/.worktrees/agent-infrastructure-cleanup"
test "$(ps -o pgid= -p "$pid" | tr -d ' ')" = "$pid"
```

Stop only that worktree process group:

```bash
pid="$(cat /tmp/freshell-agent-cleanup-3388.pid)"
kill -- "-$pid" && rm -f /tmp/freshell-agent-cleanup-3388.pid
```

- [ ] **Step 8: Commit final sweep**

```bash
git add docs/index.html README.md src server shared test
git commit -m "Complete fresh-agent centralization cleanup"
```

---

## Self-Review

**Spec coverage:** The user asked to do the migration at once, with no old clients preserved, and to include a comprehensive migration plus thorough smoke test. Tasks 1-9 remove old live code paths in one branch after proving migration ingress coverage, tab-registry normalization, settings precedence, history route parity, WebSocket event/lifecycle/ownership parity, model-capability routing, and legacy behavior test conversion. Task 10 adds harness-backed browser smoke for freshclaude, freshcodex, freshopencode, settings, real persisted-layout migration, remote layout sync normalization, route removal, pre-render side-effect suppression, and absence of legacy UI. Task 11 verifies scans, focused tests, full suite, build, browser e2e, and process-group-safe manual smoke.

**Load-bearing review summary:** The first draft had false assumptions around settings aliasing, route ownership, WebSocket parity, pane ingress coverage, storage recovery/volume, architecture guard coverage, test conversion completeness, capability naming, and browser smoke realism. This revision fixes those by adding explicit migration contracts, tab-registry normalization, config/browser-preference migration, conflict precedence rules, server layout normalization, recoverable storage migration with failure-injection and large-layout tests, fresh-agent route parity tests, full event mapping, per-connection ownership checks, a path-aware architecture guard, a file-complete behavior coverage matrix before deleting old tests, a separate model-capabilities route, and process-safe browser/manual smoke requirements.

**Placeholder scan:** The plan contains no forbidden placeholder language and no open-ended edge-case instructions. Each implementation task lists exact files, test code or exact commands, and the expected result.

**Type consistency:** Canonical names are `freshAgent` for settings, `fresh-agent` for pane kind and route namespace, `FreshAgentModelCapabilityRegistry` for model/settings capabilities, runtime `FreshAgentCapabilitiesSchema` for command booleans, and `ClaudeFreshAgentHistoryService` for moved Claude history under `server/fresh-agent/history/claude`. The only allowed legacy identifiers after implementation are narrow migration-boundary names such as `migrateLegacyFreshAgentContent`, `migrateLegacyFreshAgentDurableState`, `migrateLegacyAgentChatDurableState` if not renamed, `migrateLegacyFreshAgentSettingsInput`, `readLegacyFreshAgentSettingsInput`, exact stored-key reads like `candidate.agentChat`, and explanatory test strings for legacy input conversion.
