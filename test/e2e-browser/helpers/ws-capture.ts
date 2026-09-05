// Raw server-side WebSocket frame capture for wire-level assertions
// (terminal.idle / terminal.turn.complete edges), independent of the browser
// client. Mirrors the WsCapture pattern in terminal-activity-rust.spec.ts.
import WebSocket from 'ws'

export type WsFrame = Record<string, any>

export class WsCapture {
  private ws: WebSocket
  private frames: WsFrame[] = []
  private readyPromise: Promise<void>

  constructor(wsUrl: string, token: string) {
    this.ws = new WebSocket(wsUrl)
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('WsCapture: no ready frame within 15s')),
        15_000,
      )
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ type: 'hello', protocolVersion: 8, token }))
      })
      this.ws.on('message', (data) => {
        let frame: WsFrame
        try {
          frame = JSON.parse(String(data))
        } catch {
          return
        }
        this.frames.push(frame)
        if (frame.type === 'ready') {
          clearTimeout(timer)
          resolve()
        }
      })
      this.ws.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  async ready(): Promise<void> {
    return this.readyPromise
  }

  get all(): WsFrame[] {
    return this.frames
  }

  count(pred: (f: WsFrame) => boolean): number {
    return this.frames.filter(pred).length
  }

  async waitFor(pred: (f: WsFrame) => boolean, timeoutMs: number, label: string): Promise<WsFrame> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = this.frames.find(pred)
      if (hit) return hit
      if (Date.now() >= deadline) {
        throw new Error(`WsCapture: timed out after ${timeoutMs}ms waiting for ${label}`)
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      // already closed
    }
  }
}
