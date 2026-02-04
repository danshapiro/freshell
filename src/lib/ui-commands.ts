import { addTab, setActiveTab, removeTab, updateTab } from '@/store/tabsSlice'
import { splitPane, closePane, setActivePane, updatePaneContent } from '@/store/panesSlice'

export function handleUiCommand(msg: any, dispatch: (action: any) => void) {
  if (msg?.type !== 'ui.command') return
  switch (msg.command) {
    case 'tab.create':
      return dispatch(addTab({ id: msg.payload.id, title: msg.payload.title, mode: msg.payload.mode, shell: msg.payload.shell }))
    case 'tab.select':
      return dispatch(setActiveTab(msg.payload.id))
    case 'tab.rename':
      return dispatch(updateTab({ id: msg.payload.id, updates: { title: msg.payload.title } }))
    case 'tab.close':
      return dispatch(removeTab(msg.payload.id))
    case 'pane.split':
      return dispatch(splitPane({ tabId: msg.payload.tabId, paneId: msg.payload.paneId, direction: msg.payload.direction, newContent: msg.payload.newContent }))
    case 'pane.close':
      return dispatch(closePane({ tabId: msg.payload.tabId, paneId: msg.payload.paneId }))
    case 'pane.select':
      return dispatch(setActivePane({ tabId: msg.payload.tabId, paneId: msg.payload.paneId }))
    case 'pane.attach':
      return dispatch(updatePaneContent({ tabId: msg.payload.tabId, paneId: msg.payload.paneId, content: msg.payload.content }))
  }
}
