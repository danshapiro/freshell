// @vitest-environment node
//
// Real-CLI contract suite: pins the facts T1-T19 of the freshclaude core
// runtime design (docs/plans/2026-10-22-freshclaude-core-runtime.md §2)
// against the pinned Claude Agent SDK 0.3.237 and its bundled CLI 2.1.237.
// The CLI talks only to the loopback provider in claude-local-provider.mjs.
//
// This is the upgrade gate for the pinned CLI: a failing fact means the
// simulator (test/fixtures/claude-cli-sim) or the design changes first. When
// the pinned CLI is missing, every test FAILS (the scenario runner throws
// PinnedClaudeMissingError); nothing here is ever skipped.
//
// The simulator conformance suite (claude-cli-conformance.ts) runs at the end
// of this file on the same real-CLI traces, so each real scenario runs once
// per test run.

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  eventsOf,
  isMsg,
  messagesOf,
  REPO_ROOT,
  scenarioCache,
  type ScenarioResult,
  type TraceEvent,
} from './claude-cli-trace'
import { PINNED_CLI_VERSION, PINNED_SDK_VERSION, resolvePinnedClaude } from './claude-local-provider.mjs'
import { describeSimulatorConformance } from './claude-cli-conformance'
// @ts-expect-error JavaScript sidecar module has no declaration file.
import { PINNED_TERMINAL_COMMANDS } from '../../../crates/freshell-claude-sidecar/terminal-commands.mjs'

const real = scenarioCache('real', { heartbeat: { timeoutMs: 150_000 } })
const SCENARIO_TIMEOUT = 120_000

// The heartbeat scenario waits for the CLI's fixed 30 s heartbeat; start it
// first so it overlaps the other scenarios.
beforeAll(() => {
  void real('heartbeat')
})

const isInit = (m: any) => m.type === 'system' && m.subtype === 'init'
const isResult = (m: any) => m.type === 'result'
const isState = (state: string) => (m: any) => m.type === 'system' && m.subtype === 'session_state_changed' && m.state === state
const isLifecycle = (uuid: string, state?: string) => (m: any) => m.type === 'command_lifecycle' && m.command_uuid === uuid && (state === undefined || m.state === state)
const isReplayOf = (uuid: string) => (m: any) => m.type === 'user' && m.isReplay === true && m.uuid === uuid
const isPush = (label: string) => (e: TraceEvent) => e.k === 'push' && e.uuid === label

function at(events: TraceEvent[], predicate: (e: TraceEvent) => boolean): number {
  const index = events.findIndex(predicate)
  expect(index, `expected an event matching ${predicate}`).toBeGreaterThanOrEqual(0)
  return index
}

function between(events: TraceEvent[], from: number, to: number, predicate: (m: any) => boolean): any[] {
  return events.slice(from + 1, to).filter((e) => e.k === 'msg' && predicate(e.m)).map((e) => e.m)
}

function lifecycleStates(messages: any[], uuid: string): string[] {
  return messages.filter(isLifecycle(uuid)).map((m) => m.state)
}

function results(result: ScenarioResult, session: string) {
  return messagesOf(result, session).filter(isResult)
}

describe(`pinned Claude CLI ${PINNED_CLI_VERSION} contract (real CLI, loopback provider)`, () => {
  it('the pinned SDK and its bundled CLI are installed and report the pinned versions', async () => {
    const pinned = await resolvePinnedClaude(REPO_ROOT)
    expect(pinned).toMatchObject({ sdkVersion: PINNED_SDK_VERSION, cliVersion: PINNED_CLI_VERSION })
    await expect(fs.access(pinned.nativeCli)).resolves.toBeUndefined()
  })

  it('a missing pinned CLI is a loud failure, never a skip', async () => {
    const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-no-claude-'))
    try {
      await expect(resolvePinnedClaude(emptyRoot)).rejects.toMatchObject({ code: 'PINNED_CLAUDE_MISSING' })
    } finally {
      await fs.rm(emptyRoot, { recursive: true, force: true })
    }
  })

  it('T1: system/init is emitted at the start of every turn, and only once a prompt is pushed', async () => {
    const r = await real('boot')
    const events = eventsOf(r, 'S')
    const firstPush = at(events, isPush('u1'))
    expect(r.observations.beforePrompt.messages).toBe(0)
    expect(between(events, -1, firstPush, isInit)).toEqual([])
    const resultIndexes = events.flatMap((e, i) => (e.k === 'msg' && isResult(e.m) ? [i] : []))
    expect(resultIndexes).toHaveLength(2)
    expect(between(events, firstPush, resultIndexes[0], isInit)).toHaveLength(1)
    expect(between(events, resultIndexes[0], resultIndexes[1], isInit)).toHaveLength(1)
    // The init of each turn follows that command's `started`.
    const started = at(events, isMsg(isLifecycle('u1', 'started')))
    expect(at(events, isMsg(isInit))).toBeGreaterThan(started)
  }, SCENARIO_TIMEOUT)

  it('T2: initializationResult() resolves with no prompt, carrying commands, models, account, the CLI pid and the permission mode', async () => {
    const r = await real('boot')
    const events = eventsOf(r, 'S')
    const resolved = at(events, (e) => e.k === 'init-resolved')
    expect(resolved).toBeLessThan(at(events, isPush('u1')))
    const summary = events[resolved].result
    expect(summary.keys).toEqual(expect.arrayContaining(['commands', 'models', 'account', 'pid', 'current_permission_mode']))
    expect(summary).toMatchObject({ pidIsCli: true, current_permission_mode: 'bypassPermissions' })
    expect(summary.commands).toBeGreaterThan(0)
    expect(summary.models).toBeGreaterThan(0)
  }, SCENARIO_TIMEOUT)

  it('T2: the boot names no terminal-only commands; every init lists them, exactly as the sidecar pins them', async () => {
    const r = await real('boot')
    const events = eventsOf(r, 'S')
    // The boot's catalog lists terminal-only commands with the rest, so the
    // sidecar's boot catalog leaves out its pinned list (terminal-commands.mjs).
    const summary = events[at(events, (e) => e.k === 'init-resolved')].result
    expect(summary.keys).not.toContain('terminal_slash_commands')
    const inits = messagesOf(r, 'S').filter(isInit)
    expect(inits.length).toBeGreaterThan(0)
    for (const init of inits) {
      expect([...init.terminal_slash_commands].sort()).toEqual([...PINNED_TERMINAL_COMMANDS].sort())
    }
  }, SCENARIO_TIMEOUT)

  it('T3: a fresh boot honors sessionId X, writes nothing before the first prompt, and the transcript appears around the first result', async () => {
    const r = await real('boot')
    const messages = messagesOf(r, 'S')
    expect(messages.filter(isInit).map((m) => m.session_id)).toEqual(['X', 'X'])
    expect(messages.filter(isResult).map((m) => m.session_id)).toEqual(['X', 'X'])
    expect(r.observations.beforePrompt.files).toEqual([])
    const appeared = r.observations.transcriptAfterFirstResult
    expect(appeared.msAfterResult).not.toBeNull()
    const shape = appeared.shape as Array<{ type: string, uuid: string }>
    expect(shape.some((line) => line.type === 'user' && line.uuid === 'u1')).toBe(true)
  }, SCENARIO_TIMEOUT)

  it('T4: a fresh boot with an id whose transcript exists is refused: "Session ID X is already in use." and exit code 1', async () => {
    const r = await real('session-in-use')
    const events = eventsOf(r, 'S')
    expect(r.observations.rejected.stderr).toContain('Session ID X is already in use.')
    expect(r.observations.rejected.childExit).toEqual({ code: 1, signal: null })
    expect(events.find((e) => e.k === 'init-rejected')?.message).toBe('Claude Code process exited with code 1')
    expect(events.find((e) => e.k === 'throw')?.message).toBe('Claude Code process exited with code 1')
    expect(messagesOf(r, 'S')).toEqual([])
  }, SCENARIO_TIMEOUT)

  it('T5: boot refusals arrive with no prompt: an error_during_execution result with num_turns 0, then initializationResult() rejects and the iterator throws', async () => {
    const r = await real('fork')
    const expected: Record<string, string | RegExp> = {
      missingResume: 'No conversation found with session ID: Z',
      badForkPoint: 'No message found with message.uuid of: nowhere',
      guard: /^Resume rejected by --resume-drops-turn: /,
    }
    for (const [session, error] of Object.entries(expected)) {
      const events = eventsOf(r, session)
      const messages = messagesOf(r, session)
      expect(messages, session).toHaveLength(1)
      expect(messages[0], session).toMatchObject({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0 })
      expect(messages[0].errors[0], session).toMatch(error)
      const resultIndex = at(events, isMsg(isResult))
      const rejected = at(events, (e) => e.k === 'init-rejected')
      const thrown = at(events, (e) => e.k === 'throw')
      expect(rejected, session).toBeGreaterThan(resultIndex)
      expect(thrown, session).toBeGreaterThan(resultIndex)
      expect(events[rejected].message, session).toBe(`Claude Code returned an error result: ${messages[0].errors[0]}`)
      expect(events[thrown].message, session).toBe(events[rejected].message)
    }
    expect(r.observations.afterRefusals.files.filter((f: string) => /F2|F3|Z/.test(path.basename(f)))).toEqual([])
  }, SCENARIO_TIMEOUT)

  it('T6: a lazy fork boots with no prompt, writes nothing until its first prompt, can be re-spawned before it, then holds the parent prefix with its uuids', async () => {
    const r = await real('fork')
    const { parent, forkBeforePrompt, forkAfterPrompt } = r.observations
    expect(eventsOf(r, 'fork1').some((e) => e.k === 'init-resolved')).toBe(true)
    expect(eventsOf(r, 'fork2').some((e) => e.k === 'init-resolved')).toBe(true)
    expect(forkBeforePrompt.files.map((f: string) => path.basename(f))).toEqual(['P.jsonl'])
    expect(forkAfterPrompt.files.map((f: string) => path.basename(f)).sort()).toEqual(['F.jsonl', 'P.jsonl'])
    const parentShape = parent.shape as Array<{ uuid: string }>
    const forkShape = forkAfterPrompt.shape as Array<{ uuid: string, type: string }>
    const keepAtIndex = parentShape.findIndex((line) => line.uuid === 'keepAt')
    expect(keepAtIndex).toBeGreaterThan(0)
    expect(forkShape.slice(0, keepAtIndex + 1).map((line) => line.uuid)).toEqual(parentShape.slice(0, keepAtIndex + 1).map((line) => line.uuid))
    expect(forkShape.map((line) => line.uuid)).not.toContain('u2')
    expect(forkShape.some((line) => line.type === 'user' && line.uuid === 'u3')).toBe(true)
    expect(forkAfterPrompt.parentUnchanged).toBe(true)
    expect(messagesOf(r, 'fork2').filter(isResult).map((m) => m.session_id)).toEqual(['F'])
  }, SCENARIO_TIMEOUT)

  it('T7: setModel and setPermissionMode before the first prompt succeed and write nothing to disk', async () => {
    const r = await real('boot')
    const calls = eventsOf(r, 'S').filter((e) => e.k === 'call')
    expect(calls.map((e) => [e.name, e.ok])).toEqual([['setModel', true], ['setPermissionMode', true]])
    expect(r.observations.afterSettings.files).toEqual([])
    expect(messagesOf(r, 'S').filter(isInit).every((m) => m.permissionMode === 'acceptEdits')).toBe(true)
  }, SCENARIO_TIMEOUT)

  it('T7: the CLI accepts any model or effort name and refuses only an unknown permission mode; the session keeps working', async () => {
    const r = await real('settings')
    const calls = eventsOf(r, 'S').filter((e) => e.k === 'call')
    expect(calls.map((e) => [e.name, e.ok])).toEqual([['setModel', true], ['applyFlagSettings', true], ['setPermissionMode', false], ['setPermissionMode', true]])
    expect(calls[2].message).toBe('Cannot set permission mode: must be one of acceptEdits, auto, bypassPermissions, default, dontAsk, plan')
    expect(results(r, 'S').map((m) => m.subtype)).toEqual(['success'])
    expect(messagesOf(r, 'S').find(isInit)).toMatchObject({ model: 'no-such-model', permissionMode: 'plan' })
  }, SCENARIO_TIMEOUT)

  it('T8: every uuid-stamped send gets command_lifecycle queued, started, then completed or cancelled, and is replayed with our uuid', async () => {
    const boot = await real('boot')
    const bootMessages = messagesOf(boot, 'S')
    expect(bootMessages.find(isInit)?.capabilities).toContain('msg_lifecycle_v1')
    for (const uuid of ['u1', 'u2']) {
      expect(lifecycleStates(bootMessages, uuid)).toEqual(['queued', 'started', 'completed'])
      expect(bootMessages.filter(isReplayOf(uuid))).toHaveLength(1)
    }
    const turns = messagesOf(await real('turns'), 'S')
    for (const uuid of ['u1', 'u2', 'u3', 'u4']) {
      expect(lifecycleStates(turns, uuid), uuid).toEqual(['queued', 'started', 'completed'])
      expect(turns.filter(isReplayOf(uuid)), uuid).toHaveLength(1)
    }
    const interrupted = messagesOf(await real('interrupts'), 'S')
    expect(lifecycleStates(interrupted, 'u1')).toEqual(['queued', 'started', 'cancelled'])
  }, SCENARIO_TIMEOUT)

  it('T8: slash commands are replayed with our uuid, an unknown slash command gets a lifecycle but no replay, and the CLI replays uuids we never sent', async () => {
    const slash = messagesOf(await real('slash'), 'S')
    expect(lifecycleStates(slash, 'u2')).toEqual(['queued', 'started', 'completed'])
    expect(slash.filter(isReplayOf('u2'))).toHaveLength(1)
    expect(lifecycleStates(slash, 'u3')).toEqual(['queued', 'started', 'completed'])
    expect(slash.filter(isReplayOf('u3'))).toEqual([])
    expect(slash.filter(isResult)).toHaveLength(4)
    // setModel before the first prompt replays its own /model command under a CLI-minted uuid.
    const boot = messagesOf(await real('boot'), 'S')
    expect(boot.filter((m) => m.type === 'user' && m.isReplay === true && m.uuid === 'cli').length).toBeGreaterThan(0)
  }, SCENARIO_TIMEOUT)

  it('T9: with CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1, session_state_changed reports running when work starts and idle once per drain', async () => {
    const r = await real('turns')
    const events = eventsOf(r, 'S')
    const messages = messagesOf(r, 'S')
    expect(messages.filter((m) => m.subtype === 'session_state_changed').map((m) => m.state)).toEqual(['running', 'idle', 'running', 'idle'])
    // running precedes the first lifecycle frame of the work it announces
    expect(at(events, isMsg(isState('running')))).toBeLessThan(at(events, isMsg(isLifecycle('u1', 'queued'))))
    // no idle between the two queued turns (u3 then u4)
    const u3Result = events.findIndex((e, i) => i > at(events, isMsg(isLifecycle('u3', 'started'))) && e.k === 'msg' && isResult(e.m))
    const u4Started = at(events, isMsg(isLifecycle('u4', 'started')))
    expect(between(events, u3Result, u4Started, isState('idle'))).toEqual([])
    // the last idle follows the last result
    const lastIdle = events.map((e) => e.k === 'msg' && isState('idle')(e.m)).lastIndexOf(true)
    const lastResult = events.map((e) => e.k === 'msg' && isResult(e.m)).lastIndexOf(true)
    expect(lastIdle).toBeGreaterThan(lastResult)
  }, SCENARIO_TIMEOUT)

  it('T10: a send pushed during a tool call is absorbed into one result; a send pushed during streamed text queues as its own turn', async () => {
    const r = await real('turns')
    const events = eventsOf(r, 'S')
    const resultIndexes = events.flatMap((e, i) => (e.k === 'msg' && isResult(e.m) ? [i] : []))
    expect(resultIndexes).toHaveLength(3)
    const [absorbed, queuedFirst, queuedSecond] = resultIndexes
    // absorbed: both commands start before the single result; u1 completes after it
    expect(at(events, isMsg(isLifecycle('u2', 'started')))).toBeLessThan(absorbed)
    expect(at(events, isMsg(isLifecycle('u1', 'completed')))).toBeGreaterThan(absorbed)
    expect(at(events, isMsg(isReplayOf('u2')))).toBeGreaterThan(at(events, isMsg((m) => m.type === 'user' && !m.isReplay && Array.isArray(m.message?.content) && m.message.content.some((b: any) => b.type === 'tool_result'))))
    // queued: u4 starts only after u3's result and has its own result
    const u4Started = at(events, isMsg(isLifecycle('u4', 'started')))
    expect(u4Started).toBeGreaterThan(queuedFirst)
    expect(u4Started).toBeLessThan(queuedSecond)
    expect(at(events, isMsg(isLifecycle('u4', 'queued')))).toBeLessThan(queuedFirst)
  }, SCENARIO_TIMEOUT)

  it('T10 T5: an absorbed send is recorded as a queued_command attachment inside its turn, so a guarded fork that undoes that turn is refused', async () => {
    const r = await real('absorbed-undo')
    const { parent, afterGuard } = r.observations
    // The absorbed send has no prompt line of its own: it is attachment content
    // of the tool turn (the replay still carries our uuid, T8).
    expect(parent.absorbed).toEqual([{ source: 'u3', prompt: [{ type: 'text', text: 'absorbed during tool' }], mode: 'prompt' }])
    const shape = parent.shape as Array<{ type: string, uuid: string }>
    expect(shape.some((line) => line.uuid === 'u3')).toBe(false)
    expect(shape.filter((line) => line.type === 'user' && line.uuid.startsWith('u')).map((line) => line.uuid)).toEqual(['u1', 'u2'])
    // Undoing the tool turn with the guard declaring its prompt is refused at
    // boot, and the refusal names the absorbed content.
    const guarded = messagesOf(r, 'guarded')
    expect(guarded).toHaveLength(1)
    expect(guarded[0]).toMatchObject({ type: 'result', subtype: 'error_during_execution', num_turns: 0 })
    expect(guarded[0].errors[0]).toMatch(/^Resume rejected by --resume-drops-turn: resuming at keepAt would discard entries not attributable to turn u2: range contains absorbed queued content; entry \d+ \[type=attachment \(queued_command\), uuid=cli\]$/)
    expect(afterGuard.files.map((f: string) => path.basename(f))).toEqual(['P.jsonl'])
  }, SCENARIO_TIMEOUT)

  it('T19 T5: a background agent\'s completion is a task-notification line inside the launching turn, so a guarded fork that undoes that turn is refused', async () => {
    const r = await real('notification-undo')
    const { parent } = r.observations
    expect(parent.notifications).toEqual([{ type: 'user', origin: 'task-notification', xml: true }])
    const shape = parent.shape as Array<{ type: string, uuid: string }>
    expect(shape.filter((line) => line.type === 'user' && line.uuid.startsWith('u')).map((line) => line.uuid)).toEqual(['u1', 'u2'])
    const guarded = messagesOf(r, 'guarded')
    expect(guarded).toHaveLength(1)
    expect(guarded[0]).toMatchObject({ type: 'result', subtype: 'error_during_execution', num_turns: 0 })
    expect(guarded[0].errors[0]).toMatch(/^Resume rejected by --resume-drops-turn: resuming at keepAt would discard entries not attributable to turn u2: range contains an externally-sourced user entry; entry \d+ \[type=user, uuid=cli\]$/)
  }, SCENARIO_TIMEOUT)

  it('T11: a warm interrupt ends the turn with error_during_execution, aborted_streaming or aborted_tools, diagnostic errors and a cancelled lifecycle; the receipt comes first', async () => {
    const r = await real('interrupts')
    const events = eventsOf(r, 'S')
    const all = results(r, 'S')
    expect(all.slice(0, 2).map((m) => [m.subtype, m.is_error, m.terminal_reason])).toEqual([
      ['error_during_execution', true, 'aborted_streaming'],
      ['error_during_execution', true, 'aborted_tools'],
    ])
    for (const result of all.slice(0, 2)) {
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors.every((e: string) => e.startsWith('[ede_diagnostic]'))).toBe(true)
    }
    for (const [tag, uuid] of [['text', 'u1'], ['tool', 'u2']] as const) {
      const receipt = at(events, (e) => e.k === 'interrupt-settled' && e.tag === tag)
      const cancelled = at(events, isMsg(isLifecycle(uuid, 'cancelled')))
      const result = events.findIndex((e, i) => i > receipt && e.k === 'msg' && isResult(e.m))
      expect(result).toBeGreaterThan(receipt)
      expect(cancelled).toBeGreaterThan(result)
    }
  }, SCENARIO_TIMEOUT)

  it('T12: a Stop while a second send is queued returns still_queued [u4]; the running turn aborts and u4 runs as its own turn', async () => {
    const r = await real('interrupts')
    const events = eventsOf(r, 'S')
    const receipt = events.find((e) => e.k === 'interrupt-settled' && e.tag === 'queued')
    expect(receipt?.receipt).toEqual({ still_queued: ['u4'] })
    const all = results(r, 'S')
    expect(all.slice(2).map((m) => [m.subtype, m.terminal_reason])).toEqual([
      ['error_during_execution', 'aborted_streaming'],
      ['success', 'completed'],
    ])
    expect(lifecycleStates(messagesOf(r, 'S'), 'u3')).toEqual(['queued', 'started', 'cancelled'])
    expect(lifecycleStates(messagesOf(r, 'S'), 'u4')).toEqual(['queued', 'started', 'completed'])
  }, SCENARIO_TIMEOUT)

  it('T13: a cold Stop lets the command run to success; re-sending the interrupt when the command starts aborts it (receipt contents are never pinned)', async () => {
    const r = await real('cold-stop')
    expect(eventsOf(r, 'noResend').find((e) => e.k === 'interrupt-settled')).toBeDefined()
    expect(results(r, 'noResend').map((m) => [m.subtype, m.terminal_reason])).toEqual([['success', 'completed']])
    expect(results(r, 'resend').map((m) => [m.subtype, m.is_error])).toEqual([['error_during_execution', true]])
    expect(results(r, 'resend')[0].terminal_reason).toMatch(/^aborted_/)
  }, SCENARIO_TIMEOUT)

  it('T14: SIGKILL of the CLI mid-turn makes the iterator throw with no result; Node stays alive and a later push is lost', async () => {
    const r = await real('crash')
    const events = eventsOf(r, 'S')
    expect(events.find((e) => e.k === 'throw')?.message).toBe('Claude Code process terminated by signal SIGKILL')
    expect(events.find((e) => e.k === 'cli-exit')).toMatchObject({ code: null, signal: 'SIGKILL' })
    expect(results(r, 'S')).toEqual([])
    const thrown = at(events, (e) => e.k === 'throw')
    expect(events.slice(thrown + 1).filter((e) => e.k === 'msg')).toEqual([])
    expect(r.observations.afterCrash).toEqual({ messagesAfterThrow: 0, results: 0, nodeAlive: true })
  }, SCENARIO_TIMEOUT)

  it('T15: /compact is one command with one result: compacting, then null with compact_result, then compact_boundary, then the result; a failed compaction also ends in one result', async () => {
    const r = await real('compact')
    const events = eventsOf(r, 'S')
    for (const [uuid, outcome] of [['u3', 'success'], ['u5', 'failed']] as const) {
      const started = at(events, isMsg(isLifecycle(uuid, 'started')))
      const completed = at(events, isMsg(isLifecycle(uuid, 'completed')))
      const statuses = between(events, started, completed, (m) => m.type === 'system' && m.subtype === 'status')
      expect(statuses.map((m) => [m.status, m.compact_result ?? null]), uuid).toEqual([['compacting', null], [null, outcome]])
      const ordered = between(events, started, completed, (m) => isResult(m) || (m.type === 'system' && ['status', 'compact_boundary'].includes(m.subtype)))
        .map((m) => (isResult(m) ? 'result' : m.subtype === 'status' ? `status:${m.status}` : m.subtype))
      expect(ordered, uuid).toEqual(outcome === 'success'
        ? ['status:compacting', 'status:null', 'compact_boundary', 'result']
        : ['status:compacting', 'status:null', 'result'])
      expect(between(events, started, completed, isResult).map((m) => m.subtype), uuid).toEqual(['success'])
    }
    const failed = messagesOf(r, 'S').find((m) => m.compact_result === 'failed')
    expect(failed.compact_error).toContain('API Error: 400')
    expect(messagesOf(r, 'S').find((m) => m.subtype === 'compact_boundary')?.compact_metadata?.trigger).toBe('manual')
  }, SCENARIO_TIMEOUT)

  it('T16: /clear sends conversation_reset stamped with the old id, then the new session id arrives in the next init and the result; its transcript exists at once and resumes', async () => {
    const r = await real('clear')
    const events = eventsOf(r, 'S')
    const reset = messagesOf(r, 'S').find((m) => m.type === 'conversation_reset')
    expect(reset).toMatchObject({ session_id: 'A' })
    // new_conversation_id is NOT the id of the new session (deviation from the design's T16 wording).
    expect(reset.new_conversation_id).toBe('resetId')
    const resetIndex = at(events, isMsg((m) => m.type === 'conversation_reset'))
    const nextInit = events.slice(resetIndex + 1).find((e) => e.k === 'msg' && isInit(e.m))?.m
    expect(nextInit?.session_id).toBe('B')
    expect(results(r, 'S').map((m) => m.session_id)).toEqual(['A', 'B', 'B'])
    expect(lifecycleStates(messagesOf(r, 'S'), 'u2')).toEqual(['queued', 'started', 'completed'])
    expect(r.observations.afterClear.files.map((f: string) => path.basename(f)).sort()).toEqual(['A.jsonl', 'B.jsonl'])
    expect(eventsOf(r, 'resumeB').some((e) => e.k === 'init-resolved')).toBe(true)
  }, SCENARIO_TIMEOUT)

  it('T17: a running tool reports tool_progress heartbeats every 30 s (a hung MCP tool included), and BASH_MAX_TIMEOUT_MS caps a foreground Bash call', async () => {
    const r = await real('heartbeat')
    for (const [session, tool] of [['mcp', 'mcp__hang__wait'], ['bash', 'Bash']] as const) {
      const events = eventsOf(r, session)
      const toolUse = messagesOf(r, session).find((m) => m.type === 'assistant')?.message?.content?.find((b: any) => b.type === 'tool_use')
      expect(toolUse?.name, session).toBe(tool)
      const heartbeat = events.find((e) => e.k === 'msg' && e.m.type === 'tool_progress')
      expect(heartbeat?.m, session).toMatchObject({
        tool_name: tool,
        heartbeat: true,
        elapsed_time_seconds: 30,
        parent_tool_use_id: toolUse.id,
        tool_use_id: `${toolUse.id}-heartbeat-0`,
      })
      const toolStartedAt = events.find((e) => e.k === 'msg' && e.m.type === 'assistant')!.t
      expect(heartbeat!.t - toolStartedAt, session).toBeGreaterThanOrEqual(29_000)
      expect(messagesOf(r, session).filter(isResult), session).toEqual([])
    }
    const capResult = messagesOf(r, 'cap').find((m) => m.type === 'user' && Array.isArray(m.message?.content) && m.message.content[0]?.type === 'tool_result')
    expect(capResult.message.content[0]).toMatchObject({ is_error: true })
    expect(JSON.stringify(capResult.message.content[0].content)).toContain('Command timed out after 1s')
    expect(r.observations.cap.elapsedMs).toBeLessThan(15_000)
  }, 160_000)

  it('T18: an API error produces an api-error assistant message, then a success-subtype result with is_error and terminal_reason api_error', async () => {
    const r = await real('api-error')
    const messages = messagesOf(r, 'S')
    const assistant = messages.find((m) => m.type === 'assistant')
    expect(assistant).toMatchObject({ is_api_error_message: true })
    expect(assistant.message.content[0].text).toMatch(/^API Error: 400/)
    expect(messages.filter(isResult).map((m) => [m.subtype, m.is_error, m.terminal_reason])).toEqual([['success', true, 'api_error']])
    expect(lifecycleStates(messages, 'u1')).toEqual(['queued', 'started', 'cancelled'])
    expect(r.observations.transcript.shape.filter((line: any) => line.isApiErrorMessage)).toHaveLength(1)
  }, SCENARIO_TIMEOUT)

  it('T19: a background Agent finishing starts an unsolicited CLI turn: task_notification, running, init, a result with no uuid or lifecycle, then idle', async () => {
    const r = await real('cli-turn')
    const events = eventsOf(r, 'S')
    const resultIndexes = events.flatMap((e, i) => (e.k === 'msg' && isResult(e.m) ? [i] : []))
    expect(resultIndexes).toHaveLength(2)
    const [first, second] = resultIndexes
    const cliTurn = events.slice(first + 1)
      .filter((e) => e.k === 'msg' && !e.m.parent_tool_use_id)
      .map((e) => e.m)
      .filter((m) => isResult(m) || isInit(m) || m.subtype === 'session_state_changed' || m.subtype === 'task_notification' || m.type === 'command_lifecycle' || (m.type === 'user' && m.isReplay))
      .map((m) => (isResult(m) ? 'result' : m.type === 'command_lifecycle' ? `lifecycle ${m.command_uuid} ${m.state}` : m.subtype === 'session_state_changed' ? m.state : m.type === 'user' ? 'replay' : m.subtype))
    expect(cliTurn).toEqual(['lifecycle u1 completed', 'idle', 'task_notification', 'running', 'init', 'result', 'idle'])
    expect(messagesOf(r, 'S').filter((m) => m.type === 'command_lifecycle').every((m) => m.command_uuid === 'u1')).toBe(true)
  }, SCENARIO_TIMEOUT)
})

describeSimulatorConformance(real)
