import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  startExternalServer,
  type ExternalServerHandle,
  type OracleTarget,
} from '../../../../port/oracle/harness/external-server.js'
import {
  WsCaptureClient,
  type CapturedMessage,
} from '../../../../port/oracle/harness/ws-capture-client.js'
import {
  diffNormalized,
  stableStringify,
  type NormalizedMessage,
  type NormalizedDiff,
} from '../../../../port/oracle/harness/normalize.js'

/**
 * FRESH-AGENT WIRE-SHAPE DIFFERENTIAL -- the decisive tool for the codex
 * live-update stall + reload-restore investigation (overnight rehearsal 3,
 * evidence (a)/(b)/(c)).
 *
 * Unlike the T0/T1/T2 equivalence oracle (`normalize.ts`'s registry treats the
 * `event` field of `freshAgent.event` as OPAQUE -- by design, for those tiers,
 * which don't care about fresh-agent inner-event shape). THIS test deliberately
 * does NOT use that registry: the entire point here is comparing the fresh-agent
 * envelope AND every inner `event.*` field, byte-for-byte, between the original
 * (node) server and the Rust port, driving the IDENTICAL WS sequence against a
 * deterministic fake `codex app-server` fixture (no live model calls, no cost).
 *
 * Sequence driven against EACH target:
 *   hello -> freshAgent.create{sessionType:'freshcodex',provider:'codex'}
 *         -> freshAgent.send{text:'hi'} -> wait for the turn-complete chime
 *         -> freshAgent.attach{same sessionId} -> settle window
 *
 * All captured `freshAgent.*` server->client frames are stripped of the
 * genuinely-nondeterministic fields (wall-clock `at`, thread `revision`,
 * server-minted `submittedTurnId`) -- replaced with presence-only sentinels --
 * and then diffed with `diffNormalized`. Every SURVIVING difference is a real
 * envelope/shape divergence: a missing/extra field, wrong nesting, or a wrong
 * enum value. This is exactly the class of bug capable of causing the SPA to
 * silently drop a frame it cannot parse into its expected shape.
 *
 * SAFETY: ephemeral loopback ports only (never :3001/17871/17872/17874),
 * isolated HOME per server, reaps every spawned pid via `stop()`.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../../../..')

const FAKE_CODEX_APP_SERVER_SOURCE = path.resolve(
  PROJECT_ROOT,
  'test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs',
)

/**
 * Deterministic thread id this differential run pins via
 * `FAKE_CODEX_APP_SERVER_BEHAVIOR.threadStartThreadId` -- both targets get the
 * exact same id, so `sessionId` is NOT run-specific here and needs no
 * placeholder normalization (unlike the general T0/T1/T2 oracle).
 */
const THREAD_ID = 'thread-wireshape-differential'

/**
 * Wrapper indirection identical to `restore-matrix.spec.ts`'s
 * `installFakeCodexAppServer`: re-exec `node <original fixture path>` rather
 * than copying the fixture elsewhere. A plain copy would (a) touch
 * permission bits on a file outside this test's owned path
 * (`test/unit/port/oracle/**`) and (b) break the fixture's
 * `import { WebSocketServer } from 'ws'` bare-specifier resolution, which is
 * relative to the FIXTURE'S OWN location -- a copy dropped in a bare temp dir
 * has no `node_modules` ancestor. `CODEX_CMD` pointed at this wrapper works
 * identically for both the legacy runtime (spawns `CODEX_CMD` directly) and
 * the Rust sidecar (whitespace-splits `CODEX_CMD`, but a bare single-token
 * executable path works unchanged).
 */
async function installFakeCodexAppServer(destDir: string): Promise<string> {
  await fs.mkdir(destDir, { recursive: true })
  const dest = path.join(destDir, 'fake-codex-app-server-wrapper.mjs')
  const wrapper = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
const target = ${JSON.stringify(FAKE_CODEX_APP_SERVER_SOURCE)}
const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(result.status ?? 1)
`
  await fs.writeFile(dest, wrapper, 'utf8')
  await fs.chmod(dest, 0o755)
  return dest
}

/**
 * Scripted fixture behavior: pin the thread id, and -- critically -- emit a
 * `turn/completed{status:'completed'}` NOTIFICATION after `turn/start`
 * (`notificationsAfterMethods`, mirroring the exact pattern
 * `test/integration/server/codex-session-flow.test.ts:507-516` uses). Without
 * this, the fixture only returns an already-`completed` turn SYNCHRONOUSLY in
 * the `turn/start` RPC *response* -- both the legacy and Rust codex adapters
 * gate their completion edge on the asynchronous `turn/completed`
 * NOTIFICATION (never the RPC response body), so no notification means no
 * `freshAgent.turn.complete` chime ever fires, for either server.
 */
function codexBehaviorEnv(): string {
  return JSON.stringify({
    threadStartThreadId: THREAD_ID,
    notificationsAfterMethods: {
      'turn/start': [{
        method: 'turn/completed',
        params: { threadId: THREAD_ID, turnId: 'turn-1', status: 'completed' },
      }],
    },
  })
}

interface FreshAgentCapture {
  target: OracleTarget
  messages: CapturedMessage[]
}

async function captureCodexFlow(
  target: OracleTarget,
  fakeCodexPath: string,
): Promise<{ handle: ExternalServerHandle; capture: FreshAgentCapture }> {
  const handle = await startExternalServer({
    target,
    provider: 'freshagent-wireshape',
    env: {
      CODEX_CMD: fakeCodexPath,
      FAKE_CODEX_APP_SERVER_BEHAVIOR: codexBehaviorEnv(),
    },
    // Fresh-agent creation is gated SERVER-side (ws-handler.ts checks
    // `settings.freshAgent.enabled` + `settings.codingCli.enabledProviders`),
    // matching `restore-matrix.spec.ts`'s seeded-config pattern.
    setupHome: async (homeDir) => {
      const freshellDir = path.join(homeDir, '.freshell')
      await fs.mkdir(freshellDir, { recursive: true })
      await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
        version: 1,
        settings: {
          freshAgent: { enabled: true },
          codingCli: {
            enabledProviders: ['codex'],
            providers: { codex: { model: 'gpt-5-codex', sandbox: 'workspace-write' } },
          },
        },
      }, null, 2))
    },
  })

  const client = new WsCaptureClient(handle.wsUrl, handle.token)
  try {
    await client.connect()
    await client.captureHandshake()

    client.send({
      type: 'freshAgent.create',
      requestId: 'wireshape-create-1',
      sessionType: 'freshcodex',
      provider: 'codex',
    })
    const created = await client.waitForServerMessage(
      (m) => m.type === 'freshAgent.created'
        && (m.parsed as { requestId?: unknown }).requestId === 'wireshape-create-1',
      20_000,
      'freshAgent.created',
    )
    const sessionId = (created.parsed as { sessionId: string }).sessionId
    expect(sessionId, 'freshAgent.created must carry a non-empty sessionId').toBeTruthy()

    client.send({
      type: 'freshAgent.send',
      requestId: 'wireshape-send-1',
      sessionId,
      sessionType: 'freshcodex',
      provider: 'codex',
      text: 'hi',
    })
    await client.waitForServerMessage(
      (m) => m.type === 'freshAgent.event'
        && (m.parsed as { event?: { type?: unknown } }).event?.type === 'freshAgent.turn.complete',
      20_000,
      'freshAgent.event{event.type:freshAgent.turn.complete}',
    )
    // Settle window: catch any trailing snapshot/status frame right after the chime.
    await new Promise((resolve) => setTimeout(resolve, 500))

    client.send({
      type: 'freshAgent.attach',
      sessionId,
      sessionType: 'freshcodex',
      provider: 'codex',
    })
    // Settle window: catch any attach-triggered snapshot re-subscription frame.
    await new Promise((resolve) => setTimeout(resolve, 1_500))

    const messages = client
      .getServerMessages()
      .filter((m) => typeof m.type === 'string' && m.type.startsWith('freshAgent.'))

    return { handle, capture: { target, messages } }
  } catch (err) {
    await client.close().catch(() => {})
    await handle.stop().catch(() => {})
    throw err
  } finally {
    await client.close().catch(() => {})
  }
}

/**
 * Fields that are genuinely nondeterministic ACROSS RUNS (wall-clock, or
 * server-minted opaque ids not under this test's control) and must be
 * replaced with a presence-only sentinel before diffing. Deliberately NOT
 * masking `sessionId`/`sessionRef.sessionId` etc: `THREAD_ID` is PINNED by
 * this test's fixture behavior, so both targets must emit the exact same
 * literal id -- any divergence there is itself a real finding, not noise.
 * `requestId` is likewise test-supplied and must echo back verbatim.
 */
const PRESENCE_ONLY_FIELDS = new Set(['at', 'revision', 'submittedTurnId'])

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(obj)) {
      const v = obj[key]
      if (PRESENCE_ONLY_FIELDS.has(key) && v !== null && v !== undefined) {
        out[key] = `<PRESENT:${typeof v}>`
        continue
      }
      out[key] = stripVolatile(v)
    }
    return out
  }
  return value
}

function toNormalized(messages: CapturedMessage[]): NormalizedMessage[] {
  return messages.map((m) => {
    const parsed = stripVolatile(m.parsed)
    return { dir: m.dir, type: m.type, parsed, serialized: stableStringify(parsed) }
  })
}

function formatDiff(diff: NormalizedDiff, node: NormalizedMessage[], rust: NormalizedMessage[]): string {
  const lines = diff.differences.map((d) => (
    `  [#${d.index}] ${d.path} (${d.kind}): node=${JSON.stringify(d.a)} rust=${JSON.stringify(d.b)}`
  ))
  const nodeTypes = node.map((m, i) => `${i}:${m.type}`).join(', ')
  const rustTypes = rust.map((m, i) => `${i}:${m.type}`).join(', ')
  return [
    `${diff.differences.length} divergence(s) between node (original) and rust (port) freshAgent frames:`,
    ...lines,
    `node frame types:  ${nodeTypes}`,
    `rust frame types:  ${rustTypes}`,
  ].join('\n')
}

describe('Fresh-agent wire-shape differential (original vs rust, codex)', () => {
  let sharedRoot: string | undefined
  let handles: ExternalServerHandle[] = []

  afterEach(async () => {
    for (const handle of handles) await handle.stop().catch(() => {})
    handles = []
    if (sharedRoot) await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    sharedRoot = undefined
  })

  it(
    'emits byte-identical freshAgent envelopes/inner-event shapes on create+send+attach',
    async () => {
      sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-wireshape-differential-'))
      const fakeCodexPath = await installFakeCodexAppServer(path.join(sharedRoot, 'bin'))

      const nodeRun = await captureCodexFlow('node', fakeCodexPath)
      handles.push(nodeRun.handle)
      const rustRun = await captureCodexFlow('rust', fakeCodexPath)
      handles.push(rustRun.handle)

      expect(
        nodeRun.capture.messages.length,
        'original (node) must have emitted at least one freshAgent.* frame',
      ).toBeGreaterThan(0)
      expect(
        rustRun.capture.messages.length,
        'rust port must have emitted at least one freshAgent.* frame',
      ).toBeGreaterThan(0)

      const nodeNormalized = toNormalized(nodeRun.capture.messages)
      const rustNormalized = toNormalized(rustRun.capture.messages)
      const diff = diffNormalized(nodeNormalized, rustNormalized)

      if (!diff.equal) {
        // eslint-disable-next-line no-console
        console.error(formatDiff(diff, nodeNormalized, rustNormalized))
      }
      expect(diff.equal, formatDiff(diff, nodeNormalized, rustNormalized)).toBe(true)
    },
    120_000,
  )
})
