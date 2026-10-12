import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { waitForCloudExecutionDispatch } from '../../../../scripts/testing/cloud-execution-dispatch.js'

describe('managed Cloud execution dispatch barrier', () => {
  it('does not start acceptance until the exact Cloud Run execution is accepted', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-cloud-dispatch-'))
    const receiptPath = path.join(directory, 'dispatch.json')
    let acceptanceStarted = false
    try {
      const acceptance = waitForCloudExecutionDispatch(receiptPath, () => true, 2_000, 5).then(receipt => {
        acceptanceStarted = true
        return receipt
      })

      await new Promise(resolve => setTimeout(resolve, 30))
      expect(acceptanceStarted).toBe(false)

      await fs.writeFile(receiptPath, JSON.stringify({ jobName: 'freshell-e2e-candidate-abc123',
        executionName: 'candidate-exec-123', acceptedAt: '2026-10-12T00:00:00Z' }))
      await expect(acceptance).resolves.toEqual({ jobName: 'freshell-e2e-candidate-abc123',
        executionName: 'candidate-exec-123', acceptedAt: '2026-10-12T00:00:00Z' })
      expect(acceptanceStarted).toBe(true)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('uses a published dispatch receipt even if the browser process has already exited', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-cloud-dispatch-'))
    const receiptPath = path.join(directory, 'dispatch.json')
    const receipt = { jobName: 'freshell-e2e-candidate-abc123', executionName: 'candidate-exec-123',
      acceptedAt: '2026-10-12T00:00:00Z' }
    try {
      await fs.writeFile(receiptPath, JSON.stringify(receipt))
      await expect(waitForCloudExecutionDispatch(receiptPath, () => false, 2_000, 5)).resolves.toEqual(receipt)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
