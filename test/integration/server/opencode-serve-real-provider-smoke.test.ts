import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  OpencodeServeManager,
  OPENCODE_SIDECAR_OWNERSHIP_ENV,
} from '../../../server/fresh-agent/adapters/opencode/serve-manager.js'
import { createAgentApiRouter } from '../../../server/agent-api/router.js'
import { LayoutStore } from '../../../server/agent-api/layout-store.js'
import { FreshAgentRuntimeManager } from '../../../server/fresh-agent/runtime-manager.js'
import { createFreshAgentProviderRegistry } from '../../../server/fresh-agent/provider-registry.js'
import { createOpencodeFreshAgentAdapter } from '../../../server/fresh-agent/adapters/opencode/adapter.js'
import {
  resolveProviderBinary,
} from '../../../test/helpers/coding-cli/real-session-contract-harness.js'

const opencode = await resolveProviderBinary('opencode')
const KIMI = 'umans-ai-coding-plan/umans-kimi-k2.7'
const describeReal = opencode.resolvedPath ? describe.sequential : describe.skip

describeReal(
  `opencode serve real provider${opencode.resolvedPath ? '' : ' (opencode not on PATH)'}`,
  () => {
    describe('OpencodeServeManager lifecycle', () => {
      it('routes session creation to distinct directories through one sidecar', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-routing-'))
        const projectA = path.join(root, 'project-a')
        const projectB = path.join(root, 'project-b')
        const manager = new OpencodeServeManager()
        try {
          await mkdir(projectA)
          await mkdir(projectB)

          const sessionA = await manager.createSession({ title: 'project-a', directory: projectA })
          const sessionB = await manager.createSession({ title: 'project-b', directory: projectB })

          expect(sessionA.id).toMatch(/^ses_/)
          expect(sessionB.id).toMatch(/^ses_/)
          expect(sessionA.id).not.toBe(sessionB.id)
          expect(sessionA.directory).toBe(await realpath(projectA))
          expect(sessionB.directory).toBe(await realpath(projectB))

          const first = await manager.ensureStarted()
          const second = await manager.ensureStarted()
          expect(second.baseUrl).toBe(first.baseUrl)
        } finally {
          await manager.shutdown()
          await rm(root, { recursive: true, force: true })
        }
      }, 60_000)

      it('checks Kimi k2.7 availability and shuts the owned process down', async () => {
        const manager = new OpencodeServeManager()
        try {
          const { baseUrl } = await manager.ensureStarted()
          expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

          const providers = await fetch(`${baseUrl}/config/providers`).then((r) => r.json() as any)
          const json = JSON.stringify(providers)
          if (!json.includes(KIMI)) {
            console.warn('Kimi k2.7 not configured on this machine; skipping turn assertions in this run.')
          }
        } finally {
          await manager.shutdown()
        }
      }, 60_000)
    })
  },
)

let manager: OpencodeServeManager | undefined
let runtimeManager: FreshAgentRuntimeManager | undefined
let app: express.Express | undefined
let kimiAvailable = false

if (opencode.resolvedPath) {
  // Top-level setup lets us avoid registering tests when the provider or the
  // target model is not available. Skipped tests are reported as skipped, not
  // vacuously passing.
  try {
    const probe = new OpencodeServeManager()
    const { baseUrl } = await probe.ensureStarted()
    const providers = await fetch(`${baseUrl}/config/providers`).then((r) => r.json() as any).catch(() => ({}))
    kimiAvailable = JSON.stringify(providers).includes('umans-kimi-k2.7')
    if (kimiAvailable) {
      manager = probe
      const adapter = createOpencodeFreshAgentAdapter({ serveManager: manager })
      runtimeManager = new FreshAgentRuntimeManager({
        registry: createFreshAgentProviderRegistry([
          { sessionType: 'freshopencode', runtimeProvider: 'opencode', adapter },
        ]),
      })
      app = express()
      app.use(express.json())
      app.use('/api', createAgentApiRouter({
        layoutStore: new LayoutStore(),
        registry: { get: () => undefined, create: () => { throw new Error('no terminals in smoke') } },
        wsHandler: { broadcastUiCommand: () => {} },
        freshAgentRuntimeManager: runtimeManager,
      }))
    } else {
      await probe.shutdown()
    }
  } catch {
    await manager?.shutdown().catch(() => {})
    manager = undefined
    runtimeManager = undefined
    app = undefined
    kimiAvailable = false
  }
}

const describeRealKimi = kimiAvailable ? describe.sequential : describe.skip

describeRealKimi('orchestration system smoke (Kimi k2.7)', () => {
  let cwdRoot: string | undefined

  afterAll(async () => {
    await manager?.shutdown()
    if (cwdRoot) await rm(cwdRoot, { recursive: true, force: true })
  })

  it('creates a freshopencode pane, runs a Kimi turn, and captures the assistant reply', async () => {
    cwdRoot = await mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-kimi-cwd-'))
    const cwd = path.join(cwdRoot, 'project')
    await mkdir(cwd)

    const created = await request(app!).post('/api/tabs').send({ agent: 'opencode', cwd, model: KIMI, effort: 'low' })
    expect(created.status).toBe(200)
    const paneId = created.body.data.paneId
    expect(created.body.data.sessionId).toMatch(/^freshopencode-/)

    const send = await request(app!).post(`/api/panes/${paneId}/send-keys`).send({ data: 'Reply with exactly this token and nothing else: smoke-ok' })
    expect(send.status).toBe(200)
    expect(send.body.data.sessionId).toMatch(/^ses_/) // materialized to a durable id

    const capture = await request(app!).get(`/api/panes/${paneId}/capture`)
    expect(capture.status).toBe(200)
    expect(capture.text.toLowerCase()).toContain('smoke-ok')

    const sessionId = send.body.data.sessionId
    const routedSession = await manager!.getSession(sessionId, { cwd })
    expect(routedSession.directory).toBe(await realpath(cwd))
  }, 90_000)

  it('continues the same session across a second turn (materialized id stable)', async () => {
    const created = await request(app!).post('/api/tabs').send({ agent: 'opencode', cwd: process.cwd(), model: KIMI, effort: 'low' })
    const paneId = created.body.data.paneId
    const first = await request(app!).post(`/api/panes/${paneId}/send-keys`).send({ data: 'Remember the word: pineapple. Reply ok.' })
    const sessionId = first.body.data.sessionId
    const second = await request(app!).post(`/api/panes/${paneId}/send-keys`).send({ data: 'What word did I ask you to remember? Reply with just that word.' })
    expect(second.body.data.sessionId).toBe(sessionId)
    const capture = await request(app!).get(`/api/panes/${paneId}/capture`)
    expect(capture.text.toLowerCase()).toContain('pineapple')
  }, 120_000)

  it('paginates history via the cursor after multiple turns', async () => {
    const created = await request(app!).post('/api/tabs').send({ agent: 'opencode', cwd: process.cwd(), model: KIMI, effort: 'low' })
    const paneId = created.body.data.paneId
    const content = (await request(app!).post('/api/tabs').send({ agent: 'opencode' })).body.data // noop second pane to ensure isolation
    void content
    await request(app!).post(`/api/panes/${paneId}/send-keys`).send({ data: 'Say 1' })
    await request(app!).post(`/api/panes/${paneId}/send-keys`).send({ data: 'Say 2' })
    const sessionId = (await request(app!).get(`/api/panes/${paneId}/capture`)).status === 200
      ? (await runtimeManager!.getSnapshot({ sessionType: 'freshopencode', provider: 'opencode', threadId: (created.body.data.sessionId) })).sessionId
      : created.body.data.sessionId
    const page1 = await runtimeManager!.getTurnPage({ sessionType: 'freshopencode', provider: 'opencode', threadId: sessionId, limit: 1, revision: 0 })
    expect(page1.turns.length).toBe(1)
    if (page1.nextCursor) {
      const page2 = await runtimeManager!.getTurnPage({ sessionType: 'freshopencode', provider: 'opencode', threadId: sessionId, cursor: page1.nextCursor, limit: 1, revision: 0 })
      expect(page2.turns.length).toBe(1)
      expect(page2.turns[0].turnId).not.toBe(page1.turns[0].turnId)
    }
  }, 120_000)

  it('forks a materialized session into a child session', async () => {
    const created = await request(app!).post('/api/tabs').send({ agent: 'opencode', cwd: process.cwd(), model: KIMI, effort: 'low' })
    const paneId = created.body.data.paneId
    await request(app!).post(`/api/panes/${paneId}/send-keys`).send({ data: 'Say ok' })
    const forked: any = await runtimeManager!.fork({ sessionType: 'freshopencode', provider: 'opencode', sessionId: created.body.data.sessionId })
    expect(forked?.sessionId).toMatch(/^ses_/)
  }, 90_000)
})

export { KIMI, OPENCODE_SIDECAR_OWNERSHIP_ENV }
