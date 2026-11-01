#!/usr/bin/env node
// HARNESS-03 deterministic fake `agy` (Antigravity CLI) terminal adapter.
// Renders the engine's scripted event program per terminal-cli.mjs; the only
// provider delta is launch detection: the real CLI's resume flag is the
// adjacent `--conversation <id>` pair ("Resume a previous conversation by
// ID" — real binary v1.4.10, Task-1 contract probe), and `--session-id <id>`
// keeps the harness-03 uniform explicit-id fresh-launch surface. Hermetic:
// never resolves or spawns a real provider binary. (The store-writing
// terminal fake the Rust-facing specs launch via ANTIGRAVITY_CMD is
// fixtures/fake-agy-terminal.mjs, not this adapter.)
import { runTerminalCli } from './terminal-cli.mjs'

function detectAgyLaunch(argv, sessionId) {
  const conversationIdx = argv.indexOf('--conversation')
  if (conversationIdx !== -1) return { kind: 'resume', id: argv[conversationIdx + 1] ?? '' }
  const sessionIdx = argv.indexOf('--session-id')
  if (sessionIdx !== -1) return { kind: 'fresh', id: argv[sessionIdx + 1] ?? sessionId }
  return { kind: 'fresh', id: sessionId, silent: true }
}

await runTerminalCli({ provider: 'agy', detectLaunch: detectAgyLaunch })
