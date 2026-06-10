import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import xtermPkg from '@xterm/xterm'

const { Terminal } = xtermPkg as unknown as { Terminal: typeof import('@xterm/xterm').Terminal }

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const artifactDir = path.resolve(repoRoot, 'docs/superpowers/proofs/artifacts')
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function dependencyVersion(packageName: string): Promise<string | null> {
  try {
    const packageJsonUrl = await import.meta.resolve(`${packageName}/package.json`)
    const parsed = JSON.parse(await fs.readFile(fileURLToPath(packageJsonUrl), 'utf8'))
    return parsed.version ?? null
  } catch {
    return null
  }
}

async function smallWriteOrder() {
  const term = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 })
  const events: Array<{ event: string; at: number; cursorX?: number; cursorY?: number }> = []
  const startedAt = performance.now()
  const mark = (event: string) => {
    events.push({
      event,
      at: Number((performance.now() - startedAt).toFixed(3)),
      cursorX: term.buffer.active.cursorX,
      cursorY: term.buffer.active.cursorY,
    })
  }
  term.write('alpha', () => mark('callback-alpha'))
  mark('after-write-alpha-returned')
  term.write('\nbeta', () => mark('callback-beta'))
  mark('after-write-beta-returned')
  await sleep(50)
  mark('after-50ms')
  term.dispose()
  return events
}

async function disposeAfterLargeWrite() {
  const term = new Terminal({ allowProposedApi: true, cols: 120, rows: 30 })
  const startedAt = performance.now()
  const events: Array<{ event: string; at: number; cursorX?: number; cursorY?: number }> = []
  const mark = (event: string) => {
    events.push({
      event,
      at: Number((performance.now() - startedAt).toFixed(3)),
      cursorX: term.buffer.active.cursorX,
      cursorY: term.buffer.active.cursorY,
    })
  }
  const data = `${'large-line-0123456789 '.repeat(16)}\n`.repeat(50_000)
  let callbackAfterDispose = false
  let disposed = false
  term.write(data, () => {
    callbackAfterDispose = disposed
    mark('large-write-callback')
  })
  mark('after-large-write-returned')
  term.dispose()
  disposed = true
  mark('after-dispose')
  await sleep(250)
  mark('after-250ms')
  return {
    events,
    callbackAfterDispose,
  }
}

async function disposeAfterQueuedWrites() {
  const term = new Terminal({ allowProposedApi: true, cols: 120, rows: 30 })
  const startedAt = performance.now()
  let disposed = false
  const callbacks: Array<{ index: number; at: number; afterDispose: boolean }> = []
  for (let i = 0; i < 500; i += 1) {
    term.write(`queued-${i}\n`, () => {
      callbacks.push({
        index: i,
        at: Number((performance.now() - startedAt).toFixed(3)),
        afterDispose: disposed,
      })
    })
  }
  const disposeAt = Number((performance.now() - startedAt).toFixed(3))
  term.dispose()
  disposed = true
  await sleep(250)
  return {
    disposeAt,
    callbackCount: callbacks.length,
    callbacksAfterDispose: callbacks.filter((callback) => callback.afterDispose).length,
    firstCallbacks: callbacks.slice(0, 10),
    lastCallbacks: callbacks.slice(-10),
    fifo: callbacks.every((callback, index) => callback.index === index),
  }
}

async function main() {
  await fs.mkdir(artifactDir, { recursive: true })
  const artifact = {
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    dependencies: {
      '@xterm/xterm': await dependencyVersion('@xterm/xterm'),
    },
    smallWriteOrder: await smallWriteOrder(),
    disposeAfterLargeWrite: await disposeAfterLargeWrite(),
    disposeAfterQueuedWrites: await disposeAfterQueuedWrites(),
  }

  const outPath = path.resolve(artifactDir, 'xterm-write-dispose.json')
  await fs.writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`)
  console.log(JSON.stringify({ outPath }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
