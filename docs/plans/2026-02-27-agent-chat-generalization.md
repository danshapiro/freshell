# Agent Chat Generalization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Generalize the `claude-chat` pane type into a provider-configurable `agent-chat` pane, making freshclaude the first provider in a registry that supports different defaults, chrome, and (eventually) harnesses.

**Architecture:** Rename `claude-chat` → `agent-chat` everywhere, add a `provider` field to the pane content, and introduce an `AGENT_CHAT_PROVIDER_CONFIGS` registry (mirroring the terminal pane's `CODING_CLI_PROVIDER_CONFIGS` pattern). Each provider config defines label, defaults (including display toggles), which settings to expose, and the underlying coding CLI provider for directory preferences. User settings are per-provider under `agentChat.providers[name]` (mirroring `codingCli.providers`). No persistence migration — old `claude-chat` panes are dropped on load. The tabs-registry schema accepts both `claude-chat` and `agent-chat` for back-compat with existing JSONL entries. Snapshot payloads include `provider` for round-tripping. The SDK bridge and WS protocol stay unchanged — they're transport-layer concerns.

**Tech Stack:** TypeScript, React, Redux Toolkit, Zod, Vitest

---

## Naming Convention

| Old | New |
|-----|-----|
| `kind: 'claude-chat'` | `kind: 'agent-chat'` |
| `ClaudeChatPaneContent` | `AgentChatPaneContent` |
| `ClaudeChatPaneInput` | `AgentChatPaneInput` |
| `ClaudeChatState` | `AgentChatState` |
| `ClaudeChatView` | `AgentChatView` |
| `FreshclaudeSettings` | `AgentChatSettings` |
| `claudeChat` (Redux slice name) | `agentChat` |
| `claudeChatSlice.ts` | `agentChatSlice.ts` |
| `claudeChatTypes.ts` | `agentChatTypes.ts` |
| `src/components/claude-chat/` | `src/components/agent-chat/` |
| `freshclaude-chat-copy.ts` | `agent-chat-copy.ts` |
| `FreshclaudeChat` (context menu constant) | `AgentChat` |
| `freshclaude` (settings key) | `agentChat` (with `providers` sub-object keyed by provider name) |
| `'claude-web'` (picker type) | removed; providers come from config |
| `test/.../claude-chat/` | `test/.../agent-chat/` |

## What stays unchanged

- `sdk.*` WebSocket messages (transport-layer, not pane-layer)
- `SdkBridge`, `SdkSessionState`, `sdk-bridge.ts` (server SDK code)
- `SdkSessionStatus` type (it describes the SDK protocol, not the pane)
- `sdk-message-handler.ts` (just rename the slice reference)
- Model IDs, permission modes, effort levels (these are provider config values)

---

### Task 1: Create Agent Chat Provider Config Registry

**Files:**
- Create: `src/lib/agent-chat-utils.ts`
- Create: `src/lib/agent-chat-types.ts`
- Create: `test/unit/client/lib/agent-chat-utils.test.ts`

This task creates the provider config registry, mirroring how `CODING_CLI_PROVIDER_CONFIGS` works for terminal panes.

**Step 1: Write the failing test**

```typescript
// test/unit/client/lib/agent-chat-utils.test.ts
import { describe, it, expect } from 'vitest'
import {
  AGENT_CHAT_PROVIDER_CONFIGS,
  AGENT_CHAT_PROVIDERS,
  isAgentChatProviderName,
  getAgentChatProviderConfig,
  getAgentChatProviderLabel,
} from '@/lib/agent-chat-utils'

describe('agent-chat-utils', () => {
  it('exports at least one provider', () => {
    expect(AGENT_CHAT_PROVIDERS.length).toBeGreaterThan(0)
    expect(AGENT_CHAT_PROVIDER_CONFIGS.length).toBeGreaterThan(0)
  })

  it('freshclaude is a valid provider', () => {
    expect(isAgentChatProviderName('freshclaude')).toBe(true)
  })

  it('rejects unknown provider names', () => {
    expect(isAgentChatProviderName('unknown')).toBe(false)
    expect(isAgentChatProviderName(undefined)).toBe(false)
  })

  it('returns config for freshclaude', () => {
    const config = getAgentChatProviderConfig('freshclaude')
    expect(config).toBeDefined()
    expect(config!.label).toBe('freshclaude')
    expect(config!.defaultModel).toBe('claude-opus-4-6')
    expect(config!.defaultPermissionMode).toBe('bypassPermissions')
    expect(config!.defaultEffort).toBe('high')
  })

  it('returns undefined for unknown provider', () => {
    expect(getAgentChatProviderConfig('nope')).toBeUndefined()
  })

  it('returns label for known provider', () => {
    expect(getAgentChatProviderLabel('freshclaude')).toBe('freshclaude')
  })

  it('returns fallback label for unknown provider', () => {
    expect(getAgentChatProviderLabel('nope')).toBe('Agent Chat')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd /home/user/code/freshell/.worktrees/agent-chat && npx vitest run test/unit/client/lib/agent-chat-utils.test.ts`
Expected: FAIL — module not found

**Step 3: Write the types file**

```typescript
// src/lib/agent-chat-types.ts
export type AgentChatProviderName = 'freshclaude'

export interface AgentChatProviderConfig {
  /** Unique identifier for this agent chat provider */
  name: AgentChatProviderName
  /** Display label in UI */
  label: string
  /** Underlying coding CLI provider used for directory preferences and CLI availability checks */
  codingCliProvider: CodingCliProviderName
  /** React component for the pane icon (e.g. FreshclaudeIcon) */
  icon: React.ComponentType<{ className?: string }>
  /** Default model ID */
  defaultModel: string
  /** Default permission mode */
  defaultPermissionMode: string
  /** Default effort level */
  defaultEffort: 'low' | 'medium' | 'high' | 'max'
  /** Default display settings */
  defaultShowThinking: boolean
  defaultShowTools: boolean
  defaultShowTimecodes: boolean
  /** Which settings are visible in the settings popover */
  settingsVisibility: {
    model: boolean
    permissionMode: boolean
    effort: boolean
    thinking: boolean
    tools: boolean
    timecodes: boolean
  }
  /** Keyboard shortcut in pane picker */
  pickerShortcut: string
}
```

**Step 4: Write the utils file**

```typescript
// src/lib/agent-chat-utils.ts
import type { AgentChatProviderName, AgentChatProviderConfig } from './agent-chat-types'

export type { AgentChatProviderName, AgentChatProviderConfig }

export const AGENT_CHAT_PROVIDERS: AgentChatProviderName[] = [
  'freshclaude',
]

export const AGENT_CHAT_PROVIDER_CONFIGS: AgentChatProviderConfig[] = [
  {
    name: 'freshclaude',
    label: 'freshclaude',
    codingCliProvider: 'claude',
    icon: FreshclaudeIcon,  // import from '@/components/icons/provider-icons'
    defaultModel: 'claude-opus-4-6',
    defaultPermissionMode: 'bypassPermissions',
    defaultEffort: 'high',
    defaultShowThinking: true,
    defaultShowTools: true,
    defaultShowTimecodes: false,
    settingsVisibility: {
      model: true,
      permissionMode: true,
      effort: true,
      thinking: true,
      tools: true,
      timecodes: true,
    },
    pickerShortcut: 'A',
  },
]

export function isAgentChatProviderName(value?: string): value is AgentChatProviderName {
  if (!value) return false
  return AGENT_CHAT_PROVIDERS.includes(value as AgentChatProviderName)
}

export function getAgentChatProviderConfig(name?: string): AgentChatProviderConfig | undefined {
  if (!name) return undefined
  return AGENT_CHAT_PROVIDER_CONFIGS.find((c) => c.name === name)
}

export function getAgentChatProviderLabel(name?: string): string {
  const config = getAgentChatProviderConfig(name)
  return config?.label ?? 'Agent Chat'
}
```

**Step 5: Run test to verify it passes**

Run: `cd /home/user/code/freshell/.worktrees/agent-chat && npx vitest run test/unit/client/lib/agent-chat-utils.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
cd /home/user/code/freshell/.worktrees/agent-chat
git add src/lib/agent-chat-types.ts src/lib/agent-chat-utils.ts test/unit/client/lib/agent-chat-utils.test.ts
git commit -m "feat: add agent-chat provider config registry with freshclaude as first provider"
```

---

### Task 2: Rename Types (`paneTypes.ts`, `claudeChatTypes.ts`)

**Files:**
- Modify: `src/store/paneTypes.ts`
- Modify: `src/store/claudeChatTypes.ts` → rename to `src/store/agentChatTypes.ts`

**Step 1: Rename `claudeChatTypes.ts` → `agentChatTypes.ts`**

```bash
cd /home/user/code/freshell/.worktrees/agent-chat
git mv src/store/claudeChatTypes.ts src/store/agentChatTypes.ts
```

In `src/store/agentChatTypes.ts`, rename:
- `ClaudeChatState` → `AgentChatState`
- No other changes needed (ChatContentBlock, ChatMessage, ChatSessionState, PermissionRequest are already generic)

**Step 2: Update `paneTypes.ts`**

- Add `import type { AgentChatProviderName } from '@/lib/agent-chat-types'`
- Rename `ClaudeChatPaneContent` → `AgentChatPaneContent`
- Change `kind: 'claude-chat'` → `kind: 'agent-chat'`
- Add `provider: AgentChatProviderName` field (required)
- Update comment: "freshclaude chat pane" → "Agent chat pane"
- Rename `ClaudeChatPaneInput` → `AgentChatPaneInput`
- Update `PaneContent` union
- Update `PaneContentInput` union

The updated `AgentChatPaneContent`:
```typescript
export type AgentChatPaneContent = {
  kind: 'agent-chat'
  /** Which agent chat provider this pane uses */
  provider: AgentChatProviderName
  sessionId?: string
  createRequestId: string
  status: SdkSessionStatus
  resumeSessionId?: string
  sessionRef?: SessionLocator
  initialCwd?: string
  model?: string
  permissionMode?: string
  effort?: 'low' | 'medium' | 'high' | 'max'
  showThinking?: boolean
  showTools?: boolean
  showTimecodes?: boolean
  settingsDismissed?: boolean
}
```

**Step 3: Run typecheck to see all breakages**

Run: `cd /home/user/code/freshell/.worktrees/agent-chat && npx tsc --noEmit 2>&1 | head -100`
Expected: Many errors — this is expected. They'll be fixed in subsequent tasks.

**Step 4: Commit**

```bash
cd /home/user/code/freshell/.worktrees/agent-chat
git add src/store/agentChatTypes.ts src/store/paneTypes.ts
git add src/store/claudeChatTypes.ts  # git mv tracked the rename
git commit -m "refactor: rename ClaudeChatPaneContent → AgentChatPaneContent, add provider field"
```

---

### Task 3: Rename Redux Slice (`claudeChatSlice.ts` → `agentChatSlice.ts`)

**Files:**
- Modify: `src/store/claudeChatSlice.ts` → rename to `src/store/agentChatSlice.ts`
- Modify: `src/store/store.ts`

**Step 1: Rename the file and update slice internals**

```bash
cd /home/user/code/freshell/.worktrees/agent-chat
git mv src/store/claudeChatSlice.ts src/store/agentChatSlice.ts
```

In `agentChatSlice.ts`:
- Change import from `./claudeChatTypes` → `./agentChatTypes`
- Change `ClaudeChatState` → `AgentChatState`
- Change slice `name: 'claudeChat'` → `name: 'agentChat'`
- Update the default export and named exports as needed

**Step 2: Update `store.ts`**

- Change `import claudeChatReducer from './claudeChatSlice'` → `import agentChatReducer from './agentChatSlice'`
- Change `claudeChat: claudeChatReducer` → `agentChat: agentChatReducer`

**Step 3: Commit**

```bash
cd /home/user/code/freshell/.worktrees/agent-chat
git add src/store/agentChatSlice.ts src/store/store.ts
git commit -m "refactor: rename claudeChat Redux slice → agentChat"
```

---

### Task 4: Rename Component Directory and Files

**Files:**
- Rename: `src/components/claude-chat/` → `src/components/agent-chat/`
- Rename: `ClaudeChatView.tsx` → `AgentChatView.tsx`
- Rename: `FreshclaudeSettings.tsx` → `AgentChatSettings.tsx`
- Rename: `src/components/context-menu/freshclaude-chat-copy.ts` → `src/components/context-menu/agent-chat-copy.ts`

**Step 1: Rename directory and files**

```bash
cd /home/user/code/freshell/.worktrees/agent-chat
git mv src/components/claude-chat src/components/agent-chat
git mv src/components/agent-chat/ClaudeChatView.tsx src/components/agent-chat/AgentChatView.tsx
git mv src/components/agent-chat/FreshclaudeSettings.tsx src/components/agent-chat/AgentChatSettings.tsx
git mv src/components/context-menu/freshclaude-chat-copy.ts src/components/context-menu/agent-chat-copy.ts
```

**Step 2: Update component names and internal references**

In `AgentChatView.tsx`:
- Rename function `ClaudeChatView` → `AgentChatView`
- Rename interface `ClaudeChatViewProps` → `AgentChatViewProps`
- Update import: `ClaudeChatPaneContent` → `AgentChatPaneContent`
- Update import: `from '@/store/claudeChatSlice'` → `from '@/store/agentChatSlice'`
- Update import: `from '@/store/claudeChatTypes'` → `from '@/store/agentChatTypes'`
- Update import: `FreshclaudeSettings` → `AgentChatSettings`
- Update Redux selector: `s.claudeChat.` → `s.agentChat.`
- Update settings API call: `{ freshclaude: defaultsPatch }` → `{ agentChat: { providers: { [provider]: defaultsPatch } } }`
- Update aria-label: `"freshclaude Chat"` → use provider label
- Update data-context: `"freshclaude-chat"` → `"agent-chat"`
- Update welcome text: read from provider config instead of hardcoded "freshclaude"
- Update placeholder: `'Message Claude...'` → provider-aware

In `AgentChatSettings.tsx`:
- Rename function `FreshclaudeSettings` → `AgentChatSettings`
- Rename interface `FreshclaudeSettingsProps` → `AgentChatSettingsProps`
- Update import: `ClaudeChatPaneContent` → `AgentChatPaneContent`
- Update aria-label: `"freshclaude settings"` → `"Agent chat settings"`

In `agent-chat-copy.ts`:
- Rename all `copyFreshclaude*` functions → `copyAgentChat*`

In all other files in the directory (`MessageBubble.tsx`, `PermissionBanner.tsx`, `CollapsedTurn.tsx`, etc.):
- Update any imports from `'@/store/claudeChatTypes'` → `'@/store/agentChatTypes'`
- (Most subcomponents have no claude-specific naming)

**Step 3: Commit**

```bash
cd /home/user/code/freshell/.worktrees/agent-chat
git add -A src/components/agent-chat/ src/components/context-menu/agent-chat-copy.ts
git commit -m "refactor: rename claude-chat components → agent-chat"
```

---

### Task 5: Update All Consumers (Imports, Selectors, References)

This task fixes all the files that import from or reference the old names. Work through the full list systematically.

**Files to modify:**

**Pane system:**
- `src/components/panes/PaneContainer.tsx` — import path, `kind === 'claude-chat'` → `'agent-chat'`, selector `s.claudeChat` → `s.agentChat`
- `src/components/panes/PanePicker.tsx` — remove `'claude-web'` from `PanePickerType`, add agent-chat providers from config
- `src/components/panes/DirectoryPicker.tsx` — remove `'claude-web'` reference
- `src/components/icons/PaneIcon.tsx` — `kind === 'claude-chat'` → `'agent-chat'`

**Lib utilities:**
- `src/lib/derivePaneTitle.ts` — `kind === 'claude-chat'` → `'agent-chat'`, return provider label instead of hardcoded `'freshclaude'`
- `src/lib/session-utils.ts` — `kind === 'claude-chat'` → `'agent-chat'`
- `src/lib/tab-directory-preference.ts` — `kind === 'claude-chat'` → `'agent-chat'`
- `src/lib/tab-registry-snapshot.ts` — rename `case 'claude-chat'` → `case 'agent-chat'`; **also persist `provider` in `stripPanePayload`** so snapshots round-trip correctly (see detail below)
- `src/lib/sdk-message-handler.ts` — `s.claudeChat` → `s.agentChat`, import path update

**Store:**
- `src/store/panesSlice.ts` — `kind === 'claude-chat'` → `'agent-chat'`, add `provider` to normalizeContent

**Context menu:**
- `src/components/context-menu/context-menu-constants.ts` — `FreshclaudeChat: 'freshclaude-chat'` → `AgentChat: 'agent-chat'`
- `src/components/context-menu/context-menu-types.ts` — `kind: 'freshclaude-chat'` → `kind: 'agent-chat'`
- `src/components/context-menu/context-menu-utils.ts` — update references
- `src/components/context-menu/menu-defs.ts` — update references
- `src/components/context-menu/ContextMenuProvider.tsx` — update import path

**Other:**
- `src/components/TabsView.tsx` — `'claude-chat'` → `'agent-chat'`
- `src/App.tsx` — update comment if any

**Settings:**
- `src/store/types.ts` — `freshclaude?:` → `agentChat?: { providers?: ... }` (per-provider structure)
- `src/store/settingsSlice.ts` — `freshclaude: {}` → `agentChat: { providers: {} }`, update `mergeSettings()` to deep-merge providers

**Server:**
- `server/tabs-registry/types.ts` — **ADD** `'agent-chat'` to `RegistryPaneKindSchema` while **keeping** `'claude-chat'` for back-compat with existing JSONL log entries (Zod strict parsing drops records with unknown enum values)

**Step 1: Do a global find-and-replace pass for each pattern**

Work through each file above. For each:
1. Update the import paths
2. Update string literals (`'claude-chat'` → `'agent-chat'`)
3. Update type references (`ClaudeChatPaneContent` → `AgentChatPaneContent`)
4. Update selector paths (`s.claudeChat.` → `s.agentChat.`)

**Key detail in `panesSlice.ts` `normalizeContent()`**: When handling `input.kind === 'agent-chat'`, include the `provider` field:
```typescript
if (input.kind === 'agent-chat') {
  // ... existing sessionRef logic ...
  return {
    kind: 'agent-chat',
    provider: input.provider,  // NEW: propagate provider
    sessionId: input.sessionId,
    createRequestId: input.createRequestId || nanoid(),
    status: input.status || 'creating',
    // ... rest unchanged
  }
}
```

**Key detail in `derivePaneTitle.ts`**: Use provider config for title:
```typescript
if (content.kind === 'agent-chat') {
  return getAgentChatProviderLabel(content.provider)
}
```

**Key detail in `PanePicker.tsx`**: Replace hardcoded `'claude-web'` with provider config:
```typescript
export type PanePickerType = 'shell' | 'cmd' | 'powershell' | 'wsl' | 'browser' | 'editor' | AgentChatProviderName | CodingCliProviderName
```

Build agent-chat picker options from config:
```typescript
const agentChatOptions: PickerOption[] = AGENT_CHAT_PROVIDER_CONFIGS
  .filter((config) => availableClis[config.codingCliProvider] && enabledProviders.includes(config.codingCliProvider))
  .map((config) => ({
    type: config.name as PanePickerType,
    label: config.label,
    icon: null,
    providerName: config.codingCliProvider,
    shortcut: config.pickerShortcut,
  }))
```

**Key detail in `PaneContainer.tsx` `createContentForType()`**: Replace `'claude-web'` handling:
```typescript
if (isAgentChatProviderName(type)) {
  const providerConfig = getAgentChatProviderConfig(type)!
  const providerSettings = settings?.agentChat?.providers?.[type]
  return {
    kind: 'agent-chat',
    provider: type,
    createRequestId: nanoid(),
    status: 'creating',
    model: providerSettings?.defaultModel ?? providerConfig.defaultModel,
    permissionMode: providerSettings?.defaultPermissionMode ?? providerConfig.defaultPermissionMode,
    effort: providerSettings?.defaultEffort ?? providerConfig.defaultEffort,
    ...(cwd ? { initialCwd: cwd } : {}),
  }
}
```

**Key detail in `PaneContainer.tsx` `handleDirectoryConfirm()`**: Fix directory preference mapping. The old code mapped `'claude-web'` → `'claude'` for the `codingCli.providers` settings key. Now use `codingCliProvider` from the provider config:
```typescript
// OLD: const settingsKey = providerType === 'claude-web' ? 'claude' : providerType
// NEW:
const agentConfig = getAgentChatProviderConfig(providerType)
const settingsKey = agentConfig ? agentConfig.codingCliProvider : providerType
```
Similarly update the label derivation:
```typescript
// OLD: const providerLabel = providerType === 'claude-web' ? 'freshclaude' : getProviderLabel(providerType)
// NEW:
const providerLabel = agentConfig ? agentConfig.label : getProviderLabel(providerType)
```

**Key detail in `tab-registry-snapshot.ts` `stripPanePayload()`**: The `provider` field must be persisted in the snapshot payload so that restored agent-chat panes know which provider to use:
```typescript
case 'agent-chat':
  {
    const sessionRef = content.sessionRef
      || (content.resumeSessionId
        ? {
            provider: 'claude',
            sessionId: content.resumeSessionId,
            serverInstanceId,
          }
        : undefined)
    return {
      provider: content.provider,  // REQUIRED: round-trip the provider
      resumeSessionId: content.resumeSessionId,
      sessionRef,
      initialCwd: content.initialCwd,
      model: content.model,
      permissionMode: content.permissionMode,
      effort: content.effort,
    }
  }
```

Consumers that restore panes from snapshots (e.g. `TabsView.tsx` remote tab restore) must read `payload.provider` when constructing `AgentChatPaneContent`. If `payload.provider` is missing (from old `claude-chat` snapshots), default to `'freshclaude'`.

**Step 2: Run typecheck**

Run: `cd /home/user/code/freshell/.worktrees/agent-chat && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
cd /home/user/code/freshell/.worktrees/agent-chat
git add -A
git commit -m "refactor: update all consumers from claude-chat to agent-chat naming"
```

---

### Task 6: Drop Old `claude-chat` Persisted Panes

**Files:**
- Modify: `src/store/persistMiddleware.ts`
- Modify: `src/store/persistedState.ts`
- Modify: `test/unit/client/store/panesPersistence.test.ts`

No data migration — old `claude-chat` panes are simply dropped on load. Users reopen them as `agent-chat` panes.

**Step 1: Write the failing test**

```typescript
// In test/unit/client/store/panesPersistence.test.ts
it('drops claude-chat panes during v4→v5 migration', () => {
  const v4Data = {
    version: 4,
    layouts: {
      tab1: {
        type: 'leaf',
        id: 'pane1',
        content: {
          kind: 'claude-chat',
          createRequestId: 'req1',
          status: 'idle',
          sessionId: 'sess1',
        },
      },
    },
    activePane: {},
    paneTitles: {},
    paneTitleSetByUser: {},
  }
  localStorage.setItem('freshell:panes', JSON.stringify(v4Data))
  const result = loadPersistedPanes()
  // The claude-chat leaf should be replaced with a picker pane
  expect(result!.layouts.tab1.content.kind).toBe('picker')
  expect(result!.version).toBe(5)
})
```

**Step 2: Run test to verify it fails**

Run: `cd /home/user/code/freshell/.worktrees/agent-chat && npx vitest run test/unit/client/store/panesPersistence.test.ts`
Expected: FAIL

**Step 3: Bump `PANES_SCHEMA_VERSION` from 4 to 5 in `persistedState.ts`**

**Step 4: Add v4→v5 migration in `loadPersistedPanesUncached()` in `persistMiddleware.ts`**

Add a new migration block after the existing `currentVersion < 2` block:

```typescript
// Version 4 -> 5: drop claude-chat panes (renamed to agent-chat; no data migration)
if (currentVersion < 5) {
  const droppedLayouts: Record<string, any> = {}
  for (const [tabId, node] of Object.entries(layouts)) {
    droppedLayouts[tabId] = dropClaudeChatNodes(node)
  }
  layouts = droppedLayouts
}
```

Where `dropClaudeChatNodes` recursively walks the tree:
```typescript
function dropClaudeChatNodes(node: any): any {
  if (!node) return node
  if (node.type === 'leaf') {
    if (node.content?.kind === 'claude-chat') {
      return { ...node, content: { kind: 'picker' } }
    }
    return node
  }
  if (node.type === 'split' && Array.isArray(node.children) && node.children.length >= 2) {
    return {
      ...node,
      children: [
        dropClaudeChatNodes(node.children[0]),
        dropClaudeChatNodes(node.children[1]),
      ],
    }
  }
  return node
}
```

**Step 5: Run test to verify it passes**

Run: `cd /home/user/code/freshell/.worktrees/agent-chat && npx vitest run test/unit/client/store/panesPersistence.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
cd /home/user/code/freshell/.worktrees/agent-chat
git add src/store/persistMiddleware.ts src/store/persistedState.ts test/unit/client/store/panesPersistence.test.ts
git commit -m "feat: drop old claude-chat panes during v4→v5 persistence migration"
```

---

### Task 7: Update Settings Key (Client, Server Schema, Config)

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/settingsSlice.ts`
- Modify: `server/settings-router.ts` — **CRITICAL**: rename `freshclaude` → `agentChat` in `SettingsPatchSchema`
- Modify: `server/config-store.ts`

The settings key changes from `freshclaude` to `agentChat`. Without updating the server's Zod schema in `settings-router.ts`, the PATCH endpoint will reject requests with 400.

**Step 1: Update `AppSettings` in `types.ts`**

Settings are **per-provider** to prevent defaults from one provider bleeding into another. This mirrors how `codingCli.providers` works:

```typescript
import type { AgentChatProviderName } from '@/lib/agent-chat-types'

interface AgentChatProviderSettings {
  defaultModel?: string
  defaultPermissionMode?: string
  defaultEffort?: 'low' | 'medium' | 'high' | 'max'
}

// In AppSettings:
agentChat?: {
  providers?: Partial<Record<AgentChatProviderName, AgentChatProviderSettings>>
}
```

**Step 2: Update `defaultSettings` in `settingsSlice.ts`**

```typescript
agentChat: { providers: {} },  // was: freshclaude: {}
```

Update `mergeSettings()` to deep-merge `agentChat.providers` (same pattern as `codingCli.providers`):
```typescript
agentChat: {
  ...baseAgentChat,
  ...(patch.agentChat || {}),
  providers: {
    ...baseAgentChat.providers,
    ...(patch.agentChat?.providers || {}),
  },
},
```

**Step 3: Update `SettingsPatchSchema` in `server/settings-router.ts`**

Replace:
```typescript
    freshclaude: z
      .object({
        defaultModel: z.string().optional(),
        defaultPermissionMode: z.string().optional(),
        defaultEffort: z.enum(['low', 'medium', 'high', 'max']).optional(),
      })
      .strict()
      .optional(),
```
With:
```typescript
    agentChat: z
      .object({
        providers: z.record(
          z.string(),
          z.object({
            defaultModel: z.string().optional(),
            defaultPermissionMode: z.string().optional(),
            defaultEffort: z.enum(['low', 'medium', 'high', 'max']).optional(),
          }).strict(),
        ).optional(),
      })
      .strict()
      .optional(),
```

**Step 4: Add migration in config loading**

In `server/config-store.ts`, when loading `~/.freshell/config.json`, if the loaded config has a `freshclaude` key but no `agentChat` key, migrate:
```typescript
// Migrate flat freshclaude → nested agentChat.providers.freshclaude
if (config.freshclaude && !config.agentChat) {
  config.agentChat = { providers: { freshclaude: config.freshclaude } }
  delete config.freshclaude
}
```
This is a one-time migration — the old flat settings become the freshclaude provider's defaults.

**Step 5: Update the settings PATCH handler in `AgentChatView`**

Already done in Task 5 (`{ freshclaude: ... }` → `{ agentChat: ... }`).

**Step 6: Run tests**

Run: `cd /home/user/code/freshell/.worktrees/agent-chat && npx vitest run test/unit/client/store/settingsSlice.test.ts test/unit/server/config-store.test.ts test/integration/server/settings-api.test.ts`
Expected: PASS (update test expectations as needed — the integration test validates that the PATCH endpoint accepts the new `agentChat` key and rejects the old `freshclaude` key)

**Step 7: Commit**

```bash
cd /home/user/code/freshell/.worktrees/agent-chat
git add src/store/types.ts src/store/settingsSlice.ts server/settings-router.ts server/config-store.ts test/...
git commit -m "refactor: rename freshclaude settings key → agentChat (client + server schema + config migration)"
```

---

### Task 8: Make AgentChatView Provider-Aware

**Files:**
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx`

Now that the provider config exists, make the component read defaults from it instead of hardcoding them.

**Step 1: Write the failing test**

```typescript
it('uses provider config defaults when pane fields are unset', () => {
  // Render AgentChatView with provider='freshclaude' and no model/permissionMode/effort set
  // Verify sdk.create is called with freshclaude defaults from config
})
```

**Step 2: Update `AgentChatView.tsx`**

Replace hardcoded constants:
```typescript
// OLD:
const DEFAULT_MODEL = 'claude-opus-4-6'
const DEFAULT_PERMISSION_MODE = 'bypassPermissions'
const DEFAULT_EFFORT = 'high'

// NEW:
import { getAgentChatProviderConfig } from '@/lib/agent-chat-utils'
// ...inside component:
const providerConfig = getAgentChatProviderConfig(paneContent.provider)
const defaultModel = providerConfig?.defaultModel ?? 'claude-opus-4-6'
const defaultPermissionMode = providerConfig?.defaultPermissionMode ?? 'bypassPermissions'
const defaultEffort = providerConfig?.defaultEffort ?? 'high'
```

Also wire display defaults from the provider config. These are used to initialize display toggles when no per-pane override exists:
```typescript
const defaultShowThinking = providerConfig?.defaultShowThinking ?? true
const defaultShowTools = providerConfig?.defaultShowTools ?? true
const defaultShowTimecodes = providerConfig?.defaultShowTimecodes ?? false
```

Use these as fallbacks when the pane content's `showThinking`/`showTools`/`showTimecodes` fields are `undefined`.

Update welcome message to use provider label:
```typescript
<p className="font-medium mb-2">{providerConfig?.label ?? 'Agent Chat'}</p>
<p>Rich chat UI for AI agent sessions.</p>
```

Update placeholder:
```typescript
placeholder={isInteractive ? `Message ${providerConfig?.label ?? 'agent'}...` : 'Waiting for connection...'}
```

**Step 3: Run test to verify it passes**

Run: `cd /home/user/code/freshell/.worktrees/agent-chat && npx vitest run test/unit/client/components/agent-chat/`
Expected: PASS

**Step 4: Commit**

```bash
cd /home/user/code/freshell/.worktrees/agent-chat
git add src/components/agent-chat/AgentChatView.tsx test/...
git commit -m "feat: AgentChatView reads defaults from provider config"
```

---

### Task 9: Make AgentChatSettings Provider-Aware

**Files:**
- Modify: `src/components/agent-chat/AgentChatSettings.tsx`
- Modify: `test/unit/client/components/agent-chat/AgentChatSettings.test.tsx` (renamed from FreshclaudeSettings.test.tsx)

**Step 1: Add `settingsVisibility` prop**

```typescript
interface AgentChatSettingsProps {
  // ...existing props...
  settingsVisibility?: AgentChatProviderConfig['settingsVisibility']
}
```

**Step 2: Conditionally render settings based on visibility**

```typescript
{settingsVisibility?.model !== false && (
  <div className="space-y-1">
    <label ...>Model</label>
    <select ...> ... </select>
  </div>
)}
```

Do the same for permissionMode, effort, thinking, tools, timecodes.

**Step 3: Wire from AgentChatView**

```typescript
<AgentChatSettings
  ...
  settingsVisibility={providerConfig?.settingsVisibility}
/>
```

**Step 4: Write test**

```typescript
it('hides effort setting when settingsVisibility.effort is false', () => {
  render(<AgentChatSettings ... settingsVisibility={{ ...allTrue, effort: false }} />)
  expect(screen.queryByLabelText('Effort')).not.toBeInTheDocument()
})
```

**Step 5: Run tests**

Expected: PASS

**Step 6: Commit**

```bash
cd /home/user/code/freshell/.worktrees/agent-chat
git add src/components/agent-chat/AgentChatSettings.tsx test/...
git commit -m "feat: AgentChatSettings conditionally shows settings based on provider config"
```

---

### Task 10: Rename and Update All Test Files

**Files (rename):**
- `test/unit/client/claudeChatSlice.test.ts` → `test/unit/client/agentChatSlice.test.ts`
- `test/unit/client/components/claude-chat/` → `test/unit/client/components/agent-chat/`
- `test/unit/client/components/context-menu/freshclaude-chat-actions.test.ts` → `...agent-chat-actions.test.ts`
- `test/e2e/claude-chat-polish-flow.test.tsx` → `test/e2e/agent-chat-polish-flow.test.tsx`
- `test/e2e/freshclaude-context-menu-flow.test.tsx` → `test/e2e/agent-chat-context-menu-flow.test.tsx`

**For each test file:**
1. `git mv` to new path
2. Update imports (component paths, slice paths, type paths)
3. Update string literals (`'claude-chat'` → `'agent-chat'`, `'freshclaude'` → provider label)
4. Update Redux state references (`state.claudeChat` → `state.agentChat`)
5. Add `provider: 'freshclaude'` to any test fixtures that create `AgentChatPaneContent`

**Step 1: Rename all test files**

```bash
cd /home/user/code/freshell/.worktrees/agent-chat
git mv test/unit/client/claudeChatSlice.test.ts test/unit/client/agentChatSlice.test.ts
git mv test/unit/client/components/claude-chat test/unit/client/components/agent-chat
git mv test/unit/client/components/context-menu/freshclaude-chat-actions.test.ts test/unit/client/components/context-menu/agent-chat-actions.test.ts
git mv test/e2e/claude-chat-polish-flow.test.tsx test/e2e/agent-chat-polish-flow.test.tsx
git mv test/e2e/freshclaude-context-menu-flow.test.tsx test/e2e/agent-chat-context-menu-flow.test.tsx
```

**Step 2: Update all test contents**

Systematic find-and-replace within each file:
- `claude-chat` → `agent-chat` (string literals)
- `ClaudeChat` → `AgentChat` (type/component names)
- `claudeChat` → `agentChat` (slice/selector names)
- `FreshclaudeSettings` → `AgentChatSettings` (component name)
- `freshclaude-chat` → `agent-chat` (context menu IDs)
- `freshclaude` → `freshclaude` (keep as provider label where appropriate)
- Add `provider: 'freshclaude'` to all test pane content fixtures

Also update test files that reference claude-chat but aren't in the claude-chat directory:
- `test/unit/client/sdk-message-handler.test.ts` — update slice reference
- `test/unit/client/store/settingsSlice.test.ts` — update settings key
- `test/unit/client/components/icons/PaneIcon.test.tsx` — update kind
- `test/unit/client/components/panes/PanePicker.test.tsx` — update picker type
- `test/unit/client/lib/derivePaneTitle.test.ts` — update kind
- `test/unit/client/lib/session-utils.test.ts` — update kind
- `test/unit/client/lib/tab-directory-preference.test.ts` — update kind
- `test/unit/client/components/ContextMenuProvider.test.tsx` — update references
- `test/unit/client/ws-client-sdk.test.ts` — update selector
- `test/unit/server/config-store.test.ts` — update settings key
- `test/e2e/sidebar-click-opens-pane.test.tsx` — update references

**Step 3: Run full test suite**

Run: `cd /home/user/code/freshell/.worktrees/agent-chat && npm test`
Expected: ALL PASS

**Step 4: Commit**

```bash
cd /home/user/code/freshell/.worktrees/agent-chat
git add -A
git commit -m "refactor: rename all test files from claude-chat to agent-chat"
```

---

### Task 11: PaneIcon Provider-Aware Rendering

**Files:**
- Modify: `src/components/icons/PaneIcon.tsx`
- Modify: `test/unit/client/components/icons/PaneIcon.test.tsx`

**Step 1: Update PaneIcon to look up icon from provider config**

Since `AgentChatProviderConfig` now has an `icon` field, use it:

```typescript
if (content.kind === 'agent-chat') {
  const config = getAgentChatProviderConfig(content.provider)
  if (config) {
    const Icon = config.icon
    return <Icon className={className} />
  }
  // Fallback for unknown provider
  return <LayoutGrid className={className} />
}
```

**Step 2: Update test**

**Step 3: Commit**

```bash
cd /home/user/code/freshell/.worktrees/agent-chat
git add src/components/icons/PaneIcon.tsx test/...
git commit -m "refactor: PaneIcon handles agent-chat kind"
```

---

### Task 12: Final Verification

**Step 1: Run full typecheck**

Run: `cd /home/user/code/freshell/.worktrees/agent-chat && npx tsc --noEmit`
Expected: No errors

**Step 2: Run full test suite**

Run: `cd /home/user/code/freshell/.worktrees/agent-chat && npm test`
Expected: ALL PASS

**Step 3: Run lint**

Run: `cd /home/user/code/freshell/.worktrees/agent-chat && npm run lint`
Expected: No errors (or only pre-existing ones)

**Step 4: Grep for any remaining old references**

```bash
cd /home/user/code/freshell/.worktrees/agent-chat
grep -rn 'claude-chat\|ClaudeChat\|claudeChat\|FreshclaudeSettings\|freshclaude-chat' src/ server/ shared/ test/ --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v '.worktrees'
```

Expected: Zero matches (except possibly comments mentioning the migration)

Note: `freshclaude` as a provider name/label is expected and correct. Only the old structural names should be gone.

**Step 5: Final commit if any fixups needed**

```bash
cd /home/user/code/freshell/.worktrees/agent-chat
git add -A
git commit -m "chore: clean up remaining claude-chat references"
```

---

## Summary of All Files Changed

### New files (3):
- `src/lib/agent-chat-types.ts`
- `src/lib/agent-chat-utils.ts`
- `test/unit/client/lib/agent-chat-utils.test.ts`

### Renamed files (source, ~15):
- `src/store/claudeChatTypes.ts` → `agentChatTypes.ts`
- `src/store/claudeChatSlice.ts` → `agentChatSlice.ts`
- `src/components/claude-chat/` → `agent-chat/` (directory)
- `src/components/agent-chat/ClaudeChatView.tsx` → `AgentChatView.tsx`
- `src/components/agent-chat/FreshclaudeSettings.tsx` → `AgentChatSettings.tsx`
- `src/components/context-menu/freshclaude-chat-copy.ts` → `agent-chat-copy.ts`

### Modified files (source, ~20):
- `src/store/paneTypes.ts`
- `src/store/store.ts`
- `src/store/panesSlice.ts`
- `src/store/types.ts`
- `src/store/settingsSlice.ts`
- `src/store/persistMiddleware.ts`
- `src/store/persistedState.ts`
- `src/components/panes/PaneContainer.tsx`
- `src/components/panes/PanePicker.tsx`
- `src/components/panes/DirectoryPicker.tsx`
- `src/components/icons/PaneIcon.tsx`
- `src/components/context-menu/context-menu-constants.ts`
- `src/components/context-menu/context-menu-types.ts`
- `src/components/context-menu/context-menu-utils.ts`
- `src/components/context-menu/menu-defs.ts`
- `src/components/context-menu/ContextMenuProvider.tsx`
- `src/components/TabsView.tsx`
- `src/lib/derivePaneTitle.ts`
- `src/lib/session-utils.ts`
- `src/lib/tab-directory-preference.ts`
- `src/lib/tab-registry-snapshot.ts`
- `src/lib/sdk-message-handler.ts`
- `server/tabs-registry/types.ts`
- `server/settings-router.ts`
- `server/config-store.ts`

### Renamed test files (~15):
- `test/unit/client/claudeChatSlice.test.ts` → `agentChatSlice.test.ts`
- `test/unit/client/components/claude-chat/` → `agent-chat/` (entire directory, 14 files)
- `test/unit/client/components/context-menu/freshclaude-chat-actions.test.ts` → `agent-chat-actions.test.ts`
- `test/e2e/claude-chat-polish-flow.test.tsx` → `agent-chat-polish-flow.test.tsx`
- `test/e2e/freshclaude-context-menu-flow.test.tsx` → `agent-chat-context-menu-flow.test.tsx`

### Modified test files (~12):
- All test files referencing `claudeChat`, `claude-chat`, `ClaudeChat`, `freshclaude-chat`, or `FreshclaudeSettings`
