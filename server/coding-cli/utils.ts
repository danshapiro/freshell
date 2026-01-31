export function looksLikePath(s: string): boolean {
  // Reject URLs and protocol-based strings (contain :// before any path separator)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
    return false
  }

  // Accept special directory references
  if (s === '~' || s === '.' || s === '..') {
    return true
  }

  // Accept paths with separators or Windows drive letters
  return s.includes('/') || s.includes('\\') || /^[A-Za-z]:\\/.test(s)
}
