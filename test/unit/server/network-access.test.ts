import { describe, expect, it } from 'vitest'
import { isRemoteAccessEnabled } from '../../../server/network-access.js'

describe('isRemoteAccessEnabled', () => {
  it('returns true when the saved host explicitly enables remote access', () => {
    expect(isRemoteAccessEnabled({
      configured: true,
      host: '0.0.0.0',
    }, '127.0.0.1', 'windows')).toBe(true)
  })

  it('returns false for WSL localhost intent even when the effective bind host stays on all interfaces', () => {
    expect(isRemoteAccessEnabled({
      configured: true,
      host: '127.0.0.1',
    }, '0.0.0.0', 'wsl2')).toBe(false)
  })

  it('returns true for legacy unconfigured non-WSL installs that still bind to all interfaces', () => {
    expect(isRemoteAccessEnabled({
      configured: false,
      host: '127.0.0.1',
    }, '0.0.0.0', 'windows')).toBe(true)
  })

  it('returns false for configured localhost-only non-WSL installs', () => {
    expect(isRemoteAccessEnabled({
      configured: true,
      host: '127.0.0.1',
    }, '0.0.0.0', 'windows')).toBe(false)
  })
})
