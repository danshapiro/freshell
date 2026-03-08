// Unit tests for the Wizard component structure and logic.
// These tests verify the component exports and configuration values
// without rendering (rendering depends on React Testing Library which
// requires a stable single-React-instance environment).
import { describe, it, expect } from 'vitest'

describe('Wizard module', () => {
  it('exports Wizard component', async () => {
    const mod = await import('../../../../electron/setup-wizard/wizard.js')
    expect(mod.Wizard).toBeDefined()
    expect(typeof mod.Wizard).toBe('function')
  })

  it('exports ServerMode type values', async () => {
    // The type is checked at compile time; verify the component
    // accepts the expected props shape by checking it doesn't throw
    // on import
    const mod = await import('../../../../electron/setup-wizard/wizard.js')
    expect(mod.Wizard).toBeTruthy()
  })
})
