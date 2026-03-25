// Tests for the ExtensionsView component with expandable config cards.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, fireEvent, act, within } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import ExtensionsView from '@/components/ExtensionsView'
import settingsReducer from '@/store/settingsSlice'
import extensionsReducer from '@/store/extensionsSlice'
import { networkReducer } from '@/store/networkSlice'
import tabRegistryReducer from '@/store/tabRegistrySlice'
import tabsReducer from '@/store/tabsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import { serverSettingsSaveStateMiddleware } from '@/store/settingsThunks'
import type { ClientExtensionEntry } from '@shared/extension-types'
import {
  createSettingsViewStore,
} from './settings-view-test-utils'

vi.mock('@/lib/api', () => ({
  api: {
    patch: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}))

import { api } from '@/lib/api'

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const claudeExt: ClientExtensionEntry = {
  name: 'claude',
  version: '1.0.0',
  label: 'Claude CLI',
  description: 'Claude Code agent',
  category: 'cli',
  cli: {
    supportsPermissionMode: true,
    supportsResume: true,
    resumeCommandTemplate: ['claude', '--resume', '{{sessionId}}'],
  },
}

const codexExt: ClientExtensionEntry = {
  name: 'codex',
  version: '1.0.0',
  label: 'Codex CLI',
  description: 'OpenAI Codex agent',
  category: 'cli',
  cli: {
    supportsModel: true,
    supportsSandbox: true,
    supportsResume: true,
    resumeCommandTemplate: ['codex', 'resume', '{{sessionId}}'],
  },
}

const serverExt: ClientExtensionEntry = {
  name: 'my-server',
  version: '2.0.0',
  label: 'My Server',
  description: 'A server extension',
  category: 'server',
  serverRunning: true,
  serverPort: 8080,
}

function renderExtensionsView(options: {
  extensions?: ClientExtensionEntry[]
  settings?: Record<string, unknown>
} = {}) {
  const { extensions = [claudeExt, codexExt], settings = {} } = options
  const store = createSettingsViewStore({
    settings: settings as any,
    extraPreloadedState: {
      extensions: { entries: extensions },
    },
  })
  const onNavigate = vi.fn()
  render(
    <Provider store={store}>
      <ExtensionsView onNavigate={onNavigate} />
    </Provider>,
  )
  return { store, onNavigate }
}

describe('ExtensionsView', () => {
  describe('card rendering', () => {
    it('renders extension cards for all entries', () => {
      renderExtensionsView()

      expect(screen.getByText('Claude CLI')).toBeInTheDocument()
      expect(screen.getByText('Codex CLI')).toBeInTheDocument()
    })

    it('shows CLI Agents group heading', () => {
      renderExtensionsView()

      expect(screen.getByText('CLI Agents')).toBeInTheDocument()
    })

    it('shows "Running" badge for running server extensions', () => {
      renderExtensionsView({ extensions: [serverExt] })

      expect(screen.getByText('Running')).toBeInTheDocument()
    })

    it('navigates back to settings', () => {
      const { onNavigate } = renderExtensionsView()

      fireEvent.click(screen.getByLabelText('Back to settings'))
      expect(onNavigate).toHaveBeenCalledWith('settings')
    })
  })

  describe('expand/collapse', () => {
    it('shows configure button for cards with config', () => {
      renderExtensionsView()

      expect(screen.getByLabelText('Show Claude CLI configuration')).toBeInTheDocument()
    })

    it('shows config fields when Configure is clicked', () => {
      renderExtensionsView()

      const expandBtn = screen.getByLabelText('Show Claude CLI configuration')
      fireEvent.click(expandBtn)

      expect(screen.getByText('Claude CLI permission mode')).toBeInTheDocument()
      expect(screen.getByText('Claude CLI starting directory')).toBeInTheDocument()
    })

    it('collapses expanded card', () => {
      renderExtensionsView()

      const expandBtn = screen.getByLabelText('Show Claude CLI configuration')
      fireEvent.click(expandBtn)
      expect(screen.getByText('Claude CLI permission mode')).toBeInTheDocument()

      fireEvent.click(screen.getByLabelText('Hide Claude CLI configuration'))
      expect(screen.queryByText('Claude CLI permission mode')).not.toBeInTheDocument()
    })
  })

  describe('CLI provider toggle', () => {
    it('toggles CLI provider enabled state', async () => {
      const { store } = renderExtensionsView()

      const toggle = screen.getByLabelText('Disable Codex CLI')
      fireEvent.click(toggle)

      await act(async () => { await Promise.resolve() })

      expect(api.patch).toHaveBeenCalled()
      const patchCall = (api.patch as any).mock.calls[0]
      expect(patchCall[0]).toBe('/api/settings')
      const sent = patchCall[1].codingCli.enabledProviders as string[]
      expect(sent).not.toContain('codex')
      expect(sent).toContain('claude')
    })

    it('enables a disabled CLI provider', async () => {
      renderExtensionsView({
        settings: { codingCli: { enabledProviders: ['claude'] } },
      })

      const toggle = screen.getByLabelText('Enable Codex CLI')
      fireEvent.click(toggle)

      await act(async () => { await Promise.resolve() })

      expect(api.patch).toHaveBeenCalled()
      const patchCall = (api.patch as any).mock.calls[0]
      const sent = patchCall[1].codingCli.enabledProviders as string[]
      expect(sent).toContain('codex')
      expect(sent).toContain('claude')
    })
  })

  describe('CLI config fields', () => {
    it('updates permission mode', async () => {
      renderExtensionsView()

      // Expand Claude card
      fireEvent.click(screen.getByLabelText('Show Claude CLI configuration'))

      const select = screen.getByLabelText('Claude CLI permission mode')
      fireEvent.change(select, { target: { value: 'plan' } })

      await act(async () => { await Promise.resolve() })

      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        codingCli: { providers: { claude: { permissionMode: 'plan' } } },
      })
    })

    it('debounces model text saves', async () => {
      renderExtensionsView()

      // Expand Codex card
      fireEvent.click(screen.getByLabelText('Show Codex CLI configuration'))

      const input = screen.getByLabelText('Codex CLI model')
      fireEvent.change(input, { target: { value: 'gpt-5-codex' } })

      expect(api.patch).not.toHaveBeenCalled()

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        codingCli: { providers: { codex: { model: 'gpt-5-codex' } } },
      })
    })

    it('updates sandbox select', async () => {
      renderExtensionsView()

      // Expand Codex card
      fireEvent.click(screen.getByLabelText('Show Codex CLI configuration'))

      const select = screen.getByLabelText('Codex CLI sandbox')
      fireEvent.change(select, { target: { value: 'workspace-write' } })

      await act(async () => { await Promise.resolve() })

      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        codingCli: { providers: { codex: { sandbox: 'workspace-write' } } },
      })
    })
  })

  describe('non-CLI extension toggle', () => {
    it('disables a non-CLI extension via disabled list', async () => {
      renderExtensionsView({ extensions: [serverExt] })

      const toggle = screen.getByLabelText('Disable My Server')
      fireEvent.click(toggle)

      await act(async () => { await Promise.resolve() })

      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        extensions: { disabled: ['my-server'] },
      })
    })
  })

  describe('empty state', () => {
    it('shows empty state when no extensions', () => {
      renderExtensionsView({ extensions: [] })

      expect(screen.getByText('No extensions installed')).toBeInTheDocument()
    })
  })
})
