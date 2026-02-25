import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

function ensurePngExtension(name: string): string {
  return path.extname(name).toLowerCase() === '.png' ? name : `${name}.png`
}

function isExplicitDirectoryInput(input: string): boolean {
  return input.endsWith(path.sep) || input.endsWith('/')
}

function normalizeScreenshotBaseName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error('name required')
  }

  if (trimmed.includes('\0')) {
    throw new Error('name must not contain null bytes')
  }

  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error('name must not contain path separators')
  }

  if (trimmed === '.' || trimmed === '..') {
    throw new Error('invalid screenshot name')
  }

  return ensurePngExtension(trimmed)
}

function normalizePathInput(pathInput: string): string {
  const trimmed = pathInput.trim()
  if (!trimmed) {
    throw new Error('path must not be empty')
  }

  if (trimmed.includes('\0')) {
    throw new Error('path must not contain null bytes')
  }

  return trimmed
}

export async function resolveScreenshotOutputPath(opts: {
  name: string
  pathInput?: string
}): Promise<string> {
  const baseName = normalizeScreenshotBaseName(opts.name)
  if (!opts.pathInput) {
    return path.resolve(path.join(os.tmpdir(), baseName))
  }

  const normalizedPathInput = normalizePathInput(opts.pathInput)
  const candidate = path.resolve(normalizedPathInput)
  let stat: Awaited<ReturnType<typeof fs.stat>> | null = null
  try {
    stat = await fs.stat(candidate)
  } catch {
    stat = null
  }

  if (stat?.isDirectory() || (!stat && isExplicitDirectoryInput(normalizedPathInput))) {
    await fs.mkdir(candidate, { recursive: true })
    return path.join(candidate, baseName)
  }

  await fs.mkdir(path.dirname(candidate), { recursive: true })
  return path.extname(candidate).toLowerCase() === '.png' ? candidate : `${candidate}.png`
}
