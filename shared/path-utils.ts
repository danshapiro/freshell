/**
 * Determines whether a string looks like a filesystem path.
 *
 * Rejects URLs and protocol-based strings (e.g. https://, s3://, file://).
 * Accepts Unix absolute paths, Windows drive-letter paths, UNC paths,
 * relative paths (./  ../  .\  ..\), tilde home-dir references, and
 * the special directory tokens "~", ".", and "..".
 */
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
