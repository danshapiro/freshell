import { Router } from 'express'
import { nanoid } from 'nanoid'
import { ok, approx, fail } from './response.js'
import { renderCapture } from './capture.js'

export function createAgentApiRouter({ layoutStore, registry, wsHandler }: { layoutStore: any; registry: any; wsHandler?: any }) {
  const router = Router()

  router.post('/tabs', (req, res) => {
    const { name, mode, shell, cwd, browser, editor } = req.body || {}
    const note = browser || editor ? 'browser/editor requested; created terminal tab' : 'tab created'

    try {
      const { tabId, paneId } = layoutStore.createTab({ title: name })
      const terminal = registry.create({
        mode: mode || 'shell',
        shell,
        cwd,
        envContext: { tabId, paneId },
      })

      layoutStore.attachPaneContent(tabId, paneId, { kind: 'terminal', terminalId: terminal.terminalId })

      wsHandler?.broadcastUiCommand({
        command: 'tab.create',
        payload: { id: tabId, title: name, mode: mode || 'shell', shell, terminalId: terminal.terminalId, initialCwd: cwd },
      })

      const responder = browser || editor ? approx : ok
      res.json(responder({ tabId, paneId, terminalId: terminal.terminalId }, note))
    } catch (err: any) {
      res.status(500).json(fail(err?.message || 'Failed to create tab'))
    }
  })

  router.post('/tabs/:id/select', (req, res) => {
    const result = layoutStore.selectTab(req.params.id)
    wsHandler?.broadcastUiCommand({ command: 'tab.select', payload: { id: req.params.id } })
    res.json(ok(result, result.message || 'tab selected'))
  })

  router.patch('/tabs/:id', (req, res) => {
    const result = layoutStore.renameTab(req.params.id, req.body?.name)
    wsHandler?.broadcastUiCommand({ command: 'tab.rename', payload: { id: req.params.id, title: req.body?.name } })
    res.json(ok(result, result.message || 'tab renamed'))
  })

  router.delete('/tabs/:id', (req, res) => {
    const result = layoutStore.closeTab(req.params.id)
    wsHandler?.broadcastUiCommand({ command: 'tab.close', payload: { id: req.params.id } })
    res.json(ok(result, result.message || 'tab closed'))
  })

  router.get('/tabs/has', (req, res) => {
    const target = (req.query.target as string | undefined) || ''
    const exists = target ? layoutStore.hasTab?.(target) : false
    res.json(ok({ exists }))
  })

  router.post('/tabs/next', (_req, res) => {
    const result = layoutStore.selectNextTab?.()
    if (result?.tabId) {
      wsHandler?.broadcastUiCommand({ command: 'tab.select', payload: { id: result.tabId } })
    }
    res.json(ok(result, result?.message || 'tab selected'))
  })

  router.post('/tabs/prev', (_req, res) => {
    const result = layoutStore.selectPrevTab?.()
    if (result?.tabId) {
      wsHandler?.broadcastUiCommand({ command: 'tab.select', payload: { id: result.tabId } })
    }
    res.json(ok(result, result?.message || 'tab selected'))
  })

  router.get('/tabs', (_req, res) => {
    const tabs = layoutStore.listTabs?.() || []
    res.json(ok({ tabs }))
  })

  router.get('/panes', (req, res) => {
    const tabId = req.query.tabId as string | undefined
    const panes = layoutStore.listPanes?.(tabId) || []
    res.json(ok({ panes }))
  })

  router.get('/panes/:id/capture', (req, res) => {
    const paneId = req.params.id
    let terminalId = layoutStore.resolvePaneToTerminal?.(paneId)
    if (!terminalId && layoutStore.resolveTarget) {
      const target = layoutStore.resolveTarget(paneId)
      if (target?.paneId) terminalId = layoutStore.resolvePaneToTerminal?.(target.paneId)
    }
    const term = terminalId ? registry.get?.(terminalId) : undefined
    if (!term) return res.status(404).json(fail('terminal not found'))

    const rawStart = req.query.S
    const start = typeof rawStart === 'string' ? Number(rawStart) : undefined
    const joinLines = req.query.J === 'true' || req.query.J === '1'
    const includeAnsi = req.query.e === 'true' || req.query.e === '1'

    const output = renderCapture(term.buffer.snapshot(), { includeAnsi, joinLines, start })
    res.type('text/plain').send(output)
  })

  router.post('/panes/:id/split', (req, res) => {
    const paneId = req.params.id
    const direction = req.body?.direction || 'horizontal'
    const wantsBrowser = !!req.body?.browser
    const wantsEditor = !!req.body?.editor
    const terminal = wantsBrowser || wantsEditor
      ? undefined
      : registry.create({ mode: req.body?.mode || 'shell', shell: req.body?.shell, cwd: req.body?.cwd })

    const result = layoutStore.splitPane({
      paneId,
      direction,
      terminalId: terminal?.terminalId,
      browser: req.body?.browser,
      editor: req.body?.editor,
    })

    if (result?.tabId && result?.newPaneId) {
      wsHandler?.broadcastUiCommand({
        command: 'pane.split',
        payload: {
          tabId: result.tabId,
          paneId,
          direction,
          newContent: req.body?.browser
            ? { kind: 'browser', url: req.body.browser, devToolsOpen: false }
            : req.body?.editor
              ? { kind: 'editor', filePath: req.body.editor, language: null, readOnly: false, content: '', viewMode: 'source' }
              : { kind: 'terminal', terminalId: terminal?.terminalId, status: 'running', mode: req.body?.mode || 'shell', shell: req.body?.shell || 'system', createRequestId: nanoid() },
        },
      })
      res.json(ok({ paneId: result.newPaneId, terminalId: terminal?.terminalId }, 'pane split'))
      return
    }

    res.json(approx(result, 'pane split requested; not applied'))
  })

  router.post('/panes/:id/close', (req, res) => {
    const paneId = req.params.id
    const result = layoutStore.closePane(paneId)
    wsHandler?.broadcastUiCommand({ command: 'pane.close', payload: { tabId: result?.tabId, paneId } })
    res.json(ok(result, result?.message || 'pane closed'))
  })

  router.post('/panes/:id/select', (req, res) => {
    const paneId = req.params.id
    const result = layoutStore.selectPane(req.body?.tabId, paneId)
    if (result?.tabId) {
      wsHandler?.broadcastUiCommand({ command: 'pane.select', payload: { tabId: result.tabId, paneId } })
    }
    res.json(ok(result, result?.message || 'pane selected'))
  })

  router.post('/panes/:id/resize', (req, res) => {
    const splitId = req.params.id
    const sizes = Array.isArray(req.body?.sizes) ? req.body.sizes : [req.body?.x ?? 50, req.body?.y ?? 50]
    const values = sizes.map((v: any) => Number(v))
    const result = layoutStore.resizePane(req.body?.tabId, splitId, [values[0] || 50, values[1] || 50])
    res.json(ok(result, result?.message || 'pane resized'))
  })

  router.post('/panes/:id/swap', (req, res) => {
    const paneId = req.params.id
    const otherId = req.body?.target || req.body?.otherId
    if (!otherId) return res.json(approx(undefined, 'swap target missing'))
    const result = layoutStore.swapPane(req.body?.tabId, paneId, otherId)
    res.json(ok(result, result?.message || 'panes swapped'))
  })

  router.post('/panes/:id/respawn', (req, res) => {
    const paneId = req.params.id
    const target = layoutStore.resolveTarget(paneId)
    const tabId = target?.tabId
    if (!tabId) return res.status(404).json(fail('pane not found'))
    const terminal = registry.create({ mode: req.body?.mode || 'shell', shell: req.body?.shell, cwd: req.body?.cwd, envContext: { tabId, paneId } })
    const content = { kind: 'terminal', terminalId: terminal.terminalId, status: 'running', mode: req.body?.mode || 'shell', shell: req.body?.shell || 'system', createRequestId: nanoid() }
    layoutStore.attachPaneContent(tabId, paneId, content)
    wsHandler?.broadcastUiCommand({ command: 'pane.attach', payload: { tabId, paneId, content } })
    res.json(ok({ terminalId: terminal.terminalId }, 'pane respawned'))
  })

  router.post('/panes/:id/attach', (req, res) => {
    const paneId = req.params.id
    const terminalId = req.body?.terminalId
    if (!terminalId) return res.status(400).json(fail('terminalId required'))
    const target = layoutStore.resolveTarget(paneId)
    const tabId = target?.tabId
    if (!tabId) return res.status(404).json(fail('pane not found'))
    const content = { kind: 'terminal', terminalId, status: 'running', mode: req.body?.mode || 'shell', shell: req.body?.shell || 'system', createRequestId: nanoid() }
    layoutStore.attachPaneContent(tabId, paneId, content)
    wsHandler?.broadcastUiCommand({ command: 'pane.attach', payload: { tabId, paneId, content } })
    res.json(ok({ terminalId }, 'terminal attached'))
  })

  router.post('/panes/:id/navigate', (req, res) => {
    const paneId = req.params.id
    const url = req.body?.url || req.body?.target
    if (!url) return res.status(400).json(fail('url required'))
    const target = layoutStore.resolveTarget(paneId)
    const tabId = target?.tabId
    if (!tabId) return res.status(404).json(fail('pane not found'))
    const content = { kind: 'browser', url, devToolsOpen: false }
    layoutStore.attachPaneContent(tabId, paneId, content)
    wsHandler?.broadcastUiCommand({ command: 'pane.attach', payload: { tabId, paneId, content } })
    res.json(ok(undefined, 'navigate requested'))
  })

  router.post('/panes/:id/send-keys', (req, res) => {
    const paneId = req.params.id
    const payload = req.body || {}
    const data = payload.data ?? payload.keys ?? payload.text ?? ''
    let terminalId = layoutStore.resolvePaneToTerminal?.(paneId)
    if (!terminalId && layoutStore.resolveTarget) {
      const target = layoutStore.resolveTarget(paneId)
      if (target?.paneId) terminalId = layoutStore.resolvePaneToTerminal?.(target.paneId)
    }
    if (!terminalId) return res.status(404).json(fail('terminal not found'))
    const okInput = registry.input(terminalId, data)
    res.json(ok({ terminalId }, okInput ? 'input sent' : 'terminal not running'))
  })

  return router
}
