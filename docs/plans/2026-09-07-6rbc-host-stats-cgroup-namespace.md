# Host-Stats cgroup-v2 Namespace (Docker default) Fix Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
`server/host-stats/readers.ts` and the Rust mirror
`crates/freshell-platform/src/host_stats_readers.rs` currently discard a
cgroup-v2 membership of `0::/` on the assumption that the cgroup filesystem
root has no limit files. Under a private cgroup namespace — Docker's default
on cgroup-v2 hosts — the kernel deliberately rewrites the process's membership
to `/`, and the namespace-private cgroupfs mount exposes the container's own
cgroup at the filesystem root, complete with `memory.current`, `memory.max`,
`pids.max`, and `pids.current`. The fix: read limit files relative to the
cgroup-namespace-visible root when membership is `0::/` (or the resolved
membership path doesn't exist under the cgroup root), so Freshell inside a
default Docker deployment sees the container's real memory and task caps
instead of falling back to host limits and reporting ALL GOOD immediately
before the container hits its actual cap.

### Explicit constraints
- Readers must keep their existing contract: pure, path-injected, synchronous,
  never throwing on read/parse failure (return `null`/`None`).
- On a real, non-namespaced host the cgroup2 root has no limit files, so the
  fs-root reads must degrade to the exact same fallbacks as today (host
  meminfo / `threads-max`).
- Add a parser unit test with a `0::/` membership plus a namespaced cgroupfs
  fixture (both Node and Rust mirrors).
- Mirror the fix in the Rust reader (`crates/freshell-platform/src/
  host_stats_readers.rs`); Rust reader semantics track the Node layer.
- Do not change the frozen public parameter order of `readCgroupMemory` /
  `readPidsLimit` / `readPidsConstraint` (or their Rust equivalents).

### Accepted tradeoffs and residuals
- Out of scope: cgroup v1 namespaces (Docker's private cgroupns default is a
  cgroup-v2-only feature; v1 behavior stays byte-for-byte identical).
- Out of scope: CPU/IO cgroup limits; the pane reads memory + pids only.
- The historical host-pressure plan doc
  (`docs/plans/2026-08-25-host-pressure-pane.md`) records the old "never read
  the fs root" assumption for context; committed plans are history and are not
  retro-edited.

**Goal:** Fresh installs of Freshell running inside Docker with the default private cgroup namespace report the container's real memory/pids limits on the host-pressure pane instead of the host's.

**Architecture:** Localize the change to leaf resolution: `resolveCgroupLeaf` (and the Rust `resolve_cgroup_leaf`) gains the `cgroupRoot` it already indirectly serves, and for cgroup v2 returns the namespace-visible fs root (path `''`) when membership is `0::/` or when the resolved membership path does not exist under `cgroupRoot`. Memberships the kernel encodes `../`-relative (a process seen from outside its cgroup namespace, per `cgroup_namespaces(7)`) likewise resolve to the fs root — the closest visible ancestor — and never read above the injected `cgroupRoot`. The memory and pids readers then read at that root through the exact same file names and fallback logic as today; the pids-constraint chain walk extends one extra depth (the fs-root node) for v2 only, which is a no-op on real hosts because the root node carries no limit files there.

**Tech Stack:** TypeScript (Node/ESM) server readers + Vitest unit tests; Rust `freshell-platform` reader mirror + `freshell-server` `#[cfg(test)]` fixture tests (tempfile-built trees); the Darkforge full QA gate (`npm run check` + cargo fmt/clippy).

## Global Constraints

- Every reader NEVER throws on read/parse failure: `null` (Node) / `None`
  (Rust). The only sanctioned throw in the module remains
  `DeadlineExceeded` from `scanProcessTable`, untouched by this plan.
- Frozen public signatures are preserved: `readCgroupMemory(cgroupRoot,
  procRoot)`, `readPidsLimit(procRoot, cgroupRoot)`,
  `readPidsConstraint(procRoot, cgroupRoot)` (Node) and the analogous Rust
  orderings. Only the private `resolveCgroupLeaf` / `resolve_cgroup_leaf`
  helpers gain a parameter.
- The stale-assumption comments (`"no limit files there"`, `"must NOT fall
  back to reading the cgroup fs root"`, etc.) in the touched files must be
  rewritten to state the new namespace-aware contract; reviewers check
  comments against behavior.
- Tests follow the existing tmpdir-fixture pattern (`writeFile` in Node,
  `write_rel` in Rust) — no committed fixture-tree changes.
- All repo rules in AGENTS.md apply (TDD red/green/refactor, NodeNext `.js`
  import suffixes, structured logging where applicable — no new logging is
  expected here).

---

### Task 1: Node readers — namespace-aware v2 leaf resolution + unit tests

**Files:**
- Modify: `server/host-stats/readers.ts` (`resolveCgroupLeaf` + its JSDoc at lines 85–112; `readCgroupMemory` call site line 211 + JSDoc 196–202; `readPidsLimit` call site line 439 + JSDoc 428–436; `readPidsConstraint` call site line 482 + walk bound 484–490 + JSDoc 458–476)
- Test: `test/unit/server/host-stats/readers.test.ts`

**Interfaces:**
- Consumes: existing private helpers `safeRead`, `splitLines`, `readNumberFile`, `parseCgroupLimit`; public readers `readCgroupMemory(cgroupRoot, procRoot)`, `readPidsLimit(procRoot, cgroupRoot)`, `readPidsConstraint(procRoot, cgroupRoot)`.
- Produces: `resolveCgroupLeaf(procRoot, v1Controller, cgroupRoot): { version: 'v1' | 'v2'; path: string } | null` where a v2 `path` may be `''`, intentionally denoting the namespace-visible cgroupfs root. Public reader signatures and return types are unchanged.

- [ ] **Step 1: Write the failing behavioral test**

In `test/unit/server/host-stats/readers.test.ts`:

1. Extend the header-comment tmpdir list (lines 14–17 area) with the cgroup
   namespace variants.
2. Add tmpdir fixtures in `beforeAll` (declare the `let` bindings with the
   rest at lines 83–85):

```ts
let nsV2Proc: string
let nsV2Cgroup: string
let nsMissingProc: string
let nsRootCgroup: string
let nsEscapeProc: string
```

```ts
  // cgroup-v2 NAMESPACE (Docker's default private cgroupns on v2 hosts):
  // the kernel reports this process's membership as '0::/' and the
  // namespace-private cgroupfs mount exposes the container's own cgroup —
  // WITH limit files — at the filesystem root.
  nsV2Proc = path.join(tmp, 'ns-v2', 'proc')
  nsV2Cgroup = path.join(tmp, 'ns-v2', 'cgroup')
  writeFile(nsV2Proc, 'self/cgroup', '0::/\n')
  writeFile(nsV2Proc, 'sys/kernel/threads-max', '999999\n')
  writeFile(nsV2Cgroup, 'memory.current', '1073741824\n')
  writeFile(nsV2Cgroup, 'memory.max', '4294967296\n')
  writeFile(nsV2Cgroup, 'pids.max', '512\n')
  writeFile(nsV2Cgroup, 'pids.current', '400\n')

  // Membership names a host path that does NOT exist under the mounted
  // cgroupfs (mount rooted at the container's cgroup while /proc still
  // reports the host path): the namespace-visible fs root carries the files.
  nsMissingProc = path.join(tmp, 'ns-missing', 'proc')
  nsRootCgroup = path.join(tmp, 'ns-missing', 'cgroup')
  writeFile(nsMissingProc, 'self/cgroup', '0::/docker/deadbeefcafe\n')
  writeFile(nsRootCgroup, 'memory.current', '268435456\n')
  writeFile(nsRootCgroup, 'memory.max', '536870912\n')
  writeFile(nsRootCgroup, 'pids.max', '256\n')
  writeFile(nsRootCgroup, 'pids.current', '10\n')

  // '../'-relative membership (cgroup_namespaces(7): a process seen from
  // outside its cgroup namespace). The sibling 'escape' dir carries
  // DIFFERENT limit values and sits ABOVE the injected cgroup root; the
  // resolver must bind the namespace root (nsV2Cgroup), never the escape.
  nsEscapeProc = path.join(tmp, 'ns-escape', 'proc')
  writeFile(nsEscapeProc, 'self/cgroup', '0::/../escape\n')
  writeFile(path.join(tmp, 'ns-v2'), 'escape/memory.current', '1\n')
  writeFile(path.join(tmp, 'ns-v2'), 'escape/memory.max', '2\n')
  writeFile(path.join(tmp, 'ns-v2'), 'escape/pids.max', '999\n')
  writeFile(path.join(tmp, 'ns-v2'), 'escape/pids.current', '1\n')
```

Add `writeFile(pidsRootCgroupProc, 'sys/kernel/threads-max', '4242\n')` next
to the existing `pidsRootCgroupProc` fixture (line 213) and rewrite its
comment (lines 210–211) to: *"Process membership reported as the namespace
root ('0::/'); the committed cgroup tree has no top-level limit files, so
even after the namespace-aware fs-root read there is no binding constraint —
the fallbacks behave exactly as on a real non-namespaced host root."*

3. Add the new tests:

In `describe('readCgroupMemory', ...)`:

```ts
  it('reads limit files at the fs root when v2 membership is the namespace root (0::/)', () => {
    expect(readCgroupMemory(nsV2Cgroup, nsV2Proc)).toEqual({
      limitBytes: 4294967296,
      currentBytes: 1073741824,
    })
  })

  it('falls back to the fs root when the v2 membership path is not mounted', () => {
    expect(readCgroupMemory(nsRootCgroup, nsMissingProc)).toEqual({
      limitBytes: 536870912,
      currentBytes: 268435456,
    })
  })

  it('returns null for 0::/ when the (non-namespaced) fs root has no limit files', () => {
    expect(readCgroupMemory(emptyCgroupRoot, pidsRootCgroupProc)).toBeNull()
  })
```

and retitle the existing leaf-absent test (currently line 304): change the
title to `'returns null when neither the leaf nor the fs root has limit files'`
and its body comment to: *"cgroupRoot exists but holds no limit files at any
depth the namespace contract can see (leaf tree absent, fs root empty)."*
The assertion `expect(readCgroupMemory(emptyCgroupRoot, PROMINI)).toBeNull()`
is unchanged.

In `describe('readPidsLimit', ...)`:

```ts
  it('reads pids.max at the fs root when v2 membership is the namespace root (0::/)', () => {
    expect(readPidsLimit(nsV2Proc, nsV2Cgroup)).toBe(512)
  })

  it('falls back to the fs root when the v2 membership path is not mounted', () => {
    expect(readPidsLimit(nsMissingProc, nsRootCgroup)).toBe(256)
  })

  it('keeps the threads-max fallback for 0::/ at a real (non-namespaced) fs root', () => {
    expect(readPidsLimit(pidsRootCgroupProc, emptyCgroupRoot)).toBe(4242)
  })
```

In `describe('readPidsConstraint', ...)`:

```ts
  it('binds the fs-root node when v2 membership is the namespace root (0::/)', () => {
    expect(readPidsConstraint(nsV2Proc, nsV2Cgroup)).toEqual({ current: 400, max: 512 })
  })

  it('binds the fs-root node when the v2 membership path is not mounted', () => {
    expect(readPidsConstraint(nsMissingProc, nsRootCgroup)).toEqual({ current: 10, max: 256 })
  })

  it('treats ../-relative v2 membership as the fs root, never above the injected root', () => {
    expect(readPidsConstraint(nsEscapeProc, nsV2Cgroup)).toEqual({ current: 400, max: 512 })
  })
```

In `describe('readCgroupMemory', ...)`:

```ts
  it('treats ../-relative v2 membership as the fs root, never above the injected root', () => {
    expect(readCgroupMemory(nsV2Cgroup, nsEscapeProc)).toEqual({
      limitBytes: 4294967296,
      currentBytes: 1073741824,
    })
  })
```

and retitle the existing root test (currently line 517) to
`'returns null for 0::/ when the fs root has no pids limit files'` with the
comment updated to the namespace-aware contract; the assertion
`expect(readPidsConstraint(pidsRootCgroupProc, CGROUP)).toBeNull()` is
unchanged (the committed cgroup tree has no top-level `pids.max`).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/server/host-stats/readers.test.ts --config config/vitest/vitest.server.config.ts -t 'namespace root'`

Expected: FAIL — exactly the three new tests whose titles contain `namespace
root` run, and all three fail because `resolveCgroupLeaf` returns null for
`0::/` today (`readCgroupMemory`/`readPidsConstraint` → null instead of the
root-file values; `readPidsLimit` → the threads-max fallback 999999 instead
of 512). Then run the full file without `-t` and confirm exactly eight new
failures — the three `0::/` value tests, the three unmounted-path value
tests, and the two `../`-relative tests (today the resolver returns the
`../escape` leaf and binds the sibling dir's values 2/1 or {current: 1, max:
999}) — with everything else (including the three fallback-shaped tests)
still passing.

- [ ] **Step 3: Add the minimal production implementation**

In `server/host-stats/readers.ts`:

1. Add the helper directly after `safeReaddir` (ends line 83):

```ts
/**
 * Directory probe; false instead of throwing. Used by resolveCgroupLeaf to
 * detect a v2 membership whose path is not present under the mounted
 * cgroupfs (a mount rooted at the container's own cgroup).
 */
function safeIsDir(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory()
  } catch {
    return false
  }
}
```

2. Replace the lines 85–112 block (JSDoc + `type CgroupLeaf` +
   `resolveCgroupLeaf`) in full with:

```ts
/**
 * Resolve THIS process's cgroup leaf from <procRoot>/self/cgroup.
 *
 * cgroup v2 namespace contract: a PRIVATE cgroup namespace (Docker's default
 * on cgroup-v2 hosts) rewrites this process's v2 membership to '0::/', and
 * the namespace-visible cgroupfs mount exposes the container's OWN cgroup at
 * the filesystem root — its memory.current/memory.max/pids.max/pids.current
 * live AT <cgroupRoot> itself. Those limit files exist only at the root of a
 * namespace-rooted mount: the REAL cgroup2 root of a non-namespaced host has
 * none of them (only statistics/pressure files), so reads resolved to the fs
 * root degrade to the same null/threads-max fallbacks as before there. Three
 * v2 shapes therefore resolve to the fs root (path ''): membership '0::/',
 * a membership path that does not exist under <cgroupRoot> (a mount rooted
 * at the container's cgroup while /proc still reports the host path), and a
 * '../'-relative membership (out-of-namespace — reads at the closest visible
 * ancestor, never above <cgroupRoot>). cgroup v1 is unchanged: v1 has no
 * namespace membership rewrite and the v1 fs root DOES carry
 * (garbage-sentinel) limit files, so v1 never resolves to the fs root.
 */
type CgroupLeaf = { version: 'v1' | 'v2'; path: string } | null

function resolveCgroupLeaf(procRoot: string, v1Controller: string, cgroupRoot: string): CgroupLeaf {
  const text = safeRead(path.join(procRoot, 'self', 'cgroup'))
  if (text === null) return null
  const lines = splitLines(text)
  // v2 unified hierarchy: a single "0::/path" line.
  const v2 = lines.find((line) => line.startsWith('0::'))
  if (v2) {
    const leaf = v2.slice('0::'.length).replace(/^\/+/, '')
    // '' is a cgroup-namespace root; a membership path absent from the mounted
    // cgroupfs is the same namespace shape seen through /proc; a '../'-relative
    // membership is the kernel's encoding for a cgroup outside the visible
    // namespace (cgroup_namespaces(7)) and must never resolve ABOVE the
    // injected root. All three read at the fs root — the closest visible
    // ancestor; on a real non-namespaced host the root has no limit files, so
    // the readers' null fallbacks fire exactly as before.
    if (leaf === '' || leaf.split('/').includes('..') || !safeIsDir(path.join(cgroupRoot, leaf))) {
      return { version: 'v2', path: '' }
    }
    return { version: 'v2', path: leaf }
  }
  // v1: "<hierarchy>:<controller[,controller...]>:/path"
  for (const line of lines) {
    const parts = line.split(':')
    if (parts.length !== 3) continue
    if (!parts[1].split(',').includes(v1Controller)) continue
    const leaf = parts[2].replace(/^\/+/, '')
    if (leaf === '') return null
    return { version: 'v1', path: leaf }
  }
  return null
}
```

3. `readCgroupMemory` (line 211): change the resolver call to
   `const leaf = resolveCgroupLeaf(procRoot, 'memory', cgroupRoot)` and
   replace the JSDoc sentence at lines 200–201 ('The cgroup fs root has NO
   limit files by design...never read the fs root.') with: *"A v2 membership
   of '0::/' (cgroup-namespace root, Docker's default) or one whose path is
   not mounted resolves to the cgroupfs fs root itself; on a non-namespaced
   host that root has no limit files, so null falls through as before."*

4. `readPidsLimit` (line 439): change the resolver call to
   `const leaf = resolveCgroupLeaf(procRoot, 'pids', cgroupRoot)`. The `dir`
   computation is unchanged (`path.join(cgroupRoot, '')` is the fs root).
   Append to the JSDoc: *"v2 leaf resolution is namespace-aware: see
   resolveCgroupLeaf."*

5. `readPidsConstraint`: change line 482 to `const leaf =
   resolveCgroupLeaf(procRoot, 'pids', cgroupRoot)`, replace the stale JSDoc
   paragraph ('The cgroup fs root has NO limit files by design; … sitting at
   the cgroup2 root.') and the stale inline comment above the chain loop, and
   extend only the v2 walk to depth 0. The complete final JSDoc tail (from
   the blank ` *` after 'Deepest node wins ties (deterministic).') and the
   full function are:

```ts
 *
 * The v2 chain INCLUDES the fs-root node: under a private cgroup namespace
 * (Docker's default on v2) resolveCgroupLeaf yields path '' and that root IS
 * the container's cgroup, with real limit files; on a non-namespaced host the
 * root carries no pids files, so the depth-0 node is simply skipped. The v1
 * walk is unchanged (v1 has no namespace membership rewrite).
 *
 * NOTE (frozen contract): parameter order here is (procRoot, cgroupRoot) — the
 * opposite of readCgroupMemory(cgroupRoot, procRoot). Callers: read the
 * signatures, do not assume.
 */
export function readPidsConstraint(
  procRoot: string = PROC_ROOT,
  cgroupRoot: string = CGROUP_ROOT,
): PidsConstraint | null {
  try {
    const leaf = resolveCgroupLeaf(procRoot, 'pids', cgroupRoot)
    if (!leaf) return null
    // Deepest-first chain; v2 walks one node past the leaf chain to the fs
    // root (namespace-visible cgroup), v1 stops at depth 1 as before.
    const segments = leaf.path.split('/').filter((segment) => segment.length > 0)
    const minDepth = leaf.version === 'v2' ? 0 : 1
    let best: PidsConstraint | null = null
    let bestRatio = -1
    for (let depth = segments.length; depth >= minDepth; depth--) {
      const nodePath = segments.slice(0, depth).join('/')
      const dir =
        leaf.version === 'v2' ? path.join(cgroupRoot, nodePath) : path.join(cgroupRoot, 'pids', nodePath)
      const maxText = safeRead(path.join(dir, 'pids.max'))
      if (maxText === null) continue
      const max = parseCgroupLimit(maxText)
      if (max === null || max <= 0) continue // 'max'/garbage: unlimited, not binding
      const currentText = safeRead(path.join(dir, 'pids.current'))
      if (currentText === null) continue // no readable same-node pair
      const current = Number(currentText.trim())
      if (!Number.isFinite(current) || current < 0) continue
      const ratio = current / max
      if (ratio > bestRatio) {
        bestRatio = ratio
        best = { current, max }
      }
    }
    return best
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run the focused test**

Run: `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/server/host-stats/readers.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS (all tests in the file, including the previously passing
committed-fixture tests and the retitled null tests).

- [ ] **Step 5: Refactor while green**

Confirm `resolveCgroupLeaf` remains the single place knowing the namespace
contract (no per-reader duplication of the `''` rule) and that every JSDoc
mention of the old "never read the fs root" assumption in the touched line
ranges is revised. No further refactor expected: the change is one helper,
two resolver branches, and one loop bound.

- [ ] **Step 6: Run impacted-test verification**

Impacted surface: `server/host-stats/readers.ts` is consumed by
`server/host-stats/service.ts` (readers mocked in its tests) and by the
host-stats test suites. Run the whole host-stats directory plus typecheck:

Run: `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/server/host-stats --config config/vitest/vitest.server.config.ts && npm run typecheck`

Expected: PASS (both readers.test.ts and service.test.ts green; typecheck clean).

- [ ] **Step 7: Commit the task**

```bash
git add server/host-stats/readers.ts test/unit/server/host-stats/readers.test.ts
git commit -m "fix(host-stats): read v2 cgroup limits at the cgroup-namespace-visible root

A private cgroup namespace (Docker's default on cgroup-v2 hosts) rewrites
/proc/self/cgroup membership to 0::/ and mounts the container's own cgroup
at the cgroupfs root, so memory.max/pids.max live AT the fs root. The
readers assumed the fs root never has limit files and dropped 0::/
memberships outright, silently falling back to HOST limits inside exactly
the container deployments the host-pressure pane exists for. Resolve a v2
membership of 0::/ (or one whose path is not mounted under the cgroup root)
to the fs root; on a real non-namespaced host the root carries no limit
files, so the reads there degrade to the existing null/threads-max
fallbacks unchanged."
```

### Task 2: Rust mirror — same resolution in freshell-platform + fixture tests

**Files:**
- Modify: `crates/freshell-platform/src/host_stats_readers.rs` (lines 82–120 `resolve_cgroup_leaf`; 289–316 `read_cgroup_memory`; 678–695 `read_pids_limit`; 724–763 `read_pids_constraint`; stale doc comments at 82–84, 278–284, 718–719, 726)
- Test: `crates/freshell-server/src/host_stats.rs` (`#[cfg(test)]` module, fixture-reader section — new test + comment refresh at lines 1627–1630 and 1709–1715)

**Interfaces:**
- Consumes: Task 1's finalized contract ( proves the reference behavior), the existing private helpers `safe_read`, `read_number_file`, `parse_cgroup_limit`, and `write_rel` in the test module.
- Produces: `resolve_cgroup_leaf(proc_root, v1_controller, cgroup_root) -> Option<CgroupLeaf>` where `CgroupLeaf::V2(String)` may carry an empty `String` denoting the namespace-visible fs root; public function signatures unchanged.

- [ ] **Step 1: Write the failing behavioral test**

In `crates/freshell-server/src/host_stats.rs`, add one test after
`host_stats_pids_constraint_v1_chain` (mirroring Node Task 1 Step 1):

```rust
    #[test]
    fn host_stats_cgroup_v2_namespace_root_reads() {
        // 0::/ + namespace-private cgroupfs mount (Docker default on v2
        // hosts): the container's limit files live AT the fs root.
        let tmp = tempfile::tempdir().unwrap();
        let proc_root = tmp.path().join("proc");
        let cgroup_root = tmp.path().join("cgroup");
        write_rel(&proc_root, "self/cgroup", "0::/\n");
        write_rel(&proc_root, "sys/kernel/threads-max", "999999\n");
        write_rel(&cgroup_root, "memory.current", "1073741824\n");
        write_rel(&cgroup_root, "memory.max", "4294967296\n");
        write_rel(&cgroup_root, "pids.max", "512\n");
        write_rel(&cgroup_root, "pids.current", "400\n");
        assert_eq!(
            readers::read_cgroup_memory(&cgroup_root, &proc_root),
            Some(readers::CgroupMemory {
                limit_bytes: Some(4294967296),
                current_bytes: 1073741824,
            })
        );
        assert_eq!(readers::read_pids_limit(&proc_root, &cgroup_root), Some(512));
        assert_eq!(
            readers::read_pids_constraint(&proc_root, &cgroup_root),
            Some(readers::PidsConstraint {
                current: 400,
                max: 512,
            })
        );

        // 0::/ at the REAL (non-namespaced) host root: no limit files exist
        // there, so every reader keeps its existing fallback.
        let tmp = tempfile::tempdir().unwrap();
        let proc_root = tmp.path().join("proc");
        let cgroup_root = tmp.path().join("cgroup");
        std::fs::create_dir_all(&cgroup_root).unwrap();
        write_rel(&proc_root, "self/cgroup", "0::/\n");
        write_rel(&proc_root, "sys/kernel/threads-max", "4242\n");
        assert!(readers::read_cgroup_memory(&cgroup_root, &proc_root).is_none());
        assert!(readers::read_pids_constraint(&proc_root, &cgroup_root).is_none());
        assert_eq!(readers::read_pids_limit(&proc_root, &cgroup_root), Some(4242));

        // Membership names a host path that is not mounted under the
        // cgroupfs mount: read the namespace-visible fs root instead.
        let tmp = tempfile::tempdir().unwrap();
        let proc_root = tmp.path().join("proc");
        let cgroup_root = tmp.path().join("cgroup");
        write_rel(&proc_root, "self/cgroup", "0::/docker/deadbeefcafe\n");
        write_rel(&cgroup_root, "memory.current", "268435456\n");
        write_rel(&cgroup_root, "memory.max", "536870912\n");
        write_rel(&cgroup_root, "pids.max", "256\n");
        write_rel(&cgroup_root, "pids.current", "10\n");
        assert_eq!(
            readers::read_cgroup_memory(&cgroup_root, &proc_root),
            Some(readers::CgroupMemory {
                limit_bytes: Some(536870912),
                current_bytes: 268435456,
            })
        );
        assert_eq!(readers::read_pids_limit(&proc_root, &cgroup_root), Some(256));
        assert_eq!(
            readers::read_pids_constraint(&proc_root, &cgroup_root),
            Some(readers::PidsConstraint { current: 10, max: 256 })
        );

        // '../'-relative membership (cgroup_namespaces(7): out-of-namespace):
        // a sibling dir ABOVE the injected root carries different limits; the
        // resolver must bind the namespace root, never the escape.
        let tmp = tempfile::tempdir().unwrap();
        let proc_root = tmp.path().join("proc");
        let cgroup_root = tmp.path().join("cgroup");
        let escape = tmp.path().join("escape");
        write_rel(&proc_root, "self/cgroup", "0::/../escape\n");
        write_rel(&cgroup_root, "memory.current", "1073741824\n");
        write_rel(&cgroup_root, "memory.max", "4294967296\n");
        write_rel(&cgroup_root, "pids.max", "512\n");
        write_rel(&cgroup_root, "pids.current", "400\n");
        write_rel(&escape, "memory.current", "1\n");
        write_rel(&escape, "memory.max", "2\n");
        write_rel(&escape, "pids.max", "999\n");
        write_rel(&escape, "pids.current", "1\n");
        assert_eq!(
            readers::read_cgroup_memory(&cgroup_root, &proc_root),
            Some(readers::CgroupMemory {
                limit_bytes: Some(4294967296),
                current_bytes: 1073741824,
            })
        );
        assert_eq!(
            readers::read_pids_constraint(&proc_root, &cgroup_root),
            Some(readers::PidsConstraint {
                current: 400,
                max: 512,
            })
        );
    }
```

Also refresh the two stale comments that assert the old contract (the
behavior stays, the stated reason changes):
- Lines 1627–1630: replace the comment with *"The fs-root fallback still
  finds nothing: a cgroup root that lacks the leaf tree AND has no top-level
  limit files yields None."* (assertion unchanged).
- Lines 1709–1715: replace the comment with *"'0::/' (namespace root) reads
  the fs root; the committed cgroup tree has no top-level pids files, so no
  node qualifies."* (assertion unchanged).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-server host_stats_cgroup_v2_namespace_root_reads`

Expected: FAIL because `resolve_cgroup_leaf` returns `None` for `0::/` today
(first assertion block: `read_cgroup_memory` returns `None` instead of the
`Some(...)` root values; the last, `../`-relative block also fails today —
the old resolver returns the `../escape` leaf and binds the sibling dir's
`2`/`{1, 999}` values).

- [ ] **Step 3: Add the minimal production implementation**

In `crates/freshell-platform/src/host_stats_readers.rs`:

1. Rewrite the `resolve_cgroup_leaf` doc + signature + v2 arm (lines 82–103):

```rust
/// Resolve THIS process's cgroup leaf from `<proc_root>/self/cgroup`.
///
/// cgroup v2 namespace contract: a PRIVATE cgroup namespace (Docker's
/// default on cgroup-v2 hosts) rewrites this process's v2 membership to
/// `0::/`, and the namespace-visible cgroupfs mount exposes the container's
/// OWN cgroup at the filesystem root — its memory.current/memory.max/
/// pids.max live AT `<cgroup_root>` itself. Those limit files only exist at
/// the root of a namespace-rooted mount: the REAL cgroup2 root of a
/// non-namespaced host has none of them, so reading at the fs root degrades
/// to the same `None` fallback as before there. Three v2 shapes therefore
/// resolve to the fs root (empty path): membership `0::/`, a membership path
/// that does not exist under `<cgroup_root>`, and a `../`-relative membership
/// (out-of-namespace per `cgroup_namespaces(7)` — reads at the closest
/// visible ancestor, never above `<cgroup_root>`). cgroup v1 is unchanged:
/// v1 has no namespace membership rewrite and the v1 fs root DOES carry
/// (garbage-sentinel) limit files, so v1 never reads the fs root.
enum CgroupLeaf {
    V1(String),
    /// The path may be empty: the cgroup-namespace-visible fs root.
    V2(String),
}

fn resolve_cgroup_leaf(
    proc_root: &Path,
    v1_controller: &str,
    cgroup_root: &Path,
) -> Option<CgroupLeaf> {
    let text = safe_read(&proc_root.join("self").join("cgroup"))?;
    let lines: Vec<&str> = non_empty_lines(&text).collect();
    // v2 unified hierarchy: a single "0::/path" line.
    for line in &lines {
        if let Some(rest) = line.strip_prefix("0::") {
            let leaf = rest.trim_start_matches('/');
            // '' is a cgroup-namespace root; a membership path absent from
            // the mounted cgroupfs is the same namespace shape seen through
            // /proc; a '../'-relative membership (out-of-namespace) must
            // never resolve ABOVE the injected root. All three read at the
            // fs root — the closest visible ancestor; on a real
            // non-namespaced host the root has no limit files, so the
            // readers' None fallbacks fire exactly as before.
            if leaf.is_empty()
                || leaf.split('/').any(|segment| segment == "..")
                || !cgroup_root.join(leaf).is_dir()
            {
                return Some(CgroupLeaf::V2(String::new()));
            }
            return Some(CgroupLeaf::V2(leaf.to_string()));
        }
    }
    // v1: "<hierarchy>:<controller[,controller...]>:/path"
    for line in lines {
        let parts: Vec<&str> = line.split(':').collect();
        if parts.len() != 3 {
            continue;
        }
        if !parts[1].split(',').any(|c| c == v1_controller) {
            continue;
        }
        let leaf = parts[2].trim_start_matches('/');
        if leaf.is_empty() {
            return None;
        }
        return Some(CgroupLeaf::V1(leaf.to_string()));
    }
    None
}
```

2. `read_cgroup_memory` (line 290): change the resolver call to
   `let leaf = resolve_cgroup_leaf(proc_root, "memory", cgroup_root)?;` —
   `cgroup_root.join(leaf)` with an empty leaf already yields the root
   itself, so the V2 arm body is otherwise unchanged; replace the stale doc
   sentence at lines 282–284 ('The cgroup fs root has NO limit files by
   design... the fs root is never read.') with: *"A v2 membership of `0::/`
   (cgroup-namespace root, Docker's default) or one whose path is not mounted
   resolves to the cgroupfs fs root itself; on a non-namespaced host that
   root has no limit files, so `None` falls through as before."*

3. `read_pids_limit` (line 679): change the resolver call to
   `resolve_cgroup_leaf(proc_root, "pids", cgroup_root)`. The `dir`
   computation is unchanged (`cgroup_root.join("")` is the fs root).

4. `read_pids_constraint`: replace the stale doc at lines 718–719 and the
   line-726 comment (per the walk comment in the block below), and replace the
   function body from the resolver call (line 725) through the end of the
   function (the closing brace at line 763) in full with:

```rust
    let leaf = resolve_cgroup_leaf(proc_root, "pids", cgroup_root)?;
    // Deepest-first chain. For v2 the chain INCLUDES the fs-root node (depth
    // 0 -> empty node path -> `<cgroup_root>` itself): under a private cgroup
    // namespace that root IS the container's cgroup (with limit files); on a
    // non-namespaced host the root carries no pids files and the depth-0
    // node is simply skipped. The v1 walk is unchanged (v1 has no namespace
    // membership rewrite).
    let segments: Vec<&str> = match &leaf {
        CgroupLeaf::V2(path) | CgroupLeaf::V1(path) => path
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect(),
    };
    let mut best: Option<PidsConstraint> = None;
    let mut best_ratio = -1.0_f64;
    let min_depth = match &leaf {
        CgroupLeaf::V2(_) => 0,
        CgroupLeaf::V1(_) => 1,
    };
    for depth in (min_depth..=segments.len()).rev() {
        let node_path = segments[..depth].join("/");
        let dir = match &leaf {
            CgroupLeaf::V2(_) => cgroup_root.join(&node_path),
            CgroupLeaf::V1(_) => cgroup_root.join("pids").join(&node_path),
        };
        let Some(max_text) = safe_read(&dir.join("pids.max")) else {
            continue;
        };
        let Some(max) = parse_cgroup_limit(&max_text) else {
            continue; // 'max'/garbage: unlimited, not binding
        };
        if max == 0 {
            continue; // matches read_pids_limit's limit > 0 convention
        }
        let Some(current_text) = safe_read(&dir.join("pids.current")) else {
            continue; // no readable same-node pair
        };
        let Ok(current) = current_text.trim().parse::<u64>() else {
            continue;
        };
        let ratio = current as f64 / max as f64;
        if ratio > best_ratio {
            best_ratio = ratio;
            best = Some(PidsConstraint { current, max });
        }
    }
    best
}
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-server host_stats_cgroup_v2_namespace_root_reads && cargo test -p freshell-platform`

Expected: PASS (new test green; the freshell-platform crate's own `#[cfg(test)]` module still green).

- [ ] **Step 5: Refactor while green**

Confirm comment/code parity (no remaining "fs root has NO limit files by
design" claims in the touched files), that the `min_depth` split is the only
v1/v2 divergence, and run `cargo fmt -p freshell-platform` if the edit
disturbed formatting (the QA gate runs `cargo fmt --all --check`).

- [ ] **Step 6: Run impacted-test verification**

Impacted surface: `read_cgroup_memory` / `read_pids_limit` /
`read_pids_constraint` are consumed by `freshell-server`'s collector
(`crates/freshell-server/src/host_stats.rs` lines 428, 672–677) and by the
fixture tests in that file.

Run: `cargo test -p freshell-server host_stats && cargo test -p freshell-platform`

Expected: PASS (the whole host_stats test module plus the platform crate).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-platform/src/host_stats_readers.rs crates/freshell-server/src/host_stats.rs
git commit -m "fix(host-stats): mirror cgroup-namespace root resolution in the Rust readers"
```

---

## Endgame (execution-stage machinery)

After both tasks: whole-branch review, then the full QA gate via the
Darkforge-recorded command `darkforge qa --repo '/home/dan/code/freshell'
--id '6rbc'` (which runs `/home/dan/.local/share/darkforge/sources/
freshell-qa.sh`: `npm run check` + cargo fmt --check + clippy). The baseline
ledger carries three pre-existing `codex-adapter.test.ts` failures; the gate
is accepted on a zero exit or a nonzero exit whose parsed failure identities
are exactly those three.
