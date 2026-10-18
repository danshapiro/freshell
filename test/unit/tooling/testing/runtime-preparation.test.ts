// @vitest-environment node
import os from 'node:os'
import { afterAll, beforeAll, describe, it, vi } from 'vitest'
import { preparationCases } from './runtime-preparation-cases.js'

describe('required source preparation', { concurrent: false }, () => {
  const nativeHomedir = os.homedir
  beforeAll(() => {
    // Native homedir reads do not follow a Vitest worker's temporary HOME.
    vi.spyOn(os, 'homedir').mockImplementation(() => process.env.HOME ?? nativeHomedir())
  })
  afterAll(() => vi.restoreAllMocks())

  for (const [name, run] of Object.entries(preparationCases)) it(name, run, 15_000)
})
