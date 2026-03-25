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

export const INSTRUCTIONS = `Freshell is a browser-accessible terminal multiplexer. Tabs contain pane trees. Panes contain terminals.

FRESHELL_URL and FRESHELL_TOKEN are already set in your environment.

Workflow pattern: new-tab -> send-keys -> wait-for -> capture-pane

Use "help" action for full command reference.`

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
    const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0]
    return { tab: activeTab, message: 'active tab used' }
  }
  const tab = tabs.find((t) => t.id === target || t.title === target)
  return { tab, message: tab ? undefined : 'tab not found' }
}

async function resolvePaneTarget(target?: string): Promise<{ tab?: TabSummary; pane?: PaneSummary; message?: string }> {
  const { tabs, activeTabId } = await fetchTabs()
  if (!tabs.length) return { message: 'no tabs' }

  if (!target) {
    const fallbackTab = tabs.find((t) => t.id === activeTabId) || tabs[0]
    const panes = await fetchPanes(fallbackTab.id)
    const pane = panes.find((p) => p.id === fallbackTab.activePaneId) || panes[0]
    return { tab: fallbackTab, pane }
  }

  // Bare numeric index: resolve within the active/first tab only (matches CLI semantics).
  // CLI's resolveTarget in server/cli/targets.ts resolves bare numbers against the active tab.
  const isBareIndex = /^\d+$/.test(target)
  if (isBareIndex) {
    const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0]
    const panes = await fetchPanes(activeTab.id)
    const pane = panes.find((p) => String(p.index) === target)
    if (pane) return { tab: activeTab, pane }
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
// Action router
// ---------------------------------------------------------------------------

const HELP_TEXT = `Freshell MCP tool -- command reference

Tab commands:
  new-tab         Create a tab. Params: name?, mode?, shell?, cwd?, browser?, editor?, resume?
  list-tabs       List all tabs.
  select-tab      Activate a tab. Params: target (tab ID or title)
  kill-tab        Close a tab. Params: target
  rename-tab      Rename a tab. Params: target, name
  has-tab         Check if a tab exists. Params: target
  next-tab        Switch to the next tab.
  prev-tab        Switch to the previous tab.

Pane commands:
  split-pane      Split a pane. Params: target?, direction (horizontal|vertical), mode?, shell?, cwd?, browser?, editor?
  list-panes      List panes. Params: target? (tab ID to filter by)
  select-pane     Activate a pane. Params: target (pane ID or index)
  kill-pane       Close a pane. Params: target
  rename-pane     Rename a pane. Params: target, name
  resize-pane     Resize a pane. Params: target, x? (1-99), y? (1-99)
  swap-pane       Swap two panes. Params: target, with (other pane ID)
  respawn-pane    Restart a pane's terminal. Params: target, mode?, shell?, cwd?

Terminal I/O:
  send-keys       Send input to a pane. Params: target, keys (array of tokens or string), literal? (boolean)
                  Token mode (default): keys=["ls","ENTER"] -> translates ENTER to \\r, C-C to Ctrl-C, etc.
                  Literal mode: keys="echo hello\\n", literal=true -> sends raw string.
  capture-pane    Capture pane output as text. Params: target
  wait-for        Wait for a pattern in pane output. Params: target, pattern?, stable?, exit?, prompt?, timeout?
  run             Run a command in a new tab. Params: command, capture?, detached?, timeout?, name?, cwd?
  summarize       Get AI summary of a terminal. Params: target (pane ID)
  display         Format info about a pane. Params: target?, format (#S=tab name, #P=pane ID, #I=tab ID)
  list-terminals  List all terminal processes.
  attach          Attach a terminal to a pane. Params: target (pane ID), terminalId

Browser:
  open-browser    Open a URL in a new tab. Params: url, name?
  navigate        Navigate a browser pane to a URL. Params: target (pane ID), url

Screenshot:
  screenshot      Take a screenshot. Params: scope (pane|tab|view), target?, name? (defaults to "screenshot")

Session:
  list-sessions   List visible sessions.
  search-sessions Search sessions. Params: query

Info:
  lan-info        Show LAN access information.

Meta:
  health          Check server health.
  help            Show this reference.`

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
      const target = requireParam(params, 'target')
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
      return c.post(`/api/panes/${encodeURIComponent(target)}/send-keys`, { data })
    }
    case 'capture-pane': {
      const target = requireParam(params, 'target')
      const queryParts: string[] = []
      if (params?.S !== undefined) queryParts.push(`S=${encodeURIComponent(String(params.S))}`)
      if (params?.J) queryParts.push('J=true')
      if (params?.e) queryParts.push('e=true')
      const qs = queryParts.length ? `?${queryParts.join('&')}` : ''
      const output = await c.get(`/api/panes/${encodeURIComponent(target)}/capture${qs}`)
      return typeof output === 'string' ? output : output
    }
    case 'wait-for': {
      const target = requireParam(params, 'target')
      const queryParts: string[] = []
      if (params?.pattern) queryParts.push(`pattern=${encodeURIComponent(String(params.pattern))}`)
      if (params?.stable) queryParts.push(`stable=${encodeURIComponent(String(params.stable))}`)
      if (params?.exit) queryParts.push('exit=true')
      if (params?.prompt) queryParts.push('prompt=true')
      if (params?.timeout) queryParts.push(`T=${encodeURIComponent(String(params.timeout))}`)
      const qs = queryParts.length ? `?${queryParts.join('&')}` : ''
      return c.get(`/api/panes/${encodeURIComponent(target)}/wait-for${qs}`)
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

    default:
      return {
        error: `Unknown action '${action}'. Run action 'help' for available commands.`,
        hint: 'Valid actions include: new-tab, list-tabs, send-keys, capture-pane, screenshot, help, ...',
      }
  }
}
