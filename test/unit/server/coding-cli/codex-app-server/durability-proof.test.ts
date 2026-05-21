import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { proofCodexRollout } from '../../../../../server/coding-cli/codex-app-server/durability-proof.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-proof-'))
})

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true })
})

async function writeRollout(name: string, content: string): Promise<string> {
  const filePath = path.join(tempDir, name)
  await fsp.writeFile(filePath, content, 'utf8')
  return filePath
}

describe('proofCodexRollout', () => {
  it('succeeds when the first JSONL record is matching session_meta', async () => {
    const filePath = await writeRollout(
      'rollout.jsonl',
      '{"type":"session_meta","payload":{"id":"thread-1","timestamp":"2026-05-14T00:00:00Z"}}\n{"type":"event_msg"}\n',
    )

    await expect(proofCodexRollout({
      rolloutPath: filePath,
      candidateThreadId: 'thread-1',
    })).resolves.toMatchObject({
      ok: true,
      rolloutProofId: 'thread-1',
    })
  })

  it.each([
    ['missing', async () => path.join(tempDir, 'missing.jsonl')],
    ['not_regular_file', async () => tempDir],
    ['empty', async () => writeRollout('empty.jsonl', '')],
    ['malformed_json', async () => writeRollout('malformed.jsonl', '{"type":')],
    ['wrong_record_type', async () => writeRollout('wrong-type.jsonl', '{"type":"event_msg","payload":{"id":"thread-1"}}\n')],
    ['missing_payload_id', async () => writeRollout('missing-id.jsonl', '{"type":"session_meta","payload":{}}\n')],
    ['mismatched_thread_id', async () => writeRollout('mismatch.jsonl', '{"type":"session_meta","payload":{"id":"other"}}\n')],
  ] as const)('returns %s for invalid proof files', async (reason, makePath) => {
    await expect(proofCodexRollout({
      rolloutPath: await makePath(),
      candidateThreadId: 'thread-1',
    })).resolves.toMatchObject({
      ok: false,
      reason,
    })
  })

  it('requires the first record to match instead of scanning later records', async () => {
    const filePath = await writeRollout(
      'later-match.jsonl',
      '{"type":"event_msg","payload":{"id":"noise"}}\n{"type":"session_meta","payload":{"id":"thread-1"}}\n',
    )

    await expect(proofCodexRollout({
      rolloutPath: filePath,
      candidateThreadId: 'thread-1',
    })).resolves.toMatchObject({
      ok: false,
      reason: 'wrong_record_type',
    })
  })

  it('rejects relative rollout paths', async () => {
    await expect(proofCodexRollout({
      rolloutPath: 'relative/rollout.jsonl',
      candidateThreadId: 'thread-1',
    })).resolves.toMatchObject({
      ok: false,
      reason: 'invalid_path',
    })
  })
})
