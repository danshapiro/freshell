import { randomUUID } from 'node:crypto'
import { test, expect } from '../helpers/fixtures.js'
import {
  analyzeFreshAgentAttachRounds,
  hasAuthoritativeFreshAgentRecoveryAction,
  type FreshAgentAttachRoundAnalysis,
  type FreshAgentAttachRoundTarget,
} from '../helpers/fresh-agent-attach-rounds.js'
import {
  fetchFreshAgentSnapshot,
  holdNextFreshAgentSnapshotResponse,
  sendComposerText,
  FORK_PARENT_CONTINUATION_PROMPT,
  withTwoDeviceSession,
  type FreshAgentMultipleDeviceMode,
} from '../helpers/fresh-agent-multiple-devices.js'

type JsonRow = Record<string, unknown>

const MODES: FreshAgentMultipleDeviceMode[] = ['freshclaude', 'kilroy', 'freshcodex', 'freshopencode']

type FreshAgentDeviceView = {
  harness: {
    getPaneLayout(tabId: string): Promise<any>
    getState(): Promise<any>
  }
  tabId: string
  paneId: string
  viewId: string
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

async function waitForAcceptedFreshAgentSend(
  frames: ReadonlyArray<Record<string, unknown>>,
  text: string,
): Promise<string> {
  let requestId = ''
  await expect.poll(() => {
    const request = frames.find((frame) => frame.direction === 'sent'
      && frame.type === 'freshAgent.send'
      && frame.text === text)
    requestId = typeof request?.requestId === 'string' ? request.requestId : ''
    return requestId
  }, {
    timeout: 20_000,
    message: `desktop submitted the exact warm prompt before configuration`,
  }).not.toBe('')

  let acceptedSessionId = ''
  await expect.poll(() => {
    const accepted = frames.find((frame) => frame.direction === 'received'
      && frame.type === 'freshAgent.send.accepted'
      && frame.requestId === requestId)
    acceptedSessionId = typeof accepted?.sessionId === 'string' ? accepted.sessionId : ''
    return acceptedSessionId
  }, {
    timeout: 30_000,
    message: `desktop observed requestId-correlated acceptance after the warm-turn binding refresh`,
  }).not.toBe('')
  return acceptedSessionId
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
      await expect.poll(async () => {
        const currentSnapshot = await fetchFreshAgentSnapshot(native.info, targetSession)
        return {
          userRows: countTranscriptRowsWithSummary(currentSnapshot.turns, 'user', heldPrompt)
            - countTranscriptRowsWithSummary(beforeSnapshot.turns, 'user', heldPrompt),
          assistantRows: countTranscriptRowsWithSummary(currentSnapshot.turns, 'assistant', response)
            - countTranscriptRowsWithSummary(beforeSnapshot.turns, 'assistant', response),
        }
      }, {
        timeout: 30_000,
        message: 'the shared transcript snapshot commits the completed native turn after it is rendered',
      }).toEqual({ userRows: 1, assistantRows: 1 })
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
      const snapshotHttpTraffic: Record<'desktop' | 'mobile', Array<Record<string, unknown>>> = {
        desktop: [],
        mobile: [],
      }
      const snapshotRequestIds: Record<'desktop' | 'mobile', WeakMap<object, string>> = {
        desktop: new WeakMap(),
        mobile: new WeakMap(),
      }
      const snapshotRequestSequences: Record<'desktop' | 'mobile', number> = { desktop: 0, mobile: 0 }
      const disableForcedOpenCodeSnapshot409 = process.env.FRESHELL_TEST_NO_FORCED_OPENCODE_409 === '1'
      let forceOpenCodeSnapshot409 = false
      let forcedSnapshot409Count = 0
      let forcedSnapshot409RequestId: string | null = null
      let forcedSnapshot409Generation: number | null = null
      let forcedSnapshot409FirstAttachAtMs: number | null = null
      let forcedSnapshot409ResponseAtMs: number | null = null
      if (mode === 'freshopencode' && !disableForcedOpenCodeSnapshot409) {
        await mobile.page.route('**/api/fresh-agent/threads/**', async (route) => {
          const request = route.request()
          const url = new URL(request.url())
          const expectedPath = `/api/fresh-agent/threads/${encodeURIComponent(session.sessionType)}/${encodeURIComponent(session.provider)}/${encodeURIComponent(session.sessionId)}`
          if (!forceOpenCodeSnapshot409
            || forcedSnapshot409Count > 0
            || request.method() !== 'GET'
            || url.pathname !== expectedPath
            || url.searchParams.get('trigger') !== 'event'
            || forcedSnapshot409Generation === null) {
            await route.continue()
            return
          }
          const waitStartedAt = Date.now()
          let committedOwner: Record<string, unknown> | null = null
          while (Date.now() - waitStartedAt < 30_000) {
            const currentReady = [...frames.mobile].reverse().find((frame) =>
              frame.direction === 'received'
              && frame.type === 'ready'
              && typeof frame.capturedAtMs === 'number')
            const currentOwner = [...frames.mobile].reverse().find((frame) =>
              frame.direction === 'received'
              && frame.type === 'session.runtimeOwner'
              && frame.provider === session.provider
              && frame.sessionId === session.sessionId
              && frame.ownerKind === 'fresh-agent'
              && frame.transition === 'handoff-committed'
              && typeof frame.capturedAtMs === 'number'
              && currentReady
              && Number(frame.capturedAtMs) > Number(currentReady.capturedAtMs))
            if (currentOwner
              && typeof currentOwner.epoch === 'number'
              && typeof currentOwner.generation === 'number') {
              const currentAttach = frames.mobile.find((frame) =>
                frame.direction === 'sent'
                && frame.type === 'freshAgent.attach'
                && frame.viewId === mobile.viewId
                && frame.tabId === mobile.tabId
                && frame.paneId === mobile.paneId
                && frame.sessionId === session.sessionId
                && frame.observedEpoch === currentOwner.epoch
                && frame.observedGeneration === currentOwner.generation
                && typeof frame.capturedAtMs === 'number'
                && Number(frame.capturedAtMs) > Number(currentReady.capturedAtMs))
              if (currentAttach) {
                // A recovery_in_progress reconcile may authorize its fenced
                // attach while the owner handoff is still starting. Require
                // both facts in this ready window and on the same fence, but
                // allow the commit and attach to arrive in either order.
                committedOwner = currentOwner
                forcedSnapshot409FirstAttachAtMs = Number(currentAttach.capturedAtMs)
                break
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
          if (!committedOwner || typeof committedOwner.generation !== 'number') {
            throw new Error('forced snapshot 409 did not observe a current-owner commit and fenced attach first')
          }
          forcedSnapshot409Generation = committedOwner.generation
          forceOpenCodeSnapshot409 = false
          forcedSnapshot409Count += 1
          forcedSnapshot409RequestId = snapshotRequestIds.mobile.get(request) ?? null
          forcedSnapshot409ResponseAtMs = Date.now()
          await route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({
              status: 'error',
              code: 'RESTORE_UNAVAILABLE',
              message: `Session ${session.sessionId} is still running on the server.`,
              ownerKind: 'fresh-agent',
              ownerGeneration: forcedSnapshot409Generation,
            }),
          })
        })
      }
      for (const [deviceName, device] of [['desktop', desktop], ['mobile', mobile]] as const) {
        device.page.on('request', (request) => {
          const url = new URL(request.url())
          if (!url.pathname.startsWith('/api/fresh-agent/threads/')) return
          const requestId = `${deviceName}-snapshot-${++snapshotRequestSequences[deviceName]}`
          snapshotRequestIds[deviceName].set(request, requestId)
          const [, , routePrefix, collection, rawSessionType, rawProvider, rawSessionId] = url.pathname.split('/')
          if (routePrefix !== 'fresh-agent' || collection !== 'threads'
            || !rawSessionType || !rawProvider || !rawSessionId) return
          const row = {
            capturedAtMs: Date.now(),
            direction: 'request',
            type: 'freshAgent.snapshot.request',
            requestId,
            method: request.method(),
            pathname: url.pathname,
            trigger: url.searchParams.get('trigger'),
            sessionType: decodeURIComponent(rawSessionType),
            provider: decodeURIComponent(rawProvider),
            sessionId: decodeURIComponent(rawSessionId),
            viewId: device.viewId,
            tabId: device.tabId,
            paneId: device.paneId,
          }
          snapshotHttpTraffic[deviceName].push(row)
          frames[deviceName].push({ ...row, direction: 'http-request' })
        })
        device.page.on('response', async (response) => {
          const url = new URL(response.url())
          if (!url.pathname.startsWith('/api/fresh-agent/threads/')) return
          const [, , routePrefix, collection, rawSessionType, rawProvider, rawSessionId] = url.pathname.split('/')
          if (routePrefix !== 'fresh-agent' || collection !== 'threads'
            || !rawSessionType || !rawProvider || !rawSessionId) return
          const row: Record<string, unknown> = {
            capturedAtMs: Date.now(),
            direction: 'response',
            type: 'freshAgent.snapshot.response',
            requestId: snapshotRequestIds[deviceName].get(response.request()) ?? null,
            method: response.request().method(),
            pathname: url.pathname,
            trigger: url.searchParams.get('trigger'),
            status: response.status(),
            sessionType: decodeURIComponent(rawSessionType),
            provider: decodeURIComponent(rawProvider),
            sessionId: decodeURIComponent(rawSessionId),
            viewId: device.viewId,
            tabId: device.tabId,
            paneId: device.paneId,
          }
          if (response.status() === 409) {
            try {
              const body = await response.json() as Record<string, unknown>
              row.body = body
              row.code = body.code
              row.ownerKind = body.ownerKind
              row.ownerGeneration = body.ownerGeneration
            } catch (error) {
              row.bodyReadError = error instanceof Error ? error.message : String(error)
            }
          }
          snapshotHttpTraffic[deviceName].push(row)
          frames[deviceName].push({ ...row, direction: 'http-response' })
        })
      }
      // The server accepts the warm send only after its provider-specific
      // post-send binding/settings refresh. Do not let the initial idle pane
      // snapshot race that write before this scenario configures its baseline.
      const initialSessionId = session.sessionId
      const acceptedSessionId = await waitForAcceptedFreshAgentSend(
        frames.desktop,
        'stage1 warm session for multiple devices',
      )
      if (mode === 'freshopencode' && !disableForcedOpenCodeSnapshot409) {
        // OpenCode starts with a request-scoped placeholder id. The accepted
        // warm send is the durable materialization boundary; after it, the
        // desktop and mobile panes must both fold that same identity before
        // the settings/binding assertions use the shared session id.
        if (acceptedSessionId !== initialSessionId) {
          for (const [deviceName, deviceFrames] of [
            ['desktop', frames.desktop],
            ['mobile', frames.mobile],
          ] as const) {
            await expect.poll(() => deviceFrames.some((frame) => frame.direction === 'received'
              && frame.type === 'freshAgent.session.materialized'
              && frame.previousSessionId === initialSessionId
              && frame.provider === session.provider
              && frame.sessionType === session.sessionType
              && frame.sessionId === acceptedSessionId), {
              timeout: 30_000,
              message: deviceName + ' observes the warm OpenCode placeholder materialize to the accepted session id',
            }).toBe(true)
          }
        }
        for (const [deviceName, device] of [
          ['desktop', desktop],
          ['mobile', mobile],
        ] as const) {
          await expect.poll(async () => findFreshAgentLeaf(
            await device.harness.getPaneLayout(device.tabId),
          )?.content?.sessionRef?.sessionId ?? null, {
            timeout: 30_000,
            message: deviceName + ' pane stores the requestId-correlated accepted OpenCode session id',
          }).toBe(acceptedSessionId)
        }
        session.sessionId = acceptedSessionId
      } else {
        expect(acceptedSessionId).toBe(session.sessionId)
      }
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
        && tuple.observedGeneration === 1), 'desktop baseline attach carries the original owner fence; observed '
        + JSON.stringify(desktopBaseline)).toBe(true)
      expect(mobileBaseline.some((tuple) => tuple.observedEpoch === 1
        && tuple.observedGeneration === 1), 'mobile baseline attach carries the original owner fence; observed '
        + JSON.stringify(mobileBaseline)).toBe(true)

      // Seed a settings value before recovery. The restart helper adds a
      // durable failed-transition fence for this generation, then recovery
      // restores a newer legitimate owner. The later configure must cross
      // that fence and survive a second server restart.
      const baselineConfigureRequestId = 'stage1-dead-binding-configure-baseline'
      const bindingBeforeBaselineConfigure = await native.readBinding(session.sessionId)
      const baselineExpectedModel = mode === 'freshcodex'
        ? 'fakeprov/fakemodel'
        : bindingBeforeBaselineConfigure.model ?? null
      const baselineConfigureSettings = mode === 'freshcodex'
        ? { model: 'fakeprov/fakemodel', effort: 'low' }
        : { effort: 'low' }
      const baselineSettingsFrameCursors = {
        desktop: frames.desktop.length,
        mobile: frames.mobile.length,
      }
      await desktop.page.evaluate(({ provider, sessionType, sessionId, requestId, settings }) => {
        window.__FRESHELL_TEST_HARNESS__?.sendWsMessage({
          type: 'freshAgent.configure',
          requestId,
          provider,
          sessionType,
          sessionId,
          settings,
        })
      }, { ...session, requestId: baselineConfigureRequestId, settings: baselineConfigureSettings })
      const baselineMetadataFor = (deviceFrames: JsonRow[], frameCursor: number) =>
        deviceFrames.slice(frameCursor).flatMap((frame, offset) => {
          const event = frame.event as Record<string, unknown> | undefined
          if (!(frame.direction === 'received'
            && frame.type === 'freshAgent.event'
            && frame.sessionId === session.sessionId
            && event?.type === 'freshAgent.session.metadata')) return []
          return [{
            frameIndex: frameCursor + offset,
            ...(typeof event.requestId === 'string' ? { requestId: event.requestId } : {}),
            model: event.model,
            effort: event.effort,
          }]
        })
      for (const [deviceName, deviceFrames, frameCursor] of [
        ['desktop', frames.desktop, baselineSettingsFrameCursors.desktop],
        ['mobile', frames.mobile, baselineSettingsFrameCursors.mobile],
      ] as const) {
        await expect.poll(() => baselineMetadataFor(deviceFrames, frameCursor), {
          timeout: 30_000,
          message: deviceName + ' observes this configure\'s baseline settings before recovery',
        }).toContainEqual(expect.objectContaining({
          ...(mode === 'freshcodex' ? { requestId: baselineConfigureRequestId } : {}),
          model: baselineExpectedModel,
          effort: 'low',
        }))
      }
      await expect.poll(async () => {
        const binding = await native.readBinding(session.sessionId)
        return { model: binding.model ?? null, effort: binding.effort ?? null }
      }, {
        timeout: 30_000,
        message: 'baseline configure is durable before dead-binding recovery starts',
      }).toEqual({ model: baselineExpectedModel, effort: 'low' })
      await test.info().attach(`task3-baseline-${mode}`, {
        body: JSON.stringify({
          mode,
          target: { provider: session.provider, sessionType: session.sessionType, sessionId: session.sessionId },
          baselineFence: { epoch: 1, generation: 1 },
          desktopBaselineAttachments: desktopBaseline,
          mobileBaselineAttachments: mobileBaseline,
          configureRequestId: baselineConfigureRequestId,
          expectedSettings: { model: baselineExpectedModel, effort: 'low' },
          desktopMetadataFrames: baselineMetadataFor(frames.desktop, baselineSettingsFrameCursors.desktop),
          mobileMetadataFrames: baselineMetadataFor(frames.mobile, baselineSettingsFrameCursors.mobile),
        }, null, 2),
        contentType: 'application/json',
      })
      const baselineBinding = await native.readBinding(session.sessionId)
      expect({ model: baselineBinding.model ?? null, effort: baselineBinding.effort ?? null })
        .toEqual({ model: baselineExpectedModel, effort: 'low' })
      const ownerGenerationFromBinding = (binding: Record<string, unknown>) => {
        if (typeof binding.ownerGeneration !== 'number') {
          throw new Error(`expected a durable owner fence, got ${JSON.stringify(binding)}`)
        }
        return binding.ownerGeneration
      }

      const expectRecoveryAttachRounds = async (
        deviceName: 'desktop' | 'mobile',
        device: { viewId: string; tabId: string; paneId: string },
        deviceFrames: ReadonlyArray<Record<string, unknown>>,
        baselineFrameCount: number,
        expectedRecoveryFence: { epoch: number; generation: number },
        endFrameCount?: number,
      ) => {
        await expect.poll(async () => {
          const analysis = analyzeFreshAgentAttachRounds(deviceFrames, targetFor(device))
          const recoveryRounds = analysis.rounds.filter((round) => round.authorizationFrameIndex >= baselineFrameCount
            && (endFrameCount === undefined || round.authorizationFrameIndex < endFrameCount))
          const readyRounds = recoveryRounds.filter((round) => round.kind === 'ready')
          const reconcileRounds = recoveryRounds.filter((round) => round.kind === 'reconcile')
          const bindingReconcileRounds = reconcileRounds.filter((round) =>
            round.targetVerdict === 'attach' || round.targetVerdict === 'respawn'
              || round.targetVerdict === 'recovery_in_progress')
          const duplicateAttachments = recoveryRounds.flatMap((round) => round.duplicateAttachments)
          const recoveryAttachments = recoveryRounds.flatMap((round) => round.attachments)
          const authoritativeByRound = bindingReconcileRounds.map((round) => ({
            roundId: round.id,
            verdict: round.targetVerdict,
            count: hasAuthoritativeFreshAgentRecoveryAction(round, expectedRecoveryFence) ? 1 : 0,
            fencedAttachCount: round.attachments.filter((attachment) => !attachment.retryAfterSessionReserved
              && !attachment.retryAfterRestoreUnavailable
              && attachment.observedEpoch === expectedRecoveryFence.epoch
              && attachment.observedGeneration === expectedRecoveryFence.generation).length,
            respawnCreatedFrameIndex: round.respawnCreatedFrameIndex,
            respawnCommittedOwnerFence: round.respawnCommittedOwnerFence,
            respawnCommittedOwnerFrameIndex: round.respawnCommittedOwnerFrameIndex,
          }))
          const missingAuthoritativeRounds = authoritativeByRound.filter((round) => round.count !== 1)
          const bootstrapByRound = recoveryRounds.map((round) => ({
            roundId: round.id,
            verdict: round.targetVerdict,
            count: round.attachments.filter((attachment) => !attachment.retryAfterSessionReserved
              && !attachment.retryAfterRestoreUnavailable
              && attachment.observedEpoch === null
              && attachment.observedGeneration === null).length,
          }))
          const bootstrapCount = bootstrapByRound.reduce((total, round) => total + round.count, 0)
          const authoritativeCount = authoritativeByRound.reduce((count, round) => count + round.count, 0)
          const unexpectedTuples = recoveryAttachments.filter((attachment) => !(
            (attachment.observedEpoch === null && attachment.observedGeneration === null)
            || (attachment.observedEpoch === expectedRecoveryFence.epoch
              && attachment.observedGeneration === expectedRecoveryFence.generation)
          ))
          const allSessionAttaches = analysis.rounds.flatMap((round) => round.attachments)
          const connectionReconcileTraffic = deviceFrames.flatMap((frame, frameIndex) => {
            if (frame.type !== 'ready' && frame.type !== 'pane.reconcile.request'
              && frame.type !== 'pane.reconcile.result') return []
            const panes = Array.isArray(frame.panes) ? frame.panes.map((value) => {
              const pane = value as Record<string, unknown>
              return {
                paneKey: pane.paneKey,
                kind: pane.kind,
                mode: pane.mode,
                createRequestId: pane.createRequestId,
                sessionRef: pane.sessionRef,
                resumeSessionId: pane.resumeSessionId,
              }
            }) : undefined
            return [{
              frameIndex,
              direction: frame.direction,
              type: frame.type,
              bootId: frame.bootId,
              serverInstanceId: frame.serverInstanceId,
              capabilities: frame.capabilities,
              reconcileId: frame.reconcileId,
              panes,
              verdicts: frame.verdicts,
            }]
          })
          const respawnRequestIds = new Set(bindingReconcileRounds
            .filter((round) => round.targetVerdict === 'respawn')
            .map((round) => round.respawnCreateRequestId)
            .filter((requestId): requestId is string => typeof requestId === 'string'))
          const respawnTraffic = deviceFrames.flatMap((frame, frameIndex) => {
            if (frame.type !== 'freshAgent.create' && frame.type !== 'freshAgent.created'
              && frame.type !== 'freshAgent.create.failed' && frame.type !== 'session.runtimeOwner'
              && frame.type !== 'freshAgent.attach') return []
            const sessionRef = frame.sessionRef as Record<string, unknown> | undefined
            const targetIdentity = frame.provider === session.provider
              && (frame.sessionId === session.sessionId
                || (sessionRef?.provider === session.provider && sessionRef.sessionId === session.sessionId))
            const targetRequest = typeof frame.requestId === 'string'
              && respawnRequestIds.has(frame.requestId)
            if (!targetIdentity && !targetRequest) return []
            return [{
              frameIndex,
              direction: frame.direction,
              type: frame.type,
              requestId: frame.requestId,
              viewId: frame.viewId,
              tabId: frame.tabId,
              paneId: frame.paneId,
              provider: frame.provider,
              sessionType: frame.sessionType,
              sessionId: frame.sessionId,
              sessionRef: frame.sessionRef,
              epoch: frame.epoch,
              generation: frame.generation,
              ownerKind: frame.ownerKind,
              transition: frame.transition,
              operationId: frame.operationId,
              fenced: frame.fenced,
              observedEpoch: frame.observedEpoch,
              observedGeneration: frame.observedGeneration,
              code: frame.code,
            }]
          })
          const reconcileActionFrames = deviceFrames.flatMap((frame, frameIndex) => {
            const event = frame.event as Record<string, unknown> | undefined
            const targetFreshAgentEvent = frame.type === 'freshAgent.event'
              && frame.sessionId === session.sessionId
            if (frame.type !== 'ready' && frame.type !== 'pane.reconcile.request'
              && frame.type !== 'pane.reconcile.result' && frame.type !== 'freshAgent.create'
              && frame.type !== 'freshAgent.created' && frame.type !== 'freshAgent.create.failed'
              && frame.type !== 'freshAgent.attach' && frame.type !== 'session.runtimeOwner'
              && !targetFreshAgentEvent) return []
            return [{ frameIndex, ...frame }]
          })
          if (
            readyRounds.length > 0
            && reconcileRounds.length > 0
            && authoritativeCount > 0
            && bindingReconcileRounds.length > 0
            && duplicateAttachments.length === 0
            && missingAuthoritativeRounds.length === 0
            && unexpectedTuples.length === 0
          ) {
            if (bindingReconcileRounds.some((round) => round.targetVerdict === 'respawn')) {
              await test.info().attach(
                `fresh-agent-respawn-${deviceName}-${expectedRecoveryFence.epoch}-${baselineFrameCount}`,
                {
                  body: JSON.stringify({
                    device: deviceName,
                    intendedView: { viewId: device.viewId, tabId: device.tabId, paneId: device.paneId },
                    expectedRecoveryFence,
                    bindingRounds: bindingReconcileRounds.map((round) => ({
                      id: round.id,
                      verdict: round.targetVerdict,
                      authorizationFrameIndex: round.authorizationFrameIndex,
                      recoveryJoinFence: round.recoveryJoinFence,
                      recoveryJoinCommittedOwnerFrames: round.recoveryJoinCommittedOwnerFrames,
                      respawnCreateRequestId: round.respawnCreateRequestId,
                      respawnCreatedFrameIndex: round.respawnCreatedFrameIndex,
                      respawnCommittedOwnerFence: round.respawnCommittedOwnerFence,
                      respawnCommittedOwnerFrameIndex: round.respawnCommittedOwnerFrameIndex,
                      attachments: round.attachments,
                    })),
                    respawnTraffic,
                  }, null, 2),
                  contentType: 'application/json',
                },
              )
            }
            return null
          }
          return {
            device: deviceName,
            intendedView: { viewId: device.viewId, tabId: device.tabId, paneId: device.paneId },
            expectedBaselineFence: { observedEpoch: 1, observedGeneration: 1 },
            expectedRecovery: `attach verdict => exactly one non-retry (${expectedRecoveryFence.epoch},${expectedRecoveryFence.generation}) attach; recovery_in_progress => matching handoff-started fence, one matching attach, then matching commit; respawn verdict => exact target create acknowledgment plus current committed owner fence (${expectedRecoveryFence.epoch},${expectedRecoveryFence.generation}) with optional single follow-up attach; duplicate same-fence sends require SESSION_RESERVED`,
            observedRecoveryCounts: { bootstrapCount, authoritativeCount },
            authoritativeByRound,
            bootstrapByRound,
            missingAuthoritativeRounds,
            duplicateAttachments,
            unexpectedRecoveryTuples: unexpectedTuples,
            connectionReconcileTraffic,
            snapshotHttpTraffic: JSON.stringify(snapshotHttpTraffic[deviceName]),
            forcedSnapshot409: mode === 'freshopencode' ? {
              count: forcedSnapshot409Count,
              requestId: forcedSnapshot409RequestId,
              ownerGeneration: forcedSnapshot409Generation,
              firstFencedAttachAtMs: forcedSnapshot409FirstAttachAtMs,
              responseAtMs: forcedSnapshot409ResponseAtMs,
            } : null,
            reconcileActionFrames: JSON.stringify(reconcileActionFrames),
            respawnTraffic: JSON.stringify(respawnTraffic),
            readyRounds: readyRounds.map((round) => ({
              id: round.id,
              bootId: round.bootId,
              authorizationFrameIndex: round.authorizationFrameIndex,
              attachments: round.attachments,
            })),
            allRecoveryRounds: JSON.stringify(recoveryRounds.map((round) => ({
              id: round.id,
              kind: round.kind,
              bootId: round.bootId,
              reconcileId: round.reconcileId,
              targetVerdict: round.targetVerdict,
              authorizationFrameIndex: round.authorizationFrameIndex,
              recoveryJoinFence: round.recoveryJoinFence,
              recoveryJoinCommittedOwnerFrames: round.recoveryJoinCommittedOwnerFrames,
              respawnCreateRequestId: round.respawnCreateRequestId,
              respawnNullBootstrapFrameIndex: round.respawnNullBootstrapFrameIndex,
              respawnCreatedFrameIndex: round.respawnCreatedFrameIndex,
              respawnCommittedOwnerFence: round.respawnCommittedOwnerFence,
              respawnCommittedOwnerFrameIndex: round.respawnCommittedOwnerFrameIndex,
              attachments: round.attachments,
              duplicateAttachments: round.duplicateAttachments,
            }))),
            sessionAttachTuples: allSessionAttaches,
            validReconcileRoundIds: analysis.validReconcileRoundIds,
          }
        }, {
          timeout: 30_000,
          message: deviceName + ' target view performs one authorized attach/create action per target reconcile round',
        }).toBeNull()
      }

      await restartWithDeadTerminalBinding(session.sessionId)
      await Promise.all([
        desktop.harness.waitForConnectionAfter(desktopReadyBefore, 60_000),
        mobile.harness.waitForConnectionAfter(mobileReadyBefore, 60_000),
      ])
      const recoveredBinding = await native.readBinding(session.sessionId)
      expect({ model: recoveredBinding.model ?? null, effort: recoveredBinding.effort ?? null })
        .toEqual({ model: baselineExpectedModel, effort: 'low' })
      const recoveredFence = {
        epoch: await native.readBootEpoch(),
        generation: ownerGenerationFromBinding(recoveredBinding),
      }

      await Promise.all([
        expectRecoveryAttachRounds(
          'desktop', desktop, frames.desktop, desktopFrameCountBefore, recoveredFence,
        ),
        expectRecoveryAttachRounds(
          'mobile', mobile, frames.mobile, mobileFrameCountBefore, recoveredFence,
        ),
      ])
      for (const [deviceName, deviceFrames, frameCursor] of [
        ['desktop', frames.desktop, desktopFrameCountBefore],
        ['mobile', frames.mobile, mobileFrameCountBefore],
      ] as const) {
        await expect.poll(() => deviceFrames.slice(frameCursor).some((frame) => {
          const event = frame.event as Record<string, unknown> | undefined
          return frame.direction === 'received'
            && frame.type === 'freshAgent.event'
            && frame.sessionId === session.sessionId
            && event?.type === 'freshAgent.session.metadata'
            && event.model === baselineExpectedModel
            && event.effort === 'low'
        }), {
          timeout: 30_000,
          message: deviceName + ' receives the recovered model and effort after reconnecting',
        }).toBe(true)
      }
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
          && (frame.event as Record<string, unknown> | undefined)?.model === baselineExpectedModel
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
      if (mode === 'freshopencode') {
        const ownerBeforeRestart = await native.readBinding(session.sessionId)
        forcedSnapshot409Generation = ownerGenerationFromBinding(ownerBeforeRestart)
        forceOpenCodeSnapshot409 = true
      }
      await restartServer()
      await Promise.all([
        desktop.harness.waitForConnectionAfter(desktopSettingsReady, 60_000),
        mobile.harness.waitForConnectionAfter(mobileSettingsReady, 60_000),
      ])
      await Promise.all([
        waitForPaneStatus(desktop, /^(connected|idle)$/),
        waitForPaneStatus(mobile, /^(connected|idle)$/),
      ])
      const persistedBinding = await native.readBinding(session.sessionId)
      expect({ model: persistedBinding.model ?? null, effort: persistedBinding.effort ?? null })
        .toEqual({ model: baselineExpectedModel, effort: 'high' })
      const persistedFence = {
        epoch: await native.readBootEpoch(),
        generation: ownerGenerationFromBinding(persistedBinding),
      }
      for (const [deviceName, deviceFrames, frameCursor] of [
        ['desktop', frames.desktop, desktopSettingsFrameCursor],
        ['mobile', frames.mobile, mobileSettingsFrameCursor],
      ] as const) {
        await expect.poll(() => deviceFrames.slice(frameCursor).some((frame) => frame.direction === 'received'
          && frame.type === 'freshAgent.event'
          && frame.sessionId === session.sessionId
          && (frame.event as Record<string, unknown> | undefined)?.type === 'freshAgent.session.metadata'
          && (frame.event as Record<string, unknown> | undefined)?.model === baselineExpectedModel
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
        expectRecoveryAttachRounds(
          'desktop', desktop, frames.desktop, desktopFrameCountBefore, recoveredFence, desktopSettingsFrameCursor,
        ),
        expectRecoveryAttachRounds(
          'mobile', mobile, frames.mobile, mobileFrameCountBefore, recoveredFence, mobileSettingsFrameCursor,
        ),
        expectRecoveryAttachRounds(
          'desktop', desktop, frames.desktop, desktopSettingsFrameCursor, persistedFence,
        ),
        expectRecoveryAttachRounds(
          'mobile', mobile, frames.mobile, mobileSettingsFrameCursor, persistedFence,
        ),
      ])
      // One recovery start was shared by both views; the second deliberate
      // server restart then starts one new runtime for the next boot.
      expect(native.runtimeStartCount(session.sessionId)).toBe(startCountBefore + 2)
      if (mode === 'freshopencode') {
        const captureReconnectFrames = (deviceFrames: ReadonlyArray<Record<string, unknown>>, cursor: number) =>
          deviceFrames.slice(cursor).filter((frame) => {
            if (frame.type === 'ready' || frame.type === 'pane.reconcile.request'
              || frame.type === 'pane.reconcile.result' || frame.type === 'freshAgent.attach'
              || frame.type === 'freshAgent.create' || frame.type === 'freshAgent.created'
              || frame.type === 'freshAgent.create.failed' || frame.type === 'session.runtimeOwner') return true
            const event = frame.event as Record<string, unknown> | undefined
            return frame.type === 'freshAgent.event'
              && frame.sessionId === session.sessionId
              && (event?.type === 'freshAgent.error' || event?.type === 'freshAgent.session.metadata')
          })
        const targetSnapshotTraffic = (deviceName: 'desktop' | 'mobile') =>
          snapshotHttpTraffic[deviceName]
            .filter((row) => typeof row.pathname === 'string'
              && row.pathname.endsWith(encodeURIComponent(session.sessionId)))
            .sort((left, right) => Number(left.capturedAtMs) - Number(right.capturedAtMs))
        const correlationEvidence = {
          sessionId: session.sessionId,
          expectedFence: persistedFence,
          forcedSnapshot409: {
            count: forcedSnapshot409Count,
            requestId: forcedSnapshot409RequestId,
            ownerGeneration: forcedSnapshot409Generation,
            firstFencedAttachAtMs: forcedSnapshot409FirstAttachAtMs,
            responseAtMs: forcedSnapshot409ResponseAtMs,
          },
          desktop: {
            snapshotHttp: targetSnapshotTraffic('desktop'),
            websocket: captureReconnectFrames(frames.desktop, desktopSettingsFrameCursor),
          },
          mobile: {
            snapshotHttp: targetSnapshotTraffic('mobile'),
            websocket: captureReconnectFrames(frames.mobile, mobileSettingsFrameCursor),
          },
        }
        console.log('TASK3_OPENCODE_RECONNECT_CORRELATION=' + JSON.stringify(correlationEvidence))
        await test.info().attach('task3-opencode-second-restart-correlation', {
          body: JSON.stringify(correlationEvidence, null, 2),
          contentType: 'application/json',
        })
      }
    }))
  }

  for (const mode of MODES) {
    test(`stage2 requester ${mode}: mobile joins a desktop turn without resetting its peer`, withTwoDeviceSession(mode, async ({
      desktop,
      mobile,
      native,
      session,
      frames,
      openView,
    }) => {
      const prompt = mode === 'freshopencode'
        ? `stage2 requester held prompt ${mode}`
        : 'stage1 shared held prompt'
      const response = mode === 'freshclaude' || mode === 'kilroy'
        ? 'Stage1 shared response'
        : mode === 'freshcodex'
          ? 'Native streaming fragment and final answer'
          : `Fake OpenCode response: ${prompt}`
      const before = await fetchFreshAgentSnapshot(native.info, session)

      await native.holdNextTurn()
      const composer = desktop.page.locator('[data-context="fresh-agent"]').last()
        .getByRole('textbox', { name: 'Chat message input' })
      await composer.fill(prompt)
      await composer.press('Enter')
      await native.waitForHeldTurn(prompt)

      const desktopSnapshotCount = frames.desktop.filter((frame) => frame.direction === 'received'
        && frame.type === 'freshAgent.event'
        && frame.sessionId === session.sessionId
        && (frame.event as Record<string, unknown> | undefined)?.type === 'freshAgent.session.snapshot').length
      const mobileView = await openView('mobile', session.sessionId)
      await waitForPaneStatus(mobileView, /running|busy/i)
      const mobileAttach = frames.mobile.find((frame) => frame.direction === 'sent'
        && frame.type === 'freshAgent.attach'
        && frame.sessionId === session.sessionId)
      expect(mobileAttach?.requestId).toEqual(expect.any(String))
      const requestId = mobileAttach?.requestId as string
      await expect.poll(() => frames.mobile.some((frame) => frame.direction === 'received'
        && frame.type === 'freshAgent.attached'
        && frame.requestId === requestId
        && frame.viewId === mobileAttach?.viewId
        && frame.sessionId === session.sessionId), {
        timeout: 30_000,
        message: 'mobile receives its correlated attach snapshot while desktop is streaming',
      }).toBe(true)
      expect(frames.desktop.some((frame) => frame.direction === 'received'
        && (frame.type === 'freshAgent.attached' || frame.type === 'freshAgent.attach.failed')
        && frame.requestId === requestId)).toBe(false)
      expect(frames.desktop.filter((frame) => frame.direction === 'received'
        && frame.type === 'freshAgent.event'
        && frame.sessionId === session.sessionId
        && (frame.event as Record<string, unknown> | undefined)?.type === 'freshAgent.session.snapshot')).toHaveLength(desktopSnapshotCount)
      expect(frames.desktop.concat(frames.mobile).some((frame) => frame.direction === 'received'
        && frame.type === 'freshAgent.event'
        && frame.sessionId === session.sessionId
        && (frame.event as Record<string, unknown> | undefined)?.type === 'freshAgent.error')).toBe(false)

      await native.releaseTurn()
      await expect(desktop.page.locator('[data-context="fresh-agent"]').last()).toContainText(response, { timeout: 45_000 })
      await expect(mobileView.page.locator('[data-context="fresh-agent"]').last()).toContainText(response, { timeout: 45_000 })
      await expect.poll(async () => {
        const snapshot = await fetchFreshAgentSnapshot(native.info, session)
        return {
          user: countTranscriptRowsWithSummary(snapshot.turns, 'user', prompt)
            - countTranscriptRowsWithSummary(before.turns, 'user', prompt),
          assistant: countTranscriptRowsWithSummary(snapshot.turns, 'assistant', response)
            - countTranscriptRowsWithSummary(before.turns, 'assistant', response),
        }
      }, { timeout: 45_000, message: 'the joined turn adds one user row and one assistant row' })
        .toEqual({ user: 1, assistant: 1 })
      expect(mode === 'freshopencode' ? native.bootCount() : native.bootCount(session.sessionId)).toBe(1)
    }))
  }

  const recoveryAction = async (
    deviceFrames: JsonRow[],
    device: FreshAgentDeviceView,
    session: { provider: string; sessionType: string; sessionId: string },
    cursor: number,
  ) => {
    const recoveryActionStartedAtMs = Date.now()
    const frameCountAtEntry = deviceFrames.length
    let action: JsonRow | undefined
    try {
      await expect.poll(() => {
        action = deviceFrames.slice(cursor).find((frame) => frame.direction === 'sent'
          && (frame.type === 'freshAgent.create' || frame.type === 'freshAgent.attach')
          && frame.viewId === device.viewId
          && frame.provider === session.provider
          && frame.sessionType === session.sessionType
          && (frame.sessionId === session.sessionId
            || (frame.sessionRef as Record<string, unknown> | undefined)?.sessionId === session.sessionId))
        return action ?? null
      }, {
        timeout: 45_000,
        message: `${session.sessionType} view sends its own recovery request`,
      }).not.toBeNull()
    } catch (error) {
      const timedOutAtMs = Date.now()
      const frameCountAtTimeout = deviceFrames.length
      const framesAtTimeout = deviceFrames.slice(cursor, frameCountAtTimeout)
      const [state, layout] = await Promise.all([
        device.harness.getState(),
        device.harness.getPaneLayout(device.tabId),
      ])
      const content = findFreshAgentLeaf(layout)?.content
      const ownerRecords = Object.values(state.freshAgent?.runtimeOwners ?? {})
        .filter((owner: any) => owner?.provider === session.provider && owner?.sessionId === session.sessionId)
        .map((owner: any) => ({
          ownerKind: owner.ownerKind,
          transition: owner.transition,
          epoch: owner.epoch,
          generation: owner.generation,
          fenced: owner.fenced,
        }))
      const observedWireFrames = framesAtTimeout.map((frame, offset) => {
          const sessionRef = frame.sessionRef as Record<string, unknown> | undefined
          return {
            frameIndex: cursor + offset,
            capturedAtMs: frame.capturedAtMs,
            direction: frame.direction,
            type: frame.type,
            requestId: frame.requestId,
            reconcileId: frame.reconcileId,
            viewId: frame.viewId,
            provider: frame.provider,
            sessionType: frame.sessionType,
            sessionId: frame.sessionId,
            bootId: frame.bootId,
            verdict: frame.verdict,
            sessionRef: sessionRef && {
              provider: sessionRef.provider,
              sessionId: sessionRef.sessionId,
            },
            code: frame.code,
          }
        })
      const recoveryActionCandidates = framesAtTimeout
        .flatMap((frame, offset) => {
          if (frame.type !== 'freshAgent.create' && frame.type !== 'freshAgent.attach') return []
          const sessionRefId = (frame.sessionRef as Record<string, unknown> | undefined)?.sessionId
          const predicates = {
            direction: { actual: frame.direction, expected: 'sent', matches: frame.direction === 'sent' },
            viewId: { actual: frame.viewId, expected: device.viewId, matches: frame.viewId === device.viewId },
            provider: { actual: frame.provider, expected: session.provider, matches: frame.provider === session.provider },
            sessionType: { actual: frame.sessionType, expected: session.sessionType, matches: frame.sessionType === session.sessionType },
            sessionId: {
              actual: frame.sessionId,
              sessionRefId,
              expected: session.sessionId,
              matches: frame.sessionId === session.sessionId || sessionRefId === session.sessionId,
            },
          }
          return [{
            frameIndex: cursor + offset,
            capturedAtMs: frame.capturedAtMs,
            requestId: frame.requestId,
            type: frame.type,
            viewId: frame.viewId,
            provider: frame.provider,
            sessionType: frame.sessionType,
            sessionId: frame.sessionId,
            sessionRefId,
            predicates,
          }]
        })
      const paneSessionRef = content?.sessionRef as Record<string, unknown> | undefined
      const diagnostic = {
        expectedRecoveryAction: {
          viewId: device.viewId,
          provider: session.provider,
          sessionType: session.sessionType,
          sessionId: session.sessionId,
          cursor,
          frameCountAtEntry,
          frameCountAtTimeout,
          frameCountDelta: frameCountAtTimeout - frameCountAtEntry,
          recoveryActionStartedAtMs,
          timedOutAtMs,
          framesAppendedDuringDiagnostic: deviceFrames.slice(frameCountAtTimeout).map((frame, offset) => ({
            frameIndex: frameCountAtTimeout + offset,
            capturedAtMs: frame.capturedAtMs,
            direction: frame.direction,
            type: frame.type,
            requestId: frame.requestId,
            viewId: frame.viewId,
            provider: frame.provider,
            sessionType: frame.sessionType,
            sessionId: frame.sessionId,
            sessionRef: frame.sessionRef,
          })),
        },
        connection: {
          status: state.connection?.status,
          bootId: state.connection?.bootId,
          readySequence: state.connection?.readySequence,
          lastReadyAt: state.connection?.lastReadyAt,
        },
        activeTabId: state.tabs?.activeTabId,
        activePaneId: state.panes?.activePane?.[device.tabId],
        pane: {
          tabId: device.tabId,
          paneId: device.paneId,
          viewId: content?.viewId,
          createRequestId: content?.createRequestId,
          provider: content?.provider,
          sessionType: content?.sessionType,
          sessionId: content?.sessionId,
          sessionRef: paneSessionRef && {
            provider: paneSessionRef.provider,
            sessionId: paneSessionRef.sessionId,
          },
          status: content?.status,
          reconcileEpoch: content?.reconcileEpoch,
          recoveryDesiredState: content?.recoverySummary?.desiredState,
          recoveryState: content?.recoverySummary?.recoveryState,
          pendingReconcile: state.panes?.reconcilePendingPanes?.[`${device.tabId}:${device.paneId}`],
        },
        ownerRecords,
        recoveryActionCandidates,
        observedWireFrames,
      }
      throw new Error(
        `${session.sessionType} recovery request not found for view ${device.viewId}; `
        + `metadata-only reconnect trace: ${JSON.stringify(diagnostic)}`,
        { cause: error },
      )
    }
    return action!
  }

  const recoveryOutcome = async (
    deviceFrames: JsonRow[],
    action: JsonRow,
    success: boolean,
  ) => {
    let outcome: JsonRow | undefined
    await expect.poll(() => {
      outcome = deviceFrames.find((frame) => frame.direction === 'received'
        && frame.requestId === action.requestId
        && (frame.type === 'freshAgent.created'
          || frame.type === 'freshAgent.create.failed'
          || frame.type === 'freshAgent.attached'
          || frame.type === 'freshAgent.attach.failed'))
      return outcome?.type ?? null
    }, {
      timeout: 60_000,
      message: `request ${String(action.requestId)} gets its own ${success ? 'success' : 'failure'} result`,
    }).toMatch(success
      ? /^(freshAgent\.created|freshAgent\.attached)$/
      : /^(freshAgent\.create\.failed|freshAgent\.attach\.failed)$/)
    expect(outcome?.viewId).toBe(action.viewId)
    return outcome!
  }

  const assertJoinedRecoveryCohort = async (
    mode: FreshAgentMultipleDeviceMode,
    native: FreshAgentMultipleDeviceSession['native'],
    sessionId: string,
    actions: [JsonRow, JsonRow],
    attemptsBefore: number,
  ): Promise<JsonRow[]> => {
    if (mode !== 'freshcodex' && mode !== 'freshopencode') return []
    const requestIds = actions.map((action) => action.requestId as string)
    const admissions = await native.waitForSharedRecoveryAdmissions(sessionId, requestIds)
    const cohort = requestIds.map((requestId) => admissions.find((row) => row.request_id === requestId)!)
    const admittedAt = cohort.map((row) => Number(row.admitted_at_ms))
    const firstNativeAttempt = native.recoveryAttemptRows(sessionId)[attemptsBefore]
    const nativeAttemptAt = Number(mode === 'freshopencode' ? firstNativeAttempt?.t : firstNativeAttempt?.at)
    const safeWindowMs = mode === 'freshopencode' ? 8_000 : 28_000

    expect(cohort.map((row) => row.operation_id).every((operationId) => operationId === cohort[0]?.operation_id))
      .toBe(true)
    expect(new Set(cohort.map((row) => row.admission))).toEqual(new Set(['started', 'joined']))
    expect(Math.max(...admittedAt) - Math.min(...admittedAt)).toBeLessThan(safeWindowMs)
    expect(Math.max(...admittedAt) - nativeAttemptAt).toBeLessThan(safeWindowMs)
    return cohort
  }

  for (const mode of MODES) {
    test(`stage2 bounded refresh ${mode}: reconnect and retry settle while the peer streams`, withTwoDeviceSession(mode, async ({
      desktop,
      mobile,
      native,
      session,
    }) => {
      const snapshotPath = `/api/fresh-agent/threads/${encodeURIComponent(session.sessionType)}/${encodeURIComponent(session.provider)}/${encodeURIComponent(session.sessionId)}`
      let mobileSnapshotRequests = 0
      const mobileSnapshotResponses: Array<Record<string, unknown>> = []
      const mobileBrowserErrors: Array<Record<string, unknown>> = []
      const onMobilePageError = (error: Error) => {
        mobileBrowserErrors.push({ kind: 'pageerror', message: error.message })
      }
      const onMobileConsoleError = (message: import('@playwright/test').ConsoleMessage) => {
        if (message.type() !== 'error') return
        mobileBrowserErrors.push({
          kind: 'console',
          message: message.text(),
          location: message.location(),
        })
      }
      mobile.page.on('pageerror', onMobilePageError)
      mobile.page.on('console', onMobileConsoleError)
      mobile.page.on('request', (request) => {
        const url = new URL(request.url())
        if (request.method() === 'GET' && url.pathname === snapshotPath) mobileSnapshotRequests += 1
      })
      mobile.page.on('response', (response) => {
        const url = new URL(response.url())
        if (response.request().method() !== 'GET' || url.pathname !== snapshotPath) return
        void response.json().then((raw: unknown) => {
          const snapshot = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
          const extensions = snapshot.extensions && typeof snapshot.extensions === 'object'
            ? snapshot.extensions as Record<string, unknown>
            : {}
          const providerState = extensions[session.provider] && typeof extensions[session.provider] === 'object'
            ? extensions[session.provider] as Record<string, unknown>
            : {}
          mobileSnapshotResponses.push({
            trigger: url.searchParams.get('trigger'),
            status: response.status(),
            revision: typeof snapshot.revision === 'number' ? snapshot.revision : null,
            ownerKind: typeof providerState.ownerKind === 'string' ? providerState.ownerKind : null,
            statusFromLiveState: typeof providerState.statusFromLiveState === 'boolean' ? providerState.statusFromLiveState : null,
            nativeHistoryAvailable: typeof providerState.nativeHistoryAvailable === 'boolean' ? providerState.nativeHistoryAvailable : null,
            turnCount: Array.isArray(snapshot.turns) ? snapshot.turns.length : null,
          })
        }).catch(() => {
          mobileSnapshotResponses.push({ trigger: url.searchParams.get('trigger'), status: response.status(), bodyReadError: true })
        })
      })
      const snapshotDiagnostics = async () => {
        const audit = await mobile.page.evaluate(() => {
          const events = window.__FRESHELL_TEST_HARNESS__?.getPerfAuditSnapshot()?.perfEvents ?? []
          return events.filter((event) => event.event === 'fresh_agent.snapshot_request').map((event) => ({
            stage: event.stage,
            view: event.view,
            tabId: event.tabId,
            paneId: event.paneId,
            activeTabId: event.activeTabId,
            activePaneId: event.activePaneId,
            isActivePane: event.isActivePane,
            trigger: event.trigger,
            requestSource: event.requestSource,
            requestSerial: event.requestSerial,
            refreshSerial: event.refreshSerial,
            reason: event.reason,
            force: event.force,
            hidden: event.hidden,
            outcome: event.outcome,
            revision: event.revision,
            snapshotRevision: event.snapshotRevision,
            dirty: event.dirty,
            dirtyVersion: event.dirtyVersion,
            dirtyBaseRevision: event.dirtyBaseRevision,
            requiresRevisionAdvance: event.requiresRevisionAdvance,
            revealVersion: event.revealVersion,
            attemptRequestId: event.attemptRequestId,
            attemptState: event.attemptState,
            attemptIdentity: event.attemptIdentity,
            deadlineAt: event.deadlineAt,
            errorVisible: event.errorVisible,
            revealRefreshIsCurrent: event.revealRefreshIsCurrent,
            revealRevisionIsFresh: event.revealRevisionIsFresh,
            projectionNeedsResnapshot: event.projectionNeedsResnapshot,
            projectionRevisionIsFresh: event.projectionRevisionIsFresh,
          }))
        })
        return { requests: mobileSnapshotRequests, responses: mobileSnapshotResponses, audit }
      }
      const beforeReconnect = await fetchFreshAgentSnapshot(native.info, session)
      expect(beforeReconnect.turns.length).toBeGreaterThan(0)
      const desktopTranscriptView = desktop.page.locator('[data-context="fresh-agent-transcript"]').last()
      await expect.poll(() => desktopTranscriptView.locator('article[data-turn-index]').count(), {
        timeout: 20_000,
        message: 'desktop renders the turns already present in the unchanged server snapshot',
      }).toBeGreaterThanOrEqual(beforeReconnect.turns.length)
      const requestsBeforeReconnect = mobileSnapshotRequests
      const responsesBeforeReconnect = mobileSnapshotResponses.length
      const firstReadyAt = await mobile.harness.getLastReadyAt()

      await mobile.harness.forceDisconnect()
      await mobile.context.setOffline(true)
      await mobile.page.waitForTimeout(1_500)
      await mobile.context.setOffline(false)
      await mobile.harness.waitForConnectionAfter(firstReadyAt, 60_000)
      await expect.poll(() => mobileSnapshotRequests, {
        timeout: 30_000,
        message: 'mobile performs a real snapshot read after reconnect',
      }).toBeGreaterThan(requestsBeforeReconnect)
      await expect.poll(() => mobileSnapshotResponses.length, {
        timeout: 20_000,
        message: 'the reconnect snapshot response is received and recorded',
      }).toBeGreaterThan(responsesBeforeReconnect)
      await expect(mobile.page.locator('[aria-label="Refreshing conversation"]')).toHaveCount(0, { timeout: 20_000 })
      const mobileTranscriptView = mobile.page.locator('[data-context="fresh-agent-transcript"]').last()
      await expect.poll(() => mobileTranscriptView.locator('article[data-turn-index]').count(), {
        timeout: 20_000,
        message: 'mobile renders all turns from the unchanged server snapshot',
      }).toBeGreaterThanOrEqual(beforeReconnect.turns.length)
      await expect(mobileTranscriptView).toContainText('stage1 warm session for multiple devices')
      const reconnectResponse = mobileSnapshotResponses.slice(responsesBeforeReconnect)
        .find((response) => response.trigger === 'reconnect')
      expect(reconnectResponse, `reconnect response diagnostics: ${JSON.stringify(await snapshotDiagnostics())}`)
        .toMatchObject({
          trigger: 'reconnect',
          status: 200,
          revision: beforeReconnect.revision,
          turnCount: beforeReconnect.turns.length,
        })
      expect((await fetchFreshAgentSnapshot(native.info, session)).turns).toEqual(beforeReconnect.turns)

      // Keep the mobile view hidden while it is suspended and the desktop
      // starts a real turn. Reconnecting a hidden view records that its
      // transcript needs checking; revealing it below starts the visible,
      // bounded refresh that this scenario holds.
      const mobileTabCountBeforeBackground = await mobile.harness.getTabCount()
      const backgroundTabId = `task7-refresh-background-${randomUUID()}`
      await mobile.page.evaluate((id) => {
        const harness = window.__FRESHELL_TEST_HARNESS__
        if (!harness) throw new Error('Test harness not installed')
        harness.dispatch({ type: 'tabs/addTab', payload: { id, title: 'Refresh background', mode: 'shell' } })
      }, backgroundTabId)
      await expect.poll(() => mobile.harness.getTabCount(), {
        timeout: 10_000,
        message: 'mobile creates a second real tab to hide the suspended Fresh Agent view',
      }).toBe(mobileTabCountBeforeBackground + 1)
      await expect.poll(() => mobile.harness.getActiveTabId(), {
        timeout: 10_000,
        message: 'the newly created background tab becomes active on mobile',
      }).toBe(backgroundTabId)
      expect(backgroundTabId).not.toBe(mobile.tabId)

      const heldSnapshot = await holdNextFreshAgentSnapshotResponse(mobile.page, session)
      try {
        const secondReadyAt = await mobile.harness.getLastReadyAt()
        const desktopReadyAt = await desktop.harness.getLastReadyAt()
        await mobile.harness.forceDisconnect()
        await mobile.context.setOffline(true)
        await mobile.page.waitForTimeout(1_500)

        const snapshotBeforeHeldTurn = await fetchFreshAgentSnapshot(native.info, session)
        expect(typeof snapshotBeforeHeldTurn.revision).toBe('number')
        const firstHeldPrompt = `stage2 bounded refresh held prompt committed ${mode}`
        await native.holdNextTurn(session.sessionId)
        await sendComposerText(desktop, firstHeldPrompt)
        await native.waitForHeldTurn(firstHeldPrompt, session.sessionId)
        await waitForPaneStatus(desktop, /^running$/)
        expect(native.bootCount(session.sessionId)).toBe(1)

        // Finish one real native turn while mobile is offline so its saved
        // transcript revision advances beyond the mobile pane's cached base.
        // A second held turn keeps desktop streaming while mobile times out
        // and retries against that committed revision.
        await native.releaseTurn()
        await waitForPaneStatus(desktop, /^idle$/)
        await expect.poll(async () => JSON.stringify((await fetchFreshAgentSnapshot(native.info, session)).turns), {
          timeout: 30_000,
          message: 'the first native turn is committed to provider history before the Retry scenario',
        }).toContain(firstHeldPrompt)
        const snapshotAfterCommittedTurn = await fetchFreshAgentSnapshot(native.info, session)
        expect(snapshotAfterCommittedTurn.revision).toBeGreaterThan(snapshotBeforeHeldTurn.revision)
        expect(snapshotAfterCommittedTurn.turns.length).toBeGreaterThan(snapshotBeforeHeldTurn.turns.length)

        const secondHeldPrompt = `stage2 bounded refresh held prompt live ${mode}`
        await native.holdNextTurn(session.sessionId)
        await sendComposerText(desktop, secondHeldPrompt)
        await native.waitForHeldTurn(secondHeldPrompt, session.sessionId)
        await waitForPaneStatus(desktop, /^running$/)
        expect(await desktop.harness.getConnectionStatus()).toBe('ready')
        expect(await desktop.harness.getLastReadyAt()).toBe(desktopReadyAt)

        const requestsBeforeReveal = mobileSnapshotRequests
        await mobile.context.setOffline(false)
        await mobile.harness.waitForConnectionAfter(secondReadyAt, 60_000)
        expect(await mobile.harness.getActiveTabId()).toBe(backgroundTabId)
        expect(mobileSnapshotRequests).toBe(requestsBeforeReveal)

        await mobile.page.evaluate((tabId) => {
          const harness = window.__FRESHELL_TEST_HARNESS__
          if (!harness) throw new Error('Test harness not installed')
          harness.dispatch({ type: 'tabs/setActiveTab', payload: tabId })
        }, mobile.tabId)
        await expect.poll(() => mobile.harness.getActiveTabId(), {
          timeout: 10_000,
          message: 'mobile reveals the suspended Fresh Agent view',
        }).toBe(mobile.tabId)
        await expect.poll(() => heldSnapshot.isFetched(), {
          timeout: 30_000,
          message: 'revealing the suspended view made a real snapshot read with trigger=reveal',
        }).toBe(true)
        expect(heldSnapshot.requestTrigger()).toBe('reveal')
        await expect(mobile.page.getByRole('status', { name: 'Refreshing conversation' })).toBeVisible()

        const refreshFailure = mobile.page.getByRole('alert', {
          name: 'The conversation could not be refreshed.',
        })
        await expect(refreshFailure).toBeVisible({ timeout: 25_000 })
        await expect(refreshFailure).toContainText('Try again.')
        await expect(mobile.page.getByTestId('fresh-agent-stale-transcript')).toHaveAttribute('aria-hidden', 'true')
        await expect.poll(async () => {
          const layout = await desktop.harness.getPaneLayout(desktop.tabId)
          return findFreshAgentLeaf(layout)?.content?.status ?? null
        }, {
          timeout: 10_000,
          message: 'desktop remains in the second held streaming turn while mobile refresh is bounded',
        }).toBe('running')
        expect(native.bootCount(session.sessionId)).toBe(1)

        const requestsBeforeRetry = mobileSnapshotRequests
        const responsesBeforeRetry = mobileSnapshotResponses.length
        const diagnosticsBeforeRetry = await snapshotDiagnostics()
        const evaluationsBeforeRetry = diagnosticsBeforeRetry.audit
          .filter((event) => event.stage === 'reveal_refresh_evaluated').length
        const retryButton = refreshFailure.getByRole('button', { name: 'Retry' })
        await expect(refreshFailure).toBeVisible()
        await expect(retryButton).toBeVisible()
        await expect(retryButton).toBeEnabled()
        const retryUiBeforeClick = {
          activeTabId: await mobile.harness.getActiveTabId(),
          buttonVisible: await retryButton.isVisible(),
          buttonEnabled: await retryButton.isEnabled(),
          alertVisible: await refreshFailure.isVisible(),
          requestCount: mobileSnapshotRequests,
        }
        expect(retryUiBeforeClick.activeTabId).toBe(mobile.tabId)
        const auditCountBeforeClick = (await snapshotDiagnostics()).audit.length
        const browserErrorCountBeforeClick = mobileBrowserErrors.length
        const retryClickProbe = await mobile.page.evaluate(() => {
          const pageWindow = window as any
          pageWindow.__TASK7_RETRY_CLICK_DISPATCH__ = null
          pageWindow.__TASK7_RETRY_CLICK_EVENT__ = null
          pageWindow.__TASK7_DOCUMENT_CAPTURE_EVENTS__ = []
          pageWindow.__TASK7_DOCUMENT_BUBBLE_EVENTS__ = []
          pageWindow.__TASK7_EVENT_PROPAGATION_TRAIL__ = []
          pageWindow.__TASK7_EVENT_METHOD_CALLS__ = []
          pageWindow.__TASK7_RETRY_ONCLICK_ENTRIES__ = []
          pageWindow.__TASK7_RETRY_EVENT_LISTENERS__ = []
          pageWindow.__TASK7_RETRY_EVENT_METHOD_RESTORERS__ = []
          pageWindow.__TASK7_RETRY_REACT_PROP_PATCH__ = null
          const describeElement = (element: Element) => {
            const ownNames = Object.getOwnPropertyNames(element)
            const propsKey = ownNames.find((key) => key.startsWith('__reactProps$'))
            const props = propsKey ? (element as any)[propsKey] as Record<string, unknown> : null
            const onClickSource = typeof props?.onClick === 'function'
              ? String(props.onClick).replace(/\s+/g, ' ').slice(0, 480)
              : null
            return {
              tagName: element.tagName,
              id: element.id || null,
              role: element.getAttribute('role'),
              testId: element.getAttribute('data-testid'),
              hasReactProps: Boolean(propsKey),
              reactEventProps: props
                ? Object.keys(props).filter((key) => key === 'onClick' || key === 'onClickCapture')
                : [],
              onClickType: typeof props?.onClick,
              onClickName: typeof props?.onClick === 'function' ? props.onClick.name || null : null,
              onClickSource,
              onClickContainsRetryAuditMarker: onClickSource?.includes('reveal_retry_clicked') ?? false,
              onClickCaptureType: typeof props?.onClickCapture,
              hasReactFiber: ownNames.some((key) => key.startsWith('__reactFiber$')),
              hasReactContainer: ownNames.some((key) => key.startsWith('__reactContainer$')),
            }
          }
          const describePathNode = (node: EventTarget) => {
            if (node === window) return 'window'
            if (node === document) return 'document'
            if (node instanceof Element) {
              const role = node.getAttribute('role')
              return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${role ? `[role=${role}]` : ''}`
            }
            return node instanceof Node ? node.nodeName : typeof node
          }
          const readPerfAuditState = () => {
            const snapshot = pageWindow.__FRESHELL_TEST_HARNESS__?.getPerfAuditSnapshot?.() ?? null
            const events = snapshot?.perfEvents ?? []
            const latest = events.at(-1) as Record<string, unknown> | undefined
            return {
              snapshotAvailable: snapshot !== null,
              perfEventCount: events.length,
              latestEvent: latest
                ? { event: latest.event, stage: latest.stage, trigger: latest.trigger, refreshSerial: latest.refreshSerial }
                : null,
            }
          }
          const describeEvent = (event: MouseEvent) => ({
            isTrusted: event.isTrusted,
            bubbles: event.bubbles,
            cancelable: event.cancelable,
            composed: event.composed,
            eventPhase: event.eventPhase,
            cancelBubble: event.cancelBubble,
            defaultPrevented: event.defaultPrevented,
            target: event.target ? describePathNode(event.target) : null,
            composedPath: event.composedPath().slice(0, 24).map(describePathNode),
            perfAudit: readPerfAuditState(),
          })
          const alert = document.querySelector('[role="alert"][aria-label="The conversation could not be refreshed."]')
          const button = alert?.querySelector('button') as HTMLButtonElement | null
          const root = document.getElementById('root')
          const buttonOwnNames = button ? Object.getOwnPropertyNames(button) : []
          const buttonPropsKey = buttonOwnNames.find((key) => key.startsWith('__reactProps$'))
          const buttonProps = buttonPropsKey && button ? (button as any)[buttonPropsKey] as Record<string, unknown> : null
          const originalOnClick = buttonProps?.onClick
          let reactOnClickWrapped = false
          let reactOnClickPatchError: string | null = null
          if (buttonProps && typeof originalOnClick === 'function') {
            const wrappedOnClick = function (this: unknown, ...args: unknown[]) {
              const syntheticEvent = args[0] as { nativeEvent?: Event; defaultPrevented?: boolean } | undefined
              const entry: Record<string, unknown> = {
                eventIsSavedNativeEvent: syntheticEvent?.nativeEvent === pageWindow.__TASK7_RETRY_CLICK_EVENT__,
                syntheticDefaultPreventedAtEntry: syntheticEvent?.defaultPrevented ?? null,
                auditAtEntry: readPerfAuditState(),
              }
              pageWindow.__TASK7_RETRY_ONCLICK_ENTRIES__.push(entry)
              try {
                const result = (originalOnClick as (...args: unknown[]) => unknown).apply(this, args)
                entry.auditAfterHandler = readPerfAuditState()
                return result
              } catch (error) {
                entry.handlerError = error instanceof Error ? error.message : String(error)
                entry.auditAfterHandler = readPerfAuditState()
                throw error
              }
            }
            try {
              buttonProps.onClick = wrappedOnClick
              reactOnClickWrapped = buttonProps.onClick === wrappedOnClick
              pageWindow.__TASK7_RETRY_REACT_PROP_PATCH__ = { buttonProps, originalOnClick, wrappedOnClick }
            } catch (error) {
              reactOnClickPatchError = error instanceof Error ? error.message : String(error)
            }
          }
          const isRetryButtonEvent = (event: MouseEvent) => Boolean(button && event.composedPath().includes(button))
          const rememberEventMethod = (event: MouseEvent, method: 'preventDefault' | 'stopPropagation' | 'stopImmediatePropagation') => {
            const originalDescriptor = Object.getOwnPropertyDescriptor(event, method)
            const originalMethod = (event as any)[method] as (...args: unknown[]) => unknown
            try {
              Object.defineProperty(event, method, {
                configurable: true,
                writable: true,
                value: function (...args: unknown[]) {
                  pageWindow.__TASK7_EVENT_METHOD_CALLS__.push({
                    method,
                    stack: new Error(`Retry click ${method}`).stack?.split('\n').slice(0, 8).join('\n').slice(0, 1400) ?? null,
                    cancelBubbleBefore: event.cancelBubble,
                    defaultPreventedBefore: event.defaultPrevented,
                  })
                  return originalMethod.apply(event, args)
                },
              })
              pageWindow.__TASK7_RETRY_EVENT_METHOD_RESTORERS__ ??= []
              pageWindow.__TASK7_RETRY_EVENT_METHOD_RESTORERS__.push({ event, method, originalDescriptor })
            } catch (error) {
              pageWindow.__TASK7_EVENT_METHOD_CALLS__.push({
                method,
                patchError: error instanceof Error ? error.message : String(error),
              })
            }
          }
          const captureListener = (event: MouseEvent) => {
            const matchesRetryButton = isRetryButtonEvent(event)
            const target = event.target instanceof Element ? event.target.closest('button') : null
            const alertAtCapture = target?.closest('[role="alert"]') ?? null
            pageWindow.__TASK7_DOCUMENT_CAPTURE_EVENTS__.push({
              count: pageWindow.__TASK7_DOCUMENT_CAPTURE_EVENTS__.length + 1,
              matchesRetryButton,
              alertLabel: alertAtCapture?.getAttribute('aria-label') ?? null,
              event: describeEvent(event),
            })
            if (!matchesRetryButton) return
            pageWindow.__TASK7_RETRY_CLICK_EVENT__ = event
            for (const method of ['preventDefault', 'stopPropagation', 'stopImmediatePropagation'] as const) {
              rememberEventMethod(event, method)
            }
            const ancestry: Array<Record<string, unknown>> = []
            let current: Element | null = target
            while (current && ancestry.length < 64) {
              ancestry.push(describeElement(current))
              if (current === root) break
              current = current.parentElement
            }
            const dispatch: Record<string, unknown> = {
              dispatched: true,
              event: describeEvent(event),
              targetConnected: button?.isConnected ?? false,
              targetDisabled: button?.disabled ?? null,
              targetMatchesAlert: alertAtCapture?.getAttribute('aria-label') === 'The conversation could not be refreshed.',
              activeTabId: pageWindow.__FRESHELL_TEST_HARNESS__?.getState()?.tabs?.activeTabId ?? null,
              documentBubbleSeen: false,
              ancestry,
            }
            pageWindow.__TASK7_RETRY_CLICK_DISPATCH__ = dispatch
          }
          const bubbleListener = (event: MouseEvent) => {
            const matchesSavedEvent = event === pageWindow.__TASK7_RETRY_CLICK_EVENT__
            const dispatch = pageWindow.__TASK7_RETRY_CLICK_DISPATCH__
            pageWindow.__TASK7_DOCUMENT_BUBBLE_EVENTS__.push({
              count: pageWindow.__TASK7_DOCUMENT_BUBBLE_EVENTS__.length + 1,
              matchesSavedEvent,
              event: describeEvent(event),
            })
            if (!matchesSavedEvent || !dispatch) return
            dispatch.documentBubbleSeen = true
            dispatch.eventAtDocumentBubble = describeEvent(event)
          }
          const addPropagationProbe = (node: EventTarget | null, nodeLabel: string, capture: boolean) => {
            if (!node) return
            const listener = (event: Event) => {
              if (event !== pageWindow.__TASK7_RETRY_CLICK_EVENT__) return
              pageWindow.__TASK7_EVENT_PROPAGATION_TRAIL__.push({
                node: nodeLabel,
                phase: capture ? 'capture' : 'bubble',
                event: describeEvent(event as MouseEvent),
              })
            }
            node.addEventListener('click', listener, capture)
            pageWindow.__TASK7_RETRY_EVENT_LISTENERS__.push({ node, listener, capture })
          }
          pageWindow.__TASK7_RETRY_CAPTURE_LISTENER__ = captureListener
          pageWindow.__TASK7_RETRY_BUBBLE_LISTENER__ = bubbleListener
          addPropagationProbe(button, 'retry-button', true)
          addPropagationProbe(button, 'retry-button', false)
          addPropagationProbe(root, '#root', true)
          addPropagationProbe(root, '#root', false)
          document.addEventListener('click', captureListener, true)
          addPropagationProbe(document, 'document-capture', true)
          document.addEventListener('click', bubbleListener)
          addPropagationProbe(document, 'document-bubble', false)
          return {
            alertFound: Boolean(alert),
            buttonFound: Boolean(button),
            buttonConnected: button?.isConnected ?? false,
            buttonDisabled: (button as HTMLButtonElement | null)?.disabled ?? null,
            buttonReact: button ? describeElement(button) : null,
            rootReact: document.getElementById('root') ? describeElement(document.getElementById('root')!) : null,
            reactOnClickWrapped,
            reactOnClickPatchError,
            perfAuditAtListenerInstall: readPerfAuditState(),
          }
        })
        const collectRetryUiAfterClick = () => mobile.page.evaluate(() => {
          const pageWindow = window as any
          const alerts = Array.from(document.querySelectorAll('[role="alert"]'))
            .map((alert) => ({ label: alert.getAttribute('aria-label'), text: alert.textContent?.trim() ?? '' }))
          const retryAlert = document.querySelector('[role="alert"][aria-label="The conversation could not be refreshed."]')
          const button = retryAlert?.querySelector('button')
          const clickEvent = pageWindow.__TASK7_RETRY_CLICK_EVENT__ as MouseEvent | null
          const clickDispatch = pageWindow.__TASK7_RETRY_CLICK_DISPATCH__ ?? null
          const eventAfterDispatch = clickEvent ? {
            bubbles: clickEvent.bubbles,
            cancelable: clickEvent.cancelable,
            composed: clickEvent.composed,
            cancelBubble: clickEvent.cancelBubble,
            defaultPrevented: clickEvent.defaultPrevented,
            eventPhase: clickEvent.eventPhase,
          } : null
          const documentCaptureEvents = [...(pageWindow.__TASK7_DOCUMENT_CAPTURE_EVENTS__ ?? [])]
          const documentBubbleEvents = [...(pageWindow.__TASK7_DOCUMENT_BUBBLE_EVENTS__ ?? [])]
          const propagationTrail = [...(pageWindow.__TASK7_EVENT_PROPAGATION_TRAIL__ ?? [])]
          const eventMethodCalls = [...(pageWindow.__TASK7_EVENT_METHOD_CALLS__ ?? [])]
          const onClickEntries = [...(pageWindow.__TASK7_RETRY_ONCLICK_ENTRIES__ ?? [])]
          const auditBridgeAtRead = (() => {
            const snapshot = pageWindow.__FRESHELL_TEST_HARNESS__?.getPerfAuditSnapshot?.() ?? null
            const events = snapshot?.perfEvents ?? []
            const latest = events.at(-1) as Record<string, unknown> | undefined
            return {
              snapshotAvailable: snapshot !== null,
              perfEventCount: events.length,
              latestEvent: latest
                ? { event: latest.event, stage: latest.stage, trigger: latest.trigger, refreshSerial: latest.refreshSerial }
                : null,
            }
          })()
          const propPatch = pageWindow.__TASK7_RETRY_REACT_PROP_PATCH__
          let reactOnClickRestored = false
          const cleanupErrors: string[] = []
          try {
            if (propPatch?.buttonProps?.onClick === propPatch.wrappedOnClick) {
              propPatch.buttonProps.onClick = propPatch.originalOnClick
              reactOnClickRestored = propPatch.buttonProps.onClick === propPatch.originalOnClick
            }
          } catch (error) {
            cleanupErrors.push(error instanceof Error ? error.message : String(error))
          }
          const methodRestorers = pageWindow.__TASK7_RETRY_EVENT_METHOD_RESTORERS__ ?? []
          for (const restorer of methodRestorers) {
            try {
              if (restorer.originalDescriptor) {
                Object.defineProperty(restorer.event, restorer.method, restorer.originalDescriptor)
              } else {
                delete restorer.event[restorer.method]
              }
            } catch (error) {
              cleanupErrors.push(error instanceof Error ? error.message : String(error))
            }
          }
          const captureListener = pageWindow.__TASK7_RETRY_CAPTURE_LISTENER__
          const bubbleListener = pageWindow.__TASK7_RETRY_BUBBLE_LISTENER__
          if (typeof captureListener === 'function') {
            document.removeEventListener('click', captureListener, true)
          }
          if (typeof bubbleListener === 'function') document.removeEventListener('click', bubbleListener)
          for (const registration of pageWindow.__TASK7_RETRY_EVENT_LISTENERS__ ?? []) {
            try {
              registration.node.removeEventListener('click', registration.listener, registration.capture)
            } catch (error) {
              cleanupErrors.push(error instanceof Error ? error.message : String(error))
            }
          }
          pageWindow.__TASK7_RETRY_CAPTURE_LISTENER__ = null
          pageWindow.__TASK7_RETRY_BUBBLE_LISTENER__ = null
          pageWindow.__TASK7_RETRY_CLICK_EVENT__ = null
          return {
            clickDispatch,
            eventAfterDispatch,
            documentCaptureEvents,
            documentBubbleEvents,
            propagationTrail,
            eventMethodCalls,
            onClickEntries,
            auditBridgeAtRead,
            reactOnClickRestored,
            cleanupErrors,
            activeTabId: pageWindow.__FRESHELL_TEST_HARNESS__?.getState()?.tabs?.activeTabId ?? null,
            retryAlertPresent: Boolean(retryAlert),
            retryAlertText: retryAlert?.textContent?.trim() ?? null,
            retryButtonVisible: Boolean(button && button.getClientRects().length > 0),
            retryButtonEnabled: Boolean(button && !(button as HTMLButtonElement).disabled),
            alerts,
          }
        })
        let retryUiAfterClick: Awaited<ReturnType<typeof collectRetryUiAfterClick>> | null = null
        let retryClickFailure: unknown = null
        try {
          await retryButton.tap()
        } catch (error) {
          retryClickFailure = error
        } finally {
          try {
            retryUiAfterClick = await collectRetryUiAfterClick()
          } catch (error) {
            retryClickFailure ??= error
          }
        }
        if (retryClickFailure) {
          throw new Error(`Retry click/cleanup failed: ${String(retryClickFailure)}; aftermath=${JSON.stringify(retryUiAfterClick)}`)
        }
        if (!retryUiAfterClick) throw new Error('Retry click aftermath snapshot was not captured')
        const immediatePostClick = await snapshotDiagnostics()
        const postClickAudit = immediatePostClick.audit.slice(auditCountBeforeClick)
        const retryClickAudit = [...postClickAudit].reverse()
          .find((event) => event.stage === 'reveal_retry_clicked')
        const retryRefreshRequestAudit = [...postClickAudit].reverse()
          .find((event) => event.stage === 'refresh_requested' && event.trigger === 'reveal'
            && typeof event.refreshSerial === 'number'
            && event.refreshSerial > Number(retryClickAudit?.attemptRequestId))
        const suppressedAudit = [...postClickAudit].reverse()
          .find((event) => event.stage === 'reveal_refresh_suppressed')
        console.info(JSON.stringify({
          event: 'task7_browser_refresh_post_click',
          mode,
          retryUiBeforeClick,
          retryClickProbe,
          retryUiAfterClick,
          requestsBeforeRetry,
          requestsImmediatelyAfterClick: immediatePostClick.requests,
          auditCountBeforeClick,
          postClickAudit,
          browserErrors: mobileBrowserErrors,
          browserErrorsAfterClick: mobileBrowserErrors.slice(browserErrorCountBeforeClick),
          retryClickAudit,
          retryRefreshRequestAudit,
          suppressedAudit,
        }))
        mobile.page.off('pageerror', onMobilePageError)
        mobile.page.off('console', onMobileConsoleError)
        expect(retryClickAudit, `Retry handler audit: ${JSON.stringify(immediatePostClick)}`).toBeDefined()
        expect(retryClickAudit).toMatchObject({
          tabId: mobile.tabId,
          paneId: mobile.paneId,
          activeTabId: mobile.tabId,
          activePaneId: mobile.paneId,
          isActivePane: true,
          hidden: false,
          dirty: true,
          errorVisible: true,
          attemptState: 'timed-out',
        })
        expect(retryRefreshRequestAudit, `Retry request audit: ${JSON.stringify(immediatePostClick)}`).toBeDefined()
        try {
          await expect.poll(() => mobileSnapshotRequests, {
            timeout: 25_000,
            message: 'Retry issues a new real snapshot request after click-handler execution',
          }).toBeGreaterThan(requestsBeforeRetry)
        } catch (error) {
          throw new Error(`${String(error)}\nPost-click diagnostics: ${JSON.stringify(await snapshotDiagnostics())}`)
        }
        await expect.poll(() => mobileSnapshotResponses.length, {
          timeout: 25_000,
          message: 'Retry receives a snapshot response',
        }).toBeGreaterThan(responsesBeforeRetry)
        await expect.poll(async () => (await snapshotDiagnostics()).audit
          .filter((event) => event.stage === 'reveal_refresh_evaluated').length, {
          timeout: 25_000,
          message: 'Retry response is evaluated against the current revision and freshness requirements',
        }).toBeGreaterThan(evaluationsBeforeRetry)
        const retryDiagnostics = await snapshotDiagnostics()
        const retryEvaluation = [...retryDiagnostics.audit].reverse().find((event) => event.stage === 'reveal_refresh_evaluated'
          && event.trigger === 'reveal' && event.refreshSerial === retryRefreshRequestAudit?.refreshSerial)
        const retryResponse = retryDiagnostics.responses.slice(responsesBeforeRetry)
          .find((response) => response.trigger === 'reveal')
        console.info(JSON.stringify({
          event: 'task7_browser_refresh_retry_diagnostic',
          mode,
          requestsBeforeRetry,
          requestsAfterRetry: retryDiagnostics.requests,
          response: retryResponse,
          evaluation: retryEvaluation,
        }))
        await expect(refreshFailure, `Retry response diagnostics: ${JSON.stringify(retryDiagnostics)}`)
          .toHaveCount(0, { timeout: 25_000 })
        expect(retryEvaluation).toMatchObject({
          trigger: 'reveal',
          requestSource: 'native',
          dirty: true,
          revealRefreshIsCurrent: true,
          revealRevisionIsFresh: true,
        })
        expect(retryResponse).toMatchObject({ status: 200 })
        expect(typeof retryResponse?.revision).toBe('number')
        expect(retryResponse?.revision as number).toBeGreaterThan(snapshotBeforeHeldTurn.revision)
        expect(retryEvaluation?.snapshotRevision).toBe(retryResponse?.revision)
        expect(retryEvaluation?.dirtyBaseRevision).toBe(snapshotBeforeHeldTurn.revision)
        await expect(mobile.page.getByTestId('fresh-agent-stale-transcript')).toHaveCount(0)
        await waitForPaneStatus(desktop, /^running$/)
        expect(await desktop.harness.getConnectionStatus()).toBe('ready')
        expect(await desktop.harness.getLastReadyAt()).toBe(desktopReadyAt)
        expect(native.bootCount(session.sessionId)).toBe(1)

        // Complete the older held response only after the current retry has
        // settled. Its request belongs to the timed-out attempt and cannot
        // replace the successful retry's verified transcript.
        heldSnapshot.release()
        await heldSnapshot.finished
        await expect(refreshFailure).toHaveCount(0)
        await expect(mobile.page.getByTestId('fresh-agent-stale-transcript')).toHaveCount(0)
      } finally {
        heldSnapshot.release()
        await native.releaseTurn().catch(() => {})
      }
    }, { perfAudit: true }))
  }

  for (const mode of MODES) {
    test(`stage2 cold open ${mode}: desktop and mobile join one held recovery`, withTwoDeviceSession(mode, async ({
      desktop,
      mobile,
      native,
      session,
      frames,
      restartServer,
    }) => {
      const desktopReady = await desktop.harness.getLastReadyAt()
      const mobileReady = await mobile.harness.getLastReadyAt()
      const desktopCursor = frames.desktop.length
      const mobileCursor = frames.mobile.length
      const recoveryAttemptsBefore = native.recoveryAttemptCount(session.sessionId)
      const runtimeStartsBefore = native.runtimeStartCount(session.sessionId)
      await native.holdNextRecovery(session.sessionId)
      await restartServer()
      await Promise.all([
        desktop.harness.waitForConnectionAfter(desktopReady, 60_000),
        mobile.harness.waitForConnectionAfter(mobileReady, 60_000),
      ])

      const [attemptResult, desktopActionResult, mobileActionResult] = await Promise.allSettled([
        native.waitForRecoveryAttempt(session.sessionId),
        recoveryAction(frames.desktop, desktop, session, desktopCursor),
        recoveryAction(frames.mobile, mobile, session, mobileCursor),
      ])
      const actionFailures = [
        desktopActionResult.status === 'rejected'
          ? `desktop(${desktop.viewId}): ${String(desktopActionResult.reason)}`
          : null,
        mobileActionResult.status === 'rejected'
          ? `mobile(${mobile.viewId}): ${String(mobileActionResult.reason)}`
          : null,
      ].filter((failure): failure is string => failure !== null)
      expect(actionFailures, 'both desktop and mobile send their own recovery request').toEqual([])
      if (desktopActionResult.status === 'rejected') throw desktopActionResult.reason
      if (mobileActionResult.status === 'rejected') throw mobileActionResult.reason
      const desktopAction = desktopActionResult.value
      const mobileAction = mobileActionResult.value
      if (attemptResult.status === 'rejected') {
        const recoveryRows = native.rows().filter((row) => row.event === 'session_get_started'
          || row.event === 'session_get_failed'
          || row.event === 'session_get')
        throw new Error(
          `expected a held native recovery attempt for ${session.sessionId}; `
          + `actions=${JSON.stringify([desktopAction, mobileAction].map((action) => ({
            type: action.type,
            requestId: action.requestId,
            viewId: action.viewId,
            sessionId: action.sessionId,
            sessionRef: action.sessionRef,
            capturedAtMs: action.capturedAtMs,
          })))}; native recovery rows=${JSON.stringify(recoveryRows)}`,
          { cause: attemptResult.reason },
        )
      }
      expect(desktopAction.requestId).not.toBe(mobileAction.requestId)
      const cohort = await assertJoinedRecoveryCohort(
        mode,
        native,
        session.sessionId,
        [desktopAction, mobileAction],
        recoveryAttemptsBefore,
      )
      const recoveryTrace = {
        requestIds: [desktopAction.requestId, mobileAction.requestId],
        joinedOperation: cohort,
        allAdmissions: await native.recoveryAdmissions(session.sessionId),
        nativeAttempts: native.recoveryAttemptRows(session.sessionId).slice(recoveryAttemptsBefore),
        allSessionGets: native.rows().filter((row) => row.event === 'session_get_started'
          && row.sessionId === session.sessionId),
      }
      const recoveryRequestId = cohort.find((row) => row.admission === 'started')?.request_id
      expect(native.recoveryAttemptCount(session.sessionId),
        `one native attempt before releasing the held operation; trace=${JSON.stringify(recoveryTrace)}`)
        .toBe(recoveryAttemptsBefore + 1)
      if (mode === 'freshopencode') {
        expect(recoveryTrace.nativeAttempts.map((row) => row.recoveryRequestId),
          `the one OpenCode GET belongs to the server request that started the shared operation; trace=${JSON.stringify(recoveryTrace)}`)
          .toEqual([recoveryRequestId])
      }
      await native.releaseRecovery()

      const [desktopResult, mobileResult] = await Promise.all([
        recoveryOutcome(frames.desktop, desktopAction, true),
        recoveryOutcome(frames.mobile, mobileAction, true),
      ])
      expect(desktopResult.sessionId).toBe(session.sessionId)
      expect(mobileResult.sessionId).toBe(session.sessionId)
      await Promise.all([
        waitForPaneStatus(desktop, /^(connected|idle)$/),
        waitForPaneStatus(mobile, /^(connected|idle)$/),
      ])
      const recoveryAttemptsAfterRelease = native.recoveryAttemptRows(session.sessionId)
        .slice(recoveryAttemptsBefore)
      const browserRecoveryActions = [
        ...frames.desktop.slice(desktopCursor).map((frame) => ({ device: 'desktop', frame })),
        ...frames.mobile.slice(mobileCursor).map((frame) => ({ device: 'mobile', frame })),
      ].filter(({ frame }) => frame.direction === 'sent'
        && (frame.type === 'freshAgent.create' || frame.type === 'freshAgent.attach'))
        .map(({ device, frame }) => ({
          device,
          type: frame.type,
          requestId: frame.requestId,
          viewId: frame.viewId,
          provider: frame.provider,
          sessionType: frame.sessionType,
          sessionId: frame.sessionId,
          sessionRef: (frame.sessionRef as Record<string, unknown> | undefined)?.sessionId,
          capturedAtMs: frame.capturedAtMs,
        }))
      const finalRecoveryTrace = {
        baselineAttemptCount: recoveryAttemptsBefore,
        finalAttemptCount: native.recoveryAttemptCount(session.sessionId),
        browserRequestIds: [desktopAction.requestId, mobileAction.requestId],
        browserRecoveryActions,
        admissions: await native.recoveryAdmissions(session.sessionId),
        allCodexResumeRows: mode === 'freshcodex'
          ? native.codexResumeRows().map((row) => ({
            auditSource: row.auditSource,
            at: row.at,
            threadId: (row.params as Record<string, unknown> | undefined)?.threadId,
            cwd: row.cwd,
          }))
          : undefined,
        recoveryAttemptsAfterBaseline: recoveryAttemptsAfterRelease.map((row) => ({
          at: row.at,
          threadId: (row.params as Record<string, unknown> | undefined)?.threadId,
          cwd: row.cwd,
        })),
      }
      expect(native.recoveryAttemptCount(session.sessionId),
        `one native recovery attempt after releasing the shared operation; trace=${JSON.stringify(finalRecoveryTrace)}`)
        .toBe(recoveryAttemptsBefore + 1)
      expect(native.runtimeStartCount(session.sessionId)).toBe(runtimeStartsBefore + 1)
    }))

    test(`stage2 stale authority ${mode}: delayed desktop attach joins mobile recovery`, withTwoDeviceSession(mode, async ({
      desktop,
      mobile,
      native,
      session,
      frames,
      restartServer,
    }) => {
      const desktopReady = await desktop.harness.getLastReadyAt()
      const mobileReady = await mobile.harness.getLastReadyAt()
      const desktopCursor = frames.desktop.length
      const mobileCursor = frames.mobile.length
      const attemptsBefore = native.recoveryAttemptCount(session.sessionId)
      const runtimeStartsBefore = native.runtimeStartCount(session.sessionId)
      const oldBinding = await native.readBinding(session.sessionId)
      const oldAuthority = {
        epoch: await native.readBootEpoch(),
        generation: typeof oldBinding.ownerGeneration === 'number' ? oldBinding.ownerGeneration : undefined,
      }
      expect(oldAuthority.generation, 'the existing owner has a durable generation before restart').toEqual(expect.any(Number))

      desktop.attachRequests.holdNext(desktop.viewId)
      await native.holdNextRecovery(session.sessionId)
      await restartServer()
      await Promise.all([
        desktop.harness.waitForConnectionAfter(desktopReady, 60_000),
        mobile.harness.waitForConnectionAfter(mobileReady, 60_000),
      ])

      const [heldDesktopAttach, mobileActionResult, recoveryAttemptResult] = await Promise.allSettled([
        desktop.attachRequests.waitForHeld(45_000),
        recoveryAction(frames.mobile, mobile, session, mobileCursor),
        native.waitForRecoveryAttempt(session.sessionId),
      ])
      if (heldDesktopAttach.status === 'rejected') throw heldDesktopAttach.reason
      if (mobileActionResult.status === 'rejected') throw mobileActionResult.reason
      if (recoveryAttemptResult.status === 'rejected') throw recoveryAttemptResult.reason
      const staleRequestId = heldDesktopAttach.value.requestId
      const mobileAction = mobileActionResult.value
      expect(heldDesktopAttach.value).toMatchObject({
        type: 'freshAgent.attach',
        viewId: desktop.viewId,
        provider: session.provider,
        sessionType: session.sessionType,
        sessionId: session.sessionId,
      })
      expect(staleRequestId).toEqual(expect.any(String))
      expect(staleRequestId).not.toBe(mobileAction.requestId)

      // Mobile completes the one shared recovery while desktop's older attach
      // is still held outside the server. Releasing it with the pre-restart
      // fence makes the late request exercise the stale-authority refusal.
      await native.releaseRecovery()
      const mobileResult = await recoveryOutcome(frames.mobile, mobileAction, true)
      expect(mobileResult.sessionId).toBe(session.sessionId)
      await waitForPaneStatus(mobile, /^(connected|idle)$/)

      desktop.attachRequests.release({ epoch: oldAuthority.epoch, generation: oldAuthority.generation! })
      const staleDesktopAttach = frames.desktop.slice(desktopCursor).find((frame) => frame.direction === 'sent'
        && frame.type === 'freshAgent.attach'
        && frame.requestId === staleRequestId)
      expect(staleDesktopAttach).toMatchObject({
        requestId: staleRequestId,
        viewId: desktop.viewId,
        observedEpoch: oldAuthority.epoch,
        observedGeneration: oldAuthority.generation,
      })
      let staleRefusal: JsonRow | undefined
      await expect.poll(() => {
        staleRefusal = frames.desktop.find((frame) => frame.direction === 'received'
          && frame.requestId === staleRequestId
          && frame.type === 'freshAgent.attach.failed')
        return staleRefusal ?? null
      }, {
        timeout: 30_000,
        message: 'the delayed pre-restart attach receives its own complete stale-owner refusal',
      }).not.toBeNull()
      expect(staleRefusal).toMatchObject({
        requestId: staleRequestId,
        viewId: desktop.viewId,
        ownerKind: 'fresh-agent',
        ownerEpoch: expect.any(Number),
        ownerGeneration: expect.any(Number),
      })
      const winnerAuthority = {
        epoch: staleRefusal!.ownerEpoch as number,
        generation: staleRefusal!.ownerGeneration as number,
      }
      expect(winnerAuthority.epoch).toBeGreaterThan(oldAuthority.epoch)

      let winningDesktopAttach: JsonRow | undefined
      await expect.poll(() => {
        winningDesktopAttach = frames.desktop.slice(desktopCursor).find((frame) => frame.direction === 'sent'
          && frame.type === 'freshAgent.attach'
          && frame.viewId === desktop.viewId
          && frame.requestId !== staleRequestId)
        return winningDesktopAttach ?? null
      }, {
        timeout: 30_000,
        message: 'desktop attaches to the recovered owner with a distinct immutable request',
      }).not.toBeNull()
      expect(winningDesktopAttach).toMatchObject({
        type: 'freshAgent.attach',
        viewId: desktop.viewId,
        provider: session.provider,
        sessionType: session.sessionType,
        sessionId: session.sessionId,
        observedEpoch: winnerAuthority.epoch,
        observedGeneration: winnerAuthority.generation,
      })
      expect(winningDesktopAttach?.requestId).not.toBe(staleRequestId)
      const desktopResult = await recoveryOutcome(frames.desktop, winningDesktopAttach!, true)
      expect(desktopResult.sessionId).toBe(session.sessionId)
      await waitForPaneStatus(desktop, /^(connected|idle)$/)

      const desktopAttachRequests = frames.desktop.slice(desktopCursor).filter((frame) => frame.direction === 'sent'
        && frame.type === 'freshAgent.attach'
        && frame.viewId === desktop.viewId
        && frame.provider === session.provider
        && frame.sessionType === session.sessionType
        && frame.sessionId === session.sessionId)
      expect(desktopAttachRequests).toHaveLength(2)
      expect(desktopAttachRequests.map((frame) => frame.requestId).sort()).toEqual([
        staleRequestId,
        winningDesktopAttach?.requestId,
      ].sort())
      expect(native.recoveryAttemptCount(session.sessionId)).toBe(attemptsBefore + 1)
      expect(native.runtimeStartCount(session.sessionId)).toBe(runtimeStartsBefore + 1)

      const state = await desktop.harness.getState()
      const ownerRecords = Object.values(state.freshAgent?.runtimeOwners ?? {}) as Array<Record<string, unknown>>
      const currentOwner = ownerRecords.find((owner) => owner.provider === session.provider
        && owner.sessionId === session.sessionId)
      expect(currentOwner).toMatchObject({
        ownerKind: 'fresh-agent',
        epoch: winnerAuthority.epoch,
        generation: winnerAuthority.generation,
      })
    }))

    test(`stage2 shared failure ${mode}: both views receive one failed recovery result`, withTwoDeviceSession(mode, async ({
      desktop,
      mobile,
      native,
      session,
      frames,
      restartServer,
    }) => {
      const desktopReady = await desktop.harness.getLastReadyAt()
      const mobileReady = await mobile.harness.getLastReadyAt()
      const desktopCursor = frames.desktop.length
      const mobileCursor = frames.mobile.length
      const recoveryAttemptsBefore = native.recoveryAttemptCount(session.sessionId)
      await native.holdNextRecovery(session.sessionId)
      await native.failNextRecovery()
      await restartServer()
      await Promise.all([
        desktop.harness.waitForConnectionAfter(desktopReady, 60_000),
        mobile.harness.waitForConnectionAfter(mobileReady, 60_000),
      ])

      const [attemptResult, desktopActionResult, mobileActionResult] = await Promise.allSettled([
        native.waitForRecoveryAttempt(session.sessionId),
        recoveryAction(frames.desktop, desktop, session, desktopCursor),
        recoveryAction(frames.mobile, mobile, session, mobileCursor),
      ])
      const actionFailures = [
        desktopActionResult.status === 'rejected'
          ? `desktop(${desktop.viewId}): ${String(desktopActionResult.reason)}`
          : null,
        mobileActionResult.status === 'rejected'
          ? `mobile(${mobile.viewId}): ${String(mobileActionResult.reason)}`
          : null,
      ].filter((failure): failure is string => failure !== null)
      expect(actionFailures, 'both desktop and mobile send their own recovery request').toEqual([])
      if (desktopActionResult.status === 'rejected') throw desktopActionResult.reason
      if (mobileActionResult.status === 'rejected') throw mobileActionResult.reason
      const desktopAction = desktopActionResult.value
      const mobileAction = mobileActionResult.value
      if (attemptResult.status === 'rejected') {
        const recoveryRows = native.rows().filter((row) => row.event === 'session_get_started'
          || row.event === 'session_get_failed'
          || row.event === 'session_get')
        throw new Error(
          `expected a held native recovery attempt for ${session.sessionId}; `
          + `actions=${JSON.stringify([desktopAction, mobileAction].map((action) => ({
            type: action.type,
            requestId: action.requestId,
            viewId: action.viewId,
            sessionId: action.sessionId,
            sessionRef: action.sessionRef,
            capturedAtMs: action.capturedAtMs,
          })))}; native recovery rows=${JSON.stringify(recoveryRows)}`,
          { cause: attemptResult.reason },
        )
      }
      expect(desktopAction.requestId).not.toBe(mobileAction.requestId)
      const cohort = await assertJoinedRecoveryCohort(
        mode,
        native,
        session.sessionId,
        [desktopAction, mobileAction],
        recoveryAttemptsBefore,
      )
      const recoveryTrace = {
        requestIds: [desktopAction.requestId, mobileAction.requestId],
        joinedOperation: cohort,
        allAdmissions: await native.recoveryAdmissions(session.sessionId),
        nativeAttempts: native.recoveryAttemptRows(session.sessionId).slice(recoveryAttemptsBefore),
        allSessionGets: native.rows().filter((row) => row.event === 'session_get_started'
          && row.sessionId === session.sessionId),
      }
      const recoveryRequestId = cohort.find((row) => row.admission === 'started')?.request_id
      expect(native.recoveryAttemptCount(session.sessionId),
        `one native attempt before releasing the held operation; trace=${JSON.stringify(recoveryTrace)}`)
        .toBe(recoveryAttemptsBefore + 1)
      if (mode === 'freshopencode') {
        expect(recoveryTrace.nativeAttempts.map((row) => row.recoveryRequestId),
          `the one OpenCode GET belongs to the server request that started the shared operation; trace=${JSON.stringify(recoveryTrace)}`)
          .toEqual([recoveryRequestId])
      }
      await native.releaseRecovery()

      const [desktopFailure, mobileFailure] = await Promise.all([
        recoveryOutcome(frames.desktop, desktopAction, false),
        recoveryOutcome(frames.mobile, mobileAction, false),
      ])
      expect(desktopFailure.code).toEqual(expect.any(String))
      expect(mobileFailure.code).toEqual(expect.any(String))
      expect(native.recoveryAttemptCount(session.sessionId)).toBe(recoveryAttemptsBefore + 1)
      if (desktopAction.type === 'freshAgent.attach') {
        expect(frames.mobile.some((frame) => frame.direction === 'received'
          && frame.type === 'freshAgent.attach.failed'
          && frame.requestId === desktopAction.requestId)).toBe(false)
      }
      if (mobileAction.type === 'freshAgent.attach') {
        expect(frames.desktop.some((frame) => frame.direction === 'received'
          && frame.type === 'freshAgent.attach.failed'
          && frame.requestId === mobileAction.requestId)).toBe(false)
      }
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
