# Design: Sync Tabs & Panes to Server

**Status: DESIGN** — Awaiting review before implementation.

**Goal:** Persist the tab/pane layout on the server so that connecting from a different machine (or a fresh browser) restores the same workspace. The client remains the source of truth. The server also maintains a list of recently-closed tabs, shown greyed-out in the tab bar for easy reopening — absorbing and replacing the current "Background Sessions" panel.

---

## 1. Why This Matters

Today, tabs and panes live only in `localStorage`. If you work on Machine A, then walk to Machine B, you get a blank slate and have to manually reattach to background terminals. This design makes the workspace follow you across machines while keeping the client authoritative over its own layout.

Because Freshell is self-hosted (all clients talk to the same server), `terminalId` values are valid across machines. Syncing the layout is the missing piece — once Machine B has the tab/pane tree, it can attach to the exact same running PTYs.

---

## 2. Data Model

### 2.1 Workspace File

New file: `~/.freshell/workspace.json`, managed by a new `WorkspaceStore` (same atomic-write + mutex pattern as `ConfigStore`).

```typescript
// ~/.freshell/workspace.json
{
  version: 1,
  updatedAt: number,           // epoch ms — last mutation timestamp
  sourceClientId: string,      // which client wrote this (for leader-election-free conflict resolution)

  // Active workspace (mirrors the persisted Redux state)
  tabs: Tab[],                 // same shape as localStorage persisted tabs (volatile fields stripped)
  activeTabId: string | null,
  layouts: Record<string, PaneNode>,
  activePane: Record<string, string>,
  paneTitles: Record<string, Record<string, string>>,
  paneTitleSetByUser: Record<string, Record<string, boolean>>,

  // Closed tabs (most-recent-first, capped)
  closedTabs: ClosedTab[],
}
```

### 2.2 ClosedTab

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
  terminalIds: string[]        // all terminal IDs from pane leaves (for status enrichment)
}
```

The server enriches each `ClosedTab` with live status when sending to clients:

```typescript
type ClosedTabWithStatus = ClosedTab & {
  terminals: Array<{
    terminalId: string
    status: 'running' | 'exited' | 'gone'   // 'gone' = reaped from registry
    idleSince?: number
  }>
}
```

### 2.3 Limits

| Limit | Value | Rationale |
|-------|-------|-----------|
| Max closed tabs | 50 | Prevent unbounded growth |
| Max active tabs in workspace file | 200 | Sanity cap |
| Workspace file max size | 512 KB | Reject writes that exceed this |
| Closed tab TTL | 7 days | Auto-prune on write |

---

## 3. Sync Protocol

### 3.1 New WebSocket Messages

```
Client → Server
─────────────────────────────────────────────
workspace.sync          Full workspace state push (debounced)
workspace.tab-closed    Single tab closed (immediate)
workspace.reopen-tab    Request to reopen a closed tab

Server → Client
─────────────────────────────────────────────
workspace.state         Full workspace snapshot (on connect, or after another client pushes)
workspace.closed-tabs   Closed tabs list update (after close/reopen/prune)
```

#### `workspace.sync` (Client → Server)

```typescript
{
  type: 'workspace.sync',
  updatedAt: number,
  tabs: Tab[],
  activeTabId: string | null,
  layouts: Record<string, PaneNode>,
  activePane: Record<string, string>,
  paneTitles: Record<string, Record<string, string>>,
  paneTitleSetByUser: Record<string, Record<string, boolean>>,
}
```

#### `workspace.tab-closed` (Client → Server)

```typescript
{
  type: 'workspace.tab-closed',
  closedTab: ClosedTab,
}
```

Sent immediately (not debounced) when a tab is closed, so the closed-tab entry is captured before any subsequent sync overwrites.

#### `workspace.reopen-tab` (Client → Server)

```typescript
{
  type: 'workspace.reopen-tab',
  closedTabId: string,
}
```

Server removes from `closedTabs`, broadcasts updated list. The requesting client handles adding the tab locally (it already has the closed tab data from its local state or the last `workspace.closed-tabs` message).

#### `workspace.state` (Server → Client)

```typescript
{
  type: 'workspace.state',
  updatedAt: number,
  sourceClientId: string,
  tabs: Tab[],
  activeTabId: string | null,
  layouts: Record<string, PaneNode>,
  activePane: Record<string, string>,
  paneTitles: Record<string, Record<string, string>>,
  paneTitleSetByUser: Record<string, Record<string, boolean>>,
  closedTabs: ClosedTabWithStatus[],
}
```

#### `workspace.closed-tabs` (Server → Client)

```typescript
{
  type: 'workspace.closed-tabs',
  closedTabs: ClosedTabWithStatus[],
}
```

### 3.2 Capability Negotiation

Add `supportsWorkspaceSyncV1: true` to the `hello` capabilities object. Server only sends `workspace.state` to capable clients. This ensures backward compatibility with older client builds.

---

## 4. Data Flow

### 4.1 Client Makes a Change (Happy Path)

```
User adds/closes/rearranges tab
  → Redux dispatch (immediate local UI update)
  → persistMiddleware → localStorage (500ms debounce, unchanged)
  → NEW: workspaceSyncMiddleware → WS workspace.sync (500ms debounce, separate timer)
  → Server receives workspace.sync
  → WorkspaceStore persists to ~/.freshell/workspace.json (atomic write)
  → Server broadcasts workspace.state to OTHER connected clients (not sender)
  → Other clients merge into local state (reusing hydrateTabs/hydratePanes logic)
```

### 4.2 Client Connects (Fresh Browser / Different Machine)

```
Client connects → sends hello (supportsWorkspaceSyncV1: true)
  → Server sends ready
  → Server sends workspace.state (from disk, enriched with terminal statuses)
  → Client checks: do I have local tabs in localStorage?
    → NO local state:  hydrate entirely from workspace.state
    → YES local state: compare updatedAt timestamps
      → Server newer: hydrate from server (merge with smart terminal state preservation)
      → Local newer:  keep local, push workspace.sync to server
```

### 4.3 Tab Closed

```
User closes tab
  → closeTab() thunk dispatches removeTab() (local)
  → workspaceSyncMiddleware intercepts tabs/removeTab
  → Captures tab snapshot + layout BEFORE removal (via middleware pre-processing)
  → Sends workspace.tab-closed immediately
  → Then queues workspace.sync for the updated active state (debounced)
  → Server appends to closedTabs, prunes if over limit
  → Server broadcasts workspace.closed-tabs to all clients
```

### 4.4 Reopen Closed Tab

```
User clicks greyed-out closed tab
  → Client creates new tab locally from ClosedTab snapshot
  → Dispatches addTab() + initLayout() with the saved layout
  → Terminal panes: if terminalIds are still running → attach
                    if exited/gone → set status 'creating', spawn new PTY
  → Sends workspace.reopen-tab to server
  → Server removes from closedTabs, persists
  → Server broadcasts workspace.closed-tabs to all clients
  → Normal workspace.sync follows from the client's tab addition
```

---

## 5. Conflict Resolution

**Principle: last writer wins at the server, smart merge at the client.**

- The server stores whichever `workspace.sync` arrived most recently (by `updatedAt`).
- When a client receives `workspace.state`, it merges using the existing `hydrateTabs` / `hydratePanes` logic, which already handles:
  - Preserving local `terminalId` when remote lacks it
  - Preserving local `activeTabId` if the tab exists in the remote set
  - Smart `resumeSessionId` merge to prevent cross-client clobbering
- Two simultaneous editors: both push syncs; the server keeps the later one. The "losing" client receives a `workspace.state` broadcast and merges. In practice, the merge is usually additive (different tabs being modified).

**No vector clocks, no CRDTs.** The workspace is small, changes are infrequent relative to network latency, and the existing merge logic handles the realistic conflict cases (same tab modified on two machines). This is intentionally simple — the same strategy that powers the existing cross-tab sync.

---

## 6. Performance Analysis

### 6.1 Payload Size

Typical workspace: 10 tabs, each with 1-3 panes. Estimated JSON size:

| Field | Per-tab | 10 tabs |
|-------|---------|---------|
| Tab metadata | ~300 B | 3 KB |
| PaneNode tree | ~200 B | 2 KB |
| Pane titles | ~100 B | 1 KB |
| Closed tabs (50) | — | 15 KB |
| **Total** | — | **~21 KB** |

This is well within a single WebSocket frame. No chunking needed.

### 6.2 Write Frequency

- `workspace.sync` debounced at 500ms — at most 2 writes/sec during active tab manipulation.
- `workspace.tab-closed` is immediate but infrequent (user closes a tab).
- File I/O: atomic write to `workspace.json` is ~1ms (small file, temp+rename).

### 6.3 Server Memory

- `WorkspaceStore` holds one parsed workspace in memory (~20 KB).
- No per-client workspace state needed — server has one canonical workspace.

### 6.4 Network

- `workspace.state` broadcast skips the sender (they already have the state).
- No polling. Entirely event-driven.
- On reconnect, one `workspace.state` message (~20 KB) — negligible compared to the `sessions.updated` snapshots (~500 KB) already sent.

### 6.5 localStorage Interaction

- localStorage persist continues unchanged (no regression for same-browser cross-tab sync).
- Server sync is additive — a second transport layer, not a replacement.
- If the server is unreachable (e.g., network blip), localStorage still works locally.

---

## 7. Closed Tabs UX

### 7.1 Tab Bar Integration

Closed tabs appear at the right end of the tab bar, visually distinct:

- **Greyed out** (reduced opacity, no background highlight)
- **Italic title** to distinguish from active tabs
- **Status indicator dot**: green if terminal still running, grey if exited/gone
- **Click** to reopen (restores full pane layout and reattaches terminals)
- **Right-click → "Dismiss"** to permanently remove from closed list
- **Separator** (thin vertical line or gap) between active and closed tabs

### 7.2 Replacing Background Sessions

The current `BackgroundSessions` component (polling `terminal.list` every 5s) is replaced by the closed tabs bar. Benefits:

- No more polling — closed tabs are pushed via WebSocket events
- Richer context — you see the original tab title and pane layout, not just "terminal-abc123"
- Same actions available — reattach or kill

Running terminals with no associated tab (e.g., orphans from crashes) still appear in the closed tabs list. The server constructs synthetic `ClosedTab` entries for running terminals that have no client AND no matching `closedTabs` entry.

### 7.3 Overflow

If many closed tabs accumulate, the tab bar shows a `+N closed` overflow button that opens a dropdown/popover listing all closed tabs with timestamps and status.

---

## 8. WorkspaceStore (Server)

New file: `server/workspace-store.ts`

Follows the same pattern as `ConfigStore`:

```typescript
class WorkspaceStore {
  private mutex = new Mutex()
  private cached: WorkspaceData | null = null
  private filePath: string  // ~/.freshell/workspace.json

  async load(): Promise<WorkspaceData>
  async save(data: WorkspaceData): Promise<void>           // atomic write
  async updateWorkspace(sync: WorkspaceSync): Promise<void> // merge active state
  async addClosedTab(tab: ClosedTab): Promise<void>
  async removeClosedTab(id: string): Promise<ClosedTab | null>
  async pruneClosedTabs(): Promise<void>                   // TTL + count cap

  // Enrichment
  enrichClosedTabs(
    closedTabs: ClosedTab[],
    registry: TerminalRegistry
  ): ClosedTabWithStatus[]
}
```

---

## 9. Client-Side Changes

### 9.1 New: `workspaceSyncMiddleware`

Similar to `persistMiddleware`, intercepts `tabs/*` and `panes/*` actions:

```typescript
// Debounce timer (500ms, separate from persist)
// On flush: read current state, send workspace.sync over WS
// On tab close: capture snapshot pre-removal, send workspace.tab-closed immediately
// Skip actions tagged with { source: 'workspace-sync' } to prevent echo
```

### 9.2 New: `closedTabsSlice`

```typescript
type ClosedTabsState = {
  closedTabs: ClosedTabWithStatus[]
}

// Reducers:
//   setClosedTabs(tabs)      — from workspace.state or workspace.closed-tabs
//   clearClosedTab(id)       — local removal (before reopen or dismiss)

// Selectors:
//   selectClosedTabs         — all closed tabs
//   selectClosedTabsWithRunning — only those with at least one running terminal
```

### 9.3 Modified: Connection Handler

On receiving `workspace.state`:
- If no local tabs: hydrate fully
- If local tabs exist: compare `updatedAt`, merge or push accordingly
- Always update `closedTabs` slice

### 9.4 Modified: Tab Bar

- Render closed tabs after active tabs with visual distinction
- Click handler dispatches reopen flow
- Right-click context menu with "Dismiss" option

---

## 10. Migration & Backward Compatibility

- **Old clients** (no `supportsWorkspaceSyncV1`): continue using localStorage only. No `workspace.state` sent. No breakage.
- **First connection with new client**: server has no `workspace.json` yet. Client pushes its localStorage state to server on connect. From then on, workspace is synced.
- **Downgrade**: if a user reverts to an older Freshell version, `workspace.json` is ignored. localStorage still works. No data loss.
- **Background Sessions panel**: removed in the new UI. The tab bar closed-tabs section replaces it entirely. The `terminal.list` / `terminal.list.response` / `terminal.list.updated` WS messages remain available but are no longer polled by the default UI.

---

## 11. Edge Cases

| Scenario | Behavior |
|----------|----------|
| Two machines connected, both editing | Both push syncs; last writer wins at server. Loser receives broadcast, merges. Tabs are additive so typically no visible conflict. |
| Client disconnects mid-sync | Server has last successful write. Client reconnects, receives stale-but-valid state, pushes fresh sync. |
| Server restart | `workspace.json` survives on disk. First client to connect receives persisted state. |
| `workspace.json` corrupted | Server logs error, treats as empty. First client push recreates it. |
| Tab closed on Machine A, terminal killed before Machine B sees it | Machine B receives `closedTabs` with terminal status `'gone'`. Reopening creates a fresh terminal. |
| 200+ tabs | Server rejects `workspace.sync` exceeding size cap. Client keeps local state. Log warning. |
| Clock skew between machines | `updatedAt` is set by the server on receipt (not trusted from client), eliminating clock skew issues. |

---

## 12. Testing Strategy

### Unit Tests
- `WorkspaceStore`: load/save/prune/enrich, atomic writes, mutex serialization
- `closedTabsSlice`: reducers, selectors
- `workspaceSyncMiddleware`: debounce, skip-echo, pre-removal capture
- Workspace message Zod schemas: validation, edge cases

### Integration Tests
- WS handler: `workspace.sync` → persist → broadcast flow
- WS handler: `workspace.tab-closed` → closed list update → broadcast
- WS handler: capability negotiation (old client gets no workspace messages)
- Connect flow: fresh client hydration from server state

### E2E Tests
- Open tab on "Machine A" (browser tab 1), verify it appears on "Machine B" (browser tab 2 after clearing localStorage)
- Close tab, verify grey tab appears on both machines
- Reopen closed tab, verify terminal reattaches
- Kill terminal, verify closed tab shows grey status dot

---

## 13. Implementation Order

1. **WorkspaceStore** — server-side persistence (file I/O, mutex, prune logic)
2. **WS message schemas** — Zod schemas for all new message types
3. **WS handler integration** — receive `workspace.sync` / `workspace.tab-closed` / `workspace.reopen-tab`, send `workspace.state` / `workspace.closed-tabs`, capability negotiation
4. **closedTabsSlice** — client-side Redux slice
5. **workspaceSyncMiddleware** — client-side middleware (debounced push, pre-removal capture)
6. **Connection handler** — hydration logic on connect (fresh vs. existing state)
7. **Tab bar UI** — closed tabs rendering, reopen, dismiss
8. **Remove BackgroundSessions** — replace with closed tabs bar
9. **Cross-machine E2E tests**

---

## 14. Open Questions

1. **Should `updatedAt` be server-assigned?** Proposed yes (avoids clock skew). But this means a client can't tell if its local state is "newer" than the server's without comparing content. Alternative: use a monotonic counter instead of timestamp.

2. **Should closed tabs sync bidirectionally?** Current proposal: server is authoritative for closed tabs (clients only add/remove via WS messages). Alternative: clients could maintain their own closed tab lists and merge.

3. **Should we support "workspace profiles"?** (e.g., save/restore named layouts.) Out of scope for v1 but the data model supports it naturally — a workspace profile is just a named snapshot of the active workspace fields.

4. **Pane zoom state:** Currently ephemeral (not persisted). Should we sync it? Probably not — it's a transient view preference.
