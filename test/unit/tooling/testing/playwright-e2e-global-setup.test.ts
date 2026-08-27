import { describe, expect, it, vi } from 'vitest'

import { ensureFreshE2eBuild } from '../../../e2e-browser/global-setup.js'

describe('Playwright e2e global setup', () => {
  it('rebuilds the current client and Rust server assets instead of accepting an existing dist build', () => {
    const execSync = vi.fn()
    const log = vi.fn()

    ensureFreshE2eBuild('/repo', {
      execSync,
      env: { PATH: '/bin' },
      log: { log },
    })

    expect(execSync).toHaveBeenCalledWith('npm run build:client && cargo build --release -p freshell-server --locked', {
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
