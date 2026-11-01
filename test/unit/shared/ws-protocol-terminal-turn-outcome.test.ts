import { describe, expect, it } from 'vitest'

import { TerminalTurnCompleteSchema } from '@shared/ws-protocol'

const complete = {
  type: 'terminal.turn.complete',
  terminalId: 'terminal-1',
  provider: 'codex',
  at: 1,
  completionSeq: 1,
} as const

describe('terminal turn completion outcomes', () => {
  it('accepts completed and failed outcomes while retaining legacy frames', () => {
    expect(TerminalTurnCompleteSchema.parse({ ...complete, outcome: 'completed' }).outcome).toBe('completed')
    expect(TerminalTurnCompleteSchema.parse({ ...complete, outcome: 'failed' }).outcome).toBe('failed')
    expect(TerminalTurnCompleteSchema.parse(complete).outcome).toBeUndefined()
  })

  it('rejects unknown outcome values', () => {
    expect(TerminalTurnCompleteSchema.safeParse({ ...complete, outcome: 'interrupted' }).success).toBe(false)
  })
})
