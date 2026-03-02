# Freshclaude Plugin Injection

## Problem

Freshclaude sessions need to load specific skills (via plugins) at creation time. The immediate use case is ensuring every freshclaude session has `freshell-orchestration` available. The future use case is custom pane types (e.g., "kilroy") that wrap freshclaude and inject skills from external repos.

## Design

### Data Flow

```
ClaudeChatPaneContent.plugins: string[]    (absolute paths)
  → sdk.create WS message.plugins          (passed over websocket)
  → sdkBridge.createSession(options)       (server receives)
  → query({ options: { plugins } })        (SDK loads them)
```

### Changes by Layer

**1. `ClaudeChatPaneContent`** (`src/store/paneTypes.ts`)
- Add `plugins?: string[]` — array of absolute paths to plugin directories

**2. `AppSettings.freshclaude`** (`src/store/types.ts`)
- Add `defaultPlugins?: string[]` — default plugin paths for new sessions
- Server resolves `freshell-orchestration` to its absolute path as the fallback default

**3. WS Protocol** (`shared/ws-protocol.ts`)
- Add `plugins: z.array(z.string()).optional()` to `SdkCreateSchema`

**4. `SdkBridge.createSession()`** (`server/sdk-bridge.ts`)
- Accept `plugins?: string[]` in options
- Map to `plugins: paths.map(p => ({ type: 'local' as const, path: p }))` in the `query()` call
- Default: `[path.resolve(projectRoot, '.claude/plugins/freshell-orchestration')]`

**5. WS Handler** (`server/ws-handler.ts`)
- Pass `m.plugins` through to `sdkBridge.createSession()`

**6. Client creation flow** (`src/components/panes/PaneContainer.tsx`)
- `createContentForType('claude-web')` includes `plugins` from settings defaults

**7. `ClaudeChatView`** (`src/components/claude-chat/ClaudeChatView.tsx`)
- Include `paneContent.plugins` in the `sdk.create` message

### Out of Scope

- UI for editing plugins list (future — kilroy pane type would set this programmatically)
- Name-based resolution (future — for now, absolute paths only)
- CLI support for plugins parameter (future)

### Default Behavior

- Every freshclaude session gets `freshell-orchestration` loaded by default
- This is additive — the session still discovers project-level skills from its CWD normally
