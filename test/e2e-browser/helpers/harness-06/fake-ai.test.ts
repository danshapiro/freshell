import { describe, it, expect, afterEach } from 'vitest'
import { startFakeGemini, type FakeGemini } from './fake-ai.js'

/**
 * HARNESS-06 summary-AI coverage: a fake Gemini `generateContent` endpoint
 * that returns caller-configured FIXED output. Two validation layers:
 * The fixture is exercised through raw HTTP so this retained test does not
 * pull the retired Node AI SDK into the root dependency graph.
 */

const fakes: FakeGemini[] = []
async function make(): Promise<FakeGemini> {
  const f = await startFakeGemini()
  fakes.push(f)
  return f
}
afterEach(async () => {
  while (fakes.length) await fakes.pop()!.stop()
})

const MODEL = 'gemini-2.5-flash-lite'
const FIXED = 'fixture AI output: stable summary'

function genUrl(f: FakeGemini, model = MODEL): string {
  return `${f.baseUrl}/v1beta/models/${model}:generateContent`
}

describe('harness-06 fake-ai: raw HTTP shape', () => {
  it('returns the fixed output in the exact Gemini response shape and records the request', async () => {
    const f = await make()
    const res = await fetch(genUrl(f), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': 'fixture-key' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'summarize this terminal' }] }] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> }; finishReason?: string }>
      usageMetadata?: { totalTokenCount?: number }
    }
    expect(body.candidates[0].content.parts[0].text).toBe(FIXED)
    expect(body.candidates[0].finishReason).toBe('STOP')
    expect(typeof body.usageMetadata?.totalTokenCount).toBe('number')

    const ledger = f.ledger()
    expect(ledger).toHaveLength(1)
    expect(ledger[0].model).toBe(MODEL)
    expect(ledger[0].action).toBe('generateContent')
    expect(ledger[0].apiKeyPresent).toBe(true)
    expect(ledger[0].promptText).toContain('summarize this terminal')
    expect(ledger[0].seq).toBe(1)
  })

  it('setResponse swaps the fixed output deterministically', async () => {
    const f = await make()
    f.setResponse('rewritten fixture title')
    const res = await fetch(genUrl(f), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'x' }] }] }),
    })
    const body = (await res.json()) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> }
    expect(body.candidates[0].content.parts[0].text).toBe('rewritten fixture title')
  })

  it('error modes: 500, 429, and blocked prompt feedback', async () => {
    const f = await make()
    f.setError('http500')
    expect((await fetch(genUrl(f), { method: 'POST', body: '{}' })).status).toBe(500)
    f.setError('rateLimit429')
    const limited = await fetch(genUrl(f), { method: 'POST', body: '{}' })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('1')
    f.setError('blocked')
    const blocked = await (await fetch(genUrl(f), { method: 'POST', body: '{}' })).json() as Record<string, unknown>
    expect((blocked.promptFeedback as { blockReason: string }).blockReason).toBe('SAFETY')
    f.setError(null)
    expect((await fetch(genUrl(f), { method: 'POST', body: '{}' })).status).toBe(200)
  })

  it('streams deterministic SSE chunks on streamGenerateContent', async () => {
    const f = await make()
    f.setResponse('streamed words here')
    const res = await fetch(`${f.baseUrl}/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'stream me' }] }] }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    const dataLines = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6))
    expect(dataLines.length).toBe(2)
    const first = JSON.parse(dataLines[0]) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> }
    const second = JSON.parse(dataLines[1]) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> }; finishReason?: string }>
      usageMetadata?: { totalTokenCount?: number }
    }
    expect(first.candidates[0].content.parts[0].text).toBe('streamed ')
    expect(second.candidates[0].content.parts[0].text).toBe('words here')
    expect(second.candidates[0].finishReason).toBe('STOP')
    expect(typeof second.usageMetadata?.totalTokenCount).toBe('number')
    expect(f.ledger()[0].action).toBe('streamGenerateContent')
  })

  it('404s unknown model routes without hanging', async () => {
    const f = await make()
    expect((await fetch(`${f.baseUrl}/v1beta/other`, { method: 'POST', body: '{}' })).status).toBe(404)
  })
})
