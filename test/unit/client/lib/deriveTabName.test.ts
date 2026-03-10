import { describe, it, expect } from 'vitest'
import { deriveTabName } from '@/lib/deriveTabName'
import type { PaneNode } from '@/store/paneTypes'
import type { ClientExtensionEntry } from '@shared/extension-types'

const mockExtensions: ClientExtensionEntry[] = [
  { name: 'codex', label: 'Codex CLI', category: 'cli', version: '1.0.0', description: '' },
  { name: 'gemini', label: 'Gemini', category: 'cli', version: '1.0.0', description: '' },
]

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

    expect(deriveTabName(layout, mockExtensions)).toBe('Codex CLI')
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

    expect(deriveTabName(layout, mockExtensions)).toBe('Gemini')
  })

  it('falls back to capitalized name without extensions', () => {
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
})
