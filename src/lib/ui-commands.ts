import { addTab, setActiveTab, closeTab, closePaneWithCleanup } from '@/store/tabsSlice'
import { initLayout, splitPane, setActivePane, nudgePaneFocus, updatePaneContent, resizePanes, swapPanes } from '@/store/panesSlice'
import { captureUiScreenshot } from '@/lib/ui-screenshot'
import type { RootState } from '@/store/store'
import { applyPaneRename, applyTabRename } from '@/store/titleSync'
import { receiveSessionNames } from '@/store/sessionNamesSlice'
import { bootstrapSessionNames, parseSessionNameUpdate, parseSessionNameRef } from '@/lib/session-names'
import { isUnifiedAgentMode, type SessionNameRef } from '@shared/session-names'
import type { PaneContent } from '@/store/paneTypes'
import {
  isScopedPaneContent,
  selectTabNameSourcePaneId,
} from '@/store/selectors/sessionNameSelectors'
import { forceLayoutResync } from '@/store/layoutMirrorMiddleware'

type DispatchFn = (action: any) => any

type UiCommandRuntime = {
  dispatch: DispatchFn
  getState?: () => RootState
  send?: (msg: unknown) => void
}

function resolveRuntime(input: UiCommandRuntime | DispatchFn): UiCommandRuntime {
  if (typeof input === 'function') {
    return { dispatch: input }
  }
  return input
}

/**
 * Unified agent names (Task 5): a scoped agent pane/tab never takes a sticky
 * ui.command title alias — a server that routes its rename canonically
 * publishes `session.name.updated` instead, so any legacy rename receipt that
 * still names a scoped target is consumed through the canonical cache: an
 * embedded `sessionName` update folds directly, otherwise the resolved name
 * is refetched (never a local manual flag, never a second PATCH).
 */
function consumeScopedRenameReceipt(
  runtime: UiCommandRuntime,
  tabId: string | undefined,
  paneId: string | undefined,
  payload: Record<string, unknown>,
): boolean {
  const state = runtime.getState?.()
  if (!state) return false
  let scoped = false
  if (paneId) {
    for (const layout of Object.values(state.panes?.layouts ?? {})) {
      const walk = (node: unknown): void => {
        if (!node || typeof node !== 'object') return
        const n = node as { type?: string; id?: string; content?: { kind?: string }; children?: unknown[] }
        if (n.type === 'leaf') {
          if (n.id === paneId && n.content && isScopedPaneContent(n.content as never)) scoped = true
          return
        }
        for (const child of n.children ?? []) walk(child)
      }
      walk(layout)
    }
  }
  if (!scoped && tabId && selectTabNameSourcePaneId(state, tabId)) scoped = true
  if (!scoped) return false

  const update = parseSessionNameUpdate(payload.sessionName)
  if (update) {
    runtime.dispatch(receiveSessionNames([update]))
    return true
  }
  // No embedded record: refetch the resolved names for the pane's naming refs
  // (best effort — the session.name.updated push remains the live authority).
  const refs = collectRefsForScopedTarget(state, tabId, paneId)
  if (refs.length > 0) {
    void bootstrapSessionNames(refs)
      .then((updates) => {
        if (updates.length > 0) runtime.dispatch(receiveSessionNames(updates))
      })
      .catch(() => { /* the broadcast converges this later */ })
  }
  return true
}

function collectRefsForScopedTarget(
  state: RootState,
  tabId: string | undefined,
  paneId: string | undefined,
): SessionNameRef[] {
  const refs: SessionNameRef[] = []
  const layouts = state.panes?.layouts ?? {}
  const layout = tabId ? layouts[tabId] : undefined
  if (layout) {
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return
      const n = node as {
        type?: string
        id?: string
        content?: { kind?: string; nameRef?: unknown; namingHandle?: unknown; sessionRef?: { provider?: unknown; sessionId?: unknown } }
        children?: unknown[]
      }
      if (n.type === 'leaf') {
        if (n.id === paneId || !paneId) {
          const content = n.content
          const parsedRef = content ? parseSessionNameRef(content.nameRef) : undefined
          if (parsedRef) refs.push(parsedRef)
          if (typeof content?.namingHandle === 'string' && content.namingHandle.length > 0) {
            refs.push({ kind: 'pending', id: content.namingHandle })
          }
          if (
            typeof content?.sessionRef?.provider === 'string'
            && typeof content?.sessionRef?.sessionId === 'string'
            && content.sessionRef.sessionId.length > 0
            && (content.sessionRef.provider === 'claude' || content.sessionRef.provider === 'codex' || content.sessionRef.provider === 'opencode')
          ) {
            refs.push({ kind: 'session', provider: content.sessionRef.provider, sessionId: content.sessionRef.sessionId })
          }
        }
        return
      }
      for (const child of n.children ?? []) walk(child)
    }
    walk(layout)
  }
  return refs
}

/** Does a `tab.create` payload create a scoped Claude/Codex/OpenCode pane?
 * Explicit pane content decides; otherwise the tab's mode does (a
 * terminal-id create and the layout's later default pane both take it). */
function createsScopedAgentPane(payload: { mode?: unknown; paneContent?: unknown }): boolean {
  const content = payload.paneContent
  if (content && typeof content === 'object') {
    return isScopedPaneContent(content as PaneContent)
  }
  return typeof payload.mode === 'string' && isUnifiedAgentMode(payload.mode, undefined)
}

async function handleScreenshotCapture(msg: any, runtime: UiCommandRuntime): Promise<void> {
  const payload = msg?.payload && typeof msg.payload === 'object'
    ? msg.payload as Record<string, unknown>
    : {}

  const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
  if (!requestId || !runtime.send) return

  const scope = payload.scope
  if (scope !== 'pane' && scope !== 'tab' && scope !== 'view') {
    runtime.send({
      type: 'ui.screenshot.result',
      requestId,
      ok: false,
      changedFocus: false,
      restoredFocus: false,
      error: 'invalid screenshot scope',
    })
    return
  }

  const paneId = typeof payload.paneId === 'string' ? payload.paneId : undefined
  const tabId = typeof payload.tabId === 'string' ? payload.tabId : undefined

  try {
    // Renders through an off-DOM clone: the user's selection, focus, and
    // screen never move, background tabs included.
    const capture = await captureUiScreenshot({ scope, paneId, tabId })
    runtime.send({
      type: 'ui.screenshot.result',
      requestId,
      ...capture,
    })
  } catch (err: any) {
    runtime.send({
      type: 'ui.screenshot.result',
      requestId,
      ok: false,
      changedFocus: false,
      restoredFocus: false,
      error: err?.message || 'failed to capture screenshot',
    })
  }
}

export function handleUiCommand(msg: any, runtimeOrDispatch: UiCommandRuntime | DispatchFn) {
  if (msg?.type !== 'ui.command') return
  const runtime = resolveRuntime(runtimeOrDispatch)
  const dispatch = runtime.dispatch

  if (msg.command === 'screenshot.capture') {
    void handleScreenshotCapture(msg, runtime)
    return
  }

  switch (msg.command) {
    case 'tab.create':
      dispatch(addTab({
        id: msg.payload.id,
        title: msg.payload.title,
        // Explicit creator-provided name (REST/MCP `name`): an explicit title
        // outranks mirrored session titles and registry auto-titles in
        // getTabDisplayTitle (rename-scope-contract display precedence).
        // Not for a Claude/Codex/OpenCode tab (name reliability, Task 7): its
        // title is a provisional display that the saved-name mirror replaces
        // once the session's record arrives, so it is never frozen.
        titleSetByUser: msg.payload.title && !createsScopedAgentPane(msg.payload) ? true : undefined,
        mode: msg.payload.mode,
        shell: msg.payload.shell,
        initialCwd: msg.payload.initialCwd,
        sessionRef: msg.payload.sessionRef,
        resumeSessionId: msg.payload.resumeSessionId,
        status: msg.payload.status,
        activate: false,
      }))
      if (msg.payload.paneId && msg.payload.paneContent) {
        return dispatch(initLayout({ tabId: msg.payload.id, paneId: msg.payload.paneId, content: msg.payload.paneContent }))
      }
      if (msg.payload.terminalId) {
        return dispatch(initLayout({
          tabId: msg.payload.id,
          content: {
            kind: 'terminal',
            mode: msg.payload.mode || 'shell',
            terminalId: msg.payload.terminalId,
            status: msg.payload.status || 'running',
            shell: msg.payload.shell,
            initialCwd: msg.payload.initialCwd,
            sessionRef: msg.payload.sessionRef,
            resumeSessionId: msg.payload.resumeSessionId,
          },
        }))
      }
      return
    case 'tab.select':
      dispatch(setActiveTab(msg.payload.id))
      // Focus contract: explicit selects move DOM focus. When the tab (or its
      // active pane) was already Redux-active there is no eligibility
      // transition, so nudge the pane focus epoch as the DOM-focus signal.
      return dispatch(nudgePaneFocus({ tabId: msg.payload.id }))
    case 'tab.rename': {
      const payload = (msg.payload ?? {}) as Record<string, unknown>
      if (consumeScopedRenameReceipt(runtime, msg.payload?.id, undefined, payload)) return
      return dispatch(applyTabRename({ tabId: msg.payload.id, title: msg.payload.title }))
    }
    case 'tab.close':
      return dispatch(closeTab(msg.payload.id))
    case 'pane.split':
      return dispatch(splitPane({
        tabId: msg.payload.tabId,
        paneId: msg.payload.paneId,
        direction: msg.payload.direction,
        newContent: msg.payload.newContent,
        newPaneId: msg.payload.newPaneId,
        activate: false,
      }))
    case 'pane.close':
      return dispatch(closePaneWithCleanup({ tabId: msg.payload.tabId, paneId: msg.payload.paneId }))
    case 'pane.select':
      dispatch(setActiveTab(msg.payload.tabId))
      // focusNudge: an explicit select moves DOM focus even when the pane is
      // already Redux-active (no eligibility transition exists to re-run
      // focus effects) — the epoch bump is that signal.
      return dispatch(setActivePane({ tabId: msg.payload.tabId, paneId: msg.payload.paneId, focusNudge: true }))
    case 'pane.rename': {
      const payload = (msg.payload ?? {}) as Record<string, unknown>
      if (consumeScopedRenameReceipt(runtime, msg.payload.tabId, msg.payload.paneId, payload)) return
      return dispatch(applyPaneRename({
        tabId: msg.payload.tabId,
        paneId: msg.payload.paneId,
        title: msg.payload.title,
      }))
    }
    case 'pane.attach':
      return dispatch(updatePaneContent({ tabId: msg.payload.tabId, paneId: msg.payload.paneId, content: msg.payload.content }))
    case 'pane.resize':
      return dispatch(resizePanes({ tabId: msg.payload.tabId, splitId: msg.payload.splitId, sizes: msg.payload.sizes }))
    case 'pane.swap':
      return dispatch(swapPanes({ tabId: msg.payload.tabId, paneId: msg.payload.paneId, otherId: msg.payload.otherId }))
    case 'layout.resync':
      // kata b8ke Task 10: the server's re-sync handshake (respawn/attach
      // missed this pane in every synced layout) — the layout mirror
      // re-sends the current layout immediately, dedupe gate bypassed.
      return dispatch(forceLayoutResync())
  }
}
