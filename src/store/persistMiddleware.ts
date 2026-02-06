import type { Middleware } from '@reduxjs/toolkit'
import { nanoid } from 'nanoid'

const STORAGE_KEY = 'freshell.tabs.v1'
const PANES_STORAGE_KEY = 'freshell.panes.v1'
export const PERSIST_DEBOUNCE_MS = 500

// Current panes schema version
const PANES_SCHEMA_VERSION = 4

const flushCallbacks = new Set<() => void>()
let flushListenersAttached = false

function notifyFlushCallbacks() {
  for (const cb of flushCallbacks) {
    try {
      cb()
    } catch {
      // ignore
    }
  }
}

function attachFlushListeners() {
  if (flushListenersAttached) return
  if (typeof document === 'undefined' || typeof window === 'undefined') return

  const handleVisibility = () => {
    if (document.visibilityState === 'hidden') {
      notifyFlushCallbacks()
    }
  }
  const handlePageHide = () => {
    notifyFlushCallbacks()
  }

  document.addEventListener('visibilitychange', handleVisibility)
  window.addEventListener('pagehide', handlePageHide)
  window.addEventListener('beforeunload', handlePageHide)

  flushListenersAttached = true
}

function registerFlushCallback(cb: () => void) {
  flushCallbacks.add(cb)
  attachFlushListeners()
}

function stripTabVolatileFields(tab: unknown) {
  if (!tab || typeof tab !== 'object') return tab
  // Strip any runtime-added volatile fields that shouldn't be persisted.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { lastInputAt, ...rest } = tab as Record<string, unknown> & { lastInputAt?: number }
  return rest
}

export function resetPersistFlushListenersForTests() {
  flushCallbacks.clear()
}

export function loadPersistedTabs(): any | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed
  } catch {
    return null
  }
}

/**
 * Migrate terminal pane content to include lifecycle fields.
 * Only runs if content is missing required fields.
 */
function migratePaneContent(content: any): any {
  if (!content || typeof content !== 'object') {
    return content
  }
  if (content.kind !== 'terminal') {
    return content
  }

  // Already has lifecycle fields - no migration needed
  if (content.createRequestId && content.status) {
    return content
  }

  return {
    ...content,
    createRequestId: content.createRequestId || nanoid(),
    status: content.status || 'creating',
    mode: content.mode || 'shell',
    shell: content.shell || 'system',
  }
}

function stripEditorContent(content: any): any {
  if (content?.kind !== 'editor') return content
  if (content.content === '') return content
  return {
    ...content,
    content: '',
  }
}

function stripEditorContentFromNode(node: any): any {
  if (!node) return node

  if (node.type === 'leaf') {
    const nextContent = stripEditorContent(node.content)
    if (nextContent === node.content) return node
    return {
      ...node,
      content: nextContent,
    }
  }

  if (node.type === 'split') {
    if (!Array.isArray(node.children) || node.children.length < 2) {
      return node
    }
    const left = stripEditorContentFromNode(node.children[0])
    const right = stripEditorContentFromNode(node.children[1])
    if (left === node.children[0] && right === node.children[1]) return node
    return {
      ...node,
      children: [left, right],
    }
  }

  return node
}

/**
 * Recursively migrate all pane nodes in a tree.
 */
function migrateNode(node: any): any {
  if (!node) return node

  if (node.type === 'leaf') {
    return {
      ...node,
      content: migratePaneContent(node.content),
    }
  }

  if (node.type === 'split') {
    if (!Array.isArray(node.children) || node.children.length < 2) {
      return node
    }
    return {
      ...node,
      children: [
        migrateNode(node.children[0]),
        migrateNode(node.children[1]),
      ],
    }
  }

  return node
}

export function loadPersistedPanes(): any | null {
  try {
    const raw = localStorage.getItem(PANES_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)

    // Check if migration needed
    const currentVersion = parsed.version || 1
    if (currentVersion >= PANES_SCHEMA_VERSION) {
      const sanitizedLayouts: Record<string, any> = {}
      for (const [tabId, node] of Object.entries(parsed.layouts || {})) {
        sanitizedLayouts[tabId] = stripEditorContentFromNode(node)
      }
      // Already up to date, but ensure paneTitles exists
      return {
        ...parsed,
        layouts: sanitizedLayouts,
        paneTitles: parsed.paneTitles || {},
        paneTitleSetByUser: parsed.paneTitleSetByUser || {},
      }
    }

    // Run migrations
    let layouts = parsed.layouts || {}
    let paneTitles = parsed.paneTitles || {}
    let paneTitleSetByUser = parsed.paneTitleSetByUser || {}

    // Version 1 -> 2: migrate pane content to include lifecycle fields
    if (currentVersion < 2) {
      const migratedLayouts: Record<string, any> = {}
      for (const [tabId, node] of Object.entries(layouts)) {
        migratedLayouts[tabId] = migrateNode(node)
      }
      layouts = migratedLayouts
    }

    // Version 2 -> 3: add paneTitles (already defaulted to {} above)
    // No additional migration needed, just ensure the field exists
    // Version 3 -> 4: paneTitles semantics changed; reset overrides
    if (currentVersion < 4) {
      paneTitles = {}
      paneTitleSetByUser = {}
    }

    const sanitizedLayouts: Record<string, any> = {}
    for (const [tabId, node] of Object.entries(layouts)) {
      sanitizedLayouts[tabId] = stripEditorContentFromNode(node)
    }

    return {
      layouts: sanitizedLayouts,
      activePane: parsed.activePane || {},
      paneTitles,
      paneTitleSetByUser,
      version: PANES_SCHEMA_VERSION,
    }
  } catch {
    return null
  }
}

export const persistMiddleware: Middleware = (store) => {
  let tabsDirty = false
  let panesDirty = false
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  const canUseStorage = () => typeof localStorage !== 'undefined'

  const flush = () => {
    flushTimer = null
    if (!canUseStorage()) return
    if (!tabsDirty && !panesDirty) return

    const state = store.getState() as any

    if (tabsDirty) {
      const tabsPayload = {
        tabs: {
          // Persist only stable tab state. Keep ephemeral UI fields out of storage.
          activeTabId: state.tabs.activeTabId,
          tabs: state.tabs.tabs.map(stripTabVolatileFields),
        },
      }

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(tabsPayload))
      } catch {
        // ignore quota
      }
    }

    if (panesDirty) {
      try {
        const sanitizedLayouts: Record<string, any> = {}
        for (const [tabId, node] of Object.entries(state.panes.layouts)) {
          sanitizedLayouts[tabId] = stripEditorContentFromNode(node)
        }
        const panesPayload = {
          ...state.panes,
          layouts: sanitizedLayouts,
          version: PANES_SCHEMA_VERSION,
        }
        const panesJson = JSON.stringify(panesPayload)
        localStorage.setItem(PANES_STORAGE_KEY, panesJson)
      } catch (err) {
        console.error('[Panes Persist] Failed to save to localStorage:', err)
      }
    }

    tabsDirty = false
    panesDirty = false
  }

  const scheduleFlush = () => {
    if (flushTimer) return
    flushTimer = setTimeout(flush, PERSIST_DEBOUNCE_MS)
  }

  const flushNow = () => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    flush()
  }

  registerFlushCallback(flushNow)

  return (next) => (action: unknown) => {
    const result = next(action as any)

    const meta = (action as any)?.meta
    if (meta?.skipPersist) {
      return result
    }

    const actionType = (action as any)?.type
    if (typeof actionType === 'string') {
      if (actionType.startsWith('tabs/')) {
        tabsDirty = true
        scheduleFlush()
      }
      if (actionType.startsWith('panes/')) {
        panesDirty = true
        scheduleFlush()
      }
    }

    return result
  }
}
