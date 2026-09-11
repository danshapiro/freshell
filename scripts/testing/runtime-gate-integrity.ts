/** Fail-closed evidence and candidate checks shared by runtime qualification. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

export type RuntimeCandidate = {
  sha: string
  dirty: boolean
  diffHash: string
  statusHash: string
}

/** Hash source changes; never copy source contents or credentials into receipts. */
export function captureRuntimeCandidate(repoRoot: string): RuntimeCandidate {
  const git = (args: string[]) => execFileSync('git', args, {
    cwd: repoRoot,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const sha = git(['rev-parse', '--verify', 'HEAD']).toString('utf8').trim()
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const diff = git(['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--'])
  const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex')
  return { sha, dirty: status.length > 0, diffHash: hash(diff), statusHash: hash(status) }
}

export function candidateIntegrityFailures(
  expectedSha: string,
  before: RuntimeCandidate,
  after: RuntimeCandidate,
): string[] {
  const failures: string[] = []
  if (before.sha !== expectedSha || after.sha !== expectedSha) {
    failures.push('candidate commit changed during qualification')
  }
  if (before.dirty) failures.push('candidate had uncommitted inputs before qualification')
  if (after.dirty) failures.push('candidate has uncommitted inputs after qualification')
  if (before.diffHash !== after.diffHash || before.statusHash !== after.statusHash) {
    failures.push('candidate inputs changed during qualification')
  }
  return failures
}

export type RuntimeArtifactAudit = {
  missing: string[]
  invalid: Array<{ artifact: string; reason: string }>
}

// JSON control records are bounded independently of potentially large binary
// browser traces. JSONL is streamed so a soak log cannot exhaust the gate.
const MAX_JSON_BYTES = 16 * 1024 * 1024
const MAX_JSONL_RECORD_BYTES = 1024 * 1024
const MAX_DIRECTORY_ENTRIES = 100_000
const MAX_DIRECTORY_DEPTH = 32

function requireRecord(text: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Native parser errors can include a fragment of the input, including a
    // deliberately injected credential in a redaction test.
    throw new Error('invalid JSON record')
  }
  if (parsed === null || typeof parsed !== 'object') throw new Error('JSON evidence is not a record')
}

function validateJsonLines(fd: number): void {
  const buffer = Buffer.alloc(64 * 1024)
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let records = 0
  const consume = (line: string) => {
    if (Buffer.byteLength(line, 'utf8') > MAX_JSONL_RECORD_BYTES) throw new Error('JSONL record exceeds the evidence bound')
    if (line.trim() === '') return
    requireRecord(line)
    records += 1
  }
  for (;;) {
    const count = fs.readSync(fd, buffer, 0, buffer.length, null)
    pending += count === 0 ? decoder.end() : decoder.write(buffer.subarray(0, count))
    let end: number
    while ((end = pending.indexOf('\n')) !== -1) {
      consume(pending.slice(0, end))
      pending = pending.slice(end + 1)
    }
    if (Buffer.byteLength(pending, 'utf8') > MAX_JSONL_RECORD_BYTES) throw new Error('JSONL record exceeds the evidence bound')
    if (count === 0) break
  }
  if (pending.length > 0) consume(pending)
  if (records === 0) throw new Error('JSONL evidence has no records')
}

function validateFile(file: string, stat: fs.Stats): void {
  if (!stat.isFile()) throw new Error('required artifact is not a regular file')
  if (stat.size === 0) throw new Error('required artifact is empty')
  const extension = path.extname(file).toLowerCase()
  if (extension !== '.json' && extension !== '.jsonl') return
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    if (extension === '.json') {
      if (stat.size > MAX_JSON_BYTES) throw new Error('JSON artifact exceeds the evidence bound')
      requireRecord(fs.readFileSync(fd, 'utf8'))
    } else {
      validateJsonLines(fd)
    }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * A directory receipt must contain real retained evidence, not an empty tree,
 * a link to a previous campaign, or a link cycle. Reject every symlink rather
 * than guessing whether its current target will remain safe after handoff.
 */
function validateDirectory(directory: string): void {
  let entries = 0
  let files = 0
  const visit = (current: string, depth: number) => {
    if (depth > MAX_DIRECTORY_DEPTH) throw new Error('evidence directory is too deep')
    for (const name of fs.readdirSync(current)) {
      if (++entries > MAX_DIRECTORY_ENTRIES) throw new Error('evidence directory has too many entries')
      const target = path.join(current, name)
      const stat = fs.lstatSync(target)
      if (stat.isSymbolicLink()) throw new Error('evidence contains a symbolic link')
      if (stat.isDirectory()) visit(target, depth + 1)
      else {
        validateFile(target, stat)
        files += 1
      }
    }
  }
  visit(directory, 0)
  if (files === 0) throw new Error('evidence directory has no nonempty files')
}

/** Auditing never throws: even malformed evidence needs a durable FAIL summary. */
export function auditRuntimeArtifacts(evidenceDir: string, declared: readonly string[]): RuntimeArtifactAudit {
  const result: RuntimeArtifactAudit = { missing: [], invalid: [] }
  const root = path.resolve(evidenceDir)
  for (const artifact of new Set(declared)) {
    if (artifact === 'summary.json') continue // Written by the caller after this audit.
    try {
      if (typeof artifact !== 'string' || artifact.length === 0 || path.isAbsolute(artifact)
        || artifact.includes('\\') || artifact.includes('\0')) {
        throw new Error('unsafe artifact path')
      }
      const directory = artifact.endsWith('/')
      const parts = (directory ? artifact.slice(0, -1) : artifact).split('/')
      if (parts.some((part) => part === '' || part === '.' || part === '..')) throw new Error('unsafe artifact path')
      let target = root
      let stat: fs.Stats | undefined
      for (let index = 0; index < parts.length; index += 1) {
        target = path.join(target, parts[index])
        stat = fs.lstatSync(target)
        if (stat.isSymbolicLink()) throw new Error('artifact or ancestor is a symbolic link')
        if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('artifact ancestor is not a directory')
      }
      if (!stat) throw new Error('invalid artifact path')
      if (directory) {
        if (!stat.isDirectory()) throw new Error('required artifact is not a directory')
        validateDirectory(target)
      } else {
        validateFile(target, stat)
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') result.missing.push(artifact)
      else result.invalid.push({
        artifact,
        reason: code ? `artifact read failed (${code})` : error instanceof Error ? error.message : 'artifact validation failed',
      })
    }
  }
  return result
}
