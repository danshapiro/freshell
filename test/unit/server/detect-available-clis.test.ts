import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    default: {
      ...actual,
      execFile: mockExecFile,
    },
  }
})

import { detectAvailableClis } from '../../../server/platform.js'

function stubExecFile(isAvailable: (cmd: string) => boolean) {
  mockExecFile.mockImplementation((_finder: string, args: string[], _opts: any, cb: any) => {
    const target = args[0]
    if (isAvailable(target)) {
      cb(null, '/usr/bin/' + target, '')
    } else {
      cb(new Error('not found'), '', '')
    }
  })
}

describe('detectAvailableClis', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    stubExecFile(() => false)
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('returns an object with boolean values for known CLIs', async () => {
    const result = await detectAvailableClis()
    expect(typeof result.claude).toBe('boolean')
    expect(typeof result.codex).toBe('boolean')
    expect(typeof result.opencode).toBe('boolean')
    expect(typeof result.gemini).toBe('boolean')
    expect(typeof result.kimi).toBe('boolean')
  })

  it('returns true for CLIs found on PATH', async () => {
    stubExecFile((cmd) => cmd === 'claude' || cmd === 'codex')

    const result = await detectAvailableClis()
    expect(result.claude).toBe(true)
    expect(result.codex).toBe(true)
    expect(result.opencode).toBe(false)
  })

  it('returns false for all CLIs when none are installed', async () => {
    const result = await detectAvailableClis()
    expect(result.claude).toBe(false)
    expect(result.codex).toBe(false)
    expect(result.opencode).toBe(false)
    expect(result.gemini).toBe(false)
    expect(result.kimi).toBe(false)
  })

  it('respects env var overrides for command names', async () => {
    process.env.CLAUDE_CMD = 'my-claude'
    stubExecFile((cmd) => cmd === 'my-claude')

    const result = await detectAvailableClis()
    expect(result.claude).toBe(true)
  })

  it('uses the correct finder command for the current platform', async () => {
    stubExecFile(() => true)
    await detectAvailableClis()
    const expectedFinder = process.platform === 'win32' ? 'where.exe' : 'which'
    expect(mockExecFile).toHaveBeenCalledWith(
      expectedFinder,
      expect.any(Array),
      expect.objectContaining({ timeout: 3000 }),
      expect.any(Function)
    )
  })
})
