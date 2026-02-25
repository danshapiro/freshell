#!/usr/bin/env node
import { parseArgs } from './args.js'
import { createHttpClient } from './http.js'
import { writeError, writeJson, writeText } from './output.js'
import { resolveConfig } from './config.js'
import { resolveTarget } from './targets.js'
import { runCommand as sendKeysCommand } from './commands/sendKeys.js'
import { partitionSendKeysArgs } from './send-keys-args.js'

type Flags = Record<string, string | boolean>

type TabSummary = { id: string; title?: string; activePaneId?: string }

type PaneSummary = { id: string; index?: number; kind?: string; terminalId?: string }

const aliases: Record<string, string> = {
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

const aliasNotices: Partial<Record<string, string>> = {
  'new-window': 'new-window maps to new-tab in Freshell (creates a new tab). Use split-pane to create a pane in the current tab.',
  'new-session': 'new-session maps to new-tab in Freshell (creates a new tab). Use split-pane to create a pane in the current tab.',
}

const getFlag = (flags: Flags, ...names: string[]) => {
  for (const name of names) {
    if (flags[name] !== undefined) return flags[name]
  }
  return undefined
}

const isTruthy = (value: unknown) => value === true || value === 'true' || value === '1' || value === 'yes'

const unwrap = (response: any) => (response && typeof response === 'object' && 'data' in response ? response.data : response)

async function fetchTabs(client: ReturnType<typeof createHttpClient>): Promise<{ tabs: TabSummary[]; activeTabId?: string | null }> {
  const res = await client.get('/api/tabs')
  const data = unwrap(res)
  const tabs = (data?.tabs || data || []) as TabSummary[]
  const activeTabId = data?.activeTabId ?? null
  return { tabs, activeTabId }
}

async function fetchPanes(client: ReturnType<typeof createHttpClient>, tabId?: string): Promise<PaneSummary[]> {
  const query = tabId ? `?tabId=${encodeURIComponent(tabId)}` : ''
  const res = await client.get(`/api/panes${query}`)
  const data = unwrap(res)
  return (data?.panes || data || []) as PaneSummary[]
}

async function buildTargetContext(client: ReturnType<typeof createHttpClient>) {
  const { tabs, activeTabId } = await fetchTabs(client)
  const panesByTab: Record<string, string[]> = {}
  const paneInfoById: Record<string, PaneSummary> = {}

  for (const tab of tabs) {
    const panes = await fetchPanes(client, tab.id)
    panesByTab[tab.id] = panes.map((p) => p.id)
    for (const pane of panes) paneInfoById[pane.id] = pane
  }

  return { tabs, panesByTab, paneInfoById, activeTabId: activeTabId || undefined }
}

async function resolvePaneTarget(client: ReturnType<typeof createHttpClient>, target?: string) {
  const { tabs, panesByTab, paneInfoById, activeTabId } = await buildTargetContext(client)
  const effectiveActiveTabId = activeTabId || tabs[0]?.id
  const ctx = { activeTabId: effectiveActiveTabId, panesByTab, tabs }

  if (!target) {
    const fallbackTab = tabs.find((t) => t.id === effectiveActiveTabId) || tabs[0]
    const paneId = fallbackTab?.activePaneId || (fallbackTab ? panesByTab[fallbackTab.id]?.[0] : undefined)
    return { tab: fallbackTab, pane: paneId ? paneInfoById[paneId] : undefined, message: 'active tab used' }
  }

  const resolved = resolveTarget(target, ctx)
  const tab = tabs.find((t) => t.id === resolved.tabId)
  const pane = resolved.paneId ? paneInfoById[resolved.paneId] : undefined
  return { tab, pane, message: resolved.message }
}

async function resolveTabTarget(client: ReturnType<typeof createHttpClient>, target?: string) {
  const { tabs, activeTabId } = await fetchTabs(client)
  if (!tabs.length) return { tab: undefined, message: 'no tabs' }
  if (!target) {
    const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0]
    return { tab: activeTab, message: 'active tab used' }
  }
  const tab = tabs.find((t) => t.id === target || t.title === target)
  return { tab, message: tab ? undefined : 'tab not found' }
}

function formatList(items: string[]) {
  if (!items.length) return ''
  return items.join('\n')
}

async function handleDisplay(format: string, target: string | undefined, client: ReturnType<typeof createHttpClient>) {
  const config = resolveConfig()
  const resolved = await resolvePaneTarget(client, target)
  const tab = resolved.tab
  const pane = resolved.pane

  const values: Record<string, string> = {
    tab_name: tab?.title || 'N/A',
    tab_id: tab?.id || 'N/A',
    pane_id: pane?.id || 'N/A',
    pane_index: pane?.index !== undefined ? String(pane.index) : 'N/A',
    terminal_id: pane?.terminalId || 'N/A',
    pane_type: pane?.kind || 'N/A',
    pane_mode: pane?.kind === 'terminal' ? 'shell' : 'N/A',
    pane_url: 'N/A',
    pane_file: 'N/A',
    server_url: config.url,
  }

  let hadUnknown = false

  const expanded = format
    .replace(/#S/g, values.tab_name)
    .replace(/#I/g, values.tab_id)
    .replace(/#P/g, values.pane_id)
    .replace(/#\{([^}]+)\}/g, (_match, token) => {
      if (values[token] !== undefined) return values[token]
      hadUnknown = true
      return 'N/A'
    })

  if (hadUnknown) writeError('token not supported; returned N/A')
  if (resolved.message) writeError(resolved.message)
  writeText(expanded)
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (!parsed.command) {
    writeError('command required')
    process.exitCode = 1
    return
  }

  const aliasNotice = aliasNotices[parsed.command]
  if (aliasNotice) writeError(aliasNotice)

  const command = aliases[parsed.command] || parsed.command
  const flags = parsed.flags
  const args = parsed.args
  const client = createHttpClient()

  switch (command) {
    case 'new-tab': {
      const name = (getFlag(flags, 'n', 'name', 'title') as string | undefined) || undefined
      const mode = isTruthy(getFlag(flags, 'claude')) ? 'claude'
        : isTruthy(getFlag(flags, 'codex')) ? 'codex'
          : (getFlag(flags, 'mode') as string | undefined) || 'shell'
      const shell = getFlag(flags, 'shell') as string | undefined
      const cwd = getFlag(flags, 'cwd') as string | undefined
      const browser = getFlag(flags, 'browser') as string | undefined
      const editor = getFlag(flags, 'editor') as string | undefined
      const resumeSessionId = getFlag(flags, 'resume') as string | undefined
      const prompt = getFlag(flags, 'prompt') as string | undefined

      const res = await client.post('/api/tabs', { name, mode, shell, cwd, browser, editor, resumeSessionId })
      const data = unwrap(res)
      if (prompt && data?.paneId) {
        await client.post(`/api/panes/${encodeURIComponent(data.paneId)}/send-keys`, { data: `${prompt}\r` })
      }
      writeJson(res)
      return
    }
    case 'list-tabs': {
      const res = await client.get('/api/tabs')
      if (isTruthy(getFlag(flags, 'json'))) {
        writeJson(res)
        return
      }
      const tabs = unwrap(res)?.tabs || []
      const lines = tabs.map((tab: TabSummary) => `${tab.id}\t${tab.title || ''}\t${tab.activePaneId || ''}`)
      writeText(formatList(lines))
      return
    }
    case 'select-tab': {
      const target = (getFlag(flags, 't', 'target', 'tab') as string | undefined) || args[0]
      const { tab, message } = await resolveTabTarget(client, target)
      if (!tab) {
        writeError(message || 'tab not found')
        process.exitCode = 1
        return
      }
      if (message) writeError(message)
      const res = await client.post(`/api/tabs/${encodeURIComponent(tab.id)}/select`, {})
      writeJson(res)
      return
    }
    case 'kill-tab': {
      const target = (getFlag(flags, 't', 'target', 'tab') as string | undefined) || args[0]
      const { tab, message } = await resolveTabTarget(client, target)
      if (!tab) {
        writeError(message || 'tab not found')
        process.exitCode = 1
        return
      }
      if (message) writeError(message)
      const res = await client.delete(`/api/tabs/${encodeURIComponent(tab.id)}`)
      writeJson(res)
      return
    }
    case 'rename-tab': {
      const target = (getFlag(flags, 't', 'target', 'tab') as string | undefined) || args[0]
      const name = (getFlag(flags, 'n', 'name', 'title') as string | undefined) || args[1]
      if (!name) {
        writeError('name required')
        process.exitCode = 1
        return
      }
      const { tab, message } = await resolveTabTarget(client, target)
      if (!tab) {
        writeError(message || 'tab not found')
        process.exitCode = 1
        return
      }
      if (message) writeError(message)
      const res = await client.patch(`/api/tabs/${encodeURIComponent(tab.id)}`, { name })
      writeJson(res)
      return
    }
    case 'has-tab': {
      const target = (getFlag(flags, 't', 'target', 'tab') as string | undefined) || args[0]
      if (!target) {
        writeError('target required')
        process.exitCode = 1
        return
      }
      const res = await client.get(`/api/tabs/has?target=${encodeURIComponent(target)}`)
      writeJson(res)
      return
    }
    case 'next-tab': {
      const res = await client.post('/api/tabs/next', {})
      writeJson(res)
      return
    }
    case 'prev-tab': {
      const res = await client.post('/api/tabs/prev', {})
      writeJson(res)
      return
    }
    case 'split-pane': {
      const target = (getFlag(flags, 't', 'target', 'pane') as string | undefined) || args[0]
      const direction = isTruthy(getFlag(flags, 'v', 'vertical')) ? 'vertical' : 'horizontal'
      const browser = getFlag(flags, 'browser') as string | undefined
      const editor = getFlag(flags, 'editor') as string | undefined
      const mode = getFlag(flags, 'mode') as string | undefined
      const shell = getFlag(flags, 'shell') as string | undefined
      const cwd = getFlag(flags, 'cwd') as string | undefined

      const resolved = await resolvePaneTarget(client, target)
      if (!resolved.pane?.id) {
        writeError(resolved.message || 'pane not found')
        process.exitCode = 1
        return
      }
      if (resolved.message) writeError(resolved.message)
      const res = await client.post(`/api/panes/${encodeURIComponent(resolved.pane.id)}/split`, {
        direction,
        browser,
        editor,
        mode,
        shell,
        cwd,
      })
      writeJson(res)
      return
    }
    case 'list-panes': {
      const target = (getFlag(flags, 't', 'target', 'tab') as string | undefined) || undefined
      let tabId: string | undefined
      if (target) {
        const { tab } = await resolveTabTarget(client, target)
        tabId = tab?.id
      }
      const res = await client.get(tabId ? `/api/panes?tabId=${encodeURIComponent(tabId)}` : '/api/panes')
      if (isTruthy(getFlag(flags, 'json'))) {
        writeJson(res)
        return
      }
      const panes = unwrap(res)?.panes || []
      const lines = panes.map((pane: PaneSummary) => `${pane.id}\t${pane.index ?? ''}\t${pane.kind ?? ''}\t${pane.terminalId ?? ''}`)
      writeText(formatList(lines))
      return
    }
    case 'select-pane': {
      const target = (getFlag(flags, 't', 'target', 'pane') as string | undefined) || args[0]
      const resolved = await resolvePaneTarget(client, target)
      if (!resolved.pane?.id) {
        writeError(resolved.message || 'pane not found')
        process.exitCode = 1
        return
      }
      if (resolved.message) writeError(resolved.message)
      const res = await client.post(`/api/panes/${encodeURIComponent(resolved.pane.id)}/select`, {
        tabId: resolved.tab?.id,
      })
      writeJson(res)
      return
    }
    case 'kill-pane': {
      const target = (getFlag(flags, 't', 'target', 'pane') as string | undefined) || args[0]
      const resolved = await resolvePaneTarget(client, target)
      if (!resolved.pane?.id) {
        writeError(resolved.message || 'pane not found')
        process.exitCode = 1
        return
      }
      if (resolved.message) writeError(resolved.message)
      const res = await client.post(`/api/panes/${encodeURIComponent(resolved.pane.id)}/close`, {})
      writeJson(res)
      return
    }
    case 'resize-pane': {
      const target = (getFlag(flags, 't', 'target', 'pane') as string | undefined) || args[0]
      const x = getFlag(flags, 'x') as string | undefined
      const y = getFlag(flags, 'y') as string | undefined
      const resolved = await resolvePaneTarget(client, target)
      if (!resolved.pane?.id) {
        writeError(resolved.message || 'pane not found')
        process.exitCode = 1
        return
      }
      const res = await client.post(`/api/panes/${encodeURIComponent(resolved.pane.id)}/resize`, {
        tabId: resolved.tab?.id,
        x: x ? Number(x) : undefined,
        y: y ? Number(y) : undefined,
      })
      writeJson(res)
      return
    }
    case 'swap-pane': {
      const target = (getFlag(flags, 't', 'target', 'pane') as string | undefined) || args[0]
      const other = (getFlag(flags, 's', 'swap', 'other') as string | undefined) || args[1]
      const resolved = await resolvePaneTarget(client, target)
      if (!resolved.pane?.id) {
        writeError(resolved.message || 'pane not found')
        process.exitCode = 1
        return
      }
      if (!other) {
        writeError('swap target required')
        process.exitCode = 1
        return
      }
      const res = await client.post(`/api/panes/${encodeURIComponent(resolved.pane.id)}/swap`, {
        target: other,
        tabId: resolved.tab?.id,
      })
      writeJson(res)
      return
    }
    case 'respawn-pane': {
      const target = (getFlag(flags, 't', 'target', 'pane') as string | undefined) || args[0]
      const mode = getFlag(flags, 'mode') as string | undefined
      const shell = getFlag(flags, 'shell') as string | undefined
      const cwd = getFlag(flags, 'cwd') as string | undefined
      const resolved = await resolvePaneTarget(client, target)
      if (!resolved.pane?.id) {
        writeError(resolved.message || 'pane not found')
        process.exitCode = 1
        return
      }
      const res = await client.post(`/api/panes/${encodeURIComponent(resolved.pane.id)}/respawn`, { mode, shell, cwd })
      writeJson(res)
      return
    }
    case 'send-keys': {
      const targetFromFlag = getFlag(flags, 't', 'target', 'pane') as string | undefined
      const parsedSendKeys = partitionSendKeysArgs(args, targetFromFlag)
      let target: string | undefined = parsedSendKeys.target
      const literal = isTruthy(getFlag(flags, 'l', 'literal'))
      const keyArgs = parsedSendKeys.keyArgs
      if (!target) {
        const resolved = await resolvePaneTarget(client, undefined)
        target = resolved.pane?.id
        if (resolved.message) writeError(resolved.message)
      }
      if (!target) {
        writeError('pane target required')
        process.exitCode = 1
        return
      }
      if (literal) {
        const data = keyArgs.join(' ')
        const res = await client.post(`/api/panes/${encodeURIComponent(target)}/send-keys`, { data })
        writeJson(res)
        return
      }
      const res = await sendKeysCommand({ target, keys: keyArgs }, client)
      writeJson(res)
      return
    }
    case 'capture-pane': {
      let target = (getFlag(flags, 't', 'target', 'pane') as string | undefined) || args[0]
      const resolved = await resolvePaneTarget(client, target)
      if (!resolved.pane?.id) {
        writeError(resolved.message || 'pane not found')
        process.exitCode = 1
        return
      }
      const params = new URLSearchParams()
      const start = getFlag(flags, 'S')
      if (start !== undefined) params.set('S', String(start))
      if (isTruthy(getFlag(flags, 'J'))) params.set('J', 'true')
      if (isTruthy(getFlag(flags, 'e'))) params.set('e', 'true')
      const output = await client.get(`/api/panes/${encodeURIComponent(resolved.pane.id)}/capture?${params.toString()}`)
      writeText(String(output))
      return
    }
    case 'screenshot': {
      const defaultScope = parsed.command === 'screenshot-pane' ? 'pane'
        : parsed.command === 'screenshot-tab' ? 'tab'
          : parsed.command === 'screenshot-view' ? 'view'
            : undefined
      const scopeRaw = ((getFlag(flags, 'scope') as string | undefined) || defaultScope)
      if (scopeRaw !== 'pane' && scopeRaw !== 'tab' && scopeRaw !== 'view') {
        writeError('scope must be pane, tab, or view')
        process.exitCode = 1
        return
      }

      const name = getFlag(flags, 'n', 'name') as string | undefined
      if (!name) {
        writeError('name required')
        process.exitCode = 1
        return
      }

      const pathInput = getFlag(flags, 'path') as string | undefined
      const overwrite = isTruthy(getFlag(flags, 'overwrite'))
      let paneId: string | undefined
      let tabId: string | undefined

      if (scopeRaw === 'pane') {
        const target = (getFlag(flags, 't', 'target', 'pane') as string | undefined) || args[0]
        const resolved = await resolvePaneTarget(client, target)
        if (!resolved.pane?.id) {
          writeError(resolved.message || 'pane not found')
          process.exitCode = 1
          return
        }
        if (resolved.message) writeError(resolved.message)
        paneId = resolved.pane.id
        tabId = resolved.tab?.id
      } else if (scopeRaw === 'tab') {
        const target = (getFlag(flags, 't', 'target', 'tab') as string | undefined) || args[0]
        const resolved = await resolveTabTarget(client, target)
        if (!resolved.tab?.id) {
          writeError(resolved.message || 'tab not found')
          process.exitCode = 1
          return
        }
        if (resolved.message) writeError(resolved.message)
        tabId = resolved.tab.id
      }

      const res = await client.post('/api/screenshots', {
        scope: scopeRaw,
        name,
        path: pathInput,
        overwrite,
        tabId,
        paneId,
      })
      writeJson(res)
      return
    }
    case 'wait-for': {
      let target = (getFlag(flags, 't', 'target', 'pane') as string | undefined) || args[0]
      const resolved = await resolvePaneTarget(client, target)
      if (!resolved.pane?.id) {
        writeError(resolved.message || 'pane not found')
        process.exitCode = 1
        return
      }
      const params = new URLSearchParams()
      const pattern = getFlag(flags, 'p', 'pattern') as string | undefined
      const stable = getFlag(flags, 'stable') as string | undefined
      const timeout = getFlag(flags, 'T', 'timeout') as string | undefined
      if (pattern) params.set('pattern', pattern)
      if (stable) params.set('stable', stable)
      if (isTruthy(getFlag(flags, 'exit'))) params.set('exit', 'true')
      if (isTruthy(getFlag(flags, 'prompt'))) params.set('prompt', 'true')
      if (timeout) params.set('T', timeout)
      const res = await client.get(`/api/panes/${encodeURIComponent(resolved.pane.id)}/wait-for?${params.toString()}`)
      writeJson(res)
      return
    }
    case 'open-browser': {
      const url = args[0] || (getFlag(flags, 'url') as string | undefined)
      if (!url) {
        writeError('url required')
        process.exitCode = 1
        return
      }
      const res = await client.post('/api/tabs', { name: getFlag(flags, 'n', 'name', 'title'), browser: url })
      const data = unwrap(res)
      if (data?.paneId) {
        await client.post(`/api/panes/${encodeURIComponent(data.paneId)}/navigate`, { url })
      }
      writeJson(res)
      return
    }
    case 'navigate': {
      const url = args[0] || (getFlag(flags, 'url') as string | undefined)
      const target = (getFlag(flags, 't', 'target', 'pane') as string | undefined) || args[1]
      if (!url) {
        writeError('url required')
        process.exitCode = 1
        return
      }
      const resolved = await resolvePaneTarget(client, target)
      if (!resolved.pane?.id) {
        writeError(resolved.message || 'pane not found')
        process.exitCode = 1
        return
      }
      const res = await client.post(`/api/panes/${encodeURIComponent(resolved.pane.id)}/navigate`, { url })
      writeJson(res)
      return
    }
    case 'list-sessions': {
      const res = await client.get('/api/sessions')
      writeJson(res)
      return
    }
    case 'search-sessions': {
      const query = args[0] || (getFlag(flags, 'q', 'query') as string | undefined)
      if (!query) {
        writeError('query required')
        process.exitCode = 1
        return
      }
      const res = await client.get(`/api/sessions/search?q=${encodeURIComponent(query)}`)
      writeJson(res)
      return
    }
    case 'display': {
      const format = (getFlag(flags, 'p', 'format') as string | undefined) || args[0]
      if (!format) {
        writeError('format required')
        process.exitCode = 1
        return
      }
      const target = (getFlag(flags, 't', 'target', 'pane') as string | undefined) || args[1]
      await handleDisplay(format, target, client)
      return
    }
    case 'run': {
      const capture = isTruthy(getFlag(flags, 'capture', 'c'))
      const detached = isTruthy(getFlag(flags, 'd', 'detach'))
      const timeout = getFlag(flags, 'T', 'timeout') as string | undefined
      const name = getFlag(flags, 'n', 'name', 'title') as string | undefined
      const cwd = getFlag(flags, 'cwd') as string | undefined
      const commandText = args.join(' ')
      if (!commandText) {
        writeError('command required')
        process.exitCode = 1
        return
      }
      const res = await client.post('/api/run', { command: commandText, capture, detached, timeout, name, cwd })
      writeJson(res)
      return
    }
    case 'summarize': {
      const target = (getFlag(flags, 't', 'target', 'pane') as string | undefined) || args[0]
      const resolved = await resolvePaneTarget(client, target)
      if (!resolved.pane?.terminalId) {
        writeError(resolved.message || 'terminal not found')
        process.exitCode = 1
        return
      }
      const res = await client.post(`/api/ai/terminals/${encodeURIComponent(resolved.pane.terminalId)}/summary`, {})
      writeJson(res)
      return
    }
    case 'health': {
      const res = await client.get('/api/health')
      writeJson(res)
      return
    }
    case 'lan-info': {
      const res = await client.get('/api/lan-info')
      writeJson(res)
      return
    }
    case 'list-terminals': {
      const res = await client.get('/api/terminals')
      writeJson(res)
      return
    }
    case 'attach': {
      const terminalId = (getFlag(flags, 't', 'terminal') as string | undefined) || args[0]
      if (!terminalId) {
        writeError('terminal id required')
        process.exitCode = 1
        return
      }
      let target = (getFlag(flags, 'p', 'pane', 'target') as string | undefined) || args[1]
      const resolved = await resolvePaneTarget(client, target)
      if (!resolved.pane?.id) {
        writeError(resolved.message || 'pane not found')
        process.exitCode = 1
        return
      }
      const res = await client.post(`/api/panes/${encodeURIComponent(resolved.pane.id)}/attach`, { terminalId })
      writeJson(res)
      return
    }
    default: {
      writeError(`unknown command: ${command}`)
      process.exitCode = 1
    }
  }
}

main().catch((err) => {
  writeError(err)
  process.exitCode = 1
})
