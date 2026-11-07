// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'

if (process.env.FRESHELL_SANDBOX_MODE !== 'runtime-suite') {
  throw new Error('Sandbox cache selftest fixtures require the disposable runtime sandbox')
}

it.each([
  ['scripts/sandbox-cache-selftest.sh', 'sandbox_cache_selftest_runtime_alias_failed', 1],
  ['scripts/test/sandbox-runtime-startup.test.sh', 'PASS: a cache prefix cannot become a host bind mount', 91],
] as const)('reaches the strict runtime launch in %s', (script, previousProof, expectedStatus) => {
  const root = mkdtempSync(path.join(process.env.FRESHELL_TEST_EXECUTABLE_TMP_DIR!, 'cache-selftest-route-'))
  const bin = path.join(root, 'bin')
  const marker = path.join(root, 'strict-runtime-started')
  mkdirSync(bin)
  const fakeDocker = path.join(bin, 'docker.cjs')
  writeFileSync(fakeDocker, `
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === 'container' && args[1] === 'inspect') process.exit(1)
if (args[0] === 'run') {
  const index = args.indexOf('--cidfile')
  if (index >= 0) fs.writeFileSync(args[index + 1], 'a'.repeat(64))
  if (index >= 0 && args[args.indexOf('--network') + 1] === 'none') {
    fs.writeFileSync(process.env.CACHE_SELFTEST_RUNTIME_MARKER, 'reached')
    process.exit(91)
  }
  if (args.includes('--entrypoint') && args[args.indexOf('--entrypoint') + 1] === 'stat') {
    console.log(process.getuid() + ':' + process.getgid())
  }
  if (args.at(-1) === '-s' && !args.includes('--read-only')) {
    console.error('FAIL: sandbox root filesystem is writable')
    process.exit(1)
  }
}
process.exit(0)
`)
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const docker = path.join(bin, 'docker')
  writeFileSync(docker, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fakeDocker)} "$@"\n`)
  chmodSync(docker, 0o755)
  try {
    const result = spawnSync('bash', [script], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: root,
        FRESHELL_SANDBOX_DEPENDENCIES_READY: '', CACHE_SELFTEST_RUNTIME_MARKER: marker },
      encoding: 'utf8', timeout: 60_000,
    })
    // The fake deliberately stops the strict workload once it is reached;
    // no real Docker daemon or Cargo process is involved.
    expect(`${result.stdout}\n${result.stderr}`).toContain(previousProof)
    expect(existsSync(marker), result.stderr).toBe(true)
    expect(result.status, result.stderr).toBe(expectedStatus)
  } finally {
    if (existsSync(root)) rmSync(root, { recursive: true })
  }
}, 70_000)
