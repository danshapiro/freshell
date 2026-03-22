import type { Middleware } from '@reduxjs/toolkit'
import type { TabsState } from './tabsSlice'
import type { PanesState } from './paneTypes'
import type { Tab } from './types'
import { nanoid } from 'nanoid'
import { broadcastPersistedRaw } from './persistBroadcast'
import { isWellFormedPaneTree } from './paneTreeValidation.js'
import { PANES_SCHEMA_VERSION } from './persistedState.js'
import { PANES_STORAGE_KEY, TABS_STORAGE_KEY } from './storage-keys'
import { createLogger } from '@/lib/client-logger'
import { migratePersistedPaneContent } from './persisted-pane-migration'
import { derivePaneTitle } from '@/lib/derivePaneTitle'
import {
  bootstrapLegacyTabTitleSource,
  inferLegacyPaneTitleSource,
  resolveEffectiveLegacyTabTitleSource,
} from '@/lib/title-source'


const log = createLogger('PanesPersist')

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

function canonicalizeTabForPersistence(tab: Tab, panes: PanesState | undefined): Tab {
  const layout = panes?.layouts?.[tab.id]
  const paneTitle = layout?.type === 'leaf' ? panes?.paneTitles?.[tab.id]?.[layout.id] : undefined
  const paneTitleSource = layout?.type === 'leaf'
    ? panes?.paneTitleSources?.[tab.id]?.[layout.id]
      ?? inferLegacyPaneTitleSource({
        storedTitle: paneTitle,
        derivedTitle: derivePaneTitle(layout.content),
        titleSetByUser: panes?.paneTitleSetByUser?.[tab.id]?.[layout.id],
      })
    : undefined

  const titleSource = tab.titleSource
    ?? bootstrapLegacyTabTitleSource({
      title: tab.title,
      titleSetByUser: tab.titleSetByUser,
      mode: tab.mode,
      shell: tab.shell,
    })
    ?? resolveEffectiveLegacyTabTitleSource({
      storedTitle: tab.title,
      titleSetByUser: tab.titleSetByUser,
      layout,
      paneTitle,
      paneTitleSource,
    })

  return {
    ...tab,
    titleSource,
    titleSetByUser: titleSource === 'user',
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
    const raw = localStorage.getItem(TABS_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed
  } catch {
    return null
  }
}

/**
 * Migrate pane content to include required lifecycle/identity fields.
 */
function migratePaneContent(content: any): any {
  if (!content || typeof content !== 'object') {
    return content
  }
  if (content.kind === 'browser') {
    return {
      ...content,
      browserInstanceId:
        typeof content.browserInstanceId === 'string' && content.browserInstanceId
          ? content.browserInstanceId
          : nanoid(),
      url: typeof content.url === 'string' ? content.url : '',
      devToolsOpen: typeof content.devToolsOpen === 'boolean' ? content.devToolsOpen : false,
    }
  }
  if (content.kind === 'terminal') {
    const migrated = migratePersistedPaneContent(content) as Record<string, unknown>
    return {
      ...migrated,
      createRequestId: migrated.createRequestId || nanoid(),
      status: migrated.status || 'creating',
      mode: migrated.mode || 'shell',
      shell: migrated.shell || 'system',
    }
  }
  if (content.kind === 'agent-chat') {
    const migrated = migratePersistedPaneContent(content) as Record<string, unknown>
    return {
      ...migrated,
      createRequestId: migrated.createRequestId || nanoid(),
      status: migrated.status || 'creating',
    }
  }
  return content
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

function dropClaudeChatNodes(node: any): any {
  if (!node) return node
  if (node.type === 'leaf') {
    if (node.content?.kind === 'claude-chat') {
      return { ...node, content: { kind: 'picker' } }
    }
    return node
  }
  if (node.type === 'split' && Array.isArray(node.children) && node.children.length >= 2) {
    return {
      ...node,
      children: [
        dropClaudeChatNodes(node.children[0]),
        dropClaudeChatNodes(node.children[1]),
      ],
    }
  }
  return node
}

function collectLeafNodes(node: any): Array<{ id: string; content: any }> {
  if (!node || typeof node !== 'object') return []
  if (node.type === 'leaf' && typeof node.id === 'string') {
    return [{ id: node.id, content: node.content }]
  }
  if (node.type === 'split' && Array.isArray(node.children) && node.children.length >= 2) {
    return [
      ...collectLeafNodes(node.children[0]),
      ...collectLeafNodes(node.children[1]),
    ]
  }
  return []
}

function inferPaneTitleSourcesByTab(
  layouts: Record<string, any>,
  paneTitles: Record<string, Record<string, string>>,
  paneTitleSetByUser: Record<string, Record<string, boolean>>,
  existingPaneTitleSources?: Record<string, Record<string, 'derived' | 'stable' | 'user'>>,
): Record<string, Record<string, 'derived' | 'stable' | 'user'>> {
  const nextSources: Record<string, Record<string, 'derived' | 'stable' | 'user'>> = {}

  for (const [tabId, layout] of Object.entries(layouts || {})) {
    const tabSources: Record<string, 'derived' | 'stable' | 'user'> = {}
    for (const leaf of collectLeafNodes(layout)) {
      const existingSource = existingPaneTitleSources?.[tabId]?.[leaf.id]
      if (existingSource) {
        tabSources[leaf.id] = existingSource
        continue
      }

      tabSources[leaf.id] = inferLegacyPaneTitleSource({
        storedTitle: paneTitles?.[tabId]?.[leaf.id],
        derivedTitle: derivePaneTitle(leaf.content),
        titleSetByUser: paneTitleSetByUser?.[tabId]?.[leaf.id],
      })
    }

    if (Object.keys(tabSources).length > 0) {
      nextSources[tabId] = tabSources
    }
  }

  return nextSources
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
      const droppedTabIds = new Set<string>()
      for (const [tabId, node] of Object.entries(parsed.layouts || {})) {
        const sanitizedNode = stripEditorContentFromNode(migrateNode(node))
        if (isWellFormedPaneTree(sanitizedNode)) {
          sanitizedLayouts[tabId] = sanitizedNode
        } else {
          droppedTabIds.add(tabId)
        }
      }
      // Already up to date, but ensure paneTitles/paneTitleSetByUser exist
      return {
        ...parsed,
        layouts: sanitizedLayouts,
        activePane: Object.fromEntries(
          Object.entries(parsed.activePane || {}).filter(([tabId]) => !droppedTabIds.has(tabId)),
        ),
        paneTitles: Object.fromEntries(
          Object.entries(parsed.paneTitles || {}).filter(([tabId]) => !droppedTabIds.has(tabId)),
        ),
        paneTitleSources: inferPaneTitleSourcesByTab(
          sanitizedLayouts,
          Object.fromEntries(
            Object.entries(parsed.paneTitles || {}).filter(([tabId]) => !droppedTabIds.has(tabId)),
          ),
          Object.fromEntries(
            Object.entries(parsed.paneTitleSetByUser || {}).filter(([tabId]) => !droppedTabIds.has(tabId)),
          ),
          Object.fromEntries(
            Object.entries(parsed.paneTitleSources || {}).filter(([tabId]) => !droppedTabIds.has(tabId)),
          ),
        ),
        paneTitleSetByUser: Object.fromEntries(
          Object.entries(parsed.paneTitleSetByUser || {}).filter(([tabId]) => !droppedTabIds.has(tabId)),
        ),
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

    // Version 4 -> 5: drop claude-chat panes (renamed to agent-chat; no data migration)
    if (currentVersion < 5) {
      const droppedLayouts: Record<string, any> = {}
      for (const [tabId, node] of Object.entries(layouts)) {
        droppedLayouts[tabId] = dropClaudeChatNodes(node)
      }
      layouts = droppedLayouts
    }

    // Version 5 -> 6: assign stable browser instance ids.
    if (currentVersion < 6) {
      const migratedLayouts: Record<string, any> = {}
      for (const [tabId, node] of Object.entries(layouts)) {
        migratedLayouts[tabId] = migrateNode(node)
      }
      layouts = migratedLayouts
    }

    const sanitizedLayouts: Record<string, any> = {}
    const droppedTabIds = new Set<string>()
    for (const [tabId, node] of Object.entries(layouts)) {
      const sanitizedNode = stripEditorContentFromNode(node)
      if (isWellFormedPaneTree(sanitizedNode)) {
        sanitizedLayouts[tabId] = sanitizedNode
      } else {
        droppedTabIds.add(tabId)
      }
    }

    const filteredPaneTitles = Object.fromEntries(
      Object.entries(paneTitles).filter(([tabId]) => !droppedTabIds.has(tabId)),
    ) as Record<string, Record<string, string>>
    const filteredPaneTitleSetByUser = Object.fromEntries(
      Object.entries(parsed.paneTitleSetByUser || {}).filter(([tabId]) => !droppedTabIds.has(tabId)),
    ) as Record<string, Record<string, boolean>>

    return {
      layouts: sanitizedLayouts,
      activePane: Object.fromEntries(
        Object.entries(parsed.activePane || {}).filter(([tabId]) => !droppedTabIds.has(tabId)),
      ),
      paneTitles: filteredPaneTitles,
      paneTitleSources: inferPaneTitleSourcesByTab(
        sanitizedLayouts,
        filteredPaneTitles,
        filteredPaneTitleSetByUser,
      ),
      paneTitleSetByUser: filteredPaneTitleSetByUser,
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
          tabs: state.tabs.tabs
            .map((tab) => canonicalizeTabForPersistence(tab, state.panes))
            .map(stripTabVolatileFields),
        },
      }

      try {
        const raw = JSON.stringify(tabsPayload)
        localStorage.setItem(TABS_STORAGE_KEY, raw)
        broadcastPersistedRaw(TABS_STORAGE_KEY, raw)
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
          refreshRequestsByPane: _rrbp,
          ...persistablePanes
        } = state.panes
        const panesPayload = {
          ...persistablePanes,
          paneTitleSources: state.panes.paneTitleSources
            || inferPaneTitleSourcesByTab(
              sanitizedLayouts,
              state.panes.paneTitles || {},
              state.panes.paneTitleSetByUser || {},
            ),
          layouts: sanitizedLayouts,
          version: PANES_SCHEMA_VERSION,
        }
        const panesJson = JSON.stringify(panesPayload)
        localStorage.setItem(PANES_STORAGE_KEY, panesJson)
        broadcastPersistedRaw(PANES_STORAGE_KEY, panesJson)
      } catch (err) {
        log.error('Failed to save to localStorage:', err)
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
