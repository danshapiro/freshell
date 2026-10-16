import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const jobs = Number(process.argv[2])
assert([1, 2].includes(jobs))
assert.equal(Number(process.env.CARGO_BUILD_JOBS), jobs)
const read = name => fs.readFileSync(`/sys/fs/cgroup/${name}`, 'utf8').trim()
const [quota, period] = read('cpu.max').split(' ').map(Number)
assert.equal(quota / period, 2)
assert.equal(read('memory.max'), '8589934592')
assert.equal(read('memory.swap.max'), '8589934592')
assert.equal(read('pids.max'), '512')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-budget-'))
const events = path.join(root, 'events.jsonl')

try {
  const members = Array.from({ length: 6 }, (_, i) => `unit${i}`)
  fs.writeFileSync(path.join(root, 'Cargo.toml'), `[workspace]\nresolver="2"\nmembers=${JSON.stringify(members)}\n`)
  for (const member of members) {
    fs.mkdirSync(path.join(root, member, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, member, 'Cargo.toml'), `[package]\nname="${member}"\nversion="0.1.0"\nedition="2021"\n`)
    fs.writeFileSync(path.join(root, member, 'src/lib.rs'), 'pub fn value() -> u8 { 1 }\n')
    fs.writeFileSync(path.join(root, member, 'build.rs'), `
use std::{env,fs::OpenOptions,io::Write,thread,time::{Duration,SystemTime,UNIX_EPOCH}};
fn main() {
 let start=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
 let held=vec![1u8;8*1024*1024];
 thread::sleep(Duration::from_millis(300));
 std::hint::black_box(&held);
 let end=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
 let mut f=OpenOptions::new().create(true).append(true).open(env::var("BUDGET_EVENTS").unwrap()).unwrap();
 let line=format!("{{\\"name\\":\\"${member}\\",\\"jobs\\":{},\\"start\\":\\"{}\\",\\"end\\":\\"{}\\"}}\\n",env::var("NUM_JOBS").unwrap(),start,end);
 f.write_all(line.as_bytes()).unwrap();
}
`)
  }
  execFileSync('cargo', ['build', '--workspace', '--offline', '--manifest-path', path.join(root, 'Cargo.toml')], {
    env: { ...process.env, BUDGET_EVENTS: events, CARGO_TARGET_DIR: path.join(root, 'target') },
    stdio: 'inherit', timeout: 120_000,
  })
  const rows = fs.readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows.length, 6)
  assert.equal(new Set(rows.map(row => row.name)).size, 6)
  for (const row of rows) assert.equal(row.jobs, jobs)
  const edges = rows.flatMap(row => [[BigInt(row.start), 1], [BigInt(row.end), -1]])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1])
  let running = 0, peak = 0
  for (const [, delta] of edges) {
    running += delta
    peak = Math.max(peak, running)
  }
  assert(peak >= 1 && peak <= jobs)
  const pressure = read('memory.pressure')
  const peakBytes = Number(read('memory.peak'))
  assert(peakBytes < 2 * 1024 ** 3)
  assert(Number(/some avg10=([0-9.]+)/.exec(pressure)[1]) < 5)
  console.log(JSON.stringify({ severity: 'info', event: 'sandbox_budget_smoke_passed', cause: 'bounded_cargo_completed',
    action: 'verify_effective_budget', outcome: 'passed', jobs, peakOverlap: peak, peakBytes, pressure }))
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
