import { describe, expect, it } from 'vitest'
import { getTabSwitchShortcutDirection } from '@/lib/tab-switch-shortcuts'

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
