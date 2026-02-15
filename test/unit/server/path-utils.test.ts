import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'path'
import os from 'os'
import {
  convertWindowsPathToWslPath,
  detectUserPathFlavor,
  isPathAllowed,
  normalizePath,
  normalizeUserPath,
  resolveUserPath,
  toFilesystemPath,
  toFilesystemPathSync,
} from '../../../server/path-utils'

// Mock logger to prevent console output in tests
vi.mock('../../../server/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

describe('path-utils', () => {
  describe('normalizePath', () => {
    it('resolves relative paths to absolute', () => {
      const result = normalizePath('foo/bar')
      expect(path.isAbsolute(result)).toBe(true)
    })

    it('resolves .. sequences', () => {
      const result = normalizePath('/home/user/projects/../other')
      expect(result).toBe(path.normalize('/home/user/other'))
    })

    it('handles trailing slashes', () => {
      const result = normalizePath('/home/user/')
      expect(result).toBe(path.normalize('/home/user'))
    })

    it('handles tilde expansion', () => {
      const result = normalizePath('~/projects')
      expect(path.isAbsolute(result)).toBe(true)
      expect(result).not.toContain('~')
    })
  })

  describe('isPathAllowed', () => {
    describe('when allowedRoots is undefined or empty', () => {
      it('allows any path when allowedRoots is undefined', () => {
        expect(isPathAllowed('/etc/passwd', undefined)).toBe(true)
      })

      it('allows any path when allowedRoots is empty array', () => {
        expect(isPathAllowed('/etc/passwd', [])).toBe(true)
      })
    })

    describe('when allowedRoots is configured', () => {
      const allowedRoots = ['/home/user/projects', '/tmp/workspace']

      it('allows path inside an allowed directory', () => {
        expect(isPathAllowed('/home/user/projects/myapp/src/index.ts', allowedRoots)).toBe(true)
      })

      it('allows path that is exactly an allowed root', () => {
        expect(isPathAllowed('/home/user/projects', allowedRoots)).toBe(true)
      })

      it('allows path inside second allowed root', () => {
        expect(isPathAllowed('/tmp/workspace/file.txt', allowedRoots)).toBe(true)
      })

      it('allows paths for roots configured with tilde', () => {
        const homeProjectsRoot = '~/projects'
        const targetPath = path.join(os.homedir(), 'projects', 'app', 'index.ts')
        expect(isPathAllowed(targetPath, [homeProjectsRoot])).toBe(true)
      })

      it('blocks path outside all allowed directories', () => {
        expect(isPathAllowed('/etc/passwd', allowedRoots)).toBe(false)
      })

      it('blocks path traversal attack', () => {
        expect(isPathAllowed('/home/user/projects/../../etc/passwd', allowedRoots)).toBe(false)
      })

      it('blocks path that is a prefix but not a directory boundary', () => {
        expect(isPathAllowed('/home/user/projects-evil/file.txt', allowedRoots)).toBe(false)
      })

      it('blocks parent of allowed directory', () => {
        expect(isPathAllowed('/home/user', allowedRoots)).toBe(false)
      })

      it('blocks root path', () => {
        expect(isPathAllowed('/', allowedRoots)).toBe(false)
      })
    })

    describe('path traversal edge cases', () => {
      const allowedRoots = ['/home/user/projects']

      it('blocks double-dot traversal escaping the sandbox', () => {
        expect(isPathAllowed('/home/user/projects/../../../etc/shadow', allowedRoots)).toBe(false)
      })

      it('blocks traversal with redundant slashes', () => {
        expect(isPathAllowed('/home/user/projects//../../../etc/passwd', allowedRoots)).toBe(false)
      })

      it('allows traversal that stays within the sandbox', () => {
        expect(isPathAllowed('/home/user/projects/a/../b/file.txt', allowedRoots)).toBe(true)
      })
    })
  })

  describe('resolveUserPath', () => {
    it('handles empty input', () => {
      expect(resolveUserPath('')).toBe('')
      expect(resolveUserPath('  ')).toBe('')
    })

    it('resolves absolute paths', () => {
      expect(resolveUserPath('/usr/local/bin')).toBe('/usr/local/bin')
    })

    it('expands tilde to home directory', () => {
      const result = resolveUserPath('~/Documents')
      expect(path.isAbsolute(result)).toBe(true)
      expect(result).toContain('Documents')
      expect(result).not.toContain('~')
    })

    it('expands bare tilde to home directory', () => {
      const result = resolveUserPath('~')
      expect(path.isAbsolute(result)).toBe(true)
    })
  })
})

describe('server/path-utils cross-platform path handling', () => {
  const originalPlatform = process.platform
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true,
    })
    process.env = { ...originalEnv }
  })

  it('detects Windows paths by drive letter and UNC prefix', () => {
    expect(detectUserPathFlavor(String.raw`D:\users\words with spaces`)).toBe('windows')
    expect(detectUserPathFlavor(String.raw`\\server\share`)).toBe('windows')
  })

  it('normalizes wrapped Windows paths and preserves Windows flavor', () => {
    const normalized = normalizeUserPath(String.raw`"D:\users\words with spaces"`)
    expect(normalized.flavor).toBe('windows')
    expect(normalized.normalizedPath).toBe(String.raw`D:\users\words with spaces`)
  })

  it('converts Windows drive paths to WSL mount paths with custom mount roots', () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      writable: true,
      configurable: true,
    })
    process.env.WSL_DISTRO_NAME = 'Ubuntu'
    process.env.WSL_WINDOWS_SYS32 = '/custom-mount/c/X/System32'

    expect(convertWindowsPathToWslPath(String.raw`D:\users\words with spaces`)).toBe('/custom-mount/d/users/words with spaces')
  })

  it('maps Windows flavor paths to host filesystem paths when running in WSL', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      writable: true,
      configurable: true,
    })
    process.env.WSL_DISTRO_NAME = 'Ubuntu'
    process.env.WSL_WINDOWS_SYS32 = '/custom-mount/c/Windows/System32'

    const fsPath = await toFilesystemPath(String.raw`D:\projects\app`, 'windows')
    expect(fsPath).toBe('/custom-mount/d/projects/app')
  })

  it('maps /mnt drive paths to Windows paths when running on Windows', () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
      configurable: true,
    })

    const fsPath = toFilesystemPathSync('/mnt/d/projects/app', 'posix')
    expect(fsPath).toBe(String.raw`D:\projects\app`)
  })

  it('allows Windows-configured roots against WSL-mapped targets', () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      writable: true,
      configurable: true,
    })
    process.env.WSL_DISTRO_NAME = 'Ubuntu'
    process.env.WSL_WINDOWS_SYS32 = '/custom-mount/c/Windows/System32'

    const driveRootAllowed = ['C:\\']
    expect(isPathAllowed('/custom-mount/c', driveRootAllowed)).toBe(true)
    expect(isPathAllowed('/custom-mount/c/users/alice/project', driveRootAllowed)).toBe(true)

    const allowedRoots = [String.raw`C:\users`]
    expect(isPathAllowed('/custom-mount/c/users/alice/project', allowedRoots)).toBe(true)
    expect(isPathAllowed('/custom-mount/d/users/alice/project', allowedRoots)).toBe(false)
  })
})
