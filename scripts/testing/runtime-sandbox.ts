import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile, execFileSync, spawnSync, spawn, type ChildProcess } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { ManagedRuntimeInventorySnapshotSchema, ManagedRuntimeMigrationPlanSchema, ManagedRuntimeSoulSchema,
  type ManagedRuntimeInventorySnapshot } from '../../shared/managed-runtime.js'


import fsp from 'node:fs/promises'
import { defaultReceiptFileName } from './runtime-receipts.js'
import { buildProviderQualificationReceipt, type ProviderQualificationReceiptV2, type ProviderQualificationRow } from './provider-qualification-receipt.js'
import { buildFreshAgentQualificationReceipt, type FreshAgentQualificationReceiptV1, type FreshAgentQualificationRow } from './fresh-agent-qualification-receipt.js'
import type { QualifiableTerminalProvider } from './provider-qualification-selection.js'

import { configuredProviderOnecliGrantFiles } from './runtime-amplifier-onecli.js'
import { RestrictedDockerBroker, type BrokerEvent, type BrokerReceipt } from './runtime-test-broker.js'

const { DatabaseSync }: typeof import('node:sqlite') = createRequire(import.meta.url)('node:sqlite')

// This is the pinned v1.18.21 migration registry, not a copy of a user store.
// A changed provider schema must update the fixture and its importer together.
const MIGRATIONS = [
  '20260127222353_familiar_lady_ursula',
  '20260211171708_add_project_commands',
  '20260213144116_wakeful_the_professor',
  '20260225215848_workspace',
  '20260227213759_add_session_workspace_id',
  '20260228203230_blue_harpoon',
  '20260303231226_add_workspace_fields',
  '20260309230000_move_org_to_state',
  '20260312043431_session_message_cursor',
  '20260323234822_events',
  '20260410174513_workspace-name',
  '20260413175956_chief_energizer',
  '20260423070820_add_icon_url_override',
  '20260427172553_slow_nightmare',
  '20260428004200_add_session_path',
  '20260501142318_next_venus',
  '20260504145000_add_sync_owner',
  '20260507164347_add_workspace_time',
  '20260510033149_session_usage',
  '20260511000411_data_migration_state',
  '20260511173437_session-metadata',
  '20260601010001_normalize_storage_paths',
  '20260601202201_amazing_prowler',
  '20260602002951_lowly_union_jack',
  '20260602182828_add_project_directories',
  '20260603001617_session_message_projection_indexes',
  '20260603040000_session_message_projection_order',
  '20260603141458_session_input_inbox',
  '20260603160727_jittery_ezekiel_stane',
  '20260604172448_event_sourced_session_input',
  '20260605003541_add_session_context_snapshot',
  '20260605042240_add_context_epoch_agent',
  '20260611035744_credential',
  '20260611192811_lush_chimera',
  '20260612174303_project_dir_strategy',
  '20260622142730_simplify_session_context_epoch',
  '20260622170816_reset_v2_session_state',
  '20260622202450_simplify_session_input',
] as const

export const EXCLUDED_SOURCE_SENTINELS = [
  'UNRELATED_SESSION_SENTINEL',
  'UNRELATED_MESSAGE_SENTINEL',
  'ACCOUNT_TOKEN_SENTINEL',
  'ACCOUNT_REFRESH_SENTINEL',
  'CONTROL_ACCOUNT_SENTINEL',
  'CREDENTIAL_VALUE_SENTINEL',
  'PROVIDER_CONFIG_SENTINEL',
] as const

export type SyntheticSource = {
  databasePath: string
  rootId: string
  childId: string
  grandchildId: string
  unrelatedId: string
  baselineMessages: ReadonlyMap<string, string>
  baselineParts: ReadonlyMap<string, string>
  lastMessageId: string
  selectedSentinel: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

export function seedManagedOpenCodeSource(input: {
  repoRoot: string
  databasePath: string
  workspace: string
  nonce: string
  messageCount?: number
}): SyntheticSource {
  const { repoRoot, databasePath, workspace, nonce } = input
  const messageCount = input.messageCount ?? 106
  if (!Number.isInteger(messageCount) || messageCount < 2 || messageCount % 2 !== 0) {
    throw new Error('synthetic OpenCode message count must be an even integer of at least two')
  }
  const nativeIdNonce = sha256(nonce).slice(0, 16)
  const nativeId = (prefix: string, index: number): string =>
    `${prefix}_${nativeIdNonce}${String(index).padStart(10, '0')}`
  const rootId = nativeId('ses', 0)
  const childId = nativeId('ses', 1)
  const grandchildId = nativeId('ses', 2)
  const unrelatedId = nativeId('ses', 3)
  // Project IDs are not prefixed IDs: v1.18.21 derives them from a remote URL
  // with Hash.fast(`git-remote:${normalizedRemote}`).
  const projectId = sha1('git-remote:fixture.invalid/freshell/managed-opencode')
  const selectedSentinel = `SELECTED_HISTORY_${nonce}`
  const baselineMessages = new Map<string, string>()
  const baselineParts = new Map<string, string>()
  const now = Date.now() - 600_000

  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(databasePath)
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
    db.exec(fs.readFileSync(path.join(repoRoot, 'crates/freshell-sessions/src/opencode_schema_v1_18_21.sql'), 'utf8'))
    db.exec('CREATE TABLE message_seq (session_id TEXT PRIMARY KEY, next INTEGER NOT NULL); CREATE TABLE provider_config (id TEXT PRIMARY KEY, value TEXT);')
    const insertMigration = db.prepare('INSERT INTO migration (id, time_completed) VALUES (?, ?)')
    MIGRATIONS.forEach((migration, index) => insertMigration.run(migration, index + 100))
    db.prepare('INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?)')
      .run(projectId, workspace, now, now, '[]')
    db.prepare('INSERT INTO project_directory (project_id, directory, time_created) VALUES (?, ?, ?)')
      .run(projectId, workspace, now)
    db.prepare('INSERT INTO permission (id, project_id, action, resource, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)')
      .run(nativeId('per', 0), projectId, 'read', '*', now, now)

    const insertSession = db.prepare(`INSERT INTO session
      (id, project_id, workspace_id, parent_id, slug, directory, title, version,
       time_created, time_updated, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, '1.18.21', ?, ?, ?)`)
    for (const [id, parent, title, offset] of [
      [rootId, null, `Synthetic managed OpenCode ${nonce}`, 0],
      [childId, rootId, `Synthetic child ${nonce}`, 1],
      [grandchildId, childId, `Synthetic grandchild ${nonce}`, 2],
      [unrelatedId, null, 'UNRELATED_SESSION_SENTINEL', 3],
    ] as const) {
      // These are ordinary local sessions. OpenCode 1.18.21 rejects prompts
      // attached to a workspace adapter that is not enabled in the TUI.
      insertSession.run(id, projectId, null, parent, id, workspace, title, now + offset, now + offset, JSON.stringify({ opaque: 'OPAQUE_ROW_SENTINEL' }))
    }

    const insertMessage = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
    const insertPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
    const tokens = { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    let lastMessageId = ''
    for (let index = 0; index < messageCount; index++) {
      const id = nativeId('msg', index)
      const time = now + 100 + index
      const assistant = index % 2 === 1
      const data = JSON.stringify(assistant
        ? {
          role: 'assistant',
          parentID: nativeId('msg', index - 1),
          providerID: 'openai',
          modelID: 'gpt-5.6-luna',
          mode: 'build',
          agent: 'build',
          path: { cwd: workspace, root: workspace },
          cost: 0,
          tokens,
          finish: 'stop',
          time: { created: time, completed: time },
        }
        : {
          role: 'user',
          agent: 'build',
          model: { providerID: 'openai', modelID: 'gpt-5.6-luna' },
          time: { created: time },
        })
      const part = JSON.stringify({ type: 'text', text: `${selectedSentinel}_${index}` })
      insertMessage.run(id, rootId, time, time, data)
      if (assistant) {
        const startId = nativeId('prt', index * 3)
        insertPart.run(startId, id, rootId, time, time, JSON.stringify({ type: 'step-start' }))
        baselineParts.set(startId, sha256(JSON.stringify({ type: 'step-start' })))
      }
      const textId = nativeId('prt', index * 3 + 1)
      insertPart.run(textId, id, rootId, time, time, part)
      baselineMessages.set(id, sha256(data))
      baselineParts.set(textId, sha256(part))
      if (assistant) {
        const finish = JSON.stringify({ type: 'step-finish', reason: 'stop', cost: 0, tokens })
        const finishId = nativeId('prt', index * 3 + 2)
        insertPart.run(finishId, id, rootId, time, time, finish)
        baselineParts.set(finishId, sha256(finish))
      }
      lastMessageId = id
    }
    for (const [messageIndex, id, label] of [
      [messageCount, childId, 'CHILD_HISTORY_SENTINEL'],
      [messageCount + 1, grandchildId, 'GRANDCHILD_HISTORY_SENTINEL'],
      [messageCount + 2, unrelatedId, 'UNRELATED_MESSAGE_SENTINEL'],
    ] as const) {
      const messageId = nativeId('msg', messageIndex)
      const partId = nativeId('prt', messageIndex * 3 + 1)
      const data = JSON.stringify({
        role: 'user',
        agent: 'build',
        model: { providerID: 'openai', modelID: 'gpt-5.6-luna' },
        time: { created: now + 500 },
      })
      const part = JSON.stringify({ type: 'text', text: label })
      insertMessage.run(messageId, id, now + 500, now + 500, data)
      insertPart.run(partId, messageId, id, now + 500, now + 500, part)
      if (id !== unrelatedId) {
        baselineMessages.set(messageId, sha256(data))
        baselineParts.set(partId, sha256(part))
      }
    }
    db.prepare('INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES (?, 1, ?)').run(rootId, `owner_${nonce}`)
    const rootInfo = {
      id: rootId,
      slug: rootId,
      projectID: projectId,
      directory: workspace,
      title: `Synthetic managed OpenCode ${nonce}`,
      version: '1.18.21',
      time: { created: now, updated: now },
    }
    db.prepare('INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, 1, ?, ?)')
      .run(nativeId('evt', 0), rootId, 'session.created.1', JSON.stringify({ sessionID: rootId, info: rootInfo }))
    db.prepare('INSERT INTO session_context_epoch (session_id, baseline, snapshot, baseline_seq) VALUES (?, ?, ?, 1)')
      .run(rootId, 'baseline', JSON.stringify({ opaque: 'CONTEXT_SENTINEL' }))
    db.prepare('INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run(rootId, 'synthetic todo', 'pending', 'high', now + 503, now + 503)
    db.prepare('INSERT INTO message_seq (session_id, next) VALUES (?, ?)').run(rootId, messageCount + 1)
    db.prepare('INSERT INTO account (id, email, url, access_token, refresh_token, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(`account_${nonce}`, 'synthetic@example.invalid', 'https://example.invalid', 'ACCOUNT_TOKEN_SENTINEL', 'ACCOUNT_REFRESH_SENTINEL', now, now)
    db.prepare('INSERT INTO control_account (email, url, access_token, refresh_token, active, time_created, time_updated) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run('synthetic@example.invalid', 'https://example.invalid', 'CONTROL_ACCOUNT_SENTINEL', 'CONTROL_REFRESH_SENTINEL', now, now)
    db.prepare('INSERT INTO credential (id, label, value, time_created, time_updated) VALUES (?, ?, ?, ?, ?)')
      .run(nativeId('cred', 0), 'synthetic', 'CREDENTIAL_VALUE_SENTINEL', now, now)
    db.prepare('INSERT INTO provider_config (id, value) VALUES (?, ?)').run(`provider_${nonce}`, 'PROVIDER_CONFIG_SENTINEL')
    return { databasePath, rootId, childId, grandchildId, unrelatedId, baselineMessages, baselineParts, lastMessageId, selectedSentinel }
  } finally {
    db.close()
  }
}

export const PHASE1_RUNTIME_IMAGE_TAG = 'ubuntu:24.04'
export const PHASE2_RUNTIME_IMAGE_TAG = 'freshell-managed-runtime:phase2'
export const CONTROL_PROTOCOL_VERSION = 2

type RunOwnedRuntimeImage = { tag: string; runId: string; candidateSha: string; digest?: string }

export function assertRunOwnedRuntimeImage(observed: unknown, context: RunOwnedRuntimeImage): void {
  const parsed = z.array(z.object({ Id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    RepoTags: z.array(z.string()), Config: z.object({ Labels: z.record(z.string(), z.string()) }) })).length(1).safeParse(observed)
  const image = parsed.success ? parsed.data[0] : undefined
  if (!image || (context.digest && image.Id !== context.digest) || !image.RepoTags.includes(context.tag)
    || image.Config.Labels['com.freshell.runtime-test-run-id'] !== context.runId
    || image.Config.Labels['com.freshell.runtime-test-candidate'] !== context.candidateSha) {
    throw new Error('runtime image is not the exact owned artifact')
  }
}

export function removeRunOwnedRuntimeImage(context: RunOwnedRuntimeImage, execute: typeof execFileSync = execFileSync): void {
  const tags = () => String(execute('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'],
    { encoding: 'utf8' })).trim().split('\n')
  if (!tags().includes(context.tag)) return
  const image: unknown = JSON.parse(String(execute('docker', ['image', 'inspect', context.tag], { encoding: 'utf8' })))
  assertRunOwnedRuntimeImage(image, context)
  execute('docker', ['image', 'rm', context.tag], { encoding: 'utf8' })
  if (tags().includes(context.tag)) throw new Error('exact owned runtime image tag remains after cleanup')
}

function runOwnedRuntimeImageTag(runId: string, candidateSha: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId)
    || !/^[a-f0-9]{40}$/.test(candidateSha)) throw new Error('exact workload image run and candidate required')
  return `freshell-managed-runtime:task008-${candidateSha.slice(0, 12)}-${runId}`
}

export function buildRunOwnedRuntimeImage(
  repoRoot: string, runId: string, candidateSha: string, execute: typeof execFileSync = execFileSync,
): { tag: string; digest: string } {
  const tag = runOwnedRuntimeImageTag(runId, candidateSha)
  execute('docker', ['build', '--pull=false', '--provenance=false', '--sbom=false',
    '--label', `com.freshell.runtime-test-run-id=${runId}`, '--label', `com.freshell.runtime-test-candidate=${candidateSha}`,
    '-f', 'docker/runtime/Dockerfile', '-t', tag, '.'], { cwd: repoRoot, stdio: 'inherit' })
  const digest = String(execute('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'], { encoding: 'utf8' })).trim()
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('run-owned runtime image has no pinned digest')
  return { tag, digest }
}

export type RuntimeOwnerIsolation = { bootstrapProviders: readonly QualifiableTerminalProvider[] }

export function runtimeProviderUserRoots(isolated: boolean, homeDir = os.homedir()): string[] {
  if (isolated) return []
  const roots: string[] = []
  for (const relative of ['.claude', '.codex', '.config/opencode', '.amplifier']) {
    try {
      const root = fs.realpathSync(path.join(homeDir, relative))
      if (fs.statSync(root).isDirectory()) roots.push(root)
    } catch {}
  }
  return roots
}

export function verifyRuntimeCleanupAbsence(
  expected: { containerIds: readonly string[]; volumes: readonly string[]; helperNames?: readonly string[] }, observed: unknown,
): void {
  const parsed = z.object({ containerIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
    volumes: z.array(z.string().min(1)), containerNames: z.array(z.string().min(1)).optional() }).strict().safeParse(observed)
  if (!parsed.success) throw new Error('runtime cleanup observation is missing or malformed')
  if (expected.helperNames?.length && !parsed.data.containerNames) throw new Error('runtime cleanup helper-name observation is missing')
  if (expected.containerIds.some(id => parsed.data.containerIds.includes(id))
    || expected.volumes.some(volume => parsed.data.volumes.includes(volume))
    || expected.helperNames?.some(name => parsed.data.containerNames?.includes(name))) throw new Error('exact owned runtime resource remains after cleanup')
}

export type RuntimeLimits = {
  cpuMilli: number
  memoryBytes: number
  swapBytes: number
  pidsMax: number
}

/** Current owned address; a saved native root alone never certifies LIVE. */
export type ExactRuntimeHandle = {
  runId: string
  candidateSha: string
  soulId: string
  incarnationId: string
  containerId: string
  hostBootId: string
  nativeSessionId: string
}

/** Installed binary facts can precede the first native session; they never qualify a root. */
export type RuntimeEnclosureHandle = Omit<ExactRuntimeHandle, 'nativeSessionId'>

export function createRuntimeEnclosureHandle(owner: { runId: string; candidateSha: string },
  view: Pick<ManagedRuntimeView, 'soulId' | 'incarnationId' | 'containerId' | 'hostBootId'>): RuntimeEnclosureHandle {
  if (!view.containerId || !/^[a-f0-9]{64}$/.test(view.containerId) || !view.hostBootId) throw new Error('exact runtime enclosure address required')
  return { runId: owner.runId, candidateSha: owner.candidateSha, soulId: view.soulId,
    incarnationId: view.incarnationId, containerId: view.containerId, hostBootId: view.hostBootId }
}

export type FixtureNativeState = {
  nativeSessionId: string
  pendingDecisionId: string | null
  dispatchCount: number
  completionCount: number
}

export type NativeToolEvidence = {
  requestIds: string[]
  resultIds: string[]
  replayCount: number
}
export type NativeChallengeKind = 'chaos-approval' | 'chaos-long-tool' | 'chaos-follow-up'
const NativeChallengeMarkers: Record<NativeChallengeKind, string> = {
  'chaos-approval': 'p5-chaos-approval-count', 'chaos-long-tool': 'p5-chaos-long-tool-count',
  'chaos-follow-up': 'P5_CHAOS_FOLLOWUP',
}
export type SyntheticOpenCodeChallenge = { challengeId: string; nativeSessionId: string; messageId: string; toolPartId: string }
const SYNTHETIC_OPENCODE_CHALLENGE_SCRIPT = String.raw`
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const [root, projectId, workspace, marker] = process.argv.slice(1);
const database = '/home/freshell/provider/.local/share/opencode/opencode.db';
const db = new DatabaseSync(database);
try {
  db.exec('BEGIN IMMEDIATE');
  if (db.prepare('SELECT id FROM session WHERE id = ?').all(root).length) throw new Error('synthetic root already exists');
  db.prepare('INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES (?,?,?,?,?)').run(projectId,workspace,1,1,'[]');
  db.prepare('INSERT INTO project_directory (project_id,directory,time_created) VALUES (?,?,?)').run(projectId,workspace,1);
  db.prepare('INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) VALUES (?,?,?,?,?,?,?,?)').run(root,projectId,'fixture',workspace,'Task008 synthetic challenge','1.18.21',1,1);
  const messageId='msg_'+projectId, toolPartId='prt_tool_'+projectId;
  db.prepare('INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)').run(messageId,root,1,1,
    JSON.stringify({role:'assistant',time:{created:1,completed:2},providerID:'synthetic-fixture',modelID:'synthetic-fixture'}));
  const part=db.prepare('INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)');
  part.run('prt_text_'+projectId,messageId,root,1,1,JSON.stringify({type:'text',text:marker+' synthetic owner-only challenge'}));
  part.run(toolPartId,messageId,root,2,2,JSON.stringify({type:'tool',tool:'synthetic-fixture',state:{status:'completed',input:{marker}}}));
  db.exec('COMMIT');
  const session=db.prepare('SELECT id FROM session WHERE id = ?').get(root);
  const message=db.prepare('SELECT id FROM message WHERE session_id = ?').get(root);
  const tool=db.prepare('SELECT id FROM part WHERE session_id = ? AND id = ?').get(root,toolPartId);
  process.stdout.write(JSON.stringify({nativeSessionId:session.id,messageId:message.id,toolPartId:tool.id}));
} catch(error) { try {db.exec('ROLLBACK')} catch {} throw error }
finally {db.close()}
`

export const OPENCODE_TOOL_EVIDENCE_SCRIPT = String.raw`
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const filename = process.argv[1];
const sessionId = process.argv[2];
const marker = process.argv[3];
if (!filename || !sessionId || !marker) throw new Error('tool probe requires an exact store, session, and marker');
if (!fs.existsSync(filename)) {
  process.stdout.write(JSON.stringify({ requestIds: [], resultIds: [], replayCount: 0 }));
} else {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;');
    const rows = db.prepare('SELECT id, data FROM part WHERE session_id = ? ORDER BY time_created, id LIMIT 512').all(sessionId);
    const matches = [];
    for (const row of rows) {
      const part = JSON.parse(row.data);
      if (part.type !== 'tool' || !JSON.stringify(part).includes(marker)) continue;
      matches.push({ id: row.id, completed: part.state?.status === 'completed' });
    }
    process.stdout.write(JSON.stringify({
      requestIds: matches.map((row) => row.id),
      resultIds: matches.filter((row) => row.completed).map((row) => row.id),
      replayCount: Math.max(0, matches.length - 1),
    }));
  } catch {
    console.error('native tool evidence query failed');
    process.exitCode = 1;
  } finally { db.close(); }
}
`

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

const PROVIDER_HISTORY_DIGESTS = String.raw`
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const root = process.argv[2];
const hash = (value) => createHash('sha256').update(value).digest('hex');
try {
  db.exec('PRAGMA query_only = ON; BEGIN;');
  const descendants = db.prepare('WITH RECURSIVE ids(id) AS (SELECT id FROM session WHERE id = ? UNION ALL SELECT child.id FROM session child JOIN ids ON child.parent_id = ids.id) SELECT id FROM ids ORDER BY id').all(root).map((row) => row.id);
  const messages = db.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id');
  const parts = db.prepare('SELECT id, data FROM part WHERE session_id = ? ORDER BY time_created, id');
  const output = { sessions: descendants, messages: {}, parts: {} };
  for (const id of descendants) {
    for (const row of messages.all(id)) output.messages[row.id] = hash(row.data);
    for (const row of parts.all(id)) output.parts[row.id] = hash(row.data);
  }
  db.exec('COMMIT;');
  process.stdout.write(JSON.stringify(output));
} finally { db.close(); }
`

const PROVIDER_SENTINEL_SCAN = String.raw`
const { DatabaseSync } = require('node:sqlite');
const sentinels = JSON.parse(process.argv[2]);
const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const matches = new Set();
try {
  db.exec('PRAGMA query_only = ON; BEGIN;');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  for (const { name } of tables) {
    const columns = db.prepare('PRAGMA table_info(' + quote(name) + ')').all();
    const rows = db.prepare('SELECT * FROM ' + quote(name)).all();
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (typeof value !== 'string') continue;
        for (const sentinel of sentinels) if (value.includes(sentinel)) matches.add(sentinel);
      }
    }
  }
  db.exec('COMMIT;');
  process.stdout.write(JSON.stringify([...matches].sort()));
} finally { db.close(); }
`

export type RuntimeHostFacts = {
  workerPid: number
  workerLaunchCount: number
  limits: { cpuMax: string; memoryMax: string; swapMax: string; pidsMax: string }
  unsafeBrokerAttempts: number
}

export const SyntheticOpenCodeSourceFactsSchema = z.object({
  rootId: z.string().min(1), childId: z.string().min(1), grandchildId: z.string().min(1),
  unrelatedId: z.string().min(1), lastMessageId: z.string().min(1), nonce: z.string().regex(/^[a-f0-9]{16}$/),
  baselineMessages: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  baselineParts: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  rootMessageCount: z.number().int().nonnegative(),
}).strict()
export type SyntheticOpenCodeSourceFacts = z.infer<typeof SyntheticOpenCodeSourceFactsSchema>

export const SyntheticOpenCodeHistoryFactsSchema = z.object({
  sessions: z.array(z.string().min(1)),
  messages: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  parts: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
}).strict()
export type SyntheticOpenCodeHistoryFacts = z.infer<typeof SyntheticOpenCodeHistoryFactsSchema>

export const FreshAgentLaunchFactsSchema = z.object({ provider: z.enum(['claude', 'codex', 'opencode']),
  version: z.string().regex(/^\d+\.\d+\.\d+$/), workerPid: z.number().int().min(2) }).strict()
export type FreshAgentLaunchFacts = z.infer<typeof FreshAgentLaunchFactsSchema>
export const RuntimeWebProcessFactsSchema = z.object({ pid: z.number().int().positive(),
  bootAttemptCount: z.number().int().positive() }).strict()
export type RuntimeWebProcessFacts = z.infer<typeof RuntimeWebProcessFactsSchema>
export const RuntimeSupervisorProcessFactsSchema = z.object({ containerId: z.string().regex(/^[a-f0-9]{64}$/),
  pid: z.number().int().min(2) }).strict()
export type RuntimeSupervisorProcessFacts = z.infer<typeof RuntimeSupervisorProcessFactsSchema>
export const RuntimeChaosWebOutputFactsSchema = z.object({ contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentBytes: z.number().int().nonnegative(), containsFollowUpMarker: z.boolean(), containsAuthToken: z.boolean() }).strict()
export type RuntimeChaosWebOutputFacts = z.infer<typeof RuntimeChaosWebOutputFactsSchema>

export const OwnedContainerStateSchema = z.discriminatedUnion('present', [
  z.object({ present: z.literal(false), running: z.literal(false) }).strict(),
  z.object({ present: z.literal(true), running: z.boolean() }).strict(),
])
export type OwnedContainerState = z.infer<typeof OwnedContainerStateSchema>

export const Phase3BrowserObservationSchema = z.object({
  browserInteraction: z.boolean(), provider: z.literal('opencode'), providerVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  model: z.string().min(1).max(200), paneId: z.string().min(1).max(200), terminalId: z.string().min(1).max(200),
  soulId: z.string().min(1).max(200), incarnationIdBefore: z.string().min(1).max(200), incarnationIdAfter: z.string().min(1).max(200),
  providerSessionIdBefore: z.string().min(1).max(200), providerSessionIdAfter: z.string().min(1).max(200),
  approvalPromptNativeId: z.string().min(1).max(200), permissionPromptHandled: z.boolean(), approvalSurvived: z.boolean(),
  samePane: z.boolean(), visibleRecoveryState: z.boolean(), rejectedInputWhileRecovering: z.boolean(), accidentalApproval: z.boolean(),
  toolCompletedExactlyOnce: z.boolean(), providerHostSurvivedWebRestart: z.boolean(), followUpCompleted: z.boolean(),
  followUpResponse: z.literal('P3_FOLLOWUP_OK'),
}).strict()
export type Phase3BrowserObservation = z.infer<typeof Phase3BrowserObservationSchema>

const RuntimeOwnerOperationRequestSchema = z.object({
  runId: z.string().min(1), candidateSha: z.string().regex(/^[a-f0-9]{40}$/),
  scenarioId: z.string().min(1), operationId: z.string().min(1),
  action: z.enum([
    'describe', 'inventory', 'inventory-snapshot', 'control-epoch', 'writer-claim', 'host-facts', 'fixture-state', 'fixture-worker',
    'provider-volume', 'fixture-decision-allow',
    'replace-web', 'replace-web-graceful', 'replace-supervisor', 'replace-supervisor-abrupt', 'web-process-facts', 'supervisor-process-facts',
    'managed-opt-in', 'opencode-version', 'fresh-agent-launch-facts', 'container-state', 'phase3-effect-reset', 'phase3-effect-count', 'crash-provider-worker',
    'crash-host', 'crash-provider', 'hold-host', 'release-host',
    'native-tool-evidence', 'native-follow-up-ids', 'stop-soul', 'finish', 'abort', 'incident-matches-soul',
    'native-challenge-register', 'native-effect-count', 'native-effect-reset', 'chaos-web-output', 'chaos-long-tool-running',
    'synthetic-history-challenge',
    'synthetic-source-facts',
    'synthetic-source-history', 'synthetic-source-exclusions',
    'synthetic-source-adoption',
    'synthetic-source-follow-up',
    'phase3-browser-receipt',
    'retained-start', 'retained-status', 'retained-observed', 'retained-finish',
  ]),
  handle: z.object({
    runId: z.string().min(1), candidateSha: z.string().regex(/^[a-f0-9]{40}$/),
    soulId: z.string().min(1), incarnationId: z.string().min(1), containerId: z.string().regex(/^[a-f0-9]{64}$/),
    hostBootId: z.string().min(1), nativeSessionId: z.string().min(1),
  }).strict().optional(),
  enclosure: z.object({ runId: z.string().min(1), candidateSha: z.string().regex(/^[a-f0-9]{40}$/),
    soulId: z.string().min(1), incarnationId: z.string().min(1), containerId: z.string().regex(/^[a-f0-9]{64}$/),
    hostBootId: z.string().min(1) }).strict().optional(),
  challengeId: z.string().min(1).optional(),
  incidentId: z.string().min(1).max(200).optional(),
  expectedControlEpoch: z.number().int().nonnegative().optional(),
  expectedIntentRevision: z.number().int().nonnegative().optional(),
  generation: z.number().int().nonnegative().optional(),
  phase3Browser: Phase3BrowserObservationSchema.optional(),
}).strict()

export type RuntimeOwnerOperationRequest = z.infer<typeof RuntimeOwnerOperationRequestSchema>

export type RuntimeWriterClaimFacts = {
  provider: string; providerStoreId: string; nativeSessionId: string; soulId: string; incarnationId: string
  activeClaimCount: number; globalConflictingClaimCount: number
}

export const ManagedMigrationFactsSchema = ManagedRuntimeMigrationPlanSchema.omit({ registryBackupPath: true }).strip()
export type ManagedMigrationFacts = z.infer<typeof ManagedMigrationFactsSchema>

export const ManagedStopResultSchema = z.object({
  outcome: z.enum(['verified_empty', 'blocked_ownership', 'backend_unavailable', 'termination_unconfirmed']),
  view: ManagedRuntimeSoulSchema,
}).strict()
export type ManagedStopResult = z.infer<typeof ManagedStopResultSchema>

/** A run keeps operation settlements until teardown so a lost reply cannot repeat a mutation. */
export class RuntimeOwnerOperationQueue {
  private tail: Promise<void> = Promise.resolve()
  private readonly operations = new Map<string, { fingerprint: string; result: Promise<unknown> }>()

  constructor(
    private readonly runId: string, private readonly candidateSha: string, private readonly scenarioId: string,
    private readonly execute: (request: RuntimeOwnerOperationRequest) => Promise<unknown>,
  ) {}

  async perform(input: unknown): Promise<unknown> {
    const parsed = RuntimeOwnerOperationRequestSchema.safeParse(input)
    if (!parsed.success) throw new Error('invalid closed owner operation')
    const request = parsed.data
    if (request.runId !== this.runId || request.candidateSha !== this.candidateSha || request.scenarioId !== this.scenarioId
      || (request.handle && (request.handle.runId !== this.runId || request.handle.candidateSha !== this.candidateSha))
      || (request.enclosure && (request.enclosure.runId !== this.runId || request.enclosure.candidateSha !== this.candidateSha))) {
      throw new Error('owner operation does not belong to this owned run, candidate and scenario')
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const previous = this.operations.get(request.operationId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('owner operation ID was reused for a different request')
      return previous.result
    }
    const result = this.tail.then(() => this.execute(request))
    this.operations.set(request.operationId, { fingerprint, result })
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

export type RuntimeOwnerInventoryRow = Pick<ExactRuntimeHandle,
  'soulId' | 'incarnationId' | 'containerId' | 'hostBootId' | 'nativeSessionId'> & { launchState: string }

export interface RuntimeOwnerFactsAdapter {
  readonly runId: string
  readonly candidateSha: string
  inventory(): Promise<readonly RuntimeOwnerInventoryRow[]>
  receipts(): readonly Pick<BrokerReceipt, 'soulId' | 'incarnationId' | 'containerId'>[]
  readHostFacts(handle: ExactRuntimeHandle): Promise<unknown>
}

export const RuntimeHandleMismatchFieldsSchema = z.array(z.enum([
  'inventoryMembership', 'launchState', 'incarnationId', 'containerId', 'hostBootId', 'nativeSessionId',
])).min(1)

export async function assertExactRuntimeHandle(
  owner: Omit<RuntimeOwnerFactsAdapter, 'readHostFacts'>, handle: ExactRuntimeHandle,
): Promise<void> {
  if (handle.runId !== owner.runId || handle.candidateSha !== owner.candidateSha
    || !/^[a-f0-9]{40}$/.test(handle.candidateSha) || !/^[a-f0-9]{64}$/.test(handle.containerId)
    || ['runId', 'soulId', 'incarnationId', 'hostBootId', 'nativeSessionId'].some(
      (key) => typeof handle[key as keyof ExactRuntimeHandle] !== 'string' || !handle[key as keyof ExactRuntimeHandle].trim(),
    )) throw new Error('exact owned runtime handle required')
  if (!owner.receipts().some((receipt) => receipt.containerId === handle.containerId
    && receipt.soulId === handle.soulId && receipt.incarnationId === handle.incarnationId)) {
    throw new Error('runtime handle has no exact owned broker receipt')
  }
  const rows = (await owner.inventory()).filter((row) => row.soulId === handle.soulId && row.launchState !== 'stopped')
  const row = rows[0]
  const mismatches: z.infer<typeof RuntimeHandleMismatchFieldsSchema> = []
  if (rows.length !== 1) mismatches.push('inventoryMembership')
  else {
    if (row.launchState !== 'running') mismatches.push('launchState')
    for (const field of ['incarnationId', 'containerId', 'hostBootId', 'nativeSessionId'] as const) {
      if (row[field] !== handle[field]) mismatches.push(field)
    }
  }
  if (mismatches.length) {
    throw Object.assign(new Error('runtime handle is not the current exact owned incarnation and root'), {
      runtimeHandleMismatches: mismatches,
    })
  }
}

function objectFields(value: unknown, reason: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(reason)
  return value as Record<string, unknown>
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function decodeFixtureNativeState(value: unknown, nativeSessionId: string): FixtureNativeState {
  const state = objectFields(value, 'invalid native fixture state')
  if (!nativeSessionId || state.nativeSessionId !== nativeSessionId
    || !(state.pendingDecisionId === null || (typeof state.pendingDecisionId === 'string' && state.pendingDecisionId.length > 0))
    || !nonnegativeInteger(state.dispatchCount) || !nonnegativeInteger(state.completionCount)) {
    throw new Error('invalid or conflicting native fixture state')
  }
  return {
    nativeSessionId, pendingDecisionId: state.pendingDecisionId,
    dispatchCount: state.dispatchCount, completionCount: state.completionCount,
  }
}

export async function readExactRuntimeHostFacts(
  owner: RuntimeOwnerFactsAdapter, handle: ExactRuntimeHandle,
): Promise<RuntimeHostFacts> {
  await assertExactRuntimeHandle(owner, handle)
  const facts = objectFields(await owner.readHostFacts(handle), 'invalid observed owner facts')
  const limits = objectFields(facts.limits, 'invalid observed owner facts limits')
  if (!nonnegativeInteger(facts.workerPid) || facts.workerPid === 0
    || !nonnegativeInteger(facts.workerLaunchCount) || facts.workerLaunchCount === 0
    || !nonnegativeInteger(facts.unsafeBrokerAttempts)
    || typeof limits.cpuMax !== 'string' || !/^(?:max|[1-9][0-9]*) [1-9][0-9]*$/.test(limits.cpuMax)
    || ['memoryMax', 'swapMax', 'pidsMax'].some((key) => (
      typeof limits[key] !== 'string' || !/^(?:max|[0-9]+)$/.test(limits[key] as string)
    ))) throw new Error('invalid observed owner facts')
  return {
    workerPid: facts.workerPid, workerLaunchCount: facts.workerLaunchCount,
    unsafeBrokerAttempts: facts.unsafeBrokerAttempts,
    limits: {
      cpuMax: limits.cpuMax, memoryMax: limits.memoryMax as string,
      swapMax: limits.swapMax as string, pidsMax: limits.pidsMax as string,
    },
  }
}

export async function settleOwnedRuntimeCleanup(
  stopWeb: () => Promise<void>, cleanupRuntime: () => Promise<{ ok: boolean; errors: string[] }>,
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = []
  try { await stopWeb() } catch (error) { errors.push(`web stop: ${error instanceof Error ? error.message : String(error)}`) }
  let runtimeOk = false
  try {
    const result = await cleanupRuntime()
    runtimeOk = result.ok
    errors.push(...result.errors)
  } catch (error) {
    errors.push(`runtime cleanup: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { ok: runtimeOk && errors.length === 0, errors }
}

export type SupervisorInstance = {
  scenarioId: string
  containerId: string
  controlSocket: string
  controlSecret: string
  controlSecretFile: string
  runtimeRoot: string
  volumeName: string
  binaryKind: 'test' | 'release'
}

export type AdminError = {
  code: string
  message: string
}

export type AdminReply = {
  requestId: string
  result: { Ok?: any; Err?: AdminError }
}

export type AssertionRecord = {
  at: string
  caseId: string
  pass: boolean
  message: string
  evidence?: unknown
}

export type ProviderQualificationBuildRecord = {
  kind: 'production' | 'qualification_fixture'
  serverFeatures: string[]
  supervisorFeatures: string[]
  qualificationProviders: string[]
  serverBinary: string
  supervisorBinary: string
}

export type FreshAgentQualificationBuildRecord = {
  kind: 'production' | 'deterministic_fixture'
  serverFeatures: string[]
  sessionHostFeatures: string[]
  selectedModes: string[]
  fixtureModes: string[]
  serverBinary: string
  supervisorBinary: string
  sessionHostBinary: string
}

export function phase2BootstrapFiles(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const files = new Set<string>()
  const addRegularFile = (candidate: string | undefined) => {
    if (!candidate) return
    try {
      const resolved = fs.realpathSync(candidate)
      if (fs.statSync(resolved).isFile()) files.add(resolved)
    } catch {}
  }
  for (const key of [
    'FRESHELL_MANAGED_CLAUDE_CREDENTIAL_FILE',
    'FRESHELL_MANAGED_CODEX_AUTH_FILE',
  ]) {
    addRegularFile(env[key]?.trim())
  }
  for (const provider of ['claude', 'codex', 'opencode', 'amplifier'] as const) {
    for (const grant of configuredProviderOnecliGrantFiles(provider, env)) files.add(grant)
  }
  return [...files]
}

export class RuntimeGateAssertionError extends Error {
  constructor(
    readonly caseId: string,
    message: string,
    readonly evidence?: unknown,
  ) {
    super(`[${caseId}] ${message}`)
  }
}

export class RuntimeGateBlockedError extends Error {
  constructor(
    readonly caseId: string,
    message: string,
    readonly evidence?: unknown,
  ) {
    super(`[${caseId}] BLOCKED: ${message}`)
  }
}

type Task2FixtureArtifact = { path: string; sha256: string }
type NativeArtifacts = {
  candidateSha: string
  imageDigest: string
  supervisor: Task2FixtureArtifact
  host: Task2FixtureArtifact
  server?: Task2FixtureArtifact
  sourceFiles: { name: string; path: string; sha256: string }[]
}
type Task2FixtureArtifacts = {
  candidateSha: string
  imageDigest: string
  currentSupervisor: Task2FixtureArtifact
  currentHost: Task2FixtureArtifact
  currentServer: Task2FixtureArtifact
  legacySupervisor: Task2FixtureArtifact
  legacyHost: Task2FixtureArtifact
  legacyCreatorCommit: '7dbc7ef6b0b87e47ec8386e19115f5e440399898'
}


export class RuntimeHarness {
  private task2FiniteFixtures = false
  task2ServerBinary = ""
  readonly repoRoot: string
  readonly phase: 1 | 2 | 3 | 4 | 5
  readonly runId: string
  readonly candidateSha: string
  readonly testRoot: string
  readonly evidenceDir: string
  readonly buildDir: string
  readonly assertionsPath: string
  readonly lifecyclePath: string
  readonly incidentsDir: string
  readonly browserDir: string

  imageRef = ''
  private ownedImage?: RunOwnedRuntimeImage
  broker!: RestrictedDockerBroker
  testSupervisorBinary = ''
  testHostBinary = ''
  releaseSupervisorBinary = ''
  releaseHostBinary = ''

  private readonly trackedContainers = new Set<string>()
  private readonly trackedSupervisorContainers = new Set<string>()
  private readonly trackedForeignContainers = new Set<string>()
  private readonly trackedVolumes = new Set<string>()
  private readonly assertions: AssertionRecord[] = []
  private brokerStarted = false

  constructor(repoRoot: string, runId = randomUUID(), phase: 1 | 2 | 3 | 4 | 5 = 1,
    private readonly ownerIsolation?: RuntimeOwnerIsolation) {
    this.repoRoot = fs.realpathSync(repoRoot)
    this.phase = phase
    this.runId = runId
    this.candidateSha = git(this.repoRoot, ['rev-parse', 'HEAD']).trim()
    // A shared /tmp/frt can belong to another account on multi-user hosts.
    // Keep the short socket path while isolating each account's test runs.
    const userId = (process.getuid?.() ?? process.pid).toString(36)
    this.testRoot = path.join(os.tmpdir(), `f${userId}`, runId.slice(0, 12))
    this.evidenceDir = path.join(this.repoRoot, '.runtime-evidence', this.candidateSha, runId)
    this.buildDir = path.join(this.repoRoot, '.runtime-build', this.runId)
    this.assertionsPath = path.join(this.evidenceDir, 'assertions.jsonl')
    this.lifecyclePath = path.join(this.evidenceDir, 'lifecycle.jsonl')
    this.incidentsDir = path.join(this.evidenceDir, 'incidents')
    this.browserDir = path.join(this.evidenceDir, 'browser')
  }

  async prepare(): Promise<void> {
    fs.rmSync(this.testRoot, { recursive: true, force: true })
    fs.mkdirSync(this.testRoot, { recursive: true, mode: 0o700 })
    ensurePrivateDirectory(this.evidenceDir)
    ensurePrivateDirectory(this.incidentsDir)
    ensurePrivateDirectory(this.browserDir)
    if (this.phase === 1) {
      writePrivateJson(path.join(this.browserDir, 'not-applicable.json'), { reason: 'Phase 1 has no browser surface; the live gate exercises the supervisor/runtime IPC directly.' })
    }

    const sourceManifest = JSON.parse(fs.readFileSync(path.join(this.repoRoot, 'test/runtime/gate-manifest.json'), 'utf8'))
    writePrivateJson(path.join(this.evidenceDir, 'manifest.json'), { ...sourceManifest, execution: { candidateSha: this.candidateSha, runId: this.runId, startedAt: new Date().toISOString() } })
    const providerResults = this.phase === 1
      ? { phase: 'phase-1', externalProviders: 'not-applicable', fixtures: ['heartbeat', 'descendant_spawner', 'cpu_burner', 'memory_allocator', 'native_session', 'security_probe'] }
      : this.phase === 2
        ? { phase: 'phase-2', opencode: { status: 'pending-live-gate', version: '1.18.21', modelProvider: 'openai', model: 'openai/gpt-5.6-luna', freeTier: false }, workloadImage: 'pinned' }
        : this.phase === 3
          ? {
              phase: 'phase-3',
              deterministicFixture: { provider: 'native-session-fixture', status: 'pending-live-gate' },
              providers: {
                claude: { status: 'pending-receipt', requiredModel: 'haiku', reasoning: 'lowest' },
                opencode: { status: 'pending-receipt', version: '1.18.21', modelProvider: 'openai', model: 'openai/gpt-5.6-luna', freeTier: false },
                codex: { status: 'pending-receipt', version: '0.147.0', requiredModel: 'gpt-5.6-luna', reasoning: 'lowest' },
                amplifier: { status: 'pending-receipt', version: '0.1.1', commit: '1873aa980535c99a743b17172e4231833f6c8741' },
              },
            }
          : this.phase === 4
            ? {
                phase: 'phase-4',
                startupReconciliation: 'pending-live-gate',
                durableViewIntents: 'pending-live-gate',
                browserRehydration: 'pending-receipt',
                compatibilityFallback: 'pending-live-gate',
              }
            : {
                phase: 'phase-5',
                lossCertification: 'pending-live-gate',
                incidentBeforeCleanup: 'pending-live-gate',
                durableNotices: 'pending-browser-receipt',
                chaos: 'pending-live-gate',
                migrationRollback: 'pending-live-gate',
              }
    writePrivateJson(path.join(this.evidenceDir, 'provider-results.json'), providerResults)

    this.recordLifecycle('gate.prepare.started', { repoRoot: this.repoRoot, candidateSha: this.candidateSha, runId: this.runId })
    this.ensureRuntimeImage()
    this.buildBinaries()

    const realSocketPath = dockerSocketPath()
    const proxySocketPath = path.join(this.testRoot, 'broker', 'docker.sock')
    this.broker = new RestrictedDockerBroker({
      realSocketPath,
      proxySocketPath,
      runtimeRootPrefix: path.join(this.testRoot, 'r'),
      allowedHostBinaryPaths: new Set([this.testHostBinary, this.releaseHostBinary]),
      allowedImageRefs: new Set([this.imageRef]),
      allowTerminalWorkloads: this.phase >= 2,
      allowedWorkspaceRoots: new Set(this.phase >= 2 ? this.phase2WorkspaceRoots() : []),
      allowedProviderUserRoots: new Set(this.phase >= 2 ? this.phase2ProviderUserRoots() : []),
      allowedBootstrapFiles: new Set(this.phase >= 2 ? this.phase2BootstrapFiles() : []),
      testRunId: this.runId,
      logPath: path.join(this.evidenceDir, 'broker.jsonl'),
    })
    await this.broker.start()
    this.brokerStarted = true

    writePrivateJson(path.join(this.evidenceDir, 'ownership-before.json'), { brokerReceipts: [], trackedContainers: [] })
    writePrivateJson(path.join(this.evidenceDir, 'capabilities.json'), this.collectCapabilities())
    writePrivateJson(path.join(this.evidenceDir, 'build.json'), this.collectBuildInfo())
    this.recordLifecycle('gate.prepare.completed', { imageRef: this.imageRef, brokerSocket: proxySocketPath })
  }

  async prepareNativeArtifacts(input: NativeArtifacts): Promise<{ sourceRoot: string; files: { name: string; path: string; sha256: string }[]; serverPath?: string }> {
    // Phase one avoids the existing broad qualification home/bootstrap mounts.
    // The explicit immutable image, actual binaries and native selectors define
    // this experiment; no phase label establishes provider qualification.
    if (this.phase !== 1 || input.candidateSha !== this.candidateSha
      || !/^sha256:[a-f0-9]{64}$/.test(input.imageDigest) || !await dockerIsRootless()) {
      throw new Error('finite native preparation requires exact candidate/image and rootless Docker')
    }
    if ((await docker(['image', 'inspect', input.imageDigest, '--format', '{{.Id}}'])).trim() !== input.imageDigest) {
      throw new Error('native image identity mismatch')
    }
    const fileBytes = (file: Task2FixtureArtifact, executable: boolean): Buffer => {
      const metadata = fs.lstatSync(file.path)
      if (!path.isAbsolute(file.path) || fs.realpathSync(file.path) !== file.path || !metadata.isFile()
        || (executable && (metadata.mode & 0o222) !== 0) || !/^[a-f0-9]{64}$/.test(file.sha256)) {
        throw new Error('exact native file artifact required')
      }
      const bytes = fs.readFileSync(file.path)
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('native file artifact changed')
      return bytes
    }
    const binaries = [input.supervisor, input.host]
    for (const binary of binaries) fileBytes(binary, true)
    if (input.server) fileBytes(input.server, true)
    const names = new Set<string>()
    for (const file of input.sourceFiles) {
      if (!/^(claude|kilroy|codex|opencode|amplifier)\/[a-zA-Z0-9._/-]+$/.test(file.name)
        || file.name.split('/').some((part) => !part || part === '.' || part === '..') || names.has(file.name)) {
        throw new Error('unique selected native source name required')
      }
      names.add(file.name)
      fileBytes(file, false)
    }
    if (fs.existsSync(this.testRoot) || fs.existsSync(this.buildDir)) throw new Error('native run already exists')
    for (const directory of [this.testRoot, this.buildDir, this.evidenceDir, this.incidentsDir, this.browserDir]) ensurePrivateDirectory(directory)
    const destinations = ['freshell-supervisor-native', 'freshell-session-host-native']
    for (const [index, binary] of binaries.entries()) {
      const destination = path.join(this.buildDir, destinations[index]!)
      fs.writeFileSync(destination, fileBytes(binary, true), { flag: 'wx', mode: index === 1 ? 0o550 : 0o500 })
      if (createHash('sha256').update(fs.readFileSync(destination)).digest('hex') !== binary.sha256) throw new Error('native executable copy changed')
    }
    const serverPath = input.server ? path.join(this.buildDir, 'freshell-server-native') : undefined
    if (input.server && serverPath) {
      fs.writeFileSync(serverPath, fileBytes(input.server, true), { flag: 'wx', mode: 0o500 })
      if (createHash('sha256').update(fs.readFileSync(serverPath)).digest('hex') !== input.server.sha256) throw new Error('native server executable copy changed')
    }
    const sourceRoot = path.join(this.testRoot, 'native-source')
    ensurePrivateDirectory(sourceRoot)
    const files = input.sourceFiles.map((source) => {
      const destination = path.join(sourceRoot, source.name)
      ensurePrivateDirectory(path.dirname(destination))
      fs.writeFileSync(destination, fileBytes(source, false), { flag: 'wx', mode: 0o600 })
      if (createHash('sha256').update(fs.readFileSync(destination)).digest('hex') !== source.sha256) throw new Error('native selected source copy changed')
      return { name: source.name, path: destination, sha256: source.sha256 }
    })
    this.imageRef = input.imageDigest
    this.testSupervisorBinary = this.releaseSupervisorBinary = path.join(this.buildDir, destinations[0]!)
    this.testHostBinary = this.releaseHostBinary = path.join(this.buildDir, destinations[1]!)
    this.broker = new RestrictedDockerBroker({
      realSocketPath: dockerSocketPath(), proxySocketPath: path.join(this.testRoot, 'broker/docker.sock'),
      runtimeRootPrefix: path.join(this.testRoot, 'r'), allowedHostBinaryPaths: new Set([this.testHostBinary]),
      allowedImageRefs: new Set([this.imageRef]), allowTerminalWorkloads: true,
      allowedWorkspaceRoots: new Set([this.testRoot]), allowedProviderUserRoots: new Set([sourceRoot]),
      allowedBootstrapFiles: new Set(files.map((file) => file.path)), testRunId: this.runId,
      logPath: path.join(this.evidenceDir, 'broker.jsonl'),
    })
    await this.broker.start()
    this.brokerStarted = true
    this.writeArtifact('native-artifacts.json', { ...input, preparedSources: files })
    return { sourceRoot, files, ...(serverPath ? { serverPath } : {}) }
  }

  async prepareTask2FixtureArtifacts(input: Task2FixtureArtifacts): Promise<void> {
    if (input.candidateSha !== this.candidateSha || !/^sha256:[a-f0-9]{64}$/.test(input.imageDigest)
      || input.legacyCreatorCommit !== '7dbc7ef6b0b87e47ec8386e19115f5e440399898'
      || !dockerIsRootless()) throw new Error('exact current/legacy artifacts and rootless Docker required')
    if (docker(['image', 'inspect', input.imageDigest, '--format', '{{.Id}}']).trim() !== input.imageDigest)
      throw new Error('immutable fixture image mismatch')
    const artifacts = [input.currentSupervisor, input.currentHost, input.legacySupervisor, input.legacyHost, input.currentServer]
    // Inputs must be prebuilt immutable private copies. Refuse symlinks and hash
    // before copying; hash each copy afterward to catch changed inputs.
    for (const artifact of artifacts) {
      const stat = fs.lstatSync(artifact.path)
      if (!path.isAbsolute(artifact.path) || fs.realpathSync(artifact.path) !== artifact.path
        || !stat.isFile() || (stat.mode & 0o222) !== 0 || !/^[a-f0-9]{64}$/.test(artifact.sha256)
        || createHash('sha256').update(fs.readFileSync(artifact.path)).digest('hex') !== artifact.sha256)
        throw new Error('immutable exact fixture binary required')
    }
    if (fs.existsSync(this.testRoot) || fs.existsSync(this.buildDir)) throw new Error('fixture run already exists')
    fs.mkdirSync(this.testRoot, { recursive: true, mode: 0o700 })
    fs.mkdirSync(this.buildDir, { recursive: true, mode: 0o700 })
    for (const directory of [this.evidenceDir, this.incidentsDir, this.browserDir]) ensurePrivateDirectory(directory)
    const names = ['freshell-supervisor-test', 'freshell-session-host-test', 'task002-legacy-supervisor', 'task002-prefixed-session-host', 'task002-server']
    for (const [index, artifact] of artifacts.entries()) {
      const destination = path.join(this.buildDir, names[index]!)
      fs.copyFileSync(artifact.path, destination, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(destination, index === 1 || index === 3 ? 0o550 : 0o500)
      if (createHash('sha256').update(fs.readFileSync(destination)).digest('hex') !== artifact.sha256)
        throw new Error('fixture copy changed')
    }
    this.imageRef = input.imageDigest
    this.task2ServerBinary = path.join(this.buildDir, names[4]!)
    this.testSupervisorBinary = this.releaseSupervisorBinary = path.join(this.buildDir, names[0]!)
    this.testHostBinary = this.releaseHostBinary = path.join(this.buildDir, names[1]!)
    this.task2FiniteFixtures = true
    this.broker = new RestrictedDockerBroker({
      realSocketPath: dockerSocketPath(), proxySocketPath: path.join(this.testRoot, 'broker/docker.sock'),
      runtimeRootPrefix: path.join(this.testRoot, 'r'),
      allowedHostBinaryPaths: new Set([this.testHostBinary, path.join(this.buildDir, names[3]!)]),
      allowedImageRefs: new Set([this.imageRef]), allowTerminalWorkloads: true,
      allowedWorkspaceRoots: new Set([this.testRoot]), allowedProviderUserRoots: new Set(),
      allowTask2LegacyNegativeFixtures: true,
      allowedBootstrapFiles: new Set(), testRunId: this.runId, logPath: path.join(this.evidenceDir, 'broker.jsonl'),
    })
    await this.broker.start()
    this.brokerStarted = true
    this.writeArtifact('task002-artifacts.json', input)
  }

  /** Finite offline transfer qualification; no ambient homes/grants or broker. */
  async prepareTransfer(imageDigest: string): Promise<void> {
    if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest) || !dockerIsRootless()) {
      throw new Error('transfer requires an exact immutable image and rootless Docker')
    }
    const inspected = docker(['image', 'inspect', imageDigest, '--format', '{{.Id}}']).trim()
    if (inspected !== imageDigest) throw new Error('transfer image identity mismatch')
    if (fs.existsSync(this.testRoot)) throw new Error('transfer scratch already exists')
    fs.mkdirSync(this.testRoot, { recursive: true, mode: 0o700 })
    ensurePrivateDirectory(this.evidenceDir)
    this.imageRef = imageDigest
    this.recordLifecycle('transfer.prepare.completed', { imageDigest, candidateSha: this.candidateSha })
  }

  startTransferProvider(stageBinary: string, schemaFile: string, migrationsFile: string, workspacePaths: readonly string[] = []): { containerId: string; volumeName: string } {
    for (const file of [stageBinary, schemaFile, migrationsFile]) {
      if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) throw new Error('exact transfer artifact file required')
    }
    const volumeName = `freshell-transfer-${this.runId.slice(0, 12)}-${randomUUID().slice(0, 8)}`
    docker(['volume', 'create', '--label', `com.freshell.runtime-test-run-id=${this.runId}`, volumeName])
    this.trackedVolumes.add(volumeName)
    // Trusted rootless volume initialization finishes before any provider
    // runs. Only the owned volume root changes; provider operations get no caps.
    const initializer = docker([
      'create', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
      '--security-opt', 'no-new-privileges', '--label', `com.freshell.runtime-test-run-id=${this.runId}`,
      '--mount', `type=volume,source=${volumeName},target=/scratch`, this.imageRef,
      'python3', '-c', 'import os; p="/scratch/.freshell-transfer-owner"; f=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600); os.write(f,b"owned-transfer-volume"); os.fsync(f); os.close(f); os.chown(p,65534,0); os.chmod("/scratch",0o700); os.chown("/scratch",65534,0)',
    ]).trim()
    if (!/^[a-f0-9]{64}$/.test(initializer)) throw new Error('invalid transfer initializer id')
    this.trackedContainers.add(initializer)
    docker(['start', '-a', initializer])
    const exitCode = Number(docker(['inspect', '--format', '{{.State.ExitCode}}', initializer]).trim())
    if (exitCode !== 0) throw new Error('owned volume initialization failed')
    const containerId = docker([
      'run', '-d', '--network', 'none', '--read-only', '--user', '65534:0', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--cpus', '2', '--memory', '1g', '--memory-swap', '1g', '--pids-limit', '128',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777',
      '--label', `com.freshell.runtime-test-run-id=${this.runId}`,
      '--mount', `type=volume,source=${volumeName},target=/scratch`,
      '--mount', `type=bind,source=${stageBinary},target=/opt/transfer-stage,readonly`,
      '--mount', `type=bind,source=${schemaFile},target=/opt/transfer-schema.sql,readonly`,
      '--mount', `type=bind,source=${migrationsFile},target=/opt/transfer-migrations.json,readonly`,
      '-e', 'HOME=/scratch/provider', '-e', 'XDG_DATA_HOME=/scratch/provider/.local/share',
      '-e', 'XDG_CONFIG_HOME=/scratch/provider/.config', '-e', 'XDG_CACHE_HOME=/scratch/provider/.cache',
      '-e', 'OPENCODE_DB=/scratch/provider/.local/share/opencode/opencode.db',
      '-e', 'OPENCODE_DISABLE_DEFAULT_PLUGINS=1', '-e', 'OPENCODE_DISABLE_MODELS_FETCH=1', '-e', 'OPENCODE_DISABLE_AUTOUPDATE=1',
      ...workspacePaths.flatMap((workspace) => {
        if (!path.isAbsolute(workspace) || fs.realpathSync(workspace) !== workspace || workspace === os.homedir()
          || workspace === '/' || workspace === '/scratch' || !fs.statSync(workspace).isDirectory()) throw new Error('exact qualified workspace required')
        return ['--mount', `type=bind,source=${workspace},target=${workspace},readonly`]
      }),
      '-w', '/scratch', this.imageRef, 'sleep', '600',
    ]).trim()
    if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('invalid transfer provider id')
    this.trackedContainers.add(containerId)
    this.recordLifecycle('transfer.provider.started', { containerId, volumeName, imageDigest: this.imageRef, providerUid: 65534, providerGid: 0 })
    return { containerId, volumeName }
  }

  writeTransferRequest(containerId: string, fileName: string, value: unknown): void {
    if (!this.trackedContainers.has(containerId) || !/^[a-z0-9-]+\.json$/.test(fileName)) throw new Error('owned transfer request required')
    execFileSync('docker', ['exec', '-i', '--user', '65534:0', containerId, 'python3', '-c',
      'import os,sys; p="/scratch/"+sys.argv[1]; f=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600); b=sys.stdin.buffer.read(1048577); assert len(b)<=1048576; os.write(f,b); os.fsync(f); os.close(f)', fileName,
    ], { input: JSON.stringify(value), encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 })
  }

  async copyTransferFileExact(containerId: string, sourceFile: string, destinationFile: string): Promise<void> {
    if (!this.trackedContainers.has(containerId) || !/^\/scratch\/[a-z0-9-]+\.(json|bin)$/.test(destinationFile)) throw new Error('exact owned transfer file required')
    const child = spawn('docker', ['exec', '-i', '--user', '65534:0', containerId, 'node', '-e',
      'const fs=require("node:fs");const f=fs.openSync(process.argv[1],"wx",0o600);let count=0;process.stdin.on("data",b=>{count+=b.length;if(count>8589934592)process.exit(1);fs.writeSync(f,b)});process.stdin.on("end",()=>{fs.fsyncSync(f);fs.closeSync(f)});', destinationFile,
    ], { cwd: this.repoRoot, stdio: ['pipe', 'ignore', 'pipe'], timeout: 300_000 })
    this.recordLifecycle('transfer.file.copy.started', { containerId, childPid: child.pid, sourceReference: sourceFile, destinationReference: destinationFile })
    const completion = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`owned transfer copy failed: ${code ?? signal}`)))
      child.stderr.resume()
    })
    const results = await Promise.allSettled([pipeline(fs.createReadStream(sourceFile), child.stdin), completion])
    if (results.some((result) => result.status === 'rejected')) throw new Error('owned transfer file copy failed')
    this.recordLifecycle('transfer.file.copy.complete', { containerId, destinationReference: destinationFile })
  }

  async captureTransferFileExact(containerId: string, sourceFile: string, destinationFile: string): Promise<void> {
    if (!this.trackedContainers.has(containerId) || !/^\/scratch\/(?:native-[a-zA-Z0-9_-]+\.json|native-private\.log)$/.test(sourceFile)) throw new Error('exact owned native artifact required')
    const child = spawn('docker', ['exec', '--user', '65534:0', containerId, 'node', '-e',
      'require("node:fs").createReadStream(process.argv[1]).pipe(process.stdout)', sourceFile,
    ], { cwd: this.repoRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 })
    const completion = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`owned native capture failed: ${code ?? signal}`)))
      child.stderr.resume()
    })
    const results = await Promise.allSettled([pipeline(child.stdout, fs.createWriteStream(destinationFile, { mode: 0o600, flags: 'wx' })), completion])
    if (results.some((result) => result.status === 'rejected')) throw new Error('owned native artifact capture failed')
    this.recordLifecycle('transfer.native_artifact.captured', { containerId, sourceReference: sourceFile, destinationReference: destinationFile })
  }

  transferOwnedIds(): { containers: string[]; volumes: string[] } {
    return { containers: [...this.trackedContainers], volumes: [...this.trackedVolumes] }
  }

  verifyTransferCleanup(original: { containers: string[]; volumes: string[] }): void {
    // Successful inventory calls prove absence; daemon/transport failure is
    // never interpreted as a missing owned object.
    const containers = new Set(docker(['ps', '-aq', '--no-trunc']).trim().split('\n'))
    const volumes = new Set(docker(['volume', 'ls', '-q']).trim().split('\n'))
    if (original.containers.some((id) => containers.has(id)) || original.volumes.some((id) => volumes.has(id))) {
      throw new Error('owned transfer resources remain after cleanup')
    }
  }

  async cleanup(): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = []
    const exactContainerIds = [...new Set([
      ...this.trackedSupervisorContainers, ...this.trackedForeignContainers,
      ...this.trackedContainers, ...this.broker?.receiptIds?.() ?? [],
    ])]
    const providerVolumes = new Set((this.broker?.receipts?.() ?? []).map(receipt => receipt.providerVolumeName).filter((value): value is string => !!value))
    const exactVolumes = [...new Set([...this.trackedVolumes, ...providerVolumes])]
    const historyHelperNames = this.broker?.historyHelperNames?.() ?? []
    for (const id of [...this.trackedSupervisorContainers]) {
      try { this.removeContainerExact(id) } catch (error) { errors.push(`supervisor ${id}: ${String(error)}`) }
    }
    for (const id of [...this.broker?.receiptIds?.() ?? []]) {
      try { this.removeContainerExact(id) } catch (error) { errors.push(`managed runtime ${id}: ${String(error)}`) }
    }
    for (const name of historyHelperNames) {
      try { this.removeContainerExact(name) } catch (error) { errors.push(`history helper ${name}: ${String(error)}`) }
    }
    for (const id of [...this.trackedForeignContainers]) {
      try { this.removeContainerExact(id) } catch (error) { errors.push(`foreign sentinel ${id}: ${String(error)}`) }
    }
    for (const id of [...this.trackedContainers]) {
      try { this.removeContainerExact(id) } catch (error) { errors.push(`tracked container ${id}: ${String(error)}`) }
    }
    for (const volume of providerVolumes) {
      try { docker(['volume', 'rm', volume]) } catch (error) { errors.push(`provider volume ${volume}: ${String(error)}`) }
    }
    for (const volume of [...this.trackedVolumes]) {
      try { docker(['volume', 'rm', volume]) } catch (error) { errors.push(`volume ${volume}: ${String(error)}`) }
    }
    if (this.brokerStarted) {
      try { await this.broker.close() } catch (error) { errors.push(`broker close: ${String(error)}`) }
      this.brokerStarted = false
    }
    let resourcesAbsent = false
    try {
      const lines = (text: string) => text.trim() ? text.trim().split('\n').map(value => value.trim()) : []
      verifyRuntimeCleanupAbsence({ containerIds: exactContainerIds, volumes: exactVolumes, helperNames: historyHelperNames }, {
        containerIds: lines(docker(['ps', '-aq', '--no-trunc'])),
        volumes: lines(docker(['volume', 'ls', '--format', '{{.Name}}'])),
        containerNames: lines(docker(['ps', '-a', '--format', '{{.Names}}'])),
      })
      resourcesAbsent = true
    } catch (error) { errors.push(`runtime absence: ${error instanceof Error ? error.message : String(error)}`) }
    if (resourcesAbsent && this.ownedImage) {
      try { removeRunOwnedRuntimeImage(this.ownedImage) }
      catch (error) { errors.push(`runtime image cleanup: ${error instanceof Error ? error.message : String(error)}`) }
    }
    // Build copies are unique to this run, so retries/concurrent gates never
    // overwrite an executable that another still-running container/process
    // has mapped. Remove them only after every receipt-owned runtime stopped.
    if (resourcesAbsent) {
      try { fs.rmSync(this.buildDir, { recursive: true, force: true }) } catch (error) { errors.push(`runtime build dir: ${String(error)}`) }
    }
    const cleanup = {
      ok: errors.length === 0,
      errors,
      exactContainerIds,
      volumes: exactVolumes,
      historyHelperNames,
      verifiedResourcesAbsent: resourcesAbsent,
      ownedImage: this.ownedImage,
      unsafeBrokerAttempts: this.broker?.unsafeAttempts?.() ?? [],
      completedAt: new Date().toISOString(),
    }
    ensurePrivateDirectory(this.evidenceDir)
    writePrivateJson(path.join(this.evidenceDir, 'cleanup.json'), cleanup)
    writePrivateJson(path.join(this.evidenceDir, 'ownership-after.json'), { brokerReceipts: this.broker?.receipts?.() ?? [], brokerEvents: this.broker?.eventsSnapshot?.() ?? [] })
    this.collectScenarioLifecycleLogs()
    return { ok: cleanup.ok, errors }
  }

  recordProviderQualificationBuild(record: ProviderQualificationBuildRecord): void {
    const buildPath = path.join(this.evidenceDir, 'build.json')
    const build = JSON.parse(fs.readFileSync(buildPath, 'utf8'))
    const qualificationBuild = {
      kind: record.kind,
      serverFeatures: [...record.serverFeatures].sort(),
      supervisorFeatures: [...record.supervisorFeatures].sort(),
      qualificationProviders: [...record.qualificationProviders].sort(),
      binaries: {
        server: fileBuild(this.validateRunBuildBinary(record.serverBinary, 'qualification server')),
        supervisor: fileBuild(this.validateRunBuildBinary(record.supervisorBinary, 'qualification supervisor')),
      },
    }
    writePrivateJson(buildPath, { ...build, qualificationBuild })
  }

  recordFreshAgentQualificationBuild(record: FreshAgentQualificationBuildRecord): void {
    const buildPath = path.join(this.evidenceDir, 'build.json')
    const build = JSON.parse(fs.readFileSync(buildPath, 'utf8'))
    const freshAgentQualificationBuild = {
      kind: record.kind,
      serverFeatures: [...record.serverFeatures].sort(),
      sessionHostFeatures: [...record.sessionHostFeatures].sort(),
      selectedModes: [...record.selectedModes],
      fixtureModes: [...record.fixtureModes],
      binaries: {
        server: fileBuild(this.validateRunBuildBinary(record.serverBinary, 'fresh-agent qualification server')),
        supervisor: fileBuild(this.validateRunBuildBinary(record.supervisorBinary, 'fresh-agent qualification supervisor')),
        sessionHost: fileBuild(this.validateRunBuildBinary(record.sessionHostBinary, 'fresh-agent qualification session host')),
      },
    }
    fs.writeFileSync(buildPath, JSON.stringify({
      ...build,
      freshAgentQualificationBuild,
      binaries: { ...build.binaries, ...freshAgentQualificationBuild.binaries },
    }, null, 2))
  }

  assert(caseId: string, condition: unknown, message: string, evidence?: unknown): asserts condition {
    const record: AssertionRecord = { at: new Date().toISOString(), caseId, pass: Boolean(condition), message, ...(evidence === undefined ? {} : { evidence }) }
    this.assertions.push(record)
    appendPrivateLine(this.assertionsPath, record)
    if (!condition) throw new RuntimeGateAssertionError(caseId, message, evidence)
  }

  recordLifecycle(event: string, data: unknown = {}): void {
    ensurePrivateDirectory(path.dirname(this.lifecyclePath))
    appendPrivateLine(this.lifecyclePath, { at: new Date().toISOString(), event, data })
  }

  writeIncident(name: string, value: unknown): void {
    ensurePrivateDirectory(this.incidentsDir)
    writePrivateJson(path.join(this.incidentsDir, `${sanitizeName(name)}.json`), value)
  }

  writeBrowserArtifact(name: string, value: unknown): string {
    ensurePrivateDirectory(this.browserDir)
    const target = path.join(this.browserDir, `${sanitizeName(name)}.json`)
    writePrivateJson(target, value)
    return target
  }

  /// A named top-level evidence artifact. The gate manifest declares which
  /// artifacts a run must contain; this is how a case contributes one.
  writeArtifact(fileName: string, value: unknown): string {
    const target = path.join(this.evidenceDir, sanitizeName(fileName))
    ensurePrivateDirectory(path.dirname(target))
    writePrivateJson(target, value)
    return target
  }

  writeProviderResults(value: unknown): void {
    writePrivateJson(path.join(this.evidenceDir, 'provider-results.json'), value)
  }

  writeSummary(summary: unknown): void {
    writePrivateJson(path.join(this.evidenceDir, 'summary.json'), summary)
  }

  scenarioPath(scenarioId: string): string {
    return path.join(this.testRoot, 'scenarios', sanitizeName(scenarioId))
  }

  async startSupervisor(options: {
    scenarioId: string
    volumeName?: string
    binaryKind?: 'test' | 'release'
    crashPoint?: string
    dbFailpoint?: string
    waitForHealth?: boolean
    reuseSecret?: boolean
    installationBudget?: RuntimeLimits
    projectBudget?: RuntimeLimits
    env?: Record<string, string>
    /** Exact harness-built supervisor binary; must live under this run's build directory. */
    binaryPath?: string
    /** Exact artifact-owned historical session host for legacy enclosure proof. */
    hostBinaryPath?: string
  }): Promise<SupervisorInstance> {
    const scenarioId = sanitizeName(options.scenarioId)
    const scenarioRoot = this.scenarioPath(scenarioId)
    const controlDir = path.join(scenarioRoot, 'control')
    // Linux Unix-domain sockets have a small sun_path budget. Runtime paths
    // include a long incarnation UUID plus `/host.sock`, so keep the durable
    // runtime root intentionally short and deterministic across restarts.
    const runtimeKey = `${scenarioId.slice(0, 6)}-${createHash('sha256').update(scenarioId).digest('hex').slice(0, 8)}`
    const runtimeRoot = path.join(this.testRoot, 'r', runtimeKey, 'x')
    fs.mkdirSync(controlDir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 })
    const worstHostSocket = path.join(runtimeRoot, `incarnation-${'0'.repeat(36)}`, 'host.sock')
    if (Buffer.byteLength(worstHostSocket) >= 104) {
      throw new Error(`runtime host socket path budget exceeded (${Buffer.byteLength(worstHostSocket)} bytes): ${worstHostSocket}`)
    }
    const controlSecretFile = path.join(controlDir, 'secret')
    if (!fs.existsSync(controlSecretFile) || options.reuseSecret === false) {
      fs.writeFileSync(controlSecretFile, `${randomUUID()}${randomUUID()}${randomUUID()}`, { mode: 0o600 })
    }
    const controlSecret = fs.readFileSync(controlSecretFile, 'utf8').trim()
    const controlSocket = path.join(controlDir, 'supervisor.sock')
    const volumeName = options.volumeName ?? `freshell-p${this.phase}-${this.runId.slice(0, 8)}-${scenarioId}`
    if (!this.trackedVolumes.has(volumeName)) {
      docker(['volume', 'create', volumeName])
      this.trackedVolumes.add(volumeName)
    }
    const binaryKind = options.binaryKind ?? 'test'
    const defaultSupervisorBinary = binaryKind === 'test' ? this.testSupervisorBinary : this.releaseSupervisorBinary
    const supervisorBinary = options.binaryPath
      ? this.validateRunBuildBinary(options.binaryPath, 'supervisor')
      : defaultSupervisorBinary
    const hostBinary = options.hostBinaryPath
      ? this.validateRunBuildBinary(options.hostBinaryPath, 'host')
      : binaryKind === 'test' ? this.testHostBinary : this.releaseHostBinary
    const name = `freshell-p${this.phase}-supervisor-${this.runId.slice(0, 8)}-${scenarioId}-${randomUUID().slice(0, 8)}`
    const args = [
      'run', '-d', '--name', name, '--label', `com.freshell.runtime-test-run-id=${this.runId}`,
      // The supervisor is trusted control-plane test code. Rootful Docker
      // preserves the host runner uid on bind mounts, so uid-0 with CapDrop=ALL
      // cannot traverse this harness's 0700 testRoot or read its 0600 secret.
      // Add only DAC_OVERRIDE to keep the same private-file contract portable;
      // managed workload containers still use the stricter broker-enforced set.
      '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'CHOWN', '--security-opt', 'no-new-privileges',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
      '-v', `${this.testRoot}:${this.testRoot}:rw`,
      '-v', `${this.buildDir}:${this.buildDir}:ro`,
      '-v', `${volumeName}:/var/lib/freshell-supervisor:rw`,
    ]
    if (this.phase >= 2) {
      for (const root of this.phase2WorkspaceRoots()) {
        if (root === this.testRoot || root === this.buildDir) continue
        args.push('-v', `${root}:${root}:ro`)
      }
    }
    if (this.phase >= 2) {
      for (const credentialFile of this.phase2BootstrapFiles()) {
        // The web/server side records this exact canonical HOST path in the
        // durable launch spec. A containerized supervisor must therefore see
        // the same path for validation; mount the single file, never its
        // parent directory/home.
        args.push('-v', `${credentialFile}:${credentialFile}:ro`)
      }
    }
    if (options.crashPoint) {
      // Namespace PID1 ignores default SIGABRT; libc abort can then trap with
      // SIGSEGV. Let Docker's init reap the actual aborted supervisor child.
      args.push('--init', '-e', `FRESHELL_RUNTIME_CRASH_POINT=${options.crashPoint}`)
    }
    if (options.dbFailpoint) args.push('-e', `FRESHELL_RUNTIME_DB_FAILPOINT=${options.dbFailpoint}`)
    for (const [key, value] of Object.entries(options.env ?? {})) args.push('-e', `${key}=${value}`)
    args.push(
      this.imageRef,
      supervisorBinary, 'serve',
      '--registry-root', '/var/lib/freshell-supervisor',
      '--control-socket', controlSocket,
      '--control-secret-file', controlSecretFile,
      '--docker-socket', this.broker.proxySocketPath,
      '--runtime-root', runtimeRoot,
      '--host-binary', hostBinary,
      '--image-ref', this.imageRef,
    )
    if (options.installationBudget) {
      args.push('--installation-budget-cpu-milli', String(options.installationBudget.cpuMilli), '--installation-budget-memory-bytes', String(options.installationBudget.memoryBytes), '--installation-budget-pids', String(options.installationBudget.pidsMax))
    }
    if (options.projectBudget) {
      args.push('--project-budget-cpu-milli', String(options.projectBudget.cpuMilli), '--project-budget-memory-bytes', String(options.projectBudget.memoryBytes), '--project-budget-pids', String(options.projectBudget.pidsMax))
    }
    args.push('--test-run-id', this.runId)
    const containerId = docker(args).trim()
    if (!/^[0-9a-f]{64}$/.test(containerId)) throw new Error(`supervisor docker run returned invalid id: ${containerId}`)
    this.trackedSupervisorContainers.add(containerId)
    this.trackedContainers.add(containerId)
    const instance: SupervisorInstance = { scenarioId, containerId, controlSocket, controlSecret, controlSecretFile, runtimeRoot, volumeName, binaryKind }
    this.recordLifecycle('supervisor.started', { scenarioId, containerId, binaryKind, crashPoint: options.crashPoint, dbFailpoint: options.dbFailpoint, volumeName })
    if (options.waitForHealth !== false) await this.waitForSupervisorHealth(instance)
    return instance
  }

  private validateRunBuildBinary(candidate: string, label: string): string {
    const resolved = fs.realpathSync(candidate)
    const buildRoot = `${fs.realpathSync(this.buildDir)}${path.sep}`
    if (!resolved.startsWith(buildRoot) || !fs.statSync(resolved).isFile()) {
      throw new Error(`${label} binary override must be a regular file under this run's build directory`)
    }
    return resolved
  }

  async waitForSupervisorHealth(instance: SupervisorInstance, timeoutMs = 12_000): Promise<any> {
    const deadline = Date.now() + timeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      if (!this.isContainerRunning(instance.containerId)) {
        const logs = this.containerLogs(instance.containerId)
        throw new Error(`supervisor ${instance.containerId} exited before health: ${logs}`)
      }
      if (fs.existsSync(instance.controlSocket)) {
        // Rootful Docker creates the bind-mounted UDS as container root, so
        // the non-root GitHub/CI harness cannot connect to its mode-0600
        // socket. Rootless Docker already maps container root to this user.
        // Bridge ownership only for this exact test-supervisor socket; the
        // managed runtime host sockets remain private to the supervisor.
        if (!dockerIsRootless()) {
          const uid = process.getuid?.() ?? 1000
          const gid = process.getgid?.() ?? 1000
          try { docker(['exec', instance.containerId, 'chown', `${uid}:${gid}`, instance.controlSocket]) } catch {}
        }
        try { return await this.adminOk(instance, { method: 'health' }) } catch (error) { lastError = error }
      }
      await sleep(50)
    }
    throw new Error(`supervisor health timeout: ${String(lastError)}`)
  }

  async adminRaw(instance: SupervisorInstance, body: any, options: { requestId?: string; auth?: string } = {}): Promise<AdminReply> {
    return await this.adminEnvelopeRaw(instance, {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      requestId: options.requestId ?? `request-${randomUUID()}`,
      role: 'web',
      auth: options.auth ?? instance.controlSecret,
      body,
    })
  }

  async adminSendAndDrop(instance: SupervisorInstance, body: any, options: { requestId?: string; auth?: string } = {}): Promise<void> {
    const envelope = {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      requestId: options.requestId ?? `request-${randomUUID()}`,
      role: 'web',
      auth: options.auth ?? instance.controlSecret,
      body,
    }
    const payload = Buffer.from(JSON.stringify(envelope))
    const frame = Buffer.allocUnsafe(4 + payload.length)
    frame.writeUInt32BE(payload.length, 0)
    payload.copy(frame, 4)
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(instance.controlSocket)
      socket.once('error', reject)
      socket.once('connect', () => {
        socket.write(frame, (error) => {
          if (error) return reject(error)
          socket.destroy()
          resolve()
        })
      })
    })
  }

  async adminEnvelopeRaw(instance: SupervisorInstance, envelope: Record<string, unknown>): Promise<AdminReply> {
    const payload = Buffer.from(JSON.stringify(envelope))
    const frame = Buffer.allocUnsafe(4 + payload.length)
    frame.writeUInt32BE(payload.length, 0)
    payload.copy(frame, 4)
    return await unixRoundTrip(instance.controlSocket, frame) as AdminReply
  }

  async adminOversizedFrame(instance: SupervisorInstance, announcedBytes = 1024 * 1024 + 1): Promise<AdminReply> {
    const frame = Buffer.allocUnsafe(4)
    frame.writeUInt32BE(announcedBytes, 0)
    return await unixRoundTrip(instance.controlSocket, frame) as AdminReply
  }

  async adminOk(instance: SupervisorInstance, body: any, options: { requestId?: string; auth?: string } = {}): Promise<any> {
    const reply = await this.adminRaw(instance, body, options)
    if (reply.result?.Err) {
      const error = new Error(`${reply.result.Err.code}: ${reply.result.Err.message}`) as Error & { runtimeError?: AdminError }
      error.runtimeError = reply.result.Err
      throw error
    }
    if (!('Ok' in (reply.result ?? {}))) throw new Error(`malformed supervisor reply: ${JSON.stringify(reply)}`)
    return reply.result.Ok
  }

  launchBody(params: {
    soulId: string
    limits?: RuntimeLimits
    fixture?: 'heartbeat' | 'descendant_spawner' | 'cpu_burner' | 'memory_allocator' | 'native_session' | 'security_probe'
    terminal?: Record<string, unknown>
    profile?: 'default_agent' | 'test_fixture' | 'custom'
    projectKey?: string
    nativeSessionId?: string
    expectedControlEpoch?: number
    provider?: string
    providerStoreId?: string
    creationSeedRef?: string
    viewIntent?: Record<string, unknown>
  }): any {
    const terminal = params.terminal
    return {
      method: 'launch',
      params: {
        soulId: params.soulId,
        provider: params.provider ?? (terminal ? 'shell' : 'phase1-fixture'),
        providerStoreId: params.providerStoreId ?? `store-${this.runId}`,
        creationSeedRef: params.creationSeedRef ?? `seed-${params.soulId}`,
        limits: params.limits ?? defaultLimits(),
        ...(params.profile ? { profile: params.profile } : {}),
        ...(params.projectKey ? { projectKey: params.projectKey } : {}),
        ...(params.nativeSessionId ? { nativeSessionId: params.nativeSessionId } : {}),
        ...(terminal ? { terminal } : { fixture: params.fixture ?? 'heartbeat' }),
        ...(params.viewIntent ? { viewIntent: params.viewIntent } : {}),
        ...(params.expectedControlEpoch === undefined ? {} : { expectedControlEpoch: params.expectedControlEpoch }),
      },
    }
  }

  terminalInputBody(soulId: string, data: string, expectedControlEpoch?: number): any {
    return { method: 'terminal_input', params: { soulId, data, ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }) } }
  }

  terminalResizeBody(soulId: string, cols: number, rows: number, expectedControlEpoch?: number): any {
    return { method: 'terminal_resize', params: { soulId, cols, rows, ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }) } }
  }

  terminalReadOutputBody(soulId: string, afterSeq = 0, maxBytes = 64 * 1024, expectedControlEpoch?: number): any {
    return { method: 'terminal_read_output', params: { soulId, afterSeq, maxBytes, ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }) } }
  }

  freshAgentResolveBody(
    soulId: string,
    decisionId: string,
    decision: Record<string, unknown>,
    expectedControlEpoch?: number,
  ): any {
    return {
      method: 'fresh_agent_resolve',
      params: {
        soulId,
        decisionId,
        decision,
        ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }),
      },
    }
  }

  runtimeMetricsBody(soulId: string, expectedControlEpoch?: number): any {
    return { method: 'runtime_metrics', params: { soulId, ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }) } }
  }

  inventoryBody(): any {
    return { method: 'inventory' }
  }

  inventorySnapshotBody(): any {
    return { method: 'inventory_snapshot' }
  }

  pendingViewProjectionsBody(limit = 100, expectedControlEpoch?: number): any {
    return {
      method: 'pending_view_projections',
      params: { limit, ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }) },
    }
  }

  acknowledgeViewProjectionBody(eventId: string, expectedControlEpoch?: number): any {
    return {
      method: 'acknowledge_view_projection',
      params: { eventId, ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }) },
    }
  }

  updateViewVisibilityBody(params: {
    viewId: string
    visibility: 'visible' | 'detached' | 'hidden'
    expectedRevision: number
    expectedSoulIntentRevision: number
    expectedControlEpoch?: number
  }): any {
    return {
      method: 'update_view_visibility',
      params: {
        viewId: params.viewId,
        visibility: params.visibility,
        expectedRevision: params.expectedRevision,
        expectedSoulIntentRevision: params.expectedSoulIntentRevision,
        ...(params.expectedControlEpoch === undefined ? {} : { expectedControlEpoch: params.expectedControlEpoch }),
      },
    }
  }

  upsertViewIntentBody(params: {
    soulId: string
    viewId?: string
    intent: Record<string, unknown>
    expectedRevision?: number
    expectedSoulIntentRevision: number
    expectedControlEpoch?: number
  }): any {
    return {
      method: 'upsert_view_intent',
      params: {
        soulId: params.soulId,
        ...(params.viewId ? { viewId: params.viewId } : {}),
        intent: params.intent,
        ...(params.expectedRevision === undefined ? {} : { expectedRevision: params.expectedRevision }),
        expectedSoulIntentRevision: params.expectedSoulIntentRevision,
        ...(params.expectedControlEpoch === undefined ? {} : { expectedControlEpoch: params.expectedControlEpoch }),
      },
    }
  }

  updateLimitsBody(params: {
    soulId: string
    limits: RuntimeLimits
    expectedIntentRevision: number
    expectedControlEpoch?: number
  }): any {
    return {
      method: 'update_limits',
      params: {
        soulId: params.soulId,
        limits: params.limits,
        expectedIntentRevision: params.expectedIntentRevision,
        ...(params.expectedControlEpoch === undefined ? {} : { expectedControlEpoch: params.expectedControlEpoch }),
      },
    }
  }

  probeRecoveryBody(soulId: string, expectedControlEpoch?: number): any {
    return { method: 'probe_recovery', params: { soulId, ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }) } }
  }

  pendingNoticesBody(profileId: string, limit = 20, expectedControlEpoch?: number): any {
    return {
      method: 'pending_notices',
      params: {
        profileId,
        limit,
        ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }),
      },
    }
  }

  noticeReceiptBody(params: {
    noticeId: string
    profileId: string
    state: 'rendered' | 'acknowledged' | 'dismissed'
    expectedControlEpoch?: number
  }): any {
    return {
      method: 'notice_receipt',
      params: {
        noticeId: params.noticeId,
        profileId: params.profileId,
        state: params.state,
        ...(params.expectedControlEpoch === undefined ? {} : { expectedControlEpoch: params.expectedControlEpoch }),
      },
    }
  }

  incidentSummaryBody(incidentId: string, expectedControlEpoch?: number): any {
    return {
      method: 'incident_summary',
      params: {
        incidentId,
        ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }),
      },
    }
  }

  runtimeMetricsSnapshotBody(): any {
    return { method: 'metrics_snapshot' }
  }

  migrationPlanBody(params: {
    requestedMode: 'legacy' | 'managed-opt-in' | 'managed-default'
    apply?: boolean
    backupPath?: string
    legacyMetadataPath?: string
    expectedControlEpoch?: number
  }): any {
    return {
      method: 'migration_plan',
      params: {
        requestedMode: params.requestedMode,
        apply: params.apply ?? false,
        ...(params.backupPath ? { backupPath: params.backupPath } : {}),
        ...(params.legacyMetadataPath ? { legacyMetadataPath: params.legacyMetadataPath } : {}),
        ...(params.expectedControlEpoch === undefined ? {} : { expectedControlEpoch: params.expectedControlEpoch }),
      },
    }
  }

  repairAuditBody(apply = false, expectedControlEpoch?: number): any {
    return {
      method: 'repair_audit',
      params: {
        apply,
        ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }),
      },
    }
  }

  recoverBody(
    soulId: string,
    trigger: 'provider_exit' | 'host_unreachable' | 'startup_reconcile' | 'manual_retry' | 'retry_exhausted' | 'explicit_request' = 'explicit_request',
    expectedControlEpoch?: number,
    expectedIntentRevision?: number,
  ): any {
    return {
      method: 'recover',
      params: {
        soulId,
        trigger,
        ...(expectedIntentRevision === undefined ? {} : { expectedIntentRevision }),
        ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }),
      },
    }
  }

  stopBody(soulId: string, expectedControlEpoch?: number, expectedIntentRevision?: number): any {
    return {
      method: 'stop',
      params: {
        soulId,
        ...(expectedIntentRevision === undefined ? {} : { expectedIntentRevision }),
        ...(expectedControlEpoch === undefined ? {} : { expectedControlEpoch }),
      },
    }
  }

  runtimeDir(instance: SupervisorInstance, incarnationId: string): string {
    return path.join(instance.runtimeRoot, incarnationId)
  }

  private ownerFactsAdapter(instance: SupervisorInstance): Omit<RuntimeOwnerFactsAdapter, 'readHostFacts'> {
    return {
      runId: this.runId, candidateSha: this.candidateSha,
      receipts: () => this.broker.receipts(),
      inventory: async () => {
        const result = await this.adminOk(instance, { method: 'inventory' })
        if (result?.kind !== 'inventory' || !Array.isArray(result.data)) throw new Error('current owned inventory is unavailable')
        return result.data
      },
    }
  }

  async fixtureNativeState(instance: SupervisorInstance, handle: ExactRuntimeHandle): Promise<FixtureNativeState> {
    await assertExactRuntimeHandle(this.ownerFactsAdapter(instance), handle)
    const value = JSON.parse(this.execOwnedContainerAsExact(handle.containerId, '65534:0', [
      'cat', '/home/freshell/provider/.freshell-fixture/provider-native-state.json',
    ]))
    return decodeFixtureNativeState(value, handle.nativeSessionId)
  }

  async nativeFixtureCall(instance: SupervisorInstance, incarnationId: string, body: Record<string, unknown>): Promise<any> {
    const socketPath = path.join(this.runtimeDir(instance, incarnationId), 'native.sock')
    await this.waitForFile(socketPath)
    const payload = Buffer.from(JSON.stringify(body))
    const frame = Buffer.allocUnsafe(4 + payload.length)
    frame.writeUInt32BE(payload.length, 0)
    payload.copy(frame, 4)
    return await unixRoundTrip(socketPath, frame)
  }

  startWebLifetimeSentinel(scenarioId: string): string {
    const id = docker([
      'run', '-d', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--label', 'project=freshell',
      '--label', `com.freshell.runtime-test-run-id=${this.runId}`,
      this.imageRef, 'sleep', 'infinity',
    ]).trim()
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error(`web lifetime sentinel returned invalid id: ${id}`)
    this.trackedContainers.add(id)
    this.recordLifecycle('web_lifetime_sentinel.started', { scenarioId, containerId: id })
    return id
  }

  stopTrackedContainerExact(containerId: string): void {
    if (!this.isContainerRunning(containerId)) return
    const result = spawnSync('docker', ['stop', '-t', '1', containerId], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || `docker stop failed for tracked container ${containerId}`)
  }

  killTrackedContainerExact(containerId: string): void {
    if (!this.trackedContainers.has(containerId)) throw new Error(`refusing to kill untracked container ${containerId}`)
    if (!this.isContainerRunning(containerId)) return
    const result = spawnSync('docker', ['kill', containerId], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || `docker kill failed for tracked container ${containerId}`)
  }

  ownedContainerHostPidExact(containerId: string): number {
    if (!this.trackedContainers.has(containerId) && !this.broker.receiptIds().has(containerId)) {
      throw new Error(`refusing to inspect host PID for unowned container ${containerId}`)
    }
    const raw = docker(['inspect', '--format', '{{.State.Pid}}', containerId]).trim()
    const pid = Number(raw)
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`owned container ${containerId} has invalid host PID ${raw}`)
    return pid
  }

  restartOwnedRuntimeExact(containerId: string): void {
    if (!this.broker.receiptIds().has(containerId)) throw new Error(`refusing to restart non-receipt container ${containerId}`)
    const result = spawnSync('docker', ['restart', '-t', '1', containerId], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || `docker restart failed for owned runtime ${containerId}`)
  }

  stopOwnedRuntimeExact(containerId: string): void {
    if (!this.broker.receiptIds().has(containerId)) throw new Error(`refusing to stop non-receipt container ${containerId}`)
    if (!this.isContainerRunning(containerId)) return
    const result = spawnSync('docker', ['stop', '-t', '1', containerId], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || `docker stop failed for owned runtime ${containerId}`)
  }

  killOwnedRuntimeExact(containerId: string): void {
    if (!this.broker.receiptIds().has(containerId)) throw new Error(`refusing to kill non-receipt container ${containerId}`)
    if (!this.isContainerRunning(containerId)) return
    const result = spawnSync('docker', ['kill', containerId], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || `docker kill failed for owned runtime ${containerId}`)
  }

  killOwnedRuntimePidExact(containerId: string, pid: number, signal: 'TERM' | 'KILL' = 'KILL'): void {
    if (!this.broker.receiptIds().has(containerId)) {
      throw new Error(`refusing to signal a pid in non-receipt container ${containerId}`)
    }
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      throw new Error(`refusing to signal unsafe runtime pid ${pid}`)
    }
    if (!this.isContainerRunning(containerId)) return
    // Runtime workers run as the provider UID. The rootless container host
    // has no CAP_KILL for that UID, so signal from the same user namespace.
    const result = spawnSync('docker', [
      'exec', '--user', '65534:0', containerId, 'kill', `-${signal}`, String(pid),
    ], {
      encoding: 'utf8',
    })
    if (result.status !== 0) {
      throw new Error(result.stderr || `docker exec kill failed for owned runtime ${containerId} pid ${pid}`)
    }
  }

  execOwnedContainerExact(containerId: string, command: string[]): string {
    if (!this.broker.receiptIds().has(containerId) && !this.trackedContainers.has(containerId)) {
      throw new Error(`refusing to exec non-owned container ${containerId}`)
    }
    return execFileSync('docker', ['exec', containerId, ...command], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  }

  execOwnedContainerAsExact(containerId: string, user: string, command: string[]): string {
    if (!this.trackedContainers.has(containerId) && !this.broker?.receiptIds().has(containerId)) {
      throw new Error(`refusing to exec non-owned container ${containerId}`)
    }
    if (!/^\d+:\d+$/.test(user)) throw new Error(`invalid numeric docker exec user ${user}`)
    return execFileSync('docker', ['exec', '--user', user, containerId, ...command], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  }

  execTransferProviderExact(containerId: string, command: string[]): string {
    if (!this.trackedContainers.has(containerId)) throw new Error('owned finite transfer container required')
    return execFileSync('docker', ['exec', '--user', '65534:0', containerId, ...command], {
      encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
    })
  }

  topOwnedContainerExact(containerId: string, psArgs: string[] = ['-eo', 'pid,ppid,sid,comm']): string {
    if (!this.broker.receiptIds().has(containerId) && !this.trackedContainers.has(containerId)) {
      throw new Error(`refusing to inspect non-owned container ${containerId}`)
    }
    return execFileSync('docker', ['top', containerId, ...psArgs], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  }

  async waitForFile(filePath: string, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (fs.existsSync(filePath)) return
      await sleep(50)
    }
    throw new Error(`file did not appear: ${filePath}`)
  }

  async waitForContainerExit(containerId: string, timeoutMs = 12_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this.isContainerRunning(containerId)) return
      await sleep(75)
    }
    throw new Error(`container remained running: ${containerId}`)
  }

  // Finite Task2 fault injection only. These enclosures are CREATED, never
  // started, and cannot become broker replacement or provider-writer receipts.
  createTask2LegacyNegativeContainerExact(
    originalId: string,
    fault: 'extra_mount' | 'missing_tmpfs' | 'missing_binary' | 'foreign_binary',
  ): string {
    const receipt = this.broker.receipts().find(row => row.containerId === originalId)
    if (!this.task2FiniteFixtures || !dockerIsRootless() || !receipt
      || !['extra_mount', 'missing_tmpfs', 'missing_binary', 'foreign_binary'].includes(fault)
      || !/^[a-f0-9]{64}$/.test(originalId)) throw new Error('owned finite legacy fixture required')
    const original = this.inspectContainer(originalId)
    const config = original.Config, host = original.HostConfig
    const labels = config.Labels
    const expectedLabels = { project: 'freshell', 'com.freshell.managed': 'true',
      'com.freshell.runtime-test-run-id': this.runId, 'com.freshell.soul-id': receipt.soulId,
      'com.freshell.incarnation-id': receipt.incarnationId }
    this.writeArtifact('task2-legacy-physical-shape.json', { idMatches: original.Id === originalId, imageReceiptMatches: original.Image === receipt.imageRef, imageAllowed: original.Image === this.imageRef, running: original.State.Running, labelsMatch: Object.entries(expectedLabels).every(([key, value]) => labels[key] === value), installationPresent: !!labels['com.freshell.installation-id'], readonlyRoot: host.ReadonlyRootfs, privileged: host.Privileged, pidMode: host.PidMode, networkMode: host.NetworkMode, restartPolicy: host.RestartPolicy, capDrop: host.CapDrop, capAdd: host.CapAdd, securityOpt: host.SecurityOpt, tmpfs: Object.keys(host.Tmpfs), receiptSourcesPresent: !!receipt.hostBinaryPath && !!receipt.workspacePath && !!receipt.providerVolumeName, commandPrefix: config.Cmd?.[0], entrypoint: config.Entrypoint })
    if (original.Id !== originalId || original.Image !== receipt.imageRef || original.Image !== this.imageRef
      || original.State.Running !== true || !labels['com.freshell.installation-id']
      || Object.entries(expectedLabels).some(([key, value]) => labels[key] !== value)
      || host.ReadonlyRootfs !== true || host.Privileged || host.PidMode
      || host.NetworkMode !== 'bridge' || !['no', 'unless-stopped'].includes(host.RestartPolicy.Name) || host.RestartPolicy.MaximumRetryCount !== 0
      || JSON.stringify(host.CapDrop) !== JSON.stringify(['ALL'])
      || JSON.stringify([...host.CapAdd].map((cap: string) => cap.replace(/^CAP_/, '')).sort())
        !== JSON.stringify(['CHOWN', 'SETGID', 'SETUID'])
      || JSON.stringify(host.SecurityOpt.map((option: string) => option.replace(/:true$/, ''))) !== JSON.stringify(['no-new-privileges'])
      || JSON.stringify(Object.keys(host.Tmpfs).sort()) !== JSON.stringify(['/run/opencode-tmp', '/tmp'])
      || !receipt.hostBinaryPath || !receipt.workspacePath || !receipt.providerVolumeName
      || !Array.isArray(config.Cmd) || config.Cmd[0] !== '/runtime/freshell-session-host'
      || (config.Entrypoint?.length ?? 0) > 1) throw new Error('exact owned legacy enclosure differs')
    const expectedBinds = [
      `${receipt.hostBinaryPath}:/runtime/freshell-session-host:ro`, `${receipt.runtimeDir}:/run/freshell:rw`,
      `${receipt.providerVolumeName}:/home/freshell/provider:rw`, `${receipt.workspacePath}:${receipt.workspacePath}:rw`,
    ]
    if (JSON.stringify([...host.Binds].sort()) !== JSON.stringify(expectedBinds.sort()))
      throw new Error('legacy fixture gained configuration, secret, or foreign mounts')
    for (const source of [receipt.runtimeDir, receipt.workspacePath]) {
      if (!source.startsWith(`${this.testRoot}${path.sep}`) || fs.realpathSync(source) !== source)
        throw new Error('fixture source is outside the owned scratch root')
    }
    if (receipt.hostBinaryPath !== path.join(this.buildDir, 'task002-prefixed-session-host'))
      throw new Error('actual old creator binary mount required')
    const binds: string[] = [...host.Binds]
    const tmpfs: Record<string, string> = { ...host.Tmpfs }
    const binaryIndex = binds.indexOf(`${receipt.hostBinaryPath}:/runtime/freshell-session-host:ro`)
    if (fault === 'extra_mount') binds.push(`${receipt.workspacePath}:/run/task002-extra:ro`)
    if (fault === 'missing_tmpfs') delete tmpfs['/run/opencode-tmp']
    if (fault === 'missing_binary') binds.splice(binaryIndex, 1)
    if (fault === 'foreign_binary') {
      if (this.testHostBinary !== path.join(this.buildDir, 'freshell-session-host-test')
        || fs.realpathSync(this.testHostBinary) !== this.testHostBinary)
        throw new Error('owned current fixture binary required')
      binds[binaryIndex] = `${this.testHostBinary}:/runtime/freshell-session-host:ro`
    }
    const args = ['create', '--name', `task002-negative-${this.runId}-${fault}`, '--read-only',
      '--network', host.NetworkMode, '--restart', host.RestartPolicy.Name, '--cap-drop', 'ALL',
      '--cpus', String(host.NanoCpus / 1_000_000_000), '--memory', String(host.Memory),
      '--memory-swap', String(host.MemorySwap), '--pids-limit', String(host.PidsLimit)]
    for (const cap of host.CapAdd) args.push('--cap-add', cap)
    for (const option of host.SecurityOpt) args.push('--security-opt', option)
    for (const entry of host.ExtraHosts ?? []) args.push('--add-host', entry)
    for (const [key, value] of Object.entries(labels)) args.push('--label', `${key}=${value}`)
    args.push('--label', `com.freshell.task2-negative=${fault}`)
    for (const entry of config.Env ?? []) args.push('--env', entry)
    for (const bind of binds) args.push('--volume', bind)
    for (const [destination, options] of Object.entries(tmpfs)) args.push('--tmpfs', `${destination}:${options}`)
    if (config.User) args.push('--user', config.User)
    if (config.WorkingDir) args.push('--workdir', config.WorkingDir)
    args.push('--entrypoint', config.Entrypoint?.[0] ?? '', original.Image, ...config.Cmd)
    const id = docker(args).trim()
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('negative create did not return an exact full ID')
    this.trackedContainers.add(id) // before inspect/admission so failure still cleans this exact ID
    try {
      const bad = this.inspectContainer(id)
      const preservedHostFields = ['NetworkMode', 'PidMode', 'Privileged', 'ReadonlyRootfs', 'NanoCpus',
        'Memory', 'MemorySwap', 'PidsLimit', 'CapDrop', 'CapAdd', 'SecurityOpt', 'ExtraHosts', 'RestartPolicy']
      const preservedHostMismatch = preservedHostFields.filter(key => {
        const normalized = (value: unknown) => ['CapAdd', 'CapDrop'].includes(key) && Array.isArray(value)
          ? value.map((cap: string) => cap.replace(/^CAP_/, '')).sort() : value
        return JSON.stringify(normalized(bad.HostConfig[key])) !== JSON.stringify(normalized(host[key]))
      })
      const environmentNames = (entries: string[]) => entries.map(entry => entry.split('=', 1)[0])
      const environmentShape = {
        originalNames: environmentNames(config.Env ?? []), actualNames: environmentNames(bad.Config.Env ?? []),
        originalUnique: new Set(environmentNames(config.Env ?? [])).size === (config.Env ?? []).length,
        actualUnique: new Set(environmentNames(bad.Config.Env ?? [])).size === (bad.Config.Env ?? []).length,
        completeEntriesEqualIgnoringOrder: JSON.stringify([...(config.Env ?? [])].sort()) === JSON.stringify([...(bad.Config.Env ?? [])].sort()),
      }
      this.writeArtifact(`task2-negative-${fault}-environment-shape.json`, environmentShape)
      // Unique environment names have no ordering semantics. Refuse duplicate
      // names (where order can choose a value), and compare every exact entry.
      const environmentPreserved = environmentShape.originalUnique && environmentShape.actualUnique
        && environmentShape.completeEntriesEqualIgnoringOrder
      if (bad.State.Running || bad.State.Status !== 'created' || bad.State.Pid !== 0
        || bad.Id !== id || bad.Image !== original.Image || bad.HostConfig.ReadonlyRootfs !== true
        || preservedHostMismatch.length !== 0
        || JSON.stringify([...bad.HostConfig.Binds].sort()) !== JSON.stringify([...binds].sort())
        || JSON.stringify(bad.HostConfig.Tmpfs) !== JSON.stringify(tmpfs)
        || !environmentPreserved
        || JSON.stringify(bad.Config.Cmd) !== JSON.stringify(config.Cmd))
        throw new Error(`never-started negative fixture shape differs (host fields: ${preservedHostMismatch.join(',')}; binds: ${JSON.stringify([...bad.HostConfig.Binds].sort()) === JSON.stringify([...binds].sort())}; tmpfs: ${JSON.stringify(bad.HostConfig.Tmpfs) === JSON.stringify(tmpfs)}; env: ${environmentPreserved}; command: ${JSON.stringify(bad.Config.Cmd) === JSON.stringify(config.Cmd)})`)
      this.broker.admitTask2LegacyNegativeInspection(bad, original)
      this.recordLifecycle('task2.legacy_negative.created', { severity: 'info', fault, containerId: id, ownerContainerId: originalId })
      return id
    } catch (error) {
      this.removeTask2LegacyNegativeContainerExact(id)
      throw error
    }
  }

  removeTask2LegacyNegativeContainerExact(containerId: string): void {
    if (!this.task2FiniteFixtures || !this.trackedContainers.has(containerId) || !/^[a-f0-9]{64}$/.test(containerId))
      throw new Error('tracked finite negative enclosure required')
    const inspected = this.inspectContainer(containerId)
    if (inspected.Id !== containerId || inspected.State.Running || inspected.State.Status !== 'created'
      || inspected.Config.Labels['com.freshell.runtime-test-run-id'] !== this.runId
      || !['extra_mount', 'missing_tmpfs', 'missing_binary', 'foreign_binary'].includes(inspected.Config.Labels['com.freshell.task2-negative']))
      throw new Error('negative cleanup ownership or never-started state differs')
    this.broker.forgetTask2LegacyNegativeInspection(containerId)
    docker(['rm', containerId]) // no force; no start/stop/kill authority
    this.trackedContainers.delete(containerId)
  }
  inspectContainer(containerId: string): any {
    const output = docker(['inspect', containerId])
    return JSON.parse(output)[0]
  }

  isContainerRunning(containerId: string): boolean {
    const result = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', containerId], { encoding: 'utf8' })
    if (result.status !== 0) return false
    return result.stdout.trim() === 'true'
  }

  containerLogs(containerId: string): string {
    const result = spawnSync('docker', ['logs', containerId], { encoding: 'utf8' })
    return `${result.stdout ?? ''}${result.stderr ?? ''}`.slice(-20_000)
  }

  stopSupervisorExact(instance: SupervisorInstance): void {
    if (this.isContainerRunning(instance.containerId)) {
      const result = spawnSync('docker', ['stop', '-t', '2', instance.containerId], { encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr || `docker stop failed for ${instance.containerId}`)
    }
  }

  removeContainerExact(containerId: string): void {
    const inspect = spawnSync('docker', ['inspect', containerId], { encoding: 'utf8' })
    if (inspect.status !== 0) return
    const result = spawnSync('docker', ['rm', '-f', containerId], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || `docker rm failed for ${containerId}`)
    this.trackedContainers.delete(containerId)
    this.trackedSupervisorContainers.delete(containerId)
    this.trackedForeignContainers.delete(containerId)
  }

  createForeignSentinel(options: { scenarioId: string; installationId?: string }): string {
    const scenarioRoot = this.scenarioPath(options.scenarioId)
    fs.mkdirSync(scenarioRoot, { recursive: true })
    const name = `freshell-foreign-${this.runId.slice(0, 8)}-${randomUUID().slice(0, 8)}`
    const id = docker([
      'run', '-d', '--name', name, '--label', `com.freshell.runtime-test-run-id=${this.runId}`, '--network', 'none',
      '--label', 'com.freshell.managed=true',
      '--label', `com.freshell.installation-id=${options.installationId ?? `installation-${randomUUID()}`}`,
      '--label', `com.freshell.soul-id=soul-${randomUUID()}`,
      '--label', `com.freshell.incarnation-id=incarnation-${randomUUID()}`,
      '-e', `FRESHELL_CODEX_SIDECAR_ID=codex-sidecar-${randomUUID()}`,
      '-v', `${scenarioRoot}:${scenarioRoot}:rw`, '-w', scenarioRoot,
      this.imageRef, 'sleep', '600',
    ]).trim()
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error(`foreign sentinel invalid id: ${id}`)
    this.trackedForeignContainers.add(id)
    this.trackedContainers.add(id)
    this.recordLifecycle('foreign_sentinel.started', { id, scenarioId: options.scenarioId })
    return id
  }

  brokerReceiptsSince(before: Set<string>): BrokerReceipt[] {
    return this.broker.receipts().filter((receipt) => !before.has(receipt.containerId))
  }

  brokerEventsFor(containerId: string): BrokerEvent[] {
    return this.broker.destructiveRequestsFor(containerId)
  }

  runSandboxed(command: string): string {
    return execFileSync('bash', ['scripts/sandbox-test.sh', '--runtime-suite', command], { cwd: this.repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
  }

  runCommand(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
    return execFileSync(command, args, { cwd: options.cwd ?? this.repoRoot, env: { ...process.env, ...options.env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
  }

  private ensureRuntimeImage(): void {
    if (this.ownerIsolation && this.phase >= 2) {
      this.ownedImage = { tag: runOwnedRuntimeImageTag(this.runId, this.candidateSha), runId: this.runId, candidateSha: this.candidateSha }
      const image = buildRunOwnedRuntimeImage(this.repoRoot, this.runId, this.candidateSha)
      this.ownedImage.digest = image.digest
      this.imageRef = image.digest
      this.recordLifecycle('runtime.owned_image_built', { tag: image.tag, digest: image.digest })
      return
    }
    const tag = this.phase === 1 ? PHASE1_RUNTIME_IMAGE_TAG : PHASE2_RUNTIME_IMAGE_TAG
    let inspect = spawnSync('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'], { encoding: 'utf8' })
    if (this.phase === 1) {
      if (inspect.status !== 0) {
        docker(['pull', tag])
        inspect = spawnSync('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'], { encoding: 'utf8' })
      }
    } else {
      // Always invoke the Phase 2 build so Docker validates the current
      // Dockerfile/provider pins. Layer caching keeps unchanged rebuilds cheap.
      // BuildKit provenance captures the whole context digest, including files
      // the image never copies, and therefore changes the manifest-list ID for
      // an otherwise identical workload image. Disable attestations here so
      // the exact image identity is a reproducible digest of the image itself.
      execFileSync('docker', [
        'build',
        '--pull=false',
        '--provenance=false',
        '--sbom=false',
        '-f',
        'docker/runtime/Dockerfile',
        '-t',
        tag,
        '.',
      ], { cwd: this.repoRoot, stdio: 'inherit' })
      inspect = spawnSync('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'], { encoding: 'utf8' })
    }
    this.imageRef = inspect.stdout.trim()
    if (!/^sha256:[0-9a-f]{64}$/.test(this.imageRef)) throw new Error(`runtime image is not pinned: ${this.imageRef}`)
  }

  private phase2BootstrapFiles(): string[] {
    if (this.task2FiniteFixtures) return []
    if (this.ownerIsolation) return [...new Set(this.ownerIsolation.bootstrapProviders.flatMap(provider => configuredProviderOnecliGrantFiles(provider, process.env)))]
    return phase2BootstrapFiles()
  }

  private phase2WorkspaceRoots(): string[] {
    if (this.task2FiniteFixtures) return [this.testRoot]
    const roots = new Set<string>([this.repoRoot, this.testRoot])
    try {
      const common = git(this.repoRoot, ['rev-parse', '--git-common-dir']).trim()
      roots.add(fs.realpathSync(path.isAbsolute(common) ? common : path.join(this.repoRoot, common)))
    } catch {}
    return [...roots]
  }

  private phase2ProviderUserRoots(): string[] {
    return runtimeProviderUserRoots(this.task2FiniteFixtures || Boolean(this.ownerIsolation))
  }

  private buildBinaries(): void {
    fs.mkdirSync(this.buildDir, { recursive: true })
    const mise = path.join(os.homedir(), '.local', 'bin', 'mise')
    execFileSync(mise, ['exec', 'rust@1.96', '--', 'cargo', 'build', '-p', 'freshell-supervisor', '-p', 'freshell-session-host', '--features', 'freshell-supervisor/runtime-test-faults,freshell-session-host/fresh-agent-fixtures'], { cwd: this.repoRoot, stdio: 'inherit' })
    this.testSupervisorBinary = path.join(this.buildDir, 'freshell-supervisor-test')
    this.testHostBinary = path.join(this.buildDir, 'freshell-session-host-test')
    fs.copyFileSync(path.join(this.repoRoot, 'target/debug/freshell-supervisor'), this.testSupervisorBinary)
    fs.copyFileSync(path.join(this.repoRoot, 'target/debug/freshell-session-host'), this.testHostBinary)
    fs.chmodSync(this.testSupervisorBinary, 0o755)
    fs.chmodSync(this.testHostBinary, 0o755)

    execFileSync(mise, ['exec', 'rust@1.96', '--', 'cargo', 'build', '--release', '-p', 'freshell-supervisor', '-p', 'freshell-session-host'], { cwd: this.repoRoot, stdio: 'inherit' })
    this.releaseSupervisorBinary = path.join(this.buildDir, 'freshell-supervisor-release')
    this.releaseHostBinary = path.join(this.buildDir, 'freshell-session-host-release')
    fs.copyFileSync(path.join(this.repoRoot, 'target/release/freshell-supervisor'), this.releaseSupervisorBinary)
    fs.copyFileSync(path.join(this.repoRoot, 'target/release/freshell-session-host'), this.releaseHostBinary)
    fs.chmodSync(this.releaseSupervisorBinary, 0o755)
    fs.chmodSync(this.releaseHostBinary, 0o755)
  }

  private collectCapabilities(): unknown {
    const info = JSON.parse(docker(['info', '--format', '{{json .}}']))
    return {
      docker: {
        serverVersion: info.ServerVersion,
        cgroupDriver: info.CgroupDriver,
        cgroupVersion: info.CgroupVersion,
        memoryLimit: info.MemoryLimit,
        swapLimit: info.SwapLimit,
        cpuCfsQuota: info.CpuCfsQuota,
        pidsLimit: info.PidsLimit,
        securityOptions: info.SecurityOptions,
      },
      realDockerSocket: dockerSocketPath(),
      brokerSocket: this.broker.proxySocketPath,
      runtimeImage: this.imageRef,
    }
  }

  private collectBuildInfo(): unknown {
    const mise = path.join(os.homedir(), '.local', 'bin', 'mise')
    const rustc = execFileSync(mise, ['exec', 'rust@1.96', '--', 'rustc', '--version'], { encoding: 'utf8' }).trim()
    return {
      candidateSha: this.candidateSha,
      runtimeImage: this.imageRef,
      rustc,
      node: process.version,
      docker: docker(['version', '--format', 'client={{.Client.Version}} server={{.Server.Version}}']).trim(),
      binaries: {
        testSupervisor: fileBuild(this.testSupervisorBinary),
        testHost: fileBuild(this.testHostBinary),
        releaseSupervisor: fileBuild(this.releaseSupervisorBinary),
        releaseHost: fileBuild(this.releaseHostBinary),
      },
    }
  }

  private collectScenarioLifecycleLogs(): void {
    const runtimeNamespace = path.join(this.testRoot, 'r')
    if (!fs.existsSync(runtimeNamespace)) return
    for (const scenario of fs.readdirSync(runtimeNamespace)) {
      const log = path.join(runtimeNamespace, scenario, 'evidence', 'lifecycle.jsonl')
      if (!fs.existsSync(log)) continue
      for (const line of fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
        appendPrivateLine(this.lifecyclePath, { at: new Date().toISOString(), event: 'supervisor.lifecycle', data: { scenario, raw: JSON.parse(line) } })
      }
    }
  }
}

export function defaultLimits(): RuntimeLimits {
  return { cpuMilli: 500, memoryBytes: 128 * 1024 * 1024, swapBytes: 0, pidsMax: 64 }
}

export function newSoul(): string {
  return `soul-${randomUUID()}`
}

export function newRequest(): string {
  return `request-${randomUUID()}`
}

let dockerRootlessCache: boolean | undefined

function dockerIsRootless(): boolean {
  if (dockerRootlessCache !== undefined) return dockerRootlessCache
  try {
    const options = JSON.parse(docker(['info', '--format', '{{json .SecurityOptions}}'])) as string[]
    dockerRootlessCache = options.some((value) => /rootless/i.test(value))
  } catch {
    dockerRootlessCache = false
  }
  return dockerRootlessCache
}

export function dockerSocketPath(): string {
  const configured = process.env.DOCKER_HOST
  if (configured?.startsWith('unix://')) return configured.slice('unix://'.length)
  if (configured?.startsWith('unix:')) return configured.slice('unix:'.length)
  return path.join('/run/user', String(process.getuid?.() ?? 1000), 'docker.sock')
}

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/// Bound on one gate → supervisor control round trip.
///
/// A wedged supervisor must produce a FAIL with evidence, never an
/// indefinitely hanging gate: a run that never returns cannot be reviewed,
/// cannot clean up its own containers, and cannot be told apart from a slow
/// one. Generous by design — this catches deadlock, not slowness.
export const CONTROL_ROUND_TRIP_TIMEOUT_MS = Number(
  process.env.FRESHELL_RUNTIME_CONTROL_TIMEOUT_MS ?? 120_000,
)

function unixRoundTrip(
  socketPath: string,
  frame: Buffer,
  timeoutMs = CONTROL_ROUND_TRIP_TIMEOUT_MS,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    const chunks: Buffer[] = []
    let expected: number | undefined
    let done = false
    let timer: NodeJS.Timeout
    const fail = (error: unknown) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    }
    timer = setTimeout(() => {
      fail(new Error(`control round trip exceeded ${timeoutMs}ms: ${socketPath}`))
    }, timeoutMs)
    // A pending timer must never keep the gate process alive on its own.
    timer.unref?.()
    socket.once('error', fail)
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      if (expected === undefined && bytes.length >= 4) expected = bytes.readUInt32BE(0)
      if (expected !== undefined && bytes.length >= expected + 4) {
        try {
          const parsed = JSON.parse(bytes.subarray(4, 4 + expected).toString('utf8'))
          done = true
          clearTimeout(timer)
          socket.destroy()
          resolve(parsed)
        } catch (error) { fail(error) }
      }
    })
    socket.once('close', () => {
      if (!done) fail(new Error(`control socket closed before a complete reply: ${socketPath}`))
    })
    socket.once('connect', () => socket.write(frame))
  })
}

function fileBuild(filePath: string): unknown {
  const bytes = fs.readFileSync(filePath)
  const stat = fs.statSync(filePath)
  return { path: filePath, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: stat.size }
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120)
}

function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
}

function writePrivateJson(filePath: string, value: unknown): void {
  ensurePrivateDirectory(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
}

function appendPrivateLine(filePath: string, value: unknown): void {
  ensurePrivateDirectory(path.dirname(filePath))
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}


export type RuntimeWebInfo = {
  port: number; baseUrl: string; wsUrl: string; token: string
  configDir: string; homeDir: string; logsDir: string; debugLogPath: string; pid: number; runtimeRoot: string
}
export type RuntimeWebConstructOptions = {
  binary: string; repoRoot: string; preserveHomeOnStop: boolean; homeDir?: string
  candidateSha: string; buildDirty: boolean
  env: Record<string, string>; setupHome: (homeDir: string) => Promise<void>
  stripEnvPrefixes?: string[]
  providerFreeFixture?: boolean
  token?: string
}
export interface RuntimeWebHandle {
  readonly info: RuntimeWebInfo
  start(): Promise<RuntimeWebInfo>
  stop(): Promise<void>
  restart(): Promise<RuntimeWebInfo>
  restartAbrupt(): Promise<RuntimeWebInfo>
  kill(signal?: NodeJS.Signals): Promise<void>
  capturedOutput(): { stdout: string; stderr: string }
  processEvidence(): { pid: number; bootAttemptCount: number }
  ownedChildPids(): number[]
}
export type RuntimeWebFactory = (options: RuntimeWebConstructOptions) => RuntimeWebHandle
export function runtimeWebStripPrefixes(options: Pick<RuntimeWebConstructOptions, 'stripEnvPrefixes' | 'providerFreeFixture'>): string[] {
  return [...options.stripEnvPrefixes ?? [], ...(options.providerFreeFixture ? [
    'ANTHROPIC_', 'OPENAI_', 'GEMINI_', 'ONECLI_', 'FRESHELL_MANAGED_CLAUDE_',
    'FRESHELL_MANAGED_CODEX_', 'FRESHELL_MANAGED_OPENCODE_', 'FRESHELL_MANAGED_AMPLIFIER_',
  ] : [])]
}

export const P2_OPENCODE_VERSION = '1.18.21'
export const P2_OPENCODE_MODEL = 'openai/gpt-5.6-luna'

export type ManagedRuntimeView = {
  soulId: string
  incarnationId: string
  launchState: string
  cleanupState?: string
  intentRevision: number
  executionGeneration?: number
  effectiveLimits?: {
    cpuMilli: number
    memoryBytes: number
    swapBytes: number
    pidsMax: number
  }
  desiredState?: string
  recoveryState?: string
  durabilityState?: string
  allocationState?: string
  containerId?: string
  hostBootId?: string
  terminalId?: string
  terminalStreamId?: string
  terminalMode?: string
  terminalCwd?: string
  terminalCreateRequestId?: string
  terminalResumeSessionId?: string
  freshAgentSessionId?: string
  freshAgentSessionType?: string
  freshAgentRuntimeVariant?: string
  projectKey?: string
  profile?: string
  provider?: string
  nativeSessionId?: string
  recoveryReason?: string
  priorIncarnationId?: string
  recoveryAttemptId?: string
  evidenceRevision?: number
  successfulRecoveriesInWindow?: number
}

export type ManagedOpenCodeAdoptionStatus =
  | { state: 'not_required' | 'awaiting_observation' }
  | { state: 'observed'; data: { observation: {
      terminalId: string
      rootSessionId: string
      tailMessageId: string | null
      evidenceGeneration: string
      incarnationId: string
      launchNonce: string
      hydrated: boolean
      messagesRead: 'success' | 'empty_confirmed' | 'failed'
    } } }

export const ManagedOpenCodeAdoptionStatusSchema: z.ZodType<ManagedOpenCodeAdoptionStatus> = z.discriminatedUnion('state', [
  z.object({ state: z.enum(['not_required', 'awaiting_observation']) }).strict(),
  z.object({ state: z.literal('observed'), data: z.object({ observation: z.object({
    terminalId: z.string().min(1), rootSessionId: z.string().min(1), tailMessageId: z.string().nullable(),
    evidenceGeneration: z.string().min(1), incarnationId: z.string().min(1), launchNonce: z.string().min(1),
    hydrated: z.boolean(), messagesRead: z.enum(['success', 'empty_confirmed', 'failed']),
  }).strict() }).strict() }).strict(),
])

/**
 * Owned managed-runtime browser rig: restricted Docker broker + supervisor +
 * a feature-enabled Rust web server. Web restart methods touch only the web
 * process; dynamic session-host containers are outside its process tree and
 * remain owned by the supervisor/harness receipts.
 */
export class ManagedRuntimeOwner {
  readonly repoRoot: string
  readonly runtime: RuntimeHarness
  supervisor!: SupervisorInstance
  web!: RuntimeWebHandle
  info!: RuntimeWebInfo
  private serverBin = ''
  private readonly serverEnv: Record<string, string>
  private webHomeDir: string | undefined
  private readonly supervisorEnv: Record<string, string>
  private readonly supervisorBinaryKind: 'test' | 'release'
  private readonly enabledProviders: string[]
  private readonly providerSettings: Record<string, Record<string, unknown>>
  private readonly freshAgentModes: string[]
  private readonly fixtureFreshAgentModes: string[]
  private qualificationSupervisorBin: string | undefined
  private stopSettlement?: Promise<{ ok: boolean; errors: string[] }>
  private readonly heldHosts = new Map<string, { handle: ExactRuntimeHandle; pid: number }>()
  private readonly nativeChallenges = new Map<string, { soulId: string; nativeSessionId: string; marker: string }>()
  private readonly providerProbes = new Map<string, { child?: ChildProcess; settlement: Promise<string> }>()
  private syntheticSource?: { source: SyntheticSource; root: string; nonce: string }

  constructor(
    private readonly webFactory: RuntimeWebFactory,
    repoRoot = process.cwd(),
    phase: 2 | 3 | 4 | 5 = 2,
    serverEnv: Record<string, string> = {},
    supervisorEnv: Record<string, string> = {},
    supervisorBinaryKind: 'test' | 'release' = 'test',
    qualificationProviders: {
      enabledProviders: string[]
      providerSettings?: Record<string, Record<string, unknown>>
      freshAgentModes?: string[]
      fixtureFreshAgentModes?: string[]
    } = { enabledProviders: ['opencode'] },
    webHomeDir?: string,
    ownerIsolation?: RuntimeOwnerIsolation,
  ) {
    this.repoRoot = fs.realpathSync(repoRoot)
    this.runtime = new RuntimeHarness(this.repoRoot, undefined, phase, ownerIsolation)
    this.serverEnv = { ...serverEnv }
    this.webHomeDir = webHomeDir
    this.supervisorEnv = { ...supervisorEnv }
    this.supervisorBinaryKind = supervisorBinaryKind
    this.enabledProviders = [...qualificationProviders.enabledProviders]
    this.providerSettings = { ...qualificationProviders.providerSettings }
    this.freshAgentModes = [...(qualificationProviders.freshAgentModes ?? [])]
    this.fixtureFreshAgentModes = [...(qualificationProviders.fixtureFreshAgentModes ?? [])]
    if (this.fixtureFreshAgentModes.length > 0 && supervisorBinaryKind !== 'test') {
      throw new Error('deterministic fresh-agent fixtures require the test session-host build')
    }
  }

  async prepareSyntheticOpenCodeSource(): Promise<SyntheticOpenCodeSourceFacts> {
    if (this.syntheticSource) return this.syntheticOpenCodeSourceFacts()
    if (process.env.FRESHELL_RUNTIME_SYNTHETIC_RESUME !== '1' || this.runtime.phase !== 3
      || this.enabledProviders.length !== 1 || this.enabledProviders[0] !== 'opencode'
      || this.web || this.stopSettlement || this.webHomeDir) {
      throw new Error('synthetic OpenCode source requires its exact opt-in before owned web setup')
    }
    const root = fs.mkdtempSync(path.join(this.repoRoot, '.freshell-opencode-resume-'))
    try {
      const nonce = randomBytes(8).toString('hex')
      const home = path.join(root, 'web-home')
      const databasePath = path.join(home, '.local/share/opencode/opencode.db')
      const source = seedManagedOpenCodeSource({ repoRoot: this.repoRoot, databasePath, workspace: this.repoRoot, nonce })
      this.syntheticSource = { source, root, nonce }
      const facts = await this.syntheticOpenCodeSourceFacts()
      this.webHomeDir = home
      this.serverEnv.OPENCODE_DB = databasePath
      this.supervisorEnv.OPENCODE_DB = databasePath
      this.runtime.recordLifecycle('source-fixture.prepared', { sourceReference: root, rootId: source.rootId })
      return facts
    } catch (error) {
      fs.rmSync(root, { recursive: true, force: true })
      this.syntheticSource = undefined
      throw error
    }
  }

  async syntheticOpenCodeSourceFacts(): Promise<SyntheticOpenCodeSourceFacts> {
    const fixture = this.syntheticSource
    if (!fixture) throw new Error('synthetic OpenCode source is not registered')
    const { source, nonce } = fixture
    const db = new DatabaseSync(source.databasePath, { readOnly: true })
    try {
      const rootMessageCount = z.number().int().nonnegative().parse(
        db.prepare('SELECT COUNT(*) AS count FROM message WHERE session_id = ?').get(source.rootId)?.count)
      return SyntheticOpenCodeSourceFactsSchema.parse({ rootId: source.rootId, childId: source.childId,
        grandchildId: source.grandchildId, unrelatedId: source.unrelatedId, lastMessageId: source.lastMessageId,
        nonce, baselineMessages: Object.fromEntries(source.baselineMessages), baselineParts: Object.fromEntries(source.baselineParts),
        rootMessageCount })
    } finally { db.close() }
  }

  private async assertSyntheticOpenCodeSourceHandle(handle: ExactRuntimeHandle): Promise<void> {
    await this.assertCurrentHandle(handle)
    if (!this.syntheticSource || handle.nativeSessionId !== this.syntheticSource.source.rootId) {
      throw new Error('registered synthetic source root differs from the exact runtime')
    }
  }

  async syntheticOpenCodeHistoryFacts(handle: ExactRuntimeHandle): Promise<SyntheticOpenCodeHistoryFacts> {
    await this.assertSyntheticOpenCodeSourceHandle(handle)
    const raw = await this.ownedProviderExec(handle.containerId, ['node', '--no-warnings', '-e', PROVIDER_HISTORY_DIGESTS,
      '/home/freshell/provider/.local/share/opencode/opencode.db', handle.nativeSessionId])
    return SyntheticOpenCodeHistoryFactsSchema.parse(JSON.parse(raw))
  }

  async syntheticOpenCodeExcludedSentinels(handle: ExactRuntimeHandle): Promise<string[]> {
    await this.assertSyntheticOpenCodeSourceHandle(handle)
    const raw = await this.ownedProviderExec(handle.containerId, ['node', '--no-warnings', '-e', PROVIDER_SENTINEL_SCAN,
      '/home/freshell/provider/.local/share/opencode/opencode.db', JSON.stringify(EXCLUDED_SOURCE_SENTINELS)])
    return z.array(z.enum(EXCLUDED_SOURCE_SENTINELS)).parse(JSON.parse(raw))
  }

  async syntheticOpenCodeAdoptionStatus(handle: ExactRuntimeHandle): Promise<ManagedOpenCodeAdoptionStatus> {
    await this.assertSyntheticOpenCodeSourceHandle(handle)
    const view = (await this.inventory()).find(row => row.soulId === handle.soulId && row.incarnationId === handle.incarnationId)
    if (!view || view.incarnationId !== handle.incarnationId || view.containerId !== handle.containerId
      || view.hostBootId !== handle.hostBootId || view.nativeSessionId !== handle.nativeSessionId) {
      throw new Error('registered source adoption address changed before its probe')
    }
    const status = ManagedOpenCodeAdoptionStatusSchema.parse(await this.ownedOpenCodeAdoptionStatus(view))
    if (status.state === 'observed' && status.data.observation.rootSessionId !== handle.nativeSessionId) {
      throw new Error('registered source adoption observation belongs to another root')
    }
    return status
  }

  async syntheticOpenCodeFollowUpMessageId(handle: ExactRuntimeHandle): Promise<string | null> {
    await this.assertSyntheticOpenCodeSourceHandle(handle)
    const fixture = this.syntheticSource
    if (!fixture) throw new Error('registered synthetic source required')
    const raw = await this.ownedProviderExec(handle.containerId, ['node', '--no-warnings', '-e', OPENCODE_NATIVE_HISTORY_SCRIPT,
      '/home/freshell/provider/.local/share/opencode/opencode.db', handle.nativeSessionId])
    const history = z.object({ turns: z.array(z.object({ messageId: z.string().min(1), text: z.string(),
      toolCalls: z.array(z.unknown()) }).passthrough()) }).passthrough().parse(JSON.parse(raw))
    const turn = history.turns.find(candidate => !fixture.source.baselineMessages.has(candidate.messageId)
      && candidate.toolCalls.length === 0 && candidate.text.includes(`SYNTHETIC_FOLLOWUP_${fixture.nonce}`))
    return turn?.messageId ?? null
  }

  async start(): Promise<RuntimeWebInfo> {
    await this.runtime.prepare()
    this.qualificationSupervisorBin = this.buildQualificationSupervisor()
    this.serverBin = this.buildManagedServer()
    const selected = this.pendingQualificationProviders()
    this.runtime.recordProviderQualificationBuild({
      kind: selected.length ? 'qualification_fixture' : 'production',
      serverFeatures: [selected.length ? 'managed-provider-qualification' : 'managed-runtime-v1'],
      supervisorFeatures: selected.length ? ['provider-qualification'] : [],
      qualificationProviders: selected,
      serverBinary: this.serverBin,
      supervisorBinary: this.qualificationSupervisorBin
        ?? (this.supervisorBinaryKind === 'test'
          ? this.runtime.testSupervisorBinary
          : this.runtime.releaseSupervisorBinary),
    })
    if (this.freshAgentModes.length > 0) {
      const supervisorBinary = this.qualificationSupervisorBin
        ?? (this.supervisorBinaryKind === 'test'
          ? this.runtime.testSupervisorBinary
          : this.runtime.releaseSupervisorBinary)
      this.runtime.recordFreshAgentQualificationBuild({
        kind: this.fixtureFreshAgentModes.length > 0 ? 'deterministic_fixture' : 'production',
        serverFeatures: [this.fixtureFreshAgentModes.length > 0
          ? 'managed-fresh-agent-fixtures'
          : 'managed-runtime-v1'],
        sessionHostFeatures: this.fixtureFreshAgentModes.length > 0 ? ['fresh-agent-fixtures'] : [],
        selectedModes: this.freshAgentModes,
        fixtureModes: this.fixtureFreshAgentModes,
        serverBinary: this.serverBin,
        supervisorBinary,
        sessionHostBinary: this.supervisorBinaryKind === 'test'
          ? this.runtime.testHostBinary
          : this.runtime.releaseHostBinary,
      })
    }
    this.supervisor = await this.runtime.startSupervisor({
      scenarioId: 'browser-managed-runtime',
      binaryKind: this.supervisorBinaryKind,
      env: { ...this.supervisorEnv, ...this.qualificationEnvironment() },
      binaryPath: this.qualificationSupervisorBin,
    })
    this.web = this.webFactory({
      binary: this.serverBin, repoRoot: this.repoRoot, candidateSha: this.runtime.candidateSha,
      buildDirty: git(this.repoRoot, ['status', '--porcelain']).trim().length > 0,
      preserveHomeOnStop: true,
      providerFreeFixture: this.fixtureFreshAgentModes.length > 0 && this.enabledProviders.length === 0
        && this.freshAgentModes.every(mode => this.fixtureFreshAgentModes.includes(mode)),
      homeDir: this.webHomeDir,
      env: {
        // Managed MCP calls back from Docker workloads, so this owned
        // ephemeral-port server must override RustServer's loopback default.
        FRESHELL_BIND_HOST: '0.0.0.0',
        FRESHELL_MANAGED_RUNTIME_V1: '1',
        ...(this.freshAgentModes.length > 0
          ? { FRESHELL_MANAGED_FRESH_AGENT_V1: '1' }
          : {}),
        ...(this.fixtureFreshAgentModes.length > 0
          ? { FRESHELL_MANAGED_FRESH_AGENT_FIXTURE_MODES: this.fixtureFreshAgentModes.join(',') }
          : {}),
        FRESHELL_RUNTIME_CONTROL_SOCKET: this.supervisor.controlSocket,
        FRESHELL_RUNTIME_CONTROL_SECRET_FILE: this.supervisor.controlSecretFile,
        ...this.serverEnv,
        ...this.qualificationEnvironment(),
      },
      setupHome: async (homeDir) => {
        const freshell = path.join(homeDir, '.freshell')
        await fsp.mkdir(freshell, { recursive: true })
        await fsp.writeFile(path.join(freshell, 'config.json'), JSON.stringify({
          version: 1,
          settings: {
            defaultCwd: this.repoRoot,
            codingCli: {
              enabledProviders: this.enabledProviders,
              providers: {
                ...(this.enabledProviders.includes('opencode')
                  ? { opencode: { model: P2_OPENCODE_MODEL } }
                  : {}),
                ...this.providerSettings,
              },
            },
            ...(this.freshAgentModes.length > 0
              ? {
                  freshAgent: {
                    enabled: true,
                    providers: this.providerSettings,
                  },
                }
              : {}),
          },
        }, null, 2))
      },
    })
    const previous = process.env.FRESHELL_E2E_RUST_SERVER_BIN
    process.env.FRESHELL_E2E_RUST_SERVER_BIN = this.serverBin
    try {
      this.info = await this.web.start()
    } finally {
      if (previous === undefined) delete process.env.FRESHELL_E2E_RUST_SERVER_BIN
      else process.env.FRESHELL_E2E_RUST_SERVER_BIN = previous
    }
    return this.info
  }

  fixtureRegistrationFacts(): {
    phase: number; enabledProviders: string[]; freshAgentModes: string[]; fixtureFreshAgentModes: string[]
  } {
    return { phase: this.runtime.phase, enabledProviders: [...this.enabledProviders],
      freshAgentModes: [...this.freshAgentModes], fixtureFreshAgentModes: [...this.fixtureFreshAgentModes] }
  }

  async restartWebGracefully(): Promise<RuntimeWebInfo> {
    return this.withManagedBin(() => this.web.restart())
  }

  async webProcessFacts(): Promise<RuntimeWebProcessFacts> {
    if (!this.web) throw new Error('owned web process is not prepared')
    return RuntimeWebProcessFactsSchema.parse(this.web.processEvidence())
  }

  async supervisorProcessFacts(): Promise<RuntimeSupervisorProcessFacts> {
    if (!this.supervisor) throw new Error('owned supervisor process is not prepared')
    const containerId = RuntimeSupervisorProcessFactsSchema.shape.containerId.parse(this.supervisor.containerId)
    return RuntimeSupervisorProcessFactsSchema.parse({ containerId, pid: this.runtime.ownedContainerHostPidExact(containerId) })
  }

  async chaosWebOutputFacts(handle: ExactRuntimeHandle, challengeId: string): Promise<RuntimeChaosWebOutputFacts> {
    const marker = await this.nativeChallengeMarker(handle, challengeId)
    if (marker !== NativeChallengeMarkers['chaos-follow-up']) throw new Error('registered chaos follow-up challenge required')
    if (!this.web) throw new Error('owned web process is not prepared')
    const token = this.web.info.token
    if (!token) throw new Error('owned web token is absent')
    const output = z.object({ stdout: z.string(), stderr: z.string() }).strict().parse(this.web.capturedOutput())
    const bytes = `${output.stdout}${output.stderr}`
    return { contentSha256: createHash('sha256').update(bytes).digest('hex'), contentBytes: Buffer.byteLength(bytes),
      containsFollowUpMarker: bytes.includes(marker), containsAuthToken: bytes.includes(token) }
  }

  async restartWeb(): Promise<RuntimeWebInfo> {
    return this.restartWebGracefully()
  }

  async crashAndRestartWeb(): Promise<RuntimeWebInfo> {
    return this.withManagedBin(() => this.web.restartAbrupt())
  }

  async crashWeb(): Promise<RuntimeWebInfo> {
    return this.crashAndRestartWeb()
  }

  async restartSupervisor(): Promise<SupervisorInstance> {
    return this.replaceSupervisor('graceful')
  }

  async restartSupervisorAbrupt(): Promise<SupervisorInstance> {
    return this.replaceSupervisor('abrupt')
  }

  private async replaceSupervisor(mode: 'graceful' | 'abrupt'): Promise<SupervisorInstance> {
    const previous = this.supervisor
    if (mode === 'abrupt') this.runtime.killTrackedContainerExact(previous.containerId)
    else this.runtime.stopSupervisorExact(previous)
    this.runtime.removeContainerExact(previous.containerId)
    this.supervisor = await this.runtime.startSupervisor({
      scenarioId: previous.scenarioId,
      volumeName: previous.volumeName,
      binaryKind: previous.binaryKind,
      reuseSecret: true,
      env: { ...this.supervisorEnv, ...this.qualificationEnvironment() },
      binaryPath: this.qualificationSupervisorBin,
    })
    return this.supervisor
  }

  async stopSoul(soulId: string): Promise<any> {
    const epoch = await this.controlEpoch()
    const result = await this.runtime.adminOk(this.supervisor, this.runtime.stopBody(soulId, epoch))
    return this.dataOf(result, 'stop')
  }

  async stopRuntimeSoul(handle: ExactRuntimeHandle, expectedControlEpoch: number, expectedIntentRevision: number): Promise<ManagedStopResult> {
    await this.assertCurrentHandle(handle)
    if (expectedControlEpoch !== await this.controlEpoch()) throw new Error('exact Stop controller epoch is stale')
    const current = (await this.inventory()).find(row => row.soulId === handle.soulId && row.incarnationId === handle.incarnationId)
    if (!current || current.intentRevision !== expectedIntentRevision) throw new Error('exact Stop intent revision is stale')
    const result = await this.runtime.adminOk(this.supervisor,
      this.runtime.stopBody(handle.soulId, expectedControlEpoch, expectedIntentRevision))
    return ManagedStopResultSchema.parse(this.dataOf(result, 'stop'))
  }

  async stop(): Promise<{ ok: boolean; errors: string[] }> {
    if (this.stopSettlement) return this.stopSettlement
    this.stopSettlement = (async () => {
      const result = await settleOwnedRuntimeCleanup(() => this.stopWebAndReleaseHeldHosts(), () => this.runtime.cleanup())
      if (result.ok && this.syntheticSource) {
        try { await fsp.rm(this.syntheticSource.root, { recursive: true, force: true }) }
        catch { result.ok = false; result.errors.push('owned synthetic source cleanup failed') }
      }
      const cleanupPath = path.join(this.runtime.evidenceDir, 'cleanup.json')
      let runtimeCleanup: Record<string, unknown> = {}
      try { runtimeCleanup = objectFields(JSON.parse(fs.readFileSync(cleanupPath, 'utf8')), 'invalid owner cleanup artifact') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          result.errors.push(`cleanup artifact: ${error instanceof Error ? error.message : String(error)}`)
          result.ok = false
        }
      }
      this.runtime.writeArtifact('cleanup.json', { ...runtimeCleanup, ...result })
      return result
    })()
    try {
      const result = await this.stopSettlement
      if (!result.ok) this.stopSettlement = undefined
      return result
    } catch (error) { this.stopSettlement = undefined; throw error }
  }

  private async stopWebAndReleaseHeldHosts(): Promise<void> {
    const errors: unknown[] = []
    const probes = [...this.providerProbes.values()]
    for (const probe of probes) {
      if (probe.child && probe.child.exitCode === null && probe.child.signalCode === null) {
        try { probe.child.kill('SIGKILL') } catch (error) { errors.push(error) }
      }
    }
    await Promise.allSettled(probes.map(probe => probe.settlement))
    for (const { handle } of this.heldHosts.values()) {
      try { await this.releaseRuntimeHost(handle) }
      catch (error) {
        errors.push(error)
        this.runtime.recordLifecycle('external.host_release_failed', { severity: 'error', ...handle })
      }
    }
    try { await this.web?.stop() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'held host release or web cleanup failed')
  }

  async destroyTestRig(): Promise<{ ok: boolean; errors: string[] }> {
    return this.stop()
  }

  async controlEpoch(): Promise<number> {
    const health = await this.runtime.adminOk(this.supervisor, { method: 'health' })
    const data = this.dataOf(health, 'health')
    return data.controlEpoch ?? data.control_epoch
  }

  async incidentMatchesSoul(handle: ExactRuntimeHandle, incidentId: string): Promise<boolean> {
    await this.assertCurrentHandle(handle)
    const result = await this.runtime.adminOk(this.supervisor,
      this.runtime.incidentSummaryBody(incidentId, await this.controlEpoch()))
    const summary = z.object({ soulId: z.string().min(1).optional(), soul_id: z.string().min(1).optional() })
      .passthrough().parse(this.dataOf(result, 'incident_summary'))
    if ((!summary.soulId && !summary.soul_id)
      || (summary.soulId && summary.soul_id && summary.soulId !== summary.soul_id)) {
      throw new Error('incident soul observation is absent or ambiguous')
    }
    return (summary.soulId ?? summary.soul_id) === handle.soulId
  }

  async applyManagedOptIn(expectedControlEpoch: number): Promise<ManagedMigrationFacts> {
    if (expectedControlEpoch !== await this.controlEpoch()) throw new Error('managed preset controller epoch is stale')
    const result = await this.runtime.adminOk(this.supervisor, this.runtime.migrationPlanBody({
      requestedMode: 'managed-opt-in', apply: true, expectedControlEpoch,
    }))
    return ManagedMigrationFactsSchema.parse(this.dataOf(result, 'migration_plan'))
  }

  async inventory(): Promise<ManagedRuntimeView[]> {
    const result = await this.runtime.adminOk(this.supervisor, { method: 'inventory' })
    return this.dataOf(result, 'inventory') as ManagedRuntimeView[]
  }

  async inventorySnapshot(): Promise<ManagedRuntimeInventorySnapshot> {
    const result = await this.runtime.adminOk(this.supervisor, { method: 'inventory_snapshot' })
    return ManagedRuntimeInventorySnapshotSchema.parse(this.dataOf(result, 'inventory_snapshot'))
  }

  /** Saved addresses fence read-only writer evidence, including a stopped claim's zero count. */
  async writerClaimFacts(handle: ExactRuntimeHandle): Promise<RuntimeWriterClaimFacts> {
    if (handle.runId !== this.runtime.runId || handle.candidateSha !== this.runtime.candidateSha
      || !this.runtime.broker.receipts().some(row => row.containerId === handle.containerId
        && row.soulId === handle.soulId && row.incarnationId === handle.incarnationId)) {
      throw new Error('writer observation requires an exact owned address')
    }
    const matchingRows = (await this.inventory()).filter(row => row.soulId === handle.soulId && row.incarnationId === handle.incarnationId)
    const row = matchingRows[0]
    if (matchingRows.length !== 1 || !row.provider || row.incarnationId !== handle.incarnationId
      || row.containerId !== handle.containerId || row.hostBootId !== handle.hostBootId
      || row.nativeSessionId !== handle.nativeSessionId) throw new Error('writer address is not the current owned incarnation and root')
    return this.qualificationWriterClaim({ provider: row.provider, nativeSessionId: row.nativeSessionId,
      soulId: row.soulId, incarnationId: row.incarnationId })
  }

  async qualificationWriterClaim(input: {
    provider: string
    nativeSessionId: string
    soulId: string
    incarnationId: string
  }): Promise<any> {
    const result = await this.runtime.adminOk(this.supervisor, {
      method: 'qualification_writer_claim',
      params: input,
    })
    return this.dataOf(result, 'qualification_writer_claim')
  }

  async runningViewForTerminal(terminalId: string): Promise<ManagedRuntimeView | null> {
    return (await this.inventory()).find((row) => row.terminalId === terminalId && row.launchState === 'running') ?? null
  }

  async runningViewForFreshSession(sessionId: string): Promise<ManagedRuntimeView | null> {
    return (await this.inventory()).find((row: any) => (
      row.freshAgentSessionId === sessionId && row.launchState === 'running'
    )) ?? null
  }

  exactRuntimeHandle(view: Pick<ManagedRuntimeView, 'soulId' | 'incarnationId' | 'containerId' | 'hostBootId' | 'nativeSessionId'>): ExactRuntimeHandle {
    if (!view.containerId || !view.hostBootId || !view.nativeSessionId) throw new Error('exact current runtime address required')
    return {
      runId: this.runtime.runId, candidateSha: this.runtime.candidateSha,
      soulId: view.soulId, incarnationId: view.incarnationId, containerId: view.containerId,
      hostBootId: view.hostBootId, nativeSessionId: view.nativeSessionId,
    }
  }

  async chaosHostFacts(handle: ExactRuntimeHandle): Promise<RuntimeHostFacts> {
    return readExactRuntimeHostFacts({
      ...this.runtimeFactsAdapter(handle),
      readHostFacts: async (current) => {
        const state = JSON.parse(await fsp.readFile(path.join(this.runtime.runtimeDir(this.supervisor, current.incarnationId), 'host-state.json'), 'utf8'))
        if (state.hostBootId !== current.hostBootId) throw new Error('owner host facts belong to a replaced boot')
        const limits = JSON.parse(await this.ownedDockerProbe(current.containerId, [
          'node', '-e',
          "const fs=require('node:fs');const root='/sys/fs/cgroup/';process.stdout.write(JSON.stringify({cpuMax:fs.readFileSync(root+'cpu.max','utf8').trim(),memoryMax:fs.readFileSync(root+'memory.max','utf8').trim(),swapMax:fs.readFileSync(root+'memory.swap.max','utf8').trim(),pidsMax:fs.readFileSync(root+'pids.max','utf8').trim()}))",
        ], false))
        return {
          workerPid: state.workerPid, workerLaunchCount: state.workerLaunchCount,
          limits, unsafeBrokerAttempts: this.runtime.broker.unsafeAttempts().length,
        }
      },
    }, handle)
  }

  private runtimeFactsAdapter(handle: ExactRuntimeHandle): Omit<RuntimeOwnerFactsAdapter, 'readHostFacts'> {
    return {
      runId: this.runtime.runId, candidateSha: this.runtime.candidateSha,
      inventory: async () => {
        const rows = (await this.inventory()).filter(row => row.soulId === handle.soulId && row.launchState !== 'stopped')
        if (rows.length !== 1) throw new Error('exact current runtime inventory is absent or ambiguous')
        return rows.flatMap(row => row.containerId && row.hostBootId && row.nativeSessionId
          ? [{ ...row, containerId: row.containerId, hostBootId: row.hostBootId, nativeSessionId: row.nativeSessionId }]
          : [])
      },
      receipts: () => this.runtime.broker.receipts(),
    }
  }

  async assertCurrentHandle(handle: ExactRuntimeHandle): Promise<void> {
    await assertExactRuntimeHandle(this.runtimeFactsAdapter(handle), handle)
  }

  async crashRuntimeHost(handle: ExactRuntimeHandle): Promise<void> {
    await this.assertCurrentHandle(handle)
    this.runtime.killOwnedRuntimeExact(handle.containerId)
  }

  runtimeEnclosureHandle(view: Pick<ManagedRuntimeView, 'soulId' | 'incarnationId' | 'containerId' | 'hostBootId'>): RuntimeEnclosureHandle {
    return createRuntimeEnclosureHandle(this.runtime, view)
  }

  private async currentRuntimeEnclosure(handle: RuntimeEnclosureHandle): Promise<ManagedRuntimeView> {
    const rows = (await this.inventory()).filter(view => view.soulId === handle.soulId && view.launchState !== 'stopped')
    const row = rows[0]
    if (handle.runId !== this.runtime.runId || handle.candidateSha !== this.runtime.candidateSha || rows.length !== 1
      || row.launchState !== 'running' || row.incarnationId !== handle.incarnationId
      || row.containerId !== handle.containerId || row.hostBootId !== handle.hostBootId
      || !this.runtime.broker.receipts().some(receipt => receipt.soulId === handle.soulId
        && receipt.incarnationId === handle.incarnationId && receipt.containerId === handle.containerId)) {
      throw new Error('address is not the exact current owned enclosure')
    }
    return row
  }

  private async assertCurrentOpenCodeEnclosure(handle: RuntimeEnclosureHandle): Promise<void> {
    if ((await this.currentRuntimeEnclosure(handle)).provider !== 'opencode') throw new Error('exact OpenCode runtime required')
  }

  async freshAgentLaunchFacts(handle: RuntimeEnclosureHandle): Promise<FreshAgentLaunchFacts> {
    const row = await this.currentRuntimeEnclosure(handle)
    const mode = row.freshAgentSessionType
    if (this.runtime.phase !== 5 || !mode || !this.freshAgentModes.includes(mode) || this.fixtureFreshAgentModes.includes(mode)) {
      throw new Error('registered production fresh-agent mode required')
    }
    const provider = mode === 'freshclaude' || mode === 'kilroy' ? 'claude'
      : mode === 'freshcodex' ? 'codex' : mode === 'freshopencode' ? 'opencode' : null
    const registeredProvider = mode === 'kilroy' ? 'kilroy' : provider
    if (!provider || row.provider !== registeredProvider) throw new Error('fresh-agent provider registration differs')
    const raw = await this.ownedProviderExec(handle.containerId, [provider, '--version'])
    const version = raw.match(/\b\d+\.\d+\.\d+\b/)?.[0]
    if (!version) throw new Error('provider version reply is invalid')
    const pattern = provider === 'claude' ? /(?:^|\s)claude(?:$|\s)/m
      : provider === 'codex' ? /codex.*app-server|app-server.*codex/m : /opencode.*serve/m
    const processes = await this.ownedProviderExec(handle.containerId, ['ps', '-eo', 'pid,args'])
    const process = processes.split('\n').find(line => pattern.test(line))
    const workerPid = Number(process?.trim().match(/^(\d+)/)?.[1])
    if (!Number.isSafeInteger(workerPid) || workerPid <= 1) throw new Error('actual provider child PID was not found')
    return { provider, version, workerPid }
  }

  /** A prior tracked enclosure may be stopped or removed; this never qualifies a native root. */
  async ownedContainerState(handle: RuntimeEnclosureHandle): Promise<OwnedContainerState> {
    const receipts = this.runtime.broker.receipts().filter(receipt => receipt.soulId === handle.soulId
      && receipt.incarnationId === handle.incarnationId && receipt.containerId === handle.containerId)
    if (handle.runId !== this.runtime.runId || handle.candidateSha !== this.runtime.candidateSha || receipts.length !== 1) {
      throw new Error('exact owned container address required')
    }
    const state = z.object({ hostBootId: z.literal(handle.hostBootId) }).passthrough()
      .safeParse(JSON.parse(await fsp.readFile(path.join(receipts[0].runtimeDir, 'host-state.json'), 'utf8')))
    if (!state.success) throw new Error('owned container address belongs to another boot')
    const listed = (await this.trackedDockerProbe(handle.containerId, ['ps', '-a', '--no-trunc', '--filter',
      `id=${handle.containerId}`, '--format', '{{.ID}}'])).trim()
    if (!listed) return { present: false, running: false }
    if (listed !== handle.containerId) throw new Error('owned container inspection identity is ambiguous or differs')
    const inspected = z.array(z.object({ Id: z.literal(handle.containerId),
      State: z.object({ Running: z.boolean() }).passthrough() }).passthrough()).length(1)
      .parse(JSON.parse(await this.trackedDockerProbe(handle.containerId, ['inspect', handle.containerId])))
    return { present: true, running: inspected[0].State.Running }
  }

  async resetPhase3ApprovalEffect(handle: RuntimeEnclosureHandle): Promise<void> {
    if (this.runtime.phase !== 3) throw new Error('Phase 3 approval fixture required')
    await this.assertCurrentOpenCodeEnclosure(handle)
    await this.ownedProviderExec(handle.containerId, ['sh', '-lc', 'rm -f "$HOME/p3-tool-effect-count"'])
  }

  async phase3ApprovalEffectCount(handle: RuntimeEnclosureHandle): Promise<number> {
    if (this.runtime.phase !== 3) throw new Error('Phase 3 approval fixture required')
    await this.assertCurrentOpenCodeEnclosure(handle)
    const raw = (await this.ownedProviderExec(handle.containerId, ['sh', '-lc',
      'if test -f "$HOME/p3-tool-effect-count"; then wc -l < "$HOME/p3-tool-effect-count"; else printf 0; fi'])).trim()
    return /^\d+$/.test(raw) ? Number(raw) : -1
  }

  async openCodeVersionFacts(handle: RuntimeEnclosureHandle): Promise<{ provider: 'opencode'; version: string }> {
    await this.assertCurrentOpenCodeEnclosure(handle)
    const version = (await this.ownedProviderExec(handle.containerId, ['opencode', '--version'])).trim()
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('OpenCode version reply is invalid')
    return { provider: 'opencode', version }
  }

  async crashProviderWorker(handle: ExactRuntimeHandle): Promise<void> {
    await this.assertCurrentHandle(handle)
    const row = (await this.inventory()).find(view => view.soulId === handle.soulId && view.launchState === 'running')
    const facts = row?.freshAgentSessionType
      ? await this.freshAgentLaunchFacts(this.runtimeEnclosureHandle(handle))
      : await this.chaosHostFacts(handle)
    if (!Number.isSafeInteger(facts.workerPid) || facts.workerPid <= 1) throw new Error('exact host-recorded provider child PID required')
    this.runtime.recordLifecycle('external.provider_worker_crash', { severity: 'info', ...handle, workerPid: facts.workerPid })
    this.runtime.killOwnedRuntimePidExact(handle.containerId, facts.workerPid)
  }

  async registerNativeChallenge(handle: ExactRuntimeHandle, kind: NativeChallengeKind): Promise<{ challengeId: string }> {
    await this.assertCurrentHandle(handle)
    if (!Object.hasOwn(NativeChallengeMarkers, kind)) throw new Error('registered native challenge kind required')
    const challengeId = randomUUID()
    this.nativeChallenges.set(challengeId, { soulId: handle.soulId, nativeSessionId: handle.nativeSessionId,
      marker: NativeChallengeMarkers[kind] })
    return { challengeId }
  }

  async createSyntheticOpenCodeChallenge(handle: ExactRuntimeHandle): Promise<SyntheticOpenCodeChallenge> {
    if (!this.fixtureFreshAgentModes.includes('freshopencode')) throw new Error('registered synthetic OpenCode fixture required')
    const worker = await this.fixtureWorkerFacts(handle)
    if (worker.provider !== 'opencode') throw new Error('registered synthetic OpenCode worker required')
    await this.fixtureNativeState(handle)
    const challengeId = randomUUID(), marker = `task008-synthetic-${challengeId}`
    this.nativeChallenges.set(challengeId, { soulId: handle.soulId, nativeSessionId: handle.nativeSessionId, marker })
    // Initialize the installed CLI's actual schema without dispatching a turn.
    await this.ownedProviderExec(handle.containerId, ['env', 'XDG_DATA_HOME=/home/freshell/provider/.local/share',
      'OPENCODE_DISABLE_DEFAULT_PLUGINS=1', 'OPENCODE_DISABLE_MODELS_FETCH=1', 'OPENCODE_DISABLE_AUTOUPDATE=1',
      'opencode', 'session', 'list', '--format', 'json'])
    const raw = await this.ownedProviderExec(handle.containerId, ['node', '--no-warnings', '-e', SYNTHETIC_OPENCODE_CHALLENGE_SCRIPT,
      handle.nativeSessionId, `task008_${challengeId.replaceAll('-', '')}`, this.repoRoot, marker])
    const rows = z.object({ nativeSessionId: z.literal(handle.nativeSessionId), messageId: z.string().min(1),
      toolPartId: z.string().min(1) }).strict().parse(JSON.parse(raw))
    return { challengeId, ...rows }
  }

  private async nativeChallengeMarker(handle: ExactRuntimeHandle, challengeId: string): Promise<string> {
    await this.assertCurrentHandle(handle)
    const registered = this.nativeChallenges.get(challengeId)
    if (!registered || registered.soulId !== handle.soulId || registered.nativeSessionId !== handle.nativeSessionId) {
      throw new Error('exact registered native challenge root required')
    }
    return registered.marker
  }

  async nativeToolEvidence(handle: ExactRuntimeHandle, challengeId: string): Promise<NativeToolEvidence> {
    const marker = await this.nativeChallengeMarker(handle, challengeId)
    const raw = await this.ownedProviderExec(handle.containerId, ['node', '--no-warnings', '-e', OPENCODE_TOOL_EVIDENCE_SCRIPT,
      '/home/freshell/provider/.local/share/opencode/opencode.db', handle.nativeSessionId, marker])
    return z.object({ requestIds: z.array(z.string().min(1)), resultIds: z.array(z.string().min(1)),
      replayCount: z.number().int().nonnegative() }).strict().parse(JSON.parse(raw))
  }

  private async nativeEffectMarker(handle: ExactRuntimeHandle, challengeId: string): Promise<string> {
    const marker = await this.nativeChallengeMarker(handle, challengeId)
    if (marker !== NativeChallengeMarkers['chaos-approval'] && marker !== NativeChallengeMarkers['chaos-long-tool']) {
      throw new Error('registered chaos effect challenge required')
    }
    return marker
  }

  async nativeChallengeEffectCount(handle: ExactRuntimeHandle, challengeId: string): Promise<number> {
    const marker = await this.nativeEffectMarker(handle, challengeId)
    const raw = (await this.ownedProviderExec(handle.containerId, ['sh', '-lc',
      `test -f "$HOME/${marker}" && wc -l < "$HOME/${marker}" || printf 0`])).trim()
    const count = /^\d+$/.test(raw) ? Number(raw) : NaN
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid registered chaos effect count')
    return count
  }

  async resetNativeChallengeEffect(handle: ExactRuntimeHandle, challengeId: string): Promise<void> {
    const marker = await this.nativeEffectMarker(handle, challengeId)
    await this.ownedProviderExec(handle.containerId, ['rm', '-f', `/home/freshell/provider/${marker}`])
  }

  async chaosLongToolRunning(handle: ExactRuntimeHandle, challengeId: string): Promise<boolean> {
    const marker = await this.nativeChallengeMarker(handle, challengeId)
    if (marker !== NativeChallengeMarkers['chaos-long-tool']) throw new Error('registered chaos long-tool challenge required')
    return this.ownedContainerProcessTable(handle.containerId).includes('sleep 180')
  }

  async nativeFollowUpMessageIds(handle: ExactRuntimeHandle, challengeId: string): Promise<string[]> {
    const marker = await this.nativeChallengeMarker(handle, challengeId)
    const raw = await this.ownedProviderExec(handle.containerId, ['node', '--no-warnings', '-e', OPENCODE_NATIVE_HISTORY_SCRIPT,
      '/home/freshell/provider/.local/share/opencode/opencode.db', handle.nativeSessionId])
    const history = z.object({ provider: z.literal('opencode'), nativeSessionId: z.literal(handle.nativeSessionId),
      turns: z.array(z.object({ text: z.string(), messageId: z.string().min(1).optional() }).passthrough()) }).passthrough().parse(JSON.parse(raw))
    return history.turns.filter(turn => turn.text.includes(marker)).flatMap(turn => turn.messageId ? [turn.messageId] : [])
  }

  private heldHostKey(handle: ExactRuntimeHandle): string {
    return JSON.stringify([handle.runId, handle.candidateSha, handle.soulId, handle.incarnationId,
      handle.containerId, handle.hostBootId, handle.nativeSessionId])
  }

  async holdRuntimeHost(handle: ExactRuntimeHandle): Promise<{ pid: number }> {
    await this.assertCurrentHandle(handle)
    const key = this.heldHostKey(handle)
    if (this.heldHosts.has(key)) throw new Error('exact owned host is already held')
    const pid = this.signalOwnedSessionHostExact(handle.containerId, handle.incarnationId, 'SIGSTOP')
    this.heldHosts.set(key, { handle: { ...handle }, pid })
    this.runtime.recordLifecycle('external.host_held', { severity: 'info', ...handle, pid })
    return { pid }
  }

  async releaseRuntimeHost(handle: ExactRuntimeHandle): Promise<void> {
    const key = this.heldHostKey(handle), held = this.heldHosts.get(key)
    if (!held) throw new Error('exact recorded held host required')
    this.signalOwnedSessionHostExact(handle.containerId, handle.incarnationId, 'SIGCONT', held.pid)
    this.heldHosts.delete(key)
    this.runtime.recordLifecycle('external.host_released', { severity: 'info', ...handle, pid: held.pid })
  }

  async providerVolumeFacts(handle: ExactRuntimeHandle): Promise<{ providerVolumeName: string }> {
    await this.assertCurrentHandle(handle)
    const receipts = this.runtime.broker.receipts().filter(row => row.soulId === handle.soulId
      && row.incarnationId === handle.incarnationId && row.containerId === handle.containerId)
    if (receipts.length !== 1 || !receipts[0].providerVolumeName) throw new Error('exact current provider volume receipt required')
    return { providerVolumeName: receipts[0].providerVolumeName }
  }

  async fixtureWorkerFacts(handle: ExactRuntimeHandle): Promise<{ provider: string; workerPid: number }> {
    await this.assertCurrentHandle(handle)
    const row = (await this.inventory()).find(view => view.soulId === handle.soulId && view.launchState === 'running')
    if (!row?.freshAgentSessionType || !row.provider || !this.fixtureFreshAgentModes.includes(row.freshAgentSessionType)) {
      throw new Error('registered deterministic fresh-agent fixture required')
    }
    const lines = this.ownedContainerProcessTable(handle.containerId).split('\n').filter(line => (
      line.includes('fresh-agent-fixture-worker') && line.includes(`--provider ${row.provider}`)
    ))
    const workerPid = Number(lines[0]?.trim().match(/^(\d+)/)?.[1])
    if (lines.length !== 1 || !Number.isSafeInteger(workerPid) || workerPid <= 1) throw new Error('exact registered fixture worker is absent or ambiguous')
    return { provider: row.provider, workerPid }
  }

  async crashFixtureWorker(handle: ExactRuntimeHandle): Promise<void> {
    const { workerPid } = await this.fixtureWorkerFacts(handle)
    this.runtime.killOwnedRuntimePidExact(handle.containerId, workerPid)
  }

  async allowFixtureDecision(handle: ExactRuntimeHandle, decisionId: string): Promise<void> {
    await this.assertCurrentHandle(handle)
    const state = await this.fixtureNativeState(handle)
    if (!decisionId || state.pendingDecisionId !== decisionId) throw new Error('exact actually pending fixture decision required')
    await this.runtime.adminOk(this.supervisor, this.runtime.freshAgentResolveBody(
      handle.soulId, decisionId, { behavior: 'allow' }, await this.controlEpoch(),
    ))
  }

  async fixtureNativeState(handle: ExactRuntimeHandle): Promise<FixtureNativeState> {
    const row = (await this.inventory()).find((view) => view.soulId === handle.soulId && view.launchState === 'running')
    if (!row?.freshAgentSessionType || !this.fixtureFreshAgentModes.includes(row.freshAgentSessionType)) {
      throw new Error('registered deterministic fresh-agent fixture required')
    }
    return this.runtime.fixtureNativeState(this.supervisor, handle)
  }

  signalOwnedSessionHostExact(containerId: string, incarnationId: string, signal: 'SIGSTOP' | 'SIGCONT', expectedPid?: number): number {
    const pid = this.runtime.ownedContainerHostPidExact(containerId)
    if (expectedPid !== undefined && pid !== expectedPid) throw new Error('owned session-host PID changed')
    const rows = this.runtime.topOwnedContainerExact(containerId, ['-eo', 'pid,args']).split('\n')
    const row = rows.find((line) => Number(line.trim().split(/\s+/)[0]) === pid)
    if (!row || !/(?:^|\s)\/[^ ]*freshell-session-host\s+serve\s+--control-socket\s/.test(row)
      || !row.includes(`--incarnation-id ${incarnationId}`)) {
      throw new Error('owned container PID is not the requested session host')
    }
    // The session host is namespace PID1. SIGSTOP from inside that namespace
    // is ignored; signal only its receipt-proven PID from the ancestor namespace.
    process.kill(pid, signal)
    return pid
  }

  ownedContainerExec(containerId: string, args: string[]): string {
    return this.runtime.execOwnedContainerExact(containerId, args)
  }

  async ownedProviderExec(containerId: string, args: string[]): Promise<string> {
    return this.ownedDockerProbe(containerId, args, true)
  }

  private async ownedDockerProbe(containerId: string, args: string[], providerUser: boolean): Promise<string> {
    return this.trackedDockerProbe(containerId, ['exec', ...(providerUser ? ['--user', '65534:0'] : []), containerId,
      'env', 'HOME=/home/freshell/provider', ...args])
  }

  private async trackedDockerProbe(containerId: string, args: string[]): Promise<string> {
    if (!this.runtime.broker.receiptIds().has(containerId)
      && !this.runtime.transferOwnedIds().containers.includes(containerId)) throw new Error('exact owned provider probe container required')
    const probeId = randomUUID()
    let resolve!: (output: string) => void
    let reject!: (error: Error) => void
    const settlement = new Promise<string>((yes, no) => { resolve = yes; reject = no })
    const record: { child?: ChildProcess; settlement: Promise<string> } = { settlement }
    // Track before creation: outer cancellation can settle a probe even when
    // its browser reply disappears. Removing the owned runtime removes its
    // container-side exec; this child owns only the Docker transport process.
    this.providerProbes.set(probeId, record)
    try {
      this.runtime.recordLifecycle('external.provider_probe_started', { severity: 'info', probeId, containerId })
      record.child = execFile('docker', args, {
        cwd: this.repoRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        this.providerProbes.delete(probeId)
        try {
          this.runtime.recordLifecycle('external.provider_probe_settled', { severity: error ? 'warn' : 'info',
            probeId, containerId, code: error?.code ?? 0, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr) })
        } catch (evidenceError) {
          reject(new Error('owned provider probe settlement evidence failed', { cause: evidenceError }))
          return
        }
        if (error) reject(new Error('owned provider probe failed or timed out', { cause: error }))
        else resolve(stdout)
      })
    } catch (error) {
      this.providerProbes.delete(probeId)
      reject(error instanceof Error ? error : new Error('owned provider probe did not start'))
    }
    return settlement
  }

  /** Read the actual session-host adoption gate for this exact owned incarnation. */
  async ownedOpenCodeAdoptionStatus(view: ManagedRuntimeView): Promise<ManagedOpenCodeAdoptionStatus> {
    if (!view.containerId || !view.terminalId || !view.hostBootId) {
      throw new Error('managed OpenCode adoption probe requires an exact container, host boot, and terminal')
    }
    const status = JSON.parse(await this.ownedDockerProbe(this.supervisor.containerId, [
      'node', '--no-warnings',
      path.join(this.repoRoot, 'test/e2e-browser/fixtures/managed-opencode-host-status.cjs'),
      this.runtime.runtimeDir(this.supervisor, view.incarnationId),
      view.incarnationId,
      view.hostBootId,
    ], false)) as ManagedOpenCodeAdoptionStatus
    if (status.state === 'observed'
      && (status.data?.observation?.incarnationId !== view.incarnationId
        || status.data.observation.terminalId !== view.terminalId)) {
      throw new Error('managed OpenCode adoption status belongs to another incarnation or terminal')
    }
    return status
  }

  ownedContainerHasPid(containerId: string, pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    const result = this.runtime.execOwnedContainerExact(containerId, [
      'sh',
      '-lc',
      `if test -d /proc/${pid}; then printf alive; fi`,
    ])
    return result.trim() === 'alive'
  }

  ownedContainerProcessTable(containerId: string): string {
    // docker top reports host PIDs, while killOwnedRuntimePidExact signals
    // inside the container's PID namespace. Read both from the same namespace.
    return this.runtime.execOwnedContainerExact(containerId, ['ps', '-eo', 'pid,args'])
  }

  writeBrowserReceipt(value: unknown): string {
    const target = process.env.FRESHELL_RUNTIME_BROWSER_RECEIPT
      || path.join(this.runtime.browserDir, defaultReceiptFileName('FRESHELL_RUNTIME_BROWSER_RECEIPT'))
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    fs.writeFileSync(target, JSON.stringify(value, null, 2), { mode: 0o600 })
    return target
  }

  writeOpencodeReceipt(value: unknown): string {
    const target = process.env.FRESHELL_RUNTIME_OPENCODE_RECEIPT
      || path.join(this.runtime.browserDir, defaultReceiptFileName('FRESHELL_RUNTIME_OPENCODE_RECEIPT'))
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    fs.writeFileSync(target, JSON.stringify(value, null, 2), { mode: 0o600 })
    return target
  }

  writeProviderQualificationReceipt(
    value: unknown,
    defaultFileName = 'opencode-provider-qualification.json',
  ): string[] {
    const targets = new Set([
      process.env.FRESHELL_RUNTIME_PHASE3_PROVIDER_RECEIPT,
      process.env.FRESHELL_RUNTIME_PHASE5_PROVIDER_RECEIPT,
    ].filter((value): value is string => Boolean(value?.trim())))
    if (targets.size === 0) {
      targets.add(path.join(this.runtime.browserDir, defaultFileName))
    }
    const written: string[] = []
    for (const target of targets) {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
      fs.writeFileSync(target, JSON.stringify(value, null, 2), { mode: 0o600 })
      written.push(target)
    }
    return written
  }

  finalizeProviderQualificationReceipt(providers: ProviderQualificationRow[]): {
    receipt: ProviderQualificationReceiptV2
    paths: string[]
  } {
    const receipt = buildProviderQualificationReceipt({
      repoRoot: this.repoRoot,
      evidenceDir: this.runtime.evidenceDir,
      candidateSha: this.runtime.candidateSha,
      receiptRunId: this.runtime.runId,
      runtimeImage: this.runtime.imageRef,
      providers,
    })
    return {
      receipt,
      paths: this.writeProviderQualificationReceipt(
        receipt,
        providers.length > 1
          ? 'managed-provider-qualification.json'
          : `${providers[0]?.provider ?? 'provider'}-provider-qualification.json`,
      ),
    }
  }

  finalizeFreshAgentQualificationReceipt(rows: FreshAgentQualificationRow[]): {
    receipt: FreshAgentQualificationReceiptV1
    paths: string[]
  } {
    const receipt = buildFreshAgentQualificationReceipt({
      repoRoot: this.repoRoot,
      evidenceDir: this.runtime.evidenceDir,
      candidateSha: this.runtime.candidateSha,
      receiptRunId: this.runtime.runId,
      runtimeImage: this.runtime.imageRef,
      selectedModes: rows.map(({ mode }) => mode),
      rows,
    })
    const targets = new Set([
      process.env.FRESHELL_RUNTIME_PHASE3_FRESH_AGENT_RECEIPT,
      process.env.FRESHELL_RUNTIME_PHASE5_FRESH_AGENT_RECEIPT,
    ].filter((value): value is string => Boolean(value?.trim())))
    if (targets.size === 0) {
      targets.add(path.join(this.runtime.browserDir, 'fresh-agent-qualification.json'))
    }
    for (const target of targets) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, JSON.stringify(receipt, null, 2))
    }
    return { receipt, paths: [...targets] }
  }

  async publishPhase3BrowserReceipt(handle: ExactRuntimeHandle, input: Phase3BrowserObservation): Promise<{ artifactRef: string }> {
    if (this.runtime.phase !== 3) throw new Error('Phase 3 browser fixture required')
    await this.assertCurrentHandle(handle)
    const browser = Phase3BrowserObservationSchema.parse(input)
    if (browser.soulId !== handle.soulId || browser.incarnationIdAfter !== handle.incarnationId
      || browser.providerSessionIdBefore !== handle.nativeSessionId || browser.providerSessionIdAfter !== handle.nativeSessionId
      || browser.approvalPromptNativeId !== handle.nativeSessionId) {
      throw new Error('browser observation differs from the exact native address')
    }
    const target = this.writePhase3BrowserReceipt({ schemaVersion: 1, status: 'PASS', candidateSha: this.runtime.candidateSha, browser })
    const sha256 = createHash('sha256').update(fs.readFileSync(target)).digest('hex')
    const artifactRef = `phase3-browser:${sha256}`
    this.runtime.recordLifecycle('external.phase3_browser_receipt', { severity: 'info', artifactRef, artifactPath: target, sha256 })
    return { artifactRef }
  }

  writePhase3BrowserReceipt(value: unknown): string {
    const target = process.env.FRESHELL_RUNTIME_PHASE3_BROWSER_RECEIPT
      || path.join(this.runtime.browserDir, defaultReceiptFileName('FRESHELL_RUNTIME_PHASE3_BROWSER_RECEIPT'))
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    fs.writeFileSync(target, JSON.stringify(value, null, 2), { mode: 0o600 })
    return target
  }

  writePhase4BrowserReceipt(value: unknown): string {
    const target = process.env.FRESHELL_RUNTIME_PHASE4_BROWSER_RECEIPT
      || path.join(this.runtime.browserDir, defaultReceiptFileName('FRESHELL_RUNTIME_PHASE4_BROWSER_RECEIPT'))
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    fs.writeFileSync(target, JSON.stringify(value, null, 2), { mode: 0o600 })
    return target
  }

  writePhase5LossReceipt(value: unknown): string {
    const target = this.canonicalPhase5ReceiptTarget('FRESHELL_RUNTIME_PHASE5_LOSS_RECEIPT')
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    fs.writeFileSync(target, JSON.stringify(value, null, 2), { mode: 0o600 })
    return target
  }

  writePhase5ChaosReceipt(value: unknown): string {
    const target = this.canonicalPhase5ReceiptTarget('FRESHELL_RUNTIME_PHASE5_CHAOS_RECEIPT')
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    fs.writeFileSync(target, JSON.stringify(value, null, 2), { mode: 0o600 })
    return target
  }

  private canonicalPhase5ReceiptTarget(
    envName: 'FRESHELL_RUNTIME_PHASE5_LOSS_RECEIPT' | 'FRESHELL_RUNTIME_PHASE5_CHAOS_RECEIPT',
  ): string {
    const canonical = path.join(this.runtime.browserDir, defaultReceiptFileName(envName))
    const requested = process.env[envName]?.trim()
    if (requested && path.resolve(this.repoRoot, requested) !== canonical) {
      throw new Error(`${envName} must name the canonical candidate/run browser receipt path`)
    }
    return canonical
  }

  private buildManagedServer(): string {
    const mise = path.join(os.homedir(), '.local', 'bin', 'mise')
    const qualification = this.pendingQualificationProviders()
    execFileSync(mise, [
      'exec', 'rust@1.96', '--', 'cargo', 'build', '--release', '-p', 'freshell-server',
      '--features', this.fixtureFreshAgentModes.length > 0
        ? 'managed-fresh-agent-fixtures'
        : qualification.length ? 'managed-provider-qualification' : 'managed-runtime-v1',
    ], { cwd: this.repoRoot, stdio: 'inherit' })
    const source = path.join(this.repoRoot, 'target', 'release', 'freshell-server')
    const target = path.join(this.runtime.buildDir, 'freshell-server-managed')
    fs.copyFileSync(source, target)
    fs.chmodSync(target, 0o755)
    return target
  }

  private buildQualificationSupervisor(): string | undefined {
    if (this.pendingQualificationProviders().length === 0) return undefined
    const mise = path.join(os.homedir(), '.local', 'bin', 'mise')
    execFileSync(mise, [
      'exec', 'rust@1.96', '--', 'cargo', 'build', '--release', '-p', 'freshell-supervisor',
      '--features', 'provider-qualification',
    ], { cwd: this.repoRoot, stdio: 'inherit' })
    const target = path.join(this.runtime.buildDir, 'freshell-supervisor-qualification')
    fs.copyFileSync(path.join(this.repoRoot, 'target', 'release', 'freshell-supervisor'), target)
    fs.chmodSync(target, 0o755)
    return target
  }

  private pendingQualificationProviders(): QualifiableTerminalProvider[] {
    return this.enabledProviders.filter(
      (provider): provider is QualifiableTerminalProvider => (
        provider === 'claude' || provider === 'codex' || provider === 'amplifier'
      ),
    )
  }

  private qualificationEnvironment(): Record<string, string> {
    const selected = this.pendingQualificationProviders()
    if (selected.length === 0) return {}
    return {
      FRESHELL_MANAGED_PROVIDER_QUALIFICATION: selected.join(','),
    }
  }

  private async withManagedBin<T>(operation: () => Promise<T>): Promise<T> {
    const previous = process.env.FRESHELL_E2E_RUST_SERVER_BIN
    process.env.FRESHELL_E2E_RUST_SERVER_BIN = this.serverBin
    try {
      return await operation()
    } finally {
      if (previous === undefined) delete process.env.FRESHELL_E2E_RUST_SERVER_BIN
      else process.env.FRESHELL_E2E_RUST_SERVER_BIN = previous
    }
  }

  private dataOf(result: any, expectedKind: string): any {
    if (!result || result.kind !== expectedKind) {
      throw new Error(`expected ${expectedKind} supervisor result, got ${JSON.stringify(result)}`)
    }
    return result.data
  }
}
