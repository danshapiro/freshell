import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import {
  createNetworkState,
  createNetworkStatus,
  createSettingsViewStore,
  installSettingsViewHooks,
  renderSettingsView,
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

installSettingsViewHooks({ mockFonts: true })

describe('SettingsView network access section', () => {
  it('renders remote access toggle', () => {
    const store = createSettingsViewStore()
    renderSettingsView(store, { onNavigate: vi.fn() })

    expect(screen.getByText(/remote access/i)).toBeInTheDocument()
  })

  it('shows firewall Fix button for WSL2 even with empty commands', () => {
    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            firewall: { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: false },
          }),
        }),
      },
    })
    renderSettingsView(store, { onNavigate: vi.fn() })

    expect(screen.getByRole('button', { name: /fix firewall/i })).toBeInTheDocument()
  })

  it('shows dev-mode restart warning when devMode is true', () => {
    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            devMode: true,
            devPort: 5173,
            accessUrl: 'http://192.168.1.100:5173/?token=abc',
          }),
        }),
      },
    })
    renderSettingsView(store, { onNavigate: vi.fn() })

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(/dev mode/i)).toBeInTheDocument()
    expect(screen.getByText(/npm run dev/i)).toBeInTheDocument()
  })

  it('suppresses dev-mode warning on WSL2', () => {
    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            devMode: true,
            devPort: 5173,
            accessUrl: 'http://192.168.1.100:5173/?token=abc',
            firewall: { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: false },
          }),
        }),
      },
    })
    renderSettingsView(store, { onNavigate: vi.fn() })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('disables remote access toggle during rebind', () => {
    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus({
            rebinding: true,
          }),
        }),
      },
    })
    renderSettingsView(store, { onNavigate: vi.fn() })

    expect(screen.getByRole('switch', { name: /remote access/i })).toBeDisabled()
  })

  it('disables remote access toggle during configuring', () => {
    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus(),
          configuring: true,
        }),
      },
    })
    renderSettingsView(store, { onNavigate: vi.fn() })

    expect(screen.getByRole('switch', { name: /remote access/i })).toBeDisabled()
  })

  it('renders Get link button when access URL is present', () => {
    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus(),
        }),
      },
    })
    renderSettingsView(store, { onNavigate: vi.fn() })

    expect(screen.getByText('Get link')).toBeInTheDocument()
  })

  it('calls onSharePanel when Get link is clicked', () => {
    const onSharePanel = vi.fn()
    const store = createSettingsViewStore({
      extraPreloadedState: {
        network: createNetworkState({
          status: createNetworkStatus(),
        }),
      },
    })
    renderSettingsView(store, { onNavigate: vi.fn(), onSharePanel })

    fireEvent.click(screen.getByText('Get link'))
    expect(onSharePanel).toHaveBeenCalledOnce()
  })
})
