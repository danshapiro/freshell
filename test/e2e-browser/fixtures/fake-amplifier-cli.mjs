#!/usr/bin/env node
// Fake `amplifier` CLI for the restore-across-restart e2e. Mirrors ONLY the
// restore-relevant behavior of the real CLI under the LAUNCHER-ASSIGNED
// identity mechanism (the broker mints a UUID at terminal create, pre-creates
// the session stub dir, and always spawns `amplifier resume <uuid>`):
//
//   - RESUME launch (`resume <id>` -- the ONLY mode the broker uses for
//     amplifier panes now): prints a deterministic, greppable marker naming
//     which id it resumed, then ADOPTS the broker's pre-created stub dir
//     under `amplifierHome()/projects/*/sessions/<id>` -- on stdin lines
//     (the pane's Enter/submits) it appends a `prompt:submit` record to the
//     stub's events.jsonl, and on the first submit also stamps `turn_count`
//     into the stub's metadata.json and appends one transcript line: the
//     exact "used" signature the broker's stub GC respects (used sessions
//     survive terminal exit; never-used stubs are GC'd and re-stubbed on
//     restore). Mirrors argv to `FAKE_AMPLIFIER_ARGV_LOG` if set (parity
//     with `installFakeCodexAppServer`'s `FAKE_CODEX_APP_SERVER_ARG_LOG`
//     pattern in `restore-matrix.spec.ts`) so the scenario has two
//     independent, non-DOM ways to prove the resume argv.
//   - FRESH launch (no args): stays interactive and lazily creates its own
//     session dir on first stdin. This branch no longer runs for
//     broker-created amplifier panes (the broker always spawns `resume`);
//     it is kept only so the fixture stays self-consistent as a CLI.
//
// Both modes stay alive (`stdin.resume()`) so the pane's terminal status
// remains 'running', matching a real interactive TUI rather than a one-shot
// process the exit-surfacing path would treat as exited.

import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)

function appendArgvLog() {
  const logPath = process.env.FAKE_AMPLIFIER_ARGV_LOG
  if (!logPath) return
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, t: Date.now(), argv })}\n`)
}
appendArgvLog()

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
function findSessionDir(sessionId) {
  const projectsDir = path.join(amplifierHome(), 'projects')
  let slugs = []
  try { slugs = fs.readdirSync(projectsDir) } catch { return null /* no home yet */ }
  for (const slug of slugs) {
    const dir = path.join(projectsDir, slug, 'sessions', sessionId)
    if (fs.existsSync(path.join(dir, 'metadata.json'))) return dir
  }
  return null
}

if (argv[0] === 'session' && argv[1] === 'resume') {
  // Real launch shape: `session resume --full-history <id>` -- the session
  // id is the argument after `--full-history` (i.e. the last element).
  const sessionId = argv[argv.length - 1] ?? ''
  process.stdout.write(`amplifier: resumed session ${sessionId}\r\n`)
  process.stdout.write('amplifier> \r\n')
  // Exit cleanly on EOF (Ctrl-D), like the real interactive CLI -- specs use
  // this to release the pane's live PTY (the broker enforces a same-id
  // double-resume guard, so a session can only be re-resumed once the
  // terminal holding it has exited). Freshell tab/pane close is "detach,
  // don't kill", so EOF is the deterministic way to end the process.
  process.stdin.on('end', () => process.exit(0))
  // Mirror the real CLI's turn save against the broker's PRE-CREATED stub
  // dir (never create our own session dir in resume mode): every submit
  // appends a prompt:submit record to the stub's events.jsonl; the first
  // submit also stamps turn_count into metadata.json and appends one
  // transcript line -- the "used" signature the broker's stub GC respects
  // (used sessions survive terminal exit).
  let turnRecorded = false
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', () => {
    const dir = findSessionDir(sessionId)
    if (!dir) return
    // Schema-carrying record like the real CLI writes -- the Rust events
    // lane gates on `amplifier.log` major 1 and would go permanently dead
    // on a schema-less record (SchemaMismatch).
    fs.appendFileSync(
      path.join(dir, 'events.jsonl'),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        lvl: 'INFO',
        schema: { name: 'amplifier.log', ver: '1.0.0' },
        event: 'prompt:submit',
        session_id: sessionId,
      })}\n`,
    )
    if (turnRecorded) return
    turnRecorded = true
    const metaPath = path.join(dir, 'metadata.json')
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    meta.turn_count = (meta.turn_count ?? 0) + 1
    fs.writeFileSync(metaPath, JSON.stringify(meta))
    fs.appendFileSync(
      path.join(dir, 'transcript.jsonl'),
      `${JSON.stringify({ role: 'user', content: 'fake turn' })}\n`,
    )
    process.stdout.write(`amplifier: turn recorded ${sessionId}\r\n`)
  })
  process.stdin.resume()
} else {
  process.stdout.write('amplifier> \r\n')

  let sessionCreated = false
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', () => {
    // Any input at all counts as "the first submit" for this fixture's
    // purposes -- the pty's own cooked-mode line discipline already
    // withholds bytes from this process until the user presses Enter, so
    // the first `data` event this process ever sees IS that submit.
    if (sessionCreated) return
    sessionCreated = true

    const cwd = process.cwd()
    const slug = slugify(cwd)
    const sessionId = `fake-amp-${Date.now()}-${process.pid}`
    const sessionDir = path.join(amplifierHome(), 'projects', slug, 'sessions', sessionId)
    fs.mkdirSync(sessionDir, { recursive: true })
    const lines = [
      JSON.stringify({ event: 'session:start' }),
      JSON.stringify({ event: 'session:config', working_dir: cwd }),
    ]
    fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), `${lines.join('\n')}\n`)
    // FIXTURE REALISM (reconcile adoption): real amplifier persists
    // `metadata.json` alongside `events.jsonl` -- and `metadata.json` is the
    // CANONICAL record the session index reads
    // (`crates/freshell-sessions/src/amplifier.rs`: "Only metadata.json is
    // read+parsed for the session-directory listing"; R10b requires
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
        name: `fake amplifier e2e session ${sessionId}`,
      }),
    )

    process.stdout.write(`amplifier: session ${sessionId} started\r\n`)
  })
  process.stdin.resume()
}
