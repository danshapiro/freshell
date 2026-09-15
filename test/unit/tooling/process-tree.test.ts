import { spawn } from 'node:child_process'
import { once } from 'node:events'

import { describe, expect, it } from 'vitest'
import {
  findReleaseServerPid,
  isProcessRunning,
  readProcessSnapshot,
  signalProcessTree,
} from '../../../scripts/testing/process-tree.js'

const itUnix = process.platform === 'win32' ? it.skip : it

describe('process tree signalling', () => {
  itUnix('signals a phase and every descendant so none outlives a stopped phase', async () => {
    const parent = spawn(process.execPath, ['-e', [
      "const { spawn } = require('node:child_process')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      'console.log(child.pid)',
      'setInterval(() => {}, 1000)',
    ].join('\n')], { stdio: ['ignore', 'pipe', 'inherit'] })
    const [firstChunk] = await once(parent.stdout!, 'data') as [Buffer]
    const grandchildPid = Number.parseInt(firstChunk.toString().trim(), 10)
    const parentExit = once(parent, 'exit')

    const signalled = signalProcessTree(parent.pid!, 'SIGTERM')

    expect(signalled).toEqual(expect.arrayContaining([parent.pid, grandchildPid]))
    await parentExit
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && isProcessRunning(grandchildPid)) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(isProcessRunning(grandchildPid)).toBe(false)
  })

  itUnix('reports an exited process as not running', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await once(child, 'exit')

    expect(isProcessRunning(child.pid!)).toBe(false)
    expect(isProcessRunning(process.pid)).toBe(true)
  })
})

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
