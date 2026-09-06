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
