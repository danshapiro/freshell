// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock child_process for spawnAndMonitor tests (hoisted above all imports)
const mockSpawn = vi.fn()
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
  }
})

// Dynamic import so the mock is in place when file-opener loads
const { resolveOpenCommand } = await import('../../../server/file-opener')

describe('resolveOpenCommand', () => {
  describe('with no custom editor configured (auto)', () => {
    it('uses "open" on macOS', async () => {
      const result = await resolveOpenCommand({
        filePath: '/Users/me/file.ts',
        platform: 'darwin',
      })
      expect(result.command).toBe('open')
      expect(result.args).toEqual(['/Users/me/file.ts'])
    })

    it('uses "open -R" for reveal on macOS', async () => {
      const result = await resolveOpenCommand({
        filePath: '/Users/me/file.ts',
        reveal: true,
        platform: 'darwin',
      })
      expect(result.command).toBe('open')
      expect(result.args).toEqual(['-R', '/Users/me/file.ts'])
    })

    it('uses "cmd /c start" on win32', async () => {
      const result = await resolveOpenCommand({
        filePath: 'C:\\Users\\me\\file.ts',
        platform: 'win32',
      })
      expect(result.command).toBe('cmd')
      expect(result.args).toEqual(['/c', 'start', '', 'C:\\Users\\me\\file.ts'])
    })

    it('uses "explorer.exe /select," for reveal on win32', async () => {
      const result = await resolveOpenCommand({
        filePath: 'C:\\Users\\me\\file.ts',
        reveal: true,
        platform: 'win32',
      })
      expect(result.command).toBe('explorer.exe')
      expect(result.args).toEqual(['/select,', 'C:\\Users\\me\\file.ts'])
    })

    it('uses "xdg-open" on native linux', async () => {
      const result = await resolveOpenCommand({
        filePath: '/home/user/file.ts',
        platform: 'linux',
      })
      expect(result.command).toBe('xdg-open')
      expect(result.args).toEqual(['/home/user/file.ts'])
    })

    it('uses "explorer.exe /select," for reveal on WSL2', async () => {
      const result = await resolveOpenCommand({
        filePath: '/home/user/file.ts',
        reveal: true,
        platform: 'wsl',
      })
      expect(result.command).toBe('explorer.exe')
    })

    it('uses "cmd.exe /c start" for non-reveal on WSL2 (no editor)', async () => {
      const result = await resolveOpenCommand({
        filePath: '/home/user/file.ts',
        platform: 'wsl',
      })
      // WSL2 auto: falls back to Windows start command
      expect(result.command).toBe('/mnt/c/Windows/System32/cmd.exe')
      expect(result.args).toEqual(['/c', 'start', '', '/home/user/file.ts'])
    })
  })

  describe('with editor preset', () => {
    it('uses cursor with -r -g and line:col', async () => {
      const result = await resolveOpenCommand({
        filePath: '/home/user/file.ts',
        line: 42,
        column: 10,
        editorSetting: 'cursor',
        platform: 'linux',
      })
      expect(result.command).toBe('cursor')
      expect(result.args).toEqual(['-r', '-g', '/home/user/file.ts:42:10'])
    })

    it('uses code with -g and line:col', async () => {
      const result = await resolveOpenCommand({
        filePath: '/home/user/file.ts',
        line: 5,
        editorSetting: 'code',
        platform: 'linux',
      })
      expect(result.command).toBe('code')
      expect(result.args).toEqual(['-g', '/home/user/file.ts:5'])
    })

    it('omits line:col when not provided', async () => {
      const result = await resolveOpenCommand({
        filePath: '/home/user/file.ts',
        editorSetting: 'cursor',
        platform: 'linux',
      })
      expect(result.command).toBe('cursor')
      expect(result.args).toEqual(['-r', '-g', '/home/user/file.ts'])
    })

    it('falls back to platform default for reveal even with editor set', async () => {
      const result = await resolveOpenCommand({
        filePath: '/home/user/file.ts',
        reveal: true,
        editorSetting: 'cursor',
        platform: 'darwin',
      })
      // reveal always uses the platform file manager, not the editor
      expect(result.command).toBe('open')
      expect(result.args).toEqual(['-R', '/home/user/file.ts'])
    })
  })

  describe('with custom editor template', () => {
    it('substitutes {file}, {line}, {col} placeholders', async () => {
      const result = await resolveOpenCommand({
        filePath: '/home/user/file.ts',
        line: 10,
        column: 5,
        editorSetting: 'custom',
        customEditorCommand: 'nvim +{line} {file}',
        platform: 'linux',
      })
      expect(result.command).toBe('nvim')
      expect(result.args).toEqual(['+10', '/home/user/file.ts'])
    })

    it('removes unfilled placeholders when line/col not provided', async () => {
      const result = await resolveOpenCommand({
        filePath: '/home/user/file.ts',
        editorSetting: 'custom',
        customEditorCommand: 'myeditor --file {file} --line {line}',
        platform: 'linux',
      })
      expect(result.command).toBe('myeditor')
      expect(result.args).toEqual(['--file', '/home/user/file.ts'])
    })

    it('falls back to auto when custom is set but command is empty', async () => {
      const result = await resolveOpenCommand({
        filePath: '/home/user/file.ts',
        editorSetting: 'custom',
        customEditorCommand: '',
        platform: 'darwin',
      })
      expect(result.command).toBe('open')
    })
  })
})

describe('spawnAndMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns ok when process does not exit within timeout', async () => {
    mockSpawn.mockReturnValue({
      unref: vi.fn(),
      on: vi.fn(), // never calls the 'error' or 'exit' callback
      removeListener: vi.fn(),
    })
    const { spawnAndMonitor } = await import('../../../server/file-opener')
    const resultPromise = spawnAndMonitor({ command: 'cursor', args: ['-g', 'file.ts'] })
    await vi.advanceTimersByTimeAsync(2000)
    const result = await resultPromise
    expect(result.ok).toBe(true)
  })

  it('returns error when process exits immediately with non-zero', async () => {
    mockSpawn.mockReturnValue({
      unref: vi.fn(),
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === 'exit') setTimeout(() => cb(127), 10)
      }),
      removeListener: vi.fn(),
    })
    const { spawnAndMonitor } = await import('../../../server/file-opener')
    const resultPromise = spawnAndMonitor({ command: 'nonexistent', args: [] })
    await vi.advanceTimersByTimeAsync(10)
    const result = await resultPromise
    expect(result.ok).toBe(false)
    expect(result.error).toContain('exited')
  })

  it('returns error when spawn emits error event', async () => {
    mockSpawn.mockReturnValue({
      unref: vi.fn(),
      on: vi.fn((event: string, cb: (err: Error) => void) => {
        if (event === 'error') setTimeout(() => cb(new Error('ENOENT')), 10)
      }),
      removeListener: vi.fn(),
    })
    const { spawnAndMonitor } = await import('../../../server/file-opener')
    const resultPromise = spawnAndMonitor({ command: 'nonexistent', args: [] })
    await vi.advanceTimersByTimeAsync(10)
    const result = await resultPromise
    expect(result.ok).toBe(false)
    expect(result.error).toContain('ENOENT')
  })

  it('cleans up listeners after timeout resolves', async () => {
    const mockRemoveListener = vi.fn()
    mockSpawn.mockReturnValue({
      unref: vi.fn(),
      on: vi.fn(),
      removeListener: mockRemoveListener,
    })
    const { spawnAndMonitor } = await import('../../../server/file-opener')
    const resultPromise = spawnAndMonitor({ command: 'cursor', args: [] })
    await vi.advanceTimersByTimeAsync(2000)
    await resultPromise
    // Should have removed both 'error' and 'exit' listeners
    expect(mockRemoveListener).toHaveBeenCalledTimes(2)
  })

  it('does not double-resolve when exit fires after error', async () => {
    let errorCb: ((err: Error) => void) | undefined
    let exitCb: ((code: number) => void) | undefined
    mockSpawn.mockReturnValue({
      unref: vi.fn(),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'error') errorCb = cb as (err: Error) => void
        if (event === 'exit') exitCb = cb as (code: number) => void
      }),
      removeListener: vi.fn(),
    })
    const { spawnAndMonitor } = await import('../../../server/file-opener')
    const resultPromise = spawnAndMonitor({ command: 'nonexistent', args: [] })

    // Fire error first, then exit — should only resolve once
    errorCb!(new Error('ENOENT'))
    exitCb!(1)

    const result = await resultPromise
    expect(result.ok).toBe(false)
    expect(result.error).toContain('ENOENT')
  })
})
