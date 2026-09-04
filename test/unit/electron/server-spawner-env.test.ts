import { describe, it, expect } from 'vitest'
import { buildSpawnEnv } from '../../../electron/server-spawner.js'

const CONFIG_DIR = '/home/user/.freshell-work'

describe('buildSpawnEnv', () => {
  it('inherits the base environment', () => {
    const env = buildSpawnEnv({ PATH: '/bin', CUSTOM: 'x' }, 3001, CONFIG_DIR)
    expect(env.PATH).toBe('/bin')
    expect(env.CUSTOM).toBe('x')
  })

  it('pins PORT to the spawn port', () => {
    expect(buildSpawnEnv({ PORT: '9999' }, 3001, CONFIG_DIR).PORT).toBe('3001')
  })

  it('pins FRESHELL_CONFIG_DIR to the profile config dir, overriding any inherited value', () => {
    expect(buildSpawnEnv({ FRESHELL_CONFIG_DIR: '/elsewhere' }, 3001, CONFIG_DIR).FRESHELL_CONFIG_DIR)
      .toBe(CONFIG_DIR)
  })
})
