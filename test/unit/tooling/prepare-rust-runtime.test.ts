// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { prepareRustRuntime } from '../../../scripts/prepare-rust-runtime.js'

describe('prepareRustRuntime', () => {
  it('runs authentication bootstrap and the locked Claude sidecar install together', () => {
    const ensureAuthTokenFile = vi.fn().mockReturnValue({ created: true, source: 'generated' })
    const ensureClaudeSidecarDependencies = vi.fn().mockReturnValue({
      severity: 'info',
      event: 'claude_sidecar_dependencies_ready',
      sidecarDir: '/tmp/sidecar',
      packageName: '@anthropic-ai/claude-agent-sdk',
      packageVersion: '0.3.237',
      installCommand: ['npm', 'ci'],
    })
    const env: NodeJS.ProcessEnv = {}

    const result = prepareRustRuntime({
      env,
      envPath: '/tmp/freshell/.env',
      sidecarDir: '/tmp/freshell-sidecar',
      ensureAuthTokenFile,
      ensureClaudeSidecarDependencies,
    })

    expect(ensureAuthTokenFile).toHaveBeenCalledWith({
      env,
      envPath: '/tmp/freshell/.env',
    })
    expect(ensureClaudeSidecarDependencies).toHaveBeenCalledWith({
      env,
      sidecarDir: '/tmp/freshell-sidecar',
    })
    expect(result).toEqual({
      authToken: { created: true, source: 'generated' },
      claudeSidecar: expect.objectContaining({ event: 'claude_sidecar_dependencies_ready' }),
    })
  })
})
