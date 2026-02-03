import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'

export function resolveUserPath(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return trimmed
  if (trimmed === '~') {
    return os.homedir()
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2))
  }
  return path.resolve(trimmed)
}

export function isReachableDirectorySync(input: string): { ok: boolean; resolvedPath: string } {
  const resolvedPath = resolveUserPath(input)
  try {
    const stat = fs.statSync(resolvedPath)
    return { ok: stat.isDirectory(), resolvedPath }
  } catch {
    return { ok: false, resolvedPath }
  }
}

export async function isReachableDirectory(input: string): Promise<{ ok: boolean; resolvedPath: string }> {
  const resolvedPath = resolveUserPath(input)
  try {
    const stat = await fsp.stat(resolvedPath)
    return { ok: stat.isDirectory(), resolvedPath }
  } catch {
    return { ok: false, resolvedPath }
  }
}
