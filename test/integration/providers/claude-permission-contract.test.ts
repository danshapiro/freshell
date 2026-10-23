// @vitest-environment node
//
// Real-CLI contract for Claude's permission suggestions and plan approvals
// (client-alerts plan PR-C, D0): the production sidecar
// (crates/freshell-claude-sidecar/index.mjs) over the pinned SDK 0.3.237 and
// its bundled CLI 2.1.237, against the local provider endpoint (never the real
// API). claude-permission-contract.mjs runs each scenario in its own fixture
// and reports every stdout frame, the decisions it sent, and what the CLI left
// on disk.
//
// The approval card ("Allow and don't ask again"), the plan card and the
// pane's permission mode rely on these facts. This is a characterization of
// an external dependency: a pinned-CLI bump that changes any of them fails
// here first. When the pinned CLI is missing the harness fails
// (PinnedClaudeMissingError): nothing here is ever skipped.

import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PINNED_CLI_VERSION, PINNED_SDK_VERSION } from './claude-local-provider.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../..')
const HARNESS = path.join(__dirname, 'claude-permission-contract.mjs')

type Frame = Record<string, any>
interface ScenarioReceipt {
  failure?: string
  fixtureRemoved: boolean
  sidecarExit?: { code: number | null; signal: string | null }
  frames: Frame[]
  answered: Array<{ tool: string; decision: Frame }>
  settingsLocal: unknown
  written: Record<string, boolean>
}
interface Receipt {
  sdkVersion: string
  bundledCliVersion: string
  plan: string
  planFileText: string
  scenarios: Record<string, ScenarioReceipt>
}

let child: ChildProcess | undefined
let receipt: Receipt
let stderr = ''

beforeAll(async () => {
  child = spawn(process.execPath, [HARNESS, REPO_ROOT], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child?.kill('SIGTERM')
      reject(new Error(`the permission contract harness timed out; stderr=${stderr.slice(-2000)}`))
    }, 140_000)
    timer.unref()
    child!.once('error', (error) => { clearTimeout(timer); reject(error) })
    child!.once('exit', () => { clearTimeout(timer); resolve() })
  })
  const lines = stdout.trim().split('\n').filter(Boolean)
  if (lines.length !== 1) throw new Error(`expected one receipt line; stdout=${stdout.slice(-1000)} stderr=${stderr.slice(-2000)}`)
  receipt = JSON.parse(lines[0]!)
}, 150_000)

afterAll(() => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
})

const scenario = (name: string): ScenarioReceipt => {
  const recorded = receipt.scenarios[name]
  expect(recorded, `scenario ${name} ran`).toBeDefined()
  expect(recorded!.failure, `${name}: ${stderr.slice(-2000)}`).toBeUndefined()
  return recorded!
}
const ofType = (list: Frame[], type: string) => list.filter((frame) => frame.type === type)
const requests = (name: string) => ofType(scenario(name).frames, 'sdk.permission.request')
const modes = (name: string) => ofType(scenario(name).frames, 'sdk.session.metadata').map((frame) => frame.permissionMode)
const NPM_TEST_RULE = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }], behavior: 'allow', destination: 'localSettings' }
const OUTSIDE_READ_RULE = { type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '/<root>/outside/**' }], behavior: 'allow', destination: 'session' }
const ACCEPT_EDITS = { type: 'setMode', mode: 'acceptEdits', destination: 'session' }

describe(`Claude permission suggestions and plan approvals over the pinned CLI ${PINNED_CLI_VERSION} and a local provider`, () => {
  it('runs every scenario on the pinned SDK and CLI, and each sidecar then exits cleanly', () => {
    expect(receipt).toMatchObject({ sdkVersion: PINNED_SDK_VERSION, bundledCliVersion: PINNED_CLI_VERSION })
    expect(Object.keys(receipt.scenarios)).toEqual([
      'remember-local', 'remember-session', 'shapes', 'plan-default', 'plan-accept-edits', 'plan-bypass', 'plan-file', 'plan-empty',
    ])
    for (const name of Object.keys(receipt.scenarios)) {
      expect(scenario(name), name).toMatchObject({ fixtureRemoved: true, sidecarExit: { code: 0, signal: null } })
      expect(ofType(scenario(name).frames, 'sdk.error'), name).toEqual([])
    }
  })

  it('a project rule the CLI suggests, sent back as updatedPermissions, is saved to .claude/settings.local.json and stops the next ask for that command only', () => {
    const asked = requests('remember-local')
    expect(asked[0]).toMatchObject({ tool: { name: 'Bash', input: { command: 'npm test' } }, suggestions: [NPM_TEST_RULE] })
    expect(scenario('remember-local').answered[0]!.decision).toEqual({ behavior: 'allow', updatedPermissions: [NPM_TEST_RULE] })
    // The second `npm test` runs without asking; a different command still asks.
    expect(asked.map((request) => request.tool.input.command)).toEqual(['npm test', 'ls /'])
    expect(ofType(scenario('remember-local').frames, 'sdk.result')).toHaveLength(3)
    expect(scenario('remember-local').settingsLocal).toEqual({ permissions: { allow: ['Bash(npm test *)'] } })
  })

  it('the same rule for this conversation only (destination session) stops the next ask and writes no file', () => {
    expect(requests('remember-session').map((request) => request.tool.input.command)).toEqual(['npm test', 'ls /'])
    expect(scenario('remember-session').answered[0]!.decision.updatedPermissions).toEqual([{ ...NPM_TEST_RULE, destination: 'session' }])
    expect(scenario('remember-session').settingsLocal).toBeNull()
  })

  it('the suggestion shapes: a Write offers acceptEdits, a Read outside the workspace offers a directory rule, a compound command offers both, `ls /` offers none', () => {
    const [writeRequest, readRequest, compound, listRoot] = requests('shapes')
    expect(writeRequest).toMatchObject({ tool: { name: 'Write' }, suggestions: [ACCEPT_EDITS] })
    expect(readRequest).toMatchObject({ tool: { name: 'Read' }, suggestions: [OUTSIDE_READ_RULE] })
    expect(readRequest!.decisionReason).toEqual(expect.any(String))
    expect(compound!.suggestions).toEqual([
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'cat <root>/outside/notes.txt && git status' }], behavior: 'allow', destination: 'localSettings' },
      OUTSIDE_READ_RULE,
    ])
    expect(compound!.blockedPath).toBe('<root>/outside/notes.txt')
    expect(listRoot).toMatchObject({ tool: { input: { command: 'ls /' } }, suggestions: [], blockedPath: '/' })
  })

  it('ExitPlanMode offers no suggestions and carries the plan the model gave', () => {
    for (const name of ['plan-default', 'plan-accept-edits', 'plan-bypass']) {
      const [exit] = requests(name)
      expect(exit, name).toMatchObject({ tool: { name: 'ExitPlanMode', input: { plan: receipt.plan } } })
      expect(exit!.suggestions, name).toBeUndefined()
    }
  })

  it('a plain plan approval returns the CLI to the mode it had before plan mode (default here): the sidecar states it once, and a Write asks again', () => {
    expect(scenario('plan-default').answered[0]!.decision).toEqual({ behavior: 'allow' })
    expect(modes('plan-default')).toEqual(['default'])
    expect(requests('plan-default').map((request) => request.tool.name)).toEqual(['ExitPlanMode', 'Write'])
    expect(scenario('plan-default').written['after.txt']).toBe(false)
  })

  it('a plan approval with setMode acceptEdits leaves plan mode for acceptEdits: stated once, and the next Write runs without asking', () => {
    expect(modes('plan-accept-edits')).toEqual(['acceptEdits'])
    expect(requests('plan-accept-edits').map((request) => request.tool.name)).toEqual(['ExitPlanMode'])
    expect(scenario('plan-accept-edits').written['after.txt']).toBe(true)
  })

  it('a plan approval with setMode bypassPermissions leaves plan mode for bypassPermissions: stated once, and the next Write runs without asking', () => {
    expect(modes('plan-bypass')).toEqual(['bypassPermissions'])
    expect(requests('plan-bypass').map((request) => request.tool.name)).toEqual(['ExitPlanMode'])
    expect(scenario('plan-bypass').written['after.txt']).toBe(true)
  })

  it('ExitPlanMode with no input: the CLI fills in the plan file\'s text and path when the model wrote one, and sends an empty input when it did not', () => {
    const [fromFile] = requests('plan-file')
    expect(fromFile!.tool.input).toEqual({ plan: receipt.planFileText, planFilePath: expect.stringMatching(/^<root>\/home\/\.claude\/plans\/[^/]+\.md$/) })
    const [empty] = requests('plan-empty')
    expect(empty!.tool.input).toEqual({})
  })
})
