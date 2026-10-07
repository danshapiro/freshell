import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { dispatchNativeFeasibility, nativeFeasibilityCases, parseNativeFeasibilityArguments,
  type NativeExperimentOriginal, type NativeSelection } from '../../../../scripts/testing/runtime-native-feasibility.js'

const imageDigest = `sha256:${'a'.repeat(64)}`
const candidateSha = 'b'.repeat(40)
const ownerId = 'unit-finite-child'
const selection: NativeSelection = { mode: 'freshclaude', case: 'startup' }
function child(caseId: string, failure = false): NativeExperimentOriginal {
  const code = `const [caseId,ownerId,imageDigest,candidateSha,failure]=process.argv.slice(1);
    const original={caseId,ownerId,imageDigest,candidateSha,nativeVersion:'fixture-only',
      executableSha256:'c'.repeat(64),profileSha256:'d'.repeat(64),artifactReferences:['fixture://'+process.pid],
      assertions:[{name:'actual-fixture-child-exit',pass:process.pid>0&&failure==='false'}]};
    process.stdout.write(JSON.stringify(original));`
  return JSON.parse(execFileSync(process.execPath, ['-e', code, caseId, ownerId, imageDigest, candidateSha, String(failure)], {
    encoding: 'utf8', timeout: 5_000,
  })) as NativeExperimentOriginal
}

describe('finite native experiment dispatch (fixtures do not qualify providers)', () => {
  it('selects the supported provider/mode and refuses real-root and arbitrary command arguments', () => {
    expect(parseNativeFeasibilityArguments(['--mode', 'kilroy', '--case', 'approval-checkpoint']))
      .toEqual({ mode: 'kilroy', case: 'approval-checkpoint' })
    for (const args of [[], ['--provider', 'unknown', '--case', 'startup'],
      ['--provider', 'claude', '--case', 'approval-checkpoint'],
      ['--mode', 'freshcodex', '--case', 'approval-checkpoint'],
      ['--provider', 'claude', '--case', 'startup', '--root', 'real-root'],
      ['--shell', 'anything', '--case', 'startup']]) {
      expect(() => parseNativeFeasibilityArguments(args)).toThrow()
    }
  })

  it('executes every finite child and always joins owned cleanup', async () => {
    const executed: string[] = []
    let cleaned = false
    const originals = await dispatchNativeFeasibility({ selection, imageDigest, candidateSha, ownerId,
      execute: async (caseId) => { executed.push(caseId); return child(caseId) },
      cleanup: async () => { cleaned = true },
    })
    expect(executed).toEqual(nativeFeasibilityCases(selection))
    expect(originals).toHaveLength(executed.length)
    expect(cleaned).toBe(true)
  })

  it.each(['failed-assertion', 'child-timeout', 'foreign-owner', 'incomplete-provenance'])(
    'refuses %s without reporting success and still cleans owned resources', async (fault) => {
      let cleaned = false
      await expect(dispatchNativeFeasibility({ selection, imageDigest, candidateSha, ownerId,
        execute: async (caseId) => {
          if (fault === 'child-timeout') throw new Error('child timeout')
          const original = child(caseId, fault === 'failed-assertion')
          if (fault === 'foreign-owner') original.ownerId = 'unowned-real-store'
          if (fault === 'incomplete-provenance') original.executableSha256 = ''
          return original
        }, cleanup: async () => { cleaned = true },
      })).rejects.toThrow()
      expect(cleaned).toBe(true)
    },
  )
})
