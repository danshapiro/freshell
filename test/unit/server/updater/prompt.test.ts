// test/unit/server/updater/prompt.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as readline from 'readline'
import { EventEmitter } from 'events'
import { formatUpdateBanner, promptForUpdate } from '../../../../server/updater/prompt.js'

// Mock readline module
vi.mock('readline')

describe('formatUpdateBanner', () => {
  it('contains "new Freshell" in the output', () => {
    const banner = formatUpdateBanner('1.0.0', '2.0.0')
    expect(banner).toContain('new Freshell')
  })

  it('contains the current version string', () => {
    const banner = formatUpdateBanner('1.2.3', '2.0.0')
    expect(banner).toContain('1.2.3')
  })

  it('contains the latest version string', () => {
    const banner = formatUpdateBanner('1.0.0', '2.5.0')
    expect(banner).toContain('2.5.0')
  })

  it('contains both version strings in a single banner', () => {
    const banner = formatUpdateBanner('0.1.0', '0.2.0')
    expect(banner).toContain('0.1.0')
    expect(banner).toContain('0.2.0')
  })

  it('includes an arrow between versions', () => {
    const banner = formatUpdateBanner('1.0.0', '2.0.0')
    // The arrow should indicate upgrade direction
    expect(banner).toMatch(/1\.0\.0.*→.*2\.0\.0/)
  })

  it('handles longer version strings gracefully', () => {
    const banner = formatUpdateBanner('10.20.30', '100.200.300')
    expect(banner).toContain('10.20.30')
    expect(banner).toContain('100.200.300')
    expect(banner).toContain('new Freshell')
  })

  it('handles version strings that exceed banner width without breaking', () => {
    // Very long version strings that exceed the banner width
    const banner = formatUpdateBanner('1.0.0-alpha.super.long.version.string', '2.0.0-beta.another.extremely.long.version')
    expect(banner).toContain('1.0.0-alpha.super.long.version.string')
    expect(banner).toContain('2.0.0-beta.another.extremely.long.version')
    // Should not throw - negative padding is handled with Math.max(0, ...)
    expect(banner).toContain('╭')
    expect(banner).toContain('╰')
  })

  it('produces a multiline banner with box drawing characters', () => {
    const banner = formatUpdateBanner('1.0.0', '2.0.0')
    // Should have top-left and bottom-left corner characters
    expect(banner).toContain('╭')
    expect(banner).toContain('╰')
  })
})

describe('promptForUpdate', () => {
  let mockRl: EventEmitter & {
    question: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let originalIsTTY: boolean | undefined

  beforeEach(() => {
    // Create mock readline interface with EventEmitter capabilities
    const emitter = new EventEmitter()
    mockRl = Object.assign(emitter, {
      question: vi.fn(),
      close: vi.fn()
    })
    vi.mocked(readline.createInterface).mockReturnValue(mockRl as unknown as readline.Interface)
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    // Save original isTTY and set to true by default for most tests
    originalIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    // Restore original isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, writable: true })
  })

  it('returns true for empty input (default yes)', async () => {
    mockRl.question.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
      callback('')
    })

    const result = await promptForUpdate('1.0.0', '2.0.0')
    expect(result).toBe(true)
    expect(mockRl.close).toHaveBeenCalled()
  })

  it('returns true for "Y" input', async () => {
    mockRl.question.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
      callback('Y')
    })

    const result = await promptForUpdate('1.0.0', '2.0.0')
    expect(result).toBe(true)
  })

  it('returns true for "y" input', async () => {
    mockRl.question.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
      callback('y')
    })

    const result = await promptForUpdate('1.0.0', '2.0.0')
    expect(result).toBe(true)
  })

  it('returns true for "yes" input', async () => {
    mockRl.question.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
      callback('yes')
    })

    const result = await promptForUpdate('1.0.0', '2.0.0')
    expect(result).toBe(true)
  })

  it('returns true for "YES" input', async () => {
    mockRl.question.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
      callback('YES')
    })

    const result = await promptForUpdate('1.0.0', '2.0.0')
    expect(result).toBe(true)
  })

  it('returns false for "n" input', async () => {
    mockRl.question.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
      callback('n')
    })

    const result = await promptForUpdate('1.0.0', '2.0.0')
    expect(result).toBe(false)
  })

  it('returns false for "N" input', async () => {
    mockRl.question.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
      callback('N')
    })

    const result = await promptForUpdate('1.0.0', '2.0.0')
    expect(result).toBe(false)
  })

  it('returns false for "no" input', async () => {
    mockRl.question.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
      callback('no')
    })

    const result = await promptForUpdate('1.0.0', '2.0.0')
    expect(result).toBe(false)
  })

  it('returns false for "NO" input', async () => {
    mockRl.question.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
      callback('NO')
    })

    const result = await promptForUpdate('1.0.0', '2.0.0')
    expect(result).toBe(false)
  })

  it('displays the update banner before prompting', async () => {
    mockRl.question.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
      callback('y')
    })

    await promptForUpdate('1.0.0', '2.0.0')

    expect(consoleLogSpy).toHaveBeenCalled()
    const loggedContent = consoleLogSpy.mock.calls[0][0]
    expect(loggedContent).toContain('new Freshell')
    expect(loggedContent).toContain('1.0.0')
    expect(loggedContent).toContain('2.0.0')
  })

  it('handles input with leading/trailing whitespace', async () => {
    mockRl.question.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
      callback('  y  ')
    })

    const result = await promptForUpdate('1.0.0', '2.0.0')
    expect(result).toBe(true)
  })

  it('returns false for unexpected input', async () => {
    mockRl.question.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
      callback('maybe')
    })

    const result = await promptForUpdate('1.0.0', '2.0.0')
    expect(result).toBe(false)
  })

  it('returns false when readline emits close event (EOF/Ctrl+D)', async () => {
    // Simulate readline close without answering (e.g., Ctrl+D)
    mockRl.question.mockImplementation(() => {
      // Emit close event after a short delay, simulating EOF
      setImmediate(() => {
        mockRl.emit('close')
      })
    })

    const result = await promptForUpdate('1.0.0', '2.0.0')
    expect(result).toBe(false)
  })

  it('returns false in non-interactive mode (no TTY)', async () => {
    // Set stdin to non-TTY mode
    Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true })

    const result = await promptForUpdate('1.0.0', '2.0.0')

    expect(result).toBe(false)
    // Should log non-interactive message
    expect(consoleLogSpy).toHaveBeenCalledWith('Non-interactive mode detected, skipping update prompt.')
    // Should not create readline interface
    expect(readline.createInterface).not.toHaveBeenCalled()
  })

  it('still displays banner in non-interactive mode before skipping', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true })

    await promptForUpdate('1.0.0', '2.0.0')

    // Banner should still be displayed
    const loggedContent = consoleLogSpy.mock.calls[0][0]
    expect(loggedContent).toContain('new Freshell')
    expect(loggedContent).toContain('1.0.0')
    expect(loggedContent).toContain('2.0.0')
  })
})
