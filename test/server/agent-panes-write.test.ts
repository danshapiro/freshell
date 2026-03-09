import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAgentApiRouter } from '../../server/agent-api/router'

it('splits a pane horizontally', async () => {
  const app = express()
  app.use(express.json())
  const splitPane = vi.fn(() => ({ newPaneId: 'pane_new', tabId: 'tab_1' }))
  const attachPaneContent = vi.fn()
  const registryCreate = vi.fn(() => ({ terminalId: 'term_new' }))
  app.use('/api', createAgentApiRouter({
    layoutStore: { splitPane, attachPaneContent },
    registry: { create: registryCreate },
    wsHandler: { broadcastUiCommand: () => {} },
  }))

  const res = await request(app).post('/api/panes/pane_1/split').send({ direction: 'horizontal' })
  expect(res.body.status).toBe('ok')
  expect(res.body.data.paneId).toBe('pane_new')
  expect(registryCreate).toHaveBeenCalled()
  expect(registryCreate).toHaveBeenCalledWith(expect.objectContaining({
    envContext: { tabId: 'tab_1', paneId: 'pane_new' },
  }))
  expect(attachPaneContent).toHaveBeenCalled()
})

it('resolves tmux-style pane targets for close', async () => {
  const app = express()
  app.use(express.json())
  const closePane = vi.fn(() => ({ tabId: 'tab_1' }))
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      closePane,
      resolveTarget: () => ({ tabId: 'tab_1', paneId: 'pane_resolved' }),
    },
    registry: {},
    wsHandler: { broadcastUiCommand: () => {} },
  }))

  const res = await request(app).post('/api/panes/1.0/close').send({})
  expect(res.body.status).toBe('ok')
  expect(closePane).toHaveBeenCalledWith('pane_resolved')
})

it('rejects ambiguous pane title targets before mutating pane routes', async () => {
  const app = express()
  app.use(express.json())
  const closePane = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      closePane,
      resolveTarget: () => ({ message: 'pane target is ambiguous; use pane id or tab.pane index' }),
    },
    registry: {},
    wsHandler: { broadcastUiCommand: () => {} },
  }))

  const res = await request(app).post('/api/panes/Shell/close').send({})

  expect(res.status).toBe(409)
  expect(res.body.status).toBe('error')
  expect(res.body.message).toContain('ambiguous')
  expect(closePane).not.toHaveBeenCalled()
})

it('rejects ambiguous pane title targets for wait-for', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      resolveTarget: () => ({ message: 'pane target is ambiguous; use pane id or tab.pane index' }),
    },
    registry: {},
    wsHandler: { broadcastUiCommand: () => {} },
  }))

  const res = await request(app).get('/api/panes/Shell/wait-for')

  expect(res.status).toBe(409)
  expect(res.body.status).toBe('error')
  expect(res.body.message).toContain('ambiguous')
})

it('rejects blank pane rename payloads', async () => {
  const app = express()
  app.use(express.json())
  const renamePane = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: { renamePane },
    registry: {} as any,
    wsHandler: { broadcastUiCommand: vi.fn() },
  }))

  const res = await request(app).patch('/api/panes/pane_1').send({ name: '   ' })

  expect(res.status).toBe(400)
  expect(renamePane).not.toHaveBeenCalled()
})

it('preserves coding CLI mode across attach so a later rename-pane persists overrides', async () => {
  const app = express()
  app.use(express.json())
  let paneSnapshot: any = {
    tabId: 'tab_1',
    paneId: 'pane_1',
    paneContent: { kind: 'terminal', terminalId: 'term_1', mode: 'shell' },
  }
  const renamePane = vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' }))
  const attachPaneContent = vi.fn((_tabId: string, _paneId: string, content: any) => {
    paneSnapshot = { tabId: 'tab_1', paneId: 'pane_1', paneContent: content }
  })
  const patchTerminalOverride = vi.fn().mockResolvedValue({})
  const patchSessionOverride = vi.fn().mockResolvedValue({})
  const updateTitle = vi.fn()
  const refresh = vi.fn().mockResolvedValue(undefined)
  const broadcast = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      renamePane,
      attachPaneContent,
      resolveTarget: () => ({ tabId: 'tab_1', paneId: 'pane_1' }),
      listPanes: () => [{ id: 'pane_1' }, { id: 'pane_2' }],
      getPaneSnapshot: () => paneSnapshot,
    } as any,
    registry: {
      get: () => ({ mode: 'codex' }),
      updateTitle,
    } as any,
    wsHandler: { broadcastUiCommand: vi.fn(), broadcast },
    configStore: { patchTerminalOverride, patchSessionOverride } as any,
    terminalMetadata: {
      list: () => [{ terminalId: 'term_1', provider: 'codex', sessionId: 'session-1' }],
    } as any,
    codingCliIndexer: { refresh } as any,
  }))

  const attachRes = await request(app).post('/api/panes/pane_1/attach').send({ terminalId: 'term_1' })
  expect(attachRes.status).toBe(200)
  expect(attachPaneContent).toHaveBeenCalledWith('tab_1', 'pane_1', expect.objectContaining({
    mode: 'codex',
    terminalId: 'term_1',
  }))

  const renameRes = await request(app).patch('/api/panes/pane_1').send({ name: 'Attached agent' })

  expect(renameRes.status).toBe(200)
  expect(renamePane).toHaveBeenCalledWith('pane_1', 'Attached agent')
  expect(patchTerminalOverride).toHaveBeenCalledWith('term_1', { titleOverride: 'Attached agent' })
  expect(patchSessionOverride).toHaveBeenCalledWith('codex:session-1', { titleOverride: 'Attached agent' })
})

it('preserves attached shell metadata for non-system terminals', async () => {
  const app = express()
  app.use(express.json())
  const attachPaneContent = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      attachPaneContent,
      resolveTarget: () => ({ tabId: 'tab_1', paneId: 'pane_1' }),
    } as any,
    registry: {
      get: () => ({ mode: 'shell', shell: 'powershell' }),
    } as any,
    wsHandler: { broadcastUiCommand: vi.fn() },
  }))

  const res = await request(app).post('/api/panes/pane_1/attach').send({ terminalId: 'term_1' })

  expect(res.status).toBe(200)
  expect(attachPaneContent).toHaveBeenCalledWith('tab_1', 'pane_1', expect.objectContaining({
    terminalId: 'term_1',
    mode: 'shell',
    shell: 'powershell',
  }))
})

it('renames a resolved pane via PATCH /api/panes/:id', async () => {
  const app = express()
  app.use(express.json())
  const renamePane = vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_real' }))
  const broadcastUiCommand = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      renamePane,
      resolveTarget: () => ({ tabId: 'tab_1', paneId: 'pane_real' }),
    } as any,
    registry: {} as any,
    wsHandler: { broadcastUiCommand },
  }))

  const res = await request(app).patch('/api/panes/1.0').send({ name: '  Logs  ' })

  expect(res.status).toBe(200)
  expect(renamePane).toHaveBeenCalledWith('pane_real', 'Logs')
  expect(broadcastUiCommand).toHaveBeenCalledWith({
    command: 'pane.rename',
    payload: { tabId: 'tab_1', paneId: 'pane_real', title: 'Logs' },
  })
})

it('syncs the tab title when renaming the only pane in a tab', async () => {
  const app = express()
  app.use(express.json())
  const renamePane = vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' }))
  const renameTab = vi.fn(() => ({ tabId: 'tab_1' }))
  const broadcastUiCommand = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      renamePane,
      renameTab,
      listPanes: () => [{ id: 'pane_1' }],
      getPaneSnapshot: () => ({
        tabId: 'tab_1',
        paneId: 'pane_1',
        paneContent: { kind: 'terminal', mode: 'shell', terminalId: 'term_1' },
      }),
    } as any,
    registry: {} as any,
    wsHandler: { broadcastUiCommand },
  }))

  const res = await request(app).patch('/api/panes/pane_1').send({ name: 'Docs' })

  expect(res.status).toBe(200)
  expect(res.body.data).toMatchObject({ tabId: 'tab_1', paneId: 'pane_1', tabRenamed: true })
  expect(renamePane).toHaveBeenCalledWith('pane_1', 'Docs')
  expect(renameTab).toHaveBeenCalledWith('tab_1', 'Docs')
  expect(broadcastUiCommand).toHaveBeenCalledWith({
    command: 'pane.rename',
    payload: { tabId: 'tab_1', paneId: 'pane_1', title: 'Docs' },
  })
  expect(broadcastUiCommand).toHaveBeenCalledWith({
    command: 'tab.rename',
    payload: { id: 'tab_1', title: 'Docs' },
  })
})

it('reports when a pane rename does not also rename the tab', async () => {
  const app = express()
  app.use(express.json())
  const renamePane = vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' }))
  const renameTab = vi.fn()
  const broadcastUiCommand = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      renamePane,
      renameTab,
      listPanes: () => [{ id: 'pane_1' }, { id: 'pane_2' }],
      getPaneSnapshot: () => ({
        tabId: 'tab_1',
        paneId: 'pane_1',
        paneContent: { kind: 'terminal', mode: 'shell', terminalId: 'term_1' },
      }),
    } as any,
    registry: {} as any,
    wsHandler: { broadcastUiCommand },
  }))

  const res = await request(app).patch('/api/panes/pane_1').send({ name: 'Docs' })

  expect(res.status).toBe(200)
  expect(res.body.data).toMatchObject({ tabId: 'tab_1', paneId: 'pane_1', tabRenamed: false })
  expect(renamePane).toHaveBeenCalledWith('pane_1', 'Docs')
  expect(renameTab).not.toHaveBeenCalled()
  expect(broadcastUiCommand).toHaveBeenCalledWith({
    command: 'pane.rename',
    payload: { tabId: 'tab_1', paneId: 'pane_1', title: 'Docs' },
  })
  expect(broadcastUiCommand).not.toHaveBeenCalledWith({
    command: 'tab.rename',
    payload: { id: 'tab_1', title: 'Docs' },
  })
})

it('persists syncable coding CLI pane renames through terminal overrides and session overrides', async () => {
  const app = express()
  app.use(express.json())
  const renamePane = vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' }))
  const patchTerminalOverride = vi.fn().mockResolvedValue({})
  const patchSessionOverride = vi.fn().mockResolvedValue({})
  const updateTitle = vi.fn()
  const refresh = vi.fn().mockResolvedValue(undefined)
  const broadcast = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      renamePane,
      listPanes: () => [{ id: 'pane_1' }, { id: 'pane_2' }],
      getPaneSnapshot: () => ({
        tabId: 'tab_1',
        paneId: 'pane_1',
        paneContent: { kind: 'terminal', mode: 'codex', terminalId: 'term_1' },
      }),
    } as any,
    registry: { updateTitle } as any,
    wsHandler: { broadcastUiCommand: vi.fn(), broadcast },
    configStore: { patchTerminalOverride, patchSessionOverride } as any,
    terminalMetadata: {
      list: () => [{ terminalId: 'term_1', provider: 'codex', sessionId: 'session-1' }],
    } as any,
    codingCliIndexer: { refresh } as any,
  }))

  const res = await request(app).patch('/api/panes/pane_1').send({ name: 'Agent' })

  expect(res.status).toBe(200)
  expect(renamePane).toHaveBeenCalledWith('pane_1', 'Agent')
  expect(patchTerminalOverride).toHaveBeenCalledWith('term_1', { titleOverride: 'Agent' })
  expect(updateTitle).toHaveBeenCalledWith('term_1', 'Agent')
  expect(patchSessionOverride).toHaveBeenCalledWith('codex:session-1', { titleOverride: 'Agent' })
  expect(refresh).toHaveBeenCalledOnce()
  expect(broadcast).toHaveBeenCalledWith({ type: 'terminal.list.updated' })
})

it('falls back to pane resumeSessionId when terminal metadata is not ready yet', async () => {
  const app = express()
  app.use(express.json())
  const renamePane = vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' }))
  const patchTerminalOverride = vi.fn().mockResolvedValue({})
  const patchSessionOverride = vi.fn().mockResolvedValue({})
  const updateTitle = vi.fn()
  const refresh = vi.fn().mockResolvedValue(undefined)
  const broadcast = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      renamePane,
      listPanes: () => [{ id: 'pane_1' }, { id: 'pane_2' }],
      getPaneSnapshot: () => ({
        tabId: 'tab_1',
        paneId: 'pane_1',
        paneContent: {
          kind: 'terminal',
          mode: 'codex',
          terminalId: 'term_1',
          resumeSessionId: 'session-1',
        },
      }),
    } as any,
    registry: { updateTitle } as any,
    wsHandler: { broadcastUiCommand: vi.fn(), broadcast },
    configStore: { patchTerminalOverride, patchSessionOverride } as any,
    terminalMetadata: {
      list: () => [],
    } as any,
    codingCliIndexer: { refresh } as any,
  }))

  const res = await request(app).patch('/api/panes/pane_1').send({ name: 'Agent' })

  expect(res.status).toBe(200)
  expect(renamePane).toHaveBeenCalledWith('pane_1', 'Agent')
  expect(patchTerminalOverride).toHaveBeenCalledWith('term_1', { titleOverride: 'Agent' })
  expect(updateTitle).toHaveBeenCalledWith('term_1', 'Agent')
  expect(patchSessionOverride).toHaveBeenCalledWith('codex:session-1', { titleOverride: 'Agent' })
  expect(refresh).toHaveBeenCalledOnce()
  expect(broadcast).toHaveBeenCalledWith({ type: 'terminal.list.updated' })
})

it('falls back to terminal metadata when pane snapshot mode is stale during pane rename persistence', async () => {
  const app = express()
  app.use(express.json())
  const renamePane = vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' }))
  const patchTerminalOverride = vi.fn().mockResolvedValue({})
  const patchSessionOverride = vi.fn().mockResolvedValue({})
  const updateTitle = vi.fn()
  const refresh = vi.fn().mockResolvedValue(undefined)
  const broadcast = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      renamePane,
      getPaneSnapshot: () => ({
        tabId: 'tab_1',
        paneId: 'pane_1',
        paneContent: { kind: 'terminal', mode: 'shell', terminalId: 'term_1' },
      }),
    } as any,
    registry: { get: () => ({ mode: 'shell' }), updateTitle } as any,
    wsHandler: { broadcastUiCommand: vi.fn(), broadcast },
    configStore: { patchTerminalOverride, patchSessionOverride } as any,
    terminalMetadata: {
      list: () => [{ terminalId: 'term_1', provider: 'codex', sessionId: 'session-1' }],
    } as any,
    codingCliIndexer: { refresh } as any,
  }))

  const res = await request(app).patch('/api/panes/pane_1').send({ name: 'Recovered agent' })

  expect(res.status).toBe(200)
  expect(renamePane).toHaveBeenCalledWith('pane_1', 'Recovered agent')
  expect(patchTerminalOverride).toHaveBeenCalledWith('term_1', { titleOverride: 'Recovered agent' })
  expect(updateTitle).toHaveBeenCalledWith('term_1', 'Recovered agent')
  expect(patchSessionOverride).toHaveBeenCalledWith('codex:session-1', { titleOverride: 'Recovered agent' })
  expect(refresh).toHaveBeenCalledOnce()
  expect(broadcast).toHaveBeenCalledWith({ type: 'terminal.list.updated' })
})

it('falls back to registry mode when pane snapshot mode is stale during pane rename persistence', async () => {
  const app = express()
  app.use(express.json())
  const renamePane = vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' }))
  const patchTerminalOverride = vi.fn().mockResolvedValue({})
  const patchSessionOverride = vi.fn()
  const updateTitle = vi.fn()
  const broadcast = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      renamePane,
      getPaneSnapshot: () => ({
        tabId: 'tab_1',
        paneId: 'pane_1',
        paneContent: { kind: 'terminal', mode: 'shell', terminalId: 'term_1' },
      }),
    } as any,
    registry: { get: () => ({ mode: 'codex' }), updateTitle } as any,
    wsHandler: { broadcastUiCommand: vi.fn(), broadcast },
    configStore: { patchTerminalOverride, patchSessionOverride } as any,
    terminalMetadata: {
      list: () => [],
    } as any,
  }))

  const res = await request(app).patch('/api/panes/pane_1').send({ name: 'Recovered agent' })

  expect(res.status).toBe(200)
  expect(renamePane).toHaveBeenCalledWith('pane_1', 'Recovered agent')
  expect(patchTerminalOverride).toHaveBeenCalledWith('term_1', { titleOverride: 'Recovered agent' })
  expect(updateTitle).toHaveBeenCalledWith('term_1', 'Recovered agent')
  expect(patchSessionOverride).not.toHaveBeenCalled()
  expect(broadcast).toHaveBeenCalledWith({ type: 'terminal.list.updated' })
})

it('does not fail the pane rename when coding CLI session cascade refresh fails', async () => {
  const app = express()
  app.use(express.json())
  const renamePane = vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' }))
  const patchTerminalOverride = vi.fn().mockResolvedValue({})
  const patchSessionOverride = vi.fn().mockResolvedValue({})
  const updateTitle = vi.fn()
  const refresh = vi.fn().mockRejectedValue(new Error('refresh failed'))
  const broadcast = vi.fn()
  const broadcastUiCommand = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      renamePane,
      listPanes: () => [{ id: 'pane_1' }, { id: 'pane_2' }],
      getPaneSnapshot: () => ({
        tabId: 'tab_1',
        paneId: 'pane_1',
        paneContent: { kind: 'terminal', mode: 'codex', terminalId: 'term_1' },
      }),
    } as any,
    registry: { updateTitle } as any,
    wsHandler: { broadcastUiCommand, broadcast },
    configStore: { patchTerminalOverride, patchSessionOverride } as any,
    terminalMetadata: {
      list: () => [{ terminalId: 'term_1', provider: 'codex', sessionId: 'session-1' }],
    } as any,
    codingCliIndexer: { refresh } as any,
  }))

  const res = await request(app).patch('/api/panes/pane_1').send({ name: 'Agent' })

  expect(res.status).toBe(200)
  expect(renamePane).toHaveBeenCalledWith('pane_1', 'Agent')
  expect(patchTerminalOverride).toHaveBeenCalledWith('term_1', { titleOverride: 'Agent' })
  expect(updateTitle).toHaveBeenCalledWith('term_1', 'Agent')
  expect(patchSessionOverride).toHaveBeenCalledWith('codex:session-1', { titleOverride: 'Agent' })
  expect(broadcast).toHaveBeenCalledWith({ type: 'terminal.list.updated' })
  expect(broadcastUiCommand).toHaveBeenCalledWith({
    command: 'pane.rename',
    payload: { tabId: 'tab_1', paneId: 'pane_1', title: 'Agent' },
  })
})

it('does not fail the pane rename when terminal override persistence fails', async () => {
  const app = express()
  app.use(express.json())
  const renamePane = vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' }))
  const patchTerminalOverride = vi.fn().mockRejectedValue(new Error('disk full'))
  const patchSessionOverride = vi.fn()
  const updateTitle = vi.fn()
  const refresh = vi.fn()
  const broadcast = vi.fn()
  const broadcastUiCommand = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      renamePane,
      listPanes: () => [{ id: 'pane_1' }, { id: 'pane_2' }],
      getPaneSnapshot: () => ({
        tabId: 'tab_1',
        paneId: 'pane_1',
        paneContent: { kind: 'terminal', mode: 'codex', terminalId: 'term_1' },
      }),
    } as any,
    registry: { updateTitle } as any,
    wsHandler: { broadcastUiCommand, broadcast },
    configStore: { patchTerminalOverride, patchSessionOverride } as any,
    terminalMetadata: {
      list: () => [{ terminalId: 'term_1', provider: 'codex', sessionId: 'session-1' }],
    } as any,
    codingCliIndexer: { refresh } as any,
  }))

  const res = await request(app).patch('/api/panes/pane_1').send({ name: 'Agent' })

  expect(res.status).toBe(200)
  expect(renamePane).toHaveBeenCalledWith('pane_1', 'Agent')
  expect(patchTerminalOverride).toHaveBeenCalledWith('term_1', { titleOverride: 'Agent' })
  expect(updateTitle).not.toHaveBeenCalled()
  expect(patchSessionOverride).not.toHaveBeenCalled()
  expect(refresh).not.toHaveBeenCalled()
  expect(broadcast).not.toHaveBeenCalled()
  expect(broadcastUiCommand).toHaveBeenCalledWith({
    command: 'pane.rename',
    payload: { tabId: 'tab_1', paneId: 'pane_1', title: 'Agent' },
  })
})

it('rejects pane rename payloads longer than the terminal title override limit', async () => {
  const app = express()
  app.use(express.json())
  const renamePane = vi.fn()
  const patchTerminalOverride = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: { renamePane, getPaneSnapshot: vi.fn() } as any,
    registry: {} as any,
    wsHandler: { broadcastUiCommand: vi.fn(), broadcast: vi.fn() },
    configStore: { patchTerminalOverride } as any,
  }))

  const res = await request(app).patch('/api/panes/pane_1').send({ name: 'a'.repeat(501) })

  expect(res.status).toBe(400)
  expect(renamePane).not.toHaveBeenCalled()
  expect(patchTerminalOverride).not.toHaveBeenCalled()
})

it('does not broadcast pane.rename when the pane does not exist', async () => {
  const app = express()
  app.use(express.json())
  const renamePane = vi.fn(() => ({ message: 'pane not found' }))
  const broadcastUiCommand = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: { renamePane },
    registry: {} as any,
    wsHandler: { broadcastUiCommand },
  }))

  const res = await request(app).patch('/api/panes/missing').send({ name: 'Ghost' })

  expect(res.status).toBe(200)
  expect(renamePane).toHaveBeenCalledWith('missing', 'Ghost')
  expect(broadcastUiCommand).not.toHaveBeenCalled()
})

it('does not persist terminal rename side effects when the authoritative pane rename fails', async () => {
  const app = express()
  app.use(express.json())
  const renamePane = vi.fn(() => ({ message: 'pane not found' }))
  const patchTerminalOverride = vi.fn().mockResolvedValue({})
  const patchSessionOverride = vi.fn().mockResolvedValue({})
  const updateTitle = vi.fn()
  const refresh = vi.fn().mockResolvedValue(undefined)
  const broadcast = vi.fn()
  const broadcastUiCommand = vi.fn()
  app.use('/api', createAgentApiRouter({
    layoutStore: {
      renamePane,
      getPaneSnapshot: () => ({
        tabId: 'tab_1',
        paneId: 'pane_1',
        paneContent: { kind: 'terminal', mode: 'codex', terminalId: 'term_1' },
      }),
    } as any,
    registry: { updateTitle } as any,
    wsHandler: { broadcastUiCommand, broadcast },
    configStore: { patchTerminalOverride, patchSessionOverride } as any,
    terminalMetadata: {
      list: () => [{ terminalId: 'term_1', provider: 'codex', sessionId: 'session-1' }],
    } as any,
    codingCliIndexer: { refresh } as any,
  }))

  const res = await request(app).patch('/api/panes/pane_1').send({ name: 'Ghost' })

  expect(res.status).toBe(200)
  expect(renamePane).toHaveBeenCalledWith('pane_1', 'Ghost')
  expect(patchTerminalOverride).not.toHaveBeenCalled()
  expect(updateTitle).not.toHaveBeenCalled()
  expect(patchSessionOverride).not.toHaveBeenCalled()
  expect(refresh).not.toHaveBeenCalled()
  expect(broadcast).not.toHaveBeenCalled()
  expect(broadcastUiCommand).not.toHaveBeenCalled()
})
