//! Trusted closed-fixture entrypoint. Only this container receives Docker IPC;
//! the native startup fixture receives this broker's restricted proxy socket.
import fs from 'node:fs'
import path from 'node:path'
import { RestrictedDockerBroker, type PreparedInputAuthorization } from './runtime-test-broker.js'

const root=process.env.FRESHELL_PROVIDER_LAUNCH_FIXTURE ?? ''
if (path.dirname(root)!=='/tmp' || !/^fln-[a-f0-9]{16}$/.test(path.basename(root))) {
  throw new Error('closed provider startup requires its exact owned fixture root')
}
const configuration=JSON.parse(fs.readFileSync(path.join(root,'broker-configuration.json'),'utf8'))
const image='sha256:967627e41734aa903e824e4be22849c7f22ce0e69487ce61bb72004c4817f89c'
if (configuration.imageRef!==image || !['opencode','codex'].includes(configuration.provider) || !Array.isArray(configuration.initialVolumes) || configuration.initialVolumes.length!==2) {
  throw new Error('closed provider startup image or finite source set changed')
}
const gateways=new Set<string>()
const broker=new RestrictedDockerBroker({
  realSocketPath:'/run/fixture-docker.sock',proxySocketPath:path.join(root,'broker.sock'),
  runtimeRootPrefix:path.join(root,'scenarios'),allowedHostBinaryPaths:new Set([configuration.hostBinaryPath]),
  allowedImageRefs:new Set([image]),allowTerminalWorkloads:true,
  allowedWorkspaceRoots:new Set([path.join(root,'workspace')]),
  allowedProviderUserRoots:new Set(configuration.provider==='codex'
    ? ['/home/freshell/provider',path.join(root,'source-home/.codex')]
    : ['/home/freshell/provider',path.join(root,'.opencode')]),
  allowedBootstrapFiles:new Set([path.join(root,'grants/environment.env'),path.join(root,'grants/auth.json'),path.join(root,'grants/ca.pem')]),
  allowedHostGatewayAddresses:gateways,
  testRunId:configuration.runId,logPath:path.join(root,'broker.jsonl'),
})
for (const authorization of configuration.initialVolumes) broker.authorizeInitialProviderVolume(authorization)
await broker.start()
const accepted=new Set<string>()
const timer=setInterval(()=>{
  try {
    const gatewayFile=path.join(root,'controller-gateway.json')
    if (fs.existsSync(gatewayFile) && gateways.size===0) {
      const gateway=JSON.parse(fs.readFileSync(gatewayFile,'utf8'))
      if (typeof gateway.address!=='string' || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(gateway.address)) throw new Error('closed controller gateway is invalid')
      gateways.add(gateway.address)
    }
    const directory=path.join(root,'handoff')
    const entries=fs.readdirSync(directory).filter((name)=>name.endsWith('.json'))
    if (entries.length>2) throw new Error('closed provider fixture exceeds its finite two launch attempts')
    for (const name of entries) {
      if (accepted.has(name)) continue
      if (!/^[a-zA-Z0-9_-]{1,128}\.json$/.test(name)) throw new Error('closed provider fixture handoff name invalid')
      const file=path.join(directory,name)
      const stat=fs.lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size>1024*1024) throw new Error('closed provider fixture handoff profile exceeded')
      const input=JSON.parse(fs.readFileSync(file,'utf8')) as PreparedInputAuthorization
      if (!configuration.initialVolumes.some((source:any)=>source.installationId===input.installationId
        && source.soulId===input.soulId && source.providerVolumeName===input.providerVolumeName)) {
        throw new Error('closed provider fixture handoff owner changed')
      }
      broker.authorizePreparedInputs(input)
      accepted.add(name)
      fs.writeFileSync(file.slice(0,-'.json'.length)+'.accepted','ok',{mode:0o600})
    }
    if (fs.existsSync(path.join(root,'broker-complete'))) {
      clearInterval(timer)
      void broker.close().then(()=>{
        fs.writeFileSync(path.join(root,'broker-receipt.json'),JSON.stringify({
          events:broker.eventsSnapshot(),receipts:broker.receipts(),unsafeAttempts:broker.unsafeAttempts(),acceptedPreparations:accepted.size,
        })+'\n',{mode:0o600})
      })
    }
  } catch {
    clearInterval(timer)
    fs.writeFileSync(path.join(root,'broker-failure'),'closed fixture authorization failed',{mode:0o600})
    void broker.close()
    process.exitCode=1
  }
},20)
