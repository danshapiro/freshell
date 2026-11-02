import { test, expect } from '../helpers/fixtures.js'
import {
  fetchFreshAgentSnapshot,
  withTwoDeviceSession,
  type FreshAgentMultipleDeviceMode,
} from '../helpers/fresh-agent-multiple-devices.js'

const MODES: FreshAgentMultipleDeviceMode[] = ['freshclaude', 'kilroy', 'freshcodex', 'freshopencode']

function findFreshAgentLeaf(node: any): any {
  if (!node) return null
  if (node.type === 'leaf' && node.content?.kind === 'fresh-agent') return node
  if (node.type === 'split') {
    for (const child of node.children ?? []) {
      const found = findFreshAgentLeaf(child)
      if (found) return found
    }
  }
  return null
}

function countTranscriptRowsWithSummary(
  turns: Array<{ role?: string; summary?: string }>,
  role: 'user' | 'assistant',
  summary: string,
): number {
  return turns.filter((turn) => turn.role === role && turn.summary === summary).length
}

test.describe('Fresh Agent shared sessions across desktop and mobile devices (Rust)', () => {
  test.setTimeout(240_000)

  for (const mode of MODES) {
    test(`stage1 close ${mode}: closing mobile detaches its view and desktop keeps the shared agent`, withTwoDeviceSession(mode, async ({
      desktop,
      mobile,
      native,
      session,
      frames,
    }) => {
      const heldPrompt = 'stage1 shared held prompt'
      const terminatePrompt = 'stage1 terminate held prompt'
      const response = mode === 'freshclaude' || mode === 'kilroy'
        ? 'Stage1 shared response'
        : mode === 'freshcodex'
          ? 'Native streaming fragment and final answer'
          : `Fake OpenCode response: ${heldPrompt}`

      const beforeSnapshot = await fetchFreshAgentSnapshot(native.info, session)
      const beforeTranscriptRows = beforeSnapshot.turns.length
      expect(beforeTranscriptRows).toBeGreaterThanOrEqual(2)

      await native.holdNextTurn()
      await desktop.page.locator('[data-context="fresh-agent"]').last()
        .getByRole('textbox', { name: 'Chat message input' }).fill(heldPrompt)
      await desktop.page.locator('[data-context="fresh-agent"]').last()
        .getByRole('button', { name: 'Send', exact: true }).click()
      await native.waitForHeldTurn(heldPrompt)

      const desktopPane = findFreshAgentLeaf(await desktop.harness.getPaneLayout(desktop.tabId))
      const desktopSessionId = desktopPane?.content?.sessionRef?.sessionId
      expect(desktopSessionId).toBe(session.sessionId)
      expect(mobile.paneId).toBeTruthy()
      expect(mobile.tabId).not.toBe(desktop.tabId)

      const mobileTabCount = await mobile.harness.getTabCount()
      expect(await mobile.harness.getActiveTabId()).toBe(mobile.tabId)
      const mobileFreshAgent = mobile.page.locator('[data-context="fresh-agent"]').last()
      const mobilePane = mobile.page.getByRole('group', { name: /^Pane:/ }).filter({ has: mobileFreshAgent })
      await expect(mobilePane).toHaveCount(1)
      expect(findFreshAgentLeaf(await mobile.harness.getPaneLayout(mobile.tabId))?.content).toMatchObject({
        kind: 'fresh-agent',
        sessionId: session.sessionId,
        sessionRef: { provider: session.provider, sessionId: session.sessionId },
      })
      await mobilePane.getByRole('button', { name: 'Close pane', exact: true }).tap()
      let closeDiagnostic: Record<string, unknown> | undefined
      try {
        await expect.poll(async () => {
          const detaches = frames.mobile.filter((frame) => frame.direction === 'sent'
            && frame.type === 'freshAgent.detach')
          const state = await mobile.harness.getState()
          closeDiagnostic = {
            tabCount: await mobile.harness.getTabCount(),
            activeTabId: state.tabs?.activeTabId,
            detachCount: detaches.length,
            detachSessionIds: detaches.map((frame) => frame.sessionId),
            detachViewIds: detaches.map((frame) => frame.viewId),
            closeInFlight: {
              tab: state.panes?.closingTabs?.[mobile.tabId] === true,
              pane: state.panes?.closingPanes?.[`${mobile.tabId}:${mobile.paneId}`] === true,
            },
            closeError: findFreshAgentLeaf(state.panes?.layouts?.[mobile.tabId])?.content?.closeError ?? null,
            attemptedDetachMessages: (await mobile.harness.getSentWsMessages())
              .filter((message: any) => message?.type === 'freshAgent.detach'),
          }
          return closeDiagnostic
        }, {
          timeout: 15_000,
          message: 'closing the Fresh Agent pane removes its tab and sends a scoped view detach',
        }).toMatchObject({ tabCount: mobileTabCount - 1, detachCount: 1 })
      } catch (error) {
        console.error(`Fresh Agent close diagnostic: ${JSON.stringify(closeDiagnostic)}`)
        throw error
      }
      const detach = frames.mobile.find((frame) => frame.direction === 'sent'
        && frame.type === 'freshAgent.detach'
        && (frame.sessionId === session.sessionId || (frame.sessionRef as { sessionId?: string } | undefined)?.sessionId === session.sessionId))
      expect(detach).toBeTruthy()
      expect(detach?.requestId).toBeTruthy()
      await expect.poll(() => frames.mobile.some((frame) => frame.direction === 'received'
        && frame.type === 'freshAgent.detached'
        && frame.requestId === detach?.requestId
        && frame.viewId === detach?.viewId
        && frame.success === true), {
        timeout: 15_000,
        message: 'mobile received its own detach acknowledgment',
      }).toBe(true)
      await expect.poll(() => mobile.harness.getTabCount(), { timeout: 15_000 }).toBe(mobileTabCount - 1)
      expect(frames.desktop.concat(frames.mobile).some((frame) => frame.direction === 'sent'
        && ['freshAgent.kill', 'freshAgent.recovery.stop'].includes(String(frame.type)))).toBe(false)
      expect(native.stopCount()).toBe(0)
      expect(native.bootCount()).toBe(1)

      await native.releaseTurn()
      await expect(desktop.page.locator('[data-context="fresh-agent"]').last()).toContainText(response, { timeout: 45_000 })
      const expectedTurnRowCount = beforeTranscriptRows + (mode === 'freshcodex' ? 4 : 2)
      await expect.poll(async () => (await fetchFreshAgentSnapshot(native.info, session)).turns.length, {
        timeout: 45_000,
        message: 'the completed native turn appears in the shared transcript snapshot',
      }).toBe(expectedTurnRowCount)
      await expect.poll(async () => {
        const turns = (await fetchFreshAgentSnapshot(native.info, session)).turns
        return countTranscriptRowsWithSummary(turns, 'user', heldPrompt)
          - countTranscriptRowsWithSummary(beforeSnapshot.turns, 'user', heldPrompt)
      }, { timeout: 45_000, message: 'the held user row appears in the shared transcript snapshot' }).toBe(1)
      await expect.poll(async () => {
        const turns = (await fetchFreshAgentSnapshot(native.info, session)).turns
        return countTranscriptRowsWithSummary(turns, 'assistant', response)
          - countTranscriptRowsWithSummary(beforeSnapshot.turns, 'assistant', response)
      }, { timeout: 45_000, message: 'the held answer row appears in the shared transcript snapshot' }).toBe(1)
      const afterSnapshot = await fetchFreshAgentSnapshot(native.info, session)
      expect(afterSnapshot.turns.length).toBe(expectedTurnRowCount)
      expect(
        countTranscriptRowsWithSummary(afterSnapshot.turns, 'user', heldPrompt)
          - countTranscriptRowsWithSummary(beforeSnapshot.turns, 'user', heldPrompt),
      ).toBe(1)
      expect(
        countTranscriptRowsWithSummary(afterSnapshot.turns, 'assistant', response)
          - countTranscriptRowsWithSummary(beforeSnapshot.turns, 'assistant', response),
      ).toBe(1)
      await expect.poll(() => native.bootCount()).toBe(1)
      await expect.poll(() => native.stopCount()).toBe(0)

      // Prove the new explicit action still terminates the shared session.
      await native.holdNextTurn()
      const paneRoot = desktop.page.locator('[data-context="fresh-agent"]').last()
      await paneRoot.getByRole('textbox', { name: 'Chat message input' }).fill(terminatePrompt)
      await paneRoot.getByRole('button', { name: 'Send', exact: true }).click()
      await native.waitForHeldTurn(terminatePrompt)
      await paneRoot.locator('article[data-turn-index]').last().click({ button: 'right' })
      const terminate = desktop.page.getByRole('menuitem', { name: 'Terminate agent' })
      await expect(terminate).toBeVisible({ timeout: 15_000 })
      await terminate.click()

      await expect.poll(() => frames.desktop.some((frame) => frame.direction === 'sent'
        && frame.type === 'freshAgent.kill'
        && frame.sessionId === session.sessionId), {
        timeout: 15_000,
        message: 'the explicit termination action sent the shared kill request',
      }).toBe(true)
      await expect.poll(() => frames.desktop.some((frame) => frame.direction === 'received'
        && frame.type === 'freshAgent.killed'
        && frame.sessionId === session.sessionId), {
        timeout: 15_000,
        message: 'the server acknowledged the explicit shared-session termination',
      }).toBe(true)
      expect(frames.desktop.find((frame) => frame.direction === 'received'
        && frame.type === 'freshAgent.killed'
        && frame.sessionId === session.sessionId)).toMatchObject({ success: true })
      await expect.poll(() => native.stopCount(), { timeout: 30_000 }).toBe(1)
      await expect.poll(async () => {
        const layout = await desktop.harness.getPaneLayout(desktop.tabId)
        return findFreshAgentLeaf(layout)?.content?.status ?? null
      }, { timeout: 30_000, message: 'desktop folds the acknowledged shared termination' }).toBe('exited')
      expect(native.bootCount()).toBe(1)
    }))
  }
})
