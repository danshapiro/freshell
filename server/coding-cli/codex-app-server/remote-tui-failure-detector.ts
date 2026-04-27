export type CodexRemoteTuiFailureResult =
  | { fatal: false }
  | { fatal: true; reason: 'transport_reset' | 'event_stream_disconnected' | 'resume_attach_failed' }

const ROLLING_TAIL_MAX_CHARS = 4 * 1024

const ANSI_PATTERN = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, '')
}

export function detectCodexRemoteTuiFailure(input: string): CodexRemoteTuiFailureResult {
  const text = stripAnsi(input)

  if (/remote app server[\s\S]*transport failed:[\s\S]*Connection reset without closing handshake/i.test(text)) {
    return { fatal: true, reason: 'transport_reset' }
  }

  if (/app-server event stream disconnected: channel closed/i.test(text)) {
    return { fatal: true, reason: 'event_stream_disconnected' }
  }

  if (/Failed to attach to resumed app-server thread: thread is not yet available for replay or live attach\./i.test(text)) {
    return { fatal: true, reason: 'resume_attach_failed' }
  }

  return { fatal: false }
}

export class CodexRemoteTuiFailureDetector {
  private tail = ''

  push(chunk: string): CodexRemoteTuiFailureResult {
    this.tail += stripAnsi(chunk)
    if (this.tail.length > ROLLING_TAIL_MAX_CHARS) {
      this.tail = this.tail.slice(-ROLLING_TAIL_MAX_CHARS)
    }
    return detectCodexRemoteTuiFailure(this.tail)
  }

  reset(): void {
    this.tail = ''
  }
}
