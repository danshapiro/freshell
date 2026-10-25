import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isDefaultOrDerivedName,
  isProviderPlaceholderTitle,
  type NameEvidenceContext,
} from '@shared/name-evidence'

// The same table pins crates/freshell-sessions/src/name_evidence.rs
// (crates/freshell-sessions/tests/name_evidence.rs), so the two classifiers
// cannot drift apart.
type ClassifierCase = { name: string; ctx: NameEvidenceContext; expected: boolean }
type PlaceholderCase = { provider: string; title: string; expected: boolean }
type Fixture = { cases: ClassifierCase[]; placeholderCases: PlaceholderCase[] }

const fixture: Fixture = JSON.parse(
  readFileSync(path.join(__dirname, '../../fixtures/name-evidence/cases.json'), 'utf-8'),
)

describe('name evidence classifier', () => {
  it('classifies every shared fixture case exactly as expected', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(40)
    const mismatches = fixture.cases
      .map((row, index) => ({ index, row, actual: isDefaultOrDerivedName(row.name, row.ctx) }))
      .filter(({ row, actual }) => actual !== row.expected)
      .map(({ index, row, actual }) =>
        `row ${index}: ${JSON.stringify(row.name)} ctx=${JSON.stringify(row.ctx)} expected ${row.expected}, got ${actual}`)
    expect(mismatches).toEqual([])
  })

  it('treats provider placeholders per provider only', () => {
    const placeholder = 'New session - 2026-10-20T00:09:25.350Z'
    expect(isProviderPlaceholderTitle('opencode', placeholder)).toBe(true)
    expect(isProviderPlaceholderTitle('claude', placeholder)).toBe(false)

    const mismatches = fixture.placeholderCases
      .map((row, index) => ({ index, row, actual: isProviderPlaceholderTitle(row.provider, row.title) }))
      .filter(({ row, actual }) => actual !== row.expected)
      .map(({ index, row, actual }) =>
        `placeholder row ${index}: ${row.provider} ${JSON.stringify(row.title)} expected ${row.expected}, got ${actual}`)
    expect(mismatches).toEqual([])
  })
})
