// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// These fixtures exercise creation-time signals and Docker cleanup. Run them
// through scripts/sandbox-test.sh --runtime-suite, never directly on the host.
if (process.env.FRESHELL_SANDBOX_MODE !== 'runtime-suite') {
  throw new Error('Sandbox wrapper fixtures require scripts/sandbox-test.sh --runtime-suite and sandbox-test.config.ts')
}

function fixture(mode: string) {
  const root = mkdtempSync(path.join(process.env.FRESHELL_TEST_EXECUTABLE_TMP_DIR ?? os.tmpdir(), 'sandbox-wrapper-'))
  for (const subdir of ['scripts', 'bin', 'control']) mkdirSync(path.join(root, subdir))
  copyFileSync(path.resolve('scripts/sandbox-test.sh'), path.join(root, 'scripts/sandbox-test.sh'))
  const receipt = path.join(root, 'receipt.jsonl')
  const state = path.join(root, 'owned-object.json')
  const foreign = path.join(root, 'foreign-object')
  writeFileSync(foreign, 'untouched')
  writeFileSync(path.join(root, 'bin/docker.mjs'), String.raw`
    import fs from 'node:fs';
    const args = process.argv.slice(2), mode = process.env.FIXTURE_MODE;
    const state = process.env.FIXTURE_STATE;
    const cid = 'a'.repeat(64);
    const record = event => fs.appendFileSync(process.env.FIXTURE_RECEIPT, JSON.stringify(event)+'\n');
    const object = () => fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : null;
    record({kind:'docker', args});
    if (args[0] === 'image') process.exit(0);
    if (args[0] === 'run') {
      const name = args[args.indexOf('--name')+1], cidfile = args[args.indexOf('--cidfile')+1];
      record({kind:'run', name, cidfile});
      if (mode !== 'no-object' && mode !== 'late-creation') fs.writeFileSync(state, JSON.stringify({cid, name}));
      if (mode === 'published' || mode === 'removed-race') fs.writeFileSync(cidfile, cid);
      if (mode === 'removed-race') fs.unlinkSync(state);
      if (mode === 'late-creation') {
        process.kill(process.ppid, 'SIGTERM');
        setTimeout(() => {
          fs.writeFileSync(state, JSON.stringify({cid, name}));
          record({kind:'creation-client-settled'});
          process.exit(0);
        }, 150);
      } else process.exit(mode === 'published' ? 37 : 42);
    } else if (args[0] === 'ps') {
      if (mode === 'query-failed') process.exit(71);
      const current = object(), filter = args[args.indexOf('--filter')+1];
      if (current && (filter === 'id='+cid || filter === 'name=^/'+current.name+'$')) console.log(cid);
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
    root, state, foreign,
    run() {
      const result = spawnSync('bash', [path.join(root, 'scripts/sandbox-test.sh'), '--runtime-suite', 'true'], {
        env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, TMPDIR: path.join(root, 'control'),
          FIXTURE_MODE: mode, FIXTURE_STATE: state, FIXTURE_RECEIPT: receipt },
        encoding: 'utf8', timeout: 40_000,
      })
      const events = readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      const run = events.find(event => event.kind === 'run')
      return { ...result, events, control: path.dirname(run.cidfile), name: run.name }
    },
    cleanup() { rmSync(root, { recursive: true, force: true }) },
  }
}

describe('sandbox wrapper owned launch settlement', () => {
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
