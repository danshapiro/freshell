import { describe, expect, it } from 'vitest'
import type { ClientExtensionEntry } from '@shared/extension-types'
import {
  getProviderTerminalBehavior,
  prefersCanvasRenderer,
  providerUsesExtensionTerminalBehavior,
  scrollLinesToCursorKeys,
  shouldTranslateScrollToCursorKeys,
} from '@/lib/terminal-behavior'

const extensions: ClientExtensionEntry[] = [{
  name: 'opencode',
  version: '1.0.0',
  label: 'OpenCode',
  description: 'OpenCode CLI agent',
  category: 'cli',
  cli: {
    terminalBehavior: {
      preferredRenderer: 'canvas',
      scrollInputPolicy: 'fallbackToCursorKeysWhenAltScreenMouseCapture',
    },
  },
}]

describe('terminal behavior', () => {
  it('returns provider terminal behavior from the extension registry', () => {
    expect(getProviderTerminalBehavior('opencode', extensions)).toEqual({
      preferredRenderer: 'canvas',
      scrollInputPolicy: 'fallbackToCursorKeysWhenAltScreenMouseCapture',
    })
  })

  it('keeps non-opted-in providers native by default', () => {
    expect(getProviderTerminalBehavior('codex', extensions)).toEqual({
      preferredRenderer: undefined,
      scrollInputPolicy: 'native',
    })
  })

  it('requires both alt screen and mouse capture before translating scroll', () => {
    expect(shouldTranslateScrollToCursorKeys({
      scrollInputPolicy: 'fallbackToCursorKeysWhenAltScreenMouseCapture',
      altBufferActive: true,
      mouseTrackingMode: 'any',
    })).toBe(true)
    expect(shouldTranslateScrollToCursorKeys({
      scrollInputPolicy: 'fallbackToCursorKeysWhenAltScreenMouseCapture',
      altBufferActive: false,
      mouseTrackingMode: 'any',
    })).toBe(false)
  })

  it('builds repeated cursor-key sequences for positive and negative line counts', () => {
    expect(scrollLinesToCursorKeys(-2, false)).toBe('\u001b[A\u001b[A')
    expect(scrollLinesToCursorKeys(3, true)).toBe('\u001bOB\u001bOB\u001bOB')
  })

  it('maps canvas renderer preference without hard-coded provider checks', () => {
    expect(prefersCanvasRenderer('opencode', extensions)).toBe(true)
    expect(prefersCanvasRenderer('codex', extensions)).toBe(false)
  })

  it('only waits for extension-managed behavior on opted-in providers', () => {
    expect(providerUsesExtensionTerminalBehavior('opencode')).toBe(true)
    expect(providerUsesExtensionTerminalBehavior('codex')).toBe(false)
    expect(providerUsesExtensionTerminalBehavior('claude')).toBe(false)
  })
})
