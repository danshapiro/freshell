// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LaunchChooser } from '../../../../electron/launch-chooser/chooser.js'
import type { LaunchServerCandidate } from '../../../../electron/types.js'

function localCandidate(overrides: Partial<LaunchServerCandidate> = {}): LaunchServerCandidate {
  return {
    id: 'local-3001',
    url: 'http://localhost:3001',
    origin: 'port-scan',
    ownership: 'detected-local',
    label: 'localhost:3001',
    requiresAuth: true,
    ...overrides,
  }
}

function installDesktopApi(options: {
  candidates: LaunchServerCandidate[]
  chooseLaunchOption?: ReturnType<typeof vi.fn>
}) {
  const chooseLaunchOption = options.chooseLaunchOption ?? vi.fn().mockResolvedValue(undefined)
  window.freshellDesktop = {
    getLaunchOptions: vi.fn().mockResolvedValue({
      candidates: options.candidates,
      reason: 'manual-choice',
      alwaysAskOnLaunch: false,
      port: 3001,
    }),
    chooseLaunchOption,
  }
  return { chooseLaunchOption }
}

afterEach(() => {
  cleanup()
  delete window.freshellDesktop
})

describe('LaunchChooser', () => {
  it('keeps the chooser open when a detected auth-required server has no token', async () => {
    const { chooseLaunchOption } = installDesktopApi({
      candidates: [localCandidate()],
    })

    render(<LaunchChooser />)

    fireEvent.click(await screen.findByRole('button', { name: 'Connect to localhost:3001' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Enter a token for localhost:3001')
    expect(chooseLaunchOption).not.toHaveBeenCalled()
  })

  it('connects to a detected auth-required server with the entered token', async () => {
    const { chooseLaunchOption } = installDesktopApi({
      candidates: [localCandidate()],
    })

    render(<LaunchChooser />)

    fireEvent.change(await screen.findByLabelText('Token for localhost:3001'), {
      target: { value: 'typed-token' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect to localhost:3001' }))

    await waitFor(() => expect(chooseLaunchOption).toHaveBeenCalledWith({
      kind: 'connect',
      url: 'http://localhost:3001',
      token: 'typed-token',
      requiresAuth: true,
      alwaysAskOnLaunch: false,
      remember: true,
    }))
  })

  it('keeps the chooser open when a manual remote server has no token', async () => {
    const { chooseLaunchOption } = installDesktopApi({
      candidates: [],
    })

    render(<LaunchChooser />)

    fireEvent.change(await screen.findByLabelText('URL'), {
      target: { value: 'http://10.0.0.5:3001' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect remote' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Enter a token for the remote server')
    expect(chooseLaunchOption).not.toHaveBeenCalled()
  })

  it('pre-fills the remote URL from the saved configuration', async () => {
    window.freshellDesktop = {
      getLaunchOptions: vi.fn().mockResolvedValue({
        candidates: [],
        reason: 'saved-remote-unreachable',
        alwaysAskOnLaunch: false,
        port: 3001,
        remoteUrl: 'http://10.0.0.5:3001',
      }),
      chooseLaunchOption: vi.fn().mockResolvedValue(undefined),
    }

    render(<LaunchChooser />)

    const urlInput = (await screen.findByLabelText('URL')) as HTMLInputElement
    await waitFor(() => expect(urlInput.value).toBe('http://10.0.0.5:3001'))
  })

  it('rejects an out-of-range local port before sending a choice', async () => {
    const { chooseLaunchOption } = installDesktopApi({ candidates: [] })

    render(<LaunchChooser />)

    const portInput = await screen.findByLabelText('Port')
    fireEvent.change(portInput, { target: { value: '80' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start local' }))

    expect((await screen.findByRole('alert')).textContent).toContain('between 1024 and 65535')
    expect(chooseLaunchOption).not.toHaveBeenCalled()
  })

  it('submits "Start local" and lets the main process decide, even when a candidate occupies that port', async () => {
    const chooseLaunchOption = vi.fn().mockResolvedValue({ ok: true })
    installDesktopApi({
      candidates: [localCandidate({ id: 'l', url: 'http://localhost:3001', label: 'localhost:3001' })],
      chooseLaunchOption,
    })

    render(<LaunchChooser />)

    // Wait for candidates to load; default port (3001) matches the detected server.
    await screen.findByRole('button', { name: 'Connect to localhost:3001' })
    fireEvent.click(screen.getByRole('button', { name: 'Start local' }))

    // The renderer no longer second-guesses occupancy from a stale snapshot;
    // it submits and the authoritative main-process check is the decider.
    await waitFor(() =>
      expect(chooseLaunchOption).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'start-local', port: 3001 }),
      ),
    )
  })
})
