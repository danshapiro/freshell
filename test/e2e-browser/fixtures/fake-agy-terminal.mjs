#!/usr/bin/env node
// Fake `agy` (Antigravity CLI) TERMINAL fake for the google-cli e2e specs
// (antigravity plan Task 10). Line-for-line sibling of fake-codex-terminal.mjs
// on the ANTIgravity store layout: the identity artifact is the conversation
// transcript at
//   <antigravity_home>/brain/<conversationId>/.system_generated/logs/transcript.jsonl
// plus the cache/last_conversations.json sidecar — the weaker
// workspace-cache mechanism Freshell must NEVER use for identity or resume
// (plan Global Constraint 2); this fake keeps it written so later specs can
// prove exactly that.
//
// REAL-BINARY record contract (corrected 2026-11-02 against real agy 1.2.11
// + 1.4.12 transcripts; evidence:
// .worktrees/.the-usual-logs/antigravity-transcript-validation/reports/
// real-binary-transcript-evidence.md): the transcript's records are
// step-indexed — USER_INPUT / PLANNER_RESPONSE / GENERIC / SYSTEM_MESSAGE /
// CHECKPOINT — every record carrying source/status/step_index and a
// second-granularity RFC3339 created_at (this fake writes ms-precision
// stamps — the shared coercion accepts both), with the user text in the
// top-level `content` field. Real records carry NO conversation id and NO
// workspace evidence, so this fake additionally appends ONE labeled
// fake-contract extension the real binary never writes: the
// `session_start` ownership record (conversationId + workspacePaths — the
// disk locator's cwd/id evidence), plus the `turn_settled` settle record
// the attention machinery consumes (real transcripts carry no settle
// record). Both extensions keep the real-shaped field discipline so the
// tracker's (created_at, step_index) identity-pair dedupe is exercised
// end to end.
//
// <antigravity_home> resolves exactly like the server's seam
// (crates/freshell-sessions provider_layout.rs's antigravity_home):
// $FRESHELL_ANTIGRAVITY_HOME when set, else $HOME/.gemini/antigravity-cli.
// All writes stay under that root (plus the argv log path): hermetic by
// construction — the fake records argv ONLY, never env, so credentials can
// never leak through it.
//
// Wire surface:
// - fresh: prints `agy> `; the FIRST submitted line mints
//   conversationId = crypto.randomUUID(), writes the transcript (ownership
//   record first) + cache, and prints `agy: conversation <uuid> started`.
//   Enter-gating mirrors the codex fake (the transcript materializes only at
//   the first user prompt, keeping the fixture on the safe side of the
//   server's first-submit locator window); a bare Enter mints NOTHING (the
//   zero-turn restore scenario stays robust).
//   Submit delimiters mirror the ws association's byte discipline
//   (crates/freshell-ws/src/antigravity_association.rs, whole-delta review
//   round 3, Major 3): CR (Enter, 0x0D) is the ONLY submit delimiter; LF
//   (Ctrl+J, 0x0A) inserts a newline INTO the accumulating prompt — the
//   CLI's documented multiline form — so `line one`, Ctrl+J, `line two`,
//   Enter submits ONE turn whose USER_INPUT content carries BOTH lines
//   ("line one\nline two"), matching the ws capture's single full
//   multi-line flush. (Pre-fix this fake treated LF as a delimiter too and
//   ran two turns against one captured submit, so multi-line prompts never
//   bound — the round-3 review finding.)
// - resume (`--conversation <id>` anywhere in argv — the server's adjacent
//   resumeArgs pair): an existing brain/<id>/ continues (`agy: resumed
//   conversation <id>` + a session_start {source:"resume"} record appended
//   — the resumed.sanitized.jsonl shape); a MISSING brain/<id>/ follows
//   the PROBED missing-id contract (round 7, Major 1; real binaries
//   v1.4.10 AND v1.4.12, the round-6 PTY receipts in the plan's Provider
//   Contract Record): print `warning: conversation "<id>" not found` to
//   stderr and CONTINUE INTO A FRESH INTERACTIVE SESSION — the same
//   `agy> ` prompt and the same first-prompt mint under a NEW
//   crypto.randomUUID() (the fake's normal mint path), NEVER a failure
//   exit and NEVER a transcript under the requested dead id (the
//   pre-round-7 fake exited 1 — a contract no real binary has).
// - argv mirrored to FAKE_AGY_TERMINAL_ARGV_LOG as JSONL (so specs can
//   prove the launch shape: NO prompt-taking `-i` (panes launch BARE),
//   no headless `-p`, `--conversation <id>` adjacent, `--continue` NEVER).
// - argv VALIDATION mirrors the REAL binary's parser (whole-delta review
//   round 6, Major; argv probes 2026-11-01 against real pinned binaries
//   v1.4.10 AND v1.4.12, receipts in the plan's Provider Contract Record):
//   the real `agy` requires a VALUE for `-i`/`--prompt-interactive` — a
//   bare `-i` exits 2 with `flag needs an argument: -i`, and
//   `-i --conversation <id>` exits 2 with the LOUD misparse error
//   `Error: -i took "--conversation" as its prompt, ...` (the CLI never
//   silently substitutes). This fake reproduces those exact rejections, so
//   a manifest regression (a static bare `-i` again) kills every launch
//   HERE the same way the real binary would — the pane dies with the
//   greppable error and the spec fails, instead of a silent fresh
//   conversation. `--conversation` without an adjacent id is rejected the
//   same way. The headless/continue spellings (`-p`/`--print`/`--prompt`/
//   `-c`/`--continue`) are legal BINARY shapes but never legal PANE-launch
//   shapes; this terminal fake refuses them with its own labeled error
//   (it models no headless mode). `-i <prompt>` (the parser-legal seeded
//   shape) is ACCEPTED but the auto-run initial turn is not modeled — no
//   spec drives it; Freshell never sends it.
//
// Per submitted line (a "turn") the default program runs, in order:
//   busy marker → USER_INPUT record → PLANNER_RESPONSE record → bare BEL
//   + `turn done.` (the leading-BEL chunk the turn-complete tracker
//   consumes) → turn_settled{fullyIdle:true} record. A verb line REPLACES
//   parts of that program:
//   /^resume:<id>$/  switches the active transcript to the EXISTING
//                    brain/<id>/ (non-zero exit + greppable error when
//                    missing); the command itself appends no user record —
//                    subsequent prompts append there as the LATEST user
//                    records (the documented in-CLI switch to a previous
//                    conversation).
//   /^switch:/      mints a NEW conversation dir; subsequent prompts append
//                    there (the new-conversation rebind path).
//   /^explode:/     exits mid-turn: the turn starts (busy marker + user
//                    record) then the process dies with NO settle and NO
//                    completion (the crash-parity lane's shape).
//   /^approval:/    renders a greppable approval prompt and leaves the turn
//                    pending (no settle, no completion) until a later turn
//                    settles.
//   /^remember:/    registers the nonce after the colon (the line itself is
//                    a normal turn); the nonce is echoed on later turns and
//                    recovered from the transcript on resume, so a spec can
//                    prove CONTENT continuation across a restart — not just
//                    an id match.
//   /^async:/       settles turn_settled{fullyIdle:false} with NO completion
//                    (outstanding async work — the pane stays busy until a
//                    later turn settles fullyIdle:true).
//   /^dup:/         appends a byte-faithful COPY of the ACTIVE transcript's
//                    last turn_settled record (same created_at AND
//                    step_index — BOTH identity components of the tracker's
//                    dedupe key) — the scripted duplicate-settle replay the
//                    dedupe must swallow: no double completion, one bell
//                    (plan Task 13's scenario). No user record; with no
//                    active conversation or no settle yet there is nothing
//                    to duplicate and the honest marker says so.
//
// FAKE_AGY_STORE_GATE_PATH (the fake-codex rollout-gate copy): when set, the
// process's FIRST conversation mint blocks on a 50 ms poll until the gate
// file exists, so a spec can hold the store write back and prove the server
// never blocks on it. Later mints (the switch: verb) are ungated.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import process from 'node:process'

const argv = process.argv.slice(2)

function appendArgvLog() {
  const logPath = process.env.FAKE_AGY_TERMINAL_ARGV_LOG
  if (!logPath) return
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, t: Date.now(), argv })}\n`)
}
appendArgvLog()

// ── argv validation (mirrors the probed real binary's parser; see the ──────
// header comment for the probe receipts). Runs BEFORE any store wiring, the
// same way the real CLI's flag parse precedes its home/store init.
function looksLikeFlag(token) {
  return typeof token === 'string' && token.startsWith('-') && token.length > 1
}

function rejectLaunch(binaryShapedMessage, fakeDetail) {
  process.stderr.write(`${binaryShapedMessage}\r\n`)
  process.stderr.write(`fake-agy-terminal: ${fakeDetail}\r\n`)
  exitWith(2)
}

const VALUE_TAKING = new Set(['-i', '--prompt-interactive'])
for (let i = 0; i < argv.length; i += 1) {
  const token = argv[i]
  if (VALUE_TAKING.has(token)) {
    const next = argv[i + 1]
    if (next === undefined) {
      rejectLaunch('flag needs an argument: -i', 'a bare prompt-taking interactive flag never starts a pane (the real binary exits 2 the same way)')
    }
    if (looksLikeFlag(next)) {
      rejectLaunch(
        `Error: -i took "${next}" as its prompt, so the intended prompt was left as an argument and ignored.`,
        'the misparse shape the real binary rejects with exit 2 (a resume must never degrade into a seeded fresh prompt)',
      )
    }
    // Parser-legal `-i <prompt>`: accepted; the auto-run initial turn is
    // not modeled (documented in the header).
    i += 1
  } else if (token === '--conversation') {
    const next = argv[i + 1]
    if (next === undefined || looksLikeFlag(next)) {
      rejectLaunch('flag needs an argument: -conversation', 'the resume pair must carry the conversation id adjacently')
    }
    i += 1
  } else if (token === '--model' || token === '--effort') {
    const next = argv[i + 1]
    if (next === undefined || looksLikeFlag(next)) {
      rejectLaunch(`flag needs an argument: ${token.slice(2)}`, 'the settings pair must carry its value adjacently')
    }
    i += 1
  } else if (token === '-p' || token === '--print' || token === '--prompt' || token === '-c' || token === '--continue') {
    rejectLaunch(
      `fake-agy-terminal: refusing the ${token} pane-launch shape`,
      'headless/continue spellings are legal binary shapes but never legal pane launches',
    )
  } else if (looksLikeFlag(token)) {
    // Other pass-through flags: the binary accepts a wider bool-flag set
    // than this fake models (--agent, --settings, ...) — pass through like
    // the binary's parser.
  } else {
    rejectLaunch(
      `fake-agy-terminal: unexpected positional "${token}"`,
      'positional residue is the misparse shape (a swallowed flag strands its value)',
    )
  }
}

// Deterministic exits: schedule through the event loop (the fixture engine's
// crash discipline) so pending stdout/stderr writes flush before the exit.
function exitWith(code) {
  setTimeout(() => process.exit(code), 0)
}

// ── the antigravity store layout (AntigravityLayout) ────────────────────────

function antigravityHome() {
  const override = process.env.FRESHELL_ANTIGRAVITY_HOME
  if (override && override.length > 0) return override
  return path.join(process.env.HOME ?? '', '.gemini', 'antigravity-cli')
}

function brainDir(conversationId) {
  return path.join(antigravityHome(), 'brain', conversationId)
}

function transcriptPath(conversationId) {
  return path.join(brainDir(conversationId), '.system_generated', 'logs', 'transcript.jsonl')
}

function modelFromArgv() {
  const idx = argv.indexOf('--model')
  return (idx !== -1 && argv[idx + 1]) || 'gemini-3-pro'
}

function sessionStartRecord(conversationId, source) {
  const record = {
    type: 'session_start',
    conversationId,
    workspacePaths: [process.cwd()],
    model: modelFromArgv(),
    startedAt: new Date().toISOString(),
  }
  if (source) record.source = source
  return record
}

function appendRecord(conversationId, record) {
  const file = transcriptPath(conversationId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`)
}

// cache/last_conversations.json — maintained plausibly (the active
// conversation upserted as the most recent row) purely so specs can prove
// the server ignores it for identity and resume.
function updateLastConversationsCache(conversationId) {
  const cacheDir = path.join(antigravityHome(), 'cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  const cachePath = path.join(cacheDir, 'last_conversations.json')
  let rows = []
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    if (Array.isArray(parsed?.conversations)) rows = parsed.conversations
  } catch {
    // absent or unreadable — a fresh cache
  }
  rows = rows.filter((row) => row?.id !== conversationId)
  rows.unshift({ id: conversationId, lastModified: new Date().toISOString() })
  fs.writeFileSync(cachePath, `${JSON.stringify({ conversations: rows }, null, 2)}\n`)
}

// ── nonce recall (resume-content proof) ─────────────────────────────────────
// `remember: <nonce>` lines persist in the transcript as USER_INPUT content;
// every activation re-reads them, so an echo after a `--conversation <id>`
// restart proves the conversation CONTENT continued — not just the id.

const REMEMBER_RE = /^remember:\s*(.+?)\s*$/

function loadRememberedNonces(conversationId) {
  const nonces = []
  let raw
  try {
    raw = fs.readFileSync(transcriptPath(conversationId), 'utf8')
  } catch {
    return nonces
  }
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue // malformed tail — skip
    }
    if (obj?.type !== 'USER_INPUT') continue
    const match = REMEMBER_RE.exec(String(obj.content ?? ''))
    if (match) nonces.push(match[1])
  }
  return nonces
}

// ── step-counter seeding (the cross-process continuation) ────────────────────
// The real binary CONTINUES a conversation's step_index across processes
// (binary evidence: USER_INPUT steps 0→2→5 across three separate resumed
// processes — no per-process reset), so a resumed conversation's new
// records must continue past every record already on disk.

function maxStepIndex(conversationId) {
  let raw
  try {
    raw = fs.readFileSync(transcriptPath(conversationId), 'utf8')
  } catch {
    return -1
  }
  let max = -1
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue // malformed tail — skip
    }
    if (typeof obj?.step_index === 'number' && obj.step_index > max) max = obj.step_index
  }
  return max
}

// ── interactive conversation state ───────────────────────────────────────────

const state = {
  conversationId: null,
  remembered: [],
  // Per-conversation record counter modeling the real binary's step_index
  // identity: unique per record, strictly increasing across turns AND
  // across processes (binary evidence: USER_INPUT steps 0→2→5 across
  // three separate resumed processes — no per-process reset). Every
  // activation seeds it from the transcript's max existing step_index,
  // so a RESUME continues the steps and a MINT (whose fresh transcript
  // carries no step records yet) starts fresh. The tracker's settle
  // dedupe keys on (created_at, step_index).
  step: -1,
}

function nextStepIndex() {
  state.step += 1
  return state.step
}

function activateConversation(conversationId) {
  state.conversationId = conversationId
  state.remembered = loadRememberedNonces(conversationId)
  // Seed the step counter from the transcript — the evidenced
  // cross-process continuation. A mint's just-written transcript
  // carries no step records yet, so a mint still starts at step 0.
  state.step = maxStepIndex(conversationId)
  updateLastConversationsCache(conversationId)
}

// The mint (b): fresh transcript (ownership record as the FIRST line) + the
// cache sidecar. Silent — the caller owns the stdout marker. The step
// counter re-seeds inside activateConversation from the fresh, step-less
// transcript — a mint starts at step 0.
function mintConversation() {
  const conversationId = crypto.randomUUID()
  const file = transcriptPath(conversationId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(sessionStartRecord(conversationId))}\n`)
  activateConversation(conversationId)
  return conversationId
}

let mintedOnce = false

// The store-gate race pattern (fake-codex-terminal.mjs:195-208): the
// process's FIRST mint waits for the gate file to exist before writing.
function waitForStoreGate() {
  const gate = process.env.FAKE_AGY_STORE_GATE_PATH
  if (!gate) return Promise.resolve()
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      if (fs.existsSync(gate)) {
        clearInterval(poll)
        resolve()
      }
    }, 50)
  })
}

async function mintConversationGated() {
  if (!mintedOnce) {
    await waitForStoreGate()
    mintedOnce = true
  }
  return mintConversation()
}

// The PROBED missing-id contract (round 7, Major 1; real binaries v1.4.10
// AND v1.4.12, the round-6 PTY receipts): the CLI prints
// `warning: conversation "<id>" not found` (byte-faithful, quotes
// included) and CONTINUES — no failure exit. The CALLER owns what
// "continues" means: the launch arm prints the fresh prompt (the first
// submit then mints a NEW conversation), and the in-CLI `resume:` verb
// warns and keeps the current conversation (the argv form is the probed
// shape; the in-CLI form is this fake's documented choice, following
// the only real-binary evidence: the CLI never dies on a missing id).
function missingConversation(conversationId) {
  process.stderr.write(`warning: conversation "${conversationId}" not found\r\n`)
}

// ── the per-line turn program ────────────────────────────────────────────────

function now() {
  return new Date().toISOString()
}

// The turn-program record writers. USER_INPUT and PLANNER_RESPONSE are the
// REAL binary vocabulary (v1.4.12: source/status/step_index/created_at, user
// text in `content`, flat token fields on the reply); `turn_settled` is the
// labeled fake-contract settle record (real transcripts carry no settle
// record — binary evidence) with the real-shaped field discipline so the
// tracker's (created_at, step_index) identity-pair dedupe is exercised end
// to end.
function appendUserMessage(line) {
  appendRecord(state.conversationId, {
    type: 'USER_INPUT',
    source: 'USER_EXPLICIT',
    status: 'DONE',
    step_index: nextStepIndex(),
    created_at: now(),
    content: line,
  })
}

function appendAssistantMessage(text) {
  appendRecord(state.conversationId, {
    type: 'PLANNER_RESPONSE',
    source: 'MODEL',
    status: 'DONE',
    step_index: nextStepIndex(),
    created_at: now(),
    content: text,
    input_tokens: 1,
    output_tokens: 1,
    cache_read_tokens: 0,
  })
}

function appendTurnSettled(fullyIdle) {
  // The fake-contract settle record: the real binary writes NO settle
  // record (binary evidence, real-binary-transcript-evidence.md); the
  // fake appends this extension so the attention machinery has a
  // settle signal — real-shaped field discipline (created_at +
  // step_index) so the tracker's identity-pair dedupe is exercised.
  appendRecord(state.conversationId, {
    type: 'turn_settled',
    step_index: nextStepIndex(),
    created_at: now(),
    outcome: fullyIdle ? 'completed' : 'async-outstanding',
    fullyIdle,
  })
}

// Copy source for the /^dup:/ verb: the ACTIVE transcript's last
// turn_settled RAW line — byte-faithful, same created_at AND step_index
// (both identity components), a true duplicate — or '' when there is no
// settle to duplicate.
function lastSettledLine(conversationId) {
  let raw
  try {
    raw = fs.readFileSync(transcriptPath(conversationId), 'utf8')
  } catch {
    return ''
  }
  for (const line of raw.split('\n').reverse()) {
    if (line.trim().length === 0) continue
    try {
      if (JSON.parse(line).type === 'turn_settled') return line
    } catch {
      continue // malformed tail — skip
    }
  }
  return ''
}

function assistantReply() {
  return state.remembered.length > 0
    ? `done; remembered: ${state.remembered.join(', ')}`
    : 'done'
}

// The default turn, in the contract order: busy marker → user+assistant
// records → bare BEL + `turn done.` (two chunks, the leading-BEL pair) →
// turn_settled{fullyIdle:true}. The nonce echo rides AFTER the pair so it
// can never corrupt the completion signal.
function defaultTurn(line) {
  process.stdout.write('agy: working on it...\r\n')
  appendUserMessage(line)
  appendAssistantMessage(assistantReply())
  process.stdout.write('\x07')
  process.stdout.write('turn done.\r\n')
  if (state.remembered.length > 0) {
    process.stdout.write(`agy: remembered: ${state.remembered.join(', ')}\r\n`)
  }
  appendTurnSettled(true)
}

async function handleLine(line) {
  // In-CLI switch to an EXISTING conversation (the documented conversation
  // switch): the command itself appends no user record — subsequent prompts
  // append there as the LATEST user records.
  const resumeMatch = /^resume:\s*(.+?)\s*$/.exec(line)
  if (resumeMatch) {
    const id = resumeMatch[1]
    if (!fs.existsSync(brainDir(id))) {
      // The probed missing-id contract: warn and CONTINUE (the CLI never
      // dies on a missing id) — the pane keeps its CURRENT conversation.
      missingConversation(id)
      return
    }
    activateConversation(id)
    process.stdout.write(`agy: resumed conversation ${id}\r\n`)
    return
  }
  // New-conversation rebind: mint a NEW dir; subsequent prompts append there.
  if (/^switch:/.test(line)) {
    const id = await mintConversationGated()
    process.stdout.write(`agy: switched to conversation ${id}\r\n`)
    return
  }
  // Duplicate-settle replay: append a byte-faithful copy of the ACTIVE
  // transcript's last turn_settled record (same created_at AND
  // step_index — both identity components of the tracker's dedupe key) —
  // the scripted duplicate the dedupe must swallow (no double completion,
  // one bell; plan Task 13's scenario). Not a turn line: no user record,
  // no mint — nothing to duplicate ⇒ the honest marker.
  if (/^dup:/.test(line)) {
    const last = state.conversationId ? lastSettledLine(state.conversationId) : ''
    if (last) fs.appendFileSync(transcriptPath(state.conversationId), `${last}\n`)
    process.stdout.write(last ? 'agy: duplicated settle\r\n' : 'agy: no settle to duplicate\r\n')
    return
  }
  // A TURN line needs an active conversation — the first submit mints one.
  if (!state.conversationId) {
    const id = await mintConversationGated()
    process.stdout.write(`agy: conversation ${id} started\r\n`)
  }
  if (/^explode:/.test(line)) {
    // Mid-turn crash: the turn starts (busy), then the process dies with no
    // settle and no completion.
    process.stdout.write('agy: working on it...\r\n')
    appendUserMessage(line)
    process.stdout.write('agy: simulated crash\r\n')
    exitWith(3)
    return
  }
  if (/^approval:/.test(line)) {
    // A pending approval: the turn is in flight, the prompt renders, and
    // nothing settles until a later turn does.
    process.stdout.write('agy: working on it...\r\n')
    appendUserMessage(line)
    process.stdout.write(`approval requested: ${line.slice('approval:'.length).trim()} (y/n)\r\n`)
    return
  }
  const rememberMatch = REMEMBER_RE.exec(line)
  if (rememberMatch) {
    state.remembered.push(rememberMatch[1])
    defaultTurn(line)
    return
  }
  if (/^async:/.test(line)) {
    // Settles WITHOUT full idle: no BEL, no `turn done.` — the pane stays
    // busy until a later turn settles fullyIdle:true.
    process.stdout.write('agy: working on it...\r\n')
    appendUserMessage(line)
    appendAssistantMessage(assistantReply())
    appendTurnSettled(false)
    return
  }
  defaultTurn(line)
}

// ── launch arms ─────────────────────────────────────────────────────────────

const conversationIdx = argv.indexOf('--conversation')
if (conversationIdx !== -1) {
  const resumeId = argv[conversationIdx + 1] ?? ''
  if (!fs.existsSync(brainDir(resumeId))) {
    // The PROBED missing-id contract (round 7, Major 1): warn, then
    // CONTINUE into the FRESH interactive session — the pane stays
    // alive under the requested (dead) id, and the first prompt mints
    // a NEW conversation (the normal mint path below). Never an exit,
    // never a transcript under the requested dead id.
    missingConversation(resumeId)
    process.stdout.write('agy> \r\n')
  } else {
    appendRecord(resumeId, sessionStartRecord(resumeId, 'resume'))
    activateConversation(resumeId)
    process.stdout.write(`agy: resumed conversation ${resumeId}\r\n`)
  }
} else {
  process.stdout.write('agy> \r\n')
}

// Line-buffered stdin, serialized per line (multi-line chunks and split
// writes both stay in order); empty lines are no-ops. CR (0x0D) is the
// ONLY submit delimiter — an LF stays embedded in the accumulating prompt
// as a newline (Ctrl+J, the CLI's documented multiline form), so ONE
// Enter on a multi-line prompt submits ONE line carrying the embedded
// newline and `handleLine` writes ONE user record with the full text.
//
// RAW MODE (the load-bearing part): a real interactive CLI puts its tty in
// raw mode, and the byte discipline above is only observable there —
// under the PTY's default COOKED mode the line discipline's ICRNL
// translates the Enter key's CR into LF before this process ever reads
// it (and a bare Ctrl+J is already LF), so the two bytes would be
// indistinguishable and the CR-only delimiter could never fire. (The
// pre-round-3 fake's `/[\r\n]/` delimiter worked only BY ACCIDENT of
// that translation: it submitted at the ICRNL-translated Enter.) The
// fake therefore sets its stdin to raw mode when it owns a tty — the
// e2e PTY always provides one — and falls back to passthrough when
// driven through a pipe (no line discipline, bytes arrive verbatim).
let carry = ''
let queue = Promise.resolve()
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  carry += String(chunk)
  let idx
  while ((idx = carry.indexOf('\r')) !== -1) {
    const line = carry.slice(0, idx)
    carry = carry.slice(idx + 1)
    if (line.length > 0) queue = queue.then(() => handleLine(line))
  }
})
process.stdin.resume()
