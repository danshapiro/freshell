#!/usr/bin/env node
// Realistic launcher: a separate Node process in front of the native
// app-server, exactly like `node …/@openai/codex/bin/codex.js`.
// - spawns the native with inherited stdio in the SAME process group;
// - forwards only the FIRST SIGINT/SIGTERM/SIGHUP (codex.js returns early
//   once `child.killed` is true);
// - exits only after the native exits, mirroring its code (or 128+signal).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const nativeScript = process.env.FAKE_CODEX_NATIVE_SCRIPT || path.join(here, 'fake-app-server.mjs')
const child = spawn(process.execPath, [nativeScript, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, FAKE_CODEX_ROLE: 'native', CODEX_MANAGED_BY_NPM: '1' },
})
const forwarded = []
const manifestDir = process.env.FAKE_CODEX_MANIFEST_DIR
function writeManifest() {
  if (!manifestDir) return
  fs.mkdirSync(manifestDir, { recursive: true })
  const file = path.join(manifestDir, `launcher-${process.pid}.json`)
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ role: 'launcher', pid: process.pid, nativePid: child.pid, forwarded }))
  fs.renameSync(`${file}.tmp`, file)
}
writeManifest()
function forwardSignal(signal) {
  if (child.killed) return
  forwarded.push(signal)
  writeManifest()
  try { child.kill(signal) } catch { /* already gone */ }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => forwardSignal(sig))
child.on('exit', (code, signal) => {
  if (signal) process.exit(128 + (os.constants.signals[signal] ?? 1))
  process.exit(code ?? 1)
})
