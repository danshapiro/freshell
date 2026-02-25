import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TerminalRegistry } from '../../../server/terminal-registry'
import * as pty from 'node-pty'
import * as fs from 'fs'

vi.mock('fs', () => {
  const existsSync = vi.fn()
  const statSync = vi.fn()
  return {
    existsSync,
    statSync,
    default: { existsSync, statSync },
  }
})

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}))

vi.mock('../../../server/logger', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  }
  logger.child.mockReturnValue(logger)
  return { logger }
})

describe('TerminalRegistry env injection', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fs.existsSync).mockReturnValue(true)
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('adds FRESHELL env vars on create', () => {
    process.env.AUTH_TOKEN = 'test-token-1234567890'
    const registry = new TerminalRegistry()
    registry.create({ mode: 'shell', envContext: { tabId: 'tab_x', paneId: 'pane_y' } })
    const call = vi.mocked(pty.spawn).mock.calls[0]
    const env = call[2].env as Record<string, string>
    expect(env.FRESHELL).toBe('1')
    expect(env.FRESHELL_TAB_ID).toBe('tab_x')
    expect(env.FRESHELL_PANE_ID).toBe('pane_y')
  })
})
