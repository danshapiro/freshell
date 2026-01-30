import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect } from 'vitest'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, '../../..')
const serverDir = path.join(repoRoot, 'server')

const allowedExtensions = new Set(['.js', '.json'])

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walk(fullPath))
      continue
    }
    if (entry.isFile() && fullPath.endsWith('.ts')) {
      files.push(fullPath)
    }
  }

  return files
}

function collectRelativeImports(source: string): string[] {
  const specifiers: string[] = []
  const patterns = [
    /from\s+['"](\.{1,2}\/[^'"]+)['"]/g,
    /import\s+['"](\.{1,2}\/[^'"]+)['"]/g,
    /import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  ]

  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source)) !== null) {
      specifiers.push(match[1])
    }
  }

  return specifiers
}

describe('server ESM import specifiers', () => {
  it('uses explicit .js extensions for relative imports', () => {
    const violations: string[] = []

    for (const filePath of walk(serverDir)) {
      const contents = fs.readFileSync(filePath, 'utf-8')
      const specifiers = collectRelativeImports(contents)
      for (const specifier of specifiers) {
        const ext = path.extname(specifier)
        if (!allowedExtensions.has(ext)) {
          const rel = path.relative(repoRoot, filePath)
          violations.push(`${rel}: ${specifier}`)
        }
      }
    }

    expect(violations).toEqual([])
  })
})

describe('ai-sdk dependency alignment', () => {
  it('uses a single @ai-sdk/provider version in package-lock', () => {
    const lockPath = path.join(repoRoot, 'package-lock.json')
    const raw = fs.readFileSync(lockPath, 'utf-8')
    const lock = JSON.parse(raw) as { packages?: Record<string, { version?: string }> }
    const versions = new Set<string>()

    for (const [pkgPath, pkgInfo] of Object.entries(lock.packages ?? {})) {
      if (pkgPath.endsWith('node_modules/@ai-sdk/provider') && pkgInfo?.version) {
        versions.add(pkgInfo.version)
      }
    }

    expect(Array.from(versions)).toHaveLength(1)
  })
})
