# SentinelX agent on garageserver

This is the operator note for the SentinelX agent that runs coding-agent work on `garageserver`. It describes the layout after the 0.11.18 security update.

## Current layout

- The service is the enabled systemd user unit `sentinelx-agent.service`, running as the dedicated `sentinelx` user.
- The active code is `/home/sentinelx/sentinelx-update-0.11.18`.
- Persistent agent state is separate from versioned code in `/home/sentinelx/sentinelx-data`:
  - `config.yaml` — policy and logging configuration.
  - `identity.json` — enrollment identity; treat it as a secret.
  - `audit.jsonl` — the audit log.
  - `agent.log` — the configured file-log destination, if file logging is enabled.
- The previous 0.11.14 install is retained at `/home/sentinelx/sentinelx-retired-0.11.14` for emergency rollback. It is not an active service path and is restricted to `sentinelx`.
- The agent has no `/etc/sudoers.d/sentinelx` grant. The service uses `NoNewPrivileges=yes` and runs without root capabilities.

This host uses a custom user-level install. It does not use the installer's usual `/opt/sentinelx-cloud-core` and `/etc/sentinelx` paths. Do not rerun a `curl | bash` installer here without first reviewing the resulting layout and rollback plan.

## Safe checks

Run these as an operator with permission to inspect the `sentinelx` user:

```bash
sudo -u sentinelx env XDG_RUNTIME_DIR=/run/user/1001 \
  systemctl --user status sentinelx-agent.service --no-pager

sudo -u sentinelx env XDG_RUNTIME_DIR=/run/user/1001 \
  systemctl --user show sentinelx-agent.service \
  -p ActiveState -p SubState -p MainPID -p ExecStart -p NoNewPrivileges

sudo -l -U sentinelx
sudo ls -l /etc/sudoers.d/sentinelx

sudo -u sentinelx bash -c '
  cd /home/sentinelx/sentinelx-update-0.11.18 &&
  .venv/bin/sentinelx-cloud-core \
    --hub https://mcp.sentinelx.app \
    --identity /home/sentinelx/sentinelx-data/identity.json \
    --config /home/sentinelx/sentinelx-data/config.yaml \
    --verify-enrollment
'
```

The last command should report that enrollment is accepted. Do not print `identity.json` or include it in a ticket or chat transcript.

## Upgrade procedure

1. Stage the new release in a new versioned directory under `/home/sentinelx`, preserving `/home/sentinelx/sentinelx-data`.
2. Run the new binary's help and enrollment checks before changing the service.
3. Schedule the service stop. The unit uses `KillMode=control-group`, so stopping or restarting it also stops child processes owned by the agent.
4. Back up the current user unit and update its `ExecStart`, identity/config paths, audit path, and `NoNewPrivileges=yes`.
5. Run `systemctl --user daemon-reload`, start the service, and check its status, journal connection, enrollment, and process security fields.
6. Only after those checks succeed, move the prior code directory to a recoverable `sentinelx-retired-<version>` name. Keep it until the rollback window has expired.

Keep the state files at their stable paths across upgrades. If the YAML log path names a versioned code directory, update it to `/home/sentinelx/sentinelx-data/agent.log` before starting the new version.

## Rollback

The migration saved the pre-migration unit files in `/home/sentinelx/sentinelx-data/rollback`. For an emergency rollback to 0.11.14:

1. Stop `sentinelx-agent.service`.
2. Move `/home/sentinelx/sentinelx-retired-0.11.14` back to `/home/sentinelx/sentinelx`.
3. Restore `rollback/sentinelx-agent.service.pre-migration` to `/home/sentinelx/.config/systemd/user/sentinelx-agent.service`.
4. Ensure there is no active `sentinelx-agent.service.d` drop-in, reload the user manager, and start the service.
5. Re-run the enrollment and journal checks, then reapply the security update as soon as practical.

The rollback copy is intentionally retained instead of being deleted. The old release is not the preferred steady state because it predates the writable-path fix.

## Validation record

On 2026-09-09, the migration was checked as follows:

- The staged SentinelX test suite passed: 247 tests passed, with 7 warnings.
- The service was active and connected to `https://mcp.sentinelx.app` after starting from the new paths.
- Enrollment verification succeeded using the state in `/home/sentinelx/sentinelx-data`.
- The service process had `NoNewPrivs: 1`, zero effective capabilities, and UID/GID 1001.
- The copied identity and audit files matched the originals by SHA-256 before the originals were retired.
- Rootless Docker remained active and listed its running containers after the migration.
