# Settings Show Switches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Workspace sidebar visibility settings consistently positive so every switch label says what turning it on will show.

**Architecture:** Rename the two negative local sidebar settings to positive internal keys, preserve legacy browser preferences through explicit migration, and update all runtime consumers to read the new positive schema. Keep the existing server-backed first-chat exclusion fields, but rename the visible textarea label to the user's requested copy.

**Tech Stack:** React 18 settings components, Redux Toolkit settings state, shared TypeScript settings contracts with Zod, Vitest, Testing Library, Playwright.

## Global Constraints

- User-facing Workspace sidebar switches must use positive "Show ..." labels.
- A switch in the on/right/true state must mean the relevant item is shown.
- Internal local settings schema must be cleaned up too: replace `ignoreCodexSubagents` with `showCodexSubagents`, and replace `hideEmptySessions` with `showEmptySessions`.
- Existing stored browser preferences must preserve behavior: `ignoreCodexSubagents: true` migrates to `showCodexSubagents: false`; `ignoreCodexSubagents: false` migrates to `showCodexSubagents: true`; `hideEmptySessions: true` migrates to `showEmptySessions: false`; `hideEmptySessions: false` migrates to `showEmptySessions: true`.
- If a stored object contains both a new positive key and an old negative key, the new positive key wins.
- The first-chat exclusion textarea label must be exactly `Exclude chats that start with this`.
- Do not move first-chat exclusion storage from server settings to local settings.
- Do not create or open a PR without explicit user approval.
- Work in `.worktrees/settings-show-switches-plan` or a fresh execution worktree created from `origin/main`.
- Use coordinated broad test commands; use `npm run test:vitest -- ...` for focused Vitest paths.

---

## File Structure

- Modify: `shared/settings.ts`
  - Owns the settings contract, defaults, local/server setting separation, legacy migration, and composition.
- Modify: `src/components/settings/WorkspaceSettings.tsx`
  - Owns the visible Workspace settings labels and local/server patch dispatches.
- Modify: `src/store/selectors/sidebarSelectors.ts`
  - Owns visibility filtering semantics for the sidebar.
- Modify: `src/store/sessionsThunks.ts`
  - Owns API visibility options for sidebar session snapshots.
- Modify: `src/store/browserPreferencesPersistence.ts`
  - Owns persisted browser preference patches and must write only positive local keys.
- Modify: `test/unit/shared/settings.test.ts`
  - Proves settings schema, defaults, stripping, and legacy migration.
- Modify: `test/unit/client/components/SettingsView.behavior.test.tsx`
  - Proves the Workspace UI labels and switches write positive local state.
- Modify: `test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts`
  - Proves positive visibility filtering semantics.
- Modify: `test/unit/client/store/selectors/sidebarSelectors.test.ts`
  - Updates selector state fixtures to the positive schema.
- Modify: `test/unit/client/lib/browser-preferences.test.ts`
  - Proves browser preference seeds and persisted local patches use the new keys.
- Modify: `test/unit/client/store/*`, `test/unit/client/components/*`, and `test/e2e/*.tsx`
  - Mechanical fixture updates where tests construct `settings.sidebar`.
- Modify: `test/integration/server/settings-api.test.ts`
  - Keeps server API rejecting local-only fields, including both new and legacy local-only sidebar fields.
- Modify: `test/e2e-browser/specs/settings.spec.ts`
  - Adds a high-level browser check that Workspace settings expose only positive sidebar visibility switch labels and that toggles persist positive state.
- Modify: `docs/index.html`
  - Updates the nonfunctional mock settings page so visible labels and default switch states match the product UI.

### Inventory From Current `main`

- Already positive and keep as-is: `Show project badges` (`sidebar.showProjectBadges`, default `true`).
- Already positive and keep as-is: `Show subagent sessions` (`sidebar.showSubagents`, default `false`).
- Change: `Ignore Codex subagent sessions` (`sidebar.ignoreCodexSubagents`, default `true`) becomes `Show Codex subagent sessions` (`sidebar.showCodexSubagents`, default `false`).
- Already positive and keep as-is: `Show non-interactive sessions` (`sidebar.showNoninteractiveSessions`, default `false`).
- Change: `Hide empty sessions` (`sidebar.hideEmptySessions`, default `true`) becomes `Show empty sessions` (`sidebar.showEmptySessions`, default `false`).
- Change copy only: `Hide sessions by first chat` becomes `Exclude chats that start with this`.
- Keep as-is unless product later asks for behavior change: `First chat must start with match` (`sidebar.excludeFirstChatMustStart`, default `false`), because it is server-backed and not a hide/show switch.

## Task 1: Shared Settings Schema And Legacy Migration

**Files:**
- Modify: `shared/settings.ts`
- Test: `test/unit/shared/settings.test.ts`

**Interfaces:**
- Consumes: existing `LocalSettings`, `LocalSettingsPatch`, `resolveLocalSettings`, `mergeLocalSettings`, `extractLegacyLocalSettingsSeed`, `stripLocalSettings`, `buildServerSettingsPatchSchema`.
- Produces: `LocalSettings['sidebar'].showCodexSubagents: boolean`, `LocalSettings['sidebar'].showEmptySessions: boolean`, legacy migration from old negative keys, no runtime `LocalSettings['sidebar'].ignoreCodexSubagents` or `LocalSettings['sidebar'].hideEmptySessions`.

- [ ] **Step 1: Write failing shared settings tests**

Add and update tests in `test/unit/shared/settings.test.ts`:

```ts
it('uses positive local sidebar visibility defaults', () => {
  const resolved = resolveLocalSettings(undefined)

  expect(resolved.sidebar.showSubagents).toBe(false)
  expect(resolved.sidebar.showCodexSubagents).toBe(false)
  expect(resolved.sidebar.showNoninteractiveSessions).toBe(false)
  expect(resolved.sidebar.showEmptySessions).toBe(false)
  expect('ignoreCodexSubagents' in resolved.sidebar).toBe(false)
  expect('hideEmptySessions' in resolved.sidebar).toBe(false)
})

it('accepts positive local sidebar visibility patches', () => {
  const resolved = resolveLocalSettings({
    sidebar: {
      showSubagents: true,
      showCodexSubagents: true,
      showNoninteractiveSessions: true,
      showEmptySessions: true,
    },
  })

  expect(resolved.sidebar.showSubagents).toBe(true)
  expect(resolved.sidebar.showCodexSubagents).toBe(true)
  expect(resolved.sidebar.showNoninteractiveSessions).toBe(true)
  expect(resolved.sidebar.showEmptySessions).toBe(true)
})

it('migrates legacy negative sidebar visibility keys to positive local keys', () => {
  expect(resolveLocalSettings({
    sidebar: {
      ignoreCodexSubagents: false,
      hideEmptySessions: false,
    } as any,
  }).sidebar).toMatchObject({
    showCodexSubagents: true,
    showEmptySessions: true,
  })

  expect(resolveLocalSettings({
    sidebar: {
      ignoreCodexSubagents: true,
      hideEmptySessions: true,
    } as any,
  }).sidebar).toMatchObject({
    showCodexSubagents: false,
    showEmptySessions: false,
  })
})

it('lets positive sidebar visibility keys win over legacy negative aliases', () => {
  const resolved = resolveLocalSettings({
    sidebar: {
      showCodexSubagents: true,
      ignoreCodexSubagents: true,
      showEmptySessions: true,
      hideEmptySessions: true,
    } as any,
  })

  expect(resolved.sidebar.showCodexSubagents).toBe(true)
  expect(resolved.sidebar.showEmptySessions).toBe(true)
})

it('extracts positive sidebar visibility local seed from legacy settings', () => {
  expect(extractLegacyLocalSettingsSeed({
    sidebar: {
      showSubagents: true,
      ignoreCodexSubagents: false,
      hideEmptySessions: false,
      excludeFirstChatSubstrings: ['server-backed'],
    },
  })).toEqual({
    sidebar: {
      showSubagents: true,
      showCodexSubagents: true,
      showEmptySessions: true,
    },
  })
})

it('strips both current and legacy local sidebar visibility keys while preserving server-backed settings', () => {
  const rawMixedSettings = {
    sidebar: {
      showSubagents: true,
      showCodexSubagents: true,
      showNoninteractiveSessions: true,
      showEmptySessions: true,
      ignoreCodexSubagents: false,
      hideEmptySessions: false,
      excludeFirstChatSubstrings: ['__AUTO__'],
      excludeFirstChatMustStart: true,
    },
  }

  expect(stripLocalSettings(rawMixedSettings)).toEqual({
    sidebar: {
      excludeFirstChatSubstrings: ['__AUTO__'],
      excludeFirstChatMustStart: true,
    },
  })
})
```

Update existing expectations in this same file:

```ts
expect(schema.safeParse({ sidebar: { showSubagents: true } }).success).toBe(false)
expect(schema.safeParse({ sidebar: { showCodexSubagents: true } }).success).toBe(false)
expect(schema.safeParse({ sidebar: { showEmptySessions: true } }).success).toBe(false)
expect(schema.safeParse({ sidebar: { ignoreCodexSubagents: true } }).success).toBe(false)
expect(schema.safeParse({ sidebar: { hideEmptySessions: true } }).success).toBe(false)
```

Update the existing `extracts only moved local settings into the legacy seed` assertion so the expected sidebar uses the positive key:

```ts
      sidebar: {
        sortMode: 'project',
        showSubagents: true,
        showCodexSubagents: true,
      },
```

Update the existing deprecated alias test to the new name and positive expected value:

```ts
  it('translates deprecated ignoreCodexSubagentSessions into showCodexSubagents when extracting a legacy seed', () => {
    expect(extractLegacyLocalSettingsSeed({
      sidebar: {
        ignoreCodexSubagentSessions: true,
      },
    } as Record<string, unknown>)).toEqual({
      sidebar: {
        showCodexSubagents: false,
      },
    })
  })
```

- [ ] **Step 2: Run shared settings tests to verify failure**

Run:

```bash
npm run test:vitest -- run test/unit/shared/settings.test.ts
```

Expected: FAIL because `showCodexSubagents` and `showEmptySessions` do not exist yet and old negative fields still appear.

- [ ] **Step 3: Rename local schema keys and defaults**

In `shared/settings.ts`, change `SIDEBAR_LOCAL_KEYS` to positive keys plus explicit legacy-only keys used by stripping:

```ts
const SIDEBAR_LOCAL_KEYS = [
  'sortMode',
  'worktreeGrouping',
  'showProjectBadges',
  'showSubagents',
  'showCodexSubagents',
  'showNoninteractiveSessions',
  'showEmptySessions',
  'width',
  'collapsed',
] as const

const LEGACY_SIDEBAR_LOCAL_KEYS = [
  'ignoreCodexSubagents',
  'ignoreCodexSubagentSessions',
  'hideEmptySessions',
] as const
```

Update `LocalSettings['sidebar']`:

```ts
  sidebar: {
    sortMode: SidebarSortMode
    worktreeGrouping: WorktreeGrouping
    showProjectBadges: boolean
    showSubagents: boolean
    showCodexSubagents: boolean
    showNoninteractiveSessions: boolean
    showEmptySessions: boolean
    width: number
    collapsed: boolean
  }
```

Update `defaultLocalSettings.sidebar`:

```ts
  sidebar: {
    sortMode: 'activity',
    worktreeGrouping: 'repo',
    showProjectBadges: true,
    showSubagents: false,
    showCodexSubagents: false,
    showNoninteractiveSessions: false,
    showEmptySessions: false,
    width: 288,
    collapsed: false,
  },
```

- [ ] **Step 4: Add one sidebar local settings sanitizer and reuse it**

Add this helper in `shared/settings.ts` near `normalizeLocalFreshAgent`:

```ts
function sanitizeSidebarLocalSettingsPatchInput(
  rawSidebar: Record<string, unknown>,
): LocalSettingsPatch['sidebar'] | undefined {
  const sidebar: LocalSettingsPatch['sidebar'] = {}

  if (hasOwn(rawSidebar, 'sortMode')) {
    sidebar.sortMode = normalizeLocalSortMode(rawSidebar.sortMode)
  }
  if (hasOwn(rawSidebar, 'worktreeGrouping')) {
    sidebar.worktreeGrouping = normalizeWorktreeGrouping(rawSidebar.worktreeGrouping)
  }
  if (typeof rawSidebar.showProjectBadges === 'boolean') {
    sidebar.showProjectBadges = rawSidebar.showProjectBadges
  }
  if (typeof rawSidebar.showSubagents === 'boolean') {
    sidebar.showSubagents = rawSidebar.showSubagents
  }
  if (typeof rawSidebar.showCodexSubagents === 'boolean') {
    sidebar.showCodexSubagents = rawSidebar.showCodexSubagents
  } else if (typeof rawSidebar.ignoreCodexSubagents === 'boolean') {
    sidebar.showCodexSubagents = !rawSidebar.ignoreCodexSubagents
  } else if (typeof rawSidebar.ignoreCodexSubagentSessions === 'boolean') {
    sidebar.showCodexSubagents = !rawSidebar.ignoreCodexSubagentSessions
  }
  if (typeof rawSidebar.showNoninteractiveSessions === 'boolean') {
    sidebar.showNoninteractiveSessions = rawSidebar.showNoninteractiveSessions
  }
  if (typeof rawSidebar.showEmptySessions === 'boolean') {
    sidebar.showEmptySessions = rawSidebar.showEmptySessions
  } else if (typeof rawSidebar.hideEmptySessions === 'boolean') {
    sidebar.showEmptySessions = !rawSidebar.hideEmptySessions
  }
  const normalizedSidebarWidth = normalizeRoundedClampedNumber(
    rawSidebar.width,
    SIDEBAR_WIDTH_MIN,
    SIDEBAR_WIDTH_MAX,
  )
  if (normalizedSidebarWidth !== undefined) {
    sidebar.width = normalizedSidebarWidth
  }
  if (typeof rawSidebar.collapsed === 'boolean') {
    sidebar.collapsed = rawSidebar.collapsed
  }

  return Object.keys(sidebar).length > 0 ? sidebar : undefined
}
```

Replace the sidebar block in `normalizeExtractedLocalSeed` with:

```ts
  if (isRecord(patch.sidebar)) {
    const sidebar = sanitizeSidebarLocalSettingsPatchInput(patch.sidebar)
    if (sidebar) {
      normalized.sidebar = sidebar
    }
  }
```

Update `resolveLocalSettings` so it sanitizes the sidebar patch before merging:

```ts
export function resolveLocalSettings(patch?: LocalSettingsPatch): LocalSettings {
  const migratedFreshAgentPatch = patch
    ? migrateLegacyFreshAgentSettingsInput(patch as Record<string, unknown>).freshAgent as FreshAgentSettingsPatchInput | undefined
    : undefined
  const freshAgentPatch = sanitizeFreshAgentLocalSettingsPatchInput(
    isRecord(migratedFreshAgentPatch) ? migratedFreshAgentPatch : {},
  )
  const sidebarPatch = sanitizeSidebarLocalSettingsPatchInput(
    isRecord(patch?.sidebar) ? patch.sidebar : {},
  )

  return {
    ...defaultLocalSettings,
    ...(hasOwn(patch, 'theme') ? { theme: patch?.theme ?? defaultLocalSettings.theme } : {}),
    ...(hasOwn(patch, 'uiScale') ? { uiScale: patch?.uiScale ?? defaultLocalSettings.uiScale } : {}),
    terminal: mergeDefined(defaultLocalSettings.terminal, patch?.terminal),
    panes: mergeDefined(defaultLocalSettings.panes, patch?.panes),
    sidebar: {
      ...mergeDefined(defaultLocalSettings.sidebar, sidebarPatch),
      sortMode: normalizeLocalSortMode(sidebarPatch?.sortMode),
      worktreeGrouping: normalizeWorktreeGrouping(sidebarPatch?.worktreeGrouping),
    },
    freshAgent: normalizeLocalFreshAgent(mergeDefined(defaultLocalSettings.freshAgent, freshAgentPatch)),
    notifications: mergeDefined(defaultLocalSettings.notifications, patch?.notifications),
  }
}
```

Update `mergeLocalSettings` sidebar handling:

```ts
  const baseSidebar = sanitizeSidebarLocalSettingsPatchInput(
    isRecord(base?.sidebar) ? base.sidebar : {},
  ) || {}
  const patchSidebar = sanitizeSidebarLocalSettingsPatchInput(
    isRecord(patch.sidebar) ? patch.sidebar : {},
  ) || {}
  const sidebar = mergeDefined(baseSidebar as Record<string, unknown>, patchSidebar as Record<string, unknown>)
  if (Object.keys(sidebar).length > 0) {
    next.sidebar = sidebar as LocalSettingsPatch['sidebar']
  }
```

- [ ] **Step 5: Update legacy seed extraction and server stripping**

Replace the existing `extractLegacyLocalSettingsSeed` sidebar block with:

```ts
  if (isRecord(raw.sidebar)) {
    const sidebarPatch = sanitizeSidebarLocalSettingsPatchInput(raw.sidebar)
    if (sidebarPatch) {
      maybeAssignNested(patch, 'sidebar', sidebarPatch)
    }
  }
```

Update the `stripLocalSettings` sidebar block:

```ts
  if (isRecord(raw.sidebar)) {
    const strippedSidebar = omitKeys(raw.sidebar, [
      ...SIDEBAR_LOCAL_KEYS,
      ...LEGACY_SIDEBAR_LOCAL_KEYS,
    ])
    if (Object.keys(strippedSidebar).length > 0) {
      next.sidebar = strippedSidebar
    } else {
      delete next.sidebar
    }
  }
```

- [ ] **Step 6: Run shared settings tests to verify pass**

Run:

```bash
npm run test:vitest -- run test/unit/shared/settings.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 1**

```bash
git add shared/settings.ts test/unit/shared/settings.test.ts
git commit -m "refactor: use positive sidebar visibility settings"
```

## Task 2: Workspace UI Copy And Local Patch Dispatch

**Files:**
- Modify: `src/components/settings/WorkspaceSettings.tsx`
- Test: `test/unit/client/components/SettingsView.behavior.test.tsx`

**Interfaces:**
- Consumes: `settings.sidebar.showCodexSubagents`, `settings.sidebar.showEmptySessions`, existing `applyLocalSetting`, existing `scheduleServerTextSettingSave`.
- Produces: visible labels `Show Codex subagent sessions`, `Show empty sessions`, `Exclude chats that start with this`; local patches with positive keys only.

- [ ] **Step 1: Write failing Workspace UI tests**

In `test/unit/client/components/SettingsView.behavior.test.tsx`, add tests inside `describe('additional settings interactions', ...)`:

```ts
it('uses positive labels for Workspace sidebar visibility switches', () => {
  const store = createSettingsViewStore()
  renderSettingsView(store)
  switchSettingsTab('Workspace')

  expect(screen.getByText('Show project badges')).toBeInTheDocument()
  expect(screen.getByText('Show subagent sessions')).toBeInTheDocument()
  expect(screen.getByText('Show Codex subagent sessions')).toBeInTheDocument()
  expect(screen.getByText('Show non-interactive sessions')).toBeInTheDocument()
  expect(screen.getByText('Show empty sessions')).toBeInTheDocument()
  expect(screen.queryByText('Ignore Codex subagent sessions')).not.toBeInTheDocument()
  expect(screen.queryByText('Hide empty sessions')).not.toBeInTheDocument()
})

it('toggles positive Codex subagent and empty-session visibility locally', async () => {
  const store = createSettingsViewStore({
    settings: {
      sidebar: {
        showCodexSubagents: false,
        showEmptySessions: false,
      },
    },
  })
  renderSettingsView(store)
  switchSettingsTab('Workspace')

  fireEvent.click(screen.getByRole('switch', { name: 'Show Codex subagent sessions' }))
  fireEvent.click(screen.getByRole('switch', { name: 'Show empty sessions' }))

  expect(store.getState().settings.settings.sidebar.showCodexSubagents).toBe(true)
  expect(store.getState().settings.settings.sidebar.showEmptySessions).toBe(true)
  expect('ignoreCodexSubagents' in store.getState().settings.settings.sidebar).toBe(false)
  expect('hideEmptySessions' in store.getState().settings.settings.sidebar).toBe(false)

  await act(async () => {
    vi.advanceTimersByTime(500)
  })

  expect(api.patch).not.toHaveBeenCalled()
})

it('uses the requested first-chat exclusion label', () => {
  const store = createSettingsViewStore()
  renderSettingsView(store)
  switchSettingsTab('Workspace')

  expect(screen.getByText('Exclude chats that start with this')).toBeInTheDocument()
  expect(screen.queryByText('Hide sessions by first chat')).not.toBeInTheDocument()
})
```

- [ ] **Step 2: Run component tests to verify failure**

Run:

```bash
npm run test:vitest -- run test/unit/client/components/SettingsView.behavior.test.tsx
```

Expected: FAIL because the UI still uses old labels and dispatches old keys.

- [ ] **Step 3: Update Workspace settings UI**

In `src/components/settings/WorkspaceSettings.tsx`, replace the Codex subagent row with:

```tsx
        <SettingsRow label="Show Codex subagent sessions">
          <Toggle
            checked={settings.sidebar?.showCodexSubagents ?? false}
            onChange={(checked) => {
              applyLocalSetting({ sidebar: { showCodexSubagents: checked } })
            }}
            aria-label="Show Codex subagent sessions"
          />
        </SettingsRow>
```

Replace the empty sessions row with:

```tsx
        <SettingsRow
          label="Show empty sessions"
          description="Show sessions that have no messages yet (e.g. newly started Claude Code sessions)."
        >
          <Toggle
            checked={settings.sidebar?.showEmptySessions ?? false}
            onChange={(checked) => {
              applyLocalSetting({ sidebar: { showEmptySessions: checked } })
            }}
            aria-label="Show empty sessions"
          />
        </SettingsRow>
```

Replace the first-chat textarea row opening with:

```tsx
        <SettingsRow
          label="Exclude chats that start with this"
          description="One entry per line. Matching sessions are hidden from the sidebar."
        >
```

- [ ] **Step 4: Run component tests to verify pass**

Run:

```bash
npm run test:vitest -- run test/unit/client/components/SettingsView.behavior.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/components/settings/WorkspaceSettings.tsx test/unit/client/components/SettingsView.behavior.test.tsx
git commit -m "fix: make workspace visibility switches positive"
```

## Task 3: Runtime Consumers And Browser Preference Persistence

**Files:**
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Modify: `src/store/sessionsThunks.ts`
- Modify: `src/store/browserPreferencesPersistence.ts`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.test.ts`
- Modify: `test/unit/client/lib/browser-preferences.test.ts`
- Modify: related fixtures found with `rg -n "ignoreCodexSubagents|ignoreCodexSubagentSessions|hideEmptySessions" src test`

**Interfaces:**
- Consumes: positive local settings from Task 1.
- Produces: unchanged sidebar visibility behavior, but expressed as `showCodexSubagents` and `showEmptySessions`.

- [ ] **Step 1: Write failing selector and persistence tests**

In `test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts`, update `baseSettings` and empty-session tests:

```ts
  const baseSettings = {
    excludeFirstChatSubstrings: [],
    excludeFirstChatMustStart: false,
    showCodexSubagents: true,
    showEmptySessions: false,
  }
```

Add Codex-specific visibility tests:

```ts
  describe('Codex subagent filtering', () => {
    it('hides Codex subagent sessions when showCodexSubagents is false', () => {
      const items = [
        createSessionItem({ id: '1', provider: 'codex', isSubagent: true }),
        createSessionItem({ id: '2', provider: 'claude', isSubagent: true }),
        createSessionItem({ id: '3' }),
      ]

      const result = filterSessionItemsByVisibility(items, {
        ...baseSettings,
        showSubagents: true,
        showCodexSubagents: false,
        showNoninteractiveSessions: true,
      })

      expect(result.map((i) => i.id)).toEqual(['2', '3'])
    })

    it('shows Codex subagent sessions when showCodexSubagents is true', () => {
      const items = [
        createSessionItem({ id: '1', provider: 'codex', isSubagent: true }),
        createSessionItem({ id: '2' }),
      ]

      const result = filterSessionItemsByVisibility(items, {
        ...baseSettings,
        showSubagents: true,
        showCodexSubagents: true,
        showNoninteractiveSessions: true,
      })

      expect(result.map((i) => i.id)).toEqual(['1', '2'])
    })
  })
```

Replace the entire `describe('empty session filtering', ...)` block with positive names and settings:

```ts
  describe('empty session filtering', () => {
    it('hides empty sessions when showEmptySessions is false', () => {
      const items = [
        createSessionItem({ id: '1', title: 'a7f3b2c1', hasTitle: false }),
        createSessionItem({ id: '2', title: 'Real conversation', hasTitle: true }),
      ]

      const result = filterSessionItemsByVisibility(items, {
        ...baseSettings,
        showSubagents: true,
        showNoninteractiveSessions: true,
        showEmptySessions: false,
      })

      expect(result.map((i) => i.id)).toEqual(['2'])
    })

    it('shows empty sessions when showEmptySessions is true', () => {
      const items = [
        createSessionItem({ id: '1', title: 'a7f3b2c1', hasTitle: false }),
        createSessionItem({ id: '2', title: 'Real conversation', hasTitle: true }),
      ]

      const result = filterSessionItemsByVisibility(items, {
        ...baseSettings,
        showSubagents: true,
        showNoninteractiveSessions: true,
        showEmptySessions: true,
      })

      expect(result.map((i) => i.id)).toEqual(['1', '2'])
    })

    it('hides sessions with system-only firstUserMessage and no title when showEmptySessions is false', () => {
      const items = [
        createSessionItem({
          id: '1',
          title: '63f567a2',
          hasTitle: false,
          firstUserMessage: '<local-command-caveat>system content</local-command-caveat>',
        }),
        createSessionItem({ id: '2', title: 'Real session', hasTitle: true, firstUserMessage: 'Hello' }),
      ]

      const result = filterSessionItemsByVisibility(items, {
        ...baseSettings,
        showSubagents: true,
        showNoninteractiveSessions: true,
        showEmptySessions: false,
      })

      expect(result.map((i) => i.id)).toEqual(['2'])
    })

    it('keeps sessions with a real title even without firstUserMessage', () => {
      const items = [
        createSessionItem({ id: '1', title: 'Manually titled', hasTitle: true, firstUserMessage: undefined }),
        createSessionItem({ id: '2', title: 'deadbeef', hasTitle: false, firstUserMessage: undefined }),
      ]

      const result = filterSessionItemsByVisibility(items, {
        ...baseSettings,
        showSubagents: true,
        showNoninteractiveSessions: true,
        showEmptySessions: false,
      })

      expect(result.map((i) => i.id)).toEqual(['1'])
    })

    it('keeps titleless sessions visible when they have an open tab', () => {
      const result = filterSessionItemsByVisibility([
        createSessionItem({ id: '1', title: 'deadbeef', hasTitle: false, hasTab: true }),
      ], {
        ...baseSettings,
        showSubagents: true,
        showNoninteractiveSessions: true,
        showEmptySessions: false,
      })

      expect(result.map((item) => item.id)).toEqual(['1'])
    })

    it('keeps titleless sessions visible when they are running', () => {
      const result = filterSessionItemsByVisibility([
        createSessionItem({ id: '1', title: 'deadbeef', hasTitle: false, isRunning: true }),
      ], {
        ...baseSettings,
        showSubagents: true,
        showNoninteractiveSessions: true,
        showEmptySessions: false,
      })

      expect(result.map((item) => item.id)).toEqual(['1'])
    })
  })
```

In `test/unit/client/lib/browser-preferences.test.ts`, add imports:

```ts
import { buildLocalSettingsPatch } from '@/store/browserPreferencesPersistence'
import { resolveLocalSettings } from '@shared/settings'
```

Then add:

```ts
it('persists positive sidebar visibility keys in browser preferences', () => {
  const local = resolveLocalSettings({
    sidebar: {
      showCodexSubagents: true,
      showEmptySessions: true,
    },
  })

  expect(buildLocalSettingsPatch(local).sidebar).toMatchObject({
    showCodexSubagents: true,
    showEmptySessions: true,
  })
  expect(buildLocalSettingsPatch(local).sidebar).not.toHaveProperty('ignoreCodexSubagents')
  expect(buildLocalSettingsPatch(local).sidebar).not.toHaveProperty('hideEmptySessions')
})
```

If `buildLocalSettingsPatch` is not exported today, export it from `src/store/browserPreferencesPersistence.ts` because this test needs the same persisted-patch builder used by the middleware.

- [ ] **Step 2: Run focused runtime tests to verify failure**

Run:

```bash
npm run test:vitest -- run \
  test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts \
  test/unit/client/lib/browser-preferences.test.ts
```

Expected: FAIL because runtime code still reads/writes negative keys.

- [ ] **Step 3: Update sidebar selectors to positive fields**

In `src/store/selectors/sidebarSelectors.ts`, replace selectors:

```ts
const selectShowCodexSubagents = (state: RootState) => state.settings.settings.sidebar?.showCodexSubagents ?? false
const selectShowEmptySessions = (state: RootState) => state.settings.settings.sidebar?.showEmptySessions ?? false
```

Update `VisibilitySettings`:

```ts
export interface VisibilitySettings {
  showSubagents: boolean
  showCodexSubagents: boolean
  showNoninteractiveSessions: boolean
  showEmptySessions: boolean
  excludeFirstChatSubstrings: string[]
  excludeFirstChatMustStart: boolean
}
```

Update filtering:

```ts
    if (!settings.showSubagents && item.isSubagent) return false
    if (!settings.showCodexSubagents && item.isSubagent && item.provider === 'codex') return false
    if (shouldHideAsNonInteractive(item, settings.showNoninteractiveSessions)) return false
    if (!settings.showEmptySessions && !item.hasTitle && !item.hasTab && !item.isRunning) return false
```

Update selector argument names and object construction:

```ts
      showSubagents,
      showCodexSubagents,
      showNoninteractiveSessions,
      showEmptySessions,
      excludeFirstChatSubstrings,
      excludeFirstChatMustStart,
```

```ts
      const visible = filterSessionItemsByVisibility(items, {
        showSubagents,
        showCodexSubagents,
        showNoninteractiveSessions,
        showEmptySessions,
        excludeFirstChatSubstrings,
        excludeFirstChatMustStart,
      })
```

Update the `makeSelectSortedSessionItems` `createSelector` input list too:

```ts
      selectShowSubagents,
      selectShowCodexSubagents,
      selectShowNoninteractiveSessions,
      selectShowEmptySessions,
      selectExcludeFirstChatSubstrings,
      selectExcludeFirstChatMustStart,
```

- [ ] **Step 4: Update session snapshot options**

In `src/store/sessionsThunks.ts`, update `getSidebarVisibilityOptions`:

```ts
function getSidebarVisibilityOptions(state: RootState) {
  const sidebarSettings = state.settings?.settings?.sidebar
  return {
    includeSubagents: sidebarSettings?.showSubagents || undefined,
    includeNonInteractive: sidebarSettings?.showNoninteractiveSessions || undefined,
    includeEmpty: sidebarSettings?.showEmptySessions || undefined,
  }
}
```

There is no Codex-specific API option today, so keep Codex subagent filtering client-side.

- [ ] **Step 5: Update browser preference persistence**

In `src/store/browserPreferencesPersistence.ts`, rename only the two negative visibility keys in the sidebar persisted patch builder. Keep `sortMode`, `width`, and `collapsed` persisted:

```ts
  assignChangedScalar(sidebar, localSettings.sidebar, defaultLocalSettings.sidebar, 'sortMode')
  assignChangedScalar(sidebar, localSettings.sidebar, defaultLocalSettings.sidebar, 'showProjectBadges')
  assignChangedScalar(sidebar, localSettings.sidebar, defaultLocalSettings.sidebar, 'showSubagents')
  assignChangedScalar(sidebar, localSettings.sidebar, defaultLocalSettings.sidebar, 'showCodexSubagents')
  assignChangedScalar(sidebar, localSettings.sidebar, defaultLocalSettings.sidebar, 'showNoninteractiveSessions')
  assignChangedScalar(sidebar, localSettings.sidebar, defaultLocalSettings.sidebar, 'showEmptySessions')
  assignChangedScalar(sidebar, localSettings.sidebar, defaultLocalSettings.sidebar, 'width')
  assignChangedScalar(sidebar, localSettings.sidebar, defaultLocalSettings.sidebar, 'collapsed')
```

- [ ] **Step 6: Mechanically update fixtures and stale field references**

Run:

```bash
rg -n "ignoreCodexSubagents|ignoreCodexSubagentSessions|hideEmptySessions" src test shared
```

For runtime code outside migration tests, replace old fields:

```ts
ignoreCodexSubagents: false
```

becomes:

```ts
showCodexSubagents: true
```

```ts
ignoreCodexSubagents: true
```

becomes:

```ts
showCodexSubagents: false
```

```ts
hideEmptySessions: false
```

becomes:

```ts
showEmptySessions: true
```

```ts
hideEmptySessions: true
```

becomes:

```ts
showEmptySessions: false
```

For option types and default-setting reads, update old names manually. For example, in `test/e2e/sidebar-click-opens-pane.test.tsx`:

```ts
  showCodexSubagents?: boolean
```

and:

```ts
      showCodexSubagents: options.showCodexSubagents ?? defaultSettings.sidebar.showCodexSubagents,
```

Replace any `defaultSettings.sidebar.hideEmptySessions` reads with `defaultSettings.sidebar.showEmptySessions`.

Replace deprecated fixture keys too. For example:

```ts
ignoreCodexSubagentSessions: true
```

becomes:

```ts
showCodexSubagents: false
```

Leave only explicit legacy migration tests with old key names.

- [ ] **Step 7: Run runtime tests to verify pass**

Run:

```bash
npm run test:vitest -- run \
  test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts \
  test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts \
  test/unit/client/store/selectors/sidebarSelectors.test.ts \
  test/unit/client/lib/browser-preferences.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add src/store/selectors/sidebarSelectors.ts src/store/sessionsThunks.ts src/store/browserPreferencesPersistence.ts test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/lib/browser-preferences.test.ts
git add test
git commit -m "refactor: consume positive sidebar visibility settings"
```

## Task 4: Integration, Browser Coverage, And Final Verification

**Files:**
- Modify: `test/integration/server/settings-api.test.ts`
- Modify: `test/e2e-browser/specs/settings.spec.ts`
- Modify: `docs/index.html`
- Modify: remaining test fixtures found by `rg`

**Interfaces:**
- Consumes: completed positive schema from Tasks 1-3.
- Produces: high-level confidence that local-only fields stay local, Workspace Settings copy is visible in a browser, and final repo checks pass.

- [ ] **Step 1: Update server API local-only rejection tests**

In `test/integration/server/settings-api.test.ts`, update the payload list:

```ts
    const payloads = [
      { theme: 'dark' },
      { terminal: { fontSize: 18 } },
      { terminal: { osc52Clipboard: 'always' } },
      { sidebar: { sortMode: 'activity' } },
      { sidebar: { showSubagents: true } },
      { sidebar: { showCodexSubagents: true } },
      { sidebar: { showEmptySessions: true } },
      { sidebar: { ignoreCodexSubagents: true } },
      { sidebar: { hideEmptySessions: true } },
      { notifications: { soundEnabled: false } },
    ]
```

- [ ] **Step 2: Update the docs mock settings UI**

In `docs/index.html`, replace the three stale Workspace rows with:

```html
                <div class="settings-row">
                  <div class="settings-label"><div class="settings-label-title">Show Codex subagent sessions</div></div>
                  <div class="settings-control settings-switch-wrap"><button class="settings-switch" type="button" role="switch" aria-checked="false" aria-label="Show Codex subagent sessions"></button></div>
                </div>
```

```html
                <div class="settings-row">
                  <div class="settings-label"><div class="settings-label-title">Show empty sessions</div><div class="settings-label-desc">Show sessions that have no messages yet (e.g. newly started Claude Code sessions).</div></div>
                  <div class="settings-control settings-switch-wrap"><button class="settings-switch" type="button" role="switch" aria-checked="false" aria-label="Show empty sessions"></button></div>
                </div>
```

```html
                <div class="settings-row stack">
                  <div class="settings-label"><div class="settings-label-title">Exclude chats that start with this</div><div class="settings-label-desc">One entry per line. Matching sessions are hidden from the sidebar.</div></div>
                  <div class="settings-control wide"><textarea class="settings-textarea" aria-label="Sidebar first chat exclusion substrings" placeholder="__AUTO__"></textarea></div>
                </div>
```

- [ ] **Step 3: Add Playwright Workspace settings coverage**

In `test/e2e-browser/specs/settings.spec.ts`, add:

```ts
  test('workspace sidebar visibility switches use positive show semantics', async ({ freshellPage, page, harness }) => {
    await openSettingsSection(page, 'Workspace')

    await expect(page.getByText('Show project badges')).toBeVisible()
    await expect(page.getByText('Show subagent sessions')).toBeVisible()
    await expect(page.getByText('Show Codex subagent sessions')).toBeVisible()
    await expect(page.getByText('Show non-interactive sessions')).toBeVisible()
    await expect(page.getByText('Show empty sessions')).toBeVisible()
    await expect(page.getByText('Exclude chats that start with this')).toBeVisible()
    await expect(page.getByText('Ignore Codex subagent sessions')).toHaveCount(0)
    await expect(page.getByText('Hide empty sessions')).toHaveCount(0)
    await expect(page.getByText('Hide sessions by first chat')).toHaveCount(0)

    await page.getByRole('switch', { name: 'Show empty sessions' }).click()
    await page.waitForTimeout(500)

    const settings = await harness.getSettings()
    expect(settings.sidebar.showEmptySessions).toBe(true)
    expect(settings.sidebar.hideEmptySessions).toBeUndefined()
  })
```

- [ ] **Step 4: Run final stale-reference scan**

Run:

```bash
rg -n "Ignore Codex subagent sessions|Hide empty sessions|Hide sessions by first chat|ignoreCodexSubagents|ignoreCodexSubagentSessions|hideEmptySessions" src shared test docs/index.html
```

Expected: only `shared/settings.ts` legacy alias handling, legacy migration tests, and explicit local-only rejection tests mention `ignoreCodexSubagents`, `ignoreCodexSubagentSessions`, or `hideEmptySessions`; no user-facing old labels remain.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run test:vitest -- run \
  test/unit/shared/settings.test.ts \
  test/unit/client/components/SettingsView.behavior.test.tsx \
  test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts \
  test/unit/client/store/selectors/sidebarSelectors.test.ts \
  test/unit/client/lib/browser-preferences.test.ts

npm run test:vitest -- run test/integration/server/settings-api.test.ts --config config/vitest/vitest.server.config.ts
```

Expected: PASS.

- [ ] **Step 6: Run lint, typecheck, and coordinated check**

Run:

```bash
npm run lint
npm run typecheck
FRESHELL_TEST_SUMMARY='settings show switches positive schema' npm run check
```

Expected: PASS, with only pre-existing non-blocking lint warnings if the repo already has them.

- [ ] **Step 7: Run browser settings spec**

Run:

```bash
npm run test:e2e -- test/e2e-browser/specs/settings.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

```bash
git add test/integration/server/settings-api.test.ts test/e2e-browser/specs/settings.spec.ts docs/index.html
git add src shared test
git commit -m "test: cover positive workspace visibility settings"
```

## Self-Review

**Spec coverage:** The plan covers all inventoried hide/show items in Settings. Already-positive rows stay unchanged. `Ignore Codex subagent sessions` and `Hide empty sessions` become positive labels, positive switch state, positive defaults, and positive internal keys. The first-chat row receives the requested label while preserving its server-backed filtering storage.

**Placeholder scan:** No implementation step depends on unspecified future work, missing code, "similar to", or unspecified error handling. Each code-changing step includes concrete code or exact mechanical replacements.

**Type consistency:** The new local field names are `showCodexSubagents` and `showEmptySessions` everywhere. Legacy names appear only in migration/stripping/rejection tests and in the sanitizer aliases.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-22-settings-show-switches.md`. Two execution options:

**1. Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.
