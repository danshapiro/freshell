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

  it('parses nested token_count.info payload and keeps legacy token_count fallback', () => {
    const nestedLine = JSON.stringify({
      type: 'event_msg',
      session_id: 'session-1',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 120,
            output_tokens: 30,
            cached_input_tokens: 40,
            total_tokens: 190,
          },
          total_token_usage: {
            input_tokens: 30000,
            output_tokens: 20000,
            cached_input_tokens: 1200,
            total_tokens: 51200,
          },
          model_context_window: 200000,
        },
      },
    })

    const legacyLine = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        input: 5,
        output: 6,
        total: 11,
      },
    })

    const nestedEvents = codexProvider.parseEvent(nestedLine)
    const legacyEvents = codexProvider.parseEvent(legacyLine)

    expect(nestedEvents).toHaveLength(1)
    expect(nestedEvents[0]).toMatchObject({
      type: 'token.usage',
      tokens: { inputTokens: 120, outputTokens: 30, cachedTokens: 40 },
      tokenUsage: { input: 120, output: 30, total: 190 },
    })

    expect(legacyEvents).toHaveLength(1)
    expect(legacyEvents[0]).toMatchObject({
      type: 'token.usage',
      tokens: { inputTokens: 5, outputTokens: 6 },
      tokenUsage: { input: 5, output: 6, total: 11 },
    })
  })

  it('parses codex session metadata and uses current-context token usage (not cumulative totals)', () => {
    const explicitLimit = 90000
    const content = [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'session-token-meta',
          cwd: '/project/a',
          git: { branch: 'main', dirty: true },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 40200,
              output_tokens: 600,
              cached_input_tokens: 19944,
              total_tokens: 70744,
            },
            total_token_usage: {
              input_tokens: 67867071,
              output_tokens: 249291,
              cached_input_tokens: 63449600,
              total_tokens: 68359470,
            },
            model_context_window: 200000,
            model_auto_compact_token_limit: explicitLimit,
          },
        },
      }),
    ].join('\n')

    const meta = parseCodexSessionContent(content)

    expect(meta.gitBranch).toBe('main')
    expect(meta.isDirty).toBe(true)
    expect(meta.tokenUsage).toEqual({
      inputTokens: 40200,
      outputTokens: 600,
      cachedTokens: 19944,
      totalTokens: 70744,
      contextTokens: 70744,
      modelContextWindow: 200000,
      compactThresholdTokens: explicitLimit,
      compactPercent: Math.round((70744 / explicitLimit) * 100),
    })
  })

  it('does not double-count cached tokens when total_tokens is missing', () => {
    const explicitLimit = 180000
    const content = [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'session-missing-total',
          cwd: '/project/a',
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 100,
              output_tokens: 20,
              cached_input_tokens: 80,
              // total_tokens intentionally omitted
            },
            model_context_window: 200000,
            model_auto_compact_token_limit: explicitLimit,
          },
        },
      }),
    ].join('\n')

    const meta = parseCodexSessionContent(content)

    expect(meta.tokenUsage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 80,
      totalTokens: 120,
      contextTokens: 120,
      modelContextWindow: 200000,
      compactThresholdTokens: explicitLimit,
      compactPercent: Math.round((120 / explicitLimit) * 100),
    })
  })

  it('derives codex compact threshold from model_context_window when explicit limit is missing', () => {
    const content = [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'session-default-limit',
          cwd: '/project/a',
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 80000,
              output_tokens: 3284,
              cached_input_tokens: 80000,
              total_tokens: 163284,
            },
            model_context_window: 258400,
          },
        },
      }),
    ].join('\n')

    const meta = parseCodexSessionContent(content)
    const derivedLimit = Math.round(258400 * (90 / 95))

    expect(meta.tokenUsage).toEqual({
      inputTokens: 80000,
      outputTokens: 3284,
      cachedTokens: 80000,
      totalTokens: 163284,
      contextTokens: 163284,
      modelContextWindow: 258400,
      compactThresholdTokens: derivedLimit,
      compactPercent: Math.round((163284 / derivedLimit) * 100),
    })
  })

  it('computes compact percent against the derived compact threshold', () => {
    const contextWindow = 100000
    const derivedLimit = Math.round(contextWindow * (90 / 95))
    const points = [
      { totalTokens: 23440, expectedCompactPercent: Math.round((23440 / derivedLimit) * 100) },
      { totalTokens: 38400, expectedCompactPercent: Math.round((38400 / derivedLimit) * 100) },
      { totalTokens: 56000, expectedCompactPercent: Math.round((56000 / derivedLimit) * 100) },
    ]

    for (const point of points) {
      const content = [
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: `session-derived-limit-${point.totalTokens}`,
            cwd: '/project/a',
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: point.totalTokens,
                output_tokens: 0,
                cached_input_tokens: 0,
                total_tokens: point.totalTokens,
              },
              model_context_window: contextWindow,
            },
          },
        }),
      ].join('\n')

      const meta = parseCodexSessionContent(content)
      expect(meta.tokenUsage?.compactPercent).toBe(point.expectedCompactPercent)
      expect(meta.tokenUsage?.compactThresholdTokens).toBe(derivedLimit)
    }
  })

  it('prefers last_token_usage snapshot over cumulative total_usage_tokens when context window is missing', () => {
    const content = [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'session-cumulative',
          cwd: '/project/a',
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_usage_tokens: 83181483,
            last_token_usage: {
              input_tokens: 58073,
              cached_input_tokens: 55552,
              output_tokens: 624,
              reasoning_output_tokens: 172,
              total_tokens: 58697,
            },
            total_token_usage: {
              input_tokens: 82880676,
              cached_input_tokens: 77492992,
              output_tokens: 300807,
              reasoning_output_tokens: 163157,
              total_tokens: 83181483,
            },
          },
        },
      }),
    ].join('\n')

    const meta = parseCodexSessionContent(content)

    expect(meta.tokenUsage).toEqual({
      inputTokens: 58073,
      outputTokens: 624,
      cachedTokens: 55552,
      totalTokens: 58697,
      contextTokens: 58697,
      modelContextWindow: undefined,
      compactThresholdTokens: undefined,
      compactPercent: undefined,
    })
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

  describe('getSessionRoots()', () => {
    it('returns the sessions directory under homeDir', () => {
      const roots = codexProvider.getSessionRoots()
      expect(roots).toEqual([path.join(codexProvider.homeDir, 'sessions')])
    })
  })
})
