import { describe, it, expect } from 'vitest'
import {
  ClaudeEventType,
  parseClaudeEvent,
  isTextContent,
  isToolUseContent,
  isToolResultContent,
} from '../../../server/claude-stream-types'

describe('claude-stream-types', () => {
  describe('parseClaudeEvent', () => {
    it('parses assistant text message', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_123',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello world' }],
        },
        session_id: 'session_abc',
        uuid: 'uuid_123',
      })

      const event = parseClaudeEvent(line)
      expect(event.type).toBe('assistant')
      expect(event.message.content[0].type).toBe('text')
    })

    it('parses system init event', () => {
      const line = JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'session_abc',
        cwd: '/home/user',
        model: 'claude-sonnet-4-5-20250929',
      })

      const event = parseClaudeEvent(line)
      expect(event.type).toBe('system')
      expect(event.subtype).toBe('init')
    })

    it('parses result event', () => {
      const line = JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 1000,
        session_id: 'session_abc',
      })

      const event = parseClaudeEvent(line)
      expect(event.type).toBe('result')
      expect(event.is_error).toBe(false)
    })

    it('throws on invalid JSON', () => {
      expect(() => parseClaudeEvent('not json')).toThrow()
    })
  })

  describe('content type guards', () => {
    it('identifies text content', () => {
      expect(isTextContent({ type: 'text', text: 'hello' })).toBe(true)
      expect(isTextContent({ type: 'tool_use', id: '1', name: 'Bash', input: {} })).toBe(false)
    })

    it('identifies tool_use content', () => {
      expect(isToolUseContent({ type: 'tool_use', id: '1', name: 'Bash', input: {} })).toBe(true)
    })

    it('identifies tool_result content', () => {
      expect(isToolResultContent({ type: 'tool_result', tool_use_id: '1', content: '' })).toBe(true)
    })
  })
})
