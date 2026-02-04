import { describe, it, expect } from 'vitest'
import { resolveConfig } from '../../../server/cli/config'

describe('resolveConfig', () => {
  it('prefers env vars', () => {
    const prevUrl = process.env.FRESHELL_URL
    const prevToken = process.env.FRESHELL_TOKEN

    process.env.FRESHELL_URL = 'http://localhost:3001'
    process.env.FRESHELL_TOKEN = 'token123'

    const cfg = resolveConfig()
    expect(cfg.url).toBe('http://localhost:3001')
    expect(cfg.token).toBe('token123')

    if (prevUrl === undefined) {
      delete process.env.FRESHELL_URL
    } else {
      process.env.FRESHELL_URL = prevUrl
    }
    if (prevToken === undefined) {
      delete process.env.FRESHELL_TOKEN
    } else {
      process.env.FRESHELL_TOKEN = prevToken
    }
  })
})
