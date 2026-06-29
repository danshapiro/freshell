import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElectronMainLogger } from '../../../electron/main-process-logger.js'

describe('main process logger', () => {
  let configDir: string

  beforeEach(async () => {
    configDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'electron-main-logger-'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fsp.rm(configDir, { recursive: true, force: true })
  })

  it('writes structured JSONL events under configDir/logs', () => {
    const logger = createElectronMainLogger({
      configDir,
      now: () => new Date('2026-06-28T20:58:50.000Z'),
      pid: 1234,
    })

    logger.log({
      severity: 'warn',
      event: 'main_window_renderer_gone',
      url: 'http://localhost:3001/?token=secret-token&tab=one',
      reason: 'crashed',
    })

    const files = fs.readdirSync(path.join(configDir, 'logs'))
    expect(files).toEqual(['electron-main.1234.jsonl'])
    const [line] = fs.readFileSync(path.join(configDir, 'logs', files[0]), 'utf8').trim().split('\n')
    expect(JSON.parse(line)).toEqual({
      timestamp: '2026-06-28T20:58:50.000Z',
      severity: 'warn',
      component: 'electron-main',
      event: 'main_window_renderer_gone',
      url: 'http://localhost:3001/?token=[REDACTED]&tab=one',
      reason: 'crashed',
    })
  })

  it('falls back to stderr when the log file cannot be written', () => {
    const error = new Error('EACCES for token=file-secret')
    const appendFileSync = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw error
    })
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})

    const logger = createElectronMainLogger({
      configDir,
      now: () => new Date('2026-06-28T20:58:50.000Z'),
      pid: 1234,
    })
    logger.log({
      severity: 'error',
      event: 'main_window_recovery_failed',
      url: 'http://localhost:3001/?token=query-secret',
      error,
    })

    expect(appendFileSync).toHaveBeenCalled()
    expect(stderr).toHaveBeenCalledTimes(1)
    const [line] = stderr.mock.calls[0]
    expect(JSON.parse(line)).toMatchObject({
      timestamp: '2026-06-28T20:58:50.000Z',
      severity: 'error',
      component: 'electron-main',
      event: 'main_window_recovery_failed',
      url: 'http://localhost:3001/?token=[REDACTED]',
      error: {
        name: 'Error',
        message: 'EACCES for token=[REDACTED]',
        stack: expect.stringContaining('EACCES for token=[REDACTED]'),
      },
    })
  })

  it('redacts token-bearing keys, URL token parameters, and token-like string fragments', () => {
    const logger = createElectronMainLogger({
      configDir,
      now: () => new Date('2026-06-28T20:58:50.000Z'),
      pid: 1234,
    })

    logger.log({
      severity: 'warn',
      event: 'token_redaction_probe',
      remoteToken: 'plain-secret',
      nested: {
        authToken: 'nested-secret',
        url: 'http://localhost:3001/?token=query-secret',
      },
      error: new Error('failed for token=message-secret'),
    })

    const line = fs.readFileSync(path.join(configDir, 'logs', 'electron-main.1234.jsonl'), 'utf8').trim()
    expect(line).not.toContain('plain-secret')
    expect(line).not.toContain('nested-secret')
    expect(line).not.toContain('query-secret')
    expect(line).not.toContain('message-secret')
    expect(JSON.parse(line)).toMatchObject({
      remoteToken: '[REDACTED]',
      nested: {
        authToken: '[REDACTED]',
        url: 'http://localhost:3001/?token=[REDACTED]',
      },
    })
  })
})
