import { describe, it, expect } from 'vitest'
import { resolveBindHost } from '../../../server/startup-url'

describe('resolveBindHost', () => {
  it('defaults to 127.0.0.1 with no args or env', () => {
    expect(resolveBindHost([], {})).toBe('127.0.0.1')
  })

  it('reads HOST env var', () => {
    expect(resolveBindHost([], { HOST: '0.0.0.0' })).toBe('0.0.0.0')
  })

  it('reads custom HOST env var', () => {
    expect(resolveBindHost([], { HOST: '192.168.1.10' })).toBe('192.168.1.10')
  })

  it('--host flag overrides env var', () => {
    expect(resolveBindHost(['node', 'index.js', '--host', '10.0.0.1'], { HOST: '192.168.1.10' })).toBe('10.0.0.1')
  })

  it('--lan maps to 0.0.0.0', () => {
    expect(resolveBindHost(['node', 'index.js', '--lan'], {})).toBe('0.0.0.0')
  })

  it('--lan overrides HOST env var', () => {
    expect(resolveBindHost(['node', 'index.js', '--lan'], { HOST: '192.168.1.10' })).toBe('0.0.0.0')
  })

  it('--host without value falls back to env', () => {
    // --host is the last arg with no value after it
    expect(resolveBindHost(['node', 'index.js', '--host'], { HOST: '10.0.0.5' })).toBe('10.0.0.5')
  })

  it('--host without value or env falls back to default', () => {
    expect(resolveBindHost(['node', 'index.js', '--host'], {})).toBe('127.0.0.1')
  })
})
