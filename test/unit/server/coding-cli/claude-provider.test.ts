import { describe, it, expect, afterEach, vi } from 'vitest'
import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { claudeProvider, parseSessionContent } from '../../../../server/coding-cli/providers/claude'
import { getClaudeHome } from '../../../../server/claude-home'
import { ClaudeSessionIndexer, applyOverride } from '../../../../server/claude-indexer'
import { looksLikePath } from '../../../../server/coding-cli/utils'

const VALID_CLAUDE_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'
const SESSION_A = '11111111-1111-1111-1111-111111111111'
const SESSION_B = '22222222-2222-2222-2222-222222222222'
const SESSION_C = '33333333-3333-3333-3333-333333333333'
const SESSION_D = '44444444-4444-4444-4444-444444444444'
const SESSION_EXISTING = '55555555-5555-5555-5555-555555555555'
const SESSION_NO_CWD = '66666666-6666-6666-6666-666666666666'
const SESSION_NEW = '77777777-7777-7777-7777-777777777777'
const SESSION_NEWEST = '88888888-8888-8888-8888-888888888888'
const SESSION_OLDEST = '99999999-9999-9999-9999-999999999999'
const SESSION_MIDDLE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const SESSION_REAPPEAR = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

describe('claudeProvider.resolveProjectPath()', () => {
  it('returns cwd from session metadata (like Codex)', async () => {
    const meta = { cwd: '/home/user/my-project' }
    const result = await claudeProvider.resolveProjectPath('/some/file.jsonl', meta)
    expect(result).toBe('/home/user/my-project')
  })

  it('returns "unknown" when cwd is not present', async () => {
    const meta = {}
    const result = await claudeProvider.resolveProjectPath('/some/file.jsonl', meta)
    expect(result).toBe('unknown')
  })

})

describe('claudeProvider.getStreamArgs()', () => {
  it('includes --resume when resumeSessionId is a valid UUID', () => {
    const args = claudeProvider.getStreamArgs({ prompt: 'hi', resumeSessionId: VALID_CLAUDE_SESSION_ID })
    expect(args).toContain('--resume')
    expect(args).toContain(VALID_CLAUDE_SESSION_ID)
  })

  it('omits --resume when resumeSessionId is invalid', () => {
    const args = claudeProvider.getStreamArgs({ prompt: 'hi', resumeSessionId: 'not-a-uuid' })
    expect(args).not.toContain('--resume')
  })
})

describe('parseSessionContent() - token usage snapshots', () => {
  const originalAutocompactOverride = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE

  afterEach(() => {
    if (originalAutocompactOverride === undefined) {
      delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
    } else {
      process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = originalAutocompactOverride
    }
  })

  it('uses latest assistant usage snapshot with uuid -> message.id -> line-hash dedupe priority', () => {
    const content = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'uuid-a',
        message: {
          role: 'assistant',
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 0,
          },
        },
      }),
      // Duplicate by uuid (must be ignored)
      JSON.stringify({
        type: 'assistant',
        uuid: 'uuid-a',
        message: {
          role: 'assistant',
          usage: {
            input_tokens: 99,
            output_tokens: 99,
            cache_read_input_tokens: 99,
            cache_creation_input_tokens: 99,
          },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'message-b',
          role: 'assistant',
          usage: {
            input_tokens: 6,
            output_tokens: 3,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 4,
          },
        },
      }),
      // Duplicate by message.id (must be ignored)
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'message-b',
          role: 'assistant',
          usage: {
            input_tokens: 77,
            output_tokens: 77,
            cache_read_input_tokens: 77,
            cache_creation_input_tokens: 77,
          },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          usage: {
            input_tokens: 4,
            output_tokens: 2,
            cache_read_input_tokens: 1,
            cache_creation_input_tokens: 2,
          },
        },
      }),
      // Duplicate with no uuid/message.id (line hash fallback must dedupe)
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          usage: {
            input_tokens: 4,
            output_tokens: 2,
            cache_read_input_tokens: 1,
            cache_creation_input_tokens: 2,
          },
        },
      }),
    ].join('\n')

    const meta = parseSessionContent(content)

    expect(meta.tokenUsage).toEqual({
      inputTokens: 4,
      outputTokens: 2,
      cachedTokens: 3,
      totalTokens: 9,
      contextTokens: 9,
      modelContextWindow: 200000,
      compactThresholdTokens: 190000,
      compactPercent: 0,
    })
  })

  it('caps CLAUDE_AUTOCOMPACT_PCT_OVERRIDE above default threshold', () => {
    process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '99'

    const content = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'uuid-threshold',
        message: {
          role: 'assistant',
          usage: {
            input_tokens: 100000,
            output_tokens: 90000,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }),
    ].join('\n')

    const meta = parseSessionContent(content)

    expect(meta.tokenUsage?.compactThresholdTokens).toBe(190000)
    expect(meta.tokenUsage?.compactPercent).toBe(100)
  })

  it('supports compact-threshold overrides sourced outside session JSON (e.g. debug logs)', () => {
    const content = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'uuid-debug-threshold',
        message: {
          role: 'assistant',
          usage: {
            input_tokens: 1,
            output_tokens: 8,
            cache_read_input_tokens: 49961,
            cache_creation_input_tokens: 4444,
          },
        },
      }),
    ].join('\n')

    const meta = parseSessionContent(content, { compactThresholdTokens: 167000 })
    expect(meta.tokenUsage?.contextTokens).toBe(54414)
    expect(meta.tokenUsage?.compactThresholdTokens).toBe(167000)
    expect(meta.tokenUsage?.compactPercent).toBe(Math.round((54414 / 167000) * 100))
  })

  it('supports context-token overrides sourced outside session JSON (e.g. debug logs)', () => {
    const content = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'uuid-debug-context',
        message: {
          role: 'assistant',
          usage: {
            input_tokens: 1,
            output_tokens: 8,
            cache_read_input_tokens: 49961,
            cache_creation_input_tokens: 4444,
          },
        },
      }),
    ].join('\n')

    const meta = parseSessionContent(content, {
      compactThresholdTokens: 167000,
      contextTokens: 55880,
    })

    expect(meta.tokenUsage?.inputTokens).toBe(1)
    expect(meta.tokenUsage?.outputTokens).toBe(8)
    expect(meta.tokenUsage?.cachedTokens).toBe(54405)
    expect(meta.tokenUsage?.totalTokens).toBe(55880)
    expect(meta.tokenUsage?.contextTokens).toBe(55880)
    expect(meta.tokenUsage?.compactThresholdTokens).toBe(167000)
    expect(meta.tokenUsage?.compactPercent).toBe(Math.round((55880 / 167000) * 100))
  })

  it('reads compact threshold from Claude debug logs when parsing session files', async () => {
    const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-claude-debug-'))
    const sessionId = SESSION_A
    const debugDir = path.join(homeDir, 'debug')
    const debugFile = path.join(debugDir, `${sessionId}.txt`)
    await fsp.mkdir(debugDir, { recursive: true })
    await fsp.writeFile(
      debugFile,
      [
        'autocompact: tokens=120000 threshold=160000 effectiveWindow=180000',
        'autocompact: tokens=55880 threshold=167000 effectiveWindow=180000',
      ].join('\n'),
      'utf8',
    )
    // Ensure the last autocompact line can fall outside of the cheapest tail read.
    // Claude debug logs are noisy and can grow large without additional autocompact entries.
    await fsp.appendFile(debugFile, `\n${'x'.repeat(200_000)}`, 'utf8')

    const originalHomeDir = (claudeProvider as any).homeDir
    ;(claudeProvider as any).homeDir = homeDir
    try {
      const content = [
        JSON.stringify({
          type: 'assistant',
          uuid: 'uuid-session-file-threshold',
          message: {
            role: 'assistant',
            usage: {
              input_tokens: 1,
              output_tokens: 8,
              cache_read_input_tokens: 49961,
              cache_creation_input_tokens: 4444,
            },
          },
        }),
      ].join('\n')

      const meta = await claudeProvider.parseSessionFile(
        content,
        path.join(homeDir, 'projects', 'project-a', `${sessionId}.jsonl`),
      )

      expect(meta.tokenUsage?.contextTokens).toBe(55880)
      expect(meta.tokenUsage?.compactThresholdTokens).toBe(167000)
      expect(meta.tokenUsage?.compactPercent).toBe(Math.round((55880 / 167000) * 100))

      // Debug files are updated during an active session; ensure we re-read when they change
      // so token counts don't freeze and drift.
      await fsp.appendFile(
        debugFile,
        '\nautocompact: tokens=60000 threshold=170000 effectiveWindow=180000',
        'utf8',
      )

      const refreshed = await claudeProvider.parseSessionFile(
        content,
        path.join(homeDir, 'projects', 'project-a', `${sessionId}.jsonl`),
      )

      expect(refreshed.tokenUsage?.contextTokens).toBe(60000)
      expect(refreshed.tokenUsage?.compactThresholdTokens).toBe(170000)
      expect(refreshed.tokenUsage?.compactPercent).toBe(Math.round((60000 / 170000) * 100))
    } finally {
      ;(claudeProvider as any).homeDir = originalHomeDir
      await fsp.rm(homeDir, { recursive: true, force: true })
    }
  })
})

describe('claude provider cross-platform tests', () => {
  describe('getClaudeHome()', () => {
    const originalEnv = process.env.CLAUDE_HOME

    afterEach(() => {
      // Restore original environment
      if (originalEnv === undefined) {
        delete process.env.CLAUDE_HOME
      } else {
        process.env.CLAUDE_HOME = originalEnv
      }
    })

    it('should respect CLAUDE_HOME environment variable when set', () => {
      process.env.CLAUDE_HOME = '/custom/claude/home'
      expect(getClaudeHome()).toBe('/custom/claude/home')
    })

    it('should respect Windows CLAUDE_HOME path', () => {
      process.env.CLAUDE_HOME = 'C:\\Users\\Test\\.claude'
      expect(getClaudeHome()).toBe('C:\\Users\\Test\\.claude')
    })

    it('should respect UNC path for CLAUDE_HOME (WSL access)', () => {
      process.env.CLAUDE_HOME = '\\\\wsl$\\Ubuntu\\home\\user\\.claude'
      expect(getClaudeHome()).toBe('\\\\wsl$\\Ubuntu\\home\\user\\.claude')
    })

    it('should fall back to os.homedir()/.claude when CLAUDE_HOME not set', () => {
      delete process.env.CLAUDE_HOME
      const expected = path.join(os.homedir(), '.claude')
      expect(getClaudeHome()).toBe(expected)
    })

    it('should return a string that ends with .claude when using default', () => {
      delete process.env.CLAUDE_HOME
      const result = getClaudeHome()
      expect(result.endsWith('.claude')).toBe(true)
    })

    it('should return an absolute path when using default', () => {
      delete process.env.CLAUDE_HOME
      const result = getClaudeHome()
      // On Windows, absolute paths start with drive letter; on Unix, with /
      const isAbsolute = path.isAbsolute(result)
      expect(isAbsolute).toBe(true)
    })
  })

  describe('claudeProvider.parseEvent()', () => {
    it('does not include raw payload in normalized events', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        session_id: 's1',
      })

      const events = claudeProvider.parseEvent(line)

      expect(events).toHaveLength(1)
      expect('raw' in events[0]).toBe(false)
    })
  })

  describe('looksLikePath()', () => {
    describe('Unix paths', () => {
      it('should recognize absolute Unix paths', () => {
        expect(looksLikePath('/home/user')).toBe(true)
        expect(looksLikePath('/usr/local/bin')).toBe(true)
        expect(looksLikePath('/var/log/app.log')).toBe(true)
        expect(looksLikePath('/')).toBe(true)
      })

      it('should recognize home directory paths with tilde', () => {
        expect(looksLikePath('~/projects')).toBe(true)
        expect(looksLikePath('~/.config')).toBe(true)
        expect(looksLikePath('~/Documents/file.txt')).toBe(true)
      })

      it('should recognize relative paths', () => {
        expect(looksLikePath('./relative')).toBe(true)
        expect(looksLikePath('../parent')).toBe(true)
        expect(looksLikePath('./src/index.ts')).toBe(true)
        expect(looksLikePath('../../../up/three/levels')).toBe(true)
      })
    })

    describe('Windows paths', () => {
      it('should recognize Windows drive letter paths', () => {
        expect(looksLikePath('C:\\')).toBe(true)
        expect(looksLikePath('C:\\Users')).toBe(true)
        expect(looksLikePath('D:\\Projects')).toBe(true)
        expect(looksLikePath('C:\\Users\\Dan\\Documents')).toBe(true)
      })

      it('should recognize Windows paths with forward slashes', () => {
        expect(looksLikePath('C:/Users')).toBe(true)
        expect(looksLikePath('D:/Projects/app')).toBe(true)
      })

      it('should recognize UNC paths (network shares)', () => {
        expect(looksLikePath('\\\\server\\share')).toBe(true)
        expect(looksLikePath('\\\\192.168.1.1\\folder')).toBe(true)
        expect(looksLikePath('\\\\wsl$\\Ubuntu\\home')).toBe(true)
      })

      it('should recognize Windows relative paths', () => {
        expect(looksLikePath('.\\relative')).toBe(true)
        expect(looksLikePath('..\\parent')).toBe(true)
        expect(looksLikePath('.\\src\\index.ts')).toBe(true)
      })
    })

    describe('non-paths (should return false)', () => {
      it('should reject plain strings without path separators', () => {
        expect(looksLikePath('hello')).toBe(false)
        expect(looksLikePath('project-name')).toBe(false)
        expect(looksLikePath('MyApp')).toBe(false)
        expect(looksLikePath('')).toBe(false)
      })

      it('should reject URLs', () => {
        expect(looksLikePath('https://example.com')).toBe(false)
        expect(looksLikePath('http://localhost:3000')).toBe(false)
        expect(looksLikePath('https://github.com/user/repo')).toBe(false)
        expect(looksLikePath('ftp://files.example.com/doc')).toBe(false)
        expect(looksLikePath('file://localhost/path')).toBe(false)
      })

      it('should reject email addresses', () => {
        // Email addresses don't have slashes typically, but just to be safe
        expect(looksLikePath('user@example.com')).toBe(false)
      })

      it('should reject strings that look like paths but are protocol-based', () => {
        expect(looksLikePath('s3://bucket/key')).toBe(false)
        expect(looksLikePath('gs://bucket/object')).toBe(false)
        expect(looksLikePath('ssh://user@host/path')).toBe(false)
      })
    })

    describe('edge cases', () => {
      it('should handle paths with spaces', () => {
        expect(looksLikePath('/home/user/My Documents')).toBe(true)
        expect(looksLikePath('C:\\Users\\Dan\\My Documents')).toBe(true)
        expect(looksLikePath('/path/with spaces/file name.txt')).toBe(true)
      })

      it('should handle paths with special characters', () => {
        expect(looksLikePath('/path/with-dashes/file_underscore.ts')).toBe(true)
        expect(looksLikePath('/path/with.dots/file.name.ext')).toBe(true)
        expect(looksLikePath("C:\\path\\with'quotes")).toBe(true)
        expect(looksLikePath('/path/with(parens)/file')).toBe(true)
      })

      it('should handle paths with unicode characters', () => {
        expect(looksLikePath('/home/用户/文档')).toBe(true)
        expect(looksLikePath('C:\\Users\\José\\Documents')).toBe(true)
      })

      it('should handle root-only paths', () => {
        expect(looksLikePath('/')).toBe(true)
        expect(looksLikePath('C:\\')).toBe(true)
      })

      it('should handle tilde alone (home directory)', () => {
        // Just tilde by itself should be considered a path as it refers to home directory
        expect(looksLikePath('~')).toBe(true)
      })

      it('should handle dot alone (current directory)', () => {
        // Single dot is the current directory
        expect(looksLikePath('.')).toBe(true)
      })

      it('should handle double dot alone (parent directory)', () => {
        // Double dot is parent directory
        expect(looksLikePath('..')).toBe(true)
      })
    })
  })

  describe('parseSessionContent() - line ending handling', () => {
    describe('LF line endings (Unix)', () => {
      it('should parse content with LF line endings', () => {
        const content = [
          '{"cwd": "/home/user/project"}',
          '{"role": "user", "content": "Hello"}',
          '{"role": "assistant", "content": "Hi there"}',
        ].join('\n')

        const meta = parseSessionContent(content)

        expect(meta.cwd).toBe('/home/user/project')
        expect(meta.title).toBe('Hello')
        expect(meta.messageCount).toBe(3)
      })

      it('should handle trailing LF', () => {
        const content = '{"cwd": "/test"}\n{"role": "user", "content": "Test"}\n'
        const meta = parseSessionContent(content)

        expect(meta.cwd).toBe('/test')
        expect(meta.messageCount).toBe(2)
      })
    })

    describe('CRLF line endings (Windows)', () => {
      it('should parse content with CRLF line endings', () => {
        const content = [
          '{"cwd": "C:\\\\Users\\\\Dan\\\\project"}',
          '{"role": "user", "content": "Hello from Windows"}',
          '{"role": "assistant", "content": "Hi there"}',
        ].join('\r\n')

        const meta = parseSessionContent(content)

        expect(meta.cwd).toBe('C:\\Users\\Dan\\project')
        expect(meta.title).toBe('Hello from Windows')
        expect(meta.messageCount).toBe(3)
      })

      it('should handle trailing CRLF', () => {
        const content = '{"cwd": "/test"}\r\n{"role": "user", "content": "Test"}\r\n'
        const meta = parseSessionContent(content)

        expect(meta.cwd).toBe('/test')
        expect(meta.messageCount).toBe(2)
      })
    })

    describe('mixed line endings', () => {
      it('should handle mixed LF and CRLF in same content', () => {
        const content =
          '{"cwd": "/project"}\n' +
          '{"role": "user", "content": "Line with LF"}\r\n' +
          '{"role": "assistant", "content": "Line with CRLF"}\n'

        const meta = parseSessionContent(content)

        expect(meta.cwd).toBe('/project')
        expect(meta.title).toBe('Line with LF')
        expect(meta.messageCount).toBe(3)
      })
    })

    describe('empty and whitespace content', () => {
      it('should handle empty string', () => {
        const meta = parseSessionContent('')

        expect(meta.cwd).toBeUndefined()
        expect(meta.title).toBeUndefined()
        expect(meta.messageCount).toBe(0)
      })

      it('should handle content with only newlines', () => {
        const meta = parseSessionContent('\n\r\n\n')

        expect(meta.messageCount).toBe(0)
      })

      it('should filter out empty lines from count', () => {
        const content = '{"cwd": "/test"}\n\n\n{"role": "user", "content": "Hi"}\n'
        const meta = parseSessionContent(content)

        // Empty lines should be filtered by Boolean
        expect(meta.messageCount).toBe(2)
      })
    })
  })

  describe('parseSessionContent() - path format extraction', () => {
    it('should extract Unix cwd from session data', () => {
      const content = '{"cwd": "/home/user/my-project"}\n'
      const meta = parseSessionContent(content)
      expect(meta.cwd).toBe('/home/user/my-project')
    })

    it('should extract Windows cwd from session data', () => {
      const content = '{"cwd": "C:\\\\Users\\\\Dan\\\\Projects\\\\app"}\n'
      const meta = parseSessionContent(content)
      expect(meta.cwd).toBe('C:\\Users\\Dan\\Projects\\app')
    })

    it('should extract UNC path cwd from session data', () => {
      const content = '{"cwd": "\\\\\\\\wsl$\\\\Ubuntu\\\\home\\\\user"}\n'
      const meta = parseSessionContent(content)
      expect(meta.cwd).toBe('\\\\wsl$\\Ubuntu\\home\\user')
    })

    it('should extract cwd from nested context object', () => {
      const content = '{"context": {"cwd": "/nested/path"}}\n'
      const meta = parseSessionContent(content)
      expect(meta.cwd).toBe('/nested/path')
    })

    it('should extract cwd from payload object', () => {
      const content = '{"payload": {"cwd": "D:\\\\Work\\\\Project"}}\n'
      const meta = parseSessionContent(content)
      expect(meta.cwd).toBe('D:\\Work\\Project')
    })

    it('should extract cwd from data object', () => {
      const content = '{"data": {"cwd": "/data/cwd/path"}}\n'
      const meta = parseSessionContent(content)
      expect(meta.cwd).toBe('/data/cwd/path')
    })

    it('should extract cwd from message object', () => {
      const content = '{"message": {"cwd": "/message/cwd/path"}}\n'
      const meta = parseSessionContent(content)
      expect(meta.cwd).toBe('/message/cwd/path')
    })

    it('should prefer first valid cwd found', () => {
      const content = ['{"cwd": "/first/path"}', '{"cwd": "/second/path"}'].join('\n')
      const meta = parseSessionContent(content)
      expect(meta.cwd).toBe('/first/path')
    })
  })

  describe('parseSessionContent() - title extraction', () => {
    it('should extract title from user message content', () => {
      const content = '{"role": "user", "content": "Implement a new feature"}\n'
      const meta = parseSessionContent(content)
      expect(meta.title).toBe('Implement a new feature')
    })

    it('should extract title from nested message object', () => {
      const content = '{"message": {"role": "user", "content": "Fix the bug"}}\n'
      const meta = parseSessionContent(content)
      expect(meta.title).toBe('Fix the bug')
    })

    it('should extract title from explicit title field', () => {
      const content = '{"title": "My Session Title"}\n'
      const meta = parseSessionContent(content)
      expect(meta.title).toBe('My Session Title')
    })

    it('should extract title from sessionTitle field', () => {
      const content = '{"sessionTitle": "Another Title"}\n'
      const meta = parseSessionContent(content)
      expect(meta.title).toBe('Another Title')
    })

    it('should truncate long titles to 200 characters', () => {
      const longMessage = 'A'.repeat(250)
      const content = `{"role": "user", "content": "${longMessage}"}\n`
      const meta = parseSessionContent(content)
      expect(meta.title?.length).toBe(200)
      expect(meta.title).toBe('A'.repeat(200))
    })

    it('should normalize whitespace in titles', () => {
      const content = '{"role": "user", "content": "  Multiple   spaces   here  "}\n'
      const meta = parseSessionContent(content)
      expect(meta.title).toBe('Multiple spaces here')
    })

    it('should not extract title from assistant messages', () => {
      const content = '{"role": "assistant", "content": "This is a response"}\n'
      const meta = parseSessionContent(content)
      expect(meta.title).toBeUndefined()
    })
  })

  describe('parseSessionContent() - summary extraction', () => {
    it('should extract summary when present', () => {
      const content = '{"summary": "This is a session summary"}\n'
      const meta = parseSessionContent(content)
      expect(meta.summary).toBe('This is a session summary')
    })

    it('should extract summary from sessionSummary field', () => {
      const content = '{"sessionSummary": "Alternative summary field"}\n'
      const meta = parseSessionContent(content)
      expect(meta.summary).toBe('Alternative summary field')
    })

    it('should truncate long summaries to 240 characters', () => {
      const longSummary = 'B'.repeat(300)
      const content = `{"summary": "${longSummary}"}\n`
      const meta = parseSessionContent(content)
      expect(meta.summary?.length).toBe(240)
    })
  })

  describe('parseSessionContent() - malformed content handling', () => {
    it('should handle malformed JSON lines gracefully', () => {
      const content = 'not valid json\n{"cwd": "/valid/path"}\n'
      const meta = parseSessionContent(content)
      expect(meta.cwd).toBe('/valid/path')
      // Malformed line is still counted because it's non-empty
      expect(meta.messageCount).toBe(2)
    })

    it('should handle completely invalid JSON content', () => {
      const content = 'just plain text\nno json here\n'
      const meta = parseSessionContent(content)
      expect(meta.cwd).toBeUndefined()
      expect(meta.title).toBeUndefined()
      expect(meta.summary).toBeUndefined()
      expect(meta.messageCount).toBe(2)
    })

    it('should handle partial JSON objects', () => {
      const content = '{"incomplete": true\n{"cwd": "/works"}\n'
      const meta = parseSessionContent(content)
      expect(meta.cwd).toBe('/works')
    })
  })

  describe('parseSessionContent() - title extraction skips system context', () => {
    it('skips subagent mode instructions like [SUGGESTION MODE: ...]', () => {
      const content = [
        '{"cwd": "/project"}',
        '{"type": "user", "message": {"role": "user", "content": "[SUGGESTION MODE: Suggest what the user might naturally type next...] FIRST: Look at the user\'s recent messages."}}',
        '{"type": "user", "message": {"role": "user", "content": "Fix the login bug"}}',
      ].join('\n')

      const meta = parseSessionContent(content)

      expect(meta.title).toBe('Fix the login bug')
    })

    it('skips messages starting with bracketed uppercase mode tags', () => {
      const content = [
        '{"cwd": "/project"}',
        '{"role": "user", "content": "[REVIEW MODE: You are reviewing code...] Check for bugs."}',
        '{"role": "user", "content": "Review the auth module"}',
      ].join('\n')

      const meta = parseSessionContent(content)

      expect(meta.title).toBe('Review the auth module')
    })

    it('skips AGENTS.md instruction messages', () => {
      const content = [
        '{"cwd": "/project"}',
        '{"role": "user", "content": "# AGENTS.md instructions\\n\\nFollow these rules..."}',
        '{"role": "user", "content": "Build the feature"}',
      ].join('\n')

      const meta = parseSessionContent(content)

      expect(meta.title).toBe('Build the feature')
    })

    it('skips XML-wrapped system context', () => {
      const content = [
        '{"cwd": "/project"}',
        '{"role": "user", "content": "<system_context>\\nYou are an assistant...\\n</system_context>"}',
        '{"role": "user", "content": "Help me debug this"}',
      ].join('\n')

      const meta = parseSessionContent(content)

      expect(meta.title).toBe('Help me debug this')
    })

    it('uses first user message if none are system context', () => {
      const content = [
        '{"cwd": "/project"}',
        '{"role": "user", "content": "Hello, I need help"}',
      ].join('\n')

      const meta = parseSessionContent(content)

      expect(meta.title).toBe('Hello, I need help')
    })

    it('skips pasted log/debug output (digit+comma)', () => {
      const content = [
        '{"cwd": "/project"}',
        '{"role": "user", "content": "0, totalJsHeapSize: 12345678, usedJsHeapSize: 9876543"}',
        '{"role": "user", "content": "Why is memory usage so high?"}',
      ].join('\n')

      const meta = parseSessionContent(content)

      expect(meta.title).toBe('Why is memory usage so high?')
    })

    it('skips agent boilerplate "You are an automated..."', () => {
      const content = [
        '{"cwd": "/project"}',
        '{"role": "user", "content": "You are an automated coding assistant that helps with..."}',
        '{"role": "user", "content": "Add error handling to the API"}',
      ].join('\n')

      const meta = parseSessionContent(content)

      expect(meta.title).toBe('Add error handling to the API')
    })

    it('skips pasted shell output "> command"', () => {
      const content = [
        '{"cwd": "/project"}',
        '{"role": "user", "content": "> npm run build\\n\\nadded 42 packages"}',
        '{"role": "user", "content": "The build is failing, help me fix it"}',
      ].join('\n')

      const meta = parseSessionContent(content)

      expect(meta.title).toBe('The build is failing, help me fix it')
    })

    it('skips <user_instructions> tags', () => {
      const content = [
        '{"cwd": "/project"}',
        '{"role": "user", "content": "<user_instructions>\\nAlways use TypeScript\\n</user_instructions>"}',
        '{"role": "user", "content": "Refactor the auth module"}',
      ].join('\n')

      const meta = parseSessionContent(content)

      expect(meta.title).toBe('Refactor the auth module')
    })

    it('returns no title when only system context exists', () => {
      const content = [
        '{"cwd": "/project"}',
        '{"role": "user", "content": "<environment_context>\\n  <cwd>/project</cwd>\\n</environment_context>"}',
        '{"role": "user", "content": "# AGENTS.md instructions\\n\\nFollow these rules..."}',
      ].join('\n')

      const meta = parseSessionContent(content)

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
      ].join('\\n')

      const content = [
        '{"cwd": "/project"}',
        `{"role": "user", "content": "${ideMessage}"}`,
      ].join('\n')

      const meta = parseSessionContent(content)

      expect(meta.title).toBe('Fix the authentication bug in the login form')
    })
  })

  describe('parseSessionContent() - orphaned sessions (snapshot-only)', () => {
    it('should return undefined cwd for sessions with only file-history-snapshot events', () => {
      const orphanedContent = `{"type":"file-history-snapshot","messageId":"abc123","snapshot":{"messageId":"abc123","trackedFileBackups":{},"timestamp":"2026-01-29T04:37:54.888Z"},"isSnapshotUpdate":false}`

      const meta = parseSessionContent(orphanedContent)

      expect(meta.cwd).toBeUndefined()
      expect(meta.title).toBeUndefined()
    })

    it('should return undefined cwd for sessions with multiple snapshot events but no conversation', () => {
      const orphanedContent = [
        '{"type":"file-history-snapshot","messageId":"a","snapshot":{"messageId":"a","trackedFileBackups":{},"timestamp":"2026-01-29T04:28:46.115Z"},"isSnapshotUpdate":false}',
        '{"type":"file-history-snapshot","messageId":"b","snapshot":{"messageId":"b","trackedFileBackups":{},"timestamp":"2026-01-29T04:36:00.396Z"},"isSnapshotUpdate":false}',
        '{"type":"file-history-snapshot","messageId":"c","snapshot":{"messageId":"c","trackedFileBackups":{},"timestamp":"2026-01-29T04:39:25.400Z"},"isSnapshotUpdate":false}',
      ].join('\n')

      const meta = parseSessionContent(orphanedContent)

      expect(meta.cwd).toBeUndefined()
      expect(meta.messageCount).toBe(3)
    })
  })

  describe('parseSessionContent() - real sessions (with conversation)', () => {
    it('extracts a valid sessionId from content', () => {
      const realContent = [
        `{"cwd":"/home/user/project","sessionId":"${VALID_CLAUDE_SESSION_ID}","type":"user","message":{"role":"user","content":"hello"}}`,
      ].join('\n')

      const meta = parseSessionContent(realContent)

      expect(meta.sessionId).toBe(VALID_CLAUDE_SESSION_ID)
    })

    it('ignores invalid sessionId values', () => {
      const realContent = [
        '{"cwd":"/home/user/project","sessionId":"not-a-uuid","type":"user","message":{"role":"user","content":"hello"}}',
      ].join('\n')

      const meta = parseSessionContent(realContent)

      expect(meta.sessionId).toBeUndefined()
    })

    it('should extract cwd from session with conversation events', () => {
      const realContent = [
        '{"type":"file-history-snapshot","messageId":"abc","snapshot":{}}',
        '{"cwd":"D:\\\\Users\\\\Dan\\\\project","sessionId":"abc123","type":"user","message":{"role":"user","content":"hello"}}',
      ].join('\n')

      const meta = parseSessionContent(realContent)

      expect(meta.cwd).toBe('D:\\Users\\Dan\\project')
    })

    it('should extract title from first user message', () => {
      const realContent = [
        '{"type":"file-history-snapshot","messageId":"abc","snapshot":{}}',
        '{"cwd":"/home/user/project","type":"user","message":{"role":"user","content":"Fix the login bug"}}',
      ].join('\n')

      const meta = parseSessionContent(realContent)

      expect(meta.cwd).toBe('/home/user/project')
      expect(meta.title).toBe('Fix the login bug')
    })
  })
})

describe('ClaudeSessionIndexer new session detection', () => {
  it('should call onNewSession handler only for newly discovered sessions after initialization', async () => {
    const indexer = new ClaudeSessionIndexer()
    const newSessionHandler = vi.fn()

    indexer.onNewSession(newSessionHandler)

    // Simulate indexer has been initialized (start() completed)
    indexer['initialized'] = true

    // Add session A to known set (simulating it was seen before)
    indexer['knownSessionIds'].add(SESSION_A)

    // Simulate detecting sessions A and B
    const sessions: ClaudeSession[] = [
      { sessionId: SESSION_A, projectPath: '/proj', updatedAt: Date.now(), cwd: '/proj' },
      { sessionId: SESSION_B, projectPath: '/proj', updatedAt: Date.now(), cwd: '/proj' },
    ]

    indexer['detectNewSessions'](sessions)

    expect(newSessionHandler).toHaveBeenCalledTimes(1)
    expect(newSessionHandler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SESSION_B }))
  })

  it('should not call handlers before initialization (startup scenario)', () => {
    const indexer = new ClaudeSessionIndexer()
    const handler = vi.fn()

    indexer.onNewSession(handler)

    // initialized is false by default (before start() completes)
    // Simulate first refresh detecting existing sessions
    indexer['detectNewSessions']([
      { sessionId: SESSION_EXISTING, projectPath: '/proj', updatedAt: Date.now(), cwd: '/proj' },
    ])

    // Handler should NOT fire - we're still initializing
    expect(handler).not.toHaveBeenCalled()
    // But session should be tracked
    expect(indexer['knownSessionIds'].has(SESSION_EXISTING)).toBe(true)
  })

  it('should skip sessions without cwd', () => {
    const indexer = new ClaudeSessionIndexer()
    const handler = vi.fn()

    indexer.onNewSession(handler)
    indexer['initialized'] = true

    indexer['detectNewSessions']([
      { sessionId: SESSION_NO_CWD, projectPath: '/proj', updatedAt: Date.now(), cwd: undefined },
    ])

    expect(handler).not.toHaveBeenCalled()
  })

  it('should unsubscribe handler when returned function is called', () => {
    const indexer = new ClaudeSessionIndexer()
    const handler = vi.fn()

    const unsubscribe = indexer.onNewSession(handler)
    unsubscribe()
    indexer['initialized'] = true

    indexer['detectNewSessions']([
      { sessionId: SESSION_NEW, projectPath: '/proj', updatedAt: Date.now(), cwd: '/proj' },
    ])

    expect(handler).not.toHaveBeenCalled()
  })

  it('should prune stale session IDs from knownSessionIds (memory leak prevention)', () => {
    const indexer = new ClaudeSessionIndexer()
    indexer['initialized'] = true

    // First detection adds sessions A, B, C
    indexer['detectNewSessions']([
      { sessionId: SESSION_A, projectPath: '/proj', updatedAt: Date.now(), cwd: '/proj' },
      { sessionId: SESSION_B, projectPath: '/proj', updatedAt: Date.now(), cwd: '/proj' },
      { sessionId: SESSION_C, projectPath: '/proj', updatedAt: Date.now(), cwd: '/proj' },
    ])

    expect(indexer['knownSessionIds'].size).toBe(3)
    expect(indexer['knownSessionIds'].has(SESSION_A)).toBe(true)
    expect(indexer['knownSessionIds'].has(SESSION_B)).toBe(true)
    expect(indexer['knownSessionIds'].has(SESSION_C)).toBe(true)

    // Second detection: B was deleted, D was added
    indexer['detectNewSessions']([
      { sessionId: SESSION_A, projectPath: '/proj', updatedAt: Date.now(), cwd: '/proj' },
      { sessionId: SESSION_C, projectPath: '/proj', updatedAt: Date.now(), cwd: '/proj' },
      { sessionId: SESSION_D, projectPath: '/proj', updatedAt: Date.now(), cwd: '/proj' },
    ])

    // B should be pruned, D should be added
    expect(indexer['knownSessionIds'].size).toBe(3)
    expect(indexer['knownSessionIds'].has(SESSION_A)).toBe(true)
    expect(indexer['knownSessionIds'].has(SESSION_B)).toBe(false) // Pruned
    expect(indexer['knownSessionIds'].has(SESSION_C)).toBe(true)
    expect(indexer['knownSessionIds'].has(SESSION_D)).toBe(true) // Added
  })

  it('should call handlers in oldest-first order when multiple new sessions are detected', () => {
    const indexer = new ClaudeSessionIndexer()
    const calls: string[] = []
    indexer.onNewSession((session) => calls.push(session.sessionId))
    indexer['initialized'] = true

    indexer['detectNewSessions']([
      { sessionId: SESSION_NEWEST, projectPath: '/proj', updatedAt: 200, cwd: '/proj' },
      { sessionId: SESSION_OLDEST, projectPath: '/proj', updatedAt: 100, cwd: '/proj' },
      { sessionId: SESSION_MIDDLE, projectPath: '/proj', updatedAt: 150, cwd: '/proj' },
    ])

    expect(calls).toEqual([SESSION_OLDEST, SESSION_MIDDLE, SESSION_NEWEST])
  })

  it('should not fire handlers for sessions that reappear after being seen', () => {
    const indexer = new ClaudeSessionIndexer()
    const handler = vi.fn()
    indexer.onNewSession(handler)
    indexer['initialized'] = true

    // First appearance - should fire
    indexer['detectNewSessions']([
      { sessionId: SESSION_REAPPEAR, projectPath: '/proj', updatedAt: 100, cwd: '/proj' },
    ])
    expect(handler).toHaveBeenCalledTimes(1)

    // Simulate session removed (known list pruned)
    indexer['detectNewSessions']([])

    // Reappearance with same sessionId should NOT fire again
    indexer['detectNewSessions']([
      { sessionId: SESSION_REAPPEAR, projectPath: '/proj', updatedAt: 200, cwd: '/proj' },
    ])

    expect(handler).toHaveBeenCalledTimes(1)
  })

  describe('applyOverride()', () => {
    it('returns null when override marks deleted', () => {
      const session: ClaudeSession = {
        sessionId: 's1',
        projectPath: '/proj',
        createdAt: 100,
        updatedAt: 200,
      }

      expect(applyOverride(session, { deleted: true })).toBeNull()
    })

    it('applies title/summary/archived and createdAt overrides', () => {
      const session: ClaudeSession = {
        sessionId: 's1',
        projectPath: '/proj',
        createdAt: 100,
        updatedAt: 200,
        title: 'Original',
        summary: 'Summary',
        archived: false,
      }

      const merged = applyOverride(session, {
        titleOverride: 'New title',
        summaryOverride: 'New summary',
        archived: true,
        createdAtOverride: 999,
      })

      expect(merged?.title).toBe('New title')
      expect(merged?.summary).toBe('New summary')
      expect(merged?.archived).toBe(true)
      expect(merged?.createdAt).toBe(999)
    })
  })
})
