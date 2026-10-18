import { spawn, spawnSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import { runtimeCargoBuildAndCopy, runtimeCargoCommand } from '../../../scripts/testing/runtime-cargo-artifacts.js'
import { ensureRustServerBuilt } from '../../e2e-browser/helpers/rust-server.js'

describe.runIf(process.platform === 'linux')('runtime Cargo artifact ownership', () => {
  it('freezes the requested feature build before a competing Cargo producer can replace it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-cargo-artifacts-'))
    const targetDirectory = path.join(root, 'target')
    const ready = path.join(root, 'built')
    const resume = path.join(root, 'copy-allowed')
    const frozen = path.join(root, 'fixture-host')
    const competingFrozen = path.join(root, 'ordinary-host')
    const env = { ...process.env, CARGO_TARGET_DIR: targetDirectory }
    fs.mkdirSync(path.join(root, 'src'))
    fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname = "artifact-owner-fixture"\nversion = "0.1.0"\nedition = "2021"\n[features]\nfixtures = []\n')
    fs.writeFileSync(path.join(root, 'src/main.rs'), 'fn main() { println!("{}", if cfg!(feature = "fixtures") { "fixture" } else { "ordinary" }); }\n')
    // Pause after the real feature build has exited, in the exact window where
    // another Cargo command previously replaced the mutable top-level binary.
    const build = path.join(root, 'build.mjs')
    fs.writeFileSync(build, `
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
execFileSync('cargo', ['build', '--offline', '--features', 'fixtures'], { stdio: 'inherit', timeout: 30000 })
fs.writeFileSync(${JSON.stringify(ready)}, '')
const deadline = Date.now() + 30000
while (!fs.existsSync(${JSON.stringify(resume)})) {
  if (Date.now() > deadline) throw new Error('artifact ownership fixture did not release the copy')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
}
`)
    const runner = path.join(root, 'runner.mts')
    fs.writeFileSync(runner, `
import { runtimeCargoBuildAndCopy } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, '../../../scripts/testing/runtime-cargo-artifacts.ts')).href)}
runtimeCargoBuildAndCopy(${JSON.stringify(root)}, process.execPath, [${JSON.stringify(build)}], [{
  source: ${JSON.stringify(path.join(targetDirectory, 'debug', 'artifact-owner-fixture'))},
  target: ${JSON.stringify(frozen)},
}])
`)
    const child = spawn(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), runner], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    const exited = new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => resolve(code ?? 1))
    })
    try {
      const deadline = Date.now() + 30000
      while (!fs.existsSync(ready)) {
        if (child.exitCode !== null || Date.now() > deadline) throw new Error(`feature build did not become ready: ${output}`)
        await delay(10)
      }
      const contender = runtimeCargoCommand(root, 'cargo', ['build', '--offline'], env)
      // A nonblocking actual Cargo contender must be refused while the first
      // build is ready but its run-private copy has not yet been published.
      const raced = spawnSync(contender.command, contender.command === 'flock'
        ? ['--nonblock', ...contender.args] : contender.args, { cwd: root, env, encoding: 'utf8', timeout: 30000 })
      fs.writeFileSync(resume, '')
      expect(await exited, output).toBe(0)
      expect(execFileSync(frozen, { encoding: 'utf8' }).trim()).toBe('fixture')
      expect(raced.status, raced.stderr).toBe(1)

      // Once the first owner is done, the other real feature variant can build
      // in the same cache without changing the already selected executable.
      runtimeCargoBuildAndCopy(root, 'cargo', ['build', '--offline'], [{
        source: path.join(targetDirectory, 'debug', 'artifact-owner-fixture'), target: competingFrozen,
      }], env)
      expect(execFileSync(competingFrozen, { encoding: 'utf8' }).trim()).toBe('ordinary')
      expect(execFileSync(frozen, { encoding: 'utf8' }).trim()).toBe('fixture')
    } finally {
      fs.writeFileSync(resume, '')
      await exited
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 90000)

  it('boots the exact ordinary server from a custom target and retains it after another feature build', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-browser-artifact-'))
    try {
      vi.stubEnv('CARGO_TARGET_DIR', 'custom-target')
      vi.stubEnv('CARGO_NET_OFFLINE', 'true')
      vi.stubEnv('FRESHELL_E2E_RUST_SERVER_BIN', undefined)
      fs.mkdirSync(path.join(root, 'src'))
      fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname = "freshell-server"\nversion = "0.1.0"\nedition = "2021"\n[features]\nfixtures = []\n')
      fs.writeFileSync(path.join(root, 'Cargo.lock'), 'version = 4\n[[package]]\nname = "freshell-server"\nversion = "0.1.0"\n')
      fs.writeFileSync(path.join(root, 'src/main.rs'), 'fn main() { println!("{}", if cfg!(feature = "fixtures") { "fixture" } else { "ordinary" }); }\n')
      const stale = path.join(root, 'target/release/freshell-server')
      fs.mkdirSync(path.dirname(stale), { recursive: true })
      fs.writeFileSync(stale, '#!/bin/sh\nprintf "stale\\n"\n', { mode: 0o755 })

      const selected = ensureRustServerBuilt(root)
      expect(execFileSync(selected, { encoding: 'utf8' }).trim()).toBe('ordinary')
      const competitor = runtimeCargoCommand(root, 'cargo', ['build', '--release', '--locked', '--features', 'fixtures'])
      execFileSync(competitor.command, competitor.args, { cwd: root, stdio: 'inherit' })
      expect(execFileSync(path.join(root, 'custom-target/release/freshell-server'), { encoding: 'utf8' }).trim()).toBe('fixture')
      expect(execFileSync(selected, { encoding: 'utf8' }).trim()).toBe('ordinary')
      expect(execFileSync(ensureRustServerBuilt(root), { encoding: 'utf8' }).trim()).toBe('ordinary')
    } finally {
      vi.unstubAllEnvs()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 90000)
})
