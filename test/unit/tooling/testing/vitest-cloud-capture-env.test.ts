// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function runCloudVitestWrapper(captureEnabled: boolean): string {
  const tempRoot = path.resolve('.test-tmp')
  mkdirSync(tempRoot, { recursive: true })
  const root = mkdtempSync(path.join(tempRoot, 'vitest-cloud-capture-env-'))
  fixtureRoots.push(root)
  const bin = path.join(root, 'bin')
  const log = path.join(root, 'gcloud.log')
  mkdirSync(bin)

  const fakeGcloud = path.join(bin, 'gcloud')
  writeFileSync(fakeGcloud, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GCLOUD_LOG"
if [[ "$*" == *"auth print-access-token"* ]]; then echo fake-token; exit 0; fi
if [[ "$*" == *"info"* ]]; then echo /usr/lib/google-cloud-sdk; exit 0; fi
if [[ "$*" == *"run jobs execute"* ]]; then echo 'Execution [capture-test] has successfully completed.'; exit 0; fi
if [[ "$*" == *"logs read"* ]]; then echo 'Test Files  1 passed (1)'; exit 0; fi
if [[ "$*" == *"executions describe"* ]]; then
  if [[ "$*" == *"succeededCount"* ]]; then echo 1; else echo 0; fi
  exit 0
fi
exit 0
`)
  chmodSync(fakeGcloud, 0o755)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FRESHELL_GCP_ACCOUNT: 'capture-test@example.invalid',
    GCLOUD_ROBOT_REQUIRE: '',
    FAKE_GCLOUD_LOG: log,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
  }
  delete env.GCLOUD_IDENT
  delete env.GCLOUD_ROBOT_ACCOUNT
  if (captureEnabled) env.FRESHELL_CODEX_CONTRACT_CAPTURE_STDOUT = '1'
  else delete env.FRESHELL_CODEX_CONTRACT_CAPTURE_STDOUT

  const wrapper = path.resolve('scripts/vitest-cloud.sh')
  const result = spawnSync('bash', [wrapper, 'run', '--cloud', '--shards=1'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Cloud wrapper exited ${result.status}: ${result.stdout}\n${result.stderr}`)
  }

  return readFileSync(log, 'utf8').split('\n').find(line => line.includes('run jobs execute')) ?? ''
}

describe('Cloud Vitest capture environment', () => {
  it('forwards the native Codex capture opt-in only when requested', () => {
    const enabledArgs = runCloudVitestWrapper(true)
    expect(enabledArgs).toContain('FRESHELL_CODEX_CONTRACT_CAPTURE_STDOUT=1')

    const disabledArgs = runCloudVitestWrapper(false)
    expect(disabledArgs).not.toContain('FRESHELL_CODEX_CONTRACT_CAPTURE_STDOUT')
  })
})
