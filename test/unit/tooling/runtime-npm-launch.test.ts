// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawn,
}))

import { main as runSourceRuntimeTests } from '../../../scripts/testing/run-source-runtime-tests.js'
import { main as runStandardTests } from '../../../scripts/run-standard-tests.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  spawn.mockReset()
})

describe('runtime test npm subprocesses', () => {
  it.each([
    ['source-runtime prerequisite builder', () => runSourceRuntimeTests([])],
    ['standard source-runtime phase', () => runStandardTests(['test/integration/tooling/source-runtime-rust.test.ts'])],
  ])('launches %s using the npm JavaScript entrypoint on native Windows', async (_name, run) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const npmCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
    vi.stubEnv('npm_execpath', npmCli)
    spawn.mockImplementation((command: string) => {
      const child = Object.assign(new EventEmitter(), { exitCode: null, killed: false })
      queueMicrotask(() => {
        if (command.endsWith('.cmd')) child.emit('error', new Error('spawn EINVAL'))
        else child.emit('exit', 0, null)
      })
      return child
    })

    expect(await run()).toBe(0)
    const launches = spawn.mock.calls.map(([command, args, options]) => ({
      command,
      args,
      windowsHide: options?.windowsHide,
    }))
    expect(launches).toContainEqual({
      command: process.execPath,
      args: expect.arrayContaining([npmCli, 'run']),
      windowsHide: true,
    })
  })
})
