"""Project an already selected ordinary provider into native CLI settings."""

import json
import os
from pathlib import Path
import sys


def reuse_native_secret_reference(provider):
    """Keep a matching native key stable when ordinary settings are refreshed."""
    from amplifier_app_cli.provider_config_utils import (
        KeyManager,
        _secret_config_field,
        _suggest_instance_env_var,
    )

    field = _secret_config_field(provider["module"])
    config = provider.get("config") or {}
    value = config.get(field["id"]) if field else None
    if not isinstance(value, str) or not value:
        return
    if value.startswith("${") and value.endswith("}"):
        return
    candidates = []
    instance = str(provider.get("id") or provider["module"])
    try:
        candidates.append(_suggest_instance_env_var(provider["module"], instance, set()))
    except ValueError:
        # Native normalization still decides whether a new name is available.
        pass
    if field.get("env_var"):
        candidates.append(field["env_var"])
    manager = KeyManager()
    if not manager.keys_file.exists():
        return
    # Use the pinned native store's lock and parsing convention. Environment
    # values can override loaded keys and cannot prove the persisted value.
    with manager._lock:
        stored = {}
        for line in manager.keys_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                name, saved = line.split("=", 1)
                stored[name.strip()] = saved.strip().strip('"').strip("'")
        for name in candidates:
            if stored.get(name) == value:
                config[field["id"]] = "${" + name + "}"
                return


def prepare(bundle):
    phase = "load_native_settings"
    try:
        import yaml
        from amplifier_app_cli.lib.settings import AppSettings
        from amplifier_app_cli.provider_sources import is_provider_module_installed

        settings = AppSettings()
        if settings.get_provider_overrides():
            return
        phase = "validate_bundle"
        if not bundle or any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for character in bundle):
            raise ValueError("selected Amplifier bundle is not a local bundle name")
        phase = "read_bundle"
        source = Path(os.environ["HOME"]) / ".amplifier" / "bundles" / (bundle + ".yaml")
        selected = yaml.safe_load(source.read_text())
        phase = "validate_providers"
        providers = selected.get("providers") if isinstance(selected, dict) else None
        if not isinstance(providers, list) or not providers:
            raise ValueError("selected Amplifier bundle has no explicit ordinary providers")
        for provider in providers:
            if not isinstance(provider, dict) or not isinstance(provider.get("module"), str) or not is_provider_module_installed(provider["module"]):
                raise ValueError("selected Amplifier provider is not installed")
        phase = "write_native_settings"
        for provider in providers:
            reuse_native_secret_reference(provider)
            settings.set_provider_override(provider)
        phase = "verify_native_settings"
        if settings.get_provider_overrides() != providers:
            raise ValueError("native Amplifier settings did not retain selected ordinary providers")
        sys.stderr.write(json.dumps({"severity":"info", "event":"amplifier.selected_profile.prepared", "bundle":bundle, "providerCount":len(providers)}) + "\n")
    except Exception as error:
        # Exception messages and tracebacks can contain configuration values.
        sys.stderr.write(json.dumps({"severity":"error", "event":"amplifier.selected_profile.failed", "phase":phase, "exception_type":type(error).__name__}) + "\n")
        raise SystemExit(1) from None


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.stderr.write(json.dumps({"severity":"error", "event":"amplifier.selected_profile.failed", "phase":"validate_bundle", "exception_type":"ValueError"}) + "\n")
        raise SystemExit(1)
    prepare(sys.argv[1])
