import { describe, it, expect, afterEach, vi } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import { claudeProvider, defaultClaudeHome, parseSessionContent } from '../../../../server/coding-cli/providers/claude'
import { ClaudeSessionIndexer, applyOverride } from '../../../../server/claude-indexer'
import { looksLikePath } from '../../../../server/coding-cli/utils'

describe('claudeProvider.resolveProjectPath()', () => {
  it('memoizes project metadata lookups per directory', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-project-cache-'))
    const projectDir = path.join(tempDir, 'project-a')
    const projectPath = '/home/user/project-a'
    await fsp.mkdir(projectDir, { recursive: true })
    await fsp.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({ projectPath }))

    const readSpy = vi.spyOn(fsp, 'readFile')
    try {
      const first = await claudeProvider.resolveProjectPath(path.join(projectDir, 'session-a.jsonl'), {})
      const second = await claudeProvider.resolveProjectPath(path.join(projectDir, 'session-b.jsonl'), {})

      expect(first).toBe(projectPath)
      expect(second).toBe(projectPath)
      expect(readSpy).toHaveBeenCalledTimes(1)
    } finally {
      readSpy.mockRestore()
      await fsp.rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe('claude provider cross-platform tests', () => {
  describe('defaultClaudeHome()', () => {
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
      expect(defaultClaudeHome()).toBe('/custom/claude/home')
    })

    it('should respect Windows CLAUDE_HOME path', () => {
      process.env.CLAUDE_HOME = 'C:\\Users\\Test\\.claude'
      expect(defaultClaudeHome()).toBe('C:\\Users\\Test\\.claude')
    })

    it('should respect UNC path for CLAUDE_HOME (WSL access)', () => {
      process.env.CLAUDE_HOME = '\\\\wsl$\\Ubuntu\\home\\user\\.claude'
      expect(defaultClaudeHome()).toBe('\\\\wsl$\\Ubuntu\\home\\user\\.claude')
    })

    it('should fall back to os.homedir()/.claude when CLAUDE_HOME not set', () => {
      delete process.env.CLAUDE_HOME
      const expected = path.join(os.homedir(), '.claude')
      expect(defaultClaudeHome()).toBe(expected)
    })

    it('should return a string that ends with .claude when using default', () => {
      delete process.env.CLAUDE_HOME
      const result = defaultClaudeHome()
      expect(result.endsWith('.claude')).toBe(true)
    })

    it('should return an absolute path when using default', () => {
      delete process.env.CLAUDE_HOME
      const result = defaultClaudeHome()
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
    indexer['knownSessionIds'].add('session-a')

    // Simulate detecting sessions A and B
    const sessions: ClaudeSession[] = [
      { sessionId: 'session-a', projectPath: '/proj', updatedAt: Date.now(), cwd: '/proj' },
      { sessionId: 'session-b', projectPath: '/proj', updatedAt: Date.now(), cwd: '/proj' },
    ]

    indexer['detectNewSessions'](sessions)

    expect(newSessionHandler).toHaveBeenCalledTimes(1)
    expect(newSessionHandler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-b' }))
  })

  it('should not call handlers before initialization (startup scenario)', () => {
    const indexer = new ClaudeSessionIndexer()
    const handler = vi.fn()

    indexer.onNewSession(handler)

    // initialized is false by default (before start() completes)
    // Simulate first refresh detecting existing sessions
    indexer['detectNewSessions']([
      { sessionId: 'existing-session', projectPath: '/proj', updatedAt: Date.now(), cwd: '/proj' },
    ])

    // Handler should NOT fire - we're still initializing
    expect(handler).not.toHaveBeenCalled()
    // But session should be tracked
    expect(indexer['knownSessionIds'].has('existing-session')).toBe(true)
  })

  it('should skip sessions without cwd', () => {
    const indexer = new ClaudeSessionIndexer()
    const handler = vi.fn()

    indexer.onNewSession(handler)
    indexer['initialized'] = true

    indexer['detectNewSessions']([
      { sessionId: 'no-cwd-session', projectPath: '/proj', updatedAt: Date.now(), cwd: undefined },
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
      { sessionId: 'new-session', projectPath: '/proj', updatedAt: Date.now(), cwd: '/proj' },
    ])

    expect(handler).not.toHaveBeenCalled()
  })

  it('should prune stale session IDs from knownSessionIds (memory leak prevention)', () => {
    const indexer = new ClaudeSessionIndexer()
    indexer['initialized'] = true

    // First detection adds sessions A, B, C
    indexer['detectNewSessions']([
      { sessionId: 'session-a', projectPath: '/proj', updatedAt: Date.now(), cwd: '/proj' },
      { sessionId: 'session-b', projectPath: '/proj', updatedAt: Date.now(), cwd: '/proj' },
      { sessionId: 'session-c', projectPath: '/proj', updatedAt: Date.now(), cwd: '/proj' },
    ])

    expect(indexer['knownSessionIds'].size).toBe(3)
    expect(indexer['knownSessionIds'].has('session-a')).toBe(true)
    expect(indexer['knownSessionIds'].has('session-b')).toBe(true)
    expect(indexer['knownSessionIds'].has('session-c')).toBe(true)

    // Second detection: B was deleted, D was added
    indexer['detectNewSessions']([
      { sessionId: 'session-a', projectPath: '/proj', updatedAt: Date.now(), cwd: '/proj' },
      { sessionId: 'session-c', projectPath: '/proj', updatedAt: Date.now(), cwd: '/proj' },
      { sessionId: 'session-d', projectPath: '/proj', updatedAt: Date.now(), cwd: '/proj' },
    ])

    // B should be pruned, D should be added
    expect(indexer['knownSessionIds'].size).toBe(3)
    expect(indexer['knownSessionIds'].has('session-a')).toBe(true)
    expect(indexer['knownSessionIds'].has('session-b')).toBe(false) // Pruned
    expect(indexer['knownSessionIds'].has('session-c')).toBe(true)
    expect(indexer['knownSessionIds'].has('session-d')).toBe(true) // Added
  })

  it('should call handlers in oldest-first order when multiple new sessions are detected', () => {
    const indexer = new ClaudeSessionIndexer()
    const calls: string[] = []
    indexer.onNewSession((session) => calls.push(session.sessionId))
    indexer['initialized'] = true

    indexer['detectNewSessions']([
      { sessionId: 'newest', projectPath: '/proj', updatedAt: 200, cwd: '/proj' },
      { sessionId: 'oldest', projectPath: '/proj', updatedAt: 100, cwd: '/proj' },
      { sessionId: 'middle', projectPath: '/proj', updatedAt: 150, cwd: '/proj' },
    ])

    expect(calls).toEqual(['oldest', 'middle', 'newest'])
  })

  it('should not fire handlers for sessions that reappear after being seen', () => {
    const indexer = new ClaudeSessionIndexer()
    const handler = vi.fn()
    indexer.onNewSession(handler)
    indexer['initialized'] = true

    // First appearance - should fire
    indexer['detectNewSessions']([
      { sessionId: 'session-a', projectPath: '/proj', updatedAt: 100, cwd: '/proj' },
    ])
    expect(handler).toHaveBeenCalledTimes(1)

    // Simulate session removed (known list pruned)
    indexer['detectNewSessions']([])

    // Reappearance with same sessionId should NOT fire again
    indexer['detectNewSessions']([
      { sessionId: 'session-a', projectPath: '/proj', updatedAt: 200, cwd: '/proj' },
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
