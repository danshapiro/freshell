export type TabSwitchShortcutDirection = 'prev' | 'next'

export type TabLifecycleAction = 'new' | 'close'

type TabShortcutEvent = Pick<
  KeyboardEvent,
  'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'code'
>

export function getTabSwitchShortcutDirection(
  event: TabShortcutEvent,
): TabSwitchShortcutDirection | null {
  if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return null
  if (event.code === 'BracketLeft') return 'prev'
  if (event.code === 'BracketRight') return 'next'
  return null
}

export function getTabLifecycleAction(
  event: TabShortcutEvent,
): TabLifecycleAction | null {
  if (!event.altKey || event.ctrlKey || event.shiftKey || event.metaKey) return null
  if (event.code === 'KeyT') return 'new'
  if (event.code === 'KeyW') return 'close'
  return null
}
