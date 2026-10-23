import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  createClaudeFixture,
  FAKE_MODEL,
  resolvePinnedClaude,
  startLocalProvider,
} from './claude-local-provider.mjs'

const repoRoot = process.argv[2]
if (!repoRoot) throw new Error('repository root argument is required')

const pinned = await resolvePinnedClaude(repoRoot)
const nativeCli = pinned.nativeCli
const fixture = await createClaudeFixture({ prefix: 'freshell-claude-checkpoint-contract-' })
const { home, cwd } = fixture

// The checkpoint contract: a uuid supplied on an SDK user message is replayed
// by the native CLI and persisted on the transcript's user line.

const inputUuid = randomUUID()
const promptText = randomUUID()
const responseText = randomUUID()

let provider
let query
let nativeChild
let releasePrompt
let timer
let resultMessage
let replayedUserUuid
let persistedUserUuid
let replayFlagObservedByNativeCli = false
let localProviderClosed = false
let nativeCliExited = false
let verdict = 'FAIL'
let failureStage = 'initialization'

const closeProvider = async () => {
  releasePrompt?.()
  try { query?.close?.() } catch {}
  if (nativeChild && !nativeCliExited) {
    nativeChild.kill('SIGTERM')
    await Promise.race([
      new Promise(resolve => nativeChild.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ])
    if (!nativeCliExited) nativeChild.kill('SIGKILL')
    await Promise.race([
      new Promise(resolve => nativeChild.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ])
  }
  nativeCliExited = !nativeChild || nativeCliExited
  if (provider) await provider.close()
  localProviderClosed = !provider || !provider.listening
}

try {
  failureStage = 'local provider'
  provider = await startLocalProvider({ replyText: responseText })
  const providerUrl = provider.url
  const childEnv = fixture.env(providerUrl, { FRESHELL_CLAUDE_ONECLI_API_KEY: '1' })

  // resolvePinnedClaude already checked the CLI's version.
  failureStage = 'native CLI flags'
  const { stdout: nativeHelp } = await promisify(execFile)(nativeCli, ['--help'], {
    cwd,
    env: childEnv,
    timeout: 10_000,
    maxBuffer: 100_000,
  })
  if (!nativeHelp.includes('--replay-user-messages')) throw new Error('native CLI does not advertise replay-user-messages')

  // Match the production sidecar's clean child environment and SDK dependency.
  for (const name of Object.keys(process.env)) delete process.env[name]
  Object.assign(process.env, childEnv)
  const { query: sdkQuery } = await import(pathToFileURL(pinned.sdkEntry).href)
  const abortController = new AbortController()
  timer = setTimeout(() => {
    abortController.abort()
    query?.close?.()
  }, 45_000)

  async function* prompt() {
    yield {
      type: 'user',
      uuid: inputUuid,
      message: { role: 'user', content: promptText },
      parent_tool_use_id: null,
    }
    await new Promise(resolve => { releasePrompt = resolve })
  }

  failureStage = 'SDK query and replay'
  query = sdkQuery({
    prompt: prompt(),
    options: {
      cwd,
      env: childEnv,
      settingSources: ['user', 'project', 'local'],
      mcpServers: {},
      strictMcpConfig: true,
      tools: [],
      model: FAKE_MODEL,
      maxTurns: 1,
      systemPrompt: '',
      pathToClaudeCodeExecutable: nativeCli,
      extraArgs: { 'replay-user-messages': null },
      abortController,
      spawnClaudeCodeProcess(options) {
        if (options.command !== nativeCli || options.cwd !== cwd
          || options.env.HOME !== home || options.env.ANTHROPIC_BASE_URL !== providerUrl) {
          throw new Error('SDK spawned the native CLI outside the isolated local-provider fixture')
        }
        replayFlagObservedByNativeCli = options.args.includes('--replay-user-messages')
        nativeChild = spawn(options.command, options.args, {
          cwd: options.cwd,
          env: options.env,
          signal: options.signal,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        nativeChild.stderr.on('data', () => {})
        nativeChild.once('exit', () => { nativeCliExited = true })
        return nativeChild
      },
      stderr() {},
    },
  })

  for await (const message of query) {
    if (message.type === 'user' && message.isReplay === true && message.message?.role === 'user') {
      replayedUserUuid = message.uuid
    }
    if (message.type === 'result') {
      resultMessage = message
      releasePrompt?.()
      break
    }
  }
  clearTimeout(timer)
  timer = undefined
  query.close()
  await closeProvider()

  failureStage = 'persisted transcript'
  for (const file of await fixture.transcripts()) {
    for (const line of (await fs.readFile(path.join(fixture.claudeConfigDir, file), 'utf8')).split('\n').filter(Boolean)) {
      let row
      try { row = JSON.parse(line) } catch { continue }
      if (row.type === 'user' && row.message?.role === 'user' && row.uuid === inputUuid) {
        persistedUserUuid = row.uuid
      }
    }
  }
  if (replayedUserUuid === inputUuid && persistedUserUuid === inputUuid
    && resultMessage?.subtype === 'success' && resultMessage?.is_error === false
    && replayFlagObservedByNativeCli && nativeCliExited && localProviderClosed) {
    verdict = 'PASS'
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    severity: 'error',
    component: 'claude-checkpoint-contract',
    stage: failureStage,
    code: error?.code ?? 'CONTRACT_FAILURE',
    name: error?.name ?? 'Error',
    message: String(error?.message ?? 'unknown error').slice(0, 500),
  })}\n`)
} finally {
  if (timer) clearTimeout(timer)
  await closeProvider()
  await fixture.cleanup()
}

const fixtureRemoved = !(await fs.stat(fixture.root).catch(() => null))
process.stdout.write(`${JSON.stringify({
  verdict,
  sdkVersion: pinned.sdkVersion,
  bundledCliVersion: pinned.cliVersion,
  replayFlagObservedByNativeCli,
  replayedUserUuid,
  persistedUserUuid,
  resultSubtype: resultMessage?.subtype,
  nativeCliExited,
  localProviderClosed,
  fixtureRemoved,
})}\n`)
if (verdict !== 'PASS' || !fixtureRemoved) process.exitCode = 1
