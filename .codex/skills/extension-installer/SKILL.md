---
name: extension-installer
description: "Install, create, or troubleshoot supported Freshell CLI extensions from GitHub repositories, local directories, or scratch. Use browser panes for independently run web applications; Freshell does not support client or server extension panes."
---

# Installing Freshell CLI Extensions

Freshell's Rust server supports CLI extensions that launch terminal tools. It
still validates historical `client` and `server` manifests for compatibility,
but it does not start their processes, proxy their traffic, or render extension
iframes. Do not create or present those categories as supported.

If the requested extension is a web application, run it independently and open
its reachable URL in a normal Freshell browser pane. If it is a static page,
serve it with an independent static-file server first.

## Before installing

- Inspect the project and its existing `freshell.json` before changing it.
- Build or install the CLI yourself. Freshell does not run package installation
  or build steps for extensions.
- Confirm the CLI command works on the host and determine whether it needs a
  fixed working directory or environment variables.
- Use an absolute symlink target. Freshell scans symlinked directories.
- Never restart the live Freshell server without the user's explicit approval.
  Installing files is safe; activating a new extension waits for the next
  approved restart.

## Supported manifest

Create `freshell.json` in the extension directory. The manifest schema is
strict: unknown keys or a category/config mismatch cause the extension to be
skipped with a server warning.

Required top-level fields:

| Field | Value |
|---|---|
| `name` | Non-empty unique identifier |
| `version` | Non-empty version string |
| `label` | Human-readable picker label |
| `description` | Short picker description |
| `category` | Must be `"cli"` |
| `cli` | Must be the only category config block |

Useful optional top-level fields:

| Field | Purpose |
|---|---|
| `icon` | Path relative to the extension directory |
| `picker.shortcut` | Picker shortcut letter |
| `picker.group` | Picker group, commonly `"agents"` or `"tools"` |

The `cli` block accepts:

| Field | Purpose |
|---|---|
| `command` | Required executable name or absolute path |
| `args` | Base argument array; defaults to `[]` |
| `env` | String-to-string environment additions |
| `envVar` | Environment variable that overrides `command` |
| `resumeArgs` | Resume argument template using `{{sessionId}}` |
| `createSessionArgs` | New-session argument template using `{{sessionId}}` |
| `modelArgs` | Model argument template using `{{model}}` |
| `sandboxArgs` | Sandbox argument template using `{{sandbox}}` |
| `permissionModeArgs` | Permission argument template using `{{permissionMode}}` |
| `permissionModeEnvVar` | Environment variable used for permission mode |
| `permissionModeValues` | Maps Freshell permission modes to environment values |
| `supportsPermissionMode` | Whether the picker exposes permission controls |
| `supportsModel` | Whether the picker exposes model controls |
| `supportsSandbox` | Whether the picker exposes sandbox controls |
| `terminalBehavior` | Optional renderer and scroll behavior overrides |

`terminalBehavior.preferredRenderer` currently accepts `"canvas"`.
`terminalBehavior.scrollInputPolicy` accepts `"native"` or
`"fallbackToCursorKeysWhenAltScreenMouseCapture"`.

Use the advanced capability fields only when the CLI actually implements the
corresponding arguments. The built-in manifests under `extensions/` are the
best current examples for coding agents.

## Minimal example

```json
{
  "name": "htop-pane",
  "version": "0.1.0",
  "label": "htop",
  "description": "System monitor in a terminal pane",
  "category": "cli",
  "cli": {
    "command": "htop"
  },
  "picker": {
    "shortcut": "H",
    "group": "tools"
  }
}
```

## Install from a repository or local directory

1. Clone or locate the project in a stable absolute path.
2. Install dependencies and build its executable artifacts when required.
3. Create or correct `freshell.json` using the supported CLI schema above.
4. Verify the configured command runs successfully from a normal terminal.
5. Link the extension directory:

   ```bash
   mkdir -p ~/.freshell/extensions
   ln -sfn /absolute/path/to/extension ~/.freshell/extensions/<name>
   ```

6. Confirm the link resolves with `readlink -f`.
7. Report that activation requires a Freshell restart. Restart only when the
   user has explicitly approved restarting the live server.
8. After an approved restart, inspect server logs, `GET /api/extensions`, and
   the New Tab picker. Launch the extension and verify its real terminal
   behavior.

Freshell scans `~/.freshell/extensions/`, then `.freshell/extensions/` relative
to the server working directory, then the built-in `extensions/` directory.
The first manifest with a duplicate name wins.

## Troubleshooting

- Missing from the picker: inspect startup warnings, confirm the symlink and
  command, and check that the provider is enabled in Settings → Coding CLI.
- Manifest rejected: remove unknown keys, require all five top-level identity
  fields, set `category` to `"cli"`, and keep exactly one `cli` block.
- Command unavailable: install/build it or set the configured `envVar` to its
  absolute executable path.
- Changed files have no effect: extensions are scanned only at server startup;
  wait for an approved restart.
- Existing `client` or `server` manifest: explain that it is historical and
  unavailable in the Rust runtime. For a web service, run it independently and
  open its URL in a browser pane.

## Completion checklist

- `freshell.json` is valid JSON and contains no unknown keys.
- `category` is `"cli"`, with one `cli` block and no `client` or `server` block.
- The executable and any referenced artifacts exist and run on this host.
- The symlink resolves to the intended stable directory.
- No live restart occurred without explicit user approval.
- After activation, logs are clean, the picker entry appears, and launching it
  exercises the configured CLI.
