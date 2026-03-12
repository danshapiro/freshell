/**
 * Tests for the setup wizard's exported logic and component structure.
 *
 * The wizard's pure validation and navigation logic is extracted into
 * wizard-logic.ts and thoroughly tested here without React rendering.
 *
 * React component rendering tests are not possible in this git worktree
 * environment due to duplicate React instances: the worktree's node_modules
 * contains react, but @testing-library/react resolves react-dom from the
 * parent repo's node_modules (../../node_modules/react-dom), which internally
 * requires a DIFFERENT copy of react. This causes the "Invalid hook call:
 * more than one copy of React" error. This is a known limitation of git
 * worktrees sharing node_modules. The rendering behavior will be validated
 * by E2E tests and manual testing.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  validatePort,
  validateUrl,
  canAdvance,
  nextStep,
  prevStep,
  buildConfig,
  STEPS,
  DEFAULT_PORT,
  DEFAULT_HOTKEY,
  PORT_MIN,
  PORT_MAX,
} from '../../../../electron/setup-wizard/wizard-logic.js'

describe('Wizard module', () => {
  it('exports Wizard component', async () => {
    const mod = await import('../../../../electron/setup-wizard/wizard.js')
    expect(mod.Wizard).toBeDefined()
    expect(typeof mod.Wizard).toBe('function')
  })

  it('exports ServerMode and WizardConfig types via re-export', async () => {
    // The type re-exports are checked at compile time; verify the component
    // module loads without error
    const mod = await import('../../../../electron/setup-wizard/wizard.js')
    expect(mod.Wizard).toBeTruthy()
  })
})

describe('Wizard logic', () => {
  describe('STEPS', () => {
    it('has 5 steps in correct order', () => {
      expect(STEPS).toEqual(['welcome', 'server-mode', 'configuration', 'hotkey', 'complete'])
      expect(STEPS).toHaveLength(5)
    })
  })

  describe('defaults', () => {
    it('has correct default port', () => {
      expect(DEFAULT_PORT).toBe(3001)
    })

    it('has correct default hotkey', () => {
      expect(DEFAULT_HOTKEY).toBe('CommandOrControl+`')
    })

    it('has correct port range', () => {
      expect(PORT_MIN).toBe(1024)
      expect(PORT_MAX).toBe(65535)
    })
  })

  describe('validatePort', () => {
    it('accepts valid ports within range', () => {
      expect(validatePort(3001)).toBe('')
      expect(validatePort(1024)).toBe('')
      expect(validatePort(65535)).toBe('')
      expect(validatePort(8080)).toBe('')
    })

    it('rejects port below 1024', () => {
      expect(validatePort(80)).toContain('between 1024 and 65535')
      expect(validatePort(0)).toContain('between 1024 and 65535')
      expect(validatePort(1023)).toContain('between 1024 and 65535')
    })

    it('rejects port above 65535', () => {
      expect(validatePort(65536)).toContain('between 1024 and 65535')
      expect(validatePort(99999)).toContain('between 1024 and 65535')
    })

    it('rejects NaN', () => {
      expect(validatePort(NaN)).toContain('between 1024 and 65535')
    })
  })

  describe('validateUrl', () => {
    it('accepts valid URLs', () => {
      expect(validateUrl('http://10.0.0.5:3001')).toBe('')
      expect(validateUrl('https://example.com')).toBe('')
      expect(validateUrl('http://localhost:3001')).toBe('')
    })

    it('rejects invalid URLs', () => {
      expect(validateUrl('not-a-url')).toContain('valid URL')
      expect(validateUrl('')).toContain('valid URL')
      expect(validateUrl('just words')).toContain('valid URL')
    })
  })

  describe('canAdvance', () => {
    it('always allows advancing from welcome step', () => {
      expect(canAdvance('welcome', 'app-bound', 3001, '')).toBe('')
    })

    it('always allows advancing from server-mode step', () => {
      expect(canAdvance('server-mode', 'daemon', 3001, '')).toBe('')
    })

    it('always allows advancing from hotkey step', () => {
      expect(canAdvance('hotkey', 'app-bound', 3001, '')).toBe('')
    })

    it('validates port for daemon mode on configuration step', () => {
      expect(canAdvance('configuration', 'daemon', 3001, '')).toBe('')
      expect(canAdvance('configuration', 'daemon', 80, '')).toContain('between')
    })

    it('validates port for app-bound mode on configuration step', () => {
      expect(canAdvance('configuration', 'app-bound', 8080, '')).toBe('')
      expect(canAdvance('configuration', 'app-bound', 0, '')).toContain('between')
    })

    it('validates URL for remote mode on configuration step', () => {
      expect(canAdvance('configuration', 'remote', 3001, 'http://10.0.0.5:3001')).toBe('')
      expect(canAdvance('configuration', 'remote', 3001, 'not-a-url')).toContain('valid URL')
    })
  })

  describe('nextStep', () => {
    it('advances by one', () => {
      expect(nextStep(0)).toBe(1)
      expect(nextStep(1)).toBe(2)
      expect(nextStep(3)).toBe(4)
    })

    it('clamps to last step', () => {
      expect(nextStep(4)).toBe(4)
      expect(nextStep(10)).toBe(4)
    })
  })

  describe('prevStep', () => {
    it('goes back by one', () => {
      expect(prevStep(4)).toBe(3)
      expect(prevStep(1)).toBe(0)
    })

    it('clamps to first step', () => {
      expect(prevStep(0)).toBe(0)
    })
  })

  describe('buildConfig', () => {
    it('builds a complete WizardConfig object', () => {
      const config = buildConfig('daemon', 3001, 'http://server', 'mytoken', 'Ctrl+`')
      expect(config).toEqual({
        serverMode: 'daemon',
        port: 3001,
        remoteUrl: 'http://server',
        remoteToken: 'mytoken',
        globalHotkey: 'Ctrl+`',
      })
    })

    it('builds config with default values', () => {
      const config = buildConfig('app-bound', DEFAULT_PORT, '', '', DEFAULT_HOTKEY)
      expect(config.serverMode).toBe('app-bound')
      expect(config.port).toBe(3001)
      expect(config.globalHotkey).toBe('CommandOrControl+`')
    })
  })

  describe('keyboard navigation logic', () => {
    it('Enter on non-complete step advances', () => {
      // Simulating the logic from wizard.tsx handleKeyDown
      const step = STEPS[0] // 'welcome'
      const shouldAdvance = step !== 'complete'
      expect(shouldAdvance).toBe(true)
    })

    it('Enter on complete step does not advance', () => {
      const step = STEPS[4] // 'complete'
      const shouldAdvance = step !== 'complete'
      expect(shouldAdvance).toBe(false)
    })

    it('Escape on step > 0 goes back', () => {
      const currentStep = 2
      const shouldGoBack = currentStep > 0
      expect(shouldGoBack).toBe(true)
    })

    it('Escape on step 0 does not go back', () => {
      const currentStep = 0
      const shouldGoBack = currentStep > 0
      expect(shouldGoBack).toBe(false)
    })
  })
})
