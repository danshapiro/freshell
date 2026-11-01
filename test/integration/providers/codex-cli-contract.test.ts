// @vitest-environment node
import { describe, expect, it } from 'vitest'
// @ts-expect-error Native executable harness is shared with the offline runner.
import { captureNativeScenario } from './codex-cli-contract.mjs'

describe('Codex 0.164.0 release contract through an isolated Responses provider', () => {
  it('refuses a missing real-client prerequisite before opening a native thread', async () => {
    await expect(captureNativeScenario('text-history', { policyClientProbe: '/freshell-missing-policy-client-probe' }))
      .rejects.toThrow(/freshell-missing-policy-client-probe/)
  }, 180_000)

  it.each(['legacy', 'paginated'])('retains the actual final answer through %s history and a cold resume', async historyMode => {
    const capture = await captureNativeScenario('text-history', { historyMode, timeoutMs: 120_000 })
    expect(capture.binary.version).toBe('0.164.0')
    expect(capture.observations.finalAssistantText).toBe('First fragment and final fragment')
    expect(capture.observations.resumedAssistantText).toBe(capture.observations.finalAssistantText)
    expect(capture.notifications.some((frame: any) => frame.method === 'item/agentMessage/delta')).toBe(true)
    expect(capture.fixtureTraffic.length).toBeGreaterThan(0)
    expect(capture.fixtureTraffic.every((request: any) => request.loopback)).toBe(true)
  }, 180_000)

  it.each(['legacy', 'paginated'])('preserves duplicate equal assistant bodies in %s history', async historyMode => {
    const capture = await captureNativeScenario('text-history', { historyMode, duplicateBodies: true, timeoutMs: 120_000 })
    expect(capture.observations.finalAssistantText).toBe('First fragment and final fragment\nFirst fragment and final fragment')
    expect(capture.observations.resumedAssistantText).toBe(capture.observations.finalAssistantText)
  }, 180_000)

  it.each(['active-input-stop', 'parent-child-read', 'plan-question-controls', 'mcp-form-url', 'model-effort-usage', 'approval-policy-restricted-exec'])(
    'executes the complete native %s scenario', async scenario => {
      const capture = await captureNativeScenario(scenario, { timeoutMs: 120_000 })
      expect(capture.passed).toBe(true)
      expect(capture.fixtureTraffic.length).toBeGreaterThan(0)
      if (scenario === 'model-effort-usage') {
        const [explicit, nativeDefault] = capture.observations.sameThreadNativeDefault
        expect(explicit.traffic[0].body.reasoning.effort).toBe('xhigh')
        expect(nativeDefault.params).not.toHaveProperty('effort')
        expect(nativeDefault.params.collaborationMode.settings.reasoning_effort).toBeNull()
        expect(nativeDefault.completed.params.turn.status).toBe('completed')
        expect(nativeDefault.traffic.length).toBeGreaterThan(0)
        expect(nativeDefault.current.thread.id).toBe(explicit.current.thread.id)
      }
    }, 180_000,
  )
  it.each(['read-only', 'workspace-write'])('executes restricted never policy with actual %s effects', async sandboxMode => {
    const capture = await captureNativeScenario('approval-policy-restricted-exec', { sandboxMode, probeApprovalPolicy: 'never', probePolicyEffects: true, timeoutMs: 120_000 })
    expect(capture.observations.restrictedCommandExecuted).toBe(true)
    expect(capture.observations.policyEffects).toEqual(expect.objectContaining({ outsideWrite: false, gitWrite: false, codexWrite: false, agentsWrite: false, homeWrite: false, stateWrite: false, excludedTmpdirWrite: false, excludedGlobalTempWrite: false, networkRequests: 0 }))
    expect(capture.observations.workspaceWritePresent).toBe(sandboxMode === 'workspace-write')
  }, 180_000)

  it('refuses untrusted work through the real Rust client under actual native requirements', async () => {
    const capture = await captureNativeScenario('approval-policy-restricted-exec', { requirementsGuard: true, timeoutMs: 120_000 })
    expect(capture.observations.requirementsGuard.refusedRoutes).toEqual(['create', 'resume', 'fork', 'send'])
    expect(capture.observations.requirementsGuard.workRequests).toBe(0)
    expect(capture.observations.requirementsGuard.ownedListenerSettled).toBe(true)
    expect(capture.processCloses).toEqual(capture.processExits)
    expect(capture.fixtureTraffic).toHaveLength(0)
  }, 180_000)

  it.each(['stdin', 'network'])('executes actual %s approval effects and cancellation', async approvalControl => {
    const capture = await captureNativeScenario('approval-policy-restricted-exec', { approvalControl, timeoutMs: 120_000 })
    expect(capture.passed).toBe(true)
    expect(approvalControl === 'stdin' ? capture.observations.stdinCases.length : capture.observations.networkCases.length).toBe(approvalControl === 'stdin' ? 4 : 5)
  }, 180_000)

  it('cancels genuine MCP startup without inventing a turn terminal', async () => {
    const capture = await captureNativeScenario('active-input-stop', { startupCancellation: true, timeoutMs: 120_000 })
    expect(capture.observations.startupCancellation.nativeStartupResult.status).toBe('cancelled')
    expect(capture.fixtureTraffic).toHaveLength(0)
  }, 180_000)

  it('reads ephemeral child metadata without taking a writer role', async () => {
    const capture = await captureNativeScenario('parent-child-read', { ephemeralParent: true, timeoutMs: 120_000 })
    expect(capture.observations.childAvailability).toBe('ephemeral_history_unavailable')
    expect(capture.observations.childObserverMethods.every((method: string) => method === 'thread/read')).toBe(true)
  }, 180_000)

  it.each(['legacy', 'paginated'])('captures actual large command and MCP persistence in %s history', async historyMode => {
    const capture = await captureNativeScenario('mcp-form-url', { historyMode, largeOutput: true, timeoutMs: 120_000 })
    expect(capture.observations.largeOutputReads.map((read: any) => read.label)).toEqual(['warm', 'cold-resume'])
  }, 180_000)

  it.each(['legacy', 'paginated'])('captures delayed persistence and finite failed refresh in %s history', async historyMode => {
    const capture = await captureNativeScenario('text-history', { historyMode, persistenceMode: 'delayed', timeoutMs: 120_000 })
    expect(capture.observations.boundedRefresh).toHaveLength(3)
    expect(capture.observations.retainedCompletedText).toBe('First fragment and final fragment')
    expect(['saved-after-owned-blocker-release-and-cold-recovery', 'retained-unsaved-provider-unavailable-refresh-stopped']).toContain(capture.observations.persistenceState)
  }, 180_000)

  it.each(['legacy', 'paginated'])('captures genuinely missing persistence after owned exit in %s history', async historyMode => {
    const capture = await captureNativeScenario('text-history', { historyMode, persistenceMode: 'missing', timeoutMs: 120_000 })
    expect(capture.observations.coldMissingFaultRemoved).toBe(true)
    expect(capture.observations.coldRecoveryState).toBe('saved-history-unavailable-no-invented-fragments')
  }, 180_000)

  it('preserves native untrusted intent in the spawned child without a writer takeover', async () => {
    const capture = await captureNativeScenario('parent-child-read', { childApproval: true, timeoutMs: 120_000 })
    expect(capture.observations.childApprovalPolicyProof.parentPolicy).toBe('untrusted')
    expect(capture.observations.childApprovalPolicyProof.request.threadId).toBe(capture.observations.childId)
    expect(capture.observations.childObserverMethods.every((method: string) => method === 'thread/read')).toBe(true)
  }, 180_000)

})
