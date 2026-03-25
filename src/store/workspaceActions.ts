import { createAction } from '@reduxjs/toolkit'
import { nanoid } from 'nanoid'
import type {
  BrowserPaneInput,
  EditorPaneInput,
  PaneContentInput,
  PaneNode,
  PanesState,
  TerminalPaneInput,
} from './paneTypes'
import type { TabsState } from './tabsSlice'
import type {
  Tab,
  TerminalStatus,
  TabMode,
  ShellType,
  CodingCliProviderName,
  DefaultNewPane,
} from './types'

export interface WorkspaceTabInput {
  id: string
  title?: string
  titleSetByUser?: boolean
  description?: string
  terminalId?: string
  codingCliSessionId?: string
  codingCliProvider?: CodingCliProviderName
  claudeSessionId?: string
  status?: TerminalStatus
  mode?: TabMode
  shell?: ShellType
  initialCwd?: string
  resumeSessionId?: string
  sessionMetadataByKey?: Tab['sessionMetadataByKey']
  createRequestId?: string
  createdAt?: number
  lastInputAt?: number
}

export interface WorkspaceTabDraft extends Omit<WorkspaceTabInput, 'id'> {
  id?: string
}

export interface CreatePaneBackedTabPayload {
  tab: WorkspaceTabInput
  content: PaneContentInput
  paneId?: string
}

export interface RestorePaneBackedTabPayload {
  tab: WorkspaceTabInput
  layout: PaneNode
  paneTitles: Record<string, string>
}

export interface HydrateWorkspaceSnapshotPayload {
  tabs: TabsState
  panes: PanesState
}

export const createPaneBackedTab = createAction<CreatePaneBackedTabPayload>(
  'workspace/createPaneBackedTab',
)

export const restorePaneBackedTab = createAction<RestorePaneBackedTabPayload>(
  'workspace/restorePaneBackedTab',
)

export const hydrateWorkspaceSnapshot = createAction<HydrateWorkspaceSnapshotPayload>(
  'workspace/hydrateWorkspaceSnapshot',
)

function ensureWorkspaceTabId(tab: WorkspaceTabDraft): WorkspaceTabInput {
  return {
    ...tab,
    id: tab.id || nanoid(),
  }
}

export function buildDefaultNewTabContent(
  defaultNewPane: DefaultNewPane | undefined,
  defaultCwd?: string,
): PaneContentInput {
  if (defaultNewPane === 'browser') {
    return { kind: 'browser', url: '', devToolsOpen: false }
  }
  if (defaultNewPane === 'editor') {
    return {
      kind: 'editor',
      filePath: null,
      language: null,
      readOnly: false,
      content: '',
      viewMode: 'source',
    }
  }
  if (defaultNewPane === 'shell') {
    return {
      kind: 'terminal',
      mode: 'shell',
      shell: 'system',
      ...(defaultCwd ? { initialCwd: defaultCwd } : {}),
    }
  }
  return { kind: 'picker' }
}

function buildTerminalPaneContent(
  tab: WorkspaceTabDraft,
  overrides: Partial<TerminalPaneInput> = {},
): TerminalPaneInput {
  return {
    kind: 'terminal',
    mode: overrides.mode ?? tab.mode ?? 'shell',
    shell: overrides.shell ?? tab.shell ?? 'system',
    terminalId: overrides.terminalId ?? tab.terminalId,
    resumeSessionId: overrides.resumeSessionId ?? tab.resumeSessionId,
    initialCwd: overrides.initialCwd ?? tab.initialCwd,
    status: overrides.status ?? tab.status,
    createRequestId: overrides.createRequestId ?? tab.createRequestId,
    sessionRef: overrides.sessionRef,
  }
}

export function createDefaultPaneBackedTab(tab: WorkspaceTabDraft = {}) {
  return (
    dispatch: (action: ReturnType<typeof createPaneBackedTab>) => unknown,
    getState: () => {
      settings?: {
        settings?: {
          defaultCwd?: string
          panes?: {
            defaultNewPane?: DefaultNewPane
          }
        }
      }
    },
  ) => {
    const settings = getState().settings?.settings
    const content = buildDefaultNewTabContent(
      settings?.panes?.defaultNewPane,
      settings?.defaultCwd,
    )
    const nextTab = ensureWorkspaceTabId({
      mode: 'shell',
      shell: 'system',
      ...tab,
      ...(content.kind === 'terminal' && tab.initialCwd === undefined && settings?.defaultCwd
        ? { initialCwd: settings.defaultCwd }
        : {}),
    })

    return dispatch(
      createPaneBackedTab({
        tab: nextTab,
        content,
      }),
    )
  }
}

export function createTerminalPaneBackedTab(input: {
  tab: WorkspaceTabDraft
  paneId?: string
  content?: Partial<TerminalPaneInput>
}) {
  const tab = ensureWorkspaceTabId(input.tab)
  return createPaneBackedTab({
    tab,
    paneId: input.paneId,
    content: buildTerminalPaneContent(tab, input.content),
  })
}

export function createBrowserPaneBackedTab(input: {
  tab: WorkspaceTabDraft
  paneId?: string
  content?: Partial<BrowserPaneInput>
}) {
  const tab = ensureWorkspaceTabId(input.tab)
  return createPaneBackedTab({
    tab,
    paneId: input.paneId,
    content: {
      kind: 'browser',
      url: input.content?.url ?? '',
      devToolsOpen: input.content?.devToolsOpen ?? false,
      browserInstanceId: input.content?.browserInstanceId,
    },
  })
}

export function createEditorPaneBackedTab(input: {
  tab: WorkspaceTabDraft
  paneId?: string
  content?: Partial<EditorPaneInput>
}) {
  const tab = ensureWorkspaceTabId(input.tab)
  return createPaneBackedTab({
    tab,
    paneId: input.paneId,
    content: {
      kind: 'editor',
      filePath: input.content?.filePath ?? null,
      language: input.content?.language ?? null,
      readOnly: input.content?.readOnly ?? false,
      content: input.content?.content ?? '',
      viewMode: input.content?.viewMode ?? 'source',
    },
  })
}
