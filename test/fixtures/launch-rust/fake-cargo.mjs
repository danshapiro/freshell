#!/usr/bin/env node
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import path from 'node:path'

const log = process.env.FRESHELL_FIXTURE_LOG
const target = process.env.CARGO_TARGET_DIR
const controller = process.env.FRESHELL_FIXTURE_CONTROLLER
if (!log || !target || !controller) throw new Error('fixture cargo environment is incomplete')

appendFileSync(log, `${JSON.stringify({
  command: 'cargo',
  args: process.argv.slice(2),
  cwd: process.cwd(),
  target,
})}\n`)

const release = path.join(target, 'release')
mkdirSync(release, { recursive: true })
if (process.argv.includes('freshell-deploy')) {
  copyFileSync(controller, path.join(release, 'freshell-deploy'))
  chmodSync(path.join(release, 'freshell-deploy'), 0o755)
}
if (process.argv.includes('freshell-server')) {
  writeFileSync(path.join(release, 'freshell-server'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  chmodSync(path.join(release, 'freshell-server'), 0o755)
}
