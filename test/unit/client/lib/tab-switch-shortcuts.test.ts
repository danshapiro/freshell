import { describe, expect, it } from 'vitest'
import { getTabSwitchShortcutDirection, getTabLifecycleAction } from '@/lib/tab-switch-shortcuts'

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

  it('maps Alt+[ and Alt+] to tab directions', () => {
    expect(getTabSwitchShortcutDirection({
      ctrlKey: false,
      shiftKey: false,
      altKey: true,
      metaKey: false,
      code: 'BracketLeft',
    })).toBe('prev')

    expect(getTabSwitchShortcutDirection({
      ctrlKey: false,
      shiftKey: false,
      altKey: true,
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

    expect(getTabSwitchShortcutDirection({
      altKey: true,
      ctrlKey: true,
      shiftKey: false,
      metaKey: false,
      code: 'BracketLeft',
    })).toBeNull()

    expect(getTabSwitchShortcutDirection({
      altKey: true,
      ctrlKey: false,
      shiftKey: false,
      metaKey: true,
      code: 'BracketRight',
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

  it('ignores other keys with Alt', () => {
    expect(getTabLifecycleAction({
      altKey: true, ctrlKey: false, shiftKey: false, metaKey: false,
      code: 'KeyA',
    })).toBeNull()
  })
})
