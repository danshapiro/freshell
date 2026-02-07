import { describe, it, expect } from 'vitest'
import { deriveTabName } from '@/lib/deriveTabName'
import type { PaneNode } from '@/store/paneTypes'

describe('deriveTabName', () => {
  it('returns provider label for codex terminal', () => {
    const layout: PaneNode = {
      type: 'leaf',
      id: 'pane-1',
      content: {
        kind: 'terminal',
        mode: 'codex',
        status: 'running',
        createRequestId: 'req-1',
      },
    }

    expect(deriveTabName(layout)).toBe('Codex')
  })

  it('returns provider label for gemini terminal', () => {
    const layout: PaneNode = {
      type: 'leaf',
      id: 'pane-1',
      content: {
        kind: 'terminal',
        mode: 'gemini',
        status: 'running',
        createRequestId: 'req-1',
      },
    }

    expect(deriveTabName(layout)).toBe('Gemini')
  })
})
