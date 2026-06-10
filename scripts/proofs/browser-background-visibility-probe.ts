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
  hidden: boolean
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
    visibilityStateBefore: a.visibilityState,
    visibilityStateAfter: b.visibilityState,
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
  const context = await browser.newContext()
  const page = await context.newPage()
  const coverPage = await context.newPage()
  const wsUrl = `ws://127.0.0.1:${port}`
  const html = `<!doctype html>
<html>
<body>
<script>
  const counters = {
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
    hidden: document.hidden,
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
    await coverPage.goto('data:text/html,<title>cover</title><body>cover</body>')
    await page.bringToFront()
    await page.evaluate(() => (window as any).__wsReady)

    await sleep(1000)
    const activeA = await page.evaluate(() => (window as any).__snapshot()) as Snapshot
    const serverSentActiveA = serverSent
    await sleep(1000)
    const activeB = await page.evaluate(() => (window as any).__snapshot()) as Snapshot
    const serverSentActiveB = serverSent

    await coverPage.bringToFront()
    await sleep(250)
    const hiddenA = await page.evaluate(() => (window as any).__snapshot()) as Snapshot
    const serverSentHiddenA = serverSent
    await sleep(3000)
    const hiddenB = await page.evaluate(() => (window as any).__snapshot()) as Snapshot
    const serverSentHiddenB = serverSent

    await page.bringToFront()
    await sleep(1000)
    const resumed = await page.evaluate(() => (window as any).__snapshot()) as Snapshot
    const serverSentResumed = serverSent

    const artifact = {
      generatedAt: new Date().toISOString(),
      chromiumVersion: browser.version(),
      headed,
      wsSendIntervalMs: 50,
      active: {
        before: activeA,
        after: activeB,
        pageDelta: delta(activeA, activeB),
        serverSentDelta: serverSentActiveB - serverSentActiveA,
      },
      backgrounded: {
        before: hiddenA,
        after: hiddenB,
        pageDelta: delta(hiddenA, hiddenB),
        serverSentDelta: serverSentHiddenB - serverSentHiddenA,
      },
      resumed: {
        after: resumed,
        pageDeltaFromHiddenEnd: delta(hiddenB, resumed),
        serverSentDelta: serverSentResumed - serverSentHiddenB,
      },
    }

    const outPath = path.resolve(artifactDir, 'browser-background-visibility.json')
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
