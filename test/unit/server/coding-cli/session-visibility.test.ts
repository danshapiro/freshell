import { describe, it, expect } from 'vitest'
import { parseCodexSessionContent } from '../../../../server/coding-cli/providers/codex'
import { parseSessionContent } from '../../../../server/coding-cli/providers/claude'

describe('session visibility flags', () => {
  describe('Codex isNonInteractive detection', () => {
    it('sets isNonInteractive when source is "exec"', () => {
      const content = [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'abc-123', cwd: '/home/user/project', source: 'exec' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ text: 'Review this code' }] },
        }),
      ].join('\n')

      const meta = parseCodexSessionContent(content)
      expect(meta.isNonInteractive).toBe(true)
    })

    it('does not set isNonInteractive when source is absent', () => {
      const content = [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'abc-123', cwd: '/home/user/project' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ text: 'Help me' }] },
        }),
      ].join('\n')

      const meta = parseCodexSessionContent(content)
      expect(meta.isNonInteractive).toBeFalsy()
    })

    it('does not set isNonInteractive when source is "interactive"', () => {
      const content = [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'abc-123', cwd: '/home/user/project', source: 'interactive' },
        }),
      ].join('\n')

      const meta = parseCodexSessionContent(content)
      expect(meta.isNonInteractive).toBeFalsy()
    })
  })

  describe('Claude isNonInteractive detection', () => {
    it('sets isNonInteractive when queue-operation events are present', () => {
      const content = [
        JSON.stringify({ type: 'queue-operation', subtype: 'enqueue', taskId: 'task-1' }),
        JSON.stringify({ cwd: '/home/user/project', type: 'user', message: { role: 'user', content: 'Automated task' } }),
      ].join('\n')

      const meta = parseSessionContent(content)
      expect(meta.isNonInteractive).toBe(true)
    })

    it('does not set isNonInteractive for normal Claude sessions', () => {
      const content = [
        JSON.stringify({ cwd: '/home/user/project', type: 'user', message: { role: 'user', content: 'Help me' } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Sure!' }] } }),
      ].join('\n')

      const meta = parseSessionContent(content)
      expect(meta.isNonInteractive).toBeFalsy()
    })
  })
})
