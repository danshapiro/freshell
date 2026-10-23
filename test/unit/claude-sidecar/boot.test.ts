// @vitest-environment node

// The pure half of the sidecar's boot (design §4.2 and §5.1 of
// docs/plans/2026-10-22-freshclaude-core-runtime.md, protocol v2): which SDK
// options a `create.boot` launches with, and which `create.failed` code a
// refused boot gets. The refusal strings are the pinned CLI's own, exactly as
// claude-cli-contract.test.ts records them (T4, T5).

import { describe, expect, it } from 'vitest'
// @ts-expect-error JavaScript sidecar module has no declaration file.
import { bootOptions, classifyBootError, CreateRequestError } from '../../../crates/freshell-claude-sidecar/boot.mjs'

const X = '0f5a2a8e-5a0c-4d6b-9a52-3c1f7f0d2b11'
const P = '7c1d4e22-9a3b-4f61-8d0e-2b5c6a7f8e90'

describe('bootOptions', () => {
  it('boots a fresh conversation under the minted id, or lets the CLI pick one', () => {
    expect(bootOptions({ kind: 'fresh' }, X)).toEqual({ sessionId: X })
    expect(bootOptions({ kind: 'fresh' }, undefined)).toEqual({})
  })

  it('resumes a conversation by its id and never sets sessionId (the SDK forbids it with resume)', () => {
    expect(bootOptions({ kind: 'resume', resume: P }, X)).toEqual({ resume: P })
    expect(bootOptions({ kind: 'resume', resume: '/projects/p/abc.jsonl' }, undefined)).toEqual({ resume: '/projects/p/abc.jsonl' })
  })

  it('forks a parent at a point, under the minted id when there is one, with the drops-turn guard', () => {
    expect(bootOptions({ kind: 'fork', resume: P, resumeSessionAt: 'a1', dropsTurn: 'u2' }, X))
      .toEqual({ resume: P, forkSession: true, resumeSessionAt: 'a1', sessionId: X, resumeDropsTurn: 'u2' })
    expect(bootOptions({ kind: 'fork', resume: P }, undefined)).toEqual({ resume: P, forkSession: true })
  })

  it('refuses a boot it cannot launch, before any SDK call', () => {
    for (const boot of [undefined, {}, { kind: 'restore' }, { kind: 'resume' }, { kind: 'fork', resume: '' }]) {
      let thrown: unknown
      try { bootOptions(boot, X) } catch (error) { thrown = error }
      expect(thrown, JSON.stringify(boot)).toBeInstanceOf(CreateRequestError)
      expect((thrown as { code: string }).code).toBe('BOOT_FAILED')
    }
  })
})

describe('classifyBootError', () => {
  it('names a fresh boot over an existing transcript from the CLI\'s stderr (T4)', () => {
    expect(classifyBootError({
      error: new Error('Claude Code process exited with code 1'),
      stderr: `Error: Session ID ${X} is already in use.\n`,
    })).toEqual({ code: 'SESSION_ID_IN_USE', message: `Session ID ${X} is already in use.` })
  })

  it('names the three refusals the CLI reports as an error result (T5)', () => {
    const cases = [
      ['CONVERSATION_NOT_FOUND', `No conversation found with session ID: ${X}`],
      ['RESUME_POINT_NOT_FOUND', 'No message found with message.uuid of: 3f0b9d2e-1111-4222-8333-444455556666'],
      ['FORK_GUARD_REFUSED', `Resume rejected by --resume-drops-turn: resuming at a1 would discard entries not attributable to turn u2: range does not start with the declared turn prompt; first discarded entry 0 [type=assistant, uuid=a2]`],
    ] as const
    for (const [code, refusal] of cases) {
      // The result's errors carry the refusal; the rejection repeats it after the SDK's prefix.
      expect(classifyBootError({
        error: new Error(`Claude Code returned an error result: ${refusal}`),
        resultErrors: [refusal],
      })).toEqual({ code, message: refusal })
      // The rejection alone is enough.
      expect(classifyBootError({ error: new Error(`Claude Code returned an error result: ${refusal}`) }))
        .toEqual({ code, message: refusal })
    }
  })

  it('ignores the CLI\'s internal diagnostics', () => {
    expect(classifyBootError({
      error: new Error('Claude Code returned an error result: boom'),
      resultErrors: ['[ede_diagnostic] stack', `No conversation found with session ID: ${X}`],
    })).toEqual({ code: 'CONVERSATION_NOT_FOUND', message: `No conversation found with session ID: ${X}` })
  })

  it('calls anything else a failed boot and keeps the SDK\'s message (for one, a CLAUDE_CMD that is not the CLI)', () => {
    const missing = 'Claude Code native binary not found at /nonexistent/claude. Please ensure Claude Code is installed via native installer or specify a valid path with options.pathToClaudeCodeExecutable.'
    expect(classifyBootError({ error: new Error(missing) })).toEqual({ code: 'BOOT_FAILED', message: missing })
    expect(classifyBootError({ error: new Error('Claude Code process exited with code 1'), stderr: 'segfault\n' }))
      .toEqual({ code: 'BOOT_FAILED', message: 'Claude Code process exited with code 1' })
    expect(classifyBootError({}).code).toBe('BOOT_FAILED')
    expect(classifyBootError({}).message).toEqual(expect.any(String))
  })

  it('cuts a long message', () => {
    const { code, message } = classifyBootError({ error: new Error(`x${'y'.repeat(5000)}`) })
    expect(code).toBe('BOOT_FAILED')
    expect(message.length).toBeLessThanOrEqual(1000)
  })
})
