#!/usr/bin/env node
// Fake `codex` CLI (terminal mode, NOT the FreshCodex JSON-RPC app-server
// fixture) for `sidebar-click-resume.spec.ts` (SESSION-01 narrowed-MISSING
// closure: "resuming a session through the UI" via a real sidebar-history
// CLICK, not the restart-driven path `amplifier-restore-rust.spec.ts`
// already proves). Mirrors that spec's `fake-amplifier-cli.mjs` pattern:
//
//   - RESUME launch (`resume <id>`, per `extensions/codex-cli/freshell.json`'s
//     `resumeArgs: ["resume", "{{sessionId}}"]` / `cli_launch_goldens.rs`'s
//     G-X2): prints a deterministic, greppable marker naming which id it
//     resumed, and mirrors argv to `FAKE_CODEX_ARGV_LOG` if set -- two
//     independent, non-DOM ways to prove the resume argv actually reached
//     the spawned process.
//   - FRESH launch (no resume arg): just prints a prompt marker. This
//     scenario only exercises the resume path, but a fresh marker is kept
//     for parity/diagnosability if a future scenario needs it.
//
// Stays alive (`stdin.resume()`) so the pane's terminal status remains
// 'running', matching a real interactive TUI.

import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)

function appendArgvLog() {
  const logPath = process.env.FAKE_CODEX_ARGV_LOG
  if (!logPath) return
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, t: Date.now(), argv })}\n`)
}
appendArgvLog()

// The real launch-arg builder appends `resumeArgs` LAST, after any
// settings args (model/sandbox/permission-mode) that happen to be
// configured (`cli_launch.rs`'s `resume_args`/`settings_args` ordering,
// `server/terminal-registry.ts`'s identical `[...remoteArgs, ...providerArgs,
// ...baseArgs, ...settingsArgs, ...resumeArgs]` shape) -- so `resume` is not
// guaranteed to be `argv[0]` the way `fake-amplifier-cli.mjs`'s simpler
// no-settings-args CLI can assume. Search for `resume` anywhere in argv.
const resumeIndex = argv.indexOf('resume')

if (resumeIndex !== -1) {
  const sessionId = argv[resumeIndex + 1] ?? ''
  process.stdout.write(`codex: resumed session ${sessionId}\r\n`)
} else {
  process.stdout.write('codex> \r\n')
}
process.stdin.resume()
