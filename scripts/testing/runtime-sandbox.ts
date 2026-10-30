import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile, execFileSync, spawnSync, spawn, type ChildProcess } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { ManagedRuntimeInventorySnapshotSchema, ManagedRuntimeMigrationPlanSchema, ManagedRuntimeSoulSchema,
  ManagedRuntimeRepairBatchScopeSchema,
  ManagedRuntimeNativeIdentityObservationSchema,
  type ManagedRuntimeInventorySnapshot } from '../../shared/managed-runtime.js'

import { preparedRuntimeBinary } from './runtime-build-preflight.js'
import { parseHelperCreateDelay } from './runtime-test-broker.js'

import fsp from 'node:fs/promises'
import { defaultReceiptFileName } from './runtime-receipts.js'
import { captureRuntimeCandidate } from './runtime-gate-integrity.js'
import { buildProviderQualificationReceipt, type ProviderQualificationReceiptV2, type ProviderQualificationRow } from './provider-qualification-receipt.js'
import { buildFreshAgentQualificationReceipt, deriveFreshBrowserExecution, matchesFreshBrowserFrame, matchesFreshBrowserSendAccepted, sameFreshBrowserActivation, validateFreshBrowserAlias, validateFreshApprovalCheckpoint, validateFreshApprovalDispatch, validateFreshApprovalRecovery, nativeCompletedTurnProofs, type FreshBrowserIngressObservation, type FreshAgentQualificationReceiptV1, type FreshAgentQualificationRow } from './fresh-agent-qualification-receipt.js'
import { claudeNativeInspection, nativeCheckpointTranscriptRetained, observeNativeSoloBashOutcome, openCodeFreeAccessScript } from './runtime-native-feasibility.js'
import type { QualifiableTerminalProvider } from './provider-qualification-selection.js'
import { deferredProviders, loadCapabilityManifest } from './provider-certification.js'
import { deriveNativeRecoveryOriginals, nativeRecoveryValidationDiagnostic, NATIVE_RECOVERY_ORIGINALS_FILE, type NativeOriginalReference, type NativeRecoveryStage } from './qualification-observations.js'
import { hasSuccessfulNativeAnswer, type NativeHistory } from './provider-native-history.js'
import { runtimeCargoBuildAndCopy, runtimeCargoTargetDirectory } from './runtime-cargo-artifacts.js'

import { configuredProviderOnecliGrantFiles } from './runtime-amplifier-onecli.js'
import { RestrictedDockerBroker, type BrokerEvent, type BrokerReceipt, type BrokerSettlementFailure } from './runtime-test-broker.js'
import {
  captureInitialProviderVolumes, cleanupInitialProviderVolumes, findInitialProviderVolume,
  type InitialProviderRegistrySource,
} from './initial-provider-volume.js'

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

export type SyntheticSourceFamily = Omit<SyntheticSource, 'databasePath' | 'unrelatedId'>
export type SyntheticSevenRootSource = SyntheticSource & {
  families: readonly [SyntheticSourceFamily, SyntheticSourceFamily, SyntheticSourceFamily,
    SyntheticSourceFamily, SyntheticSourceFamily, SyntheticSourceFamily, SyntheticSourceFamily]
}

type SyntheticSourceInput = {
  repoRoot: string
  databasePath: string
  workspace: string
  nonce: string
  messageCount?: number
  batch?: 'stopped-repair-seven-roots'
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

export function seedManagedOpenCodeSource(input: SyntheticSourceInput & { batch: 'stopped-repair-seven-roots' }): SyntheticSevenRootSource
export function seedManagedOpenCodeSource(input: SyntheticSourceInput): SyntheticSource
export function seedManagedOpenCodeSource(input: SyntheticSourceInput): SyntheticSource | SyntheticSevenRootSource {
  const { repoRoot, databasePath, workspace, nonce } = input
  const messageCount = input.messageCount ?? 106
  if (!Number.isInteger(messageCount) || messageCount < 2 || messageCount % 2 !== 0) {
    throw new Error('synthetic OpenCode message count must be an even integer of at least two')
  }
  if (input.batch !== undefined && input.batch !== 'stopped-repair-seven-roots') {
    throw new Error('unknown synthetic OpenCode batch')
  }
  const nativeIdNonce = sha256(nonce).slice(0, 16)
  const nativeId = (prefix: string, index: number): string =>
    `${prefix}_${nativeIdNonce}${String(index).padStart(10, '0')}`
  const unrelatedId = nativeId('ses', 3)
  // Project IDs are not prefixed IDs: v1.18.21 derives them from a remote URL
  // with Hash.fast(`git-remote:${normalizedRemote}`).
  const projectId = sha1('git-remote:fixture.invalid/freshell/managed-opencode')
  const now = Date.now() - 600_000

  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(databasePath)
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
    db.exec(fs.readFileSync(path.join(repoRoot, 'crates/freshell-sessions/src/opencode_schema_v1_18_21.sql'), 'utf8'))
    db.exec('CREATE TABLE message_seq (session_id TEXT PRIMARY KEY, next INTEGER NOT NULL); CREATE TABLE provider_config (id TEXT PRIMARY KEY, value TEXT);')
    // Publish one complete fictional graph; close rolls back any failed seed.
    // A single commit also avoids a synchronous WAL fsync for every fixture row.
    db.exec('BEGIN IMMEDIATE')
    const insertMigration = db.prepare('INSERT INTO migration (id, time_completed) VALUES (?, ?)')
    MIGRATIONS.forEach((migration, index) => insertMigration.run(migration, index + 100))
    db.prepare("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes, vcs) VALUES (?, ?, ?, ?, ?, 'git')")
      .run(projectId, workspace, now, now, '[]')
    db.prepare('INSERT INTO project_directory (project_id, directory, time_created) VALUES (?, ?, ?)')
      .run(projectId, workspace, now)
    db.prepare('INSERT INTO permission (id, project_id, action, resource, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)')
      .run(nativeId('per', 0), projectId, 'read', '*', now, now)

    const insertSession = db.prepare(`INSERT INTO session
      (id, project_id, workspace_id, parent_id, slug, directory, title, version,
       time_created, time_updated, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, '1.18.21', ?, ?, ?)`)
    insertSession.run(unrelatedId, projectId, null, null, unrelatedId, workspace, 'UNRELATED_SESSION_SENTINEL', now + 3, now + 3, JSON.stringify({ opaque: 'OPAQUE_ROW_SENTINEL' }))
    const insertMessage = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
    const insertPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
    const unrelatedMessageId = nativeId('msg', messageCount + 2)
    insertMessage.run(unrelatedMessageId, unrelatedId, now + 500, now + 500, JSON.stringify({
      role: 'user', agent: 'build', model: { providerID: 'openai', modelID: 'gpt-5.6-luna' }, time: { created: now + 500 },
    }))
    insertPart.run(nativeId('prt', (messageCount + 2) * 3 + 1), unrelatedMessageId, unrelatedId, now + 500, now + 500, JSON.stringify({ type: 'text', text: 'UNRELATED_MESSAGE_SENTINEL' }))

    const insertFamily = (familyIndex: number): SyntheticSourceFamily => {
      const familyNonce = familyIndex === 0 ? nonce : `${nonce}:family:${familyIndex}`
      const familyIdNonce = sha256(familyNonce).slice(0, 16)
      const nativeId = (prefix: string, index: number): string => `${prefix}_${familyIdNonce}${String(index).padStart(10, '0')}`
      const rootId = nativeId('ses', 0)
      const childId = nativeId('ses', 1)
      const grandchildId = nativeId('ses', 2)
      const selectedSentinel = `SELECTED_HISTORY_${familyNonce}`
      const baselineMessages = new Map<string, string>()
      const baselineParts = new Map<string, string>()
      for (const [id, parent, title, offset] of [
        [rootId, null, `Synthetic managed OpenCode ${familyNonce}`, 0],
        [childId, rootId, `Synthetic child ${familyNonce}`, 1],
        [grandchildId, childId, `Synthetic grandchild ${familyNonce}`, 2],
      ] as const) {
        // These are ordinary local sessions. OpenCode 1.18.21 rejects prompts
        // attached to a workspace adapter that is not enabled in the TUI.
        insertSession.run(id, projectId, null, parent, id, workspace, title, now + offset, now + offset, JSON.stringify({ opaque: 'OPAQUE_ROW_SENTINEL' }))
      }

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
        baselineMessages.set(messageId, sha256(data))
        baselineParts.set(partId, sha256(part))
      }
      db.prepare('INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES (?, 1, ?)').run(rootId, `owner_${familyNonce}`)
      const rootInfo = {
        id: rootId,
        slug: rootId,
        projectID: projectId,
        directory: workspace,
        title: `Synthetic managed OpenCode ${familyNonce}`,
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
      return { rootId, childId, grandchildId, baselineMessages, baselineParts, lastMessageId, selectedSentinel }
    }
    const first = insertFamily(0)
    const families = input.batch === undefined ? undefined : [first, insertFamily(1), insertFamily(2), insertFamily(3), insertFamily(4), insertFamily(5), insertFamily(6)] as const
    db.prepare('INSERT INTO account (id, email, url, access_token, refresh_token, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(`account_${nonce}`, 'synthetic@example.invalid', 'https://example.invalid', 'ACCOUNT_TOKEN_SENTINEL', 'ACCOUNT_REFRESH_SENTINEL', now, now)
    db.prepare('INSERT INTO control_account (email, url, access_token, refresh_token, active, time_created, time_updated) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run('synthetic@example.invalid', 'https://example.invalid', 'CONTROL_ACCOUNT_SENTINEL', 'CONTROL_REFRESH_SENTINEL', now, now)
    db.prepare('INSERT INTO credential (id, label, value, time_created, time_updated) VALUES (?, ?, ?, ?, ?)')
      .run(nativeId('cred', 0), 'synthetic', 'CREDENTIAL_VALUE_SENTINEL', now, now)
    db.prepare('INSERT INTO provider_config (id, value) VALUES (?, ?)').run(`provider_${nonce}`, 'PROVIDER_CONFIG_SENTINEL')
    db.exec('COMMIT')
    const source = { databasePath, unrelatedId, ...first }
    return families ? { ...source, families } : source
  } finally {
    db.close()
  }
}

// Kept after the immutable Task7 seeder prefix; canonical production schemas only.
import { FreshAgentCreateSchema } from '../../shared/ws-protocol.js'
import { SessionRefSchema } from '../../shared/session-contract.js'

export const PHASE1_RUNTIME_IMAGE_TAG = 'ubuntu:24.04'
export const PHASE2_RUNTIME_IMAGE_TAG = 'freshell-managed-runtime:phase2'
export const CONTROL_PROTOCOL_VERSION = 2

type RunOwnedRuntimeImage = { tag: string; runId: string; candidateSha: string; digest?: string }

// Docker inherits image labels into containers. Keep image provenance outside
// the com.freshell.* namespace used to validate exact container ownership.
const RUNTIME_IMAGE_LABELS = {
  runId: 'org.freshell.runtime-test-run-id',
  candidate: 'org.freshell.runtime-test-candidate',
  sourceState: 'org.freshell.runtime-test-source-state',
} as const

export function assertRunOwnedRuntimeImage(observed: unknown, context: RunOwnedRuntimeImage): void {
  const parsed = z.array(z.object({ Id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    RepoTags: z.array(z.string()), Config: z.object({ Labels: z.record(z.string(), z.string()) }) })).length(1).safeParse(observed)
  const image = parsed.success ? parsed.data[0] : undefined
  if (!image || (context.digest && image.Id !== context.digest) || !image.RepoTags.includes(context.tag)
    || image.Config.Labels[RUNTIME_IMAGE_LABELS.runId] !== context.runId
    || image.Config.Labels[RUNTIME_IMAGE_LABELS.candidate] !== context.candidateSha) {
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
  const source = captureRuntimeCandidate(repoRoot)
  execute('docker', ['build', '--pull=false', '--provenance=false', '--sbom=false',
    '--label', `${RUNTIME_IMAGE_LABELS.runId}=${runId}`, '--label', `${RUNTIME_IMAGE_LABELS.candidate}=${candidateSha}`,
    '--label', `${RUNTIME_IMAGE_LABELS.sourceState}=${source.sha}:${source.dirty ? 'dirty' : 'clean'}`,
    '-f', 'docker/runtime/Dockerfile', '-t', tag, '.'], { cwd: repoRoot, stdio: 'inherit' })
  const digest = String(execute('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'], { encoding: 'utf8' })).trim()
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('run-owned runtime image has no pinned digest')
  const addressed = String(execute('docker', ['image', 'inspect', digest, '--format', '{{.Id}}'], { encoding: 'utf8' })).trim()
  if (addressed !== digest) throw new Error('run-owned runtime image digest is not locally addressable')
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

// The batch reader adds only the selected closure's parent edges. Existing
// history and exclusion readers retain their implementations and semantics.
export const TASK007_BATCH_STORE_PROBE = `
const { DatabaseSync } = require('node:sqlite');
const { execFileSync } = require('node:child_process');
const database = process.argv[1], root = process.argv[2];
const history = () => JSON.parse(execFileSync(process.execPath, ['--no-warnings', '-e', ${JSON.stringify(PROVIDER_HISTORY_DIGESTS)}, database, root], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 }));
const parents = () => {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON; BEGIN;');
    const rows = db.prepare('WITH RECURSIVE ids(id) AS (SELECT id FROM session WHERE id = ? UNION SELECT child.id FROM session child JOIN ids ON child.parent_id = ids.id) SELECT session.id, session.parent_id FROM session JOIN ids ON session.id = ids.id ORDER BY session.id LIMIT 1025').all(root);
    if (rows.length > 1024 || rows.filter(row => row.id === root && row.parent_id === null).length !== 1) throw new Error('registered batch root is absent, non-root or oversized');
    return Object.fromEntries(rows.map(row => [row.id, row.parent_id]));
  } finally { db.close(); }
};
let readable;
if (process.argv[3]) {
  const frame = require('node:fs').readFileSync(process.argv[3]);
  if (frame.length < 5 || frame.length > 512 * 1024 + 16 * 1024 + 4 || frame.readUInt32BE(0) !== frame.length - 4) throw new Error('invalid original descriptor frame');
  const descriptor = JSON.parse(frame.subarray(4).toString('utf8'));
  if (descriptor.rootSessionId !== root) throw new Error('original descriptor root differs from selected graph');
  readable = JSON.parse(execFileSync('/runtime/freshell-session-host', ['opencode-reader-probe', '--workspace-root', process.argv[4], '--expected-cwd', process.cwd(), '--provider-uid', '65534', '--provider-gid', '0'], { input: frame, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 }));
}
const before = parents(), digests = history();
const exclusions = JSON.parse(execFileSync(process.execPath, ['--no-warnings', '-e', ${JSON.stringify(PROVIDER_SENTINEL_SCAN)}, database, ${JSON.stringify(JSON.stringify(EXCLUDED_SOURCE_SENTINELS))}], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 }));
if (JSON.stringify(before) !== JSON.stringify(parents()) || JSON.stringify(digests) !== JSON.stringify(history()) || JSON.stringify(Object.keys(before).sort()) !== JSON.stringify([...digests.sessions].sort())) throw new Error('installed graph changed during batch read');
process.stdout.write(JSON.stringify({ parents: before, history: digests, excludedSourceSentinels: exclusions, ...(readable ? { readable } : {}) }));
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

// Inspect the current native process, rather than running the global terminal CLI.
// The environment is used inside the owned probe; only these selected facts leave it.
export const FRESH_AGENT_PROCESS_SCRIPT = String.raw`
import pathlib,os,sys,json,hashlib,subprocess,base64
PROC=pathlib.Path('/proc')
provider,incarnation=sys.argv[1:]
assert provider in ['claude','codex','opencode']
def sha(file):
 h=hashlib.sha256()
 with file.open('rb') as source:
  for chunk in iter(lambda:source.read(1024*1024),b''):h.update(chunk)
 return h.hexdigest()
def read(p):
 stat=(p/'stat').read_text();fields=stat[stat.rfind(')')+2:].split()
 argv=[v.decode() for v in (p/'cmdline').read_bytes().split(b'\0') if v]
 env=dict(v.decode().split('=',1) for v in (p/'environ').read_bytes().split(b'\0') if b'=' in v)
 return dict(pid=int(p.name),parentPid=int(fields[1]),startTicks=fields[19],uid=p.stat().st_uid,argv=argv,env=env,exe=(p/'exe').resolve(),cwd=str((p/'cwd').resolve()))
processes=[]
for p in PROC.iterdir():
 if not p.name.isdigit():continue
 try:processes.append(read(p))
 except (OSError,ValueError):continue
sidecar=None;sdk=None
if provider=='claude':
 sidecars=[p for p in processes if p['env'].get('FRESHELL_CLAUDE_SIDECAR_ID') and any(pathlib.Path(a).name=='index.mjs' for a in p['argv'][1:])]
 assert len(sidecars)==1,'unique owned SDK sidecar required'
 sidecar=sidecars[0];entry=pathlib.Path(next(a for a in sidecar['argv'][1:] if pathlib.Path(a).name=='index.mjs'))
 assert entry.is_absolute() and entry.is_file() and sidecar['uid']==65534
 selected=sidecar['env'].get('FRESHELL_CLAUDE_SDK_QUERY_MODULE') or '@anthropic-ai/claude-agent-sdk'
 resolver="import{pathToFileURL,fileURLToPath}from'node:url';process.stdout.write(fileURLToPath(import.meta.resolve(process.argv[2],pathToFileURL(process.argv[1]).href)));"
 module=pathlib.Path(subprocess.check_output([str(sidecar['exe']),'--experimental-import-meta-resolve','--input-type=module','-e',resolver,str(entry),selected],text=True,timeout=15)).resolve()
 package=module.parent
 while not (package/'package.json').is_file():
  assert package.parent!=package;package=package.parent
 metadata=json.loads((package/'package.json').read_text());assert metadata['name']=='@anthropic-ai/claude-agent-sdk'
 def raw(file):
  value=file.read_bytes();assert len(value)<=2*1024*1024;return base64.b64encode(value).decode()
 sdk=dict(packageBytesBase64=raw(package/'package.json'),moduleBytesBase64=raw(module),entryBytesBase64=raw(entry),version=metadata['version'],declaredNativeVersion=metadata.get('claudeCodeVersion'),modulePath=str(module),moduleSha256=sha(module),entryPath=str(entry),entrySha256=sha(entry),selection='sidecar-selected-module-resolution')
 def descendant(p):
  seen=set()
  while p['parentPid'] not in seen:
   if p['parentPid']==sidecar['pid']:return True
   seen.add(p['parentPid']);parents=[v for v in processes if v['pid']==p['parentPid']]
   if len(parents)!=1:return False
   p=parents[0]
  return False
 matches=[p for p in processes if p['pid']!=sidecar['pid'] and p['exe'].name in ['claude','claude.exe'] and p['env'].get('FRESHELL_CLAUDE_SIDECAR_ID')==sidecar['env']['FRESHELL_CLAUDE_SIDECAR_ID'] and descendant(p)]
else:
 matches=[p for p in processes if (provider=='codex' and p['exe'].name in ['codex','codex.exe'] and 'app-server' in p['argv']) or (provider=='opencode' and p['exe'].name in ['opencode','opencode.exe'] and 'serve' in p['argv'] and p['env'].get('FRESHELL_OPENCODE_SIDECAR_ID'))]
assert len(matches)==1,'actual provider child PID is missing or ambiguous'
p=matches[0];assert p['uid']==65534
launch=json.loads(p['env']['FRESHELL_NATIVE_IDENTITY_LAUNCH']);assert launch['incarnationId']==incarnation
if sidecar and sidecar['env'].get('CLAUDE_CMD'):
 assert pathlib.Path(sidecar['env']['CLAUDE_CMD']).resolve()==p['exe'],'selected native override differs'
def flag(name):
 values=[p['argv'][i+1] for i,v in enumerate(p['argv'][:-1]) if v==name]
 values.extend(v[len(name)+1:] for v in p['argv'] if v.startswith(name+'='))
 assert len(values)<=1
 return values[0] if values else None
profiles=[];home=pathlib.Path(p['env']['HOME']);cwd=pathlib.Path(p['cwd'])
files=[home/'.claude/settings.json',cwd/'.claude/settings.json',cwd/'.claude/settings.local.json'] if provider=='claude' else [home/'.codex/config.toml'] if provider=='codex' else [home/'.config/opencode/opencode.json',home/'.config/opencode/opencode.jsonc']
for file in files:profiles.append(dict(path=str(file),sha256=sha(file) if file.is_file() else None))
native=dict(pid=p['pid'],parentPid=p['parentPid'],startTicks=p['startTicks'],uid=p['uid'],executable=str(p['exe']),executableSha256=sha(p['exe']),cwd=p['cwd'],launch=launch,configuredModel=flag('--model'),configuredEffort=flag('--effort'),profileSha256=hashlib.sha256(json.dumps(profiles,sort_keys=True).encode()).hexdigest())
version=subprocess.check_output([str(p['exe']),'--version'],env=p['env'],text=True,timeout=15).strip()
current=read(PROC/str(p['pid']));assert current['startTicks']==p['startTicks'] and current['exe']==p['exe'] and current['argv']==p['argv'] and current['cwd']==p['cwd']
if sidecar:
 current=read(PROC/str(sidecar['pid']));assert current['startTicks']==sidecar['startTicks'] and current['argv']==sidecar['argv']
print(json.dumps(dict(provider=provider,version=version,native=native,sdk=sdk,sidecar=None if not sidecar else dict(pid=sidecar['pid'],startTicks=sidecar['startTicks'],uid=sidecar['uid']))))
`

export const FreshNativeCollectionResultSchema = z.object({ collectionId: z.string().uuid(),
  completedStages: z.number().int().min(0).max(3), closed: z.boolean(),
  providerStoreId: z.string().min(1).optional(),
  completedNativeTurns: z.array(z.object({ turnId: z.string().min(1), assistantMessageId: z.string().min(1),
    completionKind: z.literal('provider_native_completed') }).strict()).length(3).optional(),
}).strict().refine(value => (value.providerStoreId === undefined && value.completedNativeTurns === undefined)
  || (value.closed && value.completedStages === 3 && value.providerStoreId !== undefined && value.completedNativeTurns !== undefined),
'native IDs require the successful closed three-stage collection')
export type FreshNativeCollectionResult = z.infer<typeof FreshNativeCollectionResultSchema>
export const FreshBrowserChallengeResultSchema = z.object({ challengeId: z.string().uuid(), prompt: z.string().optional(),
  decisionId: z.string().optional(), toolUseID: z.string().optional(), nativeRequestId: z.string().optional() }).strict()
export type FreshBrowserChallengeResult = z.infer<typeof FreshBrowserChallengeResultSchema>
export const FreshBrowserIngressObservationSchema = z.object({ ingress: z.enum(['browser-picker', 'browser-split', 'history-resume', 'ws-create', 'ws-attach',
  'rest-tab', 'rest-split', 'mcp-new-tab', 'mcp-split', 'startup-restore', 'auto-resume']), request: z.record(z.string(), z.any()), reply: z.record(z.string(), z.any()).optional() }).strict()
  .refine(value => Buffer.byteLength(JSON.stringify(value)) <= 32768, 'bounded browser route observation required')
type FreshNativeCollection = {
  collectionId: string; mode: string; provider: string; soulId: string; providerStoreId: string; nativeSessionId: string
  nonce: string; stages: Record<string, unknown>[]; lastHandle: ExactRuntimeHandle; closed: boolean; failed: boolean
  crash?: Record<string, unknown>
  stopped?: NativeOriginalReference
  completedNativeTurns?: FreshAgentQualificationRow['completedNativeTurns']
}
const NativeDigest = z.string().regex(/^[a-f0-9]{64}$/)
const FreshNativeProcessSchema = z.object({ provider: z.enum(['claude', 'codex', 'opencode']), version: z.string(),
  native: z.object({ pid: z.number().int().min(2), parentPid: z.number().int().positive(), startTicks: z.string().regex(/^\d+$/),
    uid: z.literal(65534), executable: z.string().refine(path.isAbsolute), executableSha256: NativeDigest,
    cwd: z.string().refine(path.isAbsolute), profileSha256: NativeDigest,
    configuredModel: z.string().nullable().optional(), configuredEffort: z.string().nullable().optional(),
    launch: z.object({ incarnationId: z.string().min(1) }).passthrough(),
  }).strict(), sdk: z.object({ version: z.string(), declaredNativeVersion: z.string(),
    modulePath: z.string().optional(), entryPath: z.string().optional(), moduleSha256: NativeDigest, entrySha256: NativeDigest,
    selection: z.literal('sidecar-selected-module-resolution'), packageBytesBase64: z.string().optional(),
    moduleBytesBase64: z.string().optional(), entryBytesBase64: z.string().optional(),
  }).strict().nullable(), sidecar: z.object({ pid: z.number().int().positive(), startTicks: z.string(), uid: z.literal(65534) }).strict().nullable().optional(),
}).strict()
const RawNativeSnapshotSchema = z.object({ path: z.string().refine(path.isAbsolute), identity: z.array(z.string()).min(2),
  completeEof: z.literal(true), sha256: NativeDigest, bytesBase64: z.string(), querySnapshotBase64: z.string().optional(), querySnapshotSha256: NativeDigest.optional() }).strict()
type FreshCapturedNativeHistory = NativeHistory & { rawSource: { snapshot: z.infer<typeof RawNativeSnapshotSchema> } | null }

const FRESH_ACCEPTED_PROFILE_SCRIPT = String.raw`
import sqlite3,sys,json
db=sqlite3.connect('file:/var/lib/freshell-supervisor/runtime.sqlite3?mode=ro',uri=True)
db.row_factory=sqlite3.Row;db.execute('PRAGMA query_only=ON');db.execute('PRAGMA trusted_schema=OFF');db.execute('BEGIN')
rows=db.execute('SELECT i.soul_id AS soulId,i.incarnation_id AS incarnationId,i.container_id AS containerId,i.host_boot_id AS hostBootId,i.launch_nonce AS launchNonce,i.execution_generation AS executionGeneration,s.provider_store_id AS providerStoreId,s.native_session_id AS nativeSessionId,i.fresh_agent_spec AS spec FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id WHERE i.soul_id=? AND i.incarnation_id=? AND i.launch_state=\'running\'',sys.argv[1:]).fetchall()
assert len(rows)==1;value=dict(rows[0]);spec=json.loads(value['spec'])
value['spec']={key:spec.get(key,[] if key=='providerSecretReferences' else None) for key in ['sessionType','provider','runtimeVariant','providerStoreId','nativeSessionId','cwd','model','effort','runAsUid','runAsGid','providerSecretReferences']}
value['source']='registry-current-incarnation';print(json.dumps(value));db.close()
`


export const FRESH_NATIVE_NAMESPACE_SCRIPT = String.raw`
import pathlib,os,sys,json,ssl,urllib.request,urllib.parse
${openCodeFreeAccessScript()}
provider,pid,root=sys.argv[1:4];mode=sys.argv[4] if len(sys.argv)>4 else None;p=pathlib.Path('/proc')/pid
env=dict(v.decode().split('=',1) for v in (p/'environ').read_bytes().split(b'\0') if b'=' in v)
argv=[v.decode() for v in (p/'cmdline').read_bytes().split(b'\0') if v]
native_root=None
if provider=='claude':
 hook=json.loads((pathlib.Path(env['FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR'])/'session-start.json').read_text())
 native_root=hook['native']['session_id'];assert native_root==root
elif provider=='opencode':
 assert argv.count('--port')==1 and argv.count('--hostname')==1 and argv[argv.index('--hostname')+1]=='127.0.0.1'
 port=int(argv[argv.index('--port')+1]);assert 0<port<65536
 local=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 with local.open('http://127.0.0.1:'+str(port)+'/session/'+urllib.parse.quote(root,safe='')+'?directory='+urllib.parse.quote(str((p/'cwd').resolve()),safe=''),timeout=10) as response:
  assert response.status==200;raw=response.read(1024*1024+1);assert len(raw)<=1024*1024
  info=json.loads(raw);native_root=info['id'];assert native_root==root and info.get('parentID') is None
free_access=None
if mode=='freshopencode':
 assert provider=='opencode'
 context,free_access=probe_free_opencode_access(local,port,str((p/'cwd').resolve()),env);status=None
else:
 ca=env.get('SSL_CERT_FILE') or env['NODE_EXTRA_CA_CERTS'];context=ssl.create_default_context(cafile=ca)
 proxy=env.get('HTTPS_PROXY') or env.get('https_proxy');opener=urllib.request.build_opener(urllib.request.ProxyHandler({'https':proxy}),urllib.request.HTTPSHandler(context=context))
 url='https://api.anthropic.com/v1/models' if provider=='claude' else 'https://api.openai.com/v1/models' if provider=='opencode' else 'https://chatgpt.com/backend-api/codex/models?client_version=0.147.0'
 headers={'anthropic-version':'2023-06-01','authorization':'Bearer '+env['CLAUDE_CODE_OAUTH_TOKEN']} if provider=='claude' and env.get('CLAUDE_CODE_OAUTH_TOKEN') else {'anthropic-version':'2023-06-01','x-api-key':env['ANTHROPIC_API_KEY']} if provider=='claude' else {'Authorization':'Bearer onecli-managed'}
 with opener.open(urllib.request.Request(url,headers=headers),timeout=20) as response:
  status=response.status;assert status==200;response.read(1024*1024)
print(json.dumps(dict(uid=os.getuid(),gid=os.getgid(),caps=next(row.split()[1] for row in pathlib.Path('/proc/self/status').read_text().splitlines() if row.startswith('CapEff:')),readOnlyRoot=bool(os.statvfs('/').f_flag&os.ST_RDONLY),nativePid=int(pid),nativeRoot=native_root,nativeCwd=str((p/'cwd').resolve()),nativeLaunch=json.loads(env['FRESHELL_NATIVE_IDENTITY_LAUNCH']),tlsVerifyMode=context.verify_mode.value,tlsCheckHostname=context.check_hostname,httpsStatus=status,freeModelAccess=free_access)))
`

const FRESH_NATIVE_EXIT_SCRIPT = String.raw`
import pathlib,sys,json
p=pathlib.Path('/proc')/sys.argv[1];exited=False
try:
 stat=(p/'stat').read_text();fields=stat[stat.rfind(')')+2:].split()
 exited=fields[19]!=sys.argv[2] or fields[0]=='Z'
except FileNotFoundError:exited=True
print(json.dumps(dict(exited=exited)))
`
export const RuntimeWebProcessFactsSchema = z.object({ pid: z.number().int().positive(),
  bootAttemptCount: z.number().int().positive() }).strict()
export type RuntimeWebProcessFacts = z.infer<typeof RuntimeWebProcessFactsSchema>
export const RuntimeSupervisorProcessFactsSchema = z.object({ containerId: z.string().regex(/^[a-f0-9]{64}$/),
  pid: z.number().int().min(2) }).strict()
export type RuntimeSupervisorProcessFacts = z.infer<typeof RuntimeSupervisorProcessFactsSchema>
export const RuntimeCandidateIntegritySchema = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/), dirty: z.boolean(),
  diffHash: z.string().regex(/^[a-f0-9]{64}$/), statusHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export type RuntimeCandidateIntegrity = z.infer<typeof RuntimeCandidateIntegritySchema>
const RuntimeChaosLogSchema = z.object({ source: z.enum(['server', 'browser']), sequence: z.number().int().positive(),
  monotonicMs: z.number().nonnegative(), level: z.string(), event: z.string(),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/), contentBytes: z.number().int().nonnegative(), redacted: z.literal(true) }).strict()
export type RuntimeChaosLog = z.infer<typeof RuntimeChaosLogSchema>
export const RuntimeChaosLogsSchema = z.object({
  server: z.array(RuntimeChaosLogSchema.extend({ source: z.literal('server') })).min(1),
  browser: z.array(RuntimeChaosLogSchema.extend({ source: z.literal('browser') })).min(1),
}).strict()
export type RuntimeChaosLogs = z.infer<typeof RuntimeChaosLogsSchema>
export const RuntimeChaosLogArtifactsSchema = z.object({
  serverArtifactRef: z.string().regex(/^phase5-chaos-server-log:[a-f0-9]{64}$/),
  browserArtifactRef: z.string().regex(/^phase5-chaos-browser-log:[a-f0-9]{64}$/),
}).strict()
export type RuntimeChaosLogArtifacts = z.infer<typeof RuntimeChaosLogArtifactsSchema>
export const RuntimeChaosEvidenceSchema = z.object({
  providerEvents: z.object({ schemaVersion: z.literal(1), provider: z.literal('opencode'), nativeSessionId: z.string().min(1) }).passthrough(),
  assertions: z.object({ schemaVersion: z.literal(1), caseId: z.literal('P5-G09'), identity: z.object({
    soulId: z.string().min(1), incarnationId: z.string().min(1), containerId: z.string().regex(/^[a-f0-9]{64}$/),
    hostBootId: z.string().min(1), nativeSessionId: z.string().min(1),
  }).passthrough() }).passthrough(),
}).strict()
export type RuntimeChaosEvidence = z.infer<typeof RuntimeChaosEvidenceSchema>
export const RuntimeChaosEvidenceArtifactsSchema = z.object({
  providerEventsArtifactRef: z.string().regex(/^phase5-chaos-provider-events:[a-f0-9]{64}$/),
  assertionsArtifactRef: z.string().regex(/^phase5-chaos-assertions:[a-f0-9]{64}$/),
}).strict()
export type RuntimeChaosEvidenceArtifacts = z.infer<typeof RuntimeChaosEvidenceArtifactsSchema>
export const RuntimeChaosReceiptArtifactSchema = z.object({ artifactRef: z.string().regex(/^phase5-chaos:[a-f0-9]{64}$/) }).strict()
export type RuntimeChaosReceiptArtifact = z.infer<typeof RuntimeChaosReceiptArtifactSchema>
export const OpencodeLossCredentialEvidenceSchema = z.object({
  path: z.literal('/home/freshell/provider/.local/share/opencode/auth.json'), exists: z.boolean(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type OpencodeLossCredentialEvidence = z.infer<typeof OpencodeLossCredentialEvidenceSchema>
const OPENCODE_LOSS_TARGETS = [
  '/home/freshell/provider/.local/share/opencode/opencode.db',
  '/home/freshell/provider/.local/share/opencode/opencode.db-wal',
  '/home/freshell/provider/.local/share/opencode/opencode.db-shm',
  '/home/freshell/provider/.freshell/checkpoints',
] as const
const OpencodeLossAbsenceCheckSchema = z.object({
  path: z.enum(OPENCODE_LOSS_TARGETS), state: z.enum(['absent', 'present', 'unknown']), probe: z.literal('lstat'),
}).strict()
export const OpencodeLossAbsenceEvidenceSchema = z.array(OpencodeLossAbsenceCheckSchema).length(4)
  .refine(rows => rows.every((row, index) => row.path === OPENCODE_LOSS_TARGETS[index]), 'exact ordered loss targets required')
export type OpencodeLossAbsenceEvidence = z.infer<typeof OpencodeLossAbsenceEvidenceSchema>
export const OpencodeLossRecoverySchema = z.object({
  outcome: z.string().min(1), incidentId: z.string().min(1),
  view: z.object({ cleanupState: z.string().min(1), nativeSessionId: z.string().min(1),
    intentRevision: z.number().int().nonnegative() }).strict(),
}).strict()
export type OpencodeLossRecovery = z.infer<typeof OpencodeLossRecoverySchema>
export const OpencodeLossIncidentEvidenceSchema = z.object({
  persisted: z.boolean(), containsNativeSessionId: z.boolean(), containsControlSecret: z.boolean(),
  certificateSha256: z.string().regex(/^[a-f0-9]{64}$/),
  certificate: z.object({ intentRevision: z.number().int().nonnegative(),
    nativeSessionRefHash: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict(),
  artifactRef: z.string().regex(/^phase5-loss-incident:[a-f0-9]{64}$/),
}).strict()
export type OpencodeLossIncidentEvidence = z.infer<typeof OpencodeLossIncidentEvidenceSchema>
export const RuntimeLossAssertionsSchema = z.object({
  schemaVersion: z.literal(2), caseId: z.literal('P5-G02'),
  test: z.object({ total: z.number().int().nonnegative(), passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative() }).strict(),
  identity: z.object({ provider: z.literal('opencode'), soulId: z.string().min(1), incarnationId: z.string().min(1),
    containerId: z.string().regex(/^[a-f0-9]{64}$/), hostBootId: z.string().min(1),
    nativeSessionIdHash: z.string().regex(/^sha256:[a-f0-9]{64}$/), incidentId: z.string().min(1) }).passthrough(),
  intent: z.record(z.string(), z.unknown()), providerState: z.record(z.string(), z.unknown()),
  browser: z.record(z.string(), z.unknown()),
}).strict()
export type RuntimeLossAssertions = z.infer<typeof RuntimeLossAssertionsSchema>
export const RuntimeLossAssertionsArtifactSchema = z.object({
  artifactRef: z.string().regex(/^phase5-loss-assertions:[a-f0-9]{64}$/),
}).strict()
export type RuntimeLossAssertionsArtifact = z.infer<typeof RuntimeLossAssertionsArtifactSchema>
export const RuntimeLossReceiptArtifactSchema = z.object({
  artifactRef: z.string().regex(/^phase5-loss:[a-f0-9]{64}$/),
}).strict()
export type RuntimeLossReceiptArtifact = z.infer<typeof RuntimeLossReceiptArtifactSchema>
export const RuntimeFreshAgentObservationSchema: z.ZodType<FreshAgentQualificationRow> = z.object({
  mode: z.enum(['freshclaude', 'kilroy', 'freshcodex', 'freshopencode']), provider: z.string().min(1),
  providerVersion: z.string().min(1), model: z.string().min(1), effort: z.string().min(1), runtimeVariant: z.string().min(1),
  actualProviderProcess: z.literal(true), fixtureTransport: z.literal(false),
  ingresses: z.array(z.enum(['browser-picker', 'browser-split', 'history-resume', 'ws-create', 'ws-attach',
    'rest-tab', 'rest-split', 'mcp-new-tab', 'mcp-split', 'startup-restore', 'auto-resume'])),
  soulId: z.string().min(1), nativeSessionId: z.string().min(1), providerStoreId: z.string().min(1),
  completedNativeTurns: z.array(z.object({ turnId: z.string().min(1), assistantMessageId: z.string().min(1),
    completionKind: z.literal('provider_native_completed') }).strict()), noToolRecall: z.boolean(),
  crashes: z.object({ web: z.array(z.string()), host: z.array(z.string()) }).strict(),
  pendingApproval: z.discriminatedUnion('supported', [z.object({ supported: z.literal(false) }).strict(),
    z.object({ supported: z.literal(true), survivedWebRestart: z.boolean(), survivedHostRecovery: z.boolean(),
      resolvedExactlyOnce: z.boolean(), decisionIdHash: z.string() }).strict()]),
  writerProof: z.object({ activeWriterCount: z.number(), conflictingWriterCount: z.number(),
    dispatchCountForPrompt: z.number(), completionCountForPrompt: z.number() }).strict(),
  isolation: z.object({ providerVolumeNameHash: z.string(), enclosureIdHash: z.string(),
    independentProviderStore: z.boolean(), independentEnclosure: z.boolean() }).strict(),
  limits: z.object({ cpuMax: z.string(), memoryMax: z.string(), swapMax: z.string(), pidsMax: z.string() }).strict(),
  oldEnclosure: z.object({ verifiedEmptyBeforeResume: z.boolean(), writerClaimReleasedBeforeResume: z.boolean() }).strict(),
}).passthrough()
export const RuntimeFreshAgentReceiptArtifactsSchema = z.object({
  rowCount: z.number().int().positive(), artifactRefs: z.array(z.string().regex(/^fresh-agent-qualification:[a-f0-9]{64}$/)).nonempty(),
}).strict()
export type RuntimeFreshAgentReceiptArtifacts = z.infer<typeof RuntimeFreshAgentReceiptArtifactsSchema>
export const RuntimeOwnershipFactsSchema = z.object({
  receiptCount: z.number().int().nonnegative(), unsafeBrokerAttempts: z.number().int().nonnegative(),
  supervisorContainerId: z.string().regex(/^[a-f0-9]{64}$/), supervisorBinaryKind: z.enum(['test', 'release']),
}).strict()
export type RuntimeOwnershipFacts = z.infer<typeof RuntimeOwnershipFactsSchema>
const ONECLI_PROVIDER_CA_PATH = '/home/freshell/provider/.config/onecli/gateway-ca.pem'

type OpenCodeOnecliBootstrap = {
  authFile: string
  environmentFile: string
  caFile: string
}

function requirePrivateGrantFile(
  env: NodeJS.ProcessEnv,
  key: string,
  qualification: string,
  description: string,
): string {
  const configured = env[key]?.trim()
  if (!configured) throw new Error(`${qualification} requires ${key} to point at a private ${description}`)
  if (!path.isAbsolute(configured)) throw new Error(`${qualification} ${key} must be an absolute path`)

  let stat: fs.Stats
  try {
    stat = fs.lstatSync(configured)
  } catch {
    throw new Error(`${qualification} ${description} is not an existing file: ${configured}`)
  }
  if (!stat.isFile()) {
    throw new Error(`${qualification} ${description} must be a regular file: ${configured}`)
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${qualification} ${description} must be private (mode 0600 or stricter): ${configured}`)
  }
  if ((stat.mode & 0o400) === 0) {
    throw new Error(`${qualification} ${description} must be owner-readable: ${configured}`)
  }
  try {
    const descriptor = fs.openSync(configured, 'r')
    fs.closeSync(descriptor)
    return fs.realpathSync(configured)
  } catch {
    throw new Error(`${qualification} ${description} is unreadable: ${configured}`)
  }
}

/** Require the explicit typed OneCLI auth-file grant used by isolated OpenCode gates. */
export function requireOpenCodeAuthFile(
  env: NodeJS.ProcessEnv = process.env,
  qualification = 'P2-G04',
): string {
  return requirePrivateGrantFile(
    env,
    'FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE',
    qualification,
    'OpenCode auth.json OneCLI grant',
  )
}

function readEnvironmentGrant(file: string, qualification: string): Map<string, string> {
  const values = new Map<string, string>()
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    throw new Error(`${qualification} OpenCode OneCLI environment grant is unreadable`)
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) throw new Error(`${qualification} OpenCode OneCLI environment grant is invalid`)
    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim()
    if (!key || values.has(key)) throw new Error(`${qualification} OpenCode OneCLI environment grant is invalid`)
    values.set(key, value)
  }
  return values
}

/** Require a safe OpenCode OAuth stub plus the full OneCLI proxy and CA transport. */
export function requireOpenCodeOnecliBootstrap(
  env: NodeJS.ProcessEnv = process.env,
  qualification = 'P2-G04',
): OpenCodeOnecliBootstrap {
  const authFile = requireOpenCodeAuthFile(env, qualification)
  const environmentFile = requirePrivateGrantFile(
    env,
    'FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE',
    qualification,
    'OpenCode OneCLI environment grant',
  )
  const caFile = requirePrivateGrantFile(
    env,
    'FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE',
    qualification,
    'OpenCode OneCLI CA certificate grant',
  )
  if (new Set([authFile, environmentFile, caFile]).size !== 3) {
    throw new Error(`${qualification} OpenCode OneCLI grants must be separate files`)
  }

  let auth: unknown
  try {
    auth = JSON.parse(fs.readFileSync(authFile, 'utf8'))
  } catch {
    throw new Error(`${qualification} OpenCode OneCLI auth grant must be valid JSON`)
  }
  const openai = (auth as { openai?: Record<string, unknown> } | null)?.openai
  const expectedAuthKeys = ['access', 'expires', 'refresh', 'type']
  if (
    !openai
    || Object.keys(auth as Record<string, unknown>).length !== 1
    || Object.keys(openai).sort().join(',') !== expectedAuthKeys.join(',')
    || openai.type !== 'oauth'
    || openai.access !== 'onecli-managed'
    || openai.refresh !== 'onecli-managed'
    || typeof openai.expires !== 'number'
    || !Number.isFinite(openai.expires)
    || openai.expires < Date.now() + 60 * 60 * 1000
  ) {
    throw new Error(`${qualification} requires a future OneCLI placeholder OAuth credential for OpenCode`)
  }

  const environment = readEnvironmentGrant(environmentFile, qualification)
  const proxy = environment.get('HTTPS_PROXY')
  const noProxy = environment.get('NO_PROXY')
  const noProxyHosts = noProxy?.split(',').map((host) => host.trim().toLowerCase()).sort()
  const lowerNoProxy = environment.get('no_proxy')
  if (
    !proxy
    || environment.get('https_proxy') !== proxy
    || environment.get('HTTP_PROXY') !== proxy
    || environment.get('http_proxy') !== proxy
    || environment.get('OPENAI_BASE_URL') !== 'https://api.openai.com/v1'
    || environment.get('NODE_EXTRA_CA_CERTS') !== ONECLI_PROVIDER_CA_PATH
    || environment.get('NODE_USE_ENV_PROXY') !== '1'
    || noProxyHosts?.join(',') !== '127.0.0.1,localhost'
    || (lowerNoProxy !== undefined && lowerNoProxy !== noProxy)
  ) {
    throw new Error(
      `${qualification} OpenCode OneCLI environment grant is missing required proxy, CA, or loopback-only NO_PROXY settings`,
    )
  }

  return { authFile, environmentFile, caFile }
}

const OPENCODE_CONTINUITY_AUTH_SCRIPT = "const fs=require('node:fs');const auth=JSON.parse(fs.readFileSync('/home/freshell/provider/.local/share/opencode/auth.json','utf8'));const openai=auth.openai;if(!openai||openai.type!=='oauth'||openai.access!=='onecli-managed'||openai.refresh!=='onecli-managed'||openai.expires<Date.now()+3600000)process.exit(2);fs.accessSync('/home/freshell/provider/.config/onecli/gateway-ca.pem',fs.constants.R_OK);process.stdout.write('onecli managed OpenAI stub and CA present')"
export const OpencodeContinuityStartupFactsSchema = z.object({
  authPresent: z.boolean(), modelAvailable: z.boolean(), explicitModelArg: z.boolean(),
  loopbackHostname: z.boolean(), explicitPort: z.boolean(),
}).strict()
export type OpencodeContinuityStartupFacts = z.infer<typeof OpencodeContinuityStartupFactsSchema>
export const OpencodeContinuityFirstReplySchema = z.object({
  resolvedProvider: z.string(), resolvedModel: z.string(),
}).strict()
export type OpencodeContinuityFirstReply = z.infer<typeof OpencodeContinuityFirstReplySchema>
export const OpencodeQualificationStartupFactsSchema = z.object({
  modelProcessPresent: z.boolean(), authPresent: z.boolean(), modelAvailable: z.boolean(),
  limits: z.object({ cpuMax: z.string(), memoryMax: z.string(), swapMax: z.string(), pidsMax: z.string() }).strict(),
}).strict()
export type OpencodeQualificationStartupFacts = z.infer<typeof OpencodeQualificationStartupFactsSchema>
export const OpencodeReplacementReadinessSchema = z.object({
  incarnationId: z.string().min(1), streamEpoch: z.string().min(1), terminalId: z.string().min(1),
  exited: z.boolean(), headSeq: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]), sourceReady: z.boolean(),
}).strict()
export type OpencodeReplacementReadiness = z.infer<typeof OpencodeReplacementReadinessSchema>
export const OpencodeReadinessConfirmationSchema = OpencodeReplacementReadinessSchema.pick({ terminalId: true, streamEpoch: true, headSeq: true })
export type OpencodeReadinessConfirmation = z.infer<typeof OpencodeReadinessConfirmationSchema>
export const OpencodeReadinessDiagnosticSchema = z.object({
  soulId: z.string().min(1), incarnationId: z.string().min(1), terminalId: z.string().min(1), stableLaunchStreamId: z.string().min(1),
  paneStreamId: z.string().optional(), paneIncarnationId: z.string().optional(),
  browserInputReady: z.boolean().optional(), browserModelBanner: z.boolean().optional(),
  sourceIncarnationId: z.string().optional(), sourceStreamEpoch: z.string().optional(), sourceTerminalId: z.string().optional(),
  sourceExited: z.boolean().optional(), sourceReady: z.boolean().optional(),
  sourceCursor: OpencodeReplacementReadinessSchema.shape.headSeq.optional(),
  observedStreamChanges: z.array(z.object({ terminalId: z.string(), streamId: z.string(), reason: z.string(),
    attachRequestId: z.string().nullable() }).strict()).max(10),
  observedWebSocketFrameTypes: z.array(z.string()), observedWebSocketCount: z.number().int().nonnegative(),
}).strict()
export type OpencodeReadinessDiagnostic = z.infer<typeof OpencodeReadinessDiagnosticSchema>
const OpencodeQualificationProofStageSchema = z.enum(['initial', 'after_session_host_crash', 'after_provider_process_crash'])
export type OpencodeQualificationProofStage = z.infer<typeof OpencodeQualificationProofStageSchema>
const NativeMessageComponentEvidenceSchema = z.object({
  messageId: z.string().min(1), parentMessageId: z.string().min(1).nullable(),
  recordIndex: z.number().int().nonnegative(), byteStart: z.number().int().nonnegative(),
  byteEnd: z.number().int().positive(), recordSha256: NativeDigest,
}).strict()
const NativeMessageComponentsSchema = z.array(NativeMessageComponentEvidenceSchema).nonempty().optional()
const OpencodeQualificationNativeEvidenceSchema = z.object({ kind: z.literal('identified_message'),
  turnId: z.string(), messageId: z.string(), parentMessageId: z.string().nullable(),
  components: NativeMessageComponentsSchema, parentChain: NativeMessageComponentsSchema,
}).strict()
const OpencodeQualificationNativeTurnSchema = z.object({
  nativeEvidence: OpencodeQualificationNativeEvidenceSchema, turnId: z.string().optional(), messageId: z.string().optional(),
  parentMessageId: z.string().nullable().optional(), completedAt: z.union([z.string(), z.number()]), text: z.string(),
  toolCalls: z.array(z.object({ type: z.string(), name: z.string().optional() })),
  resolvedProvider: z.string(), resolvedModel: z.string(), resolvedReasoningEffort: z.string(),
  providerProvenance: z.string(), modelProvenance: z.string(), reasoningEffortProvenance: z.string(),
})
export const OpencodeQualificationTurnSchema = z.object({ messageId: z.string().min(1),
  containsOtherNonce: z.boolean().nullable(), proof: z.object({ schemaVersion: z.literal(2),
    stage: OpencodeQualificationProofStageSchema, nativeSessionId: z.string().min(1),
    nativeEvidence: OpencodeQualificationNativeEvidenceSchema, completedAt: z.union([z.string(), z.number()]),
    responseSha256: z.string().regex(/^[a-f0-9]{64}$/), responseContainsNonce: z.literal(true),
    toolCallCount: z.number().int().nonnegative(), toolCallTypes: z.array(z.string()),
    resolvedProvider: z.string(), resolvedModel: z.string(), resolvedReasoningEffort: z.string(),
    providerProvenance: z.string(), modelProvenance: z.string(), reasoningEffortProvenance: z.string(),
  }).strict(),
}).strict()
export type OpencodeQualificationTurn = z.infer<typeof OpencodeQualificationTurnSchema>
const FreshCodexHistoryMeasurementErrorSchema = z.enum(['owned CPU profile stop/extraction failed',
  'owned CPU profiler disable failed', 'owned CDP detach failed', 'owned perf audit extraction failed'])
export type FreshCodexHistoryMeasurementError = z.infer<typeof FreshCodexHistoryMeasurementErrorSchema>
export const FreshCodexHistoryMeasurementStartSchema = z.object({ kind: z.literal('owned-page saved-history diagnostic'),
  errors: z.array(FreshCodexHistoryMeasurementErrorSchema), browserBeforeReload: z.object({ timeOrigin: z.number(), now: z.number() }).strict(),
  cpuStartRequestedAt: z.number(), cpuStartedAt: z.number(),
}).strict()
export type FreshCodexHistoryMeasurementStart = z.infer<typeof FreshCodexHistoryMeasurementStartSchema>
export const FreshCodexHistoryMeasurementFinishSchema = z.object({ cpuStartRequestedAt: z.number().optional(),
  cpuStartedAt: z.number().optional(), cpuStopRequestedAt: z.number().optional(), cpuStoppedAt: z.number().optional(),
  errors: z.array(FreshCodexHistoryMeasurementErrorSchema),
}).strict()
export type FreshCodexHistoryMeasurementFinish = z.infer<typeof FreshCodexHistoryMeasurementFinishSchema>
const FreshCodexProfileFrameSchema = z.object({ functionName: z.string().regex(/^[\w .()<>:$-]{0,120}$/),
  script: z.string().regex(/^[^/?#\\\r\n]*$/).optional(), line: z.number().optional(), column: z.number().optional(),
}).strict()
export const FreshCodexSavedHistoryMeasurementSchema = z.object({ kind: z.literal('owned-page saved-history diagnostic'),
  errors: z.array(FreshCodexHistoryMeasurementErrorSchema), browserBeforeReload: z.object({ timeOrigin: z.number(), now: z.number() }).strict().optional(),
  cpuStartRequestedAt: z.number().optional(), cpuStartedAt: z.number().optional(), cpuStopRequestedAt: z.number().optional(),
  cpuStoppedAt: z.number().optional(), finallyEnteredAt: z.number().optional(),
  cpu: z.object({ startTimeUs: z.number(), endTimeUs: z.number(), sampledDurationMs: z.number(), sampleCount: z.number(),
    topLeaves: z.array(FreshCodexProfileFrameSchema.extend({ samples: z.number(), durationMs: z.number(),
      stack: z.array(FreshCodexProfileFrameSchema).max(20) })).max(80),
    seconds: z.array(z.object({ second: z.number(), durationMs: z.number(), samples: z.number(), idleMs: z.number() }).strict()),
  }).strict().optional(),
  audit: z.object({ timeOrigin: z.number(), extractedAtMs: z.number(), available: z.boolean(), cutoffWallMs: z.number(),
    requestRecordCount: z.number(), requestRecordsReturned: z.number(), requestRecordsDropped: z.number(),
    requestRecords: z.array(z.object({ sequence: z.number(),
    stage: z.enum(['refresh_requested', 'effect_skipped', 'request_captured', 'request_queued', 'run_started', 'native_started', 'native_completed', 'native_failed', 'soul_started', 'outcome_received', 'currentness_checked', 'identity_rejected', 'display_committed']).optional(),
    trigger: z.enum(['identity', 'event', 'send-accepted', 'materialized', 'manual', 'poll', 'reconnect', 'reveal', 'idle-incomplete']).optional(),
    reason: z.enum(['no_thread', 'divergence', 'unmanaged_lost']).optional(),
    check: z.enum(['native-error', 'before-soul', 'outcome', 'error-fold']).optional(),
    source: z.enum(['direct', 'fallback']).optional(),
    fence: z.enum(['create', 'soul', 'revision', 'boot', 'owner', 'applied_serial', 'read_generation', 'recovery', 'provider', 'session_type', 'thread', 'divergence']).optional(),
    errorKind: z.enum(['abort', 'error']).optional(),
    outcome: z.enum(['ok', 'error', 'coalesced', 'rate-limited', 'backoff']).optional(),
    timestamp: z.number().optional(),
    view: z.number().optional(),
    requestSerial: z.number().optional(),
    readGeneration: z.number().optional(),
    refreshSerial: z.number().optional(),
    appliedSerial: z.number().optional(),
    currentGeneration: z.number().optional(),
    previousRows: z.number().optional(),
    rows: z.number().optional(),
    revision: z.number().optional(),
    requestReadOnly: z.boolean().optional(),
    hasSoul: z.boolean().optional(),
    ran: z.boolean().optional(),
    stale: z.boolean().optional(),
    historyOnly: z.boolean().optional(),
    live: z.boolean().optional(),
    vacant: z.boolean().optional(),
    accepted: z.boolean().optional(),
    providerMatches: z.boolean().optional(),
    typeMatches: z.boolean().optional(),
    threadMatches: z.boolean().optional(),
    initialCapture: z.boolean().optional(),
    createChanged: z.boolean().optional(),
    soulChanged: z.boolean().optional(),
    revisionChanged: z.boolean().optional(),
    bootChanged: z.boolean().optional(),
    ownerChanged: z.boolean().optional(),
    providerChanged: z.boolean().optional(),
    typeChanged: z.boolean().optional(),
    threadChanged: z.boolean().optional(),
    paneSessionChanged: z.boolean().optional(),
    recoveryChanged: z.boolean().optional(),
    lostChanged: z.boolean().optional(),
    supervisorChanged: z.boolean().optional(),
    refreshChanged: z.boolean().optional(),
    }).strict()).max(2000),
    events: z.array(z.object({ sequence: z.number(), event: z.enum(['perf.api_slow', 'perf.api_parse_slow', 'perf.longtask', 'perf.resource_slow']),
      route: z.string().regex(/^(native-thread-snapshot|owned-soul-history|unknown-route|other-api|document-or-resource|asset:[^/?#\\\r\n]*)$/).optional(),
      status: z.number().optional(),
      durationMs: z.number().optional(),
      ttfbMs: z.number().optional(),
      bodyMs: z.number().optional(),
      parseMs: z.number().optional(),
      payloadChars: z.number().optional(),
      startTime: z.number().optional(),
      transferSize: z.number().optional(),
      encodedBodySize: z.number().optional(),
      decodedBodySize: z.number().optional(),
    }).strict()),
  }).strict().optional(),
}).strict()
export type FreshCodexSavedHistoryMeasurement = z.infer<typeof FreshCodexSavedHistoryMeasurementSchema>
export const FreshCodexSavedHistoryOwnershipFactsSchema = z.object({
  receiptContainerIds: z.array(z.string()), startCount: z.number().int().nonnegative(),
  launches: z.array(z.object({ event: z.literal('supervisor.launch_running'), at: z.union([z.number(), z.string()]),
    data: z.object({ soulId: z.string(), incarnationId: z.string(), containerId: z.string(), workerLaunchCount: z.number().int().nonnegative() }) })),
  targetSoulRecoveries: z.array(z.object({ event: z.literal('supervisor.runtime_observer.recovery_scheduled'),
    at: z.union([z.number(), z.string()]), data: z.object({ soulId: z.string() }) })),
}).strict()
export type FreshCodexSavedHistoryOwnershipFacts = z.infer<typeof FreshCodexSavedHistoryOwnershipFactsSchema>
export const FreshCodexControllerStartupFactsSchema = z.object({
  controllerHealth: z.object({ control_epoch: z.number().int().nonnegative(), installation_id: z.string() }),
  startupFinished: z.object({ event: z.literal('supervisor.startup_scan.finished'), at: z.number(),
    data: z.object({ scanned: z.number().int().nonnegative(), blockedSubsystems: z.array(z.string()) }) }),
  controllerReady: z.object({ event: z.literal('supervisor.ready'), at: z.number(),
    data: z.object({ controlEpoch: z.number().int().nonnegative(), installationId: z.string() }) }),
}).strict()
export type FreshCodexControllerStartupFacts = z.infer<typeof FreshCodexControllerStartupFactsSchema>
const FreshCodexHistoryStateSchema = z.object({ nativeSessionId: z.string().min(1), pendingDecisionId: z.string().min(1).nullable(),
  dispatchCount: z.number().int().nonnegative(), completionCount: z.number().int().nonnegative() }).strict()
export type FreshCodexControllerReattachment = {
  oldControllerId: string; currentControllerId: string; oldControlEpoch: number; currentControlEpoch: number
  controllerRestartStartedAt: number; completedAt: number; reattached: ManagedRuntimeView
  controllerReady: FreshCodexControllerStartupFacts['controllerReady']
  startupFinished: FreshCodexControllerStartupFacts['startupFinished']
}
export const FreshCodexControllerReattachmentSchema: z.ZodType<FreshCodexControllerReattachment> = z.object({
  oldControllerId: z.string().regex(/^[a-f0-9]{64}$/), currentControllerId: z.string().regex(/^[a-f0-9]{64}$/),
  oldControlEpoch: z.number().int().nonnegative(), currentControlEpoch: z.number().int().nonnegative(),
  controllerRestartStartedAt: z.number(), completedAt: z.number(),
  controllerReady: FreshCodexControllerStartupFactsSchema.shape.controllerReady,
  startupFinished: FreshCodexControllerStartupFactsSchema.shape.startupFinished,
  reattached: ManagedRuntimeSoulSchema.partial().required({ soulId: true, incarnationId: true, launchState: true, intentRevision: true }).strict(),
}).strict()
export const FreshCodexSavedHistoryPreservationSchema = z.object({ source: z.literal('owned provider-volume native history'),
  wrongSource: z.literal('coincident web-local native history'), heldHost: z.object({ containerId: z.string().regex(/^[a-f0-9]{64}$/),
    incarnationId: z.string().min(1), pid: z.number().int().positive() }).strict(),
  // Managed inventory owns recovery. A single original create request may
  // rebind its native reference; legacy pane reconciliation is not involved.
  bootstrap: z.null(), bootstrapCreates: z.array(FreshAgentCreateSchema.strict()).max(1),
  nativeSessionId: z.string().min(1), beforeHistory: FreshCodexHistoryStateSchema, afterReload: FreshCodexHistoryStateSchema,
  originalIdentity: z.object({ sessionRef: SessionRefSchema, resumeSessionId: z.string().optional(),
    createRequestId: z.string().min(1), soulId: z.string().min(1) }).strict(),
  managedLaunch: FreshCodexSavedHistoryOwnershipFactsSchema.shape.launches.element, bothSourcesUnchanged: z.literal(true),
  observerWindow: z.object({ intervalMs: z.literal(60000), controllerReattachment: FreshCodexControllerReattachmentSchema,
    startupFinished: FreshCodexControllerStartupFactsSchema.shape.startupFinished,
    firstObservationNotBefore: z.number(), holdRequestedAt: z.number(), heldAt: z.number(), releasedAt: z.number(), resumedAt: z.number(),
    targetSoulRecoveries: FreshCodexSavedHistoryOwnershipFactsSchema.shape.targetSoulRecoveries,
  }).strict(),
}).strict()
export type FreshCodexSavedHistoryPreservation = z.infer<typeof FreshCodexSavedHistoryPreservationSchema>
export const FreshCodexRetainedSnapshotFactsSchema = z.object({
  threadId: z.string(), bytes: z.number().int().nonnegative(), turnCount: z.number().int().nonnegative(),
  firstTurnId: z.string().nullable(), lastTurnId: z.string().nullable(), firstAnswerMatches: z.boolean(),
  lastAnswerMatches: z.boolean(), retentionAbsent: z.boolean(),
}).strict()
export type FreshCodexRetainedSnapshotFacts = z.infer<typeof FreshCodexRetainedSnapshotFactsSchema>
export const Phase4BrowserObservationSchema = z.object({
  browserInteraction: z.boolean(), coldStartAgents: z.number().int().nonnegative(), restartCycles: z.number().int().nonnegative(),
  deterministicPlacement: z.boolean(), singleViewPerIntent: z.boolean(), existingLayoutPreserved: z.boolean(), focusStable: z.boolean(),
  expectedFocus: z.object({ activeTabId: z.string(), activePaneId: z.string() }).strict(),
  focusObservations: z.array(z.object({ stage: z.string(), activeTabId: z.string(), activePaneId: z.string().nullable() }).strict()),
  sameSoulIds: z.boolean(), noBlankSubstitution: z.boolean(), closeViewKeepsAgent: z.boolean(),
  closeViewNotRecreatedAfterInventoryRefresh: z.boolean(), stopAgentStopsRuntime: z.boolean(), oldClientNoDuplicate: z.boolean(),
  initialSoulIds: z.array(z.string()), expectedTabIds: z.array(z.string()), expectedPaneIds: z.array(z.string()),
  browserTabId: z.string(), createdTabIds: z.array(z.string()),
}).strict()
export type Phase4BrowserObservation = z.infer<typeof Phase4BrowserObservationSchema>
export const RuntimeProviderNativeTurnProofsSchema = z.array(OpencodeQualificationTurnSchema.shape.proof.extend({
  nativeEvidence: z.discriminatedUnion('kind', [OpencodeQualificationNativeEvidenceSchema,
    z.object({ kind: z.literal('append_only_record'), recordIndex: z.number().int().nonnegative(),
      byteStart: z.number().int().nonnegative(), byteEnd: z.number().int().nonnegative(),
      recordSha256: z.string(), prefixSha256Before: z.string(), completionEventOrdinal: z.number().int().nonnegative(),
      completionEventSha256: z.string(), responseEventSha256s: z.array(NativeDigest).nonempty().optional() }).strict()]),
}))
export const RuntimeProviderObservationSchema: z.ZodType<ProviderQualificationRow> = z.object({
  provider: z.string().min(1), modes: z.array(z.string().min(1)), providerVersion: z.string().min(1),
  model: z.string().min(1), reasoningEffort: z.string().min(1), nativeSessionId: z.string().min(1),
  nonceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  nativeTurnProofs: RuntimeProviderNativeTurnProofsSchema,
  actualProviderBinary: z.boolean(), completedTurn: z.boolean(), nativeStateCaptured: z.boolean(), runtimeOwned: z.boolean(),
  limitsVerified: z.boolean(), swapMaxVerified: z.boolean(),
  limitEvidence: z.object({ cpuMax: z.string(), memoryMax: z.string(), swapMax: z.string(), pidsMax: z.string() }).strict(),
  automaticResume: z.boolean(), profileVerified: z.boolean(), releaseBinary: z.boolean(), nativeRecovery: z.boolean(),
  exactNativeRecovery: z.boolean(), sameNativeSession: z.boolean(), followUpCompleted: z.boolean(), onlyOneWriter: z.boolean(),
  writerClaim: z.object({ provider: z.string(), providerStoreId: z.string(), nativeSessionId: z.string(), soulId: z.string(),
    incarnationId: z.string(), activeClaimCount: z.number(), globalConflictingClaimCount: z.number() }).strict(),
  oldEnclosureVerifiedEmpty: z.boolean(), verifiedEmptyOrdering: z.object({ stopOutcome: z.literal('verified_empty'),
    activeClaimCountAfterStop: z.number(), globalConflictingClaimCountAfterStop: z.number(), oldContainerRunningAfterStop: z.boolean() }).strict(),
  lostNoticeCount: z.number(), crashKinds: z.array(z.string()),
  nonceRecovery: z.object({ sameSoul: z.boolean(), sameNativeSession: z.boolean(), newIncarnation: z.boolean(),
    oldEnclosureVerifiedEmpty: z.boolean(), recalledNonce: z.boolean(), followUpCompleted: z.boolean(),
    workspaceOrToolReadUsed: z.boolean() }).strict().optional(),
  repairedSameSoul: z.boolean().optional(), repairedSameNativeSession: z.boolean().optional(),
  blockers: z.array(z.object({ reason: z.string(), outcome: z.literal('blocked'), lost: z.literal(false) }).strict()).optional(),
  blockerEvidence: z.array(z.string()).optional(),
}).strict()
export const RuntimeProviderReceiptArtifactsSchema = z.object({ schemaVersion: z.literal(2),
  rowCount: z.number().int().positive(), artifactRefs: z.array(z.string().regex(/^provider-qualification:[a-f0-9]{64}$/)).nonempty(),
}).strict()
export type RuntimeProviderReceiptArtifacts = z.infer<typeof RuntimeProviderReceiptArtifactsSchema>
const TerminalContinuityIdentitySchema = z.object({
  soulId: z.string().min(1), incarnationId: z.string().min(1),
  containerId: z.string().regex(/^[a-f0-9]{64}$/), hostBootId: z.string().min(1),
})
export const RuntimeTerminalContinuityObservationSchema = z.discriminatedUnion('caseId', [
  TerminalContinuityIdentitySchema.extend({ caseId: z.literal('P2-G01'), status: z.literal('PASS'),
    restartCycles: z.literal(10), childPid: z.number().int().positive(), outputAdvanced: z.literal(true),
    inputUsable: z.literal(true), viewAssociations: z.literal(1), createRequestId: z.string().min(1),
    terminalId: z.string().min(1) }).strict(),
  TerminalContinuityIdentitySchema.extend({ caseId: z.literal('P2-G04'), status: z.literal('PASS'), provider: z.literal('opencode'),
    modelProvider: z.string().min(1), opencodeVersion: z.string().min(1), model: z.string().min(1),
    resolvedModel: z.string().min(1), freeTier: z.literal(false), nativeSessionId: z.string().min(1),
    sameNativeSession: z.literal(true), sameIncarnation: z.literal(true), toolCompletionCount: z.literal(1),
    followupSucceeded: z.literal(true), providerLaunchCount: z.number().int().refine((value): boolean => value === 1, 'one observed provider launch required') }).strict(),
])
export type RuntimeTerminalContinuityObservation = z.infer<typeof RuntimeTerminalContinuityObservationSchema>
export const RuntimeTerminalChildFactsSchema = z.union([
  z.object({ pid: z.number().int().positive(), running: z.boolean() }).strict(),
  z.object({ pid: z.null(), running: z.literal(false) }).strict(),
])
export type RuntimeTerminalChildFacts = z.infer<typeof RuntimeTerminalChildFactsSchema>
const OPENCODE_LOSS_ABSENCE_SCRIPT = String.raw`
const fs = require('node:fs');
const target = process.argv[1];
let state = 'absent';
try { fs.lstatSync(target); state = 'present'; } catch (error) { if (error.code !== 'ENOENT') state = 'unknown'; }
process.stdout.write(JSON.stringify({ path: target, state, probe: 'lstat' }));
`
const OPENCODE_LOSS_REMOVAL_SCRIPT = String.raw`
const fs = require('node:fs');
for (const target of [
  '/home/freshell/provider/.local/share/opencode/opencode.db',
  '/home/freshell/provider/.local/share/opencode/opencode.db-wal',
  '/home/freshell/provider/.local/share/opencode/opencode.db-shm',
]) {
  try { fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const checkpoints = '/home/freshell/provider/.freshell/checkpoints';
try { fs.rmSync(checkpoints, { recursive: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!fs.statSync('/home/freshell/provider/p5-diagnostic-only').isFile()) process.exit(2);
`
const OPENCODE_LOSS_CREDENTIAL_SCRIPT = String.raw`
const crypto = require('node:crypto');
const fs = require('node:fs');
const target = process.argv[1];
let exists = false;
let digest = crypto.createHash('sha256').update('absent').digest('hex');
try {
  const stat = fs.lstatSync(target);
  exists = stat.isFile();
  if (exists) digest = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
process.stdout.write(JSON.stringify({ path: target, exists, sha256: digest }));
`

export function writePrivateRuntimeChaosJsonl(filePath: string, rows: readonly RuntimeChaosLog[]): void {
  if (rows.length === 0) throw new Error('refusing to persist an empty chaos log')
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, { mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
}
export const RuntimeChaosWebOutputFactsSchema = z.object({ contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentBytes: z.number().int().nonnegative(), containsFollowUpMarker: z.boolean(), containsAuthToken: z.boolean() }).strict()
export type RuntimeChaosWebOutputFacts = z.infer<typeof RuntimeChaosWebOutputFactsSchema>

export const RuntimeHostProcessStateSchema = z.object({ pid: z.number().int().positive(), stopped: z.boolean() }).strict()
export type RuntimeHostProcessState = z.infer<typeof RuntimeHostProcessStateSchema>
export const OwnedContainerStateSchema = z.discriminatedUnion('present', [
  z.object({ present: z.literal(false), running: z.literal(false) }).strict(),
  z.object({ present: z.literal(true), running: z.boolean() }).strict(),
])
export type OwnedContainerState = z.infer<typeof OwnedContainerStateSchema>

export const ManagedTerminalStartupFactsSchema = z.object({
  provider: z.enum(['claude', 'codex', 'opencode', 'amplifier']),
  version: z.string().max(200).regex(/\b\d+\.\d+\.\d+\b/), providerProcessPresent: z.boolean(),
  processIdentities: z.array(z.enum(['haiku', 'low', 'gpt-5.6-luna', 'openai/gpt-5.6-luna'])).max(4),
  reasoningFlagsAbsent: z.boolean(),
  limits: OpencodeQualificationStartupFactsSchema.shape.limits,
}).strict()
export type ManagedTerminalStartupFacts = z.infer<typeof ManagedTerminalStartupFactsSchema>

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

const InterruptedOrdinaryStopDurableFactsSchema = z.object({
  soul: z.object({ soul_id: z.string(), provider_store_id: z.string(), provider_volume_name: z.string(),
    native_session_id: z.string(), intent_revision: z.number().int(), desired_state: z.string() }).strict(),
  incarnations: z.array(z.object({ incarnation_id: z.string(), container_id: z.string().nullable(),
    execution_generation: z.number().int(), grant_id: z.string().nullable(), launch_state: z.string(), cleanup_state: z.string() }).strict()),
  stops: z.array(z.object({ intent_revision: z.number().int(), outcome: z.string().nullable(),
    revoke_pending: z.number().int(), settled: z.number().int() }).strict()),
  writers: z.number().int().nonnegative(), effects: z.array(z.enum(['replacement', 'writer', 'grant', 'recovery'])),
  tombstones: z.number().int().nonnegative(),
}).strict()
const InterruptedOrdinaryStopLifecycleSchema = z.object({
  event: z.enum(['supervisor.stop_committed', 'supervisor.stop_continuation']),
  data: z.object({ soulId: z.string(), intentRevision: z.number().int() }),
})
export const InterruptedOrdinaryStopFactsSchema = z.object({
  durable: InterruptedOrdinaryStopDurableFactsSchema, workerLaunchCount: z.number().int().nonnegative(),
  lifecycle: z.array(InterruptedOrdinaryStopLifecycleSchema),
}).strict()
export type InterruptedOrdinaryStopFacts = z.infer<typeof InterruptedOrdinaryStopFactsSchema>
export const InterruptedOrdinaryStopCrashFactsSchema = z.object({
  running: z.boolean(), exitCode: z.number().int(), crashPoint: z.literal('ordinary_stop_after_intent').nullable(),
}).strict()
export type InterruptedOrdinaryStopCrashFacts = z.infer<typeof InterruptedOrdinaryStopCrashFactsSchema>

// The fixed Task 6 probe installs counters only after setup; browser callers
// supply an exact registered handle, never SQL or a filesystem path.
const INTERRUPTED_ORDINARY_STOP_REGISTRY_SCRIPT = String.raw`
import json,sqlite3,sys
c=sqlite3.connect('/var/lib/freshell-supervisor/runtime.sqlite3')
c.row_factory=sqlite3.Row
if sys.argv[2]=='install':
 c.executescript("""CREATE TABLE stop_browser_effects(kind TEXT NOT NULL);
 CREATE TRIGGER stop_browser_incarnation AFTER INSERT ON incarnations BEGIN INSERT INTO stop_browser_effects VALUES('replacement'); END;
 CREATE TRIGGER stop_browser_writer AFTER INSERT ON writer_claims BEGIN INSERT INTO stop_browser_effects VALUES('writer'); END;
 CREATE TRIGGER stop_browser_grant AFTER UPDATE OF execution_generation,grant_id ON incarnations WHEN NEW.execution_generation!=OLD.execution_generation OR NEW.grant_id IS NOT OLD.grant_id BEGIN INSERT INTO stop_browser_effects VALUES('grant'); END;
 CREATE TRIGGER stop_browser_recovery AFTER INSERT ON recovery_attempts BEGIN INSERT INTO stop_browser_effects VALUES('recovery'); END;""")
soul=dict(c.execute('SELECT soul_id,provider_store_id,provider_volume_name,native_session_id,intent_revision,desired_state FROM souls WHERE soul_id=?',(sys.argv[1],)).fetchone())
incarnations=[dict(r) for r in c.execute('SELECT incarnation_id,container_id,execution_generation,grant_id,launch_state,cleanup_state FROM incarnations WHERE soul_id=? ORDER BY created_at,rowid',(sys.argv[1],))]
stops=[dict(r) for r in c.execute('SELECT intent_revision,outcome,revoke_pending,settled FROM ordinary_stops WHERE soul_id=?',(sys.argv[1],))]
print(json.dumps(dict(soul=soul,incarnations=incarnations,stops=stops,writers=c.execute('SELECT count(*) FROM writer_claims WHERE soul_id=?',(sys.argv[1],)).fetchone()[0],effects=[r[0] for r in c.execute('SELECT kind FROM stop_browser_effects')],tombstones=c.execute('SELECT count(*) FROM stop_tombstones WHERE soul_id=?',(sys.argv[1],)).fetchone()[0])))
`

export const SyntheticStoppedRepairFaultSchema = z.enum(['none', 'after_import_publication',
  'after_repair_cas_before_withdrawal', 'during_withdrawal_before_ack', 'first_resume_observation', 'source_generation_change', 'pending_withdrawal'])
export type SyntheticStoppedRepairFault = z.infer<typeof SyntheticStoppedRepairFaultSchema>

const RuntimeOwnerOperationRequestSchema = z.object({
  runId: z.string().min(1), candidateSha: z.string().regex(/^[a-f0-9]{40}$/),
  scenarioId: z.string().min(1), operationId: z.string().min(1),
  action: z.enum([
    'describe', 'inventory', 'inventory-snapshot', 'control-epoch', 'candidate-integrity', 'ownership-facts', 'terminal-child-facts', 'terminal-web-cycle', 'writer-claim', 'host-facts', 'fixture-state', 'fixture-worker', 'freshcodex-history-preservation-artifact', 'freshcodex-history-measurement-artifact', 'freshcodex-controller-reattachment', 'freshcodex-history-measurement-finish', 'freshcodex-history-measurement-start', 'freshcodex-history-ownership', 'freshcodex-controller-startup', 'freshcodex-history-snapshot', 'freshcodex-history-prepare', 'freshcodex-history-unchanged', 'freshcodex-coincident-prepare', 'freshcodex-coincident-unchanged',
    'provider-volume', 'managed-terminal-stopped-proofs', 'managed-terminal-startup', 'managed-provider-notice-count', 'fixture-decision-allow',
    'opencode-qualification-startup',
    'opencode-qualification-limits',
    'opencode-qualification-blockers',
    'opencode-replacement-readiness',
    'opencode-readiness-confirm',
    'opencode-readiness-diagnostic',
    'opencode-qualification-second-view',
    'opencode-qualification-notice-count',
    'opencode-qualification-message-ids',
    'opencode-qualification-nonce',
    'opencode-qualification-turn',
    'terminal-continuity-receipt',
    'terminal-continuity-diagnostics',
    'opencode-continuity-first-reply',
    'interrupted-stop-history', 'interrupted-stop-arm', 'interrupted-stop-counters', 'interrupted-stop-facts',
    'interrupted-stop-crash-facts', 'interrupted-stop-artifact',
    'replace-web', 'replace-web-graceful', 'replace-supervisor', 'replace-supervisor-abrupt', 'web-process-facts', 'supervisor-process-facts',
    'managed-opt-in', 'opencode-version', 'opencode-continuity-startup', 'opencode-continuity-first-turn', 'opencode-continuity-effect-count', 'opencode-continuity-follow-up', 'opencode-continuity-long-tool', 'loss-credential', 'loss-diagnostic', 'loss-absence', 'loss-remove-storage', 'loss-recover', 'loss-container-running', 'loss-incident', 'loss-assertions', 'loss-receipt', 'fresh-agent-ingresses', 'fresh-agent-receipt', 'provider-receipt', 'fresh-agent-launch-facts', 'fresh-native-register', 'fresh-native-stage', 'fresh-native-finish', 'fresh-browser-ingress', 'fresh-browser-turn-register', 'fresh-browser-turn-finish', 'fresh-browser-row', 'fresh-approval-register', 'fresh-approval-checkpoint', 'fresh-approval-finish', 'container-state', 'host-process-state', 'phase3-effect-reset', 'phase3-effect-count', 'crash-provider-worker',
    'crash-host', 'crash-provider', 'hold-host', 'release-host',
    'native-tool-evidence', 'native-follow-up-ids', 'stop-soul', 'stop-completion-facts', 'finish', 'abort', 'incident-matches-soul',
    'native-challenge-register', 'native-effect-count', 'native-effect-reset', 'chaos-web-output', 'chaos-long-tool-running', 'chaos-logs', 'chaos-evidence', 'chaos-receipt',
    'synthetic-history-challenge',
    'synthetic-source-facts',
    'synthetic-source-history', 'synthetic-source-exclusions',
    'synthetic-source-adoption',
    'synthetic-source-follow-up',
    'synthetic-stopped-repair-facts', 'synthetic-stopped-repair-observation', 'synthetic-stopped-repair-fault',
    'phase3-browser-receipt', 'phase4-browser-receipt',
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
  nativeCollectionId: z.string().uuid().optional(),
  nativeCollectionNonce: z.string().regex(/^codename-[a-f0-9]{32}$/).optional(),
  freshBrowserIngress: FreshBrowserIngressObservationSchema.optional(),
  freshBrowserRequest: z.record(z.string(), z.any()).optional(),
  freshBrowserReply: z.record(z.string(), z.any()).optional(),
  freshApprovalAllowed: z.boolean().optional(),
  freshApprovalRecovery: z.enum(['web', 'host', 'provider']).optional(),
  challengeId: z.string().min(1).optional(),
  incidentId: z.string().min(1).max(200).optional(),
  expectedControlEpoch: z.number().int().nonnegative().optional(),
  expectedIntentRevision: z.number().int().nonnegative().optional(),
  generation: z.number().int().nonnegative().optional(),
  interruptedStopRetainedTurns: z.number().int().nonnegative().optional(),
  phase3Browser: Phase3BrowserObservationSchema.optional(),
  phase4Browser: Phase4BrowserObservationSchema.optional(),
  historyMeasurementStart: FreshCodexHistoryMeasurementStartSchema.optional(),
  historyMeasurementFinish: FreshCodexHistoryMeasurementFinishSchema.optional(),
  historyControllerReattachment: FreshCodexControllerReattachmentSchema.optional(),
  historyMeasurement: FreshCodexSavedHistoryMeasurementSchema.optional(),
  historyPreservation: FreshCodexSavedHistoryPreservationSchema.optional(),
  chaosLogs: RuntimeChaosLogsSchema.optional(),
  chaosEvidence: RuntimeChaosEvidenceSchema.optional(),
  lossAssertions: RuntimeLossAssertionsSchema.optional(),
  freshAgentObservations: z.array(RuntimeFreshAgentObservationSchema).optional(),
  providerObservations: z.array(RuntimeProviderObservationSchema).optional(),
  continuityObservation: RuntimeTerminalContinuityObservationSchema.optional(),
  qualificationTerminalId: z.string().min(1).max(200).optional(),
  qualificationNonce: z.string().regex(/^p-[A-Za-z0-9_-]{22}$/).optional(),
  terminalQualificationNonce: z.string().regex(/^codename-[a-f0-9]{32}$/).optional(),
  qualificationProofStage: OpencodeQualificationProofStageSchema.optional(),
  priorMessageIds: z.array(z.string().min(1)).max(128).optional(),
  otherChallengeId: z.string().min(1).optional(),
  qualificationReadiness: OpencodeReadinessConfirmationSchema.optional(),
  qualificationDiagnostic: OpencodeReadinessDiagnosticSchema.optional(),
  fixtureId: z.string().min(1).max(160).optional(),
  repairOperationId: z.string().min(1).max(160).optional(),
  stoppedRepairFault: SyntheticStoppedRepairFaultSchema.optional(),
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

/** Read-only evidence of the captured ordinary Stop, including revoke settlement. */
export const ManagedStopCompletionFactsSchema = z.object({
  soulId: z.string().min(1), incarnationId: z.string().min(1), containerId: z.string().regex(/^[a-f0-9]{64}$/),
  hostBootId: z.string().min(1), nativeSessionId: z.string().min(1), providerStoreId: z.string().min(1),
  intentRevision: z.number().int().nonnegative(), executionGeneration: z.number().int().nonnegative(),
  outcome: ManagedStopResultSchema.shape.outcome.nullable(), settled: z.boolean(), revokePending: z.boolean(),
  view: ManagedRuntimeSoulSchema,
}).strict()
export type ManagedStopCompletionFacts = z.infer<typeof ManagedStopCompletionFactsSchema>

const ORDINARY_STOP_COMPLETION_SCRIPT = String.raw`
import json,sqlite3,sys
c=sqlite3.connect('file:/var/lib/freshell-supervisor/runtime.sqlite3?mode=ro',uri=True,timeout=1)
c.row_factory=sqlite3.Row;c.execute('PRAGMA query_only=ON');c.execute('PRAGMA trusted_schema=OFF');c.execute('BEGIN')
rows=c.execute('SELECT s.soul_id AS soulId,i.incarnation_id AS incarnationId,i.container_id AS containerId,i.host_boot_id AS hostBootId,s.native_session_id AS nativeSessionId,s.provider_store_id AS providerStoreId,p.intent_revision AS intentRevision,p.execution_generation AS executionGeneration,p.outcome,p.settled,p.revoke_pending AS revokePending FROM ordinary_stops p JOIN souls s ON s.soul_id=p.soul_id JOIN incarnations i ON i.incarnation_id=p.incarnation_id AND i.soul_id=s.soul_id WHERE p.soul_id=? AND p.incarnation_id=? AND p.intent_revision=? AND p.execution_generation=? AND s.intent_revision=p.intent_revision AND s.desired_state=\'stopped\' AND i.execution_generation=p.execution_generation',sys.argv[1:]).fetchall()
if len(rows)!=1: raise RuntimeError('current exact Stop transaction is absent or changed')
value=dict(rows[0]);value['settled']=bool(value['settled']);value['revokePending']=bool(value['revokePending']);print(json.dumps(value));c.close()
`

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

type NativeHistoryDiagnostic = { stage: string; reason: string; code: string | null }
const nativeHistoryDiagnosticTuples = new Set([
  ['native_capture', 'filesystem_entry_missing', 'ENOENT'],
  ...['EACCES', 'EPERM'].map(code => ['native_capture', 'permission_denied', code]),
  ...['EISDIR', 'ENOTDIR', 'ELOOP'].map(code => ['native_capture', 'filesystem_shape_refused', code]),
  ['native_capture', 'native_validation_failed', null],
  ['source_selection', 'source_absent_or_ambiguous', null],
  ['source_read', 'incomplete_source_eof', null],
  ['arguments', 'invalid_arguments', null],
].map(tuple => JSON.stringify(tuple)))
const NativeHistoryRefusalSchema = z.object({ severity: z.literal('error'), event: z.literal('provider_native_history.refused'),
  stage: z.string(), reason: z.string(), code: z.string().nullable(),
}).strict().refine(value => nativeHistoryDiagnosticTuples.has(JSON.stringify([value.stage, value.reason, value.code])))

function readNativeHistoryDiagnostic(exitCode: unknown, stdout: string, stderr: string): NativeHistoryDiagnostic {
  if (exitCode === 2 && !stdout && Buffer.byteLength(stderr) <= 1_024) {
    try {
      const { stage, reason, code } = NativeHistoryRefusalSchema.parse(JSON.parse(stderr))
      return { stage, reason, code }
    } catch { /* Unclassified startup failures and invalid output remain unknown. */ }
  }
  return { stage: 'unknown', reason: 'unknown', code: null }
}

class NativeHistoryProbeFailure extends Error {
  constructor(readonly diagnostic: NativeHistoryDiagnostic) { super('owned native history probe failed') }
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

/** How long cleanup waits for Docker to answer requests the broker forwarded:
  * a create can wait tens of seconds for the host to flush its disk. */
const BROKER_SETTLE_MS = 90_000

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

export type RuntimeFixtureInputs = {
  workspaceRoots: string[]
  providerInputRoots?: string[]
  bootstrapFiles: string[]
}

function validateOwnedFixturePath(selected: string, kind: 'directory' | 'file', label: string): string {
  const metadata = fs.lstatSync(selected)
  if (!path.isAbsolute(selected) || path.normalize(selected) !== selected || fs.realpathSync(selected) !== selected
    || !(kind === 'directory' ? metadata.isDirectory() : metadata.isFile()) || metadata.isSymbolicLink()
    || (process.getuid && metadata.uid !== process.getuid())) {
    throw new Error(`${label} must retain its selected owned physical ${kind}`)
  }
  return selected
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


export type Task007RunChild = (file: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; encoding: 'utf8'
  signal?: AbortSignal
}) => Promise<{ stdout: string; stderr: string }>

const runTask007Child: Task007RunChild = (file, args, options) => new Promise((resolve, reject) => {
  const { signal, ...childOptions } = options
  if (signal?.aborted) { reject(new Error('Task7 owner cancelled')); return }
  let forceStop: NodeJS.Timeout | undefined
  // Let an already-issued allocation/start acknowledge before cleanup. Killing
  // its transport can otherwise hide a daemon-side allocation still in progress.
  const settleAllocation = file === 'docker' && (['create', 'start'].includes(args[0])
    || (args[0] === 'volume' && args[1] === 'create'))
  const cancel = () => {
    if (settleAllocation) return
    child.kill('SIGTERM')
    forceStop = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 2_000)
  }
  const child = execFile(file, args, childOptions, (error, stdout, stderr) => {
    signal?.removeEventListener('abort', cancel)
    clearTimeout(forceStop)
    // execFile's callback runs after close, so a cancelled child has actually
    // settled before its owner captures receipts or closes the broker.
    if (error || signal?.aborted) reject(new Task007ChildFailure(signal?.aborted ? 'cancelled' : error?.code ?? undefined, stdout, stderr))
    else resolve({ stdout, stderr })
  })
  signal?.addEventListener('abort', cancel, { once: true })
})

class Task007ChildFailure extends Error {
  constructor(readonly code: string | number | undefined, readonly stdout: string, readonly stderr: string) {
    super(`Task7 owned child failed (${code ?? 'unknown'})`)
  }
}

export type Task007LibTestArtifact = {
  path: string; sha256: string; candidateSha: string; packageId: string; features: string[]; sourcePath: string
}

export const TASK007_EXPORT_TEST = 'loss_report::tests::task007_export_stopped_repair_fixture'

const Task007Id = z.string().min(1).max(160).regex(/^[^\x00-\x1f\x7f]+$/)
const Task007Hex = z.string().regex(/^[a-f0-9]{64}$/)
const Task007TargetInputSchema = z.object({ soulId: Task007Id, providerStoreId: Task007Id,
  terminalId: Task007Id, streamId: Task007Id }).strict()
const Task007ViewLocationSchema = z.object({ viewId: Task007Id, ownerId: Task007Id,
  workspaceId: Task007Id, tabId: Task007Id, paneId: Task007Id }).strict()
export const Task007FixtureInputSchema = z.object({
  schemaVersion: z.literal(1), fixtureId: Task007Id, runId: Task007Id, candidateSha: z.string().regex(/^[a-f0-9]{40}$/),
  installationId: Task007Id, ownerRoot: z.string(), runtimeRoot: z.string(), workspacePath: z.string(), cwd: z.string(),
  gitCommonDir: z.string().nullable().optional(), imageRef: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  hostBinaryPath: z.string(), hostBinarySha256: Task007Hex, dockerDaemonId: Task007Id, brokerSocketPath: z.string(),
  source: z.object({ rootSessionIds: z.array(z.string().regex(/^ses_.+/)).length(7), unrelatedSessionId: z.string().regex(/^ses_.+/) }).strict(),
  targets: z.array(Task007TargetInputSchema).length(9),
  canonicalChoices: z.array(z.object({ rootOrdinal: z.number().int().min(0).max(1), targetOrdinal: z.number().int().min(0).max(8) }).strict()).length(2),
  explicitViews: z.array(Task007ViewLocationSchema.extend({ targetOrdinal: z.number().int().min(0).max(8) }).strict()).length(4),
  unrelated: Task007ViewLocationSchema.extend({ target: Task007TargetInputSchema }).strict(),
}).strict()
export type Task007FixtureInput = z.infer<typeof Task007FixtureInputSchema>
export const Task007FixtureOutputSchema = z.object({
  schemaVersion: z.literal(1), evidenceKind: z.literal('historical-fixture-setup'), fixtureId: Task007Id, runId: Task007Id,
  candidateSha: z.string().regex(/^[a-f0-9]{40}$/), installationId: Task007Id, dockerDaemonId: Task007Id,
  imageRef: z.string().regex(/^sha256:[a-f0-9]{64}$/), hostBinarySha256: Task007Hex, workspacePath: z.string(), runtimeRoot: z.string(),
  registry: z.object({ file: z.literal('runtime.sqlite3'), schemaVersion: z.literal(7), sha256: Task007Hex }).strict(),
  targets: z.array(z.object({ rootSessionId: z.string(), soulId: Task007Id, providerStoreId: Task007Id, incarnationId: Task007Id,
    launchNonce: Task007Id, containerId: Task007Hex, providerVolumeName: z.string().regex(/^freshell-provider-[a-f0-9]{24}$/),
    runtimeDir: z.string(), hostBinaryPath: z.string(), immutableConfigDigest: z.string().min(1), incidentId: Task007Id,
    expectedIntentRevision: z.number().int().nonnegative(), viewIds: z.array(Task007Id) }).strict()).length(9),
  canonicalChoices: z.array(z.object({ rootSessionId: z.string(), soulId: Task007Id, expectedIntentRevision: z.number().int().nonnegative() }).strict()).length(2),
  unrelated: z.object({ soulId: Task007Id, incidentId: Task007Id, viewId: Task007Id,
    expectedIntentRevision: z.number().int().nonnegative(), noticeIds: z.array(Task007Id), outboxEventIds: z.array(Task007Id),
    exports: z.array(z.object({ file: z.string(), sha256: Task007Hex }).strict()) }).strict(),
  historicalControlEpoch: z.number().int().nonnegative(),
}).strict()
export type Task007FixtureOutput = z.infer<typeof Task007FixtureOutputSchema>
export type Task007StoppedFixtureKind = 'browser' | 'after_import_publication' | 'after_repair_cas_before_withdrawal' | 'during_withdrawal_before_ack'
export type Task007PreparedStoppedFixture = {
  input: Task007FixtureInput; output: Task007FixtureOutput; source: SyntheticSevenRootSource;
  inputFile: string; outputDir: string; metadataFile: string; sourceDatabaseFile: string; registryRoot: string;
  scenarioId: string; volumeName?: string
}

const Task007FamilyFactsSchema = z.object({ rootId: Task007Id, childId: Task007Id, grandchildId: Task007Id,
  baselineMessages: z.record(z.string(), Task007Hex), baselineParts: z.record(z.string(), Task007Hex) }).strict()
const Task007ActivitySchema = z.object({ setupHelpersCompleted: z.number().int().nonnegative(),
  helperStartRequests: z.number().int().nonnegative(), providerContainerStartRequests: z.number().int().nonnegative(),
  providerLaunchRunningEvents: z.number().int().nonnegative() }).strict()
export const SyntheticStoppedRepairBatchFactsSchema = z.object({ fixtureId: Task007Id, sourceStoreId: Task007Hex,
  activity: Task007ActivitySchema,
  families: z.array(Task007FamilyFactsSchema).length(7),
  targets: z.array(z.object({ soulId: Task007Id, providerStoreId: Task007Id, rootSessionId: Task007Id,
    terminalId: Task007Id, streamId: Task007Id, incidentId: Task007Id, viewIds: z.array(Task007Id) }).strict()).length(9),
  canonicalChoices: z.array(z.object({ rootSessionId: Task007Id, soulId: Task007Id }).strict()).length(2),
  unrelated: z.object({ soulId: Task007Id, incidentId: Task007Id, viewId: Task007Id,
    noticeIds: z.array(Task007Id), outboxEventIds: z.array(Task007Id), exportSha256: z.array(Task007Hex) }).strict(),
}).strict()
export type SyntheticStoppedRepairBatchFacts = z.infer<typeof SyntheticStoppedRepairBatchFactsSchema>
// These are the existing native reader's bindings, not a second row verifier.
const Task007ReaderReceiptSchema = z.object({ version: z.literal(1), transferId: Task007Id,
  destinationStoreId: Task007Id, rootSessionId: Task007Id, sourceGeneration: Task007Hex,
  targetImageRef: z.string().regex(/^sha256:[a-f0-9]{64}$/), targetBuildReceipt: Task007Hex,
  providerUid: z.number().int().nonnegative(), providerGid: z.number().int().nonnegative(),
  home: z.string(), xdgDataHome: z.string(), xdgConfigHome: z.string(), opencodeDb: z.string(), cwd: z.string(),
  rowCount: z.number().int().nonnegative(), assetCount: z.number().int().nonnegative(), structuralSha256: Task007Hex,
}).passthrough()
const Task007DescriptorSchema = z.object({ transferId: Task007Id, sourceStoreId: Task007Hex,
  rootSessionId: Task007Id, sourceGeneration: Task007Hex, destinationStoreId: Task007Id,
  destinationDatabasePath: z.literal('.local/share/opencode/opencode.db'), targetImageRef: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  targetBuildReceipt: Task007Hex, sourceSchemaFingerprint: Task007Hex, migrationJournalFingerprint: Task007Hex,
  manifestJson: z.string().max(512 * 1024), bundleSha256: Task007Hex,
}).passthrough()
const Task007ReadableBaselineSchema = z.object({ destinationStoreId: Task007Id,
  providerUid: z.number().int().nonnegative(), providerGid: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative(), assetCount: z.number().int().nonnegative(), structuralSha256: Task007Hex,
  readerEnvironmentSha256: Task007Hex, bundleSha256: Task007Hex,
}).strict()
export function task007ValidateInstalledRead(descriptorValue: unknown, baselineValue: unknown, freshValue: unknown) {
  const descriptor = Task007DescriptorSchema.parse(descriptorValue)
  const baseline = Task007ReadableBaselineSchema.parse(baselineValue)
  const fresh = Task007ReaderReceiptSchema.parse(freshValue)
  if (baseline.destinationStoreId !== descriptor.destinationStoreId || baseline.bundleSha256 !== descriptor.bundleSha256) {
    throw new Error('reader baseline differs from original descriptor')
  }
  for (const key of ['transferId', 'destinationStoreId', 'rootSessionId', 'sourceGeneration', 'targetImageRef', 'targetBuildReceipt'] as const) {
    if (fresh[key] !== descriptor[key]) throw new Error(`fresh reader differs from original descriptor: ${key}`)
  }
  for (const key of ['destinationStoreId', 'providerUid', 'providerGid', 'rowCount', 'assetCount', 'structuralSha256'] as const) {
    if (fresh[key] !== baseline[key]) throw new Error(`fresh reader differs from original baseline: ${key}`)
  }
  // Match the production receipt's explicit field order (serde_json preserve_order).
  const environment = Object.fromEntries(['providerUid', 'providerGid', 'home', 'xdgDataHome', 'xdgConfigHome', 'opencodeDb', 'cwd']
    .map(key => [key, fresh[key]]))
  if (sha256(JSON.stringify(environment)) !== baseline.readerEnvironmentSha256) throw new Error('fresh reader environment differs from original baseline')
  return fresh
}
const Task007RepairSoulSchema = z.object({ soulId: Task007Id, providerStoreId: Task007Id,
  nativeSessionId: Task007Id.nullable(), desiredState: z.string(), recoveryState: z.string(),
  identityRevision: z.number().int().nonnegative(), intentRevision: z.number().int().nonnegative(),
  nativeImportRevision: z.number().int().nonnegative(), activeWriters: z.number().int().nonnegative(),
  writerClaims: z.array(z.object({ soulId: Task007Id, incarnationId: Task007Id,
    intentRevision: z.number().int().nonnegative(), provider: Task007Id, providerStoreId: Task007Id,
    nativeSessionId: Task007Id }).strict()),
  incidentPresent: z.boolean(), exportPresent: z.array(z.boolean()).length(2) }).strict()
const Task007InstalledGraphSchema = z.object({ parents: z.record(Task007Id, Task007Id.nullable())
  .refine(parents => Object.keys(parents).length <= 1024), history: SyntheticOpenCodeHistoryFactsSchema,
  excludedSourceSentinels: z.array(z.enum(EXCLUDED_SOURCE_SENTINELS)) }).strict()
const Task007SafeAdoptionSchema = z.discriminatedUnion('state', [
  z.object({ state: z.enum(['not_required', 'awaiting_observation']) }).strict(),
  z.object({ state: z.literal('observed'), terminalId: Task007Id, rootSessionId: Task007Id,
    tailMessageId: Task007Id.nullable(), evidenceGeneration: Task007Hex, incarnationId: Task007Id,
    launchNonceSha256: Task007Hex, hydrated: z.boolean(), messagesRead: z.enum(['success', 'empty_confirmed', 'failed']) }).strict(),
])
export const TASK007_HOST_ADOPTION_PROBE = `
const { readHostAdoptionStatus } = require(process.argv[1]);
readHostAdoptionStatus(process.argv[2], process.argv[3], process.argv[4]).then(
  status => process.stdout.write(JSON.stringify(status)),
  error => {
    if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) process.stdout.write(JSON.stringify({ state: 'unavailable' }));
    else { process.stderr.write(String(error)); process.exitCode = 1; }
  }
);
`
const Task007NativeObservationSchema = z.discriminatedUnion('state', [
  z.object({ rootSessionId: Task007Id, canonicalSoulId: Task007Id, state: z.literal('unavailable'),
    reason: z.enum(['stopped', 'host_unavailable']) }).strict(),
  z.object({ rootSessionId: Task007Id, canonicalSoulId: Task007Id, state: z.literal('current'),
    incarnationId: Task007Id, containerId: Task007Hex, hostBootId: Task007Id, terminalId: Task007Id,
    intentRevision: z.number().int().nonnegative(), nativeImportRevision: z.number().int().nonnegative(),
    executionGeneration: z.number().int().nonnegative(), evidenceRevision: z.number().int().nonnegative(),
    launchState: Task007Id, recoveryState: Task007Id, hostStatus: Task007SafeAdoptionSchema,
    registryNativeObservation: ManagedRuntimeNativeIdentityObservationSchema.omit({ launchNonce: true })
      .extend({ launchNonceSha256: Task007Hex }).strict().nullable() }).strict(),
])
const Task007CurrentIncarnationSchema = z.object({ soulId: Task007Id, incarnationId: Task007Id,
  launchNonce: Task007Id, containerId: Task007Hex.nullable(), hostBootId: Task007Id.nullable(),
  launchState: Task007Id, executionGeneration: z.number().int().nonnegative() }).strict()
type Task007CurrentIncarnation = z.infer<typeof Task007CurrentIncarnationSchema>
const Task007CrashPointSchema = z.enum(['stopped_repair_after_import_publication',
  'stopped_repair_after_repair_cas_before_withdrawal', 'stopped_repair_during_withdrawal_before_ack'])
const Task007FaultMarkersSchema = z.object({ preset: SyntheticStoppedRepairFaultSchema, supervisorContainerId: Task007Hex,
  crash: z.object({ point: Task007CrashPointSchema, running: z.boolean(), exitCode: z.number().int() }).strict().nullable(),
  firstResumeObservationFailures: z.array(z.object({ soulId: Task007Id, incarnationId: Task007Id,
    executionGeneration: z.number().int().positive() }).strict()).max(9) }).strict()
const Task007RepairRootSchema = z.object({ rootSessionId: Task007Id, canonicalSoulId: Task007Id, destinationStoreId: Task007Id,
    sourceSchemaFingerprint: Task007Hex, migrationJournalFingerprint: Task007Hex,
    sourceGeneration: Task007Id, transferId: Task007Id, rowCount: z.number().int().nonnegative(),
    assetCount: z.number().int().nonnegative(), structuralSha256: Task007Hex,
    providerUid: z.number().int().nonnegative(), providerGid: z.number().int().nonnegative(),
    readerEnvironmentSha256: Task007Hex, adoptionBaselineSha256: Task007Hex }).strict()
export const SyntheticStoppedRepairBatchObservationSchema = z.object({ fixtureId: Task007Id, operationId: Task007Id,
  activity: Task007ActivitySchema, faultMarkers: Task007FaultMarkersSchema,
  controlEpoch: z.number().int().nonnegative(), scope: ManagedRuntimeRepairBatchScopeSchema,
  canonicalChoices: z.array(z.object({ rootSessionId: Task007Id, soulId: Task007Id,
    expectedIntentRevision: z.number().int().positive() }).strict()).length(2),
  status: z.enum(['importing', 'withdraw_pending', 'complete']), withdrawalStatus: z.enum(['files_pending', 'files_complete']).nullable(),
  souls: z.array(Task007RepairSoulSchema).length(9),
  roots: z.array(Task007RepairRootSchema).max(7),
  unrelated: z.object({ incidentPresent: z.boolean(), viewPresent: z.boolean(), noticeIds: z.array(Task007Id),
    outboxEventIds: z.array(Task007Id), exportSha256: z.array(Task007Hex.nullable()) }).strict(),
  installedStores: z.array(z.object({ rootSessionId: Task007Id, providerStoreId: Task007Id,
    providerUid: z.literal(65534), providerGid: z.literal(0), providerVersion: Task007Id,
    generation: Task007Id, sourceSchemaFingerprint: Task007Id, migrationJournalFingerprint: Task007Id,
    rowCount: z.number().int().nonnegative(), readable: Task007ReaderReceiptSchema }).extend(Task007InstalledGraphSchema.shape).strict()).max(7),
  nativeObservations: z.array(Task007NativeObservationSchema).max(7),
}).strict()
const Task007RepairRecordsSchema = SyntheticStoppedRepairBatchObservationSchema.omit({ installedStores: true, nativeObservations: true,
  activity: true, faultMarkers: true })
  .extend({ currentIncarnations: z.array(Task007CurrentIncarnationSchema).max(9),
    roots: z.array(Task007RepairRootSchema.omit({
      sourceSchemaFingerprint: true, migrationJournalFingerprint: true }).extend({
      descriptor: Task007DescriptorSchema, readable: Task007ReadableBaselineSchema,
    }).strict().transform(({ descriptor, readable, ...root }) => {
      const manifest = z.object({ generation: z.literal(root.sourceGeneration), source_store_id: z.literal(descriptor.sourceStoreId),
        root_session_id: z.literal(root.rootSessionId), source_schema_fingerprint: z.literal(descriptor.sourceSchemaFingerprint),
        migration_journal_fingerprint: z.literal(descriptor.migrationJournalFingerprint) }).parse(JSON.parse(descriptor.manifestJson))
      const generationField = `"generation":"${manifest.generation}"`
      if (!descriptor.manifestJson.endsWith(`${generationField}}`)
        || sha256(descriptor.manifestJson.slice(0, -generationField.length - 1) + '"generation":""}') !== manifest.generation) {
        throw new Error('captured source manifest generation differs from immutable content')
      }
      if (descriptor.rootSessionId !== root.rootSessionId || descriptor.destinationStoreId !== root.destinationStoreId
        || descriptor.transferId !== root.transferId || descriptor.sourceGeneration !== root.sourceGeneration
        || readable.rowCount !== root.rowCount || readable.assetCount !== root.assetCount
        || readable.structuralSha256 !== root.structuralSha256 || readable.providerUid !== root.providerUid
        || readable.providerGid !== root.providerGid || readable.readerEnvironmentSha256 !== root.readerEnvironmentSha256
        || readable.bundleSha256 !== descriptor.bundleSha256) throw new Error('private descriptor/receipt differs from operation root')
      return { ...root, descriptor, readable,
        sourceSchemaFingerprint: manifest.source_schema_fingerprint, migrationJournalFingerprint: manifest.migration_journal_fingerprint }
    })).max(7),
  }).strict()
export type SyntheticStoppedRepairBatchObservation = z.infer<typeof SyntheticStoppedRepairBatchObservationSchema>

// Fixed owner-only read of current production records; browser supplies IDs,
// never a query, database path, command, or historical evidence object.
export const TASK007_STOPPED_REPAIR_OBSERVATION = String.raw`
import hashlib,json,os,sqlite3,sys
database,metadata,operation,export_root,source_store=sys.argv[1:6]
fixture=json.load(open(metadata))
c=sqlite3.connect('file:'+database+'?mode=ro',uri=True)
c.row_factory=sqlite3.Row
c.execute('PRAGMA query_only=ON')
c.execute('BEGIN')
op=c.execute('SELECT status,targets_json,scope_json,owner_choices_json,result_json FROM stopped_repair_operations WHERE operation_id=?',(operation,)).fetchone()
if op is None: raise RuntimeError('registered repair operation is absent')
expected={t['soulId']:t for t in fixture['targets']}
targets=json.loads(op['targets_json']);scope=json.loads(op['scope_json']);choices=json.loads(op['owner_choices_json'])
def exact_targets(items):
    if len(items)!=9 or len({t['soulId'] for t in items})!=9: return False
    return all(t['soulId'] in expected and t['incidentId']==expected[t['soulId']]['incidentId'] and t['expectedIntentRevision']==expected[t['soulId']]['expectedIntentRevision'] for t in items)
if not exact_targets(targets): raise RuntimeError('repair operation targets or incidents differ from registered fixture')
if scope['sourceStoreId']!=source_store or not exact_targets([t['target'] for t in scope['targets']]): raise RuntimeError('repair source or captured targets differ from registered fixture')
if any(t['providerStoreId']!=expected[t['target']['soulId']]['providerStoreId'] or t['rootSessionId']!=expected[t['target']['soulId']]['rootSessionId'] for t in scope['targets']): raise RuntimeError('captured repair store/root differs from registered fixture')
roots_by_id={r['rootSessionId']:r for r in scope['roots']}
if len(scope['roots'])!=7 or set(roots_by_id)!={t['rootSessionId'] for t in fixture['targets']}: raise RuntimeError('captured repair roots differ from registered fixture')
for r in scope['roots']:
    eligible={t['soulId'] for t in fixture['targets'] if t['rootSessionId']==r['rootSessionId']}
    if len(r['eligibleOwners'])!=len(eligible) or set(r['eligibleOwners'])!=eligible: raise RuntimeError('repair eligible owners differ from registered fixture')
ambiguous={r['rootSessionId'] for r in scope['roots'] if r['canonicalSoulId'] is None}
if len(choices)!=2 or {choice['rootSessionId'] for choice in choices}!=ambiguous: raise RuntimeError('repair canonical choices differ from captured scope')
canonicals={r['rootSessionId']:r['canonicalSoulId'] for r in scope['roots']}
for choice in choices:
    r=roots_by_id[choice['rootSessionId']];t=expected.get(choice['soulId'])
    if choice['soulId'] not in r['eligibleOwners'] or t is None or choice['expectedIntentRevision']!=t['expectedIntentRevision']: raise RuntimeError('selected canonical owner is not eligible')
    canonicals[choice['rootSessionId']]=choice['soulId']
if any(canonicals[r['rootSessionId']] not in r['eligibleOwners'] for r in scope['roots']): raise RuntimeError('captured canonical owner is not eligible')
def present(table,key,value): return c.execute('SELECT EXISTS(SELECT 1 FROM '+table+' WHERE '+key+'=?)',(value,)).fetchone()[0]==1
def digest(value): return hashlib.sha256(value).hexdigest()
def file_hash(relative):
    file=os.path.realpath(os.path.join(export_root,relative))
    if not file.startswith(os.path.realpath(export_root)+os.sep): raise RuntimeError('export is outside registered fixture')
    return digest(open(file,'rb').read()) if os.path.isfile(file) else None
souls=[];current_incarnations=[]
for target in fixture['targets']:
    row=c.execute('SELECT soul_id,provider_store_id,native_session_id,desired_state,recovery_state,identity_revision,intent_revision,native_import_revision FROM souls WHERE soul_id=?',(target['soulId'],)).fetchone()
    if row is None: raise RuntimeError('registered repair soul is absent')
    writers=[dict(soulId=w['soul_id'],incarnationId=w['incarnation_id'],intentRevision=w['intent_revision'],provider=w['provider'],providerStoreId=w['provider_store_id'],nativeSessionId=w['native_session_id']) for w in c.execute("SELECT * FROM writer_claims WHERE soul_id=? OR (provider='opencode' AND provider_store_id=? AND native_session_id=?) ORDER BY soul_id,incarnation_id",(target['soulId'],row['provider_store_id'],row['native_session_id']))]
    souls.append(dict(soulId=row['soul_id'],providerStoreId=row['provider_store_id'],nativeSessionId=row['native_session_id'],desiredState=row['desired_state'],recoveryState=row['recovery_state'],identityRevision=row['identity_revision'],intentRevision=row['intent_revision'],nativeImportRevision=row['native_import_revision'],activeWriters=len(writers),writerClaims=writers,incidentPresent=present('loss_incidents','incident_id',target['incidentId']),exportPresent=[os.path.isfile(os.path.join(export_root,'incidents',target['incidentId']+'.'+suffix+'.json')) for suffix in ['open','closed']]))
    current=c.execute("SELECT * FROM incarnations WHERE soul_id=? ORDER BY CASE WHEN launch_state IN ('prepared','created','starting','running','stopping') THEN 0 ELSE 1 END,created_at DESC,rowid DESC LIMIT 1",(row['soul_id'],)).fetchone()
    if current: current_incarnations.append(dict(soulId=row['soul_id'],incarnationId=current['incarnation_id'],launchNonce=current['launch_nonce'],containerId=current['container_id'],hostBootId=current['host_boot_id'],launchState=current['launch_state'],executionGeneration=current['execution_generation']))
roots=[];completed_roots=[]
for row in c.execute('SELECT root_session_id,canonical_soul_id,source_store_id,source_generation,identity_revision,intent_revision,native_import_revision,transfer_id,import_receipt_json,readable_receipt_json FROM stopped_repair_root_receipts WHERE operation_id=? ORDER BY root_session_id',(operation,)):
    imported=json.loads(row['import_receipt_json']);readable=json.loads(row['readable_receipt_json'])
    if row['root_session_id'] not in canonicals or row['canonical_soul_id']!=canonicals[row['root_session_id']]: raise RuntimeError('installed canonical differs from selected operation')
    if row['source_generation']!=roots_by_id[row['root_session_id']]['graphDigest']: raise RuntimeError('installed source generation differs from captured scope')
    captured=next(t for t in scope['targets'] if t['target']['soulId']==row['canonical_soul_id'])
    if row['source_store_id']!=source_store or row['identity_revision']!=captured['identityRevision'] or row['intent_revision']!=captured['target']['expectedIntentRevision'] or row['native_import_revision']!=captured['nativeImportRevision']: raise RuntimeError('installed source or captured revisions differ from operation scope')
    if readable['destinationStoreId']!=expected[row['canonical_soul_id']]['providerStoreId']: raise RuntimeError('installed destination differs from selected owner')
    descriptor=imported['adoption_baseline']['descriptor']
    if descriptor['sourceStoreId']!=row['source_store_id'] or descriptor['sourceGeneration']!=row['source_generation'] or descriptor['rootSessionId']!=row['root_session_id'] or descriptor['destinationStoreId']!=readable['destinationStoreId'] or descriptor['destinationDatabasePath']!='.local/share/opencode/opencode.db': raise RuntimeError('immutable adoption descriptor differs from registered source/root/destination')
    for key in ['transfer_id','root_session_id','destination_store_id','source_store_id','source_generation','source_schema_fingerprint','migration_journal_fingerprint','target_image_ref','target_build_receipt','bundle_sha256']:
        camel=''.join([key.split('_')[0]]+[word.title() for word in key.split('_')[1:]])
        if imported[key]!=descriptor[camel]: raise RuntimeError('original import receipt differs from descriptor')
    for key in ['provider_uid','provider_gid','row_count','asset_count','structural_sha256','reader_environment_sha256','bundle_sha256']:
        camel=''.join([key.split('_')[0]]+[word.title() for word in key.split('_')[1:]])
        if imported[key]!=readable[camel]: raise RuntimeError('original import and readability receipts differ')
    if imported['adoption_baseline']['manifestSha256']!=digest(descriptor['manifestJson'].encode()): raise RuntimeError('immutable baseline manifest digest differs')
    if imported['canonical_soul_id']!=row['canonical_soul_id']: raise RuntimeError('original import canonical owner differs')
    for key in ['identity_revision','intent_revision','native_import_revision']:
        if imported['captured_'+key]!=row[key]: raise RuntimeError('original import captured revisions differ')
    manifest=json.loads(descriptor['manifestJson'])
    if manifest['source_store_id']!=row['source_store_id'] or manifest['root_session_id']!=row['root_session_id']: raise RuntimeError('immutable manifest differs from source/root')
    roots.append(dict(rootSessionId=row['root_session_id'],canonicalSoulId=row['canonical_soul_id'],destinationStoreId=readable['destinationStoreId'],descriptor=descriptor,readable=readable,sourceGeneration=row['source_generation'],transferId=row['transfer_id'],rowCount=readable['rowCount'],assetCount=readable['assetCount'],structuralSha256=readable['structuralSha256'],providerUid=readable['providerUid'],providerGid=readable['providerGid'],readerEnvironmentSha256=readable['readerEnvironmentSha256'],adoptionBaselineSha256=digest(json.dumps(imported['adoption_baseline'],sort_keys=True,separators=(',',':')).encode())))
    completed_roots.append(dict(rootSessionId=row['root_session_id'],canonicalSoulId=row['canonical_soul_id'],importStatus='complete',intentRevision=row['intent_revision'],nativeImportRevision=row['native_import_revision']+1))
withdrawal=c.execute('SELECT status FROM stopped_repair_withdrawals WHERE operation_id=?',(operation,)).fetchone()
# Completion atomically removes the work marker and saves the qualified result.
# An absent marker by itself says nothing about whether withdrawal completed.
withdrawal_status=None
if op['status']=='complete':
    if withdrawal is not None or op['result_json'] is None: raise RuntimeError('completed repair has contradictory withdrawal state or missing saved result')
    saved=json.loads(op['result_json'])
    if (not isinstance(saved,dict) or saved.get('operationId')!=operation
        or saved.get('scopeId')!=scope['scopeId'] or saved.get('status')!='complete'
        or saved.get('repairedTargetCount')!=len(targets) or saved.get('totalTargetCount')!=len(targets)):
        raise RuntimeError('saved completed repair differs from current operation/scope/targets')
    saved_roots=saved.get('roots')
    if not isinstance(saved_roots,list) or any(not isinstance(root,dict) for root in saved_roots): raise RuntimeError('saved completed repair roots are invalid')
    fields=['rootSessionId','canonicalSoulId','importStatus','intentRevision','nativeImportRevision']
    saved_roots=[{key:root.get(key) for key in fields} for root in saved_roots]
    if (len(completed_roots)!=len(roots_by_id)
        or {root['rootSessionId'] for root in completed_roots}!=set(roots_by_id)
        or sorted(saved_roots,key=lambda root:str(root['rootSessionId']))!=completed_roots):
        raise RuntimeError('saved completed repair roots differ from current captured receipts')
    withdrawal_status='files_complete'
elif op['status']=='withdraw_pending':
    if withdrawal is None or withdrawal['status']!='files_pending' or op['result_json'] is not None: raise RuntimeError('pending repair has missing or contradictory withdrawal authority')
    withdrawal_status='files_pending'
elif op['status']!='importing' or withdrawal is not None or op['result_json'] is not None:
    raise RuntimeError('repair operation has contradictory withdrawal state')
unrelated=fixture['unrelated']
epoch=c.execute('SELECT control_epoch FROM installation WHERE singleton=1').fetchone()[0]
result=dict(fixtureId=fixture['fixtureId'],operationId=operation,controlEpoch=epoch,scope=scope,canonicalChoices=choices,status=op['status'],withdrawalStatus=withdrawal_status,souls=souls,roots=roots,currentIncarnations=current_incarnations,unrelated=dict(incidentPresent=present('loss_incidents','incident_id',unrelated['incidentId']),viewPresent=present('view_intents','view_id',unrelated['viewId']),noticeIds=[id for id in unrelated['noticeIds'] if present('runtime_notices','notice_id',id)],outboxEventIds=[id for id in unrelated['outboxEventIds'] if present('outbox','event_id',id)],exportSha256=[file_hash(artifact['file']) for artifact in unrelated['exports']]))
c.close()
print(json.dumps(result))
`

// Only the known-stopped reader takes a snapshot. Committed SQLite state can
// still live in the WAL; a private writable directory lets SQLite rebuild its
// derived SHM index without writing to the read-only Registry volume.
export const TASK007_STOPPED_REGISTRY_OBSERVATION = String.raw`
import os,shutil,sys,tempfile
with tempfile.TemporaryDirectory(prefix='freshell-registry-read-') as snapshot:
    source_database=sys.argv[1]
    snapshot_database=os.path.join(snapshot,'runtime.sqlite3')
    shutil.copyfile(source_database,snapshot_database)
    if os.path.isfile(source_database+'-wal'):
        shutil.copyfile(source_database+'-wal',snapshot_database+'-wal')
    sys.argv[1]=snapshot_database
` + TASK007_STOPPED_REPAIR_OBSERVATION.split('\n').map(line => `    ${line}`).join('\n')

const TASK007_PROVIDER_HOME_INITIALIZER = `import json, os, stat
fd = os.open("/home/freshell/provider", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    before = os.fstat(fd)
    if not stat.S_ISDIR(before.st_mode) or (before.st_uid, before.st_gid) != (0, 0):
        raise RuntimeError("fixture volume is not a new root-owned directory")
    if os.listdir(fd):
        raise RuntimeError("fixture volume is not empty")
    os.fchmod(fd, 0o700)
    os.fchown(fd, 65534, 0)
    os.fsync(fd)
    after = os.fstat(fd)
    if (after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode)) != (65534, 0, 0o700):
        raise RuntimeError("fixture HOME handoff did not complete")
    print(json.dumps({"kind":"historical-fixture-home-setup","uid":65534,"gid":0,"mode":448,"priorEntries":0}))
finally:
    os.close(fd)
`

export async function initializeTask007ProviderHome(options: {
  input: Pick<Task007FixtureInput, 'runId' | 'candidateSha' | 'imageRef' | 'installationId'>;
  target: Task007FixtureOutput['targets'][number]; receipt: BrokerReceipt; name: string
}, execute: Task007RunChild = runTask007Child): Promise<{ containerId: string; uid: 65534; gid: 0; mode: 448; priorEntries: 0 }> {
  const { input, target, receipt, name } = options
  if (!/^freshell-task007-setup-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(name)
    || target.containerId !== receipt.containerId || target.soulId !== receipt.soulId
    || target.incarnationId !== receipt.incarnationId || input.imageRef !== receipt.imageRef
    || target.runtimeDir !== receipt.runtimeDir || target.hostBinaryPath !== receipt.hostBinaryPath
    || target.providerVolumeName !== receipt.providerVolumeName) throw new Error('Task7 HOME setup receipt binding refused')
  const command = (args: string[]) => execute('docker', args, {
    cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: os.homedir(),
      ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) },
    timeout: 60_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
  })
  const inspected = z.array(z.object({ Id: z.string(), Image: z.string(),
    State: z.object({ Status: z.string(), Running: z.boolean(), Pid: z.number() }),
    Config: z.object({ Labels: z.record(z.string(), z.string()) }),
    Mounts: z.array(z.object({ Type: z.string(), Name: z.string().optional(), Destination: z.string(), RW: z.boolean() })),
  })).length(1).parse(JSON.parse((await command(['inspect', receipt.containerId])).stdout))[0]
  const labels = inspected.Config.Labels
  const homeMounts = inspected.Mounts.filter(mount => mount.Destination === '/home/freshell/provider')
  if (inspected.Id !== receipt.containerId || inspected.Image !== input.imageRef
    || inspected.State.Status !== 'created' || inspected.State.Running || inspected.State.Pid !== 0
    || labels['com.freshell.runtime-test-run-id'] !== input.runId || labels['com.freshell.soul-id'] !== target.soulId
    || labels['com.freshell.incarnation-id'] !== target.incarnationId
    || labels['com.freshell.installation-id'] !== input.installationId
    || homeMounts.length !== 1 || homeMounts[0].Type !== 'volume' || homeMounts[0].Name !== target.providerVolumeName
    || !homeMounts[0].RW) throw new Error('Task7 HOME setup requires the exact never-started Created enclosure')
  const names = (await command(['ps', '-a', '--format', '{{.Names}}'])).stdout.trim().split('\n')
  if (names.includes(name)) throw new Error('Task7 HOME setup helper name already exists')
  let helperId: string | undefined
  try {
    const containerId = (await command(['create', '--name', name, '--user', '0:0', '--workdir', '/',
      '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--security-opt', 'no-new-privileges',
      '--memory', '256m', '--memory-swap', '256m', '--cpus', '0.5', '--pids-limit', '32',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m', '--label', `com.freshell.runtime-test-run-id=${input.runId}`,
      '--label', `com.freshell.runtime-test-candidate=${input.candidateSha}`, '--label', 'com.freshell.task007-setup=provider-home',
      '--label', `com.freshell.owner-container-id=${target.containerId}`, '--mount',
      `type=volume,source=${target.providerVolumeName},target=/home/freshell/provider,volume-nocopy`,
      '--entrypoint', 'python3', input.imageRef, '-I', '-c', TASK007_PROVIDER_HOME_INITIALIZER])).stdout.trim()
    if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('Task7 HOME helper create returned no exact container')
    helperId = containerId
    await command(['start', containerId])
    if ((await command(['wait', containerId])).stdout.trim() !== '0') throw new Error('Task7 HOME initialization failed')
    const facts = z.object({ kind: z.literal('historical-fixture-home-setup'), uid: z.literal(65534), gid: z.literal(0),
      mode: z.literal(448), priorEntries: z.literal(0) }).strict().parse(JSON.parse((await command(['logs', containerId])).stdout))
    return { containerId, uid: facts.uid, gid: facts.gid, mode: facts.mode, priorEntries: facts.priorEntries }
  } finally {
    if (helperId) await command(['rm', '--force', helperId])
    else {
      const remaining = (await command(['ps', '-a', '--format', '{{.Names}}'])).stdout.trim().split('\n')
      if (remaining.includes(name)) {
        const discovered = z.array(z.object({ Id: Task007Hex, Image: z.string(),
          Config: z.object({ Labels: z.record(z.string(), z.string()) }),
          Mounts: z.array(z.object({ Type: z.string(), Name: z.string().optional(), Destination: z.string() })),
        })).length(1).parse(JSON.parse((await command(['inspect', name])).stdout))[0]
        if (discovered.Image !== input.imageRef || discovered.Config.Labels['com.freshell.runtime-test-run-id'] !== input.runId
          || discovered.Config.Labels['com.freshell.owner-container-id'] !== target.containerId
          || discovered.Config.Labels['com.freshell.task007-setup'] !== 'provider-home'
          || discovered.Mounts.length !== 1 || discovered.Mounts[0].Type !== 'volume'
          || discovered.Mounts[0].Name !== target.providerVolumeName || discovered.Mounts[0].Destination !== '/home/freshell/provider') {
          throw new Error('Task7 lost-ACK HOME helper ownership is unknown')
        }
        await command(['rm', '--force', discovered.Id])
      }
    }
  }
}

function assertTask007PrivatePath(file: string, directory: boolean, mode: number): void {
  const stat = fs.lstatSync(file)
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== file || stat.uid !== process.getuid?.()
    || (stat.mode & 0o777) !== mode || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error('Task7 fixture path is not canonical private owner custody')
  }
}

function task007FileHash(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export const TASK007_HISTORICAL_SNAPSHOT_INSTALLER = `import hashlib, json, os, sqlite3, stat, sys, urllib.parse
source, destination, expected_hash = sys.argv[1:]
for directory in (source, destination):
    metadata = os.lstat(directory)
    if os.path.realpath(directory) != directory or not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) != 0o700:
        raise RuntimeError("snapshot directory is not canonical private owner custody")
if os.listdir(destination):
    raise RuntimeError("historical snapshot destination is nonempty, not fresh")
database = os.path.join(source, "runtime.sqlite3")
for suffix in ("-wal", "-shm", "-journal"):
    if os.path.lexists(database + suffix) and os.lstat(database + suffix).st_size:
        raise RuntimeError("historical snapshot has active WAL/checkpoint dependency")
files = {}
incidents = os.path.join(source, "incidents")
incident_metadata = os.lstat(incidents)
if not stat.S_ISDIR(incident_metadata.st_mode) or incident_metadata.st_uid != os.geteuid() or stat.S_IMODE(incident_metadata.st_mode) != 0o700:
    raise RuntimeError("historical incident directory is not private")
incident_files = [os.path.join("incidents", name) for name in sorted(os.listdir(incidents))]
for name in ("runtime.sqlite3", "lifecycle.jsonl", "metadata.json", *incident_files):
    file = os.path.join(source, name)
    metadata = os.lstat(file)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) != 0o600:
        raise RuntimeError("historical snapshot file is not private and regular")
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(fd, "rb", closefd=False) as reader:
            files[name] = reader.read(67108865)
        if len(files[name]) > 67108864:
            raise RuntimeError("historical snapshot file exceeds fixture bound")
    finally:
        os.close(fd)
digest = hashlib.sha256(files["runtime.sqlite3"]).hexdigest()
if digest != expected_hash:
    raise RuntimeError("historical snapshot database digest changed")
connection = sqlite3.connect("file:" + urllib.parse.quote(database) + "?mode=ro&immutable=1", uri=True)
try:
    if connection.execute("SELECT schema_version FROM installation WHERE singleton=1").fetchall() != [(7,)]:
        raise RuntimeError("historical snapshot is not schema-seven")
    removed = {"ordinary_stops", "recovery_retries", "stopped_repair_root_receipts", "stopped_repair_withdrawals", "stopped_repair_operations", "native_origin_owners", "cancel_recovery_retry_on_intent"}
    if removed.intersection(row[0] for row in connection.execute("SELECT name FROM sqlite_master")):
        raise RuntimeError("historical schema-seven retains post-7 tables or trigger")
    absent_columns = {
        "souls": {"identity_revision", "native_import_revision", "native_import_state", "native_import_source_store_id", "native_import_root_session_id", "native_import_source_generation", "native_import_schema_fingerprint", "native_import_migration_fingerprint", "native_import_complete_inventory", "native_import_authority", "claude_fork_recipe"},
        "loss_incidents": {"captured_control_epoch", "captured_identity_revision", "captured_evidence_revision", "captured_native_import_revision", "captured_native_import_state", "captured_source_store_id", "captured_root_session_id", "captured_source_generation", "captured_source_schema_fingerprint", "captured_migration_fingerprint", "captured_native_import_complete", "captured_native_import_authority"},
        "incarnations": {"launch_policy", "native_identity_launch", "native_identity_observation"}
    }
    for table, absent in absent_columns.items():
        columns = {row[1] for row in connection.execute("PRAGMA table_info(" + table + ")")}
        if not columns or absent.intersection(columns):
            raise RuntimeError("historical schema-seven retains post-7 columns")
finally:
    connection.close()
os.mkdir(os.path.join(destination, "incidents"), 0o700)
for name, data in files.items():
    fd = os.open(os.path.join(destination, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=False) as writer:
            writer.write(data)
            writer.flush()
        os.fsync(fd)
    finally:
        os.close(fd)
for directory in (os.path.join(destination, "incidents"), destination):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
with open(os.path.join(destination, "runtime.sqlite3"), "rb") as reader:
    if hashlib.sha256(reader.read()).hexdigest() != digest:
        raise RuntimeError("installed historical snapshot digest changed")
print(json.dumps({"kind":"historical-fixture-snapshot-install","schemaVersion":7,"sha256":digest}))
`

export async function installTask007HistoricalSnapshot(input: {
  sourceDir: string; registryRoot: string; sha256: string
}, execute: Task007RunChild = runTask007Child): Promise<{ schemaVersion: 7; sha256: string }> {
  assertTask007PrivatePath(input.sourceDir, true, 0o700)
  assertTask007PrivatePath(input.registryRoot, true, 0o700)
  const result = await execute('python3', ['-I', '-c', TASK007_HISTORICAL_SNAPSHOT_INSTALLER,
    input.sourceDir, input.registryRoot, input.sha256], {
    cwd: input.sourceDir, env: {}, timeout: 60_000, maxBuffer: 1024 * 1024, encoding: 'utf8',
  }).catch(error => {
    if (error instanceof Task007ChildFailure) {
      if (error.stderr.includes('destination is nonempty')) throw new Error('Task7 historical snapshot destination is not fresh', { cause: error })
      if (error.stderr.includes('active WAL/checkpoint')) throw new Error('Task7 historical snapshot WAL checkpoint refused', { cause: error })
      if (error.stderr.includes('schema-seven')) throw new Error('Task7 historical schema-seven refused', { cause: error })
    }
    throw error
  })
  const installed = z.object({ kind: z.literal('historical-fixture-snapshot-install'), schemaVersion: z.literal(7),
    sha256: Task007Hex }).strict().parse(JSON.parse(result.stdout))
  if (installed.sha256 !== input.sha256) throw new Error('Task7 installed historical snapshot digest refused')
  return { schemaVersion: installed.schemaVersion, sha256: installed.sha256 }
}

export async function executeTask007FixtureExporter(options: {
  repoRoot: string; artifact: Task007LibTestArtifact; inputFile: string; outputDir: string
}, execute: Task007RunChild = runTask007Child): Promise<Task007FixtureOutput> {
  const { artifact, inputFile, outputDir } = options
  const repoRoot = fs.realpathSync(options.repoRoot)
  assertTask007Candidate(repoRoot, artifact.candidateSha)
  assertTask007PrivatePath(artifact.path, false, 0o700)
  assertTask007PrivatePath(inputFile, false, 0o600)
  assertTask007PrivatePath(outputDir, true, 0o700)
  const input = Task007FixtureInputSchema.parse(JSON.parse(fs.readFileSync(inputFile, 'utf8')))
  assertTask007PrivatePath(input.ownerRoot, true, 0o700)
  const withinOwner = (file: string) => file.startsWith(`${input.ownerRoot}${path.sep}`)
  if (!withinOwner(inputFile) || !withinOwner(outputDir) || !withinOwner(input.runtimeRoot)
    || !withinOwner(input.hostBinaryPath) || !withinOwner(input.brokerSocketPath)
    || input.candidateSha !== artifact.candidateSha || task007FileHash(artifact.path) !== artifact.sha256
    || task007FileHash(input.hostBinaryPath) !== input.hostBinarySha256 || fs.readdirSync(outputDir).length !== 0) {
    throw new Error('Task7 fixture input binding or fresh output custody refused')
  }
  const result = await execute(artifact.path, ['--exact', TASK007_EXPORT_TEST, '--nocapture', '--test-threads=1'], {
    cwd: repoRoot, env: { FRESHELL_TASK007_STOPPED_FIXTURE_INPUT_FILE: inputFile,
      FRESHELL_TASK007_STOPPED_FIXTURE_OUTPUT_DIR: outputDir },
    timeout: 300_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
  })
  fs.writeFileSync(path.join(outputDir, 'export.stdout'), result.stdout, { mode: 0o600, flag: 'wx' })
  fs.writeFileSync(path.join(outputDir, 'export.stderr'), result.stderr, { mode: 0o600, flag: 'wx' })
  if (!/^test result: ok\. 1 passed; 0 failed; 0 ignored;/m.test(result.stdout)) {
    throw new Error('Task7 fixture exporter did not execute its one selected test')
  }
  assertTask007Candidate(repoRoot, artifact.candidateSha)
  if (task007FileHash(artifact.path) !== artifact.sha256) throw new Error('Task7 fixture artifact changed during export')
  const metadataFile = path.join(outputDir, 'metadata.json')
  const databaseFile = path.join(outputDir, 'runtime.sqlite3')
  assertTask007PrivatePath(metadataFile, false, 0o600)
  assertTask007PrivatePath(databaseFile, false, 0o600)
  const output = Task007FixtureOutputSchema.parse(JSON.parse(fs.readFileSync(metadataFile, 'utf8')))
  const sameIdentity = output.fixtureId === input.fixtureId && output.runId === input.runId
    && output.candidateSha === input.candidateSha && output.installationId === input.installationId
    && output.dockerDaemonId === input.dockerDaemonId && output.imageRef === input.imageRef
    && output.hostBinarySha256 === input.hostBinarySha256 && output.workspacePath === input.workspacePath
    && output.runtimeRoot === input.runtimeRoot && output.registry.sha256 === task007FileHash(databaseFile)
  const rootOrdinals = [0, 1, 2, 3, 4, 5, 6, 0, 1]
  const sameTargets = output.targets.every((target, index) => {
    const expected = input.targets[index]
    const viewIds = input.explicitViews.filter(view => view.targetOrdinal === index).map(view => view.viewId)
    return target.soulId === expected.soulId && target.providerStoreId === expected.providerStoreId
      && target.rootSessionId === input.source.rootSessionIds[rootOrdinals[index]]
      && target.runtimeDir === path.join(input.runtimeRoot, target.incarnationId)
      && target.hostBinaryPath === input.hostBinaryPath
      && target.providerVolumeName === `freshell-provider-${createHash('sha256').update(`${input.installationId}\0${target.soulId}`).digest('hex').slice(0, 24)}`
      && target.viewIds.length === viewIds.length && viewIds.every(id => target.viewIds.includes(id))
  })
  const sameChoices = output.canonicalChoices.every((choice, index) => {
    const expected = input.canonicalChoices[index]
    return choice.rootSessionId === input.source.rootSessionIds[expected.rootOrdinal]
      && choice.soulId === input.targets[expected.targetOrdinal].soulId
      && choice.expectedIntentRevision === output.targets[expected.targetOrdinal].expectedIntentRevision
  })
  if (!sameIdentity || !sameTargets || !sameChoices || output.unrelated.soulId !== input.unrelated.target.soulId
    || output.unrelated.viewId !== input.unrelated.viewId) throw new Error('Task7 fixture output identity binding refused')
  for (const exported of output.unrelated.exports) {
    const file = path.resolve(outputDir, exported.file)
    if (!file.startsWith(`${outputDir}${path.sep}`)) throw new Error('Task7 fixture export path escapes output custody')
    assertTask007PrivatePath(file, false, 0o600)
    if (task007FileHash(file) !== exported.sha256) throw new Error('Task7 fixture unrelated export binding refused')
  }
  return output
}

function assertTask007Candidate(repoRoot: string, candidateSha: string): void {
  if (!/^[a-f0-9]{40}$/.test(candidateSha) || git(repoRoot, ['rev-parse', 'HEAD']).trim() !== candidateSha) {
    throw new Error('Task7 library artifact candidate changed')
  }
}

export async function prepareTask007LibTestArtifact(input: {
  repoRoot: string; buildDir: string; candidateSha: string
}, execute: Task007RunChild = runTask007Child): Promise<Task007LibTestArtifact> {
  const repoRoot = fs.realpathSync(input.repoRoot)
  assertTask007Candidate(repoRoot, input.candidateSha)
  const result = await execute(path.join(os.homedir(), '.local/bin/mise'), [
    'exec', 'rust@1.96', '--', 'cargo', 'test', '-p', 'freshell-supervisor', '--lib', '--no-run', '--message-format=json',
  ], { cwd: repoRoot, env: { PATH: process.env.PATH, HOME: os.homedir() },
    timeout: 1_800_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' })
  assertTask007Candidate(repoRoot, input.candidateSha)
  const destination = path.join(input.buildDir, 'task007')
  ensurePrivateDirectory(destination)
  fs.writeFileSync(path.join(destination, 'compile.jsonl'), result.stdout, { mode: 0o600, flag: 'wx' })
  fs.writeFileSync(path.join(destination, 'compile.stderr'), result.stderr, { mode: 0o600, flag: 'wx' })
  const messages: unknown[] = result.stdout.split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
  const records = messages.map(message => objectFields(message, 'invalid Task7 compiler artifact message'))
  if (!records.some(record => record.reason === 'build-finished' && record.success === true)
    || records.some(record => record.reason === 'build-finished' && record.success !== true)) {
    throw new Error('Task7 library artifact build did not finish successfully')
  }
  const sourcePath = fs.realpathSync(path.join(repoRoot, 'crates/freshell-supervisor/src/lib.rs'))
  const cratePath = path.join(repoRoot, 'crates/freshell-supervisor')
  const artifacts = records.filter(record => {
    if (record.reason !== 'compiler-artifact' || typeof record.package_id !== 'string') return false
    let packageUrl: URL
    try { packageUrl = new URL(record.package_id) } catch { return false }
    const target = objectFields(record.target, 'invalid Task7 compiler artifact target')
    const profile = objectFields(record.profile, 'invalid Task7 compiler artifact profile')
    return packageUrl.protocol === 'path+file:' && decodeURIComponent(packageUrl.pathname) === cratePath && !!packageUrl.hash
      && target.name === 'freshell_supervisor' && Array.isArray(target.kind) && target.kind.includes('lib')
      && target.src_path === sourcePath && profile.test === true && typeof record.executable === 'string'
  })
  if (artifacts.length !== 1) throw new Error('Task7 requires exactly one current library test artifact')
  const artifact = artifacts[0]
  const executable = z.string().parse(artifact.executable)
  const stat = fs.lstatSync(executable)
  if (!path.isAbsolute(executable) || fs.realpathSync(executable) !== executable || !stat.isFile()
    || !executable.startsWith(`${path.join(repoRoot, 'target')}${path.sep}`)) throw new Error('Task7 library artifact executable is not canonical and owned')
  const bytes = fs.readFileSync(executable)
  const file = path.join(destination, 'freshell-supervisor-lib-test')
  fs.writeFileSync(file, bytes, { mode: 0o700, flag: 'wx' })
  fs.chmodSync(file, 0o700)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== sha256) throw new Error('Task7 library artifact copy changed')
  const listing = await execute(file, ['--list', '--exact', TASK007_EXPORT_TEST], {
    cwd: repoRoot, env: {}, timeout: 30_000, maxBuffer: 1024 * 1024, encoding: 'utf8',
  })
  const tests = listing.stdout.split('\n').filter(line => line.endsWith(': test'))
  if (tests.length !== 1 || tests[0] !== `${TASK007_EXPORT_TEST}: test`
    || !/^1 test, 0 benchmarks$/m.test(listing.stdout)) throw new Error('Task7 artifact does not select its exact fixture exporter')
  fs.writeFileSync(path.join(destination, 'exporter-list.txt'), listing.stdout, { mode: 0o600, flag: 'wx' })
  assertTask007Candidate(repoRoot, input.candidateSha)
  if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== sha256) throw new Error('Task7 library artifact changed during selection')
  return { path: file, sha256, candidateSha: input.candidateSha, packageId: z.string().parse(artifact.package_id),
    features: z.array(z.string()).parse(artifact.features), sourcePath }
}

export type TransferResourcePolicy = {
  operationTimeoutMs: number
  cleanupTimeoutMs: number
  lifecycleMs: number
  memoryBytes: number
}
const TRANSFER_FIXTURE_POLICY: TransferResourcePolicy = {
  operationTimeoutMs: 300_000, cleanupTimeoutMs: 30_000, lifecycleMs: 600_000, memoryBytes: 1024 ** 3,
}

function admitTransferPolicy(policy: TransferResourcePolicy): TransferResourcePolicy {
  if (![policy.operationTimeoutMs, policy.cleanupTimeoutMs, policy.lifecycleMs, policy.memoryBytes].every(value => Number.isSafeInteger(value) && value > 0)
    || policy.operationTimeoutMs > policy.lifecycleMs || policy.operationTimeoutMs > 7_200_000 || policy.lifecycleMs > 7_200_000
    || policy.cleanupTimeoutMs > 30_000 || policy.memoryBytes > 2 * 1024 ** 3) throw new Error('finite transfer resource ceiling required')
  return { ...policy }
}

export class RuntimeHarness {
  private transferPolicy?: TransferResourcePolicy
  private transferAllocationUnknown = false
  private readonly transferPendingNames = new Set<string>()
  private readonly transferDeadlines = new Map<string, number>()
  private transferDocker(args: string[], cleanup = false, deadline?: number): string {
    const policy = this.transferPolicy ?? TRANSFER_FIXTURE_POLICY
    const timeout = Math.min(cleanup ? policy.cleanupTimeoutMs : policy.operationTimeoutMs, deadline === undefined ? Infinity : deadline - Date.now())
    if (timeout < 1) throw new Error('owned transfer cleanup budget expired')
    return execFileSync('docker', args, { encoding: 'utf8', timeout,
      killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  }
  private allocateTransferContainer(args: string[], name: string): string {
    this.transferPendingNames.add(name)
    try {
      const id = this.transferDocker(['create', '--name', name, ...args]).trim()
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('owned transfer allocation acknowledgement invalid')
      this.trackedContainers.add(id); this.transferPendingNames.delete(name)
      return id
    } catch (error) { this.transferAllocationUnknown = true; throw error }
  }
  private transferRemaining(containerId: string): number {
    const policy = this.transferPolicy ?? TRANSFER_FIXTURE_POLICY
    const remaining = (this.transferDeadlines.get(containerId) ?? Date.now() + policy.lifecycleMs) - Date.now()
    if (remaining < 1) throw new Error('owned transfer lifecycle expired')
    return Math.min(policy.operationTimeoutMs, remaining)
  }
  private async cleanupTransfer(): Promise<{ ok: boolean; errors: string[] }> {
    const original = this.transferOwnedIds(), errors: string[] = []
    const deadline = Date.now() + this.transferPolicy!.cleanupTimeoutMs
    for (const id of original.containers) {
      try { this.transferDocker(['rm', '-f', id], true, deadline) } catch { errors.push('owned transfer container removal failed') }
    }
    for (const volume of original.volumes) {
      try { this.transferDocker(['volume', 'rm', volume], true, deadline) } catch { errors.push('owned transfer volume removal failed') }
    }
    let absent = false
    try { this.verifyTransferCleanup(original, deadline); absent = true } catch { errors.push('owned transfer absence unresolved') }
    if (this.transferAllocationUnknown) errors.push('owned transfer allocation acknowledgement unresolved')
    if (absent && !this.transferAllocationUnknown) {
      this.trackedContainers.clear(); this.trackedVolumes.clear(); this.transferDeadlines.clear()
    }
    ensurePrivateDirectory(this.evidenceDir)
    writePrivateJson(path.join(this.evidenceDir, 'cleanup.json'), { ok: errors.length === 0, errors, ...original,
      verifiedResourcesAbsent: absent && !this.transferAllocationUnknown, allocationUnknown: this.transferAllocationUnknown })
    return { ok: errors.length === 0, errors }
  }
  private task2FiniteFixtures = false
  task2ServerBinary = ""
  readonly repoRoot: string
  readonly phase: 1 | 2 | 3 | 4 | 5
  readonly runId: string
  readonly candidateSha: string
  readonly testRoot: string
  readonly evidenceDir: string
  readonly buildDir: string
  readonly nativeHistoryBuildDir: string
  readonly assertionsPath: string
  readonly lifecyclePath: string
  readonly incidentsDir: string
  readonly browserDir: string

  imageRef = ''
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
  private ownedRuntimeImage: RunOwnedRuntimeImage | undefined
  private brokerStarted = false
  private readonly fixtureInputs: RuntimeFixtureInputs | undefined
  private readonly providerFixtureHome: string | undefined
  private readonly ownerIsolation: RuntimeOwnerIsolation | undefined
  private task007Artifact?: Promise<Task007LibTestArtifact>
  private readonly task007Brokers: RestrictedDockerBroker[] = []
  private readonly task007HelperNames = new Set<string>()
  private readonly task007RegistryReaderSupervisors = new Map<string, string>()
  private readonly task007Children = new Set<Promise<unknown>>()
  private readonly task007Cancellation = new AbortController()
  private readonly task007Fixtures = new Map<Task007StoppedFixtureKind, Task007PreparedStoppedFixture>()
  private readonly task007HostPaths = new Set<string>()
  private readonly task007WorkspaceRoots = new Set<string>()
  private readonly initialProviderRegistries = new Map<string, InitialProviderRegistrySource>()

  constructor(repoRoot: string, runId = randomUUID(), phase: 1 | 2 | 3 | 4 | 5 = 1,
    providerFixtureHomeOrIsolation?: string | RuntimeOwnerIsolation,
    private readonly providerFixtureXdgConfigHome?: string,
    fixtureInputs?: RuntimeFixtureInputs,
    ownerIsolation?: RuntimeOwnerIsolation) {
    this.providerFixtureHome = typeof providerFixtureHomeOrIsolation === 'string' ? providerFixtureHomeOrIsolation : undefined
    this.ownerIsolation = typeof providerFixtureHomeOrIsolation === 'object' ? providerFixtureHomeOrIsolation : ownerIsolation
    this.repoRoot = fs.realpathSync(repoRoot)
    this.fixtureInputs = fixtureInputs && {
      workspaceRoots: [...fixtureInputs.workspaceRoots],
      providerInputRoots: fixtureInputs.providerInputRoots ? [...fixtureInputs.providerInputRoots] : undefined,
      bootstrapFiles: [...fixtureInputs.bootstrapFiles],
    }
    this.phase = phase
    this.runId = runId
    this.candidateSha = git(this.repoRoot, ['rev-parse', 'HEAD']).trim()
    // A shared /tmp/frt can belong to another account on multi-user hosts.
    // Keep the short socket path while isolating each account's test runs.
    const userId = (process.getuid?.() ?? process.pid).toString(36)
    this.testRoot = path.join(os.tmpdir(), `f${userId}`, runId.slice(0, 12))
    this.evidenceDir = path.join(this.repoRoot, '.runtime-evidence', this.candidateSha, runId)
    this.buildDir = path.join(this.repoRoot, '.runtime-build', this.runId)
    this.nativeHistoryBuildDir = path.join(this.repoRoot, 'dist', `native-history-${this.runId}`)
    this.assertionsPath = path.join(this.evidenceDir, 'assertions.jsonl')
    this.lifecyclePath = path.join(this.evidenceDir, 'lifecycle.jsonl')
    this.incidentsDir = path.join(this.evidenceDir, 'incidents')
    this.browserDir = path.join(this.evidenceDir, 'browser')
  }

  async prepare(options: { operatorHome?: string } = {}): Promise<void> {
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
    this.task007HostPaths.add(this.testHostBinary)
    this.task007HostPaths.add(this.releaseHostBinary)
    if (this.phase >= 2) for (const root of this.phase2WorkspaceRoots()) this.task007WorkspaceRoots.add(root)

    const realSocketPath = dockerSocketPath()
    const proxySocketPath = path.join(this.testRoot, 'broker', 'docker.sock')
    this.broker = new RestrictedDockerBroker({
      realSocketPath,
      proxySocketPath,
      runtimeRootPrefix: path.join(this.testRoot, 'r'),
      allowedHostBinaryPaths: this.task007HostPaths,
      allowedImageRefs: new Set([this.imageRef]),
      allowTerminalWorkloads: this.phase >= 2,
      allowedWorkspaceRoots: this.task007WorkspaceRoots,
      allowedProviderInputRoots: new Set(this.phase >= 2 ? this.phase2ProviderInputRoots() : []),
      allowedProviderUserRoots: new Set(this.phase >= 2 ? this.phase2ProviderUserRoots() : []),
      allowedBootstrapFiles: new Set(this.phase >= 2 ? this.phase2BootstrapFiles() : []),
      allowedOperatorHomeRoots: new Set(options.operatorHome ? [options.operatorHome] : []),
      initialProviderVolumeLookup: volume => findInitialProviderVolume(volume, [...this.initialProviderRegistries.values()]),
      testRunId: this.runId,
      logPath: path.join(this.evidenceDir, 'broker.jsonl'),
    })
    const helperCreateDelay = parseHelperCreateDelay(process.env.FRESHELL_TEST_BROKER_DELAY_HELPER_CREATE)
    if (helperCreateDelay) {
      this.broker.delayHelperCreates(helperCreateDelay)
      this.recordLifecycle('gate.broker.helper_create_delay', helperCreateDelay)
    }
    await this.broker.start()
    this.brokerStarted = true

    writePrivateJson(path.join(this.evidenceDir, 'ownership-before.json'), { brokerReceipts: [], trackedContainers: [] })
    writePrivateJson(path.join(this.evidenceDir, 'capabilities.json'), this.collectCapabilities())
    writePrivateJson(path.join(this.evidenceDir, 'build.json'), this.collectBuildInfo())
    this.recordLifecycle('gate.prepare.completed', { imageRef: this.imageRef, brokerSocket: proxySocketPath })
  }

  cancelTask007(signal: 'SIGINT' | 'SIGTERM'): void {
    if (this.task007Cancellation.signal.aborted) return
    this.recordLifecycle('task007.owner.cancelled', { severity: 'warn', signal, runId: this.runId,
      candidateSha: this.candidateSha })
    this.task007Cancellation.abort(signal)
  }

  private assertTask007Active(): void {
    if (this.task007Cancellation.signal.aborted) throw new Error('Task7 owner cancelled')
  }

  private readonly executeTask007Child: Task007RunChild = (file, args, options) => {
    const cleanup = file === 'docker' && (['logs', 'rm', 'ps', 'inspect'].includes(args[0])
      || (args[0] === 'volume' && ['ls', 'rm'].includes(args[1])))
    if (!cleanup) this.assertTask007Active()
    const reference = `task007-child-${randomUUID()}`
    const retain = (stdout: string, stderr: string, failed: boolean) => {
      ensurePrivateDirectory(this.evidenceDir)
      fs.writeFileSync(path.join(this.evidenceDir, `${reference}.stdout`), stdout, { mode: 0o600, flag: 'wx' })
      fs.writeFileSync(path.join(this.evidenceDir, `${reference}.stderr`), stderr, { mode: 0o600, flag: 'wx' })
      this.recordLifecycle('task007.child.settled', { severity: failed ? 'warn' : 'info', reference, file, args })
    }
    const settlement = runTask007Child(file, args, { ...options,
      ...(!cleanup ? { signal: this.task007Cancellation.signal } : {}) }).then(result => {
      retain(result.stdout, result.stderr, false)
      return result
    }, error => {
      if (error instanceof Task007ChildFailure) retain(error.stdout, error.stderr, true)
      throw error
    })
    this.task007Children.add(settlement)
    const forget = () => this.task007Children.delete(settlement)
    settlement.then(forget, forget)
    return settlement
  }

  private async task007Docker(args: string[]): Promise<string> {
    const result = await this.executeTask007Child('docker', args, {
      cwd: this.repoRoot, env: { PATH: process.env.PATH, HOME: os.homedir(),
        ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) },
      timeout: 60_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
    })
    return result.stdout
  }

  private supervisorLocation(scenario: string): { scenarioId: string; controlDir: string; runtimeRoot: string } {
    const scenarioId = sanitizeName(scenario)
    const runtimeKey = `${scenarioId.slice(0, 6)}-${createHash('sha256').update(scenarioId).digest('hex').slice(0, 8)}`
    return { scenarioId, controlDir: path.join(this.scenarioPath(scenarioId), 'control'),
      runtimeRoot: path.join(this.testRoot, 'r', runtimeKey, 'x') }
  }

  /** Private grant-free setup; generated historical identities are not current runtime evidence. */
  async prepareTask007StoppedFixture(kind: Task007StoppedFixtureKind): Promise<Task007PreparedStoppedFixture> {
    this.assertTask007Active()
    if (this.phase !== 3 || !this.ownerIsolation || this.ownerIsolation.bootstrapProviders.length !== 0
      || !['browser', 'after_import_publication', 'after_repair_cas_before_withdrawal', 'during_withdrawal_before_ack'].includes(kind)) {
      throw new Error('Task7 batch requires an explicitly isolated phase-three owner')
    }
    const existing = this.task007Fixtures.get(kind)
    if (existing) return existing
    if (!this.brokerStarted) {
      if (fs.existsSync(this.testRoot) || fs.existsSync(this.buildDir)) throw new Error('Task7 fixture run already exists')
      await this.prepare()
    }
    if (!dockerIsRootless()) throw new Error('Task7 batch requires actual rootless Docker')
    this.task007Artifact ??= prepareTask007LibTestArtifact({ repoRoot: this.repoRoot, buildDir: this.buildDir,
      candidateSha: this.candidateSha }, this.executeTask007Child)
    const artifact = await this.task007Artifact
    const scenarioId = kind === 'browser' ? 'browser-managed-runtime' : `task007-${kind}`
    const { runtimeRoot } = this.supervisorLocation(scenarioId)
    const ownerRoot = kind === 'browser' ? this.testRoot : path.dirname(runtimeRoot)
    ensurePrivateDirectory(ownerRoot)
    ensurePrivateDirectory(runtimeRoot)
    const workspacePath = path.join(ownerRoot, `task007-${kind}-workspace`)
    fs.mkdirSync(workspacePath, { mode: 0o755 })
    // This generated workspace is read by provider UID 65534. A private
    // owner umask must not make its workspace or Git metadata inaccessible.
    fs.chmodSync(workspacePath, 0o755)
    git(workspacePath, ['init', '--shared=0644', '--quiet'])
    const gitCommonDir = fs.realpathSync(path.join(workspacePath, '.git'))
    this.task007WorkspaceRoots.add(workspacePath)
    this.task007WorkspaceRoots.add(gitCommonDir)
    const sourceDatabaseFile = path.join(ownerRoot, `task007-${kind}-source.db`)
    const source = seedManagedOpenCodeSource({ repoRoot: this.repoRoot, databasePath: sourceDatabaseFile,
      workspace: workspacePath, nonce: randomUUID(), batch: 'stopped-repair-seven-roots' })
    fs.chmodSync(sourceDatabaseFile, 0o600)
    const hostBinaryPath = path.join(ownerRoot, `task007-${kind}-host`)
    fs.copyFileSync(this.testHostBinary, hostBinaryPath, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(hostBinaryPath, 0o550)
    this.task007HostPaths.add(hostBinaryPath)
    let broker = this.broker
    if (kind !== 'browser') {
      broker = new RestrictedDockerBroker({ realSocketPath: dockerSocketPath(), proxySocketPath: path.join(ownerRoot, 'broker.sock'),
        runtimeRootPrefix: ownerRoot, allowedHostBinaryPaths: new Set([hostBinaryPath]), allowedImageRefs: new Set([this.imageRef]),
        allowTerminalWorkloads: true, allowedWorkspaceRoots: new Set([workspacePath, gitCommonDir]),
        allowedProviderUserRoots: new Set(), allowedBootstrapFiles: new Set(), testRunId: this.runId,
        logPath: path.join(this.evidenceDir, `task007-${kind}-broker.jsonl`) })
      this.task007Brokers.push(broker)
      await broker.start()
    }
    const target = () => ({ soulId: `soul-${randomUUID()}`, providerStoreId: `provider-store-${randomUUID()}`,
      terminalId: `terminal-${randomUUID()}`, streamId: `stream-${randomUUID()}` })
    const view = () => ({ viewId: `view-${randomUUID()}`, ownerId: `owner-${randomUUID()}`,
      workspaceId: `workspace-${randomUUID()}`, tabId: `tab-${randomUUID()}`, paneId: `pane-${randomUUID()}` })
    const input: Task007FixtureInput = { schemaVersion: 1, fixtureId: `task007-${randomUUID()}`, runId: this.runId,
      candidateSha: this.candidateSha, installationId: `installation-${randomUUID()}`, ownerRoot, runtimeRoot,
      workspacePath, cwd: workspacePath, gitCommonDir, imageRef: this.imageRef, hostBinaryPath,
      hostBinarySha256: task007FileHash(hostBinaryPath), dockerDaemonId: (await this.task007Docker(['info', '--format', '{{.ID}}'])).trim(),
      brokerSocketPath: broker.proxySocketPath, source: { rootSessionIds: source.families.map(family => family.rootId), unrelatedSessionId: source.unrelatedId },
      targets: Array.from({ length: 9 }, target), canonicalChoices: [{ rootOrdinal: 0, targetOrdinal: 0 }, { rootOrdinal: 1, targetOrdinal: 8 }],
      explicitViews: [0, 1, 7, 8].map(targetOrdinal => ({ ...view(), targetOrdinal })), unrelated: { ...view(), target: target() } }
    const expectedVolumes = input.targets.map(item => `freshell-provider-${createHash('sha256').update(`${input.installationId}\0${item.soulId}`).digest('hex').slice(0, 24)}`)
    const volumeInventory = (await this.task007Docker(['volume', 'ls', '-q'])).trim().split('\n')
    if (expectedVolumes.some(name => volumeInventory.includes(name))) throw new Error('Task7 refuses an existing provider volume')
    for (const name of expectedVolumes) {
      this.trackedVolumes.add(name)
      await this.task007Docker(['volume', 'create', '--label', `com.freshell.runtime-test-run-id=${this.runId}`,
        '--label', `com.freshell.runtime-test-candidate=${this.candidateSha}`, '--label', 'com.freshell.task007-setup=provider-home', name])
    }
    const inputFile = path.join(ownerRoot, `task007-${kind}-input.json`)
    const outputDir = path.join(ownerRoot, `task007-${kind}-output`)
    writePrivateJson(inputFile, input)
    ensurePrivateDirectory(outputDir)
    const output = await executeTask007FixtureExporter({ repoRoot: this.repoRoot, artifact, inputFile, outputDir }, this.executeTask007Child)
    for (const target of output.targets) {
      const receipt = broker.receipts().find(receipt => receipt.containerId === target.containerId)
      if (!receipt || receipt.workspacePath !== input.workspacePath) throw new Error('Task7 physical exporter receipt membership refused')
      this.trackedContainers.add(target.containerId)
      const consumers = (await this.task007Docker(['ps', '-aq', '--no-trunc', '--filter', `volume=${target.providerVolumeName}`])).trim().split('\n')
      if (consumers.length !== 1 || consumers[0] !== target.containerId) throw new Error('Task7 provider volume has unknown or foreign consumers')
      const name = `freshell-task007-setup-${randomUUID()}`
      const names = (await this.task007Docker(['ps', '-a', '--format', '{{.Names}}'])).trim().split('\n')
      if (names.includes(name)) throw new Error('Task7 setup name already exists')
      this.task007HelperNames.add(name)
      const initialized = await initializeTask007ProviderHome({ input, target, receipt, name }, this.executeTask007Child)
      this.task007HelperNames.delete(name)
      this.recordLifecycle('task007.provider_home.initialized', { fixtureId: input.fixtureId, ...initialized,
        providerVolumeName: target.providerVolumeName, ownerContainerId: target.containerId })
    }
    const registryRoot = path.join(ownerRoot, `task007-${kind}-registry`)
    ensurePrivateDirectory(registryRoot)
    let volumeName: string | undefined
    if (kind === 'browser') {
      volumeName = `freshell-task007-registry-${randomUUID()}`
      if ((await this.task007Docker(['volume', 'ls', '-q'])).trim().split('\n').includes(volumeName)) throw new Error('Task7 supervisor volume already exists')
      this.trackedVolumes.add(volumeName)
      await this.task007Docker(['volume', 'create', '--label', `com.freshell.runtime-test-run-id=${this.runId}`, volumeName])
      await this.installTask007SupervisorVolume(outputDir, volumeName, output.registry.sha256)
    } else await installTask007HistoricalSnapshot({ sourceDir: outputDir, registryRoot, sha256: output.registry.sha256 }, this.executeTask007Child)
    const prepared: Task007PreparedStoppedFixture = { input, output, source, inputFile, outputDir,
      metadataFile: path.join(outputDir, 'metadata.json'), sourceDatabaseFile, registryRoot, scenarioId, ...(volumeName ? { volumeName } : {}) }
    this.task007Fixtures.set(kind, prepared)
    this.writeArtifact(`task007-${kind}-prepared.json`, { input, output, registryRoot, sourceDatabaseFile, volumeName,
      artifact, historicalSetupOnly: true })
    return prepared
  }

  private async installTask007SupervisorVolume(sourceDir: string, volumeName: string, sha256: string): Promise<void> {
    const name = `freshell-task007-copy-${randomUUID()}`
    if ((await this.task007Docker(['ps', '-a', '--format', '{{.Names}}'])).trim().split('\n').includes(name)) throw new Error('Task7 copy helper name already exists')
    this.task007HelperNames.add(name)
    const containerId = (await this.task007Docker(['create', '--name', name, '--user', '0:0', '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '256m', '--memory-swap', '256m', '--cpus', '0.5', '--pids-limit', '32',
      '--mount', `type=bind,source=${sourceDir},target=/fixture,readonly`,
      '--mount', `type=volume,source=${volumeName},target=/registry,volume-nocopy`,
      '--label', `com.freshell.runtime-test-run-id=${this.runId}`, '--label', `com.freshell.runtime-test-candidate=${this.candidateSha}`,
      '--label', 'com.freshell.task007-setup=registry-copy', '--entrypoint', 'python3', this.imageRef,
      '-I', '-c', `import os; os.chmod('/registry',0o700)\n${TASK007_HISTORICAL_SNAPSHOT_INSTALLER}`, '/fixture', '/registry', sha256])).trim()
    if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('Task7 copy helper returned no exact ID')
    this.trackedContainers.add(containerId)
    try {
      await this.task007Docker(['start', containerId])
      const exit = (await this.task007Docker(['wait', containerId])).trim()
      const stdout = await this.task007Docker(['logs', containerId])
      writePrivateJson(path.join(this.evidenceDir, 'task007-copy-result.json'), { exit, stdout, containerId })
      if (exit !== '0' || z.object({ sha256: z.literal(sha256), schemaVersion: z.literal(7) }).safeParse(JSON.parse(stdout)).success !== true) {
        throw new Error('Task7 preopen supervisor snapshot installation failed')
      }
    } finally {
      await this.task007Docker(['rm', '--force', containerId])
      this.trackedContainers.delete(containerId)
      this.task007HelperNames.delete(name)
    }
  }

  async readTask007StoppedRegistry(supervisor: SupervisorInstance, fixtureId: string, operationId: string): Promise<z.infer<typeof Task007RepairRecordsSchema>> {
    const batch = this.task007Fixtures.get('browser')
    Task007Id.parse(operationId)
    if (!batch || batch.input.fixtureId !== fixtureId || batch.input.runId !== this.runId || batch.input.candidateSha !== this.candidateSha
      || batch.volumeName !== supervisor.volumeName || batch.input.runtimeRoot !== supervisor.runtimeRoot
      || batch.scenarioId !== supervisor.scenarioId || !this.trackedSupervisorContainers.has(supervisor.containerId)
      || !this.trackedVolumes.has(supervisor.volumeName) || this.imageRef !== batch.input.imageRef) {
      throw new Error('exact registered stopped Registry reader ownership required')
    }
    if (this.isContainerRunning(supervisor.containerId, true)) throw new Error('stopped Registry reader refuses a running supervisor')
    assertTask007PrivatePath(batch.metadataFile, false, 0o600)
    if (!batch.metadataFile.startsWith(`${fs.realpathSync(this.testRoot)}${path.sep}`)
      || fs.lstatSync(batch.metadataFile).nlink !== 1
      || JSON.stringify(Task007FixtureOutputSchema.parse(JSON.parse(fs.readFileSync(batch.metadataFile, 'utf8'))))
        !== JSON.stringify(Task007FixtureOutputSchema.parse(batch.output))) {
      throw new Error('registered stopped Registry metadata custody changed')
    }
    const sourceStoreId = createHash('sha256').update(fs.realpathSync(batch.sourceDatabaseFile)).digest('hex')
    const name = `freshell-task007-registry-read-${randomUUID()}`
    if ((await this.task007Docker(['ps', '-a', '--format', '{{.Names}}'])).trim().split('\n').includes(name)) {
      throw new Error('stopped Registry reader name already exists')
    }
    this.task007HelperNames.add(name)
    this.task007RegistryReaderSupervisors.set(name, supervisor.containerId)
    let containerId: string | undefined, failure: unknown
    try {
      const returnedId = (await this.task007Docker(['create', '--name', name, '--user', '0:0', '--network', 'none', '--read-only',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '256m', '--memory-swap', '256m', '--cpus', '0.5', '--pids-limit', '32',
        '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m',
        '--mount', `type=volume,source=${supervisor.volumeName},target=/registry,readonly,volume-nocopy`,
        '--mount', `type=bind,source=${batch.metadataFile},target=/fixture/metadata.json,readonly`,
        '--label', `com.freshell.runtime-test-run-id=${this.runId}`, '--label', `com.freshell.runtime-test-candidate=${this.candidateSha}`,
        '--label', 'com.freshell.task007-setup=registry-observation', '--label', `com.freshell.task007-fixture-id=${fixtureId}`,
        '--label', `com.freshell.task007-supervisor-id=${supervisor.containerId}`,
        '--entrypoint', 'python3', this.imageRef, '-I', '-c', TASK007_STOPPED_REGISTRY_OBSERVATION,
        '/registry/runtime.sqlite3', '/fixture/metadata.json', operationId, '/registry', sourceStoreId])).trim()
      Task007Hex.parse(returnedId)
      if (this.trackedContainers.has(returnedId) || this.trackedSupervisorContainers.has(returnedId)
        || this.broker.receiptIds().has(returnedId)) throw new Error('stopped Registry reader returned an already owned container')
      containerId = returnedId
      this.trackedContainers.add(containerId)
      this.recordLifecycle('task007.registry_reader.start_requested', { fixtureId, containerId, supervisorContainerId: supervisor.containerId })
      await this.task007Docker(['start', containerId])
      const exit = (await this.task007Docker(['wait', containerId])).trim()
      const stdout = await this.task007Docker(['logs', containerId])
      this.writeArtifact(`task007-registry-read-${randomUUID()}.json`, { fixtureId, operationId, containerId, exit, stdout })
      if (exit !== '0') throw new Error('current stopped Registry reader refused operation')
      if (this.isContainerRunning(supervisor.containerId, true)) throw new Error('stopped Registry supervisor restarted during read')
      return Task007RepairRecordsSchema.parse(JSON.parse(stdout))
    } catch (error) { failure = error; throw error }
    finally {
      try {
        if (containerId && Task007Hex.safeParse(containerId).success) {
          await this.task007Docker(['rm', '--force', containerId]); this.trackedContainers.delete(containerId)
        } else await this.removeTask007Helper(name)
        this.task007HelperNames.delete(name)
        this.task007RegistryReaderSupervisors.delete(name)
      } catch (cleanupError) {
        if (failure) throw new AggregateError([failure, cleanupError], 'stopped Registry read and owned cleanup failed')
        throw cleanupError
      }
    }
  }

  async runTask007StoppedRepairParents(): Promise<{ executedParents: 3; passedParents: 3 }> {
    this.assertTask007Active()
    const kinds = ['after_import_publication', 'after_repair_cas_before_withdrawal', 'during_withdrawal_before_ack'] as const
    const fixtures: Record<string, { inputFile: string; registryRoot: string; sourceDatabaseFile: string; metadataFile: string }> = {}
    for (const kind of kinds) {
      this.assertTask007Active()
      const prepared = await this.prepareTask007StoppedFixture(kind)
      fixtures[`stopped_repair_${kind}`] = { inputFile: prepared.inputFile, registryRoot: prepared.registryRoot,
        sourceDatabaseFile: prepared.sourceDatabaseFile, metadataFile: prepared.metadataFile }
    }
    const artifact = await this.task007Artifact
    this.assertTask007Active()
    if (!artifact) throw new Error('Task7 parent harness artifact is absent')
    const manifest = path.join(this.testRoot, 'task007-crash-fixtures.json')
    writePrivateJson(manifest, fixtures)
    const name = `freshell-task007-parents-${randomUUID()}`
    if ((await this.task007Docker(['ps', '-a', '--format', '{{.Names}}'])).trim().split('\n').includes(name)) throw new Error('Task7 parent enclosure name exists')
    this.task007HelperNames.add(name)
    const containerId = (await this.task007Docker(['create', '--name', name, '--user', '0:0', '--workdir', '/', '--init',
      '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--memory', '2g', '--memory-swap', '2g', '--cpus', '2', '--pids-limit', '256',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m', '--mount', `type=bind,source=${this.testRoot},target=${this.testRoot}`,
      '--mount', `type=bind,source=${this.buildDir},target=${this.buildDir},readonly`,
      '--label', `com.freshell.runtime-test-run-id=${this.runId}`, '--label', `com.freshell.runtime-test-candidate=${this.candidateSha}`,
      '--label', 'com.freshell.task007-setup=destructive-parents', '-e', 'FRESHELL_SANDBOX_MODE=runtime-suite',
      '-e', `FRESHELL_TASK007_STOPPED_REPAIR_CRASH_FIXTURES=${manifest}`, '--entrypoint', artifact.path, this.imageRef,
      'stopped_repair_crash_', '--ignored', '--nocapture', '--test-threads=1'])).trim()
    if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('Task7 parent enclosure create returned no exact ID')
    this.trackedContainers.add(containerId)
    let exit: string | undefined
    let logs = ''
    const errors: unknown[] = []
    try {
      await this.task007Docker(['start', containerId])
      const result = await this.executeTask007Child('docker', ['wait', containerId], {
        cwd: this.repoRoot, env: { PATH: process.env.PATH, HOME: os.homedir(),
          ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) },
        timeout: 600_000, maxBuffer: 1024 * 1024, encoding: 'utf8',
      })
      exit = result.stdout.trim()
    } catch (error) {
      errors.push(error)
    } finally {
      try {
        const capture = await this.executeTask007Child('docker', ['logs', containerId], {
          cwd: this.repoRoot, env: { PATH: process.env.PATH, HOME: os.homedir(),
            ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) },
          timeout: 60_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
        })
        logs = capture.stdout
        fs.writeFileSync(path.join(this.evidenceDir, 'task007-destructive-parents.stdout'), logs, { mode: 0o600, flag: 'wx' })
        fs.writeFileSync(path.join(this.evidenceDir, 'task007-destructive-parents.stderr'), capture.stderr, { mode: 0o600, flag: 'wx' })
      } catch (error) { errors.push(error) }
      try {
        await this.task007Docker(['rm', '--force', containerId])
        this.trackedContainers.delete(containerId)
        this.task007HelperNames.delete(name)
      } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'Task7 owned enclosed execution or capture/cleanup failed')
    const expected = ['stopped_repair_crash_after_import_publication', 'stopped_repair_crash_after_repair_cas_before_withdrawal',
      'stopped_repair_crash_during_withdrawal_before_ack']
    // Each parent prints nested child/helper output before its trailing ok.
    const cases = [...logs.matchAll(/test loss_report::tests::(stopped_repair_crash_[a-z_]+) \.\.\./g)]
    if (exit !== '0' || cases.length !== 3 || expected.some(name => !cases.some(row => row[1] === name))
      || !/test result: ok\. 3 passed; 0 failed; 0 ignored;/.test(logs)) throw new Error('Task7 actual enclosed three-parent execution failed')
    this.writeArtifact('task007-destructive-result.json', { candidateSha: this.candidateSha, runId: this.runId,
      imageRef: this.imageRef, containerId, artifact, executedParents: cases.length, passedParents: 3,
      fictionalHistoricalSetup: true, nativeQualified: false })
    return { executedParents: 3, passedParents: 3 }
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

  async prepareTask2FixtureArtifactsForCurrentCandidate(
    input: Omit<Task2FixtureArtifacts, 'imageDigest'>,
  ): Promise<void> {
    if (!this.imageRef) this.ensureRuntimeImage()
    if (!this.imageRef) throw new Error('current-candidate fixture image was not prepared')
    await this.prepareTask2FixtureArtifacts({ ...input, imageDigest: this.imageRef })
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
  async prepareTransfer(imageDigest: string, policy: TransferResourcePolicy = TRANSFER_FIXTURE_POLICY): Promise<void> {
    this.transferPolicy = admitTransferPolicy(policy)
    if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest) || !JSON.parse(this.transferDocker(['info', '--format', '{{json .SecurityOptions}}'])).some((value: string) => /rootless/i.test(value))) {
      throw new Error('transfer requires an exact immutable image and rootless Docker')
    }
    const inspected = this.transferDocker(['image', 'inspect', imageDigest, '--format', '{{.Id}}']).trim()
    if (inspected !== imageDigest) throw new Error('transfer image identity mismatch')
    if (fs.existsSync(this.testRoot)) throw new Error('transfer scratch already exists')
    fs.mkdirSync(this.testRoot, { recursive: true, mode: 0o700 })
    ensurePrivateDirectory(this.evidenceDir)
    this.imageRef = imageDigest
    this.recordLifecycle('transfer.prepare.completed', { imageDigest, candidateSha: this.candidateSha })
  }

  startTransferProvider(stageBinary: string, schemaFile: string, migrationsFile: string, workspacePaths: readonly string[] = [], policy?: TransferResourcePolicy): { containerId: string; volumeName: string } {
    this.transferPolicy = admitTransferPolicy(policy ?? this.transferPolicy ?? TRANSFER_FIXTURE_POLICY)
    for (const file of [stageBinary, schemaFile, migrationsFile]) {
      if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) throw new Error('exact transfer artifact file required')
    }
    const volumeName = `freshell-transfer-${this.runId.slice(0, 12)}-${randomUUID().slice(0, 8)}`
    this.trackedVolumes.add(volumeName)
    try { this.transferDocker(['volume', 'create', '--label', `com.freshell.runtime-test-run-id=${this.runId}`, volumeName]) }
    catch (error) { this.transferAllocationUnknown = true; throw error }
    // Trusted rootless volume initialization finishes before any provider
    // runs. Only the owned volume root changes; provider operations get no caps.
    const initializerName = `${volumeName}-init`
    const initializer = this.allocateTransferContainer([
      '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
      '--security-opt', 'no-new-privileges', '--label', `com.freshell.runtime-test-run-id=${this.runId}`,
      '--mount', `type=volume,source=${volumeName},target=/scratch`, this.imageRef,
      'python3', '-c', 'import os; p="/scratch/.freshell-transfer-owner"; f=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600); os.write(f,b"owned-transfer-volume"); os.fsync(f); os.close(f); os.chown(p,65534,0); os.chmod("/scratch",0o700); os.chown("/scratch",65534,0)',
    ], initializerName)
    if (!/^[a-f0-9]{64}$/.test(initializer)) throw new Error('invalid transfer initializer id')
    this.trackedContainers.add(initializer)
    this.transferDocker(['start', '-a', initializer])
    const exitCode = Number(this.transferDocker(['inspect', '--format', '{{.State.ExitCode}}', initializer]).trim())
    if (exitCode !== 0) throw new Error('owned volume initialization failed')
    const containerId = this.allocateTransferContainer([
      '--network', 'none', '--read-only', '--user', '65534:0', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--cpus', '2', '--memory', String(this.transferPolicy!.memoryBytes), '--memory-swap', String(this.transferPolicy!.memoryBytes), '--pids-limit', '128',
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
      '-w', '/scratch', this.imageRef, 'sleep', String(Math.ceil(this.transferPolicy!.lifecycleMs / 1000)),
    ], `${volumeName}-provider`)
    const startedAt = Date.now()
    this.transferDocker(['start', containerId])
    if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('invalid transfer provider id')
    this.trackedContainers.add(containerId)
    this.transferDeadlines.set(containerId, startedAt + this.transferPolicy!.lifecycleMs)
    this.recordLifecycle('transfer.provider.started', { containerId, volumeName, imageDigest: this.imageRef, providerUid: 65534, providerGid: 0 })
    return { containerId, volumeName }
  }

  writeTransferRequest(containerId: string, fileName: string, value: unknown): void {
    if (!this.trackedContainers.has(containerId) || !/^[a-z0-9-]+\.json$/.test(fileName)) throw new Error('owned transfer request required')
    execFileSync('docker', ['exec', '-i', '--user', '65534:0', containerId, 'python3', '-c',
      'import os,sys; p="/scratch/"+sys.argv[1]; f=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600); b=sys.stdin.buffer.read(1048577); assert len(b)<=1048576; os.write(f,b); os.fsync(f); os.close(f)', fileName,
    ], { input: JSON.stringify(value), encoding: 'utf8', timeout: this.transferRemaining(containerId), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 })
  }

  async copyTransferFileExact(containerId: string, sourceFile: string, destinationFile: string): Promise<void> {
    if (!this.trackedContainers.has(containerId) || !/^\/scratch\/[a-z0-9-]+\.(json|bin)$/.test(destinationFile)) throw new Error('exact owned transfer file required')
    const child = spawn('docker', ['exec', '-i', '--user', '65534:0', containerId, 'node', '-e',
      'const fs=require("node:fs");const f=fs.openSync(process.argv[1],"wx",0o600);let count=0;process.stdin.on("data",b=>{count+=b.length;if(count>8589934592)process.exit(1);fs.writeSync(f,b)});process.stdin.on("end",()=>{fs.fsyncSync(f);fs.closeSync(f)});', destinationFile,
    ], { cwd: this.repoRoot, stdio: ['pipe', 'ignore', 'pipe'], timeout: this.transferRemaining(containerId), killSignal: 'SIGKILL' })
    this.recordLifecycle('transfer.file.copy.started', { containerId, childPid: child.pid, sourceReference: sourceFile, destinationReference: destinationFile })
    const completion = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`owned transfer copy failed: ${code ?? signal}`)))
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
    ], { cwd: this.repoRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: this.transferRemaining(containerId), killSignal: 'SIGKILL' })
    const completion = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`owned native capture failed: ${code ?? signal}`)))
      child.stderr.resume()
    })
    const results = await Promise.allSettled([pipeline(child.stdout, fs.createWriteStream(destinationFile, { mode: 0o600, flags: 'wx' })), completion])
    if (results.some((result) => result.status === 'rejected')) throw new Error('owned native artifact capture failed')
    this.recordLifecycle('transfer.native_artifact.captured', { containerId, sourceReference: sourceFile, destinationReference: destinationFile })
  }

  transferOwnedIds(): { containers: string[]; volumes: string[] } {
    return { containers: [...this.trackedContainers, ...this.transferPendingNames], volumes: [...this.trackedVolumes] }
  }

  verifyTransferCleanup(original: { containers: string[]; volumes: string[] }, deadline = Date.now() + (this.transferPolicy ?? TRANSFER_FIXTURE_POLICY).cleanupTimeoutMs): void {
    // Successful inventory calls prove absence; daemon/transport failure is
    // never interpreted as a missing owned object.
    const containers = new Set(this.transferDocker(['ps', '-aq', '--no-trunc'], true, deadline).trim().split('\n'))
    if (this.transferPendingNames.size) for (const name of this.transferDocker(['ps', '-a', '--format', '{{.Names}}'], true, deadline).trim().split('\n')) containers.add(name)
    const volumes = new Set(this.transferDocker(['volume', 'ls', '-q'], true, deadline).trim().split('\n'))
    if (original.containers.some((id) => containers.has(id)) || original.volumes.some((id) => volumes.has(id))) {
      throw new Error('owned transfer resources remain after cleanup')
    }
  }

  private async removeTask007Helper(name: string): Promise<void> {
    if (!this.task007HelperNames.has(name)) { this.removeContainerExact(name); return }
    const names = (await this.task007Docker(['ps', '-a', '--format', '{{.Names}}'])).trim().split('\n')
    if (!names.includes(name)) {
      this.task007HelperNames.delete(name)
      this.task007RegistryReaderSupervisors.delete(name)
      return
    }
    const observed = z.array(z.object({ Id: Task007Hex, Image: z.string(), Config: z.object({ Labels: z.record(z.string(), z.string()) }),
      Mounts: z.array(z.object({ Type: z.string(), Name: z.string().optional(), Source: z.string().optional(), Destination: z.string(), RW: z.boolean() })) })).length(1)
      .parse(JSON.parse(await this.task007Docker(['inspect', name])))[0]
    const labels = observed.Config.Labels
    const volumes = observed.Mounts.filter(mount => mount.Type === 'volume')
    const binds = observed.Mounts.filter(mount => mount.Type === 'bind')
    const kind = labels['com.freshell.task007-setup']
    const parentMounts = kind === 'destructive-parents' && observed.Mounts.length === 2 && binds.length === 2
      && binds.some(mount => mount.Source === this.testRoot && mount.Destination === this.testRoot && mount.RW)
      && binds.some(mount => mount.Source === this.buildDir && mount.Destination === this.buildDir && !mount.RW)
    const setupMounts = ['provider-home', 'registry-copy'].includes(kind) && volumes.length === 1
      && !!volumes[0].Name && this.trackedVolumes.has(volumes[0].Name) && volumes[0].RW
      && (kind === 'provider-home' ? observed.Mounts.length === 1 && volumes[0].Destination === '/home/freshell/provider'
        : observed.Mounts.length === 2 && volumes[0].Destination === '/registry' && binds.length === 1
          && !!binds[0].Source?.startsWith(`${this.testRoot}${path.sep}`) && binds[0].Destination === '/fixture' && !binds[0].RW)
    const batch = this.task007Fixtures.get('browser')
    const registryReaderMounts = kind === 'registry-observation' && name.startsWith('freshell-task007-registry-read-')
      && !!batch && labels['com.freshell.task007-fixture-id'] === batch.input.fixtureId
      && this.task007RegistryReaderSupervisors.has(name)
      && this.task007RegistryReaderSupervisors.get(name) === labels['com.freshell.task007-supervisor-id']
      && observed.Mounts.length === 2 && volumes.length === 1 && volumes[0].Name === batch.volumeName
      && !!batch.volumeName && this.trackedVolumes.has(batch.volumeName) && volumes[0].Destination === '/registry' && !volumes[0].RW
      && binds.length === 1 && binds[0].Source === batch.metadataFile && binds[0].Destination === '/fixture/metadata.json' && !binds[0].RW
    if (observed.Image !== this.imageRef || labels['com.freshell.runtime-test-run-id'] !== this.runId
      || labels['com.freshell.runtime-test-candidate'] !== this.candidateSha
      || (!parentMounts && !setupMounts && !registryReaderMounts)) throw new Error('Task7 partial setup helper ownership is unknown')
    await this.task007Docker(['rm', '--force', observed.Id])
    this.task007HelperNames.delete(name)
    this.task007RegistryReaderSupervisors.delete(name)
  }

  async cleanup(): Promise<{ ok: boolean; errors: string[] }> {
    if (this.transferPolicy) return this.cleanupTransfer()
    const errors: string[] = []
    await Promise.allSettled([...this.task007Children])
    const brokers = [this.broker, ...this.task007Brokers].filter((broker): broker is RestrictedDockerBroker => !!broker)
    const supervisorIds = [...this.trackedSupervisorContainers]
    for (const id of supervisorIds) {
      try { this.removeContainerExact(id) } catch (error) { errors.push(`supervisor ${id}: ${String(error)}`) }
    }
    // Stop producers before draining on ordinary errors as well as signals.
    // Helpers may hold independent broker waits after their caller has exited.
    const names = new Set([...this.task007HelperNames, ...brokers.flatMap(broker => broker.historyHelperNames())])
    for (const name of names) {
      try { await this.removeTask007Helper(name) } catch (error) { errors.push(`settling helper ${name}: ${String(error)}`) }
    }
    const brokerSettlementFailures: BrokerSettlementFailure[] = []
    let brokerSettlementComplete = true
    for (const broker of brokers) {
      try {
        if (!(await broker.settleForwarded(BROKER_SETTLE_MS))) {
          brokerSettlementComplete = false
          errors.push(`docker requests forwarded by the broker were still unanswered after ${BROKER_SETTLE_MS / 1000}s`)
          continue
        }
        const failures = await broker.awaitPendingRequests()
        brokerSettlementFailures.push(...failures)
        for (const failure of failures) errors.push(`broker settlement: ${failure.reason} (${failure.method} ${failure.url})`)
      } catch (error) { brokerSettlementComplete = false; errors.push(`broker settlement: ${String(error)}`) }
    }
    const receipts = brokers.flatMap(broker => broker.receipts())
    const initialProviders = brokers.flatMap(broker => broker.initialProviderVolumeCreations())
    const initialProviderNames = new Set(initialProviders.map(owner => owner.providerVolumeName))
    let initialProviderVolumes: ReturnType<typeof captureInitialProviderVolumes> = []
    let initialProviderCleanupConfirmed = true
    try { initialProviderVolumes = captureInitialProviderVolumes(initialProviders) }
    catch (error) { initialProviderCleanupConfirmed = false; errors.push(`initial provider capture: ${String(error)}`) }
    const exactContainerIds = [...new Set([
      ...supervisorIds, ...this.trackedForeignContainers,
      ...this.trackedContainers, ...brokers.flatMap(broker => [...broker.receiptIds()]),
    ])]
    const providerVolumes = new Set([...initialProviderNames,
      ...receipts.map(receipt => receipt.providerVolumeName).filter((value): value is string => !!value)])
    const candidateVolumes = new Set(brokers.flatMap(broker => broker.candidateVolumeNames()))
    const exactVolumes = [...new Set([...this.trackedVolumes, ...providerVolumes, ...candidateVolumes])]
    const historyHelperNames = [...new Set([...brokers.flatMap(broker => broker.historyHelperNames()), ...this.task007HelperNames])]
    for (const id of new Set(brokers.flatMap(broker => [...broker.receiptIds()]))) {
      try { this.removeContainerExact(id) } catch (error) { errors.push(`managed runtime ${id}: ${String(error)}`) }
    }
    for (const name of historyHelperNames) {
      try {
        await this.removeTask007Helper(name)
      } catch (error) { errors.push(`history helper ${name}: ${String(error)}`) }
    }
    for (const id of [...this.trackedForeignContainers]) {
      try { this.removeContainerExact(id) } catch (error) { errors.push(`foreign sentinel ${id}: ${String(error)}`) }
    }
    for (const id of [...this.trackedContainers]) {
      try { this.removeContainerExact(id) } catch (error) { errors.push(`tracked container ${id}: ${String(error)}`) }
    }
    const indexedVolumes = new Set<string>()
    for (const broker of brokers) {
      const owned = new Set(broker.eventsSnapshot().flatMap(event => {
        const volume = event.providerVolumeName
        return event.decision === 'forward' && event.method === 'POST'
          && event.url.startsWith('/v1.47/containers/create?')
          && /^[a-f0-9]{64}$/.test(event.containerId ?? '')
          && /^freshell-inputs-[a-f0-9]{24}$/.test(volume ?? '')
          && event.helperName === `${volume}-publisher` ? [volume!] : []
      }))
      for (const volume of owned) {
        indexedVolumes.add(volume)
        try {
          const url = `/v1.47/volumes/${volume}`
          const deleted = await brokerRequestStatus(broker.proxySocketPath, 'DELETE', url)
          if (deleted !== 204 && deleted !== 404) throw new Error('owned indexed volume deletion unavailable')
          if (await brokerRequestStatus(broker.proxySocketPath, 'GET', url) !== 404) throw new Error('owned indexed volume absence unconfirmed')
        } catch (error) { errors.push(`indexed volume ${volume}: ${String(error)}`) }
      }
    }
    exactVolumes.push(...[...indexedVolumes].filter(volume => !exactVolumes.includes(volume)))
    if (initialProviderCleanupConfirmed) {
      try { cleanupInitialProviderVolumes(initialProviderVolumes) }
      catch (error) { initialProviderCleanupConfirmed = false; errors.push(`initial provider cleanup: ${String(error)}`) }
    }
    // Candidate scratch belongs to the broker that admitted its creation.
    // Remove it after every mounting helper, before discarding the broker.
    for (const broker of brokers) {
      for (const volume of broker.candidateVolumeNames()) {
        try {
          const url = `/v1.47/volumes/${volume}`
          const deleted = await brokerRequestStatus(broker.proxySocketPath, 'DELETE', url)
          if (deleted !== 204 && deleted !== 404) throw new Error('owned candidate volume deletion unavailable')
          if (await brokerRequestStatus(broker.proxySocketPath, 'GET', url) !== 404) throw new Error('owned candidate volume absence unconfirmed')
        } catch (error) { errors.push(`candidate volume ${volume}: ${String(error)}`) }
      }
    }
    for (const volume of exactVolumes.filter(volume => !indexedVolumes.has(volume) && !initialProviderNames.has(volume) && !candidateVolumes.has(volume))) {
      try { docker(['volume', 'rm', volume]) } catch (error) { errors.push(`volume ${volume}: ${String(error)}`) }
    }
    if (this.brokerStarted) {
      try { await this.broker.close() } catch (error) { errors.push(`broker close: ${String(error)}`) }
      this.brokerStarted = false
    }
    for (const broker of this.task007Brokers) {
      try { await broker.close() } catch (error) { errors.push(`Task7 broker close: ${String(error)}`) }
    }
    let knownResourcesAbsent = false
    try {
      const lines = (text: string) => text.trim() ? text.trim().split('\n').map(value => value.trim()) : []
      verifyRuntimeCleanupAbsence({ containerIds: exactContainerIds, volumes: exactVolumes, helperNames: historyHelperNames }, {
        containerIds: lines(docker(['ps', '-aq', '--no-trunc'])),
        volumes: lines(docker(['volume', 'ls', '--format', '{{.Name}}'])),
        containerNames: lines(docker(['ps', '-a', '--format', '{{.Names}}'])),
      })
      knownResourcesAbsent = true
    } catch (error) { errors.push(`runtime absence: ${error instanceof Error ? error.message : String(error)}`) }
    const resourcesAbsent = knownResourcesAbsent && brokerSettlementComplete && initialProviderCleanupConfirmed
      && !brokerSettlementFailures.some(failure => failure.allocationUnknown)
    let runtimeImageCleanup: { tag: string; digest?: string; removed?: boolean } | undefined
    if (resourcesAbsent && this.ownedRuntimeImage) {
      runtimeImageCleanup = { tag: this.ownedRuntimeImage.tag, digest: this.ownedRuntimeImage.digest }
      try {
        removeRunOwnedRuntimeImage(this.ownedRuntimeImage)
        runtimeImageCleanup.removed = true
        this.recordLifecycle('runtime.owned_image_removed', runtimeImageCleanup)
      } catch (error) {
        runtimeImageCleanup.removed = false
        errors.push(`runtime image ${this.ownedRuntimeImage.tag}: ${String(error)}`)
        this.recordLifecycle('runtime.owned_image_cleanup_failed', { ...runtimeImageCleanup, error: String(error) })
      }
    }
    // Build copies are unique to this run, so retries/concurrent gates never
    // overwrite an executable that another still-running container/process
    // has mapped. Remove them only after every receipt-owned runtime stopped.
    if (resourcesAbsent) {
      try { fs.rmSync(this.buildDir, { recursive: true, force: true }) } catch (error) { errors.push(`runtime build dir: ${String(error)}`) }
      try { fs.rmSync(this.nativeHistoryBuildDir, { recursive: true, force: true }) } catch (error) { errors.push(`native history build dir: ${String(error)}`) }
    }
    const cleanup = {
      ok: errors.length === 0,
      errors,
      exactContainerIds,
      volumes: exactVolumes,
      historyHelperNames,
      brokerSettlementFailures,
      brokerSettlementComplete,
      verifiedKnownResourcesAbsent: knownResourcesAbsent,
      verifiedResourcesAbsent: resourcesAbsent,
      ownedImage: this.ownedRuntimeImage,
      runtimeImage: runtimeImageCleanup,
      unsafeBrokerAttempts: this.broker?.unsafeAttempts?.() ?? [],
      completedAt: new Date().toISOString(),
    }
    ensurePrivateDirectory(this.evidenceDir)
    writePrivateJson(path.join(this.evidenceDir, 'cleanup.json'), cleanup)
    writePrivateJson(path.join(this.evidenceDir, 'ownership-after.json'), { brokerReceipts: receipts, brokerEvents: brokers.flatMap(broker => broker.eventsSnapshot()) })
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
    /** Operator home the supervisor mounts read-only into terminal/fresh-agent souls. */
    operatorHome?: string
    /** Exact artifact-owned historical session host for legacy enclosure proof. */
    hostBinaryPath?: string
  }): Promise<SupervisorInstance> {
    const { scenarioId, controlDir, runtimeRoot } = this.supervisorLocation(options.scenarioId)
    // Linux Unix-domain sockets have a small sun_path budget. Runtime paths
    // include a long incarnation UUID plus `/host.sock`, so keep the durable
    // runtime root intentionally short and deterministic across restarts.
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
      ? this.validateSupervisorHostBinary(options.hostBinaryPath)
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
      // Helpers are created by the host Docker daemon; their exchange sources
      // must live in the existing same-path shared root, outside private /tmp.
      '-e', `TMPDIR=${this.testRoot}`,
      '-v', `${this.buildDir}:${this.buildDir}:ro`,
      '-v', `${volumeName}:/var/lib/freshell-supervisor:rw`,
    ]
    if (this.phase >= 2) {
      if (this.providerFixtureHome !== undefined) {
        // The supervisor resolves provider configuration-file references in
        // this explicitly supplied synthetic HOME before it can mount them
        // into a workload. Keep ambient host homes unmounted.
        const home = validateOwnedFixturePath(this.providerFixtureHome, 'directory', 'provider fixture root')
        args.push('-v', `${home}:${home}:ro`)
      }
      for (const root of this.phase2WorkspaceRoots()) {
        if (root === this.testRoot || root === this.buildDir) continue
        args.push('-v', `${root}:${root}:ro`)
      }
      for (const root of this.phase2ProviderInputRoots()) {
        // The explicitly selected HOME is already mounted above; avoid
        // publishing a duplicate Docker mount when it is also an approved
        // provider-input root.
        if (root === this.providerFixtureHome || root === this.testRoot || root === this.buildDir
          || this.phase2WorkspaceRoots().includes(root)) continue
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
    if (options.operatorHome) args.push('--operator-home', options.operatorHome)
    const containerId = docker(args).trim()
    if (!/^[0-9a-f]{64}$/.test(containerId)) throw new Error(`supervisor docker run returned invalid id: ${containerId}`)
    this.trackedSupervisorContainers.add(containerId)
    this.trackedContainers.add(containerId)
    const instance: SupervisorInstance = { scenarioId, containerId, controlSocket, controlSecret, controlSecretFile, runtimeRoot, volumeName, binaryKind }
    this.recordLifecycle('supervisor.started', { scenarioId, containerId, binaryKind, crashPoint: options.crashPoint, dbFailpoint: options.dbFailpoint, volumeName })
    if (options.waitForHealth !== false) {
      const health = await this.waitForSupervisorHealth(instance)
      if (this.phase >= 2 && dockerIsRootless()) {
        const metadata = JSON.parse(docker(['volume', 'inspect', volumeName]))[0]
        if (!this.trackedVolumes.has(volumeName) || metadata?.Name !== volumeName
          || metadata.Driver !== 'local' || typeof metadata.Mountpoint !== 'string') {
          throw new Error('owned supervisor registry mount is unavailable')
        }
        const source: InitialProviderRegistrySource = {
          registryPath: path.join(fs.realpathSync(metadata.Mountpoint), 'runtime.sqlite3'),
          installationId: z.string().min(1).parse(health.data.installation_id),
          imageRef: this.imageRef, hostBinaryPath: hostBinary,
          binarySha256: createHash('sha256').update(fs.readFileSync(hostBinary)).digest('hex'),
          daemonId: docker(['info', '--format', '{{.ID}}']).trim(),
        }
        this.initialProviderRegistries.set(volumeName, source)
        this.recordLifecycle('runtime.initial_provider_registry.registered', { severity: 'info', scenarioId })
      }
    }
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

  private validateSupervisorHostBinary(candidate: string): string {
    const fixture = [...this.task007Fixtures.values()].find(fixture => fixture.input.hostBinaryPath === candidate)
    if (!fixture) return this.validateRunBuildBinary(candidate, 'host')
    const resolved = fs.realpathSync(candidate)
    const info = fs.statSync(resolved)
    if (resolved !== candidate || !resolved.startsWith(`${fs.realpathSync(fixture.input.ownerRoot)}${path.sep}`)
      || !info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o550
      || task007FileHash(resolved) !== fixture.input.hostBinarySha256) {
      throw new Error('registered Task7 host artifact digest or custody changed')
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

  async adminRaw(instance: SupervisorInstance, body: any, options: { requestId?: string; auth?: string; timeoutMs?: number } = {}): Promise<AdminReply> {
    return await this.adminEnvelopeRaw(instance, {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      requestId: options.requestId ?? `request-${randomUUID()}`,
      role: 'web',
      auth: options.auth ?? instance.controlSecret,
      body,
    }, { timeoutMs: options.timeoutMs })
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

  async adminEnvelopeRaw(instance: SupervisorInstance, envelope: Record<string, unknown>, options: { timeoutMs?: number } = {}): Promise<AdminReply> {
    const payload = Buffer.from(JSON.stringify(envelope))
    const frame = Buffer.allocUnsafe(4 + payload.length)
    frame.writeUInt32BE(payload.length, 0)
    payload.copy(frame, 4)
    return await unixRoundTrip(instance.controlSocket, frame, options.timeoutMs) as AdminReply
  }

  async adminOversizedFrame(instance: SupervisorInstance, announcedBytes = 1024 * 1024 + 1): Promise<AdminReply> {
    const frame = Buffer.allocUnsafe(4)
    frame.writeUInt32BE(announcedBytes, 0)
    return await unixRoundTrip(instance.controlSocket, frame) as AdminReply
  }

  async adminOk(instance: SupervisorInstance, body: any, options: { requestId?: string; auth?: string; timeoutMs?: number } = {}): Promise<any> {
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

  async fixtureNativeState(instance: SupervisorInstance, handle: ExactRuntimeHandle, capture?: (value: unknown) => void): Promise<FixtureNativeState> {
    await assertExactRuntimeHandle(this.ownerFactsAdapter(instance), handle)
    const value = JSON.parse(this.execOwnedContainerAsExact(handle.containerId, '65534:0', [
      'cat', '/home/freshell/provider/.freshell-fixture/provider-native-state.json',
    ]))
    const state = decodeFixtureNativeState(value, handle.nativeSessionId)
    capture?.(value)
    return state
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
      encoding: 'utf8', timeout: this.transferRemaining(containerId), killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
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
    const output = this.transferPolicy ? this.transferDocker(['inspect', containerId]) : docker(['inspect', containerId])
    return JSON.parse(output)[0]
  }

  isContainerRunning(containerId: string, requireObservation = false): boolean {
    const result = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', containerId], { encoding: 'utf8' })
    const running = result.stdout?.trim()
    if (requireObservation && (result.status !== 0 || !['true', 'false'].includes(running))) {
      throw new Error('exact container running-state inspection is unavailable or malformed')
    }
    if (result.status !== 0) return false
    return running === 'true'
  }

  containerLogs(containerId: string): string {
    const result = spawnSync('docker', ['logs', containerId], { encoding: 'utf8' })
    return `${result.stdout ?? ''}${result.stderr ?? ''}`.slice(-20_000)
  }

  stopSupervisorExact(instance: SupervisorInstance, requireObservation = false): void {
    if (this.isContainerRunning(instance.containerId, requireObservation)) {
      const result = spawnSync('docker', ['stop', '-t', '2', instance.containerId], { encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr || `docker stop failed for ${instance.containerId}`)
    }
    if (requireObservation && this.isContainerRunning(instance.containerId, true)) {
      throw new Error('exact supervisor stopped state was not confirmed')
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
    if (this.phase >= 2) {
      const selected = process.env.FRESHELL_RUNTIME_WORKLOAD_IMAGE_DIGEST
      if (selected !== undefined) {
        if (!/^sha256:[a-f0-9]{64}$/.test(selected)) throw new Error('selected workload image must be an exact digest')
        const source = captureRuntimeCandidate(this.repoRoot)
        if (source.dirty || source.sha !== this.candidateSha) throw new Error('selected workload image requires the current clean candidate source')
        const inspected = z.array(z.object({ Id: z.literal(selected), Config: z.object({ Labels: z.record(z.string(), z.string()) }) }))
          .length(1).safeParse(JSON.parse(docker(['image', 'inspect', selected])))
        if (!inspected.success) throw new Error('selected workload image does not resolve to its exact digest')
        const labels = inspected.data[0]!.Config.Labels
        if (labels[RUNTIME_IMAGE_LABELS.candidate] !== this.candidateSha
          || labels[RUNTIME_IMAGE_LABELS.sourceState] !== `${this.candidateSha}:clean`) {
          throw new Error('selected workload image candidate or source differs')
        }
        // A selected digest is borrowed. Only the original builder owns its tag.
        this.imageRef = selected
        this.recordLifecycle('runtime.workload_image_admitted', { digest: selected })
        return
      }
      this.ownedRuntimeImage = { tag: runOwnedRuntimeImageTag(this.runId, this.candidateSha), runId: this.runId, candidateSha: this.candidateSha }
      const image = buildRunOwnedRuntimeImage(this.repoRoot, this.runId, this.candidateSha)
      this.ownedRuntimeImage.digest = image.digest
      this.imageRef = image.digest
      this.recordLifecycle('runtime.owned_image_built', { tag: image.tag, digest: image.digest })
      return
    }
    const tag = PHASE1_RUNTIME_IMAGE_TAG
    let inspect = spawnSync('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'], { encoding: 'utf8' })
    if (inspect.status !== 0) {
      docker(['pull', tag])
      inspect = spawnSync('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'], { encoding: 'utf8' })
    }
    this.imageRef = inspect.stdout.trim()
    if (!/^sha256:[0-9a-f]{64}$/.test(this.imageRef)) throw new Error(`runtime image is not pinned: ${this.imageRef}`)
  }

  private phase2BootstrapFiles(): string[] {
    if (this.fixtureInputs) {
      return this.fixtureInputs.bootstrapFiles.map(selected => validateOwnedFixturePath(selected, 'file', 'bootstrap fixture input'))
    }
    if (this.task2FiniteFixtures) return []
    if (this.ownerIsolation) return [...new Set(this.ownerIsolation.bootstrapProviders.flatMap(provider => configuredProviderOnecliGrantFiles(provider, process.env)))]
    return phase2BootstrapFiles()
  }

  private phase2WorkspaceRoots(): string[] {
    if (this.fixtureInputs) {
      return this.fixtureInputs.workspaceRoots.map(selected => validateOwnedFixturePath(selected, 'directory', 'workspace fixture root'))
    }
    if (this.task2FiniteFixtures) return [this.testRoot]
    const roots = new Set<string>([this.repoRoot, this.testRoot])
    try {
      const common = git(this.repoRoot, ['rev-parse', '--git-common-dir']).trim()
      roots.add(fs.realpathSync(path.isAbsolute(common) ? common : path.join(this.repoRoot, common)))
    } catch {}
    return [...roots]
  }

  private phase2ProviderInputRoots(): string[] {
    if (!this.fixtureInputs?.providerInputRoots) return []
    return this.fixtureInputs.providerInputRoots.map(selected =>
      validateOwnedFixturePath(selected, 'directory', 'provider input fixture root'))
  }

  private phase2ProviderUserRoots(): string[] {
    if (this.providerFixtureHome === undefined && (this.task2FiniteFixtures || this.ownerIsolation)) return runtimeProviderUserRoots(true)
    const home = this.providerFixtureHome ?? os.homedir()
    const validateFixtureDirectory = (selected: string) => validateOwnedFixturePath(selected, 'directory', 'provider fixture root')
    if (this.providerFixtureHome !== undefined) validateFixtureDirectory(home)
    let opencodeRoot = path.join(home, '.config/opencode')
    if (this.providerFixtureHome !== undefined && this.providerFixtureXdgConfigHome !== undefined) {
      const selected = this.providerFixtureXdgConfigHome
      const relative = path.relative(home, selected)
      const nativeRoots = ['.claude/projects', '.codex/sessions', '.amplifier/projects', '.local/share/opencode']
      if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)
        || nativeRoots.some(root => relative === root || relative.startsWith(`${root}${path.sep}`))) {
        throw new Error('provider fixture XDG root must remain outside native stores within its owned HOME')
      }
      validateFixtureDirectory(selected)
      opencodeRoot = path.join(selected, 'opencode')
    }
    const roots: string[] = []
    for (const selected of [path.join(home, '.claude'), path.join(home, '.codex'), opencodeRoot, path.join(home, '.amplifier')]) {
      try {
        const root = fs.realpathSync(selected)
        const metadata = fs.lstatSync(root)
        if (this.providerFixtureHome !== undefined) validateFixtureDirectory(selected)
        if (metadata.isDirectory()) roots.push(root)
      } catch (error) {
        if (this.providerFixtureHome !== undefined && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return roots
  }

  private buildBinaries(): void {
    fs.mkdirSync(this.buildDir, { recursive: true })
    this.testSupervisorBinary = path.join(this.buildDir, 'freshell-supervisor-test')
    this.testHostBinary = path.join(this.buildDir, 'freshell-session-host-test')
    this.releaseSupervisorBinary = path.join(this.buildDir, 'freshell-supervisor-release')
    this.releaseHostBinary = path.join(this.buildDir, 'freshell-session-host-release')
    const prepared = preparedRuntimeBinary(this.repoRoot, 'supervisor-test')
    if (prepared) {
      for (const [source, destination] of [
        [prepared, this.testSupervisorBinary],
        [preparedRuntimeBinary(this.repoRoot, 'host-test')!, this.testHostBinary],
        [preparedRuntimeBinary(this.repoRoot, 'supervisor-release')!, this.releaseSupervisorBinary],
        [preparedRuntimeBinary(this.repoRoot, 'host-release')!, this.releaseHostBinary],
      ]) fs.copyFileSync(source, destination)
      return
    }
    const mise = path.join(os.homedir(), '.local', 'bin', 'mise')
    runtimeCargoBuildAndCopy(this.repoRoot, mise, ['exec', 'rust@1.96', '--', 'cargo', 'build', '-p', 'freshell-supervisor', '-p', 'freshell-session-host', '--features', 'freshell-supervisor/runtime-test-faults,freshell-session-host/fresh-agent-fixtures'], [
      { source: cargoArtifactPath(this.repoRoot, 'debug', 'freshell-supervisor'), target: this.testSupervisorBinary },
      { source: cargoArtifactPath(this.repoRoot, 'debug', 'freshell-session-host'), target: this.testHostBinary },
    ])

    runtimeCargoBuildAndCopy(this.repoRoot, mise, ['exec', 'rust@1.96', '--', 'cargo', 'build', '--release', '-p', 'freshell-supervisor', '-p', 'freshell-session-host'], [
      { source: cargoArtifactPath(this.repoRoot, 'release', 'freshell-supervisor'), target: this.releaseSupervisorBinary },
      { source: cargoArtifactPath(this.repoRoot, 'release', 'freshell-session-host'), target: this.releaseHostBinary },
    ])
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

function brokerRequestStatus(socketPath: string, method: 'GET' | 'DELETE', url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: url, method }, response => {
      response.resume()
      response.once('error', reject)
      response.once('end', () => resolve(response.statusCode ?? 0))
    })
    request.once('error', reject)
    request.end()
  })
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

function cargoArtifactPath(repoRoot: string, profile: 'debug' | 'release', binary: string): string {
  // Cargo resolves an explicit relative target directory from its build cwd.
  // Copy only that build's outputs; a stale default target is never a fallback.
  return path.join(runtimeCargoTargetDirectory(repoRoot), profile, binary)
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
type FixtureOnecliReferenceKey = `FRESHELL_MANAGED_${'CLAUDE' | 'CODEX' | 'OPENCODE'}_ONECLI_${'ENV' | 'AUTH' | 'CA'}_FILE`
export type RuntimeWebConstructOptions = {
  binary: string; repoRoot: string; preserveHomeOnStop: boolean; homeDir?: string
  candidateSha: string; buildDirty: boolean
  env: Record<string, string>; setupHome: (homeDir: string) => Promise<void>
  writeDiagnosticArtifact?: (fileName: string, value: unknown) => string
  stripEnvPrefixes?: string[]
  providerFreeFixture?: boolean
  fixtureOnecliReferences?: Partial<Record<FixtureOnecliReferenceKey, string>>
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

/** Fixture isolation keeps only explicitly supplied references; requested scrubs still win. */
export function stripRuntimeWebEnvironment(env: NodeJS.ProcessEnv,
  options: Pick<RuntimeWebConstructOptions, 'stripEnvPrefixes' | 'providerFreeFixture' | 'fixtureOnecliReferences'>): void {
  const references = options.providerFreeFixture ? Object.entries(options.fixtureOnecliReferences ?? {}).filter(([key, value]) => (
    /^FRESHELL_MANAGED_(CLAUDE|CODEX|OPENCODE)_ONECLI_(ENV|AUTH|CA)_FILE$/.test(key)
    && typeof value === 'string' && value.trim().length > 0 && env[key] === value
    && !(options.stripEnvPrefixes ?? []).some(prefix => key.startsWith(prefix))
  )) : []
  const prefixes = runtimeWebStripPrefixes(options)
  for (const key of Object.keys(env)) if (prefixes.some(prefix => key.startsWith(prefix))) delete env[key]
  for (const [key, value] of references) env[key] = value
}

function fixtureOnecliReferences(serverEnv: Record<string, string>, fixtureModes: readonly string[]) {
  const references: Partial<Record<FixtureOnecliReferenceKey, string>> = {}
  const families = new Set<'CLAUDE' | 'CODEX' | 'OPENCODE'>()
  for (const mode of fixtureModes) {
    if (mode === 'freshclaude' || mode === 'kilroy') families.add('CLAUDE')
    else if (mode === 'freshcodex') families.add('CODEX')
    else if (mode === 'freshopencode') families.add('OPENCODE')
  }
  for (const family of families) for (const kind of ['ENV', 'AUTH', 'CA'] as const) {
    const key: FixtureOnecliReferenceKey = `FRESHELL_MANAGED_${family}_ONECLI_${kind}_FILE`
    if (serverEnv[key]?.trim()) references[key] = serverEnv[key]
  }
  return references
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
  nativeIdentityObservation?: z.infer<typeof ManagedRuntimeNativeIdentityObservationSchema>
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

function freshCodexFixtureTranscriptPath(nativeId: string): string {
  return `/home/freshell/provider/.codex/sessions/rollout-fixture-${nativeId}.jsonl`
}

function freshCodexSavedTranscript(nativeId: string): string {
  return [
    JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd: '/workspace', model_provider: 'openai' } }),
    ...Array.from({ length: 80 }, (_, index) => [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: `retained-${index}` } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: `Managed prompt ${index}` } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: `retained-${index}`,
        last_agent_message: `${index === 79 ? 'Managed fixture saved answer' : `Managed retained answer ${index}`}\n${'x'.repeat(20_000)}` } }),
    ]).flat(),
  ].join('\n') + '\n'
}

function hasFreshCodexFixtureTextContent(content: unknown, type: 'input_text' | 'output_text'): boolean {
  return Array.isArray(content) && content.length === 1
    && content[0]?.type === type && typeof content[0].text === 'string'
    && content[0].text.trim().length > 0
}

function preservesFreshCodexSavedTranscript(raw: string, nativeId: string): boolean {
  const seed = freshCodexSavedTranscript(nativeId)
  if (raw === seed) return true
  if (!raw.startsWith(seed)) return false
  // This fixed fixture intentionally sends one new turn. Its original
  // retained bytes must survive, followed only by that completed native turn.
  try {
    const [context, user, assistant, complete, ...extra] = raw.slice(seed.length).trimEnd().split('\n').map(line => JSON.parse(line))
    return extra.length === 0
      && context?.type === 'turn_context' && typeof context.payload?.turn_id === 'string' && context.payload.turn_id.length > 0
      && user?.type === 'response_item' && user.payload?.type === 'message' && user.payload.role === 'user'
      && hasFreshCodexFixtureTextContent(user.payload.content, 'input_text')
      && assistant?.type === 'response_item' && assistant.payload?.type === 'message' && assistant.payload.role === 'assistant'
      && hasFreshCodexFixtureTextContent(assistant.payload.content, 'output_text')
      && complete?.type === 'event_msg' && complete.payload?.type === 'task_complete'
      && complete.payload.turn_id === context.payload.turn_id
  } catch {
    return false
  }
}

/**
 * Owned managed-runtime browser rig: restricted Docker broker + supervisor +
 * a feature-enabled Rust web server. Web restart methods touch only the web
 * process; dynamic session-host containers are outside its process tree and
 * remain owned by the supervisor/harness receipts.
 */
export type ManagedEnvironmentInputs = RuntimeFixtureInputs & { defaultCwd: string }

export class ManagedRuntimeOwner {
  readonly repoRoot: string
  readonly runtime: RuntimeHarness
  supervisor!: SupervisorInstance
  web!: RuntimeWebHandle
  info!: RuntimeWebInfo
  private serverBin = ''
  private readonly serverEnv: Record<string, string>
  private webHomeDir: string | undefined
  private readonly defaultCwd: string
  private readonly resolvedOperatorHome: string | undefined
  private readonly supervisorEnv: Record<string, string>
  private readonly supervisorBinaryKind: 'test' | 'release'
  private readonly enabledProviders: string[]
  private readonly providerSettings: Record<string, Record<string, unknown>>
  private readonly freshAgentModes: string[]
  private readonly fixtureFreshAgentModes: string[]
  private qualificationSupervisorBin: string | undefined
  private stopSettlement?: Promise<{ ok: boolean; errors: string[] }>
  private readonly heldHosts = new Map<string, { handle: ExactRuntimeHandle; pid: number }>()
  private readonly recordedHistoryHolds = new Set<string>()
  private readonly savedHistoryFixtureStates = new Map<string, unknown>()
  private readonly nativeChallenges = new Map<string, { soulId: string; nativeSessionId: string; marker: string }>()
  private readonly freshNativeProcesses = new Map<string, z.infer<typeof FreshNativeProcessSchema>>()
  private readonly freshNativeCollections = new Map<string, FreshNativeCollection>()
  private readonly freshBrowserCollections = new Map<string, { routes: any[]; auxiliarySoulId?: string; ui?: any }>()
  private readonly freshBrowserChallenges = new Map<string, any>()
  private readonly freshApprovalChallenges = new Map<string, any>()
  private readonly freshWebRestarts: any[] = []
  private readonly freshSupervisorRestarts: any[] = []
  private readonly nativeCaptures = new Set<Promise<unknown>>()
  private readonly nativeCaptureFailures: string[] = []
  private nativeHistoryTool?: string
  private nativeHistoryToolFailure?: Error
  private nativeCollectionsClosing = false
  private nativeCollectionsAborted = false
  private readonly providerProbes = new Map<string, { child?: ChildProcess; settlement: Promise<string> }>()
  private syntheticSource?: { source: SyntheticSource; root: string; nonce: string }
  private stoppedRepairBatch?: Task007PreparedStoppedFixture
  private stoppedRepairSourceIdentity?: { file: string; sha256: string }
  private stoppedRepairSourceFault?: { original: Buffer; expectedSha256: string; active: boolean }
  private stoppedRepairWithdrawalFault?: { file: string; sha256: string; dev: number; ino: number; removed: boolean; activationComplete: boolean }
  private stoppedRepairWebStopped = false
  private stoppedRepairFaultPreset: SyntheticStoppedRepairFault = 'none'
  private runtimePreparation?: Promise<void>
  private receiptCandidateBefore?: RuntimeCandidateIntegrity
  private chaosEvidencePublished = false
  private lossRecovery?: { handle: ExactRuntimeHandle; incidentId: string }
  private lossIncidentNativeHash?: string
  private lossAssertionsPublished = false
  private readonly terminalChildren = new Map<string, number>()
  private readonly openCodeReadiness = new Map<string, OpencodeReplacementReadiness>()
  private interruptedStop?: {
    handle: ExactRuntimeHandle; volumeName: string; runtimeRoot: string; scenarioId: string
    crashSupervisorId?: string; crash?: InterruptedOrdinaryStopCrashFacts; countersInstalled: boolean
  }

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
    fixtureInputsOrIsolation?: ManagedEnvironmentInputs | RuntimeOwnerIsolation,
    operatorHome?: string,
    ownerIsolation?: RuntimeOwnerIsolation,
  ) {
    this.repoRoot = fs.realpathSync(repoRoot)
    const fixtureInputs = fixtureInputsOrIsolation && 'workspaceRoots' in fixtureInputsOrIsolation ? fixtureInputsOrIsolation : undefined
    const isolation = fixtureInputsOrIsolation && 'bootstrapProviders' in fixtureInputsOrIsolation ? fixtureInputsOrIsolation : ownerIsolation
    this.runtime = new RuntimeHarness(this.repoRoot, undefined, phase, webHomeDir, serverEnv.XDG_CONFIG_HOME, fixtureInputs, isolation)
    this.defaultCwd = fixtureInputs?.defaultCwd ?? this.repoRoot
    if (fixtureInputs && !fixtureInputs.workspaceRoots.includes(this.defaultCwd)) {
      throw new Error('managed environment default cwd must be an explicitly selected workspace')
    }
    this.resolvedOperatorHome = operatorHome === undefined ? undefined
      : path.isAbsolute(operatorHome) ? operatorHome : path.join(this.runtime.testRoot, operatorHome)
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

  get workspaceCwd(): string { return this.stoppedRepairBatch?.input.workspacePath ?? this.defaultCwd }

  get operatorHomePath(): string | undefined { return this.resolvedOperatorHome }

  async prepareSyntheticStoppedRepairBatch(): Promise<SyntheticStoppedRepairBatchFacts> {
    if (this.stoppedRepairBatch) return this.syntheticStoppedRepairBatchFacts()
    if (process.env.FRESHELL_RUNTIME_SYNTHETIC_RESUME !== '1' || this.runtime.phase !== 3
      || this.enabledProviders.length !== 0 || this.freshAgentModes.length !== 0
      || this.supervisorBinaryKind !== 'test' || this.web || this.stopSettlement || this.syntheticSource || this.webHomeDir) {
      throw new Error('stopped repair batch requires an isolated grant-free phase-three owner before web setup')
    }
    const preparation = this.runtime.prepareTask007StoppedFixture('browser')
    this.runtimePreparation = preparation.then(() => undefined)
    await this.runtimePreparation
    this.stoppedRepairBatch = await preparation
    this.stoppedRepairSourceIdentity = { file: fs.realpathSync(this.stoppedRepairBatch.sourceDatabaseFile),
      sha256: task007FileHash(this.stoppedRepairBatch.sourceDatabaseFile) }
    this.webHomeDir = path.join(this.runtime.testRoot, 'task007-browser-web-home')
    ensurePrivateDirectory(this.webHomeDir)
    this.serverEnv.OPENCODE_DB = this.stoppedRepairBatch.sourceDatabaseFile
    this.supervisorEnv.OPENCODE_DB = this.stoppedRepairBatch.sourceDatabaseFile
    return this.syntheticStoppedRepairBatchFacts()
  }

  private registeredStoppedRepairBatch(fixtureId?: string): Task007PreparedStoppedFixture {
    const batch = this.stoppedRepairBatch
    if (!batch || (fixtureId !== undefined && fixtureId !== batch.input.fixtureId)
      || batch.input.runId !== this.runtime.runId || batch.input.candidateSha !== this.runtime.candidateSha) {
      throw new Error('exact registered stopped repair fixture required')
    }
    return batch
  }

  async syntheticStoppedRepairBatchFacts(): Promise<SyntheticStoppedRepairBatchFacts> {
    const batch = this.registeredStoppedRepairBatch()
    return SyntheticStoppedRepairBatchFactsSchema.parse({ fixtureId: batch.input.fixtureId,
      activity: await this.readTask007Activity(batch),
      sourceStoreId: createHash('sha256').update(await fsp.realpath(batch.sourceDatabaseFile)).digest('hex'),
      families: batch.source.families.map(family => ({ rootId: family.rootId, childId: family.childId,
        grandchildId: family.grandchildId, baselineMessages: Object.fromEntries(family.baselineMessages),
        baselineParts: Object.fromEntries(family.baselineParts) })),
      targets: batch.output.targets.map((target, index) => ({ soulId: target.soulId, providerStoreId: target.providerStoreId,
        rootSessionId: target.rootSessionId, terminalId: batch.input.targets[index].terminalId,
        streamId: batch.input.targets[index].streamId, incidentId: target.incidentId, viewIds: target.viewIds })),
      canonicalChoices: batch.output.canonicalChoices.map(({ rootSessionId, soulId }) => ({ rootSessionId, soulId })),
      unrelated: { soulId: batch.output.unrelated.soulId, incidentId: batch.output.unrelated.incidentId,
        viewId: batch.output.unrelated.viewId, noticeIds: batch.output.unrelated.noticeIds,
        outboxEventIds: batch.output.unrelated.outboxEventIds,
        exportSha256: batch.output.unrelated.exports.map(artifact => artifact.sha256) },
    })
  }

  private async readTask007Activity(batch: Task007PreparedStoppedFixture): Promise<z.infer<typeof Task007ActivitySchema>> {
    const targetIds = new Set(batch.output.targets.map(target => target.containerId))
    const soulIds = new Set(batch.output.targets.map(target => target.soulId))
    const providerIds = new Set(this.runtime.broker.receipts().filter(receipt => soulIds.has(receipt.soulId)).map(receipt => receipt.containerId))
    const ownerEvents = await this.readOwnedLifecycle('owner')
    const setupHelpersCompleted = ownerEvents.filter(event => {
      if (event.event !== 'task007.provider_home.initialized') return false
      const data = z.object({ fixtureId: Task007Id, ownerContainerId: Task007Hex }).parse(event.data)
      if (data.fixtureId !== batch.input.fixtureId) return false
      if (!targetIds.has(data.ownerContainerId)) throw new Error('setup completion belongs to an unregistered container')
      return true
    }).length
    const brokerEvents = this.runtime.broker.eventsSnapshot()
    const registeredHelperIds = new Set(brokerEvents.flatMap(event => event.helperName && event.containerId
      && providerIds.has(Task007Hex.parse(event.ownerContainerId)) ? [Task007Hex.parse(event.containerId)] : []))
    let helperStartRequests = 0, providerContainerStartRequests = 0
    for (const event of brokerEvents) {
      if (event.method !== 'POST' || !event.url.endsWith('/start')) continue
      const addressedId = event.url.match(/^\/v1\.47\/containers\/([a-f0-9]{64})\/start$/)?.[1]
      if (addressedId && (providerIds.has(addressedId) || registeredHelperIds.has(addressedId))
        && ['upstream_request_failed', 'upstream_response_incomplete', 'owner_request_failed', 'cleanup_deadline'].includes(event.reason ?? '')) {
        throw new Error('registered start outcome is unknown; activity cannot certify zero starts')
      }
      if (event.decision !== 'forward') continue
      const containerId = Task007Hex.parse(event.containerId)
      if (event.url !== `/v1.47/containers/${containerId}/start`) throw new Error('forwarded start address differs from recorded container')
      if (event.helperName) {
        const knownHelperName = /^freshell-history-[a-zA-Z0-9-]+$/.test(event.helperName)
          || /^freshell-opencode-repair-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(event.helperName)
        if (!knownHelperName) throw new Error('unknown registered helper start name')
        if (providerIds.has(Task007Hex.parse(event.ownerContainerId))) helperStartRequests++
      } else if (providerIds.has(containerId)) providerContainerStartRequests++
    }
    const supervisorEvents = this.supervisor ? await this.readOwnedLifecycle() : []
    const providerLaunchRunningEvents = supervisorEvents.filter(event => event.event === 'supervisor.launch_running'
      && soulIds.has(z.object({ soulId: Task007Id }).parse(event.data).soulId)).length
    return { setupHelpersCompleted, helperStartRequests, providerContainerStartRequests, providerLaunchRunningEvents }
  }

  async syntheticStoppedRepairBatchObservation(fixtureId: string, operationId: string): Promise<SyntheticStoppedRepairBatchObservation> {
    const batch = this.registeredStoppedRepairBatch(fixtureId)
    Task007Id.parse(operationId)
    if (!this.supervisor || this.supervisor.volumeName !== batch.volumeName) throw new Error('registered batch supervisor required')
    const sourceStoreId = (await this.syntheticStoppedRepairBatchFacts()).sourceStoreId
    const records = async () => this.runtime.isContainerRunning(this.supervisor.containerId, true)
      ? Task007RepairRecordsSchema.parse(JSON.parse(await this.ownedDockerProbe(
        this.supervisor.containerId, ['python3', '-I', '-c', TASK007_STOPPED_REPAIR_OBSERVATION,
          '/var/lib/freshell-supervisor/runtime.sqlite3', batch.metadataFile, operationId, '/var/lib/freshell-supervisor', sourceStoreId], false)))
      : this.runtime.readTask007StoppedRegistry(this.supervisor, fixtureId, operationId)
    const initial = await records()
    const { currentIncarnations, ...observed } = initial
    if (observed.fixtureId !== fixtureId || observed.operationId !== operationId
      || observed.souls.some(soul => !batch.output.targets.some(target => target.soulId === soul.soulId))
      || observed.roots.some(root => !batch.source.families.some(family => family.rootId === root.rootSessionId))) {
      throw new Error('current repair observation differs from registered fixture and operation')
    }
    const resumedSouls = new Set(observed.roots.filter(root => observed.souls.some(soul =>
      soul.soulId === root.canonicalSoulId && soul.desiredState === 'running')).map(root => root.canonicalSoulId))
    if (observed.souls.some(soul => soul.activeWriters !== 0 && !resumedSouls.has(soul.soulId))) {
      throw new Error('stopped store observation requires zero current writers')
    }
    const currentViews = resumedSouls.size ? await this.inventory() : []
    const selectCurrentView = (views: ManagedRuntimeView[], current?: Task007CurrentIncarnation): ManagedRuntimeView | undefined => {
      if (!current) return undefined
      const rows = views.filter(row => row.soulId === current.soulId)
      const matches = rows.filter(row => row.incarnationId === current.incarnationId)
      // Registry selects current authority; failed/stopped history is retained.
      // Another active incarnation remains a conflict on either side of the read.
      if (matches.length !== 1 || rows.some(row => row.incarnationId !== current.incarnationId
        && ['prepared', 'created', 'starting', 'running', 'stopping'].includes(row.launchState))) return undefined
      return matches[0]
    }
    const installedStores: SyntheticStoppedRepairBatchObservation['installedStores'] = []
    const nativeObservations: SyntheticStoppedRepairBatchObservation['nativeObservations'] = []
    const resumedReads: Array<{ root: SyntheticStoppedRepairBatchObservation['roots'][number]; view: ManagedRuntimeView;
      soul: z.infer<typeof Task007RepairSoulSchema>; current: Task007CurrentIncarnation; native: z.infer<typeof Task007NativeObservationSchema> }> = []
    for (const root of observed.roots) {
      const soul = observed.souls.find(soul => soul.soulId === root.canonicalSoulId)
      if (!soul || !['running', 'stopped'].includes(soul.desiredState) || soul.nativeSessionId !== root.rootSessionId
        || soul.providerStoreId !== root.destinationStoreId) throw new Error('current store/root differs from repair receipt')
      let view: ManagedRuntimeView | undefined
      if (soul.desiredState === 'running') {
        const current = currentIncarnations.find(current => current.soulId === soul.soulId)
        view = selectCurrentView(currentViews, current)
        if (!view || !current || view.incarnationId !== current.incarnationId
          || (view.containerId ?? null) !== current.containerId || (view.hostBootId ?? null) !== current.hostBootId
          || view.launchState !== current.launchState || view.executionGeneration !== current.executionGeneration
          || view.provider !== 'opencode' || view.nativeSessionId !== root.rootSessionId
          || view.intentRevision !== soul.intentRevision || view.desiredState !== soul.desiredState
          || view.recoveryState !== soul.recoveryState || soul.activeWriters > 1
          || (!view.containerId && soul.activeWriters !== 0)
          || (view.launchState === 'stopped' && soul.activeWriters !== 0)
          || soul.writerClaims.some(writer => writer.soulId !== soul.soulId || writer.incarnationId !== current.incarnationId
            || writer.intentRevision !== soul.intentRevision || writer.provider !== 'opencode'
            || writer.providerStoreId !== soul.providerStoreId || writer.nativeSessionId !== root.rootSessionId)) {
          throw new Error('current canonical address or writer ownership differs from registered repair')
        }
        const native = await this.readTask007NativeObservation(root, soul, view, current)
        nativeObservations.push(native)
        resumedReads.push({ root, soul, view, current, native })
      } else nativeObservations.push({ rootSessionId: root.rootSessionId, canonicalSoulId: root.canonicalSoulId,
        state: 'unavailable', reason: 'stopped' })
      installedStores.push(await this.readTask007InstalledStore(batch, root, view))
    }
    for (const { root, soul, view, current, native } of resumedReads) {
      const after = selectCurrentView(await this.inventory(), current)
      if (!after || JSON.stringify(after) !== JSON.stringify(view)
        || JSON.stringify(await this.readTask007NativeObservation(root, soul, after, current)) !== JSON.stringify(native)) {
        throw new Error('current native Resume observation changed during installed store read')
      }
    }
    if (JSON.stringify(await records()) !== JSON.stringify(initial)) throw new Error('current stopped repair records changed during independent store observation')
    return SyntheticStoppedRepairBatchObservationSchema.parse({ ...observed, roots: observed.roots.map(({ descriptor: _descriptor, readable: _readable, ...root }) => root), installedStores, nativeObservations,
      activity: await this.readTask007Activity(batch), faultMarkers: await this.readTask007FaultMarkers(currentIncarnations) })
  }

  private async readTask007FaultMarkers(current: Task007CurrentIncarnation[]): Promise<z.infer<typeof Task007FaultMarkersSchema>> {
    const preset = this.stoppedRepairFaultPreset
    let crash: z.infer<typeof Task007FaultMarkersSchema>['crash'] = null
    if (['after_import_publication', 'after_repair_cas_before_withdrawal', 'during_withdrawal_before_ack'].includes(preset)) {
      for (const line of this.runtime.containerLogs(this.supervisor.containerId).split('\n').filter(Boolean)) {
        let row: unknown
        try { row = JSON.parse(line) }
        catch { if (line.includes('supervisor.test_crash')) throw new Error('current stopped-repair crash marker is malformed'); continue }
        const candidate = z.object({ event: z.string().optional() }).passthrough().parse(row)
        if (candidate.event !== 'supervisor.test_crash') continue
        const marker = z.object({ event: z.literal('supervisor.test_crash'), point: Task007CrashPointSchema }).strict().parse(row)
        if (marker.point !== `stopped_repair_${preset}` || crash) throw new Error('current stopped-repair crash marker conflicts with selected seam')
        const state = z.object({ State: z.object({ Running: z.boolean(), ExitCode: z.number().int() }) })
          .parse(this.runtime.inspectContainer(this.supervisor.containerId)).State
        crash = { point: marker.point, running: state.Running, exitCode: state.ExitCode }
      }
    }
    const firstResumeObservationFailures: z.infer<typeof Task007FaultMarkersSchema>['firstResumeObservationFailures'] = []
    if (preset === 'first_resume_observation') {
      for (const event of await this.readOwnedLifecycle()) {
        if (event.event !== 'supervisor.stopped_repair_resume_observation_test_failure') continue
        const marker = z.object({ soulId: Task007Id, incarnationId: Task007Id, executionGeneration: z.number().int().positive() }).parse(event.data)
        if (current.some(row => row.soulId === marker.soulId && row.incarnationId === marker.incarnationId)) firstResumeObservationFailures.push(marker)
      }
    }
    return { preset, supervisorContainerId: this.supervisor.containerId, crash, firstResumeObservationFailures }
  }

  private async readTask007NativeObservation(root: SyntheticStoppedRepairBatchObservation['roots'][number],
    soul: z.infer<typeof Task007RepairSoulSchema>, view: ManagedRuntimeView,
    current: Task007CurrentIncarnation): Promise<z.infer<typeof Task007NativeObservationSchema>> {
    if (view.launchState !== 'running' || !view.containerId || !view.hostBootId || !view.terminalId) {
      return { rootSessionId: root.rootSessionId, canonicalSoulId: soul.soulId, state: 'unavailable', reason: 'host_unavailable' }
    }
    const host = z.union([ManagedOpenCodeAdoptionStatusSchema, z.object({ state: z.literal('unavailable') }).strict()])
      .parse(JSON.parse(await this.ownedDockerProbe(this.supervisor.containerId,
      ['node', '--no-warnings', '-e', TASK007_HOST_ADOPTION_PROBE,
        path.join(this.repoRoot, 'test/e2e-browser/fixtures/managed-opencode-host-status.cjs'),
        this.runtime.runtimeDir(this.supervisor, current.incarnationId), current.incarnationId, view.hostBootId], false)))
    if (host.state === 'unavailable') return { rootSessionId: root.rootSessionId,
      canonicalSoulId: soul.soulId, state: 'unavailable', reason: 'host_unavailable' }
    let hostStatus: z.infer<typeof Task007SafeAdoptionSchema>
    if (host.state === 'observed') {
      const { launchNonce, ...observation } = host.data.observation
      // Adoption has its own attempt nonce; the authenticated host applies
      // its production expectation gate, independently of Registry launch identity.
      if (!/^[a-f0-9]{32}$/.test(launchNonce) || !/^[a-f0-9]{64}$/.test(observation.evidenceGeneration)
        || observation.incarnationId !== current.incarnationId
        || observation.rootSessionId !== root.rootSessionId || observation.terminalId !== view.terminalId) {
        throw new Error('current native host observation nonce, generation, incarnation, terminal or root differs')
      }
      hostStatus = { state: 'observed', ...observation, launchNonceSha256: sha256(launchNonce) }
    } else hostStatus = host
    let registryNativeObservation: z.infer<typeof ManagedRuntimeNativeIdentityObservationSchema> | null = null
    if (view.nativeIdentityObservation) {
      const registry = ManagedRuntimeNativeIdentityObservationSchema.parse(view.nativeIdentityObservation)
      if (registry.launchNonce !== current.launchNonce || registry.incarnationId !== current.incarnationId
        || registry.nativeSessionId !== root.rootSessionId || registry.evidenceRevision !== view.evidenceRevision
        || registry.source !== 'opencode_tui') throw new Error('current persisted native identity address or evidence revision differs')
      registryNativeObservation = registry
    }
    const { launchNonce: registryNonce, ...safeRegistry } = registryNativeObservation ?? { launchNonce: '' }
    return Task007NativeObservationSchema.parse({ rootSessionId: root.rootSessionId, canonicalSoulId: soul.soulId,
      state: 'current', incarnationId: current.incarnationId, containerId: view.containerId,
      hostBootId: view.hostBootId, terminalId: view.terminalId, intentRevision: soul.intentRevision,
      nativeImportRevision: soul.nativeImportRevision, executionGeneration: current.executionGeneration,
      evidenceRevision: view.evidenceRevision, launchState: view.launchState, recoveryState: soul.recoveryState,
      hostStatus, registryNativeObservation: registryNativeObservation ? { ...safeRegistry, launchNonceSha256: sha256(registryNonce) } : null })
  }

  private async readTask007InstalledStore(batch: Task007PreparedStoppedFixture,
    root: z.infer<typeof Task007RepairRecordsSchema>['roots'][number], view?: ManagedRuntimeView): Promise<SyntheticStoppedRepairBatchObservation['installedStores'][number]> {
    // A failed pre-create incarnation has no enclosure. Its installed volume
    // remains bound to the exact historical fixture receipt, independently of
    // the current failed incarnation selected by the observation above.
    const readerView = view?.containerId ? view : undefined
    const target = batch.output.targets.find(target => target.soulId === root.canonicalSoulId
      && target.providerStoreId === root.destinationStoreId && target.rootSessionId === root.rootSessionId)
    const receipt = target && this.runtime.broker.receipts().find(receipt => receipt.containerId === (readerView?.containerId ?? target.containerId)
      && receipt.soulId === target.soulId && receipt.incarnationId === (readerView?.incarnationId ?? target.incarnationId))
    if (!target || !receipt || receipt.providerVolumeName !== target.providerVolumeName
      || receipt.imageRef !== this.runtime.imageRef || receipt.workspacePath !== batch.input.workspacePath
      || receipt.hostBinaryPath !== batch.input.hostBinaryPath) throw new Error('registered stopped store has no exact current-image receipt')
    const state = z.array(z.object({ Id: z.literal(receipt.containerId), State: z.object({ Running: z.literal(readerView?.launchState === 'running') }) })).length(1)
    state.parse(JSON.parse(await this.trackedDockerProbe(receipt.containerId, ['inspect', receipt.containerId])))
    const selected = { providerStoreId: root.destinationStoreId, nativeSessionId: root.rootSessionId,
      imageRef: this.runtime.imageRef, providerHome: '/home/freshell/provider', workspacePath: batch.input.workspacePath,
      cwd: batch.input.cwd, providerUid: 65534, providerGid: 0 }
    const name = `freshell-history-${randomUUID()}`
    const probe = (args: string[]) => this.trackedDockerProbe(receipt.containerId, args, true)
    let failure: unknown
    try {
      const id = (await probe(['create', '--name', name, '--user', '65534:0', '--network', 'none', '--read-only',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '256m', '--memory-swap', '256m',
        '--cpus', '0.5', '--pids-limit', '32', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
        '--env', 'HOME=/home/freshell/provider', '--env', 'XDG_DATA_HOME=/home/freshell/provider/.local/share',
        '--env', 'XDG_CONFIG_HOME=/home/freshell/provider/.config', '--env', 'OPENCODE_DB=/home/freshell/provider/.local/share/opencode/opencode.db',
        '--mount', `type=volume,source=${target.providerVolumeName},target=/home/freshell/provider,readonly`,
        '--mount', `type=bind,source=${batch.input.hostBinaryPath},target=/runtime/freshell-session-host,readonly`,
        '--mount', `type=bind,source=${batch.input.workspacePath},target=${batch.input.workspacePath},readonly`,
        '--workdir', batch.input.cwd, '--entrypoint', '/runtime/freshell-session-host', this.runtime.imageRef,
        'retained-opencode-store-worker', JSON.stringify(selected)])).trim()
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('stopped store reader returned no exact helper ID')
      await probe(['start', id])
      const exit = (await probe(['wait', id])).trim()
      const output = await probe(['logs', id])
      this.runtime.writeArtifact(`task007-store-read-${root.canonicalSoulId}.json`, { fixtureId: batch.input.fixtureId, helperId: id, exit, output })
      if (exit !== '0') throw new Error('current-image stopped store reader refused registered source')
      const measured = z.object({ request: z.object({ providerStoreId: z.literal(selected.providerStoreId), nativeSessionId: z.literal(selected.nativeSessionId),
        imageRef: z.literal(selected.imageRef), providerHome: z.literal(selected.providerHome), workspacePath: z.literal(selected.workspacePath),
        cwd: z.literal(selected.cwd), providerUid: z.literal(65534), providerGid: z.literal(0) }).strict(),
        providerVersion: Task007Id, sourceSchemaFingerprint: Task007Id, migrationJournalFingerprint: Task007Id,
        generation: Task007Id, rowCount: z.number().int().nonnegative() }).strict().parse(JSON.parse(output))
      const { readable, ...graph } = await this.readTask007InstalledGraph(batch, target, receipt, root)
      return { rootSessionId: root.rootSessionId, providerStoreId: root.destinationStoreId,
        providerUid: measured.request.providerUid, providerGid: measured.request.providerGid, providerVersion: measured.providerVersion,
        sourceSchemaFingerprint: measured.sourceSchemaFingerprint, migrationJournalFingerprint: measured.migrationJournalFingerprint,
        generation: measured.generation, rowCount: measured.rowCount, readable, ...graph }
    } catch (error) { failure = error; throw error }
    finally {
      try { await probe(['rm', '--force', name]) }
      catch (cleanupError) {
        if (failure) throw new AggregateError([failure, cleanupError], 'stopped store reader and cleanup failed')
        throw cleanupError
      }
    }
  }

  private async readTask007InstalledGraph(batch: Task007PreparedStoppedFixture,
    target: Task007FixtureOutput['targets'][number], receipt: BrokerReceipt,
    root: z.infer<typeof Task007RepairRecordsSchema>['roots'][number]): Promise<z.infer<typeof Task007InstalledGraphSchema> & { readable: z.infer<typeof Task007ReaderReceiptSchema> }> {
    const name = `freshell-history-${randomUUID()}`
    const probe = (args: string[]) => this.trackedDockerProbe(receipt.containerId, args, true)
    if (root.descriptor.targetImageRef !== receipt.imageRef) {
      throw new Error('original reader environment differs from current owned store')
    }
    const descriptorFile = path.join(receipt.runtimeDir, 'task007-reader-descriptor.frame')
    const bytes = Buffer.from(JSON.stringify(root.descriptor))
    if (bytes.length > 512 * 1024 + 16 * 1024) throw new Error('original descriptor exceeds native frame bound')
    const frame = Buffer.alloc(4 + bytes.length); frame.writeUInt32BE(bytes.length); bytes.copy(frame, 4)
    const descriptorHandle = await fsp.open(descriptorFile, 'wx', 0o444)
    try {
      let writeFailed = false
      try {
        await descriptorHandle.chmod(0o444)
        await descriptorHandle.writeFile(frame)
      }
      catch (error) { writeFailed = true; throw error }
      finally {
        try { await descriptorHandle.close() }
        // Preserve the original write failure if closing the same handle also fails.
        catch (closeError) { if (!writeFailed) throw closeError }
      }
      let failure: unknown
      try {
        const id = (await probe(['create', '--name', name, '--user', '65534:0', '--network', 'none', '--read-only',
          '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '256m', '--memory-swap', '256m',
          '--cpus', '0.5', '--pids-limit', '32', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m',
          '--env', 'HOME=/home/freshell/provider', '--env', 'XDG_DATA_HOME=/home/freshell/provider/.local/share',
          '--env', 'XDG_CONFIG_HOME=/home/freshell/provider/.config', '--env', 'OPENCODE_DB=/home/freshell/provider/.local/share/opencode/opencode.db',
          '--mount', `type=bind,source=${batch.input.hostBinaryPath},target=/runtime/freshell-session-host,readonly`,
          '--mount', `type=bind,source=${descriptorFile},target=/run/freshell-opencode-reader.frame,readonly`,
          '--mount', `type=volume,source=${receipt.providerVolumeName},target=/home/freshell/provider,readonly`,
          '--mount', `type=bind,source=${batch.input.workspacePath},target=${batch.input.workspacePath},readonly`,
          '--workdir', batch.input.cwd, '--entrypoint', 'node', this.runtime.imageRef,
          '--no-warnings', '-e', TASK007_BATCH_STORE_PROBE,
          '/home/freshell/provider/.local/share/opencode/opencode.db', target.rootSessionId, '/run/freshell-opencode-reader.frame', batch.input.workspacePath])).trim()
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('batch graph reader returned no exact helper ID')
        await probe(['start', id])
        const exit = (await probe(['wait', id])).trim()
        const output = await probe(['logs', id])
        this.runtime.writeArtifact(`task007-installed-graph-${target.soulId}.json`, { fixtureId: batch.input.fixtureId, helperId: id, exit, output })
        if (exit !== '0') throw new Error('batch installed graph reader refused registered root')
        const { readable: measured, ...graph } = Task007InstalledGraphSchema.extend({ readable: Task007ReaderReceiptSchema }).parse(JSON.parse(output))
        const readable = task007ValidateInstalledRead(root.descriptor, root.readable, measured)
        if (readable.cwd !== batch.input.cwd || readable.home !== '/home/freshell/provider'
          || readable.xdgDataHome !== '/home/freshell/provider/.local/share'
          || readable.xdgConfigHome !== '/home/freshell/provider/.config'
          || readable.opencodeDb !== '/home/freshell/provider/.local/share/opencode/opencode.db') throw new Error('fresh reader environment differs from current store')
        if (graph.parents[target.rootSessionId] !== null || new Set(graph.history.sessions).size !== graph.history.sessions.length
          || JSON.stringify([...graph.history.sessions].sort()) !== JSON.stringify(Object.keys(graph.parents).sort())) {
          throw new Error('batch graph/history closure differs from registered root')
        }
        return { ...graph, readable }
      } catch (error) { failure = error; throw error }
      finally {
        try { await probe(['rm', '--force', name]) }
        catch (cleanupError) {
          if (failure) throw new AggregateError([failure, cleanupError], 'batch graph reader and cleanup failed')
          throw cleanupError
        }
      }
    } finally { await fsp.unlink(descriptorFile) }
  }

  async setSyntheticStoppedRepairFault(fixtureId: string, preset: SyntheticStoppedRepairFault): Promise<{ controlEpoch: number | null }> {
    const batch = this.registeredStoppedRepairBatch(fixtureId)
    const fault = SyntheticStoppedRepairFaultSchema.parse(preset)
    if (this.supervisorBinaryKind !== 'test') throw new Error('stopped repair faults require the feature-built supervisor')
    if (this.supervisor && (this.supervisor.volumeName !== batch.volumeName || this.supervisor.runtimeRoot !== batch.input.runtimeRoot)) {
      throw new Error('registered batch supervisor differs')
    }
    const sourceEffect = fault === 'source_generation_change' || (fault === 'none' && Boolean(this.stoppedRepairSourceFault))
    const beforeStart = () => {
      if (sourceEffect) this.applyStoppedRepairSourceFault(batch, fault === 'source_generation_change')
      if (fault === 'pending_withdrawal' || (fault === 'none' && this.stoppedRepairWithdrawalFault)) {
        this.applyStoppedRepairWithdrawalFault(batch, fault === 'pending_withdrawal')
      }
      delete this.supervisorEnv.FRESHELL_RUNTIME_CRASH_POINT
      delete this.supervisorEnv.FRESHELL_RUNTIME_STOPPED_REPAIR_RESUME_OBSERVATION_FAIL
      if (fault === 'first_resume_observation') this.supervisorEnv.FRESHELL_RUNTIME_STOPPED_REPAIR_RESUME_OBSERVATION_FAIL = '1'
      else if (['after_import_publication', 'after_repair_cas_before_withdrawal', 'during_withdrawal_before_ack'].includes(fault)) {
        this.supervisorEnv.FRESHELL_RUNTIME_CRASH_POINT = `stopped_repair_${fault}`
      }
      this.stoppedRepairFaultPreset = fault
    }
    const restartWeb = sourceEffect || this.stoppedRepairWebStopped
    if (restartWeb) {
      this.assertStoppedRepairSourceSettled()
    }
    try {
      if (restartWeb && this.web) {
        this.stoppedRepairWebStopped = true
        await this.web.stop()
      }
      if (this.supervisor) await this.replaceSupervisor('graceful', undefined, beforeStart)
      else beforeStart()
      if (restartWeb && this.web) {
        this.info = await this.withManagedBin(() => this.web.start())
        this.stoppedRepairWebStopped = false
      }
    } catch (error) {
      if (!restartWeb) throw error
      const errors = [error]
      try { await this.web?.stop() } catch (cleanupError) { errors.push(cleanupError) }
      try { if (this.supervisor) this.runtime.stopSupervisorExact(this.supervisor) }
      catch (cleanupError) { errors.push(cleanupError) }
      if (errors.length > 1) throw new AggregateError(errors, 'stopped repair replacement and service settlement failed')
      throw error
    }
    return { controlEpoch: this.supervisor ? await this.controlEpoch() : null }
  }

  private assertStoppedRepairSourceSettled(): void {
    if (this.providerProbes.size || this.stopSettlement) throw new Error('registered source consumers are not settled')
  }

  private applyStoppedRepairSourceFault(batch: Task007PreparedStoppedFixture, activate: boolean): void {
    this.assertStoppedRepairSourceSettled()
    const identity = this.stoppedRepairSourceIdentity
    const file = batch.sourceDatabaseFile
    const info = fs.lstatSync(file)
    if (!identity || identity.file !== file || fs.realpathSync(file) !== file
      || !file.startsWith(`${fs.realpathSync(this.runtime.testRoot)}${path.sep}`)
      || !info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) {
      throw new Error('registered fictional source custody changed')
    }
    const sidecars = ['-wal', '-shm', '-journal'].map(suffix => {
      try { return { suffix, info: fs.lstatSync(`${file}${suffix}`) } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined }
    }).filter((entry): entry is { suffix: string; info: fs.Stats } => entry !== undefined)
    // A completed read-only SQLite consumer can leave an empty WAL/SHM pair.
    // Only that private, quiesced shape is eligible for SQLite's own cleanup.
    if (sidecars.length && (sidecars.length !== 2 || sidecars.some(({ suffix, info }) =>
      !info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600
      || (suffix === '-wal' ? info.size !== 0 : suffix !== '-shm' || info.size !== 32_768)))) {
      throw new Error('registered fictional source has an unsettled sidecar')
    }
    const current = fs.readFileSync(file), digest = createHash('sha256').update(current).digest('hex')
    const recorded = this.stoppedRepairSourceFault
    if (digest !== (recorded?.expectedSha256 ?? identity.sha256)) throw new Error('registered fictional source bytes changed unexpectedly')
    if (sidecars.length) {
      const db = new DatabaseSync(file)
      try {
        // Refuse a still-active writer. Checkpoint and close settle the empty
        // sidecars without applying data or changing the captured main file.
        db.exec('BEGIN IMMEDIATE; COMMIT')
        if (db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy !== 0) {
          throw new Error('registered fictional source has an unsettled sidecar')
        }
      } finally { db.close() }
      for (const suffix of ['-wal', '-shm', '-journal']) {
        if (fs.existsSync(`${file}${suffix}`)) throw new Error('registered fictional source has an unsettled sidecar')
      }
      if (task007FileHash(file) !== digest) throw new Error('registered fictional source bytes changed unexpectedly')
    }
    if (activate) {
      if (recorded) {
        if (!recorded.active) throw new Error('registered fictional source requires completion of owned restoration')
        return
      }
      const db = new DatabaseSync(file)
      const retained = { original: current, expectedSha256: digest, active: false }
      this.stoppedRepairSourceFault = retained
      let transactionOpen = false
      try {
        db.exec('BEGIN IMMEDIATE')
        transactionOpen = true
        const changed = db.prepare("UPDATE session SET title = title || ' [fictional stopped-repair generation fault]' WHERE id = ?")
          .run(batch.source.families[0].rootId)
        if (changed.changes !== 1) throw new Error('registered fictional source root is absent')
        db.exec('COMMIT')
        transactionOpen = false
      } catch (error) { if (transactionOpen) db.exec('ROLLBACK'); throw error }
      finally { db.close() }
      retained.expectedSha256 = task007FileHash(file)
      retained.active = true
    } else if (recorded) {
      const temporary = `${file}.task007-restore-${randomUUID()}`
      try {
        const fd = fs.openSync(temporary, 'wx', 0o600)
        try { fs.writeFileSync(fd, recorded.original); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
        fs.renameSync(temporary, file)
        if (task007FileHash(file) !== identity.sha256) throw new Error('registered fictional source restoration differs')
        recorded.expectedSha256 = identity.sha256
        recorded.active = false
        const directory = fs.openSync(path.dirname(file), 'r')
        try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
        this.stoppedRepairSourceFault = undefined
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
    }
  }

  private applyStoppedRepairWithdrawalFault(batch: Task007PreparedStoppedFixture, activate: boolean): void {
    const directory = path.join(path.dirname(batch.input.runtimeRoot), 'evidence')
    const file = path.join(directory, 'lifecycle.jsonl.1')
    if (!file.startsWith(`${fs.realpathSync(this.runtime.testRoot)}${path.sep}`)) throw new Error('withdrawal obstruction is outside registered owner')
    const parent = path.dirname(directory)
    if (fs.realpathSync(parent) !== parent) throw new Error('withdrawal obstruction parent custody changed')
    fs.mkdirSync(directory, { mode: 0o700, recursive: true })
    if (fs.realpathSync(directory) !== directory) throw new Error('withdrawal obstruction directory custody changed')
    const recorded = this.stoppedRepairWithdrawalFault
    if (recorded) {
      if (recorded.file !== file) throw new Error('owned withdrawal obstruction changed')
      if (recorded.removed) {
        let present = false
        try { fs.lstatSync(file); present = true }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (present) throw new Error('owned withdrawal obstruction changed after removal')
        if (activate) throw new Error('owned withdrawal obstruction requires completion of removal')
      } else {
        const info = fs.lstatSync(file)
        if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600
          || info.dev !== recorded.dev || info.ino !== recorded.ino || task007FileHash(file) !== recorded.sha256) {
          throw new Error('owned withdrawal obstruction changed')
        }
        if (activate) {
          if (!recorded.activationComplete) throw new Error('owned withdrawal obstruction requires completion of removal after failed activation')
          return
        }
        fs.unlinkSync(file)
        recorded.removed = true
      }
      const fd = fs.openSync(directory, 'r')
      try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      this.stoppedRepairWithdrawalFault = undefined
    } else if (activate) {
      if (fs.existsSync(file)) throw new Error('withdrawal obstruction already exists and is not owned')
      const content = Buffer.from('malformed fictional stopped-repair withdrawal\n')
      const fd = fs.openSync(file, 'wx', 0o600)
      const info = fs.fstatSync(fd)
      const created = { file, sha256: createHash('sha256').update('').digest('hex'), dev: info.dev, ino: info.ino, removed: false, activationComplete: false }
      this.stoppedRepairWithdrawalFault = created
      try { fs.writeFileSync(fd, content); fs.fsyncSync(fd) }
      finally {
        try {
          const current = fs.lstatSync(file)
          if (!current.isFile() || current.dev !== created.dev || current.ino !== created.ino
            || current.uid !== process.getuid?.() || current.nlink !== 1 || (current.mode & 0o777) !== 0o600) {
            throw new Error('owned withdrawal obstruction changed during activation')
          }
          created.sha256 = task007FileHash(file)
        } finally { fs.closeSync(fd) }
      }
      created.activationComplete = true
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
    this.runtimePreparation ??= this.runtime.prepare(this.resolvedOperatorHome === undefined ? {} : { operatorHome: this.resolvedOperatorHome })
    await this.runtimePreparation
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
      operatorHome: this.resolvedOperatorHome,
      ...(this.stoppedRepairBatch ? { volumeName: this.stoppedRepairBatch.volumeName,
        hostBinaryPath: this.stoppedRepairBatch.input.hostBinaryPath } : {}),
      binaryKind: this.supervisorBinaryKind,
      env: { ...this.supervisorEnv, ...this.qualificationEnvironment() },
      binaryPath: this.qualificationSupervisorBin,
      ...(this.stoppedRepairBatch && this.supervisorEnv.FRESHELL_RUNTIME_CRASH_POINT
        ? { crashPoint: this.supervisorEnv.FRESHELL_RUNTIME_CRASH_POINT } : {}),
    })
    this.web = this.webFactory({
      binary: this.serverBin, repoRoot: this.repoRoot, candidateSha: this.runtime.candidateSha,
      buildDirty: git(this.repoRoot, ['status', '--porcelain']).trim().length > 0,
      preserveHomeOnStop: true,
      writeDiagnosticArtifact: (fileName, value) => this.runtime.writeArtifact(fileName, value),
      providerFreeFixture: this.fixtureFreshAgentModes.length > 0 && this.enabledProviders.length === 0
        && this.freshAgentModes.every(mode => this.fixtureFreshAgentModes.includes(mode)),
      homeDir: this.webHomeDir ?? this.resolvedOperatorHome,
      fixtureOnecliReferences: fixtureOnecliReferences(this.serverEnv, this.fixtureFreshAgentModes),
      env: {
        // Managed MCP calls back from Docker workloads, so this owned
        // ephemeral-port server must override RustServer's loopback default.
        FRESHELL_BIND_HOST: '0.0.0.0',
        FRESHELL_MANAGED_RUNTIME_V1: '1',
        ...(this.freshAgentModes.length > 0
          ? { FRESHELL_MANAGED_FRESH_AGENT_V1: '1', ...(this.freshAgentModes.includes('kilroy') ? { KILROY_ENABLED: '1' } : {}) }
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
        if (this.enabledProviders.includes('codex') || this.freshAgentModes.includes('freshcodex')) {
          // Web isolation explicitly selects this CODEX_HOME. Native input
          // preparation requires that selected directory to exist already.
          await fsp.mkdir(path.join(homeDir, '.codex'), { recursive: true, mode: 0o700 })
          this.runtime.recordLifecycle('runtime.codex_home.prepared', { severity: 'info', owned: true })
        }
        const freshell = path.join(homeDir, '.freshell')
        await fsp.mkdir(freshell, { recursive: true })
        await fsp.writeFile(path.join(freshell, 'config.json'), JSON.stringify({
          version: 1,
          settings: {
            defaultCwd: this.workspaceCwd,
            codingCli: {
              enabledProviders: [...new Set([...this.enabledProviders, ...this.freshAgentModes.map(mode => mode === 'freshcodex' ? 'codex' : mode === 'freshopencode' ? 'opencode' : 'claude')])],
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

  async captureCandidateIntegrity(): Promise<RuntimeCandidateIntegrity> {
    const { captureRuntimeReceiptCandidate } = await import('./runtime-phase5-evidence-common.js')
    const observed = RuntimeCandidateIntegritySchema.refine(value => value.sha === this.runtime.candidateSha, 'owned candidate changed')
      .parse(captureRuntimeReceiptCandidate(this.repoRoot))
    if (!this.stopSettlement) this.receiptCandidateBefore ??= observed
    return observed
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
    const before = await this.observeLiveFreshAllocations()
    const requestedAt = Date.now()
    const info = await this.withManagedBin(() => this.web.restartAbrupt())
    const after = await this.observeLiveFreshAllocations()
    for (const allocation of before) {
      const current = after.find(value => value.view.soulId === allocation.view.soulId)
      if (current) this.freshWebRestarts.push({ kind: 'web_restart', before: allocation, after: current, requestedAt, completedAt: Date.now(), observedAt: Date.now() })
    }
    return info
  }

  private async observeLiveFreshAllocations() {
    if (!this.freshNativeCollections.size || this.runtime.phase !== 5) return []
    const views = (await this.inventory()).filter(view => view.launchState === 'running' && view.nativeSessionId
      && this.freshAgentModes.includes(view.freshAgentSessionType ?? '') && !this.fixtureFreshAgentModes.includes(view.freshAgentSessionType ?? ''))
    const allocations = []
    for (const view of views) allocations.push(await this.freshBrowserAllocation(this.exactRuntimeHandle(view)))
    return allocations
  }

  async crashWeb(): Promise<RuntimeWebInfo> {
    return this.crashAndRestartWeb()
  }

  async restartSupervisor(): Promise<SupervisorInstance> {
    const before = await this.observeLiveFreshAllocations()
    const instance = await this.replaceSupervisor('graceful')
    const after = await this.observeLiveFreshAllocations()
    const lifecycle = before.length ? await this.readOwnedLifecycle() : []
    for (const allocation of before) {
      const current = after.find(value => value.view.soulId === allocation.view.soulId)
      if (current) this.freshSupervisorRestarts.push({ before: allocation.view, after: current.view, lifecycle, observedAt: Date.now() })
    }
    return instance
  }

  async restartSupervisorAbrupt(): Promise<SupervisorInstance> {
    return this.replaceSupervisor('abrupt')
  }

  private async replaceSupervisor(mode: 'graceful' | 'abrupt', crashPoint?: 'ordinary_stop_after_intent', beforeStart?: () => void): Promise<SupervisorInstance> {
    const previous = this.supervisor
    if (mode === 'abrupt') this.runtime.killTrackedContainerExact(previous.containerId)
    else if (beforeStart) this.runtime.stopSupervisorExact(previous, true)
    else this.runtime.stopSupervisorExact(previous)
    beforeStart?.()
    if (!beforeStart) this.runtime.removeContainerExact(previous.containerId)
    this.supervisor = await this.runtime.startSupervisor({
      scenarioId: previous.scenarioId,
      operatorHome: this.resolvedOperatorHome,
      volumeName: previous.volumeName,
      binaryKind: previous.binaryKind,
      ...(beforeStart ? { waitForHealth: false } : {}),
      reuseSecret: true,
      env: { ...this.supervisorEnv, ...this.qualificationEnvironment() },
      binaryPath: this.qualificationSupervisorBin,
      ...(this.stoppedRepairBatch ? { hostBinaryPath: this.stoppedRepairBatch.input.hostBinaryPath } : {}),
      ...(this.stoppedRepairBatch && this.supervisorEnv.FRESHELL_RUNTIME_CRASH_POINT
        ? { crashPoint: this.supervisorEnv.FRESHELL_RUNTIME_CRASH_POINT } : {}),
      ...(crashPoint ? { crashPoint } : {}),
    })
    if (beforeStart) {
      await this.runtime.waitForSupervisorHealth(this.supervisor)
      this.runtime.removeContainerExact(previous.containerId)
    }
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

  async stopCompletionFacts(handle: ExactRuntimeHandle, expectedIntentRevision: number,
    executionGeneration: number): Promise<ManagedStopCompletionFacts> {
    const receipts = this.runtime.broker.receipts().filter(receipt => receipt.soulId === handle.soulId
      && receipt.incarnationId === handle.incarnationId && receipt.containerId === handle.containerId)
    if (handle.runId !== this.runtime.runId || handle.candidateSha !== this.runtime.candidateSha || receipts.length !== 1) {
      throw new Error('Stop completion requires the exact owned receipt')
    }
    const currentView = async () => {
      const rows = (await this.inventory()).filter(row => row.soulId === handle.soulId)
      const matching = rows.filter(row => row.incarnationId === handle.incarnationId)
      const view = matching[0]
      if (matching.length !== 1 || rows.some(row => row.incarnationId !== handle.incarnationId && row.launchState !== 'stopped')
        || view.containerId !== handle.containerId || view.hostBootId !== handle.hostBootId
        || view.nativeSessionId !== handle.nativeSessionId || view.intentRevision !== expectedIntentRevision
        || view.executionGeneration !== executionGeneration || view.desiredState !== 'stopped') {
        throw new Error('current Stop completion identity or transaction changed')
      }
      return view
    }
    await currentView()
    const host = z.object({ hostBootId: z.literal(handle.hostBootId) }).passthrough()
      .safeParse(JSON.parse(await fsp.readFile(path.join(receipts[0].runtimeDir, 'host-state.json'), 'utf8')))
    if (!host.success) throw new Error('Stop completion owned host boot changed')
    // Async scoped IO remains in providerProbes until it settles, even if the
    // browser's fixed observation deadline expires first. Cleanup joins it.
    const raw = JSON.parse(await this.trackedDockerProbe(this.supervisor.containerId, ['exec', this.supervisor.containerId,
      'python3', '-c', ORDINARY_STOP_COMPLETION_SCRIPT, handle.soulId, handle.incarnationId,
      String(expectedIntentRevision), String(executionGeneration)]))
    // Completion may occur during the IO above. Recheck the current fence and
    // read its view afterward instead of pairing a final transaction with an
    // earlier "stopping" view.
    const facts = ManagedStopCompletionFactsSchema.parse({ ...raw, view: await currentView() })
    if ((['soulId', 'incarnationId', 'containerId', 'hostBootId', 'nativeSessionId'] as const)
      .some(field => facts[field] !== handle[field]) || facts.intentRevision !== expectedIntentRevision
      || facts.executionGeneration !== executionGeneration) throw new Error('recorded Stop completion identity changed')
    return facts
  }

  async stop(): Promise<{ ok: boolean; errors: string[] }> {
    if (this.stopSettlement) return this.stopSettlement
    this.stopSettlement = (async () => {
      this.nativeCollectionsClosing = true
      await Promise.allSettled([...this.nativeCaptures])
      const result = await settleOwnedRuntimeCleanup(() => this.stopWebAndReleaseHeldHosts(), () => this.runtime.cleanup())
      if (result.ok && this.syntheticSource) {
        try { await fsp.rm(this.syntheticSource.root, { recursive: true, force: true }) }
        catch { result.ok = false; result.errors.push('owned synthetic source cleanup failed') }
      }
      if (this.freshNativeCollections.size) this.runtime.writeArtifact('native-collection-status.json', {
        complete: [...this.freshNativeCollections.values()].every(collection => collection.closed && !collection.failed),
        failures: this.nativeCaptureFailures.length,
      })
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
  async ownershipFacts(): Promise<RuntimeOwnershipFacts> {
    return RuntimeOwnershipFactsSchema.parse({ receiptCount: this.runtime.broker.receipts().length,
      unsafeBrokerAttempts: this.runtime.broker.unsafeAttempts().length,
      supervisorContainerId: this.supervisor.containerId, supervisorBinaryKind: this.supervisor.binaryKind })
  }
  async terminalChildFacts(handle: RuntimeEnclosureHandle): Promise<RuntimeTerminalChildFacts> {
    if (this.runtime.phase !== 2) throw new Error('Phase 2 terminal continuity fixture required')
    await this.currentRuntimeEnclosure(handle)
    const key = JSON.stringify([handle.containerId, handle.hostBootId])
    let pid = this.terminalChildren.get(key)
    if (pid === undefined) {
      const raw = (await this.ownedProviderExec(handle.containerId, ['sh', '-lc',
        'cat "/home/freshell/provider/p2-child-pid" 2>/dev/null || true'])).trim()
      if (!/^\d+$/.test(raw)) return { pid: null, running: false }
      pid = Number(raw)
      if (!Number.isSafeInteger(pid) || pid <= 0) return { pid: null, running: false }
      this.terminalChildren.set(key, pid)
    }
    return RuntimeTerminalChildFactsSchema.parse({ pid, running: this.ownedContainerHasPid(handle.containerId, pid) })
  }

  async terminalWebCycleCompleted(handle: RuntimeEnclosureHandle, marker: string): Promise<boolean> {
    if (this.runtime.phase !== 2) throw new Error('Phase 2 terminal continuity fixture required')
    const cycle = /^P2_WEB_CYCLE_([1-9]|10)_\d+$/.exec(marker)?.[1]
    if (!cycle) throw new Error('fixed terminal web-cycle marker required')
    await this.currentRuntimeEnclosure(handle)
    const actual = (await this.ownedProviderExec(handle.containerId, ['sh', '-lc',
      `cat ${JSON.stringify(`/home/freshell/provider/p2-web-cycle-${cycle}`)} 2>/dev/null || true`])).trim()
    return actual === marker
  }
  async captureTerminalContinuityDiagnostics(handle: RuntimeEnclosureHandle): Promise<{ artifactRef: string }> {
    if (this.runtime.phase !== 2) throw new Error('Phase 2 terminal continuity fixture required')
    await this.currentRuntimeEnclosure(handle)
    if (!this.web) throw new Error('owned web process is not prepared')
    const output = this.web.capturedOutput()
    const target = this.runtime.writeArtifact('terminal-continuity-diagnostics.json', {
      ...handle, ownedProcesses: this.ownedContainerProcessTable(handle.containerId).slice(-1200),
      hostLogsTail: this.runtime.containerLogs(handle.containerId).slice(-1200),
      webStdoutTail: output.stdout.slice(-1500), webStderrTail: output.stderr.slice(-1500),
    })
    const artifactRef = `terminal-continuity-diagnostics:${createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`
    this.runtime.recordLifecycle('external.terminal_continuity_diagnostics_captured', { severity: 'info', artifactRef, ...handle })
    return { artifactRef }
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
    return (await this.inventory()).find((row) => (
      (row.freshAgentSessionId === sessionId || row.nativeSessionId === sessionId) && row.launchState === 'running'
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
    const collection = this.nativeCollectionForCrash(handle, 'session_host_exit')
    const approval = this.pendingFreshApprovalForCrash(handle)
    const requestedAt = Date.now()
    this.runtime.killOwnedRuntimeExact(handle.containerId)
    if (collection) await this.retainFreshNativeExit(collection, handle, 'session_host_exit', requestedAt)
    if (approval) await this.retainFreshNativeExit(approval, handle, 'session_host_exit', requestedAt)
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
    if (this.nativeCollectionsClosing || this.stopSettlement) throw new Error('fresh native collection is finished')
    const process = FreshNativeProcessSchema.parse(JSON.parse(await this.ownedProviderExec(handle.containerId,
      ['python3', '-c', FRESH_AGENT_PROCESS_SCRIPT, provider, handle.incarnationId])))
    const native = process.native
    const version = typeof process.version === 'string' ? process.version.match(/\b\d+\.\d+\.\d+\b/)?.[0] : undefined
    if (process.provider !== provider || !version || !Number.isSafeInteger(native.pid) || native.pid <= 1
      || native.uid !== 65534 || !/^\d+$/.test(native.startTicks ?? '') || native.launch?.incarnationId !== handle.incarnationId
      || !/^[a-f0-9]{64}$/.test(native.executableSha256 ?? '') || !/^[a-f0-9]{64}$/.test(native.profileSha256 ?? '')
      || !path.isAbsolute(native.executable ?? '') || !path.isAbsolute(native.cwd ?? '')) throw new Error('actual provider child PID/profile is invalid')
    if (provider === 'claude' && (!process.sdk || process.sdk.selection !== 'sidecar-selected-module-resolution')) {
      throw new Error('owned SDK selected module is missing')
    }
    const current = await this.currentRuntimeEnclosure(handle)
    if (current.executionGeneration !== row.executionGeneration || current.nativeIdentityObservation?.launchNonce !== row.nativeIdentityObservation?.launchNonce) {
      throw new Error('current native launch changed during capture')
    }
    this.freshNativeProcesses.set(JSON.stringify(handle), { ...process, version })
    return { provider, version, workerPid: native.pid }
  }

  private trackNativeCapture<T>(work: () => Promise<T>): Promise<T> {
    const result = Promise.resolve().then(work).then(value => {
      this.nativeCaptures.delete(result)
      return value
    }, error => {
      this.nativeCaptures.delete(result)
      this.nativeCaptureFailures.push('native original capture failed')
      const nativeRecoveryDiagnostic = nativeRecoveryValidationDiagnostic(error)
      this.runtime.recordLifecycle('external.native_collection_failed', { severity: 'warn',
        ...(nativeRecoveryDiagnostic ? { nativeRecoveryDiagnostic } : {}),
        ...(error instanceof NativeHistoryProbeFailure ? { nativeHistoryDiagnostic: error.diagnostic } : {}) })
      throw error
    })
    this.nativeCaptures.add(result)
    return result
  }


  private freshBrowserCollection(collectionId: string) {
    const collection = this.freshNativeCollections.get(collectionId)
    if (!collection || collection.failed || this.nativeCollectionsClosing || this.stopSettlement) throw new Error('registered fresh collection required')
    let browser = this.freshBrowserCollections.get(collectionId)
    if (!browser) { browser = { routes: [] }; this.freshBrowserCollections.set(collectionId, browser) }
    return { collection, browser }
  }

  private async freshBrowserAllocation(handle: ExactRuntimeHandle) {
    await this.freshAgentLaunchFacts(this.runtimeEnclosureHandle(handle))
    return { view: await this.currentRuntimeEnclosure(handle), writer: await this.writerClaimFacts(handle),
      volume: await this.providerVolumeFacts(handle), process: this.freshNativeProcesses.get(JSON.stringify(this.runtimeEnclosureHandle(handle)))!,
      limits: (await this.chaosHostFacts(handle)).limits }
  }

  async observeFreshBrowserIngress(handle: ExactRuntimeHandle, collectionId: string, observation: FreshBrowserIngressObservation): Promise<void> {
    return this.trackNativeCapture(async () => {
      const { collection, browser } = this.freshBrowserCollection(collectionId)
      await this.assertCurrentHandle(handle)
      const view = await this.currentRuntimeEnclosure(handle)
      if (view.freshAgentSessionType !== collection.mode || browser.routes.some(route => route.ingress === observation.ingress)
        || ['startup-restore', 'auto-resume'].includes(observation.ingress)) throw new Error('one executed browser route on the selected mode required')
      if (['history-resume', 'ws-attach'].includes(observation.ingress) && observation.request.type === 'freshAgent.attach'
        && (view.soulId !== collection.soulId || view.nativeSessionId !== collection.nativeSessionId
          || !matchesFreshBrowserFrame(view, observation.request))) throw new Error('browser attach differs from the registered current native allocation')
      const route = { ...FreshBrowserIngressObservationSchema.parse(observation), view, observedAt: Date.now(),
        ...(/^(rest|mcp)-/.test(observation.ingress) ? { writer: await this.writerClaimFacts(handle) } : {}) }
      if (/^(rest|mcp)-/.test(observation.ingress)) validateFreshBrowserAlias(route, collection)
      browser.routes.push(route)
    })
  }

  async registerFreshBrowserTurn(handle: ExactRuntimeHandle, collectionId: string): Promise<FreshBrowserChallengeResult> {
    const { collection, browser } = this.freshBrowserCollection(collectionId)
    if (collection.soulId === handle.soulId || browser.auxiliarySoulId) throw new Error('one independent allocation required for browser UI turn')
    return this.trackNativeCapture(async () => {
      await this.assertCurrentHandle(handle)
      const allocation = await this.freshBrowserAllocation(handle)
      if (allocation.view.freshAgentSessionType !== collection.mode || allocation.writer.providerStoreId === collection.providerStoreId) throw new Error('independent selected native allocation required')
      const captured = await this.captureFreshNativeSource(handle, collection.provider, true)
      const challengeId = randomUUID(), prefix = 'fresh-browser-' + collectionId + '/ui'
      const boundary = await this.materializeNativeSource(prefix + '/boundary', captured)
      browser.auxiliarySoulId = handle.soulId
      this.freshBrowserChallenges.set(challengeId, { challengeId, collectionId, handle, provider: collection.provider, beforeView: allocation.view,
        // Keep the raw empty boundary, but completed-turn decoders require
        // at least one completion. The first UI send starts at zero turns.
        boundary: captured.turns.length ? boundary : undefined, beforeTurns: captured.turns.length, prompt: 'Reply ready. Do not use tools.' })
      return { challengeId, prompt: 'Reply ready. Do not use tools.' }
    })
  }

  async finishFreshBrowserTurn(handle: ExactRuntimeHandle, challengeId: string, request: Record<string, any>, reply: Record<string, any>): Promise<void> {
    return this.trackNativeCapture(async () => {
      const challenge = this.freshBrowserChallenges.get(challengeId)
      if (!challenge || challenge.finished || JSON.stringify(handle) !== JSON.stringify(challenge.handle)
        || request.type !== 'freshAgent.send' || request.text !== challenge.prompt
        || reply.type !== 'freshAgent.send.accepted' || request.requestId !== reply.requestId
        || !request.requestId) throw new Error('registered actual browser send/ack required')
      await this.assertCurrentHandle(handle)
      const view = await this.currentRuntimeEnclosure(handle)
      if (!matchesFreshBrowserFrame(view, request) || !matchesFreshBrowserSendAccepted(view, reply)
        || !sameFreshBrowserActivation(view, challenge.beforeView)) throw new Error('browser send activation differs')
      const deadline = Date.now() + 90_000
      let captured: FreshCapturedNativeHistory | undefined
      while (Date.now() < deadline) {
        await this.assertCurrentHandle(handle)
        try { captured = await this.captureFreshNativeSource(handle, challenge.provider) } catch { captured = undefined }
        if (captured && captured.turns.length > challenge.beforeTurns) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const answer = captured?.turns.at(-1)
      if (!captured || captured.turns.length !== challenge.beforeTurns + 1
        || !hasSuccessfulNativeAnswer(answer, challenge.provider)
        || answer!.toolCalls.length) throw new Error('actual browser no-tool native completion differs')
      const after = await this.materializeNativeSource('fresh-browser-' + challenge.collectionId + '/ui/completed', captured)
      this.freshBrowserCollection(challenge.collectionId).browser.ui = { provider: challenge.provider, nativeRoot: handle.nativeSessionId,
        boundary: challenge.boundary, after, request, reply, view, beforeTurns: challenge.beforeTurns }
      challenge.finished = true
    })
  }

  async registerFreshApproval(handle: ExactRuntimeHandle, allowed: boolean, recovery: 'web' | 'host' | 'provider'): Promise<FreshBrowserChallengeResult> {
    return this.trackNativeCapture(async () => {
      await this.assertCurrentHandle(handle)
      const view = await this.currentRuntimeEnclosure(handle)
      if (!['freshclaude', 'kilroy'].includes(view.freshAgentSessionType ?? '') || !this.freshAgentModes.includes(view.freshAgentSessionType!)
        || this.fixtureFreshAgentModes.includes(view.freshAgentSessionType!)) throw new Error('actual Claude-backed native approval allocation required')
      await this.freshAgentLaunchFacts(this.runtimeEnclosureHandle(handle))
      const challengeId = randomUUID(), effectPath = '/home/freshell/provider/owned-native-effect-' + challengeId + '.jsonl'
      const command = "printf 'effect\\n' >> '" + effectPath + "'"
      const baseline = await this.runtime.adminOk(this.supervisor, { method: 'fresh_agent_read_events', params: { soulId: handle.soulId, afterSequence: 0, maxEvents: 128 } })
      const challenge = { challengeId, allowed, recovery, soulId: handle.soulId, nativeRoot: handle.nativeSessionId,
        beforeView: view, effectPath, command, cursor: baseline.data.head, events: [] as any[], batches: [] as any[] }
      if (await this.freshApprovalEffect(challenge, handle) !== 0) throw new Error('new effect oracle must be absent')
      this.freshApprovalChallenges.set(challengeId, challenge)
      return { challengeId, prompt: 'Use the Bash tool exactly once with this exact command: ' + command + '. Do not use other tools or another command. After its result, reply done. If denied, do not retry, use no other tools, and reply done.' }
    })
  }

  private async freshApprovalEffect(challenge: any, handle: ExactRuntimeHandle): Promise<number> {
    const raw = await this.ownedProviderExec(handle.containerId, ['python3', '-c',
      "import pathlib,sys,json;p=pathlib.Path(sys.argv[1]);b=p.read_bytes() if p.exists() else b'';assert b==b'effect\\n'*b.count(b'\\n');print(json.dumps(b.count(b'\\n')))", challenge.effectPath])
    return z.number().int().nonnegative().parse(JSON.parse(raw))
  }

  private async freshApprovalEvents(challenge: any, select: (event: any) => boolean): Promise<any> {
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      if (this.nativeCollectionsAborted) throw new Error('native approval observation aborted')
      const { events } = await this.readFreshApprovalEvents(challenge)
      const found = events.find(select)
      if (found) return found
      if (events.some((event: any) => event.kind === 'provider' && event.data.payload.event?.type === 'freshAgent.result')) throw new Error('native completion preceded required approval checkpoint')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('bounded native approval observation deadline exceeded')
  }

  private async readFreshApprovalEvents(challenge: any): Promise<{ head: number; events: any[] }> {
    const batch = await this.runtime.adminOk(this.supervisor, { method: 'fresh_agent_read_events',
      params: { soulId: challenge.soulId, afterSequence: challenge.cursor, maxEvents: 128 } })
    if (batch.data.resetRequired) throw new Error('native approval event retention gap')
    challenge.batches.push(batch)
    challenge.cursor = batch.data.events.at(-1)?.sequence ?? batch.data.head
    const events = batch.data.events.map((row: any) => row.event)
    challenge.events.push(...events)
    return { head: batch.data.head, events }
  }

  async captureFreshApprovalCheckpoint(handle: ExactRuntimeHandle, challengeId: string): Promise<FreshBrowserChallengeResult> {
    return this.trackNativeCapture(async () => {
      const challenge = this.freshApprovalChallenges.get(challengeId)
      if (!challenge || challenge.finished || challenge.soulId !== handle.soulId || challenge.nativeRoot !== handle.nativeSessionId) throw new Error('registered native approval challenge required')
      await this.assertCurrentHandle(handle)
      const view = await this.currentRuntimeEnclosure(handle)
      const card = challenge.beforeCard && challenge.recovery === 'web' ? challenge.beforeCard
        : (await this.freshApprovalEvents(challenge, event => event.kind === 'permission_requested' && !!event.data.payload.nativeCheckpoint)).data
      const native = JSON.parse(await this.ownedProviderExec(handle.containerId, ['python3', '-c', claudeNativeInspection, handle.nativeSessionId, 'true', 'fresh', 'ordinary']))
      const files = []
      for (const [file, providerUser] of [['/home/freshell/provider/.freshell/native-checkpoints/claude/' + handle.nativeSessionId + '.json', true], ['/run/freshell-host-actor/fresh-agent-state.json', false]] as const) {
        files.push(JSON.parse(await this.ownedDockerProbe(handle.containerId, ['python3', '-c',
          "import pathlib,json,base64,hashlib,sys,os;p=pathlib.Path(sys.argv[1]);b=p.read_bytes();assert len(b)<=32*1024*1024;json.loads(b);print(json.dumps({'path':str(p),'sha256':hashlib.sha256(b).hexdigest(),'bytesBase64':base64.b64encode(b).decode(),'readerUid':os.getuid()}))", file], providerUser)))
      }
      const effectCount = await this.freshApprovalEffect(challenge, handle)
      validateFreshApprovalCheckpoint(card, native, files, view, challenge.command)
      if (card.payload.tool?.name !== 'Bash' || card.payload.tool.input?.command !== challenge.command
        || card.payload.nativeCheckpoint.nativeSessionId !== challenge.nativeRoot || card.payload.nativeCheckpoint.toolUseID !== card.payload.toolUseID
        || native.nativeLaunch.incarnationId !== handle.incarnationId || effectCount !== 0) throw new Error('actual native solo Bash checkpoint/input differs')
      if (!challenge.beforeCard) Object.assign(challenge, { beforeCard: card, beforeNative: native, beforeFiles: files, beforeEffectCount: effectCount,
        beforeAllocation: await this.freshBrowserAllocation(handle), beforeCapturedAt: Date.now(), beforeWebRestartCount: this.freshWebRestarts.length })
      else {
        if (challenge.beforeCard.decision_id !== card.decision_id || !nativeCheckpointTranscriptRetained(challenge.beforeNative, native, card.payload.toolUseID)
          || JSON.stringify(challenge.beforeCard.payload.nativeCheckpoint) !== JSON.stringify(card.payload.nativeCheckpoint)
          || (challenge.recovery === 'web' ? challenge.beforeView.incarnationId !== view.incarnationId
            : challenge.beforeView.incarnationId === view.incarnationId || challenge.beforeCard.payload.nativeRequestId === card.payload.nativeRequestId)) throw new Error('current native callback/checkpoint did not survive recovery')
        const after = await this.freshBrowserAllocation(handle)
        const recoveryObservation = challenge.crash ? { ...challenge.crash, completedAt: Date.now(), before: challenge.beforeAllocation, after,
          lifecycle: await this.readOwnedLifecycle() }
          : this.freshWebRestarts.slice(challenge.beforeWebRestartCount).find(value => value.before.view.soulId === challenge.soulId && value.requestedAt >= challenge.beforeCapturedAt)
        const current = { ...challenge, currentCard: card, currentNative: native, currentFiles: files, currentEffectCount: effectCount, afterView: view,
          recoveryObservation, currentCapturedAt: Date.now() }
        validateFreshApprovalRecovery(current, { soulId: challenge.soulId, nativeSessionId: challenge.nativeRoot, providerStoreId: challenge.beforeAllocation.writer.providerStoreId })
        Object.assign(challenge, current)
      }
      await this.retainNativeOriginal('fresh-approval-' + challengeId + '/' + (challenge.currentCard ? 'current' : 'before') + '.json', { card, native, files, effectCount, view })
      return { challengeId, decisionId: card.decision_id, toolUseID: card.payload.toolUseID, nativeRequestId: card.payload.nativeRequestId }
    })
  }

  async finishFreshApproval(handle: ExactRuntimeHandle, challengeId: string, decision: Record<string, any>): Promise<void> {
    return this.trackNativeCapture(async () => {
      const challenge = this.freshApprovalChallenges.get(challengeId)
      if (!challenge?.currentCard || challenge.finished || challenge.soulId !== handle.soulId || challenge.nativeRoot !== handle.nativeSessionId) throw new Error('captured current native approval required')
      await this.assertCurrentHandle(handle)
      const view = await this.currentRuntimeEnclosure(handle)
      if (decision.type !== 'freshAgent.approval.respond' || !matchesFreshBrowserFrame(view, decision)
        || !sameFreshBrowserActivation(view, challenge.afterView)
        || String(decision.requestId) !== challenge.currentCard.decision_id
        || decision.decision?.behavior !== (challenge.allowed ? 'allow' : 'deny')) throw new Error('actual current browser decision differs')
      challenge.browserDecision = decision
      const terminal = await this.freshApprovalEvents(challenge, event => event.kind === 'permission_requested'
        || event.kind === 'provider' && event.data.payload.event?.type === 'freshAgent.result')
      if (terminal.kind === 'permission_requested') throw new Error('bounded native decision requested another operation')
      challenge.effectCount = await this.freshApprovalEffect(challenge, handle)
      observeNativeSoloBashOutcome({ nativeRoot: challenge.nativeRoot, toolUseID: challenge.beforeCard.payload.toolUseID,
        allowed: challenge.allowed, observed: challenge.events, effectCount: challenge.effectCount })
      await new Promise(resolve => setTimeout(resolve, 1_000))
      const deadline = Date.now() + 5_000
      let batch = await this.readFreshApprovalEvents(challenge)
      while (challenge.cursor < batch.head) {
        if (Date.now() >= deadline) throw new Error('bounded native post-decision drain deadline exceeded')
        batch = await this.readFreshApprovalEvents(challenge)
      }
      challenge.recheckedEffectCount = await this.freshApprovalEffect(challenge, handle)
      validateFreshApprovalDispatch(challenge)
      if (challenge.recheckedEffectCount !== challenge.effectCount || challenge.events.filter((event: any) => event.kind === 'permission_requested').length !== (challenge.recovery === 'web' ? 1 : 2)) throw new Error('native approval replayed')
      challenge.finished = true
      await this.retainNativeOriginal('fresh-approval-' + challengeId + '/outcome.json', challenge)
    })
  }

  async captureFreshBrowserRow(handle: ExactRuntimeHandle, collectionId: string): Promise<FreshAgentQualificationRow> {
    return this.trackNativeCapture(async () => {
      const { collection, browser } = this.freshBrowserCollection(collectionId)
      if (collection.stages.length !== 3 || !browser.ui || !browser.auxiliarySoulId || handle.soulId !== collection.soulId) throw new Error('three native stages and actual independent browser turn required')
      const other = (await this.inventory()).find(view => view.soulId === browser.auxiliarySoulId && view.launchState === 'running')
      if (!other) throw new Error('current independent allocation absent')
      const allocations = [await this.freshBrowserAllocation(handle), await this.freshBrowserAllocation(this.exactRuntimeHandle(other))]
      const stageViews = []
      for (const stage of collection.stages) {
        const value = JSON.parse(await fsp.readFile(path.join(this.runtime.evidenceDir, (stage.launch as NativeOriginalReference).path), 'utf8'))
        stageViews.push(value.response.data.view)
      }
      const original = { mode: collection.mode, routes: browser.routes, ui: browser.ui, allocations, stageViews,
        lifecycle: await this.readOwnedLifecycle(), webRestarts: this.freshWebRestarts, supervisorRestarts: this.freshSupervisorRestarts,
        approvals: [...this.freshApprovalChallenges.values()].filter(value => value.soulId === browser.auxiliarySoulId && value.finished) }
      const reference = await this.retainNativeOriginal('fresh-browser-' + collectionId + '/execution.json', original)
      const manifestPath = 'fresh-native-' + collectionId + '/manifest.json'
      const conversation = deriveNativeRecoveryOriginals({ evidenceDir: this.runtime.evidenceDir, candidateSha: this.runtime.candidateSha, runId: this.runtime.runId,
        runtimeImage: this.runtime.imageRef, selected: [collection.mode], originalReference: { path: manifestPath, sha256: createHash('sha256').update(await fsp.readFile(path.join(this.runtime.evidenceDir, manifestPath))).digest('hex') } })[0]!
      const accepted = JSON.parse(await fsp.readFile(path.join(this.runtime.evidenceDir, 'fresh-native-' + collectionId + '/stage-2/accepted.json'), 'utf8'))
      return { mode: collection.mode as FreshAgentQualificationRow['mode'], provider: collection.provider, providerVersion: allocations[0]!.process.version,
        model: accepted.spec.model, effort: accepted.spec.effort ?? 'provider-default', runtimeVariant: accepted.spec.runtimeVariant,
        actualProviderProcess: true, fixtureTransport: false, soulId: collection.soulId, nativeSessionId: collection.nativeSessionId,
        providerStoreId: collection.providerStoreId, completedNativeTurns: nativeCompletedTurnProofs(conversation), noToolRecall: conversation.stages.slice(1).every(stage => stage.recalledNonce),
        ...deriveFreshBrowserExecution(original, conversation), executionOriginal: reference }
    })
  }

  private nativeCollectionResult(collection: FreshNativeCollection): FreshNativeCollectionResult {
    return { collectionId: collection.collectionId, completedStages: collection.stages.length, closed: collection.closed,
      ...(collection.closed && collection.completedNativeTurns ? { providerStoreId: collection.providerStoreId, completedNativeTurns: collection.completedNativeTurns } : {}) }
  }

  private async currentFreshCollection(handle: ExactRuntimeHandle, collectionId: string): Promise<FreshNativeCollection> {
    if (this.nativeCollectionsClosing || this.stopSettlement || this.nativeCollectionsAborted) throw new Error('fresh native collection is finished')
    const collection = this.freshNativeCollections.get(collectionId)
    if (!collection || collection.closed || collection.failed || collection.soulId !== handle.soulId
      || collection.nativeSessionId !== handle.nativeSessionId) throw new Error('registered open fresh native collection required')
    await this.assertCurrentHandle(handle)
    return collection
  }

  async registerFreshNativeCollection(handle: ExactRuntimeHandle, nonce: string): Promise<FreshNativeCollectionResult> {
    if (this.nativeCollectionsClosing || this.stopSettlement || this.nativeCollectionsAborted) throw new Error('fresh native collection is finished')
    return this.trackNativeCapture(async () => {
      if (!/^codename-[a-f0-9]{32}$/.test(nonce)) throw new Error('fixed fresh native collection nonce required')
      await this.freshAgentLaunchFacts(this.runtimeEnclosureHandle(handle))
      await this.assertCurrentHandle(handle)
      const row = await this.currentRuntimeEnclosure(this.runtimeEnclosureHandle(handle))
      if (this.freshNativeCollections.size >= this.freshAgentModes.length
        || [...this.freshNativeCollections.values()].some(collection => collection.soulId === handle.soulId || collection.mode === row.freshAgentSessionType)) {
        throw new Error('fresh mode/soul collection is already registered')
      }
      const writer = await this.writerClaimFacts(handle)
      if (!writer.providerStoreId || writer.activeClaimCount !== 1 || writer.globalConflictingClaimCount !== 0) throw new Error('current fresh collection writer/store is absent or conflicting')
      const collection: FreshNativeCollection = { collectionId: randomUUID(), mode: row.freshAgentSessionType!,
        provider: row.freshAgentSessionType === 'kilroy' ? 'claude' : row.provider!, soulId: handle.soulId,
        providerStoreId: writer.providerStoreId, nativeSessionId: handle.nativeSessionId, nonce, stages: [], lastHandle: handle, closed: false, failed: false }
      this.freshNativeCollections.set(collection.collectionId, collection)
      return this.nativeCollectionResult(collection)
    })
  }

  private async retainNativeOriginal(relative: string, value: Buffer | Record<string, unknown>): Promise<NativeOriginalReference> {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify({ execution: {
      candidateSha: this.runtime.candidateSha, runId: this.runtime.runId, runtimeImage: this.runtime.imageRef }, ...value }))
    if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) throw new Error('native original exceeds the serialized evidence bound')
    const filename = path.join(this.runtime.evidenceDir, relative)
    await fsp.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
    await fsp.writeFile(filename, bytes, { mode: 0o600, flag: 'wx' })
    return { path: relative, sha256: createHash('sha256').update(bytes).digest('hex') }
  }

  private prepareNativeHistoryTool(): string {
    if (this.nativeHistoryTool) return this.nativeHistoryTool
    if (this.nativeHistoryToolFailure) throw this.nativeHistoryToolFailure
    const directory = this.runtime.nativeHistoryBuildDir
    const target = path.join(directory, 'probe-cli.mjs')
    const source = path.join(this.repoRoot, 'test/e2e-browser/helpers/provider-native-history/probe-cli.ts')
    const args = ['--filter', 'freshell-mcp-runtime', 'exec', 'esbuild', source,
      '--bundle', '--platform=node', '--format=esm', '--target=node22', `--outfile=${target}`]
    try {
      this.runtime.recordLifecycle('native_history.tool_build_started', { severity: 'info', producer: 'pnpm', path: target })
      // Keep build copies out of private evidence/build parents. Existing
      // workspace mounts expose this source-only tool to both reader forms.
      const dist = path.dirname(directory)
      if (!fs.existsSync(dist)) {
        fs.mkdirSync(dist, { mode: 0o755 })
        fs.chmodSync(dist, 0o755)
      }
      for (const parent of [this.repoRoot, dist]) {
        const stat = fs.lstatSync(parent)
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(parent) !== parent || (stat.mode & 0o005) !== 0o005) {
          throw new Error('native history tool parent is not helper-readable')
        }
      }
      fs.mkdirSync(directory, { mode: 0o755 })
      fs.chmodSync(directory, 0o755)
      execFileSync('pnpm', args, { cwd: this.repoRoot, encoding: 'utf8', stdio: 'pipe', timeout: 60_000 })
      fs.chmodSync(target, 0o644)
      this.runtime.writeArtifact('native-history-tool.json', { producer: 'pnpm', args,
        path: target, sha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex'),
        sourceSha256: createHash('sha256').update(fs.readFileSync(source)).digest('hex') })
      this.nativeHistoryTool = target
      this.runtime.recordLifecycle('native_history.tool_build_completed', { severity: 'info', path: target })
      return target
    } catch (error) {
      const failure = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer; status?: number; signal?: string }
      this.runtime.writeArtifact('native-history-tool-failure.json', { producer: 'pnpm', args, path: target,
        message: failure.message, status: failure.status ?? null, signal: failure.signal ?? null,
        stdout: String(failure.stdout ?? ''), stderr: String(failure.stderr ?? '') })
      this.runtime.recordLifecycle('native_history.tool_build_failed', { severity: 'error', path: target, status: failure.status ?? null })
      this.nativeHistoryToolFailure = new Error('native history tool preparation failed')
      throw this.nativeHistoryToolFailure
    }
  }

  private async captureFreshNativeSource(handle: ExactRuntimeHandle, provider: string, boundary = false): Promise<FreshCapturedNativeHistory> {
    const source = provider === 'claude' ? '/home/freshell/provider/.claude/projects'
      : provider === 'codex' ? '/home/freshell/provider/.codex/sessions' : '/home/freshell/provider/.local/share/opencode/opencode.db'
    // An imported probe must not see its own filename as argv[1]: the CLI's
    // normal main guard would otherwise dispatch a second capture.
    const script = "const{captureNativeHistory,runNativeHistoryProbe}=await import(process.argv[2]);runNativeHistoryProbe(()=>captureNativeHistory(process.argv[3],process.argv[4],process.argv[5],process.argv[6]==='boundary'));"
    const raw = await this.ownedProviderExec(handle.containerId, ['node', '--no-warnings', '--input-type=module', '-e', script,
      'native-history-import', this.prepareNativeHistoryTool(), provider, source, handle.nativeSessionId,
      boundary ? 'boundary' : 'completion'])
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error('native capture exceeds the serialized evidence bound')
    const captured = objectFields(JSON.parse(raw), 'invalid raw native source')
    if (captured.provider !== provider || captured.nativeSessionId !== handle.nativeSessionId || !Array.isArray(captured.turns)) throw new Error('raw native source identity differs')
    if (captured.rawSource !== null) RawNativeSnapshotSchema.parse(objectFields(captured.rawSource, 'raw source is absent').snapshot)
    return captured as FreshCapturedNativeHistory
  }

  private async materializeNativeSource(prefix: string, captured: FreshCapturedNativeHistory): Promise<NativeOriginalReference | undefined> {
    if (captured.rawSource === null && captured.turns.length === 0) return undefined
    const snapshot = RawNativeSnapshotSchema.parse(captured.rawSource?.snapshot)
    if (snapshot.completeEof !== true || !Array.isArray(snapshot.identity) || snapshot.identity.length < 2) throw new Error('native snapshot is partial or lacks identity')
    const bytes = Buffer.from(snapshot.querySnapshotBase64 ?? snapshot.bytesBase64, 'base64')
    if (createHash('sha256').update(bytes).digest('hex') !== (snapshot.querySnapshotSha256 ?? snapshot.sha256)) throw new Error('raw native snapshot digest differs')
    return this.retainNativeOriginal(`${prefix}/${path.basename(snapshot.path)}`, bytes)
  }

  async captureFreshNativeStage(handle: ExactRuntimeHandle, collectionId: string): Promise<FreshNativeCollectionResult> {
    if (this.nativeCollectionsClosing || this.stopSettlement) throw new Error('fresh native collection is finished')
    return this.trackNativeCapture(async () => {
      const collection = await this.currentFreshCollection(handle, collectionId)
      try {
        const index = collection.stages.length
        if (index >= 3 || (index > 0 && !collection.crash)) throw new Error('fresh native stage needs the exact preceding owned crash')
        const stage: NativeRecoveryStage = index === 0 ? 'initial' : index === 1 ? 'after_session_host_crash' : 'after_provider_process_crash'
        const prefix = `fresh-native-${collectionId}/stage-${index}`
        await this.freshAgentLaunchFacts(this.runtimeEnclosureHandle(handle))
        const process = this.freshNativeProcesses.get(JSON.stringify(this.runtimeEnclosureHandle(handle)))!
        const row = await this.currentRuntimeEnclosure(this.runtimeEnclosureHandle(handle)), capturedAt = Date.now()
        const accepted = objectFields(JSON.parse(await this.ownedDockerProbe(this.supervisor.containerId,
          ['python3', '-c', FRESH_ACCEPTED_PROFILE_SCRIPT, handle.soulId, handle.incarnationId], false)), 'accepted current fresh profile is absent')
        for (const field of ['soulId', 'incarnationId', 'containerId', 'hostBootId', 'nativeSessionId'] as const) {
          if (accepted[field] !== handle[field]) throw new Error(`accepted current profile ${field} differs`)
        }
        if (accepted.providerStoreId !== collection.providerStoreId || objectFields(accepted.spec, 'accepted fresh spec is absent').providerStoreId !== collection.providerStoreId
          || accepted.executionGeneration !== row.executionGeneration || accepted.launchNonce !== row.nativeIdentityObservation?.launchNonce) throw new Error('accepted current profile/store differs')
        const acceptedReference = await this.retainNativeOriginal(`${prefix}/accepted.json`, { ...accepted, capturedAt })
        const writer = await this.writerClaimFacts(handle)
        if (writer.providerStoreId !== collection.providerStoreId || writer.activeClaimCount !== 1 || writer.globalConflictingClaimCount !== 0) throw new Error('fresh native writer changed')
        const writerReference = await this.retainNativeOriginal(`${prefix}/writer.json`, { ...writer, capturedAt: Date.now() })
        const launch = await this.retainNativeOriginal(`${prefix}/launch.json`, { capturedAt,
          authorityProjection: { source: 'inventory+accepted-spec+writer-claim', accepted: acceptedReference, writer: writerReference },
          response: { data: { view: { ...row, providerStoreId: accepted.providerStoreId } } } })
        const namespace = objectFields(JSON.parse(await this.ownedProviderExec(handle.containerId,
          ['python3', '-c', FRESH_NATIVE_NAMESPACE_SCRIPT, collection.provider, String(process.native.pid), handle.nativeSessionId, collection.mode])), 'native namespace is absent')
        if (namespace.nativePid !== process.native.pid || namespace.nativeCwd !== process.native.cwd) throw new Error('current native namespace/process differs')
        const namespaceReference = await this.retainNativeOriginal(`${prefix}/namespace.json`, { ...namespace,
          executableSha256: process.native.executableSha256, profileSha256: process.native.profileSha256,
          ownedProbe: { containerId: handle.containerId, nativePid: process.native.pid, capturedAt: Date.now() } })
        const sdk: Record<string, unknown> | null = process.sdk ? { ...process.sdk } : null
        if (sdk) {
          for (const [bytesField, referenceField, filename] of [['packageBytesBase64', 'packageSource', 'sdk-package.json'], ['moduleBytesBase64', 'moduleSource', 'sdk-module.mjs'], ['entryBytesBase64', 'entrySource', 'sidecar-entry.mjs']]) {
            sdk[referenceField!] = await this.retainNativeOriginal(`${prefix}/${filename}`, Buffer.from(z.string().parse(sdk[bytesField!]), 'base64'))
            delete sdk[bytesField!]
          }
        }
        const processReference = await this.retainNativeOriginal(`${prefix}/process.json`, { ...process, sdk })
        const profile = await this.retainNativeOriginal(`${prefix}/profile.json`, { mode: collection.mode, process: processReference, accepted: acceptedReference })
        const boundary = await this.captureFreshNativeSource(handle, collection.provider, true)
        const boundaryFile = await this.materializeNativeSource(`${prefix}/boundary`, boundary)
        if (!boundaryFile) await this.retainNativeOriginal(`${prefix}/empty-boundary.json`, { provider: collection.provider,
          nativeSessionId: handle.nativeSessionId, containerId: handle.containerId, observed: 'exact-root-transcript-absent', capturedAt: Date.now() })
        const prompt = index === 0 ? `Remember this codename: ${collection.nonce}. Reply stored. Do not use tools.`
          : 'Recall the saved codename from this conversation. Reply with the codename only. Do not use tools.'
        const requestId = `request-${randomUUID()}`, sentAt = Date.now(), request = { method: 'fresh_agent_send', params: { soulId: handle.soulId, text: prompt } }
        const reply = await this.runtime.adminRaw(this.supervisor, request, { requestId })
        const requestReference = await this.retainNativeOriginal(`${prefix}/request.json`, { requestId, sentAt, request, reply })
        if (reply.result?.Err) throw new Error('owned native request was refused')
        const deadline = Date.now() + 60_000
        let captured: FreshCapturedNativeHistory | undefined
        while (Date.now() < deadline) {
          if (this.nativeCollectionsAborted) throw new Error('native collection aborted')
          await this.assertCurrentHandle(handle)
          // A provider may acknowledge the input before its first completed row or
          // between append writes. Keep the exact handle live and retry the raw read
          // until a complete source can be parsed; acceptance never counts as a turn.
          try { captured = await this.captureFreshNativeSource(handle, collection.provider) }
          catch { captured = undefined }
          if (captured && captured.turns.length > boundary.turns.length) break
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        if (!captured || captured.turns.length !== boundary.turns.length + 1) throw new Error('owned native completion is missing or ambiguous')
        const nativeFile = await this.materializeNativeSource(`${prefix}/completed`, captured)
        if (!nativeFile) throw new Error('completed native raw source is missing')
        const receipt = this.runtime.broker.receipts().filter(value => value.containerId === handle.containerId
          && value.soulId === handle.soulId && value.incarnationId === handle.incarnationId)
        if (receipt.length !== 1 || !receipt[0]!.providerVolumeName) throw new Error('exact owned native provider volume is missing')
        const store = await this.retainNativeOriginal(`${prefix}/store.json`, { containerId: handle.containerId,
          providerVolumeName: receipt[0]!.providerVolumeName, ...captured.rawSource })
        const currentProcess = FreshNativeProcessSchema.parse(JSON.parse(await this.ownedProviderExec(handle.containerId,
          ['python3', '-c', FRESH_AGENT_PROCESS_SCRIPT, collection.provider, handle.incarnationId])))
        if (JSON.stringify(currentProcess.native) !== JSON.stringify(process.native) || JSON.stringify(currentProcess.sdk) !== JSON.stringify(process.sdk)
          || JSON.stringify(currentProcess.sidecar) !== JSON.stringify(process.sidecar)) throw new Error('native process/profile changed during capture')
        await this.assertCurrentHandle(handle)
        const retainedStage = { stage, launch, namespace: namespaceReference, profile, request: requestReference, nativeFile, store,
          ...(boundaryFile && boundary.turns.length ? { boundaryFile } : {}),
          ...(collection.crash ? { crash: await this.retainNativeOriginal(`${prefix}/crash.json`, collection.crash) } : {}) }
        collection.stages.push(retainedStage)
        collection.lastHandle = handle
        collection.crash = undefined
        await this.sealFreshNativeOriginals(collection)
        deriveNativeRecoveryOriginals({ evidenceDir: this.runtime.evidenceDir, candidateSha: this.runtime.candidateSha,
          runId: this.runtime.runId, runtimeImage: this.runtime.imageRef, selected: [collection.mode],
          originalReference: { path: `fresh-native-${collectionId}/manifest.json`, sha256: createHash('sha256').update(await fsp.readFile(path.join(this.runtime.evidenceDir, `fresh-native-${collectionId}/manifest.json`))).digest('hex') },
          requiredStages: collection.stages.map(value => value.stage as NativeRecoveryStage) })
        return this.nativeCollectionResult(collection)
      } catch (error) { collection.failed = true; throw error }
    })
  }

  private async sealFreshNativeOriginals(collection: FreshNativeCollection): Promise<void> {
    const filename = path.join(this.runtime.evidenceDir, `fresh-native-${collection.collectionId}/manifest.json`)
    await fsp.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
    await fsp.writeFile(filename, JSON.stringify({ schemaVersion: 1, candidateSha: this.runtime.candidateSha,
      runId: this.runtime.runId, runtimeImage: this.runtime.imageRef, selected: [collection.mode], conversations: [{
        mode: collection.mode, provider: collection.provider, soulId: collection.soulId, providerStoreId: collection.providerStoreId,
        nativeSessionId: collection.nativeSessionId, nonce: collection.nonce, stages: collection.stages }] }), { mode: 0o600 })
  }

  private nativeCollectionForCrash(handle: ExactRuntimeHandle, kind: string): FreshNativeCollection | undefined {
    const collection = [...this.freshNativeCollections.values()].find(value => value.soulId === handle.soulId && !value.closed)
    const addressFields = ['runId', 'candidateSha', 'soulId', 'incarnationId', 'containerId', 'hostBootId', 'nativeSessionId'] as const
    if (collection && (collection.failed || collection.crash || addressFields.some(field => collection.lastHandle[field] !== handle[field])
      || collection.stages.length !== (kind === 'session_host_exit' ? 1 : 2))) throw new Error('registered native crash order/current handle differs')
    return collection
  }

  private pendingFreshApprovalForCrash(handle: ExactRuntimeHandle): any {
    const matches = [...this.freshApprovalChallenges.values()].filter(value => value.soulId === handle.soulId && value.nativeRoot === handle.nativeSessionId
      && value.beforeCard && !value.currentCard && !value.finished)
    if (matches.length > 1 || matches[0]?.crash || matches[0] && matches[0].beforeView.incarnationId !== handle.incarnationId) throw new Error('one current pending approval recovery required')
    return matches[0]
  }

  private async retainFreshNativeExit(collection: FreshNativeCollection, handle: ExactRuntimeHandle, kind: string, requestedAt: number): Promise<void> {
    const deadline = Date.now() + 30_000
    const process = this.freshNativeProcesses.get(JSON.stringify(this.runtimeEnclosureHandle(handle)))
    while (Date.now() < deadline) {
      if (this.nativeCollectionsAborted) throw new Error('native collection aborted')
      const state = await this.ownedContainerState(this.runtimeEnclosureHandle(handle))
      let exited = !state.running && state.present
      if (kind === 'provider_process_exit' && state.running && process) {
        const observation = objectFields(JSON.parse(await this.ownedProviderExec(handle.containerId,
          ['python3', '-c', FRESH_NATIVE_EXIT_SCRIPT, String(process.native.pid), process.native.startTicks])), 'native exit observation is absent')
        exited = observation.exited === true
      }
      if (exited) {
        collection.crash = { kind, soulId: handle.soulId, nativeSessionId: handle.nativeSessionId, containerId: handle.containerId, incarnationId: handle.incarnationId, requestedAt,
          exitedAt: Date.now(), ...(process ? { nativePid: process.native.pid, startTicks: process.native.startTicks } : {}),
          observation: state.running ? 'exact-native-process-exited' : 'exact-owned-container-stopped' }
        return
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    collection.failed = true
    throw new Error('exact owned native exit was not observed')
  }

  async finishFreshNativeCollection(handle: ExactRuntimeHandle, collectionId: string): Promise<FreshNativeCollectionResult> {
    if (this.nativeCollectionsClosing || this.stopSettlement) throw new Error('fresh native collection is finished')
    return this.trackNativeCapture(async () => {
      const collection = await this.currentFreshCollection(handle, collectionId)
      try {
        if (collection.stages.length !== 3 || collection.crash) throw new Error('all three native recovery stages must settle before Stop')
        const result = await this.stopSoul(handle.soulId)
        const stopCompletedAt = Date.now()
        if (result.outcome !== 'verified_empty') throw new Error('fresh native Stop did not verify empty')
        const row = (await this.inventory()).filter(view => view.soulId === handle.soulId)
          .find(view => view.incarnationId === handle.incarnationId)
        const stoppedObservedAt = Date.now()
        if (!row || row.launchState !== 'stopped' || row.desiredState !== 'stopped' || row.cleanupState !== 'verified_empty'
          || row.nativeSessionId !== handle.nativeSessionId || row.containerId !== handle.containerId || row.hostBootId !== handle.hostBootId) throw new Error('exact stopped fresh native source is absent')
        const writer = await this.writerClaimFacts(handle)
        const writerObservedAt = Date.now()
        if (writer.providerStoreId !== collection.providerStoreId || writer.activeClaimCount !== 0 || writer.globalConflictingClaimCount !== 0) throw new Error('fresh native stopped source still has a writer')
        const receipts = this.runtime.broker.receipts().filter(receipt => receipt.containerId === handle.containerId && receipt.incarnationId === handle.incarnationId && receipt.soulId === handle.soulId)
        if (receipts.length !== 1 || !receipts[0]!.providerVolumeName || receipts[0]!.workspacePath !== this.repoRoot
          || receipts[0]!.imageRef !== this.runtime.imageRef) throw new Error('exact stopped fresh provider receipt is absent')
        if ((await this.ownedContainerState(this.runtimeEnclosureHandle(handle))).running) throw new Error('stopped fresh provider is running')
        const readStartedAt = Date.now()
        const captured = await this.readStoppedNativeHistory(handle, collection.provider, receipts[0]!)
        const readCompletedAt = Date.now()
        const prefix = `fresh-native-${collectionId}/stopped`
        const nativeFile = await this.materializeNativeSource(`${prefix}/completed`, captured)
        const store = await this.retainNativeOriginal(`${prefix}/store.json`, { containerId: handle.containerId,
          providerVolumeName: receipts[0]!.providerVolumeName, ...captured.rawSource })
        const last = collection.stages.at(-1)!.nativeFile as NativeOriginalReference
        const lastBytes = await fsp.readFile(path.join(this.runtime.evidenceDir, last.path))
        const finalBytes = await fsp.readFile(path.join(this.runtime.evidenceDir, nativeFile!.path))
        const { captureNativeHistory } = await import('../../test/e2e-browser/helpers/provider-native-history/probe-cli.js')
        const lastFilename = path.join(this.runtime.evidenceDir, last.path)
        const lastHistory = captureNativeHistory(collection.provider, collection.provider === 'opencode' ? lastFilename : path.dirname(lastFilename), collection.nativeSessionId)
        if (JSON.stringify(captured.turns) !== JSON.stringify(lastHistory.turns)) throw new Error('stopped native completions differ from the retained current source')
        if (collection.provider !== 'opencode' && !finalBytes.subarray(0, lastBytes.length).equals(lastBytes)) throw new Error('stopped native retained prefix changed')
        collection.stopped = await this.retainNativeOriginal(`${prefix}/read.json`, { nativeFile, store, stopResult: result, stoppedView: row, writer,
          stopCompletedAt, stoppedObservedAt, writerObservedAt, readStartedAt, readCompletedAt, completedTurnCount: captured.turns.length })
        const observed = deriveNativeRecoveryOriginals({ evidenceDir: this.runtime.evidenceDir, candidateSha: this.runtime.candidateSha,
          runId: this.runtime.runId, runtimeImage: this.runtime.imageRef, selected: [collection.mode],
          originalReference: { path: `fresh-native-${collectionId}/manifest.json`,
            sha256: createHash('sha256').update(await fsp.readFile(path.join(this.runtime.evidenceDir, `fresh-native-${collectionId}/manifest.json`))).digest('hex') } })
        collection.completedNativeTurns = nativeCompletedTurnProofs(observed[0]!)
        collection.closed = true
        if ([...this.freshNativeCollections.values()].every(value => value.closed && !value.failed)
          && this.freshAgentModes.every(mode => [...this.freshNativeCollections.values()].some(value => value.mode === mode))) {
          const collections = this.freshAgentModes.map(mode => [...this.freshNativeCollections.values()].find(value => value.mode === mode)!)
          await fsp.writeFile(path.join(this.runtime.evidenceDir, NATIVE_RECOVERY_ORIGINALS_FILE), JSON.stringify({
            schemaVersion: 1, candidateSha: this.runtime.candidateSha, runId: this.runtime.runId, runtimeImage: this.runtime.imageRef,
            selected: this.freshAgentModes, conversations: collections.map(value => ({ mode: value.mode, provider: value.provider,
              soulId: value.soulId, providerStoreId: value.providerStoreId, nativeSessionId: value.nativeSessionId, nonce: value.nonce,
              stages: value.stages, stopped: value.stopped })) }), { mode: 0o600 })
        }
        return this.nativeCollectionResult(collection)
      } catch (error) { collection.failed = true; throw error }
    })
  }

  abortFreshNativeCollections(): void {
    this.nativeCollectionsAborted = true
    this.nativeCollectionsClosing = true
    for (const collection of this.freshNativeCollections.values()) if (!collection.closed) collection.failed = true
    for (const probe of this.providerProbes.values()) {
      if (probe.child && probe.child.exitCode === null && probe.child.signalCode === null) probe.child.kill('SIGKILL')
    }
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

  private async assertOpenCodeContinuityEnclosure(handle: RuntimeEnclosureHandle): Promise<void> {
    if (this.runtime.phase !== 2) throw new Error('Phase 2 OpenCode continuity fixture required')
    await this.assertCurrentOpenCodeEnclosure(handle)
  }
  async openCodeContinuityFirstTurnCompleted(handle: RuntimeEnclosureHandle): Promise<boolean> {
    await this.assertOpenCodeContinuityEnclosure(handle)
    const raw = await this.ownedProviderExec(handle.containerId, ['sh', '-lc', 'cat /home/freshell/provider/p2-opencode-first-turn 2>/dev/null || true'])
    return raw.trim() === 'P2_OPENCODE_FIRST_TURN_DONE'
  }
  async openCodeContinuityFirstReply(handle: ExactRuntimeHandle): Promise<OpencodeContinuityFirstReply | null> {
    await this.assertOpenCodeContinuityEnclosure(handle)
    await this.assertCurrentHandle(handle)
    const raw = await this.ownedProviderExec(handle.containerId, ['node', '--no-warnings', '-e', OPENCODE_NATIVE_HISTORY_SCRIPT,
      '/home/freshell/provider/.local/share/opencode/opencode.db', handle.nativeSessionId])
    const history = z.object({ nativeSessionId: z.string(), turns: z.array(z.object({ text: z.string(),
      resolvedProvider: z.string(), resolvedModel: z.string() }).passthrough()) }).passthrough().parse(JSON.parse(raw))
    if (history.nativeSessionId !== handle.nativeSessionId) return null
    const turn = history.turns.find(candidate => candidate.text.includes('READY'))
    return turn ? { resolvedProvider: turn.resolvedProvider, resolvedModel: turn.resolvedModel } : null
  }
  async openCodeContinuityEffectCount(handle: RuntimeEnclosureHandle): Promise<number | null> {
    await this.assertOpenCodeContinuityEnclosure(handle)
    const raw = await this.ownedProviderExec(handle.containerId, ['sh', '-lc', 'test -f /home/freshell/provider/p2-opencode-tool-count && wc -l < /home/freshell/provider/p2-opencode-tool-count || echo 0'])
    const count = Number(raw.trim())
    return Number.isFinite(count) ? count : null
  }
  async openCodeContinuityFollowUpCompleted(handle: RuntimeEnclosureHandle): Promise<boolean> {
    await this.assertOpenCodeContinuityEnclosure(handle)
    const raw = await this.ownedProviderExec(handle.containerId, ['sh', '-lc', 'cat /home/freshell/provider/p2-opencode-followup 2>/dev/null || true'])
    return raw.trim() === 'P2_OPENCODE_FOLLOWUP_DONE'
  }
  async openCodeContinuityLongToolRunning(handle: RuntimeEnclosureHandle): Promise<boolean> {
    await this.assertOpenCodeContinuityEnclosure(handle)
    return this.ownedContainerProcessTable(handle.containerId).split(/\r?\n/).some(line => line.includes('sleep 12'))
  }
  async openCodeContinuityStartupFacts(handle: RuntimeEnclosureHandle): Promise<OpencodeContinuityStartupFacts> {
    await this.assertOpenCodeContinuityEnclosure(handle)
    const auth = await this.ownedProviderExec(handle.containerId, ['node', '--no-warnings', '-e', OPENCODE_CONTINUITY_AUTH_SCRIPT])
    const models = await this.ownedProviderExec(handle.containerId, ['opencode', 'models', 'openai'])
    const processes = this.ownedContainerExec(handle.containerId, ['sh', '-lc', "pgrep -af '[o]pencode' || true"])
    return OpencodeContinuityStartupFactsSchema.parse({ authPresent: auth.trim() === 'onecli managed OpenAI stub and CA present',
      modelAvailable: models.includes(P2_OPENCODE_MODEL.split('/')[1]), explicitModelArg: processes.includes(`--model ${P2_OPENCODE_MODEL}`),
      loopbackHostname: processes.includes('--hostname 127.0.0.1'), explicitPort: processes.includes('--port 4096') })
  }
  async openCodeQualificationStartupFacts(handle: RuntimeEnclosureHandle): Promise<OpencodeQualificationStartupFacts> {
    if (this.runtime.phase !== 5) throw new Error('Phase 5 OpenCode qualification fixture required')
    await this.assertCurrentOpenCodeEnclosure(handle)
    const processes = this.ownedContainerProcessTable(handle.containerId)
    const auth = await this.ownedProviderExec(handle.containerId, ['node', '--no-warnings', '-e',
      "const fs=require('node:fs');const auth=JSON.parse(fs.readFileSync('/home/freshell/provider/.local/share/opencode/auth.json','utf8'));const openai=auth.openai;if(!openai||openai.type!=='oauth'||openai.access!=='onecli-managed'||openai.refresh!=='onecli-managed'||openai.expires<Date.now()+3600000)process.exit(2);fs.accessSync('/home/freshell/provider/.config/onecli/gateway-ca.pem',fs.constants.R_OK);process.stdout.write('OneCLI OpenAI stub and CA present')"])
    const models = await this.ownedProviderExec(handle.containerId, ['opencode', 'models', 'openai'])
    return OpencodeQualificationStartupFactsSchema.parse({ modelProcessPresent: processes.includes(P2_OPENCODE_MODEL),
      authPresent: auth.trim() === 'OneCLI OpenAI stub and CA present', modelAvailable: models.includes(P2_OPENCODE_MODEL.split('/')[1]),
      limits: await this.openCodeQualificationLimits(handle) })
  }
  async openCodeQualificationLimits(handle: RuntimeEnclosureHandle): Promise<OpencodeQualificationStartupFacts['limits']> {
    if (this.runtime.phase !== 5) throw new Error('Phase 5 OpenCode qualification fixture required')
    await this.assertCurrentOpenCodeEnclosure(handle)
    const raw = this.ownedContainerExec(handle.containerId, ['sh', '-lc',
      `printf '{"cpuMax":"%s","memoryMax":"%s","swapMax":"%s","pidsMax":"%s"}' "$(cat /sys/fs/cgroup/cpu.max)" "$(cat /sys/fs/cgroup/memory.max)" "$(cat /sys/fs/cgroup/memory.swap.max)" "$(cat /sys/fs/cgroup/pids.max)"`])
    return OpencodeQualificationStartupFactsSchema.shape.limits.parse(JSON.parse(raw))
  }
  async openCodeReplacementReadiness(handle: RuntimeEnclosureHandle, terminalId: string): Promise<OpencodeReplacementReadiness> {
    if (this.runtime.phase !== 5) throw new Error('Phase 5 OpenCode qualification fixture required')
    await this.assertCurrentOpenCodeEnclosure(handle)
    const result = await this.runtime.adminOk(this.supervisor,
      this.runtime.terminalReadOutputBody(handle.soulId, 0, 256 * 1024, await this.controlEpoch()))
    const output = OpencodeReplacementReadinessSchema.omit({ sourceReady: true }).extend({
      frames: z.array(z.object({ streamEpoch: z.string(), terminalId: z.string(), data: z.string() }).passthrough()).optional(),
    }).passthrough().parse(this.dataOf(result, 'terminal_output'))
    const sourceText = (output.frames ?? []).map(frame => {
      if (frame.streamEpoch !== output.streamEpoch || frame.terminalId !== terminalId) {
        throw new Error('replacement prompt frame has mismatched ownership')
      }
      return frame.data
    }).join('').slice(-512 * 1024)
    if (output.incarnationId !== handle.incarnationId || output.terminalId !== terminalId) {
      throw new Error('replacement source identity does not match the current owner')
    }
    const { openCodeTerminalReady } = await import('./provider-native-history.js')
    const observation = OpencodeReplacementReadinessSchema.parse({ incarnationId: output.incarnationId, streamEpoch: output.streamEpoch,
      terminalId: output.terminalId, exited: output.exited, headSeq: output.headSeq,
      sourceReady: openCodeTerminalReady(sourceText, ['GPT-5.6 Luna', P2_OPENCODE_MODEL]) })
    this.openCodeReadiness.set(JSON.stringify(handle), observation)
    return { ...observation }
  }
  async confirmOpenCodeReplacementReadiness(handle: RuntimeEnclosureHandle, input: OpencodeReadinessConfirmation): Promise<void> {
    if (this.runtime.phase !== 5) throw new Error('Phase 5 OpenCode qualification fixture required')
    await this.assertCurrentOpenCodeEnclosure(handle)
    const confirmation = OpencodeReadinessConfirmationSchema.parse(input)
    const observed = this.openCodeReadiness.get(JSON.stringify(handle))
    if (!observed || !observed.sourceReady || observed.exited || observed.terminalId !== confirmation.terminalId
      || observed.streamEpoch !== confirmation.streamEpoch || observed.headSeq !== confirmation.headSeq) {
      throw new Error('matching observed owner source readiness required')
    }
    this.runtime.assert('PC-OPENCODE', true, 'replacement TUI prompt is source-observed and rendered before input', {
      soulId: handle.soulId, incarnationId: handle.incarnationId, terminalId: observed.terminalId,
      streamEpoch: observed.streamEpoch, cursor: observed.headSeq,
    })
  }
  async publishOpenCodeReadinessDiagnostic(handle: RuntimeEnclosureHandle, input: OpencodeReadinessDiagnostic): Promise<{ artifactRef: string }> {
    if (this.runtime.phase !== 5) throw new Error('Phase 5 OpenCode qualification fixture required')
    await this.assertCurrentOpenCodeEnclosure(handle)
    const diagnostic = OpencodeReadinessDiagnosticSchema.parse(input)
    if (diagnostic.soulId !== handle.soulId || diagnostic.incarnationId !== handle.incarnationId) {
      throw new Error('readiness diagnostic belongs to another identity')
    }
    const target = this.runtime.writeBrowserArtifact('opencode-replacement-readiness', diagnostic)
    const artifactRef = `opencode-replacement-readiness:${createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`
    this.runtime.recordLifecycle('external.opencode_readiness_diagnostic_published', { severity: 'info', artifactRef,
      soulId: handle.soulId, incarnationId: handle.incarnationId })
    return { artifactRef }
  }
  async registerOpenCodeQualificationNonce(handle: ExactRuntimeHandle, nonce: string): Promise<{ challengeId: string }> {
    if (this.runtime.phase !== 5) throw new Error('Phase 5 OpenCode qualification fixture required')
    if (!/^p-[A-Za-z0-9_-]{22}$/.test(nonce)) throw new Error('fixed qualification nonce shape required')
    await this.assertCurrentOpenCodeEnclosure(handle)
    await this.assertCurrentHandle(handle)
    const challengeId = randomUUID()
    this.nativeChallenges.set(challengeId, { soulId: handle.soulId, nativeSessionId: handle.nativeSessionId, marker: nonce })
    return { challengeId }
  }
  async openCodeQualificationTurn(handle: ExactRuntimeHandle, challengeId: string, stage: OpencodeQualificationProofStage,
    priorMessageIds: readonly string[], otherChallengeId?: string): Promise<OpencodeQualificationTurn | null> {
    if (this.runtime.phase !== 5) throw new Error('Phase 5 OpenCode qualification fixture required')
    await this.assertCurrentOpenCodeEnclosure(handle)
    const marker = await this.nativeChallengeMarker(handle, challengeId)
    if (!/^p-[A-Za-z0-9_-]{22}$/.test(marker)) throw new Error('registered qualification nonce required')
    const other = otherChallengeId ? this.nativeChallenges.get(otherChallengeId) : undefined
    if (otherChallengeId && (!other || !/^p-[A-Za-z0-9_-]{22}$/.test(other.marker))) {
      throw new Error('other registered qualification nonce required')
    }
    const raw = await this.ownedProviderExec(handle.containerId, ['node', '--no-warnings', '-e', OPENCODE_NATIVE_HISTORY_SCRIPT,
      '/home/freshell/provider/.local/share/opencode/opencode.db', handle.nativeSessionId])
    const history = z.object({ schemaVersion: z.literal(1), nativeSessionId: z.literal(handle.nativeSessionId),
      turns: z.array(OpencodeQualificationNativeTurnSchema) }).passthrough().parse(JSON.parse(raw))
    const { selectNativeAssistantTurn, nativeTurnProof } = await import('./provider-native-history.js')
    const turn = selectNativeAssistantTurn(history.turns, new Set(priorMessageIds), marker)
    if (!turn) return null
    return OpencodeQualificationTurnSchema.parse({ messageId: turn.messageId,
      proof: nativeTurnProof(stage, handle.nativeSessionId, turn, marker),
      containsOtherNonce: other ? turn.text.includes(other.marker) : null })
  }
  async openCodeQualificationAssistantMessageIds(handle: ExactRuntimeHandle): Promise<string[]> {
    if (this.runtime.phase !== 5) throw new Error('Phase 5 OpenCode qualification fixture required')
    await this.assertCurrentOpenCodeEnclosure(handle)
    await this.assertCurrentHandle(handle)
    const raw = await this.ownedProviderExec(handle.containerId, ['node', '--no-warnings', '-e', OPENCODE_NATIVE_HISTORY_SCRIPT,
      '/home/freshell/provider/.local/share/opencode/opencode.db', handle.nativeSessionId])
    const history = z.object({ schemaVersion: z.literal(1), nativeSessionId: z.literal(handle.nativeSessionId),
      turns: z.array(z.object({ messageId: z.string().min(1) }).passthrough()) }).passthrough().parse(JSON.parse(raw))
    return history.turns.map(turn => turn.messageId)
  }
  async openCodeQualificationNoticeCount(): Promise<number> {
    if (this.runtime.phase !== 5) throw new Error('Phase 5 OpenCode qualification fixture required')
    const result = await this.runtime.adminOk(this.supervisor,
      this.runtime.pendingNoticesBody('profile:opencode-provider-qualification', 100, await this.controlEpoch()))
    return z.array(z.unknown()).parse(this.dataOf(result, 'pending_notices')).length
  }
  async addOpenCodeQualificationSecondView(handle: ExactRuntimeHandle, expectedIntentRevision: number, expectedControlEpoch: number): Promise<void> {
    if (this.runtime.phase !== 5) throw new Error('Phase 5 OpenCode qualification fixture required')
    await this.assertCurrentHandle(handle)
    const row = await this.currentRuntimeEnclosure(handle)
    if (row.provider !== 'opencode') throw new Error('exact OpenCode runtime required')
    if (row.intentRevision !== expectedIntentRevision) throw new Error('qualification view revision is stale')
    if (await this.controlEpoch() !== expectedControlEpoch) throw new Error('qualification controller epoch is stale')
    const result = await this.runtime.adminOk(this.supervisor, this.runtime.upsertViewIntentBody({
      soulId: handle.soulId, intent: {
        ownerId: 'opencode-qualification-second-view', workspaceId: row.projectKey || 'opencode-qualification',
        kind: 'explicit', preferredTabId: 'opencode-qualification-second-tab',
        preferredPaneId: 'opencode-qualification-second-pane', title: 'OpenCode qualification second view',
        placementGroup: 'Recovered agents', visibility: 'visible',
      }, expectedSoulIntentRevision: expectedIntentRevision, expectedControlEpoch,
    }))
    this.dataOf(result, 'view_intent')
    this.runtime.recordLifecycle('external.opencode_qualification_second_view_applied', { severity: 'info',
      soulId: handle.soulId, incarnationId: handle.incarnationId, expectedIntentRevision, expectedControlEpoch })
  }
  async runOpenCodeQualificationBlockers(): Promise<string[]> {
    if (this.runtime.phase !== 5) throw new Error('Phase 5 OpenCode qualification fixture required')
    const tests = [
      ['freshell-agent-runtime', 'release_qualified_opencode_blocker_matrix_is_explicit'],
      ['freshell-agent-runtime', 'opencode_probe_reads_exact_row_without_guessing_latest'],
      ['freshell-supervisor', 'retry_budget_is_persisted_and_manual_retry_rearms_without_identity_change'],
    ]
    const mise = path.join(os.homedir(), '.local', 'bin', 'mise')
    for (const [index, [crate, filter]] of tests.entries()) {
      this.runtime.recordLifecycle('external.opencode_blocker_started', { severity: 'info', crate, filter })
      try {
        const stdout = this.runtime.runCommand(mise, ['exec', 'rust@1.96', '--', 'cargo', 'test', '-p', crate, filter, '--', '--nocapture'],
          { cwd: this.repoRoot })
        this.runtime.writeArtifact(`opencode-blocker-${index}.json`, { runId: this.runtime.runId,
          candidateSha: this.runtime.candidateSha, crate, filter, stdout })
        this.runtime.recordLifecycle('external.opencode_blocker_passed', { severity: 'info', crate, filter })
      } catch (error) {
        this.runtime.recordLifecycle('external.opencode_blocker_failed', { severity: 'error', crate, filter })
        throw error
      }
    }
    return tests.map(([crate, filter]) => `${crate}:${filter}`)
  }

  async lossCredentialEvidence(handle: RuntimeEnclosureHandle): Promise<OpencodeLossCredentialEvidence> {
    await this.assertCurrentOpenCodeEnclosure(handle)
    const raw = await this.ownedProviderExec(handle.containerId, ['node', '-e', OPENCODE_LOSS_CREDENTIAL_SCRIPT,
      '/home/freshell/provider/.local/share/opencode/auth.json'])
    return OpencodeLossCredentialEvidenceSchema.parse(JSON.parse(raw))
  }
  async lossDiagnosticRetained(handle: RuntimeEnclosureHandle): Promise<boolean> {
    await this.assertCurrentOpenCodeEnclosure(handle)
    const raw = await this.ownedProviderExec(handle.containerId, ['sh', '-lc', 'cat "$HOME/p5-diagnostic-only" 2>/dev/null || true'])
    return raw.trim() === 'phase5-diagnostic-retained-no-credential'
  }
  async lossAbsenceEvidence(handle: RuntimeEnclosureHandle): Promise<OpencodeLossAbsenceEvidence> {
    await this.assertCurrentOpenCodeEnclosure(handle)
    const rows = await Promise.all(OPENCODE_LOSS_TARGETS.map(async target => {
      const raw = await this.ownedProviderExec(handle.containerId, ['node', '-e', OPENCODE_LOSS_ABSENCE_SCRIPT, target])
      return OpencodeLossAbsenceCheckSchema.parse(JSON.parse(raw))
    }))
    return OpencodeLossAbsenceEvidenceSchema.parse(rows)
  }

  async removeLossStorage(handle: ExactRuntimeHandle): Promise<void> {
    if (this.runtime.phase !== 5) throw new Error('Phase 5 loss fixture required')
    await this.assertCurrentHandle(handle)
    await this.assertCurrentOpenCodeEnclosure(this.runtimeEnclosureHandle(handle))
    this.ownedContainerExec(handle.containerId, ['node', '-e', OPENCODE_LOSS_REMOVAL_SCRIPT])
  }
  async recoverLoss(handle: ExactRuntimeHandle): Promise<OpencodeLossRecovery> {
    if (this.runtime.phase !== 5) throw new Error('Phase 5 loss fixture required')
    await this.assertCurrentHandle(handle)
    await this.assertCurrentOpenCodeEnclosure(this.runtimeEnclosureHandle(handle))
    const result = await this.runtime.adminOk(this.supervisor,
      this.runtime.recoverBody(handle.soulId, 'provider_exit', await this.controlEpoch()))
    const data = OpencodeLossRecoverySchema.extend({ view: OpencodeLossRecoverySchema.shape.view.passthrough() })
      .passthrough().parse(this.dataOf(result, 'recovery'))
    const observed = OpencodeLossRecoverySchema.parse({ outcome: data.outcome, incidentId: data.incidentId,
      view: { cleanupState: data.view.cleanupState, nativeSessionId: data.view.nativeSessionId,
        intentRevision: data.view.intentRevision } })
    if (observed.outcome === 'lost') {
      this.lossRecovery = { handle: { ...handle }, incidentId: observed.incidentId }
      this.lossIncidentNativeHash = undefined
      this.lossAssertionsPublished = false
    }
    return observed
  }
  private observedLossHandle(incidentId: string): ExactRuntimeHandle {
    const observed = this.lossRecovery
    if (this.runtime.phase !== 5 || !observed || observed.incidentId !== incidentId
      || observed.handle.runId !== this.runtime.runId || observed.handle.candidateSha !== this.runtime.candidateSha
      || !this.runtime.broker.receipts().some(receipt => receipt.soulId === observed.handle.soulId
        && receipt.incarnationId === observed.handle.incarnationId && receipt.containerId === observed.handle.containerId)) {
      throw new Error('exact owner-observed loss incident required')
    }
    return observed.handle
  }
  async lossContainerRunning(incidentId: string): Promise<boolean> {
    const handle = this.observedLossHandle(incidentId)
    return this.runtime.isContainerRunning(handle.containerId)
  }
  async lossIncidentEvidence(incidentId: string): Promise<OpencodeLossIncidentEvidence> {
    const handle = this.observedLossHandle(incidentId)
    if (!/^incident-[a-zA-Z0-9_-]+$/.test(incidentId)) throw new Error('fixed observed incident file identity required')
    const summary = await this.runtime.adminOk(this.supervisor,
      this.runtime.incidentSummaryBody(incidentId, await this.controlEpoch()))
    this.dataOf(summary, 'incident_summary')
    const incidentPath = path.join('/var/lib/freshell-supervisor/incidents', `${incidentId}.closed.json`)
    const persisted = this.runtime.runCommand('docker', ['exec', this.supervisor.containerId, 'test', '-s', incidentPath]) === ''
    const raw = this.runtime.runCommand('docker', ['exec', this.supervisor.containerId, 'cat', incidentPath])
    const artifact: unknown = JSON.parse(raw)
    const fields = OpencodeLossIncidentEvidenceSchema.pick({ certificateSha256: true, certificate: true })
      .extend({ certificate: OpencodeLossIncidentEvidenceSchema.shape.certificate.passthrough() }).passthrough().parse(artifact)
    const { PHASE5_LOSS_INCIDENT_FILE } = await import('./runtime-phase5-loss-evidence.js')
    const target = this.runtime.writeArtifact(PHASE5_LOSS_INCIDENT_FILE, artifact)
    this.lossIncidentNativeHash = fields.certificate.nativeSessionRefHash
    return OpencodeLossIncidentEvidenceSchema.parse({ persisted,
      containsNativeSessionId: raw.includes(handle.nativeSessionId), containsControlSecret: raw.includes(this.supervisor.controlSecret),
      certificateSha256: fields.certificateSha256,
      certificate: { intentRevision: fields.certificate.intentRevision, nativeSessionRefHash: fields.certificate.nativeSessionRefHash },
      artifactRef: `phase5-loss-incident:${createHash('sha256').update(fs.readFileSync(target)).digest('hex')}` })
  }
  async publishLossAssertions(incidentId: string, input: RuntimeLossAssertions): Promise<RuntimeLossAssertionsArtifact> {
    const handle = this.observedLossHandle(incidentId)
    const assertions = RuntimeLossAssertionsSchema.parse(input)
    if (!this.lossIncidentNativeHash || assertions.identity.incidentId !== incidentId
      || assertions.identity.nativeSessionIdHash !== this.lossIncidentNativeHash
      || assertions.identity.soulId !== handle.soulId || assertions.identity.incarnationId !== handle.incarnationId
      || assertions.identity.containerId !== handle.containerId || assertions.identity.hostBootId !== handle.hostBootId) {
      throw new Error('exact observed loss incident assertions required')
    }
    const { PHASE5_LOSS_ASSERTIONS_FILE } = await import('./runtime-phase5-loss-evidence.js')
    const target = this.runtime.writeArtifact(PHASE5_LOSS_ASSERTIONS_FILE, { ...assertions,
      candidateSha: this.runtime.candidateSha, receiptRunId: this.runtime.runId })
    const result = RuntimeLossAssertionsArtifactSchema.parse({
      artifactRef: `phase5-loss-assertions:${createHash('sha256').update(fs.readFileSync(target)).digest('hex')}` })
    this.lossAssertionsPublished = true
    this.runtime.recordLifecycle('external.loss_assertions_published', { severity: 'info', ...result })
    return result
  }
  async finalizeLossReceipt(): Promise<RuntimeLossReceiptArtifact> {
    if (this.runtime.phase !== 5 || !this.receiptCandidateBefore || !this.lossAssertionsPublished || !this.lossIncidentNativeHash) {
      throw new Error('owned Phase5 loss observations and captured candidate required')
    }
    if (!this.stopSettlement) throw new Error('owned cleanup must settle before loss receipt finalization')
    const cleanup = await this.stopSettlement
    if (!cleanup.ok || cleanup.errors.length > 0) throw new Error('owned cleanup failed before loss receipt finalization')
    const { buildPhase5LossReceipt, PHASE5_CAPABILITY_INVENTORY_FILE } = await import('./runtime-phase5-loss-evidence.js')
    const inventory = path.join(this.runtime.evidenceDir, PHASE5_CAPABILITY_INVENTORY_FILE)
    fs.copyFileSync(path.join(this.repoRoot, 'docs/development/runtime-provider-capabilities.json'), inventory)
    fs.chmodSync(inventory, 0o600)
    const receipt = buildPhase5LossReceipt({ repoRoot: this.repoRoot, evidenceDir: this.runtime.evidenceDir,
      candidateSha: this.runtime.candidateSha, runtimeImage: this.runtime.imageRef, receiptRunId: this.runtime.runId,
      candidateBefore: this.receiptCandidateBefore, candidateAfter: await this.captureCandidateIntegrity() })
    const target = this.writePhase5LossReceipt(receipt)
    const artifactRef = `phase5-loss:${createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`
    process.stdout.write(`${JSON.stringify({ severity: 'info', event: 'external.loss_receipt_finalized',
      runId: this.runtime.runId, candidateSha: this.runtime.candidateSha, artifactRef })}\n`)
    return { artifactRef }
  }

  async crashProviderWorker(handle: ExactRuntimeHandle): Promise<void> {
    await this.assertCurrentHandle(handle)
    const row = (await this.inventory()).find(view => view.soulId === handle.soulId && view.launchState === 'running')
    const collection = this.nativeCollectionForCrash(handle, 'provider_process_exit')
    const approval = this.pendingFreshApprovalForCrash(handle)
    const facts = row?.freshAgentSessionType
      ? await this.freshAgentLaunchFacts(this.runtimeEnclosureHandle(handle))
      : await this.chaosHostFacts(handle)
    if (!Number.isSafeInteger(facts.workerPid) || facts.workerPid <= 1) throw new Error('exact host-recorded provider child PID required')
    this.runtime.recordLifecycle('external.provider_worker_crash', { severity: 'info', ...handle, workerPid: facts.workerPid })
    const requestedAt = Date.now()
    this.runtime.killOwnedRuntimePidExact(handle.containerId, facts.workerPid)
    if (collection) await this.retainFreshNativeExit(collection, handle, 'provider_process_exit', requestedAt)
    if (approval) await this.retainFreshNativeExit(approval, handle, 'provider_process_exit', requestedAt)
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

  async publishChaosLogs(handle: ExactRuntimeHandle, input: RuntimeChaosLogs): Promise<RuntimeChaosLogArtifacts> {
    await this.assertCurrentHandle(handle)
    const logs = RuntimeChaosLogsSchema.parse(input)
    const server = path.join(this.runtime.evidenceDir, 'phase5-chaos-server-log.jsonl')
    const browser = path.join(this.runtime.evidenceDir, 'phase5-chaos-browser-log.jsonl')
    writePrivateRuntimeChaosJsonl(server, logs.server)
    writePrivateRuntimeChaosJsonl(browser, logs.browser)
    const artifacts = { serverArtifactRef: `phase5-chaos-server-log:${createHash('sha256').update(fs.readFileSync(server)).digest('hex')}`,
      browserArtifactRef: `phase5-chaos-browser-log:${createHash('sha256').update(fs.readFileSync(browser)).digest('hex')}` }
    this.runtime.recordLifecycle('external.chaos_logs_published', { severity: 'info', ...artifacts })
    return artifacts
  }

  async publishChaosEvidence(handle: ExactRuntimeHandle, input: RuntimeChaosEvidence): Promise<RuntimeChaosEvidenceArtifacts> {
    await this.assertCurrentHandle(handle)
    const evidence = RuntimeChaosEvidenceSchema.parse(input)
    if (evidence.providerEvents.nativeSessionId !== handle.nativeSessionId) throw new Error('chaos provider root identity differs')
    const identity = evidence.assertions.identity
    if (identity.soulId !== handle.soulId || identity.incarnationId !== handle.incarnationId
      || identity.containerId !== handle.containerId || identity.hostBootId !== handle.hostBootId
      || identity.nativeSessionId !== handle.nativeSessionId) throw new Error('chaos observed address identity differs')
    const { schemaVersion, ...observations } = evidence.assertions
    const assertions = { schemaVersion, candidateSha: this.runtime.candidateSha, receiptRunId: this.runtime.runId, ...observations }
    assertions.candidateSha = this.runtime.candidateSha
    assertions.receiptRunId = this.runtime.runId
    const provider = path.join(this.runtime.evidenceDir, 'phase5-chaos-provider-events.json')
    const browser = path.join(this.runtime.evidenceDir, 'phase5-chaos-assertions.json')
    writePrivateJson(provider, evidence.providerEvents)
    writePrivateJson(browser, assertions)
    const artifacts = { providerEventsArtifactRef: `phase5-chaos-provider-events:${createHash('sha256').update(fs.readFileSync(provider)).digest('hex')}`,
      assertionsArtifactRef: `phase5-chaos-assertions:${createHash('sha256').update(fs.readFileSync(browser)).digest('hex')}` }
    this.runtime.recordLifecycle('external.chaos_evidence_published', { severity: 'info', ...artifacts })
    this.chaosEvidencePublished = true
    return artifacts
  }

  async finalizeChaosReceipt(): Promise<RuntimeChaosReceiptArtifact> {
    if (this.runtime.phase !== 5 || !this.receiptCandidateBefore || !this.chaosEvidencePublished) {
      throw new Error('owned Phase5 chaos observations and captured candidate required')
    }
    if (!this.stopSettlement) throw new Error('owned cleanup must settle before chaos receipt finalization')
    const cleanup = await this.stopSettlement
    if (!cleanup.ok || cleanup.errors.length > 0) throw new Error('owned cleanup failed before chaos receipt finalization')
    const { buildPhase5ChaosReceipt } = await import('./runtime-phase5-chaos-evidence.js')
    const inventory = path.join(this.runtime.evidenceDir, 'phase5-capability-inventory.json')
    fs.copyFileSync(path.join(this.repoRoot, 'docs/development/runtime-provider-capabilities.json'), inventory)
    fs.chmodSync(inventory, 0o600)
    const receipt = buildPhase5ChaosReceipt({ repoRoot: this.repoRoot, evidenceDir: this.runtime.evidenceDir,
      candidateSha: this.runtime.candidateSha, runtimeImage: this.runtime.imageRef, receiptRunId: this.runtime.runId,
      candidateBefore: this.receiptCandidateBefore, candidateAfter: await this.captureCandidateIntegrity() })
    const target = this.writePhase5ChaosReceipt(receipt)
    const artifactRef = `phase5-chaos:${createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`
    process.stdout.write(`${JSON.stringify({ severity: 'info', event: 'external.chaos_receipt_finalized',
      runId: this.runtime.runId, candidateSha: this.runtime.candidateSha, artifactRef })}\n`)
    return { artifactRef }
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

  private savedHistoryHostLifecycleEnabled(): boolean {
    return this.runtime.phase === 3 && this.enabledProviders.length === 0
      && this.fixtureFreshAgentModes.length === 1 && this.fixtureFreshAgentModes[0] === 'freshcodex'
  }

  async ownedRuntimeHostState(handle: RuntimeEnclosureHandle): Promise<RuntimeHostProcessState> {
    const container = await this.ownedContainerState(handle)
    if (!container.present || !container.running) throw new Error('exact recorded running enclosure required for host process state')
    const pid = this.runtime.ownedContainerHostPidExact(handle.containerId)
    const status = await fsp.readFile(`/proc/${pid}/status`, 'utf8')
    const state = RuntimeHostProcessStateSchema.parse({ pid, stopped: /State:\s+T/.test(status) })
    const held = [...this.heldHosts.entries()].find(([, value]) => value.handle.containerId === handle.containerId
      && value.handle.incarnationId === handle.incarnationId && value.handle.hostBootId === handle.hostBootId && value.pid === pid)
    if (this.savedHistoryHostLifecycleEnabled() && state.stopped && held && !this.recordedHistoryHolds.has(held[0])) {
      this.runtime.recordLifecycle('browser.owned_host_hold', { containerId: handle.containerId,
        incarnationId: handle.incarnationId, pid, state: 'T' })
      this.recordedHistoryHolds.add(held[0])
    }
    return state
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
    try {
      this.runtime.recordLifecycle('external.host_released', { severity: 'info', ...handle, pid: held.pid })
      if (this.savedHistoryHostLifecycleEnabled() && this.recordedHistoryHolds.has(key)) {
        this.runtime.recordLifecycle('browser.owned_host_release', { containerId: handle.containerId,
          incarnationId: handle.incarnationId, pid: held.pid })
      }
    } finally { this.recordedHistoryHolds.delete(key) }
  }

  async providerVolumeFacts(handle: ExactRuntimeHandle): Promise<{ providerVolumeName: string }> {
    await this.assertCurrentHandle(handle)
    const receipts = this.runtime.broker.receipts().filter(row => row.soulId === handle.soulId
      && row.incarnationId === handle.incarnationId && row.containerId === handle.containerId)
    if (receipts.length !== 1 || !receipts[0].providerVolumeName) throw new Error('exact current provider volume receipt required')
    return { providerVolumeName: receipts[0].providerVolumeName }
  }

  private async currentManagedTerminal(handle: RuntimeEnclosureHandle): Promise<ManagedRuntimeView & { provider: ManagedTerminalStartupFacts['provider'] }> {
    const row = await this.currentRuntimeEnclosure(handle)
    if (!row.provider || !this.enabledProviders.includes(row.provider) || row.freshAgentSessionType) {
      throw new Error('registered managed terminal provider required')
    }
    return { ...row, provider: ManagedTerminalStartupFactsSchema.shape.provider.parse(row.provider) }
  }

  async managedTerminalStartupFacts(handle: RuntimeEnclosureHandle): Promise<ManagedTerminalStartupFacts> {
    const { provider } = await this.currentManagedTerminal(handle)
    const versionCommand = provider === 'amplifier'
      ? ['/opt/amplifier-src/.venv/bin/python', '-c', 'import importlib.metadata as m; print(m.version("amplifier-app-cli"))']
      : [provider, '--version']
    const version = await this.ownedProviderExec(handle.containerId, versionCommand)
    const limits = JSON.parse(await this.ownedProviderExec(handle.containerId, ['node', '-e',
      "const fs=require('node:fs');const root='/sys/fs/cgroup/';process.stdout.write(JSON.stringify({cpuMax:fs.readFileSync(root+'cpu.max','utf8').trim(),memoryMax:fs.readFileSync(root+'memory.max','utf8').trim(),swapMax:fs.readFileSync(root+'memory.swap.max','utf8').trim(),pidsMax:fs.readFileSync(root+'pids.max','utf8').trim()}))",
    ]))
    const processTable = await this.ownedProviderExec(handle.containerId, ['ps', '-eo', 'pid,args'])
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const processIdentities = (['haiku', 'low', 'gpt-5.6-luna', P2_OPENCODE_MODEL] as const)
      .filter(identity => new RegExp(`(?:^|[\\s=:'"])${escape(identity)}(?:$|[\\s'"])`, 'm').test(processTable))
    return ManagedTerminalStartupFactsSchema.parse({ provider, version, limits,
      providerProcessPresent: new RegExp(`(?:^|\\s)(?:/[^\\s]*/)?${escape(provider)}(?:$|\\s)`, 'm').test(processTable),
      processIdentities, reasoningFlagsAbsent: !/(?:^|\s)--(?:reasoning-)?effort(?:=|\s)/m.test(processTable) })
  }

  async managedProviderPendingNoticeCount(handle: ExactRuntimeHandle): Promise<number> {
    await this.assertCurrentHandle(handle)
    const row = await this.currentManagedTerminal(handle)
    const result = await this.runtime.adminOk(this.supervisor, this.runtime.pendingNoticesBody(
      `profile:managed-provider-qualification:${row.provider}`, 100, await this.controlEpoch(),
    ))
    return z.array(z.unknown()).parse(this.dataOf(result, 'pending_notices')).length
  }

  async managedTerminalStoppedProofs(handle: ExactRuntimeHandle, nonce: string): Promise<ProviderQualificationRow['nativeTurnProofs']> {
    if (this.runtime.phase !== 5) throw new Error('Phase 5 managed terminal qualification required')
    if (!/^codename-[a-f0-9]{32}$/.test(nonce)) throw new Error('fixed terminal qualification nonce required')
    const rows = (await this.inventory()).filter(row => row.soulId === handle.soulId && row.incarnationId === handle.incarnationId)
    const row = rows[0]
    if (handle.runId !== this.runtime.runId || handle.candidateSha !== this.runtime.candidateSha || rows.length !== 1
      || row.launchState !== 'stopped' || row.desiredState !== 'stopped' || row.cleanupState !== 'verified_empty'
      || row.incarnationId !== handle.incarnationId || row.containerId !== handle.containerId || row.hostBootId !== handle.hostBootId
      || row.nativeSessionId !== handle.nativeSessionId || !row.provider || !this.enabledProviders.includes(row.provider)
      || row.freshAgentSessionType) throw new Error('exact registered stopped terminal handle required')
    const provider = ManagedTerminalStartupFactsSchema.shape.provider.parse(row.provider)
    const receipts = this.runtime.broker.receipts().filter(receipt => receipt.soulId === handle.soulId
      && receipt.incarnationId === handle.incarnationId && receipt.containerId === handle.containerId)
    const receipt = receipts[0]
    if (receipts.length !== 1 || !receipt.providerVolumeName || receipt.workspacePath !== this.repoRoot
      || receipt.imageRef !== this.runtime.imageRef) throw new Error('exact stopped provider source receipt required')
    if ((await this.ownedContainerState(handle)).running) throw new Error('stopped provider enclosure is still running')
    const claim = await this.writerClaimFacts(handle)
    if (claim.provider !== provider || claim.soulId !== handle.soulId || claim.incarnationId !== handle.incarnationId
      || claim.nativeSessionId !== handle.nativeSessionId || claim.activeClaimCount !== 0 || claim.globalConflictingClaimCount !== 0) {
      throw new Error('stopped native history requires a current zero-writer claim')
    }
    const history = await this.readStoppedNativeHistory(handle, provider, receipt)
    const turns = history.turns.filter((turn: import('./provider-native-history.js').NativeAssistantTurn) => turn.text.includes(nonce))
    if (turns.length !== 3) throw new Error(`native exact-session history must contain exactly three nonce-bearing completed assistant responses; found ${turns.length}`)
    const [initial, hostCrash, providerCrash] = turns
    if (!initial || !hostCrash || !providerCrash) throw new Error('three stopped native turns are required')
    const { nativeTurnProof } = await import('./provider-native-history.js')
    return RuntimeProviderNativeTurnProofsSchema.parse([
      nativeTurnProof('initial', handle.nativeSessionId, initial, nonce),
      nativeTurnProof('after_session_host_crash', handle.nativeSessionId, hostCrash, nonce),
      nativeTurnProof('after_provider_process_crash', handle.nativeSessionId, providerCrash, nonce),
    ])
  }

  private async readStoppedNativeHistory(handle: ExactRuntimeHandle, provider: string, receipt: BrokerReceipt): Promise<FreshCapturedNativeHistory> {
    const nativeHistoryTool = this.prepareNativeHistoryTool()
    const source = provider === 'claude' ? '/home/freshell/provider/.claude/projects'
      : provider === 'codex' ? '/home/freshell/provider/.codex/sessions'
      : provider === 'opencode' ? '/home/freshell/provider/.local/share/opencode/opencode.db' : '/home/freshell/provider/.amplifier/projects'
    const helperName = `freshell-history-${randomUUID()}`
    let helperId: string | null = null
    let helperExitStatus: string | null = null
    let refusal: Error | undefined
    let logsAttempted = false
    let failure: unknown
    const probe = (args: string[]) => this.trackedDockerProbe(handle.containerId, args, true, { ...handle, provider, helperName })
    const retain = () => this.runtime.writeArtifact(`stopped-native-history-${helperName}.json`, {
      ...handle, provider, runtimeImage: this.runtime.imageRef, providerVolumeName: receipt.providerVolumeName,
      helperName, helperId, helperExitStatus,
    })
    try {
      helperId = (await probe(['create', '--name', helperName, '--tty',
        '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:0',
        '--memory', '256m', '--memory-swap', '256m', '--cpus', '0.5', '--pids-limit', '32',
        '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m', '--env', 'HOME=/home/freshell/provider',
        '--mount', `type=volume,source=${receipt.providerVolumeName},target=/home/freshell/provider,readonly`,
        '--mount', `type=bind,source=${this.repoRoot},target=${this.repoRoot},readonly`, '--workdir', this.repoRoot,
        '--entrypoint', 'node', this.runtime.imageRef, '--no-warnings', nativeHistoryTool, provider, source, handle.nativeSessionId,
      ])).trim()
      if (!/^[a-f0-9]{64}$/.test(helperId)) throw new Error('native history helper acknowledgement is invalid')
      await probe(['start', helperId])
      helperExitStatus = (await probe(['wait', helperId])).trim()
      if (helperExitStatus !== '0') refusal = new Error('native history helper refused the exact stopped source')
      retain()
      logsAttempted = true
      const raw = await probe(['logs', helperId])
      if (refusal) throw refusal
      const history: FreshCapturedNativeHistory = JSON.parse(raw)
      if (history.schemaVersion !== 1 || history.provider !== provider || history.nativeSessionId !== handle.nativeSessionId) {
        throw new Error('stopped native history identity differs')
      }
      return history
    } catch (error) {
      failure = refusal && error !== refusal ? new AggregateError([refusal, error],
        'stopped native history helper refused and evidence collection failed') : error
      // A failed wait/start transport can still leave useful helper output.
      // Keep collection bounded to this already acknowledged, owned helper.
      if (helperId && /^[a-f0-9]{64}$/.test(helperId) && !logsAttempted) {
        logsAttempted = true
        try { await probe(['logs', helperId]) }
        catch (logsError) { failure = new AggregateError([failure, logsError], 'stopped native history read and log collection failed') }
      }
      try { retain() }
      catch (retentionError) { failure = new AggregateError([failure, retentionError], 'stopped native history read and diagnostic retention failed') }
      throw failure
    } finally {
      try { await probe(['rm', '--force', helperName]) }
      catch (cleanupError) {
        if (failure) throw new AggregateError([failure, cleanupError], 'stopped native history read and helper cleanup failed')
        throw cleanupError
      }
    }
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

  private async assertFreshCodexSavedHistoryFixture(handle: ExactRuntimeHandle): Promise<void> {
    if (this.runtime.phase !== 3 || !this.fixtureFreshAgentModes.includes('freshcodex')) throw new Error('registered Phase 3 fresh Codex history fixture required')
    await this.assertCurrentHandle(handle)
    const row = (await this.inventory()).find(view => view.soulId === handle.soulId && view.launchState === 'running')
    if (row?.provider !== 'codex' || row.freshAgentSessionType !== 'freshcodex') throw new Error('exact fresh Codex history fixture required')
  }

  async prepareInterruptedOrdinaryStopHistory(handle: ExactRuntimeHandle): Promise<void> {
    await this.assertFreshCodexSavedHistoryFixture(handle)
    if (this.supervisor.binaryKind !== 'test' || this.interruptedStop) throw new Error('unprepared interrupted Stop test fixture required')
    const transcript = [
      { type: 'session_meta', payload: { id: handle.nativeSessionId, cwd: '/workspace', model_provider: 'openai' } },
      ...[0, 1, 2].flatMap((index) => [
        { type: 'event_msg', payload: { type: 'task_started', turn_id: `stop-retained-${index}` } },
        { type: 'event_msg', payload: { type: 'user_message', message: `Synthetic saved prompt ${index}` } },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: `stop-retained-${index}`,
          last_agent_message: `Synthetic saved answer ${index}` } },
      ]),
    ].map((row) => JSON.stringify(row)).join('\n') + '\n'
    await this.ownedProviderExec(handle.containerId, ['node', '--input-type=module', '-e',
      'import fs from "node:fs"; import path from "node:path"; fs.mkdirSync(path.dirname(process.argv[1]), {recursive:true}); fs.writeFileSync(process.argv[1],process.argv[2]);',
      freshCodexFixtureTranscriptPath(handle.nativeSessionId), transcript])
    this.interruptedStop = { handle: { ...handle }, volumeName: this.supervisor.volumeName,
      runtimeRoot: this.supervisor.runtimeRoot, scenarioId: this.supervisor.scenarioId, countersInstalled: false }
    this.runtime.recordLifecycle('external.interrupted_stop_history_prepared', { severity: 'info', ...handle })
  }

  // The current-running guard cannot apply while the controller is dead or the
  // original Stop has settled. Retain its exact admitted identity and check the
  // original receipt, registry volume and host boot before every later probe.
  private async interruptedStopFixture(handle: ExactRuntimeHandle) {
    const fixture = this.interruptedStop
    if (!fixture || (['runId', 'candidateSha', 'soulId', 'incarnationId', 'containerId', 'hostBootId', 'nativeSessionId'] as const)
      .some(field => handle[field] !== fixture.handle[field])
      || this.supervisor.binaryKind !== 'test' || this.supervisor.volumeName !== fixture.volumeName
      || this.supervisor.runtimeRoot !== fixture.runtimeRoot || this.supervisor.scenarioId !== fixture.scenarioId) {
      throw new Error('original registered interrupted Stop owner identity required')
    }
    const receipts = this.runtime.broker.receipts().filter(receipt => receipt.soulId === handle.soulId
      && receipt.incarnationId === handle.incarnationId && receipt.containerId === handle.containerId)
    if (receipts.length !== 1 || receipts[0].runtimeDir !== path.join(fixture.runtimeRoot, handle.incarnationId)) {
      throw new Error('original interrupted Stop broker receipt required')
    }
    const host = z.object({ hostBootId: z.literal(handle.hostBootId), workerLaunchCount: z.number().int().nonnegative() })
      .safeParse(JSON.parse(await fsp.readFile(path.join(receipts[0].runtimeDir, 'host-state.json'), 'utf8')))
    if (!host.success) throw new Error('interrupted Stop host boot identity changed or is unreadable')
    return { fixture, workerLaunchCount: host.data.workerLaunchCount }
  }

  async armInterruptedOrdinaryStop(handle: ExactRuntimeHandle): Promise<void> {
    const { fixture } = await this.interruptedStopFixture(handle)
    await this.assertFreshCodexSavedHistoryFixture(handle)
    if (fixture.crashSupervisorId) throw new Error('interrupted Stop fault is already armed')
    const supervisor = await this.replaceSupervisor('graceful', 'ordinary_stop_after_intent')
    fixture.crashSupervisorId = supervisor.containerId
    this.runtime.recordLifecycle('external.interrupted_stop_armed', { severity: 'info', ...handle,
      supervisorContainerId: supervisor.containerId, crashPoint: 'ordinary_stop_after_intent' })
  }

  async installInterruptedOrdinaryStopCounters(handle: ExactRuntimeHandle): Promise<InterruptedOrdinaryStopFacts> {
    const { fixture } = await this.interruptedStopFixture(handle)
    await this.assertFreshCodexSavedHistoryFixture(handle)
    if (fixture.crashSupervisorId !== this.supervisor.containerId || fixture.countersInstalled) {
      throw new Error('armed interrupted Stop before counter installation required')
    }
    const result = await this.readInterruptedOrdinaryStopFacts(handle, true)
    fixture.countersInstalled = true
    return result
  }

  async interruptedOrdinaryStopFacts(handle: ExactRuntimeHandle): Promise<InterruptedOrdinaryStopFacts> {
    const { fixture } = await this.interruptedStopFixture(handle)
    if (!fixture.countersInstalled) throw new Error('installed interrupted Stop effect counters required')
    return this.readInterruptedOrdinaryStopFacts(handle, false)
  }

  private async readInterruptedOrdinaryStopFacts(handle: ExactRuntimeHandle, install: boolean): Promise<InterruptedOrdinaryStopFacts> {
    const { workerLaunchCount } = await this.interruptedStopFixture(handle)
    const durable = InterruptedOrdinaryStopDurableFactsSchema.parse(JSON.parse(this.runtime.execOwnedContainerExact(
      this.supervisor.containerId, ['python3', '-c', INTERRUPTED_ORDINARY_STOP_REGISTRY_SCRIPT,
        handle.soulId, install ? 'install' : 'read'])))
    if (durable.soul.soul_id !== handle.soulId || durable.soul.native_session_id !== handle.nativeSessionId
      || !durable.incarnations.some(row => row.incarnation_id === handle.incarnationId && row.container_id === handle.containerId)) {
      throw new Error('interrupted Stop durable identity changed')
    }
    const lifecycle = (await this.readOwnedLifecycle()).filter(event => (
      event.event === 'supervisor.stop_committed' || event.event === 'supervisor.stop_continuation'
    ) && z.object({ soulId: z.string().optional() }).parse(event.data).soulId === handle.soulId)
      .map(event => InterruptedOrdinaryStopLifecycleSchema.parse(event))
    return { durable, workerLaunchCount, lifecycle }
  }

  async interruptedOrdinaryStopCrashFacts(handle: ExactRuntimeHandle): Promise<InterruptedOrdinaryStopCrashFacts> {
    const { fixture } = await this.interruptedStopFixture(handle)
    const containerId = fixture.crashSupervisorId
    if (!containerId || containerId !== this.supervisor.containerId) throw new Error('exact armed interrupted Stop supervisor required')
    const state = z.object({ State: z.object({ Running: z.boolean(), ExitCode: z.number().int() }) })
      .parse(this.runtime.inspectContainer(containerId)).State
    const observed = this.runtime.containerLogs(containerId).split('\n').some(line => {
      try { const row = JSON.parse(line); return row.event === 'supervisor.test_crash' && row.point === 'ordinary_stop_after_intent' }
      catch { return false }
    })
    const facts = { running: state.Running, exitCode: state.ExitCode,
      crashPoint: observed ? 'ordinary_stop_after_intent' as const : null }
    fixture.crash = facts
    return facts
  }

  async publishInterruptedOrdinaryStopResult(handle: ExactRuntimeHandle, retainedTurns: number): Promise<{ artifactRef: string }> {
    const { fixture } = await this.interruptedStopFixture(handle)
    const facts = await this.interruptedOrdinaryStopFacts(handle)
    const crash = fixture.crash
    if (retainedTurns !== 6 || !crash || crash.running || crash.exitCode !== 134
      || crash.crashPoint !== 'ordinary_stop_after_intent' || facts.durable.soul.desired_state !== 'stopped') {
      throw new Error('observed interrupted Stop crash and retained stopped history required')
    }
    const target = this.runtime.writeArtifact('task006-interrupted-stop.json', {
      caseName: 'synthetic interrupted ordinary Stop preserves history', status: 'PASS',
      soulId: handle.soulId, incarnationId: handle.incarnationId, nativeSessionId: handle.nativeSessionId,
      intentRevision: facts.durable.soul.intent_revision, crashPoint: crash.crashPoint, crashExitCode: crash.exitCode,
      retainedTurns, workerLaunchCount: facts.workerLaunchCount, effects: facts.durable.effects,
    })
    const artifactRef = `interrupted-ordinary-stop:${createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`
    this.runtime.recordLifecycle('external.interrupted_stop_artifact', { severity: 'info', ...handle, artifactRef })
    return { artifactRef }
  }

  async publishFreshCodexSavedHistoryPreservation(handle: ExactRuntimeHandle, input: FreshCodexSavedHistoryPreservation): Promise<{ artifactRef: string }> {
    let stage = 'current_fixture'
    try {
      await this.assertFreshCodexSavedHistoryFixture(handle)
      stage = 'input_validation'
      const data = FreshCodexSavedHistoryPreservationSchema.parse(input)
      stage = 'identity'
      if (data.nativeSessionId !== handle.nativeSessionId || data.heldHost.containerId !== handle.containerId
        || data.heldHost.incarnationId !== handle.incarnationId || data.originalIdentity.soulId !== handle.soulId
        || data.originalIdentity.sessionRef.provider !== 'codex' || data.originalIdentity.sessionRef.sessionId !== handle.nativeSessionId) {
        throw new Error('exact observed saved-history identity required')
      }
      stage = 'captured_states'
      const beforeHistory = this.savedHistoryFixtureStates.get(JSON.stringify(data.beforeHistory))
      const afterReload = this.savedHistoryFixtureStates.get(JSON.stringify(data.afterReload))
      if (!beforeHistory || !afterReload) throw new Error('captured private fixture states required before history publication')
      stage = 'history_sources'
      if (!await this.freshCodexSavedHistoryUnchanged(handle) || !await this.coincidentFreshCodexHistoryUnchanged(handle)) {
        throw new Error('both observed history sources must remain unchanged')
      }
      stage = 'managed_launch'
      const lifecycle = await this.readOwnedLifecycle()
      const managedLaunch = lifecycle.filter(event => event.event === data.managedLaunch.event && event.at === data.managedLaunch.at
        && z.object({ soulId: z.string(), incarnationId: z.string(), containerId: z.string(), workerLaunchCount: z.number() }).parse(event.data).soulId === handle.soulId).at(-1)
      const observedLaunch = FreshCodexSavedHistoryOwnershipFactsSchema.shape.launches.element.parse(managedLaunch)
      if (observedLaunch.data.incarnationId !== handle.incarnationId || observedLaunch.data.containerId !== handle.containerId
        || observedLaunch.data.workerLaunchCount !== data.managedLaunch.data.workerLaunchCount) throw new Error('observed owned launch required')
      stage = 'controller_reattachment'
      const ownerLifecycle = await this.readOwnedLifecycle('owner')
      const controller = ownerLifecycle.filter(event => event.event === 'browser.owned_controller_reattached'
        && z.object({ completedAt: z.number() }).parse(event.data).completedAt === data.observerWindow.controllerReattachment.completedAt).at(-1)
      if (!controller) throw new Error('recorded owned controller reattachment required')
      const observedController = FreshCodexControllerReattachmentSchema.parse(controller.data)
      if (observedController.currentControllerId !== data.observerWindow.controllerReattachment.currentControllerId
        || observedController.reattached.soulId !== handle.soulId || observedController.reattached.incarnationId !== handle.incarnationId) {
        throw new Error('recorded controller differs from the observed history runtime')
      }
      stage = 'startup_window'
      if (observedController.startupFinished.at !== data.observerWindow.startupFinished.at) throw new Error('observed startup timestamp differs from its history window')
      const privateStartup = z.object({ startupFinished: z.unknown() }).parse(controller.data).startupFinished
      stage = 'artifact_write'
      const target = this.runtime.writeBrowserArtifact('owned-host-history-preservation', { ...data, beforeHistory, afterReload, managedLaunch,
        observerWindow: { ...data.observerWindow, controllerReattachment: controller.data, startupFinished: privateStartup } })
      fs.chmodSync(target, 0o600)
      const artifactRef = `owned-host-history-preservation:${createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`
      this.runtime.recordLifecycle('external.saved_history_preservation_artifact', { severity: 'info', ...handle, artifactRef })
      return { artifactRef }
    } catch (error) {
      this.runtime.recordLifecycle('external.saved_history_preservation_refused', { severity: 'warn', ...handle, stage })
      throw error
    }
  }

  async publishFreshCodexSavedHistoryMeasurement(enclosure: RuntimeEnclosureHandle, input: FreshCodexSavedHistoryMeasurement): Promise<{ artifactRef: string }> {
    if (this.runtime.phase !== 3 || !this.fixtureFreshAgentModes.includes('freshcodex')) throw new Error('registered Phase 3 fresh Codex history fixture required')
    await this.ownedContainerState(enclosure)
    const measurement = FreshCodexSavedHistoryMeasurementSchema.parse(input)
    const target = this.runtime.writeBrowserArtifact('saved-history-render-measurement', measurement)
    fs.chmodSync(target, 0o600)
    const artifactRef = `saved-history-render-measurement:${createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`
    this.runtime.recordLifecycle('external.saved_history_measurement_artifact', { severity: 'info', ...enclosure, artifactRef })
    return { artifactRef }
  }

  async recordFreshCodexControllerReattachment(handle: ExactRuntimeHandle, input: FreshCodexControllerReattachment): Promise<void> {
    await this.assertFreshCodexSavedHistoryFixture(handle)
    const data = FreshCodexControllerReattachmentSchema.parse(input)
    if (data.currentControllerId !== this.supervisor.containerId || data.currentControllerId === data.oldControllerId
      || data.currentControlEpoch !== data.controllerReady.data.controlEpoch || data.currentControlEpoch <= data.oldControlEpoch
      || data.reattached.soulId !== handle.soulId || data.reattached.incarnationId !== handle.incarnationId
      || data.reattached.containerId !== handle.containerId || data.reattached.hostBootId !== handle.hostBootId
      || data.reattached.nativeSessionId !== handle.nativeSessionId) throw new Error('exact observed controller and reattached runtime required')
    const lifecycle = await this.readOwnedLifecycle()
    const controllerReady = lifecycle.filter(event => event.event === data.controllerReady.event && event.at === data.controllerReady.at).at(-1)
    const startupFinished = lifecycle.filter(event => event.event === data.startupFinished.event && event.at === data.startupFinished.at).at(-1)
    const observed = FreshCodexControllerStartupFactsSchema.pick({ controllerReady: true, startupFinished: true }).parse({ controllerReady, startupFinished })
    const ready = observed.controllerReady.data, startup = observed.startupFinished.data
    if (ready.controlEpoch !== data.controllerReady.data.controlEpoch || ready.installationId !== data.controllerReady.data.installationId
      || startup.scanned !== data.startupFinished.data.scanned
      || startup.blockedSubsystems.length !== data.startupFinished.data.blockedSubsystems.length
      || startup.blockedSubsystems.some((value, index) => value !== data.startupFinished.data.blockedSubsystems[index])) {
      throw new Error('controller startup observation differs from its owned lifecycle')
    }
    this.runtime.recordLifecycle('browser.owned_controller_reattached', { ...data, controllerReady, startupFinished })
  }

  async finishFreshCodexSavedHistoryMeasurement(enclosure: RuntimeEnclosureHandle, input: FreshCodexHistoryMeasurementFinish): Promise<void> {
    if (this.runtime.phase !== 3 || !this.fixtureFreshAgentModes.includes('freshcodex')) throw new Error('registered Phase 3 fresh Codex history fixture required')
    await this.ownedContainerState(enclosure)
    const measurement = FreshCodexHistoryMeasurementFinishSchema.parse(input)
    this.runtime.recordLifecycle('browser.saved_history_measurement.finished', measurement)
  }

  async startFreshCodexSavedHistoryMeasurement(handle: ExactRuntimeHandle, input: FreshCodexHistoryMeasurementStart): Promise<void> {
    await this.assertFreshCodexSavedHistoryFixture(handle)
    const measurement = FreshCodexHistoryMeasurementStartSchema.parse(input)
    this.runtime.recordLifecycle('browser.saved_history_measurement.started', measurement)
  }

  private async readOwnedLifecycle(source: 'supervisor' | 'owner' = 'supervisor') {
    const file = source === 'owner' ? this.runtime.lifecyclePath
      : path.join(path.dirname(this.supervisor.runtimeRoot), 'evidence', 'lifecycle.jsonl')
    return (await fsp.readFile(file, 'utf8'))
      .split('\n').filter(Boolean).map((line: string) => z.object({ event: z.string() }).passthrough().parse(JSON.parse(line)))
  }

  async freshCodexSavedHistoryOwnershipFacts(handle: ExactRuntimeHandle): Promise<FreshCodexSavedHistoryOwnershipFacts> {
    await this.assertFreshCodexSavedHistoryFixture(handle)
    const receiptContainerIds = this.runtime.broker.receipts().filter(receipt => receipt.soulId === handle.soulId)
      .map(receipt => receipt.containerId)
    const startCount = this.runtime.broker.eventsSnapshot().filter(event => event.containerId === handle.containerId
      && event.method === 'POST' && event.url === `/v1.47/containers/${handle.containerId}/start`).length
    const lifecycle = await this.readOwnedLifecycle()
    const matching = (name: string) => lifecycle.filter(event => event.event === name
      && z.object({ soulId: z.unknown().optional() }).parse(event.data).soulId === handle.soulId)
    return FreshCodexSavedHistoryOwnershipFactsSchema.parse({ receiptContainerIds, startCount,
      launches: matching('supervisor.launch_running'), targetSoulRecoveries: matching('supervisor.runtime_observer.recovery_scheduled') })
  }

  async freshCodexControllerStartupFacts(handle: ExactRuntimeHandle): Promise<FreshCodexControllerStartupFacts> {
    await this.assertFreshCodexSavedHistoryFixture(handle)
    const controllerHealth = (await this.runtime.adminOk(this.supervisor, { method: 'health' })).data
    const lifecycle = await this.readOwnedLifecycle()
    const startupFinished = lifecycle.filter(event => event.event === 'supervisor.startup_scan.finished').at(-1)
    const controllerReady = lifecycle.filter(event => event.event === 'supervisor.ready').at(-1)
    return FreshCodexControllerStartupFactsSchema.parse({ controllerHealth, startupFinished, controllerReady })
  }

  async freshCodexRetainedSnapshotFacts(handle: ExactRuntimeHandle): Promise<FreshCodexRetainedSnapshotFacts> {
    await this.assertFreshCodexSavedHistoryFixture(handle)
    const reply = await this.runtime.adminOk(this.supervisor, { method: 'fresh_agent_read_snapshot',
      params: { soulId: handle.soulId, expectedControlEpoch: await this.controlEpoch() } })
    const snapshot = z.object({ threadId: z.string(), turns: z.array(z.object({ turnId: z.string(),
      items: z.array(z.object({ text: z.string().optional() }).passthrough()) }).passthrough()),
      extensions: z.object({ codex: z.object({ nativeHistoryRetention: z.unknown().optional() }).passthrough() }).passthrough(),
    }).passthrough().parse(reply.data)
    const first = snapshot.turns[1]?.items.find(item => item.text?.startsWith('Managed retained answer 0'))
    const last = snapshot.turns[159]?.items.find(item => item.text?.startsWith('Managed fixture saved answer'))
    return { threadId: snapshot.threadId, bytes: Buffer.byteLength(JSON.stringify(reply.data)), turnCount: snapshot.turns.length,
      firstTurnId: snapshot.turns[0]?.turnId ?? null, lastTurnId: snapshot.turns[159]?.turnId ?? null,
      firstAnswerMatches: first?.text === `Managed retained answer 0\n${'x'.repeat(20_000)}`,
      lastAnswerMatches: last?.text === `Managed fixture saved answer\n${'x'.repeat(20_000)}`,
      retentionAbsent: snapshot.extensions.codex.nativeHistoryRetention === undefined }
  }

  async prepareFreshCodexSavedHistory(handle: ExactRuntimeHandle): Promise<{ bytes: number }> {
    await this.assertFreshCodexSavedHistoryFixture(handle)
    const target = freshCodexFixtureTranscriptPath(handle.nativeSessionId)
    const raw = await this.ownedProviderExec(handle.containerId, ['node', '--input-type=module', '-e',
      `import fs from "node:fs"; import path from "node:path"; const makeTranscript = ${freshCodexSavedTranscript.toString()}; fs.mkdirSync(path.dirname(process.argv[1]), {recursive:true}); fs.writeFileSync(process.argv[1], makeTranscript(process.argv[2])); process.stdout.write(JSON.stringify({bytes: fs.statSync(process.argv[1]).size}));`,
      target, handle.nativeSessionId])
    const result = z.object({ bytes: z.number().int().positive() }).strict().parse(JSON.parse(raw))
    this.runtime.recordLifecycle('external.freshcodex_saved_history_prepared', { severity: 'info', ...handle, bytes: result.bytes })
    return result
  }

  async freshCodexSavedHistoryUnchanged(handle: ExactRuntimeHandle): Promise<boolean> {
    await this.assertFreshCodexSavedHistoryFixture(handle)
    const raw = await this.ownedProviderExec(handle.containerId, ['cat',
      freshCodexFixtureTranscriptPath(handle.nativeSessionId)])
    return preservesFreshCodexSavedTranscript(raw, handle.nativeSessionId)
  }

  private coincidentFreshCodexHistoryPath(handle: ExactRuntimeHandle): string {
    if (!this.web) throw new Error('owned web HOME required for coincident fixture history')
    return path.join(this.web.info.homeDir, '.codex', 'sessions', `rollout-${handle.nativeSessionId}.jsonl`)
  }

  async prepareCoincidentFreshCodexHistory(handle: ExactRuntimeHandle): Promise<void> {
    await this.assertFreshCodexSavedHistoryFixture(handle)
    const target = this.coincidentFreshCodexHistoryPath(handle)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, freshCodexSavedTranscript(handle.nativeSessionId)
      .replaceAll('Managed fixture saved answer', 'Wrong web-local answer'))
    this.runtime.recordLifecycle('external.freshcodex_coincident_history_prepared', { severity: 'info', ...handle })
  }

  async coincidentFreshCodexHistoryUnchanged(handle: ExactRuntimeHandle): Promise<boolean> {
    await this.assertFreshCodexSavedHistoryFixture(handle)
    return await fsp.readFile(this.coincidentFreshCodexHistoryPath(handle), 'utf8') ===
      freshCodexSavedTranscript(handle.nativeSessionId).replaceAll('Managed fixture saved answer', 'Wrong web-local answer')
  }

  async fixtureNativeState(handle: ExactRuntimeHandle): Promise<FixtureNativeState> {
    const row = (await this.inventory()).find((view) => view.soulId === handle.soulId && view.launchState === 'running')
    if (!row?.freshAgentSessionType || !this.fixtureFreshAgentModes.includes(row.freshAgentSessionType)) {
      throw new Error('registered deterministic fresh-agent fixture required')
    }
    if (!this.savedHistoryHostLifecycleEnabled()) return this.runtime.fixtureNativeState(this.supervisor, handle)
    let captured: unknown
    const state = await this.runtime.fixtureNativeState(this.supervisor, handle, value => { captured = value })
    if (captured === undefined) throw new Error('private fixture state capture is unavailable')
    const key = JSON.stringify(state), previous = this.savedHistoryFixtureStates.get(key)
    if (previous !== undefined && !(await import('node:util')).isDeepStrictEqual(previous, captured)) {
      throw new Error('private fixture state changed without its observed counters')
    }
    this.savedHistoryFixtureStates.set(key, captured)
    return state
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

  private async trackedDockerProbe(containerId: string, args: string[], historyHelper = false,
    historyDiagnostic?: ExactRuntimeHandle & { provider: string; helperName: string }): Promise<string> {
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
        ...(historyHelper ? { env: { ...process.env, DOCKER_HOST: `unix://${this.runtime.broker.proxySocketPath}`, DOCKER_API_VERSION: '1.47' } } : {}),
      }, (error, stdout, stderr) => {
        this.providerProbes.delete(probeId)
        const nativeHistoryDiagnostic = error && args.includes('native-history-import')
          ? readNativeHistoryDiagnostic(error.code, stdout, stderr) : undefined
        try {
          if (historyDiagnostic) this.runtime.writeArtifact(`native-history-probe-${probeId}.json`, {
            ...historyDiagnostic, runtimeImage: this.runtime.imageRef, probeId, containerId, operation: args[0],
            helperId: args[0] === 'create' ? stdout.trim() : args[0] === 'rm' ? null : args[1],
            code: error?.code ?? 0, signal: error?.signal ?? null, killed: error?.killed ?? false, stdout, stderr,
            stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
          })
          this.runtime.recordLifecycle('external.provider_probe_settled', { severity: error ? 'warn' : 'info',
            probeId, containerId, code: error?.code ?? 0, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
            ...(nativeHistoryDiagnostic ? { nativeHistoryDiagnostic } : {}) })
        } catch (evidenceError) {
          reject(new Error('owned provider probe settlement evidence failed', { cause: evidenceError }))
          return
        }
        if (nativeHistoryDiagnostic) reject(new NativeHistoryProbeFailure(nativeHistoryDiagnostic))
        else if (error) reject(new Error('owned provider probe failed or timed out', { cause: error }))
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
  async publishTerminalContinuityReceipt(handle: RuntimeEnclosureHandle, input: RuntimeTerminalContinuityObservation): Promise<{ artifactRef: string }> {
    if (this.runtime.phase !== 2) throw new Error('Phase 2 terminal continuity fixture required')
    await this.currentRuntimeEnclosure(handle)
    const observation = RuntimeTerminalContinuityObservationSchema.parse(input)
    if (observation.soulId !== handle.soulId || observation.incarnationId !== handle.incarnationId
      || observation.containerId !== handle.containerId || observation.hostBootId !== handle.hostBootId) {
      throw new Error('continuity observation belongs to another identity')
    }
    if (observation.caseId === 'P2-G04') {
      await this.assertOpenCodeContinuityEnclosure(handle)
      await this.assertCurrentHandle({ ...handle, nativeSessionId: observation.nativeSessionId })
    }
    const receipt = { ...observation, candidateSha: this.runtime.candidateSha, runtimeImage: this.runtime.imageRef }
    const target = observation.caseId === 'P2-G01' ? this.writeBrowserReceipt(receipt) : this.writeOpencodeReceipt(receipt)
    const artifactRef = `terminal-continuity-receipt:${createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`
    this.runtime.recordLifecycle('external.terminal_continuity_receipt_published', { severity: 'info', artifactRef, caseId: observation.caseId })
    return { artifactRef }
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

  async publishProviderQualification(input: ProviderQualificationRow[]): Promise<RuntimeProviderReceiptArtifacts> {
    const rows = z.array(RuntimeProviderObservationSchema).parse(input)
    const providers = new Set(rows.map(row => row.provider))
    if (this.runtime.phase !== 5 || this.fixtureFreshAgentModes.length !== 0 || providers.size !== rows.length
      || providers.size === 0 || providers.size !== this.enabledProviders.length
      || this.enabledProviders.some(provider => !providers.has(provider))) throw new Error('exact registered managed providers required')
    if (!this.stopSettlement) throw new Error('owned cleanup must settle before provider receipt publication')
    const cleanup = await this.stopSettlement
    if (!cleanup.ok || cleanup.errors.length > 0) throw new Error('owned cleanup failed before provider receipt publication')
    const finalized = this.finalizeProviderQualificationReceipt(rows)
    const artifactRefs = finalized.paths.map(target => {
      fs.chmodSync(target, 0o600)
      return `provider-qualification:${createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`
    })
    const result = RuntimeProviderReceiptArtifactsSchema.parse({ schemaVersion: finalized.receipt.schemaVersion,
      rowCount: finalized.receipt.providers.length, artifactRefs })
    process.stdout.write(`${JSON.stringify({ severity: 'info', event: 'external.provider_receipt_published',
      runId: this.runtime.runId, candidateSha: this.runtime.candidateSha, ...result })}\n`)
    return result
  }

  async validateFreshAgentIngressInventory(): Promise<void> {
    const { validateFreshAgentIngressInventory } = await import('./fresh-agent-ingress-inventory.js')
    validateFreshAgentIngressInventory(this.repoRoot)
  }

  async publishFreshAgentQualification(input: FreshAgentQualificationRow[]): Promise<RuntimeFreshAgentReceiptArtifacts> {
    const rows = z.array(RuntimeFreshAgentObservationSchema).parse(input)
    const modes = new Set(rows.map(row => row.mode))
    if (this.runtime.phase !== 5 || this.fixtureFreshAgentModes.length !== 0 || modes.size !== rows.length
      || modes.size === 0 || modes.size !== this.freshAgentModes.length
      || this.freshAgentModes.some(mode => !rows.some(row => row.mode === mode))) throw new Error('exact registered production fresh-agent modes required')
    if (this.nativeCaptureFailures.length || [...this.freshNativeCollections.values()].some(value => !value.closed || value.failed)) throw new Error('native original collection is incomplete')
    if (!this.stopSettlement) throw new Error('owned cleanup must settle before fresh-agent receipt publication')
    const cleanup = await this.stopSettlement
    if (!cleanup.ok || cleanup.errors.length > 0) throw new Error('owned cleanup failed before fresh-agent receipt publication')
    const finalized = this.finalizeFreshAgentQualificationReceipt(rows)
    const artifactRefs = finalized.paths.map(target => {
      fs.chmodSync(target, 0o600)
      return `fresh-agent-qualification:${createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`
    })
    const result = RuntimeFreshAgentReceiptArtifactsSchema.parse({ rowCount: finalized.receipt.rows.length, artifactRefs })
    process.stdout.write(`${JSON.stringify({ severity: 'info', event: 'external.fresh_agent_receipt_published',
      runId: this.runtime.runId, candidateSha: this.runtime.candidateSha, ...result })}\n`)
    return result
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

  async publishPhase4BrowserReceipt(input: Phase4BrowserObservation): Promise<{ artifactRef: string }> {
    if (this.runtime.phase !== 4) throw new Error('Phase 4 browser fixture required')
    const browser = Phase4BrowserObservationSchema.parse(input)
    const target = this.writePhase4BrowserReceipt({ schemaVersion: 1, status: 'PASS', candidateSha: this.runtime.candidateSha, browser })
    const sha256 = createHash('sha256').update(fs.readFileSync(target)).digest('hex')
    const artifactRef = `phase4-browser:${sha256}`
    this.runtime.recordLifecycle('external.phase4_browser_receipt', { severity: 'info', artifactRef, artifactPath: target, sha256 })
    return { artifactRef }
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
    const features = this.fixtureFreshAgentModes.length > 0
      ? 'managed-fresh-agent-fixtures'
      : qualification.length ? 'managed-provider-qualification' : 'managed-runtime-v1'
    const prepared = features === 'managed-runtime-v1' ? undefined
      : preparedRuntimeBinary(this.repoRoot, `server-${features}`)
    const sourceState = `${git(this.repoRoot, ['rev-parse', 'HEAD']).trim()}:${git(this.repoRoot, ['status', '--porcelain']).trim() ? 'dirty' : 'clean'}`
    const target = path.join(this.runtime.buildDir, 'freshell-server-managed')
    if (prepared) {
      fs.copyFileSync(prepared, target)
      fs.chmodSync(target, 0o755)
      return target
    }
    runtimeCargoBuildAndCopy(this.repoRoot, mise, [
      'exec', 'rust@1.96', '--', 'cargo', 'build', '--release', '-p', 'freshell-server',
      '--features', features,
    ], [{ source: cargoArtifactPath(this.repoRoot, 'release', 'freshell-server'), target }],
    { ...process.env, FRESHELL_BUILD_SOURCE_STATE: sourceState })
    return target
  }

  private buildQualificationSupervisor(): string | undefined {
    if (this.pendingQualificationProviders().length === 0) return undefined
    const mise = path.join(os.homedir(), '.local', 'bin', 'mise')
    const target = path.join(this.runtime.buildDir, 'freshell-supervisor-qualification')
    const prepared = preparedRuntimeBinary(this.repoRoot, 'supervisor-qualification')
    if (prepared) {
      fs.copyFileSync(prepared, target)
      fs.chmodSync(target, 0o755)
      return target
    }
    runtimeCargoBuildAndCopy(this.repoRoot, mise, [
      'exec', 'rust@1.96', '--', 'cargo', 'build', '--release', '-p', 'freshell-supervisor',
      '--features', 'provider-qualification',
    ], [{ source: cargoArtifactPath(this.repoRoot, 'release', 'freshell-supervisor'), target }])
    return target
  }

  private pendingQualificationProviders(): QualifiableTerminalProvider[] {
    if (this.enabledProviders.length === 0) return []
    const manifest = loadCapabilityManifest(this.repoRoot)
    const pending = new Set(deferredProviders(manifest).filter(provider =>
      manifest.providers.find(row => row.provider === provider)?.qualificationReady === true))
    return this.enabledProviders.filter(
      (provider): provider is QualifiableTerminalProvider => (
        pending.has(provider)
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
