// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const fixtureRoots: string[] = []
const captureEnvironmentKey = 'FRESHELL_CODEX_CONTRACT_CAPTURE_STDOUT'
const captureEnvironmentAssignment = `${captureEnvironmentKey}=1`

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function getUpdateEnvVarsValue(args: string[]): string | undefined {
  const flag = '--update-env-vars'
  const flagIndex = args.findIndex(argument => argument === flag || argument.startsWith(`${flag}=`))
  if (flagIndex < 0) return undefined

  const flagArgument = args[flagIndex]
  return flagArgument === flag ? args[flagIndex + 1] : flagArgument.slice(flag.length + 1)
}

function parseEnvironmentAssignments(value: string): string[] {
  let delimiter = ','
  let assignments = value
  if (value.startsWith('^')) {
    const prefix = value.match(/^\^([^^]+)\^/)
    if (!prefix) throw new Error('Malformed custom environment delimiter prefix')
    delimiter = prefix[1]
    assignments = value.slice(prefix[0].length)
  }
  return assignments.split(delimiter)
}

function getEnvironmentAssignmentsForKey(entries: string[], key: string): string[] {
  return entries.filter(entry => {
    const separatorIndex = entry.indexOf('=')
    return separatorIndex >= 0 && entry.slice(0, separatorIndex) === key
  })
}

function runCloudVitestWrapper(captureEnabled: boolean): string[] {
  const tempRoot = path.resolve('.test-tmp')
  mkdirSync(tempRoot, { recursive: true })
  const root = mkdtempSync(path.join(tempRoot, 'vitest-cloud-capture-env-'))
  fixtureRoots.push(root)
  const bin = path.join(root, 'bin')
  const log = path.join(root, 'gcloud.log')
  mkdirSync(bin)
  writeFileSync(log, '')

  const fakeGcloud = path.join(bin, 'gcloud')
  writeFileSync(fakeGcloud, `#!/usr/bin/env bash
if [[ "$*" == *"auth print-access-token"* ]]; then echo fake-token; exit 0; fi
if [[ "$*" == *"info"* ]]; then echo /usr/lib/google-cloud-sdk; exit 0; fi
if [[ "$1" == "run" && "$2" == "jobs" && "$3" == "execute" ]]; then
  printf '%s\\0' "$@" >> "$FAKE_GCLOUD_LOG"
  echo 'Execution [capture-test] has successfully completed.'
  exit 0
fi
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

  const args = readFileSync(log, 'utf8').split('\0')
  if (args.at(-1) === '') args.pop()
  return args
}

describe('Cloud Vitest capture environment', () => {
  it('parses comma-delimited env map entries', () => {
    expect(parseEnvironmentAssignments('TEST_MODE=vitest,VITEST_CONFIGS=default')).toEqual([
      'TEST_MODE=vitest',
      'VITEST_CONFIGS=default',
    ])
  })

  it('derives custom delimiters and keeps embedded assignment text in its value', () => {
    const embeddedValue = `^|^TEST_MODE=vitest|VITEST_ARGS_JSON=["test/file","${captureEnvironmentAssignment}"]`
    const entries = parseEnvironmentAssignments(embeddedValue)

    expect(entries).toEqual([
      'TEST_MODE=vitest',
      `VITEST_ARGS_JSON=["test/file","${captureEnvironmentAssignment}"]`,
    ])
    expect(getEnvironmentAssignmentsForKey(entries, captureEnvironmentKey)).toEqual([])
  })

  it('forwards the native Codex capture opt-in only when requested', () => {
    const enabledArgs = runCloudVitestWrapper(true)
    const enabledUpdateEnvVars = getUpdateEnvVarsValue(enabledArgs)
    expect(enabledUpdateEnvVars).toBeDefined()
    const enabledEntries = parseEnvironmentAssignments(enabledUpdateEnvVars!)
    expect(getEnvironmentAssignmentsForKey(enabledEntries, captureEnvironmentKey)).toEqual([
      captureEnvironmentAssignment,
    ])

    const disabledArgs = runCloudVitestWrapper(false)
    const disabledUpdateEnvVars = getUpdateEnvVarsValue(disabledArgs)
    expect(disabledUpdateEnvVars).toBeDefined()
    const disabledEntries = parseEnvironmentAssignments(disabledUpdateEnvVars!)
    expect(getEnvironmentAssignmentsForKey(disabledEntries, captureEnvironmentKey)).toEqual([])
  })
})
