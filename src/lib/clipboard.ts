export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Fall through to legacy copy
    }
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    textarea.style.pointerEvents = 'none'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}

/**
 * Check if clipboard read is available in this context.
 * Clipboard API requires secure context (HTTPS or localhost).
 */
export function isClipboardReadAvailable(): boolean {
  if (typeof navigator === 'undefined') return false
  if (typeof navigator.clipboard?.readText !== 'function') return false
  // Check if we're in a secure context (required for clipboard API)
  if (typeof window !== 'undefined' && 'isSecureContext' in window) {
    return window.isSecureContext
  }
  // Fallback: localhost is always secure
  return typeof location !== 'undefined' && location.hostname === 'localhost'
}

export async function readText(): Promise<string | null> {
  if (isClipboardReadAvailable()) {
    try {
      return await navigator.clipboard.readText()
    } catch {
      return null
    }
  }
  return null
}
