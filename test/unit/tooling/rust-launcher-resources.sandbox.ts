// @vitest-environment node
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { fixture } from './run-rust-tests-fixture.js'
import { sandboxCommand } from '../../../scripts/testing/run-rust-tests.js'
import { descendantPids, readProcessSnapshot } from '../../../scripts/testing/process-tree.js'

if (process.env.FRESHELL_SANDBOX_MODE !== 'runtime-suite') {
  throw new Error('Rust resource regression requires the disposable runtime sandbox')
}

it.each([0, 31])('removes sealed transfer fixtures only inside its owned roots and preserves child status %s', status => {
  const f = fixture()
  const marker = path.join(f.root, 'sealed-fixtures.json')
  const sentinel = path.join(f.artifacts, 'retained-ready')
  const probe = path.join(f.root, 'seal-fixtures.cjs')
  mkdirSync(sentinel)
  writeFileSync(path.join(sentinel, 'private'), 'keep', { mode: 0o400 })
  chmodSync(sentinel, 0o500)
  writeFileSync(probe, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const roots = [process.env.TMPDIR, process.env.FRESHELL_TEST_EXECUTABLE_TMP_DIR];
const observations = roots.map(root => {
  const ready = path.join(root, 'opencode-transfers', 'transfer.ready');
  fs.mkdirSync(ready, {recursive:true});
  for (const name of ['descriptor.json', 'READY', 'entry-0000.bin']) {
    fs.writeFileSync(path.join(ready, name), 'private', {mode:name === 'descriptor.json' ? 0o600 : 0o400});
  }
  fs.symlinkSync(${JSON.stringify(sentinel)}, path.join(root, 'external-ready'));
  fs.chmodSync(ready, 0o500);
  let unlinkError;
  try { fs.unlinkSync(path.join(ready, 'entry-0000.bin')); } catch (error) { unlinkError = error.code; }
  return {root, readyMode:fs.statSync(ready).mode & 0o777,
    fileMode:fs.statSync(path.join(ready, 'entry-0000.bin')).mode & 0o777,
    uid:fs.statSync(ready).uid, unlinkError};
});
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({uid:process.getuid(), observations}));
process.exit(${status});
`, { mode: 0o700 })
  try {
    const result = f.run({ FRESHELL_RUST_TEST_SANDBOX: '1', RUNTIME_PROBE: probe })
    const state = JSON.parse(readFileSync(marker, 'utf8'))
    expect(state.uid).not.toBe(0)
    expect(state.observations).toHaveLength(2)
    for (const observation of state.observations) {
      expect(observation).toMatchObject({ readyMode: 0o500, fileMode: 0o400, uid: state.uid, unlinkError: 'EACCES' })
    }
    expect(result.status, result.stderr).toBe(status)
    for (const { root } of state.observations) expect(existsSync(root)).toBe(false)
    expect(readFileSync(path.join(sentinel, 'private'), 'utf8')).toBe('keep')
    expect(statSync(sentinel).mode & 0o777).toBe(0o500)
    expect(statSync(path.join(sentinel, 'private')).mode & 0o777).toBe(0o400)
  } finally {
    // Settle this test's exact fixtures even while demonstrating the RED.
    if (existsSync(marker)) {
      for (const { root } of JSON.parse(readFileSync(marker, 'utf8')).observations) {
        if (existsSync(root)) {
          chmodSync(path.join(root, 'opencode-transfers', 'transfer.ready'), 0o700)
          rmSync(root, { recursive: true, force: true })
        }
      }
    }
    chmodSync(sentinel, 0o700)
    f.cleanup()
  }
})

it('removes its temporary artifacts when an interrupted child ignores termination', async () => {
  const f = fixture()
  const marker = path.join(f.root, 'held')
  const sentinel = path.join(f.artifacts, 'foreign')
  writeFileSync(sentinel, 'keep')
  const child = spawn('bash', ['-c', sandboxCommand([])], {
    env: { ...process.env, PATH: `${f.root}/bin:${process.env.PATH}`, HOLD_TEST: marker, RECEIPT: path.join(f.root, 'receipt.jsonl') },
    stdio: 'ignore',
  })
  const joined = new Promise(resolve => child.once('close', resolve))
  let ownedTmp: string | undefined
  let ownedExecutableTmp: string | undefined
  try {
    await expect.poll(() => existsSync(marker), { timeout: 5_000 }).toBe(true)
    const running = JSON.parse(readFileSync(marker, 'utf8'))
    ownedTmp = running.tmp
    ownedExecutableTmp = running.executableTmp
    console.info(JSON.stringify({ severity: 'info', event: 'rust_interruption_fixture_started', pid: child.pid, childPid: running.pid, temporaryDirectory: ownedTmp, executableTemporaryDirectory: ownedExecutableTmp }))
    expect(existsSync(running.tmp)).toBe(true)
    expect(existsSync(running.executableTmp)).toBe(true)
    child.kill('SIGTERM')
    await expect.poll(() => existsSync(running.tmp), { timeout: 2_000 }).toBe(false)
    await expect.poll(() => existsSync(running.executableTmp), { timeout: 2_000 }).toBe(false)
    expect(readFileSync(sentinel, 'utf8')).toBe('keep')
  } finally {
    // This regression lives only in the disposable PID namespace. It owns
    // the exact shell tree and joins it even when the expected RED fails.
    if (child.pid !== undefined && child.exitCode === null) {
      const snapshot = readProcessSnapshot(process.platform)
      for (const pid of [child.pid, ...descendantPids(child.pid, snapshot)]) {
        try { process.kill(pid, 'SIGKILL') } catch { /* already settled */ }
      }
    }
    await joined
    if (ownedTmp) rmSync(ownedTmp, { recursive: true, force: true })
    if (ownedExecutableTmp) rmSync(ownedExecutableTmp, { recursive: true, force: true })
    f.cleanup()
  }
})

it('starts concurrent default Tokio runtimes within the unchanged sandbox PID budget', () => {
  const probe = mkdtempSync('/freshell-test-artifacts/.rust-runtime-probe-')
  const f = fixture()
  try {
    mkdirSync(path.join(probe, 'src'))
    writeFileSync(path.join(probe, 'Cargo.toml'), `[package]
name = "rust-runtime-probe"
version = "0.0.0"
edition = "2021"
[workspace]
[dependencies]
tokio = { version = "=1.52.3", features = ["rt-multi-thread"] }
`)
    writeFileSync(path.join(probe, 'src/main.rs'), `fn main() {
    // Like #[tokio::test(flavor = "multi_thread")], every runtime resolves
    // its worker count before a test can acquire a shared fixture lock.
    let runtimes: Vec<_> = (0..8).map(|_| tokio::runtime::Builder::new_multi_thread().build().unwrap()).collect();
    for runtime in &runtimes { assert_eq!(runtime.block_on(async { 42 }), 42); }
}
`)
    const build = spawnSync('cargo', ['build', '--offline', '--manifest-path', path.join(probe, 'Cargo.toml')], {
      env: { ...process.env, CARGO_BUILD_JOBS: '3', CARGO_TARGET_DIR: path.join(probe, 'target') },
      encoding: 'utf8', timeout: 120_000,
    })
    expect(build.status, build.stderr).toBe(0)
    const result = f.run({ FRESHELL_RUST_TEST_SANDBOX: '1', RUNTIME_PROBE: path.join(probe, 'target/debug/rust-runtime-probe') })
    expect(result.status, result.stderr).toBe(0)
  } finally {
    f.cleanup()
    rmSync(probe, { recursive: true, force: true })
  }
}, 150_000)

it('runs every process-intensive libtest case within the unchanged PID budget', () => {
  const f = fixture()
  try {
    const source = path.join(f.artifacts, 'cases.rs')
    const binary = path.join(f.artifacts, 'cases')
    writeFileSync(source, Array.from({ length: 12 }, (_, index) => `#[test]
fn case_${index}() {
    let children: Vec<_> = (0..64).map(|_| std::thread::spawn(|| std::thread::sleep(std::time::Duration::from_millis(300)))).collect();
    for child in children { child.join().unwrap(); }
}`).join('\n'))
    const build = spawnSync('rustc', ['--test', source, '-o', binary], { encoding: 'utf8', timeout: 30_000 })
    expect(build.status, build.stderr).toBe(0)
    const result = f.run({ FRESHELL_RUST_TEST_SANDBOX: '1', RUNTIME_PROBE: binary })
    expect(result.status, result.stderr + result.stdout).toBe(0)
    expect(result.stdout).toContain('12 passed; 0 failed; 0 ignored')
  } finally { f.cleanup() }
})

function assertRustProbe(sourceText: string, env: NodeJS.ProcessEnv = {}): void {
  const f = fixture()
  try {
    const source = path.join(f.artifacts, 'probe.rs')
    const binary = path.join(f.artifacts, 'probe')
    writeFileSync(source, sourceText)
    const build = spawnSync('rustc', [source, '-o', binary], { encoding: 'utf8', timeout: 30_000 })
    expect(build.status, build.stderr).toBe(0)
    const result = f.run({ FRESHELL_RUST_TEST_SANDBOX: '1', RUNTIME_PROBE: binary, ...env })
    expect(result.status, result.stderr + result.stdout).toBe(0)
  } finally { f.cleanup() }
}

it('exchanges native-auth and incarnation socket messages', () => {
  assertRustProbe(`use std::{io::{Read, Write}, os::unix::net::{UnixListener, UnixStream}, path::Path};
fn exchange(path: &Path) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let listener = UnixListener::bind(path).unwrap();
    let mut client = UnixStream::connect(path).unwrap();
    client.write_all(b"private-ipc").unwrap();
    let (mut server, _) = listener.accept().unwrap();
    let mut message = [0; 11];
    server.read_exact(&mut message).unwrap();
    assert_eq!(&message, b"private-ipc");
    std::fs::remove_file(path).unwrap();
}
fn main() {
    let root = std::env::temp_dir();
    let uuid = "00000000-0000-0000-0000-000000000000";
    exchange(&root.join(format!("freshell-inputs-{uuid}/reply.sock")));
    exchange(&root.join(format!(".tmpXXXXXX/runtime/incarnation-{uuid}/host.sock")));
}
`)
})

it.each(['native', 'script'])('executes ordinary temporary %s fixtures', kind => {
  assertRustProbe(`use std::{os::unix::fs::PermissionsExt, process::Command};
fn main() {
    if std::env::args().nth(1).as_deref() == Some("copied") { return; }
    let root = std::env::temp_dir();
    if std::env::var("EXECUTION_KIND").unwrap() == "native" {
        let executable = root.join("copied-native");
        std::fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
        assert!(Command::new(executable).arg("copied").status().unwrap().success());
    } else {
        let script = root.join("fixture.sh");
        std::fs::write(&script, "#!/bin/sh\\nprintf ordinary-script").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let result = Command::new(script).output().unwrap();
        assert!(result.status.success());
        assert_eq!(result.stdout, b"ordinary-script");
    }
}
`, { EXECUTION_KIND: kind })
})
