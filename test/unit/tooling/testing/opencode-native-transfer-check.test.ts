import { execFileSync, spawnSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  dispatchNativeCases, expectedExportRefusal, NATIVE_TRANSFER_CASES, parseNativeTransferArguments,
  type NativeCaseOriginal, type NativeTransferCase,
} from '../../../../scripts/testing/opencode-native-transfer-check.js'

const imageDigest = `sha256:${'a'.repeat(64)}`

describe('expected native export refusals', () => {
  const diagnostic = { event: 'opencode.rehearsal.stage_refused', detail: 'blocked: source schema relationships differ for pinned table message_seq' }
  // The production container embeds this exact function, without module state.
  const check: typeof expectedExportRefusal = runInNewContext(`(${expectedExportRefusal.toString()})`)
  it('accepts a normal case-specific adapter refusal only without a receipt', () => {
    const result = spawnSync(process.execPath, ['-e', 'process.exitCode=1'], { encoding: 'utf8', timeout: 5_000 })
    expect(check('changed-type', result, diagnostic, false)).toBe(true)
    expect(check('changed-type', result, diagnostic, true)).toBe(false)
  })
  it.each([
    { name: 'timeout', result: { status: null, signal: 'SIGTERM', error: Object.assign(new Error('fixture timeout'), { code: 'ETIMEDOUT' }) } },
    { name: 'signal', result: { status: null, signal: 'SIGSEGV' } },
    { name: 'spawn error despite exit one', result: { status: 1, error: new Error('spawn failed') } },
    { name: 'wrong normal exit', result: { status: 7, signal: null } },
  ])('rejects $name even with the expected diagnostic', ({ result }) => {
    expect(check('changed-type', result, diagnostic, false)).toBe(false)
  })
  it.each([null, {}, { ...diagnostic, detail: 'unrelated disk failure' },
    { ...diagnostic, detail: 'native file part has no recognized URL' }, { ...diagnostic, event: 'other' }])(
    'rejects an absent, unrelated or wrong-case cause (%j)', cause => {
      expect(check('changed-type', { status: 1 }, cause, false)).toBe(false)
    })
  it.each([
    ['changed-type', 'source schema relationships differ for pinned table message_seq'],
    ['changed-key', 'source schema relationships differ for pinned table message_seq'],
    ['changed-nullability', 'source schema relationships differ for pinned table message_seq'],
    ['changed-foreign-key', 'source schema relationships differ for pinned table message_seq'],
    ['changed-index', 'source schema object inventory differs from pinned OpenCode'],
    ['changed-trigger', 'source schema object inventory differs from pinned OpenCode'],
    ['changed-migration', 'source migration journal does not match OpenCode v1.18.21'],
    ['missing-native-attachment-url', 'native file part has no recognized URL'],
    ['changed-source-reference', 'workspace file reference is unavailable: ENOENT'],
    ['missing-snapshot-descendant', 'retained snapshot has an incomplete tree closure'],
  ])('requires the intended cause for %s', (label, detail) => {
    expect(check(label, { status: 1 }, { ...diagnostic, detail }, false)).toBe(true)
    expect(check(label, { status: 1 }, { ...diagnostic, detail: 'unrelated adapter error' }, false)).toBe(false)
  })
})

// These finite child fixtures exercise admission, exits, dispatch and cleanup.
// They are deliberately never passed to runNativeTransferCheck or called
// pinned-native qualification evidence.
function child(caseId: NativeTransferCase, outcome: 'complete' | 'refused' | 'crash' = 'complete'): NativeCaseOriginal {
  const code = `
    const [caseId,outcome]=process.argv.slice(1);
    if(outcome==='crash') process.exit(7);
    const checked = process.pid > 0;
    process.stdout.write(JSON.stringify({caseId,nativeVersion:'1.18.21',nativeDecodedRootCount:3,
      assertions:[{name:'finite-fixture-child-finished',pass:checked&&outcome==='complete'}],
      artifactReferences:['fixture://child/'+process.pid]}));
  `
  return JSON.parse(execFileSync(process.execPath, ['-e', code, caseId, outcome], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
  })) as NativeCaseOriginal
}

describe('finite native transfer driver plumbing', () => {
  it('requires exactly the explicit immutable image and all selector', () => {
    expect(parseNativeTransferArguments(['--image-digest', imageDigest, '--case', 'all'])).toEqual({ imageDigest })
    for (const args of [[], ['--case', 'all'], ['--image-digest', 'latest', '--case', 'all'], ['--image-digest', imageDigest, '--case', 'semantic-schema']]) {
      expect(() => parseNativeTransferArguments(args)).toThrow()
    }
  })

  it('executes four finite child groups and derives originals before owned cleanup', async () => {
    const executed: NativeTransferCase[] = []
    let cleaned = false
    const originals = await dispatchNativeCases({ imageDigest, cases: NATIVE_TRANSFER_CASES,
      execute: async (caseId) => { executed.push(caseId); return child(caseId) },
      cleanup: async () => { expect(executed).toEqual(NATIVE_TRANSFER_CASES); cleaned = true },
    })
    expect(originals).toHaveLength(4)
    expect(originals.every((original) => original.assertions.length > 0 && original.assertions.every((assertion) => assertion.pass))).toBe(true)
    expect(cleaned).toBe(true)
  })

  it.each(['refused', 'crash'] as const)('continues finite dispatch and refuses a %s child after cleanup', async (outcome) => {
    const executed: NativeTransferCase[] = []
    let cleaned = false
    await expect(dispatchNativeCases({ imageDigest, cases: NATIVE_TRANSFER_CASES,
      execute: async (caseId) => { executed.push(caseId); return child(caseId, caseId === 'attachment-authority' ? outcome : 'complete') },
      cleanup: async () => { cleaned = true },
    })).rejects.toThrow('attachment-authority')
    expect(executed).toEqual(NATIVE_TRANSFER_CASES)
    expect(cleaned).toBe(true)
  })

  it('refuses missing, repeated and zero selectors before creating children', async () => {
    let executed = 0
    for (const cases of [[], NATIVE_TRANSFER_CASES.slice(0, 3), [...NATIVE_TRANSFER_CASES.slice(0, 3), NATIVE_TRANSFER_CASES[0]]]) {
      await expect(dispatchNativeCases({ imageDigest, cases,
        execute: async (caseId) => { executed++; return child(caseId) }, cleanup: async () => {},
      })).rejects.toThrow('all four')
    }
    expect(executed).toBe(0)
  })

  it('refuses zero native reads, empty assertions, wrong child identity and failed cleanup', async () => {
    for (const mutation of [
      (original: NativeCaseOriginal) => { original.nativeDecodedRootCount = 0 },
      (original: NativeCaseOriginal) => { original.assertions = [] },
      (original: NativeCaseOriginal) => { original.caseId = 'semantic-schema' },
      (original: NativeCaseOriginal) => { original.nativeVersion = 'unknown' },
    ]) {
      let cleaned = false
      await expect(dispatchNativeCases({ imageDigest, cases: NATIVE_TRANSFER_CASES,
        execute: async (caseId) => { const original = child(caseId); if (caseId === 'native-transfer-boundaries') mutation(original); return original },
        cleanup: async () => { cleaned = true },
      })).rejects.toThrow()
      expect(cleaned).toBe(true)
    }
    await expect(dispatchNativeCases({ imageDigest, cases: NATIVE_TRANSFER_CASES,
      execute: async (caseId) => child(caseId), cleanup: async () => { throw new Error('owned container remains') },
    })).rejects.toThrow('owned container remains')
  })
})
