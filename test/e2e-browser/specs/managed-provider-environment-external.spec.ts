import type { Page } from '@playwright/test'
import path from 'node:path'
import { resolvePairedExternalFixture } from '../../../scripts/testing/e2e-external-target.js'
import { test, expect } from '../helpers/fixtures.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { TestHarness } from '../helpers/test-harness.js'
import type { ProviderPreparationFailure } from '../../../shared/ws-protocol.js'
import { summarizeProviderPreparationFailure, summarizeRuntimeErrorClass, summarizeRuntimeErrorCode } from '../../../scripts/testing/managed-environment-create.js'

const paired = resolvePairedExternalFixture(process.env, true)
if (paired?.kind !== 'managed-environment') throw new Error('Managed environment requires its paired owned target')
const fixture = paired.fixture
const headers = { 'x-auth-token': paired.targetToken }
const healthyTitle = 'executes selected resources with Bun in both managed stages and retains identity on reconnect'
const caseScenarios: Record<string, string> = {
  [healthyTitle]: 'healthy',
  'missing-reference retains an actionable blocked result without a replacement conversation': 'missing-reference',
  'startup-before-identity retains an actionable blocked result without a replacement conversation': 'startup-before-identity',
}

async function terminalDiagnostic(page: Page, terminalId?: string, paneId?: string, createRequestId?: string) {
  const diagnostic = await page.evaluate(({ terminalId, paneId, createRequestId, marker }) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    const buffer = terminalId && harness ? harness.getTerminalBuffer(terminalId) : null
    const received = (harness?.getReceivedWsMessages?.() ?? []) as any[]
    const sent = (harness?.getSentWsMessages?.() ?? []) as any[]
    const paneCreates = sent.filter(message => message.type === 'terminal.create' && message.paneId === paneId)
    const paneCreateRequestIds = new Set(paneCreates.map(message => message.requestId).filter(value => typeof value === 'string'))
    const writes = (harness?.getTerminalWriteEvents?.() ?? []).filter(event => event.terminalId === terminalId)
    const output = received.filter(message => message.terminalId === terminalId
      && ['terminal.output', 'terminal.output.batch'].includes(message.type))
    const classify = (chunks: string[]) => {
      let tail = '', markerPresent = false, reset = false, alternateEntered = false, alternateExited = false
      for (const chunk of chunks) {
        const current = tail + chunk
        markerPresent ||= current.includes(marker)
        reset ||= current.includes('\x1bc') || current.includes('\x1b[2J')
        alternateEntered ||= /\x1b\[\?(?:47|1047|1049)h/.test(current)
        alternateExited ||= /\x1b\[\?(?:47|1047|1049)l/.test(current)
        tail = current.slice(-Math.max(marker.length - 1, 16))
      }
      return { chunks: chunks.length, markerPresent, reset, alternateEntered, alternateExited }
    }
    const attachRequests = new Set(sent.filter(message => terminalId && message.terminalId === terminalId
      && message.type === 'terminal.attach').map(message => message.attachRequestId))
    const attachErrors = received.filter(message => message.type === 'error' && (
      (Boolean(terminalId) && message.terminalId === terminalId)
      || typeof message.requestId === 'string' && (
        message.requestId === createRequestId
        || paneCreateRequestIds.has(message.requestId)
        || attachRequests.has(message.requestId)
      )
    ))
      .slice(-16).map(message => ({ type: 'error', code: ['INVALID_REQUEST', 'TERMINAL_NOT_FOUND', 'PTY_SPAWN_FAILED',
        'SESSION_RESERVED', 'INTERNAL_ERROR', 'AUTH_FAILED'].includes(message.code) ? message.code : 'UNKNOWN',
      ...(typeof message.terminalId === 'string' ? { terminalId: message.terminalId } : {}),
      ...(typeof message.requestId === 'string' ? { requestId: message.requestId } : {}),
      message: typeof message.message === 'string' ? message.message.slice(0, 4096) : undefined,
      providerPreparationFailure: message.providerPreparationFailure }))
    const metadata = (messages: any[]) => messages.filter(message => message.terminalId === terminalId && [
      'terminal.attach', 'terminal.replay.credit', 'terminal.attach.ready', 'terminal.output.gap',
      'terminal.stream.changed', 'terminal.modes.sync', 'terminal.turn.complete',
    ].includes(message.type)).slice(-32).map(message => {
      const value: Record<string, string | number | boolean> = { type: message.type }
      for (const key of ['sinceSeq', 'requestedSinceSeq', 'effectiveSinceSeq', 'oldestRetainedSeq', 'headSeq',
        'replayFromSeq', 'replayToSeq', 'consumedSeq', 'fromSeq', 'toSeq', 'geometryEpoch']) {
        if (Number.isSafeInteger(message[key]) && message[key] >= 0) value[key] = message[key]
      }
      for (const key of ['attachRequestId', 'streamId']) {
        if (typeof message[key] === 'string' && /^[a-zA-Z0-9._:-]{1,512}$/.test(message[key])) value[key] = message[key]
      }
      if (typeof message.surfaceReset === 'boolean') value.surfaceReset = message.surfaceReset
      if (['viewport_hydrate', 'transport_reconnect', 'keepalive_delta'].includes(message.intent)) value.intent = message.intent
      if (['geometry_authority_unknown', 'retention_lost'].includes(message.replayResetReason)) value.replayResetReason = message.replayResetReason
      if (['queue_overflow', 'replay_window_exceeded', 'replay_budget_exceeded', 'handoff_boundary_reached',
        'new_pty_session', 'codex_pty_recovery', 'retention_lost', 'server_restart_incompatible_retention'].includes(message.reason)) value.reason = message.reason
      return value
    })
    const relevantMessages = received.filter(message => [
      'terminal.created', 'terminal.status', 'terminal.exit', 'terminal.replaced', 'error',
    ].includes(message.type) && (
      (Boolean(terminalId) && (message.terminalId === terminalId || message.oldTerminalId === terminalId || message.newTerminalId === terminalId))
      || typeof message.requestId === 'string' && (
        message.requestId === createRequestId || paneCreateRequestIds.has(message.requestId)
      )
    )).slice(-24).map(message => {
      const value: Record<string, string | number | boolean> = { type: message.type }
      for (const key of ['code', 'requestId', 'terminalId', 'oldTerminalId', 'newTerminalId', 'status', 'exitCode', 'mode']) {
        if (typeof message[key] === 'string' || Number.isSafeInteger(message[key])) value[key] = message[key]
      }
      if (message.recoverySummary && typeof message.recoverySummary === 'object') {
        const summary = message.recoverySummary as Record<string, unknown>
        for (const key of ['recoveryState', 'desiredState', 'reason']) {
          if (typeof summary[key] === 'string') value[`recovery${key[0]!.toUpperCase()}${key.slice(1)}`] = summary[key] as string
        }
      }
      return value
    })
    const recentPaneCreates = paneCreates.slice(-16).map(message => ({
      requestId: typeof message.requestId === 'string' ? message.requestId : 'UNKNOWN',
      mode: typeof message.mode === 'string' ? message.mode : 'UNKNOWN',
      restore: message.restore === true,
    }))
    return { harnessPresent: Boolean(harness), bufferType: typeof buffer, bufferNull: buffer === null,
      bufferLength: typeof buffer === 'string' ? buffer.length : null,
      markerPresent: typeof buffer === 'string' ? buffer.includes(marker) : false,
      xtermBufferType: terminalId && harness ? harness.getTerminalModes(terminalId)?.bufferType ?? 'UNKNOWN' : 'UNKNOWN',
      receivedOutput: classify(output.map(message => message.data).filter(value => typeof value === 'string')),
      submittedWrites: classify(writes.filter(event => event.phase === 'submitted').map(event => event.data)),
      completedWrites: classify(writes.filter(event => event.phase === 'written').map(event => event.data)),
      sentMetadata: metadata(sent), receivedMetadata: metadata(received), attachErrors,
      paneCreates: recentPaneCreates, relevantMessages,
      // These getters retain bounded history, not a complete transport trace.
      receivedHistoryAtBound: received.length >= 500, writeHistoryAtBound: writes.length >= 1000 }
  }, { terminalId, paneId, createRequestId, marker: `MANAGED_ENV_OUTPUT ${fixture.expectedNonce}` }).catch(() => ({ observation: 'UNKNOWN' }))
  if (!('attachErrors' in diagnostic) || !Array.isArray(diagnostic.attachErrors)) return diagnostic
  return { ...diagnostic, attachErrors: diagnostic.attachErrors.map((error: any) => {
    const runtimeErrorClass = summarizeRuntimeErrorClass(error.message ?? '')
    const runtimeErrorCode = summarizeRuntimeErrorCode(error.message ?? '')
    const providerPreparationFailure = summarizeProviderPreparationFailure(error.providerPreparationFailure)
    return { type: error.type, code: error.code,
      ...(typeof error.terminalId === 'string' ? { terminalId: error.terminalId } : {}),
      ...(typeof error.requestId === 'string' ? { requestId: error.requestId } : {}),
      ...(runtimeErrorClass ? { runtimeErrorClass } : {}),
      ...(runtimeErrorCode ? { runtimeErrorCode } : {}),
      ...(providerPreparationFailure ? { providerPreparationFailure } : {}) }
  }) }
}

async function hasCompletedOutputWrite(page: Page, terminalId: string, marker: string, after = 0) {
  return page.evaluate(({ terminalId, marker, after }) => {
    const events = window.__FRESHELL_TEST_HARNESS__?.getTerminalWriteEvents?.() ?? []
    let tail = ''
    for (const event of events) {
      if (event.terminalId !== terminalId || event.phase !== 'written' || event.at < after) continue
      const current = tail + event.data
      if (current.includes(marker)) return true
      tail = current.slice(-Math.max(marker.length - 1, 16))
    }
    return false
  }, { terminalId, marker, after })
}

test.afterEach(async ({ page }, info) => {
  const scenario = caseScenarios[info.title]
  if (!scenario) throw new Error('Unknown managed environment case')
  const cwd = `${fixture.remoteWorkspacePath}/${scenario}`
  const request = await readReceipt(page, `${cwd}/.managed-fixture/request.json`)
  let failureEvidence: Record<string, unknown> | undefined
  if (info.status !== info.expectedStatus) {
    const pane = await activePane(page).catch(() => null)
    const content = pane?.content.kind === 'terminal' ? pane.content : undefined
    const diagnostic = await terminalDiagnostic(page, content?.terminalId, pane?.paneId, content?.createRequestId)
    failureEvidence = {
      stage: info.annotations.filter(value => value.type === 'managed-stage').at(-1)?.description ?? 'UNKNOWN',
      paneId: pane?.paneId,
      terminalId: content?.terminalId,
      createRequestId: content?.createRequestId,
      paneStatus: content?.status,
      runtimeStatus: content?.runtimeStatus,
      recoveryState: content?.recoverySummary?.recoveryState,
      recoveryReason: content?.recoverySummary?.reason,
      terminalPresent: Boolean(content?.terminalId),
      soulPresent: Boolean(content?.soulId),
      nativeIdentityPresent: Boolean(content?.sessionRef),
      diagnostic,
    }
    console.error(JSON.stringify({ severity: 'error', event: 'managed_environment.browser_attempt_failed',
      scenario, attempt: info.retry, status: info.status,
      ...failureEvidence }))
  }
  const response = await page.request.post(`${paired!.targetUrl}/api/files/write`, { headers, timeout: 30_000,
    data: { path: `${cwd}/.managed-fixture/completion.json`, content: JSON.stringify({ ...fixture, scenario,
      attempt: info.retry, status: info.status, willRetry: info.status !== info.expectedStatus && info.retry < info.project.retries,
      ...(failureEvidence ? { failureEvidence } : {}),
      ...(request?.attempt === info.retry ? { createRequestId: request.createRequestId } : {}) }) } })
  expect(response.ok()).toBe(true)
})

async function json(page: Page, route: string) {
  const response = await page.request.get(`${paired!.targetUrl}${route}`, { headers, timeout: 30_000 })
  if (!response.ok()) console.error(JSON.stringify({ severity: 'error', event: 'managed_environment.browser_http_failed',
    route, status: response.status() }))
  expect(response.ok()).toBe(true)
  return response.json()
}

async function readReceipt(page: Page, selected: string): Promise<any | null> {
  const response = await page.request.get(`${paired!.targetUrl}/api/files/read?path=${encodeURIComponent(selected)}`,
    { headers, timeout: 30_000 })
  if (response.status() === 404) return null
  expect(response.ok()).toBe(true)
  return JSON.parse((await response.json()).content)
}

async function activePane(page: Page) {
  return page.evaluate(() => {
    const state = window.__FRESHELL_TEST_HARNESS__!.getState()
    const root = state.panes.layouts[state.tabs.activeTabId!]
    if (root?.type !== 'leaf') throw new Error('Expected the real picker to have one leaf pane')
    return { tabId: state.tabs.activeTabId!, paneId: root.id, content: root.content }
  })
}

async function launch(page: Page, scenario: string, attempt: number) {
  await page.goto(`${paired!.targetUrl}/?token=${encodeURIComponent(paired!.targetToken)}&e2e=1`)
  await page.waitForFunction(() => Boolean(window.__FRESHELL_TEST_HARNESS__), undefined, { timeout: 60_000 })
  await new TestHarness(page).waitForConnection(120_000)
  const info = await json(page, '/api/server-info')
  expect(info.runtime).toBe('rust')
  expect(info.commit).toBe(fixture.candidateSha)
  expect(info.buildDirty).toBe(false)
  const readiness = await json(page, '/api/runtime/readiness')
  expect(readiness.readiness.initialScanState).toBe('complete')
  expect(await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.getReceivedWsMessages?.()
    .some((message: any) => message.type === 'ready' && message.capabilities?.managedRuntimeV1 === true))).toBe(true)

  const add = page.locator('[data-context="tab-add"]')
  if (await add.isVisible()) await add.click()
  const picker = await openPanePicker(page)
  const before = await activePane(page)
  // Authorize the actual UI-generated request before its normal create effect runs.
  // The existing test harness suppresses effects only for this picker leaf.
  await page.evaluate(id => window.__FRESHELL_TEST_HARNESS__!.setTerminalNetworkEffectsSuppressed(id, true), before.paneId)
  await picker.getByRole('button', { name: /^OpenCode$/ }).click()
  const cwd = `${fixture.remoteWorkspacePath}/${scenario}`
  const directory = page.getByRole('combobox', { name: /Starting directory for OpenCode/i })
  await directory.fill(cwd)
  await directory.press('Enter')
  await expect.poll(async () => (await activePane(page)).content.kind).toBe('terminal')
  const selected = await activePane(page)
  if (selected.content.kind !== 'terminal') throw new Error('The OpenCode picker did not create terminal content')
  expect(selected.paneId).toBe(before.paneId)
  expect(selected.content.mode).toBe('opencode')
  expect(selected.content.createRequestId).toBeTruthy()
  const request = { ...fixture, scenario, attempt, createRequestId: selected.content.createRequestId, paneId: selected.paneId }
  const written = await page.request.post(`${paired!.targetUrl}/api/files/write`, { headers,
    data: { path: `${cwd}/.managed-fixture/request.json`, content: JSON.stringify(request) } })
  expect(written.ok()).toBe(true)
  await expect.poll(async () => readReceipt(page, `${cwd}/.managed-fixture/authorized.json`),
    { timeout: 120_000 }).toMatchObject({ candidateSha: fixture.candidateSha, runId: fixture.runId,
      expectedNonce: fixture.expectedNonce, attempt, createRequestId: selected.content.createRequestId })
  await page.evaluate(id => {
    const harness = window.__FRESHELL_TEST_HARNESS__!
    harness.setTerminalNetworkEffectsSuppressed(id, false)
    const state = harness.getState()
    const tabId = state.tabs.activeTabId!
    const root = state.panes.layouts[tabId]
    if (root?.type !== 'leaf' || root.id !== id) throw new Error('The selected picker leaf changed')
    harness.dispatch({ type: 'panes/updatePaneContent', payload: { tabId, paneId: id, content: { ...root.content } } })
  }, selected.paneId)
  await expect.poll(async () => {
    const pane = await activePane(page)
    return pane.content.kind === 'terminal'
      ? scenario === 'missing-reference' ? pane.content.launchFailure?.providerPreparationFailure : pane.content.terminalId
      : null
  }, { timeout: 120_000 }).toBeTruthy()
  return { ...(await activePane(page)), cwd, createRequestId: selected.content.createRequestId }
}

test(healthyTitle, async ({ page }, info) => {
  test.setTimeout(360_000)
  info.annotations.push({ type: 'managed-stage', description: 'healthy-launch' })
  const pane = await launch(page, 'healthy', info.retry)
  if (pane.content.kind !== 'terminal') throw new Error('Expected the real OpenCode terminal')
  const terminalId = pane.content.terminalId!
  const marker = `MANAGED_ENV_OUTPUT ${fixture.expectedNonce}`
  info.annotations.push({ type: 'managed-stage', description: 'healthy-initial-output' })
  await expect.poll(() => hasCompletedOutputWrite(page, terminalId, marker),
    { timeout: 120_000 }).toBe(true)
  let receipt: any
  await expect.poll(async () => {
    receipt = await readReceipt(page, `${pane.cwd}/.managed-fixture/target-receipt.json`)
    return receipt
  }, { timeout: 120_000 }).toMatchObject({ candidateSha: fixture.candidateSha, runId: fixture.runId,
    expectedNonce: fixture.expectedNonce, terminalId, stage: { observed: true }, child: {
      terminalId, bun: true, dependency: fixture.expectedNonce, resource: fixture.expectedNonce,
      absoluteReference: fixture.expectedNonce, relativeReference: fixture.expectedNonce, executableMode: '0711',
    } })
  let directMcpReceipt: any
  await expect.poll(async () => {
    directMcpReceipt = await readReceipt(page, `${pane.cwd}/.managed-fixture/direct-mcp-receipt.json`)
    return directMcpReceipt
  }, { timeout: 120_000 }).toMatchObject({ expectedNonce: fixture.expectedNonce, helper: fixture.expectedNonce })
  // The shell wrapper changes into its own MCP directory before launching Node.
  expect(directMcpReceipt.cwd).toBe(path.dirname(directMcpReceipt.scriptPath))
  expect(directMcpReceipt).toMatchObject({ sibling: fixture.expectedNonce,
    dependency: fixture.expectedNonce, schemaNonce: fixture.expectedNonce,
    envFileOperandRewritten: true, envValueLoaded: true })
  expect(directMcpReceipt.scriptPath).toMatch(/\/direct-mcp\/server\.mjs$/)
  expect(receipt.directHomeAppendMcp).toMatchObject({ envFileOperandRewritten: true, envValueLoaded: true })
  expect(receipt.soulId).toBeTruthy()
  expect(receipt.incarnationId).toBeTruthy()
  expect(receipt.nativeSessionId).toBeTruthy()
  const replacementCreateRequestsBeforeReconnect = await page.evaluate(({ paneId, createRequestId }) => window.__FRESHELL_TEST_HARNESS__!.getSentWsMessages?.()
    .filter((message: any) => message.type === 'terminal.create' && message.paneId === paneId)
    .map((message: any) => message.requestId)
    .filter((requestId: string) => requestId !== createRequestId),
  { paneId: pane.paneId, createRequestId: pane.createRequestId })
  console.log(JSON.stringify({ severity: 'info', event: 'managed_environment.browser_before_reconnect',
    scenario: 'healthy', attempt: info.retry,
    diagnostic: await terminalDiagnostic(page, terminalId, pane.paneId, pane.createRequestId) }))
  const reconnectStartedAt = await page.evaluate(() => performance.now())
  await new TestHarness(page).forceDisconnect()
  await new TestHarness(page).waitForConnection(120_000)
  await expect.poll(async () => (await activePane(page)).content).toMatchObject({ terminalId,
    sessionRef: { provider: 'opencode', sessionId: receipt.nativeSessionId } })
  info.annotations.push({ type: 'managed-stage', description: 'healthy-post-reconnect-output' })
  await expect.poll(() => hasCompletedOutputWrite(page, terminalId, marker, reconnectStartedAt),
    { timeout: 120_000 }).toBe(true)
  expect(await page.evaluate(({ paneId, createRequestId }) => window.__FRESHELL_TEST_HARNESS__!.getSentWsMessages?.()
    .filter((message: any) => message.type === 'terminal.create' && message.paneId === paneId)
    .map((message: any) => message.requestId)
    .filter((requestId: string) => requestId !== createRequestId),
  { paneId: pane.paneId, createRequestId: pane.createRequestId }))
    .toEqual(replacementCreateRequestsBeforeReconnect)
  const rows = await json(page, '/api/terminals')
  expect(rows.filter((row: any) => row.cwd === pane.cwd)).toHaveLength(1)
  expect(rows.find((row: any) => row.terminalId === terminalId)).toMatchObject({ terminalId,
    soulId: receipt.soulId, incarnationId: receipt.incarnationId, runtimeStatus: 'running' })
})

for (const scenario of ['missing-reference', 'startup-before-identity']) {
  test(`${scenario} retains an actionable blocked result without a replacement conversation`, async ({ page }, info) => {
    test.setTimeout(300_000)
    info.annotations.push({ type: 'managed-stage', description: `${scenario}-launch` })
    const pane = await launch(page, scenario, info.retry)
    if (pane.content.kind !== 'terminal') throw new Error('Expected the retained managed terminal')
    if (scenario === 'missing-reference') {
      const selectedPath = `${pane.cwd}/missing-selected.txt`
      const preparationFailure = { code: 'SELECTED_REFERENCE_UNAVAILABLE', stage: 'configuration', operation: 'resolve',
        cause: 'not_found', workspace: pane.cwd, declaringConfig: `${pane.cwd}/opencode.json`, selectedPath } satisfies ProviderPreparationFailure
      const retained = { mode: 'opencode', status: 'error', createRequestId: pane.createRequestId,
        launchFailure: { code: 'LAUNCH_FAILED', providerPreparationFailure: preparationFailure } }
      expect(pane.content).toMatchObject(retained)
      expect(await page.evaluate(requestId => window.__FRESHELL_TEST_HARNESS__!.getReceivedWsMessages?.()
        .filter((message: any) => message.type === 'error' && message.requestId === requestId)
        .map((message: any) => ({ code: message.code, requestId: message.requestId,
          providerPreparationFailure: message.providerPreparationFailure })), pane.createRequestId)).toContainEqual({
        code: 'PTY_SPAWN_FAILED', requestId: pane.createRequestId, providerPreparationFailure: preparationFailure,
      })
      expect(await page.evaluate(requestId => window.__FRESHELL_TEST_HARNESS__!.getReceivedWsMessages?.()
        .filter((message: any) => message.type === 'terminal.created' && message.requestId === requestId).length,
      pane.createRequestId)).toBe(0)
      const assertNoHandle = async () => {
        const current = (await activePane(page)).content
        if (current.kind !== 'terminal') throw new Error('Expected the real failed request pane')
        expect(current.terminalId).toBeUndefined()
        expect(current.soulId).toBeUndefined()
        expect(current.sessionRef).toBeUndefined()
        expect(current.resumeSessionId).toBeUndefined()
        expect((await json(page, '/api/terminals')).filter((item: any) => item.cwd === pane.cwd)).toHaveLength(0)
        expect(await readReceipt(page, `${pane.cwd}/.managed-fixture/child-receipt.json`)).toBeNull()
      }
      const diagnostic = page.locator('[data-testid="terminal-work-area"]')
      await expect(diagnostic).toContainText(selectedPath)
      await expect(diagnostic).toContainText(/not found/i)
      await expect(diagnostic.getByRole('button', { name: 'Retry launch' })).toBeVisible()
      await expect(diagnostic.getByRole('button', { name: /^Attach/ })).toHaveCount(0)
      await assertNoHandle()
      const paneCreateRequests = await page.evaluate(paneId => window.__FRESHELL_TEST_HARNESS__!.getSentWsMessages?.()
        .filter((message: any) => message.type === 'terminal.create' && message.paneId === paneId)
        .map((message: any) => message.requestId), pane.paneId)
      expect(paneCreateRequests).toEqual([pane.createRequestId])
      await new TestHarness(page).forceDisconnect()
      await new TestHarness(page).waitForConnection(120_000)
      await expect.poll(async () => (await activePane(page)).content, { timeout: 30_000 })
        .toMatchObject(retained)
      expect(await page.evaluate(paneId => window.__FRESHELL_TEST_HARNESS__!.getSentWsMessages?.()
        .filter((message: any) => message.type === 'terminal.create' && message.paneId === paneId)
        .map((message: any) => message.requestId), pane.paneId)).toEqual(paneCreateRequests)
      await assertNoHandle()
      await page.reload()
      await page.waitForFunction(() => Boolean(window.__FRESHELL_TEST_HARNESS__), undefined, { timeout: 60_000 })
      await new TestHarness(page).waitForConnection(120_000)
      expect((await activePane(page)).content).toMatchObject(retained)
      expect(await page.evaluate(({ paneId, requestId }) => window.__FRESHELL_TEST_HARNESS__!.getSentWsMessages?.()
        .filter((message: any) => message.type === 'terminal.create' && message.paneId === paneId && message.requestId === requestId).length,
      { paneId: pane.paneId, requestId: pane.createRequestId })).toBe(0)
      await expect(diagnostic).toContainText(selectedPath)
      await expect(diagnostic).toContainText(/not found/i)
      await assertNoHandle()
      return
    }
    const terminalId = pane.content.terminalId!
    let row: any
    info.annotations.push({ type: 'managed-stage', description: 'startup-before-identity-blocked-directory' })
    await expect.poll(async () => {
      row = (await json(page, '/api/terminals')).find((item: any) => item.terminalId === terminalId)
      return row
    }, { timeout: 120_000 }).toMatchObject({ terminalId, runtimeStatus: 'blocked', recoverySummary: { recoveryState: 'blocked' } })
    expect(row.recoverySummary.reason).toBeTruthy()
    expect(row.sessionRef).toBeUndefined()
    const diagnostic = page.locator('[data-testid="terminal-work-area"]')
    await expect(diagnostic).toContainText(/blocked|unable|failed/i)
    await expect(diagnostic).toContainText(scenario === 'missing-reference' ? /missing-selected/i : /startup-fixture/i)
    const terminalIdsBeforeReconnect = (await json(page, '/api/terminals'))
      .filter((item: any) => item.cwd === pane.cwd)
      .map((item: any) => item.terminalId)
      .sort()
    expect(terminalIdsBeforeReconnect).toContain(terminalId)
    const paneCreateRequests = await page.evaluate(paneId => window.__FRESHELL_TEST_HARNESS__!.getSentWsMessages?.()
      .filter((message: any) => message.type === 'terminal.create' && message.paneId === paneId)
      .map((message: any) => message.requestId), pane.paneId)
    await new TestHarness(page).forceDisconnect()
    await new TestHarness(page).waitForConnection(120_000)
    await expect.poll(async () => (await activePane(page)).content, { timeout: 30_000 })
      .toMatchObject({ terminalId, status: 'error' })
    expect(await page.evaluate(paneId => window.__FRESHELL_TEST_HARNESS__!.getSentWsMessages?.()
      .filter((message: any) => message.type === 'terminal.create' && message.paneId === paneId)
      .map((message: any) => message.requestId), pane.paneId)).toEqual(paneCreateRequests)
    expect((await json(page, '/api/terminals'))
      .filter((item: any) => item.cwd === pane.cwd)
      .map((item: any) => item.terminalId)
      .sort()).toEqual(terminalIdsBeforeReconnect)
  })
}
