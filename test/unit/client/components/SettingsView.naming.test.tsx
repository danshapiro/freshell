import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'
import {
  createSettingsViewStore,
  installSettingsViewHooks,
  renderSettingsView,
  switchSettingsTab,
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

installSettingsViewHooks({ fakeTimers: true, mockFonts: true })

describe('SettingsView naming settings', () => {
  it('renders naming controls without the old AI heading', () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Naming')

    expect(screen.getByRole('heading', { name: 'Naming' })).toBeInTheDocument()
    expect(screen.getByText('Gemini API key')).toBeInTheDocument()
    expect(screen.getByText('Auto-generate session titles')).toBeInTheDocument()
    expect(screen.getByText('Naming prompt')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'AI' })).not.toBeInTheDocument()
  })

  it('debounces Gemini API key saves', async () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Naming')

    fireEvent.change(screen.getByPlaceholderText('Enter Gemini API key'), {
      target: { value: 'gemini-key' },
    })

    expect(store.getState().settings.settings.ai.geminiApiKey).toBe('gemini-key')
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(api.patch).toHaveBeenCalledWith('/api/settings', {
      ai: { geminiApiKey: 'gemini-key' },
    })
  })

  it('toggles automatic session titles through server settings', async () => {
    const store = createSettingsViewStore({
      settings: { sidebar: { autoGenerateTitles: true } },
    })
    renderSettingsView(store)
    switchSettingsTab('Naming')

    fireEvent.click(screen.getByRole('switch', { name: 'Auto-generate session titles' }))

    expect(store.getState().settings.settings.sidebar.autoGenerateTitles).toBe(false)
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.patch).toHaveBeenCalledWith('/api/settings', {
      sidebar: { autoGenerateTitles: false },
    })
  })

  it('debounces naming prompt saves', async () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Naming')

    fireEvent.change(screen.getByPlaceholderText(/Generate a short title/), {
      target: { value: 'Name this session tersely.' },
    })

    expect(store.getState().settings.settings.ai.titlePrompt).toBe('Name this session tersely.')
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(api.patch).toHaveBeenCalledWith('/api/settings', {
      ai: { titlePrompt: 'Name this session tersely.' },
    })
  })
})
