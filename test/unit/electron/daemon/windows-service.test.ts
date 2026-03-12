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
    <Command>cmd.exe</Command>
    <Arguments>/c "set "NODE_PATH={{NODE_PATH}}" &amp;&amp; set "NODE_ENV=production" &amp;&amp; set "PORT={{PORT}}" &amp;&amp; set "FRESHELL_CONFIG_DIR={{CONFIG_DIR}}" &amp;&amp; "{{NODE_BINARY}}" "{{SERVER_ENTRY}}""</Arguments>
    <WorkingDirectory>{{CONFIG_DIR}}</WorkingDirectory>
  </Exec></Actions>
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

    it('uses cmd.exe wrapper to set environment variables (Task Scheduler has no Environment support)', async () => {
      setupExecFileSuccess()
      await manager.install(testPaths, 3001)

      const writtenContent = mockWriteFile.mock.calls[0][1] as string
      // Command must be cmd.exe, not the node binary directly
      expect(writtenContent).toContain('<Command>cmd.exe</Command>')
      // Arguments must contain set commands for NODE_PATH, NODE_ENV, PORT, and FRESHELL_CONFIG_DIR
      expect(writtenContent).toContain('set "NODE_PATH=')
      expect(writtenContent).toContain('set "NODE_ENV=production"')
      expect(writtenContent).toContain('set "PORT=3001"')
      expect(writtenContent).toContain('set "FRESHELL_CONFIG_DIR=')
      // The node binary and server entry must appear in the arguments, not as the Command
      expect(writtenContent).toContain(testPaths.nodeBinary)
      expect(writtenContent).toContain(testPaths.serverEntry)
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

    it('constructs WMIC LIKE clause with correct quoting (% wildcards inside quotes)', async () => {
      // First install to set the nodeBinaryPath
      setupExecFileSuccess()
      await manager.install(testPaths, 3001)

      // Configure wmic to return a PID
      mockExecFile.mockImplementation((cmd: string, _args: string[], callback: Function) => {
        if (cmd === 'wmic') {
          callback(null, 'ProcessId=99\r\n', '')
        } else {
          callback(null, '', '')
        }
      })

      await manager.stop()

      const wmicCall = mockExecFile.mock.calls.find(
        (call: any[]) => call[0] === 'wmic'
      )
      expect(wmicCall).toBeDefined()

      // The WMIC where clause is the 3rd argument (index 2)
      const whereClause = wmicCall![1][2] as string
      // The LIKE pattern must have % wildcards INSIDE the quotes: like '%...%'
      // NOT like '%...'% (which is a syntax error)
      expect(whereClause).toMatch(/like '%[^']+%'/)
      // Ensure it does NOT end with '%  (% outside quotes)
      expect(whereClause).not.toMatch(/'%$/)
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
