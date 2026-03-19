import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent, act } from '@testing-library/react'
import {
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

import { api } from '@/lib/api'

installSettingsViewHooks({ fakeTimers: true, mockFonts: true })

describe('SettingsView terminal advanced settings', () => {
  it('is collapsed by default', () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)

    const advancedToggle = screen.getByRole('button', { name: 'OSC52 Clipboard' })
    const panel = document.getElementById(advancedToggle.getAttribute('aria-controls') ?? '')
    expect(advancedToggle).toHaveAttribute('aria-expanded', 'false')
    expect(panel).toHaveAttribute('hidden')
  })

  it('expands to show OSC52 clipboard policy control', () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)

    const advancedToggle = screen.getByRole('button', { name: 'OSC52 Clipboard' })
    fireEvent.click(advancedToggle)
    const panel = document.getElementById(advancedToggle.getAttribute('aria-controls') ?? '')

    expect(advancedToggle).toHaveAttribute('aria-expanded', 'true')
    expect(panel).not.toHaveAttribute('hidden')
    expect(screen.getByText('OSC52 clipboard access')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ask' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Always' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Never' })).toBeInTheDocument()
  })

  it('keeps Always and Never policy updates local-only', async () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)

    const advancedToggle = screen.getByRole('button', { name: 'OSC52 Clipboard' })
    fireEvent.click(advancedToggle)
    fireEvent.click(screen.getByRole('button', { name: 'Always' }))

    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    expect(api.patch).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Never' }))

    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    expect(api.patch).not.toHaveBeenCalled()
  })
})
