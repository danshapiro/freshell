import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'freshell-client-artifact-'))
  temporaryDirectories.push(directory)
  return directory
}

function directoryDigest(directory: string): string | null {
  try {
    const files: string[] = []
    const visit = (current: string) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name)
        if (entry.isDirectory()) visit(path)
        else if (entry.isFile()) files.push(path)
      }
    }
    visit(directory)
    files.sort()
    const digest = createHash('sha256')
    for (const file of files) {
      digest.update(relative(directory, file))
      digest.update('\0')
      digest.update(String(statSync(file).mode & 0o777))
      digest.update('\0')
      digest.update(readFileSync(file))
      digest.update('\0')
    }
    return digest.digest('hex')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('deployment compatibility client artifact', () => {
  it(
    'typechecks and builds the exact declaration manifest outside checkout dist',
    () => {
      const checkoutDistBefore = directoryDigest(join(root, 'dist/client'))
      const outputDirectory = join(temporaryDirectory(), 'client')

      execFileSync('npm', ['run', 'typecheck:client'], {
        cwd: root,
        env: process.env,
        stdio: 'pipe',
      })
      execFileSync('npm', ['run', 'build:client'], {
        cwd: root,
        env: {
          ...process.env,
          FRESHELL_CLIENT_OUT_DIR: outputDirectory,
        },
        stdio: 'pipe',
      })

      expect(JSON.parse(readFileSync(join(outputDirectory, 'deployment-compatibility.json'), 'utf8')))
        .toEqual({
          schemaVersion: '1',
          declaration: {
            schemaVersion: '1',
            component: 'client',
            version: '0.7.5',
            supports: {
              server: {
                minInclusive: '0.7.0',
                maxExclusive: '0.7.1',
              },
            },
          },
          declarationSha256: '43c554165e167d8d5b33b22b84ce63c8aa5940cc1ba9effb29d62c85aee1c6bb',
        })
      expect(directoryDigest(join(root, 'dist/client'))).toBe(checkoutDistBefore)
    },
    120_000,
  )

  it('rejects a relative launcher output directory without writing checkout dist', () => {
    const checkoutDistBefore = directoryDigest(join(root, 'dist/client'))
    const result = spawnSync('npm', ['run', 'build:client'], {
      cwd: root,
      env: {
        ...process.env,
        FRESHELL_CLIENT_OUT_DIR: 'relative-client-output',
      },
      encoding: 'utf8',
    })

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'FRESHELL_CLIENT_OUT_DIR must be an absolute path',
    )
    expect(directoryDigest(join(root, 'dist/client'))).toBe(checkoutDistBefore)
  }, 30_000)
})
