import { describe, expect, it, vi } from 'vitest'

import { ensureBuiltServerEntry } from '../../../setup/server-global-setup.js'

describe('ensureBuiltServerEntry', () => {
  it('rebuilds dist/server before the parallel server suite', () => {
    const execFileSync = vi.fn()

    ensureBuiltServerEntry('/repo', {
      execFileSync,
      env: { PATH: '/bin' },
      platform: 'linux',
    })

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

    ensureBuiltServerEntry('/repo', {
      execFileSync,
      env: { PATH: '/bin' },
      platform: 'linux',
    })

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

    ensureBuiltServerEntry('C:\\repo', {
      execFileSync,
      env: { PATH: 'C:\\Windows\\System32' },
      platform: 'win32',
    })

    expect(execFileSync).toHaveBeenCalledWith('npm.cmd', ['run', 'build:server'], {
      cwd: 'C:\\repo',
      env: {
        PATH: 'C:\\Windows\\System32',
        NODE_ENV: 'production',
      },
      stdio: 'inherit',
    })
  })
})
