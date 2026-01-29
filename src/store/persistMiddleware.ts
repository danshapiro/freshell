import type { Middleware } from '@reduxjs/toolkit'
import type { RootState } from './store'
import { nanoid } from 'nanoid'

const STORAGE_KEY = 'freshell.tabs.v1'
const PANES_STORAGE_KEY = 'freshell.panes.v1'

// Current panes schema version
const PANES_SCHEMA_VERSION = 2

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
      // Already up to date
      return parsed
    }

    // Run migrations
    const migratedLayouts: Record<string, any> = {}
    for (const [tabId, node] of Object.entries(parsed.layouts || {})) {
      migratedLayouts[tabId] = migrateNode(node)
    }

    return {
      ...parsed,
      layouts: migratedLayouts,
      version: PANES_SCHEMA_VERSION,
    }
  } catch {
    return null
  }
}

export const persistMiddleware: Middleware<{}, RootState> = (store) => (next) => (action) => {
  const result = next(action)
  const state = store.getState()

  // Persist tabs slice
  const tabsPayload = {
    tabs: state.tabs,
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tabsPayload))
  } catch {
    // ignore quota
  }

  // Persist panes slice with version
  try {
    const panesPayload = {
      ...state.panes,
      version: PANES_SCHEMA_VERSION,
    }
    const panesJson = JSON.stringify(panesPayload)
    localStorage.setItem(PANES_STORAGE_KEY, panesJson)
    // Debug: log when we persist a split pane
    if (panesJson.includes('"type":"split"')) {
      console.log('[Panes Persist] Saved split pane to localStorage')
      console.log('[Panes Persist] Layout keys being saved:', Object.keys(state.panes.layouts))
    }
  } catch (err) {
    console.error('[Panes Persist] Failed to save to localStorage:', err)
  }

  return result
}
