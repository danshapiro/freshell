import { describe, expect, it } from 'vitest'
import {
  checkpointLabelForText,
  pickCheckpointForTurn,
  type CheckpointEntry,
} from '@/lib/fresh-agent-checkpoints'
import type { FreshAgentTurn } from '@shared/fresh-agent-contract'

function userTurn(id: string, text: string, turnId = id): FreshAgentTurn {
  return {
    id,
    turnId,
    role: 'user',
    summary: text,
    items: [{ id: `${id}-item`, kind: 'text', text }],
  } as FreshAgentTurn
}

function assistantTurn(id: string): FreshAgentTurn {
  return {
    id,
    turnId: id,
    role: 'assistant',
    summary: 'reply',
    items: [{ id: `${id}-item`, kind: 'text', text: 'done' }],
  } as FreshAgentTurn
}

// Newest-first, matching git log order.
const CHECKPOINTS: CheckpointEntry[] = [
  { id: 'sha-3', ts: 300, label: 'fix the bug' },
  { id: 'sha-2', ts: 200, label: 'add a test' },
  { id: 'sha-1', ts: 100, label: 'fix the bug' },
]

describe('checkpointLabelForText', () => {
  it('flattens whitespace and truncates', () => {
    expect(checkpointLabelForText('  fix\n\nthe   bug  ')).toBe('fix the bug')
    expect(checkpointLabelForText('x'.repeat(300))).toHaveLength(120)
    expect(checkpointLabelForText('   ')).toBe('checkpoint')
  })
})

describe('pickCheckpointForTurn', () => {
  it('matches persisted display turn id only for normalized user turns', () => {
    const user = userTurn('native-turn-1-user', 'same native', 'display-user-1')
    const assistant = {
      ...assistantTurn('native-turn-1-assistant'),
      turnId: 'display-assistant-1',
      id: 'native-turn-1-assistant',
      summary: 'same native',
      items: [{ id: 'assistant-item', kind: 'text' as const, text: 'same native' }],
    } as FreshAgentTurn
    const checkpoints: CheckpointEntry[] = [
      { id: 'sha-user', ts: 1, label: 'same native', turnId: 'display-user-1' },
    ]

    expect(pickCheckpointForTurn(checkpoints, [user, assistant], user)?.id).toBe('sha-user')
    expect(pickCheckpointForTurn(checkpoints, [user, assistant], assistant)).toBeNull()
  })

  it('prefers display turn id and request id before duplicate label ordinal matching', () => {
    const older = userTurn('old-native', 'fix the bug', 'display-old')
    const newer = userTurn('new-native', 'fix the bug', 'display-new') as FreshAgentTurn & { requestId: string }
    newer.requestId = 'send-new'
    const turns = [newer, assistantTurn('reply'), older]
    const checkpoints: CheckpointEntry[] = [
      { id: 'sha-old', ts: 100, label: 'fix the bug', turnId: 'display-old', requestId: 'send-old' },
      { id: 'sha-new', ts: 200, label: 'fix the bug', requestId: 'send-new' },
    ]

    expect(pickCheckpointForTurn(checkpoints, turns, newer)?.id).toBe('sha-new')
    expect(pickCheckpointForTurn(checkpoints, turns, older)?.id).toBe('sha-old')
  })

  it('does not let a checkpoint for an older duplicate prompt satisfy a newer display turn by label', () => {
    const newer = userTurn('new-native', 'fix the bug', 'display-new')
    const older = userTurn('old-native', 'fix the bug', 'display-old')
    const checkpoints: CheckpointEntry[] = [
      { id: 'sha-old', ts: 100, label: 'fix the bug', turnId: 'display-old', requestId: 'send-old' },
    ]

    expect(pickCheckpointForTurn(checkpoints, [newer, older], newer)).toBeNull()
  })

  it('does not count direct-id checkpoints when indexing legacy label-only matches', () => {
    const older = userTurn('old-native', 'fix the bug', 'display-old')
    const newer = userTurn('new-native', 'fix the bug', 'display-new')
    const checkpoints: CheckpointEntry[] = [
      { id: 'sha-new', ts: 200, label: 'fix the bug' },
      { id: 'sha-old', ts: 100, label: 'fix the bug', turnId: 'display-old' },
    ]

    expect(pickCheckpointForTurn(checkpoints, [older, newer], newer)?.id).toBe('sha-new')
  })

  it('uses label ordinal matching when saved submitted display ids no longer resolve after restart', () => {
    const older = userTurn('old-native', 'fix the bug', 'display-old-after-restart')
    const newer = userTurn('new-native', 'fix the bug', 'display-new-after-restart')
    const checkpoints: CheckpointEntry[] = [
      {
        id: 'sha-new',
        ts: 200,
        label: 'fix the bug',
        turnId: 'submitted-new-before-restart',
        requestId: 'send-new',
      },
      {
        id: 'sha-old',
        ts: 100,
        label: 'fix the bug',
        turnId: 'submitted-old-before-restart',
        requestId: 'send-old',
      },
    ]

    expect(pickCheckpointForTurn(checkpoints, [older, newer], older)?.id).toBe('sha-old')
    expect(pickCheckpointForTurn(checkpoints, [older, newer], newer)?.id).toBe('sha-new')
  })

  it('matches a user turn to its checkpoint by label', () => {
    const turns = [userTurn('t1', 'add a test'), assistantTurn('t2')]
    expect(pickCheckpointForTurn(CHECKPOINTS, turns, turns[0])?.id).toBe('sha-2')
  })

  it('disambiguates duplicate labels by ordinal, oldest first', () => {
    const turns = [
      userTurn('t1', 'fix the bug'),
      assistantTurn('t2'),
      userTurn('t3', 'fix the bug'),
    ]
    expect(pickCheckpointForTurn(CHECKPOINTS, turns, turns[0])?.id).toBe('sha-1')
    expect(pickCheckpointForTurn(CHECKPOINTS, turns, turns[2])?.id).toBe('sha-3')
  })

  it('returns null for assistant turns and unmatched labels', () => {
    const turns = [userTurn('t1', 'never sent before'), assistantTurn('t2')]
    expect(pickCheckpointForTurn(CHECKPOINTS, turns, turns[1])).toBeNull()
    expect(pickCheckpointForTurn(CHECKPOINTS, turns, turns[0])).toBeNull()
  })

  it('matches labels after attachment suffixes the same way send does', () => {
    const outgoing = 'look at this\n\nAttached files (read them from disk):\n- /tmp/x.png'
    const label = checkpointLabelForText(outgoing)
    const turns = [userTurn('t1', outgoing)]
    const checkpoints: CheckpointEntry[] = [{ id: 'sha-a', ts: 1, label }]
    expect(pickCheckpointForTurn(checkpoints, turns, turns[0])?.id).toBe('sha-a')
  })
})
