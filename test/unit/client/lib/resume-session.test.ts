import { beforeEach, describe, expect, it, vi } from 'vitest'

const findPaneForSession = vi.fn()
vi.mock('@/lib/session-utils', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  findPaneForSession: (...args: unknown[]) => findPaneForSession(...args),
}))

const openSessionTabAction = { type: 'test/openSessionTab' }
const openSessionTab = vi.fn(() => openSessionTabAction)
vi.mock('@/store/tabsSlice', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openSessionTab: (...args: unknown[]) => openSessionTab(...args),
}))

import { setActiveTab } from '@/store/tabsSlice'
import { setActivePane } from '@/store/panesSlice'
import { resumeSessionInTab } from '@/lib/resume-session'
import type { RootState } from '@/store/store'

const state = { connection: { serverInstanceId: 'srv-1' } } as unknown as RootState

describe('resumeSessionInTab', () => {
  const dispatch = vi.fn()
  const onNavigate = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('focuses the existing pane instead of opening a duplicate', () => {
    findPaneForSession.mockReturnValue({ tabId: 'tab-1', paneId: 'pane-1' })
    const result = resumeSessionInTab(
      state,
      dispatch,
      { provider: 'codex', sessionId: 'abc', sessionType: 'codex' },
      onNavigate,
    )
    expect(result).toEqual({ deduped: true })
    expect(findPaneForSession).toHaveBeenCalledWith(
      state,
      { provider: 'codex', sessionId: 'abc' },
      'srv-1',
    )
    expect(dispatch).toHaveBeenCalledWith(setActiveTab('tab-1'))
    expect(dispatch).toHaveBeenCalledWith(setActivePane({ tabId: 'tab-1', paneId: 'pane-1' }))
    expect(openSessionTab).not.toHaveBeenCalled()
    expect(onNavigate).toHaveBeenCalledWith('terminal')
  })

  it('opens a new tab with the full tuple when no pane holds the session', () => {
    findPaneForSession.mockReturnValue(undefined)
    const result = resumeSessionInTab(
      state,
      dispatch,
      { provider: 'opencode', sessionId: 'ses_x00000000000000000000000000', cwd: '/repo/beta' },
      onNavigate,
    )
    expect(result).toEqual({ deduped: false })
    expect(openSessionTab).toHaveBeenCalledWith({
      sessionId: 'ses_x00000000000000000000000000',
      provider: 'opencode',
      sessionType: 'opencode', // defaults to provider when unset
      cwd: '/repo/beta',
      title: undefined,
      firstUserMessage: undefined,
    })
    expect(dispatch).toHaveBeenCalledWith(openSessionTabAction)
    expect(onNavigate).toHaveBeenCalledWith('terminal')
  })

  it('preserves an explicitly carried checkpoint workspace when opening a resumed tab', () => {
    findPaneForSession.mockReturnValue(undefined)
    const checkpointWorkspace = { path: '/projects/selected', provenance: 'directory-picker' as const }
    const target = {
      provider: 'codex',
      sessionId: 'thread-123',
      cwd: '/home/user',
      checkpointWorkspace,
    }

    resumeSessionInTab(state, dispatch, target, onNavigate)

    expect(openSessionTab).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'thread-123',
      cwd: '/home/user',
      checkpointWorkspace,
    }))
  })
})
