import { describe, expect, it } from 'vitest'
import {
  selectAttentionTabIds,
  selectTabAttentionStyle,
  selectTabNeedsAttention,
} from '@/store/selectors/tabAttentionSelectors'
import type { RootState } from '@/store/store'
import type { TabAttentionStyle } from '@/store/types'

function makeState({
  tabIds = ['tab-1', 'tab-2', 'tab-3', 'tab-4'],
  attentionByTab = {},
  watchedCompletionByTab = {},
  style = 'highlight',
}: {
  tabIds?: string[]
  attentionByTab?: Record<string, boolean>
  watchedCompletionByTab?: Record<string, boolean>
  style?: TabAttentionStyle
} = {}): RootState {
  return {
    tabs: { tabs: tabIds.map((id) => ({ id })), activeTabId: tabIds[0] },
    turnCompletion: { attentionByTab, attentionByPane: {}, watchedCompletionByTab },
    settings: { settings: { panes: { tabAttentionStyle: style } } },
  } as unknown as RootState
}

describe('tabAttentionSelectors', () => {
  it('lists attention tabs in tab-strip order, not mark order', () => {
    const state = makeState({ attentionByTab: { 'tab-4': true, 'tab-2': true } })
    expect(selectAttentionTabIds(state)).toEqual(['tab-2', 'tab-4'])
  })

  it('is the union of unwitnessed attention and watched completion marks', () => {
    const state = makeState({
      attentionByTab: { 'tab-3': true },
      watchedCompletionByTab: { 'tab-1': true },
    })
    expect(selectAttentionTabIds(state)).toEqual(['tab-1', 'tab-3'])
    expect(selectTabNeedsAttention(state, 'tab-1')).toBe(true)
    expect(selectTabNeedsAttention(state, 'tab-3')).toBe(true)
    expect(selectTabNeedsAttention(state, 'tab-2')).toBe(false)
  })

  it('ignores marks for tabs that no longer exist', () => {
    const state = makeState({ attentionByTab: { 'tab-gone': true, 'tab-2': true } })
    expect(selectAttentionTabIds(state)).toEqual(['tab-2'])
  })

  it('hides every mark when the attention style is none', () => {
    const state = makeState({
      style: 'none',
      attentionByTab: { 'tab-2': true },
      watchedCompletionByTab: { 'tab-1': true },
    })
    expect(selectTabAttentionStyle(state)).toBe('none')
    expect(selectAttentionTabIds(state)).toEqual([])
    expect(selectTabNeedsAttention(state, 'tab-2')).toBe(false)
  })

  it('defaults the style to highlight when settings carry none', () => {
    const state = {
      ...makeState({ attentionByTab: { 'tab-2': true } }),
      settings: { settings: { panes: {} } },
    } as unknown as RootState
    expect(selectTabAttentionStyle(state)).toBe('highlight')
    expect(selectAttentionTabIds(state)).toEqual(['tab-2'])
  })

  it('returns the same array reference while its inputs are unchanged', () => {
    const state = makeState({ attentionByTab: { 'tab-2': true } })
    const first = selectAttentionTabIds(state)
    expect(selectAttentionTabIds({ ...state } as RootState)).toBe(first)
  })
})
