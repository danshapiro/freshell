import fs from 'node:fs'
import path from 'node:path'

const MAX_TREE_ENTRIES = 2_048
const MAX_TREE_DEPTH = 6
const MAX_JSONL_BYTES = 4 * 1024 * 1024
const MAX_JSONL_LINES = 4_096
const MAX_JSONL_LINE_BYTES = 256 * 1024

export function safeOpaqueId(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a safe opaque session id`)
  }
  return value
}

function checkedRoot(root: string, label: string): string {
  if (!path.isAbsolute(root)) throw new Error(`${label} must be absolute`)
  const stat = fs.lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory`)
  const real = fs.realpathSync(root)
  if (real !== path.resolve(root)) throw new Error(`${label} must not traverse a symlink`)
  return real
}

/** Bounded walk that fails on every symlink and returns matching regular files. */
export function findFiles(root: string, matches: (basename: string) => boolean): string[] {
  const safeRoot = checkedRoot(root, 'native history root')
  const hits: string[] = []
  let visited = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_TREE_DEPTH) throw new Error('native history tree exceeds the depth bound')
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      visited += 1
      if (visited > MAX_TREE_ENTRIES) throw new Error('native history tree exceeds the entry bound')
      const candidate = path.join(dir, entry.name)
      const stat = fs.lstatSync(candidate)
      if (stat.isSymbolicLink()) throw new Error(`native history tree contains a symlink: ${entry.name}`)
      if (stat.isDirectory()) walk(candidate, depth + 1)
      else if (stat.isFile() && matches(entry.name)) hits.push(candidate)
    }
  }
  walk(safeRoot, 0)
  return hits
}

export function findExactFiles(root: string, basename: string): string[] {
  return findFiles(root, (candidate) => candidate === basename)
}

/** Amplifier's shape is projects/<slug>/sessions/<exact-id>, never a glob guess. */
export function findExactSessionDirectories(root: string, sessionId: string): string[] {
  const safeRoot = checkedRoot(root, 'native history root')
  const hits: string[] = []
  let visited = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_TREE_DEPTH) throw new Error('native history tree exceeds the depth bound')
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      visited += 1
      if (visited > MAX_TREE_ENTRIES) throw new Error('native history tree exceeds the entry bound')
      const candidate = path.join(dir, entry.name)
      const stat = fs.lstatSync(candidate)
      if (stat.isSymbolicLink()) throw new Error(`native history tree contains a symlink: ${entry.name}`)
      if (!stat.isDirectory()) continue
      if (entry.name === sessionId && path.basename(dir) === 'sessions') hits.push(candidate)
      else walk(candidate, depth + 1)
    }
  }
  walk(safeRoot, 0)
  return hits
}

export function readBoundedRegularFile(filePath: string, label: string): Buffer {
  const before = fs.lstatSync(filePath)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`)
  if (before.size > MAX_JSONL_BYTES) throw new Error(`${label} exceeds the byte bound`)
  const noFollow = fs.constants.O_NOFOLLOW ?? 0
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow)
  try {
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} changed during safe open`)
    }
    if (opened.size > MAX_JSONL_BYTES) throw new Error(`${label} exceeds the byte bound`)
    return fs.readFileSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

export function readBoundedJsonl(filePath: string, label: string): Record<string, any>[] {
  const bytes = readBoundedRegularFile(filePath, label)
  const lines = bytes.toString('utf8').split(/\r?\n/).filter((line) => line.trim())
  if (lines.length > MAX_JSONL_LINES) throw new Error(`${label} exceeds the row bound`)
  return lines.map((line, index) => {
    if (Buffer.byteLength(line, 'utf8') > MAX_JSONL_LINE_BYTES) throw new Error(`${label} line ${index + 1} exceeds the line bound`)
    try {
      const parsed = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('row is not an object')
      return parsed
    } catch (error) {
      throw new Error(`${label} line ${index + 1} is not valid JSON: ${String(error)}`)
    }
  })
}
