import { describe, expect, it, vi } from 'vitest'
import { createChooseLaunchOptionHandler } from '../../../electron/launch-choice-handler.js'

describe('launch choice handler', () => {
  it('persists remote launch choice and restarts startup', async () => {
    const patchDesktopConfig = vi.fn().mockResolvedValue(undefined)
    const restartMain = vi.fn().mockResolvedValue(undefined)
    const handler = createChooseLaunchOptionHandler({
      patchDesktopConfig,
      restartMain,
      getCurrentPort: () => 3001,
    })

    await handler({}, {
      kind: 'remote',
      url: 'http://10.0.0.5:3001',
      token: 'vpn-token',
      requiresAuth: true,
      alwaysAskOnLaunch: true,
      remember: true,
    })

    expect(patchDesktopConfig).toHaveBeenCalledWith({
      serverMode: 'remote',
      remoteUrl: 'http://10.0.0.5:3001',
      remoteToken: 'vpn-token',
      alwaysAskOnLaunch: true,
      setupCompleted: true,
    })
    expect(restartMain).toHaveBeenCalled()
  })

  it('rejects auth-required server choices without a token before restart', async () => {
    const patchDesktopConfig = vi.fn().mockResolvedValue(undefined)
    const restartMain = vi.fn().mockResolvedValue(undefined)
    const validateServerAuth = vi.fn()
    const handler = createChooseLaunchOptionHandler({
      patchDesktopConfig,
      restartMain,
      getCurrentPort: () => 3001,
      validateServerAuth,
    })

    const result = await handler({}, {
      kind: 'connect',
      url: 'http://localhost:3001',
      requiresAuth: true,
      alwaysAskOnLaunch: false,
      remember: true,
    })

    expect(result).toEqual({
      ok: false,
      error: 'Enter a token for http://localhost:3001',
    })
    expect(validateServerAuth).not.toHaveBeenCalled()
    expect(patchDesktopConfig).not.toHaveBeenCalled()
    expect(restartMain).not.toHaveBeenCalled()
  })

  it('rejects server choices with invalid tokens before restart', async () => {
    const patchDesktopConfig = vi.fn().mockResolvedValue(undefined)
    const restartMain = vi.fn().mockResolvedValue(undefined)
    const validateServerAuth = vi.fn().mockResolvedValue(false)
    const handler = createChooseLaunchOptionHandler({
      patchDesktopConfig,
      restartMain,
      getCurrentPort: () => 3001,
      validateServerAuth,
    })

    const result = await handler({}, {
      kind: 'connect',
      url: 'http://localhost:3001',
      token: 'bad-token',
      requiresAuth: true,
      alwaysAskOnLaunch: false,
      remember: true,
    })

    expect(result).toEqual({
      ok: false,
      error: 'The server rejected that token.',
    })
    expect(validateServerAuth).toHaveBeenCalledWith('http://localhost:3001', 'bad-token')
    expect(patchDesktopConfig).not.toHaveBeenCalled()
    expect(restartMain).not.toHaveBeenCalled()
  })

  it('persists and restarts after validating an auth-required server choice', async () => {
    const patchDesktopConfig = vi.fn().mockResolvedValue(undefined)
    const restartMain = vi.fn().mockResolvedValue(undefined)
    const validateServerAuth = vi.fn().mockResolvedValue(true)
    const handler = createChooseLaunchOptionHandler({
      patchDesktopConfig,
      restartMain,
      getCurrentPort: () => 3001,
      validateServerAuth,
    })

    const result = await handler({}, {
      kind: 'connect',
      url: 'http://localhost:3001/',
      token: ' local-token ',
      requiresAuth: true,
      alwaysAskOnLaunch: false,
      remember: true,
    })

    expect(result).toEqual({ ok: true })
    expect(validateServerAuth).toHaveBeenCalledWith('http://localhost:3001', 'local-token')
    expect(patchDesktopConfig).toHaveBeenCalledWith({
      serverMode: 'remote',
      remoteUrl: 'http://localhost:3001',
      remoteToken: 'local-token',
      alwaysAskOnLaunch: false,
      setupCompleted: true,
    })
    expect(restartMain).toHaveBeenCalled()
  })

  it('persists start-local launch choice with selected port', async () => {
    const patchDesktopConfig = vi.fn().mockResolvedValue(undefined)
    const restartMain = vi.fn().mockResolvedValue(undefined)
    const handler = createChooseLaunchOptionHandler({
      patchDesktopConfig,
      restartMain,
      getCurrentPort: () => 3001,
    })

    await handler({}, {
      kind: 'start-local',
      port: 3003,
      alwaysAskOnLaunch: false,
      remember: true,
    })

    expect(patchDesktopConfig).toHaveBeenCalledWith({
      serverMode: 'app-bound',
      port: 3003,
      alwaysAskOnLaunch: false,
      setupCompleted: true,
    })
    expect(restartMain).toHaveBeenCalled()
  })

  it('forwards the chosen connection to restartMain so it is honored this launch', async () => {
    const patchDesktopConfig = vi.fn().mockResolvedValue(undefined)
    const restartMain = vi.fn().mockResolvedValue(undefined)
    const handler = createChooseLaunchOptionHandler({
      patchDesktopConfig,
      restartMain,
      getCurrentPort: () => 3001,
    })

    await handler({}, {
      kind: 'connect',
      url: 'http://localhost:3001',
      token: 'tok',
      requiresAuth: true,
      alwaysAskOnLaunch: true,
      remember: true,
    })

    expect(restartMain).toHaveBeenCalledWith({
      kind: 'connect',
      url: 'http://localhost:3001',
      token: 'tok',
    })
  })

  it('forwards the chosen local port to restartMain so it is honored this launch', async () => {
    const patchDesktopConfig = vi.fn().mockResolvedValue(undefined)
    const restartMain = vi.fn().mockResolvedValue(undefined)
    const handler = createChooseLaunchOptionHandler({
      patchDesktopConfig,
      restartMain,
      getCurrentPort: () => 3001,
    })

    await handler({}, {
      kind: 'start-local',
      port: 3009,
      alwaysAskOnLaunch: false,
      remember: true,
    })

    expect(restartMain).toHaveBeenCalledWith({ kind: 'start-local', port: 3009 })
  })

  it('does not persist the server selection when remember is false (connect)', async () => {
    const patchDesktopConfig = vi.fn().mockResolvedValue(undefined)
    const restartMain = vi.fn().mockResolvedValue(undefined)
    const validateServerAuth = vi.fn().mockResolvedValue(true)
    const handler = createChooseLaunchOptionHandler({
      patchDesktopConfig,
      restartMain,
      getCurrentPort: () => 3001,
      validateServerAuth,
    })

    const result = await handler({}, {
      kind: 'connect',
      url: 'http://localhost:3001',
      token: 'tok',
      requiresAuth: true,
      alwaysAskOnLaunch: false,
      remember: false,
    })

    expect(result).toEqual({ ok: true })
    // Only the standalone always-ask preference is persisted, not the server selection.
    expect(patchDesktopConfig).toHaveBeenCalledWith({ alwaysAskOnLaunch: false })
    expect(restartMain).toHaveBeenCalledWith({
      kind: 'connect',
      url: 'http://localhost:3001',
      token: 'tok',
    })
  })

  it('does not persist app-bound mode when remember is false (start-local)', async () => {
    const patchDesktopConfig = vi.fn().mockResolvedValue(undefined)
    const restartMain = vi.fn().mockResolvedValue(undefined)
    const handler = createChooseLaunchOptionHandler({
      patchDesktopConfig,
      restartMain,
      getCurrentPort: () => 3001,
    })

    const result = await handler({}, {
      kind: 'start-local',
      port: 3005,
      alwaysAskOnLaunch: true,
      remember: false,
    })

    expect(result).toEqual({ ok: true })
    expect(patchDesktopConfig).toHaveBeenCalledWith({ alwaysAskOnLaunch: true })
    expect(restartMain).toHaveBeenCalledWith({ kind: 'start-local', port: 3005 })
  })

  it('rejects an out-of-range start-local port before persisting or restarting', async () => {
    const patchDesktopConfig = vi.fn().mockResolvedValue(undefined)
    const restartMain = vi.fn().mockResolvedValue(undefined)
    const handler = createChooseLaunchOptionHandler({
      patchDesktopConfig,
      restartMain,
      getCurrentPort: () => 3001,
    })

    for (const port of [0, 80, 70000]) {
      const result = await handler({}, {
        kind: 'start-local',
        port,
        alwaysAskOnLaunch: false,
        remember: true,
      })
      expect(result.ok).toBe(false)
    }

    expect(patchDesktopConfig).not.toHaveBeenCalled()
    expect(restartMain).not.toHaveBeenCalled()
  })

  it('rejects a connect choice whose URL is not http(s), even when auth is skipped', async () => {
    const patchDesktopConfig = vi.fn().mockResolvedValue(undefined)
    const restartMain = vi.fn().mockResolvedValue(undefined)
    const handler = createChooseLaunchOptionHandler({
      patchDesktopConfig,
      restartMain,
      getCurrentPort: () => 3001,
    })

    const result = await handler({}, {
      kind: 'connect',
      url: 'file:///etc/passwd',
      requiresAuth: false,
      alwaysAskOnLaunch: false,
      remember: false,
    })

    expect(result.ok).toBe(false)
    expect(patchDesktopConfig).not.toHaveBeenCalled()
    expect(restartMain).not.toHaveBeenCalled()
  })

  it('rejects choices from a sender that is not the launch chooser window', async () => {
    const patchDesktopConfig = vi.fn().mockResolvedValue(undefined)
    const restartMain = vi.fn().mockResolvedValue(undefined)
    const handler = createChooseLaunchOptionHandler({
      patchDesktopConfig,
      restartMain,
      getCurrentPort: () => 3001,
      isAllowedSender: () => false,
    })

    const result = await handler({}, {
      kind: 'connect',
      url: 'http://localhost:3001',
      token: 'tok',
      requiresAuth: true,
      alwaysAskOnLaunch: false,
      remember: true,
    })

    expect(result.ok).toBe(false)
    expect(patchDesktopConfig).not.toHaveBeenCalled()
    expect(restartMain).not.toHaveBeenCalled()
  })
})
