# Pane Extension System Architecture

**Date:** 2026-02-28
**Author:** Justin Choo + Claude
**Status:** Draft / RFC
**First test case:** kilroy-run-pane

## Decisions Log

Decisions made during architectural review (2026-02-28):

- **CLI panes are a full extension category** — not a lightweight picker shortcut. All three categories (client, server, CLI) are first-class.
- **Manifest validation is required** — freshell must validate `freshell.json` against a schema on discovery. Invalid manifests are rejected with clear error messages.
- **Built-in panes stay hardcoded for V1** — existing pane types (terminal, browser, editor, picker, agent-chat) are not migrated to the extension system yet. Future consideration: ship them as extensions in freshell's repo `extensions/` dir so they stay in sync.
- **Installation is manual drop-folder for V1** — user places a pre-built, ready-to-run extension folder into `~/.freshell/extensions/`. Freshell does NOT build, install deps, or clone repos. How the folder gets there and how it was built is the user's/developer's concern.
- **Communication protocol is post-MVP** — V1 has no `postMessage` protocol between freshell and extension iframes. Server panes are self-contained. Client panes get initial props only.
- **Phase 1-2 is the immediate scope** — build the extension infrastructure, then validate with kilroy-run-pane as the first server extension.

## 1. Problem Statement

Freshell currently has 5 hardcoded pane types (terminal, browser, editor, picker, agent-chat). Adding a new pane type requires modifying 10+ files across the codebase: type definitions, Redux reducers, render switches, picker options, icons, titles, action registries, and server-side types.

Dan's vision (from 2026-02-26 meeting): a folder you drop into an extensions directory that defines a new pane type — icon, server process (optional), HTML to render, and metadata. This enables the ecosystem to grow without modifying freshell core.

### Motivating use cases

- **Kilroy Run Viewer** — server pane that watches pipeline runs on disk, streams updates via SSE, renders DAG visualization (first test case, already exists as standalone app)
- **Graphviz DOT Viewer** — client-only pane that renders `.dot` files using WASM-compiled Graphviz
- **Mermaid Chart Viewer** — client-only pane for rendering Mermaid diagrams
- **Custom CLI tools** — CLI panes wrapping tools like `lazygit`, `k9s`, etc.

### Context: Kilroy in freshell

Kilroy itself integrates into freshell as a freshclaude instance (agent-chat pane with Kilroy skills preloaded). The Kilroy Run Viewer is a **separate pane** that sits alongside the Kilroy orchestrator, showing pipeline execution progress in real-time. These are independent — the viewer is useful with or without a live Kilroy session.

## 2. Pane Categories

Three categories, all first-class extension types:

### 2a. Client-only panes

Pure frontend — an HTML/JS bundle loaded into an iframe. No server process needed.

- **Examples:** DOT viewer, Mermaid charts, Markdown preview, JSON viewer
- **Rendering:** iframe pointing at a local HTML file served by freshell
- **Data flow:** freshell passes initial props; no ongoing communication in V1
- **Lifecycle:** load iframe on open, dispose on close

### 2b. Server panes

A server process that freshell manages, serving HTML that gets embedded in an iframe.

- **Examples:** kilroy-run-pane, LibreChat, any tool with its own web UI
- **Rendering:** iframe pointing at `http://localhost:{port}/`
- **Data flow:** the pane's own server handles all data; freshell just manages the process
- **Lifecycle:** freshell starts the server on first pane open, stops it when last pane of that type closes (or on freshell exit)

### 2c. CLI panes

A terminal running a specific CLI command. This is a specialization of the existing terminal pane.

- **Examples:** `lazygit`, `k9s`, `btop`, custom dev tools
- **Rendering:** xterm.js (reuses existing terminal infrastructure)
- **Data flow:** PTY stdin/stdout
- **Lifecycle:** spawn on open, SIGHUP on close

## 3. Extension Manifest

Each extension lives in its own directory and contains a `freshell.json` manifest. The extension folder must be **pre-built and ready to run** — freshell does not run install or build steps.

```
~/.freshell/extensions/kilroy-run-pane/
├── freshell.json          # Extension manifest (required)
├── icon.svg               # Pane icon (SVG)
├── dist/                  # Pre-built client assets (client/server panes)
│   ├── index.html         # Client entry (client-only panes)
│   └── ...
├── dist-server/           # Pre-built server (server panes)
│   └── index.js
├── package.json           # (informational only — freshell doesn't use it)
└── node_modules/          # Pre-installed deps (if needed by server)
```

### freshell.json schema

Freshell validates this manifest against a JSON schema on discovery. Only the config block matching `category` is required; others are ignored.

```jsonc
{
  // === Required fields ===
  "name": "kilroy-run-pane",
  "version": "0.1.0",
  "label": "Kilroy Run Viewer",
  "description": "View Kilroy pipeline runs with DAG visualization",
  "category": "server",           // "client" | "server" | "cli"

  // === Icon ===
  "icon": "./icon.svg",           // relative path to SVG icon

  // === Client pane config (required when category: "client") ===
  "client": {
    "entry": "./dist/index.html"  // HTML entry point, served by freshell
  },

  // === Server pane config (required when category: "server") ===
  "server": {
    "command": "node",            // command to start server
    "args": ["dist-server/index.js"],
    "env": {                      // env vars freshell sets for the server
      "PORT": "{{port}}"          // freshell injects allocated port
    },
    "readyPattern": "Listening on",  // stdout pattern = server is ready
    "readyTimeout": 10000,        // ms before giving up on startup
    "healthCheck": "/api/health", // optional HTTP health endpoint
    "singleton": true             // one server instance for all panes of this type
  },

  // === CLI pane config (required when category: "cli") ===
  "cli": {
    "command": "lazygit",
    "args": [],
    "env": {}
  },

  // === Pane URL template (client & server panes) ===
  "url": "/run/{{runId}}",        // appended to server base URL or local file server

  // === Content schema: what data the pane needs from freshell ===
  "contentSchema": {
    "runId": {
      "type": "string",
      "label": "Run ID",
      "required": true
    },
    "runsDir": {
      "type": "string",
      "label": "Runs directory",
      "default": "~/.local/state/kilroy/attractor/runs"
    }
  },

  // === Picker config ===
  "picker": {
    "shortcut": "K",              // keyboard shortcut in picker
    "group": "tools"              // picker section: "tools", "viewers", etc.
  }
}
```

### Manifest validation

On discovery, freshell validates each `freshell.json`:
- Required fields present (`name`, `version`, `label`, `description`, `category`)
- `category` is one of: `client`, `server`, `cli`
- The matching config block exists (e.g., `server` block for `category: "server"`)
- For server panes: `command` is required
- For client panes: `entry` is required and the file exists
- For CLI panes: `command` is required
- No duplicate `name` across installed extensions
- Invalid manifests are skipped with a warning logged to console

### Template variables

The `url` field and `server.env` values support `{{variable}}` interpolation:
- `{{port}}` — the port freshell allocated for this server
- Any key from `contentSchema` (e.g., `{{runId}}`)

## 4. Extension Discovery & Loading

### 4a. Extension locations

Freshell scans these locations on startup (in order):

1. **User extensions:** `~/.freshell/extensions/` — user-installed
2. **Local dev extensions:** `.freshell/extensions/` in the current working directory — for development

Built-in pane types (terminal, browser, editor, picker, agent-chat) remain hardcoded for V1 and are not loaded through the extension system.

> **Future consideration:** Ship built-in panes as extensions in `<freshell>/extensions/` so they use the same loading path. Requires a mechanism to keep them in sync with freshell releases.

### 4b. Discovery flow

```
Startup:
  1. Scan extension directories for subdirectories containing freshell.json
  2. Read and validate each freshell.json against schema
  3. Skip invalid manifests (log warning)
  4. Build extension registry (name → manifest + path)
  5. Send registry to frontend via WebSocket
  6. Frontend populates pane picker with discovered extensions
```

### 4c. Lazy activation

Extensions are NOT loaded until a pane of that type is opened:
- **Client panes:** iframe created on demand
- **Server panes:** server process spawned on first pane open
- **CLI panes:** PTY spawned on open (already how terminals work)

## 5. Installation

### V1: Manual drop-folder

The user places a pre-built extension folder into `~/.freshell/extensions/`. Freshell discovers it on next startup (or via a "Refresh extensions" action).

The extension must be ready to run — all dependencies installed, all build artifacts present. How the user obtains and prepares the extension is outside freshell's scope for V1.

Examples of how an extension might end up in the directory:

```bash
# Developer working locally — symlink to their checkout
ln -s ~/code/kilroy-run-pane ~/.freshell/extensions/kilroy-run-pane

# User downloading a release
cd ~/.freshell/extensions/
unzip kilroy-run-pane-v0.1.0.zip

# User cloning and building themselves
cd ~/.freshell/extensions/
git clone https://github.com/park9140/kilroy-run-pane.git
cd kilroy-run-pane && npm install && npm run build
```

### First-run experience

When a user opens a pane type that requires configuration (e.g., kilroy-run-pane needs `KILROY_RUNS_DIR`):

1. Freshell shows a setup prompt within the pane area, driven by `contentSchema`
2. User fills in required fields (fields with `default` values are pre-populated)
3. Freshell saves defaults to `~/.freshell/extension-settings/{name}.json`
4. Subsequent opens use saved defaults (user can override per-pane)

### Future: Automated installation

Post-V1, we may add:
- `freshell extension install <url|name>` CLI command
- Marketplace / curated registry for official and community extensions
- Auto-update mechanism

These are out of scope for the initial implementation.

## 6. Server Pane Lifecycle Management

### 6a. Process management

```
Pane opened (first of this type):
  1. Allocate port (scan for free port starting from manifest default)
  2. Set env vars (PORT={{port}}, plus contentSchema defaults)
  3. Spawn child process (server.command + server.args)
  4. Watch stdout for server.readyPattern
  5. If readyPattern matched within readyTimeout → server is ready
  6. If timeout → show error in pane, offer retry
  7. Start health check polling (if healthCheck defined)
  8. Load iframe at http://localhost:{port}{url}

Pane closed (last of this type, if singleton):
  1. Send SIGTERM to server process
  2. Wait 5 seconds
  3. Send SIGKILL if still running
  4. Release port

Freshell exit:
  1. SIGTERM all managed server processes
  2. Wait, then SIGKILL stragglers
```

### 6b. Crash recovery

If a server process exits unexpectedly:
1. Show "Extension crashed" overlay in the iframe pane
2. Offer "Restart" button
3. On restart: re-spawn with same port and env

### 6c. Singleton vs per-pane servers

- **Singleton** (`"singleton": true`): One server instance shared by all panes of this type. The iframe URL differs per pane (via `url` template). This is how kilroy-run-pane works — one Express server, different `/run/{runId}` paths.
- **Per-pane** (`"singleton": false`): Each pane gets its own server instance on a different port. Useful for extensions that maintain per-session state.

## 7. Frontend Architecture Changes

### 7a. Extension registry

Extension discovery, process management, and filesystem access all live **server-side**. The frontend receives a serialized registry via WebSocket on connection.

**Server-side** (`server/extension-manager.ts`):

```typescript
// Server owns the full registry with filesystem paths and process handles
interface ExtensionRegistryEntry {
  manifest: ExtensionManifest;
  path: string;            // filesystem path to extension dir
  serverPort?: number;     // allocated port (server panes)
  serverProcess?: ChildProcess;
}

class ExtensionManager {
  private extensions = new Map<string, ExtensionRegistryEntry>();
  private running = new Map<string, ManagedProcess>();

  scan(dirs: string[]): void;
  get(name: string): ExtensionRegistryEntry | undefined;
  getAll(): ExtensionRegistryEntry[];

  async startServer(name: string): Promise<number>;  // returns port
  async stopServer(name: string): Promise<void>;
  async stopAll(): Promise<void>;
  isRunning(name: string): boolean;
  getPort(name: string): number | undefined;

  // Serialize for frontend consumption (no ChildProcess, no fs paths)
  toClientRegistry(): ClientExtensionEntry[];
}
```

**Client-side** (`src/lib/extension-registry.ts`):

```typescript
// Frontend receives a serialized, safe subset of the registry
interface ClientExtensionEntry {
  name: string;
  version: string;
  label: string;
  description: string;
  category: 'client' | 'server' | 'cli';
  iconUrl: string;         // URL to icon served by freshell
  url?: string;            // URL template
  contentSchema?: Record<string, ContentSchemaField>;
  picker?: { shortcut?: string; group?: string };
  serverRunning?: boolean;
  serverPort?: number;
}

// Populated from WebSocket message on connect
class ClientExtensionRegistry {
  private extensions = new Map<string, ClientExtensionEntry>();

  update(entries: ClientExtensionEntry[]): void;
  get(name: string): ClientExtensionEntry | undefined;
  getAll(): ClientExtensionEntry[];
  getByCategory(cat: string): ClientExtensionEntry[];
}
```

### 7b. PaneContent type changes

Current: hardcoded discriminated union.

New: add a generic `ExtensionPaneContent` variant:

```typescript
// src/store/paneTypes.ts

// Keep existing built-in types as-is for backwards compat
export type PaneContent =
  | TerminalPaneContent
  | BrowserPaneContent
  | EditorPaneContent
  | PickerPaneContent
  | AgentChatPaneContent
  | ExtensionPaneContent;    // NEW: catch-all for extensions

export interface ExtensionPaneContent {
  kind: 'extension';
  extensionName: string;     // maps to registry
  props: Record<string, unknown>;  // contentSchema values
}
```

### 7c. Render changes

```typescript
// PaneContainer.tsx → renderContent()

// Add one case for all extensions:
if (content.kind === 'extension') {
  const ext = clientExtensionRegistry.get(content.extensionName);
  if (!ext) return <ExtensionError name={content.extensionName} />;

  switch (ext.category) {
    case 'client':
      return <ClientExtensionPane extension={ext} props={content.props} />;
    case 'server':
      return <ServerExtensionPane extension={ext} props={content.props} />;
    case 'cli':
      return <CliExtensionPane extension={ext} props={content.props} />;
  }
}
```

### 7d. Pane picker changes

Currently: hardcoded options list built from `CODING_CLI_PROVIDER_CONFIGS` and `AGENT_CHAT_PROVIDER_CONFIGS`.

New: merge extension registry entries into the picker dynamically:

```typescript
// PanePicker.tsx
// Extension picker items always create ExtensionPaneContent (kind: 'extension')
// They do NOT use the extension name as a pane type to avoid collisions with built-ins
const extensionOptions = clientExtensionRegistry.getAll().map(ext => ({
  label: ext.label,
  icon: ext.iconUrl,
  shortcut: ext.picker?.shortcut,
  group: ext.picker?.group ?? 'extensions',
  // When selected, creates:
  createContent: (): ExtensionPaneContent => ({
    kind: 'extension',
    extensionName: ext.name,
    props: {},  // filled in by setup prompt if contentSchema exists
  }),
}));

// Merge with built-in options
const allOptions = [...builtInOptions, ...extensionOptions];
```

### 7e. Title, icon, action registry

These become registry lookups instead of exhaustive switches:

```typescript
// derivePaneTitle.ts
if (content.kind === 'extension') {
  return clientExtensionRegistry.get(content.extensionName)?.label ?? 'Extension';
}

// PaneIcon.tsx
if (content.kind === 'extension') {
  const ext = clientExtensionRegistry.get(content.extensionName);
  return ext ? <img src={ext.iconUrl} /> : <LayoutGrid />;
}
```

## 8. Server-Side Changes

### 8a. API endpoints (new)

```
GET  /api/extensions              → list installed extensions
GET  /api/extensions/:name        → extension details + status
POST /api/extensions/:name/start  → start server pane's server
POST /api/extensions/:name/stop   → stop server pane's server
```

### 8b. WebSocket messages (new)

```typescript
// Extension pane lifecycle messages
{ type: 'extension.server.starting', name: string }
{ type: 'extension.server.ready', name: string, port: number }
{ type: 'extension.server.error', name: string, error: string }
{ type: 'extension.server.stopped', name: string }
```

## 9. Communication Protocol (Post-MVP)

**Decision: deferred to post-MVP.**

For V1, communication is minimal:
- **Server panes:** fully self-contained (iframe talks to its own server)
- **Client panes:** freshell passes initial props; no ongoing communication
- **CLI panes:** PTY stdin/stdout only

Post-MVP, we can add a `postMessage` protocol for richer integration:

```typescript
// freshell → extension iframe
{ type: 'freshell:theme', theme: 'dark' | 'light' }
{ type: 'freshell:resize', width: number, height: number }
{ type: 'freshell:props', props: Record<string, unknown> }

// extension iframe → freshell
{ type: 'ext:setTitle', title: string }
{ type: 'ext:openPane', paneType: string, props: Record<string, unknown> }
{ type: 'ext:requestFile', path: string }
```

## 10. Persistence & Serialization

Extension pane state must survive freshell restarts:

```typescript
// Persisted pane layout stores:
{
  type: 'leaf',
  id: 'pane-abc',
  content: {
    kind: 'extension',
    extensionName: 'kilroy-run-pane',
    props: { runId: '01KJ8...', runsDir: '/path/to/runs' }
  }
}
```

On restore:
1. Check if extension is still installed
2. If server pane: start server if not already running
3. Recreate iframe with saved props

If extension was uninstalled: show "Extension not found" placeholder with install prompt.

## 11. kilroy-run-pane as First Extension

### What needs to change in kilroy-run-pane

1. **Add `freshell.json` manifest** (see below)
2. **Add `/api/health` endpoint** to server
3. **Accept `PORT` from env** (already does this)
4. **Accept `KILROY_RUNS_DIR` from env** (already does this)

Changes are minimal — kilroy-run-pane was already designed as a standalone server.

### Draft freshell.json for kilroy-run-pane

```json
{
  "name": "kilroy-run-pane",
  "version": "0.1.0",
  "label": "Kilroy Run Viewer",
  "description": "View Kilroy pipeline runs with DAG visualization and stage execution details",
  "category": "server",
  "icon": "./icon.svg",
  "server": {
    "command": "node",
    "args": ["dist-server/index.js"],
    "env": {
      "PORT": "{{port}}",
      "KILROY_RUNS_DIR": "{{runsDir}}"
    },
    "readyPattern": "Listening on",
    "readyTimeout": 10000,
    "healthCheck": "/api/health",
    "singleton": true
  },
  "url": "/run/{{runId}}",
  "contentSchema": {
    "runId": {
      "type": "string",
      "label": "Run ID",
      "required": false
    },
    "runsDir": {
      "type": "string",
      "label": "Runs directory",
      "default": "~/.local/state/kilroy/attractor/runs"
    }
  },
  "picker": {
    "shortcut": "K",
    "group": "tools"
  }
}
```

## 12. Migration Strategy

### Phase 1: Extension infrastructure (no breaking changes)

1. Add `ExtensionManager` on server: directory scanning, manifest validation, process lifecycle
2. Add `ClientExtensionRegistry` on frontend: receives serialized registry via WS
3. Add `ExtensionPaneContent` to the `PaneContent` union
4. Add `extension` case to `renderContent()`, `derivePaneTitle()`, `PaneIcon`
5. Add extension options to `PanePicker`
6. Support all three categories: client, server, and CLI
7. Built-in panes remain hardcoded (no regression risk)

### Phase 2: First server extension (kilroy-run-pane)

1. Add `freshell.json` to kilroy-run-pane
2. Add `/api/health` endpoint
3. Test: place into `~/.freshell/extensions/`, open from picker, verify full lifecycle (start, render, close, restart)

### Phase 3: First client-only extension (DOT viewer)

1. Extract DotPreview from kilroy-run-pane as standalone client extension
2. Validates the client pane category works end-to-end

### Phase 4 (future): postMessage protocol, automated install

## 13. Files to Create/Modify in Freshell

### New files

| File | Purpose |
|------|---------|
| `server/extension-manager.ts` | Extension discovery, manifest validation, process lifecycle (server-side) |
| `server/extension-manifest-schema.ts` | JSON schema for `freshell.json` validation (server-side) |
| `server/routes/extensions.ts` | Extension API endpoints |
| `src/lib/extension-registry.ts` | Client-side registry (receives serialized data from server via WS) |
| `src/components/panes/ExtensionPane.tsx` | Generic extension pane renderer (iframe wrapper) |
| `src/components/panes/ExtensionError.tsx` | Error states (not installed, crashed, etc.) |

### Modified files

| File | Change |
|------|--------|
| `src/store/paneTypes.ts` | Add `ExtensionPaneContent` to union |
| `src/store/panesSlice.ts` | Handle `extension` kind in normalizeContent |
| `src/components/panes/PaneContainer.tsx` | Add `extension` case to renderContent |
| `src/components/panes/PanePicker.tsx` | Merge extension options into picker |
| `src/lib/derivePaneTitle.ts` | Add `extension` case |
| `src/components/icons/PaneIcon.tsx` | Add `extension` case |
| `src/lib/pane-action-registry.ts` | Support extension-registered actions |
| `server/index.ts` | Initialize ExtensionManager |
| `server/ws-handler.ts` | Handle extension lifecycle messages |

## 14. Open Questions

1. **Sandboxing**: Server panes run arbitrary processes. Do we need a trust/permission model? (Probably not for V1 — trust on install, like Hyper.)

2. **Extension settings UI**: Should freshell expose a settings panel per extension? Or just use the `contentSchema` defaults saved in `~/.freshell/extension-settings/`?

3. **Extension dependencies on freshell APIs**: Should extensions be able to call freshell's file system APIs, terminal APIs, etc.? (Deferred to post-MVP, via postMessage protocol.)

4. **Multi-pane extensions**: Can one extension declare multiple pane types? (e.g., kilroy could provide both "run viewer" and "dot viewer"). The manifest could have a `panes` array instead of a single pane config.

5. **Version compatibility**: Should the manifest declare a minimum freshell version? (Probably yes, even if we don't enforce it initially.)

6. **Hot reload for development**: Should freshell watch `~/.freshell/extensions/` for changes and auto-reload? Useful for extension developers but adds complexity.
