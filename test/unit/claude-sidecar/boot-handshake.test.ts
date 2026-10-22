// @vitest-environment node

// The sidecar's boot handshake (design §4.2 and §5.1 of
// docs/plans/2026-10-22-freshclaude-core-runtime.md, protocol v2): `created`
// is the sidecar's word that the CLI booted, so it is sent only once
// `initializationResult()` resolved (T2). A boot the CLI refuses is answered
// with a typed `create.failed`, never with `created` followed by a session that
// is already dead: no turn frame reaches Rust, and the sidecar exits with code
// 2. The command catalog comes from the boot itself.
//
// Driven through the production index.mjs over the CLI simulator (harness.ts),
// whose boot refusals reproduce the pinned CLI's (T4, T5). The bad-CLAUDE_CMD
// case runs over the pinned SDK itself: its spawn fails before any request.

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { startRealSidecar, type RealSidecar, type SidecarFrame } from './harness'

const MISSING = '0f5a2a8e-5a0c-4d6b-9a52-3c1f7f0d2b11'
const BOOT_FAILED_EXIT_CODE = 2

/** A conversation with `turns` finished turns, in `parent`'s CLAUDE_CONFIG_DIR; its id and transcript lines. */
async function conversationWithTurns(parent: RealSidecar, turns: number) {
  const sessionId = await parent.create()
  for (let turn = 1; turn <= turns; turn++) {
    parent.send({ type: 'send', sessionId, text: `turn ${turn}` })
    await parent.waitFor(() => parent.frames.filter((frame) => frame.type === 'sdk.result').length === turn, `the result of turn ${turn}`)
  }
  const { cliSessionId } = await parent.waitFor('sdk.session.init')
  const transcript = await waitForTranscript(parent, cliSessionId, turns)
  parent.send({ type: 'shutdown' })
  await parent.waitExit()
  return { id: cliSessionId as string, lines: transcript }
}

async function waitForTranscript(sidecar: RealSidecar, id: string, turns: number) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const projects = `${sidecar.claudeConfigDir}/projects`
    const file = fs.existsSync(projects)
      ? fs.readdirSync(projects).map((dir) => `${projects}/${dir}/${id}.jsonl`).find((candidate) => fs.existsSync(candidate))
      : undefined
    const lines = file ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
    if (lines.filter((line: { type: string }) => line.type === 'assistant').length >= turns) return lines as Array<{ type: string; uuid?: string }>
    if (Date.now() > deadline) throw new Error(`no transcript with ${turns} turns for ${id} under ${projects}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** A sidecar that shares `parent`'s CLAUDE_CONFIG_DIR, so it can resume or fork its conversations. */
function startBeside(parent: RealSidecar) {
  return startRealSidecar({ env: { CLAUDE_CONFIG_DIR: parent.claudeConfigDir } })
}

/** The refusal: `create.failed` with this code, nothing else on stdout, and exit code 2. */
async function expectRefusedBoot(sidecar: RealSidecar, answer: SidecarFrame, code: string) {
  expect(answer).toMatchObject({ type: 'create.failed', code, message: expect.any(String) })
  expect(await sidecar.waitExit()).toEqual({ code: BOOT_FAILED_EXIT_CODE, signal: null })
  // The CLI's error_during_execution boot result is the refusal's evidence,
  // never a turn: no sdk.result, error, edge or stream end reaches Rust.
  expect(sidecar.frames.map((frame) => frame.type)).toEqual(['create.failed'])
}

describe('the sidecar answers created only once the CLI has booted', () => {
  it('sends created after initializationResult() resolved, with the protocol and the CLI pid', async () => {
    const sidecar = await startRealSidecar()
    const answer = await sidecar.requestCreate()
    // The simulated CLI records its boot before initializationResult() resolves.
    const boots = sidecar.ledger().filter((row) => row.kind === 'boot')
    expect(boots).toHaveLength(1)
    expect(answer).toMatchObject({ type: 'created', protocol: 2, cliPid: boots[0].cliPid, sessionId: expect.any(String) })
    expect(sidecar.ledger().filter((row) => row.kind === 'prompt')).toEqual([])
  })

  it('publishes the command catalog from the boot, before any prompt, and again only when it changes', async () => {
    const sidecar = await startRealSidecar()
    const sessionId = await sidecar.create()
    const catalogs = () => sidecar.frames.filter((frame) => frame.type === 'sdk.session.changed' && frame.reason === 'session-commands')
    const atBoot = await sidecar.waitFor((frame) => frame.type === 'sdk.session.changed', 'the boot catalog')
    expect(atBoot).toMatchObject({ sessionId, reason: 'session-commands' })
    expect(atBoot.commands).toContainEqual({ name: 'compact', description: 'Free up context by summarizing the conversation so far', argumentHint: '<optional custom summarization instructions>' })
    expect(sidecar.ledger().filter((row) => row.kind === 'prompt')).toEqual([])
    // created is the first line: the catalog follows it.
    expect(sidecar.frames.findIndex((frame) => frame.type === 'created')).toBe(0)

    // The first turn's init names the CLI's terminal-only commands: the
    // catalog changes, so it is published again without them.
    sidecar.send({ type: 'send', sessionId, text: 'one' })
    await sidecar.waitFor(() => sidecar.frames.filter((frame) => frame.type === 'sdk.result').length === 1, 'the first result')
    expect(catalogs()).toHaveLength(2)
    expect(catalogs()[1].commands.map((command: { name: string }) => command.name)).not.toContain('doctor')

    // Every later turn's init repeats the same catalog: nothing is published.
    sidecar.send({ type: 'send', sessionId, text: 'two' })
    await sidecar.waitFor(() => sidecar.frames.filter((frame) => frame.type === 'sdk.result').length === 2, 'the second result')
    expect(catalogs()).toHaveLength(2)
  })

  it('refuses a second create: one sidecar hosts one session, and that session keeps working', async () => {
    const sidecar = await startRealSidecar()
    const sessionId = await sidecar.create({ requestId: 'first' })
    const second = await sidecar.requestCreate({ requestId: 'second' })
    expect(second).toMatchObject({ type: 'create.failed', requestId: 'second', code: 'BOOT_FAILED' })
    expect(sidecar.ledger().filter((row) => row.kind === 'query')).toHaveLength(1)
    sidecar.send({ type: 'send', sessionId, text: 'still here' })
    expect(await sidecar.waitFor('sdk.result')).toMatchObject({ sessionId, result: 'success' })
  })
})

describe('a boot the CLI refuses is a typed create.failed and the sidecar exits with code 2', () => {
  it('a resume of a conversation that does not exist: CONVERSATION_NOT_FOUND (T5)', async () => {
    const sidecar = await startRealSidecar()
    const answer = await sidecar.requestCreate({ boot: { kind: 'resume', resume: MISSING } })
    await expectRefusedBoot(sidecar, answer, 'CONVERSATION_NOT_FOUND')
    expect(answer.message).toBe(`No conversation found with session ID: ${MISSING}`)
  })

  it('a fork at a point the parent does not have: RESUME_POINT_NOT_FOUND (T5)', async () => {
    const parentSidecar = await startRealSidecar()
    const parent = await conversationWithTurns(parentSidecar, 1)
    const sidecar = await startBeside(parentSidecar)
    const nowhere = '3f0b9d2e-1111-4222-8333-444455556666'
    const answer = await sidecar.requestCreate({ boot: { kind: 'fork', resume: parent.id, resumeSessionAt: nowhere } })
    await expectRefusedBoot(sidecar, answer, 'RESUME_POINT_NOT_FOUND')
    expect(answer.message).toBe(`No message found with message.uuid of: ${nowhere}`)
  })

  it('a fork whose drops-turn guard does not hold: FORK_GUARD_REFUSED (T5)', async () => {
    const parentSidecar = await startRealSidecar()
    const parent = await conversationWithTurns(parentSidecar, 2)
    const sidecar = await startBeside(parentSidecar)
    // Keep the first turn: the second is discarded, and the guard names a turn
    // that is not the one discarded.
    const keepAt = parent.lines.find((line) => line.type === 'assistant')!.uuid
    const answer = await sidecar.requestCreate({ boot: { kind: 'fork', resume: parent.id, resumeSessionAt: keepAt, dropsTurn: MISSING } })
    await expectRefusedBoot(sidecar, answer, 'FORK_GUARD_REFUSED')
    expect(answer.message).toMatch(/^Resume rejected by --resume-drops-turn: /)
  })

  it('a fresh boot under an id whose transcript exists: SESSION_ID_IN_USE (T4)', async () => {
    const parentSidecar = await startRealSidecar()
    const parent = await conversationWithTurns(parentSidecar, 1)
    const sidecar = await startBeside(parentSidecar)
    const answer = await sidecar.requestCreate({ sessionId: parent.id, boot: { kind: 'fresh' } })
    await expectRefusedBoot(sidecar, answer, 'SESSION_ID_IN_USE')
    expect(answer.message).toBe(`Session ID ${parent.id} is already in use.`)
  })

  it('a CLAUDE_CMD that is not the CLI: BOOT_FAILED with the SDK\'s reason (the pinned SDK)', async () => {
    const sidecar = await startRealSidecar({
      env: {
        // The pinned SDK, not the simulator: its spawn of the missing binary fails before any request.
        FRESHELL_CLAUDE_SDK_QUERY_MODULE: '',
        CLAUDE_CMD: '/nonexistent/claude',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9',
      },
    })
    const answer = await sidecar.requestCreate()
    await expectRefusedBoot(sidecar, answer, 'BOOT_FAILED')
    expect(answer.message).toContain('/nonexistent/claude')
  })

  it('a create that does not speak protocol 2 fails fast, with no SDK call: SIDECAR_PROTOCOL_MISMATCH', async () => {
    for (const protocol of [undefined, 1, 3]) {
      const sidecar = await startRealSidecar()
      const answer = await sidecar.requestCreate({ protocol })
      await expectRefusedBoot(sidecar, answer, 'SIDECAR_PROTOCOL_MISMATCH')
      expect(sidecar.ledger().filter((row) => row.kind === 'query'), `protocol ${protocol}`).toEqual([])
    }
  })
})
