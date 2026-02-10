import type { Middleware } from '@reduxjs/toolkit'
import type { TabsState } from './tabsSlice'
import type { PanesState } from './paneTypes'
import type { Tab } from './types'
import { nanoid } from 'nanoid'
import { broadcastPersistedRaw } from './persistBroadcast'
import { PANES_SCHEMA_VERSION } from './persistedState.js'

const STORAGE_KEY = 'freshell.tabs.v1'
const PANES_STORAGE_KEY = 'freshell.panes.v1'
export const PERSIST_DEBOUNCE_MS = 500

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

function stripTabVolatileFields(tab: Tab) {
  return {
    ...tab,
    lastInputAt: undefined,
  }
}

export function resetPersistFlushListenersForTests() {
  flushCallbacks.clear()
}

export function resetPersistedPanesCacheForTests() {
  cachedPersistedPanes = undefined
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

let cachedPersistedPanes: any | null | undefined

export function loadPersistedPanes(): any | null {
  // Memoize: legacy migrations generate nanoid() values, so both callers
  // (panesSlice and terminal-restore) must see the same result.
  if (cachedPersistedPanes !== undefined) return cachedPersistedPanes
  cachedPersistedPanes = loadPersistedPanesUncached()
  return cachedPersistedPanes
}

function loadPersistedPanesUncached(): any | null {
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
      // Already up to date, but ensure paneTitles/paneTitleSetByUser exist
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

    const sanitizedLayouts: Record<string, any> = {}
    for (const [tabId, node] of Object.entries(layouts)) {
      sanitizedLayouts[tabId] = stripEditorContentFromNode(node)
    }

    return {
      layouts: sanitizedLayouts,
      activePane: parsed.activePane || {},
      paneTitles,
      paneTitleSetByUser: parsed.paneTitleSetByUser || {},
      version: PANES_SCHEMA_VERSION,
    }
  } catch {
    return null
  }
}

type PersistState = {
  tabs: TabsState
  panes: PanesState
}

export const persistMiddleware: Middleware<{}, PersistState> = (store) => {
  let tabsDirty = false
  let panesDirty = false
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  const canUseStorage = () => typeof localStorage !== 'undefined'

  const flush = () => {
    flushTimer = null
    if (!canUseStorage()) return
    if (!tabsDirty && !panesDirty) return

    const state = store.getState()

    if (tabsDirty) {
      const tabsPayload = {
        tabs: {
          // Persist only stable tab state. Keep ephemeral UI fields out of storage.
          activeTabId: state.tabs.activeTabId,
          tabs: state.tabs.tabs.map(stripTabVolatileFields),
        },
      }

      try {
        const raw = JSON.stringify(tabsPayload)
        localStorage.setItem(STORAGE_KEY, raw)
        broadcastPersistedRaw(STORAGE_KEY, raw)
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
        const {
          renameRequestTabId: _rrt,
          renameRequestPaneId: _rrp,
          zoomedPane: _zp,
          ...persistablePanes
        } = state.panes
        const panesPayload = {
          ...persistablePanes,
          layouts: sanitizedLayouts,
          version: PANES_SCHEMA_VERSION,
        }
        const panesJson = JSON.stringify(panesPayload)
        localStorage.setItem(PANES_STORAGE_KEY, panesJson)
        broadcastPersistedRaw(PANES_STORAGE_KEY, panesJson)
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

  return (next) => (action) => {
    const result = next(action)

    const a = action as any
    if (a?.meta?.skipPersist) {
      return result
    }

    if (typeof a?.type === 'string') {
      if (a.type.startsWith('tabs/')) {
        tabsDirty = true
        scheduleFlush()
      }
      if (a.type.startsWith('panes/')) {
        panesDirty = true
        scheduleFlush()
      }
    }

    return result
  }
}
