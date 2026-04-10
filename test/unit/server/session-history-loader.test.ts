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
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'Hello' }],
      timestamp: '2026-01-01T00:00:01Z',
    })
    expect(messages[1]).toMatchObject({
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
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'What is 2+2?' }],
      timestamp: '2026-01-01T00:00:01Z',
    })
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: '2+2 equals 4.' }],
      timestamp: '2026-01-01T00:00:02Z',
    })
  })

  it('preserves authoritative top-level ids and model fields for legacy string-form records', () => {
    const content = [
      '{"type":"assistant","id":"upstream-top","model":"claude-opus-test","message":"hello","timestamp":"2026-01-01T00:00:00Z"}',
    ].join('\n')

    const messages = extractChatMessagesFromJsonl(content)

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      timestamp: '2026-01-01T00:00:00Z',
      model: 'claude-opus-test',
      messageId: 'upstream-top',
    })
  })

  it('includes top-level legacy model in synthesized deterministic ids', () => {
    const modelA = extractChatMessagesFromJsonl(
      '{"type":"assistant","model":"model-a","message":"hello","timestamp":"2026-01-01T00:00:00Z"}',
    )
    const modelB = extractChatMessagesFromJsonl(
      '{"type":"assistant","model":"model-b","message":"hello","timestamp":"2026-01-01T00:00:00Z"}',
    )

    expect(modelA).toHaveLength(1)
    expect(modelB).toHaveLength(1)
    expect(modelA[0]?.model).toBe('model-a')
    expect(modelB[0]?.model).toBe('model-b')
    expect(modelA[0]?.messageId).toBeDefined()
    expect(modelB[0]?.messageId).toBeDefined()
    expect(modelA[0]?.messageId).not.toBe(modelB[0]?.messageId)
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

  it('coalesces tool messages even when malformed lines are interspersed', () => {
    const content = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]},"timestamp":"2026-01-01T00:00:01Z"}',
      'not valid json',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_result","tool_use_id":"t1","content":"output"}]},"timestamp":"2026-01-01T00:00:02Z"}',
      'also malformed',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"f.ts"}}]},"timestamp":"2026-01-01T00:00:03Z"}',
    ].join('\n')

    const messages = extractChatMessagesFromJsonl(content)

    expect(messages).toHaveLength(1)
    expect(messages[0].content).toHaveLength(3)
    expect(messages[0].content[0]).toEqual({ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } })
    expect(messages[0].content[1]).toEqual({ type: 'tool_result', tool_use_id: 't1', content: 'output' })
    expect(messages[0].content[2]).toEqual({ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'f.ts' } })
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

  it('preserves authoritative upstream message ids when present', () => {
    const content = [
      '{"type":"assistant","message":{"id":"upstream-msg-1","role":"assistant","content":[{"type":"text","text":"Hi"}],"model":"claude-opus-4-6"},"timestamp":"2026-01-01T00:00:01Z"}',
    ].join('\n')

    const messages = extractChatMessagesFromJsonl(content)

    expect(messages[0].messageId).toBe('upstream-msg-1')
  })

  it('synthesizes deterministic message ids for idless equivalent rewrites', () => {
    const original = [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello  \\r\\nworld"}]},"timestamp":"2026-01-01T00:00:01Z"}',
    ].join('\n')
    const rewritten = [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello  \\nworld"}]},"timestamp":"2026-01-02T00:00:01Z"}',
    ].join('\n')

    const originalMessages = extractChatMessagesFromJsonl(original)
    const rewrittenMessages = extractChatMessagesFromJsonl(rewritten)

    expect(originalMessages[0].messageId).toBeDefined()
    expect(originalMessages[0].messageId).toBe(rewrittenMessages[0].messageId)
  })

  it('treats block-end newlines as trailing whitespace when synthesizing deterministic message ids', () => {
    const original = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]},"timestamp":"2026-01-01T00:00:01Z"}',
    ].join('\n')
    const rewritten = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello\\n"}]},"timestamp":"2026-01-02T00:00:01Z"}',
    ].join('\n')

    const originalMessages = extractChatMessagesFromJsonl(original)
    const rewrittenMessages = extractChatMessagesFromJsonl(rewritten)

    expect(originalMessages[0].messageId).toBeDefined()
    expect(originalMessages[0].messageId).toBe(rewrittenMessages[0].messageId)
  })

  it('preserves parent/reference ancestry and distinguishes synthesized ids across different durable chains', () => {
    const content = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"same reply"}],"model":"claude","parentId":"parent-a","referenceId":"ref-a"},"timestamp":"2026-01-01T00:00:01Z"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"same reply"}],"model":"claude","parentId":"parent-b","referenceId":"ref-b"},"timestamp":"2026-01-01T00:00:02Z"}',
    ].join('\n')

    const messages = extractChatMessagesFromJsonl(content)

    expect(messages).toHaveLength(2)
    expect(messages[0]?.parentId).toBe('parent-a')
    expect(messages[0]?.referenceId).toBe('ref-a')
    expect(messages[1]?.parentId).toBe('parent-b')
    expect(messages[1]?.referenceId).toBe('ref-b')
    expect(messages[0]?.messageId).toBeDefined()
    expect(messages[1]?.messageId).toBeDefined()
    expect(messages[0]?.messageId).not.toBe(messages[1]?.messageId)
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

describe('tool message coalescing', () => {
  it('coalesces consecutive tool-only assistant messages from JSONL', () => {
    const content = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]},"timestamp":"2026-01-01T00:00:01Z"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_result","tool_use_id":"t1","content":"file1\\nfile2"}]},"timestamp":"2026-01-01T00:00:02Z"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"f.ts"}}]},"timestamp":"2026-01-01T00:00:03Z"}',
    ].join('\n')

    const messages = extractChatMessagesFromJsonl(content)

    expect(messages).toHaveLength(1)
    expect(messages[0].content).toHaveLength(3)
    expect(messages[0].content[0]).toEqual({ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } })
    expect(messages[0].content[1]).toEqual({ type: 'tool_result', tool_use_id: 't1', content: 'file1\nfile2' })
    expect(messages[0].content[2]).toEqual({ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'f.ts' } })
  })

  it('does not coalesce when assistant message has text content', () => {
    const content = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]},"timestamp":"2026-01-01T00:00:01Z"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]},"timestamp":"2026-01-01T00:00:02Z"}',
    ].join('\n')

    const messages = extractChatMessagesFromJsonl(content)

    expect(messages).toHaveLength(2)
  })

  it('does not coalesce across user messages', () => {
    const content = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]},"timestamp":"2026-01-01T00:00:01Z"}',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Thanks"}]},"timestamp":"2026-01-01T00:00:02Z"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"f.ts"}}]},"timestamp":"2026-01-01T00:00:03Z"}',
    ].join('\n')

    const messages = extractChatMessagesFromJsonl(content)

    expect(messages).toHaveLength(3)
  })

  it('preserves timestamp from first message in coalesced group', () => {
    const content = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]},"timestamp":"2026-01-01T00:00:01Z"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_result","tool_use_id":"t1","content":"output"}]},"timestamp":"2026-01-01T00:00:02Z"}',
    ].join('\n')

    const messages = extractChatMessagesFromJsonl(content)

    expect(messages).toHaveLength(1)
    expect(messages[0].timestamp).toBe('2026-01-01T00:00:01Z')
  })
})
