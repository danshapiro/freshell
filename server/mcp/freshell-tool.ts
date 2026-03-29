/**
 * Freshell MCP tool -- single "freshell" tool with action dispatch (obra pattern).
 *
 * Routes structured { action, params } calls to the Freshell REST API via
 * the MCP HTTP client. This is the core of the MCP server.
 */

import { z } from 'zod'
import { createApiClient, resolveConfig, type ApiClient } from './http-client.js'
import { translateKeys } from '../cli/keys.js'

// Lazy-initialized client -- created on first use so env vars are read at call time.
let _client: ApiClient | undefined

function client(): ApiClient {
  if (!_client) {
    _client = createApiClient(resolveConfig())
  }
  return _client
}

// ---------------------------------------------------------------------------
// Exports: TOOL_DESCRIPTION, INSTRUCTIONS, INPUT_SCHEMA, executeAction
// ---------------------------------------------------------------------------

export const TOOL_DESCRIPTION = `Freshell terminal multiplexer -- orchestrate tabs, panes, and terminals.

Use action dispatch: freshell({ action: "help" }) to see all commands.

Key actions:
- Tab: new-tab, list-tabs, select-tab, kill-tab, rename-tab, next-tab, prev-tab, has-tab
- Pane: split-pane, list-panes, select-pane, kill-pane, rename-pane, resize-pane, swap-pane, respawn-pane
- Terminal I/O: send-keys, capture-pane, wait-for, run, summarize, display, list-terminals, attach
- Browser: open-browser, navigate
- Screenshot: screenshot (scope: pane|tab|view)
- Session: list-sessions, search-sessions
- Info: lan-info
- Meta: health, help

Common params: target (ID or name), name, mode, direction, keys, url, scope.`

export const INSTRUCTIONS = `Freshell is a browser-accessible terminal multiplexer and session organizer.

FRESHELL_URL and FRESHELL_TOKEN are already set in your environment.

## Mental model

- Tabs contain pane trees (splits). Panes contain content.
- Pane kinds: terminal, editor, browser, agent-chat (Claude/Codex/etc.), picker (transient).
- **Picker panes are ephemeral.** A freshly-created tab without mode/browser/editor starts as a picker pane while the user chooses what to launch. Once they select, the picker is replaced by the real pane with a **new pane ID**. Never target a picker pane for splits or mutations -- use mode/browser/editor params on new-tab/split-pane to skip the picker entirely.
- Typical workflow: new-tab -> send-keys -> wait-for -> capture-pane/screenshot.

## Targets

- Tab target: tab ID or exact tab title.
- Pane target: pane ID, numeric pane index (scoped to active tab), or pane title.
- Omitted target defaults to the caller's own tab and pane (where the MCP server was spawned), NOT the user's active viewport. This means split-pane without a target splits your own pane, not whatever the user is looking at.
- If a target is ambiguous (e.g. duplicate pane titles), the error returns the specific pane IDs to use.
- If target resolution fails, run list-tabs / list-panes and retry with explicit IDs.

## Key gotchas

- Use literal mode for natural-language prompts: { keys: "your prompt text", literal: true }. Token mode (default) translates special tokens like ENTER/C-C but mangles prose.
- wait-for with stable (seconds of no output) is more reliable than pattern matching across different CLI providers.
- Editor panes show "Loading..." until the tab is visited in the browser. When screenshotting multiple tabs, visit each tab first (select-tab), then loop back for screenshots.
- Browser pane screenshots: proxied localhost URLs render actual content in the iframe. Truly cross-origin URLs (e.g. https://example.com) render a placeholder with the source URL instead of a blank region.
- Freshell has a 50 PTY limit. Scripted runs accumulate orphan terminals silently. Clean up with list-terminals and kill unneeded tabs/panes.

## tmux compatibility

tmux aliases are supported: new-window/new-session -> new-tab, list-windows -> list-tabs, select-window -> select-tab, kill-window -> kill-tab, rename-window -> rename-tab, next-window -> next-tab, previous-window/prev-window -> prev-tab, split-window -> split-pane, display-message -> display.

Key differences from tmux: HTTP transport (not local socket), multiple pane types (not terminal-only), ID/title/index target resolution (not tmux session:window.pane grammar), browser-first and remote-friendly.

Use action "help" for the full command reference with params, examples, and playbooks.`

export const INPUT_SCHEMA = {
  action: z.string().describe(
    'Command: help, new-tab, list-tabs, select-tab, kill-tab, rename-tab, '
    + 'split-pane, list-panes, select-pane, kill-pane, send-keys, capture-pane, '
    + 'wait-for, screenshot, run, health, ...',
  ),
  params: z.record(z.string(), z.unknown()).optional().describe(
    'Named parameters for the action. Common: target, name, mode, direction, keys, url, scope',
  ),
}

// ---------------------------------------------------------------------------
// Envelope unwrapping helper
// ---------------------------------------------------------------------------

/**
 * Extract the payload from an API response that may be a { status, data, message } envelope.
 * The HTTP client now returns the full envelope to preserve status/message for callers.
 * Internal helpers that need the data payload should call this.
 */
function unwrapData(res: any): any {
  if (res && typeof res === 'object' && 'data' in res && res.data != null) {
    return res.data
  }
  return res
}

// ---------------------------------------------------------------------------
// Caller identity: the MCP server is spawned per-terminal, inheriting the
// terminal's FRESHELL_TAB_ID and FRESHELL_PANE_ID. When no target is given,
// default to the caller's own tab/pane -- not the user's active viewport.
// ---------------------------------------------------------------------------

function callerTabId(): string | undefined {
  return process.env.FRESHELL_TAB_ID || undefined
}

function callerPaneId(): string | undefined {
  return process.env.FRESHELL_PANE_ID || undefined
}

// ---------------------------------------------------------------------------
// Target resolution helpers (mirrors CLI's resolveTabTarget / resolvePaneTarget)
// ---------------------------------------------------------------------------

type TabSummary = { id: string; title?: string; activePaneId?: string }
type PaneSummary = { id: string; index?: number; kind?: string; terminalId?: string; title?: string }

async function fetchTabs(): Promise<{ tabs: TabSummary[]; activeTabId?: string }> {
  const res = await client().get('/api/tabs')
  const data = unwrapData(res)
  const obj = data && typeof data === 'object' ? data : {}
  const tabs = (obj.tabs || []) as TabSummary[]
  const activeTabId = obj.activeTabId ?? undefined
  return { tabs, activeTabId }
}

async function fetchPanes(tabId?: string): Promise<PaneSummary[]> {
  const query = tabId ? `?tabId=${encodeURIComponent(tabId)}` : ''
  const res = await client().get(`/api/panes${query}`)
  const data = unwrapData(res)
  const obj = data && typeof data === 'object' ? data : {}
  return (obj.panes || []) as PaneSummary[]
}

async function resolveTabTarget(target?: string): Promise<{ tab?: TabSummary; message?: string }> {
  const { tabs, activeTabId } = await fetchTabs()
  if (!tabs.length) return { message: 'no tabs' }
  if (!target) {
    // Prefer the caller's own tab over the user's active viewport tab
    const ownTabId = callerTabId()
    const defaultTabId = ownTabId || activeTabId
    const tab = tabs.find((t) => t.id === defaultTabId) || tabs[0]
    return { tab, message: ownTabId ? 'caller tab used' : 'active tab used' }
  }
  const tab = tabs.find((t) => t.id === target || t.title === target)
  return { tab, message: tab ? undefined : 'tab not found' }
}

async function resolvePaneTarget(target?: string): Promise<{ tab?: TabSummary; pane?: PaneSummary; message?: string }> {
  const { tabs, activeTabId } = await fetchTabs()
  if (!tabs.length) return { message: 'no tabs' }

  if (!target) {
    // Prefer the caller's own tab/pane over the user's active viewport
    const ownTabId = callerTabId()
    const ownPaneId = callerPaneId()
    const defaultTabId = ownTabId || activeTabId
    const fallbackTab = tabs.find((t) => t.id === defaultTabId) || tabs[0]
    const panes = await fetchPanes(fallbackTab.id)
    // If we know our own pane ID, use it; otherwise fall back to the tab's active pane
    const pane = (ownPaneId && panes.find((p) => p.id === ownPaneId))
      || panes.find((p) => p.id === fallbackTab.activePaneId)
      || panes[0]
    return { tab: fallbackTab, pane }
  }

  // Bare numeric index: resolve within the caller's tab (or active tab as fallback).
  const isBareIndex = /^\d+$/.test(target)
  if (isBareIndex) {
    const ownTabId = callerTabId()
    const defaultTabId = ownTabId || activeTabId
    const contextTab = tabs.find((t) => t.id === defaultTabId) || tabs[0]
    const panes = await fetchPanes(contextTab.id)
    const pane = panes.find((p) => String(p.index) === target)
    if (pane) return { tab: contextTab, pane }
    return { message: 'pane not found' }
  }

  // Non-numeric target (pane ID, UUID, etc.): search across all tabs by ID first, then by title
  const titleMatches: { tab: TabSummary; pane: PaneSummary }[] = []
  for (const tab of tabs) {
    const panes = await fetchPanes(tab.id)
    const paneById = panes.find((p) => p.id === target)
    if (paneById) return { tab, pane: paneById }
    // Collect all title matches to detect ambiguity (matches CLI: server/cli/targets.ts:68)
    for (const pane of panes) {
      if (pane.title === target) {
        titleMatches.push({ tab, pane })
      }
    }
  }

  if (titleMatches.length === 1) return titleMatches[0]
  if (titleMatches.length > 1) {
    return { message: `pane target is ambiguous; use the pane ID directly (e.g. ${titleMatches.map(m => `"${m.pane.id}"`).join(' or ')})` }
  }

  return { message: 'pane not found' }
}

// ---------------------------------------------------------------------------
// Display format-string expansion (mirrors CLI's handleDisplay)
// ---------------------------------------------------------------------------

async function handleDisplay(format: string, target?: string): Promise<string> {
  const resolved = await resolvePaneTarget(target)
  const tab = resolved.tab
  const pane = resolved.pane

  const values: Record<string, string> = {
    tab_name: tab?.title || 'N/A',
    tab_id: tab?.id || 'N/A',
    pane_id: pane?.id || 'N/A',
    pane_index: pane?.index !== undefined ? String(pane.index) : 'N/A',
    terminal_id: pane?.terminalId || 'N/A',
    pane_type: pane?.kind || 'N/A',
  }

  return format
    .replace(/#S/g, values.tab_name)
    .replace(/#I/g, values.tab_id)
    .replace(/#P/g, values.pane_id)
    .replace(/#\{([^}]+)\}/g, (_match, token) => values[token] ?? 'N/A')
}

// ---------------------------------------------------------------------------
// Parameter validation: known params per action
// ---------------------------------------------------------------------------

const ACTION_PARAMS: Record<string, { required: string[]; optional: string[] }> = {
  'new-tab':         { required: [],                          optional: ['name', 'mode', 'shell', 'cwd', 'browser', 'editor', 'resume', 'prompt'] },
  'list-tabs':       { required: [],                          optional: [] },
  'select-tab':      { required: ['target'],                  optional: [] },
  'kill-tab':        { required: ['target'],                  optional: [] },
  'rename-tab':      { required: ['target', 'name'],          optional: [] },
  'has-tab':         { required: ['target'],                  optional: [] },
  'next-tab':        { required: [],                          optional: [] },
  'prev-tab':        { required: [],                          optional: [] },
  'split-pane':      { required: [],                          optional: ['target', 'direction', 'mode', 'shell', 'cwd', 'browser', 'editor'] },
  'list-panes':      { required: [],                          optional: ['target'] },
  'select-pane':     { required: ['target'],                  optional: [] },
  'rename-pane':     { required: ['target', 'name'],          optional: [] },
  'kill-pane':       { required: ['target'],                  optional: [] },
  'resize-pane':     { required: ['target'],                  optional: ['x', 'y', 'sizes'] },
  'swap-pane':       { required: ['target', 'with'],          optional: [] },
  'respawn-pane':    { required: ['target'],                  optional: ['mode', 'shell', 'cwd'] },
  'send-keys':       { required: [],                          optional: ['target', 'keys', 'literal'] },
  'capture-pane':    { required: [],                          optional: ['target', 'S', 'J', 'e'] },
  'wait-for':        { required: [],                          optional: ['target', 'pattern', 'stable', 'exit', 'prompt', 'timeout'] },
  'run':             { required: ['command'],                 optional: ['capture', 'detached', 'timeout', 'name', 'cwd'] },
  'summarize':       { required: [],                          optional: ['target'] },
  'display':         { required: [],                          optional: ['target', 'format'] },
  'list-terminals':  { required: [],                          optional: [] },
  'attach':          { required: ['target', 'terminalId'],    optional: [] },
  'open-browser':    { required: ['url'],                     optional: ['name'] },
  'navigate':        { required: ['target', 'url'],           optional: [] },
  'screenshot':      { required: ['scope'],                   optional: ['target', 'name'] },
  'list-sessions':   { required: [],                          optional: [] },
  'search-sessions': { required: ['query'],                   optional: [] },
  'lan-info':        { required: [],                          optional: [] },
  'health':          { required: [],                          optional: [] },
  'help':            { required: [],                          optional: [] },
}

const COMMON_CONFUSIONS: Record<string, Record<string, string>> = {
  'new-tab': {
    url: "Unknown parameter 'url' for action 'new-tab'. Did you mean to use 'open-browser' to open a URL? Or pass the URL as 'browser' to create a browser pane in a new tab.",
  },
}

function validateParams(action: string, params: Record<string, unknown> | undefined): { error: string; hint: string } | null {
  const schema = ACTION_PARAMS[action]
  if (!schema) return null

  const allValid = [...schema.required, ...schema.optional]
  const givenKeys = Object.keys(params || {})
  const unknownKeys = givenKeys.filter(k => !allValid.includes(k))

  if (unknownKeys.length === 0) return null

  const specificHint = COMMON_CONFUSIONS[action]
  for (const key of unknownKeys) {
    if (specificHint?.[key]) {
      return { error: specificHint[key], hint: `Valid params for '${action}': ${allValid.join(', ') || '(none)'}` }
    }
  }

  return {
    error: `Unknown parameter${unknownKeys.length > 1 ? 's' : ''} '${unknownKeys.join("', '")}' for action '${action}'.`,
    hint: `Valid params: ${allValid.join(', ') || '(none)'}`,
  }
}

// ---------------------------------------------------------------------------
// Action router
// ---------------------------------------------------------------------------

const HELP_TEXT = `Freshell MCP tool -- full reference

## Command reference

Tab commands:
  new-tab         Create a tab with a terminal pane (default). Params: name?, mode?, shell?, cwd?, browser?, editor?, resume?, prompt?
                  mode values: shell (default), claude, codex, kimi, opencode, or any supported CLI.
                  prompt: text to send to the terminal after creation (via send-keys with literal mode).
                  To open a URL in a browser pane, use 'open-browser' instead.
  list-tabs       List all tabs. Returns { tabs: [...], activeTabId }.
  select-tab      Activate a tab. Params: target (tab ID or title)
  kill-tab        Close a tab. Params: target
  rename-tab      Rename a tab. Params: target, name
  has-tab         Check if a tab exists. Params: target
  next-tab        Switch to the next tab.
  prev-tab        Switch to the previous tab.

Pane commands:
  split-pane      Split a pane. Params: target?, direction (horizontal|vertical), mode?, shell?, cwd?, browser?, editor?
                  Omit target to split the active pane. Returns { paneId, tabId }.
  list-panes      List panes. Params: target? (tab ID or title to filter by). Returns { panes: [...] }.
  select-pane     Activate a pane. Params: target (pane ID or index)
  kill-pane       Close a pane. Params: target
  rename-pane     Rename a pane. Params: target, name
  resize-pane     Resize a pane. Params: target, x? (1-99), y? (1-99)
  swap-pane       Swap two panes. Params: target, with (other pane ID)
  respawn-pane    Restart a pane's terminal. Params: target, mode?, shell?, cwd?

Terminal I/O:
  send-keys       Send input to a pane. Params: target, keys, literal?
                  Token mode (default): keys=["ls","ENTER"] translates ENTER to \\r, C-C to Ctrl-C, etc.
                  Literal mode: keys="your prompt text here", literal=true sends raw string.
                  IMPORTANT: Always use literal mode for natural-language prompts or multi-word text.
  capture-pane    Capture pane output as text. Params: target, S? (start line, negative for scrollback), J? (join wrapped), e? (escape sequences)
  wait-for        Wait for a condition in pane output. Params: target, pattern?, stable?, exit?, prompt?, timeout?
                  stable: seconds of no new output (most reliable across CLI providers).
                  exit: wait for the process to exit.
                  prompt: wait for a shell prompt.
                  timeout: max seconds to wait (default varies by server config).
  run             Run a command in a new tab. Params: command, capture?, detached?, timeout?, name?, cwd?
  summarize       Get AI summary of a terminal. Params: target (pane ID)
  display         Format info about a pane. Params: target?, format (#S=tab name, #P=pane ID, #I=tab ID, #{pane_index}, #{terminal_id}, #{pane_type})
  list-terminals  List all terminal processes.
  attach          Attach a terminal to a pane. Params: target (pane ID), terminalId

Browser/navigation:
  open-browser    Open a URL in a new browser tab to display web pages or images.
                  Params: url (required), name? (optional)
  navigate        Navigate an existing browser pane to a URL. Params: target (pane ID), url

Screenshot:
  screenshot      Take a screenshot. Params: scope (pane|tab|view), target?, name? (defaults to "screenshot")
                  scope=pane: captures a single pane. target is pane ID/index/title.
                  scope=tab: captures the full tab. target is tab ID/title.
                  scope=view: captures the entire app viewport. No target needed.

Session/service:
  list-sessions   List visible coding CLI sessions.
  search-sessions Search sessions. Params: query
  health          Check server health.
  lan-info        Show LAN access information.

Meta:
  help            Show this reference.

## Playbook: create a coding CLI tab and send a prompt

  // Create tab with mode to skip the picker pane
  result = freshell({ action: "new-tab", params: { name: "My Task", mode: "claude", cwd: "/path/to/repo" } })
  // result contains { status: "ok", data: { tabId, paneId } }
  paneId = result.data.paneId

  // Send prompt in literal mode
  freshell({ action: "send-keys", params: { target: paneId, keys: "Implement the feature described in SPEC.md", literal: true } })
  freshell({ action: "send-keys", params: { target: paneId, keys: ["ENTER"] } })

  // Wait for completion (stable = 8 seconds of silence)
  freshell({ action: "wait-for", params: { target: paneId, stable: 8, timeout: 1800 } })

  // Capture output
  freshell({ action: "capture-pane", params: { target: paneId, S: -120 } })

## Playbook: parallel coding panes in one tab

  seed = freshell({ action: "new-tab", params: { name: "Eval x4", mode: "claude", cwd: "/path/to/repo" } })
  p0 = seed.data.paneId

  p1 = freshell({ action: "split-pane", params: { target: p0, mode: "claude", cwd: "/path/to/repo" } }).data.paneId
  p2 = freshell({ action: "split-pane", params: { target: p0, direction: "vertical", mode: "claude", cwd: "/path/to/repo" } }).data.paneId
  p3 = freshell({ action: "split-pane", params: { target: p1, direction: "vertical", mode: "claude", cwd: "/path/to/repo" } }).data.paneId

  // Send same prompt to all 4 panes, wait, capture
  for each paneId in [p0, p1, p2, p3]:
    freshell({ action: "send-keys", params: { target: paneId, keys: "Implement <task>. Run tests.", literal: true } })
    freshell({ action: "send-keys", params: { target: paneId, keys: ["ENTER"] } })
  for each paneId in [p0, p1, p2, p3]:
    freshell({ action: "wait-for", params: { target: paneId, stable: 8, timeout: 1800 } })
    freshell({ action: "capture-pane", params: { target: paneId, S: -120 } })

## Playbook: open file in editor pane

  // New tab with editor
  freshell({ action: "new-tab", params: { name: "Edit README", editor: "/absolute/path/to/README.md" } })

  // Or split an existing pane
  freshell({ action: "split-pane", params: { editor: "/absolute/path/to/file.ts" } })

## Playbook: open a URL in a browser pane

  // Open a URL in a new browser tab (correct way)
  freshell({ action: "open-browser", params: { url: "https://example.com", name: "My Page" } })

  // Navigate an existing browser pane to a different URL
  freshell({ action: "navigate", params: { target: paneId, url: "https://other.com" } })


## Screenshot guidance

- Use a dedicated canary tab when validating screenshot behavior so live project panes are not contaminated.
- Close temporary tabs/panes after verification unless user asked to keep them open.
- Browser panes: proxied localhost URLs render actual content in the iframe screenshot. Truly cross-origin URLs (e.g. https://example.com) render a placeholder message with the source URL instead of a blank region.
- Editor panes show "Loading..." until visited. When screenshotting multiple tabs, visit each tab once first (select-tab), then loop back for screenshots.

## Gotchas

- Always use literal: true with send-keys for natural-language prompts or multi-word text.
- wait-for with stable (seconds of no output) is usually more reliable than pattern matching across different CLI providers.
- Freshell has a 50 PTY limit. Scripted runs accumulate orphan terminals silently. Use list-terminals and clean up with kill-tab/kill-pane.
- Picker panes are transient -- a new tab without mode/browser/editor starts as a picker. Always specify mode/browser/editor to get a usable pane immediately.
- If target resolution fails, run list-tabs and list-panes, then retry with explicit IDs.

## tmux aliases

These tmux action names are supported as aliases:
  new-window, new-session -> new-tab
  list-windows -> list-tabs
  select-window -> select-tab
  kill-window -> kill-tab
  rename-window -> rename-tab
  next-window -> next-tab
  previous-window, prev-window -> prev-tab
  split-window -> split-pane
  display-message -> display`

function requireParam(params: Record<string, unknown> | undefined, name: string): string {
  const value = params?.[name]
  if (value === undefined || value === null || value === '') {
    throw new MissingParamError(name)
  }
  return String(value)
}

class MissingParamError extends Error {
  constructor(public paramName: string) {
    super(`Missing required parameter: '${paramName}'`)
  }
}

export async function executeAction(
  action: string,
  params?: Record<string, unknown>,
): Promise<any> {
  try {
    const paramError = validateParams(action, params)
    if (paramError) return paramError
    return await routeAction(action, params)
  } catch (err: any) {
    if (err instanceof MissingParamError) {
      return { error: err.message, hint: `Run action 'help' to see required parameters for '${action}'.` }
    }
    return {
      error: `Action '${action}' failed: ${err.message || err}`,
      hint: 'Check that the Freshell server is running and FRESHELL_URL/FRESHELL_TOKEN are set correctly.',
    }
  }
}

async function routeAction(
  action: string,
  params?: Record<string, unknown>,
): Promise<any> {
  const c = client()

  switch (action) {
    // -- Tab actions --
    case 'new-tab': {
      const { name, mode, shell, cwd, browser, editor, resume, prompt, ...rest } = params || {}
      const tabResult = await c.post('/api/tabs', { name, mode, shell, cwd, browser, editor, resumeSessionId: resume, ...rest })
      // Send prompt text to the newly created pane (mirrors CLI behavior: server/cli/index.ts:318)
      if (prompt) {
        const data = unwrapData(tabResult)
        const paneId = data?.paneId
        if (paneId) {
          await c.post(`/api/panes/${encodeURIComponent(paneId)}/send-keys`, { data: `${prompt}\r` })
        }
      }
      return tabResult
    }
    case 'list-tabs':
      return c.get('/api/tabs')
    case 'select-tab': {
      const target = requireParam(params, 'target')
      const { tab } = await resolveTabTarget(target)
      if (!tab) return { error: `Tab '${target}' not found`, hint: "Run action 'list-tabs' to see available tabs." }
      return c.post(`/api/tabs/${encodeURIComponent(tab.id)}/select`, {})
    }
    case 'kill-tab': {
      const target = requireParam(params, 'target')
      const { tab } = await resolveTabTarget(target)
      if (!tab) return { error: `Tab '${target}' not found`, hint: "Run action 'list-tabs' to see available tabs." }
      return c.delete(`/api/tabs/${encodeURIComponent(tab.id)}`)
    }
    case 'rename-tab': {
      const target = requireParam(params, 'target')
      const name = requireParam(params, 'name')
      const { tab } = await resolveTabTarget(target)
      if (!tab) return { error: `Tab '${target}' not found`, hint: "Run action 'list-tabs' to see available tabs." }
      return c.patch(`/api/tabs/${encodeURIComponent(tab.id)}`, { name })
    }
    case 'has-tab': {
      const target = requireParam(params, 'target')
      return c.get(`/api/tabs/has?target=${encodeURIComponent(target)}`)
    }
    case 'next-tab':
      return c.post('/api/tabs/next', {})
    case 'prev-tab':
      return c.post('/api/tabs/prev', {})

    // -- Pane actions --
    case 'split-pane': {
      const rawTarget = params?.target as string | undefined
      let paneId: string
      if (rawTarget) {
        paneId = rawTarget
      } else {
        // Resolve to active pane (same fallback as CLI)
        const resolved = await resolvePaneTarget(undefined)
        if (!resolved.pane) return { error: 'No active pane found', hint: "Run action 'list-panes' to see available panes." }
        paneId = resolved.pane.id
      }
      const { direction, browser, editor, mode, shell, cwd, target: _t, ...rest } = params || {}
      return c.post(`/api/panes/${encodeURIComponent(paneId)}/split`, {
        direction, browser, editor, mode, shell, cwd, ...rest,
      })
    }
    case 'list-panes': {
      const target = params?.target as string | undefined
      if (target) {
        const { tab } = await resolveTabTarget(target)
        if (!tab) return { error: `Tab '${target}' not found`, hint: "Run action 'list-tabs' to see available tabs." }
        return c.get(`/api/panes?tabId=${encodeURIComponent(tab.id)}`)
      }
      return c.get('/api/panes')
    }
    case 'select-pane': {
      const target = requireParam(params, 'target')
      return c.post(`/api/panes/${encodeURIComponent(target)}/select`, {})
    }
    case 'rename-pane': {
      const target = requireParam(params, 'target')
      const name = requireParam(params, 'name')
      return c.patch(`/api/panes/${encodeURIComponent(target)}`, { name })
    }
    case 'kill-pane': {
      const target = requireParam(params, 'target')
      return c.post(`/api/panes/${encodeURIComponent(target)}/close`, {})
    }
    case 'resize-pane': {
      const target = requireParam(params, 'target')
      const { x, y, sizes, ...rest } = params || {}
      return c.post(`/api/panes/${encodeURIComponent(target)}/resize`, { x, y, sizes, ...rest })
    }
    case 'swap-pane': {
      const target = requireParam(params, 'target')
      const other = params?.with as string
      if (!other) throw new MissingParamError('with')
      return c.post(`/api/panes/${encodeURIComponent(target)}/swap`, { target: other })
    }
    case 'respawn-pane': {
      const target = requireParam(params, 'target')
      const { mode, shell, cwd } = params || {}
      return c.post(`/api/panes/${encodeURIComponent(target)}/respawn`, { mode, shell, cwd })
    }

    // -- Terminal I/O --
    case 'send-keys': {
      const rawTarget = params?.target as string | undefined
      const resolved = await resolvePaneTarget(rawTarget)
      if (!resolved.pane) return { error: resolved.message || 'pane not found', hint: "Run action 'list-panes' to see available panes." }
      const paneId = resolved.pane.id
      const keys = params?.keys
      const literal = params?.literal
      let data: string
      if (literal && typeof keys === 'string') {
        // Literal mode: send raw string
        data = keys
      } else if (Array.isArray(keys)) {
        // Token mode: translate key tokens
        data = translateKeys(keys.map(String))
      } else if (typeof keys === 'string') {
        // Single token (backwards compat)
        data = translateKeys([keys])
      } else {
        throw new MissingParamError('keys')
      }
      return c.post(`/api/panes/${encodeURIComponent(paneId)}/send-keys`, { data })
    }
    case 'capture-pane': {
      const rawTarget = params?.target as string | undefined
      const resolved = await resolvePaneTarget(rawTarget)
      if (!resolved.pane) return { error: resolved.message || 'pane not found', hint: "Run action 'list-panes' to see available panes." }
      const paneId = resolved.pane.id
      const queryParts: string[] = []
      if (params?.S !== undefined) queryParts.push(`S=${encodeURIComponent(String(params.S))}`)
      if (params?.J) queryParts.push('J=true')
      if (params?.e) queryParts.push('e=true')
      const qs = queryParts.length ? `?${queryParts.join('&')}` : ''
      const output = await c.get(`/api/panes/${encodeURIComponent(paneId)}/capture${qs}`)
      return typeof output === 'string' ? output : output
    }
    case 'wait-for': {
      const rawTarget = params?.target as string | undefined
      const resolved = await resolvePaneTarget(rawTarget)
      if (!resolved.pane) return { error: resolved.message || 'pane not found', hint: "Run action 'list-panes' to see available panes." }
      const paneId = resolved.pane.id
      const queryParts: string[] = []
      if (params?.pattern) queryParts.push(`pattern=${encodeURIComponent(String(params.pattern))}`)
      if (params?.stable) queryParts.push(`stable=${encodeURIComponent(String(params.stable))}`)
      if (params?.exit) queryParts.push('exit=true')
      if (params?.prompt) queryParts.push('prompt=true')
      if (params?.timeout) queryParts.push(`T=${encodeURIComponent(String(params.timeout))}`)
      const qs = queryParts.length ? `?${queryParts.join('&')}` : ''
      return c.get(`/api/panes/${encodeURIComponent(paneId)}/wait-for${qs}`)
    }
    case 'run': {
      const command = requireParam(params, 'command')
      const { capture, detached, timeout, name, cwd } = params || {}
      return c.post('/api/run', { command, capture, detached, timeout, name, cwd })
    }
    case 'summarize': {
      const target = params?.target as string | undefined
      const resolved = await resolvePaneTarget(target)
      if (resolved.message && !resolved.pane) {
        return { error: resolved.message, hint: 'Provide a valid pane target (pane ID or unique title).' }
      }
      if (!resolved.pane?.terminalId) {
        return { error: 'terminal not found for target', hint: 'Provide a valid pane target.' }
      }
      return c.post(`/api/ai/terminals/${encodeURIComponent(resolved.pane.terminalId)}/summary`, {})
    }
    case 'display': {
      const format = params?.format as string
      if (!format) throw new MissingParamError('format')
      const target = params?.target as string | undefined
      return await handleDisplay(format, target)
    }
    case 'list-terminals':
      return c.get('/api/terminals')
    case 'attach': {
      const target = requireParam(params, 'target')
      const terminalId = requireParam(params, 'terminalId')
      return c.post(`/api/panes/${encodeURIComponent(target)}/attach`, { terminalId })
    }

    // -- Browser --
    case 'open-browser': {
      const url = requireParam(params, 'url')
      const name = params?.name as string | undefined
      return c.post('/api/tabs', { name, browser: url })
    }
    case 'navigate': {
      const target = requireParam(params, 'target')
      const url = requireParam(params, 'url')
      return c.post(`/api/panes/${encodeURIComponent(target)}/navigate`, { url })
    }

    // -- Screenshot --
    case 'screenshot': {
      const scope = requireParam(params, 'scope') as 'pane' | 'tab' | 'view'
      const name = (params?.name as string) || 'screenshot'
      const target = params?.target as string | undefined
      const body: Record<string, unknown> = { scope, name }

      if (scope === 'pane') {
        // Always resolve target through resolvePaneTarget (handles IDs, indices, and active-pane fallback)
        const resolved = await resolvePaneTarget(target || undefined)
        if (resolved.message && !resolved.pane) return { error: resolved.message, hint: "Run action 'list-panes' to see available panes." }
        if (!resolved.pane) return { error: target ? `Pane '${target}' not found` : 'No active pane found', hint: "Run action 'list-panes' to see available panes." }
        body.paneId = resolved.pane.id
        if (resolved.tab) body.tabId = resolved.tab.id
      } else if (scope === 'tab') {
        if (target) {
          const { tab } = await resolveTabTarget(target)
          if (!tab) return { error: `Tab '${target}' not found`, hint: "Run action 'list-tabs' to see available tabs." }
          body.tabId = tab.id
        } else {
          // Resolve to active tab
          const { tab } = await resolveTabTarget(undefined)
          if (!tab) return { error: 'No active tab found', hint: "Run action 'list-tabs' to see available tabs." }
          body.tabId = tab.id
        }
      }
      // scope === 'view' -> no ID needed

      return c.post('/api/screenshots', body)
    }

    // -- Session --
    case 'list-sessions':
      return c.get('/api/session-directory?priority=visible')
    case 'search-sessions': {
      const query = requireParam(params, 'query')
      return c.get(`/api/session-directory?priority=visible&query=${encodeURIComponent(query)}`)
    }

    // -- Info --
    case 'lan-info':
      return c.get('/api/lan-info')

    // -- Meta --
    case 'health':
      return c.get('/api/health')
    case 'help':
      return HELP_TEXT

    default: {
      // tmux alias resolution (mirrors CLI: server/cli/index.ts aliases)
      const TMUX_ALIASES: Record<string, string> = {
        'new-window': 'new-tab',
        'new-session': 'new-tab',
        'list-windows': 'list-tabs',
        'select-window': 'select-tab',
        'kill-window': 'kill-tab',
        'rename-window': 'rename-tab',
        'next-window': 'next-tab',
        'previous-window': 'prev-tab',
        'prev-window': 'prev-tab',
        'split-window': 'split-pane',
        'display-message': 'display',
        'screenshot-pane': 'screenshot',
        'screenshot-tab': 'screenshot',
        'screenshot-view': 'screenshot',
      }
      const resolved = TMUX_ALIASES[action]
      if (resolved) {
        // For screenshot aliases, inject scope from the alias name
        if (action.startsWith('screenshot-')) {
          const scope = action.replace('screenshot-', '')
          return routeAction(resolved, { ...params, scope })
        }
        return routeAction(resolved, params)
      }
      return {
        error: `Unknown action '${action}'. Run action 'help' for available commands.`,
        hint: 'Valid actions include: new-tab, list-tabs, send-keys, capture-pane, screenshot, help, ...',
      }
    }
  }
}
