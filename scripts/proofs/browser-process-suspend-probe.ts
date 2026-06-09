import fs from 'fs/promises'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'
import { chromium } from '@playwright/test'
import { WebSocketServer } from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const artifactDir = path.resolve(repoRoot, 'docs/superpowers/proofs/artifacts')
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Snapshot = {
  at: number
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

function chromiumProcessTree(rootPid: number): number[] {
  const output = execFileSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
  const children = new Map<number, number[]>()
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) continue
    const pid = Number(match[1])
    const ppid = Number(match[2])
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid)?.push(pid)
  }

  const tree: number[] = []
  const visit = (pid: number) => {
    tree.push(pid)
    for (const child of children.get(pid) ?? []) visit(child)
  }
  visit(rootPid)
  return tree
}

function signalPids(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {
      // Process may have exited during shutdown.
    }
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

  const browserServer = await chromium.launchServer({ headless: true })
  const browserProcess = browserServer.process()
  if (!browserProcess?.pid) throw new Error('Browser process pid unavailable')
  const browser = await chromium.connect(browserServer.wsEndpoint())
  const page = await browser.newPage()
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
    const serverSentActiveA = serverSent
    await sleep(1000)
    const activeB = await page.evaluate(() => (window as any).__snapshot()) as Snapshot
    const serverSentActiveB = serverSent

    const stoppedBefore = activeB
    const pidsToStop = chromiumProcessTree(browserProcess.pid)
    const serverSentStopStart = serverSent
    const stopStartedAt = Date.now()
    signalPids([...pidsToStop].sort((a, b) => b - a), 'SIGSTOP')
    await sleep(2000)
    const serverSentStopEnd = serverSent
    signalPids([...pidsToStop].sort((a, b) => a - b), 'SIGCONT')
    const stopEndedAt = Date.now()
    const resumedImmediate = await page.evaluate(() => (window as any).__snapshot()) as Snapshot
    const serverSentResumeImmediate = serverSent
    await sleep(1000)
    const resumedAfter = await page.evaluate(() => (window as any).__snapshot()) as Snapshot
    const serverSentResumeAfter = serverSent

    const artifact = {
      generatedAt: new Date().toISOString(),
      chromiumVersion: browser.version(),
      browserPid: browserProcess.pid,
      wsSendIntervalMs: 50,
      active: {
        before: activeA,
        after: activeB,
        pageDelta: delta(activeA, activeB),
        serverSentDelta: serverSentActiveB - serverSentActiveA,
      },
      stopped: {
        signal: 'SIGSTOP',
        stoppedPids: pidsToStop,
        durationMs: stopEndedAt - stopStartedAt,
        before: stoppedBefore,
        afterResumeImmediate: resumedImmediate,
        pageDeltaAfterResumeImmediate: delta(stoppedBefore, resumedImmediate),
        serverSentWhileStopped: serverSentStopEnd - serverSentStopStart,
        serverSentByResumeImmediate: serverSentResumeImmediate - serverSentStopStart,
      },
      resumed: {
        after: resumedAfter,
        pageDeltaAfterResume: delta(resumedImmediate, resumedAfter),
        serverSentDeltaAfterResume: serverSentResumeAfter - serverSentResumeImmediate,
      },
    }

    const outPath = path.resolve(artifactDir, 'browser-process-suspend.json')
    await fs.writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`)
    console.log(JSON.stringify({ outPath }, null, 2))
  } finally {
    await browser.close().catch(() => undefined)
    await browserServer.close().catch(() => undefined)
    clearInterval(sendTimer)
    await new Promise<void>((resolve) => wss.close(() => resolve()))
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
