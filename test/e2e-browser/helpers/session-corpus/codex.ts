/**
 * HARNESS-04 — Codex rollout writer.
 *
 * Real Codex CLI layout (`server/coding-cli/providers/codex.ts`):
 *   $CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<sessionId>.jsonl
 * with a leading `session_meta` record (`payload.id`/`payload.cwd`, optional
 * `payload.source: 'exec'` ⇒ non-interactive) followed by
 * `response_item`/`message` records (`input_text` user, `output_text`
 * assistant). First user text → title; first assistant text → summary.
 *
 * Codex's own archive is a MOVE to `$CODEX_HOME/archived_sessions/…`; the
 * are written there with expectation `absent` — that IS the expected semantics.
 */

import path from 'path'
import fsp from 'fs/promises'
import type { CorpusContext, CorpusSessionExpectation } from './types.js'
import { recordFile } from './manifest.js'

export interface CodexSessionSpec {
  role: string
  sessionId: string
  cwd: string
  titleText: string
  /** session_meta timestamp (also the wire createdAt). */
  createdAt: number
  /** Timestamp of the final record (the wire lastActivityAt). */
  lastActivityAt: number
  /** 'exec' → payload.source ⇒ hidden by default (non-interactive). */
  source?: string
  /** Write under archived_sessions/ instead of sessions/ (provider-archived). */
  archivedByProvider?: boolean
}

export interface CodexRolloutFixtureSpec {
  sessionId: string
  cwd: string
  /** Explicit name lets tests make filename order disagree with event order. */
  fileName: string
  /** session_meta timestamp (also the wire createdAt). */
  createdAt: number
  userAt: number
  assistantAt: number
  userText: string
  assistantText: string
  /** A later user turn that is absent from first-message title metadata. */
  laterUserMessage?: { at: number; text: string }
}

export interface CodexContinuationFixtureSpec {
  sessionId: string
  cwd: string
  segments: Array<Omit<CodexRolloutFixtureSpec, 'sessionId' | 'cwd'>>
}

const iso = (ms: number): string => new Date(ms).toISOString()

/** 'YYYY/MM/DD' for the rollout date-dir layout. */
export function codexDatePath(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`
}

/** rollout-<iso with dashes instead of colons>-<id>.jsonl, real codex shape. */
export function codexRolloutFileName(ms: number, sessionId: string): string {
  return `rollout-${iso(ms).replace(/:/g, '-').slice(0, 19)}-${sessionId}.jsonl`
}

/**
 * Write one realistic VS Code Codex rollout file into an isolated test home.
 * The fields intentionally match the 0.156 continuation evidence inspected
 * for rrx7; text is synthetic and contains no provider transcript content.
 */
export async function writeCodexRolloutFixture(
  homeDir: string,
  spec: CodexRolloutFixtureSpec,
): Promise<string> {
  const dir = path.join(homeDir, '.codex', 'sessions', ...codexDatePath(spec.createdAt).split('/'))
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, spec.fileName)
  const records = [
    {
      timestamp: iso(spec.createdAt),
      ordinal: 0,
      type: 'session_meta',
      payload: {
        id: spec.sessionId,
        session_id: spec.sessionId,
        timestamp: iso(spec.createdAt),
        cwd: spec.cwd,
        source: 'vscode',
        thread_source: 'user',
        cli_version: '0.156.0',
        originator: 'codex-vscode',
        history_mode: 'paginated',
      },
    },
    {
      timestamp: iso(spec.userAt),
      ordinal: 1,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: spec.userText }],
      },
    },
    {
      timestamp: iso(spec.assistantAt),
      ordinal: 2,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: spec.assistantText }],
      },
    },
    ...(spec.laterUserMessage ? [{
      timestamp: iso(spec.laterUserMessage.at),
      ordinal: 3,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: spec.laterUserMessage.text }],
      },
    }] : []),
  ]
  await fsp.writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  return file
}

/** Write a session's rollout segments into an isolated home in listed order. */
export async function writeCodexContinuationFixtures(
  homeDir: string,
  spec: CodexContinuationFixtureSpec,
): Promise<string[]> {
  const files: string[] = []
  for (const segment of spec.segments) {
    files.push(await writeCodexRolloutFixture(homeDir, {
      ...segment,
      sessionId: spec.sessionId,
      cwd: spec.cwd,
    }))
  }
  return files
}

export interface CodexReferencedHistoryFixtureSpec {
  sessionId: string
  selectedRolloutId: string
  unselectedRolloutId: string
  cwd: string
  createdAt: number
  retainedUserText: string
  selectedUserText: string
  discardedUserText: string
  unselectedUserText: string
}

/**
 * A same-thread revert preserves an exact original prefix and replaces its
 * tail. SQLite selects the current rollout even when another branch's filename
 * is newer. Byte offsets address encoded JSONL bytes, including newlines.
 */
export async function writeCodexReferencedHistoryFixture(
  homeDir: string,
  spec: CodexReferencedHistoryFixtureSpec,
): Promise<{ rootFile: string; selectedFile: string; unselectedFile: string; lastActivityAt: number }> {
  const codexHome = path.join(homeDir, '.codex')
  const selectedAt = spec.createdAt + 60_000
  const unselectedAt = spec.createdAt + 120_000
  const header = (at: number, ordinal: number, version: string, historyBase?: {
    thread_id: string
    end_byte_offset: number
    end_ordinal_exclusive: number
  }) => ({
    timestamp: iso(at),
    ordinal,
    type: 'session_meta',
    payload: {
      id: spec.sessionId,
      session_id: spec.sessionId,
      timestamp: iso(at),
      cwd: spec.cwd,
      source: 'vscode',
      thread_source: 'user',
      cli_version: version,
      originator: 'codex-vscode',
      history_mode: 'paginated',
      ...(historyBase ? { history_base: historyBase } : {}),
    },
  })
  const message = (at: number, ordinal: number, role: 'user' | 'assistant', text: string) => ({
    timestamp: iso(at),
    ordinal,
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
    },
  })
  const encode = (records: unknown[]) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
  const write = async (at: number, physicalId: string, records: unknown[]) => {
    const directory = path.join(codexHome, 'sessions', ...codexDatePath(at).split('/'))
    await fsp.mkdir(directory, { recursive: true })
    const ids = physicalId === spec.sessionId ? spec.sessionId : `${spec.sessionId}_${physicalId}`
    const filename = path.join(directory, codexRolloutFileName(at, ids))
    await fsp.writeFile(filename, encode(records))
    return filename
  }

  const retainedPrefix = [
    header(spec.createdAt, 0, '0.159.2'),
    message(spec.createdAt + 1000, 1, 'user', 'Referenced history opening request'),
    message(spec.createdAt + 2000, 2, 'assistant', 'Referenced history opening reply'),
    message(spec.createdAt + 3000, 3, 'user', spec.retainedUserText),
    message(spec.createdAt + 4000, 4, 'assistant', 'Retained prefix reply'),
  ]
  const historyBase = {
    thread_id: spec.sessionId,
    end_byte_offset: Buffer.byteLength(encode(retainedPrefix), 'utf8'),
    end_ordinal_exclusive: retainedPrefix.length,
  }
  const rootFile = await write(spec.createdAt, spec.sessionId, [
    ...retainedPrefix,
    message(spec.createdAt + 5000, 5, 'user', spec.discardedUserText),
    message(spec.createdAt + 6000, 6, 'assistant', 'Discarded original tail reply'),
  ])
  const selectedFile = await write(selectedAt, spec.selectedRolloutId, [
    header(selectedAt, 5, '0.160.0', historyBase),
    message(selectedAt + 1000, 6, 'user', 'Selected replacement opening request'),
    message(selectedAt + 2000, 7, 'assistant', 'Selected replacement reply'),
    message(selectedAt + 3000, 8, 'user', spec.selectedUserText),
  ])
  const unselectedFile = await write(unselectedAt, spec.unselectedRolloutId, [
    header(unselectedAt, 5, '0.160.0', historyBase),
    message(unselectedAt + 1000, 6, 'user', 'Unselected replacement opening request'),
    message(unselectedAt + 2000, 7, 'assistant', 'Unselected replacement reply'),
    message(unselectedAt + 3000, 8, 'user', spec.unselectedUserText),
  ])

  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'))
  try {
    database.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL,
      history_mode TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0
    )`)
    database.prepare('INSERT INTO threads (id, rollout_path, history_mode) VALUES (?, ?, ?)')
      .run(spec.sessionId, selectedFile, 'paginated')
  } finally {
    database.close()
  }
  return { rootFile, selectedFile, unselectedFile, lastActivityAt: selectedAt + 3000 }
}

export async function writeCodexSession(
  ctx: CorpusContext,
  spec: CodexSessionSpec,
): Promise<CorpusSessionExpectation> {
  if (spec.lastActivityAt < spec.createdAt + 2) {
    throw new Error(
      `writeCodexSession(${spec.role}): need lastActivityAt >= createdAt+2 (meta/user/assistant)`,
    )
  }
  const root = spec.archivedByProvider
    ? path.join(ctx.homeDir, '.codex', 'archived_sessions')
    : path.join(ctx.homeDir, '.codex', 'sessions')
  const dir = path.join(root, ...codexDatePath(spec.createdAt).split('/'))
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, codexRolloutFileName(spec.createdAt, spec.sessionId))

  const records = [
    {
      timestamp: iso(spec.createdAt),
      type: 'session_meta',
      payload: {
        id: spec.sessionId,
        timestamp: iso(spec.createdAt),
        cwd: spec.cwd,
        originator: 'codex_cli_rs',
        cli_version: '0.20.0',
        instructions: null,
        ...(spec.source ? { source: spec.source } : {}),
        git: { branch: 'main', commit_hash: 'h04corpus00000000000000000000000000000000' },
      },
    },
    {
      timestamp: iso(spec.createdAt + 1),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `${spec.titleText} request 1` }],
      },
    },
    {
      timestamp: iso(spec.lastActivityAt),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `${spec.titleText} reply 1` }],
      },
    },
  ]
  await fsp.writeFile(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`)
  await recordFile(ctx.files, ctx.homeDir, file, `codex-session:${spec.role}`)

  const userText = `${spec.titleText} request 1`
  const expectation: CorpusSessionExpectation = spec.archivedByProvider
    ? {
      key: `codex:${spec.sessionId}`,
      provider: 'codex',
      sessionId: spec.sessionId,
      role: spec.role,
      projectPath: spec.cwd,
      cwd: spec.cwd,
      lastActivityAt: spec.lastActivityAt,
      visibility: 'absent',
    }
    : {
      key: `codex:${spec.sessionId}`,
      provider: 'codex',
      sessionId: spec.sessionId,
      role: spec.role,
      title: userText,
      summary: `${spec.titleText} reply 1`,
      projectPath: spec.cwd,
      cwd: spec.cwd,
      createdAt: spec.createdAt,
      lastActivityAt: spec.lastActivityAt,
      visibility: spec.source === 'exec' ? 'hidden-default' : 'listed',
      ...(spec.source === 'exec' ? { visibleWith: { includeNonInteractive: true } } : {}),
    }
  ctx.sessions.push(expectation)
  return expectation
}
