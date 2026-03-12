import { describe, expect, it } from 'vitest'
import { createSlowNetworkController } from '@test/helpers/visible-first/slow-network-controller'

describe('createSlowNetworkController', () => {
  it('holds and releases request lanes and websocket readiness independently', async () => {
    const controller = createSlowNetworkController()

    let criticalReleased = false
    let visibleReleased = false
    let backgroundReleased = false
    let wsReleased = false

    const critical = controller.waitForLane('critical', '/api/bootstrap').then(() => {
      criticalReleased = true
    })
    const visible = controller.waitForLane('visible', '/api/session-directory').then(() => {
      visibleReleased = true
    })
    const background = controller.waitForLane('background', '/api/version').then(() => {
      backgroundReleased = true
    })
    const wsReady = controller.waitForWsReady().then(() => {
      wsReleased = true
    })

    await controller.waitForPending('critical')
    await controller.waitForPending('visible')
    await controller.waitForPending('background')

    expect(criticalReleased).toBe(false)
    expect(visibleReleased).toBe(false)
    expect(backgroundReleased).toBe(false)
    expect(wsReleased).toBe(false)

    controller.releaseNext('visible')
    await visible
    expect(visibleReleased).toBe(true)
    expect(criticalReleased).toBe(false)
    expect(backgroundReleased).toBe(false)
    expect(wsReleased).toBe(false)

    controller.releaseNext('critical')
    await critical
    controller.releaseNext('background')
    await background
    controller.releaseWsReady()
    await wsReady

    expect(controller.getRequestLog().map((entry) => entry.lane)).toEqual([
      'critical',
      'visible',
      'background',
    ])
    expect(wsReleased).toBe(true)
  })
})
