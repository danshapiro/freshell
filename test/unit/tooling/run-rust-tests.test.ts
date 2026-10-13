// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { shouldRunProviderCrashRecoveryGate } from '../../../scripts/testing/run-rust-tests.js'

describe('shouldRunProviderCrashRecoveryGate', () => {
  it('schedules crash recovery after a full Unix Rust run', () => {
    expect(shouldRunProviderCrashRecoveryGate('linux', [])).toBe(true)
  })

  it('skips the Unix-only crash selector on Windows', () => {
    expect(shouldRunProviderCrashRecoveryGate('win32', [])).toBe(false)
  })

  it('does not add the full crash suite to a filtered Rust run', () => {
    expect(shouldRunProviderCrashRecoveryGate('linux', ['provider_environment::tests'])).toBe(false)
  })
})
