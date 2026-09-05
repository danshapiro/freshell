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
