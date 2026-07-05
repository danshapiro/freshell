import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-version.js'

/**
 * WebSocket capture client for the equivalence oracle.
 *
 * Adapted from `test/helpers/visible-first/protocol-harness.ts`, but pointed at
 * an EXTERNAL server url + token (no in-process `http.createServer`/`WsHandler`).
 * It records BOTH directions as a single ordered transcript so the oracle can
 * replay/compare original-vs-port wire behaviour byte-for-byte.
 *
 * Do NOT import server internals here — the whole point of the external harness
 * is that capture is transport-only and works identically against the node
 * original and the future Rust port.
 */

export type Direction = 'in' | 'out'

export interface CapturedMessage {
  /** 'in' = server→client, 'out' = client→server. */
  dir: Direction
  /** The `type` discriminant, if the payload is an object with a string type. */
  type: string | undefined
  /** Exact wire bytes as a UTF-8 string. */
  raw: string
  /** JSON.parse(raw), or `{ __unparseable: true, raw }` if parsing failed. */
  parsed: unknown
  /** Milliseconds since this client was constructed (monotonic-ish ordering aid). */
  tMs: number
}

export interface WsCaptureClientOptions {
  /** Protocol version sent in `hello` (defaults to the frozen WS_PROTOCOL_VERSION). */
  protocolVersion?: number
  /** Timeout for the WS `open` event (default 15s). */
  openTimeoutMs?: number
}

const DEFAULT_WAIT_MS = 15_000

export class WsCaptureClient {
  private ws: WebSocket | null = null
  private readonly transcript: CapturedMessage[] = []
  private readonly startedAt = Date.now()
  private readonly protocolVersion: number
  private readonly openTimeoutMs: number
  private helloSent = false

  constructor(
    private readonly url: string,
    private readonly token: string,
    options: WsCaptureClientOptions = {},
  ) {
    this.protocolVersion = options.protocolVersion ?? WS_PROTOCOL_VERSION
    this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_WAIT_MS
  }

  private now(): number {
    return Date.now() - this.startedAt
  }

  private record(dir: Direction, raw: string, parsed: unknown): void {
    const type =
      parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string'
        ? (parsed as { type: string }).type
        : undefined
    this.transcript.push({ dir, type, raw, parsed, tMs: this.now() })
  }

  /** Open the WebSocket and start recording inbound messages. */
  async connect(): Promise<void> {
    if (this.ws) throw new Error('WsCaptureClient already connected')
    const ws = new WebSocket(this.url)
    this.ws = ws

    // Registered first so inbound messages are always in the transcript before
    // any waitFor predicate runs (listeners fire in registration order).
    ws.on('message', (data: WebSocket.RawData) => {
      const raw = typeof data === 'string' ? data : data.toString()
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = { __unparseable: true, raw }
      }
      this.record('in', raw, parsed)
    })

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out opening WebSocket ${this.url} after ${this.openTimeoutMs}ms`)),
        this.openTimeoutMs,
      )
      ws.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      ws.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  /** Send an arbitrary client→server message (recorded as an outbound entry). */
  send(message: unknown): void {
    if (!this.ws) throw new Error('WsCaptureClient not connected')
    const raw = JSON.stringify(message)
    this.record('out', raw, message)
    this.ws.send(raw)
  }

  /** Send the `hello` handshake message with the configured token + protocol version. */
  sendHello(overrides: Record<string, unknown> = {}): void {
    this.send({ type: 'hello', token: this.token, protocolVersion: this.protocolVersion, ...overrides })
    this.helloSent = true
  }

  /** Send a `ping` (server replies with `pong` — a cheap liveness probe). */
  ping(): void {
    this.send({ type: 'ping' })
  }

  private waitFor(
    predicate: (m: CapturedMessage) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<CapturedMessage> {
    const existing = this.transcript.find(predicate)
    if (existing) return Promise.resolve(existing)

    const ws = this.ws
    if (!ws) return Promise.reject(new Error('WsCaptureClient not connected'))

    return new Promise<CapturedMessage>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        ws.off('message', onMessage)
        ws.off('close', onClose)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`))
      }, timeoutMs)
      const onMessage = () => {
        const hit = this.transcript.find(predicate)
        if (hit) {
          cleanup()
          resolve(hit)
        }
      }
      const onClose = (code: number, reason: Buffer) => {
        cleanup()
        reject(new Error(`WebSocket closed before ${label} (code ${code}: ${reason.toString()})`))
      }
      ws.on('message', onMessage)
      ws.on('close', onClose)
    })
  }

  /** Resolve with the first captured server→client message of the given `type`. */
  waitForType(type: string, timeoutMs = DEFAULT_WAIT_MS): Promise<CapturedMessage> {
    return this.waitFor((m) => m.dir === 'in' && m.type === type, timeoutMs, `server→client "${type}"`)
  }

  /**
   * Resolve with the first server→client message matching an arbitrary predicate.
   * Needed for wrapped envelopes like `freshAgent.event`, where the meaningful
   * discriminant is the INNER `event.type` (e.g. `freshAgent.turn.complete`) rather
   * than the outer message `type`. Additive — existing helpers are unchanged.
   */
  waitForServerMessage(
    predicate: (m: CapturedMessage) => boolean,
    timeoutMs = DEFAULT_WAIT_MS,
    label = 'server→client message',
  ): Promise<CapturedMessage> {
    return this.waitFor((m) => m.dir === 'in' && predicate(m), timeoutMs, label)
  }

  /** Resolve when the server sends `ready` (the first post-hello message). */
  waitForReady(timeoutMs = DEFAULT_WAIT_MS): Promise<CapturedMessage> {
    return this.waitForType('ready', timeoutMs)
  }

  /**
   * Drive and capture the full connect handshake:
   *   hello → ready → settings.updated → [perf.logging] → [config.fallback] → terminal.inventory
   *
   * Sends `hello` if it has not been sent yet, then collects the transcript
   * through the terminating `terminal.inventory` message and returns the ordered
   * transcript (both directions).
   */
  async captureHandshake(timeoutMs = 20_000): Promise<CapturedMessage[]> {
    if (!this.helloSent) this.sendHello()
    await this.waitForType('terminal.inventory', timeoutMs)
    return this.getTranscript()
  }

  /** A defensive copy of the full ordered transcript (both directions). */
  getTranscript(): CapturedMessage[] {
    return this.transcript.slice()
  }

  /** Only the server→client messages, in order. */
  getServerMessages(): CapturedMessage[] {
    return this.transcript.filter((m) => m.dir === 'in')
  }

  /** Gracefully close the socket (terminates if it does not close in time). */
  async close(timeoutMs = 2_000): Promise<void> {
    const ws = this.ws
    this.ws = null
    if (!ws) return
    if (ws.readyState === WebSocket.CLOSED) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        ws.terminate()
        resolve()
      }, timeoutMs)
      ws.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        ws.close()
      } catch {
        ws.terminate()
        clearTimeout(timer)
        resolve()
      }
    })
  }
}
