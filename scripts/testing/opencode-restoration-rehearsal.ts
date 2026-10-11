import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { RuntimeHarness } from './runtime-sandbox.js'
import { ManagedRuntimeRepairBatchScopeSchema } from '../../shared/managed-runtime.js'

export type RehearsalManifest = {
  kind: 'host-opencode-real-source'
  candidateSha: string
  imageDigest: string
  sourceIdentity: string
  targetScopeDigest: string
  preflightUrl: string
  preflightTokenFile: string
  expectedControlEpoch: number
  canonicalOriginalDatabase: string
  originalDefaultDatabase: string
  snapshotFile: string
  snapshotSha256: string
  snapshotBytes: number
  roots: { rootSessionId: string; graphDigest: string; workspacePath: string; destinationStoreId: string; canonicalSoulId: string; expectedIntentRevision: number }[]
}

const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const absolute = (value: unknown): value is string => typeof value === 'string' && path.isAbsolute(value)

export function admitRehearsalManifest(value: unknown, candidateSha: string): RehearsalManifest {
  const manifest = value as Partial<RehearsalManifest> | null
  if (!manifest || manifest.kind !== 'host-opencode-real-source' || !/^[a-f0-9]{40}$/.test(candidateSha)
    || manifest.candidateSha !== candidateSha || !/^sha256:[a-f0-9]{64}$/.test(manifest.imageDigest ?? '')
    || !sha256(manifest.sourceIdentity) || !sha256(manifest.targetScopeDigest) || !sha256(manifest.snapshotSha256)
    || !Number.isSafeInteger(manifest.snapshotBytes) || manifest.snapshotBytes! <= 0
    || !Number.isSafeInteger(manifest.expectedControlEpoch) || manifest.expectedControlEpoch! < 1
    || ![manifest.preflightTokenFile, manifest.canonicalOriginalDatabase, manifest.originalDefaultDatabase, manifest.snapshotFile].every(absolute)
    || !Array.isArray(manifest.roots) || manifest.roots.length !== 7
    || new Set(manifest.roots.map((root) => root.rootSessionId)).size !== 7
    || new Set(manifest.roots.map((root) => root.destinationStoreId)).size !== 7
    || manifest.roots.some((root) => !/^ses_[a-zA-Z0-9_-]+$/.test(root.rootSessionId) || /fixture|synthetic/.test(root.rootSessionId)
      || !sha256(root.graphDigest) || !absolute(root.workspacePath) || !root.destinationStoreId || !root.canonicalSoulId
      || !Number.isSafeInteger(root.expectedIntentRevision) || root.expectedIntentRevision < 1)) {
    throw new Error('exact current candidate, immutable image, private real-source provenance and seven distinct roots required')
  }
  const preflight = new URL(manifest.preflightUrl ?? '')
  if (!['http:', 'https:'].includes(preflight.protocol) || preflight.username || preflight.password
    || preflight.pathname !== '/api/runtime/soul-loss-repairs/preflight' || preflight.search || preflight.hash) throw new Error('exact authenticated current preflight endpoint required')
  return manifest as RehearsalManifest
}

export function assertPrivateInput(file: string): void {
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== file) throw new Error('exact absolute private input required')
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('private owned regular input required')
}

export type RootRehearsalEvidence = {
  rootSessionId: string
  graphDigest: string
  exportArtifact: string
  importArtifact: string
  readerArtifact: string
  nativeArtifact: string
  nativeReadableSessionCount: number
  savedSnapshotSummary: unknown
}
export type RehearsalReceipt = {
  kind: 'real-root-rehearsal'
  candidateSha: string
  imageDigest: string
  sourceIdentity: string
  targetScopeDigest: string
  runCount: number
  expectedRootCount: number
  exportedRootCount: number
  importedRootCount: number
  nativeReadableRootCount: number
  failedRootCount: number
  cleanupStatus: 'complete'
  rootEvidence: RootRehearsalEvidence[]
}

/** Finite lifecycle plumbing. Its output alone is never a real receipt. */
export async function dispatchRehearsalRoots(input: {
  roots: readonly string[]
  prepare?: () => Promise<void>
  execute: (root: string) => Promise<RootRehearsalEvidence>
  cleanup: () => Promise<void>
}): Promise<RootRehearsalEvidence[]> {
  if (input.roots.length !== 7 || new Set(input.roots).size !== 7) throw new Error('seven exact distinct roots required')
  const completed: RootRehearsalEvidence[] = []
  const failed: string[] = []
  try {
    await input.prepare?.()
    for (const root of input.roots) {
      try {
        const evidence = await input.execute(root)
        if (evidence.rootSessionId !== root || !sha256(evidence.graphDigest) || !Number.isSafeInteger(evidence.nativeReadableSessionCount) || evidence.nativeReadableSessionCount < 1
          || [evidence.exportArtifact, evidence.importArtifact, evidence.readerArtifact, evidence.nativeArtifact].some((file) => !absolute(file) || !fs.statSync(file).isFile())) throw new Error('completed original root artifacts required')
        completed.push(evidence)
      } catch { failed.push(root) }
    }
  } finally { await input.cleanup() }
  if (failed.length || completed.length !== 7) throw new Error(`real-root lifecycle refused: ${failed.length} failed roots`)
  return completed
}

function writePrivate(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
}

function hashFile(file: string): string {
  const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(64 * 1024), hash = createHash('sha256')
  try { for (;;) { const read = fs.readSync(fd, buffer); if (!read) break; hash.update(buffer.subarray(0, read)) } }
  finally { fs.closeSync(fd) }
  return hash.digest('hex')
}

const REAL_NATIVE_READER = String.raw`
const fs=require('node:fs'),cp=require('node:child_process'),crypto=require('node:crypto');
const [requestFile,resultFile]=process.argv.slice(1),input=JSON.parse(fs.readFileSync(requestFile,'utf8'));
const descriptor=JSON.parse(fs.readFileSync(input.descriptorFile,'utf8')),manifest=JSON.parse(descriptor.manifestJson);
const sessions=manifest.rows.filter(row=>row.table==='session').map(row=>row.key[0].value),artifacts=[];
const sha=file=>{const fd=fs.openSync(file,'r'),b=Buffer.alloc(65536),hash=crypto.createHash('sha256');try{for(;;){const n=fs.readSync(fd,b);if(!n)break;hash.update(b.subarray(0,n))}}finally{fs.closeSync(fd)}return hash.digest('hex')};
const status=fs.readFileSync('/proc/self/status','utf8');
if(process.getuid()!==65534||process.getgid()!==0||!/^CapEff:\s+0+$/m.test(status)||!/^NoNewPrivs:\s+1$/m.test(status))throw Error('provider boundary differs');
if(cp.execFileSync('opencode',['--version'],{encoding:'utf8'}).trim()!=='1.18.21')throw Error('native version differs');
const log=fs.openSync('/scratch/native-private.log','wx',0o600),server=cp.spawn('opencode',['serve','--hostname','127.0.0.1','--port','4199'],{cwd:input.workspacePath,stdio:['ignore',log,log]});fs.closeSync(log);
(async()=>{let count=0;try{
for(let n=0;n<200;n++){try{if((await fetch('http://127.0.0.1:4199/global/health',{signal:AbortSignal.timeout(500)})).ok)break}catch{}if(server.exitCode!==null||n===199)throw Error('native startup failed');await new Promise(r=>setTimeout(r,100))}
for(const session of sessions){
 const get=async route=>{const r=await fetch('http://127.0.0.1:4199'+route,{headers:{'x-opencode-directory':input.workspacePath},signal:AbortSignal.timeout(120000)});if(!r.ok)throw Error('typed native read failed');return r.json()};
 const info=await get('/session/'+session),messages=await get('/session/'+session+'/message');if(info.id!==session||!Array.isArray(messages))throw Error('native selected graph differs');
 const readFile='/scratch/native-'+session+'-read.json';fs.writeFileSync(readFile,JSON.stringify({info,messages}),{mode:0o600,flag:'wx'});
 const exportFile='/scratch/native-'+session+'-export.json',out=fs.openSync(exportFile,'wx',0o600);
 const exported=cp.spawnSync('opencode',['export',session],{cwd:input.workspacePath,stdio:['ignore',out,'pipe'],timeout:180000,maxBuffer:1024*1024});fs.closeSync(out);if(exported.status!==0)throw Error('native export failed');
 const decoded=JSON.parse(fs.readFileSync(exportFile,'utf8'));if(decoded.info.id!==session||decoded.messages.length!==messages.length)throw Error('native export closure differs');artifacts.push({path:readFile,sha256:sha(readFile)},{path:exportFile,sha256:sha(exportFile)});count++;
}
if(count!==sessions.length||count<1)throw Error('native read selection incomplete');
const result={rootSessionId:input.rootSessionId,graphDigest:descriptor.sourceGeneration,nativeVersion:'1.18.21',nativeReadableSessionCount:count,providerUid:process.getuid(),providerGid:process.getgid(),snapshotSummary:input.savedSnapshotSummary,artifacts};
fs.writeFileSync(resultFile,JSON.stringify(result),{mode:0o600,flag:'wx'});process.stdout.write(JSON.stringify(result));
}finally{if(server.exitCode===null){await new Promise(r=>{server.once('exit',r);server.kill('SIGTERM');const timer=setTimeout(()=>server.kill('SIGKILL'),5000);timer.unref()})}}})().catch(()=>{process.stderr.write(JSON.stringify({severity:'error',event:'opencode.real_rehearsal.native_refused',reasonCode:'native_read_failed'})+'\n');process.exitCode=1});`

export async function readRehearsalPreflight(manifest: RehearsalManifest, token: string): Promise<void> {
  const response = await fetch(manifest.preflightUrl, { method: 'POST', headers: { 'x-auth-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ sourceStoreId: manifest.sourceIdentity, rootSessionIds: manifest.roots.map((root) => root.rootSessionId), expectedControlEpoch: manifest.expectedControlEpoch }), signal: AbortSignal.timeout(300_000) })
  if (!response.ok) throw new Error('independent current preflight refused')
  const scope = ManagedRuntimeRepairBatchScopeSchema.parse(await response.json())
  if (scope.scopeId !== manifest.targetScopeDigest || scope.sourceStoreId !== manifest.sourceIdentity || scope.roots.length !== manifest.roots.length
    || manifest.roots.some((root) => {
      const current = scope.roots.find((current) => current.rootSessionId === root.rootSessionId && current.graphDigest === root.graphDigest)
      const member = scope.targets.find((member) => member.rootSessionId === root.rootSessionId && member.target.soulId === root.canonicalSoulId)
      return !current || !current.eligibleOwners.includes(root.canonicalSoulId) || (current.canonicalSoulId !== null && current.canonicalSoulId !== root.canonicalSoulId)
        || !member || member.providerStoreId !== root.destinationStoreId || member.target.expectedIntentRevision !== root.expectedIntentRevision
    })) throw new Error('current external preflight source/member/owner/store scope differs')
}

export async function runRealRootRehearsal(input: { manifestFile: string; scratchDir: string }): Promise<RehearsalReceipt> {
  assertPrivateInput(input.manifestFile)
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const manifest = admitRehearsalManifest(JSON.parse(fs.readFileSync(input.manifestFile, 'utf8')), candidateSha)
  assertPrivateInput(manifest.snapshotFile); assertPrivateInput(manifest.preflightTokenFile)
  if (fs.statSync(manifest.snapshotFile).size !== manifest.snapshotBytes || hashFile(manifest.snapshotFile) !== manifest.snapshotSha256
    || fs.realpathSync(manifest.canonicalOriginalDatabase) !== manifest.canonicalOriginalDatabase) throw new Error('current private snapshot/source binding differs')
  if (!path.isAbsolute(input.scratchDir) || fs.existsSync(input.scratchDir)) throw new Error('fresh absolute scratch directory required')
  const token = fs.readFileSync(manifest.preflightTokenFile, 'utf8').trim()
  if (!token) throw new Error('current preflight authentication required')
  await readRehearsalPreflight(manifest, token)
  fs.mkdirSync(input.scratchDir, { mode: 0o700 })
  if (fs.realpathSync(input.scratchDir) !== input.scratchDir || (fs.statSync(input.scratchDir).mode & 0o077) !== 0) throw new Error('private scratch directory differs')
  const harness = new RuntimeHarness(repoRoot, randomUUID(), 2)
  await harness.prepareTransfer(manifest.imageDigest)
  const adapter = path.join(harness.testRoot, 'transfer-stage')
  fs.copyFileSync(path.join(repoRoot, 'target/release/examples/opencode_restoration_rehearsal'), adapter); fs.chmodSync(adapter, 0o755)
  const schema = path.join(repoRoot, 'crates/freshell-sessions/src/opencode_schema_v1_18_21.sql')
  const migrations = path.join(harness.testRoot, 'migrations.json')
  fs.writeFileSync(migrations, '[]', { mode: 0o644, flag: 'wx' }); fs.chmodSync(migrations, 0o644)
  const rootById = new Map(manifest.roots.map((root) => [root.rootSessionId, root]))
  const stage = promisify(execFile)
  const requests = manifest.roots.map((root, index) => {
    const directory = path.join(input.scratchDir, `root-${index}`)
    return { candidateSha, imageDigest: manifest.imageDigest, sourceDatabase: manifest.snapshotFile, rootSessionId: root.rootSessionId,
      extractionRoot: path.join(directory, 'extractions'), workspacePath: root.workspacePath, descriptorFile: path.join(directory, 'descriptor.json'),
      payloadFile: path.join(directory, 'payload.json'), destinationStoreId: root.destinationStoreId, destinationDatabase: '/scratch/provider/.local/share/opencode/opencode.db',
      providerHome: '/scratch/provider', providerUid: 65534, providerGid: 0, receiptFile: path.join(directory, 'export.json'),
      sourceSnapshot: { canonicalOriginalDatabase: manifest.canonicalOriginalDatabase, originalDefaultDatabase: manifest.originalDefaultDatabase,
        sourceStoreId: manifest.sourceIdentity, snapshotSha256: manifest.snapshotSha256, snapshotBytes: manifest.snapshotBytes,
        roots: manifest.roots.map((item) => ({ rootSessionId: item.rootSessionId, graphDigest: item.graphDigest })),
        workspaces: [...new Set(manifest.roots.map((item) => item.workspacePath))] },
    }
  })
  const rootEvidence = await dispatchRehearsalRoots({ roots: manifest.roots.map((root) => root.rootSessionId),
    prepare: async () => {
      for (const request of requests) fs.mkdirSync(path.dirname(request.receiptFile), { mode: 0o700 })
      const exportRequest = path.join(input.scratchDir, 'export-batch-request.json'); writePrivate(exportRequest, requests)
      // Keep qualification alive for the complete batch, within the previous
      // cumulative export budget. Per-root import/read/native checks follow.
      await stage(adapter, ['--stage', 'export', '--request-file', exportRequest], { cwd: repoRoot, timeout: 600_000 * requests.length, maxBuffer: 1024 * 1024 })
    },
    execute: async (rootSessionId) => {
      const root = rootById.get(rootSessionId)!, index = manifest.roots.indexOf(root)
      const directory = path.join(input.scratchDir, `root-${index}`), request = requests[index]!
      const exported = JSON.parse(fs.readFileSync(request.receiptFile, 'utf8'))
      if (exported.status !== 'complete' || exported.evidence.sourceStoreId !== manifest.sourceIdentity || exported.evidence.graphDigest !== root.graphDigest) throw new Error('original source export differs from preflight')
      const owned = harness.startTransferProvider(adapter, schema, migrations, [root.workspacePath])
      const inspection = harness.inspectContainer(owned.containerId)
      if (inspection.Image !== manifest.imageDigest || inspection.Config.User !== '65534:0' || inspection.HostConfig.CapAdd?.length
        || !inspection.HostConfig.ReadonlyRootfs || inspection.HostConfig.NetworkMode !== 'none') throw new Error('owned provider policy differs')
      harness.execTransferProviderExact(owned.containerId, ['node', '-e', 'const fs=require("node:fs");for(const p of ["/scratch/provider/.local/share/opencode","/scratch/provider/.config","/scratch/provider/.cache"])fs.mkdirSync(p,{recursive:true,mode:0o700})'])
      await harness.copyTransferFileExact(owned.containerId, request.descriptorFile, '/scratch/descriptor.json')
      await harness.copyTransferFileExact(owned.containerId, request.payloadFile, '/scratch/payload.bin')
      const providerRequest = { ...request, descriptorFile: '/scratch/descriptor.json', payloadFile: '/scratch/payload.bin', receiptFile: '/scratch/import.json', sourceSnapshot: undefined }
      harness.writeTransferRequest(owned.containerId, 'import-request.json', providerRequest)
      const imported = JSON.parse(harness.execTransferProviderExact(owned.containerId, ['/opt/transfer-stage', '--stage', 'import', '--request-file', '/scratch/import-request.json']))
      const importArtifact = path.join(directory, 'import.json'); writePrivate(importArtifact, imported)
      harness.writeTransferRequest(owned.containerId, 'read-request.json', { ...providerRequest, receiptFile: '/scratch/read.json' })
      const readable = JSON.parse(harness.execTransferProviderExact(owned.containerId, ['/opt/transfer-stage', '--stage', 'read', '--request-file', '/scratch/read-request.json']))
      const readerArtifact = path.join(directory, 'read.json'); writePrivate(readerArtifact, readable)
      if (imported.status !== 'complete' || readable.status !== 'complete' || imported.evidence.structuralSha256 !== readable.evidence.structuralSha256
        || exported.evidence.rowCount !== readable.evidence.rowCount || exported.evidence.assetCount !== readable.evidence.assetCount) throw new Error('complete installed reader receipt differs')
      harness.writeTransferRequest(owned.containerId, 'native-request.json', { ...providerRequest, savedSnapshotSummary: exported.evidence.savedSnapshotSummary })
      let nativeOutput: string
      try {
        nativeOutput = harness.execTransferProviderExact(owned.containerId, ['node', '-e', REAL_NATIVE_READER, '/scratch/native-request.json', '/scratch/native-result.json'])
      } catch (error) {
        writePrivate(path.join(directory, 'native-failure.json'), { severity: 'error', event: 'opencode.real_rehearsal.native_failed', rootSessionId, candidateSha, imageDigest: manifest.imageDigest })
        // Preserve the owned consumer's private diagnostic before deleting
        // its exact volume; an absent startup log cannot authorize a receipt.
        try { await harness.captureTransferFileExact(owned.containerId, '/scratch/native-private.log', path.join(directory, 'native-failure.log')) } catch { /* startup may fail before its log is created */ }
        throw error
      }
      const native = JSON.parse(nativeOutput)
      if (native.rootSessionId !== rootSessionId || native.graphDigest !== root.graphDigest || native.nativeVersion !== '1.18.21'
        || native.providerUid !== 65534 || native.providerGid !== 0 || native.nativeReadableSessionCount < 1) throw new Error('actual pinned native graph receipt differs')
      for (const artifact of native.artifacts as { path: string; sha256: string }[]) {
        const captured = path.join(directory, path.basename(artifact.path))
        await harness.captureTransferFileExact(owned.containerId, artifact.path, captured)
        if (hashFile(captured) !== artifact.sha256) throw new Error('private native original bytes differ')
        artifact.path = captured
      }
      const nativeArtifact = path.join(directory, 'native.json'); writePrivate(nativeArtifact, native)
      const evidence = { rootSessionId, graphDigest: root.graphDigest, exportArtifact: request.receiptFile, importArtifact, readerArtifact, nativeArtifact,
        nativeReadableSessionCount: native.nativeReadableSessionCount as number, savedSnapshotSummary: exported.evidence.savedSnapshotSummary }
      writePrivate(path.join(directory, 'root-evidence.json'), evidence)
      return evidence
    },
    cleanup: async () => {
      const originalOwned = harness.transferOwnedIds(), cleanup = await harness.cleanup()
      if (!cleanup.ok) throw new Error('owned real-root cleanup failed')
      harness.verifyTransferCleanup(originalOwned)
      writePrivate(path.join(input.scratchDir, 'cleanup.json'), { status: 'complete', ...originalOwned })
    },
  })
  const receipt: RehearsalReceipt = { kind: 'real-root-rehearsal', candidateSha, imageDigest: manifest.imageDigest, sourceIdentity: manifest.sourceIdentity,
    targetScopeDigest: manifest.targetScopeDigest, runCount: 1, expectedRootCount: manifest.roots.length,
    exportedRootCount: rootEvidence.filter((root) => fs.existsSync(root.exportArtifact)).length,
    importedRootCount: rootEvidence.filter((root) => fs.existsSync(root.importArtifact)).length,
    nativeReadableRootCount: rootEvidence.filter((root) => fs.existsSync(root.nativeArtifact) && root.nativeReadableSessionCount > 0).length,
    failedRootCount: manifest.roots.length - rootEvidence.length, cleanupStatus: 'complete', rootEvidence }
  writePrivate(path.join(input.scratchDir, 'rehearsal-receipt.json'), receipt)
  return receipt
}

export function parseRehearsalArguments(args: string[]): { manifestFile: string; scratchDir: string } {
  if (args.length !== 6 || args[0] !== '--mode' || args[1] !== 'real'
    || args[2] !== '--manifest-file' || !path.isAbsolute(args[3] ?? '')
    || args[4] !== '--scratch-dir' || !path.isAbsolute(args[5] ?? '')) {
    throw new Error('required --mode real --manifest-file <private absolute file> --scratch-dir <fresh private directory>')
  }
  return { manifestFile: args[3]!, scratchDir: args[5]! }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRealRootRehearsal(parseRehearsalArguments(process.argv.slice(2))).then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`)).catch(() => {
    process.stderr.write(`${JSON.stringify({ severity: 'error', event: 'opencode.real_rehearsal.refused', reasonCode: 'real_source_or_lifecycle_not_qualified' })}\n`)
    process.exitCode = 1
  })
}
