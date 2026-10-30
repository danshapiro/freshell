import { randomUUID, createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const launchKey = 'FRESHELL_NATIVE_IDENTITY_LAUNCH'
const signalKey = 'FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR'
const ownPath = fileURLToPath(import.meta.url)
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const validRoot = (root) => typeof root === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(root)
const sessionStartSources = new Set(['startup', 'resume', 'clear', 'compact', 'fork'])
// The previous whole-file reader rejected transcripts above this size, so a
// single row could never have been larger. Keep that compatibility bound per
// row while allowing an unlimited number of ordinary-sized rows.
const maxNativeTranscriptRowBytes = 32 * 1024 * 1024

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

async function forEachNativeTranscriptRow(path, { allowMissing = false, hash } = {}, consume) {
  const invalid = (reason) => Object.assign(new Error(reason), { code: 'NATIVE_TRANSCRIPT_INVALID' })
  let file
  try {
    file = await open(path, 'r')
  } catch (error) {
    if (error?.code === 'ENOENT' && allowMissing) {
      return { byteLength: 0n, identity: null, rowCount: 0 }
    }
    throw error
  }

  const identity = (metadata) => [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(':')
  let lineParts = []
  let lineBytes = 0
  let lineOffset = 0n
  let bytesRead = 0n
  let lastByte = null
  let rowCount = 0

  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile()) throw invalid('invalid native transcript file')
    const stream = file.createReadStream({ start: 0, autoClose: false })
    const processLine = () => {
      const lineBuffer = Buffer.concat(lineParts, lineBytes)
      const line = lineBuffer.toString('utf8')
      if (line.trim()) {
        consume(JSON.parse(line), line, lineOffset)
        rowCount += 1
      }
      lineOffset += BigInt(lineBytes + 1)
      lineParts = []
      lineBytes = 0
    }
    const appendPart = (part) => {
      if (!part.length) return
      lineBytes += part.length
      if (lineBytes > maxNativeTranscriptRowBytes) throw invalid('native transcript row exceeds the supported size')
      lineParts.push(part)
    }

    for await (const chunk of stream) {
      bytesRead += BigInt(chunk.length)
      hash?.update(chunk)
      if (chunk.length) lastByte = chunk.at(-1)
      let start = 0
      let boundary
      while ((boundary = chunk.indexOf(10, start)) >= 0) {
        appendPart(chunk.subarray(start, boundary))
        processLine()
        start = boundary + 1
      }
      appendPart(chunk.subarray(start))
    }
    if (lineBytes > 0) throw invalid('native transcript changed or has incomplete EOF')

    const after = await file.stat({ bigint: true })
    const current = await stat(path, { bigint: true })
    if (identity(before) !== identity(after) || identity(after) !== identity(current)
      || bytesRead !== after.size || (bytesRead ? lastByte !== 10 : !allowMissing)) {
      throw invalid('native transcript changed or has incomplete EOF')
    }

    return { byteLength: bytesRead, identity: identity(after), rowCount }
  } finally { await file.close() }
}

async function scanNativeTranscript(path, { allowMissing = false, expectedSessionId } = {}) {
  const pending = new Set()
  let malformedToolUse = false
  let latestDeferredMarkerSeen = false
  let latestDeferredToolUseID = null
  let latestDeferredToolUseValid = false
  let latestDeferredToolUseMatched = false
  let messageCount = 0
  let sessionIdentityMatches = true

  await forEachNativeTranscriptRow(path, { allowMissing }, (row, line) => {
    if (latestDeferredToolUseID !== null
      && line.includes('"tool_use_id":"' + latestDeferredToolUseID + '"')) {
      latestDeferredToolUseMatched = true
    }

    if (expectedSessionId !== undefined && ['user', 'assistant'].includes(row.type)) {
      messageCount += 1
      if (row.sessionId !== expectedSessionId) sessionIdentityMatches = false
    }

    for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
      if (row.type === 'assistant' && block.type === 'tool_use') {
        if (typeof block.id !== 'string' || !block.id) malformedToolUse = true
        else pending.add(block.id)
      } else if (row.type === 'user' && block.type === 'tool_result') {
        pending.delete(block.tool_use_id)
      }
    }

    if (row.type === 'attachment' && row.attachment?.type === 'hook_deferred_tool') {
      latestDeferredMarkerSeen = true
      latestDeferredToolUseID = row.attachment.toolUseID
      latestDeferredToolUseValid = typeof latestDeferredToolUseID === 'string' && latestDeferredToolUseID.length > 0
      latestDeferredToolUseMatched = false
    }
  })

  const hasDeferredOperation = malformedToolUse || pending.size > 0
    || (latestDeferredMarkerSeen
      && (!latestDeferredToolUseValid || !latestDeferredToolUseMatched))
  return { hasDeferredOperation, messageCount, sessionIdentityMatches }
}

/** Whether the pinned native loader has an unfinished operation on first
 * input. This never qualifies a checkpoint or proves an effect outcome. */
export async function inspectNativeForkSource(recipe, childSessionId) {
  if (!recipe || !validRoot(childSessionId) || recipe.childSessionId !== childSessionId
    || recipe.recoveryDisabled === true
    || !validRoot(recipe.parentSessionId) || recipe.parentSessionId === childSessionId
    || !isAbsolute(recipe.parentTranscript ?? '') || !isAbsolute(recipe.childTranscript ?? '')
    || !/^[a-f0-9]{64}$/.test(recipe.parentSha256 ?? '')) throw new Error('invalid native fork source')
  const hash = createHash('sha256')
  const candidates = []
  let parentSeen = false
  let foreignMessages = false
  // Parent-backed recovery needs chain links and pending-tool identities, not
  // prior text/output bodies. Reuse the stable streaming read used by normal
  // native admission, and hash the original bytes during that same pass.
  await forEachNativeTranscriptRow(recipe.parentTranscript, { hash }, row => {
    if (row.sessionId === recipe.parentSessionId) parentSeen = true
    if (['user', 'assistant'].includes(row.type) && row.sessionId !== recipe.parentSessionId) foreignMessages = true
    if (typeof row.uuid !== 'string' || !row.uuid
      || ['mode', 'atis-latch', 'queue-operation', 'last-prompt'].includes(row.type)) return
    candidates.push({ uuid: row.uuid, parentUuid: row.parentUuid, type: row.type,
      message: { content: Array.isArray(row.message?.content) ? row.message.content
        .filter(block => block.type === 'tool_use' || block.type === 'tool_result')
        .map(block => ({ type: block.type, id: block.id, tool_use_id: block.tool_use_id })) : [] },
      ...(row.attachment?.type === 'hook_deferred_tool' ? { attachment: {
        type: row.attachment.type, toolUseID: row.attachment.toolUseID,
      } } : {}) })
  })
  if (hash.digest('hex') !== recipe.parentSha256) throw new Error('native fork source changed')
  if (!candidates.length || !parentSeen || foreignMessages) throw new Error('native fork parent identity changed')
  const byId = new Map(candidates.map((row) => [row.uuid, row]))
  const chain = [], seen = new Set()
  let row = candidates.at(-1)
  while (row) {
    if (seen.has(row.uuid)) throw new Error('native fork source cycle')
    seen.add(row.uuid); chain.unshift(row); row = byId.get(row.parentUuid)
  }
  if (recipe.target?.kind === 'empty') return { rows: [], lines: [] }
  const index = chain.findIndex((row) => row.uuid === recipe.target?.cutoffUuid)
  if (recipe.target?.kind !== 'prefix' || index < 0
    || (recipe.target.dropTurnUuid && chain[index + 1]?.uuid !== recipe.target.dropTurnUuid)) throw new Error('native fork cutoff changed')
  const kept = chain.slice(0, index + 1)
  return { rows: kept, lines: kept.map(row => JSON.stringify(row)) }
}

function hasDeferredOperationInTranscript({ rows, lines }) {
  const pending = new Set()
  for (const row of rows) {
    for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
      if (row.type === 'assistant' && block.type === 'tool_use') {
        if (typeof block.id !== 'string' || !block.id) return true
        pending.add(block.id)
      } else if (row.type === 'user' && block.type === 'tool_result') {
        pending.delete(block.tool_use_id)
      }
    }
  }
  if (pending.size) return true
  const index = rows.findLastIndex((row) => row.type === 'attachment' && row.attachment?.type === 'hook_deferred_tool')
  if (index < 0) return false
  const toolUseID = rows[index].attachment.toolUseID
  return typeof toolUseID !== 'string' || !toolUseID
    || !lines.slice(index + 1).some((line) => line.includes('"tool_use_id":"' + toolUseID + '"'))
}

export async function nativeTranscriptHasDeferredOperation({ path, allowMissing = false, parentFork, nativeSessionId }) {
  let transcript
  try {
    transcript = await scanNativeTranscript(path, {
      allowMissing: allowMissing && !parentFork,
      expectedSessionId: parentFork ? nativeSessionId : undefined,
    })
    if (parentFork) {
      if (!transcript.messageCount || !transcript.sessionIdentityMatches) {
        throw new Error('native fork child has no complete current history')
      }
    }
  }
  catch (error) {
    if (error?.code !== 'ENOENT' || !parentFork || parentFork.childTranscript !== path) throw error
    transcript = await inspectNativeForkSource(parentFork, nativeSessionId)
    return hasDeferredOperationInTranscript(transcript)
  }
  return transcript.hasDeferredOperation
}

/** Native parser only: a persisted card or an attachment without its original
 * solo assistant operation never establishes a recoverable no-effect point. */
export async function inspectNativeDeferredCheckpoint({ path, nativeSessionId, toolUseID, inputDigest,
  includeConsumed = false, checkpointUuid }) {
  if (!validRoot(nativeSessionId) || typeof toolUseID !== 'string' || !/^toolu_[A-Za-z0-9]+$/.test(toolUseID)
    || typeof inputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(inputDigest)) return null
  try {
    let previousAssistant = null
    let candidate = null
    const firstPass = await forEachNativeTranscriptRow(path, {}, (row, line, offset) => {
      if (row.type === 'assistant' && Array.isArray(row.message?.content)
        && row.message.content.some((block) => block.type === 'tool_use' && block.id === toolUseID)) {
        previousAssistant = {
          messageId: row.message.id,
          sessionId: row.sessionId,
          version: row.version,
          uuid: row.uuid,
        }
      }

      if (row.type === 'attachment' && row.attachment?.type === 'hook_deferred_tool'
        && (!checkpointUuid || row.uuid === checkpointUuid)) {
        const attachment = row.attachment
        candidate = {
          valid: row.sessionId === nativeSessionId && row.version === '2.1.237'
            && typeof row.uuid === 'string' && row.uuid.length > 0
            && attachment.toolUseID === toolUseID && attachment.toolName === 'Bash'
            && attachment.hookEvent === 'PreToolUse'
            && nativeInputDigest(attachment.toolInput) === inputDigest,
          checkpointUuid: row.uuid,
          checkpointDigest: createHash('sha256').update(line).digest('hex'),
          checkpointOffset: offset,
          checkpointVersion: row.version,
          assistant: previousAssistant,
          consumed: false,
        }
      } else if (candidate && line.includes('"tool_use_id":"' + toolUseID + '"')) {
        candidate.consumed = true
      }
    })

    if (!candidate?.valid || candidate.consumed && !includeConsumed) return null
    if (firstPass.byteLength - candidate.checkpointOffset > 1024n * 1024n
      && !(includeConsumed && candidate.consumed)) return null

    const assistant = candidate.assistant
    if (!assistant || typeof assistant.messageId !== 'string' || !assistant.messageId
      || assistant.sessionId !== nativeSessionId || assistant.version !== '2.1.237'
      || typeof assistant.uuid !== 'string' || !assistant.uuid) return null

    let batchRowsValid = true
    let toolCount = 0
    let tool
    const secondPass = await forEachNativeTranscriptRow(path, {}, (row) => {
      if (row.type !== 'assistant' || row.message?.id !== assistant.messageId) return
      if (row.sessionId !== nativeSessionId || row.version !== '2.1.237'
        || !Array.isArray(row.message.content)) {
        batchRowsValid = false
        return
      }
      for (const block of row.message.content) {
        if (block.type !== 'tool_use') continue
        toolCount += 1
        if (toolCount === 1) tool = block
      }
    })
    if (firstPass.identity !== secondPass.identity || firstPass.byteLength !== secondPass.byteLength) {
      throw Object.assign(new Error('native transcript changed between checkpoint scans'), { code: 'NATIVE_TRANSCRIPT_INVALID' })
    }
    if (!batchRowsValid || toolCount !== 1 || tool?.name !== 'Bash'
      || nativeInputDigest(tool.input) !== inputDigest) return null

    return { nativeSessionId, toolUseID, inputDigest, toolName: 'Bash',
      checkpointUuid: candidate.checkpointUuid, assistantUuid: assistant.uuid,
      nativeVersion: candidate.checkpointVersion, checkpointDigest: candidate.checkpointDigest,
      ...(includeConsumed ? { consumed: candidate.consumed } : {}) }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'NATIVE_TRANSCRIPT_INVALID' || error instanceof SyntaxError) return null
    throw new Error('native deferred checkpoint is unreadable')
  }
}

async function writeNativeSignal(name, input, env) {
  const launch = JSON.parse(env[launchKey] ?? 'null')
  const directory = env[signalKey]
  if (!launch?.launchNonce || !launch.incarnationId || !directory) throw new Error('missing current native launch')
  const payload = JSON.stringify({ launch, native: input })
  if (Buffer.byteLength(payload) > 65_536) throw new Error('native signal input too large')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const staging = join(directory, `signal-${randomUUID()}.tmp`)
  try {
    await writeFile(staging, payload, { mode: 0o600 })
    await rename(staging, join(directory, name))
  } finally { await rm(staging, { force: true }) }
}

export async function writeNativeSessionSignal(input, env = process.env) {
  if (!input || input.hook_event_name !== 'SessionStart' || typeof input.session_id !== 'string'
    || !validRoot(input.session_id) || !sessionStartSources.has(input.source)) {
    throw new Error('invalid native SessionStart')
  }
  if (input.source === 'compact') {
    // Compaction continues the admitted session; it is not another launch.
    // Keep the receipt that selected its current root, including a clear,
    // so the statusline can still prove it. Changed roots/launches remain visible.
    try {
      const prior = JSON.parse(await readFile(join(env[signalKey], 'session-start.json'), 'utf8'))
      if (canonicalJson(prior.launch) === canonicalJson(JSON.parse(env[launchKey] ?? 'null'))
        && ['startup', 'resume', 'clear'].includes(prior.native?.source)
        && ['session_id', 'cwd', 'transcript_path'].every(key => prior.native[key] === input[key])) return
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
  }
  await writeNativeSignal('session-start.json', input, env)
}

async function terminalStatusLine(input, bytes, env = process.env) {
  if (!validRoot(input?.session_id) || input.version !== '2.1.263'
    || typeof input.transcript_path !== 'string' || !input.transcript_path.startsWith('/')
    || typeof input.model?.id !== 'string' || !input.model.id
    || typeof input.workspace?.current_dir !== 'string'
    || !Number.isSafeInteger(input.context_window?.context_window_size)
    || input.context_window.context_window_size <= 0) throw new Error('invalid native post-load status')
  // Compose the ordinary selected command. The native CLI merges these
  // supported sources in this order; our injected command supplies evidence
  // without changing the selected command's stdin or stdout.
  let selected
  for (const path of [join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? '', '.claude'), 'settings.json'),
    join(process.cwd(), '.claude/settings.json'), join(process.cwd(), '.claude/settings.local.json'),
    '/etc/claude-code/managed-settings.json']) {
    try {
      const settingsBytes = await readFile(path)
      if (settingsBytes.length > 1024 * 1024) throw new Error('native status settings too large')
      const settings = JSON.parse(settingsBytes)
      if (Object.hasOwn(settings, 'statusLine')) selected = settings.statusLine
    } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
  if (env.FRESHELL_NATIVE_STATUSLINE_SETTINGS) selected = JSON.parse(env.FRESHELL_NATIVE_STATUSLINE_SETTINGS)
  await writeNativeSignal('statusline-loaded.json', input, env)
  if (!selected?.command) return
  if (selected.type !== 'command' || typeof selected.command !== 'string'
    || selected.command.includes('native-session-channel.mjs --status-line')) throw new Error('invalid selected native status command')
  await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', selected.command], { env, stdio: ['pipe', 'inherit', 'inherit'] })
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error('selected native status command failed')))
    child.stdin.on('error', () => {})
    child.stdin.end(bytes)
  })
}

export async function createNativeSessionChannel({ launch, directory, timeoutMs = 50_000, signal, allowFork = false,
  expectedNativeSessionId } = {}) {
  if (!launch?.launchNonce || !launch.incarnationId) throw new Error('missing current native launch')
  const ownedDirectory = join(directory ?? tmpdir(), `freshell-native-${randomUUID()}`)
  await mkdir(ownedDirectory, { recursive: true, mode: 0o700 })
  const env = { [launchKey]: JSON.stringify(launch), [signalKey]: ownedDirectory }
  const settings = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(ownPath)}` }] }] } }
  let observedNativeSessionId = expectedNativeSessionId ?? launch.requestedNativeSessionId
  return {
    env, settings, directory: ownedDirectory,
    cleanup: () => rm(ownedDirectory, { recursive: true, force: true }),
    async waitReady(query, { clearFrom, clearTo } = {}) {
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
            || !sessionStartSources.has(value.native.source)) throw new Error('invalid native SessionStart')
          if (value.native.source === 'fork' && !allowFork) throw new Error('unexpected native fork')
          const expected = observedNativeSessionId
          const nativeClear = clearFrom === expected && clearTo === value.native.session_id
            && value.native.source === 'clear'
          if (clearFrom !== undefined && !nativeClear) {
            // The next init and the hook's atomic file publication are separate
            // native channels. An unchanged prior receipt is not the new proof.
            if (value.native.session_id === expected) {
              await new Promise((resolve) => setTimeout(resolve, 5))
              continue
            }
            throw new Error('native clear did not acknowledge its exact new root')
          }
          if (expected && value.native.session_id !== expected && !nativeClear) throw new Error('wrong native root')
          if (initialized) {
            observedNativeSessionId = value.native.session_id
            return { nativeSessionId: value.native.session_id, native: value.native,
              evidenceDigest: createHash('sha256').update(bytes).digest('hex') }
          }
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
    if (process.argv[2] === '--status-line') await terminalStatusLine(JSON.parse(input), input)
    else {
      await writeNativeSessionSignal(JSON.parse(input))
      process.stdout.write('{}\n')
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ severity: 'error', component: 'native-session-hook', message: error.message })}\n`)
    process.exitCode = 1
  }
}
