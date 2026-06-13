# Freshagent Style Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-Fresh Agent pane-type style defaults, expose a `sans` / `serif` dropdown in each Fresh Agent pane settings menu, and render the new serif-clean transcript style without changing existing sans behavior.

**Architecture:** Treat style as a server-backed Fresh Agent provider default keyed by `sessionType`, matching existing model/thinking/permission defaults. Each pane stores its chosen style once changed, while new panes and legacy panes without a stored style resolve through `settings.freshAgent.providers[sessionType].style ?? 'sans'`. Rendering is a root class/data attribute on `FreshAgentView`; CSS keeps the existing sans look as the baseline and scopes serif changes under `.fresh-agent-style-serif`.

**Tech Stack:** React 18, Redux Toolkit, TypeScript, Zod settings schemas, Vitest, Testing Library, Tailwind CSS plus `src/index.css`.

---

## File Structure

- Modify `shared/settings.ts`: define/export the style contract, normalize style values, extend `AgentChatProviderDefaults`, and allow `style` through schemas, sanitization, alias merging, and legacy provider-default normalization.
- Modify `src/store/paneTypes.ts`: add `style?: FreshAgentStyle` to `FreshAgentPaneContent`.
- Modify `src/store/panesSlice.ts`: preserve and normalize `style` whenever Fresh Agent pane content is initialized, merged, hydrated, or updated.
- Leave Fresh Agent resume content style-free so reopened history panes resolve the current per-sessionType provider default instead of hard-stamping an old visual style.
- Modify `src/components/panes/PaneContainer.tsx`: seed newly created Fresh Agent panes with the per-sessionType style default.
- Modify `src/components/fresh-agent/FreshAgentSettingsButton.tsx`: add the style dropdown, update the current pane, and persist the chosen provider default under `freshAgent.providers[sessionType]`.
- Modify `src/components/fresh-agent/FreshAgentView.tsx`: resolve the active style and apply `fresh-agent-style-sans` or `fresh-agent-style-serif` plus `data-style`.
- Modify `src/lib/tab-registry-snapshot.ts`: include Fresh Agent pane style in cross-device tab registry payloads.
- Modify `src/components/TabsView.tsx`: restore Fresh Agent pane style when reopening a tab-registry snapshot.
- Modify `src/index.css`: add scoped serif-clean visual treatment for light and dark mode.
- Modify `docs/index.html`: reflect the Fresh Agent settings style selector in the static default-experience mock.
- Modify tests:
  - `test/unit/shared/settings.test.ts`
  - `test/unit/server/config-store.fresh-agent-settings.test.ts`
  - `test/integration/server/settings-api.test.ts`
  - `test/unit/client/store/panesSlice.test.ts`
  - `test/unit/client/lib/tab-registry-snapshot.test.ts`
  - `test/unit/client/components/TabsView.fresh-agent.test.tsx`
  - `test/unit/client/lib/session-type-utils.test.ts`
  - `test/unit/client/components/panes/PaneContainer.createContent.test.tsx`
  - `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
  - `test/e2e-browser/specs/fresh-agent.spec.ts`

## Implementation Tasks

### Task 1: Shared Style Contract And Settings Persistence

**Files:**
- Modify: `shared/settings.ts`
- Test: `test/unit/shared/settings.test.ts`
- Test: `test/unit/server/config-store.fresh-agent-settings.test.ts`
- Test: `test/integration/server/settings-api.test.ts`

- [ ] **Step 1: Write failing shared settings tests**

Add these assertions inside `describe('shared settings contract', ...)` in `test/unit/shared/settings.test.ts`:

```ts
  it('accepts fresh-agent provider style defaults and keeps them per session type', () => {
    const parsed = buildServerSettingsPatchSchema().parse({
      freshAgent: {
        providers: {
          freshcodex: { style: 'serif' },
          freshclaude: { style: 'sans' },
        },
      },
    })

    expect(parsed.freshAgent?.providers?.freshcodex).toEqual({ style: 'serif' })
    expect(parsed.freshAgent?.providers?.freshclaude).toEqual({ style: 'sans' })

    const merged = mergeServerSettings(createDefaultServerSettings({ loggingDebug: false }), {
      freshAgent: {
        providers: {
          freshcodex: { style: 'serif' },
          freshclaude: { style: 'sans' },
        },
      },
    })

    expect(merged.freshAgent.providers.freshcodex?.style).toBe('serif')
    expect(merged.freshAgent.providers.freshclaude?.style).toBe('sans')
    expect(merged.agentChat.providers).toEqual(merged.freshAgent.providers)
  })

  it('rejects invalid fresh-agent provider style defaults', () => {
    const schema = buildServerSettingsPatchSchema()

    expect(schema.safeParse({
      freshAgent: {
        providers: {
          freshcodex: { style: 'mono' },
        },
      },
    }).success).toBe(false)

    const merged = mergeServerSettings(createDefaultServerSettings({ loggingDebug: false }), {
      freshAgent: {
        providers: {
          freshcodex: { style: 'mono' as any },
        },
      },
    })

    expect(merged.freshAgent.providers.freshcodex).toBeUndefined()
  })
```

Extend the legacy migration test in `test/unit/server/config-store.fresh-agent-settings.test.ts` so the legacy input carries style:

```ts
          freshclaude: { defaultModel: 'fixture-claude-model', defaultEffort: 'high', style: 'serif' },
```

and both expectations include:

```ts
      style: 'serif',
```

In `test/integration/server/settings-api.test.ts`, extend `PATCH /api/settings accepts freshAgent settings while preserving the legacy alias` so the posted `freshAgent.providers` includes:

```ts
          freshcodex: { style: 'serif' },
```

and assert both aliases round-trip:

```ts
    expect(res.body.freshAgent.providers.freshcodex).toEqual({ style: 'serif' })
    expect(res.body.agentChat.providers.freshcodex).toEqual({ style: 'serif' })
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
env -u NODE_ENV npm run test:vitest -- test/unit/shared/settings.test.ts test/unit/server/config-store.fresh-agent-settings.test.ts test/integration/server/settings-api.test.ts --run
```

Expected: FAIL because `style` is not allowed by the strict provider defaults schemas, rejected by the settings API, and stripped from legacy provider defaults.

- [ ] **Step 3: Implement the shared style contract**

In `shared/settings.ts`, add the style values near the other settings value constants:

```ts
export const FRESH_AGENT_STYLE_VALUES = ['sans', 'serif'] as const
export type FreshAgentStyle = (typeof FRESH_AGENT_STYLE_VALUES)[number]
export const DEFAULT_FRESH_AGENT_STYLE: FreshAgentStyle = 'sans'
```

Add the schema near the other Zod schemas:

```ts
const FreshAgentStyleSchema = z.enum(FRESH_AGENT_STYLE_VALUES)
```

Export normalizers after the local Fresh Agent font-scale helpers:

```ts
export function normalizeFreshAgentStyleOverride(value: unknown): FreshAgentStyle | undefined {
  return FreshAgentStyleSchema.safeParse(value).success
    ? value as FreshAgentStyle
    : undefined
}

export function normalizeFreshAgentStyle(value: unknown): FreshAgentStyle {
  return normalizeFreshAgentStyleOverride(value) ?? DEFAULT_FRESH_AGENT_STYLE
}
```

Extend `AgentChatProviderDefaults`:

```ts
export type AgentChatProviderDefaults = {
  modelSelection?: AgentChatModelSelection
  defaultPermissionMode?: string
  effort?: AgentChatEffort
  style?: FreshAgentStyle
}
```

Extend both provider defaults schemas:

```ts
function createAgentChatProviderDefaultsSchema() {
  return z
    .object({
      modelSelection: AgentChatModelSelectionSchema.optional(),
      defaultPermissionMode: z.string().optional(),
      effort: AgentChatOpaqueStringSchema.optional(),
      style: FreshAgentStyleSchema.optional(),
    })
    .strict()
}

function createAgentChatProviderDefaultsPatchSchema() {
  return z
    .object({
      modelSelection: AgentChatModelSelectionSchema.nullable().optional(),
      defaultPermissionMode: z.string().optional(),
      effort: z.union([AgentChatOpaqueStringSchema, z.literal('')]).nullable().optional(),
      style: FreshAgentStyleSchema.optional(),
    })
    .strict()
}
```

In `sanitizeServerSettingsPatch`, copy parsed `style` into provider patches:

```ts
          if (hasOwn(normalizedProviderPatchInput, 'style')) {
            normalizedProviderPatch.style = parsed.data.style
          }
```

In `normalizeLegacyAgentChatProviderDefaultsInput`, preserve style by changing the key list to:

```ts
    ['modelSelection', 'defaultPermissionMode', 'effort', 'style'],
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
env -u NODE_ENV npm run test:vitest -- test/unit/shared/settings.test.ts test/unit/server/config-store.fresh-agent-settings.test.ts test/integration/server/settings-api.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/settings.ts test/unit/shared/settings.test.ts test/unit/server/config-store.fresh-agent-settings.test.ts test/integration/server/settings-api.test.ts
git commit -m "feat: add fresh agent style defaults contract"
```

### Task 2: Pane Content Persistence Boundaries

**Files:**
- Modify: `src/store/paneTypes.ts`
- Modify: `src/store/panesSlice.ts`
- Modify: `src/lib/tab-registry-snapshot.ts`
- Modify: `src/components/TabsView.tsx`
- Test: `test/unit/client/store/panesSlice.test.ts`
- Test: `test/unit/client/lib/tab-registry-snapshot.test.ts`
- Test: `test/unit/client/components/TabsView.fresh-agent.test.tsx`

- [ ] **Step 1: Write failing pane normalization tests**

In `test/unit/client/store/panesSlice.test.ts`, add a test near the Fresh Agent pane cases:

```ts
  it('preserves fresh-agent style through content initialization and merge updates', () => {
    const state = panesReducer(undefined, initLayout({
      tabId: 'tab-style',
      paneId: 'pane-style',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-style',
        status: 'idle',
        style: 'serif',
      },
    }))

    const initialized = state.layouts['tab-style']
    expect(initialized.type).toBe('leaf')
    expect(initialized.type === 'leaf' && initialized.content.kind === 'fresh-agent'
      ? initialized.content.style
      : null).toBe('serif')

    const updated = panesReducer(state, mergePaneContent({
      tabId: 'tab-style',
      paneId: 'pane-style',
      updates: { style: 'sans' },
    }))
    const updatedNode = updated.layouts['tab-style']
    expect(updatedNode.type === 'leaf' && updatedNode.content.kind === 'fresh-agent'
      ? updatedNode.content.style
      : null).toBe('sans')
  })

  it('does not force a style override onto legacy fresh-agent panes', () => {
    const state = panesReducer(undefined, initLayout({
      tabId: 'tab-legacy-style',
      paneId: 'pane-legacy-style',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-legacy-style',
        status: 'idle',
      },
    }))

    const initialized = state.layouts['tab-legacy-style']
    expect(initialized.type === 'leaf' && initialized.content.kind === 'fresh-agent'
      ? initialized.content.style
      : 'unexpected').toBeUndefined()
  })
```

In `test/unit/client/lib/tab-registry-snapshot.test.ts`, add a case in `describe('collectPaneSnapshots', ...)` beside the other payload tests:

```ts
  it('keeps fresh-agent style in tab-registry pane payloads', () => {
    const node: PaneNode = {
      type: 'leaf',
      id: 'pane-style',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-style',
        status: 'idle',
        style: 'serif',
      },
    }

    const snapshots = collectPaneSnapshots(node, 'server-style')

    expect(snapshots[0]).toMatchObject({
      kind: 'fresh-agent',
      payload: {
        sessionType: 'freshcodex',
        style: 'serif',
      },
    })
  })
```

In `test/unit/client/components/TabsView.fresh-agent.test.tsx`, extend `serializes fresh-agent panes in remote snapshots and rehydrates them back into fresh-agent panes` by adding `style: 'serif'` to the remote pane payload:

```ts
            style: 'serif',
```

and include style in the final `toMatchObject` assertion:

```ts
      style: 'serif',
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
env -u NODE_ENV npm run test:vitest -- test/unit/client/store/panesSlice.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/components/TabsView.fresh-agent.test.tsx --run
```

Expected: FAIL because `panesSlice.normalizePaneContent` reconstructs Fresh Agent content from a whitelist without `style`, `tab-registry-snapshot` strips Fresh Agent payloads to a whitelist without `style`, and `TabsView` restores Fresh Agent snapshots from a payload whitelist without `style`.

- [ ] **Step 3: Implement pane content persistence**

In `src/store/paneTypes.ts`, import the style type:

```ts
import type { FreshAgentStyle } from '@shared/settings'
```

Add the field to `FreshAgentPaneContent`:

```ts
  /** Visual style for this pane; missing legacy panes resolve from provider defaults, then sans. */
  style?: FreshAgentStyle
```

In `src/store/panesSlice.ts`, import the normalizer:

```ts
import { normalizeFreshAgentStyleOverride } from '@shared/settings'
```

In the `fresh-agent` branch of `normalizePaneContent`, resolve and conditionally spread a valid override:

```ts
    const style = normalizeFreshAgentStyleOverride((input as { style?: unknown }).style)
```

Then include it in the returned Fresh Agent content:

```ts
      ...(style ? { style } : {}),
```

Place the spread before `settingsDismissed` so `mergePaneContent({ updates: { style } })`, `initLayout`, `updatePaneContent`, hydration, and UI-command pane attaches all preserve valid style overrides. Do not write `style: normalizeFreshAgentStyle(...)` here; missing legacy styles must stay missing so those panes can continue resolving through provider defaults.

In `src/lib/tab-registry-snapshot.ts`, include style in the Fresh Agent content payload:

```ts
    ...(content.style ? { style: content.style } : {}),
```

In `src/components/TabsView.tsx`, include style when rebuilding Fresh Agent pane content from a tab-registry snapshot:

```ts
    const style = normalizeFreshAgentStyleOverride(payload.style)
```

Then include it in the returned Fresh Agent content:

```ts
      ...(style ? { style } : {}),
```

Add the `normalizeFreshAgentStyleOverride` import from `@shared/settings`. Do not read `content.style` here; `sanitizePaneSnapshot` rebuilds from the snapshot `payload`, which is `Record<string, unknown>`.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
env -u NODE_ENV npm run test:vitest -- test/unit/client/store/panesSlice.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/components/TabsView.fresh-agent.test.tsx --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/paneTypes.ts src/store/panesSlice.ts src/lib/tab-registry-snapshot.ts src/components/TabsView.tsx test/unit/client/store/panesSlice.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/components/TabsView.fresh-agent.test.tsx
git commit -m "feat: preserve fresh agent pane styles"
```

### Task 3: Pane Creation Defaults And Resume Inheritance

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx`
- Test: `test/unit/client/components/panes/PaneContainer.createContent.test.tsx`
- Test: `test/unit/client/lib/session-type-utils.test.ts`

- [ ] **Step 1: Write failing pane creation tests**

In `test/unit/client/components/panes/PaneContainer.createContent.test.tsx`, extend the existing test named `starts Freshcodex panes with the persisted fresh-agent provider defaults` so the `freshcodex` provider defaults include style:

```ts
              style: 'serif',
```

and add this expectation inside the final `waitFor` block:

```ts
      expect(paneContent.style).toBe('serif')
```

Add a second test after it to prove the default is keyed by pane type:

```ts
  it('does not let the Freshcodex style default affect Freshclaude panes', async () => {
    const node = createPickerNode('pane-1')
    const store = createStore(
      { layouts: { 'tab-1': node }, activePane: { 'tab-1': 'pane-1' } },
      [],
      {
        codingCli: {
          enabledProviders: ['claude', 'codex'],
          providers: {
            claude: { permissionMode: 'default' },
            codex: {},
          },
        },
        freshAgent: {
          enabled: true,
          providers: {
            freshcodex: { style: 'serif' },
          },
        },
      },
      {
        status: 'ready',
        platform: 'linux',
        availableClis: { claude: true, codex: true },
      },
    )

    render(
      <Provider store={store}>
        <PaneContainer tabId="tab-1" node={node} />
      </Provider>,
    )

    const freshclaudeButton = screen.getByRole('button', { name: 'Freshclaude' })
    fireEvent.click(freshclaudeButton)
    const container = getPickerContainer()
    fireEvent.transitionEnd(container)

    const input = await screen.findByLabelText('Starting directory for Freshclaude')
    fireEvent.change(input, { target: { value: '/workspace/claude' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      const paneContent = (store.getState().panes.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).content
      expect(paneContent.kind).toBe('fresh-agent')
      if (paneContent.kind !== 'fresh-agent') return
      expect(paneContent.sessionType).toBe('freshclaude')
      expect(paneContent.style).toBe('sans')
    })
  })
```

In `test/unit/client/lib/session-type-utils.test.ts`, add a guard test in `describe('buildResumeContent', ...)`:

```ts
  it('does not stamp visual style onto fresh-agent resume content', () => {
    const content = buildResumeContent({
      sessionType: 'freshcodex',
      sessionId: 'codex-session-1',
      cwd: '/workspace/codex',
    })

    expect(content.kind).toBe('fresh-agent')
    if (content.kind !== 'fresh-agent') throw new Error('expected fresh-agent')
    expect(content.sessionType).toBe('freshcodex')
    expect(content.provider).toBe('codex')
    expect(content.style).toBeUndefined()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
env -u NODE_ENV npm run test:vitest -- test/unit/client/components/panes/PaneContainer.createContent.test.tsx test/unit/client/lib/session-type-utils.test.ts --run
```

Expected: FAIL because pane creation does not set `style`. The `buildResumeContent` guard should already pass and exists to prevent a future implementation from hard-stamping `sans` onto resumed panes, which would block provider-default inheritance.

- [ ] **Step 3: Implement pane creation style defaults**

In `src/components/panes/PaneContainer.tsx`, import defaults:

```ts
import { DEFAULT_FRESH_AGENT_STYLE } from '@shared/settings'
```

Add style to the Fresh Agent `return` object in `createContentForType`:

```ts
        style: providerSettings?.style ?? DEFAULT_FRESH_AGENT_STYLE,
```

Do not add style to `buildResumeContent`. Reopened history panes should remain style-free and resolve `paneContent.style ?? providerDefaults?.style ?? 'sans'` inside `FreshAgentView` and `FreshAgentSettingsButton`.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
env -u NODE_ENV npm run test:vitest -- test/unit/client/components/panes/PaneContainer.createContent.test.tsx test/unit/client/lib/session-type-utils.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/panes/PaneContainer.tsx test/unit/client/components/panes/PaneContainer.createContent.test.tsx test/unit/client/lib/session-type-utils.test.ts
git commit -m "feat: apply fresh agent style defaults to panes"
```

### Task 4: Settings Dropdown And View Style Resolution

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentSettingsButton.tsx`
- Modify: `src/components/fresh-agent/FreshAgentView.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

- [ ] **Step 1: Write failing component tests**

In `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`, add this settings test after the existing Freshcodex settings tests:

```ts
  it('lets a Freshcodex pane choose style and persists it as a per-sessionType default', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-style',
        sessionId: 'thread-style',
        status: 'idle',
        model: 'gpt-5.4-flash',
        effort: 'high',
        style: 'sans',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentSettingsButton tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))
    const styleSelect = screen.getByRole('combobox', { name: 'Style' })
    expect(styleSelect).toHaveValue('sans')

    fireEvent.change(styleSelect, { target: { value: 'serif' } })

    const layout = store.getState().panes.layouts['tab-1']
    expect(layout?.type === 'leaf' && layout.content.kind === 'fresh-agent' ? layout.content.style : null).toBe('serif')
    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      freshAgent: {
        providers: {
          freshcodex: { style: 'serif' },
        },
      },
    })
  })
```

Add this rendering test in the `FreshAgentView` describe block:

```ts
  it('applies the resolved fresh-agent style to the view root', async () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshcodex',
            provider: 'codex',
            createRequestId: 'req-render-style',
            sessionId: 'thread-render-style',
            status: 'idle',
            style: 'serif',
          }}
        />
      </Provider>,
    )

    const root = await waitFor(() => document.querySelector('[data-context="fresh-agent"]') as HTMLElement)
    expect(root).toHaveAttribute('data-style', 'serif')
    expect(root).toHaveClass('fresh-agent-style-serif')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
env -u NODE_ENV npm run test:vitest -- test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --run
```

Expected: FAIL because no style combobox exists and the root does not expose style.

- [ ] **Step 3: Implement the settings dropdown**

In `src/components/fresh-agent/FreshAgentSettingsButton.tsx`, update imports:

```ts
import type { FreshAgentPaneContent } from '@/store/paneTypes'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  DEFAULT_FRESH_AGENT_STYLE,
  FRESH_AGENT_STYLE_VALUES,
  normalizeFreshAgentStyle,
  type FreshAgentStyle,
} from '@shared/settings'
```

Resolve provider defaults and the active style inside the component:

```ts
  const providerDefaults = useAppSelector(
    (state) => state.settings.settings.freshAgent?.providers?.[paneContent.sessionType]
      ?? state.settings.serverSettings?.freshAgent?.providers?.[paneContent.sessionType]
      ?? state.settings.settings.agentChat?.providers?.[paneContent.sessionType]
      ?? state.settings.serverSettings?.agentChat?.providers?.[paneContent.sessionType],
  )
  const styleValue = normalizeFreshAgentStyle(
    paneContent.style ?? providerDefaults?.style ?? DEFAULT_FRESH_AGENT_STYLE,
  )
```

Extend `persistProviderDefaults`:

```ts
  const persistProviderDefaults = useCallback((defaults: {
    modelSelection?: { kind: 'exact'; modelId: string }
    defaultPermissionMode?: string
    effort?: string
    style?: FreshAgentStyle
  }) => {
```

Add the style select as the first item in the popover:

```tsx
            <label className="block space-y-1">
              <span className="font-medium">Style</span>
              <select
                aria-label="Style"
                className="min-h-[2.5rem] w-full rounded border border-border/70 bg-background px-2 py-1 text-base sm:min-h-0 sm:text-xs"
                value={styleValue}
                onChange={(event) => {
                  const nextStyle = normalizeFreshAgentStyle(event.target.value)
                  dispatch(mergePaneContent({
                    tabId,
                    paneId,
                    updates: { style: nextStyle },
                  }))
                  persistProviderDefaults({ style: nextStyle })
                }}
              >
                {FRESH_AGENT_STYLE_VALUES.map((style) => (
                  <option key={style} value={style}>
                    {style === 'sans' ? 'Sans' : 'Serif'}
                  </option>
                ))}
              </select>
            </label>
```

Do not disable the style dropdown when `settingsDisabled` is true; style is presentation-only and can change while a runtime turn is running.

- [ ] **Step 4: Implement view style resolution**

In `src/components/fresh-agent/FreshAgentView.tsx`, import:

```ts
import { cn } from '@/lib/utils'
import { DEFAULT_FRESH_AGENT_STYLE, normalizeFreshAgentStyle } from '@shared/settings'
```

Inside `FreshAgentView`, resolve provider defaults and active style:

```ts
  const providerDefaults = useAppSelector(
    (state) => state.settings.settings.freshAgent?.providers?.[paneContent.sessionType]
      ?? state.settings.serverSettings?.freshAgent?.providers?.[paneContent.sessionType]
      ?? state.settings.settings.agentChat?.providers?.[paneContent.sessionType]
      ?? state.settings.serverSettings?.agentChat?.providers?.[paneContent.sessionType],
  )
  const activeStyle = normalizeFreshAgentStyle(
    paneContent.style ?? providerDefaults?.style ?? DEFAULT_FRESH_AGENT_STYLE,
  )
```

Change the root `div`:

```tsx
      <div
        className={cn(
          'fresh-agent-pane relative flex h-full min-h-0 flex-col overflow-hidden',
          `fresh-agent-style-${activeStyle}`,
        )}
        data-context="fresh-agent"
        data-style={activeStyle}
        data-session-id={paneContent.sessionId}
        style={{ '--fresh-transcript-font-size': `${terminalFontSize}px` } as CSSProperties}
        onPointerUpCapture={handlePanePointerUp}
        onKeyDownCapture={handlePaneKeyDown}
      >
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
env -u NODE_ENV npm run test:vitest -- test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --run
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/fresh-agent/FreshAgentSettingsButton.tsx src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git commit -m "feat: add fresh agent style selector"
```

### Task 5: Serif-Clean Visual Treatment

**Files:**
- Modify: `src/index.css`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

- [ ] **Step 1: Add CSS expectations to the existing root style test**

Extend the `applies the resolved fresh-agent style to the view root` test from Task 3:

```ts
    expect(root.className).toContain('fresh-agent-style-serif')
```

This intentionally tests the class contract, not computed browser CSS.

- [ ] **Step 2: Run the test to verify the class contract passes before styling**

Run:

```bash
env -u NODE_ENV npm run test:vitest -- test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --run
```

Expected: PASS. This confirms the remaining work is visual CSS scoped to an already-tested class.

- [ ] **Step 3: Add scoped serif styles**

In `src/index.css`, extend `.fresh-agent-pane` with style variables:

```css
.fresh-agent-pane {
  container-type: inline-size;
  --fresh-transcript-font-size: 16px;
  --fresh-agent-copy-font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --fresh-agent-meta-font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --fresh-agent-surface: hsl(var(--background));
  --fresh-agent-panel-surface: hsl(var(--card));
  --fresh-agent-subtle-surface: hsl(var(--muted) / 0.4);
  --fresh-agent-border: hsl(var(--border) / 0.6);
  --fresh-agent-text: hsl(var(--foreground));
  --fresh-agent-muted-text: hsl(var(--muted-foreground));
}
```

Add scoped serif overrides after the existing `.fresh-agent-transcript-copy` rules:

```css
.fresh-agent-style-serif {
  --fresh-agent-copy-font-family: ui-serif, Georgia, Cambria, "Times New Roman", Times, serif;
  --fresh-agent-meta-font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --fresh-agent-surface: #ffffff;
  --fresh-agent-panel-surface: #fbfaf8;
  --fresh-agent-subtle-surface: #f6f2ec;
  --fresh-agent-border: color-mix(in srgb, hsl(var(--border)) 72%, #b47d3c 28%);
  --fresh-agent-text: #221f1b;
  --fresh-agent-muted-text: #696159;
  background: var(--fresh-agent-surface);
  color: var(--fresh-agent-text);
}

.dark .fresh-agent-style-serif {
  --fresh-agent-surface: #141311;
  --fresh-agent-panel-surface: #1c1a17;
  --fresh-agent-subtle-surface: #25211d;
  --fresh-agent-border: color-mix(in srgb, hsl(var(--border)) 74%, #c59b6a 26%);
  --fresh-agent-text: #f4efe7;
  --fresh-agent-muted-text: #b8aea2;
}

.fresh-agent-style-serif .fresh-agent-transcript-copy {
  color: var(--fresh-agent-text);
  font-family: var(--fresh-agent-copy-font-family);
  line-height: 1.42;
}

.fresh-agent-style-serif .fresh-agent-transcript-copy [data-markdown-body] :where(h1, h2, h3, h4) {
  color: var(--fresh-agent-text);
  font-family: var(--fresh-agent-copy-font-family);
  font-weight: 650;
  letter-spacing: 0;
}

.fresh-agent-style-serif .fresh-agent-transcript-copy [data-markdown-body] :where(p, li, blockquote) {
  color: var(--fresh-agent-text);
}

.fresh-agent-style-serif .fresh-agent-transcript-copy [data-markdown-body] :where(pre, code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}

.fresh-agent-style-serif .fresh-agent-sidebar,
.fresh-agent-style-serif .fresh-agent-sidebar-section {
  border-color: var(--fresh-agent-border);
}

.fresh-agent-style-serif .fresh-agent-sidebar-section,
.fresh-agent-style-serif .fresh-agent-transcript-copy [data-markdown-body] blockquote {
  background: var(--fresh-agent-subtle-surface);
}
```

Do not add a `.fresh-agent-style-sans` override; sans remains the current CSS behavior.
The scoped serif CSS intentionally applies to transcript and `FreshAgentSidebar` content under `FreshAgentView`; it does not style the pane header or settings popover, which are rendered outside the Fresh Agent view root.

- [ ] **Step 4: Run focused component tests**

Run:

```bash
env -u NODE_ENV npm run test:vitest -- test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.css test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git commit -m "style: add fresh agent serif theme"
```

### Task 6: Browser E2E Coverage

**Files:**
- Modify: `test/e2e-browser/specs/fresh-agent.spec.ts`

- [ ] **Step 1: Add a failing browser workflow test**

In `test/e2e-browser/specs/fresh-agent.spec.ts`, add a test after the existing Fresh Agent settings tests:

```ts
  test('style setting persists per Fresh Agent pane type and applies serif rendering', async ({ freshellPage: _freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await enableClaudeAndCodex(page)

    await harness.clearSentWsMessages()
    let picker = await openPanePicker(page)
    await suppressFreshAgentNetworkForActivePane(page)
    await picker.getByRole('button', { name: /^Freshcodex$/i }).click({ force: true })
    await page.getByRole('option').first().click()

    let dialog = await openFreshAgentSettings(page, 'Freshcodex')
    await dialog.getByRole('combobox', { name: /^Style$/i }).selectOption('serif')

    const freshcodexRoot = page.locator('[data-context="fresh-agent"][data-style="serif"]').last()
    await expect(freshcodexRoot).toBeVisible()
    await expect.poll(async () => {
      return page.evaluate(() => {
        const settings = window.__FRESHELL_TEST_HARNESS__?.getState()?.settings?.settings
        return settings?.freshAgent?.providers?.freshcodex?.style ?? null
      })
    }).toBe('serif')

    const transcriptFont = await freshcodexRoot.locator('.fresh-agent-transcript-copy').first().evaluate((node) => {
      return getComputedStyle(node).fontFamily
    })
    expect(transcriptFont.toLowerCase()).toContain('georgia')

    picker = await openPanePicker(page)
    await suppressFreshAgentNetworkForActivePane(page)
    await picker.getByRole('button', { name: /^Freshclaude$/i }).click({ force: true })
    await page.getByRole('option').first().click()

    dialog = await openFreshAgentSettings(page, 'Freshclaude')
    await expect(dialog.getByRole('combobox', { name: /^Style$/i })).toHaveValue('sans')

    picker = await openPanePicker(page)
    await suppressFreshAgentNetworkForActivePane(page)
    await picker.getByRole('button', { name: /^Freshcodex$/i }).click({ force: true })
    await page.getByRole('option').first().click()

    dialog = await openFreshAgentSettings(page, 'Freshcodex')
    await expect(dialog.getByRole('combobox', { name: /^Style$/i })).toHaveValue('serif')
  })
```

If the exact DOM contains no transcript copy before a snapshot loads, seed a minimal Fresh Agent snapshot in the active pane using the existing harness pattern from the surrounding spec before reading computed style.

- [ ] **Step 2: Run the browser test to verify it fails**

Run:

```bash
env -u NODE_ENV npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent.spec.ts
```

Expected: FAIL because there is no style dropdown and no `data-style`/serif rendering yet.

- [ ] **Step 3: Run the browser test after implementation**

Run:

```bash
env -u NODE_ENV npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent.spec.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/e2e-browser/specs/fresh-agent.spec.ts
git commit -m "test: cover fresh agent style workflow"
```

### Task 7: Static Docs Mock And Full Verification

**Files:**
- Modify: `docs/index.html`

- [ ] **Step 1: Update the static docs mock**

In `docs/index.html`, update the Fresh Agent mock area near the pane header/settings affordance to show the style selector as part of the represented settings surface. Add this markup near the Fresh Agent pane mock controls or settings popover representation:

```html
<div class="fresh-style-control" aria-label="Fresh Agent style setting">
  <span>Style</span>
  <strong>Serif</strong>
</div>
```

Add CSS in the Fresh Agent mock section:

```css
.fresh-style-control {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid rgba(120, 113, 108, 0.32);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.78);
  color: #2d2924;
  padding: 6px 9px;
  font-size: 12px;
  line-height: 1;
}

.fresh-style-control strong {
  font-family: ui-serif, Georgia, Cambria, "Times New Roman", Times, serif;
  font-weight: 650;
}
```

Keep this as static documentation only; do not create a new standalone mockup.

- [ ] **Step 2: Run targeted tests**

Run:

```bash
env -u NODE_ENV npm run test:vitest -- test/unit/shared/settings.test.ts test/unit/server/config-store.fresh-agent-settings.test.ts test/integration/server/settings-api.test.ts test/unit/client/store/panesSlice.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/components/TabsView.fresh-agent.test.tsx test/unit/client/components/panes/PaneContainer.createContent.test.tsx test/unit/client/lib/session-type-utils.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --run
env -u NODE_ENV npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
env -u NODE_ENV npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run coordinated full suite**

Run:

```bash
env -u NODE_ENV FRESHELL_TEST_SUMMARY="freshagent style settings verification" npm test
```

Expected: PASS for client, server, and electron suites.

- [ ] **Step 5: Commit**

```bash
git add docs/index.html
git commit -m "docs: show fresh agent style setting"
```

## Acceptance Criteria

- Fresh Agent settings popovers show a `Style` dropdown with `Sans` and `Serif`.
- Changing style updates the current pane immediately.
- Changing style persists `settings.freshAgent.providers[sessionType].style`, so future panes of the same Fresh Agent pane type inherit it.
- Freshcodex style defaults do not affect Freshclaude defaults, and vice versa.
- Missing legacy style values resolve to `sans`.
- `sans` preserves the existing look by default.
- `serif` applies a white light-mode surface, a warm dark-mode surface, serif transcript typography, and scoped panel/border color adjustments.
- Targeted tests, typecheck, and the coordinated full test suite pass.
