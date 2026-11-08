
import fs from 'node:fs'
import readline from 'node:readline'

const spawnLog = process.env.FRESHELL_TEST_CLAUDE_SPAWN_LOG
const respondLog = process.env.FRESHELL_TEST_CLAUDE_RESPOND_LOG
// Task 4 review (C1) determinism knob: DEFER every create ANSWER by N ms. The
// create request is still logged IMMEDIATELY (the spawn-log gate observes the
// rollback parked inside its respawn), so a test can fire a send while the
// rollback deterministically waits on `created` — the mid-rollback send
// interleaving is guaranteed, never luck.
const deferCreateMs = parseInt(process.env.FRESHELL_TEST_CLAUDE_DEFER_CREATE_MS || '0', 10)
// Task 4 review (M3) provable-rejection knob: die on create like a spawn-time
// provider rejection (EOF before `created`).
const failCreate = process.env.FRESHELL_TEST_CLAUDE_FAIL_CREATE === '1'

let counter = 0
// Task 4c (ep3-r2 F2): live-session membership — the real sidecar DELETES its
// JS session when consumeStream's finally runs (stream end) while stdout stays
// open, so a later send is answered by a lone signed `sdk.error` (no terminal
// edge, no EOF). `__drop_session__` simulates that provider-side death.
const liveSessions = new Set(
  (process.env.FRESHELL_TEST_CLAUDE_PRESEED_SESSIONS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
) // ep4-r2: the live-fixture rig boots WITHOUT a `create` frame — preseed its durable ids here so its sends are not answered with session-not-found.
// ep4-r3: a minimal model of the SDK-input queue for compact intents — every
// `/compact` send sits in it until the quiesce DRAINS it (the drain-count IS
// the cancelledQueue the real sidecar reports), mirroring the real
// cancellation authority at the pre-handoff residence.
const compactQueue = []
const configuredSettings = new Map()
const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }
  if (msg.type === 'create') {
    // Log the WHOLE create request (one line per create) so tests can both count
    // spawns AND assert what the sidecar received (e.g. resumeSessionId).
    if (spawnLog) {
      fs.appendFileSync(spawnLog, `${JSON.stringify(msg)}\n`)
    }
    if (failCreate) process.exit(1)
    const answer = () => {
      counter += 1
      const sessionId = `fake-claude-session-${process.pid}-${counter}`
      liveSessions.add(sessionId)
      configuredSettings.set(sessionId, { model: msg.model, effort: msg.effort, permissionMode: msg.permissionMode, cwd: msg.cwd })
      process.stdout.write(JSON.stringify({ type: 'created', sessionId }) + '\n')
      // Mirror the real sidecar's post-create init: echo resumeSessionId as the durable
      // id when present (resume continuity), else a fixed fake uuid.
      // Task 4 (kata 1wxv): a forkSession:true create mints a FRESH durable id,
      // never an echo — fork-at-point adoption depends on the id changing.
      const cliSessionId = msg.forkSession === true
        ? `fork-${process.pid}-${counter}-0000-4000-8000-000000000000`
        : (msg.resumeSessionId || 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
      console.log(JSON.stringify({ type: 'sdk.session.init', sessionId, cliSessionId, model: 'fake-model', cwd: '/tmp', tools: [] }))
      console.log(JSON.stringify({ type: 'sdk.status', sessionId, status: 'idle' }))
    }
    if (deferCreateMs > 0) setTimeout(answer, deferCreateMs)
    else answer()
  } else if (msg.type === 'configure') {
    if (respondLog) fs.appendFileSync(respondLog, `${JSON.stringify(msg)}\n`)
    console.log(JSON.stringify({ type: 'sdk.session.changed', sessionId: msg.sessionId, reason: 'session-commands', commands: [{ name: 'review', description: 'Review changes' }] }))
    const settings = configuredSettings.get(msg.sessionId) ?? {}
    const ok = msg.settings?.model !== 'unavailable' && msg.settings?.effort !== 'invalid'
    if (msg.settings?.model !== 'unavailable') settings.model = msg.settings.model
    if (ok) Object.assign(settings, msg.settings)
    console.log(JSON.stringify({ type: 'sdk.configured', sessionId: msg.sessionId, requestId: msg.requestId, ok, settings, message: 'Model or effort is unavailable' }))
  } else if (msg.type === 'send') {
    // Test hook: lets tests kill the sidecar THROUGH the public API to exercise
    // the consumer-exit eviction path (ledger A9).
    if (msg.text === '__exit__') process.exit(0)
    // Task 4 (kata 1wxv) in_turn edge hooks: each magic text emits ONE canned sdk.*
    // line so the four-edge/fail-closed busy contract can drive every edge.
    if (msg.text === '__emit_result_error__') {
      console.log(JSON.stringify({ type: 'sdk.result', sessionId: msg.sessionId, result: 'error_during_execution' }))
    } else if (msg.text === '__emit_idle__') {
      console.log(JSON.stringify({ type: 'sdk.status', sessionId: msg.sessionId, status: 'idle' }))
    } else if (msg.text === '__emit_error__') {
      console.log(JSON.stringify({ type: 'sdk.error', sessionId: msg.sessionId, message: 'boom' }))
    } else if (msg.text === '__emit_compacting__') {
      console.log(JSON.stringify({ type: 'sdk.status', sessionId: msg.sessionId, status: 'compacting' }))
    // Task 4b (kata 1wxv, ep3-r1 F1): the SDK's compact COMPLETION boundary
    // carries the manual/auto trigger the bare `compacting` status lacks — the
    // ONLY wire-level way to tell an explicit `/compact` run apart from the
    // SDK's automatic context compaction. The real sidecar relays it as
    // `sdk.compact_boundary {trigger}` (crates/freshell-claude-sidecar).
    } else if (msg.text === '__emit_compact_boundary_manual__') {
      console.log(JSON.stringify({ type: 'sdk.compact_boundary', sessionId: msg.sessionId, trigger: 'manual' }))
    } else if (msg.text === '__emit_compact_boundary_auto__') {
      console.log(JSON.stringify({ type: 'sdk.compact_boundary', sessionId: msg.sessionId, trigger: 'auto' }))
    } else if (msg.text === '__drop_session__') {
      liveSessions.delete(msg.sessionId)
    } else if (!liveSessions.has(msg.sessionId)) {
      // Task 4c (ep3-r2 F2): the provider-side session was DELETED (stream end)
      // while stdout stayed open — the real sidecar answers with this lone
      // signed frame and NOTHING after (no result, no idle, no EOF).
      console.log(JSON.stringify({ type: 'sdk.error', sessionId: msg.sessionId, message: 'session not found', sessionNotFound: true }))
    } else if (/^\s*\/compact(\s|$)/.test(String(msg.text ?? ''))) {
      // ep4-r3: track compact intents in the fake's queue (the quiesce arm
      // drains them) — then log like every other non-magic send.
      compactQueue.push(msg.text)
      if (respondLog) fs.appendFileSync(respondLog, `${JSON.stringify(msg)}\n`)
    } else if (msg.text === '__emit_assistant__') {
      console.log(JSON.stringify({ type: 'sdk.assistant', sessionId: msg.sessionId, content: [{ type: 'text', text: 'noise' }] }))
    // Task 2 test hook: raise a canned pending permission the approve/deny flow can
    // respond to. The fake parks nothing — Rust's pending fold is the state under test.
    } else if (msg.text === '__raise_permission__') {
      process.stdout.write(JSON.stringify({
        type: 'sdk.permission.request',
        sessionId: msg.sessionId,
        requestId: 'req-1',
        subtype: 'can_use_tool',
        tool: { name: 'Bash', input: { command: 'ls' } },
        toolUseID: 'toolu_fake_1',
        blockedPath: null,
        decisionReason: null,
      }) + '\n')
    } else if (msg.text.startsWith('__set_status__:')) {
      // Reconnect-revive hook: emit a real sdk.status frame so a test can arrange a
      // non-default tracked status through the REAL stdout consumer fold (the attach
      // ack under test speaks it back).
      process.stdout.write(JSON.stringify({ type: 'sdk.status', sessionId: msg.sessionId, status: msg.text.slice('__set_status__:'.length) }) + '\n')
    } else if (msg.text === '__emit_assistant__') {
      // Reconnect-revive hook: emit a real sdk.assistant frame (the real wire shape —
      // index.mjs:165) so a test can drive the tracker's turn-start ("running") fold.
      process.stdout.write(JSON.stringify({ type: 'sdk.assistant', sessionId: msg.sessionId, content: [{ type: 'text', text: 'part' }], model: 'fake-model' }) + '\n')
    } else if (msg.text === '__emit_result__') {
      // Reconnect-revive hook: emit a real sdk.result frame (the real wire shape —
      // index.mjs:177) so a test can drive the tracker's turn-complete settle fold.
      process.stdout.write(JSON.stringify({ type: 'sdk.result', sessionId: msg.sessionId, result: 'success', durationMs: 1, costUsd: 0, usage: {} }) + '\n')
    } else if (respondLog) {
      // Non-magic sends (e.g. `/compact …`) land in the respond log verbatim so
      // tests can assert the exact stdin frame shape the compact handler writes.
      fs.appendFileSync(respondLog, `${JSON.stringify(msg)}\n`)
    }
  } else if (msg.type === 'permission.respond' || msg.type === 'question.respond') {
    if (respondLog) fs.appendFileSync(respondLog, `${JSON.stringify(msg)}\n`)
  } else if (msg.type === 'interrupt') {
    const interruptLog = process.env.FRESHELL_TEST_CLAUDE_INTERRUPT_LOG
    if (interruptLog) fs.appendFileSync(interruptLog, `${msg.sessionId}\n`)
    // Task 4c (kata 1wxv focused ep4-r1/ep4-r2 F1): the interrupt SETTLES
    // asynchronously, and per the SDK contract (`sdk.d.ts:3760`) the control
    // receipt is written BEFORE the interrupted turn's terminal `sdk.result`
    // — so the fake mirrors: settle frame first, then (accepted case) the
    // interrupted turn's own result + paired idle, IN THAT ORDER. The
    // rollback gate opens at the RESULTS, never at the receipt. A knocked-out
    // settle (probe on an idle sidecar) still stands alone: with no in-flight
    // op the result folds harmlessly on an empty tracker.
    //
    // Knobs: FRESHELL_TEST_CLAUDE_INTERRUPT_REJECT=1 — the provider REJECTED
    // the interrupt (ok:false, NO trailing result/idle: the turn still runs
    // and its own later edge owns it — the gate stays closed);
    // FRESHELL_TEST_CLAUDE_INTERRUPT_SETTLE_MS — defer the whole settle→result
    // →idle chain (the request↔settle window is the provider-work window the
    // gate must hold);
    // FRESHELL_TEST_CLAUDE_PROBE_COMPACT_BEFORE_SETTLE=1 — BEFORE the settle,
    // emit `sdk.status:compacting` (the absorbed compact debt started in the
    // sidecar before consuming the probe request: rollback's recheck must see
    // the revived candidate via the probe's in-order stream position and
    // ABORT the teardown) — and NO trailing result/idle for the compact: its
    // own terminal edge has not yet landed (the hazard window).
    const settleMs = parseInt(process.env.FRESHELL_TEST_CLAUDE_INTERRUPT_SETTLE_MS || '0', 10)
    const reject = process.env.FRESHELL_TEST_CLAUDE_INTERRUPT_REJECT === '1'
    const compactBeforeSettle = process.env.FRESHELL_TEST_CLAUDE_PROBE_COMPACT_BEFORE_SETTLE === '1'
    const settle = () => {
      if (compactBeforeSettle) {
        console.log(JSON.stringify({ type: 'sdk.status', sessionId: msg.sessionId, status: 'compacting' }))
      }
      console.log(JSON.stringify({ type: 'sdk.interrupt_settled', sessionId: msg.sessionId, ok: !reject }))
      if (!reject && !compactBeforeSettle) {
        console.log(JSON.stringify({ type: 'sdk.result', sessionId: msg.sessionId, subtype: 'error', errors: ['interrupted'] }))
        console.log(JSON.stringify({ type: 'sdk.status', sessionId: msg.sessionId, status: 'idle' }))
      }
    }
    if (settleMs > 0) setTimeout(settle, settleMs)
    else settle()
  } else if (msg.type === 'rollback.quiesce') {
    // Task 4c (kata 1wxv ep4-r3): rollback's pre-teardown quiesce probe. The
    // fake drains its tracked compact queue and answers with a
    // probeId-correlated verdict, echoing the real sidecar's stream order and
    // fields. Knob FRESHELL_TEST_CLAUDE_PROBE_COMPACT_BEFORE_SETTLE=1 models
    // the un-cancellable race: an absorbed compact was HANDED to an idle SDK
    // consumer before the probe — its compacting STATUS lands first (in-order
    // evidence) and the answer reports handedCompactLikely (BUSY verdict); no
    // trailing terminal frames (its run never completed in the hazard window).
    const compactBeforeSettle = process.env.FRESHELL_TEST_CLAUDE_PROBE_COMPACT_BEFORE_SETTLE === '1'
    // FRESHELL_TEST_CLAUDE_PROBE_WRONG_ID=1 — answer with a FOREIGN probe id
    // (a stale receipt): the probe must stay open and time out, never close on
    // it (ep4-r3 F2 correlation).
    const wrongId = process.env.FRESHELL_TEST_CLAUDE_PROBE_WRONG_ID === '1'
    const echoId = wrongId ? 'stale-receipt-not-this-probe' : (msg.probeId ?? null)
    if (compactBeforeSettle) {
      console.log(JSON.stringify({ type: 'sdk.status', sessionId: msg.sessionId, status: 'compacting' }))
      console.log(JSON.stringify({ type: 'sdk.rollback.quiesced', sessionId: msg.sessionId, probeId: echoId, cancelledQueue: 0, inFlightTurn: false, handedCompactLikely: true }))
    } else if (process.env.FRESHELL_TEST_CLAUDE_PROBE_HANDED_BUSY === '1') {
      // Models the SAME-TICK handoff: an absorbed compact was handed to an
      // awaiting SDK consumer immediately before the probe — NO status has
      // been emitted yet, so the verdict is the ONLY evidence. The gate must
      // abort on the verdict alone.
      console.log(JSON.stringify({ type: 'sdk.rollback.quiesced', sessionId: msg.sessionId, probeId: echoId, cancelledQueue: 0, inFlightTurn: false, handedCompactLikely: true }))
    } else {
      const cancelled = compactQueue.splice(0).length
      console.log(JSON.stringify({ type: 'sdk.rollback.quiesced', sessionId: msg.sessionId, probeId: echoId, cancelledQueue: cancelled, inFlightTurn: false, handedCompactLikely: false }))
    }
  } else if (msg.type === 'shutdown') {
    process.exit(0)
  }
})
