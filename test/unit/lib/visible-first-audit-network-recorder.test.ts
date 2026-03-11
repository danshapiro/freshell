// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  createNetworkRecorder,
  summarizeNetworkCapture,
} from '@test/e2e-browser/perf/network-recorder'

function fakeApiRequest(pathname: string) {
  return {
    requestId: 'req-1',
    timestamp: 1,
    request: {
      url: `http://127.0.0.1:3001${pathname}`,
      method: 'GET',
    },
  }
}

function fakeLoadingFinished() {
  return {
    requestId: 'req-1',
    encodedDataLength: 321,
  }
}

function fakeWsFrame(type: string) {
  return {
    requestId: 'ws-1',
    timestamp: 2,
    response: {
      opcode: 1,
      payloadData: JSON.stringify({ type }),
    },
  }
}

describe('createNetworkRecorder', () => {
  it('normalizes app API requests and WS frames from CDP events', () => {
    const recorder = createNetworkRecorder()
    recorder.onRequestWillBeSent(fakeApiRequest('/api/agent-sessions/abc123/timeline'))
    recorder.onLoadingFinished(fakeLoadingFinished())
    recorder.onWebSocketFrameReceived(fakeWsFrame('sdk.session.snapshot'))

    const summary = summarizeNetworkCapture(recorder.snapshot())
    expect(summary.http.byRoute['/api/agent-sessions/:sessionId/timeline']?.count).toBe(1)
    expect(summary.ws.byType['sdk.session.snapshot']?.receivedFrames).toBe(1)
  })
})
