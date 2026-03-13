import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { ensureBuiltServerEntry, installBuiltServerEntryRefresh } from '../../../setup/server-global-setup.js'

describe('ensureBuiltServerEntry', () => {
  it('rebuilds dist/server before the parallel server suite', () => {
    const execFileSync = vi.fn()
    const rmSync = vi.fn()

    ensureBuiltServerEntry('/repo', {
      execFileSync,
      rmSync,
      env: { PATH: '/bin' },
      platform: 'linux',
    })

    expect(rmSync).toHaveBeenCalledWith(path.join('/repo', 'dist', '.env'), { force: true })
    expect(execFileSync).toHaveBeenCalledWith('npm', ['run', 'build:server'], {
      cwd: '/repo',
      env: {
        PATH: '/bin',
        NODE_ENV: 'production',
      },
      stdio: 'inherit',
    })
  })

  it('rebuilds even when dist/server/index.js already exists so worktree artifacts cannot go stale', () => {
    const execFileSync = vi.fn()
    const rmSync = vi.fn()

    ensureBuiltServerEntry('/repo', {
      execFileSync,
      rmSync,
      env: { PATH: '/bin' },
      platform: 'linux',
    })

    expect(rmSync).toHaveBeenCalledWith(path.join('/repo', 'dist', '.env'), { force: true })
    expect(execFileSync).toHaveBeenCalledWith('npm', ['run', 'build:server'], {
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

    ensureBuiltServerEntry('C:\\repo', {
      execFileSync,
      rmSync,
      env: { PATH: 'C:\\Windows\\System32' },
      platform: 'win32',
    })

    expect(rmSync).toHaveBeenCalledWith(path.join('C:\\repo', 'dist', '.env'), { force: true })
    expect(execFileSync).toHaveBeenCalledWith('npm.cmd', ['run', 'build:server'], {
      cwd: 'C:\\repo',
      env: {
        PATH: 'C:\\Windows\\System32',
        NODE_ENV: 'production',
      },
      stdio: 'inherit',
    })
  })

  it('rebuilds dist/server on every watch rerun', async () => {
    let rerunHandler: ((testFiles: unknown[]) => Promise<void> | void) | undefined
    const ensureBuiltServerEntry = vi.fn()

    installBuiltServerEntryRefresh({
      onTestsRerun(handler) {
        rerunHandler = handler
      },
    }, '/repo', {
      ensureBuiltServerEntry,
    })

    expect(ensureBuiltServerEntry).toHaveBeenCalledTimes(1)
    expect(ensureBuiltServerEntry).toHaveBeenNthCalledWith(1, '/repo')
    expect(rerunHandler).toBeTypeOf('function')

    await rerunHandler?.([])

    expect(ensureBuiltServerEntry).toHaveBeenCalledTimes(2)
    expect(ensureBuiltServerEntry).toHaveBeenNthCalledWith(2, '/repo')
  })
})
