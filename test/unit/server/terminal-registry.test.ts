import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isLinuxPath, getSystemShell, escapeCmdExe, buildSpawnSpec, TerminalRegistry, isWsl, isWindowsLike, modeSupportsResume } from '../../../server/terminal-registry'
import { isValidClaudeSessionId } from '../../../server/claude-session-id'
import * as fs from 'fs'
import os from 'os'

// Mock fs.existsSync for shell existence checks
// Need to provide both named export and default export since the implementation uses `import fs from 'fs'`
vi.mock('fs', () => {
  const existsSync = vi.fn()
  const statSync = vi.fn()
  return {
    existsSync,
    statSync,
    default: { existsSync, statSync },
  }
})

// Mock node-pty to avoid spawning real processes
// The source uses `import * as pty from 'node-pty'` and calls `pty.spawn()`
vi.mock('node-pty', async () => {
  const createMockPty = () => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pid: 12345,
  })
  return {
    spawn: vi.fn(createMockPty),
  }
})

// Mock logger to avoid console output during tests
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

const VALID_CLAUDE_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'
const OTHER_CLAUDE_SESSION_ID = '6f1c2b3a-4d5e-6f70-8a9b-0c1d2e3f4a5b'

function expectCodexTurnCompleteArgs(args: string[]) {
  expect(args).toContain('-c')
  expect(args).toContain('tui.notification_method=bel')
  expect(args).toContain("tui.notifications=['agent-turn-complete']")
}

function expectClaudeTurnCompleteArgs(args: string[]) {
  const command = getClaudeStopHookCommand(args)
  expect(command).toContain("printf '\\a'")
}

function getClaudeStopHookCommand(args: string[]): string {
  const settingsIndex = args.indexOf('--settings')
  expect(settingsIndex).toBeGreaterThan(-1)
  const settingsJson = args[settingsIndex + 1]
  expect(typeof settingsJson).toBe('string')
  const settings = JSON.parse(settingsJson) as {
    hooks?: {
      Stop?: Array<{
        hooks?: Array<{
          type?: string
          command?: string
        }>
      }>
    }
  }
  const stopHook = settings.hooks?.Stop?.[0]?.hooks?.[0]
  expect(stopHook?.type).toBe('command')
  return stopHook?.command || ''
}

/**
 * Tests for getSystemShell - cross-platform shell resolution
 * This function returns the appropriate shell for macOS/Linux systems.
 *
 * RED PHASE: These tests verify robust shell resolution with:
 * - SHELL env var validation (check if shell exists)
 * - Platform-specific fallbacks (zsh for macOS, bash for Linux)
 * - Ultimate fallback to /bin/sh
 */
describe('getSystemShell', () => {
  const originalPlatform = process.platform
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.resetAllMocks()
    // Default: all shells exist
    vi.mocked(fs.existsSync).mockReturnValue(true)
  })

  afterEach(() => {
    // Restore original platform and env
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    process.env = { ...originalEnv }
  })

  describe('when SHELL environment variable is set', () => {
    it('returns SHELL value when it exists', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      process.env.SHELL = '/usr/bin/fish'
      vi.mocked(fs.existsSync).mockReturnValue(true)

      const result = getSystemShell()
      expect(result).toBe('/usr/bin/fish')
    })

    it('falls back to platform default when SHELL does not exist', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      process.env.SHELL = '/nonexistent/shell'
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === '/nonexistent/shell') return false
        if (path === '/bin/bash') return true
        return false
      })

      const result = getSystemShell()
      expect(result).toBe('/bin/bash')
    })

    it('falls back when SHELL is empty string', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      process.env.SHELL = ''
      vi.mocked(fs.existsSync).mockImplementation((path) => path === '/bin/bash')

      const result = getSystemShell()
      expect(result).toBe('/bin/bash')
    })
  })

  describe('macOS (darwin) platform fallback', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      delete process.env.SHELL
    })

    it('returns /bin/zsh as primary fallback on macOS', () => {
      vi.mocked(fs.existsSync).mockImplementation((path) => path === '/bin/zsh')

      const result = getSystemShell()
      expect(result).toBe('/bin/zsh')
    })

    it('falls back to /bin/bash if zsh does not exist', () => {
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === '/bin/zsh') return false
        if (path === '/bin/bash') return true
        return false
      })

      const result = getSystemShell()
      expect(result).toBe('/bin/bash')
    })

    it('falls back to /bin/sh as last resort', () => {
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === '/bin/zsh') return false
        if (path === '/bin/bash') return false
        if (path === '/bin/sh') return true
        return false
      })

      const result = getSystemShell()
      expect(result).toBe('/bin/sh')
    })
  })

  describe('Linux platform fallback', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      delete process.env.SHELL
    })

    it('returns /bin/bash as primary fallback on Linux', () => {
      vi.mocked(fs.existsSync).mockImplementation((path) => path === '/bin/bash')

      const result = getSystemShell()
      expect(result).toBe('/bin/bash')
    })

    it('falls back to /bin/sh if bash does not exist', () => {
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === '/bin/bash') return false
        if (path === '/bin/sh') return true
        return false
      })

      const result = getSystemShell()
      expect(result).toBe('/bin/sh')
    })
  })

  describe('returned shell path validation', () => {
    it('returns a path starting with / on Unix platforms', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      process.env.SHELL = '/usr/local/bin/zsh'
      vi.mocked(fs.existsSync).mockReturnValue(true)

      const result = getSystemShell()
      expect(result.startsWith('/')).toBe(true)
    })

    it('returns a valid absolute path on darwin', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      delete process.env.SHELL
      vi.mocked(fs.existsSync).mockReturnValue(true)

      const result = getSystemShell()
      expect(result.startsWith('/')).toBe(true)
      expect(result.length).toBeGreaterThan(1)
    })
  })

  describe('edge cases', () => {
    it('handles SHELL with whitespace only', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      process.env.SHELL = '   '
      vi.mocked(fs.existsSync).mockImplementation((path) => path === '/bin/bash')

      const result = getSystemShell()
      expect(result).toBe('/bin/bash')
    })

    it('handles when no shells exist (returns /bin/sh as final fallback)', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      delete process.env.SHELL
      vi.mocked(fs.existsSync).mockReturnValue(false)

      const result = getSystemShell()
      // Should still return /bin/sh as absolute last resort
      expect(result).toBe('/bin/sh')
    })
  })
})

/**
 * Tests for isLinuxPath (also known as isUnixPath)
 * This function detects Unix-style paths (Linux/macOS/WSL) that won't work
 * on native Windows shells.
 *
 * The function serves a critical purpose: determining when to force WSL mode
 * on Windows because the path cannot be handled by native Windows shells.
 */
describe('isLinuxPath', () => {
  describe('should correctly identify Unix-style paths', () => {
    it('identifies absolute Unix paths starting with /', () => {
      expect(isLinuxPath('/home/user')).toBe(true)
      expect(isLinuxPath('/usr/bin/bash')).toBe(true)
      expect(isLinuxPath('/var/log/messages')).toBe(true)
      expect(isLinuxPath('/')).toBe(true)
      expect(isLinuxPath('/tmp')).toBe(true)
    })

    it('identifies macOS paths', () => {
      expect(isLinuxPath('/Users/john/Documents')).toBe(true)
      expect(isLinuxPath('/Applications')).toBe(true)
      expect(isLinuxPath('/System/Library')).toBe(true)
    })

    it('identifies WSL paths', () => {
      expect(isLinuxPath('/mnt/c/Users')).toBe(true)
      expect(isLinuxPath('/mnt/d/Projects')).toBe(true)
    })
  })

  describe('should correctly reject Windows paths', () => {
    it('rejects Windows drive letter paths with backslashes', () => {
      expect(isLinuxPath('C:\\Users\\dan')).toBe(false)
      expect(isLinuxPath('D:\\projects')).toBe(false)
      expect(isLinuxPath('C:\\Windows\\System32')).toBe(false)
      expect(isLinuxPath('c:\\users\\dan')).toBe(false) // lowercase
    })

    it('rejects Windows paths with forward slashes', () => {
      expect(isLinuxPath('C:/Users/Dan')).toBe(false)
      expect(isLinuxPath('D:/Projects')).toBe(false)
    })
  })

  describe('should correctly reject UNC paths', () => {
    it('rejects UNC network paths with backslashes', () => {
      expect(isLinuxPath('\\\\server\\share')).toBe(false)
      expect(isLinuxPath('\\\\192.168.1.1\\data')).toBe(false)
      expect(isLinuxPath('\\\\wsl$\\Ubuntu\\home')).toBe(false)
    })

    it('rejects UNC paths with forward slashes (WSL from Windows)', () => {
      // Some tools convert backslashes to forward slashes
      // These look like Unix paths but start with // which is UNC
      expect(isLinuxPath('//server/share')).toBe(false)
      expect(isLinuxPath('//wsl$/Ubuntu')).toBe(false)
      expect(isLinuxPath('//wsl$/Ubuntu/home/user')).toBe(false)
    })
  })

  describe('should handle edge cases', () => {
    it('rejects empty string', () => {
      expect(isLinuxPath('')).toBe(false)
    })

    it('rejects relative paths', () => {
      expect(isLinuxPath('relative/path')).toBe(false)
      expect(isLinuxPath('./relative')).toBe(false)
      expect(isLinuxPath('../parent')).toBe(false)
      expect(isLinuxPath('file.txt')).toBe(false)
    })

    it('rejects non-string values', () => {
      expect(isLinuxPath(null)).toBe(false)
      expect(isLinuxPath(undefined)).toBe(false)
      expect(isLinuxPath(123)).toBe(false)
      expect(isLinuxPath({})).toBe(false)
      expect(isLinuxPath([])).toBe(false)
    })

    it('handles paths with spaces', () => {
      expect(isLinuxPath('/home/user/my documents')).toBe(true)
      expect(isLinuxPath('/Users/john/My Documents')).toBe(true)
    })

    it('handles paths with special characters', () => {
      expect(isLinuxPath('/home/user/project-name')).toBe(true)
      expect(isLinuxPath('/home/user/project_name')).toBe(true)
      expect(isLinuxPath('/home/user/.config')).toBe(true)
    })

    it('handles trailing slashes', () => {
      expect(isLinuxPath('/home/user/')).toBe(true)
      expect(isLinuxPath('/tmp/')).toBe(true)
    })
  })

  describe('mixed separator handling', () => {
    it('handles paths that may have been converted from Windows', () => {
      // A Unix path should not contain backslashes
      // If it does, it was likely a Windows path that got partially converted
      // The current implementation doesn't check for this, but it might be worth considering
      expect(isLinuxPath('/home/user\\Documents')).toBe(true) // Currently passes, may want to reconsider
    })
  })

  describe('should correctly identify Mac paths', () => {
    it('identifies /Users/dan as Linux path', () => {
      expect(isLinuxPath('/Users/dan')).toBe(true)
    })
  })
})

describe('isValidClaudeSessionId', () => {
  it('accepts UUID strings', () => {
    expect(isValidClaudeSessionId(VALID_CLAUDE_SESSION_ID)).toBe(true)
  })

  it('rejects non-UUID values', () => {
    expect(isValidClaudeSessionId('nanoid-123')).toBe(false)
    expect(isValidClaudeSessionId('')).toBe(false)
  })
})

/**
 * Tests for isWsl
 * This function detects if running inside Windows Subsystem for Linux
 * by checking for WSL-specific environment variables.
 */
describe('isWsl', () => {
  const originalPlatform = process.platform
  const originalEnv = { ...process.env }

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    process.env = { ...originalEnv }
  })

  it('returns false on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.WSL_DISTRO_NAME = 'Ubuntu'

    expect(isWsl()).toBe(false)
  })

  it('returns false on macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })

    expect(isWsl()).toBe(false)
  })

  it('returns false on native Linux without WSL env vars', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    delete process.env.WSL_DISTRO_NAME
    delete process.env.WSL_INTEROP
    delete process.env.WSLENV

    expect(isWsl()).toBe(false)
  })

  it('returns true on Linux with WSL_DISTRO_NAME', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    process.env.WSL_DISTRO_NAME = 'Ubuntu'
    delete process.env.WSL_INTEROP
    delete process.env.WSLENV

    expect(isWsl()).toBe(true)
  })

  it('returns true on Linux with WSL_INTEROP', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    delete process.env.WSL_DISTRO_NAME
    process.env.WSL_INTEROP = '/run/WSL/123_interop'
    delete process.env.WSLENV

    expect(isWsl()).toBe(true)
  })

  it('returns true on Linux with WSLENV', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    delete process.env.WSL_DISTRO_NAME
    delete process.env.WSL_INTEROP
    process.env.WSLENV = 'PATH/l'

    expect(isWsl()).toBe(true)
  })
})

/**
 * Tests for isWindowsLike
 * Returns true when Windows shells are available (native Windows or WSL).
 */
describe('isWindowsLike', () => {
  const originalPlatform = process.platform
  const originalEnv = { ...process.env }

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    process.env = { ...originalEnv }
  })

  it('returns true on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })

    expect(isWindowsLike()).toBe(true)
  })

  it('returns false on macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })

    expect(isWindowsLike()).toBe(false)
  })

  it('returns false on native Linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    delete process.env.WSL_DISTRO_NAME
    delete process.env.WSL_INTEROP
    delete process.env.WSLENV

    expect(isWindowsLike()).toBe(false)
  })

  it('returns true on WSL', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    process.env.WSL_DISTRO_NAME = 'Ubuntu'

    expect(isWindowsLike()).toBe(true)
  })
})

/**
 * Tests for escapeCmdExe
 * This function escapes special characters for cmd.exe shell commands.
 *
 * cmd.exe uses ^ as its escape character for most special characters.
 * The % character is special and must be doubled (%%).
 */
describe('escapeCmdExe', () => {
  describe('should escape command separator and pipe characters', () => {
    it('escapes & (command separator)', () => {
      expect(escapeCmdExe('echo hello & echo world')).toBe('echo hello ^& echo world')
    })

    it('escapes | (pipe)', () => {
      expect(escapeCmdExe('dir | findstr foo')).toBe('dir ^| findstr foo')
    })

    it('escapes multiple & and | characters', () => {
      expect(escapeCmdExe('a & b | c & d')).toBe('a ^& b ^| c ^& d')
    })
  })

  describe('should escape redirect characters', () => {
    it('escapes < (input redirect)', () => {
      expect(escapeCmdExe('cmd < input.txt')).toBe('cmd ^< input.txt')
    })

    it('escapes > (output redirect)', () => {
      expect(escapeCmdExe('echo hello > output.txt')).toBe('echo hello ^> output.txt')
    })

    it('escapes >> (append redirect)', () => {
      expect(escapeCmdExe('echo hello >> log.txt')).toBe('echo hello ^>^> log.txt')
    })
  })

  describe('should escape the escape character itself', () => {
    it('escapes ^ (caret/escape char)', () => {
      expect(escapeCmdExe('echo ^test')).toBe('echo ^^test')
    })

    it('escapes multiple ^ characters', () => {
      expect(escapeCmdExe('a^b^c')).toBe('a^^b^^c')
    })
  })

  describe('should escape environment variable expansion', () => {
    it('escapes % (environment variable)', () => {
      expect(escapeCmdExe('echo %PATH%')).toBe('echo %%PATH%%')
    })

    it('escapes single % at end of string', () => {
      expect(escapeCmdExe('echo 50%')).toBe('echo 50%%')
    })
  })

  describe('should handle quotes', () => {
    it('escapes double quotes with backslash', () => {
      // cmd.exe typically uses \" for literal quotes in certain contexts
      expect(escapeCmdExe('echo "hello"')).toBe('echo \\"hello\\"')
    })
  })

  describe('should handle realistic command scenarios', () => {
    it('handles cd with spaces and && chaining', () => {
      const input = 'cd "C:\\Program Files" && dir'
      const expected = 'cd \\"C:\\Program Files\\" ^&^& dir'
      expect(escapeCmdExe(input)).toBe(expected)
    })

    it('handles complex pipeline with redirect', () => {
      const input = 'type file.txt | findstr pattern > output.txt'
      const expected = 'type file.txt ^| findstr pattern ^> output.txt'
      expect(escapeCmdExe(input)).toBe(expected)
    })

    it('handles environment variables in path', () => {
      const input = 'cd %USERPROFILE%\\Documents'
      const expected = 'cd %%USERPROFILE%%\\Documents'
      expect(escapeCmdExe(input)).toBe(expected)
    })

    it('handles mix of special characters', () => {
      const input = 'echo %VAR% & echo ^test | more > out.txt'
      const expected = 'echo %%VAR%% ^& echo ^^test ^| more ^> out.txt'
      expect(escapeCmdExe(input)).toBe(expected)
    })
  })

  describe('should handle edge cases', () => {
    it('returns empty string unchanged', () => {
      expect(escapeCmdExe('')).toBe('')
    })

    it('returns string with no special chars unchanged', () => {
      expect(escapeCmdExe('hello world')).toBe('hello world')
    })

    it('handles string that is just special chars', () => {
      expect(escapeCmdExe('&|<>^%')).toBe('^&^|^<^>^^%%')
    })

    it('handles consecutive special chars', () => {
      expect(escapeCmdExe('&&||')).toBe('^&^&^|^|')
    })
  })
})

/**
 * Tests for buildSpawnSpec - Unix (macOS/Linux) code paths
 *
 * These tests verify the spawn spec generation for Unix platforms.
 * We mock process.platform to simulate macOS and Linux environments.
 *
 * The buildSpawnSpec function generates { file, args, cwd, env } used to spawn terminals.
 */
describe('buildSpawnSpec Unix paths', () => {
  // Store original values to restore after tests
  const originalPlatform = process.platform
  const originalEnv = { ...process.env }

  // Helper to mock platform
  function mockPlatform(platform: string) {
    Object.defineProperty(process, 'platform', {
      value: platform,
      writable: true,
      configurable: true,
    })
    // Clear WSL env vars to avoid isWsl() returning true on native Windows
    // when WSLENV is set by Windows Terminal
    delete process.env.WSL_DISTRO_NAME
    delete process.env.WSL_INTEROP
    delete process.env.WSLENV
  }

  beforeEach(() => {
    vi.resetAllMocks()
    // Reset env to a clean state before each test
    process.env = { ...originalEnv }
    // Clear WSL-related env vars so mocking platform to 'linux' doesn't trigger WSL detection
    delete process.env.WSL_DISTRO_NAME
    delete process.env.WSL_INTEROP
    delete process.env.WSLENV
    // Default: all shells exist (so getSystemShell() works as expected)
    vi.mocked(fs.existsSync).mockReturnValue(true)
  })

  afterEach(() => {
    // Restore original platform and env after each test
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true,
    })
    process.env = originalEnv
  })

  describe('macOS shell mode', () => {
    beforeEach(() => {
      mockPlatform('darwin')
    })

    it('uses /bin/zsh as default shell on macOS when SHELL not set', () => {
      delete process.env.SHELL

      const spec = buildSpawnSpec('shell', '/Users/john/project', 'system')

      expect(spec.file).toBe('/bin/zsh')
      expect(spec.args).toContain('-l')
      expect(spec.cwd).toBe('/Users/john/project')
    })

    it('uses $SHELL when set on macOS', () => {
      process.env.SHELL = '/opt/homebrew/bin/fish'

      const spec = buildSpawnSpec('shell', '/Users/john/project', 'system')

      expect(spec.file).toBe('/opt/homebrew/bin/fish')
      expect(spec.args).toContain('-l')
    })

    it('includes -l flag for login shell on macOS', () => {
      delete process.env.SHELL

      const spec = buildSpawnSpec('shell', '/Users/john', 'system')

      expect(spec.args).toEqual(['-l'])
    })

    it('passes cwd correctly for macOS paths', () => {
      delete process.env.SHELL

      const spec = buildSpawnSpec('shell', '/Users/john/Documents/My Project', 'system')

      expect(spec.cwd).toBe('/Users/john/Documents/My Project')
    })
  })

  describe('Linux shell mode', () => {
    beforeEach(() => {
      mockPlatform('linux')
    })

    it('uses /bin/bash as default shell on Linux when SHELL not set', () => {
      delete process.env.SHELL

      const spec = buildSpawnSpec('shell', '/home/user/project', 'system')

      expect(spec.file).toBe('/bin/bash')
      expect(spec.args).toContain('-l')
      expect(spec.cwd).toBe('/home/user/project')
    })

    it('uses $SHELL when set on Linux', () => {
      process.env.SHELL = '/bin/zsh'

      const spec = buildSpawnSpec('shell', '/home/user', 'system')

      expect(spec.file).toBe('/bin/zsh')
    })

    it('includes -l flag for login shell on Linux', () => {
      delete process.env.SHELL

      const spec = buildSpawnSpec('shell', '/home/user', 'system')

      expect(spec.args).toEqual(['-l'])
    })
  })

  describe('claude mode on Unix', () => {
    beforeEach(() => {
      mockPlatform('darwin')
    })

    it('spawns claude command directly without shell wrapper', () => {
      delete process.env.CLAUDE_CMD

      const spec = buildSpawnSpec('claude', '/Users/john/project', 'system')

      expect(spec.file).toBe('claude')
      expect(spec.cwd).toBe('/Users/john/project')
    })

    it('uses CLAUDE_CMD env var when set', () => {
      process.env.CLAUDE_CMD = '/usr/local/bin/claude-dev'

      const spec = buildSpawnSpec('claude', '/Users/john', 'system')

      expect(spec.file).toBe('/usr/local/bin/claude-dev')
    })

    it('passes --resume flag with session ID when resuming', () => {
      delete process.env.CLAUDE_CMD

      const spec = buildSpawnSpec('claude', '/Users/john', 'system', VALID_CLAUDE_SESSION_ID)

      expect(spec.file).toBe('claude')
      expect(spec.args).toContain('--resume')
      expect(spec.args).toContain(VALID_CLAUDE_SESSION_ID)
    })

    it('omits --resume when resumeSessionId is invalid', () => {
      delete process.env.CLAUDE_CMD

      const spec = buildSpawnSpec('claude', '/Users/john', 'system', 'not-a-uuid')

      expect(spec.args).not.toContain('--resume')
    })

    it('does not include --resume when no session ID provided', () => {
      delete process.env.CLAUDE_CMD

      const spec = buildSpawnSpec('claude', '/Users/john', 'system')

      expect(spec.args).not.toContain('--resume')
      expectClaudeTurnCompleteArgs(spec.args)
    })
  })

  describe('codex mode on Unix', () => {
    beforeEach(() => {
      mockPlatform('linux')
    })

    it('spawns codex command directly', () => {
      delete process.env.CODEX_CMD

      const spec = buildSpawnSpec('codex', '/home/user/project', 'system')

      expect(spec.file).toBe('codex')
      expectCodexTurnCompleteArgs(spec.args)
      expect(spec.cwd).toBe('/home/user/project')
    })

    it('uses CODEX_CMD env var when set', () => {
      process.env.CODEX_CMD = '/opt/codex/bin/codex'

      const spec = buildSpawnSpec('codex', '/home/user', 'system')

      expect(spec.file).toBe('/opt/codex/bin/codex')
    })

    it('adds resume subcommand when resumeSessionId provided', () => {
      delete process.env.CODEX_CMD

      const spec = buildSpawnSpec('codex', '/home/user/project', 'system', 'session-123')

      expect(spec.file).toBe('codex')
      expectCodexTurnCompleteArgs(spec.args)
      expect(spec.args.slice(-2)).toEqual(['resume', 'session-123'])
    })
  })

  describe('provider settings in spawn spec', () => {
    beforeEach(() => {
      mockPlatform('darwin')
    })

    it('includes --permission-mode flag for claude when provided', () => {
      delete process.env.CLAUDE_CMD

      const spec = buildSpawnSpec('claude', '/Users/john/project', 'system', undefined, {
        permissionMode: 'bypassPermissions',
      })

      expect(spec.args).toContain('--permission-mode')
      expect(spec.args).toContain('bypassPermissions')
      const idx = spec.args.indexOf('--permission-mode')
      expect(spec.args[idx + 1]).toBe('bypassPermissions')
    })

    it('includes --permission-mode flag for acceptEdits mode', () => {
      delete process.env.CLAUDE_CMD

      const spec = buildSpawnSpec('claude', '/Users/john/project', 'system', undefined, {
        permissionMode: 'acceptEdits',
      })

      const idx = spec.args.indexOf('--permission-mode')
      expect(idx).toBeGreaterThan(-1)
      expect(spec.args[idx + 1]).toBe('acceptEdits')
    })

    it('omits --permission-mode flag when not provided', () => {
      delete process.env.CLAUDE_CMD

      const spec = buildSpawnSpec('claude', '/Users/john/project', 'system')

      expect(spec.args).not.toContain('--permission-mode')
    })

    it('omits --permission-mode flag when set to default', () => {
      delete process.env.CLAUDE_CMD

      const spec = buildSpawnSpec('claude', '/Users/john/project', 'system', undefined, {
        permissionMode: 'default',
      })

      expect(spec.args).not.toContain('--permission-mode')
    })

    it('omits --permission-mode for shell mode even if provided', () => {
      const spec = buildSpawnSpec('shell', '/Users/john/project', 'system', undefined, {
        permissionMode: 'bypassPermissions',
      })

      expect(spec.args).not.toContain('--permission-mode')
    })

    it('combines --permission-mode with --resume when both provided', () => {
      delete process.env.CLAUDE_CMD

      const spec = buildSpawnSpec('claude', '/Users/john/project', 'system', VALID_CLAUDE_SESSION_ID, {
        permissionMode: 'bypassPermissions',
      })

      expect(spec.args).toContain('--permission-mode')
      expect(spec.args).toContain('bypassPermissions')
      expect(spec.args).toContain('--resume')
      expect(spec.args).toContain(VALID_CLAUDE_SESSION_ID)
    })
  })

  describe('environment variables in spawn spec', () => {
    beforeEach(() => {
      mockPlatform('darwin')
    })

    it('includes TERM environment variable', () => {
      delete process.env.TERM

      const spec = buildSpawnSpec('shell', '/Users/john', 'system')

      expect(spec.env.TERM).toBe('xterm-256color')
    })

    it('preserves existing TERM if set', () => {
      process.env.TERM = 'screen-256color'

      const spec = buildSpawnSpec('shell', '/Users/john', 'system')

      expect(spec.env.TERM).toBe('screen-256color')
    })

    it('includes COLORTERM environment variable', () => {
      delete process.env.COLORTERM

      const spec = buildSpawnSpec('shell', '/Users/john', 'system')

      expect(spec.env.COLORTERM).toBe('truecolor')
    })

    it('preserves existing COLORTERM if set', () => {
      process.env.COLORTERM = '24bit'

      const spec = buildSpawnSpec('shell', '/Users/john', 'system')

      expect(spec.env.COLORTERM).toBe('24bit')
    })

    it('passes through other environment variables', () => {
      process.env.MY_CUSTOM_VAR = 'test-value'

      const spec = buildSpawnSpec('shell', '/Users/john', 'system')

      expect(spec.env.MY_CUSTOM_VAR).toBe('test-value')
    })
  })

  describe('cwd handling on Unix', () => {
    beforeEach(() => {
      mockPlatform('darwin')
    })

    it('passes undefined cwd when not provided', () => {
      delete process.env.SHELL

      const spec = buildSpawnSpec('shell', undefined, 'system')

      expect(spec.cwd).toBeUndefined()
    })

    it('handles paths with spaces', () => {
      delete process.env.SHELL

      const spec = buildSpawnSpec('shell', '/Users/john/My Documents/Project Name', 'system')

      expect(spec.cwd).toBe('/Users/john/My Documents/Project Name')
    })

    it('handles deep nested paths', () => {
      delete process.env.SHELL

      const spec = buildSpawnSpec('shell', '/var/www/html/sites/mysite/public_html', 'system')

      expect(spec.cwd).toBe('/var/www/html/sites/mysite/public_html')
    })

    it('handles root path', () => {
      delete process.env.SHELL

      const spec = buildSpawnSpec('shell', '/', 'system')

      expect(spec.cwd).toBe('/')
    })
  })

  describe('shell type normalization on Unix', () => {
    beforeEach(() => {
      mockPlatform('darwin')
    })

    it('normalizes cmd shell type to system on Unix', () => {
      process.env.SHELL = '/bin/zsh'

      // On Unix, 'cmd' should be normalized to 'system' shell
      const spec = buildSpawnSpec('shell', '/Users/john', 'cmd')

      // The shell should still use the system shell, not cmd.exe
      expect(spec.file).toBe('/bin/zsh')
    })

    it('normalizes powershell shell type to system on Unix', () => {
      process.env.SHELL = '/bin/bash'

      // On Unix, 'powershell' should be normalized to 'system' shell
      const spec = buildSpawnSpec('shell', '/Users/john', 'powershell')

      expect(spec.file).toBe('/bin/bash')
    })

    it('normalizes wsl shell type to system on Unix', () => {
      process.env.SHELL = '/bin/bash'

      // On Unix, 'wsl' should be normalized to 'system' shell
      const spec = buildSpawnSpec('shell', '/Users/john', 'wsl')

      expect(spec.file).toBe('/bin/bash')
    })
  })

  describe('spawn spec structure completeness', () => {
    beforeEach(() => {
      mockPlatform('darwin')
    })

    it('returns all required fields for shell mode', () => {
      delete process.env.SHELL

      const spec = buildSpawnSpec('shell', '/Users/john', 'system')

      // Verify structure has all required fields
      expect(spec).toHaveProperty('file')
      expect(spec).toHaveProperty('args')
      expect(spec).toHaveProperty('cwd')
      expect(spec).toHaveProperty('env')
      expect(typeof spec.file).toBe('string')
      expect(Array.isArray(spec.args)).toBe(true)
      expect(typeof spec.env).toBe('object')
    })

    it('returns all required fields for claude mode', () => {
      const spec = buildSpawnSpec('claude', '/Users/john', 'system')

      expect(spec).toHaveProperty('file')
      expect(spec).toHaveProperty('args')
      expect(spec).toHaveProperty('cwd')
      expect(spec).toHaveProperty('env')
    })

    it('returns all required fields for codex mode', () => {
      const spec = buildSpawnSpec('codex', '/Users/john', 'system')

      expect(spec).toHaveProperty('file')
      expect(spec).toHaveProperty('args')
      expect(spec).toHaveProperty('cwd')
      expect(spec).toHaveProperty('env')
    })
  })

  describe('claude mode on Linux', () => {
    beforeEach(() => {
      mockPlatform('linux')
    })

    it('spawns claude command directly on Linux', () => {
      delete process.env.CLAUDE_CMD

      const spec = buildSpawnSpec('claude', '/home/user/project', 'system')

      expect(spec.file).toBe('claude')
      expect(spec.cwd).toBe('/home/user/project')
    })

    it('uses CLAUDE_CMD env var on Linux when set', () => {
      process.env.CLAUDE_CMD = '/usr/local/bin/my-claude'

      const spec = buildSpawnSpec('claude', '/home/user', 'system')

      expect(spec.file).toBe('/usr/local/bin/my-claude')
    })

    it('handles --resume flag correctly on Linux', () => {
      delete process.env.CLAUDE_CMD

      const spec = buildSpawnSpec('claude', '/home/user', 'system', VALID_CLAUDE_SESSION_ID)

      expect(spec.args).toContain('--resume')
      expect(spec.args).toContain(VALID_CLAUDE_SESSION_ID)
      expectClaudeTurnCompleteArgs(spec.args)
      expect(spec.args.slice(-2)).toEqual(['--resume', VALID_CLAUDE_SESSION_ID])
    })

    it('includes proper env vars in claude mode on Linux', () => {
      delete process.env.TERM
      delete process.env.COLORTERM

      const spec = buildSpawnSpec('claude', '/home/user', 'system')

      expect(spec.env.TERM).toBe('xterm-256color')
      expect(spec.env.COLORTERM).toBe('truecolor')
    })
  })

  describe('codex mode on macOS', () => {
    beforeEach(() => {
      mockPlatform('darwin')
    })

    it('spawns codex command directly on macOS', () => {
      delete process.env.CODEX_CMD

      const spec = buildSpawnSpec('codex', '/Users/john/project', 'system')

      expect(spec.file).toBe('codex')
      expectCodexTurnCompleteArgs(spec.args)
      expect(spec.cwd).toBe('/Users/john/project')
    })

    it('uses CODEX_CMD env var on macOS when set', () => {
      process.env.CODEX_CMD = '/Applications/Codex.app/Contents/MacOS/codex'

      const spec = buildSpawnSpec('codex', '/Users/john', 'system')

      expect(spec.file).toBe('/Applications/Codex.app/Contents/MacOS/codex')
    })

    it('includes proper env vars in codex mode on macOS', () => {
      delete process.env.TERM
      delete process.env.COLORTERM

      const spec = buildSpawnSpec('codex', '/Users/john', 'system')

      expect(spec.env.TERM).toBe('xterm-256color')
      expect(spec.env.COLORTERM).toBe('truecolor')
    })
  })

  describe('shell mode uses direct spawn (not shell wrapper)', () => {
    it('spawns the shell directly on macOS (no wrapper)', () => {
      mockPlatform('darwin')
      process.env.SHELL = '/bin/zsh'

      const spec = buildSpawnSpec('shell', '/Users/john', 'system')

      // Should spawn zsh directly, not through another shell
      expect(spec.file).toBe('/bin/zsh')
      // Args should be login shell flag only, not a command to execute
      expect(spec.args).toEqual(['-l'])
      // Should NOT have -c flag (which would indicate shell wrapper)
      expect(spec.args).not.toContain('-c')
    })

    it('spawns the shell directly on Linux (no wrapper)', () => {
      mockPlatform('linux')
      process.env.SHELL = '/bin/bash'

      const spec = buildSpawnSpec('shell', '/home/user', 'system')

      expect(spec.file).toBe('/bin/bash')
      expect(spec.args).toEqual(['-l'])
      expect(spec.args).not.toContain('-c')
    })
  })

  describe('various shell fallback scenarios', () => {
    it('falls back to /bin/zsh on macOS when SHELL is invalid', () => {
      mockPlatform('darwin')
      process.env.SHELL = '/nonexistent/shell'
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === '/nonexistent/shell') return false
        if (path === '/bin/zsh') return true
        return false
      })

      const spec = buildSpawnSpec('shell', '/Users/john', 'system')

      expect(spec.file).toBe('/bin/zsh')
    })

    it('falls back to /bin/bash on Linux when SHELL is invalid', () => {
      mockPlatform('linux')
      process.env.SHELL = '/nonexistent/shell'
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === '/nonexistent/shell') return false
        if (path === '/bin/bash') return true
        return false
      })

      const spec = buildSpawnSpec('shell', '/home/user', 'system')

      expect(spec.file).toBe('/bin/bash')
    })

    it('uses /bin/sh as last resort when other shells missing', () => {
      mockPlatform('linux')
      delete process.env.SHELL
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        // No bash, only /bin/sh
        if (path === '/bin/bash') return false
        if (path === '/bin/sh') return true
        return false
      })

      const spec = buildSpawnSpec('shell', '/home/user', 'system')

      expect(spec.file).toBe('/bin/sh')
    })
  })

  describe('home directory paths', () => {
    it('handles typical home directory path on macOS', () => {
      mockPlatform('darwin')
      delete process.env.SHELL

      const spec = buildSpawnSpec('shell', '/Users/johndoe', 'system')

      expect(spec.cwd).toBe('/Users/johndoe')
    })

    it('handles typical home directory path on Linux', () => {
      mockPlatform('linux')
      delete process.env.SHELL

      const spec = buildSpawnSpec('shell', '/home/johndoe', 'system')

      expect(spec.cwd).toBe('/home/johndoe')
    })

    it('handles WSL-style home path on Linux', () => {
      mockPlatform('linux')
      delete process.env.SHELL

      // WSL maps Windows drives under /mnt
      const spec = buildSpawnSpec('shell', '/mnt/c/Users/john/project', 'system')

      expect(spec.cwd).toBe('/mnt/c/Users/john/project')
    })
  })

  describe('special paths', () => {
    beforeEach(() => {
      mockPlatform('linux')
      delete process.env.SHELL
    })

    it('handles /tmp path', () => {
      const spec = buildSpawnSpec('shell', '/tmp', 'system')
      expect(spec.cwd).toBe('/tmp')
    })

    it('handles /var/log path', () => {
      const spec = buildSpawnSpec('shell', '/var/log', 'system')
      expect(spec.cwd).toBe('/var/log')
    })

    it('handles /opt path', () => {
      const spec = buildSpawnSpec('shell', '/opt/myapp', 'system')
      expect(spec.cwd).toBe('/opt/myapp')
    })

    it('handles paths with dots', () => {
      const spec = buildSpawnSpec('shell', '/home/user/.config', 'system')
      expect(spec.cwd).toBe('/home/user/.config')
    })

    it('handles paths with multiple consecutive dots in name', () => {
      const spec = buildSpawnSpec('shell', '/home/user/project..old', 'system')
      expect(spec.cwd).toBe('/home/user/project..old')
    })
  })
})

/**
 * Tests for buildSpawnSpec - WSL (Windows Subsystem for Linux) code paths
 *
 * These tests verify spawn spec generation when running inside WSL.
 * In WSL, we can spawn Windows executables (cmd.exe, powershell.exe) via interop,
 * but 'wsl' and 'system' shells should use the native Linux shell.
 */
describe('buildSpawnSpec WSL paths', () => {
  const originalPlatform = process.platform
  const originalEnv = { ...process.env }

  function mockWsl() {
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      writable: true,
      configurable: true,
    })
    process.env.WSL_DISTRO_NAME = 'Ubuntu'
  }

  beforeEach(() => {
    vi.resetAllMocks()
    process.env = { ...originalEnv }
    // Clear WSL-related env vars so mocking platform to 'linux' doesn't trigger WSL detection
    delete process.env.WSL_DISTRO_NAME
    delete process.env.WSL_INTEROP
    delete process.env.WSLENV
    vi.mocked(fs.existsSync).mockReturnValue(true)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true,
    })
    process.env = originalEnv
  })

  describe('shell type handling in WSL', () => {
    it('uses Linux shell for system shell type in WSL', () => {
      mockWsl()
      process.env.SHELL = '/bin/bash'

      const spec = buildSpawnSpec('shell', '/home/user/project', 'system')

      expect(spec.file).toBe('/bin/bash')
      expect(spec.args).toContain('-l')
      expect(spec.cwd).toBe('/home/user/project')
    })

    it('uses Linux shell for wsl shell type in WSL', () => {
      mockWsl()
      process.env.SHELL = '/bin/bash'

      const spec = buildSpawnSpec('shell', '/home/user/project', 'wsl')

      expect(spec.file).toBe('/bin/bash')
      expect(spec.args).toContain('-l')
    })

    it('uses full path to cmd.exe for cmd shell type in WSL', () => {
      mockWsl()

      const spec = buildSpawnSpec('shell', '/home/user/project', 'cmd')

      // WSL uses full path since cmd.exe may not be on PATH
      expect(spec.file).toBe('/mnt/c/Windows/System32/cmd.exe')
      expect(spec.args).toContain('/K')
    })

    it('uses full path to powershell.exe for powershell shell type in WSL', () => {
      mockWsl()

      const spec = buildSpawnSpec('shell', '/home/user/project', 'powershell')

      // WSL uses full path since powershell.exe may not be on PATH
      expect(spec.file).toBe('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
      expect(spec.args).toContain('-NoLogo')
    })
  })

  describe('cwd handling for Windows shells in WSL', () => {
    // In WSL, we can't pass Linux paths to node-pty for Windows executables
    // (they become UNC paths which cmd.exe rejects). Instead, we pass cwd: undefined
    // to node-pty and pass a Windows drive path via cd /d or Set-Location.

    it('uses cd command for cmd.exe with Linux path in WSL', () => {
      mockWsl()

      const spec = buildSpawnSpec('shell', '/home/user/project', 'cmd')

      // cwd should be undefined to avoid UNC path translation
      expect(spec.cwd).toBeUndefined()
      // Directory change should be in the command args
      expect(spec.args).toContain('/K')
      expect(spec.args.some(arg => arg.includes('cd /d "C:'))).toBe(true)
    })

    it('uses Set-Location for powershell.exe with Linux path in WSL', () => {
      mockWsl()

      const spec = buildSpawnSpec('shell', '/home/user/project', 'powershell')

      // cwd should be undefined to avoid UNC path translation
      expect(spec.cwd).toBeUndefined()
      // Directory change should be in the command args
      expect(spec.args).toContain('-NoLogo')
      expect(spec.args.some(arg => arg.includes('Set-Location') && arg.includes("'C:\\"))).toBe(true)
    })

    it('uses USERPROFILE for Windows default cwd in cmd args when available in WSL', () => {
      mockWsl()
      process.env.USERPROFILE = 'C:\\Users\\testuser'

      const spec = buildSpawnSpec('shell', '/home/user/project', 'cmd')

      // cwd undefined, path in args
      expect(spec.cwd).toBeUndefined()
      expect(spec.args.some(arg => arg.includes('cd /d "C:\\Users\\testuser"'))).toBe(true)

      delete process.env.USERPROFILE
    })

    it('converts standard /mnt drive paths to Windows drive paths for cmd', () => {
      mockWsl()

      const spec = buildSpawnSpec('shell', '/mnt/d/projects/demo', 'cmd')

      expect(spec.cwd).toBeUndefined()
      expect(spec.args.some(arg => arg.includes('cd /d "D:\\projects\\demo"'))).toBe(true)
    })

    it('respects custom WSL mount prefix when converting WSL cwd for powershell args', () => {
      mockWsl()
      process.env.WSL_WINDOWS_SYS32 = '/win/c/Windows/System32'

      const spec = buildSpawnSpec('shell', '/win/d/Users/testuser', 'powershell')

      expect(spec.cwd).toBeUndefined()
      expect(spec.args.some(arg => arg.includes("Set-Location") && arg.includes("'D:\\Users\\testuser'"))).toBe(true)

      delete process.env.WSL_WINDOWS_SYS32
    })

    it('uses provided Windows paths directly when shell is cmd in WSL', () => {
      mockWsl()

      const spec = buildSpawnSpec('codex', 'D:\\users\\dan', 'cmd')

      expect(spec.cwd).toBeUndefined()
      expect(spec.args).toContain('/K')
      expect(spec.args.some(arg => arg.includes('cd /d "D:\\users\\dan"'))).toBe(true)
    })
  })

  describe('coding CLI modes in WSL with Linux shell', () => {
    it('spawns claude directly in WSL with system shell', () => {
      mockWsl()
      delete process.env.CLAUDE_CMD

      const spec = buildSpawnSpec('claude', '/home/user/project', 'system')

      expect(spec.file).toBe('claude')
      expect(spec.cwd).toBe('/home/user/project')
    })

    it('spawns codex directly in WSL with system shell', () => {
      mockWsl()
      delete process.env.CODEX_CMD

      const spec = buildSpawnSpec('codex', '/home/user/project', 'system')

      expect(spec.file).toBe('codex')
      expect(spec.cwd).toBe('/home/user/project')
    })

    it('converts Windows cwd to WSL path for codex in WSL system shell', () => {
      mockWsl()
      delete process.env.CODEX_CMD

      const spec = buildSpawnSpec('codex', String.raw`D:\users\dan\project`, 'system')

      expect(spec.file).toBe('codex')
      expect(spec.cwd).toBe('/mnt/d/users/dan/project')
    })

    it('converts Windows cwd to WSL path for shell mode in WSL system shell', () => {
      mockWsl()
      process.env.SHELL = '/bin/bash'

      const spec = buildSpawnSpec('shell', String.raw`C:\Users\dan\workspace`, 'system')

      expect(spec.file).toBe('/bin/bash')
      expect(spec.args).toEqual(['-l'])
      expect(spec.cwd).toBe('/mnt/c/Users/dan/workspace')
    })
  })
})

describe('buildSpawnSpec resume validation on Windows shells', () => {
  const originalPlatform = process.platform
  const originalEnv = { ...process.env }

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    process.env = { ...originalEnv }
  })

  it('omits --resume in cmd.exe string when invalid', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const spec = buildSpawnSpec('claude', 'C:\\tmp', 'cmd', 'not-a-uuid')
    expect(spec.args.join(' ')).not.toContain('--resume')
  })

  it('omits --resume in PowerShell command when invalid', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const spec = buildSpawnSpec('claude', 'C:\\tmp', 'powershell', 'not-a-uuid')
    expect(spec.args.join(' ')).not.toContain('--resume')
  })

  it('omits --resume in WSL args when invalid', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const spec = buildSpawnSpec('claude', 'C:\\tmp', 'wsl', 'not-a-uuid')
    expect(spec.args).not.toContain('--resume')
  })

  it('converts Windows cwd to WSL mount path when launching with wsl shell on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const spec = buildSpawnSpec('claude', String.raw`D:\users\words with spaces`, 'wsl')
    expect(spec.file).toBe('wsl.exe')
    const cdIndex = spec.args.indexOf('--cd')
    expect(cdIndex).toBeGreaterThan(-1)
    expect(spec.args[cdIndex + 1]).toBe('/mnt/d/users/words with spaces')
  })

  it('quotes coding-cli args for cmd.exe to preserve JSON and whitespace', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.CLAUDE_CMD = 'C:\\Program Files\\Claude\\claude.cmd'

    const spec = buildSpawnSpec('claude', 'C:\\tmp', 'cmd', VALID_CLAUDE_SESSION_ID)
    expect(spec.file).toBe('cmd.exe')
    expect(spec.args[0]).toBe('/K')
    expect(spec.args[1]).toContain('"C:\\Program Files\\Claude\\claude.cmd"')
    expect(spec.args[1]).toContain('"--settings"')
    expect(spec.args[1]).toContain('\\"hooks\\"')
    expect(spec.args[1]).toContain('"--resume"')
    expect(spec.args[1]).toContain(`"${VALID_CLAUDE_SESSION_ID}"`)
  })

  it('quotes coding-cli args for PowerShell to preserve literals', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.CODEX_CMD = 'C:\\Program Files\\Codex\\codex.cmd'

    const spec = buildSpawnSpec('codex', 'C:\\tmp', 'powershell', 'session-123')
    expect(spec.file).toBe('powershell.exe')
    expect(spec.args).toContain('-NoExit')
    expect(spec.args[3]).toContain("& 'C:\\Program Files\\Codex\\codex.cmd'")
    expect(spec.args[3]).toContain("'-c'")
    expect(spec.args[3]).toContain("'tui.notification_method=bel'")
    expect(spec.args[3]).toContain("'tui.notifications=[''agent-turn-complete'']'")
    expect(spec.args[3]).toContain("'resume'")
    expect(spec.args[3]).toContain("'session-123'")
  })

  it('uses a Windows-compatible Claude stop-hook command for native Windows shells', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })

    const cmdSpec = buildSpawnSpec('claude', 'C:\\tmp', 'cmd')
    const psSpec = buildSpawnSpec('claude', 'C:\\tmp', 'powershell')

    expect(cmdSpec.args[1]).toContain('powershell.exe')
    expect(cmdSpec.args[1]).not.toContain('/dev/tty')
    expect(cmdSpec.args[1]).toContain('CONOUT$')
    expect(cmdSpec.args[1]).toContain('[Console]::Out.Write($bell)')
    expect(psSpec.args[3]).toContain('powershell.exe')
    expect(psSpec.args[3]).not.toContain('/dev/tty')
    expect(psSpec.args[3]).toContain('CONOUT$')
    expect(psSpec.args[3]).toContain('[Console]::Out.Write($bell)')
  })

  it('keeps Unix Claude stop-hook command when launching through WSL', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })

    const spec = buildSpawnSpec('claude', '/home/user/project', 'wsl')
    const hookCommand = getClaudeStopHookCommand(spec.args)
    expect(hookCommand).toContain("printf '\\a'")
    expect(hookCommand).toContain('/dev/tty')
  })
})

/**
 * Tests for TerminalRegistry class - resumeSessionId functionality
 *
 * These tests verify the resumeSessionId storage and retrieval functionality
 * added to support session-centric sidebar features.
 */
describe('TerminalRegistry', () => {
  let registry: TerminalRegistry

  beforeEach(async () => {
    vi.resetAllMocks()
    vi.mocked(fs.existsSync).mockReturnValue(true)
    // Re-setup node-pty mock after resetAllMocks clears implementations
    const pty = await import('node-pty')
    vi.mocked(pty.spawn).mockImplementation(() => ({
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      pid: 12345,
    }) as any)
    // Create registry with a small maxTerminals limit for testing
    registry = new TerminalRegistry(undefined, 10)
  })

  afterEach(() => {
    // Clean up the registry (stops idle monitor)
    registry.shutdown()
  })

  describe('reaping exited terminals', () => {
    it('does not count exited terminals against MAX_TERMINALS', () => {
      const reg = new TerminalRegistry(undefined, 2)
      const t1 = reg.create({ mode: 'shell' })
      reg.create({ mode: 'shell' })

      reg.kill(t1.terminalId)

      expect(() => reg.create({ mode: 'shell' })).not.toThrow()
      reg.shutdown()
    })

    it('reaps old exited terminals to prevent unbounded growth', () => {
      const reg = new TerminalRegistry(undefined, 1, 5)
      for (let i = 0; i < 20; i += 1) {
        const t = reg.create({ mode: 'shell' })
        reg.kill(t.terminalId)
      }

      expect(reg.list().length).toBeLessThanOrEqual(5)
      reg.shutdown()
    })
  })

  describe('create() with resumeSessionId', () => {
    it('stores resumeSessionId on the terminal record when provided', () => {
      const record = registry.create({
        mode: 'claude',
        cwd: '/home/user/project',
        resumeSessionId: VALID_CLAUDE_SESSION_ID,
      })

      expect(record.resumeSessionId).toBe(VALID_CLAUDE_SESSION_ID)
      expect(record.mode).toBe('claude')
    })

    it('leaves resumeSessionId undefined when not provided', () => {
      const record = registry.create({
        mode: 'claude',
        cwd: '/home/user/project',
      })

      expect(record.resumeSessionId).toBeUndefined()
    })

    it('ignores resumeSessionId for shell mode terminals', () => {
      const record = registry.create({
        mode: 'shell',
        cwd: '/home/user/project',
        resumeSessionId: 'shell-session-123',
      })

      expect(record.resumeSessionId).toBeUndefined()
      expect(record.mode).toBe('shell')
    })
  })

  describe('defaultCwd validation', () => {
    const originalPlatform = process.platform

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    })

    it('uses defaultCwd when directory exists', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      vi.mocked(fs.statSync).mockImplementation((pathValue) => {
        if (pathValue === '/valid/path') {
          return { isDirectory: () => true } as any
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

      const registryWithSettings = new TerminalRegistry({ defaultCwd: '/valid/path' } as any, 10)
      const record = registryWithSettings.create({ mode: 'shell' })

      expect(record.cwd).toBe('/valid/path')
      registryWithSettings.shutdown()
    })

    it('falls back to home when defaultCwd is invalid', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

      const registryWithSettings = new TerminalRegistry({ defaultCwd: '/missing/path' } as any, 10)
      const record = registryWithSettings.create({ mode: 'shell' })

      expect(record.cwd).toBe(os.homedir())
      registryWithSettings.shutdown()
    })
  })

  describe('list() returns resumeSessionId', () => {
    it('includes resumeSessionId in list output when set', () => {
      registry.create({
        mode: 'claude',
        cwd: '/home/user/project1',
        resumeSessionId: VALID_CLAUDE_SESSION_ID,
      })
      registry.create({
        mode: 'claude',
        cwd: '/home/user/project2',
        resumeSessionId: OTHER_CLAUDE_SESSION_ID,
      })

      const terminals = registry.list()

      expect(terminals).toHaveLength(2)
      const sessionIds = terminals.map(t => t.resumeSessionId).sort()
      expect(sessionIds).toEqual([VALID_CLAUDE_SESSION_ID, OTHER_CLAUDE_SESSION_ID])
    })

    it('includes undefined resumeSessionId in list output when not set', () => {
      registry.create({
        mode: 'claude',
        cwd: '/home/user/project',
      })

      const terminals = registry.list()

      expect(terminals).toHaveLength(1)
      expect(terminals[0].resumeSessionId).toBeUndefined()
    })
  })

  describe('list() returns mode', () => {
    it('includes mode in list output for shell terminals', () => {
      registry.create({
        mode: 'shell',
        cwd: '/home/user/project',
      })

      const terminals = registry.list()

      expect(terminals).toHaveLength(1)
      expect(terminals[0].mode).toBe('shell')
    })

    it('includes mode in list output for claude terminals', () => {
      registry.create({
        mode: 'claude',
        cwd: '/home/user/project',
      })

      const terminals = registry.list()

      expect(terminals).toHaveLength(1)
      expect(terminals[0].mode).toBe('claude')
    })

    it('includes mode in list output for codex terminals', () => {
      registry.create({
        mode: 'codex',
        cwd: '/home/user/project',
      })

      const terminals = registry.list()

      expect(terminals).toHaveLength(1)
      expect(terminals[0].mode).toBe('codex')
    })

    it('returns correct modes for mixed terminal types', () => {
      registry.create({ mode: 'shell', cwd: '/home/user' })
      registry.create({ mode: 'claude', cwd: '/home/user' })
      registry.create({ mode: 'codex', cwd: '/home/user' })

      const terminals = registry.list()
      const modes = terminals.map(t => t.mode).sort()

      expect(modes).toEqual(['claude', 'codex', 'shell'])
    })
  })

  describe('findTerminalsBySession() exact match', () => {
    it('finds terminal by exact resumeSessionId match', () => {
      const record = registry.create({
        mode: 'claude',
        cwd: '/home/user/project',
        resumeSessionId: VALID_CLAUDE_SESSION_ID,
      })

      const found = registry.findTerminalsBySession('claude', VALID_CLAUDE_SESSION_ID)

      expect(found).toHaveLength(1)
      expect(found[0].terminalId).toBe(record.terminalId)
      expect(found[0].resumeSessionId).toBe(VALID_CLAUDE_SESSION_ID)
    })

    it('returns empty array when no matching resumeSessionId', () => {
      registry.create({
        mode: 'claude',
        cwd: '/home/user/project',
        resumeSessionId: VALID_CLAUDE_SESSION_ID,
      })

      const found = registry.findTerminalsBySession('claude', OTHER_CLAUDE_SESSION_ID)

      expect(found).toHaveLength(0)
    })

    it('enforces one-owner invariant for the same provider/sessionId', () => {
      const first = registry.create({
        mode: 'claude',
        cwd: '/home/user/project1',
        resumeSessionId: VALID_CLAUDE_SESSION_ID,
      })
      const second = registry.create({
        mode: 'claude',
        cwd: '/home/user/project2',
        resumeSessionId: VALID_CLAUDE_SESSION_ID,
      })

      const found = registry.findTerminalsBySession('claude', VALID_CLAUDE_SESSION_ID)

      expect(found).toHaveLength(1)
      expect(found[0].terminalId).toBe(first.terminalId)
      expect(second.resumeSessionId).toBeUndefined()
    })
  })

  describe('findTerminalsBySession() ignores cwd parameter', () => {
    it('does not match by cwd, only by resumeSessionId', () => {
      registry.create({
        mode: 'claude',
        cwd: '/home/user/project',
        resumeSessionId: VALID_CLAUDE_SESSION_ID,
      })

      // cwd matches but sessionId doesn't - should not find terminal
      const found = registry.findTerminalsBySession('claude', OTHER_CLAUDE_SESSION_ID, '/home/user/project')

      expect(found).toHaveLength(0)
    })

    it('finds terminal by exact resumeSessionId ignoring cwd', () => {
      const record = registry.create({
        mode: 'claude',
        cwd: '/home/user/project-a',
        resumeSessionId: VALID_CLAUDE_SESSION_ID,
      })

      // cwd differs but sessionId matches - should find terminal
      const found = registry.findTerminalsBySession('claude', VALID_CLAUDE_SESSION_ID, '/home/user/different')

      expect(found).toHaveLength(1)
      expect(found[0].terminalId).toBe(record.terminalId)
    })
  })

  describe('findRunningClaudeTerminalBySession', () => {
    it('finds a running claude terminal by resumeSessionId', () => {
      const record = registry.create({
        mode: 'claude',
        cwd: '/home/user/project',
        resumeSessionId: VALID_CLAUDE_SESSION_ID,
      })

      const found = registry.findRunningClaudeTerminalBySession(VALID_CLAUDE_SESSION_ID)

      expect(found?.terminalId).toBe(record.terminalId)
    })
  })

  describe('findTerminalsBySession() ignores shell mode', () => {
    it('does not return shell-mode terminals even with matching resumeSessionId', () => {
      registry.create({
        mode: 'shell',
        cwd: '/home/user/project',
        resumeSessionId: VALID_CLAUDE_SESSION_ID,
      })

      const found = registry.findTerminalsBySession('claude', VALID_CLAUDE_SESSION_ID, '/home/user/project')

      expect(found).toHaveLength(0)
    })

    it('does not return shell-mode terminals with exact resumeSessionId match', () => {
      registry.create({
        mode: 'shell',
        cwd: '/home/user/project',
        resumeSessionId: VALID_CLAUDE_SESSION_ID,
      })

      const found = registry.findTerminalsBySession('claude', VALID_CLAUDE_SESSION_ID)

      expect(found).toHaveLength(0)
    })

    it('does not return codex-mode terminals', () => {
      registry.create({
        mode: 'codex',
        cwd: '/home/user/project',
        resumeSessionId: VALID_CLAUDE_SESSION_ID,
      })

      const found = registry.findTerminalsBySession('claude', VALID_CLAUDE_SESSION_ID, '/home/user/project')

      expect(found).toHaveLength(0)
    })

    it('returns only claude-mode terminals from mixed modes', () => {
      registry.create({
        mode: 'shell',
        cwd: '/home/user/project',
        resumeSessionId: VALID_CLAUDE_SESSION_ID,
      })
      const claudeRecord = registry.create({
        mode: 'claude',
        cwd: '/home/user/project',
        resumeSessionId: VALID_CLAUDE_SESSION_ID,
      })
      registry.create({
        mode: 'codex',
        cwd: '/home/user/project',
        resumeSessionId: VALID_CLAUDE_SESSION_ID,
      })

      const found = registry.findTerminalsBySession('claude', VALID_CLAUDE_SESSION_ID)

      expect(found).toHaveLength(1)
      expect(found[0].terminalId).toBe(claudeRecord.terminalId)
      expect(found[0].mode).toBe('claude')
    })
  })

  describe('findUnassociatedClaudeTerminals', () => {
    it('should find claude terminals without resumeSessionId matching cwd', () => {
      // Create a claude terminal without resumeSessionId
      const term1 = registry.create({ mode: 'claude', cwd: '/home/user/project' })
      // Create a claude terminal WITH resumeSessionId (should not match)
      registry.create({ mode: 'claude', cwd: '/home/user/project', resumeSessionId: VALID_CLAUDE_SESSION_ID })
      // Create a shell terminal (should not match)
      registry.create({ mode: 'shell', cwd: '/home/user/project' })

      const results = registry.findUnassociatedClaudeTerminals('/home/user/project')

      expect(results).toHaveLength(1)
      expect(results[0].terminalId).toBe(term1.terminalId)
    })

    it('should return empty array when no matching terminals', () => {
      registry.create({ mode: 'claude', cwd: '/other/path' })

      const results = registry.findUnassociatedClaudeTerminals('/home/user/project')

      expect(results).toHaveLength(0)
    })

    it('should match cwd case-insensitively on Windows', () => {
      const term = registry.create({ mode: 'claude', cwd: 'C:\\Users\\Dan\\project' })

      const results = registry.findUnassociatedClaudeTerminals('c:/users/dan/project')

      // On Windows, paths are case-insensitive
      // On Unix, this test would fail (which is correct behavior)
      if (process.platform === 'win32') {
        expect(results).toHaveLength(1)
        expect(results[0].terminalId).toBe(term.terminalId)
      } else {
        // Unix: different case = different path
        expect(results).toHaveLength(0)
      }
    })

    it('should normalize backslashes to forward slashes', () => {
      const term = registry.create({ mode: 'claude', cwd: 'C:\\Users\\Dan\\project' })

      const results = registry.findUnassociatedClaudeTerminals('C:/Users/Dan/project')

      expect(results).toHaveLength(1)
      expect(results[0].terminalId).toBe(term.terminalId)
    })

    it('should return results sorted by createdAt (oldest first)', () => {
      // Create terminals with slight delays to ensure different createdAt
      const term1 = registry.create({ mode: 'claude', cwd: '/home/user/project' })
      const term2 = registry.create({ mode: 'claude', cwd: '/home/user/project' })
      const term3 = registry.create({ mode: 'claude', cwd: '/home/user/project' })

      const results = registry.findUnassociatedClaudeTerminals('/home/user/project')

      expect(results).toHaveLength(3)
      // Oldest first (by createdAt)
      expect(results[0].terminalId).toBe(term1.terminalId)
      expect(results[1].terminalId).toBe(term2.terminalId)
      expect(results[2].terminalId).toBe(term3.terminalId)
    })
  })

  describe('findUnassociatedTerminals', () => {
    it('should find codex terminals without resumeSessionId matching cwd', () => {
      const term1 = registry.create({ mode: 'codex', cwd: '/home/user/project' })
      // codex terminal WITH resumeSessionId (should not match)
      registry.create({ mode: 'codex', cwd: '/home/user/project', resumeSessionId: 'codex-session-123' })
      // shell terminal (should not match)
      registry.create({ mode: 'shell', cwd: '/home/user/project' })
      // claude terminal (should not match for codex mode)
      registry.create({ mode: 'claude', cwd: '/home/user/project' })

      const results = registry.findUnassociatedTerminals('codex', '/home/user/project')

      expect(results).toHaveLength(1)
      expect(results[0].terminalId).toBe(term1.terminalId)
    })

    it('should return empty array when cwd does not match', () => {
      registry.create({ mode: 'codex', cwd: '/other/path' })

      const results = registry.findUnassociatedTerminals('codex', '/home/user/project')

      expect(results).toHaveLength(0)
    })

    it('should return results sorted by createdAt (oldest first)', () => {
      const term1 = registry.create({ mode: 'codex', cwd: '/home/user/project' })
      const term2 = registry.create({ mode: 'codex', cwd: '/home/user/project' })
      const term3 = registry.create({ mode: 'codex', cwd: '/home/user/project' })

      const results = registry.findUnassociatedTerminals('codex', '/home/user/project')

      expect(results).toHaveLength(3)
      expect(results[0].terminalId).toBe(term1.terminalId)
      expect(results[1].terminalId).toBe(term2.terminalId)
      expect(results[2].terminalId).toBe(term3.terminalId)
    })

    it('should normalize backslashes and trailing slashes', () => {
      const term = registry.create({ mode: 'codex', cwd: 'C:\\Users\\Dan\\project' })

      const results = registry.findUnassociatedTerminals('codex', 'C:/Users/Dan/project')

      expect(results).toHaveLength(1)
      expect(results[0].terminalId).toBe(term.terminalId)
    })

    it('should work for claude mode (delegates same logic)', () => {
      const term = registry.create({ mode: 'claude', cwd: '/home/user/project' })
      registry.create({ mode: 'codex', cwd: '/home/user/project' })

      const results = registry.findUnassociatedTerminals('claude', '/home/user/project')

      expect(results).toHaveLength(1)
      expect(results[0].terminalId).toBe(term.terminalId)
    })
  })

  describe('findUnassociatedClaudeTerminals delegates to findUnassociatedTerminals', () => {
    it('should return the same results as findUnassociatedTerminals for claude mode', () => {
      registry.create({ mode: 'claude', cwd: '/home/user/project' })
      registry.create({ mode: 'codex', cwd: '/home/user/project' })

      const claude = registry.findUnassociatedClaudeTerminals('/home/user/project')
      const generic = registry.findUnassociatedTerminals('claude', '/home/user/project')

      expect(claude).toEqual(generic)
    })
  })

  describe('modeSupportsResume', () => {
    it('returns true for claude', () => {
      expect(modeSupportsResume('claude')).toBe(true)
    })

    it('returns true for codex', () => {
      expect(modeSupportsResume('codex')).toBe(true)
    })

    it('returns false for shell', () => {
      expect(modeSupportsResume('shell')).toBe(false)
    })

    it('returns false for opencode (no resumeArgs)', () => {
      expect(modeSupportsResume('opencode')).toBe(false)
    })

    it('returns false for gemini (no resumeArgs)', () => {
      expect(modeSupportsResume('gemini')).toBe(false)
    })

    it('returns false for kimi (no resumeArgs)', () => {
      expect(modeSupportsResume('kimi')).toBe(false)
    })
  })

  describe('setResumeSessionId', () => {
    it('should set resumeSessionId on existing terminal', () => {
      const term = registry.create({ mode: 'claude', cwd: '/home/user/project' })

      const result = registry.setResumeSessionId(term.terminalId, VALID_CLAUDE_SESSION_ID)

      expect(result).toBe(true)
      expect(registry.get(term.terminalId)?.resumeSessionId).toBe(VALID_CLAUDE_SESSION_ID)
    })

    it('rejects invalid sessionId for claude terminals', () => {
      const term = registry.create({ mode: 'claude', cwd: '/home/user/project' })

      const result = registry.setResumeSessionId(term.terminalId, 'not-a-uuid')

      expect(result).toBe(false)
      expect(registry.get(term.terminalId)?.resumeSessionId).toBeUndefined()
    })

    it('accepts any sessionId for codex terminals', () => {
      const term = registry.create({ mode: 'codex', cwd: '/home/user/project' })

      const result = registry.setResumeSessionId(term.terminalId, 'codex-session-abc-123')

      expect(result).toBe(true)
      expect(registry.get(term.terminalId)?.resumeSessionId).toBe('codex-session-abc-123')
    })

    it('should return false for non-existent terminal', () => {
      const result = registry.setResumeSessionId('nonexistent', 'session-id')

      expect(result).toBe(false)
    })
  })
})

describe('buildSpawnSpec Unix paths', () => {
  // Store original values to restore after tests
  const originalPlatform = process.platform
  const originalEnv = { ...process.env }

  // Helper to mock platform
  function mockPlatform(platform: string) {
    Object.defineProperty(process, 'platform', {
      value: platform,
      writable: true,
      configurable: true,
    })
    // Clear WSL env vars to avoid isWsl() returning true on native Windows
    // when WSLENV is set by Windows Terminal
    delete process.env.WSL_DISTRO_NAME
    delete process.env.WSL_INTEROP
    delete process.env.WSLENV
  }

  beforeEach(() => {
    vi.resetAllMocks()
    // Reset env to a clean state before each test
    process.env = { ...originalEnv }
    // Clear WSL-related env vars so mocking platform to 'linux' doesn't trigger WSL detection
    delete process.env.WSL_DISTRO_NAME
    delete process.env.WSL_INTEROP
    delete process.env.WSLENV
    // Default: all shells exist (so getSystemShell() works as expected)
    vi.mocked(fs.existsSync).mockReturnValue(true)
  })

  afterEach(() => {
    // Restore original platform and env after each test
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true,
    })
    process.env = originalEnv
  })

  describe('macOS shell mode', () => {
    beforeEach(() => {
      mockPlatform('darwin')
    })

    it('uses /bin/zsh as default shell on macOS when SHELL not set', () => {
      delete process.env.SHELL

      const spec = buildSpawnSpec('shell', '/Users/john/project', 'system')

      expect(spec.file).toBe('/bin/zsh')
      expect(spec.args).toContain('-l')
      expect(spec.cwd).toBe('/Users/john/project')
    })

    it('uses $SHELL when set on macOS', () => {
      process.env.SHELL = '/opt/homebrew/bin/fish'

      const spec = buildSpawnSpec('shell', '/Users/john/project', 'system')

      expect(spec.file).toBe('/opt/homebrew/bin/fish')
      expect(spec.args).toContain('-l')
    })

    it('includes -l flag for login shell on macOS', () => {
      delete process.env.SHELL

      const spec = buildSpawnSpec('shell', '/Users/john', 'system')

      expect(spec.args).toEqual(['-l'])
    })

    it('passes cwd correctly for macOS paths', () => {
      delete process.env.SHELL

      const spec = buildSpawnSpec('shell', '/Users/john/Documents/My Project', 'system')

      expect(spec.cwd).toBe('/Users/john/Documents/My Project')
    })
  })

  describe('Linux shell mode', () => {
    beforeEach(() => {
      mockPlatform('linux')
    })

    it('uses /bin/bash as default shell on Linux when SHELL not set', () => {
      delete process.env.SHELL

      const spec = buildSpawnSpec('shell', '/home/user/project', 'system')

      expect(spec.file).toBe('/bin/bash')
      expect(spec.args).toContain('-l')
      expect(spec.cwd).toBe('/home/user/project')
    })

    it('uses $SHELL when set on Linux', () => {
      process.env.SHELL = '/bin/zsh'

      const spec = buildSpawnSpec('shell', '/home/user', 'system')

      expect(spec.file).toBe('/bin/zsh')
    })

    it('includes -l flag for login shell on Linux', () => {
      delete process.env.SHELL

      const spec = buildSpawnSpec('shell', '/home/user', 'system')

      expect(spec.args).toEqual(['-l'])
    })
  })

  describe('claude mode on Unix', () => {
    beforeEach(() => {
      mockPlatform('darwin')
    })

    it('spawns claude command directly without shell wrapper', () => {
      delete process.env.CLAUDE_CMD

      const spec = buildSpawnSpec('claude', '/Users/john/project', 'system')

      expect(spec.file).toBe('claude')
      expect(spec.cwd).toBe('/Users/john/project')
    })

    it('uses CLAUDE_CMD env var when set', () => {
      process.env.CLAUDE_CMD = '/usr/local/bin/claude-dev'

      const spec = buildSpawnSpec('claude', '/Users/john', 'system')

      expect(spec.file).toBe('/usr/local/bin/claude-dev')
    })

    it('passes --resume flag with session ID when resuming', () => {
      delete process.env.CLAUDE_CMD

      const spec = buildSpawnSpec('claude', '/Users/john', 'system', VALID_CLAUDE_SESSION_ID)

      expect(spec.file).toBe('claude')
      expect(spec.args).toContain('--resume')
      expect(spec.args).toContain(VALID_CLAUDE_SESSION_ID)
    })

    it('does not include --resume when no session ID provided', () => {
      delete process.env.CLAUDE_CMD

      const spec = buildSpawnSpec('claude', '/Users/john', 'system')

      expect(spec.args).not.toContain('--resume')
      expectClaudeTurnCompleteArgs(spec.args)
    })
  })

  describe('codex mode on Unix', () => {
    beforeEach(() => {
      mockPlatform('linux')
    })

    it('spawns codex command directly', () => {
      delete process.env.CODEX_CMD

      const spec = buildSpawnSpec('codex', '/home/user/project', 'system')

      expect(spec.file).toBe('codex')
      expectCodexTurnCompleteArgs(spec.args)
      expect(spec.cwd).toBe('/home/user/project')
    })

    it('uses CODEX_CMD env var when set', () => {
      process.env.CODEX_CMD = '/opt/codex/bin/codex'

      const spec = buildSpawnSpec('codex', '/home/user', 'system')

      expect(spec.file).toBe('/opt/codex/bin/codex')
    })
  })

  describe('environment variables in spawn spec', () => {
    beforeEach(() => {
      mockPlatform('darwin')
    })

    it('includes TERM environment variable', () => {
      delete process.env.TERM

      const spec = buildSpawnSpec('shell', '/Users/john', 'system')

      expect(spec.env.TERM).toBe('xterm-256color')
    })

    it('preserves existing TERM if set', () => {
      process.env.TERM = 'screen-256color'

      const spec = buildSpawnSpec('shell', '/Users/john', 'system')

      expect(spec.env.TERM).toBe('screen-256color')
    })

    it('includes COLORTERM environment variable', () => {
      delete process.env.COLORTERM

      const spec = buildSpawnSpec('shell', '/Users/john', 'system')

      expect(spec.env.COLORTERM).toBe('truecolor')
    })

    it('preserves existing COLORTERM if set', () => {
      process.env.COLORTERM = '24bit'

      const spec = buildSpawnSpec('shell', '/Users/john', 'system')

      expect(spec.env.COLORTERM).toBe('24bit')
    })

    it('passes through other environment variables', () => {
      process.env.MY_CUSTOM_VAR = 'test-value'

      const spec = buildSpawnSpec('shell', '/Users/john', 'system')

      expect(spec.env.MY_CUSTOM_VAR).toBe('test-value')
    })
  })

  describe('cwd handling on Unix', () => {
    beforeEach(() => {
      mockPlatform('darwin')
    })

    it('passes undefined cwd when not provided', () => {
      delete process.env.SHELL

      const spec = buildSpawnSpec('shell', undefined, 'system')

      expect(spec.cwd).toBeUndefined()
    })

    it('handles paths with spaces', () => {
      delete process.env.SHELL

      const spec = buildSpawnSpec('shell', '/Users/john/My Documents/Project Name', 'system')

      expect(spec.cwd).toBe('/Users/john/My Documents/Project Name')
    })

    it('handles deep nested paths', () => {
      delete process.env.SHELL

      const spec = buildSpawnSpec('shell', '/var/www/html/sites/mysite/public_html', 'system')

      expect(spec.cwd).toBe('/var/www/html/sites/mysite/public_html')
    })

    it('handles root path', () => {
      delete process.env.SHELL

      const spec = buildSpawnSpec('shell', '/', 'system')

      expect(spec.cwd).toBe('/')
    })
  })

  describe('shell type normalization on Unix', () => {
    beforeEach(() => {
      mockPlatform('darwin')
    })

    it('normalizes cmd shell type to system on Unix', () => {
      process.env.SHELL = '/bin/zsh'

      // On Unix, 'cmd' should be normalized to 'system' shell
      const spec = buildSpawnSpec('shell', '/Users/john', 'cmd')

      // The shell should still use the system shell, not cmd.exe
      expect(spec.file).toBe('/bin/zsh')
    })

    it('normalizes powershell shell type to system on Unix', () => {
      process.env.SHELL = '/bin/bash'

      // On Unix, 'powershell' should be normalized to 'system' shell
      const spec = buildSpawnSpec('shell', '/Users/john', 'powershell')

      expect(spec.file).toBe('/bin/bash')
    })

    it('normalizes wsl shell type to system on Unix', () => {
      process.env.SHELL = '/bin/bash'

      // On Unix, 'wsl' should be normalized to 'system' shell
      const spec = buildSpawnSpec('shell', '/Users/john', 'wsl')

      expect(spec.file).toBe('/bin/bash')
    })
  })

  describe('spawn spec structure completeness', () => {
    beforeEach(() => {
      mockPlatform('darwin')
    })

    it('returns all required fields for shell mode', () => {
      delete process.env.SHELL

      const spec = buildSpawnSpec('shell', '/Users/john', 'system')

      // Verify structure has all required fields
      expect(spec).toHaveProperty('file')
      expect(spec).toHaveProperty('args')
      expect(spec).toHaveProperty('cwd')
      expect(spec).toHaveProperty('env')
      expect(typeof spec.file).toBe('string')
      expect(Array.isArray(spec.args)).toBe(true)
      expect(typeof spec.env).toBe('object')
    })

    it('returns all required fields for claude mode', () => {
      const spec = buildSpawnSpec('claude', '/Users/john', 'system')

      expect(spec).toHaveProperty('file')
      expect(spec).toHaveProperty('args')
      expect(spec).toHaveProperty('cwd')
      expect(spec).toHaveProperty('env')
    })

    it('returns all required fields for codex mode', () => {
      const spec = buildSpawnSpec('codex', '/Users/john', 'system')

      expect(spec).toHaveProperty('file')
      expect(spec).toHaveProperty('args')
      expect(spec).toHaveProperty('cwd')
      expect(spec).toHaveProperty('env')
    })
  })

  describe('claude mode on Linux', () => {
    beforeEach(() => {
      mockPlatform('linux')
    })

    it('spawns claude command directly on Linux', () => {
      delete process.env.CLAUDE_CMD

      const spec = buildSpawnSpec('claude', '/home/user/project', 'system')

      expect(spec.file).toBe('claude')
      expect(spec.cwd).toBe('/home/user/project')
    })

    it('uses CLAUDE_CMD env var on Linux when set', () => {
      process.env.CLAUDE_CMD = '/usr/local/bin/my-claude'

      const spec = buildSpawnSpec('claude', '/home/user', 'system')

      expect(spec.file).toBe('/usr/local/bin/my-claude')
    })

    it('handles --resume flag correctly on Linux', () => {
      delete process.env.CLAUDE_CMD

      const spec = buildSpawnSpec('claude', '/home/user', 'system', VALID_CLAUDE_SESSION_ID)

      expect(spec.args).toContain('--resume')
      expect(spec.args).toContain(VALID_CLAUDE_SESSION_ID)
      expectClaudeTurnCompleteArgs(spec.args)
      expect(spec.args.slice(-2)).toEqual(['--resume', VALID_CLAUDE_SESSION_ID])
    })

    it('includes proper env vars in claude mode on Linux', () => {
      delete process.env.TERM
      delete process.env.COLORTERM

      const spec = buildSpawnSpec('claude', '/home/user', 'system')

      expect(spec.env.TERM).toBe('xterm-256color')
      expect(spec.env.COLORTERM).toBe('truecolor')
    })
  })

  describe('codex mode on macOS', () => {
    beforeEach(() => {
      mockPlatform('darwin')
    })

    it('spawns codex command directly on macOS', () => {
      delete process.env.CODEX_CMD

      const spec = buildSpawnSpec('codex', '/Users/john/project', 'system')

      expect(spec.file).toBe('codex')
      expectCodexTurnCompleteArgs(spec.args)
      expect(spec.cwd).toBe('/Users/john/project')
    })

    it('uses CODEX_CMD env var on macOS when set', () => {
      process.env.CODEX_CMD = '/Applications/Codex.app/Contents/MacOS/codex'

      const spec = buildSpawnSpec('codex', '/Users/john', 'system')

      expect(spec.file).toBe('/Applications/Codex.app/Contents/MacOS/codex')
    })

    it('includes proper env vars in codex mode on macOS', () => {
      delete process.env.TERM
      delete process.env.COLORTERM

      const spec = buildSpawnSpec('codex', '/Users/john', 'system')

      expect(spec.env.TERM).toBe('xterm-256color')
      expect(spec.env.COLORTERM).toBe('truecolor')
    })
  })

  describe('shell mode uses direct spawn (not shell wrapper)', () => {
    it('spawns the shell directly on macOS (no wrapper)', () => {
      mockPlatform('darwin')
      process.env.SHELL = '/bin/zsh'

      const spec = buildSpawnSpec('shell', '/Users/john', 'system')

      // Should spawn zsh directly, not through another shell
      expect(spec.file).toBe('/bin/zsh')
      // Args should be login shell flag only, not a command to execute
      expect(spec.args).toEqual(['-l'])
      // Should NOT have -c flag (which would indicate shell wrapper)
      expect(spec.args).not.toContain('-c')
    })

    it('spawns the shell directly on Linux (no wrapper)', () => {
      mockPlatform('linux')
      process.env.SHELL = '/bin/bash'

      const spec = buildSpawnSpec('shell', '/home/user', 'system')

      expect(spec.file).toBe('/bin/bash')
      expect(spec.args).toEqual(['-l'])
      expect(spec.args).not.toContain('-c')
    })
  })

  describe('various shell fallback scenarios', () => {
    it('falls back to /bin/zsh on macOS when SHELL is invalid', () => {
      mockPlatform('darwin')
      process.env.SHELL = '/nonexistent/shell'
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === '/nonexistent/shell') return false
        if (path === '/bin/zsh') return true
        return false
      })

      const spec = buildSpawnSpec('shell', '/Users/john', 'system')

      expect(spec.file).toBe('/bin/zsh')
    })

    it('falls back to /bin/bash on Linux when SHELL is invalid', () => {
      mockPlatform('linux')
      process.env.SHELL = '/nonexistent/shell'
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === '/nonexistent/shell') return false
        if (path === '/bin/bash') return true
        return false
      })

      const spec = buildSpawnSpec('shell', '/home/user', 'system')

      expect(spec.file).toBe('/bin/bash')
    })

    it('uses /bin/sh as last resort when other shells missing', () => {
      mockPlatform('linux')
      delete process.env.SHELL
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        // No bash, only /bin/sh
        if (path === '/bin/bash') return false
        if (path === '/bin/sh') return true
        return false
      })

      const spec = buildSpawnSpec('shell', '/home/user', 'system')

      expect(spec.file).toBe('/bin/sh')
    })
  })

  describe('home directory paths', () => {
    it('handles typical home directory path on macOS', () => {
      mockPlatform('darwin')
      delete process.env.SHELL

      const spec = buildSpawnSpec('shell', '/Users/johndoe', 'system')

      expect(spec.cwd).toBe('/Users/johndoe')
    })

    it('handles typical home directory path on Linux', () => {
      mockPlatform('linux')
      delete process.env.SHELL

      const spec = buildSpawnSpec('shell', '/home/johndoe', 'system')

      expect(spec.cwd).toBe('/home/johndoe')
    })

    it('handles WSL-style home path on Linux', () => {
      mockPlatform('linux')
      delete process.env.SHELL

      // WSL maps Windows drives under /mnt
      const spec = buildSpawnSpec('shell', '/mnt/c/Users/john/project', 'system')

      expect(spec.cwd).toBe('/mnt/c/Users/john/project')
    })
  })

  describe('special paths', () => {
    beforeEach(() => {
      mockPlatform('linux')
      delete process.env.SHELL
    })

    it('handles /tmp path', () => {
      const spec = buildSpawnSpec('shell', '/tmp', 'system')
      expect(spec.cwd).toBe('/tmp')
    })

    it('handles /var/log path', () => {
      const spec = buildSpawnSpec('shell', '/var/log', 'system')
      expect(spec.cwd).toBe('/var/log')
    })

    it('handles /opt path', () => {
      const spec = buildSpawnSpec('shell', '/opt/myapp', 'system')
      expect(spec.cwd).toBe('/opt/myapp')
    })

    it('handles paths with dots', () => {
      const spec = buildSpawnSpec('shell', '/home/user/.config', 'system')
      expect(spec.cwd).toBe('/home/user/.config')
    })

    it('handles paths with multiple consecutive dots in name', () => {
      const spec = buildSpawnSpec('shell', '/home/user/project..old', 'system')
      expect(spec.cwd).toBe('/home/user/project..old')
    })
  })

  /**
   * Additional comprehensive tests for Mac/Linux spawn behavior
   * These tests ensure thorough coverage of the Unix spawn path in buildSpawnSpec()
   */
  describe('comprehensive Mac/Linux spawn behavior', () => {
    // Store original values to restore after tests
    const originalPlatform = process.platform
    const originalEnv = { ...process.env }

    function mockPlatform(platform: string) {
      Object.defineProperty(process, 'platform', {
        value: platform,
        writable: true,
        configurable: true,
      })
    }

    beforeEach(() => {
      vi.resetAllMocks()
      process.env = { ...originalEnv }
      // Clear WSL-related env vars so mocking platform to 'linux' doesn't trigger WSL detection
      delete process.env.WSL_DISTRO_NAME
      delete process.env.WSL_INTEROP
      delete process.env.WSLENV
      vi.mocked(fs.existsSync).mockReturnValue(true)
    })

    afterEach(() => {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        writable: true,
        configurable: true,
      })
      process.env = originalEnv
    })

    describe('basic shell spawn on macOS (darwin)', () => {
      beforeEach(() => {
        mockPlatform('darwin')
      })

      it('uses system shell from getSystemShell() on macOS', () => {
        process.env.SHELL = '/usr/local/bin/zsh'

        const spec = buildSpawnSpec('shell', '/Users/test', 'system')

        expect(spec.file).toBe('/usr/local/bin/zsh')
      })

      it('passes -l flag for login shell on macOS', () => {
        process.env.SHELL = '/bin/zsh'

        const spec = buildSpawnSpec('shell', '/Users/test', 'system')

        expect(spec.args).toEqual(['-l'])
      })

      it('sets TERM=xterm-256color when not already set on macOS', () => {
        delete process.env.TERM
        process.env.SHELL = '/bin/zsh'

        const spec = buildSpawnSpec('shell', '/Users/test', 'system')

        expect(spec.env.TERM).toBe('xterm-256color')
      })

      it('preserves existing TERM value on macOS', () => {
        process.env.TERM = 'xterm-color'
        process.env.SHELL = '/bin/zsh'

        const spec = buildSpawnSpec('shell', '/Users/test', 'system')

        expect(spec.env.TERM).toBe('xterm-color')
      })
    })

    describe('basic shell spawn on Linux', () => {
      beforeEach(() => {
        mockPlatform('linux')
      })

      it('uses system shell from getSystemShell() on Linux', () => {
        process.env.SHELL = '/usr/bin/bash'

        const spec = buildSpawnSpec('shell', '/home/user', 'system')

        expect(spec.file).toBe('/usr/bin/bash')
      })

      it('passes -l flag for login shell on Linux', () => {
        process.env.SHELL = '/bin/bash'

        const spec = buildSpawnSpec('shell', '/home/user', 'system')

        expect(spec.args).toEqual(['-l'])
      })

      it('sets TERM=xterm-256color when not already set on Linux', () => {
        delete process.env.TERM
        process.env.SHELL = '/bin/bash'

        const spec = buildSpawnSpec('shell', '/home/user', 'system')

        expect(spec.env.TERM).toBe('xterm-256color')
      })

      it('preserves existing TERM value on Linux', () => {
        process.env.TERM = 'linux'
        process.env.SHELL = '/bin/bash'

        const spec = buildSpawnSpec('shell', '/home/user', 'system')

        expect(spec.env.TERM).toBe('linux')
      })
    })

    describe('spawn with custom cwd', () => {
      it('cwd is passed correctly on macOS', () => {
        mockPlatform('darwin')
        process.env.SHELL = '/bin/zsh'

        const spec = buildSpawnSpec('shell', '/Users/developer/projects/myapp', 'system')

        expect(spec.cwd).toBe('/Users/developer/projects/myapp')
      })

      it('cwd is passed correctly on Linux', () => {
        mockPlatform('linux')
        process.env.SHELL = '/bin/bash'

        const spec = buildSpawnSpec('shell', '/home/user/project', 'system')

        expect(spec.cwd).toBe('/home/user/project')
      })

      it('works with typical Unix paths like /home/user/project', () => {
        mockPlatform('linux')
        process.env.SHELL = '/bin/bash'

        const spec = buildSpawnSpec('shell', '/home/user/project', 'system')

        expect(spec.cwd).toBe('/home/user/project')
        // Verify it's a valid Unix-style path
        expect(spec.cwd?.startsWith('/')).toBe(true)
      })

      it('handles undefined cwd gracefully', () => {
        mockPlatform('linux')
        process.env.SHELL = '/bin/bash'

        const spec = buildSpawnSpec('shell', undefined, 'system')

        expect(spec.cwd).toBeUndefined()
      })
    })

    describe('claude mode on Mac/Linux', () => {
      it('spawns claude command on macOS when mode is claude', () => {
        mockPlatform('darwin')
        delete process.env.CLAUDE_CMD

        const spec = buildSpawnSpec('claude', '/Users/developer', 'system')

        expect(spec.file).toBe('claude')
        expect(spec.cwd).toBe('/Users/developer')
      })

      it('spawns claude command on Linux when mode is claude', () => {
        mockPlatform('linux')
        delete process.env.CLAUDE_CMD

        const spec = buildSpawnSpec('claude', '/home/user', 'system')

        expect(spec.file).toBe('claude')
        expect(spec.cwd).toBe('/home/user')
      })

      it('command is passed correctly with custom CLAUDE_CMD', () => {
        mockPlatform('darwin')
        process.env.CLAUDE_CMD = '/opt/claude/bin/claude'

        const spec = buildSpawnSpec('claude', '/Users/developer', 'system')

        expect(spec.file).toBe('/opt/claude/bin/claude')
      })

      it('includes --resume flag with session ID when resuming', () => {
        mockPlatform('darwin')
        delete process.env.CLAUDE_CMD

        const spec = buildSpawnSpec('claude', '/Users/developer', 'system', VALID_CLAUDE_SESSION_ID)

        expect(spec.args).toContain('--resume')
        expect(spec.args).toContain(VALID_CLAUDE_SESSION_ID)
      })

      it('has empty args when not resuming session', () => {
        mockPlatform('darwin')
        delete process.env.CLAUDE_CMD

        const spec = buildSpawnSpec('claude', '/Users/developer', 'system')

        expectClaudeTurnCompleteArgs(spec.args)
      })
    })

    describe('codex mode on Mac/Linux', () => {
      it('spawns codex command on macOS when mode is codex', () => {
        mockPlatform('darwin')
        delete process.env.CODEX_CMD

        const spec = buildSpawnSpec('codex', '/Users/developer', 'system')

        expect(spec.file).toBe('codex')
        expect(spec.cwd).toBe('/Users/developer')
      })

      it('spawns codex command on Linux when mode is codex', () => {
        mockPlatform('linux')
        delete process.env.CODEX_CMD

        const spec = buildSpawnSpec('codex', '/home/user', 'system')

        expect(spec.file).toBe('codex')
        expect(spec.cwd).toBe('/home/user')
      })

      it('command is passed correctly with custom CODEX_CMD', () => {
        mockPlatform('linux')
        process.env.CODEX_CMD = '/usr/local/bin/codex-cli'

        const spec = buildSpawnSpec('codex', '/home/user', 'system')

        expect(spec.file).toBe('/usr/local/bin/codex-cli')
      })

      it('has empty args for codex mode', () => {
        mockPlatform('linux')
        delete process.env.CODEX_CMD

        const spec = buildSpawnSpec('codex', '/home/user', 'system')

        expectCodexTurnCompleteArgs(spec.args)
      })
    })

    describe('environment variables', () => {
      it('SHELL env var is used for shell selection', () => {
        mockPlatform('linux')
        process.env.SHELL = '/usr/bin/fish'

        const spec = buildSpawnSpec('shell', '/home/user', 'system')

        expect(spec.file).toBe('/usr/bin/fish')
      })

      it('TERM defaults to xterm-256color when not set', () => {
        mockPlatform('linux')
        delete process.env.TERM
        process.env.SHELL = '/bin/bash'

        const spec = buildSpawnSpec('shell', '/home/user', 'system')

        expect(spec.env.TERM).toBe('xterm-256color')
      })

      it('COLORTERM defaults to truecolor when not set', () => {
        mockPlatform('linux')
        delete process.env.COLORTERM
        process.env.SHELL = '/bin/bash'

        const spec = buildSpawnSpec('shell', '/home/user', 'system')

        expect(spec.env.COLORTERM).toBe('truecolor')
      })

      it('custom env vars are passed through', () => {
        mockPlatform('darwin')
        process.env.SHELL = '/bin/zsh'
        process.env.CUSTOM_VAR = 'custom_value'
        process.env.ANOTHER_VAR = 'another_value'

        const spec = buildSpawnSpec('shell', '/Users/test', 'system')

        expect(spec.env.CUSTOM_VAR).toBe('custom_value')
        expect(spec.env.ANOTHER_VAR).toBe('another_value')
      })

      it('preserves PATH environment variable', () => {
        mockPlatform('linux')
        process.env.SHELL = '/bin/bash'
        process.env.PATH = '/usr/local/bin:/usr/bin:/bin'

        const spec = buildSpawnSpec('shell', '/home/user', 'system')

        expect(spec.env.PATH).toBe('/usr/local/bin:/usr/bin:/bin')
      })

      it('preserves HOME environment variable', () => {
        mockPlatform('darwin')
        process.env.SHELL = '/bin/zsh'
        process.env.HOME = '/Users/developer'

        const spec = buildSpawnSpec('shell', '/Users/developer', 'system')

        expect(spec.env.HOME).toBe('/Users/developer')
      })
    })

    describe('shell type normalization on Unix platforms', () => {
      it('normalizes windows shell types to system on darwin', () => {
        mockPlatform('darwin')
        process.env.SHELL = '/bin/zsh'

        // cmd, powershell, and wsl should all normalize to system shell on macOS
        const specCmd = buildSpawnSpec('shell', '/Users/test', 'cmd')
        const specPowershell = buildSpawnSpec('shell', '/Users/test', 'powershell')
        const specWsl = buildSpawnSpec('shell', '/Users/test', 'wsl')

        expect(specCmd.file).toBe('/bin/zsh')
        expect(specPowershell.file).toBe('/bin/zsh')
        expect(specWsl.file).toBe('/bin/zsh')
      })

      it('normalizes windows shell types to system on native linux (not WSL)', () => {
        mockPlatform('linux')
        process.env.SHELL = '/bin/bash'
        // Clear WSL env vars to simulate native Linux (not WSL)
        delete process.env.WSL_DISTRO_NAME
        delete process.env.WSL_INTEROP
        delete process.env.WSLENV

        // cmd, powershell, and wsl should all normalize to system shell on native Linux
        const specCmd = buildSpawnSpec('shell', '/home/user', 'cmd')
        const specPowershell = buildSpawnSpec('shell', '/home/user', 'powershell')
        const specWsl = buildSpawnSpec('shell', '/home/user', 'wsl')

        expect(specCmd.file).toBe('/bin/bash')
        expect(specPowershell.file).toBe('/bin/bash')
        expect(specWsl.file).toBe('/bin/bash')
      })
    })

    describe('spawn spec completeness for Unix', () => {
      it('returns complete spec object with all required fields for shell mode', () => {
        mockPlatform('darwin')
        process.env.SHELL = '/bin/zsh'

        const spec = buildSpawnSpec('shell', '/Users/test', 'system')

        expect(spec).toMatchObject({
          file: expect.any(String),
          args: expect.any(Array),
          env: expect.any(Object),
        })
        expect(spec).toHaveProperty('cwd')
      })

      it('returns complete spec object for claude mode', () => {
        mockPlatform('linux')

        const spec = buildSpawnSpec('claude', '/home/user', 'system')

        expect(spec).toMatchObject({
          file: expect.any(String),
          args: expect.any(Array),
          env: expect.any(Object),
        })
        expect(spec).toHaveProperty('cwd')
      })

      it('returns complete spec object for codex mode', () => {
        mockPlatform('linux')

        const spec = buildSpawnSpec('codex', '/home/user', 'system')

        expect(spec).toMatchObject({
          file: expect.any(String),
          args: expect.any(Array),
          env: expect.any(Object),
        })
        expect(spec).toHaveProperty('cwd')
      })
    })
  })
})
