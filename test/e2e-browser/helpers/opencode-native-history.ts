import { createHash } from 'node:crypto'
import { stripVTControlCharacters } from 'node:util'

export type NativeAssistantTurn = {
  messageId: string
  parentMessageId: string | null
  completedAt: number
  text: string
  toolPartCount: number
  modelId: string | null
  providerId: string | null
}

/** Run only through the ownership-checked provider exec inside the test soul. */
export const OPENCODE_NATIVE_HISTORY_SCRIPT = String.raw`
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const filename = process.argv[1];
const sessionId = process.argv[2];
if (!filename || !sessionId) throw new Error('native history probe requires exact store and session');
if (!fs.existsSync(filename)) {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, sessionId, available: false, turns: [] }));
} else {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;');
    const rows = db.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id LIMIT 128').all(sessionId);
    const parts = db.prepare('SELECT data FROM part WHERE session_id = ? AND message_id = ? ORDER BY time_created, id LIMIT 256');
    const turns = [];
    for (const row of rows) {
      const message = JSON.parse(row.data);
      if (message.role !== 'assistant' || !Number.isSafeInteger(message.time?.completed) || message.time.completed <= 0) continue;
      const materialized = parts.all(sessionId, row.id).map((part) => JSON.parse(part.data));
      const text = materialized.filter((part) => part.type === 'text').map((part) => part.text || '').join('');
      if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('native assistant response exceeds evidence bound');
      turns.push({
        messageId: row.id,
        parentMessageId: typeof message.parentID === 'string' ? message.parentID : null,
        completedAt: message.time.completed,
        text,
        toolPartCount: materialized.filter((part) => part.type === 'tool').length,
        modelId: typeof message.modelID === 'string' ? message.modelID : null,
        providerId: typeof message.providerID === 'string' ? message.providerID : null,
      });
    }
    process.stdout.write(JSON.stringify({ schemaVersion: 1, sessionId, available: true, turns }));
  } catch {
    console.error('native conversation query failed');
    process.exitCode = 1;
  } finally { db.close(); }
}
`

export function selectNativeAssistantTurn(
  turns: readonly NativeAssistantTurn[],
  priorMessageIds: ReadonlySet<string>,
  expectedText: string,
): NativeAssistantTurn | null {
  return turns.find((turn) => (
    !priorMessageIds.has(turn.messageId)
    && turn.toolPartCount === 0
    && turn.text.includes(expectedText)
  )) ?? null
}

export function nativeAssistantProof(nativeSessionId: string, turn: NativeAssistantTurn) {
  return {
    nativeSessionId,
    messageId: turn.messageId,
    parentMessageId: turn.parentMessageId,
    completedAt: turn.completedAt,
    toolPartCount: turn.toolPartCount,
    modelId: turn.modelId,
    providerId: turn.providerId,
    responseSha256: createHash('sha256').update(turn.text).digest('hex'),
  }
}

/** Resumed conversations omit the home-screen placeholder. Observe actual TUI input mode. */
export function openCodeTerminalReady(rawOutput: string): boolean {
  const modes = [...rawOutput.matchAll(/\x1b\[\?2004([hl])/g)]
  if (modes.at(-1)?.[1] !== 'h') return false
  const rendered = stripVTControlCharacters(rawOutput)
  return rendered.includes('Build') && rendered.includes('Big Pickle')
}
