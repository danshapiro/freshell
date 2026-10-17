import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { nativeTranscriptHasDeferredOperation } from '../../../crates/freshell-claude-sidecar/native-session-channel.mjs'

describe('streaming native transcript safety scan', () => {
  let directory: string | undefined

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = undefined
  })

  it('allows a valid transcript larger than 32 MiB when no deferred operation remains', async () => {
    directory = await mkdtemp(join(tmpdir(), 'native-transcript-streaming-'))
    const path = join(directory, 'session.jsonl')
    const row = JSON.stringify({ type: 'user', sessionId: 'session-one', message: { content: 'x'.repeat(4096) } }) + '\n'
    const count = Math.ceil((33 * 1024 * 1024) / Buffer.byteLength(row))
    await writeFile(path, row.repeat(count))

    await expect(nativeTranscriptHasDeferredOperation({ path })).resolves.toBe(false)
  })

  it('rejects an individual row beyond the previously supported transcript size', async () => {
    directory = await mkdtemp(join(tmpdir(), 'native-transcript-large-row-'))
    const path = join(directory, 'session.jsonl')
    const file = await open(path, 'w')
    try {
      await file.write('{"type":"user","message":{"content":"')
      const chunk = 'x'.repeat(1024 * 1024)
      for (let index = 0; index < 33; index += 1) await file.write(chunk)
      await file.write('"}}\n')
    } finally {
      await file.close()
    }

    await expect(nativeTranscriptHasDeferredOperation({ path }))
      .rejects.toMatchObject({ code: 'NATIVE_TRANSCRIPT_INVALID' })
  })
})
