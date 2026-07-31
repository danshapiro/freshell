import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { stopOwnedChildBeforeIdentity } from '../../helpers/owned-child-process.js'

const execFileAsync = promisify(execFile)
const testFile = fileURLToPath(import.meta.url)
const repository = path.resolve(path.dirname(testFile), '../../..')
const temporaryRoots: string[] = []

function temporaryRoot(prefix: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function waitForFile(file: string, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function fakeCodexInvocation(extraEnvironment: NodeJS.ProcessEnv = {}) {
  const root = temporaryRoot('freshell-fake-codex-portable-')
  const log = path.join(root, 'argv.jsonl')
  const fixture = path.join(repository, 'test/e2e-browser/fixtures/fake-codex-cli.mjs')
  const child = spawn(
    process.execPath,
    [fixture, '--model', 'test-model', 'resume', 'portable-session'],
    {
      stdio: 'ignore',
      env: {
        ...process.env,
        FAKE_CODEX_ARGV_LOG: log,
        ...extraEnvironment,
      },
    },
  )
  try {
    await waitForFile(log)
    return JSON.parse(readFileSync(log, 'utf8').trim())
  } finally {
    await stopOwnedChildBeforeIdentity(child, 'fake-Codex fixture')
  }
}

function writeFakePlaywright(workspace: string, version: string, installLog: string) {
  const packageRoot = path.join(workspace, 'node_modules/playwright')
  const binRoot = path.join(workspace, 'node_modules/.bin')
  mkdirSync(packageRoot, { recursive: true })
  mkdirSync(binRoot, { recursive: true })
  writeFileSync(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: 'playwright', version, main: 'index.js' })}\n`,
  )
  writeFileSync(
    path.join(packageRoot, 'index.js'),
    `const path = require('node:path')
exports.chromium = {
  executablePath() {
    return path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium-' + ${JSON.stringify(version)}, 'chrome')
  },
}
`,
  )
  const cli = path.join(binRoot, 'playwright')
  writeFileSync(
    cli,
    `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const version = require('../playwright/package.json').version
fs.appendFileSync(${JSON.stringify(installLog)}, JSON.stringify(process.argv.slice(2)) + '\\n')
if (process.argv[2] === 'install' && process.argv[3] === 'chromium') {
  const executable = path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium-' + version, 'chrome')
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.writeFileSync(executable, '#!/bin/sh\\nexit 0\\n', { mode: 0o755 })
}
`,
  )
  chmodSync(cli, 0o755)
}

function sandboxDefinitionSha256(uid = process.getuid!(), gid = process.getgid!()) {
  const files = [
    'docker/sandbox/Dockerfile',
    'docker/sandbox/entrypoint.sh',
    'docker/sandbox/ensure-playwright-cache.sh',
  ]
  const hashes = files.map((file) => createHash('sha256')
    .update(readFileSync(path.join(repository, file)))
    .digest('hex'))
  const lock = JSON.parse(readFileSync(path.join(repository, 'package-lock.json'), 'utf8'))
  const playwrightVersion = lock.packages?.['node_modules/playwright']?.version
  if (!playwrightVersion) throw new Error('package-lock.json does not resolve playwright')
  return createHash('sha256')
    .update(`${[
      ...hashes,
      `playwright=${playwrightVersion}`,
      `uid=${uid}`,
      `gid=${gid}`,
    ].join('\n')}\n`)
    .digest('hex')
}

function writeConcurrentFakeDocker(binRoot: string) {
  const fakeDocker = path.join(binRoot, 'docker')
  writeFileSync(
    fakeDocker,
    `#!/usr/bin/env bash
set -euo pipefail

state="\${FAKE_DOCKER_STATE:?}"
case "\${1:-}:\${2:-}" in
  image:inspect)
    printf '%s\\n' "\${FAKE_DOCKER_DEFINITION_SHA256:?}"
    ;;
  build:*)
    printf '%s\\n' "$*" > "\${FAKE_DOCKER_BUILD_LOG:?}"
    ;;
  network:inspect)
    if [ -d "\${state}/network" ]; then
      exit 0
    fi
    marker="\${state}/network-inspect-\${BASHPID}"
    : > "\${marker}"
    expected="\${FAKE_DOCKER_INSPECT_BARRIER:-1}"
    for _attempt in $(seq 1 500); do
      count="$(find "\${state}" -maxdepth 1 -name 'network-inspect-*' | wc -l)"
      if [ "\${count}" -ge "\${expected}" ]; then
        break
      fi
      sleep 0.01
    done
    if [ -d "\${state}/network" ]; then
      exit 0
    fi
    : > "\${state}/network-missing-\${BASHPID}"
    for _attempt in $(seq 1 500); do
      count="$(find "\${state}" -maxdepth 1 -name 'network-missing-*' | wc -l)"
      if [ "\${count}" -ge "\${expected}" ]; then
        exit 1
      fi
      sleep 0.01
    done
    echo "fake docker inspect barrier timed out" >&2
    exit 70
    ;;
  network:create)
    if [ "\${FAKE_DOCKER_NETWORK_CREATE_ERROR:-}" = "permission" ]; then
      echo "Error response from daemon: permission denied creating network" >&2
      exit 42
    fi
    if mkdir "\${state}/network" 2>/dev/null; then
      printf '%s\\n' freshell-sandbox
      exit 0
    fi
    echo "Error response from daemon: network freshell-sandbox already exists" >&2
    exit 1
    ;;
  run:*)
    exit 0
    ;;
  *)
    printf 'unexpected fake docker invocation: %q' "$@" >&2
    printf '\\n' >&2
    exit 64
    ;;
esac
`,
  )
  chmodSync(fakeDocker, 0o755)
}

function callWithinTryBlock(
  sourceFile: ts.SourceFile,
  predicate: (call: ts.CallExpression) => boolean,
) {
  let matched: ts.CallExpression | undefined
  const visit = (node: ts.Node) => {
    if (!matched && ts.isCallExpression(node) && predicate(node)) matched = node
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  expect(matched, 'expected safety-sensitive call to exist').toBeDefined()
  let current: ts.Node | undefined = matched
  while (current) {
    if (
      ts.isBlock(current)
      && current.parent
      && ts.isTryStatement(current.parent)
      && current.parent.tryBlock === current
    ) {
      return true
    }
    current = current.parent
  }
  return false
}

describe('Task 7 proof infrastructure', () => {
  it('installs the lockfile-backed Playwright Chromium into an empty cache and reuses it', async () => {
    const root = temporaryRoot('freshell-playwright-cache-unit-')
    const workspace = path.join(root, 'workspace')
    const cache = path.join(root, 'cache')
    const installLog = path.join(root, 'installs.jsonl')
    mkdirSync(workspace)
    mkdirSync(cache)
    writeFakePlaywright(workspace, '1.58.2', installLog)
    const helper = path.join(repository, 'docker/sandbox/ensure-playwright-cache.sh')
    const environment = {
      ...process.env,
      FRESHELL_SANDBOX_WORKSPACE: workspace,
      PLAYWRIGHT_BROWSERS_PATH: cache,
    }

    await execFileAsync(helper, { env: environment })
    expect(readFileSync(path.join(cache, '.freshell-playwright-version'), 'utf8'))
      .toBe('1.58.2\n')
    expect(readFileSync(installLog, 'utf8').trim().split('\n')).toEqual([
      '["install","chromium"]',
    ])

    await execFileAsync(helper, { env: environment })
    expect(readFileSync(installLog, 'utf8').trim().split('\n')).toEqual([
      '["install","chromium"]',
    ])

    writeFakePlaywright(workspace, '1.59.0', installLog)
    await execFileAsync(helper, { env: environment })
    expect(readFileSync(path.join(cache, '.freshell-playwright-version'), 'utf8'))
      .toBe('1.59.0\n')
    expect(readFileSync(installLog, 'utf8').trim().split('\n')).toEqual([
      '["install","chromium"]',
      '["install","chromium"]',
    ])
  })

  it('keys image-level browser dependencies to the lockfile Playwright version', () => {
    const dockerfile = readFileSync(
      path.join(repository, 'docker/sandbox/Dockerfile'),
      'utf8',
    )
    const build = readFileSync(path.join(repository, 'scripts/sandbox-build.sh'), 'utf8')
    const run = readFileSync(path.join(repository, 'scripts/sandbox-test.sh'), 'utf8')
    const definition = readFileSync(
      path.join(repository, 'scripts/sandbox-image-definition.sh'),
      'utf8',
    )
    expect(dockerfile).toContain('ARG PLAYWRIGHT_VERSION')
    expect(dockerfile).toContain('"playwright@${PLAYWRIGHT_VERSION}" install-deps chromium')
    expect(definition).toContain('lock.packages?.["node_modules/playwright"]?.version')
    expect(build).toContain('--build-arg "PLAYWRIGHT_VERSION=${PLAYWRIGHT_VERSION}"')
    expect(build).toContain('sandbox_playwright_version "${REPO_ROOT}"')
    expect(run).toContain('sandbox_playwright_version "${REPO_ROOT}"')
    expect(definition).toContain("printf 'playwright=%s\\nuid=%s\\ngid=%s\\n'")
  })

  it('maps an existing sandbox UID onto a provisioned primary GID', () => {
    const dockerfile = readFileSync(
      path.join(repository, 'docker/sandbox/Dockerfile'),
      'utf8',
    )
    const groupProvision = dockerfile.indexOf(
      '(getent group "${GID}" >/dev/null 2>&1 || groupadd -g "${GID}" sandbox)',
    )
    const existingUidLookup = dockerfile.indexOf(
      'if getent passwd "${UID}" >/dev/null 2>&1; then',
    )

    expect(groupProvision).toBeGreaterThan(-1)
    expect(existingUidLookup).toBeGreaterThan(groupProvision)
    expect(dockerfile).toContain('usermod -g "${GID}" sandbox;')
  })

  it('invalidates the shared sandbox image fingerprint when its baked user identity changes', async () => {
    const build = readFileSync(path.join(repository, 'scripts/sandbox-build.sh'), 'utf8')
    const run = readFileSync(path.join(repository, 'scripts/sandbox-test.sh'), 'utf8')
    const helper = path.join(repository, 'scripts/sandbox-image-definition.sh')
    const lock = JSON.parse(readFileSync(path.join(repository, 'package-lock.json'), 'utf8'))
    const playwrightVersion = lock.packages?.['node_modules/playwright']?.version
    if (!playwrightVersion) throw new Error('package-lock.json does not resolve playwright')
    const fingerprint = async (uid: number, gid: number) => {
      const { stdout } = await execFileAsync('bash', [
        '-c',
        'source "$1"; sandbox_image_definition_sha256 "$2" "$3" "$4" "$5"',
        'sandbox-image-definition-test',
        helper,
        repository,
        playwrightVersion,
        String(uid),
        String(gid),
      ])
      return stdout.trim()
    }

    const identity1000 = await fingerprint(1000, 1000)
    expect(identity1000).toBe(sandboxDefinitionSha256(1000, 1000))
    await expect(fingerprint(1001, 1000)).resolves.not.toBe(identity1000)
    await expect(fingerprint(1000, 1001)).resolves.not.toBe(identity1000)
    for (const wrapper of [build, run]) {
      expect(wrapper).toContain('source "${REPO_ROOT}/scripts/sandbox-image-definition.sh"')
      expect(wrapper).toContain('sandbox_image_definition_sha256')
      expect(wrapper).toContain('"${SANDBOX_UID}"')
      expect(wrapper).toContain('"${SANDBOX_GID}"')
    }
  })

  it('rebuilds a sandbox image cached for a different user identity', async () => {
    const root = temporaryRoot('freshell-sandbox-identity-cache-')
    const binRoot = path.join(root, 'bin')
    const state = path.join(root, 'state')
    const buildLog = path.join(root, 'build.log')
    mkdirSync(binRoot)
    mkdirSync(state)
    writeConcurrentFakeDocker(binRoot)
    const uid = process.getuid!()
    const gid = process.getgid!()
    const environment = {
      ...process.env,
      PATH: `${binRoot}:${process.env.PATH}`,
      FAKE_DOCKER_STATE: state,
      FAKE_DOCKER_DEFINITION_SHA256: sandboxDefinitionSha256(uid + 1, gid),
      FAKE_DOCKER_BUILD_LOG: buildLog,
    }

    await execFileAsync(
      path.join(repository, 'scripts/sandbox-test.sh'),
      ['true'],
      { env: environment },
    )

    const buildInvocation = readFileSync(buildLog, 'utf8')
    expect(buildInvocation).toContain(`--build-arg UID=${uid}`)
    expect(buildInvocation).toContain(`--build-arg GID=${gid}`)
    expect(buildInvocation).toContain(
      `--build-arg FRESHELL_SANDBOX_DEFINITION_SHA256=${sandboxDefinitionSha256(uid, gid)}`,
    )
  })

  it('lets concurrent sandbox invocations share network creation', async () => {
    const root = temporaryRoot('freshell-sandbox-network-race-')
    const binRoot = path.join(root, 'bin')
    const state = path.join(root, 'state')
    mkdirSync(binRoot)
    mkdirSync(state)
    writeConcurrentFakeDocker(binRoot)
    const environment = {
      ...process.env,
      PATH: `${binRoot}:${process.env.PATH}`,
      FAKE_DOCKER_STATE: state,
      FAKE_DOCKER_DEFINITION_SHA256: sandboxDefinitionSha256(),
      FAKE_DOCKER_INSPECT_BARRIER: '2',
    }
    const wrapper = path.join(repository, 'scripts/sandbox-test.sh')

    const results = await Promise.allSettled([
      execFileAsync(wrapper, ['true'], { env: environment }),
      execFileAsync(wrapper, ['true'], { env: environment }),
    ])

    expect(results.map(({ status }) => status)).toEqual(['fulfilled', 'fulfilled'])
  })

  it('preserves a network creation failure when the network remains absent', async () => {
    const root = temporaryRoot('freshell-sandbox-network-error-')
    const binRoot = path.join(root, 'bin')
    const state = path.join(root, 'state')
    mkdirSync(binRoot)
    mkdirSync(state)
    writeConcurrentFakeDocker(binRoot)
    const environment = {
      ...process.env,
      PATH: `${binRoot}:${process.env.PATH}`,
      FAKE_DOCKER_STATE: state,
      FAKE_DOCKER_DEFINITION_SHA256: sandboxDefinitionSha256(),
      FAKE_DOCKER_NETWORK_CREATE_ERROR: 'permission',
    }
    const wrapper = path.join(repository, 'scripts/sandbox-test.sh')

    await expect(execFileAsync(wrapper, ['true'], { env: environment }))
      .rejects.toMatchObject({
        code: 42,
        stderr: expect.stringContaining('permission denied creating network'),
      })
  })

  it('keeps ordinary fake-Codex argv logging portable', async () => {
    const invocation = await fakeCodexInvocation({
      FAKE_CODEX_PROC_ROOT: '/definitely-not-a-real-proc-root',
    })
    expect(invocation).toEqual({
      pid: expect.any(Number),
      t: expect.any(Number),
      argv: ['--model', 'test-model', 'resume', 'portable-session'],
    })
  })

  it('falls back to portable fake-Codex logging when exact sandbox identity is unavailable', async () => {
    const invocation = await fakeCodexInvocation({
      FAKE_CODEX_EXACT_BIRTH_LOG: '1',
      FAKE_CODEX_PROC_ROOT: '/definitely-not-a-real-proc-root',
    })
    expect(invocation).toEqual({
      pid: expect.any(Number),
      t: expect.any(Number),
      argv: ['--model', 'test-model', 'resume', 'portable-session'],
    })
  })

  it('captures temporary roots and sentinel identities inside cleanup-protected scopes', () => {
    const browserPath = path.join(
      repository,
      'test/e2e-browser/deployment-compatibility.spec.ts',
    )
    const browserSource = ts.createSourceFile(
      browserPath,
      readFileSync(browserPath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    expect(callWithinTryBlock(browserSource, (call) => (
      call.expression.getText(browserSource) === 'mkdtempSync'
      && call.arguments[0]?.getText(browserSource).includes('freshell-deploy-browser-')
    ))).toBe(true)
    expect(callWithinTryBlock(browserSource, (call) => (
      call.expression.getText(browserSource) === 'readProcessIdentity'
      && call.arguments[0]?.getText(browserSource) === 'sentinel.pid'
    ))).toBe(true)

    const realBoundaryPath = path.join(
      repository,
      'test/integration/server/launch-rust-real-boundary.sandbox.test.ts',
    )
    const realBoundarySource = ts.createSourceFile(
      realBoundaryPath,
      readFileSync(realBoundaryPath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    expect(callWithinTryBlock(realBoundarySource, (call) => (
      call.expression.getText(realBoundarySource) === 'mkdtempSync'
      && call.arguments[0]?.getText(realBoundarySource).includes('freshell-real-deploy-task6-')
    ))).toBe(true)
    expect(callWithinTryBlock(realBoundarySource, (call) => (
      call.expression.getText(realBoundarySource) === 'readProcessIdentity'
      && call.arguments[0]?.getText(realBoundarySource) === 'unrelatedSentinel.pid'
    ))).toBe(true)
  })

  it('stops a spawned sentinel even when identity capture never completed', async () => {
    const child = spawn(
      process.execPath,
      ['--eval', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    )
    expect(child.pid).toEqual(expect.any(Number))
    await stopOwnedChildBeforeIdentity(child, 'unit-test sentinel')
    expect(child.signalCode ?? child.exitCode).not.toBeNull()
  })
})
