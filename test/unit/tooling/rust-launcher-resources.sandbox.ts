// @vitest-environment node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { fixture } from './run-rust-tests-fixture.js'
import { sandboxCommand } from '../../../scripts/testing/run-rust-tests.js'
import { descendantPids, readProcessSnapshot } from '../../../scripts/testing/process-tree.js'

if (process.env.FRESHELL_SANDBOX_MODE !== 'runtime-suite') {
  throw new Error('Rust resource regression requires the disposable runtime sandbox')
}

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
  try {
    await expect.poll(() => existsSync(marker), { timeout: 5_000 }).toBe(true)
    const running = JSON.parse(readFileSync(marker, 'utf8'))
    ownedTmp = running.tmp
    console.info(JSON.stringify({ severity: 'info', event: 'rust_interruption_fixture_started', pid: child.pid, childPid: running.pid, temporaryDirectory: ownedTmp }))
    expect(existsSync(running.tmp)).toBe(true)
    child.kill('SIGTERM')
    await expect.poll(() => existsSync(running.tmp), { timeout: 2_000 }).toBe(false)
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
