import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { runManagedContainer, verifyManagedPrerequisites } from './codex-managed-contract.mjs'
import { prepareContractImage } from '../../../scripts/testing/prepare-codex-contract.mjs'

const owned = fs.mkdtempSync(path.join(process.env.FRESHELL_TEST_EXECUTABLE_TMP_DIR ?? (fs.existsSync('/freshell-test-artifacts') ? '/freshell-test-artifacts' : os.tmpdir()), 'codex-image-cleanup-'))
const originalPath = process.env.PATH
const base = `sha256:${'a'.repeat(64)}`
const state = path.join(owned, 'state.json')
const calls = path.join(owned, 'calls.jsonl')
const fake = path.join(owned, 'docker')
fs.writeFileSync(fake, `#!${process.execPath}
import fs from 'node:fs';
const state=${JSON.stringify(state)}, calls=${JSON.stringify(calls)};
const args=process.argv.slice(2);fs.appendFileSync(calls,JSON.stringify(args)+'\\n');
const data=fs.existsSync(state)?JSON.parse(fs.readFileSync(state,'utf8')):{};
const save=()=>fs.writeFileSync(state,JSON.stringify(data));
if(args[0]==='image'&&args[1]==='tag'){data[args[3]]={Id:args[2],Config:{Labels:{}}};save()}
else if(args[0]==='build'){const owner=args[args.indexOf('--label')+1].split('=')[1];const tag=args[args.indexOf('-t')+1];data[tag]={Id:'sha256:'+'b'.repeat(64),Config:{Labels:{'org.freshell.codex-contract-owner':owner}}};save();process.stderr.write('injected lost successful build acknowledgement');process.exitCode=71}
else if(args[0]==='image'&&args[1]==='inspect'){const value=data[args[2]];if(!value){process.stderr.write('Error: No such image: '+args[2]);process.exitCode=1}else process.stdout.write(args.includes('--format')?value.Id:JSON.stringify([value]))}
else if(args[0]==='image'&&args[1]==='rm'){assertOwned: {if(!data[args[2]])throw Error('unexpected deletion');delete data[args[2]];save()}}
else if(args[0]==='create'){const name=args[args.indexOf('--name')+1];const owner=args[args.indexOf('--label')+1].split('=')[1];data[name]={Id:'c'.repeat(64),Image:'sha256:'+'a'.repeat(64),Config:{Labels:{'org.freshell.codex-contract':process.env.CODEX_CLEANUP_FOREIGN==='1'?'foreign':owner}}};save();process.stderr.write('injected lost successful create acknowledgement');process.exitCode=72}
else if(args[0]==='inspect'){const value=data[args[1]];if(value)process.stdout.write(JSON.stringify([value]));else{process.stderr.write('Error: No such object: '+args[1]);process.exitCode=1}}
else if(args[0]==='rm'){const entry=Object.entries(data).find(([,v])=>v.Id===args[2]);if(!entry)throw Error('unowned container deletion');delete data[entry[0]];save()}
else if(args[0]==='volume'&&args[1]==='inspect'){process.stderr.write('Error: No such volume');process.exitCode=1}
else throw Error('unexpected fake Docker operation '+JSON.stringify(args));
`, { mode: 0o755 })
// The fake CLI is a regular process with an owned executable directory. It
// records actual subprocess calls; it never contacts a Docker daemon.
process.env.PATH = `${owned}:${originalPath}`
const contexts = []
try {
  for (const failure of ['dockerfile-write', 'lost-build-reply']) {
    fs.writeFileSync(state, '{}')
    fs.writeFileSync(calls, '')
    const owner = `cleanup-${randomUUID()}`
    const contextRoot = path.join(owned, 'contexts')
    const context = path.join(contextRoot, owner)
    contexts.push(context)
    if (failure === 'dockerfile-write') fs.mkdirSync(path.join(context, 'Dockerfile'), { recursive: true })
    await assert.rejects(prepareContractImage(base, owner, contextRoot))
    assert.deepEqual(JSON.parse(fs.readFileSync(state, 'utf8')), {}, `${failure}: every acquired owned image tag must be removed`)
  }
  for (const foreign of [false, true]) {
    fs.writeFileSync(state, '{}'); fs.writeFileSync(calls, '')
    process.env.CODEX_CLEANUP_FOREIGN = foreign ? '1' : '0'
    const owner = `container-${randomUUID()}`
    await assert.rejects(runManagedContainer({ owner, image: base, receiptDir: owned,
      common: ['--label', `org.freshell.codex-contract=${owner}`], label: 'lost-reply', args: [] }), error => {
        const primary = foreign ? error.errors?.[0] : error
        assert.match(primary?.message ?? '', /injected lost successful create acknowledgement/)
        if (foreign) assert(error instanceof AggregateError, 'execution and ownership refusal must both remain diagnosable')
        return true
      })
    const retained = JSON.parse(fs.readFileSync(state, 'utf8'))
    assert.equal(Object.keys(retained).length, foreign ? 1 : 0, 'only the exact owned lost-ack container may be removed')
    const deleted = fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(args => args[0] === 'rm')
    assert.equal(deleted.length, foreign ? 0 : 1)
  }
  delete process.env.CODEX_CLEANUP_FOREIGN
  fs.writeFileSync(calls, '')
  assert.throws(() => verifyManagedPrerequisites({ complete: true, policyClientProbe: { path: `/freshell-test-artifacts/freshcodex-contract-${randomUUID()}/policy-client-probe`, sha256: 'a'.repeat(64) } }))
  const admissionCalls = fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(admissionCalls.map(args => args.slice(0, 2)), [['volume', 'inspect']], 'a missing prepared volume must refuse before create or provisioning')
  console.log(JSON.stringify({ severity: 'info', event: 'codex_managed_image_cleanup_passed', cases: 5 }))
} finally {
  process.env.PATH = originalPath
  for (const context of contexts) fs.rmSync(context, { recursive: true, force: true })
  fs.rmSync(owned, { recursive: true, force: true })
}
