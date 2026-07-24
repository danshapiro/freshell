import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startExternalServer } from '../harness/external-server.js'
import { WsCaptureClient, type CapturedMessage } from '../harness/ws-capture-client.js'

/**
 * Generate/refresh the committed handshake transcript fixture used by the
 * oracle's DATA-LEVEL mutation-validation suite
 * (`test/unit/port/oracle/mutation-validation.test.ts`).
 *
 * Boots ONE isolated original server, captures the real connect handshake
 * (hello -> ready -> settings.updated -> [perf.logging] -> terminal.inventory),
 * and writes a static snapshot to `handshake-transcript.json`. That snapshot is
 * the representative "known-good" data the mutation suite corrupts to prove the
 * oracle's contract-validator + normalization/diff actually DETECT divergence.
 *
 * The fixture is a SNAPSHOT (it carries this boot's ids/timestamps/token/paths);
 * the mutation suite normalizes it, so those run-specific values are canonical.
 *
 * Usage:  npx tsx port/oracle/fixtures/generate-handshake-fixture.ts
 *
 * SAFETY: spawns its own server on an ephemeral loopback port and reaps it; never
 * touches the user's live :3001 / pid 1262455.
 */

const __filename = fileURLToPath(import.meta.url)
const FIXTURE_DIR = path.dirname(__filename)
const FIXTURE_PATH = path.join(FIXTURE_DIR, 'handshake-transcript.json')

/** Strip the per-capture `tMs` (wall-clock-ish ordering aid) so the fixture is diff-stable. */
function toFixtureEntry(m: CapturedMessage): Omit<CapturedMessage, 'tMs'> {
  return { dir: m.dir, type: m.type, raw: m.raw, parsed: m.parsed }
}

async function main(): Promise<void> {
  const server = await startExternalServer({ provider: 'oracle-handshake-fixture' })
  let transcript: CapturedMessage[] = []
  const client = new WsCaptureClient(server.wsUrl, server.token)
  try {
    await client.connect()
    transcript = await client.captureHandshake(60_000)
  } finally {
    await client.close().catch(() => {})
    await server.stop().catch(() => {})
  }

  const serverMessages = transcript.filter((m) => m.dir === 'in')
  const fixture = {
    note:
      'Representative handshake snapshot for the oracle DATA-LEVEL mutation suite. ' +
      'Captured once from the ORIGINAL node server via port/oracle/harness. ' +
      'Regenerate with: npx tsx port/oracle/fixtures/generate-handshake-fixture.ts',
    capturedAt: new Date().toISOString(),
    wsProtocolVersion: undefined as number | undefined,
    serverMessageTypes: serverMessages.map((m) => m.type),
    transcript: transcript.map(toFixtureEntry),
  }

  // Record the protocol version the client negotiated (from the outbound hello).
  const hello = transcript.find((m) => m.dir === 'out' && m.type === 'hello')
  if (hello && hello.parsed && typeof hello.parsed === 'object') {
    const pv = (hello.parsed as Record<string, unknown>).protocolVersion
    if (typeof pv === 'number') fixture.wsProtocolVersion = pv
  }

  await fsp.writeFile(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + '\n', 'utf8')
  // eslint-disable-next-line no-console
  console.log(
    `Wrote ${FIXTURE_PATH}\n  server->client types: ${JSON.stringify(fixture.serverMessageTypes)}\n` +
      `  total transcript messages: ${fixture.transcript.length} (server pid ${server.pid}, port ${server.port})`,
  )
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('handshake fixture generation failed:', err)
  process.exit(1)
})
