# Tabs Registry Compact State Plan

Status: revised plan, based on `dev` at `71c0542d`
Worktree: `.worktrees/tabs-registry-device-snapshots-dev`
Branch: `feature/tabs-registry-device-snapshots-dev`

## Summary

The root problem is not that the Tabs view has too many visible tabs. The root problem is that the server persists every tab sync event forever in `~/.freshell/tabs-registry/tabs-registry.jsonl`, then reads and splits that whole file on startup.

Measured evidence from the production incident:

- `tabs-registry.jsonl`: about 291 MiB, 438,708 lines, about 1,367 unique tab keys.
- Standalone hydrate benchmark: about 1.14 GiB heap used during hydrate.
- Restart logs: first production heap sample about 1.275 GiB.
- Current code path:
  - `server/tabs-registry/store.ts` reads the whole JSONL file in the constructor.
  - `server/tabs-registry/store.ts` appends every accepted record.
  - `server/ws-handler.ts` handles `tabs.sync.push` by upserting each record one by one.

The correct fix is to remove the append-only event log from the active path and replace it with compact bounded state.

The initial "one snapshot per device" design is not safe. A Freshell device identity is persisted in `localStorage`, so multiple browser windows on the same machine share the same `deviceId`. If the server treats a whole-device snapshot as authoritative, a stale hidden window can erase tabs from an active window. The revised design separates ownership:

- Open tabs are replaceable per running browser instance, not per device.
- Closed tabs are retained as merged tombstones, not deleted by omission.
- Devices are grouped for display, but they are not the write-concurrency boundary.

## Plain-English Model

There are three identities:

1. Device
   - A durable local-machine identity stored in browser storage.
   - Used for display grouping: "This machine", "Studio Mac", etc.
   - Multiple browser windows can share it.

2. Client instance
   - A short-lived identity for one running Freshell browser app instance.
   - Created at app startup and not persisted across reloads.
   - This is the ownership boundary for open-tab snapshots.

3. Tab key
   - The stable key for one tab record.
   - Used to dedupe competing open/closed records with last-write-wins semantics.

The server stores compact state:

- `openSnapshotsByClient`: latest open snapshot from each active browser instance.
- `closedByTabKey`: latest closed tombstone for each recently closed tab.

On query, the server combines fresh open snapshots with recent closed tombstones, resolves conflicts by tab key, and returns:

- `localOpen`
- `remoteOpen`
- `closed`

This keeps the small useful state while removing the unbounded historical journal.

## Strategic Decisions

### 1. Open State Is Authoritative Only Per Client Instance

Rejected design:

- `deviceId -> records[]`
- A push replaces all records for that device.

Reason rejected:

- Multiple tabs/windows share `deviceId`.
- Stale windows can send incomplete state.
- Omitted records would become destructive.

Revised design:

- `(deviceId, clientInstanceId) -> open records[]`
- A push replaces only that client instance's open snapshot.
- Query aggregates all fresh client snapshots for a device.

This gives us replacement semantics without pretending there is only one writer per device.

### 2. Closed History Is a Tombstone Set

Closed tabs cannot be controlled by omission. `localClosed` is currently memory-only in Redux. If a browser reloads and immediately sends a replacement snapshot without its earlier closed records, that must not erase server-side recently closed history.

Revised rule:

- Incoming closed records merge into `closedByTabKey`.
- A closed record remains until it loses last-write-wins resolution or exceeds retention.
- Omission from a later push does not delete a closed tombstone.

This preserves the behavior users see today: recently closed tabs survive browser reloads and server restarts within retention.

### 3. Default Closed Retention Is 30 Days

The user-requested default is 30 days.

Rules:

- Default: 30 days.
- Allowed setting range: 1 to 30 days.
- Old browser preference values:
  - missing -> 30
  - 1..30 -> preserve
  - greater than 30 -> clamp to 30
- Server stores closed tombstones up to the max retention window, then query filters to the requested local setting.

The old 90-day and 365-day UI options go away.

### 4. Device Freshness Is Separate From Closed Retention

Remote open tabs should fall away when a device has not been seen recently.

Rules:

- Open snapshot freshness uses server receipt time, not record `updatedAt`.
- Default stale-client/device TTL: 7 days.
- A running idle browser should stay fresh via a low-frequency forced heartbeat/snapshot.
- `updatedAt` remains the conflict-resolution timestamp for a tab record.

This distinction matters:

- `snapshotReceivedAt` answers "is this browser instance still around?"
- `record.updatedAt` answers "which version of this tab record wins?"

### 5. Last-Write-Wins Must Still Resolve Open vs Closed

Query must not simply append all fresh open records and all recent closed records.

It must first combine candidate records by `tabKey` and select the newest record using the existing revision/updatedAt semantics:

- higher `revision` wins
- if revision ties, newer `updatedAt` wins

Then it returns winners by status.

This prevents a stale-but-fresh hidden window from resurrecting a tab that another window closed. The hidden window may keep sending its old open snapshot, but the newer closed tombstone wins for that `tabKey`.

### 6. No Silent Fallbacks

If compact state is corrupt, migration fails, or the registry is unavailable, return a clear server/client error. Do not silently serve an empty snapshot.

Atomic writes may keep a manual recovery copy, but the server should not automatically load an older backup as a hidden fallback without explicit approval.

## Proposed Server Data Shape

Add compact persistence under `~/.freshell/tabs-registry/`.

Preferred active file:

```text
device-snapshots.json
```

Shape:

```ts
type CompactTabsRegistryStateV1 = {
  version: 1
  savedAt: number
  deviceTtlDays: 7
  maxClosedRetentionDays: 30
  openSnapshotsByClient: Record<string, ClientOpenSnapshot>
  closedByTabKey: Record<string, RegistryTabRecord>
}

type ClientOpenSnapshot = {
  deviceId: string
  deviceLabel: string
  clientInstanceId: string
  snapshotRevision: number
  snapshotReceivedAt: number
  records: RegistryTabRecord[]
}
```

Snapshot key:

```ts
const clientSnapshotKey = `${deviceId}:${clientInstanceId}`
```

Important constraints:

- `records` in `ClientOpenSnapshot` must contain open records only.
- Incoming push payload may contain open and closed records.
- Server separates them:
  - open records replace that client's open snapshot
  - closed records merge into `closedByTabKey`

## Protocol Changes

Current push:

```ts
{
  type: 'tabs.sync.push',
  deviceId,
  deviceLabel,
  records,
}
```

Revised push:

```ts
{
  type: 'tabs.sync.push',
  deviceId,
  deviceLabel,
  clientInstanceId,
  snapshotRevision,
  records,
}
```

Rules:

- `clientInstanceId` is required.
- `snapshotRevision` is monotonically increasing per client instance.
- Server rejects same-key snapshots with `snapshotRevision <= current.snapshotRevision`.
- Server acks only after validation and atomic persistence succeed.
- Ack should describe replacement semantics, not claim `updated: records.length`.

Revised ack:

```ts
{
  type: 'tabs.sync.ack',
  accepted: true,
  openRecords: number,
  closedRecords: number,
}
```

Current query uses `rangeDays`. Revised query should use the semantic name:

```ts
{
  type: 'tabs.sync.query',
  requestId,
  deviceId,
  closedTabRetentionDays,
}
```

Rules:

- `closedTabRetentionDays` is required from updated clients.
- Schema clamps/rejects outside 1..30 at the WebSocket boundary.
- Prefer rejection with a clear error for invalid client payloads.

## Store API

Replace the current `upsert(record)` API with batch operations that match ownership.

```ts
type ReplaceClientSnapshotInput = {
  deviceId: string
  deviceLabel: string
  clientInstanceId: string
  snapshotRevision: number
  records: RegistryTabRecord[]
}

class TabsRegistryStore {
  static async open(rootDir: string, options?: TabsRegistryStoreOptions): Promise<TabsRegistryStore>

  async replaceClientSnapshot(input: ReplaceClientSnapshotInput): Promise<{
    accepted: boolean
    openRecords: number
    closedRecords: number
  }>

  async query(input: {
    deviceId: string
    closedTabRetentionDays: number
  }): Promise<TabsRegistryQueryResult>

  listDevices(): Array<{
    deviceId: string
    deviceLabel: string
    lastSeenAt: number
  }>

  count(): number
}
```

`open()` must be async because migration is streaming and must complete before the store is usable.

## Persistence Rules

Active persistence:

- Write compact JSON only.
- No active append-only JSONL.
- Write through a serialized write queue.
- Atomic write with temp file + rename.
- Validate compact state before accepting it into memory.

Caps:

- Max records per push: 500.
- Max open records per client snapshot: 500.
- Max closed records accepted per push: 500.
- Max panes per tab record: 20.
- Max serialized push bytes: 1 MiB.
- Max compact state bytes after pruning: 5 MiB.
- Max closed tombstones after retention pruning: 2,000 newest.

If caps are exceeded:

- Reject push.
- Send clear WS error.
- Do not truncate open snapshots silently.

Closed tombstones may be pruned by age and by the max-tombstone cap, keeping newest records first. That is not a fallback; it is an explicit retention policy.

## Query Algorithm

Inputs:

- `deviceId`
- `closedTabRetentionDays`
- `now`

Steps:

1. Prune stale client snapshots where `snapshotReceivedAt < now - 7 days`.
2. Prune closed tombstones older than max closed retention.
3. Build candidate records:
   - all open records from fresh client snapshots
   - all closed tombstones with `closedAt >= now - closedTabRetentionDays`
4. Resolve candidates by `tabKey` using existing LWW logic.
5. Split winners:
   - open + same `deviceId` -> `localOpen`
   - open + different `deviceId` -> `remoteOpen`
   - closed -> `closed`
6. Sort:
   - open by `updatedAt` descending
   - closed by `closedAt ?? updatedAt` descending

This preserves the current mental model while avoiding historical storage.

## Legacy Migration

Legacy file:

```text
tabs-registry.jsonl
```

Migration must be one-time and streaming.

Rules:

1. If compact file exists, do not read legacy JSONL.
2. If compact file does not exist and legacy JSONL exists, stream it line by line.
3. Parse each valid record with the existing schema.
4. Compute latest record per `tabKey` first.
5. Only after latest-per-tab resolution:
   - closed latest records within 30 days become `closedByTabKey`
   - open latest records are grouped into synthetic migrated snapshots by `deviceId`
6. Synthetic migrated snapshots use:
   - `clientInstanceId: 'legacy-migration'`
   - `snapshotRevision: 1`
   - `snapshotReceivedAt: max(updatedAt of grouped open records)`
7. The 7-day freshness rule naturally drops stale migrated open snapshots.
8. Write compact state atomically.
9. Rename legacy JSONL to an archived name only after compact write succeeds.

Archive name example:

```text
tabs-registry.jsonl.migrated-20260507-143012
```

Critical ordering:

- Do not prune closed records before latest-per-tab resolution.
- Otherwise an old closed tombstone could be discarded and an older open record could be resurrected.

Startup rule:

- Store opening must be awaited before `WsHandler` is created.
- If migration fails, startup should expose a clear registry error. Do not serve empty tab snapshots.

## Client Changes

### Client Instance Identity

Add a per-running-app `clientInstanceId`.

Rules:

- Generated once per loaded app instance.
- Not persisted in `localStorage`.
- Included in every `tabs.sync.push`.
- New browser window gets a different `clientInstanceId`.
- Browser reload gets a different `clientInstanceId`; the old snapshot falls away by TTL.

Candidate location:

- `src/store/tabRegistrySync.ts` local module state, or
- `tabRegistrySlice` state if UI/debug display needs it.

Prefer module state unless tests become cleaner with Redux state.

### Snapshot Revision

Keep a monotonic `snapshotRevision` per client instance.

Rules:

- Increment when sending a push.
- Do not use tab record revision for snapshot ordering.
- Server rejects stale snapshot revisions for the same `(deviceId, clientInstanceId)`.

### Push Behavior

Current behavior already builds records from:

- current open tabs
- `tabRegistry.localClosed`

Revised behavior:

- Keep sending open records for current tabs.
- Send closed records from local memory while they exist and are within retention.
- Do not rely on omission to delete server-side closed records.
- Add a forced heartbeat/snapshot interval so idle active browsers refresh `snapshotReceivedAt`.

Suggested intervals:

- Existing push interval remains 5 seconds for changed lifecycle state.
- Add forced heartbeat snapshot every 5 minutes while WebSocket is ready.
- Heartbeat can send the same compact payload with a new `snapshotRevision`.

### Closed Retention State

Rename client state:

- from `searchRangeDays`
- to `closedTabRetentionDays`

Default:

- 30

Browser preferences:

- Load old `tabs.searchRangeDays` for migration.
- Store new `tabs.closedTabRetentionDays`.
- Write only the new key after any preferences save.
- Clamp to 1..30.

Cross-tab sync:

- Update browser preference hydration to carry `closedTabRetentionDays`.
- Preserve pending local writes as current code does for `searchRangeDays`.

Tabs View:

- Replace `Last 30 days / Last 90 days / Last year` with bounded options:
  - `Last 1 day`
  - `Last 7 days`
  - `Last 14 days`
  - `Last 30 days`
- Default selected: `Last 30 days`.
- Always send the chosen retention to the server query.

Settings:

- Add a setting row for closed tab history if we want it outside the Tabs view.
- If only the Tabs view selector owns it, make the selector label clear enough.

Device management:

- Settings "Devices" should represent own device plus fresh remote open devices.
- Do not keep a remote device row alive solely because it has a closed tombstone retained for 30 days.
- Closed tab cards can still show the record's device label.

This satisfies both:

- remote open devices fall away after the freshness TTL
- closed tab history can remain visible for 30 days

## ServerInstanceId Rules

The current server overwrites pushed records with the connected server's `serverInstanceId`.

Keep that for live open snapshots from the current connection.

Be careful with closed records:

- If a closed record originated on the current server, preserving/overwriting to current server is fine.
- If closed records ever become persisted client-side, namespace them by `serverInstanceId` or clear them when the ready server changes.
- This plan avoids requiring client-side persisted closed history, so the immediate implementation can keep the current overwrite behavior.

Legacy migration should preserve the `serverInstanceId` already stored in each legacy record.

Reason:

- TabsView uses `serverInstanceId` to decide whether live terminal handles can be reused.
- Migration is restoring historical records, not re-authoring them through a live WebSocket connection.

## Implementation Phases

### Phase 1: Contract Tests For New Semantics

Add failing tests before implementation.

Server store unit tests:

- Open snapshot replacement is scoped to `(deviceId, clientInstanceId)`.
- Two client instances on the same device do not erase each other.
- Stale snapshot revision for the same client is rejected.
- Closed tombstone survives later open snapshot omission.
- Newer closed tombstone suppresses stale open record.
- Newer open record suppresses older closed tombstone.
- Query uses server receipt time for snapshot freshness.
- Closed retention defaults to 30 and clamps/rejects outside 1..30.
- Stale snapshots are pruned from query.
- Oversized pushes are rejected.
- Duplicate tab keys in one push are resolved or rejected explicitly.

Integration/persistence tests:

- Compact state rehydrates without JSONL.
- Legacy JSONL migration computes latest per tab before pruning.
- Old closed tombstone does not resurrect older open record.
- Legacy file is archived only after compact write succeeds.
- Startup awaits migration before WS can query.
- Corrupt compact file produces a clear error, not empty data.

WebSocket tests:

- `tabs.sync.push` requires `clientInstanceId` and `snapshotRevision`.
- Ack reports accepted/open/closed counts.
- Query requires/uses `closedTabRetentionDays`.
- `closedTabRetentionDays > 30` is rejected.
- Missing registry returns clear error for query, not empty snapshot.

Client tests:

- Sync includes `clientInstanceId` and increasing `snapshotRevision`.
- Forced heartbeat sends even when record fingerprint is unchanged.
- Closed records older than retention are not sent.
- Browser preference migration clamps old `searchRangeDays`.
- Cross-tab preference sync preserves pending local `closedTabRetentionDays`.
- Tabs view no longer offers 90/365.
- Settings devices are not kept alive solely by closed tombstones.

### Phase 2: Compact Store Types And Helpers

Modify:

- `server/tabs-registry/types.ts`
- `server/tabs-registry/store.ts`
- `server/tabs-registry/device-store.ts`

Add:

- compact state schema
- push input schema
- LWW helper shared by migration/query
- prune helpers
- size/cap validation
- atomic write helper

Keep imports NodeNext-compatible with `.js` extensions.

### Phase 3: Async Open And Migration

Modify:

- `server/tabs-registry/store.ts`
- `server/index.ts`

Replace synchronous constructor hydration with:

```ts
const tabsRegistryStore = await createTabsRegistryStore()
```

or:

```ts
const tabsRegistryStore = await TabsRegistryStore.open(...)
```

The factory must:

1. ensure directory exists
2. load compact state if present
3. otherwise migrate legacy JSONL if present
4. otherwise initialize empty compact state

No WebSocket handler should receive the store before this completes.

### Phase 4: WebSocket Protocol Wiring

Modify:

- `server/ws-handler.ts`
- `src/lib/ws-client.ts`
- `shared/ws-protocol.ts`
- related tests

Replace looped `upsert` calls with one store call:

```ts
await tabsRegistryStore.replaceClientSnapshot(...)
```

Do not send empty snapshots when the registry is unavailable. Send a clear error.

### Phase 5: Client Sync And Preferences

Modify:

- `src/store/tabRegistrySync.ts`
- `src/store/tabRegistrySlice.ts`
- `src/lib/browser-preferences.ts`
- `src/store/browserPreferencesPersistence.ts`
- `src/store/crossTabSync.ts`
- `src/store/selectors/tabsRegistrySelectors.ts`
- `src/store/types.ts`
- tests under `test/unit/client`

Add:

- `clientInstanceId`
- `snapshotRevision`
- heartbeat push
- retention rename/migration
- retention-aware closed pruning

Keep `localClosed` memory-only unless implementation proves a client-side persistence gap remains. Server tombstones should handle reload survival.

### Phase 6: Tabs View And Device UI

Modify:

- `src/components/TabsView.tsx`
- `src/components/settings/SafetySettings.tsx`
- `src/lib/known-devices.ts`
- relevant unit/e2e tests

Tabs View:

- remove 90/365 options
- default to 30
- send `closedTabRetentionDays`

Devices:

- base device rows on fresh open device presence
- keep aliases/dismissal behavior
- do not use closed-only records to keep stale devices alive

### Phase 7: Verification

Focused commands:

```bash
npm run test:vitest -- test/unit/server/tabs-registry/store.test.ts --run
npm run test:vitest -- --config vitest.server.config.ts test/integration/server/tabs-registry-store.persistence.test.ts --run
npm run test:vitest -- --config vitest.server.config.ts test/server/ws-tabs-registry.test.ts --run
npm run test:vitest -- test/unit/client/store/tabRegistrySync.test.ts test/unit/client/lib/browser-preferences.test.ts test/unit/client/store/browserPreferencesPersistence.test.ts test/unit/client/store/crossTabSync.test.ts --run
npm run test:vitest -- test/unit/client/components/TabsView.test.tsx test/unit/client/components/SettingsView.behavior.test.tsx --run
```

Then coordinated broad checks:

```bash
FRESHELL_TEST_SUMMARY="tabs registry compact state" npm run test:status
FRESHELL_TEST_SUMMARY="tabs registry compact state" npm run check
```

Manual perf verification:

1. Build from the worktree.
2. Copy a large legacy `tabs-registry.jsonl` fixture into a temp Freshell home.
3. Start production server on a unique port with that temp home.
4. Confirm startup does not read/split the full file into heap.
5. Confirm compact file is small.
6. Confirm legacy JSONL is archived.
7. Confirm remote tabs and recently closed tabs still appear correctly.

Expected result:

- No active `tabs-registry.jsonl` growth.
- Compact state well under a few MiB in normal use.
- Startup heap does not spike around 1 GiB from tabs registry hydrate.

## Acceptance Criteria

- Server no longer appends to active `tabs-registry.jsonl`.
- Server startup does not `readFileSync` and `split` a large tabs-registry JSONL file.
- Legacy migration streams line by line.
- Compact file is versioned and schema-validated.
- Open replacement is scoped to `(deviceId, clientInstanceId)`.
- Same-device multiple browser windows cannot erase each other's open tabs.
- Closed history survives browser reload and server restart for up to 30 days.
- Stale hidden-window open records cannot resurrect newer closed tabs.
- Remote open devices fall away after 7 days without server receipt.
- Idle active browser instances remain fresh through heartbeat.
- Retention default is 30 days.
- Retention setting is clamped/rejected to 1..30.
- 90-day and 365-day closed history options are gone.
- Query failures are explicit; no empty-snapshot fallback.
- Oversized/malformed pushes are rejected clearly.
- Existing Tabs behavior still works:
  - jump to local tab
  - pull remote tab copy
  - reopen closed tab
  - preserve pane snapshots
  - preserve serverInstanceId behavior for live handles
  - preserve device aliases and dismissal
- Focused tests pass.
- Coordinated `npm run check` passes before merge.

## Risks And Mitigations

Risk: client instance snapshots accumulate after browser crashes.

Mitigation:

- 7-day freshness TTL.
- Prune on query and write.

Risk: heartbeat creates needless writes.

Mitigation:

- Heartbeat interval is low frequency.
- Compact writes are bounded and small.
- Only refresh one client snapshot, not append history.

Risk: changing protocol breaks stale browser bundles.

Mitigation:

- Reject invalid/missing `clientInstanceId` with a clear error.
- Do not maintain a long-term compatibility fallback unless explicitly approved.

Risk: compact JSON still grows from bad clients.

Mitigation:

- hard caps on push size, records, panes, tombstones, and compact file size
- clear errors on rejection

Risk: migration drops useful current open tabs from idle devices.

Mitigation:

- migrated open snapshots use legacy `updatedAt` as freshness evidence
- current active browsers push immediately after reconnect/startup
- stale historical devices intentionally fall away

## Implementation Handoff

Implement this plan in the dev-based worktree:

```text
/home/user/code/freshell/.worktrees/tabs-registry-device-snapshots-dev
```

Use Red-Green-Refactor. Keep changes committed in the worktree after each coherent phase.
