// Shared theme detection utilities used by app theme, terminal themes, and editor panes.

export function getSystemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false
}
