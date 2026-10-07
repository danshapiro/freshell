import { fileURLToPath } from 'node:url'
import { RuntimeHarness } from './runtime-sandbox.js'

export type NativeProvider = 'claude' | 'codex' | 'opencode' | 'amplifier'
export type NativeMode = 'freshclaude' | 'kilroy' | 'freshcodex' | 'freshopencode'
export type NativeExperimentCase = 'startup' | 'native-turn' | 'approval-checkpoint'
export type NativeSelection = { provider?: NativeProvider; mode?: NativeMode; case: NativeExperimentCase }
export type NativeExperimentOriginal = {
  caseId: string
  ownerId: string
  imageDigest: string
  candidateSha: string
  nativeVersion: string
  executableSha256: string
  profileSha256: string
  artifactReferences: string[]
  assertions: { name: string; pass: boolean }[]
}

export function parseNativeFeasibilityArguments(args: readonly string[]): NativeSelection {
  if (args.length !== 4 || !['--provider', '--mode'].includes(args[0] ?? '') || args[2] !== '--case') {
    throw new Error('usage: runtime-native-feasibility --provider claude|codex|opencode|amplifier OR --mode freshclaude|kilroy|freshcodex|freshopencode --case startup|native-turn|approval-checkpoint')
  }
  const cases = ['startup', 'native-turn', 'approval-checkpoint']
  if (!cases.includes(args[3]!)) throw new Error('unknown finite native case')
  const selected = args[1]!
  if (args[0] === '--provider') {
    if (!['claude', 'codex', 'opencode', 'amplifier'].includes(selected) || args[3] === 'approval-checkpoint') {
      throw new Error('unsupported native provider/case')
    }
    return { provider: selected as NativeProvider, case: args[3] as NativeExperimentCase }
  }
  if (!['freshclaude', 'kilroy', 'freshcodex', 'freshopencode'].includes(selected)
    || (args[3] === 'approval-checkpoint' && !['freshclaude', 'kilroy'].includes(selected))) {
    throw new Error('unsupported native mode/case')
  }
  return { mode: selected as NativeMode, case: args[3] as NativeExperimentCase }
}

export function nativeFeasibilityCases(selection: NativeSelection): readonly string[] {
  if (selection.case === 'native-turn') return ['current-native-turn']
  if (selection.case === 'approval-checkpoint') return [
    'allow', 'deny', 'crash-before-checkpoint', 'changed-tool', 'missing-tool', 'changed-input',
    'changed-profile', 'changed-root', 'multiple-tools', 'stale-callback', 'effect-before-observation',
  ]
  if (selection.provider === 'claude') return [
    'create', 'exact-resume', 'fork-root', 'wrong-root', 'stale-shared-signal', 'disabled-hooks',
    'trust-refusal', 'unwritable-signal', 'timeout', 'provider-exit', 'stop-cancellation', 'restoration-failure-after-hook',
  ]
  if (selection.provider === 'amplifier') return [
    'create', 'exact-resume', 'wrong-root', 'missing-history', 'missing-context-restore', 'load-failure',
    'timeout', 'provider-exit', 'stop-cancellation', 'file-replacement', 'file-truncation', 'old-writer',
    'malformed-ack', 'parent-root', 'native-followup',
  ]
  if (selection.mode === 'freshclaude' || selection.mode === 'kilroy') return [
    'create', 'exact-resume', 'wrong-id', 'missing-native-id', 'placeholder-id', 'disabled-hooks',
    'restoration-failure-after-hook', 'timeout-50s', 'provider-exit', 'stop-cancellation',
  ]
  if (selection.provider === 'opencode') return [
    'null-slot', 'disposal', 'root-load-error', 'history-load-error', 'v1-empty', 'v2-empty-is-not-v1-empty',
    'full-revert', 'part-revert', 'baseline-only-resume', 'stale-observation', 'cancellation',
  ]
  return ['create', 'exact-resume', 'wrong-root', 'cancellation']
}

/** Finite process dispatcher only; fixture children never establish native qualification. */
export async function dispatchNativeFeasibility(input: {
  selection: NativeSelection
  imageDigest: string
  candidateSha: string
  ownerId: string
  execute: (caseId: string) => Promise<NativeExperimentOriginal>
  cleanup: () => Promise<void>
}): Promise<NativeExperimentOriginal[]> {
  if (!/^sha256:[a-f0-9]{64}$/.test(input.imageDigest) || !/^[a-f0-9]{40}$/.test(input.candidateSha)
    || !input.ownerId || !!input.selection.mode === !!input.selection.provider) {
    throw new Error('exact candidate, image, owner and one finite selector required')
  }
  parseNativeFeasibilityArguments([input.selection.mode ? '--mode' : '--provider',
    input.selection.mode ?? input.selection.provider!, '--case', input.selection.case])
  const originals: NativeExperimentOriginal[] = []
  const failures: string[] = []
  try {
    for (const caseId of nativeFeasibilityCases(input.selection)) {
      try {
        const original = await input.execute(caseId)
        originals.push(original)
        if (original.caseId !== caseId || original.ownerId !== input.ownerId
          || original.imageDigest !== input.imageDigest || original.candidateSha !== input.candidateSha
          || !original.nativeVersion || !/^[a-f0-9]{64}$/.test(original.executableSha256)
          || !/^[a-f0-9]{64}$/.test(original.profileSha256) || original.artifactReferences.length === 0
          || original.assertions.length === 0 || original.assertions.some((assertion) => !assertion.pass)) {
          failures.push(caseId)
        }
      } catch {
        failures.push(caseId)
      }
    }
  } finally {
    await input.cleanup()
  }
  if (failures.length > 0 || originals.length !== nativeFeasibilityCases(input.selection).length) {
    throw new Error(`native experiment cases failed: ${failures.join(',')}`)
  }
  return originals
}

export async function runNativeFeasibility(args = process.argv.slice(2)): Promise<void> {
  const selection = parseNativeFeasibilityArguments(args)
  const harness = new RuntimeHarness(process.cwd(), undefined, 3)
  void selection
  void harness
  throw new Error('native managed experiment implementation is pending')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runNativeFeasibility().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ severity: 'error', event: 'runtime.native_feasibility.failed',
      reason: error instanceof Error ? error.message : 'unknown failure' })}\n`)
    process.exitCode = 1
  })
}
