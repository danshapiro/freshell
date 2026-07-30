import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseResumeInput, MAX_RESUME_CANDIDATES } from '@shared/resume-input-parser'
import type { ResumeCandidate, ResumeHint } from '@shared/resume-input-parser'

const V4 = 'ed2afda6-a340-443e-ba60-024a1b3554b4'
const V7 = '019fac27-69d7-78a0-b972-b339d551042e'
const SES = 'ses_root0000000000000000000000'

describe('parseResumeInput — candidate extraction', () => {
  it.each([
    ['bare short hex', '417e8345', [{ token: '417e8345', kind: 'hex-prefix' }]],
    ['bare v4 uuid', V4, [{ token: V4, kind: 'uuid' }]],
    ['bare opencode id', SES, [{ token: SES, kind: 'prefixed-id' }]],
    ['codex resume command', `codex resume ${V7}`, [{ token: V7, kind: 'uuid' }]],
    ['claude --resume command', `claude --resume ${V4}`, [{ token: V4, kind: 'uuid' }]],
    ['claude -r command', `$ claude -r ${V4}`, [{ token: V4, kind: 'uuid' }]],
    ['opencode --session command', `opencode --session ${SES}`, [{ token: SES, kind: 'prefixed-id' }]],
    ['amplifier --resume short id', 'amplifier --resume 417e8345', [{ token: '417e8345', kind: 'hex-prefix' }]],
    ['quoted + padded', `  "claude --resume ${V4}"  `, [{ token: V4, kind: 'uuid' }]],
    ['backticks', '`417e8345`', [{ token: '417e8345', kind: 'hex-prefix' }]],
    ['id embedded in a path', `/home/x/.claude/projects/foo/${V4}.jsonl`, [{ token: V4, kind: 'uuid' }]],
    ['trailing punctuation', 'session 417e8345.', [{ token: '417e8345', kind: 'hex-prefix' }]],
    ['ansi codes', `\u001b[32m417e8345\u001b[0m`, [{ token: '417e8345', kind: 'hex-prefix' }]],
    [
      'multi-line noise',
      `To continue:\n$ codex resume ${V7}\nor open the app`,
      [{ token: V7, kind: 'uuid' }],
    ],
  ] as const)('%s', (_label, input, expected) => {
    expect(parseResumeInput(input).candidates).toEqual(expected)
  })

  it.each([
    ['english hex-looking word', 'decade'],
    ['facade sentence', 'I spent a decade behind a facade'],
    ['hex without digits', 'deadbeef'],
    ['garbage', 'hello world!! no ids here'],
    ['empty', ''],
  ] as const)('extracts nothing from %s', (_label, input) => {
    expect(parseResumeInput(input).candidates).toEqual([])
  })

  it('orders prefixed ids, then uuids, then hex prefixes longest-first', () => {
    const { candidates } = parseResumeInput(`417e8345 ${V4} ${SES} 417e8345abcd`)
    expect(candidates.map((c) => c.token)).toEqual([SES, V4, '417e8345abcd', '417e8345'])
  })

  it('dedupes repeated tokens case-insensitively', () => {
    const { candidates } = parseResumeInput(`${V4} ${V4.toUpperCase()}`)
    expect(candidates).toHaveLength(1)
  })

  it('does not extract hex segments out of a uuid', () => {
    const { candidates } = parseResumeInput(V4)
    expect(candidates).toEqual([{ token: V4, kind: 'uuid' }])
  })

  it('caps hex tokens at 32 chars (git shas do not match)', () => {
    expect(parseResumeInput('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2').candidates).toEqual([])
  })

  it('rejects arbitrary snake_case identifiers (only known xxx_ id families match)', () => {
    expect(parseResumeInput('my_function123 snake_casedword9').candidates).toEqual([])
  })

  it('accepts other known xxx_ id families (thread_)', () => {
    expect(parseResumeInput('thread_abc123456').candidates).toEqual([
      { token: 'thread_abc123456', kind: 'prefixed-id' },
    ])
  })

  it('caps candidates at MAX_RESUME_CANDIDATES (server work budget)', () => {
    const tokens = Array.from(
      { length: MAX_RESUME_CANDIDATES + 4 },
      (_, i) => `417e83450a${String(i).padStart(2, '0')}`,
    )
    const { candidates } = parseResumeInput(tokens.join(' '))
    expect(candidates).toHaveLength(MAX_RESUME_CANDIDATES)
  })
})

describe('parseResumeInput — advisory hint', () => {
  it.each([
    ['codex command', `codex resume ${V7}`, { provider: 'codex', source: 'command' }],
    ['claude --resume', `claude --resume ${V4}`, { provider: 'claude', source: 'command' }],
    ['claude -r', `claude -r ${V4}`, { provider: 'claude', source: 'command' }],
    ['opencode --session', `opencode --session ${SES}`, { provider: 'opencode', source: 'command' }],
    ['amplifier --resume', 'amplifier --resume 417e8345', { provider: 'amplifier', source: 'command' }],
    ['agent word only', `the claude session ${V4}`, { provider: 'claude', source: 'word' }],
    ['ses_ id shape', SES, { provider: 'opencode', source: 'id-shape' }],
    ['uuid v7 shape', V7, { provider: 'codex', source: 'id-shape' }],
    ['uuid v4 shape', V4, { provider: 'claude', source: 'id-shape' }],
    ['short hex shape', '417e8345', { provider: 'amplifier', source: 'id-shape' }],
  ] as const)('%s', (_label, input, expected) => {
    expect(parseResumeInput(input).hint).toEqual(expected)
  })

  it('returns null hint for garbage', () => {
    expect(parseResumeInput('nothing to see').hint).toBeNull()
  })
})

// SYNC-06 cross-language anti-drift: the SAME fixture table pins this parser
// and the Rust port (crates/freshell-sessions/tests/resume_input_parser_parity.rs).
// Behavior changes go through the fixture first — add cases there, never inline.
const FIXTURE = JSON.parse(
  readFileSync(path.join(__dirname, '../../fixtures/resume-input/parser-cases.json'), 'utf-8'),
) as {
  cases: Array<{
    name: string
    input: string
    candidates: ResumeCandidate[]
    hint: ResumeHint | null
  }>
}

describe('parseResumeInput — shared cross-language fixture', () => {
  it('has at least the pinned number of cases (anti-deletion gate, mirrors the Rust floor)', () => {
    expect(FIXTURE.cases.length).toBeGreaterThanOrEqual(32)
  })

  it.each(FIXTURE.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const parsed = parseResumeInput(c.input)
    expect(parsed.candidates).toEqual(c.candidates)
    expect(parsed.hint ?? null).toEqual(c.hint ?? null)
  })
})
