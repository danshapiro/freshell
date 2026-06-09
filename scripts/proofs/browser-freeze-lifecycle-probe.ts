import fs from 'fs/promises'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { chromium } from '@playwright/test'
import { WebSocketServer } from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const artifactDir = path.resolve(repoRoot, 'docs/superpowers/proofs/artifacts')

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Snapshot = {
  at: number
  visibilityState: string
  intervalTicks: number
  rafTicks: number
  wsReceived: number
  lastIntervalAt: number
  lastRafAt: number
  lastWsAt: number
}

function delta(a: Snapshot, b: Snapshot) {
  return {
    elapsedMs: b.at - a.at,
    intervalTicks: b.intervalTicks - a.intervalTicks,
    rafTicks: b.rafTicks - a.rafTicks,
    wsReceived: b.wsReceived - a.wsReceived,
  }
}

async function main() {
  await fs.mkdir(artifactDir, { recursive: true })

  let serverSent = 0
  const httpServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  const wss = new WebSocketServer({ server: httpServer })
  const sendTimer = setInterval(() => {
    serverSent += 1
    const payload = JSON.stringify({ n: serverSent, at: Date.now() })
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(payload)
    }
  }, 50)

  const port = await new Promise<number>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address()
      if (!address || typeof address === 'string') throw new Error('No listen port')
      resolve(address.port)
    })
  })

  const headed = process.env.FRESHELL_PROOF_HEADED_BROWSER === '1'
  const browser = await chromium.launch({ headless: !headed })
  const page = await browser.newPage()
  const cdp = await page.context().newCDPSession(page)
  const wsUrl = `ws://127.0.0.1:${port}`
  const html = `<!doctype html>
<html>
<body>
<script>
  const counters = {
    startedAt: performance.now(),
    intervalTicks: 0,
    rafTicks: 0,
    wsReceived: 0,
    lastIntervalAt: 0,
    lastRafAt: 0,
    lastWsAt: 0,
  };
  setInterval(() => {
    counters.intervalTicks += 1;
    counters.lastIntervalAt = performance.now();
  }, 50);
  function onRaf() {
    counters.rafTicks += 1;
    counters.lastRafAt = performance.now();
    requestAnimationFrame(onRaf);
  }
  requestAnimationFrame(onRaf);
  const ws = new WebSocket(${JSON.stringify(wsUrl)});
  ws.onmessage = () => {
    counters.wsReceived += 1;
    counters.lastWsAt = performance.now();
  };
  window.__snapshot = () => ({
    at: performance.now(),
    visibilityState: document.visibilityState,
    intervalTicks: counters.intervalTicks,
    rafTicks: counters.rafTicks,
    wsReceived: counters.wsReceived,
    lastIntervalAt: counters.lastIntervalAt,
    lastRafAt: counters.lastRafAt,
    lastWsAt: counters.lastWsAt,
  });
  window.__wsReady = new Promise((resolve) => {
    ws.onopen = () => resolve(true);
  });
</script>
</body>
</html>`

  try {
    await page.goto(`data:text/html,${encodeURIComponent(html)}`)
    await page.evaluate(() => (window as any).__wsReady)
    await sleep(1000)
    const activeA = await page.evaluate(() => (window as any).__snapshot()) as Snapshot
    const serverSentAtActiveA = serverSent
    await sleep(1000)
    const activeB = await page.evaluate(() => (window as any).__snapshot()) as Snapshot
    const serverSentAtActiveB = serverSent

    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' })
    const freezeStart = Date.now()
    const frozenA = activeB
    const serverSentAtFreezeStart = serverSent
    await sleep(2000)
    const serverSentAtFreezeEnd = serverSent

    let frozenEvalStatus: 'returned' | 'timed_out' | 'error' = 'timed_out'
    let frozenEvalSnapshot: Snapshot | null = null
    let frozenEvalError: string | undefined
    try {
      const evaluated = await Promise.race([
        cdp.send('Runtime.evaluate', {
          expression: 'window.__snapshot()',
          returnByValue: true,
        }),
        sleep(1000).then(() => null),
      ])
      if (evaluated) {
        frozenEvalStatus = 'returned'
        frozenEvalSnapshot = (evaluated as any).result.value as Snapshot
      }
    } catch (error) {
      frozenEvalStatus = 'error'
      frozenEvalError = error instanceof Error ? error.message : String(error)
    }

    await cdp.send('Page.setWebLifecycleState', { state: 'active' })
    const resumedImmediate = await page.evaluate(() => (window as any).__snapshot()) as Snapshot
    const serverSentAtResumeImmediate = serverSent
    await sleep(1000)
    const resumedB = await page.evaluate(() => (window as any).__snapshot()) as Snapshot
    const serverSentAtResumeB = serverSent

    const artifact = {
      generatedAt: new Date().toISOString(),
      chromiumVersion: browser.version(),
      headed,
      wsSendIntervalMs: 50,
      active: {
        before: activeA,
        after: activeB,
        pageDelta: delta(activeA, activeB),
        serverSentDelta: serverSentAtActiveB - serverSentAtActiveA,
      },
      frozen: {
        stateCommand: "Page.setWebLifecycleState({ state: 'frozen' })",
        durationMs: Date.now() - freezeStart,
        before: frozenA,
        evalStatus: frozenEvalStatus,
        evalSnapshot: frozenEvalSnapshot,
        evalError: frozenEvalError,
        pageDeltaIfEvalReturned: frozenEvalSnapshot ? delta(frozenA, frozenEvalSnapshot) : null,
        serverSentDelta: serverSentAtFreezeEnd - serverSentAtFreezeStart,
      },
      resumed: {
        immediate: resumedImmediate,
        after: resumedB,
        immediateDeltaFromFreezeStart: delta(frozenA, resumedImmediate),
        pageDeltaAfterResume: delta(resumedImmediate, resumedB),
        serverSentDeltaImmediate: serverSentAtResumeImmediate - serverSentAtFreezeStart,
        serverSentDeltaAfterResume: serverSentAtResumeB - serverSentAtResumeImmediate,
      },
    }

    const outPath = path.resolve(artifactDir, 'browser-freeze-lifecycle.json')
    await fs.writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`)
    console.log(JSON.stringify({ outPath }, null, 2))
  } finally {
    await browser.close().catch(() => undefined)
    clearInterval(sendTimer)
    await new Promise<void>((resolve) => wss.close(() => resolve()))
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
