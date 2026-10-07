"""Project an already selected ordinary provider into native CLI settings."""

import json
import os
from pathlib import Path
import sys

import yaml
from amplifier_app_cli.lib.settings import AppSettings
from amplifier_app_cli.provider_sources import is_provider_module_installed


def prepare(bundle):
    settings = AppSettings()
    if settings.get_provider_overrides():
        return
    if not bundle or any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for character in bundle):
        raise ValueError("selected Amplifier bundle is not a local bundle name")
    source = Path(os.environ["HOME"]) / ".amplifier" / "bundles" / (bundle + ".yaml")
    selected = yaml.safe_load(source.read_text())
    providers = selected.get("providers") if isinstance(selected, dict) else None
    if not isinstance(providers, list) or not providers:
        raise ValueError("selected Amplifier bundle has no explicit ordinary providers")
    for provider in providers:
        if not isinstance(provider, dict) or not isinstance(provider.get("module"), str) or not is_provider_module_installed(provider["module"]):
            raise ValueError("selected Amplifier provider is not installed")
    for provider in providers:
        settings.set_provider_override(provider)
    if settings.get_provider_overrides() != providers:
        raise ValueError("native Amplifier settings did not retain selected ordinary providers")
    sys.stderr.write(json.dumps({"severity":"info", "event":"amplifier.selected_profile.prepared", "bundle":bundle, "providerCount":len(providers)}) + "\n")


if len(sys.argv) != 2:
    raise ValueError("one selected Amplifier bundle is required")
prepare(sys.argv[1])
