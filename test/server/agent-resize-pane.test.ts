import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { LayoutStore } from '../../server/agent-api/layout-store'
import { createAgentApiRouter } from '../../server/agent-api/router'

type SplitNode = {
  type: 'split'
  id: string
  sizes: [number, number]
  children: [any, any]
}

function findSplitSizesById(node: any, splitId: string): [number, number] | undefined {
  if (!node) return undefined
  if (node.type === 'split') {
    const split = node as SplitNode
    if (split.id === splitId) return split.sizes
    return findSplitSizesById(split.children[0], splitId) ?? findSplitSizesById(split.children[1], splitId)
  }
  return undefined
}

function createApp(layoutStore: any) {
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore,
    registry: {} as any,
    wsHandler: { broadcastUiCommand: vi.fn() },
  }))
  return app
}

describe('agent resize-pane api', () => {
  it('normalizes missing axis to keep split totals at 100 when only y is provided', async () => {
    const layoutStore = new LayoutStore()
    const { tabId, paneId } = layoutStore.createTab({ title: 'Resize test', terminalId: 'term_1' })
    const splitResult = layoutStore.splitPane({ paneId, direction: 'horizontal', terminalId: 'term_2' })
    if (!('newPaneId' in splitResult)) throw new Error('expected split to succeed')
    const splitInfo = layoutStore.findSplitForPane(splitResult.newPaneId)
    if (!splitInfo?.splitId) throw new Error('expected parent split id')

    layoutStore.resizePane(tabId, splitInfo.splitId, [70, 30])
    const app = createApp(layoutStore)

    const res = await request(app)
      .post(`/api/panes/${splitResult.newPaneId}/resize`)
      .send({ y: 33 })

    expect(res.status).toBe(200)
    const snapshot = (layoutStore as any).snapshot
    const root = snapshot.layouts[tabId]
    expect(findSplitSizesById(root, splitInfo.splitId)).toEqual([67, 33])
  })

  it('derives missing axis from complement when existing sizes are unavailable', async () => {
    const resizePane = vi.fn(() => ({ tabId: 'tab_1' }))
    const layoutStore = {
      resizePane,
    }
    const app = createApp(layoutStore)

    const res = await request(app)
      .post('/api/panes/split_1/resize')
      .send({ y: 33 })

    expect(res.status).toBe(200)
    expect(resizePane).toHaveBeenCalledWith(undefined, 'split_1', [67, 33])
  })

  it('keeps explicit sizes[] path and normalizes tuple totals to 100', async () => {
    const resizePane = vi.fn(() => ({ tabId: 'tab_1' }))
    const layoutStore = {
      resizePane,
    }
    const app = createApp(layoutStore)

    const res = await request(app)
      .post('/api/panes/split_1/resize')
      .send({ sizes: [80, 30] })

    expect(res.status).toBe(200)
    expect(resizePane).toHaveBeenCalledWith(undefined, 'split_1', [73, 27])
  })

  it('returns 400 for non-numeric or out-of-range x/y/sizes values', async () => {
    const resizePane = vi.fn(() => ({ tabId: 'tab_1' }))
    const layoutStore = {
      resizePane,
    }
    const app = createApp(layoutStore)

    const payloads = [
      { x: 200 },
      { y: -5 },
      { sizes: ['bad', 30] },
      { sizes: [120, 20] },
    ]

    for (const payload of payloads) {
      const res = await request(app)
        .post('/api/panes/split_1/resize')
        .send(payload)
      expect(res.status).toBe(400)
      expect(res.body.status).toBe('error')
    }
  })
})
