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
    soulId: soul.soulId, incarnationId: soul.incarnationId,
    provider: soul.provider, profile: soul.profile, freshAgentSessionId: soul.freshAgentSessionId,
    freshAgentSessionType: soul.freshAgentSessionType, freshAgentCreateRequestId: soul.freshAgentCreateRequestId,
    freshAgentRuntimeVariant: soul.freshAgentRuntimeVariant, containerId: soul.containerId,
    hostBootId: soul.hostBootId, intentRevision: soul.intentRevision, executionGeneration: soul.executionGeneration,
    launchState: soul.launchState,
  }
}

/** Keep the exact owner and layout while its completed turn's metadata settles. */
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
      expect(soul).toMatchObject({ soulId: allocation.soulId, incarnationId: allocation.incarnationId,
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
      // Native materialization can reach the pane before the supervisor saves
      // that identity. Only the exact pending capture state admits absence;
      // the pane and allocation above still require the established native ID.
      if (soul.nativeSessionId === undefined) expect(pair).toEqual(['materializing', 'unknown'])
      else expect(soul.nativeSessionId).toBe(allocation.nativeSessionId)
      return { content, soul, view, pair }
    }
    const prior = bind(before), current = bind(after)
    const baselineLeaf = leaves(expected[allocation.tabId]).find(candidate => candidate.id === allocation.paneId)!
    if (baselineLeaf.content.kind !== 'fresh-agent') throw new Error('baseline fresh-agent History leaf required')
    // FreshAgentView publishes these asynchronously through the pane reducer,
    // which owns their validation. They do not change the pane or conversation.
    if (current.content.checkpointOutcomes !== undefined) {
      baselineLeaf.content.checkpointOutcomes = structuredClone(current.content.checkpointOutcomes)
    } else delete baselineLeaf.content.checkpointOutcomes
    expect(ownerIdentity(current.soul), 'History must retain the exact allocated runtime owner').toEqual(ownerIdentity(prior.soul))
    if (prior.soul.nativeSessionId !== undefined) {
      expect(current.soul.nativeSessionId, 'History cannot forget an established authoritative native identity').toBe(prior.soul.nativeSessionId)
    }
    expect(current.view, 'History must retain the exact view intent').toStrictEqual(prior.view)
    if (prior.content.status !== current.content.status) {
      // The fixture has completed its turn. Its final provider activity event
      // may settle while History is opening; that does not change the saved
      // pane or its runtime owner. Admit only the busy-to-idle completion edge.
      expect(prior.content.status, 'Only a completed pane may settle during History').toBe('running')
      expect(current.content.status, 'A completed pane must settle to idle').toBe('idle')
      baselineLeaf.content.status = current.content.status
    }
    if (prior.pair[0] !== current.pair[0] || prior.pair[1] !== current.pair[1]) {
      expect(prior.pair).toEqual(['materializing', 'unknown'])
      expect(current.pair).toEqual(['verified_durable', 'resume_captured'])
      if (!baselineLeaf.content.recoverySummary) throw new Error('baseline recovery summary required')
      baselineLeaf.content.recoverySummary.allocationState = 'verified_durable'
      baselineLeaf.content.recoverySummary.durabilityState = 'resume_captured'
    }
  }
  // Keep every other field, including all background panes and split geometry.
  expect(after.panes.layouts).toStrictEqual(expected)
}
