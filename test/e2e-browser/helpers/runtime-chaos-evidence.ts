import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { ManagedRuntimeBrowserRig, ManagedRuntimeView } from './managed-runtime.js'
import { OPENCODE_NATIVE_HISTORY_SCRIPT, type NativeHistory } from './opencode-native-history.js'

const OPENCODE_TOOL_EVIDENCE_SCRIPT = String.raw`
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

export type ChaosRuntimeObservation = {
  soulId: string
  incarnationId: string
  containerId: string
  hostBootId: string
  nativeSessionId: string
  providerPid: number
  providerLaunchCount: number
  activeWriters: number
  unsafeBrokerAttempts: number
  limits: { cpuMax: string; memoryMax: string; swapMax: string; pidsMax: string }
}

export type NativeToolEvidence = {
  requestIds: string[]
  resultIds: string[]
  replayCount: number
}

export type StructuredChaosLog = {
  source: 'server' | 'browser'
  sequence: number
  monotonicMs: number
  level: string
  event: string
  contentSha256: string
  contentBytes: number
  redacted: true
}

export async function captureChaosRuntimeObservation(
  rig: ManagedRuntimeBrowserRig,
  expected: Pick<ManagedRuntimeView, 'soulId' | 'incarnationId' | 'containerId' | 'hostBootId' | 'nativeSessionId'>,
): Promise<ChaosRuntimeObservation> {
  if (!expected.containerId || !expected.hostBootId || !expected.nativeSessionId) {
    throw new Error('chaos observation lacks an exact initial runtime identity')
  }
  const snapshot = await rig.inventorySnapshot()
  const rows = (snapshot.souls as ManagedRuntimeView[]).filter((row) => (
    row.soulId === expected.soulId && row.launchState === 'running'
  ))
  if (rows.length !== 1) throw new Error(`chaos expected exactly one running incarnation, observed ${rows.length}`)
  const row = rows[0]
  const claim = await rig.qualificationWriterClaim({
    provider: 'opencode',
    nativeSessionId: expected.nativeSessionId,
    soulId: expected.soulId,
    incarnationId: expected.incarnationId,
  })
  if (claim.activeClaimCount !== 1 || claim.globalConflictingClaimCount !== 0) {
    throw new Error('chaos writer claim is not uniquely owned')
  }
  const statePath = path.join(rig.runtime.runtimeDir(rig.supervisor, expected.incarnationId), 'host-state.json')
  const hostState = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  const limits = JSON.parse(rig.ownedContainerExec(expected.containerId, [
    'sh', '-lc',
    `printf '{"cpuMax":"%s","memoryMax":"%s","swapMax":"%s","pidsMax":"%s"}' "$(cat /sys/fs/cgroup/cpu.max)" "$(cat /sys/fs/cgroup/memory.max)" "$(cat /sys/fs/cgroup/memory.swap.max)" "$(cat /sys/fs/cgroup/pids.max)"`,
  ]))
  return {
    soulId: row.soulId,
    incarnationId: row.incarnationId,
    containerId: row.containerId ?? '',
    hostBootId: row.hostBootId ?? '',
    nativeSessionId: row.nativeSessionId ?? '',
    providerPid: Number(hostState.workerPid),
    providerLaunchCount: Number(hostState.workerLaunchCount),
    activeWriters: claim.activeClaimCount,
    unsafeBrokerAttempts: rig.runtime.broker.unsafeAttempts().length,
    limits,
  }
}

export function nativeToolEvidence(
  rig: ManagedRuntimeBrowserRig,
  containerId: string,
  nativeSessionId: string,
  marker: string,
): NativeToolEvidence {
  return JSON.parse(rig.ownedProviderExec(containerId, [
    'node', '--no-warnings', '-e', OPENCODE_TOOL_EVIDENCE_SCRIPT,
    '/home/freshell/provider/.local/share/opencode/opencode.db', nativeSessionId, marker,
  ]))
}

export function nativeFollowUpMessageIds(
  rig: ManagedRuntimeBrowserRig,
  containerId: string,
  nativeSessionId: string,
  marker: string,
): string[] {
  const result = JSON.parse(rig.ownedProviderExec(containerId, [
    'node', '--no-warnings', '-e', OPENCODE_NATIVE_HISTORY_SCRIPT,
    '/home/freshell/provider/.local/share/opencode/opencode.db', nativeSessionId,
  ])) as NativeHistory
  if (result.provider !== 'opencode' || result.nativeSessionId !== nativeSessionId) {
    throw new Error('native follow-up probe returned a conflicting OpenCode identity')
  }
  return result.turns
    .filter((turn) => turn.text.includes(marker))
    .map((turn) => turn.messageId)
    .filter((messageId): messageId is string => typeof messageId === 'string' && messageId.length > 0)
}

export function structuredChaosLog(
  source: 'server' | 'browser',
  sequence: number,
  monotonicMs: number,
  level: string,
  event: string,
  transientContent: string,
): StructuredChaosLog {
  return {
    source,
    sequence,
    monotonicMs,
    level,
    event,
    contentSha256: createHash('sha256').update(transientContent).digest('hex'),
    contentBytes: Buffer.byteLength(transientContent),
    redacted: true,
  }
}

export function writePrivateJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
}

export function writePrivateJsonl(filePath: string, rows: readonly StructuredChaosLog[]): void {
  if (rows.length === 0) throw new Error('refusing to persist an empty chaos log')
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, { mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
}
