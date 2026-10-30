import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { readAmplifierNativeHistory } from './amplifier.js'
import { readClaudeNativeHistory } from './claude.js'
import { readCodexNativeHistory, readCodexNativeObservation, selectCodexNativeSource } from './codex.js'
import { readOpenCodeNativeHistory, readOpenCodeNativeObservation } from './opencode.js'
import { findExactFiles, findExactSessionDirectories, isAbsentClaudeProjectsRoot, safeOpaqueId, readBoundedJsonl } from './safe-io.js'

const MAX_RAW_BYTES = 4 * 1024 * 1024
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const identity = (stat: fs.BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)

/** Read one complete stable descriptor; the semantic reader sees only these retained bytes. */
function snapshot(filename: string) {
  const before = fs.lstatSync(filename, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || fs.realpathSync(filename) !== filename || before.size > BigInt(MAX_RAW_BYTES)) {
    throw new Error('native source is not a bounded canonical regular file')
  }
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const opened = fs.fstatSync(fd, { bigint: true })
    const bytes = Buffer.alloc(MAX_RAW_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null)
      if (count === 0) break
      length += count
    }
    const after = fs.fstatSync(fd, { bigint: true })
    if (!length || length > MAX_RAW_BYTES || JSON.stringify(identity(before)) !== JSON.stringify(identity(opened))
      || JSON.stringify(identity(opened)) !== JSON.stringify(identity(after))
      || JSON.stringify(identity(after)) !== JSON.stringify(identity(fs.lstatSync(filename, { bigint: true })))) {
      throw new Error('native source changed or exceeds the byte bound')
    }
    const raw = bytes.subarray(0, length)
    if (filename.endsWith('.jsonl') && raw.at(-1) !== 0x0a) throw new Error('native source has incomplete EOF')
    return { path: filename, identity: identity(after), completeEof: true as const, sha256: digest(raw), bytesBase64: raw.toString('base64') }
  } finally { fs.closeSync(fd) }
}

const SQLITE_BACKUP = String.raw`
import pathlib,sqlite3,sys,base64
file=pathlib.Path(sys.argv[1]);assert file.is_file() and not file.is_symlink() and file.resolve()==file
for suffix in ['-wal','-shm']:
 companion=pathlib.Path(str(file)+suffix)
 assert not companion.exists() or companion.is_file() and not companion.is_symlink() and companion.resolve()==companion
with sqlite3.connect(file.as_uri()+'?mode=ro',uri=True) as source,sqlite3.connect(':memory:') as memory:
 source.execute('PRAGMA query_only=ON');source.execute('PRAGMA trusted_schema=OFF');source.backup(memory)
 raw=memory.serialize();assert 0<len(raw)<=4*1024*1024
print(base64.b64encode(raw).decode())
`

function exact(files: string[]): string {
  if (files.length !== 1) throw new Error('native source is absent or ambiguous')
  return files[0]!
}

/** Existing history projection plus a private raw adjunct, with unchanged provider/source/root arguments. */
export function captureNativeHistory(provider: string, source: string, nativeSessionId: string, allowEmptyBoundary = false) {
  const root = safeOpaqueId(nativeSessionId, 'native root')
  const claudeFiles = provider === 'claude' && !(allowEmptyBoundary && isAbsentClaudeProjectsRoot(source))
    ? findExactFiles(source, `${root}.jsonl`) : []
  if (provider === 'claude' && allowEmptyBoundary && claudeFiles.length === 0) {
    return { schemaVersion: 1 as const, provider: 'claude' as const, nativeSessionId: root, turns: [], rawSource: null }
  }
  const filename = provider === 'claude' ? exact(claudeFiles)
    : provider === 'codex' ? selectCodexNativeSource(source, root)
      : provider === 'opencode' ? source
        : provider === 'amplifier' ? path.join(exact(findExactSessionDirectories(source, root)), 'transcript.jsonl') : null
  if (!filename) throw new Error('unsupported provider')
  const captured = snapshot(filename)
  const eventsSnapshot = provider === 'amplifier' ? snapshot(path.join(path.dirname(filename), 'events.jsonl')) : undefined
  let querySnapshotBase64: string | undefined
  if (provider === 'opencode') {
    querySnapshotBase64 = execFileSync('python3', ['-c', SQLITE_BACKUP, filename], { encoding: 'utf8', stdio: 'pipe', timeout: 30_000,
      maxBuffer: MAX_CAPTURE_BYTES }).trim()
    if (JSON.stringify(captured.identity) !== JSON.stringify(identity(fs.lstatSync(filename, { bigint: true })))) {
      throw new Error('native database changed during capture')
    }
  }
  const rawSource = { snapshot: { ...captured, ...(querySnapshotBase64 ? { querySnapshotBase64,
    querySnapshotSha256: digest(Buffer.from(querySnapshotBase64, 'base64')) } : {}) }, ...(eventsSnapshot ? { eventsSnapshot } : {}) }
  const retained = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-native-capture-'))
  try {
    const target = provider === 'amplifier' ? path.join(retained, 'project', 'sessions', root, 'transcript.jsonl')
      : path.join(retained, path.basename(filename))
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    fs.writeFileSync(target, Buffer.from(querySnapshotBase64 ?? captured.bytesBase64, 'base64'), { mode: 0o600 })
    if (eventsSnapshot) fs.writeFileSync(path.join(path.dirname(target), 'events.jsonl'), Buffer.from(eventsSnapshot.bytesBase64, 'base64'), { mode: 0o600 })
    let history
    if (provider === 'claude') {
      const rows = readBoundedJsonl(target, 'Claude retained boundary')
      history = allowEmptyBoundary && !rows.some(row => row.type === 'user' || row.type === 'assistant')
        ? { schemaVersion: 1 as const, provider: 'claude' as const, nativeSessionId: root, turns: [] }
        : readClaudeNativeHistory(retained, root)
    } else if (provider === 'codex') history = allowEmptyBoundary ? readCodexNativeObservation(retained, root).history : readCodexNativeHistory(retained, root)
    else if (provider === 'opencode') history = allowEmptyBoundary ? readOpenCodeNativeObservation(target, root).history : readOpenCodeNativeHistory(target, root)
    else history = readAmplifierNativeHistory(retained, root)
    const result = { ...history, rawSource }
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_CAPTURE_BYTES) throw new Error('native original exceeds the serialized evidence bound')
    return result
  } finally { fs.rmSync(retained, { recursive: true, force: true }) }
}

/** CLI and imported captures share the same body-free refusal boundary. */
export function runNativeHistoryProbe(capture: () => unknown): void {
  try {
    process.stdout.write(JSON.stringify(capture()))
  } catch (error) {
    // Never echo parsed content, paths, ids, or exception values from a native store.
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
      && ['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'ELOOP'].includes(error.code) ? error.code : null
    let stage = 'native_capture', reason = 'native_validation_failed'
    if (code === 'ENOENT') reason = 'filesystem_entry_missing'
    else if (code === 'EACCES' || code === 'EPERM') reason = 'permission_denied'
    else if (code) reason = 'filesystem_shape_refused'
    else if (error instanceof Error) {
      // Match only fixed local guard messages; all other causes remain unknown.
      if (error.message === 'native source is absent or ambiguous') {
        stage = 'source_selection'; reason = 'source_absent_or_ambiguous'
      } else if (error.message === 'native source has incomplete EOF') {
        stage = 'source_read'; reason = 'incomplete_source_eof'
      } else if (error.message === 'missing probe arguments' || error.message === 'unsupported provider') {
        stage = 'arguments'; reason = 'invalid_arguments'
      }
    }
    process.stderr.write(`${JSON.stringify({ severity: 'error', event: 'provider_native_history.refused', stage, reason, code })}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runNativeHistoryProbe(() => {
    const [provider, source, nativeSessionId, ...extra] = process.argv.slice(2)
    if (!provider || !source || !nativeSessionId || extra.length) throw new Error('missing probe arguments')
    return captureNativeHistory(provider, source, nativeSessionId)
  })
}
