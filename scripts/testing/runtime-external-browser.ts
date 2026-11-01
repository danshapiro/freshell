import { BROWSER_ORIGINAL_FILES, TABS_CASE_TITLES, type BrowserOriginalIndex } from './runtime-campaign-policy.js'
import {
  QUALIFICATION_PROVIDER_SELECTION_ENV, parseQualificationProviderSelection,
  type QualifiableTerminalProvider,
} from './provider-qualification-selection.js'
import {
  FRESH_AGENT_QUALIFICATION_MODES_ENV, parseFreshAgentQualificationModes,
  type QualifiableFreshAgentMode,
} from './fresh-agent-qualification-selection.js'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { FreshBrowserIngressObservation } from './fresh-agent-qualification-receipt.js'
import { nativeRecoveryValidationDiagnostic } from './qualification-observations.js'
import { FreshBrowserChallengeResultSchema, RuntimeFreshAgentObservationSchema, type FreshBrowserChallengeResult } from './runtime-sandbox.js'
import type { RuntimeWebConstructOptions, RuntimeWebFactory, RuntimeWebHandle, RuntimeWebInfo } from './runtime-sandbox.js'
import type { SyntheticStoppedRepairBatchFacts, SyntheticStoppedRepairBatchObservation, SyntheticStoppedRepairFault } from './runtime-sandbox.js'
import { RuntimeOwnerOperationQueue, ManagedRuntimeOwner, RuntimeHarness, dockerSocketPath, stripRuntimeWebEnvironment,
  SyntheticStoppedRepairBatchFactsSchema, SyntheticStoppedRepairBatchObservationSchema,
  ManagedMigrationFactsSchema, ManagedStopResultSchema, ManagedStopCompletionFactsSchema, SyntheticOpenCodeSourceFactsSchema,
  SyntheticOpenCodeHistoryFactsSchema, ManagedOpenCodeAdoptionStatusSchema, Phase3BrowserObservationSchema, Phase4BrowserObservationSchema,
  FreshCodexSavedHistoryPreservationSchema, FreshCodexSavedHistoryMeasurementSchema, FreshCodexControllerReattachmentSchema, FreshCodexHistoryMeasurementFinishSchema, FreshCodexHistoryMeasurementStartSchema, FreshCodexSavedHistoryOwnershipFactsSchema, FreshCodexControllerStartupFactsSchema, FreshCodexRetainedSnapshotFactsSchema, FreshAgentLaunchFactsSchema, FreshNativeCollectionResultSchema, OwnedContainerStateSchema, RuntimeHostProcessStateSchema, RuntimeHandleMismatchFieldsSchema, RuntimeWebProcessFactsSchema,
  RuntimeChaosWebOutputFactsSchema, RuntimeSupervisorProcessFactsSchema, RuntimeCandidateIntegritySchema,
  InterruptedOrdinaryStopFactsSchema, InterruptedOrdinaryStopCrashFactsSchema,
  RuntimeChaosLogArtifactsSchema, RuntimeChaosEvidenceArtifactsSchema, RuntimeChaosReceiptArtifactSchema,
  OpencodeLossCredentialEvidenceSchema, OpencodeLossAbsenceEvidenceSchema, OpencodeLossRecoverySchema,
  OpencodeLossIncidentEvidenceSchema, RuntimeLossAssertionsArtifactSchema, RuntimeLossReceiptArtifactSchema,
  RuntimeProviderReceiptArtifactsSchema, RuntimeFreshAgentReceiptArtifactsSchema, RuntimeOwnershipFactsSchema, RuntimeTerminalChildFactsSchema,
  OpencodeContinuityStartupFactsSchema, OpencodeContinuityFirstReplySchema, RuntimeTerminalContinuityObservationSchema,
  OpencodeQualificationStartupFactsSchema, ManagedTerminalStartupFactsSchema, RuntimeProviderNativeTurnProofsSchema,
  OpencodeReplacementReadinessSchema,
  OpencodeReadinessConfirmationSchema,
  OpencodeReadinessDiagnosticSchema,
  OpencodeQualificationTurnSchema,
  requireOpenCodeOnecliBootstrap, EXCLUDED_SOURCE_SENTINELS } from './runtime-sandbox.js'
import { createRuntimeEnclosureHandle, type RuntimeEnclosureHandle } from './runtime-sandbox.js'
import type { Reporter, TestCase, TestResult, TestStep, FullResult } from '@playwright/test/reporter'
import { z } from 'zod'
import type { Page, Request, Response as BrowserResponse } from '@playwright/test'
import { SessionDirectoryPageSchema } from '../../shared/read-models.js'
import { ManagedRuntimeInventorySnapshotSchema, type ManagedRuntimeInventorySnapshot } from '../../shared/managed-runtime.js'
import type { RuntimeWriterClaimFacts, ManagedMigrationFacts, ManagedStopResult, ManagedStopCompletionFacts } from './runtime-sandbox.js'
import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { ErrorCode, WS_PROTOCOL_VERSION } from '../../shared/ws-protocol.js'
import type { ExactRuntimeHandle, ManagedRuntimeView, ManagedOpenCodeAdoptionStatus, FixtureNativeState, RuntimeHostFacts, RuntimeOwnerOperationRequest } from './runtime-sandbox.js'
import type { InterruptedOrdinaryStopFacts, InterruptedOrdinaryStopCrashFacts } from './runtime-sandbox.js'
import type { NativeChallengeKind, NativeToolEvidence, SyntheticOpenCodeChallenge, SyntheticOpenCodeSourceFacts, SyntheticOpenCodeHistoryFacts } from './runtime-sandbox.js'
import type { FreshCodexSavedHistoryPreservation, FreshCodexSavedHistoryMeasurement, FreshCodexControllerReattachment, FreshCodexHistoryMeasurementFinish, FreshCodexHistoryMeasurementStart, FreshCodexSavedHistoryOwnershipFacts, RuntimeHostProcessState, FreshCodexControllerStartupFacts, FreshCodexRetainedSnapshotFacts, Phase4BrowserObservation, Phase3BrowserObservation, FreshAgentLaunchFacts, FreshNativeCollectionResult, OwnedContainerState, RuntimeWebProcessFacts, RuntimeChaosWebOutputFacts, RuntimeSupervisorProcessFacts, RuntimeCandidateIntegrity } from './runtime-sandbox.js'
import type { RuntimeChaosLogs, RuntimeChaosLogArtifacts, RuntimeChaosEvidence, RuntimeChaosEvidenceArtifacts, RuntimeChaosReceiptArtifact } from './runtime-sandbox.js'
import type { OpencodeLossCredentialEvidence, OpencodeLossAbsenceEvidence, OpencodeLossRecovery, OpencodeLossIncidentEvidence } from './runtime-sandbox.js'
import type { RuntimeLossAssertions, RuntimeLossAssertionsArtifact, RuntimeLossReceiptArtifact } from './runtime-sandbox.js'
import type { RuntimeFreshAgentReceiptArtifacts, RuntimeOwnershipFacts, RuntimeTerminalChildFacts } from './runtime-sandbox.js'
import type { OpencodeContinuityStartupFacts } from './runtime-sandbox.js'
import type { ProviderQualificationRow } from './provider-qualification-receipt.js'
import type { ManagedTerminalStartupFacts } from './runtime-sandbox.js'
import type { RuntimeProviderReceiptArtifacts } from './runtime-sandbox.js'
import type { FreshAgentQualificationRow } from './fresh-agent-qualification-receipt.js'
import { RetainedFixtureBrowserSession, runTask2RetainedFixture, Task2RetainedBrowserStageSchema,
  type Task2RetainedBrowserStage } from './task002-retained-fixture.js'
import { requireAmplifierOnecliBootstrap, readAmplifierQualificationProfile, stageAmplifierQualificationProfile } from './runtime-amplifier-onecli.js'
import { ownedClaudeStartupPreferences } from './runtime-native-feasibility.js'
import { defaultReceiptFileName } from './runtime-receipts.js'

type OwnedProcessIdentity = { pid: number; startTicks: string; executable: string; cwd: string }
type OwnedProcessScope = { children: OwnedProcessIdentity[]; groupPresent: boolean }

/** Serialized by Playwright into the owned page after its matching allocation. */
export function observeOwnedFreshBrowserPane(input: {
  tabId: string; paneId: string; createRequestId: string
  sessionType: string; provider: string; createdSessionId: string; nativeSessionId: string
}): { paneId: string; sessionId: string } | null {
  const state = (globalThis as any).window?.__FRESHELL_TEST_HARNESS__?.getState()
  const find = (node: any): any => node?.type === 'leaf' ? node.id === input.paneId ? node : null
    : node?.children?.map(find).find(Boolean) ?? null
  const leaf = find(state?.panes?.layouts?.[input.tabId]), content = leaf?.content
  if (content?.kind !== 'fresh-agent' || content.createRequestId !== input.createRequestId
    || content.sessionType !== input.sessionType || content.provider !== input.provider) return null
  // Materialization changes conversation identity, never the picker route.
  // The second allowed ID comes only from this request's exact allocation.
  if (!content.sessionId || ![input.createdSessionId, input.nativeSessionId].includes(content.sessionId)) return null
  if (content.sessionRef && (content.sessionRef.provider !== input.provider || content.sessionRef.sessionId !== content.sessionId)) return null
  return { paneId: leaf.id, sessionId: content.sessionId }
}

/** Serialized by Playwright into the owned page; uses only its existing harness. */
export function stageOwnedFreshBrowserProfile(profile: { mode: string; model: string; effort: string }): { tabId: string; paneId: string; createRequestId: string } | null {
  const harness = (globalThis as any).window?.__FRESHELL_TEST_HARNESS__
  if (!harness?.isAllFreshAgentNetworkEffectsSuppressed()) throw new Error('fresh create effects must be suppressed while staging the selected profile')
  const state = harness.getState(), tabId = state.tabs.activeTabId, activeId = state.panes.activePane[tabId]
  const find = (node: any): any => node?.type === 'leaf' ? node.id === activeId ? node : null : node?.children?.map(find).find(Boolean)
  const leaf = find(state.panes.layouts[tabId])
  if (leaf?.content.kind !== 'fresh-agent' || leaf.content.sessionType !== profile.mode) return null
  if (leaf.content.sessionId) throw new Error('profile must be staged before any native create')
  const content = { ...leaf.content, model: profile.model, modelSelection: { kind: 'exact', modelId: profile.model },
    effort: profile.effort === 'provider-default' ? undefined : profile.effort, permissionMode: 'default' }
  harness.setSuppressAllFreshAgentNetworkEffects(false)
  harness.dispatch({ type: 'panes/updatePaneContent', payload: { tabId, paneId: leaf.id, content } })
  return { tabId, paneId: leaf.id, createRequestId: content.createRequestId }
}

function processIdentity(pid: number): OwnedProcessIdentity | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    if (!/^[0-9]+$/.test(fields[19])) throw new Error('owned process start identity is unreadable')
    return {
      pid, startTicks: fields[19], executable: fs.readlinkSync(`/proc/${pid}/exe`),
      cwd: fs.readlinkSync(`/proc/${pid}/cwd`),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return null
    throw error
  }
}

function sameProcess(expected: OwnedProcessIdentity, current: OwnedProcessIdentity): boolean {
  return expected.pid === current.pid && expected.startTicks === current.startTicks
    && expected.executable === current.executable && expected.cwd === current.cwd
}

function ownedPidPresent(expected: OwnedProcessIdentity): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${expected.pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === expected.startTicks
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

function processGroupPresent(pid: number): boolean {
  try {
    // Signal zero only probes existence; termination still verifies each PID.
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

function processDescendants(parent: OwnedProcessIdentity): OwnedProcessIdentity[] {
  const rows: Array<{ pid: number; parent: number }> = []
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(entry)) continue
    try {
      const text = fs.readFileSync(`/proc/${entry}/stat`, 'utf8')
      rows.push({ pid: Number(entry), parent: Number(text.slice(text.lastIndexOf(')') + 2).split(' ')[1]) })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  const owned = new Set([parent.pid])
  let grew = true
  while (grew) {
    grew = false
    for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); grew = true }
  }
  return [...owned].filter((pid) => pid !== parent.pid).flatMap((pid) => {
    const identity = processIdentity(pid)
    return identity ? [identity] : []
  })
}

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))
const OWNED_CHILD_MARKER = 'FRESHELL_RUNTIME_CHILD_OWNER'

/** Owner-side process primitive. No executable, argv or PID enters the remote API. */
export class OwnedRuntimeChild {
  readonly child: ChildProcess
  private recordedIdentity?: OwnedProcessIdentity
  private readonly ownerMarker = randomUUID()
  private readonly retainedChildren = new Map<number, OwnedProcessIdentity>()
  private cleanupSettled = false
  private stdout = ''
  private stderr = ''
  private exited = false
  private readonly exit: Promise<void>

  private constructor(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    const canonical = fs.realpathSync(executable)
    this.child = spawn(canonical, args, { cwd, env: { ...env, [OWNED_CHILD_MARKER]: this.ownerMarker },
      detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.exit = new Promise((resolve) => {
      const finish = () => { this.exited = true; resolve() }
      this.child.once('exit', finish)
      this.child.once('error', finish)
    })
    this.child.stdout?.on('data', (chunk: Buffer) => { this.stdout = (this.stdout + chunk.toString()).slice(-1024 * 1024) })
    this.child.stderr?.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-1024 * 1024) })
  }

  static async create(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<OwnedRuntimeChild> {
    const process = new OwnedRuntimeChild(executable, args, cwd, env)
    const deadline = Date.now() + 2000
    while (process.alive() && Date.now() < deadline) {
      const identity = process.child.pid ? processIdentity(process.child.pid) : null
      if (identity && identity.cwd === fs.realpathSync(cwd) && identity.executable === fs.realpathSync(executable)) {
        process.recordedIdentity = identity
        return process
      }
      await delay(10)
    }
    // Before a verified executable handshake, only this exact spawn handle is
    // signal authority. Wait for it to settle before reporting startup failure.
    if (process.alive()) process.child.kill('SIGTERM')
    await Promise.race([process.exit, delay(2000)])
    if (process.alive()) process.child.kill('SIGKILL')
    await Promise.race([process.exit, delay(2000)])
    if (process.alive()) throw new Error('owned process spawn failed and cleanup did not settle')
    throw new Error('owned process did not establish its exact executable/cwd/start identity')
  }

  get identity(): OwnedProcessIdentity {
    if (!this.recordedIdentity) throw new Error('owned process identity handshake is incomplete')
    return this.recordedIdentity
  }

  output(): { stdout: string; stderr: string } { return { stdout: this.stdout, stderr: this.stderr } }
  alive(): boolean { return !this.exited }
  async wait(): Promise<number> {
    await this.exit
    if (typeof this.child.exitCode !== 'number') throw new Error('owned child did not exit with a numeric status')
    return this.child.exitCode
  }
  descendants(): OwnedProcessIdentity[] {
    return this.ownedScope().children
  }

  private ownedScope(): OwnedProcessScope {
    if (this.cleanupSettled) return { children: [], groupPresent: false }
    const current = processIdentity(this.identity.pid)
    if (current && !sameProcess(this.identity, current)) throw new Error('owned process identity was replaced')
    // detached:true creates a dedicated session/group. Its members remain in
    // that group after reparenting, even if the launcher has already exited.
    // The inherited marker distinguishes this launch if the numeric group ID
    // is later reused. Never terminate a group with an unchecked negative-PID signal.
    const group: OwnedProcessIdentity[] = []
    let groupPresent = false
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^[0-9]+$/.test(entry)) continue
      const pid = Number(entry)
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        if (Number(fields[2]) !== this.identity.pid || Number(fields[3]) !== this.identity.pid) continue
        groupPresent = true
        const member = processIdentity(pid)
        if (!member) continue // Exited (including a zombie awaiting reaping).
        const marker = `${OWNED_CHILD_MARKER}=${this.ownerMarker}`
        if (!fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(marker)) {
          throw new Error('owned process group identity was replaced')
        }
        if (pid !== this.identity.pid) group.push(member)
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
    }
    // Keep the existing live-tree coverage for children that create their own
    // groups, and retain exact identities when a cleanup attempt is interrupted.
    for (const [pid, retained] of this.retainedChildren) {
      const current = processIdentity(pid)
      if (current?.startTicks === retained.startTicks) this.retainedChildren.set(pid, current)
      else if (!ownedPidPresent(retained)) this.retainedChildren.delete(pid)
    }
    for (const child of [...group, ...(current ? processDescendants(this.identity) : [])]) {
      const retained = this.retainedChildren.get(child.pid)
      if (retained && retained.startTicks !== child.startTicks) throw new Error('owned child PID was replaced')
      this.retainedChildren.set(child.pid, child)
    }
    return { children: [...this.retainedChildren.values()].filter(ownedPidPresent), groupPresent }
  }

  private absenceVerified({ children, groupPresent }: OwnedProcessScope): boolean {
    if (groupPresent || ownedPidPresent(this.identity) || children.length) return false
    // A /proc enumeration can miss a child forked while its parent exits.
    // Retire the scope only when the kernel confirms current group absence.
    return !processGroupPresent(this.identity.pid)
  }

  private signal(identity: OwnedProcessIdentity, signal: NodeJS.Signals): void {
    const current = processIdentity(identity.pid)
    if (!current) return
    if (!sameProcess(identity, current)) throw new Error('refused to signal a replaced owned PID')
    try { process.kill(identity.pid, signal) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }

  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    if (this.cleanupSettled) return
    this.descendants()
    this.signal(this.identity, signal)
    await Promise.race([this.exit, delay(5000)])
    if (ownedPidPresent(this.identity)) {
      this.signal(this.identity, 'SIGKILL')
      await Promise.race([this.exit, delay(5000)])
    }
    for (const childSignal of ['SIGTERM', 'SIGKILL'] as const) {
      const signalled = new Set<string>()
      const deadline = Date.now() + 5000
      do {
        const scope = this.ownedScope()
        if (this.absenceVerified(scope)) {
          // Retire the numeric scope permanently once absence is established.
          this.cleanupSettled = true
          return
        }
        for (const child of scope.children) {
          const key = `${child.pid}:${child.startTicks}`
          if (!signalled.has(key)) { this.signal(child, childSignal); signalled.add(key) }
        }
        await delay(50)
      } while (Date.now() < deadline)
    }
    if (!this.absenceVerified(this.ownedScope())) throw new Error('owned process cleanup could not verify absence')
    this.cleanupSettled = true
  }
}

async function freeOwnerPort(): Promise<number> {
  const listener = net.createServer()
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', resolve)
  })
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('owned port reservation failed')
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))
  return address.port
}

class ManagedWebProvenanceError extends Error {
  constructor(readonly fields: Record<string, string | boolean>) {
    super('owned managed web provenance differs from the exact artifact candidate and cleanliness')
  }
}

export function validateManagedWebProvenance(observed: unknown, candidateSha: string, buildDirty: boolean): void {
  const body = observed && typeof observed === 'object' && !Array.isArray(observed)
    ? observed as Record<string, unknown> : undefined
  const reason = !body || typeof body.buildDirty !== 'boolean' ? 'unreadable_provenance'
    : body.runtime !== 'rust' ? 'runtime_mismatch' : body.commit !== candidateSha ? 'candidate_mismatch'
      : body.buildDirty !== buildDirty ? 'cleanliness_mismatch' : undefined
  if (!reason) return
  const safeCommit = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : 'unknown'
  throw new ManagedWebProvenanceError({ reason, expectedCommit: safeCommit(candidateSha), observedCommit: safeCommit(body?.commit),
    expectedBuildDirty: buildDirty, ...(typeof body?.buildDirty === 'boolean' ? { observedBuildDirty: body.buildDirty } : {}) })
}

export type OwnedWebDiagnosticRecord = {
  pid: number; homeReference: string; bootAttemptCount: number; ignoredLineCount: number
  logReadState: 'missing' | 'read'; logFiles: { name: string; bytes: number; sha256: string }[]
  privateLogArtifact?: string
  facts: { severity: string; event: string; fields: Record<string, string | number | boolean> }[]
}

const SAFE_PROVIDER_START_DIAGNOSTICS = new Set([
  'authentication', 'arguments', 'listener', 'configuration', 'network', 'unclassified', 'no-diagnostic', 'none',
])

function ownedWebDiagnosticFacts(output: { stdout: string; stderr: string }, nativeLog?: { text: string; pid: number }): Pick<OwnedWebDiagnosticRecord, 'facts' | 'ignoredLineCount'> {
  const facts: OwnedWebDiagnosticRecord['facts'] = []
  let ignoredLineCount = 0
  const lines = [
    ...`${output.stdout}\n${output.stderr}`.split('\n').map(line => ({ line, native: false })),
    ...(nativeLog?.text ?? '').split('\n').map(line => ({ line, native: true })),
  ].filter(value => value.line.trim())
  for (const { line, native } of lines) {
    let body: unknown
    try { body = JSON.parse(line) } catch { ignoredLineCount++; continue }
    const parsed = z.object({ level: z.enum(['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR']),
      fields: z.record(z.string(), z.unknown()).optional() }).passthrough().safeParse(body)
    if (!parsed.success) { ignoredLineCount++; continue }
    const values = { ...parsed.data, ...parsed.data.fields }
    if (native && values.server_pid !== nativeLog?.pid) { ignoredLineCount++; continue }
    const event = values.event ?? values.msg ?? values.message
    if (typeof event !== 'string' || !/^(?:fresh_agent|freshagent|managed_runtime|runtime|server)\.[A-Za-z0-9_.]+$/.test(event)) {
      ignoredLineCount++; continue
    }
    const fields: Record<string, string | number | boolean> = {}
    for (const key of ['code', 'runtime_code', 'runtime_error_code', 'soul_id', 'incarnation_id', 'terminal_id',
      'session_id', 'request_id', 'provider', 'session_type', 'outcome', 'reason', 'evidence_revision',
      'identity_revision', 'control_epoch', 'execution_generation', 'native_session_id', 'host_boot_id',
      'provider_start_diagnostic']) {
      const value = values[key]
      if (key === 'provider_start_diagnostic') {
        if (typeof value === 'string' && SAFE_PROVIDER_START_DIAGNOSTICS.has(value)) fields[key] = value
        continue
      }
      if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
        || (typeof value === 'string' && /^[A-Za-z0-9_.:()/-]{1,256}$/.test(value))) fields[key] = value
    }
    facts.push({ severity: parsed.data.level.toLowerCase(), event, fields })
  }
  return { facts, ignoredLineCount }
}

/** The runtime owner supplies the artifact; this class never builds or locates a foreign server. */
export class ManagedRuntimeWebServer implements RuntimeWebHandle {
  private readonly token: string
  private process?: OwnedRuntimeChild
  private current?: RuntimeWebInfo
  private homeDir?: string
  private bootCount = 0
  private homeConfigured = false
  private lastOutput = { stdout: '', stderr: '' }
  private logsDir?: string
  private admissionFailure?: OwnedWebDiagnosticRecord['facts'][number]

  constructor(private readonly options: RuntimeWebConstructOptions,
    private readonly diagnostics?: (record: OwnedWebDiagnosticRecord) => void | Promise<void>) {
    this.token = options.token ?? randomUUID()
  }

  get info(): RuntimeWebInfo {
    if (!this.current) throw new Error('owned managed web is not started')
    return this.current
  }
  capturedOutput(): { stdout: string; stderr: string } { return this.process?.output() ?? this.lastOutput }
  processEvidence(): { pid: number; bootAttemptCount: number } {
    return { pid: this.info.pid, bootAttemptCount: this.bootCount }
  }
  ownedChildPids(): number[] { return this.process?.descendants().map((child) => child.pid) ?? [] }

  async start(): Promise<RuntimeWebInfo> {
    if (this.process?.alive()) throw new Error('owned managed web is already started')
    this.homeDir ??= this.options.homeDir ?? await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-managed-web-'))
    return this.boot(await freeOwnerPort())
  }

  private async boot(port: number): Promise<RuntimeWebInfo> {
    this.admissionFailure = undefined
    const token = this.token
    const home = this.homeDir!
    const configDir = path.join(home, '.freshell')
    if (!this.homeConfigured) {
      await this.options.setupHome(home)
      await fsp.mkdir(configDir, { recursive: true })
      const configFile = path.join(configDir, 'config.json')
      const config = JSON.parse(await fsp.readFile(configFile, 'utf8'))
      config.settings ??= {}
      config.settings.network = { configured: true, host: '127.0.0.1', ...config.settings.network }
      await fsp.writeFile(configFile, JSON.stringify(config), { mode: 0o600 })
      this.homeConfigured = true
    }
    const logsDir = path.join(configDir, 'logs')
    this.logsDir = logsDir
    await fsp.mkdir(logsDir, { recursive: true })
    const env: NodeJS.ProcessEnv = {
      ...process.env, ...this.options.env, PORT: String(port), NODE_ENV: 'production', AUTH_TOKEN: token,
      HIDE_STARTUP_TOKEN: 'true', FRESHELL_LOG_DIR: logsDir,
      FRESHELL_CLIENT_DIR: path.join(this.options.repoRoot, 'dist/client'),
      FRESHELL_HOME: home, HOME: home, CLAUDE_HOME: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
      XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CONFIG_HOME: path.join(home, '.config'),
      LOCALAPPDATA: path.join(home, 'AppData/Local'), APPDATA: path.join(home, 'AppData/Roaming'),
    }
    stripRuntimeWebEnvironment(env, this.options)
    delete env.VITE_PORT
    this.process = await OwnedRuntimeChild.create(this.options.binary, [], this.options.repoRoot, env)
    this.bootCount += 1
    const baseUrl = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 60_000
    try {
      let ready = false
      while (Date.now() < deadline) {
        if (!this.process.alive()) throw new Error('owned managed web exited before readiness')
        let response: Response
        try {
          response = await fetch(`${baseUrl}/api/server-info`, {
            headers: { 'x-auth-token': token }, signal: AbortSignal.timeout(2000),
          })
        } catch { await delay(100); continue }
        if (response.ok) {
          validateManagedWebProvenance(await response.json(), this.options.candidateSha, this.options.buildDirty)
          ready = true
          break
        }
        await delay(100)
      }
      if (!ready) throw new Error('owned managed web authenticated readiness timed out')
      this.current = {
        port, token, baseUrl, wsUrl: `ws://127.0.0.1:${port}/ws`, homeDir: home, configDir: home,
        logsDir, debugLogPath: path.join(logsDir, `freshell-server.rust.${port}.log`),
        pid: this.process.identity.pid, runtimeRoot: this.options.repoRoot,
      }
      return this.current
    } catch (error) {
      if (error instanceof ManagedWebProvenanceError) {
        this.admissionFailure = { severity: 'error', event: 'managed_runtime.web_admission_refused', fields: error.fields }
      }
      await this.process.stop()
      throw error
    }
  }

  async restart(): Promise<RuntimeWebInfo> {
    const { port } = this.info
    await this.kill('SIGTERM')
    return this.boot(port)
  }
  async restartAbrupt(): Promise<RuntimeWebInfo> {
    const { port } = this.info
    await this.kill('SIGKILL')
    return this.boot(port)
  }
  async kill(signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
    if (this.process) {
      await this.process.stop(signal)
      this.lastOutput = this.process.output()
      const log = await this.readOwnedRustLogs()
      if (!this.homeDir) throw new Error('owned web HOME reference is unavailable')
      const outputFacts = ownedWebDiagnosticFacts(this.lastOutput, { text: log.text, pid: this.process.identity.pid })
      if (this.admissionFailure) outputFacts.facts.push(this.admissionFailure)
      let privateLogArtifact: string | undefined
      if (log.files.length && this.options.writeDiagnosticArtifact) {
        try {
          privateLogArtifact = this.options.writeDiagnosticArtifact(`owned-web-${this.process.identity.pid}-boot-${this.bootCount}.json`, {
            pid: this.process.identity.pid, bootAttemptCount: this.bootCount, logFiles: log.files, content: log.text,
          })
        } catch (error) {
          const errno = (error as NodeJS.ErrnoException)?.code
          const fields = { code: typeof errno === 'string' && /^[A-Z0-9_]{1,64}$/.test(errno) ? errno : 'UNKNOWN' }
          const failure = { severity: 'warn', event: 'managed_runtime.web_diagnostics_retention_failed', fields }
          outputFacts.facts.push(failure)
          process.stderr.write(`${JSON.stringify(failure)}\n`)
        }
      }
      await this.diagnostics?.({ pid: this.process.identity.pid, bootAttemptCount: this.bootCount,
        homeReference: this.homeDir,
        logReadState: log.files.length ? 'read' : 'missing', logFiles: log.files,
        ...(privateLogArtifact ? { privateLogArtifact } : {}),
        ...outputFacts })
    }
    this.process = undefined
  }
  private async readOwnedRustLogs(): Promise<{ text: string; files: OwnedWebDiagnosticRecord['logFiles'] }> {
    if (!this.logsDir) return { text: '', files: [] }
    const names = (await fsp.readdir(this.logsDir)).filter(name => /^rust-server\.jsonl(?:\.[1-9][0-9]*)?$/.test(name)).sort()
    const files: OwnedWebDiagnosticRecord['logFiles'] = []
    const chunks: string[] = []
    for (const name of names) {
      const target = path.join(this.logsDir, name)
      const stat = await fsp.lstat(target)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error('owned Rust log is not a bounded regular file')
      const bytes = await fsp.readFile(target)
      files.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
      chunks.push(bytes.toString('utf8'))
    }
    return { text: chunks.join('\n'), files }
  }
  async stop(): Promise<void> {
    await this.kill('SIGTERM')
    this.current = undefined
    if (this.homeDir && !this.options.homeDir && !this.options.preserveHomeOnStop) {
      await fsp.rm(this.homeDir, { recursive: true, force: true })
      this.homeDir = undefined
      this.homeConfigured = false
    }
  }
}

const PINNED_CLOUDFLARED_SHA256 = 'd33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db'

export function resolveOwnedTunnelBinary(configured: string | undefined, searchPath = process.env.PATH ?? ''): string {
  if (configured !== undefined) return fs.realpathSync(configured)
  for (const directory of searchPath.split(path.delimiter)) {
    const candidate = path.resolve(directory || '.', 'cloudflared')
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate)
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
  throw new Error('owned tunnel requires the pinned cloudflared executable on PATH or FRESHELL_RUNTIME_CLOUDFLARED_BINARY')
}

// A diagnostic write must not replace an operation result or interrupt cleanup.
function emitExternalDiagnostic(site: 'relay' | 'client' | 'retained' | 'tunnel', emit: () => void): void {
  try { emit() } catch {
    try {
      // Use the stderr descriptor so a fallback error stays inside this catch.
      fs.writeSync(2, `${JSON.stringify({ severity: 'warn', event: 'managed_external_diagnostic_write_failed', site })}\n`)
    } catch {
      // Both sinks may be unavailable; the original response/cleanup still settles.
    }
  }
}

// Error messages and arbitrary error codes can contain credentials or bodies.
function safeExternalFailure(error: unknown): { errorClass: string; errorCode: string } {
  const errorClass = error instanceof TypeError ? 'TypeError' : error instanceof SyntaxError ? 'SyntaxError'
    : error instanceof RangeError ? 'RangeError' : error instanceof AggregateError ? 'AggregateError'
      : error instanceof Error ? 'Error' : 'unknown'
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  const errorCode = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ABORT_ERR']
    .find(allowed => allowed === code) ?? 'unknown'
  return { errorClass, errorCode }
}

function retainedStageDiagnostic(stage: unknown): { kind: string; sequence: number; phase?: string } | undefined {
  const parsed = z.object({ kind: z.enum(['preparing', 'failed', 'finished', 'observe', 'retry']),
    sequence: z.number().int().nonnegative(),
    phase: z.enum(['store_blocked', 'config_blocked', 'replaced', 'config_fault', 'repaired']).optional(),
  }).safeParse(stage)
  return parsed.success ? parsed.data : undefined
}

const OWNED_RELAY_SERVER = 'freshell-managed-runtime-relay'
const OWNED_RELAY_REQUEST_HEADER = 'x-freshell-relay-request-id'

export function parseOwnedTunnelOrigin(output: string): string | null {
  const origins = new Set(output.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b/g) ?? [])
  if (origins.size > 1) throw new Error('owned tunnel published different generated origins')
  return [...origins][0] ?? null
}

export class OwnedManagedRuntimeTunnel {
  private process?: OwnedRuntimeChild
  private home?: string
  private origin?: string

  constructor(private readonly repoRoot: string, private readonly binary = process.env.FRESHELL_RUNTIME_CLOUDFLARED_BINARY,
    private readonly diagnostics?: (record: Record<string, string | number>) => void) {}

  get baseUrl(): string {
    if (!this.origin) throw new Error('owned tunnel has not published its origin')
    return this.origin
  }
  get wsUrl(): string { return `${this.baseUrl.replace(/^https:/, 'wss:')}/ws` }
  processEvidence(): OwnedProcessIdentity {
    if (!this.process) throw new Error('owned tunnel process is unavailable')
    return { ...this.process.identity }
  }
  assertAlive(): void {
    if (!this.process?.alive()) throw new Error('owned tunnel exited during the browser job')
    const current = processIdentity(this.process.identity.pid)
    if (!current || !sameProcess(this.process.identity, current)) throw new Error('owned tunnel process identity changed')
  }
  async start(relayUrl: string): Promise<void> {
    if (this.process || this.home) throw new Error('owned tunnel already started')
    const relay = new URL(relayUrl)
    if (relay.protocol !== 'http:' || relay.hostname !== '127.0.0.1' || !relay.port || relay.pathname !== '/' || relay.search || relay.hash) {
      throw new Error('owned tunnel requires the exact loopback relay address')
    }
    const binary = resolveOwnedTunnelBinary(this.binary)
    const digest = createHash('sha256').update(await fsp.readFile(binary)).digest('hex')
    if (digest !== PINNED_CLOUDFLARED_SHA256) throw new Error('owned tunnel executable differs from the pinned artifact')
    const version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim()
    if (!/^cloudflared version 2026\.10\.0(?:\s|$)/.test(version)) throw new Error('owned tunnel executable version differs from its pin')
    this.home = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-owned-tunnel-'))
    await fsp.chmod(this.home, 0o700)
    try {
      this.process = await OwnedRuntimeChild.create(binary, [
        'tunnel', '--no-autoupdate', '--url', relayUrl, '--protocol', 'http2',
      ], this.repoRoot, { PATH: process.env.PATH, HOME: this.home, XDG_CONFIG_HOME: this.home })
      const deadline = Date.now() + 90_000
      while (Date.now() < deadline) {
        this.assertAlive()
        const { stdout, stderr } = this.process.output()
        const origin = parseOwnedTunnelOrigin(`${stdout}\n${stderr}`)
        if (origin) { this.origin = origin; return }
        await delay(100)
      }
      throw new Error('owned tunnel origin readiness timed out')
    } catch (error) {
      try { await this.stop() } catch (cleanup) { throw new AggregateError([error, cleanup], 'owned tunnel startup and cleanup failed') }
      throw error
    }
  }
  async stop(): Promise<void> {
    const owned = this.process
    if (owned) {
      try { await owned.stop() } finally {
        const { stdout, stderr } = owned.output()
        const counts = { originUnreachable: 0, connectionRefused: 0, edgeConnectionClosed: 0, timeout: 0, otherErrorLines: 0 }
        for (const line of `${stdout}\n${stderr}`.split('\n')) {
          if (!/\bERR\b/.test(line)) continue
          if (line.includes('Unable to reach the origin service')) counts.originUnreachable++
          else if (line.includes('connection refused')) counts.connectionRefused++
          else if (line.includes('connection with edge closed')) counts.edgeConnectionClosed++
          else if (line.includes('timeout') || line.includes('deadline exceeded')) counts.timeout++
          else counts.otherErrorLines++
        }
        emitExternalDiagnostic('tunnel', () => this.diagnostics?.({ severity: 'info', pid: owned.identity.pid,
          startTicks: owned.identity.startTicks, ...counts }))
      }
    }
    this.process = undefined
    if (this.home) await fsp.rm(this.home, { recursive: true })
    this.home = undefined
    this.origin = undefined
  }
}

export class OwnedManagedRuntimeRelay {
  private server?: http.Server
  private address?: string
  private acceptedOrigin?: string
  private readonly sockets = new Set<import('node:stream').Duplex>()
  private authRefusals = 0
  private originRefusals = 0
  private lastOwnerRefusalStatus: number | null = null

  constructor(private readonly options: {
    token: string; backend: () => string; control: (request: unknown) => Promise<unknown>
    retryResponse?: (observed: { soulId: string; requestId: string; response: unknown }) => void
    diagnostics?: { runId: string; candidateSha: string; recordLifecycle: (event: string, data: unknown) => void }
  }) {}

  get localUrl(): string {
    if (!this.address) throw new Error('owned relay is not started')
    return this.address
  }
  setOrigin(origin: string): void {
    const url = new URL(origin)
    if (url.protocol !== 'https:' || url.origin !== origin || (this.acceptedOrigin && this.acceptedOrigin !== origin)) {
      throw new Error('owned relay origin cannot change')
    }
    this.acceptedOrigin = origin
  }
  refusalFacts(): { authRefusals: number; originRefusals: number; lastOwnerRefusalStatus: number | null } {
    return { authRefusals: this.authRefusals, originRefusals: this.originRefusals, lastOwnerRefusalStatus: this.lastOwnerRefusalStatus }
  }

  private admission(request: IncomingMessage): number | null {
    if (request.headers.origin && request.headers.origin !== this.acceptedOrigin) {
      this.originRefusals += 1
      this.lastOwnerRefusalStatus = 403
      return 403
    }
    const url = new URL(request.url ?? '/', 'http://owned-relay')
    const token = request.headers['x-auth-token'] ?? request.headers.authorization?.replace(/^Bearer /, '') ?? url.searchParams.get('token')
    if (url.pathname === '/ws') {
      // Browser websocket authentication happens in the Rust hello frame.
      // The browser's exact admitted Origin and the server's hello validation
      // are retained; Node clients supply the token in their upgrade headers.
      if ((this.acceptedOrigin && request.headers.origin === this.acceptedOrigin) || token === this.options.token) return null
    } else if (!url.pathname.startsWith('/api/') && url.pathname !== '/__managed_runtime') {
      return null
    } else if (url.pathname === '/api/health' || token === this.options.token) return null
    this.authRefusals += 1
    this.lastOwnerRefusalStatus = 401
    return 401
  }

  private admittedPath(pathname: string): boolean {
    return pathname === '/' || pathname === '/index.html' || pathname === '/favicon.ico'
      || pathname === '/__managed_runtime' || pathname === '/ws'
      || ['/assets/', '/icons/', '/fonts/'].some((prefix) => pathname.startsWith(prefix))
      || pathname.startsWith('/api/')
  }

  private proxyHeaders(request: IncomingMessage, target: URL): http.OutgoingHttpHeaders {
    const headers = { ...request.headers, host: target.host }
    if (headers.origin) headers.origin = target.origin
    return headers
  }

  private async readOwnerRequest(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of request) {
      length += Buffer.byteLength(chunk)
      // Closed diagnostic DTOs include bounded CPU stacks and snapshot audit records.
      if (length > 2 * 1024 * 1024) throw new Error('owned request exceeds its bound')
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  private async handle(request: IncomingMessage, response: ServerResponse, diagnostic: {
    diagnosticId?: string; phase: string; operationId?: string; action?: string; stage?: ReturnType<typeof retainedStageDiagnostic>
  }): Promise<void> {
    const refusal = this.admission(request)
    if (refusal) { response.writeHead(refusal); response.end(); return }
    const pathname = new URL(request.url ?? '/', 'http://owned-relay').pathname
    if (!this.admittedPath(pathname)) { response.writeHead(404); response.end(); return }
    if (pathname === '/__managed_runtime') {
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
      diagnostic.diagnosticId = randomUUID()
      diagnostic.phase = 'body_read'
      response.setHeader('server', OWNED_RELAY_SERVER)
      response.setHeader(OWNED_RELAY_REQUEST_HEADER, diagnostic.diagnosticId)
      const record = (event: string, severity: string, extra: Record<string, unknown> = {}) => emitExternalDiagnostic('relay', () => this.options.diagnostics?.recordLifecycle(event, {
        severity, runId: this.options.diagnostics.runId, candidateSha: this.options.diagnostics.candidateSha, ...diagnostic, ...extra,
      }))
      record('external.relay_owner_received', 'info')
      response.once('finish', () => record('external.relay_owner_completed', response.statusCode >= 500 ? 'error' : 'info', { status: response.statusCode }))
      const body = await this.readOwnerRequest(request)
      let result: unknown
      diagnostic.phase = 'control'
      try {
        const input: unknown = JSON.parse(body.toString('utf8'))
        // This only extracts safe correlation fields; control retains full admission.
        const metadata = z.object({ runId: z.literal(this.options.diagnostics?.runId),
          candidateSha: z.literal(this.options.diagnostics?.candidateSha), operationId: z.string().uuid(),
          action: z.enum(['retained-start', 'retained-status', 'retained-observed', 'retained-finish', 'finish', 'abort']),
        }).safeParse(input)
        if (metadata.success) { diagnostic.operationId = metadata.data.operationId; diagnostic.action = metadata.data.action }
        result = await this.options.control(input)
      }
      catch {
        response.writeHead(409, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ reason: 'owner_operation_refused' }))
        return
      }
      if (diagnostic.action === 'retained-status' && result && typeof result === 'object' && 'result' in result) {
        diagnostic.stage = retainedStageDiagnostic(result.result)
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      diagnostic.phase = 'response_serialize'
      const serialized = JSON.stringify(result)
      diagnostic.phase = 'response_send'
      response.end(serialized)
      return
    }
    const retryPath = request.method === 'POST' && this.options.retryResponse
      ? /^\/api\/runtime\/souls\/([^/]+)\/retry$/.exec(pathname) : null
    let retryBody: Buffer | undefined
    let requestId: string | undefined
    if (retryPath) {
      retryBody = await this.readOwnerRequest(request)
      const parsed = z.object({ requestId: z.string().min(1) }).passthrough().safeParse(JSON.parse(retryBody.toString('utf8')))
      if (!parsed.success) throw new Error('owned Retry request lacks its exact request ID')
      requestId = parsed.data.requestId
    }
    const target = new URL(this.options.backend())
    await new Promise<void>((resolve, reject) => {
      const upstream = http.request(target, {
        method: request.method, path: request.url, headers: this.proxyHeaders(request, target),
      }, (result) => {
        response.writeHead(result.statusCode ?? 502, result.headers)
        result.once('error', reject)
        if (retryPath && requestId && result.statusCode === 200) {
          const chunks: Buffer[] = []
          let length = 0
          result.on('data', (chunk: Buffer) => {
            length += chunk.length
            if (length > 1024 * 1024) result.destroy(new Error('owned Retry response exceeds its bound'))
            else chunks.push(chunk)
          })
          result.once('end', () => {
            try {
              this.options.retryResponse!({ soulId: decodeURIComponent(retryPath[1]), requestId,
                response: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
              resolve()
            } catch { reject(new Error('owned Retry response observation failed')) }
          })
        } else result.once('end', resolve)
        result.pipe(response)
      })
      upstream.once('error', reject)
      if (retryBody) upstream.end(retryBody)
      else request.pipe(upstream)
    })
  }

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => {
      const diagnostic: Parameters<OwnedManagedRuntimeRelay['handle']>[2] = { phase: 'admission' }
      this.handle(request, response, diagnostic).catch(error => {
        if (diagnostic.diagnosticId) emitExternalDiagnostic('relay', () => this.options.diagnostics?.recordLifecycle('external.relay_owner_failed', {
          severity: 'error', runId: this.options.diagnostics.runId, candidateSha: this.options.diagnostics.candidateSha,
          ...diagnostic, status: response.headersSent ? response.statusCode : 502, ...safeExternalFailure(error),
        }))
        if (!response.headersSent) response.writeHead(502)
        response.end()
      })
    })
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    this.server.on('upgrade', (request, socket, head) => {
      const refusal = this.admission(request)
      if (refusal || new URL(request.url ?? '/', 'http://owned-relay').pathname !== '/ws') {
        socket.end(`HTTP/1.1 ${refusal ?? 404} Refused\r\nConnection: close\r\n\r\n`)
        return
      }
      const target = new URL(this.options.backend())
      const upstream = http.request(target, {
        method: 'GET', path: '/ws', headers: this.proxyHeaders(request, target),
      })
      upstream.once('error', () => socket.destroy())
      upstream.once('response', (response) => {
        socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Refused\r\nConnection: close\r\n\r\n`)
        response.resume()
      })
      upstream.once('upgrade', (response, backend, backendHead) => {
        this.sockets.add(backend)
        backend.once('close', () => this.sockets.delete(backend))
        socket.write(`HTTP/1.1 ${response.statusCode} Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${String(value)}`).join('\r\n')}\r\n\r\n`)
        if (head.length) backend.write(head)
        if (backendHead.length) socket.write(backendHead)
        backend.on('error', () => socket.destroy())
        socket.on('error', () => backend.destroy())
        backend.pipe(socket)
        socket.pipe(backend)
      })
      upstream.end()
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', resolve)
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('owned relay did not bind its loopback address')
    this.address = `http://127.0.0.1:${address.port}`
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    if (this.server) await new Promise<void>((resolve, reject) => this.server!.close((error) => error ? reject(error) : resolve()))
    this.server = undefined
    this.address = undefined
  }
}

/** Closed transport metadata shared by the owner runner and browser selection. */
export const EXTERNAL_MANAGED_SPEC_NAMES = [
  'runtime-provider-resurrection-rust.spec.ts',
  'runtime-managed-provider-qualification-rust.spec.ts',
  'runtime-fresh-agent-qualification-rust.spec.ts',
  'runtime-terminal-continuity-rust.spec.ts',
  'runtime-lost-soul-notice-rust.spec.ts',
  'runtime-opencode-provider-qualification-rust.spec.ts',
  'runtime-tabs-rehydrate-rust.spec.ts',
  'runtime-chaos-rust.spec.ts',
  'runtime-fresh-agent-fixture-rust.spec.ts',
  'runtime-external-target-smoke-rust.spec.ts',
] as const

export const EXTERNAL_DESCRIPTOR_KEYS = [
  'FRESHELL_E2E_TARGET_URL', 'FRESHELL_E2E_TARGET_WS_URL', 'FRESHELL_E2E_TARGET_TOKEN',
  'FRESHELL_RUNTIME_EXTERNAL_RUN_ID', 'FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA',
] as const

export const EXTERNAL_SELECTION_KEYS = [
  'FRESHELL_RUNTIME_SYNTHETIC_RESUME', 'FRESHELL_RUNTIME_FRESH_AGENT_FIXTURE_TEST',
  'FRESHELL_RUNTIME_SYNTHETIC_RESUME_FOLLOWUP',
  'FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE',
  'FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_PROVIDERS',
  'FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_LIVE',
  'FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_MODES',
  'FRESHELL_RUNTIME_PHASE3_LIVE', 'FRESHELL_RUNTIME_PHASE5_LIVE',
  'FRESHELL_RUNTIME_OPENCODE_QUALIFICATION_LIVE', 'FRESHELL_RUNTIME_PHASE5_CHAOS_LIVE',
] as const

export type ManagedExternalDescriptor = {
  baseUrl: string; wsUrl: string; token: string; runId: string; candidateSha: string
}

export type ManagedBrowserConnectionInfo = Pick<RuntimeWebInfo, 'baseUrl' | 'wsUrl' | 'token'>
export type ExternalOwnerFetch = (url: string, init: RequestInit) => Promise<Response>

const ExternalRuntimeViewSchema: z.ZodType<ManagedRuntimeView> = z.object({
  soulId: z.string().min(1), incarnationId: z.string().min(1), launchState: z.string().min(1),
  intentRevision: z.number().int().nonnegative(),
  containerId: z.string().regex(/^[a-f0-9]{64}$/).optional(), hostBootId: z.string().min(1).optional(),
  nativeSessionId: z.string().min(1).optional(), terminalId: z.string().optional(),
  freshAgentSessionId: z.string().optional(), freshAgentSessionType: z.string().optional(),
  provider: z.string().optional(),
}).passthrough()
const ExternalCleanupSchema = z.object({ ok: z.boolean(), errors: z.array(z.string()) }).strict()
const CompletedOwnerOperationSchema = z.object({ completed: z.literal(true) }).strict()
const OPENCODE_ONECLI_REFERENCE_KEYS = [
  'FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE',
  'FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE',
  'FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE',
] as const
const ExternalOwnerRegistrationSchema = z.object({ phase: z.number().int().min(2).max(5),
  enabledProviders: z.array(z.string().min(1)), freshAgentModes: z.array(z.string().min(1)),
  fixtureFreshAgentModes: z.array(z.string().min(1)) }).strict()
export type ExternalOwnerRegistration = z.infer<typeof ExternalOwnerRegistrationSchema>

/** A Cloud browser has typed fixture operations and no local runtime/process authority. */
export class ExternalManagedRuntimeRig {
  private workspace?: string
  private stopSettlement?: Promise<{ ok: boolean; errors: string[] }>
  constructor(private readonly descriptor: ManagedExternalDescriptor, private readonly transport: ExternalOwnerFetch = fetch,
    private readonly expectedRegistration?: ExternalOwnerRegistration) {}
  get repoRoot(): string {
    if (!this.workspace) throw new Error('external owner description is not loaded')
    return this.workspace
  }
  get info(): ManagedBrowserConnectionInfo {
    return { baseUrl: this.descriptor.baseUrl, wsUrl: this.descriptor.wsUrl, token: this.descriptor.token }
  }
  private infoSchema(): z.ZodType<ManagedBrowserConnectionInfo> {
    return z.object({ baseUrl: z.literal(this.descriptor.baseUrl), wsUrl: z.literal(this.descriptor.wsUrl), token: z.literal(this.descriptor.token) }).strict()
  }
  private async rpc<T>(
    action: RuntimeOwnerOperationRequest['action'], schema: z.ZodType<T>,
    params: Pick<RuntimeOwnerOperationRequest, 'handle' | 'enclosure' | 'challengeId' | 'incidentId' | 'expectedControlEpoch' | 'expectedIntentRevision' | 'generation' | 'phase3Browser' | 'phase4Browser' | 'historyMeasurementStart' | 'historyMeasurementFinish' | 'historyControllerReattachment' | 'historyMeasurement' | 'historyPreservation' | 'chaosLogs' | 'chaosEvidence' | 'lossAssertions' | 'freshAgentObservations' | 'providerObservations' | 'continuityObservation' | 'qualificationTerminalId' | 'qualificationNonce' | 'terminalQualificationNonce' | 'qualificationProofStage' | 'priorMessageIds' | 'otherChallengeId' | 'qualificationReadiness' | 'qualificationDiagnostic' | 'interruptedStopRetainedTurns' | 'fixtureId' | 'repairOperationId' | 'stoppedRepairFault' | 'nativeCollectionId' | 'nativeCollectionNonce' | 'freshBrowserIngress' | 'freshBrowserRequest' | 'freshBrowserReply' | 'freshApprovalAllowed' | 'freshApprovalRecovery'> = {},
  ): Promise<T> {
    const operationId = randomUUID()
    const request = {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-auth-token': this.descriptor.token },
      body: JSON.stringify({ runId: this.descriptor.runId, candidateSha: this.descriptor.candidateSha,
        scenarioId: 'browser-managed-runtime', operationId, action, ...params }),
    }
    let response: Response | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      response = undefined
      try {
        response = await this.transport(`${this.descriptor.baseUrl}/__managed_runtime`, {
          ...request, signal: AbortSignal.timeout(90_000),
        })
      } catch {
        if (attempt === 1) throw new Error(`closed owner ${action} transport did not settle`)
      }
      if (response?.ok) break
      if (response) {
        const status = response.status
        const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
        const server = response.headers.get('server')?.trim().toLowerCase()
        const ray = response.headers.get('cf-ray'), relayRequest = response.headers.get(OWNED_RELAY_REQUEST_HEADER)
        emitExternalDiagnostic('client', () => process.stderr.write(`${JSON.stringify({ severity: 'error', event: 'managed_external_owner_http_failed',
          runId: this.descriptor.runId, candidateSha: this.descriptor.candidateSha, operationId, action, status,
          server: server === OWNED_RELAY_SERVER ? 'owned_relay' : server === 'cloudflare' ? 'cloudflare' : 'unknown',
          contentType: !contentType ? 'absent' : contentType === 'application/json' ? 'json'
            : contentType === 'text/html' ? 'html' : contentType === 'text/plain' ? 'text' : 'other',
          cloudflareRay: ray && /^[a-f0-9]{16}-[A-Z]{3}$/.test(ray) ? ray : null,
          relayRequestId: relayRequest && z.string().uuid().safeParse(relayRequest).success ? relayRequest : null,
        })}\n`))
        // Only the read-only status poll may share the existing transport retry for this upstream response.
        const upstreamStatusFailure = action === 'retained-status' && status === 502
          && server === 'cloudflare' && contentType === 'text/html' && relayRequest === null
        if (!upstreamStatusFailure || attempt === 1) throw new Error(`closed owner operation refused: ${status}`)
      }
      emitExternalDiagnostic('client', () => process.stderr.write(`${JSON.stringify({ severity: 'warn', event: 'managed_external_owner_transport_retry',
        runId: this.descriptor.runId, candidateSha: this.descriptor.candidateSha, operationId, action })}\n`))
    }
    if (!response) throw new Error('closed owner transport produced no response')
    let body: unknown
    try { body = await response.json() } catch { throw new Error('closed owner reply is not valid JSON') }
    const reply = z.object({ runId: z.literal(this.descriptor.runId), candidateSha: z.literal(this.descriptor.candidateSha),
      operationId: z.literal(operationId), result: z.unknown() }).strict().safeParse(body)
    if (!reply.success) throw new Error('closed owner reply has invalid run, candidate, operation or shape')
    const result = schema.safeParse(reply.data.result)
    if (!result.success) throw new Error(`closed owner ${action} reply result is missing or invalid`)
    return result.data
  }
  async start(): Promise<ManagedBrowserConnectionInfo> {
    const description = await this.rpc('describe', z.object({ workspaceCwd: z.string().min(1), info: this.infoSchema(),
      registration: ExternalOwnerRegistrationSchema }).strict()).catch(() => { throw new Error('external registered owner description is missing or invalid') })
    const expected = this.expectedRegistration
    if (expected && (description.registration.phase !== expected.phase
      || (['enabledProviders', 'freshAgentModes', 'fixtureFreshAgentModes'] as const).some(key => {
        const actual = description.registration[key]
        return actual.length !== expected[key].length || actual.some(value => !expected[key].includes(value))
      }))) throw new Error('external owner registration differs from the requested fixture')
    this.workspace = description.workspaceCwd
    return description.info
  }
  async inventory(): Promise<ManagedRuntimeView[]> { return this.rpc('inventory', z.array(ExternalRuntimeViewSchema)) }
  async prepareSyntheticOpenCodeSource(): Promise<SyntheticOpenCodeSourceFacts> {
    return this.syntheticOpenCodeSourceFacts()
  }
  async syntheticOpenCodeSourceFacts(): Promise<SyntheticOpenCodeSourceFacts> {
    return this.rpc('synthetic-source-facts', SyntheticOpenCodeSourceFactsSchema)
  }
  async prepareSyntheticStoppedRepairBatch(): Promise<SyntheticStoppedRepairBatchFacts> {
    return this.syntheticStoppedRepairBatchFacts()
  }
  async syntheticStoppedRepairBatchFacts(): Promise<SyntheticStoppedRepairBatchFacts> {
    return this.rpc('synthetic-stopped-repair-facts', SyntheticStoppedRepairBatchFactsSchema)
  }
  async syntheticStoppedRepairBatchObservation(fixtureId: string, operationId: string): Promise<SyntheticStoppedRepairBatchObservation> {
    const observed = await this.rpc('synthetic-stopped-repair-observation', SyntheticStoppedRepairBatchObservationSchema,
      { fixtureId, repairOperationId: operationId })
    if (observed.fixtureId !== fixtureId || observed.operationId !== operationId) {
      throw new Error('batch observation belongs to another fixture or repair operation')
    }
    return observed
  }
  async setSyntheticStoppedRepairFault(fixtureId: string, preset: SyntheticStoppedRepairFault): Promise<{ controlEpoch: number | null }> {
    return this.rpc('synthetic-stopped-repair-fault', z.object({ controlEpoch: z.number().int().nonnegative().nullable() }).strict(),
      { fixtureId, stoppedRepairFault: preset })
  }
  async syntheticOpenCodeHistoryFacts(handle: ExactRuntimeHandle): Promise<SyntheticOpenCodeHistoryFacts> {
    return this.rpc('synthetic-source-history', SyntheticOpenCodeHistoryFactsSchema, { handle })
  }
  async syntheticOpenCodeExcludedSentinels(handle: ExactRuntimeHandle): Promise<string[]> {
    return this.rpc('synthetic-source-exclusions', z.array(z.enum(EXCLUDED_SOURCE_SENTINELS)), { handle })
  }
  async syntheticOpenCodeAdoptionStatus(handle: ExactRuntimeHandle): Promise<ManagedOpenCodeAdoptionStatus> {
    return this.rpc('synthetic-source-adoption', ManagedOpenCodeAdoptionStatusSchema.refine(status => status.state !== 'observed'
      || (status.data.observation.rootSessionId === handle.nativeSessionId
        && status.data.observation.incarnationId === handle.incarnationId), 'source adoption differs from the exact address'), { handle })
  }
  async syntheticOpenCodeFollowUpMessageId(handle: ExactRuntimeHandle): Promise<string | null> {
    return this.rpc('synthetic-source-follow-up', z.string().min(1).nullable(), { handle })
  }
  async inventorySnapshot(): Promise<ManagedRuntimeInventorySnapshot> {
    return this.rpc('inventory-snapshot', ManagedRuntimeInventorySnapshotSchema)
  }
  async controlEpoch(): Promise<number> { return this.rpc('control-epoch', z.number().int().nonnegative()) }
  async applyManagedOptIn(expectedControlEpoch: number): Promise<ManagedMigrationFacts> {
    return this.rpc('managed-opt-in', ManagedMigrationFactsSchema, { expectedControlEpoch })
  }
  async writerClaimFacts(handle: ExactRuntimeHandle): Promise<RuntimeWriterClaimFacts> {
    return this.rpc('writer-claim', z.object({ provider: z.string().min(1), providerStoreId: z.string().min(1),
      nativeSessionId: z.literal(handle.nativeSessionId), soulId: z.literal(handle.soulId), incarnationId: z.literal(handle.incarnationId),
      activeClaimCount: z.number().int().nonnegative(), globalConflictingClaimCount: z.number().int().nonnegative() }).strict(), { handle })
  }
  async stopRuntimeSoul(handle: ExactRuntimeHandle, expectedControlEpoch: number, expectedIntentRevision: number): Promise<ManagedStopResult> {
    return this.rpc('stop-soul', ManagedStopResultSchema.refine(result => result.view.soulId === handle.soulId
      && result.view.incarnationId === handle.incarnationId, 'Stop result differs from the exact address'),
    { handle, expectedControlEpoch, expectedIntentRevision })
  }
  async stopCompletionFacts(handle: ExactRuntimeHandle, expectedIntentRevision: number,
    executionGeneration: number): Promise<ManagedStopCompletionFacts> {
    return this.rpc('stop-completion-facts', ManagedStopCompletionFactsSchema.refine(result => (
      (['soulId', 'incarnationId', 'containerId', 'hostBootId', 'nativeSessionId'] as const)
        .every(field => result[field] === handle[field])
      && result.intentRevision === expectedIntentRevision && result.executionGeneration === executionGeneration
    ), 'Stop completion differs from the captured transaction'), { handle, expectedIntentRevision, generation: executionGeneration })
  }
  async runningViewForTerminal(terminalId: string): Promise<ManagedRuntimeView | null> {
    return (await this.inventory()).find(row => row.terminalId === terminalId && row.launchState === 'running') ?? null
  }
  async runningViewForFreshSession(sessionId: string): Promise<ManagedRuntimeView | null> {
    return (await this.inventory()).find(row => row.freshAgentSessionId === sessionId && row.launchState === 'running') ?? null
  }
  exactRuntimeHandle(view: Pick<ManagedRuntimeView, 'soulId' | 'incarnationId' | 'containerId' | 'hostBootId' | 'nativeSessionId'>): ExactRuntimeHandle {
    if (!view.containerId || !/^[a-f0-9]{64}$/.test(view.containerId) || !view.hostBootId || !view.nativeSessionId) throw new Error('exact current runtime address required')
    return { runId: this.descriptor.runId, candidateSha: this.descriptor.candidateSha, soulId: view.soulId,
      incarnationId: view.incarnationId, containerId: view.containerId, hostBootId: view.hostBootId, nativeSessionId: view.nativeSessionId }
  }
  async publishFreshCodexSavedHistoryPreservation(handle: ExactRuntimeHandle, historyPreservation: FreshCodexSavedHistoryPreservation): Promise<{ artifactRef: string }> {
    return this.rpc('freshcodex-history-preservation-artifact', z.object({
      artifactRef: z.string().regex(/^owned-host-history-preservation:[a-f0-9]{64}$/),
    }).strict(), { handle, historyPreservation })
  }
  async publishFreshCodexSavedHistoryMeasurement(enclosure: RuntimeEnclosureHandle, historyMeasurement: FreshCodexSavedHistoryMeasurement): Promise<{ artifactRef: string }> {
    return this.rpc('freshcodex-history-measurement-artifact', z.object({
      artifactRef: z.string().regex(/^saved-history-render-measurement:[a-f0-9]{64}$/),
    }).strict(), { enclosure, historyMeasurement })
  }
  async recordFreshCodexControllerReattachment(handle: ExactRuntimeHandle, historyControllerReattachment: FreshCodexControllerReattachment): Promise<void> {
    await this.rpc('freshcodex-controller-reattachment', z.object({ completed: z.literal(true) }).strict(), { handle, historyControllerReattachment })
  }
  async finishFreshCodexSavedHistoryMeasurement(enclosure: RuntimeEnclosureHandle, historyMeasurementFinish: FreshCodexHistoryMeasurementFinish): Promise<void> {
    await this.rpc('freshcodex-history-measurement-finish', z.object({ completed: z.literal(true) }).strict(), { enclosure, historyMeasurementFinish })
  }
  async startFreshCodexSavedHistoryMeasurement(handle: ExactRuntimeHandle, historyMeasurementStart: FreshCodexHistoryMeasurementStart): Promise<void> {
    await this.rpc('freshcodex-history-measurement-start', z.object({ completed: z.literal(true) }).strict(), { handle, historyMeasurementStart })
  }
  async freshCodexSavedHistoryOwnershipFacts(handle: ExactRuntimeHandle): Promise<FreshCodexSavedHistoryOwnershipFacts> {
    return this.rpc('freshcodex-history-ownership', FreshCodexSavedHistoryOwnershipFactsSchema, { handle })
  }
  async freshCodexControllerStartupFacts(handle: ExactRuntimeHandle): Promise<FreshCodexControllerStartupFacts> {
    return this.rpc('freshcodex-controller-startup', FreshCodexControllerStartupFactsSchema, { handle })
  }
  async freshCodexRetainedSnapshotFacts(handle: ExactRuntimeHandle): Promise<FreshCodexRetainedSnapshotFacts> {
    return this.rpc('freshcodex-history-snapshot', FreshCodexRetainedSnapshotFactsSchema, { handle })
  }
  async prepareFreshCodexSavedHistory(handle: ExactRuntimeHandle): Promise<{ bytes: number }> {
    return this.rpc('freshcodex-history-prepare', z.object({ bytes: z.number().int().positive() }).strict(), { handle })
  }
  async prepareInterruptedOrdinaryStopHistory(handle: ExactRuntimeHandle): Promise<void> {
    await this.rpc('interrupted-stop-history', CompletedOwnerOperationSchema, { handle })
  }
  async armInterruptedOrdinaryStop(handle: ExactRuntimeHandle): Promise<void> {
    await this.rpc('interrupted-stop-arm', CompletedOwnerOperationSchema, { handle })
  }
  async installInterruptedOrdinaryStopCounters(handle: ExactRuntimeHandle): Promise<InterruptedOrdinaryStopFacts> {
    return this.rpc('interrupted-stop-counters', InterruptedOrdinaryStopFactsSchema, { handle })
  }
  async interruptedOrdinaryStopFacts(handle: ExactRuntimeHandle): Promise<InterruptedOrdinaryStopFacts> {
    return this.rpc('interrupted-stop-facts', InterruptedOrdinaryStopFactsSchema, { handle })
  }
  async interruptedOrdinaryStopCrashFacts(handle: ExactRuntimeHandle): Promise<InterruptedOrdinaryStopCrashFacts> {
    return this.rpc('interrupted-stop-crash-facts', InterruptedOrdinaryStopCrashFactsSchema, { handle })
  }
  async publishInterruptedOrdinaryStopResult(handle: ExactRuntimeHandle, interruptedStopRetainedTurns: number): Promise<{ artifactRef: string }> {
    return this.rpc('interrupted-stop-artifact', z.object({ artifactRef: z.string().regex(/^interrupted-ordinary-stop:[a-f0-9]{64}$/) }).strict(),
      { handle, interruptedStopRetainedTurns })
  }
  async freshCodexSavedHistoryUnchanged(handle: ExactRuntimeHandle): Promise<boolean> {
    return this.rpc('freshcodex-history-unchanged', z.boolean(), { handle })
  }
  async prepareCoincidentFreshCodexHistory(handle: ExactRuntimeHandle): Promise<void> {
    await this.rpc('freshcodex-coincident-prepare', z.object({ completed: z.literal(true) }).strict(), { handle })
  }
  async coincidentFreshCodexHistoryUnchanged(handle: ExactRuntimeHandle): Promise<boolean> {
    return this.rpc('freshcodex-coincident-unchanged', z.boolean(), { handle })
  }
  async fixtureNativeState(handle: ExactRuntimeHandle): Promise<FixtureNativeState> {
    return this.rpc('fixture-state', z.object({ nativeSessionId: z.literal(handle.nativeSessionId),
      pendingDecisionId: z.string().min(1).nullable(), dispatchCount: z.number().int().nonnegative(),
      completionCount: z.number().int().nonnegative() }).strict(), { handle })
  }
  async fixtureWorkerFacts(handle: ExactRuntimeHandle): Promise<{ provider: string; workerPid: number }> {
    return this.rpc('fixture-worker', z.object({ provider: z.string().min(1), workerPid: z.number().int().min(2) }).strict(), { handle })
  }
  async providerVolumeFacts(handle: ExactRuntimeHandle): Promise<{ providerVolumeName: string }> {
    return this.rpc('provider-volume', z.object({ providerVolumeName: z.string().min(1) }).strict(), { handle })
  }
  async managedProviderPendingNoticeCount(handle: ExactRuntimeHandle): Promise<number> {
    return this.rpc('managed-provider-notice-count', z.number().int().nonnegative(), { handle })
  }
  async managedTerminalStartupFacts(handle: RuntimeEnclosureHandle): Promise<ManagedTerminalStartupFacts> {
    return this.rpc('managed-terminal-startup', ManagedTerminalStartupFactsSchema, { enclosure: this.runtimeEnclosureHandle(handle) })
  }
  async managedTerminalStoppedProofs(handle: ExactRuntimeHandle, terminalQualificationNonce: string): Promise<ProviderQualificationRow['nativeTurnProofs']> {
    return this.rpc('managed-terminal-stopped-proofs', RuntimeProviderNativeTurnProofsSchema, { handle, terminalQualificationNonce })
  }
  async chaosHostFacts(handle: ExactRuntimeHandle): Promise<RuntimeHostFacts> {
    return this.rpc('host-facts', z.object({ workerPid: z.number().int().positive(), workerLaunchCount: z.number().int().nonnegative(),
      limits: z.object({ cpuMax: z.string().regex(/^(?:max|\d+) \d+$/), memoryMax: z.string().regex(/^(?:max|\d+)$/),
        swapMax: z.string().regex(/^(?:max|\d+)$/), pidsMax: z.string().regex(/^(?:max|\d+)$/) }).strict(),
      unsafeBrokerAttempts: z.number().int().nonnegative() }).strict(), { handle })
  }
  async webProcessFacts(): Promise<RuntimeWebProcessFacts> {
    return this.rpc('web-process-facts', RuntimeWebProcessFactsSchema)
  }
  async supervisorProcessFacts(): Promise<RuntimeSupervisorProcessFacts> {
    return this.rpc('supervisor-process-facts', RuntimeSupervisorProcessFactsSchema)
  }
  async captureCandidateIntegrity(): Promise<RuntimeCandidateIntegrity> {
    return this.rpc('candidate-integrity', RuntimeCandidateIntegritySchema.refine(value => value.sha === this.descriptor.candidateSha,
      'owned candidate changed'))
  }
  async chaosWebOutputFacts(handle: ExactRuntimeHandle, challengeId: string): Promise<RuntimeChaosWebOutputFacts> {
    return this.rpc('chaos-web-output', RuntimeChaosWebOutputFactsSchema, { handle, challengeId })
  }
  async chaosLongToolRunning(handle: ExactRuntimeHandle, challengeId: string): Promise<boolean> {
    return this.rpc('chaos-long-tool-running', z.boolean(), { handle, challengeId })
  }
  async publishChaosLogs(handle: ExactRuntimeHandle, chaosLogs: RuntimeChaosLogs): Promise<RuntimeChaosLogArtifacts> {
    return this.rpc('chaos-logs', RuntimeChaosLogArtifactsSchema, { handle, chaosLogs })
  }
  async publishChaosEvidence(handle: ExactRuntimeHandle, chaosEvidence: RuntimeChaosEvidence): Promise<RuntimeChaosEvidenceArtifacts> {
    return this.rpc('chaos-evidence', RuntimeChaosEvidenceArtifactsSchema, { handle, chaosEvidence })
  }
  async finalizeChaosReceipt(): Promise<RuntimeChaosReceiptArtifact> {
    return this.rpc('chaos-receipt', RuntimeChaosReceiptArtifactSchema)
  }
  async incidentMatchesSoul(handle: ExactRuntimeHandle, incidentId: string): Promise<boolean> {
    return this.rpc('incident-matches-soul', z.boolean(), { handle, incidentId })
  }
  runtimeEnclosureHandle(view: Pick<ManagedRuntimeView, 'soulId' | 'incarnationId' | 'containerId' | 'hostBootId'>): RuntimeEnclosureHandle {
    return createRuntimeEnclosureHandle(this.descriptor, view)
  }
  async resetPhase3ApprovalEffect(enclosure: RuntimeEnclosureHandle): Promise<void> {
    await this.rpc('phase3-effect-reset', CompletedOwnerOperationSchema, { enclosure })
  }
  async registerFreshNativeCollection(handle: ExactRuntimeHandle, nativeCollectionNonce: string): Promise<FreshNativeCollectionResult> {
    return this.rpc('fresh-native-register', FreshNativeCollectionResultSchema, { handle, nativeCollectionNonce })
  }
  async captureFreshNativeStage(handle: ExactRuntimeHandle, nativeCollectionId: string): Promise<FreshNativeCollectionResult> {
    return this.rpc('fresh-native-stage', FreshNativeCollectionResultSchema, { handle, nativeCollectionId })
  }
  async finishFreshNativeCollection(handle: ExactRuntimeHandle, nativeCollectionId: string): Promise<FreshNativeCollectionResult> {
    return this.rpc('fresh-native-finish', FreshNativeCollectionResultSchema, { handle, nativeCollectionId })
  }

  async observeFreshBrowserIngress(handle: ExactRuntimeHandle, nativeCollectionId: string, freshBrowserIngress: FreshBrowserIngressObservation): Promise<void> {
    await this.rpc('fresh-browser-ingress', CompletedOwnerOperationSchema, { handle, nativeCollectionId, freshBrowserIngress })
  }
  async registerFreshBrowserTurn(handle: ExactRuntimeHandle, nativeCollectionId: string): Promise<FreshBrowserChallengeResult> {
    return this.rpc('fresh-browser-turn-register', FreshBrowserChallengeResultSchema, { handle, nativeCollectionId })
  }
  async finishFreshBrowserTurn(handle: ExactRuntimeHandle, challengeId: string, freshBrowserRequest: Record<string, any>, freshBrowserReply: Record<string, any>): Promise<void> {
    await this.rpc('fresh-browser-turn-finish', CompletedOwnerOperationSchema, { handle, challengeId, freshBrowserRequest, freshBrowserReply })
  }
  async registerFreshApproval(handle: ExactRuntimeHandle, freshApprovalAllowed: boolean, freshApprovalRecovery: 'web' | 'host' | 'provider'): Promise<FreshBrowserChallengeResult> {
    return this.rpc('fresh-approval-register', FreshBrowserChallengeResultSchema, { handle, freshApprovalAllowed, freshApprovalRecovery })
  }
  async captureFreshApprovalCheckpoint(handle: ExactRuntimeHandle, challengeId: string): Promise<FreshBrowserChallengeResult> {
    return this.rpc('fresh-approval-checkpoint', FreshBrowserChallengeResultSchema, { handle, challengeId })
  }
  async finishFreshApproval(handle: ExactRuntimeHandle, challengeId: string, freshBrowserRequest: Record<string, any>): Promise<void> {
    await this.rpc('fresh-approval-finish', CompletedOwnerOperationSchema, { handle, challengeId, freshBrowserRequest })
  }
  async captureFreshBrowserRow(handle: ExactRuntimeHandle, nativeCollectionId: string): Promise<FreshAgentQualificationRow> {
    return this.rpc('fresh-browser-row', RuntimeFreshAgentObservationSchema, { handle, nativeCollectionId })
  }

  async freshAgentLaunchFacts(enclosure: RuntimeEnclosureHandle): Promise<FreshAgentLaunchFacts> {
    return this.rpc('fresh-agent-launch-facts', FreshAgentLaunchFactsSchema, { enclosure })
  }
  async validateFreshAgentIngressInventory(): Promise<void> {
    await this.rpc('fresh-agent-ingresses', CompletedOwnerOperationSchema)
  }
  async ownershipFacts(): Promise<RuntimeOwnershipFacts> {
    return this.rpc('ownership-facts', RuntimeOwnershipFactsSchema)
  }
  async terminalChildFacts(enclosure: RuntimeEnclosureHandle): Promise<RuntimeTerminalChildFacts> {
    return this.rpc('terminal-child-facts', RuntimeTerminalChildFactsSchema, { enclosure })
  }
  async terminalWebCycleCompleted(enclosure: RuntimeEnclosureHandle, challengeId: string): Promise<boolean> {
    return this.rpc('terminal-web-cycle', z.boolean(), { enclosure, challengeId })
  }
  async captureTerminalContinuityDiagnostics(enclosure: RuntimeEnclosureHandle): Promise<{ artifactRef: string }> {
    return this.rpc('terminal-continuity-diagnostics', z.object({
      artifactRef: z.string().regex(/^terminal-continuity-diagnostics:[a-f0-9]{64}$/),
    }).strict(), { enclosure })
  }
  async publishTerminalContinuityReceipt(enclosure: RuntimeEnclosureHandle,
    continuityObservation: z.infer<typeof RuntimeTerminalContinuityObservationSchema>): Promise<{ artifactRef: string }> {
    return this.rpc('terminal-continuity-receipt', z.object({
      artifactRef: z.string().regex(/^terminal-continuity-receipt:[a-f0-9]{64}$/),
    }).strict(), { enclosure, continuityObservation })
  }
  async publishProviderQualification(providerObservations: ProviderQualificationRow[]): Promise<RuntimeProviderReceiptArtifacts> {
    return this.rpc('provider-receipt', RuntimeProviderReceiptArtifactsSchema, { providerObservations })
  }
  async publishFreshAgentQualification(freshAgentObservations: FreshAgentQualificationRow[]): Promise<RuntimeFreshAgentReceiptArtifacts> {
    return this.rpc('fresh-agent-receipt', RuntimeFreshAgentReceiptArtifactsSchema, { freshAgentObservations })
  }
  async ownedRuntimeHostState(enclosure: RuntimeEnclosureHandle): Promise<RuntimeHostProcessState> {
    return this.rpc('host-process-state', RuntimeHostProcessStateSchema, { enclosure })
  }
  async ownedContainerState(enclosure: RuntimeEnclosureHandle): Promise<OwnedContainerState> {
    return this.rpc('container-state', OwnedContainerStateSchema, { enclosure })
  }
  async phase3ApprovalEffectCount(enclosure: RuntimeEnclosureHandle): Promise<number> {
    return this.rpc('phase3-effect-count', z.number().int().min(-1), { enclosure })
  }
  async publishPhase4BrowserReceipt(phase4Browser: Phase4BrowserObservation): Promise<{ artifactRef: string }> {
    return this.rpc('phase4-browser-receipt', z.object({ artifactRef: z.string().regex(/^phase4-browser:[a-f0-9]{64}$/) }).strict(),
      { phase4Browser: Phase4BrowserObservationSchema.parse(phase4Browser) })
  }
  async publishPhase3BrowserReceipt(handle: ExactRuntimeHandle, browser: Phase3BrowserObservation): Promise<{ artifactRef: string }> {
    return this.rpc('phase3-browser-receipt', z.object({ artifactRef: z.string().regex(/^phase3-browser:[a-f0-9]{64}$/) }).strict(),
      { handle, phase3Browser: Phase3BrowserObservationSchema.parse(browser) })
  }
  async openCodeVersionFacts(handle: RuntimeEnclosureHandle): Promise<{ provider: 'opencode'; version: string }> {
    return this.rpc('opencode-version', z.object({ provider: z.literal('opencode'),
      version: z.string().regex(/^\d+\.\d+\.\d+$/) }).strict(), { enclosure: this.runtimeEnclosureHandle(handle) })
  }
  async openCodeContinuityStartupFacts(enclosure: RuntimeEnclosureHandle): Promise<OpencodeContinuityStartupFacts> {
    return this.rpc('opencode-continuity-startup', OpencodeContinuityStartupFactsSchema, { enclosure })
  }
  async openCodeQualificationStartupFacts(enclosure: RuntimeEnclosureHandle): Promise<z.infer<typeof OpencodeQualificationStartupFactsSchema>> {
    return this.rpc('opencode-qualification-startup', OpencodeQualificationStartupFactsSchema, { enclosure })
  }
  async openCodeQualificationLimits(enclosure: RuntimeEnclosureHandle): Promise<z.infer<typeof OpencodeQualificationStartupFactsSchema>['limits']> {
    return this.rpc('opencode-qualification-limits', OpencodeQualificationStartupFactsSchema.shape.limits, { enclosure })
  }
  async runOpenCodeQualificationBlockers(): Promise<string[]> {
    return this.rpc('opencode-qualification-blockers', z.array(z.string().min(1)).length(3))
  }
  async openCodeReplacementReadiness(enclosure: RuntimeEnclosureHandle, qualificationTerminalId: string): Promise<z.infer<typeof OpencodeReplacementReadinessSchema>> {
    return this.rpc('opencode-replacement-readiness', OpencodeReplacementReadinessSchema, { enclosure, qualificationTerminalId })
  }
  async confirmOpenCodeReplacementReadiness(enclosure: RuntimeEnclosureHandle, qualificationReadiness: z.infer<typeof OpencodeReadinessConfirmationSchema>): Promise<void> {
    await this.rpc('opencode-readiness-confirm', CompletedOwnerOperationSchema, { enclosure, qualificationReadiness })
  }
  async publishOpenCodeReadinessDiagnostic(enclosure: RuntimeEnclosureHandle, qualificationDiagnostic: z.infer<typeof OpencodeReadinessDiagnosticSchema>): Promise<{ artifactRef: string }> {
    return this.rpc('opencode-readiness-diagnostic', z.object({
      artifactRef: z.string().regex(/^opencode-replacement-readiness:[a-f0-9]{64}$/),
    }).strict(), { enclosure, qualificationDiagnostic })
  }
  async addOpenCodeQualificationSecondView(handle: ExactRuntimeHandle, expectedIntentRevision: number, expectedControlEpoch: number): Promise<void> {
    await this.rpc('opencode-qualification-second-view', CompletedOwnerOperationSchema, { handle, expectedIntentRevision, expectedControlEpoch })
  }
  async openCodeQualificationNoticeCount(): Promise<number> {
    return this.rpc('opencode-qualification-notice-count', z.number().int().nonnegative())
  }
  async openCodeQualificationAssistantMessageIds(handle: ExactRuntimeHandle): Promise<string[]> {
    return this.rpc('opencode-qualification-message-ids', z.array(z.string().min(1)), { handle })
  }
  async registerOpenCodeQualificationNonce(handle: ExactRuntimeHandle, qualificationNonce: string): Promise<{ challengeId: string }> {
    return this.rpc('opencode-qualification-nonce', z.object({ challengeId: z.string().uuid() }).strict(), { handle, qualificationNonce })
  }
  async openCodeQualificationTurn(handle: ExactRuntimeHandle, challengeId: string,
    qualificationProofStage: z.infer<typeof OpencodeQualificationTurnSchema>['proof']['stage'],
    priorMessageIds: string[], otherChallengeId?: string): Promise<z.infer<typeof OpencodeQualificationTurnSchema> | null> {
    return this.rpc('opencode-qualification-turn', OpencodeQualificationTurnSchema.nullable(),
      { handle, challengeId, qualificationProofStage, priorMessageIds, otherChallengeId })
  }
  async openCodeContinuityFirstTurnCompleted(enclosure: RuntimeEnclosureHandle): Promise<boolean> {
    return this.rpc('opencode-continuity-first-turn', z.boolean(), { enclosure })
  }
  async openCodeContinuityFirstReply(handle: ExactRuntimeHandle): Promise<z.infer<typeof OpencodeContinuityFirstReplySchema> | null> {
    return this.rpc('opencode-continuity-first-reply', OpencodeContinuityFirstReplySchema.nullable(), { handle })
  }
  async openCodeContinuityEffectCount(enclosure: RuntimeEnclosureHandle): Promise<number | null> {
    return this.rpc('opencode-continuity-effect-count', z.number().nullable(), { enclosure })
  }
  async openCodeContinuityFollowUpCompleted(enclosure: RuntimeEnclosureHandle): Promise<boolean> {
    return this.rpc('opencode-continuity-follow-up', z.boolean(), { enclosure })
  }
  async openCodeContinuityLongToolRunning(enclosure: RuntimeEnclosureHandle): Promise<boolean> {
    return this.rpc('opencode-continuity-long-tool', z.boolean(), { enclosure })
  }
  async lossCredentialEvidence(enclosure: RuntimeEnclosureHandle): Promise<OpencodeLossCredentialEvidence> {
    return this.rpc('loss-credential', OpencodeLossCredentialEvidenceSchema, { enclosure })
  }
  async lossDiagnosticRetained(enclosure: RuntimeEnclosureHandle): Promise<boolean> {
    return this.rpc('loss-diagnostic', z.boolean(), { enclosure })
  }
  async lossAbsenceEvidence(enclosure: RuntimeEnclosureHandle): Promise<OpencodeLossAbsenceEvidence> {
    return this.rpc('loss-absence', OpencodeLossAbsenceEvidenceSchema, { enclosure })
  }
  async removeLossStorage(handle: ExactRuntimeHandle): Promise<void> {
    await this.rpc('loss-remove-storage', CompletedOwnerOperationSchema, { handle })
  }
  async recoverLoss(handle: ExactRuntimeHandle): Promise<OpencodeLossRecovery> {
    return this.rpc('loss-recover', OpencodeLossRecoverySchema, { handle })
  }
  async lossContainerRunning(incidentId: string): Promise<boolean> {
    return this.rpc('loss-container-running', z.boolean(), { incidentId })
  }
  async lossIncidentEvidence(incidentId: string): Promise<OpencodeLossIncidentEvidence> {
    return this.rpc('loss-incident', OpencodeLossIncidentEvidenceSchema, { incidentId })
  }
  async publishLossAssertions(incidentId: string, lossAssertions: RuntimeLossAssertions): Promise<RuntimeLossAssertionsArtifact> {
    return this.rpc('loss-assertions', RuntimeLossAssertionsArtifactSchema, { incidentId, lossAssertions })
  }
  async finalizeLossReceipt(): Promise<RuntimeLossReceiptArtifact> {
    return this.rpc('loss-receipt', RuntimeLossReceiptArtifactSchema)
  }
  async crashProviderWorker(handle: ExactRuntimeHandle): Promise<void> {
    await this.rpc('crash-provider-worker', CompletedOwnerOperationSchema, { handle })
  }
  async crashRuntimeHost(handle: ExactRuntimeHandle): Promise<void> {
    await this.rpc('crash-host', CompletedOwnerOperationSchema, { handle })
  }
  async holdRuntimeHost(handle: ExactRuntimeHandle): Promise<{ pid: number }> {
    return this.rpc('hold-host', z.object({ pid: z.number().int().positive() }).strict(), { handle })
  }
  async registerNativeChallenge(handle: ExactRuntimeHandle, kind: NativeChallengeKind): Promise<{ challengeId: string }> {
    return this.rpc('native-challenge-register', z.object({ challengeId: z.string().uuid() }).strict(), { handle, challengeId: kind })
  }
  async createSyntheticOpenCodeChallenge(handle: ExactRuntimeHandle): Promise<SyntheticOpenCodeChallenge> {
    return this.rpc('synthetic-history-challenge', z.object({ challengeId: z.string().uuid(),
      nativeSessionId: z.literal(handle.nativeSessionId), messageId: z.string().min(1), toolPartId: z.string().min(1) }).strict(), { handle })
  }
  async nativeToolEvidence(handle: ExactRuntimeHandle, challengeId: string): Promise<NativeToolEvidence> {
    return this.rpc('native-tool-evidence', z.object({ requestIds: z.array(z.string().min(1)), resultIds: z.array(z.string().min(1)),
      replayCount: z.number().int().nonnegative() }).strict(), { handle, challengeId })
  }
  async nativeChallengeEffectCount(handle: ExactRuntimeHandle, challengeId: string): Promise<number> {
    return this.rpc('native-effect-count', z.number().int().nonnegative(), { handle, challengeId })
  }
  async resetNativeChallengeEffect(handle: ExactRuntimeHandle, challengeId: string): Promise<void> {
    await this.rpc('native-effect-reset', CompletedOwnerOperationSchema, { handle, challengeId })
  }
  async nativeFollowUpMessageIds(handle: ExactRuntimeHandle, challengeId: string): Promise<string[]> {
    return this.rpc('native-follow-up-ids', z.array(z.string().min(1)), { handle, challengeId })
  }
  async releaseRuntimeHost(handle: ExactRuntimeHandle): Promise<void> {
    await this.rpc('release-host', CompletedOwnerOperationSchema, { handle })
  }
  async crashFixtureWorker(handle: ExactRuntimeHandle): Promise<void> {
    await this.rpc('crash-provider', CompletedOwnerOperationSchema, { handle })
  }
  async allowFixtureDecision(handle: ExactRuntimeHandle, decisionId: string): Promise<void> {
    await this.rpc('fixture-decision-allow', CompletedOwnerOperationSchema, { handle, challengeId: decisionId })
  }
  async crashAndRestartWeb(): Promise<ManagedBrowserConnectionInfo> { return this.rpc('replace-web', this.infoSchema()) }
  async restartWebGracefully(): Promise<ManagedBrowserConnectionInfo> { return this.rpc('replace-web-graceful', this.infoSchema()) }
  async restartSupervisor(): Promise<void> { await this.rpc('replace-supervisor', CompletedOwnerOperationSchema) }
  async restartSupervisorAbrupt(): Promise<void> { await this.rpc('replace-supervisor-abrupt', CompletedOwnerOperationSchema) }
  async startRetainedFixture(fixtureId: 'config' | 'legacy'): Promise<Task2RetainedBrowserStage> {
    return this.rpc('retained-start', Task2RetainedBrowserStageSchema, { challengeId: fixtureId })
  }
  async retainedFixtureStage(): Promise<Task2RetainedBrowserStage> {
    return this.rpc('retained-status', Task2RetainedBrowserStageSchema)
  }
  async observeRetainedFixture(sequence: number): Promise<Task2RetainedBrowserStage> {
    return this.rpc('retained-observed', Task2RetainedBrowserStageSchema, { generation: sequence })
  }
  async finishRetainedFixture(): Promise<{ ok: boolean; errors: string[] }> {
    return this.rpc('retained-finish', ExternalCleanupSchema)
  }
  async stop(): Promise<{ ok: boolean; errors: string[] }> {
    this.stopSettlement ??= this.rpc('finish', ExternalCleanupSchema)
    try {
      const result = await this.stopSettlement
      if (!result.ok) this.stopSettlement = undefined
      return result
    } catch (error) { this.stopSettlement = undefined; throw error }
  }
}

export interface ExternalRetainedFixtureControl {
  start(fixtureId: 'config' | 'legacy'): void
  status(): Task2RetainedBrowserStage
  advance(sequence: number): void
  cancel(): Promise<void>
}

// Runtime images are owned per run; the nested fixture must use its active
// outer owner's image rather than a digest from an earlier run.
type RetainedArtifacts = Omit<Parameters<RuntimeHarness['prepareTask2FixtureArtifacts']>[0], 'imageDigest'>
const RetainedArtifactSchema = z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const RetainedArtifactsSchema: z.ZodType<RetainedArtifacts> = z.object({
  candidateSha: z.string().regex(/^[a-f0-9]{40}$/),
  currentSupervisor: RetainedArtifactSchema, currentHost: RetainedArtifactSchema, currentServer: RetainedArtifactSchema,
  legacySupervisor: RetainedArtifactSchema, legacyHost: RetainedArtifactSchema,
  legacyCreatorCommit: z.literal('7dbc7ef6b0b87e47ec8386e19115f5e440399898'),
}).strict()

export function readRetainedArtifacts(file: string | undefined, repoRoot: string, candidateSha: string): RetainedArtifacts {
  if (!file || !path.isAbsolute(file) || fs.realpathSync(file) !== file) throw new Error('exact owner Task2 artifact manifest required')
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('Task2 artifact manifest must be private and owned')
  const { repoRoot: manifestRoot, runId, ...manifestArtifacts } = JSON.parse(fs.readFileSync(file, 'utf8'))
  // The sealer records the image used to prepare its immutable files, but a
  // retained fixture must run inside the active owner's image and Docker
  // daemon. Validate the legacy metadata shape, then deliberately discard it.
  const { imageDigest: sourceImageDigest, ...artifacts } = manifestArtifacts
  z.string().regex(/^sha256:[a-f0-9]{64}$/).optional().parse(sourceImageDigest)
  const parsed = RetainedArtifactsSchema.parse(artifacts)
  if (manifestRoot !== repoRoot || !z.string().uuid().safeParse(runId).success || parsed.candidateSha !== candidateSha) {
    throw new Error('Task2 artifacts differ from the current exact candidate and worktree')
  }
  return parsed
}

/** Each browser case owns a separate actual retained driver, broker and registry. */
export class OwnedRetainedBrowserFixtures implements ExternalRetainedFixtureControl {
  private session?: RetainedFixtureBrowserSession
  private activeWeb?: RuntimeWebHandle
  private readonly webs = new Set<RuntimeWebHandle>()
  private facts?: Extract<Task2RetainedBrowserStage, { kind: 'finished' }>['facts']
  private readonly cleanupErrors: string[] = []
  constructor(private readonly owner: ManagedRuntimeOwner, private readonly artifacts: RetainedArtifacts,
    private readonly allowed: readonly ('config' | 'legacy')[],
    private readonly webFactory?: RuntimeWebFactory) {}

  get backend(): string { return this.activeWeb?.info.baseUrl ?? this.owner.info.baseUrl }
  start(fixtureId: 'config' | 'legacy'): void {
    if (!this.allowed.includes(fixtureId) || (this.session && this.session.status().kind !== 'finished')) {
      throw new Error('retained fixture is not registered or its previous run is unsettled')
    }
    const h: RuntimeHarness = new RuntimeHarness(this.owner.repoRoot, randomUUID(), 3)
    if (h.candidateSha !== this.owner.runtime.candidateSha) throw new Error('retained fixture source candidate changed')
    this.session = new RetainedFixtureBrowserSession()
    this.facts = undefined
    const factory: RuntimeWebFactory = options => {
      const configured = { ...options, token: this.owner.info.token,
        writeDiagnosticArtifact: (fileName: string, value: unknown) => h.writeArtifact(fileName, value) }
      const web = this.webFactory ? this.webFactory(configured) : new ManagedRuntimeWebServer(configured,
        record => h.recordLifecycle('external.web_diagnostics', { severity: 'info', ...record }))
      this.webs.add(web)
      const start = web.start.bind(web), stop = web.stop.bind(web)
      web.start = async () => { const info = await start(); this.activeWeb = web; return info }
      web.stop = async () => { await stop(); if (this.activeWeb === web) this.activeWeb = undefined }
      return web
    }
    this.session.start(async hooks => {
      let original: unknown
      let lastStage = retainedStageDiagnostic(this.session!.status())
      const recordStage = () => {
        const stage = retainedStageDiagnostic(this.session!.status())
        if (stage?.kind !== 'observe' && stage?.kind !== 'retry') return
        lastStage = stage
        emitExternalDiagnostic('retained', () => h.recordLifecycle('external.retained_stage_published', {
          severity: 'info', parentRunId: this.owner.runtime.runId, runId: h.runId,
          candidateSha: h.candidateSha, fixtureId, stage: lastStage }))
      }
      const observe: typeof hooks.observe = (context, phase) => {
        const pending = hooks.observe(context, phase)
        recordStage()
        return pending
      }
      const retry: typeof hooks.retry = (context, phase) => {
        const pending = hooks.retry(context, phase)
        recordStage()
        return pending
      }
      try {
        await h.prepareTask2FixtureArtifacts({ ...this.artifacts, imageDigest: this.owner.runtime.imageRef })
        h.recordLifecycle('external.retained_fixture_registered', { severity: 'info',
          parentRunId: this.owner.runtime.runId, candidateSha: h.candidateSha, fixtureId })
        await runTask2RetainedFixture(h, fixtureId === 'legacy', factory, { observe, retry })
        h.assert(fixtureId, h.broker.unsafeAttempts().length === 0, 'retained browser fixture performs no unsafe broker operation')
      } catch (error) {
        original = error
        const cancelled = error instanceof Error && error.message === 'owned retained browser session cancelled'
        emitExternalDiagnostic('retained', () => h.recordLifecycle('external.retained_driver_failed', { severity: cancelled ? 'info' : 'error',
          parentRunId: this.owner.runtime.runId, runId: h.runId, candidateSha: h.candidateSha, fixtureId,
          reason: cancelled ? 'cancelled' : 'driver_failure', stage: lastStage, ...safeExternalFailure(error) }))
      }
      let cleanupFailure: unknown
      try {
        const webErrors: unknown[] = []
        for (const web of this.webs) {
          try { await web.stop() } catch (error) { webErrors.push(error) }
        }
        const receipts = h.broker?.receipts() ?? [], ids = h.transferOwnedIds()
        const cleanup = await h.cleanup()
        h.verifyTransferCleanup({ containers: [...new Set([...ids.containers, ...receipts.map(row => row.containerId)])],
          volumes: [...new Set([...ids.volumes, ...receipts.flatMap(row => row.providerVolumeName ? [row.providerVolumeName] : [])])] })
        if (!cleanup.ok) throw new Error('actual retained resources did not clean up')
        if (webErrors.length) throw new AggregateError(webErrors, 'retained owned web cleanup failed')
        this.facts = { fixtureRunId: h.runId, candidateSha: h.candidateSha, imageDigest: h.imageRef,
          unsafeBrokerAttempts: h.broker?.unsafeAttempts().length ?? 0 }
        h.writeArtifact(fixtureId === 'legacy' ? 'task002-legacy-browser.json' : 'task002-config-browser.json', {
          kind: 'synthetic-task2-browser', nativeQualified: false, ...this.facts,
          parentRunId: this.owner.runtime.runId,
        })
      } catch (error) { cleanupFailure = error; this.cleanupErrors.push('retained fixture cleanup failed') }
      if (original && cleanupFailure) throw new AggregateError([original, cleanupFailure], 'retained fixture and cleanup failed')
      if (original) throw original
      if (cleanupFailure) throw cleanupFailure
    })
  }
  status(): Task2RetainedBrowserStage {
    if (!this.session) throw new Error('owned retained fixture has not started')
    const stage = this.session.status()
    return stage.kind === 'finished' ? { ...stage, facts: this.facts } : stage
  }
  advance(sequence: number): void {
    if (!this.session) throw new Error('owned retained fixture has not started')
    this.session.advance(sequence)
  }
  captureRetry(observed: { soulId: string; requestId: string; response: unknown }): void {
    if (!this.session) throw new Error('owned retained fixture has not started')
    this.session.captureRetry(observed.soulId, observed.requestId, observed.response)
  }
  async cancel(): Promise<void> {
    await this.session?.cancel()
    for (const web of this.webs) await web.stop()
    if (this.cleanupErrors.length) throw new Error(this.cleanupErrors.join('; '))
  }
}

export function createExternalRuntimeControl(
  owner: ManagedRuntimeOwner, descriptor: ManagedExternalDescriptor,
  retained?: ExternalRetainedFixtureControl,
): (input: unknown) => Promise<unknown> {
  if (owner.runtime.runId !== descriptor.runId || owner.runtime.candidateSha !== descriptor.candidateSha) {
    throw new Error('external controller differs from its exact owned run and candidate')
  }
  let finished = false
  const retainedStage = () => {
    if (!retained) throw new Error('registered retained fixture required')
    const stage = retained.status()
    return stage.kind === 'observe' || stage.kind === 'retry'
      ? { ...stage, context: { ...stage.context, info: {
        baseUrl: descriptor.baseUrl, wsUrl: descriptor.wsUrl, token: descriptor.token,
      } } } : stage
  }
  const execute = async (request: RuntimeOwnerOperationRequest) => {
    if (finished && request.action !== 'finish' && request.action !== 'abort'
      && request.action !== 'candidate-integrity' && request.action !== 'chaos-receipt' && request.action !== 'loss-receipt'
      && request.action !== 'fresh-agent-receipt' && request.action !== 'provider-receipt') {
      throw new Error('external owned runtime is finished')
    }
    const handle = () => {
      if (!request.handle) throw new Error('exact current owner handle required')
      return request.handle
    }
    let result: unknown
    switch (request.action) {
      case 'describe':
        result = { workspaceCwd: owner.workspaceCwd, info: { baseUrl: descriptor.baseUrl, wsUrl: descriptor.wsUrl, token: descriptor.token },
          registration: owner.fixtureRegistrationFacts() }
        break
      case 'inventory': result = await owner.inventory(); break
      case 'synthetic-source-facts': result = await owner.syntheticOpenCodeSourceFacts(); break
      case 'synthetic-stopped-repair-facts': result = await owner.syntheticStoppedRepairBatchFacts(); break
      case 'synthetic-stopped-repair-observation':
        if (!request.fixtureId || !request.repairOperationId) throw new Error('registered fixture and repair operation IDs required')
        result = await owner.syntheticStoppedRepairBatchObservation(request.fixtureId, request.repairOperationId)
        break
      case 'synthetic-stopped-repair-fault':
        if (!request.fixtureId || !request.stoppedRepairFault) throw new Error('registered fixture and fixed fault required')
        result = await owner.setSyntheticStoppedRepairFault(request.fixtureId, request.stoppedRepairFault)
        break
      case 'synthetic-source-history': result = await owner.syntheticOpenCodeHistoryFacts(handle()); break
      case 'synthetic-source-exclusions': result = await owner.syntheticOpenCodeExcludedSentinels(handle()); break
      case 'synthetic-source-adoption': result = await owner.syntheticOpenCodeAdoptionStatus(handle()); break
      case 'synthetic-source-follow-up': result = await owner.syntheticOpenCodeFollowUpMessageId(handle()); break
      case 'inventory-snapshot': result = await owner.inventorySnapshot(); break
      case 'control-epoch': result = await owner.controlEpoch(); break
      case 'ownership-facts': result = await owner.ownershipFacts(); break
      case 'terminal-child-facts':
        if (!request.enclosure) throw new Error('exact terminal enclosure required')
        result = await owner.terminalChildFacts(request.enclosure)
        break
      case 'terminal-web-cycle':
        if (!request.enclosure || !request.challengeId) throw new Error('exact terminal enclosure and cycle marker required')
        result = await owner.terminalWebCycleCompleted(request.enclosure, request.challengeId)
        break
      case 'terminal-continuity-diagnostics':
        if (!request.enclosure) throw new Error('exact terminal enclosure required')
        result = await owner.captureTerminalContinuityDiagnostics(request.enclosure)
        break
      case 'terminal-continuity-receipt':
        if (!request.enclosure || !request.continuityObservation) throw new Error('exact enclosure and continuity observations required')
        result = await owner.publishTerminalContinuityReceipt(request.enclosure, request.continuityObservation)
        break
      case 'candidate-integrity': result = await owner.captureCandidateIntegrity(); break
      case 'web-process-facts': result = await owner.webProcessFacts(); break
      case 'supervisor-process-facts': result = await owner.supervisorProcessFacts(); break
      case 'chaos-web-output':
        if (!request.challengeId) throw new Error('registered chaos follow-up challenge required')
        result = await owner.chaosWebOutputFacts(handle(), request.challengeId)
        break
      case 'chaos-long-tool-running':
        if (!request.challengeId) throw new Error('registered chaos long-tool challenge required')
        result = await owner.chaosLongToolRunning(handle(), request.challengeId)
        break
      case 'chaos-logs':
        if (!request.chaosLogs) throw new Error('chaos log observations required')
        result = await owner.publishChaosLogs(handle(), request.chaosLogs)
        break
      case 'chaos-evidence':
        if (!request.chaosEvidence) throw new Error('chaos evidence observations required')
        result = await owner.publishChaosEvidence(handle(), request.chaosEvidence)
        break
      case 'chaos-receipt': result = await owner.finalizeChaosReceipt(); break
      case 'loss-credential':
        if (!request.enclosure) throw new Error('exact runtime enclosure required')
        result = await owner.lossCredentialEvidence(request.enclosure)
        break
      case 'loss-diagnostic':
        if (!request.enclosure) throw new Error('exact runtime enclosure required')
        result = await owner.lossDiagnosticRetained(request.enclosure)
        break
      case 'loss-absence':
        if (!request.enclosure) throw new Error('exact runtime enclosure required')
        result = await owner.lossAbsenceEvidence(request.enclosure)
        break
      case 'loss-remove-storage': await owner.removeLossStorage(handle()); result = { completed: true }; break
      case 'loss-recover': result = await owner.recoverLoss(handle()); break
      case 'loss-container-running':
        if (!request.incidentId) throw new Error('observed loss incident required')
        result = await owner.lossContainerRunning(request.incidentId)
        break
      case 'loss-incident':
        if (!request.incidentId) throw new Error('observed loss incident required')
        result = await owner.lossIncidentEvidence(request.incidentId)
        break
      case 'loss-assertions':
        if (!request.incidentId || !request.lossAssertions) throw new Error('observed loss incident assertions required')
        result = await owner.publishLossAssertions(request.incidentId, request.lossAssertions)
        break
      case 'loss-receipt': result = await owner.finalizeLossReceipt(); break
      case 'incident-matches-soul':
        if (!request.incidentId) throw new Error('observed incident identity required')
        result = await owner.incidentMatchesSoul(handle(), request.incidentId)
        break
      case 'managed-opt-in':
        if (request.expectedControlEpoch === undefined) throw new Error('exact managed preset controller epoch required')
        result = await owner.applyManagedOptIn(request.expectedControlEpoch)
        break
      case 'writer-claim': result = await owner.writerClaimFacts(handle()); break
      case 'stop-soul':
        if (request.expectedControlEpoch === undefined || request.expectedIntentRevision === undefined) {
          throw new Error('exact Stop controller epoch and intent revision required')
        }
        result = await owner.stopRuntimeSoul(handle(), request.expectedControlEpoch, request.expectedIntentRevision)
        break
      case 'stop-completion-facts':
        if (request.expectedIntentRevision === undefined || request.generation === undefined) {
          throw new Error('captured Stop intent and execution generation required')
        }
        result = await owner.stopCompletionFacts(handle(), request.expectedIntentRevision, request.generation)
        break
      case 'retained-start':
        if (!retained || (request.challengeId !== 'config' && request.challengeId !== 'legacy')) throw new Error('registered retained fixture required')
        retained.start(request.challengeId)
        result = retainedStage()
        break
      case 'retained-status':
        if (!retained) throw new Error('registered retained fixture required')
        result = retainedStage()
        break
      case 'retained-observed':
        if (!retained || request.generation === undefined) throw new Error('exact retained stage sequence required')
        retained.advance(request.generation)
        result = retainedStage()
        break
      case 'retained-finish':
        if (!retained) throw new Error('registered retained fixture required')
        try { await retained.cancel(); result = { ok: true, errors: [] } }
        catch { result = { ok: false, errors: ['retained fixture cleanup failed'] } }
        break
      case 'host-facts': result = await owner.chaosHostFacts(handle()); break
      case 'opencode-version':
        if (!request.enclosure) throw new Error('exact current runtime enclosure address required')
        result = await owner.openCodeVersionFacts(request.enclosure)
        break
      case 'opencode-continuity-startup':
        if (!request.enclosure) throw new Error('exact OpenCode enclosure required')
        result = await owner.openCodeContinuityStartupFacts(request.enclosure)
        break
      case 'opencode-continuity-first-turn':
        if (!request.enclosure) throw new Error('exact OpenCode enclosure required')
        result = await owner.openCodeContinuityFirstTurnCompleted(request.enclosure)
        break
      case 'opencode-continuity-first-reply':
        result = await owner.openCodeContinuityFirstReply(handle())
        break
      case 'opencode-qualification-startup':
        if (!request.enclosure) throw new Error('exact OpenCode enclosure required')
        result = await owner.openCodeQualificationStartupFacts(request.enclosure)
        break
      case 'opencode-qualification-limits':
        if (!request.enclosure) throw new Error('exact OpenCode enclosure required')
        result = await owner.openCodeQualificationLimits(request.enclosure)
        break
      case 'opencode-qualification-blockers':
        result = await owner.runOpenCodeQualificationBlockers()
        break
      case 'opencode-replacement-readiness':
        if (!request.enclosure || !request.qualificationTerminalId) throw new Error('exact OpenCode enclosure and observed terminal required')
        result = await owner.openCodeReplacementReadiness(request.enclosure, request.qualificationTerminalId)
        break
      case 'opencode-readiness-confirm':
        if (!request.enclosure || !request.qualificationReadiness) throw new Error('exact enclosure and readiness observations required')
        await owner.confirmOpenCodeReplacementReadiness(request.enclosure, request.qualificationReadiness)
        result = { completed: true }
        break
      case 'opencode-readiness-diagnostic':
        if (!request.enclosure || !request.qualificationDiagnostic) throw new Error('exact enclosure and readiness diagnostic required')
        result = await owner.publishOpenCodeReadinessDiagnostic(request.enclosure, request.qualificationDiagnostic)
        break
      case 'opencode-qualification-second-view':
        if (request.expectedIntentRevision === undefined || request.expectedControlEpoch === undefined) throw new Error('exact view revision and controller epoch required')
        await owner.addOpenCodeQualificationSecondView(handle(), request.expectedIntentRevision, request.expectedControlEpoch)
        result = { completed: true }
        break
      case 'opencode-qualification-notice-count':
        result = await owner.openCodeQualificationNoticeCount()
        break
      case 'opencode-qualification-message-ids':
        result = await owner.openCodeQualificationAssistantMessageIds(handle())
        break
      case 'opencode-qualification-nonce':
        if (!request.qualificationNonce) throw new Error('fixed qualification nonce required')
        result = await owner.registerOpenCodeQualificationNonce(handle(), request.qualificationNonce)
        break
      case 'opencode-qualification-turn':
        if (!request.challengeId || !request.qualificationProofStage || !request.priorMessageIds) throw new Error('registered challenge, stage and prior IDs required')
        result = await owner.openCodeQualificationTurn(handle(), request.challengeId, request.qualificationProofStage,
          request.priorMessageIds, request.otherChallengeId)
        break
      case 'opencode-continuity-effect-count':
        if (!request.enclosure) throw new Error('exact OpenCode enclosure required')
        result = await owner.openCodeContinuityEffectCount(request.enclosure)
        break
      case 'opencode-continuity-follow-up':
        if (!request.enclosure) throw new Error('exact OpenCode enclosure required')
        result = await owner.openCodeContinuityFollowUpCompleted(request.enclosure)
        break
      case 'opencode-continuity-long-tool':
        if (!request.enclosure) throw new Error('exact OpenCode enclosure required')
        result = await owner.openCodeContinuityLongToolRunning(request.enclosure)
        break
      case 'phase3-effect-reset':
        if (!request.enclosure) throw new Error('exact current runtime enclosure address required')
        await owner.resetPhase3ApprovalEffect(request.enclosure)
        result = { completed: true }
        break
      case 'fresh-native-register':
        if (!request.nativeCollectionNonce) throw new Error('fresh native collection nonce required')
        result = await owner.registerFreshNativeCollection(handle(), request.nativeCollectionNonce)
        break
      case 'fresh-native-stage':
        if (!request.nativeCollectionId) throw new Error('registered fresh native collection required')
        result = await owner.captureFreshNativeStage(handle(), request.nativeCollectionId)
        break
      case 'fresh-native-finish':
        if (!request.nativeCollectionId) throw new Error('registered fresh native collection required')
        result = await owner.finishFreshNativeCollection(handle(), request.nativeCollectionId)
        break

      case 'fresh-browser-ingress':
        if (!request.nativeCollectionId || !request.freshBrowserIngress) throw new Error('registered collection and actual route required')
        await owner.observeFreshBrowserIngress(handle(), request.nativeCollectionId, request.freshBrowserIngress)
        result = { completed: true }; break
      case 'fresh-browser-turn-register':
        if (!request.nativeCollectionId) throw new Error('registered collection required')
        result = await owner.registerFreshBrowserTurn(handle(), request.nativeCollectionId); break
      case 'fresh-browser-turn-finish':
        if (!request.challengeId || !request.freshBrowserRequest || !request.freshBrowserReply) throw new Error('registered actual browser turn required')
        await owner.finishFreshBrowserTurn(handle(), request.challengeId, request.freshBrowserRequest, request.freshBrowserReply)
        result = { completed: true }; break
      case 'fresh-browser-row':
        if (!request.nativeCollectionId) throw new Error('registered collection required')
        result = await owner.captureFreshBrowserRow(handle(), request.nativeCollectionId); break
      case 'fresh-approval-register':
        if (request.freshApprovalAllowed === undefined || !request.freshApprovalRecovery) throw new Error('fixed native decision and recovery required')
        result = await owner.registerFreshApproval(handle(), request.freshApprovalAllowed, request.freshApprovalRecovery); break
      case 'fresh-approval-checkpoint':
        if (!request.challengeId) throw new Error('registered native approval required')
        result = await owner.captureFreshApprovalCheckpoint(handle(), request.challengeId); break
      case 'fresh-approval-finish':
        if (!request.challengeId || !request.freshBrowserRequest) throw new Error('registered native approval and actual browser decision required')
        await owner.finishFreshApproval(handle(), request.challengeId, request.freshBrowserRequest)
        result = { completed: true }; break

      case 'fresh-agent-launch-facts':
        if (!request.enclosure) throw new Error('exact current runtime enclosure address required')
        result = await owner.freshAgentLaunchFacts(request.enclosure)
        break
      case 'fresh-agent-ingresses': await owner.validateFreshAgentIngressInventory(); result = { completed: true }; break
      case 'provider-receipt':
        if (!request.providerObservations) throw new Error('observed provider rows required')
        result = await owner.publishProviderQualification(request.providerObservations)
        break
      case 'fresh-agent-receipt':
        if (!request.freshAgentObservations) throw new Error('observed fresh-agent rows required')
        result = await owner.publishFreshAgentQualification(request.freshAgentObservations)
        break
      case 'host-process-state':
        if (!request.enclosure) throw new Error('exact tracked runtime enclosure address required')
        result = await owner.ownedRuntimeHostState(request.enclosure)
        break
      case 'container-state':
        if (!request.enclosure) throw new Error('exact tracked runtime enclosure address required')
        result = await owner.ownedContainerState(request.enclosure)
        break
      case 'phase3-effect-count':
        if (!request.enclosure) throw new Error('exact current runtime enclosure address required')
        result = await owner.phase3ApprovalEffectCount(request.enclosure)
        break
      case 'phase4-browser-receipt':
        if (!request.phase4Browser) throw new Error('closed Phase 4 browser observation required')
        result = await owner.publishPhase4BrowserReceipt(request.phase4Browser)
        break
      case 'phase3-browser-receipt':
        if (!request.phase3Browser) throw new Error('closed Phase 3 browser observation required')
        result = await owner.publishPhase3BrowserReceipt(handle(), request.phase3Browser)
        break
      case 'crash-provider-worker': await owner.crashProviderWorker(handle()); result = { completed: true }; break
      case 'freshcodex-history-preservation-artifact':
        if (!request.historyPreservation) throw new Error('closed observed saved-history preservation required')
        result = await owner.publishFreshCodexSavedHistoryPreservation(handle(), request.historyPreservation)
        break
      case 'freshcodex-history-measurement-artifact':
        if (!request.enclosure || !request.historyMeasurement) throw new Error('recorded enclosure and closed profiler measurement required')
        result = await owner.publishFreshCodexSavedHistoryMeasurement(request.enclosure, request.historyMeasurement)
        break
      case 'freshcodex-controller-reattachment':
        if (!request.historyControllerReattachment) throw new Error('closed controller reattachment observation required')
        await owner.recordFreshCodexControllerReattachment(handle(), request.historyControllerReattachment)
        result = { completed: true }
        break
      case 'freshcodex-history-measurement-finish':
        if (!request.enclosure || !request.historyMeasurementFinish) throw new Error('recorded enclosure and closed saved-history completion timing required')
        await owner.finishFreshCodexSavedHistoryMeasurement(request.enclosure, request.historyMeasurementFinish)
        result = { completed: true }
        break
      case 'freshcodex-history-measurement-start':
        if (!request.historyMeasurementStart) throw new Error('closed saved-history browser timing required')
        await owner.startFreshCodexSavedHistoryMeasurement(handle(), request.historyMeasurementStart)
        result = { completed: true }
        break
      case 'freshcodex-history-ownership': result = await owner.freshCodexSavedHistoryOwnershipFacts(handle()); break
      case 'freshcodex-controller-startup': result = await owner.freshCodexControllerStartupFacts(handle()); break
      case 'freshcodex-history-snapshot': result = await owner.freshCodexRetainedSnapshotFacts(handle()); break
      case 'freshcodex-history-prepare': result = await owner.prepareFreshCodexSavedHistory(handle()); break
      case 'interrupted-stop-history': await owner.prepareInterruptedOrdinaryStopHistory(handle()); result = { completed: true }; break
      case 'interrupted-stop-arm': await owner.armInterruptedOrdinaryStop(handle()); result = { completed: true }; break
      case 'interrupted-stop-counters': result = await owner.installInterruptedOrdinaryStopCounters(handle()); break
      case 'interrupted-stop-facts': result = await owner.interruptedOrdinaryStopFacts(handle()); break
      case 'interrupted-stop-crash-facts': result = await owner.interruptedOrdinaryStopCrashFacts(handle()); break
      case 'interrupted-stop-artifact':
        if (request.interruptedStopRetainedTurns === undefined) throw new Error('observed retained Stop turn count required')
        result = await owner.publishInterruptedOrdinaryStopResult(handle(), request.interruptedStopRetainedTurns)
        break
      case 'freshcodex-history-unchanged': result = await owner.freshCodexSavedHistoryUnchanged(handle()); break
      case 'freshcodex-coincident-prepare': await owner.prepareCoincidentFreshCodexHistory(handle()); result = { completed: true }; break
      case 'freshcodex-coincident-unchanged': result = await owner.coincidentFreshCodexHistoryUnchanged(handle()); break
      case 'fixture-state': result = await owner.fixtureNativeState(handle()); break
      case 'fixture-worker': result = await owner.fixtureWorkerFacts(handle()); break
      case 'provider-volume': result = await owner.providerVolumeFacts(handle()); break
      case 'managed-provider-notice-count': result = await owner.managedProviderPendingNoticeCount(handle()); break
      case 'managed-terminal-startup':
        if (!request.enclosure) throw new Error('current registered terminal enclosure required')
        result = await owner.managedTerminalStartupFacts(request.enclosure)
        break
      case 'managed-terminal-stopped-proofs':
        if (!request.terminalQualificationNonce) throw new Error('fixed terminal qualification nonce required')
        result = await owner.managedTerminalStoppedProofs(handle(), request.terminalQualificationNonce)
        break
      case 'fixture-decision-allow':
        if (!request.challengeId) throw new Error('actual pending fixture decision required')
        await owner.allowFixtureDecision(handle(), request.challengeId)
        result = { completed: true }
        break
      case 'crash-host': await owner.crashRuntimeHost(handle()); result = { completed: true }; break
      case 'hold-host': result = await owner.holdRuntimeHost(handle()); break
      case 'native-challenge-register':
        if (request.challengeId !== 'chaos-approval' && request.challengeId !== 'chaos-long-tool' && request.challengeId !== 'chaos-follow-up') throw new Error('registered native challenge kind required')
        result = await owner.registerNativeChallenge(handle(), request.challengeId)
        break
      case 'synthetic-history-challenge': result = await owner.createSyntheticOpenCodeChallenge(handle()); break
      case 'native-effect-count':
        if (!request.challengeId) throw new Error('registered chaos effect challenge required')
        result = await owner.nativeChallengeEffectCount(handle(), request.challengeId)
        break
      case 'native-effect-reset':
        if (!request.challengeId) throw new Error('registered chaos effect challenge required')
        await owner.resetNativeChallengeEffect(handle(), request.challengeId)
        result = { completed: true }
        break
      case 'native-tool-evidence':
        if (!request.challengeId) throw new Error('registered native challenge required')
        result = await owner.nativeToolEvidence(handle(), request.challengeId)
        break
      case 'native-follow-up-ids':
        if (!request.challengeId) throw new Error('registered native challenge required')
        result = await owner.nativeFollowUpMessageIds(handle(), request.challengeId)
        break
      case 'release-host': await owner.releaseRuntimeHost(handle()); result = { completed: true }; break
      case 'crash-provider': await owner.crashFixtureWorker(handle()); result = { completed: true }; break
      case 'replace-web':
        await owner.crashAndRestartWeb()
        result = { baseUrl: descriptor.baseUrl, wsUrl: descriptor.wsUrl, token: descriptor.token }
        break
      case 'replace-web-graceful':
        await owner.restartWebGracefully()
        result = { baseUrl: descriptor.baseUrl, wsUrl: descriptor.wsUrl, token: descriptor.token }
        break
      case 'replace-supervisor': await owner.restartSupervisor(); result = { completed: true }; break
      case 'replace-supervisor-abrupt': await owner.restartSupervisorAbrupt(); result = { completed: true }; break
      case 'finish':
      case 'abort': {
        if (request.action === 'abort') owner.abortFreshNativeCollections()
        const errors: string[] = []
        try { await retained?.cancel() } catch { errors.push('retained fixture cleanup failed') }
        const cleanup = await owner.stop()
        errors.push(...cleanup.errors)
        finished = cleanup.ok && errors.length === 0
        result = { ok: finished, errors }
        break
      }
      default: throw new Error('owner operation is not admitted by this external fixture controller')
    }
    return { runId: descriptor.runId, candidateSha: descriptor.candidateSha, operationId: request.operationId, result }
  }
  const queue = new RuntimeOwnerOperationQueue(descriptor.runId, descriptor.candidateSha, 'browser-managed-runtime', async request => {
    try { return await execute(request) } catch (error) {
      const runtime = z.object({ runtimeError: z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/) }) }).safeParse(error)
      const address = z.object({ runtimeHandleMismatches: RuntimeHandleMismatchFieldsSchema }).safeParse(error)
      const nativeRecoveryDiagnostic = nativeRecoveryValidationDiagnostic(error)
      owner.runtime.recordLifecycle('external.owner_operation_refused', {
        severity: 'warn', runId: descriptor.runId, candidateSha: descriptor.candidateSha,
        operationId: request.operationId, action: request.action,
        reason: runtime.success ? 'runtime_rejection'
          : address.success ? 'current_address_mismatch'
            : nativeRecoveryDiagnostic ? 'native_recovery_validation_failed'
              : error instanceof Error && error.message === 'exact actually pending fixture decision required'
                ? 'pending_decision_mismatch' : 'owner_operation_refused',
        ...(runtime.success ? { runtimeCode: runtime.data.runtimeError.code } : {}),
        ...(address.success ? { mismatchedFields: address.data.runtimeHandleMismatches } : {}),
        ...(nativeRecoveryDiagnostic ? { nativeRecoveryDiagnostic } : {}),
        ...(request.handle ? { soulId: request.handle.soulId, incarnationId: request.handle.incarnationId } : {}),
      })
      throw error
    }
  })
  return input => queue.perform(input)
}

export type ExternalBrowserSelection = {
  spec: string
  grep?: string
  provider?: QualifiableTerminalProvider
  mode?: QualifiableFreshAgentMode
}

export type ExternalBrowserCase = { id: string; title: string; file: string }
export type ExternalBrowserCaseResult = ExternalBrowserCase & {
  status: 'passed' | 'failed' | 'skipped' | 'timedOut' | 'interrupted'
}
export type ExternalBrowserCounts = {
  originals?: BrowserOriginalIndex[]
  selected: number; executed: number; passed: number; failed: number; skipped: number; timedOut: number
}

export function parseExternalCloudExecutionEvents(
  events: readonly unknown[], context: Pick<ManagedExternalDescriptor, 'runId' | 'candidateSha'>,
): ExternalBrowserCaseResult[] {
  const observed = parseExternalCloudCaseObservations(events, context)
  if (observed.status !== 'passed') throw new Error('Cloud execution completion failed')
  return observed.cases
}

function parseExternalCloudCaseObservations(
  events: readonly unknown[], context: Pick<ManagedExternalDescriptor, 'runId' | 'candidateSha'>,
): { status: FullResult['status']; cases: ExternalBrowserCaseResult[] } {
  const cases: ExternalBrowserCaseResult[] = []
  let completion: Record<string, unknown> | undefined
  for (const input of events) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid Cloud execution event')
    const event = input as Record<string, unknown>
    if (!['managed_external_case', 'managed_external_complete'].includes(String(event.event))) continue
    if (event.runId !== context.runId || event.candidateSha !== context.candidateSha) {
      throw new Error('Cloud execution event differs from the owned run or candidate')
    }
    if (event.event === 'managed_external_complete') {
      if (completion) throw new Error('duplicate Cloud execution completion')
      completion = event
      continue
    }
    if (typeof event.id !== 'string' || !event.id || typeof event.title !== 'string' || !event.title
      || typeof event.file !== 'string' || !['passed', 'failed', 'skipped', 'timedOut', 'interrupted'].includes(String(event.status))) {
      throw new Error('invalid Cloud execution case observation')
    }
    specName(event.file)
    if (cases.some(row => row.id === event.id)) throw new Error('duplicate Cloud execution case')
    cases.push({ id: event.id, title: event.title, file: event.file, status: event.status as ExternalBrowserCaseResult['status'] })
  }
  const status = z.enum(['passed', 'failed', 'timedout', 'interrupted']).safeParse(completion?.status)
  if (!completion || !status.success || !cases.length || completion.cases !== cases.length) {
    throw new Error('Cloud execution completion is missing, failed or incomplete')
  }
  return { status: status.data, cases }
}

// The prefix keeps these bounded records in Cloud Logging textPayload. The
// existing launcher retains that display stream in cloud-launcher-output.json.
const HISTORY_DIAGNOSTIC_PREFIX = 'managed-history-diagnostic '
const HistoryCallsiteSchema = z.object({
  file: z.string().regex(/^test\/e2e-browser\/(specs|helpers)\/[a-zA-Z0-9_.-]+\.ts$/),
  line: z.number().int().positive(), column: z.number().int().positive(),
})
const HistoryPhaseSchema = z.enum(['start', 'goto', 'harness', 'connection', 'new-tab', 'picker-visible',
  'picker-click', 'directory-fill', 'directory-enter', 'pane-observation', 'first-inventory',
  'composer-enabled', 'composer-fill', 'send', 'completion', 'native-pane', 'tab-count', 'layout',
  'inventory-before', 'history-open', 'history-pane-visible', 'history-active-tab', 'history-tab-count',
  'history-layout', 'history-inventory', 'history-wire', 'history-current', 'history-dispatch'])
const HistoryModeSchema = z.enum(['bootstrap', 'freshclaude', 'kilroy', 'freshcodex', 'freshopencode'])
const HistoryErrorCategorySchema = z.enum(['timeout', 'interrupted', 'operation-error'])
const HistoryWindowStageSchema = z.enum(['before-projects', 'before-refresh', 'indexed', 'complete', 'failed'])
const HistoryIntegritySchema = z.enum(['none', 'identity_collision', 'other', 'unknown'])
const HistoryIssueCodeSchema = z.enum(['invalid_type', 'invalid_enum_value', 'too_small', 'too_big',
  'unrecognized_keys', 'invalid_string', 'custom', 'other'])
const HistoryWindowFactsSchema = z.object({
  available: z.boolean(), exactIdentityCount: z.number().int().nonnegative().optional(),
  resultVersion: z.number().int().nonnegative().optional(), lastLoadedAtPresent: z.boolean().optional(),
  loading: z.boolean().optional(), loadingKind: z.enum(['initial', 'search', 'background', 'pagination', 'other', 'absent']).optional(),
  errorPresent: z.boolean().optional(), requestedQueryEmpty: z.boolean().optional(), appliedQueryEmpty: z.boolean().optional(),
  requestedTier: z.enum(['title', 'other', 'absent']).optional(), appliedTier: z.enum(['title', 'other', 'absent']).optional(),
  partial: z.boolean().optional(), integrity: HistoryIntegritySchema.optional(),
  activeSurface: z.enum(['history', 'sidebar', 'other', 'absent']).optional(),
  sidebarExactIdentityCount: z.number().int().nonnegative().optional(), topLevelExactIdentityCount: z.number().int().nonnegative().optional(),
})
export type ManagedHistoryWindowFacts = z.infer<typeof HistoryWindowFactsSchema>
export type ManagedHistoryWindowStage = z.infer<typeof HistoryWindowStageSchema>
const HistoryDirectoryFactsSchema = z.object({
  event: z.literal('managed_history_directory'), mode: HistoryModeSchema, requestSeq: z.number().int().positive(),
  order: z.number().int().positive(), stage: z.enum(['request', 'response', 'failed', 'body']),
  method: z.enum(['GET', 'POST', 'other']).optional(), route: z.literal('session-directory').optional(),
  query: z.object({ queryEmpty: z.boolean(), tier: z.enum(['title', 'other']), limit: z.number().int().positive().max(10000).optional(),
    includeSubagents: z.boolean(), includeNonInteractive: z.boolean(), includeEmpty: z.boolean(),
    includeKeysCount: z.number().int().nonnegative().max(10000) }).optional(),
  status: z.number().int().min(100).max(599).optional(),
  category: z.enum(['http-error', 'aborted', 'transport-failed', 'body-unavailable', 'unknown', 'body-limit']).optional(),
  parseSuccess: z.boolean().optional(), issues: z.array(z.object({ code: HistoryIssueCodeSchema,
    path: z.array(z.enum(['root', 'items', 'contextUsageExtras', 'integrityError', 'index', 'field'])).max(6) })).max(8).optional(),
  itemCount: z.number().int().nonnegative().optional(), exactIdentityCount: z.number().int().nonnegative().optional(),
  nextCursorPresent: z.boolean().optional(), partial: z.boolean().optional(), integrity: HistoryIntegritySchema.optional(),
  snapshotSeq: z.number().int().positive().optional(), ownedContext: z.array(z.object({ projectMatches: z.boolean(),
    cwdMatches: z.boolean().optional(), checkoutMatches: z.boolean().optional() })).max(8).optional(),
})
const HistoryDiagnosticSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('managed_history_phase'), phase: HistoryPhaseSchema, mode: HistoryModeSchema,
    state: z.enum(['begin', 'end', 'failed']), callsite: HistoryCallsiteSchema.optional(),
    errorCategory: HistoryErrorCategorySchema.optional() }),
  z.object({ event: z.literal('managed_history_navigation'), status: z.number().int().min(100).max(599).optional(),
    resourceType: z.enum(['document', 'stylesheet', 'image', 'media', 'font', 'script', 'texttrack',
      'xhr', 'fetch', 'eventsource', 'websocket', 'manifest', 'other']),
    category: z.enum(['response', 'request-failed', 'page-error']).optional() }),
  z.object({ event: z.literal('managed_history_failure'), phase: HistoryPhaseSchema.optional(), mode: HistoryModeSchema.optional(),
    callsite: HistoryCallsiteSchema.optional(), status: z.enum(['failed', 'timedOut', 'interrupted']),
    errorCategory: HistoryErrorCategorySchema, diagnosticLimitReached: z.boolean() }),
  HistoryDirectoryFactsSchema,
  z.object({ event: z.literal('managed_history_window'), mode: HistoryModeSchema, stage: HistoryWindowStageSchema,
    facts: HistoryWindowFactsSchema }),
])
type HistoryDiagnostic = z.infer<typeof HistoryDiagnosticSchema>

const OrdinaryTerminalProviderSchema = z.enum(['claude', 'codex', 'opencode'])
const OrdinaryTerminalSetupStageSchema = z.enum(['existing_panes', 'picker_open', 'provider_selection',
  'directory_dialog', 'pane_creation', 'terminal_visible', 'managed_runtime_view', 'ready'])
const OrdinaryTerminalSmokeSetupStageSchema = z.enum(['provider_definitions', 'runtime_construction', 'runtime_start',
  'browser_script', 'page_navigation', 'harness_ready', 'connection_ready', 'active_tab'])
const OrdinaryTerminalTurnStageSchema = z.enum(['attach_ready', 'turn_completion'])
const OrdinaryTerminalFactsSchema = z.object({
  available: z.boolean(), provider: OrdinaryTerminalProviderSchema.optional(),
  providerProcessPresent: z.boolean().optional(), nativeSessionIdPresent: z.boolean().optional(),
})
const ManagedViewProbeSchema = z.object({
  terminalCreateResult: z.enum(['created', 'error', 'no_reply']),
  createSent: z.boolean(), wireErrorCode: ErrorCode.optional(),
  inventoryRead: z.enum(['ok', 'failed']),
  matchingRowCount: z.number().int().nonnegative().max(10_000),
  matchingRows: z.array(z.object({
    launchState: z.enum(['prepared', 'created', 'starting', 'running', 'stopping', 'stopped', 'failed', 'unknown']),
    providerMatch: z.boolean(), containerIdPresent: z.boolean(),
  }).strict()).max(8),
}).strict()
const PaneCreationProbeSchema = z.object({
  terminalCreateResult: z.enum(['request_id_missing', 'request_not_observed', 'no_reply', 'created', 'error']),
  wireErrorCode: ErrorCode.optional(),
  inventoryRead: z.enum(['ok', 'failed']),
  matchingRowCount: z.number().int().nonnegative().max(10_000),
  matchingRows: z.array(z.object({
    launchState: z.enum(['prepared', 'created', 'starting', 'running', 'stopping', 'stopped', 'failed', 'unknown']),
    providerMatch: z.boolean(), containerIdPresent: z.boolean(),
  }).strict()).max(8),
}).strict()
const OrdinaryTerminalTurnFactsSchema = z.object({
  requestInputSeen: z.boolean(), activitySeen: z.boolean(), outputSeen: z.boolean(),
  renderedAnswerSeen: z.boolean().optional(),
  outputFrameCount: z.number().int().nonnegative().max(10000), completionSeen: z.boolean(),
  completionSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  completionOutcome: z.enum(['completed', 'failed']).nullable().optional(),
})
const OrdinaryTerminalDiagnosticSchema = z.discriminatedUnion('event', [
  z.object({ severity: z.literal('error'), event: z.literal('durable_souls.pane_creation_probe'),
    lane: z.literal('terminal'), provider: z.literal('codex'), probe: PaneCreationProbeSchema }).strict(),
  z.object({ event: z.literal('durable_souls.managed_view_probe'), lane: z.literal('terminal'),
    provider: z.literal('codex'), probe: ManagedViewProbeSchema }),
  z.object({ event: z.literal('durable_souls.ordinary_turn_completed'), lane: z.literal('terminal'),
    provider: OrdinaryTerminalProviderSchema }),
  z.object({ event: z.literal('durable_souls.ordinary_setup_failed'), lane: z.literal('terminal'),
    stage: OrdinaryTerminalSmokeSetupStageSchema }),
  z.object({ event: z.literal('durable_souls.ordinary_turn_failed'), lane: z.literal('terminal'),
    provider: OrdinaryTerminalProviderSchema, paneSetupFailureStage: OrdinaryTerminalSetupStageSchema.nullable().optional(),
    ordinaryTurnFailureStage: OrdinaryTerminalTurnStageSchema.nullable().optional(),
    terminalFacts: OrdinaryTerminalFactsSchema.optional(), ordinaryTurnFacts: OrdinaryTerminalTurnFactsSchema.nullable().optional() }),
])
const OrdinaryFreshModeSchema = z.enum(['freshclaude', 'freshcodex', 'freshopencode'])
const OrdinaryFreshStageSchema = z.enum(['creating', 'pane_created', 'waiting_for_composer', 'filling_composer',
  'pressing_enter', 'waiting_for_send_frame', 'completed'])
const OrdinaryFreshProviderFailureCodeSchema = z.enum(['FRESH_AGENT_CREATE_FAILED', 'FRESH_AGENT_PROVIDER_START_FAILED'])
const OrdinaryFreshProviderStartupDiagnosticSchema = z.enum(['authentication', 'arguments', 'listener',
  'configuration', 'network', 'unclassified', 'no-diagnostic', 'none'])
const OrdinaryFreshCountSchema = z.number().int().nonnegative().max(10000)
const OrdinaryFreshProviderEventsSchema = z.object({
  counts: z.object({ created: OrdinaryFreshCountSchema, createFailed: OrdinaryFreshCountSchema,
    assistant: OrdinaryFreshCountSchema, stream: OrdinaryFreshCountSchema, error: OrdinaryFreshCountSchema,
    snapshot: OrdinaryFreshCountSchema, changed: OrdinaryFreshCountSchema, turnComplete: OrdinaryFreshCountSchema,
    result: OrdinaryFreshCountSchema }),
  createFailureCodes: z.array(OrdinaryFreshProviderFailureCodeSchema).max(8),
  createFailureDiagnostics: z.array(OrdinaryFreshProviderStartupDiagnosticSchema).max(8),
  errorCodePresent: z.boolean(), errorMessagePresent: z.boolean(),
})
const OrdinaryFreshReadinessSchema = z.object({
  paneFound: z.boolean(),
  paneStatus: z.enum(['idle', 'creating', 'starting', 'connected', 'running', 'busy', 'create-failed', 'exited', 'stuck', 'missing', 'other']),
  sessionStatePresent: z.boolean(),
  sessionStatus: z.enum(['creating', 'starting', 'connected', 'running', 'idle', 'compacting', 'exited', 'stuck', 'create-failed', 'missing', 'other']),
  attachTargetsPaneSession: z.boolean(),
  composerPresent: z.boolean(),
  composerDisabled: z.boolean().nullable(),
  composerVisible: z.boolean(),
  composerFocused: z.boolean(),
  composerHasInput: z.boolean(),
  connectionStatus: z.enum(['disconnected', 'connecting', 'connected', 'ready', 'missing', 'other']),
  networkEffectsSuppressed: z.boolean(),
})
const OrdinaryFreshDiagnosticSchema = z.union([
  z.object({ event: z.literal('durable_souls.ordinary_turn_completed'), lane: z.literal('fresh-agent'),
    mode: OrdinaryFreshModeSchema }),
  z.object({ event: z.literal('durable_souls.ordinary_turn_failed'), lane: z.literal('fresh-agent'),
    mode: OrdinaryFreshModeSchema, stage: OrdinaryFreshStageSchema,
    createCompleted: z.boolean(), composerFilled: z.boolean(), assistantBaselineCaptured: z.boolean(),
    composerSubmitted: z.boolean(), sendObserved: z.boolean(), turnCompleteObserved: z.boolean(), assistantTextDisplayed: z.boolean(),
    assistantDom: z.object({ available: z.boolean(), rows: OrdinaryFreshCountSchema, textCharacters: OrdinaryFreshCountSchema }),
    providerEvents: OrdinaryFreshProviderEventsSchema,
    readiness: OrdinaryFreshReadinessSchema.nullable().optional() }),
])
type ManagedOrdinaryDiagnostic = z.infer<typeof OrdinaryTerminalDiagnosticSchema> | z.infer<typeof OrdinaryFreshDiagnosticSchema>

const ORDINARY_TERMINAL_SPEC = 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts'
const ORDINARY_TERMINAL_TITLE = 'each selected terminal provider completes one ordinary turn'
const ORDINARY_FRESH_AGENT_SPEC = 'test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts'
const ORDINARY_FRESH_AGENT_TITLE = 'each selected fresh-agent mode completes one ordinary turn'
type OrdinaryTurnTarget = { file: string; lane: 'terminal' | 'fresh-agent' }

function matchesOrdinaryTest(test: TestCase, file: string, title: string): boolean {
  const normalizedFile = test.location.file.replaceAll('\\', '/')
  return test.title === title && (normalizedFile === file || normalizedFile.endsWith(`/${file}`))
}

function ordinaryTurnTarget(test: TestCase): OrdinaryTurnTarget | undefined {
  if (matchesOrdinaryTest(test, ORDINARY_TERMINAL_SPEC, ORDINARY_TERMINAL_TITLE)) {
    return { file: ORDINARY_TERMINAL_SPEC, lane: 'terminal' }
  }
  if (matchesOrdinaryTest(test, ORDINARY_FRESH_AGENT_SPEC, ORDINARY_FRESH_AGENT_TITLE)) {
    return { file: ORDINARY_FRESH_AGENT_SPEC, lane: 'fresh-agent' }
  }
  return undefined
}

/** Parse only bounded, body-free observations from the two ordinary-turn smoke specs. */
export function parseManagedOrdinaryTurnDiagnosticText(text: string): ManagedOrdinaryDiagnostic[] {
  const events: ManagedOrdinaryDiagnostic[] = []
  for (const line of text.split('\n')) {
    if (line.length > 8192) continue
    const offset = line.indexOf('{')
    if (offset < 0) continue
    try {
      const raw: unknown = JSON.parse(line.slice(offset))
      const terminal = OrdinaryTerminalDiagnosticSchema.safeParse(raw)
      if (terminal.success) { events.push(terminal.data); continue }
      const fresh = OrdinaryFreshDiagnosticSchema.safeParse(raw)
      if (fresh.success) events.push(fresh.data)
    } catch { /* unrelated or truncated display line */ }
  }
  return events
}

function historyDirectoryIssues(issues: readonly z.ZodIssue[]): NonNullable<z.infer<typeof HistoryDirectoryFactsSchema>['issues']> {
  return issues.slice(0, 8).map(issue => {
    const code = HistoryIssueCodeSchema.safeParse(issue.code)
    return { code: code.success ? code.data : 'other', path: issue.path.length ? issue.path.slice(0, 6).map((part, index) => {
      if (typeof part === 'number') return 'index'
      if (index === 0 && (part === 'items' || part === 'contextUsageExtras' || part === 'integrityError')) return part
      return 'field'
    }) : ['root'] }
  })
}

function historyCallsite(location?: { file: string; line: number; column: number }): z.infer<typeof HistoryCallsiteSchema> | undefined {
  if (!location) return undefined
  const file = location.file.replaceAll('\\', '/').match(/test\/e2e-browser\/(?:specs|helpers)\/[a-zA-Z0-9_.-]+\.ts$/)?.[0]
  const parsed = HistoryCallsiteSchema.safeParse({ ...location, file })
  return parsed.success ? parsed.data : undefined
}

function historyErrorCategory(error: unknown): z.infer<typeof HistoryErrorCategorySchema> {
  return error instanceof Error && (error.name === 'TimeoutError' || /timed?\s*out|timeout/i.test(error.message)) ? 'timeout'
    : error instanceof Error && /closed|interrupted|abort/i.test(error.message) ? 'interrupted' : 'operation-error'
}

/** Observe original awaits without adding a deadline, cancellation or retry. */
export class ManagedHistoryAwaitedPhases {
  private emitted = 0
  constructor(private readonly emit: (line: string) => void = line => { process.stdout.write(line) }) {}
  private record(event: HistoryDiagnostic): void {
    if (this.emitted++ >= 256) return
    const parsed = HistoryDiagnosticSchema.safeParse(event)
    if (parsed.success) emitExternalDiagnostic('client', () => this.emit(`${HISTORY_DIAGNOSTIC_PREFIX}${JSON.stringify(parsed.data)}\n`))
  }
  async run<T>(phase: z.infer<typeof HistoryPhaseSchema>, mode: z.infer<typeof HistoryModeSchema>, operation: () => T | Promise<T>): Promise<T> {
    const location = new Error().stack?.split('\n').filter(line => !/\bat phase\b/.test(line))
      .map(line => line.match(/(test\/e2e-browser\/(?:specs|helpers)\/[a-zA-Z0-9_.-]+\.ts):(\d+):(\d+)/)).find(Boolean)
    const callsite = location ? historyCallsite({ file: location[1], line: Number(location[2]), column: Number(location[3]) }) : undefined
    this.record({ event: 'managed_history_phase', phase, mode, state: 'begin', callsite })
    try {
      const value = await operation()
      this.record({ event: 'managed_history_phase', phase, mode, state: 'end', callsite })
      return value
    } catch (error) {
      this.record({ event: 'managed_history_phase', phase, mode, state: 'failed', callsite, errorCategory: historyErrorCategory(error) })
      throw error
    }
  }
  navigation(facts: Omit<Extract<HistoryDiagnostic, { event: 'managed_history_navigation' }>, 'event'>): void {
    this.record({ event: 'managed_history_navigation', ...facts })
  }
  directory(facts: Omit<z.infer<typeof HistoryDirectoryFactsSchema>, 'event'>): void {
    this.record({ event: 'managed_history_directory', ...facts })
  }
  window(mode: z.infer<typeof HistoryModeSchema>, stage: ManagedHistoryWindowStage, facts: ManagedHistoryWindowFacts): void {
    this.record({ event: 'managed_history_window', mode, stage, facts })
  }
}

/** Passive, locally correlated reads of the requests already made by History. */
export class ManagedHistoryDirectoryResponses {
  private readonly requests = new Map<Request, number>()
  private readonly pending = new Set<Promise<void>>()
  private sequence = 0
  private order = 0
  private closed = false
  private timer?: ReturnType<typeof setTimeout>
  private release!: () => void
  private readonly closing = new Promise<undefined>(resolve => { this.release = () => resolve(undefined) })
  constructor(private readonly page: Page, private readonly observation: ManagedHistoryAwaitedPhases,
    private readonly mode: z.infer<typeof HistoryModeSchema>,
    private readonly identity: { provider: string; nativeSessionId: string; repoRoot: string }) {
    try { page.on('request', this.request) } catch { /* unavailable page */ }
    try { page.on('response', this.response) } catch { /* unavailable page */ }
    try { page.on('requestfailed', this.failed) } catch { /* unavailable page */ }
  }
  begin(deadline: number): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.close().catch(() => {}) }, Math.max(0, deadline - Date.now()))
  }
  private record(facts: Omit<z.infer<typeof HistoryDirectoryFactsSchema>, 'event' | 'mode' | 'order'>): void {
    try { this.observation.directory({ ...facts, mode: this.mode, order: ++this.order }) } catch { /* diagnostics cannot affect the case */ }
  }
  private readonly request = (request: Request): void => {
    if (this.closed || this.sequence >= 8) return
    try {
      const url = new URL(request.url())
      if (url.pathname !== '/api/session-directory') return
      const query = url.searchParams, limit = Number(query.get('limit'))
      const requestSeq = ++this.sequence
      this.requests.set(request, requestSeq)
      this.record({ requestSeq, stage: 'request', route: 'session-directory',
        method: request.method() === 'GET' ? 'GET' : request.method() === 'POST' ? 'POST' : 'other',
        query: { queryEmpty: !(query.get('query') ?? '').trim(), tier: !query.has('tier') || query.get('tier') === 'title' ? 'title' : 'other',
          limit: Number.isSafeInteger(limit) && limit > 0 && limit <= 10000 ? limit : undefined,
          includeSubagents: ['1', 'true'].includes(query.get('includeSubagents') ?? ''),
          includeNonInteractive: ['1', 'true'].includes(query.get('includeNonInteractive') ?? ''),
          includeEmpty: ['1', 'true'].includes(query.get('includeEmpty') ?? ''),
          includeKeysCount: Math.min(10000, query.get('includeKeys')?.split(',').filter(Boolean).length ?? 0) } })
    } catch { /* unavailable request facts remain unknown */ }
  }
  private readonly failed = (request: Request): void => {
    const requestSeq = this.requests.get(request)
    if (this.closed || !requestSeq) return
    this.requests.delete(request)
    let aborted = false
    try { aborted = /abort/i.test(request.failure()?.errorText ?? '') } catch { /* no raw failure retention */ }
    this.record({ requestSeq, stage: 'failed', category: aborted ? 'aborted' : 'transport-failed' })
  }
  private readonly response = (response: BrowserResponse): void => {
    if (this.closed) return
    try {
      const request = response.request(), requestSeq = this.requests.get(request)
      if (!requestSeq) return
      const status = response.status()
      this.requests.delete(request)
      this.record({ requestSeq, stage: 'response', status, category: status < 200 || status >= 300 ? 'http-error' : undefined })
      if (status < 200 || status >= 300) return
      this.track(async () => {
        let facts: Omit<z.infer<typeof HistoryDirectoryFactsSchema>, 'event' | 'mode' | 'order'> = { requestSeq, stage: 'body', status, category: 'unknown' }
        try {
          // The race joins our observation at the original action deadline or
          // cleanup. A still-running browser transport has no asserted result.
          const body = await Promise.race([response.body(), this.closing])
          if (body !== undefined) {
            if (body.length > 131072) facts.category = 'body-limit'
            else {
              let input: unknown
              try { input = JSON.parse(body.toString('utf8')) } catch { /* validate non-JSON as an invalid page */ }
              const parsed = SessionDirectoryPageSchema.safeParse(input)
              if (!parsed.success) facts = { requestSeq, stage: 'body', status, parseSuccess: false,
                issues: historyDirectoryIssues(parsed.error.issues) }
              else {
                const data = parsed.data, exact = data.items.filter(item => item.provider === this.identity.provider && item.sessionId === this.identity.nativeSessionId)
                facts = { requestSeq, stage: 'body', status, parseSuccess: true, itemCount: data.items.length, exactIdentityCount: exact.length,
                  nextCursorPresent: data.nextCursor !== null, partial: data.partial, integrity: data.integrityError?.kind ?? 'none', snapshotSeq: data.snapshotSeq,
                  ownedContext: exact.slice(0, 8).map(item => ({ projectMatches: item.projectPath === this.identity.repoRoot,
                    cwdMatches: item.cwd === undefined ? undefined : item.cwd === this.identity.repoRoot,
                    checkoutMatches: item.checkoutPath === undefined ? undefined : item.checkoutPath === this.identity.repoRoot })) }
              }
            }
          }
        } catch { facts.category = 'body-unavailable' }
        this.record(facts)
      })
    } catch { /* unavailable response metadata cannot affect the request */ }
  }
  private track(operation: () => Promise<void>): void {
    const work = operation().catch(() => {}).finally(() => { this.pending.delete(work) })
    this.pending.add(work)
  }
  window(stage: ManagedHistoryWindowStage, facts: ManagedHistoryWindowFacts): void {
    try { this.observation.window(this.mode, stage, facts) } catch { /* preserve original result */ }
  }
  captureWindow(stage: ManagedHistoryWindowStage, read: () => Promise<ManagedHistoryWindowFacts>): void {
    if (this.closed || this.pending.size >= 13) { this.window(stage, { available: false }); return }
    this.track(async () => {
      let facts: ManagedHistoryWindowFacts = { available: false }
      try { facts = await Promise.race([read(), this.closing]) ?? facts } catch { /* report unknown without the error */ }
      this.window(stage, facts)
    })
  }
  async settle(): Promise<void> { await Promise.all([...this.pending]) }
  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      clearTimeout(this.timer)
      try { this.page.off('request', this.request) } catch { /* unavailable page */ }
      try { this.page.off('response', this.response) } catch { /* unavailable page */ }
      try { this.page.off('requestfailed', this.failed) } catch { /* unavailable page */ }
      for (const requestSeq of this.requests.values()) this.record({ requestSeq, stage: 'failed', category: 'unknown' })
      this.requests.clear()
      this.release()
    }
    await this.settle()
  }
}

/** Parse only the bounded body-free text emitted by the original reporter. */
export function parseManagedHistoryDiagnosticText(text: string): Array<HistoryDiagnostic & { runId?: string; candidateSha?: string; id?: string }> {
  const events: Array<HistoryDiagnostic & { runId?: string; candidateSha?: string; id?: string }> = []
  for (const line of text.split('\n')) {
    const offset = line.indexOf(HISTORY_DIAGNOSTIC_PREFIX)
    if (offset < 0 || line.length > 8192) continue
    try {
      const parsed = HistoryDiagnosticSchema.and(z.object({ runId: z.string().uuid().optional(),
        candidateSha: z.string().regex(/^[a-f0-9]{40}$/).optional(), id: z.string().max(256).optional() })).safeParse(JSON.parse(line.slice(offset + HISTORY_DIAGNOSTIC_PREFIX.length)))
      if (parsed.success) events.push(parsed.data)
    } catch { /* unrelated or truncated display line */ }
  }
  return events
}

/** Body-free execution observations travel through the exact Cloud execution log. */
export default class ManagedExternalExecutionReporter implements Reporter {
  private cases = 0
  private readonly descriptor = resolveManagedExternalDescriptor(process.env)
  private readonly history = new Map<string, { buffer: string; count: number; active?: Extract<HistoryDiagnostic, { event: 'managed_history_phase' }>; callsite?: z.infer<typeof HistoryCallsiteSchema> }>()
  private readonly ordinaryTurns = new Map<string, { buffer: string; stderrBuffer: string; count: number }>()

  printsToStdio(): boolean { return true }
  private emit(event: Record<string, unknown>): void {
    if (!this.descriptor) throw new Error('external execution reporter requires its owned descriptor')
    process.stdout.write(`${JSON.stringify({ severity: 'info', runId: this.descriptor.runId,
      candidateSha: this.descriptor.candidateSha, ...event })}\n`)
  }
  private emitHistory(test: TestCase, event: HistoryDiagnostic): void {
    if (!this.descriptor) throw new Error('external execution reporter requires its owned descriptor')
    process.stdout.write(`${HISTORY_DIAGNOSTIC_PREFIX}${JSON.stringify({ severity: 'info',
      runId: this.descriptor.runId, candidateSha: this.descriptor.candidateSha, id: test.id, ...event })}\n`)
  }
  private forwardOrdinaryTurnText(test: TestCase, state: { buffer: string; count: number }, text: string,
    target: OrdinaryTurnTarget): void {
    for (const source of parseManagedOrdinaryTurnDiagnosticText(text)) {
      if (source.lane !== target.lane || state.count >= 16) continue
      state.count += 1
      const common = { event: 'managed_external_ordinary_turn', id: test.id, file: target.file,
        sourceEvent: source.event, outcome: source.event === 'durable_souls.ordinary_turn_completed'
          ? 'completed' : 'failed', lane: source.lane }
      if (source.event === 'durable_souls.ordinary_setup_failed') {
        this.emit({ ...common, setupFailureStage: source.stage })
      } else if (source.event === 'durable_souls.pane_creation_probe') {
        this.emit({ ...common, provider: source.provider, paneCreationProbe: source.probe })
      } else if (source.event === 'durable_souls.managed_view_probe') {
        this.emit({ ...common, provider: source.provider, managedViewProbe: source.probe })
      } else if (source.lane === 'terminal' && source.event === 'durable_souls.ordinary_turn_failed') {
        this.emit({ ...common, provider: source.provider,
          paneSetupFailureStage: source.paneSetupFailureStage ?? null,
          ordinaryTurnFailureStage: source.ordinaryTurnFailureStage ?? null,
          terminalFacts: source.terminalFacts ?? { available: false },
          ordinaryTurnFacts: source.ordinaryTurnFacts ?? null })
      } else if (source.lane === 'terminal') {
        this.emit({ ...common, provider: source.provider })
      } else if (source.event === 'durable_souls.ordinary_turn_failed') {
        this.emit({ ...common, mode: source.mode, stage: source.stage,
          createCompleted: source.createCompleted, composerFilled: source.composerFilled,
          assistantBaselineCaptured: source.assistantBaselineCaptured, composerSubmitted: source.composerSubmitted,
          sendObserved: source.sendObserved, turnCompleteObserved: source.turnCompleteObserved,
          assistantTextDisplayed: source.assistantTextDisplayed, assistantDom: source.assistantDom,
          providerEvents: source.providerEvents, ...(source.readiness ? { readiness: source.readiness } : {}) })
      } else {
        this.emit({ ...common, mode: source.mode })
      }
    }
  }
  private captureOrdinaryTurnText(test: TestCase, chunk: string | Buffer, stream: 'stdout' | 'stderr'): void {
    const target = ordinaryTurnTarget(test)
    if (!target) return

    const state = this.ordinaryTurns.get(test.id) ?? { buffer: '', stderrBuffer: '', count: 0 }
    this.ordinaryTurns.set(test.id, state)
    const key = stream === 'stdout' ? 'buffer' : 'stderrBuffer'
    state[key] = (state[key] + String(chunk)).slice(-16_384)
    const lines = state[key].split('\n')
    state[key] = lines.pop()!
    this.forwardOrdinaryTurnText(test, state, lines.join('\n'), target)
  }
  onStdOut(chunk: string | Buffer, test?: TestCase, _result?: TestResult): void {
    if (!test) return
    const fileName = path.basename(test.location.file)
    if (fileName === 'runtime-fresh-agent-fixture-rust.spec.ts') {
      const state = this.history.get(test.id) ?? { buffer: '', count: 0 }
      this.history.set(test.id, state)
      state.buffer = (state.buffer + String(chunk)).slice(-8192)
      const lines = state.buffer.split('\n')
      state.buffer = lines.pop()!
      for (const event of parseManagedHistoryDiagnosticText(lines.join('\n'))) {
        if (state.count++ >= 256) continue
        if (event.event === 'managed_history_phase') {
          if (event.state === 'begin') { state.active = event; state.callsite = event.callsite }
          else if (event.state === 'end' && state.active?.phase === event.phase && state.active.mode === event.mode) state.active = undefined
          else if (event.state === 'failed' && state.active?.phase === event.phase && state.active.mode === event.mode) state.active = event
        }
        this.emitHistory(test, event)
      }
      return
    }
    this.captureOrdinaryTurnText(test, chunk, 'stdout')
  }
  onStdErr(chunk: string | Buffer, test?: TestCase, _result?: TestResult): void {
    if (!test) return
    this.captureOrdinaryTurnText(test, chunk, 'stderr')
  }
  onStepBegin(test: TestCase, _result: TestResult, step: TestStep): void {
    const state = this.history.get(test.id)
    if (state?.active && step.category === 'pw:api') state.callsite = historyCallsite(step.location) ?? state.callsite
  }
  onTestEnd(test: TestCase, result: TestResult): void {
    const history = this.history.get(test.id)
    if (history && ['failed', 'timedOut', 'interrupted'].includes(result.status)) {
      this.emitHistory(test, { event: 'managed_history_failure', phase: history.active?.phase, mode: history.active?.mode,
        callsite: history.callsite, status: result.status as 'failed' | 'timedOut' | 'interrupted',
        errorCategory: result.status === 'timedOut' ? 'timeout' : result.status === 'interrupted' ? 'interrupted'
          : history.active?.errorCategory ?? 'operation-error', diagnosticLimitReached: history.count >= 256 })
    }
    const target = ordinaryTurnTarget(test), ordinary = this.ordinaryTurns.get(test.id)
    if (target && ordinary) {
      if (ordinary.buffer) this.forwardOrdinaryTurnText(test, ordinary, ordinary.buffer, target)
      if (ordinary.stderrBuffer) this.forwardOrdinaryTurnText(test, ordinary, ordinary.stderrBuffer, target)
      ordinary.buffer = ''
      ordinary.stderrBuffer = ''
    }
    this.history.delete(test.id)
    this.ordinaryTurns.delete(test.id)
    const file = path.basename(test.location.file)
    const titles = test.titlePath()
    const fileIndex = titles.findIndex(title => path.basename(title) === file)
    if (fileIndex < 0) throw new Error('external executed title lacks its source file')
    const source = `test/e2e-browser/specs/${file}`
    specName(source)
    this.cases += 1
    this.emit({ event: 'managed_external_case', id: test.id, file: source,
      title: titles.slice(fileIndex + 1).join(' › '), status: result.status })
  }
  onEnd(result: FullResult): void {
    this.emit({ event: 'managed_external_complete', status: result.status, cases: this.cases })
  }
}

function reportObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid Playwright machine listing')
  return value as Record<string, unknown>
}

export function parseExternalPlaywrightList(value: unknown): ExternalBrowserCase[] {
  const report = reportObject(value)
  if (!Array.isArray(report.errors) || report.errors.length || !Array.isArray(report.suites)) {
    throw new Error('Playwright machine listing is missing or failed')
  }
  const cases: ExternalBrowserCase[] = []
  const visit = (input: unknown, parents: string[]) => {
    const suite = reportObject(input)
    if (typeof suite.title !== 'string' || typeof suite.file !== 'string') throw new Error('invalid Playwright listing suite')
    const title = suite.title === suite.file ? parents : [...parents, suite.title]
    if (suite.specs !== undefined && !Array.isArray(suite.specs)) throw new Error('invalid Playwright listing specs')
    for (const inputSpec of (suite.specs ?? []) as unknown[]) {
      const spec = reportObject(inputSpec)
      if (typeof spec.id !== 'string' || !spec.id || typeof spec.title !== 'string' || !spec.title
        || typeof spec.file !== 'string' || !(EXTERNAL_MANAGED_SPEC_NAMES as readonly string[]).includes(spec.file)
        || !Array.isArray(spec.tests) || spec.tests.length !== 1) throw new Error('invalid Playwright external listing case')
      const test = reportObject(spec.tests[0])
      if (test.projectName !== 'chromium-external-target' || test.expectedStatus !== 'passed') {
        throw new Error('Playwright listing selected an unsupported project or skipped case')
      }
      cases.push({ id: spec.id, title: [...title, spec.title].join(' › '), file: `test/e2e-browser/specs/${spec.file}` })
    }
    if (suite.suites !== undefined && !Array.isArray(suite.suites)) throw new Error('invalid Playwright listing child suites')
    for (const child of (suite.suites ?? []) as unknown[]) visit(child, title)
  }
  for (const suite of report.suites) visit(suite, [])
  return cases
}

export function listExternalBrowserCases(
  selection: ExternalBrowserSelection, environment: NodeJS.ProcessEnv, execute: typeof execFileSync = execFileSync,
): ExternalBrowserCase[] {
  const env = validateSelection(selection, environment)
  if (!resolveManagedExternalDescriptor(env)) throw new Error('complete external descriptor required before Playwright listing')
  const output = execute('pnpm', [
    'exec', 'playwright', 'test', '--config', 'test/e2e-browser/playwright.cloud.config.ts',
    '--list', '--reporter=json', '--project=chromium-external-target', selection.spec,
    ...(selection.grep ? ['--grep', selection.grep] : []),
  ], {
    cwd: process.cwd(), env: {
      ...env, FRESHELL_RUNTIME_EXTERNAL_SPEC: selection.spec,
      ...(selection.grep ? { FRESHELL_RUNTIME_EXTERNAL_GREP: selection.grep } : {}),
    }, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
  })
  return parseExternalPlaywrightList(JSON.parse(output))
}

export interface ExternalBrowserLifecycle {
  start(selection: ExternalBrowserSelection): Promise<NodeJS.ProcessEnv>
  list(selection: ExternalBrowserSelection, environment: NodeJS.ProcessEnv): Promise<ExternalBrowserCase[]>
  child(command: string, args: string[], environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{
    exitCode: number; cases: ExternalBrowserCaseResult[]
  }>
  finish(): Promise<{ ok: boolean; errors: string[] }>
  publishOriginals?(selected: ExternalBrowserCase[], executed: ExternalBrowserCaseResult[]): BrowserOriginalIndex
  abort(): Promise<{ ok: boolean; errors: string[] }>
}

export function resolveManagedExternalDescriptor(env: NodeJS.ProcessEnv): ManagedExternalDescriptor | null {
  if (!EXTERNAL_DESCRIPTOR_KEYS.some((key) => env[key] !== undefined)) return null
  if (EXTERNAL_DESCRIPTOR_KEYS.some((key) => !env[key]?.trim())) throw new Error('complete owned external descriptor required')
  let http: URL
  let websocket: URL
  try {
    http = new URL(env.FRESHELL_E2E_TARGET_URL!)
    websocket = new URL(env.FRESHELL_E2E_TARGET_WS_URL!)
  } catch { throw new Error('invalid external transport descriptor') }
  if (http.protocol !== 'https:' || websocket.protocol !== 'wss:' || http.host !== websocket.host
    || http.pathname !== '/' || websocket.pathname !== '/ws'
    || [http, websocket].some((url) => url.username || url.password || url.search || url.hash)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(env.FRESHELL_RUNTIME_EXTERNAL_RUN_ID!)
    || !/^[a-f0-9]{40}$/.test(env.FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA!)) {
    throw new Error('invalid external origin, run or candidate descriptor')
  }
  return {
    baseUrl: http.origin, wsUrl: websocket.href, token: env.FRESHELL_E2E_TARGET_TOKEN!,
    runId: env.FRESHELL_RUNTIME_EXTERNAL_RUN_ID!, candidateSha: env.FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA!,
  }
}

function specName(spec: string): string {
  const prefix = 'test/e2e-browser/specs/'
  if (!spec.startsWith(prefix) || !(EXTERNAL_MANAGED_SPEC_NAMES as readonly string[]).includes(spec.slice(prefix.length))) {
    throw new Error('external browser requires an allowlisted exact spec path')
  }
  return spec.slice(prefix.length)
}

function requireOptIn(env: NodeJS.ProcessEnv, name: string): void {
  if (env[name] !== '1') throw new Error(`external browser requires ${name}=1 for this selection`)
}

function validateSelection(selection: ExternalBrowserSelection, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const name = specName(selection.spec)
  const environment = { ...env }
  if (selection.grep !== undefined) {
    if (!selection.grep) throw new Error('external grep must not be empty')
    try { new RegExp(selection.grep) } catch { throw new Error('invalid external grep selector') }
  }
  if (selection.provider !== undefined) {
    if (name !== 'runtime-managed-provider-qualification-rust.spec.ts') throw new Error('provider selector requires the managed-provider qualification spec')
    const providers = parseQualificationProviderSelection(selection.provider)
    if (providers.length !== 1) throw new Error('external provider selector must name exactly one provider')
    environment[QUALIFICATION_PROVIDER_SELECTION_ENV] = selection.provider
  }
  if (selection.mode !== undefined) {
    if (name !== 'runtime-fresh-agent-qualification-rust.spec.ts') throw new Error('mode selector requires the fresh-agent qualification spec')
    const modes = parseFreshAgentQualificationModes(selection.mode)
    if (modes.length !== 1) throw new Error('external mode selector must name exactly one mode')
    environment[FRESH_AGENT_QUALIFICATION_MODES_ENV] = selection.mode
  }
  if (selection.provider && selection.mode) throw new Error('external provider and mode selectors are mutually exclusive')
  const synthetic = selection.grep?.includes('synthetic') || selection.grep?.includes('source-to-soul') || selection.grep?.includes('restoration runbook')
  if (synthetic && (selection.provider || selection.mode)) throw new Error('native provider or mode selection cannot select a synthetic case')
  if (synthetic) requireOptIn(environment, 'FRESHELL_RUNTIME_SYNTHETIC_RESUME')
  if (name === 'runtime-fresh-agent-fixture-rust.spec.ts') requireOptIn(environment, 'FRESHELL_RUNTIME_FRESH_AGENT_FIXTURE_TEST')
  if (name === 'runtime-managed-provider-qualification-rust.spec.ts' && !synthetic) {
    requireOptIn(environment, 'FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE')
    parseQualificationProviderSelection(environment[QUALIFICATION_PROVIDER_SELECTION_ENV] ?? '')
  }
  if (name === 'runtime-fresh-agent-qualification-rust.spec.ts') {
    requireOptIn(environment, 'FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_LIVE')
    parseFreshAgentQualificationModes(environment[FRESH_AGENT_QUALIFICATION_MODES_ENV] ?? '')
  }
  if (name === 'runtime-provider-resurrection-rust.spec.ts' && !synthetic) requireOptIn(environment, 'FRESHELL_RUNTIME_PHASE3_LIVE')
  if (name === 'runtime-lost-soul-notice-rust.spec.ts') requireOptIn(environment, 'FRESHELL_RUNTIME_PHASE5_LIVE')
  if (name === 'runtime-opencode-provider-qualification-rust.spec.ts') requireOptIn(environment, 'FRESHELL_RUNTIME_OPENCODE_QUALIFICATION_LIVE')
  if (name === 'runtime-chaos-rust.spec.ts') requireOptIn(environment, 'FRESHELL_RUNTIME_PHASE5_CHAOS_LIVE')
  return environment
}

export function parseExternalBrowserArguments(args: readonly string[], env: NodeJS.ProcessEnv = process.env): ExternalBrowserSelection {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    if (!['--spec', '--grep', '--provider', '--mode'].includes(flag)
      || values.has(flag) || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error('usage: pnpm exec tsx scripts/testing/runtime-external-browser.ts --spec <managed-spec> [--grep <selector>] [--provider <provider> | --mode <mode>]')
    }
    values.set(flag, args[index + 1])
  }
  const selection: ExternalBrowserSelection = {
    spec: values.get('--spec') ?? '', grep: values.get('--grep'),
    provider: values.get('--provider') as QualifiableTerminalProvider | undefined,
    mode: values.get('--mode') as QualifiableFreshAgentMode | undefined,
  }
  validateSelection(selection, env)
  return selection
}

/** Only this closed public target and selection crosses the Cloud job boundary. */
export function externalCloudMetadata(environment: NodeJS.ProcessEnv): Record<string, string> {
  if (!resolveManagedExternalDescriptor(environment)) return {}
  const selection: ExternalBrowserSelection = {
    spec: environment.FRESHELL_RUNTIME_EXTERNAL_SPEC ?? '', grep: environment.FRESHELL_RUNTIME_EXTERNAL_GREP,
  }
  const admitted = validateSelection(selection, environment)
  const metadata: Record<string, string> = {}
  for (const key of [...EXTERNAL_DESCRIPTOR_KEYS, ...EXTERNAL_SELECTION_KEYS,
    'FRESHELL_RUNTIME_EXTERNAL_SPEC', 'FRESHELL_RUNTIME_EXTERNAL_GREP']) {
    const value = admitted[key]
    if (value !== undefined) metadata[key] = value
  }
  return metadata
}

export function assertExternalCloudJobOwned(
  observed: unknown, context: { jobName: string; runId: string; candidateSha: string },
): void {
  const parsed = z.object({ metadata: z.object({ name: z.literal(context.jobName), labels: z.object({
    'freshell-managed-run': z.literal(context.runId), 'freshell-managed-candidate': z.literal(context.candidateSha),
  }).passthrough() }).passthrough() }).passthrough().safeParse(observed)
  if (!parsed.success) throw new Error('exact owned Cloud job identity is missing or differs from this run and candidate')
}

export function assertExternalCloudJobAbsent(observed: unknown, jobName: string): void {
  const parsed = ExternalCloudJobInventorySchema.safeParse(observed)
  if (!parsed.success) throw new Error('Cloud job inventory is missing or incomplete')
  if (parsed.data.some(job => job.metadata.name === jobName)) throw new Error('exact owned Cloud job remains after cleanup')
}

const ExternalCloudJobInventorySchema = z.array(z.object({ metadata: z.object({ name: z.string().min(1) }).passthrough() }).passthrough())

type OwnedExternalCloudJob = {
  jobName: string; runId: string; candidateSha: string; project: string; region: string; account: string
}

/** Read failed cases from the exact job even when its launcher's EXIT trap already deleted it. */
export function readOwnedExternalCloudCases(context: OwnedExternalCloudJob, execute: typeof execFileSync = execFileSync) {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(context.jobName) || !z.string().uuid().safeParse(context.runId).success
    || !/^[a-f0-9]{40}$/.test(context.candidateSha)) throw new Error('exact owned Cloud observation context required')
  const query = `resource.type="cloud_run_job" AND resource.labels.job_name=${JSON.stringify(context.jobName)} AND resource.labels.location=${JSON.stringify(context.region)} AND jsonPayload.runId=${JSON.stringify(context.runId)} AND jsonPayload.candidateSha=${JSON.stringify(context.candidateSha)} AND (jsonPayload.event="managed_external_case" OR jsonPayload.event="managed_external_complete")`
  const output = execute('gcloud', ['--quiet', 'logging', 'read', query, `--project=${context.project}`,
    `--account=${context.account}`, '--format=json', '--limit=1000'], {
    encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' },
  })
  const entries = z.array(z.object({ resource: z.object({ type: z.literal('cloud_run_job'), labels: z.object({
    job_name: z.literal(context.jobName), location: z.literal(context.region),
  }).passthrough() }).passthrough(), labels: z.object({ 'run.googleapis.com/execution_name': z.string().min(1) }).passthrough(),
  jsonPayload: z.unknown() }).passthrough()).min(1).safeParse(JSON.parse(String(output)))
  if (!entries.success) throw new Error('exact owned Cloud job observations are missing or invalid')
  const executions = new Set(entries.data.map(row => row.labels['run.googleapis.com/execution_name']))
  const executionName = [...executions][0]
  if (executions.size !== 1 || !executionName.startsWith(`${context.jobName}-`)) throw new Error('Cloud observations do not belong to one exact owned execution')
  return { executionName, ...parseExternalCloudCaseObservations(entries.data.map(row => row.jsonPayload), context) }
}

export function settleExternalCloudChildOutput(exitCode: number, records: readonly Record<string, unknown>[],
  jobs: readonly OwnedExternalCloudJob[], recover = readOwnedExternalCloudCases): { exitCode: number; cases: ExternalBrowserCaseResult[] } {
  const cases = records.filter(record => record.event === 'managed_external_cloud_cases')
  const cleanup = records.filter(record => record.event === 'managed_external_job_cleanup')
  if (exitCode !== 0 && cases.length === 0) {
    if (jobs.length !== 1) throw new Error('failed Cloud observations require one exact owned job')
    const observed = recover(jobs[0])
    process.stderr.write(`${JSON.stringify({ severity: 'error', event: 'managed_external_failed_execution_observed',
      runId: jobs[0].runId, candidateSha: jobs[0].candidateSha, jobName: jobs[0].jobName,
      executionName: observed.executionName, status: observed.status, cases: observed.cases })}\n`)
    return { exitCode, cases: observed.cases }
  }
  if (cases.length !== 1 || cleanup.length !== 1 || cleanup[0].ok !== true || !Array.isArray(cases[0].cases)) {
    throw new Error('exact Cloud execution cases or verified job cleanup are missing')
  }
  return { exitCode, cases: z.array(z.object({ id: z.string().min(1), file: z.string().min(1), title: z.string().min(1),
    status: z.enum(['passed', 'failed', 'skipped', 'timedOut', 'interrupted']) }).strict()).parse(cases[0].cases) }
}

/** The launcher may vanish before its EXIT trap; cleanup remains with the owner. */
export function cleanupOwnedExternalCloudJob(context: OwnedExternalCloudJob, execute: typeof execFileSync = execFileSync): void {
  const flags = [`--project=${context.project}`, `--region=${context.region}`, `--account=${context.account}`]
  const call = (args: string[]) => execute('gcloud', ['--quiet', 'run', 'jobs', ...args, ...flags],
    { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' } })
  const inventory = (): unknown => JSON.parse(String(call(['list', '--format=json'])))
  const before = ExternalCloudJobInventorySchema.safeParse(inventory())
  if (!before.success) throw new Error('Cloud job inventory is missing or incomplete')
  if (!before.data.some(job => job.metadata.name === context.jobName)) return
  assertExternalCloudJobOwned(JSON.parse(String(call(['describe', context.jobName, '--format=json']))), context)
  const executions = z.array(z.object({ metadata: z.object({ name: z.string().min(1), labels: z.object({
    'run.googleapis.com/job': z.literal(context.jobName),
  }).passthrough() }).passthrough(), status: z.object({ completionTime: z.string().min(1).optional() }).passthrough() }).passthrough())
    .safeParse(JSON.parse(String(call(['executions', 'list', `--job=${context.jobName}`, '--format=json']))))
  if (!executions.success) throw new Error('exact owned Cloud execution inventory is missing or invalid')
  for (const execution of executions.data) {
    if (!execution.status.completionTime) call(['executions', 'cancel', execution.metadata.name])
  }
  call(['delete', context.jobName])
  assertExternalCloudJobAbsent(inventory(), context.jobName)
}

function requiredCases(selection: ExternalBrowserSelection, listed: ExternalBrowserCase[], environment: NodeJS.ProcessEnv): ExternalBrowserCase[] {
  const matched = listed.filter((row) => {
    if (row.file !== selection.spec || (selection.grep && !new RegExp(selection.grep).test(row.title))) return false
    if (!selection.grep && path.basename(selection.spec) === 'runtime-managed-provider-qualification-rust.spec.ts'
      && (selection.provider || environment.FRESHELL_RUNTIME_SYNTHETIC_RESUME !== '1')
      && /(?:^| › )synthetic (?:config-blocked exact retry|legacy retained-runtime exact retry)$/.test(row.title)) return false
    if (!selection.grep && path.basename(selection.spec) === 'runtime-provider-resurrection-rust.spec.ts'
      && environment.FRESHELL_RUNTIME_SYNTHETIC_RESUME !== '1'
      && row.title.startsWith('managed OpenCode source-to-soul resume › ')) return false
    return true
  })
  if (!matched.length) throw new Error('external browser selected zero requested cases')
  if (new Set(matched.map((row) => row.id)).size !== matched.length || matched.some((row) => !row.id || !row.title)) {
    throw new Error('invalid or duplicate selected external case identities')
  }
  if (selection.grep) {
    // Simple explicit title alternatives each require a positive match.
    // Grouped regexes remain one selector and use Playwright's exact listing.
    const patterns = /[()\\]/.test(selection.grep) ? [selection.grep] : selection.grep.split('|')
    if (patterns.some((pattern) => !matched.some((row) => new RegExp(pattern).test(row.title)))) {
      throw new Error('external browser selected zero cases for a requested title')
    }
  }
  return matched
}

export async function dispatchOwnedExternalBrowser(
  selection: ExternalBrowserSelection, environment: NodeJS.ProcessEnv, owner: ExternalBrowserLifecycle,
  signal?: AbortSignal,
): Promise<ExternalBrowserCounts> {
  const selectedEnv = validateSelection(selection, environment)
  if (selectedEnv.FRESHELL_E2E_BACKEND !== 'cloud') throw new Error('managed external browser requires its configured cloud backend')
  try {
    signal?.throwIfAborted()
    const ownedEnvironment = await owner.start(selection)
    signal?.throwIfAborted()
    const descriptor = resolveManagedExternalDescriptor(ownedEnvironment)
    if (!descriptor) throw new Error('owner did not publish its complete external descriptor')
    const env = {
      ...selectedEnv, ...ownedEnvironment,
      FRESHELL_RUNTIME_EXTERNAL_SPEC: selection.spec,
      ...(selection.grep ? { FRESHELL_RUNTIME_EXTERNAL_GREP: selection.grep } : {}),
    }
    const selected = requiredCases(selection, await owner.list(selection, env), env)
    signal?.throwIfAborted()
    const child = await owner.child('pnpm', [
      'run', 'test:e2e', '--project=chromium-external-target', '--shards=1', '--workers=1', '--retries=0', '--timeout=120m',
      selection.spec, ...(selection.grep ? ['--grep', selection.grep] : []),
    ], env, ...(signal ? [signal] : []))
    signal?.throwIfAborted()
    if (child.exitCode !== 0) throw new Error('configured cloud dispatch failed')
    const results = selected.map((row) => {
      const matches = child.cases.filter((result) => result.id === row.id && result.file === row.file && result.title === row.title)
      if (matches.length !== 1) throw new Error('selected/executed external case identities differ')
      return matches[0]
    })
    const selectedIds = new Set(selected.map((row) => row.id))
    if (child.cases.some((row) => !selectedIds.has(row.id) && row.status !== 'skipped')
      || results.some((row) => row.status !== 'passed')) throw new Error('selected external cases did not all execute and pass')
    const counts: ExternalBrowserCounts = {
      selected: selected.length, executed: results.length, passed: results.length,
      failed: 0, skipped: 0, timedOut: 0,
    }
    const cleanup = await owner.finish()
    if (!cleanup.ok || cleanup.errors.length) throw new Error('owned external cleanup failed')
    if (owner.publishOriginals) counts.originals = [owner.publishOriginals(selected, results)]
    return counts
  } catch (error) {
    let cleanup: { ok: boolean; errors: string[] }
    try { cleanup = await owner.abort() }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'external browser and owned abort failed') }
    if (!cleanup.ok || cleanup.errors.length) throw new AggregateError([error], 'external browser failed and owned cleanup failed')
    throw error
  }
}

async function probeExternalManagedWebsocket(descriptor: ManagedExternalDescriptor): Promise<void> {
  const socket = new WebSocket(descriptor.wsUrl, { headers: { Origin: descriptor.baseUrl, 'x-auth-token': descriptor.token } })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('owned external websocket readiness timed out')), 10_000)
      const settle = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve() }
      socket.once('error', () => settle(new Error('owned external websocket transport failed')))
      socket.once('close', () => settle(new Error('owned external websocket closed before readiness')))
      socket.once('open', () => socket.send(JSON.stringify({ type: 'hello', token: descriptor.token,
        protocolVersion: WS_PROTOCOL_VERSION, capabilities: { managedRuntimeV1: true, paneReconcileV1: true } })))
      socket.on('message', input => {
        let value: unknown
        try { value = JSON.parse(String(input)) } catch { return }
        const frame = z.object({ type: z.literal('ready'), buildId: z.literal(descriptor.candidateSha),
          capabilities: z.object({ managedRuntimeV1: z.literal(true) }).passthrough() }).passthrough().safeParse(value)
        if (frame.success) settle()
      })
    })
  } finally { socket.terminate() }
}

async function verifyExternalManagedTransport(descriptor: ManagedExternalDescriptor): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      const server = await fetch(`${descriptor.baseUrl}/api/server-info`, {
        headers: { 'x-auth-token': descriptor.token, Origin: descriptor.baseUrl }, signal: AbortSignal.timeout(5000),
      })
      if (!server.ok) throw new Error('owned external authenticated HTTP refused')
      validateManagedWebProvenance(await server.json(), descriptor.candidateSha, false)
      const unauthenticated = await fetch(`${descriptor.baseUrl}/api/server-info`, { signal: AbortSignal.timeout(5000) })
      if (unauthenticated.status !== 401) throw new Error('owned external unauthenticated HTTP was not refused')
      const foreign = await fetch(`${descriptor.baseUrl}/api/server-info`, { headers: {
        'x-auth-token': descriptor.token, Origin: 'https://unowned.invalid',
      }, signal: AbortSignal.timeout(5000) })
      if (foreign.status !== 403) throw new Error('owned external foreign Origin was not refused')
      await probeExternalManagedWebsocket(descriptor)
      return
    } catch { await delay(500) }
  }
  throw new Error('owned HTTPS/WSS provenance and admission readiness failed')
}

function tabsCaseSelections(selection: ExternalBrowserSelection): Array<ExternalBrowserSelection & { grep: string }> {
  const fullTitles = TABS_CASE_TITLES.map(title => `Phase 4 managed-runtime tab rehydration › ${title}`)
  const selected = TABS_CASE_TITLES.filter((_title, index) => !selection.grep || new RegExp(selection.grep).test(fullTitles[index]))
  if (!selected.length) throw new Error('external browser selected zero requested tabs cases')
  if (selection.grep) {
    const patterns = /[()\\]/.test(selection.grep) ? [selection.grep] : selection.grep.split('|')
    if (patterns.some(pattern => !fullTitles.some(title => new RegExp(pattern).test(title)))) {
      throw new Error('external browser selected zero cases for a requested tabs title')
    }
  }
  return selected.map(title => ({ ...selection, grep: title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }))
}

function selectsSyntheticSource(selection: ExternalBrowserSelection, environment: NodeJS.ProcessEnv): boolean {
  const title = 'managed OpenCode source-to-soul resume › imports only the selected synthetic conversation and reopens under its native ID'
  return path.basename(selection.spec) === 'runtime-provider-resurrection-rust.spec.ts'
    && environment.FRESHELL_RUNTIME_SYNTHETIC_RESUME === '1'
    && (!selection.grep || new RegExp(selection.grep).test(title))
}

function selectsStoppedRepairBatch(selection: ExternalBrowserSelection, environment: NodeJS.ProcessEnv): boolean {
  if (path.basename(selection.spec) !== 'runtime-provider-resurrection-rust.spec.ts' || !selection.grep) return false
  const selector = new RegExp(selection.grep)
  if (!selector.test('stopped nine-soul restoration runbook')) return false
  requireOptIn(environment, 'FRESHELL_RUNTIME_SYNTHETIC_RESUME')
  if (selection.provider || selection.mode || selectsSyntheticSource(selection, environment)
    || selector.test('Phase 3 provider resurrection › P3-G10: pending native approval survives exact provider resurrection')) {
    throw new Error('stopped repair batch requires a separate exact fixture registration')
  }
  return true
}

function selectsPhase3Approval(selection: ExternalBrowserSelection, environment: NodeJS.ProcessEnv): boolean {
  const title = 'Phase 3 provider resurrection › P3-G10: pending native approval survives exact provider resurrection'
  return path.basename(selection.spec) === 'runtime-provider-resurrection-rust.spec.ts'
    && environment.FRESHELL_RUNTIME_PHASE3_LIVE === '1'
    && (!selection.grep || new RegExp(selection.grep).test(title))
}

function qualificationSelections(selection: ExternalBrowserSelection, environment: NodeJS.ProcessEnv, retainedArtifacts: boolean) {
  const spec = path.basename(selection.spec)
  let providers = selection.provider ? parseQualificationProviderSelection(selection.provider) : []
  if (!selection.provider && !selection.mode && !retainedArtifacts && spec === 'runtime-managed-provider-qualification-rust.spec.ts') {
    requireOptIn(environment, 'FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE')
    providers = parseQualificationProviderSelection(environment[QUALIFICATION_PROVIDER_SELECTION_ENV] ?? '')
  }
  let modes = selection.mode ? parseFreshAgentQualificationModes(selection.mode) : []
  if (!selection.mode && !selection.provider && !retainedArtifacts && spec === 'runtime-fresh-agent-qualification-rust.spec.ts') {
    requireOptIn(environment, 'FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_LIVE')
    modes = parseFreshAgentQualificationModes(environment[FRESH_AGENT_QUALIFICATION_MODES_ENV] ?? '')
  }
  return { providers, modes }
}

/** Preserve the existing fixed permission and observable-recovery preset on the owned web. */
export function createExternalManagedWebFactory(selection: ExternalBrowserSelection, environment: NodeJS.ProcessEnv,
  webFactory: RuntimeWebFactory, retainedArtifacts = false): RuntimeWebFactory {
  const preset: Record<string, string> = selectsPhase3Approval(selection, environment) ? {
    FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION: 'ask', FRESHELL_MANAGED_RECOVERY_TEST_DELAY_MS: '7000',
  } : {}
  const spec = path.basename(selection.spec)
  const selected = qualificationSelections(selection, environment, retainedArtifacts)
  const selectedFreshOpenCode = spec === 'runtime-fresh-agent-qualification-rust.spec.ts'
    && selected.modes.includes('freshopencode') && !retainedArtifacts
  const selectedFreshOpenCodeOrdinaryTurn = selectedFreshOpenCode
    && selection.grep === 'each selected fresh-agent mode completes one ordinary turn$'
  const preservedFreshOpenCodeReferenceKeys = new Set<string>(
    selectedFreshOpenCodeOrdinaryTurn ? OPENCODE_ONECLI_REFERENCE_KEYS : [],
  )
  const selectedFreshOpenCodeReferences = Object.fromEntries([...preservedFreshOpenCodeReferenceKeys].map(key => {
    const value = environment[key]?.trim()
    if (!value) throw new Error('FreshOpenCode ordinary-turn selection requires ENV, AUTH, and CA OneCLI grant references')
    return [key, value]
  }))
  Object.assign(preset, selectedFreshOpenCodeReferences)
  const freshBootstrap = new Set<string>(selected.modes.filter(mode => mode !== 'freshopencode').map(mode => mode === 'freshcodex' ? 'CODEX' : 'CLAUDE'))
  const unselectedFreshBootstrap = !retainedArtifacts && spec === 'runtime-fresh-agent-qualification-rust.spec.ts'
    ? ['CLAUDE', 'CODEX', 'OPENCODE', 'AMPLIFIER'].filter(provider => !freshBootstrap.has(provider)
      && !(provider === 'OPENCODE' && preservedFreshOpenCodeReferenceKeys.size > 0)).map(provider => `FRESHELL_MANAGED_${provider}_`) : []
  const claudeStartup = !retainedArtifacts && spec === 'runtime-managed-provider-qualification-rust.spec.ts'
    && selected.providers.includes('claude')
  const amplifierProfile = !retainedArtifacts && spec === 'runtime-managed-provider-qualification-rust.spec.ts'
    && selected.providers.includes('amplifier')
    ? readAmplifierQualificationProfile(environment) : undefined
  const continuityTitle = 'Phase 2 managed runtime continuity › P2-G04: OpenAI-authenticated OpenCode tool turn survives web replacement in one native session'
  if (spec === 'runtime-opencode-provider-qualification-rust.spec.ts'
    || (spec === 'runtime-terminal-continuity-rust.spec.ts' && (!selection.grep || new RegExp(selection.grep).test(continuityTitle)))) {
    const bootstrap = requireOpenCodeOnecliBootstrap(environment,
      spec === 'runtime-opencode-provider-qualification-rust.spec.ts' ? 'OpenCode provider qualification' : 'P2-G04')
    Object.assign(preset, { FRESHELL_BIND_HOST: '0.0.0.0',
      FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: bootstrap.authFile,
      FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE: bootstrap.environmentFile,
      FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE: bootstrap.caFile })
  }
  return options => {
    const env = { ...options.env, ...preset }
    const stripEnvPrefixes = new Set(options.stripEnvPrefixes ?? [])
    if (unselectedFreshBootstrap.length) {
      for (const prefix of [...unselectedFreshBootstrap, 'OPENCODE_API_KEY']) stripEnvPrefixes.add(prefix)
    }
    if (selectedFreshOpenCode) {
      if (preservedFreshOpenCodeReferenceKeys.size > 0) {
        for (const key of new Set([...Object.keys(environment), ...Object.keys(env)])) {
          if (key.startsWith('FRESHELL_MANAGED_OPENCODE_') && !preservedFreshOpenCodeReferenceKeys.has(key)) stripEnvPrefixes.add(key)
        }
      } else {
        stripEnvPrefixes.add('FRESHELL_MANAGED_OPENCODE_')
      }
      for (const prefix of [
        'ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'OPENCODE_API_KEY', 'GEMINI_', 'GOOGLE_API_KEY', 'LUNAROUTE_', 'ONECLI_',
        'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
      ]) stripEnvPrefixes.add(prefix)
      if (!freshBootstrap.has('CLAUDE')) stripEnvPrefixes.add('FRESHELL_MANAGED_CLAUDE_')
      if (!freshBootstrap.has('CODEX')) stripEnvPrefixes.add('FRESHELL_MANAGED_CODEX_')
      stripEnvPrefixes.add('FRESHELL_MANAGED_AMPLIFIER_')
    }
    return webFactory({ ...options, env, ...(stripEnvPrefixes.size ? { stripEnvPrefixes: [...stripEnvPrefixes] } : {}),
      ...(amplifierProfile || claudeStartup ? { setupHome: async (home: string) => {
        await options.setupHome?.(home)
        if (amplifierProfile) stageAmplifierQualificationProfile(amplifierProfile, home)
        if (claudeStartup) {
          const directory = path.join(home, '.claude')
          await fsp.mkdir(directory, { recursive: true, mode: 0o700 })
          await fsp.writeFile(path.join(directory, '.claude.json'), ownedClaudeStartupPreferences([options.repoRoot]), { mode: 0o600 })
        }
      } } : {}),
    })
  }
}

function selectsInterruptedOrdinaryStop(selection: ExternalBrowserSelection, environment: NodeJS.ProcessEnv): boolean {
  if (path.basename(selection.spec) !== 'runtime-terminal-continuity-rust.spec.ts') return false
  const selector = selection.grep ? new RegExp(selection.grep) : undefined
  const title = 'Phase 2 managed runtime continuity › synthetic interrupted ordinary Stop preserves history'
  if (selector ? !selector.test(title) : environment.FRESHELL_RUNTIME_SYNTHETIC_RESUME !== '1') return false
  requireOptIn(environment, 'FRESHELL_RUNTIME_SYNTHETIC_RESUME')
  if (!selector || [
    'Phase 2 managed runtime continuity › P2-G01: real browser shell survives ten graceful/abrupt web replacements',
    'Phase 2 managed runtime continuity › P2-G04: OpenAI-authenticated OpenCode tool turn survives web replacement in one native session',
  ].some(other => selector.test(other))) throw new Error('interrupted Stop requires a separate owned fixture registration')
  return true
}

/** One owner registration for the selected browser case, with its existing fixed presets. */
export function createExternalManagedRuntimeOwner(root: string, selection: ExternalBrowserSelection,
  environment: NodeJS.ProcessEnv, webFactory: RuntimeWebFactory, retainedArtifacts = false): ManagedRuntimeOwner {
  const fixture = path.basename(selection.spec) === 'runtime-fresh-agent-fixture-rust.spec.ts'
  const smoke = path.basename(selection.spec) === 'runtime-external-target-smoke-rust.spec.ts'
  const tabs = path.basename(selection.spec) === 'runtime-tabs-rehydrate-rust.spec.ts'
  const tabsCases = tabs ? tabsCaseSelections(selection) : []
  if (tabs && tabsCases.length !== 1) throw new Error('tabs cases require separate owned registrations')
  const history = tabs && new RegExp(tabsCases[0].grep).test(TABS_CASE_TITLES[0])
  const interruptedStop = selectsInterruptedOrdinaryStop(selection, environment)
  const stoppedRepairBatch = selectsStoppedRepairBatch(selection, environment)
  const deterministic = fixture || smoke || history || interruptedStop || stoppedRepairBatch
  const sourceSelection = selectsSyntheticSource(selection, environment)
  const selected = qualificationSelections(selection, environment, retainedArtifacts)
  const modes = fixture ? ['freshclaude', 'kilroy', 'freshcodex', 'freshopencode'] : smoke ? ['freshopencode'] : history || interruptedStop ? ['freshcodex'] : selected.modes
  const providers = deterministic || modes.length ? [] : selected.providers.length ? selected.providers : ['opencode']
  const providerSettings = !retainedArtifacts && path.basename(selection.spec) === 'runtime-managed-provider-qualification-rust.spec.ts'
    ? { ...(selected.providers.includes('claude') ? { claude: { model: 'haiku', effort: 'low' } } : {}),
      ...(selected.providers.includes('codex') ? { codex: { model: 'gpt-5.6-luna', effort: 'low' } } : {}) } : {}
  const phase = deterministic ? 3 : selected.providers.length || modes.length ? 5
    : path.basename(selection.spec).includes('resurrection') ? 3
      : path.basename(selection.spec).includes('rehydrate') ? 4
        : /chaos|lost-soul/.test(selection.spec) ? 5 : 2
  const supervisorEnv: Record<string, string> = fixture ? { FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS: '250' } : history || interruptedStop ? {
    FRESHELL_RUNTIME_HOST_COMMAND_TIMEOUT_MS: '5000', FRESHELL_RUNTIME_FRESH_AGENT_COMMAND_TIMEOUT_MS: '10000',
    FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS: '60000',
  } : {}
  if (!deterministic && !retainedArtifacts && providers.includes('amplifier')) requireAmplifierOnecliBootstrap(environment)
  return new ManagedRuntimeOwner(createExternalManagedWebFactory(selection, environment, webFactory, retainedArtifacts), root, phase,
    {}, supervisorEnv, deterministic || tabs || sourceSelection || selectsPhase3Approval(selection, environment) ? 'test' : 'release', { enabledProviders: providers, freshAgentModes: modes,
      providerSettings,
      fixtureFreshAgentModes: deterministic ? modes : [] }, undefined, {
      bootstrapProviders: deterministic || retainedArtifacts ? [] : sourceSelection ? ['opencode']
        : selected.providers.length ? selected.providers : modes.length
          ? [...new Set(modes.map(mode => mode === 'freshcodex' ? 'codex' as const : mode === 'freshopencode' ? 'opencode' as const : 'claude' as const))]
          : ['claude', 'codex', 'opencode', 'amplifier'],
    })
}

/** Production lifecycle; its callbacks own only this run's local resources. */
export class ManagedExternalBrowserLifecycle implements ExternalBrowserLifecycle {
  private owner?: ManagedRuntimeOwner
  private relay?: OwnedManagedRuntimeRelay
  private tunnel?: OwnedManagedRuntimeTunnel
  private cloud?: OwnedRuntimeChild
  private cloudDiagnosticFingerprint?: string
  private descriptor?: ManagedExternalDescriptor
  private retained?: OwnedRetainedBrowserFixtures
  private cleanupSettled = false
  private receiptBefore: Record<string, string> = {}
  private readonly cloudJobs = new Map<string, OwnedExternalCloudJob>()
  constructor(private readonly repoRoot = process.cwd(), private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async start(selection: ExternalBrowserSelection): Promise<NodeJS.ProcessEnv> {
    this.cleanupSettled = false
    this.receiptBefore = this.receiptDigests()
    const root = fs.realpathSync(this.repoRoot)
    if (!fs.statSync(path.join(root, '.git')).isFile()
      || execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) {
      throw new Error('owned external candidate requires an exact clean isolated worktree')
    }
    const socket = dockerSocketPath()
    if (socket !== `/run/user/${process.getuid?.() ?? 1000}/docker.sock` || !fs.statSync(socket).isSocket()) {
      throw new Error('owned external target requires the admitted local rootless Docker socket')
    }
    process.env.DOCKER_HOST = `unix://${socket}`
    const security = JSON.parse(execFileSync('docker', ['info', '--format', '{{json .SecurityOptions}}'], { encoding: 'utf8' }))
    if (!Array.isArray(security) || !security.includes('name=rootless')) throw new Error('owned runtime Docker daemon is not rootless')
    const sourceSelection = selectsSyntheticSource(selection, this.environment)
    const stoppedRepairBatch = selectsStoppedRepairBatch(selection, this.environment)
    const retainedSelection = path.basename(selection.spec) === 'runtime-managed-provider-qualification-rust.spec.ts'
      && this.environment.FRESHELL_RUNTIME_SYNTHETIC_RESUME === '1'
    const retainedArtifacts = retainedSelection ? readRetainedArtifacts(this.environment.FRESHELL_TASK002_FIXTURE_ARTIFACT_MANIFEST,
      root, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()) : undefined
    this.owner = createExternalManagedRuntimeOwner(root, selection, this.environment, options => new ManagedRuntimeWebServer({ ...options, preserveHomeOnStop: false }, record => {
      if (!this.owner) throw new Error('owned web diagnostic sink is unavailable')
      this.owner.runtime.recordLifecycle('external.web_diagnostics', { severity: 'info', ...record })
    }), Boolean(retainedArtifacts))
    if (sourceSelection) await this.owner.prepareSyntheticOpenCodeSource()
    if (stoppedRepairBatch) await this.owner.prepareSyntheticStoppedRepairBatch()
    execFileSync('pnpm', ['run', 'build:client'], { cwd: root, stdio: 'inherit' })
    execFileSync('pnpm', ['run', 'build:tools'], { cwd: root, stdio: 'inherit' })
    await this.owner.start()
    if (retainedArtifacts) {
      const titles = { config: 'synthetic config-blocked exact retry', legacy: 'synthetic legacy retained-runtime exact retry' }
      const allowed = (['config', 'legacy'] as const).filter(id => !selection.grep || new RegExp(selection.grep).test(titles[id]))
      this.retained = new OwnedRetainedBrowserFixtures(this.owner, retainedArtifacts, allowed)
    }
    let control: ((request: unknown) => Promise<unknown>) | undefined
    this.relay = new OwnedManagedRuntimeRelay({ token: this.owner.info.token, backend: () => this.retained?.backend ?? this.owner!.info.baseUrl,
      diagnostics: { runId: this.owner.runtime.runId, candidateSha: this.owner.runtime.candidateSha,
        recordLifecycle: (event, data) => this.owner!.runtime.recordLifecycle(event, data) },
      control: async request => {
        if (!control) throw new Error('owned external controller is not admitted yet')
        return control(request)
      },
      retryResponse: this.retained ? observed => this.retained!.captureRetry(observed) : undefined,
    })
    await this.relay.start()
    this.tunnel = new OwnedManagedRuntimeTunnel(root, this.environment.FRESHELL_RUNTIME_CLOUDFLARED_BINARY,
      record => this.owner!.runtime.recordLifecycle('external.tunnel_diagnostics', {
        runId: this.owner!.runtime.runId, candidateSha: this.owner!.runtime.candidateSha, ...record }))
    await this.tunnel.start(this.relay.localUrl)
    this.relay.setOrigin(this.tunnel.baseUrl)
    this.descriptor = { baseUrl: this.tunnel.baseUrl, wsUrl: this.tunnel.wsUrl,
      token: this.owner.info.token, runId: this.owner.runtime.runId, candidateSha: this.owner.runtime.candidateSha }
    control = createExternalRuntimeControl(this.owner, this.descriptor, this.retained)
    await verifyExternalManagedTransport(this.descriptor)
    this.owner.runtime.recordLifecycle('external.transport_ready', { runId: this.descriptor.runId,
      candidateSha: this.descriptor.candidateSha, tunnel: this.tunnel.processEvidence(), web: this.owner.web.processEvidence() })
    return { FRESHELL_E2E_TARGET_URL: this.descriptor.baseUrl, FRESHELL_E2E_TARGET_WS_URL: this.descriptor.wsUrl,
      FRESHELL_E2E_TARGET_TOKEN: this.descriptor.token, FRESHELL_RUNTIME_EXTERNAL_RUN_ID: this.descriptor.runId,
      FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: this.descriptor.candidateSha }
  }
  async list(selection: ExternalBrowserSelection, environment: NodeJS.ProcessEnv): Promise<ExternalBrowserCase[]> {
    this.tunnel?.assertAlive()
    return listExternalBrowserCases(selection, environment)
  }
  async child(command: string, args: string[], environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ exitCode: number; cases: ExternalBrowserCaseResult[] }> {
    if (command !== 'pnpm' || !this.owner || !this.descriptor || !this.tunnel) throw new Error('owned Cloud dispatch is not ready')
    const manager = (this.environment.PATH ?? '').split(path.delimiter).map(directory => path.join(directory, 'pnpm')).find(file => fs.existsSync(file))
    if (!manager || execFileSync(manager, ['--version'], { encoding: 'utf8' }).trim() !== '10.34.5') throw new Error('owned dispatch requires pinned pnpm')
    this.cloud = await OwnedRuntimeChild.create(process.execPath, [fs.realpathSync(manager), ...args], this.repoRoot, environment)
    // The Cloud task retains its full two-hour envelope after image build;
    // the owner also covers build/dispatch and exact cleanup time.
    const deadline = Date.now() + 3 * 60 * 60_000
    const events = new Map<string, Record<string, unknown>>()
    while (this.cloud.alive()) {
      signal?.throwIfAborted()
      this.tunnel.assertAlive()
      if (Date.now() > deadline) throw new Error('owned Cloud browser lifetime expired')
      this.captureCloudEvents(events)
      await delay(200)
    }
    const exitCode = await this.cloud.wait()
    this.captureCloudEvents(events)
    await this.captureCloudDiagnostics()
    return settleExternalCloudChildOutput(exitCode, [...events.values()], [...this.cloudJobs.values()])
  }
  private async captureCloudDiagnostics(): Promise<void> {
    if (!this.cloud || !this.owner) return
    const output = this.cloud.output()
    const fingerprint = createHash('sha256').update(JSON.stringify(output)).digest('hex')
    if (fingerprint === this.cloudDiagnosticFingerprint) return
    const artifact = this.owner.runtime.writeArtifact('cloud-launcher-output.json', output)
    const bytes = await fsp.readFile(artifact)
    this.owner.runtime.recordLifecycle('external.cloud_diagnostics', {
      severity: 'info', artifactRef: 'cloud-launcher-output.json',
      sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
      tailLimitCharactersPerStream: 1024 * 1024,
    })
    this.cloudDiagnosticFingerprint = fingerprint
  }
  private captureCloudEvents(events: Map<string, Record<string, unknown>>): void {
    if (!this.cloud || !this.descriptor || !this.owner) return
    for (const line of this.cloud.output().stdout.split('\n')) {
      let value: unknown
      try { value = JSON.parse(line) } catch { continue }
      const parsed = z.object({ event: z.enum(['managed_external_job_reserved', 'managed_external_job_created', 'managed_external_job_execution',
        'managed_external_cloud_cases', 'managed_external_job_cleanup']), runId: z.literal(this.descriptor.runId),
        candidateSha: z.literal(this.descriptor.candidateSha) }).passthrough().safeParse(value)
      if (!parsed.success) continue
      if (parsed.data.event === 'managed_external_job_reserved') {
        const job = z.object({ jobName: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
          runId: z.literal(this.descriptor.runId), candidateSha: z.literal(this.descriptor.candidateSha),
          project: z.string().min(1), region: z.string().min(1), account: z.string().min(1) }).safeParse(parsed.data)
        if (!job.success) throw new Error('owned Cloud job reservation has invalid resource or identity context')
        this.cloudJobs.set(job.data.jobName, job.data)
      }
      const fingerprint = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex')
      if (events.has(fingerprint)) continue
      events.set(fingerprint, parsed.data)
      this.owner.runtime.recordLifecycle(parsed.data.event, parsed.data)
    }
  }
  async finish(): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = []
    for (const [name, cleanup] of [
      ['cloud child', async () => {
        if (this.cloud) {
          this.captureCloudEvents(new Map())
          await this.cloud.stop()
          this.captureCloudEvents(new Map())
          await this.captureCloudDiagnostics()
        }
      }],
      ['Cloud jobs', async () => { for (const job of this.cloudJobs.values()) cleanupOwnedExternalCloudJob(job) }],
      ['retained fixtures', async () => { await this.retained?.cancel() }],
      ['runtime', async () => { if (this.owner) { const result = await this.owner.stop(); errors.push(...result.errors) } }],
      ['tunnel', async () => { await this.tunnel?.stop() }],
      ['relay', async () => { await this.relay?.stop() }],
    ] as const) {
      try { await cleanup() } catch { errors.push(`${name} cleanup failed`) }
    }
    this.cleanupSettled = errors.length === 0
    return { ok: this.cleanupSettled, errors }
  }
  private receiptDigests(): Record<string, string> {
    const result: Record<string, string> = {}
    const targets = { ...this.environment }
    if (this.owner) for (const name of ['FRESHELL_RUNTIME_PHASE5_LOSS_RECEIPT', 'FRESHELL_RUNTIME_PHASE5_CHAOS_RECEIPT']) {
      targets[name] = path.join(this.owner.runtime.evidenceDir, 'browser', defaultReceiptFileName(name))
    }
    for (const [name, target] of Object.entries(targets)) {
      if (!name.startsWith('FRESHELL_RUNTIME_') || !name.endsWith('_RECEIPT') || !target) continue
      try {
        const stat = fs.lstatSync(target)
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16 * 1024 * 1024) {
          result[name] = createHash('sha256').update(fs.readFileSync(target)).digest('hex')
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    return result
  }
  publishOriginals(selected: ExternalBrowserCase[], executed: ExternalBrowserCaseResult[]): BrowserOriginalIndex {
    if (!this.cleanupSettled || !this.owner || !this.descriptor) throw new Error('browser originals require successful finalized owned cleanup')
    const runtime = this.owner.runtime
    const artifacts = Object.fromEntries(Object.entries(BROWSER_ORIGINAL_FILES).map(([key, file]) => {
      const target = path.join(runtime.evidenceDir, file), stat = fs.lstatSync(target)
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size === 0 || stat.size > 16 * 1024 * 1024) {
        throw new Error('browser original must be a bounded private regular file')
      }
      return [key, { path: path.relative(this.repoRoot, target), sha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex') }]
    })) as BrowserOriginalIndex['artifacts']
    const events = fs.readFileSync(runtime.lifecyclePath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    const executions = [...new Map(events.filter(row => row.event === 'managed_external_job_execution').map(row => [JSON.stringify(row.data), row.data])).values()] as any[]
    if (executions.length !== 1 || executions[0].runId !== runtime.runId || executions[0].candidateSha !== runtime.candidateSha
      || !/^sha256:[a-f0-9]{64}$/.test(executions[0].imageDigest)) throw new Error('browser original lacks exact owned Cloud image execution')
    const cleanup = JSON.parse(fs.readFileSync(path.join(runtime.evidenceDir, 'cleanup.json'), 'utf8'))
    if (cleanup.ok !== true || !Array.isArray(cleanup.errors) || cleanup.errors.length) throw new Error('browser original cleanup is not finalized successfully')
    const after = this.receiptDigests()
    return { candidateSha: runtime.candidateSha, runId: runtime.runId, runtimeImage: runtime.imageRef,
      browserImage: executions[0].imageDigest, selected, executed: executed.map(row => {
        if (row.status !== 'passed') throw new Error('browser original has unsuccessful selected execution')
        return { ...row, status: 'passed' as const }
      }), artifacts, receiptDigests: Object.fromEntries(Object.entries(after).filter(([name, digest]) => digest !== this.receiptBefore[name])) }
  }
  async abort(): Promise<{ ok: boolean; errors: string[] }> { return this.finish() }
}

export async function runExternalBrowserCli(args: readonly string[], environment: NodeJS.ProcessEnv = process.env,
  owner?: ExternalBrowserLifecycle, signal?: AbortSignal): Promise<ExternalBrowserCounts> {
  const selection = parseExternalBrowserArguments(args, environment)
  const selections = path.basename(selection.spec) === 'runtime-tabs-rehydrate-rust.spec.ts' ? tabsCaseSelections(selection) : [selection]
  const counts: ExternalBrowserCounts = { selected: 0, executed: 0, passed: 0, failed: 0, skipped: 0, timedOut: 0 }
  for (const selected of selections) {
    const result = await dispatchOwnedExternalBrowser(selected, environment,
      owner ?? new ManagedExternalBrowserLifecycle(process.cwd(), environment), signal)
    counts.selected += result.selected
    counts.executed += result.executed
    counts.passed += result.passed
    counts.failed += result.failed
    counts.skipped += result.skipped
    counts.timedOut += result.timedOut
    if (result.originals) (counts.originals ??= []).push(...result.originals)
  }
  return counts
}

// Preserve the exception chain in the existing private artifact store, never
// arbitrary child-process, request, response or environment properties.
function externalBrowserErrorDetails(error: unknown, seen = new Set<Error>()): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: 'unknown', message: String(error) }
  const details: Record<string, unknown> = { name: error.name, message: error.message, stack: error.stack }
  if (seen.has(error)) return { name: error.name, message: error.message }
  seen.add(error)
  if (error.cause !== undefined) details.cause = externalBrowserErrorDetails(error.cause, seen)
  if (error instanceof AggregateError) details.errors = error.errors.map(cause => externalBrowserErrorDetails(cause, seen))
  return details
}

export function captureExternalBrowserFailure(error: unknown, repoRoot = process.cwd()) {
  const details = externalBrowserErrorDetails(error)
  const reason = JSON.stringify(details).includes('No such image:')
    ? 'Workload image is unavailable; omit FRESHELL_RUNTIME_WORKLOAD_IMAGE_DIGEST to build an owned image.'
    : error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : 'Unknown external browser failure'
  let diagnosticPath: string | undefined
  emitExternalDiagnostic('client', () => {
    diagnosticPath = new RuntimeHarness(repoRoot).writeArtifact('external-browser-failure-private.json', { error: details })
  })
  return { ...safeExternalFailure(error), reason, diagnosticPath }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const cancellation = new AbortController()
  const cancel = () => cancellation.abort(new Error('owned external run cancelled'))
  process.once('SIGTERM', cancel)
  process.once('SIGINT', cancel)
  runExternalBrowserCli(process.argv.slice(2), process.env, undefined, cancellation.signal).then(counts => {
    process.stdout.write(`${JSON.stringify({ severity: 'info', event: 'managed_external_browser_passed', counts: { selected: counts.selected, executed: counts.executed, passed: counts.passed, failed: counts.failed, skipped: counts.skipped, timedOut: counts.timedOut }, originals: counts.originals })}\n`)
  }).catch(error => {
    const failure = captureExternalBrowserFailure(error)
    emitExternalDiagnostic('client', () => process.stderr.write(`${JSON.stringify({ severity: 'error',
      event: 'managed_external_admission_or_run_failed', ...failure })}\n`))
    process.exitCode = 1
  }).finally(() => {
    process.removeListener('SIGTERM', cancel)
    process.removeListener('SIGINT', cancel)
  })
}
