import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { TabsDeviceStore } from './device-store.js'
import { TabRegistryRecordSchema, type RegistryTabRecord } from './types.js'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_RANGE_DAYS = 1

type TabsRegistryStoreOptions = {
  now?: () => number
  defaultRangeDays?: number
}

export type TabsRegistryQueryInput = {
  deviceId: string
  rangeDays?: number
}

export type TabsRegistryQueryResult = {
  localOpen: RegistryTabRecord[]
  remoteOpen: RegistryTabRecord[]
  closed: RegistryTabRecord[]
}

function isIncomingNewer(incoming: RegistryTabRecord, current: RegistryTabRecord | undefined): boolean {
  if (!current) return true
  if (incoming.revision !== current.revision) return incoming.revision > current.revision
  if (incoming.updatedAt !== current.updatedAt) return incoming.updatedAt >= current.updatedAt
  return true
}

function sortByUpdatedDesc(a: RegistryTabRecord, b: RegistryTabRecord): number {
  return b.updatedAt - a.updatedAt
}

function sortByClosedDesc(a: RegistryTabRecord, b: RegistryTabRecord): number {
  const aClosedAt = a.closedAt ?? a.updatedAt
  const bClosedAt = b.closedAt ?? b.updatedAt
  return bClosedAt - aClosedAt
}

function resolveStoreDir(baseDir?: string): string {
  if (baseDir) return path.resolve(baseDir)
  return path.join(os.homedir(), '.freshell', 'tabs-registry')
}

export class TabsRegistryStore {
  private readonly latestByTabKey = new Map<string, RegistryTabRecord>()
  private readonly devices = new TabsDeviceStore()
  private readonly logPath: string
  private readonly now: () => number
  private readonly defaultRangeDays: number
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly rootDir: string, options: TabsRegistryStoreOptions = {}) {
    this.logPath = path.join(rootDir, 'tabs-registry.jsonl')
    this.now = options.now ?? (() => Date.now())
    this.defaultRangeDays = options.defaultRangeDays ?? DEFAULT_RANGE_DAYS
    this.hydrateFromDisk()
  }

  private hydrateFromDisk(): void {
    fs.mkdirSync(this.rootDir, { recursive: true })
    if (!fs.existsSync(this.logPath)) return

    const raw = fs.readFileSync(this.logPath, 'utf-8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = TabRegistryRecordSchema.parse(JSON.parse(trimmed))
        this.applyRecord(parsed)
      } catch {
        // Ignore malformed history lines; valid lines still restore state.
      }
    }
  }

  private applyRecord(record: RegistryTabRecord): void {
    const current = this.latestByTabKey.get(record.tabKey)
    if (!isIncomingNewer(record, current)) return
    this.latestByTabKey.set(record.tabKey, record)
    this.devices.upsert(record.deviceId, record.deviceLabel, record.updatedAt)
  }

  private async appendRecord(record: RegistryTabRecord): Promise<void> {
    await fsp.mkdir(this.rootDir, { recursive: true })
    await fsp.appendFile(this.logPath, `${JSON.stringify(record)}\n`, 'utf-8')
  }

  async upsert(record: RegistryTabRecord): Promise<boolean> {
    const parsed = TabRegistryRecordSchema.parse(record)
    let changed = false

    this.writeQueue = this.writeQueue.then(async () => {
      const current = this.latestByTabKey.get(parsed.tabKey)
      if (!isIncomingNewer(parsed, current)) return
      this.applyRecord(parsed)
      await this.appendRecord(parsed)
      changed = true
    })

    await this.writeQueue
    return changed
  }

  async query(input: TabsRegistryQueryInput): Promise<TabsRegistryQueryResult> {
    const rangeDays = input.rangeDays ?? this.defaultRangeDays
    const rangeMs = Math.max(1, rangeDays) * DAY_MS
    const cutoff = this.now() - rangeMs

    const localOpen: RegistryTabRecord[] = []
    const remoteOpen: RegistryTabRecord[] = []
    const closed: RegistryTabRecord[] = []

    for (const record of this.latestByTabKey.values()) {
      if (record.status === 'open') {
        if (record.deviceId === input.deviceId) {
          localOpen.push(record)
        } else {
          remoteOpen.push(record)
        }
        continue
      }

      const closedAt = record.closedAt ?? record.updatedAt
      if (closedAt >= cutoff) {
        closed.push(record)
      }
    }

    return {
      localOpen: localOpen.sort(sortByUpdatedDesc),
      remoteOpen: remoteOpen.sort(sortByUpdatedDesc),
      closed: closed.sort(sortByClosedDesc),
    }
  }

  listDevices(): Array<{ deviceId: string; deviceLabel: string; lastSeenAt: number }> {
    return this.devices.list()
  }

  count(): number {
    return this.latestByTabKey.size
  }
}

export function createTabsRegistryStore(baseDir?: string, options: TabsRegistryStoreOptions = {}): TabsRegistryStore {
  return new TabsRegistryStore(resolveStoreDir(baseDir), options)
}
