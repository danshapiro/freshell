// @vitest-environment node
import { describe, expect, it } from 'vitest'
// @ts-expect-error Native executable harness is shared with the offline runner.
import { captureNativeScenario } from './codex-cli-contract.mjs'

describe('Codex 0.164.0 release contract through an isolated Responses provider', () => {
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
    }, 180_000,
  )
})
