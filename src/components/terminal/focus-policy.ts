/**
 * TerminalView's background focus paths (the active-pane rAF effect and the
 * coalesced layout flush) can fire long after they were requested — under a
 * saturated main thread, exactly while the user has started inline editing
 * elsewhere in the pane chrome (kata r49m: pane-header rename). Stealing
 * focus mid-edit diverts the pending keystrokes into xterm's helper textarea,
 * where they are consumed as PTY input and silently lost.
 *
 * The policy: programmatic terminal focus yields to any text-entry element
 * outside xterm's own helper textarea. Non-text controls (buttons,
 * checkboxes) do not yield, so click-to-activate typing UX is unchanged.
 * User-driven refocus paths (search close, mobile toolbar) never consult this.
 */
const XTERM_HELPER_TEXTAREA_CLASS = 'xterm-helper-textarea'

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

function isTextEntryControl(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) {
    return !NON_TEXT_INPUT_TYPES.has((el.type || 'text').toLowerCase())
  }
  return false
}

export function shouldYieldProgrammaticTerminalFocus(doc: Document = document): boolean {
  const el = doc.activeElement
  if (!el || el === doc.body) return false
  if (
    el instanceof HTMLTextAreaElement &&
    el.classList.contains(XTERM_HELPER_TEXTAREA_CLASS)
  ) {
    return false
  }
  if (isTextEntryControl(el)) return true
  return el.closest('[contenteditable]:not([contenteditable="false"])') !== null
}
