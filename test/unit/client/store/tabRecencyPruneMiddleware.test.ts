import { describe, expect, it, vi } from 'vitest'

import { tabRecencyPruneMiddleware } from '@/store/tabRecencyPruneMiddleware'

describe('tabRecencyPruneMiddleware', () => {
  it('does not inspect pane topology for unrelated actions', () => {
    const action = { type: 'settings/updateSettingsLocal', payload: { theme: 'dark' } }
    const store = {
      getState: vi.fn(() => {
        throw new Error('unrelated actions should not inspect recency topology')
      }),
      dispatch: vi.fn(),
    }
    const next = vi.fn((received) => received)

    const result = tabRecencyPruneMiddleware(store as any)(next)(action)

    expect(result).toBe(action)
    expect(next).toHaveBeenCalledWith(action)
    expect(store.getState).not.toHaveBeenCalled()
    expect(store.dispatch).not.toHaveBeenCalled()
  })
})
