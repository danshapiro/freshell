import { describe, it, expect, afterEach } from 'vitest'
import path from 'path'
import os from 'os'
import { codexProvider, defaultCodexHome, parseCodexSessionContent } from '../../../../server/coding-cli/providers/codex'

describe('codex-provider', () => {
  describe('defaultCodexHome()', () => {
    const originalEnv = process.env.CODEX_HOME

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = originalEnv
      }
    })

    it('should respect CODEX_HOME environment variable when set', () => {
      process.env.CODEX_HOME = '/custom/codex/home'
      expect(defaultCodexHome()).toBe('/custom/codex/home')
    })

    it('should fall back to os.homedir()/.codex when CODEX_HOME not set', () => {
      delete process.env.CODEX_HOME
      const expected = path.join(os.homedir(), '.codex')
      expect(defaultCodexHome()).toBe(expected)
    })
  })

  it('parses codex session metadata and first user message', () => {
    const content = [
      JSON.stringify({
        timestamp: '2026-01-29T18:14:43.573Z',
        type: 'session_meta',
        payload: { id: 'session-xyz', cwd: '/project/a', model_provider: 'openai' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Build the feature' }],
        },
      }),
    ].join('\n')

    const meta = parseCodexSessionContent(content)

    expect(meta.sessionId).toBe('session-xyz')
    expect(meta.cwd).toBe('/project/a')
    expect(meta.title).toBe('Build the feature')
    expect(meta.messageCount).toBe(2)
  })

  it('normalizes codex events into tool call/result', () => {
    const toolCallLine = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: '{"cmd":"ls"}',
        call_id: 'call-1',
      },
    })

    const toolResultLine = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'ok',
      },
    })

    const callEvents = codexProvider.parseEvent(toolCallLine)
    const resultEvents = codexProvider.parseEvent(toolResultLine)

    expect(callEvents[0].type).toBe('tool.call')
    expect(callEvents[0].toolCall?.id).toBe('call-1')
    expect(callEvents[0].toolCall?.name).toBe('exec_command')
    expect(callEvents[0].toolCall?.arguments).toEqual({ cmd: 'ls' })

    expect(resultEvents[0].type).toBe('tool.result')
    expect(resultEvents[0].toolResult?.id).toBe('call-1')
    expect(resultEvents[0].toolResult?.output).toBe('ok')
  })

  it('normalizes codex reasoning events', () => {
    const reasoningLine = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'agent_reasoning',
        text: 'Reasoning here',
      },
    })

    const events = codexProvider.parseEvent(reasoningLine)

    expect(events[0].type).toBe('reasoning')
    expect(events[0].reasoning).toBe('Reasoning here')
  })

  it('builds stream args with model and sandbox', () => {
    const args = codexProvider.getStreamArgs({
      prompt: 'Hello',
      model: 'gpt-5-codex',
      sandbox: 'read-only',
    })

    expect(args).toEqual(['exec', '--json', '--model', 'gpt-5-codex', '--sandbox', 'read-only', 'Hello'])
  })
})
