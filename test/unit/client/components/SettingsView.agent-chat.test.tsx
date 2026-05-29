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

function getToggle(labelText: string) {
  const label = screen.getByText(labelText)
  let row: HTMLElement | null = label.parentElement
  while (row && !row.querySelector('[role="switch"]')) {
    row = row.parentElement
  }
  if (!row) throw new Error(`Row with label "${labelText}" not found`)
  return row.querySelector('[role="switch"]') as HTMLElement
}

describe('SettingsView fresh agent settings', () => {
  it('renders the Fresh agent section on the Workspace tab', () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Workspace')

    expect(screen.getByRole('heading', { name: 'Fresh agent' })).toBeInTheDocument()
    expect(screen.getByText('Display settings for fresh-agent panes')).toBeInTheDocument()
  })

  it('renders the enable switch, Show thinking, Show tools, and Show timecodes toggles', () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Workspace')

    expect(getToggle('Enable fresh clients (experimental)')).toBeInTheDocument()
    expect(getToggle('Show thinking')).toBeInTheDocument()
    expect(getToggle('Show tools')).toBeInTheDocument()
    expect(getToggle('Show timecodes & model')).toBeInTheDocument()
  })

  it('all agent chat toggles default to unchecked (off)', () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Workspace')

    expect(getToggle('Enable fresh clients (experimental)')).toHaveAttribute('aria-checked', 'false')
    expect(getToggle('Show thinking')).toHaveAttribute('aria-checked', 'false')
    expect(getToggle('Show tools')).toHaveAttribute('aria-checked', 'false')
    expect(getToggle('Show timecodes & model')).toHaveAttribute('aria-checked', 'false')
  })

  it('reflects current freshAgent settings when preloaded', () => {
    const store = createSettingsViewStore({
      settings: { freshAgent: { showThinking: true, showTools: true, showTimecodes: true } },
    })
    renderSettingsView(store)
    switchSettingsTab('Workspace')

    expect(getToggle('Show thinking')).toHaveAttribute('aria-checked', 'true')
    expect(getToggle('Show tools')).toHaveAttribute('aria-checked', 'true')
    expect(getToggle('Show timecodes & model')).toHaveAttribute('aria-checked', 'true')
  })

  it('toggling Enable fresh clients updates server-backed settings', async () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Workspace')

    fireEvent.click(getToggle('Enable fresh clients (experimental)'))

    expect(store.getState().settings.settings.freshAgent.enabled).toBe(true)
    expect(store.getState().settings.settings.agentChat.enabled).toBe(true)

    await act(async () => {
      await Promise.resolve()
    })

    expect(api.patch).toHaveBeenCalledWith('/api/settings', {
      freshAgent: { enabled: true },
      agentChat: { enabled: true },
    })
  })

  it('toggling Show thinking updates the store to true', () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Workspace')

    fireEvent.click(getToggle('Show thinking'))

    expect(store.getState().settings.settings.freshAgent.showThinking).toBe(true)
    expect(store.getState().settings.settings.agentChat.showThinking).toBe(true)
  })

  it('toggling Show tools updates the store to true', () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Workspace')

    fireEvent.click(getToggle('Show tools'))

    expect(store.getState().settings.settings.freshAgent.showTools).toBe(true)
    expect(store.getState().settings.settings.agentChat.showTools).toBe(true)
  })

  it('toggling Show timecodes updates the store to true', () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Workspace')

    fireEvent.click(getToggle('Show timecodes & model'))

    expect(store.getState().settings.settings.freshAgent.showTimecodes).toBe(true)
    expect(store.getState().settings.settings.agentChat.showTimecodes).toBe(true)
  })

  it('toggling off a previously-on setting sets it to false', () => {
    const store = createSettingsViewStore({
      settings: { freshAgent: { showThinking: true }, agentChat: { showThinking: true } },
    })
    renderSettingsView(store)
    switchSettingsTab('Workspace')

    fireEvent.click(getToggle('Show thinking'))

    expect(store.getState().settings.settings.freshAgent.showThinking).toBe(false)
    expect(store.getState().settings.settings.agentChat.showThinking).toBe(false)
  })

  it('fresh agent setting changes are local-only (no api.patch call)', async () => {
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
