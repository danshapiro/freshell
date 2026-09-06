# Host Pressure Pane Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

**Goal:** Freshell gains a `host-stats` pane — an at-a-glance host load dashboard (CPU, memory, paging, PSI, disk I/O, network, limits, Freshell's own footprint, plus on-request heavy measurements) that costs the host nothing while no pane watches it.

**Architecture:** One server-side collector (`server/host-stats/`) reads `/proc`+`/sys` directly on two cadence tiers (2s fast / 5s slow) ONLY while ≥1 WebSocket client is subscribed; heavier sections refresh strictly on explicit request (`hoststats.refresh`) with per-section time budgets, single-flight suppression, and previous-value retention on failure. Snapshots flow to subscribers over WS (`hoststats.snapshot`); the client renders tiles from a new `hostStatsSlice`, with an on-request group that shared-ramp desaturates (full color ≤30s → fully grey at 5min). The pane kind `host-stats` is gated by a new `hostStatsAvailable` feature flag (true on linux/wsl/darwin, false on win32). Full Rust-server parity: protocol discriminants in `crates/freshell-protocol`, collector in `crates/freshell-server/src/host_stats.rs`, flag in `build_platform_payload`.

**Tech Stack:** TypeScript/React/Redux Toolkit client (Vitest + Testing Library), Node/Express+ws server (Vitest + raw `ws` client tests), Rust workspace (cargo test), frozen wire contract (`npm run contract:generate` + `npm run test:port`).

## Global Constraints

- **Test command env:** every vitest/npm `test` command in this plan MUST be prefixed with `env -u FRESHELL_BIND_HOST` — the orchestrator session exports `FRESHELL_BIND_HOST=0.0.0.0`, which fails `test/unit/vite-config.test.ts` (3 tests) by design of `getNetworkHost()`. Unprefixed runs show a false failure.
- **Repo-owned test paths only:** focused vitest via `npm run test:vitest -- run <paths> [--config config/vitest/vitest.server.config.ts]`; never raw `npx vitest`. Broad suites go through the coordinated runner (`npm test` etc.) at Stage 5's gate, not per task.
- **Server is NodeNext/ESM:** relative imports in `server/`/`shared/` must include `.js` extensions.
- **Client MUST import shared protocol with `import type`** (no zod runtime in the bundle) — `shared/ws-protocol.ts:1-8`.
- **Frozen wire contract:** any change to `shared/ws-protocol.ts` requires `npm run contract:generate` and committing the regenerated `port/contract/*` artifacts in the SAME commit; `npm run test:port` and `cargo test -p freshell-protocol --locked` must pass (the Rust inventory tests at `crates/freshell-protocol/tests/inventory.rs` hardcode type counts — update the counts with the discriminants).
- **No `WS_PROTOCOL_VERSION` bump** — additive messages follow the accept-and-strip precedent (`shared/ws-protocol.ts:376-381` comment).
- **No new runtime dependencies.** Node ≥22.5.0 (package.json engines).
- **Collector rules:** recurring paths are direct `/proc`+`/sys` reads only — NO subprocesses ever in recurring paths; NO subprocess at all on darwin except the single allowed `ps` call inside the on-request refresh. All collector timers `.unref?.()`. All per-section failures degrade that section to `{ available: false }` — never fail a whole snapshot or response.
- **Structured logging:** pino child `logger.child({ component: 'host-stats' })`, fields-first, stable `event:` snake_case keys, errors carry `{ err }` (convention: `server/index.ts:169`, `server/perf-logger.ts`).
- **A11y:** real `<button>`/`<summary>` elements, `aria-label` on icon-only controls, `role="status"` on the verdict strip; `npm run lint` must stay clean.
- **Theme:** Tailwind semantic utilities ONLY (`bg-card`, `border-border`, `text-muted-foreground`, `text-success`, `bg-destructive/10 text-destructive`); no raw hex; no raw `hsl(var(--…))` except inside arbitrary values where opacity modifiers can't reach (convention: `plan-theme-tests.md` §1).
- **Persistence gate:** the new pane kind MUST be accepted by `src/store/paneTreeValidation.ts isPaneContentShape` or persisted panes silently vanish on reload.
- **Pane naming:** kind `host-stats`; WS namespace `hoststats.*`; feature flag `hostStatsAvailable`; picking label `Host Stats`.
- **Rust parity is mandatory**, not optional: the self-hosted production server is the Rust server.
- **No PR creation** until the user explicitly approves; branch `the-usual/host-pressure-pane` in this worktree only.
- **`docs/index.html`** is a nonfunctional mock — update only if the change is major (this pane qualifies as a pane-list addition; small edit).
- **README.md** is the only end-user doc location.

## Design contract (immutable while executing)

### Wire messages (additive, dot-namespaced)

Client→Server (zod, into `ClientMessageSchema`, `shared/ws-protocol.ts:701-733`):

```ts
export const HostStatsSubscribeSchema = z.object({
  type: z.literal('hoststats.subscribe'),
}).strict()

export const HostStatsUnsubscribeSchema = z.object({
  type: z.literal('hoststats.unsubscribe'),
}).strict()

export const HostStatsRefreshSchema = z.object({
  type: z.literal('hoststats.refresh'),
  requestId: z.string().min(1),
}).strict()
```

Server→Client (zod + `z.infer` aliases, into `ServerMessage` union, `shared/ws-protocol.ts:1178-1230`; server validates before send):

```ts
export const HostStatsSnapshotSchema = z.object({
  type: z.literal('hoststats.snapshot'),
  at: z.number().int().nonnegative(),          // server wall clock ms (epoch)
  live: HostStatsLiveSchema,
  manualAt: z.number().int().nonnegative().nullable(),  // last on-request refresh time; null = never
  manual: HostStatsManualSchema.nullable(),             // present when manualAt set
})
export type HostStatsSnapshotMessage = z.infer<typeof HostStatsSnapshotSchema>

export const HostStatsRefreshResponseSchema = z.object({
  type: z.literal('hoststats.refresh.response'),
  requestId: z.string().min(1),
  ok: z.boolean(),
  at: z.number().int().nonnegative().optional(),
  manual: HostStatsManualSchema.optional(),
  error: z.string().optional(),
})
export type HostStatsRefreshResponseMessage = z.infer<typeof HostStatsRefreshResponseSchema>
```

### Data schemas (shared, used by both snapshot+response)

```ts
const Avail = { available: z.boolean() }

export const HostStatsMachineSchema = z.object({
  cores: z.number().int().positive(),
  memTotalBytes: z.number().nonnegative(),
  platform: z.string(),                          // process.platform value
  wsl: z.boolean(),
  kernel: z.string().nullable(),                 // uname release; null on darwin fallback
  hostname: z.string().nullable(),
  // capability snapshot, computed once at service start (cheap dir listings/probes):
  psi: z.boolean(),                              // /proc/pressure readable
  cgroup: z.enum(['v1', 'v2', 'none']),
  thermalCount: z.number().int().nonnegative(),
  batteryPresent: z.boolean(),
  gpu: z.literal('none'),                        // GPU detection out of scope; chip renders 'n/a' truthfully
})

export const HostStatsLiveSchema = z.object({
  machine: HostStatsMachineSchema,
  cpu: z.object({
    ...Avail, usagePct: z.number().min(0).max(100),
    stealPct: z.number().min(0).max(100).nullable(),
    perCorePct: z.array(z.number().min(0).max(100)),
    freqMHz: z.number().nonnegative().nullable(),
  }),
  load: z.object({ ...Avail, load1: z.number(), load5: z.number(), load15: z.number(), cores: z.number().int().positive() }),
  memory: z.object({
    ...Avail, source: z.enum(['host', 'cgroup', 'processes']),
    totalBytes: z.number().nonnegative(), usedBytes: z.number().nonnegative(), availableBytes: z.number().nonnegative(),
    cgroupLimitBytes: z.number().nonnegative().nullable(),
    swapTotalBytes: z.number().nonnegative().nullable(), swapUsedBytes: z.number().nonnegative().nullable(),
  }),
  paging: z.object({
    ...Avail, swapInKbps: z.number().nonnegative(), swapOutKbps: z.number().nonnegative(),
    majFaultsPerSec: z.number().nonnegative(), oomKillsDelta: z.number().int().nonnegative(), oomKillsTotal: z.number().int().nonnegative(),
  }),
  psi: z.object({
    ...Avail,
    cpuSome10: z.number().nullable(), memSome10: z.number().nullable(), memFull10: z.number().nullable(),
    ioSome10: z.number().nullable(), ioFull10: z.number().nullable(),
  }),
  diskIo: z.object({
    ...Avail, readBps: z.number().nonnegative(), writeBps: z.number().nonnegative(),
    utilPct: z.number().min(0).max(100).nullable(), weightedAwaitMs: z.number().nonnegative().nullable(),
  }),
  network: z.object({
    ...Avail, rxBps: z.number().nonnegative(), txBps: z.number().nonnegative(),
    rxErrorsTotal: z.number().int().nonnegative(), txErrorsTotal: z.number().int().nonnegative(),
    rxDroppedTotal: z.number().int().nonnegative(), txDroppedTotal: z.number().int().nonnegative(),
    rxErrorsDelta: z.number().int().nonnegative(), txErrorsDelta: z.number().int().nonnegative(),      // last-tick deltas — server keeps prev tick
    rxDroppedDelta: z.number().int().nonnegative(), txDroppedDelta: z.number().int().nonnegative(),
  }),
  limits: z.object({
    ...Avail, fdsUsed: z.number().int().nonnegative().nullable(), fdsMax: z.number().int().nonnegative().nullable(),
    pidsUsed: z.number().int().nonnegative().nullable(), pidsMax: z.number().int().nonnegative().nullable(),
    timeWait: z.number().int().nonnegative().nullable(), ephemeralPorts: z.number().int().nonnegative().nullable(),
  }),
  freshell: z.object({
    ...Avail, source: z.enum(['node', 'rust']),
    ptysRunning: z.number().int().nonnegative(), ptysMax: z.number().int().nonnegative(),
    wsClients: z.number().int().nonnegative(), wsClientsMax: z.number().int().nonnegative(),
    eventLoopLagP99Ms: z.number().nonnegative().nullable(),   // rust: scheduler drift p99; null when unmeasurable
    rssBytes: z.number().nonnegative().nullable(), uptimeSec: z.number().nonnegative(),
  }),
})

export const HostStatsManualSchema = z.object({
  topProcesses: z.object({
    ...Avail, dwellMs: z.number().int().nonnegative(),
    list: z.array(z.object({
      pid: z.number().int().positive(), name: z.string(), cpuPct: z.number().min(0), rssBytes: z.number().nonnegative(),
      state: z.string(),                                   // single-char kernel state, or platform word
    })),
  }),
  processHealth: z.object({ ...Avail, zombies: z.number().int().nonnegative(), dState: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
  inotify: z.object({
    ...Avail, instances: z.number().int().nonnegative().nullable(), watches: z.number().int().nonnegative().nullable(),
    maxUserWatches: z.number().int().nonnegative().nullable(), maxUserInstances: z.number().int().nonnegative().nullable(),
  }),
  disks: z.object({
    ...Avail, list: z.array(z.object({
      mount: z.string(), totalBytes: z.number().nonnegative(), freeBytes: z.number().nonnegative(), usedPct: z.number().min(0).max(100),
      inodesTotal: z.number().nonnegative().nullable(), inodesFree: z.number().nonnegative().nullable(),
    })),
  }),
  thermals: z.object({
    ...Avail, zones: z.array(z.object({ label: z.string(), celsius: z.number() })),
    battery: z.object({ pct: z.number().min(0).max(100), status: z.string() }).nullable(),
  }),
  sectionErrors: z.record(z.string(), z.string()),        // section key -> short error string when budget/read failed
})
```

**Degraded-section rule (frozen):** a section that times out, throws, or is unsupported on the current platform returns its **FULL shape** with `available:false` and zero/empty/null/`[]` for every other field — never a bare `{available:false}` (per-section fields stay schema-required). UI renders '—' for every value when `available:false`. Live sections follow the same rule (`HostStatsLiveSchema` fields are non-optional with zero values when `available:false`).

### Cadence + cost contract

All timestamps are server wall-clock ms (epoch); all durations/rates are SI ms/KB(units named in the field). `eventLoopLagP99Ms` is **milliseconds of scheduler delay p99** per implementation: Node = `monitorEventLoopDelay` ns → ms conversion (÷1e6) folded per fast tick; Rust = drift p99 (expected interval vs actual wake) in ms per fast tick. The 50/500ms UI thresholds apply identically to both — both quantities mean "how late the runtime was to run its own timer".

- Fast tier `FRESHELL_HOST_STATS_FAST_MS` (default **2000**): `/proc/stat` CPU deltas, `/proc/loadavg`, `/proc/meminfo`, `/proc/vmstat` (paging rates, oom_kill), `/proc/pressure/*`, memory (cgroup-aware), event-loop lag histogram fold, `process.memoryUsage()`, PTY/WS counts.
- Slow tier `FRESHELL_HOST_STATS_SLOW_MS` (default **5000**): `/proc/diskstats`, `/proc/net/dev`, `/proc/net/tcp{,6}` state counts, fd count (`/proc/self/fd` dir walk, capped 1M), pids count (numeric `/proc` dirs, capped), cpu freq, ephemeral-port range read.
- On-request refresh (never automatic, never on pane open/subscribe): process-table scan (two samples, 300ms dwell — top CPU + zombies/D-state in ONE scan), `fs.statfs` on `/` and `/dev/shm` (skip shm on darwin), fdinfo inotify scan (bounded 4096 fds), thermal zones, battery. Per-section budget **2000ms** (Promise.race; timeout → `{available:false}` + `sectionErrors` entry), overall server cap **4000ms**, single in-flight (`this.pendingRefresh` promise shared), snapshot with `manual` broadcast to subscribers after completion.
- Client refresh deadline **6000ms**; on timeout/failure/close: previous values AND original `manualAt` preserved; error text shown. One in-flight request per client pane group (`refreshInFlight` in slice).
- Desaturation (client, one shared rate over the whole on-request group container): `saturation = at<=30s ? 1 : clamp(1-(age-30_000)/270_000, 0, 1)` via CSS `filter: saturate(s)`; age label `aria-live="polite"`.
- Subscription gating: per-`ClientState` boolean `hostStatsSubscribed`; 0→1 subscribe starts service timers AND immediately emits one snapshot to the subscriber; 1→0 (unsubscribe or `onClose` sweep) decrements; at 0 subscribers the service stops ALL timers (true zero cost). `hoststats.refresh` works without subscription.
- Snapshot payload is connection-level (not per-pane); N panes on one client = one subscription (client-side mount counter in slice).

### Pane/component contract

- Verdict strip (`role="status"`) computes overall status from the latest live snapshot: `ALL GOOD` (green) / `ELEVATED` (amber, names offenders) / `TROUBLE` (red). Offenders use the same per-tile status words: CPU `OK|BUSY|MAXED`, Memory `OK|TIGHT|FULL`, Paging `OK|SWAPPING|THRASHING`, PSI `OK|STALLED`, Disk I/O `OK|SLOW|STALLED`, Network `OK|ERRORS`, Limits `OK|TIGHT|FULL`, Freshell `OK|LAGGING|BLOCKED`.
- Status word mapping is a PURE function module `src/lib/host-stats-status.ts` (thresholds below), fully unit-tested; the component never embeds threshold logic.
- Thresholds: cpu.busy ≥80, cpu.maxed ≥95; memory.tight ≥85%, full ≥97%; paging.swapping when `swapInKbps+swapOutKbps > 0` (rate already smoothed over the 2s fast interval — single-snapshot semantics, no cross-tick state anywhere), thrashing when combined rate > 5000 KB/s; psi.stalled any full10 > 1.0; diskIo.slow weightedAwaitMs>20, stalled >100 (aggregation rule for multi-device hosts: worst device wins — `utilPct = max over devices of ΔtimeDoingIosMs/Δt*100`, `weightedAwaitMs` = that same device's `(ΔreadMs+ΔwriteMs)/(Δreads+Δwrites)`; a whole-device set never sums to >100 because max is taken) — null when no ios in window); network.errors when `rxErrorsDelta+txErrorsDelta+rxDroppedDelta+txDroppedDelta > 0`; limits.tight ≥70% of max, full ≥90% — evaluated per sub-limit (fds, pids, timeWait-share-of-ephemeral), worst sub-limit drives the tile; freshell.lagging lagP99>50ms, blocked >500ms. Load tile presentational only (no pill color), shows load1/cores.
- On-request group renders fully grey (saturate(0)) when `manualAt === null` — data values render as '—' placeholders, never literal zeros (zeros would lie: 0% used ≠ never measured). Degraded sections (`available:false` inside a filled manual) ALSO render '—' per value. This overrides any "zeros" phrasing elsewhere in this plan.
- Machine summary: native `<details>` disclosure (chips: PSI yes/no, cgroup v1/v2/no, thermals count, battery present, GPU n/a) built from `live.machine`; expanded body shows exact numbers.
- e2e tolerance: gVisor/Cloud Run may lack `/proc/pressure` — every section carries `available`; the e2e spec asserts structure + at least ONE of {cpu, memory, load} `available: true`, never PSI specifically.

### Headless demo/drive contract (preserved from prototype for manual QA only)

Not part of the shipped pane. The `/tmp/opencode/host-pressure-prototype.html` remains the visual reference; the React port must match its semantics (verdict strip, status pills, machine summary, on-request group, desaturation ramp) — not its pixel layout.

---

## Tasks

### Task 1: Wire protocol surface (TS + frozen contract + Rust types)

**Files:**
- Modify: `shared/ws-protocol.ts` (client schemas ~line 333-615 region / master union 701-733; server schemas ~120-124 region / `ServerMessage` union 1178-1230)
- Modify: `crates/freshell-protocol/src/client_messages.rs` (enum `ClientMessage` + `CLIENT_MESSAGE_TYPES`)
- Modify: `crates/freshell-protocol/src/server_messages.rs` (enum `ServerMessage` + `SERVER_MESSAGE_TYPES`)
- Modify: `crates/freshell-protocol/tests/inventory.rs` (hardcoded counts 31→34, 58→60, 89→94)
- Modify: `port/contract/ws-protocol.schema.json`, `ws-server-messages.schema.json`, `ws-message-inventory.json` (REGENERATED via `npm run contract:generate`)
- Test: `test/unit/shared/hoststats-protocol.test.ts` (new)

**Interfaces:**
- Produces: the six schemas + aliases exactly as specified in "Design contract / Wire messages"; types `HostStatsLive`, `HostStatsManual`, `HostStatsMachine` (z.infer).

- [ ] **Step 1: Write the failing behavioral test**

`test/unit/shared/hoststats-protocol.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  ClientMessageSchema, HostStatsSubscribeSchema, HostStatsUnsubscribeSchema, HostStatsRefreshSchema,
  HostStatsSnapshotSchema, HostStatsRefreshResponseSchema,
} from '../../../shared/ws-protocol'

const live = {
  machine: { cores: 12, memTotalBytes: 34_000_000_000, platform: 'linux', wsl: true, kernel: '6.6', hostname: 'h', psi: true, cgroup: 'v2', thermalCount: 1, batteryPresent: false, gpu: 'none' },
  cpu: { available: true, usagePct: 12.5, stealPct: 0, perCorePct: [1, 2], freqMHz: 3400 },
  load: { available: true, load1: 0.5, load5: 1, load15: 1.2, cores: 12 },
  memory: { available: true, source: 'host', totalBytes: 1, usedBytes: 1, availableBytes: 1, cgroupLimitBytes: null, swapTotalBytes: 0, swapUsedBytes: 0 },
  paging: { available: true, swapInKbps: 0, swapOutKbps: 0, majFaultsPerSec: 0, oomKillsDelta: 0, oomKillsTotal: 0 },
  psi: { available: true, cpuSome10: 0.1, memSome10: null, memFull10: null, ioSome10: 0.2, ioFull10: 0 },
  diskIo: { available: true, readBps: 0, writeBps: 0, utilPct: null, weightedAwaitMs: null },
  network: { available: true, rxBps: 0, txBps: 0, rxErrorsTotal: 0, txErrorsTotal: 0, rxDroppedTotal: 0, txDroppedTotal: 0, rxErrorsDelta: 0, txErrorsDelta: 0, rxDroppedDelta: 0, txDroppedDelta: 0 },
  limits: { available: true, fdsUsed: 128, fdsMax: 1048576, pidsUsed: 900, pidsMax: 4194304, timeWait: 42, ephemeralPorts: 28232 },
  freshell: { available: true, source: 'node', ptysRunning: 1, ptysMax: 50, wsClients: 2, wsClientsMax: 50, eventLoopLagP99Ms: 3.2, rssBytes: 900_000_000, uptimeSec: 100 },
}
const manual = {
  topProcesses: { available: true, dwellMs: 300, list: [{ pid: 5, name: 'node', cpuPct: 12.3, rssBytes: 1e6, state: 'S' }] },
  processHealth: { available: true, zombies: 0, dState: 0, total: 900 },
  inotify: { available: true, instances: 3, watches: 420, maxUserWatches: 1048576, maxUserInstances: 128 },
  disks: { available: true, list: [{ mount: '/', totalBytes: 1e12, freeBytes: 5e11, usedPct: 50, inodesTotal: 1e8, inodesFree: 9e7 }] },
  thermals: { available: true, zones: [{ label: 'cpu', celsius: 51.5 }], battery: null },
  sectionErrors: {},
}

describe('hoststats protocol', () => {
  it('accepts subscribe/unsubscribe/refresh client messages', () => {
    expect(() => ClientMessageSchema.parse({ type: 'hoststats.subscribe' })).not.toThrow()
    expect(() => ClientMessageSchema.parse({ type: 'hoststats.unsubscribe' })).not.toThrow()
    expect(() => ClientMessageSchema.parse({ type: 'hoststats.refresh', requestId: 'r1' })).not.toThrow()
  })
  it('rejects malformed client frames', () => {
    expect(HostStatsRefreshSchema.safeParse({ type: 'hoststats.refresh' }).success).toBe(false)
    expect(HostStatsRefreshSchema.safeParse({ type: 'hoststats.refresh', requestId: '' }).success).toBe(false)
    expect(HostStatsSubscribeSchema.safeParse({ type: 'hoststats.subscribe', sneaky: 1 }).success).toBe(false)
    expect(HostStatsUnsubscribeSchema.safeParse({ type: 'hoststats.unsubscribe' }).success).toBe(true)
  })
  it('validates a full snapshot and refresh response', () => {
    const snap = { type: 'hoststats.snapshot', at: 1_756_000_000_000, live, manualAt: null, manual: null }
    expect(HostStatsSnapshotSchema.safeParse(snap).success).toBe(true)
    expect(HostStatsSnapshotSchema.safeParse({ ...snap, live: { ...live, cpu: { ...live.cpu, usagePct: 101 } } }).success).toBe(false)
    expect(HostStatsRefreshResponseSchema.safeParse({ type: 'hoststats.refresh.response', requestId: 'r1', ok: true, at: 5, manual }).success).toBe(true)
    expect(HostStatsRefreshResponseSchema.safeParse({ type: 'hoststats.refresh.response', requestId: 'r1', ok: false, error: 'deadline' }).success).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/shared/hoststats-protocol.test.ts`

Expected: FAIL — `HostStatsSubscribeSchema` is not exported (module resolution error).

- [ ] **Step 3: Add the minimal production implementation**

In `shared/ws-protocol.ts`: add the client schemas near `CodexActivityListSchema` (line 420), the data schemas + server schemas near `CodexActivityUpdatedSchema` (line 120), register the three client schemas in `ClientMessageSchema` (701-733 alpha position), append `HostStatsSnapshotMessage | HostStatsRefreshResponseMessage` to the `ServerMessage` union.

In `crates/freshell-protocol/src/client_messages.rs`: add serde-tagged variants:

```rust
    #[serde(rename = "hoststats.subscribe")]
    HostStatsSubscribe,
    #[serde(rename = "hoststats.unsubscribe")]
    HostStatsUnsubscribe,
    #[serde(rename = "hoststats.refresh")]
    HostStatsRefresh(HostStatsRefresh),   // struct { request_id: String }
```

(`request_id` with `#[serde(rename = "requestId")]`), append the three type strings to `CLIENT_MESSAGE_TYPES` in inventory order, bump its length to 34. In `server_messages.rs`: add `HostStatsSnapshot(HostStatsSnapshot)` and `HostStatsRefreshResponse(HostStatsRefreshResponse)` variants + full payload structs mirroring the zod shapes. **Serde discipline (critical, LB14 + review finding):** fields that are zod `.nullable()` (ie. REQUIRED-but-may-be-null on the wire: `freqMHz`, `stealPct`, `cgroupLimitBytes`, `swapTotalBytes`/`swapUsedBytes`, PSI avg fields, `utilPct`, `weightedAwaitMs`, all `limits.*Used/*Max`, `eventLoopLagP99Ms`, `rssBytes`, `kernel`, `hostname`, `battery`, `manualAt`, `manual`) map to `Option<T>` that ALWAYS serialize (null allowed) with NO skip attr; fields that are zod `.optional()` (ie. MAY-be-absent: `refresh.response.at/manual/error`) map to `Option<T>` PLUS `#[serde(skip_serializing_if = "Option::is_none", default)]` — never serialized as explicit null. `sectionErrors`: `HashMap<String,String>`; casing: match the file's existing convention (`rename_all = "camelCase"` if that's what the neighbors use — verify; the shape-pin test below pins it either way). Append the two server discriminants to `SERVER_MESSAGE_TYPES` → 60. Update `crates/freshell-protocol/tests/inventory.rs` counts: 31→34, 58→60, 89→94.

Also add a FIELD-LEVEL drift pin (LB14 — the inventory test only pins discriminant names, not shapes): new test file `crates/freshell-protocol/tests/hoststats_shape.rs` — TWO cases: (a) a fully-populated `HostStatsSnapshot` asserting the exact key set + camelCase spelling (nested sections included) against a committed expected JSON literal, and (b) a bare `HostStatsRefreshResponse { request_id, ok:true }` asserting `at`/`manual`/`error` keys are ABSENT (not null) and a `HostStatsSnapshot` with `manual_at: None` asserting `"manualAt": null` IS present — pinning the nullable-vs-optional serde split from both sides.

- [ ] **Step 4: Run the focused test**

Run: `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/shared/hoststats-protocol.test.ts && npm run contract:generate && cargo test -p freshell-protocol --locked`

Expected: all PASS; `git status` shows regenerated `port/contract/*` modified (inventory now 34/60).

- [ ] **Step 5: Refactor while green**

Schema field order alphabetical within each object (file convention). No other cleanup expected.

- [ ] **Step 6: Run impacted-test verification**

Impacted: everything importing the protocol (client+server), the port contract freeze test, Rust protocol tests.

Run: `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/shared test/server/ws-protocol.test.ts && env -u FRESHELL_BIND_HOST npm run test:port && cargo test -p freshell-protocol --locked`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add shared/ws-protocol.ts crates/freshell-protocol port/contract test/unit/shared/hoststats-protocol.test.ts
git commit -m "feat(host-stats): add hoststats.* wire protocol surface (TS+Rust+contract)"
```

---

### Task 2: Node collector readers (pure, fixture-parsed `/proc`+`/sys`)

**Files:**
- Create: `server/host-stats/readers.ts`
- Create: `test/unit/server/host-stats/readers.test.ts`
- Create: `test/fixtures/host-stats/proc/…` + `…/sys/…` fixture trees (see below)

**Interfaces:**
- Consumes: nothing repo-internal; `node:fs`, `node:os`.
- Produces (all sync unless noted; path-injected roots; never throw — return `null` on read/parse failure):

```ts
// server/host-stats/readers.ts
export type CpuTimes = { total: number; busy: number; steal: number; perCore: { total: number; busy: number }[] }
export function readCpuTimes(procRoot?: string): CpuTimes | null                  // '/proc/stat' aggregated + per-core, steal jiffies
export function readLoadavg(procRoot?: string): { load1: number; load5: number; load15: number } | null  // mac: os.loadavg()
export function readMeminfo(procRoot?: string): { totalKB: number; availKB: number; swapTotalKB: number; swapFreeKB: number } | null  // mac: null (caller uses os)
export function readCgroupMemory(cgroupRoot?: string, procRoot?: string): { limitBytes: number | null; currentBytes: number } | null  // resolves THIS process's cgroup leaf from <procRoot>/self/cgroup (v2: '0::/path' → <cgroupRoot><path>/memory.current+memory.max ('max'→null); v1: 'memory' controller line → <cgroupRoot>/memory<path>/usage_in_bytes+limit_in_bytes with garbage filter limit ≥ 2^60 → null); root-of-cgroup2 has NO limit files by design — never read the fs root; none/unreadable → null
export function readVmstat(procRoot?: string): { pswpin: number; pswpout: number; pgmajfault: number; oomKill: number | null } | null
export function readPsi(procRoot?: string): { cpuSome10: number | null; memSome10: number | null; memFull10: number | null; ioSome10: number | null; ioFull10: number | null } | null
export function readDiskStats(procRoot?: string): Map<string, { readsCompleted: number; readMs: number; writesCompleted: number; writeMs: number; readSectors: number; writtenSectors: number; timeDoingIosMs: number }> | null  // /proc/diskstats fields 1,4,5,8,3,7,10 (1-indexed per kernel iostats doc); whole devices only (skip partitions/loop/ram)
export function readNetDev(procRoot?: string): { rxBytes: number; txBytes: number; rxErr: number; txErr: number; rxDrop: number; txDrop: number } | null
export function readTcpStateCounts(procRoot?: string): { timeWait: number } | null  // state '06' across tcp+tcp6
export function readEphemeralPortRange(procRoot?: string): { start: number; end: number } | null
export function readSelfFdCount(procRoot?: string): number | null                   // entries of /proc/self/fd, cap 1_048_576
export function readPidCount(procRoot?: string): number | null                      // numeric /proc entries, cap 10_000_000
export function readPidsLimit(procRoot?: string, cgroupRoot?: string): number | null  // BINDING process cap: cgroup v2 leaf `pids.max` ('max'→null → fallback) else cgroup v1 `pids.max`, else `/proc/sys/kernel/threads-max`. (PID-number `/proc/sys/kernel/pid_max` is a wrap boundary, NOT a creatable-process cap — do not use it as the limit; validated R3M2.)
export function readSelfLimitsFdsMax(procRoot?: string): number | null              // 'Max open files' SOFT limit
export function readSelfInotifyStats(procRoot?: string): { instances: number; watches: number } | null  // bounded scan: /proc/self/fd entries (cap 4096) where readlink target starts 'anon_inode:inotify' → instances++; /proc/self/fdinfo/<fd> lines starting 'inotify' → watches++
export function readInotifyLimits(procRoot?: string): { maxUserWatches: number | null; maxUserInstances: number | null } | null  // /proc/sys/fs/inotify/max_user_{watches,instances}
export function readCpuFreqMHz(sysRoot?: string): number | null                     // mean scaling_cur_freq kHz→MHz
export function readMachineInfo(procRoot?: string, sysRoot?: string): HostStatsMachine
export function statfsInfo(mount: string): { totalBytes: number; freeBytes: number; usedPct: number; inodesTotal: number | null; inodesFree: number | null } | null
export function readThermals(sysRoot?: string): { label: string; celsius: number }[] | null   // ≤16 zones; null if missing dir
export function readBattery(sysRoot?: string): { pct: number; status: string } | null
export async function scanProcessTable(procRoot: string | null, dwellMs: number, deadlineMs: number): Promise<{ top: { pid: number; name: string; cpuPct: number; rssBytes: number; state: string }[]; zombies: number; dState: number; total: number } | null>
// deadlineMs is an absolute epoch-ms budget from the caller (service section budget): checked BEFORE each pid unit of work; on expiry throws DeadlineExceeded.
export const __testInternals: { computeCpuPct(deltaJiffies: number, dwellMs: number): number; parsePsOutput(text: string): …; isWholeDevice(name: string): boolean }
```

`scanProcessTable` (procRoot `null` → darwin path): Linux/WSL — enumerate numeric `/proc` dirs (cap 100k), read `/proc/<pid>/stat` bounded 4096B (via async `fsp.readFile` between-cooperative-deadline-checks per pid — see Task 3 deadline contract), comm-split after LAST `)` (precedent `server/coding-cli/codex-child-registry.ts:143-154`), sample A utime+stime, wait `dwellMs`, sample B, `cpuPct = (b-a)/USER_HZ/(dwell/1000)*100` — USER_HZ=100 holds on every Linux arch this project targets (it is the field's documented ABI exposure in practice; document as an assumption comment, clamp computed cpuPct to [0, 100*cores] defensively); sort desc, top 12; zombies/D-state from state char field; **rssBytes from `/proc/<pid>/status` `VmRSS` (kB → bytes), NOT stat rss pages × 4096** — VmRSS removes the page-size assumption entirely (aarch64 16K/64K pages would silently 16×-inflate RSS via stat). Per-proc cost: 2 bounded reads (stat + status) at on-request cadence only — well within the 2000ms section budget. Darwin — ONLY subprocess in the whole feature: `ps -Aceo pid,pcpu,rss,stat,comm` with 2000ms hard timeout, top 12 by pcpu (rss KB→bytes), zombies = STAT contains 'Z', dState = contains 'U' or 'D'.

`statfsInfo` uses `statfsSync(mount)` (Node ≥22.5; returns `{bsize,blocks,bavail,files,ffree}`): `totalBytes = bsize*blocks`, `freeBytes = bsize*bavail` (unprivileged view), `usedPct = (1 - bavail/blocks)*100`, inodes from `files/ffree` (null when 0/0).

Fixtures under `test/fixtures/host-stats/`: `proc/stat` (16 cores, steal>0), `loadavg`, `meminfo` (64GB + swap), `vmstat`, `pressure/{cpu,memory,io}`, `diskstats` (sda + sda1 + loop0 + nvme0n1 + nvme0n1p1 → whole-device filter assertion), `net/dev` (lo+eth0+docker0), `net/tcp`+`net/tcp6` (exactly 3 TIME_WAIT), `sys/net/ipv4/ip_local_port_range`, `sys/kernel/threads-max`, `self/limits`, `self/fd` (6 fds: 3 inotify anon-inode via readlink-indirection fixture note: fd fixtures need real symlinks — use a tempdir with real `fs.symlinkSync('anon_inode:inotify', …)` created by the test at setup, NOT committed symlinks) + `self/fdinfo/<fd>` (matching inotify watch counts), `sys/fs/inotify/max_user_{watches,instances}`, `procmini/<pid>/stat` + `procmini/<pid>/status` (VmRSS) ×7 (incl. one Z, one D, one comm-with-parens), `procmini/self/cgroup` v2 leaf sample (`0::/user.slice/.../app.slice/freshell-rust.service`), cgroup v2 leaf tree `sys/fs/cgroup/user.slice/.../freshell-rust.service/{memory.current,memory.max,pids.current,pids.max}` (leaf resolution proof; fs root deliberately has NO such files), cgroup-absent empty dir, `sys/class/thermal/thermal_zone0/{temp,type}`, `sys/class/power_supply/BAT0/{type,capacity,status}`, `sys/devices/system/cpu/cpu{0,1}/cpufreq/scaling_cur_freq`.

- [ ] **Step 1: Write the failing behavioral test**

`test/unit/server/host-stats/readers.test.ts` — exact-value assertions per fixture (deltas across two fixture copies for cpu/net/disk rates computed by caller; `timeWait === 3`; cgroup v2 limit parse; absent cgroup → null; thermal 51.5; battery 87 'Discharging'; `parsePsOutput` on a darwin ps fixture; negative cases: missing file → null, truncated stat → process skipped not thrown). Rate computation is the SERVICE's job (delta of cumulative readers), so tests for readers assert cumulative values verbatim.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/server/host-stats/readers.test.ts --config config/vitest/vitest.server.config.ts`

Expected: FAIL — `server/host-stats/readers.js` does not exist.

- [ ] **Step 3: Add the minimal production implementation**

Implement `readers.ts` per contract; write the fixture trees (they are part of this task's test data).

- [ ] **Step 4: Run the focused test**

Run: `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/server/host-stats/readers.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Extract shared `safeRead`/line-split helpers if duplicated >2×. Keep functions pure and synchronous except `scanProcessTable`.

- [ ] **Step 6: Run impacted-test verification**

New module, no existing callers. Nearest neighbors: this test + Task 1 protocol test. Check which vitest config owns `test/unit/server/**` (`config/vitest/vitest.config.ts:29-53` exclude list vs `vitest.server.config.ts:27-28` include list — it is excluded from neither server include nor default exclude for unit? `vitest.config.ts` excludes `test/unit/server/**` per line ~35; so unit/server runs under the SERVER config) — run:

Run: `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/server/host-stats --config config/vitest/vitest.server.config.ts`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add server/host-stats/readers.ts test/unit/server/host-stats/readers.test.ts test/fixtures/host-stats
git diff --cached --stat   # verify: ONLY the listed paths staged — never `git add <dir>`
git commit -m "feat(host-stats): /proc+/sys reader layer with fixture-based parser tests"
```

---

### Task 3: Node `HostStatsService` (tiers, gating, refresh single-flight)

**Files:**
- Create: `server/host-stats/service.ts`
- Test: `test/unit/server/host-stats/service.test.ts`

**Interfaces:**
- Consumes: `./readers.js` (Task 2); protocol types `HostStatsLive`, `HostStatsManual` (Task 1 — import from `shared/ws-protocol.js` is fine server-side).
- Produces:

```ts
export interface HostStatsServiceDeps {
  procRoot?: string            // test injection; default per platform
  sysRoot?: string
  fastMs?: number              // default env FRESHELL_HOST_STATS_FAST_MS || 2000
  slowMs?: number              // default env FRESHELL_HOST_STATS_SLOW_MS || 5000
  sectionBudgetMs?: number     // default 2000
  overallBudgetMs?: number     // default 4000
  getPtyCounts?: () => { running: number; max: number }        // OPTIONAL seed; real wiring comes via setSources (below)
  getWsClientCounts?: () => { clients: number; max: number }   // OPTIONAL seed; same
  now?: () => number           // test injection
}
export class HostStatsService {
  constructor(deps?: HostStatsServiceDeps)   // probes machine capabilities once: psi readable?, cgroup v1/v2/none (via /proc/self/cgroup + leaf files), thermalCount (dir listing, cheap), batteryPresent (dir listing, cheap) — all degraded-safe
  setSources(src: { getPtyCounts?: () => { running: number; max: number }; getWsClientCounts?: () => { clients: number; max: number } }): void  // called AFTER WsHandler exists (chicken-egg fix); seeds used until then
  start(): void                // begins fast+slow timers; enables own event-loop histogram (perf_hooks.monitorEventLoopDelay)
  stop(): void                 // clears all timers, disables+nulls histogram. Idempotent.
  isRunning(): boolean
  getSnapshot(): { at: number; live: HostStatsLive; manualAt: number | null; manual: HostStatsManual | null }  // builds from cached sections; NEVER waits on I/O newer than last tick (ticks write caches)
  onSnapshot(cb: ((snap: { at: number; live: HostStatsLive; manualAt: number | null; manual: HostStatsManual | null }) => void) | null): void  // single-listener slot; cb fired after every fast tick; null clears. Asserted by the service test.
  refresh(): Promise<{ at: number; manual: HostStatsManual }>   // single-flight; per-section Promise.race budgets; sections run concurrently
  readonly runningChanged?: …  // see test seam note below
}
```

Behavior contract (the test file asserts every line):
1. `start()` installs two `.unref?.()`'d intervals; slow tier reads only the slow readers; rates (cpu%, paging rates, disk r/w Bps, net rx/tx Bps) computed from cumulative reader deltas over dt; first tick populates with null-safe zeros where a delta isn't possible yet. **Darwin CPU path:** `/proc/stat` is Linux-only, yet darwin must show CPU (R3M5) — the fast tier branches on `process.platform`: darwin computes usage from `os.cpus()` times deltas ([user+nice+sys] / total per core, steal always null) — a direct Node API, no subprocess; PSI/diskIo/network/tcp/inotify stay `available:false` there; Rust collector on darwin reports `cpu.available:false` (no /proc path; CPU via os.cpus() is Node-only — noted divergence, macOS is not self-hosted production).
2. Memory precedence (VALIDATED on the real service: the running Freshell itself sits in an unlimited cgroup — `memory.current=16.2GB, memory.max=max` — so this rule is exercised daily): cgroup leaf resolved from `/proc/self/cgroup`; when the finite limit exists (`memory.max` ≠ 'max'), `source='cgroup'`, `totalBytes=limitBytes`, `usedBytes=currentBytes`, `availableBytes=max(0, limit−current)`, `cgroupLimitBytes=limitBytes`; when unlimited (max='max') or absent, `source='host'` and ALL totals come from host `/proc/meminfo` (`totalBytes=MemTotal`, `availableBytes=MemAvailable`, `usedBytes=total−avail`, `cgroupLimitBytes=null`) — never mix a cgroup `current` with a host total. Darwin: `os.totalmem()/freemem()` same shape, source 'host'.
3. `freshell.eventLoopLagP99Ms` — own histogram: enable at start; each fast tick read p99 → `histogram.reset()`; darwin/win… only while running.
4. `freshell.ptys*/ws*` come from `setSources`-injected (or constructor-seeded) providers — `getWsClientCounts` is wired with the real WsHandler in index.ts via `hostStats.setSources(...)` after handler construction.
5. Nothing is collected while stopped: test spies on reader functions (vi.mock the readers module) → after `stop()`, advancing fake timers calls zero reader fns.
6. `refresh()` single-flight AND post-completion cooldown: two concurrent calls return the SAME promise; a call arriving <1s AFTER the previous completion is also rejected (no re-start stampede — R3M6 reinforcement). **Budgets are COOPERATIVE, not `Promise.race`-around-sync:** every section implementation is async (`fsp.*` / awaited dwell), receives a shared `deadline = now()+sectionBudgetMs`, checks `Date.now() > deadline` before each unit of work (per pid in the table scan, per fd in the fdinfo scan — `scanProcessTable`'s `deadlineMs` param exists for exactly this, R2M2), and throws `DeadlineExceeded` early when exceeded; synchronous preemption is unnecessary since each unit is microseconds. A final `overallBudgetMs` watchdog (4000ms) marks any still-running section failed; cleared in `finally`. On section failure the OTHER sections still complete; failed section → full zero-shape + `available:false` + `sectionErrors` entry.
7. On Linux/WSL, `darwin`-only paths are never attempted; on darwin, `/proc`-dependent sections return their full zero-shape with `available:false` without attempting reads.
8. `getSnapshot()` before `start()` or with zero ticks returns a structurally valid snapshot with every section `available:false` (machine filled) — this is what a fresh subscriber receives.
9. A successful `refresh()` immediately fires the `onSnapshot` listener with the merged snapshot (live cache may be one tick stale; `manual`/`manualAt` fresh), so watching clients update without waiting for the next fast tick.

- [ ] **Step 1: Write the failing behavioral test**

`test/unit/server/host-stats/service.test.ts` with `vi.mock('../readers.js')` (…path per module layout — the readers module fully mocked with vi.fn()s) + `vi.useFakeTimers()`. Assert: start→one immediate tick shape; fast ticks at 2s advance, slow at 5s (advance 6s → 3 fast, 1 slow); rates from cumulative deltas correct; stop→no further reader calls; snapshot-without-start all-unavailable; refresh single-flight identity; refresh section timeout degrades only that section; refresh failure keeps prior manual in subsequent snapshot.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/server/host-stats/service.test.ts --config config/vitest/vitest.server.config.ts`

Expected: FAIL — module absent.

- [ ] **Step 3: Add the minimal production implementation**

Implement `server/host-stats/service.ts` per the contract. Histogram: `import { monitorEventLoopDelay } from 'node:perf_hooks'`; guard `histogram?.enable()/.disable()/.reset()`. Logging on budget-exceeded refresh sections: `log.warn({ event: 'host_stats_section_timeout', section, budgetMs }, …)`.

- [ ] **Step 4: Run the focused test**

Run: `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/server/host-stats/service.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Factor the per-section refresh table as a data-driven list `[{ key, run }]` so Task 9's Rust port mirrors the same section list; no other refactors.

- [ ] **Step 6: Run impacted-test verification**

Run: `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/server/host-stats --config config/vitest/vitest.server.config.ts`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add server/host-stats/service.ts test/unit/server/host-stats/service.test.ts
git diff --cached --stat   # verify: ONLY the listed paths staged — never `git add <dir>`
git commit -m "feat(host-stats): subscriber-gated two-tier collector service with single-flight refresh"
```

---

### Task 4: Node ws-handler wiring + service wiring in `server/index.ts`

**Files:**
- Modify: `server/ws-handler.ts` (ClientState 474-491; onConnection init 1177-1194; onClose 1227-1264; `rebuildClientMessageSchema` 820-852; switch 2059+; `close()`)
- Modify: `server/terminal-registry.ts` (add a public getter `getMaxTerminals(): number { return this.maxTerminals }` — the cap is currently a private field with no exposure; one-line getter, no behavior change; plus a one-line unit test in the nearest registry test that the getter returns the constructed max)
- Modify: `server/index.ts` (construct service near `sessionsSync` ~537; inject into `new WsHandler(...)` options object ~406-443; shutdown step near :1263)
- Test: `test/server/ws-hoststats.test.ts` (new)

**Interfaces:**
- Consumes: `HostStatsService` (Task 3); `HostStats*Schema`s (Task 1).
- Produces: `WsHandlerOptions.hostStats?: HostStatsService`. index.ts constructs the service (no providers), passes it in options, then — AFTER the handler exists — calls `hostStats.setSources({ getPtyCounts, getWsClientCounts })` where `getPtyCounts` uses `registry.getDiagnosticCounts().terminals.running` + `registry.getMaxTerminals()` (getter added in this task) and `getWsClientCounts` closes over the handler's `connectionCount()` + configured max (same source as :240).

Behavior contract:
1. `case 'hoststats.subscribe'`: set `state.hostStatsSubscribed = true`; if the handler-level subscriber count went 0→1, call `service.start()`; immediately `send` the current snapshot to THIS socket (validate via `HostStatsSnapshotSchema.safeParse`, warn+log on failure).
2. `case 'hoststats.unsubscribe'`: clear the flag; count 1→0 → `service.stop()`.
3. Snapshot fan-out: the handler owns the tick subscription — implement `service.onSnapshot(listener)` hot path? NO — simpler: handler passes an `onSnapshot` callback in `WsHandlerOptions.hostStats`: Task 3's service emits each freshly-ticked snapshot to a single registered listener; the handler listener iterates `clientStates` and `safeSend`s to subscribed+authenticated sockets (`broadcastSessionStatus` shape, ws-handler.ts:867-875). Add `onSnapshot(cb)` public method to the service (single listener, set at wiring time; fine with a one-listener field — assert in service test).
4. `case 'hoststats.refresh'`: `service.refresh()` → on resolve `send` `hoststats.refresh.response {ok:true, at, manual}`; on reject `{ok:false, error}`. Every requester gets its own response with its OWN requestId even when the underlying refresh is shared (handler keeps a per-request closure — trivially true with async/await). Per-connection rate floor: if the same connection sent a refresh <1000ms before the new one, respond `{ok:false, error:'rate_limited'}` WITHOUT invoking the service (track `state.hostStatsLastRefreshAt`; resets in onClose implicitly with state). Additionally the SERVICE enforces a post-completion minimum interval: `refresh()` rejects with `rate_limited` when called <1000ms after the last completed refresh START (tracked inside the service, connection-agnostic — closes the multi-connection bypass, R3M6); single-flight covers concurrency, this covers back-to-back. Refresh is heavy (300ms table dwell) and must not sustain a 100% duty cycle from any socket or across sockets.
5. `onClose`: if `state.hostStatsSubscribed`, clear + decrement; 1→0 stops service. Mirror in `close()` (server shutdown path) → `service.stop()` also added to index.ts teardown near sessionsSync.shutdown().
6. Auth gate: hoststats messages are non-hello → covered by existing NOT_AUTHENTICATED gate (verify by test).

- [ ] **Step 1: Write the failing behavioral test**

`test/server/ws-hoststats.test.ts` cloning `test/server/ws-codex-activity.test.ts` scaffolding (FakeRegistry, listen-on-port-0, hello→ready dance, waitForMessage/expectNoMatchingMessage helpers) with a REAL `HostStatsService` whose deps use `fastMs: 25, slowMs: 50, procRoot/sysRoot: fixture roots` (reuse Task 2 fixtures dir). Cases:
  (a) subscribe → immediate snapshot (schema-shaped, `machine.cores > 0`), then ≥2 more within 300ms (fastMs 25);
  (b) snapshot values: cpu/load/memory available with fixture-consistent load value;
  (c) unsubscribe → `expectNoMatchingMessage(type==='hoststats.snapshot', 150ms)`;
  (d) socket close mid-subscription → service stops (assert `service.isRunning() === false` after a second socket unsubscribes/closes as last subscriber);
  (e) refresh → response with matching requestId, `manual.disks.list` non-empty for fixture mounts… note: statfs runs against the real host (mounts '/', plus '/dev/shm' if present) — assert shape+numerically sane, not fixture-exact; section timeout path: bump `sectionBudgetMs: 1` with a process table fixture forcing dwell > budget → `topProcesses.available === false`, response still ok:true;
  (f) unauthenticated socket sending subscribe → no snapshot (existing auth gate);
  (g) zero-subscriber zero-cost: with no subscription assert `service.isRunning() === false` before subscribe; and
  (h) refresh rate floor: two refreshes from the same socket 100ms apart → second yields `{ok:false, error:'rate_limited'}` and the service refresh spy was called once; AND a refresh arriving 100ms after the FIRST completes (fresh request, both under per-conn floor) is rejected by the service-level post-completion interval.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/server/ws-hoststats.test.ts --config config/vitest/vitest.server.config.ts`

Expected: FAIL — `hoststats.subscribe` rejected by `rebuildClientMessageSchema` union (INVALID_MESSAGE).

- [ ] **Step 3: Add the minimal production implementation**

The three switch cases + ClientState fields (`hostStatsSubscribed`, `hostStatsLastRefreshAt`) + onClose sweep + union registration + `sendSnapshotTo` helper, per the contract; index.ts: construct `const hostStats = new HostStatsService()` after registry, pass in WsHandler options, then `hostStats.setSources({ getPtyCounts: () => ({ running: registry.getDiagnosticCounts().terminals.running, max: registry.getMaxTerminals() }), getWsClientCounts: () => ({ clients: wsHandler.connectionCount(), max: wsHandlerMaxConnections }) })` after the handler is built; `hostStats.stop()` in teardown. (`wsHandlerMaxConnections` = the same `maxConnections` value the handler is constructed with.)

- [ ] **Step 4: Run the focused test**

Run: `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/server/ws-hoststats.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

If the three cases share subscriber bookkeeping, extract `setHostStatsSubscribed(state, ws, subscribed)` private method. Keep the switch cases small.

- [ ] **Step 6: Run impacted-test verification**

ws-handler touches everything ws: run the full server-side ws suite + index wiring tests.

Run: `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/server --config config/vitest/vitest.server.config.ts && env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/server/host-stats --config config/vitest/vitest.server.config.ts`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add server/ws-handler.ts server/index.ts server/terminal-registry.ts server/host-stats test/server/ws-hoststats.test.ts test/unit/server
git commit -m "feat(host-stats): ws subscribe/unsubscribe/refresh wiring with subscriber-gated sampling + registry getMaxTerminals"
```

---

### Task 5: `hostStatsAvailable` feature flag (Node + Rust)

**Files:**
- Modify: `server/platform-router.ts` (`detectFeatureFlags` 20-29)
- Modify: `crates/freshell-server/src/main.rs` (`build_platform_payload` 2436-2449)
- Test: `test/unit/server/platform-flags.test.ts` (new; runs under the SERVER vitest config per LB5 — `config/vitest/vitest.server.config.ts:29` includes `test/unit/server/**/*.test.ts`)
- Test: the existing Rust payload tests near `main.rs:3516/3592/3606` — extend nearest one to assert flag present-and-boolean.

**Interfaces:**
- Produces: `featureFlags.hostStatsAvailable: boolean` on `/api/platform` and `/api/bootstrap` (Node), same on the two Rust endpoints.

Behavior: Node — `hostStatsAvailable: process.platform !== 'win32'` (linux/wsl/darwin true; no boot probe needed: readers degrade to `available:false`, so a proc-less darwin is still fine to expose the pane). Rust — `cfg!(not(target_os = "windows"))`. Both are boot-static, satisfying the boot-frozen `Arc` (`main.rs:1224`).

- [ ] **Step 1: Write the failing behavioral test**

Node test asserts `detectFeatureFlags()['hostStatsAvailable'] === (process.platform !== 'win32')` for the current platform AND a stubbed-win32 call (`detectFeatureFlags(platform = process.platform)` injectable param). Rust: NEW test `host_stats_flag_present_in_platform_payload` in the module that owns the existing payload tests (near `main.rs:3516/3592/3606`) asserting `payload["featureFlags"]["hostStatsAvailable"] == json!(cfg!(not(target_os = "windows")))`. **All existing exact-equality payload assertions must also gain the new key** (there are several; find them with `rg -n "featureFlags" crates/freshell-server/src/main.rs`) — the red test must fail for the reason "flag missing", and exact-equality tests fail until the production edit lands.

- [ ] **Step 2: Run the test and verify the intended failure**

Run (TWO commands; BOTH must show RED — never chain RED evidence with `&&`):
1. `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/server/platform-flags.test.ts --config config/vitest/vitest.server.config.ts` → FAIL (flag absent)
2. `cargo test -p freshell-server --locked host_stats_flag_present_in_platform_payload` → FAIL (flag absent; the named test exists)

Expected: RED — flag absent; the named Rust test EXISTS and fails (never accept a filter matching zero tests).

- [ ] **Step 3: Add the minimal production implementation**

One line in `detectFeatureFlags` (+ its signature default param); one field in the Rust `json!` + supporting const `let host_stats_available = cfg!(not(target_os = "windows"));`.

- [ ] **Step 4: Run the focused test** (same command)

Expected: PASS.

- [ ] **Step 5: Refactor while green**

None expected.

- [ ] **Step 6: Run impacted-test verification**

Both endpoints' payload tests + bootstrap tests: `rg -l "bootstrap" test/ | head` → run those files.

Run: `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/server --config config/vitest/vitest.server.config.ts && cargo test -p freshell-server --locked`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add server/platform-router.ts crates/freshell-server/src/main.rs test/unit/server/platform-flags.test.ts
git diff --cached --stat   # verify: ONLY the listed paths staged — never `git add <dir>`
git commit -m "feat(host-stats): hostStatsAvailable feature flag on platform payloads (Node+Rust)"
```

---

### Task 6: Client `hostStatsSlice` + ws folding + status helpers

**Files:**
- Create: `src/store/hostStatsSlice.ts`
- Create: `src/lib/host-stats-status.ts` (pure status-word mapping)
- Create: `src/lib/host-stats-format.ts` (bytes/duration/percent formatters used by tiles — pure)
- Modify: `src/store/index.ts` (register slice — check actual store assembly file name first: `rg -l "configureStore" src/store`)
- Modify: `src/App.tsx` (ready-handler resubscribe ~985+/1106-1109; onMessage folds ~983+, requestCodexActivityList ref-map precedent 718-726/1278-1288)
- Test: `test/unit/client/store/hostStatsSlice.test.ts` (new)
- Test: `test/unit/client/lib/host-stats-status.test.ts` (new)
- Test: `test/unit/client/components/App.hoststats-ws.test.tsx` (new — the `vi.mock('@/lib/ws-client')` pattern from `App.reconcile-adoption.test.tsx`)

**Interfaces:**

```ts
// src/store/hostStatsSlice.ts
export type HostStatsState = {
  mountedPanes: number                       // client-side subscription refcount (not persisted)
  subscribed: boolean                        // true after subscribe acked optimistically on send
  live: HostStatsLive | null
  liveAt: number | null
  clockOffsetMs: number | null               // Date.now() - snapshot.at, refreshed per snapshot; age math uses server-consistent now: serverNow = Date.now() - clockOffsetMs
  manualAt: number | null
  manual: HostStatsManual | null
  refresh: { inFlight: boolean; requestId: string | null; error: string | null }
}
// reducers: hostStatsPaneMounted(), hostStatsPaneUnmounted(), hostStatsSubscribedSet(true|false)  ← the ONLY writer of `subscribed`;
//   activated by the thunks at the exact 0→1 / 1→0 transition (optimistic=true; on ws error state, hostStatsReset clears),
//   hostStatsSnapshotReceived({at, live, manualAt, manual}) — also sets
//   clockOffsetMs = Date.now() - at with NO zero-clamp (client-behind-server yields a correctly NEGATIVE offset so
//   serverNow = Date.now() - clockOffsetMs stays skew-correct; only reject |offset|>10min as unparseable garbage → keep previous),
// hostStatsRefreshStarted({requestId}), hostStatsRefreshResolved({at, manual}), hostStatsRefreshFailed({error}),
//           hostStatsReset()  // on ws disconnect/'ready' — keeps last manual+live but subscribed=false
// thunks (in the slice file, following repo thunk conventions): activateHostStats() / deactivateHostStats() — PURE reducer
//   actions hostStatsPaneMounted/hostStatsPaneUnmounted mutate the refcount ONLY; the thunks wrap them and perform the WS
//   side effect exactly on the 0→1 / 1→0 transition (reading the state after dispatch). Components NEVER dispatch the raw
//   reducers — always the thunks. requestHostStatsRefresh() mints requestId `hsr-${Date.now()}-${rand36}`,
//   sets inFlight, sends frame, arms 6000ms acceptance deadline → on timeout dispatches hostStatsRefreshFailed('refresh timed out — showing previous values').
```

```ts
// src/lib/host-stats-status.ts
export type StatusWord = 'ok' | 'busy' | 'maxed' | 'tight' | 'full' | 'swapping' | 'thrashing' | 'stalled' | 'slow'
  | 'errors' | 'lagging' | 'blocked' | 'unknown'
export type Severity = 'ok' | 'warn' | 'bad'
export interface TileStatus { severity: Severity; word: string }        // word is the DISPLAY word (uppercased at render)
export function cpuStatus(l: HostStatsLive): TileStatus                 // all functions degrade to 'unknown'/ok-grey when !available
export function memoryStatus(l: HostStatsLive): TileStatus
export function pagingStatus(l: HostStatsLive): TileStatus
export function psiStatus(l: HostStatsLive): TileStatus
export function diskIoStatus(l: HostStatsLive): TileStatus
export function networkStatus(l: HostStatsLive): TileStatus
export function limitsStatus(l: HostStatsLive): TileStatus
export function freshellStatus(l: HostStatsLive): TileStatus
export function overallVerdict(l: HostStatsLive | null): { severity: Severity; label: string; offenders: string[] }
// thresholds EXACTLY per "Design contract / Pane-component contract" threshold list; paging 'swapping' needs
// sustained 2 ticks → implemented as: warn if pswpinKbps+pswpoutKbps>0; 'THRASHING' if > 5000. (No cross-tick memory:
// the delta is already a smoothed rate; sustainedness comes from the 2s cadence. Drop the 2-tick carry.)
```

Folding rules in App.tsx: `hoststats.snapshot` → validate-then-dispatch is NOT runtime-revalidated client-side (server already validated; client trusts server — ws-protocol.ts:26-28) → `hostStatsSnapshotReceived`. `hoststats.refresh.response` → match ref-map keyed by requestId (delete entry; resolve/fail reducer). `ready` → `hostStatsReset()` then if `mountedPanes > 0` resend `hoststats.subscribe`. Unmount-to-zero sends `hoststats.unsubscribe`.

- [ ] **Step 1: Write the failing behavioral test**

Status/format tests are pure-table tests covering EVERY threshold boundary (79.9/80/95, 84.99/85/97, psi 1.0, await 20/100, lag 50/500, exact null availability paths). Slice tests (with `vi.mock('@/lib/ws-client')` send spy — the repo thunk pattern calls the real `getWsClient()`): thunk-ed mount refcount (activate twice → ONE subscribe frame; deactivate once → no unsubscribe; second deactivate → unsubscribe frame), snapshot reducer merge semantics (a snapshot without manual MUST NOT clear existing manual/manualAt; reducer installs `clockOffsetMs = Date.now() - at`), refresh start/resolve/fail/timeout paths (fake timers cover the 6000ms client deadline), reset keeps data but clears subscribed. App test: inject frames via captured handler per `App.reconcile-adoption.test.tsx` — snapshot lands in `store.getState().hostStats.live`; refresh.response with unknown requestId ignored without throw; on `ready`, subscribe is re-sent iff mountedPanes>0.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/client/store/hostStatsSlice.test.ts test/unit/client/lib/host-stats-status.test.ts test/unit/client/components/App.hoststats-ws.test.tsx`

Expected: FAIL — `hostStatsSlice` selector/reducer imports missing.

- [ ] **Step 3: Add the minimal production implementation**

Slice + helpers + App.tsx folds per contract. The ws send helper: small module `src/lib/host-stats-ws.ts` exporting `subscribeHostStats() / unsubscribeHostStats() / requestHostStatsRefreshWs(requestId)` wrapping `getWsClient().send(...)` — this keeps App.tsx thin and gives the pane component (Task 7) and thunk a shared seam.

- [ ] **Step 4: Run the focused test** (same command)

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Share the `percent()`/`bytes()`/`ms()` formatters if pipeline duplicates appear; keep helpers table-free of component code.

- [ ] **Step 6: Run impacted-test verification**

App.tsx is central: run the client component + store suites around App.

Run: `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/client/components/App test/unit/client/store test/unit/client/lib`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/store/hostStatsSlice.ts src/lib/host-stats-status.ts src/lib/host-stats-format.ts src/lib/host-stats-ws.ts src/store/index.ts src/App.tsx test/unit/client/store/hostStatsSlice.test.ts test/unit/client/lib/host-stats-status.test.ts test/unit/client/components/App.hoststats-ws.test.tsx
git diff --cached --stat   # verify: ONLY the listed paths staged — never `git add <dir>`
git commit -m "feat(host-stats): client slice, status helpers, and ws folding for hoststats.*"
```

---

### Task 7: `HostStatsPane` component + pane-kind plumbing

**Files:**
- Create: `src/components/panes/HostStatsPane.tsx`
- Modify: `src/store/paneTypes.ts` (union 246-247, `LivePaneContentInput` 275-276)
- Modify: `src/store/panesSlice.ts` (`normalizePaneContent` explicit branch near 287-291)
- Modify: `src/store/paneTreeValidation.ts` (`isPaneContentShape` — add `case 'host-stats': return true` near picker at 61-62)
- Modify: `src/components/panes/PaneContainer.tsx` (`PickerWrapper.createContentForType` switch 636-768; `renderContent` if-chain 838-928)
- Modify: `src/components/panes/PanePicker.tsx` (`PanePickerType` 17; gated option + final ordering 140)
- Modify: `src/lib/derivePaneTitle.ts` (branch before terminal tail → `'Host Stats'`)
- Modify: `src/components/icons/PaneIcon.tsx` (branch → `Gauge` from lucide-react, before LayoutGrid fallback)
- Test: `test/unit/client/components/panes/HostStatsPane.test.tsx` (new)
- Test: `test/e2e-browser/specs/host-stats-pane.spec.ts` (Authored HERE, not Task 10 — see Task 10 for why)
- Test: extend `test/unit/client/components/panes/PanePicker.test.tsx` (flag gating, platform gating — mirror 'platform-specific shell options' 602-673)
- Test: extend `test/unit/client/components/panes/PaneContainer.createContent.test.tsx` (host-stats option → `{kind:'host-stats'}`)
- Test: extend `test/unit/client/store/panesSlice.test.ts` or nearest persistence test: `{kind:'host-stats'}` normalize + tree-validation round-trip

**Interfaces:**
- Consumes: `hostStatsSlice` state (Task 6); status helpers (Task 6); `useAppSelector/useAppDispatch` (`@/store/hooks`).
- Produces: `HostStatsPaneContent = { kind: 'host-stats' }`; component `export default function HostStatsPane({ tabId, paneId }: { tabId: string; paneId: string })`.

**Component structure (exact):**

```tsx
export default function HostStatsPane(_props: HostStatsPaneProps) {
  const dispatch = useAppDispatch()
  const live = useAppSelector((s) => s.hostStats.live)
  const liveAt = useAppSelector((s) => s.hostStats.liveAt)
  const manualAt = useAppSelector((s) => s.hostStats.manualAt)
  const manual = useAppSelector((s) => s.hostStats.manual)
  const refresh = useAppSelector((s) => s.hostStats.refresh)
  useEffect(() => {
    dispatch(activateHostStats())                    // thunk: refcount++, sends hoststats.subscribe iff 0→1
    return () => { dispatch(deactivateHostStats()) } // thunk: refcount--, sends hoststats.unsubscribe iff 1→0
  }, [dispatch])
  // …render per contract (a11y: unused props object is taken whole — `no-unused-vars` clean without `_`-prefixed destructuring)
}
```

Render contract (structure mirrors the prototype semantically):
1. Root: `<section aria-label="Host stats" className="flex h-full flex-col overflow-auto bg-background p-2">` — inner scroll, tiles never overflow the pane.
2. Verdict strip: `<div role="status" className="…">` with classes by severity: ok `bg-success/15 text-success`, warn `bg-warning/15 text-warning`, bad `bg-destructive/10 text-destructive`; label from `overallVerdict(live)` ('ALL GOOD — nothing needs attention' / 'ELEVATED — CPU BUSY' / 'TROUBLE — MEMORY FULL · PRESSURE STALLED').
3. Machine `<details>` summary: `<summary className="text-xs text-muted-foreground">` with `"{cores} cores · {GiB} GiB RAM{wsl ? ' · WSL2' : ''}"` + capability chips (`rounded-full bg-muted px-2 text-xs`); `<details>` body shows kernel/hostname/cgroup/PSI/thermal/battery presence read from `live.machine` + section availability.
4. Group label `LIVE` (`text-xs text-muted-foreground uppercase tracking-wide`) + tile grid: `grid grid-cols-2 gap-2 @3xl:grid-cols-3` (use repo's existing responsive utility pattern if container queries unavailable — check `rg "grid-cols" src/components/OverviewView.tsx`; fall back to `grid-cols-2 xl:grid-cols-3`).
5. Tile component (local, not exported): `<div className="rounded-lg border border-border bg-card p-2">`, header row = title `text-xs text-muted-foreground` + pill `<span className={pillClasses(severity)}>{word}</span>` where `pillClasses = ok→'bg-success/15 text-success', warn→'bg-warning/15 text-warning', bad→'bg-destructive/10 text-destructive'` with `rounded-full px-1.5 text-[10px] font-medium`; body = big value `text-xl font-semibold tabular-nums` + rows (use `tabular-nums` for ALL numbers).
6. Live tiles (in order): CPU, Load, Memory, Paging, Pressure(PSI), Disk I/O, Network, Limits, Freshell Itself. Each tile maps 1:1 to a status helper (Task 6) + renders its key rows exact per prototype semantics: CPU `usagePct%` + mini per-core bar row (12 tiny `<span className="inline-block h-3 w-2 rounded-sm">` colored by pct bucket — pure presentational, severity color classes) + `steal %` row when stealPct>1; Memory `usedPct%` + `source` hint ('VM limit' when cgroup) + swap row when swapTotal>0; Paging rows swap in/out KB/s + majflt/s + oom_kills; PSI rows some/full avg10 per class; Disk I/O r/w Bps + util%/await; Network rx/tx Bps + err/drop counters; Limits fds, pids, TIME_WAIT/ephemeral — any `*Max === 0` means "no cap on this server implementation" and renders as '—' (Rust sends 0; see Task 9); Freshell `ptysRunning/ptysMax` (same '—' rule), `wsClients`, lag p99, RSS MB.
7. On-request group: header row = group label `ON REQUEST` + refresh `<button aria-label="Refresh on-request measurements">` (real button, shows spinner glyph + 'Collecting…' while `refresh.inFlight`, disabled while inFlight) + age label `<span>` ('updated 12s ago' — NOT `aria-live` and NOT announced on tick: a 1s-updating live region would nag screen readers every second (R3M-minor); refresh COMPLETION is announced separately by a one-shot visually-hidden `<div role="status" className="sr-only">{refreshJustCompleted ? 'Measurements refreshed' : ''}</div>` set on `hostStatsRefreshResolved` and cleared on the next tick). Group container carries `style={{ filter: \`saturate(${sat})\` }}` where `sat` uses the contract formula computed against server-now (`Date.now() - clockOffsetMs`), recomputed by a local 1s `setInterval` (cleared on unmount) reading `manualAt`. Tiles: Top Processes (rows name/cpu%/rss/state badge), Process Health (zombies, D-state), Inotify (watches /max), Disks (per-mount used% + inode free), Thermals & Battery. Never-measured state (`manualAt === null`) renders these tiles with '—' values (not zeros — frozen contract above); degraded sections (`available:false`) likewise render '—'.
8. Refresh flow: button onClick → `dispatch(requestHostStatsRefresh())`. Error from slice → small `<div role="alert" className="text-xs text-destructive">` inside the on-request header row. Old values + original `manualAt` MUST remain (this is slice behavior, Task 6, but the component test asserts no visual blanking).
9. No implicit data fetch on mount beyond subscription; if `live === null` render tiles with '—' placeholders (pre-first-snapshot frame).

- [ ] **Step 1: Write the failing behavioral test**

FIRST, the e2e spec `test/e2e-browser/specs/host-stats-pane.spec.ts` (per Task 10's content block), committed standalone with only that file staged, and run to verify RED at the picker click — the only sequence point where absence-RED is reachable (Task 10 re-runs it GREEN). THEN, the unit tests below.

`HostStatsPane.test.tsx` with local `createMockStore` (panes + settings + connection + hostStats reducers — pattern `BrowserPane.test.tsx:30-74` + `EditorPane.test.tsx:82-109`) and `vi.mock('@/lib/ws-client')` per `TerminalView.lastInputAt.test.tsx:47-54`. Cases: (a) mount sends exactly one `hoststats.subscribe` (via mocked send spy) and unmount sends `hoststats.unsubscribe` — mount refcount behavior already covered by slice test; here assert once-per-mount; (b) seeded live state → verdict strip text + a tile word ('BUSY' when cpu 85%); (c) `manualAt:null` → on-request group has `filter: saturate(0)` style and empty age label; (d) seeded manual + fake timers advanced 60s → style moves toward `saturate(<1)`; (e) refresh click → send spy called with `hoststats.refresh` + requestId; failure state → `role="alert"` shows and old manual values still rendered; (f) 'Host Stats' title helper and icon/picker tests per the extended files; (g) picker: featureFlags.hostStatsAvailable=false OR platform='win32' → no Host Stats option; true+linux → option present with `aria-label="Host Stats"`, shortcut H handled.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/client/components/panes/HostStatsPane.test.tsx`

Expected: FAIL — `./HostStatsPane` does not exist.

- [ ] **Step 3: Add the minimal production implementation**

Component + all plumbing edits per the Files list. `PanePicker` option: `{ type: 'host-stats', label: 'Host Stats', icon: Gauge, shortcut: 'H' }` inserted before `nonShellOptions` — gate is `featureFlags.hostStatsAvailable === true && platform !== 'win32'` (exactly the plan-pane-types.md §3c snippet; the flag already encodes platform, the second clause is belt-and-braces). Shortcut collision tolerance: first-match-wins is the existing dispatch semantic — 'H' collision with an H-named extension is cosmetic; accepted.

- [ ] **Step 4: Run the focused test**

Run: `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/client/components/panes/HostStatsPane.test.tsx test/unit/client/components/panes/PanePicker.test.tsx test/unit/client/components/panes/PaneContainer.createContent.test.tsx`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Extract the pill and per-core bar into tiny local components if render exceeds ~250 lines; no new shared modules unless reused.

- [ ] **Step 6: Run impacted-test verification**

Pane plumbing touches panes/persistence/picker + store round-trips:

Run: `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/client/components/panes test/unit/client/store && npm run lint`

Expected: PASS (lint: no jsx-a11y errors in new/changed files).

- [ ] **Step 7: Commit the task**

```bash
git add src/components/panes/HostStatsPane.tsx src/store/paneTypes.ts src/store/panesSlice.ts src/store/paneTreeValidation.ts src/components/panes/PaneContainer.tsx src/components/panes/PanePicker.tsx src/lib/derivePaneTitle.ts src/components/icons/PaneIcon.tsx test/unit/client/components/panes/HostStatsPane.test.tsx test/unit/client/components/panes/PanePicker.test.tsx test/unit/client/components/panes/PaneContainer.createContent.test.tsx test/unit/client/store/ test/e2e-browser/specs/host-stats-pane.spec.ts
git diff --cached --stat   # verify: ONLY the listed paths staged — never `git add <dir>`
git commit -m "feat(host-stats): HostStatsPane component, pane kind plumbing, gated picker option"
```

---

### Task 8: Registry / REST / MCP surface (Node + Rust mirrors)

**Files:**
- Modify: `server/tabs-registry/types.ts:7-16` (add `'host-stats'` to `RegistryPaneKindSchema`)
- Modify: `src/lib/tab-registry-open.ts` (`sanitizePaneSnapshot` branch before picker fallback ~180; `paneKindIcon` 198-204 → Gauge; `paneKindColorClass` 206-213; `paneKindLabel` 215-222 → 'Host Stats')
- Modify: `src/lib/tab-registry-snapshot.ts` (`stripPanePayload` explicit `case 'host-stats': return {}`)
- Modify: `server/agent-api/layout-store.ts` `buildContent` (317-325): `hostStats?: boolean` opt → `{ kind: 'host-stats' }`
- Modify: `server/agent-api/router.ts` (`POST /api/tabs` 687-831: `wantsHostStats` branch before browser; `POST /api/panes/:id/split` 1240-1373: same)
- Modify: `server/mcp/freshell-tool.ts` (`ACTION_PARAMS` new-tab 305 + split-pane 313 optional arrays +`hostStats`; HELP_TEXT one-liner under Pane commands 398+)
- Modify: `crates/freshell-ws/src/tabs_store_model.rs` `PANE_KINDS` (249-257 +`"host-stats"` → len 8)
- Modify: `crates/freshell-ws/src/tabs_persist_validation.rs` `validate_pane` (483-516): `"host-stats" => Ok(())` arm (picker precedent ~509)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` (203-243 + `create_content_tab` 254): `hostStats` request flag arm
- Modify: `crates/freshell-freshagent/src/pane_ops.rs` (191-224): split-pane arm
- Modify: `crates/freshell-freshagent/src/layout_store_content.rs` `derive_pane_title` (17-76): `"host-stats" => "Host Stats"` arm
- Test: extend nearest tabs-registry zod test + `src/lib/tab-registry-open` client test; REST tests covering BOTH routes (find via `rg -l "POST /api/tabs|createTab|/split" test/unit/server/agent-api`): (a) POST /api/tabs hostStats:true, (b) POST /api/panes/:id/split hostStats:true; MCP tests: `server/mcp/freshell-tool.test.ts`-adjacent coverage asserting new-tab/split-pane pass `hostStats` through (find via `rg -l "ACTION_PARAMS|freshell-tool" test`); Rust: terminal_tabs create arm + pane_ops split arm unit tests; extend `crates/freshell-ws/…/tabs_persist_tests.rs` (1162-1199 list assertion)

**Interfaces:**
- Produces: REST `POST /api/tabs { hostStats: true }` and `POST /api/panes/:id/split { hostStats: true }`; MCP `new-tab { hostStats: true }` / `split-pane { hostStats: true }`.

- [ ] **Step 1: Write the failing behavioral test**

Node: REST hostStats:true tab returns layout whose leaf content is `{kind:'host-stats'}`; registry zod accepts a tab record with a host-stats pane; client `sanitizePaneSnapshot` returns `{kind:'host-stats'}` (not picker fallback). Rust: `validate_pane` accepts host-stats; tabs_persist kind list assertion extended.

- [ ] **Step 2: Run the test and verify the intended failure**

Run (two lanes — do NOT mix configs): server lane `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/server/agent-api test/unit/server/tabs-registry --config config/vitest/vitest.server.config.ts`, client lane `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/client/lib/tab-registry` (default config), Rust `cargo test -p freshell-ws --locked tabs_persist`

Expected: RED — kind rejected / fallback to picker.

- [ ] **Step 3: Add the minimal production implementation**

All edits per Files list (each is ≤5 lines; mirror, don't redesign).

- [ ] **Step 4: Run the focused test** (same command)

Expected: PASS.

- [ ] **Step 5: Refactor while green**

None expected.

- [ ] **Step 6: Run impacted-test verification**

Run (three lanes, no config mixing): server lane `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/server/agent-api test/unit/server/tabs-registry --config config/vitest/vitest.server.config.ts`; client lane `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/client/lib`; Rust `cargo test -p freshell-ws --locked && cargo test -p freshell-freshagent --locked`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add server/tabs-registry/types.ts src/lib/tab-registry-open.ts src/lib/tab-registry-snapshot.ts server/agent-api/layout-store.ts server/agent-api/router.ts server/mcp/freshell-tool.ts crates/freshell-ws/src/tabs_store_model.rs crates/freshell-ws/src/tabs_persist_validation.rs crates/freshell-freshagent/src/terminal_tabs.rs crates/freshell-freshagent/src/pane_ops.rs crates/freshell-freshagent/src/layout_store_content.rs <test files touched>
git diff --cached --stat   # verify: ONLY the listed paths staged — never `git add <dir>`
git commit -m "feat(host-stats): registry/REST/MCP surface for host-stats pane kind (Node+Rust)"
```

---

### Task 9: Rust collector parity

**Files:**
- Create: `crates/freshell-platform/src/host_stats_readers.rs` (pure path-injected readers, mirroring Node `readers.ts`; registered via `pub mod` in `crates/freshell-platform/src/lib.rs`)
- Create: `crates/freshell-ws/src/host_stats_interest.rs` (interest registry cloned from `subagent_interest.rs`: set/remove/any/count ONLY — no JoinHandle ownership here)
- Create: `crates/freshell-ws/src/host_stats_collector.rs` (`pub trait HostStatsCollector: Send + Sync` — `snapshot()`, `refresh(deadline)`, and `set_active(active: bool)` — the last is the interest-transition callback; the concrete collector in freshell-server owns cadence lifecycle internally on this call: true→spawn task, false→abort. freshell-ws never touches /proc or timers)
- Create: `crates/freshell-server/src/host_stats.rs` (concrete collector implementing the trait using freshell-platform readers)
- Modify: `crates/freshell-server/src/main.rs` (construct the concrete collector + `Arc<dyn HostStatsCollector>` near :1311-1315, next to where `spawn_subagent_cadence` wiring lives; inject into `WsState`; no spawn here — the collector's `set_active` owns spawning)
- Modify: `crates/freshell-ws/src/lib.rs` (`WsState` field area 140-145: interest registry + `Arc<dyn HostStatsCollector>` — and the reviewer-flagged literal sweep: enumerate every `WsState {` construction site with `rg -n "WsState \{" crates/`, update each explicitly; if the sweep exceeds ~6 sites, wrap BOTH new fields in a single `host_stats: WsHostStatsState` sub-struct deriving `Default` so each legacy literal gains exactly one `..Default::default()`-compatible arm; run `cargo check --workspace` after the sweep as its own gate BEFORE the task's GREEN run).
- Modify: `crates/freshell-ws/src/terminal.rs` — the actual authenticated-message dispatch + disconnect cleanup live HERE (not lib.rs): add `hoststats.subscribe`/`hoststats.unsubscribe`/`hoststats.refresh` cases; per-connection `host_stats_last_refresh_at: Instant`; **1s floor → `{ok:false, error:"rate_limited"}` without invoking the collector**; on socket teardown: remove interest; at count 0 abort the cadence JoinHandle.
- Test: `crates/freshell-server/src/host_stats.rs` `#[cfg(test)]` tests (fixture readers, refresh single-flight + cooperative budget), `host_stats_interest.rs` set/remove/any tests + collector `set_active` spawn/abort lifecycle tests. **Tokio `time::pause/advance` are FORBIDDEN here** — `freshell-server`/`freshell-ws` tokio lacks the `test-util` feature (R3 verified from Cargo.tomls) and adding it churns `Cargo.lock` against `--locked` CI. Timed tests use REAL short cadences instead (cadence tasks constructed with 25ms fast / 50ms slow in tests, `tokio::time::sleep` waits ≤500ms, deterministic assertions on counts). The rate-floor test uses `Instant`-controlled short sleeps.

**Crate architecture (correcting the dependency direction — freshell-ws canNOT depend on freshell-server):**
- `crates/freshell-platform/src/host_stats_readers.rs` (New): pure `/proc`+`/sys` readers + parsers (path-injected root, like `detect.rs`).
- `crates/freshell-ws/src/host_stats_collector.rs` (New): `pub trait HostStatsCollector: Send + Sync { fn snapshot(&self) -> HostStatsSnapshotPayload; fn refresh(&self, deadline: Duration) -> … }` + unit struct `HostStatsShare`; freshell-ws owns ZERO /proc knowledge.
- `crates/freshell-server/src/host_stats.rs`: the concrete collector (cadences 2000/5000ms, `MissedTickBehavior::Skip`, interest-spawn/abort, filepath-pure reader integration) implementing the freshell-ws trait; constructed and `Arc`'d in `main.rs` near the subagent-cadence spawn (~1311-1315), injected into `WsState` at construction.
- `crates/freshell-ws/src/terminal.rs` — AUTHENTICATED MESSAGE DISPATCH + disconnect cleanup ACTUALLY live here (not lib.rs): `hoststats.subscribe`/`hoststats.unsubscribe`/`hoststats.refresh` cases; per-connection `host_stats_last_refresh_at: Instant` field; **per-conn 1s floor returns `{"type":"hoststats.refresh.response", ok:false, error:"rate_limited"}` WITHOUT invoking the collector**; on connection teardown the interest record is removed AND the cadence JoinHandle aborted when count hits 0.

Rust delivery targeting: snapshots flow ONLY to subscribed connections — mirroring Node's subscriber-targeted send (frozen contract: non-watchers get zero traffic). The shared `broadcast_tx` fans out to every connection, so it is NOT the delivery mechanism; the cadence task instead iterates the interest registry's live connections and uses the per-connection outbound sender that terminal.rs already owns for its socket write loop (the reviewer-verified location of the per-conn channel — implementer: locate the exact sender field name in `freshell-ws/src/terminal.rs` during RED step, e.g. `out_tx`/`ws_tx`; the interest registry stores the sender alongside each connection id at subscribe time). If no per-connection sender proves available at that site, `host_stats_interest.rs` additionally stores an `mpsc::UnboundedSender<String>` per connection created at subscribe time and drained into the socket's existing outbound path — either way, frames never touch `broadcast_tx`.

Behavior: identical cadences (2000/5000ms, `MissedTickBehavior::Skip`), same readers over `/proc` (reuse path-injection style from `shutdown_forensics.rs:56`; pure fns + fixture tests), same sections with `{available:false}` degradation, `eventLoopLagP99Ms` = scheduler-drift p99 in ms per the units contract above (`freshell.source = 'rust'`), connection count from `freshell-terminal` registry `connection_count()` (`crates/freshell-terminal/src/registry.rs:774-780`) → `wsClients`; **`wsClientsMax: 0`** (freshell-ws has no connection cap — verified LB9) and **`ptysMax: 0`** (the Rust spawn gate is a concurrency gate `CreateProtectConfig::from_env()`, not a PTY-count cap — verified LB9); client renders both as '—' per Task 7. PTY running count sourced from the terminal registry the same way `diag.rs` surfaces it (follow its access pattern), RSS from `/proc/self/statm`, `uptimeSec` = seconds since server boot anchor passed in from `main.rs`.

- [ ] **Step 1: Write the failing behavioral test**

`#[cfg(test)] mod tests` in host_stats.rs: fixture `/proc` tree under `crates/freshell-server/tests/fixtures/host-stats/` (reuse Task 2 fixture semantics), refresh single-flight + per-section budget tests, plus the lifecycle assertions. **Stub-to-RED rule (Rust-specific):** a new `.rs` file is inert until `mod`-registered — so step 1 writes the MODULE SKELETON: `crates/freshell-platform/src/host_stats_readers.rs` (+ `pub mod` in its lib.rs), `crates/freshell-ws/src/host_stats_interest.rs` + `host_stats_collector.rs` (+ registrations), `crates/freshell-server/src/host_stats.rs` (+ registration), each with compiling placeholder implementations (`unimplemented!/Err-returning`) and the full failing test bodies that call them. RED = runtime assertion failures/panics, not compile failure.

- [ ] **Step 2: Run the test and verify the intended failure**

Run (separately — both must show RED with NONZERO test counts, never `&&`-chained, never zero-match):
1. `cargo test -p freshell-server --locked -- host_stats 2>&1; cargo test -p freshell-server --locked -- --list | grep -c host_stats` → RED AND count ≥ 3 (zero matches = registration broken, go fix that)
2. `cargo test -p freshell-ws --locked -- host_stats 2>&1; cargo test -p freshell-ws --locked -- --list | grep -c host_stats` → RED AND count ≥ 2
The two parity tests in scope: (1) spawn/abort lifecycle — `set_active(true)` spawns the cadence task, `set_active(false)` aborts it (assert via a test-visible `is_running()`/handle option), (2) the post-completion 1s floor returns `rate_limited` on repeat.

- [ ] **Step 3: Add the minimal production implementation**

Collector module + interest registry + spawn + dispatch cases per contract.

- [ ] **Step 4: Run the focused test** (same command)

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Share fixture-driven parse asserts with the Node side conceptually (same fixture FILE content under crates fixture dir — duplicated bytes intentionally; ports drift independently).

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-server --locked && cargo test -p freshell-ws --locked && cargo test -p freshell-protocol --locked && cargo test -p freshell-freshagent --locked && cargo test -p freshell-terminal --locked`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-platform/src/host_stats_readers.rs crates/freshell-platform/src/lib.rs crates/freshell-ws/src/host_stats_interest.rs crates/freshell-ws/src/host_stats_collector.rs crates/freshell-ws/src/lib.rs crates/freshell-ws/src/terminal.rs crates/freshell-server/src/host_stats.rs crates/freshell-server/src/main.rs <ws-lib literals touched by the WsState sweep> <test files>
git diff --cached --stat   # verify: ONLY the listed paths staged — never `git add <dir>`
git commit -m "feat(host-stats): Rust collector parity — platform readers, trait bridge, interest-gated cadence, targeted send, refresh floor"
```

---

### Task 10: Playwright e2e smoke (`host-stats-pane.spec.ts`)

**Files:**
- Test: `test/e2e-browser/specs/host-stats-pane.spec.ts` (new, ONE file)
- Modify: `test/e2e-browser/playwright.config.ts` — add `/host-stats-pane\.spec\.ts$/` to `MATRIX_SPECS` (the list `rust-chromium` actually `testMatch`es on, ~L353; RUST_ONLY_SPECS is an exclusion list for the Node legs — listing there alone would run ZERO Rust tests)

Spec content (model: `browser-pane.spec.ts`; fixtures import `../helpers/fixtures.js`; open the picker via `openPanePicker(page)` from `test/e2e-browser/helpers/pane-picker.ts` — the repo-supported, harness-driven path, not a `.xterm` class dance — then click `getByRole('button', { name: /^Host Stats$/ })`):
1. Boot `freshellPage` → open Host Stats via the picker helper → assert leaf `content.kind === 'host-stats'` via `harness.getPaneLayout`.
2. Smoke: verdict strip `getByRole('status')` non-empty; CPU tile shows `/\d+(\.\d+)?%/` within 5s.
3. Refresh interaction — NO try/catch, NO environment-branch text probes. Assert the ALWAYS-TRUE products of a successful refresh: (a) while awaiting the response, the button shows the Collecting state (disabled + 'Collecting…' text); (b) the button returns to enabled; (c) the age label in the ON-REQUEST header shows `/updated .*ago|just now/`. This is backend-agnostic (the refresh always resolves — degraded sections still resolve with zero-shape). Additionally assert the per-design fallback: Disks tile value is EITHER `/\d+%/` OR the em-dash placeholder — via `await expect(diskValue).toHaveText(/\d+%|—/)` (the em dash is the frozen '—' contract, not a guess).
4. Persistence: switch tab away and back → live tiles still render `/\d/` within 5s; kind still host-stats.
5. Reload page → pane restores as host-stats (proves paneTreeValidation survives reload).

Since the spec runs under `MATRIX_SPECS`, it executes under BOTH `legacy-chromium` (Node server) and `rust-chromium` — Rust parity coverage is therefore inherent; the Rust lane must show the refresh resolve + placeholder behavior identically (Rust collector zero-shape contract is the same). If a Rust-lane only divergence surfaces during implementation, handle it like the existing matrix specs do (the spec file gets a doc comment + assertion split by `testServer.info.kind`) — never split into a second file.

- [ ] **Steps**: RED evidence was captured in **Task 7** (the picker-option RED) — Task 10 does NOT re-derive RED (it postdates the feature). This task: (1) register the spec into `MATRIX_SPECS`, (2) run both matrix legs GREEN, (3) re-run `pane-picker.spec.ts` (option-count impact) GREEN, (4) commit the config change. E2E backend: **local, per the user's recorded decision** (run-state.md); never cloud, never persisted to bashrc.

Expected: PASS.

```bash
git add test/e2e-browser/playwright.config.ts
git diff --cached --stat   # verify: ONLY that file staged
git commit -m "test(host-stats): promote pane spec to MATRIX_SPECS (Node + Rust legs green)"
```

---

### Task 11: Docs touchpoints

**Files:**
- Modify: `README.md` (one bullet in the feature list: "Host pressure dashboard pane (CPU/memory/pressure/IO at a glance, near-zero overhead)")
- Modify: `docs/index.html` (pane picker mock: add Host Stats tile alongside Browser/Editor)
- Modify: `AGENTS.md` — pane content types sentence gains `host-stats` in the list ("Pane content types: `terminal` … and `browser`" line), no more.

- [ ] **Step 1:** docs-only; verification = rendered check: open `docs/index.html` and confirm the new tile renders; **specific greps (no vacuous combined match):** `rg -n "Host pressure dashboard" README.md` (shows the new bullet) AND `rg -n "host-stats" AGENTS.md` (shows the updated pane-types sentence) AND `rg -n "Host Stats" docs/index.html` (shows the mock tile).
- [ ] **Step 2–6:** `git grep -n "Pane content types" AGENTS.md` shows the updated line; browser check of docs/index.html via the static server already running (`http://localhost:8613/../docs/index.html` is outside its root — use `python3 -m http.server` from the worktree briefly on port 8614 with recorded PID, screenshot mentally via MCP browser pane, then kill PID).
- [ ] **Step 7:**

```bash
git add README.md docs/index.html AGENTS.md
git commit -m "docs(host-stats): README bullet, docs/index.html picker tile, AGENTS.md pane-kind list"
```

---

## Stage-2 handoff: load-bearing assumptions (RESOLVED)

All 7 seeded claims plus 10 finder-surfaced claims (LB1-LB17) were validated during Stage 2; verdicts + plan changes are in `.worktrees/.the-usual-logs/host-pressure-pane/load-bearing-ledger.md`. Plan text reflects every falsified/gap claim.

## Final integration gate (mandatory end of Stage 4, before Stage 5 delta review)

Per-task focused tests are necessary but NOT sufficient — the delta is integration-level (App.tsx, ws-handler, contract artifacts, platform payloads, pane plumbing). After the last task lands, in order, ALL must pass before Stage 5:

1. Focused lanes green: `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/server/host-stats --config config/vitest/vitest.server.config.ts`; `… run test/server/ws-hoststats.test.ts --config config/vitest/vitest.server.config.ts`; `… run test/unit/client/components/panes test/unit/client/store/hostStatsSlice.test.ts test/unit/client/lib/host-stats-status.test.ts test/unit/shared/hoststats-protocol.test.ts`
2. `npm run typecheck`
3. `npm run lint`
4. `env -u FRESHELL_BIND_HOST FRESHELL_TEST_SUMMARY='host-pressure-pane stage-4 gate' npm test` — coordinated full suite
5. `cargo test --workspace --locked`
6. `cargo clippy --workspace --locked --all-targets -- -D warnings` (match the strictness profile CI/repo actually uses — check `.github/workflows` for the clippy invocation first)
7. `npm run contract:generate && git diff --exit-code -- port/contract` — regen idempotent at HEAD
8. Task 10's e2e matrix run green on both legs
9. `npm run build` in the worktree

Evidence: record each command's result into run-state.md's execution ledger lines.

