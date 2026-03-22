import { describe, expect, it } from 'vitest'
import {
  makeCodingCliSessionKey,
  normalizeSessionCwdForKey,
} from '@/lib/coding-cli-session-key'
import {
  SESSION_KEY_NORMALIZATION_CASES,
  makeExpectedScopedSessionKey,
} from '@test/shared/coding-cli-session-key-corpus'

describe('coding-cli-session-key', () => {
  it.each(SESSION_KEY_NORMALIZATION_CASES)('normalizes $name cwd values consistently', ({ rawCwd, normalizedCwd }) => {
    expect(normalizeSessionCwdForKey(rawCwd)).toBe(normalizedCwd)
    expect(makeCodingCliSessionKey('kimi', 'team:alpha', rawCwd)).toBe(
      makeExpectedScopedSessionKey('kimi', 'team:alpha', normalizedCwd),
    )
  })
})
