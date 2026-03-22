import { addTab, setActiveTab, closeTab, closePaneWithCleanup } from '@/store/tabsSlice'
import {
  initLayout,
  splitPane,
  setActivePane,
  updatePaneContent,
  resizePanes,
  swapPanes,
  updatePaneTitle,
} from '@/store/panesSlice'
import { captureUiScreenshot } from '@/lib/ui-screenshot'
import type { AppDispatch, RootState } from '@/store/store'
import { applyPaneRename, applyTabRename } from '@/store/titleSync'
import { buildExactSessionRef } from '@/lib/exact-session-ref'
import type { PaneContentInput } from '@/store/paneTypes'

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

function hydrateUiCommandPaneContent(
  content: PaneContentInput | undefined,
  localServerInstanceId?: string,
): PaneContentInput | undefined {
  if (!content) return content
  if (content.kind === 'terminal' && content.mode !== 'shell' && content.resumeSessionId) {
    const sessionRef = content.sessionRef
      ?? buildExactSessionRef({
        provider: content.mode,
        sessionId: content.resumeSessionId,
        serverInstanceId: localServerInstanceId,
      })
    return {
      ...content,
      ...(sessionRef ? { sessionRef } : {}),
    }
  }
  return content
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
  const localServerInstanceId = runtime.getState?.().connection?.serverInstanceId

  if (msg.command === 'screenshot.capture') {
    void handleScreenshotCapture(msg, runtime)
    return
  }

  switch (msg.command) {
    case 'tab.create':
      dispatch(addTab({
        id: msg.payload.id,
        title: msg.payload.title,
        titleSource: msg.payload.title ? 'stable' : undefined,
        mode: msg.payload.mode,
        shell: msg.payload.shell,
        terminalId: msg.payload.terminalId,
        initialCwd: msg.payload.initialCwd,
        resumeSessionId: msg.payload.resumeSessionId,
        status: msg.payload.status,
        createRequestId: msg.payload.createRequestId
          || msg.payload.paneContent?.createRequestId,
      }))
      if (msg.payload.paneId && msg.payload.paneContent) {
        return dispatch(initLayout({
          tabId: msg.payload.id,
          paneId: msg.payload.paneId,
          content: hydrateUiCommandPaneContent(msg.payload.paneContent, localServerInstanceId)!,
          title: msg.payload.title,
          titleSource: msg.payload.title ? 'stable' : undefined,
        }))
      }
      return
    case 'tab.select':
      return dispatch(setActiveTab(msg.payload.id))
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
      }))
    case 'pane.close':
      return dispatch(closePaneWithCleanup({ tabId: msg.payload.tabId, paneId: msg.payload.paneId }))
    case 'pane.select':
      return dispatch(setActivePane({ tabId: msg.payload.tabId, paneId: msg.payload.paneId }))
    case 'pane.rename':
      return dispatch(applyPaneRename({
        tabId: msg.payload.tabId,
        paneId: msg.payload.paneId,
        title: msg.payload.title,
      }))
    case 'pane.attach':
      return dispatch(updatePaneContent({
        tabId: msg.payload.tabId,
        paneId: msg.payload.paneId,
        content: hydrateUiCommandPaneContent(msg.payload.content, localServerInstanceId)!,
      }))
    case 'pane.resize':
      return dispatch(resizePanes({ tabId: msg.payload.tabId, splitId: msg.payload.splitId, sizes: msg.payload.sizes }))
    case 'pane.swap':
      return dispatch(swapPanes({ tabId: msg.payload.tabId, paneId: msg.payload.paneId, otherId: msg.payload.otherId }))
  }
}
