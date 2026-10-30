import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { admitRehearsalManifest, assertPrivateInput, dispatchRehearsalRoots, parseRehearsalArguments, runRealRootRehearsal, readRehearsalPreflight, type RootRehearsalEvidence } from '../../../../scripts/testing/opencode-restoration-rehearsal.js'
import { RuntimeHarness } from '../../../../scripts/testing/runtime-sandbox.js'

const candidate = 'a'.repeat(40)
const manifest = () => ({
  kind: 'host-opencode-real-source' as const, candidateSha: candidate, imageDigest: `sha256:${'b'.repeat(64)}`,
  sourceIdentity: 'c'.repeat(64), targetScopeDigest: 'd'.repeat(64),
  preflightUrl: 'http://127.0.0.1:3344/api/runtime/soul-loss-repairs/preflight',
  preflightTokenFile: '/private/token', expectedControlEpoch: 4,
  canonicalOriginalDatabase: '/qualified/opencode.db', originalDefaultDatabase: '/qualified/opencode.db',
  snapshotFile: '/private/snapshot.db', snapshotSha256: 'e'.repeat(64), snapshotBytes: 1024,
  roots: Array.from({ length: 7 }, (_, index) => ({ rootSessionId: `ses_real_root_${index}`,
    graphDigest: 'f'.repeat(64), workspacePath: '/qualified/workspace', destinationStoreId: `store-${index}`, canonicalSoulId: `soul-${index}`, expectedIntentRevision: 2 })),
})

describe('explicit real-root rehearsal admission', () => {
  it('joins cleanup after the actual adapter setup fails inside preparation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'real-driver-setup-'))
    // Exercise the producer's real Git boundary in an owned checkout, including
    // when the delivered sources have no repository metadata.
    const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', timeout: 10_000 })
    git('init', '--quiet')
    git('-c', 'user.name=Dan Shapiro', '-c', 'user.email=3732858+danshapiro@users.noreply.github.com',
      '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'Owned restoration rehearsal fixture')
    const snapshot = path.join(directory, 'snapshot.sqlite'), token = path.join(directory, 'token')
    fs.writeFileSync(snapshot, 'owned fixture snapshot', { mode: 0o600 }); fs.writeFileSync(token, 'fixture', { mode: 0o600 })
    const input = { ...manifest(), candidateSha: git('rev-parse', 'HEAD').trim(),
      snapshotFile: snapshot, canonicalOriginalDatabase: snapshot, originalDefaultDatabase: snapshot, preflightTokenFile: token,
      snapshotBytes: fs.statSync(snapshot).size, snapshotSha256: createHash('sha256').update(fs.readFileSync(snapshot)).digest('hex') }
    const scope = { scopeId:input.targetScopeDigest,sourceStoreId:input.sourceIdentity,sourceFingerprint:'e'.repeat(64),
      roots:input.roots.map(root=>({rootSessionId:root.rootSessionId,graphDigest:root.graphDigest,eligibleOwners:[root.canonicalSoulId],canonicalSoulId:root.canonicalSoulId})),
      targets:input.roots.map(root=>({target:{soulId:root.canonicalSoulId,incidentId:'incident-'+root.canonicalSoulId,expectedIntentRevision:root.expectedIntentRevision},providerStoreId:root.destinationStoreId,rootSessionId:root.rootSessionId,incidentRevision:1,identityRevision:0,nativeImportRevision:0,evidenceRevision:1})),
    }
    let preflightCalls = 0
    const server = createServer((_request,response) => { preflightCalls++; response.end(JSON.stringify(scope)) })
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    const address=server.address(); if(!address||typeof address==='string')throw new Error('owned setup HTTP fixture absent')
    input.preflightUrl=`http://127.0.0.1:${address.port}/api/runtime/soul-loss-repairs/preflight`
    const prepare = vi.spyOn(RuntimeHarness.prototype,'prepareTransfer').mockResolvedValue(undefined)
    const cleanup = vi.spyOn(RuntimeHarness.prototype,'cleanup').mockResolvedValue({ok:true,errors:[]})
    vi.spyOn(RuntimeHarness.prototype,'verifyTransferCleanup').mockImplementation(()=>{})
    const file=path.join(directory,'manifest.json'),scratchDir=path.join(directory,'scratch')
    const run = () => runRealRootRehearsal({ manifestFile: file, scratchDir, repoRoot: directory })
    try {
      fs.writeFileSync(file, JSON.stringify({ ...input, candidateSha: '0'.repeat(40) }), { mode: 0o600 })
      await expect(run()).rejects.toThrow('exact current candidate')
      expect(preflightCalls).toBe(0)
      expect(prepare).not.toHaveBeenCalled()
      expect(cleanup).not.toHaveBeenCalled()
      expect(fs.existsSync(scratchDir)).toBe(false)

      fs.writeFileSync(file, JSON.stringify(input), { mode: 0o600 })
      await expect(run()).rejects.toMatchObject({ code: 'ENOENT',
        path: path.join(directory, 'target/release/examples/opencode_restoration_rehearsal') })
      expect(preflightCalls).toBe(1)
      expect(prepare).toHaveBeenCalledOnce(); expect(cleanup).toHaveBeenCalledOnce()
      expect(prepare.mock.contexts[0]).toMatchObject({repoRoot:directory,candidateSha:input.candidateSha})
      expect(cleanup.mock.contexts[0]).toBe(prepare.mock.contexts[0])
      expect(JSON.parse(fs.readFileSync(path.join(scratchDir,'stage-failure.json'),'utf8')).stage).toBe('prepare')
      expect(fs.existsSync(path.join(scratchDir,'rehearsal-receipt.json'))).toBe(false)
    } finally { vi.restoreAllMocks(); server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); fs.rmSync(directory,{recursive:true,force:true}) }
  })
  it('allows an owned delayed HTTP preflight within its budget and refuses after the budget without assuming server settlement', async () => {
    const input = manifest()
    let completed = 0
    let observeRequest!: () => void
    const requestObserved = new Promise<void>(resolve => { observeRequest = resolve })
    let releaseResponse!: () => void
    const responseGate = new Promise<void>(resolve => { releaseResponse = resolve })
    let observeSettlement!: () => void
    const serverSettled = new Promise<void>(resolve => { observeSettlement = resolve })
    const server = createServer(async (_request, response) => {
      observeRequest()
      await responseGate
      completed++
      response.end('{}')
      observeSettlement()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('owned HTTP fixture missing')
    input.preflightUrl = `http://127.0.0.1:${address.port}/api/runtime/soul-loss-repairs/preflight`
    const preflight = readRehearsalPreflight(input, 'fixture', { timeoutMs: 1_000 })
    try {
      await requestObserved
      await expect(preflight).rejects.toMatchObject({ name: 'TimeoutError' })
      expect(completed).toBe(0)
      releaseResponse()
      await serverSettled
      expect(completed).toBe(1)
    } finally {
      releaseResponse()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
  it('uses actual HTTP source/epoch/auth shape and refuses substituted destination ownership', async () => {
    const input=manifest()
    const scope={scopeId:input.targetScopeDigest,sourceStoreId:input.sourceIdentity,sourceFingerprint:'e'.repeat(64),
      roots:input.roots.map(root=>({rootSessionId:root.rootSessionId,graphDigest:root.graphDigest,eligibleOwners:[root.canonicalSoulId],canonicalSoulId:root.canonicalSoulId})),
      targets:input.roots.map(root=>({target:{soulId:root.canonicalSoulId,incidentId:'incident-'+root.canonicalSoulId,expectedIntentRevision:root.expectedIntentRevision},providerStoreId:root.destinationStoreId,rootSessionId:root.rootSessionId,incidentRevision:1,identityRevision:0,nativeImportRevision:0,evidenceRevision:1})),
    }
    let calls=0
    const server=createServer(async (request,response)=>{
      const chunks=[];for await (const chunk of request) chunks.push(chunk)
      expect(request.headers['x-auth-token']).toBe('owned-fixture-token')
      expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({sourceStoreId:input.sourceIdentity,rootSessionIds:input.roots.map(root=>root.rootSessionId),expectedControlEpoch:input.expectedControlEpoch})
      calls++;await new Promise(resolve => setTimeout(resolve, 50));response.setHeader('content-type','application/json');response.end(JSON.stringify(scope))
    })
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    const address=server.address();if(!address||typeof address==='string')throw new Error('owned HTTP fixture missing')
    input.preflightUrl=`http://127.0.0.1:${address.port}/api/runtime/soul-loss-repairs/preflight`
    try {
      await expect(readRehearsalPreflight(input,'owned-fixture-token', { timeoutMs: 1_000 })).resolves.toBeUndefined()
      scope.targets[0]!.providerStoreId='substituted-store'
      await expect(readRehearsalPreflight(input,'owned-fixture-token')).rejects.toThrow('scope differs')
      expect(calls).toBe(2)
    } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
  })
  it('requires all exact CLI arguments and refuses every synthetic/default mode', () => {
    expect(parseRehearsalArguments(['--mode', 'real', '--manifest-file', '/private/input.json', '--scratch-dir', '/private/new-run'])).toEqual({ manifestFile: '/private/input.json', scratchDir: '/private/new-run' })
    for (const args of [[], ['--mode', 'fixture'], ['--mode', 'real', '--manifest-file', 'relative', '--scratch-dir', '/private/new-run']]) expect(() => parseRehearsalArguments(args)).toThrow()
  })
  it('refuses missing or fixture provenance before any transfer', () => {
    for (const value of [{}, { ...manifest(), kind: 'fixture' }, { ...manifest(), snapshotFile: undefined }]) {
      expect(() => admitRehearsalManifest(value, candidate)).toThrow()
    }
  })
  it('refuses wrong candidate/image and incomplete or extra distinct roots', () => {
    for (const value of [{ ...manifest(), candidateSha: '0'.repeat(40) }, { ...manifest(), imageDigest: 'latest' },
      { ...manifest(), roots: manifest().roots.map(root => ({ ...root, rootSessionId: root.rootSessionId.replace('real', 'fixture') })) },
      { ...manifest(), roots: manifest().roots.slice(0, 6) }, { ...manifest(), roots: [...manifest().roots, { ...manifest().roots[0]!, rootSessionId: 'ses_eighth' }] },
      { ...manifest(), roots: Array.from({ length: 7 }, () => manifest().roots[0]) }]) expect(() => admitRehearsalManifest(value, candidate)).toThrow()
  })
  it('refuses missing or broad-readable private input without creating scratch', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-rehearsal-input-'))
    try {
      const file = path.join(directory, 'manifest.json'), scratchDir = path.join(directory, 'scratch')
      await expect(runRealRootRehearsal({ manifestFile: file, scratchDir })).rejects.toThrow()
      fs.writeFileSync(file, '{}', { mode: 0o644 })
      fs.chmodSync(file, 0o644)
      expect(() => assertPrivateInput(file)).toThrow()
      fs.chmodSync(file, 0o600); assertPrivateInput(file)
      await expect(runRealRootRehearsal({ manifestFile: file, scratchDir })).rejects.toThrow()
      expect(fs.existsSync(scratchDir)).toBe(false)
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it('executes seven finite child originals and derives completion from files', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-rehearsal-children-'))
    let cleanupCount = 0
    try {
      const roots = manifest().roots.map((root) => root.rootSessionId)
      const execute = async (root: string): Promise<RootRehearsalEvidence> => {
        const child = await promisify(execFile)(process.execPath, ['-e',
          'const fs=require("node:fs"),path=require("node:path");const [dir,root]=process.argv.slice(1);const files=["export","import","read","native"].map(stage=>path.join(dir,root+"-"+stage+".json"));for(const file of files)fs.writeFileSync(file,JSON.stringify({kind:"fixture",root}),{mode:0o600});process.stdout.write(JSON.stringify(files));', directory, root])
        const files = JSON.parse(child.stdout) as string[]
        return { rootSessionId: root, graphDigest: 'f'.repeat(64), exportArtifact: files[0]!, importArtifact: files[1]!, readerArtifact: files[2]!, nativeArtifact: files[3]!, nativeReadableSessionCount: files.length / 4, savedSnapshotSummary: { status: 'legacy_unqualified' } }
      }
      const completed = await dispatchRehearsalRoots({ roots, execute, cleanup: async () => { cleanupCount++ } })
      expect(completed).toHaveLength(7)
      expect(completed.every((root) => root.nativeReadableSessionCount === 1)).toBe(true)
      expect(cleanupCount).toBe(1)
      expect(() => admitRehearsalManifest({ ...manifest(), kind: 'fixture-root-dispatch', rootEvidence: completed }, candidate)).toThrow()
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it('prepares all root originals before consumers and cleans up a failed preparation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-rehearsal-prepare-'))
    const roots = manifest().roots.map(root => root.rootSessionId)
    let cleaned = 0
    try {
      const prepare = async () => {
        await promisify(execFile)(process.execPath, ['-e',
          'const fs=require("node:fs"),path=require("node:path"),[dir,...roots]=process.argv.slice(1);for(const root of roots)fs.writeFileSync(path.join(dir,root+".json"),JSON.stringify({root}),{flag:"wx",mode:0o600});', directory, ...roots])
      }
      const execute = async (root: string): Promise<RootRehearsalEvidence> => {
        const artifact = path.join(directory, `${root}.json`)
        expect(JSON.parse(fs.readFileSync(artifact, 'utf8'))).toEqual({ root })
        return { rootSessionId: root, graphDigest: 'f'.repeat(64), exportArtifact: artifact, importArtifact: artifact,
          readerArtifact: artifact, nativeArtifact: artifact, nativeReadableSessionCount: 1, savedSnapshotSummary: {} }
      }
      await expect(dispatchRehearsalRoots({ roots, prepare, execute, cleanup: async () => { cleaned++ } })).resolves.toHaveLength(7)
      await expect(dispatchRehearsalRoots({ roots, prepare, execute, cleanup: async () => { cleaned++ } })).rejects.toThrow()
      expect(cleaned).toBe(2)
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it('refuses failed native child, absent originals, six/eight roots and failed owned cleanup', async () => {
    const roots = manifest().roots.map((root) => root.rootSessionId)
    let executed = 0, cleaned = 0
    const failed = async (): Promise<RootRehearsalEvidence> => {
      executed++
      await promisify(execFile)(process.execPath, ['-e', 'process.exit(7)'])
      throw new Error('failed native fixture cannot complete')
    }
    await expect(dispatchRehearsalRoots({ roots, execute: failed, cleanup: async () => { cleaned++ } })).rejects.toThrow()
    expect(executed).toBe(7); expect(cleaned).toBe(1)
    await expect(dispatchRehearsalRoots({ roots, execute: async root => ({ rootSessionId: root, graphDigest: 'f'.repeat(64), exportArtifact: '/missing-export', importArtifact: '/missing-import', readerArtifact: '/missing-reader', nativeArtifact: '/missing-native', nativeReadableSessionCount: 1, savedSnapshotSummary: {} }), cleanup: async () => { cleaned++ } })).rejects.toThrow()
    expect(cleaned).toBe(2)
    for (const selected of [roots.slice(0, 6), [...roots, 'ses_extra']]) await expect(dispatchRehearsalRoots({ roots: selected, execute: failed, cleanup: async () => {} })).rejects.toThrow()
    await expect(dispatchRehearsalRoots({ roots, execute: failed, cleanup: async () => { throw new Error('owned cleanup failed') } })).rejects.toThrow('owned cleanup failed')
  })
})
