import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as owner from '../../../../scripts/testing/runtime-sandbox.js'
import * as external from '../../../../scripts/testing/runtime-external-browser.js'
import { execFile, execFileSync } from 'node:child_process'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import net from 'node:net'
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { runTask2RetainedFixture } from '../../../../scripts/testing/task002-config-legacy-fixtures.js'
import { RustServer } from '../../../e2e-browser/helpers/rust-server.js'
import * as retained from '../../../../scripts/testing/task002-retained-fixture.js'
import { RestrictedDockerBroker } from '../../../../scripts/testing/runtime-test-broker.js'
import type { NativeHistory } from '../../../../scripts/testing/provider-native-history.js'
import plugin from '../../../../extensions/opencode/freshell-rebind-plugin.js'

const { DatabaseSync }: typeof import('node:sqlite') = createRequire(import.meta.url)('node:sqlite')

const sourceRoot = process.cwd()
let fixtureRepoRoot: string

beforeEach(async () => {
  // Exercise the real Git provenance boundary even in source-only Cloud images.
  fixtureRepoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'runtime-owner-facts-repo-'))
  const schema = 'crates/freshell-sessions/src/opencode_schema_v1_18_21.sql'
  await fsp.mkdir(path.dirname(path.join(fixtureRepoRoot, schema)), { recursive: true })
  await fsp.copyFile(path.join(sourceRoot, schema), path.join(fixtureRepoRoot, schema))
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'user.name=Dan Shapiro', '-c', 'user.email=3732858+danshapiro@users.noreply.github.com',
    '-c', 'commit.gpgsign=false', ...args,
  ], { cwd: fixtureRepoRoot, encoding: 'utf8', timeout: 10_000 })
  git('init', '--quiet')
  git('add', '.')
  git('commit', '--quiet', '-m', 'Owned runtime facts unit fixture')
})

afterEach(async () => {
  if (fixtureRepoRoot) await fsp.rm(fixtureRepoRoot, { recursive: true, force: true })
})

const handle = {
  runId: 'run-owned', candidateSha: 'a'.repeat(40), soulId: 'soul-owned',
  incarnationId: 'incarnation-owned', containerId: 'b'.repeat(64),
  hostBootId: 'boot-owned', nativeSessionId: 'native-owned',
}

describe('Task7 standalone owner cancellation', () => {
  it.each([
    ...(['SIGINT', 'SIGTERM'] as const).flatMap(signal =>
      (['wait', 'create', 'export', 'export-never', 'export-abort'] as const).map(stage => ({ signal, stage }))),
    { signal: 'SIGTERM' as const, stage: 'ordinary-wait' as const },
  ])(
    'settles exact children and resources on $signal during $stage', async ({ signal, stage }) => {
      const directory = path.join(fixtureRepoRoot, `cancel-${signal}-${stage}`)
      await fsp.mkdir(directory, { mode: 0o700 })
      const stateFile = path.join(directory, 'daemon.json')
      const eventsFile = path.join(directory, 'events.jsonl')
      const readyFile = path.join(directory, 'ready.json')
      const resultFile = path.join(directory, 'owner.json')
      const id = 'a'.repeat(64), foreignId = 'f'.repeat(64), knownId = 'd'.repeat(64), helperId = 'e'.repeat(64)
      const uncertain = stage === 'export-never' || stage === 'export-abort'
      const volume = `freshell-provider-${'c'.repeat(24)}`
      const allocatedVolume = uncertain ? `freshell-provider-${'e'.repeat(24)}` : volume
      const state = { containers: { [foreignId]: { Id: foreignId, Name: 'unrelated-sentinel' }, ...(uncertain ? { [knownId]: { Id: knownId, Name: 'known-owned' } } : {}) }, volumes: ['unrelated-volume', volume] }
      await fsp.writeFile(stateFile, JSON.stringify(state))
      const docker = path.join(directory, 'docker')
      const common = `const fs=require('node:fs'),http=require('node:http');const stateFile=${JSON.stringify(stateFile)},eventsFile=${JSON.stringify(eventsFile)},readyFile=${JSON.stringify(readyFile)};const event=(kind,data={})=>fs.appendFileSync(eventsFile,JSON.stringify({kind,...data})+'\\n');`
      await fsp.writeFile(docker, `#!${process.execPath}\n${common}
const args=process.argv.slice(2),state=JSON.parse(fs.readFileSync(stateFile));event('docker',{args});
if(args[0]==='create'){
 const name=args[args.indexOf('--name')+1],labels={};for(let i=0;i<args.length;i++)if(args[i]==='--label'){const [key,value]=args[++i].split('=');labels[key]=value}
 const mounts=[];for(let i=0;i<args.length;i++)if(args[i]==='--mount'){const items=args[++i].split(','),values=Object.fromEntries(items.map(item=>item.split('=')));mounts.push({Type:values.type,Source:values.source,Destination:values.target,RW:!items.includes('readonly')})}
 state.containers['${id}']={Id:'${id}',Name:name,Image:args[args.indexOf('--entrypoint')+2],Config:{Labels:labels},Mounts:mounts};fs.writeFileSync(stateFile,JSON.stringify(state));
 const acknowledge=()=>{event('create.settled');process.stdout.write('${id}')};if(${JSON.stringify(stage)}==='create'){fs.writeFileSync(readyFile,JSON.stringify({pid:process.pid}));setTimeout(acknowledge,250)}else acknowledge();
}else if(args[0]==='wait'){
 fs.writeFileSync(readyFile,JSON.stringify({pid:process.pid}));event('wait.started');setInterval(()=>{},1000);
 process.on('SIGTERM',()=>{const socket=JSON.parse(fs.readFileSync(${JSON.stringify(resultFile)})).socket;const request=http.get({socketPath:socket,path:'/_ping'},response=>{response.resume();response.on('end',()=>setTimeout(()=>{event('wait.settled');process.stderr.write('cancelled wait');process.exit(9)},75))});request.on('error',()=>process.exit(8))});
}else if(args[0]==='logs')process.stdout.write('partial owned parent output');
else if(args[0]==='inspect'){const item=Object.values(state.containers).find(item=>item.Id===args[1]||item.Name===args[1]);if(!item)process.exit(1);process.stdout.write(JSON.stringify([item]))}
else if(args[0]==='rm'){if(args.at(-1)==='${foreignId}')process.exit(7);const item=Object.values(state.containers).find(item=>item.Id===args.at(-1)||item.Name===args.at(-1));if(item)delete state.containers[item.Id];fs.writeFileSync(stateFile,JSON.stringify(state));event('container.removed',{id:args.at(-1)})}
else if(args[0]==='ps')process.stdout.write(Object.values(state.containers).map(item=>args.includes('--format')?item.Name:item.Id).join('\\n'));
else if(args[0]==='volume'){if(args[1]==='rm'){if(args[2]==='unrelated-volume')process.exit(7);state.volumes=state.volumes.filter(name=>name!==args[2]);fs.writeFileSync(stateFile,JSON.stringify(state));event('volume.removed')}else process.stdout.write(state.volumes.join('\\n'))}
else if(args[0]!=='start')process.exit(4);
`, { mode: 0o700 })
      const exporter = path.join(directory, 'exporter.cjs')
      await fsp.writeFile(exporter, `${common}
const control=JSON.parse(fs.readFileSync(${JSON.stringify(resultFile)}));event('export.started',{pid:process.pid});
const send=(url,body,done)=>{const request=http.request({socketPath:control.socket,path:url,method:'POST'},response=>{let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>{event('export.response',{status:response.statusCode});if(done)done()})});request.on('error',error=>event('export.request_error',{message:error.message}));request.end(body?JSON.stringify(body):undefined)};
send('/v1.47/containers/create?name=controlled-provider',control.create,()=>{if(${JSON.stringify(stage)}==='ordinary-wait')send('/v1.47/containers/create?name='+control.helperName,control.helper,()=>{send('/v1.47/containers/${helperId}/wait?condition=not-running');setTimeout(()=>process.exit(9),200)})});setInterval(()=>{},1000);
process.on('SIGTERM',()=>{event('export.settled');process.stderr.write('partial owned export');process.exit(9)});
`)
      const launcher = path.join(directory, 'owner.mjs')
      await fsp.writeFile(launcher, `import fs from 'node:fs';import path from 'node:path';import http from 'node:http';
import {RuntimeHarness} from ${JSON.stringify(path.join(sourceRoot, 'scripts/testing/runtime-sandbox.ts'))};
import {RestrictedDockerBroker} from ${JSON.stringify(path.join(sourceRoot, 'scripts/testing/runtime-test-broker.ts'))};
import {runTask007DestructiveSandbox} from ${JSON.stringify(path.join(sourceRoot, 'scripts/testing/task007-destructive-sandbox.ts'))};
const event=(kind,data={})=>fs.appendFileSync(${JSON.stringify(eventsFile)},JSON.stringify({kind,...data})+'\\n');let upstream;
RuntimeHarness.prototype.prepareTask007StoppedFixture=async function(){
 if(!this.broker){
  fs.mkdirSync(this.testRoot,{recursive:true,mode:0o700});fs.mkdirSync(this.evidenceDir,{recursive:true,mode:0o700});fs.mkdirSync(this.buildDir,{recursive:true,mode:0o700});this.imageRef='sha256:${'b'.repeat(64)}';
  const realSocket=path.join(this.testRoot,'upstream.sock'),socket=path.join(this.testRoot,'proxy.sock'),host=path.join(this.testRoot,'host'),runtimeDir=path.join(this.testRoot,'r/scenario/x/incarnation');
  upstream=http.createServer((request,response)=>{request.resume();request.on('end',()=>{
   if(request.url.includes('/wait?')){event('helper.wait.started');fs.writeFileSync(${JSON.stringify(readyFile)},JSON.stringify({pid:process.pid}));const poll=setInterval(()=>{if(!JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)})).containers['${helperId}']){clearInterval(poll);event('helper.wait.settled');response.end(JSON.stringify({StatusCode:137}))}},10);response.on('close',()=>clearInterval(poll));return}
   if(request.method!=='POST'){response.end('OK');return}
   const helper=request.url.includes('name=freshell-history-');
   if(!helper){event('upstream.create.started');if(${JSON.stringify(stage)}!=='ordinary-wait')fs.writeFileSync(${JSON.stringify(readyFile)},JSON.stringify({pid:process.pid}))}
   if(${uncertain}){const state=JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}));state.containers['${id}']={Id:'${id}',Name:'unacknowledged-provider'};state.volumes.push('${allocatedVolume}');fs.writeFileSync(${JSON.stringify(stateFile)},JSON.stringify(state));response.once('close',()=>event('upstream.transport.closed'))}
   if(${JSON.stringify(stage)}==='export-never')return;
   if(${JSON.stringify(stage)}==='export-abort'){response.writeHead(201,{'content-type':'application/json'});response.write('{"Id":"');setTimeout(()=>{event('upstream.response.aborted');response.destroy()},250);return}
   setTimeout(()=>{const state=JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)})),id=helper?'${helperId}':'${id}';state.containers[id]={Id:id,Name:helper?new URL(request.url,'http://docker').searchParams.get('name'):'late-provider'};fs.writeFileSync(${JSON.stringify(stateFile)},JSON.stringify(state));event('upstream.create.settled');response.writeHead(201);response.end(JSON.stringify({Id:id}))},250)
  })});await new Promise(resolve=>upstream.listen(realSocket,resolve));
  this.broker=new RestrictedDockerBroker({realSocketPath:realSocket,proxySocketPath:socket,runtimeRootPrefix:path.join(this.testRoot,'r'),allowedHostBinaryPaths:new Set([host]),allowedImageRefs:new Set([this.imageRef]),testRunId:this.runId,logPath:path.join(this.evidenceDir,'broker.jsonl')});await this.broker.start();this.brokerStarted=true;this.trackedVolumes.add('${volume}');if(${uncertain})this.trackedContainers.add('${knownId}');this.task007Artifact=Promise.resolve({path:'/controlled-lib-test'});
  const close=this.broker.close.bind(this.broker);this.broker.close=async()=>{await close();event('broker.closed')};
  const create={Image:this.imageRef,Labels:{project:'freshell','com.freshell.managed':'true','com.freshell.installation-id':'installation-unit','com.freshell.incarnation-id':'incarnation-unit','com.freshell.soul-id':'soul-unit','com.freshell.runtime-test-run-id':this.runId},HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],CapAdd:[],SecurityOpt:['no-new-privileges:true'],RestartPolicy:{Name:'no'},NanoCpus:500000000,Memory:134217728,PidsLimit:64,Tmpfs:{'/tmp':'rw,noexec,nosuid,nodev,size=128m'},Binds:[host+':/runtime/freshell-session-host:ro',runtimeDir+':/run/freshell:rw','${allocatedVolume}:/home/freshell/provider:rw']}};
  const helperName='freshell-history-11111111-1111-4111-8111-111111111111';
  const helper={Image:this.imageRef,User:'65534:0',Tty:true,Entrypoint:['/runtime/freshell-session-host'],Cmd:['native-history-only','--provider','codex','--session-id','controlled-native','--provider-home','/home/freshell/provider'],Env:['HOME=/home/freshell/provider'],HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,CapDrop:['ALL'],CapAdd:[],SecurityOpt:['no-new-privileges'],Memory:268435456,MemorySwap:268435456,NanoCpus:500000000,PidsLimit:32,Tmpfs:{'/tmp':'rw,noexec,nosuid,nodev,size=16m'},Mounts:[{Type:'bind',Source:host,Target:'/runtime/freshell-session-host',ReadOnly:true},{Type:'volume',Source:'${volume}',Target:'/home/freshell/provider',ReadOnly:true}]}};
  fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({testRoot:this.testRoot,evidenceDir:this.evidenceDir,buildDir:this.buildDir,socket,create,helper,helperName}));
 }
 if(${JSON.stringify(stage)}.startsWith('export')||${JSON.stringify(stage)}==='ordinary-wait')await this.executeTask007Child(process.execPath,[${JSON.stringify(exporter)}],{cwd:this.repoRoot,env:{},timeout:15000,maxBuffer:1048576,encoding:'utf8'});
 return {inputFile:'/controlled-input',registryRoot:'/controlled-registry',sourceDatabaseFile:'/controlled-source',metadataFile:'/controlled-metadata'};
};
try{await runTask007DestructiveSandbox(${JSON.stringify(fixtureRepoRoot)})}catch(error){event('owner.failed',{message:error.message});process.exitCode=1}finally{if(upstream)await new Promise(resolve=>upstream.close(resolve))}
`)
      const child = execFile(process.execPath, ['--import', path.join(sourceRoot, 'node_modules/tsx/dist/loader.mjs'), launcher], {
        cwd: sourceRoot, env: { PATH: `${directory}${path.delimiter}${process.env.PATH}` }, timeout: 20_000,
      })
      const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, exitSignal) => resolve({ code, signal: exitSignal })))
      let activePid: number | undefined
      let control: { testRoot: string; evidenceDir: string; buildDir: string } | undefined
      try {
        await vi.waitFor(async () => {
          if (!fs.existsSync(readyFile)) throw new Error(fs.existsSync(eventsFile) ? await fsp.readFile(eventsFile, 'utf8') : 'Owner has not allocated')
          activePid = JSON.parse(await fsp.readFile(readyFile, 'utf8')).pid
        }, { timeout: 10_000 })
        control = JSON.parse(await fsp.readFile(resultFile, 'utf8'))
        if (stage !== 'ordinary-wait') expect(child.kill(signal)).toBe(true)
        const deadline = setTimeout(() => child.kill('SIGKILL'), 12_000)
        const completed = await completion.finally(() => clearTimeout(deadline))
        expect(completed.signal).toBeNull()
        expect(completed.code).not.toBe(0)
        const closure = JSON.parse(await fsp.readFile(path.join(control!.evidenceDir, 'cleanup.json'), 'utf8'))
        expect(closure, `${stage}: ${JSON.stringify(closure)}`).toMatchObject({ ok: !uncertain, verifiedResourcesAbsent: !uncertain })
        if (uncertain) {
          expect(closure.verifiedKnownResourcesAbsent).toBe(true)
          expect(closure.brokerSettlementFailures).toEqual(expect.arrayContaining([expect.objectContaining({ allocationUnknown: true,
            reason: stage === 'export-never' ? 'cleanup_deadline' : 'upstream_response_incomplete' })]))
        }
        expect(JSON.parse(await fsp.readFile(path.join(control!.evidenceDir, 'task007-destructive-owner-result.json'), 'utf8')))
          .toMatchObject({ status: stage === 'ordinary-wait' ? 'failed' : 'cancelled', ...(stage === 'ordinary-wait' ? {} : { signal }), cleanup: { ok: !uncertain } })
        const daemon = JSON.parse(await fsp.readFile(stateFile, 'utf8'))
        expect(daemon).toEqual({ containers: { [foreignId]: { Id: foreignId, Name: 'unrelated-sentinel' },
          ...(uncertain ? { [id]: { Id: id, Name: 'unacknowledged-provider' } } : {}) }, volumes: ['unrelated-volume', ...(uncertain ? [allocatedVolume] : [])] })
        const events = (await fsp.readFile(eventsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { kind: string; args?: string[] })
        if (!uncertain) {
          const settled = events.findIndex(row => row.kind === `${stage === 'export' ? 'upstream.create' : stage === 'ordinary-wait' ? 'helper.wait' : stage}.settled`)
          expect(settled).toBeGreaterThan(-1)
          expect(events.findIndex(row => row.kind === 'volume.removed')).toBeGreaterThan(settled)
          if (stage === 'ordinary-wait') expect(events.findIndex(row => row.kind === 'container.removed')).toBeLessThan(settled)
        }
        if (uncertain) expect(events.some(row => row.kind === 'upstream.transport.closed')).toBe(true)
        if (stage === 'export-abort') expect(events.some(row => row.kind === 'upstream.response.aborted')).toBe(true)
        expect(events.findIndex(row => row.kind === 'broker.closed')).toBeGreaterThan(events.findIndex(row => row.kind === 'volume.removed'))
        if (stage === 'create') expect(events.some(row => row.args?.[0] === 'start')).toBe(false)
        if (stage === 'wait') expect(await fsp.readFile(path.join(control!.evidenceDir, 'task007-destructive-parents.stdout'), 'utf8')).toBe('partial owned parent output')
        if (stage === 'export') expect(events.some(row => row.kind === 'export.settled')).toBe(true)
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await completion
        if (!control && fs.existsSync(resultFile)) control = JSON.parse(await fsp.readFile(resultFile, 'utf8'))
        if (!activePid && fs.existsSync(eventsFile)) {
          const started = (await fsp.readFile(eventsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { kind: string; pid?: number }).find(row => row.kind === 'export.started')
          activePid = started?.pid
        }
        if (activePid && activePid !== child.pid) {
          try { process.kill(activePid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
        }
        if (control) await fsp.rm(control.testRoot, { recursive: true, force: true })
      }
  }, 90_000)
})

describe('Task7 exact library test artifact packaging', () => {
  it('packages the actual Cargo-selected library harness through an asynchronous process and refuses decoys', async () => {
    const crate = path.join(fixtureRepoRoot, 'crates/freshell-supervisor')
    const source = path.join(crate, 'src/lib.rs')
    const executable = path.join(fixtureRepoRoot, 'target/debug/deps/freshell_supervisor-fixture')
    await fsp.mkdir(path.dirname(source), { recursive: true })
    await fsp.writeFile(source, '// controlled compiler source fixture\n')
    await fsp.mkdir(path.dirname(executable), { recursive: true })
    const invocation = path.join(fixtureRepoRoot, 'harness-invocation.json')
    await fsp.writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(invocation)},JSON.stringify(process.argv.slice(2)));process.stdout.write('loss_report::tests::task007_export_stopped_repair_fixture: test\\n\\n1 test, 0 benchmarks\\n')\n`, { mode: 0o700 })
    const harness = new owner.RuntimeHarness(fixtureRepoRoot, 'task007-packaging-unit', 3, { bootstrapProviders: [] })
    const artifact = { reason: 'compiler-artifact', package_id: `path+file://${crate}#0.1.0`,
      target: { name: 'freshell_supervisor', kind: ['lib'], src_path: source },
      profile: { test: true }, features: [], executable }
    const input = path.join(fixtureRepoRoot, 'compiler-messages.jsonl')
    const childScript = path.join(fixtureRepoRoot, 'compiler-fixture.cjs')
    const commandLog = path.join(fixtureRepoRoot, 'compiler-command.json')
    await fsp.writeFile(childScript, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(commandLog)},JSON.stringify(process.argv.slice(2)));setTimeout(()=>process.stdout.write(fs.readFileSync(${JSON.stringify(input)})),10)\n`)
    const execute: owner.Task007RunChild = (file, args, options) => new Promise((resolve, reject) => {
      const compiler = file.endsWith('/mise')
      execFile(compiler ? process.execPath : file, compiler ? [childScript, file, ...args] : args, options, (error, stdout, stderr) => {
        if (error) reject(error)
        else resolve({ stdout: String(stdout), stderr: String(stderr) })
      })
    })
    const messages = (records: unknown[]) => records.map(record => JSON.stringify(record)).join('\n') + '\n'
    const build = { reason: 'build-finished', success: true }
    const buildDir = path.join(fixtureRepoRoot, 'private-build')
    await fsp.writeFile(input, messages([{ ...artifact, target: { ...artifact.target, kind: ['bin'] }, profile: { test: false } }, artifact, build]))
    const packaged = await owner.prepareTask007LibTestArtifact({ repoRoot: fixtureRepoRoot, buildDir, candidateSha: harness.candidateSha }, execute)
    expect(await fsp.readFile(packaged.path)).toEqual(await fsp.readFile(executable))
    expect((await fsp.stat(packaged.path)).mode & 0o777).toBe(0o700)
    expect(packaged.candidateSha).toBe(harness.candidateSha)
    expect(JSON.parse(await fsp.readFile(invocation, 'utf8'))).toEqual(['--list', '--exact', 'loss_report::tests::task007_export_stopped_repair_fixture'])
    expect(JSON.parse(await fsp.readFile(commandLog, 'utf8'))).toEqual([
      path.join(os.homedir(), '.local/bin/mise'), 'exec', 'rust@1.96', '--', 'cargo', 'test',
      '-p', 'freshell-supervisor', '--lib', '--no-run', '--message-format=json',
    ])
    const invalid = [
      [build], [artifact, artifact, build], [artifact, { ...build, success: false }],
      [{ ...artifact, profile: { test: false } }, build],
      [{ ...artifact, target: { ...artifact.target, src_path: path.join(crate, 'src/main.rs') } }, build],
      [{ ...artifact, package_id: `path+file://${fixtureRepoRoot}/foreign#0.1.0` }, build],
    ]
    for (let index = 0; index < invalid.length; index++) {
      await fsp.writeFile(input, messages(invalid[index]))
      await expect(owner.prepareTask007LibTestArtifact({ repoRoot: fixtureRepoRoot,
        buildDir: path.join(fixtureRepoRoot, `rejected-build-${index}`), candidateSha: harness.candidateSha }, execute)).rejects.toThrow(/artifact|build/)
    }
  })
})

describe('Task7 asynchronous private fixture exporter', () => {
  it('keeps the real Unix broker responsive during child export and verifies private output custody', async () => {
    const root = fixtureRepoRoot
    const harness = new owner.RuntimeHarness(root, 'task007-export-unit', 3, { bootstrapProviders: [] })
    const imageRef = `sha256:${'a'.repeat(64)}`
    const host = path.join(root, 'pinned-host')
    await fsp.writeFile(host, 'controlled host artifact', { mode: 0o500 })
    const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
    const socket = path.join(root, 'daemon.sock')
    const broker = new RestrictedDockerBroker({ realSocketPath: socket, proxySocketPath: path.join(root, 'broker.sock'),
      runtimeRootPrefix: path.join(root, 'r'), allowedHostBinaryPaths: new Set([host]), allowedImageRefs: new Set([imageRef]),
      testRunId: harness.runId, logPath: path.join(root, 'broker.jsonl') })
    let requests = 0
    const upstream = http.createServer((_req, res) => { requests++; res.end('OK') })
    const target = (index: number) => ({ soulId: `soul-unit-${index}`, providerStoreId: `store-unit-${index}`, terminalId: `terminal-unit-${index}`, streamId: `stream-unit-${index}` })
    const view = (index: number) => ({ viewId: `view-unit-${index}`, ownerId: 'owner-unit', workspaceId: 'workspace-unit', tabId: `tab-unit-${index}`, paneId: `pane-unit-${index}` })
    const input: owner.Task007FixtureInput = { schemaVersion: 1, fixtureId: 'fixture-unit', runId: harness.runId,
      candidateSha: harness.candidateSha, installationId: 'installation-unit', ownerRoot: root,
      runtimeRoot: path.join(root, 'r/case/x'), workspacePath: root, cwd: root, gitCommonDir: null,
      imageRef, hostBinaryPath: host, hostBinarySha256: digest(await fsp.readFile(host)), dockerDaemonId: 'daemon-unit',
      brokerSocketPath: broker.proxySocketPath, source: { rootSessionIds: Array.from({ length: 7 }, (_, index) => `ses_unit_${index}`), unrelatedSessionId: 'ses_unrelated' },
      targets: Array.from({ length: 9 }, (_, index) => target(index)), canonicalChoices: [{ rootOrdinal: 0, targetOrdinal: 0 }, { rootOrdinal: 1, targetOrdinal: 8 }],
      explicitViews: [0, 1, 7, 8].map(index => ({ ...view(index), targetOrdinal: index })), unrelated: { ...view(9), target: target(9) } }
    const bytes = 'controlled checkpointed database bytes'
    const output: owner.Task007FixtureOutput = { schemaVersion: 1, evidenceKind: 'historical-fixture-setup', fixtureId: input.fixtureId,
      runId: input.runId, candidateSha: input.candidateSha, installationId: input.installationId, dockerDaemonId: input.dockerDaemonId,
      imageRef, hostBinarySha256: input.hostBinarySha256, workspacePath: root, runtimeRoot: input.runtimeRoot,
      registry: { file: 'runtime.sqlite3', schemaVersion: 7, sha256: digest(bytes) }, historicalControlEpoch: 1,
      targets: input.targets.map((item, index) => ({ soulId: item.soulId, providerStoreId: item.providerStoreId, rootSessionId: input.source.rootSessionIds[[0, 1, 2, 3, 4, 5, 6, 0, 1][index]],
        incarnationId: `incarnation-unit-${index}`, launchNonce: `launch-unit-${index}`, containerId: String(index + 1).repeat(64),
        providerVolumeName: `freshell-provider-${digest(input.installationId + '\0' + item.soulId).slice(0, 24)}`,
        runtimeDir: path.join(input.runtimeRoot, `incarnation-unit-${index}`), hostBinaryPath: host, immutableConfigDigest: `sha256:${'b'.repeat(64)}`,
        incidentId: `incident-unit-${index}`, expectedIntentRevision: 1, viewIds: input.explicitViews.filter(item => item.targetOrdinal === index).map(item => item.viewId) })),
      canonicalChoices: input.canonicalChoices.map(choice => ({ rootSessionId: input.source.rootSessionIds[choice.rootOrdinal], soulId: input.targets[choice.targetOrdinal].soulId, expectedIntentRevision: 1 })),
      unrelated: { soulId: input.unrelated.target.soulId, incidentId: 'incident-unrelated', viewId: input.unrelated.viewId, expectedIntentRevision: 1, noticeIds: ['notice-unrelated'], outboxEventIds: ['event-unrelated'], exports: [] } }
    const inputFile = path.join(root, 'input.json')
    const metadataControl = path.join(root, 'metadata-control.json')
    const calls = path.join(root, 'export-child-call.json')
    const executable = path.join(root, 'controlled-exporter.cjs')
    await fsp.writeFile(inputFile, JSON.stringify(input), { mode: 0o600 })
    await fsp.writeFile(metadataControl, JSON.stringify(output), { mode: 0o600 })
    await fsp.mkdir(input.runtimeRoot, { recursive: true })
    await fsp.writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs'),http=require('node:http'),path=require('node:path');fs.writeFileSync(${JSON.stringify(calls)},JSON.stringify({args:process.argv.slice(2),env:process.env}));const input=JSON.parse(fs.readFileSync(process.env.FRESHELL_TASK007_STOPPED_FIXTURE_INPUT_FILE));const request=http.request({socketPath:input.brokerSocketPath,path:'/_ping'},res=>{res.resume();res.on('end',()=>{const out=process.env.FRESHELL_TASK007_STOPPED_FIXTURE_OUTPUT_DIR;fs.writeFileSync(path.join(out,'runtime.sqlite3'),${JSON.stringify(bytes)},{mode:0o600});fs.writeFileSync(path.join(out,'metadata.json'),fs.readFileSync(${JSON.stringify(metadataControl)}),{mode:0o600});process.stdout.write('test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\\n')})});request.on('error',()=>process.exit(2));request.end();\n`, { mode: 0o700 })
    const artifact = { path: executable, sha256: digest(await fsp.readFile(executable)), candidateSha: harness.candidateSha,
      packageId: 'controlled-export-unit', features: [], sourcePath: path.join(root, 'controlled-source') }
    try {
      await new Promise<void>(resolve => upstream.listen(socket, resolve))
      await broker.start()
      vi.stubEnv('UNRELATED_OWNER_ENV', 'must-not-inherit')
      const outputDir = path.join(root, 'output')
      await fsp.mkdir(outputDir, { mode: 0o700 })
      const result = await owner.executeTask007FixtureExporter({ repoRoot: root, artifact, inputFile, outputDir })
      expect(result).toEqual(output)
      expect(requests).toBe(1)
      const child = JSON.parse(await fsp.readFile(calls, 'utf8'))
      expect(child.args).toEqual(['--exact', owner.TASK007_EXPORT_TEST, '--nocapture', '--test-threads=1'])
      expect(child.env).toEqual({ FRESHELL_TASK007_STOPPED_FIXTURE_INPUT_FILE: inputFile, FRESHELL_TASK007_STOPPED_FIXTURE_OUTPUT_DIR: outputDir })
      await fsp.writeFile(metadataControl, JSON.stringify({ ...output, candidateSha: 'f'.repeat(40) }))
      const invalidOutput = path.join(root, 'invalid-output')
      await fsp.mkdir(invalidOutput, { mode: 0o700 })
      await expect(owner.executeTask007FixtureExporter({ repoRoot: root, artifact, inputFile, outputDir: invalidOutput })).rejects.toThrow(/fixture.*bind|identity/)
    } finally {
      vi.unstubAllEnvs()
      await broker.close()
      await new Promise<void>(resolve => upstream.close(() => resolve()))
    }
  })
})

describe('Task7 empty provider HOME initialization', () => {
  it('joins an actual Created inspection to its receipt and starts only the fixed private helper', async () => {
    const directory = path.join(fixtureRepoRoot, 'home-initializer')
    await fsp.mkdir(directory, { mode: 0o700 })
    const calls = path.join(directory, 'calls.jsonl')
    const state = path.join(directory, 'state.json')
    const executable = path.join(directory, 'docker-control.cjs')
    const containerId = 'a'.repeat(64), imageRef = `sha256:${'b'.repeat(64)}`
    const receipt = { containerId, createdAt: 'controlled', requestDigest: 'controlled-request-only', incarnationId: 'incarnation-unit',
      soulId: 'soul-unit', imageRef, runtimeDir: path.join(fixtureRepoRoot, 'r/x/incarnation-unit'), providerVolumeName: `freshell-provider-${'c'.repeat(24)}`,
      workspacePath: fixtureRepoRoot, hostBinaryPath: path.join(fixtureRepoRoot, 'host') }
    const target: owner.Task007FixtureOutput['targets'][number] = { ...receipt, rootSessionId: 'ses_unit', providerStoreId: 'store-unit',
      providerVolumeName: receipt.providerVolumeName, hostBinaryPath: receipt.hostBinaryPath, launchNonce: 'nonce-unit',
      immutableConfigDigest: 'actual-config-only', incidentId: 'incident-unit', expectedIntentRevision: 1, viewIds: [] }
    const input = { runId: 'owned-home-unit', candidateSha: 'd'.repeat(40), imageRef, installationId: 'installation-unit' }
    const inspection = { Id: containerId, Image: imageRef, State: { Status: 'created', Running: false, Pid: 0 },
      Config: { Labels: { 'com.freshell.runtime-test-run-id': input.runId, 'com.freshell.soul-id': receipt.soulId,
        'com.freshell.incarnation-id': receipt.incarnationId, 'com.freshell.installation-id': input.installationId } },
      Mounts: [{ Type: 'volume', Name: receipt.providerVolumeName, Destination: '/home/freshell/provider', RW: true }] }
    await fsp.writeFile(state, JSON.stringify(inspection), { mode: 0o600 })
    await fsp.writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(args[0]==='inspect')process.stdout.write(JSON.stringify([JSON.parse(fs.readFileSync(${JSON.stringify(state)}))]));else if(args[0]==='ps')process.stdout.write('');else if(args[0]==='create')process.stdout.write('${'e'.repeat(64)}');else if(args[0]==='wait')process.stdout.write('0');else if(args[0]==='logs')process.stdout.write(JSON.stringify({kind:'historical-fixture-home-setup',uid:65534,gid:0,mode:448,priorEntries:0}));else if(!['start','rm'].includes(args[0]))process.exit(3);\n`, { mode: 0o700 })
    const execute: owner.Task007RunChild = (_file, args, options) => new Promise((resolve, reject) => {
      execFile(executable, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }))
    })
    const name = `freshell-task007-setup-${'01234567-89ab-4cde-8fab-0123456789ab'}`
    await expect(owner.initializeTask007ProviderHome({ input, target, receipt, name }, execute)).resolves.toMatchObject({ uid: 65534, gid: 0, mode: 448, priorEntries: 0 })
    const firstCalls = (await fsp.readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    const create = firstCalls.find(args => args[0] === 'create')!
    expect(create).toContain('--read-only')
    expect(create.slice(create.indexOf('--cap-add'), create.indexOf('--cap-add') + 2)).toEqual(['--cap-add', 'CHOWN'])
    expect(create).not.toContain('DAC_OVERRIDE')
    expect(create).toContain(`type=volume,source=${receipt.providerVolumeName},target=/home/freshell/provider,volume-nocopy`)
    expect(firstCalls.filter(args => args[0] === 'start')).toEqual([['start', 'e'.repeat(64)]])
    expect(firstCalls.at(-1)).toEqual(['rm', '--force', 'e'.repeat(64)])
    await fsp.writeFile(state, JSON.stringify({ ...inspection, State: { Status: 'running', Running: true, Pid: 7 } }))
    await expect(owner.initializeTask007ProviderHome({ input, target, receipt, name }, execute)).rejects.toThrow(/Created|never.started/)
    const finalCalls = (await fsp.readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(finalCalls.filter(args => args[0] === 'create')).toHaveLength(1)
    await fsp.writeFile(state, JSON.stringify({ ...inspection, Config: { Labels: { ...inspection.Config.Labels, 'com.freshell.installation-id': 'foreign-installation' } } }))
    await expect(owner.initializeTask007ProviderHome({ input, target, receipt, name }, execute)).rejects.toThrow(/ownership|Created/)
  })
})

describe('Task7 closed historical snapshot installation', () => {
  it('installs private schema-seven bytes before any ordinary opener and refuses current schema or active WAL', async () => {
    const sourceDir = path.join(fixtureRepoRoot, 'closed-snapshot')
    const registryRoot = path.join(fixtureRepoRoot, 'new-registry')
    await fsp.mkdir(sourceDir, { mode: 0o700 })
    await fsp.mkdir(registryRoot, { mode: 0o700 })
    const databaseFile = path.join(sourceDir, 'runtime.sqlite3')
    const db = new DatabaseSync(databaseFile)
    db.exec('CREATE TABLE installation(singleton INTEGER,schema_version INTEGER); INSERT INTO installation VALUES(1,7); CREATE TABLE souls(soul_id TEXT); CREATE TABLE incarnations(incarnation_id TEXT); CREATE TABLE loss_incidents(incident_id TEXT);')
    db.close()
    await fsp.chmod(databaseFile, 0o600)
    await fsp.writeFile(path.join(sourceDir, 'lifecycle.jsonl'), 'historical setup only\n', { mode: 0o600 })
    await fsp.writeFile(path.join(sourceDir, 'metadata.json'), '{"evidenceKind":"historical-fixture-setup"}', { mode: 0o600 })
    await fsp.mkdir(path.join(sourceDir, 'incidents'), { mode: 0o700 })
    await fsp.writeFile(path.join(sourceDir, 'incidents/incident-unit.json'), '{"historical":true}', { mode: 0o600 })
    const digest = () => createHash('sha256').update(fs.readFileSync(databaseFile)).digest('hex')
    await expect(owner.installTask007HistoricalSnapshot({ sourceDir, registryRoot, sha256: digest() })).resolves.toMatchObject({ schemaVersion: 7, sha256: digest() })
    expect(await fsp.readFile(path.join(registryRoot, 'runtime.sqlite3'))).toEqual(await fsp.readFile(databaseFile))
    expect((await fsp.stat(path.join(registryRoot, 'runtime.sqlite3'))).mode & 0o777).toBe(0o600)
    expect(await fsp.readFile(path.join(registryRoot, 'incidents/incident-unit.json'), 'utf8')).toBe('{"historical":true}')
    expect(await fsp.readFile(path.join(registryRoot, 'metadata.json'))).toEqual(await fsp.readFile(path.join(sourceDir, 'metadata.json')))
    expect(await fsp.readFile(path.join(sourceDir, 'incidents/incident-unit.json'), 'utf8')).toBe('{"historical":true}')
    await expect(owner.installTask007HistoricalSnapshot({ sourceDir, registryRoot, sha256: digest() })).rejects.toThrow(/nonempty|fresh/)
    const invalidRoot = path.join(fixtureRepoRoot, 'invalid-registry')
    await fsp.mkdir(invalidRoot, { mode: 0o700 })
    await fsp.writeFile(`${databaseFile}-wal`, 'uncheckpointed bytes', { mode: 0o600 })
    await expect(owner.installTask007HistoricalSnapshot({ sourceDir, registryRoot: invalidRoot, sha256: digest() })).rejects.toThrow(/WAL|checkpoint/)
    expect(await fsp.readdir(invalidRoot)).toEqual([])
    await fsp.rm(`${databaseFile}-wal`)
    const modified = new DatabaseSync(databaseFile)
    modified.exec('ALTER TABLE souls ADD COLUMN identity_revision INTEGER')
    modified.close()
    await expect(owner.installTask007HistoricalSnapshot({ sourceDir, registryRoot: invalidRoot, sha256: digest() })).rejects.toThrow(/schema.seven|post.7/)
    expect(await fsp.readdir(invalidRoot)).toEqual([])
  })
})

describe('Task7 registered physical stopped fixture preparation', () => {
  it('admits only the fixed batch SQLite graph reader through the owned helper boundary', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-batch-broker-'))
    const upstreamSocket = path.join(directory, 'upstream.sock'), proxySocket = path.join(directory, 'proxy.sock')
    const helperId = 'e'.repeat(64), image = `sha256:${'a'.repeat(64)}`, volume = `freshell-provider-${'b'.repeat(24)}`
    const upstream = http.createServer((_request, response) => { response.writeHead(201).end(JSON.stringify({ Id: helperId })) })
    const broker = new RestrictedDockerBroker({ realSocketPath: upstreamSocket, proxySocketPath: proxySocket,
      runtimeRootPrefix: directory, allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set([image]),
      allowedWorkspaceRoots: new Set([directory]), testRunId: 'owned-batch', logPath: path.join(directory, 'broker.jsonl') })
    vi.spyOn(broker, 'receipts').mockReturnValue([{ soulId: 'soul-batch', incarnationId: 'inc-batch', containerId: 'c'.repeat(64),
      imageRef: image, providerVolumeName: volume, workspacePath: directory, hostBinaryPath: '/owned/host',
      runtimeDir: directory, createdAt: 'controlled', requestDigest: 'controlled' }])
    const body = { Image: image, User: '65534:0', Tty: false, WorkingDir: directory, Entrypoint: ['node'],
      Cmd: ['--no-warnings', '-e', owner.TASK007_BATCH_STORE_PROBE, '/home/freshell/provider/.local/share/opencode/opencode.db', 'ses_owned_batch'],
      Env: ['HOME=/home/freshell/provider'], HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true,
        CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], Memory: 256 * 1024 * 1024, MemorySwap: 256 * 1024 * 1024,
        NanoCpus: 500_000_000, PidsLimit: 32, Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=16m' },
        Mounts: [{ Type: 'volume', Source: volume, Target: '/home/freshell/provider', ReadOnly: true },
          { Type: 'bind', Source: directory, Target: directory, ReadOnly: true }] } }
    try {
      await new Promise<void>(resolve => upstream.listen(upstreamSocket, resolve))
      await broker.start()
      const status = await new Promise<number>((resolve, reject) => {
        const request = http.request({ socketPath: proxySocket, method: 'POST',
          path: `/v1.47/containers/create?name=freshell-history-${randomUUID()}` }, response => {
          response.resume(); response.on('end', () => resolve(response.statusCode!))
        })
        request.on('error', reject); request.end(JSON.stringify(body))
      })
      expect(status).toBe(201)
      expect(broker.receiptIds()).toContain(helperId)
    } finally {
      await broker.close(); upstream.closeAllConnections()
      await new Promise<void>(resolve => upstream.close(() => resolve()))
      await fsp.rm(directory, { recursive: true, force: true }); vi.restoreAllMocks()
    }
  })

  async function browserFixture(rig: owner.ManagedRuntimeOwner): Promise<owner.Task007PreparedStoppedFixture> {
    vi.spyOn(rig.runtime, 'isContainerRunning').mockReturnValue(true)
    const root = rig.runtime.testRoot
    await fsp.mkdir(root, { recursive: true, mode: 0o700 })
    const sourceDatabaseFile = path.join(root, 'source.db')
    const source = owner.seedManagedOpenCodeSource({ repoRoot: fixtureRepoRoot, databasePath: sourceDatabaseFile,
      workspace: root, nonce: 'batch-browser-unit', batch: 'stopped-repair-seven-roots' })
    await fsp.chmod(sourceDatabaseFile, 0o600)
    await fsp.mkdir(path.dirname(rig.runtime.lifecyclePath), { recursive: true, mode: 0o700 })
    await fsp.writeFile(rig.runtime.lifecyclePath, '', { mode: 0o600 })
    const lifecycle = path.join(root, 'r/browser/evidence/lifecycle.jsonl')
    await fsp.mkdir(path.dirname(lifecycle), { recursive: true, mode: 0o700 })
    await fsp.writeFile(lifecycle, '', { mode: 0o600 })
    rig.runtime.broker = new RestrictedDockerBroker({ realSocketPath: '/controlled-unused', proxySocketPath: path.join(root, 'broker.sock'),
      runtimeRootPrefix: root, allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set(),
      testRunId: rig.runtime.runId, logPath: path.join(root, 'broker.jsonl') })
    const host = path.join(root, 'host')
    await fsp.writeFile(host, 'controlled registered host artifact', { mode: 0o550 })
    await fsp.chmod(host, 0o550)
    const target = (index: number) => ({ soulId: `soul-${index}`, providerStoreId: `store-${index}`, terminalId: `terminal-${index}`, streamId: `stream-${index}` })
    const view = { viewId: 'unrelated-view', ownerId: 'owner-unit', workspaceId: 'workspace-unit', tabId: 'tab-unit', paneId: 'pane-unit' }
    const input: owner.Task007FixtureInput = { schemaVersion: 1, fixtureId: 'fixture-browser-unit', runId: rig.runtime.runId,
      candidateSha: rig.runtime.candidateSha, installationId: 'installation-unit', ownerRoot: root, runtimeRoot: path.join(root, 'r/browser/x'),
      workspacePath: root, cwd: root, imageRef: `sha256:${'a'.repeat(64)}`, hostBinaryPath: host,
      hostBinarySha256: createHash('sha256').update(await fsp.readFile(host)).digest('hex'),
      dockerDaemonId: 'daemon-unit', brokerSocketPath: path.join(root, 'broker.sock'),
      source: { rootSessionIds: source.families.map(family => family.rootId), unrelatedSessionId: source.unrelatedId },
      targets: Array.from({ length: 9 }, (_, index) => target(index)), canonicalChoices: [{ rootOrdinal: 0, targetOrdinal: 0 }, { rootOrdinal: 1, targetOrdinal: 8 }],
      explicitViews: [0, 1, 7, 8].map(index => ({ ...view, viewId: `view-${index}`, targetOrdinal: index })),
      unrelated: { ...view, target: target(9) } }
    const output: owner.Task007FixtureOutput = { schemaVersion: 1, evidenceKind: 'historical-fixture-setup', fixtureId: input.fixtureId,
      runId: input.runId, candidateSha: input.candidateSha, installationId: input.installationId, dockerDaemonId: input.dockerDaemonId,
      imageRef: input.imageRef, hostBinarySha256: input.hostBinarySha256, workspacePath: root, runtimeRoot: input.runtimeRoot,
      registry: { file: 'runtime.sqlite3', schemaVersion: 7, sha256: 'c'.repeat(64) }, historicalControlEpoch: 1,
      targets: input.targets.map((item, index) => ({ soulId: item.soulId, providerStoreId: item.providerStoreId,
        rootSessionId: source.families[[0, 1, 2, 3, 4, 5, 6, 0, 1][index]].rootId,
        incarnationId: `incarnation-${index}`, launchNonce: `launch-${index}`, containerId: String(index + 1).repeat(64),
        providerVolumeName: `freshell-provider-${String(index).repeat(24)}`, runtimeDir: path.join(input.runtimeRoot, `incarnation-${index}`),
        hostBinaryPath: input.hostBinaryPath, immutableConfigDigest: `sha256:${'d'.repeat(64)}`,
        incidentId: `incident-${index}`, expectedIntentRevision: 1, viewIds: [] })),
      canonicalChoices: input.canonicalChoices.map(choice => ({ rootSessionId: source.families[choice.rootOrdinal].rootId,
        soulId: input.targets[choice.targetOrdinal].soulId, expectedIntentRevision: 1 })),
      unrelated: { soulId: 'soul-9', incidentId: 'incident-9', viewId: view.viewId, expectedIntentRevision: 1,
        noticeIds: ['notice-unrelated'], outboxEventIds: ['event-unrelated'], exports: [{ file: 'incidents/incident-9.closed.json', sha256: 'e'.repeat(64) }] } }
    const metadataFile = path.join(root, 'metadata.json')
    await fsp.writeFile(metadataFile, JSON.stringify(output), { mode: 0o600 })
    return { input, output, source, inputFile: path.join(root, 'input.json'), outputDir: root, metadataFile,
      sourceDatabaseFile, registryRoot: path.join(root, 'registry'), scenarioId: 'browser-managed-runtime', volumeName: 'registered-unit-volume' }
  }

  it('retains exact lost-ACK Registry reader ownership across failed inner and outer cleanup', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused cleanup-retry web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [] }, undefined, { bootstrapProviders: [] })
    const batch = await browserFixture(rig)
    vi.spyOn(rig.runtime, 'prepareTask007StoppedFixture').mockResolvedValue(batch)
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    const supervisor: owner.SupervisorInstance = { scenarioId: batch.scenarioId, containerId: 'a'.repeat(64), volumeName: batch.volumeName!,
      runtimeRoot: batch.input.runtimeRoot, controlSocket: '/controlled/socket', controlSecret: 'controlled-secret',
      controlSecretFile: '/controlled/secret', binaryKind: 'test' }
    const helperId = 'e'.repeat(64), foreignId = 'f'.repeat(64)
    const stateFile = path.join(batch.outputDir, 'cleanup-daemon.json'), calls = path.join(batch.outputDir, 'cleanup-calls.jsonl')
    const state = { containers: {
      [supervisor.containerId]: { Id: supervisor.containerId, Name: 'registered-supervisor' },
      [foreignId]: { Id: foreignId, Name: 'unrelated-sentinel' },
    }, volumes: [batch.volumeName!, 'unrelated-volume'], cleanupInspectFailed: false }
    await fsp.writeFile(stateFile, JSON.stringify(state), { mode: 0o600 })
    await fsp.writeFile(path.join(batch.outputDir, 'docker'), `#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2),file=${JSON.stringify(stateFile)},state=JSON.parse(fs.readFileSync(file));const save=()=>fs.writeFileSync(file,JSON.stringify(state));fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args[0]==='inspect'){
 const item=Object.values(state.containers).find(item=>item.Id===args.at(-1)||item.Name===args.at(-1));if(!item)process.exit(1);
 if(args.includes('--format'))process.stdout.write('false');else if(item.Id==='${helperId}'&&!state.cleanupInspectFailed){state.cleanupInspectFailed=true;save();process.exit(9)}else process.stdout.write(JSON.stringify([item]));
}else if(args[0]==='create'){
 const labels={};for(let i=0;i<args.length;i++)if(args[i]==='--label'){const [key,value]=args[++i].split('=');labels[key]=value}
 const mounts=[];for(let i=0;i<args.length;i++)if(args[i]==='--mount'){const parts=args[++i].split(','),values=Object.fromEntries(parts.map(part=>part.split('=')));mounts.push({Type:values.type,Name:values.type==='volume'?values.source:undefined,Source:values.source,Destination:values.target,RW:!parts.includes('readonly')})}
 state.containers['${helperId}']={Id:'${helperId}',Name:args[args.indexOf('--name')+1],Image:args[args.indexOf('--entrypoint')+2],Config:{Labels:labels},Mounts:mounts};save();process.stderr.write('controlled create ACK lost');process.exit(9);
}else if(args[0]==='rm'){
 if(args.at(-1)==='${foreignId}')process.exit(7);delete state.containers[args.at(-1)];save();
}else if(args[0]==='ps')process.stdout.write(Object.values(state.containers).map(item=>args.includes('--format')?item.Name:item.Id).join('\\n'));
else if(args[0]==='volume'){if(args[1]==='rm'){if(args[2]==='unrelated-volume')process.exit(7);state.volumes=state.volumes.filter(name=>name!==args[2]);save()}else process.stdout.write(state.volumes.join('\\n'))}else process.exit(8);\n`, { mode: 0o700 })
    try {
      await rig.prepareSyntheticStoppedRepairBatch(); rig.supervisor = supervisor
      Object.assign(rig.runtime, { imageRef: batch.input.imageRef, task007Fixtures: new Map([['browser', batch]]),
        trackedSupervisorContainers: new Set([supervisor.containerId]), trackedVolumes: new Set([batch.volumeName]) })
      vi.mocked(rig.runtime.isContainerRunning).mockRestore()
      vi.stubEnv('PATH', `${batch.outputDir}${path.delimiter}${process.env.PATH}`)
      await expect(rig.runtime.readTask007StoppedRegistry(supervisor, batch.input.fixtureId, 'repair-current')).rejects.toThrow(/owned cleanup failed/)
      expect(rig.runtime.transferOwnedIds().containers).not.toContain(helperId)
      const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      let current = readState()
      expect(current.cleanupInspectFailed).toBe(true)
      expect(current.containers[helperId]).toBeDefined()
      current.containers[helperId].Config.Labels['com.freshell.task007-supervisor-id'] = foreignId
      await fsp.writeFile(stateFile, JSON.stringify(current))
      const refused = await rig.runtime.cleanup()
      expect(refused.ok).toBe(false)
      expect(refused.errors.some(error => error.includes('ownership is unknown'))).toBe(true)
      current = readState()
      expect(current.containers[supervisor.containerId]).toBeUndefined()
      expect(current.containers[helperId]).toBeDefined(); expect(current.containers[foreignId]).toBeDefined()
      current.containers[helperId].Config.Labels['com.freshell.task007-supervisor-id'] = supervisor.containerId
      await fsp.writeFile(stateFile, JSON.stringify(current))
      await expect(rig.runtime.cleanup()).resolves.toEqual({ ok: true, errors: [] })
      current = readState()
      expect(Object.keys(current.containers)).toEqual([foreignId]); expect(current.volumes).toEqual(['unrelated-volume'])
      const actual = (await fsp.readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
      expect(actual.filter(args => args[0] === 'rm')).toEqual([['rm', '-f', supervisor.containerId], ['rm', '--force', helperId]])
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fsp.rm(rig.runtime.testRoot, { recursive: true, force: true }) }
  })

  it('starts only the exact registered historical host copy and refuses changed artifact bytes', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused copied-host web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [] }, undefined, { bootstrapProviders: [] })
    const batch = await browserFixture(rig)
    const directory = path.join(fixtureRepoRoot, 'host-launch-control')
    await fsp.mkdir(directory)
    await fsp.mkdir(rig.runtime.buildDir, { recursive: true, mode: 0o700 })
    const calls = path.join(directory, 'calls.jsonl')
    await fsp.writeFile(path.join(directory, 'docker'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');process.stdout.write('${'a'.repeat(64)}');\n`, { mode: 0o700 })
    Object.assign(rig.runtime, { task007Fixtures: new Map([['browser', batch]]) })
    rig.runtime.imageRef = batch.input.imageRef
    rig.runtime.testSupervisorBinary = '/controlled-supervisor'
    rig.runtime.broker = new RestrictedDockerBroker({ realSocketPath: '/controlled-unused', proxySocketPath: batch.input.brokerSocketPath,
      runtimeRootPrefix: batch.input.ownerRoot, allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set(),
      testRunId: rig.runtime.runId, logPath: path.join(directory, 'broker.jsonl') })
    vi.stubEnv('PATH', `${directory}${path.delimiter}${process.env.PATH}`)
    try {
      await rig.runtime.startSupervisor({ scenarioId: batch.scenarioId, volumeName: batch.volumeName,
        hostBinaryPath: batch.input.hostBinaryPath, waitForHealth: false })
      const launches = (await fsp.readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
      const last = launches.at(-1)!
      expect(last[last.indexOf('--image-ref') + 1]).toBe(batch.input.imageRef)
      expect(launches.at(-1)).toContain(batch.input.hostBinaryPath)
      await fsp.chmod(batch.input.hostBinaryPath, 0o750)
      await fsp.writeFile(batch.input.hostBinaryPath, 'changed artifact')
      await fsp.chmod(batch.input.hostBinaryPath, 0o550)
      await expect(rig.runtime.startSupervisor({ scenarioId: batch.scenarioId, volumeName: batch.volumeName,
        hostBinaryPath: batch.input.hostBinaryPath, waitForHealth: false })).rejects.toThrow(/changed|digest/)
      expect((await fsp.readFile(calls, 'utf8')).trim().split('\n')).toHaveLength(2)
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fsp.rm(rig.runtime.testRoot, { recursive: true, force: true }) }
  })

  it('keeps registered original baselines across fault replacements without reinstalling historical state', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused batch web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [] }, undefined, { bootstrapProviders: [] })
    const batch = await browserFixture(rig)
    const preparation = vi.spyOn(rig.runtime, 'prepareTask007StoppedFixture').mockResolvedValue(batch)
    vi.spyOn(rig.runtime, 'waitForSupervisorHealth').mockResolvedValue({})
    const ordinary = vi.spyOn(rig.runtime, 'prepare')
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    const previous: owner.SupervisorInstance = { scenarioId: batch.scenarioId, containerId: 'a'.repeat(64), volumeName: batch.volumeName!,
      runtimeRoot: batch.input.runtimeRoot, controlSocket: '/controlled/socket', controlSecret: 'controlled-secret',
      controlSecretFile: '/controlled/secret', binaryKind: 'test' }
    const stop = vi.spyOn(rig.runtime, 'stopSupervisorExact').mockImplementation(() => undefined)
    vi.spyOn(rig.runtime, 'removeContainerExact').mockImplementation(() => undefined)
    const launch = vi.spyOn(rig.runtime, 'startSupervisor').mockResolvedValue({ ...previous, containerId: 'b'.repeat(64) })
    vi.spyOn(rig, 'controlEpoch').mockResolvedValue(12)
    try {
      const original = await rig.prepareSyntheticStoppedRepairBatch()
      expect(original).toMatchObject({ sourceStoreId: createHash('sha256')
        .update(await fsp.realpath(batch.sourceDatabaseFile)).digest('hex') })
      const sourceDb = new DatabaseSync(batch.sourceDatabaseFile)
      sourceDb.prepare('UPDATE session SET title = ? WHERE id = ?').run('changed source content', batch.source.families[0].rootId)
      sourceDb.close()
      expect(await rig.syntheticStoppedRepairBatchFacts()).toEqual(original)
      expect(original.families[0].baselineMessages).toEqual(Object.fromEntries(batch.source.families[0].baselineMessages))
      expect(JSON.stringify(original)).not.toContain(batch.sourceDatabaseFile)
      await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'after_import_publication')).resolves.toEqual({ controlEpoch: null })
      rig.supervisor = previous
      await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'first_resume_observation')).resolves.toEqual({ controlEpoch: 12 })
      expect(launch.mock.calls.at(-1)?.[0]).toMatchObject({ volumeName: previous.volumeName, hostBinaryPath: batch.input.hostBinaryPath,
        env: { FRESHELL_RUNTIME_STOPPED_REPAIR_RESUME_OBSERVATION_FAIL: '1' } })
      await rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'none')
      expect(launch.mock.calls.at(-1)?.[0].env).toEqual({ OPENCODE_DB: batch.sourceDatabaseFile })
      await expect(rig.prepareSyntheticStoppedRepairBatch()).resolves.toEqual(original)
      expect(preparation).toHaveBeenCalledOnce()
      expect(ordinary).not.toHaveBeenCalled()
      await expect(rig.setSyntheticStoppedRepairFault('foreign-fixture', 'none')).rejects.toThrow(/registered/)
      expect(stop).toHaveBeenCalledTimes(2)
    } finally { vi.unstubAllEnvs(); await fsp.rm(rig.runtime.testRoot, { recursive: true, force: true }) }
  })

  it.each((['failed', 'malformed', 'stop-unconfirmed'] as const).flatMap(mode =>
    (['activation', 'restoration'] as const).map(stage => ({ mode, stage }))))(
    'refuses unknown $mode supervisor state before registered-store $stage', async ({ mode, stage }) => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused inspection web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [] }, undefined, { bootstrapProviders: [] })
    const batch = await browserFixture(rig)
    const db = new DatabaseSync(batch.sourceDatabaseFile)
    db.exec('PRAGMA journal_mode = DELETE'); db.close()
    vi.spyOn(rig.runtime, 'prepareTask007StoppedFixture').mockResolvedValue(batch)
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    const previous: owner.SupervisorInstance = { scenarioId: batch.scenarioId, containerId: 'a'.repeat(64), volumeName: batch.volumeName!,
      runtimeRoot: batch.input.runtimeRoot, controlSocket: '/controlled/socket', controlSecret: 'controlled-secret',
      controlSecretFile: '/controlled/secret', binaryKind: 'test' }
    const launch = vi.spyOn(rig.runtime, 'startSupervisor').mockResolvedValue(previous)
    const remove = vi.spyOn(rig.runtime, 'removeContainerExact').mockImplementation(() => undefined)
    vi.spyOn(rig.runtime, 'waitForSupervisorHealth').mockResolvedValue({})
    vi.spyOn(rig, 'controlEpoch').mockResolvedValue(12)
    const state = path.join(batch.outputDir, 'inspect-mode'), calls = path.join(batch.outputDir, 'inspect-calls.jsonl')
    await fsp.writeFile(state, 'stopped')
    await fsp.writeFile(path.join(batch.outputDir, 'docker'), `#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2),mode=fs.readFileSync(${JSON.stringify(state)},'utf8');fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(args[0]==='inspect'){if(mode==='failed')process.exit(9);process.stdout.write(mode==='malformed'?'unknown':mode==='stop-unconfirmed'?'true':'false')}else if(args[0]!=='stop')process.exit(8);\n`, { mode: 0o700 })
    try {
      await rig.prepareSyntheticStoppedRepairBatch(); rig.supervisor = previous
      Object.assign(rig.runtime, { imageRef: batch.input.imageRef, task007Fixtures: new Map([['browser', batch]]),
        trackedSupervisorContainers: new Set([previous.containerId]), trackedVolumes: new Set([batch.volumeName]) })
      vi.mocked(rig.runtime.isContainerRunning).mockRestore()
      vi.stubEnv('PATH', `${batch.outputDir}${path.delimiter}${process.env.PATH}`)
      const original = await fsp.readFile(batch.sourceDatabaseFile)
      if (stage === 'restoration') {
        await rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'source_generation_change')
        expect(await fsp.readFile(batch.sourceDatabaseFile)).not.toEqual(original)
        launch.mockClear(); remove.mockClear()
      }
      const beforeRefusal = await fsp.readFile(batch.sourceDatabaseFile)
      await fsp.writeFile(state, mode)
      if (stage === 'activation' && mode !== 'stop-unconfirmed') {
        await expect(rig.runtime.readTask007StoppedRegistry(previous, batch.input.fixtureId, 'repair-current')).rejects.toThrow(/inspection|state/)
        await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).rejects.toThrow(/inspection|state/)
      }
      await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId,
        stage === 'activation' ? 'source_generation_change' : 'none')).rejects.toThrow(/inspection|state|stopped/)
      expect(await fsp.readFile(batch.sourceDatabaseFile)).toEqual(beforeRefusal)
      if (stage === 'activation') expect(beforeRefusal).toEqual(original)
      expect(launch).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled()
      expect((await fsp.readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line)[0])).not.toContain('create')
      if (stage === 'restoration') {
        await fsp.writeFile(state, 'stopped')
        await rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'none')
        expect(await fsp.readFile(batch.sourceDatabaseFile)).toEqual(original)
      }
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fsp.rm(rig.runtime.testRoot, { recursive: true, force: true }) }
  })

  // A completed read-only SQLite consumer leaves the empty WAL and SHM pair
  // seen by the stopped runbook. Do not fabricate their bytes or kill a reader.
  function readSourceSessions(databaseFile: string): { id: string; title: string }[] {
    return JSON.parse(execFileSync(process.execPath, ['--no-warnings', '-e', `
      const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(process.argv[1],{readOnly:true});
      try { process.stdout.write(JSON.stringify(db.prepare('SELECT id,title FROM session ORDER BY id').all())) }
      finally { db.close() }
    `, databaseFile], { encoding: 'utf8', timeout: 10_000 }))
  }

  it('settles quiesced SQLite WAL sidecars before changing and restoring the registered fictional source', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused source sidecar web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [] }, undefined, { bootstrapProviders: [] })
    const batch = await browserFixture(rig)
    vi.spyOn(rig.runtime, 'prepareTask007StoppedFixture').mockResolvedValue(batch)
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    const previous: owner.SupervisorInstance = { scenarioId: batch.scenarioId, containerId: 'a'.repeat(64), volumeName: batch.volumeName!,
      runtimeRoot: batch.input.runtimeRoot, controlSocket: '/controlled/socket', controlSecret: 'controlled-secret',
      controlSecretFile: '/controlled/secret', binaryKind: 'test' }
    vi.spyOn(rig.runtime, 'stopSupervisorExact').mockImplementation(() => undefined)
    vi.spyOn(rig.runtime, 'removeContainerExact').mockImplementation(() => undefined)
    vi.spyOn(rig.runtime, 'waitForSupervisorHealth').mockResolvedValue({})
    const launch = vi.spyOn(rig.runtime, 'startSupervisor').mockResolvedValue(previous)
    vi.spyOn(rig, 'controlEpoch').mockResolvedValue(12)
    const readSource = () => readSourceSessions(batch.sourceDatabaseFile)
    const sidecars = () => ['-wal', '-shm'].map(suffix => fs.lstatSync(`${batch.sourceDatabaseFile}${suffix}`))
    try {
      await rig.prepareSyntheticStoppedRepairBatch(); rig.supervisor = previous
      const original = await fsp.readFile(batch.sourceDatabaseFile)
      const originalRows = readSource()
      expect(sidecars().map(info => info.size)).toEqual([0, 32_768])
      expect(sidecars().every(info => info.isFile() && info.uid === process.getuid?.() && info.nlink === 1
        && (info.mode & 0o777) === 0o600)).toBe(true)
      await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'source_generation_change')).resolves.toEqual({ controlEpoch: 12 })
      const changed = await fsp.readFile(batch.sourceDatabaseFile)
      expect(createHash('sha256').update(changed).digest('hex')).not.toEqual(createHash('sha256').update(original).digest('hex'))
      for (const suffix of ['-wal', '-shm', '-journal']) expect(fs.existsSync(`${batch.sourceDatabaseFile}${suffix}`)).toBe(false)
      expect(readSource()).toEqual(originalRows.map(row => row.id === batch.source.families[0].rootId
        ? { ...row, title: `${row.title} [fictional stopped-repair generation fault]` } : row))
      expect(sidecars().map(info => info.size)).toEqual([0, 32_768])
      await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'none')).resolves.toEqual({ controlEpoch: 12 })
      expect((await fsp.readFile(batch.sourceDatabaseFile)).equals(original)).toBe(true)
      for (const suffix of ['-wal', '-shm', '-journal']) expect(fs.existsSync(`${batch.sourceDatabaseFile}${suffix}`)).toBe(false)
      expect(readSource()).toEqual(originalRows)
      expect(launch).toHaveBeenCalledTimes(2)
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fsp.rm(rig.runtime.testRoot, { recursive: true, force: true }) }
  })

  it.each(['active-writer', 'shared-sidecar', 'public-sidecar'] as const)(
    'refuses source fault settlement with a real WAL pair and %s', async mode => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused unsafe source web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [] }, undefined, { bootstrapProviders: [] })
    const batch = await browserFixture(rig)
    vi.spyOn(rig.runtime, 'prepareTask007StoppedFixture').mockResolvedValue(batch)
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    const previous: owner.SupervisorInstance = { scenarioId: batch.scenarioId, containerId: 'a'.repeat(64), volumeName: batch.volumeName!,
      runtimeRoot: batch.input.runtimeRoot, controlSocket: '/controlled/socket', controlSecret: 'controlled-secret',
      controlSecretFile: '/controlled/secret', binaryKind: 'test' }
    vi.spyOn(rig.runtime, 'stopSupervisorExact').mockImplementation(() => undefined)
    const launch = vi.spyOn(rig.runtime, 'startSupervisor')
    let writer: InstanceType<typeof DatabaseSync> | undefined
    try {
      await rig.prepareSyntheticStoppedRepairBatch(); rig.supervisor = previous
      const original = await fsp.readFile(batch.sourceDatabaseFile)
      if (mode === 'active-writer') {
        writer = new DatabaseSync(batch.sourceDatabaseFile)
        writer.exec('BEGIN IMMEDIATE')
      } else {
        readSourceSessions(batch.sourceDatabaseFile)
        if (mode === 'shared-sidecar') await fsp.link(`${batch.sourceDatabaseFile}-shm`, path.join(batch.outputDir, 'unrelated-shm'))
        else await fsp.chmod(`${batch.sourceDatabaseFile}-shm`, 0o644)
      }
      expect(fs.statSync(`${batch.sourceDatabaseFile}-wal`).size).toBe(0)
      expect(fs.statSync(`${batch.sourceDatabaseFile}-shm`).size).toBe(32_768)
      const wal = await fsp.readFile(`${batch.sourceDatabaseFile}-wal`)
      const shm = await fsp.readFile(`${batch.sourceDatabaseFile}-shm`)
      await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'source_generation_change'))
        .rejects.toThrow(mode === 'active-writer' ? /locked/ : /sidecar/)
      expect((await fsp.readFile(batch.sourceDatabaseFile)).equals(original)).toBe(true)
      expect((await fsp.readFile(`${batch.sourceDatabaseFile}-wal`)).equals(wal)).toBe(true)
      expect((await fsp.readFile(`${batch.sourceDatabaseFile}-shm`)).equals(shm)).toBe(true)
      expect(launch).not.toHaveBeenCalled()
    } finally {
      if (writer) { writer.exec('ROLLBACK'); writer.close() }
      vi.restoreAllMocks(); vi.unstubAllEnvs(); await fsp.rm(rig.runtime.testRoot, { recursive: true, force: true })
    }
  })

  it('changes only the registered fictional source generation and restores its exact original bytes', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused fault web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [] }, undefined, { bootstrapProviders: [] })
    const batch = await browserFixture(rig)
    vi.spyOn(rig.runtime, 'prepareTask007StoppedFixture').mockResolvedValue(batch)
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    const previous: owner.SupervisorInstance = { scenarioId: batch.scenarioId, containerId: 'a'.repeat(64), volumeName: batch.volumeName!,
      runtimeRoot: batch.input.runtimeRoot, controlSocket: '/controlled/socket', controlSecret: 'controlled-secret',
      controlSecretFile: '/controlled/secret', binaryKind: 'test' }
    let stopped = false
    vi.spyOn(rig.runtime, 'waitForSupervisorHealth').mockResolvedValue({})
    vi.spyOn(rig.runtime, 'stopSupervisorExact').mockImplementation(() => { stopped = true })
    vi.spyOn(rig.runtime, 'removeContainerExact').mockImplementation(() => undefined)
    const closedSource = new DatabaseSync(batch.sourceDatabaseFile)
    closedSource.exec('PRAGMA journal_mode = DELETE'); closedSource.close()
    const originalBytes = await fsp.readFile(batch.sourceDatabaseFile)
    const title = () => {
      const db = new DatabaseSync(batch.sourceDatabaseFile, { readOnly: true })
      try { return db.prepare('SELECT title FROM session WHERE id = ?').get(batch.source.families[0].rootId)?.title }
      finally { db.close() }
    }
    const originalTitle = title()
    const launch = vi.spyOn(rig.runtime, 'startSupervisor').mockImplementation(async options => {
      expect(stopped).toBe(true)
      expect(options).toMatchObject({ scenarioId: previous.scenarioId, volumeName: previous.volumeName, reuseSecret: true })
      stopped = false
      return { ...previous }
    })
    vi.spyOn(rig, 'controlEpoch').mockResolvedValue(12)
    try {
      const facts = await rig.prepareSyntheticStoppedRepairBatch()
      rig.supervisor = previous
      for (const suffix of ['-wal', '-shm', '-journal']) {
        await fsp.writeFile(`${batch.sourceDatabaseFile}${suffix}`, 'controlled unsettled sidecar')
        await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'source_generation_change')).rejects.toThrow(/sidecar/)
        expect((await fsp.readFile(batch.sourceDatabaseFile)).equals(originalBytes)).toBe(true)
        await fsp.unlink(`${batch.sourceDatabaseFile}${suffix}`)
      }
      await fsp.symlink(path.join(batch.outputDir, 'unregistered-sidecar'), `${batch.sourceDatabaseFile}-wal`)
      await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'source_generation_change')).rejects.toThrow(/sidecar/)
      expect((await fsp.readFile(batch.sourceDatabaseFile)).equals(originalBytes)).toBe(true)
      await fsp.unlink(`${batch.sourceDatabaseFile}-wal`)
      const sourceAlias = path.join(batch.outputDir, 'unrelated-source-alias.db')
      await fsp.link(batch.sourceDatabaseFile, sourceAlias)
      await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'source_generation_change')).rejects.toThrow(/custody/)
      expect((await fsp.readFile(sourceAlias)).equals(originalBytes)).toBe(true)
      await fsp.unlink(sourceAlias)
      await fsp.appendFile(batch.sourceDatabaseFile, 'unexpected source bytes')
      await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'source_generation_change')).rejects.toThrow(/unexpectedly/)
      expect((await fsp.readFile(batch.sourceDatabaseFile)).equals(originalBytes)).toBe(false)
      await fsp.writeFile(batch.sourceDatabaseFile, originalBytes)
      await rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'source_generation_change')
      expect(title()).not.toEqual(originalTitle)
      expect((await fsp.readFile(batch.sourceDatabaseFile)).equals(originalBytes)).toBe(false)
      const mutated = await fsp.readFile(batch.sourceDatabaseFile)
      await rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'source_generation_change')
      expect((await fsp.readFile(batch.sourceDatabaseFile)).equals(mutated)).toBe(true)
      await fsp.appendFile(batch.sourceDatabaseFile, 'unexpected changes during fault')
      await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'none')).rejects.toThrow(/unexpectedly/)
      expect((await fsp.readFile(batch.sourceDatabaseFile)).equals(originalBytes)).toBe(false)
      await fsp.writeFile(batch.sourceDatabaseFile, mutated)
      await rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'none')
      expect((await fsp.readFile(batch.sourceDatabaseFile)).equals(originalBytes)).toBe(true)
      expect(title()).toEqual(originalTitle)
      expect(await rig.syntheticStoppedRepairBatchFacts()).toEqual(facts)
      await rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'none')
      expect((await fsp.readFile(batch.sourceDatabaseFile)).equals(originalBytes)).toBe(true)
      expect(launch).toHaveBeenCalledTimes(4)
      await rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'source_generation_change')
      const sync = fs.fsyncSync
      let failDirectorySync = true
      const directorySync = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
        if (failDirectorySync && fs.fstatSync(fd).isDirectory()) throw new Error('controlled restoration directory sync failure')
        sync(fd)
      })
      try {
        await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'none')).rejects.toThrow(/directory sync failure/)
        expect((await fsp.readFile(batch.sourceDatabaseFile)).equals(originalBytes)).toBe(true)
        failDirectorySync = false
        await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'none')).resolves.toEqual({ controlEpoch: 12 })
        expect((await fsp.readFile(batch.sourceDatabaseFile)).equals(originalBytes)).toBe(true)
      } finally { directorySync.mockRestore() }
      await expect(rig.setSyntheticStoppedRepairFault('foreign-fixture', 'source_generation_change')).rejects.toThrow(/registered/)
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fsp.rm(rig.runtime.testRoot, { recursive: true, force: true }) }
  })

  it('refuses fictional source mutation until its actual tracked probe child settles', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused source probe web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [] }, undefined, { bootstrapProviders: [] })
    const batch = await browserFixture(rig)
    vi.spyOn(rig.runtime, 'prepareTask007StoppedFixture').mockResolvedValue(batch)
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    const original = await fsp.readFile(batch.sourceDatabaseFile)
    const pidFile = path.join(batch.outputDir, 'controlled-probe.pid'), release = path.join(batch.outputDir, 'release-probe')
    await fsp.writeFile(path.join(batch.outputDir, 'docker'), `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.stdout.write('settled')}},10);\n`, { mode: 0o700 })
    rig.runtime.broker = new RestrictedDockerBroker({ realSocketPath: '/controlled-unused', proxySocketPath: batch.input.brokerSocketPath,
      runtimeRootPrefix: batch.input.ownerRoot, allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set(),
      testRunId: rig.runtime.runId, logPath: path.join(batch.outputDir, 'broker.jsonl') })
    vi.spyOn(rig.runtime.broker, 'receiptIds').mockReturnValue(new Set(['a'.repeat(64)]))
    vi.spyOn(rig.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    vi.stubEnv('PATH', `${batch.outputDir}${path.delimiter}${process.env.PATH}`)
    let probe: Promise<string> | undefined, pid: number | undefined
    try {
      await rig.prepareSyntheticStoppedRepairBatch()
      probe = rig.ownedProviderExec('a'.repeat(64), ['node', '--version'])
      await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true))
      pid = Number(await fsp.readFile(pidFile, 'utf8'))
      await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'source_generation_change')).rejects.toThrow(/consumers.*settled/)
      expect((await fsp.readFile(batch.sourceDatabaseFile)).equals(original)).toBe(true)
    } finally {
      await fsp.writeFile(release, 'release exact controlled child')
      if (probe) await expect(probe).resolves.toBe('settled')
      if (pid) expect(fs.existsSync(`/proc/${pid}`)).toBe(false)
      vi.restoreAllMocks(); vi.unstubAllEnvs(); await fsp.rm(rig.runtime.testRoot, { recursive: true, force: true })
    }
  })

  it.each((['supervisor', 'web'] as const).flatMap(service =>
    (['activation', 'restoration'] as const).map(stage => ({ service, stage }))))(
    'settles both source consumers after failed $service $stage and retries the same services', async ({ service: failedService, stage }) => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused fault web factory') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [] }, undefined, { bootstrapProviders: [] })
    const batch = await browserFixture(rig)
    const db = new DatabaseSync(batch.sourceDatabaseFile)
    db.exec('PRAGMA journal_mode = DELETE'); db.close()
    const original = await fsp.readFile(batch.sourceDatabaseFile)
    vi.spyOn(rig.runtime, 'prepareTask007StoppedFixture').mockResolvedValue(batch)
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    const previous: owner.SupervisorInstance = { scenarioId: batch.scenarioId, containerId: 'a'.repeat(64), volumeName: batch.volumeName!,
      runtimeRoot: batch.input.runtimeRoot, controlSocket: '/controlled/socket', controlSecret: 'controlled-secret',
      controlSecretFile: '/controlled/secret', binaryKind: 'test' }
    let webRunning = true, supervisorRunning = true, fail = stage === 'activation'
    vi.spyOn(rig.runtime, 'waitForSupervisorHealth').mockResolvedValue({})
    const stop = vi.spyOn(rig.runtime, 'stopSupervisorExact').mockImplementation(() => { supervisorRunning = false })
    const remove = vi.spyOn(rig.runtime, 'removeContainerExact').mockImplementation(() => undefined)
    vi.spyOn(rig.runtime, 'startSupervisor').mockImplementation(async options => {
      expect(webRunning).toBe(false)
      expect(supervisorRunning).toBe(false)
      expect(options).toMatchObject({ volumeName: previous.volumeName, reuseSecret: true, scenarioId: previous.scenarioId })
      if (fail && failedService === 'supervisor') throw new Error('controlled supervisor start failure')
      supervisorRunning = true
      return { ...previous, containerId: 'b'.repeat(64) }
    })
    const info: owner.RuntimeWebInfo = { port: 3499, baseUrl: 'http://127.0.0.1:3499', wsUrl: 'ws://127.0.0.1:3499/ws',
      token: 'controlled-unchanged-token', configDir: batch.outputDir, homeDir: batch.outputDir, logsDir: batch.outputDir,
      debugLogPath: path.join(batch.outputDir, 'debug.log'), pid: 101, runtimeRoot: batch.input.runtimeRoot }
    const webStop = vi.fn(async () => { webRunning = false })
    const webStart = vi.fn(async () => {
      expect(supervisorRunning).toBe(true)
      webRunning = true
      if (fail && failedService === 'web') throw new Error('controlled web start failure')
      return { ...info, pid: 102 }
    })
    const web: owner.RuntimeWebHandle = { info, start: webStart, stop: webStop, restart: webStart, restartAbrupt: webStart,
      kill: webStop, capturedOutput: () => ({ stdout: '', stderr: '' }), processEvidence: () => ({ pid: 101, bootAttemptCount: 1 }),
      ownedChildPids: () => [] }
    vi.spyOn(rig, 'controlEpoch').mockResolvedValue(12)
    try {
      await rig.prepareSyntheticStoppedRepairBatch(); rig.supervisor = previous; rig.web = web; rig.info = info
      if (stage === 'restoration') {
        await rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'source_generation_change')
        fail = true
      }
      const removedBefore = remove.mock.calls.length
      await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId,
        stage === 'activation' ? 'source_generation_change' : 'none')).rejects.toThrow(/start failure/)
      expect((await fsp.readFile(batch.sourceDatabaseFile)).equals(original)).toBe(stage === 'restoration')
      expect(webRunning).toBe(false)
      expect(supervisorRunning).toBe(false)
      if (failedService === 'supervisor') expect(remove).toHaveBeenCalledTimes(removedBefore)
      fail = false
      await rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'none')
      expect((await fsp.readFile(batch.sourceDatabaseFile)).equals(original)).toBe(true)
      expect(webRunning && supervisorRunning).toBe(true)
      expect(rig.info).toEqual({ ...info, pid: 102 })
      expect(stop).toHaveBeenCalled()
      expect(webStop).toHaveBeenCalled()
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fsp.rm(rig.runtime.testRoot, { recursive: true, force: true }) }
  })

  it('retains a fault replacement address before failed health and propagates ordinary health failure', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused fault-health web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [] }, undefined, { bootstrapProviders: [] })
    const batch = await browserFixture(rig)
    vi.spyOn(rig.runtime, 'prepareTask007StoppedFixture').mockResolvedValue(batch)
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    const previous: owner.SupervisorInstance = { scenarioId: batch.scenarioId, containerId: 'a'.repeat(64), volumeName: batch.volumeName!,
      runtimeRoot: batch.input.runtimeRoot, controlSocket: '/controlled/socket', controlSecret: 'controlled-secret',
      controlSecretFile: '/controlled/secret', binaryKind: 'test' }
    const replacement = { ...previous, containerId: 'b'.repeat(64) }
    const stop = vi.spyOn(rig.runtime, 'stopSupervisorExact').mockImplementation(() => undefined)
    vi.spyOn(rig.runtime, 'removeContainerExact').mockImplementation(() => undefined)
    const health = vi.spyOn(rig.runtime, 'waitForSupervisorHealth').mockRejectedValue(new Error('controlled exited before health'))
    const launch = vi.spyOn(rig.runtime, 'startSupervisor').mockImplementation(async options => {
      expect(options).toMatchObject({ volumeName: previous.volumeName, reuseSecret: true })
      if (options.waitForHealth !== false) await rig.runtime.waitForSupervisorHealth(replacement)
      return replacement
    })
    vi.spyOn(rig, 'controlEpoch').mockResolvedValue(12)
    try {
      await rig.prepareSyntheticStoppedRepairBatch(); rig.supervisor = previous
      await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'during_withdrawal_before_ack')).rejects.toThrow(/before health/)
      expect(rig.supervisor.containerId).toBe(replacement.containerId)
      expect(health).toHaveBeenCalledExactlyOnceWith(replacement)
      health.mockResolvedValue({})
      await rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'none')
      expect(stop).toHaveBeenLastCalledWith(replacement, true)
      expect(launch.mock.calls[1][0]).toMatchObject({ volumeName: previous.volumeName, waitForHealth: false })
      health.mockRejectedValue(new Error('ordinary health failure'))
      await expect(rig.restartSupervisor()).rejects.toThrow(/ordinary health failure/)
      expect(launch.mock.calls[2][0].waitForHealth).toBeUndefined()
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fsp.rm(rig.runtime.testRoot, { recursive: true, force: true }) }
  })

  it('refuses a symlinked withdrawal parent without writing into its unrelated target', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused obstruction web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [] }, undefined, { bootstrapProviders: [] })
    const batch = await browserFixture(rig)
    vi.spyOn(rig.runtime, 'prepareTask007StoppedFixture').mockResolvedValue(batch)
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    const parent = path.join(path.dirname(batch.input.runtimeRoot), 'evidence')
    const savedParent = `${parent}.controlled-original`, foreign = path.join(fixtureRepoRoot, 'unrelated-obstruction-target')
    try {
      await rig.prepareSyntheticStoppedRepairBatch()
      await fsp.rename(parent, savedParent); await fsp.mkdir(foreign)
      await fsp.symlink(foreign, parent)
      await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'pending_withdrawal')).rejects.toThrow(/custody/)
      expect(await fsp.readdir(foreign)).toEqual([])
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fsp.rm(rig.runtime.testRoot, { recursive: true, force: true }) }
  })

  it.each(['write', 'fsync', 'close'] as const)(
    'retains exclusively created obstruction custody after activation $0 failure until exact none cleanup', async stage => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused activation-failure web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [] }, undefined, { bootstrapProviders: [] })
    const batch = await browserFixture(rig)
    vi.spyOn(rig.runtime, 'prepareTask007StoppedFixture').mockResolvedValue(batch)
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    vi.spyOn(rig.runtime, 'stopSupervisorExact').mockImplementation(() => undefined)
    vi.spyOn(rig.runtime, 'removeContainerExact').mockImplementation(() => undefined)
    vi.spyOn(rig.runtime, 'waitForSupervisorHealth').mockResolvedValue({})
    vi.spyOn(rig, 'controlEpoch').mockResolvedValue(12)
    const obstruction = path.join(path.dirname(batch.input.runtimeRoot), 'evidence/lifecycle.jsonl.1')
    const supervisor: owner.SupervisorInstance = { scenarioId: batch.scenarioId, containerId: 'a'.repeat(64), volumeName: batch.volumeName!,
      runtimeRoot: batch.input.runtimeRoot, controlSocket: '/controlled/socket', controlSecret: 'controlled-secret',
      controlSecretFile: '/controlled/secret', binaryKind: 'test' }
    vi.spyOn(rig.runtime, 'startSupervisor').mockResolvedValue(supervisor)
    const unrelated = path.join(path.dirname(obstruction), 'lifecycle.jsonl.2')
    let failed = false, descriptor: number | undefined
    const matches = (fd: unknown): fd is number => typeof fd === 'number' && fs.existsSync(obstruction)
      && fs.fstatSync(fd).ino === fs.lstatSync(obstruction).ino
    try {
      await rig.prepareSyntheticStoppedRepairBatch(); rig.supervisor = supervisor
      await fsp.writeFile(unrelated, 'unrelated rotation bytes', { mode: 0o600 })
      const write = fs.writeFileSync, sync = fs.fsyncSync, close = fs.closeSync
      const writeFailure = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
        if (matches(file)) descriptor = file
        if (stage === 'write' && !failed && matches(file)) {
          failed = true; descriptor = file; write(file, Buffer.from(data as Uint8Array).subarray(0, 7))
          throw new Error('controlled activation write failure')
        }
        write(file, data, options)
      })
      const syncFailure = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
        if (stage === 'fsync' && !failed && matches(fd)) {
          failed = true; descriptor = fd; throw new Error('controlled activation fsync failure')
        }
        sync(fd)
      })
      const closeFailure = vi.spyOn(fs, 'closeSync').mockImplementation(fd => {
        const fail = stage === 'close' && !failed && fd === descriptor
        close(fd)
        if (fail) { failed = true; descriptor = fd; throw new Error('controlled activation close failure') }
      })
      try {
        await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'pending_withdrawal')).rejects.toThrow(/controlled activation/)
      } finally { writeFailure.mockRestore(); syncFailure.mockRestore(); closeFailure.mockRestore() }
      expect(failed).toBe(true)
      expect(() => fs.fstatSync(descriptor!)).toThrow()
      const ownedBytes = await fsp.readFile(obstruction)
      expect(ownedBytes.length).toBeGreaterThan(0)
      await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'pending_withdrawal')).rejects.toThrow(/completion.*removal/)
      const held = `${obstruction}.held-owned`
      await fsp.rename(obstruction, held)
      await fsp.writeFile(obstruction, ownedBytes, { mode: 0o600 })
      await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'none')).rejects.toThrow(/changed|owned/)
      expect(await fsp.readFile(obstruction)).toEqual(ownedBytes)
      await fsp.unlink(obstruction); await fsp.rename(held, obstruction)
      await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'none')).resolves.toEqual({ controlEpoch: 12 })
      await expect(fsp.stat(obstruction)).rejects.toHaveProperty('code', 'ENOENT')
      expect(await fsp.readFile(unrelated, 'utf8')).toBe('unrelated rotation bytes')
      await rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'pending_withdrawal')
      await rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'none')
      await expect(fsp.stat(obstruction)).rejects.toHaveProperty('code', 'ENOENT')
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fsp.rm(rig.runtime.testRoot, { recursive: true, force: true }) }
  })

  it('owns only the actual exporter rotation obstruction and clears only its recorded bytes', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused obstruction web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [] }, undefined, { bootstrapProviders: [] })
    const batch = await browserFixture(rig)
    vi.spyOn(rig.runtime, 'waitForSupervisorHealth').mockResolvedValue({})
    vi.spyOn(rig.runtime, 'prepareTask007StoppedFixture').mockResolvedValue(batch)
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    const previous: owner.SupervisorInstance = { scenarioId: batch.scenarioId, containerId: 'a'.repeat(64), volumeName: batch.volumeName!,
      runtimeRoot: batch.input.runtimeRoot, controlSocket: '/controlled/socket', controlSecret: 'controlled-secret',
      controlSecretFile: '/controlled/secret', binaryKind: 'test' }
    vi.spyOn(rig.runtime, 'stopSupervisorExact').mockImplementation(() => undefined)
    vi.spyOn(rig.runtime, 'removeContainerExact').mockImplementation(() => undefined)
    const launch = vi.spyOn(rig.runtime, 'startSupervisor').mockResolvedValue(previous)
    vi.spyOn(rig, 'controlEpoch').mockResolvedValue(12)
    const obstruction = path.join(path.dirname(previous.runtimeRoot), 'evidence/lifecycle.jsonl.1')
    try {
      await rig.prepareSyntheticStoppedRepairBatch(); rig.supervisor = previous
      await fsp.mkdir(path.dirname(obstruction), { recursive: true, mode: 0o700 })
      const unrelated = path.join(path.dirname(obstruction), 'lifecycle.jsonl.2')
      await fsp.writeFile(unrelated, '{"event":"unrelated"}\n', { mode: 0o600 })
      await fsp.writeFile(obstruction, 'foreign pre-existing bytes', { mode: 0o600 })
      await rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'none')
      expect(await fsp.readFile(obstruction, 'utf8')).toBe('foreign pre-existing bytes')
      await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'pending_withdrawal')).rejects.toThrow(/exist|owned/)
      expect(await fsp.readFile(obstruction, 'utf8')).toBe('foreign pre-existing bytes')
      await fsp.unlink(obstruction)
      await rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'pending_withdrawal')
      const owned = await fsp.readFile(obstruction)
      expect(() => JSON.parse(owned.toString())).toThrow()
      expect((await fsp.stat(obstruction)).mode & 0o777).toBe(0o600)
      await rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'pending_withdrawal')
      expect((await fsp.readFile(obstruction)).equals(owned)).toBe(true)
      await fsp.writeFile(obstruction, 'unexpected changed bytes')
      await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'none')).rejects.toThrow(/changed|owned/)
      expect(await fsp.readFile(obstruction, 'utf8')).toBe('unexpected changed bytes')
      await fsp.writeFile(obstruction, owned)
      const heldOwned = `${obstruction}.held-owned`
      await fsp.rename(obstruction, heldOwned)
      await fsp.writeFile(obstruction, owned, { mode: 0o600 })
      await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'none')).rejects.toThrow(/changed|owned/)
      expect((await fsp.readFile(obstruction)).equals(owned)).toBe(true)
      await fsp.unlink(obstruction); await fsp.rename(heldOwned, obstruction)
      await fsp.chmod(obstruction, 0o644)
      await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'none')).rejects.toThrow(/changed|owned/)
      await fsp.chmod(obstruction, 0o600)
      await rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'none')
      await expect(fsp.stat(obstruction)).rejects.toHaveProperty('code', 'ENOENT')
      await rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'pending_withdrawal')
      const sync = fs.fsyncSync
      let failDirectorySync = true
      const directorySync = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
        if (failDirectorySync && fs.fstatSync(fd).isDirectory()) throw new Error('controlled obstruction directory sync failure')
        sync(fd)
      })
      try {
        await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'none')).rejects.toThrow(/directory sync failure/)
        await expect(fsp.stat(obstruction)).rejects.toHaveProperty('code', 'ENOENT')
        failDirectorySync = false
        await fsp.writeFile(obstruction, 'new foreign obstruction', { mode: 0o600 })
        await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'none')).rejects.toThrow(/changed|owned/)
        expect(await fsp.readFile(obstruction, 'utf8')).toBe('new foreign obstruction')
        await fsp.unlink(obstruction)
        await expect(rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'none')).resolves.toEqual({ controlEpoch: 12 })
      } finally { directorySync.mockRestore() }
      expect(await fsp.readFile(unrelated, 'utf8')).toBe('{"event":"unrelated"}\n')
      expect(launch.mock.calls.every(([options]) => options.volumeName === previous.volumeName)).toBe(true)
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fsp.rm(rig.runtime.testRoot, { recursive: true, force: true }) }
  })

  it.each((['provider', 'helper'] as const).flatMap(kind =>
    (['lost', 'incomplete'] as const).map(outcome => ({ kind, outcome }))))(
    'refuses zero activity after an owned $kind start reaches upstream with $outcome response', async ({ kind, outcome }) => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused start-outcome web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [] }, undefined, { bootstrapProviders: [] })
    const batch = await browserFixture(rig), target = batch.output.targets[0], helperId = 'e'.repeat(64)
    vi.spyOn(rig.runtime, 'prepareTask007StoppedFixture').mockResolvedValue(batch)
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    const upstreamSocket = path.join(batch.outputDir, 'upstream.sock'), received: string[] = []
    const upstream = http.createServer((request, response) => {
      request.resume(); request.on('end', () => {
        received.push(request.url!)
        if (request.url!.endsWith('/start')) {
          if (outcome === 'incomplete') {
            response.writeHead(200, { 'content-length': '20' }); response.write('partial')
            setImmediate(() => response.destroy())
          } else response.destroy()
        } else response.writeHead(201).end(JSON.stringify({ Id: helperId }))
      })
    })
    const broker = new RestrictedDockerBroker({ realSocketPath: upstreamSocket, proxySocketPath: batch.input.brokerSocketPath,
      runtimeRootPrefix: batch.input.ownerRoot, allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set([batch.input.imageRef]),
      allowedWorkspaceRoots: new Set([batch.input.workspacePath]), testRunId: rig.runtime.runId, logPath: path.join(batch.outputDir, 'broker.jsonl') })
    const receipt = { ...target, imageRef: batch.input.imageRef, workspacePath: batch.input.workspacePath,
      createdAt: 'controlled', requestDigest: 'f'.repeat(64) }
    Object.assign(broker, { receiptsById: new Map([[target.containerId, receipt]]), knownContainerIds: new Set([target.containerId]) })
    rig.runtime.broker = broker
    const request = (url: string, body?: unknown) => new Promise<number>((resolve, reject) => {
      const client = http.request({ socketPath: broker.proxySocketPath, method: 'POST', path: url }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode!)); response.on('error', reject)
      })
      client.on('error', reject); client.end(body === undefined ? undefined : JSON.stringify(body))
    })
    try {
      await new Promise<void>(resolve => upstream.listen(upstreamSocket, resolve)); await broker.start()
      if (kind === 'helper') {
        const body = { Image: batch.input.imageRef, User: '65534:0', Tty: false, WorkingDir: batch.input.workspacePath, Entrypoint: ['node'],
          Cmd: ['--no-warnings', '-e', owner.TASK007_BATCH_STORE_PROBE, '/home/freshell/provider/.local/share/opencode/opencode.db', target.rootSessionId],
          Env: ['HOME=/home/freshell/provider'], HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true,
            CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], Memory: 256 * 1024 * 1024, MemorySwap: 256 * 1024 * 1024,
            NanoCpus: 500_000_000, PidsLimit: 32, Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=16m' },
            Mounts: [{ Type: 'volume', Source: target.providerVolumeName, Target: '/home/freshell/provider', ReadOnly: true },
              { Type: 'bind', Source: batch.input.workspacePath, Target: batch.input.workspacePath, ReadOnly: true }] } }
        expect(await request(`/v1.47/containers/create?name=freshell-history-${randomUUID()}`, body)).toBe(201)
      }
      expect(await rig.prepareSyntheticStoppedRepairBatch()).toHaveProperty('activity.providerContainerStartRequests', 0)
      const refusedUrl = `/v1.47/containers/${'f'.repeat(64)}/start`
      expect(await request(refusedUrl)).toBe(403)
      expect(received).not.toContain(refusedUrl)
      expect((await rig.syntheticStoppedRepairBatchFacts()).activity).toMatchObject({ helperStartRequests: 0, providerContainerStartRequests: 0 })
      const url = `/v1.47/containers/${kind === 'helper' ? helperId : target.containerId}/start`
      await expect(request(url)).rejects.toThrow()
      await broker.awaitPendingRequests()
      expect(received).toContain(url)
      expect(broker.eventsSnapshot()).toContainEqual(expect.objectContaining({ method: 'POST', url, reason: 'owner_request_failed' }))
      expect(broker.eventsSnapshot()).toContainEqual(expect.objectContaining({ method: 'POST', url,
        reason: outcome === 'lost' ? 'upstream_request_failed' : 'upstream_response_incomplete' }))
      await expect(rig.syntheticStoppedRepairBatchFacts()).rejects.toThrow(/start.*outcome|activity.*unknown/)
      const events = broker.eventsSnapshot()
      const observedEvents = vi.spyOn(broker, 'eventsSnapshot')
      for (const reason of ['owner_request_failed', outcome === 'lost' ? 'upstream_request_failed' : 'upstream_response_incomplete']) {
        observedEvents.mockReturnValue(events.filter(event => event.reason === undefined || event.reason === reason || event.url === refusedUrl))
        await expect(rig.syntheticStoppedRepairBatchFacts()).rejects.toThrow(/start.*outcome|activity.*unknown/)
      }
    } finally {
      await broker.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()))
      vi.restoreAllMocks(); vi.unstubAllEnvs(); await fsp.rm(rig.runtime.testRoot, { recursive: true, force: true })
    }
  })

  it.each(['history', 'opencode-repair'] as const)(
    'counts an admitted %s helper start produced by the real broker only for the registered batch', async (family) => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused helper-family web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [] }, undefined, { bootstrapProviders: [] })
    const batch = await browserFixture(rig), target = batch.output.targets[0]
    vi.spyOn(rig.runtime, 'prepareTask007StoppedFixture').mockResolvedValue(batch)
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    const helperId = 'e'.repeat(64), foreignHelperId = 'd'.repeat(64)
    const foreign = { ...target, soulId: 'foreign-soul', containerId: 'f'.repeat(64),
      providerVolumeName: `freshell-provider-${'f'.repeat(24)}` }
    const upstreamSocket = path.join(batch.outputDir, 'upstream.sock'), received: string[] = []
    const helperName = `freshell-${family}-${randomUUID()}`, foreignName = `freshell-${family}-${randomUUID()}`
    const upstream = http.createServer((request, response) => {
      request.resume(); request.on('end', () => {
        received.push(request.url!)
        if (request.url!.includes('/create?')) {
          const name = new URL(request.url!, 'http://docker').searchParams.get('name')
          response.writeHead(201).end(JSON.stringify({ Id: name === helperName ? helperId : foreignHelperId }))
        } else response.writeHead(204).end()
      })
    })
    const broker = new RestrictedDockerBroker({ realSocketPath: upstreamSocket, proxySocketPath: batch.input.brokerSocketPath,
      runtimeRootPrefix: batch.input.ownerRoot, allowedHostBinaryPaths: new Set([batch.input.hostBinaryPath]),
      allowedImageRefs: new Set([batch.input.imageRef]), allowedWorkspaceRoots: new Set([batch.input.workspacePath]),
      testRunId: rig.runtime.runId, logPath: path.join(batch.outputDir, 'broker.jsonl') })
    const receipts = [target, foreign].map(item => ({ ...item, imageRef: batch.input.imageRef,
      workspacePath: batch.input.workspacePath, createdAt: 'controlled', requestDigest: 'f'.repeat(64) }))
    Object.assign(broker, { receiptsById: new Map(receipts.map(receipt => [receipt.containerId, receipt])),
      knownContainerIds: new Set(receipts.map(receipt => receipt.containerId)) })
    rig.runtime.broker = broker
    const helperBody = (receipt: typeof target) => ({
      Image: batch.input.imageRef, User: family === 'history' ? '65534:0' : '0:0', Tty: family === 'history',
      WorkingDir: batch.input.workspacePath, Entrypoint: ['/runtime/freshell-session-host'],
      Cmd: family === 'history'
        ? ['native-history-only', '--provider', 'opencode', '--session-id', receipt.rootSessionId, '--provider-home', '/home/freshell/provider']
        : ['opencode-stopped-repair-worker', '--stage-dir', '/run/freshell-opencode-transfer',
          '--workspace-root', batch.input.workspacePath, '--expected-cwd', batch.input.cwd, '--provider-uid', '65534', '--provider-gid', '0'],
      Env: family === 'history' ? ['HOME=/home/freshell/provider'] : ['HOME=/home/freshell/provider',
        'XDG_DATA_HOME=/home/freshell/provider/.local/share', 'XDG_CONFIG_HOME=/home/freshell/provider/.config',
        'OPENCODE_DB=/home/freshell/provider/.local/share/opencode/opencode.db'],
      HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'],
        CapAdd: family === 'history' ? [] : ['SETUID', 'SETGID'], SecurityOpt: ['no-new-privileges'],
        Memory: 256 * 1024 * 1024, MemorySwap: 256 * 1024 * 1024, NanoCpus: 500_000_000, PidsLimit: 32,
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=16m' }, Mounts: [
          { Type: 'bind', Source: batch.input.hostBinaryPath, Target: '/runtime/freshell-session-host', ReadOnly: true },
          { Type: 'volume', Source: receipt.providerVolumeName, Target: '/home/freshell/provider', ReadOnly: family === 'history' },
          ...(family === 'history' ? [] : [
            { Type: 'bind', Source: path.join(path.dirname(receipt.runtimeDir), 'opencode-transfers', `stopped-repair-${'a'.repeat(48)}.ready`),
              Target: '/run/freshell-opencode-transfer', ReadOnly: true },
            { Type: 'bind', Source: batch.input.workspacePath, Target: batch.input.workspacePath, ReadOnly: true },
          ]),
        ] },
    })
    const request = (url: string, body?: unknown) => new Promise<number>((resolve, reject) => {
      const client = http.request({ socketPath: broker.proxySocketPath, method: 'POST', path: url }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode!)); response.on('error', reject)
      })
      client.on('error', reject); client.end(body === undefined ? undefined : JSON.stringify(body))
    })
    try {
      await new Promise<void>(resolve => upstream.listen(upstreamSocket, resolve)); await broker.start()
      expect((await rig.prepareSyntheticStoppedRepairBatch()).activity).toEqual({ setupHelpersCompleted: 0,
        helperStartRequests: 0, providerContainerStartRequests: 0, providerLaunchRunningEvents: 0 })
      const refusedUrl = `/v1.47/containers/${'b'.repeat(64)}/start`
      expect(await request(refusedUrl)).toBe(403)
      expect(received).not.toContain(refusedUrl)
      expect(await request(`/v1.47/containers/create?name=${helperName}`, helperBody(target))).toBe(201)
      const startUrl = `/v1.47/containers/${helperId}/start`
      expect(await request(startUrl)).toBe(204)
      expect(received).toContain(startUrl)
      expect(broker.eventsSnapshot()).toContainEqual(expect.objectContaining({ method: 'POST', url: startUrl,
        decision: 'forward', helperName, containerId: helperId, ownerContainerId: target.containerId }))
      expect((await rig.syntheticStoppedRepairBatchFacts()).activity).toEqual({ setupHelpersCompleted: 0,
        helperStartRequests: 1, providerContainerStartRequests: 0, providerLaunchRunningEvents: 0 })
      expect(await request(`/v1.47/containers/create?name=${foreignName}`, helperBody(foreign)),
        JSON.stringify(broker.eventsSnapshot())).toBe(201)
      expect(await request(`/v1.47/containers/${foreignHelperId}/start`)).toBe(204)
      expect((await rig.syntheticStoppedRepairBatchFacts()).activity.helperStartRequests).toBe(1)
      expect(await broker.awaitPendingRequests()).toEqual([])
    } finally {
      await broker.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()))
      vi.restoreAllMocks(); vi.unstubAllEnvs(); await fsp.rm(rig.runtime.testRoot, { recursive: true, force: true })
    }
  })

  it('measures registered setup completion and forwarded helper/provider requests separately from launch events', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused activity web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [] }, undefined, { bootstrapProviders: [] })
    const batch = await browserFixture(rig)
    vi.spyOn(rig.runtime, 'prepareTask007StoppedFixture').mockResolvedValue(batch)
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    rig.runtime.broker = new RestrictedDockerBroker({ realSocketPath: '/controlled-unused', proxySocketPath: batch.input.brokerSocketPath,
      runtimeRootPrefix: batch.input.ownerRoot, allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set(),
      testRunId: rig.runtime.runId, logPath: path.join(batch.outputDir, 'broker.jsonl') })
    const target = batch.output.targets[0], helperId = 'e'.repeat(64)
    vi.spyOn(rig.runtime.broker, 'receipts').mockReturnValue([{ ...target, imageRef: batch.input.imageRef,
      runtimeDir: target.runtimeDir, createdAt: 'controlled', requestDigest: 'f'.repeat(64) }])
    const event = { at: 'controlled', severity: 'info' as const, method: 'POST', decision: 'forward' as const, destructive: true, unsafeAttempt: false }
    vi.spyOn(rig.runtime.broker, 'eventsSnapshot').mockReturnValue([
      { ...event, url: `/v1.47/containers/${helperId}/start`, containerId: helperId, helperName: 'freshell-history-controlled', ownerContainerId: target.containerId },
      { ...event, url: `/v1.47/containers/${target.containerId}/start`, containerId: target.containerId },
      { ...event, decision: 'block', url: `/v1.47/containers/${target.containerId}/start`, containerId: target.containerId },
      { ...event, url: `/v1.47/containers/${'f'.repeat(64)}/start`, containerId: 'f'.repeat(64), helperName: 'freshell-history-foreign', ownerContainerId: 'f'.repeat(64) },
    ])
    await fsp.mkdir(path.dirname(rig.runtime.lifecyclePath), { recursive: true })
    await fsp.writeFile(rig.runtime.lifecyclePath, JSON.stringify({ event: 'task007.provider_home.initialized', data: {
      fixtureId: batch.input.fixtureId, ownerContainerId: target.containerId } }) + '\n')
    try {
      const facts = await rig.prepareSyntheticStoppedRepairBatch()
      expect(facts).toHaveProperty('activity', { setupHelpersCompleted: 1, helperStartRequests: 1,
        providerContainerStartRequests: 1, providerLaunchRunningEvents: 0 })
      rig.supervisor = { scenarioId: batch.scenarioId, volumeName: batch.volumeName!, containerId: 'c'.repeat(64),
        runtimeRoot: batch.input.runtimeRoot, controlSocket: '/controlled/socket', controlSecret: 'controlled', controlSecretFile: '/controlled/secret', binaryKind: 'test' }
      const lifecycle = path.join(path.dirname(batch.input.runtimeRoot), 'evidence/lifecycle.jsonl')
      await fsp.mkdir(path.dirname(lifecycle), { recursive: true })
      await fsp.writeFile(lifecycle, JSON.stringify({ event: 'supervisor.launch_running', data: { soulId: target.soulId } }) + '\n')
      expect(await rig.syntheticStoppedRepairBatchFacts()).toHaveProperty('activity.providerLaunchRunningEvents', 1)
      await fsp.writeFile(lifecycle, 'malformed owned observation\n')
      await expect(rig.syntheticStoppedRepairBatchFacts()).rejects.toThrow()
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fsp.rm(rig.runtime.testRoot, { recursive: true, force: true }) }
  })

  it.each(['running', 'blocked stopped', 'stopped readonly WAL', 'retained failed Retry'] as const)(
    'projects actual current repair SQLite records for %s and refuses absent or foreign operations', async (attempt) => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused batch reader web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [] }, undefined, { bootstrapProviders: [] })
    const batch = await browserFixture(rig)
    vi.spyOn(rig.runtime, 'prepareTask007StoppedFixture').mockResolvedValue(batch)
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    const hostRuntimeDir = path.join(batch.outputDir, 'current-host')
    let hostServer: net.Server | undefined
    let hostStatus: owner.ManagedOpenCodeAdoptionStatus
    try {
      const facts = await rig.prepareSyntheticStoppedRepairBatch()
      await fsp.mkdir(batch.registryRoot)
      const database = path.join(batch.registryRoot, 'runtime.sqlite3')
      const db = new DatabaseSync(database)
      db.exec(`CREATE TABLE installation(singleton INTEGER,control_epoch INTEGER); INSERT INTO installation VALUES(1,12);
        CREATE TABLE stopped_repair_operations(operation_id TEXT,status TEXT,targets_json TEXT,scope_json TEXT,owner_choices_json TEXT);
        CREATE TABLE stopped_repair_withdrawals(operation_id TEXT,status TEXT);
        CREATE TABLE stopped_repair_root_receipts(operation_id TEXT,root_session_id TEXT,canonical_soul_id TEXT,source_generation TEXT,transfer_id TEXT,import_receipt_json TEXT,readable_receipt_json TEXT,source_store_id TEXT,identity_revision INTEGER,intent_revision INTEGER,native_import_revision INTEGER);
        CREATE TABLE souls(soul_id TEXT,provider_store_id TEXT,native_session_id TEXT,desired_state TEXT,recovery_state TEXT,identity_revision INTEGER,intent_revision INTEGER,native_import_revision INTEGER);
        CREATE TABLE writer_claims(soul_id TEXT,provider TEXT,provider_store_id TEXT,native_session_id TEXT,incarnation_id TEXT,intent_revision INTEGER);
        CREATE TABLE incarnations(soul_id TEXT,incarnation_id TEXT,launch_nonce TEXT,container_id TEXT,host_boot_id TEXT,launch_state TEXT,execution_generation INTEGER,created_at INTEGER);
        CREATE TABLE loss_incidents(incident_id TEXT);
        CREATE TABLE view_intents(view_id TEXT);CREATE TABLE runtime_notices(notice_id TEXT);CREATE TABLE outbox(event_id TEXT);`)
      const targets = batch.output.targets.map(target => ({ soulId: target.soulId, incidentId: target.incidentId,
        expectedIntentRevision: target.expectedIntentRevision }))
      const scope = { scopeId: 'd'.repeat(64), sourceStoreId: facts.sourceStoreId, sourceFingerprint: 'e'.repeat(64),
        targets: batch.output.targets.map((target, index) => ({ target: targets[index], providerStoreId: target.providerStoreId,
          rootSessionId: target.rootSessionId, incidentRevision: 1, identityRevision: 1, nativeImportRevision: 1, evidenceRevision: 1 })),
        roots: batch.source.families.map(family => { const eligibleOwners = batch.output.targets.filter(target => target.rootSessionId === family.rootId).map(target => target.soulId)
          return { rootSessionId: family.rootId, graphDigest: 'generation-current', eligibleOwners,
            canonicalSoulId: eligibleOwners.length === 1 ? eligibleOwners[0] : null } }) }
      // Production scopes use a SHA256 generation, independently of the selection ID.
      scope.roots.forEach(root => { root.graphDigest = 'f'.repeat(64) })
      const insertOperation = db.prepare('INSERT INTO stopped_repair_operations VALUES(?,?,?,?,?)')
      insertOperation.run('repair-current', 'complete', JSON.stringify(targets), JSON.stringify(scope), JSON.stringify(batch.output.canonicalChoices))
      insertOperation.run('repair-foreign', 'complete', '[]', JSON.stringify(scope), JSON.stringify(batch.output.canonicalChoices))
      db.prepare('INSERT INTO stopped_repair_withdrawals VALUES(?,?)').run('repair-current', 'files_complete')
      for (const target of batch.output.targets) db.prepare('INSERT INTO souls VALUES(?,?,?,?,?,?,?,?)').run(target.soulId, target.providerStoreId, target.rootSessionId, 'stopped', 'data_repair_complete', 2, 1, 2)
      db.prepare('INSERT INTO loss_incidents VALUES(?)').run('incident-9')
      db.prepare('INSERT INTO view_intents VALUES(?)').run(batch.output.unrelated.viewId)
      db.prepare('INSERT INTO runtime_notices VALUES(?)').run('notice-unrelated')
      db.prepare('INSERT INTO outbox VALUES(?)').run('event-unrelated')
      const root = batch.output.targets[0]
      db.prepare('INSERT INTO stopped_repair_root_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('repair-current', root.rootSessionId, root.soulId,
        'f'.repeat(64), 'transfer-current', JSON.stringify({ adoption_baseline: { manifestSha256: 'f'.repeat(64) } }),
        JSON.stringify({ destinationStoreId: root.providerStoreId, rowCount: 318, assetCount: 0, structuralSha256: 'a'.repeat(64),
          providerUid: 65534, providerGid: 0, readerEnvironmentSha256: 'b'.repeat(64) }), facts.sourceStoreId, 1, 1, 1)
      db.close()
      await fsp.mkdir(path.join(batch.registryRoot, 'incidents'))
      await fsp.writeFile(path.join(batch.registryRoot, 'incidents/incident-9.closed.json'), 'unchanged unrelated artifact')
      await fsp.mkdir(path.join(batch.outputDir, 'incidents'))
      await fsp.writeFile(path.join(batch.outputDir, 'incidents/incident-9.closed.json'), 'historical backup must not masquerade as current registry exports')
      rig.supervisor = { scenarioId: batch.scenarioId, volumeName: batch.volumeName!, containerId: 'c'.repeat(64),
        runtimeRoot: batch.input.runtimeRoot, controlSocket: '/controlled/socket', controlSecret: 'controlled', controlSecretFile: '/controlled/secret', binaryKind: 'test' }
      vi.spyOn(Object.getPrototypeOf(rig), 'ownedDockerProbe').mockImplementation(async (_container: string, args: string[]) => new Promise<string>((resolve, reject) => {
        if (args[0] === 'node') {
          execFile(process.execPath, ['--no-warnings', '-e', args[3],
            path.join(sourceRoot, 'test/e2e-browser/fixtures/managed-opencode-host-status.cjs'), hostRuntimeDir, args[6], args[7]],
          { encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout))
          return
        }
        expect(args.slice(0, 3)).toEqual(['python3', '-I', '-c'])
        const exports = args[7] === '/var/lib/freshell-supervisor' ? batch.registryRoot : args[7]
        execFile('python3', [args[1], args[2], args[3], database, args[5], args[6], exports, args[8]], { encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout))
      }))
      rig.runtime.imageRef = batch.input.imageRef
      rig.runtime.broker = new RestrictedDockerBroker({ realSocketPath: '/controlled-unused', proxySocketPath: batch.input.brokerSocketPath,
        runtimeRootPrefix: batch.input.ownerRoot, allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set(),
        testRunId: rig.runtime.runId, logPath: path.join(batch.input.ownerRoot, 'broker.jsonl') })
      vi.spyOn(rig.runtime.broker, 'receipts').mockReturnValue([{ soulId: root.soulId, incarnationId: root.incarnationId,
        containerId: root.containerId, imageRef: rig.runtime.imageRef, providerVolumeName: root.providerVolumeName,
        workspacePath: batch.input.workspacePath, hostBinaryPath: batch.input.hostBinaryPath, runtimeDir: root.runtimeDir,
        createdAt: 'controlled', requestDigest: 'controlled' }])
      const probeScript = path.join(batch.outputDir, 'readonly-control.cjs')
      const calls = path.join(batch.outputDir, 'readonly-calls.jsonl')
      const selected = path.join(batch.outputDir, 'readonly-request.json')
      const inspection = path.join(batch.outputDir, 'inspection.json')
      await fsp.writeFile(inspection, JSON.stringify([{ Id: root.containerId, State: { Running: false } }]))
      const installedDatabase = path.join(batch.outputDir, 'installed.db')
      await fsp.copyFile(batch.sourceDatabaseFile, installedDatabase)
      await fsp.writeFile(probeScript, `const fs=require('node:fs'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(args[0]==='inspect')process.stdout.write(fs.readFileSync(${JSON.stringify(inspection)}));else if(args[0]==='create'){fs.writeFileSync(${JSON.stringify(selected)},JSON.stringify(args));process.stdout.write('${'d'.repeat(64)}')}else if(args[0]==='wait')process.stdout.write('0');else if(args[0]==='logs'){const saved=JSON.parse(fs.readFileSync(${JSON.stringify(selected)}));if(saved[saved.indexOf('--entrypoint')+1]==='node')process.stdout.write(require('node:child_process').execFileSync(process.execPath,['--no-warnings','-e',saved.at(-3),${JSON.stringify(installedDatabase)},saved.at(-1)],{encoding:'utf8'}));else process.stdout.write(JSON.stringify({request:JSON.parse(saved.at(-1)),providerVersion:'1.18.21',sourceSchemaFingerprint:'schema-current',migrationJournalFingerprint:'migration-current',generation:'generation-current',rowCount:318}));}else if(!['start','rm'].includes(args[0]))process.exit(4);\n`)
      const read = vi.spyOn(Object.getPrototypeOf(rig), 'trackedDockerProbe').mockImplementation(async (_container: string, args: string[]) => new Promise<string>((resolve, reject) => {
        execFile(process.execPath, [probeScript, ...args], { encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout))
      }))
      const observed = await rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')
      expect(observed).toHaveProperty('faultMarkers', { preset: 'none', supervisorContainerId: rig.supervisor.containerId,
        crash: null, firstResumeObservationFailures: [] })
      expect(observed.status).toBe('complete')
      expect(observed.souls).toHaveLength(9)
      expect(observed.souls.every(soul => soul.activeWriters === 0 && !soul.incidentPresent)).toBe(true)
      expect(observed.roots[0]).toMatchObject({ rootSessionId: root.rootSessionId, providerUid: 65534, rowCount: 318 })
      expect(observed.installedStores.map(({ parents, history, excludedSourceSentinels, ...measured }) => measured)).toEqual([{ rootSessionId: root.rootSessionId, providerStoreId: root.providerStoreId,
        providerUid: 65534, providerGid: 0, providerVersion: '1.18.21', sourceSchemaFingerprint: 'schema-current',
        migrationJournalFingerprint: 'migration-current', generation: 'generation-current', rowCount: 318 }])
      expect(observed.installedStores[0]).toHaveProperty('parents', {
        [batch.source.families[0].rootId]: null,
        [batch.source.families[0].childId]: batch.source.families[0].rootId,
        [batch.source.families[0].grandchildId]: batch.source.families[0].childId,
      })
      expect(observed.installedStores[0].history.messages).toEqual(Object.fromEntries(batch.source.families[0].baselineMessages))
      expect(observed.installedStores[0].history.parts).toEqual(Object.fromEntries(batch.source.families[0].baselineParts))
      expect(observed.installedStores[0].excludedSourceSentinels).toEqual([...owner.EXCLUDED_SOURCE_SENTINELS].sort())
      expect(JSON.stringify(observed)).not.toContain('must-not-import')
      const actual = (await fsp.readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
      expect(actual.map(args => args[0])).toEqual(['inspect', 'create', 'start', 'wait', 'logs', 'create', 'start', 'wait', 'logs', 'rm', 'rm'])
      expect(actual[1]).toContain('retained-opencode-store-worker')
      expect(actual[1]).toContain(`type=volume,source=${root.providerVolumeName},target=/home/freshell/provider,readonly`)
      expect(actual.at(-1)?.slice(0, 2)).toEqual(['rm', '--force'])
      expect(observed.unrelated).toEqual({ incidentPresent: true, viewPresent: true, noticeIds: ['notice-unrelated'],
        outboxEventIds: ['event-unrelated'], exportSha256: [createHash('sha256').update('unchanged unrelated artifact').digest('hex')] })
      if (attempt === 'blocked stopped' || attempt === 'stopped readonly WAL') {
        let originalWal: Buffer | undefined
        if (attempt === 'stopped readonly WAL') {
          // A stopped WAL writer can leave committed rows outside the main DB and
          // no shared-memory index. The source directory must remain read-only.
          await new Promise<void>((resolve, reject) => execFile('python3', ['-I', '-c', String.raw`
import os,sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute('PRAGMA journal_mode=WAL')
c.execute('PRAGMA wal_autocheckpoint=0')
c.execute("UPDATE stopped_repair_operations SET status='before-current' WHERE operation_id='repair-current'")
c.execute('UPDATE installation SET control_epoch=1')
c.commit()
c.execute('PRAGMA wal_checkpoint(TRUNCATE)')
c.execute("UPDATE stopped_repair_operations SET status='complete' WHERE operation_id='repair-current'")
c.execute('UPDATE installation SET control_epoch=12')
c.commit()
os._exit(0)
`, database], { encoding: 'utf8' }, error => error ? reject(error) : resolve()))
          await fsp.unlink(`${database}-shm`)
          originalWal = await fsp.readFile(`${database}-wal`)
          expect(originalWal.length).toBeGreaterThan(32)
          await fsp.chmod(batch.registryRoot, 0o500)
        }
        Object.assign(rig.runtime, { task007Fixtures: new Map([['browser', batch]]),
          trackedSupervisorContainers: new Set([rig.supervisor.containerId]), trackedVolumes: new Set([batch.volumeName]) })
        const running = vi.spyOn(rig.runtime, 'isContainerRunning').mockReturnValue(false)
        const registryCommands: string[][] = []
        let created: string[] = [], output = '', failedLogs = false, lostAck = false, pendingHelper = false, foreignLabels = false, malformedProjection = false
        const helperId = 'e'.repeat(64)
        const execute: owner.Task007RunChild = async (file, args) => {
          expect(file).toBe('docker'); registryCommands.push([...args])
          if (args[0] === 'ps') return { stdout: pendingHelper ? created[created.indexOf('--name') + 1] : '', stderr: '' }
          if (args[0] === 'create') {
            created = args
            pendingHelper = true
            expect(args).toContain(`type=volume,source=${batch.volumeName},target=/registry,readonly,volume-nocopy`)
            expect(args).toContain(`type=bind,source=${batch.metadataFile},target=/fixture/metadata.json,readonly`)
            expect(args.slice(args.indexOf('--user'), args.indexOf('--user') + 2)).toEqual(['--user', '0:0'])
            expect(args).toContain('--read-only'); expect(args).toContain('none'); expect(args).toContain('ALL')
            expect(args).not.toContain(root.providerVolumeName)
            if (lostAck) throw new Error('controlled create ACK lost')
            return { stdout: helperId, stderr: '' }
          }
          if (args[0] === 'inspect') {
            const labels: Record<string, string> = {}
            args = created
            for (let index = 0; index < args.length; index++) if (args[index] === '--label') {
              const [key, value] = args[++index].split('='); labels[key] = value
            }
            if (foreignLabels) labels['com.freshell.task007-fixture-id'] = 'foreign-fixture'
            return { stdout: JSON.stringify([{ Id: helperId, Image: batch.input.imageRef, Config: { Labels: labels }, Mounts: [
              { Type: 'volume', Name: batch.volumeName, Destination: '/registry', RW: false },
              { Type: 'bind', Source: batch.metadataFile, Destination: '/fixture/metadata.json', RW: false },
            ] }]), stderr: '' }
          }
          if (args[0] === 'start') {
            output = await new Promise<string>((resolve, reject) => execFile('python3', ['-I', '-c', created.at(-6)!,
              database, batch.metadataFile, created.at(-3)!, batch.registryRoot, created.at(-1)!], { encoding: 'utf8' },
              (error, stdout) => error ? reject(error) : resolve(stdout)))
            return { stdout: '', stderr: '' }
          }
          if (args[0] === 'wait') return { stdout: '0', stderr: '' }
          if (args[0] === 'logs') { if (failedLogs) throw new Error('controlled Registry read failure'); return { stdout: malformedProjection ? '{}' : output, stderr: '' } }
          if (args[0] === 'rm') { expect(args).toEqual(['rm', '--force', helperId]); pendingHelper = false; return { stdout: '', stderr: '' } }
          throw new Error('unexpected Registry helper command')
        }
        Object.assign(rig.runtime, { executeTask007Child: execute })
        const beforeRefusal = registryCommands.length
        await expect(rig.runtime.readTask007StoppedRegistry({ ...rig.supervisor, volumeName: 'foreign-volume' }, batch.input.fixtureId, 'repair-current')).rejects.toThrow(/ownership/)
        await expect(rig.runtime.readTask007StoppedRegistry(rig.supervisor, 'foreign-fixture', 'repair-current')).rejects.toThrow(/ownership/)
        running.mockReturnValue(true)
        await expect(rig.runtime.readTask007StoppedRegistry(rig.supervisor, batch.input.fixtureId, 'repair-current')).rejects.toThrow(/running/)
        running.mockReturnValue(false)
        const metadata = await fsp.readFile(batch.metadataFile)
        await fsp.writeFile(batch.metadataFile, JSON.stringify({ ...batch.output, fixtureId: 'foreign-fixture' }))
        await expect(rig.runtime.readTask007StoppedRegistry(rig.supervisor, batch.input.fixtureId, 'repair-current')).rejects.toThrow(/metadata.*custody/)
        await fsp.writeFile(batch.metadataFile, metadata)
        expect(registryCommands).toHaveLength(beforeRefusal)
        vi.spyOn(rig.runtime, 'stopSupervisorExact').mockImplementation(() => undefined)
        vi.spyOn(rig.runtime, 'removeContainerExact').mockImplementation(() => undefined)
        vi.spyOn(rig.runtime, 'startSupervisor').mockResolvedValue({ ...rig.supervisor })
        vi.spyOn(rig.runtime, 'waitForSupervisorHealth').mockResolvedValue({})
        vi.spyOn(rig, 'controlEpoch').mockResolvedValue(12)
        const logs = vi.spyOn(rig.runtime, 'containerLogs').mockReturnValue(JSON.stringify({ event: 'supervisor.test_crash', point: 'stopped_repair_after_import_publication' }))
        vi.spyOn(rig.runtime, 'inspectContainer').mockReturnValue({ State: { Running: false, ExitCode: 134 } })
        await rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'after_import_publication')
        const originalRegistry = await fsp.readFile(database)
        const stoppedObserved = await rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')
        expect(stoppedObserved.operationId).toBe('repair-current')
        expect(stoppedObserved.status).toBe('complete')
        expect(stoppedObserved.controlEpoch).toBe(12)
        expect(stoppedObserved.faultMarkers.crash).toEqual({ point: 'stopped_repair_after_import_publication', running: false, exitCode: 134 })
        expect(stoppedObserved.unrelated).toEqual(observed.unrelated)
        expect((await fsp.readFile(database)).equals(originalRegistry)).toBe(true)
        if (originalWal) {
          expect((await fsp.readFile(`${database}-wal`)).equals(originalWal)).toBe(true)
          await expect(fsp.stat(`${database}-shm`)).rejects.toMatchObject({ code: 'ENOENT' })
        }
        expect(registryCommands.filter(args => args[0] === 'create')).toHaveLength(2)
        expect(registryCommands.filter(args => args[0] === 'rm')).toHaveLength(2)
        expect(rig.runtime.transferOwnedIds().containers).not.toContain(helperId)
        failedLogs = true
        await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).rejects.toThrow(/controlled Registry read failure/)
        expect(registryCommands.at(-1)).toEqual(['rm', '--force', helperId])
        failedLogs = false
        malformedProjection = true
        await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).rejects.toThrow()
        expect(registryCommands.at(-1)).toEqual(['rm', '--force', helperId])
        malformedProjection = false; lostAck = true
        await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).rejects.toThrow(/ACK lost/)
        expect(registryCommands.at(-1)).toEqual(['rm', '--force', helperId])
        expect(pendingHelper).toBe(false)
        foreignLabels = true
        await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).rejects.toThrow(/owned cleanup failed/)
        expect(registryCommands.at(-1)?.[0]).toBe('inspect')
        expect(pendingHelper).toBe(true)
        foreignLabels = false
        await Reflect.apply(Object.getPrototypeOf(rig.runtime).removeTask007Helper, rig.runtime, [created[created.indexOf('--name') + 1]])
        expect(pendingHelper).toBe(false)
        lostAck = false
        await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'missing-operation')).rejects.toThrow(/absent|failed/)
        expect(registryCommands.at(-1)).toEqual(['rm', '--force', helperId])
        logs.mockReturnValue('{"event":"supervisor.test_crash", malformed')
        await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).rejects.toThrow(/malformed/)
        logs.mockReturnValue('')
        expect((await rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).faultMarkers.crash).toBeNull()
        await rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'none')
        running.mockReturnValue(true)
        if (originalWal) {
          expect((await fsp.readFile(database)).equals(originalRegistry)).toBe(true)
          expect((await fsp.readFile(`${database}-wal`)).equals(originalWal)).toBe(true)
          await fsp.chmod(batch.registryRoot, 0o700)
        }
      }
      const alteredGraph = new DatabaseSync(installedDatabase)
      alteredGraph.prepare('UPDATE session SET parent_id = ? WHERE id = ?').run(root.rootSessionId, batch.source.families[0].grandchildId)
      alteredGraph.close()
      const changedEdges = await rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')
      expect(changedEdges.installedStores[0].history.sessions).toEqual(observed.installedStores[0].history.sessions)
      expect(changedEdges.installedStores[0].parents).not.toEqual(observed.installedStores[0].parents)
      expect(changedEdges.installedStores[0].parents[batch.source.families[0].grandchildId]).toBe(root.rootSessionId)
      const resumed = { soulId: root.soulId, incarnationId: 'incarnation-resumed', containerId: 'a'.repeat(64),
        hostBootId: 'resumed-boot', terminalId: 'terminal-0', nativeSessionId: root.rootSessionId,
        provider: 'opencode', launchState: 'running', desiredState: 'running', recoveryState: 'live', intentRevision: 2,
        executionGeneration: 2, evidenceRevision: 3,
        nativeIdentityObservation: { nativeSessionId: root.rootSessionId, incarnationId: 'incarnation-resumed',
          launchNonce: 'private-current-nonce', evidenceRevision: 3, source: 'opencode_tui' as const, evidenceDigest: 'c'.repeat(64) } }
      const liveDb = new DatabaseSync(database)
      liveDb.prepare('UPDATE souls SET desired_state=?,recovery_state=?,intent_revision=? WHERE soul_id=?').run('running', 'live', 2, root.soulId)
      liveDb.prepare('INSERT INTO incarnations VALUES(?,?,?,?,?,?,?,?)').run(root.soulId, resumed.incarnationId,
        'private-current-nonce', resumed.containerId, resumed.hostBootId, 'running', 2, 100)
      liveDb.prepare('INSERT INTO writer_claims VALUES(?,?,?,?,?,?)').run(root.soulId, 'opencode', root.providerStoreId, root.rootSessionId, resumed.incarnationId, 2)
      liveDb.close()
      const originalReceipts = rig.runtime.broker.receipts()
      vi.spyOn(rig.runtime.broker, 'receipts').mockReturnValue([...originalReceipts,
        { ...originalReceipts[0], containerId: resumed.containerId, incarnationId: resumed.incarnationId }])
      const inventory = vi.spyOn(rig, 'inventory').mockResolvedValue([resumed])
      const persistedInventory = () => {
        const registry = new DatabaseSync(database, { readOnly: true })
        try {
          return registry.prepare(`SELECT i.incarnation_id,i.container_id,i.host_boot_id,i.launch_state,i.execution_generation,
            s.desired_state,s.recovery_state,s.intent_revision FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id
            ORDER BY i.created_at,i.incarnation_id`).all().map(row => ({ ...resumed,
              incarnationId: String(row.incarnation_id), containerId: row.container_id === null ? undefined : String(row.container_id),
              hostBootId: row.host_boot_id === null ? undefined : String(row.host_boot_id), launchState: String(row.launch_state),
              executionGeneration: Number(row.execution_generation), desiredState: String(row.desired_state),
              recoveryState: String(row.recovery_state), intentRevision: Number(row.intent_revision),
              nativeIdentityObservation: row.incarnation_id === resumed.incarnationId ? resumed.nativeIdentityObservation : undefined }))
        } finally { registry.close() }
      }
      if (attempt === 'blocked stopped') {
        const blocked = { ...resumed, launchState: 'stopped', recoveryState: 'blocked' }
        const failedResume = new DatabaseSync(database)
        failedResume.exec("UPDATE souls SET recovery_state='blocked' WHERE soul_id='soul-0'; UPDATE incarnations SET launch_state='stopped'; DELETE FROM writer_claims")
        failedResume.close()
        await rig.setSyntheticStoppedRepairFault(batch.input.fixtureId, 'first_resume_observation')
        const failureMarker = { soulId: root.soulId, incarnationId: resumed.incarnationId, executionGeneration: 2 }
        await fsp.appendFile(path.join(path.dirname(batch.input.runtimeRoot), 'evidence/lifecycle.jsonl'), JSON.stringify({
          event: 'supervisor.stopped_repair_resume_observation_test_failure', data: failureMarker }) + '\n')
        inventory.mockImplementation(async () => persistedInventory())
        await fsp.writeFile(inspection, JSON.stringify([{ Id: resumed.containerId, State: { Running: false } }]))
        const blockedObservation = await rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')
        expect(blockedObservation.faultMarkers.firstResumeObservationFailures).toEqual([failureMarker])
        expect(blockedObservation.souls[0]).toMatchObject({ desiredState: 'running', recoveryState: 'blocked', activeWriters: 0 })
        expect(blockedObservation.nativeObservations[0]).toEqual({ rootSessionId: root.rootSessionId,
          canonicalSoulId: root.soulId, state: 'unavailable', reason: 'host_unavailable' })
        expect(blockedObservation.installedStores[0]).toEqual(changedEdges.installedStores[0])
        inventory.mockResolvedValueOnce([blocked]).mockResolvedValueOnce([{ ...blocked, intentRevision: 3 }])
        await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).rejects.toThrow(/changed/)
        const stoppedWriter = new DatabaseSync(database)
        stoppedWriter.prepare('INSERT INTO writer_claims VALUES(?,?,?,?,?,?)').run(root.soulId, 'opencode', root.providerStoreId,
          root.rootSessionId, resumed.incarnationId, 2)
        stoppedWriter.close()
        read.mockClear()
        await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).rejects.toThrow(/writer/)
        expect(read).not.toHaveBeenCalled()
        const retry = new DatabaseSync(database)
        retry.exec("UPDATE souls SET recovery_state='live' WHERE soul_id='soul-0'; UPDATE incarnations SET launch_state='running'")
        retry.close()
        inventory.mockResolvedValue([resumed])
      }
      if (attempt === 'retained failed Retry') {
        const predecessor = { ...resumed, incarnationId: 'incarnation-retired', containerId: undefined,
          hostBootId: undefined, launchState: 'failed', executionGeneration: 1, nativeIdentityObservation: undefined }
        const retired = new DatabaseSync(database)
        retired.prepare('INSERT INTO incarnations VALUES(?,?,?,?,?,?,?,?)').run(root.soulId, predecessor.incarnationId,
          'private-retired-nonce', null, null, 'failed', 1, 90)
        retired.close()
        inventory.mockImplementation(async () => persistedInventory())
      }
      const adoptionNonce = '1234567890abcdef'.repeat(2), adoptionGeneration = '9'.repeat(64)
      hostStatus = { state: 'observed', data: { observation: {
        terminalId: resumed.terminalId, rootSessionId: root.rootSessionId, tailMessageId: null,
        evidenceGeneration: adoptionGeneration, incarnationId: resumed.incarnationId,
        launchNonce: adoptionNonce, hydrated: true, messagesRead: 'success' } } }
      await fsp.mkdir(hostRuntimeDir, { mode: 0o700 })
      const secret = Buffer.from('private-unit-host-secret')
      await fsp.writeFile(path.join(hostRuntimeDir, 'secret'), secret, { mode: 0o600 })
      const proof = (challenge: string) => createHmac('sha256', secret)
        .update(`${challenge}\0${resumed.hostBootId}\0${resumed.incarnationId}`).digest('hex')
      hostServer = net.createServer(socket => {
        let buffered = Buffer.alloc(0)
        socket.on('error', () => socket.destroy())
        socket.on('data', chunk => {
          buffered = Buffer.concat([buffered, chunk])
          if (buffered.length < 4 || buffered.length < buffered.readUInt32BE(0) + 4) return
          const request = JSON.parse(buffered.subarray(4).toString())
          const hello = request.body.method === 'hello'
          const admitted = request.body.params.incarnation_id === resumed.incarnationId
            && (hello || request.auth === proof('command-auth'))
          const response = { requestId: request.requestId, result: admitted ? { Ok: hello
            ? { kind: 'hello', data: { host_boot_id: resumed.hostBootId, proof: proof(request.body.params.challenge) } }
            : { kind: 'status', data: { host_boot_id: resumed.hostBootId, opencode_adoption: hostStatus } } }
            : { Err: { code: 'UNAUTHORIZED' } } }
          const payload = Buffer.from(JSON.stringify(response)), frame = Buffer.alloc(payload.length + 4)
          frame.writeUInt32BE(payload.length, 0); payload.copy(frame, 4); socket.end(frame)
        })
      })
      await new Promise<void>(resolve => hostServer!.listen(path.join(hostRuntimeDir, 'host.sock'), resolve))
      await fsp.writeFile(inspection, JSON.stringify([{ Id: resumed.containerId, State: { Running: true } }]))
      const live = await rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')
      expect(live).toHaveProperty('nativeObservations.0.state', 'current')
      expect(JSON.stringify(live)).not.toContain('private-current-nonce')
      expect(JSON.stringify(live)).not.toContain(adoptionNonce)
      expect(live).toHaveProperty('nativeObservations.0.hostStatus.launchNonceSha256', createHash('sha256').update(adoptionNonce).digest('hex'))
      expect(live).toHaveProperty('nativeObservations.0.registryNativeObservation.launchNonceSha256', createHash('sha256').update('private-current-nonce').digest('hex'))
      expect(live).toHaveProperty('nativeObservations.0.hostStatus.evidenceGeneration', adoptionGeneration)
      for (const changedView of [
        { ...resumed, incarnationId: 'incarnation-foreign' },
        { ...resumed, hostBootId: 'foreign-boot' },
        { ...resumed, nativeSessionId: 'ses_foreign' },
        { ...resumed, executionGeneration: 3 },
        { ...resumed, intentRevision: 3 },
        { ...resumed, nativeIdentityObservation: { ...resumed.nativeIdentityObservation, launchNonce: 'foreign-nonce' } },
        { ...resumed, nativeIdentityObservation: { ...resumed.nativeIdentityObservation, evidenceRevision: 2 } },
      ]) {
        inventory.mockResolvedValue([changedView])
        await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).rejects.toThrow(/current/)
      }
      for (const conflictingViews of [
        [resumed, resumed],
        ...['prepared', 'created', 'starting', 'running', 'stopping'].map(launchState =>
          [resumed, { ...resumed, incarnationId: 'incarnation-conflicting', launchState }]),
      ]) {
        inventory.mockResolvedValue(conflictingViews)
        read.mockClear()
        await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).rejects.toThrow(/current/)
        expect(read).not.toHaveBeenCalled()
        inventory.mockResolvedValueOnce([resumed]).mockResolvedValueOnce(conflictingViews)
        await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).rejects.toThrow(/changed/)
      }
      inventory.mockResolvedValue([resumed])
      const duplicateWriter = new DatabaseSync(database)
      duplicateWriter.prepare('INSERT INTO writer_claims VALUES(?,?,?,?,?,?)').run(root.soulId, 'opencode', root.providerStoreId,
        root.rootSessionId, resumed.incarnationId, 2)
      duplicateWriter.close()
      read.mockClear()
      await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).rejects.toThrow(/writer/)
      expect(read).not.toHaveBeenCalled()
      const removeDuplicate = new DatabaseSync(database)
      removeDuplicate.exec('DELETE FROM writer_claims WHERE rowid=(SELECT MAX(rowid) FROM writer_claims)')
      removeDuplicate.close()
      const foreignLiveWriter = new DatabaseSync(database)
      foreignLiveWriter.prepare('UPDATE writer_claims SET soul_id = ?, incarnation_id = ?').run('foreign-soul', 'incarnation-foreign')
      foreignLiveWriter.close()
      await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).rejects.toThrow(/writer/)
      const restoreWriter = new DatabaseSync(database)
      restoreWriter.prepare('UPDATE writer_claims SET soul_id = ?, incarnation_id = ?').run(root.soulId, resumed.incarnationId)
      restoreWriter.close()
      inventory.mockResolvedValueOnce([resumed]).mockResolvedValueOnce([{ ...resumed, evidenceRevision: 4 }])
      await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).rejects.toThrow(/changed/)
      inventory.mockResolvedValue([resumed])
      hostStatus = { state: 'awaiting_observation' }
      const awaiting = await rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')
      expect(awaiting).toHaveProperty('nativeObservations.0.hostStatus.state', 'awaiting_observation')
      inventory.mockResolvedValue([{ ...resumed, nativeIdentityObservation: undefined }])
      const awaitingRegistry = await rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')
      expect(awaitingRegistry).toHaveProperty('nativeObservations.0.registryNativeObservation', null)
      inventory.mockResolvedValue([resumed])
      hostStatus = { state: 'observed', data: { observation: { terminalId: resumed.terminalId, rootSessionId: root.rootSessionId,
        tailMessageId: null, evidenceGeneration: adoptionGeneration, incarnationId: resumed.incarnationId,
        launchNonce: adoptionNonce, hydrated: true, messagesRead: 'success' } } }
      hostStatus.data.observation.launchNonce = 'foreign-native-nonce'
      await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).rejects.toThrow(/nonce/)
      hostStatus.data.observation.launchNonce = adoptionNonce
      hostStatus.data.observation.evidenceGeneration = 'malformed-generation'
      await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).rejects.toThrow(/generation/)
      hostStatus.data.observation.evidenceGeneration = adoptionGeneration
      for (const key of ['incarnationId', 'rootSessionId', 'terminalId'] as const) {
        const currentValue = hostStatus.data.observation[key]
        hostStatus.data.observation[key] = 'foreign-current-binding'
        await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).rejects.toThrow(/differs/)
        hostStatus.data.observation[key] = currentValue
      }
      await new Promise<void>(resolve => hostServer!.close(() => resolve()))
      hostServer = undefined
      await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).resolves.toHaveProperty('nativeObservations.0.reason', 'host_unavailable')
      inventory.mockRestore()
      vi.spyOn(rig.runtime.broker, 'receipts').mockReturnValue(originalReceipts)
      const stoppedAgain = new DatabaseSync(database)
      stoppedAgain.prepare('UPDATE souls SET desired_state=?,recovery_state=?,intent_revision=? WHERE soul_id=?').run('stopped', 'data_repair_complete', 1, root.soulId)
      stoppedAgain.exec('DELETE FROM writer_claims; DELETE FROM incarnations')
      stoppedAgain.close()
      await fsp.writeFile(inspection, JSON.stringify([{ Id: root.containerId, State: { Running: false } }]))
      const changed = new DatabaseSync(database)
      changed.prepare('INSERT INTO writer_claims VALUES(?,?,?,?,?,?)').run(root.soulId, 'opencode', root.providerStoreId, root.rootSessionId, root.incarnationId, 1)
      changed.close()
      read.mockClear()
      await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).rejects.toThrow(/writer/)
      expect(read).not.toHaveBeenCalled()
      const foreignWriter = new DatabaseSync(database)
      foreignWriter.exec('DELETE FROM writer_claims')
      foreignWriter.prepare('INSERT INTO writer_claims VALUES(?,?,?,?,?,?)').run('foreign-soul', 'opencode', root.providerStoreId, root.rootSessionId, 'foreign-incarnation', 1)
      foreignWriter.close()
      await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).rejects.toThrow(/writer/)
      expect(read).not.toHaveBeenCalled()
      await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'absent')).rejects.toThrow(/absent/)
      await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-foreign')).rejects.toThrow(/differ/)
      await expect(rig.syntheticStoppedRepairBatchObservation('foreign-fixture', 'repair-current')).rejects.toThrow(/registered/)
      const mismatched = new DatabaseSync(database)
      mismatched.prepare('UPDATE stopped_repair_operations SET targets_json = ? WHERE operation_id = ?')
        .run(JSON.stringify(batch.output.targets.map(target => ({ soulId: target.soulId,
          incidentId: 'foreign-incident', expectedIntentRevision: target.expectedIntentRevision }))), 'repair-current')
      mismatched.exec('DELETE FROM writer_claims')
      mismatched.close()
      await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).rejects.toThrow(/targets|incident/)
      const receiptDrift = new DatabaseSync(database)
      receiptDrift.prepare('UPDATE stopped_repair_operations SET targets_json = ? WHERE operation_id = ?').run(JSON.stringify(targets), 'repair-current')
      receiptDrift.prepare('UPDATE stopped_repair_root_receipts SET source_store_id = ?').run('a'.repeat(64))
      receiptDrift.close()
      await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).rejects.toThrow(/source|capture/)
      const restoreReceipt = new DatabaseSync(database)
      restoreReceipt.prepare('UPDATE stopped_repair_root_receipts SET source_store_id = ?, native_import_revision = ?').run(facts.sourceStoreId, 9)
      restoreReceipt.close()
      await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).rejects.toThrow(/capture/)
      const restoreCapture = new DatabaseSync(database)
      restoreCapture.exec('UPDATE stopped_repair_root_receipts SET native_import_revision = 1')
      restoreCapture.close()
      for (const wrongScope of [
        { ...scope, sourceStoreId: '0'.repeat(64) },
        { ...scope, targets: scope.targets.map((target, index) => index === 0
          ? { ...target, target: { ...target.target, expectedIntentRevision: 2 } } : target) },
        { ...scope, roots: scope.roots.map((root, index) => index === 0 ? { ...root, eligibleOwners: ['foreign-soul'] } : root) },
        { ...scope, roots: scope.roots.slice(1) },
      ]) {
        const wrong = new DatabaseSync(database)
        wrong.prepare('UPDATE stopped_repair_operations SET scope_json = ? WHERE operation_id = ?').run(JSON.stringify(wrongScope), 'repair-current')
        wrong.close()
        await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).rejects.toThrow(/source|capture|eligible/)
      }
      const wrongChoice = new DatabaseSync(database)
      wrongChoice.prepare('UPDATE stopped_repair_operations SET scope_json = ?, owner_choices_json = ? WHERE operation_id = ?')
        .run(JSON.stringify(scope), JSON.stringify(batch.output.canonicalChoices.map((choice, index) => index === 0 ? { ...choice, soulId: 'soul-7' } : choice)), 'repair-current')
      wrongChoice.close()
      await expect(rig.syntheticStoppedRepairBatchObservation(batch.input.fixtureId, 'repair-current')).rejects.toThrow(/canonical/)
    } finally {
      if (hostServer) await new Promise<void>(resolve => hostServer!.close(() => resolve()))
      if (attempt === 'stopped readonly WAL') await fsp.chmod(batch.registryRoot, 0o700)
      vi.restoreAllMocks(); vi.unstubAllEnvs(); await fsp.rm(rig.runtime.testRoot, { recursive: true, force: true })
      expect(fs.existsSync(path.join(hostRuntimeDir, 'host.sock'))).toBe(false)
      expect(fs.existsSync(rig.runtime.testRoot)).toBe(false)
    }
  }, 60_000)

  it('refuses browser batch setup before any preparation unless the owner is isolated, grant-free and explicitly opted in', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused batch web') }, fixtureRepoRoot, 3)
    const prepare = vi.spyOn(rig.runtime, 'prepare')
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    try {
      await expect(rig.prepareSyntheticStoppedRepairBatch()).rejects.toThrow(/isolated|grant.free/)
      expect(prepare).not.toHaveBeenCalled()
    } finally { vi.unstubAllEnvs() }
  })
  it('refuses a pre-existing run root before ordinary preparation can remove its files', async () => {
    const harness = new owner.RuntimeHarness(fixtureRepoRoot, randomUUID(), 3, { bootstrapProviders: [] })
    const prepare = vi.spyOn(harness, 'prepare').mockRejectedValue(new Error('ordinary preparation reached'))
    await fsp.mkdir(harness.testRoot, { recursive: true, mode: 0o700 })
    const sentinel = path.join(harness.testRoot, 'existing-owner-file')
    await fsp.writeFile(sentinel, 'preserve prior state')
    try {
      await expect(harness.prepareTask007StoppedFixture('browser')).rejects.toThrow(/already exists/)
      expect(prepare).not.toHaveBeenCalled()
      expect(await fsp.readFile(sentinel, 'utf8')).toBe('preserve prior state')
    } finally { await fsp.rm(harness.testRoot, { recursive: true, force: true }) }
  })
  it('captures enclosure stdout and stderr before removal even when the parent wait transport fails', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused parent failure web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [] }, undefined, { bootstrapProviders: [] })
    const batch = await browserFixture(rig)
    const harness = rig.runtime
    await fsp.mkdir(harness.evidenceDir, { recursive: true, mode: 0o700 })
    const directory = path.join(fixtureRepoRoot, 'parent-wait-control')
    await fsp.mkdir(directory)
    const calls = path.join(directory, 'calls.jsonl')
    await fsp.writeFile(path.join(directory, 'docker'), `#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(args[0]==='create')process.stdout.write('${'a'.repeat(64)}');else if(args[0]==='wait'){process.stderr.write('wait transport failed');process.exit(9)}else if(args[0]==='logs'){process.stdout.write('owned container stdout');process.stderr.write('owned container stderr')}else if(!['ps','start','rm'].includes(args[0]))process.exit(4);\n`, { mode: 0o700 })
    vi.spyOn(harness, 'prepareTask007StoppedFixture').mockResolvedValue(batch)
    Object.assign(harness, { task007Artifact: Promise.resolve({ path: '/controlled-copied-harness', candidateSha: harness.candidateSha }) })
    harness.imageRef = batch.input.imageRef
    vi.stubEnv('PATH', `${directory}${path.delimiter}${process.env.PATH}`)
    try {
      await expect(harness.runTask007StoppedRepairParents()).rejects.toThrow(/failed/)
      expect(await fsp.readFile(path.join(harness.evidenceDir, 'task007-destructive-parents.stdout'), 'utf8')).toBe('owned container stdout')
      expect(await fsp.readFile(path.join(harness.evidenceDir, 'task007-destructive-parents.stderr'), 'utf8')).toBe('owned container stderr')
      const actual = (await fsp.readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
      expect(actual.map(args => args[0])).toEqual(['ps', 'create', 'start', 'wait', 'logs', 'rm'])
      expect(actual.at(-1)).toEqual(['rm', '--force', 'a'.repeat(64)])
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fsp.rm(harness.testRoot, { recursive: true, force: true }) }
  })
  it('refuses a fixture outside the explicitly isolated phase-three owner before preparation', async () => {
    const ordinary = new owner.RuntimeHarness(fixtureRepoRoot, 'task007-ordinary-refusal', 1)
    const prepare = vi.spyOn(ordinary, 'prepare')
    await expect(ordinary.prepareTask007StoppedFixture('after_import_publication')).rejects.toThrow(/isolated.*phase.three/)
    expect(prepare).not.toHaveBeenCalled()
  })

  it('removes a preallocated provider volume once when its actual receipt also owns it', async () => {
    const directory = path.join(fixtureRepoRoot, 'cleanup-control')
    await fsp.mkdir(directory, { mode: 0o700 })
    const calls = path.join(directory, 'calls.jsonl')
    const executable = path.join(directory, 'docker')
    const volume = `freshell-provider-${'c'.repeat(24)}`
    await fsp.writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(args[0]==='run')process.stdout.write('${'a'.repeat(64)}');else if(args[0]==='inspect')process.exit(1);else if(args[0]==='volume'&&args[1]==='rm'){const lines=fs.readFileSync(${JSON.stringify(calls)},'utf8').trim().split('\\n').map(JSON.parse);if(lines.filter(a=>a[0]==='volume'&&a[1]==='rm').length>1)process.exit(9)}else if(!['volume','ps','rm'].includes(args[0]))process.exit(4);\n`, { mode: 0o700 })
    const harness = new owner.RuntimeHarness(fixtureRepoRoot, 'task007-volume-cleanup', 1, { bootstrapProviders: [] })
    harness.imageRef = `sha256:${'b'.repeat(64)}`
    harness.testSupervisorBinary = '/controlled-supervisor'
    harness.testHostBinary = '/controlled-host'
    const broker = new RestrictedDockerBroker({ realSocketPath: '/controlled-unused', proxySocketPath: path.join(harness.testRoot, 'broker.sock'),
      runtimeRootPrefix: harness.testRoot, allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set(), testRunId: harness.runId, logPath: path.join(directory, 'broker.jsonl') })
    harness.broker = broker
    vi.spyOn(broker, 'receipts').mockReturnValue([{ containerId: 'd'.repeat(64), incarnationId: 'incarnation-unit', soulId: 'soul-unit',
      createdAt: 'controlled', requestDigest: 'controlled', imageRef: harness.imageRef, runtimeDir: '/controlled-runtime', providerVolumeName: volume }])
    try {
      vi.stubEnv('PATH', `${directory}${path.delimiter}${process.env.PATH}`)
      await harness.startSupervisor({ scenarioId: 'preallocated-volume', volumeName: volume, waitForHealth: false })
      await expect(harness.cleanup()).resolves.toEqual({ ok: true, errors: [] })
      const actual = (await fsp.readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
      expect(actual.filter(args => args[0] === 'volume' && args[1] === 'rm')).toEqual([['volume', 'rm', volume]])
    } finally {
      vi.unstubAllEnvs()
      await fsp.rm(harness.testRoot, { recursive: true, force: true })
    }
  })
  it('reconciles a lost parent-create acknowledgement only through its exact owned image, labels and two mounts', async () => {
    const harness = new owner.RuntimeHarness(fixtureRepoRoot, 'task007-parent-lost-ack', 3, { bootstrapProviders: [] })
    await fsp.mkdir(harness.evidenceDir, { recursive: true, mode: 0o700 })
    const directory = path.join(fixtureRepoRoot, 'parent-cleanup-control')
    await fsp.mkdir(directory)
    const calls = path.join(directory, 'calls.jsonl')
    const removed = path.join(directory, 'removed')
    const name = 'freshell-task007-parents-controlled'
    const id = 'c'.repeat(64)
    harness.imageRef = `sha256:${'a'.repeat(64)}`
    const observed = { Id: id, Image: harness.imageRef, Config: { Labels: { 'com.freshell.runtime-test-run-id': harness.runId,
      'com.freshell.runtime-test-candidate': harness.candidateSha, 'com.freshell.task007-setup': 'destructive-parents' } },
      Mounts: [{ Type: 'bind', Source: harness.testRoot, Destination: harness.testRoot, RW: true },
        { Type: 'bind', Source: harness.buildDir, Destination: harness.buildDir, RW: false }] }
    await fsp.writeFile(path.join(directory, 'docker'), `#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(args[0]==='ps'&&args.includes('--format')&&!fs.existsSync(${JSON.stringify(removed)}))process.stdout.write(${JSON.stringify(name)});else if(args[0]==='inspect')process.stdout.write(JSON.stringify([${JSON.stringify(observed)}]));else if(args[0]==='rm')fs.writeFileSync(${JSON.stringify(removed)},'removed');else if(!['ps','volume'].includes(args[0]))process.exit(4);\n`, { mode: 0o700 })
    Object.assign(harness, { task007HelperNames: new Set([name]) })
    vi.stubEnv('PATH', `${directory}${path.delimiter}${process.env.PATH}`)
    try {
      await expect(harness.cleanup()).resolves.toEqual({ ok: true, errors: [] })
      expect(await fsp.readFile(removed, 'utf8')).toBe('removed')
      const actual = (await fsp.readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
      expect(actual.filter(args => args[0] === 'rm')).toEqual([['rm', '--force', id]])
    } finally { vi.unstubAllEnvs(); await fsp.rm(harness.testRoot, { recursive: true, force: true }) }
  })
})

describe('Task7 literal destructive sandbox dispatch', () => {
  it('runs only the fixed owner adapter for the exact corpus-free command and preserves corpus refusal', async () => {
    const directory = path.join(fixtureRepoRoot, 'route-control')
    await fsp.mkdir(directory, { mode: 0o700 })
    const calls = path.join(directory, 'calls.jsonl')
    for (const file of ['pnpm', 'docker']) {
      await fsp.writeFile(path.join(directory, file), `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({file:${JSON.stringify(file)},args:process.argv.slice(2)})+'\\n');process.exit(${file === 'pnpm' ? 0 : 81});\n`, { mode: 0o700 })
    }
    const wrapper = path.join(sourceRoot, 'scripts/sandbox-test.sh')
    const command = 'cargo test -p freshell-supervisor stopped_repair_crash_ -- --ignored'
    const options = { cwd: fixtureRepoRoot, env: { PATH: `${directory}${path.delimiter}${process.env.PATH}`, HOME: directory }, encoding: 'utf8' as const }
    const run = (args: string[]) => new Promise<void>((resolve, reject) => execFile(wrapper, args, options, error => error ? reject(error) : resolve()))
    await run(['--runtime-suite', command])
    const actual = (await fsp.readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(actual).toEqual([{ file: 'pnpm', args: ['exec', 'tsx', path.join(sourceRoot, 'scripts/testing/task007-destructive-sandbox.ts')] }])
    await expect(run(['--corpus', '--runtime-suite', command])).rejects.toThrow()
    expect((await fsp.readFile(calls, 'utf8')).trim().split('\n')).toHaveLength(1)
  })
})

describe('fixed observations of an owned prior enclosure', () => {
  it('distinguishes stopped, running, absent and failed Docker inspection for the exact recorded boot', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-container-state-'))
    const modeFile = path.join(root, 'mode')
    const calls = path.join(root, 'calls.jsonl')
    const docker = path.join(root, 'docker')
    await fsp.writeFile(docker, `#!${process.execPath}\nconst fs=require('node:fs');const mode=fs.readFileSync(${JSON.stringify(modeFile)},'utf8');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(mode==='failed')process.exit(9);if(args[0]==='ps'){if(mode!=='absent')process.stdout.write('${handle.containerId}\\n');if(mode==='ambiguous')process.stdout.write('other-container\\n')}else if(args[0]==='inspect')process.stdout.write(JSON.stringify([{Id:'${handle.containerId}',State:{Running:mode==='malformed'?'unknown':mode==='running'}}]));else process.exit(10)\n`, { mode: 0o700 })
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') }, fixtureRepoRoot)
    const address = rig.runtimeEnclosureHandle(handle)
    await fsp.writeFile(path.join(root, 'host-state.json'), JSON.stringify({ hostBootId: address.hostBootId }))
    rig.runtime.broker = new RestrictedDockerBroker({ realSocketPath: path.join(root, 'unused.sock'), proxySocketPath: path.join(root, 'proxy.sock'),
      runtimeRootPrefix: root, allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set(), testRunId: rig.runtime.runId, logPath: path.join(root, 'broker.jsonl') })
    vi.spyOn(rig.runtime.broker, 'receipts').mockReturnValue([{ ...address, runtimeDir: root, imageRef: 'owned-image',
      createdAt: new Date().toISOString(), requestDigest: 'd'.repeat(64) }])
    vi.spyOn(rig.runtime.broker, 'receiptIds').mockReturnValue(new Set([address.containerId]))
    vi.spyOn(rig.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    vi.stubEnv('PATH', `${root}${path.delimiter}${process.env.PATH}`)
    try {
      for (const [mode, expected] of [
        ['stopped', { present: true, running: false }], ['running', { present: true, running: true }], ['absent', { present: false, running: false }],
      ] as const) {
        await fsp.writeFile(modeFile, mode)
        await expect(rig.ownedContainerState(address)).resolves.toEqual(expected)
      }
      await fsp.writeFile(modeFile, 'failed')
      await expect(rig.ownedContainerState(address)).rejects.toThrow(/probe|inspection/)
      await fsp.writeFile(modeFile, 'ambiguous')
      await expect(rig.ownedContainerState(address)).rejects.toThrow(/ambiguous|differs/)
      await fsp.writeFile(modeFile, 'malformed')
      await expect(rig.ownedContainerState(address)).rejects.toThrow()
      const before = await fsp.readFile(calls, 'utf8')
      await expect(rig.ownedContainerState({ ...address, hostBootId: 'foreign' })).rejects.toThrow(/boot|address/)
      await expect(rig.ownedContainerState({ ...address, runId: 'foreign' })).rejects.toThrow(/owned|address/)
      expect(await fsp.readFile(calls, 'utf8')).toBe(before)
    } finally { vi.unstubAllEnvs(); await fsp.rm(root, { recursive: true, force: true }) }
  })
})

describe('fixed fresh-agent launch observations', () => {
  it('crashes the matching fresh provider child rather than its adapter PID', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') }, fixtureRepoRoot, 5, {}, {}, 'release', {
      enabledProviders: [], freshAgentModes: ['freshclaude'],
    })
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    vi.spyOn(rig, 'inventory').mockResolvedValue([{ ...current, provider: 'claude', freshAgentSessionType: 'freshclaude',
      launchState: 'running', intentRevision: 1 }])
    const launch = vi.spyOn(rig, 'freshAgentLaunchFacts').mockResolvedValue({ provider: 'claude', version: '2.1.263', workerPid: 42 })
    const host = vi.spyOn(rig, 'chaosHostFacts').mockResolvedValue({ workerPid: 99, workerLaunchCount: 1, unsafeBrokerAttempts: 0,
      limits: { cpuMax: '200000 100000', memoryMax: '4294967296', swapMax: '0', pidsMax: '512' } })
    const kill = vi.spyOn(rig.runtime, 'killOwnedRuntimePidExact').mockImplementation(() => undefined)
    vi.spyOn(rig.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    await rig.crashProviderWorker(current)
    expect(kill).toHaveBeenCalledExactlyOnceWith(current.containerId, 42)
    expect(launch).toHaveBeenCalledExactlyOnceWith(rig.runtimeEnclosureHandle(current))
    expect(host).not.toHaveBeenCalled()
  })
  it.each([
    { mode: 'freshclaude', provider: 'claude', version: '2.1.237', command: 'claude --session owned' },
    { mode: 'kilroy', provider: 'claude', registeredProvider: 'kilroy', version: '2.1.237', command: 'claude --session owned' },
    { mode: 'freshcodex', provider: 'codex', version: '0.147.0', command: 'codex app-server' },
    { mode: 'freshopencode', provider: 'opencode', version: '1.18.21', command: 'opencode serve' },
  ])('observes $mode native-family version/PID without requiring a pre-turn native ID', async ({ mode, provider, registeredProvider = provider, version, command }) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-fresh-launch-'))
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') }, fixtureRepoRoot, 5, {}, {}, 'release', {
      enabledProviders: [], freshAgentModes: [mode],
    })
    const enclosure = rig.runtimeEnclosureHandle(handle)
    const row = { ...enclosure, provider: registeredProvider, freshAgentSessionType: mode, launchState: 'running', intentRevision: 1 }
    const inventory = vi.spyOn(rig, 'inventory').mockResolvedValue([row])
    rig.runtime.broker = new RestrictedDockerBroker({ realSocketPath: path.join(root, 'unused.sock'), proxySocketPath: path.join(root, 'proxy.sock'),
      runtimeRootPrefix: root, allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set(), testRunId: rig.runtime.runId, logPath: path.join(root, 'broker.jsonl') })
    vi.spyOn(rig.runtime.broker, 'receipts').mockReturnValue([{ ...enclosure, imageRef: 'owned-image', runtimeDir: root,
      createdAt: new Date().toISOString(), requestDigest: 'd'.repeat(64) }])
    const probe = vi.spyOn(rig, 'ownedProviderExec').mockImplementation(async (_container, args) => (
      args[0] === 'python3' ? JSON.stringify({ provider, version, native: { pid: 42, parentPid: 41, startTicks: '123', uid: 65534, executable: `/owned/${provider}`, executableSha256: 'd'.repeat(64), cwd: '/owned/workspace', profileSha256: 'e'.repeat(64), launch: { incarnationId: enclosure.incarnationId } }, sdk: provider === 'claude' ? { version: '0.3.237', declaredNativeVersion: '2.1.237', modulePath: '/owned/sdk.mjs', moduleSha256: 'f'.repeat(64), entryPath: '/owned/index.mjs', entrySha256: 'a'.repeat(64), selection: 'sidecar-selected-module-resolution' } : null }) : `${version} (global)\n1 session-host\n99 ${command}\n`
    ))
    try {
      await expect(rig.freshAgentLaunchFacts(enclosure)).resolves.toEqual({ provider, version, workerPid: 42 })
      expect(probe).toHaveBeenCalledExactlyOnceWith(enclosure.containerId, ['python3', '-c', owner.FRESH_AGENT_PROCESS_SCRIPT, provider, enclosure.incarnationId])
      probe.mockResolvedValue(JSON.stringify({ provider, version, native: { pid: 1 } }))
      await expect(rig.freshAgentLaunchFacts(enclosure)).rejects.toThrow()
      probe.mockClear()
      inventory.mockResolvedValue([{ ...row, provider: registeredProvider === provider ? 'kilroy' : provider }])
      await expect(rig.freshAgentLaunchFacts(enclosure)).rejects.toThrow(/registration/)
      expect(probe).not.toHaveBeenCalled()
      inventory.mockResolvedValue([{ ...row, hostBootId: 'replacement' }])
      await expect(rig.freshAgentLaunchFacts(enclosure)).rejects.toThrow(/current|enclosure/)
      expect(probe).not.toHaveBeenCalled()
    } finally { await fsp.rm(root, { recursive: true, force: true }) }
  })
})

describe('fixed owned fresh Codex saved history', () => {
  it('prepares the original large fixture in its owned provider and detects later changes', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-codex-saved-history-'))
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused saved-history web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'] })
    vi.spyOn(rig.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    const inventory = vi.spyOn(rig, 'inventory').mockResolvedValue([{ ...current, provider: 'codex',
      freshAgentSessionType: 'freshcodex', launchState: 'running', intentRevision: 1 }])
    const file = path.join(root, 'retained.jsonl')
    const probe = vi.spyOn(rig, 'ownedProviderExec').mockImplementation(async (container, args) => {
      expect(container).toBe(current.containerId)
      if (args[0] === 'cat') return fsp.readFile(file, 'utf8')
      expect(args.slice(0, 3)).toEqual(['node', '--input-type=module', '-e'])
      return execFileSync(process.execPath, [args[1], args[2], args[3], file, args[5]], { encoding: 'utf8' })
    })
    try {
      const prepared = await rig.prepareFreshCodexSavedHistory(current)
      const raw = await fsp.readFile(file, 'utf8')
      const rows = raw.trim().split('\n').map(line => JSON.parse(line))
      expect(prepared.bytes).toBe(Buffer.byteLength(raw))
      expect(prepared.bytes).toBeGreaterThan(1024 * 1024)
      expect(rows).toHaveLength(241)
      expect(rows[0].payload.id).toBe(current.nativeSessionId)
      expect(rows.at(-1).payload.last_agent_message).toBe(`Managed fixture saved answer\n${'x'.repeat(20_000)}`)
      await expect(rig.freshCodexSavedHistoryUnchanged(current)).resolves.toBe(true)
      await fsp.appendFile(file, 'changed\n')
      await expect(rig.freshCodexSavedHistoryUnchanged(current)).resolves.toBe(false)
      Object.assign(rig, { web: { info: { homeDir: root } } })
      await rig.prepareCoincidentFreshCodexHistory(current)
      const coincident = path.join(root, '.codex', 'sessions', `rollout-${current.nativeSessionId}.jsonl`)
      expect(await fsp.readFile(coincident, 'utf8')).toContain('Wrong web-local answer')
      await expect(rig.coincidentFreshCodexHistoryUnchanged(current)).resolves.toBe(true)
      await fsp.appendFile(coincident, 'changed\n')
      await expect(rig.coincidentFreshCodexHistoryUnchanged(current)).resolves.toBe(false)
      const descriptor = external.resolveManagedExternalDescriptor({ FRESHELL_E2E_TARGET_URL: 'https://owned.trycloudflare.com',
        FRESHELL_E2E_TARGET_WS_URL: 'wss://owned.trycloudflare.com/ws', FRESHELL_E2E_TARGET_TOKEN: 'private-token',
        FRESHELL_RUNTIME_EXTERNAL_RUN_ID: rig.runtime.runId, FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: rig.runtime.candidateSha })!
      const control = external.createExternalRuntimeControl(rig, descriptor)
      const remote = new external.ExternalManagedRuntimeRig(descriptor, async (_url, init) => (
        new Response(JSON.stringify(await control(JSON.parse(String(init?.body)))), { status: 200 })
      ))
      await expect(remote.freshCodexSavedHistoryUnchanged(current)).resolves.toBe(false)
      await expect(remote.coincidentFreshCodexHistoryUnchanged(current)).resolves.toBe(false)
      await expect(remote.prepareFreshCodexSavedHistory(current)).resolves.toEqual(prepared)
      await remote.prepareCoincidentFreshCodexHistory(current)
      await expect(remote.freshCodexSavedHistoryUnchanged(current)).resolves.toBe(true)
      await expect(remote.coincidentFreshCodexHistoryUnchanged(current)).resolves.toBe(true)
      probe.mockClear()
      await expect(control({ runId: descriptor.runId, candidateSha: descriptor.candidateSha,
        scenarioId: 'browser-managed-runtime', operationId: 'foreign-codex-history-path', action: 'freshcodex-history-prepare',
        handle: current, outputPath: '/foreign/file' })).rejects.toThrow(/operation/)
      expect(probe).not.toHaveBeenCalled()
      inventory.mockResolvedValue([{ ...current, provider: 'codex', freshAgentSessionType: 'freshclaude', launchState: 'running', intentRevision: 1 }])
      probe.mockClear()
      await expect(rig.prepareFreshCodexSavedHistory(current)).rejects.toThrow(/fixture/)
      expect(probe).not.toHaveBeenCalled()
    } finally { await fsp.rm(root, { recursive: true, force: true }) }
  })
})

describe('fixed fresh Codex controller snapshot facts', () => {
  it('observes the original retained-row predicates without returning history text', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused snapshot web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'] })
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    vi.spyOn(rig, 'inventory').mockResolvedValue([{ ...current, provider: 'codex', freshAgentSessionType: 'freshcodex', launchState: 'running', intentRevision: 1 }])
    vi.spyOn(rig, 'controlEpoch').mockResolvedValue(17)
    const snapshot = { threadId: current.nativeSessionId, turns: Array.from({ length: 160 }, (_, index) => ({
      turnId: `retained-${Math.floor(index / 2)}:row-${index % 2}`, items: [{ text: index % 2 === 0 ? `Managed prompt ${index / 2}`
        : `${index === 159 ? 'Managed fixture saved answer' : `Managed retained answer ${Math.floor(index / 2)}`}\n${'x'.repeat(20_000)}` }],
    })), extensions: { codex: {} } }
    const admin = vi.spyOn(rig.runtime, 'adminOk').mockResolvedValue({ kind: 'fresh_agent_snapshot', data: snapshot })
    const facts = await rig.freshCodexRetainedSnapshotFacts(current)
    expect(facts).toEqual({ threadId: current.nativeSessionId, bytes: Buffer.byteLength(JSON.stringify(snapshot)),
      turnCount: 160, firstTurnId: 'retained-0:row-0', lastTurnId: 'retained-79:row-1',
      firstAnswerMatches: true, lastAnswerMatches: true, retentionAbsent: true })
    expect(JSON.stringify(facts)).not.toContain('Managed fixture saved answer')
    expect(facts.bytes).toBeGreaterThan(1024 * 1024)
    expect(admin).toHaveBeenCalledExactlyOnceWith(rig.supervisor, { method: 'fresh_agent_read_snapshot',
      params: { soulId: current.soulId, expectedControlEpoch: 17 } })
    const descriptor = external.resolveManagedExternalDescriptor({ FRESHELL_E2E_TARGET_URL: 'https://owned.trycloudflare.com',
      FRESHELL_E2E_TARGET_WS_URL: 'wss://owned.trycloudflare.com/ws', FRESHELL_E2E_TARGET_TOKEN: 'private-token',
      FRESHELL_RUNTIME_EXTERNAL_RUN_ID: rig.runtime.runId, FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: rig.runtime.candidateSha })!
    const control = external.createExternalRuntimeControl(rig, descriptor)
    const remote = new external.ExternalManagedRuntimeRig(descriptor, async (_url, init) => (
      new Response(JSON.stringify(await control(JSON.parse(String(init?.body)))), { status: 200 })
    ))
    await expect(remote.freshCodexRetainedSnapshotFacts(current)).resolves.toEqual(facts)
    const beforeRefusal = admin.mock.calls.length
    await expect(control({ runId: descriptor.runId, candidateSha: descriptor.candidateSha, scenarioId: 'browser-managed-runtime',
      operationId: 'foreign-snapshot-query', action: 'freshcodex-history-snapshot', handle: current, sql: 'SELECT * FROM history' })).rejects.toThrow(/operation/)
    expect(admin.mock.calls).toHaveLength(beforeRefusal)

    snapshot.turns[1].items[0].text = 'changed answer'
    await expect(rig.freshCodexRetainedSnapshotFacts(current)).resolves.toMatchObject({ firstAnswerMatches: false })
    admin.mockResolvedValue({ kind: 'fresh_agent_snapshot', data: { ...snapshot, extensions: { codex: { nativeHistoryRetention: { limit: 1 } } } } })
    await expect(rig.freshCodexRetainedSnapshotFacts(current)).resolves.toMatchObject({ retentionAbsent: false })
    admin.mockResolvedValue({ kind: 'fresh_agent_snapshot', data: { threadId: current.nativeSessionId } })
    await expect(rig.freshCodexRetainedSnapshotFacts(current)).rejects.toThrow()
  })
})

describe('fixed fresh Codex controller startup facts', () => {
  it('reads actual owned lifecycle startup and ready events with the same controller health', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-controller-startup-'))
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused startup web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'] })
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    vi.spyOn(rig, 'inventory').mockResolvedValue([{ ...current, provider: 'codex', freshAgentSessionType: 'freshcodex', launchState: 'running', intentRevision: 1 }])
    Object.assign(rig, { supervisor: { runtimeRoot: path.join(root, 'runtime') } })
    const health = vi.spyOn(rig.runtime, 'adminOk').mockResolvedValue({ kind: 'health', data: { control_epoch: 17, installation_id: 'owned-installation' } })
    const startupFinished = { event: 'supervisor.startup_scan.finished', at: 100, data: { scanned: 1, blockedSubsystems: [] } }
    const controllerReady = { event: 'supervisor.ready', at: 101, data: { controlEpoch: 17, installationId: 'owned-installation' } }
    const file = path.join(root, 'evidence', 'lifecycle.jsonl')
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, `${JSON.stringify({ event: 'gate.prepare.started', at: new Date().toISOString(), data: {} })}\n${JSON.stringify(startupFinished)}\n${JSON.stringify(controllerReady)}\n`)
    try {
      await expect(rig.freshCodexControllerStartupFacts(current)).resolves.toEqual({ controllerHealth: {
        control_epoch: 17, installation_id: 'owned-installation' }, startupFinished, controllerReady })
      expect(health).toHaveBeenCalledExactlyOnceWith(rig.supervisor, { method: 'health' })
      const descriptor = external.resolveManagedExternalDescriptor({ FRESHELL_E2E_TARGET_URL: 'https://owned.trycloudflare.com',
        FRESHELL_E2E_TARGET_WS_URL: 'wss://owned.trycloudflare.com/ws', FRESHELL_E2E_TARGET_TOKEN: 'private-token',
        FRESHELL_RUNTIME_EXTERNAL_RUN_ID: rig.runtime.runId, FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: rig.runtime.candidateSha })!
      const control = external.createExternalRuntimeControl(rig, descriptor)
      const remote = new external.ExternalManagedRuntimeRig(descriptor, async (_url, init) => (
        new Response(JSON.stringify(await control(JSON.parse(String(init?.body)))), { status: 200 })
      ))
      await expect(remote.freshCodexControllerStartupFacts(current)).resolves.toEqual({ controllerHealth: {
        control_epoch: 17, installation_id: 'owned-installation' }, startupFinished, controllerReady })
      const beforeRefusal = health.mock.calls.length
      await expect(control({ runId: descriptor.runId, candidateSha: descriptor.candidateSha, scenarioId: 'browser-managed-runtime',
        operationId: 'foreign-startup-path', action: 'freshcodex-controller-startup', handle: current, path: '/foreign/lifecycle' })).rejects.toThrow(/operation/)
      expect(health.mock.calls).toHaveLength(beforeRefusal)

      await fsp.appendFile(file, `${JSON.stringify({ ...startupFinished, at: 200, data: { scanned: 2, blockedSubsystems: ['fixture-blocker'] } })}\n`)
      await expect(rig.freshCodexControllerStartupFacts(current)).resolves.toMatchObject({ startupFinished: {
        at: 200, data: { scanned: 2, blockedSubsystems: ['fixture-blocker'] } } })
      await fsp.writeFile(file, `${JSON.stringify(startupFinished)}\n`)
      await expect(rig.freshCodexControllerStartupFacts(current)).rejects.toThrow()
      await fsp.writeFile(file, 'malformed\n')
      await expect(rig.freshCodexControllerStartupFacts(current)).rejects.toThrow()
    } finally { await fsp.rm(root, { recursive: true, force: true }) }
  })
})

describe('fixed owned session-host process state', () => {
  it('reads the exact tracked host PID and refuses absent or unobserved enclosures', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused host state web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'] })
    const enclosure = rig.runtimeEnclosureHandle(handle)
    const current = { ...handle, ...enclosure }
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    const signal = vi.spyOn(rig, 'signalOwnedSessionHostExact').mockReturnValue(process.pid)
    const record = vi.spyOn(rig.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    const container = vi.spyOn(rig, 'ownedContainerState').mockResolvedValue({ present: true, running: true })
    const pid = vi.spyOn(rig.runtime, 'ownedContainerHostPidExact').mockReturnValue(process.pid)
    await expect(rig.ownedRuntimeHostState(enclosure)).resolves.toEqual({ pid: process.pid, stopped: false })
    expect(container).toHaveBeenCalledExactlyOnceWith(enclosure)
    expect(pid).toHaveBeenCalledExactlyOnceWith(enclosure.containerId)
    const descriptor = external.resolveManagedExternalDescriptor({ FRESHELL_E2E_TARGET_URL: 'https://owned.trycloudflare.com',
      FRESHELL_E2E_TARGET_WS_URL: 'wss://owned.trycloudflare.com/ws', FRESHELL_E2E_TARGET_TOKEN: 'private-token',
      FRESHELL_RUNTIME_EXTERNAL_RUN_ID: rig.runtime.runId, FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: rig.runtime.candidateSha })!
    const control = external.createExternalRuntimeControl(rig, descriptor)
    const remote = new external.ExternalManagedRuntimeRig(descriptor, async (_url, init) => (
      new Response(JSON.stringify(await control(JSON.parse(String(init?.body)))), { status: 200 })
    ))
    await expect(remote.ownedRuntimeHostState(enclosure)).resolves.toEqual({ pid: process.pid, stopped: false })
    const beforeRefusal = pid.mock.calls.length
    await expect(control({ runId: descriptor.runId, candidateSha: descriptor.candidateSha, scenarioId: 'browser-managed-runtime',
      operationId: 'foreign-host-status-path', action: 'host-process-state', enclosure, pid: 1, path: '/proc/1/status' })).rejects.toThrow(/operation/)
    expect(pid.mock.calls).toHaveLength(beforeRefusal)

    const read = vi.spyOn(fsp, 'readFile')
    try {
      read.mockResolvedValueOnce('Name: unheld-host\nState:\tT (stopped)\n')
      await rig.ownedRuntimeHostState(enclosure)
      expect(record).not.toHaveBeenCalled()
      await rig.holdRuntimeHost(current)
      record.mockClear()
      read.mockResolvedValueOnce('Name: fixture-host\nState:\tT (stopped)\n')
      await expect(rig.ownedRuntimeHostState(enclosure)).resolves.toEqual({ pid: process.pid, stopped: true })
      expect(read).toHaveBeenCalledWith(`/proc/${process.pid}/status`, 'utf8')
      expect(record).toHaveBeenCalledExactlyOnceWith('browser.owned_host_hold', {
        containerId: current.containerId, incarnationId: current.incarnationId, pid: process.pid, state: 'T',
      })
      read.mockResolvedValueOnce('Name: fixture-host\nState:\tT (stopped)\n')
      await rig.ownedRuntimeHostState(enclosure)
      expect(record).toHaveBeenCalledTimes(1)
      await rig.releaseRuntimeHost(current)
      expect(signal).toHaveBeenLastCalledWith(current.containerId, current.incarnationId, 'SIGCONT', process.pid)
      expect(record).toHaveBeenLastCalledWith('browser.owned_host_release', {
        containerId: current.containerId, incarnationId: current.incarnationId, pid: process.pid,
      })

      container.mockResolvedValue({ present: false, running: false })
      pid.mockClear(); read.mockClear()
      await expect(rig.ownedRuntimeHostState(enclosure)).rejects.toThrow(/running/)
      expect(pid).not.toHaveBeenCalled()
      expect(read).not.toHaveBeenCalled()
      container.mockRejectedValue(new Error('recorded host boot mismatch'))
      await expect(rig.ownedRuntimeHostState(enclosure)).rejects.toThrow(/boot mismatch/)
      expect(pid).not.toHaveBeenCalled()
    } finally { read.mockRestore() }
  })
})

describe('fixed fresh Codex saved-history ownership facts', () => {
  it('counts actual matching receipts, starts, launches and scheduled recoveries', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-history-ownership-'))
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused ownership web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'] })
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    vi.spyOn(rig, 'inventory').mockResolvedValue([{ ...current, provider: 'codex', freshAgentSessionType: 'freshcodex', launchState: 'running', intentRevision: 1 }])
    Object.assign(rig, { supervisor: { runtimeRoot: path.join(root, 'runtime') } })
    rig.runtime.broker = new RestrictedDockerBroker({ realSocketPath: path.join(root, 'unused.sock'), proxySocketPath: path.join(root, 'proxy.sock'),
      runtimeRootPrefix: root, allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set(), testRunId: rig.runtime.runId, logPath: path.join(root, 'broker.jsonl') })
    const receipt = { soulId: current.soulId, incarnationId: current.incarnationId, containerId: current.containerId,
      imageRef: 'fixture', runtimeDir: root, createdAt: new Date().toISOString(), requestDigest: 'c'.repeat(64) }
    const receipts = vi.spyOn(rig.runtime.broker, 'receipts').mockReturnValue([receipt, { ...receipt, soulId: 'other-soul' }])
    const start = { at: new Date().toISOString(), severity: 'info', method: 'POST', url: `/v1.47/containers/${current.containerId}/start`,
      decision: 'forward', containerId: current.containerId, destructive: false, unsafeAttempt: false } as const
    const events = vi.spyOn(rig.runtime.broker, 'eventsSnapshot').mockReturnValue([start, { ...start, url: '/v1.47/containers/other/start' }])
    const launch = { event: 'supervisor.launch_running', at: 100, data: { soulId: current.soulId,
      incarnationId: current.incarnationId, containerId: current.containerId, workerLaunchCount: 1 } }
    const file = path.join(root, 'evidence', 'lifecycle.jsonl')
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, `${JSON.stringify(launch)}\n${JSON.stringify({ ...launch, data: { ...launch.data, soulId: 'other-soul' } })}\n`)
    try {
      await expect(rig.freshCodexSavedHistoryOwnershipFacts(current)).resolves.toEqual({ receiptContainerIds: [current.containerId],
        startCount: 1, launches: [launch], targetSoulRecoveries: [] })
      const descriptor = external.resolveManagedExternalDescriptor({ FRESHELL_E2E_TARGET_URL: 'https://owned.trycloudflare.com',
        FRESHELL_E2E_TARGET_WS_URL: 'wss://owned.trycloudflare.com/ws', FRESHELL_E2E_TARGET_TOKEN: 'private-token',
        FRESHELL_RUNTIME_EXTERNAL_RUN_ID: rig.runtime.runId, FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: rig.runtime.candidateSha })!
      const control = external.createExternalRuntimeControl(rig, descriptor)
      const remote = new external.ExternalManagedRuntimeRig(descriptor, async (_url, init) => (
        new Response(JSON.stringify(await control(JSON.parse(String(init?.body)))), { status: 200 })
      ))
      await expect(remote.freshCodexSavedHistoryOwnershipFacts(current)).resolves.toEqual({ receiptContainerIds: [current.containerId],
        startCount: 1, launches: [launch], targetSoulRecoveries: [] })
      await expect(control({ runId: descriptor.runId, candidateSha: descriptor.candidateSha, scenarioId: 'browser-managed-runtime',
        operationId: 'foreign-ownership-path', action: 'freshcodex-history-ownership', handle: current, path: '/foreign/lifecycle' })).rejects.toThrow(/operation/)
      receipts.mockReturnValue([receipt, receipt]); events.mockReturnValue([start, start])
      const recovery = { event: 'supervisor.runtime_observer.recovery_scheduled', at: 200, data: { soulId: current.soulId } }
      await fsp.appendFile(file, `${JSON.stringify(recovery)}\n`)
      await expect(rig.freshCodexSavedHistoryOwnershipFacts(current)).resolves.toEqual({ receiptContainerIds: [current.containerId, current.containerId],
        startCount: 2, launches: [launch], targetSoulRecoveries: [recovery] })
      await fsp.appendFile(file, 'malformed\n')
      await expect(rig.freshCodexSavedHistoryOwnershipFacts(current)).rejects.toThrow()
    } finally { await fsp.rm(root, { recursive: true, force: true }) }
  })
})

describe('fixed saved-history measurement lifecycle', () => {
  it('records the same browser timing metadata only for the registered fixture', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused measurement web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'] })
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    const inventory = vi.spyOn(rig, 'inventory').mockResolvedValue([{ ...current, provider: 'codex', freshAgentSessionType: 'freshcodex', launchState: 'running', intentRevision: 1 }])
    const record = vi.spyOn(rig.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    const measurement: owner.FreshCodexHistoryMeasurementStart = { kind: 'owned-page saved-history diagnostic', errors: [], browserBeforeReload: { timeOrigin: 1, now: 2 },
      cpuStartRequestedAt: 3, cpuStartedAt: 4 }
    await rig.startFreshCodexSavedHistoryMeasurement(current, measurement)
    expect(record).toHaveBeenCalledExactlyOnceWith('browser.saved_history_measurement.started', measurement)
    const descriptor = external.resolveManagedExternalDescriptor({ FRESHELL_E2E_TARGET_URL: 'https://owned.trycloudflare.com',
      FRESHELL_E2E_TARGET_WS_URL: 'wss://owned.trycloudflare.com/ws', FRESHELL_E2E_TARGET_TOKEN: 'private-token',
      FRESHELL_RUNTIME_EXTERNAL_RUN_ID: rig.runtime.runId, FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: rig.runtime.candidateSha })!
    const control = external.createExternalRuntimeControl(rig, descriptor)
    const remote = new external.ExternalManagedRuntimeRig(descriptor, async (_url, init) => (
      new Response(JSON.stringify(await control(JSON.parse(String(init?.body)))), { status: 200 })
    ))
    await remote.startFreshCodexSavedHistoryMeasurement(current, measurement)
    expect(record).toHaveBeenNthCalledWith(2, 'browser.saved_history_measurement.started', measurement)
    await expect(control({ runId: descriptor.runId, candidateSha: descriptor.candidateSha, scenarioId: 'browser-managed-runtime',
      operationId: 'foreign-measurement-body', action: 'freshcodex-history-measurement-start', handle: current,
      historyMeasurementStart: { ...measurement, errors: ['private conversation text'] } })).rejects.toThrow(/operation/)

    await expect(rig.startFreshCodexSavedHistoryMeasurement(current, { ...measurement, transcript: 'private text' })).rejects.toThrow()
    expect(record).toHaveBeenCalledTimes(2)
    inventory.mockResolvedValue([{ ...current, provider: 'codex', freshAgentSessionType: 'freshclaude', launchState: 'running', intentRevision: 1 }])
    await expect(rig.startFreshCodexSavedHistoryMeasurement(current, measurement)).rejects.toThrow(/fixture/)
    expect(record).toHaveBeenCalledTimes(2)
  })
})

describe('fixed saved-history measurement completion', () => {
  it('records original completion timings after verifying the recorded enclosure', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused completion web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'] })
    const enclosure = rig.runtimeEnclosureHandle(handle)
    const tracked = vi.spyOn(rig, 'ownedContainerState').mockResolvedValue({ present: false, running: false })
    const record = vi.spyOn(rig.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    const measurement: owner.FreshCodexHistoryMeasurementFinish = { cpuStartRequestedAt: 1, cpuStartedAt: 2,
      cpuStopRequestedAt: 3, cpuStoppedAt: 4, errors: ['owned CDP detach failed'] }
    await rig.finishFreshCodexSavedHistoryMeasurement(enclosure, measurement)
    expect(tracked).toHaveBeenCalledExactlyOnceWith(enclosure)
    expect(record).toHaveBeenCalledExactlyOnceWith('browser.saved_history_measurement.finished', measurement)
    const descriptor = external.resolveManagedExternalDescriptor({ FRESHELL_E2E_TARGET_URL: 'https://owned.trycloudflare.com',
      FRESHELL_E2E_TARGET_WS_URL: 'wss://owned.trycloudflare.com/ws', FRESHELL_E2E_TARGET_TOKEN: 'private-token',
      FRESHELL_RUNTIME_EXTERNAL_RUN_ID: rig.runtime.runId, FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: rig.runtime.candidateSha })!
    const control = external.createExternalRuntimeControl(rig, descriptor)
    const remote = new external.ExternalManagedRuntimeRig(descriptor, async (_url, init) => (
      new Response(JSON.stringify(await control(JSON.parse(String(init?.body)))), { status: 200 })
    ))
    await remote.finishFreshCodexSavedHistoryMeasurement(enclosure, measurement)
    expect(record).toHaveBeenNthCalledWith(2, 'browser.saved_history_measurement.finished', measurement)
    await expect(control({ runId: descriptor.runId, candidateSha: descriptor.candidateSha, scenarioId: 'browser-managed-runtime',
      operationId: 'foreign-measurement-finish-body', action: 'freshcodex-history-measurement-finish', enclosure,
      historyMeasurementFinish: { ...measurement, errors: ['private conversation text'] } })).rejects.toThrow(/operation/)

    tracked.mockRejectedValue(new Error('recorded boot mismatch'))
    await expect(rig.finishFreshCodexSavedHistoryMeasurement(enclosure, measurement)).rejects.toThrow(/boot mismatch/)
    expect(record).toHaveBeenCalledTimes(2)
    tracked.mockResolvedValue({ present: false, running: false })
    await expect(rig.finishFreshCodexSavedHistoryMeasurement(enclosure, { ...measurement, transcript: 'private text' })).rejects.toThrow()
    expect(record).toHaveBeenCalledTimes(2)
    const unregistered = new owner.ManagedRuntimeOwner(() => { throw new Error('unused unregistered web') }, fixtureRepoRoot, 3)
    await expect(unregistered.finishFreshCodexSavedHistoryMeasurement(enclosure, measurement)).rejects.toThrow(/fixture/)
  })
})

describe('fixed saved-history controller reattachment lifecycle', () => {
  it('records original reattachment metadata with its complete private startup events', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-controller-reattach-'))
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused reattachment web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'] })
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    const reattached = { ...current, provider: 'codex', freshAgentSessionType: 'freshcodex', launchState: 'running', intentRevision: 1 }
    vi.spyOn(rig, 'inventory').mockResolvedValue([reattached])
    Object.assign(rig, { supervisor: { runtimeRoot: path.join(root, 'runtime'), containerId: 'c'.repeat(64) } })
    const record = vi.spyOn(rig.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    const startupFinished = { event: 'supervisor.startup_scan.finished', at: 100, data: { scanned: 1, blockedSubsystems: [] } }
    const controllerReady = { event: 'supervisor.ready', at: 101, data: { controlEpoch: 17, installationId: 'owned-installation' } }
    const privateReady = { ...controllerReady, data: { ...controllerReady.data, privateStartupDiagnostic: 'owner-only metadata' } }
    const file = path.join(root, 'evidence', 'lifecycle.jsonl')
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, `${JSON.stringify(startupFinished)}\n${JSON.stringify(privateReady)}\n`)
    const input: owner.FreshCodexControllerReattachment = { oldControllerId: 'b'.repeat(64), currentControllerId: 'c'.repeat(64),
      oldControlEpoch: 16, currentControlEpoch: 17, controllerRestartStartedAt: 99, controllerReady, startupFinished,
      reattached: { soulId: current.soulId, incarnationId: current.incarnationId, containerId: current.containerId,
        hostBootId: current.hostBootId, nativeSessionId: current.nativeSessionId, intentRevision: 1, launchState: 'running',
        provider: 'codex', freshAgentSessionType: 'freshcodex' }, completedAt: 102 }
    try {
      await rig.recordFreshCodexControllerReattachment(current, input)
      expect(record).toHaveBeenCalledExactlyOnceWith('browser.owned_controller_reattached', { ...input, controllerReady: privateReady })
      const descriptor = external.resolveManagedExternalDescriptor({ FRESHELL_E2E_TARGET_URL: 'https://owned.trycloudflare.com',
        FRESHELL_E2E_TARGET_WS_URL: 'wss://owned.trycloudflare.com/ws', FRESHELL_E2E_TARGET_TOKEN: 'private-token',
        FRESHELL_RUNTIME_EXTERNAL_RUN_ID: rig.runtime.runId, FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: rig.runtime.candidateSha })!
      const control = external.createExternalRuntimeControl(rig, descriptor)
      const replies: unknown[] = []
      const remote = new external.ExternalManagedRuntimeRig(descriptor, async (_url, init) => {
        const reply = await control(JSON.parse(String(init?.body)))
        replies.push(reply)
        return new Response(JSON.stringify(reply), { status: 200 })
      })
      await remote.recordFreshCodexControllerReattachment(current, input)
      expect(JSON.stringify(replies)).not.toContain('owner-only metadata')
      expect(record).toHaveBeenNthCalledWith(2, 'browser.owned_controller_reattached', { ...input, controllerReady: privateReady })
      await expect(rig.recordFreshCodexControllerReattachment(current, { ...input,
        controllerReady: { ...controllerReady, data: { ...controllerReady.data, installationId: 'foreign-installation' } } })).rejects.toThrow(/owned lifecycle/)
      await expect(rig.recordFreshCodexControllerReattachment(current, { ...input,
        reattached: { ...input.reattached, nativeSessionId: 'foreign-root' } })).rejects.toThrow(/reattached/)

      await expect(rig.recordFreshCodexControllerReattachment(current, { ...input, currentControllerId: 'd'.repeat(64) })).rejects.toThrow(/controller/)
      await expect(rig.recordFreshCodexControllerReattachment(current, { ...input, reattached: { ...input.reattached, transcript: 'private text' } })).rejects.toThrow()
      expect(record).toHaveBeenCalledTimes(2)
    } finally { await fsp.rm(root, { recursive: true, force: true }) }
  })
})

describe('fixed saved-history render measurement publication', () => {
  it('publishes existing sanitized profiler and audit metadata privately before cleanup', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-history-measurement-'))
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused measurement artifact web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'] })
    Object.assign(rig.runtime, { browserDir: root })
    const enclosure = rig.runtimeEnclosureHandle(handle)
    vi.spyOn(rig, 'ownedContainerState').mockResolvedValue({ present: false, running: false })
    vi.spyOn(rig.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    const measurement: owner.FreshCodexSavedHistoryMeasurement = { kind: 'owned-page saved-history diagnostic', errors: [],
      browserBeforeReload: { timeOrigin: 1, now: 2 }, cpuStartRequestedAt: 3, cpuStartedAt: 4,
      cpuStopRequestedAt: 5, cpuStoppedAt: 6, finallyEnteredAt: 7,
      cpu: { startTimeUs: 1000, endTimeUs: 2000, sampledDurationMs: 1, sampleCount: 1,
        topLeaves: [{ functionName: 'render', script: 'index-fixture.js', line: 1, column: 2,
          samples: 1, durationMs: 1, stack: [{ functionName: '(root)', script: 'native-or-anonymous' }] }],
        seconds: [{ second: 0, durationMs: 1, samples: 1, idleMs: 0 }] },
      audit: { timeOrigin: 1, extractedAtMs: 2, available: true, cutoffWallMs: 7, requestRecordCount: 1,
        requestRecordsReturned: 1, requestRecordsDropped: 0, requestRecords: [{ sequence: 0, stage: 'display_committed', rows: 160, live: false }],
        events: [{ sequence: 0, event: 'perf.api_slow', route: 'native-thread-snapshot', durationMs: 1, status: 200 }] } }
    try {
      const result = await rig.publishFreshCodexSavedHistoryMeasurement(enclosure, measurement)
      const file = path.join(root, 'saved-history-render-measurement.json')
      const raw = await fsp.readFile(file, 'utf8')
      expect(JSON.parse(raw)).toEqual(measurement)
      expect((await fsp.stat(file)).mode & 0o777).toBe(0o600)
      const { createHash } = await import('node:crypto')
      expect(result).toEqual({ artifactRef: `saved-history-render-measurement:${createHash('sha256').update(raw).digest('hex')}` })
      expect(JSON.stringify(result)).not.toContain(root)
      const descriptor = external.resolveManagedExternalDescriptor({ FRESHELL_E2E_TARGET_URL: 'https://owned.trycloudflare.com',
        FRESHELL_E2E_TARGET_WS_URL: 'wss://owned.trycloudflare.com/ws', FRESHELL_E2E_TARGET_TOKEN: 'private-token',
        FRESHELL_RUNTIME_EXTERNAL_RUN_ID: rig.runtime.runId, FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: rig.runtime.candidateSha })!
      const control = external.createExternalRuntimeControl(rig, descriptor)
      const remote = new external.ExternalManagedRuntimeRig(descriptor, async (_url, init) => (
        new Response(JSON.stringify(await control(JSON.parse(String(init?.body)))), { status: 200 })
      ))
      await expect(remote.publishFreshCodexSavedHistoryMeasurement(enclosure, measurement)).resolves.toEqual(result)
      await expect(control({ runId: descriptor.runId, candidateSha: descriptor.candidateSha, scenarioId: 'browser-managed-runtime',
        operationId: 'foreign-profiler-path', action: 'freshcodex-history-measurement-artifact', enclosure,
        historyMeasurement: measurement, outputPath: '/foreign/measurement' })).rejects.toThrow(/operation/)
      const audit = measurement.audit
      if (!audit) throw new Error('measurement test requires its audit fixture')
      await expect(rig.publishFreshCodexSavedHistoryMeasurement(enclosure, { ...measurement,
        audit: { ...audit, requestRecords: [{ sequence: 0, transcript: 'private text' }] } })).rejects.toThrow()

      await expect(rig.publishFreshCodexSavedHistoryMeasurement(enclosure, { ...measurement, transcript: 'private text' })).rejects.toThrow()
      expect(await fsp.readFile(file, 'utf8')).toBe(raw)
    } finally { await fsp.rm(root, { recursive: true, force: true }) }
  })
})

describe('fixed owned saved-history preservation artifact', () => {
  it('preserves captured private fixture profiles and lifecycle evidence without a body or path channel', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-history-preservation-'))
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused preservation web') }, fixtureRepoRoot, 3,
      {}, {}, 'test', { enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'] })
    Object.assign(rig.runtime, { browserDir: root })
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    const enclosure = rig.runtimeEnclosureHandle(current)
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    vi.spyOn(rig, 'inventory').mockResolvedValue([{ ...current, provider: 'codex', freshAgentSessionType: 'freshcodex', launchState: 'running', intentRevision: 1 }])
    vi.spyOn(rig, 'ownedContainerState').mockResolvedValue({ present: true, running: true })
    vi.spyOn(rig, 'freshCodexSavedHistoryUnchanged').mockResolvedValue(true)
    const coincident = vi.spyOn(rig, 'coincidentFreshCodexHistoryUnchanged').mockResolvedValue(true)
    Object.assign(rig.runtime, { lifecyclePath: path.join(root, 'owner', 'lifecycle.jsonl') })
    const record = vi.spyOn(rig.runtime, 'recordLifecycle')
    const state = { nativeSessionId: current.nativeSessionId, pendingDecisionId: null, dispatchCount: 1, completionCount: 1 }
    const privateState = { ...state, schemaVersion: 1, createProfile: { fixtureTransport: true, privateReference: 'owner-only-profile' } }
    vi.spyOn(rig.runtime, 'fixtureNativeState').mockImplementation(async (_instance, address, capture) => {
      capture?.(privateState)
      return owner.decodeFixtureNativeState(privateState, address.nativeSessionId)
    })
    const observedState = await rig.fixtureNativeState(current)
    const startupFinished = { event: 'supervisor.startup_scan.finished', at: 100, data: { scanned: 1, blockedSubsystems: [] } }
    const controllerReady = { event: 'supervisor.ready', at: 101, data: { controlEpoch: 17, installationId: 'owned-installation' } }
    const launch = { event: 'supervisor.launch_running', at: 90, data: { soulId: current.soulId,
      incarnationId: current.incarnationId, containerId: current.containerId, workerLaunchCount: 1 } }
    const controllerReattachment = { oldControllerId: 'b'.repeat(64), currentControllerId: 'c'.repeat(64), oldControlEpoch: 16,
      currentControlEpoch: 17, controllerRestartStartedAt: 99, controllerReady, startupFinished,
      reattached: { soulId: current.soulId, incarnationId: current.incarnationId, containerId: current.containerId,
        hostBootId: current.hostBootId, nativeSessionId: current.nativeSessionId, intentRevision: 1, launchState: 'running' }, completedAt: 102 }
    Object.assign(rig, { supervisor: { runtimeRoot: path.join(root, 'runtime'), containerId: 'c'.repeat(64) } })
    const lifecycle = path.join(root, 'evidence', 'lifecycle.jsonl')
    await fsp.mkdir(path.dirname(lifecycle), { recursive: true })
    const privateLaunch = { ...launch, data: { ...launch.data, privateLaunchReference: 'owner-only-launch' } }
    const privateStartup = { ...startupFinished, data: { ...startupFinished.data, privateScanReference: 'owner-only-scan' } }
    const privateController = { ...controllerReattachment, startupFinished: privateStartup }
    await fsp.writeFile(lifecycle, [privateLaunch, privateStartup, controllerReady]
      .map(value => JSON.stringify(value)).join('\n')+'\n')
    await rig.recordFreshCodexControllerReattachment(current, controllerReattachment)
    const input: owner.FreshCodexSavedHistoryPreservation = { source: 'owned provider-volume native history',
      wrongSource: 'coincident web-local native history', heldHost: { containerId: current.containerId, incarnationId: current.incarnationId, pid: 42 },
      bootstrap: { type: 'pane.reconcile.request', reconcileId: 'reconcile-owned', panes: [{ paneKey: 'tab:pane', kind: 'fresh-agent',
        mode: 'codex', createRequestId: 'request-owned', sessionRef: { provider: 'codex', sessionId: current.nativeSessionId } }] },
      bootstrapCreates: [], nativeSessionId: current.nativeSessionId, beforeHistory: observedState, afterReload: observedState,
      originalIdentity: { sessionRef: { provider: 'codex', sessionId: current.nativeSessionId }, createRequestId: 'request-owned', soulId: current.soulId },
      managedLaunch: launch, bothSourcesUnchanged: true, observerWindow: { intervalMs: 60000, controllerReattachment, startupFinished,
        firstObservationNotBefore: 60100, holdRequestedAt: 103, heldAt: 104, releasedAt: 105, resumedAt: 106, targetSoulRecoveries: [] } }
    try {
      const result = await rig.publishFreshCodexSavedHistoryPreservation(current, input)
      const file = path.join(root, 'owned-host-history-preservation.json')
      const raw = await fsp.readFile(file, 'utf8')
      expect(JSON.parse(raw)).toEqual({ ...input, beforeHistory: privateState, afterReload: privateState, managedLaunch: privateLaunch,
        observerWindow: { ...input.observerWindow, controllerReattachment: privateController, startupFinished: privateStartup } })
      expect((await fsp.stat(file)).mode & 0o777).toBe(0o600)
      const { createHash } = await import('node:crypto')
      expect(result).toEqual({ artifactRef: `owned-host-history-preservation:${createHash('sha256').update(raw).digest('hex')}` })
      expect(JSON.stringify(result)).not.toContain('owner-only')
      const descriptor = external.resolveManagedExternalDescriptor({ FRESHELL_E2E_TARGET_URL: 'https://owned.trycloudflare.com',
        FRESHELL_E2E_TARGET_WS_URL: 'wss://owned.trycloudflare.com/ws', FRESHELL_E2E_TARGET_TOKEN: 'private-token',
        FRESHELL_RUNTIME_EXTERNAL_RUN_ID: rig.runtime.runId, FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: rig.runtime.candidateSha })!
      const control = external.createExternalRuntimeControl(rig, descriptor)
      const replies: unknown[] = []
      const remote = new external.ExternalManagedRuntimeRig(descriptor, async (_url, init) => {
        const reply = await control(JSON.parse(String(init?.body)))
        replies.push(reply)
        return new Response(JSON.stringify(reply), { status: 200 })
      })
      await expect(remote.publishFreshCodexSavedHistoryPreservation(current, input)).resolves.toEqual(result)
      expect(JSON.stringify(replies)).not.toContain('owner-only')
      await expect(control({ runId: descriptor.runId, candidateSha: descriptor.candidateSha, scenarioId: 'browser-managed-runtime',
        operationId: 'foreign-history-preservation-path', action: 'freshcodex-history-preservation-artifact', handle: current,
        historyPreservation: input, outputPath: '/foreign/history' })).rejects.toThrow(/operation/)
      const recordedOwnerLifecycle = await fsp.readFile(rig.runtime.lifecyclePath, 'utf8')
      await fsp.writeFile(rig.runtime.lifecyclePath, '')
      // The supervisor's log cannot substitute for the private owner's actual observation.
      await fsp.appendFile(lifecycle, JSON.stringify({ event: 'browser.owned_controller_reattached',
        at: 'wrong-source-time', data: privateController })+'\n')
      await expect(rig.publishFreshCodexSavedHistoryPreservation(current, input)).rejects.toThrow(/recorded owned controller/)
      expect(record).toHaveBeenLastCalledWith('external.saved_history_preservation_refused', {
        severity: 'warn', ...current, stage: 'controller_reattachment',
      })
      await fsp.writeFile(rig.runtime.lifecyclePath, recordedOwnerLifecycle)
      await expect(rig.publishFreshCodexSavedHistoryPreservation(current, input)).resolves.toEqual(result)

      record.mockClear()
      await expect(rig.publishFreshCodexSavedHistoryPreservation(current, { ...input, beforeHistory: { ...state, completionCount: 99 } })).rejects.toThrow(/captured/)
      expect(record).toHaveBeenLastCalledWith('external.saved_history_preservation_refused', {
        severity: 'warn', ...current, stage: 'captured_states',
      })

      coincident.mockResolvedValue(false)
      await expect(rig.publishFreshCodexSavedHistoryPreservation(current, input)).rejects.toThrow(/unchanged/)
      expect(record).toHaveBeenLastCalledWith('external.saved_history_preservation_refused', {
        severity: 'warn', ...current, stage: 'history_sources',
      })
      await expect(rig.publishFreshCodexSavedHistoryPreservation(current, { ...input, transcript: 'private text' })).rejects.toThrow()
      expect(record).toHaveBeenLastCalledWith('external.saved_history_preservation_refused', {
        severity: 'warn', ...current, stage: 'input_validation',
      })
      expect(JSON.stringify(record.mock.calls)).not.toMatch(/owner-only|private text|privateReference|transcript/)
      expect(await fsp.readFile(file, 'utf8')).toBe(raw)
      vi.spyOn(rig.runtime, 'fixtureNativeState').mockImplementation(async (_instance, address, capture) => {
        capture?.({ ...privateState, createProfile: { fixtureTransport: true, privateReference: 'conflicting-profile' } })
        return owner.decodeFixtureNativeState(privateState, address.nativeSessionId)
      })
      await expect(rig.fixtureNativeState(current)).rejects.toThrow(/changed without/)
    } finally { await fsp.rm(root, { recursive: true, force: true }) }
  })
})

describe('private fixture-state capture boundary', () => {
  it('captures complete private values only after existing identity and counter decoding succeeds', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused fixture capture web') }, fixtureRepoRoot, 3)
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    Object.assign(rig.runtime, { broker: { receipts: () => [{ soulId: current.soulId, incarnationId: current.incarnationId, containerId: current.containerId }] } })
    vi.spyOn(rig.runtime, 'adminOk').mockResolvedValue({ kind: 'inventory', data: [{ ...current, launchState: 'running' }] })
    const raw = { nativeSessionId: current.nativeSessionId, pendingDecisionId: null, dispatchCount: 1, completionCount: 1,
      schemaVersion: 1, createProfile: { fixtureTransport: true } }
    const read = vi.spyOn(rig.runtime, 'execOwnedContainerAsExact').mockReturnValue(JSON.stringify(raw))
    const captured = vi.fn()
    await expect(rig.runtime.fixtureNativeState(rig.supervisor, current, captured)).resolves.toEqual({
      nativeSessionId: current.nativeSessionId, pendingDecisionId: null, dispatchCount: 1, completionCount: 1 })
    expect(captured).toHaveBeenCalledExactlyOnceWith(raw)
    read.mockReturnValue(JSON.stringify({ ...raw, nativeSessionId: 'foreign-root' }))
    await expect(rig.runtime.fixtureNativeState(rig.supervisor, current, captured)).rejects.toThrow(/conflicting/)
    expect(captured).toHaveBeenCalledTimes(1)
  })
})

describe('finite Phase 4 browser receipt publication', () => {
  it('writes the existing observation privately on its owner and refuses worker paths or transcript fields', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-phase4-receipt-'))
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused phase4 web') }, fixtureRepoRoot, 4)
    const file = path.join(root, 'phase4.json')
    vi.stubEnv('FRESHELL_RUNTIME_PHASE4_BROWSER_RECEIPT', file)
    vi.spyOn(rig.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    const browser = { browserInteraction: true, coldStartAgents: 3, restartCycles: 3, deterministicPlacement: true,
      singleViewPerIntent: true, existingLayoutPreserved: true, focusStable: false,
      expectedFocus: { activeTabId: 'saved-tab', activePaneId: 'saved-pane' },
      focusObservations: [{ stage: 'rehydration', activeTabId: 'other-tab', activePaneId: null }],
      sameSoulIds: true, noBlankSubstitution: true, closeViewKeepsAgent: true,
      closeViewNotRecreatedAfterInventoryRefresh: true, stopAgentStopsRuntime: true, oldClientNoDuplicate: true,
      initialSoulIds: ['soul1', 'soul2', 'soul3'], expectedTabIds: ['tab1', 'tab2', 'tab3'],
      expectedPaneIds: ['pane1', 'pane2', 'pane3'], browserTabId: 'saved-tab', createdTabIds: ['tab1', 'tab2', 'tab3'] }
    try {
      const result = await rig.publishPhase4BrowserReceipt(browser)
      const raw = await fsp.readFile(file, 'utf8')
      expect(JSON.parse(raw)).toEqual({ schemaVersion: 1, status: 'PASS', candidateSha: rig.runtime.candidateSha, browser })
      expect(JSON.parse(raw).browser.focusStable).toBe(false)
      expect((await fsp.stat(file)).mode & 0o777).toBe(0o600)
      const { createHash } = await import('node:crypto')
      expect(result).toEqual({ artifactRef: `phase4-browser:${createHash('sha256').update(raw).digest('hex')}` })
      expect(JSON.stringify(result)).not.toContain(root)
      const descriptor = external.resolveManagedExternalDescriptor({ FRESHELL_E2E_TARGET_URL: 'https://owned.trycloudflare.com',
        FRESHELL_E2E_TARGET_WS_URL: 'wss://owned.trycloudflare.com/ws', FRESHELL_E2E_TARGET_TOKEN: 'private-token',
        FRESHELL_RUNTIME_EXTERNAL_RUN_ID: rig.runtime.runId, FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: rig.runtime.candidateSha })!
      const control = external.createExternalRuntimeControl(rig, descriptor)
      const remote = new external.ExternalManagedRuntimeRig(descriptor, async (_url, init) => (
        new Response(JSON.stringify(await control(JSON.parse(String(init?.body)))), { status: 200 })
      ))
      await expect(remote.publishPhase4BrowserReceipt(browser)).resolves.toEqual(result)
      expect(await fsp.readFile(file, 'utf8')).toBe(raw)
      await expect(control({ runId: descriptor.runId, candidateSha: descriptor.candidateSha, operationId: 'foreign-phase4-path', scenarioId: 'browser-managed-runtime',
        action: 'phase4-browser-receipt', phase4Browser: browser, outputPath: '/foreign/file' })).rejects.toThrow(/operation/)
      await expect(control({ runId: 'foreign', candidateSha: descriptor.candidateSha, operationId: 'foreign-phase4-run', scenarioId: 'browser-managed-runtime',
        action: 'phase4-browser-receipt', phase4Browser: browser })).rejects.toThrow(/owned run/)
      await expect(rig.publishPhase4BrowserReceipt({ ...browser, transcript: 'private text' })).rejects.toThrow()
      await expect(rig.publishPhase4BrowserReceipt({ ...browser, outputPath: '/foreign/file' })).rejects.toThrow()
      const other = new owner.ManagedRuntimeOwner(() => { throw new Error('unused phase3 web') }, fixtureRepoRoot, 3)
      await expect(other.publishPhase4BrowserReceipt(browser)).rejects.toThrow(/Phase 4/)
      expect(await fsp.readFile(file, 'utf8')).toBe(raw)
    } finally { vi.unstubAllEnvs(); await fsp.rm(root, { recursive: true, force: true }) }
  })
})

describe('finite Phase 3 approval effect operations', () => {
  it('publishes the existing browser observation on the owner without returning a filesystem path', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-p3-receipt-'))
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') }, fixtureRepoRoot, 3)
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    vi.spyOn(rig.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    const file = path.join(root, 'browser.json')
    vi.stubEnv('FRESHELL_RUNTIME_PHASE3_BROWSER_RECEIPT', file)
    const browser: owner.Phase3BrowserObservation = { browserInteraction: true, provider: 'opencode', providerVersion: '1.18.21', model: 'openai/gpt-5.6-luna',
      paneId: 'pane', terminalId: 'terminal', soulId: current.soulId, incarnationIdBefore: 'old-incarnation', incarnationIdAfter: current.incarnationId,
      providerSessionIdBefore: current.nativeSessionId, providerSessionIdAfter: current.nativeSessionId, approvalPromptNativeId: current.nativeSessionId,
      permissionPromptHandled: true, approvalSurvived: true, samePane: true, visibleRecoveryState: true, rejectedInputWhileRecovering: true,
      accidentalApproval: false, toolCompletedExactlyOnce: true, providerHostSurvivedWebRestart: true, followUpCompleted: true,
      followUpResponse: 'P3_FOLLOWUP_OK' }
    try {
      const result = await rig.publishPhase3BrowserReceipt(current, browser)
      expect(result).toEqual({ artifactRef: expect.stringMatching(/^phase3-browser:[a-f0-9]{64}$/) })
      expect(JSON.parse(await fsp.readFile(file, 'utf8'))).toEqual({ schemaVersion: 1, status: 'PASS', candidateSha: current.candidateSha, browser })
      await expect(rig.publishPhase3BrowserReceipt(current, { ...browser, providerSessionIdAfter: 'foreign' })).rejects.toThrow(/address|native/)
    } finally { vi.unstubAllEnvs(); await fsp.rm(root, { recursive: true, force: true }) }
  })
  it('resets and counts only the existing owned marker file before native identity materializes', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-p3-effect-'))
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') }, fixtureRepoRoot, 3)
    const enclosure = rig.runtimeEnclosureHandle(handle)
    const row = { ...enclosure, provider: 'opencode', nativeSessionId: undefined, launchState: 'running', intentRevision: 1 }
    const inventory = vi.spyOn(rig, 'inventory').mockResolvedValue([row])
    rig.runtime.broker = new RestrictedDockerBroker({ realSocketPath: path.join(root, 'unused.sock'), proxySocketPath: path.join(root, 'proxy.sock'),
      runtimeRootPrefix: root, allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set(), testRunId: rig.runtime.runId, logPath: path.join(root, 'broker.jsonl') })
    vi.spyOn(rig.runtime.broker, 'receipts').mockReturnValue([{ ...enclosure, imageRef: 'owned-image', runtimeDir: root,
      createdAt: new Date().toISOString(), requestDigest: 'd'.repeat(64) }])
    const probe = vi.spyOn(rig, 'ownedProviderExec').mockImplementation(async (containerId, args) => {
      expect(containerId).toBe(enclosure.containerId)
      return execFileSync(args[0], [...args.slice(1)], { env: { ...process.env, HOME: root }, encoding: 'utf8' })
    })
    try {
      await fsp.writeFile(path.join(root, 'p3-tool-effect-count'), 'old\nold\n')
      await expect(rig.phase3ApprovalEffectCount(enclosure)).resolves.toBe(2)
      await rig.resetPhase3ApprovalEffect(enclosure)
      await expect(rig.phase3ApprovalEffectCount(enclosure)).resolves.toBe(0)
      await fsp.writeFile(path.join(root, 'p3-tool-effect-count'), 'P3_APPROVAL_EFFECT\n')
      await expect(rig.phase3ApprovalEffectCount(enclosure)).resolves.toBe(1)
      probe.mockClear()
      await expect(rig.resetPhase3ApprovalEffect({ ...enclosure, hostBootId: 'foreign' })).rejects.toThrow(/current|enclosure/)
      expect(probe).not.toHaveBeenCalled()
      inventory.mockResolvedValue([{ ...row, provider: 'codex' }])
      await expect(rig.phase3ApprovalEffectCount(enclosure)).rejects.toThrow(/OpenCode/)
      expect(probe).not.toHaveBeenCalled()
    } finally { await fsp.rm(root, { recursive: true, force: true }) }
  })
})

describe('owner-side synthetic OpenCode source preparation', () => {
  it('returns only a new matching no-tool follow-up ID from the existing private native history', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') }, fixtureRepoRoot, 3)
    vi.spyOn(rig.runtime, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    try {
      const source = await rig.prepareSyntheticOpenCodeSource()
      const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha, nativeSessionId: source.rootId }
      const marker = `SYNTHETIC_FOLLOWUP_${source.nonce}`
      const turns = [
        { messageId: source.lastMessageId, text: marker, toolCalls: [] },
        { messageId: 'new-tool-turn', text: marker, toolCalls: [{ id: 'tool-call' }] },
        { messageId: 'other-marker-turn', text: 'other synthetic marker', toolCalls: [] },
        { messageId: 'new-matching-turn', text: marker, toolCalls: [] },
      ]
      const probe = vi.spyOn(rig, 'ownedProviderExec').mockResolvedValue(JSON.stringify({ turns }))
      await expect(rig.syntheticOpenCodeFollowUpMessageId(current)).resolves.toBe('new-matching-turn')
      probe.mockResolvedValue(JSON.stringify({ turns: turns.slice(0, 3) }))
      await expect(rig.syntheticOpenCodeFollowUpMessageId(current)).resolves.toBeNull()
    } finally { vi.unstubAllEnvs(); await rig.stop() }
  })

  it('binds the existing authenticated adoption result to the registered source and current native address', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') }, fixtureRepoRoot, 3)
    vi.spyOn(rig.runtime, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    try {
      const source = await rig.prepareSyntheticOpenCodeSource()
      const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha, nativeSessionId: source.rootId }
      const view = { ...current, terminalId: 'owned-source-terminal', launchState: 'running', intentRevision: 1 }
      vi.spyOn(rig, 'inventory').mockResolvedValue([{ ...view, incarnationId: 'prior-source-incarnation',
        containerId: 'c'.repeat(64), hostBootId: 'prior-source-boot', launchState: 'stopped' }, view])
      const observation = { terminalId: view.terminalId, rootSessionId: source.rootId, tailMessageId: source.lastMessageId,
        evidenceGeneration: 'a'.repeat(64), incarnationId: view.incarnationId, launchNonce: 'owned-launch',
        hydrated: true, messagesRead: 'success' as const }
      const read = vi.spyOn(rig, 'ownedOpenCodeAdoptionStatus').mockResolvedValue({ state: 'observed', data: { observation } })
      await expect(rig.syntheticOpenCodeAdoptionStatus(current)).resolves.toEqual({ state: 'observed', data: { observation } })
      expect(read).toHaveBeenCalledWith(view)
      read.mockResolvedValue({ state: 'observed', data: { observation: { ...observation, rootSessionId: 'foreign-root' } } })
      await expect(rig.syntheticOpenCodeAdoptionStatus(current)).rejects.toThrow(/source|root/)
    } finally { vi.unstubAllEnvs(); await rig.stop() }
  })

  it.each(['history', 'excluded'] as const)('reads actual SQLite %s facts only for the registered source root', async mode => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') }, fixtureRepoRoot, 3)
    const lifecycle = vi.spyOn(rig.runtime, 'recordLifecycle')
    vi.spyOn(rig.runtime, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    try {
      const source = await rig.prepareSyntheticOpenCodeSource()
      const detail = lifecycle.mock.calls.find(([event]) => event === 'source-fixture.prepared')?.[1]
      const reference = Object.getOwnPropertyDescriptor(detail ?? {}, 'sourceReference')?.value
      if (typeof reference !== 'string') throw new Error('actual source path required')
      const database = path.join(reference, 'web-home', '.local/share/opencode/opencode.db')
      const probe = vi.spyOn(rig, 'ownedProviderExec').mockImplementation(async (_container, args) =>
        execFileSync(process.execPath, args.slice(1).map(arg => arg === '/home/freshell/provider/.local/share/opencode/opencode.db' ? database : arg),
          { encoding: 'utf8' }))
      const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha, nativeSessionId: source.rootId }
      const read = (address: owner.ExactRuntimeHandle) => mode === 'history'
        ? rig.syntheticOpenCodeHistoryFacts(address) : rig.syntheticOpenCodeExcludedSentinels(address)
      const facts = await read(current)
      if (mode === 'history') {
        expect(facts).toEqual({ sessions: [source.childId, source.grandchildId, source.rootId].sort(),
          messages: source.baselineMessages, parts: source.baselineParts })
      } else {
        expect(facts).toEqual([...owner.EXCLUDED_SOURCE_SENTINELS].sort())
      }
      probe.mockClear()
      await expect(read({ ...current, nativeSessionId: 'foreign-root' })).rejects.toThrow(/registered.*source|source.*root/)
      expect(probe).not.toHaveBeenCalled()
    } finally { vi.unstubAllEnvs(); await rig.stop() }
  })

  it('owns source setup and teardown while returning only IDs, digests and observed counts', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') }, fixtureRepoRoot, 3)
    const lifecycle = vi.spyOn(rig.runtime, 'recordLifecycle')
    vi.spyOn(rig.runtime, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    let sourceRoot: string | undefined
    try {
      const source = await rig.prepareSyntheticOpenCodeSource()
      expect(source.rootMessageCount).toBe(106)
      expect(Object.keys(source.baselineMessages)).toHaveLength(108)
      expect(source).not.toHaveProperty('databasePath')
      expect(source).not.toHaveProperty('selectedSentinel')
      const preparation = lifecycle.mock.calls.find(([event]) => event === 'source-fixture.prepared')
      const reference = Object.getOwnPropertyDescriptor(preparation?.[1] ?? {}, 'sourceReference')?.value
      if (typeof reference !== 'string') throw new Error('actual owned source reference required')
      sourceRoot = reference
      expect(sourceRoot).toMatch(/\.freshell-opencode-resume-/)
      const database = path.join(sourceRoot, 'web-home', '.local/share/opencode/opencode.db')
      const db = new DatabaseSync(database)
      try { db.prepare('DELETE FROM message WHERE id = ?').run(source.lastMessageId) } finally { db.close() }
      expect((await rig.syntheticOpenCodeSourceFacts()).rootMessageCount).toBe(105)
      expect((await rig.prepareSyntheticOpenCodeSource()).rootId).toBe(source.rootId)
      expect((await rig.stop()).ok).toBe(true)
      await expect(fsp.stat(sourceRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      vi.unstubAllEnvs()
      await rig.stop()
    }
  })

  it('seeds the actual default conversation graph and keeps unrelated history outside its baselines', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-source-owner-'))
    const databasePath = path.join(root, 'opencode.db')
    try {
      const source = owner.seedManagedOpenCodeSource({ repoRoot: process.cwd(), databasePath,
        workspace: root, nonce: 'owner-source-default' })
      const db = new DatabaseSync(databasePath, { readOnly: true })
      try {
        const count = db.prepare('SELECT COUNT(*) AS count FROM message WHERE session_id = ?')
        expect(count.get(source.rootId)).toEqual({ count: 106 })
        expect(count.get(source.unrelatedId)).toEqual({ count: 1 })
        expect(db.prepare('SELECT parent_id FROM session WHERE id = ?').get(source.childId))
          .toEqual({ parent_id: source.rootId })
        expect(db.prepare('SELECT parent_id FROM session WHERE id = ?').get(source.grandchildId))
          .toEqual({ parent_id: source.childId })
        expect(source.baselineMessages.size).toBe(108)
        expect(source.baselineMessages.has(source.lastMessageId)).toBe(true)
        const unrelated = db.prepare('SELECT id FROM message WHERE session_id = ?').get(source.unrelatedId)
        expect(unrelated).toBeDefined()
        expect(source.baselineMessages.has(String(unrelated?.id))).toBe(false)
      } finally { db.close() }
      const invalidPath = path.join(root, 'invalid.db')
      expect(() => owner.seedManagedOpenCodeSource({ repoRoot: process.cwd(), databasePath: invalidPath,
        workspace: root, nonce: 'invalid', messageCount: 3 })).toThrow('even integer of at least two')
      await expect(fsp.stat(invalidPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await fsp.rm(root, { recursive: true, force: true }) }
  })
})

describe('retained fixture pinned native seed SQL', () => {
  const root = 'ses_providercreatedroot123', child = 'ses_task002syntheticchild'
  function database() {
    const file = path.join(fixtureRepoRoot, 'native.db')
    const db = new DatabaseSync(file)
    db.exec(fs.readFileSync(path.join(fixtureRepoRoot, 'crates/freshell-sessions/src/opencode_schema_v1_18_21.sql'), 'utf8'))
    db.prepare(`INSERT INTO project(id,worktree,name,time_created,time_updated,sandboxes,commands)
      VALUES ('native-project', '/native-worktree', 'native name', 123, 456, '["native-sandbox"]', '{"native":true}')`).run()
    db.prepare(`INSERT INTO project_directory(project_id,directory,type,strategy,time_created)
      VALUES ('native-project', ?, 'native-type', 'native-strategy', 321)`).run(fixtureRepoRoot)
    db.prepare(`INSERT INTO session(id,project_id,parent_id,slug,directory,title,version,time_created,time_updated,metadata)
      VALUES (?, 'native-project', NULL, 'native-slug', ?, 'native title', '1.18.21', 123, 456, '{"native":true}')`).run(root, fixtureRepoRoot)
    db.prepare(`INSERT INTO event_sequence(aggregate_id,seq,owner_id) VALUES (?,7,'native-owner')`).run(root)
    db.prepare(`INSERT INTO event(id,aggregate_id,seq,type,data) VALUES ('evt_native',?,7,'session.created.1','{"native":true}')`).run(root)
    db.close()
    return file
  }
  function rows(file: string) {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      return Object.fromEntries(['session', 'project', 'project_directory', 'message', 'part', 'event', 'event_sequence',
        'session_input', 'session_message'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
    } finally { db.close() }
  }
  function seed(file: string, nativeRoot = root, preserveNativeRoot = true) {
    execFileSync('python3', ['-c', `import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA foreign_keys=ON')
workspace,root,child=sys.argv[2:5]
preserve_native_root=sys.argv[5]=='current'
try:
 exec(${JSON.stringify(retained.TASK2_RETAINED_SEED_SQL)})
 c.commit()
finally:c.close()
`, file, fixtureRepoRoot, nativeRoot, child, preserveNativeRoot ? 'current' : 'legacy'],
    { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
  }

  function seededFixture(mode: 'current' | 'legacy') {
    const nativeRoot = mode === 'current' ? root : 'ses_task002syntheticroot'
    const file = database()
    seed(file, nativeRoot, mode === 'current')
    return { file, nativeRoot }
  }

  function nativeHistory(file: string, nativeRoot: string) {
    const stored = rows(file)
    const sessionRow = stored.session.find(row => row.id === nativeRoot)!
    const session = { id: sessionRow.id, parentID: sessionRow.parent_id, projectID: sessionRow.project_id,
      directory: sessionRow.directory, title: sessionRow.title, version: sessionRow.version,
      time: { created: sessionRow.time_created, updated: sessionRow.time_updated }, revert: sessionRow.revert }
    const messages = stored.message.filter(row => row.session_id === nativeRoot).map(row => ({
      info: { ...JSON.parse(String(row.data)), id: row.id, sessionID: row.session_id },
      parts: stored.part.filter(part => part.message_id === row.id).map(part => ({
        ...JSON.parse(String(part.data)), id: part.id, messageID: part.message_id, sessionID: part.session_id,
      })),
    }))
    return { session, messages }
  }

  async function loadSeededRoot(file: string, nativeRoot: string) {
    // Project the stored native IDs and original payloads without normalizing
    // them. This exercises our producer/loader boundary, not an installed SDK.
    const { session, messages } = nativeHistory(file, nativeRoot)
    const home = path.join(fixtureRepoRoot, `native-loader-${randomUUID()}`)
    const launch = { incarnationId: 'incarnation-retained', launchNonce: 'launch-retained', evidenceRevision: 4,
      executionGeneration: 2, requestedNativeSessionId: nativeRoot }
    const directory = path.join(home, '.freshell/native-identity', launch.launchNonce)
    const abort = new AbortController()
    const create = vi.fn()
    const get = vi.fn(async () => ({ data: session }))
    const readMessages = vi.fn(async () => ({ data: messages }))
    vi.useFakeTimers()
    for (const key of Object.keys(process.env).filter(key => key.startsWith('FRESHELL_OPENCODE_ADOPTION_'))) {
      vi.stubEnv(key, undefined)
    }
    vi.stubEnv('HOME', home)
    vi.stubEnv('FRESHELL_NATIVE_IDENTITY_LAUNCH', JSON.stringify(launch))
    vi.stubEnv('FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR', directory)
    try {
      plugin.tui({
        state: { ready: true, session: { get: () => session, messages: () => messages.map(row => row.info) },
          part: (messageId: string) => messages.find(row => row.info.id === messageId)?.parts },
        client: { session: { create, get, messages: readMessages } },
        route: { current: { name: 'session', params: { sessionID: nativeRoot } } }, lifecycle: { signal: abort.signal },
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(create).not.toHaveBeenCalled()
      expect(get).toHaveBeenCalledExactlyOnceWith({ sessionID: nativeRoot }, { throwOnError: true })
      expect(readMessages).toHaveBeenCalledExactlyOnceWith({ sessionID: nativeRoot }, { throwOnError: true })
      const read = (name: string) => {
        const filename = path.join(directory, `${name}.json`)
        return fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : null
      }
      return { launch, messages, loaded: read('opencode-loaded'), refused: read('opencode-refused') }
    } finally {
      try {
        abort.abort()
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
        vi.unstubAllEnvs()
        fs.rmSync(home, { recursive: true, force: true })
      }
    }
  }

  it.each(['current', 'legacy'] as const)('hydrates the actual %s SQL seed through the production native TUI loader', async mode => {
    const { file, nativeRoot } = seededFixture(mode)
    const before = rows(file)
    const observed = await loadSeededRoot(file, nativeRoot)
    expect({ loaded: observed.loaded !== null, refused: observed.refused }).toEqual({ loaded: true, refused: null })
    expect(observed.loaded).toEqual({ launch: observed.launch, native: {
      source: 'opencode-tui-native-loader', session_id: nativeRoot, parent_id: null, hydrated: true,
      messages_read: 'success', active_message_count: 1, tail_message_id: observed.messages[0].info.id,
    } })
    expect(observed.messages).toHaveLength(1)
    expect(observed.messages[0].parts).toHaveLength(1)
    expect(rows(file)).toEqual(before)
  })

  it.each((['current', 'legacy'] as const).flatMap(mode => [false, true].map(laterTail => ({ mode, laterTail }))))(
    'refuses an actual malformed stored message before native publication ($mode, later valid tail: $laterTail)', async ({ mode, laterTail }) => {
      const { file, nativeRoot } = seededFixture(mode)
      const db = new DatabaseSync(file)
      const malformedId = `msg_${nativeRoot}`
      try {
        db.exec('PRAGMA foreign_keys=ON; BEGIN; PRAGMA defer_foreign_keys=ON')
        db.prepare('UPDATE message SET id=? WHERE session_id=?').run(malformedId, nativeRoot)
        db.prepare('UPDATE part SET message_id=? WHERE session_id=?').run(malformedId, nativeRoot)
        if (laterTail) db.prepare(`INSERT INTO message(id,session_id,time_created,time_updated,data)
          SELECT 'msg_latervalidtail',session_id,2,2,data FROM message WHERE id=?`).run(malformedId)
        db.exec('COMMIT')
        expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      } finally { db.close() }
      const before = rows(file)
      const observed = await loadSeededRoot(file, nativeRoot)
      expect(observed.messages.map(row => row.info.id)).toEqual(laterTail ? [malformedId, 'msg_latervalidtail'] : [malformedId])
      expect(observed.messages[0].parts[0].messageID).toBe(malformedId)
      expect(observed.loaded).toBeNull()
      expect(observed.refused).toMatchObject({ nativeSessionId: nativeRoot, reason: 'history_not_hydrated',
        incarnationId: observed.launch.incarnationId, launchNonce: observed.launch.launchNonce })
      expect(rows(file)).toEqual(before)
    })

  it('preserves the exact native parentless root/project/directory/events while adding the same child and attachments', () => {
    const file = database(), before = rows(file)
    seed(file)
    const after = rows(file)
    expect(after.session[0]).toEqual(before.session[0])
    expect(after.project).toEqual(before.project)
    expect(after.project_directory).toEqual(before.project_directory)
    expect(after.event[0]).toEqual(before.event[0])
    expect(after.event_sequence[0]).toEqual(before.event_sequence[0])
    expect(after.session).toHaveLength(2)
    expect(after.session[1]).toMatchObject({ id: child, parent_id: root, project_id: 'native-project', directory: fixtureRepoRoot })
    expect(after.message).toHaveLength(2)
    expect(after.part).toHaveLength(2)
    for (const sessionId of [root, child]) {
      const message = after.message.find(row => row.session_id === sessionId)!
      const part = after.part.find(row => row.session_id === sessionId)!
      expect(message.id).toBe(`msg_${sessionId.slice(4)}`)
      expect(JSON.parse(String(message.data))).toEqual({ role: 'user', agent: 'build',
        model: { providerID: 'openai', modelID: 'gpt-5.6-luna' }, time: { created: 1 } })
      expect(part.id).toBe(`prt_${sessionId}`)
      expect(part.message_id).toBe(message.id)
      expect(JSON.parse(String(part.data))).toEqual({ type: 'file', mime: 'text/plain', filename: 'asset.txt',
        url: `file://${fixtureRepoRoot}/asset.txt` })
    }
    expect(after.event).toHaveLength(2)
    expect(JSON.parse(String(after.event[1].data))).toMatchObject({ sessionID: child,
      info: { projectID: 'native-project', parentID: root, directory: fixtureRepoRoot } })
  })

  it.each(['missing-root', 'parented-root', 'wrong-directory', 'missing-project', 'messages', 'orphan-parts',
    'pending-input', 'session-history', 'existing-child', 'existing-descendant'] as const)
    ('refuses %s atomically before appending a retained graph', fault => {
      const file = database(), db = new DatabaseSync(file)
      try {
        if (fault === 'parented-root') db.prepare('UPDATE session SET parent_id=? WHERE id=?').run('ses_parent', root)
        if (fault === 'wrong-directory') db.prepare('UPDATE session SET directory=? WHERE id=?').run('/other-workspace', root)
        if (fault === 'missing-project') { db.exec('PRAGMA foreign_keys=OFF'); db.exec("DELETE FROM project WHERE id='native-project'") }
        if (fault === 'messages') db.prepare("INSERT INTO message VALUES ('msg_existing',?,1,1,'{}')").run(root)
        if (fault === 'orphan-parts') { db.exec('PRAGMA foreign_keys=OFF'); db.prepare("INSERT INTO part VALUES ('prt_existing','msg_missing',?,1,1,'{}')").run(root) }
        if (fault === 'pending-input') db.prepare("INSERT INTO session_input VALUES ('input_existing',?,'private synthetic','pending',1,NULL,1)").run(root)
        if (fault === 'session-history') db.prepare("INSERT INTO session_message VALUES ('history_existing',?,'synthetic',1,1,1,'{}')").run(root)
        if (fault === 'existing-child' || fault === 'existing-descendant') db.prepare(`INSERT INTO session
          (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated)
          VALUES (?,'native-project',?,'existing',?,'existing','1.18.21',1,1)`)
          .run(fault === 'existing-child' ? child : 'ses_existingdescendant', fault === 'existing-child' ? null : root, fixtureRepoRoot)
      } finally { db.close() }
      const before = rows(file)
      expect(() => seed(file, fault === 'missing-root' ? 'ses_missing' : root)).toThrow(/retained native root/)
      expect(rows(file)).toEqual(before)
    })

  it('keeps the historical legacy seed as two new fixture sessions and fixture project/events', () => {
    const file = database()
    seed(file, 'ses_task002syntheticroot', false)
    const after = rows(file)
    expect(after.session.slice(1)).toMatchObject([{ id: 'ses_task002syntheticroot', parent_id: null, project_id: 'task002_project' },
      { id: child, parent_id: 'ses_task002syntheticroot', project_id: 'task002_project' }])
    expect(after.message).toHaveLength(2)
    expect(after.part).toHaveLength(2)
    expect(after.project).toHaveLength(2)
    expect(after.event).toHaveLength(3)
    expect(after.event_sequence).toHaveLength(3)
    for (const sessionId of ['ses_task002syntheticroot', child]) {
      const message = after.message.find(row => row.session_id === sessionId)!
      const part = after.part.find(row => row.session_id === sessionId)!
      expect(JSON.parse(String(message.data))).toEqual({ role: 'user', agent: 'build',
        model: { providerID: 'openai', modelID: 'gpt-5.6-luna' }, time: { created: 1 } })
      expect(part).toMatchObject({ id: `prt_${sessionId}`, message_id: message.id, session_id: sessionId })
      expect(JSON.parse(String(part.data))).toEqual({ type: 'file', mime: 'text/plain', filename: 'asset.txt',
        url: `file://${fixtureRepoRoot}/asset.txt` })
      expect(after.event.find(row => row.aggregate_id === sessionId)).toMatchObject({ id: `evt_${sessionId}` })
    }
  })
})

describe('current retained fixture native root binding', () => {
  async function fixture(options: { complete?: boolean; legacy?: boolean; fault?: string; tuiFormat?: 'json' | 'jsonc'; observationRevision?: number } = {}) {
    const h = new owner.RuntimeHarness(fixtureRepoRoot, undefined, 3)
    await fsp.mkdir(h.testRoot, { recursive: true, mode: 0o700 })
    const control = path.join(h.testRoot, 'control')
    await fsp.mkdir(control)
    const supervisor: owner.SupervisorInstance = { scenarioId: 'task2-config-jsonc', containerId: 'c'.repeat(64),
      controlSocket: path.join(control, 'supervisor.sock'), controlSecret: 'owned-unit-secret',
      controlSecretFile: path.join(control, 'secret'), runtimeRoot: path.join(control, 'runtime'),
      volumeName: 'owned-unit-volume', binaryKind: 'test' }
    let workspace = ''
    const preparation = net.createServer(socket => {
      let request = ''
      socket.on('data', chunk => { request += chunk.toString() })
      socket.on('end', () => {
        const selected = JSON.parse(request)
        expect(selected.soulId).toMatch(/^soul-/)
        workspace = selected.workspace
        socket.end(JSON.stringify({ context: { workspace: selected.workspace }, secretReferences: [] }))
      })
    })
    await new Promise<void>(resolve => preparation.listen(path.join(control, 'mcp.sock'), resolve))
    const stop = vi.fn(async () => {})
    const info = { baseUrl: 'https://owned.example.invalid', wsUrl: 'wss://owned.example.invalid/ws',
      token: 'unit-token', port: 443, configDir: h.testRoot, homeDir: h.testRoot, logsDir: h.testRoot,
      debugLogPath: path.join(h.testRoot, 'web.jsonl'), pid: 1, runtimeRoot: h.repoRoot }
    const unexpectedRestart = async (): Promise<owner.RuntimeWebInfo> => { throw new Error('unexpected fixture web restart') }
    const web: owner.RuntimeWebHandle = { start: async () => info, stop, info,
      restart: unexpectedRestart, restartAbrupt: unexpectedRestart, kill: stop,
      capturedOutput: () => ({ stdout: '', stderr: '' }), processEvidence: () => ({ pid: 1, bootAttemptCount: 1 }),
      ownedChildPids: () => [] }
    let controlEpoch = 0
    vi.spyOn(h, 'startSupervisor').mockImplementation(async () => { controlEpoch++; return supervisor })
    vi.spyOn(h, 'waitForFile').mockResolvedValue(undefined)
    vi.spyOn(h, 'assert').mockImplementation((_caseId, passed, message) => { expect(passed, message).toBe(true) })
    vi.spyOn(h, 'recordLifecycle').mockImplementation(() => {})
    const provider = vi.spyOn(h, 'execOwnedContainerAsExact')
    const input = vi.spyOn(h, 'terminalInputBody')
    let release!: () => void
    let entered!: () => void
    const launchEntered = new Promise<void>(resolve => { entered = resolve })
    const nativeReady = new Promise<void>(resolve => { release = resolve })
    const nativeRoot = 'ses_providercreatedroot123'
    let created = 0, navigated = 0, hydrated = 0
    let view: Record<string, any>, oldRunning = true, replaced = false
    const oldContainer = 'a'.repeat(64), replacement = 'b'.repeat(64)
    const incarnation = 'incarnation-current-unit'
    const observation = { nativeSessionId: nativeRoot, incarnationId: incarnation, launchNonce: 'launch-current-unit',
      evidenceRevision: options.observationRevision ?? 0, source: 'opencode_tui', evidenceDigest: 'd'.repeat(64) }
    const launch = async (body: any) => {
      workspace = body.params.terminal.cwd
      entered()
      await nativeReady
      // The current native plugin creates/navigates only without a requested root.
      // An assigned missing root cannot publish a loaded observation or complete launch.
      if (body.params.nativeSessionId && !options.legacy) throw new Error('missing requested native root remains unobserved')
      expect(body.params.terminal.args).toEqual([])
      if (options.legacy) expect(body.params.nativeSessionId).toBe('ses_task002syntheticroot')
      else { created++; navigated++; hydrated++ }
      if (!options.complete) throw new Error(`observed fresh root ${nativeRoot}`)
      view = { soulId: body.params.soulId, incarnationId: incarnation, nativeSessionId: nativeRoot,
        containerId: oldContainer, hostBootId: 'boot-current-unit', provider: 'opencode', launchState: 'running',
        // First native identity recording advances the soul, not the launch observation.
        evidenceRevision: options.legacy ? 0 : observation.evidenceRevision + 1, nativeIdentityObservation: observation }
      const result: Record<string, any> = { ...view, nativeIdentityObservation: { ...observation } }
      if (options.legacy) { result.nativeSessionId = 'ses_task002syntheticroot'; delete result.nativeIdentityObservation }
      if (options.fault === 'missing-root') delete result.nativeSessionId
      if (options.fault === 'empty-root') result.nativeSessionId = ''
      if (options.fault === 'invalid-root') result.nativeSessionId = 'ses_invalid_root'
      if (options.fault === 'placeholder-root') result.nativeSessionId = 'ses_task002syntheticroot'
      if (options.fault === 'wrong-soul') result.soulId = 'soul-foreign'
      if (options.fault === 'wrong-observation-root') result.nativeIdentityObservation.nativeSessionId = 'ses_foreign'
      if (options.fault === 'wrong-observation-incarnation') result.nativeIdentityObservation.incarnationId = 'incarnation-foreign'
      if (options.fault === 'stale-incarnation') view.incarnationId = 'incarnation-newer'
      if (options.fault === 'wrong-current-observation') view.nativeIdentityObservation = { ...observation, nativeSessionId: 'ses_foreign' }
      if (options.fault === 'stale-launch-soul-revision') result.evidenceRevision = observation.evidenceRevision
      if (options.fault === 'stale-current-soul-revision') view.evidenceRevision = observation.evidenceRevision
      if (options.fault === 'wrong-launch-observation-revision') result.nativeIdentityObservation.evidenceRevision++
      if (options.fault === 'wrong-current-observation-revision') view.nativeIdentityObservation = { ...observation, evidenceRevision: observation.evidenceRevision - 1 }
      return { kind: 'launch', data: { view: result, hostBootId: 'boot-current-unit' } }
    }
    vi.spyOn(h, 'adminOk').mockImplementation(async (_supervisor, body) => {
      if (body.method === 'health') return { kind: 'health', data: { controlEpoch } }
      if (body.method === 'launch') return launch(body)
      if (body.method === 'inventory') return { kind: 'inventory', data: [view] }
      if (body.method === 'upsert_view_intent') return { kind: 'view_intent', data: {} }
      if (body.method === 'probe_recovery') return { kind: 'recovery_probe', data: { kind: 'resume_ready' } }
      if (body.method === 'recover') {
        await fsp.mkdir(control, { recursive: true })
        await fsp.writeFile(path.join(control, 'evidence/lifecycle.jsonl'), JSON.stringify({ event: 'supervisor.recovery.preflight',
          data: { severity: 'warn', soulId: view.soulId, incarnationId: incarnation, controlEpoch: 2,
            blockReason: 'STORE_UNREADABLE', repair: 'repair owned store', attemptReserved: false } })+'\n')
        return { kind: 'recovery', data: { outcome: 'blocked', probe: { kind: 'blocked', data: { reason: 'STORE_UNREADABLE' } } } }
      }
      throw new Error(`unexpected adapter operation ${body.method}`)
    })
    vi.spyOn(h, 'adminEnvelopeRaw').mockImplementation(async (s, envelope) => {
      const requestId = envelope.requestId
      if (typeof requestId !== 'string') throw new Error('exact fixture request ID required')
      return { requestId, result: { Ok: await h.adminOk(s, envelope.body) } }
    })
    const roots: string[] = [], probeRoots: string[][] = []
    let host: net.Server | undefined
    if (options.complete) {
      h.imageRef = 'sha256:'+ 'f'.repeat(64)
      await fsp.mkdir(path.join(control, 'evidence'))
      const hostDir = path.join(h.testRoot, 'host')
      await fsp.mkdir(hostDir)
      await fsp.writeFile(path.join(hostDir, 'secret'), 'synthetic-host-secret')
      vi.spyOn(h, 'runtimeDir').mockReturnValue(hostDir)
      host = net.createServer(socket => {
        const chunks: Buffer[] = []
        socket.on('data', chunk => { chunks.push(chunk) })
        socket.on('end', () => {
          const frame = Buffer.concat(chunks)
          expect(frame.readUInt32BE(0)).toBe(frame.length-4)
          const request = JSON.parse(frame.subarray(4).toString())
          expect(request.body.params.incarnation_id).toBe(incarnation)
          const reply = Buffer.from(JSON.stringify({ requestId: request.requestId,
            result: { Ok: { kind: 'status', data: { exited: false } } } }))
          const header = Buffer.alloc(4); header.writeUInt32BE(reply.length)
          socket.end(Buffer.concat([header, reply]))
        })
      })
      await new Promise<void>(resolve => host!.listen(path.join(hostDir, 'host.sock'), resolve))
      vi.spyOn(h, 'stopSupervisorExact').mockImplementation(() => {})
      vi.spyOn(h, 'removeContainerExact').mockImplementation(() => {})
      vi.spyOn(h, 'inspectContainer').mockImplementation(id => ({ Id: id, Image: h.imageRef,
        HostConfig: { Tmpfs: { '/tmp': 'owned', '/run/opencode-tmp': 'owned' } },
        Mounts: [{ Destination: '/home/freshell/provider', Name: 'owned-provider-volume' }],
        State: { Running: id === oldContainer ? oldRunning : true } }))
      vi.spyOn(h, 'execOwnedContainerExact').mockImplementation(() => JSON.stringify({ attemptCount: replaced ? 1 : 0,
        writerClaims: replaced ? 1 : 0, incarnation: { soul_id: view.soulId, incarnation_id: incarnation,
          container_id: replaced ? replacement : oldContainer, immutable_config_digest: 'owned-digest', ...(!options.legacy ? { launch_policy: 'current' } : {}) } }))
      const dbFile = path.join(h.testRoot, 'probe.db'), db = new DatabaseSync(dbFile)
      db.exec('CREATE TABLE session(id TEXT PRIMARY KEY)')
      db.prepare('INSERT INTO session VALUES (?)').run(nativeRoot)
      db.prepare('INSERT INTO session VALUES (?)').run('ses_task002syntheticchild')
      db.close()
      provider.mockImplementation((_id, user, args) => {
        expect(user).toBe('65534:0')
        if (args[0] === 'cat') return fs.readFileSync(path.join(workspace, `selected-tui.${options.tuiFormat ?? 'jsonc'}`), 'utf8')
        if (args[0] === 'chmod') return ''
        if (args[0] !== 'python3') throw new Error('unexpected provider mutation')
        if (args.length >= 6) {
          roots.push(args[4])
          if (options.legacy) {
            expect(args.slice(3)).toEqual([workspace, 'ses_task002syntheticroot', 'ses_task002syntheticchild'])
            throw new Error('original legacy seed entered')
          }
          expect(args[6]).toBe('preserve_native_root')
          return JSON.stringify({ root: args[4], child: args[5], providerUid: 65534, providerGid: 0 })
        }
        probeRoots.push(args.slice(3))
        // Execute the driver's actual read query against an owned SQLite store.
        return execFileSync('python3', ['-c', `import sqlite3
connect=sqlite3.connect
sqlite3.connect=lambda *args,**kwargs:connect(${JSON.stringify(dbFile)})
` + args[2], ...args.slice(3)], { encoding: 'utf8', timeout: 10_000 })
      })
      h.broker = { receiptIds: () => [], receipts: () => [] } as unknown as RestrictedDockerBroker
      vi.spyOn(h, 'brokerReceiptsSince').mockImplementation(() => replaced ? [{ containerId: replacement,
        providerVolumeName: 'owned-provider-volume' } as any] : [])
      let retries = 0
      vi.spyOn(h, 'adminRaw').mockImplementation(async () => {
        const failed = retries++ === 0
        if (!failed) { replaced = true; oldRunning = false }
        return { requestId: 'owned-retry', result: { Ok: { kind: 'recovery', data: failed
          ? { outcome: 'blocked', probe: { data: { reason: 'CAPABILITY_PENDING', retry_hint: { repair: 'provider configuration publication' } } } }
          : { outcome: 'replaced', view } } } }
      })
      vi.spyOn(h, 'writeArtifact').mockImplementation(file => path.join(h.testRoot, file))
    }
    return { h, provider, input, stop, release, launchEntered, nativeRoot,
      observations: () => ({ created, navigated, hydrated }),
      roots, probeRoots,
      run: (browser?: retained.Task2RetainedBrowserHooks) => retained.runTask2RetainedFixture(h, !!options.legacy, () => web, browser, options.tuiFormat),
      close: async () => {
        if (host) await new Promise<void>((resolve, reject) => host!.close(error => error ? reject(error) : resolve()))
        await new Promise<void>((resolve, reject) => preparation.close(error => error ? reject(error) : resolve()))
        await fsp.rm(h.testRoot, { recursive: true, force: true })
      } }
  }

  it('waits for actual fresh create/navigation/hydration before seeding rather than resuming a missing root', async () => {
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    const f = await fixture()
    const operation = f.run()
    const settled = operation.catch(error => error as Error)
    try {
      await f.launchEntered
      expect(f.provider).not.toHaveBeenCalled()
      expect(f.input).not.toHaveBeenCalled()
      expect(f.observations()).toEqual({ created: 0, navigated: 0, hydrated: 0 })
      f.release()
      expect(await settled).toMatchObject({ message: `observed fresh root ${f.nativeRoot}` })
      expect(f.observations()).toEqual({ created: 1, navigated: 1, hydrated: 1 })
      expect(f.provider).not.toHaveBeenCalled()
      expect(f.input).not.toHaveBeenCalled()
      expect(f.stop).toHaveBeenCalledOnce()
    } finally { f.release(); await settled; await f.close(); vi.unstubAllEnvs() }
  })

  it.each([{ tuiFormat: 'json', observationRevision: 0 }, { tuiFormat: 'jsonc', observationRevision: 0 },
    { tuiFormat: 'json', observationRevision: 7 }, { tuiFormat: 'jsonc', observationRevision: 7 }] as const)
    ('binds the observed current root through seeding/public context and actual retained SQL probes ($tuiFormat, observation revision $observationRevision)', async ({ tuiFormat, observationRevision }) => {
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    const f = await fixture({ complete: true, tuiFormat, observationRevision })
    const contexts: retained.Task2RetainedPublicContext[] = []
    const operation = f.run({ observe: async (context, phase) => {
      contexts.push(retained.task2RetainedPublicContext(context))
      expect(context.rootSessionId).toBe(f.nativeRoot)
      expect(context.soulId).toMatch(/^soul-/)
      if (phase === 'store_blocked') expect(context.oldIncarnationId).toBe('incarnation-current-unit')
    }, retry: async (context) => {
      contexts.push(retained.task2RetainedPublicContext(context))
      return f.h.adminRaw(context.supervisor, f.h.recoverBody(context.soulId, 'manual_retry', 3))
    } })
    const settled = operation.catch(error => error as Error)
    try {
      await f.launchEntered; f.release()
      expect(await settled).toBeUndefined()
      expect(f.roots).toEqual([f.nativeRoot])
      expect(f.probeRoots).toEqual([[f.nativeRoot, 'ses_task002syntheticchild']])
      expect(contexts).toHaveLength(5)
      expect(contexts.every(context => context.rootSessionId === f.nativeRoot)).toBe(true)
      expect(f.input).not.toHaveBeenCalled()
      expect(f.stop).toHaveBeenCalledOnce()
    } finally { f.release(); await settled; await f.close(); vi.unstubAllEnvs() }
  })

  it.each(['missing-root', 'empty-root', 'invalid-root', 'placeholder-root', 'wrong-soul',
    'wrong-observation-root', 'wrong-observation-incarnation', 'stale-incarnation', 'wrong-current-observation',
    'stale-launch-soul-revision', 'stale-current-soul-revision', 'wrong-launch-observation-revision', 'wrong-current-observation-revision'])
    ('refuses %s before any provider seed/config/store mutation', async fault => {
      vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
      const f = await fixture({ complete: true, fault, observationRevision: 7 })
      const operation = f.run(), settled = operation.catch(error => error as Error)
      try {
        await f.launchEntered; f.release()
        expect(await settled).toMatchObject({ message: expect.stringMatching(/observed retained native root/) })
        expect(f.provider).not.toHaveBeenCalled()
        expect(f.input).not.toHaveBeenCalled()
        expect(f.stop).toHaveBeenCalledOnce()
      } finally { f.release(); await settled; await f.close(); vi.unstubAllEnvs() }
    })

  it('keeps the genuine protocol1 launch/root and original legacy seed without requiring current observation', async () => {
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    const f = await fixture({ complete: true, legacy: true })
    const operation = f.run(), settled = operation.catch(error => error as Error)
    try {
      await f.launchEntered; f.release()
      expect(await settled).toMatchObject({ message: 'original legacy seed entered' })
      expect(f.roots).toEqual(['ses_task002syntheticroot'])
      expect(f.observations()).toEqual({ created: 0, navigated: 0, hydrated: 0 })
      expect(f.h.adminEnvelopeRaw).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ protocolVersion: 1,
        body: expect.objectContaining({ method: 'launch', params: expect.objectContaining({ nativeSessionId: 'ses_task002syntheticroot' }) }) }))
      expect(f.input).not.toHaveBeenCalled()
    } finally { f.release(); await settled; await f.close(); vi.unstubAllEnvs() }
  })
})

describe('retained fixture owner web injection', () => {
  it('uses the injected owner factory rather than launching its browser fixture dependency', async () => {
    const h = new owner.RuntimeHarness(fixtureRepoRoot, undefined, 3)
    const supervisor: owner.SupervisorInstance = { scenarioId: 'task2-config-jsonc', containerId: 'c'.repeat(64),
      controlSocket: path.join(h.testRoot, 'control.sock'), controlSecret: 'owned-unit-secret',
      controlSecretFile: path.join(h.testRoot, 'control-secret'), runtimeRoot: h.testRoot,
      volumeName: 'owned-unit-volume', binaryKind: 'test' }
    vi.spyOn(h, 'startSupervisor').mockResolvedValue(supervisor)
    vi.spyOn(h, 'adminOk').mockResolvedValue({ kind: 'health', data: { controlEpoch: 1 } })
    vi.spyOn(h, 'assert').mockImplementation(() => {})
    const browserStart = vi.spyOn(RustServer.prototype, 'start').mockRejectedValue(new Error('old browser web dependency entered'))
    const factory = vi.fn<owner.RuntimeWebFactory>().mockImplementation(() => { throw new Error('injected owner web entered') })
    vi.stubEnv('FRESHELL_RUNTIME_SYNTHETIC_RESUME', '1')
    await fsp.mkdir(h.testRoot, { recursive: true, mode: 0o700 })
    try {
      await expect(runTask2RetainedFixture(h, false, undefined, 'jsonc', factory)).rejects.toThrow('injected owner web entered')
      expect(factory).toHaveBeenCalledOnce()
      expect(browserStart).not.toHaveBeenCalled()
    } finally {
      browserStart.mockRestore()
      vi.unstubAllEnvs()
      await fsp.rm(h.testRoot, { recursive: true, force: true })
    }
  })
})

describe('finite retained browser stage protocol (source coverage only)', () => {
  it('requires the exact observed stage before advancing and accepts only the actual soul retry response', async () => {
    const h = new owner.RuntimeHarness(fixtureRepoRoot, undefined, 3)
    const info: owner.RuntimeWebInfo = { baseUrl: 'https://owned.example.invalid', wsUrl: 'wss://owned.example.invalid/ws',
      token: 'synthetic-unit-token', port: 443, configDir: h.testRoot, homeDir: h.testRoot, logsDir: h.testRoot,
      debugLogPath: path.join(h.testRoot, 'log'), pid: 1, runtimeRoot: h.repoRoot }
    const web = new RustServer()
    vi.spyOn(web, 'info', 'get').mockReturnValue(info)
    const context: retained.Task2RetainedBrowserContext = { h, web,
      supervisor: { scenarioId: 'owned-stage', containerId: 'b'.repeat(64), controlSocket: path.join(h.testRoot, 'control.sock'),
        controlSecret: 'synthetic-unit-control', controlSecretFile: path.join(h.testRoot, 'secret'), runtimeRoot: h.testRoot,
        volumeName: 'owned-stage-volume', binaryKind: 'test' },
      soulId: 'owned-stage-soul', rootSessionId: 'ses_owned', childSessionId: 'ses_child',
      oldContainerId: 'c'.repeat(64), oldIncarnationId: 'owned-incarnation', providerVolumeName: 'owned-stage-provider',
      configFile: path.join(h.testRoot, 'opencode.json'), preferredTabId: 'owned-tab', preferredPaneId: 'owned-pane', title: 'owned fixture' }
    let advanced = 0
    const session = new retained.RetainedFixtureBrowserSession()
    try {
      await fsp.mkdir(h.testRoot, { recursive: true, mode: 0o700 })
      await fsp.writeFile(context.configFile, '{}', { mode: 0o644 })
      session.start(async hooks => {
        await hooks.observe(context, 'store_blocked')
        advanced++
        const reply = await hooks.retry(context, 'repaired')
        expect(reply.requestId).toBe('actual-ui-request')
        advanced++
      })
      const first = session.status()
      expect(first).toMatchObject({ kind: 'observe', phase: 'store_blocked', sequence: 1 })
      expect(() => session.advance(2)).toThrow(/stage|sequence/)
      expect(advanced).toBe(0)
      session.advance(1)
      await new Promise(resolve => setImmediate(resolve))
      expect(session.status()).toMatchObject({ kind: 'retry', phase: 'repaired', sequence: 2 })
      expect(() => session.captureRetry('foreign-soul', 'actual-ui-request', { view: { soulId: context.soulId }, outcome: 'replaced' })).toThrow(/soul/)
      expect(advanced).toBe(1)
      session.captureRetry(context.soulId, 'actual-ui-request', { view: { soulId: context.soulId }, outcome: 'replaced' })
      await session.settled()
      expect(advanced).toBe(2)
      expect(session.status().kind).toBe('finished')
      const preparing = new retained.RetainedFixtureBrowserSession()
      let release!: () => void
      const setup = new Promise<void>(resolve => { release = resolve })
      preparing.start(async hooks => { await setup; await hooks.observe(context, 'store_blocked') })
      const cancellation = preparing.cancel()
      release()
      try {
        await new Promise(resolve => setImmediate(resolve))
        expect(preparing.status().kind).toBe('failed')
        await cancellation
      } finally {
        const late = preparing.status()
        if (late.kind === 'observe') preparing.advance(late.sequence)
        await cancellation
      }
    } finally {
      await session.cancel()
      await fsp.rm(h.testRoot, { recursive: true, force: true })
    }
  })
})

function fixture() {
  const row = { ...handle, launchState: 'running' }
  const read = vi.fn().mockResolvedValue({
    workerPid: 42, workerLaunchCount: 1,
    limits: { cpuMax: '50000 100000', memoryMax: '268435456', swapMax: '0', pidsMax: '64' },
    unsafeBrokerAttempts: 0,
  })
  const adapter = {
    runId: handle.runId, candidateSha: handle.candidateSha,
    inventory: vi.fn().mockResolvedValue([row]),
    receipts: () => [{ containerId: handle.containerId, soulId: handle.soulId, incarnationId: handle.incarnationId }],
    readHostFacts: read,
  }
  return { adapter, read, row }
}

describe('exact owned runtime facts', () => {
  it('reads only the unique running incarnation when stopped history belongs to the same soul', async () => {
    const { adapter, read, row } = fixture()
    const prior = { ...row, incarnationId: 'prior-incarnation', containerId: 'c'.repeat(64), hostBootId: 'prior-boot', launchState: 'stopped' }
    adapter.inventory.mockResolvedValue([prior, row])
    await expect(owner.readExactRuntimeHostFacts(adapter, handle)).resolves.toMatchObject({ workerPid: 42 })
    expect(read).toHaveBeenCalledExactlyOnceWith(handle)
    read.mockClear()
    vi.spyOn(adapter, 'receipts').mockReturnValue([prior, row])
    await expect(owner.readExactRuntimeHostFacts(adapter, { ...handle, incarnationId: prior.incarnationId,
      containerId: prior.containerId, hostBootId: prior.hostBootId })).rejects.toThrow(/current/)
    expect(read).not.toHaveBeenCalled()
  })
  it.each(['launchState', 'incarnationId', 'containerId', 'hostBootId', 'nativeSessionId'] as const)(
    'identifies the changed %s before reading owner facts', async field => {
    const { adapter, read, row } = fixture()
    row[field] = 'replacement-value'
    await expect(owner.readExactRuntimeHostFacts(adapter, handle)).rejects.toMatchObject({
      runtimeHandleMismatches: [field],
    })
    expect(read).not.toHaveBeenCalled()
  })
  it('keeps absent and duplicate current inventory unknown and unread', async () => {
    const { adapter, read, row } = fixture()
    for (const rows of [[], [row, row]]) {
      adapter.inventory.mockResolvedValue(rows)
      await expect(owner.readExactRuntimeHostFacts(adapter, handle)).rejects.toMatchObject({
        runtimeHandleMismatches: ['inventoryMembership'],
      })
    }
    expect(read).not.toHaveBeenCalled()
  })
  it('keeps owner control responsive while cgroup facts are read for the exact native host', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-cgroup-child-'))
    const command = path.join(root, 'docker')
    const limits = { cpuMax: '50000 100000', memoryMax: '268435456', swapMax: '0', pidsMax: '64' }
    await fsp.writeFile(command, `#!${process.execPath}\nsetTimeout(()=>process.stdout.write('${JSON.stringify(limits)}'),150)\n`, { mode: 0o700 })
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') }, fixtureRepoRoot)
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    rig.supervisor = { scenarioId: 'owned-cgroup', containerId: 'd'.repeat(64), controlSocket: path.join(root, 'control.sock'),
      controlSecret: 'synthetic-secret', controlSecretFile: path.join(root, 'secret'), runtimeRoot: root,
      volumeName: 'owned-cgroup-volume', binaryKind: 'test' }
    await fsp.mkdir(path.join(root, current.incarnationId))
    await fsp.writeFile(path.join(root, current.incarnationId, 'host-state.json'), JSON.stringify({
      hostBootId: current.hostBootId, workerPid: 42, workerLaunchCount: 1,
    }))
    rig.runtime.broker = new RestrictedDockerBroker({ realSocketPath: path.join(root, 'unused.sock'), proxySocketPath: path.join(root, 'proxy.sock'),
      runtimeRootPrefix: root, allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set(), testRunId: rig.runtime.runId, logPath: path.join(root, 'broker.jsonl') })
    vi.spyOn(rig.runtime.broker, 'receipts').mockReturnValue([{ ...current, runtimeDir: path.join(root, current.incarnationId), imageRef: 'owned-image',
      createdAt: new Date().toISOString(), requestDigest: 'd'.repeat(64) }])
    vi.spyOn(rig.runtime.broker, 'receiptIds').mockReturnValue(new Set([current.containerId]))
    vi.spyOn(rig, 'inventory').mockResolvedValue([{ ...current, launchState: 'running', intentRevision: 1 }])
    vi.spyOn(rig.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    vi.stubEnv('PATH', `${root}${path.delimiter}${process.env.PATH}`)
    let settled = false
    const responsive = new Promise<boolean>(resolve => setTimeout(() => resolve(!settled), 20))
    const probe = rig.chaosHostFacts(current).then(result => { settled = true; return result })
    try {
      try { expect(await responsive).toBe(true) } finally {
        await expect(probe).resolves.toEqual({ workerPid: 42, workerLaunchCount: 1, limits, unsafeBrokerAttempts: 0 })
      }
    } finally { vi.unstubAllEnvs(); await fsp.rm(root, { recursive: true, force: true }) }
  })
  it('keeps owner control responsive while the fixed supervisor adoption probe runs', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-adoption-child-'))
    const command = path.join(root, 'docker')
    await fsp.writeFile(command, `#!${process.execPath}\nsetTimeout(()=>process.stdout.write(JSON.stringify({state:'awaiting_observation'})),150)\n`, { mode: 0o700 })
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') }, fixtureRepoRoot)
    rig.supervisor = { scenarioId: 'owned-adoption', containerId: 'd'.repeat(64), controlSocket: path.join(root, 'control.sock'),
      controlSecret: 'synthetic-secret', controlSecretFile: path.join(root, 'secret'), runtimeRoot: root,
      volumeName: 'owned-adoption-volume', binaryKind: 'test' }
    rig.runtime.broker = new RestrictedDockerBroker({ realSocketPath: path.join(root, 'unused.sock'), proxySocketPath: path.join(root, 'unused-proxy.sock'),
      runtimeRootPrefix: root, allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set(), testRunId: rig.runtime.runId, logPath: path.join(root, 'broker.jsonl') })
    vi.spyOn(rig.runtime.broker, 'receiptIds').mockReturnValue(new Set([rig.supervisor.containerId]))
    vi.stubEnv('PATH', `${root}${path.delimiter}${process.env.PATH}`)
    let settled = false
    const response = new Promise<boolean>(resolve => setTimeout(() => resolve(!settled), 20))
    try {
      const probe = rig.ownedOpenCodeAdoptionStatus({ ...handle, terminalId: 'owned-terminal', launchState: 'running', intentRevision: 1 })
        .then(result => { settled = true; return result })
      try { expect(await response).toBe(true) } finally {
        await expect(probe).resolves.toEqual({ state: 'awaiting_observation' })
      }
    } finally { vi.unstubAllEnvs(); await fsp.rm(root, { recursive: true, force: true }) }
  })
  it('keeps owner control responsive while an actual owned probe child is running', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-probe-child-'))
    const command = path.join(root, 'docker')
    await fsp.writeFile(command, `#!${process.execPath}\nsetTimeout(()=>process.stdout.write(JSON.stringify({requestIds:['actual-probe-result'],resultIds:['actual-probe-result'],replayCount:0})),150)\n`, { mode: 0o700 })
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web factory') }, fixtureRepoRoot)
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    rig.runtime.broker = new RestrictedDockerBroker({ realSocketPath: path.join(root, 'unused.sock'), proxySocketPath: path.join(root, 'unused-proxy.sock'),
      runtimeRootPrefix: root, allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set(), testRunId: rig.runtime.runId, logPath: path.join(root, 'broker.jsonl') })
    vi.spyOn(rig.runtime.broker, 'receiptIds').mockReturnValue(new Set([current.containerId]))
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    vi.stubEnv('PATH', `${root}${path.delimiter}${process.env.PATH}`)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const challenge = await rig.registerNativeChallenge(current, 'chaos-approval')
      let heartbeat = false
      timer = setTimeout(() => { heartbeat = true }, 20)
      const result = await rig.nativeToolEvidence(current, challenge.challengeId)
      expect(result.requestIds).toEqual(['actual-probe-result'])
      expect(heartbeat).toBe(true)
    } finally {
      clearTimeout(timer)
      vi.unstubAllEnvs()
      await fsp.rm(root, { recursive: true })
    }
  })
  it('settles an in-flight owned probe and verifies its PID is absent during owner cleanup', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-probe-cancel-'))
    const pidFile = path.join(root, 'probe.pid')
    const command = path.join(root, 'docker')
    await fsp.writeFile(command, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)\n`, { mode: 0o700 })
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web factory') }, fixtureRepoRoot)
    rig.runtime.broker = new RestrictedDockerBroker({ realSocketPath: path.join(root, 'unused.sock'), proxySocketPath: path.join(root, 'unused-proxy.sock'),
      runtimeRootPrefix: root, allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set(), testRunId: rig.runtime.runId, logPath: path.join(root, 'broker.jsonl') })
    vi.spyOn(rig.runtime.broker, 'receiptIds').mockReturnValue(new Set([handle.containerId]))
    const cleanup = vi.spyOn(rig.runtime, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
    vi.spyOn(rig.runtime, 'writeArtifact').mockReturnValue('/owned/cleanup.json')
    vi.stubEnv('PATH', `${root}${path.delimiter}${process.env.PATH}`)
    let observedFailure = false
    const probe = rig.ownedProviderExec(handle.containerId, ['node', '--version']).catch(() => { observedFailure = true })
    let pid: number | undefined
    try {
      await vi.waitFor(async () => { pid = Number(await fsp.readFile(pidFile, 'utf8')); expect(pid).toBeGreaterThan(1) })
      await expect(rig.stop()).resolves.toEqual({ ok: true, errors: [] })
      await probe
      expect(observedFailure).toBe(true)
      await expect(fsp.stat(`/proc/${pid}`)).rejects.toThrow()
      expect(cleanup).toHaveBeenCalledOnce()
    } finally {
      await rig.stop()
      await probe
      vi.unstubAllEnvs()
      await fsp.rm(root, { recursive: true })
    }
  })
  it('reads challenge IDs from actual SQLite rows while retaining transcript bytes on the owner', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-fixed-native-probe-'))
    const file = path.join(root, 'opencode.db')
    const seed = `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);
      db.exec('CREATE TABLE session(id TEXT);CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);CREATE TABLE part(id TEXT,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT)');
      db.prepare('INSERT INTO session VALUES(?)').run('native-owned');
      db.prepare('INSERT INTO message VALUES(?,?,?,?)').run('actual-message','native-owned',1,JSON.stringify({role:'assistant',time:{completed:2},providerID:'synthetic',modelID:'synthetic'}));
      const insert=db.prepare('INSERT INTO part VALUES(?,?,?,?,?)');
      insert.run('actual-text','native-owned','actual-message',1,JSON.stringify({type:'text',text:'P5_CHAOS_FOLLOWUP synthetic owner-only response'}));
      insert.run('actual-tool','native-owned','actual-message',2,JSON.stringify({type:'tool',tool:'bash',state:{status:'completed',input:'p5-chaos-approval-count'}}));db.close();`
    execFileSync(process.execPath, ['--no-warnings', '-e', seed, file])
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web factory') }, fixtureRepoRoot)
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    vi.spyOn(rig, 'ownedProviderExec').mockImplementation(async (containerId, args) => {
      expect(containerId).toBe(current.containerId)
      expect(args[0]).toBe('node')
      expect(args[4]).toBe('/home/freshell/provider/.local/share/opencode/opencode.db')
      const nodeArgs = args.slice(1)
      nodeArgs[3] = file
      return execFileSync(process.execPath, nodeArgs, { encoding: 'utf8' })
    })
    try {
      const approval = await rig.registerNativeChallenge(current, 'chaos-approval')
      const followUp = await rig.registerNativeChallenge(current, 'chaos-follow-up')
      expect(await rig.nativeToolEvidence(current, approval.challengeId)).toEqual({ requestIds: ['actual-tool'], resultIds: ['actual-tool'], replayCount: 0 })
      const ids = await rig.nativeFollowUpMessageIds(current, followUp.challengeId)
      expect(ids).toEqual(['actual-message'])
      expect(JSON.stringify(ids)).not.toContain('synthetic owner-only response')
      await expect(rig.nativeFollowUpMessageIds({ ...current, nativeSessionId: 'foreign-root' }, followUp.challengeId)).rejects.toThrow(/challenge/)
    } finally {
      await fsp.rm(root, { recursive: true })
    }
  })
  it('reads fixed facts only for the current exact owned runtime', async () => {
    const { adapter, read } = fixture()
    const value = await owner.readExactRuntimeHostFacts(adapter, handle)
    expect(value.workerPid).toBe(42)
    expect(value.workerLaunchCount).toBe(1)
    expect(value.limits.swapMax).toBe('0')
    expect(read).toHaveBeenCalledExactlyOnceWith(handle)
  })

  it.each([
    { runId: 'another-run' }, { candidateSha: 'c'.repeat(40) },
    { soulId: 'another-soul' }, { incarnationId: 'old-incarnation' },
    { containerId: 'b'.repeat(12) }, { containerId: 'c'.repeat(64) },
    { hostBootId: 'old-boot' }, { nativeSessionId: 'another-root' },
  ])('refuses a mismatched handle %j before any owner read', async (changed) => {
    const { adapter, read } = fixture()
    await expect(owner.readExactRuntimeHostFacts(adapter, { ...handle, ...changed })).rejects.toThrow(/exact|owned|current/)
    expect(read).not.toHaveBeenCalled()
  })

  it('refuses a replaced current incarnation before reading retained evidence', async () => {
    const { adapter, read, row } = fixture()
    row.incarnationId = 'replacement'
    await expect(owner.readExactRuntimeHostFacts(adapter, handle)).rejects.toThrow(/current/)
    expect(read).not.toHaveBeenCalled()
  })

  it('refuses an inventory identity without a broker ownership receipt', async () => {
    const { adapter, read } = fixture()
    adapter.receipts = () => []
    await expect(owner.readExactRuntimeHostFacts(adapter, handle)).rejects.toThrow(/owned/)
    expect(read).not.toHaveBeenCalled()
  })

  it.each([
    { workerPid: 0 }, { workerLaunchCount: -1 }, { unsafeBrokerAttempts: NaN },
    { limits: { cpuMax: '50000 100000', memoryMax: 'truncated', swapMax: '0', pidsMax: '64' } },
  ])('refuses malformed observed owner facts %j', async (changed) => {
    const { adapter, read } = fixture()
    read.mockResolvedValue({ ...await read(), ...changed })
    await expect(owner.readExactRuntimeHostFacts(adapter, handle)).rejects.toThrow(/facts/)
  })
})

describe('registered fresh fixture state decoder', () => {
  it('returns actual native state without treating the requested root as evidence', () => {
    expect(owner.decodeFixtureNativeState({
      nativeSessionId: 'native-actual', pendingDecisionId: null, dispatchCount: 2, completionCount: 1,
    }, 'native-actual')).toEqual({ nativeSessionId: 'native-actual', pendingDecisionId: null, dispatchCount: 2, completionCount: 1 })
  })
  it.each([
    { nativeSessionId: 'wrong-root' }, { pendingDecisionId: 5 },
    { pendingDecisionId: '' }, { dispatchCount: 1.5 }, { completionCount: -1 },
  ])('rejects wrong-root or truncated native fixture observations %j', (changed) => {
    expect(() => owner.decodeFixtureNativeState({
      nativeSessionId: 'native-actual', pendingDecisionId: null, dispatchCount: 2, completionCount: 1, ...changed,
    }, 'native-actual')).toThrow(/fixture/)
  })
})

describe('owned rig cleanup settlement', () => {
  it('attempts every held host release, web stop and runtime cleanup after a release failure', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web factory') }, fixtureRepoRoot)
    const first = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    const second = { ...first, soulId: 'second-owned-soul', incarnationId: 'second-owned-incarnation', containerId: 'd'.repeat(64) }
    vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    const signal = vi.spyOn(rig, 'signalOwnedSessionHostExact').mockImplementation((_container, incarnation, signal) => {
      if (signal === 'SIGCONT' && incarnation === first.incarnationId) throw new Error('owned release failed')
      return incarnation === first.incarnationId ? 1234 : 1235
    })
    const web = new RustServer()
    rig.web = web
    const stopWeb = vi.spyOn(web, 'stop').mockResolvedValue(undefined)
    const cleanup = vi.spyOn(rig.runtime, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
    vi.spyOn(rig.runtime, 'writeArtifact').mockReturnValue('/owned/cleanup.json')
    await rig.holdRuntimeHost(first)
    await rig.holdRuntimeHost(second)
    const result = await rig.stop()
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/held|release/)
    expect(signal).toHaveBeenCalledWith(first.containerId, first.incarnationId, 'SIGCONT', 1234)
    expect(signal).toHaveBeenCalledWith(second.containerId, second.incarnationId, 'SIGCONT', 1235)
    expect(stopWeb).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
  })
  it('retains web stop failure and still cleans its runtime resources', async () => {
    const stopWeb = vi.fn().mockRejectedValue(new Error('owned web did not stop'))
    const cleanupRuntime = vi.fn().mockResolvedValue({ ok: true, errors: [] })
    await expect(owner.settleOwnedRuntimeCleanup(stopWeb, cleanupRuntime)).resolves.toEqual({
      ok: false, errors: ['web stop: owned web did not stop'],
    })
    expect(stopWeb).toHaveBeenCalledOnce()
    expect(cleanupRuntime).toHaveBeenCalledOnce()
  })
  it('retains every observed runtime cleanup failure', async () => {
    const stopWeb = vi.fn().mockResolvedValue(undefined)
    const cleanupRuntime = vi.fn().mockResolvedValue({ ok: false, errors: ['owned host remains', 'owned volume remains'] })
    await expect(owner.settleOwnedRuntimeCleanup(stopWeb, cleanupRuntime)).resolves.toEqual({
      ok: false, errors: ['owned host remains', 'owned volume remains'],
    })
  })
  it('settles a rejected runtime cleanup as a failure', async () => {
    await expect(owner.settleOwnedRuntimeCleanup(async () => {}, async () => { throw new Error('owner cleanup failed') }))
      .resolves.toEqual({ ok: false, errors: ['runtime cleanup: owner cleanup failed'] })
  })
  it('settles actual owner cleanup rejection even when runtime produced no cleanup artifact', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web factory') }, fixtureRepoRoot)
    vi.spyOn(rig.runtime, 'cleanup').mockRejectedValue(new Error('owned cleanup rejected'))
    const write = vi.spyOn(rig.runtime, 'writeArtifact').mockReturnValue('/owned/cleanup.json')
    await expect(rig.stop()).resolves.toEqual({ ok: false, errors: ['runtime cleanup: owned cleanup rejected'] })
    expect(write).toHaveBeenCalledWith('cleanup.json', expect.objectContaining({ ok: false }))
  })
  it('settles repeated successful owner finish once', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web factory') }, fixtureRepoRoot)
    const cleanup = vi.spyOn(rig.runtime, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
    vi.spyOn(rig.runtime, 'writeArtifact').mockReturnValue('/owned/cleanup.json')
    await expect(rig.stop()).resolves.toEqual({ ok: true, errors: [] })
    await expect(rig.stop()).resolves.toEqual({ ok: true, errors: [] })
    expect(cleanup).toHaveBeenCalledOnce()
  })
})

describe('run-scoped owner operation settlement', () => {
  it('serializes owner mutations and settles a timed-out duplicate operation only once', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const actions: string[] = []
    const perform = vi.fn(async (request: { action: string }) => {
      actions.push(request.action)
      if (request.action === 'replace-web') await blocked
      return { action: request.action }
    })
    const queue = new owner.RuntimeOwnerOperationQueue(handle.runId, handle.candidateSha, 'fixture-owned', perform)
    const first = queue.perform({ runId: handle.runId, candidateSha: handle.candidateSha, scenarioId: 'fixture-owned', operationId: 'operation-one', action: 'replace-web' })
    const duplicate = queue.perform({ runId: handle.runId, candidateSha: handle.candidateSha, scenarioId: 'fixture-owned', operationId: 'operation-one', action: 'replace-web' })
    const next = queue.perform({ runId: handle.runId, candidateSha: handle.candidateSha, scenarioId: 'fixture-owned', operationId: 'operation-two', action: 'replace-supervisor' })
    await Promise.resolve()
    expect(actions).toEqual(['replace-web'])
    release()
    await expect(first).resolves.toEqual({ action: 'replace-web' })
    await expect(duplicate).resolves.toEqual({ action: 'replace-web' })
    await expect(next).resolves.toEqual({ action: 'replace-supervisor' })
    expect(perform).toHaveBeenCalledTimes(2)
  })

  it.each([{ runId: 'other-run' }, { candidateSha: 'c'.repeat(40) }, { scenarioId: 'other-fixture' }, { action: 'exec' }])(
    'refuses an unowned or unsupported owner request %j', async (changed) => {
      const perform = vi.fn().mockResolvedValue({})
      const queue = new owner.RuntimeOwnerOperationQueue(handle.runId, handle.candidateSha, 'fixture-owned', perform)
      await expect(queue.perform({ runId: handle.runId, candidateSha: handle.candidateSha,
        scenarioId: 'fixture-owned', operationId: 'operation-one', action: 'inventory', ...changed,
      })).rejects.toThrow(/owned|operation/)
      expect(perform).not.toHaveBeenCalled()
    },
  )

  it('refuses reuse of an operation ID for a different mutation', async () => {
    const perform = vi.fn().mockResolvedValue({})
    const queue = new owner.RuntimeOwnerOperationQueue(handle.runId, handle.candidateSha, 'fixture-owned', perform)
    const request = { runId: handle.runId, candidateSha: handle.candidateSha,
      scenarioId: 'fixture-owned', operationId: 'operation-one', action: 'replace-web' }
    await queue.perform(request)
    await expect(queue.perform({ ...request, action: 'replace-supervisor' })).rejects.toThrow(/operation/)
    expect(perform).toHaveBeenCalledOnce()
  })
})

describe('current handle admission before owner mutation', () => {
  it('reads unchanged stopped history through the tracked helper and returns only the original three proofs', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-stopped-proofs-'))
    const nonce = `codename-${'e'.repeat(32)}`
    const historyFile = path.join(root, 'history.json')
    const callsFile = path.join(root, 'calls.jsonl')
    const helperId = 'c'.repeat(64)
    const docker = path.join(root, 'docker')
    await fsp.writeFile(docker, `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify({args:a,host:process.env.DOCKER_HOST,api:process.env.DOCKER_API_VERSION})+'\\n');if(a[0]==='create')process.stdout.write('${helperId}');else if(a[0]==='wait')process.stdout.write('0');else if(a[0]==='logs')process.stdout.write(fs.readFileSync(${JSON.stringify(historyFile)},'utf8'));else if(!['start','rm'].includes(a[0]))process.exit(10);\n`, { mode: 0o700 })
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused stopped-proof web') }, fixtureRepoRoot, 5,
      {}, {}, 'release', { enabledProviders: ['codex'], freshAgentModes: [] })
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    const row = { ...current, provider: 'codex', launchState: 'stopped', desiredState: 'stopped', cleanupState: 'verified_empty', intentRevision: 1 }
    const inventory = vi.spyOn(rig, 'inventory').mockResolvedValue([row])
    Object.defineProperty(rig.runtime, 'broker', { value: { proxySocketPath: path.join(root, 'broker.sock'),
      receiptIds: () => new Set([current.containerId, helperId]), receipts: () => [{ ...current,
        providerVolumeName: 'freshell-provider-aaaaaaaaaaaaaaaaaaaaaaaa', workspacePath: rig.repoRoot, imageRef: rig.runtime.imageRef }] } })
    vi.spyOn(rig, 'ownedContainerState').mockResolvedValue({ present: false, running: false })
    const claim = vi.spyOn(rig, 'writerClaimFacts').mockResolvedValue({ provider: 'codex', providerStoreId: 'owned-store',
      nativeSessionId: current.nativeSessionId, soulId: current.soulId, incarnationId: current.incarnationId,
      activeClaimCount: 0, globalConflictingClaimCount: 0 })
    vi.spyOn(rig.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    const history: NativeHistory = { schemaVersion: 1, provider: 'codex', nativeSessionId: current.nativeSessionId,
      turns: [1, 2, 3].map(index => ({ nativeEvidence: { kind: 'identified_message', turnId: `turn-${index}`, messageId: `message-${index}`, parentMessageId: null },
        text: `private native answer ${nonce} ${index}`, completedAt: index, toolCalls: [], resolvedProvider: 'openai', resolvedModel: 'gpt-5.6-luna',
        resolvedReasoningEffort: 'low', providerProvenance: 'native-fixture', modelProvenance: 'native-fixture', reasoningEffortProvenance: 'native-fixture' })) }
    await fsp.writeFile(historyFile, JSON.stringify(history))
    vi.stubEnv('PATH', `${root}${path.delimiter}${process.env.PATH}`)
    try {
      const proofs = await rig.managedTerminalStoppedProofs(current, nonce)
      expect(proofs.map(proof => proof.stage)).toEqual(['initial', 'after_session_host_crash', 'after_provider_process_crash'])
      expect(proofs.map(proof => proof.nativeEvidence)).toEqual(history.turns.map(turn => turn.nativeEvidence))
      expect(JSON.stringify(proofs)).not.toContain('private native answer')
      expect(JSON.stringify(proofs)).not.toContain(nonce)
      const calls = (await fsp.readFile(callsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      expect(calls.map(call => call.args[0])).toEqual(['create', 'start', 'wait', 'logs', 'rm'])
      expect(calls.every(call => call.host === `unix://${rig.runtime.broker.proxySocketPath}` && call.api === '1.47')).toBe(true)
      await fsp.writeFile(historyFile, JSON.stringify({ ...history, nativeSessionId: 'foreign-native-root' }))
      await expect(rig.managedTerminalStoppedProofs(current, nonce)).rejects.toThrow(/identity differs/)
      expect(JSON.parse((await fsp.readFile(callsFile, 'utf8')).trim().split('\n').at(-1) ?? '{}').args[0]).toBe('rm')
      await fsp.writeFile(historyFile, JSON.stringify({ ...history, turns: history.turns.slice(0, 2) }))
      await expect(rig.managedTerminalStoppedProofs(current, nonce)).rejects.toThrow(/exactly three/)
      expect(JSON.parse((await fsp.readFile(callsFile, 'utf8')).trim().split('\n').at(-1) ?? '{}').args[0]).toBe('rm')
      const before = await fsp.readFile(callsFile, 'utf8')
      claim.mockResolvedValue({ provider: 'codex', providerStoreId: 'owned-store', nativeSessionId: current.nativeSessionId,
        soulId: current.soulId, incarnationId: current.incarnationId, activeClaimCount: 1, globalConflictingClaimCount: 0 })
      await expect(rig.managedTerminalStoppedProofs(current, nonce)).rejects.toThrow(/writer/)
      expect(await fsp.readFile(callsFile, 'utf8')).toBe(before)
      inventory.mockResolvedValue([{ ...row, launchState: 'running' }])
      await expect(rig.managedTerminalStoppedProofs(current, nonce)).rejects.toThrow(/stopped/)
      expect(await fsp.readFile(callsFile, 'utf8')).toBe(before)
    } finally { vi.unstubAllEnvs(); await fsp.rm(root, { recursive: true, force: true }) }
  })
  it.each([
    { provider: 'claude', version: '2.1.263', process: '42 /usr/bin/claude --model haiku --effort low', identities: ['haiku', 'low'], effortAbsent: false },
    { provider: 'codex', version: '0.147.0', process: '42 /usr/bin/codex -m gpt-5.6-luna --reasoning-effort low', identities: ['low', 'gpt-5.6-luna'], effortAbsent: false },
    { provider: 'opencode', version: '1.18.21', process: '42 /usr/bin/opencode --model openai/gpt-5.6-luna', identities: ['openai/gpt-5.6-luna'], effortAbsent: true },
    { provider: 'amplifier', version: '0.1.1', process: '42 /usr/bin/amplifier resume', identities: [], effortAbsent: true },
  ])('projects fixed terminal startup facts for $provider without exposing the process table', async ({ provider, version, process, identities, effortAbsent }) => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused startup web') }, fixtureRepoRoot, 5,
      {}, {}, 'release', { enabledProviders: [provider], freshAgentModes: [] })
    const current = rig.runtimeEnclosureHandle(handle)
    const inventory = vi.spyOn(rig, 'inventory').mockResolvedValue([{ ...current, provider, launchState: 'running', intentRevision: 1 }])
    Object.defineProperty(rig.runtime, 'broker', { value: { receipts: () => [current] } })
    const limits = { cpuMax: '50000 100000', memoryMax: '268435456', swapMax: '0', pidsMax: '32' }
    const probe = vi.spyOn(rig, 'ownedProviderExec').mockImplementation(async (_container, args) => args[0] === 'ps'
      ? `${process}\n43 private-unrelated-process --secret private-value` : args[0] === 'node' ? JSON.stringify(limits) : `${version} (provider)\n`)
    await expect(rig.managedTerminalStartupFacts(current)).resolves.toEqual({ provider, version: `${version} (provider)\n`,
      providerProcessPresent: true, processIdentities: identities, reasoningFlagsAbsent: effortAbsent, limits })
    expect(probe).toHaveBeenLastCalledWith(current.containerId, ['ps', '-eo', 'pid,args'])
    if (provider === 'amplifier') expect(probe).toHaveBeenNthCalledWith(1, current.containerId,
      ['/opt/amplifier-src/.venv/bin/python', '-c', 'import importlib.metadata as m; print(m.version("amplifier-app-cli"))'])
    else expect(probe).toHaveBeenNthCalledWith(1, current.containerId, [provider, '--version'])
    probe.mockImplementation(async (_container, args) => args[0] === 'ps' ? `42 ${provider}-impostor --model fake-haiku --reasoning-effort=not-low` : args[0] === 'node' ? JSON.stringify(limits) : version)
    await expect(rig.managedTerminalStartupFacts(current)).resolves.toMatchObject({ providerProcessPresent: false, processIdentities: [], reasoningFlagsAbsent: false })
    probe.mockClear()
    inventory.mockResolvedValue([{ ...current, provider: 'foreign-provider', launchState: 'running', intentRevision: 1 }])
    await expect(rig.managedTerminalStartupFacts(current)).rejects.toThrow(/registered.*terminal/)
    expect(probe).not.toHaveBeenCalled()
    inventory.mockResolvedValue([{ ...current, provider, hostBootId: 'replacement-boot', launchState: 'running', intentRevision: 1 }])
    await expect(rig.managedTerminalStartupFacts(current)).rejects.toThrow(/current.*enclosure/)
    expect(probe).not.toHaveBeenCalled()
  })
  it('reads the registered terminal provider notice count with the current controller fence', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused terminal web') }, fixtureRepoRoot, 5,
      {}, {}, 'release', { enabledProviders: ['codex'], freshAgentModes: [] })
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    const row = { ...current, provider: 'codex', launchState: 'running', intentRevision: 1 }
    const admission = vi.spyOn(rig, 'assertCurrentHandle').mockResolvedValue(undefined)
    const inventory = vi.spyOn(rig, 'inventory').mockResolvedValue([row])
    Object.defineProperty(rig.runtime, 'broker', { value: { receipts: () => [current] } })
    vi.spyOn(rig, 'controlEpoch').mockResolvedValue(7)
    const body = vi.spyOn(rig.runtime, 'pendingNoticesBody')
    const admin = vi.spyOn(rig.runtime, 'adminOk').mockResolvedValue({ kind: 'pending_notices', data: [{ privateText: 'owner only' }] })
    await expect(rig.managedProviderPendingNoticeCount(current)).resolves.toBe(1)
    expect(body).toHaveBeenCalledExactlyOnceWith('profile:managed-provider-qualification:codex', 100, 7)
    admin.mockResolvedValue({ kind: 'pending_notices', data: [] })
    await expect(rig.managedProviderPendingNoticeCount(current)).resolves.toBe(0)
    admin.mockResolvedValue({ kind: 'inventory', data: [] })
    await expect(rig.managedProviderPendingNoticeCount(current)).rejects.toThrow()
    admin.mockClear()
    inventory.mockResolvedValue([{ ...row, provider: 'claude' }])
    await expect(rig.managedProviderPendingNoticeCount(current)).rejects.toThrow(/registered.*terminal/)
    expect(admin).not.toHaveBeenCalled()
    inventory.mockResolvedValue([{ ...row, freshAgentSessionType: 'freshcodex' }])
    await expect(rig.managedProviderPendingNoticeCount(current)).rejects.toThrow(/registered.*terminal/)
    expect(admin).not.toHaveBeenCalled()
    admission.mockRejectedValue(new Error('stale current runtime'))
    await expect(rig.managedProviderPendingNoticeCount(current)).rejects.toThrow(/stale current/)
    expect(admin).not.toHaveBeenCalled()
  })
  function rigFixture() {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('web is not used by this unit') }, fixtureRepoRoot, 3, {}, {}, 'test', {
      enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'],
    })
    const current = { ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha }
    const row = { ...current, launchState: 'running', intentRevision: 1, provider: 'codex', freshAgentSessionType: 'freshcodex' }
    vi.spyOn(rig, 'inventory').mockResolvedValue([row])
    Object.defineProperty(rig.runtime, 'broker', { value: { receipts: () => [{ ...current, providerVolumeName: 'volume-owned' }] } })
    const kill = vi.spyOn(rig.runtime, 'killOwnedRuntimeExact').mockImplementation(() => {})
    return { rig, current, row, kill }
  }
  it('crashes only the current receipt-owned host', async () => {
    const { rig, current, kill } = rigFixture()
    await rig.crashRuntimeHost(current)
    expect(kill).toHaveBeenCalledExactlyOnceWith(current.containerId)
  })
  it('keeps stopped history out of current address and fixture-registration selection', async () => {
    const { rig, current, row } = rigFixture()
    const prior = { ...row, incarnationId: 'prior-incarnation', containerId: 'c'.repeat(64), hostBootId: 'prior-boot',
      launchState: 'stopped', freshAgentSessionType: 'freshclaude', provider: 'claude' }
    vi.spyOn(rig, 'inventory').mockResolvedValue([prior, row])
    await expect(rig.providerVolumeFacts(current)).resolves.toEqual({ providerVolumeName: 'volume-owned' })
    const state = { nativeSessionId: current.nativeSessionId, pendingDecisionId: 'pending-owned', dispatchCount: 2, completionCount: 1 }
    const read = vi.spyOn(rig.runtime, 'fixtureNativeState').mockImplementation(async (_instance, _address, capture) => {
      capture?.({ ...state, schemaVersion: 1, createProfile: { fixtureTransport: true } })
      return state
    })
    await expect(rig.fixtureNativeState(current)).resolves.toEqual(state)
    expect(read).toHaveBeenCalledExactlyOnceWith(rig.supervisor, current, expect.any(Function))
  })
  it('refuses stale incarnation and boot before signalling a host', async () => {
    const { rig, current, row, kill } = rigFixture()
    row.hostBootId = 'replacement-boot'
    await expect(rig.crashRuntimeHost(current)).rejects.toThrow(/current/)
    expect(kill).not.toHaveBeenCalled()
  })
  it('refuses an ambiguous inventory even when the second row lacks native identity', async () => {
    const { rig, current, row, kill } = rigFixture()
    vi.mocked(rig.inventory).mockResolvedValue([row, { soulId: row.soulId, incarnationId: 'ambiguous', launchState: 'starting', intentRevision: 2 }])
    await expect(rig.crashRuntimeHost(current)).rejects.toThrow(/ambiguous|current/)
    expect(kill).not.toHaveBeenCalled()
  })
  it('returns provider-volume facts only for the exact current owner', async () => {
    const { rig, current } = rigFixture()
    await expect(rig.providerVolumeFacts(current)).resolves.toEqual({ providerVolumeName: 'volume-owned' })
    await expect(rig.providerVolumeFacts({ ...current, nativeSessionId: 'foreign-root' })).rejects.toThrow(/current/)
  })
  it('queries only the exact writer incarnation while retaining its stopped zero-claim observation', async () => {
    const { rig, current, row } = rigFixture()
    const prior = { ...row, incarnationId: 'prior-incarnation', containerId: 'c'.repeat(64), hostBootId: 'prior-boot',
      launchState: 'stopped', provider: 'claude' }
    const inventory = vi.mocked(rig.inventory).mockResolvedValue([prior, row])
    const facts = { provider: row.provider, providerStoreId: 'owned-store', nativeSessionId: current.nativeSessionId,
      soulId: current.soulId, incarnationId: current.incarnationId, activeClaimCount: 1, globalConflictingClaimCount: 0 }
    const claim = vi.spyOn(rig, 'qualificationWriterClaim').mockResolvedValue(facts)
    await expect(rig.writerClaimFacts(current)).resolves.toEqual(facts)
    expect(claim).toHaveBeenCalledExactlyOnceWith({ provider: row.provider, nativeSessionId: current.nativeSessionId,
      soulId: current.soulId, incarnationId: current.incarnationId })
    row.launchState = 'stopped'
    claim.mockResolvedValue({ ...facts, activeClaimCount: 0 })
    await expect(rig.writerClaimFacts(current)).resolves.toMatchObject({ activeClaimCount: 0 })
    claim.mockClear()
    for (const changed of [{ hostBootId: 'foreign-boot' }, { nativeSessionId: 'foreign-root' },
      { runId: 'foreign-run' }, { candidateSha: 'f'.repeat(40) }]) {
      await expect(rig.writerClaimFacts({ ...current, ...changed })).rejects.toThrow(/writer|owned|root/)
    }
    expect(claim).not.toHaveBeenCalled()
    inventory.mockResolvedValue([prior, row, row])
    await expect(rig.writerClaimFacts(current)).rejects.toThrow(/writer|current/)
    expect(claim).not.toHaveBeenCalled()
  })
  it('observes and crashes the registered fixture worker using owner-derived PID only', async () => {
    const { rig, current } = rigFixture()
    const read = vi.spyOn(rig.runtime, 'execOwnedContainerExact').mockReturnValue('PID COMMAND\n42 node fresh-agent-fixture-worker.mjs --provider codex\n')
    const kill = vi.spyOn(rig.runtime, 'killOwnedRuntimePidExact').mockImplementation(() => {})
    await expect(rig.fixtureWorkerFacts(current)).resolves.toEqual({ provider: 'codex', workerPid: 42 })
    await rig.crashFixtureWorker(current)
    expect(read).toHaveBeenCalledWith(current.containerId, ['ps', '-eo', 'pid,args'])
    expect(kill).toHaveBeenCalledExactlyOnceWith(current.containerId, 42)
  })
  it('refuses ambiguous workers and non-fixture registrations before signalling', async () => {
    const { rig, current, row } = rigFixture()
    vi.spyOn(rig.runtime, 'execOwnedContainerExact').mockReturnValue('42 node fresh-agent-fixture-worker --provider codex\n43 node fresh-agent-fixture-worker --provider codex\n')
    const kill = vi.spyOn(rig.runtime, 'killOwnedRuntimePidExact').mockImplementation(() => {})
    await expect(rig.crashFixtureWorker(current)).rejects.toThrow(/fixture/)
    row.freshAgentSessionType = 'unregistered-mode'
    await expect(rig.crashFixtureWorker(current)).rejects.toThrow(/fixture/)
    expect(kill).not.toHaveBeenCalled()
  })
  it('allows only the actually pending deterministic fixture decision', async () => {
    const { rig, current } = rigFixture()
    vi.spyOn(rig, 'fixtureNativeState').mockResolvedValue({ nativeSessionId: current.nativeSessionId,
      pendingDecisionId: 'pending-owned', dispatchCount: 2, completionCount: 1 })
    vi.spyOn(rig, 'controlEpoch').mockResolvedValue(2)
    const admin = vi.spyOn(rig.runtime, 'adminOk').mockResolvedValue({ kind: 'ack' })
    await expect(rig.allowFixtureDecision(current, 'foreign-decision')).rejects.toThrow(/pending/)
    expect(admin).not.toHaveBeenCalled()
    await rig.allowFixtureDecision(current, 'pending-owned')
    expect(admin).toHaveBeenCalledExactlyOnceWith(rig.supervisor,
      rig.runtime.freshAgentResolveBody(current.soulId, 'pending-owned', { behavior: 'allow' }, 2))
  })
})

describe('run-owned workload image build', () => {
  it('builds and resolves only the exact run tag instead of the shared runtime tag', () => {
    const runId = '7aab49a4-08ed-4ca7-a4b2-6501f4821a63'
    const child = vi.fn<typeof execFileSync>().mockReturnValue(`sha256:${'c'.repeat(64)}\n`)
    const result = owner.buildRunOwnedRuntimeImage(process.cwd(), runId, handle.candidateSha, child)
    expect(result.digest).toBe(`sha256:${'c'.repeat(64)}`)
    expect(result.tag).toContain(runId)
    expect(child).toHaveBeenNthCalledWith(1, 'docker', expect.arrayContaining(['build', '-t', result.tag]), expect.objectContaining({ cwd: process.cwd() }))
    expect(child).toHaveBeenNthCalledWith(2, 'docker', ['image', 'inspect', result.tag, '--format', '{{.Id}}'], expect.objectContaining({ encoding: 'utf8' }))
    expect(child.mock.calls.flatMap(call => call[1] ?? [])).not.toContain(owner.PHASE2_RUNTIME_IMAGE_TAG)
  })
  it('refuses an invalid observed image digest instead of certifying a tag as an artifact', () => {
    const child = vi.fn<typeof execFileSync>().mockReturnValue('not-a-digest')
    expect(() => owner.buildRunOwnedRuntimeImage(process.cwd(), '7aab49a4-08ed-4ca7-a4b2-6501f4821a63', handle.candidateSha, child)).toThrow(/pinned|digest/)
  })
  it('admits image deletion only for the actual run tag, labels and immutable digest', () => {
    const context = { tag: 'freshell-managed-runtime:owned-test', runId: handle.runId,
      candidateSha: handle.candidateSha, digest: `sha256:${'c'.repeat(64)}` }
    const image = { Id: context.digest, RepoTags: [context.tag], Config: { Labels: {
      'com.freshell.runtime-test-run-id': context.runId,
      'com.freshell.runtime-test-candidate': context.candidateSha,
    } } }
    expect(() => owner.assertRunOwnedRuntimeImage([image], context)).not.toThrow()
    expect(() => owner.assertRunOwnedRuntimeImage([{ ...image, Id: `sha256:${'d'.repeat(64)}` }], context)).toThrow(/owned/)
    expect(() => owner.assertRunOwnedRuntimeImage([{ ...image, RepoTags: ['foreign-image:tag'] }], context)).toThrow(/owned/)
    expect(() => owner.assertRunOwnedRuntimeImage([{ ...image, Config: { Labels: {} } }], context)).toThrow(/owned/)
  })
  it('removes only a verified owned tag and verifies its absence, retaining unrelated images', () => {
    const context = { tag: 'freshell-managed-runtime:owned-test', runId: handle.runId,
      candidateSha: handle.candidateSha, digest: `sha256:${'c'.repeat(64)}` }
    const image = { Id: context.digest, RepoTags: [context.tag], Config: { Labels: {
      'com.freshell.runtime-test-run-id': context.runId,
      'com.freshell.runtime-test-candidate': context.candidateSha,
    } } }
    let removed = false
    const execute = vi.fn<typeof execFileSync>().mockImplementation((_command, args) => {
      if (args?.[1] === 'ls') return `${removed ? '' : `${context.tag}\n`}unrelated-image:tag\n`
      if (args?.[1] === 'inspect') return JSON.stringify([image])
      if (args?.[1] === 'rm') { removed = true; return '' }
      throw new Error('unexpected image operation')
    })
    expect(() => owner.removeRunOwnedRuntimeImage(context, execute)).not.toThrow()
    expect(execute).toHaveBeenCalledWith('docker', ['image', 'rm', context.tag], expect.anything())
    expect(execute.mock.calls.some(call => call[1]?.includes('unrelated-image:tag'))).toBe(false)
    removed = false
    const retained = vi.fn<typeof execFileSync>().mockImplementation((_command, args) =>
      args?.[1] === 'inspect' ? JSON.stringify([image]) : `${context.tag}\n`)
    expect(() => owner.removeRunOwnedRuntimeImage(context, retained)).toThrow(/remains/)
    const foreign = vi.fn<typeof execFileSync>().mockImplementation((_command, args) =>
      args?.[1] === 'inspect' ? JSON.stringify([{ ...image, Config: { Labels: {} } }]) : `${context.tag}\n`)
    expect(() => owner.removeRunOwnedRuntimeImage(context, foreign)).toThrow(/owned/)
    expect(foreign.mock.calls.some(call => call[1]?.[1] === 'rm')).toBe(false)
  })
})

describe('external owner provider-root isolation', () => {
  it('keeps operator homes out of the owner registration while preserving existing local root discovery', async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'task008-root-admission-'))
    try {
      await fsp.mkdir(path.join(home, '.codex'))
      await fsp.mkdir(path.join(home, '.config/opencode'), { recursive: true })
      expect(owner.runtimeProviderUserRoots(true, home)).toEqual([])
      expect(owner.runtimeProviderUserRoots(false, home)).toEqual([
        path.join(home, '.codex'), path.join(home, '.config/opencode'),
      ])
    } finally { await fsp.rm(home, { recursive: true }) }
  })
})

describe('actual owned runtime cleanup observations', () => {
  const expected = { containerIds: ['b'.repeat(64)], volumes: ['owned-volume'] }
  it('requires exact owned containers and volumes absent while retaining unrelated resources', () => {
    expect(() => owner.verifyRuntimeCleanupAbsence(expected, { containerIds: ['c'.repeat(64)], volumes: ['unrelated-volume'] })).not.toThrow()
    expect(() => owner.verifyRuntimeCleanupAbsence(expected, { containerIds: expected.containerIds, volumes: [] })).toThrow(/remains/)
    expect(() => owner.verifyRuntimeCleanupAbsence(expected, { containerIds: [], volumes: expected.volumes })).toThrow(/remains/)
  })
  it('refuses unread, partial or malformed resource observations as cleanup proof', () => {
    expect(() => owner.verifyRuntimeCleanupAbsence(expected, {})).toThrow(/observation/)
    expect(() => owner.verifyRuntimeCleanupAbsence(expected, { containerIds: ['b'.repeat(12)], volumes: [] })).toThrow(/observation/)
  })
  it('retains helper-name absence as required evidence when create acknowledgement was lost', () => {
    const helperNames = ['freshell-history-11111111-1111-4111-8111-111111111111']
    expect(() => owner.verifyRuntimeCleanupAbsence({ ...expected, helperNames }, { containerIds: [], volumes: [] })).toThrow(/observation/)
    expect(() => owner.verifyRuntimeCleanupAbsence({ ...expected, helperNames }, { containerIds: [], volumes: [], containerNames: helperNames })).toThrow(/remains/)
    expect(() => owner.verifyRuntimeCleanupAbsence({ ...expected, helperNames }, { containerIds: [], volumes: [], containerNames: ['unrelated-helper'] })).not.toThrow()
  })
})

describe('finite retained fresh native collection', () => {
  it('still attempts owned cleanup when writing incomplete collection status fails', async () => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') }, fixtureRepoRoot, 5, {}, {}, 'release', { enabledProviders: [], freshAgentModes: ['freshclaude'] })
    const collections = (rig as any).freshNativeCollections as Map<string, unknown>
    collections.set('fixture-collection', { closed: false, failed: true })
    const cleanup = vi.spyOn(rig.runtime, 'cleanup').mockResolvedValue({ ok: true, errors: [] })
    vi.spyOn(rig.runtime, 'writeArtifact').mockImplementation(name => { if (name === 'native-collection-status.json') throw new Error('controlled artifact write failure') })
    await expect(rig.stop()).rejects.toThrow(/artifact write failure/)
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it.each([false, true])('joins the full native file materialization before cleanup (abort=%s)', async abort => {
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') }, fixtureRepoRoot, 5, {}, {}, 'release', { enabledProviders: [], freshAgentModes: ['freshclaude'] })
    await fsp.mkdir(rig.runtime.evidenceDir, { recursive: true })
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const file = path.join(rig.runtime.evidenceDir, 'pending-native-original.jsonl')
    const cleanup = vi.spyOn(rig.runtime, 'cleanup').mockImplementation(async () => {
      expect(await fsp.readFile(file, 'utf8')).toBe('completed raw bytes\n')
      return { ok: true, errors: [] }
    })
    vi.spyOn(rig.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    const capture = (rig as any).trackNativeCapture(async () => { await pending; await fsp.writeFile(file, 'completed raw bytes\n') }) as Promise<void>
    if (abort) rig.abortFreshNativeCollections()
    const stop = rig.stop()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(cleanup).not.toHaveBeenCalled()
    release()
    await Promise.all([capture, stop])
    expect(cleanup).toHaveBeenCalledOnce()
    expect((rig as any).nativeCaptures.size).toBe(0)
  })

  it('selects the actual tagged SDK descendant while an unrelated global Claude is running', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'fresh-native-process-'))
    const executable = path.join(directory, 'claude'), entry = path.join(directory, 'index.mjs')
    const packageDir = path.join(directory, 'node_modules/@anthropic-ai/claude-agent-sdk')
    await fsp.mkdir(packageDir, { recursive: true })
    await fsp.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.237', claudeCodeVersion: '2.1.237', main: 'sdk.mjs' }))
    await fsp.writeFile(path.join(packageDir, 'sdk.mjs'), 'throw new Error("the fixture SDK must never execute")')
    const source = path.join(directory, 'fake.c')
    await fsp.writeFile(source, '#include <stdio.h>\n#include <string.h>\n#include <unistd.h>\nint main(int n,char**v){if(n>1&&!strcmp(v[1],"--version")){puts("2.1.237");return 0;}for(;;)pause();}')
    execFileSync('cc', [source, '-o', executable])
    await fsp.writeFile(entry, `import {spawn} from 'node:child_process';import fs from 'node:fs';const child=spawn(${JSON.stringify(executable)},['--model','haiku','--effort','low'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(path.join(directory, 'pid'))},String(child.pid));process.on('SIGTERM',()=>{child.kill();child.on('exit',()=>process.exit(0))});`)
    const sidecar = execFile(process.execPath, [entry], { cwd: directory, env: { ...process.env, HOME: directory,
      FRESHELL_CLAUDE_SIDECAR_ID: `fixture-${randomUUID()}`, FRESHELL_NATIVE_IDENTITY_LAUNCH: JSON.stringify({ incarnationId: 'fixture-incarnation' }) } })
    const unrelated = execFile(executable, [], { cwd: directory })
    try {
      const deadline = Date.now() + 5_000
      while (!fs.existsSync(path.join(directory, 'pid')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      const nativePid = Number(await fsp.readFile(path.join(directory, 'pid'), 'utf8'))
      // The host fixture uses its own UID; the container script retains the production UID 65534 guard.
      const script = owner.FRESH_AGENT_PROCESS_SCRIPT.replaceAll('==65534', '==os.getuid()')
      const measured = JSON.parse(execFileSync('python3', ['-c', script, 'claude', 'fixture-incarnation'], { encoding: 'utf8' }))
      expect(measured.native).toMatchObject({ pid: nativePid, parentPid: sidecar.pid, configuredModel: 'haiku', configuredEffort: 'low', cwd: directory })
      expect(measured.native.pid).not.toBe(unrelated.pid)
      expect(measured).toMatchObject({ version: '2.1.237', sdk: { version: '0.3.237', declaredNativeVersion: '2.1.237', modulePath: path.join(packageDir, 'sdk.mjs') } })
      expect(Buffer.from(measured.sdk.moduleBytesBase64, 'base64').toString()).toContain('must never execute')
      await fsp.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'wrong-selected-module', version: '0.3.237', main: 'sdk.mjs' }))
      expect(() => execFileSync('python3', ['-c', script, 'claude', 'fixture-incarnation'], { stdio: 'pipe' })).toThrow()
    } finally {
      const closed = [sidecar, unrelated].map(child => new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', () => resolve()) }))
      sidecar.kill('SIGTERM'); unrelated.kill('SIGTERM')
      await Promise.all(closed)
      await fsp.rm(directory, { recursive: true, force: true })
    }
  })

  it('retains three actual-format raw stages before owned cleanup deletes the source', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'fresh-native-collection-'))
    const rig = new owner.ManagedRuntimeOwner(() => { throw new Error('unused web') }, fixtureRepoRoot, 5, {}, {}, 'release', {
      enabledProviders: [], freshAgentModes: ['freshclaude'],
    })
    const nonce = `codename-${'a'.repeat(32)}`, nativeRoot = 'owned-native-root'
    const projects = path.join(directory, 'projects'); await fsp.mkdir(projects)
    const nativeFile = path.join(projects, `${nativeRoot}.jsonl`)
    await fsp.writeFile(nativeFile, JSON.stringify({ type: 'system', sessionId: nativeRoot, subtype: 'init' }) + '\n')
    const sdkPackage = Buffer.from(JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.237', claudeCodeVersion: '2.1.237' }))
    const sdkModule = Buffer.from('export const query = () => undefined'), sidecarEntry = Buffer.from('import {query} from "@anthropic-ai/claude-agent-sdk"')
    let generation = 1, stopped = false, sent = 0
    const current = () => ({ ...handle, runId: rig.runtime.runId, candidateSha: rig.runtime.candidateSha,
      incarnationId: `inc-${generation}`, containerId: String(generation).repeat(64), hostBootId: `boot-${generation}`,
      nativeSessionId: nativeRoot, provider: 'claude', freshAgentSessionType: 'freshclaude', freshAgentRuntimeVariant: 'claude-agent-sdk',
      launchState: stopped ? 'stopped' : 'running', desiredState: stopped ? 'stopped' : 'running', recoveryState: 'live', cleanupState: stopped ? 'verified_empty' : 'none',
      executionGeneration: generation, intentRevision: 1,
      nativeIdentityObservation: { nativeSessionId: nativeRoot, incarnationId: `inc-${generation}`, launchNonce: `launch-${generation}`,
        evidenceRevision: generation, evidenceDigest: 'c'.repeat(64) } })
    vi.spyOn(rig, 'inventory').mockImplementation(async () => [current()])
    vi.spyOn(rig, 'assertCurrentHandle').mockImplementation(async requested => { expect(requested).toMatchObject(rig.runtimeEnclosureHandle(current())) })
    rig.runtime.imageRef = `sha256:${'b'.repeat(64)}`
    rig.supervisor = { containerId: 'f'.repeat(64) } as any
    await fsp.mkdir(rig.runtime.evidenceDir, { recursive: true })
    rig.runtime.broker = new RestrictedDockerBroker({ realSocketPath: path.join(directory, 'unused.sock'), proxySocketPath: path.join(directory, 'proxy.sock'),
      runtimeRootPrefix: directory, allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set(), testRunId: rig.runtime.runId, logPath: path.join(directory, 'broker.jsonl') })
    vi.spyOn(rig.runtime.broker, 'receipts').mockImplementation(() => Array.from({ length: generation }, (_, index) => ({
      ...current(), incarnationId: `inc-${index + 1}`, containerId: String(index + 1).repeat(64), providerVolumeName: 'owned-native-volume',
      imageRef: rig.runtime.imageRef, workspacePath: rig.repoRoot, runtimeDir: directory, createdAt: new Date().toISOString(), requestDigest: 'd'.repeat(64),
    })))
    const launchProcess = () => ({ provider: 'claude', version: '2.1.237', native: { pid: 42, parentPid: 41, startTicks: `100${generation}`, uid: 65534,
      executable: '/owned/claude', executableSha256: 'd'.repeat(64), profileSha256: 'e'.repeat(64), cwd: fixtureRepoRoot,
      configuredModel: 'haiku', configuredEffort: 'low', launch: { incarnationId: `inc-${generation}`, launchNonce: `launch-${generation}`,
        executionGeneration: generation, evidenceRevision: generation } }, sdk: { version: '0.3.237', declaredNativeVersion: '2.1.237', selection: 'sidecar-selected-module-resolution',
        packageBytesBase64: sdkPackage.toString('base64'), moduleBytesBase64: sdkModule.toString('base64'), entryBytesBase64: sidecarEntry.toString('base64'),
        moduleSha256: createHash('sha256').update(sdkModule).digest('hex'), entrySha256: createHash('sha256').update(sidecarEntry).digest('hex') } })
    vi.spyOn(rig, 'ownedProviderExec').mockImplementation(async (_container, args) => {
      if (args.includes(owner.FRESH_AGENT_PROCESS_SCRIPT)) return JSON.stringify(launchProcess())
      if (args[0] === 'node') {
        const { captureNativeHistory } = await import('../../../e2e-browser/helpers/provider-native-history/probe-cli.js')
        return JSON.stringify(captureNativeHistory('claude', projects, nativeRoot, args.at(-1) === 'boundary'))
      }
      return JSON.stringify({ uid: 65534, gid: 0, caps: '0000000000000000', readOnlyRoot: true, nativePid: 42, nativeRoot,
        nativeCwd: fixtureRepoRoot, executableSha256: 'd'.repeat(64), profileSha256: 'e'.repeat(64), nativeLaunch: launchProcess().native.launch,
        tlsVerifyMode: 2, tlsCheckHostname: true, httpsStatus: 200 })
    })
    vi.spyOn(rig as any, 'ownedDockerProbe').mockImplementation(async () => JSON.stringify({ source: 'registry-current-incarnation', soulId: handle.soulId,
      incarnationId: `inc-${generation}`, containerId: String(generation).repeat(64), hostBootId: `boot-${generation}`, launchNonce: `launch-${generation}`,
      executionGeneration: generation, providerStoreId: 'owned-native-store', nativeSessionId: nativeRoot,
      spec: { sessionType: 'freshclaude', provider: 'claude', runtimeVariant: 'claude-agent-sdk', providerStoreId: 'owned-native-store',
        nativeSessionId: nativeRoot, cwd: fixtureRepoRoot, model: 'haiku', effort: 'low' } }))
    vi.spyOn(rig, 'writerClaimFacts').mockImplementation(async () => ({ provider: 'claude', providerStoreId: 'owned-native-store', nativeSessionId: nativeRoot,
      soulId: handle.soulId, incarnationId: `inc-${generation}`, activeClaimCount: stopped ? 0 : 1, globalConflictingClaimCount: 0 }))
    const completions: Promise<void>[] = []
    vi.spyOn(rig.runtime, 'adminRaw').mockImplementation(async (_supervisor, body, options) => {
      expect(body.method).toBe('fresh_agent_send')
      sent += 1
      const text = sent === 1 ? 'stored' : nonce
      const turn = sent
      await fsp.appendFile(nativeFile, JSON.stringify({ type: 'user', uuid: `user-${turn}`, sessionId: nativeRoot, message: { role: 'user', content: body.params.text } }) + '\n')
      completions.push(new Promise<void>(resolve => setTimeout(resolve, 25)).then(async () => {
        await fsp.appendFile(nativeFile, JSON.stringify({ type: 'assistant', uuid: `assistant-${turn}`, parentUuid: `user-${turn}`, sessionId: nativeRoot, timestamp: new Date().toISOString(),
          message: { id: `turn-${turn}`, role: 'assistant', model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', content: [{ type: 'text', text }] } }) + '\n')
      }))
      return { requestId: options?.requestId, result: { Ok: { data: {} } } } as any
    })
    let previousExited = false
    vi.spyOn(rig.runtime, 'killOwnedRuntimeExact').mockImplementation(() => { previousExited = true })
    vi.spyOn(rig, 'ownedContainerState').mockImplementation(async () => ({ present: true, running: !stopped && !previousExited }))
    vi.spyOn(rig.runtime, 'killOwnedRuntimePidExact').mockImplementation(() => { previousExited = true })
    vi.spyOn(rig, 'ownedRuntimeHostState').mockImplementation(async () => ({ running: !previousExited, pid: 1 }) as any)
    vi.spyOn(rig.runtime, 'recordLifecycle').mockImplementation(() => undefined)
    vi.spyOn(rig, 'stopSoul').mockImplementation(async () => { stopped = true; return { outcome: 'verified_empty', view: current() } })
    Object.assign(rig, { readStoppedNativeHistory: async () => {
      expect(stopped).toBe(true)
      const { captureNativeHistory } = await import('../../../e2e-browser/helpers/provider-native-history/probe-cli.js')
      return captureNativeHistory('claude', projects, nativeRoot)
    } })
    vi.spyOn(rig.runtime, 'cleanup').mockImplementation(async () => { await fsp.rm(projects, { recursive: true }); return { ok: true, errors: [] } })
    try {
      const registered = await rig.registerFreshNativeCollection({ ...rig.runtimeEnclosureHandle(current()), nativeSessionId: nativeRoot }, nonce)
      for (let index = 0; index < 3; index++) {
        const exact = { ...rig.runtimeEnclosureHandle(current()), nativeSessionId: nativeRoot }
        await expect(rig.captureFreshNativeStage(exact, registered.collectionId)).resolves.toMatchObject({ completedStages: index + 1, closed: false })
        if (index === 0) await rig.crashRuntimeHost(Object.fromEntries(Object.entries(exact).reverse()) as typeof exact)
        if (index === 1) await rig.crashProviderWorker(exact)
        if (index < 2) { generation++; previousExited = false }
      }
      await expect(rig.finishFreshNativeCollection({ ...rig.runtimeEnclosureHandle(current()), nativeSessionId: nativeRoot }, registered.collectionId)).resolves.toMatchObject({ completedStages: 3, closed: true,
        providerStoreId: 'owned-native-store', completedNativeTurns: [1, 2, 3].map(index => ({ turnId: `turn-${index}`, assistantMessageId: `assistant-${index}`, completionKind: 'provider_native_completed' })) })
      const manifest = JSON.parse(await fsp.readFile(path.join(rig.runtime.evidenceDir, 'native-recovery-originals.json'), 'utf8'))
      const stoppedRead = JSON.parse(await fsp.readFile(path.join(rig.runtime.evidenceDir, manifest.conversations[0].stopped.path), 'utf8'))
      expect(stoppedRead).toMatchObject({ stopResult: { outcome: 'verified_empty', view: { soulId: handle.soulId, incarnationId: 'inc-3', launchState: 'stopped' } },
        stoppedView: { soulId: handle.soulId, incarnationId: 'inc-3', containerId: '3'.repeat(64), hostBootId: 'boot-3', nativeSessionId: nativeRoot, desiredState: 'stopped', cleanupState: 'verified_empty' },
        writer: { providerStoreId: 'owned-native-store', incarnationId: 'inc-3', activeClaimCount: 0, globalConflictingClaimCount: 0 } })
      const readOrder = ['stopCompletedAt', 'stoppedObservedAt', 'writerObservedAt', 'readStartedAt', 'readCompletedAt'].map(field => stoppedRead[field])
      expect(readOrder.every((at, index) => Number.isSafeInteger(at) && at > 0 && (index === 0 || at >= readOrder[index - 1]))).toBe(true)
      await rig.stop()
      expect(fs.existsSync(projects)).toBe(false)
      const { deriveNativeRecoveryOriginals } = await import('../../../../scripts/testing/qualification-observations.js')
      const observed = deriveNativeRecoveryOriginals({ evidenceDir: rig.runtime.evidenceDir, candidateSha: rig.runtime.candidateSha,
        runId: rig.runtime.runId, runtimeImage: rig.runtime.imageRef, selected: ['freshclaude'] })
      expect(observed[0]!.stages.map(stage => [stage.recalledNonce, stage.profile.effort])).toEqual([[false, null], [true, null], [true, null]])
      expect(sent).toBe(3)
      await expect(rig.captureFreshNativeStage({ ...rig.runtimeEnclosureHandle(current()), nativeSessionId: nativeRoot }, registered.collectionId)).rejects.toThrow(/finished|closed/)
    } finally { await Promise.all(completions); await fsp.rm(directory, { recursive: true, force: true }) }
  })
})
