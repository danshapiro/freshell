import { nanoid } from 'nanoid'

export const PERSIST_BROADCAST_CHANNEL_NAME = 'freshell.persist.v2'

let sourceId: string | null = null
let sourceIdByOwner = new WeakMap<object, string>()

function createSourceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return nanoid()
}

export function getPersistBroadcastSourceId(owner?: object): string {
  if (owner) {
    let ownerSourceId = sourceIdByOwner.get(owner)
    if (!ownerSourceId) {
      ownerSourceId = createSourceId()
      sourceIdByOwner.set(owner, ownerSourceId)
    }
    return ownerSourceId
  }
  if (!sourceId) sourceId = createSourceId()
  return sourceId
}

export type PersistBroadcastMessage = {
  type: 'persist'
  key: string
  raw: string
  sourceId: string
}

type PersistBroadcastListener = (msg: PersistBroadcastMessage) => void

const listeners = new Set<PersistBroadcastListener>()

export function onPersistBroadcast(listener: PersistBroadcastListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notifyListeners(msg: PersistBroadcastMessage): void {
  for (const listener of listeners) {
    try {
      listener(msg)
    } catch {
      // ignore
    }
  }
}

export function broadcastPersistedRaw(key: string, raw: string, owner?: object): void {
  const msg: PersistBroadcastMessage = {
    type: 'persist',
    key,
    raw,
    sourceId: getPersistBroadcastSourceId(owner),
  }

  // Always notify in-process listeners, even if BroadcastChannel is unavailable.
  notifyListeners(msg)

  if (typeof BroadcastChannel === 'undefined') return
  try {
    const ch = new BroadcastChannel(PERSIST_BROADCAST_CHANNEL_NAME)
    ch.postMessage(msg)
    ch.close()
  } catch {
    // ignore
  }
}

export function resetPersistBroadcastForTests(): void {
  sourceId = null
  sourceIdByOwner = new WeakMap()
  listeners.clear()
}
