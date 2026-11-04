// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'

function fixture(mode: 'available' | 'missing' | 'foreign' | 'stale-policy' | 'legacy-protocol' | 'stale-base' | 'wrong-derived') {
  const root = mkdtempSync(path.join(process.env.FRESHELL_TEST_EXECUTABLE_TMP_DIR ?? os.tmpdir(), 'codex-sandbox-cache-'))
  const gitInit = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8', timeout: 10_000 })
  expect(gitInit.status, gitInit.stderr).toBe(0)
  for (const file of [
    'scripts/sandbox-test.sh', 'scripts/testing/prepare-codex-contract.mjs', 'docker/sandbox/protocol.json', 'docker/sandbox/dependency-cache.mjs',
    'test/integration/providers/codex-local-provider.mjs',
    'test/fixtures/coding-cli/codex-native-artifact.json', 'docker/runtime/codex-native-sandbox.json',
  ]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    copyFileSync(path.resolve(file), path.join(root, file))
  }
  for (const directory of ['bin', 'control', '.runtime-build/codex-contract']) mkdirSync(path.join(root, directory), { recursive: true })
  const policy = spawnSync(process.execPath, ['--input-type=module', '-e',
    'import { nativeSandboxPolicy } from "./scripts/testing/prepare-codex-contract.mjs"; import { CODEX_NETWORK_REQUIREMENTS } from "./test/integration/providers/codex-local-provider.mjs"; import { createHash } from "node:crypto"; process.stdout.write(JSON.stringify({json:nativeSandboxPolicy().json,requirementsSha256:createHash("sha256").update(CODEX_NETWORK_REQUIREMENTS).digest("hex")}))',
  ], { cwd: root, encoding: 'utf8', timeout: 10_000 })
  expect(policy.status, policy.stderr).toBe(0)
  const preparedPolicy = JSON.parse(policy.stdout)
  writeFileSync(path.join(root, '.runtime-build/codex-contract/codex-policy.json'), preparedPolicy.json)
  const baseImage = `sha256:${'a'.repeat(64)}`
  const image = `sha256:${'b'.repeat(64)}`
  const owner = 'freshcodex-contract-11111111-1111-1111-1111-111111111111'
  writeFileSync(path.join(root, '.runtime-build/codex-contract/staged.json'), JSON.stringify({
    image, baseImage, subdir: owner, contractImage: { requirementsSha256: preparedPolicy.requirementsSha256 },
    fingerprint: 'f'.repeat(64), uid: 1000, gid: 1000, nativeSandboxPolicy: { profileSha256: mode === 'stale-policy' ? `sha256:${'0'.repeat(64)}` : `sha256:${createHash('sha256').update(preparedPolicy.json).digest('hex')}` },
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
if (args[0] === 'image' && args[1] === 'inspect') {
  if (!args.includes('--format')) console.log(JSON.stringify([{Id: mode === 'wrong-derived' ? 'sha256:'+'d'.repeat(64) : ${JSON.stringify(image)}, Config:{Labels:{'org.freshell.codex-contract-owner':${JSON.stringify(owner)}}}}]));
  else if (args.at(-1).includes('dependency-protocol')) console.log(mode === 'legacy-protocol' ? '1' : '2');
  else if (args.at(-1).includes('dependency-foundation')) console.log('sha256:'+'c'.repeat(64));
  else console.log(args[2] === 'freshell-sandbox:dependencies-v2' || args[2] === ${JSON.stringify(baseImage)} ? (mode === 'stale-base' ? 'sha256:'+'e'.repeat(64) : ${JSON.stringify(baseImage)}) : ${JSON.stringify(image)});
}
else if (args[0] === 'volume' && args[1] === 'inspect') {
  const name = args.at(-1);
  if (name === 'freshell-sandbox-cargo-target' || (name === volume && mode === 'missing')) {
    console.error('missing target cache: '+name); process.exit(1);
  }
  const observed = name === volume ? { ...labels, ...(mode === 'foreign' ? {'com.freshell.cache.owner':'someone-else'} : {}) } : {};
  console.log(JSON.stringify(args.includes('--format') ? observed : [{ Name: name, Labels: observed }]));
} else if (args[0] === 'volume' && args[1] === 'ls') console.log(volume);
else if (args[0] === 'network' && args[1] === 'inspect' && args[2] === 'freshell-sandbox') console.log('[]');
else if (args[0] === 'run') console.log(JSON.stringify({verified:true,manifest:{baseImage:${JSON.stringify(baseImage)},image:${JSON.stringify(image)}}}));
else if (args[0] !== 'ps') process.exit(2);
`)
  const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`
  writeFileSync(path.join(root, 'bin/docker'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, 'bin/docker.mjs'))} "$@"\n`)
  chmodSync(path.join(root, 'bin/docker'), 0o755)
  const receipt = path.join(root, 'docker.jsonl')
  return {
    root, volume, labels, image, baseImage,
    run(wrapper = false, command = 'node test/integration/providers/codex-cli-contract.mjs --scenario text-history --missing-policy-client-probe', selectedImage?: string) {
      const result = spawnSync(wrapper ? 'bash' : process.execPath, wrapper
        ? ['scripts/sandbox-test.sh', '--runtime-suite', command]
        : ['scripts/testing/prepare-codex-contract.mjs', '--verify-sandbox'], {
        cwd: root, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, FIXTURE_RECEIPT: receipt,
          FRESHELL_SANDBOX_IMAGE: 'freshell-sandbox:dependencies-v2', FRESHELL_SANDBOX_SELECTED_IMAGE: selectedImage,
          FRESHELL_SANDBOX_SELECTED_DEPENDENCY_KEY: undefined,
          TMPDIR: path.join(root, 'control'), FRESHELL_SANDBOX_OWNER_GUARD: '0' },
      })
      if (!existsSync(receipt)) {
        if (mode !== 'stale-policy') throw new Error(`Docker fixture was not reached: ${result.error?.message ?? ''}\n${result.stderr}`)
        return { ...result, calls: [] }
      }
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
    expect(JSON.parse(result.stdout)).toEqual({ verified: true, manifest: { baseImage: f.baseImage, image: f.image } })
    expect(result.calls).toContainEqual(['volume', 'inspect', f.volume])
    const verifier = result.calls.find(args => args[0] === 'run')!
    expect(verifier.slice(verifier.indexOf('--entrypoint'), verifier.indexOf('--entrypoint') + 2))
      .toEqual(['--entrypoint', 'node'])
    expect(verifier.some(arg => /^freshell-sandbox-dependencies-v2-[a-f0-9]{64}-node-modules:\/workspace\/node_modules:ro$/.test(arg))).toBe(true)
    expect(verifier.some(arg => /^FRESHELL_SANDBOX_DEPENDENCY_KEY=[a-f0-9]{64}$/.test(arg))).toBe(true)
    expect(verifier).toContain(`${f.volume}:/freshell-test-artifacts:ro`)
    expect(verifier).toContain('--read-only')
    expect(verifier.slice(verifier.indexOf('--network'), verifier.indexOf('--network') + 2)).toEqual(['--network', 'none'])
    expect(result.calls.flat()).not.toContain('freshell-sandbox-cargo-target')
  } finally { f.cleanup() }
})

it('refuses a custom image without the dependency lifetime protocol before mounting protected caches', () => {
  const f = fixture('legacy-protocol')
  try {
    const result = f.run(true)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('sandbox dependency protocol changed; reprepare the contract image')
    expect(result.calls.some(args => args[0] === 'run')).toBe(false)
  } finally { f.cleanup() }
})

it.each(['stale-base', 'wrong-derived'] as const)('refuses %s qualification before launching a verifier or caller', mode => {
  const f = fixture(mode)
  try {
    const result = f.run(true)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(mode === 'stale-base' ? 'sandbox image changed since connected warmup' : 'owned Codex test image or system prerequisites changed')
    expect(result.calls.some(args => args[0] === 'run')).toBe(false)
  } finally { f.cleanup() }
})

it('refuses a phase workload pin that differs from the qualified contract image', () => {
  const f = fixture('available')
  try {
    const result = f.run(true, undefined, f.baseImage)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('sandbox_contract_image_mismatch')
    expect(result.calls.filter(args => args[0] === 'run').every(args => args.includes('--verify-prepared'))).toBe(true)
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
    expect(runs).toHaveLength(4)
    expect(runs.filter(args => args.includes('--verify-prepared'))).toHaveLength(2)
    const preparation = runs.find(args => args.at(-1) === 'if [ -f Cargo.lock ]; then cargo fetch --locked; fi')!
    expect(preparation).toBeDefined()
    expect(preparation.slice(preparation.indexOf('--network'), preparation.indexOf('--network') + 2)).toEqual(['--network', 'freshell-sandbox'])
    const workloads = runs.filter(args => args.includes('FRESHELL_SANDBOX_MODE=runtime-suite'))
    expect(workloads).toHaveLength(1)
    const runtime = workloads[0]
    expect(runtime).toContain(`seccomp=${f.root}/.runtime-build/codex-contract/codex-policy.json`)
    expect(runtime).toContain('FRESHELL_CODEX_CONTRACT_POLICY=prepared')
    for (const destination of ['/workspace/target', '/freshell-test-artifacts']) {
      expect(runtime).toContain(`type=volume,src=${f.volume},dst=${destination},${Object.entries(f.labels).map(([key, value]) => `volume-label=${key}=${value}`).join(',')}`)
    }
  } finally { f.cleanup() }
})

const codexVitestSelector = 'pnpm run test:vitest run test/integration/providers/codex-cli-contract.test.ts --config config/vitest/vitest.config.ts'

it('dispatches the exact Codex Vitest selector through its verified seccomp contract', () => {
  const f = fixture('available')
  try {
    const result = f.run(true, codexVitestSelector)
    expect(result.status, result.stderr).toBe(0)
    const runs = result.calls.filter(args => args[0] === 'run')
    expect(runs.filter(args => args.includes('--verify-prepared'))).toHaveLength(2)
    const runtime = runs.find(args => args.includes('FRESHELL_SANDBOX_MODE=runtime-suite'))!
    expect(runtime).toContain(f.image)
    expect(runtime.at(-1)).toBe(codexVitestSelector)
    expect(runtime).toContain(`seccomp=${f.root}/.runtime-build/codex-contract/codex-policy.json`)
    expect(runtime).toContain('FRESHELL_CODEX_CONTRACT_POLICY=prepared')
  } finally { f.cleanup() }
})

it('keeps a neighboring Codex Vitest selector on the default sandbox policy', () => {
  const f = fixture('available')
  const neighboringSelector = `${codexVitestSelector} --testNamePattern=approval`
  try {
    const result = f.run(true, neighboringSelector)
    expect(result.status, result.stderr).toBe(0)
    const runs = result.calls.filter(args => args[0] === 'run')
    const runtime = runs.find(args => args.includes('FRESHELL_SANDBOX_MODE=runtime-suite'))!
    expect(runtime).toContain(f.baseImage)
    expect(result.calls.some(args => args[0] === 'image' && args.includes('freshell-sandbox:dependencies-v2'))).toBe(true)
    expect(runtime.at(-1)).toBe(neighboringSelector)
    expect(runtime.some(argument => argument.startsWith('seccomp='))).toBe(false)
    expect(runtime).not.toContain('FRESHELL_CODEX_CONTRACT_POLICY=prepared')
    expect(runs.some(args => args.includes('--verify-prepared'))).toBe(false)
  } finally { f.cleanup() }
})

it('stops the exact Codex Vitest selector when stage verification fails', () => {
  const f = fixture('stale-policy')
  try {
    const result = f.run(true, codexVitestSelector)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('prepared Codex native policy is absent or stale')
    expect(result.calls).toEqual([])
  } finally { f.cleanup() }
})
