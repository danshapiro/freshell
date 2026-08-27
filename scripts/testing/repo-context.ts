import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** The small environment surface needed by coordinator/repository discovery. */
export type RepositoryEnvironment = Readonly<Record<string, string | undefined>>

const repoRootCache = new Map<string, string>()
const checkoutRootCache = new Map<string, string>()
const commonDirCache = new Map<string, string | undefined>()
const execFileAsync = promisify(execFile)

/** Clear repository discovery caches between isolated test fixtures. */
export function clearRepoRootCache(): void {
  repoRootCache.clear()
  checkoutRootCache.clear()
  commonDirCache.clear()
}

/** Resolve a path to its containing repository, collapsing Git worktrees. */
export async function resolveGitRepoRoot(cwd: string): Promise<string> {
  if (!cwd) return cwd

  const normalized = normalizeGitPathInput(cwd)
  if (!normalized) return cwd

  const cached = repoRootCache.get(normalized)
  if (cached !== undefined) return cached

  try {
    const result = await walkForGitRoot(normalized, 'repo')
    repoRootCache.set(normalized, result)
    return result
  } catch {
    repoRootCache.set(normalized, normalized)
    return normalized
  }
}

/** Resolve a path to the checkout root without collapsing a Git worktree. */
export async function resolveGitCheckoutRoot(cwd: string): Promise<string> {
  if (!cwd) return cwd

  const normalized = normalizeGitPathInput(cwd)
  if (!normalized) return cwd

  const cached = checkoutRootCache.get(normalized)
  if (cached !== undefined) return cached

  try {
    const result = await walkForGitRoot(normalized, 'checkout')
    checkoutRootCache.set(normalized, result)
    return result
  } catch {
    checkoutRootCache.set(normalized, normalized)
    return normalized
  }
}

/** Resolve the shared `.git` directory for a checkout or worktree. */
export async function resolveGitCommonDir(cwd: string): Promise<string | undefined> {
  if (!cwd) return undefined

  const normalized = normalizeGitPathInput(cwd)
  if (!normalized) return undefined

  if (commonDirCache.has(normalized)) return commonDirCache.get(normalized)

  try {
    const result = await walkForGitCommonDir(normalized)
    commonDirCache.set(normalized, result)
    return result
  } catch {
    commonDirCache.set(normalized, undefined)
    return undefined
  }
}

/** Resolve branch and dirty state for a checkout, returning an empty object on Git errors. */
export async function resolveGitBranchAndDirty(cwd: string): Promise<{ branch?: string; isDirty?: boolean }> {
  const normalized = normalizeGitPathInput(cwd)
  if (!normalized) return {}

  const checkoutRoot = await resolveGitCheckoutRoot(normalized)

  try {
    const [branch, status] = await Promise.all([
      resolveGitBranch(checkoutRoot),
      execFileAsync('git', ['-C', checkoutRoot, 'status', '--porcelain']),
    ])

    if (!branch && !status.stdout.trim()) return {}

    return {
      ...(branch ? { branch } : {}),
      isDirty: status.stdout.trim().length > 0,
    }
  } catch {
    return {}
  }
}

/** Return a stable integer epoch-millisecond mtime for shared read models. */
export function statMtimeMs(stat: { mtimeMs: number; mtime: Date }): number {
  return Math.floor(stat.mtimeMs || stat.mtime.getTime())
}

/** Resolve the original invocation directory without depending on a global NodeJS type. */
export function resolveInvocationCwd(envVars: RepositoryEnvironment = process.env): string | undefined {
  const candidate = envVars.INIT_CWD || envVars.PWD
  if (candidate) return candidate
  try {
    return process.cwd()
  } catch {
    return undefined
  }
}

function normalizeGitPathInput(cwd: string): string | undefined {
  // Relative paths describe the caller's directory, not the coordinator's
  // process cwd, and therefore cannot be made reliable here.
  if (cwd.startsWith('~')) {
    return path.resolve(os.homedir(), cwd.slice(cwd.startsWith('~/') ? 2 : 1))
  }
  if (path.isAbsolute(cwd)) return path.resolve(cwd)
  return undefined
}

async function resolveGitBranch(checkoutRoot: string): Promise<string | undefined> {
  try {
    const symbolic = await execFileAsync('git', ['-C', checkoutRoot, 'symbolic-ref', '--short', 'HEAD'])
    const branch = symbolic.stdout.trim()
    if (branch) return branch
  } catch {
    // Detached heads or older Git layouts can fail symbolic-ref.
  }

  try {
    const revParse = await execFileAsync('git', ['-C', checkoutRoot, 'rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = revParse.stdout.trim()
    return branch || undefined
  } catch {
    return undefined
  }
}

async function walkForGitRoot(startDir: string, mode: 'repo' | 'checkout'): Promise<string> {
  let current = startDir

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const gitPath = path.join(current, '.git')

    try {
      const gitStat = await fsp.lstat(gitPath)

      if (gitStat.isDirectory()) {
        if (!await isGitDirectory(gitPath)) return startDir
        return current
      }

      if (gitStat.isFile()) {
        if (mode === 'checkout') return current
        const content = await fsp.readFile(gitPath, 'utf8')
        const match = content.match(/^gitdir:\s*(.+)/m)
        if (match) {
          const gitdir = path.resolve(path.dirname(gitPath), match[1].trim())
          return resolveFromGitFile(current, gitdir)
        }
        return current
      }
    } catch {
      // No .git entry at this level; continue walking upwards.
    }

    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  return startDir
}

async function resolveFromGitFile(dotGitDir: string, gitdir: string): Promise<string> {
  if (gitdir.includes('/.git/modules/') || gitdir.includes('\\.git\\modules\\')) {
    return dotGitDir
  }

  if (gitdir.includes('/.git/worktrees/') || gitdir.includes('\\.git\\worktrees\\')) {
    return resolveWorktreeRoot(dotGitDir, gitdir)
  }

  return dotGitDir
}

async function resolveWorktreeRoot(dotGitDir: string, gitdir: string): Promise<string> {
  try {
    const commondirContent = await fsp.readFile(path.join(gitdir, 'commondir'), 'utf8')
    const commonDir = path.resolve(gitdir, commondirContent.trim())
    return path.dirname(commonDir)
  } catch {
    // Fall through to the path heuristic for old/incomplete worktree metadata.
  }

  const parts = gitdir.split(path.sep)
  const worktreesIndex = parts.lastIndexOf('worktrees')
  if (worktreesIndex >= 2 && parts[worktreesIndex - 1] === '.git') {
    const gitDirParent = parts.slice(0, worktreesIndex - 1)
    return gitDirParent.join(path.sep) || path.sep
  }

  return dotGitDir
}

async function walkForGitCommonDir(startDir: string): Promise<string | undefined> {
  let current = startDir

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const gitPath = path.join(current, '.git')

    try {
      const gitStat = await fsp.lstat(gitPath)
      if (gitStat.isDirectory()) {
        if (!await isGitDirectory(gitPath)) return undefined
        return gitPath
      }

      if (gitStat.isFile()) {
        const content = await fsp.readFile(gitPath, 'utf8')
        const match = content.match(/^gitdir:\s*(.+)/m)
        if (!match) return undefined
        const gitdir = path.resolve(path.dirname(gitPath), match[1].trim())
        return resolveCommonDirFromGitFile(gitdir)
      }
    } catch {
      // No .git entry at this level; continue walking upwards.
    }

    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  return undefined
}

async function isGitDirectory(gitPath: string): Promise<boolean> {
  try {
    const headStat = await fsp.stat(path.join(gitPath, 'HEAD'))
    return headStat.isFile()
  } catch {
    return false
  }
}

async function resolveCommonDirFromGitFile(gitdir: string): Promise<string> {
  try {
    const commondirContent = await fsp.readFile(path.join(gitdir, 'commondir'), 'utf8')
    return path.resolve(gitdir, commondirContent.trim())
  } catch {
    // Not all gitdir layouts use a commondir file.
  }

  const worktreesToken = `${path.sep}.git${path.sep}worktrees${path.sep}`
  const worktreesIndex = gitdir.lastIndexOf(worktreesToken)
  if (worktreesIndex >= 0) {
    return gitdir.slice(0, worktreesIndex + `${path.sep}.git`.length)
  }

  return gitdir
}
