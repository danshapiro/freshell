import { describe, it, expect } from 'vitest'
import { formatModelDisplayName } from '../../../shared/format-model-name'

describe('formatModelDisplayName', () => {
  it('converts claude-opus-4-6 to Opus 4.6', () => {
    expect(formatModelDisplayName('claude-opus-4-6')).toBe('Opus 4.6')
  })

  it('converts claude-sonnet-4-5-20250929 to Sonnet 4.5', () => {
    expect(formatModelDisplayName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
  })

  it('converts claude-haiku-4-5-20251001 to Haiku 4.5', () => {
    expect(formatModelDisplayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  })

  it('converts claude-sonnet-4-6 to Sonnet 4.6', () => {
    expect(formatModelDisplayName('claude-sonnet-4-6')).toBe('Sonnet 4.6')
  })

  it('converts claude-opus-4-5-20250929 to Opus 4.5', () => {
    expect(formatModelDisplayName('claude-opus-4-5-20250929')).toBe('Opus 4.5')
  })

  it('returns already-human-readable names unchanged', () => {
    expect(formatModelDisplayName('Opus 4.6')).toBe('Opus 4.6')
    expect(formatModelDisplayName('Sonnet 4.5')).toBe('Sonnet 4.5')
  })

  it('returns "Default" unchanged', () => {
    expect(formatModelDisplayName('Default')).toBe('Default')
  })

  it('handles unknown model IDs by cleaning up the prefix', () => {
    expect(formatModelDisplayName('claude-future-5-0')).toBe('Future 5.0')
  })

  it('handles non-claude model IDs as-is', () => {
    expect(formatModelDisplayName('gpt-4o')).toBe('gpt-4o')
  })
})
