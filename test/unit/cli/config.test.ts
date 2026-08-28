import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, it, expect } from 'vitest'
import { resolveClientConfig as resolveConfig } from '../../../tools/node-client-runtime/config'

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

  it('reads cli.json from <FRESHELL_HOME>/.freshell', () => {
    const previous = {
      home: process.env.FRESHELL_HOME,
      url: process.env.FRESHELL_URL,
      token: process.env.FRESHELL_TOKEN,
    }
    const home = mkdtempSync(path.join(os.tmpdir(), 'freshell-cli-config-'))

    try {
      mkdirSync(path.join(home, '.freshell'), { recursive: true })
      writeFileSync(path.join(home, '.freshell', 'cli.json'), JSON.stringify({
        url: 'http://file-config.example',
        token: 'file-token',
      }))
      process.env.FRESHELL_HOME = home
      delete process.env.FRESHELL_URL
      delete process.env.FRESHELL_TOKEN

      expect(resolveConfig()).toEqual({
        url: 'http://file-config.example',
        token: 'file-token',
      })
    } finally {
      if (previous.home === undefined) delete process.env.FRESHELL_HOME
      else process.env.FRESHELL_HOME = previous.home
      if (previous.url === undefined) delete process.env.FRESHELL_URL
      else process.env.FRESHELL_URL = previous.url
      if (previous.token === undefined) delete process.env.FRESHELL_TOKEN
      else process.env.FRESHELL_TOKEN = previous.token
      rmSync(home, { recursive: true, force: true })
    }
  })
})
