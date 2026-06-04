/**
 * Extract the last directory/path segment ("basename") from a filesystem path.
 * Handles both Unix and Windows separators, trailing slashes, the Unix root,
 * and Windows drive roots. Returns null when no meaningful segment exists.
 *
 * Shared by the client (tab/pane title derivation) and the server (dir-name
 * placeholder for coding-agent session overrides) so the edge cases live once.
 */
export function basenameSegment(path: string): string | null {
  // Remove trailing slashes
  const trimmed = path.replace(/[\\/]+$/, '')

  // Handle root paths
  if (trimmed === '' && path.startsWith('/')) return '/'
  if (/^[A-Za-z]:$/.test(trimmed)) return trimmed + '\\'

  // Split by both forward and back slashes
  const segments = trimmed.split(/[\\/]/)
  const last = segments[segments.length - 1]

  return last || null
}
