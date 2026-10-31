// The managed proof uses the installed npm entrypoint, not the staged executable.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { repoRoot, artifactMetadata, verifyArtifact, nativeSandboxPolicy, prepareContractImage, verifySandboxTargetCache } from '../../../scripts/testing/prepare-codex-contract.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function docker(args, options = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024, ...options })
  assert.equal(result.status, 0, `${result.error?.message ?? ''}\n${result.stderr}\n${result.stdout}`)
  return result.stdout
}

export async function runManagedContainer({ owner, image, receiptDir, common, label, args, extra = [] }) {
  const name = `${owner}-${label}`
  let id
  let failure
  try {
    id = docker(['create', '--name', name, ...common, ...extra, image, ...args]).trim()
    assert.match(id, /^[a-f0-9]{64}$/)
    const observed = JSON.parse(docker(['inspect', id]))[0]
    assert.equal(observed.Config.Labels['org.freshell.codex-contract'], owner)
    assert.equal(observed.Image, image)
    assert.equal(observed.Config.User, '65534:0')
    assert.equal(observed.HostConfig.ReadonlyRootfs, true)
    assert.deepEqual(observed.HostConfig.CapDrop, ['ALL'])
    assert.equal(observed.HostConfig.NetworkMode, 'none')
    await fsp.writeFile(path.join(receiptDir, `${label}-container.json`), `${JSON.stringify(observed, null, 2)}\n`)
    const result = spawnSync('docker', ['start', '--attach', id], { encoding: 'utf8', timeout: 1_200_000, maxBuffer: 64 * 1024 * 1024 })
    await fsp.writeFile(path.join(receiptDir, `${label}-execution.json`), `${JSON.stringify({ status: result.status, error: result.error?.message, stderr: result.stderr }, null, 2)}\n`)
    await fsp.writeFile(path.join(receiptDir, `${label}-stdout.jsonl`), result.stdout, { mode: 0o600 })
    return result
  } catch (error) {
    failure = error
    throw error
  } finally {
    try {
      // The exact UUID name remains cleanup authority after a lost create ACK.
      const inspection = spawnSync('docker', ['inspect', name], { encoding: 'utf8', timeout: 30_000 })
      if (inspection.status === 0) {
        const observed = JSON.parse(inspection.stdout)[0]
        assert.equal(observed.Config.Labels['org.freshell.codex-contract'], owner)
        assert.equal(observed.Image, image)
        assert.match(observed.Id, /^[a-f0-9]{64}$/)
        docker(['rm', '--force', observed.Id])
      } else assert.match(inspection.stderr, /No such (?:object|container)/)
    } catch (cleanup) {
      console.error(JSON.stringify({ severity: 'error', event: 'codex_managed_container_cleanup_failed', owner, name, message: cleanup.message }))
      if (failure) throw new AggregateError([failure, cleanup], 'Managed Codex execution and owned cleanup failed')
      throw cleanup
    }
  }
}

export function verifyManagedPrerequisites(staged) {
  assert.equal(staged.complete, true, 'managed contract requires completed preparation')
  assert.match(staged.policyClientProbe?.path ?? '', /^\/freshell-test-artifacts\/freshcodex-contract-[a-f0-9-]+\/policy-client-probe$/)
  assert.match(staged.policyClientProbe?.sha256 ?? '', /^[a-f0-9]{64}$/)
  // Refuse absent/foreign preparation before Docker can create any resources.
  return verifySandboxTargetCache()
}

export async function runManagedContract(harness, receiptDir, options = {}) {
  const owner = `managed-codex-${randomUUID()}`
  const artifact = await verifyArtifact(path.join(repoRoot, '.runtime-build/codex-contract/artifact'))
  const staged = JSON.parse(await fsp.readFile(path.join(repoRoot, '.runtime-build/codex-contract/staged.json'), 'utf8'))
  const targetCache = verifyManagedPrerequisites(staged)
  const policy = nativeSandboxPolicy()
  const policyFile = path.join(receiptDir, 'codex-policy.json')
  await fsp.writeFile(policyFile, policy.json, { mode: 0o644 })
  // Proxy-approval requirements belong only to the approval fixture derivative.
  // The production network-enabled mode is qualified against the actual base.
  const image = options.probeNetworkEnabled
    ? { image: harness.imageRef, baseImage: harness.imageRef, subdir: owner }
    : await prepareContractImage(harness.imageRef, owner)
  try {
    const ambient = path.join(receiptDir, `${owner}-ambient-helper`)
    await fsp.mkdir(ambient, { mode: 0o755 })
    await fsp.writeFile(path.join(ambient, 'bwrap'), '#!/bin/sh\ncase "$1" in --version) echo ambient-incompatible-bwrap;; --help) echo "--as-pid-1 --perms";; *) printf used > "$TMPDIR/ambient-bwrap-used"; exit 97;; esac\n', { mode: 0o755 })
    const targetMount = `type=volume,source=${targetCache.name},target=/freshell-test-artifacts,readonly,${Object.entries(targetCache.labels).map(([key, value]) => `volume-label=${key}=${value}`).join(',')}`
    const common = ['--label', `org.freshell.codex-contract=${owner}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--security-opt', `seccomp=${policyFile}`, '--user', '65534:0', '--pids-limit', '512', '--memory', '1g', '--cpus', '2', '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777', '--tmpfs', '/probe-state:rw,nosuid,nodev,size=512m,mode=700,uid=65534,gid=0', '--mount', `type=bind,source=${repoRoot},target=/contract,readonly`, '--mount', `type=bind,source=${artifact.path}/artifact-receipt.json,target=/native-reference.json,readonly`, '--mount', `type=bind,source=${ambient},target=/opt/freshell-codex-ambient,readonly`, '--mount', targetMount, '--env', 'FRESHELL_CODEX_MANAGED_CONTRACT=1', '--env', `FRESHELL_CODEX_POLICY_CLIENT_PROBE=${staged.policyClientProbe.path}`, '--env', 'PATH=/opt/freshell-codex-ambient:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', '--entrypoint', '/usr/local/bin/node']
    const run = (label, args, extra = []) => runManagedContainer({ owner, image: image.image, receiptDir, common, label, args, extra })
    const missing = await run('missing-helper', [policy.native.launchWrapper, '--version'], ['--entrypoint', '/usr/local/bin/node', '--tmpfs', `${policy.native.helperDirectory}:ro,nosuid,nodev,size=1m,mode=755`])
    assert.notEqual(missing.status, 0, 'missing owned helper must refuse before native startup')
    assert.match(missing.stderr, /owned bwrap helper is missing/)
    const command = ['/contract/test/integration/providers/codex-cli-contract.mjs', '--scenario', options.scenario ?? 'all', '--state-root', '/probe-state', '--receipt-dir', '/probe-state/receipts', '--emit-receipt']
    if (options.probeNetworkEnabled) command.push('--probe-network-enabled')
    if (options.probeApprovalPolicy) command.push('--probe-approval-policy', options.probeApprovalPolicy)
    if (options.sandboxMode) command.push('--sandbox-mode', options.sandboxMode)
    const result = await run('native', command)
    const captures = result.stdout.split('\n').filter(Boolean).flatMap(line => { try { const frame = JSON.parse(line); return frame.nativeCapture ? [frame.capture] : [] } catch { return [] } })
    const index = []
    for (const capture of captures) {
      const file = `${index.length.toString().padStart(2, '0')}-${capture.scenario}.json`
      const json = `${JSON.stringify(capture)}\n`
      await fsp.writeFile(path.join(receiptDir, file), json, { mode: 0o600 })
      index.push({ file, sha256: hash(json), scenario: capture.scenario, parameters: capture.parameters, passed: capture.passed, uid: capture.environment.uid, gid: capture.environment.gid, binary: capture.binary, requestCount: capture.requests.length, fixtureRequestCount: capture.fixtureTraffic.length })
    }
    await fsp.writeFile(path.join(receiptDir, 'receipt-index.json'), `${JSON.stringify({ image, profile: { id: policy.id, sha256: policy.profileSha256 }, captures: index }, null, 2)}\n`)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(captures.length, (options.scenario ?? 'all') === 'all' ? 24 : 1, 'all selected actual managed native cases must execute')
    for (const capture of captures) {
      assert.equal(capture.passed, true)
      assert.equal(capture.environment.uid, 65534)
      assert.equal(capture.environment.gid, 0)
      assert.equal(capture.binary.path, policy.native.launchWrapper)
      assert.equal(capture.binary.version, artifactMetadata.version)
      for (const helper of capture.observations.executedSandboxHelpers ?? []) assert.equal(helper.executable, capture.environment.managedLayout.bwrap)
    }
    assert(captures.some(capture => capture.observations.executedSandboxHelpers?.length), 'the installed bundled helper must actually execute')
    console.log(JSON.stringify({ severity: 'info', event: 'codex_managed_native_contract_passed', image: image.image, cases: captures.length, uid: 65534, gid: 0, profile: policy.profileSha256 }))
  } finally {
    if (image.contractImage) {
      const observed = JSON.parse(docker(['image', 'inspect', image.contractImage.tag]))[0]
      assert.equal(observed.Id, image.image)
      assert.equal(observed.Config.Labels['org.freshell.codex-contract-owner'], owner)
      docker(['image', 'rm', image.contractImage.tag])
    }
  }
  if ((options.scenario ?? 'all') === 'all') {
    const networkReceipts = path.join(receiptDir, 'network-enabled')
    await fsp.mkdir(networkReceipts, { mode: 0o700 })
    await runManagedContract(harness, networkReceipts, { scenario: 'approval-policy-restricted-exec', probeNetworkEnabled: true, probeApprovalPolicy: 'never', sandboxMode: 'workspace-write' })
  }
}
