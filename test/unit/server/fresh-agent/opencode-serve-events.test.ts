import { describe, expect, it } from 'vitest'
import type { ParsedServeEvent, SdkProviderEvent } from '../../../../server/fresh-agent/adapters/opencode/serve-events.js'
import {
  splitOpencodeModel,
  parseServeEvent,
  serveEventToSdk,
} from '../../../../server/fresh-agent/adapters/opencode/serve-events.js'

describe('splitOpencodeModel', () => {
  it('splits provider/model on the first slash only', () => {
    expect(splitOpencodeModel('umans-ai-coding-plan/umans-kimi-k2.7')).toEqual({
      providerID: 'umans-ai-coding-plan',
      modelID: 'umans-kimi-k2.7',
    })
  })
  it('returns undefined for blank or slashless input', () => {
    expect(splitOpencodeModel(undefined)).toBeUndefined()
    expect(splitOpencodeModel('   ')).toBeUndefined()
    expect(splitOpencodeModel('noslash')).toBeUndefined()
  })
  it('returns undefined when there is a leading slash', () => {
    expect(splitOpencodeModel('/model')).toBeUndefined()
  })
  it('returns undefined when there is a trailing slash', () => {
    expect(splitOpencodeModel('provider/')).toBeUndefined()
  })
  it('splits on the first slash and keeps the rest in modelID', () => {
    expect(splitOpencodeModel('a/b/c')).toEqual({ providerID: 'a', modelID: 'b/c' })
  })
})

describe('parseServeEvent', () => {
  it('extracts type and sessionId from properties', () => {
    expect(parseServeEvent({ type: 'session.idle', properties: { sessionID: 'ses_a' } }))
      .toEqual({
        kind: 'session.idle',
        sessionId: 'ses_a',
        properties: { sessionID: 'ses_a' },
        raw: { type: 'session.idle', properties: { sessionID: 'ses_a' } },
      })
  })
  it('reads sessionID from part-bearing events', () => {
    const ev = { type: 'message.part.updated', properties: { sessionID: 'ses_b', part: { id: 'prt_1', type: 'text' } } }
    expect(parseServeEvent(ev)).toMatchObject({ kind: 'message.part.updated', sessionId: 'ses_b' })
  })
  it('extracts sessionId from properties.part.sessionID when top-level sessionID is absent', () => {
    const ev = { type: 'message.part.updated', properties: { part: { id: 'prt_1', type: 'text', sessionID: 'ses_part' } } }
    expect(parseServeEvent(ev)).toMatchObject({ kind: 'message.part.updated', sessionId: 'ses_part' })
  })
  it('extracts sessionId from properties.info.sessionID when top-level and part sessionID are absent', () => {
    const ev = { type: 'session.status', properties: { status: { type: 'idle' }, info: { sessionID: 'ses_info' } } }
    expect(parseServeEvent(ev)).toMatchObject({ kind: 'session.status', sessionId: 'ses_info' })
  })
  it('returns undefined sessionId for server-level events', () => {
    expect(parseServeEvent({ type: 'server.connected', properties: {} }))
      .toMatchObject({ kind: 'server.connected', sessionId: undefined })
  })
  it('returns null for non-object / typeless input', () => {
    expect(parseServeEvent('nope')).toBeNull()
    expect(parseServeEvent({ properties: {} })).toBeNull()
  })
})

describe('serveEventToSdk', () => {
  it('maps session.idle to an idle snapshot stamped with the subscribed id', () => {
    const parsed: ParsedServeEvent = {
      kind: 'session.idle',
      sessionId: 'ses_a',
      properties: { sessionID: 'ses_a' },
      raw: { type: 'session.idle', properties: { sessionID: 'ses_a' } },
    }
    expect(serveEventToSdk(parsed, 'freshopencode-req-1')).toEqual({
      type: 'sdk.session.snapshot', sessionId: 'freshopencode-req-1', status: 'idle',
    })
  })
  it('maps busy session.status to a running snapshot', () => {
    const parsed: ParsedServeEvent = {
      kind: 'session.status',
      sessionId: 'ses_a',
      properties: { sessionID: 'ses_a', status: { type: 'busy' } },
      raw: { type: 'session.status', properties: { sessionID: 'ses_a', status: { type: 'busy' } } },
    }
    expect(serveEventToSdk(parsed, 'ses_a')).toEqual({ type: 'sdk.session.snapshot', sessionId: 'ses_a', status: 'running' })
  })
  it('maps message.part.updated to a transcript invalidation (drives client re-poll)', () => {
    const parsed: ParsedServeEvent = {
      kind: 'message.part.updated',
      sessionId: 'ses_a',
      properties: { sessionID: 'ses_a', part: { id: 'p', type: 'text' } },
      raw: { type: 'message.part.updated', properties: { sessionID: 'ses_a', part: { id: 'p', type: 'text' } } },
    }
    expect(serveEventToSdk(parsed, 'ses_a')).toEqual({
      type: 'sdk.session.changed',
      sessionId: 'ses_a',
      reason: 'opencode-message',
    })
  })
  it('maps OpenCode transcript mutation events to invalidations instead of running snapshots', () => {
    for (const kind of ['message.part.delta', 'message.part.updated', 'message.updated', 'message.removed', 'message.part.removed']) {
      const parsed: ParsedServeEvent = {
        kind,
        sessionId: 'ses_a',
        properties: { sessionID: 'ses_a', info: { id: 'msg_1', role: 'assistant' } },
        raw: { type: kind, properties: { sessionID: 'ses_a' } },
      }

      expect(serveEventToSdk(parsed, 'freshopencode-req-1')).toEqual({
        type: 'sdk.session.changed',
        sessionId: 'freshopencode-req-1',
        reason: 'opencode-message',
      })
    }
  })
  it('maps only active OpenCode session statuses to running', () => {
    const statusEvent = (statusType: string): ParsedServeEvent => ({
      kind: 'session.status',
      sessionId: 'ses_a',
      properties: { sessionID: 'ses_a', status: { type: statusType } },
      raw: { type: 'session.status', properties: { sessionID: 'ses_a', status: { type: statusType } } },
    })

    expect(serveEventToSdk(statusEvent('busy'), 'ses_a')).toEqual({
      type: 'sdk.session.snapshot',
      sessionId: 'ses_a',
      status: 'running',
    })
    expect(serveEventToSdk(statusEvent('retry'), 'ses_a')).toEqual({
      type: 'sdk.session.snapshot',
      sessionId: 'ses_a',
      status: 'running',
    })
    expect(serveEventToSdk(statusEvent('idle'), 'ses_a')).toEqual({
      type: 'sdk.session.snapshot',
      sessionId: 'ses_a',
      status: 'idle',
    })
    expect(serveEventToSdk(statusEvent('completed'), 'ses_a')).toEqual({
      type: 'sdk.session.changed',
      sessionId: 'ses_a',
      reason: 'opencode-status',
    })
    expect(serveEventToSdk(statusEvent('unexpected-future-status'), 'ses_a')).toEqual({
      type: 'sdk.session.changed',
      sessionId: 'ses_a',
      reason: 'opencode-status',
    })
  })
  it('maps session.error to an sdk.error', () => {
    const parsed: ParsedServeEvent = {
      kind: 'session.error',
      sessionId: 'ses_a',
      properties: { sessionID: 'ses_a', error: { message: 'boom' } },
      raw: { type: 'session.error', properties: { sessionID: 'ses_a', error: { message: 'boom' } } },
    }
    expect(serveEventToSdk(parsed, 'ses_a')).toEqual({ type: 'sdk.error', sessionId: 'ses_a', message: 'boom' })
  })
  it('returns null for events that should not surface to the client', () => {
    const parsed: ParsedServeEvent = {
      kind: 'server.heartbeat',
      sessionId: undefined,
      properties: {},
      raw: { type: 'server.heartbeat', properties: {} },
    }
    expect(serveEventToSdk(parsed, 'ses_a')).toBeNull()
  })
  it('maps a properties-only ParsedServeEvent to prove independence from raw internals', () => {
    const parsed: ParsedServeEvent = {
      kind: 'session.error',
      sessionId: 'ses_a',
      properties: { sessionID: 'ses_a', error: { message: 'raw-free' } },
      raw: {},
    }
    expect(serveEventToSdk(parsed, 'ses_a')).toEqual({
      type: 'sdk.error', sessionId: 'ses_a', message: 'raw-free',
    } as SdkProviderEvent)
  })
})
