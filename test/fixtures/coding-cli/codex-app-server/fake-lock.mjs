// Real exclusive per-thread writer locks, held the way Codex holds them.
//
// Linux: a real exclusive flock(2) held by THIS process's own open file
// description. Node has no flock(); util-linux `flock -x -n 3` locks the
// description we pass as fd 3 and exits — the lock stays with our fd and
// disappears exactly when this process closes it or dies (same semantics as
// Codex's O_CLOEXEC File::try_lock). /proc/locks shows the exited flock(1) pid
// in the pid column, so holders are attributed by file descriptor
// (/proc/<pid>/fdinfo lock lines), which names this process.
//
// Off Linux: one compiled `fake-codex-lock-holder` (FAKE_CODEX_LOCK_HOLDER) per
// held thread, which takes the lock with Rust's File::try_lock exactly as Codex
// does (LockFileEx on Windows) and keeps it until its stdin reaches end of file.
// Its stdin pipe stays open for the thread's lifetime, so the lock ends with an
// unload or with this process.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const onLinux = process.platform === 'linux'
const held = new Map() // threadId -> fd (Linux) | holder ChildProcess (off Linux)
const pending = new Map() // threadId -> in-flight acquisition (off Linux)

export function lockPath(codexHome, threadId) {
  return path.join(codexHome, 'thread-writer-locks', `${threadId}.lock`)
}

function conflict(threadId) {
  return { ok: false, message: `thread-store conflict: thread ${threadId} already has an active writer` }
}

// Returns `{ ok }` synchronously on Linux and a Promise of it off Linux; callers await.
export function acquireThreadLock(codexHome, threadId) {
  if (held.has(threadId)) return { ok: true }
  const file = lockPath(codexHome, threadId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (onLinux) return acquireWithFlock(file, threadId)
  if (!pending.has(threadId)) {
    pending.set(threadId, acquireWithHolder(file, threadId).finally(() => pending.delete(threadId)))
  }
  return pending.get(threadId)
}

function acquireWithFlock(file, threadId) {
  const fd = fs.openSync(file, 'a')
  const r = spawnSync('flock', ['-x', '-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] })
  if (r.error || r.status !== 0) {
    fs.closeSync(fd)
    // flock -n exits 1 when another description holds the lock; anything else
    // (flock missing, bad fd) is a broken fixture, never a silent conflict.
    if (r.error || r.status !== 1) throw r.error ?? new Error(`flock exited ${r.status} for ${file}`)
    return conflict(threadId)
  }
  held.set(threadId, fd)
  return { ok: true }
}

function acquireWithHolder(file, threadId) {
  const exe = process.env.FAKE_CODEX_LOCK_HOLDER
  if (!exe) throw new Error('FAKE_CODEX_LOCK_HOLDER is required off Linux')
  const holder = spawn(exe, [file], { stdio: ['pipe', 'pipe', 'ignore'] })
  return new Promise((resolve, reject) => {
    const lines = readline.createInterface({ input: holder.stdout })
    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      lines.close()
      fn(value)
    }
    holder.once('error', (error) => settle(reject, error))
    // 'close' (not 'exit'): it fires only after stdout is drained, so a
    // `conflict` line printed just before exiting is always read first.
    holder.once('close', (code) => settle(reject, new Error(`fake-codex-lock-holder exited ${code} before answering`)))
    lines.once('line', (line) => {
      const answer = line.trim()
      if (answer === 'locked') {
        held.set(threadId, holder)
        settle(resolve, { ok: true })
      } else if (answer === 'conflict') {
        settle(resolve, conflict(threadId))
      } else {
        settle(reject, new Error(`fake-codex-lock-holder answered ${JSON.stringify(answer)}`))
      }
    })
  })
}

// Releases a held thread lock and deletes its lock file (Codex's graceful unload
// unlinks it). Resolves once the lock is gone.
export async function releaseThreadLock(codexHome, threadId) {
  const lock = held.get(threadId)
  if (lock === undefined) return
  held.delete(threadId)
  if (onLinux) {
    fs.closeSync(lock)
  } else if (lock.exitCode === null && lock.signalCode === null) {
    await new Promise((resolve) => {
      lock.once('exit', resolve)
      lock.stdin.end()
    })
  }
  fs.rmSync(lockPath(codexHome, threadId), { force: true })
}

export function heldThreadIds() {
  return [...held.keys()]
}
