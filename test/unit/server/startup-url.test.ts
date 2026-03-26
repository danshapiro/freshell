import { describe, it, expect } from 'vitest'
import { resolveVisitPort } from '../../../server/startup-url'

describe('resolveVisitPort', () => {
  it('returns server port when not in dev mode', () => {
    expect(resolveVisitPort(3001, false, {})).toBe(3001)
  })

  it('returns default Vite port (5173) in dev mode', () => {
    expect(resolveVisitPort(3001, true, {})).toBe(5173)
  })

  it('respects VITE_PORT env var in dev mode', () => {
    expect(resolveVisitPort(3001, true, { VITE_PORT: '8080' })).toBe(8080)
  })

  it('ignores VITE_PORT when not in dev mode', () => {
    expect(resolveVisitPort(3001, false, { VITE_PORT: '8080' })).toBe(3001)
  })
})
