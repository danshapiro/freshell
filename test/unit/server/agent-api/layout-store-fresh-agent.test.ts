import { describe, expect, it } from 'vitest'
import { LayoutStore } from '../../../../server/agent-api/layout-store.js'

describe('LayoutStore fresh-agent content', () => {
  it('round-trips a fresh-agent pane content through attach + getPaneSnapshot', () => {
    const store = new LayoutStore()
    const { tabId, paneId } = store.createTab({ title: 'OpenCode' })
    const content = {
      kind: 'fresh-agent',
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionId: 'ses_opencode_1',
      createRequestId: 'req-1',
      status: 'connected',
      sessionRef: { provider: 'opencode', sessionId: 'ses_opencode_1' },
      initialCwd: '/repo',
      model: 'umans-ai-coding-plan/umans-kimi-k2.7',
      effort: 'high',
    }
    store.attachPaneContent(tabId, paneId, content)
    const snap = store.getPaneSnapshot(paneId)
    expect(snap?.kind).toBe('fresh-agent')
    expect(snap?.paneContent).toMatchObject({
      kind: 'fresh-agent', sessionType: 'freshopencode', provider: 'opencode',
      sessionId: 'ses_opencode_1', createRequestId: 'req-1',
      sessionRef: { provider: 'opencode', sessionId: 'ses_opencode_1' },
    })
  })

  it('normalizes legacy freshopencode placeholders when a UI layout snapshot is stored', () => {
    const store = new LayoutStore()
    store.updateFromUi({
      tabs: [{ id: 'tab-1', title: 'OpenCode' }],
      activeTabId: 'tab-1',
      activePane: { 'tab-1': 'pane-1' },
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'fresh-agent',
            sessionType: 'freshopencode',
            provider: 'opencode',
            sessionId: 'freshopencode-req-legacy',
            resumeSessionId: 'freshopencode-req-legacy',
            sessionRef: { provider: 'opencode', sessionId: 'freshopencode-req-legacy' },
            status: 'connected',
          },
        },
      },
    }, 'conn-1')

    const snap = store.getPaneSnapshot('pane-1')
    expect(snap?.paneContent).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshopencode',
      provider: 'opencode',
      status: 'idle',
      restoreError: {
        code: 'RESTORE_UNAVAILABLE',
        reason: 'invalid_legacy_restore_target',
      },
    })
    expect(snap?.paneContent?.sessionRef).toBeUndefined()
    expect(snap?.paneContent?.resumeSessionId).toBeUndefined()
  })
})
