import http from 'node:http'
import net from 'node:net'

/**
 * HARNESS-06 summary-AI fixture — a fake Gemini endpoint returning caller-
 * configured FIXED output.
 *
 * URL/shape contract matches the Gemini generate-content API:
 *   POST {baseURL}/v1beta/models/{model}:generateContent
 *   POST {baseURL}/v1beta/models/{model}:streamGenerateContent?alt=sse
 * Header `x-goog-api-key` presence is recorded (never the value). Responses
 * contain the stable fields consumed by the Rust server's summary client.
 */

export interface FakeGeminiRequest {
  seq: number
  at: number
  model: string
  action: 'generateContent' | 'streamGenerateContent'
  apiKeyPresent: boolean
  promptText: string
}

export type FakeGeminiErrorMode = 'http500' | 'rateLimit429' | 'blocked' | null

export interface FakeGemini {
  port: number
  baseUrl: string
  /**
   * The value a client passes as the SDK's `baseURL` — `{baseUrl}/v1beta`,
   * mirroring the real default `https://generativelanguage.googleapis.com/v1beta`.
   * (The fixture also answers `/models/...` with no prefix for raw callers.)
   */
  geminiBaseUrl: string
  stop: () => Promise<void>
  setResponse: (text: string) => void
  setError: (mode: FakeGeminiErrorMode) => void
  ledger: () => readonly FakeGeminiRequest[]
  clearLedger: () => void
}

export const FAKE_GEMINI_DEFAULT_TEXT = 'fixture AI output: stable summary'

interface GenerateContentsBody {
  contents?: Array<{ parts?: Array<{ text?: string }> }>
}

function extractPromptText(body: GenerateContentsBody): string {
  return (body.contents ?? [])
    .flatMap((c) => c.parts ?? [])
    .map((p) => p.text ?? '')
    .filter(Boolean)
    .join('\n')
}

function promptTokenEstimate(promptText: string): number {
  return Math.max(1, Math.ceil(promptText.length / 4))
}

function generateResponse(text: string, promptText: string) {
  const candidatesTokenCount = Math.max(1, Math.ceil(text.length / 4))
  const promptTokenCount = promptTokenEstimate(promptText)
  return {
    candidates: [
      {
        content: { role: 'model', parts: [{ text }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: {
      promptTokenCount,
      candidatesTokenCount,
      totalTokenCount: promptTokenCount + candidatesTokenCount,
    },
  }
}

export async function startFakeGemini(): Promise<FakeGemini> {
  let fixedText = FAKE_GEMINI_DEFAULT_TEXT
  let errorMode: FakeGeminiErrorMode = null
  let seq = 0
  const entries: FakeGeminiRequest[] = []
  const sockets = new Set<net.Socket>()

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      // /v1beta/models/{model}:{action}  (the /v1beta prefix is optional so
      // callers that set baseURL=<base> without the version suffix also work)
      const m = /^\/(?:v1beta\/)?models\/(.+):(generateContent|streamGenerateContent)$/.exec(url.pathname)
      if (req.method !== 'POST' || !m) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found', path: url.pathname }))
        return
      }
      const [, model, action] = m as [string, string, FakeGeminiRequest['action']]
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      let parsed: GenerateContentsBody = {}
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as GenerateContentsBody
      } catch {
        /* non-JSON body: record with empty prompt */
      }
      const promptText = extractPromptText(parsed)
      entries.push({
        seq: ++seq,
        at: Date.now(),
        model,
        action,
        apiKeyPresent: typeof req.headers['x-goog-api-key'] === 'string',
        promptText,
      })

      if (errorMode === 'http500') {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 500, message: 'fixture 500', status: 'INTERNAL' } }))
        return
      }
      if (errorMode === 'rateLimit429') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
        res.end(JSON.stringify({ error: { code: 429, message: 'fixture rate limited', status: 'RESOURCE_EXHAUSTED' } }))
        return
      }
      if (errorMode === 'blocked') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }))
        return
      }

      if (action === 'generateContent') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(generateResponse(fixedText, promptText)))
        return
      }

      // streamGenerateContent: two deterministic SSE chunks (split at the
      // first space, or mid-string when there is none), usage on the last.
      const splitAt = fixedText.includes(' ') ? fixedText.indexOf(' ') + 1 : Math.ceil(fixedText.length / 2)
      const firstText = fixedText.slice(0, splitAt)
      const secondText = fixedText.slice(splitAt)
      const promptTokenCount = promptTokenEstimate(promptText)
      const candidatesTokenCount = Math.max(1, Math.ceil(fixedText.length / 4))
      const chunk1 = { candidates: [{ content: { role: 'model', parts: [{ text: firstText }] } }] }
      const chunk2 = {
        candidates: [{ content: { role: 'model', parts: [{ text: secondText }] }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount,
          candidatesTokenCount,
          totalTokenCount: promptTokenCount + candidatesTokenCount,
        },
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(`data: ${JSON.stringify(chunk1)}\n\n`)
      res.write(`data: ${JSON.stringify(chunk2)}\n\n`)
      res.end()
    })().catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String(err) }))
    })
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('fake-gemini failed to bind')

  return {
    port: addr.port,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    geminiBaseUrl: `http://127.0.0.1:${addr.port}/v1beta`,
    stop: async () => {
      for (const s of sockets) { try { s.destroy() } catch { /* closed */ } }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
    setResponse: (text) => { fixedText = text },
    setError: (mode) => { errorMode = mode },
    ledger: () => entries,
    clearLedger: () => { entries.length = 0 },
  }
}
