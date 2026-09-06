import { describe, expect, it, afterEach } from 'vitest'

import { shouldYieldProgrammaticTerminalFocus } from '@/components/terminal/focus-policy'

function appendFocused<T extends HTMLElement>(el: T): T {
  document.body.appendChild(el)
  el.focus()
  return el
}

afterEach(() => {
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  document.body.innerHTML = ''
  expect(shouldYieldProgrammaticTerminalFocus()).toBe(false)
})

describe('shouldYieldProgrammaticTerminalFocus', () => {
  it('does not yield when nothing (body) is focused', () => {
    expect(document.activeElement).toBe(document.body)
    expect(shouldYieldProgrammaticTerminalFocus()).toBe(false)
  })

  it('yields to a focused text input (the pane-rename editor case)', () => {
    appendFocused(Object.assign(document.createElement('input'), { type: 'text' }))
    expect(shouldYieldProgrammaticTerminalFocus()).toBe(true)
  })

  it('yields to a focused plain textarea', () => {
    appendFocused(document.createElement('textarea'))
    expect(shouldYieldProgrammaticTerminalFocus()).toBe(true)
  })

  it('yields to a focused contenteditable region', () => {
    // tabIndex makes the div deterministically focusable in jsdom.
    const el = Object.assign(document.createElement('div'), { tabIndex: 0 })
    el.setAttribute('contenteditable', 'true')
    appendFocused(el)
    expect(shouldYieldProgrammaticTerminalFocus()).toBe(true)
  })

  it('does NOT yield to xterm\'s own helper textarea (the terminal itself has focus)', () => {
    const helper = appendFocused(document.createElement('textarea'))
    helper.classList.add('xterm-helper-textarea')
    helper.focus()
    expect(shouldYieldProgrammaticTerminalFocus()).toBe(false)
  })

  it('does NOT yield to non-text controls (buttons, checkboxes) so click-to-activate UX is preserved', () => {
    appendFocused(Object.assign(document.createElement('button'), { textContent: 'Close' }))
    expect(shouldYieldProgrammaticTerminalFocus()).toBe(false)

    ;(document.activeElement as HTMLElement).blur()
    appendFocused(Object.assign(document.createElement('input'), { type: 'checkbox' }))
    expect(shouldYieldProgrammaticTerminalFocus()).toBe(false)
  })
})
