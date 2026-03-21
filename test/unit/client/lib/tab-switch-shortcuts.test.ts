import { describe, expect, it } from 'vitest'
import { getTabSwitchShortcutDirection, getTabLifecycleAction } from '@/lib/tab-switch-shortcuts'
import { KEYBOARD_SHORTCUTS } from '@/lib/keyboard-shortcuts'

describe('getTabSwitchShortcutDirection', () => {
  it('maps Ctrl+Shift+[ and Ctrl+Shift+] to tab directions', () => {
    expect(getTabSwitchShortcutDirection({
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      code: 'BracketLeft',
    })).toBe('prev')

    expect(getTabSwitchShortcutDirection({
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      code: 'BracketRight',
    })).toBe('next')
  })

  it('ignores other modifier combinations', () => {
    expect(getTabSwitchShortcutDirection({
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      code: 'BracketRight',
    })).toBeNull()

    expect(getTabSwitchShortcutDirection({
      ctrlKey: true,
      shiftKey: true,
      altKey: true,
      metaKey: false,
      code: 'BracketRight',
    })).toBeNull()

    expect(getTabSwitchShortcutDirection({
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: true,
      code: 'BracketLeft',
    })).toBeNull()
  })
})

describe('getTabLifecycleAction', () => {
  it('maps Alt+T to new and Alt+W to close', () => {
    expect(getTabLifecycleAction({
      altKey: true, ctrlKey: false, shiftKey: false, metaKey: false,
      code: 'KeyT',
    })).toBe('new')

    expect(getTabLifecycleAction({
      altKey: true, ctrlKey: false, shiftKey: false, metaKey: false,
      code: 'KeyW',
    })).toBe('close')
  })

  it('ignores other modifier combinations', () => {
    expect(getTabLifecycleAction({
      altKey: true, ctrlKey: true, shiftKey: false, metaKey: false,
      code: 'KeyT',
    })).toBeNull()

    expect(getTabLifecycleAction({
      altKey: true, ctrlKey: false, shiftKey: true, metaKey: false,
      code: 'KeyW',
    })).toBeNull()

    expect(getTabLifecycleAction({
      altKey: false, ctrlKey: false, shiftKey: false, metaKey: false,
      code: 'KeyT',
    })).toBeNull()
  })

  it('maps Alt+H to reopen', () => {
    expect(getTabLifecycleAction({
      altKey: true, ctrlKey: false, shiftKey: false, metaKey: false,
      code: 'KeyH',
    })).toBe('reopen')
  })

  it('rejects Alt+Ctrl+H (modifier combo)', () => {
    expect(getTabLifecycleAction({
      altKey: true, ctrlKey: true, shiftKey: false, metaKey: false,
      code: 'KeyH',
    })).toBeNull()
  })

  it('rejects Alt+Shift+H (modifier combo)', () => {
    expect(getTabLifecycleAction({
      altKey: true, ctrlKey: false, shiftKey: true, metaKey: false,
      code: 'KeyH',
    })).toBeNull()
  })

  it('ignores other keys with Alt', () => {
    expect(getTabLifecycleAction({
      altKey: true, ctrlKey: false, shiftKey: false, metaKey: false,
      code: 'KeyA',
    })).toBeNull()
  })
})

describe('KEYBOARD_SHORTCUTS', () => {
  it('contains an Alt+H entry for reopening closed tabs', () => {
    const entry = KEYBOARD_SHORTCUTS.find(
      (s) => s.keys.includes('Alt') && s.keys.includes('H')
    )
    expect(entry).toBeDefined()
    expect(entry!.description.toLowerCase()).toContain('reopen')
    expect(entry!.category).toBe('tabs')
  })
})
