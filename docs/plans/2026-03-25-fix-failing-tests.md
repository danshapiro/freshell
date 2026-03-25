# Fix 17 Failing Tests

## Root Causes

### 1. Coordinator endpoint/status tests (11 failures)
- macOS `os.tmpdir()` returns `/var/folders/...` (~48 bytes)
- Adding mkdtemp prefix + socket filename exceeds 90-byte unix socket cap
- **Fix**: Use `/tmp` directly as mkdtemp base with shorter prefix (e.g. `fce-`)

### 2. git-metadata worktree test (1 failure)
- macOS `/var` is a symlink to `/private/var`
- `resolveGitRepoRoot` returns realpath, test compares against symlink path
- **Fix**: Use `fs.realpathSync(tempDir)` in test setup

### 3. settings-api + config-store (2 failures)
- New `sidebar.autoGenerateTitles` field (default: `true`) added in settings
- New `codingCli.knownProviders` field (optional, undefined) added
- Tests' expected objects don't include these fields
- **Fix**: Update test expectations to include new fields

### 4. files-api WSL tests (2 failures)
- Tests try to simulate WSL on macOS by mocking `process.platform = 'linux'`
- `isWslEnvironment()` or path conversion fails despite mock
- **Fix**: Investigate the mock mechanism; likely needs to skip on non-Linux

### 5. component-edge-cases SettingsView tests (3 failures)
- SettingsView was redesigned with tabs (#191), default tab is "appearance"
- Tests look for defaultCwd input in "safety" tab without switching tabs
- **Fix**: Click the "Safety" tab before querying for the input

### 6. test-coordinator integration (1 failure)
- "running-undescribed" test: likely cascading from socket path issue
- **Fix**: Should resolve with fix #1
