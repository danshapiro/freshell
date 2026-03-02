import { describe, it, expect, beforeEach } from 'vitest'
import { getDraft, setDraft, clearDraft } from '@/lib/draft-store'

describe('draft-store', () => {
  beforeEach(() => {
    // Clean slate — clear any drafts from previous tests
    clearDraft('pane-a')
    clearDraft('pane-b')
  })

  it('returns empty string when no draft exists', () => {
    expect(getDraft('nonexistent')).toBe('')
  })

  it('stores and retrieves a draft', () => {
    setDraft('pane-a', 'hello world')
    expect(getDraft('pane-a')).toBe('hello world')
  })

  it('keeps independent drafts per paneId', () => {
    setDraft('pane-a', 'draft A')
    setDraft('pane-b', 'draft B')
    expect(getDraft('pane-a')).toBe('draft A')
    expect(getDraft('pane-b')).toBe('draft B')
  })

  it('clears a specific draft', () => {
    setDraft('pane-a', 'some text')
    clearDraft('pane-a')
    expect(getDraft('pane-a')).toBe('')
  })

  it('removes draft when set to empty string', () => {
    setDraft('pane-a', 'some text')
    setDraft('pane-a', '')
    expect(getDraft('pane-a')).toBe('')
  })
})
