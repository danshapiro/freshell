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
      sessionId: 'freshopencode-req-1',
      createRequestId: 'req-1',
      status: 'connected',
      sessionRef: { provider: 'opencode', sessionId: 'freshopencode-req-1' },
      initialCwd: '/repo',
      model: 'umans-ai-coding-plan/umans-kimi-k2.7',
      effort: 'high',
    }
    store.attachPaneContent(tabId, paneId, content)
    const snap = store.getPaneSnapshot(paneId)
    expect(snap?.kind).toBe('fresh-agent')
    expect(snap?.paneContent).toMatchObject({
      kind: 'fresh-agent', sessionType: 'freshopencode', provider: 'opencode',
      sessionId: 'freshopencode-req-1', createRequestId: 'req-1',
      sessionRef: { provider: 'opencode', sessionId: 'freshopencode-req-1' },
    })
  })
})
