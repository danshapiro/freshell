// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'

const ownershipKeys = ['owner', 'purpose', 'schema', 'worktree-sha256'] as const
type Mode = 'available' | 'missing' | 'wrong-name' | typeof ownershipKeys[number]
const sha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex')

function fixture(mode: Mode) {
  const root = mkdtempSync(path.join(process.env.FRESHELL_TEST_EXECUTABLE_TMP_DIR ?? os.tmpdir(), 'codex-managed-cache-'))
  for (const file of [
    'scripts/testing/prepare-codex-contract.mjs', 'test/integration/providers/codex-managed-contract.mjs',
    'test/integration/providers/codex-cli-contract.mjs',
    'test/integration/providers/codex-local-provider.mjs', 'docker/runtime/codex-native-sandbox.json',
  ]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    copyFileSync(path.resolve(file), path.join(root, file))
  }
  const stage = path.join(root, '.runtime-build/codex-contract')
  const artifact = path.join(stage, 'artifact')
  for (const directory of ['bin', 'receipts', 'test/fixtures/coding-cli', '.runtime-build/codex-contract/artifact']) mkdirSync(path.join(root, directory), { recursive: true })
  // Tiny verified fixture bytes exercise preparation admission without staging
  // or claiming execution of the installed native Codex package.
  const members = [
    { path: 'codex', bytes: '#!/bin/sh\nexit 0\n', executable: true },
    { path: 'package.json', bytes: JSON.stringify({ name: '@fixture/codex', version: 'fixture-linux-x64', os: ['linux'], cpu: ['x64'] }), executable: false },
  ]
  const metadata = { version: '0.164.0', packageName: '@fixture/codex', packageVersion: 'fixture-linux-x64',
    platform: 'linux', arch: 'x64', integrity: 'fixture-only', executable: 'codex', fileCount: members.length,
    unpackedBytes: members.reduce((sum, file) => sum + Buffer.byteLength(file.bytes), 0) }
  writeFileSync(path.join(root, 'test/fixtures/coding-cli/codex-native-artifact.json'), JSON.stringify(metadata))
  for (const member of members) writeFileSync(path.join(artifact, member.path), member.bytes, { mode: member.executable ? 0o755 : 0o644 })
  writeFileSync(path.join(artifact, 'artifact-receipt.json'), JSON.stringify({ complete: true, ...metadata,
    files: members.map(file => ({ path: file.path, bytes: Buffer.byteLength(file.bytes), sha256: sha256(file.bytes), executable: file.executable })) }))
  const probe = '/freshell-test-artifacts/freshcodex-contract-00000000-0000-4000-8000-000000000000/policy-client-probe'
  writeFileSync(path.join(stage, 'staged.json'), JSON.stringify({ complete: true, policyClientProbe: { path: probe, sha256: 'a'.repeat(64) } }))
  const canonical = spawnSync('bash', ['-c', 'pwd -P'], { cwd: root, encoding: 'utf8', timeout: 10_000 })
  expect(canonical.status, canonical.stderr).toBe(0)
  const digest = sha256(canonical.stdout.trim())
  const volume = `freshell-sandbox-rust-target-v1-${digest.slice(0, 24)}`
  const labels = { 'com.freshell.cache.owner': 'freshell', 'com.freshell.cache.purpose': 'rust-target',
    'com.freshell.cache.schema': '1', 'com.freshell.cache.worktree-sha256': digest }
  const image = `sha256:${'b'.repeat(64)}`
  writeFileSync(path.join(root, 'bin/docker.mjs'), `
import fs from 'node:fs';
const args = process.argv.slice(2), root = ${JSON.stringify(root)}, volume = ${JSON.stringify(volume)}, labels = ${JSON.stringify(labels)}, mode = ${JSON.stringify(mode)};
fs.appendFileSync(root+'/docker.jsonl', JSON.stringify(args)+'\\n');
const stateFile = root+'/containers.json';
const containers = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile,'utf8')) : {};
const save = () => fs.writeFileSync(stateFile, JSON.stringify(containers));
if (args[0] === 'volume' && args[1] === 'inspect') {
  if (args[2] !== volume || mode === 'missing') { console.error('No such volume: '+args[2]); process.exit(1); }
  console.log(JSON.stringify([{ Name: mode === 'wrong-name' ? 'foreign-volume' : volume,
    Labels: { ...labels, ...(Object.hasOwn(labels, 'com.freshell.cache.'+mode) ? { ['com.freshell.cache.'+mode]: 'foreign' } : {}) } }]));
} else if (args[0] === 'create') {
  const name = args[args.indexOf('--name')+1], id = (name.endsWith('missing-helper') ? 'c' : 'd').repeat(64);
  containers[name] = { Id:id, Image:${JSON.stringify(image)}, Config: { User:'65534:0', Labels:{'org.freshell.codex-contract':args[args.indexOf('--label')+1].split('=')[1]} },
    HostConfig:{ReadonlyRootfs:true,CapDrop:['ALL'],NetworkMode:'none'}, args };
  save(); console.log(id);
} else if (args[0] === 'inspect') {
  const observed = containers[args[1]] ?? Object.values(containers).find(value => value.Id === args[1]);
  if (!observed) { console.error('No such object: '+args[1]); process.exit(1); }
  console.log(JSON.stringify([observed]));
} else if (args[0] === 'start') {
  const observed = Object.values(containers).find(value => value.Id === args.at(-1));
  if (observed.Id === 'c'.repeat(64)) { console.error('owned bwrap helper is missing'); process.exit(96); }
  console.log(JSON.stringify({nativeCapture:true,capture:{scenario:'text-history',parameters:{},passed:true,
    environment:{uid:65534,gid:0,managedLayout:{bwrap:'/fixture/bwrap'}},binary:{path:JSON.parse(fs.readFileSync(root+'/docker/runtime/codex-native-sandbox.json','utf8')).native.launchWrapper,version:'0.164.0'},
    requests:[],fixtureTraffic:[],observations:{executedSandboxHelpers:[{executable:'/fixture/bwrap'}]}}}));
} else if (args[0] === 'rm') {
  const name = Object.keys(containers).find(name => containers[name].Id === args.at(-1));
  if (!name) throw Error('unowned fixture removal');
  delete containers[name]; save();
} else throw Error('unexpected Docker mutation: '+JSON.stringify(args));
`)
  const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`
  writeFileSync(path.join(root, 'bin/docker'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, 'bin/docker.mjs'))} "$@"\n`)
  chmodSync(path.join(root, 'bin/docker'), 0o755)
  return {
    root, volume, labels, probe,
    run() {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { runManagedContract } from './test/integration/providers/codex-managed-contract.mjs';
         await runManagedContract({imageRef:${JSON.stringify(image)}}, './receipts', ${mode === 'available' ? '{scenario:"text-history",probeNetworkEnabled:true}' : '{scenario:"text-history"}'});`,
      ], { cwd: root, encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` } })
      const receipt = path.join(root, 'docker.jsonl')
      if (!existsSync(receipt)) throw new Error(`Docker fixture was not reached: ${result.error?.message ?? ''}\n${result.stderr}`)
      return { ...result, calls: readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) }
    },
    cleanup() { rmSync(root, { recursive: true, force: true }) },
  }
}

it('runs the managed consumer using the canonical labeled target with the legacy cache unavailable', () => {
  const f = fixture('available')
  try {
    const result = f.run()
    expect(result.status, result.stderr).toBe(0)
    expect(result.calls[0]).toEqual(['volume', 'inspect', f.volume])
    expect(result.calls.flat()).not.toContain('freshell-sandbox-cargo-target')
    const creates = result.calls.filter(args => args[0] === 'create')
    expect(creates).toHaveLength(2)
    for (const args of creates) {
      const mounts = args.flatMap((word, index) => word === '--mount' ? [args[index + 1]] : [])
      const cacheMount = mounts.find(mount => mount.includes('target=/freshell-test-artifacts'))!
      expect(cacheMount.split(',')).toEqual(expect.arrayContaining([
        'type=volume', `source=${f.volume}`, 'target=/freshell-test-artifacts', 'readonly',
        ...Object.entries(f.labels).map(([key, value]) => `volume-label=${key}=${value}`),
      ]))
      for (const [flag, value] of [['--user', '65534:0'], ['--network', 'none'], ['--cap-drop', 'ALL'], ['--pids-limit', '512'], ['--memory', '1g'], ['--cpus', '2']]) expect(args[args.indexOf(flag) + 1]).toBe(value)
      expect(args).toContain('--read-only')
      expect(args).toContain('no-new-privileges')
      expect(args).toContain('seccomp=receipts/codex-policy.json')
      expect(args).toContain(`FRESHELL_CODEX_POLICY_CLIENT_PROBE=${f.probe}`)
    }
    expect(JSON.parse(readFileSync(path.join(f.root, 'containers.json'), 'utf8'))).toEqual({})
    const receipts = JSON.parse(readFileSync(path.join(f.root, 'receipts/receipt-index.json'), 'utf8'))
    expect(receipts.captures).toHaveLength(1)
    expect(receipts.captures[0]).toMatchObject({ scenario: 'text-history', passed: true, uid: 65534, gid: 0 })
  } finally { f.cleanup() }
})

it.each(['missing', 'wrong-name', ...ownershipKeys] as const)('refuses a %s cache before any managed container or image mutation', mode => {
  const f = fixture(mode)
  try {
    const result = f.run()
    expect(result.status).not.toBe(0)
    expect(result.calls).toEqual([['volume', 'inspect', f.volume]])
    if (mode !== 'missing') expect(result.stderr).toContain('sandbox target cache ownership labels do not match')
  } finally { f.cleanup() }
})

it('refuses a missing real-client probe before the native harness starts work', () => {
  const f = fixture('available')
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { captureNativeScenario } from './test/integration/providers/codex-cli-contract.mjs';
      await assert.rejects(captureNativeScenario('text-history', {
        artifactRoot: './.runtime-build/codex-contract/artifact', policyClientProbe: '/freshell-missing-policy-client-probe',
      }), error => error.code === 'ENOENT' && error.path === '/freshell-missing-policy-client-probe');
      console.log('codex_missing_policy_probe_refused');
    `], { cwd: f.root, encoding: 'utf8', timeout: 30_000 })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('codex_missing_policy_probe_refused')
    expect(readdirSync(path.join(f.root, 'receipts'))).toEqual([])
    expect(existsSync(path.join(f.root, 'docker.jsonl'))).toBe(false)
  } finally { f.cleanup() }
})
