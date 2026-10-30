// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'

function fixture(mode: 'available' | 'missing' | 'foreign') {
  const root = mkdtempSync(path.join(process.env.FRESHELL_TEST_EXECUTABLE_TMP_DIR ?? os.tmpdir(), 'codex-sandbox-cache-'))
  for (const file of [
    'scripts/sandbox-test.sh', 'scripts/testing/prepare-codex-contract.mjs',
    'test/integration/providers/codex-local-provider.mjs',
    'test/fixtures/coding-cli/codex-native-artifact.json', 'docker/runtime/codex-native-sandbox.json',
  ]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    copyFileSync(path.resolve(file), path.join(root, file))
  }
  for (const directory of ['bin', 'control', '.runtime-build/codex-contract']) mkdirSync(path.join(root, directory), { recursive: true })
  const policy = spawnSync(process.execPath, ['--input-type=module', '-e',
    'import { nativeSandboxPolicy } from "./scripts/testing/prepare-codex-contract.mjs"; process.stdout.write(nativeSandboxPolicy().json)',
  ], { cwd: root, encoding: 'utf8', timeout: 10_000 })
  expect(policy.status, policy.stderr).toBe(0)
  writeFileSync(path.join(root, '.runtime-build/codex-contract/codex-policy.json'), policy.stdout)
  const image = `sha256:${'b'.repeat(64)}`
  writeFileSync(path.join(root, '.runtime-build/codex-contract/staged.json'), JSON.stringify({
    image, uid: 1000, gid: 1000, nativeSandboxPolicy: { profileSha256: `sha256:${createHash('sha256').update(policy.stdout).digest('hex')}` },
  }))
  const canonical = spawnSync('bash', ['-c', 'pwd -P'], { cwd: root, encoding: 'utf8', timeout: 10_000 })
  expect(canonical.status, canonical.stderr).toBe(0)
  const digest = createHash('sha256').update(canonical.stdout.trim()).digest('hex')
  const volume = `freshell-sandbox-rust-target-v1-${digest.slice(0, 24)}`
  const labels = { 'com.freshell.cache.owner': 'freshell', 'com.freshell.cache.purpose': 'rust-target',
    'com.freshell.cache.schema': '1', 'com.freshell.cache.worktree-sha256': digest }
  writeFileSync(path.join(root, 'bin/docker.mjs'), `
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_RECEIPT, JSON.stringify(args)+'\\n');
const volume = ${JSON.stringify(volume)}, labels = ${JSON.stringify(labels)}, mode = ${JSON.stringify(mode)};
if (args[0] === 'image' && args[1] === 'inspect') console.log(${JSON.stringify(image)});
else if (args[0] === 'volume' && args[1] === 'inspect') {
  const name = args.at(-1);
  if (name === 'freshell-sandbox-cargo-target' || (name === volume && mode === 'missing')) {
    console.error('missing target cache: '+name); process.exit(1);
  }
  const observed = name === volume ? { ...labels, ...(mode === 'foreign' ? {'com.freshell.cache.owner':'someone-else'} : {}) } : {};
  console.log(JSON.stringify(args.includes('--format') ? observed : [{ Name: name, Labels: observed }]));
} else if (args[0] === 'volume' && args[1] === 'ls') console.log(volume);
else if (args[0] === 'run') console.log(JSON.stringify({verified:true}));
else if (args[0] !== 'ps') process.exit(2);
`)
  const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`
  writeFileSync(path.join(root, 'bin/docker'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, 'bin/docker.mjs'))} "$@"\n`)
  chmodSync(path.join(root, 'bin/docker'), 0o755)
  const receipt = path.join(root, 'docker.jsonl')
  return {
    root, volume, labels,
    run(wrapper = false) {
      const result = spawnSync(wrapper ? 'bash' : process.execPath, wrapper
        ? ['scripts/sandbox-test.sh', '--runtime-suite', 'node test/integration/providers/codex-cli-contract.mjs --scenario text-history --missing-policy-client-probe']
        : ['scripts/testing/prepare-codex-contract.mjs', '--verify-sandbox'], {
        cwd: root, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, FIXTURE_RECEIPT: receipt,
          TMPDIR: path.join(root, 'control'), FRESHELL_SANDBOX_OWNER_GUARD: '0' },
      })
      if (!existsSync(receipt)) throw new Error(`Docker fixture was not reached: ${result.error?.message ?? ''}\n${result.stderr}`)
      return { ...result, calls: readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) }
    },
    cleanup() { rmSync(root, { recursive: true, force: true }) },
  }
}

it('verifies native prerequisites in the canonical per-worktree target mounted by the runtime', () => {
  const f = fixture('available')
  try {
    const result = f.run()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ verified: true })
    expect(result.calls).toContainEqual(['volume', 'inspect', f.volume])
    const verifier = result.calls.find(args => args[0] === 'run')!
    expect(verifier).toContain(`${f.volume}:/freshell-test-artifacts:ro`)
    expect(verifier).toContain('--read-only')
    expect(verifier.slice(verifier.indexOf('--network'), verifier.indexOf('--network') + 2)).toEqual(['--network', 'none'])
    expect(result.calls.flat()).not.toContain('freshell-sandbox-cargo-target')
  } finally { f.cleanup() }
})

it.each(['missing', 'foreign'] as const)('refuses %s native target prerequisites before launching any container', mode => {
  const f = fixture(mode)
  try {
    const result = f.run(true)
    expect(result.status).not.toBe(0)
    expect(result.calls).toContainEqual(['volume', 'inspect', f.volume])
    expect(result.calls.some(args => args[0] === 'run' || args.slice(0, 2).join(' ') === 'volume ls')).toBe(false)
    if (mode === 'foreign') expect(result.stderr).toContain('sandbox target cache ownership labels do not match')
  } finally { f.cleanup() }
})

it('dispatches a verified native contract with both its seccomp policy and labeled per-worktree cache', () => {
  const f = fixture('available')
  try {
    const result = f.run(true)
    expect(result.status, result.stderr).toBe(0)
    const runs = result.calls.filter(args => args[0] === 'run')
    expect(runs).toHaveLength(2)
    const runtime = runs[1]
    expect(runtime).toContain(`seccomp=${f.root}/.runtime-build/codex-contract/codex-policy.json`)
    expect(runtime).toContain('FRESHELL_CODEX_CONTRACT_POLICY=prepared')
    for (const destination of ['/workspace/target', '/freshell-test-artifacts']) {
      expect(runtime).toContain(`type=volume,src=${f.volume},dst=${destination},${Object.entries(f.labels).map(([key, value]) => `volume-label=${key}=${value}`).join(',')}`)
    }
  } finally { f.cleanup() }
})
