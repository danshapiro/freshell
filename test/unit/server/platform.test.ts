import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import fsPromises from 'fs/promises'

// Mock fs (sync) and fs/promises (async) separately
vi.mock('fs')
vi.mock('fs/promises')

// Import after mocking
import { detectPlatform, isWSL2, isWSL } from '../../../server/platform.js'

describe('detectPlatform', () => {
  const mockReadFile = vi.mocked(fsPromises.readFile)
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    // Restore original platform
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('returns process.platform on non-Linux platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })

    const result = await detectPlatform()

    expect(result).toBe('darwin')
    expect(mockReadFile).not.toHaveBeenCalled()
  })

  it('returns win32 on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })

    const result = await detectPlatform()

    expect(result).toBe('win32')
    expect(mockReadFile).not.toHaveBeenCalled()
  })

  it('returns wsl when /proc/version contains "microsoft"', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    mockReadFile.mockResolvedValue(
      'Linux version 5.15.167.4-microsoft-standard-WSL2 (root@...) (gcc ...)'
    )

    const result = await detectPlatform()

    expect(result).toBe('wsl')
    expect(mockReadFile).toHaveBeenCalledWith('/proc/version', 'utf-8')
  })

  it('returns wsl when /proc/version contains "WSL" (case insensitive)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    mockReadFile.mockResolvedValue(
      'Linux version 5.15.0-WSL2 (gcc version 9.3.0)'
    )

    const result = await detectPlatform()

    expect(result).toBe('wsl')
  })

  it('returns linux when /proc/version does not contain WSL markers', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    mockReadFile.mockResolvedValue(
      'Linux version 5.15.0-generic (buildd@lcy02-amd64-047)'
    )

    const result = await detectPlatform()

    expect(result).toBe('linux')
  })

  it('returns linux when /proc/version cannot be read', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file or directory'))

    const result = await detectPlatform()

    expect(result).toBe('linux')
  })

  it('handles empty /proc/version file', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    mockReadFile.mockResolvedValue('')

    const result = await detectPlatform()

    expect(result).toBe('linux')
  })
})

describe('isWSL2', () => {
  const mockReadFileSync = vi.mocked(readFileSync)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns true when /proc/version contains "microsoft-standard"', () => {
    mockReadFileSync.mockReturnValue('Linux version 5.15.167.4-microsoft-standard-WSL2')

    expect(isWSL2()).toBe(true)
  })

  it('returns true when /proc/version contains "wsl2"', () => {
    mockReadFileSync.mockReturnValue('Linux version 5.15.0-WSL2 (gcc version 9.3.0)')

    expect(isWSL2()).toBe(true)
  })

  it('returns false for WSL1 (has "Microsoft" but not WSL2 patterns)', () => {
    mockReadFileSync.mockReturnValue('Linux version 4.4.0-18362-Microsoft')

    expect(isWSL2()).toBe(false)
  })

  it('returns false for non-WSL Linux', () => {
    mockReadFileSync.mockReturnValue('Linux version 5.15.0-generic (buildd@lcy02-amd64-047)')

    expect(isWSL2()).toBe(false)
  })

  it('returns false when /proc/version cannot be read', () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT') })

    expect(isWSL2()).toBe(false)
  })
})

describe('isWSL', () => {
  const mockReadFileSync = vi.mocked(readFileSync)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns true for WSL2', () => {
    mockReadFileSync.mockReturnValue('Linux version 5.15.167.4-microsoft-standard-WSL2')

    expect(isWSL()).toBe(true)
  })

  it('returns true for WSL1', () => {
    mockReadFileSync.mockReturnValue('Linux version 4.4.0-18362-Microsoft')

    expect(isWSL()).toBe(true)
  })

  it('returns false for non-WSL Linux', () => {
    mockReadFileSync.mockReturnValue('Linux version 5.15.0-generic (buildd@lcy02-amd64-047)')

    expect(isWSL()).toBe(false)
  })

  it('returns false when /proc/version cannot be read', () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT') })

    expect(isWSL()).toBe(false)
  })
})
