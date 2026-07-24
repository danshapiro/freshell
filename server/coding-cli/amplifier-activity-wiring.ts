import { logger } from '../logger.js'
import {
  AMPLIFIER_ACTIVITY_SWEEP_MS,
  AmplifierActivityTracker,
} from './amplifier-activity-tracker.js'
import { wirePtyActivityTracker, type ActivityWiringRegistry } from './activity-wiring-factory.js'

type AmplifierActivityRegistry = ActivityWiringRegistry

/**
 * Registry→tracker wiring for Amplifier's PTY signals (submit/output/exit).
 * Thin wrapper over the shared wirePtyActivityTracker factory (Phase 4
 * consolidation with the claude wiring); the public surface is unchanged.
 * The events.jsonl lifecycle layers on top via amplifier-activity-integration.ts.
 */
export function wireAmplifierActivityTracker(input: {
  registry: AmplifierActivityRegistry
  now?: () => number
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
}) {
  return wirePtyActivityTracker({
    mode: 'amplifier',
    // The tracker's own warns (deadman force-read, events-lane-suspect) must
    // reach the production log for Phase-5 soak monitoring.
    tracker: new AmplifierActivityTracker({ log: logger.child({ component: 'amplifier-activity-tracker' }) }),
    sweepIntervalMs: AMPLIFIER_ACTIVITY_SWEEP_MS,
    // The amplifier tracker owns per-terminal debounce/grace timers.
    disposeTracker: (tracker) => tracker.dispose(),
    ...input,
  })
}
