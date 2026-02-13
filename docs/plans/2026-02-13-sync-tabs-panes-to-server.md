# Design: Sync Tabs & Panes to Server (Per-Device Namespacing)

**Status: DESIGN** — Awaiting review before implementation.

**Goal:** Persist tab/pane layouts on the server, keyed per device, so that connecting from a different machine shows both your local tabs and the other machine's tabs. Each device owns its own tab namespace — no sync conflicts. The server also maintains closed tabs per device, shown greyed-out for easy reopening.

---

## 1. Why This Matters

Today, tabs and panes live only in `localStorage`. If you work on `danshapiro-main` then walk to `dan-laptop`, you get a blank slate and have to manually hunt through background terminals. With per-device workspace sync:

- `dan-laptop` connects and immediately sees `danshapiro-main`'s tabs (read-only, greyed, or in a separate group)
- Clicking one of those tabs creates a **local copy** on `dan-laptop`, attached to the **same running PTYs** on the server
- Now both devices have their own tab pointing at the same terminals — zero collision risk
- Each device's tabs are labeled with the device name for clarity

Because Freshell is self-hosted, `terminalId` values are server-side PTY handles valid from any client. The missing piece is knowing *what tabs exist on other devices* so you can adopt them.

---

## 2. Core Concept: Device-Owned Workspaces

```
┌─────────────────────────────────────────────────────────┐
│  Server: ~/.freshell/workspace.json                     │
│                                                         │
│  devices: {                                             │
│    "danshapiro-main": {                                 │
│      tabs: [ freshell(3 panes), api-server(1 pane) ]    │
│      closedTabs: [ old-debug(exited) ]                  │
│    },                                                   │
│    "dan-laptop": {                                      │
│      tabs: [ freshell(3 panes) ]  ← cloned from main   │
│      closedTabs: []                                     │
│    }                                                    │
│  }                                                      │
└─────────────────────────────────────────────────────────┘
```

**Key principle:** Each device only writes to its own slot. No device ever mutates another device's data. This makes the entire system conflict-free — concurrent writes from different devices touch different keys.

---

## 3. Data Model

### 3.1 Device Identity

Each client has a **device name** — a human-readable identifier like `danshapiro-main` or `dan-laptop`. This is:

- Configured in Settings (new field: `settings.deviceName`)
- Defaults to `os.hostname()` on first connect if unset
- Stored in `~/.freshell/config.json` alongside other settings
- Sent in the `hello` message so the server knows which device slot to use

```typescript
// New field in AppSettings
{
  deviceName: string   // e.g., "danshapiro-main"
}
```

The server can also suggest a default from `os.hostname()` in the `ready` message for first-time setup.

### 3.2 Workspace File

`~/.freshell/workspace.json`, managed by `WorkspaceStore`:

```typescript
{
  version: 1,
  devices: Record<string, DeviceWorkspace>,
}

type DeviceWorkspace = {
  updatedAt: number,            // epoch ms — server-assigned on each write
  lastSeenAt: number,           // epoch ms — last time this device connected

  // Active tabs (mirrors persisted Redux state, volatile fields stripped)
  tabs: Tab[],
  activeTabId: string | null,
  layouts: Record<string, PaneNode>,
  activePane: Record<string, string>,
  paneTitles: Record<string, Record<string, string>>,
  paneTitleSetByUser: Record<string, Record<string, boolean>>,

  // Closed tabs (most-recent-first, capped per device)
  closedTabs: ClosedTab[],
}
```

### 3.3 ClosedTab

```typescript
type ClosedTab = {
  id: string                   // original tab ID
  closedAt: number             // epoch ms
  tab: {                       // snapshot at close time
    title: string
    mode: TabMode
    codingCliSessionId?: string
    codingCliProvider?: CodingCliProviderName
    shell?: string
    initialCwd?: string
    createdAt: number
  }
  layout?: PaneNode            // pane tree snapshot (stripped of editor content)
  paneTitles?: Record<string, string>
  terminalIds: string[]        // terminal IDs from pane leaves (for status enrichment)
}
```

Server enriches with live terminal status when sending to clients:

```typescript
type ClosedTabWithStatus = ClosedTab & {
  terminals: Array<{
    terminalId: string
    status: 'running' | 'exited' | 'gone'
    idleSince?: number
  }>
}

type DeviceWorkspaceWithStatus = Omit<DeviceWorkspace, 'closedTabs'> & {
  deviceName: string
  closedTabs: ClosedTabWithStatus[]
  isLocal: boolean              // true if this is the receiving client's own device
}
```

### 3.4 Limits

| Limit | Value | Rationale |
|-------|-------|-----------|
| Max closed tabs per device | 50 | Prevent unbounded growth |
| Max active tabs per device | 200 | Sanity cap |
| Max devices | 20 | Prune oldest `lastSeenAt` beyond this |
| Device stale TTL | 30 days | Auto-prune devices not seen in 30 days |
| Workspace file max size | 1 MB | Reject writes that exceed this |
| Closed tab TTL | 7 days | Auto-prune on write |

---

## 4. Sync Protocol

### 4.1 New WebSocket Messages

```
Client → Server
─────────────────────────────────────────────
workspace.sync          Push this device's full workspace (debounced)
workspace.tab-closed    This device closed a tab (immediate)
workspace.reopen-tab    Reopen a closed tab on this device
workspace.adopt-tab     Clone a tab from another device to this device

Server → Client
─────────────────────────────────────────────
workspace.state         All devices' workspaces (on connect)
workspace.device-updated   A single device's workspace changed (incremental)
workspace.closed-tabs      A device's closed tabs list changed
```

#### `workspace.sync` (Client → Server)

```typescript
{
  type: 'workspace.sync',
  // deviceName not needed — server knows from hello handshake
  tabs: Tab[],
  activeTabId: string | null,
  layouts: Record<string, PaneNode>,
  activePane: Record<string, string>,
  paneTitles: Record<string, Record<string, string>>,
  paneTitleSetByUser: Record<string, Record<string, boolean>>,
}
```

Server writes to `devices[clientDeviceName]`, broadcasts `workspace.device-updated` to other clients.

#### `workspace.tab-closed` (Client → Server)

```typescript
{
  type: 'workspace.tab-closed',
  closedTab: ClosedTab,
}
```

Sent immediately when a tab is closed. Server appends to this device's `closedTabs`, broadcasts update.

#### `workspace.adopt-tab` (Client → Server)

```typescript
{
  type: 'workspace.adopt-tab',
  fromDevice: string,           // source device name
  tabId: string,                // tab ID on the source device
}
```

Client is saying: "I want to open a copy of this tab from that device." The server responds with the full tab + layout data in a `workspace.device-updated` for the adopting device (after the client adds it locally). This message is mainly informational — the client already has the data from the last `workspace.state` and handles the local tab creation itself.

#### `workspace.reopen-tab` (Client → Server)

```typescript
{
  type: 'workspace.reopen-tab',
  closedTabId: string,
}
```

Server removes from this device's `closedTabs`, broadcasts update.

#### `workspace.state` (Server → Client, on connect)

```typescript
{
  type: 'workspace.state',
  devices: DeviceWorkspaceWithStatus[],
}
```

Full snapshot of all devices. Sent once after handshake.

#### `workspace.device-updated` (Server → Client, incremental)

```typescript
{
  type: 'workspace.device-updated',
  device: DeviceWorkspaceWithStatus,
}
```

Sent to all OTHER clients when a device pushes a sync. Not sent back to the originating client.

#### `workspace.closed-tabs` (Server → Client)

```typescript
{
  type: 'workspace.closed-tabs',
  deviceName: string,
  closedTabs: ClosedTabWithStatus[],
}
```

### 4.2 Capability Negotiation

Add `supportsWorkspaceSyncV1: true` to the `hello` capabilities. Also send `deviceName` in the hello:

```typescript
{
  type: 'hello',
  token: '...',
  capabilities: {
    supportsWorkspaceSyncV1: true,
  },
  deviceName: 'danshapiro-main',
}
```

---

## 5. Data Flow

### 5.1 Client Makes a Change

```
User adds/rearranges tab on danshapiro-main
  → Redux dispatch (immediate local UI update)
  → persistMiddleware → localStorage (500ms debounce, unchanged)
  → workspaceSyncMiddleware → WS workspace.sync (500ms debounce)
  → Server writes to devices["danshapiro-main"]
  → Server broadcasts workspace.device-updated to dan-laptop (if connected)
  → dan-laptop updates its "remote devices" state (no merge into local tabs)
```

### 5.2 New Device Connects

```
dan-laptop connects → hello with deviceName="dan-laptop"
  → Server sends ready
  → Server sends workspace.state (all devices, enriched)
  → Client sees: devices["danshapiro-main"] has 2 tabs, devices["dan-laptop"] has 0 tabs
  → Client checks localStorage for its own tabs:
    → Has local state? → push workspace.sync, show local tabs
    → No local state? → show empty tab bar + other devices' tabs as adoptable
  → Tab bar renders:
    [+ New Tab]  |  danshapiro-main: freshell (3)  api-server (1)
```

### 5.3 Adopting a Tab from Another Device

```
User on dan-laptop clicks "freshell (3)" from danshapiro-main
  → Client reads tab + layout from remoteDevices["danshapiro-main"]
  → Creates local tab: same title, same pane tree, same terminalIds
  → Dispatches addTab() + initLayout()
  → Terminal panes: terminalIds are valid (same server) → attach
  → Normal workspace.sync pushes dan-laptop's new tab to server
  → Tab bar now shows:
    freshell (3)  |  danshapiro-main: freshell (3)  api-server (1)
    └ local tab      └ still visible as remote
```

Both devices now have "freshell (3)" — each in their own namespace, both attached to the same PTYs. No conflict.

### 5.4 Tab Closed

```
User closes tab on danshapiro-main
  → closeTab() thunk (local)
  → workspaceSyncMiddleware captures snapshot before removal
  → Sends workspace.tab-closed immediately
  → Server appends to devices["danshapiro-main"].closedTabs
  → Server broadcasts workspace.closed-tabs to all clients
  → dan-laptop sees the closed tab appear in danshapiro-main's greyed section
  → danshapiro-main sees it in its own greyed section
```

### 5.5 Reconnecting to Same Device

```
danshapiro-main browser crashes and reopens
  → Connects with deviceName="danshapiro-main"
  → Receives workspace.state including its own device data
  → Client checks: localStorage empty (crash cleared it)
  → Hydrates from server's devices["danshapiro-main"] data
  → Tabs restored, terminal panes reattach to still-running PTYs
```

This is the primary "sync to yourself on the same machine" use case — surviving browser crashes/refreshes even when localStorage is lost.

---

## 6. No Conflict Resolution Needed

Because each device writes only to its own slot in the workspace file:

- **Concurrent writes from different devices** touch different keys → no conflict
- **Same device, multiple browser tabs** → same device name, same slot. Last write wins within the single device (same behavior as current localStorage cross-tab sync). The existing `persistMiddleware` + `BroadcastChannel` sync keeps browser tabs in lockstep locally.
- **No merge logic, no CRDTs, no vector clocks, no last-writer-wins tiebreaking**

The only "merge" is when a device reconnects and decides whether to use server state or local state for its own slot (section 5.2). This is a simple "local vs. remote, pick one" decision — not a semantic merge.

---

## 7. Performance Analysis

### 7.1 Payload Size

Per-device workspace: ~6 KB for 10 tabs. Full `workspace.state` with 3 devices:

| Component | Size |
|-----------|------|
| 3 devices × 10 tabs each | ~18 KB |
| 3 devices × 10 closed tabs each | ~9 KB |
| **Total workspace.state** | **~27 KB** |

Well within a single WebSocket frame.

### 7.2 Incremental Updates

After initial connect, only `workspace.device-updated` messages are sent (~6 KB per device change). These are debounced at 500ms on the client side.

### 7.3 Write Frequency

- `workspace.sync` debounced at 500ms → at most 2 writes/sec during active tab manipulation
- Server write: atomic temp+rename to `workspace.json`, ~1ms
- Only the changed device's slot is updated (read-modify-write under mutex)

### 7.4 Server Memory

- One parsed workspace in memory (all devices, ~30 KB typical)
- No per-connection workspace state needed

### 7.5 Network

- `workspace.device-updated` skips the sender
- No polling — entirely event-driven
- Initial `workspace.state` (~27 KB) is negligible vs. existing `sessions.updated` (~500 KB)

### 7.6 localStorage Unchanged

- localStorage persist continues as-is (same-browser cross-tab sync)
- Server sync is additive — works alongside localStorage, not instead of it
- If server is unreachable, local-only operation continues

---

## 8. Tab Bar UX

### 8.1 Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ [freshell ▾] [api-server]  │  ░ old-debug ░  ║  danshapiro-main:   │
│  ↑ local active tabs        ↑ local closed     [freshell (3)]       │
│                                                [api-server]         │
│                                                 ↑ remote tabs       │
└──────────────────────────────────────────────────────────────────────┘
```

### 8.2 Local Tabs (Left Section)
- Normal active tabs — existing behavior, unchanged
- User's own device, no device label needed

### 8.3 Local Closed Tabs (Middle Section)
- Greyed out, italic title
- Status dot: green (terminal running), grey (exited/gone)
- Click to reopen (restores layout, reattaches terminals)
- Right-click → "Dismiss" to remove permanently

### 8.4 Remote Device Tabs (Right Section)
- Grouped by device name with a label header
- Slightly different visual treatment (perhaps a subtle background tint or border)
- Show tab title + pane count badge
- Click to **adopt** — creates a local copy attached to the same terminals
- Remote closed tabs also visible (greyed, with device label)

### 8.5 Remote Tab Indicators
- **Device name** shown as a small label/badge above or beside the tab group
- **Online indicator** — green dot if the device is currently connected, grey if last seen N hours ago
- **Terminal status** — if the tab's terminals are still running (useful when the remote device disconnected)

### 8.6 Overflow
- If remote tabs are numerous, collapse into a `danshapiro-main: +N` pill that opens a dropdown
- Local closed tabs overflow into `+N closed` button with dropdown

### 8.7 Replacing Background Sessions

The `BackgroundSessions` component (polling `terminal.list` every 5s) is fully replaced:

- Local closed tabs show your own detached terminals with full context
- Remote device tabs show other machines' terminals
- Orphan terminals (running with no client, no tab association) are surfaced as synthetic closed tabs on a special `(server)` pseudo-device

---

## 9. WorkspaceStore (Server)

New file: `server/workspace-store.ts`

```typescript
class WorkspaceStore {
  private mutex = new Mutex()
  private cached: WorkspaceFile | null = null
  private filePath: string  // ~/.freshell/workspace.json

  async load(): Promise<WorkspaceFile>
  async save(data: WorkspaceFile): Promise<void>

  // Device operations (all serialized under mutex)
  async getDevice(name: string): Promise<DeviceWorkspace | null>
  async updateDevice(name: string, workspace: DeviceWorkspaceSync): Promise<void>
  async addClosedTab(deviceName: string, tab: ClosedTab): Promise<void>
  async removeClosedTab(deviceName: string, tabId: string): Promise<ClosedTab | null>
  async touchDevice(name: string): Promise<void>  // update lastSeenAt

  // Maintenance
  async pruneStaleDevices(maxAge: number): Promise<string[]>  // returns pruned device names
  async pruneClosedTabs(deviceName: string): Promise<void>    // TTL + count cap

  // Read (no mutex needed)
  getAllDevices(): Record<string, DeviceWorkspace>

  // Enrichment
  enrichDevice(
    device: DeviceWorkspace,
    deviceName: string,
    registry: TerminalRegistry,
    isLocal: boolean,
  ): DeviceWorkspaceWithStatus
}
```

---

## 10. Client-Side Changes

### 10.1 New: `workspaceSyncMiddleware`

Intercepts `tabs/*` and `panes/*` actions, debounces, and pushes to server:

```typescript
// - Debounce: 500ms (separate timer from persistMiddleware)
// - On flush: snapshot current tabs + panes state, send workspace.sync
// - On tab close: capture snapshot BEFORE removal, send workspace.tab-closed immediately
// - Skip actions tagged with { source: 'workspace-sync' } to prevent echo loops
// - Skip if WS not connected (degrade gracefully)
```

### 10.2 New: `remoteDevicesSlice`

```typescript
type RemoteDevicesState = {
  devices: DeviceWorkspaceWithStatus[]   // all devices except local
  localClosedTabs: ClosedTabWithStatus[] // this device's closed tabs from server
}

// Reducers:
//   setAllDevices(devices[])       — from workspace.state
//   updateDevice(device)           — from workspace.device-updated
//   setClosedTabs(deviceName, tabs) — from workspace.closed-tabs

// Selectors:
//   selectRemoteDevices            — other devices with their tabs
//   selectLocalClosedTabs          — this device's closed tabs
//   selectOnlineDevices            — devices with active WS connections
```

### 10.3 New: `deviceNameSlice` (or extend `settingsSlice`)

```typescript
// Stores the local device name
// Loaded from settings on startup
// Editable in Settings UI
// Sent in hello message
```

### 10.4 Modified: Connection Handler

On `workspace.state`:
- Populate `remoteDevicesSlice` with all non-local devices
- For own device: if localStorage is empty, hydrate from server data
- For own device: if localStorage exists, keep local, push sync to server
- Set local closed tabs from own device's closedTabs

### 10.5 Modified: Tab Bar

- Render local active tabs (unchanged)
- Render local closed tabs (new, greyed section)
- Render remote device tab groups (new, rightmost section)
- Click handlers for adopt and reopen flows

---

## 11. Migration & Backward Compatibility

- **Old clients** (no `supportsWorkspaceSyncV1`): no `deviceName` in hello, no workspace messages sent. Fully backward compatible.
- **First connect with new client**: server has no `workspace.json`. Client pushes initial sync. File created.
- **Downgrade**: `workspace.json` ignored. localStorage still works.
- **Device rename**: old device name persists as stale entry, auto-pruned after 30 days. No data loss.
- **Background Sessions**: `terminal.list` WS messages remain in protocol but UI no longer polls them. Removed in a follow-up cleanup pass.

---

## 12. Edge Cases

| Scenario | Behavior |
|----------|----------|
| Two browser tabs, same device name | Both push to same device slot. Last write wins (same as current localStorage behavior). BroadcastChannel keeps them in sync locally. |
| Device name collision (two machines with same hostname) | Unlikely but handled: last writer wins for that slot. User should rename one device in Settings. |
| Adopt a tab whose terminals have exited | Panes show `status: 'exited'`. User can see scrollback (if still in server buffer) or close. |
| Remote device disconnects | Its tabs remain visible. `lastSeenAt` stops updating. Online indicator goes grey. Tabs still adoptable if terminals are running. |
| Server restart | `workspace.json` on disk survives. All devices' data preserved. |
| `workspace.json` corrupted | Server logs error, starts fresh. Each device pushes on next connect. |
| 20+ devices over time | Oldest by `lastSeenAt` pruned automatically. |
| Device has 200+ tabs | Server rejects the sync with a warning. Client keeps local state. |

---

## 13. Testing Strategy

### Unit Tests
- `WorkspaceStore`: per-device load/save/prune, atomic writes, mutex serialization, stale device cleanup
- `remoteDevicesSlice`: reducers, selectors
- `workspaceSyncMiddleware`: debounce, skip-echo, pre-removal capture
- Workspace message Zod schemas: validation
- Tab adoption logic: clone tab + layout, remap IDs

### Integration Tests
- WS handler: `workspace.sync` → persist to device slot → broadcast to others
- WS handler: `workspace.tab-closed` → update device closedTabs → broadcast
- WS handler: capability negotiation (old client gets no workspace messages)
- WS handler: device name from hello used correctly
- Connect flow: fresh device hydration from server state
- Connect flow: existing device pushes local state

### E2E Tests
- Device A creates tabs, Device B sees them in remote section
- Device B adopts Device A's tab, both attached to same terminals
- Close tab on Device A, grey tab visible on both devices
- Reopen closed tab, terminal reattaches
- Device A disconnects, Device B still sees its tabs (stale but visible)
- Browser crash on Device A → reconnect → hydrate from server → tabs restored

---

## 14. Implementation Order

1. **Device name setting** — new `deviceName` field in AppSettings, default from `os.hostname()`, UI in Settings
2. **WorkspaceStore** — per-device persistence (file I/O, mutex, prune)
3. **WS message schemas** — Zod schemas for all new message types
4. **WS handler integration** — device-aware sync/broadcast, capability negotiation, `deviceName` in hello
5. **remoteDevicesSlice** — client Redux state for remote devices + local closed tabs
6. **workspaceSyncMiddleware** — debounced push, tab-closed capture
7. **Connection handler** — hydration on connect, push local state
8. **Tab bar UI** — closed tabs, remote device groups, adopt flow
9. **Replace BackgroundSessions** — orphan terminal surfacing on `(server)` pseudo-device
10. **E2E tests**

---

## 15. Open Questions

1. **Device name UX:** Should we prompt on first connect ("What should we call this device?") or silently default to hostname and let users rename later in Settings?

2. **Adopt vs. mirror:** When you adopt a tab, should it be a one-time clone (independent from that point) or a live mirror that stays in sync with the source device? Proposed: one-time clone (simpler, no ongoing sync coupling between devices).

3. **Tab title decoration:** How to show device provenance? Options:
   - `freshell (danshapiro-main)` in the tab title
   - Small device badge below the tab
   - Separate grouped section with device header label
   - Color-coded per device

4. **Should remote closed tabs be visible?** Or only remote active tabs? Proposed: both, but remote closed tabs are lower priority and could be hidden behind an expand toggle.

5. **Workspace profiles:** Out of scope for v1, but the per-device data model supports it naturally — a "profile" could be a snapshot of a device's workspace that you can restore later.
