# Perf / Log Investigation (running)

Date: 2026-02-01

## Log sources checked
- /mnt/c/Users/dan/.freshell (user config directory)
- /home/user/.freshell
- /mnt/c/Users/dan/AppData (including Temp)
- Repo worktree itself (.worktrees/perf-log-investiation)

## Findings

### 1) Orphaned config temp files under user config dir
Evidence
- Found 195 files matching /mnt/c/Users/dan/.freshell/config.json.tmp-*.
- Spot-checked a sample file; contents are full, valid JSON config snapshots.

Impact
- Disk/dir bloat in the user config directory.
- Indicates writes are leaving temp files behind, which can also signal abnormal shutdowns or file-lock issues that may correlate with errors/perf problems.

Root cause analysis (code)
- server/config-store.ts uses atomicWriteFile() which writes to config.json.tmp-<pid>-<ts> and then renames the temp file over config.json.
- Cleanup relies on fsp.rm(tmp, { force: true }) in finally.
- Orphaned temp files can happen if the process is terminated between write and cleanup, or if fs.rm fails due to Windows file locks (AV/backup indexing) and the error propagates.
- There is no startup cleanup routine to remove stale temp files.

Mitigation (this branch)
- Added startup sweep to remove stale config.json.tmp-* files older than 24 hours.

Code refs
- server/config-store.ts
  - atomicWriteFile() and renameWithRetry().

### 2) Stale test temp home directories in Windows Temp
Evidence
- Found .freshell directories under Windows Temp:
  - /mnt/c/Users/dan/AppData/Local/Temp/config-store-test-eajLTZ/.freshell
  - /mnt/c/Users/dan/AppData/Local/Temp/config-store-test-gKhyXi/.freshell
  - /mnt/c/Users/dan/AppData/Local/Temp/api-edge-cases-test-zVTVPn/.freshell
  - /mnt/c/Users/dan/AppData/Local/Temp/.freshell

Impact
- Low-level disk/dir bloat in Temp; may indicate tests or dev runs aborted before cleanup.

Root cause analysis (code)
- Several tests (e.g., test/unit/server/config-store.test.ts, test/integration/server/api-edge-cases.test.ts) create temp directories via mkdtemp(os.tmpdir(), ...) and set os.homedir() to those paths.
- Cleanup happens in afterEach with fsp.rm(..., { recursive: true, force: true }) but will be skipped if the test process is terminated early.
- There is no global cleanup or startup sweep to remove stale temp dirs.

Code refs
- test/unit/server/config-store.test.ts
- test/integration/server/api-edge-cases.test.ts
