#!/usr/bin/env node
// Connected preparation is deliberately separate from every native runner.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const artifactMetadata = JSON.parse(fs.readFileSync(path.join(repoRoot, 'test/fixtures/coding-cli/codex-native-artifact.json'), 'utf8'))
const stageRoot = path.join(repoRoot, '.runtime-build/codex-contract')
const stageManifest = path.join(stageRoot, 'staged.json')
const imageTag = 'freshell-sandbox:latest'
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fail = (message) => { throw new Error(`CODEX_CONTRACT_PREREQUISITE: ${message}`) }
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value

export function nativeSandboxPolicy() {
  const resource = JSON.parse(fs.readFileSync(path.join(repoRoot, 'docker/runtime/codex-native-sandbox.json'), 'utf8'))
  if (resource.schemaVersion !== 1 || resource.profile?.defaultAction !== 'SCMP_ACT_ERRNO' || resource.profile?.defaultErrnoRet !== 1 || resource.native?.version !== artifactMetadata.version) fail('declared Codex native sandbox resource is incompatible')
  const json = JSON.stringify(canonical(resource.profile))
  return { id: resource.id, profileSha256: `sha256:${digest(json)}`, profile: resource.profile, native: resource.native, json }
}

async function preparePolicy() {
  const policy = nativeSandboxPolicy()
  const temporary = path.join(stageRoot, `codex-policy.${randomUUID()}.json`)
  await fsp.writeFile(temporary, policy.json, { mode: 0o644, flag: 'wx' })
  await fsp.rename(temporary, path.join(stageRoot, 'codex-policy.json'))
  return policy
}

export function ambientCodex() {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.resolve(directory, 'codex')
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.realpathSync(candidate) } catch {}
  }
  return null
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8', timeout: 1_800_000, maxBuffer: 16 * 1024 * 1024, ...options })
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.error?.message ?? ''}\n${result.stderr ?? ''}\n${result.stdout ?? ''}`)
  return result.stdout
}

export function checkAncestors(directory) {
  const records = []
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    fs.accessSync(current, fs.constants.R_OK | fs.constants.X_OK)
    const stat = fs.statSync(current)
    records.push({ path: current, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 })
    if (path.dirname(current) === current) return records
  }
}

async function inventory(root, relative = '') {
  const files = []
  for (const name of (await fsp.readdir(path.join(root, relative))).sort()) {
    if (!relative && name === 'artifact-receipt.json') continue
    const rel = path.join(relative, name)
    const absolute = path.join(root, rel)
    const stat = await fsp.lstat(absolute)
    if (stat.isDirectory()) files.push(...await inventory(root, rel))
    else if (stat.isFile()) files.push({ path: rel, bytes: stat.size, sha256: digest(await fsp.readFile(absolute)), executable: (stat.mode & 0o111) !== 0 })
    else fail(`nonregular artifact member ${rel}`)
  }
  return files
}

async function normalizeOwnedTree(root) {
  await fsp.chmod(root, 0o755)
  for (const name of await fsp.readdir(root)) {
    const absolute = path.join(root, name)
    const stat = await fsp.lstat(absolute)
    if (stat.isDirectory()) await normalizeOwnedTree(absolute)
    else if (stat.isFile()) await fsp.chmod(absolute, stat.mode & 0o111 ? 0o755 : 0o644)
    else fail(`nonregular artifact member ${absolute}`)
  }
}

export async function verifyArtifact(root, metadata = artifactMetadata) {
  const absolute = await fsp.realpath(root)
  const receipt = JSON.parse(await fsp.readFile(path.join(absolute, 'artifact-receipt.json'), 'utf8'))
  if (receipt.integrity !== metadata.integrity || receipt.packageVersion !== metadata.packageVersion || receipt.complete !== true) fail('artifact receipt does not match pinned metadata')
  const files = await inventory(absolute)
  if (JSON.stringify(files) !== JSON.stringify(receipt.files)) fail('artifact bytes/layout/modes changed after verified preparation')
  if (files.length !== metadata.fileCount || files.reduce((sum, file) => sum + file.bytes, 0) !== metadata.unpackedBytes) fail('artifact size/file count differs from package metadata')
  const manifest = JSON.parse(await fsp.readFile(path.join(absolute, 'package.json'), 'utf8'))
  if (manifest.name !== metadata.packageName || manifest.version !== metadata.packageVersion || !manifest.os?.includes(metadata.platform) || !manifest.cpu?.includes(metadata.arch)) fail('native package manifest does not match pinned platform')
  const permissions = checkAncestors(absolute)
  for (const file of files) {
    fs.accessSync(path.join(absolute, file.path), fs.constants.R_OK | (file.executable ? fs.constants.X_OK : 0))
    checkAncestors(path.dirname(path.join(absolute, file.path)))
  }
  fs.accessSync(path.join(absolute, metadata.executable), fs.constants.X_OK)
  return { ...receipt, path: absolute, permissions, uid: process.getuid?.(), gid: process.getgid?.() }
}

export async function prepareArtifact(output, metadata = artifactMetadata) {
  if (!path.isAbsolute(output)) fail('--output must be absolute')
  if (fs.existsSync(output)) return verifyArtifact(output, metadata)
  const ambientBefore = ambientCodex()
  await fsp.mkdir(path.dirname(output), { recursive: true })
  const temporary = await fsp.mkdtemp(`${output}.partial-`)
  const archive = path.join(temporary, 'native.tgz')
  const unpacked = path.join(temporary, 'package')
  try {
    const response = await fetch(metadata.url, { signal: AbortSignal.timeout(180_000) })
    if (!response.ok || !response.body) fail(`download HTTP ${response.status}`)
    const sha512 = createHash('sha512')
    let archiveBytes = 0
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) { sha512.update(chunk); archiveBytes += chunk.length; callback(null, chunk) } }), fs.createWriteStream(archive, { flags: 'wx' }))
    const integrity = `sha512-${sha512.digest('base64')}`
    if (integrity !== metadata.integrity) fail('download archive integrity mismatch')
    const members = run('tar', ['-tzf', archive]).trim().split('\n')
    if (members.some(member => !member.startsWith('package/') || member.split('/').includes('..') || member.includes('\\'))) fail('unexpected archive path')
    await fsp.mkdir(unpacked)
    run('tar', ['-xzf', archive, '--strip-components=1', '-C', unpacked, '--no-same-owner'])
    await normalizeOwnedTree(unpacked)
    const files = await inventory(unpacked)
    const receipt = { complete: true, ...metadata, archiveBytes, files, ambientBefore, ambientAfter: ambientCodex() }
    if (receipt.ambientAfter !== ambientBefore) fail('preparation changed ambient codex resolution')
    await fsp.writeFile(path.join(unpacked, 'artifact-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 })
    await verifyArtifact(unpacked, metadata)
    try { await fsp.rename(unpacked, output) } catch (error) { if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error }
    return await verifyArtifact(output, metadata)
  } finally { await fsp.rm(temporary, { recursive: true, force: true }) }
}

function dependencyFingerprint() {
  let input = 'manager=pnpm@10.34.5\npolicy=install --frozen-lockfile --store-dir /home/sandbox/.local/share/pnpm/store\n'
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'crates/freshell-claude-sidecar/package.json', 'packages/freshell-mcp-runtime/package.json']) {
    const file = path.join(repoRoot, name)
    if (fs.existsSync(file)) input += `${digest(fs.readFileSync(file))}  ${name}\n`
  }
  return digest(input)
}

async function stagePrepared() {
  if (repoRoot !== '/workspace') fail('--stage-prepared runs only in the connected wrapper')
  const artifact = await verifyArtifact(path.join(stageRoot, 'artifact'))
  const state = await fsp.readFile('/workspace/node_modules/.sandbox-deps-state', 'utf8')
  const fingerprint = dependencyFingerprint()
  if (!state.includes(`fingerprint=${fingerprint}\n`) || !state.includes('manager_version=10.34.5\n')) fail('connected dependency warmup did not produce the expected fingerprint')
  const subdir = `freshcodex-contract-${randomUUID()}`
  const owned = `/workspace/target/${subdir}`
  await fsp.mkdir(owned, { mode: 0o755 })
  await fsp.cp(artifact.path, path.join(owned, 'artifact'), { recursive: true, errorOnExist: true })
  for (const name of ['state', 'receipts']) await fsp.mkdir(path.join(owned, name), { mode: 0o700 })
  await verifyArtifact(path.join(owned, 'artifact'))
  const policy = nativeSandboxPolicy()
  const preparedPolicy = await fsp.readFile(path.join(stageRoot, 'codex-policy.json'), 'utf8')
  if (`sha256:${digest(preparedPolicy)}` !== policy.profileSha256) fail('connected prepared policy is stale or corrupt')
  await fsp.writeFile(path.join(owned, 'codex-policy.json'), preparedPolicy, { mode: 0o644 })
  const manifest = { complete: true, subdir, root: `/freshell-test-artifacts/${subdir}`, artifactRoot: `/freshell-test-artifacts/${subdir}/artifact`, stateRoot: `/freshell-test-artifacts/${subdir}/state`, receiptRoot: `/freshell-test-artifacts/${subdir}/receipts`, nativeSandboxPolicy: { id: policy.id, profileSha256: policy.profileSha256, path: `/freshell-test-artifacts/${subdir}/codex-policy.json` }, fingerprint, uid: process.getuid(), gid: process.getgid(), image: null }
  return manifest
}

async function verifyPrepared() {
  const manifest = JSON.parse(await fsp.readFile(stageManifest, 'utf8'))
  if (!manifest.complete || !/^freshcodex-contract-[a-f0-9-]{36}$/.test(manifest.subdir) || manifest.root !== `/freshell-test-artifacts/${manifest.subdir}`) fail('invalid offline stage ownership')
  if (manifest.fingerprint !== dependencyFingerprint()) fail('dependency inputs changed since connected warmup')
  const state = await fsp.readFile('/workspace/node_modules/.sandbox-deps-state', 'utf8')
  if (!state.includes(`fingerprint=${manifest.fingerprint}\n`) || !state.includes('manager_version=10.34.5\n')) fail('sandbox dependency cache is absent or stale')
  const artifact = await verifyArtifact(manifest.artifactRoot)
  const policy = nativeSandboxPolicy()
  if (manifest.nativeSandboxPolicy?.id !== policy.id || manifest.nativeSandboxPolicy?.profileSha256 !== policy.profileSha256 || manifest.nativeSandboxPolicy.path !== `${manifest.root}/codex-policy.json`) fail('offline native sandbox policy is absent, incompatible or stale')
  const policyBytes = await fsp.readFile(manifest.nativeSandboxPolicy.path)
  if (`sha256:${digest(policyBytes)}` !== policy.profileSha256) fail('offline native sandbox policy bytes changed')
  for (const key of ['stateRoot', 'receiptRoot']) {
    if (manifest[key] !== `${manifest.root}/${key === 'stateRoot' ? 'state' : 'receipts'}`) fail('writable root escaped owned directory')
    const stat = await fsp.stat(manifest[key])
    if (!stat.isDirectory() || stat.uid !== process.getuid() || !(stat.mode & 0o200)) fail(`owned writable root unavailable: ${key}`)
    checkAncestors(manifest[key])
  }
  return { manifest, artifact, fingerprint: manifest.fingerprint, uid: process.getuid(), gid: process.getgid() }
}

export async function verifySandbox() {
  const manifest = JSON.parse(await fsp.readFile(stageManifest, 'utf8'))
  const policy = nativeSandboxPolicy()
  const hostPolicy = await fsp.readFile(path.join(stageRoot, 'codex-policy.json'))
  if (`sha256:${digest(hostPolicy)}` !== policy.profileSha256 || manifest.nativeSandboxPolicy?.profileSha256 !== policy.profileSha256) fail('prepared Codex native policy is absent or stale')
  const image = run('docker', ['image', 'inspect', imageTag, '--format', '{{.Id}}']).trim()
  if (manifest.image !== image) fail('sandbox image changed since connected warmup')
  for (const volume of ['freshell-sandbox-cargo-target', 'freshell-sandbox-node-modules', 'freshell-sandbox-sidecar-node-modules', 'freshell-sandbox-mcp-node-modules']) run('docker', ['volume', 'inspect', volume])
  const name = `freshcodex-verifier-${randomUUID()}`
  const args = ['run', '--rm', '--name', name, '--label', `org.freshell.codex-contract=${name}`, '--read-only', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', `${manifest.uid}:${manifest.gid}`, '--entrypoint', 'node', '-v', `${repoRoot}:/workspace:ro`, '-v', 'freshell-sandbox-cargo-target:/freshell-test-artifacts:ro', '-v', 'freshell-sandbox-node-modules:/workspace/node_modules:ro', image, '/workspace/scripts/testing/prepare-codex-contract.mjs', '--verify-prepared']
  try { return JSON.parse(run('docker', args, { timeout: 60_000 })) } finally {
    const inspection = spawnSync('docker', ['container', 'inspect', name], { encoding: 'utf8', timeout: 15_000 })
    if (inspection.status === 0) {
      const container = JSON.parse(inspection.stdout)[0]
      if (container.Config?.Labels?.['org.freshell.codex-contract'] !== name) fail('verifier container ownership mismatch')
      run('docker', ['rm', '--force', container.Id], { timeout: 30_000 })
    }
  }
}

async function main(args) {
  let result
  if (args[0] === '--output' && args.length === 2) result = await prepareArtifact(args[1])
  else if (args[0] === '--output' && args.length === 4 && args[2] === '--probe-metadata') {
    const metadata = JSON.parse(await fsp.readFile(path.resolve(args[3]), 'utf8'))
    if (metadata.probeOnly !== true) fail('candidate artifact requires an explicit probe-only manifest')
    result = await prepareArtifact(args[1], metadata)
  }
  else if (args.length === 1 && args[0] === '--stage-prepared') result = await stagePrepared()
  else if (args.length === 1 && args[0] === '--verify-prepared') result = await verifyPrepared()
  else if (args.length === 1 && args[0] === '--verify-sandbox') result = await verifySandbox()
  else if (args.length === 1 && args[0] === '--sandbox') {
    await prepareArtifact(path.join(stageRoot, 'artifact'))
    await preparePolicy()
    result = JSON.parse(run('bash', ['scripts/sandbox-test.sh', 'node scripts/testing/prepare-codex-contract.mjs --stage-prepared'], { stdio: ['ignore', 'pipe', 'inherit'] }))
    result.image = run('docker', ['image', 'inspect', imageTag, '--format', '{{.Id}}']).trim()
    await fsp.writeFile(stageManifest, `${JSON.stringify(result, null, 2)}\n`)
    await verifySandbox()
  } else fail('usage: --output ABS | --sandbox | --stage-prepared | --verify-sandbox')
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ severity: 'error', event: 'codex_contract_preparation_failed', message: error.message })); process.exitCode = 1 })
}
