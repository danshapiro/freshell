import { describe, expect, it } from 'vitest'

import {
  shouldSetupWslPortForwardingAtStartup,
  wslPortForwardStartupDisabled,
} from '../../../server/wsl-port-forward-startup.js'

describe('wsl-port-forward startup gating', () => {
  it('allows startup setup when bound to all interfaces and not disabled', () => {
    expect(shouldSetupWslPortForwardingAtStartup('0.0.0.0', {})).toBe(true)
  })

  it('skips startup setup when bound to loopback', () => {
    expect(shouldSetupWslPortForwardingAtStartup('127.0.0.1', {})).toBe(false)
  })

  it('skips startup setup when the disable env flag is set to 1', () => {
    expect(shouldSetupWslPortForwardingAtStartup('0.0.0.0', {
      FRESHELL_DISABLE_WSL_PORT_FORWARD: '1',
    })).toBe(false)
  })

  it('treats true-like values as disabled', () => {
    expect(wslPortForwardStartupDisabled({
      FRESHELL_DISABLE_WSL_PORT_FORWARD: 'true',
    })).toBe(true)
  })

  it('treats absent or false-like values as enabled', () => {
    expect(wslPortForwardStartupDisabled({})).toBe(false)
    expect(wslPortForwardStartupDisabled({
      FRESHELL_DISABLE_WSL_PORT_FORWARD: '0',
    })).toBe(false)
  })
})
