// Canonical registry of keyboard shortcuts displayed in the UI and README.

export type ShortcutCategory = 'tabs' | 'terminal'

export type ShortcutEntry = {
  keys: string[]
  description: string
  category: ShortcutCategory
}

export const KEYBOARD_SHORTCUTS: ShortcutEntry[] = [
  { keys: ['Alt', 'T'], description: 'New tab', category: 'tabs' },
  { keys: ['Alt', 'W'], description: 'Close tab', category: 'tabs' },
  { keys: ['Alt', 'H'], description: 'Reopen closed tab', category: 'tabs' },
  { keys: ['Ctrl', 'Shift', '['], description: 'Previous tab', category: 'tabs' },
  { keys: ['Ctrl', 'Shift', ']'], description: 'Next tab', category: 'tabs' },
  { keys: ['Ctrl', 'Shift', '\u2190'], description: 'Move tab left', category: 'tabs' },
  { keys: ['Ctrl', 'Shift', '\u2192'], description: 'Move tab right', category: 'tabs' },
  { keys: ['Ctrl', 'Shift', 'C'], description: 'Copy selection', category: 'terminal' },
  { keys: ['Ctrl', 'V'], description: 'Paste', category: 'terminal' },
  { keys: ['Ctrl', 'F'], description: 'Search', category: 'terminal' },
  { keys: ['Shift', 'Enter'], description: 'Newline', category: 'terminal' },
  { keys: ['Cmd/Ctrl', 'End'], description: 'Scroll to bottom', category: 'terminal' },
]

export const SHORTCUT_CATEGORIES: { id: ShortcutCategory; label: string }[] = [
  { id: 'tabs', label: 'Tabs' },
  { id: 'terminal', label: 'Terminal' },
]
