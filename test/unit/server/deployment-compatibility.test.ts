import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  assertMutuallyCompatible,
  canonicalDeclarationBytes,
  declarationDigest,
  parseContract,
  parseDeclaration,
  projectDeclaration,
  serializeEvent,
} from '../../../scripts/deployment-compatibility.mjs'

interface CorpusCase {
  name: string
  raw: string
  expectedCode: string
  expectedCanonical?: string
  expectedSha256?: string
}

const root = fileURLToPath(new URL('../../..', import.meta.url))
const execFileAsync = promisify(execFile)
const helperPath = join(root, 'scripts/deployment-compatibility.mjs')
const corpus = (await readFile(
  new URL('../../fixtures/deployment-compatibility/cases.jsonl', import.meta.url),
  'utf8',
))
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as CorpusCase)

const sourceContractRaw = await readFile(
  new URL('../../../config/deployment-compatibility.json', import.meta.url),
  'utf8',
)
const sourceContract = parseContract(sourceContractRaw)
const seededClient = projectDeclaration(sourceContract, 'client')
const seededServer = projectDeclaration(sourceContract, 'server')

function codeOf(action: () => unknown): string {
  try {
    action()
    return 'OK'
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNEXPECTED_ERROR'
  }
}

describe('deployment compatibility declaration corpus', () => {
  for (const vector of corpus) {
    it(vector.name, () => {
      let parsed
      let code

      try {
        parsed = parseDeclaration(vector.raw)
        if (vector.expectedCode === 'CLIENT_DOES_NOT_SUPPORT_SERVER') {
          assertMutuallyCompatible(parsed, seededServer)
        } else if (vector.expectedCode === 'SERVER_DOES_NOT_SUPPORT_CLIENT') {
          assertMutuallyCompatible(seededClient, parsed)
        }
        code = 'OK'
      } catch (error) {
        code = (error as { code?: string }).code ?? 'UNEXPECTED_ERROR'
      }

      expect(code).toBe(vector.expectedCode)
      if (vector.expectedCanonical !== undefined && parsed !== undefined) {
        expect(Buffer.from(canonicalDeclarationBytes(parsed)).toString('utf8')).toBe(
          vector.expectedCanonical,
        )
        expect(declarationDigest(parsed)).toBe(vector.expectedSha256)
      }
    })
  }
})

describe('deployment compatibility source contract', () => {
  it('projects the seeded unequal client and server versions', () => {
    expect(seededClient).toMatchObject({
      component: 'client',
      version: '0.7.5',
      supports: { server: { minInclusive: '0.7.0', maxExclusive: '0.7.1' } },
    })
    expect(seededServer).toMatchObject({
      component: 'server',
      version: '0.7.0',
      supports: { client: { minInclusive: '0.7.5', maxExclusive: '0.7.6' } },
    })
    expect(() => assertMutuallyCompatible(seededClient, seededServer)).not.toThrow()
  })

  it('rejects duplicate and unknown source contract keys before value validation', () => {
    expect(
      codeOf(() =>
        parseContract(
          '{"schemaVersion":"2","schemaVersion":"1","client":{},"server":{}}',
        ),
      ),
    ).toBe('DUPLICATE_KEY')
    expect(
      codeOf(() =>
        parseContract(
          '{"schemaVersion":"1","client":{"version":7,"supportsServer":{},"extra":true},"server":{}}',
        ),
      ),
    ).toBe('UNKNOWN_KEY')
  })

  it('treats a supplied digest only as an assertion over recomputed bytes', () => {
    expect(
      parseDeclaration(
        JSON.stringify(seededClient),
        '43c554165e167d8d5b33b22b84ce63c8aa5940cc1ba9effb29d62c85aee1c6bb',
      ),
    ).toEqual(seededClient)
    expect(codeOf(() => parseDeclaration(JSON.stringify(seededClient), '0'.repeat(64)))).toBe(
      'DIGEST_MISMATCH',
    )
  })

  it('serializes one compact JSONL event without accepting undefined values', () => {
    expect(serializeEvent({ phase: 'prepared', generationId: 'abc' })).toBe(
      '{"phase":"prepared","generationId":"abc"}\n',
    )
    expect(codeOf(() => serializeEvent({ phase: undefined }))).toBe('INVALID_EVENT')
  })

  it('rejects very deep JSON without overflowing the call stack', () => {
    const raw = `${'['.repeat(20_000)}null${']'.repeat(20_000)}`
    expect(codeOf(() => parseDeclaration(raw))).toBe('JSON_NESTING_TOO_DEEP')
  })
})

describe('deployment compatibility CLI', () => {
  it('projects a canonical declaration through an atomic output file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freshell-compat-project-'))
    const output = join(directory, 'client.json')

    await execFileAsync(process.execPath, [
      helperPath,
      'project',
      join(root, 'config/deployment-compatibility.json'),
      'client',
      output,
    ])

    expect(await readFile(output, 'utf8')).toBe(
      Buffer.from(canonicalDeclarationBytes(seededClient)).toString('utf8'),
    )
    expect(await readdir(directory)).toEqual(['client.json'])
  })

  it('checks reciprocal declarations and writes their recomputed digests', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freshell-compat-check-'))
    const clientPath = join(directory, 'client.json')
    const serverPath = join(directory, 'server.json')
    const output = join(directory, 'result.jsonl')
    await writeFile(clientPath, canonicalDeclarationBytes(seededClient))
    await writeFile(serverPath, canonicalDeclarationBytes(seededServer))

    await execFileAsync(process.execPath, [
      helperPath,
      'check',
      clientPath,
      serverPath,
      output,
    ])

    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({
      compatible: true,
      clientDigest: declarationDigest(seededClient),
      serverDigest: declarationDigest(seededServer),
    })
    expect((await readdir(directory)).sort()).toEqual([
      'client.json',
      'result.jsonl',
      'server.json',
    ])
  })

  it('serializes an event through an atomic output file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freshell-compat-event-'))
    const output = join(directory, 'event.jsonl')

    await execFileAsync(process.execPath, [
      helperPath,
      'event',
      '{"phase":"prepared","generationId":"abc"}',
      output,
    ])

    expect(await readFile(output, 'utf8')).toBe(
      '{"phase":"prepared","generationId":"abc"}\n',
    )
    expect(await readdir(directory)).toEqual(['event.jsonl'])
  })
})
