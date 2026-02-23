import { describe, it, expect } from 'vitest'
import { partitionSendKeysArgs } from '../../../server/cli/send-keys-args'

describe('partitionSendKeysArgs', () => {
  it('keeps all key args when target is provided via -t/--target', () => {
    const parsed = partitionSendKeysArgs(['echo hello'], 'pane-1')
    expect(parsed.target).toBe('pane-1')
    expect(parsed.keyArgs).toEqual(['echo hello'])
  })

  it('uses first positional arg as target when no explicit target flag is present', () => {
    const parsed = partitionSendKeysArgs(['pane-1', 'ENTER'])
    expect(parsed.target).toBe('pane-1')
    expect(parsed.keyArgs).toEqual(['ENTER'])
  })

  it('returns empty target and key args when no positional args are provided', () => {
    const parsed = partitionSendKeysArgs([])
    expect(parsed.target).toBeUndefined()
    expect(parsed.keyArgs).toEqual([])
  })
})
