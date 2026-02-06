import { describe, it, expect } from 'vitest'
import { resolveVisitPort } from '../../../server/startup-url'

describe('resolveVisitPort', () => {
  it('returns server port in production', () => {
    const env = { NODE_ENV: 'production' } as NodeJS.ProcessEnv
    expect(resolveVisitPort(3001, env)).toBe(3001)
  })

  it('returns default Vite port (5173) in development', () => {
    const env = { NODE_ENV: 'development' } as NodeJS.ProcessEnv
    expect(resolveVisitPort(3001, env)).toBe(5173)
  })

  it('respects VITE_PORT env var in development', () => {
    const env = { NODE_ENV: 'development', VITE_PORT: '8080' } as NodeJS.ProcessEnv
    expect(resolveVisitPort(3001, env)).toBe(8080)
  })

  it('returns server port when NODE_ENV is unset', () => {
    const env = {} as NodeJS.ProcessEnv
    expect(resolveVisitPort(3001, env)).toBe(3001)
  })

  it('returns server port in test mode', () => {
    const env = { NODE_ENV: 'test' } as NodeJS.ProcessEnv
    expect(resolveVisitPort(4000, env)).toBe(4000)
  })
})
