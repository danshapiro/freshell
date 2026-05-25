# Fresh Agent Tab Naming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make new FreshAgent tabs auto-name like terminal-backed CLI tabs: prefer the active working directory immediately, fall back to the FreshAgent label, then allow first-message auto-title without overriding user-renamed tabs.

**Architecture:** Extend the shared tab-title derivation path instead of adding component-specific tab display logic. FreshAgent pane content already carries `initialCwd`, so `deriveTabName()` should treat it as a first-class title source, and `FreshAgentView` should reuse the existing shared `extractTitleFromMessage()` helper for first-message auto-title.

**Tech Stack:** React 18, Redux Toolkit, Vitest, Testing Library, TypeScript/NodeNext.

---

## File Structure

- Modify `src/lib/deriveTabName.ts`
  - Add FreshAgent pane recognition.
  - Reuse the existing last-directory-segment behavior for `initialCwd`.
  - Prefer `initialCwd` for FreshAgent tabs; fall back to `getFreshAgentLabel(sessionType)`.
- Modify `test/unit/client/lib/deriveTabName.test.ts`
  - Add direct unit coverage for FreshAgent cwd naming and label fallback.
- Modify `test/unit/client/components/TabBar.deriveTitle.test.tsx`
  - Add integration-ish component coverage proving the visible tab label is the FreshAgent working directory, not `Tab`.
- Modify `src/components/fresh-agent/FreshAgentView.tsx`
  - Import `updatePaneTitle`, `updateTab`, and `extractTitleFromMessage`.
  - Add first-message auto-title before `freshAgent.send`.
  - Do not override user-set tab titles.
- Modify `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
  - Add a store with `tabs` reducer for title assertions.
  - Add tests for first-message title updates and user-title preservation.
- No README or `docs/index.html` update is needed; this is restoring expected chrome behavior, not adding an end-user-facing feature surface.

## Design Notes

- "As soon as it is active" means the tab display should derive from pane content synchronously as soon as the pane layout exists, the same way shell panes derive from `initialCwd`.
- FreshAgent is not terminal-backed, so it will not receive PTY title/cwd metadata. Its existing `initialCwd` field is the canonical local source.
- Title priority for a single FreshAgent pane:
  1. User-set tab title.
  2. User-set pane title override.
  3. FreshAgent `initialCwd` last path segment.
  4. FreshAgent label such as `Freshcodex`, `Freshopencode`, or `Freshclaude`.
  5. Existing fallback `Tab`.
- First-message auto-title should mirror legacy `AgentChatView`: set the pane title with `setByUser: false`, and update the tab title only if `tab.titleSetByUser` is false.

---

### Task 1: Unit-Test FreshAgent Tab Name Derivation

**Files:**
- Modify: `test/unit/client/lib/deriveTabName.test.ts`
- Test: `test/unit/client/lib/deriveTabName.test.ts`

- [ ] **Step 1: Write failing FreshAgent deriveTabName tests**

Append these tests inside the existing `describe('deriveTabName', () => { ... })` block:

```ts
  it('returns the last working-directory segment for a fresh-agent pane', () => {
    const layout: PaneNode = {
      type: 'leaf',
      id: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        status: 'idle',
        createRequestId: 'req-1',
        initialCwd: '/home/dan/code/freshell',
      },
    }

    expect(deriveTabName(layout, mockExtensions)).toBe('freshell')
  })

  it('falls back to the fresh-agent label when there is no working directory', () => {
    const layout: PaneNode = {
      type: 'leaf',
      id: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        status: 'idle',
        createRequestId: 'req-1',
      },
    }

    expect(deriveTabName(layout, mockExtensions)).toBe('Freshopencode')
  })
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm run test:vitest -- --run test/unit/client/lib/deriveTabName.test.ts
```

Expected: FAIL. The new tests should currently return `Tab` because `src/lib/deriveTabName.ts` has no `fresh-agent` case.

- [ ] **Step 3: Implement FreshAgent derivation in `deriveTabName`**

Change the imports in `src/lib/deriveTabName.ts` from:

```ts
import type { PaneNode, PaneContent, TerminalPaneContent, BrowserPaneContent } from '../store/paneTypes'
import type { ClientExtensionEntry } from '@shared/extension-types'
import { getProviderLabel, isNonShellMode } from './coding-cli-utils'
```

to:

```ts
import type { PaneNode, PaneContent, TerminalPaneContent, BrowserPaneContent, FreshAgentPaneContent } from '../store/paneTypes'
import type { ClientExtensionEntry } from '@shared/extension-types'
import { getProviderLabel, isNonShellMode } from './coding-cli-utils'
import { getFreshAgentLabel } from './fresh-agent-registry'
```

Add this type guard after `isCli()`:

```ts
/**
 * Check if content is a FreshAgent pane.
 */
function isFreshAgent(content: PaneContent): content is FreshAgentPaneContent {
  return content.kind === 'fresh-agent'
}
```

Update the priority comment above `deriveTabName()` to:

```ts
/**
 * Derives a tab name from pane layout content using priority order:
 * 1. First CLI instance (claude or codex mode terminal)
 * 2. First FreshAgent pane (last directory segment of initialCwd, then agent label)
 * 3. First browser
 * 4. First shell terminal (using last directory segment of initialCwd)
 */
```

Insert this block immediately after the CLI block and before the browser block:

```ts
  // Priority 2: First FreshAgent pane
  const freshAgent = contents.find(isFreshAgent)
  if (freshAgent) {
    if (freshAgent.initialCwd) {
      const segment = extractLastDirSegment(freshAgent.initialCwd)
      if (segment) return segment
    }
    return getFreshAgentLabel(freshAgent.sessionType)
  }
```

Renumber the existing browser, shell, and picker comments so they remain accurate.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
npm run test:vitest -- --run test/unit/client/lib/deriveTabName.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add src/lib/deriveTabName.ts test/unit/client/lib/deriveTabName.test.ts
git commit -m "fix: derive fresh-agent tab names from cwd"
```

---

### Task 2: Prove the Visible TabBar Uses FreshAgent Directory Names

**Files:**
- Modify: `test/unit/client/components/TabBar.deriveTitle.test.tsx`
- Test: `test/unit/client/components/TabBar.deriveTitle.test.tsx`

- [ ] **Step 1: Write a failing visible-tab test**

Append this test near the existing shell-directory derivation test in `test/unit/client/components/TabBar.deriveTitle.test.tsx`:

```tsx
  it('derives the visible tab title from a fresh-agent working directory', () => {
    const store = createStore(
      {
        tabs: [
          {
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Tab 1',
            titleSetByUser: false,
            status: 'running',
            mode: 'shell',
            shell: 'system',
            createdAt: Date.now(),
          },
        ],
        activeTabId: 'tab-1',
      },
      {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'fresh-agent',
              sessionType: 'freshcodex',
              provider: 'codex',
              createRequestId: 'req-1',
              status: 'idle',
              initialCwd: '/home/dan/code/freshell',
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
      },
    )

    render(
      <Provider store={store}>
        <TabBar />
      </Provider>,
    )

    expect(screen.getByText('freshell')).toBeInTheDocument()
    expect(screen.queryByText('Tab 1')).not.toBeInTheDocument()
    expect(screen.queryByText('Freshcodex')).not.toBeInTheDocument()
  })
```

- [ ] **Step 2: Run the focused TabBar test**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/TabBar.deriveTitle.test.tsx
```

Expected after Task 1: PASS. If it fails because `deriveTabName()` did not apply through `getTabDisplayTitle()`, fix the derivation path rather than adding special logic to `TabBar`.

- [ ] **Step 3: Commit Task 2**

Run:

```bash
git add test/unit/client/components/TabBar.deriveTitle.test.tsx
git commit -m "test: cover visible fresh-agent tab naming"
```

---

### Task 3: First-Message Auto-Title for FreshAgent

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentView.tsx`
- Modify: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

- [ ] **Step 1: Extend the FreshAgentView test store with tabs state**

In `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`, add this import near the existing reducer imports:

```ts
import tabsReducer from '@/store/tabsSlice'
```

Change `createStore()` from:

```ts
function createStore() {
  return configureStore({
    reducer: {
      panes: panesReducer,
      settings: settingsReducer,
      freshAgent: freshAgentReducer,
      agentChat: agentChatReducer,
    },
    preloadedState: {
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
    },
  })
}
```

to:

```ts
function createStore(tabTitleSetByUser = false) {
  return configureStore({
    reducer: {
      panes: panesReducer,
      tabs: tabsReducer,
      settings: settingsReducer,
      freshAgent: freshAgentReducer,
      agentChat: agentChatReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{
          id: 'tab-1',
          createRequestId: 'tab-1',
          title: tabTitleSetByUser ? 'Pinned title' : 'Tab 1',
          titleSetByUser: tabTitleSetByUser,
          status: 'running',
          mode: 'shell',
          shell: 'system',
          createdAt: Date.now(),
        }],
        activeTabId: 'tab-1',
      },
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
    },
  })
}
```

- [ ] **Step 2: Write failing first-message auto-title tests**

Add these tests inside `describe('FreshAgentView', () => { ... })`:

```tsx
  it('auto-titles the fresh-agent pane and tab from the first user message', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-auto-title',
        sessionId: 'thread-auto-title',
        status: 'idle',
        initialCwd: '/home/dan/code/freshell',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Codex turn')).toBeInTheDocument()
    })
    wsMock.send.mockClear()

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Research tab naming behavior\nUse existing code paths.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(store.getState().panes.paneTitles['tab-1']?.['pane-1']).toBe('Research tab naming behavior')
    })
    expect(store.getState().panes.paneTitleSetByUser['tab-1']?.['pane-1']).toBe(false)
    expect(store.getState().tabs.tabs[0].title).toBe('Research tab naming behavior')
    expect(store.getState().tabs.tabs[0].titleSetByUser).toBe(false)
    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.send',
      text: 'Research tab naming behavior\nUse existing code paths.',
    }))
  })

  it('does not replace a user-set tab title when auto-titling the first fresh-agent message', async () => {
    const store = createStore(true)
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-auto-title-user-tab',
        sessionId: 'thread-auto-title-user-tab',
        status: 'idle',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Codex turn')).toBeInTheDocument()
    })
    wsMock.send.mockClear()

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Do not override my tab title' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(store.getState().panes.paneTitles['tab-1']?.['pane-1']).toBe('Do not override my tab title')
    })
    expect(store.getState().tabs.tabs[0].title).toBe('Pinned title')
    expect(store.getState().tabs.tabs[0].titleSetByUser).toBe(true)
    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.send',
      text: 'Do not override my tab title',
    }))
  })
```

- [ ] **Step 3: Run the focused FreshAgentView test and verify it fails**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
```

Expected: FAIL. The pane and tab titles should not update yet because `FreshAgentView` does not currently auto-title before `freshAgent.send`.

- [ ] **Step 4: Import title actions and helper in FreshAgentView**

In `src/components/fresh-agent/FreshAgentView.tsx`, change:

```ts
import { consumePaneRefreshRequest, mergePaneContent, updatePaneContent } from '@/store/panesSlice'
```

to:

```ts
import { consumePaneRefreshRequest, mergePaneContent, updatePaneContent, updatePaneTitle } from '@/store/panesSlice'
```

Add these imports near the other store/shared imports:

```ts
import { updateTab } from '@/store/tabsSlice'
import { extractTitleFromMessage } from '@shared/title-utils'
```

- [ ] **Step 5: Read current tab title state in FreshAgentView**

Inside `FreshAgentView`, near the existing selectors, add:

```ts
  const currentTab = useAppSelector((state) => state.tabs.tabs.find((tab) => tab.id === tabId))
  const tabTitleSetByUser = currentTab?.titleSetByUser ?? false
```

If this component already has a nearby `currentTab` selector by the time this plan is executed, reuse it instead of duplicating it.

- [ ] **Step 6: Add the auto-title block before sending**

Replace the existing inline `onSend` body:

```tsx
              onSend={(text) => {
                if (!paneContent.sessionId || !canSend) return
                sendFreshAgentMessage({
                  type: 'freshAgent.send',
                  sessionId: paneContent.sessionId,
                  sessionType: paneContent.sessionType,
                  provider: paneContent.provider,
                  text,
                  settings: {
                    ...(paneContent.initialCwd ? { cwd: paneContent.initialCwd } : {}),
                    ...(getEffectiveFreshAgentModel(paneContent) ? { model: getEffectiveFreshAgentModel(paneContent) } : {}),
                    ...(paneContent.permissionMode ? { permissionMode: paneContent.permissionMode } : {}),
                    ...(paneContent.sandbox ? { sandbox: paneContent.sandbox } : {}),
                    ...(getEffectiveFreshAgentEffort(paneContent) ? { effort: getEffectiveFreshAgentEffort(paneContent) } : {}),
                  },
                })
              }}
```

with:

```tsx
              onSend={(text) => {
                if (!paneContent.sessionId || !canSend) return
                const isFirstMessage = turns.length === 0
                if (isFirstMessage) {
                  const title = extractTitleFromMessage(text)
                  if (title) {
                    dispatch(updatePaneTitle({ tabId, paneId, title, setByUser: false }))
                    if (!tabTitleSetByUser) {
                      dispatch(updateTab({ id: tabId, updates: { title } }))
                    }
                  }
                }
                sendFreshAgentMessage({
                  type: 'freshAgent.send',
                  sessionId: paneContent.sessionId,
                  sessionType: paneContent.sessionType,
                  provider: paneContent.provider,
                  text,
                  settings: {
                    ...(paneContent.initialCwd ? { cwd: paneContent.initialCwd } : {}),
                    ...(getEffectiveFreshAgentModel(paneContent) ? { model: getEffectiveFreshAgentModel(paneContent) } : {}),
                    ...(paneContent.permissionMode ? { permissionMode: paneContent.permissionMode } : {}),
                    ...(paneContent.sandbox ? { sandbox: paneContent.sandbox } : {}),
                    ...(getEffectiveFreshAgentEffort(paneContent) ? { effort: getEffectiveFreshAgentEffort(paneContent) } : {}),
                  },
                })
              }}
```

Then add `tabTitleSetByUser` to the dependency array for the surrounding `useMemo`/callback if TypeScript or lint flags it. Do not add `currentTab` as a dependency if only `tabTitleSetByUser` is used.

- [ ] **Step 7: Run the focused FreshAgentView test and verify it passes**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

Run:

```bash
git add src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git commit -m "fix: auto-title fresh-agent conversations"
```

---

### Task 4: Regression Sweep and PR Update

**Files:**
- Verify: `src/lib/deriveTabName.ts`
- Verify: `src/components/fresh-agent/FreshAgentView.tsx`
- Verify: `test/unit/client/lib/deriveTabName.test.ts`
- Verify: `test/unit/client/components/TabBar.deriveTitle.test.tsx`
- Verify: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

- [ ] **Step 1: Run the narrow regression suite**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/lib/deriveTabName.test.ts \
  test/unit/client/components/TabBar.deriveTitle.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run the existing FreshAgent focused suite**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
  test/unit/client/components/panes/PaneContainer.test.tsx \
  test/unit/client/components/panes/PaneContainer.createContent.test.tsx \
  test/unit/server/fresh-agent/codex-adapter.test.ts \
  test/unit/server/fresh-agent/runtime-manager.test.ts \
  test/unit/server/ws-handler-fresh-agent.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run typecheck and coordinated tests**

Run:

```bash
FRESHELL_TEST_SUMMARY="fresh-agent tab naming" npm run check
```

Expected: PASS. If another agent owns the broad test gate, wait for the coordinator instead of killing anything.

- [ ] **Step 4: Push the PR branch**

Run:

```bash
git push
```

Expected: branch `freshagent-ux-restoration` updates PR #366.

- [ ] **Step 5: Update local integration branches only if requested**

Do not restart the self-hosted `dev` server. If the user asks to land the updated PR head locally again, fast-forward `.worktrees/dev` to the branch head and leave local `main` alone unless they explicitly ask for a mirror refresh.

Expected commands if explicitly requested:

```bash
git -C /home/dan/code/freshell/.worktrees/dev fetch origin
git -C /home/dan/code/freshell/.worktrees/dev merge --ff-only freshagent-ux-restoration
```

---

## Self-Review

1. Spec coverage:
   - Directory-first FreshAgent tab naming is covered by Tasks 1 and 2.
   - Label fallback is covered by Task 1.
   - First-message auto-title parity with legacy `AgentChatView` is covered by Task 3.
   - User-set tab-title preservation is covered by Task 3.
   - PR update and non-interference with self-hosted dev are covered by Task 4.

2. Placeholder scan:
   - No `TBD`, `TODO`, "similar to", or unspecified test instructions remain.
   - Every code-changing step includes exact code or exact replacement guidance.

3. Type consistency:
   - `FreshAgentPaneContent` is imported from `src/store/paneTypes.ts`, where it is already defined.
   - `getFreshAgentLabel()` is imported from `src/lib/fresh-agent-registry.ts`, matching existing `derivePaneTitle.ts` usage.
   - `extractTitleFromMessage()` is imported from `@shared/title-utils`, matching `AgentChatView`.
   - `updatePaneTitle()` and `updateTab()` match existing `AgentChatView` usage.
