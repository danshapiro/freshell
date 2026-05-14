import fsp from 'node:fs/promises'
import path from 'node:path'
import type { CodexRolloutProofFailureReason } from '../../../shared/codex-durability.js'

type ProofFs = Pick<typeof fsp, 'open' | 'stat'>

const FIRST_RECORD_CHUNK_BYTES = 8192
const MAX_FIRST_RECORD_BYTES = 1024 * 1024

export type CodexRolloutProofSuccess = {
  ok: true
  candidateThreadId: string
  rolloutPath: string
  rolloutProofId: string
}

export type CodexRolloutProofFailure = {
  ok: false
  reason: CodexRolloutProofFailureReason
  message: string
  candidateThreadId: string
  rolloutPath: string
}

export type CodexRolloutProofResult = CodexRolloutProofSuccess | CodexRolloutProofFailure

export async function proofCodexRollout(input: {
  rolloutPath: string
  candidateThreadId: string
  fsImpl?: ProofFs
}): Promise<CodexRolloutProofResult> {
  const fsImpl = input.fsImpl ?? fsp
  const rolloutPath = input.rolloutPath
  const candidateThreadId = input.candidateThreadId

  const fail = (reason: CodexRolloutProofFailureReason, message: string): CodexRolloutProofFailure => ({
    ok: false,
    reason,
    message,
    candidateThreadId,
    rolloutPath,
  })

  if (!path.isAbsolute(rolloutPath)) {
    return fail('invalid_path', 'Codex rollout proof path must be absolute.')
  }
  if (!candidateThreadId) {
    return fail('mismatched_thread_id', 'Codex candidate thread id is empty.')
  }

  let stat: Awaited<ReturnType<ProofFs['stat']>>
  try {
    stat = await fsImpl.stat(rolloutPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return fail('missing', 'Codex rollout proof file does not exist.')
    }
    return fail('read_error', `Could not stat Codex rollout proof file: ${errorMessage(error)}`)
  }

  if (!stat.isFile()) {
    return fail('not_regular_file', 'Codex rollout proof path is not a regular file.')
  }

  let firstLine: string
  try {
    firstLine = (await readFirstLine(fsImpl, rolloutPath)).trim()
  } catch (error) {
    return fail('read_error', `Could not read Codex rollout proof file: ${errorMessage(error)}`)
  }

  if (!firstLine) {
    return fail('empty', 'Codex rollout proof file does not start with a JSONL record.')
  }

  let firstRecord: unknown
  try {
    firstRecord = JSON.parse(firstLine)
  } catch {
    return fail('malformed_json', 'Codex rollout proof first JSONL record is malformed.')
  }

  if (!firstRecord || typeof firstRecord !== 'object') {
    return fail('malformed_json', 'Codex rollout proof first JSONL record is not an object.')
  }

  const record = firstRecord as Record<string, unknown>
  if (record.type !== 'session_meta') {
    return fail('wrong_record_type', 'Codex rollout proof first JSONL record is not session_meta.')
  }

  const payload = record.payload
  const rolloutProofId = payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>).id
    : undefined
  if (typeof rolloutProofId !== 'string' || rolloutProofId.length === 0) {
    return fail('missing_payload_id', 'Codex rollout proof session_meta payload.id is missing.')
  }

  if (rolloutProofId !== candidateThreadId) {
    return fail('mismatched_thread_id', 'Codex rollout proof id does not match candidate thread id.')
  }

  return {
    ok: true,
    candidateThreadId,
    rolloutPath,
    rolloutProofId,
  }
}

async function readFirstLine(fsImpl: ProofFs, filePath: string): Promise<string> {
  const handle = await fsImpl.open(filePath, 'r')
  const chunks: Buffer[] = []
  let bytesSeen = 0

  try {
    while (bytesSeen < MAX_FIRST_RECORD_BYTES) {
      const buffer = Buffer.alloc(Math.min(FIRST_RECORD_CHUNK_BYTES, MAX_FIRST_RECORD_BYTES - bytesSeen))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytesSeen)
      if (bytesRead === 0) break

      const slice = buffer.subarray(0, bytesRead)
      const newlineIndex = slice.indexOf(10)
      if (newlineIndex >= 0) {
        chunks.push(slice.subarray(0, newlineIndex))
        return Buffer.concat(chunks).toString('utf8').replace(/\r$/, '')
      }

      chunks.push(slice)
      bytesSeen += bytesRead
    }
  } finally {
    await handle.close()
  }

  return Buffer.concat(chunks).toString('utf8').replace(/\r$/, '')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
