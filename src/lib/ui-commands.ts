import { addTab, setActiveTab, removeTab, updateTab } from '@/store/tabsSlice'
import { initLayout, splitPane, closePane, setActivePane, updatePaneContent, resizePanes, swapPanes } from '@/store/panesSlice'
import { captureUiScreenshot } from '@/lib/ui-screenshot'
import type { AppDispatch, RootState } from '@/store/store'

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
  if (!requestId || !runtime.send || !runtime.getState) return

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
    const capture = await captureUiScreenshot({ scope, paneId, tabId }, {
      dispatch: runtime.dispatch as AppDispatch,
      getState: runtime.getState,
    })
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
        terminalId: msg.payload.terminalId,
        initialCwd: msg.payload.initialCwd,
        resumeSessionId: msg.payload.resumeSessionId,
        status: msg.payload.status,
      }))
      if (msg.payload.paneId && msg.payload.paneContent) {
        return dispatch(initLayout({ tabId: msg.payload.id, paneId: msg.payload.paneId, content: msg.payload.paneContent }))
      }
      return
    case 'tab.select':
      return dispatch(setActiveTab(msg.payload.id))
    case 'tab.rename':
      return dispatch(updateTab({ id: msg.payload.id, updates: { title: msg.payload.title } }))
    case 'tab.close':
      return dispatch(removeTab(msg.payload.id))
    case 'pane.split':
      return dispatch(splitPane({
        tabId: msg.payload.tabId,
        paneId: msg.payload.paneId,
        direction: msg.payload.direction,
        newContent: msg.payload.newContent,
        newPaneId: msg.payload.newPaneId,
      }))
    case 'pane.close':
      return dispatch(closePane({ tabId: msg.payload.tabId, paneId: msg.payload.paneId }))
    case 'pane.select':
      return dispatch(setActivePane({ tabId: msg.payload.tabId, paneId: msg.payload.paneId }))
    case 'pane.attach':
      return dispatch(updatePaneContent({ tabId: msg.payload.tabId, paneId: msg.payload.paneId, content: msg.payload.content }))
    case 'pane.resize':
      return dispatch(resizePanes({ tabId: msg.payload.tabId, splitId: msg.payload.splitId, sizes: msg.payload.sizes }))
    case 'pane.swap':
      return dispatch(swapPanes({ tabId: msg.payload.tabId, paneId: msg.payload.paneId, otherId: msg.payload.otherId }))
  }
}
