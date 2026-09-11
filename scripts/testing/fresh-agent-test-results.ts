import fs from 'node:fs'

import path from 'node:path'

import {
  QUALIFIABLE_FRESH_AGENT_MODES,
  type QualifiableFreshAgentMode,
} from './fresh-agent-qualification-selection.js'

import {
  FRESH_AGENT_INGRESS_INVENTORY,
  type FreshAgentIngressId,
} from './fresh-agent-ingress-inventory.js'

const SHA256 = /^[a-f0-9]{64}$/

const MODE_CONTRACT = {
  freshclaude: {
    provider: 'claude',
    runtimeVariant: 'claude-agent-sdk',
    model: 'haiku',
    effort: 'low',
    pendingApproval: true,
  },
  kilroy: {
    provider: 'claude',
    runtimeVariant: 'kilroy-claude-agent-sdk',
    model: 'haiku',
    effort: 'low',
    pendingApproval: true,
  },
  freshcodex: {
    provider: 'codex',
    runtimeVariant: 'codex-app-server',
    model: 'gpt-5.6-luna',
    effort: 'low',
    pendingApproval: false,
  },
  freshopencode: {
    provider: 'opencode',
    runtimeVariant: 'opencode-per-soul-http',
    model: 'opencode/big-pickle',
    effort: 'provider-default',
    pendingApproval: false,
  },
} as const satisfies Record<QualifiableFreshAgentMode, {
  provider: string
  runtimeVariant: string
  model: string
  effort: string
  pendingApproval: boolean
}>

export type NativeTurnProof = {
  turnId: string
  assistantMessageId: string
  completionKind: 'provider_native_completed'
}

export type FreshAgentQualificationRow = {
  mode: QualifiableFreshAgentMode
  provider: string
  providerVersion: string
  model: string
  effort: string
  runtimeVariant: string
  actualProviderProcess: true
  fixtureTransport: false
  ingresses: FreshAgentIngressId[]
  soulId: string
  nativeSessionId: string
  providerStoreId: string
  completedNativeTurns: NativeTurnProof[]
  noToolRecall: boolean
  crashes: {
    web: string[]
    host: string[]
  }
  pendingApproval:
    | { supported: false }
    | {
        supported: true
        survivedWebRestart: boolean
        survivedHostRecovery: boolean
        resolvedExactlyOnce: boolean
        decisionIdHash: string
      }
  writerProof: {
    activeWriterCount: number
    conflictingWriterCount: number
    dispatchCountForPrompt: number
    completionCountForPrompt: number
  }
  isolation: {
    providerVolumeNameHash: string
    enclosureIdHash: string
    independentProviderStore: boolean
    independentEnclosure: boolean
  }
  limits: {
    cpuMax: string
    memoryMax: string
    swapMax: string
    pidsMax: string
  }
  oldEnclosure: {
    verifiedEmptyBeforeResume: boolean
    writerClaimReleasedBeforeResume: boolean
  }
  [key: string]: unknown
}

function validateRows(
  repoRoot: string,
  selectedModesValue: unknown,
  rowsValue: unknown,
): asserts rowsValue is FreshAgentQualificationRow[] {
  if (!Array.isArray(selectedModesValue) || selectedModesValue.length === 0) {
    throw new Error('fresh-agent selectedModes must contain at least one exact mode')
  }
  if (!Array.isArray(rowsValue) || rowsValue.length === 0) {
    throw new Error('fresh-agent qualification must contain at least one tested row')
  }
  const allowed = new Set<string>(QUALIFIABLE_FRESH_AGENT_MODES)
  const selectedModes = selectedModesValue.map((mode) => nonEmptyString(mode, 'selected mode'))
  for (const mode of selectedModes) {
    if (!allowed.has(mode)) throw new Error(`fresh-agent selected mode ${mode} is unsupported`)
  }
  assertNoDuplicates(selectedModes, 'selected mode')
  const modes = rowsValue.map((candidate) => nonEmptyString(object(candidate, 'fresh-agent row').mode, 'row mode'))
  assertNoDuplicates(modes, 'fresh-agent row')
  if (stableJson(selectedModes) !== stableJson(modes)) {
    throw new Error('fresh-agent rows must exactly match selectedModes in declared order')
  }

  const versions = object(
    parseJsonObject(readRegularFile(path.join(repoRoot, 'docker/runtime/provider-versions.json'), 'provider version manifest'), 'provider version manifest').providers,
    'pinned provider versions',
  )
  for (const candidate of rowsValue) {
    const row = object(candidate, 'fresh-agent row')
    const mode = row.mode as QualifiableFreshAgentMode
    const contract = MODE_CONTRACT[mode]
    if (!contract) throw new Error(`${mode} has no fresh-agent qualification contract`)
    for (const [field, expected] of Object.entries({
      provider: contract.provider,
      runtimeVariant: contract.runtimeVariant,
      model: contract.model,
      effort: contract.effort,
    })) stringEqual(row[field], expected, `${mode}.${field}`)
    if (row.actualProviderProcess !== true || row.fixtureTransport !== false) {
      throw new Error(`${mode} must prove an actual provider process and no fixture transport`)
    }
    const requiredIngresses = FRESH_AGENT_INGRESS_INVENTORY.map(({ ingress }) => ingress)
    if (stableJson(row.ingresses) !== stableJson(requiredIngresses)) {
      throw new Error(`${mode}.ingresses must exactly cover the executable doorway inventory`)
    }
    const pinned = object(versions[contract.provider], `${contract.provider} pinned provider version`)
    stringEqual(row.providerVersion, nonEmptyString(pinned.version, `${contract.provider} pinned version`), `${mode}.providerVersion`)
    for (const field of ['soulId', 'nativeSessionId', 'providerStoreId'] as const) {
      nonEmptyString(row[field], `${mode}.${field}`)
    }
    validateNativeTurns(mode, row.completedNativeTurns)
    if (row.noToolRecall !== true) throw new Error(`${mode}.noToolRecall must be true`)
    validateCrashes(mode, row.crashes)
    validatePendingApproval(mode, contract.pendingApproval, row.pendingApproval)
    const writer = object(row.writerProof, `${mode}.writerProof`)
    if (writer.activeWriterCount !== 1) throw new Error(`${mode}.writerProof.activeWriterCount must be 1`)
    if (writer.conflictingWriterCount !== 0) throw new Error(`${mode}.writerProof.conflictingWriterCount must be 0`)
    if (writer.dispatchCountForPrompt !== 1) throw new Error(`${mode}.writerProof.dispatchCountForPrompt must be 1`)
    if (writer.completionCountForPrompt !== 1) throw new Error(`${mode}.writerProof.completionCountForPrompt must be 1`)
    const isolation = object(row.isolation, `${mode}.isolation`)
    for (const field of ['providerVolumeNameHash', 'enclosureIdHash'] as const) requireSha256(isolation[field], `${mode}.isolation.${field}`)
    if (isolation.independentProviderStore !== true) throw new Error(`${mode}.isolation.independentProviderStore must be true`)
    if (isolation.independentEnclosure !== true) throw new Error(`${mode}.isolation.independentEnclosure must be true`)
    validateLimits(mode, row.limits)
    const old = object(row.oldEnclosure, `${mode}.oldEnclosure`)
    if (old.verifiedEmptyBeforeResume !== true) throw new Error(`${mode}.oldEnclosure.verifiedEmptyBeforeResume must be true`)
    if (old.writerClaimReleasedBeforeResume !== true) throw new Error(`${mode}.oldEnclosure.writerClaimReleasedBeforeResume must be true`)
  }
  const stores = rowsValue.map((row) => row.providerStoreId)
  const enclosures = rowsValue.map((row) => object(row.isolation, 'row isolation').enclosureIdHash as string)
  assertNoDuplicates(stores, 'provider store')
  assertNoDuplicates(enclosures, 'enclosure')
}

function validateNativeTurns(mode: string, value: unknown): void {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error(`${mode}.completedNativeTurns must contain initial and no-tool recall completions`)
  }
  const ids: string[] = []
  for (const candidate of value) {
    const turn = object(candidate, `${mode}.completedNativeTurns row`)
    ids.push(nonEmptyString(turn.turnId, `${mode}.completedNativeTurns.turnId`))
    nonEmptyString(turn.assistantMessageId, `${mode}.completedNativeTurns.assistantMessageId`)
    if (turn.completionKind !== 'provider_native_completed') {
      throw new Error(`${mode}.completedNativeTurns must use provider_native_completed proofs`)
    }
  }
  assertNoDuplicates(ids, `${mode} completed native turn`)
}

function validateCrashes(mode: string, value: unknown): void {
  const crashes = object(value, `${mode}.crashes`)
  const web = stringArray(crashes.web, `${mode} web crashes`)
  const host = stringArray(crashes.host, `${mode} host crashes`)
  if (!web.includes('abrupt_restart')) throw new Error(`${mode} web crashes must include abrupt_restart`)
  for (const required of ['session_host_exit', 'provider_process_exit']) {
    if (!host.includes(required)) throw new Error(`${mode} host crashes must include ${required}`)
  }
}

function validatePendingApproval(mode: string, supported: boolean, value: unknown): void {
  const pending = object(value, `${mode}.pendingApproval`)
  if (pending.supported !== supported) {
    throw new Error(`${mode}.pendingApproval.supported must be ${supported}`)
  }
  if (!supported) {
    if (Object.keys(pending).some((key) => key !== 'supported')) {
      throw new Error(`${mode}.pendingApproval must not invent unsupported decision proof`)
    }
    return
  }
  if (pending.survivedWebRestart !== true || pending.survivedHostRecovery !== true
    || pending.resolvedExactlyOnce !== true) {
    throw new Error(`${mode}.pendingApproval must survive web/host recovery and resolve exactly once`)
  }
  requireSha256(pending.decisionIdHash, `${mode}.pendingApproval.decisionIdHash`)
}

function validateLimits(mode: string, value: unknown): void {
  const limits = object(value, `${mode}.limits`)
  for (const field of ['cpuMax', 'memoryMax', 'swapMax', 'pidsMax'] as const) {
    nonEmptyString(limits[field], `${mode}.limits.${field}`)
  }
  if (limits.cpuMax === 'max') throw new Error(`${mode}.limits.cpuMax must be bounded`)
  if (limits.memoryMax === 'max') throw new Error(`${mode}.limits.memoryMax must be bounded`)
  if (limits.pidsMax === 'max') throw new Error(`${mode}.limits.pidsMax must be bounded`)
  if (limits.swapMax !== '0') throw new Error(`${mode}.limits.swapMax must prove swap is disabled`)
}

const FORBIDDEN_KEY = /^(?:responseText|prompt|credentialValue|rawProviderEvents|workspaceData)$/i

function rejectSensitiveFields(value: unknown, location = 'rows'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSensitiveFields(entry, `${location}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) throw new Error(`forbidden sensitive receipt field at ${location}.${key}`)
    rejectSensitiveFields(child, `${location}.${key}`)
  }
}

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, any>
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || value.trim() !== value) {
    throw new Error(`${label} must be a bounded non-empty string`)
  }
  return value
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
    throw new Error(`${label} must be an array of non-empty strings`)
  }
  assertNoDuplicates(value, label)
  return value
}

function assertNoDuplicates(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate evidence`)
}

function stringEqual(actual: unknown, expected: string, label: string): void {
  if (actual !== expected) throw new Error(`${label} does not match the exact expected value`)
}

function requireSha256(value: unknown, label: string): void {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} must be a SHA-256 digest`)
}

function readRegularFile(file: string, label: string): Buffer {
  let stat: fs.Stats
  try { stat = fs.lstatSync(file) } catch { throw new Error(`${label} is missing`) }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 16 * 1024 * 1024) {
    throw new Error(`${label} must be a bounded direct regular file`)
  }
  return fs.readFileSync(file)
}

function parseJsonObject(bytes: Buffer, label: string): Record<string, any> {
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error(`${label} is not valid JSON`) }
  return object(value, label)
}

function stableJson(value: unknown): string {
  return JSON.stringify(value)
}
/** Direct checks shared by live mode tests. Fixture observations cannot pass. */
export function assertFreshAgentResults(repoRoot: string, selectedModes: unknown, rows: unknown): asserts rows is FreshAgentQualificationRow[] {
  rejectSensitiveFields(rows)
  validateRows(repoRoot, selectedModes, rows)
}
