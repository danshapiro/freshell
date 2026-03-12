/**
 * Pure logic functions for the setup wizard.
 * Extracted from wizard.tsx so they can be tested without React rendering,
 * which requires a single React instance (problematic in git worktrees).
 */

export type ServerMode = 'daemon' | 'app-bound' | 'remote'

export interface WizardConfig {
  serverMode: ServerMode
  port: number
  remoteUrl: string
  remoteToken: string
  globalHotkey: string
}

export const STEPS = ['welcome', 'server-mode', 'configuration', 'hotkey', 'complete'] as const
export type Step = typeof STEPS[number]

export const DEFAULT_PORT = 3001
export const DEFAULT_HOTKEY = 'CommandOrControl+`'
export const PORT_MIN = 1024
export const PORT_MAX = 65535

/**
 * Validate a port number.
 * Returns an error message string if invalid, or empty string if valid.
 */
export function validatePort(value: number): string {
  if (isNaN(value) || value < PORT_MIN || value > PORT_MAX) {
    return `Port must be between ${PORT_MIN} and ${PORT_MAX}`
  }
  return ''
}

/**
 * Validate a URL string.
 * Returns an error message string if invalid, or empty string if valid.
 */
export function validateUrl(value: string): string {
  try {
    new URL(value)
    return ''
  } catch {
    return 'Please enter a valid URL'
  }
}

/**
 * Determine whether the user can advance from the current step.
 * Returns an error message if blocked, or empty string if allowed.
 */
export function canAdvance(
  step: Step,
  serverMode: ServerMode,
  port: number,
  remoteUrl: string,
): string {
  if (step === 'configuration') {
    if (serverMode === 'remote') {
      return validateUrl(remoteUrl)
    }
    if (serverMode === 'daemon' || serverMode === 'app-bound') {
      return validatePort(port)
    }
  }
  return ''
}

/**
 * Compute the next step index, clamped to the valid range.
 */
export function nextStep(current: number): number {
  return Math.min(current + 1, STEPS.length - 1)
}

/**
 * Compute the previous step index, clamped to 0.
 */
export function prevStep(current: number): number {
  return Math.max(current - 1, 0)
}

/**
 * Build the final WizardConfig from the wizard state.
 */
export function buildConfig(
  serverMode: ServerMode,
  port: number,
  remoteUrl: string,
  remoteToken: string,
  globalHotkey: string,
): WizardConfig {
  return { serverMode, port, remoteUrl, remoteToken, globalHotkey }
}
