import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  PROVIDER_PARITY_CASE_IDS,
  type ProviderParityReceipt,
} from '../../../scripts/testing/provider-parity-receipt.js'
import { runProviderParityFixture } from './provider-parity-fixture.js'

const repoRoot = path.resolve(import.meta.dirname, '../../..')

describe('direct and managed provider parity contract', () => {
  let receipt: ProviderParityReceipt

  beforeAll(async () => {
    receipt = await runProviderParityFixture(repoRoot)
  }, 1_800_000)

  it.each(PROVIDER_PARITY_CASE_IDS)('%s has a provider-visible direct and managed trace', caseId => {
    const row = receipt.rows.find(candidate => candidate.caseId === caseId)
    expect(row).toBeDefined()
    expect(row!.direct).toEqual(row!.managed)
    expect(row!.onecli.unapprovedReferenceRejected).toBe(true)
    expect(Object.values(row!.secretHygiene).every(Boolean)).toBe(true)
  })
})
