// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { fixture } from './run-rust-tests-fixture.js'

if (process.env.FRESHELL_SANDBOX_MODE !== 'runtime-suite') {
  throw new Error('Rust resource regression requires the disposable runtime sandbox')
}

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
