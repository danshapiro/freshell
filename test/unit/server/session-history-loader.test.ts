import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import { extractChatMessagesFromJsonl, loadSessionHistory } from '../../../server/session-history-loader.js'

describe('extractChatMessagesFromJsonl', () => {
  it('extracts user and assistant messages from structured JSONL', () => {
    const content = [
      '{"type":"system","subtype":"init","session_id":"sess-1","cwd":"/tmp"}',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]},"timestamp":"2026-01-01T00:00:01Z"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi there!"}]},"timestamp":"2026-01-01T00:00:02Z"}',
      '{"type":"result","subtype":"success","is_error":false,"duration_ms":1000}',
    ].join('\n')

    const messages = extractChatMessagesFromJsonl(content)

    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Hello' }],
      timestamp: '2026-01-01T00:00:01Z',
    })
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi there!' }],
      timestamp: '2026-01-01T00:00:02Z',
    })
  })

  it('handles simple string message format (legacy)', () => {
    const content = [
      '{"type":"user","message":"What is 2+2?","timestamp":"2026-01-01T00:00:01Z"}',
      '{"type":"assistant","message":"2+2 equals 4.","timestamp":"2026-01-01T00:00:02Z"}',
    ].join('\n')

    const messages = extractChatMessagesFromJsonl(content)

    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'What is 2+2?' }],
      timestamp: '2026-01-01T00:00:01Z',
    })
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '2+2 equals 4.' }],
      timestamp: '2026-01-01T00:00:02Z',
    })
  })

  it('preserves tool_use and tool_result content blocks', () => {
    const content = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me check."},{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"echo hi"}}]},"timestamp":"2026-01-01T00:00:01Z"}',
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"hi"}]},"timestamp":"2026-01-01T00:00:02Z"}',
    ].join('\n')

    const messages = extractChatMessagesFromJsonl(content)

    expect(messages).toHaveLength(2)
    expect(messages[0].content).toEqual([
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'echo hi' } },
    ])
    expect(messages[1].content).toEqual([
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'hi' },
    ])
  })

  it('skips system and result events', () => {
    const content = [
      '{"type":"system","subtype":"init","session_id":"sess-1"}',
      '{"type":"user","message":"Hi","timestamp":"2026-01-01T00:00:01Z"}',
      '{"type":"result","subtype":"success","is_error":false}',
    ].join('\n')

    const messages = extractChatMessagesFromJsonl(content)

    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')
  })

  it('skips malformed JSON lines gracefully', () => {
    const content = [
      '{"type":"user","message":"Good line","timestamp":"2026-01-01T00:00:01Z"}',
      'not valid json',
      '{"type":"assistant","message":"Also good","timestamp":"2026-01-01T00:00:02Z"}',
    ].join('\n')

    const messages = extractChatMessagesFromJsonl(content)

    expect(messages).toHaveLength(2)
  })

  it('returns empty array for empty content', () => {
    expect(extractChatMessagesFromJsonl('')).toEqual([])
    expect(extractChatMessagesFromJsonl('\n\n')).toEqual([])
  })

  it('includes model from structured assistant messages', () => {
    const content = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi"}],"model":"claude-opus-4-6"},"timestamp":"2026-01-01T00:00:01Z"}',
    ].join('\n')

    const messages = extractChatMessagesFromJsonl(content)

    expect(messages[0].model).toBe('claude-opus-4-6')
  })
})

describe('loadSessionHistory', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-test-'))
  })

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  it('loads and parses messages from a session .jsonl file', async () => {
    // Set up fake projects directory
    const projectDir = path.join(tmpDir, 'projects', 'my-project')
    await fsp.mkdir(projectDir, { recursive: true })
    const sessionId = 'test-session-abc-123'
    const jsonl = [
      '{"type":"system","subtype":"init","session_id":"' + sessionId + '"}',
      '{"type":"user","message":"Hello","timestamp":"2026-01-01T00:00:01Z"}',
      '{"type":"assistant","message":"Hi!","timestamp":"2026-01-01T00:00:02Z"}',
    ].join('\n')
    await fsp.writeFile(path.join(projectDir, `${sessionId}.jsonl`), jsonl)

    const messages = await loadSessionHistory(sessionId, tmpDir)

    expect(messages).toHaveLength(2)
    expect(messages![0].role).toBe('user')
    expect(messages![0].content[0].text).toBe('Hello')
    expect(messages![1].role).toBe('assistant')
    expect(messages![1].content[0].text).toBe('Hi!')
  })

  it('returns null when session file is not found', async () => {
    const projectDir = path.join(tmpDir, 'projects', 'some-project')
    await fsp.mkdir(projectDir, { recursive: true })

    const messages = await loadSessionHistory('nonexistent-session', tmpDir)

    expect(messages).toBeNull()
  })

  it('rejects session IDs with path traversal characters', async () => {
    const projectDir = path.join(tmpDir, 'projects', 'my-project')
    await fsp.mkdir(projectDir, { recursive: true })
    // Create a file that would be reachable via traversal
    await fsp.writeFile(
      path.join(tmpDir, 'secret.jsonl'),
      '{"type":"user","message":"secret","timestamp":"2026-01-01T00:00:01Z"}',
    )

    expect(await loadSessionHistory('../secret', tmpDir)).toBeNull()
    expect(await loadSessionHistory('../../etc/passwd', tmpDir)).toBeNull()
    expect(await loadSessionHistory('foo/bar', tmpDir)).toBeNull()
  })

  it('finds session files in one-level subdirectories', async () => {
    const projectDir = path.join(tmpDir, 'projects', 'my-project')
    const sessionsDir = path.join(projectDir, 'sessions')
    await fsp.mkdir(sessionsDir, { recursive: true })
    await fsp.writeFile(
      path.join(sessionsDir, 'nested-session.jsonl'),
      '{"type":"user","message":"Found in subdir","timestamp":"2026-01-01T00:00:01Z"}',
    )

    const messages = await loadSessionHistory('nested-session', tmpDir)
    expect(messages).toHaveLength(1)
    expect(messages![0].content[0].text).toBe('Found in subdir')
  })

  it('does not search deeper than one subdirectory level', async () => {
    const projectDir = path.join(tmpDir, 'projects', 'my-project')
    const deepDir = path.join(projectDir, 'parent-session', 'subagents')
    await fsp.mkdir(deepDir, { recursive: true })
    await fsp.writeFile(
      path.join(deepDir, 'deep-agent.jsonl'),
      '{"type":"user","message":"too deep","timestamp":"2026-01-01T00:00:01Z"}',
    )

    const messages = await loadSessionHistory('deep-agent', tmpDir)
    expect(messages).toBeNull()
  })

  it('searches across multiple project directories', async () => {
    const projectDir1 = path.join(tmpDir, 'projects', 'project-a')
    const projectDir2 = path.join(tmpDir, 'projects', 'project-b')
    await fsp.mkdir(projectDir1, { recursive: true })
    await fsp.mkdir(projectDir2, { recursive: true })
    // Session file is in project-b
    const sessionId = 'session-in-project-b'
    await fsp.writeFile(
      path.join(projectDir2, `${sessionId}.jsonl`),
      '{"type":"user","message":"Found me","timestamp":"2026-01-01T00:00:01Z"}',
    )

    const messages = await loadSessionHistory(sessionId, tmpDir)

    expect(messages).toHaveLength(1)
    expect(messages![0].content[0].text).toBe('Found me')
  })
})
