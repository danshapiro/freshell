import { describe, it, expect } from 'vitest'
import { getShareAction } from '@/lib/share-utils'

describe('getShareAction', () => {
  it('returns wizard step 1 when network not configured', () => {
    const action = getShareAction({ configured: false, host: '127.0.0.1' })
    expect(action).toEqual({ type: 'wizard', initialStep: 1 })
  })

  it('returns loading when status is null (fetch in progress)', () => {
    // When network status hasn't loaded yet, the Share button should show a
    // loading state instead of incorrectly routing to the wizard. This prevents
    // a race where clicking Share before fetch completes would force the setup
    // wizard for already-configured users.
    const action = getShareAction(null)
    expect(action).toEqual({ type: 'loading' })
  })

  it('returns wizard step 2 when configured but localhost-only', () => {
    const action = getShareAction({ configured: true, host: '127.0.0.1' })
    expect(action).toEqual({ type: 'wizard', initialStep: 2 })
  })

  it('returns panel when configured with remote access', () => {
    const action = getShareAction({ configured: true, host: '0.0.0.0' })
    expect(action).toEqual({ type: 'panel' })
  })

  it('returns panel for legacy HOST env override (configured=false, host=0.0.0.0)', () => {
    // Legacy deployments that set HOST=0.0.0.0 have configured=false but
    // remote access is active. They should see the share panel, not the wizard.
    const action = getShareAction({ configured: false, host: '0.0.0.0' })
    expect(action).toEqual({ type: 'panel' })
  })
})
