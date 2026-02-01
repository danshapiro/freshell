import type { PaneNode, PaneContent, TerminalPaneContent, BrowserPaneContent } from '../store/paneTypes'
import { getProviderLabel, isCodingCliMode } from './coding-cli-utils'

/**
 * Collect all leaf pane contents in tree order (left-to-right, top-to-bottom).
 */
function collectContents(node: PaneNode): PaneContent[] {
  if (node.type === 'leaf') return [node.content]
  return [...collectContents(node.children[0]), ...collectContents(node.children[1])]
}

/**
 * Check if a terminal is a CLI (claude or codex mode).
 */
function isCli(content: PaneContent): content is TerminalPaneContent {
  return content.kind === 'terminal' && isCodingCliMode(content.mode)
}

/**
 * Check if content is a browser.
 */
function isBrowser(content: PaneContent): content is BrowserPaneContent {
  return content.kind === 'browser'
}

/**
 * Check if content is a shell terminal.
 */
function isShellTerminal(content: PaneContent): content is TerminalPaneContent {
  return content.kind === 'terminal' && content.mode === 'shell'
}

/**
 * Check if content is a picker.
 */
function isPicker(content: PaneContent): boolean {
  return content.kind === 'picker'
}

/**
 * Extract hostname (with port for localhost) from a URL.
 */
function extractHostname(url: string): string | null {
  try {
    const parsed = new URL(url)
    // Include port for localhost
    if (parsed.hostname === 'localhost' && parsed.port) {
      return `localhost:${parsed.port}`
    }
    return parsed.hostname
  } catch {
    return null
  }
}

/**
 * Extract last directory segment from a path.
 * Handles both Unix and Windows paths.
 */
function extractLastDirSegment(path: string): string | null {
  // Remove trailing slashes
  const trimmed = path.replace(/[\\/]+$/, '')

  // Handle root paths
  if (trimmed === '' && path.startsWith('/')) return '/'
  if (/^[A-Za-z]:$/.test(trimmed)) return trimmed + '\\'

  // Split by both forward and back slashes
  const segments = trimmed.split(/[\\/]/)
  const last = segments[segments.length - 1]

  return last || null
}

/**
 * Derives a tab name from pane layout content using priority order:
 * 1. First CLI instance (claude or codex mode terminal)
 * 2. First browser
 * 3. First shell terminal (using last directory segment of initialCwd)
 */
export function deriveTabName(layout: PaneNode): string {
  const contents = collectContents(layout)

  // Priority 1: First CLI instance
  const cli = contents.find(isCli)
  if (cli) {
    return getProviderLabel(cli.mode)
  }

  // Priority 2: First browser
  const browser = contents.find(isBrowser)
  if (browser) {
    if (!browser.url) return 'Browser'
    const hostname = extractHostname(browser.url)
    return hostname || 'Browser'
  }

  // Priority 3: First shell terminal
  const shell = contents.find(isShellTerminal)
  if (shell) {
    if (!shell.initialCwd) return 'Shell'
    const segment = extractLastDirSegment(shell.initialCwd)
    return segment || 'Shell'
  }

  // Priority 4: Picker (when all panes are pickers)
  const hasOnlyPickers = contents.every(isPicker)
  if (hasOnlyPickers && contents.length > 0) {
    return 'New Tab'
  }

  // Fallback (should never reach here if layout has content)
  return 'Tab'
}
