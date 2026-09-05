// test/unit/electron/profile-picker/picker.test.tsx
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProfilePicker } from '../../../../electron/profile-picker/picker.js'

function installDesktopApi(options: { chooseProfile?: ReturnType<typeof vi.fn> } = {}) {
  const chooseProfile = options.chooseProfile ?? vi.fn().mockResolvedValue({ ok: true })
  window.freshellDesktop = {
    getProfiles: vi.fn().mockResolvedValue([
      { id: 'default', label: 'Default' },
      { id: 'work', label: 'Work' },
    ]),
    chooseProfile,
  }
  return { chooseProfile }
}

afterEach(() => {
  cleanup()
  delete (window as { freshellDesktop?: unknown }).freshellDesktop
})

describe('ProfilePicker', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders an accessible button per profile once loaded', async () => {
    installDesktopApi()
    render(<ProfilePicker />)
    expect(await screen.findByRole('button', { name: 'Default' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Work' })).toBeTruthy()
  })

  it('chooses a profile on click', async () => {
    const { chooseProfile } = installDesktopApi()
    render(<ProfilePicker />)
    fireEvent.click(await screen.findByRole('button', { name: 'Work' }))
    await waitFor(() => expect(chooseProfile).toHaveBeenCalledWith('work'))
  })

  it('surfaces a rejected choice via role="alert"', async () => {
    const chooseProfile = vi.fn().mockResolvedValue({ ok: false, error: 'Unknown profile.' })
    installDesktopApi({ chooseProfile })
    render(<ProfilePicker />)
    fireEvent.click(await screen.findByRole('button', { name: 'Work' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('surfaces a rejected getProfiles() promise via role="alert" instead of a blank window', async () => {
    window.freshellDesktop = {
      getProfiles: vi.fn().mockRejectedValue(new Error('ipc blew up')),
      chooseProfile: vi.fn(),
    }
    render(<ProfilePicker />)
    expect((await screen.findByRole('alert')).textContent).toContain('ipc blew up')
  })

  it('surfaces a rejected chooseProfile() promise via role="alert"', async () => {
    const chooseProfile = vi.fn().mockRejectedValue(new Error('channel closed'))
    installDesktopApi({ chooseProfile })
    render(<ProfilePicker />)
    fireEvent.click(await screen.findByRole('button', { name: 'Work' }))
    expect((await screen.findByRole('alert')).textContent).toContain('channel closed')
  })
})
