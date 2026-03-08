import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { DaemonPaths } from '../../../../electron/daemon/daemon-manager.js'

const mockExecFile = vi.fn()
const mockReadFile = vi.fn()
const mockWriteFile = vi.fn()
const mockMkdir = vi.fn()
const mockUnlink = vi.fn()

vi.mock('child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}))

vi.mock('fs/promises', () => ({
  default: {
    readFile: (...args: any[]) => mockReadFile(...args),
    writeFile: (...args: any[]) => mockWriteFile(...args),
    mkdir: (...args: any[]) => mockMkdir(...args),
    unlink: (...args: any[]) => mockUnlink(...args),
  },
}))

import { WindowsServiceDaemonManager } from '../../../../electron/daemon/windows-service.js'

const testPaths: DaemonPaths = {
  nodeBinary: 'C:\\App\\resources\\bundled-node\\bin\\node.exe',
  serverEntry: 'C:\\App\\resources\\server\\index.js',
  serverNodeModules: 'C:\\App\\resources\\server-node-modules',
  nativeModules: 'C:\\App\\resources\\bundled-node\\native-modules',
  configDir: 'C:\\Users\\testuser\\.freshell',
  logDir: 'C:\\Users\\testuser\\.freshell\\logs',
}

const TEMPLATE_CONTENT = `<?xml version="1.0"?>
<Task>
  <Actions><Exec>
    <Command>{{NODE_BINARY}}</Command>
    <Arguments>{{SERVER_ENTRY}}</Arguments>
  </Exec></Actions>
  <!-- NODE_PATH={{NODE_PATH}} PORT={{PORT}} CONFIG_DIR={{CONFIG_DIR}} LOG_DIR={{LOG_DIR}} -->
</Task>`

function setupExecFileSuccess(stdout = '') {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], callback: Function) => {
    callback(null, stdout, '')
  })
}

describe('WindowsServiceDaemonManager', () => {
  let manager: WindowsServiceDaemonManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new WindowsServiceDaemonManager()
    mockReadFile.mockResolvedValue(TEMPLATE_CONTENT)
    mockWriteFile.mockResolvedValue(undefined)
    mockMkdir.mockResolvedValue(undefined)
    mockUnlink.mockResolvedValue(undefined)
  })

  it('has platform set to win32', () => {
    expect(manager.platform).toBe('win32')
  })

  describe('install', () => {
    it('reads the XML template, substitutes placeholders, writes XML, and creates task', async () => {
      setupExecFileSuccess()
      await manager.install(testPaths, 3001)

      // Template was read
      expect(mockReadFile).toHaveBeenCalledWith(
        expect.stringContaining('freshell-task.xml.template'),
        'utf-8'
      )

      // XML was written with substituted content
      expect(mockWriteFile).toHaveBeenCalledTimes(1)
      const writtenContent = mockWriteFile.mock.calls[0][1] as string
      expect(writtenContent).toContain('C:\\App\\resources\\bundled-node\\bin\\node.exe')
      expect(writtenContent).toContain('C:\\App\\resources\\server\\index.js')
      expect(writtenContent).not.toContain('{{NODE_BINARY}}')
      expect(writtenContent).not.toContain('{{SERVER_ENTRY}}')

      // schtasks /Create with /XML was called
      const createCall = mockExecFile.mock.calls.find(
        (call: any[]) => call[0] === 'schtasks' && call[1]?.includes('/Create')
      )
      expect(createCall).toBeDefined()
      expect(createCall![1]).toContain('/XML')
      expect(createCall![1]).toContain('/TN')
      expect(createCall![1]).toContain('Freshell Server')
      expect(createCall![1]).toContain('/F')
    })

    it('substitutes NODE_PATH with native-modules and server-node-modules joined by semicolon', async () => {
      setupExecFileSuccess()
      await manager.install(testPaths, 3001)

      const writtenContent = mockWriteFile.mock.calls[0][1] as string
      expect(writtenContent).toContain(
        'C:\\App\\resources\\bundled-node\\native-modules;C:\\App\\resources\\server-node-modules'
      )
    })

    it('is idempotent (/F flag overwrites existing task)', async () => {
      setupExecFileSuccess()
      await manager.install(testPaths, 3001)
      await manager.install(testPaths, 3001)

      const createCalls = mockExecFile.mock.calls.filter(
        (call: any[]) => call[0] === 'schtasks' && call[1]?.includes('/Create')
      )
      expect(createCalls.length).toBe(2)
      for (const call of createCalls) {
        expect(call[1]).toContain('/F')
      }
    })
  })

  describe('uninstall', () => {
    it('deletes scheduled task via schtasks', async () => {
      setupExecFileSuccess()
      await manager.uninstall()

      const deleteCall = mockExecFile.mock.calls.find(
        (call: any[]) => call[0] === 'schtasks' && call[1]?.includes('/Delete')
      )
      expect(deleteCall).toBeDefined()
      expect(deleteCall![1]).toContain('/TN')
      expect(deleteCall![1]).toContain('Freshell Server')
      expect(deleteCall![1]).toContain('/F')
    })
  })

  describe('start', () => {
    it('runs scheduled task via schtasks', async () => {
      setupExecFileSuccess()
      await manager.start()

      const runCall = mockExecFile.mock.calls.find(
        (call: any[]) => call[0] === 'schtasks' && call[1]?.includes('/Run')
      )
      expect(runCall).toBeDefined()
    })
  })

  describe('stop', () => {
    it('finds the Freshell server process by bundled node path and kills only that PID', async () => {
      // First install to set the nodeBinaryPath
      setupExecFileSuccess()
      await manager.install(testPaths, 3001)

      // Configure wmic to return a specific PID
      mockExecFile.mockImplementation((cmd: string, args: string[], callback: Function) => {
        if (cmd === 'wmic') {
          callback(null, 'ProcessId=42\r\n', '')
        } else if (cmd === 'taskkill') {
          callback(null, '', '')
        } else {
          callback(null, '', '')
        }
      })

      await manager.stop()

      // Verify wmic was called to find the specific process
      const wmicCall = mockExecFile.mock.calls.find(
        (call: any[]) => call[0] === 'wmic'
      )
      expect(wmicCall).toBeDefined()

      // Verify taskkill was called with the specific PID, not /IM node.exe
      const killCall = mockExecFile.mock.calls.find(
        (call: any[]) => call[0] === 'taskkill'
      )
      expect(killCall).toBeDefined()
      expect(killCall![1]).toContain('/PID')
      expect(killCall![1]).toContain('42')
      // Ensure it does NOT use /IM node.exe (which would kill ALL node processes)
      expect(killCall![1]).not.toContain('/IM')
    })

    it('falls back to schtasks /End if wmic fails', async () => {
      mockExecFile.mockImplementation((cmd: string, args: string[], callback: Function) => {
        if (cmd === 'wmic') {
          callback(new Error('wmic not available'), '', '')
        } else if (cmd === 'schtasks' && args.includes('/End')) {
          callback(null, '', '')
        } else {
          callback(null, '', '')
        }
      })

      await manager.stop()

      const endCall = mockExecFile.mock.calls.find(
        (call: any[]) => call[0] === 'schtasks' && call[1]?.includes('/End')
      )
      expect(endCall).toBeDefined()
    })
  })

  describe('status', () => {
    it('parses Running status from CSV output', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], callback: Function) => {
        callback(null, '"TaskName","Next Run Time","Status"\r\n"Freshell Server","N/A","Running"\r\n', '')
      })

      const st = await manager.status()
      expect(st.installed).toBe(true)
      expect(st.running).toBe(true)
    })

    it('parses Ready status (installed but not running)', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], callback: Function) => {
        callback(null, '"TaskName","Next Run Time","Status"\r\n"Freshell Server","N/A","Ready"\r\n', '')
      })

      const st = await manager.status()
      expect(st.installed).toBe(true)
      expect(st.running).toBe(false)
    })

    it('returns not installed when task not found', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], callback: Function) => {
        callback(new Error('ERROR: The system cannot find the file specified.'), '', '')
      })

      const st = await manager.status()
      expect(st.installed).toBe(false)
      expect(st.running).toBe(false)
    })
  })

  describe('isInstalled', () => {
    it('returns true when task query succeeds', async () => {
      setupExecFileSuccess('"TaskName"\r\n"Freshell Server"\r\n')
      expect(await manager.isInstalled()).toBe(true)
    })

    it('returns false when task query fails', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], callback: Function) => {
        callback(new Error('not found'), '', '')
      })
      expect(await manager.isInstalled()).toBe(false)
    })
  })
})
