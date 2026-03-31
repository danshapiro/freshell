// Coordinates progressive background hydration of terminal tabs.
// After the active tab hydrates, queues remaining tabs neighbor-first.

type HydrationEntry = {
  tabId: string
  paneId: string
  trigger: () => void
}

type HydrationQueue = {
  /** Register a tab that needs background hydration. */
  register: (entry: HydrationEntry) => void
  /** Unregister a tab (e.g., on unmount). */
  unregister: (paneId: string) => void
  /** Signal that the active tab's initial hydration is complete. Starts the queue. */
  onActiveTabReady: (activeTabId: string, tabOrder: string[]) => void
  /** Signal that a background tab's hydration completed. Advances the queue. */
  onHydrationComplete: (paneId: string) => void
  /** Notify the queue that the active tab changed. Reprioritizes if needed. */
  onActiveTabChanged: (activeTabId: string, tabOrder: string[]) => void
  /** Destroy the queue. */
  dispose: () => void
}

function neighborFirstOrder(activeTabId: string, tabOrder: string[], pendingTabIds: Set<string>): string[] {
  const activeIndex = tabOrder.indexOf(activeTabId)
  if (activeIndex === -1) return [...pendingTabIds]

  const result: string[] = []
  const maxDistance = Math.max(activeIndex, tabOrder.length - 1 - activeIndex)

  for (let d = 1; d <= maxDistance; d++) {
    const leftIdx = activeIndex - d
    const rightIdx = activeIndex + d
    if (leftIdx >= 0 && pendingTabIds.has(tabOrder[leftIdx])) {
      result.push(tabOrder[leftIdx])
    }
    if (rightIdx < tabOrder.length && pendingTabIds.has(tabOrder[rightIdx])) {
      result.push(tabOrder[rightIdx])
    }
  }
  return result
}

export function createHydrationQueue(): HydrationQueue {
  const entries = new Map<string, HydrationEntry>()
  let queue: string[] = []
  let activePane: string | null = null
  let started = false
  let disposed = false

  function advance() {
    if (disposed || activePane) return
    while (queue.length > 0) {
      const nextPaneId = queue.shift()!
      const entry = entries.get(nextPaneId)
      if (entry) {
        activePane = nextPaneId
        entry.trigger()
        return
      }
    }
  }

  return {
    register(entry) {
      if (disposed) return
      entries.set(entry.paneId, entry)
    },

    unregister(paneId) {
      entries.delete(paneId)
      queue = queue.filter((id) => id !== paneId)
      if (activePane === paneId) {
        activePane = null
        advance()
      }
    },

    onActiveTabReady(activeTabId, tabOrder) {
      if (disposed || started) return
      started = true

      const pendingTabIds = new Set<string>()
      for (const entry of entries.values()) {
        pendingTabIds.add(entry.tabId)
      }
      pendingTabIds.delete(activeTabId)

      const orderedTabIds = neighborFirstOrder(activeTabId, tabOrder, pendingTabIds)
      queue = []
      for (const tabId of orderedTabIds) {
        for (const entry of entries.values()) {
          if (entry.tabId === tabId) {
            queue.push(entry.paneId)
          }
        }
      }

      advance()
    },

    onHydrationComplete(paneId) {
      if (disposed) return
      entries.delete(paneId)
      if (activePane === paneId) {
        activePane = null
        advance()
      }
    },

    onActiveTabChanged(activeTabId, tabOrder) {
      if (disposed) return
      const pendingTabIds = new Set<string>()
      for (const paneId of queue) {
        const entry = entries.get(paneId)
        if (entry) pendingTabIds.add(entry.tabId)
      }
      pendingTabIds.delete(activeTabId)

      const orderedTabIds = neighborFirstOrder(activeTabId, tabOrder, pendingTabIds)
      const newQueue: string[] = []
      for (const tabId of orderedTabIds) {
        for (const entry of entries.values()) {
          if (entry.tabId === tabId && queue.includes(entry.paneId)) {
            newQueue.push(entry.paneId)
          }
        }
      }
      queue = newQueue
    },

    dispose() {
      disposed = true
      entries.clear()
      queue = []
      activePane = null
    },
  }
}

let globalQueue: HydrationQueue | null = null

export function getHydrationQueue(): HydrationQueue {
  if (!globalQueue) {
    globalQueue = createHydrationQueue()
  }
  return globalQueue
}

export function resetHydrationQueueForTests(): void {
  globalQueue?.dispose()
  globalQueue = null
}
