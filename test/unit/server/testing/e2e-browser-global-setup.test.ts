import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { ensureBuiltRuntime, installBuiltRuntimeRefresh } from '../../../setup/e2e-browser-global-setup.js'

describe('ensureBuiltRuntime', () => {
  it('rebuilds the compiled runtime before helper tests', () => {
    const execFileSync = vi.fn()
    const rmSync = vi.fn()

    ensureBuiltRuntime('/repo', {
      execFileSync,
      rmSync,
      env: { PATH: '/bin' },
      platform: 'linux',
    })

    expect(rmSync).toHaveBeenCalledWith(path.join('/repo', 'dist', '.env'), { force: true })
    expect(execFileSync).toHaveBeenCalledWith('npm', ['run', 'build'], {
      cwd: '/repo',
      env: {
        PATH: '/bin',
        NODE_ENV: 'production',
      },
      stdio: 'inherit',
    })
  })

  it('uses npm.cmd on Windows', () => {
    const execFileSync = vi.fn()
    const rmSync = vi.fn()

    ensureBuiltRuntime('C:\\repo', {
      execFileSync,
      rmSync,
      env: { PATH: 'C:\\Windows\\System32' },
      platform: 'win32',
    })

    expect(rmSync).toHaveBeenCalledWith(path.join('C:\\repo', 'dist', '.env'), { force: true })
    expect(execFileSync).toHaveBeenCalledWith('npm.cmd', ['run', 'build'], {
      cwd: 'C:\\repo',
      env: {
        PATH: 'C:\\Windows\\System32',
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
