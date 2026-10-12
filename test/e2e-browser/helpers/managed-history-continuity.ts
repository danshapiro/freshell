import { expect } from '@playwright/test'
import type { ManagedRuntimeSoul } from '../../../shared/managed-runtime.js'
import type { PaneNode } from '../../../src/store/paneTypes.js'
import type { RootState } from '../../../src/store/store.js'

export type OwnedHistoryAllocation = {
  tabId: string; paneId: string; createRequestId: string; createdSessionId: string
  sessionType: string; provider: string; nativeSessionId: string
  soulId: string; incarnationId: string
  containerId: string; hostBootId: string; intentRevision: number
}

type HistoryState = Pick<RootState, 'panes' | 'managedRuntime'>

function leaves(node: PaneNode): Extract<PaneNode, { type: 'leaf' }>[] {
  return node.type === 'leaf' ? [node] : node.children.flatMap(leaves)
}

function ownerIdentity(soul: ManagedRuntimeSoul) {
  return {
    soulId: soul.soulId, incarnationId: soul.incarnationId, nativeSessionId: soul.nativeSessionId,
    provider: soul.provider, profile: soul.profile, freshAgentSessionId: soul.freshAgentSessionId,
    freshAgentSessionType: soul.freshAgentSessionType, freshAgentCreateRequestId: soul.freshAgentCreateRequestId,
    freshAgentRuntimeVariant: soul.freshAgentRuntimeVariant, containerId: soul.containerId,
    hostBootId: soul.hostBootId, intentRevision: soul.intentRevision, executionGeneration: soul.executionGeneration,
    launchState: soul.launchState,
  }
}

/** Only this fixture's exact same-owner durability advance may change a layout payload. */
export function assertManagedHistoryContinuity(before: HistoryState, after: HistoryState, allocations: OwnedHistoryAllocation[]) {
  expect(Number.isSafeInteger(before.managedRuntime.revision)).toBe(true)
  expect(before.managedRuntime.revision).toBeGreaterThanOrEqual(0)
  expect(Number.isSafeInteger(after.managedRuntime.revision)).toBe(true)
  expect(after.managedRuntime.revision, 'History inventory cannot move backwards').toBeGreaterThanOrEqual(before.managedRuntime.revision)
  const expected = structuredClone(before.panes.layouts)
  for (const allocation of allocations) {
    const bind = (state: HistoryState) => {
      const root = state.panes.layouts[allocation.tabId]
      expect(root, 'existing owner layout must remain present').toBeTruthy()
      const matches = leaves(root).filter(leaf => leaf.id === allocation.paneId)
      expect(matches, 'one existing owned History leaf').toHaveLength(1)
      const content = matches[0].content
      expect(content).toMatchObject({ kind: 'fresh-agent', createRequestId: allocation.createRequestId,
        sessionType: allocation.sessionType, provider: allocation.provider,
        sessionId: allocation.nativeSessionId, resumeSessionId: allocation.nativeSessionId,
        sessionRef: { provider: allocation.provider, sessionId: allocation.nativeSessionId },
        soulId: allocation.soulId, incarnationId: allocation.incarnationId })
      if (content.kind !== 'fresh-agent') throw new Error('owned fresh-agent History leaf required')
      const runtimeProvider = allocation.sessionType === 'kilroy' ? 'kilroy' : allocation.provider
      const souls = state.managedRuntime.souls.filter(soul => soul.soulId === allocation.soulId
        || soul.provider === runtimeProvider && (soul.nativeSessionId === allocation.nativeSessionId
          || soul.freshAgentSessionId === allocation.createdSessionId))
      expect(souls, 'unique authoritative History soul').toHaveLength(1)
      const soul = souls[0]
      expect(soul).toMatchObject({ soulId: allocation.soulId, incarnationId: allocation.incarnationId, nativeSessionId: allocation.nativeSessionId,
        provider: runtimeProvider, profile: 'default_agent',
        containerId: allocation.containerId, hostBootId: allocation.hostBootId, intentRevision: allocation.intentRevision,
        freshAgentSessionId: allocation.createdSessionId, freshAgentSessionType: allocation.sessionType,
        freshAgentCreateRequestId: allocation.createRequestId })
      expect(soul.containerId).toBeTruthy()
      expect(soul.hostBootId).toBeTruthy()
      expect(Number.isSafeInteger(soul.intentRevision)).toBe(true)
      expect(soul.intentRevision).toBeGreaterThanOrEqual(0)
      expect(Number.isSafeInteger(soul.executionGeneration)).toBe(true)
      expect(soul.executionGeneration).toBeGreaterThanOrEqual(0)
      expect(content.viewIntentId).toBeTruthy()
      const views = state.managedRuntime.viewIntents.filter(view => view.viewId === content.viewIntentId
        || view.preferredTabId === allocation.tabId && view.preferredPaneId === allocation.paneId)
      expect(views, 'unique authoritative History view').toHaveLength(1)
      const view = views[0]
      expect(view).toMatchObject({ viewId: content.viewIntentId, soulId: allocation.soulId,
        preferredTabId: allocation.tabId, preferredPaneId: allocation.paneId })
      expect(Number.isSafeInteger(view.revision)).toBe(true)
      expect(view.revision).toBeGreaterThanOrEqual(0)
      expect(view.soulIntentRevision).toBe(soul.intentRevision)
      expect(content.viewIntentRevision).toBe(view.revision)
      expect(content.soulIntentRevision).toBe(soul.intentRevision)
      expect(content.incarnationId).toBe(soul.incarnationId)
      expect(content.runtimeState).toBe(soul.launchState)
      expect(content.recoverySummary, 'History durability must be corroborated in the same snapshot')
        .toEqual({ desiredState: soul.desiredState, recoveryState: soul.recoveryState,
          reason: soul.recoveryReason, attemptId: soul.recoveryAttemptId, incidentId: soul.incidentId,
          allocationState: soul.allocationState, durabilityState: soul.durabilityState })
      const pair = [content.recoverySummary?.allocationState, content.recoverySummary?.durabilityState]
      expect([['materializing', 'unknown'], ['verified_durable', 'resume_captured']]).toContainEqual(pair)
      return { content, soul, view, pair }
    }
    const prior = bind(before), current = bind(after)
    expect(ownerIdentity(current.soul), 'History must retain the exact allocated runtime owner').toEqual(ownerIdentity(prior.soul))
    expect(current.view, 'History must retain the exact view intent').toStrictEqual(prior.view)
    if (prior.pair[0] !== current.pair[0] || prior.pair[1] !== current.pair[1]) {
      expect(prior.pair).toEqual(['materializing', 'unknown'])
      expect(current.pair).toEqual(['verified_durable', 'resume_captured'])
      const leaf = leaves(expected[allocation.tabId]).find(candidate => candidate.id === allocation.paneId)!
      if (leaf.content.kind !== 'fresh-agent' || !leaf.content.recoverySummary) throw new Error('baseline recovery summary required')
      leaf.content.recoverySummary.allocationState = 'verified_durable'
      leaf.content.recoverySummary.durabilityState = 'resume_captured'
    }
  }
  // Keep every other field, including all background panes and split geometry.
  expect(after.panes.layouts).toStrictEqual(expected)
}
