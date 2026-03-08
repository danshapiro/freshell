/** Generate a context-rich one-line preview for a tool header. */
export function getToolPreview(name: string, input?: Record<string, unknown>): string {
  if (!input) return ''

  if (name === 'Bash') {
    if (typeof input.description === 'string') return input.description
    if (typeof input.command === 'string') return `$ ${input.command.slice(0, 120)}`
    return ''
  }

  if (name === 'Grep') {
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    const path = typeof input.path === 'string' ? input.path : ''
    return path ? `${pattern} in ${path}` : pattern
  }

  if ((name === 'Read' || name === 'Write' || name === 'Edit') && typeof input.file_path === 'string') {
    return input.file_path
  }

  if (name === 'Glob' && typeof input.pattern === 'string') {
    return input.pattern
  }

  if (name === 'WebFetch' && typeof input.url === 'string') {
    return input.url
  }

  if (name === 'WebSearch' && typeof input.query === 'string') {
    return input.query
  }

  return JSON.stringify(input).slice(0, 100)
}
