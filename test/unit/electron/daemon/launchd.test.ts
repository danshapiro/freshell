import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { DaemonPaths } from '../../../../electron/daemon/daemon-manager.js'

// Mock child_process and fs
const mockExecFile = vi.fn()
const mockWriteFile = vi.fn().mockResolvedValue(undefined)
const mockReadFile = vi.fn()
const mockMkdir = vi.fn().mockResolvedValue(undefined)
const mockUnlink = vi.fn().mockResolvedValue(undefined)
const mockAccess = vi.fn()
const mockHomedir = vi.fn().mockReturnValue('/Users/testuser')

vi.mock('child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}))

vi.mock('fs/promises', () => ({
  default: {
    writeFile: (...args: any[]) => mockWriteFile(...args),
    readFile: (...args: any[]) => mockReadFile(...args),
    mkdir: (...args: any[]) => mockMkdir(...args),
    unlink: (...args: any[]) => mockUnlink(...args),
    access: (...args: any[]) => mockAccess(...args),
  },
  writeFile: (...args: any[]) => mockWriteFile(...args),
  readFile: (...args: any[]) => mockReadFile(...args),
  mkdir: (...args: any[]) => mockMkdir(...args),
  unlink: (...args: any[]) => mockUnlink(...args),
  access: (...args: any[]) => mockAccess(...args),
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    default: { ...actual, homedir: () => mockHomedir() },
    homedir: () => mockHomedir(),
  }
})

import { LaunchdDaemonManager } from '../../../../electron/daemon/launchd.js'

const testPaths: DaemonPaths = {
  nodeBinary: '/app/resources/bundled-node/bin/node',
  serverEntry: '/app/resources/server/index.js',
  serverNodeModules: '/app/resources/server-node-modules',
  nativeModules: '/app/resources/bundled-node/native-modules',
  configDir: '/Users/testuser/.freshell',
  logDir: '/Users/testuser/.freshell/logs',
}

// Helper to make execFile invoke the callback
function setupExecFileSuccess(stdout = '') {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, callback?: Function) => {
    if (typeof _opts === 'function') {
      _opts(null, stdout, '')
    } else if (callback) {
      callback(null, stdout, '')
    }
  })
}

function setupExecFileError(error: Error & { code?: string }, stderr = '') {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, callback?: Function) => {
    if (typeof _opts === 'function') {
      _opts(error, '', stderr)
    } else if (callback) {
      callback(error, '', stderr)
    }
  })
}

describe('LaunchdDaemonManager', () => {
  let manager: LaunchdDaemonManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new LaunchdDaemonManager()
    // Default: readFile returns the template
    mockReadFile.mockResolvedValue(
      '<?xml version="1.0"?><plist><dict>' +
      '<key>Label</key><string>com.freshell.server</string>' +
      '<key>ProgramArguments</key><array><string>{{NODE_BINARY}}</string><string>{{SERVER_ENTRY}}</string></array>' +
      '<key>EnvironmentVariables</key><dict>' +
      '<key>PORT</key><string>{{PORT}}</string>' +
      '<key>NODE_PATH</key><string>{{NODE_PATH}}</string>' +
      '<key>FRESHELL_CONFIG_DIR</key><string>{{CONFIG_DIR}}</string>' +
      '</dict>' +
      '<key>StandardOutPath</key><string>{{LOG_DIR}}/server-stdout.log</string>' +
      '<key>StandardErrorPath</key><string>{{LOG_DIR}}/server-stderr.log</string>' +
      '</dict></plist>'
    )
  })

  it('has platform set to darwin', () => {
    expect(manager.platform).toBe('darwin')
  })

  describe('install', () => {
    it('writes correct plist content with all placeholders replaced', async () => {
      setupExecFileSuccess()
      await manager.install(testPaths, 3001)

      expect(mockMkdir).toHaveBeenCalled()
      expect(mockWriteFile).toHaveBeenCalledTimes(1)

      const writtenContent = mockWriteFile.mock.calls[0][1] as string
      expect(writtenContent).not.toContain('{{NODE_BINARY}}')
      expect(writtenContent).not.toContain('{{SERVER_ENTRY}}')
      expect(writtenContent).not.toContain('{{PORT}}')
      expect(writtenContent).not.toContain('{{NODE_PATH}}')
      expect(writtenContent).not.toContain('{{CONFIG_DIR}}')
      expect(writtenContent).not.toContain('{{LOG_DIR}}')

      expect(writtenContent).toContain(testPaths.nodeBinary)
      expect(writtenContent).toContain(testPaths.serverEntry)
      expect(writtenContent).toContain('3001')
      expect(writtenContent).toContain(testPaths.nativeModules)
      expect(writtenContent).toContain(testPaths.serverNodeModules)
    })

    it('calls launchctl load -w after writing plist', async () => {
      setupExecFileSuccess()
      await manager.install(testPaths, 3001)

      // Should have called execFile for launchctl load
      const launchctlCall = mockExecFile.mock.calls.find(
        (call: any[]) => call[0] === 'launchctl' && call[1]?.[0] === 'load'
      )
      expect(launchctlCall).toBeDefined()
      expect(launchctlCall![1]).toContain('-w')
    })

    it('is idempotent (re-writes plist if already exists)', async () => {
      setupExecFileSuccess()
      await manager.install(testPaths, 3001)
      await manager.install(testPaths, 3002)

      // writeFile called twice
      expect(mockWriteFile).toHaveBeenCalledTimes(2)
      // Second write should have port 3002
      const secondContent = mockWriteFile.mock.calls[1][1] as string
      expect(secondContent).toContain('3002')
    })
  })

  describe('uninstall', () => {
    it('calls launchctl unload and removes plist file', async () => {
      setupExecFileSuccess()
      await manager.uninstall()

      const unloadCall = mockExecFile.mock.calls.find(
        (call: any[]) => call[0] === 'launchctl' && call[1]?.[0] === 'unload'
      )
      expect(unloadCall).toBeDefined()
      expect(mockUnlink).toHaveBeenCalledTimes(1)
    })
  })

  describe('start', () => {
    it('calls launchctl start com.freshell.server', async () => {
      setupExecFileSuccess()
      await manager.start()

      const startCall = mockExecFile.mock.calls.find(
        (call: any[]) => call[0] === 'launchctl' && call[1]?.[0] === 'start'
      )
      expect(startCall).toBeDefined()
      expect(startCall![1]).toContain('com.freshell.server')
    })
  })

  describe('stop', () => {
    it('calls launchctl stop com.freshell.server', async () => {
      setupExecFileSuccess()
      await manager.stop()

      const stopCall = mockExecFile.mock.calls.find(
        (call: any[]) => call[0] === 'launchctl' && call[1]?.[0] === 'stop'
      )
      expect(stopCall).toBeDefined()
      expect(stopCall![1]).toContain('com.freshell.server')
    })
  })

  describe('status', () => {
    it('parses running process (PID present)', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], callback: Function) => {
        // launchctl list output for a running service
        callback(null, '{\n\t"LimitLoadToSessionType" = "Aqua";\n\t"Label" = "com.freshell.server";\n\t"OnDemand" = false;\n\t"LastExitStatus" = 0;\n\t"PID" = 12345;\n\t"Program" = "/app/node";\n};', '')
      })

      const st = await manager.status()
      expect(st.installed).toBe(true)
      expect(st.running).toBe(true)
      expect(st.pid).toBe(12345)
    })

    it('parses stopped process (no PID, exit code shown)', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], callback: Function) => {
        callback(null, '{\n\t"Label" = "com.freshell.server";\n\t"LastExitStatus" = 256;\n};', '')
      })

      const st = await manager.status()
      expect(st.installed).toBe(true)
      expect(st.running).toBe(false)
    })

    it('returns not installed when service not found', async () => {
      const error = new Error('Could not find service') as Error & { code?: string }
      error.code = 'EXIT_NON_ZERO'
      mockExecFile.mockImplementation((_cmd: string, _args: string[], callback: Function) => {
        callback(error, '', 'Could not find service "com.freshell.server" in domain for port')
      })

      const st = await manager.status()
      expect(st.installed).toBe(false)
      expect(st.running).toBe(false)
    })
  })

  describe('isInstalled', () => {
    it('returns true when plist file exists', async () => {
      mockAccess.mockResolvedValue(undefined)
      const result = await manager.isInstalled()
      expect(result).toBe(true)
    })

    it('returns false when plist file does not exist', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'))
      const result = await manager.isInstalled()
      expect(result).toBe(false)
    })
  })
})
