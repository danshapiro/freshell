import fsp from 'node:fs/promises'
import path from 'node:path'
import type { CodexRolloutProofFailureReason } from '../../../shared/codex-durability.js'

type ProofFs = Pick<typeof fsp, 'readFile' | 'stat'>

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

  let raw: string
  try {
    raw = await fsImpl.readFile(rolloutPath, 'utf8')
  } catch (error) {
    return fail('read_error', `Could not read Codex rollout proof file: ${errorMessage(error)}`)
  }

  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? ''
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
