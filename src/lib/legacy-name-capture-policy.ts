/**
 * Name reliability (Task 2) — WHEN the browser captures legacy-name evidence,
 * WHAT counts as evidence, and when the captured copies are deleted.
 *
 * The one-time legacy-name consolidation needs the labels a user gave agent
 * tabs and panes before the saved-name records existed. Those labels live
 * only in the genuine pre-migration keys: the bare shared `freshell.layout.v3`
 * family (`freshell.layout.v3`, `freshell.layout.v3.bak`,
 * `freshell.layout.pre-migration-raw.v1`) and the v2 `freshell.tabs.v2` /
 * `freshell.panes.v2` keys, and only while their bytes carry no
 * unified-names fields. A per-window layout key, its channels and its
 * pre-migration sidecar are written by the current client itself: they hold
 * display copies of the saved names, never evidence (G1, G44).
 *
 * The lifecycle, per device (one browser profile's localStorage):
 * 1. The first boot copies each genuine source once into an immutable
 *    envelope (`freshell.session-names.migration.v1.<importId>`). A source
 *    that is absent or carries unified-names fields is skipped; with nothing
 *    to capture the device is done at once.
 * 2. The connection-ready submit sends the pending envelopes; each one is
 *    deleted when acknowledged, and the device is marked done
 *    (`freshell.session-names.capture-done.v1`) when none is left.
 * 3. A done device never captures or submits again, and deletes any
 *    envelope it still finds (left by an older client build).
 * A device that already holds envelopes or acknowledgment markers (from an
 * earlier boot, or from an older client build that copied every layout) has
 * captured before: it keeps only the genuine unacknowledged envelopes for
 * submission, deletes the rest, and never captures again.
 *
 * A failed write never throws and never blocks anything else (the layout
 * save in particular): it is logged as `legacy_name_capture_failed` and the
 * evidence is dropped, not the user's state (RC10). The connection-ready
 * submit then finds nothing pending for that source and marks the device
 * done; only a page load that never reaches a ready connection leaves the
 * capture to the next boot. Envelopes the storage-version wipe deletes
 * (`@/store/storage-migration` on a device older than the current storage
 * version removes every `freshell.session-names.*` key right after this
 * pass) are dropped the same way. This is the accepted tradeoff: once the
 * server's own boot consolidation has completed, it acknowledges a browser
 * import without writing anything (name reliability Task 3).
 *
 * The pass runs while `main.tsx` evaluates its imports, before it installs
 * client log forwarding, so the pass's errors first reach only the browser
 * console. `main.tsx` then calls `reportBootCaptureFailures`, which replays
 * them once so they also reach the server log.
 *
 * This module must never import the Redux store: it runs from `main.tsx`
 * (through `@/lib/session-name-migration`) before the store and the storage
 * migrations load.
 */

import { nanoid } from 'nanoid'
import { createLogger } from '@/lib/client-logger'
import {
  LEGACY_LAYOUT_BACKUP_STORAGE_KEY,
  LEGACY_LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY,
  LEGACY_LAYOUT_STORAGE_KEY,
  PANES_STORAGE_KEY,
  TABS_STORAGE_KEY,
} from '@/store/storage-keys'

const log = createLogger('LegacyNameCapture')

/** The immutable recovery-envelope key prefix (one key per importId). */
export const SESSION_NAME_MIGRATION_KEY_PREFIX = 'freshell.session-names.migration.v1'
/** The durable once-per-device marker. A separate prefix, so the envelope
 * enumeration never sees it. */
export const LEGACY_NAME_CAPTURE_DONE_KEY = 'freshell.session-names.capture-done.v1'
/** The acknowledged-importId marker segment (create-once, no shared blob). */
const ACKNOWLEDGED_MARKER_SEGMENT = 'ack'

/** The genuine pre-migration source keys, in capture order. */
const GENUINE_PRE_MIGRATION_SOURCE_KEYS: readonly string[] = [
  LEGACY_LAYOUT_STORAGE_KEY,
  LEGACY_LAYOUT_BACKUP_STORAGE_KEY,
  LEGACY_LAYOUT_PRE_MIGRATION_RAW_STORAGE_KEY,
  TABS_STORAGE_KEY,
  PANES_STORAGE_KEY,
]

/** Fields only a client that already has saved-name records writes: a tab's
 * `nameSource`, a pane's `nameRef` / `namingHandle`. */
const UNIFIED_NAMES_FIELDS: ReadonlySet<string> = new Set(['nameSource', 'nameRef', 'namingHandle'])

/** One captured immutable recovery envelope (the local storage shape). */
export type LegacyNameMigrationEnvelope = {
  version: 1
  importId: string
  storageKey: string
  raw: string
  capturedAt: number
}

type ReadableStorage = Pick<Storage, 'length' | 'key' | 'getItem'>
type CaptureStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>

function defaultStorage(): CaptureStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function envelopeKey(importId: string): string {
  return `${SESSION_NAME_MIGRATION_KEY_PREFIX}.${importId}`
}

function acknowledgedKey(importId: string): string {
  return `${SESSION_NAME_MIGRATION_KEY_PREFIX}.${ACKNOWLEDGED_MARKER_SEGMENT}.${importId}`
}

const ACKNOWLEDGED_KEY_PREFIX = `${SESSION_NAME_MIGRATION_KEY_PREFIX}.${ACKNOWLEDGED_MARKER_SEGMENT}.`

/** A short, content-free failure reason for logs (never the stored bytes):
 * the error's name (`QuotaExceededError`), else its message. */
function failureReason(error: unknown): string {
  if (error && typeof error === 'object') {
    const { name, message } = error as { name?: unknown; message?: unknown }
    if (typeof name === 'string' && name.length > 0 && name !== 'Error') return name
    if (typeof message === 'string') return message
  }
  return String(error)
}

// ---------------------------------------------------------------------------
// What counts as evidence
// ---------------------------------------------------------------------------

/** Does the parsed JSON carry any unified-names field anywhere? */
function carriesUnifiedNamesFields(parsed: unknown): boolean {
  const pending: unknown[] = [parsed]
  while (pending.length > 0) {
    const value = pending.pop()
    if (!value || typeof value !== 'object') continue
    if (Array.isArray(value)) {
      pending.push(...value)
      continue
    }
    for (const [key, child] of Object.entries(value)) {
      if (UNIFIED_NAMES_FIELDS.has(key)) return true
      pending.push(child)
    }
  }
  return false
}

/**
 * Is (`key`, `raw`) genuine pre-migration name evidence? Only the bare
 * shared legacy keys and the v2 keys qualify, and only when the bytes parse
 * and carry no unified-names fields.
 */
export function isGenuinePreMigrationSource(key: string, raw: string | null | undefined): boolean {
  if (!GENUINE_PRE_MIGRATION_SOURCE_KEYS.includes(key)) return false
  if (typeof raw !== 'string' || raw.length === 0) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  return !carriesUnifiedNamesFields(parsed)
}

// ---------------------------------------------------------------------------
// Envelopes and acknowledgment markers
// ---------------------------------------------------------------------------

/** Parse one stored envelope; undefined for anything else. */
function parseStoredEnvelope(raw: string | null): LegacyNameMigrationEnvelope | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<LegacyNameMigrationEnvelope>
    if (
      parsed?.version === 1
      && typeof parsed.importId === 'string' && parsed.importId.length > 0
      && typeof parsed.storageKey === 'string' && parsed.storageKey.length > 0
      && typeof parsed.raw === 'string'
    ) {
      return parsed as LegacyNameMigrationEnvelope
    }
  } catch {
    return undefined
  }
  return undefined
}

/** Every key under the migration prefix (envelopes and ack markers). */
function migrationKeys(storage: ReadableStorage): string[] {
  const keys: string[] = []
  const total = storage.length
  for (let index = 0; index < total; index += 1) {
    const key = storage.key(index)
    if (key && key.startsWith(`${SESSION_NAME_MIGRATION_KEY_PREFIX}.`)) keys.push(key)
  }
  return keys
}

/** Enumerate the captured envelopes by prefix. */
export function listCapturedMigrationEnvelopes(
  storage: ReadableStorage | null = defaultStorage(),
): LegacyNameMigrationEnvelope[] {
  if (!storage) return []
  const envelopes: LegacyNameMigrationEnvelope[] = []
  const seen = new Set<string>()
  try {
    for (const key of migrationKeys(storage)) {
      if (key.startsWith(ACKNOWLEDGED_KEY_PREFIX)) continue
      const envelope = parseStoredEnvelope(storage.getItem(key))
      if (!envelope || seen.has(envelope.importId)) continue
      seen.add(envelope.importId)
      envelopes.push(envelope)
    }
  } catch (error) {
    log.error('failed to enumerate captured legacy-name envelopes', { reason: failureReason(error) })
  }
  return envelopes
}

/** Has this import id (an envelope's or one of its chunks') been
 * acknowledged? */
export function isAcknowledged(storage: Pick<Storage, 'getItem'>, importId: string): boolean {
  try {
    return storage.getItem(acknowledgedKey(importId)) !== null
  } catch {
    return false
  }
}

/**
 * Record one import id as acknowledged and delete its envelope, if any (the
 * server keeps its own immutable copy). A chunk id has no envelope of its
 * own; its marker lets a resumed submit skip it until the envelope retires.
 */
export function markAcknowledged(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, importId: string): void {
  try {
    storage.removeItem(envelopeKey(importId))
    if (!isAcknowledged(storage, importId)) {
      storage.setItem(acknowledgedKey(importId), '1')
    }
  } catch (error) {
    log.warn('legacy_name_ack_marker_failed', { importId, reason: failureReason(error) })
  }
}

/**
 * Delete every envelope that will never be submitted — acknowledged ones,
 * copies of sources that are not genuine evidence, unreadable ones — and the
 * acknowledgment markers no pending envelope needs. Returns the genuine
 * envelopes still waiting for acknowledgment.
 */
export function purgeObsoleteEnvelopes(
  storage: CaptureStorage | null = defaultStorage(),
): LegacyNameMigrationEnvelope[] {
  if (!storage) return []
  const pending: LegacyNameMigrationEnvelope[] = []
  try {
    const keys = migrationKeys(storage)
    const markerKeys = keys.filter((key) => key.startsWith(ACKNOWLEDGED_KEY_PREFIX))
    for (const key of keys) {
      if (key.startsWith(ACKNOWLEDGED_KEY_PREFIX)) continue
      const envelope = parseStoredEnvelope(storage.getItem(key))
      if (
        envelope
        && key === envelopeKey(envelope.importId)
        && !isAcknowledged(storage, envelope.importId)
        && isGenuinePreMigrationSource(envelope.storageKey, envelope.raw)
      ) {
        pending.push(envelope)
        continue
      }
      storage.removeItem(key)
    }
    // A marker survives only while it may name a pending envelope's chunk
    // (`<importId>--<n>`), so a resumed submit skips the chunks that landed.
    for (const markerKey of markerKeys) {
      const importId = markerKey.slice(ACKNOWLEDGED_KEY_PREFIX.length)
      const belongsToPending = pending.some((envelope) => importId.startsWith(`${envelope.importId}--`))
      if (!belongsToPending) storage.removeItem(markerKey)
    }
  } catch (error) {
    log.error('legacy_name_envelope_purge_failed', { reason: failureReason(error) })
  }
  return pending
}

// ---------------------------------------------------------------------------
// The once-per-device marker
// ---------------------------------------------------------------------------

/** Has this device finished its one-time capture? (No storage: nothing can
 * ever be captured, so yes.) */
export function isCaptureDone(storage: Pick<Storage, 'getItem'> | null = defaultStorage()): boolean {
  if (!storage) return true
  try {
    return storage.getItem(LEGACY_NAME_CAPTURE_DONE_KEY) !== null
  } catch {
    return false
  }
}

/** Mark this device's one-time capture finished. */
export function markCaptureDone(storage: Pick<Storage, 'setItem'> | null = defaultStorage()): void {
  if (!storage) return
  try {
    storage.setItem(LEGACY_NAME_CAPTURE_DONE_KEY, JSON.stringify({ version: 1, doneAt: Date.now() }))
    log.info('legacy_name_capture_done')
  } catch (error) {
    // The next boot repeats the (cheap) check and tries again.
    log.warn('legacy_name_capture_done_marker_failed', { reason: failureReason(error) })
  }
}

// ---------------------------------------------------------------------------
// The one-time capture
// ---------------------------------------------------------------------------

/** What one boot's capture pass did. */
export type LegacyCaptureOutcome =
  /** The device finished before this boot; leftovers were deleted. */
  | 'already_done'
  /** Nothing (more) to capture or submit: the device is now done. */
  | 'done'
  /** Genuine envelopes wait for the connection-ready submit. */
  | 'pending'
  /** A capture read or write failed; that source's evidence is dropped (see
   * the module comment). */
  | 'failed'

/** One content-free capture failure (never the stored bytes). */
type CaptureFailure = { storageKey?: string; reason: string }

/**
 * This page load's boot-pass failures, kept for `reportBootCaptureFailures`
 * (the pass logs before client log forwarding exists). Each pass replaces
 * the list.
 */
let unreportedBootFailures: CaptureFailure[] = []

/** Log one capture failure now and keep it for the replay. */
function recordCaptureFailure(failures: CaptureFailure[], failure: CaptureFailure): void {
  log.error('legacy_name_capture_failed', failure)
  failures.push(failure)
}

/** Copy each genuine source into its own envelope; returns how many were
 * written. Every failure goes to `failures`. */
function captureGenuineSources(storage: CaptureStorage, failures: CaptureFailure[]): number {
  let captured = 0
  for (const storageKey of GENUINE_PRE_MIGRATION_SOURCE_KEYS) {
    let raw: string | null
    try {
      raw = storage.getItem(storageKey)
    } catch (error) {
      recordCaptureFailure(failures, { storageKey, reason: failureReason(error) })
      continue
    }
    if (raw === null || !isGenuinePreMigrationSource(storageKey, raw)) continue
    const envelope: LegacyNameMigrationEnvelope = {
      version: 1,
      importId: nanoid(),
      storageKey,
      raw,
      capturedAt: Date.now(),
    }
    try {
      storage.setItem(envelopeKey(envelope.importId), JSON.stringify(envelope))
      captured += 1
    } catch (error) {
      // Drop the evidence, never the user's state: nothing else waits on
      // this write. The source is left as it is.
      recordCaptureFailure(failures, { storageKey, reason: failureReason(error) })
    }
  }
  return captured
}

/**
 * The boot-time capture pass (see the module comment for the lifecycle).
 * Never throws; every outcome is logged.
 */
export function runOneTimeLegacyCapture(
  storage: CaptureStorage | null = defaultStorage(),
): LegacyCaptureOutcome {
  const failures: CaptureFailure[] = []
  unreportedBootFailures = failures
  if (!storage) return 'already_done'
  let outcome: LegacyCaptureOutcome
  try {
    if (isCaptureDone(storage)) {
      for (const key of migrationKeys(storage)) storage.removeItem(key)
      outcome = 'already_done'
    } else {
      const hadPriorCapture = migrationKeys(storage).length > 0
      const pending = purgeObsoleteEnvelopes(storage)
      if (hadPriorCapture) {
        // This device captured before: submit what is still genuine and
        // pending, never capture again.
        outcome = pending.length > 0 ? 'pending' : 'done'
      } else {
        const captured = captureGenuineSources(storage, failures)
        outcome = failures.length > 0 ? 'failed' : captured > 0 ? 'pending' : 'done'
      }
      if (outcome === 'done') markCaptureDone(storage)
    }
  } catch (error) {
    recordCaptureFailure(failures, { reason: failureReason(error) })
    outcome = 'failed'
  }
  log.debug('legacy_name_capture_pass', { outcome })
  return outcome
}

/**
 * Replay this page load's boot-pass failures, once. `main.tsx` calls this
 * right after it installs client log forwarding, so a failure the pass
 * could only log to the browser console also reaches the server log
 * (`/api/logs/client`). Each replayed entry carries the original
 * `legacy_name_capture_failed` fields plus `replayed: true`; a clean pass
 * replays nothing.
 */
export function reportBootCaptureFailures(): void {
  const failures = unreportedBootFailures
  unreportedBootFailures = []
  for (const failure of failures) {
    log.error('legacy_name_capture_failed', { ...failure, replayed: true })
  }
}
