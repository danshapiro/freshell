import { addTab, setActiveTab, closeTab, closePaneWithCleanup } from '@/store/tabsSlice'
import { initLayout, splitPane, setActivePane, nudgePaneFocus, updatePaneContent, resizePanes, swapPanes } from '@/store/panesSlice'
import { captureUiScreenshot } from '@/lib/ui-screenshot'
import type { RootState } from '@/store/store'
import { applyPaneRename, applyTabRename } from '@/store/titleSync'

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
    case 'tab.rename':
      return dispatch(applyTabRename({ tabId: msg.payload.id, title: msg.payload.title }))
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
    case 'pane.rename':
      return dispatch(applyPaneRename({
        tabId: msg.payload.tabId,
        paneId: msg.payload.paneId,
        title: msg.payload.title,
      }))
    case 'pane.attach':
      return dispatch(updatePaneContent({ tabId: msg.payload.tabId, paneId: msg.payload.paneId, content: msg.payload.content }))
    case 'pane.resize':
      return dispatch(resizePanes({ tabId: msg.payload.tabId, splitId: msg.payload.splitId, sizes: msg.payload.sizes }))
    case 'pane.swap':
      return dispatch(swapPanes({ tabId: msg.payload.tabId, paneId: msg.payload.paneId, otherId: msg.payload.otherId }))
  }
}
