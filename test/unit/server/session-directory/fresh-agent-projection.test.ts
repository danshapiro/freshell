import { describe, expect, it } from 'vitest'

import { buildSessionDirectoryComparableSnapshot } from '../../../../server/session-directory/projection.js'

describe('fresh-agent session-directory projection', () => {
  it('projects fresh sessionType and codex runtime metadata through the indexed session directory snapshot', () => {
    const snapshot = buildSessionDirectoryComparableSnapshot([
      {
        projectPath: '/repo',
        sessions: [{
          provider: 'codex',
          sessionId: 'sess-1',
          projectPath: '/repo',
          checkoutPath: '/repo/.worktrees/task-1',
          lastActivityAt: 10,
          title: 'Codex task',
          summary: 'Summary',
          sessionType: 'freshcodex',
          isSubagent: true,
          codexTaskEvents: {
            latestTaskStartedAt: 1,
          },
        }],
      },
    ])

    expect(snapshot[0]).toMatchObject({
      provider: 'codex',
      sessionId: 'sess-1',
      checkoutPath: '/repo/.worktrees/task-1',
      sessionType: 'freshcodex',
      isSubagent: true,
    })
  })
})
