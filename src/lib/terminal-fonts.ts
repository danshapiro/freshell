const DEFAULT_MONO_FALLBACKS = [
  'Cascadia Mono',
  'Cascadia Code',
  'JetBrains Mono',
  'Fira Code',
  'Source Code Pro',
  'IBM Plex Mono',
  'Menlo',
  'Monaco',
  'Consolas',
  'Liberation Mono',
  'DejaVu Sans Mono',
  'Noto Sans Mono',
  'Roboto Mono',
  'Droid Sans Mono',
  'monospace',
]

const GENERIC_FONTS = new Set(['monospace', 'serif', 'sans-serif', 'ui-monospace', 'system-ui'])

function normalizeFontToken(token: string): string | null {
  const trimmed = token.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  if (GENERIC_FONTS.has(lower)) return lower

  const hasQuotes =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  if (hasQuotes) return trimmed

  if (/\s/.test(trimmed)) {
    return `"${trimmed.replace(/"/g, '\\"')}"`
  }
  return trimmed
}

function tokenKey(token: string): string {
  return token.replace(/^['"]|['"]$/g, '').toLowerCase()
}

function splitFontStack(value: string): string[] {
  return value.split(',').map((part) => part.trim()).filter(Boolean)
}

export function resolveTerminalFontFamily(preferred?: string | null): string {
  const preferredTokens = preferred ? splitFontStack(preferred) : []
  const allTokens = [...preferredTokens, ...DEFAULT_MONO_FALLBACKS]
  const seen = new Set<string>()
  const resolved: string[] = []

  for (const token of allTokens) {
    const normalized = normalizeFontToken(token)
    if (!normalized) continue
    const key = tokenKey(normalized)
    if (seen.has(key)) continue
    seen.add(key)
    resolved.push(normalized)
  }

  return resolved.length > 0 ? resolved.join(', ') : 'monospace'
}
