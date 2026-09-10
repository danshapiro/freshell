import { stripVTControlCharacters } from 'node:util'

export type { NativeAssistantTurn, NativeHistory } from './provider-native-history/types.js'
export { nativeTurnProof } from './provider-native-history/proof.js'
import type { NativeAssistantTurn } from './provider-native-history/types.js'

/**
 * Self-contained query-only form of the current OpenCode native-history reader.
 * Runtime chaos tests execute it only through an ownership-checked provider
 * exec because the provider volume is deliberately not mounted into the web
 * process. It emits the same bounded schema as readOpenCodeNativeHistory.
 */
export const OPENCODE_NATIVE_HISTORY_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const filename = process.argv[1];
const sessionId = process.argv[2];
const fail = () => {
  process.stderr.write('[provider-native-history] BLOCKED: native history validation failed\n');
  process.exitCode = 2;
};
try {
  if (!filename || !sessionId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) {
    throw new Error('invalid native-history arguments');
  }
  if (!path.isAbsolute(filename)) throw new Error('database path must be absolute');
  const before = fs.lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('database must be a regular file');
  if (fs.realpathSync(filename) !== path.resolve(filename)) throw new Error('database path traverses a symlink');
  for (const suffix of ['-wal', '-shm']) {
    const companion = filename + suffix;
    if (!fs.existsSync(companion)) continue;
    const stat = fs.lstatSync(companion);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(companion) !== path.resolve(companion)) {
      throw new Error('unsafe sqlite companion');
    }
  }
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN;');
    const requireColumns = (table, required) => {
      const actual = new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map((row) => row.name));
      if (required.some((column) => !actual.has(column))) throw new Error('missing required columns');
    };
    requireColumns('session', ['id']);
    requireColumns('message', ['id', 'session_id', 'time_created', 'data']);
    requireColumns('part', ['id', 'session_id', 'message_id', 'time_created', 'data']);
    const sessions = db.prepare('SELECT id FROM session WHERE id = ? LIMIT 2').all(sessionId);
    if (sessions.length !== 1) throw new Error('exact session is missing or ambiguous');
    const rows = db.prepare(
      'SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id LIMIT 129'
    ).all(sessionId);
    if (rows.length > 128) throw new Error('message bound exceeded');
    const partsQuery = db.prepare(
      'SELECT data FROM part WHERE session_id = ? AND message_id = ? ORDER BY time_created, id LIMIT 257'
    );
    const turns = [];
    for (const row of rows) {
      if (Buffer.byteLength(row.data, 'utf8') > 256 * 1024) throw new Error('message bound exceeded');
      const message = JSON.parse(row.data);
      if (message.role !== 'assistant' || !Number.isSafeInteger(message.time && message.time.completed)
        || message.time.completed <= 0) continue;
      const partRows = partsQuery.all(sessionId, row.id);
      if (partRows.length > 256) throw new Error('part bound exceeded');
      const parts = partRows.map((part) => {
        if (Buffer.byteLength(part.data, 'utf8') > 256 * 1024) throw new Error('part bound exceeded');
        return JSON.parse(part.data);
      });
      const text = parts.filter((part) => part.type === 'text')
        .map((part) => typeof part.text === 'string' ? part.text : '').join('');
      if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('response bound exceeded');
      const toolCalls = parts.filter((part) => part.type === 'tool').map((part) => {
        const name = typeof (part.tool || part.name) === 'string' && (part.tool || part.name)
          ? (part.tool || part.name) : undefined;
        return name ? { type: 'tool', name } : { type: 'tool' };
      });
      if (toolCalls.length > 64) throw new Error('tool-call bound exceeded');
      if (typeof row.id !== 'string' || !row.id || typeof message.providerID !== 'string'
        || !message.providerID || typeof message.modelID !== 'string' || !message.modelID) {
        throw new Error('native identity metadata is incomplete');
      }
      const parentMessageId = typeof message.parentID === 'string' && message.parentID
        ? message.parentID : null;
      turns.push({
        nativeEvidence: {
          kind: 'identified_message', turnId: row.id, messageId: row.id, parentMessageId,
        },
        turnId: row.id,
        messageId: row.id,
        parentMessageId,
        completedAt: message.time.completed,
        text,
        toolCalls,
        resolvedProvider: message.providerID,
        resolvedModel: message.modelID,
        resolvedReasoningEffort: 'provider-default',
        providerProvenance: 'opencode-message.providerID',
        modelProvenance: 'opencode-message.modelID',
        reasoningEffortProvenance: 'opencode-message.provider-default',
      });
      if (turns.length > 128) throw new Error('turn bound exceeded');
    }
    if (turns.length === 0) throw new Error('no completed assistant response');
    db.exec('COMMIT;');
    process.stdout.write(JSON.stringify({
      schemaVersion: 1, provider: 'opencode', nativeSessionId: sessionId, turns,
    }));
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw error;
  } finally {
    db.close();
  }
} catch {
  fail();
}
`

export function selectNativeAssistantTurn(
  turns: readonly NativeAssistantTurn[],
  priorMessageIds: ReadonlySet<string>,
  expectedText: string,
): NativeAssistantTurn | null {
  return turns.find((turn) => (
    !priorMessageIds.has(turn.messageId)
    && turn.toolCalls.length === 0
    && turn.text.includes(expectedText)
  )) ?? null
}

/** Resumed conversations omit the home-screen placeholder. Observe actual TUI input mode. */
export function openCodeTerminalReady(rawOutput: string): boolean {
  const modes = [...rawOutput.matchAll(/\x1b\[\?2004([hl])/g)]
  if (modes.at(-1)?.[1] !== 'h') return false
  const rendered = stripVTControlCharacters(rawOutput)
  return rendered.includes('Build') && rendered.includes('Big Pickle')
}
