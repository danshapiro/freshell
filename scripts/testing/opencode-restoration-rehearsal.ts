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
  failure?: (root: string | null, error: unknown) => void
}): Promise<RootRehearsalEvidence[]> {
  if (input.roots.length !== 7 || new Set(input.roots).size !== 7) throw new Error('seven exact distinct roots required')
  const completed: RootRehearsalEvidence[] = []
  const failed: string[] = []
  try {
    try { await input.prepare?.() } catch (error) { input.failure?.(null, error); throw error }
    for (const root of input.roots) {
      try {
        const evidence = await input.execute(root)
        if (evidence.rootSessionId !== root || !sha256(evidence.graphDigest) || !Number.isSafeInteger(evidence.nativeReadableSessionCount) || evidence.nativeReadableSessionCount < 1
          || [evidence.exportArtifact, evidence.importArtifact, evidence.readerArtifact, evidence.nativeArtifact].some((file) => !absolute(file) || !fs.statSync(file).isFile())) throw new Error('completed original root artifacts required')
        completed.push(evidence)
      } catch (error) { input.failure?.(root, error); failed.push(root) }
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

// These two functions also run in the owned reader child. Keep them independent
// of module state so private diagnostics use the same credential filtering.
export function redactNativeDiagnostic(text: string, secrets: readonly string[]): string {
  for (const secret of secrets) {
    if (!secret) continue
    text = text.split(secret).join('[redacted]')
    text = text.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]')
  }
  return text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\\?"?\s*[:=]\s*\\?"?)[^"'\\\s;,}]+/gi, '$1[redacted]')
}

export function nativeExecutionDetails(value: unknown): Record<string, unknown> {
  const error = value as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown; status?: unknown;
    signal?: unknown; killed?: unknown; stdout?: unknown; stderr?: unknown; error?: unknown; errors?: unknown[] }
  return { name: error?.name, message: error?.message ?? String(value), stack: error?.stack, code: error?.code,
    status: error?.status, signal: error?.signal, killed: error?.killed,
    stdout: error?.stdout == null ? undefined : String(error.stdout), stderr: error?.stderr == null ? undefined : String(error.stderr),
    error: error?.error == null ? undefined : nativeExecutionDetails(error.error),
    errors: Array.isArray(error?.errors) ? error.errors.map(nativeExecutionDetails) : undefined }
}

function nativeDiagnosticSecrets(extra: readonly string[] = []): string[] {
  return [...extra, ...Object.entries(process.env).filter(([key]) => /TOKEN|PASSWORD|SECRET|API_KEY|AUTHORIZATION/i.test(key))
    .map(([, value]) => value ?? '')]
}

export const REAL_NATIVE_READER = `const redactNativeDiagnostic = ${redactNativeDiagnostic.toString()};\nconst nativeExecutionDetails = ${nativeExecutionDetails.toString()};\n` + String.raw`
const fs=require('node:fs'),cp=require('node:child_process'),crypto=require('node:crypto'),{Readable}=require('node:stream'),{pipeline}=require('node:stream/promises');
const [requestFile,resultFile]=process.argv.slice(1),input=JSON.parse(fs.readFileSync(requestFile,'utf8'));
const descriptor=JSON.parse(fs.readFileSync(input.descriptorFile,'utf8')),manifest=JSON.parse(descriptor.manifestJson);
const sessions=manifest.rows.filter(row=>row.table==='session').map(row=>row.key[0].value),artifacts=[];
const deadline=Date.now()+(input.nativeBudgetMs||300000)-5000;
const remaining=()=>{const value=deadline-Date.now();if(value<1)throw Error('native owner budget expired');return value};
const sha=file=>{const fd=fs.openSync(file,'r'),b=Buffer.alloc(65536),hash=crypto.createHash('sha256');try{for(;;){const n=fs.readSync(fd,b);if(!n)break;hash.update(b.subarray(0,n))}}finally{fs.closeSync(fd)}return hash.digest('hex')};
const status=fs.readFileSync('/proc/self/status','utf8');
if(process.getuid()!==65534||process.getgid()!==0||!/^CapEff:\s+0+$/m.test(status)||!/^NoNewPrivs:\s+1$/m.test(status))throw Error('provider boundary differs');
if(cp.execFileSync('opencode',['--version'],{encoding:'utf8',timeout:Math.min(30000,remaining()),killSignal:'SIGKILL'}).trim()!=='1.18.21')throw Error('native version differs');
const log=fs.openSync('/scratch/native-private.log','wx',0o600),server=cp.spawn('opencode',['serve','--hostname','127.0.0.1','--port','4199'],{cwd:input.workspacePath,stdio:['ignore',log,log]});fs.closeSync(log);
let serverError,serverClosed=false;const closed=new Promise(resolve=>{server.once('error',error=>{serverError=error});server.once('close',()=>{serverClosed=true;resolve()})});
let validation;
const settled=()=>serverClosed||server.exitCode!==null||server.signalCode!==null;
const stopServer=async()=>{if(settled())return;let force,limit;try{server.kill('SIGTERM');force=setTimeout(()=>{if(!settled())server.kill('SIGKILL')},2000);await Promise.race([closed,new Promise((_,reject)=>{limit=setTimeout(()=>reject(Error('native child settlement unresolved')),4000)})])}finally{clearTimeout(force);clearTimeout(limit)}};
(async()=>{let count=0,result,operationError;try{
for(let n=0;n<200;n++){if(serverError||settled())throw Error('native startup failed');try{if((await fetch('http://127.0.0.1:4199/global/health',{signal:AbortSignal.timeout(Math.min(500,remaining()))})).ok)break}catch{}if(n===199)throw Error('native startup failed');await new Promise(r=>setTimeout(r,100))}
if(serverError||settled())throw Error('native startup child did not survive health read');
const get=async(route,file)=>{const signal=AbortSignal.timeout(Math.min(120000,remaining()));const r=await fetch('http://127.0.0.1:4199'+route,{headers:{'x-opencode-directory':input.workspacePath},signal});if(!r.ok||!r.body)throw Error('typed native read failed');await pipeline(Readable.fromWeb(r.body),fs.createWriteStream(file,{mode:0o600,flags:'wx'}),{signal});return r.headers.get('x-next-cursor')};
for(const session of sessions){
 if(!/^ses_[a-zA-Z0-9_-]+$/.test(session))throw Error('native session ID differs');
 const infoFile='/scratch/native-'+session+'-info.json';await get('/session/'+encodeURIComponent(session),infoFile);
 const expectedCount=manifest.rows.filter(row=>row.table==='message'&&row.key.length===1).length;
 const pages=[],cursors=new Set();let before='';
 for(let page=0;;page++){
  if(page>expectedCount)throw Error('native page count exceeds full selected graph');
  const file='/scratch/native-'+session+'-page-'+page+'.json';
  const cursor=await get('/session/'+encodeURIComponent(session)+'/message?limit=1'+(before?'&before='+encodeURIComponent(before):''),file);pages.push(file);
  if(cursor===null)break;if(!cursor||cursors.has(cursor))throw Error('native repeated or empty cursor');cursors.add(cursor);before=cursor;
 }
 const exportFile='/scratch/native-'+session+'-export.json',out=fs.openSync(exportFile,'wx',0o600);
 const exported=cp.spawnSync('opencode',['export',session],{cwd:input.workspacePath,stdio:['ignore',out,'pipe'],timeout:Math.min(180000,remaining()),killSignal:'SIGKILL',maxBuffer:1024*1024});fs.closeSync(out);
 if(exported.error||exported.status!==0||exported.signal){fs.appendFileSync('/scratch/native-private.log',exported.stderr||Buffer.alloc(0));throw Error('native export failed')};artifacts.push({path:exportFile,sha256:sha(exportFile)});
 const validationFile='/scratch/native-'+session+'-validation.json';fs.writeFileSync(validationFile,JSON.stringify({descriptorFile:input.descriptorFile,databaseFile:input.destinationDatabase,rootSessionId:input.rootSessionId,sessionId:session,infoFile,pageFiles:pages,exportFile}),{mode:0o600,flag:'wx'});
 const checked=cp.spawnSync('/opt/transfer-stage',['--stage','native','--request-file',validationFile],{cwd:input.workspacePath,encoding:'utf8',timeout:remaining(),killSignal:'SIGKILL',maxBuffer:1024*1024});
 if(checked.error||checked.status!==0||checked.signal){
  validation={sessionId:session,execution:nativeExecutionDetails(checked)};
  try{validation.diagnostic=JSON.parse(fs.readFileSync('/scratch/native-'+session+'-validation-error.json','utf8'))}
  catch(error){validation.diagnosticReadError=nativeExecutionDetails(error)}
  throw Error('native exact artifact validation failed');
 }
 // Preserve every original native page byte without holding a whole session.
 // One aggregate GET artifact avoids thousands of separate Docker captures.
 const readFile='/scratch/native-'+session+'-read.json',readFd=fs.openSync(readFile,'wx',0o600),buffer=Buffer.alloc(65536);
 const copy=file=>{const fd=fs.openSync(file,'r');try{for(;;){const n=fs.readSync(fd,buffer);if(!n)break;fs.writeSync(readFd,buffer.subarray(0,n))}}finally{fs.closeSync(fd)}};
 try{fs.writeSync(readFd,'{"info":');copy(infoFile);fs.writeSync(readFd,',"pages":[');for(let n=0;n<pages.length;n++){if(n)fs.writeSync(readFd,',');copy(pages[n])}fs.writeSync(readFd,']}');fs.fsyncSync(readFd)}finally{fs.closeSync(readFd)}
 artifacts.push({path:readFile,sha256:sha(readFile)});count++;
}
if(count!==sessions.length||count<1)throw Error('native read selection incomplete');
result={rootSessionId:input.rootSessionId,graphDigest:descriptor.sourceGeneration,nativeVersion:'1.18.21',nativeReadableSessionCount:count,providerUid:process.getuid(),providerGid:process.getgid(),snapshotSummary:input.savedSnapshotSummary,artifacts};
}catch(error){operationError=error;throw error}finally{try{await stopServer()}catch(error){throw operationError?new AggregateError([operationError,error],'native operation and child settlement failed'):error}}
fs.writeFileSync(resultFile,JSON.stringify(result),{mode:0o600,flag:'wx'});process.stdout.write(JSON.stringify(result));
})().catch(error=>{
 const secrets=Object.entries(process.env).filter(([key])=>/TOKEN|PASSWORD|SECRET|API_KEY|AUTHORIZATION/i.test(key)).map(([,value])=>value||'');
 try{fs.writeFileSync('/scratch/native-failure-private.json',redactNativeDiagnostic(JSON.stringify({error:nativeExecutionDetails(error),validation}),secrets),{mode:0o600,flag:'wx'})}
 catch{process.stderr.write(JSON.stringify({severity:'error',event:'opencode.real_rehearsal.diagnostic_failed',reasonCode:'private_diagnostic_write_failed'})+'\n')}
 process.stderr.write(JSON.stringify({severity:'error',event:'opencode.real_rehearsal.native_refused',reasonCode:'native_read_failed'})+'\n');process.exitCode=1});`

// Full imported graphs remain subject to the existing 8GiB payload ceiling.
// Native historical006 projections were <=49MB/session and <=17MB/message.
// Two GiB permits the separate Node reader, pinned serve/export and streaming
// validator together, without enlarging swap. Native peak remains empirical.
export function realTransferPolicy(payloadBytes: number, sessionCount: number) {
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 1 || payloadBytes > 8 * 1024 ** 3
    || !Number.isSafeInteger(sessionCount) || sessionCount < 1) throw new Error('complete selected transfer sizing required')
  // Budget copies at 4MiB/s, two native startups/reads per session at 30s,
  // plus the existing ten-minute import/read allowance; never exceed two hours.
  const lifecycleMs = 600_000 + Math.ceil(payloadBytes / (4 * 1024 ** 2)) * 2_000 + sessionCount * 30_000
  if (lifecycleMs > 7_200_000) throw new Error('selected complete root exceeds finite transfer ceiling')
  return { lifecycleMs, operationTimeoutMs: Math.min(lifecycleMs - 5_000, 2_670_000), cleanupTimeoutMs: 30_000, memoryBytes: 2 * 1024 ** 3 }
}

export async function readRehearsalPreflight(manifest: RehearsalManifest, token: string, options: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2_670_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_670_000) throw new Error('finite real preflight budget required')
  const response = await fetch(manifest.preflightUrl, { method: 'POST', headers: { 'x-auth-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ sourceStoreId: manifest.sourceIdentity, rootSessionIds: manifest.roots.map((root) => root.rootSessionId), expectedControlEpoch: manifest.expectedControlEpoch }), signal: AbortSignal.timeout(timeoutMs) })
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

export async function readNativeRehearsal(harness: RuntimeHarness, containerId: string, directory: string,
  context: { rootSessionId: string; candidateSha: string; imageDigest: string }, secrets: readonly string[] = []): Promise<string> {
  try {
    return harness.execTransferProviderExact(containerId, ['node', '-e', REAL_NATIVE_READER, '/scratch/native-request.json', '/scratch/native-result.json'])
  } catch (error) {
    const captureErrors: unknown[] = [], redactions = nativeDiagnosticSecrets(secrets)
    // Capture each private source independently, before the caller removes the
    // volume. A missing startup log must not hide a validator's own diagnostic.
    for (const [source, name] of [['native-private.log', 'native-failure.log'], ['native-failure-private.json', 'native-failure-private.json']] as const) {
      const destination = path.join(directory, name)
      try {
        await harness.captureTransferFileExact(containerId, '/scratch/' + source, destination)
        fs.chmodSync(destination, 0o600)
        fs.writeFileSync(destination, redactNativeDiagnostic(fs.readFileSync(destination, 'utf8'), redactions))
      } catch (captureError) { captureErrors.push(nativeExecutionDetails(captureError)) }
    }
    try {
      fs.writeFileSync(path.join(directory, 'native-failure.json'), redactNativeDiagnostic(JSON.stringify({ severity: 'error',
        event: 'opencode.real_rehearsal.native_failed', ...context, execution: nativeExecutionDetails(error), captureErrors }), redactions), { mode: 0o600, flag: 'wx' })
    } catch (diagnosticError) {
      throw new AggregateError([error, diagnosticError], 'native read and private diagnostic capture failed')
    }
    throw error
  }
}

export async function runRealRootRehearsal(input: { manifestFile: string; scratchDir: string; repoRoot?: string }): Promise<RehearsalReceipt> {
  assertPrivateInput(input.manifestFile)
  const repoRoot = fs.realpathSync(input.repoRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'))
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
  const adapter = path.join(harness.testRoot, 'transfer-stage')
  const schema = path.join(repoRoot, 'crates/freshell-sessions/src/opencode_schema_v1_18_21.sql')
  const migrations = path.join(harness.testRoot, 'migrations.json')
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
  const phases = new Map<string | null, string>([[null, 'prepare']])
  const rootEvidence = await dispatchRehearsalRoots({ roots: manifest.roots.map((root) => root.rootSessionId),
    prepare: async () => {
      await harness.prepareTransfer(manifest.imageDigest)
      fs.copyFileSync(path.join(repoRoot, 'target/release/examples/opencode_restoration_rehearsal'), adapter); fs.chmodSync(adapter, 0o755)
      fs.writeFileSync(migrations, '[]', { mode: 0o644, flag: 'wx' }); fs.chmodSync(migrations, 0o644)
      for (const request of requests) fs.mkdirSync(path.dirname(request.receiptFile), { mode: 0o700 })
      const exportRequest = path.join(input.scratchDir, 'export-batch-request.json'); writePrivate(exportRequest, requests)
      // Keep qualification alive for the complete batch, within the previous
      // cumulative export budget. Per-root import/read/native checks follow.
      await stage(adapter, ['--stage', 'export', '--request-file', exportRequest], { cwd: repoRoot, timeout: 600_000 * requests.length, maxBuffer: 1024 * 1024 })
    },
    execute: async (rootSessionId) => {
      phases.set(rootSessionId, 'export_receipt')
      const root = rootById.get(rootSessionId)!, index = manifest.roots.indexOf(root)
      const directory = path.join(input.scratchDir, `root-${index}`), request = requests[index]!
      const exported = JSON.parse(fs.readFileSync(request.receiptFile, 'utf8'))
      if (exported.status !== 'complete' || exported.evidence.sourceStoreId !== manifest.sourceIdentity || exported.evidence.graphDigest !== root.graphDigest) throw new Error('original source export differs from preflight')
      const descriptor = JSON.parse(fs.readFileSync(request.descriptorFile, 'utf8'))
      const selected = JSON.parse(descriptor.manifestJson)
      const policy = realTransferPolicy(fs.statSync(request.payloadFile).size, selected.rows.filter((row: { table: string }) => row.table === 'session').length)
      phases.set(rootSessionId, 'provider_allocation')
      const owned = harness.startTransferProvider(adapter, schema, migrations, [root.workspacePath], policy)
      const inspection = harness.inspectContainer(owned.containerId)
      if (inspection.Image !== manifest.imageDigest || inspection.Config.User !== '65534:0' || inspection.HostConfig.CapAdd?.length
        || !inspection.HostConfig.ReadonlyRootfs || inspection.HostConfig.NetworkMode !== 'none') throw new Error('owned provider policy differs')
      harness.execTransferProviderExact(owned.containerId, ['node', '-e', 'const fs=require("node:fs");for(const p of ["/scratch/provider/.local/share/opencode","/scratch/provider/.config","/scratch/provider/.cache"])fs.mkdirSync(p,{recursive:true,mode:0o700})'])
      phases.set(rootSessionId, 'copy')
      await harness.copyTransferFileExact(owned.containerId, request.descriptorFile, '/scratch/descriptor.json')
      await harness.copyTransferFileExact(owned.containerId, request.payloadFile, '/scratch/payload.bin')
      const providerRequest = { ...request, descriptorFile: '/scratch/descriptor.json', payloadFile: '/scratch/payload.bin', receiptFile: '/scratch/import.json', sourceSnapshot: undefined }
      harness.writeTransferRequest(owned.containerId, 'import-request.json', providerRequest)
      phases.set(rootSessionId, 'import')
      const imported = JSON.parse(harness.execTransferProviderExact(owned.containerId, ['/opt/transfer-stage', '--stage', 'import', '--request-file', '/scratch/import-request.json']))
      const importArtifact = path.join(directory, 'import.json'); writePrivate(importArtifact, imported)
      harness.writeTransferRequest(owned.containerId, 'read-request.json', { ...providerRequest, receiptFile: '/scratch/read.json' })
      phases.set(rootSessionId, 'installed_read')
      const readable = JSON.parse(harness.execTransferProviderExact(owned.containerId, ['/opt/transfer-stage', '--stage', 'read', '--request-file', '/scratch/read-request.json']))
      const readerArtifact = path.join(directory, 'read.json'); writePrivate(readerArtifact, readable)
      if (imported.status !== 'complete' || readable.status !== 'complete' || imported.evidence.structuralSha256 !== readable.evidence.structuralSha256
        || exported.evidence.rowCount !== readable.evidence.rowCount || exported.evidence.assetCount !== readable.evidence.assetCount) throw new Error('complete installed reader receipt differs')
      harness.writeTransferRequest(owned.containerId, 'native-request.json', { ...providerRequest, savedSnapshotSummary: exported.evidence.savedSnapshotSummary, nativeBudgetMs: policy.operationTimeoutMs })
      phases.set(rootSessionId, 'native_read_export')
      const nativeOutput = await readNativeRehearsal(harness, owned.containerId, directory,
        { rootSessionId, candidateSha, imageDigest: manifest.imageDigest }, [token])
      const native = JSON.parse(nativeOutput)
      if (native.rootSessionId !== rootSessionId || native.graphDigest !== root.graphDigest || native.nativeVersion !== '1.18.21'
        || native.providerUid !== 65534 || native.providerGid !== 0 || native.nativeReadableSessionCount < 1) throw new Error('actual pinned native graph receipt differs')
      // Recheck the complete qualified history after native children settle.
      // The existing current reader admits the pinned native project's normal
      // discovery timestamp refresh while protecting imported history/identity.
      phases.set(rootSessionId, 'installed_read_after_native')
      harness.writeTransferRequest(owned.containerId, 'read-after-native-request.json', { ...providerRequest, receiptFile: '/scratch/read-after-native.json', currentProjection: true })
      const afterNative = JSON.parse(harness.execTransferProviderExact(owned.containerId, ['/opt/transfer-stage', '--stage', 'read', '--request-file', '/scratch/read-after-native-request.json']))
      if (afterNative.status !== 'complete' || afterNative.evidence.rootSessionId !== rootSessionId || afterNative.evidence.projection !== 'current') throw new Error('native reader changed qualified installed history')
      writePrivate(path.join(directory, 'read-after-native.json'), afterNative)
      phases.set(rootSessionId, 'capture')
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
    failure: (rootSessionId, error) => {
      const directory = rootSessionId === null ? input.scratchDir : path.dirname(requests[manifest.roots.findIndex(root => root.rootSessionId === rootSessionId)]!.receiptFile)
      const cause = error as { code?: unknown; signal?: unknown; killed?: unknown }
      writePrivate(path.join(directory, 'stage-failure.json'), { severity: 'error', event: 'opencode.real_rehearsal.stage_failed',
        stage: phases.get(rootSessionId), rootSessionId, candidateSha, imageDigest: manifest.imageDigest,
        reasonCode: cause.code === 'ETIMEDOUT' || cause.signal === 'SIGKILL' ? 'owner_timeout_or_signal' : 'stage_refused' })
      fs.writeFileSync(path.join(directory, 'stage-failure-private.log'), redactNativeDiagnostic(String(error), nativeDiagnosticSecrets([token])).slice(0, 1024 * 1024), { mode: 0o600, flag: 'wx' })
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
