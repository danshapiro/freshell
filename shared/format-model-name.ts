/**
 * Convert a raw Claude model ID (e.g. "claude-opus-4-6") into a human-readable
 * display name (e.g. "Opus 4.6"). Returns the input unchanged if it doesn't
 * match the claude-{family}-{major}-{minor} pattern.
 */
export function formatModelDisplayName(raw: string): string {
  // Already human-readable (starts with uppercase, contains a space)
  if (/^[A-Z]/.test(raw) && raw.includes(' ')) return raw

  // Match claude-{family}-{major}-{minor}[-{date}]
  const match = raw.match(/^claude-(\w+)-(\d+)-(\d+)(?:-\d{8})?$/)
  if (!match) return raw

  const family = match[1].charAt(0).toUpperCase() + match[1].slice(1)
  return `${family} ${match[2]}.${match[3]}`
}
