// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { AUDIT_PROFILES } from '@test/e2e-browser/perf/profiles'

describe('visible-first audit profiles', () => {
  it('defines exactly the accepted profiles', () => {
    expect(AUDIT_PROFILES.map((profile) => profile.id)).toEqual([
      'desktop_local',
      'mobile_restricted',
    ])
  })
})
