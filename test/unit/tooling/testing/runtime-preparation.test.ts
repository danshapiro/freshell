// @vitest-environment node
import { describe, it } from 'vitest'
import { preparationCases } from './runtime-preparation-cases.js'

describe.sequential('required source preparation', () => {
  for (const [name, run] of Object.entries(preparationCases)) it(name, run, 15_000)
})
