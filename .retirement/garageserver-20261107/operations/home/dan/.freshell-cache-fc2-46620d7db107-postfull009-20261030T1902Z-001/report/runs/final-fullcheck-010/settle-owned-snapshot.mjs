import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'

const D = path.dirname(new URL(import.meta.url).pathname)
const W = '/home/dan/code/freshell/.worktrees/freshcodex-complete'
const snapshot = path.join(W, '.runtime-build/preflight-5ca79633-fb9a-448f-a7f0-3906b98247b2')
const manifestPath = path.join(snapshot, 'manifest.json')
const expected = '29da3bd386b316eb60366494ff563fa86404dd075a559197ddf9de9be140d44b'
const hash = raw => crypto.createHash('sha256').update(raw).digest('hex')
const metadata = p => {
  const s = fs.lstatSync(p)
  return { device: s.dev, inode: s.ino, uid: s.uid, gid: s.gid, mode: s.mode, directory: s.isDirectory(), symlink: s.isSymbolicLink() }
}
assert.equal(fs.realpathSync(W), W)
assert.equal(fs.realpathSync(path.dirname(snapshot)), path.dirname(snapshot))
const before = metadata(snapshot)
assert.equal(before.directory, true)
assert.equal(before.symlink, false)
assert.equal(before.uid, process.getuid())
assert.equal(fs.realpathSync(snapshot), snapshot)
assert.equal(fs.lstatSync(manifestPath).isSymbolicLink(), false)
const raw = fs.readFileSync(manifestPath)
assert.equal(hash(raw), expected)
const manifest = JSON.parse(raw)
assert.equal(manifest.repoRoot, W)
assert.equal(manifest.revision, '6e7c2641bb0d9113127e93bb57ab0958265b3813')
for (const filename of Object.values(manifest.binaries)) assert.equal(path.dirname(filename), snapshot)
const preserved = path.join(D, 'preflight-5ca79633-fb9a-448f-a7f0-3906b98247b2-manifest.json')
assert.equal(hash(fs.readFileSync(preserved)), expected)
assert.equal(fs.existsSync('/proc/26925'), false)
assert.equal(fs.existsSync('/proc/26923'), false)
const again = metadata(snapshot)
assert.deepEqual(again, before)
const receipt = { at: new Date().toISOString(), root_authorization: 'Root message authorizing this exact snapshot after cancellation', snapshot,
  before, manifest_sha256: expected, preserved_manifest: preserved, head: manifest.revision,
  canonical_group_closed_before_cleanup: true, semantics: 'runtime-build-preflight.ts:117 fs.rmSync(directory, {recursive:true,force:true})',
  parent_other_snapshot_cache_source_foreign_cleanup: false }
fs.writeFileSync(path.join(D, 'owned-snapshot-settlement-start.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
fs.rmSync(snapshot, { recursive: true, force: true })
assert.equal(fs.existsSync(snapshot), false)
receipt.finished_at = new Date().toISOString()
receipt.exact_owned_snapshot_absent = true
const output = path.join(D, 'owned-snapshot-settlement.json')
fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ path: output, sha256: hash(fs.readFileSync(output)), snapshot_absent: true, only_verified_owned_snapshot_removed: true }))
