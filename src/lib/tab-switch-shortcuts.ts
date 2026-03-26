export type TabSwitchShortcutDirection = 'prev' | 'next'

export type TabLifecycleAction = 'new' | 'close' | 'reopen'

type TabShortcutEvent = Pick<
  KeyboardEvent,
  'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'code'
>

export function getTabSwitchShortcutDirection(
  event: TabShortcutEvent,
): TabSwitchShortcutDirection | null {
  if (event.metaKey) return null
  const ctrlShift = event.ctrlKey && event.shiftKey && !event.altKey
  const altOnly = event.altKey && !event.ctrlKey && !event.shiftKey
  if (!ctrlShift && !altOnly) return null
  if (event.code === 'BracketLeft') return 'prev'
  if (event.code === 'BracketRight') return 'next'
  return null
}

export function getTabLifecycleAction(
  event: TabShortcutEvent,
): TabLifecycleAction | null {
  if (event.metaKey || event.ctrlKey || !event.altKey) return null
  // Alt+Shift+T is an alternate binding for reopen (mirrors browser Ctrl+Shift+T)
  if (event.shiftKey && event.code === 'KeyT') return 'reopen'
  if (event.shiftKey) return null
  if (event.code === 'KeyT') return 'new'
  if (event.code === 'KeyW') return 'close'
  if (event.code === 'KeyH') return 'reopen'
  return null
}
