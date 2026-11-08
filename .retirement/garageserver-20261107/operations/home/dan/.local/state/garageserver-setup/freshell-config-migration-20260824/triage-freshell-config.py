#!/usr/bin/env python3
"""Build a garageserver-safe Freshell config from a source-machine config."""

from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
from datetime import datetime, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen


STATE_DIR = Path("/home/dan/.local/state/garageserver-setup/freshell-config-migration-20260824")
SOURCE_PATH = STATE_DIR / "config.source.json"
TARGET_PATH = Path("/home/dan/.freshell/config.json")
ENV_PATH = Path("/home/dan/code/freshell/.env")
OUTPUT_PATH = STATE_DIR / "config.triaged.json"
REPORT_PATH = STATE_DIR / "triage.jsonl"
SUMMARY_PATH = STATE_DIR / "triage-summary.json"
BASE_URL = "http://127.0.0.1:3001"

SESSION_FIELDS = {
    "archived",
    "createdAtOverride",
    "deleted",
    "titleOverride",
    "titleSource",
}
TERMINAL_FIELDS = {
    "deleted",
    "descriptionOverride",
    "titleOverride",
}
SENSITIVE_PARTS = ("key", "password", "secret", "token", "credential")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def write_record(handle, *, category: str, key: str, action: str, reason: str, fields=None) -> None:
    record = {
        "timestamp": utc_now(),
        "severity": "info",
        "event": "config_triage",
        "category": category,
        "key": key,
        "action": action,
        "reason": reason,
    }
    if fields is not None:
        record["fields"] = sorted(fields)
    handle.write(json.dumps(record, separators=(",", ":"), ensure_ascii=False) + "\n")


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def auth_token() -> str:
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        if line.startswith("AUTH_TOKEN="):
            token = line.partition("=")[2]
            if token:
                return token
    raise RuntimeError("active AUTH_TOKEN is missing")


def request_json(path: str, token: str):
    request = Request(BASE_URL + path, headers={"x-auth-token": token})
    with urlopen(request, timeout=20) as response:
        return json.load(response)


def live_session_keys(token: str) -> set[str]:
    result: set[str] = set()
    for priority in ("visible", "background"):
        cursor = None
        seen_cursors: set[str] = set()
        while True:
            query = {
                "priority": priority,
                "limit": "50",
                "includeSubagents": "1",
                "includeNonInteractive": "1",
                "includeEmpty": "1",
            }
            if cursor:
                query["cursor"] = cursor
            payload = request_json("/api/session-directory?" + urlencode(query), token)
            for item in payload.get("items", []):
                provider = item.get("provider")
                session_id = item.get("sessionId")
                if not isinstance(provider, str) or not isinstance(session_id, str):
                    continue
                canonical = session_id if session_id.startswith(provider + ":") else f"{provider}:{session_id}"
                result.add(canonical)
            cursor = payload.get("nextCursor")
            if not cursor:
                break
            if cursor in seen_cursors:
                raise RuntimeError(f"session-directory cursor repeated for {priority}")
            seen_cursors.add(cursor)
    return result


def live_terminal_ids(token: str) -> set[str]:
    payload = request_json("/api/terminals", token)
    return {
        item["terminalId"]
        for item in payload
        if isinstance(item, dict) and isinstance(item.get("terminalId"), str)
    }


def safe_override(key: str, value, allowed_fields: set[str]) -> tuple[bool, str]:
    if not isinstance(key, str) or not key:
        return False, "invalid_key"
    if not isinstance(value, dict):
        return False, "override_is_not_an_object"
    unknown = sorted(set(value).difference(allowed_fields))
    if unknown:
        return False, "unsupported_fields:" + ",".join(unknown)
    return True, "valid_shape"


def triage_overrides(
    source: dict,
    target: dict,
    live_ids: set[str],
    allowed_fields: set[str],
    category: str,
    report,
) -> tuple[dict, dict[str, int]]:
    kept: dict = {}
    counts = {"source_read": 0, "source_kept": 0, "source_removed": 0, "target_kept": 0}

    for key, value in source.items():
        counts["source_read"] += 1
        shape_ok, shape_reason = safe_override(key, value, allowed_fields)
        if not shape_ok:
            counts["source_removed"] += 1
            write_record(
                report,
                category=category,
                key=str(key),
                action="remove",
                reason=shape_reason,
                fields=value.keys() if isinstance(value, dict) else None,
            )
            continue
        if key not in live_ids:
            counts["source_removed"] += 1
            write_record(
                report,
                category=category,
                key=key,
                action="remove",
                reason="no_corresponding_garageserver_record",
                fields=value.keys(),
            )
            continue
        kept[key] = copy.deepcopy(value)
        counts["source_kept"] += 1
        write_record(
            report,
            category=category,
            key=key,
            action="keep",
            reason="corresponding_garageserver_record_exists",
            fields=value.keys(),
        )

    for key, value in target.items():
        shape_ok, _ = safe_override(key, value, allowed_fields)
        if shape_ok and key in live_ids and key not in kept:
            kept[key] = copy.deepcopy(value)
            counts["target_kept"] += 1

    return kept, counts


def iter_setting_leaves(value, prefix="settings"):
    if isinstance(value, dict):
        for key, nested in value.items():
            yield from iter_setting_leaves(nested, f"{prefix}.{key}")
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            yield from iter_setting_leaves(nested, f"{prefix}[{index}]")
    else:
        yield prefix, value


def main() -> int:
    os.umask(0o077)
    source = load_json(SOURCE_PATH)
    target = load_json(TARGET_PATH)
    token = auth_token()
    sessions = live_session_keys(token)
    terminals = live_terminal_ids(token)

    output = copy.deepcopy(source)
    settings = output.setdefault("settings", {})

    REPORT_PATH.unlink(missing_ok=True)
    with REPORT_PATH.open("a", encoding="utf-8") as report:
        for path, value in iter_setting_leaves(settings):
            sensitive = any(part in path.lower() for part in SENSITIVE_PARTS)
            reason = "portable_setting_secret_value_redacted" if sensitive else "portable_setting"
            write_record(report, category="setting", key=path, action="keep", reason=reason)

        network = settings.setdefault("network", {})
        old_host = network.get("host")
        network["configured"] = True
        network["host"] = "0.0.0.0"
        write_record(
            report,
            category="setting",
            key="settings.network.host",
            action="adapt",
            reason=f"LAN_service_bind_replaces:{old_host}",
        )

        logging = settings.setdefault("logging", {})
        old_debug = logging.get("debug")
        logging["debug"] = False
        write_record(
            report,
            category="setting",
            key="settings.logging.debug",
            action="adapt",
            reason=f"production_debug_logging_disabled_replaces:{old_debug}",
        )

        safety = settings.setdefault("safety", {})
        old_idle_minutes = safety.get("autoKillIdleMinutes")
        safety["autoKillIdleMinutes"] = 0
        write_record(
            report,
            category="setting",
            key="settings.safety.autoKillIdleMinutes",
            action="adapt",
            reason=f"detached_agent_idle_reaper_disabled_replaces:{old_idle_minutes}",
        )

        providers = settings.setdefault("codingCli", {}).setdefault("providers", {})
        for provider, provider_config in providers.items():
            if not isinstance(provider_config, dict):
                continue
            cwd = provider_config.get("cwd")
            if isinstance(cwd, str) and cwd and not Path(cwd).is_dir():
                provider_config["cwd"] = "/home/dan/code/freshell"
                write_record(
                    report,
                    category="setting",
                    key=f"settings.codingCli.providers.{provider}.cwd",
                    action="adapt",
                    reason=f"missing_directory_replaced:{cwd}",
                )

        existing_recent = []
        recent_seen = set()
        recent_read = 0
        recent_removed = 0
        for origin, directories in (
            ("source", source.get("recentDirectories", [])),
            ("target", target.get("recentDirectories", [])),
        ):
            for directory in directories:
                if origin == "source":
                    recent_read += 1
                if not isinstance(directory, str) or not Path(directory).is_dir():
                    if origin == "source":
                        recent_removed += 1
                        write_record(
                            report,
                            category="recent_directory",
                            key=str(directory),
                            action="remove",
                            reason="directory_missing_on_garageserver",
                        )
                    continue
                if directory not in recent_seen:
                    existing_recent.append(directory)
                    recent_seen.add(directory)
                if origin == "source":
                    write_record(
                        report,
                        category="recent_directory",
                        key=directory,
                        action="keep",
                        reason="directory_exists_on_garageserver",
                    )
        output["recentDirectories"] = existing_recent[:20]

        source_sessions = source.get("sessionOverrides", {})
        target_sessions = target.get("sessionOverrides", {})
        source_terminals = source.get("terminalOverrides", {})
        target_terminals = target.get("terminalOverrides", {})
        output["sessionOverrides"], session_counts = triage_overrides(
            source_sessions,
            target_sessions,
            sessions,
            SESSION_FIELDS,
            "session_override",
            report,
        )
        output["terminalOverrides"], terminal_counts = triage_overrides(
            source_terminals,
            target_terminals,
            terminals,
            TERMINAL_FIELDS,
            "terminal_override",
            report,
        )

        output["serverSecrets"] = copy.deepcopy(target.get("serverSecrets", {}))
        write_record(
            report,
            category="server_secret",
            key="serverSecrets",
            action="keep_target",
            reason="machine_identity_secret_must_not_migrate",
        )

        source_colors = source.get("projectColors", {})
        kept_colors = {}
        for project, color in source_colors.items():
            if Path(project).is_dir():
                kept_colors[project] = color
                action, reason = "keep", "project_directory_exists"
            else:
                action, reason = "remove", "project_directory_missing"
            write_record(
                report,
                category="project_color",
                key=project,
                action=action,
                reason=reason,
            )
        output["projectColors"] = kept_colors

    with OUTPUT_PATH.open("w", encoding="utf-8") as handle:
        json.dump(output, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    OUTPUT_PATH.chmod(0o600)
    REPORT_PATH.chmod(0o600)

    enabled = settings.get("codingCli", {}).get("enabledProviders", [])
    executable_path = os.pathsep.join(
        (
            "/home/dan/.local/bin",
            "/home/dan/.nvm/versions/node/v22.21.1/bin",
            os.environ.get("PATH", ""),
        )
    )
    provider_binaries = {
        provider: bool(shutil.which(provider, path=executable_path)) for provider in enabled
    }

    summary = {
        "timestamp": utc_now(),
        "source_sha256": hashlib.sha256(SOURCE_PATH.read_bytes()).hexdigest(),
        "output_sha256": hashlib.sha256(OUTPUT_PATH.read_bytes()).hexdigest(),
        "settings_leaf_count": sum(1 for _ in iter_setting_leaves(settings)),
        "session_overrides": session_counts,
        "terminal_overrides": terminal_counts,
        "live_session_count": len(sessions),
        "live_terminal_count": len(terminals),
        "recent_directories": {
            "source_read": recent_read,
            "kept": len(output["recentDirectories"]),
            "removed": recent_removed,
        },
        "project_colors_kept": len(output["projectColors"]),
        "server_secrets_source_migrated": False,
        "provider_binaries": provider_binaries,
        "network_host": settings["network"]["host"],
        "output_mode": oct(OUTPUT_PATH.stat().st_mode & 0o777),
    }
    with SUMMARY_PATH.open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2, sort_keys=True)
        handle.write("\n")
    SUMMARY_PATH.chmod(0o600)

    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
