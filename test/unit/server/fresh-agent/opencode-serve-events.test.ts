import { describe, expect, it } from 'vitest'
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
})

describe('parseServeEvent', () => {
  it('extracts type and sessionId from properties', () => {
    expect(parseServeEvent({ type: 'session.idle', properties: { sessionID: 'ses_a' } }))
      .toEqual({ kind: 'session.idle', sessionId: 'ses_a', raw: { type: 'session.idle', properties: { sessionID: 'ses_a' } } })
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
    const parsed = parseServeEvent({ type: 'session.idle', properties: { sessionID: 'ses_a' } })!
    expect(serveEventToSdk(parsed, 'freshopencode-req-1')).toEqual({
      type: 'sdk.session.snapshot', sessionId: 'freshopencode-req-1', status: 'idle',
    })
  })
  it('maps busy session.status to a running snapshot', () => {
    const parsed = parseServeEvent({ type: 'session.status', properties: { sessionID: 'ses_a', status: { type: 'busy' } } })!
    expect(serveEventToSdk(parsed, 'ses_a')).toEqual({ type: 'sdk.session.snapshot', sessionId: 'ses_a', status: 'running' })
  })
  it('maps message.part.updated to a running snapshot (drives client re-poll)', () => {
    const parsed = parseServeEvent({ type: 'message.part.updated', properties: { sessionID: 'ses_a', part: { id: 'p', type: 'text' } } })!
    expect(serveEventToSdk(parsed, 'ses_a')).toEqual({ type: 'sdk.session.snapshot', sessionId: 'ses_a', status: 'running' })
  })
  it('maps session.error to an sdk.error', () => {
    const parsed = parseServeEvent({ type: 'session.error', properties: { sessionID: 'ses_a', error: { message: 'boom' } } })!
    expect(serveEventToSdk(parsed, 'ses_a')).toEqual({ type: 'sdk.error', sessionId: 'ses_a', message: 'boom' })
  })
  it('returns null for events that should not surface to the client', () => {
    const parsed = parseServeEvent({ type: 'server.heartbeat', properties: {} })!
    expect(serveEventToSdk(parsed, 'ses_a')).toBeNull()
  })
})
