import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ReceiptRunRegistry,
  readCandidateReceiptSource,
} from '../../../../scripts/testing/runtime-receipt-source.js'

const candidateSha = 'a'.repeat(40)
const runId = 'receipt-run-1234'
const fileName = 'p5-g02-real-opencode-loss.json'
const roots: string[] = []

function fixture(receipt: Record<string, unknown> = {}): {
  repoRoot: string
  source: string
  receipt: Record<string, unknown>
} {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-receipt-source-'))
  roots.push(repoRoot)
  const source = path.join(
    repoRoot,
    '.runtime-evidence',
    candidateSha,
    runId,
    'browser',
    fileName,
  )
  fs.mkdirSync(path.dirname(source), { recursive: true })
  const value = {
    schemaVersion: 2,
    status: 'PASS',
    candidateSha,
    receiptRunId: runId,
    evidenceRun: `.runtime-evidence/${candidateSha}/${runId}`,
    ...receipt,
  }
  fs.writeFileSync(source, JSON.stringify(value), { mode: 0o600 })
  return { repoRoot, source, receipt: value }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('candidate-bound runtime receipt source', () => {
  it('loads only the canonical regular file under the exact candidate evidence run', () => {
    const fx = fixture()
    const loaded = readCandidateReceiptSource({
      repoRoot: fx.repoRoot,
      candidateSha,
      source: fx.source,
      expectedFileName: fileName,
      kind: 'phase5-loss',
    })

    expect(loaded.receipt).toEqual(fx.receipt)
    expect(loaded.sourcePath).toBe(fx.source)
    expect(loaded.evidenceDir).toBe(path.dirname(path.dirname(fx.source)))
    expect(loaded.sourceSha256).toBe(
      createHash('sha256').update(fs.readFileSync(fx.source)).digest('hex'),
    )
  })

  it.each([
    ['inline JSON', JSON.stringify({ schemaVersion: 2 })],
    ['empty input', '   '],
  ])('rejects %s instead of treating it as trusted evidence', (_label, source) => {
    const fx = fixture()
    expect(() => readCandidateReceiptSource({
      repoRoot: fx.repoRoot,
      candidateSha,
      source,
      expectedFileName: fileName,
      kind: 'phase5-loss',
    })).toThrow(/receipt.*path|inline JSON/i)
  })

  it('rejects a readable file outside the candidate evidence root', () => {
    const fx = fixture()
    const outside = path.join(fx.repoRoot, 'receipt.json')
    fs.copyFileSync(fx.source, outside)
    expect(() => readCandidateReceiptSource({
      repoRoot: fx.repoRoot,
      candidateSha,
      source: outside,
      expectedFileName: fileName,
      kind: 'phase5-loss',
    })).toThrow(/canonical candidate evidence path/i)
  })

  it('rejects symlinked receipt files and symlinked evidence directories', () => {
    const fx = fixture()
    const realReceipt = path.join(fx.repoRoot, 'real-receipt.json')
    fs.renameSync(fx.source, realReceipt)
    fs.symlinkSync(realReceipt, fx.source)
    expect(() => readCandidateReceiptSource({
      repoRoot: fx.repoRoot,
      candidateSha,
      source: fx.source,
      expectedFileName: fileName,
      kind: 'phase5-loss',
    })).toThrow(/symbolic link/i)

    fs.unlinkSync(fx.source)
    const realBrowser = path.join(fx.repoRoot, 'real-browser')
    fs.mkdirSync(realBrowser)
    fs.writeFileSync(path.join(realBrowser, fileName), JSON.stringify(fx.receipt), { mode: 0o600 })
    fs.rmSync(path.dirname(fx.source), { recursive: true })
    fs.symlinkSync(realBrowser, path.dirname(fx.source))
    expect(() => readCandidateReceiptSource({
      repoRoot: fx.repoRoot,
      candidateSha,
      source: fx.source,
      expectedFileName: fileName,
      kind: 'phase5-loss',
    })).toThrow(/symbolic link|real directory/i)
  })

  it('rejects oversized, malformed, and non-object receipt documents', () => {
    const oversized = fixture()
    fs.writeFileSync(oversized.source, `{"padding":"${'x'.repeat(1024 * 1024)}"}`)
    expect(() => readCandidateReceiptSource({
      repoRoot: oversized.repoRoot,
      candidateSha,
      source: oversized.source,
      expectedFileName: fileName,
      kind: 'phase5-loss',
    })).toThrow(/size limit/i)

    const malformed = fixture()
    fs.writeFileSync(malformed.source, '{')
    expect(() => readCandidateReceiptSource({
      repoRoot: malformed.repoRoot,
      candidateSha,
      source: malformed.source,
      expectedFileName: fileName,
      kind: 'phase5-loss',
    })).toThrow(/valid JSON/i)

    const array = fixture()
    fs.writeFileSync(array.source, '[]')
    expect(() => readCandidateReceiptSource({
      repoRoot: array.repoRoot,
      candidateSha,
      source: array.source,
      expectedFileName: fileName,
      kind: 'phase5-loss',
    })).toThrow(/JSON object/i)
  })

  it('rejects a receipt readable by group or other users', () => {
    const fx = fixture()
    fs.chmodSync(fx.source, 0o644)
    expect(() => readCandidateReceiptSource({
      repoRoot: fx.repoRoot,
      candidateSha,
      source: fx.source,
      expectedFileName: fileName,
      kind: 'phase5-loss',
    })).toThrow(/permissions.*private/i)
  })

  it('rejects candidate, evidence-run, filename, and run-id substitution', () => {
    for (const mutation of [
      { candidateSha: 'b'.repeat(40) },
      { receiptRunId: '../escape' },
      { evidenceRun: `.runtime-evidence/${candidateSha}/some-other-run` },
    ]) {
      const fx = fixture(mutation)
      expect(() => readCandidateReceiptSource({
        repoRoot: fx.repoRoot,
        candidateSha,
        source: fx.source,
        expectedFileName: fileName,
        kind: 'phase5-loss',
      })).toThrow(/candidate SHA|run id|evidence run/i)
    }

    const fx = fixture()
    expect(() => readCandidateReceiptSource({
      repoRoot: fx.repoRoot,
      candidateSha,
      source: fx.source,
      expectedFileName: 'different.json',
      kind: 'phase5-loss',
    })).toThrow(/canonical candidate evidence path/i)
  })

  it('rejects a run ID reused by a different receipt while allowing idempotent reload', () => {
    const registry = new ReceiptRunRegistry()
    const fx = fixture()
    const input = {
      repoRoot: fx.repoRoot,
      candidateSha,
      source: fx.source,
      expectedFileName: fileName,
      kind: 'phase5-loss',
      registry,
    } as const
    expect(readCandidateReceiptSource(input).receiptRunId).toBe(runId)
    expect(readCandidateReceiptSource(input).receiptRunId).toBe(runId)

    expect(() => readCandidateReceiptSource({
      ...input,
      kind: 'phase5-chaos',
    })).toThrow(/run id.*reused/i)
  })

  it('never echoes secret-looking paths or malformed receipt content in errors', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwx'
    const fx = fixture()
    fs.writeFileSync(fx.source, `{ "providerResponse": "${secret}"`)
    let malformed = ''
    try {
      readCandidateReceiptSource({
        repoRoot: fx.repoRoot,
        candidateSha,
        source: fx.source,
        expectedFileName: fileName,
        kind: 'phase5-loss',
      })
    } catch (error) {
      malformed = String(error)
    }
    expect(malformed).not.toContain(secret)

    let missing = ''
    try {
      readCandidateReceiptSource({
        repoRoot: fx.repoRoot,
        candidateSha,
        source: path.join(fx.repoRoot, secret, 'receipt.json'),
        expectedFileName: fileName,
        kind: 'phase5-loss',
      })
    } catch (error) {
      missing = String(error)
    }
    expect(missing).not.toContain(secret)
  })
})
