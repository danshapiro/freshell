import { describe, expect, it } from 'vitest'
import {
  findReleaseServerPid,
  readProcessSnapshot,
} from '../../../scripts/testing/process-tree.js'

describe('process tree ownership', () => {
  it('finds a release Rust server below a Windows npm wrapper', () => {
    const records = [
      { pid: 4100, parentPid: 4000, commandLine: 'C:\\Program Files\\nodejs\\npm.cmd start' },
      { pid: 4200, parentPid: 4100, commandLine: 'C:\\repo\\node_modules\\.bin\\tsx.cmd scripts/start-rust-server.ts target/release/freshell-server' },
      { pid: 4300, parentPid: 4200, commandLine: '"C:\\repo\\target\\release\\freshell-server.exe" --port 4567' },
      { pid: 4400, parentPid: 9999, commandLine: 'C:\\other\\target\\release\\freshell-server.exe --port 9999' },
    ]

    expect(findReleaseServerPid(4000, records, 'win32')).toBe(4300)
  })

  it('parses the Windows process table through the injected command runner', () => {
    const records = readProcessSnapshot('win32', (command, args) => {
      expect(command).toBe('powershell.exe')
      expect(args.join(' ')).toContain('Get-CimInstance Win32_Process')
      return {
        status: 0,
        stdout: JSON.stringify({
          ProcessId: 4300,
          ParentProcessId: 4200,
          CommandLine: '"C:\\repo\\target\\release\\freshell-server.exe" --port 4567',
        }),
      }
    })

    expect(records).toEqual([{
      pid: 4300,
      parentPid: 4200,
      commandLine: '"C:\\repo\\target\\release\\freshell-server.exe" --port 4567',
    }])
  })
})
