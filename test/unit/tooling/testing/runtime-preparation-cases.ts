import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { RuntimeHarness } from '../../../../scripts/testing/runtime-sandbox.js'
import { RuntimePreparation } from '../../../../scripts/testing/runtime-preparation.js'
import { ManagedRuntimeBrowserRig } from '../../../e2e-browser/helpers/managed-runtime.js'
import { RustServer } from '../../../e2e-browser/helpers/rust-server.js'

// The tools are finite child processes, not mocked preparation methods. Their
// source outputs live only in this fixture's repository and isolated HOME.
async function fixture(
  options: { commandMs: number; failBuild?: boolean; failManagedBuild?: boolean; managedMs?: number; descendant?: boolean },
  check: (harness: RuntimeHarness, root: string, log: string) => Promise<void>,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-'))
  const previous = { HOME: process.env.HOME, PATH: process.env.PATH, PREPARATION_FIXTURE: process.env.PREPARATION_FIXTURE }
  const bin = path.join(root, 'bin')
  const home = path.join(root, 'home')
  const log = path.join(root, 'commands.jsonl')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true })
  fs.mkdirSync(path.join(root, '.git'))
  fs.mkdirSync(path.join(root, 'test/runtime'), { recursive: true })
  fs.writeFileSync(path.join(root, 'test/runtime/gate-manifest.json'), '{}')
  const tool = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const a = process.argv.slice(2), name = path.basename(process.argv[1]);
const o = JSON.parse(process.env.PREPARATION_FIXTURE), root = o.root;
fs.appendFileSync(o.log, JSON.stringify({name, args:a, pid:process.pid})+'\\n');
if(name === 'git') { console.log(a.includes('--git-common-dir') ? path.join(root,'.git') : 'a'.repeat(40)); process.exit(0); }
if(name === 'docker' && a[0] !== 'build') {
  if(a[0] === 'image') console.log('sha256:'+'b'.repeat(64));
  if(a[0] === 'info') console.log(JSON.stringify({SecurityOptions:[]}));
  if(a[0] === 'version') console.log('fixture-docker');
  process.exit(0);
}
if(a.includes('rustc')) {console.log('rustc fixture'); process.exit(0);}
let descendant;
if(o.descendant) {
  descendant = cp.spawn(process.execPath,['-e','setTimeout(()=>{},3000)'],{stdio:'ignore'});
  fs.appendFileSync(o.log,JSON.stringify({name:'descendant',pid:descendant.pid,parentPid:process.pid})+'\\n');
}
setTimeout(()=>{
  if(name === 'mise' && (o.failBuild || (o.failManagedBuild && a.includes('freshell-server')))) process.exit(7);
  for(const profile of ['debug','release']) for(const binary of ['freshell-supervisor','freshell-session-host','freshell-server']) {
    const target=path.join(root,'target',profile,binary);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'fixture source output');
  }
  if(descendant) {descendant.kill();descendant.once('close',()=>process.exit(0));} else process.exit(0);
},a.includes('freshell-server') ? (o.managedMs ?? o.commandMs) : o.commandMs);
`
  for (const target of [path.join(bin, 'git'), path.join(bin, 'docker'), path.join(home, '.local/bin/mise')]) {
    fs.writeFileSync(target, tool, { mode: 0o755 })
  }
  process.env.HOME = home
  process.env.PATH = `${bin}${path.delimiter}${previous.PATH}`
  process.env.PREPARATION_FIXTURE = JSON.stringify({ ...options, root, log })
  const harness = new RuntimeHarness(root, undefined, 2)
  try {
    await check(harness, root, log)
  } finally {
    await harness.cleanup()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(harness.testRoot, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function rows(log: string): Array<{ name: string; args?: string[]; pid: number; parentPid?: number }> {
  return fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
}

async function assertReaped(log: string): Promise<void> {
  const children = rows(log).filter(row => row.name !== 'git')
  assert(children.length > 0, 'a real preparation child must run')
  for (const child of children) {
    const deadline = Date.now() + 1500
    while (Date.now() < deadline) {
      try { process.kill(child.pid, 0) } catch { break }
      await delay(20)
    }
    assert.throws(() => process.kill(child.pid, 0), `preparation child ${child.pid} must be reaped`)
  }
}

async function waitForBuildDescendant(log: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const recorded = rows(log)
    const command = recorded.find(row => row.name === 'mise')
    if (command && recorded.some(row => row.parentPid === command.pid)) return
    await delay(10)
  }
  assert.fail('teardown must reach a live preparation command and its actual descendant')
}

async function pendingCopy(cancel: boolean): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-copy-'))
  const source = path.join(root, 'source')
  const target = path.join(root, 'target')
  // Real, finite I/O: this is large enough to observe a writer in flight on
  // the bounded two-CPU fixture, without fake fs promises or background work.
  const bytes = 128 * 1024 * 1024
  fs.writeFileSync(source, Buffer.alloc(bytes, 0x61))
  const abort = new AbortController()
  const preparation = new RuntimePreparation({ timeoutMs: cancel ? 5000 : 1, signal: abort.signal })
  let settled = false
  let observer: number | undefined
  const outcome = preparation.copy(source, target).then(() => undefined, error => error).finally(() => { settled = true })
  try {
    assert.equal(settled, false, 'the actual filesystem copy is asynchronous and pending')
    if (cancel) {
      const deadline = Date.now() + 2000
      while (!fs.existsSync(target) && !settled && Date.now() < deadline) await delay(1)
      assert(fs.existsSync(target), 'cancellation reaches an actual run-owned writer')
      const size = fs.statSync(target).size
      assert(size < bytes && !settled, 'cancellation reaches the writer before its copy completes')
      observer = fs.openSync(target, 'r')
      abort.abort(new Error('copy fixture cancelled preparation'))
    }
    const error = await outcome
    assert.match(String(error), /cancelled preparation|preparation.*deadline|preparation.*exceeded/i)
    assert(!fs.existsSync(target) || fs.statSync(target).size < bytes, 'cancellation stops the actual copy before it writes all source bytes')
    if (observer === undefined && fs.existsSync(target)) observer = fs.openSync(target, 'r')
    const settledSize = observer === undefined ? undefined : fs.fstatSync(observer).size
    fs.rmSync(target, { force: true })
    await delay(100)
    if (observer !== undefined) assert.equal(fs.fstatSync(observer).size, settledSize, 'the writer must settle, even after its path is unlinked')
    assert.equal(fs.existsSync(target), false, 'a settled writer cannot recreate the run-owned path after cleanup')
  } finally {
    await outcome
    preparation.close()
    if (observer !== undefined) fs.closeSync(observer)
    fs.rmSync(root, { recursive: true, force: true })
  }
}

export const preparationCases: Record<string, () => Promise<void>> = {
  'healthy copies preserve source bytes, executable mode and filesystem errors': async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-copy-healthy-'))
    const source = path.join(root, 'source')
    const target = path.join(root, 'target')
    const preparation = new RuntimePreparation({ timeoutMs: 3000 })
    try {
      const bytes = Buffer.from([0, 255, 1, 128, 13, 10])
      fs.writeFileSync(source, bytes, { mode: 0o600 })
      await preparation.copy(source, target)
      assert.deepEqual(fs.readFileSync(target), bytes)
      assert.equal(fs.statSync(target).mode & 0o777, 0o755)
      await assert.rejects(preparation.copy(path.join(root, 'missing'), target), { code: 'ENOENT' })
      assert.deepEqual(fs.readFileSync(source), bytes)
    } finally {
      preparation.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
  'harness cleanup cancels and joins pending preparation before removing copies': async () => {
    await fixture({ commandMs: 2200, descendant: true }, async (harness, _root, log) => {
      let settled = false
      const pending = harness.prepare({ timeoutMs: 6000 }).finally(() => { settled = true })
      const outcome = pending.then(() => undefined, error => error)
      try {
        await waitForBuildDescendant(log, 5000)
        assert.deepEqual(await harness.cleanup(), { ok: true, errors: [] })
        assert(settled, 'cleanup must join preparation before returning')
        assert.match(String(await outcome), /preparation.*cancel/i)
        await assertReaped(log)
        await delay(80)
        assert.equal(fs.existsSync(harness.buildDir), false)
        assert.equal(fs.existsSync(path.join(harness.testRoot, 'broker/docker.sock')), false)
        assert.deepEqual(await harness.cleanup(), { ok: true, errors: [] })
        await assert.rejects(harness.prepare(), /stopped|closed|cancel/i)
      } finally {
        await outcome
      }
    })
  },
  'rig stop settles pending start and its preparation child without late runtime': async () => {
    await fixture({ commandMs: 2200, descendant: true }, async (_harness, root, log) => {
      const rig = new ManagedRuntimeBrowserRig(root, 2, {}, {}, 'test', { enabledProviders: [] })
      let settled = false
      const preparing = rig.prepare({ timeoutMs: 6000 })
      const outcome = rig.start().finally(() => { settled = true }).then(() => undefined, error => error)
      void preparing.catch(() => undefined)
      try {
        await waitForBuildDescendant(log, 5000)
        assert.deepEqual(await rig.stop(), { ok: true, errors: [] })
        assert(settled, 'stop must join pending start before returning')
        assert.match(String(await outcome), /preparation.*cancel|stopped/i)
        await assertReaped(log)
        await delay(80)
        assert.equal(fs.existsSync(rig.runtime.buildDir), false)
        assert.equal(fs.existsSync(path.join(rig.runtime.testRoot, 'broker/docker.sock')), false)
        assert.equal(rows(log).some(row => row.args?.[0] === 'run'), false)
        assert.equal(rig.web, undefined)
        assert.deepEqual(await rig.stop(), { ok: true, errors: [] })
        await assert.rejects(rig.start(), /stopped|cancel/i)
      } finally {
        await outcome
        await rig.stop()
        fs.rmSync(rig.runtime.testRoot, { recursive: true, force: true })
      }
    })
  },
  'pending copy observes the shared deadline and settles its writer': async () => {
    await pendingCopy(false)
  },
  'pending copy observes external cancellation and settles its writer': async () => {
    await pendingCopy(true)
  },
  'sequential source commands share one preparation deadline': async () => {
    await fixture({ commandMs: 180 }, async (harness, _root, log) => {
      const options = { operatorHome: undefined, timeoutMs: 420 }
      await assert.rejects(harness.prepare(options), /preparation.*(deadline|timed out|exceeded)/i)
      assert.equal(fs.existsSync(harness.buildDir), false, 'failure cleanup removes run-owned copies')
      assert(rows(log).filter(row => row.name === 'mise').length < 2, 'deadline is shared, never renewed per command')
      await assertReaped(log)
    })
  },
  'failed preparation cleans run-owned copies and never starts runtime': async () => {
    await fixture({ commandMs: 40, failBuild: true, descendant: true }, async (harness, _root, log) => {
      let started = false
      const options = { operatorHome: undefined, timeoutMs: 2000 }
      await assert.rejects(async () => { await harness.prepare(options); started = true })
      assert.equal(started, false)
      assert.equal(fs.existsSync(harness.buildDir), false)
      await assertReaped(log)
    })
  },
  'cancelled preparation reaps its command and descendant before rejecting': async () => {
    await fixture({ commandMs: 1000, descendant: true }, async (harness, _root, log) => {
      const abort = new AbortController()
      const pending = harness.prepare({ operatorHome: undefined, timeoutMs: 5000, signal: abort.signal })
      await waitForBuildDescendant(log)
      abort.abort(new Error('fixture cancelled preparation'))
      await assert.rejects(pending, /cancelled preparation/)
      assert.equal(fs.existsSync(harness.buildDir), false)
      await assertReaped(log)
    })
  },
  'stalled preparation reaps its command and descendant without starting runtime': async () => {
    await fixture({ commandMs: 3000, descendant: true }, async (harness, _root, log) => {
      const options = { operatorHome: undefined, timeoutMs: 350 }
      await assert.rejects(harness.prepare(options), /preparation.*(deadline|exceeded)/i)
      assert.equal(fs.existsSync(harness.buildDir), false)
      assert.equal(rows(log).some(row => row.args?.[0] === 'run'), false)
      await assertReaped(log)
    })
  },
  'managed source-build failure cleans the broker and prevents runtime start': async () => {
    await fixture({ commandMs: 40, failManagedBuild: true }, async (_harness, root, log) => {
      const rig = new ManagedRuntimeBrowserRig(root, 2, {}, {}, 'test', { enabledProviders: [] })
      try {
        await assert.rejects(rig.prepare({ timeoutMs: 5000 }), /preparation command failed/)
        await assert.rejects(rig.start(), /preparation command failed/)
        assert.equal(fs.existsSync(rig.runtime.buildDir), false)
        assert.equal(fs.existsSync(rig.runtime.broker.proxySocketPath), false)
        assert.equal(rows(log).some(row => row.args?.[0] === 'run'), false)
        await assertReaped(log)
      } finally {
        await rig.stop()
        fs.rmSync(rig.runtime.testRoot, { recursive: true, force: true })
      }
    })
  },
  'managed source builds share the same absolute preparation deadline': async () => {
    await fixture({ commandMs: 70, managedMs: 2200 }, async (_harness, root, log) => {
      const rig = new ManagedRuntimeBrowserRig(root, 2, {}, {}, 'test', { enabledProviders: [] })
      try {
        await assert.rejects(rig.prepare({ timeoutMs: 2500 }), /preparation.*(deadline|exceeded)/i)
        assert(rows(log).some(row => row.args?.includes('freshell-server')), 'the managed source build must actually begin')
        assert.equal(fs.existsSync(rig.runtime.buildDir), false)
        assert.equal(fs.existsSync(rig.runtime.broker.proxySocketPath), false)
        await assertReaped(log)
      } finally {
        await rig.stop()
        fs.rmSync(rig.runtime.testRoot, { recursive: true, force: true })
      }
    })
  },
  'preparation longer than readiness still permits an immediately healthy runtime': async () => {
    await preparationThenRuntime(false)
  },
  'stalled runtime still fails within its separate readiness allowance': async () => {
    await preparationThenRuntime(true)
  },
}

async function preparationThenRuntime(stalled: boolean): Promise<void> {
  await fixture({ commandMs: 200 }, async (_harness, root) => {
    const rig = new ManagedRuntimeBrowserRig(root, 2, {}, {}, 'test', { enabledProviders: [] })
    const previousBinary = process.env.FRESHELL_E2E_RUST_SERVER_BIN
    const readinessMs = 500
    let web: RustServer | undefined
    try {
      const preparingAt = Date.now()
      await rig.prepare({ timeoutMs: 5000 })
      assert(Date.now() - preparingAt > readinessMs, 'source preparation exceeds the runtime readiness allowance')
      const binary = path.join(rig.runtime.buildDir, 'freshell-server-managed')
      fs.writeFileSync(binary, `#!${process.execPath}\nconst http=require('node:http');\n${stalled
        ? 'setInterval(()=>{},1000);'
        : `http.createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify(q.url==='/api/health'?{ok:true}:{runtime:'rust',commit:'fixture'}))}).listen(Number(process.env.PORT),'127.0.0.1');`}`,
      { mode: 0o755 })
      process.env.FRESHELL_E2E_RUST_SERVER_BIN = binary
      web = new RustServer({ startTimeoutMs: readinessMs })
      const startingAt = Date.now()
      if (stalled) await assert.rejects(web.start(), /Timed out waiting for Rust server health after 500ms/)
      else assert((await web.start()).pid > 0)
      assert(Date.now() - startingAt < readinessMs + 1500, 'readiness does not inherit or renew the preparation allowance')
    } finally {
      await web?.stop()
      await rig.stop()
      if (previousBinary === undefined) delete process.env.FRESHELL_E2E_RUST_SERVER_BIN
      else process.env.FRESHELL_E2E_RUST_SERVER_BIN = previousBinary
      fs.rmSync(rig.runtime.testRoot, { recursive: true, force: true })
    }
  })
}
