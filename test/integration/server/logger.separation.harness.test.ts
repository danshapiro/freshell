// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { buildServerProcessEnv } from './logger.separation.harness.js'

describe('logger separation harness env', () => {
  it('does not inject a startup-only WSL port-forward suppression env var', () => {
    const childEnv = buildServerProcessEnv({}, {})

    expect(childEnv.FRESHELL_DISABLE_WSL_PORT_FORWARD).toBeUndefined()
  })
})
