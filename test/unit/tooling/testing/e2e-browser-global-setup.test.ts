import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { ensureBuiltRuntime, installBuiltRuntimeRefresh } from '../../../setup/e2e-browser-global-setup.js'

describe('ensureBuiltRuntime', () => {
  it('rebuilds the client and Rust runtime before helper tests', () => {
    const execFileSync = vi.fn()
    const rmSync = vi.fn()

    ensureBuiltRuntime('/repo', {
      execFileSync,
      rmSync,
      env: { PATH: '/bin' },
      platform: 'linux',
    })

    expect(rmSync).toHaveBeenCalledWith(path.join('/repo', 'dist', '.env'), { force: true })
    expect(execFileSync).toHaveBeenNthCalledWith(1, 'npm', ['run', 'build:client'], {
      cwd: '/repo',
      env: {
        PATH: '/bin',
        NODE_ENV: 'production',
      },
      stdio: 'inherit',
    })
    expect(execFileSync).toHaveBeenNthCalledWith(2, 'cargo', ['build', '--release', '-p', 'freshell-server', '--locked'], {
      cwd: '/repo',
      env: {
        PATH: '/bin',
        NODE_ENV: 'production',
      },
      stdio: 'inherit',
    })
  })

  it('uses the npm CLI JavaScript entrypoint on Windows when npm exposes it', () => {
    const execFileSync = vi.fn()
    const rmSync = vi.fn()
    const npmExecPath = path.join('C:\\repo', 'node_modules', 'npm', 'bin', 'npm-cli.js')

    ensureBuiltRuntime('C:\\repo', {
      execFileSync,
      rmSync,
      env: {
        PATH: 'C:\\Windows\\System32',
        npm_execpath: npmExecPath,
      },
      platform: 'win32',
    })

    expect(rmSync).toHaveBeenCalledWith(path.join('C:\\repo', 'dist', '.env'), { force: true })
    expect(execFileSync).toHaveBeenNthCalledWith(1, process.execPath, [npmExecPath, 'run', 'build:client'], {
      cwd: 'C:\\repo',
      env: {
        PATH: 'C:\\Windows\\System32',
        npm_execpath: npmExecPath,
        NODE_ENV: 'production',
      },
      stdio: 'inherit',
    })
    expect(execFileSync).toHaveBeenNthCalledWith(2, 'cargo', ['build', '--release', '-p', 'freshell-server', '--locked'], {
      cwd: 'C:\\repo',
      env: {
        PATH: 'C:\\Windows\\System32',
        npm_execpath: npmExecPath,
        NODE_ENV: 'production',
      },
      stdio: 'inherit',
    })
  })

  it('rebuilds the compiled runtime on every watch rerun', async () => {
    let rerunHandler: ((testFiles: unknown[]) => Promise<void> | void) | undefined
    const ensureBuiltRuntime = vi.fn()

    installBuiltRuntimeRefresh({
      onTestsRerun(handler) {
        rerunHandler = handler
      },
    }, '/repo', {
      ensureBuiltRuntime,
    })

    expect(ensureBuiltRuntime).toHaveBeenCalledTimes(1)
    expect(ensureBuiltRuntime).toHaveBeenNthCalledWith(1, '/repo')
    expect(rerunHandler).toBeTypeOf('function')

    await rerunHandler?.([])

    expect(ensureBuiltRuntime).toHaveBeenCalledTimes(2)
    expect(ensureBuiltRuntime).toHaveBeenNthCalledWith(2, '/repo')
  })
})
