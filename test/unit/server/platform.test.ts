import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fsPromises from 'fs/promises'

// Mock fs/promises
vi.mock('fs/promises')

// Import after mocking
import { detectPlatform } from '../../../server/platform.js'

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
