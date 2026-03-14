import { describe, it, expect } from 'vitest'
import {
  resolveTerminalFontFamily,
} from '@/lib/terminal-fonts'
import * as terminalFonts from '@/lib/terminal-fonts'

describe('terminal fonts', () => {
  it('resolves a font family with a monospace fallback', () => {
    const resolved = resolveTerminalFontFamily('Consolas')
    const parts = resolved.split(',').map((part) => part.trim().replace(/^"|"$/g, ''))

    expect(parts[0]).toBe('Consolas')
    expect(parts[parts.length - 1]).toBe('monospace')
  })

  it('resolves a safe stack when no preferred font is provided', () => {
    const resolved = resolveTerminalFontFamily(undefined)
    const parts = resolved.split(',').map((part) => part.trim().replace(/^"|"$/g, ''))

    expect(parts.length).toBeGreaterThan(0)
    expect(parts[parts.length - 1]).toBe('monospace')
  })

  it('keeps only font-stack helpers and no storage helper exports', () => {
    expect(typeof terminalFonts.resolveTerminalFontFamily).toBe('function')
    expect(terminalFonts).not.toHaveProperty('LOCAL_TERMINAL_FONT_KEY')
    expect(terminalFonts).not.toHaveProperty('loadLocalTerminalFontFamily')
    expect(terminalFonts).not.toHaveProperty('saveLocalTerminalFontFamily')
    expect(terminalFonts).not.toHaveProperty('applyLocalTerminalFontFamily')
  })
})
