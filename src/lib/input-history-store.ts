import { STORAGE_KEYS } from '@/store/storage-keys'

const MAX_ENTRIES = 500

function storageKey(paneId: string): string {
  return `${STORAGE_KEYS.inputHistory}:${paneId}`
}

export function loadHistory(paneId: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(paneId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveHistory(paneId: string, entries: string[]): void {
  localStorage.setItem(storageKey(paneId), JSON.stringify(entries))
}

export function pushEntry(paneId: string, entry: string): string[] {
  const history = loadHistory(paneId)
  if (history.length > 0 && history[history.length - 1] === entry) {
    return history
  }
  history.push(entry)
  while (history.length > MAX_ENTRIES) {
    history.shift()
  }
  saveHistory(paneId, history)
  return history
}

export function clearHistory(paneId: string): void {
  localStorage.removeItem(storageKey(paneId))
}
