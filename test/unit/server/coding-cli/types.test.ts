import { describe, expect, it } from 'vitest'
import {
  makeSessionKey,
  normalizeSessionCwdForKey,
  parseSessionKey,
} from '../../../../server/coding-cli/types.js'
import {
  SESSION_KEY_NORMALIZATION_CASES,
  makeExpectedScopedSessionKey,
} from '@test/shared/coding-cli-session-key-corpus'

describe('server coding-cli session keys', () => {
  it.each(SESSION_KEY_NORMALIZATION_CASES)('normalizes $name cwd values consistently', ({ rawCwd, normalizedCwd }) => {
    expect(normalizeSessionCwdForKey(rawCwd)).toBe(normalizedCwd)

    const compositeKey = makeSessionKey('kimi', 'team:alpha', rawCwd)
    expect(compositeKey).toBe(makeExpectedScopedSessionKey('kimi', 'team:alpha', normalizedCwd))
    expect(parseSessionKey(compositeKey)).toEqual({
      provider: 'kimi',
      sessionId: 'team:alpha',
      cwd: normalizedCwd,
    })
  })
})
