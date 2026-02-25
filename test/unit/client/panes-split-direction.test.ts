import { it, expect } from 'vitest'
import panesReducer, { splitPane, initLayout } from '../../../src/store/panesSlice'

it('creates horizontal split when requested', () => {
  const state = panesReducer(undefined as any, initLayout({ tabId: 't1', content: { kind: 'terminal' } as any }))
  const next = panesReducer(state, splitPane({ tabId: 't1', paneId: state.activePane['t1'], direction: 'horizontal', newContent: { kind: 'terminal' } as any }))
  expect(next.layouts['t1'].type).toBe('split')
  expect((next.layouts['t1'] as any).direction).toBe('horizontal')
})
