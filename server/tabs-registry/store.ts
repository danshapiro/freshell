import crypto from 'crypto'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import readline from 'readline'
import { z } from 'zod'
import { getFreshellConfigDir } from '../freshell-home.js'
import { TabRegistryRecordSchema, type RegistryTabRecord } from './types.js'

const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
const DEFAULT_CLOSED_RETENTION_DAYS = 30
const DEFAULT_OPEN_SNAPSHOT_TTL_MINUTES = 30
const DEFAULT_DEVICE_DISPLAY_TTL_DAYS = 7

type ObjectRef = {
  path: string
  sha256: string
  bytes: number
}

export type RegistryDeviceEntry = {
  deviceId: string
  deviceLabel: string
  lastSeenAt: number
}

type ClientOpenSnapshot = {
  deviceId: string
  deviceLabel: string
  clientInstanceId: string
  snapshotRevision: number
  lastPushPayloadHash: string
  snapshotReceivedAt: number
  records: RegistryTabRecord[]
}

type CompactTabsRegistryStateV1 = {
  version: 1
  savedAt: number
  openSnapshotTtlMinutes: number
  deviceDisplayTtlDays: number
  maxClosedRetentionDays: number
  openSnapshotsByClient: Record<string, ClientOpenSnapshot>
  closedByTabKey: Record<string, RegistryTabRecord>
  devicesById: Record<string, RegistryDeviceEntry>
}

type TabsRegistryManifestV1 = {
  version: 1
  manifestRevision: number
  committedAt: number
  openSnapshots: Record<string, ObjectRef>
  closedTombstones: ObjectRef
  devices: ObjectRef
  settings: {
    openSnapshotTtlMinutes: number
    deviceDisplayTtlDays: number
    maxClosedRetentionDays: number
  }
}

export type ReplaceClientSnapshotInput = {
  deviceId: string
  deviceLabel: string
  clientInstanceId: string
  snapshotRevision: number
  records: RegistryTabRecord[]
}

export type RetireClientSnapshotInput = {
  deviceId: string
  clientInstanceId: string
  snapshotRevision: number
}

export type TabsRegistryQueryInput = {
  deviceId: string
  clientInstanceId: string
  closedTabRetentionDays: number
}

export type TabsRegistryQueryResult = {
  localOpen: RegistryTabRecord[]
  sameDeviceOpen: RegistryTabRecord[]
  remoteOpen: RegistryTabRecord[]
  closed: RegistryTabRecord[]
  devices: RegistryDeviceEntry[]
}

export type TabsRegistryStoreOptions = {
  now?: () => number
  defaultClosedRetentionDays?: number
  caps?: Partial<TabsRegistryCaps>
}

type TabsRegistryCaps = {
  maxRecordsPerPush: number
  maxOpenRecordsPerClientSnapshot: number
  maxClosedRecordsPerPush: number
  maxPanesPerRecord: number
  maxSerializedPushBytes: number
  maxSerializedClientSnapshotObjectBytes: number
  maxSerializedClosedTombstoneObjectBytes: number
  maxSerializedDeviceMetadataObjectBytes: number
  maxCompactStateBytes: number
  maxClientSnapshotRefs: number
  maxClosedTombstones: number
  maxLegacyLineBytes: number
  maxLegacyUniqueTabKeys: number
  maxMigrationRetainedBytes: number
}

type FailurePoint = 'object-write' | 'object-rename' | 'manifest-write' | 'manifest-rename'

const DEFAULT_CAPS: TabsRegistryCaps = {
  maxRecordsPerPush: 500,
  maxOpenRecordsPerClientSnapshot: 500,
  maxClosedRecordsPerPush: 500,
  maxPanesPerRecord: 20,
  maxSerializedPushBytes: 1024 * 1024,
  maxSerializedClientSnapshotObjectBytes: 512 * 1024,
  maxSerializedClosedTombstoneObjectBytes: 2 * 1024 * 1024,
  maxSerializedDeviceMetadataObjectBytes: 256 * 1024,
  maxCompactStateBytes: 5 * 1024 * 1024,
  maxClientSnapshotRefs: 200,
  maxClosedTombstones: 2000,
  maxLegacyLineBytes: 256 * 1024,
  maxLegacyUniqueTabKeys: 10_000,
  maxMigrationRetainedBytes: 5 * 1024 * 1024,
}

const ObjectRefSchema = z.object({
  path: z.string().regex(/^objects\/[a-f0-9]{64}\.json$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
})

const ManifestSchema: z.ZodType<TabsRegistryManifestV1> = z.object({
  version: z.literal(1),
  manifestRevision: z.number().int().nonnegative(),
  committedAt: z.number().int().nonnegative(),
  openSnapshots: z.record(z.string().min(1), ObjectRefSchema),
  closedTombstones: ObjectRefSchema,
  devices: ObjectRefSchema,
  settings: z.object({
    openSnapshotTtlMinutes: z.number().int().positive(),
    deviceDisplayTtlDays: z.number().int().positive(),
    maxClosedRetentionDays: z.number().int().min(1).max(30),
  }),
})

const ClientOpenSnapshotSchema: z.ZodType<ClientOpenSnapshot> = z.object({
  deviceId: z.string().min(1),
  deviceLabel: z.string().min(1),
  clientInstanceId: z.string().min(1),
  snapshotRevision: z.number().int().nonnegative(),
  lastPushPayloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotReceivedAt: z.number().int().nonnegative(),
  records: z.array(TabRegistryRecordSchema),
})

const DevicesSchema: z.ZodType<Record<string, RegistryDeviceEntry>> = z.record(z.string().min(1), z.object({
  deviceId: z.string().min(1),
  deviceLabel: z.string().min(1),
  lastSeenAt: z.number().int().nonnegative(),
}))

const ClosedTombstonesSchema: z.ZodType<Record<string, RegistryTabRecord>> = z.record(z.string().min(1), TabRegistryRecordSchema)

function resolveStoreDir(baseDir?: string): string {
  if (baseDir) return path.resolve(baseDir)
  return path.join(getFreshellConfigDir(), 'tabs-registry')
}

function sha256(raw: string | Buffer): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(stableStringify(value), 'utf-8')
}

function formatBytes(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`
  return `${bytes} bytes`
}

function sourceKey(record: RegistryTabRecord): string {
  return `${record.deviceId}:${record.tabKey}:${record.status}:${record.tabId}`
}

export function compareRegistryRecordsByEventTime(a: RegistryTabRecord, b: RegistryTabRecord): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt
  if (a.revision !== b.revision) return a.revision - b.revision
  if (a.status !== b.status) return a.status === 'closed' ? 1 : -1
  return sourceKey(a).localeCompare(sourceKey(b))
}

function pickEventWinner(a: RegistryTabRecord | undefined, b: RegistryTabRecord): RegistryTabRecord {
  if (!a) return b
  return compareRegistryRecordsByEventTime(a, b) <= 0 ? b : a
}

function sortByUpdatedDesc(a: RegistryTabRecord, b: RegistryTabRecord): number {
  return b.updatedAt - a.updatedAt
}

function sortByClosedDesc(a: RegistryTabRecord, b: RegistryTabRecord): number {
  const aClosedAt = a.closedAt ?? a.updatedAt
  const bClosedAt = b.closedAt ?? b.updatedAt
  return bClosedAt - aClosedAt
}

function clientSnapshotKey(deviceId: string, clientInstanceId: string): string {
  if (!deviceId.trim() || !clientInstanceId.trim()) {
    throw new Error('Tabs registry client snapshot requires non-empty deviceId and clientInstanceId')
  }
  return `${deviceId}:${clientInstanceId}`
}

function cloneState(state: CompactTabsRegistryStateV1, savedAt: number): CompactTabsRegistryStateV1 {
  return {
    ...state,
    savedAt,
    openSnapshotsByClient: Object.fromEntries(Object.entries(state.openSnapshotsByClient).map(([key, snapshot]) => [
      key,
      { ...snapshot, records: snapshot.records.map((record) => ({ ...record, panes: [...record.panes] })) },
    ])),
    closedByTabKey: Object.fromEntries(Object.entries(state.closedByTabKey).map(([key, record]) => [
      key,
      { ...record, panes: [...record.panes] },
    ])),
    devicesById: Object.fromEntries(Object.entries(state.devicesById).map(([key, device]) => [key, { ...device }])),
  }
}

function emptyState(now: number, maxClosedRetentionDays = DEFAULT_CLOSED_RETENTION_DAYS): CompactTabsRegistryStateV1 {
  return {
    version: 1,
    savedAt: now,
    openSnapshotTtlMinutes: DEFAULT_OPEN_SNAPSHOT_TTL_MINUTES,
    deviceDisplayTtlDays: DEFAULT_DEVICE_DISPLAY_TTL_DAYS,
    maxClosedRetentionDays,
    openSnapshotsByClient: {},
    closedByTabKey: {},
    devicesById: {},
  }
}

function validateRetention(days: number): number {
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    throw new Error('Closed tab retention must be an integer from 1 to 30 days')
  }
  return days
}

function validateRecordCaps(records: RegistryTabRecord[], caps: TabsRegistryCaps): void {
  if (records.length > caps.maxRecordsPerPush) {
    throw new Error(`Tabs registry push can contain at most ${caps.maxRecordsPerPush} records`)
  }
  const seen = new Set<string>()
  for (const record of records) {
    if (seen.has(record.tabKey)) {
      throw new Error(`Tabs registry push contains duplicate tab key: ${record.tabKey}`)
    }
    seen.add(record.tabKey)
    if (record.panes.length > caps.maxPanesPerRecord || record.paneCount > caps.maxPanesPerRecord) {
      throw new Error(`Tabs registry record can contain at most ${caps.maxPanesPerRecord} panes`)
    }
  }
}

function validateStateCaps(state: CompactTabsRegistryStateV1, caps: TabsRegistryCaps): void {
  const snapshotCount = Object.keys(state.openSnapshotsByClient).length
  if (snapshotCount > caps.maxClientSnapshotRefs) {
    throw new Error(`Tabs registry can retain at most ${caps.maxClientSnapshotRefs} client snapshots`)
  }
  const closedCount = Object.keys(state.closedByTabKey).length
  if (closedCount > caps.maxClosedTombstones) {
    throw new Error(`Tabs registry can retain at most ${caps.maxClosedTombstones} closed tombstones`)
  }
  const stateBytes = jsonBytes(state)
  if (stateBytes > caps.maxCompactStateBytes) {
    throw new Error(`Tabs registry compact state exceeds ${formatBytes(caps.maxCompactStateBytes)}`)
  }
}

function pruneClosedTombstones(
  closedByTabKey: Record<string, RegistryTabRecord>,
  now: number,
  maxClosedRetentionDays: number,
  maxClosedTombstones: number,
): Record<string, RegistryTabRecord> {
  const cutoff = now - maxClosedRetentionDays * DAY_MS
  const retained = Object.values(closedByTabKey)
    .filter((record) => (record.closedAt ?? record.updatedAt) >= cutoff)
    .sort(sortByClosedDesc)
    .slice(0, maxClosedTombstones)
  return Object.fromEntries(retained.map((record) => [record.tabKey, record]))
}

function applyQueuedMaintenance(
  state: CompactTabsRegistryStateV1,
  now: number,
  caps: TabsRegistryCaps,
): CompactTabsRegistryStateV1 {
  const openCutoff = now - state.openSnapshotTtlMinutes * MINUTE_MS
  const deviceCutoff = now - state.deviceDisplayTtlDays * DAY_MS
  return {
    ...state,
    savedAt: now,
    openSnapshotsByClient: Object.fromEntries(
      Object.entries(state.openSnapshotsByClient)
        .filter(([, snapshot]) => snapshot.snapshotReceivedAt >= openCutoff)
        .sort(([, a], [, b]) => b.snapshotReceivedAt - a.snapshotReceivedAt)
        .slice(0, caps.maxClientSnapshotRefs),
    ),
    closedByTabKey: pruneClosedTombstones(
      state.closedByTabKey,
      now,
      state.maxClosedRetentionDays,
      caps.maxClosedTombstones,
    ),
    devicesById: Object.fromEntries(
      Object.entries(state.devicesById)
        .filter(([, device]) => device.lastSeenAt >= deviceCutoff)
        .sort(([, a], [, b]) => b.lastSeenAt - a.lastSeenAt),
    ),
  }
}

function assertSnapshotRecordOwnership(input: ReplaceClientSnapshotInput, record: RegistryTabRecord): void {
  if (record.deviceId !== input.deviceId || record.deviceLabel !== input.deviceLabel) {
    throw new Error('Tabs registry record device metadata must match the snapshot device metadata')
  }
}

function buildPushPayloadHash(input: ReplaceClientSnapshotInput, parsedRecords: RegistryTabRecord[]): string {
  return sha256(stableStringify({
    deviceId: input.deviceId,
    deviceLabel: input.deviceLabel,
    clientInstanceId: input.clientInstanceId,
    snapshotRevision: input.snapshotRevision,
    records: parsedRecords,
  }))
}

async function bestEffortFsyncFile(file: string): Promise<void> {
  try {
    const handle = await fsp.open(file, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Some filesystems used in tests do not support fsync consistently.
  }
}

async function bestEffortFsyncDir(dir: string): Promise<void> {
  try {
    const handle = await fsp.open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Directory fsync is best-effort across platforms.
  }
}

function archiveTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

export class TabsRegistryStore {
  private state: CompactTabsRegistryStateV1
  private manifestRevision = 0
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly now: () => number
  private readonly caps: TabsRegistryCaps
  private failurePoint?: FailurePoint
  private beforeManifestPublishHook?: () => Promise<void>

  private constructor(
    private readonly rootDir: string,
    state: CompactTabsRegistryStateV1,
    manifestRevision: number,
    options: TabsRegistryStoreOptions = {},
  ) {
    this.state = state
    this.manifestRevision = manifestRevision
    this.now = options.now ?? (() => Date.now())
    this.caps = { ...DEFAULT_CAPS, ...(options.caps ?? {}) }
  }

  static async open(rootDir: string, options: TabsRegistryStoreOptions = {}): Promise<TabsRegistryStore> {
    const resolvedRoot = resolveStoreDir(rootDir)
    const caps = { ...DEFAULT_CAPS, ...(options.caps ?? {}) }
    const now = options.now ?? (() => Date.now())
    await fsp.mkdir(path.join(resolvedRoot, 'v1', 'objects'), { recursive: true })
    await fsp.mkdir(path.join(resolvedRoot, 'v1', 'tmp'), { recursive: true })

    const compactManifestPath = path.join(resolvedRoot, 'v1', 'manifest.json')
    if (fs.existsSync(compactManifestPath)) {
      const { state, manifestRevision } = await TabsRegistryStore.loadCompactState(resolvedRoot, caps)
      return new TabsRegistryStore(resolvedRoot, state, manifestRevision, options)
    }

    const legacyPath = path.join(resolvedRoot, 'tabs-registry.jsonl')
    if (fs.existsSync(legacyPath)) {
      const migrationStartedAt = now()
      const state = await TabsRegistryStore.migrateLegacyJsonl(legacyPath, migrationStartedAt, caps, options.defaultClosedRetentionDays)
      const store = new TabsRegistryStore(resolvedRoot, state, 0, options)
      await store.commitState(state)
      const archivePath = path.join(resolvedRoot, `tabs-registry.jsonl.migrated-${archiveTimestamp(new Date(migrationStartedAt))}`)
      await fsp.rename(legacyPath, archivePath)
      await bestEffortFsyncDir(resolvedRoot)
      return store
    }

    return new TabsRegistryStore(
      resolvedRoot,
      emptyState(now(), options.defaultClosedRetentionDays ?? DEFAULT_CLOSED_RETENTION_DAYS),
      0,
      options,
    )
  }

  private static async loadCompactState(rootDir: string, caps: TabsRegistryCaps): Promise<{
    state: CompactTabsRegistryStateV1
    manifestRevision: number
  }> {
    const manifestPath = path.join(rootDir, 'v1', 'manifest.json')
    let manifest: TabsRegistryManifestV1
    try {
      manifest = ManifestSchema.parse(JSON.parse(await fsp.readFile(manifestPath, 'utf-8')))
    } catch (error) {
      throw new Error(`Tabs registry compact state manifest is invalid: ${error instanceof Error ? error.message : String(error)}`)
    }

    const readObject = async <T>(ref: ObjectRef, schema: z.ZodType<T>): Promise<T> => {
      const absolute = path.join(rootDir, 'v1', ref.path)
      const raw = await fsp.readFile(absolute, 'utf-8')
      const bytes = Buffer.byteLength(raw, 'utf-8')
      const digest = sha256(raw)
      if (bytes !== ref.bytes || digest !== ref.sha256) {
        throw new Error(`Tabs registry compact state object failed hash validation: ${ref.path}`)
      }
      return schema.parse(JSON.parse(raw))
    }

    try {
      const openEntries = await Promise.all(Object.entries(manifest.openSnapshots).map(async ([key, ref]) => {
        const snapshot = await readObject(ref, ClientOpenSnapshotSchema)
        return [key, snapshot] as const
      }))
      const state: CompactTabsRegistryStateV1 = {
        version: 1,
        savedAt: manifest.committedAt,
        openSnapshotTtlMinutes: manifest.settings.openSnapshotTtlMinutes,
        deviceDisplayTtlDays: manifest.settings.deviceDisplayTtlDays,
        maxClosedRetentionDays: manifest.settings.maxClosedRetentionDays,
        openSnapshotsByClient: Object.fromEntries(openEntries),
        closedByTabKey: await readObject(manifest.closedTombstones, ClosedTombstonesSchema),
        devicesById: await readObject(manifest.devices, DevicesSchema),
      }
      validateStateCaps(state, caps)
      return { state, manifestRevision: manifest.manifestRevision }
    } catch (error) {
      throw new Error(`Tabs registry compact state is invalid: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private static async migrateLegacyJsonl(
    legacyPath: string,
    migrationStartedAt: number,
    caps: TabsRegistryCaps,
    maxClosedRetentionDays = DEFAULT_CLOSED_RETENTION_DAYS,
  ): Promise<CompactTabsRegistryStateV1> {
    const latestByTabKey = new Map<string, RegistryTabRecord>()
    const input = fs.createReadStream(legacyPath, { encoding: 'utf-8' })
    const lines = readline.createInterface({ input, crlfDelay: Infinity })
    let retainedBytes = 0

    for await (const line of lines) {
      const lineBytes = Buffer.byteLength(line, 'utf-8')
      if (lineBytes > caps.maxLegacyLineBytes) {
        throw new Error(`Tabs registry legacy migration cap exceeded: line is larger than ${formatBytes(caps.maxLegacyLineBytes)}`)
      }
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const record = TabRegistryRecordSchema.parse(JSON.parse(trimmed))
        validateRecordCaps([record], caps)
        const current = latestByTabKey.get(record.tabKey)
        const winner = pickEventWinner(current, record)
        if (winner !== current) {
          retainedBytes -= current ? jsonBytes(current) : 0
          retainedBytes += jsonBytes(winner)
          if (retainedBytes > caps.maxMigrationRetainedBytes) {
            throw new Error(`Tabs registry legacy migration retained-byte cap exceeded: ${formatBytes(caps.maxMigrationRetainedBytes)}`)
          }
          latestByTabKey.set(record.tabKey, winner)
        }
        if (latestByTabKey.size > caps.maxLegacyUniqueTabKeys) {
          throw new Error(`Tabs registry legacy migration cap exceeded: more than ${caps.maxLegacyUniqueTabKeys} unique tab keys`)
        }
      } catch (error) {
        if (error instanceof Error && /cap exceeded/i.test(error.message)) throw error
      }
    }

    const state = emptyState(migrationStartedAt, maxClosedRetentionDays)
    const openByDevice = new Map<string, RegistryTabRecord[]>()
    const closedCutoff = migrationStartedAt - maxClosedRetentionDays * DAY_MS

    for (const record of latestByTabKey.values()) {
      if (record.status === 'closed') {
        if ((record.closedAt ?? record.updatedAt) >= closedCutoff) {
          state.closedByTabKey[record.tabKey] = record
        }
        continue
      }
      const records = openByDevice.get(record.deviceId) ?? []
      records.push(record)
      openByDevice.set(record.deviceId, records)
      state.devicesById[record.deviceId] = {
        deviceId: record.deviceId,
        deviceLabel: record.deviceLabel,
        lastSeenAt: migrationStartedAt,
      }
    }

    for (const [deviceId, records] of openByDevice) {
      const deviceLabel = records[0]?.deviceLabel ?? deviceId
      const snapshot: ClientOpenSnapshot = {
        deviceId,
        deviceLabel,
        clientInstanceId: 'legacy-migration',
        snapshotRevision: 1,
        lastPushPayloadHash: sha256(stableStringify({ deviceId, deviceLabel, clientInstanceId: 'legacy-migration', snapshotRevision: 1, records })),
        snapshotReceivedAt: migrationStartedAt,
        records,
      }
      state.openSnapshotsByClient[clientSnapshotKey(deviceId, 'legacy-migration')] = snapshot
    }

    const maintained = applyQueuedMaintenance(state, migrationStartedAt, caps)
    validateStateCaps(maintained, caps)
    return maintained
  }

  setTestFailurePoint(point: FailurePoint | undefined): void {
    this.failurePoint = point
  }

  setTestBeforeManifestPublishHook(hook: (() => Promise<void>) | undefined): void {
    this.beforeManifestPublishHook = hook
  }

  private maybeFail(point: FailurePoint): void {
    if (this.failurePoint === point) {
      this.failurePoint = undefined
      throw new Error(`Injected tabs registry ${point} failure`)
    }
  }

  private async writeObject(value: unknown, maxBytes: number): Promise<ObjectRef> {
    const raw = stableStringify(value)
    const bytes = Buffer.byteLength(raw, 'utf-8')
    if (bytes > maxBytes) {
      throw new Error(`Tabs registry object exceeds ${formatBytes(maxBytes)}`)
    }
    const digest = sha256(raw)
    const relativePath = `objects/${digest}.json`
    const objectPath = path.join(this.rootDir, 'v1', relativePath)
    if (fs.existsSync(objectPath)) {
      return { path: relativePath, sha256: digest, bytes }
    }

    const tmpPath = path.join(this.rootDir, 'v1', 'tmp', `${digest}.${process.pid}.${Date.now()}.tmp`)
    this.maybeFail('object-write')
    await fsp.writeFile(tmpPath, raw, 'utf-8')
    await bestEffortFsyncFile(tmpPath)
    this.maybeFail('object-rename')
    await fsp.rename(tmpPath, objectPath).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') {
        await fsp.rm(tmpPath, { force: true })
        return
      }
      throw error
    })
    await bestEffortFsyncDir(path.dirname(objectPath))
    return { path: relativePath, sha256: digest, bytes }
  }

  private async buildManifest(state: CompactTabsRegistryStateV1): Promise<TabsRegistryManifestV1> {
    const openSnapshots: Record<string, ObjectRef> = {}
    for (const [key, snapshot] of Object.entries(state.openSnapshotsByClient)) {
      openSnapshots[key] = await this.writeObject(snapshot, this.caps.maxSerializedClientSnapshotObjectBytes)
    }
    const closedTombstones = await this.writeObject(state.closedByTabKey, this.caps.maxSerializedClosedTombstoneObjectBytes)
    const devices = await this.writeObject(state.devicesById, this.caps.maxSerializedDeviceMetadataObjectBytes)
    return {
      version: 1,
      manifestRevision: this.manifestRevision + 1,
      committedAt: state.savedAt,
      openSnapshots,
      closedTombstones,
      devices,
      settings: {
        openSnapshotTtlMinutes: state.openSnapshotTtlMinutes,
        deviceDisplayTtlDays: state.deviceDisplayTtlDays,
        maxClosedRetentionDays: state.maxClosedRetentionDays,
      },
    }
  }

  private async publishManifest(manifest: TabsRegistryManifestV1): Promise<void> {
    const manifestPath = path.join(this.rootDir, 'v1', 'manifest.json')
    const tmpPath = path.join(this.rootDir, 'v1', 'manifest.json.tmp')
    const raw = stableStringify(manifest)
    await this.beforeManifestPublishHook?.()
    this.maybeFail('manifest-write')
    await fsp.writeFile(tmpPath, raw, 'utf-8')
    await bestEffortFsyncFile(tmpPath)
    this.maybeFail('manifest-rename')
    await fsp.rename(tmpPath, manifestPath)
    await bestEffortFsyncDir(path.dirname(manifestPath))
  }

  private async garbageCollectObjects(manifest: TabsRegistryManifestV1): Promise<void> {
    const referenced = new Set<string>([
      manifest.closedTombstones.path,
      manifest.devices.path,
      ...Object.values(manifest.openSnapshots).map((ref) => ref.path),
    ])
    const objectsDir = path.join(this.rootDir, 'v1', 'objects')
    const tmpDir = path.join(this.rootDir, 'v1', 'tmp')
    await fsp.mkdir(objectsDir, { recursive: true })
    await fsp.mkdir(tmpDir, { recursive: true })
    for (const file of await fsp.readdir(objectsDir)) {
      const relative = `objects/${file}`
      if (!referenced.has(relative)) {
        await fsp.rm(path.join(objectsDir, file), { force: true })
      }
    }
    for (const file of await fsp.readdir(tmpDir)) {
      await fsp.rm(path.join(tmpDir, file), { force: true, recursive: true })
    }
  }

  private async commitState(nextState: CompactTabsRegistryStateV1): Promise<TabsRegistryManifestV1> {
    await fsp.mkdir(path.join(this.rootDir, 'v1', 'objects'), { recursive: true })
    await fsp.mkdir(path.join(this.rootDir, 'v1', 'tmp'), { recursive: true })
    validateStateCaps(nextState, this.caps)
    const manifest = await this.buildManifest(nextState)
    await this.publishManifest(manifest)
    this.state = nextState
    this.manifestRevision = manifest.manifestRevision
    await this.garbageCollectObjects(manifest)
    return manifest
  }

  private enqueueMutation<T>(mutate: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(mutate, mutate)
    this.writeQueue = run.then(() => undefined, () => undefined)
    return run
  }

  async replaceClientSnapshot(input: ReplaceClientSnapshotInput): Promise<{
    accepted: boolean
    openRecords: number
    closedRecords: number
  }> {
    const receiptTime = this.now()
    const parsedRecords = input.records.map((record) => TabRegistryRecordSchema.parse(record))
    validateRecordCaps(parsedRecords, this.caps)
    const pushBytes = jsonBytes({ ...input, records: parsedRecords })
    if (pushBytes > this.caps.maxSerializedPushBytes) {
      throw new Error(`Tabs registry push payload exceeds ${formatBytes(this.caps.maxSerializedPushBytes)}`)
    }

    const openRecords = parsedRecords.filter((record) => record.status === 'open')
    const closedRecords = parsedRecords.filter((record) => record.status === 'closed')
    if (openRecords.length > this.caps.maxOpenRecordsPerClientSnapshot) {
      throw new Error(`Tabs registry client snapshot can contain at most ${this.caps.maxOpenRecordsPerClientSnapshot} open records`)
    }
    if (closedRecords.length > this.caps.maxClosedRecordsPerPush) {
      throw new Error(`Tabs registry push can contain at most ${this.caps.maxClosedRecordsPerPush} closed records`)
    }
    for (const record of parsedRecords) {
      assertSnapshotRecordOwnership(input, record)
    }

    const key = clientSnapshotKey(input.deviceId, input.clientInstanceId)
    const pushHash = buildPushPayloadHash(input, parsedRecords)

    return this.enqueueMutation(async () => {
      const current = this.state.openSnapshotsByClient[key]
      if (current) {
        if (input.snapshotRevision < current.snapshotRevision) {
          throw new Error('Stale snapshot revision rejected for tabs registry client snapshot')
        }
        if (input.snapshotRevision === current.snapshotRevision) {
          if (pushHash !== current.lastPushPayloadHash) {
            throw new Error('Duplicate snapshot revision has different tabs registry content')
          }
          return { accepted: true, openRecords: openRecords.length, closedRecords: closedRecords.length }
        }
      }

      let next = cloneState(this.state, receiptTime)
      for (const closedRecord of closedRecords) {
        next.closedByTabKey[closedRecord.tabKey] = pickEventWinner(next.closedByTabKey[closedRecord.tabKey], closedRecord)
      }

      for (const openRecord of openRecords) {
        const closed = next.closedByTabKey[openRecord.tabKey]
        if (closed && compareRegistryRecordsByEventTime(closed, openRecord) < 0) {
          delete next.closedByTabKey[openRecord.tabKey]
        }
      }

      next.openSnapshotsByClient[key] = {
        deviceId: input.deviceId,
        deviceLabel: input.deviceLabel,
        clientInstanceId: input.clientInstanceId,
        snapshotRevision: input.snapshotRevision,
        lastPushPayloadHash: pushHash,
        snapshotReceivedAt: receiptTime,
        records: openRecords,
      }
      next.devicesById[input.deviceId] = {
        deviceId: input.deviceId,
        deviceLabel: input.deviceLabel,
        lastSeenAt: receiptTime,
      }
      next = applyQueuedMaintenance(next, receiptTime, this.caps)
      await this.commitState(next)
      return { accepted: true, openRecords: openRecords.length, closedRecords: closedRecords.length }
    })
  }

  async retireClientSnapshot(input: RetireClientSnapshotInput): Promise<{ accepted: boolean }> {
    const receiptTime = this.now()
    const key = clientSnapshotKey(input.deviceId, input.clientInstanceId)
    return this.enqueueMutation(async () => {
      const current = this.state.openSnapshotsByClient[key]
      if (!current) return { accepted: false }
      if (input.snapshotRevision < current.snapshotRevision) return { accepted: false }

      let next = cloneState(this.state, receiptTime)
      delete next.openSnapshotsByClient[key]
      next.devicesById[input.deviceId] = {
        deviceId: current.deviceId,
        deviceLabel: current.deviceLabel,
        lastSeenAt: receiptTime,
      }
      next = applyQueuedMaintenance(next, receiptTime, this.caps)
      await this.commitState(next)
      return { accepted: true }
    })
  }

  async query(input: TabsRegistryQueryInput): Promise<TabsRegistryQueryResult> {
    const closedTabRetentionDays = validateRetention(input.closedTabRetentionDays)
    const now = this.now()
    const openCutoff = now - this.state.openSnapshotTtlMinutes * MINUTE_MS
    const closedDisplayCutoff = now - closedTabRetentionDays * DAY_MS

    const winners = new Map<string, { record: RegistryTabRecord; snapshot?: ClientOpenSnapshot }>()

    for (const snapshot of Object.values(this.state.openSnapshotsByClient)) {
      if (snapshot.snapshotReceivedAt < openCutoff) continue
      for (const record of snapshot.records) {
        const current = winners.get(record.tabKey)
        if (!current || compareRegistryRecordsByEventTime(current.record, record) <= 0) {
          winners.set(record.tabKey, { record, snapshot })
        }
      }
    }

    for (const record of Object.values(this.state.closedByTabKey)) {
      const current = winners.get(record.tabKey)
      if (!current || compareRegistryRecordsByEventTime(current.record, record) <= 0) {
        winners.set(record.tabKey, { record })
      }
    }

    const localOpen: RegistryTabRecord[] = []
    const sameDeviceOpen: RegistryTabRecord[] = []
    const remoteOpen: RegistryTabRecord[] = []
    const closed: RegistryTabRecord[] = []

    for (const winner of winners.values()) {
      const { record, snapshot } = winner
      if (record.status === 'closed') {
        if ((record.closedAt ?? record.updatedAt) >= closedDisplayCutoff) {
          closed.push(record)
        }
        continue
      }
      if (record.deviceId === input.deviceId && snapshot?.clientInstanceId === input.clientInstanceId) {
        localOpen.push(record)
      } else if (record.deviceId === input.deviceId) {
        sameDeviceOpen.push(record)
      } else {
        remoteOpen.push(record)
      }
    }

    return {
      localOpen: localOpen.sort(sortByUpdatedDesc),
      sameDeviceOpen: sameDeviceOpen.sort(sortByUpdatedDesc),
      remoteOpen: remoteOpen.sort(sortByUpdatedDesc),
      closed: closed.sort(sortByClosedDesc),
      devices: this.listDevices(),
    }
  }

  listDevices(): RegistryDeviceEntry[] {
    const now = this.now()
    const cutoff = now - this.state.deviceDisplayTtlDays * DAY_MS
    return Object.values(this.state.devicesById)
      .filter((device) => device.lastSeenAt >= cutoff)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  count(): number {
    return Object.values(this.state.openSnapshotsByClient).reduce((sum, snapshot) => sum + snapshot.records.length, 0)
      + Object.keys(this.state.closedByTabKey).length
  }
}

export async function createTabsRegistryStore(
  baseDir?: string,
  options: TabsRegistryStoreOptions = {},
): Promise<TabsRegistryStore> {
  return TabsRegistryStore.open(resolveStoreDir(baseDir), options)
}
