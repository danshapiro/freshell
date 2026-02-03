import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { addTab, closeTab, reorderTabs, updateTab, setActiveTab } from '@/store/tabsSlice'
import { addPane, closePane, initLayout, resetLayout, resetSplit, swapSplit, updatePaneTitle } from '@/store/panesSlice'
import { setProjects, setProjectExpanded } from '@/store/sessionsSlice'
import { getWsClient } from '@/lib/ws-client'
import { api } from '@/lib/api'
import { buildShareUrl } from '@/lib/utils'
import { copyText } from '@/lib/clipboard'
import { collectTerminalIds, findPaneContent } from '@/lib/pane-utils'
import { getTabDisplayTitle } from '@/lib/tab-title'
import { getBrowserActions, getEditorActions, getTerminalActions } from '@/lib/pane-action-registry'
import { ConfirmModal } from '@/components/ui/confirm-modal'
import type { AppView } from '@/components/Sidebar'
import type { CodingCliProviderName } from '@/store/types'
import type { ContextTarget } from './context-menu-types'
import { ContextMenu } from './ContextMenu'
import { ContextIds } from './context-menu-constants'
import { buildMenuItems } from './menu-defs'
import { copyDataset, isTextInputLike, parseContextTarget } from './context-menu-utils'
import { nanoid } from 'nanoid'

const CONTEXT_MENU_KEYS = ['ContextMenu']


type MenuState = {
  position: { x: number; y: number }
  target: ContextTarget
  contextElement: HTMLElement | null
  dataset: Record<string, string | undefined>
}

type ConfirmState = {
  title: string
  body: React.ReactNode
  confirmLabel: string
  onConfirm: () => void
}

type ContextMenuProviderProps = {
  view: AppView
  onViewChange: (view: AppView) => void
  onToggleSidebar: () => void
  sidebarCollapsed: boolean
  children: React.ReactNode
}

function findContextElement(start: HTMLElement | null): HTMLElement | null {
  let node: HTMLElement | null = start
  while (node) {
    if (node.dataset?.context) return node
    node = node.parentElement
  }
  return null
}

function resolveContextId(value: string | undefined): string {
  if (!value) return ContextIds.Global
  const allowed = new Set(Object.values(ContextIds))
  return allowed.has(value) ? value : ContextIds.Global
}

export function ContextMenuProvider({
  view,
  onViewChange,
  onToggleSidebar,
  sidebarCollapsed,
  children,
}: ContextMenuProviderProps) {
  const dispatch = useAppDispatch()
  const tabsState = useAppSelector((s) => s.tabs)
  const panes = useAppSelector((s) => s.panes.layouts)
  const sessions = useAppSelector((s) => s.sessions.projects)
  const expandedProjects = useAppSelector((s) => s.sessions.expandedProjects)
  const platform = useAppSelector((s) => s.connection?.platform ?? null)

  const [menuState, setMenuState] = useState<MenuState | null>(null)
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  const ws = useMemo(() => getWsClient(), [])

  const closeMenu = useCallback(() => {
    setMenuState(null)
    if (previousFocusRef.current) {
      const el = previousFocusRef.current
      previousFocusRef.current = null
      window.setTimeout(() => el.focus(), 0)
    }
  }, [])

  const openMenu = useCallback((state: MenuState) => {
    previousFocusRef.current = document.activeElement as HTMLElement | null
    setMenuState(state)
  }, [])

  const buildShareLink = useCallback(async (): Promise<string> => {
    let lanIp: string | null = null
    try {
      const res = await api.get<{ ips: string[] }>('/api/lan-info')
      if (res.ips.length > 0) lanIp = res.ips[0]
    } catch {
      // ignore
    }

    const token = sessionStorage.getItem('auth-token')
    return buildShareUrl({
      currentUrl: window.location.href,
      lanIp,
      token,
      isDev: import.meta.env.DEV,
    })
  }, [])

  const copyShareLink = useCallback(async () => {
    const url = await buildShareLink()
    await copyText(url)
  }, [buildShareLink])

  const copyTabNames = useCallback(async () => {
    const names = tabsState.tabs.map((tab) => getTabDisplayTitle(tab, panes[tab.id]))
    await copyText(names.join('\n'))
  }, [tabsState.tabs, panes])

  const copyTabName = useCallback(async (tabId: string) => {
    const tab = tabsState.tabs.find((t) => t.id === tabId)
    if (!tab) return
    const name = getTabDisplayTitle(tab, panes[tab.id])
    await copyText(name)
  }, [tabsState.tabs, panes])

  const newDefaultTab = useCallback(() => {
    dispatch(addTab({ mode: 'shell' }))
  }, [dispatch])

  const newTabWithPane = useCallback((type: 'shell' | 'cmd' | 'powershell' | 'wsl' | 'browser' | 'editor') => {
    if (type === 'browser') {
      const id = nanoid()
      dispatch(addTab({ id, mode: 'shell' }))
      dispatch(initLayout({ tabId: id, content: { kind: 'browser', url: '', devToolsOpen: false } }))
      return
    }
    if (type === 'editor') {
      const id = nanoid()
      dispatch(addTab({ id, mode: 'shell' }))
      dispatch(initLayout({
        tabId: id,
        content: {
          kind: 'editor',
          filePath: null,
          language: null,
          readOnly: false,
          content: '',
          viewMode: 'source',
        },
      }))
      return
    }
    if (type === 'cmd' || type === 'powershell' || type === 'wsl') {
      dispatch(addTab({ mode: 'shell', shell: type }))
      return
    }
    dispatch(addTab({ mode: 'shell', shell: 'system' }))
  }, [dispatch])

  const renameTab = useCallback((tabId: string) => {
    const tab = tabsState.tabs.find((t) => t.id === tabId)
    if (!tab) return
    const next = window.prompt('Rename tab', tab.title)
    if (!next) return
    dispatch(updateTab({ id: tabId, updates: { title: next, titleSetByUser: true } }))
  }, [dispatch, tabsState.tabs])

  const renamePane = useCallback((tabId: string, paneId: string) => {
    const layout = panes[tabId]
    if (!layout) return
    const current = findPaneContent(layout, paneId)
    const title = current && current.kind === 'terminal' ? current.mode : 'Pane'
    const next = window.prompt('Rename pane', title)
    if (!next) return
    dispatch(updatePaneTitle({ tabId, paneId, title: next }))
  }, [dispatch, panes])

  const closeTabById = useCallback((tabId: string) => {
    const layout = panes[tabId]
    if (layout) {
      const terminalIds = collectTerminalIds(layout)
      for (const terminalId of terminalIds) {
        ws.send({ type: 'terminal.detach', terminalId })
      }
    }
    dispatch(closeTab(tabId))
  }, [dispatch, panes, ws])

  const closeOtherTabs = useCallback((tabId: string) => {
    setConfirmState({
      title: 'Close all other tabs?',
      body: 'This will close every other tab.',
      confirmLabel: 'Close tabs',
      onConfirm: () => {
        const ids = tabsState.tabs.map((t) => t.id).filter((id) => id !== tabId)
        ids.forEach(closeTabById)
        setConfirmState(null)
      },
    })
  }, [tabsState.tabs, closeTabById])

  const closeTabsToRight = useCallback((tabId: string) => {
    const index = tabsState.tabs.findIndex((t) => t.id === tabId)
    if (index < 0) return
    const ids = tabsState.tabs.slice(index + 1).map((t) => t.id)
    ids.forEach(closeTabById)
  }, [tabsState.tabs, closeTabById])

  const moveTab = useCallback((tabId: string, dir: -1 | 1) => {
    const index = tabsState.tabs.findIndex((t) => t.id === tabId)
    if (index < 0) return
    const next = index + dir
    if (next < 0 || next >= tabsState.tabs.length) return
    dispatch(reorderTabs({ fromIndex: index, toIndex: next }))
  }, [dispatch, tabsState.tabs])

  const getSessionInfo = useCallback((sessionId: string, provider?: string) => {
    for (const project of sessions) {
      const session = project.sessions.find((s) =>
        s.sessionId === sessionId && (!provider || s.provider === provider)
      )
      if (session) return { session, project }
    }
    return null
  }, [sessions])

  const openSessionInNewTab = useCallback((sessionId: string, provider?: string) => {
    const info = getSessionInfo(sessionId, provider)
    if (!info) return
    const { session } = info
    const mode = (provider || session.provider || 'claude') as CodingCliProviderName
    const runningTerminalId =
      menuState?.target.kind === 'sidebar-session' && menuState?.target.sessionId === sessionId
        ? menuState?.target.runningTerminalId
        : undefined
    if (runningTerminalId) {
      dispatch(addTab({
        title: session.title || session.sessionId.slice(0, 8),
        terminalId: runningTerminalId,
        status: 'running',
        mode,
        codingCliProvider: mode,
        resumeSessionId: session.sessionId,
        forceNew: true,
      }))
      return
    }
    dispatch(addTab({
      title: session.title || session.sessionId.slice(0, 8),
      mode,
      codingCliProvider: mode,
      initialCwd: session.cwd,
      resumeSessionId: session.sessionId,
      forceNew: true,
    }))
  }, [dispatch, getSessionInfo, menuState?.target])

  const openSessionInThisTab = useCallback((sessionId: string, provider?: string) => {
    const activeTabId = tabsState.activeTabId
    if (!activeTabId) {
      openSessionInNewTab(sessionId, provider)
      return
    }
    const info = getSessionInfo(sessionId, provider)
    if (!info) return
    const { session } = info
    const mode = (provider || session.provider || 'claude') as CodingCliProviderName
    const runningTerminalId =
      menuState?.target.kind === 'sidebar-session' && menuState?.target.sessionId === sessionId
        ? menuState?.target.runningTerminalId
        : undefined
    dispatch(addPane({
      tabId: activeTabId,
      newContent: {
        kind: 'terminal',
        mode,
        resumeSessionId: session.sessionId,
        initialCwd: session.cwd,
        terminalId: runningTerminalId || undefined,
        status: runningTerminalId ? 'running' : 'creating',
      },
    }))
  }, [tabsState.activeTabId, dispatch, getSessionInfo, openSessionInNewTab, menuState?.target])

  const renameSession = useCallback(async (sessionId: string, provider?: string, withSummary?: boolean) => {
    const info = getSessionInfo(sessionId, provider)
    if (!info) return
    const title = window.prompt('Rename session', info.session.title || '')
    if (title === null) return
    let summary: string | undefined
    if (withSummary) {
      const nextSummary = window.prompt('Update summary', info.session.summary || '')
      if (nextSummary === null) return
      summary = nextSummary || undefined
    }
    try {
      const compositeKey = `${provider || info.session.provider || 'claude'}:${sessionId}`
      await api.patch(`/api/sessions/${encodeURIComponent(compositeKey)}`, {
        titleOverride: title || undefined,
        summaryOverride: summary,
      })
      const data = await api.get('/api/sessions')
      dispatch(setProjects(data))
    } catch {
      // ignore
    }
  }, [dispatch, getSessionInfo])

  const toggleArchiveSession = useCallback(async (sessionId: string, provider: string | undefined, next: boolean) => {
    try {
      const compositeKey = `${provider || 'claude'}:${sessionId}`
      await api.patch(`/api/sessions/${encodeURIComponent(compositeKey)}`, { archived: next })
      const data = await api.get('/api/sessions')
      dispatch(setProjects(data))
    } catch {
      // ignore
    }
  }, [dispatch])

  const deleteSession = useCallback((sessionId: string, provider?: string) => {
    const info = getSessionInfo(sessionId, provider)
    if (!info) return
    const messageCount = info.session.messageCount
    const createdAt = info.session.createdAt
    const updatedAt = info.session.updatedAt
    const summary = info.session.summary

    const formatDate = (value?: number) => {
      if (!value) return 'unknown'
      return new Date(value).toLocaleString()
    }

    setConfirmState({
      title: 'Delete session?',
      confirmLabel: 'Delete',
      body: (
        <div className="space-y-2">
          {summary ? <div className="text-xs">{summary}</div> : null}
          <div className="text-xs">Messages: {messageCount ?? 'unknown'}</div>
          <div className="text-xs">Created: {formatDate(createdAt)}</div>
          <div className="text-xs">Last used: {formatDate(updatedAt)}</div>
        </div>
      ),
      onConfirm: async () => {
        try {
          const compositeKey = `${provider || info.session.provider || 'claude'}:${sessionId}`
          await api.delete(`/api/sessions/${encodeURIComponent(compositeKey)}`)
          const data = await api.get('/api/sessions')
          dispatch(setProjects(data))
        } catch {
          // ignore
        } finally {
          setConfirmState(null)
        }
      },
    })
  }, [dispatch, getSessionInfo])

  const copySessionId = useCallback(async (sessionId: string) => {
    await copyText(sessionId)
  }, [])

  const copySessionCwd = useCallback(async (sessionId: string, provider?: string) => {
    const info = getSessionInfo(sessionId, provider)
    if (info?.session.cwd) {
      await copyText(info.session.cwd)
    }
  }, [getSessionInfo])

  const copySessionSummary = useCallback(async (sessionId: string, provider?: string) => {
    const info = getSessionInfo(sessionId, provider)
    if (info?.session.summary) {
      await copyText(info.session.summary)
    }
  }, [getSessionInfo])

  const copySessionMetadata = useCallback(async (sessionId: string, provider?: string) => {
    const info = getSessionInfo(sessionId, provider)
    if (!info) return
    const { session, project } = info
    const keyProvider = (provider || session.provider || 'claude')
    const relatedTabs = tabsState.tabs.filter(
      (t) =>
        t.resumeSessionId === sessionId &&
        (t.codingCliProvider || t.mode || 'claude') === keyProvider
    )
    const hasTab = relatedTabs.length > 0
    const tabLastInputAt = relatedTabs.reduce((max, tab) => Math.max(max, tab.lastInputAt ?? 0), 0) || undefined
    const runningTerminalId =
      menuState?.target.kind === 'sidebar-session' && menuState?.target.sessionId === sessionId
        ? menuState?.target.runningTerminalId
        : undefined
    const metadata = {
      title: session.title,
      sessionId: session.sessionId,
      provider: session.provider,
      compositeKey: `${session.provider || 'claude'}:${session.sessionId}`,
      projectPath: project.projectPath,
      cwd: session.cwd,
      createdAt: session.createdAt,
      startDate: session.createdAt ? new Date(session.createdAt).toISOString() : null,
      updatedAt: session.updatedAt,
      endDate: session.updatedAt ? new Date(session.updatedAt).toISOString() : null,
      messageCount: session.messageCount,
      summary: session.summary,
      archived: session.archived,
      sourceFile: session.sourceFile,
      hasTab,
      tabLastInputAt,
      tabLastInputAtIso: tabLastInputAt ? new Date(tabLastInputAt).toISOString() : null,
      isRunning: !!runningTerminalId,
      runningTerminalId: runningTerminalId || null,
      projectColor: project.color,
    }
    await copyText(JSON.stringify(metadata, null, 2))
  }, [getSessionInfo, tabsState.tabs, menuState?.target])

  const setProjectColor = useCallback(async (projectPath: string) => {
    const next = window.prompt('Project color (hex)', '#6b7280')
    if (!next) return
    try {
      await api.put('/api/project-colors', { projectPath, color: next })
      const data = await api.get('/api/sessions')
      dispatch(setProjects(data))
    } catch {
      // ignore
    }
  }, [dispatch])

  const toggleProjectExpandedAction = useCallback((projectPath: string, expanded: boolean) => {
    dispatch(setProjectExpanded({ projectPath, expanded }))
  }, [dispatch])

  const openAllSessionsInProject = useCallback((projectPath: string) => {
    setConfirmState({
      title: 'Open all sessions?',
      confirmLabel: 'Open tabs',
      body: 'This will open every session in the project in its own tab.',
      onConfirm: () => {
        const project = sessions.find((p) => p.projectPath === projectPath)
        if (project) {
          for (const session of project.sessions) {
            dispatch(addTab({
              title: session.title || session.sessionId.slice(0, 8),
              mode: 'claude',
              initialCwd: session.cwd,
              resumeSessionId: session.sessionId,
              forceNew: true,
            }))
          }
        }
        setConfirmState(null)
      },
    })
  }, [dispatch, sessions])

  const copyProjectPath = useCallback(async (projectPath: string) => {
    await copyText(projectPath)
  }, [])

  const openTerminal = useCallback((terminalId: string) => {
    const existing = tabsState.tabs.find((t) => t.terminalId === terminalId)
    if (existing) {
      dispatch(setActiveTab(existing.id))
      return
    }
    dispatch(addTab({ terminalId, status: 'running', mode: 'shell' }))
  }, [dispatch, tabsState.tabs])

  const renameTerminal = useCallback(async (terminalId: string) => {
    let currentTitle = ''
    let currentDesc = ''
    try {
      const terminals = await api.get<Array<{ terminalId: string; title?: string; description?: string }>>('/api/terminals')
      const term = terminals.find((t) => t.terminalId === terminalId)
      if (term) {
        currentTitle = term.title || ''
        currentDesc = term.description || ''
      }
    } catch {
      // ignore
    }
    const title = window.prompt('Rename terminal', currentTitle)
    if (title === null) return
    const description = window.prompt('Update description', currentDesc)
    if (description === null) return
    try {
      await api.patch(`/api/terminals/${encodeURIComponent(terminalId)}`, {
        titleOverride: title || undefined,
        descriptionOverride: description || undefined,
      })
      const existing = tabsState.tabs.find((t) => t.terminalId === terminalId)
      if (existing && title) {
        dispatch(updateTab({ id: existing.id, updates: { title } }))
      }
    } catch {
      // ignore
    }
  }, [dispatch, tabsState.tabs])

  const generateTerminalSummary = useCallback(async (terminalId: string) => {
    try {
      const res = await api.post<{ description?: string }>(`/api/ai/terminals/${encodeURIComponent(terminalId)}/summary`, {})
      if (res?.description) {
        await api.patch(`/api/terminals/${encodeURIComponent(terminalId)}`, {
          descriptionOverride: res.description,
        })
      }
    } catch {
      // ignore
    }
  }, [])

  const deleteTerminal = useCallback(async (terminalId: string) => {
    setConfirmState({
      title: 'Delete terminal?',
      confirmLabel: 'Delete',
      body: 'This will remove the terminal from the overview list.',
      onConfirm: async () => {
        try {
          await api.delete(`/api/terminals/${encodeURIComponent(terminalId)}`)
        } catch {
          // ignore
        } finally {
          setConfirmState(null)
        }
      },
    })
  }, [])

  const copyTerminalCwd = useCallback(async (terminalId: string) => {
    try {
      const terminals = await api.get<Array<{ terminalId: string; cwd?: string }>>('/api/terminals')
      const term = terminals.find((t) => t.terminalId === terminalId)
      if (term?.cwd) await copyText(term.cwd)
    } catch {
      // ignore
    }
  }, [])

  const copyMessageText = useCallback(async (contextEl: HTMLElement | null) => {
    if (!contextEl) return
    const text = contextEl.textContent?.trim()
    if (text) await copyText(text)
  }, [])

  const copyMessageCode = useCallback(async (contextEl: HTMLElement | null) => {
    if (!contextEl) return
    const code = contextEl.querySelector('pre code')
    if (code?.textContent) await copyText(code.textContent)
  }, [])

  const shouldUseNativeMenu = useCallback((targetEl: HTMLElement | null, contextId: string, contextEl: HTMLElement | null, evt: MouseEvent | KeyboardEvent) => {
    if (evt.type === 'contextmenu' && (evt as MouseEvent).shiftKey) return true
    if (contextEl?.dataset.nativeContext === 'true') return true
    if (targetEl?.closest?.('[data-native-context="true"]')) return true
    if (targetEl?.tagName === 'IFRAME') return true

    const inputLike = isTextInputLike(targetEl)
    if (inputLike && ![ContextIds.Editor, ContextIds.Terminal].includes(contextId as any)) return true

    const link = targetEl?.closest?.('a[href]')
    if (link && (contextId === ContextIds.Global || !contextEl)) return true

    return false
  }, [])

  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      const contextEl = findContextElement(target)
      const contextId = resolveContextId(contextEl?.dataset.context)
      if (shouldUseNativeMenu(target, contextId, contextEl, e)) return

      e.preventDefault()
      const dataset = contextEl?.dataset ? copyDataset(contextEl.dataset) : {}
      const parsed = parseContextTarget(contextId as any, dataset)
      const targetObj = parsed || { kind: 'global' as const }

      openMenu({
        position: { x: e.clientX, y: e.clientY },
        target: targetObj,
        contextElement: contextEl,
        dataset,
      })
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      const isContextKey = CONTEXT_MENU_KEYS.includes(e.key) || (e.shiftKey && e.key === 'F10')
      if (!isContextKey) return

      const target = document.activeElement as HTMLElement | null
      const contextEl = findContextElement(target)
      const contextId = resolveContextId(contextEl?.dataset.context)
      if (shouldUseNativeMenu(target, contextId, contextEl, e)) return

      e.preventDefault()
      const dataset = contextEl?.dataset ? copyDataset(contextEl.dataset) : {}
      const parsed = parseContextTarget(contextId as any, dataset)
      const targetObj = parsed || { kind: 'global' as const }

      const rect = contextEl?.getBoundingClientRect() || { left: 0, bottom: 0 }
      openMenu({
        position: { x: rect.left + 8, y: rect.bottom + 4 },
        target: targetObj,
        contextElement: contextEl,
        dataset,
      })
    }

    document.addEventListener('contextmenu', handleContextMenu, true)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('contextmenu', handleContextMenu, true)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [openMenu, shouldUseNativeMenu])

  useEffect(() => {
    if (!menuState) return

    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (menuRef.current && menuRef.current.contains(target)) return
      closeMenu()
    }

    const handleScroll = () => closeMenu()
    const handleResize = () => closeMenu()
    const handleBlur = () => closeMenu()

    document.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('resize', handleResize)
    window.addEventListener('blur', handleBlur)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('blur', handleBlur)
    }
  }, [menuState, closeMenu])

  useEffect(() => {
    if (!menuState) return
    const cleanup = () => closeMenu()
    return cleanup
  }, [view, closeMenu, menuState])

  const menuItems = useMemo(() => {
    if (!menuState) return []
    return buildMenuItems(menuState.target, {
      view,
      sidebarCollapsed,
      tabs: tabsState.tabs,
      paneLayouts: panes,
      sessions,
      expandedProjects,
      contextElement: menuState.contextElement,
      platform,
      actions: {
        newDefaultTab,
        newTabWithPane,
        copyTabNames,
        toggleSidebar: onToggleSidebar,
        copyShareLink,
        openView: onViewChange,
        copyTabName,
        renameTab,
        closeTab: closeTabById,
        closeOtherTabs,
        closeTabsToRight,
        moveTab,
        renamePane,
        resetSplit: (tabId, splitId) => dispatch(resetSplit({ tabId, splitId })),
        swapSplit: (tabId, splitId) => dispatch(swapSplit({ tabId, splitId })),
        closePane: (tabId, paneId) => dispatch(closePane({ tabId, paneId })),
        getTerminalActions: getTerminalActions,
        getEditorActions: getEditorActions,
        getBrowserActions: getBrowserActions,
        openSessionInNewTab,
        openSessionInThisTab,
        renameSession,
        toggleArchiveSession,
        deleteSession,
        copySessionId,
        copySessionCwd,
        copySessionSummary,
        copySessionMetadata,
        setProjectColor,
        toggleProjectExpanded: toggleProjectExpandedAction,
        openAllSessionsInProject,
        copyProjectPath,
        openTerminal,
        renameTerminal,
        generateTerminalSummary,
        deleteTerminal,
        copyTerminalCwd,
        copyMessageText,
        copyMessageCode,
      },
    })
  }, [
    menuState,
    view,
    sidebarCollapsed,
    tabsState.tabs,
    panes,
    sessions,
    expandedProjects,
    platform,
    newDefaultTab,
    newTabWithPane,
    copyTabNames,
    onToggleSidebar,
    copyShareLink,
    onViewChange,
    copyTabName,
    renameTab,
    closeTabById,
    closeOtherTabs,
    closeTabsToRight,
    moveTab,
    renamePane,
    dispatch,
    openSessionInNewTab,
    openSessionInThisTab,
    renameSession,
    toggleArchiveSession,
    deleteSession,
    copySessionId,
    copySessionCwd,
    copySessionSummary,
    copySessionMetadata,
    setProjectColor,
    toggleProjectExpandedAction,
    openAllSessionsInProject,
    copyProjectPath,
    openTerminal,
    renameTerminal,
    generateTerminalSummary,
    deleteTerminal,
    copyTerminalCwd,
    copyMessageText,
    copyMessageCode,
  ])

  return (
    <>
      {children}
      <ContextMenu
        ref={menuRef}
        open={!!menuState && menuItems.length > 0}
        items={menuItems}
        position={menuState?.position || { x: 0, y: 0 }}
        onClose={closeMenu}
      />
      <ConfirmModal
        open={!!confirmState}
        title={confirmState?.title || ''}
        body={confirmState?.body || null}
        confirmLabel={confirmState?.confirmLabel || 'Confirm'}
        onConfirm={() => confirmState?.onConfirm()}
        onCancel={() => setConfirmState(null)}
      />
    </>
  )
}
