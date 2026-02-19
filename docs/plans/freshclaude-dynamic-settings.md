# Freshclaude Dynamic Settings

## Context

Model and permissions dropdowns in freshclaude settings are disabled once a session starts. The SDK actually supports `query.setModel()` and `query.setPermissionMode()` mid-session, but the Freshell plumbing doesn't expose them. Additionally, there's no effort setting, no persistent defaults, and the model list is hardcoded.

## Scope

1. **Model** — changeable mid-session + persistent default
2. **Permission mode** — changeable mid-session + persistent default
3. **Effort** — creation-time only + persistent default (no `setEffort()` on SDK Query)
4. **Dynamic model list** — from `query.supportedModels()` instead of hardcoded

## Implementation

### Step 1: Persistent defaults infrastructure

Add `freshclaude` key to AppSettings on both server and client.

**`server/config-store.ts`**
- Add to `AppSettings` type:
  ```ts
  freshclaude?: {
    defaultModel?: string
    defaultPermissionMode?: string
    defaultEffort?: 'low' | 'medium' | 'high' | 'max'
  }
  ```
- Add to `mergeSettings()` (line 295): `freshclaude: { ...base.freshclaude, ...(patch.freshclaude || {}) }`
- Add to `defaultSettings` (line 110): `freshclaude: {}`

**`src/store/types.ts`**
- Add same `freshclaude?` field to client-side `AppSettings` interface (line 120)

**`src/store/settingsSlice.ts`**
- Add `freshclaude: {}` to `defaultSettings` (line 8)

**`src/store/paneTypes.ts`**
- Add `effort?: 'low' | 'medium' | 'high' | 'max'` to `ClaudeChatPaneContent` (line 64)

**`src/components/panes/PaneContainer.tsx`**
- In `createContentForType` for `claude-web` (line 411), read defaults from settings:
  ```ts
  const defaults = settings?.freshclaude
  return {
    kind: 'claude-chat',
    createRequestId: nanoid(),
    status: 'creating',
    model: defaults?.defaultModel,
    permissionMode: defaults?.defaultPermissionMode,
    effort: defaults?.defaultEffort,
    ...(cwd ? { initialCwd: cwd } : {}),
  }
  ```

### Step 2: Effort setting (creation-time only)

**`server/sdk-bridge-types.ts`**
- Add `effort: z.enum(['low', 'medium', 'high', 'max']).optional()` to `SdkCreateSchema` (line 73)

**`server/sdk-bridge.ts`**
- Add `effort?` to `createSession` options (line 42)
- Pass `effort: options.effort` to SDK `query()` options (line 74)

**`server/ws-handler.ts`**
- Pass `effort: m.effort` in `sdk.create` handler (around line 1507)

**`src/components/claude-chat/ClaudeChatView.tsx`**
- Add `DEFAULT_EFFORT = 'high'` constant
- Include `effort: paneContent.effort ?? DEFAULT_EFFORT` in `sdk.create` send (line 82)
- Pass `effort` prop to `FreshclaudeSettings` (line 265)

**`src/components/claude-chat/FreshclaudeSettings.tsx`**
- Add `effort` to `SettingsFields` Pick type (line 7)
- Add `effort: string` prop
- Add `EFFORT_OPTIONS` constant: `[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'max', label: 'Max' }]`
- Add effort dropdown, `disabled={sessionStarted}` (effort IS locked after start)

### Step 3: Mid-session model + permission mode change

**`server/sdk-bridge-types.ts`**
- Add new schemas:
  ```ts
  export const SdkSetModelSchema = z.object({
    type: z.literal('sdk.set-model'),
    sessionId: z.string().min(1),
    model: z.string().min(1),
  })
  export const SdkSetPermissionModeSchema = z.object({
    type: z.literal('sdk.set-permission-mode'),
    sessionId: z.string().min(1),
    permissionMode: z.string().min(1),
  })
  ```
- Add both to `BrowserSdkMessageSchema` discriminated union (line 118)

**`server/sdk-bridge.ts`**
- Add `setModel(sessionId, model)` method (follows `interrupt()` pattern):
  ```ts
  setModel(sessionId: string, model: string): boolean {
    const sp = this.processes.get(sessionId)
    if (!sp) return false
    const state = this.sessions.get(sessionId)
    if (state) state.model = model
    sp.query.setModel(model).catch(err => log.warn({ sessionId, err }, 'setModel failed'))
    return true
  }
  ```
- Add `setPermissionMode(sessionId, mode)` — same pattern with `sp.query.setPermissionMode(mode as any)`

**`server/ws-handler.ts`**
- Add `sdk.set-model` case: validate sdkBridge, validate ownership, call `sdkBridge.setModel(m.sessionId, m.model)`
- Add `sdk.set-permission-mode` case: same pattern with `sdkBridge.setPermissionMode()`

**`src/components/claude-chat/FreshclaudeSettings.tsx`**
- Remove `disabled={sessionStarted}` from model and permission mode dropdowns
- Keep `disabled={sessionStarted}` on effort dropdown only

**`src/components/claude-chat/ClaudeChatView.tsx`**
- Update `handleSettingsChange` to:
  1. Update pane content in Redux (existing behavior)
  2. If model changed and session is active, send `sdk.set-model` WS message
  3. If permissionMode changed and session is active, send `sdk.set-permission-mode` WS message
  4. Persist any of model/permissionMode/effort changes as defaults via `api.patch('/api/settings', { freshclaude: { ... } })`

### Step 4: Dynamic model list from SDK

**`server/sdk-bridge.ts`**
- Add `private cachedModels: Array<{ value: string; displayName: string; description: string }> | null = null`
- In `handleSdkMessage` → `system/init` case (line 205), after broadcasting `sdk.session.init`, call `sp.query.supportedModels()` and broadcast result as `sdk.models`
- Cache the result; subsequent sessions use cache immediately

**`server/sdk-bridge-types.ts`**
- Add to `SdkServerMessage` union:
  ```ts
  | { type: 'sdk.models'; sessionId: string; models: Array<{ value: string; displayName: string; description: string }> }
  ```

**`src/store/claudeChatTypes.ts`**
- Add `availableModels: Array<{ value: string; displayName: string; description: string }>` to `ClaudeChatState`

**`src/store/claudeChatSlice.ts`**
- Add `availableModels: []` to initial state
- Add `setAvailableModels` reducer

**`src/lib/sdk-message-handler.ts`**
- Handle `sdk.models` → dispatch `setAvailableModels`

**`src/components/claude-chat/FreshclaudeSettings.tsx`**
- Accept `modelOptions?: Array<{ value: string; displayName: string }>` prop
- Use dynamic options when available, fall back to hardcoded `MODEL_OPTIONS`

**`src/components/claude-chat/ClaudeChatView.tsx`**
- Read `availableModels` from Redux, pass as `modelOptions` to `FreshclaudeSettings`

## Test Plan

Each step follows TDD (red-green-refactor). Tests before implementation.

**Server unit tests:**
- `sdk-bridge-types` schemas: validate new schemas (SdkSetModel, SdkSetPermissionMode, effort on SdkCreate)
- `sdk-bridge`: setModel/setPermissionMode call query methods, update state, return false for unknown sessions; supportedModels caching and broadcast
- `ws-handler-sdk`: new message types route correctly, reject for unowned sessions
- `config-store`: mergeSettings handles `freshclaude` key

**Client unit tests:**
- `sdk-message-handler`: `sdk.models` dispatches `setAvailableModels`
- `claudeChatSlice`: `setAvailableModels` populates state
- `FreshclaudeSettings`: effort dropdown renders; model/permissionMode NOT disabled mid-session; dynamic model options used when provided

**Verification:**
1. `npm test` — all unit tests pass
2. `npm run verify` — build + test (catches type errors)
3. Manual: open freshclaude, change model mid-session, verify next response uses new model
4. Manual: open new freshclaude pane, verify it inherits previously-set defaults
