// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import { searchSessionFile } from '../../../../server/session-directory/file-search.js'
import { claudeProvider } from '../../../../server/coding-cli/providers/claude.js'
import { codexProvider } from '../../../../server/coding-cli/providers/codex.js'

describe('session-directory file search', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'session-directory-file-search-test-'))
  })

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  async function createSessionFile(name: string, content: string): Promise<string> {
    const filePath = path.join(tempDir, `${name}.jsonl`)
    await fsp.writeFile(filePath, content)
    return filePath
  }

  it('finds Claude user messages in userMessages tier', async () => {
    const filePath = await createSessionFile('claude-user', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Fix the authentication bug"}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I will fix that"}]}}',
    ].join('\n'))

    const result = await searchSessionFile(claudeProvider, filePath, 'authentication', 'userMessages')

    expect(result).toMatchObject({
      provider: 'claude',
      matchedIn: 'userMessage',
    })
    expect(result?.snippet).toContain('authentication')
  })

  it('does not search assistant messages in userMessages tier', async () => {
    const filePath = await createSessionFile('claude-user-only', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The authentication is fixed"}]}}',
    ].join('\n'))

    await expect(searchSessionFile(claudeProvider, filePath, 'authentication', 'userMessages'))
      .resolves.toBeNull()
  })

  it('searches assistant messages in fullText tier', async () => {
    const filePath = await createSessionFile('claude-full-text', [
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The authentication is fixed"}]}}',
    ].join('\n'))

    const result = await searchSessionFile(claudeProvider, filePath, 'authentication', 'fullText')

    expect(result).toMatchObject({
      provider: 'claude',
      matchedIn: 'assistantMessage',
    })
  })

  it('matches case-insensitively and returns bounded context', async () => {
    const longMessage = `${'A'.repeat(50)}TARGET${'B'.repeat(50)}`
    const filePath = await createSessionFile('snippet', [
      `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"${longMessage}"}]}}`,
    ].join('\n'))

    const result = await searchSessionFile(claudeProvider, filePath, 'target', 'userMessages')

    expect(result?.snippet?.length).toBeLessThanOrEqual(120)
    expect(result?.snippet).toContain('TARGET')
  })

  it('parses Codex user and assistant message events', async () => {
    const userFile = await createSessionFile('codex-user', [
      '{"type":"session_meta","payload":{"id":"session-1","cwd":"/project"}}',
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Fix the auth bug"}]}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Working on it"}]}}',
    ].join('\n'))
    const assistantFile = await createSessionFile('codex-assistant', [
      '{"type":"session_meta","payload":{"id":"session-2","cwd":"/project"}}',
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Hello"}]}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"The bug is fixed"}]}}',
    ].join('\n'))

    await expect(searchSessionFile(codexProvider, userFile, 'auth bug', 'userMessages'))
      .resolves.toMatchObject({ provider: 'codex', matchedIn: 'userMessage' })
    await expect(searchSessionFile(codexProvider, assistantFile, 'bug is fixed', 'fullText'))
      .resolves.toMatchObject({ provider: 'codex', matchedIn: 'assistantMessage' })
  })
})
