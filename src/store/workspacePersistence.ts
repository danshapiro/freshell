import { nanoid } from 'nanoid'
import { createLogger } from '@/lib/client-logger'
import { validateWorkspaceSnapshot } from '@/lib/tab-layout-integrity'
import {
  PANES_SCHEMA_VERSION,
  parsePersistedPanesPayload,
  parsePersistedTabsPayload,
  parsePersistedTabsRaw,
} from './persistedState'
import { PANES_STORAGE_KEY, TABS_STORAGE_KEY, WORKSPACE_STORAGE_KEY } from './storage-keys'
import type { PaneNode, PanesState } from './paneTypes'
import type { TabsState } from './tabsSlice'
import type { Tab } from './types'
import { isWellFormedPaneTree } from './paneTreeValidation'
import { migratePersistedPaneContent } from './persisted-pane-migration'

export { WORKSPACE_STORAGE_KEY } from './storage-keys'

const log = createLogger('WorkspacePersistence')

export const WORKSPACE_SCHEMA_VERSION = 1

type PersistedWorkspaceTab = {
  [key: string]: unknown
  id: string
  title: string
}

type PersistedWorkspaceTabs = {
  tabs: PersistedWorkspaceTab[]
  activeTabId: string | null
}

type PersistedWorkspacePanes = {
  layouts: Record<string, unknown>
  activePane: Record<string, string>
  paneTitles: Record<string, Record<string, string>>
  paneTitleSetByUser: Record<string, Record<string, boolean>>
}

export type PersistedWorkspaceSnapshot = {
  version: number
  tabs: PersistedWorkspaceTabs
  panes: PersistedWorkspacePanes
}

export type LoadedWorkspaceSnapshot = PersistedWorkspaceSnapshot & {
  source: 'workspace' | 'legacy-split'
  validation: ReturnType<typeof validateWorkspaceSnapshot>
}

type SerializeWorkspaceSnapshotResult =
  | {
    ok: true
    snapshot: PersistedWorkspaceSnapshot
    validation: { ok: true }
    workspaceRaw: string
    tabsRaw: string
    panesRaw: string
  }
  | {
    ok: false
    missingLayoutTabIds: string[]
  }

let cachedLoadedWorkspaceSnapshot: LoadedWorkspaceSnapshot | null | undefined
let cachedPersistedPanesView: (PersistedWorkspacePanes & { version: number }) | null | undefined

function createEmptyTabsState(): PersistedWorkspaceTabs {
  return {
    tabs: [],
    activeTabId: null,
  }
}

function createEmptyPanesState(): PersistedWorkspacePanes {
  return {
    layouts: {},
    activePane: {},
    paneTitles: {},
    paneTitleSetByUser: {},
  }
}

function stripTabVolatileFields(tab: Tab) {
  return {
    ...tab,
    lastInputAt: undefined,
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

function stripEditorContentFromNode(node: PaneNode): PaneNode
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

function parseLegacyPanesRaw(raw: string): PersistedWorkspacePanes | null {
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const currentVersion = parsed?.version || 1
  if (currentVersion > PANES_SCHEMA_VERSION) return null

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
    return {
      layouts: sanitizedLayouts,
      activePane: Object.fromEntries(
        Object.entries(parsed.activePane || {}).filter(([tabId]) => !droppedTabIds.has(tabId)),
      ) as Record<string, string>,
      paneTitles: Object.fromEntries(
        Object.entries(parsed.paneTitles || {}).filter(([tabId]) => !droppedTabIds.has(tabId)),
      ) as Record<string, Record<string, string>>,
      paneTitleSetByUser: Object.fromEntries(
        Object.entries(parsed.paneTitleSetByUser || {}).filter(([tabId]) => !droppedTabIds.has(tabId)),
      ) as Record<string, Record<string, boolean>>,
    }
  }

  let layouts = parsed.layouts || {}
  let paneTitles = parsed.paneTitles || {}

  if (currentVersion < 2) {
    const migratedLayouts: Record<string, any> = {}
    for (const [tabId, node] of Object.entries(layouts)) {
      migratedLayouts[tabId] = migrateNode(node)
    }
    layouts = migratedLayouts
  }

  if (currentVersion < 5) {
    const droppedLayouts: Record<string, any> = {}
    for (const [tabId, node] of Object.entries(layouts)) {
      droppedLayouts[tabId] = dropClaudeChatNodes(node)
    }
    layouts = droppedLayouts
  }

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
    const sanitizedNode = stripEditorContentFromNode(node as PaneNode)
    if (isWellFormedPaneTree(sanitizedNode)) {
      sanitizedLayouts[tabId] = sanitizedNode
    } else {
      droppedTabIds.add(tabId)
    }
  }

  return {
    layouts: sanitizedLayouts,
    activePane: Object.fromEntries(
      Object.entries(parsed.activePane || {}).filter(([tabId]) => !droppedTabIds.has(tabId)),
    ) as Record<string, string>,
    paneTitles: Object.fromEntries(
      Object.entries(paneTitles).filter(([tabId]) => !droppedTabIds.has(tabId)),
    ) as Record<string, Record<string, string>>,
    paneTitleSetByUser: Object.fromEntries(
      Object.entries(parsed.paneTitleSetByUser || {}).filter(([tabId]) => !droppedTabIds.has(tabId)),
    ) as Record<string, Record<string, boolean>>,
  }
}

function buildLoadedWorkspaceSnapshot(
  source: LoadedWorkspaceSnapshot['source'],
  snapshot: PersistedWorkspaceSnapshot,
): LoadedWorkspaceSnapshot {
  const tabsState = {
    ...(snapshot.tabs as unknown as TabsState),
    renameRequestTabId: null,
  } as TabsState
  return {
    ...snapshot,
    source,
    validation: validateWorkspaceSnapshot({
      tabs: tabsState,
      panes: snapshot.panes as Pick<PanesState, 'layouts'>,
    }),
  }
}

export function parsePersistedWorkspaceRaw(raw: string): PersistedWorkspaceSnapshot | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') return null

  const candidate = parsed as {
    version?: unknown
    tabs?: unknown
    panes?: unknown
  }

  const version = typeof candidate.version === 'number' ? candidate.version : 0
  if (version > WORKSPACE_SCHEMA_VERSION) return null

  const tabs = parsePersistedTabsPayload({
    tabs: candidate.tabs,
  })
  const panes = parsePersistedPanesPayload(candidate.panes, {
    requireWellFormedLayouts: true,
  })
  if (!tabs || !panes) return null

  return {
    version,
    tabs: {
      ...tabs.tabs,
      activeTabId: tabs.tabs.activeTabId ?? null,
    },
    panes,
  }
}

function loadPersistedWorkspaceSnapshotUncached(): LoadedWorkspaceSnapshot | null {
  try {
    const rawWorkspace = localStorage.getItem(WORKSPACE_STORAGE_KEY)
    if (typeof rawWorkspace === 'string') {
      const parsedWorkspace = parsePersistedWorkspaceRaw(rawWorkspace)
      if (!parsedWorkspace) {
        log.error('Failed to parse authoritative workspace snapshot')
        return null
      }
      return buildLoadedWorkspaceSnapshot('workspace', parsedWorkspace)
    }

    const rawTabs = localStorage.getItem(TABS_STORAGE_KEY)
    const rawPanes = localStorage.getItem(PANES_STORAGE_KEY)
    const parsedTabs = typeof rawTabs === 'string' ? parsePersistedTabsRaw(rawTabs) : null
    const parsedPanes = typeof rawPanes === 'string' ? parseLegacyPanesRaw(rawPanes) : null
    if (!parsedTabs && !parsedPanes) return null

    return buildLoadedWorkspaceSnapshot('legacy-split', {
      version: WORKSPACE_SCHEMA_VERSION,
      tabs: parsedTabs
        ? {
          ...parsedTabs.tabs,
          activeTabId: parsedTabs.tabs.activeTabId ?? null,
        }
        : createEmptyTabsState(),
      panes: parsedPanes ?? createEmptyPanesState(),
    })
  } catch (err) {
    log.error('Failed to load persisted workspace snapshot', err)
    return null
  }
}

export function loadPersistedWorkspaceSnapshot(): LoadedWorkspaceSnapshot | null {
  if (cachedLoadedWorkspaceSnapshot !== undefined) {
    return cachedLoadedWorkspaceSnapshot
  }
  cachedLoadedWorkspaceSnapshot = loadPersistedWorkspaceSnapshotUncached()
  return cachedLoadedWorkspaceSnapshot
}

export function primeLoadedWorkspaceSnapshotCache(snapshot: LoadedWorkspaceSnapshot | null): void {
  cachedLoadedWorkspaceSnapshot = snapshot
  cachedPersistedPanesView = snapshot
    ? {
      ...snapshot.panes,
      version: PANES_SCHEMA_VERSION,
    }
    : null
}

export function resetLoadedWorkspaceSnapshotCacheForTests(): void {
  cachedLoadedWorkspaceSnapshot = undefined
  cachedPersistedPanesView = undefined
}

export function loadPersistedTabs(): { tabs: PersistedWorkspaceTabs } | null {
  const snapshot = loadPersistedWorkspaceSnapshot()
  return snapshot ? { tabs: snapshot.tabs } : null
}

export function loadPersistedPanes(): (PersistedWorkspacePanes & { version: number }) | null {
  if (cachedPersistedPanesView !== undefined) {
    return cachedPersistedPanesView
  }
  const panes = loadPersistedWorkspaceSnapshot()?.panes
  cachedPersistedPanesView = panes
    ? {
      ...panes,
      version: PANES_SCHEMA_VERSION,
    }
    : null
  return cachedPersistedPanesView
}

export function serializeWorkspaceSnapshot(input: {
  tabs: TabsState
  panes: PanesState
}): SerializeWorkspaceSnapshotResult {
  const tabs: PersistedWorkspaceTabs = {
    activeTabId: input.tabs.activeTabId,
    tabs: input.tabs.tabs.map(stripTabVolatileFields),
  }

  const panes: PersistedWorkspacePanes = {
    layouts: Object.fromEntries(
      Object.entries(input.panes.layouts).map(([tabId, node]) => [
        tabId,
        stripEditorContentFromNode(node),
      ]),
    ),
    activePane: input.panes.activePane,
    paneTitles: input.panes.paneTitles,
    paneTitleSetByUser: input.panes.paneTitleSetByUser,
  }

  const validation = validateWorkspaceSnapshot({
    tabs: {
      ...tabs,
      renameRequestTabId: null,
    } as unknown as TabsState,
    panes: panes as Pick<PanesState, 'layouts'>,
  })
  if (!validation.ok) {
    return validation
  }

  const snapshot: PersistedWorkspaceSnapshot = {
    version: WORKSPACE_SCHEMA_VERSION,
    tabs,
    panes,
  }

  return {
    ok: true,
    snapshot,
    validation,
    workspaceRaw: JSON.stringify(snapshot),
    tabsRaw: JSON.stringify({
      tabs,
    }),
    panesRaw: JSON.stringify({
      ...panes,
      version: PANES_SCHEMA_VERSION,
    }),
  }
}
