import { describe, expect, it } from 'vitest'
import { getToolPreview } from '@/components/fresh-agent/shared/tool-preview'

// Inputs mirror what the Claude CLI persists for each tool (the Agent and
// ExitPlanMode shapes come from the pinned CLI 2.1.237 captures).
describe('getToolPreview for claude agent tools', () => {
  it('previews a subagent delegation by its description (Agent on the wire, Task in older CLIs)', () => {
    const input = { description: 'check file', prompt: 'read a.txt', subagent_type: 'general-purpose' }
    expect(getToolPreview('Agent', input)).toBe('check file')
    expect(getToolPreview('Task', input)).toBe('check file')
  })

  it('previews a todo list by its in-progress item, else by its size', () => {
    const todos = [
      { content: 'Write tests', status: 'completed', activeForm: 'Writing tests' },
      { content: 'Fix the parser', status: 'in_progress', activeForm: 'Fixing the parser' },
      { content: 'Ship', status: 'pending', activeForm: 'Shipping' },
    ]
    expect(getToolPreview('TodoWrite', { todos })).toBe('Fixing the parser')
    expect(getToolPreview('TodoWrite', { todos: todos.map((todo) => ({ ...todo, status: 'pending' })) })).toBe('3 todos')
    expect(getToolPreview('TodoWrite', { todos: [{ content: 'Only', status: 'pending' }] })).toBe('1 todo')
    expect(getToolPreview('TodoWrite', { todos: [{ content: 'No active form', status: 'in_progress' }] })).toBe('No active form')
  })

  it('previews a plan by its first non-empty line', () => {
    expect(getToolPreview('ExitPlanMode', { plan: '\n## Plan\n1. do it\n2. ship it' })).toBe('## Plan')
    expect(getToolPreview('ExitPlanMode', { plan: '1. do it' })).toBe('1. do it')
  })

  it('previews multi-file and notebook edits by their path', () => {
    expect(getToolPreview('MultiEdit', { file_path: '/w/a.ts', edits: [] })).toBe('/w/a.ts')
    expect(getToolPreview('NotebookEdit', { notebook_path: '/w/n.ipynb', new_source: 'x' })).toBe('/w/n.ipynb')
  })

  it('keeps the JSON fallback for unknown tools and malformed inputs', () => {
    expect(getToolPreview('Mystery', { a: 1 })).toBe('{"a":1}')
    expect(getToolPreview('TodoWrite', { todos: 'nope' })).toBe('{"todos":"nope"}')
  })
})
