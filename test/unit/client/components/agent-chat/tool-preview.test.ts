import { describe, it, expect } from 'vitest'
import { getToolPreview } from '@/components/agent-chat/tool-preview'

describe('getToolPreview', () => {
  it('returns empty string when no input', () => {
    expect(getToolPreview('Bash')).toBe('')
  })

  it('returns Bash description when available', () => {
    expect(getToolPreview('Bash', { command: 'npm test', description: 'Run tests' })).toBe('Run tests')
  })

  it('returns Bash command with $ prefix when no description', () => {
    expect(getToolPreview('Bash', { command: 'ls -la' })).toBe('$ ls -la')
  })

  it('returns Grep pattern and path', () => {
    expect(getToolPreview('Grep', { pattern: 'useState', path: 'src/' })).toBe('useState in src/')
  })

  it('returns Read file_path', () => {
    expect(getToolPreview('Read', { file_path: '/home/user/file.ts' })).toBe('/home/user/file.ts')
  })

  it('returns Edit file_path', () => {
    expect(getToolPreview('Edit', { file_path: 'src/App.tsx', old_string: 'a', new_string: 'b' })).toBe('src/App.tsx')
  })

  it('returns Glob pattern', () => {
    expect(getToolPreview('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
  })

  it('returns WebFetch url', () => {
    expect(getToolPreview('WebFetch', { url: 'https://example.com' })).toBe('https://example.com')
  })

  it('returns WebSearch query', () => {
    expect(getToolPreview('WebSearch', { query: 'React docs 2026' })).toBe('React docs 2026')
  })

  it('returns JSON fallback for unknown tools', () => {
    expect(getToolPreview('Unknown', { key: 'value' })).toBe('{"key":"value"}')
  })
})
