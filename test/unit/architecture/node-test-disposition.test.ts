// @vitest-environment node
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  verifyNodeTestDisposition,
  type NodeTestDispositionLedger,
  type NodeTestDispositionRow,
} from '../../../scripts/retirement/verify-node-test-disposition.js'

const repoRoot = process.cwd()

function row(overrides: Partial<NodeTestDispositionRow> = {}): NodeTestDispositionRow {
  return {
    oldPath: 'test/unit/server/example.test.ts',
    title: 'example',
    subject: 'example subject',
    decision: 'retained',
    replacementRequired: true,
    survivingTest: 'test/unit/example.test.ts',
    requiredLane: 'default-vitest',
    selector: 'test/unit/example.test.ts',
    latestReceipt: { status: 'passed', count: 1, source: 'receipt' },
    ...overrides,
  }
}

function ledger(rows: NodeTestDispositionRow[]): NodeTestDispositionLedger {
  return {
    version: 1,
    universe: 'synthetic disposition',
    candidateCount: 1,
    candidatePaths: ['test/unit/server/example.test.ts'],
    rows,
  }
}

describe('node-test-disposition verifier', () => {
  it('accepts the committed closed disposition ledger', async () => {
    const committed = JSON.parse(await readFile(
      path.join(repoRoot, 'scripts/retirement/node-test-disposition.json'),
      'utf8',
    )) as NodeTestDispositionLedger

    expect(await verifyNodeTestDisposition(committed, { expectedCandidateCount: 347 })).toEqual([])
  })

  it('rejects a Task 10 deletion omitted from the independently closed universe', async () => {
    const committed = JSON.parse(await readFile(
      path.join(repoRoot, 'scripts/retirement/node-test-disposition.json'),
      'utf8',
    )) as NodeTestDispositionLedger
    const missingPath = 'test/integration/session-repair.test.ts'
    const incomplete: NodeTestDispositionLedger = {
      ...committed,
      candidateCount: committed.candidateCount - 1,
      candidatePaths: committed.candidatePaths.filter((candidatePath) => candidatePath !== missingPath),
      rows: committed.rows.filter((candidateRow) => candidateRow.oldPath !== missingPath),
    }

    const errors = await verifyNodeTestDisposition(incomplete, { expectedCandidateCount: 347 })

    expect(errors).toContain(
      `ledger: required Task 10 deleted test path missing from closed candidate universe: ${missingPath}`,
    )
  })

  it('rejects an unresolved subject in a mixed test file', async () => {
    const errors = await verifyNodeTestDisposition(ledger([
      row({ subject: '' }),
    ]), { expectedCandidateCount: 1, enforceTask10Scope: false })

    expect(errors).toContain('test/unit/server/example.test.ts: subject is unresolved')
  })

  it('rejects a replacement receipt whose selector selected zero tests', async () => {
    const errors = await verifyNodeTestDisposition(ledger([
      row({
        selector: 'test/unit/example.test.ts -t missing',
        latestReceipt: { status: 'passed', count: 0, source: 'receipt' },
      }),
    ]), { expectedCandidateCount: 1, enforceTask10Scope: false })

    expect(errors).toContain('test/unit/server/example.test.ts [example subject]: replacement receipt selected zero tests')
  })

  it('rejects a skipped optional T2 receipt as a required replacement', async () => {
    const errors = await verifyNodeTestDisposition(ledger([
      row({
        requiredLane: 'supplemental-t2',
        latestReceipt: { status: 'skipped', count: 0, source: 'optional provider unavailable' },
      }),
    ]), { expectedCandidateCount: 1, enforceTask10Scope: false })

    expect(errors).toEqual(expect.arrayContaining([
      'test/unit/server/example.test.ts [example subject]: optional/supplemental lane cannot satisfy a required replacement',
      'test/unit/server/example.test.ts [example subject]: replacement receipt is not positive (skipped)',
      'test/unit/server/example.test.ts [example subject]: replacement receipt selected zero tests',
    ]))
  })

  it('rejects unknown, duplicate, and stale rows in a closed universe', async () => {
    const errors = await verifyNodeTestDisposition({
      ...ledger([row(), row()]),
      candidatePaths: ['test/unit/server/example.test.ts', 'test/unit/server/stale.test.ts'],
      candidateCount: 2,
    }, { expectedCandidateCount: 2, enforceTask10Scope: false })

    expect(errors).toEqual(expect.arrayContaining([
      'duplicate disposition row: test/unit/server/example.test.ts [example subject]',
      'stale candidate path without disposition: test/unit/server/stale.test.ts',
    ]))
  })
})
