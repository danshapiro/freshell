import { spawn } from 'node:child_process'
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
    expect(dockerfile).toContain('ARG PLAYWRIGHT_VERSION')
    expect(dockerfile).toContain('"playwright@${PLAYWRIGHT_VERSION}" install-deps chromium')
    expect(build).toContain('lock.packages?.["node_modules/playwright"]?.version')
    expect(build).toContain('--build-arg "PLAYWRIGHT_VERSION=${PLAYWRIGHT_VERSION}"')
    expect(run).toContain('lock.packages?.["node_modules/playwright"]?.version')
    expect(run).toContain("printf 'playwright=%s\\n' \"${PLAYWRIGHT_VERSION}\"")
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
