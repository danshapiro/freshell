// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { spawnAndWait } from '../../../scripts/testing/coordinator-upstream.js'

// These fixtures exercise creation-time signals and Docker cleanup. Run them
// through scripts/sandbox-test.sh --runtime-suite, never directly on the host.
if (process.env.FRESHELL_SANDBOX_MODE !== 'runtime-suite') {
  throw new Error('Sandbox wrapper fixtures require scripts/sandbox-test.sh --runtime-suite and sandbox-test.config.ts')
}

function fixture(mode: string) {
  const root = mkdtempSync(path.join(process.env.FRESHELL_TEST_EXECUTABLE_TMP_DIR ?? os.tmpdir(), 'sandbox-wrapper-'))
  for (const subdir of ['scripts', 'bin', 'control']) mkdirSync(path.join(root, subdir))
  copyFileSync(path.resolve('scripts/sandbox-test.sh'), path.join(root, 'scripts/sandbox-test.sh'))
  const guardSource = process.env.FIXTURE_GUARD_SOURCE ?? 'scripts/testing/sandbox-owner-guard.py'
  if (existsSync(guardSource)) {
    mkdirSync(path.join(root, 'scripts/testing'))
    copyFileSync(guardSource, path.join(root, 'scripts/testing/sandbox-owner-guard.py'))
  }
  const receipt = path.join(root, 'receipt.jsonl')
  const state = path.join(root, 'owned-object.json')
  const volumeState = path.join(root, 'volumes.json')
  const foreign = path.join(root, 'foreign-object')
  const ownedProcesses: Array<{ role: string; pid: number; identity: string }> = []
  const joinedProcesses = new Set<number>()
  const capturePendingProcesses = () => {
    if (mode !== 'watchdog-pending-creation') return
    const files = [{ role: 'creator', file: path.join(root, 'creator.json') }, ...readdirSync(path.join(root, 'control'))
      .map(name => ({ role: 'guard', file: path.join(root, 'control', name, 'owner-guard.json') }))]
    for (const { role, file } of files) {
      if (!existsSync(file) || ownedProcesses.some(owned => owned.role === role)) continue
      let owned: { role: string; pid: number; identity: string }
      try { owned = { role, ...JSON.parse(readFileSync(file, 'utf8')) } } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw cause
      }
      ownedProcesses.push(owned)
      console.info(JSON.stringify({ severity: 'info', event: 'sandbox_pending_fixture_process_captured', root, ...owned }))
    }
  }
  writeFileSync(foreign, 'untouched')
  writeFileSync(volumeState, JSON.stringify({ 'freshell-sandbox-cargo-target': { labels: { sentinel: 'legacy-volume' } } }))
  // A daemon request can outlive the attached Docker client. This creator
  // reparents inside the guest, then publishes only after both absence queries.
  writeFileSync(path.join(root, 'pending-creator.py'), String.raw`
import json, os, sys, time
from pathlib import Path
root, name = Path(sys.argv[1]), sys.argv[2]
if os.fork(): os._exit(0)
os.setsid()
if os.fork(): os._exit(0)
with open(os.devnull, 'rb+') as null:
    for fd in (0, 1, 2): os.dup2(null.fileno(), fd)
fields = Path(f'/proc/{os.getpid()}/stat').read_text().rpartition(') ')[2].split()
(root / 'creator.tmp').write_text(json.dumps({'pid': os.getpid(), 'identity': fields[19]}))
(root / 'creator.tmp').replace(root / 'creator.json')
deadline = time.monotonic() + 8
while not (root / 'absence-queries-complete').exists():
    if time.monotonic() >= deadline: os._exit(1)
    time.sleep(.025)
time.sleep(.1)
(root / 'owned-object.json').write_text(json.dumps({'cid': 'a' * 64, 'name': name}))
with (root / 'receipt.jsonl').open('a') as log:
    log.write(json.dumps({'kind': 'pending-daemon-created'}) + '\n')
(root / 'creator.done').write_text('0')
`)
  writeFileSync(path.join(root, 'bin/docker.mjs'), String.raw`
    import fs from 'node:fs';
    import { spawnSync } from 'node:child_process';
    import path from 'node:path';
    const args = process.argv.slice(2), mode = process.env.FIXTURE_MODE;
    const state = process.env.FIXTURE_STATE;
    const volumeState = process.env.FIXTURE_VOLUME_STATE;
    const cid = 'a'.repeat(64);
    const record = event => fs.appendFileSync(process.env.FIXTURE_RECEIPT, JSON.stringify(event)+'\n');
    const object = () => fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : null;
    const volumes = () => fs.existsSync(volumeState) ? JSON.parse(fs.readFileSync(volumeState, 'utf8')) : {};
    const saveVolumes = value => fs.writeFileSync(volumeState, JSON.stringify(value));
    record({kind:'docker', args});
    if (args[0] === 'image') process.exit(0);
    if (args[0] === 'network') process.exit(0);
    if (args[0] === 'volume' && args[1] === 'ls') {
      if (mode === 'volume-list-failed') process.exit(70);
      const filter = args.find(argument => argument.startsWith('name='))?.slice(5) ?? '';
      console.log(Object.keys(volumes()).filter(name => name.includes(filter)).join('\n'));
      process.exit(0);
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      if (mode === 'volume-inspect-failed' || mode === 'volume-disappears-on-inspect') {
        if (mode === 'volume-disappears-on-inspect') {
          const storedVolumes = volumes();
          delete storedVolumes[args.at(-1)];
          saveVolumes(storedVolumes);
        }
        process.exit(71);
      }
      const volume = volumes()[args.at(-1)];
      if (!volume) process.exit(1);
      console.log(JSON.stringify(volume.labels));
      process.exit(0);
    }
    if (args[0] === 'run') {
      if (mode === 'volume-label-unsupported') {
        console.error('Docker daemon rejected the volume-label mount option');
        process.exit(125);
      }
      const storedVolumes = volumes();
      for (let index = 0; index < args.length; index++) {
        if (args[index] !== '--mount') continue;
        const fields = args[index + 1].split(',');
        if (!fields.includes('type=volume')) continue;
        const source = fields.find(field => field.startsWith('src='))?.slice(4);
        if (!source?.startsWith('freshell-sandbox-rust-target-v1-') || storedVolumes[source]) continue;
        const labels = Object.fromEntries(fields.flatMap(field => {
          if (!field.startsWith('volume-label=')) return [];
          const assignment = field.slice('volume-label='.length), split = assignment.indexOf('=');
          return split < 0 ? [] : [[assignment.slice(0, split), assignment.slice(split + 1)]];
        }));
        storedVolumes[source] = { labels };
      }
      saveVolumes(storedVolumes);
      const name = args[args.indexOf('--name')+1], cidfile = args[args.indexOf('--cidfile')+1];
      record({kind:'run', name, cidfile});
      if (mode === 'watchdog-pending-creation') {
        const root = path.dirname(state);
        const starter = spawnSync('python3', [root+'/pending-creator.py', root, name], {stdio:'ignore', timeout:5000});
        if (starter.status !== 0) process.exit(75);
      } else if (mode !== 'no-object' && mode !== 'late-creation') fs.writeFileSync(state, JSON.stringify({cid, name}));
      if (mode === 'published' || mode === 'published-success' || mode === 'removed-race' || mode === 'watchdog-published') fs.writeFileSync(cidfile, cid);
      if (mode === 'removed-race') fs.unlinkSync(state);
      if (mode.startsWith('watchdog-')) {
        setInterval(() => {}, 10000);
      } else if (mode === 'late-creation') {
        process.kill(process.ppid, 'SIGTERM');
        setTimeout(() => {
          fs.writeFileSync(state, JSON.stringify({cid, name}));
          record({kind:'creation-client-settled'});
          process.exit(0);
        }, 150);
      } else process.exit(mode === 'published-success' || mode === 'volume-disappears-on-inspect' ? 0 : mode === 'published' ? 37 : 42);
    } else if (args[0] === 'ps') {
      if (mode === 'query-failed' || mode === 'watchdog-query-failed') process.exit(71);
      const current = object(), filter = args[args.indexOf('--filter')+1];
      if (current && (filter === 'id='+cid || filter === 'name=^/'+current.name+'$')) console.log(cid);
      if (mode === 'watchdog-pending-creation' && !current && filter.startsWith('name=')) {
        const queries = fs.readFileSync(process.env.FIXTURE_RECEIPT, 'utf8').trim().split('\n').map(line => JSON.parse(line))
          .filter(event => event.kind === 'docker' && event.args[0] === 'ps');
        if (queries.length >= 2) fs.writeFileSync(path.dirname(state)+'/absence-queries-complete', '0');
      }
    } else if (args[0] === 'container' && args[1] === 'inspect') {
      process.exit(object() && args[2] === cid ? 0 : 1);
    } else if (['kill', 'stop', 'wait', 'rm'].includes(args[0])) {
      if (args.at(-1) !== cid) process.exit(72);
      if (args[0] === 'rm') {
        if (mode === 'remove-failed') process.exit(73);
        if (object()) fs.unlinkSync(state);
      }
    } else process.exit(74);
  `)
  const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`
  writeFileSync(path.join(root, 'bin/docker'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, 'bin/docker.mjs'))} "$@"\n`)
  chmodSync(path.join(root, 'bin/docker'), 0o755)
  return {
    root, state, volumeState, foreign,
    async runTimeout() {
      const monitor = setInterval(capturePendingProcesses, 10)
      const watchdogLog = vi.spyOn(console, 'error').mockImplementation(() => {})
      let status: number
      let watchdogEvents: unknown[][]
      try {
        status = await spawnAndWait('bash', [path.join(root, 'scripts/sandbox-test.sh'), '--runtime-suite', 'true'], {
          ...process.env, PATH: `${root}/bin:${process.env.PATH}`, TMPDIR: path.join(root, 'control'),
          FIXTURE_MODE: mode, FIXTURE_STATE: state, FIXTURE_RECEIPT: receipt,
          FIXTURE_VOLUME_STATE: volumeState,
          FRESHELL_SANDBOX_OWNER_GUARD: '1',
          FRESHELL_SANDBOX_DEPENDENCIES_READY: '1', FRESHELL_SANDBOX_PREPARE_ONLY: '',
          FRESHELL_TEST_COORDINATOR_PHASE_TIMEOUT_MS: '600', FRESHELL_TEST_COORDINATOR_PHASE_WATCH_POLL_MS: '25',
        }, false)
        watchdogEvents = [...watchdogLog.mock.calls]
      } finally {
        clearInterval(monitor)
        capturePendingProcesses()
        watchdogLog.mockRestore()
      }
      const events = readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      const run = events.filter(event => event.kind === 'run').at(-1)
      if (!run) throw new Error(`Fixture never launched its owned workload: ${JSON.stringify(events)}`)
      return { status, events, watchdogEvents, control: path.dirname(run.cidfile), name: run.name }
    },
    run(guard = false, runtimeSuite = true, twoPhase = false) {
      const wrapperArgs = runtimeSuite ? ['--runtime-suite', 'true'] : ['true']
      const result = spawnSync('bash', [path.join(root, 'scripts/sandbox-test.sh'), ...wrapperArgs], {
        env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, TMPDIR: path.join(root, 'control'),
          FIXTURE_MODE: mode, FIXTURE_STATE: state, FIXTURE_RECEIPT: receipt,
          FIXTURE_VOLUME_STATE: volumeState,
          FRESHELL_SANDBOX_OWNER_GUARD: guard ? '1' : '0',
          FRESHELL_SANDBOX_DEPENDENCIES_READY: twoPhase ? '' : '1', FRESHELL_SANDBOX_PREPARE_ONLY: '' },
        encoding: 'utf8', timeout: 40_000,
      })
      const events = readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      const run = events.filter(event => event.kind === 'run').at(-1)
      return { ...result, events, control: run ? path.dirname(run.cidfile) : undefined, name: run?.name }
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true })
      if (mode === 'watchdog-pending-creation') {
        console.info(JSON.stringify({ severity: 'info', event: 'sandbox_pending_fixture_root_removed', root, present: existsSync(root) }))
      }
    },
    seedVolume(name: string, labels: Record<string, string>) {
      const volumes = JSON.parse(readFileSync(volumeState, 'utf8'))
      volumes[name] = { labels }
      writeFileSync(volumeState, JSON.stringify(volumes))
    },
    async joinPendingCreators() {
      // Join by captured birth identity before inspecting or removing fixture
      // state, including RED. No guest PID is ever used as host authority.
      capturePendingProcesses()
      for (const owned of ownedProcesses) {
        if (joinedProcesses.has(owned.pid)) continue
        const identity = () => {
          try {
            const fields = readFileSync(`/proc/${owned.pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')
            return fields[0] === 'Z' ? undefined : fields[19]
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
            throw cause
          }
        }
        await expect.poll(identity, { timeout: 10_000 }).not.toBe(owned.identity)
        joinedProcesses.add(owned.pid)
        console.info(JSON.stringify({ severity: 'info', event: 'sandbox_pending_fixture_process_joined', root, ...owned, identityNow: identity() ?? null }))
      }
      expect(ownedProcesses.map(owned => owned.role).sort()).toEqual(['creator', 'guard'])
    },
  }
}

describe('sandbox wrapper owned launch settlement', () => {
  it('settles a separate networked preparation before launching its strict caller', () => {
    const f = fixture('published-success')
    try {
      const result = f.run(true, true, true)
      expect(result.status, result.stderr).toBe(0)
      const runs = result.events.filter(event => event.kind === 'run')
      expect(runs).toHaveLength(2)
      expect(runs[0].name).not.toBe(runs[1].name)
      expect(runs[0].cidfile).not.toBe(runs[1].cidfile)
      const launches = result.events.filter(event => event.kind === 'docker' && event.args[0] === 'run')
      expect(launches[0].args).toContain('freshell-sandbox')
      expect(launches[0].args).not.toContain('--read-only')
      expect(launches[1].args).toContain('none')
      expect(launches[1].args).toContain('--read-only')
      const firstRemoval = result.events.findIndex(event => event.kind === 'docker' && event.args[0] === 'rm')
      const secondLaunch = result.events.findIndex(event => event.kind === 'run' && event.name === runs[1].name)
      expect(firstRemoval).toBeGreaterThan(-1)
      expect(secondLaunch).toBeGreaterThan(firstRemoval)
      for (const run of runs) expect(existsSync(path.dirname(run.cidfile))).toBe(false)
      expect(existsSync(f.state)).toBe(false)
    } finally { f.cleanup() }
  })

  it('settles failed preparation and refuses to launch the caller', () => {
    const f = fixture('published')
    try {
      const result = f.run(true, true, true)
      expect(result.status, result.stderr).toBe(37)
      expect(result.events.filter(event => event.kind === 'run')).toHaveLength(1)
      expect(existsSync(f.state)).toBe(false)
      expect(existsSync(result.control)).toBe(false)
    } finally { f.cleanup() }
  })

  it.each(['published', 'published-success'])('fails when the independent guard reports an error before %s completion', mode => {
    const f = fixture(mode)
    try {
      const guardPath = path.join(f.root, 'scripts/testing/sandbox-owner-guard.py')
      writeFileSync(guardPath, readFileSync(guardPath, 'utf8').replace(
        '    while identity(owner) == owner_identity:',
        '    raise RuntimeError("fixture guard failure")\n    while identity(owner) == owner_identity:',
      ))
      const result = f.run(true)
      expect(result.status, result.stderr).toBe(1)
      expect(result.stderr).toContain('sandbox_owner_guard_unsettled')
      expect(existsSync(f.state)).toBe(false)
      expect(readFileSync(f.foreign, 'utf8')).toBe('untouched')
    } finally { f.cleanup() }
  })
  it('preserves an ordinary successful workload after joining its successful guard', () => {
    const f = fixture('published-success')
    try {
      const result = f.run(true)
      expect(result.status, result.stderr).toBe(0)
      expect(existsSync(f.state)).toBe(false)
      expect(existsSync(result.control)).toBe(false)
      expect(readFileSync(f.foreign, 'utf8')).toBe('untouched')
    } finally { f.cleanup() }
  })
  it('settles its guard before returning an ordinary failure with unknown daemon state', () => {
    const f = fixture('query-failed')
    try {
      const result = f.run(true)
      expect(result.status, result.stderr).toBe(1)
      expect(existsSync(f.state)).toBe(true)
      expect(existsSync(path.join(result.control, 'owner-guard.done'))).toBe(true)
      expect(result.stderr).toContain('sandbox_owned_container_unsettled')
      expect(readFileSync(f.foreign, 'utf8')).toBe('untouched')
    } finally { f.cleanup() }
  })

  it('preserves an ordinary failed workload status after joining its guard', () => {
    const f = fixture('published')
    try {
      const result = f.run(true)
      expect(result.status, result.stderr).toBe(37)
      expect(existsSync(f.state)).toBe(false)
      expect(existsSync(result.control)).toBe(false)
      expect(readFileSync(f.foreign, 'utf8')).toBe('untouched')
    } finally { f.cleanup() }
  })

  it('retains unknown daemon evidence after the phase watchdog and settles the independent guard', async () => {
    const f = fixture('watchdog-query-failed')
    try {
      const result = await f.runTimeout()
      expect(result.status).toBe(125)
      const done = path.join(result.control, 'owner-guard.done')
      await expect.poll(() => existsSync(done), { timeout: 8_000 }).toBe(true)
      expect(JSON.parse(readFileSync(done, 'utf8'))).toMatchObject({ event: 'sandbox_owned_container_unsettled', code: 1 })
      const guard = JSON.parse(readFileSync(path.join(result.control, 'owner-guard.json'), 'utf8'))
      await expect.poll(() => existsSync(`/proc/${guard.pid}`), { timeout: 5_000 }).toBe(false)
      expect(existsSync(f.state)).toBe(true)
      expect(readFileSync(path.join(result.control, 'container.name'), 'utf8').trim()).toBe(result.name)
      expect(readFileSync(f.foreign, 'utf8')).toBe('untouched')
    } finally { f.cleanup() }
  })
  it.each(['watchdog-published', 'watchdog-unpublished'])('settles only its owned object after the actual phase watchdog kills %s', async mode => {
    const f = fixture(mode)
    try {
      const result = await f.runTimeout()
      expect(result.status).toBe(125)
      expect(JSON.parse(String(result.watchdogEvents[0][0]))).toMatchObject({ event: 'phase_watchdog_settled', reason: 'phase_timeout', timeoutMs: 600 })
      const deadline = Date.now() + 8_000
      while (existsSync(result.control) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
      expect(existsSync(f.state)).toBe(false)
      expect(existsSync(result.control)).toBe(false)
      expect(readFileSync(f.foreign, 'utf8')).toBe('untouched')
    } finally { f.cleanup() }
  })
  it('retains unknown creation evidence when a pending daemon publishes after watchdog cleanup queries', async () => {
    const f = fixture('watchdog-pending-creation')
    try {
      const result = await f.runTimeout()
      expect(result.status).toBe(125)
      expect(JSON.parse(String(result.watchdogEvents[0][0]))).toMatchObject({ event: 'phase_watchdog_settled', reason: 'phase_timeout', timeoutMs: 600 })
      await expect.poll(() => existsSync(path.join(f.root, 'creator.done')), { timeout: 10_000 }).toBe(true)
      await f.joinPendingCreators()
      const events = readFileSync(path.join(f.root, 'receipt.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      const published = events.findIndex(event => event.kind === 'pending-daemon-created')
      const queries = events.flatMap((event, index) => event.args?.[0] === 'ps' ? [index] : [])
      console.info(JSON.stringify({ severity: 'info', event: 'sandbox_pending_creation_proof', root: f.root,
        watchdog: JSON.parse(String(result.watchdogEvents[0][0])), queryIndices: queries, publicationIndex: published,
        objectPresent: existsSync(f.state), controlPresent: existsSync(result.control) }))
      expect(queries.length).toBe(2)
      expect(queries.every(index => index < published)).toBe(true)
      expect(existsSync(f.state)).toBe(true)
      expect(existsSync(result.control)).toBe(true)
      expect(JSON.parse(readFileSync(path.join(result.control, 'owner-guard.done'), 'utf8'))).toMatchObject({ event: 'sandbox_owned_container_unsettled', code: 1 })
      expect(readFileSync(path.join(result.control, 'owner-guard.log'), 'utf8')).toContain('sandbox_creation_unconfirmed')
      expect(readFileSync(path.join(result.control, 'container.name'), 'utf8').trim()).toBe(result.name)
      expect(readFileSync(f.foreign, 'utf8')).toBe('untouched')
    } finally {
      await f.joinPendingCreators()
      f.cleanup()
    }
  })
  it('removes an owned daemon object after failed launch without CID publication', () => {
    const f = fixture('failed-launch')
    try {
      const result = f.run()
      expect(result.status, result.stderr).toBe(42)
      expect(existsSync(f.state)).toBe(false)
      expect(existsSync(result.control)).toBe(false)
      expect(readFileSync(f.foreign, 'utf8')).toBe('untouched')
      expect(result.events.some(event => event.args?.includes(`name=^/${result.name}$`))).toBe(true)
    } finally { f.cleanup() }
  })

  it('joins a creation-time interrupted client before resolving its unpublished object', () => {
    const f = fixture('late-creation')
    try {
      const result = f.run()
      expect(result.status, result.stderr).toBe(143)
      expect(existsSync(f.state)).toBe(false)
      expect(existsSync(result.control)).toBe(false)
      const joined = result.events.findIndex(event => event.kind === 'creation-client-settled')
      const query = result.events.findIndex(event => event.args?.[0] === 'ps')
      expect(joined).toBeGreaterThan(-1)
      expect(query).toBeGreaterThan(joined)
      expect(readFileSync(f.foreign, 'utf8')).toBe('untouched')
    } finally { f.cleanup() }
  })

  it.each(['query-failed', 'remove-failed'])('retains actionable control evidence when %s leaves settlement unknown', mode => {
    const f = fixture(mode)
    try {
      const result = f.run()
      expect(result.status, result.stderr).toBe(1)
      expect(existsSync(f.state)).toBe(true)
      expect(existsSync(result.control)).toBe(true)
      expect(readFileSync(path.join(result.control, 'container.name'), 'utf8').trim()).toBe(result.name)
      expect(result.stderr).toContain('sandbox_owned_container_unsettled')
      expect(result.stderr).toContain(result.control)
      expect(readFileSync(f.foreign, 'utf8')).toBe('untouched')
    } finally { f.cleanup() }
  })

  it('preserves failed launch status after a successful exact-name absence query', () => {
    const f = fixture('no-object')
    try {
      const result = f.run()
      expect(result.status, result.stderr).toBe(42)
      expect(result.events.some(event => event.args?.includes(`name=^/${result.name}$`))).toBe(true)
      expect(existsSync(result.control)).toBe(false)
    } finally { f.cleanup() }
  })

  it.each(['published', 'removed-race'])('preserves ordinary nonzero status and settles %s CID paths', mode => {
    const f = fixture(mode)
    try {
      const result = f.run()
      expect(result.status, result.stderr).toBe(mode === 'published' ? 37 : 42)
      expect(existsSync(f.state)).toBe(false)
      expect(existsSync(result.control)).toBe(false)
      expect(readFileSync(f.foreign, 'utf8')).toBe('untouched')
    } finally { f.cleanup() }
  })
})

describe('sandbox wrapper target cache volumes', () => {
  it('uses a stable labeled volume for one worktree and a separate volume for another', () => {
    const firstWorktree = fixture('published-success')
    const secondWorktree = fixture('published-success')
    const digestFor = (root: string) => createHash('sha256').update(realpathSync(root)).digest('hex')
    const volumeFor = (root: string) => `freshell-sandbox-rust-target-v1-${digestFor(root).slice(0, 24)}`
    const lastRun = (events: Array<{ kind: string; args?: string[] }>) => events.filter(event => event.kind === 'docker' && event.args?.[0] === 'run').at(-1)!
    const cacheMounts = (event: { args?: string[] }, target: string) => {
      const args = event.args ?? []
      const index = args.findIndex((argument, position) => argument === '--mount' && args[position + 1]?.includes(`dst=${target}`))
      return index < 0 ? undefined : args[index + 1]
    }
    const volumeSource = (mount: string | undefined) => mount?.split(',').find(part => part.startsWith('src='))?.slice(4)
    const expectedLabels = (root: string) => [
      'volume-label=com.freshell.cache.owner=freshell',
      'volume-label=com.freshell.cache.purpose=rust-target',
      'volume-label=com.freshell.cache.schema=1',
      `volume-label=com.freshell.cache.worktree-sha256=${digestFor(root)}`,
    ]

    try {
      const ordinary = firstWorktree.run(false, false)
      expect(ordinary.status, ordinary.stderr).toBe(0)
      const ordinaryMount = cacheMounts(lastRun(ordinary.events), '/workspace/target')
      expect(volumeSource(ordinaryMount)).toBe(volumeFor(firstWorktree.root))
      expect(ordinaryMount?.split(',')).toEqual(expect.arrayContaining(expectedLabels(firstWorktree.root)))

      const runtime = firstWorktree.run()
      expect(runtime.status, runtime.stderr).toBe(0)
      const runtimeRun = lastRun(runtime.events)
      const runtimeTarget = cacheMounts(runtimeRun, '/workspace/target')
      const runtimeArtifacts = cacheMounts(runtimeRun, '/freshell-test-artifacts')
      expect(volumeSource(runtimeTarget)).toBe(volumeFor(firstWorktree.root))
      expect(volumeSource(runtimeArtifacts)).toBe(volumeFor(firstWorktree.root))
      expect(runtimeTarget?.split(',')).toEqual(expect.arrayContaining(expectedLabels(firstWorktree.root)))
      expect(runtimeArtifacts?.split(',')).toEqual(expect.arrayContaining(expectedLabels(firstWorktree.root)))

      const other = secondWorktree.run()
      expect(other.status, other.stderr).toBe(0)
      const otherTarget = cacheMounts(lastRun(other.events), '/workspace/target')
      expect(volumeSource(otherTarget)).toBe(volumeFor(secondWorktree.root))
      expect(volumeSource(otherTarget)).not.toBe(volumeSource(runtimeTarget))

      const firstVolumes = JSON.parse(readFileSync(firstWorktree.volumeState, 'utf8'))
      expect(firstVolumes[volumeFor(firstWorktree.root)].labels).toEqual({
        'com.freshell.cache.owner': 'freshell',
        'com.freshell.cache.purpose': 'rust-target',
        'com.freshell.cache.schema': '1',
        'com.freshell.cache.worktree-sha256': digestFor(firstWorktree.root),
      })
      expect(firstVolumes['freshell-sandbox-cargo-target'].labels).toEqual({ sentinel: 'legacy-volume' })
    } finally {
      firstWorktree.cleanup()
      secondWorktree.cleanup()
    }
  })

  it('refuses a deterministic volume with labels for another owner before launching Docker', () => {
    const f = fixture('published-success')
    const digest = createHash('sha256').update(realpathSync(f.root)).digest('hex')
    const volume = `freshell-sandbox-rust-target-v1-${digest.slice(0, 24)}`
    try {
      f.seedVolume(volume, {
        'com.freshell.cache.owner': 'someone-else',
        'com.freshell.cache.purpose': 'rust-target',
        'com.freshell.cache.schema': '1',
        'com.freshell.cache.worktree-sha256': digest,
      })
      const result = f.run()
      expect(result.status, result.stderr).toBe(1)
      expect(result.stderr).toContain('sandbox_target_cache_labels_mismatch')
      expect(result.events.some(event => event.kind === 'run')).toBe(false)
      expect(JSON.parse(readFileSync(f.volumeState, 'utf8'))[volume].labels['com.freshell.cache.owner']).toBe('someone-else')
    } finally { f.cleanup() }
  })

  it('preserves Docker volume-label errors without falling back to the legacy shared target', () => {
    const f = fixture('volume-label-unsupported')
    try {
      const result = f.run()
      const dockerRuns = result.events.filter(event => event.kind === 'docker' && event.args?.[0] === 'run')
      expect(result.status, result.stderr).toBe(125)
      expect(result.stderr).toContain('Docker daemon rejected the volume-label mount option')
      expect(dockerRuns).toHaveLength(1)
      expect(dockerRuns[0].args?.some(argument => argument.includes('dst=/workspace/target') && argument.includes('volume-label='))).toBe(true)
      expect(dockerRuns[0].args).not.toContain('-v freshell-sandbox-cargo-target:/workspace/target')
      expect(result.events.some(event => event.kind === 'run')).toBe(false)
    } finally { f.cleanup() }
  })

  it.each([
    ['volume-list-failed', 'sandbox_target_cache_list_failed'],
    ['volume-inspect-failed', 'sandbox_target_cache_inspect_failed'],
  ])('fails closed when Docker %s cannot establish existing volume metadata', (mode, event) => {
    const f = fixture(mode)
    const digest = createHash('sha256').update(realpathSync(f.root)).digest('hex')
    const volume = `freshell-sandbox-rust-target-v1-${digest.slice(0, 24)}`
    try {
      if (mode === 'volume-inspect-failed') {
        f.seedVolume(volume, {
          'com.freshell.cache.owner': 'freshell',
          'com.freshell.cache.purpose': 'rust-target',
          'com.freshell.cache.schema': '1',
          'com.freshell.cache.worktree-sha256': digest,
        })
      }
      const result = f.run()
      expect(result.status, result.stderr).toBe(1)
      expect(result.stderr).toContain(event)
      expect(result.events.some(event => event.kind === 'run')).toBe(false)
    } finally { f.cleanup() }
  })

  it('recreates a volume after a concurrent cleanup is confirmed by a second successful list', () => {
    const f = fixture('volume-disappears-on-inspect')
    const digest = createHash('sha256').update(realpathSync(f.root)).digest('hex')
    const volume = `freshell-sandbox-rust-target-v1-${digest.slice(0, 24)}`
    try {
      f.seedVolume(volume, {
        'com.freshell.cache.owner': 'freshell',
        'com.freshell.cache.purpose': 'rust-target',
        'com.freshell.cache.schema': '1',
        'com.freshell.cache.worktree-sha256': digest,
      })
      const result = f.run()
      expect(result.status, result.stderr).toBe(0)
      expect(result.events.some(event => event.kind === 'run')).toBe(true)
      expect(JSON.parse(readFileSync(f.volumeState, 'utf8'))[volume].labels['com.freshell.cache.worktree-sha256']).toBe(digest)
    } finally { f.cleanup() }
  })
})
