// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createPerfRouter } from '../../server/perf-router.js'

describe('Perf API', () => {
  let app: express.Express
  let mockPatchSettings: ReturnType<typeof vi.fn>
  let mockSetSettings: ReturnType<typeof vi.fn>
  let mockBroadcast: ReturnType<typeof vi.fn>
  let mockApplyDebugLogging: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockPatchSettings = vi.fn()
    mockSetSettings = vi.fn()
    mockBroadcast = vi.fn()
    mockApplyDebugLogging = vi.fn()

    app = express()
    app.use(express.json())
    app.use('/api/perf', createPerfRouter({
      configStore: { patchSettings: mockPatchSettings },
      registry: { setSettings: mockSetSettings },
      wsHandler: { broadcast: mockBroadcast },
      applyDebugLogging: mockApplyDebugLogging,
    }))
  })

  it('enables debug logging when enabled is true', async () => {
    mockPatchSettings.mockResolvedValue({ logging: { debug: true } })

    const res = await request(app)
      .post('/api/perf')
      .send({ enabled: true })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, enabled: true })
    expect(mockPatchSettings).toHaveBeenCalledWith({ logging: { debug: true } })
    expect(mockSetSettings).toHaveBeenCalled()
    expect(mockApplyDebugLogging).toHaveBeenCalledWith(true, 'api')
    expect(mockBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'settings.updated' }),
    )
  })

  it('disables debug logging when enabled is false', async () => {
    mockPatchSettings.mockResolvedValue({ logging: { debug: false } })

    const res = await request(app)
      .post('/api/perf')
      .send({ enabled: false })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, enabled: false })
    expect(mockPatchSettings).toHaveBeenCalledWith({ logging: { debug: false } })
    expect(mockApplyDebugLogging).toHaveBeenCalledWith(false, 'api')
  })

  it('treats missing enabled field as false', async () => {
    mockPatchSettings.mockResolvedValue({ logging: { debug: false } })

    const res = await request(app)
      .post('/api/perf')
      .send({})

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, enabled: false })
    expect(mockPatchSettings).toHaveBeenCalledWith({ logging: { debug: false } })
  })
})
