#!/usr/bin/env node
// Fake `amplifier` CLI for the restore-across-restart e2e
// (`docs/plans/2026-07-18-amplifier-restore-spec.md` §5.2). Mirrors ONLY the
// restore-relevant behavior of the real CLI:
//
//   - FRESH launch (no args, per cli_launch_goldens.rs's G-A1): stays
//     interactive and, on the FIRST line of stdin it receives (the pane's
//     first Enter/submit), lazily creates its session dir under
//     `$AMPLIFIER_HOME/projects/<slug>/sessions/<id>/` with an
//     `events.jsonl` carrying `session:start` then
//     `session:config{working_dir}` -- the exact shape
//     `crates/freshell-sessions/src/amplifier_locator.rs`'s own unit tests
//     use (no explicit `session_id` field, so the locator falls back to the
//     directory name as the id -- the same convention those tests rely on).
//   - RESUME launch (`resume <id>`, per G-A2): never creates a new session
//     dir; prints a deterministic, greppable marker naming which id it
//     resumed, and mirrors argv to `FAKE_AMPLIFIER_ARGV_LOG` if set (parity
//     with `installFakeCodexAppServer`'s `FAKE_CODEX_APP_SERVER_ARG_LOG`
//     pattern in `restore-matrix.spec.ts`) so the scenario has two
//     independent, non-DOM ways to prove the resume argv.
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
  if (process.env.AMPLIFIER_HOME) return process.env.AMPLIFIER_HOME
  const home = process.env.HOME || process.env.USERPROFILE || '.'
  return path.join(home, '.amplifier')
}

if (argv[0] === 'resume') {
  const sessionId = argv[1] ?? ''
  process.stdout.write(`amplifier: resumed session ${sessionId}\r\n`)
  process.stdin.resume()
} else {
  process.stdout.write('amplifier> \r\n')

  let sessionCreated = false
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', () => {
    // Any input at all counts as "the first submit" for this fixture's
    // purposes -- the real locator arms only on Enter-shaped WS input, and
    // the pty's own cooked-mode line discipline already withholds bytes
    // from this process until the user presses Enter, so the first `data`
    // event this process ever sees IS that submit.
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

    process.stdout.write(`amplifier: session ${sessionId} started\r\n`)
  })
  process.stdin.resume()
}
