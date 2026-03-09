// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { buildServerProcessEnv } from './logger.separation.harness.js'

describe('logger separation harness env', () => {
  it('defaults child server launches to disable WSL port-forward startup', () => {
    const childEnv = buildServerProcessEnv({}, {})

    expect(childEnv.FRESHELL_DISABLE_WSL_PORT_FORWARD).toBe('1')
  })

  it('preserves an explicit startup opt-in override', () => {
    const childEnv = buildServerProcessEnv({
      FRESHELL_DISABLE_WSL_PORT_FORWARD: '0',
    }, {})

    expect(childEnv.FRESHELL_DISABLE_WSL_PORT_FORWARD).toBe('0')
  })
})
