import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent, act } from '@testing-library/react'
import {
  createSettingsViewStore,
  installSettingsViewHooks,
  renderSettingsView,
  switchSettingsTab,
} from './settings-view-test-utils'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  api: {
    patch: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}))

installSettingsViewHooks({ fakeTimers: true, mockFonts: true })

describe('SettingsView coding agents settings', () => {
  it('renders compact rows for CLI and Fresh coding agents', () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Coding Agents')

    expect(screen.getByRole('heading', { name: 'Coding Agents' })).toBeInTheDocument()
    for (const name of [
      'Claude CLI',
      'Freshclaude',
      'Codex CLI',
      'Freshcodex',
      'OpenCode',
      'Freshopencode',
      'Gemini',
      'Kimi',
    ]) {
      expect(screen.getByRole('switch', { name })).toBeInTheDocument()
    }
    expect(screen.queryByText('Show thinking')).not.toBeInTheDocument()
    expect(screen.queryByText('Show tools')).not.toBeInTheDocument()
    expect(screen.queryByText('Show timecodes & model')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Fresh agent font size')).not.toBeInTheDocument()
  })

  it('hides unavailable CLI agents and their Fresh variants', () => {
    const store = createSettingsViewStore({
      settings: {
        codingCli: { enabledProviders: ['claude', 'codex', 'opencode', 'gemini', 'kimi'] },
        freshAgent: { enabled: true },
      },
      extraPreloadedState: {
        connection: {
          status: 'ready',
          platform: 'linux',
          availableClis: {
            claude: true,
            codex: false,
            opencode: false,
            gemini: false,
            kimi: false,
          },
          featureFlags: {},
        },
      },
    })
    renderSettingsView(store)
    switchSettingsTab('Coding Agents')

    expect(screen.getByRole('switch', { name: 'Claude CLI' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Freshclaude' })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Codex CLI' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Freshcodex' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'OpenCode' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Freshopencode' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Gemini' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Kimi' })).not.toBeInTheDocument()
  })

  it('hides Fresh agent rows when the runtime CLI is disabled in settings', () => {
    const store = createSettingsViewStore({
      settings: {
        codingCli: { enabledProviders: ['claude'] },
        freshAgent: { enabled: true },
      },
      extraPreloadedState: {
        connection: {
          status: 'ready',
          platform: 'linux',
          availableClis: {
            claude: true,
            codex: true,
            opencode: true,
            gemini: true,
            kimi: true,
          },
          featureFlags: {},
        },
      },
    })
    renderSettingsView(store)
    switchSettingsTab('Coding Agents')

    expect(screen.getByRole('switch', { name: 'Claude CLI' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Freshclaude' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Codex CLI' })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Freshcodex' })).not.toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'OpenCode' })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Freshopencode' })).not.toBeInTheDocument()
  })

  it('toggles CLI agents through codingCli.enabledProviders', async () => {
    const store = createSettingsViewStore({
      settings: { codingCli: { enabledProviders: ['claude', 'codex'] } },
    })
    renderSettingsView(store)
    switchSettingsTab('Coding Agents')

    fireEvent.click(screen.getByRole('switch', { name: 'Codex CLI' }))

    expect(store.getState().settings.settings.codingCli.enabledProviders).toEqual(['claude'])
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.patch).toHaveBeenCalledWith('/api/settings', {
      codingCli: { enabledProviders: ['claude'] },
    })
  })

  it('renders stale extension-disabled CLI agents as off and clears the stale disablement when re-enabled', async () => {
    const store = createSettingsViewStore({
      settings: {
        codingCli: { enabledProviders: ['claude', 'codex'] },
        extensions: { disabled: ['codex', 'freshcodex'] },
      },
    })
    renderSettingsView(store)
    switchSettingsTab('Coding Agents')

    expect(screen.getByRole('switch', { name: 'Codex CLI' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('switch', { name: 'Codex CLI' }))

    expect(store.getState().settings.settings.codingCli.enabledProviders).toEqual(['claude', 'codex'])
    expect(store.getState().settings.settings.extensions.disabled).toEqual(['freshcodex'])
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.patch).toHaveBeenCalledWith('/api/settings', {
      codingCli: { enabledProviders: ['claude', 'codex'] },
      extensions: { disabled: ['freshcodex'] },
    })
  })

  it('toggles one Fresh agent independently through extensions.disabled', async () => {
    const store = createSettingsViewStore({
      settings: {
        freshAgent: { enabled: true },
        extensions: { disabled: ['freshcodex'] },
      },
    })
    renderSettingsView(store)
    switchSettingsTab('Coding Agents')

    expect(screen.getByRole('switch', { name: 'Freshcodex' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('switch', { name: 'Freshcodex' }))

    expect(store.getState().settings.settings.extensions.disabled).not.toContain('freshcodex')
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.patch).toHaveBeenCalledWith('/api/settings', {
      freshAgent: { enabled: true },
      extensions: { disabled: [] },
    })
  })

  it('turns on only the selected Fresh agent from the default all-off state', async () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Coding Agents')

    fireEvent.click(screen.getByRole('switch', { name: 'Freshcodex' }))

    expect(store.getState().settings.settings.freshAgent.enabled).toBe(true)
    expect(store.getState().settings.settings.extensions.disabled).toEqual(
      expect.arrayContaining(['freshclaude', 'freshopencode', 'kilroy']),
    )
    expect(store.getState().settings.settings.extensions.disabled).not.toContain('freshcodex')
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.patch).toHaveBeenCalledWith('/api/settings', {
      freshAgent: { enabled: true },
      extensions: { disabled: ['freshclaude', 'freshopencode', 'kilroy'] },
    })
  })

  it('turns off the global Fresh agent gate when disabling the last visible Fresh agent', async () => {
    const store = createSettingsViewStore({
      settings: {
        freshAgent: { enabled: true },
        extensions: { disabled: ['freshclaude', 'freshopencode'] },
      },
    })
    renderSettingsView(store)
    switchSettingsTab('Coding Agents')

    fireEvent.click(screen.getByRole('switch', { name: 'Freshcodex' }))

    expect(store.getState().settings.settings.freshAgent.enabled).toBe(false)
    expect('agentChat' in store.getState().settings.settings).toBe(false)
    expect(store.getState().settings.settings.extensions.disabled).toEqual(
      expect.arrayContaining(['freshclaude', 'freshcodex', 'freshopencode', 'kilroy']),
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.patch).toHaveBeenCalledWith('/api/settings', {
      freshAgent: { enabled: false },
      extensions: { disabled: ['freshclaude', 'freshopencode', 'freshcodex', 'kilroy'] },
    })
  })
})
