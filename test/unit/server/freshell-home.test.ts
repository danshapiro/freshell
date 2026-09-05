// test/unit/server/freshell-home.test.ts
import os from 'os'
import path from 'path'
import { describe, it, expect } from 'vitest'
import { getFreshellHomeDir, getFreshellConfigDir } from '../../../server/freshell-home.js'

describe('getFreshellHomeDir', () => {
  it('honors FRESHELL_HOME', () => {
    expect(getFreshellHomeDir({ FRESHELL_HOME: '/tmp/fx-home' })).toBe(path.resolve('/tmp/fx-home'))
  })
  it('falls back to the OS homedir', () => {
    expect(getFreshellHomeDir({})).toBe(os.homedir())
  })
})

describe('getFreshellConfigDir', () => {
  it('defaults to ~/.freshell', () => {
    expect(getFreshellConfigDir({})).toBe(path.join(os.homedir(), '.freshell'))
  })
  it('joins FRESHELL_HOME with .freshell', () => {
    expect(getFreshellConfigDir({ FRESHELL_HOME: '/tmp/fx-home' }))
      .toBe(path.join(path.resolve('/tmp/fx-home'), '.freshell'))
  })
  it('honors FRESHELL_CONFIG_DIR verbatim over FRESHELL_HOME', () => {
    expect(getFreshellConfigDir({ FRESHELL_HOME: '/tmp/fx-home', FRESHELL_CONFIG_DIR: '/tmp/fx-work' }))
      .toBe('/tmp/fx-work')
  })
  it('resolves a relative FRESHELL_CONFIG_DIR to absolute', () => {
    expect(getFreshellConfigDir({ FRESHELL_CONFIG_DIR: 'relative/dir' }))
      .toBe(path.resolve('relative/dir'))
  })
  it('ignores a blank FRESHELL_CONFIG_DIR', () => {
    expect(getFreshellConfigDir({ FRESHELL_CONFIG_DIR: '   ' }))
      .toBe(path.join(os.homedir(), '.freshell'))
  })
})
