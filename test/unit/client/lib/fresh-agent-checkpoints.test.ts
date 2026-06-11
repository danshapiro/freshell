import { describe, expect, it } from 'vitest'
import {
  checkpointLabelForText,
  pickCheckpointForTurn,
  type CheckpointEntry,
} from '@/lib/fresh-agent-checkpoints'
import type { FreshAgentTurn } from '@shared/fresh-agent-contract'

function userTurn(id: string, text: string): FreshAgentTurn {
  return {
    id,
    turnId: id,
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
