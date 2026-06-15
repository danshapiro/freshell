import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'

import { migrateLegacyFreshAgentContent } from '@shared/fresh-agent'
import { validatePaneTree } from '@/store/paneTreeValidation'

describe('fresh-agent pane migration', () => {
  it('keeps legacy agent-chat pane types out of live pane store boundaries', () => {
    const result = spawnSync('rg', [
      '-n',
      'AgentChatPaneContent|AgentChatPaneInput',
      'src/store/paneTypes.ts',
      'src/lib/pane-activity.ts',
      'src/store/persistControl.ts',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
  })

  it('converts legacy agent-chat pane content to fresh-agent before render', () => {
    const migrated = migrateLegacyFreshAgentContent({
      kind: 'agent-chat',
      provider: 'freshclaude',
      sessionId: 'live-1',
      createRequestId: 'req-1',
      status: 'idle',
      resumeSessionId: '00000000-0000-4000-8000-000000000001',
      initialCwd: '/work',
      permissionMode: 'acceptEdits',
      effort: 'high',
      plugins: ['/tmp/plugin'],
    })

    expect(migrated).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      sessionId: 'live-1',
      createRequestId: 'req-1',
      status: 'idle',
      resumeSessionId: '00000000-0000-4000-8000-000000000001',
      initialCwd: '/work',
      permissionMode: 'acceptEdits',
      effort: 'high',
      plugins: ['/tmp/plugin'],
    })
  })

  it('rejects agent-chat as a live pane tree kind after migration boundaries', () => {
    const tree = {
      type: 'leaf',
      id: 'pane-1',
      content: {
        kind: 'agent-chat',
        provider: 'freshclaude',
        createRequestId: 'req-1',
        status: 'idle',
      },
    }
    expect(validatePaneTree(tree as never).valid).toBe(false)
  })

  it('migrates old claude-provider agent-chat records to freshclaude when the durable id is canonical', () => {
    const migrated = migrateLegacyFreshAgentContent({
      kind: 'agent-chat',
      provider: 'claude',
      createRequestId: 'req-old',
      status: 'idle',
      resumeSessionId: '00000000-0000-4000-8000-000000000123',
    })
    expect(migrated).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      sessionRef: { provider: 'claude', sessionId: '00000000-0000-4000-8000-000000000123' },
    })
  })

  it('converts incomplete legacy agent-chat records into fresh-agent restore errors', () => {
    const migrated = migrateLegacyFreshAgentContent({
      kind: 'agent-chat',
      provider: 'claude',
      createRequestId: 'req-bad',
      status: 'idle',
      resumeSessionId: 'named-alias',
    })
    expect(migrated).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'invalid_legacy_restore_target' },
    })
  })

  it('rejects non-canonical Claude sessionRef aliases in legacy agent-chat records', () => {
    const migrated = migrateLegacyFreshAgentContent({
      kind: 'agent-chat',
      provider: 'claude',
      createRequestId: 'req-alias',
      status: 'idle',
      sessionRef: { provider: 'claude', sessionId: 'named-alias' },
    })
    expect(migrated).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'invalid_legacy_restore_target' },
    })
    expect((migrated as { sessionRef?: unknown }).sessionRef).toBeUndefined()
  })

  it('keeps a bad Claude sessionRef alias as a restore error even when resumeSessionId is canonical', () => {
    const canonical = '00000000-0000-4000-8000-000000000777'
    const migrated = migrateLegacyFreshAgentContent({
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-alias-with-resume',
      status: 'idle',
      sessionRef: { provider: 'claude', sessionId: 'named-alias' },
      resumeSessionId: canonical,
    })

    expect(migrated).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'invalid_legacy_restore_target' },
    })
    expect((migrated as { sessionRef?: unknown }).sessionRef).toBeUndefined()
    expect((migrated as { resumeSessionId?: unknown }).resumeSessionId).toBeUndefined()
  })

  it('preserves legacy display overrides', () => {
    const migrated = migrateLegacyFreshAgentContent({
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-display',
      status: 'idle',
      showThinking: false,
      showTools: true,
      showTimecodes: true,
      resumeSessionId: '00000000-0000-4000-8000-000000000456',
    })
    expect(migrated).toMatchObject({
      kind: 'fresh-agent',
      showThinking: false,
      showTools: true,
      showTimecodes: true,
    })
  })
})
