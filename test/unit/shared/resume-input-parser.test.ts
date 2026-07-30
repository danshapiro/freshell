import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseResumeInput } from '@shared/resume-input-parser'

// SYNC-06 anti-drift mechanism: the SAME fixture table is consumed by
// crates/freshell-sessions/tests/resume_input_parser_parity.rs. Every case
// asserts BOTH candidates and hint. Add cases to the fixture, never inline.
interface FixtureCase {
  name: string
  input: string
  candidates: Array<{ token: string; kind: string }>
  hint: { provider: string; source: string } | null
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { cases } = JSON.parse(
  readFileSync(path.join(__dirname, '../../fixtures/resume-input/parser-cases.json'), 'utf8'),
) as { cases: FixtureCase[] }

describe('parseResumeInput — shared fixture parity', () => {
  it('fixture is non-trivial', () => {
    expect(cases.length).toBeGreaterThanOrEqual(31)
  })

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const parsed = parseResumeInput(c.input)
    expect(parsed.candidates).toEqual(c.candidates)
    expect(parsed.hint).toEqual(c.hint)
  })
})
