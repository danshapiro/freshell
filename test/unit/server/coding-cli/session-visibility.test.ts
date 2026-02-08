import { describe, it, expect } from 'vitest'
import { parseCodexSessionContent } from '../../../../server/coding-cli/providers/codex'

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
})
