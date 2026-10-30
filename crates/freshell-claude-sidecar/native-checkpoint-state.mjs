// Restricted native solo-tool recovery state; no callback or effect replay.
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { inspectNativeDeferredCheckpoint, nativeTranscriptHasDeferredOperation } from './native-session-channel.mjs'

const recoverable = new Set(['checkpointed', 'approval_waiting'])
const phases = new Set([...recoverable, 'continuing', 'dispatching', 'resolved', 'interrupted'])

export function createNativeCheckpointStore({ recordPath, transcriptPath, nativeSessionId, profileDigest, allowMissingTranscript = false, parentFork, nativeClear }) {
  if (!isAbsolute(recordPath) || !isAbsolute(transcriptPath) || !/^[a-f0-9]{64}$/.test(profileDigest)) {
    throw new Error('native checkpoint store requires its exact owned paths and profile')
  }
  let serialized = Promise.resolve()
  const run = (operation) => {
    const pending = serialized.then(operation)
    serialized = pending.catch(() => {})
    return pending
  }
  async function read() {
    try {
      const bytes = await readFile(recordPath)
      if (bytes.length > 65_536) throw new Error()
      const record = JSON.parse(bytes)
      if (record.schemaVersion !== 1 || !phases.has(record.phase) || record.checkpoint?.nativeSessionId !== nativeSessionId
        || record.nativeSessionId !== nativeSessionId || record.toolUseID !== record.checkpoint.toolUseID
        || record.inputDigest !== record.checkpoint.inputDigest || !/^[a-f0-9]{64}$/.test(record.profileDigest)) throw new Error()
      return record
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw new Error('native checkpoint state is unreadable')
    }
  }
  async function save(record) {
    const directory = dirname(recordPath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const staging = recordPath + '.' + randomUUID() + '.tmp'
    try {
      const file = await open(staging, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(record) + '\n'); await file.sync() }
      finally { await file.close() }
      await rename(staging, recordPath)
    } finally { await rm(staging, { force: true }) }
    const parent = await open(directory, 'r')
    try { await parent.sync() } finally { await parent.close() }
    return record
  }
  async function current(record) {
    if (!record || record.profileDigest !== profileDigest) return false
    const observed = await inspectNativeDeferredCheckpoint({ path: transcriptPath, nativeSessionId,
      toolUseID: record.checkpoint.toolUseID, inputDigest: record.checkpoint.inputDigest })
    return observed !== null && JSON.stringify(observed) === JSON.stringify(record.checkpoint)
  }
  async function consumed(record) {
    const proof = await inspectNativeDeferredCheckpoint({ path: transcriptPath, nativeSessionId,
      toolUseID: record.checkpoint.toolUseID, inputDigest: record.checkpoint.inputDigest,
      checkpointUuid: record.checkpoint.checkpointUuid, includeConsumed: true })
    if (!proof?.consumed) return false
    delete proof.consumed
    return JSON.stringify(proof) === JSON.stringify(record.checkpoint)
  }
  async function inputState() {
    try {
      const record = await read()
      if (!record) return await nativeTranscriptHasDeferredOperation({ path: transcriptPath, allowMissing: allowMissingTranscript,
        parentFork, nativeSessionId }) ? 'blocked' : 'clear'
      if (await consumed(record)) return await nativeTranscriptHasDeferredOperation({ path: transcriptPath }) ? 'blocked' : 'clear'
      return recoverable.has(record.phase) && await current(record) ? 'recoverable' : 'blocked'
    } catch { return 'blocked' }
  }
  return {
    disableParentFork: () => { if (parentFork) { parentFork = undefined; allowMissingTranscript = false } },
    inputState: () => run(inputState),
    setProfileDigest: (next) => run(async () => {
      if (!/^[a-f0-9]{64}$/.test(next) || await inputState() !== 'clear') {
        throw new Error('native checkpoint settings cannot change while an operation is pending')
      }
      // Only future operations use the new profile; never rewrite a journal
      // record that binds an already pending operation to its original profile.
      profileDigest = next
    }),
    publish: (toolUseID, inputDigest) => run(async () => {
      const checkpoint = await inspectNativeDeferredCheckpoint({ path: transcriptPath, nativeSessionId, toolUseID, inputDigest })
      if (!checkpoint) return null
      const previous = await read()
      if (previous && !['resolved', 'interrupted'].includes(previous.phase) && !await consumed(previous)) {
        return recoverable.has(previous.phase) && await current(previous) ? previous : null
      }
      return save({ schemaVersion: 1, checkpoint, nativeSessionId, toolUseID, inputDigest, profileDigest, phase: 'checkpointed' })
    }),
    readRecoverable: () => run(async () => {
      const record = await read()
      return record && recoverable.has(record.phase) && await current(record) ? record : null
    }),
    beginContinuation: () => run(async () => {
      const record = await read()
      if (!record || !recoverable.has(record.phase) || !await current(record)) return false
      await save({ ...record, phase: 'continuing', nativeBinding: undefined })
      return true
    }),
    parkPermission: (toolUseID, inputDigest, nativeBinding) => run(async () => {
      const record = await read()
      if (!record || record.phase !== 'continuing' || record.toolUseID !== toolUseID || record.inputDigest !== inputDigest
        || !nativeBinding?.nativeRequestId || !nativeBinding.launch?.launchNonce || !nativeBinding.launch.incarnationId
        || !Number.isSafeInteger(nativeBinding.queryGeneration) || nativeBinding.queryGeneration <= 0
        || (nativeBinding.launch.requestedNativeSessionId && nativeBinding.launch.requestedNativeSessionId !== nativeSessionId
          && !(nativeClear && nativeBinding.nativeClear?.previousNativeSessionId === nativeClear.previousNativeSessionId
            && nativeBinding.nativeClear.nativeSessionId === nativeSessionId))
        || !await current(record)) return false
      await save({ ...record, phase: 'approval_waiting', nativeBinding })
      return true
    }),
    beginDecision: (nativeRequestId) => run(async () => {
      const record = await read()
      if (!record || record.phase !== 'approval_waiting' || record.nativeBinding?.nativeRequestId !== nativeRequestId
        || !await current(record)) return false
      await save({ ...record, phase: 'dispatching' })
      return true
    }),
    finishNativeResult: (toolUseID, isError) => run(async () => {
      const record = await read()
      if (!record || !['continuing', 'dispatching'].includes(record.phase) || record.toolUseID !== toolUseID
        || typeof isError !== 'boolean') return false
      await save({ ...record, phase: 'resolved', toolResultIsError: isError })
      return true
    }),
    interrupt: () => run(async () => {
      const record = await read()
      if (record && !['resolved', 'dispatching'].includes(record.phase)) await save({ ...record, phase: 'interrupted' })
    }),
  }
}
