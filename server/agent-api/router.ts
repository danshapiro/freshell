import { Router } from 'express'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { nanoid } from 'nanoid'
import { ok, approx, fail } from './response.js'
import { renderCapture } from './capture.js'
import { waitForMatch } from './wait-for.js'
import { resolveScreenshotOutputPath } from './screenshot-path.js'

const truthy = (value: unknown) => value === true || value === 'true' || value === '1' || value === 'yes'

const parseRegex = (raw: string) => {
  if (raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
    const last = raw.lastIndexOf('/')
    const body = raw.slice(1, last)
    const flags = raw.slice(last + 1)
    return new RegExp(body, flags)
  }
  return new RegExp(raw)
}

const looksLikePrompt = (text: string) => {
  const lastLine = text.split(/\r?\n/).filter(Boolean).pop() || ''
  return /[#$>] ?$/.test(lastLine.trimEnd())
}

async function writeFileAtomic(filePath: string, content: Buffer) {
  const tempPath = `${filePath}.tmp-${randomUUID()}`
  await fs.writeFile(tempPath, content)
  try {
    await fs.rename(tempPath, filePath)
  } catch (err) {
    await fs.unlink(tempPath).catch(() => undefined)
    throw err
  }
}

export function createAgentApiRouter({ layoutStore, registry, wsHandler }: { layoutStore: any; registry: any; wsHandler?: any }) {
  const router = Router()

  const resolvePaneTarget = (raw: string) => {
    if (layoutStore.resolveTarget) {
      const resolved = layoutStore.resolveTarget(raw)
      if (resolved?.paneId) return resolved
    }
    return { paneId: raw }
  }

  router.post('/tabs', (req, res) => {
    const { name, mode, shell, cwd, browser, editor, resumeSessionId } = req.body || {}
    const wantsBrowser = !!browser
    const wantsEditor = !!editor

    try {
      const { tabId, paneId } = layoutStore.createTab({ title: name, browser, editor })

      let paneContent: any
      let terminalId: string | undefined

      if (wantsBrowser) {
        paneContent = { kind: 'browser', url: browser, devToolsOpen: false }
      } else if (wantsEditor) {
        paneContent = { kind: 'editor', filePath: editor, language: null, readOnly: false, content: '', viewMode: 'source' }
      } else {
        const terminal = registry.create({
          mode: mode || 'shell',
          shell,
          cwd,
          resumeSessionId,
          envContext: { tabId, paneId },
        })
        terminalId = terminal.terminalId
        paneContent = {
          kind: 'terminal',
          terminalId,
          status: 'running',
          mode: mode || 'shell',
          shell: shell || 'system',
          resumeSessionId,
          initialCwd: cwd,
        }
      }

      layoutStore.attachPaneContent(tabId, paneId, paneContent)

      wsHandler?.broadcastUiCommand({
        command: 'tab.create',
        payload: {
          id: tabId,
          title: name,
          mode: mode || 'shell',
          shell,
          terminalId,
          initialCwd: cwd,
          resumeSessionId,
          paneId,
          paneContent,
        },
      })

      res.json(ok({ tabId, paneId, terminalId }, 'tab created'))
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
    const activeTabId = layoutStore.getActiveTabId?.() || null
    res.json(ok({ tabs, activeTabId }))
  })

  router.get('/panes', (req, res) => {
    const tabId = req.query.tabId as string | undefined
    const panes = layoutStore.listPanes?.(tabId) || []
    res.json(ok({ panes }))
  })

  router.get('/panes/:id/capture', (req, res) => {
    const rawTarget = req.params.id
    const resolved = resolvePaneTarget(rawTarget)
    const paneId = resolved.paneId || rawTarget
    const paneSnapshot = layoutStore.getPaneSnapshot?.(paneId)
    let terminalId = paneSnapshot?.terminalId || layoutStore.resolvePaneToTerminal?.(paneId)
    const term = terminalId ? registry.get?.(terminalId) : undefined

    const rawStart = req.query.S
    const start = typeof rawStart === 'string' ? Number(rawStart) : undefined
    const joinLines = req.query.J === 'true' || req.query.J === '1'
    const includeAnsi = req.query.e === 'true' || req.query.e === '1'

    if (term) {
      const output = renderCapture(term.buffer.snapshot(), { includeAnsi, joinLines, start })
      return res.type('text/plain').send(output)
    }

    if (paneSnapshot?.kind === 'editor') {
      const editorBuffer = typeof paneSnapshot.paneContent?.content === 'string'
        ? paneSnapshot.paneContent.content
        : ''
      const output = renderCapture(editorBuffer, { includeAnsi, joinLines, start })
      return res.type('text/plain').send(output)
    }

    if (paneSnapshot?.kind && paneSnapshot.kind !== 'terminal') {
      return res.status(422).json(
        fail(`pane kind "${paneSnapshot.kind}" does not support capture-pane; use screenshot-pane`),
      )
    }

    if (terminalId || paneSnapshot?.kind === 'terminal') {
      return res.status(404).json(fail('terminal not found'))
    }

    return res.status(404).json(fail('pane not found'))
  })

  router.get('/panes/:id/wait-for', async (req, res) => {
    const paneId = req.params.id
    let terminalId = layoutStore.resolvePaneToTerminal?.(paneId)
    if (!terminalId && layoutStore.resolveTarget) {
      const target = layoutStore.resolveTarget(paneId)
      if (target?.paneId) terminalId = layoutStore.resolvePaneToTerminal?.(target.paneId)
    }
    const term = terminalId ? registry.get?.(terminalId) : undefined
    if (!term) return res.status(404).json(fail('terminal not found'))

    const rawPattern = (req.query.pattern || req.query.p) as string | undefined
    let pattern: RegExp | undefined
    if (rawPattern) {
      try {
        pattern = parseRegex(rawPattern)
      } catch {
        return res.status(400).json(fail('invalid pattern'))
      }
    }

    const rawStable = req.query.stable || req.query.s
    const stableSeconds = typeof rawStable === 'string' ? Number(rawStable) : Number.NaN
    let stableMs = Number.isFinite(stableSeconds) ? stableSeconds * 1000 : undefined

    const waitExit = truthy(req.query.exit)
    const waitPrompt = truthy(req.query.prompt)

    const rawTimeout = req.query.T || req.query.timeout
    const timeoutSeconds = typeof rawTimeout === 'string' ? Number(rawTimeout) : Number.NaN
    const timeoutMs = Number.isFinite(timeoutSeconds) ? timeoutSeconds * 1000 : 30000

    let usedFallback = false
    if (waitPrompt && stableMs === undefined) {
      stableMs = 1000
      usedFallback = true
    }
    if (!pattern && !waitExit && !waitPrompt && stableMs === undefined) {
      stableMs = 1000
      usedFallback = true
    }

    const getText = () => renderCapture(term.buffer.snapshot(), { includeAnsi: false })
    const start = Date.now()
    let lastText = getText()
    let stableSince = Date.now()

    while (true) {
      const text = getText()
      if (pattern) {
        pattern.lastIndex = 0
        if (pattern.test(text)) return res.json(ok({ matched: true, reason: 'pattern' }, 'pattern matched'))
      }
      if (waitExit && term.status === 'exited') {
        return res.json(ok({ matched: true, reason: 'exit', exitCode: term.exitCode }, 'terminal exited'))
      }
      if (waitPrompt && looksLikePrompt(text)) {
        return res.json(ok({ matched: true, reason: 'prompt' }, 'prompt detected'))
      }
      if (stableMs !== undefined) {
        if (text === lastText) {
          if (Date.now() - stableSince >= stableMs) {
            const responder = usedFallback ? approx : ok
            const message = waitPrompt && usedFallback ? 'prompt not detected; output stable' : usedFallback ? 'no wait condition; output stable' : 'output stable'
            return res.json(responder({ matched: true, reason: 'stable' }, message))
          }
        } else {
          lastText = text
          stableSince = Date.now()
        }
      }
      if (Date.now() - start >= timeoutMs) return res.json(approx({ matched: false }, 'timeout'))
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  })

  router.post('/screenshots', async (req, res) => {
    const rawScope = req.body?.scope
    const nameRaw = req.body?.name
    const pathInput = typeof req.body?.path === 'string' ? req.body.path : undefined
    const overwrite = truthy(req.body?.overwrite)
    const paneId = typeof req.body?.paneId === 'string' ? req.body.paneId : undefined
    const tabId = typeof req.body?.tabId === 'string' ? req.body.tabId : undefined

    if (rawScope !== 'pane' && rawScope !== 'tab' && rawScope !== 'view') {
      return res.status(400).json(fail('scope must be pane, tab, or view'))
    }

    const scope: 'pane' | 'tab' | 'view' = rawScope

    if (scope === 'pane' && !paneId) {
      return res.status(400).json(fail('paneId required for pane scope'))
    }

    if (scope === 'tab' && !tabId) {
      return res.status(400).json(fail('tabId required for tab scope'))
    }

    if (!wsHandler?.requestUiScreenshot) {
      return res.status(503).json(fail('ui screenshot channel unavailable'))
    }

    let outputPath: string
    try {
      outputPath = await resolveScreenshotOutputPath({
        name: String(nameRaw || ''),
        pathInput,
      })
    } catch (err: any) {
      return res.status(400).json(fail(err?.message || 'invalid screenshot options'))
    }

    try {
      if (!overwrite) {
        try {
          await fs.access(outputPath)
          return res.status(409).json(fail('output file already exists (use --overwrite)'))
        } catch {
          // File does not exist, continue.
        }
      }

      const ui = await wsHandler.requestUiScreenshot({ scope, tabId, paneId })
      if (!ui?.ok || !ui?.imageBase64) {
        return res.status(422).json(fail(ui?.error || 'ui screenshot failed'))
      }

      await writeFileAtomic(outputPath, Buffer.from(ui.imageBase64, 'base64'))

      return res.json(
        ok(
          {
            path: outputPath,
            scope,
            tabId,
            paneId,
            width: ui.width,
            height: ui.height,
            changedFocus: !!ui.changedFocus,
            restoredFocus: !!ui.restoredFocus,
            timestamp: Date.now(),
          },
          'screenshot saved',
        ),
      )
    } catch (err: any) {
      return res.status(500).json(fail(err?.message || 'failed to capture screenshot'))
    }
  })

  router.post('/run', async (req, res) => {
    const payload = req.body || {}
    const command = payload.command || payload.cmd
    if (!command) return res.status(400).json(fail('command required'))

    const title = payload.name || payload.title
    const mode = payload.mode || 'shell'
    const shell = payload.shell
    const cwd = payload.cwd
    const capture = truthy(payload.capture)
    const detached = truthy(payload.detached) || truthy(payload.detach) || truthy(payload.background)
    const rawTimeout = payload.timeout || payload.T
    const timeoutSeconds = typeof rawTimeout === 'number' ? rawTimeout : Number(rawTimeout)
    const timeoutMs = Number.isFinite(timeoutSeconds) ? timeoutSeconds * 1000 : 30000

    const created = layoutStore.createTab?.({ title })
    const tabId = created?.tabId || nanoid()
    const paneId = created?.paneId || nanoid()
    const terminal = registry.create({ mode, shell, cwd, envContext: { tabId, paneId } })
    layoutStore.attachPaneContent?.(tabId, paneId, { kind: 'terminal', terminalId: terminal.terminalId })
    wsHandler?.broadcastUiCommand({
      command: 'tab.create',
      payload: { id: tabId, title, mode, shell, terminalId: terminal.terminalId, initialCwd: cwd },
    })

    const sentinel = `__FRESHELL_DONE_${nanoid()}__`
    const input = capture ? `${command}; echo ${sentinel}\r` : `${command}\r`
    registry.input(terminal.terminalId, input)

    if (!capture || detached) {
      const message = detached ? 'command started (detached)' : 'command sent'
      return res.json(ok({ terminalId: terminal.terminalId, tabId, paneId }, message))
    }

    const escaped = sentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const result = await waitForMatch(
      () => renderCapture(registry.get(terminal.terminalId)?.buffer.snapshot() || '', { includeAnsi: false }),
      new RegExp(escaped),
      { timeoutMs },
    )
    const rawOutput = renderCapture(registry.get(terminal.terminalId)?.buffer.snapshot() || '', { includeAnsi: false })
    const output = rawOutput.split(sentinel).join('').trim()
    const responder = result.matched ? ok : approx
    const message = result.matched ? 'run complete' : 'timeout waiting for command'
    return res.json(responder({ terminalId: terminal.terminalId, tabId, paneId, output }, message))
  })

  router.post('/panes/:id/split', (req, res) => {
    const rawPaneId = req.params.id
    const resolved = resolvePaneTarget(rawPaneId)
    const paneId = resolved.paneId || rawPaneId
    const direction = req.body?.direction || 'horizontal'
    const wantsBrowser = !!req.body?.browser
    const wantsEditor = !!req.body?.editor

    const result = layoutStore.splitPane({
      paneId,
      direction,
      browser: wantsBrowser ? req.body?.browser : undefined,
      editor: wantsEditor ? req.body?.editor : undefined,
    })

    if (!result?.tabId || !result?.newPaneId) {
      res.json(approx(result, 'pane split requested; not applied'))
      return
    }

    const tabId = result.tabId
    const newPaneId = result.newPaneId

    let content: any
    let terminalId: string | undefined
    if (wantsBrowser) {
      content = { kind: 'browser', url: req.body.browser, devToolsOpen: false }
    } else if (wantsEditor) {
      content = { kind: 'editor', filePath: req.body.editor, language: null, readOnly: false, content: '', viewMode: 'source' }
    } else {
      const terminal = registry.create({
        mode: req.body?.mode || 'shell',
        shell: req.body?.shell,
        cwd: req.body?.cwd,
        envContext: { tabId, paneId: newPaneId },
      })
      terminalId = terminal.terminalId
      content = { kind: 'terminal', terminalId, status: 'running', mode: req.body?.mode || 'shell', shell: req.body?.shell || 'system' }
    }

    layoutStore.attachPaneContent(tabId, newPaneId, content)

    wsHandler?.broadcastUiCommand({
      command: 'pane.split',
      payload: {
        tabId,
        paneId,
        direction,
        newPaneId,
        newContent: content,
      },
    })

    const message = wantsBrowser || wantsEditor ? 'pane split (non-terminal)' : 'pane split'
    res.json(ok({ paneId: newPaneId, terminalId }, message))
  })

  router.post('/panes/:id/close', (req, res) => {
    const rawPaneId = req.params.id
    const resolved = resolvePaneTarget(rawPaneId)
    const paneId = resolved.paneId || rawPaneId
    const result = layoutStore.closePane(paneId)
    wsHandler?.broadcastUiCommand({ command: 'pane.close', payload: { tabId: result?.tabId, paneId } })
    res.json(ok(result, resolved.message || result?.message || 'pane closed'))
  })

  router.post('/panes/:id/select', (req, res) => {
    const rawPaneId = req.params.id
    const resolved = resolvePaneTarget(rawPaneId)
    const paneId = resolved.paneId || rawPaneId
    const tabId = req.body?.tabId || resolved.tabId
    const result = layoutStore.selectPane(tabId, paneId)
    if (result?.tabId) {
      wsHandler?.broadcastUiCommand({ command: 'pane.select', payload: { tabId: result.tabId, paneId } })
    }
    res.json(ok(result, resolved.message || result?.message || 'pane selected'))
  })

  router.post('/panes/:id/resize', (req, res) => {
    const rawTarget = req.params.id
    const sizes = Array.isArray(req.body?.sizes) ? req.body.sizes : [req.body?.x ?? 50, req.body?.y ?? 50]
    const values = sizes.map((v: any) => Number(v))
    const normalizedSizes: [number, number] = [values[0] || 50, values[1] || 50]

    let splitId = rawTarget
    let result = layoutStore.resizePane(req.body?.tabId, splitId, normalizedSizes)
    let message = result?.message

    if (message === 'split not found' && layoutStore.findSplitForPane && layoutStore.resolveTarget) {
      const resolved = layoutStore.resolveTarget(rawTarget)
      if (resolved?.paneId) {
        const parent = layoutStore.findSplitForPane(resolved.paneId)
        if (parent?.splitId) {
          splitId = parent.splitId
          result = layoutStore.resizePane(parent.tabId, splitId, normalizedSizes)
          message = 'pane matched; resized parent split'
        }
      }
    }

    if (result?.tabId) {
      wsHandler?.broadcastUiCommand({ command: 'pane.resize', payload: { tabId: result.tabId, splitId, sizes: normalizedSizes } })
    }
    res.json(ok(result, message || result?.message || 'pane resized'))
  })

  router.post('/panes/:id/swap', (req, res) => {
    const rawPaneId = req.params.id
    const otherRaw = req.body?.target || req.body?.otherId
    if (!otherRaw) return res.json(approx(undefined, 'swap target missing'))

    const resolved = resolvePaneTarget(rawPaneId)
    const paneId = resolved.paneId || rawPaneId
    const otherResolved = resolvePaneTarget(otherRaw)
    const otherId = otherResolved.paneId || otherRaw
    if (!otherId) return res.json(approx(undefined, 'swap target missing'))
    const result = layoutStore.swapPane(req.body?.tabId, paneId, otherId)
    if (result?.tabId) {
      wsHandler?.broadcastUiCommand({ command: 'pane.swap', payload: { tabId: result.tabId, paneId, otherId } })
    }
    const message = resolved.message || otherResolved.message || result?.message || 'panes swapped'
    res.json(ok(result, message))
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
