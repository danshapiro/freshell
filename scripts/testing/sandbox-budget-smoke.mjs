import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const readControl = name => fs.readFileSync(`/sys/fs/cgroup/${name}`, 'utf8').trim()
let root
let stage = 'arguments'
try {
  const args = process.argv.slice(2)
  assert(args.length === 1 || args.length === 3)
  assert(['1', '2'].includes(args[0]))
  const jobs = Number(args[0])
  const option = args[1]
  if (args.length === 3) {
    assert(['--cli-jobs', '--project-jobs'].includes(option))
    assert.equal(args[2], args[0])
    assert.equal(process.env.CARGO_BUILD_JOBS, undefined)
  } else if (process.env.CARGO_BUILD_JOBS !== undefined) {
    assert.equal(process.env.CARGO_BUILD_JOBS, args[0])
  }
  for (const key of ['CARGO_MAKEFLAGS', 'MAKEFLAGS', 'MFLAGS']) assert(!process.env[key], 'external jobserver must be absent')
  const mode = option === '--cli-jobs' ? 'cli' : option === '--project-jobs' ? 'project'
    : process.env.CARGO_BUILD_JOBS === undefined ? 'native' : 'environment'

  stage = 'controls'
  const controls = Object.fromEntries(['cpu.max', 'memory.max', 'memory.swap.max', 'pids.max'].map(name => [name, readControl(name)]))
  const [quota, period] = controls['cpu.max'].split(' ').map(Number)
  assert.equal(quota / period, 2)
  assert.equal(controls['memory.max'], '8589934592')
  assert.equal(controls['memory.swap.max'], '8589934592')
  assert.equal(controls['pids.max'], '512')

  stage = 'fixture'
  // The runtime's /tmp is intentionally noexec. Use its existing executable
  // artifact volume for both the tiny source fixture and its private target.
  root = fs.mkdtempSync(path.join(process.env.FRESHELL_TEST_EXECUTABLE_TMP_DIR ?? os.tmpdir(), 'cargo-budget-'))
  for (let ancestor = path.dirname(root); ; ancestor = path.dirname(ancestor)) {
    for (const config of ['config', 'config.toml']) assert(!fs.existsSync(path.join(ancestor, '.cargo', config)), 'external Cargo config must be absent')
    if (path.dirname(ancestor) === ancestor) break
  }
  const events = path.join(root, 'events')
  fs.mkdirSync(events)
  fs.mkdirSync(path.join(root, 'cargo-home'))
  const members = Array.from({ length: 6 }, (_, index) => `unit${index}`)
  fs.writeFileSync(path.join(root, 'Cargo.toml'), `[workspace]\nresolver="2"\nmembers=${JSON.stringify(members)}\n`)
  if (option === '--project-jobs') {
    fs.mkdirSync(path.join(root, '.cargo'))
    fs.writeFileSync(path.join(root, '.cargo/config.toml'), `[build]\njobs = ${jobs}\n`)
  }
  for (const member of members) {
    fs.mkdirSync(path.join(root, member, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, member, 'Cargo.toml'), `[package]\nname="${member}"\nversion="0.1.0"\nedition="2021"\n`)
    fs.writeFileSync(path.join(root, member, 'src/lib.rs'), 'pub fn value() -> u8 { 1 }\n')
    fs.writeFileSync(path.join(root, member, 'build.rs'), `
use std::{env,fs,thread,time::{Duration,SystemTime,UNIX_EPOCH}};
fn main() {
 let start=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
 let held=vec![1u8;8*1024*1024];
 thread::sleep(Duration::from_millis(300));
 std::hint::black_box(&held);
 let end=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
 let line=format!("{{\\"name\\":\\"${member}\\",\\"jobs\\":{},\\"start\\":\\"{}\\",\\"end\\":\\"{}\\"}}\\n",env::var("NUM_JOBS").unwrap(),start,end);
 fs::write(std::path::Path::new(&env::var("BUDGET_EVENTS").unwrap()).join("${member}.jsonl"),line).unwrap();
}
`)
  }
  stage = 'cargo'
  const cargoArgs = ['build', '--workspace', '--offline']
  if (option === '--cli-jobs') cargoArgs.push('--jobs', args[2])
  // Running from this project is necessary for Cargo to discover its local
  // config; the private CARGO_HOME excludes inherited user configuration.
  execFileSync('cargo', cargoArgs, {
    cwd: root,
    env: { ...process.env, BUDGET_EVENTS: events, CARGO_HOME: path.join(root, 'cargo-home'), CARGO_TARGET_DIR: path.join(root, 'target') },
    stdio: 'inherit', timeout: 120_000,
  })
  stage = 'observations'
  const rows = fs.readdirSync(events).flatMap(file => fs.readFileSync(path.join(events, file), 'utf8').trim().split('\n').map(line => JSON.parse(line)))
  assert.equal(rows.length, 6)
  assert.deepEqual(rows.map(row => row.name).sort(), members)
  for (const row of rows) {
    assert.equal(row.jobs, jobs)
    assert(BigInt(row.end) > BigInt(row.start))
  }
  const edges = rows.flatMap(row => [[BigInt(row.start), 1], [BigInt(row.end), -1]])
    .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] - right[1])
  let running = 0
  let peakOverlap = 0
  for (const [, delta] of edges) {
    running += delta
    peakOverlap = Math.max(peakOverlap, running)
  }
  assert(peakOverlap >= 1 && peakOverlap <= jobs)
  const pressure = readControl('memory.pressure')
  const peakBytes = Number(readControl('memory.peak'))
  const someAvg10 = Number(/^some avg10=([0-9.]+)/m.exec(pressure)?.[1])
  assert(Number.isFinite(peakBytes) && peakBytes > 0 && peakBytes < 2 * 1024 ** 3)
  assert(Number.isFinite(someAvg10) && someAvg10 < 5)
  console.log(JSON.stringify({ severity: 'info', event: 'sandbox_budget_smoke_passed', mode,
    jobs, peakOverlap, peakBytes, memoryPsiSomeAvg10: someAvg10, controls, completions: rows }))
} catch {
  console.error(JSON.stringify({ severity: 'error', event: 'sandbox_budget_smoke_failed', stage }))
  process.exitCode = 1
} finally {
  if (root) fs.rmSync(root, { recursive: true, force: true })
}
