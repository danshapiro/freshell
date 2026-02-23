import { afterEach, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAgentApiRouter } from '../../server/agent-api/router'

const createdPaths = new Set<string>()

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    [...createdPaths].map(async (targetPath) => {
      await fs.rm(targetPath, { force: true })
    }),
  )
  createdPaths.clear()
})

it('writes screenshot to temp dir by default and returns metadata JSON', async () => {
  const app = express()
  app.use(express.json())

  const wsHandler = {
    requestUiScreenshot: vi.fn().mockResolvedValue({
      ok: true,
      mimeType: 'image/png',
      imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2M7nQAAAAASUVORK5CYII=',
      width: 1,
      height: 1,
      changedFocus: false,
      restoredFocus: true,
    }),
  }

  app.use('/api', createAgentApiRouter({ layoutStore: {} as any, registry: {} as any, wsHandler: wsHandler as any }))

  const expectedPath = path.join(os.tmpdir(), 'api-view-smoke.png')
  await fs.rm(expectedPath, { force: true })
  createdPaths.add(expectedPath)

  const res = await request(app)
    .post('/api/screenshots')
    .send({ scope: 'view', name: 'api-view-smoke' })

  expect(res.status).toBe(200)
  expect(res.body.status).toBe('ok')
  expect(res.body.data.path).toBe(expectedPath)
  await expect(fs.stat(res.body.data.path)).resolves.toBeTruthy()
})

it('returns 409 when output file exists and overwrite is not set', async () => {
  const app = express()
  app.use(express.json())

  const wsHandler = {
    requestUiScreenshot: vi.fn().mockResolvedValue({
      ok: true,
      mimeType: 'image/png',
      imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2M7nQAAAAASUVORK5CYII=',
      width: 1,
      height: 1,
    }),
  }

  app.use('/api', createAgentApiRouter({ layoutStore: {} as any, registry: {} as any, wsHandler: wsHandler as any }))

  const conflictPath = path.join(os.tmpdir(), `api-shot-conflict-${Date.now()}.png`)
  await fs.writeFile(conflictPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  createdPaths.add(conflictPath)

  const res = await request(app)
    .post('/api/screenshots')
    .send({ scope: 'view', name: 'ignored', path: conflictPath })

  expect(res.status).toBe(409)
  expect(res.body.status).toBe('error')
  expect(res.body.message).toContain('already exists')
})

it('returns 400 when name is missing', async () => {
  const app = express()
  app.use(express.json())

  const wsHandler = {
    requestUiScreenshot: vi.fn(),
  }

  app.use('/api', createAgentApiRouter({ layoutStore: {} as any, registry: {} as any, wsHandler: wsHandler as any }))

  const res = await request(app)
    .post('/api/screenshots')
    .send({ scope: 'view' })

  expect(res.status).toBe(400)
  expect(res.body.status).toBe('error')
})

it('returns 400 when scope is pane and paneId is missing', async () => {
  const app = express()
  app.use(express.json())

  const wsHandler = {
    requestUiScreenshot: vi.fn(),
  }

  app.use('/api', createAgentApiRouter({ layoutStore: {} as any, registry: {} as any, wsHandler: wsHandler as any }))

  const res = await request(app)
    .post('/api/screenshots')
    .send({ scope: 'pane', name: 'pane-shot' })

  expect(res.status).toBe(400)
  expect(res.body.status).toBe('error')
  expect(res.body.message).toContain('paneId')
})

it('cleans up temporary files when atomic rename fails', async () => {
  const app = express()
  app.use(express.json())

  const wsHandler = {
    requestUiScreenshot: vi.fn().mockResolvedValue({
      ok: true,
      mimeType: 'image/png',
      imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2M7nQAAAAASUVORK5CYII=',
      width: 1,
      height: 1,
    }),
  }

  app.use('/api', createAgentApiRouter({ layoutStore: {} as any, registry: {} as any, wsHandler: wsHandler as any }))

  const outputPath = path.join(os.tmpdir(), `api-shot-rename-fail-${Date.now()}.png`)
  createdPaths.add(outputPath)

  vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed'))

  const res = await request(app)
    .post('/api/screenshots')
    .send({ scope: 'view', name: 'ignored', path: outputPath, overwrite: true })

  expect(res.status).toBe(500)
  const dirEntries = await fs.readdir(path.dirname(outputPath))
  const tmpPrefix = `${path.basename(outputPath)}.tmp-`
  expect(dirEntries.some((entry) => entry.startsWith(tmpPrefix))).toBe(false)
})

it('returns 503 when screenshot-capable UI client is unavailable', async () => {
  const app = express()
  app.use(express.json())

  const error = Object.assign(new Error('No screenshot-capable UI client connected'), {
    code: 'NO_SCREENSHOT_CLIENT',
  })
  const wsHandler = {
    requestUiScreenshot: vi.fn().mockRejectedValue(error),
  }

  app.use('/api', createAgentApiRouter({ layoutStore: {} as any, registry: {} as any, wsHandler: wsHandler as any }))

  const res = await request(app)
    .post('/api/screenshots')
    .send({ scope: 'view', name: 'needs-ui' })

  expect(res.status).toBe(503)
  expect(res.body.status).toBe('error')
  expect(res.body.message).toContain('screenshot-capable')
})

it('returns 504 when UI screenshot request times out', async () => {
  const app = express()
  app.use(express.json())

  const error = Object.assign(new Error('Timed out waiting for UI screenshot response'), {
    code: 'SCREENSHOT_TIMEOUT',
  })
  const wsHandler = {
    requestUiScreenshot: vi.fn().mockRejectedValue(error),
  }

  app.use('/api', createAgentApiRouter({ layoutStore: {} as any, registry: {} as any, wsHandler: wsHandler as any }))

  const res = await request(app)
    .post('/api/screenshots')
    .send({ scope: 'view', name: 'timed-out' })

  expect(res.status).toBe(504)
  expect(res.body.status).toBe('error')
  expect(res.body.message).toContain('Timed out waiting for UI screenshot response')
})
