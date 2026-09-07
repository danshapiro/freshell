export function isAbsolutePath(value: string): boolean {
  if (!value) return false
  if (value.startsWith('/') || value.startsWith('\\') || value.startsWith('~')) return true
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true
  if (value.startsWith('\\\\')) return true
  return false
}

export interface FilePathMatch {
  path: string
  startIndex: number
  endIndex: number
}

/**
 * Find local file paths in a line of terminal output.
 * Detects paths starting with ~/ (tilde) or / (absolute).
 * Excludes URLs and requires paths to have meaningful content.
 */
export function findLocalFilePaths(line: string): FilePathMatch[] {
  const results: FilePathMatch[] = []

  // Pattern 1: Tilde paths (~/...)
  // Low false-positive risk — tilde prefix is unambiguous
  const tildeRegex = /~\/[^\s"')\]>,;`]+/g
  let match
  while ((match = tildeRegex.exec(line)) !== null) {
    const filePath = stripTrailingPunctuation(match[0])
    if (filePath.length >= 3) {
      results.push({ path: filePath, startIndex: match.index, endIndex: match.index + filePath.length })
    }
  }

  // Pattern 2: Absolute paths (/...)
  // Must be preceded by start-of-line, whitespace, or opening delimiter
  // to avoid matching mid-URL paths like http://example.com/path
  const absRegex = /(^|[\s(["'`])(\/(?:[\w._~-]+\/)*[\w._~-]+(?:\.[\w]+)?)/gm
  while ((match = absRegex.exec(line)) !== null) {
    const prefix = match[1]
    const raw = match[2]
    const pathStart = match.index + prefix.length

    // Skip if preceded by a URL scheme (e.g., "http:", "https:", "file:")
    if (pathStart > 0) {
      const before = line.substring(Math.max(0, pathStart - 10), pathStart)
      if (/[a-zA-Z]+:$/.test(before)) continue
    }

    const filePath = stripTrailingPunctuation(raw)
    if (filePath === '/') continue
    // Require either multiple segments or a file extension for single-segment paths
    if (!filePath.includes('/', 1) && !/\.[\w]+$/.test(filePath)) continue

    results.push({ path: filePath, startIndex: pathStart, endIndex: pathStart + filePath.length })
  }

  return results
}

function stripTrailingPunctuation(path: string): string {
  return path.replace(/[.,;:!?]+$/, '')
}

export function joinPath(root: string, relativePath: string): string {
  const separator = root.includes('\\') ? '\\' : '/'
  const trimmedRoot = root.endsWith('/') || root.endsWith('\\') ? root.slice(0, -1) : root
  const trimmedRelative =
    relativePath.startsWith('/') || relativePath.startsWith('\\')
      ? relativePath.slice(1)
      : relativePath
  return `${trimmedRoot}${separator}${trimmedRelative}`
}

/**
 * Extensions the client routes to an image viewer. Deliberately aligned with
 * the `image/*` entries of the Rust byte-lane MIME table
 * (crates/freshell-server/src/files.rs `local_file_content_type`), which the
 * production self-hosted server uses to label exactly these correctly. The
 * Node `/api/files/raw` route labels via send's vendored mime table, which
 * serves `.avif` as application/octet-stream (pre-existing `/local-file` lane
 * behavior); the named requirement (`.png`) renders on both servers.
 */
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif', 'svg',
])

/**
 * True when the final segment of a file path (absolute, tilde, relative, or
 * Windows) ends in a known image extension, case-insensitively. Dotfiles
 * like `/x/.png` have no extension and return false.
 */
export function isImageFilePath(filePath: string): boolean {
  const segment = filePath.split(/[\\/]/).pop() ?? ''
  const dot = segment.lastIndexOf('.')
  if (dot <= 0) return false
  return IMAGE_EXTENSIONS.has(segment.slice(dot + 1).toLowerCase())
}
