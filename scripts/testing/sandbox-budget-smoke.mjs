import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const readControl = name => fs.readFileSync(`/sys/fs/cgroup/${name}`, 'utf8').trim()
const readControlOrNull = name => {
  try { return readControl(name) } catch { return null }
}
const unsignedInteger = value => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}
const numericTime = value => typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : null
const memoryLimitBytes = 8 * 1024 ** 3
const peakLimitBytes = 2 * 1024 ** 3
const pidsLimit = 512
let root
let stage = 'arguments'
let failure
const requireObservation = (condition, reason, values = {}) => {
  if (condition) return
  failure = { reason, ...values }
  throw new Error('sandbox budget smoke validation failed')
}
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
  const cpu = /^(\d+) (\d+)$/.exec(readControlOrNull('cpu.max') ?? '')
  const quota = unsignedInteger(cpu?.[1])
  const period = unsignedInteger(cpu?.[2])
  const observedCpus = quota !== null && period !== null && period > 0 ? quota / period : null
  requireObservation(observedCpus === 2, 'cpu_limit', { expected_cpus: 2, observed_cpus: observedCpus })
  const memory = unsignedInteger(readControlOrNull('memory.max'))
  requireObservation(memory === memoryLimitBytes, 'memory_limit', { expected_bytes: memoryLimitBytes, observed_bytes: memory })
  const swap = unsignedInteger(readControlOrNull('memory.swap.max'))
  requireObservation(swap === memoryLimitBytes, 'swap_limit', { expected_bytes: memoryLimitBytes, observed_bytes: swap })
  const pids = unsignedInteger(readControlOrNull('pids.max'))
  requireObservation(pids === pidsLimit, 'pids_limit', { expected_pids: pidsLimit, observed_pids: pids })
  // Preserve the existing success receipt shape using validated numeric data.
  const controls = { 'cpu.max': `${quota} ${period}`, 'memory.max': String(memory),
    'memory.swap.max': String(swap), 'pids.max': String(pids) }

  stage = 'fixture'
  // The runtime's /tmp is intentionally noexec. Use its existing executable
  // artifact volume for both the tiny source fixture and its private target.
  root = fs.mkdtempSync(path.join(process.env.FRESHELL_TEST_EXECUTABLE_TMP_DIR ?? os.tmpdir(), 'cargo-budget-'))
  for (let ancestor = path.dirname(root); ; ancestor = path.dirname(ancestor)) {
    for (const config of ['config', 'config.toml']) assert(!fs.existsSync(path.join(ancestor, '.cargo', config)), 'external Cargo config must be absent')
    if (path.dirname(ancestor) === ancestor) break
  }
  const events = path.join(root, 'events')
  const barrier = path.join(root, 'barrier')
  fs.mkdirSync(events)
  fs.mkdirSync(barrier)
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
use std::{env,fs,thread,time::{Duration,Instant,SystemTime,UNIX_EPOCH}};
fn main() {
 let observed_jobs=env::var("NUM_JOBS").unwrap();
 let start=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
 let held=vec![1u8;8*1024*1024];
 // The first two build scripts must both arrive before either completes.
 // The deadline bounds a genuinely serial or stalled Cargo run; overlap is
 // still measured from the completed records, not assumed from this wait.
 if ${jobs} == 2 && observed_jobs == "2" {
  let barrier=env::var("BUDGET_BARRIER").unwrap();
  let dir=std::path::Path::new(&barrier);
  fs::write(dir.join("${member}"),b"ready").unwrap();
  let deadline=Instant::now()+Duration::from_secs(60);
  while fs::read_dir(dir).unwrap().take(2).count()<2 && Instant::now()<deadline {
   thread::sleep(Duration::from_millis(20));
  }
 }
 thread::sleep(Duration::from_millis(300));
 std::hint::black_box(&held);
 let end=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
 let line=format!("{{\\"name\\":\\"${member}\\",\\"jobs\\":{},\\"start\\":\\"{}\\",\\"end\\":\\"{}\\"}}\\n",observed_jobs,start,end);
 fs::write(std::path::Path::new(&env::var("BUDGET_EVENTS").unwrap()).join("${member}.jsonl"),line).unwrap();
}
`)
  }
  stage = 'cargo'
  const cargoArgs = ['build', '--workspace', '--offline']
  if (option === '--cli-jobs') cargoArgs.push('--jobs', args[2])
  // Running from this project is necessary for Cargo to discover its local
  // config; the private CARGO_HOME excludes inherited user configuration.
  try {
    execFileSync('cargo', cargoArgs, {
      cwd: root,
      env: { ...process.env, BUDGET_EVENTS: events, BUDGET_BARRIER: barrier,
        CARGO_HOME: path.join(root, 'cargo-home'), CARGO_TARGET_DIR: path.join(root, 'target') },
      stdio: 'inherit', timeout: 120_000,
    })
  } catch (error) {
    const status = Number.isSafeInteger(error?.status) && error.status >= 0 && error.status <= 255 ? error.status : null
    requireObservation(false, 'cargo_exit', { exit_status: status })
  }
  stage = 'observations'
  let rows
  try {
    rows = fs.readdirSync(events).flatMap(file => fs.readFileSync(path.join(events, file), 'utf8').trim().split('\n').map(line => JSON.parse(line)))
  } catch {
    requireObservation(false, 'invalid_observations')
  }
  requireObservation(rows.length === members.length, 'completion_count', { expected_count: members.length, observed_count: rows.length })
  const seen = new Set()
  const intervals = []
  const completions = []
  for (const row of rows) {
    requireObservation(row && typeof row === 'object' && members.includes(row.name) && !seen.has(row.name), 'completion_identity')
    seen.add(row.name)
    const observedJobs = Number.isSafeInteger(row.jobs) ? row.jobs : null
    requireObservation(row.jobs === jobs, 'jobs', { expected_jobs: jobs, observed_jobs: observedJobs })
    const start = numericTime(row.start)
    const end = numericTime(row.end)
    requireObservation(start !== null && end !== null && end > start, 'interval')
    intervals.push({ start, end })
    completions.push({ name: row.name, jobs, start: start.toString(), end: end.toString() })
  }
  const edges = intervals.flatMap(row => [[row.start, 1], [row.end, -1]])
    .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] - right[1])
  let running = 0
  let peakOverlap = 0
  for (const [, delta] of edges) {
    running += delta
    peakOverlap = Math.max(peakOverlap, running)
  }
  requireObservation(peakOverlap === jobs, 'overlap', { expected_jobs: jobs, observed_overlap: peakOverlap })
  const peakBytes = unsignedInteger(readControlOrNull('memory.peak'))
  requireObservation(peakBytes !== null && peakBytes > 0 && peakBytes < peakLimitBytes,
    'memory_peak', { limit_bytes: peakLimitBytes, observed_bytes: peakBytes })
  const pressure = readControlOrNull('memory.pressure')
  const match = /^some avg10=(\d+(?:\.\d+)?)(?=\s|$)/m.exec(pressure ?? '')
  const parsedAvg10 = match ? Number(match[1]) : null
  const someAvg10 = Number.isFinite(parsedAvg10) ? parsedAvg10 : null
  requireObservation(someAvg10 !== null && someAvg10 < 5, 'memory_pressure', { limit_avg10: 5, observed_avg10: someAvg10 })
  console.log(JSON.stringify({ severity: 'info', event: 'sandbox_budget_smoke_passed', mode,
    jobs, peakOverlap, peakBytes, memoryPsiSomeAvg10: someAvg10, controls, completions }))
} catch {
  console.error(JSON.stringify({ severity: 'error', event: 'sandbox_budget_smoke_failed', stage, ...failure }))
  process.exitCode = 1
} finally {
  if (root) fs.rmSync(root, { recursive: true, force: true })
}
