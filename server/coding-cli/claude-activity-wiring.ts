import {
  CLAUDE_ACTIVITY_SWEEP_MS,
  ClaudeActivityTracker,
} from './claude-activity-tracker.js'
import { wirePtyActivityTracker, type ActivityWiringRegistry } from './activity-wiring-factory.js'

type ClaudeActivityRegistry = ActivityWiringRegistry

/**
 * Registry→tracker wiring for Claude. Thin wrapper over the shared
 * wirePtyActivityTracker factory (Phase 4 consolidation with the amplifier
 * wiring); the public surface is unchanged.
 */
export function wireClaudeActivityTracker(input: {
  registry: ClaudeActivityRegistry
  now?: () => number
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
}) {
  return wirePtyActivityTracker({
    mode: 'claude',
    tracker: new ClaudeActivityTracker(),
    sweepIntervalMs: CLAUDE_ACTIVITY_SWEEP_MS,
    ...input,
  })
}
