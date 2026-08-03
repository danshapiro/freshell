#!/usr/bin/env node
// Fake `amplifier` CLI for the TERM-15/TERM-16 activity e2e
// (`terminal-activity-rust.spec.ts`) and the lane-resilience e2e
// (`amplifier-lane-resilience-rust.spec.ts`). Extends
// `fake-amplifier-cli.mjs`'s restore-relevant behavior with the
// ACTIVITY-relevant behavior: schema-carrying `amplifier.log` lifecycle
// records the Rust events tailer/reducer consumes.
//
//   - RESUME launch (`resume <id>` -- the ONLY mode the broker uses for
//     amplifier panes under the launcher-assigned identity mechanism):
//     ADOPTS the broker's pre-created stub dir under
//     `amplifierHome()/projects/*/sessions/<id>` -- the events lane already
//     attached to THAT stub's events.jsonl at terminal create, so records
//     must be appended there, never to a fixture-invented session dir. On
//     each Enter: append `prompt:submit`, then after a delay
//     `prompt:complete` (the turn boundary -> terminal.turn.complete) and
//     stamp `turn_count` into the stub's metadata.json (the completed-turn
//     half of the "used" signature the broker's stub GC respects).
//   - FRESH launch (no args): lazily creates its own session dir with
//     `session:start` + `session:config` on first Enter. This branch no
//     longer runs for broker-created amplifier panes; kept only so the
//     fixture stays self-consistent as a CLI.
//
// All records carry live `ts` (the tracker folds ts into liveness — a stale
// fixture ts would look like >deadman silence) and the real schema gate
// (`amplifier.log` major 1); without it the Rust lane degrades by design.

import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)

function slugify(cwd) {
  const base = path.basename(cwd) || 'root'
  const cleaned = base.replace(/[^a-zA-Z0-9-]+/g, '-').toLowerCase()
  return cleaned || 'project'
}

function amplifierHome() {
  // Mirror the Rust broker's resolve_amplifier_home() (validated F1):
  // FRESHELL_AMPLIFIER_HOME override else $HOME/.amplifier. The real CLI's
  // AMPLIFIER_HOME is caches-only and must NOT be consulted here either --
  // server and fake CLI must resolve the SAME home.
  if (process.env.FRESHELL_AMPLIFIER_HOME) return process.env.FRESHELL_AMPLIFIER_HOME
  const home = process.env.HOME || process.env.USERPROFILE || '.'
  return path.join(home, '.amplifier')
}

/** Find the broker's pre-created stub dir for `sessionId` under any slug. */
function findSessionDir(id) {
  const projectsDir = path.join(amplifierHome(), 'projects')
  let slugs = []
  try { slugs = fs.readdirSync(projectsDir) } catch { return null /* no home yet */ }
  for (const slug of slugs) {
    const dir = path.join(projectsDir, slug, 'sessions', id)
    if (fs.existsSync(path.join(dir, 'metadata.json'))) return dir
  }
  return null
}

function record(event, extra = {}) {
  return `${JSON.stringify({
    ts: new Date().toISOString(),
    lvl: 'INFO',
    schema: { name: 'amplifier.log', ver: '1.0.0' },
    event,
    ...extra,
  })}\n`
}

const TURN_MS = Number(process.env.FAKE_AMPLIFIER_TURN_MS || 1200)

let eventsPath = null
let sessionId = null
let sessionDir = null

if (argv[0] === 'session' && argv[1] === 'resume' && argv.length > 2) {
  // LAUNCHER-ASSIGNED flow: adopt the broker's pre-created stub instead of
  // creating our own session dir (the events lane is already tailing the
  // stub's events.jsonl -- records written anywhere else are invisible).
  // Real launch shape: `session resume --full-history <id>` -- the session
  // id is the argument after `--full-history` (i.e. the last element).
  sessionId = argv[argv.length - 1]
  sessionDir = findSessionDir(sessionId)
  if (sessionDir) eventsPath = path.join(sessionDir, 'events.jsonl')
  process.stdout.write(`amplifier: resumed session ${sessionId}\r\n`)
}

process.stdout.write('amplifier> \r\n')

/** Completed-turn "used" stamp: bump turn_count in the stub's metadata.json. */
function stampTurnCount() {
  if (!sessionDir) return
  try {
    const metaPath = path.join(sessionDir, 'metadata.json')
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    meta.turn_count = (meta.turn_count ?? 0) + 1
    fs.writeFileSync(metaPath, JSON.stringify(meta))
  } catch {
    // stub vanished mid-run (e.g. spec tore the home down); stdout markers
    // and events.jsonl records still flow.
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', () => {
  if (!eventsPath) {
    // FRESH-launch fallback only (never reached for broker-created panes):
    // lazily create a fixture-owned session dir on first Enter.
    const cwd = process.cwd()
    const slug = slugify(cwd)
    sessionId = `fake-amp-${Date.now()}-${process.pid}`
    sessionDir = path.join(amplifierHome(), 'projects', slug, 'sessions', sessionId)
    fs.mkdirSync(sessionDir, { recursive: true })
    eventsPath = path.join(sessionDir, 'events.jsonl')
    fs.writeFileSync(
      eventsPath,
      record('session:start', { session_id: sessionId })
        + record('session:config', {
          session_id: sessionId,
          working_dir: cwd,
          data: { raw: { working_dir: cwd } },
        }),
    )
    // FIXTURE REALISM (reconcile adoption): real amplifier persists
    // `metadata.json` alongside `events.jsonl` -- and `metadata.json` is the
    // CANONICAL record the session index reads
    // (`crates/freshell-sessions/src/amplifier.rs`; R10b requires
    // `working_dir`). Without it, a claimed amplifier session is invisible
    // to the disk-truth existence probe and the post-restart reconcile
    // verdict is honestly `dead_session{session_not_on_disk}` instead of
    // respawn-with-resume. Mirror what the real CLI writes.
    fs.writeFileSync(
      path.join(sessionDir, 'metadata.json'),
      JSON.stringify({
        session_id: sessionId,
        working_dir: cwd,
        created: new Date().toISOString(),
        name: `fake amplifier activity e2e session ${sessionId}`,
      }),
    )
    process.stdout.write(`amplifier: session ${sessionId} started\r\n`)
  }
  fs.appendFileSync(eventsPath, record('prompt:submit', { session_id: sessionId }))
  process.stdout.write('amplifier: thinking...\r\n')
  setTimeout(() => {
    fs.appendFileSync(eventsPath, record('prompt:complete', { session_id: sessionId }))
    stampTurnCount()
    process.stdout.write('amplifier: turn complete\r\n')
  }, TURN_MS)
})
process.stdin.resume()
