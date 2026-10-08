// @vitest-environment node
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { RustServer } from '../../../e2e-browser/helpers/rust-server.js'
import { RuntimeHarness } from '../../../../scripts/testing/runtime-sandbox.js'
import { dispatchNativeFeasibility, nativeFeasibilityCases, parseNativeFeasibilityArguments,
  runNativeFeasibility, executeManagedNativeCase, nativeSdkResumeForkWrapper, nativeResumeRootInArgv, stageSdkInitFieldFault, nativeSdkInitFieldFaultMatches, staleNativeSignalBindingMatches, claudeNativeRestorationFault, terminalRestorationFaultHook, sdkRestorationFaultHook, terminalForkFaultHook, executeManagedNativeApproval, nativeCheckpointTranscriptRetained, nativeTwoToolBatchMatches, amplifierNativeProfileRetained, amplifierWrongRootInspection, nativeAmplifierStartupFaultWrapper,
  amplifierNativeAckFileFault, amplifierNativeHostStatus, completeAmplifierStaleWriter, receiverNativeNamespace, type NativeExperimentOriginal, type NativeSelection } from '../../../../scripts/testing/runtime-native-feasibility.js'

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
  it('refuses terminal Codex exact without the owned real controller before preparing a runtime', async () => {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codex-controller-preflight-'))
    const start=vi.fn(async()=>{throw new Error('runtime started before required controller preflight')})
    const harness={testRoot:directory,startSupervisor:start} as unknown as RuntimeHarness
    const sources=['env_file','auth_file','ca_file'].map(suffix=>({name:'codex/grants/'+suffix,path:'/owned/'+suffix,sha256:'e'.repeat(64)}))
    try {
      await expect(executeManagedNativeCase(harness,sources,{provider:'codex',case:'startup'},'exact-resume'))
        .rejects.toThrow('actual terminal recovery requires the owned real server artifact')
      expect(start).not.toHaveBeenCalled()
    } finally { fs.rmSync(directory,{recursive:true,force:true}) }
  })
  it.each(['valid', 'missing-observation', 'wrong-source', 'wrong-uid'])('executes terminal Codex create through the native app-server gate (%s; orchestration only)', async fault => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-codex-create-')), root = randomUUID()
    const requests: any[] = []
    const harness = { testRoot: directory, runId: ownerId, candidateSha, imageRef: imageDigest,
      startSupervisor: async (options: any) => { expect(options.env.FRESHELL_MANAGED_PROVIDER_QUALIFICATION).toBe('codex'); return {} }, writeArtifact: () => {},
      adminOk: async (_supervisor: unknown, request: any) => {
        requests.push(request); expect(request.params.freshAgent).toBeUndefined()
        expect(request.params.terminal.mode).toBe('codex'); expect(request.params.terminal.program).toBe('codex')
        expect(request.params.terminal.providerPermissionMode).toBe('on-request'); expect(request.params.terminal.providerSandbox).toBe('workspace-write')
        return { data: { view: { launchState: 'running', recoveryState: 'live', containerId: 'owned-terminal', incarnationId: 'current-inc', nativeSessionId: root,
          nativeIdentityObservation: fault === 'missing-observation' ? null : { nativeSessionId: root, incarnationId: 'current-inc', launchNonce: 'current-nonce',
            source: fault === 'wrong-source' ? 'fresh_provider_handshake' : 'codex_app_server', evidenceRevision: 0, evidenceDigest: 'a'.repeat(64) } } } }
      },
      execOwnedContainerAsExact: async () => JSON.stringify({ uid: fault === 'wrong-uid' ? 0 : 65534, gid: 0, caps: '0000000000000000', readOnlyRoot: true,
        httpsStatus: 200, tlsVerifyMode: 2, tlsCheckHostname: true, nativeCwd: path.join(directory, 'codex-create-workspace'), nativeVersion: 'codex-cli 0.147.0',
        activeNativeProcesses: 1, executableSha256: 'e'.repeat(64), profileSha256: 'd'.repeat(64) }),
    } as unknown as RuntimeHarness
    const sources = ['env_file', 'auth_file', 'ca_file'].map(suffix => ({ name: `codex/grants/${suffix}`, path: '/owned/' + suffix, sha256: 'e'.repeat(64) }))
    try {
      const run = executeManagedNativeCase(harness, sources, { provider: 'codex', case: 'startup' }, 'create')
      if (fault === 'valid') { expect((await run).assertions.every(row => row.pass)).toBe(true); expect(requests).toHaveLength(1) }
      else await expect(run).rejects.toThrow(fault === 'wrong-uid' ? 'actual native receiver namespace/profile/pin/TLS differs' : 'current managed native receiver observation missing or misbound before input')
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(['valid', 'published', 'admitted-input', 'requested-echo', 'missing-receipt', 'ephemeral-receipt', 'wrong-uid'])('requires actual different Codex native receipt and rejects initial LIVE/input (%s; controlled orchestration)', async fault => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-codex-wrong-'))
    const nativeRoot = randomUUID(), requests: any[] = []
    let expectedRoot = ''
    const incarnation = 'incarnation-current'
    fs.mkdirSync(path.join(directory, incarnation))
    const receipt = path.join(directory, incarnation, 'provider-identity.json')
    const harness = { testRoot: directory, evidenceDir: directory, runId: ownerId, candidateSha, imageRef: imageDigest,
      startSupervisor: async () => ({}), writeArtifact: () => {},
      runtimeDir: (_supervisor: unknown, current: string) => path.join(directory, current),
      inventoryBody: () => ({ method: 'inventory' }), terminalInputBody: () => ({ method: 'terminal_input' }),
      adminRaw: async (_supervisor: unknown, request: any) => {
        requests.push(request)
        if (request.method === 'launch') {
          expectedRoot = request.params.nativeSessionId
          expect(request.params.terminal.resumeSessionId).toBeUndefined()
          expect(request.params.freshAgent).toBeUndefined()
          if (fault !== 'missing-receipt') fs.writeFileSync(receipt, JSON.stringify({ schemaVersion: 1, provider: 'codex',
            nativeSessionId: fault === 'requested-echo' ? expectedRoot : nativeRoot, ephemeral: fault === 'ephemeral-receipt', observedAt: 1 }))
          return { result: { Err: { code: 'RECOVERY_BLOCKED' } } }
        }
        if (request.method === 'terminal_input') return { result: { Err: { code: fault === 'admitted-input' ? 'OTHER_ERROR' : 'UNKNOWN_SOUL' } } }
        throw new Error('unexpected controlled command')
      },
      adminOk: async () => ({ data: [{ soulId: requests[0].params.soulId, launchState: fault === 'published' ? 'running' : 'starting',
        nativeSessionId: expectedRoot, nativeIdentityObservation: null, incarnationId: incarnation, containerId: 'owned-current' }] }),
      execOwnedContainerAsExact: async () => JSON.stringify({ uid: fault === 'wrong-uid' ? 0 : 65534, gid: 0, caps: '0000000000000000', readOnlyRoot: true,
        httpsStatus: 200, tlsVerifyMode: 2, tlsCheckHostname: true, nativeCwd: path.join(directory, 'codex-wrong-root-workspace'), nativeVersion: 'codex-cli 0.147.0',
        activeNativeProcesses: 1, executableSha256: 'e'.repeat(64), profileSha256: 'd'.repeat(64) }),
    } as unknown as RuntimeHarness
    const sources = ['env_file','auth_file','ca_file'].map(suffix => ({ name: 'codex/grants/'+suffix, path:'/owned/'+suffix, sha256:'e'.repeat(64) }))
    try {
      const run = executeManagedNativeCase(harness, sources, { provider:'codex', case:'startup' }, 'wrong-root')
      if (fault === 'valid') {
        const original = await run
        expect(original.assertions.every(row => row.pass)).toBe(true)
        expect(expectedRoot).not.toBe(nativeRoot)
        expect(requests.map(row => row.method)).toEqual(['launch','terminal_input'])
      } else await expect(run).rejects.toThrow(fault === 'published' ? 'actual initial Codex wrong-root publication was not contained'
        : fault === 'admitted-input' ? 'actual Codex wrong-root admitted input'
        : fault === 'wrong-uid' ? 'actual native receiver namespace/profile/pin/TLS differs'
        : fault === 'missing-receipt' ? 'actual current Codex native receipt unavailable'
        : 'actual current Codex receipt does not prove a different native root')
    } finally { fs.rmSync(directory, { recursive:true, force:true }) }
  })
  it.each(['freshcodex','freshopencode','codex'].flatMap(mode => ['valid','copied-volume','wrong-incarnation','wrong-root','store-changed','profile-changed','wrong-outcome'].map(fault => [mode,fault])))('executes exact receiver recovery only after completed native history and preserves its original volume (%s, %s; controlled orchestration)', async (mode,fault) => {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'receiver-exact-recovery-')), provider=mode==='freshcodex'||mode==='codex'?'codex':'opencode'
    const root=provider==='codex'?randomUUID():'ses_ownedFixture', turn=randomUUID(), container='owned-initial', replacement='owned-replacement'
    const raw=Buffer.from([
      {type:'session_meta',payload:{id:root,model_provider:'openai'}},
      {type:'turn_context',payload:{turn_id:turn,model:'gpt-5.6-luna',effort:'low'}},
      {type:'response_item',payload:{type:'message',role:'assistant',id:'msg-owned',content:[{type:'output_text',text:'stored'}]}},
      {type:'event_msg',timestamp:'2026-10-08T09:00:00Z',payload:{type:'task_complete',turn_id:turn,last_agent_message:'stored'}},
    ].map(row=>JSON.stringify(row)).join('\n')+'\n')
    const databasePath=path.join(directory,'controlled-native.db'),database=new DatabaseSync(databasePath)
    database.exec('CREATE TABLE session(id TEXT); CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT);')
    database.prepare('INSERT INTO session VALUES (?)').run(root)
    database.prepare('INSERT INTO message VALUES (?,?,?,?)').run('msg-owned',root,1,JSON.stringify({role:'assistant',time:{completed:1},providerID:'openai',modelID:'gpt-5.6-luna'}))
    database.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('part-owned',root,'msg-owned',1,JSON.stringify({type:'text',text:'stored'}));database.close()
    const querySnapshot=fs.readFileSync(databasePath)
    let capabilityIssued=false
    const controller = mode==='codex' ? createServer(socket => {
      const chunks: Buffer[]=[];socket.on('data',chunk=>chunks.push(chunk));socket.on('end',()=>{
        const issue=JSON.parse(Buffer.concat(chunks).toString());expect(issue.action).toBe('issue');expect(issue.provider).toBe('codex');expect(issue.soulId).toMatch(/^soul-/)
        capabilityIssued=true;socket.end(JSON.stringify({context:{preparation:{codex:{tui_args:[],sidecar_args:[]}},config:[],mcpCapability:{grantId:'controlled-owned-grant'}},
          secretReferences:['environment','auth_file','ca_file'].map(suffix=>({sourcePath:'/owned/'+suffix,profile:'codex_onecli_'+suffix}))}))
      })
    }) : undefined
    if(controller)await new Promise<void>(resolve=>controller.listen(path.join(directory,'mcp.sock'),resolve))
    const serverPath=path.join(directory,'controlled-server');fs.writeFileSync(serverPath,'fixture-only')
    const startServer=mode==='codex'?vi.spyOn(RustServer.prototype,'start').mockResolvedValue({pid:undefined} as any):undefined
    const serverEvidence=mode==='codex'?vi.spyOn(RustServer.prototype,'processEvidence').mockReturnValue({} as any):undefined
    let seeded=false,probed=false,dead=false,outputRead=false,pasted=false
    const view=(current=false)=>({launchState:'running',recoveryState:'live',containerId:current?replacement:container,
      incarnationId:current&&fault!=='wrong-incarnation'?'new-inc':'initial-inc',nativeSessionId:current&&fault==='wrong-root'?'other-root':root,
      nativeIdentityObservation:{nativeSessionId:current&&fault==='wrong-root'?'other-root':root,incarnationId:current&&fault!=='wrong-incarnation'?'new-inc':'initial-inc',
        launchNonce:current?'new-nonce':'initial-nonce',evidenceRevision:current?1:0,evidenceDigest:'a'.repeat(64),source:mode==='codex'?'codex_app_server':'fresh_provider_handshake'}})
    const harness={testRoot:directory,evidenceDir:directory,runId:ownerId,candidateSha,imageRef:imageDigest,
      startSupervisor:async()=>({controlSocket:path.join(directory,'supervisor.sock'),controlSecret:'controlled-secret',controlSecretFile:path.join(directory,'secret')}),writeArtifact:(name:string,value:unknown)=>fs.writeFileSync(path.join(directory,name),JSON.stringify(value)),
      probeRecoveryBody:()=>({method:'probe_recovery'}),recoverBody:()=>({method:'recover'}),
      terminalReadOutputBody:()=>({method:'terminal_read_output'}),terminalInputBody:(_soulId:string,data:string)=>({method:'terminal_input',params:{data}}),
      broker:{receipts:()=>[{containerId:container,providerVolumeName:'owned-original-volume'},{containerId:replacement,providerVolumeName:fault==='copied-volume'?'copied-volume':'owned-original-volume'}]},
      killOwnedRuntimeExact:async()=>{expect(seeded&&probed).toBe(true);dead=true},waitForContainerExit:async()=>{expect(dead).toBe(true)},
      adminOk:async(_supervisor:unknown,request:any)=>{
        if(request.method==='launch'){if(mode==='codex')expect(request.params.terminal.providerLaunchContext.mcpCapability.grantId).toBe('controlled-owned-grant');return{data:{view:view()}}}
        if(request.method==='fresh_agent_send'){expect(mode).not.toBe('codex');seeded=true;return{data:{state:'dispatched'}}}
        if(request.method==='terminal_read_output'){outputRead=true;return{data:{frames:[]}}}
        if(request.method==='terminal_input'){expect(mode).toBe('codex');expect(outputRead).toBe(true);if(request.params.data==='\r'){expect(pasted).toBe(true);seeded=true}else{expect(request.params.data).toContain('\x1b[200~');expect(request.params.data).toContain('\x1b[201~');pasted=true};return{data:{state:'dispatched'}}}
        if(request.method==='probe_recovery'){expect(seeded).toBe(true);probed=true;return{data:{kind:'reattach_ready'}}}
        if(request.method==='recover'){expect(dead).toBe(true);return{data:{outcome:fault==='wrong-outcome'?'reattached':'replaced',view:view(true)}}}
        throw new Error('unexpected receiver command')
      },
      execOwnedContainerAsExact:async(id:string,_uid:string,argv:string[])=>{
        if(argv[2]===receiverNativeNamespace)return JSON.stringify({uid:65534,gid:0,caps:'0000000000000000',readOnlyRoot:true,httpsStatus:200,tlsVerifyMode:2,tlsCheckHostname:true,
          nativeCwd:path.join(directory,`${mode}-exact-resume-workspace`),nativeVersion:provider==='codex'?'codex-cli 0.147.0':'1.18.21',
          executableSha256:'e'.repeat(64),profileSha256:dead&&fault==='profile-changed'?'f'.repeat(64):'d'.repeat(64),nativeRoot:root,nativeMessageCount:seeded?2:0,activeNativeProcesses:1})
        expect(seeded).toBe(true)
        const bytes=dead&&fault==='store-changed'?Buffer.from(raw.toString().replaceAll('stored','changed')):raw
        return JSON.stringify({nativeRoot:provider==='codex'?root:null,path:provider==='codex'?`/home/freshell/provider/.codex/sessions/rollout-${root}.jsonl`:'/home/freshell/provider/.local/share/opencode/opencode.db',identity:['1',dead&&fault==='store-changed'?'2':'3',String(bytes.length)],sha256:createHash('sha256').update(bytes).digest('hex'),bytesBase64:provider==='codex'?bytes.toString('base64'):null,
          querySnapshotBase64:querySnapshot.toString('base64'),querySnapshotSha256:createHash('sha256').update(querySnapshot).digest('hex'),completeEof:true})
      },
    } as unknown as RuntimeHarness
    const sources=['env_file','auth_file','ca_file'].map(suffix=>({name:`${provider}/grants/${suffix}`,path:'/owned/'+suffix,sha256:'e'.repeat(64)}))
    try{
      const run=executeManagedNativeCase(harness,sources,mode==='codex'?{provider:'codex',case:'startup'}:{mode:mode as 'freshcodex'|'freshopencode',case:'startup'},'exact-resume',mode==='codex'?serverPath:undefined)
      if(fault==='valid'){const original=await run;expect(original.assertions.every(row=>row.pass)).toBe(true);expect(original.assertions.some(row=>row.name==='original-owned-volume-transcript-continuity')).toBe(true)}
      else await expect(run).rejects.toThrow()
      expect(seeded).toBe(true)
      if(mode==='codex'){expect(capabilityIssued).toBe(true);expect(startServer).toHaveBeenCalledOnce()}
    }finally{startServer?.mockRestore();serverEvidence?.mockRestore();if(controller)await new Promise<void>(resolve=>controller.close(()=>resolve()));fs.rmSync(directory,{recursive:true,force:true})}
  })
  it.each(['valid', 'wrong-root', 'wrong-directory', 'parent-root', 'foreign-history', 'root-http-error', 'missing-tag'])('executes the real native session HTTP reader through an owned process fixture (%s; no provider qualification)', async (fault) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-serve-reader-')), proc = path.join(directory, 'proc'), processRoot = path.join(proc, '26')
    const workspace = path.join(directory, 'session-workspace'), globalCwd = path.join(directory, 'global-server')
    for (const child of [processRoot, workspace, globalCwd]) fs.mkdirSync(child, { recursive: true })
    const executable = path.join(directory, 'opencode.exe'); fs.writeFileSync(executable, "#!/bin/sh\nprintf '1.18.21\\n'\n", { mode: 0o700 })
    fs.symlinkSync(executable, path.join(processRoot, 'exe')); fs.symlinkSync(globalCwd, path.join(processRoot, 'cwd'))
    fs.writeFileSync(path.join(proc, 'self-status'), 'CapEff:\t0000000000000000\n')
    const root = 'ses_actualFixture', requests: string[] = []
    const server = createHttpServer((request, response) => {
      const url = new URL(request.url!, 'http://127.0.0.1'); requests.push(url.pathname)
      if (url.pathname === '/models') { response.end('{}'); return }
      expect(url.searchParams.get('directory')).toBe(workspace)
      if (fault === 'root-http-error' && url.pathname === `/session/${root}`) { response.writeHead(503); response.end('{}'); return }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(url.pathname === `/session/${root}`
        ? { id: fault === 'wrong-root' ? 'ses_other' : root, directory: fault === 'wrong-directory' ? globalCwd : workspace,
          ...(fault === 'parent-root' ? { parentID: 'ses_parent' } : {}) }
        : fault === 'foreign-history' ? [{ info: { sessionID: 'ses_other' } }] : []))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    fs.writeFileSync(path.join(processRoot, 'cmdline'), ['opencode','serve','--hostname','127.0.0.1','--port',String(port),''].join('\0'))
    fs.writeFileSync(path.join(processRoot, 'environ'), [`HOME=${directory}`, 'NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt',
      ...(fault === 'missing-tag' ? [] : ['FRESHELL_OPENCODE_SIDECAR_ID=owned-fixture']), ''].join('\0'))
    // Only this process fixture substitutes owned proc/executable paths and its
    // real test UID. The production reader keeps the pinned path and UID fence.
    const script = receiverNativeNamespace.replace("pathlib.Path('/proc')", 'pathlib.Path(' + JSON.stringify(proc) + ')')
      .replace("pathlib.Path('/proc/self/status')", 'pathlib.Path(' + JSON.stringify(path.join(proc, 'self-status')) + ')')
      .replace('/usr/local/lib/node_modules/opencode-ai/bin/opencode.exe', executable)
      .replace('process.stat().st_uid!=65534', 'process.stat().st_uid!=os.getuid()')
      .replace('https://chatgpt.com/backend-api/codex/models?client_version=0.147.0', `http://127.0.0.1:${port}/models`)
    try {
      const run = promisify(execFile)('python3', ['-c', script, 'opencode', root, workspace], { timeout: 5_000 })
      if (fault === 'valid') {
        const actual = JSON.parse((await run).stdout)
        expect(actual.nativeRoot).toBe(root); expect(actual.nativeCwd).toBe(workspace); expect(actual.nativeProcessCwd).toBe(globalCwd)
        expect(actual.nativeVersion).toBe('1.18.21'); expect(actual.nativeMessageCount).toBe(0)
        expect(requests).toEqual([`/session/${root}`, `/session/${root}/message`, '/models'])
      } else await expect(run).rejects.toThrow()
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(['freshcodex', 'freshopencode'].flatMap(mode => ['valid', 'missing-observation', 'wrong-root', 'wrong-incarnation', 'wrong-source', 'wrong-version', 'wrong-uid', 'wrong-tls', 'wrong-native-api-root', 'nonempty-before-input'].map(fault => [mode, fault])))('executes managed pre-input native create and refuses incomplete evidence (%s, %s; orchestration only)', async (mode, fault) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-receiver-create-'))
    const provider = mode === 'freshcodex' ? 'codex' : 'opencode', root = provider === 'codex' ? randomUUID() : 'ses_nativeOwned'
    const sources = ['env_file', 'auth_file', 'ca_file'].map(suffix => ({ name: `${provider}/grants/${suffix}`, path: '/owned/' + suffix, sha256: 'e'.repeat(64) }))
    const launch = vi.fn(async (_supervisor: unknown, request: any) => {
      expect(request.method).toBe('launch'); expect(request.params.provider).toBe(provider)
      expect(request.params.freshAgent.sessionType).toBe(mode)
      expect(request.params.freshAgent.providerSecretReferences.map((reference: any) => reference.profile)).toEqual([
        `${provider}_onecli_environment`, `${provider}_onecli_auth_file`, `${provider}_onecli_ca_file`])
      expect(request.params.freshAgent.nativeSessionId).toBeUndefined()
      if (provider === 'codex') {
        expect(request.params.freshAgent.permissionMode).toBe('on-request')
        expect(request.params.freshAgent.sandbox).toBe('workspace-write')
      } else expect(request.params.freshAgent.permissionMode).toBeUndefined()
      return { data: { view: { launchState: 'running', recoveryState: 'live', containerId: 'owned-native', incarnationId: 'current-inc', nativeSessionId: root,
        nativeIdentityObservation: fault === 'missing-observation' ? null : { nativeSessionId: fault === 'wrong-root' ? 'other' : root,
          incarnationId: fault === 'wrong-incarnation' ? 'old-inc' : 'current-inc', source: fault === 'wrong-source' ? 'claude_native_event' : 'fresh_provider_handshake',
          launchNonce: 'current-nonce', evidenceRevision: 0, evidenceDigest: 'a'.repeat(64) } } } }
    })
    const capture = vi.fn(async (_container: string, uid: string) => {
      expect(uid).toBe('65534:0')
      return JSON.stringify({ uid: fault === 'wrong-uid' ? 0 : 65534, gid: 0, caps: '0000000000000000', readOnlyRoot: true,
        httpsStatus: fault === 'wrong-tls' ? 0 : 200, tlsVerifyMode: 2, tlsCheckHostname: true,
        nativeCwd: path.join(directory, `${mode}-create-workspace`), nativeVersion: fault === 'wrong-version' ? 'unqualified' : provider === 'codex' ? 'codex-cli 0.147.0' : '1.18.21',
        executableSha256: 'e'.repeat(64), profileSha256: 'd'.repeat(64), nativeRoot: fault === 'wrong-native-api-root' ? 'other' : root,
        nativeMessageCount: fault === 'nonempty-before-input' ? 1 : 0, activeNativeProcesses: 1 })
    })
    const records = new Map<string, unknown>()
    const start = vi.fn(async (options: any) => {
      expect(options.env.HOME).toBe(path.join(directory, 'native-source', provider, `${mode}-create`))
      expect(fs.statSync(path.join(options.env.HOME, provider === 'codex' ? '.codex' : '.config/opencode')).isDirectory()).toBe(true)
      return {}
    })
    const harness = { testRoot: directory, runId: ownerId, candidateSha, imageRef: imageDigest, startSupervisor: start,
      adminOk: launch, execOwnedContainerAsExact: capture, writeArtifact: (name: string, value: unknown) => records.set(name, value) } as unknown as RuntimeHarness
    try {
      const run = executeManagedNativeCase(harness, sources, { mode: mode as 'freshcodex' | 'freshopencode', case: 'startup' }, 'create')
      if (fault === 'valid' || provider === 'codex' && ['wrong-native-api-root', 'nonempty-before-input'].includes(fault!)) {
        expect((await run).assertions.every(row => row.pass)).toBe(true)
        expect(launch).toHaveBeenCalledTimes(1); expect(capture).toHaveBeenCalledTimes(1)
        expect(records.has(`${mode}-create-original.json`)).toBe(true)
      } else { await expect(run).rejects.toThrow(); expect(records.has(`${mode}-create-original.json`)).toBe(false) }
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(['file-replacement', 'file-truncation', 'malformed-ack'].flatMap(fault =>
    ['valid', 'wrong-original', 'symlink', 'wrong-uid'].map(form => [fault, form])))('executes the restricted ACK filesystem mutation (%s, %s; controlled identity only)', (fault, form) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amplifier-ack-file-'))
    const nonce = 'current-native-nonce', signalDirectory = path.join(directory, nonce)
    fs.mkdirSync(signalDirectory)
    const file = path.join(signalDirectory, 'amplifier-loaded-context.json'), unrelated = path.join(directory, 'unrelated-file')
    const value = { launch: { launchNonce: nonce, incarnationId: 'controlled-incarnation' }, native: { session_id: randomUUID() } }
    const raw = Buffer.from(JSON.stringify(value) + '\n'); fs.writeFileSync(unrelated, raw)
    if (form === 'symlink') fs.symlinkSync(unrelated, file); else fs.writeFileSync(file, raw)
    const before = fs.statSync(file)
    // Only this controlled filesystem fixture substitutes its owned directory
    // and identity functions; managed native execution uses the unmodified code.
    const script = "import os\nos.getuid=lambda:" + (form === 'wrong-uid' ? '0' : '65534') + "\nos.getgid=lambda:0\n"
      + amplifierNativeAckFileFault.replace("pathlib.Path('/home/freshell/provider/.freshell/native-identity')", 'pathlib.Path(sys.argv[3])')
    const expected = form === 'wrong-original' ? { ...value, native: { session_id: randomUUID() } } : value
    try {
      const run = () => execFileSync('python3', ['-c', script, fault!, JSON.stringify(expected), directory], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
      if (form !== 'valid') { expect(run).toThrow(); expect(fs.readFileSync(file)).toEqual(raw) }
      else {
        const result = JSON.parse(run()), after = fs.statSync(file)
        expect(result.originalSha256).toBe(createHash('sha256').update(raw).digest('hex'))
        expect(result.changedSha256).toBe(createHash('sha256').update(fs.readFileSync(file)).digest('hex'))
        if (fault === 'file-replacement') { expect(after.ino).not.toBe(before.ino); expect(fs.readFileSync(file)).toEqual(raw) }
        else if (fault === 'file-truncation') { expect(after.ino).toBe(before.ino); expect(after.size).toBe(raw.length - 1); expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(value) }
        else { expect(after.ino).toBe(before.ino); expect(() => JSON.parse(fs.readFileSync(file, 'utf8'))).toThrow() }
        expect(result.validAfter).toBe(fault !== 'malformed-ack')
      }
      expect(fs.readFileSync(unrelated)).toEqual(raw)
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(['valid', 'wrong-proof', 'wrong-status-boot', 'wrong-request', 'oversized'])('executes the owned native host Status authentication/framing (%s; fixture only)', async (form) => {
    const base = path.join('/tmp/frs', randomUUID().replaceAll('-', '').slice(0, 8) + '-' + randomUUID().slice(0, 3))
    const root = path.join(base, 'r', 'amplif-aaaaaaaa', 'x'), incarnation = 'incarnation-' + randomUUID()
    const directory = path.join(root, incarnation); fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const secret = Buffer.from(randomUUID()), boot = 'hostboot-' + randomUUID(), endpoint = path.join(directory, 'host.sock')
    fs.writeFileSync(path.join(directory, 'secret'), secret, { mode: 0o600 })
    const requests: any[] = []
    const proof = (challenge: string) => createHmac('sha256', secret).update(challenge + '\0' + boot + '\0' + incarnation).digest('hex')
    const server = createServer(socket => {
      let buffered = Buffer.alloc(0)
      socket.on('data', part => {
        buffered = Buffer.concat([buffered, part])
        if (buffered.length < 4 || buffered.length < 4 + buffered.readUInt32BE()) return
        const request = JSON.parse(buffered.subarray(4, 4 + buffered.readUInt32BE()).toString()); requests.push(request)
        const hello = request.body.method === 'hello'
        const response = { requestId: form === 'wrong-request' ? 'request-other' : request.requestId, result: { Ok: hello
          ? { kind: 'hello', data: { host_boot_id: boot, proof: form === 'wrong-proof' ? '0'.repeat(64) : proof(request.body.params.challenge) } }
          : { kind: 'status', data: { host_boot_id: form === 'wrong-status-boot' ? 'hostboot-other' : boot,
            worker_pid: 55, max_execution_generation: 3, exited: false, native_session_id: null, native_identity_observation: null } } } }
        const bytes = Buffer.from(JSON.stringify(response)), frame = Buffer.alloc(4 + bytes.length)
        frame.writeUInt32BE(form === 'oversized' ? 65_537 : bytes.length); bytes.copy(frame, 4)
        socket.end(form === 'oversized' ? frame.subarray(0, 4) : frame)
      })
    })
    await new Promise<void>(resolve => server.listen(endpoint, resolve))
    try {
      const run = promisify(execFile)('python3', ['-c', amplifierNativeHostStatus, root, incarnation], { timeout: 5_000 })
      if (form !== 'valid') await expect(run).rejects.toThrow()
      else {
        const value = JSON.parse((await run).stdout)
        expect(value).toEqual({ incarnationId: incarnation, hostBootId: boot, workerPid: 55, executionGeneration: 3,
          exited: false, nativeSessionId: null, nativeIdentityObservation: null })
        expect(requests).toHaveLength(2)
        expect(requests[1].auth).toBe(proof('command-auth'))
        expect(requests.every(row => row.protocolVersion === 2 && row.role === 'supervisor' && row.body.params.incarnation_id === incarnation)).toBe(true)
      }
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(base, { recursive: true, force: true }) }
  })
  it.each(['valid', 'wrong-digest', 'wrong-root', 'symlink', 'tool-operation'])('mutates only the exact owned completed native loader source (%s)', (fault) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-native-loader-source-'))
    const project = path.join(directory, 'projects', 'owned-project'); fs.mkdirSync(project, { recursive: true })
    const root = randomUUID(), file = path.join(project, root + '.jsonl'), target = path.join(directory, 'unrelated-source')
    const bytes = Buffer.from(JSON.stringify({ type: 'assistant', sessionId: fault === 'wrong-root' ? randomUUID() : root,
      message: { content: [fault === 'tool-operation' ? { type: 'tool_use', id: 'owned-tool' } : { type: 'text', text: 'controlled completed reply' }] } }) + '\n')
    fs.writeFileSync(target, bytes); if (fault === 'symlink') fs.symlinkSync(target, file); else fs.writeFileSync(file, bytes)
    const before = fs.statSync(file), expected = createHash('sha256').update(bytes).digest('hex')
    const script = claudeNativeRestorationFault.replace('/home/freshell/provider/.claude/projects', path.join(directory, 'projects'))
    try {
      const run = () => execFileSync('python3', ['-c', script, root, fault === 'wrong-digest' ? '0'.repeat(64) : expected,
        JSON.stringify([String(before.dev), String(before.ino)])], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
      if (fault !== 'valid') { expect(run).toThrow(); expect(fs.readFileSync(file)).toEqual(bytes) }
      else {
        const result = JSON.parse(run()), after = fs.statSync(file)
        expect(result.beforeSha256).toBe(expected); expect(result.afterSha256).not.toBe(expected)
        expect([after.dev, after.ino]).toEqual([before.dev, before.ino]); expect(result.changedAssistantRows).toBe(1)
        expect(JSON.parse(fs.readFileSync(file, 'utf8')).message.content).toBe('owned malformed native assistant')
      }
      expect(fs.readFileSync(target)).toEqual(bytes)
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(['exact-resume', 'native-followup', 'old-writer'])('requires the owned controller before Amplifier %s can seed', async (caseId) => {
    const start = vi.fn()
    await expect(executeManagedNativeCase({ startSupervisor: start } as unknown as RuntimeHarness, [],
      { provider: 'amplifier', case: 'startup' }, caseId)).rejects.toThrow('actual terminal recovery requires the owned real server artifact')
    expect(start).not.toHaveBeenCalled()
  })
  it.each(['exact-resume', 'native-followup', 'old-writer'])('keeps distinct owned Amplifier controller cleanup receipts for %s', async (caseId) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amplifier-controller-owner-'))
    const source = path.join(directory, 'profile'); fs.writeFileSync(source, 'fixture-only profile')
    const descriptor = path.join(directory, 'fault.json')
    fs.writeFileSync(descriptor, JSON.stringify({ schemaVersion: 1, imageDigest, wrapperSourceSha: candidateSha, wrapperSha256: 'a'.repeat(64),
      originalCliSha256: 'b'.repeat(64), producerSha256: 'c'.repeat(64), cases: ['missing-history', 'load-failure', 'missing-context-restore', 'timeout', 'provider-exit', 'stop-cancellation', 'parent-root', 'old-writer'] }))
    const sources = ['grants/env_file', 'grants/ca_file', '.amplifier/settings.yaml', '.amplifier/bundles/default.yaml']
      .map(name => ({ name: 'amplifier/' + name, path: source, sha256: 'e'.repeat(64) }))
    sources.push({ name: 'amplifier/native-fault/startup.json', path: descriptor, sha256: createHash('sha256').update(fs.readFileSync(descriptor)).digest('hex') })
    const start = vi.spyOn(RustServer.prototype, 'start').mockRejectedValue(new Error('controlled controller startup boundary'))
    const servers: any[] = []
    try {
      await expect(executeManagedNativeCase({ testRoot: directory, imageRef: imageDigest, startSupervisor: async () => ({}) } as unknown as RuntimeHarness,
        sources, { provider: 'amplifier', case: 'startup' }, caseId, '/fixture/controller', servers)).rejects.toThrow('controlled controller startup boundary')
      expect(servers).toHaveLength(1)
      expect(servers[0].scope).toBe(`amplifier-${caseId}-native`)
    } finally { start.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(['valid', 'no-native-record', 'wrong-current-nonce', 'wrong-current-incarnation', 'wrong-current-revision', 'wrong-previous-signal',
    'current-signal-binding', 'wrong-native-root', 'wrong-source-inode', 'wrong-source-eof', 'wrong-producer', 'wrong-cli', 'wrong-uid', 'wrong-cwd',
    'not-blocked', 'empty-inventory', 'running', 'published', 'admitted-input', 'wrong-previous-incarnation', 'wrong-previous-root',
    'wrong-native-parent', 'wrong-message-count', 'wrong-signal-bytes'])('requires actual stale native writer refusal and original file conservation (%s)', async (form) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'amplifier-stale-writer-'))
    const root = randomUUID(), prior = { incarnationId: 'old-incarnation', launchNonce: 'old-nonce', evidenceRevision: 0, executionGeneration: 1, requestedNativeSessionId: root }
    const current = { ...prior, incarnationId: 'current-incarnation', launchNonce: 'current-nonce', evidenceRevision: 1 }
    const previousSignal = { launch: prior, native: { session_id: root, parent_id: null } }
    const bytes = JSON.stringify(previousSignal), sha = createHash('sha256').update(bytes).digest('hex')
    fs.writeFileSync(path.join(workspace, 'prior-native-signal.json'), bytes)
    const faultImage = { originalCliSha256: 'a'.repeat(64), producerSha256: 'b'.repeat(64) }
    const load = { sessionId: root, parentId: null, messageCount: 2, transcript: { device: 2, inode: 7, size: 22, eofSha256: 'c'.repeat(64) } }
    const fault: any = { event: 'test.amplifier.native_startup_fault.applied', severity: 'warning', fault: 'old-writer', phase: 'before-stale-native-publication',
      launch: current, previousLaunch: prior, previousSignalSha256: sha, originalLoad: load, nativePid: process.pid, uid: 65534, gid: 0,
      caps: '0000000000000000', readOnlyRoot: true, nativeCwd: workspace, ...faultImage }
    const publication: any = { currentLaunch: current, nativeSignal: { launch: prior, native: { session_id: root, parent_id: null, source: 'resume',
      producer_sha256: faultImage.producerSha256, load, acceptedMessageCount: 3 } } }
    publication.signalText = JSON.stringify(publication.nativeSignal)
    publication.signalSha256 = createHash('sha256').update(publication.signalText).digest('hex')
    if (form === 'wrong-previous-incarnation') previousSignal.launch = { ...prior, incarnationId: 'foreign-prior-incarnation' }
    if (form === 'wrong-previous-root') previousSignal.native.session_id = randomUUID()
    if (form === 'wrong-current-nonce') fault.launch = { ...current, launchNonce: 'foreign-nonce' }
    if (form === 'wrong-current-incarnation') fault.launch = { ...current, incarnationId: 'foreign-incarnation' }
    if (form === 'wrong-current-revision') fault.launch = { ...current, evidenceRevision: 0 }
    if (form === 'wrong-previous-signal') fault.previousSignalSha256 = '0'.repeat(64)
    if (form === 'current-signal-binding') publication.nativeSignal.launch = current
    if (form === 'wrong-native-root') publication.nativeSignal.native.session_id = randomUUID()
    if (form === 'wrong-source-inode') fault.originalLoad = { ...load, transcript: { ...load.transcript, inode: 8 } }
    if (form === 'wrong-source-eof') fault.originalLoad = { ...load, transcript: { ...load.transcript, eofSha256: '0'.repeat(64) } }
    if (form === 'wrong-producer') fault.producerSha256 = '0'.repeat(64)
    if (form === 'wrong-cli') fault.originalCliSha256 = '0'.repeat(64)
    if (form === 'wrong-uid') fault.uid = 0
    if (form === 'wrong-cwd') fault.nativeCwd = '/foreign-workspace'
    if (form === 'wrong-native-parent') publication.nativeSignal.native.parent_id = randomUUID()
    if (form === 'wrong-message-count') publication.nativeSignal.native.acceptedMessageCount = 1
    if (form === 'wrong-signal-bytes') publication.signalText = '{}'
    if (form !== 'no-native-record') fs.writeFileSync(path.join(workspace, 'native-startup-fault.json'), JSON.stringify(fault))
    fs.writeFileSync(path.join(workspace, 'native-stale-publication.json'), JSON.stringify(publication))
    const records = new Map<string, unknown>(), input = vi.fn(async () => ({ result: form === 'admitted-input' ? { Ok: {} } : { Err: { code: 'RECOVERY_BLOCKED' } } }))
    const harness = { writeArtifact: (name: string, value: unknown) => records.set(name, value), inventoryBody: () => ({ method: 'inventory' }), terminalInputBody: () => ({}),
      adminRaw: input, adminOk: async () => ({ data: form === 'empty-inventory' ? [] : [{ soulId: 'owned-soul', launchState: form === 'running' ? 'running' : 'stopped',
        nativeIdentityObservation: form === 'published' ? { incarnationId: current.incarnationId } : null }] }),
      execOwnedContainerAsExact: async () => JSON.stringify(current) } as unknown as RuntimeHarness
    try {
      const result = completeAmplifierStaleWriter(harness, { containerId: 'owned-control' }, { scenario: 'amplifier-old-writer', workspace, nativeRoot: root,
        previousView: { soulId: 'owned-soul', incarnationId: prior.incarnationId }, previousSignal,
        seed: { transcript: { identity: ['2', '7', '22'], sha256: load.transcript.eofSha256 } },
        recovery: { result: { Ok: { data: { outcome: form === 'not-blocked' ? 'replaced' : 'blocked' } } } }, faultImage })
      if (form === 'valid') { const assertions = await result; expect(assertions.every(row => row.pass)).toBe(true); expect(assertions.length).toBeGreaterThan(2); expect(input).toHaveBeenCalledOnce() }
      else { await expect(result).rejects.toThrow(form === 'no-native-record' ? 'ENOENT' : 'actual Amplifier stale writer'); if (form !== 'admitted-input') expect(input).not.toHaveBeenCalled() }
    } finally { fs.rmSync(workspace, { recursive: true, force: true }) }
  })
  it('preserves selected Amplifier create profile and refuses a missing follow-up controller before workspace allocation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amplifier-case-route-'))
    const source = path.join(directory, 'selected-profile'); fs.writeFileSync(source, 'fixture-only selected profile')
    const workspaces: string[] = []
    const harness = { testRoot: directory, startSupervisor: async () => ({}), writeArtifact: () => '',
      adminOk: async (_supervisor: unknown, request: any) => {
        workspaces.push(request.params.terminal.cwd)
        expect(request.params.terminal.providerBootstrapFiles).toBeUndefined()
        expect(request.params.terminal.providerLaunchContext.config.map((file: any) => file.providerRelativePath))
          .toEqual(['.amplifier/settings.yaml', '.amplifier/bundles/default.yaml'])
        throw new Error('controlled native Amplifier launch boundary')
      } } as unknown as RuntimeHarness
    const sources = ['grants/env_file', 'grants/ca_file', '.amplifier/settings.yaml', '.amplifier/bundles/default.yaml']
      .map(name => ({ name: 'amplifier/' + name, path: source, sha256: 'e'.repeat(64) }))
    try {
      await expect(executeManagedNativeCase(harness, sources, { provider: 'amplifier', case: 'startup' }, 'create'))
        .rejects.toThrow('controlled native Amplifier launch boundary')
      // The next independent harness uses the same parent; it must not reuse
      // the prior case's source/profile/workspace directory.
      await expect(executeManagedNativeCase(harness, sources, { provider: 'amplifier', case: 'native-turn' }, 'current-native-turn'))
        .rejects.toThrow('actual terminal recovery requires the owned real server artifact')
      expect(workspaces).toEqual([path.join(directory, 'amplifier-create-workspace')])
      expect(fs.existsSync(path.join(directory, 'amplifier-current-native-turn-workspace'))).toBe(false)
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(['valid', 'missing-signal'])('captures actual Amplifier acknowledgement when launch already observed it (%s)', async (fault) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amplifier-initial-observation-'))
    const source = path.join(directory, 'selected-profile'); fs.writeFileSync(source, 'fixture selected profile')
    const capture = vi.fn(async (_container: string, uid: string, argv: string[]) => {
      expect(uid).toBe('65534:0')
      if (argv[0] === 'python3') {
        if (fault === 'missing-signal') throw new Error('owned native signal unreadable')
        return JSON.stringify({ launch: { incarnationId: 'current-incarnation' }, native: { load: { transcript: { path: '/owned/native-transcript' } } } })
      }
      return JSON.stringify({ uid: 65534, gid: 0, caps: '0000000000000000', readOnlyRoot: true,
        cliVersion: '0.1.1', coreVersion: '1.6.0', executableSha256: 'e'.repeat(64) })
    })
    const records = new Map<string, unknown>()
    const harness = { testRoot: directory, evidenceDir: directory, runId: ownerId, candidateSha, imageRef: imageDigest,
      startSupervisor: async () => ({}), execOwnedContainerAsExact: capture,
      writeArtifact: (name: string, value: unknown) => records.set(name, value),
      adminOk: async (_supervisor: unknown, request: any) => ({ data: { view: {
        containerId: 'owned-amplifier', incarnationId: 'current-incarnation', recoveryState: 'live', nativeSessionId: request.params.nativeSessionId,
        nativeIdentityObservation: { incarnationId: 'current-incarnation', nativeSessionId: request.params.nativeSessionId, source: 'amplifier_native_loaded_context' },
      } } }),
    } as unknown as RuntimeHarness
    const sources = ['grants/env_file', 'grants/ca_file', '.amplifier/settings.yaml', '.amplifier/bundles/default.yaml']
      .map(name => ({ name: 'amplifier/' + name, path: source, sha256: 'e'.repeat(64) }))
    try {
      const result = executeManagedNativeCase(harness, sources, { provider: 'amplifier', case: 'startup' }, 'create')
      if (fault === 'missing-signal') await expect(result).rejects.toThrow('owned native signal unreadable')
      else {
        expect((await result).assertions.every(row => row.pass)).toBe(true)
        expect(capture.mock.calls.filter(row => row[2][0] === 'python3')).toHaveLength(1)
        expect(JSON.parse(fs.readFileSync(path.join(directory, 'amplifier-create-native-signal-original.json'), 'utf8')).native.load.transcript.path)
          .toBe('/owned/native-transcript')
      }
      if (fault === 'missing-signal') expect(records.has('amplifier-create-original.json')).toBe(false)
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(['file-replacement', 'file-truncation', 'malformed-ack'].flatMap(fault =>
    ['valid', 'host-still-observed', 'input-admitted', 'no-file-change', 'wrong-root', 'wrong-launch', 'wrong-uid', 'invalid-original', 'source-changed', 'wrong-tls', 'missing-current-status']
      .map(form => [fault, form])))('requires actual native Amplifier ACK mutation through host status and input (%s, %s)', async (fault, form) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amplifier-ack-route-'))
    const source = path.join(directory, 'selected-profile'); fs.writeFileSync(source, 'fixture selected profile')
    let request: any, mutated = false
    const launch = () => ({ incarnationId: 'current-incarnation', launchNonce: 'current-nonce', evidenceRevision: 7,
      executionGeneration: 3, requestedNativeSessionId: request.params.nativeSessionId })
    const observation = () => ({ ...launch(), nativeSessionId: request.params.nativeSessionId, source: 'amplifier_native_loaded_context' })
    const signal = () => ({ launch: launch(), native: { session_id: request.params.nativeSessionId, parent_id: null,
      source: 'resume', producer_sha256: 'c'.repeat(64), load: { transcript: { path: '/owned/native/transcript.jsonl' } } } })
    const records = new Map<string, unknown>()
    const harness = { testRoot: directory, evidenceDir: directory, runId: ownerId, candidateSha, imageRef: imageDigest,
      startSupervisor: async () => ({ containerId: 'owned-control', runtimeRoot: '/tmp/frs/aaaaaaaa-bbb/r/amplif-aaaaaaaa/x' }),
      terminalInputBody: () => ({ method: 'terminal_input' }), writeArtifact: (name: string, value: unknown) => records.set(name, value),
      adminOk: async (_supervisor: unknown, input: any) => {
        request = input
        return { data: { view: { soulId: request.params.soulId, containerId: 'owned-amplifier', incarnationId: 'current-incarnation',
          nativeSessionId: request.params.nativeSessionId, recoveryState: 'live', launchState: 'running', nativeIdentityObservation: observation() } } }
      },
      adminRaw: async () => ({ result: form === 'input-admitted' ? { Ok: {} } : { Err: { code: 'RECOVERY_BLOCKED' } } }),
      execOwnedContainerAsExact: async (containerId: string, uid: string, argv: string[]) => {
        if (containerId === 'owned-control') {
          expect(uid).toBe('0:0')
          const observed = form !== 'missing-current-status' && (!mutated || form === 'host-still-observed')
          return JSON.stringify({ incarnationId: 'current-incarnation', exited: false, executionGeneration: 3,
            nativeSessionId: observed ? request.params.nativeSessionId : null, nativeIdentityObservation: observed ? observation() : null })
        }
        expect(uid).toBe('65534:0')
        if (argv[3] === fault) {
          execFileSync('python3', ['-c', 'import json,sys; value=json.loads(sys.argv[1]); assert value["native"]["load"]["transcript"]["mtimeNs"]==1790000000000000001', argv[4]!], { stdio: ['pipe', 'pipe', 'pipe'] })
          mutated = true
          return JSON.stringify({ fault, launch: { ...launch(), launchNonce: form === 'wrong-launch' ? 'old-nonce' : launch().launchNonce },
            nativeRoot: form === 'wrong-root' ? 'wrong-root' : request.params.nativeSessionId,
            uid: form === 'wrong-uid' ? 0 : 65534, gid: 0, originalSha256: 'a'.repeat(64), changedSha256: fault === 'file-replacement' || form === 'no-file-change' ? 'a'.repeat(64) : 'b'.repeat(64),
            beforeIdentity: ['1','2','100'], afterIdentity: ['1',fault === 'file-replacement' && form !== 'no-file-change' ? '3' : '2',fault === 'file-truncation' && form !== 'no-file-change' ? '99' : '100'],
            validBefore: form !== 'invalid-original', validAfter: fault !== 'malformed-ack' || form === 'no-file-change' })
        }
        if (argv[3] === '/owned/native/transcript.jsonl') return JSON.stringify({ nativeRoot: request.params.nativeSessionId,
          nativeCwd: request.params.terminal.cwd, httpsStatus: form === 'wrong-tls' ? 401 : 200, tlsVerifyMode: 2, tlsCheckHostname: true,
          completedTurns: 0, toolEvents: 0, transcript: { completeEof: true, sha256: form === 'source-changed' && mutated ? 'changed-source' : 'same-source' } })
        if (argv[0] === 'python3') return JSON.stringify(signal()).replace('"transcript":{', '"transcript":{"mtimeNs":1790000000000000001,')
        return JSON.stringify({ uid: 65534, gid: 0, caps: '0000000000000000', readOnlyRoot: true,
          cliVersion: '0.1.1', coreVersion: '1.6.0', executableSha256: 'e'.repeat(64) })
      },
    } as unknown as RuntimeHarness
    const sources = ['grants/env_file', 'grants/ca_file', '.amplifier/settings.yaml', '.amplifier/bundles/default.yaml']
      .map(name => ({ name: 'amplifier/' + name, path: source, sha256: 'e'.repeat(64) }))
    try {
      const run = executeManagedNativeCase(harness, sources, { provider: 'amplifier', case: 'startup' }, fault)
      if (form === 'valid') {
        const result = await run
        expect(mutated).toBe(true)
        expect(result.assertions.every(row => row.pass)).toBe(true)
        expect(records.has('amplifier-' + fault + '-original.json')).toBe(true)
      } else {
        await expect(run).rejects.toThrow(form === 'host-still-observed' ? 'authenticated native Amplifier host retained observation after ACK fault'
          : form === 'input-admitted' ? 'native Amplifier ACK fault admitted ordinary input'
          : form === 'wrong-tls' ? 'actual Amplifier native UID/TLS/profile before ACK fault differs'
          : form === 'missing-current-status' ? 'authenticated Amplifier host lacks current observation before file fault'
          : form === 'source-changed' ? 'native Amplifier ACK fault changed original history or dispatched a turn'
          : 'actual owned Amplifier ACK file fault condition missing')
        expect(records.has('amplifier-' + fault + '-original.json')).toBe(false)
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(['valid', 'requested-echo', 'old-nonce', 'old-incarnation', 'old-revision', 'old-generation', 'published', 'missing-event', 'admitted-input', 'signal-present', 'nonempty-root', 'parent-root', 'wrong-namespace'])('requires a current actual Amplifier wrong-root refusal (%s)', async (fault) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amplifier-wrong-root-'))
    const source = path.join(directory, 'selected-profile'); fs.writeFileSync(source, 'fixture selected profile')
    const records = new Map<string, unknown>()
    let request: any
    const launch = () => ({ incarnationId: 'current-incarnation', launchNonce: 'current-nonce', evidenceRevision: 7,
      executionGeneration: 3, requestedNativeSessionId: request.params.nativeSessionId })
    const view = () => ({ soulId: request.params.soulId, containerId: 'owned-amplifier', incarnationId: 'current-incarnation',
      launchState: fault === 'published' ? 'running' : 'starting', executionGeneration: 3, nativeSessionId: request.params.nativeSessionId })
    const harness = { testRoot: directory, evidenceDir: directory, runId: ownerId, candidateSha, imageRef: imageDigest,
      startSupervisor: async () => ({ containerId: 'owned-control' }),
      inventoryBody: () => ({ method: 'inventory' }),
      terminalReadOutputBody: () => ({ method: 'terminal_read_output' }),
      terminalInputBody: () => ({ method: 'terminal_input' }),
      writeArtifact: (name: string, value: unknown) => records.set(name, value),
      adminRaw: async (_supervisor: unknown, input: any) => {
        if (input.method === 'launch') { request = input; return { result: { Err: { code: 'RECOVERY_BLOCKED' } } } }
        return { result: fault === 'admitted-input' ? { Ok: {} } : { Err: { code: 'UNKNOWN_SOUL' } } }
      },
      adminOk: async (_supervisor: unknown, input: any) => {
        if (input.method === 'inventory') return { data: [view()] }
        const event: any = { severity: 'error', event: 'amplifier.native_root.refused', reason: 'native_root_mismatch',
          ...launch(), nativeSessionId: request.params.terminal.resumeSessionId }
        delete event.requestedNativeSessionId
        if (fault === 'requested-echo') event.nativeSessionId = request.params.nativeSessionId
        if (fault === 'old-nonce') event.launchNonce = 'old-nonce'
        if (fault === 'old-incarnation') event.incarnationId = 'old-incarnation'
        if (fault === 'old-revision') event.evidenceRevision--
        if (fault === 'old-generation') event.executionGeneration--
        return { data: { frames: [{ data: fault === 'missing-event' ? 'ordinary native output' : JSON.stringify(event) + '\n' }] } }
      },
      execOwnedContainerAsExact: async (containerId: string, uid: string) => {
        if (containerId === 'owned-control') { expect(uid).toBe('0:0'); return JSON.stringify(launch()) }
        expect(uid).toBe('65534:0')
        return JSON.stringify({ uid: fault === 'wrong-namespace' ? 0 : 65534, gid: 0, caps: '0000000000000000', readOnlyRoot: true,
          cliVersion: '0.1.1', coreVersion: '1.6.0', executableSha256: 'e'.repeat(64), producerSha256: 'f'.repeat(64),
          signalAbsent: fault !== 'signal-present', nativeRoot: request.params.terminal.resumeSessionId,
          parentId: fault === 'parent-root' ? 'other-parent' : null, messageCount: fault === 'nonempty-root' ? 1 : 0 })
      },
    } as unknown as RuntimeHarness
    const sources = ['grants/env_file', 'grants/ca_file', '.amplifier/settings.yaml', '.amplifier/bundles/default.yaml']
      .map(name => ({ name: 'amplifier/' + name, path: source, sha256: 'e'.repeat(64) }))
    try {
      const result = executeManagedNativeCase(harness, sources, { provider: 'amplifier', case: 'startup' }, 'wrong-root')
      if (fault === 'valid') {
        const original = await result
        expect(original.assertions.every(row => row.pass)).toBe(true)
        expect(request.params.terminal.resumeSessionId).not.toBe(request.params.nativeSessionId)
        expect(records.has('amplifier-wrong-root-original.json')).toBe(true)
      } else {
        await expect(result).rejects.toThrow(fault === 'published' ? 'Amplifier native fault published Running or an observation'
          : fault === 'admitted-input' ? 'Amplifier wrong-root admitted ordinary input'
          : ['signal-present', 'nonempty-root', 'parent-root', 'wrong-namespace'].includes(fault) ? 'owned Amplifier wrong-root source or namespace differs'
          : 'current actual Amplifier wrong native root evidence missing or stale')
        expect(records.has('amplifier-wrong-root-original.json')).toBe(false)
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(['exact', 'wrong-project', 'symlink'])('inspects only the exact owned Amplifier root without constructing a store under Docker default HOME (%s)', (fault) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amplifier-readonly-root-'))
    const packageRoot = path.join(directory, 'native'), pkg = path.join(packageRoot, 'amplifier_app_cli')
    const home = path.join(directory, 'provider'), defaultHome = path.join(directory, 'unused-default-home')
    const root = randomUUID(), store = path.join(home, '.amplifier', 'projects', fault === 'wrong-project' ? 'foreign-project' : directory.replaceAll('/', '-'), 'sessions', root)
    fs.mkdirSync(pkg, { recursive: true }); fs.mkdirSync(store, { recursive: true })
    fs.mkdirSync(path.join(packageRoot, '.venv', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(packageRoot, '.venv', 'bin', 'amplifier'), 'fixture native console')
    const patch = fs.readFileSync(path.join(process.cwd(), 'extensions/amplifier/freshell-native-resume.patch'), 'utf8')
    const section = patch.split('+++ b/amplifier_app_cli/freshell_native_resume.py\n')[1]!.split('--- a/amplifier_app_cli/runtime/config.py')[0]!
    fs.writeFileSync(path.join(pkg, 'freshell_native_resume.py'), section.split('\n').filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n') + '\n')
    fs.writeFileSync(path.join(pkg, 'session_store.py'), 'class SessionStore:\n def __init__(self):raise RuntimeError("inspection must not create a SessionStore")\n')
    for (const [name, version] of [['amplifier-app-cli', '0.1.1'], ['amplifier-core', '1.6.0']]) {
      const dist = path.join(packageRoot, name.replaceAll('-', '_') + '-' + version + '.dist-info'); fs.mkdirSync(dist)
      fs.writeFileSync(path.join(dist, 'METADATA'), `Name: ${name}\nVersion: ${version}\n`)
    }
    fs.writeFileSync(path.join(store, 'metadata.json'), JSON.stringify({ session_id: root, parent_id: null }))
    fs.writeFileSync(path.join(store, 'transcript.jsonl'), '')
    if (fault === 'symlink') {
      const metadata = path.join(store, 'metadata.json'); fs.renameSync(metadata, path.join(directory, 'foreign-metadata.json'))
      fs.symlinkSync(path.join(directory, 'foreign-metadata.json'), metadata)
    }
    const script = amplifierWrongRootInspection.replaceAll('/opt/amplifier-src', packageRoot).replaceAll('/home/freshell/provider', home)
    try {
      const read = () => execFileSync('python3', ['-c', script, directory, root, 'current-nonce'], {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: defaultHome, PYTHONPATH: packageRoot },
      })
      if (fault !== 'exact') { expect(read).toThrow('AssertionError'); expect(fs.existsSync(defaultHome)).toBe(false); return }
      const result = JSON.parse(read())
      expect(result.nativeRoot).toBe(root); expect(result.parentId).toBeNull()
      expect(result.messageCount).toBe(0); expect(result.signalAbsent).toBe(true)
      expect(result.load.transcript.path).toBe(path.join(store, 'transcript.jsonl'))
      expect(fs.existsSync(defaultHome)).toBe(false)
      expect(fs.readFileSync(path.join(store, 'transcript.jsonl'), 'utf8')).toBe('')
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(['missing-history', 'load-failure', 'missing-context-restore', 'timeout', 'provider-exit', 'stop-cancellation', 'parent-root', 'old-writer'].flatMap(fault => ['current', 'ordinary', 'wrong-cli-pin', 'wrong-producer-pin', 'missing-launch', 'wrong-root'].map(form => ({ fault, form }))))('executes the fixed owned Amplifier native startup fault $fault/$form', ({ fault, form }) => {
    const pending = ['timeout', 'provider-exit', 'stop-cancellation'].includes(fault)
    const directory = path.join('/tmp/frs', randomUUID().slice(0, 8) + '-abc')
    const workspace = path.join(directory, 'amplifier-' + (form === 'ordinary' ? 'create' : fault) + '-workspace')
    const native = path.join(directory, 'native'), pkg = path.join(native, 'amplifier_app_cli'), root = randomUUID()
    const store = path.join(directory, 'provider', '.amplifier', 'projects', workspace.replaceAll('/', '-'), 'sessions', root)
    fs.mkdirSync(pkg, { recursive: true }); fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(store, { recursive: true })
    fs.mkdirSync(path.join(native, '.venv', 'bin'), { recursive: true })
    const patch = fs.readFileSync(path.join(process.cwd(), 'extensions/amplifier/freshell-native-resume.patch'), 'utf8')
    const section = patch.split('+++ b/amplifier_app_cli/freshell_native_resume.py\n')[1]!.split('--- a/amplifier_app_cli/runtime/config.py')[0]!
    const producer = path.join(pkg, 'freshell_native_resume.py')
    fs.writeFileSync(producer, section.split('\n').filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n') + '\n')
    fs.writeFileSync(path.join(store, 'metadata.json'), JSON.stringify({ session_id: root, parent_id: null }))
    fs.writeFileSync(path.join(store, 'transcript.jsonl'), '')
    fs.writeFileSync(path.join(pkg, 'session_store.py'), `import pathlib,os\nfrom .freshell_native_resume import load_native\nclass SessionStore:\n def __init__(self):self.base_dir=pathlib.Path(os.environ['OWNED_STORE'])\n def load(self,root):return load_native(self,root)\n`)
    fs.writeFileSync(path.join(pkg, 'session_runner.py'), `import types,sys\nclass Context:\n async def set_messages(self,m):pass\n async def get_messages(self):return []\nasync def _create_bundle_session(*args,**kwargs):\n async def cleanup():pass\n context=Context();return types.SimpleNamespace(session_id=sys.argv[-1],parent_id=None,cleanup=cleanup,coordinator=types.SimpleNamespace(get=lambda name:context if name=='context' else None))\n`)
    const cli = path.join(native, '.venv', 'bin', 'amplifier.native')
    fs.writeFileSync(cli, `import asyncio,json,sys,time,types\nfrom amplifier_app_cli.session_store import SessionStore\nfrom amplifier_app_cli import session_runner,freshell_native_resume\nfailed=False;loaded=None\ntry:loaded,_=SessionStore().load(sys.argv[-1])\nexcept (OSError,ValueError):failed=True\nsession=asyncio.run(session_runner._create_bundle_session())\nif ${pending || fault === 'old-writer' ? 'True' : 'False'}:\n time.sleep=lambda seconds:None\n try:asyncio.run(freshell_native_resume.publish_initialized(session,types.SimpleNamespace(is_resume=True,initial_transcript=loaded)))\n except RuntimeError:pass\nprint(json.dumps({'loadFailed':failed,'hasRestore':hasattr(session.coordinator.get('context'),'set_messages')}))\n`)
    const cliSha = createHash('sha256').update(fs.readFileSync(cli)).digest('hex'), producerSha = createHash('sha256').update(fs.readFileSync(producer)).digest('hex')
    const script = nativeAmplifierStartupFaultWrapper.replaceAll('/opt/amplifier-src', native)
      .replace('b46da0c1095accbb6daf4fffc5936a26e172671713cba6688df4dc5c93c210e4', cliSha)
      .replace('1682141140822739c4cd88b7314c3b0daff7ccae1ffb55b7b72f235759123690', producerSha)
    const wrapper = path.join(directory, 'wrapper.py'); fs.writeFileSync(wrapper, script)
    const launch = { incarnationId: 'current-incarnation', launchNonce: 'current-nonce', evidenceRevision: 7, executionGeneration: 3, requestedNativeSessionId: root }
    if (form === 'wrong-cli-pin') fs.appendFileSync(cli, '\n# changed CLI\n')
    if (form === 'wrong-producer-pin') fs.appendFileSync(producer, '\n# changed producer\n')
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: path.join(directory, 'provider'), PYTHONPATH: native,
      OWNED_STORE: path.dirname(store), FRESHELL_NATIVE_IDENTITY_LAUNCH: JSON.stringify(form === 'wrong-root' ? { ...launch, requestedNativeSessionId: randomUUID() } : launch),
      FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR: path.join(directory, 'signals') }
    if (form === 'missing-launch') delete env.FRESHELL_NATIVE_IDENTITY_LAUNCH
    const previousLaunch = { ...launch, incarnationId: 'previous-incarnation', launchNonce: 'previous-nonce', evidenceRevision: 6 }
    if (fault === 'old-writer') {
      execFileSync('python3', [cli, 'session', 'resume', '--full-history', root], {
        cwd: workspace, env: { ...env, FRESHELL_NATIVE_IDENTITY_LAUNCH: JSON.stringify(previousLaunch),
          FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR: path.join(directory, 'previous-signals') }, stdio: ['pipe', 'pipe', 'pipe'],
      })
      fs.copyFileSync(path.join(directory, 'previous-signals', 'amplifier-loaded-context.json'), path.join(workspace, 'prior-native-signal.json'))
    }
    try {
      const run = () => execFileSync('python3', [wrapper, 'session', 'resume', '--full-history', root], {
        cwd: workspace, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        env,
      })
      if (!['current', 'ordinary'].includes(form)) {
        expect(run).toThrow(form === 'wrong-cli-pin' ? 'pinned ordinary Amplifier CLI differs'
          : form === 'wrong-producer-pin' ? 'pinned native Amplifier producer differs'
          : form === 'missing-launch' ? 'managed native launch binding is incomplete' : 'exact owned native resume argv/root differs')
        expect(fs.existsSync(path.join(workspace, 'native-startup-fault.json'))).toBe(false)
        expect(fs.readFileSync(path.join(store, 'transcript.jsonl'), 'utf8')).toBe('')
        return
      }
      const result = JSON.parse(run())
      if (form === 'ordinary') {
        expect(result).toEqual({ loadFailed: false, hasRestore: true })
        expect(fs.existsSync(path.join(workspace, 'native-startup-fault.json'))).toBe(false)
        expect(fs.readFileSync(path.join(store, 'transcript.jsonl'), 'utf8')).toBe('')
        return
      }
      expect(result.loadFailed).toBe(['missing-history', 'load-failure', 'parent-root'].includes(fault))
      expect(result.hasRestore).toBe(fault !== 'missing-context-restore')
      const observed = JSON.parse(fs.readFileSync(path.join(workspace, 'native-startup-fault.json'), 'utf8'))
      expect(observed.fault).toBe(fault); expect(observed.launch).toEqual(launch)
      expect(observed.nativePid).toBeGreaterThan(1); expect(observed.originalCliSha256).toBe(cliSha)
      if (fault === 'old-writer') {
        expect(observed.phase).toBe('before-stale-native-publication')
        expect(observed.previousLaunch).toEqual(previousLaunch)
        const native = JSON.parse(fs.readFileSync(path.join(directory, 'signals', 'amplifier-loaded-context.json'), 'utf8'))
        expect(native.launch).toEqual(previousLaunch); expect(native.native.session_id).toBe(root)
        expect(native.native.load.sessionId).toBe(root); expect(native.native.parent_id).toBeNull()
        const publication = JSON.parse(fs.readFileSync(path.join(workspace, 'native-stale-publication.json'), 'utf8'))
        expect(publication.currentLaunch).toEqual(launch)
        expect(publication.nativeSignal).toEqual(native)
        expect(publication.signalText).toBe(fs.readFileSync(path.join(directory, 'signals', 'amplifier-loaded-context.json'), 'utf8'))
        expect(publication.signalSha256).toBe(createHash('sha256').update(fs.readFileSync(path.join(directory, 'signals', 'amplifier-loaded-context.json'))).digest('hex'))
      }
      if (fault === 'parent-root') {
        expect(observed.phase).toBe('before-native-load')
        expect(observed.originalLoad.sessionId).toBe(root); expect(observed.originalLoad.parentId).toBeNull()
        expect(observed.nativeParent).toBeTruthy()
        expect(JSON.parse(fs.readFileSync(path.join(store, 'metadata.json'), 'utf8')).parent_id).toBe(observed.nativeParent)
        expect(fs.readFileSync(path.join(store, 'transcript.jsonl'), 'utf8')).toBe('')
        expect(fs.existsSync(path.join(directory, 'signals', 'amplifier-loaded-context.json'))).toBe(false)
      }
      if (pending) {
        expect(observed.phase).toBe('before-native-publication')
        expect(observed.nativeRoot).toBe(root); expect(observed.nativeParent).toBeNull()
        expect(observed.originalLoad.sessionId).toBe(root); expect(observed.acceptedMessageCount).toBe(0)
        expect(fs.existsSync(path.join(directory, 'signals', 'amplifier-loaded-context.json'))).toBe(false)
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(['missing-history', 'load-failure', 'missing-context-restore', 'parent-root'].flatMap(fault => ['current', 'missing-fault', 'old-launch', 'wrong-fault', 'wrong-phase', 'missing-native-condition', 'published', 'signal-published', 'wrong-image', 'admitted-input', 'wrong-descriptor'].map(form => ({ fault, form }))))('requires actual current owned Amplifier startup fault evidence $fault/$form', async ({ fault, form }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amplifier-source-fault-route-'))
    const source = path.join(directory, 'selected-profile'); fs.writeFileSync(source, 'fixture selected profile')
    const descriptor = { schemaVersion: 1, imageDigest: form === 'wrong-descriptor' ? `sha256:${'0'.repeat(64)}` : imageDigest, wrapperSourceSha: candidateSha, wrapperSha256: 'e'.repeat(64),
      originalCliSha256: 'f'.repeat(64), producerSha256: 'c'.repeat(64), cases: fault === 'parent-root'
        ? ['missing-history', 'load-failure', 'missing-context-restore', 'timeout', 'provider-exit', 'stop-cancellation', 'parent-root']
        : ['missing-history', 'load-failure', 'missing-context-restore'] }
    const descriptorFile = path.join(directory, 'fault.json'); fs.writeFileSync(descriptorFile, JSON.stringify(descriptor))
    const records = new Map<string, unknown>(); let request: any
    const launch = () => ({ incarnationId: 'current-incarnation', launchNonce: 'current-nonce', evidenceRevision: 7,
      executionGeneration: 3, requestedNativeSessionId: request.params.nativeSessionId })
    const harness = { testRoot: directory, evidenceDir: directory, runId: ownerId, candidateSha, imageRef: imageDigest,
      startSupervisor: async () => ({ containerId: 'owned-control' }),
      inventoryBody: () => ({ method: 'inventory' }), terminalReadOutputBody: () => ({ method: 'terminal_read_output' }), terminalInputBody: () => ({ method: 'terminal_input' }),
      writeArtifact: (name: string, value: unknown) => records.set(name, value),
      adminRaw: async (_supervisor: unknown, input: any) => {
        if (input.method === 'launch') {
          request = input
          const applied: any = {
            severity: 'warning', event: 'test.amplifier.native_startup_fault.applied', fault,
            phase: fault === 'missing-context-restore' ? 'before-native-context-restore' : 'before-native-load', launch: launch(),
            nativePid: process.pid, uid: 65534, gid: 0, caps: '0000000000000000', readOnlyRoot: true, nativeCwd: request.params.terminal.cwd,
            originalCliSha256: descriptor.originalCliSha256, producerSha256: descriptor.producerSha256,
            originalLoad: { sessionId: request.params.nativeSessionId, parentId: null, messageCount: 0 },
            transcriptAbsent: fault === 'missing-history', malformedSha256: fault === 'load-failure' ? 'd'.repeat(64) : null,
            hasRestoreBefore: true, hasRestoreAfter: false, originalContextType: 'controlled.native.Context',
            nativeParent: fault === 'parent-root' ? randomUUID() : null,
          }
          if (form === 'old-launch') applied.launch.launchNonce = 'old-nonce'
          if (form === 'wrong-fault') applied.fault = 'another-case'
          if (form === 'wrong-phase') applied.phase = 'after-failed-restore'
          if (form === 'missing-native-condition') { applied.transcriptAbsent = false; applied.malformedSha256 = null; applied.hasRestoreAfter = true; applied.nativeParent = null }
          if (form !== 'missing-fault') fs.writeFileSync(path.join(request.params.terminal.cwd, 'native-startup-fault.json'), JSON.stringify(applied))
          return { result: { Err: { code: 'RECOVERY_BLOCKED' } } }
        }
        return { result: form === 'admitted-input' ? { Ok: {} } : { Err: { code: 'UNKNOWN_SOUL' } } }
      },
      adminOk: async (_supervisor: unknown, input: any) => input.method === 'inventory' ? { data: [{
        soulId: request.params.soulId, incarnationId: 'current-incarnation', containerId: 'owned-amplifier', launchState: form === 'published' ? 'running' : 'starting', executionGeneration: 3,
      }] } : { data: { frames: [{ data: JSON.stringify({ severity: 'error', event: 'amplifier.native_load.refused', reason: 'no_complete_native_load', ...launch() }) + '\n' }] } },
      execOwnedContainerAsExact: async (containerId: string, uid: string) => {
        expect(uid).toBe(containerId === 'owned-control' ? '0:0' : '65534:0')
        return JSON.stringify(containerId === 'owned-control' ? launch() : { uid: 65534, gid: 0, caps: '0000000000000000', readOnlyRoot: true,
          cliVersion: '0.1.1', coreVersion: '1.6.0', executableSha256: form === 'wrong-image' ? '0'.repeat(64) : descriptor.wrapperSha256, producerSha256: descriptor.producerSha256, signalAbsent: form !== 'signal-published' })
      },
    } as unknown as RuntimeHarness
    const sources = ['grants/env_file', 'grants/ca_file', '.amplifier/settings.yaml', '.amplifier/bundles/default.yaml']
      .map(name => ({ name: 'amplifier/' + name, path: source, sha256: 'e'.repeat(64) }))
    sources.push({ name: 'amplifier/native-fault/startup.json', path: descriptorFile, sha256: createHash('sha256').update(fs.readFileSync(descriptorFile)).digest('hex') })
    try {
      const run = executeManagedNativeCase(harness, sources, { provider: 'amplifier', case: 'startup' }, fault)
      if (form === 'current') {
        const original = await run
        expect(original.assertions.every(row => row.pass)).toBe(true)
        expect(records.has('amplifier-' + fault + '-original.json')).toBe(true)
        expect(request.params.terminal.resumeSessionId).toBe(request.params.nativeSessionId)
      } else {
        await expect(run).rejects.toThrow(form === 'missing-fault' ? 'ENOENT'
          : form === 'wrong-descriptor' ? 'actual owned Amplifier fault image binding differs'
          : form === 'published' ? 'Amplifier native fault published Running or an observation'
          : ['old-launch', 'wrong-fault'].includes(form) ? 'current actual Amplifier startup fault binding missing or stale'
          : ['wrong-phase', 'missing-native-condition'].includes(form) ? fault === 'missing-context-restore' ? 'actual native Amplifier context restore method fault missing' : 'actual native Amplifier unloaded history fault missing'
          : form === 'admitted-input' ? 'Amplifier startup fault admitted ordinary input' : 'actual Amplifier fault image or native signal differs')
        expect(records.has('amplifier-' + fault + '-original.json')).toBe(false)
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(['timeout', 'provider-exit', 'stop-cancellation'].flatMap(fault =>
    ['valid', 'wrong-cli-version', 'wrong-core-version', 'wrong-wrapper', 'wrong-native-cli', 'wrong-producer', 'missing-version', 'changed-source-identity', 'changed-source-eof', 'early-timeout', 'native-still-alive', 'stop-unconfirmed']
      .map(form => [fault, form])))('executes current owned Amplifier pending launch containment (%s, %s)', async (fault, form) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amplifier-pending-route-'))
    const source = path.join(directory, 'selected-profile'); fs.writeFileSync(source, 'fixture selected profile')
    const descriptor = { schemaVersion: 1, imageDigest, wrapperSourceSha: candidateSha, wrapperSha256: 'e'.repeat(64),
      originalCliSha256: 'f'.repeat(64), producerSha256: 'c'.repeat(64), cases: ['missing-history', 'load-failure', 'missing-context-restore', 'timeout', 'provider-exit', 'stop-cancellation'] }
    const file = path.join(directory, 'fault-image.json'); fs.writeFileSync(file, JSON.stringify(descriptor))
    let now = 1_000_000, request: any, release: ((value: any) => void) | undefined, completion: ReturnType<typeof setTimeout> | undefined
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const records = new Map<string, unknown>(), killed = vi.fn()
    const launch = () => ({ incarnationId: 'current-incarnation', launchNonce: 'current-nonce', evidenceRevision: 7,
      executionGeneration: 3, requestedNativeSessionId: request.params.nativeSessionId })
    const view = () => ({ soulId: request.params.soulId, incarnationId: 'current-incarnation', containerId: 'owned-amplifier',
      launchState: fault === 'stop-cancellation' ? 'stopped' : 'starting', desiredState: fault === 'stop-cancellation' ? 'stopped' : 'running', recoveryState: fault === 'stop-cancellation' ? 'stopped' : 'live', executionGeneration: 3 })
    const harness = { testRoot: directory, evidenceDir: directory, runId: ownerId, candidateSha, imageRef: imageDigest,
      startSupervisor: async () => ({ containerId: 'owned-control' }), broker: { receipts: () => [{ soulId: request?.params.soulId, containerId: 'owned-amplifier' }] },
      inventoryBody: () => ({ method: 'inventory' }), terminalReadOutputBody: () => ({ method: 'terminal_read_output' }),
      terminalInputBody: () => ({ method: 'terminal_input' }), stopBody: () => ({ method: 'stop' }),
      writeArtifact: (name: string, value: unknown) => records.set(name, value),
      killOwnedRuntimePidExact: (containerId: string, pid: number, signal: string) => {
        killed(containerId, pid, signal); release!({ result: { Err: { code: 'RECOVERY_BLOCKED' } } })
      },
      adminRaw: (_supervisor: unknown, input: any) => {
        if (input.method !== 'launch') return Promise.resolve({ result: { Err: { code: 'UNKNOWN_SOUL' } } })
        request = input
        fs.writeFileSync(path.join(input.params.terminal.cwd, 'native-startup-fault.json'), JSON.stringify({
          severity: 'warning', event: 'test.amplifier.native_startup_fault.applied', fault, phase: 'before-native-publication',
          launch: launch(), nativePid: 55, uid: 65534, gid: 0, caps: '0000000000000000', readOnlyRoot: true,
          nativeCwd: input.params.terminal.cwd, originalCliSha256: descriptor.originalCliSha256, producerSha256: descriptor.producerSha256,
          nativeRoot: input.params.nativeSessionId, nativeParent: null, originalLoad: { sessionId: input.params.nativeSessionId,
            parentId: null, messageCount: 0, transcript: { path: '/owned/native/transcript.jsonl', device: 1, inode: 2, size: 0, mtimeNs: 3, ctimeNs: 4, eofSha256: 'd'.repeat(64) } }, acceptedMessageCount: 0,
        }))
        return new Promise(resolve => { release = resolve })
      },
      adminOk: async (_supervisor: unknown, input: any) => {
        if (input.method === 'stop') {
          release!({ result: { Err: { code: 'STALE_INTENT_REVISION' } } })
          return { data: { outcome: form === 'stop-unconfirmed' ? 'unknown' : 'verified_empty', view: view() } }
        }
        return input.method === 'inventory' ? { data: [view()] } : { data: { frames: [] } }
      },
      execOwnedContainerAsExact: async (containerId: string, uid: string, argv: string[]) => {
        if (containerId === 'owned-control') {
          const database = path.join(directory, 'controlled-runtime.sqlite3')
          execFileSync('python3', ['-c', "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE incarnations(soul_id TEXT, launch_state TEXT, native_identity_launch TEXT)'); c.executemany('INSERT INTO incarnations VALUES (?,?,?)',[(sys.argv[2],'stopped','{}'),(sys.argv[2],'starting',sys.argv[3])]); c.commit()", database, request.params.soulId, JSON.stringify(launch())])
          return execFileSync(argv[0]!, ['-c', argv[2]!.replace('file:/var/lib/freshell-supervisor/runtime.sqlite3?mode=ro', 'file:' + database + '?mode=ro'), ...argv.slice(3)], { encoding: 'utf8' })
        }
        expect(uid).toBe('65534:0')
        if (argv[3] === '/owned/native/transcript.jsonl') {
          completion = setTimeout(() => { now += form === 'early-timeout' ? 7_000 : 9_000; release!({ result: { Err: { code: 'RECOVERY_BLOCKED' } } }) }, 0)
          return JSON.stringify({ nativeRoot: request.params.nativeSessionId, nativePid: 55,
            cliVersion: form === 'missing-version' ? undefined : form === 'wrong-cli-version' ? '0.0.0' : '0.1.1',
            coreVersion: form === 'wrong-core-version' ? '0.0.0' : '1.6.0',
            executableSha256: form === 'wrong-wrapper' ? '0'.repeat(64) : descriptor.wrapperSha256,
            originalCliSha256: form === 'wrong-native-cli' ? '0'.repeat(64) : descriptor.originalCliSha256,
            producerSha256: form === 'wrong-producer' ? '0'.repeat(64) : descriptor.producerSha256,
            httpsStatus: 200, tlsVerifyMode: 2, tlsCheckHostname: true, nativeCwd: request.params.terminal.cwd,
            metadata: { session_id: request.params.nativeSessionId, parent_id: null }, completedTurns: 0, toolEvents: 0,
            transcript: { completeEof: true, identity: [form === 'changed-source-identity' ? '9' : '1','2','0','3','4'], sha256: form === 'changed-source-eof' ? '0'.repeat(64) : 'd'.repeat(64) }, profileFiles: [] })
        }
        if (form === 'native-still-alive') now += 3_000
        return JSON.stringify({ nativeExited: form !== 'native-still-alive' })
      },
    } as unknown as RuntimeHarness
    const sources = ['grants/env_file', 'grants/ca_file', '.amplifier/settings.yaml', '.amplifier/bundles/default.yaml']
      .map(name => ({ name: 'amplifier/' + name, path: source, sha256: 'e'.repeat(64) }))
    sources.push({ name: 'amplifier/native-fault/startup.json', path: file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') })
    try {
      const run = executeManagedNativeCase(harness, sources, { provider: 'amplifier', case: 'startup' }, fault)
      const refusal = !['valid', 'early-timeout', 'native-still-alive', 'stop-unconfirmed'].includes(form)
        ? 'actual unobserved Amplifier UID/TLS/profile unavailable before fault'
        : form === 'early-timeout' && fault === 'timeout' ? 'actual Amplifier native startup wait was not bounded by the existing deadline'
        : form === 'native-still-alive' && fault === 'provider-exit' ? 'owned Amplifier native PID remained alive after exit fault'
        : form === 'stop-unconfirmed' && fault === 'stop-cancellation' ? 'ordinary Amplifier Stop did not confirm empty stopped intent' : undefined
      if (refusal) {
        await expect(run).rejects.toThrow(refusal)
        if (refusal === 'actual unobserved Amplifier UID/TLS/profile unavailable before fault') expect(killed).not.toHaveBeenCalled()
        expect(records.has('amplifier-' + fault + '-original.json')).toBe(false)
      } else {
        const original = await run
        expect(original.assertions.every(row => row.pass)).toBe(true)
        expect(original.nativeVersion).toBe('amplifier-app-cli 0.1.1; amplifier-core 1.6.0')
        expect(original.executableSha256).toBe(descriptor.wrapperSha256)
        expect(killed).toHaveBeenCalledTimes(fault === 'provider-exit' ? 1 : 0)
        if (fault === 'provider-exit') expect(killed).toHaveBeenCalledWith('owned-amplifier', 55, 'TERM')
        expect(records.has('amplifier-' + fault + '-original.json')).toBe(true)
      }
    } finally { if (completion) clearTimeout(completion); clock.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(['matching', 'wrong-root', 'parent-root', 'missing-root'])('executes the pinned Amplifier producer with current native root diagnostics (%s)', (fault) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amplifier-native-root-event-'))
    const patch = fs.readFileSync(path.join(process.cwd(), 'extensions/amplifier/freshell-native-resume.patch'), 'utf8')
    const section = patch.split('+++ b/amplifier_app_cli/freshell_native_resume.py\n')[1]!.split('--- a/amplifier_app_cli/runtime/config.py')[0]!
    const source = section.split('\n').filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n') + '\n'
    const module = path.join(directory, 'native_producer.py'); fs.writeFileSync(module, source)
    const requested = randomUUID(), actual = fault === 'wrong-root' ? randomUUID() : fault === 'missing-root' ? '' : requested
    const script = String.raw`import asyncio,contextlib,importlib.util,io,json,os,pathlib,sys,types
module_file,directory,requested,actual,fault=sys.argv[1:]
spec=importlib.util.spec_from_file_location('actual_producer',module_file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
root=pathlib.Path(directory);store=root/'owned-store';session_dir=store/actual;session_dir.mkdir(parents=True)
(session_dir/'transcript.jsonl').write_text('')
(session_dir/'metadata.json').write_text(json.dumps({'session_id':actual,'parent_id':None}))
loaded,_=module.load_native(types.SimpleNamespace(base_dir=store),actual)
class Context:
 def __init__(self):self.messages=[]
 async def set_messages(self,messages):self.messages=list(messages)
 async def get_messages(self):return self.messages
context=Context();asyncio.run(context.set_messages(loaded))
class Session:
 session_id=actual;parent_id='existing-parent' if fault=='parent-root' else None;cleaned=False
 coordinator={'context':context}
 async def cleanup(self):self.cleaned=True
session=Session();signal_dir=root/'current-signal'
os.environ['FRESHELL_NATIVE_IDENTITY_LAUNCH']=json.dumps({'incarnationId':'current-incarnation','launchNonce':'current-nonce','evidenceRevision':7,'executionGeneration':3,'requestedNativeSessionId':requested})
os.environ['FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR']=str(signal_dir)
capture=io.StringIO();failure=None
with contextlib.redirect_stderr(capture):
 try:asyncio.run(module.publish_initialized(session,types.SimpleNamespace(is_resume=True,initial_transcript=loaded)))
 except ValueError as error:failure=str(error)
print(json.dumps({'events':[json.loads(line) for line in capture.getvalue().splitlines()], 'cleaned':session.cleaned,'published':(signal_dir/'amplifier-loaded-context.json').exists(),'failed':failure is not None}))`
    try {
      const result = JSON.parse(execFileSync('python3', ['-c', script, module, directory, requested, actual, fault], { encoding: 'utf8' }))
      const refusals = result.events.filter((event: any) => event.event === 'amplifier.native_root.refused')
      if (fault === 'wrong-root') {
        expect(refusals).toHaveLength(1)
        expect(refusals[0]).toEqual({ severity: 'error', event: 'amplifier.native_root.refused', reason: 'native_root_mismatch',
          incarnationId: 'current-incarnation', launchNonce: 'current-nonce', evidenceRevision: 7, executionGeneration: 3, nativeSessionId: actual })
        expect(refusals[0].nativeSessionId).not.toBe(requested)
      } else expect(refusals).toHaveLength(0)
      expect(result.published).toBe(fault === 'matching')
      expect(result.cleaned).toBe(fault !== 'matching')
      expect(result.failed).toBe(fault !== 'matching')
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(['split','sdk-inline','wrong-root','duplicate','missing','lookalike'])('correlates the exact actual native resume argv root (%s)', form=>{
    const root=randomUUID(),argv=form==='split'?['--resume',root]:form==='sdk-inline'?['--resume='+root]:form==='wrong-root'?['--resume='+randomUUID()]:form==='duplicate'?['--resume',root,'--resume='+root]:form==='missing'?['--resume']:['--resume-session-at='+root]
    expect(nativeResumeRootInArgv(argv,root)).toBe(form==='split'||form==='sdk-inline')
  })
  it.each(['split','sdk-inline'].flatMap(form=>['ordinary-create','ordinary-resume','owned-fork','owned-duplicate','wrong-root','missing-launch','wrong-pin'].map(fault=>({form,fault}))))('executes only the fixed owned SDK resume-fork fault $form/$fault', ({form,fault}) => {
    const root=path.join('/tmp/frs',randomUUID().slice(0,12));const workspace=path.join(root,'freshclaude-'+(fault==='ordinary-resume'?'exact-resume':'wrong-id')+'-workspace')
    fs.mkdirSync(workspace,{recursive:true,mode:0o700})
    const native=path.join(root,'native-child'),wrapper=path.join(root,'wrapper.py'),requested=randomUUID()
    fs.writeFileSync(native,'#!/usr/bin/python3\nimport sys,json\nprint(json.dumps(sys.argv[1:]))\n',{mode:0o700});fs.chmodSync(native,0o700)
    const expected=createHash('sha256').update(fs.readFileSync(native)).digest('hex')
    const staged=nativeSdkResumeForkWrapper.replaceAll('/opt/freshell-claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude.native',native)
      .replace('73975167f0108693cf6fd6614994781657ebb8456ebef5d247458734abfb3916',fault==='wrong-pin'?'0'.repeat(64):expected)
    fs.writeFileSync(wrapper,staged)
    const argv=fault==='ordinary-create'?['--model','selected-model']:[...(form==='sdk-inline'?['--resume='+requested]:['--resume',requested]),'--model','selected-model',...(fault==='owned-duplicate'?['--fork-session']:[])]
    const env={...process.env};delete env.FRESHELL_NATIVE_IDENTITY_LAUNCH
    if(fault!=='missing-launch')env.FRESHELL_NATIVE_IDENTITY_LAUNCH=JSON.stringify({launchNonce:'current-nonce',incarnationId:'current-incarnation',requestedNativeSessionId:fault==='wrong-root'?randomUUID():requested})
    try {
      const run=()=>execFileSync('python3',[wrapper,...argv],{cwd:workspace,env,encoding:'utf8',stdio:['pipe','pipe','pipe']})
      if(fault==='wrong-root'||fault==='missing-launch'||fault==='wrong-pin')expect(run).toThrow()
      else expect(JSON.parse(run())).toEqual(fault==='owned-fork'?[...argv,'--fork-session']:argv)
    } finally {fs.rmSync(root,{recursive:true,force:true})}
  })
  it.each(['ambiguous-root','missing-root','ordinary-malformed'])('fences ambiguous owned SDK resume and preserves ordinary argv (%s)',fault=>{
    const root=path.join('/tmp/frs',randomUUID().slice(0,12)),workspace=path.join(root,`kilroy-${fault==='ordinary-malformed'?'exact-resume':'wrong-id'}-workspace`)
    fs.mkdirSync(workspace,{recursive:true});const child=path.join(root,'child'),wrapper=path.join(root,'wrapper.py'),requested=randomUUID()
    fs.writeFileSync(child,'#!/usr/bin/python3\nimport sys,json\nprint(json.dumps(sys.argv[1:]))\n',{mode:0o700});fs.chmodSync(child,0o700)
    fs.writeFileSync(wrapper,nativeSdkResumeForkWrapper.replaceAll('/opt/freshell-claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude.native',child).replace('73975167f0108693cf6fd6614994781657ebb8456ebef5d247458734abfb3916',createHash('sha256').update(fs.readFileSync(child)).digest('hex')))
    const argv=fault==='ambiguous-root'?['--resume='+requested,'--resume',requested]:['--resume']
    try {
      const run=()=>execFileSync('python3',[wrapper,...argv],{cwd:workspace,env:{...process.env,FRESHELL_NATIVE_IDENTITY_LAUNCH:JSON.stringify({launchNonce:'current',incarnationId:'current',requestedNativeSessionId:requested})},encoding:'utf8',stdio:['pipe','pipe','pipe']})
      if(fault==='ordinary-malformed')expect(JSON.parse(run())).toEqual(argv)
      else expect(run).toThrow()
    } finally {fs.rmSync(root,{recursive:true,force:true})}
  })
  it.each(['freshclaude','kilroy'].flatMap(mode=>['split','sdk-inline'].flatMap(form=>
    ['valid','wrong-root','missing-launch','invalid-anchor','existing-anchor','ordinary'].map(fault=>({mode,form,fault})))))(
    'executes only the owned supported post-hook SDK resume-anchor fault $mode/$form/$fault',({mode,form,fault})=>{
      const directory=path.join('/tmp/frs',randomUUID().slice(0,12))
      const workspace=path.join(directory,`${mode}-${fault==='ordinary'?'exact-resume':'restoration-failure-after-hook'}-workspace`)
      fs.mkdirSync(workspace,{recursive:true})
      const child=path.join(directory,'native-child'),wrapper=path.join(directory,'wrapper.py'),root=randomUUID(),anchor=randomUUID()
      fs.writeFileSync(child,'#!/usr/bin/python3\nimport sys,json\nprint(json.dumps(sys.argv[1:]))\n',{mode:0o700});fs.chmodSync(child,0o700)
      fs.writeFileSync(wrapper,nativeSdkResumeForkWrapper
        .replaceAll('/opt/freshell-claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude.native',child)
        .replace('73975167f0108693cf6fd6614994781657ebb8456ebef5d247458734abfb3916',createHash('sha256').update(fs.readFileSync(child)).digest('hex')))
      fs.writeFileSync(path.join(workspace,'native-restoration-fault-control.json'),JSON.stringify({
        root:fault==='wrong-root'?randomUUID():root,missingAnchor:fault==='invalid-anchor'?'invalid-anchor':anchor,
        seedBytes:42,seedSha256:'a'.repeat(64),identity:['9','42'],
      }))
      const argv=[...(form==='sdk-inline'?['--resume='+root]:['--resume',root]),'--model','selected-model',
        ...(fault==='existing-anchor'?['--resume-session-at='+randomUUID()]:[])]
      const env={...process.env};delete env.FRESHELL_NATIVE_IDENTITY_LAUNCH
      if(fault!=='missing-launch')env.FRESHELL_NATIVE_IDENTITY_LAUNCH=JSON.stringify({
        launchNonce:'current-nonce',incarnationId:'current-incarnation',requestedNativeSessionId:root,
      })
      try {
        const run=()=>execFileSync('python3',[wrapper,...argv],{cwd:workspace,env,encoding:'utf8',stdio:['pipe','pipe','pipe']})
        if(fault==='valid')expect(JSON.parse(run())).toEqual([...argv,'--resume-session-at='+anchor])
        else if(fault==='ordinary')expect(JSON.parse(run())).toEqual(argv)
        else expect(run).toThrow()
      } finally {fs.rmSync(directory,{recursive:true,force:true})}
    })
  it.each(['default-home','selected-config','foreign-store','changed-file'])('executes native fork observation against the actual selected owned store (%s)', (fault) => {
    const home='/owned-provider',config=fault==='selected-config'?'/selected-native-config':home+'/.claude'
    const original=Buffer.from('owned completed history\n'),originalFile=config+'/projects/fixture/original-root.jsonl'
    const mocked = `const writes=[];let stats=0;const selectedBytes=Buffer.from('controlled native executable');const originalBytes=Buffer.from(${JSON.stringify(original.toString('base64'))},'base64');
const fs={readdirSync:()=>['71'],readFileSync:(file)=>{if(file.endsWith('native-fork-fault-control.json'))return JSON.stringify({root:'original-root',seedBytes:originalBytes.length});if(file.endsWith('/claude.exe')||file==='/proc/71/exe')return selectedBytes;if(file==='/proc/71/cmdline')return Buffer.from('native-child\\0--resume\\0original-root\\0--fork-session\\0');if(file===${JSON.stringify(originalFile)})return originalBytes;throw new Error('unowned read '+file)},lstatSync:()=>({isFile:()=>true,isSymbolicLink:()=>false}),statSync:()=>({dev:9,ino:++stats===2&&${JSON.stringify(fault)}==='changed-file'?43:42}),writeFileSync:(file,body)=>writes.push({file,body:JSON.parse(body)})};`
    const script=terminalForkFaultHook.replace("import fs from 'node:fs'",mocked)+"\nprocess.stdout.write(JSON.stringify(writes)+'\\n')"
    const env={...process.env,HOME:home,FRESHELL_NATIVE_IDENTITY_LAUNCH:JSON.stringify({requestedNativeSessionId:'original-root',incarnationId:'current',launchNonce:'nonce'})}
    delete (env as NodeJS.ProcessEnv).CLAUDE_CONFIG_DIR
    if(fault==='selected-config')(env as NodeJS.ProcessEnv).CLAUDE_CONFIG_DIR=config
    const input=JSON.stringify({source:'fork',session_id:'fork-root',cwd:process.cwd(),transcript_path:(fault==='foreign-store'?'/foreign-native-store':config+'/projects/fixture')+'/fork-root.jsonl'})
    const run=()=>execFileSync(process.execPath,['--input-type=module','-e',script],{input,env,encoding:'utf8',stdio:['pipe','pipe','pipe']})
    if(fault==='foreign-store'||fault==='changed-file')expect(run).toThrow(fault==='foreign-store'?'unowned original fork store refused':'native original fork store changed during capture')
    else {
      const writes=JSON.parse(run().trim().split('\n').at(-1)!)
      expect(writes).toHaveLength(1);expect(writes[0].body.originalPrefixSha256).toBe(createHash('sha256').update(original).digest('hex'))
      expect(writes[0].body.identity).toEqual(['9','42'])
    }
  })
  it.each(['startup', 'wrong-requested-root', 'foreign-workspace', 'same-native-root'])('requires an actual owned different native root before recording a fork (%s)', (fault) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-fork-hook-'))
    const hookPath = path.join(directory, 'fork.mjs')
    fs.writeFileSync(hookPath, terminalForkFaultHook)
    fs.writeFileSync(path.join(directory, 'native-fork-fault-control.json'), JSON.stringify({root:'original-root'}))
    const launch = {requestedNativeSessionId:fault === 'wrong-requested-root'?'other-requested-root':'original-root'}
    const input = JSON.stringify({source:fault === 'startup'?'startup':'fork', session_id:fault === 'same-native-root'?'original-root':'actual-fork-root', cwd:fault === 'foreign-workspace'?directory+'-other':directory})
    try {
      const run = () => execFileSync(process.execPath,[hookPath],{cwd:directory,input,encoding:'utf8',
        env:{...process.env,FRESHELL_NATIVE_IDENTITY_LAUNCH:JSON.stringify(launch)},stdio:['pipe','pipe','pipe']})
      if(fault === 'startup')expect(JSON.parse(run())).toEqual({})
      else expect(run).toThrow(fault === 'same-native-root'?'actual native fork root missing':'owned native fork binding mismatch')
      expect(fs.existsSync(path.join(directory,'native-fork-fault-observation.json'))).toBe(false)
    } finally {fs.rmSync(directory,{recursive:true,force:true})}
  })

  it.each(['startup', 'foreign-root', 'foreign-workspace'])('keeps native history unchanged before an owned restoration fault is bound (%s)', (fault) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-restoration-hook-'))
    const hookPath = path.join(directory, 'fault.mjs'), transcript = path.join(directory, 'owned.jsonl')
    fs.writeFileSync(hookPath, terminalRestorationFaultHook)
    fs.writeFileSync(transcript, 'owned history retained\n')
    fs.writeFileSync(path.join(directory, 'native-restoration-fault-control.json'), JSON.stringify({root:'owned-root'}))
    const launch = {requestedNativeSessionId:'owned-root'}
    const input = JSON.stringify({source:fault === 'startup'?'startup':'resume', session_id:fault === 'foreign-root'?'other-root':'owned-root', cwd:fault === 'foreign-workspace'?directory+'-other':directory, transcript_path:transcript})
    try {
      const run = () => execFileSync(process.execPath, [hookPath], {cwd:directory,input,encoding:'utf8',
        env:{...process.env,FRESHELL_NATIVE_IDENTITY_LAUNCH:JSON.stringify(launch)},stdio:['pipe','pipe','pipe']})
      if(fault === 'startup') expect(JSON.parse(run())).toEqual({})
      else expect(run).toThrow('owned native resume binding mismatch')
      expect(fs.readFileSync(transcript, 'utf8')).toBe('owned history retained\n')
      expect(fs.existsSync(path.join(directory, 'native-restoration-fault-observation.json'))).toBe(false)
    } finally {fs.rmSync(directory,{recursive:true,force:true})}
  })

  it.each(['fork-root','restoration-failure-after-hook'])('requires the owned real managed controller before the native %s fault can seed', async (caseId) => {
    await expect(executeManagedNativeCase({} as RuntimeHarness, [], {provider: 'claude', case: 'startup'}, caseId))
      .rejects.toThrow('actual terminal recovery requires the owned real server artifact')
  })

  it.each(['valid','changed-prefix','changed-inode','symlink','present-anchor','wrong-native-anchor','stale-hook','foreign-store'])(
    'observes only genuine current SDK hook and original owned missing-anchor history (%s)',fault=>{
      const root=randomUUID(),anchor=randomUUID(),messageId=fault==='present-anchor'?anchor:randomUUID()
      const launch={requestedNativeSessionId:root,incarnationId:'current-incarnation',launchNonce:'current-nonce'}
      const raw=Buffer.from(JSON.stringify({type:'assistant',sessionId:root,uuid:messageId,message:{id:'native-message',stop_reason:'end_turn',content:[{type:'text',text:'fixture reply'}]}})+'\n')
      const control={root,missingAnchor:anchor,seedBytes:raw.length,seedSha256:createHash('sha256').update(raw).digest('hex'),identity:['9','42']}
      const transcript=(fault==='foreign-store'?'/foreign': '/owned-provider/.claude/projects/project')+'/'+root+'.jsonl'
      const native={source:'resume',session_id:root,cwd:process.cwd(),transcript_path:transcript}
      const mocked=`let stats=0;const spawns=[],raw=Buffer.from(${JSON.stringify(raw.toString('base64'))},'base64');const fs={
existsSync:()=>true,readdirSync:()=>['71'],lstatSync:()=>({isFile:()=>true,isSymbolicLink:()=>${fault==='symlink'}}),
statSync:()=>({dev:9,ino:++stats===2&&${fault==='changed-inode'}?43:42}),
readFileSync:file=>{if(file.endsWith('native-restoration-fault-control.json'))return ${JSON.stringify(JSON.stringify(control))};
if(file.endsWith('session-start.json'))return ${JSON.stringify(JSON.stringify({native,launch:fault==='stale-hook'?{...launch,launchNonce:'old-nonce'}:launch}))};
if(file.endsWith('/cmdline'))return Buffer.from('native-child\\0--resume=${root}\\0--resume-session-at=${fault==='wrong-native-anchor'?randomUUID():anchor}\\0');
if(file.endsWith('/claude.native')||file.endsWith('/exe'))return Buffer.from('controlled executable');
if(file===${JSON.stringify(transcript)})return ${fault==='changed-prefix'?'Buffer.from("changed\\n")':'raw'};
throw new Error('unexpected bounded read '+file)},writeFileSync:()=>{throw new Error('hook must not write native transcript')}};
const spawn=(_file,args)=>{spawns.push(JSON.parse(args[2]));return{unref(){}}};`
      const script=sdkRestorationFaultHook.replace("import fs from 'node:fs'",mocked)
        .replace("import {spawn} from 'node:child_process'",'')+"\nprocess.stdout.write(JSON.stringify(spawns)+'\\n')"
      const run=()=>execFileSync(process.execPath,['--input-type=module','-e',script],{input:JSON.stringify(native),
        env:{...process.env,HOME:'/owned-provider',CLAUDE_CONFIG_DIR:'/owned-provider/.claude',FRESHELL_NATIVE_IDENTITY_LAUNCH:JSON.stringify(launch),FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR:'/current-signal'},encoding:'utf8',stdio:['pipe','pipe','pipe']})
      if(fault==='valid') {
        const configs=JSON.parse(run().trim().split('\n').at(-1)!)
        expect(configs).toHaveLength(1);expect(configs[0].missingAnchor).toBe(anchor)
        expect(configs[0].originalPrefixSha256).toBe(control.seedSha256)
        expect(configs[0].identity).toEqual(control.identity);expect(configs[0].hook.launch).toEqual(launch)
      } else expect(run).toThrow()
    })
  it.each(['exited','still-alive'])('records SDK restoration refusal only after the actual captured native process exits (%s)',state=>{
    const config={nativePid:71,observationPath:'/owned-observation',hook:{launch:{launchNonce:'current'}},missingAnchor:randomUUID()}
    const mocked=`const writes=[];let tick=0;Date.now=()=>tick++*3000;const fs={existsSync:()=>${state==='still-alive'},
writeFileSync:(file,bytes)=>writes.push({file,observation:JSON.parse(bytes)})};`
    const script=sdkRestorationFaultHook.replace("import fs from 'node:fs'",mocked)
      .replaceAll('process.argv[2]',JSON.stringify('--observe')).replaceAll('process.argv[3]',JSON.stringify(JSON.stringify(config)))
      +"\nprocess.stdout.write(JSON.stringify(writes)+'\\n')"
    const writes=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'}).trim())
    if(state==='still-alive')expect(writes).toEqual([])
    else {expect(writes).toHaveLength(1);expect(writes[0]).toEqual({file:config.observationPath,observation:{...config,nativeExited:true}})}
  })

  it.each(['valid', 'current-nonce', 'current-incarnation', 'wrong-root', 'wrong-loaded-root', 'missing-loaded', 'wrong-active-launch', 'hooks-enabled', 'missing-prior-nonce'])('requires the actual old/current native signal binding for the stale fault (%s)', (fault) => {
    const prior = { launchNonce: 'old-launch', incarnationId: 'old-incarnation' }
    const current = { launchNonce: 'current-launch', incarnationId: 'current-incarnation' }
    const captured: any = { hooksDisabled: true, nativeLaunch: { ...current },
      hook: { native: { session_id: 'owned-root' }, launch: { ...prior } },
      loaded: { native: { session_id: 'owned-root' }, launch: { ...prior } } }
    if (fault === 'current-nonce') current.launchNonce = prior.launchNonce
    if (fault === 'current-incarnation') current.incarnationId = prior.incarnationId
    if (fault === 'wrong-root') captured.hook.native.session_id = 'other-root'
    if (fault === 'wrong-loaded-root') captured.loaded.native.session_id = 'other-root'
    if (fault === 'missing-loaded') captured.loaded = null
    if (fault === 'wrong-active-launch') captured.nativeLaunch = prior
    if (fault === 'hooks-enabled') captured.hooksDisabled = false
    if (fault === 'missing-prior-nonce') prior.launchNonce = ''
    expect(staleNativeSignalBindingMatches(captured, prior, current, 'owned-root')).toBe(fault === 'valid')
  })

  it('makes only the owned current signal directory unwritable through the actual ordinary startup hook', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-terminal-unwritable-'))
    const source = path.join(directory, 'preferences.json'); fs.writeFileSync(source, '{}')
    const signal = path.join(directory, 'current-signal')
    const sibling = path.join(directory, 'unrelated-signal'); fs.mkdirSync(sibling); fs.writeFileSync(path.join(sibling, 'retained'), 'unchanged')
    let home = ''
    const launch = vi.fn(async (_supervisor: unknown, request: any) => {
      const selected = request.params.terminal.providerLaunchContext.config.find((file: any) => file.providerRelativePath === '.claude/settings.json')
      const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', selected.relativePath), 'utf8'))
      expect(settings.disableAllHooks).not.toBe(true)
      const command = settings.hooks.SessionStart[0].hooks[0].command
      execFileSync('/bin/sh', ['-c', command], { env: { ...process.env, FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR: signal } })
      expect(fs.statSync(signal).mode & 0o222).toBe(0)
      expect(fs.readFileSync(path.join(sibling, 'retained'), 'utf8')).toBe('unchanged')
      throw new Error('controlled unwritable native launch boundary')
    })
    const harness = { testRoot: directory, evidenceDir: directory, startSupervisor: async (options: any) => { home = options.env.HOME; return {} },
      writeArtifact: () => '', adminRaw: launch, adminOk: launch } as unknown as RuntimeHarness
    const sources = ['grants/env_file', 'grants/ca_file', 'profile/native-startup-user.json'].map((name) => ({
      name: 'claude/' + name, path: source, sha256: 'e'.repeat(64) }))
    try {
      await expect(executeManagedNativeCase(harness, sources, { provider: 'claude', case: 'startup' }, 'unwritable-signal'))
        .rejects.toThrow('controlled unwritable native launch boundary')
      expect(launch).toHaveBeenCalledOnce()
    } finally { if (fs.existsSync(signal)) fs.chmodSync(signal, 0o700); fs.rmSync(directory, { recursive: true, force: true }) }
  })

  it('submits terminal Claude paste and Enter separately before qualifying the completed native seed', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-claude-native-input-'))
    const source = path.join(directory, 'preferences.json'); fs.writeFileSync(source, '{}')
    const binary = path.join(directory, 'owned-controller'); fs.writeFileSync(binary, 'fixture-only controller artifact')
    const socketPath = path.join(directory, 'mcp.sock')
    const controller = createServer((socket) => {
      const chunks: Buffer[] = []
      socket.on('data', (chunk) => chunks.push(chunk))
      socket.on('end', () => {
        const request = JSON.parse(Buffer.concat(chunks).toString())
        expect(request.action).toBe('issue'); expect(request.provider).toBe('claude')
        socket.end(JSON.stringify({ context: { mcpCapability: { grantId: 'owned-fixture-grant' } },
          secretReferences: [{ sourcePath: source, profile: 'claude_onecli_environment' }] }))
      })
    })
    await new Promise<void>((resolve) => controller.listen(socketPath, resolve))
    const start = vi.spyOn(RustServer.prototype, 'start').mockResolvedValue({ pid: undefined } as any)
    const evidence = vi.spyOn(RustServer.prototype, 'processEvidence').mockReturnValue({} as any)
    let request: any
    let submitted = 0
    let pasted = false
    let replacement = false
    let now = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now += 25_000)
    const gestures: string[] = []
    const view = () => ({ containerId: 'owned-container', incarnationId: replacement ? 'new-incarnation' : 'old-incarnation',
      nativeSessionId: request.params.nativeSessionId, recoveryState: 'live',
      nativeIdentityObservation: { source: 'claude_native_event', nativeSessionId: request.params.nativeSessionId,
        incarnationId: replacement ? 'new-incarnation' : 'old-incarnation' } })
    const harness = { testRoot: directory, writeArtifact: () => '',
      startSupervisor: async () => ({ controlSocket: path.join(directory, 'supervisor.sock'), controlSecret: 'owned-fixture-secret' }),
      terminalInputBody: (_soul: string, data: string) => ({ method: 'terminal_input', params: { data } }),
      terminalReadOutputBody: () => ({ method: 'terminal_read_output' }),
      probeRecoveryBody: () => ({ method: 'probe_recovery' }), recoverBody: () => ({ method: 'recover' }),
      killOwnedRuntimeExact: async () => { expect(submitted).toBe(1) }, waitForContainerExit: async () => {},
      adminOk: async (_supervisor: unknown, body: any) => {
        if (body.method === 'launch') { request = body; return { data: { view: view() } } }
        if (body.method === 'terminal_input') {
          gestures.push(body.params.data)
          if (body.params.data.startsWith('\x1b[200~') && body.params.data.endsWith('\x1b[201~')) pasted = true
          else if (body.params.data === '\r' && pasted) submitted++
        }
        if (body.method === 'recover') { replacement = true; return { data: { outcome: 'replaced', view: view() } } }
        return { data: { kind: 'reattach_ready' } }
      },
      execOwnedContainerAsExact: async (_container: string, _uid: string, args: string[]) => JSON.stringify(args.at(-1) !== 'terminal' ? { processes: [] } : {
        uid: 65534, gid: 0, caps: '0000000000000000', readOnlyRoot: true, httpsStatus: 200, tlsVerifyMode: 2,
        tlsCheckHostname: true, version: '2.1.263', executableSha256: 'f'.repeat(64), profileFiles: [], nativePreferences: {},
        completedTurns: submitted, toolEvents: 0, transcript: submitted ? { sha256: 'e'.repeat(64), identity: [1, 2], completeEof: true } : null,
        hook: { launch: { launchNonce: replacement ? 'new-nonce' : 'old-nonce', incarnationId: view().incarnationId },
          native: { source: replacement ? 'resume' : 'startup', session_id: request.params.nativeSessionId } },
        loaded: { launch: { launchNonce: replacement ? 'new-nonce' : 'old-nonce', incarnationId: view().incarnationId },
          native: { version: '2.1.263', session_id: request.params.nativeSessionId,
            model: { id: 'claude-haiku-4-5-20251001' }, workspace: { current_dir: request.params.terminal.cwd } } },
      }),
    } as unknown as RuntimeHarness
    const sources = ['grants/env_file', 'grants/ca_file', 'profile/native-startup-user.json'].map((name) => ({ name: 'claude/' + name, path: source, sha256: 'e'.repeat(64) }))
    try {
      const result = await executeManagedNativeCase(harness, sources, { provider: 'claude', case: 'startup' }, 'exact-resume', binary)
      expect(result.assertions.every((assertion) => assertion.pass)).toBe(true)
      expect(submitted).toBe(1)
      expect(gestures).toHaveLength(2)
      expect(gestures[1]).toBe('\r')
    } finally {
      clock.mockRestore(); evidence.mockRestore(); start.mockRestore()
      await new Promise<void>((resolve, reject) => controller.close((error) => error ? reject(error) : resolve()))
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
  it('requires the actual owned controller artifact before terminal exact-resume can start a seed', async () => {
    const launch = vi.fn()
    const harness = { startSupervisor: launch } as unknown as RuntimeHarness
    await expect(executeManagedNativeCase(harness, [], { provider: 'claude', case: 'startup' }, 'exact-resume'))
      .rejects.toThrow('actual terminal recovery requires the owned real server artifact')
    expect(launch).not.toHaveBeenCalled()
  })
  it.each(['create', 'wrong-root', 'disabled-hooks', 'trust-refusal', 'timeout', 'provider-exit', 'stop-cancellation', 'stale-shared-signal'])('sends terminal Claude %s through its real launch route with the selected profile', async (caseId) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-terminal-claude-route-'))
    let home: string
    const launch = vi.fn(async (_supervisor: unknown, request: any) => {
      expect(request.params.terminal.providerBootstrapFiles).toBeUndefined()
      const selected = request.params.terminal.providerLaunchContext.config.find((file: any) => file.providerRelativePath === '.claude/.claude.json')
      expect(selected.root).toBe('user_provider')
      const preferences = JSON.parse(fs.readFileSync(path.join(home, '.claude', selected.relativePath), 'utf8'))
      expect(preferences.projects[request.params.terminal.cwd].hasTrustDialogAccepted).toBe(caseId !== 'trust-refusal')
      throw new Error('controlled terminal launch boundary')
    })
    const harness = { testRoot: directory, evidenceDir: directory, startSupervisor: async (options: any) => { home = options.env.HOME; return {} },
      writeArtifact: () => '', adminOk: launch, adminRaw: launch } as unknown as RuntimeHarness
    const sources = ['grants/env_file', 'grants/ca_file', 'profile/native-startup-user.json'].map((name) => ({
      name: 'claude/' + name, path: path.join(directory, path.basename(name)), sha256: 'e'.repeat(64) }))
    fs.writeFileSync(sources[2]!.path, JSON.stringify({ theme: 'dark', hasCompletedOnboarding: true,
      projects: { [path.join(directory, `claude-${caseId}-workspace`)]: { hasTrustDialogAccepted: true },
        [path.join(directory, 'claude-create-workspace')]: { hasTrustDialogAccepted: true } } }))
    try {
      await expect(executeManagedNativeCase(harness, sources, { provider: 'claude', case: 'startup' }, caseId))
        .rejects.toThrow('controlled terminal launch boundary')
      expect(launch).toHaveBeenCalledOnce()
      const request = (launch.mock.calls[0] as any)[1]
      expect(request.params.provider).toBe('claude')
      expect(request.params.terminal.mode).toBe('claude')
      expect(request.params.terminal.resumeSessionId).toBeUndefined()
      const actualRoot = request.params.terminal.args[request.params.terminal.args.indexOf('--session-id') + 1]
      if (caseId === 'wrong-root') expect(actualRoot).not.toBe(request.params.nativeSessionId)
      else expect(actualRoot).toBe(request.params.nativeSessionId)
      expect(request.params.fixture).toBeUndefined()
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(['valid', 'wrong-owner', 'wrong-candidate', 'wrong-image', 'failed-create', 'wrong-observation', 'wrong-nonce', 'wrong-signal-digest'])(
    'uses only this campaign’s completed native create for the stale-signal fault (%s)', async (fault) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-stale-campaign-'))
      const source = path.join(directory, 'preferences.json'); fs.writeFileSync(source, '{}')
      fs.mkdirSync(path.join(directory, 'claude-create-workspace'))
      const nativeRoot = randomUUID()
      const launchBinding = { incarnationId: 'prior-incarnation', launchNonce: 'prior-nonce' }
      const records: Record<string, unknown> = {
        'claude-create-original.json': { ownerId: fault === 'wrong-owner' ? 'foreign-owner' : ownerId,
          candidateSha: fault === 'wrong-candidate' ? 'f'.repeat(40) : candidateSha, imageDigest: fault === 'wrong-image' ? 'sha256:' + 'f'.repeat(64) : imageDigest,
          assertions: [{ name: 'actual-terminal-current-native-post-load-observation-before-input', pass: fault !== 'failed-create' }] },
        'claude-create-current-view.json': { containerId: 'prior-owned-container', incarnationId: 'prior-incarnation',
          launchState: 'running', recoveryState: 'live', nativeSessionId: nativeRoot,
          nativeIdentityObservation: { source: 'claude_native_event', nativeSessionId: fault === 'wrong-observation' ? randomUUID() : nativeRoot,
            ...launchBinding, launchNonce: fault === 'wrong-nonce' ? 'foreign-nonce' : launchBinding.launchNonce } },
        'claude-create-signal-native-private.json': { processes: [{ launch: launchBinding,
          signals: ['session-start.json', 'statusline-loaded.json'].map((name) => {
            const bytes = Buffer.from(JSON.stringify({ launch: launchBinding, native: { session_id: nativeRoot } }))
            return { name, bytesBase64: bytes.toString('base64'), sha256: fault === 'wrong-signal-digest' ? 'f'.repeat(64) : createHash('sha256').update(bytes).digest('hex') }
          }) }] },
      }
      for (const [name, value] of Object.entries(records)) fs.writeFileSync(path.join(directory, name), JSON.stringify(value))
      const kill = vi.fn(), wait = vi.fn(async () => {}), start = vi.fn(async () => { throw new Error('controlled stale launch boundary') })
      const harness = { testRoot: directory, evidenceDir: directory, runId: ownerId, candidateSha, imageRef: imageDigest,
        killOwnedRuntimeExact: kill, waitForContainerExit: wait, startSupervisor: start } as unknown as RuntimeHarness
      const sources = ['grants/env_file', 'grants/ca_file', 'profile/native-startup-user.json']
        .map((name) => ({ name: 'claude/' + name, path: source, sha256: 'e'.repeat(64) }))
      try {
        await expect(executeManagedNativeCase(harness, sources, { provider: 'claude', case: 'startup' }, 'stale-shared-signal'))
          .rejects.toThrow(fault === 'valid' ? 'controlled stale launch boundary' : 'current owned native create evidence')
        if (fault === 'valid') {
          expect(kill).toHaveBeenCalledExactlyOnceWith('prior-owned-container')
          expect(wait).toHaveBeenCalledExactlyOnceWith('prior-owned-container')
          expect(start).toHaveBeenCalledOnce()
        } else { expect(kill).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled() }
        expect(JSON.parse(fs.readFileSync(path.join(directory, 'claude-create-original.json'), 'utf8'))).toEqual(records['claude-create-original.json'])
      } finally { fs.rmSync(directory, { recursive: true, force: true }) }
    },
  )
  it('captures current provider-owned terminal signals before a startup refusal tears down the enclosure', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-terminal-signal-failure-'))
    const source = path.join(directory, 'preferences.json')
    fs.writeFileSync(source, '{}')
    const records = new Map<string, unknown>()
    const capture = vi.fn(async (_container: string, uid: string) => {
      expect(uid).toBe('65534:0')
      return JSON.stringify({ processes: [{ pid: 7, signals: [] }] })
    })
    let now = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now += 60_000)
    const harness = { testRoot: directory, startSupervisor: async () => ({}),
      writeArtifact: (name: string, value: unknown) => records.set(name, value),
      adminOk: async (_supervisor: unknown, request: any) => {
        if (request.method === 'launch') return { data: { view: { containerId: 'owned-native-container', recoveryState: 'live' } } }
        if (request.method === 'inventory') return { data: [] }
        return { data: {} }
      }, execOwnedContainerAsExact: capture,
    } as unknown as RuntimeHarness
    const sources = ['grants/env_file', 'grants/ca_file', 'profile/native-startup-user.json'].map((name) => ({ name: 'claude/' + name, path: source, sha256: 'e'.repeat(64) }))
    try {
      await expect(executeManagedNativeCase(harness, sources, { provider: 'claude', case: 'startup' }, 'create'))
        .rejects.toThrow('terminal Claude current post-load observation missing')
      expect(capture).toHaveBeenCalledOnce()
      expect(capture.mock.calls[0]?.[0]).toBe('owned-native-container')
      expect(records.get('claude-create-signal-native-private.json')).toEqual({ processes: [{ pid: 7, signals: [] }] })
    } finally { clock.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(['provider-exit', 'stop-cancellation', 'provider-exit-not-exited', 'stop-cancellation-not-empty'])(
    'uses the owned native PID or ordinary Stop before initial publication (%s)', async (fault) => {
      const caseId = fault.startsWith('provider-exit') ? 'provider-exit' : 'stop-cancellation'
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-terminal-startup-fault-'))
      const source = path.join(directory, 'preferences.json'); fs.writeFileSync(source, '{}')
      let request: any
      let reply: (value: any) => void
      let now = 0
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now += 250)
      const view = () => ({ soulId: request.params.soulId, containerId: 'owned-container', incarnationId: 'owned-incarnation',
        launchState: caseId === 'provider-exit' ? 'starting' : 'stopped',
        desiredState: caseId === 'provider-exit' ? 'running' : 'stopped',
        recoveryState: caseId === 'provider-exit' ? 'live' : 'stopped', nativeIdentityObservation: null })
      const kill = vi.fn((_container: string, _pid: number, _signal: string) => reply({ result: { Err: { code: 'RECOVERY_BLOCKED' } } }))
      const methods: string[] = []
      const harness = { testRoot: directory, startSupervisor: async () => ({}), writeArtifact: () => '',
        broker: { receipts: () => [{ soulId: request.params.soulId, containerId: 'owned-container' }] },
        inventoryBody: () => ({ method: 'inventory' }), stopBody: () => ({ method: 'stop' }),
        terminalInputBody: () => ({ method: 'terminal_input' }), killOwnedRuntimePidExact: kill,
        adminRaw: async (_supervisor: unknown, body: any) => {
          methods.push(body.method)
          if (body.method === 'launch') { request = body; return new Promise((resolve) => { reply = resolve }) }
          return { result: { Err: { code: 'UNKNOWN_SOUL' } } }
        },
        adminOk: async (_supervisor: unknown, body: any) => {
          methods.push(body.method)
          if (body.method === 'stop') {
            reply({ result: { Err: { code: 'STALE_INTENT_REVISION' } } })
            return { data: { outcome: fault.endsWith('not-empty') ? 'termination_unconfirmed' : 'verified_empty' } }
          }
          return { data: [view()] }
        },
        execOwnedContainerAsExact: async (_container: string, uid: string, args: string[]) => {
          expect(uid).toBe('65534:0')
          if (!args.includes('terminal')) return JSON.stringify({ nativeExited: !fault.endsWith('not-exited') })
          return JSON.stringify({ uid: 65534, gid: 0, caps: '0000000000000000', readOnlyRoot: true,
            httpsStatus: 200, tlsVerifyMode: 2, tlsCheckHostname: true, version: '2.1.263', nativePid: 21,
            nativeArgv: request.params.terminal.args, nativeCwd: request.params.terminal.cwd, hooksDisabled: true,
            hook: null, loaded: null, nativeRoot: null, completedTurns: 0, toolEvents: 0, transcript: null, profileFiles: [] })
        },
      } as unknown as RuntimeHarness
      const sources = ['grants/env_file', 'grants/ca_file', 'profile/native-startup-user.json']
        .map((name) => ({ name: 'claude/' + name, path: source, sha256: 'e'.repeat(64) }))
      try {
        const result = executeManagedNativeCase(harness, sources, { provider: 'claude', case: 'startup' }, caseId)
        if (fault.includes('not-')) await expect(result).rejects.toThrow('did not close its process or Stop transaction')
        else expect((await result).assertions.every((assertion) => assertion.pass)).toBe(true)
        if (caseId === 'provider-exit') expect(kill).toHaveBeenCalledWith('owned-container', 21, 'TERM')
        else { expect(methods).toContain('stop'); expect(kill).not.toHaveBeenCalled() }
        expect(methods).toContain('terminal_input')
      } finally { clock.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }) }
    },
  )
  it.each(['create', 'wrong-root', 'wrong-root-admitted', 'wrong-root-published', 'wrong-root-late-published',
    'disabled-hooks', 'disabled-hooks-admitted', 'disabled-hooks-published',
    'trust-refusal', 'trust-refusal-no-prompt', 'trust-refusal-admitted', 'trust-refusal-published',
    'unwritable-signal', 'unwritable-signal-writable', 'unwritable-signal-admitted', 'unwritable-signal-published',
    'timeout', 'timeout-too-fast', 'timeout-admitted', 'timeout-published'])('refreshes the current host and protects the terminal %s verdict', async (fault) => {
    const caseId = fault === 'create' ? 'create' : fault.startsWith('disabled-hooks') ? 'disabled-hooks'
      : fault.startsWith('trust-refusal') ? 'trust-refusal' : fault.startsWith('unwritable-signal') ? 'unwritable-signal'
        : fault.startsWith('timeout') ? 'timeout' : 'wrong-root'
    const noCallbacks = ['disabled-hooks', 'trust-refusal', 'unwritable-signal', 'timeout'].includes(caseId)
    const reason = caseId === 'disabled-hooks' ? 'disabled native hooks' : caseId === 'trust-refusal' ? 'unaccepted native trust'
      : caseId === 'unwritable-signal' ? 'unwritable current native signal directory'
        : caseId === 'timeout' ? 'native startup timeout' : 'wrong current native root'
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-terminal-observation-refresh-'))
    const source = path.join(directory, 'preferences.json'); fs.writeFileSync(source, '{}')
    let request: any
    let refreshed = false
    let now = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now += fault === 'timeout-too-fast' ? 1_000 : 25_000)
    const view = () => ({ soulId: request.params.soulId, containerId: 'owned-container', incarnationId: 'owned-incarnation',
      launchState: caseId === 'create' || fault.includes('published') ? 'running' : 'starting',
      recoveryState: 'live', nativeSessionId: request.params.nativeSessionId,
      nativeIdentityObservation: refreshed && caseId === 'create' ? { nativeSessionId: request.params.nativeSessionId,
        incarnationId: 'owned-incarnation', source: 'claude_native_event' } : undefined })
    const harness = { testRoot: directory, startSupervisor: async () => ({}), writeArtifact: () => '',
      inventoryBody: () => ({ method: 'inventory' }), terminalReadOutputBody: () => ({ method: 'terminal_read_output' }),
      probeRecoveryBody: () => ({ method: 'probe_recovery' }),
      terminalInputBody: () => ({ method: 'terminal_input' }),
      adminRaw: async (_supervisor: unknown, body: any) => {
        if (body.method === 'launch') {
          request = body
          return { result: fault.endsWith('-published') && !fault.includes('late') ? { Ok: { view: view() } } : { Err: { code: 'RECOVERY_BLOCKED' } } }
        }
        return { result: fault.endsWith('-admitted') ? { Ok: {} } : { Err: { code: fault === 'wrong-root-published' ? 'RECOVERY_BLOCKED' : 'UNKNOWN_SOUL' } } }
      },
      adminOk: async (_supervisor: unknown, body: any) => {
        if (body.method === 'launch') { request = body; return { data: { view: view() } } }
        if (body.method === 'probe_recovery') { refreshed = true; return { data: { kind: 'unknown' } } }
        if (body.method === 'terminal_read_output' && caseId === 'trust-refusal') return { data: { frames: fault === 'trust-refusal-no-prompt' ? [] : [{ data: 'Do you trust this folder?' }] } }
        return { data: body.method === 'inventory' ? [view()] : {} }
      },
      execOwnedContainerAsExact: async (_container: string, _uid: string, args: string[]) => JSON.stringify(args.includes('terminal')
        ? { uid: 65534, gid: 0, caps: '0000000000000000', readOnlyRoot: true, httpsStatus: 200,
          tlsVerifyMode: 2, tlsCheckHostname: true, version: '2.1.263', executableSha256: 'f'.repeat(64), profileFiles: [],
          transcript: null, hooksDisabled: caseId === 'disabled-hooks' || caseId === 'timeout', completedTurns: 0, toolEvents: 0,
          nativePreferences: { workspaceTrust: caseId !== 'trust-refusal' },
          signalWritable: fault === 'unwritable-signal-writable', signalMode: '0o500',
          nativeArgv: request.params.terminal.args, nativeCwd: request.params.terminal.cwd,
          hook: noCallbacks ? null : { launch: {}, native: { session_id: request.params.terminal.args[request.params.terminal.args.indexOf('--session-id') + 1] } },
          loaded: noCallbacks ? null : { launch: {}, native: { version: '2.1.263', session_id: request.params.terminal.args[request.params.terminal.args.indexOf('--session-id') + 1],
            context_window: { total_input_tokens: 0, total_output_tokens: 0 },
            model: { id: 'claude-haiku-4-5-20251001' }, workspace: { current_dir: request.params.terminal.cwd } } } }
        : { processes: [] }),
    } as unknown as RuntimeHarness
    const sources = ['grants/env_file', 'grants/ca_file', 'profile/native-startup-user.json'].map((name) => ({ name: 'claude/' + name, path: source, sha256: 'e'.repeat(64) }))
    try {
      const execution = executeManagedNativeCase(harness, sources, { provider: 'claude', case: 'startup' }, caseId)
      if (fault === 'unwritable-signal-writable') {
        await expect(execution).rejects.toThrow('actual terminal Claude pin/profile/namespace/TLS differs')
        return
      }
      if (fault === 'trust-refusal-no-prompt' || fault === 'timeout-too-fast') {
        await expect(execution).rejects.toThrow(fault === 'trust-refusal-no-prompt' ? 'actual native trust prompt unavailable' : 'native startup timeout did not respect its bounded wait')
        return
      }
      if (fault.includes('published')) {
        await expect(execution).rejects.toThrow(`${reason} published a running launch`)
        return
      }
      if (fault.endsWith('-admitted')) {
        await expect(execution).rejects.toThrow(`${reason} released ordinary input`)
        return
      }
      const original = await execution
      expect(refreshed).toBe(caseId === 'create')
      expect(original.assertions.every((assertion) => assertion.pass)).toBe(true)
    } finally { clock.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(['death', 'published', 'cached', 'redispatch'])('protects the native post-effect observation boundary (%s)', async (fault) => {
    const publishedOutcome = fault === 'published'
    const recover = fault === 'cached' || fault === 'redispatch'
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'native-effect-edge-'))
    const command = `printf 'effect\\n' >> '${path.join(workspace, 'owned-native-effect.jsonl')}'`
    const toolUseID = 'toolu_original1'
    const nativeRoot = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const methods: string[] = []
    let read = false
    const payload = { tool: { name: 'Bash', input: { command } }, toolUseID,
      nativeCheckpoint: { nativeSessionId: nativeRoot, toolUseID }, nativeRequestId: 'current-native-request' }
    const harness = { writeArtifact: () => '',
      freshAgentResolveBody: (_soul: string, decision: string, value: unknown) => ({ method: 'fresh_agent_resolve', params: { decision, value } }),
      probeRecoveryBody: () => ({ method: 'probe_recovery' }),
      recoverBody: () => ({ method: 'recover' }),
      adminOk: async (_supervisor: unknown, body: any) => {
        methods.push(body.method)
        if (body.method === 'fresh_agent_read_events') {
          if (read && recover) return { data: { head: 2, events: fault === 'redispatch' && methods.filter((m) => m === 'fresh_agent_read_events').length > 2
            ? [{ event: { kind: 'provider', data: { payload: { event: { type: 'freshAgent.permission.dispatch', ok: true } } } } }] : [] } }
          if (read) throw new Error('unexpected observation read after parked card')
          read = true
          return { data: { head: 1, events: [{ event: { kind: 'permission_requested', data: { decision_id: 'current-card', payload } } }] } }
        }
        if (body.method === 'fresh_agent_resolve') {
          expect(body.params.decision).toBe('current-card')
          expect(body.params.value).toEqual({ behavior: 'allow', updatedInput: { command } })
          fs.writeFileSync(path.join(workspace, 'owned-native-effect.jsonl'), 'effect\n')
          fs.writeFileSync(path.join(workspace, 'native-after-effect-before-observation.json'), JSON.stringify({
            hook_event_name: 'PostToolUse', session_id: nativeRoot, tool_name: 'Bash', tool_use_id: toolUseID, tool_input: { command } }))
        }
        if (body.method === 'recover') return { data: { outcome: 'replaced', view: {
          incarnationId: 'new-incarnation', containerId: 'replacement-container', nativeSessionId: nativeRoot,
          recoveryState: 'live', nativeIdentityObservation: { nativeSessionId: nativeRoot } } } }
        return { data: { kind: 'reattach_ready' } }
      },
      adminRaw: async () => { methods.push('cached-decision-resolve'); return { result: { Ok: { kind: 'fresh_agent_command', data: { state: 'completed' } } } } },
      waitForFile: async (file: string) => { expect(fs.existsSync(file)).toBe(true) },
      execOwnedContainerAsExact: async (_container: string, uid: string, args: string[]) => {
        const bytes = Buffer.from(JSON.stringify(uid === '0:0' ? { decisions: { 'current-card': { state: 'resolved',
          responseDigest: createHash('sha256').update(JSON.stringify({ behavior: 'allow', updatedInput: { command } })).digest('hex') } } }
          : { phase: 'dispatching', nativeSessionId: nativeRoot, toolUseID }))
        return JSON.stringify({ path: args.at(-1), readerUid: Number(uid.split(':')[0]), bytesBase64: bytes.toString('base64'),
          sha256: createHash('sha256').update(bytes).digest('hex') })
      },
      killOwnedRuntimeExact: async () => { if (!recover) throw new Error('controlled exact native death') },
      waitForContainerExit: async () => {},
    } as unknown as RuntimeHarness
    const rows = [{ type: 'assistant', sessionId: nativeRoot, message: { id: 'msg_original',
      content: [{ type: 'tool_use', id: toolUseID, name: 'Bash', input: { command } }] } },
    { type: 'attachment', sessionId: nativeRoot, attachment: { type: 'hook_deferred_tool', toolUseID } }]
    const bytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
    const nativeBytes = publishedOutcome ? Buffer.concat([bytes, Buffer.from(JSON.stringify({ type: 'user', sessionId: nativeRoot,
      message: { content: [{ type: 'tool_result', tool_use_id: toolUseID, is_error: false }] } }) + '\n')]) : bytes
    try {
      const run = executeManagedNativeApproval({ harness, supervisor: {}, soulId: 'owned-soul', workspace,
        view: { incarnationId: 'old-incarnation', nativeSessionId: nativeRoot, containerId: 'owned-container' }, scenario: 'controlled-effect-edge',
        decision: 'effect-before-observation', inspect: async () => ({ nativeRoot,
          transcript: { bytesBase64: nativeBytes.toString('base64'), sha256: createHash('sha256').update(nativeBytes).digest('hex'), completeEof: true } }) })
      if (fault === 'cached') await expect(run).resolves.toBeDefined()
      else await expect(run).rejects.toThrow(publishedOutcome ? 'post-effect native outcome was already published'
        : fault === 'redispatch' ? 'native decision dispatched again after its effect' : 'controlled exact native death')
      if (recover) {
        expect(methods.filter((m) => m === 'fresh_agent_resolve')).toHaveLength(1)
        expect(methods.filter((m) => m === 'cached-decision-resolve')).toHaveLength(1)
        expect(fs.readFileSync(path.join(workspace, 'owned-native-effect.jsonl'), 'utf8')).toBe('effect\n')
      } else expect(methods).toEqual(['fresh_agent_send', 'fresh_agent_read_events', 'fresh_agent_resolve', ...(publishedOutcome ? [] : ['probe_recovery'])])
    } finally { fs.rmSync(workspace, { recursive: true, force: true }) }
  })
  it.each(['valid','wrong-pin','running','observation','admitted','native-turn'])('executes current native fresh startup refusal checks (%s)', async (fault) => {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'native-fresh-fault-oracle-'))
    let soulId='', launchReply:(value:any)=>void
    const namespace={uid:65534,gid:0,caps:'0000000000000000',readOnlyRoot:true,httpsStatus:200,tlsVerifyMode:2,tlsCheckHostname:true,
      version:fault==='wrong-pin'?'2.1.263':'2.1.237',nativeCwd:'',nativeRoot:null,hook:null,nativePid:37,
      completedTurns:fault==='native-turn'?1:0,toolEvents:0,executableSha256:'c'.repeat(64),profileFiles:[]}
    const harness={testRoot:directory,runId:ownerId,candidateSha,imageRef:imageDigest,startSupervisor:async()=>({}),writeArtifact:()=>'',inventoryBody:()=>({method:'inventory'}),
      broker:{receipts:()=>[{soulId,containerId:'owned-container'}]},
      execOwnedContainerAsExact:async()=>{queueMicrotask(()=>launchReply({result:{Err:{code:'HOST_UNREACHABLE'}}}));return JSON.stringify(namespace)},
      adminRaw:async(_supervisor:unknown,body:any)=>{
        if(body.method==='launch') {soulId=body.params.soulId;namespace.nativeCwd=body.params.freshAgent.cwd;return new Promise(resolve=>{launchReply=resolve})}
        if(body.method!=='fresh_agent_send')throw new Error('unexpected native fault operation')
        return fault==='admitted'?{result:{Ok:{}}}:{result:{Err:{code:'UNKNOWN_SOUL'}}}
      },
      adminOk:async()=>({data:[{soulId,launchState:fault==='running'?'running':'starting',nativeIdentityObservation:fault==='observation'?{}:null}]}),
    } as unknown as RuntimeHarness
    try {
      const run=executeManagedNativeCase(harness,['env_file','ca_file'].map(suffix=>({name:'claude/grants/'+suffix,path:path.join(directory,suffix),sha256:'e'.repeat(64)})),{mode:'freshclaude',case:'startup'},'disabled-hooks')
      if(fault==='valid')expect((await run).assertions.every(assertion=>assertion.pass)).toBe(true)
      else await expect(run).rejects.toThrow(fault==='admitted'?'admitted ordinary input':fault==='running'||fault==='observation'?'published Running or identity':'pin/profile/identity fault differs')
    } finally {fs.rmSync(directory,{recursive:true,force:true})}
  })
  it.each(['verified-empty','unconfirmed','running','wrong-intent'])('requires ordinary native fresh Stop outcome and durable stopped intent (%s)', async (fault) => {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'native-fresh-stop-'))
    let soulId='', launchReply:(value:any)=>void
    const namespace={uid:65534,gid:0,caps:'0000000000000000',readOnlyRoot:true,httpsStatus:200,tlsVerifyMode:2,tlsCheckHostname:true,
      version:'2.1.237',nativeCwd:'',nativeRoot:null,hook:null,nativePid:37,completedTurns:0,toolEvents:0,executableSha256:'c'.repeat(64),profileFiles:[]}
    const harness={testRoot:directory,runId:ownerId,candidateSha,imageRef:imageDigest,startSupervisor:async()=>({}),writeArtifact:()=>'',inventoryBody:()=>({method:'inventory'}),stopBody:()=>({method:'stop'}),
      broker:{receipts:()=>[{soulId,containerId:'owned-container'}]},execOwnedContainerAsExact:async()=>JSON.stringify(namespace),
      adminRaw:async(_supervisor:unknown,body:any)=>{
        if(body.method==='launch'){soulId=body.params.soulId;namespace.nativeCwd=body.params.freshAgent.cwd;return new Promise(resolve=>{launchReply=resolve})}
        if(body.method!=='fresh_agent_send')throw new Error('unexpected native fault operation')
        return {result:{Err:{code:'UNKNOWN_SOUL'}}}
      },
      adminOk:async(_supervisor:unknown,body:any)=>{
        if(body.method==='stop'){launchReply({result:{Err:{code:'STALE_INTENT_REVISION'}}});return {data:{outcome:fault==='unconfirmed'?'termination_unconfirmed':'verified_empty'}}}
        return {data:[{soulId,launchState:fault==='running'?'running':'stopped',desiredState:fault==='wrong-intent'?'running':'stopped',recoveryState:'stopped',nativeIdentityObservation:null}]}
      },
    } as unknown as RuntimeHarness
    try {
      const run=executeManagedNativeCase(harness,['env_file','ca_file'].map(suffix=>({name:'claude/grants/'+suffix,path:path.join(directory,suffix),sha256:'e'.repeat(64)})),{mode:'kilroy',case:'startup'},'stop-cancellation')
      if(fault==='verified-empty')expect((await run).assertions.every(assertion=>assertion.pass)).toBe(true)
      else await expect(run).rejects.toThrow(fault==='running'?'published Running or identity':'empty stopped native fresh runtime')
    } finally {fs.rmSync(directory,{recursive:true,force:true})}
  })
  it.each(['valid','wrong-image','wrong-wrapper','wrong-original','wrong-installed-wrapper','wrong-sdk'])('executes the pinned SDK fault-image admission before native seed (%s)', async (fault) => {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'native-sdk-image-admission-')),file=path.join(directory,'image.json')
    const marker={kind:'owned-sdk-resume-fork-fault-image',imageDigest:fault==='wrong-image'?'sha256:'+'0'.repeat(64):imageDigest,
      wrapperSha256:fault==='wrong-wrapper'?'0'.repeat(64):createHash('sha256').update(nativeSdkResumeForkWrapper).digest('hex'),
      originalExecutableSha256:fault==='wrong-original'?'0'.repeat(64):'73975167f0108693cf6fd6614994781657ebb8456ebef5d247458734abfb3916'}
    fs.writeFileSync(file,JSON.stringify(marker))
    const start=vi.fn(async()=>({containerId:'owned-supervisor'})),launch=vi.fn(async(_supervisor:unknown,request:any)=>{
      expect(request.params.nativeSessionId).toBeUndefined();expect(request.params.freshAgent.nativeSessionId).toBeUndefined()
      throw new Error('controlled legitimate native initial create boundary')
    })
    const inspect=vi.fn(async()=>JSON.stringify({...marker,wrapperSha256:fault==='wrong-installed-wrapper'?'0'.repeat(64):marker.wrapperSha256,sdkVersion:fault==='wrong-sdk'?'0.0.0':'0.3.237'}))
    const harness={testRoot:directory,imageRef:imageDigest,startSupervisor:start,execOwnedContainerExact:inspect,writeArtifact:()=>'',adminOk:launch} as unknown as RuntimeHarness
    try {
      const run=executeManagedNativeCase(harness,[...['env_file','ca_file'].map(suffix=>({name:'claude/grants/'+suffix,path:path.join(directory,suffix),sha256:'e'.repeat(64)})),{name:'claude/native-fault/sdk-resume-fork.json',path:file,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')}],{mode:'freshclaude',case:'startup'},'wrong-id')
      await expect(run).rejects.toThrow(fault==='valid'?'legitimate native initial create boundary':fault.startsWith('wrong-installed')||fault==='wrong-sdk'?'actual SDK native fault image differs before input':'fault image binding differs')
      expect(launch).toHaveBeenCalledTimes(fault==='valid'?1:0)
      expect(start).toHaveBeenCalledTimes(['valid','wrong-installed-wrapper','wrong-sdk'].includes(fault)?1:0)
    } finally {fs.rmSync(directory,{recursive:true,force:true})}
  })
  it.each((['freshclaude','kilroy'] as const).flatMap(mode=>['wrong-id','restoration-failure-after-hook'].map(caseId=>({mode,caseId}))))('requires an owned pinned native fault image before $mode/$caseId can seed', async ({mode,caseId}) => {
    await expect(executeManagedNativeCase({} as RuntimeHarness,[],{mode,case:'startup'},caseId))
      .rejects.toThrow('owned SDK native resume-fork fault image required')
  })
  it.each(['freshclaude', 'kilroy'] as const)('routes %s restoration failure through genuine enabled native hooks before seeding', async (mode) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-native-restoration-route-'))
    const marker={kind:'owned-sdk-resume-fork-fault-image',imageDigest,
      wrapperSha256:createHash('sha256').update(nativeSdkResumeForkWrapper).digest('hex'),
      originalExecutableSha256:'73975167f0108693cf6fd6614994781657ebb8456ebef5d247458734abfb3916'}
    const markerPath=path.join(directory,'image.json');fs.writeFileSync(markerPath,JSON.stringify(marker))
    const launch = vi.fn(async (_supervisor: unknown, request: any) => {
      expect(request.params.nativeSessionId).toBeUndefined()
      expect(request.params.freshAgent.fixtureTransport).toBeUndefined()
      expect(request.params.freshAgent.provider).toBe(mode === 'kilroy' ? 'kilroy' : 'claude')
      const settings = JSON.parse(fs.readFileSync(path.join(request.params.freshAgent.cwd, '.claude/settings.json'), 'utf8'))
      expect(settings.disableAllHooks).not.toBe(true)
      expect(settings.hooks.SessionStart).toHaveLength(1)
      throw new Error('controlled genuine native restoration seed boundary')
    })
    const harness = { testRoot: directory,imageRef:imageDigest, startSupervisor: async () => ({}),
      execOwnedContainerExact:async()=>JSON.stringify({...marker,sdkVersion:'0.3.237'}),writeArtifact: () => '', adminOk: launch } as unknown as RuntimeHarness
    try {
      await expect(executeManagedNativeCase(harness, ['env_file', 'ca_file'].map(suffix => ({
        name: 'claude/grants/' + suffix, path: path.join(directory, suffix), sha256: 'e'.repeat(64),
      })).concat([{name:'claude/native-fault/sdk-resume-fork.json',path:markerPath,sha256:createHash('sha256').update(fs.readFileSync(markerPath)).digest('hex')}]), { mode, case: 'startup' }, 'restoration-failure-after-hook')).rejects.toThrow('genuine native restoration seed boundary')
      expect(launch).toHaveBeenCalledOnce()
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(['freshclaude','kilroy'].flatMap(mode => ['missing-native-id','placeholder-id'].flatMap(caseId =>
    ['valid','valid-zero-revision','wrong-revision-type','wrong-mode','wrong-case','wrong-actual-root','missing-hook','wrong-digest','stale-launch','placeholder-native-uuid','wrong-local-key','filled-profile','started','sdk-only','stale-generation']
      .map(fault => ({ mode: mode as 'freshclaude'|'kilroy', caseId, fault })))))('binds actual normalized native field refusal $mode/$caseId/$fault', ({mode,caseId,fault}) => {
    const launch={incarnationId:'inc-current',launchNonce:'nonce-current',evidenceRevision:3,executionGeneration:4,requestedNativeSessionId:null}
    const frame:any={type:'sdk.session.init',sessionId:'actual-sidecar-local-key',cwd:'/owned/workspace',model:'selected',nativeIdentityEvidence:{launch,digest:'d'.repeat(64),source:'startup',queryGeneration:1}}
    if(caseId==='placeholder-id')frame.cliSessionId=frame.sessionId
    const namespace:any={nativeRoot:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',hook:{launch,native:{session_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',source:'startup',cwd:frame.cwd}},hookSha256:'d'.repeat(64),nativeLaunch:launch}
    const receipt:any={mode,caseId,actualNativeSessionId:namespace.nativeRoot,frame}
    const actor:any=[{event:'host.native_identity.refused',severity:'warn',provider:mode==='kilroy'?'kilroy':'claude',reason:caseId==='missing-native-id'?'missing_cli_session_id':'local_placeholder_id',launch,nativeEvidenceDigest:'d'.repeat(64),nativeEvidenceSource:'startup',queryGeneration:1,normalizedEventType:'freshAgent.session.init',nativeReceiverPublished:false,nativeReceiverContainsIdentity:false}]
    if(fault==='valid-zero-revision')launch.evidenceRevision=0
    if(fault==='wrong-revision-type')(launch as any).evidenceRevision='0'
    if(fault==='wrong-mode')receipt.mode=mode==='kilroy'?'freshclaude':'kilroy'
    if(fault==='wrong-case')receipt.caseId='disabled-hooks'
    if(fault==='wrong-actual-root')receipt.actualNativeSessionId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    if(fault==='missing-hook')namespace.hook=null
    if(fault==='wrong-digest')namespace.hookSha256='e'.repeat(64)
    if(fault==='stale-launch')namespace.nativeLaunch={...launch,launchNonce:'nonce-old'}
    if(fault==='placeholder-native-uuid') {frame.cliSessionId=namespace.nativeRoot}
    if(fault==='wrong-local-key') {frame.cliSessionId='other-local'}
    if(fault==='filled-profile')actor[0].nativeReceiverContainsIdentity=true
    if(fault==='started')actor[0].nativeReceiverPublished=true
    if(fault==='sdk-only')actor[0].normalizedEventType='sdk.session.init'
    if(fault==='stale-generation')frame.nativeIdentityEvidence.queryGeneration=0
    expect(nativeSdkInitFieldFaultMatches(mode,caseId,receipt,namespace,actor)).toBe(fault==='valid'||fault==='valid-zero-revision')
  })
  it.each(['freshclaude','kilroy'].flatMap(mode=>['missing-native-id','placeholder-id'].map(caseId=>({mode:mode as 'freshclaude'|'kilroy',caseId}))))('executes the enabled-hook normalized field refusal route $mode/$caseId', async ({mode,caseId})=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'native-field-route-'))
    const publisher=fs.readFileSync('crates/freshell-claude-sidecar/index.mjs','utf8')
    const marker={kind:'owned-sdk-native-init-field-fault-image',imageDigest,sdkVersion:'0.3.237',originalExecutableSha256:'73975167f0108693cf6fd6614994781657ebb8456ebef5d247458734abfb3916',originalPublisherSha256:createHash('sha256').update(publisher).digest('hex'),patchedPublisherSha256:createHash('sha256').update(stageSdkInitFieldFault(publisher)).digest('hex')}
    const markerFile=path.join(directory,'field-image.json');fs.writeFileSync(markerFile,JSON.stringify(marker))
    let soulId='',finish:(reply:any)=>void
    const launch={incarnationId:'inc-current',launchNonce:'nonce-current',evidenceRevision:3,executionGeneration:4,requestedNativeSessionId:null}
    const namespace:any={uid:65534,gid:0,caps:'0000000000000000',readOnlyRoot:true,httpsStatus:200,tlsVerifyMode:2,tlsCheckHostname:true,
      version:'2.1.237',nativeCwd:'',nativeRoot:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',hookSha256:'d'.repeat(64),nativeLaunch:launch,nativePid:37,completedTurns:0,toolEvents:0,executableSha256:'c'.repeat(64),profileFiles:[]}
    let actor:any
    const harness={testRoot:directory,runId:ownerId,candidateSha,imageRef:imageDigest,startSupervisor:async()=>({containerId:'owned-supervisor'}),writeArtifact:()=>'',inventoryBody:()=>({method:'inventory'}),
      execOwnedContainerExact:async()=>JSON.stringify(marker),broker:{receipts:()=>[{soulId,containerId:'owned-container'}]},
      execOwnedContainerAsExact:async()=>JSON.stringify(namespace),
      containerLogs:()=>{queueMicrotask(()=>finish({result:{Err:{code:'HOST_UNREACHABLE'}}}));return JSON.stringify(actor[0])+'\n'},
      adminRaw:async(_supervisor:unknown,request:any)=>{
        if(request.method==='launch'){
          soulId=request.params.soulId;const cwd=request.params.freshAgent.cwd
          expect(fs.existsSync(path.join(cwd,'.claude/settings.json'))).toBe(false)
          expect(JSON.parse(fs.readFileSync(path.join(cwd,'native-init-field-fault-control.json'),'utf8'))).toEqual({mode,caseId})
          namespace.nativeCwd=cwd;namespace.hook={launch,native:{session_id:namespace.nativeRoot,source:'startup',cwd}}
          const frame:any={type:'sdk.session.init',sessionId:'actual-local-sidecar-key',cwd,model:'selected',nativeIdentityEvidence:{launch,digest:namespace.hookSha256,source:'startup',queryGeneration:1}}
          if(caseId==='placeholder-id')frame.cliSessionId=frame.sessionId
          fs.writeFileSync(path.join(cwd,'native-init-field-fault-observation.json'),JSON.stringify({mode,caseId,actualNativeSessionId:namespace.nativeRoot,frame}))
          actor=[{event:'host.native_identity.refused',severity:'warn',provider:mode==='kilroy'?'kilroy':'claude',reason:caseId==='missing-native-id'?'missing_cli_session_id':'local_placeholder_id',launch,nativeEvidenceDigest:namespace.hookSha256,nativeEvidenceSource:'startup',queryGeneration:1,normalizedEventType:'freshAgent.session.init',nativeReceiverPublished:false,nativeReceiverContainsIdentity:false}]
          return new Promise(resolve=>{finish=resolve})
        }
        if(request.method!=='fresh_agent_send')throw new Error('unexpected native field operation')
        return {result:{Err:{code:'UNKNOWN_SOUL'}}}
      },adminOk:async()=>({data:[{soulId,launchState:'starting',nativeIdentityObservation:null}]})
    } as unknown as RuntimeHarness
    try {
      const original=await executeManagedNativeCase(harness,[...['env_file','ca_file'].map(suffix=>({name:'claude/grants/'+suffix,path:path.join(directory,suffix),sha256:'e'.repeat(64)})),{name:'claude/native-fault/sdk-init-fields.json',path:markerFile,sha256:createHash('sha256').update(fs.readFileSync(markerFile)).digest('hex')}],{mode,case:'startup'},caseId)
      expect(original.assertions.every(item=>item.pass)).toBe(true)
      expect(original.artifactReferences).toContain(`${mode}-${caseId}-native-field-normalized-private.json`)
    } finally {fs.rmSync(directory,{recursive:true,force:true})}
  })
  it.each(['image','pin','sdk','original-publisher','patched-publisher','installed-publisher','installed-sdk'])('rejects incomplete native field image admission before launch (%s)',async fault=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'native-field-image-'))
    const publisher=fs.readFileSync('crates/freshell-claude-sidecar/index.mjs','utf8')
    const marker:any={kind:'owned-sdk-native-init-field-fault-image',imageDigest,sdkVersion:'0.3.237',originalExecutableSha256:'73975167f0108693cf6fd6614994781657ebb8456ebef5d247458734abfb3916',originalPublisherSha256:createHash('sha256').update(publisher).digest('hex'),patchedPublisherSha256:createHash('sha256').update(stageSdkInitFieldFault(publisher)).digest('hex')}
    const installed={...marker}
    if(fault==='image')marker.imageDigest='sha256:'+'0'.repeat(64)
    if(fault==='pin')marker.originalExecutableSha256='0'.repeat(64)
    if(fault==='sdk')marker.sdkVersion='0.0.0'
    if(fault==='original-publisher')marker.originalPublisherSha256='0'.repeat(64)
    if(fault==='patched-publisher')marker.patchedPublisherSha256='0'.repeat(64)
    if(fault==='installed-publisher')installed.patchedPublisherSha256='0'.repeat(64)
    if(fault==='installed-sdk')installed.sdkVersion='0.0.0'
    const file=path.join(directory,'image.json');fs.writeFileSync(file,JSON.stringify(marker))
    const launch=vi.fn(),start=vi.fn(async()=>({containerId:'owned-supervisor'}))
    const harness={testRoot:directory,imageRef:imageDigest,startSupervisor:start,execOwnedContainerExact:async()=>JSON.stringify(installed),writeArtifact:()=>'',adminRaw:launch} as unknown as RuntimeHarness
    try {
      await expect(executeManagedNativeCase(harness,[...['env_file','ca_file'].map(suffix=>({name:'claude/grants/'+suffix,path:path.join(directory,suffix),sha256:'e'.repeat(64)})),{name:'claude/native-fault/sdk-init-fields.json',path:file,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')}],{mode:'freshclaude',case:'startup'},'missing-native-id')).rejects.toThrow(fault.startsWith('installed')?'actual SDK native init-field fault image differs before input':'fault image binding differs')
      expect(launch).not.toHaveBeenCalled();expect(start).toHaveBeenCalledTimes(fault.startsWith('installed')?1:0)
    } finally {fs.rmSync(directory,{recursive:true,force:true})}
  })
  it.each(['freshclaude','kilroy'] as const)('requires a distinct owned native field-fault image before %s missing or placeholder ID launches', async mode => {
    for (const caseId of ['missing-native-id','placeholder-id']) {
      const directory=fs.mkdtempSync(path.join(os.tmpdir(),'native-field-admission-'))
      const launch=vi.fn(async()=>{throw new Error('unqualified provider launch')})
      const harness={testRoot:directory,startSupervisor:async()=>({}),writeArtifact:()=>'',broker:{receipts:()=>[]},adminRaw:launch} as unknown as RuntimeHarness
      try {
        await expect(executeManagedNativeCase(harness,['env_file','ca_file'].map(suffix=>({name:'claude/grants/'+suffix,path:path.join(directory,suffix),sha256:'e'.repeat(64)})),{mode,case:'startup'},caseId)).rejects.toThrow('owned SDK native init-field fault image required')
        expect(launch).not.toHaveBeenCalled()
      } finally {fs.rmSync(directory,{recursive:true,force:true})}
    }
  })
  it.each(['freshclaude', 'kilroy'] as const)('routes finite real-native startup faults for %s without any model dispatch', async (mode) => {
    for (const caseId of ['disabled-hooks', 'timeout-50s', 'provider-exit', 'stop-cancellation']) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-fresh-startup-route-'))
      const launch = vi.fn(async (_supervisor: unknown, body: any) => {
        expect(body.params.provider).toBe(mode === 'kilroy' ? 'kilroy' : 'claude')
        expect(body.params.freshAgent.fixtureTransport).toBeUndefined()
        expect(body.params.freshAgent.sessionType).toBe(mode)
        expect(body.params.freshAgent.runtimeVariant).toBe('claude-sdk-sidecar')
        expect(body.params.freshAgent.nativeSessionId).toBeUndefined()
        if (caseId === 'wrong-id') expect(body.params.nativeSessionId).toMatch(/^[a-f0-9-]{36}$/)
        else {
          const settings = JSON.parse(fs.readFileSync(path.join(body.params.freshAgent.cwd, '.claude/settings.json'), 'utf8'))
          expect(settings.disableAllHooks).toBe(true)
          if (caseId === 'placeholder-id') expect(body.params.freshAgent.sessionId).toMatch(/^native-fresh-/)
        }
        throw new Error('controlled genuine native startup boundary')
      })
      const harness = {testRoot:directory,startSupervisor:async()=>({}),writeArtifact:()=>'',broker:{receipts:()=>[]},adminRaw:launch,adminOk:launch} as unknown as RuntimeHarness
      try {
        await expect(executeManagedNativeCase(harness,['env_file','ca_file'].map(suffix=>({name:'claude/grants/'+suffix,path:path.join(directory,suffix),sha256:'e'.repeat(64)})),{mode,case:'startup'},caseId))
          .rejects.toThrow('controlled genuine native startup boundary')
        expect(launch).toHaveBeenCalledOnce()
      } finally {fs.rmSync(directory,{recursive:true,force:true})}
    }
  })
  it.each(['changed-tool', 'missing-tool', 'changed-input', 'changed-profile', 'changed-root', 'stale-callback',
    'crash-before-checkpoint', 'multiple-tools', 'effect-before-observation', 'exact-resume'])(
    'dispatches %s through the managed native launch boundary', async (caseId) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-negative-route-'))
      const launch = vi.fn(async (_supervisor: unknown, _body: any) => { throw new Error('controlled native launch boundary') })
      const harness = { testRoot: directory, startSupervisor: async () => ({}),
        writeArtifact: () => '', adminOk: launch } as unknown as RuntimeHarness
      try {
        await expect(executeManagedNativeCase(harness,
          ['env_file', 'ca_file'].map((suffix) => ({ name: 'claude/grants/' + suffix,
            path: path.join(directory, suffix), sha256: 'e'.repeat(64) })),
          { mode: 'freshclaude', case: caseId === 'exact-resume' ? 'startup' : 'approval-checkpoint' }, caseId))
          .rejects.toThrow('controlled native launch boundary')
        expect(launch).toHaveBeenCalledOnce()
        expect(launch.mock.calls[0]![1].params.freshAgent.sessionType).toBe('freshclaude')
      } finally { fs.rmSync(directory, { recursive: true, force: true }) }
    })
  it('actual entrypoint prepares finite phase-one artifacts and joins cleanup on preparation failure', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-entry-unit-'))
    const manifest = path.join(directory, 'artifacts.json')
    const previous = process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE
    fs.writeFileSync(manifest, JSON.stringify({ candidateSha, imageDigest,
      artifacts: { supervisor: { path: '/fixture/supervisor', sha256: 'c'.repeat(64) },
        host: { path: '/fixture/host', sha256: 'd'.repeat(64) } }, sourceFiles: [] }), { mode: 0o600 })
    process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE = manifest
    let selectedPhase: number | undefined
    const prepare = vi.spyOn(RuntimeHarness.prototype, 'prepareNativeArtifacts').mockImplementation(async function () {
      selectedPhase = this.phase
      throw new Error('controlled native preparation failure')
    })
    const cleanup = vi.spyOn(RuntimeHarness.prototype, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
    try {
      await expect(runNativeFeasibility(['--mode', 'freshclaude', '--case', 'startup']))
        .rejects.toThrow('controlled native preparation failure')
      expect(selectedPhase).toBe(1)
      expect(prepare).toHaveBeenCalledOnce()
      expect(cleanup).toHaveBeenCalledOnce()
    } finally {
      prepare.mockRestore(); cleanup.mockRestore()
      if (previous === undefined) delete process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE
      else process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE = previous
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
  it.each(['freshclaude', 'kilroy'] as const)('sends the logical %s workload and Claude native grants to the actual launch route', async (mode) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-logical-mode-'))
    const manifest = path.join(directory, 'artifacts.json')
    const previous = process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE
    fs.writeFileSync(manifest, JSON.stringify({ candidateSha, imageDigest,
      artifacts: { supervisor: { path: '/fixture/supervisor', sha256: 'c'.repeat(64) },
        host: { path: '/fixture/host', sha256: 'd'.repeat(64) } }, sourceFiles: [] }), { mode: 0o600 })
    process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE = manifest
    let scratch: string | undefined
    const requests: any[] = []
    const prepare = vi.spyOn(RuntimeHarness.prototype, 'prepareNativeArtifacts').mockImplementation(async function () {
      scratch = this.testRoot
      fs.mkdirSync(scratch, { recursive: true, mode: 0o700 })
      this.imageRef = imageDigest
      return { supervisorPath: '/fixture/supervisor', hostPath: '/fixture/host', files:
        ['env_file', 'ca_file'].map((suffix) => ({ name: 'claude/grants/' + suffix,
          path: path.join(directory, suffix), sha256: 'e'.repeat(64) })) }
    })
    const start = vi.spyOn(RuntimeHarness.prototype, 'startSupervisor').mockResolvedValue({} as never)
    const write = vi.spyOn(RuntimeHarness.prototype, 'writeArtifact').mockReturnValue('fixture-artifact')
    const admin = vi.spyOn(RuntimeHarness.prototype, 'adminOk').mockImplementation(async (_supervisor, body) => {
      requests.push(body)
      throw new Error('controlled stop after actual launch request')
    })
    const cleanup = vi.spyOn(RuntimeHarness.prototype, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
    try {
      await expect(runNativeFeasibility(['--mode', mode, '--case', 'approval-checkpoint'])).rejects.toThrow('native experiment cases failed')
      expect(requests).toHaveLength(1)
      const launch = requests[0].params
      const logical = mode === 'kilroy' ? 'kilroy' : 'claude'
      expect(launch.provider).toBe(logical)
      expect(launch.freshAgent.provider).toBe(logical)
      expect(launch.freshAgent.sessionType).toBe(mode)
      expect(launch.freshAgent.providerSecretReferences.map((reference: any) => reference.profile))
        .toEqual(['claude_onecli_environment', 'claude_onecli_ca_file'])
      expect(cleanup).toHaveBeenCalledOnce()
    } finally {
      for (const spy of [prepare, start, write, admin, cleanup]) spy.mockRestore()
      if (previous === undefined) delete process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE
      else process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE = previous
      if (scratch) fs.rmSync(scratch, { recursive: true, force: true })
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
  it.each((['claude', 'amplifier'] as const).flatMap(provider => (['startup', 'native-turn'] as const).map(caseId => ({ provider, caseId }))))('executes terminal $provider/$caseId profile preparation and paid prerequisite ordering', async ({ provider, caseId }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-terminal-create-hold-'))
    const manifest = path.join(directory, 'artifacts.json')
    const preferences = path.join(directory, 'preferences.json'); fs.writeFileSync(preferences, '{}')
    const previous = process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE
    const files = (provider === 'amplifier' ? ['grants/env_file', 'grants/ca_file', '.amplifier/settings.yaml', '.amplifier/bundles/default.yaml']
      : caseId === 'startup' ? ['grants/env_file', 'grants/ca_file', 'profile/native-startup-user.json'] : ['grants/env_file', 'grants/ca_file'])
      .map((name) => ({ name: provider + '/' + name, path: preferences, sha256: 'e'.repeat(64) }))
    fs.writeFileSync(manifest, JSON.stringify({ candidateSha, imageDigest, artifacts: {
      supervisor: { path: '/fixture/supervisor', sha256: 'c'.repeat(64) },
      host: { path: '/fixture/host', sha256: 'd'.repeat(64) },
    }, sourceFiles: files }))
    process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE = manifest
    let scratch: string | undefined
    let generatedProfileRoot: string | undefined
    const prepare = vi.spyOn(RuntimeHarness.prototype, 'prepareNativeArtifacts').mockImplementation(async function (input) {
      scratch = this.testRoot; fs.mkdirSync(scratch, { recursive: true, mode: 0o700 })
      const profile = input.sourceFiles.find((file) => file.name === 'claude/profile/native-startup-user.json')
      if (profile && profile.path !== preferences) {
        fs.readFileSync(profile.path)
        generatedProfileRoot = path.dirname(profile.path)
      }
      return { supervisorPath: '/fixture/supervisor', hostPath: '/fixture/host', serverPath: '/fixture/server', files: input.sourceFiles }
    })
    const start = vi.spyOn(RuntimeHarness.prototype, 'startSupervisor').mockResolvedValue({} as never)
    const write = vi.spyOn(RuntimeHarness.prototype, 'writeArtifact').mockReturnValue('fixture-artifact')
    const admin = vi.spyOn(RuntimeHarness.prototype, 'adminOk').mockRejectedValue(new Error('controlled create failure'))
    const raw = vi.spyOn(RuntimeHarness.prototype, 'adminRaw').mockRejectedValue(new Error('controlled negative failure'))
    const server = vi.spyOn(RustServer.prototype, 'start').mockRejectedValue(new Error('paid seed must remain held'))
    const evidence = vi.spyOn(RustServer.prototype, 'processEvidence').mockReturnValue({} as never)
    const stop = vi.spyOn(RustServer.prototype, 'stop').mockResolvedValue()
    const cleanup = vi.spyOn(RuntimeHarness.prototype, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
    try {
      await expect(runNativeFeasibility(['--provider', provider, '--case', caseId])).rejects.toThrow('native experiment cases failed')
      if (caseId === 'startup') {
        if (provider === 'claude') expect(admin).toHaveBeenCalledOnce()
        else expect(admin.mock.calls.map(([, request]: any) => path.basename(request.params.terminal.cwd)))
          .toEqual(['amplifier-create-workspace', 'amplifier-file-replacement-workspace', 'amplifier-file-truncation-workspace', 'amplifier-malformed-ack-workspace'])
        expect(server).not.toHaveBeenCalled()
      } else {
        expect(server).toHaveBeenCalledOnce()
        expect(admin).not.toHaveBeenCalled()
      }
      expect(cleanup).toHaveBeenCalledOnce()
    } finally {
      prepare.mockRestore(); start.mockRestore(); write.mockRestore(); admin.mockRestore(); raw.mockRestore()
      server.mockRestore(); evidence.mockRestore(); stop.mockRestore(); cleanup.mockRestore()
      if (previous === undefined) delete process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE
      else process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE = previous
      fs.rmSync(directory, { recursive: true, force: true })
      if (scratch) fs.rmSync(scratch, { recursive: true, force: true })
      if (generatedProfileRoot) fs.rmSync(generatedProfileRoot, { recursive: true, force: true })
    }
  })
  it.each(['freshcodex','freshopencode','codex'] as const)('holds receiver paid recovery after failed initial create (%s; entrypoint orchestration only)', async mode => {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'receiver-paid-hold-')),provider=mode==='freshcodex'||mode==='codex'?'codex':'opencode'
    const manifest=path.join(directory,'artifacts.json'),previous=process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE
    fs.writeFileSync(manifest,JSON.stringify({candidateSha,imageDigest,artifacts:{supervisor:{path:'/fixture/supervisor',sha256:'c'.repeat(64)},host:{path:'/fixture/host',sha256:'d'.repeat(64)}},
      sourceFiles:['env_file','auth_file','ca_file'].map(suffix=>({name:`${provider}/grants/${suffix}`,path:'/fixture/'+suffix,sha256:'e'.repeat(64)}))}))
    process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE=manifest
    let scratch=''
    const prepare=vi.spyOn(RuntimeHarness.prototype,'prepareNativeArtifacts').mockImplementation(async function(input){scratch=this.testRoot;fs.mkdirSync(scratch,{recursive:true});return{supervisorPath:'/fixture/supervisor',hostPath:'/fixture/host',files:input.sourceFiles,...(mode==='codex'?{serverPath:'/fixture/server'}:{})}})
    const start=vi.spyOn(RuntimeHarness.prototype,'startSupervisor').mockResolvedValue({} as never),write=vi.spyOn(RuntimeHarness.prototype,'writeArtifact').mockReturnValue('fixture')
    const admin=vi.spyOn(RuntimeHarness.prototype,'adminOk').mockRejectedValue(new Error('controlled failed native create'))
    const server=vi.spyOn(RustServer.prototype,'start').mockRejectedValue(new Error('paid controller must remain held'))
    const serverEvidence=vi.spyOn(RustServer.prototype,'processEvidence').mockReturnValue({} as any)
    const serverStop=vi.spyOn(RustServer.prototype,'stop').mockResolvedValue()
    const cleanup=vi.spyOn(RuntimeHarness.prototype,'cleanup').mockResolvedValue({ok:true,errors:[]})
    try{
      await expect(runNativeFeasibility([mode==='codex'?'--provider':'--mode',mode,'--case','startup'])).rejects.toThrow('native experiment cases failed')
      expect(server).not.toHaveBeenCalled();expect(admin).toHaveBeenCalledTimes(1);expect(start).toHaveBeenCalledTimes(1);expect(cleanup).toHaveBeenCalledTimes(1)
    }finally{
      server.mockRestore();serverEvidence.mockRestore();serverStop.mockRestore();prepare.mockRestore();start.mockRestore();write.mockRestore();admin.mockRestore();cleanup.mockRestore()
      if(previous===undefined)delete process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE;else process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE=previous
      if(scratch)fs.rmSync(scratch,{recursive:true,force:true});fs.rmSync(directory,{recursive:true,force:true})
    }
  })
  it('prepares only exact private native artifacts and selected source copies without ambient mounts', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-artifact-unit-'))
    execFileSync('git', ['init', '-q', directory])
    const gitOptions = { cwd: directory, encoding: 'utf8' as const }
    const tree = execFileSync('git', ['hash-object', '-t', 'tree', '-w', '--stdin'], { ...gitOptions, input: '' }).trim()
    const identity = 'Dan Shapiro <3732858+danshapiro@users.noreply.github.com> 1 +0000'
    const fixtureCommit = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'],
      { ...gitOptions, input: 'tree ' + tree + '\nauthor ' + identity + '\ncommitter ' + identity + '\n\nNative artifact unit fixture\n' }).trim()
    execFileSync('git', ['update-ref', 'HEAD', fixtureCommit], gitOptions)
    const bin = path.join(directory, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'docker'), '#!' + process.execPath + '\n' +
      `const kind=process.argv[2];if(kind==='info')process.stdout.write('["name=rootless"]');else if(kind==='image')process.stdout.write('${imageDigest}');else process.exit(2);`, { mode: 0o500 })
    const originalPath = process.env.PATH
    process.env.PATH = bin + path.delimiter + originalPath
    const artifact = (name: string, body: string) => {
      const file = path.join(directory, name)
      fs.writeFileSync(file, body, { mode: 0o500 })
      return { path: file, sha256: createHash('sha256').update(body).digest('hex') }
    }
    const supervisor = artifact('fixture-supervisor', 'fixture-only-supervisor')
    const host = artifact('fixture-host', 'fixture-only-host')
    const server = artifact('fixture-server', '#!' + process.execPath + '\nprocess.stdout.write("owned-native-server-fixture");\n')
    const profile = artifact('selected-profile', 'owned-selected-profile-bytes')
    fs.chmodSync(profile.path, 0o600)
    const harness = new RuntimeHarness(directory, randomUUID(), 1)
    try {
      const prepared = await harness.prepareNativeArtifacts({ candidateSha: fixtureCommit, imageDigest, supervisor, host,
        ...{ server },
        sourceFiles: [{ name: 'claude/settings.json', ...profile }] })
      expect(harness.imageRef).toBe(imageDigest)
      expect(fs.readFileSync(harness.testHostBinary, 'utf8')).toBe('fixture-only-host')
      expect(fs.readFileSync(harness.testSupervisorBinary, 'utf8')).toBe('fixture-only-supervisor')
      expect(execFileSync(path.join(harness.buildDir, 'freshell-server-native'), [], { encoding: 'utf8' }))
        .toBe('owned-native-server-fixture')
      expect(prepared.sourceRoot.startsWith(harness.testRoot + path.sep)).toBe(true)
      expect(prepared.files[0]?.path).toBe(path.join(prepared.sourceRoot, 'claude/settings.json'))
      expect(fs.readFileSync(prepared.files[0]!.path, 'utf8')).toBe('owned-selected-profile-bytes')
      expect(fs.statSync(prepared.files[0]!.path).mode & 0o777).toBe(0o600)
      expect(prepared.files.map((file) => file.path)).not.toContain(path.join(os.homedir(), '.claude/settings.json'))
      const withoutServer = new RuntimeHarness(directory, randomUUID(), 1)
      try {
        await withoutServer.prepareNativeArtifacts({ candidateSha: fixtureCommit, imageDigest, supervisor, host,
          sourceFiles: [{ name: 'claude/settings.json', ...profile }] })
        expect(fs.existsSync(path.join(withoutServer.buildDir, 'freshell-server-native'))).toBe(false)
      } finally {
        await withoutServer.cleanup()
        fs.rmSync(withoutServer.testRoot, { recursive: true, force: true })
      }
      await expect(harness.prepareNativeArtifacts({ candidateSha: fixtureCommit, imageDigest, supervisor, host,
        ...{ server }, sourceFiles: [] })).rejects.toThrow('native run already exists')
      for (const fault of ['candidate', 'image', 'phase', 'writable-binary', 'changed-source', 'escaped-name', 'duplicate-name', 'writable-server', 'changed-server', 'missing-server', 'symlink-server']) {
        const denied = new RuntimeHarness(directory, randomUUID(), fault === 'phase' ? 2 : 1)
        const input = { candidateSha: fixtureCommit, imageDigest, supervisor, host, server: { ...server },
          sourceFiles: [{ name: 'claude/settings.json', ...profile }] }
        if (fault === 'candidate') input.candidateSha = 'c'.repeat(40)
        if (fault === 'image') input.imageDigest = `sha256:${'b'.repeat(64)}`
        if (fault === 'writable-binary') fs.chmodSync(host.path, 0o700)
        if (fault === 'writable-server') fs.chmodSync(server.path, 0o700)
        if (fault === 'changed-server') {
          fs.chmodSync(server.path, 0o700)
          fs.writeFileSync(server.path, 'changed-server')
          fs.chmodSync(server.path, 0o500)
        }
        if (fault === 'missing-server') input.server.path = path.join(directory, 'missing-server')
        if (fault === 'symlink-server') {
          input.server.path = path.join(directory, 'server-link')
          fs.symlinkSync(server.path, input.server.path)
        }
        if (fault === 'changed-source') fs.writeFileSync(profile.path, 'changed-source')
        if (fault === 'escaped-name') input.sourceFiles[0]!.name = 'claude/../escaped.json'
        if (fault === 'duplicate-name') input.sourceFiles.push({ ...input.sourceFiles[0]! })
        try {
          await expect(denied.prepareNativeArtifacts(input), fault).rejects.toThrow()
          expect(fs.existsSync(path.join(denied.testRoot, 'native-source')), fault).toBe(false)
          expect(fs.existsSync(denied.buildDir), fault).toBe(false)
        } finally {
          fs.chmodSync(host.path, 0o500)
          fs.chmodSync(server.path, 0o700)
          fs.writeFileSync(server.path, '#!' + process.execPath + '\nprocess.stdout.write("owned-native-server-fixture");\n')
          fs.chmodSync(server.path, 0o500)
          fs.writeFileSync(profile.path, 'owned-selected-profile-bytes')
          await denied.cleanup()
          fs.rmSync(denied.testRoot, { recursive: true, force: true })
        }
      }
    } finally {
      process.env.PATH = originalPath
      await harness.cleanup()
      fs.rmSync(harness.testRoot, { recursive: true, force: true })
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
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

  it('refuses startup-only evidence for a native continuity turn', async () => {
    let cleaned = false
    await expect(dispatchNativeFeasibility({ selection: { mode: 'freshclaude', case: 'native-turn' },
      imageDigest, candidateSha, ownerId, execute: async (caseId) => child(caseId),
      cleanup: async () => { cleaned = true },
    })).rejects.toThrow()
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

describe('original native checkpoint byte continuity (fixtures do not qualify providers)', () => {
  const root = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const toolUseID = 'toolu_original1'
  const bytes = Buffer.from(JSON.stringify({ type: 'attachment', sessionId: root,
    attachment: { type: 'hook_deferred_tool', toolUseID } }) + '\n')
  const snapshot = (raw: Buffer, device = '2065', inode = '42') => ({ nativeRoot: root,
    transcript: { bytesBase64: raw.toString('base64'), sha256: createHash('sha256').update(raw).digest('hex'),
      completeEof: raw.at(-1) === 10, identity: [device, inode, String(raw.length)] } })
  it('recognizes two actual native tool rows sharing one model message without combining unrelated turns', () => {
    const commands = ['first independent command', 'second independent command']
    const row = (command: string, id: string, messageId = 'msg_actual_batch', name = 'Bash') => ({
      type: 'assistant', sessionId: root, message: { id: messageId,
        content: [{ type: 'tool_use', id, name, input: { command } }] } })
    const native = (rows: unknown[]) => snapshot(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n'))
    const first = row(commands[0]!, 'toolu_first1'); const second = row(commands[1]!, 'toolu_second1')
    expect(nativeTwoToolBatchMatches(native([first, second]), commands)).toBe(true)
    expect(nativeTwoToolBatchMatches(native([{ ...first, message: { ...first.message,
      content: [...first.message.content, ...second.message.content] } }]), commands)).toBe(true)
    expect(nativeTwoToolBatchMatches(native([first, row(commands[1]!, 'toolu_second1', 'msg_next_turn')]), commands)).toBe(false)
    expect(nativeTwoToolBatchMatches(native([first, row(commands[0]!, 'toolu_second1')]), commands)).toBe(false)
    expect(nativeTwoToolBatchMatches(native([first, row(commands[1]!, 'toolu_first1')]), commands)).toBe(false)
    expect(nativeTwoToolBatchMatches(native([first, row(commands[1]!, 'toolu_second1', '', 'Bash')]), commands)).toBe(false)
    expect(nativeTwoToolBatchMatches(native([first, row(commands[1]!, 'toolu_second1', 'msg_actual_batch', 'Read')]), commands)).toBe(false)
    expect(nativeTwoToolBatchMatches(native([first, { ...second, sessionId: 'other-root' }]), commands)).toBe(false)
    expect(nativeTwoToolBatchMatches({ ...native([first, second]), transcript: {
      ...native([first, second]).transcript, sha256: 'f'.repeat(64) } }, commands)).toBe(false)
    expect(nativeTwoToolBatchMatches(native([first, second]), [commands[0]!, commands[0]!])).toBe(false)
  })
  const lifecycle = Buffer.from(JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: root }) + '\n'
    + JSON.stringify({ type: 'attachment', sessionId: root, attachment: { type: 'hook_success' } }) + '\n')
  it('retains the original EOF bytes and inode when native resume appends only lifecycle rows', () => {
    expect(nativeCheckpointTranscriptRetained(snapshot(bytes), snapshot(bytes), toolUseID)).toBe(true)
    expect(nativeCheckpointTranscriptRetained(snapshot(bytes), snapshot(Buffer.concat([bytes, lifecycle])), toolUseID)).toBe(true)
  })
  it.each(['mutation', 'truncation', 'replacement', 'device', 'incomplete-eof', 'tool-result', 'new-checkpoint', 'wrong-root', 'malformed-tail', 'wrong-tail-root', 'new-assistant', 'missing-identity'])(
    'refuses actual %s before an approval decision', (fault) => {
      const before = snapshot(bytes)
      let raw = Buffer.concat([bytes, lifecycle])
      if (fault === 'mutation') { raw = Buffer.from(raw); raw[10] ^= 1 }
      if (fault === 'truncation') raw = bytes.subarray(0, bytes.length - 2)
      if (fault === 'incomplete-eof') raw = raw.subarray(0, raw.length - 1)
      if (fault === 'tool-result') raw = Buffer.concat([bytes, Buffer.from(JSON.stringify({ type: 'user', sessionId: root,
        message: { content: [{ type: 'tool_result', tool_use_id: toolUseID, is_error: true }] } }) + '\n')])
      if (fault === 'new-checkpoint') raw = Buffer.concat([bytes, bytes])
      if (fault === 'malformed-tail') raw = Buffer.concat([bytes, Buffer.from('{broken\n')])
      if (fault === 'wrong-tail-root') raw = Buffer.concat([bytes, Buffer.from(JSON.stringify({ type: 'queue-operation',
        operation: 'enqueue', sessionId: 'different-native-root' }) + '\n')])
      if (fault === 'new-assistant') raw = Buffer.concat([bytes, Buffer.from(JSON.stringify({ type: 'assistant', sessionId: root }) + '\n')])
      const after = snapshot(raw, fault === 'device' ? '2066' : '2065', fault === 'replacement' ? '43' : '42')
      if (fault === 'wrong-root') after.nativeRoot = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      if (fault === 'missing-identity') { before.transcript.identity = []; after.transcript.identity = [] }
      expect(nativeCheckpointTranscriptRetained(before, after, toolUseID)).toBe(false)
    })
})

describe('selected native Amplifier profile continuity (fixture metadata only)', () => {
  const workspace = '/owned/native-workspace'
  const files = (settings = 'a'.repeat(64), keys = 'b'.repeat(64)) => [
    { relative: '.amplifier/settings.yaml', sha256: settings },
    { relative: '.amplifier/bundles/default.yaml', sha256: 'c'.repeat(64) },
    { relative: '.amplifier/keys.env', sha256: keys },
  ]
  const before = () => ({ nativeCwd: workspace, nativeSettingsSha256: 'd'.repeat(64), profileFiles: files() })
  it('uses the full native resolved settings while preserving bundle and workspace when saved secret aliases normalize', () => {
    const old = before()
    const current = { ...before(), profileFiles: files('e'.repeat(64), 'f'.repeat(64)) }
    expect(amplifierNativeProfileRetained(old, current, workspace)).toBe(true)
  })
  it.each(['resolved-settings', 'bundle', 'workspace', 'missing-native-profile', 'missing-file', 'duplicate-file', 'invalid-digest'])(
    'refuses changed %s rather than treating raw-byte differences alone as harmless', (fault) => {
      const old = before(); const current = before()
      if (fault === 'resolved-settings') current.nativeSettingsSha256 = 'e'.repeat(64)
      if (fault === 'bundle') current.profileFiles[1]!.sha256 = 'e'.repeat(64)
      if (fault === 'workspace') current.nativeCwd = '/different/owned/workspace'
      if (fault === 'missing-native-profile') current.nativeSettingsSha256 = ''
      if (fault === 'missing-file') current.profileFiles.pop()
      if (fault === 'duplicate-file') current.profileFiles[2] = { ...current.profileFiles[0]! }
      if (fault === 'invalid-digest') current.nativeSettingsSha256 = 'unqualified'
      expect(amplifierNativeProfileRetained(old, current, workspace)).toBe(false)
    })
})
