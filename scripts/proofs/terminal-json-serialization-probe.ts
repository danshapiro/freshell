import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const artifactDir = path.resolve(repoRoot, 'docs/superpowers/proofs/artifacts')

function repeatToBytes(unit: string, targetBytes: number): string {
  let out = ''
  while (Buffer.byteLength(out, 'utf8') < targetBytes) out += unit
  while (Buffer.byteLength(out, 'utf8') > targetBytes) out = out.slice(0, -1)
  return out
}

function measure(name: string, data: string) {
  const message = {
    type: 'terminal.output',
    terminalId: 'term-proof',
    seqStart: 1,
    seqEnd: 1,
    attachRequestId: 'attach-proof',
    data,
  }
  const serialized = JSON.stringify(message)
  const rawBytes = Buffer.byteLength(data, 'utf8')
  const serializedBytes = Buffer.byteLength(serialized, 'utf8')
  return {
    name,
    rawBytes,
    serializedBytes,
    jsonOverheadBytes: serializedBytes - rawBytes,
    expansionRatio: Number((serializedBytes / rawBytes).toFixed(3)),
  }
}

async function main() {
  await fs.mkdir(artifactDir, { recursive: true })
  const target = 16 * 1024
  const samples = [
    measure('plain-ascii', repeatToBytes('a', target)),
    measure('ansi-sgr-repeat', repeatToBytes('\u001b[32mok\u001b[0m ', target)),
    measure('esc-only-control', repeatToBytes('\u001b', target)),
    measure('newline-heavy', repeatToBytes('x\n', target)),
    measure('quote-heavy', repeatToBytes('"', target)),
    measure('backslash-heavy', repeatToBytes('\\', target)),
  ]

  const artifact = {
    generatedAt: new Date().toISOString(),
    targetRawBytes: target,
    samples,
  }
  const outPath = path.resolve(artifactDir, 'terminal-json-serialization.json')
  await fs.writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`)
  console.log(JSON.stringify({ outPath }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
