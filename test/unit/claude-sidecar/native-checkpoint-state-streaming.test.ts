import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createNativeCheckpointStore } from '../../../crates/freshell-claude-sidecar/native-checkpoint-state.mjs'
import { nativeInputDigest } from '../../../crates/freshell-claude-sidecar/native-session-channel.mjs'

describe('native checkpoint state with streamed transcripts', () => {
  let directory: string | undefined

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = undefined
  })

  it('recognizes a consumed persisted checkpoint after the transcript grows beyond 32 MiB', async () => {
    directory = await mkdtemp(join(tmpdir(), 'native-checkpoint-streaming-'))
    const transcriptPath = join(directory, 'session.jsonl')
    const recordPath = join(directory, 'checkpoint.json')
    const nativeSessionId = '12345678-1234-1234-1234-123456789abc'
    const toolUseID = 'toolu_123'
    const toolInput = { command: 'x' }
    const inputDigest = nativeInputDigest(toolInput)
    const rows = [
      {
        type: 'assistant',
        uuid: 'assistant-1',
        sessionId: nativeSessionId,
        version: '2.1.237',
        message: { id: 'message-1', content: [{ type: 'tool_use', id: toolUseID, name: 'Bash', input: toolInput }] },
      },
      {
        type: 'attachment',
        uuid: 'checkpoint-1',
        sessionId: nativeSessionId,
        version: '2.1.237',
        attachment: {
          type: 'hook_deferred_tool',
          toolUseID,
          toolName: 'Bash',
          hookEvent: 'PreToolUse',
          toolInput,
        },
      },
    ]
    await writeFile(transcriptPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')

    const store = createNativeCheckpointStore({
      recordPath,
      transcriptPath,
      nativeSessionId,
      profileDigest: 'a'.repeat(64),
    })
    await expect(store.publish(toolUseID, inputDigest)).resolves.not.toBeNull()

    const file = await open(transcriptPath, 'a')
    try {
      await file.write(JSON.stringify({
        type: 'user',
        sessionId: nativeSessionId,
        message: { content: [{ type: 'tool_result', tool_use_id: toolUseID, content: [] }] },
      }) + '\n')
      const filler = JSON.stringify({ type: 'summary', body: 'x'.repeat(64 * 1024) }) + '\n'
      for (let index = 0; index < 530; index += 1) await file.write(filler)
    } finally {
      await file.close()
    }

    await expect(store.inputState()).resolves.toBe('clear')
  })
})
