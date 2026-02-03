import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isLinuxPath, getSystemShell, escapeCmdExe, buildSpawnSpec, TerminalRegistry, isWsl, isWindowsLike } from '../../../server/terminal-registry'
import * as fs from 'fs'

// Mock fs.existsSync for shell existence checks
// Need to provide both named export and default export since the implementation uses `import fs from 'fs'`
vi.mock('fs', () => {
  const existsSync = vi.fn()
  return {
    existsSync,
    default: { existsSync },
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
  }

  beforeEach(() => {
    vi.resetAllMocks()
    // Reset env to a clean state before each test
    process.env = { ...originalEnv }
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

      const spec = buildSpawnSpec('claude', '/Users/john', 'system', 'session-abc123')

      expect(spec.file).toBe('claude')
      expect(spec.args).toContain('--resume')
      expect(spec.args).toContain('session-abc123')
    })

    it('does not include --resume when no session ID provided', () => {
      delete process.env.CLAUDE_CMD

      const spec = buildSpawnSpec('claude', '/Users/john', 'system')

      expect(spec.args).not.toContain('--resume')
      expect(spec.args).toEqual([])
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
      expect(spec.args).toEqual([])
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
      expect(spec.args).toEqual(['resume', 'session-123'])
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

      const spec = buildSpawnSpec('claude', '/home/user', 'system', 'linux-session-123')

      expect(spec.args).toContain('--resume')
      expect(spec.args).toContain('linux-session-123')
      expect(spec.args).toEqual(['--resume', 'linux-session-123'])
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
      expect(spec.args).toEqual([])
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

    it('uses cmd.exe for cmd shell type in WSL', () => {
      mockWsl()

      const spec = buildSpawnSpec('shell', '/home/user/project', 'cmd')

      expect(spec.file).toBe('cmd.exe')
      expect(spec.args).toContain('/K')
    })

    it('uses powershell.exe for powershell shell type in WSL', () => {
      mockWsl()

      const spec = buildSpawnSpec('shell', '/home/user/project', 'powershell')

      expect(spec.file.toLowerCase()).toContain('powershell')
      expect(spec.args).toContain('-NoLogo')
    })
  })

  describe('cwd handling for Windows shells in WSL', () => {
    it('ignores Linux paths for cmd.exe in WSL', () => {
      mockWsl()

      const spec = buildSpawnSpec('shell', '/home/user/project', 'cmd')

      // Linux paths should be ignored for cmd.exe since it can't handle them
      expect(spec.cwd).toBeUndefined()
    })

    it('ignores Linux paths for powershell.exe in WSL', () => {
      mockWsl()

      const spec = buildSpawnSpec('shell', '/home/user/project', 'powershell')

      // Linux paths should be ignored for powershell.exe since it can't handle them
      expect(spec.cwd).toBeUndefined()
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

  describe('create() with resumeSessionId', () => {
    it('stores resumeSessionId on the terminal record when provided', () => {
      const record = registry.create({
        mode: 'claude',
        cwd: '/home/user/project',
        resumeSessionId: 'session-abc123',
      })

      expect(record.resumeSessionId).toBe('session-abc123')
      expect(record.mode).toBe('claude')
    })

    it('leaves resumeSessionId undefined when not provided', () => {
      const record = registry.create({
        mode: 'claude',
        cwd: '/home/user/project',
      })

      expect(record.resumeSessionId).toBeUndefined()
    })

    it('stores resumeSessionId for shell mode terminals', () => {
      const record = registry.create({
        mode: 'shell',
        cwd: '/home/user/project',
        resumeSessionId: 'shell-session-123',
      })

      expect(record.resumeSessionId).toBe('shell-session-123')
      expect(record.mode).toBe('shell')
    })
  })

  describe('list() returns resumeSessionId', () => {
    it('includes resumeSessionId in list output when set', () => {
      registry.create({
        mode: 'claude',
        cwd: '/home/user/project1',
        resumeSessionId: 'session-111',
      })
      registry.create({
        mode: 'claude',
        cwd: '/home/user/project2',
        resumeSessionId: 'session-222',
      })

      const terminals = registry.list()

      expect(terminals).toHaveLength(2)
      const sessionIds = terminals.map(t => t.resumeSessionId).sort()
      expect(sessionIds).toEqual(['session-111', 'session-222'])
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
        resumeSessionId: 'session-exact-match',
      })

      const found = registry.findTerminalsBySession('claude', 'session-exact-match')

      expect(found).toHaveLength(1)
      expect(found[0].terminalId).toBe(record.terminalId)
      expect(found[0].resumeSessionId).toBe('session-exact-match')
    })

    it('returns empty array when no matching resumeSessionId', () => {
      registry.create({
        mode: 'claude',
        cwd: '/home/user/project',
        resumeSessionId: 'session-different',
      })

      const found = registry.findTerminalsBySession('claude', 'session-nonexistent')

      expect(found).toHaveLength(0)
    })

    it('finds multiple terminals with same resumeSessionId', () => {
      registry.create({
        mode: 'claude',
        cwd: '/home/user/project1',
        resumeSessionId: 'session-shared',
      })
      registry.create({
        mode: 'claude',
        cwd: '/home/user/project2',
        resumeSessionId: 'session-shared',
      })

      const found = registry.findTerminalsBySession('claude', 'session-shared')

      expect(found).toHaveLength(2)
      expect(found.every(t => t.resumeSessionId === 'session-shared')).toBe(true)
    })
  })

  describe('findTerminalsBySession() ignores cwd parameter', () => {
    it('does not match by cwd, only by resumeSessionId', () => {
      registry.create({
        mode: 'claude',
        cwd: '/home/user/project',
        resumeSessionId: 'session-different',
      })

      // cwd matches but sessionId doesn't - should not find terminal
      const found = registry.findTerminalsBySession('claude', 'session-nonexistent', '/home/user/project')

      expect(found).toHaveLength(0)
    })

    it('finds terminal by exact resumeSessionId ignoring cwd', () => {
      const record = registry.create({
        mode: 'claude',
        cwd: '/home/user/project-a',
        resumeSessionId: 'session-target',
      })

      // cwd differs but sessionId matches - should find terminal
      const found = registry.findTerminalsBySession('claude', 'session-target', '/home/user/different')

      expect(found).toHaveLength(1)
      expect(found[0].terminalId).toBe(record.terminalId)
    })
  })

  describe('findTerminalsBySession() ignores shell mode', () => {
    it('does not return shell-mode terminals even with matching resumeSessionId', () => {
      registry.create({
        mode: 'shell',
        cwd: '/home/user/project',
        resumeSessionId: 'session-123',
      })

      const found = registry.findTerminalsBySession('claude', 'session-123', '/home/user/project')

      expect(found).toHaveLength(0)
    })

    it('does not return shell-mode terminals with exact resumeSessionId match', () => {
      registry.create({
        mode: 'shell',
        cwd: '/home/user/project',
        resumeSessionId: 'session-exact',
      })

      const found = registry.findTerminalsBySession('claude', 'session-exact')

      expect(found).toHaveLength(0)
    })

    it('does not return codex-mode terminals', () => {
      registry.create({
        mode: 'codex',
        cwd: '/home/user/project',
        resumeSessionId: 'session-123',
      })

      const found = registry.findTerminalsBySession('claude', 'session-123', '/home/user/project')

      expect(found).toHaveLength(0)
    })

    it('returns only claude-mode terminals from mixed modes', () => {
      registry.create({
        mode: 'shell',
        cwd: '/home/user/project',
        resumeSessionId: 'session-shared',
      })
      const claudeRecord = registry.create({
        mode: 'claude',
        cwd: '/home/user/project',
        resumeSessionId: 'session-shared',
      })
      registry.create({
        mode: 'codex',
        cwd: '/home/user/project',
        resumeSessionId: 'session-shared',
      })

      const found = registry.findTerminalsBySession('claude', 'session-shared')

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
      registry.create({ mode: 'claude', cwd: '/home/user/project', resumeSessionId: 'existing-session' })
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

  describe('setResumeSessionId', () => {
    it('should set resumeSessionId on existing terminal', () => {
      const term = registry.create({ mode: 'claude', cwd: '/home/user/project' })

      const result = registry.setResumeSessionId(term.terminalId, 'new-session-id')

      expect(result).toBe(true)
      expect(registry.get(term.terminalId)?.resumeSessionId).toBe('new-session-id')
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
  }

  beforeEach(() => {
    vi.resetAllMocks()
    // Reset env to a clean state before each test
    process.env = { ...originalEnv }
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

      const spec = buildSpawnSpec('claude', '/Users/john', 'system', 'session-abc123')

      expect(spec.file).toBe('claude')
      expect(spec.args).toContain('--resume')
      expect(spec.args).toContain('session-abc123')
    })

    it('does not include --resume when no session ID provided', () => {
      delete process.env.CLAUDE_CMD

      const spec = buildSpawnSpec('claude', '/Users/john', 'system')

      expect(spec.args).not.toContain('--resume')
      expect(spec.args).toEqual([])
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
      expect(spec.args).toEqual([])
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

      const spec = buildSpawnSpec('claude', '/home/user', 'system', 'linux-session-123')

      expect(spec.args).toContain('--resume')
      expect(spec.args).toContain('linux-session-123')
      expect(spec.args).toEqual(['--resume', 'linux-session-123'])
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
      expect(spec.args).toEqual([])
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

        const spec = buildSpawnSpec('claude', '/Users/developer', 'system', 'session-12345')

        expect(spec.args).toContain('--resume')
        expect(spec.args).toContain('session-12345')
      })

      it('has empty args when not resuming session', () => {
        mockPlatform('darwin')
        delete process.env.CLAUDE_CMD

        const spec = buildSpawnSpec('claude', '/Users/developer', 'system')

        expect(spec.args).toEqual([])
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

        expect(spec.args).toEqual([])
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
