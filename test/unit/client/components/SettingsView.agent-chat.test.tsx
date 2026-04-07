import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent, act } from '@testing-library/react'
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

installSettingsViewHooks({ fakeTimers: true, mockFonts: true })

function getToggle(labelText: string) {
  const label = screen.getByText(labelText)
  const row = label.closest('div[class*="flex"]')
  if (!row) throw new Error(`Row with label "${labelText}" not found`)
  return row.querySelector('[role="switch"]') as HTMLElement
}

describe('SettingsView agent chat settings', () => {
  it('renders the Agent chat section on the Workspace tab', () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Workspace')

    expect(screen.getByRole('heading', { name: 'Agent chat' })).toBeInTheDocument()
    expect(screen.getByText('Display settings for agent chat panes')).toBeInTheDocument()
  })

  it('renders Show thinking, Show tools, and Show timecodes toggles', () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Workspace')

    expect(getToggle('Show thinking')).toBeInTheDocument()
    expect(getToggle('Show tools')).toBeInTheDocument()
    expect(getToggle('Show timecodes & model')).toBeInTheDocument()
  })

  it('all agent chat toggles default to unchecked (off)', () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Workspace')

    expect(getToggle('Show thinking')).toHaveAttribute('aria-checked', 'false')
    expect(getToggle('Show tools')).toHaveAttribute('aria-checked', 'false')
    expect(getToggle('Show timecodes & model')).toHaveAttribute('aria-checked', 'false')
  })

  it('reflects current agentChat settings when preloaded', () => {
    const store = createSettingsViewStore({
      settings: { agentChat: { showThinking: true, showTools: true, showTimecodes: true } },
    })
    renderSettingsView(store)
    switchSettingsTab('Workspace')

    expect(getToggle('Show thinking')).toHaveAttribute('aria-checked', 'true')
    expect(getToggle('Show tools')).toHaveAttribute('aria-checked', 'true')
    expect(getToggle('Show timecodes & model')).toHaveAttribute('aria-checked', 'true')
  })

  it('toggling Show thinking updates the store to true', () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Workspace')

    fireEvent.click(getToggle('Show thinking'))

    expect(store.getState().settings.settings.agentChat.showThinking).toBe(true)
  })

  it('toggling Show tools updates the store to true', () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Workspace')

    fireEvent.click(getToggle('Show tools'))

    expect(store.getState().settings.settings.agentChat.showTools).toBe(true)
  })

  it('toggling Show timecodes updates the store to true', () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Workspace')

    fireEvent.click(getToggle('Show timecodes & model'))

    expect(store.getState().settings.settings.agentChat.showTimecodes).toBe(true)
  })

  it('toggling off a previously-on setting sets it to false', () => {
    const store = createSettingsViewStore({
      settings: { agentChat: { showThinking: true } },
    })
    renderSettingsView(store)
    switchSettingsTab('Workspace')

    fireEvent.click(getToggle('Show thinking'))

    expect(store.getState().settings.settings.agentChat.showThinking).toBe(false)
  })

  it('agent chat setting changes are local-only (no api.patch call)', async () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Workspace')

    fireEvent.click(getToggle('Show thinking'))
    fireEvent.click(getToggle('Show tools'))
    fireEvent.click(getToggle('Show timecodes & model'))

    await act(async () => {
      vi.advanceTimersByTime(600)
    })

    const { api } = await import('@/lib/api')
    expect(api.patch).not.toHaveBeenCalled()
  })
})
