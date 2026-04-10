import http from 'node:http'
import net from 'node:net'
import { URL } from 'node:url'
import { Router } from 'express'
import { logger } from './logger.js'
import { timingSafeCompare } from './auth.js'
import type { PortForwardManager } from './port-forward.js'
import { getRequesterIdentity } from './request-ip.js'

const log = logger.child({ component: 'proxy-router' })

/**
 * Headers that prevent iframe embedding. The HTTP reverse proxy strips these
 * so that proxied localhost content renders inside Freshell's browser pane
 * iframe. Without this, dev servers that send X-Frame-Options or CSP
 * frame-ancestors directives cause the browser to block the iframe content,
 * which in turn makes the MCP screenshot tool fall back to a placeholder.
 */
const IFRAME_BLOCKED_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
])

function stripIframeBlockingHeaders(
  headers: http.IncomingHttpHeaders,
): http.IncomingHttpHeaders {
  const cleaned: http.IncomingHttpHeaders = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!IFRAME_BLOCKED_HEADERS.has(key.toLowerCase())) {
      cleaned[key] = value
    }
  }
  return cleaned
}

export interface ProxyRouterDeps {
  portForwardManager: PortForwardManager
}

export function createProxyRouter(deps: ProxyRouterDeps): Router {
  const { portForwardManager } = deps
  const router = Router()

  router.post('/forward', async (req, res) => {
    const { port: targetPort } = req.body || {}

    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      return res.status(400).json({ error: 'Invalid port number' })
    }

    try {
      const requester = getRequesterIdentity(req)
      const result = await portForwardManager.forward(targetPort, requester)
      res.json({ forwardedPort: result.port })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err, targetPort }, 'Port forward failed')
      res.status(500).json({ error: `Failed to create port forward: ${msg}` })
    }
  })

  router.delete('/forward/:port', async (req, res) => {
    const targetPort = parseInt(req.params.port, 10)
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      return res.status(400).json({ error: 'Invalid port number' })
    }
    try {
      const requester = getRequesterIdentity(req)
      await portForwardManager.close(targetPort, requester.key)
      res.json({ ok: true })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err, targetPort }, 'Port forward close failed')
      res.status(500).json({ error: `Failed to close port forward: ${msg}` })
    }
  })

  // HTTP reverse proxy for localhost URLs.
  // Routes requests through Freshell's own port, avoiding WSL2/Docker
  // networking issues where the browser can't reach localhost ports directly.
  // Uses router.use so Express strips the matched prefix — req.url becomes
  // the target path+query (e.g. /index.html?v=1).
  router.use('/http/:port', (req, res) => {
    const targetPort = parseInt(req.params.port, 10)
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      return res.status(400).json({ error: 'Invalid port number' })
    }

    const headers: Record<string, string | string[] | undefined> = { ...req.headers }
    headers.host = `127.0.0.1:${targetPort}`
    delete headers['transfer-encoding']
    delete headers['connection']

    const proxyReq = http.request(
      {
        hostname: '127.0.0.1',
        port: targetPort,
        path: req.url || '/',
        method: req.method,
        headers,
      },
      (proxyRes) => {
        const strippedHeaders = stripIframeBlockingHeaders(proxyRes.headers)
        res.writeHead(proxyRes.statusCode ?? 502, strippedHeaders)
        proxyRes.pipe(res)
      },
    )

    proxyReq.on('error', (err) => {
      log.warn({ err, targetPort, path: req.url }, 'HTTP proxy connection failed')
      if (!res.headersSent) {
        res.status(502).json({ error: `Failed to connect to localhost:${targetPort}` })
      }
    })

    // If Express body-parsing middleware already consumed the stream,
    // re-serialize and write manually. Otherwise pipe the raw stream.
    if (req.readable) {
      req.pipe(proxyReq)
    } else if (req.body != null && Object.keys(req.body).length > 0) {
      const bodyStr = JSON.stringify(req.body)
      proxyReq.setHeader('content-type', 'application/json')
      proxyReq.setHeader('content-length', Buffer.byteLength(bodyStr))
      proxyReq.end(bodyStr)
    } else {
      proxyReq.end()
    }
  })

  return router
}

const PROXY_PATH_RE = /^\/api\/proxy\/http\/(\d+)(\/.*)?$/

/**
 * Attach a WebSocket upgrade handler to the HTTP server.
 *
 * Intercepts upgrade requests whose URL matches /api/proxy/http/:port/...
 * and pipes the raw TCP socket to the target localhost port. Non-matching
 * upgrade requests are destroyed (they belong to other handlers like the
 * main freshell WebSocket).
 */
export function attachProxyUpgradeHandler(server: http.Server): void {
  // Prepend our handler so it runs before any existing upgrade listeners
  // (e.g. the main freshell WS handler). We only handle proxy paths and
  // let everything else fall through.
  const existingListeners = server.listeners('upgrade') as Array<(...args: any[]) => void>
  server.removeAllListeners('upgrade')

  server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const url = req.url ?? ''
    const match = PROXY_PATH_RE.exec(url)

    if (!match) {
      // Not a proxy path — delegate to existing upgrade handlers
      for (const listener of existingListeners) {
        listener(req, socket, head)
      }
      return
    }

    const targetPort = parseInt(match[1], 10)
    if (targetPort < 1 || targetPort > 65535) {
      socket.destroy()
      return
    }

    // Authenticate via cookie (iframes can't set custom headers for WS)
    const token = process.env.AUTH_TOKEN
    if (token) {
      const cookieHeader = req.headers.cookie ?? ''
      const cookies = Object.fromEntries(
        cookieHeader.split(';').map((c) => {
          const [k, ...v] = c.trim().split('=')
          return [k, v.join('=')]
        }),
      )
      const provided = cookies['freshell-auth']
      if (!provided || !timingSafeCompare(provided, token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
    }

    const targetPath = match[2] || '/'

    // Connect to the target and relay the upgrade handshake
    const proxySocket = net.connect(targetPort, '127.0.0.1', () => {
      // Reconstruct the HTTP upgrade request for the target
      const reqLine = `${req.method} ${targetPath} HTTP/1.1\r\n`
      const headers = Object.entries(req.headers)
        .filter(([k]) => k !== 'host')
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .concat([`host: 127.0.0.1:${targetPort}`])
        .join('\r\n')

      proxySocket.write(reqLine + headers + '\r\n\r\n')
      if (head.length > 0) proxySocket.write(head)

      // Bidirectional pipe
      proxySocket.pipe(socket)
      socket.pipe(proxySocket)
    })

    proxySocket.on('error', (err) => {
      log.warn({ err, targetPort, path: targetPath }, 'WebSocket proxy connection failed')
      if (socket.writable) {
        socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\nExtension server on port ' + targetPort + ' is unavailable\r\n')
      }
      socket.destroy()
    })

    socket.on('error', () => {
      proxySocket.destroy()
    })
  })
}
