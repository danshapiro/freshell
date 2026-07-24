#!/usr/bin/env node
// Fake `opencode` CLI for the opencode TERMINAL-pane restore-across-restart
// e2e (`docs/plans/2026-07-18-opencode-terminal-restore-spec.md` §7, test 21).
// Mirrors ONLY the restore-relevant behavior of the real CLI:
//
//   - FRESH launch (no `--session`, only the always-present `--hostname`/
//     `--port` terminal-mode flags): stays interactive and, on the FIRST
//     line of stdin it receives (the pane's first Enter/submit), writes a
//     real root `session` row into `<data_home>/opencode.db` -- the SAME
//     schema `crates/freshell-sessions/src/opencode_locator.rs`'s own unit
//     tests seed (id/project_id/parent_id/directory/title/version/
//     time_created/time_updated/time_archived). This exercises the
//     Enter-anchored correlation window (spec §4.4); the spawn-anchored
//     window (row written before any Enter) is separately and
//     deterministically proven by the Rust locator's own unit tests
//     (`row_created_at_spawn_before_any_enter_resolves_via_spawn_window`),
//     which control row-vs-arm timing precisely -- something an e2e driving
//     a real browser + WS round trip cannot pin to the millisecond.
//   - RESUME launch (`--session <id>`): never creates a new session row;
//     prints a deterministic, greppable marker naming which id it resumed,
//     and mirrors argv to `FAKE_OPENCODE_TERMINAL_ARGV_LOG` if set (same
//     pattern as `FAKE_AMPLIFIER_ARGV_LOG` in `fake-amplifier-cli.mjs`) so
//     the scenario has two independent, non-DOM ways to prove the resume
//     argv.
//
// Both modes stay alive (`stdin.resume()`) so the pane's terminal status
// remains 'running', matching a real interactive TUI rather than a one-shot
// process the exit-surfacing path would treat as exited.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const argv = process.argv.slice(2)

function appendArgvLog() {
  const logPath = process.env.FAKE_OPENCODE_TERMINAL_ARGV_LOG
  if (!logPath) return
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, t: Date.now(), argv })}\n`)
}
appendArgvLog()

function argValue(name) {
  const index = argv.indexOf(name)
  if (index < 0) return undefined
  return argv[index + 1]
}

function opencodeDataHome() {
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, 'opencode')
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir() || '.'
  return path.join(home, '.local', 'share', 'opencode')
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, worktree TEXT);
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER
    );
  `)
}

function writeSessionRow(sessionId, cwd) {
  const dataHome = opencodeDataHome()
  fs.mkdirSync(dataHome, { recursive: true })
  const db = new DatabaseSync(path.join(dataHome, 'opencode.db'))
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    ensureSchema(db)
    const now = Date.now()
    db.prepare('INSERT OR REPLACE INTO project (id, worktree) VALUES (?, ?)').run(
      `proj-${sessionId}`,
      cwd,
    )
    db.prepare(
      `INSERT OR REPLACE INTO session
        (id, project_id, parent_id, slug, directory, title, version,
         time_created, time_updated, time_archived)
       VALUES (?, ?, NULL, ?, ?, ?, 'fake-opencode-terminal-e2e', ?, ?, NULL)`,
    ).run(sessionId, `proj-${sessionId}`, sessionId, cwd, sessionId, now, now)
  } finally {
    db.close()
  }
}

const resumeSessionId = argValue('--session')

if (resumeSessionId) {
  process.stdout.write(`opencode: resumed session ${resumeSessionId}\r\n`)
  process.stdin.resume()
} else {
  process.stdout.write('opencode> \r\n')

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
    const sessionId = `ses_e2e_${Date.now()}_${process.pid}`
    writeSessionRow(sessionId, cwd)

    process.stdout.write(`opencode: session ${sessionId} started\r\n`)
  })
  process.stdin.resume()
}
