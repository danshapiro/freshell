/**
 * Freshell MCP tool -- single "freshell" tool with action dispatch (obra pattern).
 *
 * Routes structured { action, params } calls to the Freshell REST API via
 * the MCP HTTP client. This is the core of the MCP server.
 */

import { z } from 'zod'
import { createApiClient, resolveConfig, type ApiClient } from './http-client.js'
import { translateKeys } from '../node-client-runtime/keys.js'
import { INVALID_RAW_CODEX_RESUME_MESSAGE } from '../node-client-runtime/codex-restore-contract.js'
import {
  ACTION_ALIASES,
  resolveCanonicalAction,
  supportedActionCapabilities,
  unsupportedInvocationResult,
} from '../node-client-runtime/action-capabilities.js'

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

const supportedCapabilities = supportedActionCapabilities()
const registeredActionNames = supportedCapabilities.flatMap((capability) => [capability.action, ...(capability.aliases ?? [])])
const actionDescription = supportedCapabilities.map((capability) => capability.action).join(', ')

export const TOOL_DESCRIPTION = `Freshell terminal multiplexer -- orchestrate tabs, panes, and terminals.

Use action dispatch: freshell({ action: "help" }) to see all commands.

Supported actions: ${actionDescription}.

Common params: target (ID or name), name, mode, direction, keys, url, scope.`

export const INSTRUCTIONS = `Freshell is a browser-accessible terminal multiplexer and session organizer.

Use your built-in shell and file tools for general work; reach for this MCP only when a user or a skill explicitly asks you to orchestrate the user's live Freshell session (tabs, panes, demos).

FRESHELL_URL and FRESHELL_TOKEN are already set in your environment.

## Mental model

- Tabs contain pane trees (splits). Panes contain content.
- Pane kinds: terminal, editor, browser, fresh-agent (Claude/Codex/OpenCode/etc.), picker (transient).
- **Picker panes are ephemeral.** A freshly-created tab without mode/browser/editor starts as a picker pane while the user chooses what to launch. Once they select, the picker is replaced by the real pane with a **new pane ID**. Never target a picker pane for splits or mutations -- use mode/browser/editor params on new-tab/split-pane to skip the picker entirely.
- Typical workflow: new-tab -> send-keys -> wait-for -> capture-pane/screenshot.

## Fresh agents (in-app)

- Use new-tab with agent="opencode", optional model=, effort=, cwd=. For direct Claude or Codex terminals, use mode="claude" or mode="codex". Then drive the pane with send-keys and read it with capture-pane. Example:
  new-tab { agent: "opencode", model: "umans-ai-coding-plan/umans-kimi-k2.7", prompt: "Summarize README.md" }

## Choosing the right action

- **split-pane vs new-tab:** When the user says "pane", "split", "alongside", "next to", or "side by side", use split-pane. Use new-tab only when the user explicitly says "tab", "window", or "new [thing]" with no spatial reference. When unsure, split-pane is the safer default -- it keeps work in one tab.
- **split-pane defaults to side-by-side (left/right):** By default, split-pane splits horizontally to create left/right panes. Use direction: "vertical" when you want stacked (top/bottom) panes instead.
- **Prefer specialized pane types:** Do NOT open a terminal to run cat/vim/nano/curl/wget when a dedicated pane type is a better fit.
  - "open/edit/show a file" -> split-pane({ editor: "/absolute/path" }) or new-tab({ editor: "/absolute/path" }). Use the editor pane type for any file that can be displayed as text (source code, markdown, configs, logs, etc.). The editor renders files with syntax highlighting. Only open a terminal to edit a file when you need to run interactive commands; for passive file viewing, prefer the editor pane.
  - "open/show a URL" or "view a webpage" -> split-pane({ browser: "https://..." }) or open-browser({ url: "https://..." })
  - "run a command" or "use a CLI tool" -> split-pane({ mode: "shell" }) or new-tab({ mode: "shell" })
- **Sending text:** Always use literal: true with send-keys for natural-language prompts or multi-word text. Token mode (default) treats special words like ENTER as control sequences and mangles prose. Do NOT append the word "ENTER" as literal text -- use keys: ["ENTER"] as a separate send-keys call instead.

## Targets

- Tab target: tab ID or exact tab title.
- Pane target: pane ID, numeric pane index (scoped to caller's tab), or pane title.
- Omitted target defaults to the caller's own tab and pane (where the MCP server was spawned), NOT the user's active viewport. This means split-pane without a target splits your own pane, not whatever the user is looking at.
- If a target is ambiguous (e.g. duplicate pane titles), the error returns the specific pane IDs to use.
- If target resolution fails, run list-tabs / list-panes and retry with explicit IDs.

## Key gotchas

- **Tab and pane IDs are ephemeral.** IDs from open-browser, new-tab, and split-pane are valid only within the current session. If the Freshell server restarts or the agent conversation resumes after a disconnect, previously returned IDs may no longer exist. Always call open-browser or list-tabs fresh rather than reusing stale IDs.
- **Always screenshot with \`screenshot({ scope: "tab", target: tabId })\` after open-browser.** Network errors, CORS issues, or server problems can cause blank pages. open-browser returns a tabId — use it immediately to screenshot and confirm the page rendered before proceeding.
- send-keys: use literal mode (literal: true + keys as a string) for natural-language prompts or multi-word text. Do NOT append "ENTER" as literal text -- send the command with literal:true, then send ["ENTER"] as a separate call in token mode.
- wait-for requires a literal output pattern; stable, exit, and prompt conditions are not available on the Rust baseline.
- Editor panes show "Loading..." until the tab is visited in the browser. When screenshotting multiple tabs, visit each tab first (select-tab), then loop back for screenshots.
- Browser pane screenshots: proxied localhost URLs render actual content in the iframe. Truly cross-origin URLs (e.g. https://example.com) render a placeholder with the source URL instead of a blank region.
- Freshell has a 50 PTY limit. Scripted runs accumulate orphan terminals silently. Clean up with list-terminals and kill unneeded tabs/panes.

## tmux compatibility

tmux aliases are supported: ${Object.entries(ACTION_ALIASES).map(([alias, action]) => `${alias} -> ${action}`).join(', ')}.

Key differences from tmux: HTTP transport (not local socket), multiple pane types (not terminal-only), ID/title/index target resolution (not tmux session:window.pane grammar), browser-first and remote-friendly.

Use action "help" for the full command reference with params, examples, and playbooks.`

export const INPUT_SCHEMA = {
  action: z.enum(registeredActionNames as [string, ...string[]]).describe(
    `Supported command: ${actionDescription}.`,
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

// The session directory endpoint caps each page at 50 items and returns a
// `nextCursor` to fetch the next page. We follow the cursor and aggregate, but
// bound the number of pages so a huge history can't blow up the token budget.
// 6 pages ~= 300 most-recent sessions.
const SESSION_DIRECTORY_MAX_PAGES = 6

/**
 * Fetch `/api/session-directory?<baseQuery>` and follow `nextCursor` up to
 * `maxPages`, concatenating `items` from every page.
 *
 * Returns `truncated: true` only when it stopped because it hit `maxPages`
 * while the server still had a non-null `nextCursor` (i.e. more sessions exist
 * beyond what we returned).
 */
async function fetchAllSessionDirectoryPages(
  c: ApiClient,
  baseQuery: string,
  maxPages = SESSION_DIRECTORY_MAX_PAGES,
): Promise<{ items: unknown[]; truncated: boolean; pages: number }> {
  const items: unknown[] = []
  let cursor: string | null = null
  let pages = 0
  let truncated = false

  for (;;) {
    const url = cursor
      ? `/api/session-directory?${baseQuery}&cursor=${encodeURIComponent(cursor)}`
      : `/api/session-directory?${baseQuery}`
    const page = unwrapData(await c.get(url)) as { items?: unknown[]; nextCursor?: string | null } | undefined
    pages++
    if (Array.isArray(page?.items)) items.push(...page.items)

    const nextCursor = page?.nextCursor ?? null
    if (!nextCursor) break // No more pages -- fully drained.
    if (pages >= maxPages) {
      truncated = true // More pages remain but we hit the bounded cap.
      break
    }
    cursor = nextCursor
  }

  return { items, truncated, pages }
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
    // Collect all title matches to detect ambiguity (matches CLI target resolution).
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

export const ACTION_PARAMS: Readonly<Record<string, { required: readonly string[]; optional: readonly string[] }>> = Object.freeze(
  Object.fromEntries(supportedCapabilities.map((capability) => [capability.action, capability.params])),
)

const RAW_CODEX_RESUME_HINT = 'Use sessionRef: { provider: "codex", sessionId } after Codex identity is durable.'

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

function isCodexSessionRef(value: unknown): boolean {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { provider?: unknown }).provider === 'codex'
    && typeof (value as { sessionId?: unknown }).sessionId === 'string'
    && (value as { sessionId: string }).sessionId.length > 0
}

function rejectRawCodexResume(
  mode: unknown,
  resume: unknown,
  sessionRef: unknown,
): { error: string; hint: string } | undefined {
  if (mode === 'codex' && typeof resume === 'string' && resume.length > 0 && !isCodexSessionRef(sessionRef)) {
    return {
      error: INVALID_RAW_CODEX_RESUME_MESSAGE,
      hint: RAW_CODEX_RESUME_HINT,
    }
  }
  return undefined
}

// Resume sugar (`resume`/`resumeSessionId`) on the fresh-agent shorthand path
// (agent param, no mode): only opencode maps to a synthesized sessionRef -- it
// is the only provider the REST resume endpoint honors. codex maps to 'codex'
// so the raw-resume refusal above fires with parity to mode=codex. Every other
// value (claude/kilroy/unknown/non-string) returns undefined: no synthesis,
// resume fields keep their dropped behavior, and explicit sessionRef (already
// forwarded for any provider) remains the documented path.
// Accepts unknown because routeAction args are Record<string, unknown>.
function agentResumeProvider(agent: unknown): 'codex' | 'opencode' | undefined {
  if (agent === 'opencode' || agent === 'codex') return agent
  return undefined
}

// ---------------------------------------------------------------------------
// Action router
// ---------------------------------------------------------------------------

const HELP_TEXT = [
  'Freshell MCP tool -- supported Rust-server reference',
  '',
  '## Command reference',
  ...supportedCapabilities.map((capability) => {
    const required = capability.params.required.join(', ')
    const optional = capability.params.optional.map((name) => `${name}?`).join(', ')
    const parameterText = [required, optional].filter(Boolean).join(', ') || '(none)'
    return `  ${capability.action}\tParams: ${parameterText}`
  }),
  '',
  'capture-pane accepts J and e as Rust-compatible no-op parameters.',
  'wait-for requires a literal pattern; stable, exit, and prompt are unavailable.',
  '',
  '## Playbook',
  'Use literal: true with send-keys for natural-language prompts.',
  'create, split, and rename without manual UI interaction using new-tab, split-pane, rename-tab, and rename-pane.',
  "Playbook: open a URL — use 'open-browser' for a new browser tab.",
  '',
  '## Screenshot guidance',
  'Use a canary tab and screenshot it after opening a URL.',
  '',
  '## Gotchas',
  'Freshell has a 50 PTY limit. Picker panes are transient.',
  '',
  '## tmux aliases',
  ...Object.entries(ACTION_ALIASES).map(([alias, action]) => `  ${alias} -> ${action}`),
].join('\n')

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
    const unsupported = unsupportedInvocationResult(action, params)
    if (unsupported) return unsupported
    const canonicalAction = resolveCanonicalAction(action) ?? action
    const effectiveParams = action.startsWith('screenshot-')
      ? { ...params, scope: action.replace('screenshot-', '') }
      : params
    const paramError = validateParams(canonicalAction, effectiveParams)
    if (paramError) return paramError
    return await routeAction(canonicalAction, effectiveParams)
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
      const { name, mode, shell, cwd, browser, editor, resume, resumeSessionId, sessionRef: explicitSessionRef, prompt, ...rest } = params || {}
      // `resumeSessionId` is accepted as an alias for the shorthand `resume` --
      // it's the exact field name the CLI sends and the server itself
      // returns/broadcasts on created panes, so agents naturally reach for it.
      // Both resolve to the canonical sessionRef below; the raw legacy field is
      // never forwarded over the wire.
      const legacyResume = typeof resume === 'string' ? resume : resumeSessionId
      // Provider the resume sugar keys on: an explicit mode wins; otherwise the
      // fresh-agent shorthand contributes one only for the REST-honorable set
      // (opencode synthesizes, codex rejects raw ids; see agentResumeProvider).
      const resumeProvider = mode ?? agentResumeProvider(rest.agent)
      const codexResumeError = rejectRawCodexResume(resumeProvider, legacyResume, explicitSessionRef)
      if (codexResumeError) return codexResumeError
      const sessionRef = explicitSessionRef ?? (typeof resumeProvider === 'string' && resumeProvider !== 'codex' && typeof legacyResume === 'string'
        ? { provider: resumeProvider, sessionId: legacyResume }
        : undefined)
      const tabResult = await c.post('/api/tabs', {
        name,
        mode,
        shell,
        cwd,
        browser,
        editor,
        ...(sessionRef ? { sessionRef } : {}),
        ...rest,
      })
      // Send prompt text to the newly created pane (mirrors CLI behavior).
      if (prompt) {
        const data = unwrapData(tabResult)
        const paneId = data?.paneId
        if (paneId) {
          await c.post(`/api/panes/${encodeURIComponent(paneId)}/send-keys`, {
            data: `${prompt}\r`,
            ...(mode === 'codex' ? { waitForCodexIdentity: true } : {}),
          })
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
      const name = requireParam(params, 'name')
      const target = typeof params?.target === 'string' && params.target.trim().length > 0
        ? params.target
        : undefined
      const { tab } = await resolveTabTarget(target)
      if (!tab) return { error: target ? `Tab '${target}' not found` : 'No active tab found', hint: "Run action 'list-tabs' to see available tabs." }
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
      const resolved = await resolvePaneTarget(rawTarget)
      if (!resolved.pane) return { error: resolved.message || 'No pane found', hint: "Run action 'list-panes' to see available panes." }
      const paneId = resolved.pane.id
      const { direction, browser, editor, mode, shell, cwd, target: _t, resume, sessionRef, ...rest } = params || {}
      const codexResumeError = rejectRawCodexResume(mode, resume, sessionRef)
      if (codexResumeError) return codexResumeError
      const effectiveSessionRef = sessionRef ?? (typeof mode === 'string' && mode !== 'codex' && typeof resume === 'string'
        ? { provider: mode, sessionId: resume }
        : undefined)
      return c.post(`/api/panes/${encodeURIComponent(paneId)}/split`, {
        direction, browser, editor, mode, shell, cwd, ...(effectiveSessionRef ? { sessionRef: effectiveSessionRef } : {}), ...rest,
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
      const name = requireParam(params, 'name')
      const target = typeof params?.target === 'string' && params.target.trim().length > 0
        ? params.target
        : undefined
      const { pane } = await resolvePaneTarget(target)
      if (!pane) return { error: target ? `Pane '${target}' not found` : 'No active pane found', hint: "Run action 'list-panes' to see available panes." }
      return c.patch(`/api/panes/${encodeURIComponent(pane.id)}`, { name })
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
      const { mode, shell, cwd, resume, sessionRef } = params || {}
      const codexResumeError = rejectRawCodexResume(mode, resume, sessionRef)
      if (codexResumeError) return codexResumeError
      const effectiveSessionRef = sessionRef ?? (typeof mode === 'string' && mode !== 'codex' && typeof resume === 'string'
        ? { provider: mode, sessionId: resume }
        : undefined)
      return c.post(`/api/panes/${encodeURIComponent(target)}/respawn`, { mode, shell, cwd, sessionRef: effectiveSessionRef })
    }

    // -- Terminal I/O --
    case 'send-keys': {
      const rawTarget = params?.target as string | undefined
      const resolved = await resolvePaneTarget(rawTarget)
      if (!resolved.pane) return { error: resolved.message || 'pane not found', hint: "Run action 'list-panes' to see available panes." }
      const paneId = resolved.pane.id
      const keys = params?.keys
      const literal = params?.literal
      const sessionRef = params?.sessionRef
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
      return c.post(`/api/panes/${encodeURIComponent(paneId)}/send-keys`, {
        data,
        ...(sessionRef ? { sessionRef } : {}),
      })
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
      const sessionRef = params?.sessionRef
      return c.post(`/api/panes/${encodeURIComponent(target)}/attach`, {
        terminalId,
        ...(sessionRef ? { sessionRef } : {}),
      })
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
    // Both actions follow the server's `nextCursor` and aggregate pages so
    // sessions beyond the first (50-item) page stay visible. `truncated` flags
    // when the bounded page cap was hit while more pages remained.
    case 'list-sessions': {
      const { items, truncated } = await fetchAllSessionDirectoryPages(c, 'priority=visible')
      return { items, count: items.length, truncated }
    }
    case 'search-sessions': {
      const query = requireParam(params, 'query')
      const { items, truncated } = await fetchAllSessionDirectoryPages(c, `priority=visible&query=${encodeURIComponent(query)}`)
      return { items, count: items.length, truncated }
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
      return {
        error: `Unknown action '${action}'. Run action 'help' for available commands.`,
        hint: 'Valid actions include: new-tab, list-tabs, send-keys, capture-pane, screenshot, help, ...',
      }
    }
  }
}
