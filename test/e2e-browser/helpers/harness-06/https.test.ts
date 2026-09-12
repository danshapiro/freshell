import { describe, it, expect, afterEach } from 'vitest'
import tls from 'node:tls'
import { X509Certificate, createHash } from 'node:crypto'
import {
  loadTestTlsAssets,
  startHttpsTarget,
  fetchWithCa,
  type HttpsTarget,
} from './https.js'
import type { TargetServer } from './target-server.js'

/**
 * HARNESS-06 trusted-HTTPS coverage: the committed test CA + leaf assets
 * (fixtures/tls/, marked DO NOT TRUST), an https target boot helper, and the
 * no-CA rejects, and the unrelated self-signed "untrusted" cert rejects even
 * with the CA pinned.
 */

const targets: Array<HttpsTarget | TargetServer> = []
async function boot(kind: 'trusted' | 'untrusted') {
  const t = await startHttpsTarget(kind)
  targets.push(t)
  return t
}
afterEach(async () => {
  while (targets.length) await targets.pop()!.stop()
})

describe('harness-06 https: committed TLS assets', () => {
  it('loads a test CA, a localhost leaf signed by it, and an unrelated self-signed cert', () => {
    const assets = loadTestTlsAssets()
    const ca = new X509Certificate(assets.caCert)
    const leaf = new X509Certificate(assets.server.cert)
    const untrusted = new X509Certificate(assets.untrusted.cert)

    expect(ca.subject).toContain('Freshell E2E Test CA')
    expect(ca.ca).toBe(true) // basicConstraints CA:TRUE
    expect(leaf.subject).toContain('localhost')
    expect(leaf.ca).toBe(false)
    expect(leaf.issuer).toBe(ca.subject)
    expect(leaf.checkIssued(ca)).toBe(true)
    // SANs cover both loopback names later lanes pass through.
    expect(leaf.subjectAltName).toContain('DNS:localhost')
    expect(leaf.subjectAltName).toContain('IP Address:127.0.0.1')
    expect(leaf.subjectAltName).toContain('IP Address:0:0:0:0:0:0:0:1')
    // Long-lived (generated 2026, 100y validity) — fixture turd never expires mid-decade.
    expect(new Date(leaf.validTo).getFullYear()).toBeGreaterThanOrEqual(2100)
    expect(untrusted.issuer).toBe(untrusted.subject) // self-signed, unrelated to the CA
    expect(untrusted.subject).not.toBe(ca.subject)

    // SPKI pin format used by Chromium's --ignore-certificate-errors-spn-list.
    expect(assets.serverSpkiSha256B64).toMatch(/^[A-Za-z0-9+/]{43}=$/)
    const leafDer = new X509Certificate(assets.server.cert)
    const expected = createHash('sha256')
      .update(leafDer.publicKey.export({ format: 'der', type: 'spki' }))
      .digest('base64')
    expect(assets.serverSpkiSha256B64).toBe(expected)
  })
})

describe('harness-06 https: trust matrix', () => {
  it('trusted leaf + pinned CA serves the marker page over TLS', async () => {
    const assets = loadTestTlsAssets()
    const t = await boot('trusted')
    const res = await fetchWithCa(`${t.baseUrl}/page`, assets.caCert)
    expect(res.status).toBe(200)
    expect(res.body).toContain('id="fixture-marker"')
    // The handshake really presented our leaf (not some other TLS endpoint).
    const peer = res.peerCertificates
    expect(new X509Certificate(peer).subject).toContain('localhost')
  })

  it('WITHOUT the CA the same leaf fails verification (untrusted by default)', async () => {
    const t = await boot('trusted')
    await expect(fetchWithCa(`${t.baseUrl}/page`)).rejects.toMatchObject({
      code: expect.stringMatching(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_GET_ISSUER_CERT/),
    })
  })

  it('the unrelated self-signed leaf rejects even WITH the fixture CA pinned', async () => {
    const assets = loadTestTlsAssets()
    const t = await boot('untrusted')
    await expect(fetchWithCa(`${t.baseUrl}/page`, assets.caCert)).rejects.toMatchObject({
      code: expect.stringMatching(/SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/),
    })
    await expect(fetchWithCa(`${t.baseUrl}/page`)).rejects.toThrow()
  })

  it('raw TLS handshake against the trusted target yields an authorized peer with the CA', async () => {
    const assets = loadTestTlsAssets()
    const t = await boot('trusted')
    const info = await new Promise<{ authorized: boolean; cn: string }>((resolve, reject) => {
      const sock = tls.connect(
        { host: '127.0.0.1', port: t.port, ca: assets.caCert, servername: 'localhost' },
        () => {
          // getPeerCertificate().subject is a NULL-PROTOTYPE object on Node 22
          // ({CN:'localhost',...}): String() on it throws "Cannot convert
          // object to primitive value", which would escape this listener and
          // leave the promise unsettled. Extract CN defensively instead.
          const peer = sock.getPeerCertificate() as {
            subject?: string | { CN?: string }
          } | null
          const subject = peer?.subject
          const cn =
            typeof subject === 'string'
              ? subject
              : String(subject?.CN ?? '')
          const out = { authorized: sock.authorized, cn }
          sock.end()
          resolve(out)
        },
      )
      sock.once('error', reject)
    })
    expect(info.authorized).toBe(true)
    expect(info.cn).toContain('localhost')
  })
})
