export type TabSwitchShortcutDirection = 'prev' | 'next'

type TabSwitchShortcutEvent = Pick<
  KeyboardEvent,
  'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'code'
>

export function getTabSwitchShortcutDirection(
  event: TabSwitchShortcutEvent,
): TabSwitchShortcutDirection | null {
  if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return null
  if (event.code === 'BracketLeft') return 'prev'
  if (event.code === 'BracketRight') return 'next'
  return null
}
