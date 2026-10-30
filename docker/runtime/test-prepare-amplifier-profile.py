"""Physical tests: pinned SDK Python test-prepare-amplifier-profile.py -v.

Run in the offline SDK enclosure alongside the current helper, with writable
temporary storage and no operator HOME, credentials, or network.
"""

import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml
from amplifier_app_cli.lib.settings import AppSettings
from amplifier_app_cli.provider_config_utils import KeyManager


class SelectedProfileTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.home = Path(self.directory.name)
        self.profile = self.home / ".amplifier"
        (self.profile / "bundles").mkdir(parents=True)
        self.environment = dict(os.environ, HOME=str(self.home))
        self.helper = Path(__file__).with_name("prepare-amplifier-profile.py")
        self.provider = {
            "id": "lunaroute",
            "module": "provider-vllm",
            "config": {
                "api_key": "fictional-offline-placeholder",
                "default_model": "fixture-model",
                "base_url": "https://offline.invalid/v1",
                "priority": 1,
            },
        }
        self.original_environment = dict(os.environ)
        self.original_cwd = Path.cwd()
        os.environ["HOME"] = str(self.home)
        os.chdir(self.home)

    def tearDown(self):
        os.chdir(self.original_cwd)
        os.environ.clear()
        os.environ.update(self.original_environment)
        self.directory.cleanup()

    def republish(self, provider=None):
        self.selected = copy.deepcopy(provider or self.provider)
        self.bundle = self.profile / "bundles/default.yaml"
        self.bundle.write_text(yaml.safe_dump({"providers": [self.selected]}))
        self.settings = self.profile / "settings.yaml"
        self.settings.write_text(yaml.safe_dump({
            "bundle": {"active": "default"}, "fixture_preserved": True,
        }))

    def prepare(self, expected_exit=0):
        outcome = subprocess.run(
            [sys.executable, str(self.helper), "default"],
            cwd=self.home, env=self.environment, capture_output=True, text=True,
            timeout=30,
        )
        self.assertEqual(outcome.returncode, expected_exit, outcome.stderr)
        secret = self.provider["config"].get("api_key")
        if secret:
            self.assertNotIn(secret, outcome.stdout + outcome.stderr)
        return outcome

    def save_key(self, name, value):
        KeyManager().save_key(name, value)

    def assert_provider(self, reference):
        expected = copy.deepcopy(self.selected)
        expected["config"]["api_key"] = reference
        self.assertEqual(AppSettings().get_provider_overrides(), [expected])
        self.assertTrue(yaml.safe_load(self.settings.read_text())["fixture_preserved"])

    def test_republication_keeps_native_credential_and_refreshes_selected_model(self):
        for index in range(5):
            self.provider["config"]["default_model"] = f"fixture-model-{index}"
            self.republish()
            original_bundle = self.bundle.read_bytes()
            key_file = KeyManager().keys_file
            original_key = (key_file.stat().st_ino, key_file.read_bytes()) if key_file.exists() else None
            self.prepare()
            self.assert_provider("${VLLM_API_KEY}")
            self.assertEqual(KeyManager().stored_keys(), {"VLLM_API_KEY"})
            self.assertEqual(self.bundle.read_bytes(), original_bundle)
            if original_key:
                self.assertEqual((key_file.stat().st_ino, key_file.read_bytes()), original_key)

    def test_republication_reuses_selected_instance_and_preserves_other_key(self):
        self.save_key("VLLM_API_KEY", "fictional-other-instance")
        for _ in range(4):
            self.republish()
            self.prepare()
            self.assert_provider("${VLLM_LUNAROUTE_API_KEY}")
            self.assertEqual(KeyManager().stored_keys(), {
                "VLLM_API_KEY", "VLLM_LUNAROUTE_API_KEY",
            })
            self.assertIn(
                'VLLM_API_KEY="fictional-other-instance"',
                KeyManager().keys_file.read_text(),
            )

    def test_conflicting_native_keys_refuse_without_mutating_settings_or_keys(self):
        self.save_key("VLLM_API_KEY", "fictional-other-instance")
        self.save_key("VLLM_LUNAROUTE_API_KEY", "fictional-conflicting-instance")
        self.republish()
        keys_before = KeyManager().keys_file.read_bytes()
        settings_before = self.settings.read_bytes()
        outcome = self.prepare(expected_exit=1)
        event = json.loads(outcome.stderr)
        self.assertEqual(event["phase"], "write_native_settings")
        self.assertEqual(event["exception_type"], "ValueError")
        self.assertEqual(KeyManager().keys_file.read_bytes(), keys_before)
        self.assertEqual(self.settings.read_bytes(), settings_before)

    def test_explicit_placeholder_does_not_allocate_native_key(self):
        self.provider["config"]["api_key"] = "${EXPLICIT_FIXTURE_KEY}"
        self.republish()
        self.prepare()
        self.assert_provider("${EXPLICIT_FIXTURE_KEY}")
        self.assertFalse(KeyManager().keys_file.exists())

    def test_missing_secret_does_not_allocate_native_key(self):
        del self.provider["config"]["api_key"]
        self.republish()
        self.prepare()
        self.assertEqual(AppSettings().get_provider_overrides(), [self.selected])
        self.assertFalse(KeyManager().keys_file.exists())

    def test_provider_without_instance_id_reuses_only_matching_default(self):
        del self.provider["id"]
        self.save_key("VLLM_API_KEY", self.provider["config"]["api_key"])
        self.republish()
        self.prepare()
        self.assert_provider("${VLLM_API_KEY}")

    def test_rotated_literal_uses_native_instance_name_without_overwriting_old_key(self):
        self.republish()
        self.prepare()
        self.provider["config"]["api_key"] = "fictional-rotated-placeholder"
        for _ in range(4):
            self.republish()
            self.prepare()
            self.assert_provider("${VLLM_LUNAROUTE_API_KEY}")
        self.assertIn(
            'VLLM_API_KEY="fictional-offline-placeholder"',
            KeyManager().keys_file.read_text(),
        )

    def test_stored_value_comparison_does_not_trust_ambient_environment(self):
        self.save_key("VLLM_API_KEY", self.provider["config"]["api_key"])
        self.environment["VLLM_API_KEY"] = "fictional-ambient-different"
        self.republish()
        self.prepare()
        self.assert_provider("${VLLM_API_KEY}")

    def test_matching_ambient_value_cannot_reuse_conflicting_stored_default(self):
        self.save_key("VLLM_API_KEY", "fictional-other-instance")
        self.environment["VLLM_API_KEY"] = self.provider["config"]["api_key"]
        self.republish()
        self.prepare()
        self.assert_provider("${VLLM_LUNAROUTE_API_KEY}")
        self.assertIn(
            'VLLM_API_KEY="fictional-other-instance"',
            KeyManager().keys_file.read_text(),
        )

    def test_unrelated_matching_credential_cannot_replace_native_collision_refusal(self):
        self.save_key("VLLM_API_KEY", "fictional-other-instance")
        self.save_key("VLLM_LUNAROUTE_API_KEY", "fictional-conflicting-instance")
        self.save_key("UNRELATED_API_KEY", self.provider["config"]["api_key"])
        self.republish()
        keys_before = KeyManager().keys_file.read_bytes()
        self.prepare(expected_exit=1)
        self.assertEqual(KeyManager().keys_file.read_bytes(), keys_before)


if __name__ == "__main__":
    unittest.main()
