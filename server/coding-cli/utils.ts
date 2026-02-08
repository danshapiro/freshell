/**
 * Check if a "user" message is actually system context injected by coding CLIs.
 * Both Claude and Codex inject system prompts as role:"user" messages:
 * - XML-wrapped context: <environment_context>, <user_instructions>, etc.
 * - Instruction file headers: "# AGENTS.md...", "# Instructions", "# System"
 * - Bracketed agent modes: [SUGGESTION MODE: ...], [REVIEW MODE: ...]
 * - IDE context format: "# Context from my IDE setup:"
 * - Pasted log/debug output: starts with digit + comma (e.g. "0, totalJsHeapSize...")
 * - Agent boilerplate: "You are an automated..." (but NOT "You are an expert/experienced")
 * - Pasted shell output: "> command" or "$ command"
 */
export function isSystemContext(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  // XML-wrapped system context: <system_context>, <environment_context>, <INSTRUCTIONS>, etc.
  if (/^<[a-zA-Z_][\w_-]*[>\s]/.test(trimmed)) return true
  // Instruction file headers: "# AGENTS.md instructions for...", "# System", "# Instructions"
  if (/^#\s*(AGENTS|Instructions?|System)/i.test(trimmed)) return true
  // Bracketed agent mode instructions: [SUGGESTION MODE: ...], [REVIEW MODE: ...]
  if (/^\[[A-Z][A-Z_ ]*:/.test(trimmed)) return true
  // IDE context format: "# Context from my IDE setup:"
  if (/^#\s*Context from my IDE setup:/i.test(trimmed)) return true
  // Pasted log/debug output: starts with digit + comma (heap stats, etc.)
  if (/^\d+,\s/.test(trimmed)) return true
  // Agent boilerplate: "You are an automated..." but NOT "You are an expert/experienced"
  if (/^You are an automated\b/i.test(trimmed)) return true
  // Pasted shell output: "> command" or "$ command" (shell prompt prefixes)
  // Must be followed by a non-space char that looks like a command (not a quote/prose)
  if (/^[>$]\s+[a-zA-Z.\/]/.test(trimmed)) {
    // Distinguish from prose: shell commands typically start with known command patterns
    const afterPrefix = trimmed.replace(/^[>$]\s+/, '')
    // If it looks like a filesystem path or common CLI command, it's shell output
    if (/^[a-z]/.test(afterPrefix) || afterPrefix.startsWith('./') || afterPrefix.startsWith('/')) {
      return true
    }
  }
  return false
}

/**
 * Extract the actual user request from IDE-formatted context messages.
 * IDE context messages follow this format:
 *   # Context from my IDE setup:
 *   ## My codebase
 *   ...
 *   ## My request for Codex:
 *   <actual user request>
 *
 * Returns the first non-empty line after "## My request for Codex:" or undefined.
 */
export function extractFromIdeContext(text: string): string | undefined {
  const lines = text.split('\n')
  let inRequestSection = false

  for (const line of lines) {
    if (/^##\s*My request for Codex:/i.test(line)) {
      inRequestSection = true
      continue
    }
    if (inRequestSection) {
      const trimmed = line.trim()
      if (trimmed) return trimmed
    }
  }

  return undefined
}

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
