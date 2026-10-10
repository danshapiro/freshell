// Synthetic, zero-prompt fixtures only. Never a native LIVE/readiness receipt.
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { createHmac, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { RuntimeHarness, newSoul, newRequest, type SupervisorInstance, type AdminReply, type RuntimeWebFactory, type RuntimeWebHandle } from './runtime-sandbox.js'

const ROOT = 'ses_task002syntheticroot'
const CHILD = 'ses_task002syntheticchild'
const HOME = '/home/freshell/provider'
const DATABASE = `${HOME}/.local/share/opencode/opencode.db`
const selected = ['synthetic config-blocked exact retry', 'synthetic legacy retained-runtime exact retry', 'synthetic concurrent one writer', 'synthetic interrupted retry'] as const

function data(reply: any, kind: string): any {
  if (reply?.kind !== kind) throw new Error(`expected ${kind}`)
  return reply.data
}
function healthEpoch(health: any): number {
  const value = health.controlEpoch ?? health.control_epoch
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('supervisor health has no valid control epoch')
  return value
}
async function epoch(h: RuntimeHarness, s: SupervisorInstance): Promise<number> {
  return healthEpoch(data(await h.adminOk(s, { method: 'health' }), 'health'))
}
async function inventory(h: RuntimeHarness, s: SupervisorInstance): Promise<any[]> {
  return data(await h.adminOk(s, h.inventoryBody()), 'inventory')
}
async function oldOk(h: RuntimeHarness, s: SupervisorInstance, body: any): Promise<any> {
  const reply = await h.adminEnvelopeRaw(s, { protocolVersion: 1, requestId: newRequest(), role: 'web', auth: s.controlSecret, body })
  if (reply.result.Err || !('Ok' in reply.result)) throw new Error('historical creator request failed')
  return reply.result.Ok
}
async function retainedHostStatus(h:RuntimeHarness, supervisor:SupervisorInstance, launch:any, legacy:boolean):Promise<any> {
  const incarnationId=launch.view.incarnationId
  const runtime=h.runtimeDir(supervisor,incarnationId)
  const secret=fs.readFileSync(path.join(runtime,'secret'))
  const auth=createHmac('sha256',secret).update('command-auth').update(Buffer.from([0])).update(launch.hostBootId).update(Buffer.from([0])).update(incarnationId).digest('hex')
  const requestId=newRequest()
  const payload=Buffer.from(JSON.stringify({protocolVersion:legacy?1:2,requestId,role:'supervisor',auth,body:{method:'status',params:{incarnation_id:incarnationId}}}))
  const frame=Buffer.alloc(4+payload.length);frame.writeUInt32BE(payload.length);payload.copy(frame,4)
  return await new Promise((resolve,reject)=>{
    const socket=net.createConnection(path.join(runtime,'host.sock'));const chunks:Buffer[]=[];let bytes=0
    socket.setTimeout(10000,()=>socket.destroy(new Error('owned retained host status timed out')))
    socket.on('error',reject);socket.on('connect',()=>socket.end(frame))
    socket.on('data',chunk=>{bytes+=chunk.length;if(bytes>1024*1024)socket.destroy(new Error('retained host status exceeds its bound'));else chunks.push(chunk)})
    socket.on('end',()=>{try {const all=Buffer.concat(chunks);if(all.length<4 || all.readUInt32BE(0)!==all.length-4)throw new Error('retained status frame differs');const reply=JSON.parse(all.subarray(4).toString());if(reply.requestId!==requestId || reply.result?.Ok?.kind!=='status')throw new Error('retained status authentication or response differs');resolve(reply.result.Ok.data)}catch(error){reject(error)}})
  })
}

function ownedRecord(h: RuntimeHarness, s: SupervisorInstance, soulId: string): any {
  return JSON.parse(h.execOwnedContainerExact(s.containerId, ['python3', '-c',
    "import sqlite3,json,sys; c=sqlite3.connect('file:/var/lib/freshell-supervisor/runtime.sqlite3?mode=ro',uri=True); c.row_factory=sqlite3.Row; i=c.execute('SELECT * FROM incarnations WHERE soul_id=? ORDER BY created_at DESC LIMIT 1',(sys.argv[1],)).fetchone(); a=c.execute('SELECT count(*) FROM recovery_attempts WHERE soul_id=?',(sys.argv[1],)).fetchone()[0]; w=c.execute('SELECT count(*) FROM writer_claims WHERE soul_id=?',(sys.argv[1],)).fetchone()[0]; print(json.dumps({'incarnation':dict(i),'attemptCount':a,'writerClaims':w}))", soulId]))
}

function mountSnapshot(mounts: unknown[]): string {
  // Docker returns this list from a map; order is not mount identity. Keep
  // every complete record and duplicate while comparing the same topology.
  return JSON.stringify(mounts.map(mount => JSON.stringify(mount)).sort())
}

const SWAP_NEGATIVE_CONTAINER = String.raw`
import sqlite3,sys,json
soul,incarnation,original,negative,digest,direction=sys.argv[1:]
if direction not in ('inject','restore'):raise RuntimeError('invalid fault injection direction')
c=sqlite3.connect('/var/lib/freshell-supervisor/runtime.sqlite3',timeout=10)
try:
 c.execute('BEGIN IMMEDIATE')
 row=c.execute('SELECT container_id,immutable_config_digest FROM incarnations WHERE soul_id=? AND incarnation_id=?',(soul,incarnation)).fetchone()
 if row is None or row[1]!=digest:raise RuntimeError('exact fixture incarnation/digest fence differs')
 expected,target=(original,negative) if direction=='inject' else (negative,original)
 if direction=='restore' and row[0]==original:pass
 elif row[0]!=expected:raise RuntimeError('fixture container ID fence differs; refusing overwrite')
 else:
  count=c.execute('UPDATE incarnations SET container_id=? WHERE soul_id=? AND incarnation_id=? AND container_id=? AND immutable_config_digest=?',(target,soul,incarnation,expected,digest)).rowcount
  if count!=1:raise RuntimeError('exact single incarnation update required')
 c.commit()
 print(json.dumps({'containerId':target,'direction':direction}))
finally:c.close()
`

async function legacyNegativeMounts(
  h: RuntimeHarness, current: SupervisorInstance, first: SupervisorInstance,
  launch: any, soulId: string, caseId: string,
): Promise<void> {
  const originalId = launch.view.containerId
  const baseline = ownedRecord(h, current, soulId)
  const incarnation = baseline.incarnation.incarnation_id
  const digest = baseline.incarnation.immutable_config_digest
  const source = h.inspectContainer(originalId)
  const writerPid = h.ownedContainerHostPidExact(originalId)
  const soulIdentity = () => JSON.parse(h.execOwnedContainerExact(current.containerId, ['python3', '-c',
    "import sqlite3,json,sys; c=sqlite3.connect('file:/var/lib/freshell-supervisor/runtime.sqlite3?mode=ro',uri=True); c.row_factory=sqlite3.Row; s=c.execute('SELECT soul_id,provider,provider_store_id,native_session_id,provider_volume_name FROM souls WHERE soul_id=?',(sys.argv[1],)).fetchone(); n=c.execute('SELECT count(*) FROM incarnations WHERE soul_id=?',(sys.argv[1],)).fetchone()[0]; print(json.dumps({'identity':dict(s),'incarnationCount':n}))", soulId]))
  const identity = soulIdentity()
  const nativeGraph = () => JSON.parse(h.execOwnedContainerAsExact(originalId, '65534:0', ['python3', '-c',
    "import sqlite3,json,os; c=sqlite3.connect('file:/home/freshell/provider/.local/share/opencode/opencode.db?mode=ro',uri=True); ids=('ses_task002syntheticroot','ses_task002syntheticchild'); sessions=c.execute('SELECT id,parent_id FROM session WHERE id IN (?,?) ORDER BY id',ids).fetchall(); counts={table:c.execute('SELECT count(*) FROM '+table+' WHERE session_id IN (?,?)',ids).fetchone()[0] for table in ('message','part')}; print(json.dumps({'sessions':sessions,'counts':counts}))"]))
  const graph = nativeGraph()
  h.assert(caseId, graph.sessions.length === 2 && graph.counts.message === 2 && graph.counts.part === 2,
    'negative fixture begins with the exact retained synthetic native graph')
  const faults = [
    ['extra_mount', 'OLD_RUNTIME_NOT_EMPTY', 'runtime gained extra, duplicate, or missing mounts'],
    ['missing_tmpfs', 'CAPABILITY_PENDING', 'owned_launch_policy_mismatch'],
    ['missing_binary', 'OLD_RUNTIME_NOT_EMPTY', 'runtime mount topology changed'],
    ['foreign_binary', 'OLD_RUNTIME_NOT_EMPTY', 'runtime mount topology changed'],
  ] as const
  const results: unknown[] = []
  for (const [fault, expectedReason, expectedMatcher] of faults) {
    const negativeId = h.createTask2LegacyNegativeContainerExact(originalId, fault)
    const eventOffset = h.broker.eventsSnapshot().length
    const lifecyclePath = path.join(path.dirname(current.runtimeRoot), 'evidence/lifecycle.jsonl')
    const lifecycleOffset = fs.readFileSync(lifecyclePath, 'utf8').length
    try {
      // Always restore even when exec loses its response after committing.
      h.execOwnedContainerExact(current.containerId, ['python3', '-c', SWAP_NEGATIVE_CONTAINER,
        soulId, incarnation, originalId, negativeId, digest, 'inject'])
      const probe = data(await h.adminOk(current, h.probeRecoveryBody(soulId, 3)), 'recovery_probe')
      const row = ownedRecord(h, current, soulId)
      const diagnostics = fs.readFileSync(lifecyclePath, 'utf8').slice(lifecycleOffset).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      h.assert(caseId, diagnostics.some(event => event.data?.severity === 'warn'
        && event.data.soulId === soulId && event.data.incarnationId === incarnation
        && event.data.blockReason === expectedReason && event.data.matcherReason === expectedMatcher
        && event.data.attemptReserved === false), `${fault} logs its precise fenced reason before reservation`)
      h.assert(caseId, probe.kind === 'blocked' && probe.data?.reason === expectedReason
        && probe.data?.retry_hint?.repair === expectedMatcher && probe.data?.evidence?.includes(expectedMatcher),
        `actual ${fault} receives its exact pre-attempt matcher reason`, { fault, probe })
      h.assert(caseId, h.broker.eventsSnapshot().slice(eventOffset).some(event => event.decision === 'forward'
        && event.method === 'GET' && event.url === `/v1.47/containers/${negativeId}/json`
        && event.containerId === negativeId && event.ownerContainerId === originalId),
        `${fault} exercised the actual Docker inspector rather than a broker refusal`)
      h.assert(caseId, row.attemptCount === baseline.attemptCount && row.writerClaims === baseline.writerClaims,
        `${fault} consumes no recovery budget or writer claim`)
      const normalized = { ...row.incarnation, container_id: originalId }
      h.assert(caseId, row.incarnation.container_id === negativeId
        && JSON.stringify(normalized) === JSON.stringify(baseline.incarnation)
        && JSON.stringify(soulIdentity()) === JSON.stringify(identity),
        `${fault} preserves every saved field, digest, root, store and incarnation count`)
      const actual = h.inspectContainer(originalId)
      h.assert(caseId, actual.State.Running === true && actual.State.Pid === writerPid
        && actual.Image === source.Image, `${fault} preserves the exact healthy original process and image`)
      h.assert(caseId, mountSnapshot(actual.Mounts) === mountSnapshot(source.Mounts),
        `${fault} preserves every original mount field and duplicate`, { sourceMounts: source.Mounts, actualMounts: actual.Mounts })
      h.assert(caseId, JSON.stringify(nativeGraph()) === JSON.stringify(graph)
        && (await retainedHostStatus(h, first, launch, true)).exited === false,
        `${fault} preserves the exact native graph and authenticated alive status`)
      h.assert(caseId, h.inspectContainer(negativeId).State.Status === 'created'
        && h.broker.destructiveRequestsFor(negativeId).length === 0,
        `${fault} negative enclosure never starts and acquires no mutation authority`)
      results.push({ fault, fullNegativeContainerId: negativeId, fullOriginalContainerId: originalId,
        probe, attemptCount: row.attemptCount, writerClaims: row.writerClaims })
    } finally {
      const restore = () => h.execOwnedContainerExact(current.containerId, ['python3', '-c', SWAP_NEGATIVE_CONTAINER,
        soulId, incarnation, originalId, negativeId, digest, 'restore'])
      try { restore() } catch { restore() } // idempotent response-loss retry, still exact/fenced
      h.assert(caseId, ownedRecord(h, current, soulId).incarnation.container_id === originalId,
        `${fault} restores the exact original container ID before cleanup`)
      // A failed restore fails the matrix and leaves the tracked object for the
      // outer disposable-rig teardown; it cannot continue to positive retry.
      h.removeTask2LegacyNegativeContainerExact(negativeId)
    }
  }
  h.writeArtifact('task2-legacy-negative-mounts.json', { kind: 'synthetic-task2-negative-inspection',
    nativeQualified: false, selectedCount: faults.length, executedCount: results.length,
    savedDigest: digest, imageDigest: source.Image, results })
}
// Shared by the provider-bound wrapper and source-only pinned-schema SQL tests.
export const TASK2_RETAINED_SEED_SQL = String.raw`
project='task002_project'
if preserve_native_root:
 c.execute('BEGIN IMMEDIATE')
 existing=c.execute('SELECT project_id,parent_id,directory FROM session WHERE id=?',(root,)).fetchone()
 if existing is None or existing[1] is not None or existing[2]!=workspace:raise RuntimeError('retained native root missing or not the exact parentless workspace root')
 project=existing[0]
 if c.execute('SELECT id FROM project WHERE id=?',(project,)).fetchone() is None:raise RuntimeError('retained native root project missing')
 if c.execute('SELECT id FROM session WHERE id=? OR parent_id=?',(child,root)).fetchone() is not None:raise RuntimeError('retained native root already has a child or descendant')
 for table in ('message','part','session_input','session_message'):
  if c.execute('SELECT 1 FROM '+table+' WHERE session_id=? LIMIT 1',(root,)).fetchone() is not None:raise RuntimeError('retained native root is nonempty')
else:
 c.execute("INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES (?,?,?,?,?)",(project,workspace,1,1,'[]'))
 c.execute('INSERT INTO project_directory (project_id,directory,time_created) VALUES (?,?,?)',(project,workspace,1))
for ident,parent in [(root,None),(child,root)]:
 if ident!=root or not preserve_native_root:
  c.execute('INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES (?,?,?,?,?,?,?,?,?)',(ident,project,parent,'fixture',workspace,'synthetic fixture','1.18.21',1,1))
 message_id='msg_'+ident[4:]
 c.execute('INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)',(message_id,ident,1,1,json.dumps({'role':'user','agent':'build','model':{'providerID':'openai','modelID':'gpt-5.6-luna'},'time':{'created':1}})))
 c.execute('INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)',('prt_'+ident,message_id,ident,1,1,json.dumps({'type':'file','mime':'text/plain','filename':'asset.txt','url':'file://'+workspace+'/asset.txt'})))
 if ident!=root or not preserve_native_root:
  info={'id':ident,'slug':'fixture','projectID':project,'directory':workspace,'title':'synthetic fixture','version':'1.18.21','time':{'created':1,'updated':1}}
  if parent:info['parentID']=parent
  c.execute('INSERT INTO event_sequence (aggregate_id,seq,owner_id) VALUES (?,1,?)',(ident,'task002_fixture'))
  c.execute('INSERT INTO event (id,aggregate_id,seq,type,data) VALUES (?,?,1,?,?)',('evt_'+ident,ident,'session.created.1',json.dumps({'sessionID':ident,'info':info})))
`
const SEED = String.raw`
import sqlite3,os,sys,json,time
workspace,root,child=sys.argv[1:4]
preserve_native_root=len(sys.argv)==5 and sys.argv[4]=='preserve_native_root'
status=open('/proc/self/status').read()
if os.geteuid()!=65534 or os.getegid()!=0 or not any(line.startswith('CapEff:') and int(line.split()[1],16)==0 for line in status.splitlines()) or 'NoNewPrivs:\t1' not in status:raise RuntimeError('provider identity/capability boundary differs')
database='/home/freshell/provider/.local/share/opencode/opencode.db'
for _ in range(100):
 if os.path.isfile(database):
  c=sqlite3.connect(database)
  if c.execute("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='session'").fetchone()[0]:break
  c.close()
 time.sleep(.1)
else:raise RuntimeError('native initialization did not create pinned store')
` + TASK2_RETAINED_SEED_SQL + String.raw`
c.commit(); c.close()
print(json.dumps({'root':root,'child':child,'providerUid':os.geteuid(),'providerGid':os.getegid(),'capEff':'0','noNewPrivileges':1}))
`

async function producer(h: RuntimeHarness, supervisor: SupervisorInstance, scenario: string, webFactory: RuntimeWebFactory): Promise<RuntimeWebHandle> {
  const server = webFactory({ binary: h.task2ServerBinary, repoRoot: h.repoRoot, candidateSha: h.candidateSha,
    buildDirty: !!h.runCommand('git', ['status', '--porcelain'], { cwd: h.repoRoot }).trim(), homeDir: path.join(h.testRoot, 'web-home', scenario), preserveHomeOnStop: true,
    stripEnvPrefixes: ['FRESHELL_RUNTIME_CAPABILITY_DIR', 'FRESHELL_RUNTIME_TRANSFER_STAGE_ROOT', 'ANTHROPIC_', 'OPENAI_', 'GEMINI_', 'ONECLI_', 'FRESHELL_MANAGED_CLAUDE_', 'FRESHELL_MANAGED_CODEX_', 'FRESHELL_MANAGED_OPENCODE_', 'FRESHELL_MANAGED_AMPLIFIER_'],
    env: { FRESHELL_BIND_HOST: '0.0.0.0', FRESHELL_MANAGED_RUNTIME_V1: '1',
      FRESHELL_RUNTIME_CONTROL_SOCKET: supervisor.controlSocket,
      FRESHELL_RUNTIME_CONTROL_SECRET_FILE: supervisor.controlSecretFile },
    setupHome: async home => { fs.mkdirSync(path.join(home, '.freshell'), { recursive: true }); fs.writeFileSync(path.join(home, '.freshell/config.json'), JSON.stringify({version:1,settings:{defaultCwd:h.testRoot,codingCli:{enabledProviders:['opencode']}}})) },
  })
  // Strip inherited grants in the fixture's child, while keeping these explicit
  // owned controller values. RustServer's final stripping runs after merging.
  try {
    const previous = process.env.FRESHELL_E2E_RUST_SERVER_BIN
    process.env.FRESHELL_E2E_RUST_SERVER_BIN = h.task2ServerBinary
    try { await server.start() } finally { if (previous === undefined) delete process.env.FRESHELL_E2E_RUST_SERVER_BIN; else process.env.FRESHELL_E2E_RUST_SERVER_BIN = previous }
    await h.waitForFile(path.join(path.dirname(supervisor.controlSocket), 'mcp.sock'))
    return server
  } catch (error) {
    try { await server.stop() }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'retained producer readiness and owned cleanup failed') }
    throw error
  }
}

async function selectedPreparation(supervisor: SupervisorInstance, soulId: string, workspace: string, tuiFormat: 'json' | 'jsonc'): Promise<any> {
  return await new Promise((resolve,reject) => {
    const socket=net.createConnection(path.join(path.dirname(supervisor.controlSocket), 'mcp.sock'))
    const chunks:Buffer[]=[]; let bytes=0
    socket.setTimeout(10000,()=>socket.destroy(new Error('configuration producer timed out')))
    socket.on('error',reject)
    socket.on('connect',()=>socket.end(JSON.stringify({action:'issue',controlSecret:supervisor.controlSecret,soulId,provider:'opencode',workspace,cwd:workspace,
      tuiSource:{root:'workspace',relativePath:`selected-tui.${tuiFormat}`,providerRelativePath:`.freshell/opencode/user-tui.${tuiFormat}`,format:tuiFormat}})))
    socket.on('data',chunk=>{ bytes+=chunk.length; if(bytes>256*1024)socket.destroy(new Error('configuration producer receipt exceeds bound'));else chunks.push(chunk) })
    socket.on('end',()=>{try {resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch {reject(new Error('configuration producer refused selected fixture inputs'))}})
  })
}

export type Task2RetainedBrowserPhase = 'store_blocked' | 'config_blocked' | 'replaced'
export type Task2RetainedBrowserContext = {
  h: RuntimeHarness
  web: RuntimeWebHandle
  supervisor: SupervisorInstance
  soulId: string
  rootSessionId: string
  childSessionId: string
  oldContainerId: string
  oldIncarnationId: string
  providerVolumeName: string
  configFile: string
  preferredTabId: string
  preferredPaneId: string
  title: string
  result?: AdminReply
}
export type Task2RetainedBrowserHooks = {
  // Observe the actual state before fixture repair/cleanup; never load a receipt.
  observe(context: Task2RetainedBrowserContext, phase: Task2RetainedBrowserPhase): Promise<void>
  // The browser owns this transaction. The driver must not issue another retry.
  retry(context: Task2RetainedBrowserContext, phase: 'config_fault' | 'repaired'): Promise<AdminReply>
}

async function observedRetainedRoot(h: RuntimeHarness, supervisor: SupervisorInstance, soulId: string, launch: any): Promise<string> {
  const refuse = (reasonCode: string): never => {
    h.recordLifecycle('task2.retained_native_root.refused', { severity: 'error', soulId, reasonCode })
    throw new Error(`observed retained native root ${reasonCode}`)
  }
  const schema = z.object({
    soulId: z.literal(soulId), incarnationId: z.string().min(1), provider: z.literal('opencode'),
    launchState: z.literal('running'), containerId: z.string().regex(/^[a-f0-9]{64}$/),
    nativeSessionId: z.string().regex(/^ses_[A-Za-z0-9]+$/).refine(root => root !== ROOT && root !== CHILD),
    evidenceRevision: z.number().int().nonnegative(),
    nativeIdentityObservation: z.object({ nativeSessionId: z.string(), incarnationId: z.string(),
      launchNonce: z.string().min(1), evidenceRevision: z.number().int().nonnegative(),
      source: z.literal('opencode_tui'), evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/) }),
  }).refine(view => view.nativeIdentityObservation.nativeSessionId === view.nativeSessionId
    && view.nativeIdentityObservation.incarnationId === view.incarnationId)
  const parsed = schema.safeParse(launch?.view)
  if (!parsed.success) return refuse('launch_binding_mismatch')
  const view = parsed.data, observation = view.nativeIdentityObservation
  const currentRows = (await inventory(h, supervisor)).filter(row => row.soulId === soulId)
  const current = schema.safeParse(currentRows[0])
  if (currentRows.length !== 1 || !current.success) return refuse('current_incarnation_mismatch')
  const currentView = current.data, currentObservation = currentView.nativeIdentityObservation
  // First identity recording advances the soul revision; the observation keeps
  // its launch revision. Correlate each domain against the current inventory.
  if (currentView.incarnationId !== view.incarnationId || currentView.containerId !== view.containerId
    || currentView.nativeSessionId !== view.nativeSessionId || currentView.evidenceRevision !== view.evidenceRevision
    || currentObservation.evidenceRevision !== observation.evidenceRevision
    || currentObservation.launchNonce !== observation.launchNonce
    || currentObservation.evidenceDigest !== observation.evidenceDigest) {
    return refuse('current_incarnation_mismatch')
  }
  h.recordLifecycle('task2.retained_native_root.bound', { severity: 'info', soulId,
    incarnationId: view.incarnationId, nativeSessionId: view.nativeSessionId, evidenceRevision: view.evidenceRevision })
  return view.nativeSessionId
}

export async function runTask2RetainedFixture(
  h: RuntimeHarness, legacy: boolean, webFactory: RuntimeWebFactory, browser?: Task2RetainedBrowserHooks, tuiFormat: 'json' | 'jsonc' = 'jsonc',
): Promise<void> {
  if (process.env.FRESHELL_RUNTIME_SYNTHETIC_RESUME !== '1') throw new Error('exact synthetic fixture gate is required')
  const caseId = selected[legacy ? 1 : 0]
  const scenarioId = `task2-${legacy ? 'legacy' : `config-${tuiFormat}`}`
  const workspace = path.join(h.testRoot, 'fixture-workspace', scenarioId)
  fs.mkdirSync(workspace, { recursive: true, mode: 0o777 }); fs.chmodSync(workspace, 0o777)
  // UID65534 must traverse the owned fixture parent; never chmod operator paths.
  fs.chmodSync(h.testRoot, 0o711)
  fs.chmodSync(path.dirname(workspace), 0o755)
  fs.writeFileSync(path.join(workspace, 'asset.txt'), 'synthetic fixture asset', { mode: 0o644 })
  fs.chmodSync(path.join(workspace, 'asset.txt'), 0o644)
  const configFile = path.join(workspace, 'opencode.json')
  fs.writeFileSync(configFile, '{"plugin":[]}', { mode: 0o644 })
  fs.chmodSync(configFile, 0o644)
  const tuiFile = path.join(workspace, `selected-tui.${tuiFormat}`)
  const initialTui = '{"theme":"task2-prior"}'
  const refreshedTui = tuiFormat === 'jsonc' ? '{ // refreshed selected TUI\n"theme":"task2-current"}' : '{"theme":"task2-current"}'
  if (!legacy) { fs.writeFileSync(tuiFile, initialTui, { mode: 0o644 }); fs.chmodSync(tuiFile, 0o644) }
  const first = await h.startSupervisor({ scenarioId, waitForHealth: !legacy,
    ...(legacy ? { binaryPath: path.join(h.buildDir, 'task002-legacy-supervisor'), hostBinaryPath: path.join(h.buildDir, 'task002-prefixed-session-host') } : {}) })
  if (legacy) await h.waitForFile(first.controlSocket)
  const firstEpoch = healthEpoch(data(await (legacy ? oldOk(h, first, { method: 'health' }) : h.adminOk(first, { method: 'health' })), 'health'))
  h.assert(caseId, firstEpoch === 1, 'scratch registry begins at epoch 1')
  const soulId = newSoul()
  let web = legacy ? undefined : await producer(h, first, scenarioId, webFactory)
  try {
  const preparation = legacy ? undefined : await selectedPreparation(first,soulId,workspace,tuiFormat)
  const terminal = {
    terminalId: `terminal-${randomUUID()}`, streamId: `stream-${randomUUID()}`, mode: 'opencode', program: 'opencode',
    args: [], cwd: workspace, workspacePath: workspace,
    runAsUid: 65534, runAsGid: 0, cols: 80, rows: 24, projectKey: scenarioId,
    env: { HOME, TMPDIR: '/run/opencode-tmp', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', XDG_DATA_HOME: `${HOME}/.local/share`, XDG_CONFIG_HOME: `${HOME}/.config`, XDG_CACHE_HOME: `${HOME}/.cache`,
      OPENCODE_DB: DATABASE, OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' },
    ...(!legacy ? { providerLaunchContext: preparation.context, providerSecretReferences: preparation.secretReferences } : {}),
  }
  const body = h.launchBody({ soulId, provider: 'opencode', providerStoreId: `store-${scenarioId}-${h.runId}`, ...(legacy ? { nativeSessionId: ROOT } : {}),
    terminal, limits: {cpuMilli:2000,memoryBytes:4*1024*1024*1024,swapBytes:0,pidsMax:512}, profile: 'default_agent', expectedControlEpoch: 1 })
  const launch = data(await (legacy ? oldOk(h, first, body) : h.adminOk(first, body)), 'launch')
  // Current launch completes only after provider-observed native creation. The
  // historical protocol1 fixture retains its original preassigned seed identity.
  const rootSessionId = legacy ? ROOT : await observedRetainedRoot(h, first, soulId, launch)
  const containerId = launch.view.containerId
  const readPublishedTui = (id: string) => h.execOwnedContainerAsExact(id, '65534:0', ['cat', `${HOME}/.freshell/opencode/user-tui.${tuiFormat}`])
  if (!legacy) h.assert(caseId, readPublishedTui(containerId) === initialTui, `${tuiFormat} actual callback recipe publishes selected TUI bytes under provider identity`)
  const inspected = h.inspectContainer(containerId)
  h.assert(caseId, /^[a-f0-9]{64}$/.test(containerId) && inspected.Id === containerId, 'saved enclosure uses full exact container identity')
  h.assert(caseId, inspected.Image === h.imageRef, 'saved enclosure uses exact immutable image')
  if (legacy) h.assert(caseId, JSON.stringify(Object.keys(inspected.HostConfig.Tmpfs).sort()) === JSON.stringify(['/run/opencode-tmp', '/tmp']), 'actual historical creator emitted only known legacy tmpfs')
  const seeded = JSON.parse(h.execOwnedContainerAsExact(containerId, '65534:0', ['python3', '-c', SEED, workspace, rootSessionId, CHILD,
    ...(!legacy ? ['preserve_native_root'] : [])]))
  h.assert(caseId, seeded.root === rootSessionId && seeded.child === CHILD && seeded.providerUid === 65534 && seeded.providerGid === 0, 'actual synthetic retained graph is seeded by provider identity')
  h.assert(caseId,(await retainedHostStatus(h,first,launch,legacy)).exited===false,'the actual retained provider remains alive after native initialization')
  const before = ownedRecord(h, first, soulId)
  if (legacy) h.assert(caseId, !('launch_policy' in before.incarnation), 'actual historical registry predates policy column')
  // Alive old reader + inaccessible actual SQLite store must not certify LIVE,
  // absence, loss, or reserve recovery budget. Native server receives no prompt.
  h.execOwnedContainerAsExact(containerId, '65534:0', ['chmod', '000', DATABASE])
  h.stopSupervisorExact(first); h.removeContainerExact(first.containerId)
  let current = await h.startSupervisor({ scenarioId, volumeName: first.volumeName })
  h.assert(caseId, await epoch(h, current) === 2, 'first supervisor reopen advances epoch to 2')
  if (!web) web = await producer(h, current, scenarioId, webFactory)
  const preferredTabId = `tab-task2-${randomUUID()}`
  const preferredPaneId = `pane-task2-${randomUUID()}`
  if (browser) {
    const view = (await inventory(h, current)).find(row => row.soulId === soulId)
    if (!view) throw new Error('retained browser fixture has no exact soul')
    await h.adminOk(current, h.upsertViewIntentBody({ soulId,
      expectedSoulIntentRevision: view.intentRevision, expectedControlEpoch: 2,
      intent: { ownerId: '', workspaceId: scenarioId, kind: 'automatic_primary',
        preferredTabId, preferredPaneId, title: caseId, visibility: 'visible' },
    }))
  }
  const browserContext = (result?: AdminReply): Task2RetainedBrowserContext => ({
    h, web: web!, supervisor: current, soulId, rootSessionId, childSessionId: CHILD,
    oldContainerId: containerId, oldIncarnationId: launch.view.incarnationId,
    providerVolumeName: inspected.Mounts.find((m: any) => m.Destination === HOME)?.Name,
    configFile, preferredTabId, preferredPaneId, title: caseId, result,
  })
  const blocked = data(await h.adminOk(current, h.recoverBody(soulId, 'manual_retry', 2)), 'recovery')
  const blockedRecord = ownedRecord(h, current, soulId)
  h.assert(caseId, blocked.outcome === 'blocked' && blockedRecord.attemptCount === before.attemptCount, 'blocked retained reader consumes no replacement attempt')
  h.assert(caseId, blocked.probe?.kind === 'blocked' && blocked.probe?.data?.reason === 'STORE_UNREADABLE', 'blocked alive store has the exact typed reader reason')
  const blockedEvents = fs.readFileSync(path.join(path.dirname(current.runtimeRoot), 'evidence/lifecycle.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  h.assert(caseId, blockedEvents.some(event => event.event === 'supervisor.recovery.preflight'
    && event.data?.severity === 'warn' && event.data.soulId === soulId
    && event.data.incarnationId === launch.view.incarnationId && event.data.controlEpoch === 2
    && event.data.blockReason === 'STORE_UNREADABLE' && typeof event.data.repair === 'string'
    && event.data.attemptReserved === false), 'blocked store logs its exact reader reason and repair before reserving an attempt')
  h.assert(caseId, h.inspectContainer(containerId).State.Running === true, 'blocked reader remains alive')
  h.assert(caseId,(await retainedHostStatus(h,first,launch,legacy)).exited===false,'an authenticated exited=false status must not bypass the blocked store')
  h.assert(caseId, blockedRecord.incarnation.container_id === containerId && blockedRecord.incarnation.immutable_config_digest === before.incarnation.immutable_config_digest, 'blocked upgrade preserves exact enclosure and saved digest')
  await browser?.observe(browserContext(), 'store_blocked')
  h.stopSupervisorExact(current); h.removeContainerExact(current.containerId)
  current = await h.startSupervisor({ scenarioId, volumeName: first.volumeName })
  h.assert(caseId, await epoch(h, current) === 3, 'second supervisor reopen advances epoch to 3')
  h.assert(caseId, ownedRecord(h, current, soulId).attemptCount === before.attemptCount, 'restart preserves zero unknown-store budget consumption')
  h.execOwnedContainerAsExact(containerId, '65534:0', ['chmod', '600', DATABASE])
  if (legacy) await legacyNegativeMounts(h, current, first, launch, soulId, caseId)
  const qualified = data(await h.adminOk(current, h.probeRecoveryBody(soulId, 3)), 'recovery_probe')
  h.writeArtifact(`${scenarioId}-preflight-status.json`,{kind:qualified.kind,reason:qualified.data?.reason,repair:qualified.data?.retry_hint?.repair})
  h.assert(caseId, qualified.kind === 'resume_ready', 'current-image worker qualifies actual full retained synthetic graph before reservation')
  if (!legacy) { fs.chmodSync(configFile, 0); fs.writeFileSync(tuiFile, refreshedTui) }
  let receipts = h.broker.receiptIds()
  if (!legacy) {
    const failed = browser ? await browser.retry(browserContext(), 'config_fault')
      : await h.adminRaw(current, h.recoverBody(soulId, 'manual_retry', 3))
    const row = ownedRecord(h, current, soulId)
    h.writeArtifact(`${scenarioId}-config-fault-status.json`, { outcome: failed.result.Ok?.data?.outcome, reason: failed.result.Ok?.data?.probe?.data?.reason, repair: failed.result.Ok?.data?.probe?.data?.retry_hint?.repair })
    h.assert(caseId, failed.result.Ok?.data?.outcome === 'blocked'
      && failed.result.Ok.data.probe?.data?.reason === 'CAPABILITY_PENDING'
      && failed.result.Ok.data.probe?.data?.retry_hint?.repair?.includes('provider configuration publication'),
      'actual unreadable selected config returns the typed publication blocker and repair hint')
    h.assert(caseId, row.incarnation.soul_id === soulId, 'config failure preserves same soul')
    await browser?.observe(browserContext(failed), 'config_blocked')
    fs.chmodSync(configFile, 0o644) // repair only owned fixture dependency
    receipts = h.broker.receiptIds()
  }
  const result = browser ? await browser.retry(browserContext(), 'repaired')
    : await h.adminRaw(current, h.recoverBody(soulId, 'manual_retry', 3))
  const after = ownedRecord(h, current, soulId)
  h.writeArtifact(`${scenarioId}-retry-status.json`,{outcome:result.result.Ok?.data?.outcome,errorCode:result.result.Err?.code,reason:result.result.Ok?.data?.probe?.data?.reason,repair:result.result.Ok?.data?.probe?.data?.retry_hint?.repair,incarnationId:after.incarnation.incarnation_id,attemptCount:after.attemptCount,writerClaims:after.writerClaims})
  const created = h.brokerReceiptsSince(receipts)
  const live = created.filter(receipt => h.inspectContainer(receipt.containerId).State.Running)
  h.assert(caseId, after.incarnation.soul_id === soulId && after.incarnation.container_id !== containerId && created.length === 1 && live.length === 1, 'exact repaired retry produces one current enclosure')
  h.assert(caseId, after.writerClaims === 1, 'registry commits one writer claim')
  if (!legacy) h.assert(caseId, readPublishedTui(live[0]!.containerId) === refreshedTui, `${tuiFormat} replacement callback and host refresh publish current selected TUI bytes`)
  h.assert(caseId, created.every(receipt => receipt.providerVolumeName === inspected.Mounts.find((m: any) => m.Destination === HOME)?.Name), 'every attempted replacement keeps exact provider volume')
  h.assert(caseId, h.inspectContainer(containerId).State.Running === false, 'old enclosure is empty before current writer runs')
  const actual = h.execOwnedContainerAsExact(live[0]!.containerId, '65534:0', ['python3', '-c',
    "import sqlite3,json,sys; c=sqlite3.connect('file:/home/freshell/provider/.local/share/opencode/opencode.db?mode=ro',uri=True); print(json.dumps([r[0] for r in c.execute('SELECT id FROM session WHERE id IN (?,?)',tuple(sys.argv[1:]))]))", rootSessionId, CHILD])
  h.assert(caseId, JSON.parse(actual).length === 2, 'replacement retained exact synthetic root and descendant')
  await browser?.observe(browserContext(result), 'replaced')
  h.writeArtifact(`${scenarioId}-result.json`, { kind: 'synthetic-task2', nativeQualified: false, browserExecuted: false, result, before, blockedProbe: blocked.probe, blockedRecord, after, fullOldContainerId: containerId, imageDigest: h.imageRef })
  } finally { await web?.stop() }
}


export { data as task2FixtureData, inventory as task2FixtureInventory, ownedRecord as task2FixtureOwnedRecord, selected as TASK2_FIXTURE_CASES }

export type Task2RetainedPublicContext = Pick<Task2RetainedBrowserContext,
  'soulId' | 'rootSessionId' | 'childSessionId' | 'oldContainerId' | 'oldIncarnationId' |
  'providerVolumeName' | 'preferredTabId' | 'preferredPaneId' | 'title' | 'result'> & {
    info: { baseUrl: string; wsUrl: string; token: string }
    configMode: number
  }
export function task2RetainedPublicContext(context: Task2RetainedBrowserContext): Task2RetainedPublicContext {
  const { soulId, rootSessionId, childSessionId, oldContainerId, oldIncarnationId, providerVolumeName,
    preferredTabId, preferredPaneId, title, result } = context
  const { baseUrl, wsUrl, token } = context.web.info
  return { soulId, rootSessionId, childSessionId, oldContainerId, oldIncarnationId, providerVolumeName,
    preferredTabId, preferredPaneId, title, result, info: { baseUrl, wsUrl, token },
    configMode: fs.statSync(context.configFile).mode & 0o777 }
}
export type Task2RetainedBrowserStage = {
  kind: 'preparing' | 'failed'; sequence: number
} | {
  kind: 'finished'; sequence: number
  facts?: { fixtureRunId: string; candidateSha: string; imageDigest: string; unsafeBrokerAttempts: number }
} | {
  kind: 'observe' | 'retry'; sequence: number
  phase: Task2RetainedBrowserPhase | 'config_fault' | 'repaired'
  context: Task2RetainedPublicContext
}

const PublicRetainedContextSchema = z.object({
  soulId: z.string().min(1), rootSessionId: z.string().min(1), childSessionId: z.string().min(1),
  oldContainerId: z.string().regex(/^[a-f0-9]{64}$/), oldIncarnationId: z.string().min(1),
  providerVolumeName: z.string().min(1), preferredTabId: z.string().min(1), preferredPaneId: z.string().min(1),
  title: z.string().min(1), configMode: z.number().int().min(0).max(0o777),
  info: z.object({ baseUrl: z.string().url(), wsUrl: z.string().url(), token: z.string().min(1) }).strict(),
  result: z.object({ requestId: z.string().min(1), result: z.object({ Ok: z.unknown().optional(),
    Err: z.object({ code: z.string(), message: z.string() }).strict().optional() }).strict() }).strict().optional(),
}).strict()
export const Task2RetainedBrowserStageSchema: z.ZodType<Task2RetainedBrowserStage> = z.union([
  z.object({ kind: z.enum(['preparing', 'failed']), sequence: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('finished'), sequence: z.number().int().nonnegative(), facts: z.object({
    fixtureRunId: z.string().uuid(), candidateSha: z.string().regex(/^[a-f0-9]{40}$/),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), unsafeBrokerAttempts: z.number().int().nonnegative(),
  }).strict().optional() }).strict(),
  z.object({ kind: z.enum(['observe', 'retry']), sequence: z.number().int().positive(),
    phase: z.enum(['store_blocked', 'config_blocked', 'replaced', 'config_fault', 'repaired']),
    context: PublicRetainedContextSchema }).strict(),
])

/** The existing driver waits for observation acknowledgements and real UI responses. */
export class RetainedFixtureBrowserSession {
  private stage: Task2RetainedBrowserStage = { kind: 'preparing', sequence: 0 }
  private settlement?: Promise<void>
  private failure?: unknown
  private cancelled = false
  private pending?: { context: Task2RetainedBrowserContext; kind: 'observe' | 'retry';
    resolve: (reply?: AdminReply) => void; reject: (error: Error) => void }

  start(run: (hooks: Task2RetainedBrowserHooks) => Promise<void>): void {
    if (this.settlement) throw new Error('owned retained session already started')
    const observe: Task2RetainedBrowserHooks['observe'] = (context, phase) => new Promise<void>((resolve, reject) => {
      this.publish(context, 'observe', phase)
      this.pending = { context, kind: 'observe', resolve: () => resolve(), reject }
    })
    const retry: Task2RetainedBrowserHooks['retry'] = (context, phase) => new Promise<AdminReply>((resolve, reject) => {
      this.publish(context, 'retry', phase)
      this.pending = { context, kind: 'retry', resolve: reply => {
        if (reply) resolve(reply); else reject(new Error('actual owned UI retry response required'))
      }, reject }
    })
    this.settlement = run({ observe, retry }).then(() => {
      this.pending = undefined
      this.stage = { kind: 'finished', sequence: this.stage.sequence + 1 }
    }).catch(error => {
      this.pending = undefined
      this.failure = error
      this.stage = { kind: 'failed', sequence: this.stage.sequence + 1 }
    })
  }
  private publish(context: Task2RetainedBrowserContext, kind: 'observe' | 'retry', phase: Task2RetainedBrowserPhase | 'config_fault' | 'repaired'): void {
    if (this.cancelled) throw new Error('owned retained browser session cancelled')
    this.stage = { kind, phase, sequence: this.stage.sequence + 1, context: task2RetainedPublicContext(context) }
  }
  status(): Task2RetainedBrowserStage { return this.stage }
  advance(sequence: number): void {
    if (this.stage.kind !== 'observe' || sequence !== this.stage.sequence || this.pending?.kind !== 'observe') {
      throw new Error('exact observed retained stage sequence required')
    }
    const pending = this.pending
    this.pending = undefined
    this.stage = { kind: 'preparing', sequence }
    pending.resolve()
  }
  captureRetry(soulId: string, requestId: string, response: unknown): void {
    if (this.stage.kind !== 'retry' || this.pending?.kind !== 'retry' || soulId !== this.pending.context.soulId || !requestId) {
      throw new Error('actual pending retained soul retry required')
    }
    const parsed = z.object({ view: z.object({ soulId: z.literal(soulId) }).passthrough(),
      outcome: z.enum(['blocked', 'replaced']) }).passthrough().safeParse(response)
    if (!parsed.success) throw new Error('actual retained UI retry response differs from the pending soul')
    const pending = this.pending
    this.pending = undefined
    this.stage = { kind: 'preparing', sequence: this.stage.sequence }
    pending.resolve({ requestId, result: { Ok: { kind: 'recovery', data: parsed.data } } })
  }
  async settled(): Promise<void> {
    if (!this.settlement) throw new Error('owned retained session is not started')
    await this.settlement
    if (this.failure) throw this.failure
  }
  async cancel(): Promise<void> {
    this.cancelled = true
    this.pending?.reject(new Error('owned retained browser session cancelled'))
    if (this.settlement) await this.settlement
  }
}
