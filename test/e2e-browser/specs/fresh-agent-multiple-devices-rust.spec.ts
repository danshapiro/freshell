import { randomUUID } from 'node:crypto'
import { test, expect } from '../helpers/fixtures.js'
import {
  analyzeFreshAgentAttachRounds,
  type FreshAgentAttachRoundAnalysis,
  type FreshAgentAttachRoundTarget,
} from '../helpers/fresh-agent-attach-rounds.js'
import {
  fetchFreshAgentSnapshot,
  FORK_PARENT_CONTINUATION_PROMPT,
  withTwoDeviceSession,
  type FreshAgentMultipleDeviceMode,
} from '../helpers/fresh-agent-multiple-devices.js'

type JsonRow = Record<string, unknown>

const MODES: FreshAgentMultipleDeviceMode[] = ['freshclaude', 'kilroy', 'freshcodex', 'freshopencode']

type FreshAgentDeviceView = {
  harness: { getPaneLayout(tabId: string): Promise<any> }
  tabId: string
}

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

async function waitForPaneStatus(device: FreshAgentDeviceView, status: RegExp): Promise<void> {
  await expect.poll(async () => {
    const pane = findFreshAgentLeaf(await device.harness.getPaneLayout(device.tabId))
    return pane?.content?.status ?? null
  }, {
    timeout: 45_000,
    message: 'the device view reaches the expected shared-session status',
  }).toMatch(status)
}

function countTranscriptRowsWithSummary(
  turns: Array<{ role?: string; summary?: string }>,
  role: 'user' | 'assistant',
  summary: string,
): number {
  return turns.filter((turn) => turn.role === role && turn.summary === summary).length
}

function targetAttachProgressSignature(
  frames: ReadonlyArray<Record<string, unknown>>,
  target: FreshAgentAttachRoundTarget,
): string {
  const attachCount = frames.filter((frame) => frame.direction === 'sent'
    && frame.type === 'freshAgent.attach'
    && frame.sessionId === target.sessionId
    && frame.provider === target.provider
    && frame.sessionType === target.sessionType
    && frame.viewId === target.viewId
    && frame.tabId === target.tabId
    && frame.paneId === target.paneId).length
  const reservedCount = frames.filter((frame) => {
    if (frame.direction !== 'received' || frame.type !== 'freshAgent.event'
      || frame.sessionId !== target.sessionId || frame.provider !== target.provider
      || frame.sessionType !== target.sessionType) return false
    const event = frame.event as Record<string, unknown> | undefined
    return event?.type === 'freshAgent.error'
      && event.code === 'SESSION_RESERVED'
      && event.requestId === undefined
      && event.rollback !== true
  }).length
  return [attachCount, reservedCount].join(':')
}

async function waitForAttachRoundQuiet(
  frames: ReadonlyArray<Record<string, unknown>>,
  target: FreshAgentAttachRoundTarget,
): Promise<void> {
  let lastSignature = targetAttachProgressSignature(frames, target)
  let stableSince = Date.now()
  await expect.poll(() => {
    const nextSignature = targetAttachProgressSignature(frames, target)
    if (nextSignature !== lastSignature) {
      lastSignature = nextSignature
      stableSince = Date.now()
    }
    return Date.now() - stableSince >= 1_500
  }, {
    timeout: 35_000,
    intervals: [250],
    message: 'target attach and SESSION_RESERVED retry traffic becomes quiet',
  }).toBe(true)
}

test.describe('Fresh Agent shared sessions across desktop and mobile devices (Rust)', () => {
  test.setTimeout(240_000)

  for (const mode of MODES) {
    test(`stage1 cancellation ${mode}: a late create detaches only its canceled view after mobile joins`, withTwoDeviceSession(mode, async ({
      desktop,
      mobile,
      native,
      session,
      frames,
      openView,
    }) => {
      const previousStops = native.stopCount()
      const desktopTabCount = await desktop.harness.getTabCount()
      const siblingBrowserPaneId = 'stage1-cancel-browser-sibling'
      await desktop.page.evaluate(({ tabId, paneId, newPaneId }) => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({
          type: 'panes/splitPane',
          payload: {
            tabId,
            paneId,
            direction: 'horizontal',
            newPaneId,
            newContent: { kind: 'browser', url: 'about:blank', devToolsOpen: false },
          },
        })
      }, { tabId: desktop.tabId, paneId: desktop.paneId, newPaneId: siblingBrowserPaneId })
      await expect.poll(async () => {
        const layout = await desktop.harness.getPaneLayout(desktop.tabId)
        return layout?.type === 'split' && layout.children?.some((child: any) => child.id === siblingBrowserPaneId)
      }, { timeout: 15_000, message: 'desktop keeps a sibling pane so cancellation uses the single-pane close path' })
        .toBe(true)
      const composer = desktop.page.locator('[data-context="fresh-agent"]').last()
        .getByRole('textbox', { name: 'Chat message input' })
      const createMessagesBeforeNew = frames.desktop.filter((frame) => frame.direction === 'sent'
        && frame.type === 'freshAgent.create').length
      desktop.createdReplies.holdNext()
      await composer.fill('/new')
      await composer.press('Enter')
      await expect.poll(() => frames.desktop.filter((frame) => frame.direction === 'sent'
        && frame.type === 'freshAgent.create').length, {
        timeout: 20_000,
        message: 'the new-conversation action sends a create request after releasing its prior view',
      }).toBeGreaterThan(createMessagesBeforeNew)
      const lateCreated = await desktop.createdReplies.waitForHeld(30_000)
      expect(lateCreated).toMatchObject({
        type: 'freshAgent.created',
        sessionType: mode,
        provider: session.provider,
        requestId: expect.any(String),
        sessionId: expect.any(String),
      })
      const newSessionId = lateCreated.sessionId as string
      expect(newSessionId).not.toBe(session.sessionId)
      const create = frames.desktop.find((frame) => frame.direction === 'sent'
        && frame.type === 'freshAgent.create'
        && frame.requestId === lateCreated.requestId)
      expect(create?.viewId).toEqual(expect.any(String))
      const cancelledViewId = create?.viewId as string
      await expect.poll(async () => {
        const leaf = findFreshAgentLeaf(await desktop.harness.getPaneLayout(desktop.tabId))
        return leaf?.content?.createRequestId ?? null
      }, { timeout: 20_000, message: 'the new conversation create is pending on desktop' }).toBe(lateCreated.requestId)

      const pendingPane = desktop.page.getByRole('group', { name: /^Pane:/ }).filter({
        has: desktop.page.locator('[data-context="fresh-agent"]').last(),
      })
      await pendingPane.getByRole('button', { name: 'Close pane', exact: true }).click()
      await expect.poll(() => desktop.harness.getTabCount(), {
        timeout: 20_000,
        message: 'closing the creating pane preserves its tab and sibling browser view',
      }).toBe(desktopTabCount)
      await expect.poll(async () => findFreshAgentLeaf(await desktop.harness.getPaneLayout(desktop.tabId)), {
        timeout: 20_000,
        message: 'closing the creating pane removes only that local Fresh Agent view',
      }).toBeNull()

      const mobileNewView = await openView('mobile', newSessionId)
      await expect.poll(async () => findFreshAgentLeaf(await mobileNewView.harness.getPaneLayout(mobileNewView.tabId))?.content?.status ?? null, {
        timeout: 45_000,
        message: 'mobile attaches to the server-owned session before desktop receives its late result',
      }).toBe('idle')
      await expect.poll(() => frames.mobile.some((frame) => frame.direction === 'sent'
        && frame.type === 'freshAgent.attach'
        && frame.sessionId === newSessionId), {
        timeout: 20_000,
        message: 'mobile joined the server-owned session before desktop received its late create result',
      }).toBe(true)

      desktop.createdReplies.release()
      let detach: JsonRow | undefined
      await expect.poll(() => {
        detach = frames.desktop.find((frame) => frame.direction === 'sent'
          && frame.type === 'freshAgent.detach'
          && frame.sessionId === newSessionId
          && frame.viewId === cancelledViewId)
        return Boolean(detach)
      }, {
        timeout: 20_000,
        message: 'the canceled create result releases only its original view',
      }).toBe(true)
      expect(detach).toMatchObject({ sessionId: newSessionId, viewId: cancelledViewId })
      await expect.poll(() => frames.desktop.some((frame) => frame.direction === 'received'
        && frame.type === 'freshAgent.detached'
        && frame.requestId === detach?.requestId
        && frame.viewId === cancelledViewId
        && frame.success === true), {
        timeout: 20_000,
        message: 'desktop receives confirmation for the canceled view only',
      }).toBe(true)
      const mobileAttachesBeforeReload = frames.mobile.filter((frame) => frame.direction === 'sent'
        && frame.type === 'freshAgent.attach'
        && frame.sessionId === newSessionId).length
      await mobileNewView.page.reload()
      await mobileNewView.harness.waitForHarness(15_000)
      await mobileNewView.harness.waitForConnection(45_000)
      await expect.poll(async () => findFreshAgentLeaf(await mobileNewView.harness.getPaneLayout(mobileNewView.tabId))?.content?.status ?? null, {
        timeout: 45_000,
        message: 'the surviving mobile view restores to a connected or idle state after reload',
      }).toMatch(/^(connected|idle)$/)
      await expect.poll(() => frames.mobile.filter((frame) => frame.direction === 'sent'
        && frame.type === 'freshAgent.attach'
        && frame.sessionId === newSessionId).length, {
        timeout: 20_000,
        message: 'the surviving mobile view restores the shared session after reload',
      }).toBeGreaterThan(mobileAttachesBeforeReload)
      expect(frames.desktop.concat(frames.mobile).some((frame) => frame.direction === 'sent'
        && frame.type === 'freshAgent.kill'
        && frame.sessionId === newSessionId)).toBe(false)
      expect(native.stopCount()).toBe(previousStops)
      const heldPrompt = 'stage1 shared held prompt'
      const response = mode === 'freshclaude' || mode === 'kilroy'
        ? 'Stage1 shared response'
        : mode === 'freshcodex'
          ? 'Native streaming fragment and final answer'
          : `Fake OpenCode response: ${heldPrompt}`
      const targetBeforeSend = { provider: session.provider, sessionType: mode, sessionId: newSessionId }
      const beforeSnapshot = await fetchFreshAgentSnapshot(native.info, targetBeforeSend)
      const desktopNewView = await openView('desktop', newSessionId)
      await expect.poll(async () => findFreshAgentLeaf(await desktopNewView.harness.getPaneLayout(desktopNewView.tabId))?.content?.status ?? null, {
        timeout: 45_000,
        message: 'desktop can reattach to the server-owned new conversation after the canceled view is removed',
      }).toBe('idle')
      await native.holdNextTurn(newSessionId)
      await desktopNewView.page.locator('[data-context="fresh-agent"]').last()
        .getByRole('textbox', { name: 'Chat message input' }).fill(heldPrompt)
      await desktopNewView.page.locator('[data-context="fresh-agent"]').last()
        .getByRole('button', { name: 'Send', exact: true }).click()
      await expect.poll(() => frames.desktop.some((frame) => frame.direction === 'sent'
        && frame.type === 'freshAgent.send'
        && frame.sessionId === newSessionId
        && frame.text === heldPrompt), {
        timeout: 20_000,
        message: 'the reattached desktop view submits the prompt to the server-owned new conversation',
      }).toBe(true)
      const nativeSessionId = await native.waitForHeldTurn(heldPrompt, newSessionId)
      const targetSession = { ...targetBeforeSend, sessionId: nativeSessionId }
      if (mode === 'freshopencode') {
        const materializedOnDesktop = () => frames.desktop.find((frame) => frame.direction === 'received'
          && frame.type === 'freshAgent.session.materialized'
          && frame.previousSessionId === newSessionId
          && frame.sessionId === nativeSessionId)
        const materializedOnMobile = () => frames.mobile.find((frame) => frame.direction === 'received'
          && frame.type === 'freshAgent.session.materialized'
          && frame.previousSessionId === newSessionId
          && frame.sessionId === nativeSessionId)
        await expect.poll(materializedOnDesktop, {
          timeout: 20_000,
          message: 'desktop follows OpenCode materialization to the provider session id',
        }).toBeTruthy()
        await expect.poll(materializedOnMobile, {
          timeout: 20_000,
          message: 'mobile follows OpenCode materialization while its shared view remains attached',
        }).toBeTruthy()
      }
      await expect.poll(async () => findFreshAgentLeaf(await mobileNewView.harness.getPaneLayout(mobileNewView.tabId))?.content?.sessionRef?.sessionId)
        .toBe(nativeSessionId)
      await native.releaseTurn()
      await expect(mobileNewView.page.locator('[data-context="fresh-agent"]').last()).toContainText(response, { timeout: 45_000 })
      const afterSnapshot = await fetchFreshAgentSnapshot(native.info, targetSession)
      expect(countTranscriptRowsWithSummary(afterSnapshot.turns, 'user', heldPrompt)
        - countTranscriptRowsWithSummary(beforeSnapshot.turns, 'user', heldPrompt)).toBe(1)
      expect(countTranscriptRowsWithSummary(afterSnapshot.turns, 'assistant', response)
        - countTranscriptRowsWithSummary(beforeSnapshot.turns, 'assistant', response)).toBe(1)
      expect(native.stopCount()).toBe(previousStops)
      expect(mode === 'freshopencode' ? native.bootCount() : native.bootCount(nativeSessionId)).toBe(1)
      expect(native.stopCount(nativeSessionId)).toBe(0)
      expect(findFreshAgentLeaf(await mobile.harness.getPaneLayout(mobileNewView.tabId))?.content?.sessionRef?.sessionId).toBe(nativeSessionId)
    }))
  }

  for (const mode of MODES) {
    test(`stage1 switches ${mode}: desktop starts fresh while mobile keeps a streaming parent`, withTwoDeviceSession(mode, async ({
      desktop,
      mobile,
      native,
      session,
      frames,
    }) => {
      const heldPrompt = 'stage1 shared held prompt'
      const response = mode === 'freshclaude' || mode === 'kilroy'
        ? 'Stage1 shared response'
        : mode === 'freshcodex'
          ? 'Native streaming fragment and final answer'
          : `Fake OpenCode response: ${heldPrompt}`
      const originalBoots = native.bootCount(session.sessionId)
      const beforeSnapshot = await fetchFreshAgentSnapshot(native.info, session)
      await native.holdNextTurn()
      await desktop.page.locator('[data-context="fresh-agent"]').last()
        .getByRole('textbox', { name: 'Chat message input' }).fill(heldPrompt)
      await desktop.page.locator('[data-context="fresh-agent"]').last()
        .getByRole('button', { name: 'Send', exact: true }).click()
      await native.waitForHeldTurn(heldPrompt)

      const composer = desktop.page.locator('[data-context="fresh-agent"]').last()
        .getByRole('textbox', { name: 'Chat message input' })
      await composer.fill('/new')
      await composer.press('Enter')
      await expect.poll(() => frames.desktop.some((frame) => frame.direction === 'sent'
        && frame.type === 'freshAgent.detach'
        && frame.sessionId === session.sessionId), {
        timeout: 20_000,
        message: 'desktop releases only its parent view before the held turn is released',
      }).toBe(true)
      expect(frames.desktop.concat(frames.mobile).some((frame) => frame.direction === 'sent'
        && frame.type === 'freshAgent.kill'
        && frame.sessionId === session.sessionId)).toBe(false)
      expect(findFreshAgentLeaf(await mobile.harness.getPaneLayout(mobile.tabId))?.content?.sessionRef?.sessionId).toBe(session.sessionId)

      // Release promptly after A detaches so the provider’s bounded prompt
      // request is not held up by the new conversation’s independent startup.
      await native.releaseTurn()
      await expect(mobile.page.locator('[data-context="fresh-agent"]').last()).toContainText(response, { timeout: 45_000 })
      await expect.poll(async () => {
        const leaf = findFreshAgentLeaf(await desktop.harness.getPaneLayout(desktop.tabId))
        return leaf?.content?.sessionRef?.sessionId ?? null
      }, {
        timeout: 30_000,
        message: 'desktop switches to a newly created conversation after its own view detaches',
      }).not.toBe(session.sessionId)
      expect(frames.desktop.concat(frames.mobile).some((frame) => frame.direction === 'sent'
        && frame.type === 'freshAgent.kill'
        && frame.sessionId === session.sessionId)).toBe(false)
      expect(findFreshAgentLeaf(await mobile.harness.getPaneLayout(mobile.tabId))?.content?.sessionRef?.sessionId).toBe(session.sessionId)
      expect(native.bootCount(session.sessionId)).toBe(originalBoots)

      await expect.poll(async () => {
        const snapshot = await fetchFreshAgentSnapshot(native.info, session)
        return {
          user: countTranscriptRowsWithSummary(snapshot.turns, 'user', heldPrompt)
            - countTranscriptRowsWithSummary(beforeSnapshot.turns, 'user', heldPrompt),
          assistant: countTranscriptRowsWithSummary(snapshot.turns, 'assistant', response)
            - countTranscriptRowsWithSummary(beforeSnapshot.turns, 'assistant', response),
        }
      }, { timeout: 45_000, message: 'the parent turn is recorded once after desktop changes its view' })
        .toEqual({ user: 1, assistant: 1 })
      expect(native.stopCount()).toBe(0)
      expect(native.bootCount(session.sessionId)).toBe(originalBoots)
    }))
  }

  for (const mode of MODES) {
    test(`stage1 switches fork ${mode}: desktop repoints while mobile keeps the parent`, withTwoDeviceSession(mode, async ({
      desktop,
      mobile,
      native,
      session,
      frames,
      openView,
    }) => {
      const heldPrompt = 'stage1 shared held prompt'
      const response = mode === 'freshclaude' || mode === 'kilroy'
        ? 'Stage1 shared response'
        : mode === 'freshcodex'
          ? 'Native streaming fragment and final answer'
          : `Fake OpenCode response: ${heldPrompt}`
      const parentBoots = native.bootCount(session.sessionId)
      const beforeSnapshot = await fetchFreshAgentSnapshot(native.info, session)
      await native.holdNextTurn()
      await desktop.page.locator('[data-context="fresh-agent"]').last()
        .getByRole('textbox', { name: 'Chat message input' }).fill(heldPrompt)
      await desktop.page.locator('[data-context="fresh-agent"]').last()
        .getByRole('button', { name: 'Send', exact: true }).click()
      await native.waitForHeldTurn(heldPrompt)
      await native.releaseTurn()
      await expect(mobile.page.locator('[data-context="fresh-agent"]').last()).toContainText(response, { timeout: 45_000 })
      await expect.poll(async () => ({
        desktop: findFreshAgentLeaf(await desktop.harness.getPaneLayout(desktop.tabId))?.content?.status ?? null,
        mobile: findFreshAgentLeaf(await mobile.harness.getPaneLayout(mobile.tabId))?.content?.status ?? null,
      }), { timeout: 45_000, message: 'both parent views settle before the transcript fork action' })
        .toEqual({ desktop: 'idle', mobile: 'idle' })
      const parentUserTurn = desktop.page.locator(
        '[data-context="fresh-agent"] article[data-turn-role="user"]',
      ).filter({ hasText: heldPrompt }).first()
      await expect(parentUserTurn).toBeVisible({ timeout: 20_000 })
      await parentUserTurn.hover({ timeout: 20_000 })
      const forkButton = parentUserTurn.getByRole('button', { name: 'Fork conversation from here' })
      await expect(forkButton).toBeVisible({ timeout: 20_000 })
      await forkButton.click({ timeout: 20_000 })
      await expect.poll(() => frames.desktop.some((frame) => frame.direction === 'sent'
        && frame.type === 'freshAgent.fork'
        && frame.sessionId === session.sessionId), {
        timeout: 20_000,
        message: 'desktop forks the settled parent while mobile remains attached',
      }).toBe(true)
      let forkReply: JsonRow | undefined
      await expect.poll(() => {
        forkReply = frames.desktop.find((frame) => frame.direction === 'received'
          && frame.type === 'freshAgent.forked'
          && frame.parentSessionId === session.sessionId)
        return forkReply?.sessionId ?? null
      }, { timeout: 45_000, message: 'desktop receives the provider fork result for its parent view' })
        .not.toBeNull()
      expect(forkReply?.sessionId).toEqual(expect.any(String))
      expect(forkReply?.sessionId).not.toBe(session.sessionId)
      // These provider fixtures fork beside the source. Managed runtimes that
      // retire a parent are a separate authoritative outcome covered by the
      // parentRetiredByRuntime unit case.
      expect(forkReply?.parentRetiredByRuntime).not.toBe(true)
      await expect.poll(async () => {
        const leaf = findFreshAgentLeaf(await desktop.harness.getPaneLayout(desktop.tabId))
        return leaf?.content?.sessionRef?.sessionId ?? null
      }, { timeout: 30_000, message: 'only the desktop pane repoints to the fork child' })
        .toBe(forkReply?.sessionId)
      expect(frames.desktop.some((frame) => frame.direction === 'sent'
        && frame.type === 'freshAgent.detach'
        && frame.sessionId === session.sessionId)).toBe(true)
      expect(frames.desktop.concat(frames.mobile).some((frame) => frame.direction === 'sent'
        && frame.type === 'freshAgent.kill'
        && frame.sessionId === session.sessionId)).toBe(false)
      expect(findFreshAgentLeaf(await mobile.harness.getPaneLayout(mobile.tabId))?.content?.sessionRef?.sessionId)
        .toBe(session.sessionId)
      expect(native.bootCount(session.sessionId)).toBe(parentBoots)

      const beforeParentContinuation = await fetchFreshAgentSnapshot(native.info, session)
      expect(countTranscriptRowsWithSummary(beforeParentContinuation.turns, 'user', heldPrompt)
        - countTranscriptRowsWithSummary(beforeSnapshot.turns, 'user', heldPrompt)).toBe(1)
      expect(countTranscriptRowsWithSummary(beforeParentContinuation.turns, 'assistant', response)
        - countTranscriptRowsWithSummary(beforeSnapshot.turns, 'assistant', response)).toBe(1)

      const continuationPrompt = FORK_PARENT_CONTINUATION_PROMPT
      const continuationResponse = mode === 'freshclaude' || mode === 'kilroy'
        ? 'Stage1 shared response'
        : mode === 'freshcodex'
          ? 'Native streaming fragment and final answer'
          : `Fake OpenCode response: ${continuationPrompt}`
      const desktopParentView = await openView('desktop', session.sessionId)
      await expect.poll(async () => findFreshAgentLeaf(await desktopParentView.harness.getPaneLayout(desktopParentView.tabId))?.content?.status ?? null, {
        timeout: 45_000,
        message: 'desktop can reattach to the parent conversation while mobile keeps its view',
      }).toBe('idle')
      await native.holdNextTurn()
      await desktopParentView.page.locator('[data-context="fresh-agent"]').last()
        .getByRole('textbox', { name: 'Chat message input' }).fill(continuationPrompt)
      await desktopParentView.page.locator('[data-context="fresh-agent"]').last()
        .getByRole('button', { name: 'Send', exact: true }).click()
      await native.waitForHeldTurn(continuationPrompt)
      await native.releaseTurn()
      await expect(mobile.page.locator('[data-context="fresh-agent"]').last())
        .toContainText(continuationResponse, { timeout: 45_000 })
      await expect.poll(async () => {
        const afterSnapshot = await fetchFreshAgentSnapshot(native.info, session)
        return {
          user: countTranscriptRowsWithSummary(afterSnapshot.turns, 'user', continuationPrompt)
            - countTranscriptRowsWithSummary(beforeParentContinuation.turns, 'user', continuationPrompt),
          assistant: countTranscriptRowsWithSummary(afterSnapshot.turns, 'assistant', continuationResponse)
            - countTranscriptRowsWithSummary(beforeParentContinuation.turns, 'assistant', continuationResponse),
        }
      }, { timeout: 45_000, message: 'the parent continuation appears once in the shared transcript snapshot' })
        .toEqual({ user: 1, assistant: 1 })

      if (mode === 'freshclaude' || mode === 'kilroy') {
        const childSessionId = forkReply?.sessionId as string
        const childView = await openView('desktop', childSessionId)
        await expect.poll(async () => findFreshAgentLeaf(await childView.harness.getPaneLayout(childView.tabId))?.content?.status ?? null, {
          timeout: 45_000,
          message: 'the desktop can open the fork child before explicitly terminating it',
        }).toBe('idle')
        const childTurn = childView.page.locator(
          `[data-context="fresh-agent"][data-pane-id="${childView.paneId}"] article[data-turn-index]`,
        ).last()
        await expect(childTurn).toBeVisible({ timeout: 20_000 })
        await childTurn.click({ button: 'right' })
        const terminateAgent = childView.page.getByRole('menuitem', { name: 'Terminate agent', exact: true })
        await expect(terminateAgent).toBeVisible({ timeout: 15_000 })
        await terminateAgent.click()

        await expect.poll(() => native.stopCount(childSessionId), {
          timeout: 30_000,
          message: 'the native stop counter reports the explicitly terminated fork child',
        }).toBe(1)
        expect(native.stopCount(session.sessionId), 'the parent remains running on mobile').toBe(0)
        expect(frames.desktop.filter((frame) => frame.direction === 'sent'
          && frame.type === 'freshAgent.kill'
          && frame.sessionId === childSessionId)).toHaveLength(1)
        expect(findFreshAgentLeaf(await mobile.harness.getPaneLayout(mobile.tabId))?.content?.sessionRef?.sessionId)
          .toBe(session.sessionId)
      }

      expect(native.bootCount(session.sessionId)).toBe(parentBoots)
    }))
  }

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
      if (mode === 'freshopencode') {
        await expect.poll(async () => {
          const layout = await desktop.harness.getPaneLayout(desktop.tabId)
          return findFreshAgentLeaf(layout)?.content?.status ?? null
        }, {
          timeout: 30_000,
          message: 'desktop converges to idle after the OpenCode prompt gate releases and rows persist',
        }).toBe('idle')
      }
      await expect.poll(() => native.bootCount()).toBe(1)
      await expect.poll(() => native.stopCount()).toBe(0)

      // Prove the new explicit action still terminates the shared session.
      const paneRoot = desktop.page.locator('[data-context="fresh-agent"]').last()
      const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
      if (mode === 'freshcodex') {
        await expect.poll(async () => {
          const [state, snapshot] = await Promise.all([
            desktop.harness.getState(),
            fetchFreshAgentSnapshot(native.info, session),
          ])
          const sessions = Object.values(state.freshAgent?.sessions ?? {}) as Array<{
            provider?: string
            sessionType?: string
            sessionId?: string
            status?: string
          }>
          const ownedSession = sessions.find((candidate) =>
            candidate.provider === session.provider
            && candidate.sessionType === session.sessionType
            && candidate.sessionId === session.sessionId)
          return {
            status: ownedSession?.status ?? null,
            canSend: snapshot.capabilities?.send ?? false,
          }
        }, {
          timeout: 30_000,
          message: 'Codex publishes idle and send-enabled state before the next held prompt',
        }).toEqual({ status: 'idle', canSend: true })
        await expect(composer).toBeEnabled()
      }
      await native.holdNextTurn()
      await composer.fill(terminatePrompt)
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

  for (const mode of MODES) {
    test(`stage1 dead binding ${mode}: desktop and mobile recover once, then send and configure`, withTwoDeviceSession(mode, async ({
      desktop,
      mobile,
      native,
      session,
      frames,
      restartWithDeadTerminalBinding,
      restartServer,
    }) => {
      const startCountBefore = native.runtimeStartCount(session.sessionId)
      const desktopReadyBefore = await desktop.harness.getLastReadyAt()
      const mobileReadyBefore = await mobile.harness.getLastReadyAt()
      const desktopFrameCountBefore = frames.desktop.length
      const mobileFrameCountBefore = frames.mobile.length
      const targetFor = (device: {
        viewId: string
        tabId: string
        paneId: string
      }): FreshAgentAttachRoundTarget => ({
        sessionId: session.sessionId,
        provider: session.provider,
        sessionType: session.sessionType,
        viewId: device.viewId,
        tabId: device.tabId,
        paneId: device.paneId,
      })
      const baselineFor = (
        analysis: FreshAgentAttachRoundAnalysis,
        baselineFrameCount: number,
      ) => analysis.rounds.flatMap((round) => round.attachments)
        .filter((attachment) => attachment.frameIndex < baselineFrameCount)
      const desktopBaseline = baselineFor(
        analyzeFreshAgentAttachRounds(frames.desktop, targetFor(desktop)),
        desktopFrameCountBefore,
      )
      const mobileBaseline = baselineFor(
        analyzeFreshAgentAttachRounds(frames.mobile, targetFor(mobile)),
        mobileFrameCountBefore,
      )
      expect(desktopBaseline.length, 'desktop target pane had attached before server recovery').toBeGreaterThan(0)
      expect(mobileBaseline.length, 'mobile target pane had attached before server recovery').toBeGreaterThan(0)
      expect(desktopBaseline.some((tuple) => tuple.observedEpoch === 1
        && tuple.observedGeneration === 1), 'desktop baseline attach carries the original owner fence').toBe(true)
      expect(mobileBaseline.some((tuple) => tuple.observedEpoch === 1
        && tuple.observedGeneration === 1), 'mobile baseline attach carries the original owner fence').toBe(true)

      // Seed a settings value before recovery. The restart helper adds a
      // durable failed-transition fence for this generation, then recovery
      // restores a newer legitimate owner. The later configure must cross
      // that fence and survive a second server restart.
      await desktop.page.evaluate(({ provider, sessionType, sessionId }) => {
        window.__FRESHELL_TEST_HARNESS__?.sendWsMessage({
          type: 'freshAgent.configure',
          requestId: 'stage1-dead-binding-configure-baseline',
          provider,
          sessionType,
          sessionId,
          settings: { effort: 'low' },
        })
      }, session)
      for (const deviceFrames of [frames.desktop, frames.mobile]) {
        await expect.poll(() => deviceFrames.some((frame) => frame.direction === 'received'
          && frame.type === 'freshAgent.event'
          && frame.sessionId === session.sessionId
          && (frame.event as Record<string, unknown> | undefined)?.type === 'freshAgent.session.metadata'
          && (frame.event as Record<string, unknown> | undefined)?.effort === 'low'), {
          timeout: 30_000,
          message: 'both devices observe the baseline settings before recovery',
        }).toBe(true)
      }
      const baselineBinding = await native.readBinding(session.sessionId)
      expect(baselineBinding).toMatchObject({ effort: 'low' })

      const expectRecoveryAttachRounds = async (
        deviceName: 'desktop' | 'mobile',
        device: { viewId: string; tabId: string; paneId: string },
        deviceFrames: ReadonlyArray<Record<string, unknown>>,
        baselineFrameCount: number,
      ) => {
        await expect.poll(() => {
          const analysis = analyzeFreshAgentAttachRounds(deviceFrames, targetFor(device))
          const recoveryRounds = analysis.rounds.filter((round) => round.authorizationFrameIndex >= baselineFrameCount)
          const readyRounds = recoveryRounds.filter((round) => round.kind === 'ready')
          const positiveReconcileRounds = recoveryRounds.filter((round) => round.kind === 'reconcile')
          const bindingReconcileRounds = positiveReconcileRounds.filter((round) =>
            round.targetVerdict === 'attach' || round.targetVerdict === 'respawn')
          const duplicateAttachments = recoveryRounds.flatMap((round) => round.duplicateAttachments)
          const recoveryAttachments = recoveryRounds.flatMap((round) => round.attachments)
          const authoritativeByRound = bindingReconcileRounds.map((round) => ({
            roundId: round.id,
            verdict: round.targetVerdict,
            count: round.attachments.filter((attachment) => !attachment.retryAfterSessionReserved
              && attachment.observedEpoch === 2
              && attachment.observedGeneration === 1).length,
          }))
          const missingAuthoritativeRounds = authoritativeByRound.filter((round) => round.count !== 1)
          const bootstrapByRound = recoveryRounds.map((round) => ({
            roundId: round.id,
            verdict: round.targetVerdict,
            count: round.attachments.filter((attachment) => !attachment.retryAfterSessionReserved
              && attachment.observedEpoch === null
              && attachment.observedGeneration === null).length,
          }))
          const bootstrapCount = bootstrapByRound.reduce((total, round) => total + round.count, 0)
          const authoritativeCount = recoveryAttachments.filter((attachment) => !attachment.retryAfterSessionReserved
            && attachment.observedEpoch === 2
            && attachment.observedGeneration === 1).length
          const unexpectedTuples = recoveryAttachments.filter((attachment) => !(
            (attachment.observedEpoch === null && attachment.observedGeneration === null)
            || (attachment.observedEpoch === 2 && attachment.observedGeneration === 1)
          ))
          const allSessionAttaches = analysis.rounds.flatMap((round) => round.attachments)
          if (
            readyRounds.length > 0
            && positiveReconcileRounds.length > 0
            && authoritativeCount > 0
            && bindingReconcileRounds.length > 0
            && duplicateAttachments.length === 0
            && missingAuthoritativeRounds.length === 0
            && unexpectedTuples.length === 0
          ) return null
          return {
            device: deviceName,
            intendedView: { viewId: device.viewId, tabId: device.tabId, paneId: device.paneId },
            expectedBaselineFence: { observedEpoch: 1, observedGeneration: 1 },
            expectedRecovery: 'one non-retry (2,1) attach in each positive target attach/respawn round; one null-to-fenced upgrade requires matching respawn create and committed owner; duplicate same-fence sends require SESSION_RESERVED',
            observedRecoveryCounts: { bootstrapCount, authoritativeCount },
            authoritativeByRound,
            bootstrapByRound,
            missingAuthoritativeRounds,
            duplicateAttachments,
            unexpectedRecoveryTuples: unexpectedTuples,
            readyRounds: readyRounds.map((round) => ({
              id: round.id,
              bootId: round.bootId,
              authorizationFrameIndex: round.authorizationFrameIndex,
              attachments: round.attachments,
            })),
            allRecoveryRounds: recoveryRounds.map((round) => ({
              id: round.id,
              kind: round.kind,
              bootId: round.bootId,
              reconcileId: round.reconcileId,
              targetVerdict: round.targetVerdict,
              authorizationFrameIndex: round.authorizationFrameIndex,
              attachments: round.attachments,
              duplicateAttachments: round.duplicateAttachments,
            })),
            sessionAttachTuples: allSessionAttaches,
            validReconcileRoundIds: analysis.validReconcileRoundIds,
          }
        }, {
          timeout: 30_000,
          message: deviceName + ' target view sends once in each authorized ready/reconcile round',
        }).toBeNull()
      }

      await restartWithDeadTerminalBinding()
      await Promise.all([
        desktop.harness.waitForConnectionAfter(desktopReadyBefore, 60_000),
        mobile.harness.waitForConnectionAfter(mobileReadyBefore, 60_000),
      ])

      await Promise.all([
        expectRecoveryAttachRounds('desktop', desktop, frames.desktop, desktopFrameCountBefore),
        expectRecoveryAttachRounds('mobile', mobile, frames.mobile, mobileFrameCountBefore),
      ])
      await expect.poll(() => native.runtimeStartCount(session.sessionId), {
        timeout: 60_000,
        message: 'both device attaches share one recovered native runtime',
      }).toBe(startCountBefore + 1)

      const prompt = 'stage1 shared held prompt'
      const recoveredResponse = mode === 'freshcodex'
        ? 'Native streaming fragment and final answer'
        : mode === 'freshopencode'
          ? `Fake OpenCode response: ${prompt}`
          : 'Stage1 shared response'
      await native.holdNextTurn(session.sessionId)
      const pane = desktop.page.locator('[data-context="fresh-agent"]').last()
      await pane.getByRole('textbox', { name: 'Chat message input' }).fill(prompt)
      await pane.getByRole('button', { name: 'Send', exact: true }).click()
      await native.waitForHeldTurn(prompt, session.sessionId)
      await native.releaseTurn()
      await expect(pane).toContainText(recoveredResponse, { timeout: 45_000 })
      await expect(mobile.page.locator('[data-context="fresh-agent"]').last())
        .toContainText(recoveredResponse, { timeout: 45_000 })

      // A configure from the second device must still reach the one recovered
      // runtime and converge its metadata back to both views.
      await mobile.page.evaluate(({ provider, sessionType, sessionId }) => {
        window.__FRESHELL_TEST_HARNESS__?.sendWsMessage({
          type: 'freshAgent.configure',
          requestId: 'stage1-dead-binding-configure',
          provider,
          sessionType,
          sessionId,
          settings: { effort: 'high' },
        })
      }, session)
      for (const deviceFrames of [frames.desktop, frames.mobile]) {
        await expect.poll(() => deviceFrames.some((frame) => frame.direction === 'received'
          && frame.type === 'freshAgent.event'
          && frame.sessionId === session.sessionId
          && (frame.event as Record<string, unknown> | undefined)?.type === 'freshAgent.session.metadata'
          && (frame.event as Record<string, unknown> | undefined)?.effort === 'high'), {
          timeout: 30_000,
          message: 'the recovered session broadcasts configured metadata to both devices',
        }).toBe(true)
      }
      await expect.poll(async () => {
        const binding = await native.readBinding(session.sessionId)
        return binding.effort
      }, {
        timeout: 30_000,
        message: 'the configure command replaces the durable settings behind the failed-transition fence',
      }).toBe('high')
      expect(frames.mobile.some((frame) => frame.direction === 'sent'
        && frame.type === 'freshAgent.configure'
        && frame.requestId === 'stage1-dead-binding-configure')).toBe(true)
      expect(frames.mobile.some((frame) => frame.direction === 'received'
        && frame.type === 'freshAgent.event'
        && frame.sessionId === session.sessionId
        && (frame.event as Record<string, unknown> | undefined)?.type === 'freshAgent.error'
        && (frame.event as Record<string, unknown> | undefined)?.requestId === 'stage1-dead-binding-configure')).toBe(false)

      // Restart after the settings command, forcing both independent views
      // to reconnect to the shared owner. The ledger file is the persistence
      // oracle, and each reconnect must deliver the persisted metadata.
      const desktopSettingsFrameCursor = frames.desktop.length
      const mobileSettingsFrameCursor = frames.mobile.length
      const desktopSettingsReady = await desktop.harness.getLastReadyAt()
      const mobileSettingsReady = await mobile.harness.getLastReadyAt()
      await restartServer()
      await Promise.all([
        desktop.harness.waitForConnectionAfter(desktopSettingsReady, 60_000),
        mobile.harness.waitForConnectionAfter(mobileSettingsReady, 60_000),
      ])
      await Promise.all([
        waitForPaneStatus(desktop, /^(connected|idle)$/),
        waitForPaneStatus(mobile, /^(connected|idle)$/),
      ])
      expect(await native.readBinding(session.sessionId)).toMatchObject({
        effort: 'high',
      })
      for (const [deviceName, deviceFrames, frameCursor] of [
        ['desktop', frames.desktop, desktopSettingsFrameCursor],
        ['mobile', frames.mobile, mobileSettingsFrameCursor],
      ] as const) {
        await expect.poll(() => deviceFrames.slice(frameCursor).some((frame) => frame.direction === 'received'
          && frame.type === 'freshAgent.event'
          && frame.sessionId === session.sessionId
          && (frame.event as Record<string, unknown> | undefined)?.type === 'freshAgent.session.metadata'
          && (frame.event as Record<string, unknown> | undefined)?.effort === 'high'), {
          timeout: 30_000,
          message: deviceName + ' receives persisted settings after reconnecting',
        }).toBe(true)
      }
      // Attach reservation retries are bounded and keep their captured fence.
      // Wait for target attach and SESSION_RESERVED traffic to stay quiet
      // longer than the retry cadence, then re-run analysis to catch a late
      // duplicate that arrived after the first recovery poll.
      await Promise.all([
        waitForAttachRoundQuiet(frames.desktop, targetFor(desktop)),
        waitForAttachRoundQuiet(frames.mobile, targetFor(mobile)),
      ])
      await Promise.all([
        expectRecoveryAttachRounds('desktop', desktop, frames.desktop, desktopFrameCountBefore),
        expectRecoveryAttachRounds('mobile', mobile, frames.mobile, mobileFrameCountBefore),
      ])
      expect(native.runtimeStartCount(session.sessionId)).toBe(startCountBefore + 1)
    }))
  }

  test('stage1 live terminal binding: desktop and mobile both refuse recovery without a second writer', withTwoDeviceSession('freshclaude', async ({
    desktop,
    mobile,
    native,
    frames,
  }) => {
    const sessionId = randomUUID()
    const terminalRequestId = 'stage1-live-terminal-owner'
    const terminalCreatesBefore = frames.desktop.filter((frame) => frame.direction === 'sent'
      && frame.type === 'terminal.create').length
    await desktop.page.evaluate(({ requestId, sessionId }) => {
      window.__FRESHELL_TEST_HARNESS__?.sendWsMessage({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        shell: 'system',
        cwd: '/tmp',
        sessionRef: { provider: 'claude', sessionId },
      })
    }, { requestId: terminalRequestId, sessionId })
    await expect.poll(() => frames.desktop.some((frame) => frame.direction === 'received'
      && frame.type === 'terminal.created'
      && frame.requestId === terminalRequestId
      && (frame.sessionRef as Record<string, unknown> | undefined)?.sessionId === sessionId), {
      timeout: 30_000,
      message: 'the fixture starts a real Claude terminal process for the recovery identity',
    }).toBe(true)
    expect(frames.desktop.filter((frame) => frame.direction === 'sent'
      && frame.type === 'terminal.create').length).toBe(terminalCreatesBefore + 1)

    const attach = (page: any) => page.evaluate((sessionId: string) => {
      window.__FRESHELL_TEST_HARNESS__?.sendWsMessage({
        type: 'freshAgent.attach',
        provider: 'claude',
        sessionType: 'freshclaude',
        sessionId,
        cwd: '/tmp',
        sessionRef: { provider: 'claude', sessionId },
      })
    }, sessionId)
    await Promise.all([attach(desktop.page), attach(mobile.page)])

    const reservedOnView = (deviceFrames: Array<Record<string, unknown>>) => deviceFrames.some((frame) => {
      if (frame.direction !== 'received' || frame.type !== 'freshAgent.event' || frame.sessionId !== sessionId) return false
      const event = frame.event as Record<string, unknown> | undefined
      return event?.type === 'freshAgent.error' && event.code === 'SESSION_RESERVED'
    })
    await expect.poll(() => ({
      desktop: reservedOnView(frames.desktop),
      mobile: reservedOnView(frames.mobile),
    }), {
      timeout: 30_000,
      message: 'each device receives the refusal while the terminal remains the live owner',
    }).toEqual({ desktop: true, mobile: true })
    expect(native.runtimeStartCount(sessionId)).toBe(0)
  }))
})
