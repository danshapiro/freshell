import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

function ensurePngExtension(name: string): string {
  return name.toLowerCase().endsWith('.png') ? name : `${name}.png`
}

function isExplicitDirectoryInput(input: string): boolean {
  return input.endsWith(path.sep) || input.endsWith('/')
}

function normalizeScreenshotBaseName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error('name required')
  }

  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error('name must not contain path separators')
  }

  if (trimmed === '.' || trimmed === '..') {
    throw new Error('invalid screenshot name')
  }

  return ensurePngExtension(trimmed)
}

export async function resolveScreenshotOutputPath(opts: {
  name: string
  pathInput?: string
}): Promise<string> {
  const baseName = normalizeScreenshotBaseName(opts.name)
  if (!opts.pathInput) {
    return path.resolve(path.join(os.tmpdir(), baseName))
  }

  const candidate = path.resolve(opts.pathInput)
  let stat: Awaited<ReturnType<typeof fs.stat>> | null = null
  try {
    stat = await fs.stat(candidate)
  } catch {
    stat = null
  }

  if (stat?.isDirectory() || (!stat && isExplicitDirectoryInput(opts.pathInput))) {
    await fs.mkdir(candidate, { recursive: true })
    return path.join(candidate, baseName)
  }

  await fs.mkdir(path.dirname(candidate), { recursive: true })
  return candidate.toLowerCase().endsWith('.png') ? candidate : `${candidate}.png`
}
