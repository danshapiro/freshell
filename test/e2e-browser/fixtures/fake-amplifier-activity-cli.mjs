#!/usr/bin/env node
// Fake `amplifier` CLI for the TERM-15/TERM-16 activity e2e
// (`terminal-activity-rust.spec.ts`). Extends `fake-amplifier-cli.mjs`'s
// restore-relevant behavior (lazy session-dir creation the AmplifierLocator
// correlates) with the ACTIVITY-relevant behavior: schema-carrying
// `amplifier.log` lifecycle records the Rust events tailer/reducer consumes.
//
//   - FIRST Enter: lazily creates
//     `$AMPLIFIER_HOME/projects/<slug>/sessions/<id>/events.jsonl` with
//     `session:start` + `session:config` (locator compat: `working_dir` both
//     top-level and under `data.raw`) + `prompt:submit` (the record that
//     CONFIRMS the tracker's provisional busy), then after a delay appends
//     `prompt:complete` (the single turn boundary -> terminal.turn.complete).
//   - LATER Enters: append `prompt:submit`, then `prompt:complete` after the
//     delay — subsequent turns on the same session.
//
// All records carry live `ts` (the tracker folds ts into liveness — a stale
// fixture ts would look like >deadman silence) and the real schema gate
// (`amplifier.log` major 1); without it the Rust lane degrades by design.

import fs from 'node:fs'
import path from 'node:path'

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

process.stdout.write('amplifier> \r\n')

let eventsPath = null
let sessionId = null

process.stdin.setEncoding('utf8')
process.stdin.on('data', () => {
  if (!eventsPath) {
    const cwd = process.cwd()
    const slug = slugify(cwd)
    sessionId = `fake-amp-${Date.now()}-${process.pid}`
    const sessionDir = path.join(amplifierHome(), 'projects', slug, 'sessions', sessionId)
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
    process.stdout.write(`amplifier: session ${sessionId} started\r\n`)
  }
  fs.appendFileSync(eventsPath, record('prompt:submit', { session_id: sessionId }))
  process.stdout.write('amplifier: thinking...\r\n')
  setTimeout(() => {
    fs.appendFileSync(eventsPath, record('prompt:complete', { session_id: sessionId }))
    process.stdout.write('amplifier: turn complete\r\n')
  }, TURN_MS)
})
process.stdin.resume()
