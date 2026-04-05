import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockClient = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}))

vi.mock('../../../../server/mcp/http-client.js', () => ({
  resolveConfig: () => ({ url: 'http://localhost:3001', token: 'test' }),
  createApiClient: () => mockClient,
}))

import { TOOL_DESCRIPTION, INSTRUCTIONS, INPUT_SCHEMA, executeAction } from '../../../../server/mcp/freshell-tool.js'

beforeEach(() => {
  mockClient.get.mockReset()
  mockClient.post.mockReset()
  mockClient.patch.mockReset()
  mockClient.delete.mockReset()
})

describe('TOOL_DESCRIPTION and INSTRUCTIONS', () => {
  it('TOOL_DESCRIPTION is a non-empty string mentioning key actions', () => {
    expect(TOOL_DESCRIPTION).toBeTruthy()
    expect(TOOL_DESCRIPTION).toContain('new-tab')
    expect(TOOL_DESCRIPTION).toContain('send-keys')
    expect(TOOL_DESCRIPTION).toContain('capture-pane')
    expect(TOOL_DESCRIPTION).toContain('screenshot')
  })

  it('INSTRUCTIONS contains mental model, pane kinds, picker warning, targets, and gotchas', () => {
    expect(INSTRUCTIONS).toBeTruthy()
    expect(INSTRUCTIONS.toLowerCase()).toContain('freshell')
    // Mental model section
    expect(INSTRUCTIONS).toContain('Mental model')
    expect(INSTRUCTIONS).toContain('terminal')
    expect(INSTRUCTIONS).toContain('editor')
    expect(INSTRUCTIONS).toContain('browser')
    expect(INSTRUCTIONS).toContain('agent-chat')
    expect(INSTRUCTIONS).toContain('picker')
    // Picker warning
    expect(INSTRUCTIONS).toContain('Picker panes are ephemeral')
    // Targets section
    expect(INSTRUCTIONS).toContain('Targets')
    expect(INSTRUCTIONS).toContain('tab ID or exact tab title')
    expect(INSTRUCTIONS).toContain('pane ID')
    // Key gotchas
    expect(INSTRUCTIONS).toContain('literal mode')
    expect(INSTRUCTIONS).toContain('wait-for')
    expect(INSTRUCTIONS).toContain('stable')
    expect(INSTRUCTIONS).toContain('50 PTY limit')
    // tmux compatibility
    expect(INSTRUCTIONS).toContain('tmux')
    expect(INSTRUCTIONS).toContain('new-window')
  })

  it('browser pane screenshot instructions reflect that proxied localhost URLs render actual content', () => {
    // The instructions should clarify that proxied localhost URLs render actual
    // content in iframe screenshots, and only truly cross-origin URLs fall back
    // to a placeholder. This guards against regressions where the instructions
    // incorrectly claim all browser pane screenshots show placeholders.
    expect(INSTRUCTIONS).toContain('proxied localhost URLs render actual content')
    expect(INSTRUCTIONS).toContain('cross-origin')
    expect(INSTRUCTIONS).toContain('placeholder')
    // Must NOT contain the old wording that claims all proxied screenshots are placeholders
    expect(INSTRUCTIONS).not.toMatch(/browser pane screenshots.*always.*placeholder/i)
    expect(INSTRUCTIONS).not.toMatch(/cross-origin iframe content renders a placeholder/i)
  })

  it('INPUT_SCHEMA has action and params fields', () => {
    expect(INPUT_SCHEMA).toHaveProperty('action')
    expect(INPUT_SCHEMA).toHaveProperty('params')
  })
})

describe('executeAction -- tab actions', () => {
  it('new-tab calls POST /api/tabs with name and mode', async () => {
    mockClient.post.mockResolvedValue({ id: 't1' })
    await executeAction('new-tab', { name: 'Work', mode: 'claude' })
    expect(mockClient.post).toHaveBeenCalledWith('/api/tabs', expect.objectContaining({ name: 'Work', mode: 'claude' }))
  })

  it('list-tabs calls GET /api/tabs', async () => {
    mockClient.get.mockResolvedValue({ tabs: [] })
    await executeAction('list-tabs')
    expect(mockClient.get).toHaveBeenCalledWith('/api/tabs')
  })

  it('select-tab calls POST /api/tabs/:id/select', async () => {
    mockClient.get.mockResolvedValue({ tabs: [{ id: 't1', title: 'Tab 1' }], activeTabId: 't1' })
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('select-tab', { target: 't1' })
    expect(mockClient.post).toHaveBeenCalledWith(expect.stringContaining('/api/tabs/t1/select'), expect.anything())
  })

  it('kill-tab calls DELETE /api/tabs/:id', async () => {
    mockClient.get.mockResolvedValue({ tabs: [{ id: 't1', title: 'Tab 1' }], activeTabId: 't1' })
    mockClient.delete.mockResolvedValue({ ok: true })
    await executeAction('kill-tab', { target: 't1' })
    expect(mockClient.delete).toHaveBeenCalledWith(expect.stringContaining('/api/tabs/t1'))
  })

  it('rename-tab calls PATCH /api/tabs/:id', async () => {
    mockClient.get.mockResolvedValue({ tabs: [{ id: 't1', title: 'Tab 1' }], activeTabId: 't1' })
    mockClient.patch.mockResolvedValue({ ok: true })
    await executeAction('rename-tab', { target: 't1', name: 'New Name' })
    expect(mockClient.patch).toHaveBeenCalledWith(
      expect.stringContaining('/api/tabs/t1'),
      expect.objectContaining({ name: 'New Name' }),
    )
  })

  it('has-tab calls GET /api/tabs/has?target=...', async () => {
    mockClient.get.mockResolvedValue({ exists: true })
    await executeAction('has-tab', { target: 'Work' })
    expect(mockClient.get).toHaveBeenCalledWith(expect.stringMatching(/\/api\/tabs\/has\?target=Work/))
  })

  it('next-tab calls POST /api/tabs/next', async () => {
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('next-tab')
    expect(mockClient.post).toHaveBeenCalledWith('/api/tabs/next', expect.anything())
  })

  it('prev-tab calls POST /api/tabs/prev', async () => {
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('prev-tab')
    expect(mockClient.post).toHaveBeenCalledWith('/api/tabs/prev', expect.anything())
  })
})

describe('executeAction -- pane actions', () => {
  it('split-pane resolves target and calls POST /api/panes/:id/split with direction', async () => {
    mockClient.get.mockImplementation((path: string) => {
      if (path === '/api/tabs') return Promise.resolve({ tabs: [{ id: 't1', activePaneId: 'p1' }], activeTabId: 't1' })
      if (path.includes('/api/panes')) return Promise.resolve({ panes: [{ id: 'p1', index: 0, kind: 'terminal', terminalId: 'term-1' }] })
      return Promise.resolve({})
    })
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('split-pane', { target: 'p1', direction: 'vertical' })
    expect(mockClient.post).toHaveBeenCalledWith(
      expect.stringContaining('/api/panes/p1/split'),
      expect.objectContaining({ direction: 'vertical' }),
    )
  })

  it('list-panes calls GET /api/panes', async () => {
    mockClient.get.mockResolvedValue({ panes: [] })
    await executeAction('list-panes')
    expect(mockClient.get).toHaveBeenCalledWith('/api/panes')
  })

  it('list-panes with tab target calls GET /api/panes?tabId=...', async () => {
    // First call: GET /api/tabs to resolve target 't1' (matched by ID)
    mockClient.get
      .mockResolvedValueOnce({ data: { tabs: [{ id: 't1', title: 'Tab1' }], activeTabId: 't1' } })
      // Second call: GET /api/panes?tabId=t1
      .mockResolvedValueOnce({ panes: [] })
    await executeAction('list-panes', { target: 't1' })
    expect(mockClient.get).toHaveBeenCalledWith(expect.stringMatching(/\/api\/panes\?tabId=t1/))
  })

  it('list-panes resolves tab title to tabId via resolveTabTarget', async () => {
    // First call: GET /api/tabs to resolve "Work" -> "t1"
    mockClient.get
      .mockResolvedValueOnce({ data: { tabs: [{ id: 't1', title: 'Work' }], activeTabId: 't1' } })
      // Second call: GET /api/panes?tabId=t1
      .mockResolvedValueOnce({ data: { panes: [{ id: 'p1', index: 0 }] } })
    const result = await executeAction('list-panes', { target: 'Work' })
    // The panes call must use the resolved tab ID, not the raw title
    expect(mockClient.get).toHaveBeenCalledWith(expect.stringMatching(/\/api\/panes\?tabId=t1/))
    // Must NOT have called with the raw title as tabId
    expect(mockClient.get).not.toHaveBeenCalledWith(expect.stringMatching(/\/api\/panes\?tabId=Work/))
  })

  it('select-pane calls POST /api/panes/:id/select', async () => {
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('select-pane', { target: 'p1' })
    expect(mockClient.post).toHaveBeenCalledWith(expect.stringContaining('/api/panes/p1/select'), expect.anything())
  })

  it('rename-pane calls PATCH /api/panes/:id', async () => {
    mockClient.patch.mockResolvedValue({ ok: true })
    await executeAction('rename-pane', { target: 'p1', name: 'My Pane' })
    expect(mockClient.patch).toHaveBeenCalledWith(
      expect.stringContaining('/api/panes/p1'),
      expect.objectContaining({ name: 'My Pane' }),
    )
  })

  it('kill-pane calls POST /api/panes/:id/close', async () => {
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('kill-pane', { target: 'p1' })
    expect(mockClient.post).toHaveBeenCalledWith(expect.stringContaining('/api/panes/p1/close'), expect.anything())
  })

  it('resize-pane calls POST /api/panes/:id/resize with x/y', async () => {
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('resize-pane', { target: 'p1', x: 60 })
    expect(mockClient.post).toHaveBeenCalledWith(
      expect.stringContaining('/api/panes/p1/resize'),
      expect.objectContaining({ x: 60 }),
    )
  })

  it('swap-pane calls POST /api/panes/:id/swap with target body', async () => {
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('swap-pane', { target: 'p1', with: 'p2' })
    expect(mockClient.post).toHaveBeenCalledWith(
      expect.stringContaining('/api/panes/p1/swap'),
      expect.objectContaining({ target: 'p2' }),
    )
  })

  it('respawn-pane calls POST /api/panes/:id/respawn', async () => {
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('respawn-pane', { target: 'p1' })
    expect(mockClient.post).toHaveBeenCalledWith(expect.stringContaining('/api/panes/p1/respawn'), expect.anything())
  })
})

describe('executeAction -- terminal I/O', () => {
  // send-keys, capture-pane, wait-for all resolve pane targets via resolvePaneTarget,
  // which fetches tabs and panes from the API. Set up mock that resolves 'p1' by ID.
  function setupPaneResolution() {
    const prevGet = mockClient.get.getMockImplementation()
    mockClient.get.mockImplementation((path: string) => {
      if (path === '/api/tabs') {
        return Promise.resolve({ tabs: [{ id: 't1', activePaneId: 'p1' }], activeTabId: 't1' })
      }
      if (path.includes('/api/panes') && !path.includes('/capture') && !path.includes('/wait-for')) {
        return Promise.resolve({ panes: [{ id: 'p1', index: 0, kind: 'terminal', terminalId: 'term-1' }] })
      }
      // For capture-pane and wait-for, call through to specific mocks or return default
      if (prevGet) return prevGet(path)
      return Promise.resolve({})
    })
  }

  it('send-keys in token mode translates key tokens via translateKeys()', async () => {
    setupPaneResolution()
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('send-keys', { target: 'p1', keys: ['ls', 'ENTER'] })
    expect(mockClient.post).toHaveBeenCalledWith(
      '/api/panes/p1/send-keys',
      expect.objectContaining({ data: 'ls\r' }),
    )
  })

  it('send-keys in literal mode sends raw string without translation', async () => {
    setupPaneResolution()
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('send-keys', { target: 'p1', keys: 'echo hello world\n', literal: true })
    expect(mockClient.post).toHaveBeenCalledWith(
      '/api/panes/p1/send-keys',
      expect.objectContaining({ data: 'echo hello world\n' }),
    )
  })

  it('send-keys with string keys and no literal flag treats as single token', async () => {
    setupPaneResolution()
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('send-keys', { target: 'p1', keys: 'ENTER' })
    expect(mockClient.post).toHaveBeenCalledWith(
      '/api/panes/p1/send-keys',
      expect.objectContaining({ data: '\r' }),
    )
  })

  it('send-keys without target resolves to caller pane', async () => {
    setupPaneResolution()
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('send-keys', { keys: ['ls', 'ENTER'] })
    expect(mockClient.post).toHaveBeenCalledWith(
      '/api/panes/p1/send-keys',
      expect.objectContaining({ data: 'ls\r' }),
    )
  })

  it('capture-pane calls GET /api/panes/:id/capture and returns plain text', async () => {
    mockClient.get.mockImplementation((path: string) => {
      if (path === '/api/tabs') {
        return Promise.resolve({ tabs: [{ id: 't1', activePaneId: 'p1' }], activeTabId: 't1' })
      }
      if (path.includes('/api/panes') && !path.includes('/capture')) {
        return Promise.resolve({ panes: [{ id: 'p1', index: 0, kind: 'terminal', terminalId: 'term-1' }] })
      }
      if (path.includes('/api/panes/p1/capture')) {
        return Promise.resolve('terminal output')
      }
      return Promise.resolve({})
    })
    const result = await executeAction('capture-pane', { target: 'p1' })
    expect(mockClient.get).toHaveBeenCalledWith(expect.stringContaining('/api/panes/p1/capture'))
    expect(result).toContain('terminal output')
  })

  it('capture-pane URL-encodes the S selector parameter', async () => {
    mockClient.get.mockImplementation((path: string) => {
      if (path === '/api/tabs') {
        return Promise.resolve({ tabs: [{ id: 't1', activePaneId: 'p1' }], activeTabId: 't1' })
      }
      if (path.includes('/api/panes') && !path.includes('/capture')) {
        return Promise.resolve({ panes: [{ id: 'p1', index: 0, kind: 'terminal', terminalId: 'term-1' }] })
      }
      return Promise.resolve('output')
    })
    await executeAction('capture-pane', { target: 'p1', S: 'foo&bar=baz' })
    // Find the capture call specifically
    const captureCall = mockClient.get.mock.calls.find((c: string[]) => (c[0] as string).includes('/capture'))
    expect(captureCall).toBeTruthy()
    const url = captureCall![0] as string
    // The S value must be encoded so & and = don't corrupt query parsing
    expect(url).toContain(`S=${encodeURIComponent('foo&bar=baz')}`)
    expect(url).not.toContain('S=foo&bar=baz')
  })

  it('wait-for calls GET /api/panes/:id/wait-for with pattern', async () => {
    mockClient.get.mockImplementation((path: string) => {
      if (path === '/api/tabs') {
        return Promise.resolve({ tabs: [{ id: 't1', activePaneId: 'p1' }], activeTabId: 't1' })
      }
      if (path.includes('/api/panes') && !path.includes('/wait-for')) {
        return Promise.resolve({ panes: [{ id: 'p1', index: 0, kind: 'terminal', terminalId: 'term-1' }] })
      }
      return Promise.resolve({ matched: true })
    })
    await executeAction('wait-for', { target: 'p1', pattern: '\\$' })
    expect(mockClient.get).toHaveBeenCalledWith(expect.stringMatching(/\/api\/panes\/p1\/wait-for/))
  })

  it('run calls POST /api/run with command and options', async () => {
    mockClient.post.mockResolvedValue({ output: 'ok', exitCode: 0 })
    await executeAction('run', { command: 'npm test', capture: true })
    expect(mockClient.post).toHaveBeenCalledWith(
      '/api/run',
      expect.objectContaining({ command: 'npm test', capture: true }),
    )
  })

  it('summarize resolves pane to terminalId and calls POST /api/ai/terminals/:terminalId/summary', async () => {
    mockClient.get.mockImplementation((path: string) => {
      if (path === '/api/tabs') return Promise.resolve({ tabs: [{ id: 't1', activePaneId: 'p1' }], activeTabId: 't1' })
      if (path.includes('/api/panes')) return Promise.resolve({ panes: [{ id: 'p1', terminalId: 'term-1' }] })
      return Promise.resolve({})
    })
    mockClient.post.mockResolvedValue({ summary: 'test' })
    await executeAction('summarize', { target: 'p1' })
    expect(mockClient.post).toHaveBeenCalledWith(expect.stringMatching(/\/api\/ai\/terminals\/term-1\/summary/), expect.anything())
  })
})

describe('executeAction -- additional terminal I/O', () => {
  it('display resolves pane target and formats string', async () => {
    mockClient.get.mockImplementation((path: string) => {
      if (path === '/api/tabs') return Promise.resolve({ tabs: [{ id: 't1', title: 'Work', activePaneId: 'p1' }], activeTabId: 't1' })
      if (path.includes('/api/panes')) return Promise.resolve({ panes: [{ id: 'p1', terminalId: 'term-1' }] })
      return Promise.resolve({})
    })
    const result = await executeAction('display', { target: 'p1', format: '#S:#P' })
    expect(result).toContain('Work')
    expect(result).toContain('p1')
  })

  it('list-terminals calls GET /api/terminals', async () => {
    mockClient.get.mockResolvedValue({ terminals: [] })
    await executeAction('list-terminals')
    expect(mockClient.get).toHaveBeenCalledWith('/api/terminals')
  })

  it('attach calls POST /api/panes/:id/attach with terminalId', async () => {
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('attach', { target: 'p1', terminalId: 'term-1' })
    expect(mockClient.post).toHaveBeenCalledWith(
      expect.stringContaining('/api/panes/p1/attach'),
      expect.objectContaining({ terminalId: 'term-1' }),
    )
  })

  it('lan-info calls GET /api/lan-info', async () => {
    mockClient.get.mockResolvedValue({ addresses: [] })
    await executeAction('lan-info')
    expect(mockClient.get).toHaveBeenCalledWith('/api/lan-info')
  })
})

describe('executeAction -- browser', () => {
  it('open-browser calls POST /api/tabs with browser URL', async () => {
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('open-browser', { url: 'https://example.com' })
    expect(mockClient.post).toHaveBeenCalledWith('/api/tabs', expect.objectContaining({ browser: 'https://example.com' }))
  })

  it('navigate calls POST /api/panes/:id/navigate', async () => {
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('navigate', { target: 'p1', url: 'https://example.com' })
    expect(mockClient.post).toHaveBeenCalledWith(
      expect.stringContaining('/api/panes/p1/navigate'),
      expect.objectContaining({ url: 'https://example.com' }),
    )
  })
})

describe('executeAction -- screenshot', () => {
  it('screenshot with scope=pane resolves target to paneId and includes name', async () => {
    mockClient.get.mockImplementation((path: string) => {
      if (path === '/api/tabs') return Promise.resolve({ tabs: [{ id: 't1', activePaneId: 'p1' }], activeTabId: 't1' })
      if (path.includes('/api/panes')) return Promise.resolve({ panes: [{ id: 'p1', index: 0, terminalId: 'term-1' }] })
      return Promise.resolve({})
    })
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('screenshot', { scope: 'pane', target: 'p1', name: 'test' })
    expect(mockClient.post).toHaveBeenCalledWith(
      '/api/screenshots',
      expect.objectContaining({ scope: 'pane', paneId: 'p1', name: 'test' }),
    )
  })

  it('screenshot with scope=tab resolves target to tabId', async () => {
    mockClient.get.mockResolvedValue({ tabs: [{ id: 't1', title: 'Tab 1' }], activeTabId: 't1' })
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('screenshot', { scope: 'tab', target: 't1', name: 'test' })
    expect(mockClient.post).toHaveBeenCalledWith(
      '/api/screenshots',
      expect.objectContaining({ scope: 'tab', tabId: 't1', name: 'test' }),
    )
  })

  it('screenshot with scope=tab resolves tab title to tabId', async () => {
    mockClient.get.mockResolvedValue({ tabs: [{ id: 't1', title: 'Work' }], activeTabId: 't1' })
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('screenshot', { scope: 'tab', target: 'Work', name: 'test' })
    expect(mockClient.post).toHaveBeenCalledWith(
      '/api/screenshots',
      expect.objectContaining({ scope: 'tab', tabId: 't1' }),
    )
  })

  it('screenshot with scope=view sends no ID', async () => {
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('screenshot', { scope: 'view', name: 'test' })
    const call = mockClient.post.mock.calls[0]
    expect(call[0]).toBe('/api/screenshots')
    expect(call[1]).toEqual(expect.objectContaining({ scope: 'view', name: 'test' }))
    expect(call[1]).not.toHaveProperty('paneId')
    expect(call[1]).not.toHaveProperty('tabId')
  })

  it('screenshot defaults name to "screenshot" when not provided', async () => {
    mockClient.get.mockImplementation((path: string) => {
      if (path === '/api/tabs') return Promise.resolve({ tabs: [{ id: 't1', activePaneId: 'p1' }], activeTabId: 't1' })
      if (path.includes('/api/panes')) return Promise.resolve({ panes: [{ id: 'p1', index: 0, terminalId: 'term-1' }] })
      return Promise.resolve({})
    })
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('screenshot', { scope: 'pane', target: 'p1' })
    expect(mockClient.post).toHaveBeenCalledWith(
      '/api/screenshots',
      expect.objectContaining({ name: 'screenshot' }),
    )
  })

  it('screenshot with scope=tab and invalid tab target returns error', async () => {
    mockClient.get.mockResolvedValue({ tabs: [{ id: 't1', title: 'Work' }], activeTabId: 't1' })
    const result = await executeAction('screenshot', { scope: 'tab', target: 'nonexistent-tab', name: 'test' })
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toContain("'nonexistent-tab'")
    expect((result as { error: string }).error).toContain('not found')
    // Should NOT have called post (no fallback to raw target)
    expect(mockClient.post).not.toHaveBeenCalled()
  })
})

describe('executeAction -- session', () => {
  it('list-sessions calls GET /api/session-directory with priority=visible', async () => {
    mockClient.get.mockResolvedValue({ items: [] })
    await executeAction('list-sessions')
    expect(mockClient.get).toHaveBeenCalledWith(expect.stringMatching(/\/api\/session-directory\?.*priority=visible/))
  })

  it('search-sessions calls GET /api/session-directory with query and priority', async () => {
    mockClient.get.mockResolvedValue({ items: [] })
    await executeAction('search-sessions', { query: 'test' })
    const path = mockClient.get.mock.calls[0][0]
    expect(path).toContain('priority=visible')
    expect(path).toContain('query=test')
  })
})

describe('executeAction -- meta', () => {
  it('health calls GET /api/health', async () => {
    mockClient.get.mockResolvedValue({ ok: true })
    await executeAction('health')
    expect(mockClient.get).toHaveBeenCalledWith('/api/health')
  })

  it('help returns full reference with commands, playbooks, gotchas, and tmux aliases', async () => {
    const result = await executeAction('help')
    expect(result).toBeTruthy()
    expect(typeof result === 'string' || typeof result === 'object').toBe(true)
    const text = typeof result === 'string' ? result : JSON.stringify(result)
    // Command reference
    expect(text).toContain('new-tab')
    expect(text).toContain('send-keys')
    expect(text).toContain('capture-pane')
    expect(text).toContain('screenshot')
    expect(text).toContain('wait-for')
    // Playbooks
    expect(text).toContain('Playbook')
    expect(text).toContain('literal: true')
    // Screenshot guidance
    expect(text).toContain('Screenshot guidance')
    expect(text).toContain('canary tab')
    // Gotchas
    expect(text).toContain('Gotchas')
    expect(text).toContain('50 PTY limit')
    expect(text).toContain('Picker panes')
    // tmux aliases
    expect(text).toContain('tmux aliases')
    expect(text).toContain('new-window')
    expect(text).toContain('split-window')
  })
})

describe('executeAction -- tab target resolution', () => {
  it('select-tab resolves tab title to tab ID', async () => {
    mockClient.get.mockResolvedValue({ tabs: [{ id: 't1', title: 'Work' }], activeTabId: 't1' })
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('select-tab', { target: 'Work' })
    expect(mockClient.post).toHaveBeenCalledWith(
      expect.stringContaining('/api/tabs/t1/select'),
      expect.anything(),
    )
  })

  it('kill-tab resolves tab title to tab ID', async () => {
    mockClient.get.mockResolvedValue({ tabs: [{ id: 't1', title: 'Work' }], activeTabId: 't1' })
    mockClient.delete.mockResolvedValue({ ok: true })
    await executeAction('kill-tab', { target: 'Work' })
    expect(mockClient.delete).toHaveBeenCalledWith(
      expect.stringContaining('/api/tabs/t1'),
    )
  })

  it('rename-tab resolves tab title to tab ID', async () => {
    mockClient.get.mockResolvedValue({ tabs: [{ id: 't1', title: 'Work' }], activeTabId: 't1' })
    mockClient.patch.mockResolvedValue({ ok: true })
    await executeAction('rename-tab', { target: 'Work', name: 'New Name' })
    expect(mockClient.patch).toHaveBeenCalledWith(
      expect.stringContaining('/api/tabs/t1'),
      expect.objectContaining({ name: 'New Name' }),
    )
  })

  it('select-tab returns error when tab title not found', async () => {
    mockClient.get.mockResolvedValue({ tabs: [{ id: 't1', title: 'Work' }], activeTabId: 't1' })
    const result = await executeAction('select-tab', { target: 'NonExistent' })
    expect(result).toHaveProperty('error')
    expect(result.error).toContain('not found')
  })
})

describe('executeAction -- split-pane without target', () => {
  it('split-pane without target resolves to active pane when no caller identity', async () => {
    mockClient.get.mockImplementation((path: string) => {
      if (path === '/api/tabs') return Promise.resolve({ tabs: [{ id: 't1', activePaneId: 'p1' }], activeTabId: 't1' })
      if (path.includes('/api/panes')) return Promise.resolve({ panes: [{ id: 'p1', terminalId: 'term-1' }] })
      return Promise.resolve({})
    })
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('split-pane', { direction: 'vertical' })
    expect(mockClient.post).toHaveBeenCalledWith(
      expect.stringContaining('/api/panes/p1/split'),
      expect.objectContaining({ direction: 'vertical' }),
    )
  })
})

describe('executeAction -- caller identity (FRESHELL_TAB_ID / FRESHELL_PANE_ID)', () => {
  const origTabId = process.env.FRESHELL_TAB_ID
  const origPaneId = process.env.FRESHELL_PANE_ID

  afterEach(() => {
    // Restore original env
    if (origTabId !== undefined) process.env.FRESHELL_TAB_ID = origTabId
    else delete process.env.FRESHELL_TAB_ID
    if (origPaneId !== undefined) process.env.FRESHELL_PANE_ID = origPaneId
    else delete process.env.FRESHELL_PANE_ID
  })

  function setupTwoTabs() {
    // t-caller is the caller's tab; t-active is the user's active viewport tab.
    // Active tab is t-active, but FRESHELL_TAB_ID points to t-caller.
    mockClient.get.mockImplementation((path: string) => {
      if (path === '/api/tabs') {
        return Promise.resolve({
          tabs: [
            { id: 't-caller', title: 'Caller Tab', activePaneId: 'p-caller' },
            { id: 't-active', title: 'Active Tab', activePaneId: 'p-active' },
          ],
          activeTabId: 't-active',
        })
      }
      if (path.includes('tabId=t-caller')) {
        return Promise.resolve({ panes: [{ id: 'p-caller', index: 0, kind: 'terminal', terminalId: 'term-caller' }] })
      }
      if (path.includes('tabId=t-active')) {
        return Promise.resolve({ panes: [{ id: 'p-active', index: 0, kind: 'terminal', terminalId: 'term-active' }] })
      }
      // Unfiltered panes query
      if (path === '/api/panes') {
        return Promise.resolve({ panes: [
          { id: 'p-caller', index: 0, kind: 'terminal', terminalId: 'term-caller' },
          { id: 'p-active', index: 0, kind: 'terminal', terminalId: 'term-active' },
        ] })
      }
      return Promise.resolve({})
    })
    mockClient.post.mockResolvedValue({ ok: true })
  }

  it('split-pane without target uses caller tab/pane when FRESHELL_TAB_ID is set', async () => {
    process.env.FRESHELL_TAB_ID = 't-caller'
    process.env.FRESHELL_PANE_ID = 'p-caller'
    setupTwoTabs()

    await executeAction('split-pane', { direction: 'horizontal' })
    expect(mockClient.post).toHaveBeenCalledWith(
      expect.stringContaining('/api/panes/p-caller/split'),
      expect.objectContaining({ direction: 'horizontal' }),
    )
  })

  it('split-pane without target falls back to active tab when FRESHELL_TAB_ID is NOT set', async () => {
    delete process.env.FRESHELL_TAB_ID
    delete process.env.FRESHELL_PANE_ID
    setupTwoTabs()

    await executeAction('split-pane', { direction: 'horizontal' })
    expect(mockClient.post).toHaveBeenCalledWith(
      expect.stringContaining('/api/panes/p-active/split'),
      expect.objectContaining({ direction: 'horizontal' }),
    )
  })

  it('screenshot scope=pane without target uses caller pane', async () => {
    process.env.FRESHELL_TAB_ID = 't-caller'
    process.env.FRESHELL_PANE_ID = 'p-caller'
    setupTwoTabs()

    await executeAction('screenshot', { scope: 'pane', name: 'test' })
    expect(mockClient.post).toHaveBeenCalledWith(
      '/api/screenshots',
      expect.objectContaining({ scope: 'pane', paneId: 'p-caller', tabId: 't-caller' }),
    )
  })

  it('screenshot scope=tab without target uses caller tab', async () => {
    process.env.FRESHELL_TAB_ID = 't-caller'
    setupTwoTabs()

    await executeAction('screenshot', { scope: 'tab', name: 'test' })
    expect(mockClient.post).toHaveBeenCalledWith(
      '/api/screenshots',
      expect.objectContaining({ scope: 'tab', tabId: 't-caller', name: 'test' }),
    )
  })

  it('bare numeric pane index resolves within caller tab, not active tab', async () => {
    process.env.FRESHELL_TAB_ID = 't-caller'
    setupTwoTabs()

    // summarize uses resolvePaneTarget which resolves bare indices
    await executeAction('summarize', { target: '0' })
    // Should resolve to p-caller (index 0 in t-caller), not p-active (index 0 in t-active)
    expect(mockClient.post).toHaveBeenCalledWith(
      expect.stringContaining('/api/ai/terminals/term-caller/summary'),
      expect.anything(),
    )
  })

  it('summarize without target uses caller pane', async () => {
    process.env.FRESHELL_TAB_ID = 't-caller'
    process.env.FRESHELL_PANE_ID = 'p-caller'
    setupTwoTabs()

    await executeAction('summarize')
    expect(mockClient.post).toHaveBeenCalledWith(
      expect.stringContaining('/api/ai/terminals/term-caller/summary'),
      expect.anything(),
    )
  })
})

describe('executeAction -- screenshot without target', () => {
  it('screenshot with scope=pane and no target resolves to active pane', async () => {
    mockClient.get.mockImplementation((path: string) => {
      if (path === '/api/tabs') return Promise.resolve({ tabs: [{ id: 't1', activePaneId: 'p1' }], activeTabId: 't1' })
      if (path.includes('/api/panes')) return Promise.resolve({ panes: [{ id: 'p1', terminalId: 'term-1' }] })
      return Promise.resolve({})
    })
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('screenshot', { scope: 'pane', name: 'test' })
    expect(mockClient.post).toHaveBeenCalledWith(
      '/api/screenshots',
      expect.objectContaining({ scope: 'pane', paneId: 'p1', name: 'test' }),
    )
  })

  it('screenshot with scope=tab and no target resolves to active tab', async () => {
    mockClient.get.mockResolvedValue({ tabs: [{ id: 't1', title: 'Work' }], activeTabId: 't1' })
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('screenshot', { scope: 'tab', name: 'test' })
    expect(mockClient.post).toHaveBeenCalledWith(
      '/api/screenshots',
      expect.objectContaining({ scope: 'tab', tabId: 't1', name: 'test' }),
    )
  })
})

describe('executeAction -- pane index resolution scoped to caller/active tab', () => {
  const origTabId = process.env.FRESHELL_TAB_ID
  afterEach(() => {
    if (origTabId !== undefined) process.env.FRESHELL_TAB_ID = origTabId
    else delete process.env.FRESHELL_TAB_ID
  })

  it('bare numeric index resolves within the active tab when no caller identity', async () => {
    // Clear caller identity so we test the active-tab fallback path
    delete process.env.FRESHELL_TAB_ID
    // Two tabs, each with a pane at index 0.
    // Tab t1 is first in array but NOT active; Tab t2 is active.
    // Bare index "0" should resolve to p2-a (active tab t2), NOT p1-a.
    mockClient.get.mockImplementation((path: string) => {
      if (path === '/api/tabs') {
        return Promise.resolve({
          tabs: [
            { id: 't1', title: 'Tab 1', activePaneId: 'p1-a' },
            { id: 't2', title: 'Tab 2', activePaneId: 'p2-a' },
          ],
          activeTabId: 't2',
        })
      }
      if (path.includes('tabId=t1')) {
        return Promise.resolve({ panes: [{ id: 'p1-a', index: 0, terminalId: 'term-1a' }] })
      }
      if (path.includes('tabId=t2')) {
        return Promise.resolve({ panes: [{ id: 'p2-a', index: 0, terminalId: 'term-2a' }] })
      }
      return Promise.resolve({ panes: [] })
    })
    mockClient.post.mockResolvedValue({ summary: 'test' })
    await executeAction('summarize', { target: '0' })
    // Must resolve to p2-a's terminal (active tab t2), not p1-a's
    expect(mockClient.post).toHaveBeenCalledWith(
      expect.stringContaining('/api/ai/terminals/term-2a/summary'),
      expect.anything(),
    )
  })

  it('UUID-like pane ID resolves across all tabs', async () => {
    // Pane p2-a is in tab t2 (not active). A UUID-like target should find it.
    mockClient.get.mockImplementation((path: string) => {
      if (path === '/api/tabs') {
        return Promise.resolve({
          tabs: [
            { id: 't1', title: 'Tab 1', activePaneId: 'p1-a' },
            { id: 't2', title: 'Tab 2', activePaneId: 'p2-a' },
          ],
          activeTabId: 't1',
        })
      }
      if (path.includes('tabId=t1')) {
        return Promise.resolve({ panes: [{ id: 'p1-a', index: 0, terminalId: 'term-1a' }] })
      }
      if (path.includes('tabId=t2')) {
        return Promise.resolve({ panes: [{ id: 'p2-a', index: 0, terminalId: 'term-2a' }] })
      }
      return Promise.resolve({ panes: [] })
    })
    mockClient.post.mockResolvedValue({ summary: 'test' })
    await executeAction('summarize', { target: 'p2-a' })
    // Must resolve to p2-a's terminal (cross-tab by ID)
    expect(mockClient.post).toHaveBeenCalledWith(
      expect.stringContaining('/api/ai/terminals/term-2a/summary'),
      expect.anything(),
    )
  })
})

describe('executeAction -- screenshot target resolution through resolvePaneTarget', () => {
  it('screenshot with scope=pane resolves name/index targets through resolvePaneTarget', async () => {
    // Bare index "0" should be resolved through resolvePaneTarget to a real pane ID
    mockClient.get.mockImplementation((path: string) => {
      if (path === '/api/tabs') {
        return Promise.resolve({
          tabs: [{ id: 't1', title: 'Tab 1', activePaneId: 'p1' }],
          activeTabId: 't1',
        })
      }
      if (path.includes('/api/panes')) {
        return Promise.resolve({ panes: [{ id: 'p1', index: 0, terminalId: 'term-1' }] })
      }
      return Promise.resolve({})
    })
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('screenshot', { scope: 'pane', target: '0', name: 'test' })
    // The API requires a real pane ID, not a bare index
    expect(mockClient.post).toHaveBeenCalledWith(
      '/api/screenshots',
      expect.objectContaining({ scope: 'pane', paneId: 'p1', name: 'test' }),
    )
  })
})

describe('executeAction -- pane title matching', () => {
  it('resolvePaneTarget matches pane by title when target is not numeric and not found by ID', async () => {
    // Pane has title 'My Terminal'. Non-numeric, non-ID target should match by title.
    mockClient.get.mockImplementation((path: string) => {
      if (path === '/api/tabs') {
        return Promise.resolve({
          tabs: [{ id: 't1', title: 'Tab 1', activePaneId: 'p1' }],
          activeTabId: 't1',
        })
      }
      if (path.includes('/api/panes')) {
        return Promise.resolve({
          panes: [
            { id: 'p1', index: 0, terminalId: 'term-1', title: 'My Terminal' },
            { id: 'p2', index: 1, terminalId: 'term-2', title: 'Other Pane' },
          ],
        })
      }
      return Promise.resolve({})
    })
    mockClient.post.mockResolvedValue({ summary: 'test' })
    await executeAction('summarize', { target: 'My Terminal' })
    // Must resolve to p1's terminal (matched by title)
    expect(mockClient.post).toHaveBeenCalledWith(
      expect.stringContaining('/api/ai/terminals/term-1/summary'),
      expect.anything(),
    )
  })

  it('resolvePaneTarget returns pane not found when title matches no pane', async () => {
    mockClient.get.mockImplementation((path: string) => {
      if (path === '/api/tabs') {
        return Promise.resolve({
          tabs: [{ id: 't1', title: 'Tab 1', activePaneId: 'p1' }],
          activeTabId: 't1',
        })
      }
      if (path.includes('/api/panes')) {
        return Promise.resolve({
          panes: [{ id: 'p1', index: 0, terminalId: 'term-1', title: 'My Terminal' }],
        })
      }
      return Promise.resolve({})
    })
    const result = await executeAction('summarize', { target: 'NonExistent Title' })
    expect(result).toHaveProperty('error')
    expect(result.error).toContain('not found')
  })

  it('resolvePaneTarget matches pane title across multiple tabs', async () => {
    // Pane with title 'Build' is in tab t2 (not active)
    mockClient.get.mockImplementation((path: string) => {
      if (path === '/api/tabs') {
        return Promise.resolve({
          tabs: [
            { id: 't1', title: 'Tab 1', activePaneId: 'p1' },
            { id: 't2', title: 'Tab 2', activePaneId: 'p2' },
          ],
          activeTabId: 't1',
        })
      }
      if (path.includes('tabId=t1')) {
        return Promise.resolve({
          panes: [{ id: 'p1', index: 0, terminalId: 'term-1', title: 'Code' }],
        })
      }
      if (path.includes('tabId=t2')) {
        return Promise.resolve({
          panes: [{ id: 'p2', index: 0, terminalId: 'term-2', title: 'Build' }],
        })
      }
      return Promise.resolve({ panes: [] })
    })
    mockClient.post.mockResolvedValue({ summary: 'test' })
    await executeAction('summarize', { target: 'Build' })
    // Must resolve to p2's terminal (title match in tab t2)
    expect(mockClient.post).toHaveBeenCalledWith(
      expect.stringContaining('/api/ai/terminals/term-2/summary'),
      expect.anything(),
    )
  })
})

describe('executeAction -- new-tab with prompt sends keys', () => {
  it('new-tab with prompt sends keys to the newly created pane', async () => {
    // The CLI (server/cli/index.ts:318) sends the prompt via send-keys after tab creation.
    // The MCP tool must replicate this behavior.
    mockClient.post.mockImplementation((path: string) => {
      if (path === '/api/tabs') {
        return Promise.resolve({ status: 'ok', data: { id: 't1', paneId: 'p-new' } })
      }
      return Promise.resolve({ ok: true })
    })
    await executeAction('new-tab', { name: 'Work', mode: 'claude', prompt: 'build the thing' })
    // First call: create tab
    expect(mockClient.post).toHaveBeenCalledWith('/api/tabs', expect.objectContaining({ name: 'Work', mode: 'claude' }))
    // Second call: send keys with prompt + \r
    expect(mockClient.post).toHaveBeenCalledWith(
      '/api/panes/p-new/send-keys',
      expect.objectContaining({ data: 'build the thing\r' }),
    )
  })

  it('new-tab without prompt does not send keys', async () => {
    mockClient.post.mockResolvedValue({ status: 'ok', data: { id: 't1', paneId: 'p-new' } })
    await executeAction('new-tab', { name: 'Work', mode: 'claude' })
    // Only one call -- no send-keys
    expect(mockClient.post).toHaveBeenCalledTimes(1)
    expect(mockClient.post).toHaveBeenCalledWith('/api/tabs', expect.objectContaining({ name: 'Work', mode: 'claude' }))
  })

  it('new-tab with prompt but no paneId in response does not send keys', async () => {
    // If the response doesn't include a paneId (unexpected but defensive), don't crash
    mockClient.post.mockResolvedValue({ status: 'ok', data: { id: 't1' } })
    await executeAction('new-tab', { name: 'Work', prompt: 'hello' })
    expect(mockClient.post).toHaveBeenCalledTimes(1)
  })
})

describe('executeAction -- ambiguous pane title error', () => {
  it('resolvePaneTarget returns error when multiple panes share the same title and suggests using pane ID', async () => {
    // CLI returns an explicit ambiguity error (server/cli/targets.ts:68).
    // MCP tool must do the same, not silently pick the first match.
    // Review fix: error message must suggest using the pane ID directly, NOT tab.pane syntax.
    mockClient.get.mockImplementation((path: string) => {
      if (path === '/api/tabs') {
        return Promise.resolve({
          tabs: [
            { id: 't1', title: 'Tab 1', activePaneId: 'p1' },
            { id: 't2', title: 'Tab 2', activePaneId: 'p2' },
          ],
          activeTabId: 't1',
        })
      }
      if (path.includes('tabId=t1')) {
        return Promise.resolve({
          panes: [{ id: 'p1', index: 0, terminalId: 'term-1', title: 'Build' }],
        })
      }
      if (path.includes('tabId=t2')) {
        return Promise.resolve({
          panes: [{ id: 'p2', index: 0, terminalId: 'term-2', title: 'Build' }],
        })
      }
      return Promise.resolve({ panes: [] })
    })
    const result = await executeAction('summarize', { target: 'Build' })
    // Must return an error, not silently pick the first match
    expect(result).toHaveProperty('error')
    expect(result.error).toContain('ambiguous')
    // Review fix: error must suggest using pane ID directly, NOT tab.pane syntax
    expect(result.error).toContain('pane ID')
    expect(result.error).not.toContain('tab.pane')
  })

  it('resolvePaneTarget succeeds when pane title is unique across all tabs', async () => {
    // Single match should work fine
    mockClient.get.mockImplementation((path: string) => {
      if (path === '/api/tabs') {
        return Promise.resolve({
          tabs: [
            { id: 't1', title: 'Tab 1', activePaneId: 'p1' },
            { id: 't2', title: 'Tab 2', activePaneId: 'p2' },
          ],
          activeTabId: 't1',
        })
      }
      if (path.includes('tabId=t1')) {
        return Promise.resolve({
          panes: [{ id: 'p1', index: 0, terminalId: 'term-1', title: 'Code' }],
        })
      }
      if (path.includes('tabId=t2')) {
        return Promise.resolve({
          panes: [{ id: 'p2', index: 0, terminalId: 'term-2', title: 'Build' }],
        })
      }
      return Promise.resolve({ panes: [] })
    })
    mockClient.post.mockResolvedValue({ summary: 'test' })
    await executeAction('summarize', { target: 'Build' })
    // Must resolve to p2's terminal (unique title match)
    expect(mockClient.post).toHaveBeenCalledWith(
      expect.stringContaining('/api/ai/terminals/term-2/summary'),
      expect.anything(),
    )
  })
})

describe('executeAction -- tmux aliases', () => {
  it('new-window routes to new-tab', async () => {
    mockClient.post.mockResolvedValue({ id: 't1' })
    await executeAction('new-window', { name: 'Work', mode: 'claude' })
    expect(mockClient.post).toHaveBeenCalledWith('/api/tabs', expect.objectContaining({ name: 'Work', mode: 'claude' }))
  })

  it('new-session routes to new-tab', async () => {
    mockClient.post.mockResolvedValue({ id: 't1' })
    await executeAction('new-session', { name: 'Work' })
    expect(mockClient.post).toHaveBeenCalledWith('/api/tabs', expect.objectContaining({ name: 'Work' }))
  })

  it('list-windows routes to list-tabs', async () => {
    mockClient.get.mockResolvedValue({ tabs: [] })
    await executeAction('list-windows')
    expect(mockClient.get).toHaveBeenCalledWith('/api/tabs')
  })

  it('select-window routes to select-tab', async () => {
    mockClient.get.mockResolvedValue({ tabs: [{ id: 't1', title: 'Work' }], activeTabId: 't1' })
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('select-window', { target: 'Work' })
    expect(mockClient.post).toHaveBeenCalledWith('/api/tabs/t1/select', {})
  })

  it('kill-window routes to kill-tab', async () => {
    mockClient.get.mockResolvedValue({ tabs: [{ id: 't1', title: 'Work' }], activeTabId: 't1' })
    mockClient.delete.mockResolvedValue({ ok: true })
    await executeAction('kill-window', { target: 'Work' })
    expect(mockClient.delete).toHaveBeenCalledWith('/api/tabs/t1')
  })

  it('rename-window routes to rename-tab', async () => {
    mockClient.get.mockResolvedValue({ tabs: [{ id: 't1', title: 'Old' }], activeTabId: 't1' })
    mockClient.patch.mockResolvedValue({ ok: true })
    await executeAction('rename-window', { target: 'Old', name: 'New' })
    expect(mockClient.patch).toHaveBeenCalledWith('/api/tabs/t1', { name: 'New' })
  })

  it('next-window routes to next-tab', async () => {
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('next-window')
    expect(mockClient.post).toHaveBeenCalledWith('/api/tabs/next', {})
  })

  it('previous-window routes to prev-tab', async () => {
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('previous-window')
    expect(mockClient.post).toHaveBeenCalledWith('/api/tabs/prev', {})
  })

  it('prev-window routes to prev-tab', async () => {
    mockClient.post.mockResolvedValue({ ok: true })
    await executeAction('prev-window')
    expect(mockClient.post).toHaveBeenCalledWith('/api/tabs/prev', {})
  })

  it('split-window routes to split-pane', async () => {
    mockClient.get.mockResolvedValue({
      tabs: [{ id: 't1', title: 'Tab', activePaneId: 'p1' }],
      activeTabId: 't1',
    })
    // fetchPanes for the active tab
    mockClient.get.mockImplementation((path: string) => {
      if (path === '/api/tabs') {
        return Promise.resolve({ tabs: [{ id: 't1', activePaneId: 'p1' }], activeTabId: 't1' })
      }
      if (path.includes('/api/panes')) {
        return Promise.resolve({ panes: [{ id: 'p1', index: 0 }] })
      }
      return Promise.resolve({})
    })
    mockClient.post.mockResolvedValue({ paneId: 'p2' })
    await executeAction('split-window', { direction: 'horizontal' })
    expect(mockClient.post).toHaveBeenCalledWith(
      expect.stringContaining('/api/panes/p1/split'),
      expect.objectContaining({ direction: 'horizontal' }),
    )
  })

  it('display-message routes to display', async () => {
    mockClient.get.mockImplementation((path: string) => {
      if (path === '/api/tabs') {
        return Promise.resolve({ tabs: [{ id: 't1', title: 'Work', activePaneId: 'p1' }], activeTabId: 't1' })
      }
      if (path.includes('/api/panes')) {
        return Promise.resolve({ panes: [{ id: 'p1', index: 0, kind: 'terminal', terminalId: 'term-1' }] })
      }
      return Promise.resolve({})
    })
    const result = await executeAction('display-message', { format: '#S' })
    expect(result).toBe('Work')
  })

  it('screenshot-pane routes to screenshot with scope=pane', async () => {
    mockClient.get.mockImplementation((path: string) => {
      if (path === '/api/tabs') {
        return Promise.resolve({ tabs: [{ id: 't1', activePaneId: 'p1' }], activeTabId: 't1' })
      }
      if (path.includes('/api/panes')) {
        return Promise.resolve({ panes: [{ id: 'p1', index: 0 }] })
      }
      return Promise.resolve({})
    })
    mockClient.post.mockResolvedValue({ path: '/tmp/screenshot.png' })
    await executeAction('screenshot-pane', { target: 'p1', name: 'test' })
    expect(mockClient.post).toHaveBeenCalledWith('/api/screenshots', expect.objectContaining({ scope: 'pane', name: 'test', paneId: 'p1' }))
  })

  it('screenshot-tab routes to screenshot with scope=tab', async () => {
    mockClient.get.mockResolvedValue({ tabs: [{ id: 't1', title: 'Work' }], activeTabId: 't1' })
    mockClient.post.mockResolvedValue({ path: '/tmp/screenshot.png' })
    await executeAction('screenshot-tab', { target: 'Work', name: 'test' })
    expect(mockClient.post).toHaveBeenCalledWith('/api/screenshots', expect.objectContaining({ scope: 'tab', name: 'test', tabId: 't1' }))
  })

  it('screenshot-view routes to screenshot with scope=view', async () => {
    mockClient.post.mockResolvedValue({ path: '/tmp/screenshot.png' })
    await executeAction('screenshot-view', { name: 'test' })
    expect(mockClient.post).toHaveBeenCalledWith('/api/screenshots', expect.objectContaining({ scope: 'view', name: 'test' }))
  })

  it('truly unknown action still returns error', async () => {
    const result = await executeAction('totally-fake-action')
    expect(result).toHaveProperty('error')
    expect(result.error).toContain("Unknown action 'totally-fake-action'")
  })
})

describe('executeAction -- error handling', () => {
  it('unknown action returns error with hint', async () => {
    const result = await executeAction('nonexistent-action')
    expect(result).toHaveProperty('error')
    expect(result.error).toContain("Unknown action 'nonexistent-action'")
    expect(result.error).toContain('help')
  })

  it('missing required param returns error with hint', async () => {
    const result = await executeAction('kill-tab', {})
    expect(result).toHaveProperty('error')
  })

  it('API error wraps with recovery hint', async () => {
    mockClient.get.mockRejectedValue(new Error('ECONNREFUSED'))
    const result = await executeAction('health')
    expect(result).toHaveProperty('error')
    expect(result).toHaveProperty('hint')
    expect(result.hint).toContain('Freshell')
  })
})

describe('executeAction -- parameter validation', () => {
  it('new-tab with url param returns error suggesting open-browser', async () => {
    const result = await executeAction('new-tab', { url: 'https://example.com' })
    expect(result).toHaveProperty('error')
    expect(result.error).toContain('open-browser')
    expect(result).toHaveProperty('hint')
    expect(result.hint).toContain('Valid params')
  })

  it('new-tab with url and name returns error about url', async () => {
    const result = await executeAction('new-tab', { url: 'https://example.com', name: 'My Tab' })
    expect(result).toHaveProperty('error')
    expect(result.error).toContain('url')
    expect(result.error).toContain('open-browser')
  })

  it('unknown param on any action returns error listing valid params', async () => {
    const result = await executeAction('screenshot', { scope: 'pane', badparam: 'value' })
    expect(result).toHaveProperty('error')
    expect(result.error).toContain('badparam')
    expect(result).toHaveProperty('hint')
    expect(result.hint).toContain('Valid params')
  })

  it('multiple unknown params returns error listing all of them', async () => {
    const result = await executeAction('health', { foo: 1, bar: 2 })
    expect(result).toHaveProperty('error')
    expect(result.error).toContain('foo')
    expect(result.error).toContain('bar')
    expect(result.hint).toContain('(none)')
  })

  it('valid params pass through without error', async () => {
    mockClient.post.mockResolvedValue({ id: 't1' })
    const result = await executeAction('new-tab', { name: 'Work', mode: 'claude' })
    expect(result).not.toHaveProperty('error')
    expect(mockClient.post).toHaveBeenCalledWith('/api/tabs', expect.objectContaining({ name: 'Work', mode: 'claude' }))
  })

  it('tmux alias validates params against the resolved action', async () => {
    const result = await executeAction('new-window', { unknownParam: 'value' })
    expect(result).toHaveProperty('error')
    expect(result.error).toContain('unknownParam')
  })

  it('tmux alias with valid params routes through', async () => {
    mockClient.post.mockResolvedValue({ id: 't1' })
    const result = await executeAction('new-window', { name: 'Work', mode: 'claude' })
    expect(result).not.toHaveProperty('error')
    expect(mockClient.post).toHaveBeenCalledWith('/api/tabs', expect.objectContaining({ name: 'Work', mode: 'claude' }))
  })

  it('tmux alias surfaces common confusion hints', async () => {
    const result = await executeAction('new-window', { url: 'https://example.com' })
    expect(result).toHaveProperty('error')
    expect(result.error).toContain('open-browser')
  })

  it('empty params on paramless action succeeds', async () => {
    mockClient.get.mockResolvedValue({ ok: true })
    const result = await executeAction('health')
    expect(result).not.toHaveProperty('error')
  })

  it('help text mentions open-browser for URLs', async () => {
    const result = await executeAction('help')
    const text = typeof result === 'string' ? result : JSON.stringify(result)
    expect(text).toContain("use 'open-browser'")
    expect(text).toContain('open-browser')
    expect(text).toContain('Playbook: open a URL')
  })
})
