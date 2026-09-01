import { describe, it, expect } from 'vitest'
import { detectFeatureFlags } from '../../../server/platform-router.js'

describe('detectFeatureFlags hostStatsAvailable', () => {
  it('matches process.platform !== "win32" on the current platform', () => {
    expect(detectFeatureFlags().hostStatsAvailable).toBe(process.platform !== 'win32')
  })

  it('is false on a stubbed win32 platform', () => {
    expect(detectFeatureFlags('win32').hostStatsAvailable).toBe(false)
  })

  it('is true on a stubbed linux platform', () => {
    expect(detectFeatureFlags('linux').hostStatsAvailable).toBe(true)
  })
})
