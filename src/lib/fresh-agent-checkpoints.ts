import type { FreshAgentTurn } from '@shared/fresh-agent-contract'

export type CheckpointEntry = { id: string; ts: number; label: string }

export const CHECKPOINT_LABEL_LIMIT = 120

export function checkpointLabelForText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return (flat || 'checkpoint').slice(0, CHECKPOINT_LABEL_LIMIT)
}

function turnLabel(turn: FreshAgentTurn): string {
  const text = turn.items
    .filter((item): item is Extract<FreshAgentTurn['items'][number], { kind: 'text' }> => item.kind === 'text')
    .map((item) => item.text)
    .join('\n\n')
  return checkpointLabelForText(text || turn.summary || '')
}

/**
 * Match a user turn to its checkpoint. Checkpoints are created at send time
 * with the outgoing text as label, so the k-th user turn bearing a given label
 * corresponds to the k-th oldest checkpoint with that label. Returns null when
 * no checkpoint matches (e.g. turns sent before this feature existed).
 */
export function pickCheckpointForTurn(
  checkpoints: readonly CheckpointEntry[],
  turns: readonly FreshAgentTurn[],
  target: FreshAgentTurn,
): CheckpointEntry | null {
  if (target.role !== 'user') return null
  const label = turnLabel(target)
  if (!label) return null

  let ordinal = 0
  for (const turn of turns) {
    if (turn.role !== 'user') continue
    if (turnLabel(turn) === label) {
      if (turn.id === target.id) break
      ordinal += 1
    }
  }

  // git log order is newest-first; we need oldest-first to index by ordinal.
  const matches = checkpoints
    .filter((entry) => entry.label === label)
    .slice()
    .reverse()
  return matches[ordinal] ?? null
}
