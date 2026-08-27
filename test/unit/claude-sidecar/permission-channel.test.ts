// test/unit/server/claude-sidecar/permission-channel.test.ts
//
// Behavioral tests for crates/freshell-claude-sidecar/permission-channel.mjs and
// its wiring into index.mjs — plan Task 1 (AGENT-05/06 sidecar half). Cases 1-10
// per docs/plans/2026-08-15-fresh-agent-approval-respond.md, a faithful-port
// contract against the legacy reference server/sdk-bridge.ts
// (canUseTool :203-214, handlePermissionRequest :516-569,
// handleAskUserQuestion :571-626, respondQuestion :629-648,
// respondPermission :771-783).

import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  canUseTool,
  cancelPending,
  ensurePending,
  raisePermissionRequest,
  raiseQuestionRequest,
  respondPermission,
  respondQuestion,
} from '../../../crates/freshell-claude-sidecar/permission-channel.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../../..')
const SIDECAR_INDEX = path.join(REPO_ROOT, 'crates', 'freshell-claude-sidecar', 'index.mjs')
const FAKE_QUERY_MODULE = path.join(__dirname, 'fixtures', 'fake-query-module.mjs')
const CRASH_PROBE = path.join(__dirname, 'fixtures', 'sidecar-crash-probe.mjs')

// ── dependency stubs (the channel is dependency-injected; index.mjs passes its
// own emit/nanoid/nextMonotonic, the tests pass equivalents) ─────────────────
type Frame = Record<string, any>

function makeDeps(session: Record<string, any> = {}) {
  const frames: Frame[] = []
  const emit = (frame: Frame) => {
    frames.push(frame)
  }
  let n = 0
  // nanoid stub: exactly 21 url-safe chars, unique per call (real nanoid shape).
  const nanoid = () => `req-${String(++n).padStart(17, '0')}`
  const nextMonotonic = (last: number | undefined, now: number) => (last != null && now <= last ? last + 1 : now)
  return { frames, emit, nanoid, nextMonotonic, session }
}

async function settle<T>(p: Promise<T>, ms = 60): Promise<{ settled: boolean; value: T | undefined }> {
  let settled = false
  let value: T | undefined
  const marked = p.then((v) => {
    settled = true
    value = v
  })
  await Promise.race([marked, new Promise((resolve) => setTimeout(resolve, ms))])
  return { settled, value }
}

// ── child-process harness (cases 8 & 10) ─────────────────────────────────────
const children = new Set<ChildProcess>()
afterEach(() => {
  for (const child of children) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
  children.clear()
})

function trackChild(child: ChildProcess) {
  children.add(child)
  child.on('exit', () => children.delete(child))
  return child
}

function waitForExit(child: ChildProcess, stderrOut: () => string, timeoutMs = 10_000) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`child did not exit within ${timeoutMs}ms; stderr=${stderrOut().slice(-800)}`)),
      timeoutMs,
    )
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

function spawnSidecar(env: Record<string, string> = {}) {
  const child = trackChild(
    spawn(process.execPath, [SIDECAR_INDEX], {
      env: { ...process.env, FRESHELL_CLAUDE_SDK_QUERY_MODULE: FAKE_QUERY_MODULE, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  )
  const frames: Frame[] = []
  let stdoutBuf = ''
  let stderrOut = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8')
    let idx: number
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim()
      stdoutBuf = stdoutBuf.slice(idx + 1)
      if (!line) continue
      try {
        frames.push(JSON.parse(line))
      } catch {
        /* non-JSON line: ignore */
      }
    }
  })
  child.stderr!.on('data', (chunk: Buffer) => {
    stderrOut += chunk.toString('utf8')
  })
  const send = (msg: Frame) => child.stdin!.write(`${JSON.stringify(msg)}\n`)
  const waitFor = (pred: (f: Frame) => boolean, label: string, timeoutMs = 10_000) =>
    new Promise<Frame>((resolve, reject) => {
      const started = Date.now()
      const poll = () => {
        const hit = frames.find(pred)
        if (hit) {
          resolve(hit)
          return
        }
        if (Date.now() - started > timeoutMs) {
          reject(
            new Error(
              `timed out waiting for ${label}; frames=${JSON.stringify(frames)}; stderr=${stderrOut.slice(-800)}`,
            ),
          )
          return
        }
        setTimeout(poll, 10)
      }
      poll()
    })
  return { child, frames, send, waitFor, waitExit: () => waitForExit(child, () => stderrOut), stderr: () => stderrOut }
}

// ── case 1 ───────────────────────────────────────────────────────────────────
describe('case 1: raisePermissionRequest parks, emits request + 0->>=1 waiting edge', () => {
  it('emits sdk.permission.request (minted 21-char id + tool payload) then sdk.turn.waiting; a second park does NOT re-emit waiting', async () => {
    const { frames, emit, nanoid, nextMonotonic, session } = makeDeps()
    const options = {
      toolUseID: 'toolu_1',
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }],
      blockedPath: '/tmp/blocked',
      decisionReason: 'needs approval',
    }
    const p1 = raisePermissionRequest({
      session, emit, nanoid, nextMonotonic,
      sessionId: 's1', toolName: 'Bash', input: { command: 'ls' }, options,
    })

    expect(frames.map((f) => f.type)).toEqual(['sdk.permission.request', 'sdk.turn.waiting'])
    const req = frames[0]
    expect(req.sessionId).toBe('s1')
    expect(req.requestId).toBe('req-00000000000000001')
    expect(req.requestId).toMatch(/^[A-Za-z0-9_-]{21}$/)
    expect(req.subtype).toBe('can_use_tool')
    expect(req.tool).toEqual({ name: 'Bash', input: { command: 'ls' } })
    expect(req.toolUseID).toBe('toolu_1')
    expect(req.suggestions).toEqual(options.suggestions)
    expect(req.blockedPath).toBe('/tmp/blocked')
    expect(req.decisionReason).toBe('needs approval')
    expect(typeof frames[1].at).toBe('number')
    expect(frames[1].sessionId).toBe('s1')
    expect(session.pendingPermissions.size).toBe(1)
    // The returned promise is parked until respond/cancel.
    expect((await settle(p1)).settled).toBe(false)

    // A second parked request emits its own request frame but NOT a second
    // waiting edge (0 -> >=1 transition only).
    const p2 = raisePermissionRequest({
      session, emit, nanoid, nextMonotonic,
      sessionId: 's1', toolName: 'Read', input: { file_path: '/x' }, options,
    })
    expect(frames.map((f) => f.type)).toEqual([
      'sdk.permission.request',
      'sdk.turn.waiting',
      'sdk.permission.request',
    ])
    expect(frames[2].requestId).toBe('req-00000000000000002')
    expect(session.pendingPermissions.size).toBe(2)
    expect((await settle(p2)).settled).toBe(false)

    // Teardown: resolveDeny:false NEVER resolves the parked promises — do not
    // await their settlement (that is the invariant under test).
    cancelPending(session, emit, 's1', { resolveDeny: false })
    expect(session.pendingPermissions.size).toBe(0)
  })
})

// ── case 2 ───────────────────────────────────────────────────────────────────
describe('case 2: respondPermission resolves the parked promise VERBATIM', () => {
  it('resolves with the exact decision object (allow then deny), deletes entries, returns true; unknown id -> false, nothing emitted', async () => {
    const { frames, emit, nanoid, nextMonotonic, session } = makeDeps()
    const p1 = raisePermissionRequest({
      session, emit, nanoid, nextMonotonic,
      sessionId: 's1', toolName: 'Bash', input: { command: 'ls' }, options: { toolUseID: 'toolu_1' },
    })
    const d1 = { behavior: 'allow' }
    const framesBeforeRespond = frames.length
    expect(respondPermission(session, 'req-00000000000000001', d1)).toBe(true)
    await expect(p1).resolves.toBe(d1) // verbatim: identical object, not a copy
    expect(session.pendingPermissions.size).toBe(0)
    expect(frames.length).toBe(framesBeforeRespond) // respond emits no frames

    const p2 = raisePermissionRequest({
      session, emit, nanoid, nextMonotonic,
      sessionId: 's1', toolName: 'Bash', input: { command: 'rm -rf /' }, options: { toolUseID: 'toolu_2' },
    })
    const d2 = { behavior: 'deny', message: 'Denied by user', interrupt: false }
    expect(respondPermission(session, 'req-00000000000000002', d2)).toBe(true)
    await expect(p2).resolves.toBe(d2)
    expect(session.pendingPermissions.size).toBe(0)

    const framesBeforeUnknown = frames.length
    expect(respondPermission(session, 'no-such-request', d1)).toBe(false)
    expect(frames.length).toBe(framesBeforeUnknown)
  })
})

// ── case 3 ───────────────────────────────────────────────────────────────────
describe('case 3: raiseQuestionRequest (AskUserQuestion) sanitizes; short-circuits unusable input', () => {
  it('sanitizes questions ({question,header,options:[{label,description}],multiSelect} + spread extras), emits request + waiting edge, parks', async () => {
    const { frames, emit, nanoid, nextMonotonic, session } = makeDeps()
    const input = {
      questions: [
        {
          id: 'q1', // extra key survives via spread
          question: 'Pick one',
          header: 'Choice',
          options: [{ extraOpt: true, label: 'A', description: 'a' }],
          multiSelect: false,
        },
        { question: 42, options: 'nope' }, // malformed fields normalize
      ],
      marker: 'keep-me',
    }
    const pending = raiseQuestionRequest({ session, emit, nanoid, nextMonotonic, sessionId: 's1', input })

    expect(frames.map((f) => f.type)).toEqual(['sdk.question.request', 'sdk.turn.waiting'])
    const req = frames[0]
    expect(req.sessionId).toBe('s1')
    expect(req.requestId).toBe('req-00000000000000001')
    expect(req.questions).toEqual([
      {
        id: 'q1',
        question: 'Pick one',
        header: 'Choice',
        options: [{ extraOpt: true, label: 'A', description: 'a' }],
        multiSelect: false,
      },
      { question: '42', header: '', options: [], multiSelect: false },
    ])
    expect(session.pendingQuestions.size).toBe(1)
    expect((await settle(pending)).settled).toBe(false)

    // Never-resolving by design (resolveDeny:false) — do not await settlement.
    cancelPending(session, emit, 's1', { resolveDeny: false })
  })

  it('empty / invalid questions arrays short-circuit to {behavior:allow, updatedInput: input} and park nothing', async () => {
    const badInputs: Array<Record<string, any>> = [
      { questions: [] },
      { questions: 'nope' },
      {},
      { questions: [null, 7] }, // filters to empty
    ]
    for (const input of badInputs) {
      const { frames, emit, nanoid, nextMonotonic, session } = makeDeps()
      const result = await raiseQuestionRequest({ session, emit, nanoid, nextMonotonic, sessionId: 's1', input })
      expect(result).toEqual({ behavior: 'allow', updatedInput: input })
      expect(result.updatedInput).toBe(input) // untouched input object
      expect(frames).toEqual([])
      expect(session.pendingQuestions.size).toBe(0)
      expect(session.pendingPermissions.size).toBe(0)
    }
  })
})

// ── case 4 ───────────────────────────────────────────────────────────────────
describe('case 4: respondQuestion wraps answers into an allow decision', () => {
  it('resolves {behavior:allow, updatedInput:{...originalInput, questions, answers}}; unknown id -> false', async () => {
    const { frames, emit, nanoid, nextMonotonic, session } = makeDeps()
    const input = {
      questions: [
        { question: 'Pick one', header: 'H', options: [{ label: 'A', description: 'a' }], multiSelect: false },
      ],
      marker: 'keep-me',
    }
    const pending = raiseQuestionRequest({ session, emit, nanoid, nextMonotonic, sessionId: 's1', input })
    const sanitized = frames[0].questions
    const answers = { 'Pick one': 'A' }
    const framesBeforeRespond = frames.length

    expect(respondQuestion(session, 'req-00000000000000001', answers)).toBe(true)
    await expect(pending).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {
        marker: 'keep-me', // original extras preserved
        questions: sanitized, // sanitized questions, not the raw array
        answers,
      },
    })
    expect(session.pendingQuestions.size).toBe(0)
    expect(frames.length).toBe(framesBeforeRespond)

    expect(respondQuestion(session, 'req-00000000000000001', answers)).toBe(false)
    expect(respondQuestion(session, 'no-such-request', answers)).toBe(false)
  })
})

// ── case 5 (LB-04 cancel split) ──────────────────────────────────────────────
describe('case 5: cancelPending splits by live state (LB-04: never a late resolve after close)', () => {
  it('resolveDeny:true (post-interrupt, transport open) emits cancel frames per entry and resolves each parked promise deny/Interrupted', async () => {
    const { frames, emit, nanoid, nextMonotonic, session } = makeDeps()
    const pr = raisePermissionRequest({
      session, emit, nanoid, nextMonotonic,
      sessionId: 's1', toolName: 'Bash', input: { command: 'ls' }, options: { toolUseID: 't1' },
    })
    const qr = raiseQuestionRequest({
      session, emit, nanoid, nextMonotonic, sessionId: 's1',
      input: { questions: [{ question: 'Q?', header: '', options: [], multiSelect: true }] },
    })
    frames.length = 0

    cancelPending(session, emit, 's1', { resolveDeny: true })

    expect(frames.map((f) => [f.type, f.sessionId, f.requestId])).toEqual([
      ['sdk.permission.cancelled', 's1', 'req-00000000000000001'],
      ['sdk.question.cancelled', 's1', 'req-00000000000000002'],
    ])
    // A cancel resolves DENY — never a fabricated user approval.
    await expect(pr).resolves.toEqual({ behavior: 'deny', message: 'Interrupted' })
    await expect(qr).resolves.toEqual({ behavior: 'deny', message: 'Interrupted' })
    expect(session.pendingPermissions.size).toBe(0)
    expect(session.pendingQuestions.size).toBe(0)
  })

  it('resolveDeny:false (post-close/shutdown) emits cancel frames and NEVER resolves the parked promises', async () => {
    const { frames, emit, nanoid, nextMonotonic, session } = makeDeps()
    const pr = raisePermissionRequest({
      session, emit, nanoid, nextMonotonic,
      sessionId: 's1', toolName: 'Bash', input: { command: 'ls' }, options: { toolUseID: 't1' },
    })
    const qr = raiseQuestionRequest({
      session, emit, nanoid, nextMonotonic, sessionId: 's1',
      input: { questions: [{ question: 'Q?', header: '', options: [], multiSelect: true }] },
    })
    frames.length = 0

    cancelPending(session, emit, 's1', { resolveDeny: false })

    expect(frames.map((f) => [f.type, f.requestId])).toEqual([
      ['sdk.permission.cancelled', 'req-00000000000000001'],
      ['sdk.question.cancelled', 'req-00000000000000002'],
    ])
    expect((await settle(pr)).settled).toBe(false)
    expect((await settle(qr)).settled).toBe(false)
    expect(session.pendingPermissions.size).toBe(0)
    expect(session.pendingQuestions.size).toBe(0)
  })
})

// ── cases 6 & 7: canUseTool adapter routing ──────────────────────────────────
describe('cases 6/7: canUseTool adapter preserves legacy ordering (sdk-bridge.ts:203-214)', () => {
  it('case 6: bypassPermissions -> immediate allow, nothing emitted, nothing parked', async () => {
    const { frames, emit, nanoid, nextMonotonic, session } = makeDeps({ permissionMode: 'bypassPermissions' })
    const input = { command: 'ls' }
    const result = await canUseTool({
      session, emit, nanoid, nextMonotonic,
      sessionId: 's1', toolName: 'Bash', input, options: { toolUseID: 't1' },
    })
    expect(result).toEqual({ behavior: 'allow', updatedInput: input })
    expect(result.updatedInput).toBe(input)
    expect(frames).toEqual([])
    expect(session.pendingPermissions?.size ?? 0).toBe(0)
    expect(session.pendingQuestions?.size ?? 0).toBe(0)
  })

  it('case 7: AskUserQuestion routes to the question path even under bypassPermissions', async () => {
    const { frames, emit, nanoid, nextMonotonic, session } = makeDeps({ permissionMode: 'bypassPermissions' })
    const input = {
      questions: [{ question: 'Q?', header: 'h', options: [{ label: 'A', description: 'a' }], multiSelect: false }],
    }
    const pending = canUseTool({
      session, emit, nanoid, nextMonotonic,
      sessionId: 's1', toolName: 'AskUserQuestion', input, options: { toolUseID: 't2' },
    })
    expect(frames.map((f) => f.type)).toEqual(['sdk.question.request', 'sdk.turn.waiting'])
    expect(session.pendingQuestions.size).toBe(1)
    expect(session.pendingPermissions?.size ?? 0).toBe(0)
    cancelPending(session, emit, 's1', { resolveDeny: false })
  })
})

// ── case 8: no-guard invariant probe ─────────────────────────────────────────
describe('case 8: no-guard invariant probe (reviewed guard design: crash loudly, NEVER swallow)', () => {
  it('a synthetic unhandled rejection inside the sidecar process exits NONZERO (Node default fatal path)', async () => {
    const child = trackChild(
      spawn(process.execPath, [CRASH_PROBE], {
        env: {
          ...process.env,
          SIDECAR_INDEX_PATH: SIDECAR_INDEX,
          FRESHELL_CLAUDE_SDK_QUERY_MODULE: FAKE_QUERY_MODULE,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    )
    let stderrOut = ''
    child.stderr!.on('data', (c: Buffer) => (stderrOut += c.toString('utf8')))
    child.stdout!.resume() // drain; nothing relevant is emitted
    // Attach the exit listener BEFORE triggering the fatal rejection — the child
    // may crash before we would otherwise subscribe.
    const exitP = waitForExit(child, () => stderrOut)
    child.stdin!.write('{"type":"__reject__"}\n')
    await new Promise((r) => setTimeout(r, 150)) // let the rejection land before stdin closes
    child.stdin!.end()

    const { code, signal } = await exitP
    // No process-level swallow handlers: the rejection must kill the process
    // itself (nonzero code, no external signal), so Rust exit-eviction engages.
    expect(signal).toBeNull()
    expect(code).not.toBeNull()
    expect(code).not.toBe(0)
    expect(stderrOut).toContain('synthetic-unhandled')
  })
})

// ── case 9: provider-originated cancellation (options.signal, round-2 F1) ────
describe('case 9: options.signal subscription (provider cancellation removes the card without inventing a user decision)', () => {
  it('abort deletes the pending entry, emits sdk.permission.cancelled, resolves deny/Aborted by provider', async () => {
    const { frames, emit, nanoid, nextMonotonic, session } = makeDeps()
    const ctrl = new AbortController()
    const pr = raisePermissionRequest({
      session, emit, nanoid, nextMonotonic,
      sessionId: 's1', toolName: 'Bash', input: { command: 'ls' }, options: { toolUseID: 't1', signal: ctrl.signal },
    })
    frames.length = 0

    ctrl.abort()

    expect(frames).toEqual([{ type: 'sdk.permission.cancelled', sessionId: 's1', requestId: 'req-00000000000000001' }])
    await expect(pr).resolves.toEqual({ behavior: 'deny', message: 'Aborted by provider' })
    expect(session.pendingPermissions.size).toBe(0)
  })

  it('abort after a respond is inert: no cancel frame, no second resolution', async () => {
    const { frames, emit, nanoid, nextMonotonic, session } = makeDeps()
    const ctrl = new AbortController()
    const decision = { behavior: 'allow' }
    const pr = raisePermissionRequest({
      session, emit, nanoid, nextMonotonic,
      sessionId: 's1', toolName: 'Bash', input: { command: 'ls' }, options: { toolUseID: 't1', signal: ctrl.signal },
    })
    expect(respondPermission(session, 'req-00000000000000001', decision)).toBe(true)
    frames.length = 0

    ctrl.abort()

    expect(frames).toEqual([])
    await expect(pr).resolves.toBe(decision)
  })

  it('a parked question aborts the same way: sdk.question.cancelled + deny/Aborted by provider', async () => {
    const { frames, emit, nanoid, nextMonotonic, session } = makeDeps()
    const ctrl = new AbortController()
    const qr = raiseQuestionRequest({
      session, emit, nanoid, nextMonotonic, sessionId: 's1',
      input: { questions: [{ question: 'Q?', header: '', options: [], multiSelect: false }] },
      signal: ctrl.signal,
    })
    frames.length = 0

    ctrl.abort()

    expect(frames).toEqual([{ type: 'sdk.question.cancelled', sessionId: 's1', requestId: 'req-00000000000000001' }])
    await expect(qr).resolves.toEqual({ behavior: 'deny', message: 'Aborted by provider' })
    expect(session.pendingQuestions.size).toBe(0)
  })
})

// ── review follow-up (Minor 1): pre-aborted signal short-circuit pins ────────
// Characterization pins for the preemptive-deny branches at
// permission-channel.mjs:39/:107 (report-disclosed untested branches): an
// already-aborted provider parks nothing, emits nothing, and resolves the deny
// payload at once — never a card for a dead request.
describe('pre-aborted signal short-circuits: never park, never emit, resolve deny at once', () => {
  it('raisePermissionRequest with an already-aborted options.signal: no frames, nothing parked, resolves deny/Aborted by provider', async () => {
    const { frames, emit, nanoid, nextMonotonic, session } = makeDeps()
    const ctrl = new AbortController()
    ctrl.abort()
    const result = await raisePermissionRequest({
      session, emit, nanoid, nextMonotonic,
      sessionId: 's1', toolName: 'Bash', input: { command: 'ls' },
      options: { toolUseID: 't1', signal: ctrl.signal },
    })
    expect(result).toEqual({ behavior: 'deny', message: 'Aborted by provider' })
    expect(frames).toEqual([])
    expect(session.pendingPermissions?.size ?? 0).toBe(0)
    expect(session.pendingQuestions?.size ?? 0).toBe(0)
  })

  it('raiseQuestionRequest with an already-aborted signal: no frames, nothing parked, resolves deny/Aborted by provider', async () => {
    const { frames, emit, nanoid, nextMonotonic, session } = makeDeps()
    const ctrl = new AbortController()
    ctrl.abort()
    // Usable questions, so the raise reaches the pre-aborted branch (:107) rather
    // than the empty/invalid allow short-circuits that precede it (:81-105).
    const result = await raiseQuestionRequest({
      session, emit, nanoid, nextMonotonic, sessionId: 's1',
      input: { questions: [{ question: 'Q?', header: '', options: [], multiSelect: false }] },
      signal: ctrl.signal,
    })
    expect(result).toEqual({ behavior: 'deny', message: 'Aborted by provider' })
    expect(frames).toEqual([])
    expect(session.pendingQuestions?.size ?? 0).toBe(0)
    expect(session.pendingPermissions?.size ?? 0).toBe(0)
  })
})

// ── case 10: production-wiring contract test (round-2 F4) ────────────────────
describe('case 10: production wiring through the real index.mjs (FRESHELL_CLAUDE_SDK_QUERY_MODULE seam)', () => {
  it('create -> magic send -> canUseTool -> respond; interrupt cancels a second park; question routing; shutdown', async () => {
    const harness = spawnSidecar()

    // create — placeholder id comes straight back
    harness.send({ type: 'create', requestId: 'r-create-1', permissionMode: 'default' })
    const created = await harness.waitFor((f) => f.type === 'created', 'created')
    const sessionId = created.sessionId as string
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]{16,32}$/)

    // magic send -> the fake query module invokes options.canUseTool ->
    // sdk.permission.request + waiting edge on stdout (order: request first).
    harness.send({ type: 'send', sessionId, text: '__raise_permission__' })
    const permReq = await harness.waitFor((f) => f.type === 'sdk.permission.request', 'sdk.permission.request')
    expect(permReq.sessionId).toBe(sessionId)
    expect(permReq.requestId).toMatch(/^[A-Za-z0-9_-]{21}$/) // real sidecar nanoid
    expect(permReq.subtype).toBe('can_use_tool')
    expect(permReq.tool).toEqual({ name: 'Bash', input: { command: 'ls' } })
    expect(permReq.toolUseID).toBe('toolu_fake_1')
    expect(permReq.suggestions).toEqual([
      { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
    ])
    expect(permReq.blockedPath).toBe('/tmp/blocked')
    expect(permReq.decisionReason).toBe('needs approval')
    const waiting1 = await harness.waitFor((f) => f.type === 'sdk.turn.waiting', 'sdk.turn.waiting')
    expect(harness.frames.indexOf(permReq)).toBeLessThan(harness.frames.indexOf(waiting1))

    // permission.respond — the fake's parked promise settles with the EXACT decision
    const decision = { behavior: 'allow', updatedInput: { command: 'ls -la' } }
    harness.send({ type: 'permission.respond', sessionId, requestId: permReq.requestId, decision })
    const resolved1 = await harness.waitFor(
      (f) => f.type === 'probe.resolved' && f.kind === 'permission' && f.n === 1,
      'probe.resolved permission #1',
    )
    expect(resolved1.decision).toEqual(decision)

    // question routing through the production entry: AskUserQuestion ->
    // sdk.question.request; question.respond wraps answers per legacy
    harness.send({ type: 'send', sessionId, text: '__raise_question__' })
    const qReq = await harness.waitFor((f) => f.type === 'sdk.question.request', 'sdk.question.request')
    expect(qReq.sessionId).toBe(sessionId)
    expect(qReq.questions).toEqual([
      {
        question: 'Pick one',
        header: 'Choice',
        options: [{ label: 'A', description: 'Option A' }],
        multiSelect: false,
      },
    ])
    const answers = { 'Pick one': 'A' }
    harness.send({ type: 'question.respond', sessionId, requestId: qReq.requestId, answers })
    const resolvedQ = await harness.waitFor(
      (f) => f.type === 'probe.resolved' && f.kind === 'question' && f.n === 1,
      'probe.resolved question #1',
    )
    expect(resolvedQ.decision).toEqual({
      behavior: 'allow',
      updatedInput: {
        marker: 'keep-me',
        questions: qReq.questions,
        answers,
      },
    })

    // unknown respond ids are no-ops (log-only): the session stays healthy
    harness.send({ type: 'permission.respond', sessionId, requestId: 'no-such-request', decision })

    // second park -> interrupt -> cancel frame + deny/Interrupted (resolveDeny split)
    harness.send({ type: 'send', sessionId, text: '__raise_permission__' })
    const permReq2 = await harness.waitFor(
      (f) => f.type === 'sdk.permission.request' && f.requestId !== permReq.requestId,
      'second sdk.permission.request',
    )
    harness.send({ type: 'interrupt', sessionId })
    const cancelFrame = await harness.waitFor((f) => f.type === 'sdk.permission.cancelled', 'sdk.permission.cancelled')
    expect(cancelFrame.sessionId).toBe(sessionId)
    expect(cancelFrame.requestId).toBe(permReq2.requestId)
    const resolved2 = await harness.waitFor(
      (f) => f.type === 'probe.resolved' && f.kind === 'permission' && f.n === 2,
      'probe.resolved permission #2',
    )
    expect(resolved2.decision).toEqual({ behavior: 'deny', message: 'Interrupted' })

    // clean teardown
    const exitP = harness.waitExit()
    harness.send({ type: 'shutdown' })
    const { code, signal } = await exitP
    expect(signal).toBeNull()
    expect(code).toBe(0)
  })
})

// ── review follow-up (Nit 2): permission.respond missing-decision guard ──────
// A hand-crafted permission.respond with no decision must NOT resolve the parked
// promise (undefined is not a PermissionResult, and a synthesized default would
// fabricate the user's choice): the arm logs to stderr and leaves the entry
// parked for a later valid respond — the mirror of the coerced-answers asymmetry
// one arm below (index.mjs question.respond).
describe('production wiring: permission.respond with a null/absent decision is a log-only no-op', () => {
  it('the parked entry survives a decisionless respond; a later valid respond resolves verbatim', async () => {
    const harness = spawnSidecar()

    harness.send({ type: 'create', requestId: 'r-create-guard', permissionMode: 'default' })
    const created = await harness.waitFor((f) => f.type === 'created', 'created')
    const sessionId = created.sessionId as string

    harness.send({ type: 'send', sessionId, text: '__raise_permission__' })
    const permReq = await harness.waitFor((f) => f.type === 'sdk.permission.request', 'sdk.permission.request')

    // Hand-crafted malformed frame: NO decision key at all.
    harness.send({ type: 'permission.respond', sessionId, requestId: permReq.requestId })

    // Log-only no-op: stderr carries the guard line, and the parked promise must
    // NOT settle (no probe.resolved frame) within a generous window.
    await new Promise((r) => setTimeout(r, 300))
    expect(harness.stderr()).toContain('permission.respond: missing decision')
    expect(harness.frames.filter((f) => f.type === 'probe.resolved')).toEqual([])

    // The entry is still parked: a later well-formed respond resolves verbatim.
    const decision = { behavior: 'deny', message: 'Denied by user' }
    harness.send({ type: 'permission.respond', sessionId, requestId: permReq.requestId, decision })
    const resolved = await harness.waitFor(
      (f) => f.type === 'probe.resolved' && f.kind === 'permission',
      'probe.resolved after the valid respond',
    )
    expect(resolved.decision).toEqual(decision)
    expect(harness.frames.filter((f) => f.type === 'probe.resolved')).toHaveLength(1)

    // Clean teardown.
    const exitP = harness.waitExit()
    harness.send({ type: 'shutdown' })
    const { code, signal } = await exitP
    expect(signal).toBeNull()
    expect(code).toBe(0)
  })
})

// ensurePending is part of the module's public surface (lazy map attachment).
describe('ensurePending', () => {
  it('lazily attaches the two pending maps, idempotently', () => {
    const session: Record<string, any> = {}
    const out = ensurePending(session)
    expect(out).toBe(session)
    expect(session.pendingPermissions).toBeInstanceOf(Map)
    expect(session.pendingQuestions).toBeInstanceOf(Map)
    const perms = session.pendingPermissions
    ensurePending(session)
    expect(session.pendingPermissions).toBe(perms) // not replaced
  })
})
