import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RuntimeHarness } from './runtime-sandbox.js'

export const NATIVE_TRANSFER_CASES = [
  'native-transfer-boundaries', 'semantic-schema', 'attachment-authority', 'saved-revert-cleanup',
] as const
export type NativeTransferCase = typeof NATIVE_TRANSFER_CASES[number]
export type NativeCaseOriginal = {
  caseId: NativeTransferCase
  assertions: { name: string; pass: boolean }[]
  nativeDecodedRootCount: number
  nativeVersion: string
  artifactReferences: string[]
}
export type NativeMatrixReceipt = {
  kind: 'pinned-native-transfer-matrix'
  candidateSha: string
  imageDigest: string
  adapterSha256: string
  selectedCount: number
  executedCount: number
  passedCount: number
  failedCount: number
  skippedCount: number
  cleanupCount: number
  cleanupStatus: 'complete'
  cases: NativeCaseOriginal[]
}

// Kept self-contained because the owned provider child embeds this function.
export function expectedExportRefusal(label: string, result: { status: number | null; signal?: string | null; error?: unknown },
  diagnostic: unknown, receiptProduced: boolean): boolean {
  const changedTable = /source schema relationships differ for pinned table message_seq/
  const reasons: Record<string, RegExp> = {
    'changed-type': changedTable,
    'changed-key': changedTable,
    'changed-nullability': changedTable,
    'changed-foreign-key': changedTable,
    'changed-index': /source schema object inventory differs from pinned OpenCode/,
    'changed-trigger': /source schema object inventory differs from pinned OpenCode/,
    'changed-migration': /source migration journal does not match OpenCode v1\.18\.21/,
    'missing-native-attachment-url': /native file part has no recognized URL/,
    'changed-source-reference': /workspace file reference is unavailable/,
    'missing-snapshot-descendant': /retained snapshot has an incomplete tree closure/,
  }
  const cause = diagnostic as { event?: unknown; detail?: unknown } | null
  return result.status === 1 && !result.signal && !result.error && !receiptProduced
    && cause?.event === 'opencode.rehearsal.stage_refused' && typeof cause.detail === 'string'
    && !!reasons[label]?.test(cause.detail)
}

/** Shared finite dispatcher. Fixture children test plumbing, never qualify native. */
export async function dispatchNativeCases(input: {
  imageDigest: string
  cases: readonly NativeTransferCase[]
  execute: (caseId: NativeTransferCase) => Promise<NativeCaseOriginal>
  cleanup: () => Promise<void>
}): Promise<NativeCaseOriginal[]> {
  if (!/^sha256:[a-f0-9]{64}$/.test(input.imageDigest)
      || input.cases.length !== NATIVE_TRANSFER_CASES.length
      || new Set(input.cases).size !== NATIVE_TRANSFER_CASES.length
      || input.cases.some((item) => !NATIVE_TRANSFER_CASES.includes(item))) {
    throw new Error('exact immutable image and all four finite cases required')
  }
  const originals: NativeCaseOriginal[] = []
  const failures: NativeTransferCase[] = []
  try {
    for (const caseId of input.cases) {
      try {
        const original = await input.execute(caseId)
        originals.push(original)
        if (original.caseId !== caseId || original.nativeVersion !== '1.18.21'
            || original.nativeDecodedRootCount < 1 || original.assertions.length < 1
            || original.assertions.some((assertion) => !assertion.pass)
            || original.artifactReferences.length < 1) failures.push(caseId)
      } catch {
        failures.push(caseId)
      }
    }
  } finally {
    await input.cleanup()
  }
  if (failures.length || originals.length !== input.cases.length) {
    throw new Error(`native transfer groups failed: ${failures.join(',')}`)
  }
  return originals
}

// This fixed child runs only in a fresh, owned offline provider container. All
// transcript bytes and native output stay in its private volume. Its ordinary
// synthetic noReply prompt is prohibited in the real-root rehearsal driver.
const NATIVE_CHILD = `const expectedExportRefusal = ${expectedExportRefusal.toString()};\n` + String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const [caseId, candidateSha, imageDigest] = process.argv.slice(1);
const base='/scratch', workspace=base+'/workspace', home=base+'/provider';
const source=base+'/source.db', destination=home+'/.local/share/opencode/opencode.db';
const assertions=[], artifactReferences=[]; let nativeDecodedRootCount=0; let nativeVersion='';
const sha=(bytes)=>crypto.createHash('sha256').update(bytes).digest('hex');
const assert=(name,pass)=>{assertions.push({name,pass:!!pass}); if(!pass) throw new Error(name);};
const write=(file,value)=>{fs.writeFileSync(file,JSON.stringify(value),{mode:0o600,flag:'wx'}); artifactReferences.push(file);};
const command=(program,args)=>cp.execFileSync(program,args,{encoding:'utf8',timeout:45000,maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']});
const id=(prefix,index)=>prefix+'_'+'a'.repeat(16)+String(index).padStart(10,'0');
const roots=[id('ses',0),id('ses',1),id('ses',2)];
const tokens={total:0,input:0,output:0,reasoning:0,cache:{read:0,write:0}};
let server;
async function request(method,route,body){
 const response=await fetch('http://127.0.0.1:4199'+route,{method,headers:{'content-type':'application/json','x-opencode-directory':workspace},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 const text=await response.text();
 assert('native-http-'+method+'-'+route+'-'+response.status,response.ok);
 return JSON.parse(text);
}
function stage(name,currentProjection=false){
 const requestFile=base+'/'+name+(currentProjection?'-current':'')+'-request.json';
 const receiptFile=base+'/'+name+(currentProjection?'-current':'')+'-receipt.json';
 write(requestFile,{candidateSha,imageDigest,sourceDatabase:source,rootSessionId:roots[0],extractionRoot:base+'/extractions',workspacePath:workspace,descriptorFile:base+'/descriptor.json',payloadFile:base+'/payload.json',destinationStoreId:'fixture-native-owner',destinationDatabase:destination,providerHome:home,providerUid:65534,providerGid:0,receiptFile,currentProjection});
 let reply;
 try { reply=JSON.parse(command('/opt/transfer-stage',['--stage',name,'--request-file',requestFile])); }
 catch(error){ assertions.push({name:'production-'+name+(currentProjection?'-current':''),pass:false}); throw error; }
 assert('production-'+name+(currentProjection?'-current':''),reply.status==='complete'&&reply.candidateSha===candidateSha&&reply.imageDigest===imageDigest);
 artifactReferences.push(receiptFile); return reply.evidence;
}
function mutateSource(sql){const db=new DatabaseSync(source);try{db.exec(sql);}finally{db.close();}}
function deniedExport(label,mutation){
 const before=fs.readFileSync(source); mutation();
 const modified=fs.readFileSync(source); const file=base+'/deny-'+label+'-request.json';
 write(file,{candidateSha,imageDigest,sourceDatabase:source,rootSessionId:roots[0],extractionRoot:base+'/deny-'+label,workspacePath:workspace,descriptorFile:base+'/deny-'+label+'-descriptor.json',payloadFile:base+'/deny-'+label+'-payload.json',destinationStoreId:'fixture-native-owner',destinationDatabase:destination,providerHome:home,providerUid:65534,providerGid:0,receiptFile:base+'/deny-'+label+'-receipt.json'});
 const result=cp.spawnSync('/opt/transfer-stage',['--stage','export','--request-file',file],{encoding:'utf8',timeout:45000,maxBuffer:1024*1024});
 const diagnosticFile=base+'/deny-'+label+'-request-error.json';
 const diagnostic=fs.existsSync(diagnosticFile)?JSON.parse(fs.readFileSync(diagnosticFile,'utf8')):null;
 assert('export-refuses-'+label,expectedExportRefusal(label,result,diagnostic,fs.existsSync(base+'/deny-'+label+'-receipt.json')));
 assert('source-unchanged-by-refused-'+label,sha(fs.readFileSync(source))===sha(modified));
 fs.writeFileSync(source,before,{mode:0o600});
}
async function run(){
 assert('effective-provider-identity',process.getuid()===65534&&process.getgid()===0);
 const status=fs.readFileSync('/proc/self/status','utf8');
 assert('zero-capability-provider',/^CapEff:\s+0+$/m.test(status)&&/^NoNewPrivs:\s+1$/m.test(status));
 for(const directory of [workspace,home+'/.local/share/opencode',home+'/.config',home+'/.cache'])fs.mkdirSync(directory,{recursive:true,mode:0o700});
 nativeVersion=command('opencode',['--version']).trim(); assert('pinned-native-version',nativeVersion==='1.18.21');
 command('git',['init','-q',workspace]);
 fs.writeFileSync(workspace+'/asset.txt','synthetic immutable fixture asset',{mode:0o600});
 command('git',['-C',workspace,'add','asset.txt']);
 command('git',['-C',workspace,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
 const projectId=command('git',['-C',workspace,'rev-parse','HEAD']).trim();
 if(caseId==='saved-revert-cleanup'){command('git',['-C',workspace,'gc','--prune=now']);assert('packed-native-source-store',fs.readdirSync(workspace+'/.git/objects/pack').some(file=>file.endsWith('.pack')));}
 let nativePartTree, nativePartBlob, nativePartBucket;
 if(caseId==='saved-revert-cleanup'){
  nativePartBucket=base+'/snapshot/'+projectId+'/'+crypto.createHash('sha1').update(workspace).digest('hex');
  command('git',['init','--bare','-q',nativePartBucket]);
  nativePartBlob=cp.execFileSync('git',['--git-dir',nativePartBucket,'hash-object','-w','--stdin'],{input:'synthetic bucket-only snapshot',encoding:'utf8',timeout:45000}).trim();
  nativePartTree=cp.execFileSync('git',['--git-dir',nativePartBucket,'mktree'],{input:'100644 blob '+nativePartBlob+'\tbucket-only.txt\n',encoding:'utf8',timeout:45000}).trim();
  assert('ordinary-git-workspace-with-bucket-only-tree',fs.statSync(workspace+'/.git').isDirectory()&&cp.spawnSync('git',['-C',workspace,'cat-file','-e',nativePartTree],{timeout:45000}).status!==0);
 }
 const db=new DatabaseSync(source);
 db.exec(fs.readFileSync('/opt/transfer-schema.sql','utf8'));
 const migrations=JSON.parse(fs.readFileSync('/opt/transfer-migrations.json','utf8'));
 for(const migration of migrations)db.prepare('INSERT INTO migration (id,time_completed) VALUES (?,0)').run(migration);
 assert('exact-38-migrations',migrations.length===38);
 if(caseId==='semantic-schema')db.exec('CREATE TABLE message_seq (\n session_id text PRIMARY KEY,\n next integer NOT NULL\n );');
 db.prepare('INSERT INTO project (id,worktree,vcs,time_created,time_updated,sandboxes) VALUES (?,?,?,1,1,?)').run(projectId,workspace,'git','[]');
 db.prepare('INSERT INTO project_directory (project_id,directory,time_created) VALUES (?,?,1)').run(projectId,workspace);
 const now=Date.now()-60000;
 for(let rootIndex=0;rootIndex<roots.length;rootIndex++){
  const root=roots[rootIndex];
  db.prepare('INSERT INTO session (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES (?,?,?,?,?,?,?, ?,?)').run(root,projectId,rootIndex?roots[rootIndex-1]:null,root,workspace,'Synthetic native transfer','1.18.21',now,now);
  const count=rootIndex?1:4;
  for(let index=0;index<count;index++){
   const n=rootIndex*10+index, messageId=id('msg',n), assistant=rootIndex===0&&index%2===1;
   const info=assistant?{role:'assistant',parentID:id('msg',n-1),providerID:'openai',modelID:'gpt-5.6-luna',mode:'build',agent:'build',path:{cwd:workspace,root:workspace},cost:0,tokens,finish:'stop',time:{created:now+index,completed:now+index}}:{role:'user',agent:'build',model:{providerID:'openai',modelID:'gpt-5.6-luna'},time:{created:now+index}};
   db.prepare('INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)').run(messageId,root,now+index,now+index,JSON.stringify(info));
   const part={type:'text',text:'synthetic message '+n};
   db.prepare('INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)').run(id('prt',n),messageId,root,now+index,now+index,JSON.stringify(part));
  }
  db.prepare('INSERT INTO event_sequence (aggregate_id,seq,owner_id) VALUES (?,1,?)').run(root,'fixture-owner');
  const info={id:root,slug:root,projectID:projectId,directory:workspace,title:'Synthetic native transfer',version:'1.18.21',time:{created:now,updated:now},...(rootIndex?{parentID:roots[rootIndex-1]}:{})};
  db.prepare('INSERT INTO event (id,aggregate_id,seq,type,data) VALUES (?,?,1,?,?)').run(id('evt',rootIndex),root,'session.created.1',JSON.stringify({sessionID:root,info}));
 }
 if(caseId==='attachment-authority'){
  const sourceAttribution={type:'file',path:workspace+'/asset.txt',text:{value:'asset',start:0,end:5}};
  const file={type:'file',mime:'text/plain',filename:'asset.txt',url:'data:text/plain;base64,'+Buffer.from('synthetic immutable fixture asset').toString('base64'),source:sourceAttribution};
  const tool={type:'tool',callID:'call-fixture',tool:'read',state:{status:'completed',input:{},output:'synthetic output',title:'Synthetic',metadata:{arbitrary:{type:'file',noUrl:true}},time:{start:now,end:now},attachments:[{...file,id:id('prt',52),sessionID:roots[0],messageID:id('msg',1)}]}};
  for(const [index,data]of [[50,file],[51,tool]])db.prepare('INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)').run(id('prt',index),id('msg',1),roots[0],now,now,JSON.stringify(data));
 }
 if(caseId==='saved-revert-cleanup'){
  const tree=command('git',['-C',workspace,'rev-parse','HEAD^{tree}']).trim();
  db.prepare('INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)').run(id('prt',71),id('msg',1),roots[0],now,now,JSON.stringify({type:'step-start',snapshot:nativePartTree}));
  db.prepare('UPDATE session SET revert=? WHERE id=?').run(JSON.stringify({messageID:id('msg',2),snapshot:tree}),roots[0]);
  db.prepare('UPDATE session SET revert=? WHERE id=?').run(JSON.stringify({messageID:id('msg',10),snapshot:'1234567890abcdef1234567890abcdef12345678'}),roots[1]);
  db.prepare('INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)').run(id('prt',70),id('msg',20),roots[2],now,now,JSON.stringify({type:'text',text:'synthetic part boundary'}));
  db.prepare('UPDATE session SET revert=? WHERE id=?').run(JSON.stringify({messageID:id('msg',20),partID:id('prt',70),snapshot:tree}),roots[2]);
 }
 db.close();
 const originalSourceHash=sha(fs.readFileSync(source));
 const exported=stage('export'); const imported=stage('import'); const readable=stage('read');
 assert('complete-production-row-asset-agreement',exported.rowCount===imported.rowCount&&imported.rowCount===readable.rowCount&&exported.assetCount===readable.assetCount&&imported.structuralSha256===readable.structuralSha256);
 assert('source-logical-bytes-preserved',sha(fs.readFileSync(source))===originalSourceHash);
 if(caseId==='native-transfer-boundaries'){
  const sourceDb=new DatabaseSync(source), installedDb=new DatabaseSync(destination);
  for(const table of ['project','project_directory','session','message','part','event_sequence','event','session_message','session_input','session_context_epoch','todo']){
   const sourceRows=sourceDb.prepare('SELECT * FROM "'+table+'" ORDER BY rowid').all();const installedRows=installedDb.prepare('SELECT * FROM "'+table+'" ORDER BY rowid').all();
   assert('complete-native-table-'+table,JSON.stringify(sourceRows)===JSON.stringify(installedRows));
  }sourceDb.close();installedDb.close();
 }
 const baselineDescriptor=sha(fs.readFileSync(base+'/descriptor.json')), baselinePayload=sha(fs.readFileSync(base+'/payload.json'));
 const log=fs.openSync(base+'/native-private.log','wx',0o600);
 server=cp.spawn('opencode',['serve','--hostname','127.0.0.1','--port','4199'],{cwd:workspace,stdio:['ignore',log,log]});
 fs.closeSync(log); artifactReferences.push(base+'/native-private.log');
 for(let attempt=0;attempt<200;attempt++){
  try{const response=await fetch('http://127.0.0.1:4199/global/health',{signal:AbortSignal.timeout(500)});if(response.ok)break;}catch{}
  if(server.exitCode!==null)throw new Error('native consumer exited');
  await new Promise(resolve=>setTimeout(resolve,100));
  if(attempt===199)throw new Error('native consumer startup timeout');
 }
 for(const root of roots){
  const info=await request('GET','/session/'+root); const messages=await request('GET','/session/'+root+'/message');
  assert('typed-native-root-'+root,info.id===root&&Array.isArray(messages)&&messages.length>0);
  write(base+'/native-'+root+'-read.json',{info,messages});
  const nativeExport=JSON.parse(command('opencode',['export',root]));
  assert('native-export-'+root,nativeExport.info.id===root&&nativeExport.messages.length===messages.length);
  write(base+'/native-'+root+'-export.json',nativeExport);nativeDecodedRootCount++;
 }
 if(caseId==='semantic-schema'){
  deniedExport('changed-type',()=>mutateSource('DROP TABLE message_seq; CREATE TABLE message_seq (session_id TEXT PRIMARY KEY,next TEXT NOT NULL);'));
  deniedExport('changed-key',()=>mutateSource('DROP TABLE message_seq; CREATE TABLE message_seq (session_id TEXT,next INTEGER NOT NULL);'));
  deniedExport('changed-nullability',()=>mutateSource('DROP TABLE message_seq; CREATE TABLE message_seq (session_id TEXT PRIMARY KEY,next INTEGER);'));
  deniedExport('changed-foreign-key',()=>mutateSource('DROP TABLE message_seq; CREATE TABLE message_seq (session_id TEXT PRIMARY KEY REFERENCES session(id),next INTEGER NOT NULL);'));
  deniedExport('changed-index',()=>mutateSource('CREATE INDEX unqualified_index ON message(session_id);'));
  deniedExport('changed-trigger',()=>mutateSource('CREATE TRIGGER unqualified_trigger AFTER INSERT ON message BEGIN SELECT 1; END;'));
  deniedExport('changed-migration',()=>mutateSource("DELETE FROM migration WHERE id=(SELECT id FROM migration LIMIT 1);"));
 }
 if(caseId==='attachment-authority'){
  const messages=await request('GET','/session/'+roots[0]+'/message');
  const parts=messages.flatMap(message=>message.parts);
  const tool=parts.find(part=>part.type==='tool'); const file=parts.find(part=>part.type==='file');
  assert('arbitrary-tool-metadata-preserved',tool.state.metadata.arbitrary.type==='file'&&tool.state.metadata.arbitrary.noUrl===true);
  assert('file-source-attribution-preserved',file.source.type==='file'&&file.source.path===workspace+'/asset.txt');
  assert('native-tool-attachment-authority-preserved',tool.state.attachments.length===1&&tool.state.attachments[0].url===file.url);
  deniedExport('missing-native-attachment-url',()=>{const database=new DatabaseSync(source);const row=database.prepare('SELECT data FROM part WHERE id=?').get(id('prt',50));const data=JSON.parse(row.data);delete data.url;database.prepare('UPDATE part SET data=? WHERE id=?').run(JSON.stringify(data),id('prt',50));database.close();});
 }
 if(caseId==='native-transfer-boundaries'){
  const refusedStage=(label,name,overrides={})=>{
   const requestFile=base+'/'+label+'-request.json',receiptFile=base+'/'+label+'-receipt.json';
   write(requestFile,{candidateSha,imageDigest,sourceDatabase:source,rootSessionId:roots[0],extractionRoot:base+'/extractions',workspacePath:workspace,descriptorFile:base+'/descriptor.json',payloadFile:base+'/payload.json',destinationStoreId:'fixture-native-owner',destinationDatabase:home+'/.local/share/opencode/'+label+'.db',providerHome:home,providerUid:65534,providerGid:0,receiptFile,...overrides});
   const result=cp.spawnSync('/opt/transfer-stage',['--stage',name,'--request-file',requestFile],{encoding:'utf8',timeout:45000,maxBuffer:1024*1024});
   assert(label+'-refused',result.status!==0&&!fs.existsSync(receiptFile));
   const diagnostic=JSON.parse(fs.readFileSync(base+'/'+label+'-request-error.json','utf8'));
   const reasons={'destination-capacity':/insufficient free space/,'conflicting-destination':/conflicting native primary key/,'mismatched-root':/transfer descriptor is invalid/,'unreadable-provider-context':/provider identity/,'mismatched-payload-digest':/digest|manifest/};
   assert(label+'-actual-refusal-reason',reasons[label].test(diagnostic.detail));
  };
  deniedExport('changed-source-reference',()=>{const database=new DatabaseSync(source);database.prepare('UPDATE part SET data=? WHERE id=?').run(JSON.stringify({type:'file',mime:'text/plain',filename:'missing-fixture.txt',url:'file://'+workspace+'/missing-fixture.txt'}),id('prt',0));database.close();});
  refusedStage('destination-capacity','import',{importCapacityCeilingBytes:0});
  assert('capacity-refusal-before-destination-write',!fs.existsSync(home+'/.local/share/opencode/destination-capacity.db'));
  const conflicting=home+'/.local/share/opencode/conflicting.db';fs.copyFileSync(source,conflicting);
  const conflictDatabase=new DatabaseSync(conflicting);const conflictText=JSON.stringify({role:'user',opaque:'synthetic conflicting destination'});
  conflictDatabase.prepare('UPDATE message SET data=? WHERE id=?').run(conflictText,id('msg',0));conflictDatabase.close();
  refusedStage('conflicting-destination','import',{destinationDatabase:conflicting});
  const preservedConflict=new DatabaseSync(conflicting);assert('destination-conflict-not-overwritten',preservedConflict.prepare('SELECT data FROM message WHERE id=?').get(id('msg',0)).data===conflictText);preservedConflict.close();
  const originalDescriptor=fs.readFileSync(base+'/descriptor.json'),changedDescriptor=JSON.parse(originalDescriptor);changedDescriptor.rootSessionId=roots[1];
  const changedDescriptorFile=base+'/wrong-root-descriptor.json';write(changedDescriptorFile,changedDescriptor);
  refusedStage('mismatched-root','import',{descriptorFile:changedDescriptorFile,rootSessionId:roots[1]});
  refusedStage('unreadable-provider-context','read',{destinationDatabase:destination,providerUid:0});
  const originalPayload=fs.readFileSync(base+'/payload.json');
  const mutatedPayload=JSON.parse(originalPayload);const changedRow=mutatedPayload.rows.find(row=>row.table==='part');const changedPart=JSON.parse(changedRow.values.data.value);changedPart.text='synthetic mismatched digest';changedRow.values.data.value=JSON.stringify(changedPart);fs.writeFileSync(base+'/payload.json',JSON.stringify(mutatedPayload));
  refusedStage('mismatched-payload-digest','import');fs.writeFileSync(base+'/payload.json',originalPayload);
  const payload=fs.readFileSync(base+'/payload.json');fs.writeFileSync(base+'/payload.json',payload.subarray(0,payload.length-1));
  const requestFile=base+'/truncate-request.json';
  write(requestFile,{candidateSha,imageDigest,sourceDatabase:source,rootSessionId:roots[0],extractionRoot:base+'/extractions',workspacePath:workspace,descriptorFile:base+'/descriptor.json',payloadFile:base+'/payload.json',destinationStoreId:'fixture-native-owner',destinationDatabase:home+'/.local/share/opencode/truncate.db',providerHome:home,providerUid:65534,providerGid:0,receiptFile:base+'/truncate-receipt.json'});
  const result=cp.spawnSync('/opt/transfer-stage',['--stage','import','--request-file',requestFile],{encoding:'utf8',timeout:45000,maxBuffer:1024*1024});
  assert('truncated-payload-refused',result.status!==0&&!fs.existsSync(base+'/truncate-receipt.json'));fs.writeFileSync(base+'/payload.json',payload);
 }
 if(caseId==='saved-revert-cleanup'){
  const bucketOnlyMessages=await request('GET','/session/'+roots[0]+'/message');
  assert('native-bucket-only-snapshot-part-preserved',bucketOnlyMessages.flatMap(message=>message.parts).some(part=>part.type==='step-start'&&part.snapshot===nativePartTree));
  const nativePartDestination=home+'/.local/share/opencode/snapshot/'+projectId+'/'+crypto.createHash('sha1').update(workspace).digest('hex');
  assert('bucket-only-tree-installed-native-readable',command('git',['--git-dir',nativePartDestination,'cat-file','-p',nativePartTree]).includes(nativePartBlob));
  const blobPath=nativePartBucket+'/objects/'+nativePartBlob.slice(0,2)+'/'+nativePartBlob.slice(2), blobBytes=fs.readFileSync(blobPath);
  deniedExport('missing-snapshot-descendant',()=>fs.unlinkSync(blobPath));fs.writeFileSync(blobPath,blobBytes);
  const installedBlob=nativePartDestination+'/objects/'+nativePartBlob.slice(0,2)+'/'+nativePartBlob.slice(2), installedBytes=fs.readFileSync(installedBlob);
  fs.writeFileSync(installedBlob,'synthetic conflicting object');
  const conflictRequest=base+'/snapshot-conflict-request.json',conflictReceipt=base+'/snapshot-conflict-receipt.json';
  write(conflictRequest,{candidateSha,imageDigest,sourceDatabase:source,rootSessionId:roots[0],extractionRoot:base+'/extractions',workspacePath:workspace,descriptorFile:base+'/descriptor.json',payloadFile:base+'/payload.json',destinationStoreId:'fixture-native-owner',destinationDatabase:destination,providerHome:home,providerUid:65534,providerGid:0,receiptFile:conflictReceipt});
  const conflictRead=cp.spawnSync('/opt/transfer-stage',['--stage','read','--request-file',conflictRequest],{timeout:45000});
  assert('conflicting-installed-snapshot-refused',conflictRead.status!==0&&!fs.existsSync(conflictReceipt));
  assert('conflicting-installed-snapshot-not-overwritten',fs.readFileSync(installedBlob,'utf8')==='synthetic conflicting object');fs.writeFileSync(installedBlob,installedBytes);
  const before=await request('GET','/session/'+roots[0]);assert('saved-reference-loaded',typeof before.revert.snapshot==='string'&&before.revert.messageID===id('msg',2));
  const unavailable=await request('GET','/session/'+roots[1]);
  assert('unavailable-saved-reference-preserved',unavailable.revert.snapshot==='1234567890abcdef1234567890abcdef12345678');
  fs.writeFileSync(workspace+'/asset.txt','synthetic changed workspace');
  await request('POST','/session/'+roots[0]+'/unrevert',{});
  assert('actual-saved-tree-restored',fs.readFileSync(workspace+'/asset.txt','utf8')==='synthetic immutable fixture asset');
  const bucket=home+'/.local/share/opencode/snapshot/'+projectId+'/'+crypto.createHash('sha1').update(workspace).digest('hex');
  assert('saved-tree-readable-in-native-bucket',command('git',['--git-dir',bucket,'cat-file','-t',before.revert.snapshot]).trim()==='tree');
  const full=await request('POST','/session/'+roots[0]+'/revert',{messageID:id('msg',2)});
  assert('native-full-boundary',full.revert.messageID===id('msg',2));
  await request('POST','/session/'+roots[0]+'/message',{noReply:true,model:{providerID:'openai',modelID:'gpt-5.6-luna'},variant:'fixture',parts:[{type:'text',text:'synthetic cleanup continuation'}]});
  const after=await request('GET','/session/'+roots[0]);const messages=await request('GET','/session/'+roots[0]+'/message');
  assert('native-full-revert-cleanup',!after.revert&&!messages.some(message=>message.info.id===id('msg',2)||message.info.id===id('msg',3)));
  for(const [root,boundary,part]of [[roots[1],id('msg',10),false],[roots[2],id('prt',70),true]]){
   await request('POST','/session/'+root+'/message',{noReply:true,model:{providerID:'openai',modelID:'gpt-5.6-luna'},variant:'fixture',parts:[{type:'text',text:'synthetic bounded cleanup'}]});
   const info=await request('GET','/session/'+root),remaining=await request('GET','/session/'+root+'/message');
   assert(part?'native-part-revert-cleanup':'unavailable-saved-tree-native-cleanup',!info.revert&&(part?!remaining.flatMap(message=>message.parts).some(item=>item.id===boundary):!remaining.some(message=>message.info.id===boundary)));
   if(part)assert('part-cleanup-prefix-preserved',remaining.flatMap(message=>message.parts).some(item=>item.id===id('prt',20)));
  }
  assert('immutable-baseline-retained',sha(fs.readFileSync(base+'/descriptor.json'))===baselineDescriptor&&sha(fs.readFileSync(base+'/payload.json'))===baselinePayload);
  stage('read',true);
 }
 assert('completed-positive-native-group',nativeDecodedRootCount===3&&assertions.length>0);
}
run().catch(error=>{fs.writeFileSync('/scratch/private-failure.json',JSON.stringify({message:String(error),stack:error.stack}),{mode:0o600});if(!assertions.some(item=>!item.pass))assertions.push({name:'native-case-operation',pass:false});}).finally(()=>{
 if(server&&server.exitCode===null)server.kill('SIGTERM');
 const original={caseId,assertions,nativeDecodedRootCount,nativeVersion,artifactReferences};
 fs.writeFileSync('/scratch/case-original.json',JSON.stringify(original),{mode:0o600});
 process.stdout.write(JSON.stringify(original));
});
`

export async function runNativeTransferCheck(imageDigest: string): Promise<NativeMatrixReceipt> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const harness = new RuntimeHarness(repoRoot, randomUUID(), 2)
  await harness.prepareTransfer(imageDigest)
  const builtStageBinary = path.join(repoRoot, 'target/release/examples/opencode_restoration_rehearsal')
  const stageBinary = path.join(harness.testRoot, 'transfer-stage')
  fs.copyFileSync(builtStageBinary, stageBinary)
  fs.chmodSync(stageBinary, 0o755)
  const schemaFile = path.join(repoRoot, 'crates/freshell-sessions/src/opencode_schema_v1_18_21.sql')
  const transferSource = fs.readFileSync(path.join(repoRoot, 'crates/freshell-sessions/src/opencode_transfer.rs'), 'utf8')
  const registry = transferSource.match(/const PINNED_MIGRATIONS: &\[&str\] = &\[([\s\S]*?)\];/)
  if (!registry) throw new Error('pinned native migration registry missing')
  const migrations = [...registry[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1])
  const migrationsFile = path.join(harness.testRoot, 'migrations.json')
  fs.writeFileSync(migrationsFile, JSON.stringify(migrations), { mode: 0o644, flag: 'wx' })
  fs.chmodSync(migrationsFile, 0o644)
  const adapterSha256 = createHash('sha256').update(fs.readFileSync(stageBinary)).digest('hex')
  let originalOwned = { containers: [] as string[], volumes: [] as string[] }
  const cases = await dispatchNativeCases({
    imageDigest, cases: NATIVE_TRANSFER_CASES,
    execute: async (caseId) => {
      const owned = harness.startTransferProvider(stageBinary, schemaFile, migrationsFile)
      originalOwned = harness.transferOwnedIds()
      const inspection = harness.inspectContainer(owned.containerId)
      if (inspection.Image !== imageDigest || inspection.Config.User !== '65534:0'
          || inspection.HostConfig.CapAdd?.length || !inspection.HostConfig.ReadonlyRootfs
          || inspection.HostConfig.NetworkMode !== 'none') throw new Error('owned native provider policy differs')
      const output = harness.execTransferProviderExact(owned.containerId, [
        'node', '--disable-warning=ExperimentalWarning', '-e', NATIVE_CHILD,
        caseId, harness.candidateSha, imageDigest,
      ])
      const original = JSON.parse(output) as NativeCaseOriginal
      const artifactsDirectory = path.join(harness.evidenceDir, `${caseId}-private`)
      fs.mkdirSync(artifactsDirectory, { mode: 0o700 })
      const captured = JSON.parse(harness.execTransferProviderExact(owned.containerId, ['node', '-e',
        'const fs=require("node:fs");const files=fs.readdirSync("/scratch").filter(name=>name.endsWith(".json")||name==="native-private.log");process.stdout.write(JSON.stringify(files.map(name=>({name,bytes:fs.readFileSync("/scratch/"+name).toString("base64")}))))',
      ])) as { name: string; bytes: string }[]
      for (const artifact of captured) {
        if (!/^[a-zA-Z0-9_-]+\.(?:json|log)$/.test(artifact.name)) throw new Error('native private artifact name differs')
        fs.writeFileSync(path.join(artifactsDirectory, artifact.name), Buffer.from(artifact.bytes, 'base64'), { mode: 0o600, flag: 'wx' })
      }
      original.artifactReferences = captured.map((artifact) => path.join(artifactsDirectory, artifact.name))
      fs.writeFileSync(path.join(harness.evidenceDir, `${caseId}.json`), JSON.stringify({ ...original, candidateSha: harness.candidateSha, imageDigest, adapterSha256, containerId: owned.containerId }), { mode: 0o600, flag: 'wx' })
      return original
    },
    cleanup: async () => {
      originalOwned = harness.transferOwnedIds()
      const cleanup = await harness.cleanup()
      if (!cleanup.ok) throw new Error('owned native transfer cleanup failed')
      harness.verifyTransferCleanup(originalOwned)
    },
  })
  const receipt: NativeMatrixReceipt = {
    kind: 'pinned-native-transfer-matrix', candidateSha: harness.candidateSha, imageDigest, adapterSha256,
    selectedCount: NATIVE_TRANSFER_CASES.length, executedCount: cases.length,
    passedCount: cases.filter((original) => original.assertions.every((assertion) => assertion.pass)).length,
    failedCount: cases.filter((original) => original.assertions.some((assertion) => !assertion.pass)).length,
    skippedCount: NATIVE_TRANSFER_CASES.length - cases.length,
    cleanupCount: originalOwned.containers.length + originalOwned.volumes.length, cleanupStatus: 'complete', cases,
  }
  fs.writeFileSync(path.join(harness.evidenceDir, 'native-transfer-receipt.json'), JSON.stringify(receipt), { mode: 0o600, flag: 'wx' })
  return receipt
}

export function parseNativeTransferArguments(args: string[]): { imageDigest: string } {
  if (args.length !== 4 || args[0] !== '--image-digest' || args[2] !== '--case'
      || args[3] !== 'all' || !/^sha256:[a-f0-9]{64}$/.test(args[1] ?? '')) {
    throw new Error('required --image-digest sha256:<digest> --case all')
  }
  return { imageDigest: args[1]! }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { imageDigest } = parseNativeTransferArguments(process.argv.slice(2))
  runNativeTransferCheck(imageDigest).then((receipt) => {
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
  }).catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ severity: 'error', event: 'opencode.native_transfer.refused', reason: String(error) })}\n`)
    process.exitCode = 1
  })
}
