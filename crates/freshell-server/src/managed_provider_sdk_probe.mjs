import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { query } from '/opt/freshell-claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'
import { hostedMcpServers } from './hosted-mcp.mjs'
import { managedSdkSpawn } from './exec-profile.mjs'

const abort = new AbortController()
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let ended = false, settleNext, prompts = 0, stage = 'query', sdkQuery, nativeChild, nativeExit
const prompt = {
  [Symbol.asyncIterator]() { return this },
  next() {
    if (ended) return Promise.resolve({ done: true })
    return new Promise(resolve => { settleNext = resolve })
  },
  end() { ended = true; settleNext?.({ done: true }); settleNext = undefined },
  return() { this.end(); return Promise.resolve({ done: true }) },
}
const token = 'synthetic-sdk-scoped-child-value'
const env = { ...process.env, FRESHELL: '1', FRESHELL_URL: 'http://127.0.0.1:9', FRESHELL_TOKEN: token }
const receipt = {
  sdkVersion: JSON.parse(readFileSync('/opt/freshell-claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk/package.json')).version,
  nativeVersion: '', defaultChild: false, connected: false, fixedRecipe: false,
  scopedEnvironment: false, zeroPrompts: false, nativeExit: false, mcpExit: false,
}
const mcpPids = new Set()
function observeMcp(parent) {
  const file = `/proc/${parent}/task/${parent}/children`
  if (!existsSync(file)) return
  for (const pid of readFileSync(file, 'utf8').trim().split(/\s+/).filter(Boolean)) {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
      if (argv.includes('/opt/freshell-mcp/server.js')) {
        mcpPids.add(pid)
        const effective = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
        receipt.scopedEnvironment = effective.includes(`FRESHELL_TOKEN=${token}`)
          && effective.includes('FRESHELL=1') && effective.includes(`FRESHELL_URL=${env.FRESHELL_URL}`)
      }
      observeMcp(pid)
    } catch { /* The observed native-owned child may exit during inspection. */ }
  }
}
const deadline = setTimeout(() => { prompt.end(); abort.abort(); sdkQuery?.close() }, 90_000)
try {
  const launch = managedSdkSpawn(() => {})
  sdkQuery = query({ prompt, options: {
    cwd: process.cwd(), env, abortController: abort,
    settingSources: ['user', 'project', 'local'], mcpServers: hostedMcpServers(true, env),
    spawnClaudeCodeProcess: options => {
      receipt.defaultChild = options.command.includes('@anthropic-ai/claude-agent-sdk-linux-x64/') && options.command.endsWith('/claude')
      const version = spawnSync(options.command, ['--version'], { env: options.env, encoding: 'utf8', timeout: 10_000 })
      receipt.nativeVersion = /^2\.1\.237(?:\s|$)/.test(version.stdout ?? '') ? '2.1.237' : 'unexpected'
      const index = options.args.indexOf('--mcp-config')
      const config = index < 0 ? {} : JSON.parse(options.args[index + 1])
      receipt.fixedRecipe = JSON.stringify(config) === JSON.stringify({ mcpServers: hostedMcpServers(true, env) })
        && !options.args.some(arg => arg.includes(token))
      nativeChild = launch(options)
      const write = nativeChild.stdin.write
      let pending = ''
      nativeChild.stdin.write = function(chunk, ...args) {
        pending += chunk.toString()
        let boundary
        while ((boundary = pending.indexOf('\n')) >= 0) {
          const frame = pending.slice(0, boundary)
          pending = pending.slice(boundary + 1)
          try { if (JSON.parse(frame).type === 'user') prompts++ } catch {}
        }
        if (pending.length > 1024 * 1024) throw new Error('fixture-native-input-profile')
        return write.call(this, chunk, ...args)
      }
      nativeExit = new Promise(resolve => nativeChild.once('exit', resolve))
      return nativeChild
    },
  } })
  stage = 'initialization'
  await sdkQuery.initializationResult()
  stage = 'native-mcp-startup'
  for (let attempt = 0; attempt < 160; attempt++) {
    const statuses = await sdkQuery.mcpServerStatus()
    receipt.connected = statuses.some(status => status.name === 'freshell' && status.status === 'connected' && status.tools?.length > 0)
    observeMcp(nativeChild.pid)
    if (receipt.connected && receipt.scopedEnvironment) break
    await pause(250)
  }
} catch {
  receipt.failureClass = stage
} finally {
  prompt.end()
  abort.abort()
  sdkQuery?.close()
  if (sdkQuery) await sdkQuery.return()
  if (nativeExit) {
    let exitTimer
    receipt.nativeExit = await Promise.race([
      nativeExit.then(() => true),
      new Promise(resolve => { exitTimer = setTimeout(() => resolve(false), 10_000) }),
    ])
    clearTimeout(exitTimer)
  }
  receipt.zeroPrompts = prompts === 0
  receipt.mcpExit = mcpPids.size > 0 && [...mcpPids].every(pid => {
    try { return /^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, 'utf8')) } catch { return true }
  })
  clearTimeout(deadline)
}
process.stdout.write(JSON.stringify(receipt))
if (receipt.failureClass || Object.values(receipt).includes(false)) process.exitCode = 1
