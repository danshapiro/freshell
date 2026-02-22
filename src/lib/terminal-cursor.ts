import { createLogger } from '@/lib/client-logger'
import { TERMINAL_CURSOR_STORAGE_KEY } from '@/store/storage-keys'

const log = createLogger('TerminalCursor')

export type CursorEntry = {
  seq: number
  updatedAt: number
}

type CursorMap = Record<string, CursorEntry>

const MAX_ENTRIES = 500
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

let cache: CursorMap | null = null

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined'
}

function normalizeSeq(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const seq = Math.floor(value)
  return seq >= 0 ? seq : 0
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const at = Math.floor(value)
  return at >= 0 ? at : 0
}

function sanitizeMap(raw: unknown): CursorMap {
  if (!raw || typeof raw !== 'object') return {}
  const input = raw as Record<string, unknown>
  const out: CursorMap = {}

  for (const [terminalId, value] of Object.entries(input)) {
    if (!terminalId || typeof terminalId !== 'string') continue
    if (!value || typeof value !== 'object') continue

    const candidate = value as Record<string, unknown>
    const seq = normalizeSeq(candidate.seq)
    const updatedAt = normalizeTimestamp(candidate.updatedAt)
    if (seq <= 0 || updatedAt <= 0) continue

    out[terminalId] = { seq, updatedAt }
  }

  return out
}

function pruneCursorMap(map: CursorMap, now: number): CursorMap {
  const cutoff = now - MAX_AGE_MS
  const retained: Array<{ terminalId: string; entry: CursorEntry }> = []

  for (const [terminalId, entry] of Object.entries(map)) {
    if (entry.updatedAt < cutoff) continue
    retained.push({ terminalId, entry })
  }

  retained.sort((a, b) => b.entry.updatedAt - a.entry.updatedAt)

  const trimmed = retained.slice(0, MAX_ENTRIES)
  const out: CursorMap = {}
  for (const { terminalId, entry } of trimmed) {
    out[terminalId] = entry
  }

  return out
}

function persistMap(map: CursorMap): void {
  if (!canUseStorage()) return
  try {
    localStorage.setItem(TERMINAL_CURSOR_STORAGE_KEY, JSON.stringify(map))
  } catch (error) {
    log.warn('Failed to persist terminal cursor map:', error)
  }
}

function ensureLoaded(): CursorMap {
  if (cache) return cache
  if (!canUseStorage()) {
    cache = {}
    return cache
  }

  let parsed: CursorMap = {}
  try {
    const raw = localStorage.getItem(TERMINAL_CURSOR_STORAGE_KEY)
    if (raw) {
      parsed = sanitizeMap(JSON.parse(raw))
    }
  } catch (error) {
    log.warn('Failed to load terminal cursor map:', error)
  }

  const pruned = pruneCursorMap(parsed, Date.now())
  cache = pruned

  const changed = JSON.stringify(parsed) !== JSON.stringify(pruned)
  if (changed) {
    persistMap(pruned)
  }

  return cache
}

export function loadTerminalCursor(terminalId: string): number {
  if (!terminalId) return 0
  const map = ensureLoaded()
  return map[terminalId]?.seq ?? 0
}

export function saveTerminalCursor(terminalId: string, seq: number): void {
  if (!terminalId) return
  const normalizedSeq = normalizeSeq(seq)
  if (normalizedSeq <= 0) return

  const map = ensureLoaded()
  const now = Date.now()
  const existing = map[terminalId]

  if (existing && existing.seq > normalizedSeq) {
    map[terminalId] = { seq: existing.seq, updatedAt: now }
  } else {
    map[terminalId] = { seq: Math.max(existing?.seq ?? 0, normalizedSeq), updatedAt: now }
  }

  cache = pruneCursorMap(map, now)
  persistMap(cache)
}

export function clearTerminalCursor(terminalId: string): void {
  if (!terminalId) return
  const map = ensureLoaded()
  if (!map[terminalId]) return
  delete map[terminalId]
  cache = map
  persistMap(cache)
}

export function getCursorMapSize(): number {
  return Object.keys(ensureLoaded()).length
}

export function __resetTerminalCursorCacheForTests(): void {
  cache = null
}
