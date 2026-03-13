import { describe, expect, it, vi } from 'vitest'

import { ensureBuiltServerEntry } from '../../../setup/server-global-setup.js'

describe('ensureBuiltServerEntry', () => {
  it('builds dist/server before the parallel server suite only when the entry is missing', () => {
    const execFileSync = vi.fn()

    ensureBuiltServerEntry('/repo', {
      existsSync: vi.fn().mockReturnValue(false),
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

  it('skips the build when dist/server/index.js already exists', () => {
    const execFileSync = vi.fn()

    ensureBuiltServerEntry('/repo', {
      existsSync: vi.fn().mockReturnValue(true),
      execFileSync,
      env: { PATH: '/bin' },
      platform: 'linux',
    })

    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('uses npm.cmd on Windows', () => {
    const execFileSync = vi.fn()

    ensureBuiltServerEntry('C:\\repo', {
      existsSync: vi.fn().mockReturnValue(false),
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
