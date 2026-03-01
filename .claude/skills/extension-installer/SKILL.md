---
name: extension-installer
description: "Use when installing, creating, or setting up Freshell extensions — from GitHub repos, local directories, or from scratch as custom panes."
---

# Installing Freshell Extensions

## When to Use

Use this skill when a user wants to:
- Add a new pane type to Freshell (from GitHub, a local project, or from scratch)
- Create a custom extension (server, client, or CLI)
- Debug why an installed extension isn't showing up

Do NOT use for modifying built-in pane types (terminal, browser, picker, etc.).

## Critical Facts

> **Read this box before doing anything.** These are the non-obvious rules that cause silent failures.

1. **Extensions must be pre-built.** Freshell does NOT run `npm install`, `npm run build`, or any build step. The extension directory must contain ready-to-run artifacts before symlinking.

2. **Scan only on startup.** Extensions are discovered once when the server starts. After installing or changing an extension, Freshell must be restarted.

3. **`z.strictObject` rejects unknown keys.** The manifest schema uses strict validation. Any key not in the schema (typos, extra fields) causes the entire manifest to silently fail validation and the extension is skipped. Check server logs for warnings.

4. **Exactly one category config block.** The manifest must have exactly one of `client`, `server`, or `cli` — and it must match the `category` field. Having zero, two, or a mismatched block fails validation.

5. **Symlinks are the recommended dev pattern.** The scanner follows symlinks. Point `~/.freshell/extensions/<name>` at your project directory for development.

6. **Template interpolation in `server.env`.** Values support `{{port}}` (allocated port) and `{{varName}}` (contentSchema field defaults). Unresolved templates are left as-is.

7. **`~/` expands to homedir.** After template interpolation, env values starting with `~/` are expanded to the user's home directory.

8. **Two scan directories.** Freshell scans `~/.freshell/extensions/` (user-installed) and `.freshell/extensions/` (local dev, relative to cwd). First match wins for duplicate names.

## Category Decision Tree

| Extension needs... | Category | Required config block |
|---|---|---|
| Its own HTTP server process (Express, Flask, etc.) | `server` | `server: { command, ... }` |
| Just static HTML/JS/CSS served by Freshell | `client` | `client: { entry }` |
| A TUI/CLI tool running in a terminal | `cli` | `cli: { command, ... }` |

## Manifest Reference

All fields below are derived from the Zod schema in `server/extension-manifest.ts`. Use **only** these keys — any others cause silent rejection.

### Top-level fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Unique identifier, min 1 char |
| `version` | string | yes | Semver recommended, min 1 char |
| `label` | string | yes | Human-readable display name |
| `description` | string | yes | Short description for picker |
| `category` | `"client"` \| `"server"` \| `"cli"` | yes | Must match the config block |
| `icon` | string | no | Path to icon file (relative to extension dir) |
| `url` | string | no | URL path template for iframe src (server and client extensions). Supports `{{fieldName}}` interpolation from contentSchema. Defaults to `"/"` |
| `contentSchema` | object | no | Defines dynamic fields for pane props (see below) |
| `picker` | object | no | Picker UI config (see below) |
| `client` | object | conditional | Required when `category: "client"` |
| `server` | object | conditional | Required when `category: "server"` |
| `cli` | object | conditional | Required when `category: "cli"` |

### `contentSchema` fields

Each key in `contentSchema` maps to a field descriptor:

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `"string"` \| `"number"` \| `"boolean"` | yes | |
| `label` | string | yes | Display label |
| `required` | boolean | no | |
| `default` | string \| number \| boolean | no | **Must match the declared `type`** (e.g., `type: "string"` requires a string default) |

### `picker` fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `shortcut` | string | no | Keyboard shortcut letter in picker |
| `group` | string | no | Picker group name |

### `client` config

| Field | Type | Required | Notes |
|---|---|---|---|
| `entry` | string | yes | Path to HTML file (relative to extension dir), min 1 char |

### `server` config

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `command` | string | yes | — | Executable to run (e.g., `"node"`) |
| `args` | string[] | no | `[]` | Arguments to command |
| `env` | Record<string, string> | no | — | Environment variables; supports `{{port}}` and `{{varName}}` interpolation |
| `readyPattern` | string | no | — | Regex matched against stdout/stderr; server is "ready" when matched |
| `readyTimeout` | number (positive int) | no | `10000` | Milliseconds to wait for readyPattern before killing |
| `healthCheck` | string | no | — | Reserved for future use. Accepted by schema but not used at runtime yet. |
| `singleton` | boolean | no | `true` | Reserved for future use. Accepted by schema but not used at runtime yet (currently always one process per extension). |

### `cli` config

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `command` | string | yes | — | Executable to run |
| `args` | string[] | no | `[]` | Arguments to command |
| `env` | Record<string, string> | no | — | Environment variables |

### Copy-paste templates

**Server extension:**

```json
{
  "name": "my-server-ext",
  "version": "0.1.0",
  "label": "My Server Extension",
  "description": "Does a thing with a server",
  "category": "server",
  "server": {
    "command": "node",
    "args": ["dist/index.js"],
    "env": {
      "PORT": "{{port}}"
    },
    "readyPattern": "listening on"
  }
}
```

**Client extension:**

```json
{
  "name": "my-client-ext",
  "version": "0.1.0",
  "label": "My Client Extension",
  "description": "A static HTML pane",
  "category": "client",
  "client": {
    "entry": "index.html"
  }
}
```

**CLI extension:**

```json
{
  "name": "my-cli-ext",
  "version": "0.1.0",
  "label": "My CLI Extension",
  "description": "Wraps a TUI tool",
  "category": "cli",
  "cli": {
    "command": "htop"
  }
}
```

## Workflow: Install from GitHub/URL

1. **Clone the repo** to a local directory (e.g., `~/code/<name>`).
2. **Install dependencies** — `npm install` (or equivalent for the project's stack).
3. **Build** — `npm run build` (or equivalent). Verify build artifacts exist (e.g., `dist/`).
4. **Check for `freshell.json`** in the project root.
   - If missing, create one. Examine the project to determine:
     - **Category:** Does it start a server? → `server`. Static HTML? → `client`. CLI tool? → `cli`.
     - **Command:** What starts the server or CLI? (e.g., `node dist/index.js`)
     - **readyPattern:** What does the server print to stdout when ready? (e.g., `"listening on"`)
5. **Validate the manifest** mentally against the schema above — no extra keys, category block matches `category` field, required fields present.
6. **Symlink into extensions directory:**
   ```bash
   mkdir -p ~/.freshell/extensions
   ln -sf /absolute/path/to/extension ~/.freshell/extensions/<name>
   ```
   Use absolute paths — relative symlinks break when the working directory changes.
7. **Restart Freshell** for the extension to be discovered.
8. **Verify** — open the pane picker, confirm the extension appears, open it, confirm it works.

## Workflow: Install from Local Directory

1. **Check for `freshell.json`** — if missing, create one (see manifest reference above).
2. **Build if needed** — check if the project requires a build step and run it.
3. **Symlink:**
   ```bash
   mkdir -p ~/.freshell/extensions
   ln -sf /absolute/path/to/project ~/.freshell/extensions/<name>
   ```
4. **Restart Freshell.**
5. **Verify** in the pane picker.

## Workflow: Create from Scratch

### Minimal server extension

Create a directory with two files:

**`index.js`:**
```javascript
const http = require('http');
const port = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h1>Hello from my extension</h1>');
});
server.listen(port, () => console.log(`Listening on port ${port}`));
```

**`freshell.json`:**
```json
{
  "name": "hello-server",
  "version": "0.1.0",
  "label": "Hello Server",
  "description": "Minimal server extension example",
  "category": "server",
  "server": {
    "command": "node",
    "args": ["index.js"],
    "env": { "PORT": "{{port}}" },
    "readyPattern": "Listening on"
  }
}
```

No build step needed. Symlink and restart.

### Single-file client extension

Create a directory with two files:

**`index.html`:**
```html
<!DOCTYPE html>
<html>
<head><title>My Pane</title></head>
<body>
  <h1>Hello from a client extension</h1>
  <script>
    // Your pane logic here
  </script>
</body>
</html>
```

**`freshell.json`:**
```json
{
  "name": "hello-client",
  "version": "0.1.0",
  "label": "Hello Client",
  "description": "Minimal client extension example",
  "category": "client",
  "client": {
    "entry": "index.html"
  }
}
```

No build step, no dependencies. Symlink and restart.

### CLI wrapper

Just a manifest pointing at an existing binary. Single file:

**`freshell.json`:**
```json
{
  "name": "htop-pane",
  "version": "0.1.0",
  "label": "htop",
  "description": "System monitor in a pane",
  "category": "cli",
  "cli": {
    "command": "htop"
  }
}
```

Create a directory with just this file, symlink, and restart.

## Validation Checklist

Run through this before declaring an extension installed:

- [ ] `freshell.json` is valid JSON
- [ ] All 5 required top-level fields present (`name`, `version`, `label`, `description`, `category`)
- [ ] No unknown keys at any level (check typos — `readypattern` vs `readyPattern`)
- [ ] Exactly one category config block, matching `category` field
- [ ] `contentSchema` defaults match their declared `type` (string default for `type: "string"`, etc.)
- [ ] **Server:** build artifacts exist (e.g., `dist/`), command is executable, `readyPattern` matches actual stdout
- [ ] **Client:** `entry` file exists at the specified path
- [ ] **CLI:** command is on PATH or specified as absolute path
- [ ] Symlink resolves correctly (`ls -la ~/.freshell/extensions/<name>`)
- [ ] Freshell restarted after install
- [ ] Extension appears in pane picker
- [ ] Extension opens and functions correctly

## Common Mistakes

| Mistake | Symptom | Fix |
|---|---|---|
| Unknown key in manifest (typo or extra field) | Extension silently not loaded. Warning in server logs. | Remove the key. Only use keys listed in the manifest reference. |
| Multiple category config blocks | Validation fails, extension skipped | Remove extra blocks — only one of `client`/`server`/`cli` allowed |
| Category block doesn't match `category` field | Validation fails | e.g., `"category": "server"` requires a `"server": {...}` block, not `"client"` |
| Build artifacts missing | Server extension fails to start (command can't find entry file) | Run the project's build step before symlinking |
| Relative symlink path | Symlink breaks when Freshell's cwd differs | Always use `ln -sf /absolute/path` |
| Missing PORT in server env | Server binds to wrong port; Freshell can't reach it | Add `"PORT": "{{port}}"` to `server.env` |
| `readyTimeout` too low | Extension killed before it finishes starting | Increase `readyTimeout` (default is 10000ms) |
| `contentSchema` default type mismatch | Validation fails (e.g., number default for `type: "string"`) | Ensure `typeof default === type` |
| Expecting hot-reload after changes | Changes not picked up | Restart Freshell — extensions are scanned once at startup |
| Duplicate extension name | Second extension silently skipped (first wins) | Use unique names across all extension directories |

## Real-World Example: kilroy-run-pane

For reference, here's the manifest from the kilroy-run-pane extension (a server extension with contentSchema, url interpolation, and picker config):

```json
{
  "name": "kilroy-run-pane",
  "version": "0.1.0",
  "label": "Kilroy Run Viewer",
  "description": "View Kilroy pipeline runs with DAG visualization and stage execution details",
  "category": "server",
  "server": {
    "command": "node",
    "args": ["dist-server/index.js"],
    "env": {
      "PORT": "{{port}}",
      "KILROY_RUNS_DIR": "{{runsDir}}"
    },
    "readyPattern": "Listening on",
    "readyTimeout": 10000,
    "healthCheck": "/api/health",
    "singleton": true
  },
  "url": "/run/{{runId}}",
  "contentSchema": {
    "runId": {
      "type": "string",
      "label": "Run ID",
      "required": false
    },
    "runsDir": {
      "type": "string",
      "label": "Runs directory",
      "default": "~/.local/state/kilroy/attractor/runs"
    }
  },
  "picker": {
    "shortcut": "R",
    "group": "tools"
  }
}
```

Note how `{{runsDir}}` in `server.env` is interpolated from the `runsDir` contentSchema default, and the `~/` prefix in that default is expanded to the user's home directory at runtime.
