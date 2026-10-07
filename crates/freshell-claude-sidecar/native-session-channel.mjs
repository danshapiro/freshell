import { randomUUID, createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const launchKey = 'FRESHELL_NATIVE_IDENTITY_LAUNCH'
const signalKey = 'FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR'
const ownPath = fileURLToPath(import.meta.url)
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const validRoot = (root) => typeof root === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(root)

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value)
  throw new Error('native operation input is not JSON')
}

export const nativeInputDigest = (input) => createHash('sha256').update(canonicalJson(input)).digest('hex')

async function readNativeTranscript(path, allowMissing = false) {
  const invalid = (reason) => Object.assign(new Error(reason), { code: 'NATIVE_TRANSCRIPT_INVALID' })
  let file
  try {
    file = await open(path, 'r')
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.size > 32n * 1024n * 1024n) throw invalid('invalid native transcript size')
    const bytes = await file.readFile()
    const after = await file.stat({ bigint: true })
    const current = await stat(path, { bigint: true })
    const identity = (metadata) => [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(':')
    if (identity(before) !== identity(after) || identity(after) !== identity(current)
      || BigInt(bytes.length) !== after.size || (bytes.length ? bytes.at(-1) !== 10 : !allowMissing)) {
      throw invalid('native transcript changed or has incomplete EOF')
    }
    const lines = bytes.toString('utf8').split('\n').filter((line) => line.trim())
    return { bytes, lines, rows: lines.map((line) => JSON.parse(line)) }
  } catch (error) {
    if (error?.code === 'ENOENT' && allowMissing) return { bytes: Buffer.alloc(0), lines: [], rows: [] }
    throw error
  } finally { await file?.close() }
}

/** Whether the pinned native loader could replay an existing marker on first
 * input. This never qualifies a checkpoint or proves an effect outcome. */
export async function nativeTranscriptHasDeferredOperation({ path, allowMissing = false }) {
  const { rows, lines } = await readNativeTranscript(path, allowMissing)
  const index = rows.findLastIndex((row) => row.type === 'attachment' && row.attachment?.type === 'hook_deferred_tool')
  if (index < 0) return false
  const toolUseID = rows[index].attachment.toolUseID
  return typeof toolUseID !== 'string' || !toolUseID
    || !lines.slice(index + 1).some((line) => line.includes('"tool_use_id":"' + toolUseID + '"'))
}

/** Native parser only: a persisted card or an attachment without its original
 * solo assistant operation never establishes a recoverable no-effect point. */
export async function inspectNativeDeferredCheckpoint({ path, nativeSessionId, toolUseID, inputDigest,
  includeConsumed = false, checkpointUuid }) {
  if (!validRoot(nativeSessionId) || typeof toolUseID !== 'string' || !/^toolu_[A-Za-z0-9]+$/.test(toolUseID)
    || typeof inputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(inputDigest)) return null
  try {
    const { bytes, lines, rows } = await readNativeTranscript(path)
    const checkpointIndex = rows.findLastIndex((row) => row.type === 'attachment' && row.attachment?.type === 'hook_deferred_tool'
      && (!checkpointUuid || row.uuid === checkpointUuid))
    if (checkpointIndex < 0) return null
    const checkpoint = rows[checkpointIndex]
    const attachment = checkpoint.attachment
    if (checkpoint.sessionId !== nativeSessionId || checkpoint.version !== '2.1.237'
      || typeof checkpoint.uuid !== 'string' || !checkpoint.uuid || attachment.toolUseID !== toolUseID
      || attachment.toolName !== 'Bash' || attachment.hookEvent !== 'PreToolUse'
      || nativeInputDigest(attachment.toolInput) !== inputDigest) return null
    // The pinned native loader scans only the final MiB and invalidates the
    // marker on any later raw correlated tool_use_id, including denials.
    const checkpointOffset = Buffer.byteLength(lines.slice(0, checkpointIndex).join('\n')) + (checkpointIndex ? 1 : 0)
    const consumed = lines.slice(checkpointIndex + 1).some((line) => line.includes('"tool_use_id":"' + toolUseID + '"'))
    if ((bytes.length - checkpointOffset > 1024 * 1024 && !(includeConsumed && consumed))
      || (consumed && !includeConsumed)) return null
    const assistant = rows.slice(0, checkpointIndex).findLast((row) => row.type === 'assistant'
      && Array.isArray(row.message?.content) && row.message.content.some((block) => block.type === 'tool_use' && block.id === toolUseID))
    const tools = assistant?.message.content.filter((block) => block.type === 'tool_use')
    if (assistant?.sessionId !== nativeSessionId || assistant.version !== '2.1.237'
      || typeof assistant.uuid !== 'string' || !assistant.uuid || tools?.length !== 1
      || tools[0].name !== attachment.toolName || nativeInputDigest(tools[0].input) !== inputDigest) return null
    return { nativeSessionId, toolUseID, inputDigest, toolName: attachment.toolName,
      checkpointUuid: checkpoint.uuid, assistantUuid: assistant.uuid, nativeVersion: checkpoint.version,
      checkpointDigest: createHash('sha256').update(lines[checkpointIndex]).digest('hex'),
      ...(includeConsumed ? { consumed } : {}) }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'NATIVE_TRANSCRIPT_INVALID' || error instanceof SyntaxError) return null
    throw new Error('native deferred checkpoint is unreadable')
  }
}

export async function writeNativeSessionSignal(input, env = process.env) {
  const launch = JSON.parse(env[launchKey] ?? 'null')
  const directory = env[signalKey]
  if (!launch?.launchNonce || !launch.incarnationId || !directory) throw new Error('missing current native launch')
  if (!input || input.hook_event_name !== 'SessionStart' || typeof input.session_id !== 'string'
    || !validRoot(input.session_id) || !['startup', 'resume', 'clear', 'compact'].includes(input.source)) {
    throw new Error('invalid native SessionStart')
  }
  const payload = { launch, native: input }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const staging = join(directory, `signal-${randomUUID()}.tmp`)
  await writeFile(staging, JSON.stringify(payload), { mode: 0o600 })
  await rename(staging, join(directory, 'session-start.json'))
}

export async function createNativeSessionChannel({ launch, directory, timeoutMs = 50_000, signal } = {}) {
  if (!launch?.launchNonce || !launch.incarnationId) throw new Error('missing current native launch')
  const ownedDirectory = join(directory ?? tmpdir(), `freshell-native-${randomUUID()}`)
  await mkdir(ownedDirectory, { recursive: true, mode: 0o700 })
  const env = { [launchKey]: JSON.stringify(launch), [signalKey]: ownedDirectory }
  const settings = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(ownPath)}` }] }] } }
  return {
    env, settings, directory: ownedDirectory,
    cleanup: () => rm(ownedDirectory, { recursive: true, force: true }),
    async waitReady(query) {
      const deadline = Date.now() + timeoutMs
      let initialized = false
      let initializationError
      Promise.resolve().then(() => query.initializationResult()).then(
        () => { initialized = true },
        (error) => { initializationError = error },
      )
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error('native startup cancelled')
        if (initializationError) throw initializationError
        try {
          const bytes = await readFile(join(ownedDirectory, 'session-start.json'), 'utf8')
          const value = JSON.parse(bytes)
          if (JSON.stringify(value.launch) !== JSON.stringify(launch)) throw new Error('stale native launch')
          if (value.native?.hook_event_name !== 'SessionStart' || !validRoot(value.native?.session_id)
            || !['startup', 'resume', 'clear', 'compact'].includes(value.native.source)) throw new Error('invalid native SessionStart')
          if (launch.requestedNativeSessionId && value.native.session_id !== launch.requestedNativeSessionId) throw new Error('wrong native root')
          if (initialized) return { nativeSessionId: value.native.session_id, native: value.native,
            evidenceDigest: createHash('sha256').update(bytes).digest('hex') }
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error('native startup timeout')
    },
  }
}

if (process.argv[1] === ownPath) {
  try {
    let input = ''
    for await (const chunk of process.stdin) {
      input += chunk
      if (input.length > 1024 * 1024) throw new Error('native hook input too large')
    }
    await writeNativeSessionSignal(JSON.parse(input))
    process.stdout.write('{}\n')
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ severity: 'error', component: 'native-session-hook', message: error.message })}\n`)
    process.exitCode = 1
  }
}
