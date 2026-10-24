// Production sidecar + CLI simulator + Rust + browser: a quiet turn rings
// once, recovery preserves the conversation, and an approval pauses the timer.
import { test, expect } from '../helpers/fixtures.js'
import { ClaudeSimLane, freshAgentLeaf, onPrompt } from '../helpers/claude-sim-lane.js'

test.describe('freshclaude quiet timeout and process recovery', () => {
  test.setTimeout(180_000)

  for (const flavour of ['freshclaude', 'kilroy'] as const) {
    test(`${flavour}: stuck recovery keeps the session and approvals pause the timeout`, async ({ browser }) => {
      const windowMs = 2_000
      const lane = await ClaudeSimLane.start(browser, {
        flavour,
        providerDefaults: { defaultPermissionMode: 'default' },
        env: { FRESHELL_FRESHCLAUDE_QUIET_WINDOW_MS: String(windowMs) },
        program: { rules: [
          onPrompt('hang until process recovery', [{ kind: 'hang' }]),
          onPrompt('wait for my approval', [
            { kind: 'approval', data: { tool: 'Bash', input: { command: 'printf approved' } } },
            { kind: 'text', data: { text: 'approval completed' } },
          ]),
        ] },
      })
      const frames: Array<{ direction: 'sent' | 'received'; message: Record<string, any> }> = []
      lane.page.on('websocket', (socket) => {
        for (const direction of ['sent', 'received'] as const) {
          socket.on(direction === 'sent' ? 'framesent' : 'framereceived', (frame) => {
            try { frames.push({ direction, message: JSON.parse(String(frame.payload)) }) } catch { /* non-JSON frames */ }
          })
        }
      })
      // This page's socket already exists. Reconnect before the first pane so
      // the trace observes the same real transport the recovery button uses.
      try {
        await lane.harness.forceDisconnect()
        await lane.harness.waitForConnection()
        const pane = await lane.openPane()
        const leaf = async () => freshAgentLeaf(await lane.harness.getPaneLayout(pane.tabId))
        const sequence = async () => (await lane.harness.getState())?.turnCompletion?.seq ?? 0
        await lane.send(pane, 'save a turn before recovery')
        await lane.waitForIdle(pane)
        const id = (await leaf()).content.sessionId
        expect(id).toMatch(/^[0-9a-f-]{36}$/)
        const before = await sequence()
        await lane.send(pane, 'hang until process recovery')
        const stuck = pane.paneRoot.getByRole('alert').filter({ hasText: /appears stuck/i })
        await expect(stuck).toBeVisible({ timeout: 30_000 })
        await expect.poll(sequence).toBe(before + 1)
        const atBefore = (await lane.harness.getState())?.turnCompletion?.lastAtByTerminalId?.[`claude:${id}`]
        expect(atBefore).toBeGreaterThan(0)

        await stuck.getByRole('button', { name: /restart sidecar and resume session/i }).click()
        await lane.waitForIdle(pane)
        await expect(stuck).toBeHidden()
        expect((await leaf()).content).toMatchObject({ sessionId: id, sessionType: flavour, provider: 'claude' })
        expect(await sequence(), 'the requested process stop adds no completion').toBe(before + 1)
        const stopAt = frames.findIndex(({ direction, message }) => direction === 'sent'
          && message.type === 'freshAgent.recovery.stop' && message.sessionId === id)
        expect(stopAt, 'the client used process recovery').toBeGreaterThanOrEqual(0)
        const stop = frames[stopAt].message
        expect(stop).toMatchObject({ provider: 'claude', sessionType: flavour })
        const ackAt = frames.findIndex(({ direction, message }) => direction === 'received'
          && message.type === 'freshAgent.recovery.stopped' && message.requestId === stop.requestId && message.success)
        const resumeAt = frames.findIndex(({ direction, message }, index) => index > stopAt && direction === 'sent'
          && message.type === 'freshAgent.create')
        expect(ackAt, 'the stop is confirmed before the replacement create').toBeGreaterThan(stopAt)
        expect(resumeAt).toBeGreaterThan(ackAt)
        expect(frames.slice(stopAt, resumeAt).some(({ message }) => message.type === 'freshAgent.kill')).toBe(false)
        const queries = lane.ledger().filter((row) => row.kind === 'query')
        expect(queries).toHaveLength(2)
        expect(queries[1].options).toMatchObject({ resume: id })
        await expect(pane.paneRoot.getByRole('article', { name: /You transcript turn$/ })
          .filter({ hasText: 'save a turn before recovery' })).toHaveCount(1)

        await lane.send(pane, 'continue the recovered conversation')
        await lane.waitForIdle(pane)
        await expect.poll(sequence).toBe(before + 2)
        expect((await lane.harness.getState())?.turnCompletion?.lastAtByTerminalId?.[`claude:${id}`])
          .toBeGreaterThan(atBefore)

        await lane.send(pane, 'wait for my approval')
        const approval = pane.paneRoot.getByRole('alert', { name: 'Permission request for Bash' })
        await expect(approval).toBeVisible({ timeout: 30_000 })
        await expect.poll(sequence).toBe(before + 3)
        const waitingSequence = await sequence()
        // Deliberately outwait the quiet window while the real pending control
        // stays unanswered; a timer that ignores pending controls fails here.
        await lane.page.waitForTimeout(windowMs * 2)
        await expect(approval).toBeVisible()
        await expect(stuck).toBeHidden()
        expect(await sequence()).toBe(waitingSequence)
        await approval.getByRole('button', { name: 'Allow tool use' }).click()
        await lane.waitForIdle(pane)
        await expect(pane.paneRoot.getByText('approval completed', { exact: true })).toBeVisible()
      } finally {
        await lane.attachLogsOnFailure(test.info())
        await lane.stop()
      }
    })
  }
})
