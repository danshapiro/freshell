// Tests for scanFileForUserTextMessages — byte-level fallback that corrects
// false non-interactive classification on large truncated session files.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { scanFileForUserTextMessages } from '../../../../server/coding-cli/session-indexer.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-scan-test-'))
})

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true })
})

function jsonlLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj)
}

function userTextMessage(content: string): string {
  return jsonlLine({
    type: 'user',
    message: { role: 'user', content },
  })
}

function userToolResult(): string {
  return jsonlLine({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'abc', content: '' }] },
  })
}

function assistantMessage(text: string): string {
  return jsonlLine({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })
}

describe('scanFileForUserTextMessages', () => {
  it('returns false for empty file', async () => {
    const filePath = path.join(tempDir, 'empty.jsonl')
    await fsp.writeFile(filePath, '')
    expect(await scanFileForUserTextMessages(filePath)).toBe(false)
  })

  it('returns false for single text user message', async () => {
    const filePath = path.join(tempDir, 'single.jsonl')
    await fsp.writeFile(filePath, [
      userTextMessage('Hello'),
      assistantMessage('Hi there'),
    ].join('\n'))
    expect(await scanFileForUserTextMessages(filePath)).toBe(false)
  })

  it('returns true for two text user messages', async () => {
    const filePath = path.join(tempDir, 'two.jsonl')
    await fsp.writeFile(filePath, [
      userTextMessage('Hello'),
      assistantMessage('Hi there'),
      userTextMessage('Do something'),
      assistantMessage('Done'),
    ].join('\n'))
    expect(await scanFileForUserTextMessages(filePath)).toBe(true)
  })

  it('does not count tool_result user messages toward interactivity', async () => {
    const filePath = path.join(tempDir, 'tool-results.jsonl')
    await fsp.writeFile(filePath, [
      userTextMessage('Hello'),
      assistantMessage('Let me check'),
      userToolResult(),
      userToolResult(),
      userToolResult(),
    ].join('\n'))
    expect(await scanFileForUserTextMessages(filePath)).toBe(false)
  })

  it('returns true when text messages are separated by many tool_result messages', async () => {
    const filePath = path.join(tempDir, 'mixed.jsonl')
    const lines = [
      userTextMessage('First question'),
      assistantMessage('Working on it'),
    ]
    // Add many tool_result exchanges in between
    for (let i = 0; i < 50; i++) {
      lines.push(userToolResult())
      lines.push(assistantMessage(`Step ${i}`))
    }
    lines.push(userTextMessage('Second question'))
    lines.push(assistantMessage('Here you go'))
    await fsp.writeFile(filePath, lines.join('\n'))
    expect(await scanFileForUserTextMessages(filePath)).toBe(true)
  })

  it('handles pattern spanning chunk boundaries', async () => {
    // Create a file where user text messages are separated by enough data
    // to span multiple 64KB chunks
    const filePath = path.join(tempDir, 'large.jsonl')
    const lines = [userTextMessage('First message')]
    // Pad with large assistant messages to push past 64KB
    const bigText = 'x'.repeat(70_000)
    lines.push(assistantMessage(bigText))
    lines.push(userTextMessage('Second message'))
    await fsp.writeFile(filePath, lines.join('\n'))
    expect(await scanFileForUserTextMessages(filePath)).toBe(true)
  })

  it('does not double-count a pattern at an exact chunk boundary', async () => {
    // Place a single user text message so the target byte pattern starts at
    // exactly byte 64KB — the overlap position scanned by both adjacent chunks.
    const chunkSize = 64 * 1024
    const filePath = path.join(tempDir, 'boundary.jsonl')
    const pattern = '"role":"user","content":"'
    // Build a user message line, then figure out where the pattern sits inside it
    const userLine = userTextMessage('Only message')
    const patternOffsetInLine = userLine.indexOf(pattern)
    // Pad so that (padding + \n + patternOffsetInLine) = chunkSize
    const prefixLength = chunkSize - 1 - patternOffsetInLine // -1 for \n separator
    const padding = 'x'.repeat(prefixLength)
    const content = padding + '\n' + userLine
    // Sanity-check alignment
    expect(content.indexOf(pattern)).toBe(chunkSize)
    await fsp.writeFile(filePath, content)
    // Only one text user message — must return false, not double-count
    expect(await scanFileForUserTextMessages(filePath)).toBe(false)
  })

  it('returns false for nonexistent file', async () => {
    const filePath = path.join(tempDir, 'nonexistent.jsonl')
    expect(await scanFileForUserTextMessages(filePath)).toBe(false)
  })

  it('returns false for file with only tool_result user messages', async () => {
    const filePath = path.join(tempDir, 'only-tools.jsonl')
    await fsp.writeFile(filePath, [
      userToolResult(),
      assistantMessage('Done'),
      userToolResult(),
      assistantMessage('Done again'),
    ].join('\n'))
    expect(await scanFileForUserTextMessages(filePath)).toBe(false)
  })
})
