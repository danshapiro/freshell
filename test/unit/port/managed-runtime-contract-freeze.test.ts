import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildManagedRuntimeContract,
  MANAGED_RUNTIME_SCHEMA_PATH,
  serializeManagedRuntimeContract,
} from '../../../port/contract/generate-managed-runtime-contract.js'

describe('managed runtime contract freeze', () => {
  it('committed schema deep-equals a fresh regeneration', () => {
    expect(JSON.parse(readFileSync(MANAGED_RUNTIME_SCHEMA_PATH, 'utf8')))
      .toEqual(buildManagedRuntimeContract())
  })

  it('committed schema is canonically serialized', () => {
    expect(readFileSync(MANAGED_RUNTIME_SCHEMA_PATH, 'utf8'))
      .toBe(serializeManagedRuntimeContract(buildManagedRuntimeContract()))
  })
})
