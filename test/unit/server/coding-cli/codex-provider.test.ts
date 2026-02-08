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

  it('does not include raw payload in normalized events', () => {
    const line = JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
      session_id: 's1',
    })

    const events = codexProvider.parseEvent(line)

    expect(events).toHaveLength(1)
    expect('raw' in events[0]).toBe(false)
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

  describe('title extraction skips system context', () => {
    it('skips AGENTS.md instructions and uses actual user prompt', () => {
      const content = [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'session-1', cwd: '/project' },
        }),
        // First "user" message is actually AGENTS.md instructions
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '# AGENTS.md instructions for /project\n\n<INSTRUCTIONS>\nPrefer bash to powershell...' }],
          },
        }),
        // Second "user" message is environment context
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/project</cwd>\n</environment_context>' }],
          },
        }),
        // Third "user" message is the actual prompt
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Review the current code changes' }],
          },
        }),
      ].join('\n')

      const meta = parseCodexSessionContent(content)

      expect(meta.title).toBe('Review the current code changes')
    })

    it('skips messages starting with XML tags like <INSTRUCTIONS>', () => {
      const content = [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'session-2', cwd: '/project' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<INSTRUCTIONS>\nSystem instructions here\n</INSTRUCTIONS>' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Build a new feature' }],
          },
        }),
      ].join('\n')

      const meta = parseCodexSessionContent(content)

      expect(meta.title).toBe('Build a new feature')
    })

    it('skips messages starting with # System or # Instructions', () => {
      const content = [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'session-3', cwd: '/project' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '# System\nYou are a helpful assistant...' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Fix the login bug' }],
          },
        }),
      ].join('\n')

      const meta = parseCodexSessionContent(content)

      expect(meta.title).toBe('Fix the login bug')
    })

    it('uses first user message if none are system context', () => {
      const content = [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'session-4', cwd: '/project' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Hello, help me debug this' }],
          },
        }),
      ].join('\n')

      const meta = parseCodexSessionContent(content)

      expect(meta.title).toBe('Hello, help me debug this')
    })

    it('skips pasted log/debug output (digit+comma)', () => {
      const content = [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'session-5', cwd: '/project' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '0, totalJsHeapSize: 12345678' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Why is memory high?' }],
          },
        }),
      ].join('\n')

      const meta = parseCodexSessionContent(content)

      expect(meta.title).toBe('Why is memory high?')
    })

    it('skips agent boilerplate "You are an automated..."', () => {
      const content = [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'session-6', cwd: '/project' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'You are an automated coding assistant that helps with...' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Add error handling' }],
          },
        }),
      ].join('\n')

      const meta = parseCodexSessionContent(content)

      expect(meta.title).toBe('Add error handling')
    })

    it('skips pasted shell output "$ command"', () => {
      const content = [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'session-7', cwd: '/project' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '$ git status\nOn branch main' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'The build is failing' }],
          },
        }),
      ].join('\n')

      const meta = parseCodexSessionContent(content)

      expect(meta.title).toBe('The build is failing')
    })

    it('skips <user_instructions> tags', () => {
      const content = [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'session-8', cwd: '/project' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<user_instructions>\nAlways use TypeScript\n</user_instructions>' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Refactor the auth module' }],
          },
        }),
      ].join('\n')

      const meta = parseCodexSessionContent(content)

      expect(meta.title).toBe('Refactor the auth module')
    })

    it('returns no title when only system context exists', () => {
      const content = [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'session-9', cwd: '/project' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/project</cwd>\n</environment_context>' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '# AGENTS.md instructions\n\nFollow these rules...' }],
          },
        }),
      ].join('\n')

      const meta = parseCodexSessionContent(content)

      expect(meta.title).toBeUndefined()
    })

    it('extracts user request from IDE context messages', () => {
      const ideMessage = [
        '# Context from my IDE setup:',
        '',
        '## My codebase',
        'This is a React project...',
        '',
        '## My request for Codex:',
        'Fix the authentication bug in the login form',
      ].join('\n')

      const content = [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'session-10', cwd: '/project' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: ideMessage }],
          },
        }),
      ].join('\n')

      const meta = parseCodexSessionContent(content)

      expect(meta.title).toBe('Fix the authentication bug in the login form')
    })
  })
})
