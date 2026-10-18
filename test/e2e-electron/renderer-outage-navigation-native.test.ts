import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureNativeWindowEvidence, readLinuxNativeProcess } from './native-process-evidence.js'
import { stopOwnedServerAndVerify, type OwnedServerStopObservation } from './owned-server-teardown.js'
import { observeOutageNavigation } from './renderer-outage-navigation.js'
import { cleanupElectronFixture, stopExactCapturedProcess } from './electron-fixture-cleanup.js'
import { isolatedElectronHomeEnv } from './fixture-home-env.js'

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))

test('outage fixture reaches native refusal with Freshell service worker and cached shell present', async ({}, testInfo) => {
  test.setTimeout(60_000)
  const deadline = Date.now() + 60_000
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-worker-outage-'))
  let app: ElectronApplication | undefined
  let main: ChildProcess | undefined
  let endpoint: ChildProcess | undefined
  const facts: Record<string, any> = {}
  const responses: Array<Record<string, unknown>> = []
  const bounded = async <T>(operation: Promise<T>, cap: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('worker outage fixture deadline')), Math.min(cap, Math.max(0, deadline - Date.now())))
      })])
    } finally { clearTimeout(timer) }
  }
  try {
    endpoint = fork(path.join(fixtures, 'worker-outage-server.cjs'), { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    const identity = process.platform === 'linux' ? readLinuxNativeProcess(endpoint.pid!) : undefined
    facts.endpointIdentity = identity ?? { pid: endpoint.pid }
    const [receipt] = await bounded(once(endpoint, 'message'), 5_000) as [{ pid: number; port: number }]
    expect(receipt.pid).toBe(endpoint.pid)
    const url = `http://127.0.0.1:${receipt.port}/`
    const env = Object.fromEntries(Object.entries(isolatedElectronHomeEnv(process.env, home))
      .filter((entry): entry is [string, string] => entry[1] !== undefined))
    app = await electron.launch({ args: [path.join(fixtures, 'worker-outage-main.cjs')],
      env, timeout: 10_000 })
    main = app.process()
    facts.electronPid = main.pid
    // Load before firstWindow: Playwright waits for a document on a new window.
    await bounded(app.evaluate(async ({ app, BrowserWindow }, url) => {
      await app.whenReady()
      await BrowserWindow.getAllWindows()[0].loadURL(url)
    }, url), 10_000)
    const page = await app.firstWindow({ timeout: 10_000 })
    const native = await app.browserWindow(page)
    try {
      facts.security = await captureNativeWindowEvidence(() => native.evaluate(window => {
        const preferences = window.webContents.getLastWebPreferences()
        return { id: window.id, webContentsId: window.webContents.id, mainPid: process.pid,
          rendererPid: window.webContents.getOSProcessId(), sandbox: preferences.sandbox,
          contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration }
      }), main.pid!)
      // Only this regression deliberately establishes the troublesome worker.
      // The actual outage case must not acquire a warm-load precondition.
      facts.worker = await bounded(page.evaluate(async () => {
        await navigator.serviceWorker.register('/sw.js')
        await navigator.serviceWorker.ready
        if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => {
          navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true })
        })
        const cached = await caches.match('/index.html')
        return { controller: new URL(navigator.serviceWorker.controller!.scriptURL).pathname,
          cacheNames: await caches.keys(), status: cached?.status, body: await cached?.text() }
      }), 10_000)
      expect(facts.worker).toMatchObject({ controller: '/sw.js', status: 200, body: expect.stringContaining('owned cached shell') })
      page.on('response', response => {
        if (response.request().isNavigationRequest()) responses.push({ status: response.status(),
          fromServiceWorker: response.fromServiceWorker(), path: new URL(response.url()).pathname })
      })
      const stopObservation: OwnedServerStopObservation = { ...receipt, host: '127.0.0.1' }
      const failure = await observeOutageNavigation({ native, url, deadline, stopObservation,
        stop: async () => {
          if (identity) expect(readLinuxNativeProcess(receipt.pid).startTicks).toBe(identity.startTicks)
          await stopOwnedServerAndVerify({ stop: async () => {
            const exited = once(endpoint!, 'exit')
            expect(endpoint!.kill('SIGTERM')).toBe(true)
            await bounded(exited, 5_000)
          } }, receipt, undefined, stopObservation)
        },
        attach: async observation => { facts.outage = observation },
      })
      expect(failure).toEqual({ code: 'ERR_CONNECTION_REFUSED', errno: -102 })
      expect(facts.outage.afterNavigation.target).toMatchObject({
        windowId: facts.security.native.id, webContentsId: facts.security.native.webContentsId,
      })
      expect(stopObservation).toMatchObject({ stop: 'fulfilled', pidGone: true, portBindable: true })
      expect(facts.outage.tcp).toMatchObject({ state: 'refused', code: 'ECONNREFUSED' })
    } finally {
      facts.responses = responses
      // Renderer state is already retained by the helper's bounded diagnostics.
      await native.dispose()
    }
  } finally {
    try {
      await cleanupElectronFixture({ app, electronProcess: main,
        gracefulCloseTimeoutMs: 5_000, forceCloseTimeoutMs: 2_000,
        stopServer: async () => {
          if (endpoint) await stopExactCapturedProcess(endpoint, 2_000,
            ms => new Promise(resolve => setTimeout(resolve, ms)))
        },
        removeHome: async () => { fs.rmSync(home, { recursive: true, force: true }) },
      })
    } finally {
      facts.cleanup = { endpointExitCode: endpoint?.exitCode, endpointSignal: endpoint?.signalCode,
        electronExitCode: main?.exitCode, electronSignal: main?.signalCode,
        homeAbsent: !fs.existsSync(home) }
      // Attachment failure cannot prevent exact owned process/HOME cleanup.
      await testInfo.attach('worker-outage', { body: JSON.stringify(facts), contentType: 'application/json' })
    }
  }
})
