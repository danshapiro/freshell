import { useEffect } from 'react'
import { useAppStore } from '@/store/hooks'
import { getWsClient } from '@/lib/ws-client'
import { createInterestPublisher, selectTerminalInterest } from '@/lib/terminal-interest'

/** Mount once for the workspace. Interest is transient, per-connection, and
 * never persisted or synchronized into another viewer's layout. */
export function TerminalInterestReporter({ workspaceVisible = true }: { workspaceVisible?: boolean }) {
  const store = useAppStore()
  useEffect(() => {
    const ws = getWsClient()
    const publisher = createInterestPublisher({
      read: () => selectTerminalInterest(store.getState(), document.hidden || !workspaceVisible),
      send: (snapshot) => ws.sendTerminalInterest(snapshot),
      scheduleTask: (task) => {
        const timer = window.setTimeout(task, 0)
        return () => window.clearTimeout(timer)
      },
    })
    let previous: readonly unknown[] | undefined
    const onState = () => {
      const state = store.getState()
      const tab = state.tabs.activeTabId
      const dependencies = [tab, tab ? state.panes.layouts[tab] : undefined,
        tab ? state.panes.activePane[tab] : undefined,
        tab ? state.panes.zoomedPane?.[tab] : undefined]
      if (previous && dependencies.every((value, index) => value === previous![index])) return
      previous = dependencies
      publisher.schedule()
    }
    const unsubscribeStore = store.subscribe(onState)
    const unsubscribeMessage = ws.onMessage((message) => {
      if (message.type === 'ready') { publisher.invalidate(); publisher.flushNow(true) }
    })
    // No disconnect hook needed: a disconnected socket's send() refuses
    // (state !== 'ready'), and the revision counter is owned by the socket —
    // on re-ready the 'ready' frame above resets protocol state client-side
    // (counter rewind happens in the ready handler, not here) and this
    // publish loop re-flushes the current interest forcefully.
    // The page may be frozen immediately after visibilitychange. Do not put
    // this update behind a timer that the browser is about to clamp.
    const onVisibility = () => publisher.flushNow(true)
    document.addEventListener('visibilitychange', onVisibility)
    onState()
    publisher.flushNow(true)
    return () => {
      unsubscribeStore(); unsubscribeMessage()
      document.removeEventListener('visibilitychange', onVisibility)
      publisher.dispose()
    }
  }, [store, workspaceVisible])
  return null
}
