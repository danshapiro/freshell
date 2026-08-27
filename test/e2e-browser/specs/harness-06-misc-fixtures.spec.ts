import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from '../helpers/fixtures.js'
import {
  startTargetServer,
  type TargetServer,
} from '../helpers/harness-06/target-server.js'
import {
  createLocalFileTree,
  createShareTrees,
  uncPathFor,
  fileUrlFor,
  splitUncPath,
  splitFileUrl,
} from '../helpers/harness-06/file-trees.js'
import { createFakeEditor } from '../helpers/harness-06/fake-editor.js'
import {
  startFakeGemini,
  FAKE_GEMINI_DEFAULT_TEXT,
} from '../helpers/harness-06/fake-ai.js'
import {
  spawnFakeKilroy,
  readKilroyLedger,
} from '../helpers/harness-06/kilroy-runtime.js'
import {
  startUpdateFeed,
  minisignVerify,
} from '../helpers/harness-06/update-feed.js'
import {
  loadTestTlsAssets,
  startHttpsTarget,
  fetchWithCa,
} from '../helpers/harness-06/https.js'

/**
 * HARNESS-06 fixture smoke (retired matrix list-registered, server-kind-agnostic).
 *
 * Acceptance mirror (checklist Playwright validation text): a fixture smoke
 * that reaches every target directly, records editor/Kilroy invocations,
 * returns fixed AI output, downloads a harmless signed artifact, and verifies
 * the test certificate. (The disposable SMB share MOUNT leg is host-limited
 * to Windows; its Linux-doable scope — the share-tree builders + UNC/file-URL
 * mapping — is exercised here directly.)
 *
 * This spec requests ONLY Playwright's built-in page/browser fixtures; the
 * shared harness's `testServer` is worker-lazy, so NO Freshell server boots
 * (load-bearing ledger L1). It therefore runs identically under
 * `chromium`, `retired Node browser lane`, and `Rust browser lane`.
 *
 * Each named `test(...)` is one acceptance leg; per-leg observed outcomes are
 * recorded in docs/plans/df1-evidence/HARNESS-06.md.
 */

async function stopAll(targets: Array<{ stop: () => Promise<void> }>): Promise<void> {
  for (const t of [...targets].reverse()) await t.stop()
  targets.length = 0
}

test.describe('harness-06 misc fixtures smoke', () => {
  test('target server: real-browser marker page + echo ledger records exact upstream inputs', async ({ page }) => {
    const target = await startTargetServer()
    try {
      // Marker page leg (direct, through the real browser).
      await page.goto(`${target.baseUrl}/page?title=smoke-marker`)
      await expect(page.locator('#fixture-marker')).toBeVisible()
      await expect(page.locator('#fixture-marker')).toHaveAttribute('data-fixture', 'harness-06')
      await expect(page).toHaveTitle('smoke-marker')

      // Echo leg: the browser sends an exact request; the server records and
      // returns the EXACT upstream inputs (proxy lanes assert byte identity).
      const echoed = await page.evaluate(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/echo?b=2&a=1&b=3`, {
          method: 'POST',
          headers: { 'x-h06-probe': 'probe-value' },
          body: 'echo-body-ünïcodé',
        })
        return (await res.json()) as {
          method: string
          query: string
          bodyBase64: string
        }
      }, target.baseUrl)
      expect(echoed.method).toBe('POST')
      expect(echoed.query).toBe('b=2&a=1&b=3') // raw, un-normalized
      expect(Buffer.from(echoed.bodyBase64, 'base64').toString('utf8')).toBe('echo-body-ünïcodé')

      const httpEntry = target.ledger().find((e) => e.kind === 'http')
      expect(httpEntry).toBeTruthy()
      expect(httpEntry!.path).toBe('/echo')
      expect(String((httpEntry as { headers: Record<string, string | string[] | undefined> }).headers['x-h06-probe'])).toBe('probe-value')

      // Chunked stream leg: ordered chunks through the real browser.
      const stream = await page.evaluate(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/stream?chunks=3&delayMs=5`)
        return res.text()
      }, target.baseUrl)
      expect(stream).toBe('chunk-0/3\nchunk-1/3\nchunk-2/3\n')
    } finally {
      await target.stop()
    }
  })

  test('target server: hot-reload bump flips the rendered build marker (no manual reload)', async ({ page }) => {
    const target = await startTargetServer()
    try {
      await page.goto(`${target.baseUrl}/hot`)
      await expect(page.locator('#build-marker')).toHaveText('build 1')
      await expect(page.locator('#fixture-marker')).toBeVisible()

      // Deterministic race fix: the page's EventSource must be CONNECTED
      // before the bump, or the reload event is missed.
      await expect.poll(() => target.sseClientCount(), { timeout: 10_000 }).toBe(1)

      // In-process admin bump -> SSE -> the page reloads ITSELF.
      target.bumpBuild()
      await expect(page.locator('#build-marker')).toHaveText('build 2')
    } finally {
      await target.stop()
    }
  })

  test('target server: ws echo round-trips text+binary in the real browser; ledger records subprotocol+cookie', async ({ page, context }) => {
    const target = await startTargetServer()
    try {
      await context.addCookies([
        { name: 'h06-probe', value: 'cookie-value', url: target.baseUrl },
      ])
      await page.goto(`${target.baseUrl}/ws-page?subprotocol=freshell.test`)
      await expect(page.locator('#ws-log')).toHaveAttribute('data-state', 'open')
      // Log entries are located by their user-visible text (HARNESS-11
      // convention), not by the fixture's CSS classes.
      await expect(page.locator('#ws-log').getByText('open:freshell.test', { exact: true })).toBeVisible()

      // Text frame -> verbatim echo back into the DOM.
      await page.evaluate(() => {
        ;(window as unknown as { __fixtureWs: WebSocket }).__fixtureWs.send('hello-e2e ünï')
      })
      await expect(page.locator('#ws-log').getByText('text:hello-e2e ünï', { exact: true })).toBeVisible()

      // Binary frame -> echoed base64 into the DOM.
      const binaryB64 = Buffer.from([0x00, 0x01, 0xfe, 0xff]).toString('base64')
      await page.evaluate(() => {
        ;(window as unknown as { __fixtureWs: WebSocket }).__fixtureWs.send(new Uint8Array([0, 1, 0xfe, 0xff]))
      })
      await expect(page.locator('#ws-log').getByText(`bin:${binaryB64}`, { exact: true })).toBeVisible()

      // Server-side ledger: open (subprotocol + cookie verbatim) + both frames.
      const open = target.ledger().find((e) => e.kind === 'ws-open')
      expect(open).toBeTruthy()
      expect((open as { subprotocol: string }).subprotocol).toBe('freshell.test')
      expect(String((open as { headers: Record<string, string | string[] | undefined> }).headers.cookie)).toContain('h06-probe=cookie-value')
      const msgs = target.ledger().filter((e) => e.kind === 'ws-message')
      expect(msgs).toHaveLength(2)
      const textMsg = msgs.find((m) => !m.isBinary)
      const binMsg = msgs.find((m) => m.isBinary)
      expect(Buffer.from(textMsg!.bodyBase64!, 'base64').toString('utf8')).toBe('hello-e2e ünï')
      expect(Buffer.from(binMsg!.bodyBase64!, 'base64')).toEqual(Buffer.from([0x00, 0x01, 0xfe, 0xff]))
    } finally {
      await target.stop()
    }
  })

  test('target server: stop -> page load FAILS -> restart on SAME port -> reload succeeds', async ({ page }) => {
    let target: TargetServer = await startTargetServer()
    const port = target.port
    const url = `${target.baseUrl}/page?title=restart-leg`
    await page.goto(url)
    await expect(page.locator('#fixture-marker')).toBeVisible()
    await target.stop()

    // While stopped the browser CANNOT load the page (network refusal).
    await expect(page.goto(url, { timeout: 5000 }).catch((err: unknown) => err)).resolves.toBeTruthy()
    // A refused navigation makes Chromium navigate asynchronously to
    // chrome-error://chromewebdata/ AFTER the goto promise rejects. Wait for
    // that error-page navigation to settle, or it races (and interrupts) the
    // next goto to the revived origin.
    await page.waitForURL(/chrome-error/, { timeout: 5000 }).catch(() => undefined)

    // Restart on the SAME port; the previously-dead origin serves again.
    target = await startTargetServer({ port })
    try {
      expect(target.port).toBe(port)
      await page.goto(url)
      await expect(page.locator('#fixture-marker')).toBeVisible()
      await expect(page).toHaveTitle('restart-leg')
    } finally {
      await target.stop()
    }
  })

  test('file trees: local + share manifests hash-match on disk; UNC/file-URL mappings round-trip', () => {
    const local = createLocalFileTree()
    const shares = createShareTrees()
    try {
      // Manifest sha256/size entries match the bytes actually on disk.
      for (const tree of [local, ...shares.shares.values()]) {
        expect(Object.keys(tree.manifest).length).toBeGreaterThan(0)
        for (const [rel, entry] of Object.entries(tree.manifest)) {
          const bytes = fs.readFileSync(path.join(tree.root, ...rel.split('/')))
          expect(entry.size).toBe(bytes.length)
          expect(entry.sha256).toBe(crypto.createHash('sha256').update(bytes).digest('hex'))
        }
      }

      // The prefix-confusion pair: 'share' and 'share-evil' are siblings.
      const main = shares.shares.get('share')!
      const evil = shares.shares.get('share-evil')!
      expect(path.dirname(main.root)).toBe(path.dirname(evil.root))
      expect(path.basename(evil.root).startsWith(path.basename(main.root))).toBe(true)
      // ...and their contents differ (the FILE-02 distinguisher).
      expect(main.manifest).not.toEqual(evil.manifest)

      // UNC + file-URL mapping round-trips with spaces and Unicode segments.
      const segments = ['ünïçødé dir', 'grüße.txt']
      const unc = uncPathFor('TESTBOX', 'share', segments)
      expect(unc).toBe('\\\\TESTBOX\\share\\ünïçødé dir\\grüße.txt')
      expect(splitUncPath(unc)).toEqual({ server: 'TESTBOX', share: 'share', segments })
      const fileUrl = fileUrlFor('TESTBOX', 'share', segments)
      expect(fileUrl).toContain('file://TESTBOX/share/')
      expect(fileUrl).toContain(encodeURIComponent('ünïçødé dir'))
      expect(splitFileUrl(fileUrl)).toEqual({ server: 'TESTBOX', share: 'share', segments })
    } finally {
      local.cleanup()
      shares.cleanup()
    }
  })

  test('fake editor: invocation ledger records exact argv/cwd, knobs control exit', async () => {
    const editor = await createFakeEditor()
    try {
      const argv = ['+12:5', path.join(os.tmpdir(), 'ünï codé file name.txt')]
      // Default exit code 0: execFileSync returns normally (it throws otherwise).
      execFileSync(editor.editorPath, argv, {
        env: { ...process.env, FAKE_EDITOR_EXIT_CODE: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const invocations = await editor.readInvocations()
      expect(invocations).toHaveLength(1)
      expect(invocations[0].argv).toEqual(argv)
      expect(invocations[0].cwd).toBe(process.cwd())
      expect(invocations[0].pid).toBeGreaterThan(0)

      // Failure knob: the spawn failure simulation leg FILE-04 drives.
      expect(() =>
        execFileSync(editor.editorPath, ['locked.txt'], {
          env: { ...process.env, FAKE_EDITOR_EXIT_CODE: '42' },
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      ).toThrow()
      const after = await editor.readInvocations()
      expect(after).toHaveLength(2)
      expect(after[1].argv).toEqual(['locked.txt'])
    } finally {
      await editor.cleanup()
    }
  })

  test('fake Gemini: fixed output via the raw generateContent shape + request ledger', async () => {
    const ai = await startFakeGemini()
    try {
      const model = 'gemini-2.5-flash'
      const res = await fetch(`${ai.geminiBaseUrl}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': 'fixture-key' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'summarize this transcript' }] }] }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        candidates: Array<{ content: { parts: Array<{ text: string }> } }>
      }
      // The EXACT response path @ai-sdk/google@3.0.43's Zod schema validates.
      expect(body.candidates[0].content.parts[0].text).toBe(FAKE_GEMINI_DEFAULT_TEXT)

      const ledger = ai.ledger()
      expect(ledger).toHaveLength(1)
      expect(ledger[0].model).toBe(model)
      expect(ledger[0].apiKeyPresent).toBe(true)
      expect(ledger[0].promptText).toContain('summarize this transcript')
    } finally {
      await ai.stop()
    }
  })

  test('fake Kilroy runtime: create handshake + full success turn + request ledger', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-h06-smoke-kilroy-'))
    const logPath = path.join(dir, 'requests.jsonl')
    const rt = await spawnFakeKilroy({ FAKE_KILROY_LOG: logPath })
    try {
      rt.send({ type: 'create', requestId: 'smoke-1', cwd: '/tmp/smoke', model: 'claude-opus-4-6' })
      const created = (await rt.nextEvent('created')) as { requestId: string; sessionId: string }
      expect(created.requestId).toBe('smoke-1')
      const init = (await rt.nextEvent('sdk.session.init')) as { cliSessionId: string }
      expect(init.cliSessionId).toMatch(/^[0-9a-f-]{36}$/)
      await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')

      rt.send({ type: 'send', sessionId: created.sessionId, text: 'kilroy smoke turn' })
      await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'running')
      const assistant = (await rt.nextEvent('sdk.assistant')) as { content: Array<{ text?: string }> }
      expect(assistant.content[0].text).toContain('kilroy smoke turn')
      await rt.nextEvent('sdk.result', (e) => (e as { result?: string }).result === 'success')
      await rt.nextEvent('sdk.turn.complete')
      await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')

      // "Records Kilroy invocations": the JSONL ledger carries both requests.
      const ledger = await readKilroyLedger(logPath)
      expect(ledger.map((row) => (row.msg as { type: string }).type)).toEqual(['create', 'send'])
    } finally {
      await rt.kill()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('update feed: manifest + harmless signed artifact downloads and verifies; tamper rejects', async () => {
    const feeds: Array<{ stop: () => Promise<void> }> = []
    try {
      const feed = await startUpdateFeed({ version: '0.8.1' })
      feeds.push(feed)

      const res = await fetch(feed.manifestUrl)
      expect(res.status).toBe(200)
      const manifest = (await res.json()) as {
        version: string
        notes: string
        pub_date: string
        platforms: Record<string, { signature: string; url: string }>
      }
      expect(manifest.version).toBe('0.8.1')
      expect(manifest.platforms['linux-x86_64']).toBeTruthy()

      const entry = manifest.platforms['linux-x86_64']
      // Download the harmless signed artifact over HTTP...
      const download = await fetch(entry.url)
      expect(download.status).toBe(200)
      const bytes = Buffer.from(await download.arrayBuffer())
      expect(bytes.equals(feed.artifactBytes)).toBe(true)
      // ...and verify its minisign signature (manifest `signature` = base64 .sig TEXT).
      const sigText = Buffer.from(entry.signature, 'base64').toString('utf8')
      await expect(minisignVerify(feed.keypair.tauriPubkeyConfig, sigText, bytes)).resolves.toBe(true)

      // Negative leg: a tampered artifact MUST fail verification.
      const tampered = await startUpdateFeed({ version: '0.8.2', tamperArtifact: true })
      feeds.push(tampered)
      const tManifest = (await (await fetch(tampered.manifestUrl)).json()) as typeof manifest
      const tEntry = tManifest.platforms['linux-x86_64']
      const tBytes = Buffer.from(await (await fetch(tEntry.url)).arrayBuffer())
      const tSigText = Buffer.from(tEntry.signature, 'base64').toString('utf8')
      await expect(minisignVerify(tampered.keypair.tauriPubkeyConfig, tSigText, tBytes)).resolves.toBe(false)
    } finally {
      await stopAll(feeds)
    }
  })

  test('https: committed test certificate verified (trusted-with-CA green, no-CA/untrusted red)', async () => {
    const assets = loadTestTlsAssets()
    const targets: Array<{ stop: () => Promise<void> }> = []
    try {
      const trusted = await startHttpsTarget('trusted')
      targets.push(trusted)

      // Trusted leg: pinned fixture CA verifies the leaf and serves the marker.
      const ok = await fetchWithCa(`${trusted.baseUrl}/page`, assets.caCert)
      expect(ok.status).toBe(200)
      expect(ok.body).toContain('id="fixture-marker"')

      // Red leg 1: WITHOUT the CA the same leaf fails the default trust store.
      await expect(fetchWithCa(`${trusted.baseUrl}/page`)).rejects.toThrow()

      // Red leg 2: the UNRELATED self-signed cert rejects even with the CA pinned.
      const untrusted = await startHttpsTarget('untrusted')
      targets.push(untrusted)
      await expect(fetchWithCa(`${untrusted.baseUrl}/page`, assets.caCert)).rejects.toThrow()

      // Browser-shaped pinning artifact: the SPKI sha256 Chromium expects.
      expect(assets.serverSpkiSha256B64).toMatch(/^[A-Za-z0-9+/]{43}=$/)
    } finally {
      await stopAll(targets)
    }
  })
})
