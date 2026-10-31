#!/usr/bin/env node
// Fake `agy` (Antigravity CLI) TERMINAL fake for the google-cli e2e specs
// (antigravity plan Task 10). Line-for-line sibling of fake-codex-terminal.mjs
// on the ANTIgravity store layout: the identity artifact is the conversation
// transcript at
//   <antigravity_home>/brain/<conversationId>/.system_generated/logs/transcript.jsonl
// whose FIRST line is the session_start ownership record (conversationId +
// workspacePaths are the disk locator's evidence), plus the
// cache/last_conversations.json sidecar — the weaker workspace-cache mechanism
// Freshell must NEVER use for identity or resume (plan Global Constraint 2);
// this fake keeps it written so later specs can prove exactly that.
//
// // Stage-1 candidate contract: the store layout and the record schema
// (session_start / user_message / assistant_message / turn_settled) are the
// fixture-validated candidate contract pinned by
// test/fixtures/coding-cli/antigravity/*.sanitized.jsonl and parsed by
// crates/freshell-sessions/src/parse/antigravity.rs (the A2 named blocker
// stands; this fake claims nothing beyond it).
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
// - resume (`--conversation <id>` anywhere in argv — the server's adjacent
//   resumeArgs pair): missing brain/<id>/ ⇒ non-zero exit with a greppable
//   error; else `agy: resumed conversation <id>` and the existing transcript
//   continues (a session_start {source:"resume"} record is appended — the
//   resumed.sanitized.jsonl shape).
// - argv mirrored to FAKE_AGY_TERMINAL_ARGV_LOG as JSONL (so specs can prove
//   `-i` present, `-p` absent, `--conversation <id>` adjacent, `--continue`
//   NEVER).
//
// Per submitted line (a "turn") the default program runs, in order:
//   busy marker → user_message record → assistant_message record → bare BEL
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
//                    last turn_settled record (same `at`) — the scripted
//                    duplicate-settle replay the tracker's dedupe must
//                    swallow: no double completion, one bell (plan Task
//                    13's scenario). No user record; with no active
//                    conversation or no settle yet there is nothing to
//                    duplicate and the honest marker says so.
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
// `remember: <nonce>` lines persist in the transcript as user_message text;
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
    if (obj?.type !== 'user_message') continue
    const match = REMEMBER_RE.exec(String(obj.text ?? ''))
    if (match) nonces.push(match[1])
  }
  return nonces
}

// ── interactive conversation state ───────────────────────────────────────────

const state = {
  conversationId: null,
  remembered: [],
}

function activateConversation(conversationId) {
  state.conversationId = conversationId
  state.remembered = loadRememberedNonces(conversationId)
  updateLastConversationsCache(conversationId)
}

// The mint (b): fresh transcript (ownership record as the FIRST line) + the
// cache sidecar. Silent — the caller owns the stdout marker.
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

function missingConversation(conversationId) {
  process.stderr.write(`agy: conversation ${conversationId} not found\r\n`)
  exitWith(1)
}

// ── the per-line turn program ────────────────────────────────────────────────

function now() {
  return new Date().toISOString()
}

function appendUserMessage(line) {
  appendRecord(state.conversationId, {
    type: 'user_message',
    conversationId: state.conversationId,
    text: line,
    at: now(),
  })
}

function appendAssistantMessage(text) {
  appendRecord(state.conversationId, {
    type: 'assistant_message',
    conversationId: state.conversationId,
    text,
    at: now(),
    usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, totalTokens: 2 },
  })
}

function appendTurnSettled(fullyIdle) {
  appendRecord(state.conversationId, {
    type: 'turn_settled',
    conversationId: state.conversationId,
    at: now(),
    outcome: 'completed',
    fullyIdle,
  })
}

// Copy source for the /^dup:/ verb: the ACTIVE transcript's last
// turn_settled RAW line — byte-faithful, same `at`, a true duplicate — or
// '' when there is no settle to duplicate.
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
  // transcript's last turn_settled record (same `at`) — the scripted
  // duplicate the tracker's dedupe must swallow (no double completion, one
  // bell; plan Task 13's scenario). Not a turn line: no user record, no
  // mint — nothing to duplicate ⇒ the honest marker.
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
    missingConversation(resumeId)
  } else {
    appendRecord(resumeId, sessionStartRecord(resumeId, 'resume'))
    activateConversation(resumeId)
    process.stdout.write(`agy: resumed conversation ${resumeId}\r\n`)
  }
} else {
  process.stdout.write('agy> \r\n')
}

// Line-buffered stdin, serialized per line (multi-line chunks and split
// writes both stay in order); empty lines are no-ops.
let carry = ''
let queue = Promise.resolve()
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  carry += String(chunk)
  let idx
  while ((idx = carry.search(/[\r\n]/)) !== -1) {
    const line = carry.slice(0, idx)
    carry = carry.slice(idx + 1)
    if (line.length > 0) queue = queue.then(() => handleLine(line))
  }
})
process.stdin.resume()
