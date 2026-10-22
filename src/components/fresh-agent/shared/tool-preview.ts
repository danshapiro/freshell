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

  if ((name === 'Read' || name === 'Write' || name === 'Edit' || name === 'MultiEdit') && typeof input.file_path === 'string') {
    return input.file_path
  }

  if (name === 'NotebookEdit' && typeof input.notebook_path === 'string') {
    return input.notebook_path
  }

  // The subagent tool: `Agent` on the wire, `Task` in older CLIs.
  if ((name === 'Agent' || name === 'Task') && typeof input.description === 'string') {
    return input.description
  }

  if (name === 'TodoWrite' && Array.isArray(input.todos)) {
    return todoPreview(input.todos)
  }

  if (name === 'ExitPlanMode' && typeof input.plan === 'string') {
    const firstLine = input.plan.split('\n').map((line) => line.trim()).find((line) => line.length > 0)
    if (firstLine) return firstLine.slice(0, 120)
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

/** The in-progress todo (its active form when present), else the list size. */
function todoPreview(todos: unknown[]): string {
  const active = todos.find((todo): todo is Record<string, unknown> => (
    typeof todo === 'object' && todo !== null && (todo as Record<string, unknown>).status === 'in_progress'
  ))
  if (active) {
    if (typeof active.activeForm === 'string' && active.activeForm) return active.activeForm
    if (typeof active.content === 'string') return active.content
  }
  return `${todos.length} todo${todos.length === 1 ? '' : 's'}`
}
