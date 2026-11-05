import { spawnSync as realSpawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

import { ensureFreshE2eBuild } from '../../../e2e-browser/global-setup.js'

describe('Playwright e2e global setup', () => {
  it('rebuilds the current client and Rust server assets instead of accepting an existing dist build', () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0, signal: null })
    const log = vi.fn()

    ensureFreshE2eBuild('/repo', {
      spawnSync: spawnSync as unknown as typeof realSpawnSync,
      env: { PATH: '/bin' },
      platform: 'linux',
      log: { log },
    })

    expect(spawnSync).toHaveBeenNthCalledWith(1, 'npm', ['run', 'prebuild'], {
      cwd: '/repo',
      env: {
        PATH: '/bin',
        NODE_ENV: 'production',
      },
      stdio: 'inherit',
      shell: false,
    })
    expect(spawnSync).toHaveBeenNthCalledWith(2, 'npm', ['run', 'build:client'], {
      cwd: '/repo',
      env: {
        PATH: '/bin',
        NODE_ENV: 'production',
      },
      stdio: 'inherit',
      shell: false,
    })
    expect(spawnSync).toHaveBeenNthCalledWith(3, 'cargo', ['build', '--release', '-p', 'freshell-server', '--locked'], {
      cwd: '/repo',
      env: {
        PATH: '/bin',
        NODE_ENV: 'production',
      },
      stdio: 'inherit',
    })
    expect(log).toHaveBeenNthCalledWith(1, '[e2e-setup] Building client and Rust server...')
    expect(log).toHaveBeenNthCalledWith(2, '[e2e-setup] Build complete.')
  })
})

// Every prerequisite must finish successfully before a browser can observe its
// output. Inject the subprocess outcome itself, not host permissions or timing.
describe.each([
  { stage: 'prebuild', index: 0 },
  { stage: 'client build', index: 1 },
  { stage: 'Rust server build', index: 2 },
])('Playwright build failure at $stage', ({ stage, index }) => {
  function fixture(failure: { status: number | null; signal?: NodeJS.Signals | null; error?: Error }) {
    const spawnSync = vi.fn().mockReturnValue({ status: 0, signal: null })
    for (let prior = 0; prior < index; prior++) {
      spawnSync.mockReturnValueOnce({ status: 0, signal: null })
    }
    spawnSync.mockReturnValueOnce(failure)
    const log = vi.fn()
    const run = () => ensureFreshE2eBuild('/repo', {
      spawnSync: spawnSync as unknown as typeof realSpawnSync,
      env: { PATH: '/bin' }, platform: 'linux', log: { log },
    })
    const stopped = () => {
      expect(spawnSync).toHaveBeenCalledTimes(index + 1)
      expect(log).not.toHaveBeenCalledWith('[e2e-setup] Build complete.')
    }
    return { run, stopped }
  }

  it('stops at a nonzero exit instead of accepting stale assets', () => {
    const { run, stopped } = fixture({ status: 2, signal: null })
    expect(run).toThrow(`${stage} failed (exit 2)`)
    stopped()
  })

  it.each(['ENOENT', 'ETIMEDOUT'])('preserves the original %s subprocess error', code => {
    const error = Object.assign(new Error(`${stage}: ${code}`), { code })
    const { run, stopped } = fixture({ status: null, signal: null, error })
    let observed: unknown
    try { run() } catch (caught) { observed = caught }
    expect(observed).toBe(error)
    stopped()
  })

  it.each(['SIGTERM', 'SIGKILL'] as const)('rejects an interrupted build (%s)', signal => {
    const { run, stopped } = fixture({ status: null, signal })
    expect(run).toThrow(`${stage} did not complete (signal ${signal})`)
    stopped()
  })

  it('rejects an unobserved exit rather than treating null as success', () => {
    const { run, stopped } = fixture({ status: null, signal: null })
    expect(run).toThrow(`${stage} did not complete (signal unknown)`)
    stopped()
  })
})
