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
  it('releases the artifact lock when Cargo exits even while its test descendant remains alive', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-cargo-descendant-'))
    const env = { ...process.env, CARGO_TARGET_DIR: path.join(root, 'target'), CARGO_HOME: path.join(root, 'cargo-home'), CARGO_NET_OFFLINE: 'true',
      LOCK_FIXTURE_ROOT: root }
    const ready = path.join(root, 'child-ready'), release = path.join(root, 'child-release')
    const finished = path.join(root, 'cargo-finished')
    fs.mkdirSync(path.join(root, 'src'))
    fs.mkdirSync(path.join(root, 'tests'))
    fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname="lock-descendant-fixture"\nversion="0.1.0"\nedition="2021"\n')
    fs.writeFileSync(path.join(root, 'src/main.rs'), `
use std::{env,fs,path::PathBuf,thread,time::{Duration,Instant}};
fn main() {
    let root=PathBuf::from(env::var_os("LOCK_FIXTURE_ROOT").unwrap());
    fs::write(root.join("child-ready.tmp"),std::process::id().to_string()).unwrap();
    fs::rename(root.join("child-ready.tmp"),root.join("child-ready")).unwrap();
    let deadline=Instant::now()+Duration::from_secs(45);
    while !root.join("child-release").exists() && Instant::now()<deadline {thread::sleep(Duration::from_millis(10));}
}
`)
    fs.writeFileSync(path.join(root, 'tests/owner.rs'), `
use std::process::{Command,Stdio};
#[test]
fn retained_descendant() {
    let _child=Command::new(env!("CARGO_BIN_EXE_lock-descendant-fixture"))
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
}
`)
    // Adopt and reap the retained fixture child after Cargo's test exits.
    // The orchestrator never owns the artifact lock itself.
    const orchestrator = path.join(root, 'run.py')
    fs.writeFileSync(orchestrator, `
import ctypes,json,os,pathlib,subprocess,sys,time
assert ctypes.CDLL(None,use_errno=True).prctl(36,1,0,0,0)==0
root=pathlib.Path(os.environ['LOCK_FIXTURE_ROOT'])
result=subprocess.run(json.loads(sys.argv[1]),timeout=30)
(root/'cargo-finished.tmp').write_text(str(result.returncode))
(root/'cargo-finished.tmp').rename(root/'cargo-finished')
if result.returncode==0:
    deadline=time.monotonic()+5
    while not (root/'child-ready').exists():
        assert time.monotonic()<deadline
        time.sleep(.01)
    os.waitpid(int((root/'child-ready').read_text()),0)
sys.exit(result.returncode)
`)
    const command = runtimeCargoCommand(root, 'cargo', ['test', '--offline', '--test', 'owner'], env)
    const child = spawn('python3', [orchestrator, JSON.stringify([command.command, ...command.args])], {
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
      while (!fs.existsSync(finished) || !fs.existsSync(ready)) {
        if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Cargo descendant did not become ready: ${output}`)
        await delay(10)
      }
      expect(fs.readFileSync(finished, 'utf8')).toBe('0')
      expect(process.kill(Number(fs.readFileSync(ready, 'utf8')), 0)).toBe(true)
      const contender = runtimeCargoCommand(root, process.execPath, ['-e', 'process.stdout.write("acquired")'], env)
      const acquired = spawnSync(contender.command, ['--nonblock', ...contender.args], { cwd: root, env, encoding: 'utf8', timeout: 5000 })
      expect(acquired.status, acquired.stderr).toBe(0)
      expect(acquired.stdout).toBe('acquired')
    } finally {
      fs.writeFileSync(release, '')
      try {
        expect(await exited, output).toBe(0)
        if (fs.existsSync(ready)) {
          expect(() => process.kill(Number(fs.readFileSync(ready, 'utf8')), 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  }, 90000)

  it('freezes the requested feature build before a competing Cargo producer can replace it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-cargo-artifacts-'))
    const targetDirectory = path.join(root, 'target')
    const ready = path.join(root, 'built')
    const resume = path.join(root, 'copy-allowed')
    const frozen = path.join(root, 'fixture-host')
    const competingFrozen = path.join(root, 'ordinary-host')
    const env = { ...process.env, CARGO_TARGET_DIR: targetDirectory, CARGO_HOME: path.join(root, 'cargo-home') }
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
      vi.stubEnv('CARGO_HOME', path.join(root, 'cargo-home'))
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
