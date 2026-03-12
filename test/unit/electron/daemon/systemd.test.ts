import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { DaemonPaths } from '../../../../electron/daemon/daemon-manager.js'

const mockExecFile = vi.fn()
const mockWriteFile = vi.fn().mockResolvedValue(undefined)
const mockReadFile = vi.fn()
const mockMkdir = vi.fn().mockResolvedValue(undefined)
const mockUnlink = vi.fn().mockResolvedValue(undefined)
const mockAccess = vi.fn()
const mockHomedir = vi.fn().mockReturnValue('/home/testuser')

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

import { SystemdDaemonManager } from '../../../../electron/daemon/systemd.js'

const testPaths: DaemonPaths = {
  nodeBinary: '/app/resources/bundled-node/bin/node',
  serverEntry: '/app/resources/server/index.js',
  serverNodeModules: '/app/resources/server-node-modules',
  nativeModules: '/app/resources/bundled-node/native-modules',
  configDir: '/home/testuser/.freshell',
  logDir: '/home/testuser/.freshell/logs',
}

function setupExecFileSuccess(stdout = '') {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], callback: Function) => {
    callback(null, stdout, '')
  })
}

describe('SystemdDaemonManager', () => {
  let manager: SystemdDaemonManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new SystemdDaemonManager()
    mockReadFile.mockResolvedValue(
      '[Unit]\nDescription=Freshell\n\n[Service]\nExecStart={{NODE_BINARY}} {{SERVER_ENTRY}}\n' +
      'Environment=PORT={{PORT}}\nEnvironment=NODE_PATH={{NODE_PATH}}\n' +
      'Environment=FRESHELL_CONFIG_DIR={{CONFIG_DIR}}\n' +
      'StandardOutput=append:{{LOG_DIR}}/server-stdout.log\n' +
      'StandardError=append:{{LOG_DIR}}/server-stderr.log\n\n[Install]\nWantedBy=default.target\n'
    )
  })

  it('has platform set to linux', () => {
    expect(manager.platform).toBe('linux')
  })

  describe('install', () => {
    it('writes unit file with all placeholders replaced and calls daemon-reload and enable', async () => {
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

      // Verify daemon-reload was called
      const reloadCall = mockExecFile.mock.calls.find(
        (call: any[]) => call[0] === 'systemctl' && call[1]?.includes('daemon-reload')
      )
      expect(reloadCall).toBeDefined()

      // Verify enable was called
      const enableCall = mockExecFile.mock.calls.find(
        (call: any[]) => call[0] === 'systemctl' && call[1]?.includes('enable')
      )
      expect(enableCall).toBeDefined()
    })
  })

  describe('uninstall', () => {
    it('calls disable, stop, removes unit file, and daemon-reload', async () => {
      setupExecFileSuccess()
      await manager.uninstall()

      const disableCall = mockExecFile.mock.calls.find(
        (call: any[]) => call[0] === 'systemctl' && call[1]?.includes('disable')
      )
      expect(disableCall).toBeDefined()

      const stopCall = mockExecFile.mock.calls.find(
        (call: any[]) => call[0] === 'systemctl' && call[1]?.includes('stop')
      )
      expect(stopCall).toBeDefined()

      expect(mockUnlink).toHaveBeenCalledTimes(1)

      const reloadCall = mockExecFile.mock.calls.find(
        (call: any[]) => call[0] === 'systemctl' && call[1]?.includes('daemon-reload')
      )
      expect(reloadCall).toBeDefined()
    })
  })

  describe('start', () => {
    it('calls systemctl --user start freshell', async () => {
      setupExecFileSuccess()
      await manager.start()

      const startCall = mockExecFile.mock.calls.find(
        (call: any[]) => call[0] === 'systemctl' && call[1]?.includes('start') && call[1]?.includes('freshell')
      )
      expect(startCall).toBeDefined()
    })
  })

  describe('stop', () => {
    it('calls systemctl --user stop freshell', async () => {
      setupExecFileSuccess()
      await manager.stop()

      const stopCall = mockExecFile.mock.calls.find(
        (call: any[]) => call[0] === 'systemctl' && call[1]?.includes('stop') && call[1]?.includes('freshell')
      )
      expect(stopCall).toBeDefined()
    })
  })

  describe('status', () => {
    it('parses active running process', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], callback: Function) => {
        callback(null, 'ActiveState=active\nMainPID=12345\nExecMainStartTimestamp=Mon 2026-03-08 10:00:00 UTC', '')
      })

      const st = await manager.status()
      expect(st.installed).toBe(true)
      expect(st.running).toBe(true)
      expect(st.pid).toBe(12345)
    })

    it('parses inactive stopped process', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], callback: Function) => {
        callback(null, 'ActiveState=inactive\nMainPID=0\n', '')
      })

      const st = await manager.status()
      expect(st.installed).toBe(true)
      expect(st.running).toBe(false)
    })

    it('returns not installed on error', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], callback: Function) => {
        callback(new Error('Unit freshell.service could not be found'), '', '')
      })

      const st = await manager.status()
      expect(st.installed).toBe(false)
      expect(st.running).toBe(false)
    })
  })

  describe('isInstalled', () => {
    it('returns true when unit file exists', async () => {
      mockAccess.mockResolvedValue(undefined)
      expect(await manager.isInstalled()).toBe(true)
    })

    it('returns false when unit file does not exist', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'))
      expect(await manager.isInstalled()).toBe(false)
    })
  })
})
