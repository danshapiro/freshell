use freshell_platform::provider_native_auth::validate_native_auth;
use freshell_runtime_protocol::{ProviderSecretProfile, ProviderSecretReference};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

const MAX_KEYS_BYTES: u64 = 128 * 1024;
const CERTIFICATE_CHILD_NAMES: &[&str] = &[
    "CURL_CA_BUNDLE",
    "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
    "SSL_CERT_FILE",
];

#[derive(Default)]
pub struct ResolvedProviderSecrets {
    pub claude_settings_argument: Option<String>,
    pub opencode_plan: Option<freshell_platform::opencode_config::OpencodeConfigPlan>,
    pub environment: BTreeMap<String, String>,
    pub provider_files: Vec<(&'static str, Vec<u8>)>,
    pub configuration_files: Vec<(String, std::path::PathBuf)>,
}

pub fn resolve_child_secrets(
    provider: &str,
    references: &[ProviderSecretReference],
    mount_root: &Path,
) -> Result<ResolvedProviderSecrets, String> {
    freshell_runtime_protocol::validate_provider_secrets(provider, references)
        .map_err(|error| error.message)?;
    let mut resolved = ResolvedProviderSecrets::default();
    let mut configuration_bytes = 0u64;
    let mut environment_grants = Vec::new();
    let mut native_auth = false;
    let mut oauth_providers = BTreeSet::new();
    let mut mounted_ca = false;
    let mut seen = std::collections::BTreeSet::new();
    for (index, reference) in references.iter().enumerate() {
        if reference.profile.provider() != provider {
            return Err("OneCLI profile belongs to another provider".into());
        }
        let mount = mount_root.join(format!("provider-{index}"));
        if reference.profile.is_configuration_file() {
            let metadata = fs::symlink_metadata(&mount)
                .map_err(|_| "configuration-file grant is unavailable")?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() > 16 * 1024 * 1024
            {
                return Err(
                    "configuration-file grant must be a bounded regular file (16 MiB)".into(),
                );
            }
            configuration_bytes = configuration_bytes
                .checked_add(metadata.len())
                .ok_or("configuration-file grant size overflow")?;
            if configuration_bytes > 32 * 1024 * 1024 {
                return Err("configuration-file grants exceed 32 MiB aggregate limit".into());
            }
            resolved.configuration_files.push((
                reference
                    .provider_relative_path
                    .clone()
                    .ok_or("configuration-file grant destination missing")?,
                mount,
            ));
            continue;
        }
        let metadata = fs::symlink_metadata(&mount)
            .map_err(|error| format!("OneCLI grant is unavailable: {error}"))?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > MAX_KEYS_BYTES
        {
            return Err("OneCLI grant must be a bounded regular file".into());
        }
        use std::io::Read;
        let mut raw = Vec::new();
        fs::File::open(&mount)
            .map_err(|_| "OneCLI grant is unavailable")?
            .take(MAX_KEYS_BYTES + 1)
            .read_to_end(&mut raw)
            .map_err(|_| "read OneCLI grant failed")?;
        if raw.len() > MAX_KEYS_BYTES as usize {
            return Err("OneCLI grant exceeds 128 KiB".into());
        }
        if let Some(relative) = reference.profile.provider_file_relative_path() {
            if raw.is_empty() || !seen.insert(relative) {
                return Err("OneCLI provider-file grant is empty or duplicated".into());
            }
            if reference.profile.auth_relative_path().is_some() {
                oauth_providers = validate_native_auth(provider, &raw)?;
                native_auth = true;
            } else {
                mounted_ca = true;
            }
            resolved.provider_files.push((relative, raw));
        } else {
            environment_grants.push((reference.profile, raw));
        }
    }
    for (profile, raw) in environment_grants {
        let text =
            std::str::from_utf8(&raw).map_err(|_| "OneCLI environment grant is not UTF-8")?;
        for (name, value) in resolve_profile_with_native_auth(profile, text, native_auth)? {
            if resolved.environment.insert(name, value).is_some() {
                return Err("OneCLI grants set the same child environment key".into());
            }
        }
    }
    let conflict = match provider {
        "codex" | "opencode" => {
            oauth_providers.contains("openai")
                && resolved.environment.contains_key("OPENAI_API_KEY")
        }
        "claude" => {
            oauth_providers.contains("anthropic")
                && resolved.environment.contains_key("ANTHROPIC_API_KEY")
        }
        _ => false,
    };
    if conflict {
        return Err("OneCLI native OAuth conflicts with environment API-key auth mode".into());
    }
    if resolved.environment.contains_key("ANTHROPIC_API_KEY")
        && resolved.environment.contains_key("CLAUDE_CODE_OAUTH_TOKEN")
    {
        return Err("OneCLI Claude environment auth modes conflict".into());
    }
    const NATIVE_CA: &str = "/home/freshell/provider/.config/onecli/gateway-ca.pem";
    for name in CERTIFICATE_CHILD_NAMES {
        if let Some(value) = resolved.environment.get(*name) {
            if !mounted_ca || value != NATIVE_CA {
                return Err("OneCLI native trust path has no exact typed CA mount".into());
            }
        }
    }
    if mounted_ca {
        let names: &[&str] = match provider {
            "claude" | "opencode" => &["NODE_EXTRA_CA_CERTS"],
            "codex" => &["SSL_CERT_FILE"],
            "amplifier" => &["SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"],
            _ => return Err("unsupported OneCLI CA provider".into()),
        };
        for name in names {
            resolved
                .environment
                .insert((*name).into(), NATIVE_CA.into());
        }
    }
    Ok(resolved)
}

fn environment_profile(
    profile: ProviderSecretProfile,
) -> Result<freshell_platform::provider_environment_grants::EnvironmentProfile, String> {
    use freshell_platform::provider_environment_grants::EnvironmentProfile;
    match profile {
        ProviderSecretProfile::ClaudeOnecliEnvironment => Ok(EnvironmentProfile::Claude),
        ProviderSecretProfile::CodexOnecliEnvironment => Ok(EnvironmentProfile::Codex),
        ProviderSecretProfile::OpencodeOnecliEnvironment => Ok(EnvironmentProfile::Opencode),
        ProviderSecretProfile::AmplifierOnecliEnvironment => Ok(EnvironmentProfile::Amplifier),
        ProviderSecretProfile::AmplifierOnecliLunarouteGlm53 => Ok(EnvironmentProfile::AmplifierLunarouteGlm53),
        ProviderSecretProfile::LegacyAmplifierOnecliAnthropicHaikuLow => Err("legacy Amplifier Anthropic/Haiku secret profile is no longer supported; recreate the managed runtime with the approved OneCLI/LunaRoute profile".into()),
        _ => Err("OneCLI auth-file grant cannot be parsed as an environment profile".into()),
    }
}

#[cfg(test)]
fn resolve_profile(
    profile: ProviderSecretProfile,
    raw: &str,
) -> Result<BTreeMap<String, String>, String> {
    resolve_profile_with_native_auth(profile, raw, false)
}

fn resolve_profile_with_native_auth(
    profile: ProviderSecretProfile,
    raw: &str,
    native_auth: bool,
) -> Result<BTreeMap<String, String>, String> {
    freshell_platform::provider_environment_grants::resolve_environment_profile_with_native_auth(
        environment_profile(profile)?,
        raw,
        native_auth,
    )
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_runtime_protocol::ProviderSecretReference;

    fn resolve_native_fixture(
        provider: &str,
        profiles: [ProviderSecretProfile; 2],
        auth: &serde_json::Value,
        environment: &str,
    ) -> Result<ResolvedProviderSecrets, String> {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("provider-0"), auth.to_string()).unwrap();
        fs::write(root.path().join("provider-1"), environment).unwrap();
        let references = profiles.map(|profile| ProviderSecretReference {
            source_path: "/private/typed-native-fixture".into(),
            profile,
            provider_relative_path: None,
        });
        resolve_child_secrets(provider, &references, root.path())
    }

    fn resolve_codex_fixture(
        auth: &serde_json::Value,
        environment: &str,
    ) -> Result<ResolvedProviderSecrets, String> {
        resolve_native_fixture(
            "codex",
            [
                ProviderSecretProfile::CodexOnecliAuthFile,
                ProviderSecretProfile::CodexOnecliEnvironment,
            ],
            auth,
            environment,
        )
    }

    fn codex_oauth_fixture() -> serde_json::Value {
        serde_json::json!({
            "last_refresh":"2099-01-01T00:00:00Z",
            "tokens": {
                "id_token":"e30.eyJlbWFpbCI6ImZpeHR1cmVAZXhhbXBsZS50ZXN0In0.signature",
                "access_token":"e30.eyJleHAiOjQxMDI0NDQ4MDB9.signature",
                "refresh_token":"synthetic-refresh"
            }
        })
    }

    #[test]
    fn typed_codex_native_api_key_accepts_inferred_and_explicit_modes() {
        for mode in [None, Some(serde_json::Value::Null), Some("apikey".into())] {
            let mut auth = serde_json::json!({"OPENAI_API_KEY": "synthetic-native-key"});
            if let Some(mode) = mode {
                auth["auth_mode"] = mode;
            }
            let resolved = resolve_codex_fixture(&auth, "HTTPS_PROXY=http://192.0.2.10:10255\n")
                .expect("native API-key auth permits proxy-only transport");
            assert!(!resolved.environment.contains_key("OPENAI_API_KEY"));
            assert_eq!(
                resolved.provider_files,
                vec![(".codex/auth.json", auth.to_string().into_bytes())]
            );
        }
    }

    #[test]
    fn typed_codex_native_oauth_accepts_optional_mode_and_account_id() {
        for mode in [
            None,
            Some(serde_json::Value::Null),
            Some("chatgpt".into()),
            Some("chatgptAuthTokens".into()),
        ] {
            for null_account_id in [false, true] {
                let mut auth = codex_oauth_fixture();
                auth["tokens"]["refresh_token"] = "".into();
                if let Some(mode) = mode.clone() {
                    auth["auth_mode"] = mode;
                }
                if null_account_id {
                    auth["tokens"]["account_id"] = serde_json::Value::Null;
                }
                let resolved =
                    resolve_codex_fixture(&auth, "HTTPS_PROXY=http://192.0.2.10:10255\n")
                        .expect("native optional OAuth fields do not block launch");
                assert_eq!(resolved.provider_files[0].1, auth.to_string().into_bytes());
                let error = resolve_codex_fixture(&auth, "OPENAI_API_KEY=synthetic-conflict\n")
                    .err()
                    .expect("inferred and explicit OAuth both reject conflicting API-key mode");
                assert_eq!(
                    error,
                    "OneCLI native OAuth conflicts with environment API-key auth mode"
                );
            }
        }
    }

    #[test]
    fn typed_codex_native_oauth_rejects_missing_refresh_state_before_publication() {
        // Codex get_token_data requires last_refresh even when the access
        // token is unexpired. Deserializing optional metadata is insufficient.
        for mode in [None, Some("chatgpt"), Some("chatgptAuthTokens")] {
            for refresh in [None, Some(serde_json::Value::Null), Some("".into())] {
                let mut auth = codex_oauth_fixture();
                auth.as_object_mut().unwrap().remove("last_refresh");
                if let Some(mode) = mode {
                    auth["auth_mode"] = mode.into();
                }
                if let Some(refresh) = refresh {
                    auth["last_refresh"] = refresh;
                }
                let error = resolve_codex_fixture(&auth, "HTTPS_PROXY=http://192.0.2.10:10255\n")
                    .err()
                    .expect("a native grant without usable token state must not be published");
                assert_eq!(
                    error,
                    "OneCLI typed native auth has an unsupported provider shape"
                );
            }
        }
    }

    #[test]
    fn typed_codex_native_auth_rejects_invalid_and_conflicting_modes_without_secret_values() {
        let mut conflicting_modes = codex_oauth_fixture();
        conflicting_modes["auth_mode"] = "chatgpt".into();
        conflicting_modes["OPENAI_API_KEY"] = "synthetic-private-key".into();
        for auth in [
            serde_json::json!({"auth_mode": "unknown", "OPENAI_API_KEY": "synthetic-private-key"}),
            serde_json::json!({"auth_mode": "api_key", "OPENAI_API_KEY": "synthetic-private-key"}),
            serde_json::json!({"auth_mode": "apikey"}),
            serde_json::json!({"OPENAI_API_KEY": 42}),
            conflicting_modes,
            serde_json::json!({"tokens": {"access_token":"synthetic-access"}}),
            serde_json::json!({"auth_mode": 42, "OPENAI_API_KEY":"synthetic-private-key"}),
        ] {
            let error = resolve_codex_fixture(&auth, "HTTPS_PROXY=http://192.0.2.10:10255\n")
                .err()
                .expect("invalid native auth must fail before launch");
            assert_eq!(
                error,
                "OneCLI typed native auth has an unsupported provider shape"
            );
        }
    }

    #[test]
    fn typed_opencode_native_oauth_keeps_model_provider_identity() {
        for (oauth_provider, key, conflicts) in [
            ("anthropic", "OPENAI_API_KEY", false),
            ("openai", "ANTHROPIC_API_KEY", false),
            ("openai", "OPENROUTER_API_KEY", false),
            ("openrouter", "OPENAI_API_KEY", false),
            ("openai", "OPENAI_API_KEY", true),
            ("anthropic", "ANTHROPIC_API_KEY", false),
        ] {
            let auth = serde_json::json!({oauth_provider: {
                "type":"oauth", "access":"synthetic-access", "refresh":"synthetic-refresh", "expires":1790000000000_i64
            }});
            let result = resolve_native_fixture(
                "opencode",
                [
                    ProviderSecretProfile::OpencodeOnecliAuthFile,
                    ProviderSecretProfile::OpencodeOnecliEnvironment,
                ],
                &auth,
                &format!("{key}=synthetic-environment-key\n"),
            );
            if conflicts {
                assert_eq!(
                    result.err().expect("same-provider modes conflict"),
                    "OneCLI native OAuth conflicts with environment API-key auth mode"
                );
            } else {
                let resolved =
                    result.expect("different model providers can use separate auth modes");
                assert_eq!(
                    resolved.environment.get(key).map(String::as_str),
                    Some("synthetic-environment-key")
                );
                assert_eq!(
                    resolved.provider_files,
                    vec![(
                        ".local/share/opencode/auth.json",
                        auth.to_string().into_bytes()
                    )]
                );
            }
        }
    }

    #[test]
    fn typed_opencode_mixed_native_credentials_keep_each_oauth_provider() {
        let mut auth = serde_json::json!({
            "anthropic": {"type":"oauth", "access":"synthetic-access", "refresh":"synthetic-refresh", "expires":1790000000000_i64},
            "openai": {"type":"api", "key":"synthetic-native-key"}
        });
        let profiles = [
            ProviderSecretProfile::OpencodeOnecliAuthFile,
            ProviderSecretProfile::OpencodeOnecliEnvironment,
        ];
        let resolved = resolve_native_fixture(
            "opencode",
            profiles,
            &auth,
            "OPENAI_API_KEY=synthetic-environment-key\n",
        )
        .expect("an unrelated OAuth entry does not mask the native API-key entry");
        assert!(resolved.environment.contains_key("OPENAI_API_KEY"));
        auth["openai"] = serde_json::json!({"type":"oauth", "access":"synthetic-access", "refresh":"synthetic-refresh", "expires":1790000000000_i64});
        let error = resolve_native_fixture(
            "opencode",
            profiles,
            &auth,
            "OPENAI_API_KEY=synthetic-private-key\n",
        )
        .err()
        .expect("OpenAI retains its existing OAuth/API-key conflict check");
        assert_eq!(
            error,
            "OneCLI native OAuth conflicts with environment API-key auth mode"
        );
        let resolved = resolve_native_fixture(
            "opencode",
            profiles,
            &auth,
            "ANTHROPIC_API_KEY=synthetic-environment-key\n",
        )
        .expect("preserve OpenCode's existing Anthropic credential precedence");
        assert!(resolved.environment.contains_key("ANTHROPIC_API_KEY"));
    }

    #[test]
    fn configuration_file_grants_use_large_profile_without_expanding_payload_into_environment() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("provider-0"), vec![b'x'; 128 * 1024 + 1]).unwrap();
        let reference = ProviderSecretReference {
            source_path: "/synthetic/config-source".into(),
            profile: ProviderSecretProfile::OpencodeConfigurationFile,
            provider_relative_path: Some(".freshell/references/0".into()),
        };
        let resolved = resolve_child_secrets("opencode", &[reference], temp.path()).unwrap();
        assert!(resolved.environment.is_empty());
        assert!(resolved.provider_files.is_empty());
        assert_eq!(resolved.configuration_files.len(), 1);
        assert_eq!(resolved.configuration_files[0].0, ".freshell/references/0");
    }

    #[test]
    fn typed_codex_oauth_accepts_proxy_only_transport_without_changing_auth_mode() {
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join("provider-0"),
            "HTTPS_PROXY=http://agent:fixture@192.0.2.10:10255\n",
        )
        .unwrap();
        fs::write(root.path().join("provider-1"), r#"{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":"native-shaped-id","access_token":"fixture-access","refresh_token":"fixture-refresh","account_id":"fixture-account"},"last_refresh":"2026-10-06T00:00:00Z"}"#).unwrap();
        let references = [
            ProviderSecretProfile::CodexOnecliEnvironment,
            ProviderSecretProfile::CodexOnecliAuthFile,
        ]
        .into_iter()
        .enumerate()
        .map(|(index, profile)| ProviderSecretReference {
            source_path: root
                .path()
                .join(format!("provider-{index}"))
                .to_string_lossy()
                .into_owned(),
            profile,
            provider_relative_path: None,
        })
        .collect::<Vec<_>>();
        let resolved = resolve_child_secrets("codex", &references, root.path())
            .expect("typed native OAuth permits proxy-only transport");
        assert!(!resolved.environment.contains_key("OPENAI_API_KEY"));
        assert_eq!(resolved.provider_files[0].0, ".codex/auth.json");
        let native: serde_json::Value =
            serde_json::from_slice(&resolved.provider_files[0].1).unwrap();
        assert_eq!(native["auth_mode"], "chatgpt");
        fs::write(
            root.path().join("provider-0"),
            "OPENAI_API_KEY=conflicting-mode\nHTTPS_PROXY=http://192.0.2.10:10255\n",
        )
        .unwrap();
        assert!(resolve_child_secrets("codex", &references, root.path()).is_err());
    }

    #[test]
    fn proxy_only_transport_does_not_accept_malformed_native_auth_or_unmounted_ca() {
        let root = tempfile::tempdir().unwrap();
        let references = [
            ProviderSecretProfile::CodexOnecliEnvironment,
            ProviderSecretProfile::CodexOnecliAuthFile,
        ]
        .into_iter()
        .enumerate()
        .map(|(index, profile)| ProviderSecretReference {
            source_path: root
                .path()
                .join(format!("provider-{index}"))
                .to_string_lossy()
                .into_owned(),
            profile,
            provider_relative_path: None,
        })
        .collect::<Vec<_>>();
        fs::write(
            root.path().join("provider-0"),
            "HTTPS_PROXY=http://192.0.2.10:10255\n",
        )
        .unwrap();
        fs::write(
            root.path().join("provider-1"),
            r#"{"auth_mode":"chatgpt","tokens":{}}"#,
        )
        .unwrap();
        assert!(resolve_child_secrets("codex", &references, root.path()).is_err());
        fs::write(
            root.path().join("provider-0"),
            "OPENAI_API_KEY=fixture\nSSL_CERT_FILE=/unmounted/gateway.pem\n",
        )
        .unwrap();
        assert!(resolve_child_secrets("codex", &references[..1], root.path()).is_err());
    }

    #[test]
    fn provider_secret_profiles_accept_only_their_provider_and_keep_controls_out_of_child() {
        let cases = [
            (
                "claude",
                ProviderSecretProfile::ClaudeOnecliEnvironment,
                "ANTHROPIC_API_KEY=claude-fixture\n",
            ),
            (
                "codex",
                ProviderSecretProfile::CodexOnecliEnvironment,
                "OPENAI_API_KEY=codex-fixture\n",
            ),
            (
                "opencode",
                ProviderSecretProfile::OpencodeOnecliEnvironment,
                "OPENROUTER_API_KEY=opencode-fixture\n",
            ),
            (
                "amplifier",
                ProviderSecretProfile::AmplifierOnecliEnvironment,
                "OPENAI_API_KEY=amplifier-fixture\n",
            ),
        ];
        for (provider, profile, value) in cases {
            let root = tempfile::tempdir().unwrap();
            fs::write(
                root.path().join("provider-0"),
                format!("ONECLI_URL=http://127.0.0.1:10254\nNO_PROXY=localhost\n{value}"),
            )
            .unwrap();
            let references = [ProviderSecretReference {
                provider_relative_path: None,
                source_path: root
                    .path()
                    .join("provider-0")
                    .to_string_lossy()
                    .into_owned(),
                profile,
            }];
            let resolved = resolve_child_secrets(provider, &references, root.path()).unwrap();
            let allows_loopback_bypass = provider == "opencode";
            assert_eq!(
                resolved.environment.len(),
                if allows_loopback_bypass { 2 } else { 1 }
            );
            assert!(resolved
                .environment
                .values()
                .any(|value| value.ends_with("-fixture")));
            assert!(!resolved.environment.contains_key("ONECLI_URL"));
            assert_eq!(
                resolved.environment.get("NO_PROXY").map(String::as_str),
                allows_loopback_bypass.then_some("localhost")
            );
            assert!(resolve_child_secrets("wrong-provider", &references, root.path()).is_err());
        }
    }

    #[test]
    fn opencode_onecli_environment_forwards_the_authenticated_proxy_and_node_ca_settings() {
        let root = tempfile::tempdir().unwrap();
        let mount = root.path().join("provider-0");
        fs::write(
            &mount,
            concat!(
                "OPENAI_BASE_URL=https://api.openai.com/v1\n",
                "HTTPS_PROXY=http://agent:fixture@192.168.3.150:10255\n",
                "https_proxy=http://agent:fixture@192.168.3.150:10255\n",
                "HTTP_PROXY=http://agent:fixture@192.168.3.150:10255\n",
                "http_proxy=http://agent:fixture@192.168.3.150:10255\n",
                "NODE_EXTRA_CA_CERTS=/home/freshell/provider/.config/onecli/gateway-ca.pem\n",
                "NODE_USE_ENV_PROXY=1\n",
                "ONECLI_URL=http://127.0.0.1:10254\n",
                "NO_PROXY=localhost,127.0.0.1\n",
            ),
        )
        .unwrap();
        let reference = ProviderSecretReference {
            provider_relative_path: None,
            source_path: mount.to_string_lossy().into_owned(),
            profile: ProviderSecretProfile::OpencodeOnecliEnvironment,
        };

        fs::write(root.path().join("provider-1"), "fixture-ca").unwrap();
        let ca = ProviderSecretReference {
            source_path: root
                .path()
                .join("provider-1")
                .to_string_lossy()
                .into_owned(),
            profile: ProviderSecretProfile::OpencodeOnecliCaFile,
            provider_relative_path: None,
        };
        let resolved = resolve_child_secrets("opencode", &[reference, ca], root.path()).unwrap();

        assert_eq!(
            resolved.environment.get("OPENAI_BASE_URL").unwrap(),
            "https://api.openai.com/v1"
        );
        assert_eq!(
            resolved.environment.get("HTTPS_PROXY").unwrap(),
            "http://agent:fixture@192.168.3.150:10255"
        );
        assert_eq!(
            resolved.environment.get("https_proxy").unwrap(),
            "http://agent:fixture@192.168.3.150:10255"
        );
        assert_eq!(
            resolved.environment.get("HTTP_PROXY").unwrap(),
            "http://agent:fixture@192.168.3.150:10255"
        );
        assert_eq!(
            resolved.environment.get("http_proxy").unwrap(),
            "http://agent:fixture@192.168.3.150:10255"
        );
        assert_eq!(
            resolved.environment.get("NODE_EXTRA_CA_CERTS").unwrap(),
            "/home/freshell/provider/.config/onecli/gateway-ca.pem"
        );
        assert_eq!(resolved.environment.get("NODE_USE_ENV_PROXY").unwrap(), "1");
        assert!(!resolved.environment.contains_key("ONECLI_URL"));
        assert_eq!(
            resolved.environment.get("NO_PROXY").unwrap(),
            "localhost,127.0.0.1"
        );
    }

    #[test]
    fn non_opencode_onecli_profiles_do_not_enable_http_or_node_environment_proxies() {
        let cases = [
            (
                "claude",
                ProviderSecretProfile::ClaudeOnecliEnvironment,
                "ANTHROPIC_API_KEY=claude-fixture",
            ),
            (
                "codex",
                ProviderSecretProfile::CodexOnecliEnvironment,
                "OPENAI_API_KEY=codex-fixture",
            ),
            (
                "amplifier",
                ProviderSecretProfile::AmplifierOnecliEnvironment,
                "OPENAI_API_KEY=amplifier-fixture",
            ),
        ];

        for (provider, profile, provider_value) in cases {
            let root = tempfile::tempdir().unwrap();
            let mount = root.path().join("provider-0");
            fs::write(
                &mount,
                format!(
                    concat!(
                        "{provider_value}\n",
                        "HTTPS_PROXY=http://proxy.example:10255\n",
                        "https_proxy=http://proxy.example:10255\n",
                        "HTTP_PROXY=http://proxy.example:10255\n",
                        "http_proxy=http://proxy.example:10255\n",
                        "NODE_USE_ENV_PROXY=1\n"
                    ),
                    provider_value = provider_value
                ),
            )
            .unwrap();
            let reference = ProviderSecretReference {
                provider_relative_path: None,
                source_path: mount.to_string_lossy().into_owned(),
                profile,
            };

            let resolved = resolve_child_secrets(provider, &[reference], root.path()).unwrap();

            assert_eq!(
                resolved.environment.get("HTTPS_PROXY").map(String::as_str),
                Some("http://proxy.example:10255")
            );
            assert_eq!(
                resolved.environment.get("https_proxy").map(String::as_str),
                Some("http://proxy.example:10255")
            );
            assert!(!resolved.environment.contains_key("HTTP_PROXY"));
            assert!(!resolved.environment.contains_key("http_proxy"));
            assert!(!resolved.environment.contains_key("NODE_USE_ENV_PROXY"));
        }
    }

    #[test]
    fn provider_secret_file_grants_return_only_provider_relative_files() {
        let cases = [
            (
                "claude",
                ProviderSecretProfile::ClaudeOnecliAuthFile,
                ".claude/.credentials.json",
            ),
            (
                "codex",
                ProviderSecretProfile::CodexOnecliAuthFile,
                ".codex/auth.json",
            ),
            (
                "opencode",
                ProviderSecretProfile::OpencodeOnecliAuthFile,
                ".local/share/opencode/auth.json",
            ),
            (
                "opencode",
                ProviderSecretProfile::OpencodeOnecliCaFile,
                ".config/onecli/gateway-ca.pem",
            ),
            (
                "amplifier",
                ProviderSecretProfile::AmplifierOnecliKeysFile,
                ".amplifier/keys.env",
            ),
        ];
        for (provider, profile, expected) in cases {
            let root = tempfile::tempdir().unwrap();
            let mount = root.path().join("provider-0");
            let auth = match provider {
                "claude" => {
                    r#"{"claudeAiOauth":{"accessToken":"fixture-access","refreshToken":"fixture-refresh"}}"#
                }
                "codex" => {
                    r#"{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":"fixture-id","access_token":"fixture-access","refresh_token":"fixture-refresh","account_id":"fixture-account"},"last_refresh":"2026-10-06T00:00:00Z"}"#
                }
                "opencode" if profile.auth_relative_path().is_some() => {
                    r#"{"openai":{"type":"oauth","access":"fixture-access","refresh":"fixture-refresh","expires":1790000000000}}"#
                }
                "amplifier" => "VLLM_API_KEY=fixture-key\n",
                _ => "fixture-ca",
            };
            fs::write(&mount, auth).unwrap();
            let references = [ProviderSecretReference {
                provider_relative_path: None,
                source_path: mount.to_string_lossy().into_owned(),
                profile,
            }];
            let resolved = resolve_child_secrets(provider, &references, root.path()).unwrap();
            if profile.auth_relative_path().is_some() {
                assert!(resolved.environment.is_empty());
            } else {
                assert_eq!(
                    resolved
                        .environment
                        .get("NODE_EXTRA_CA_CERTS")
                        .map(String::as_str),
                    Some("/home/freshell/provider/.config/onecli/gateway-ca.pem")
                );
            }
            assert_eq!(
                resolved.provider_files,
                vec![(expected, auth.as_bytes().to_vec())]
            );
            assert!(resolve_child_secrets("wrong-provider", &references, root.path()).is_err());
        }
    }

    #[test]
    fn opencode_onecli_environment_rejects_proxy_aliases_invalid_node_switch_and_non_loopback_bypass(
    ) {
        for invalid in [
            "HTTP_PROXY=http://onecli.example:10255\nhttp_proxy=http://different.example:10255\n",
            "NODE_USE_ENV_PROXY=true\n",
            "NO_PROXY=*\n",
            "NO_PROXY=api.openai.com\n",
            "NO_PROXY=localhost,127.0.0.1,api.openai.com\n",
            "NO_PROXY=localhost,127.0.0.1\nno_proxy=localhost\n",
        ] {
            let root = tempfile::tempdir().unwrap();
            let mount = root.path().join("provider-0");
            fs::write(
                &mount,
                format!(
                    "OPENAI_BASE_URL=https://api.openai.com/v1\nHTTPS_PROXY=http://192.168.3.150:10255\nhttps_proxy=http://192.168.3.150:10255\n{invalid}"
                ),
            )
            .unwrap();
            let reference = ProviderSecretReference {
                provider_relative_path: None,
                source_path: mount.to_string_lossy().into_owned(),
                profile: ProviderSecretProfile::OpencodeOnecliEnvironment,
            };
            assert!(resolve_child_secrets("opencode", &[reference], root.path()).is_err());
        }
    }

    #[test]
    fn resolves_actual_onecli_lunaroute_profile_to_vllm_child_environment() {
        let raw = "ONECLI_GATEWAY=1\nONECLI_URL=http://127.0.0.1:10254\nLUNAROUTE_API_KEY='proxy-managed-placeholder'\nLUNAROUTE_BASE_URL=https://lunaroute.example/v1\nHTTPS_PROXY=http://user:credential@192.0.2.10:10255\nNO_PROXY=localhost,127.0.0.1\nSSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt\nREQUESTS_CA_BUNDLE=$SSL_CERT_FILE\n";
        let child =
            resolve_profile(ProviderSecretProfile::AmplifierOnecliLunarouteGlm53, raw).unwrap();
        assert_eq!(
            child.get("VLLM_API_KEY").unwrap(),
            "proxy-managed-placeholder"
        );
        assert_eq!(
            child.get("VLLM_BASE_URL").unwrap(),
            "https://lunaroute.example/v1"
        );
        assert_eq!(
            child.get("HTTPS_PROXY").unwrap(),
            "http://user:credential@192.0.2.10:10255"
        );
        assert_eq!(child.get("REQUESTS_CA_BUNDLE"), child.get("SSL_CERT_FILE"));
        assert_eq!(child.get("HTTPS_PROXY"), child.get("https_proxy"));
        assert!(!child.contains_key("LUNAROUTE_API_KEY"));
        assert!(!child.contains_key("ONECLI_URL"));
        assert!(!child.contains_key("NO_PROXY"));
        assert!(!child.contains_key("no_proxy"));
        assert!(!child.contains_key("ANTHROPIC_API_KEY"));
    }

    #[test]
    fn onecli_profile_rejects_shell_syntax_unknown_names_duplicates_and_unreachable_proxy() {
        for raw in [
            "ONECLI_GATEWAY=1\nLUNAROUTE_API_KEY=$(cat /secret)\nLUNAROUTE_BASE_URL=https://lunaroute.example/v1\nHTTPS_PROXY=http://user:credential@192.0.2.10:10255\n",
            "ONECLI_GATEWAY=1\nEVIL=value\nLUNAROUTE_API_KEY=key\nLUNAROUTE_BASE_URL=https://lunaroute.example/v1\nHTTPS_PROXY=http://user:credential@192.0.2.10:10255\n",
            "ONECLI_GATEWAY=1\nLUNAROUTE_API_KEY=one\nLUNAROUTE_API_KEY=two\nLUNAROUTE_BASE_URL=https://lunaroute.example/v1\nHTTPS_PROXY=http://user:credential@192.0.2.10:10255\n",
            "ONECLI_GATEWAY=1\nLUNAROUTE_API_KEY=key\nLUNAROUTE_BASE_URL=https://lunaroute.example/v1\nHTTPS_PROXY=http://user:credential@127.0.0.1:10255\n",
            "ONECLI_GATEWAY=1\nLUNAROUTE_API_KEY=proxy-managed-placeholder\nLUNAROUTE_BASE_URL=https://lunaroute.example/v1\nHTTPS_PROXY=http://<AGENT_TOKEN>@192.0.2.10:10255\n",
            "ONECLI_GATEWAY=1\nLUNAROUTE_API_KEY=key\nLUNAROUTE_BASE_URL=https://lunaroute.example/v1\nHTTPS_PROXY=http://user:one@192.0.2.10:10255\nhttps_proxy=http://user:two@192.0.2.10:10255\n",
        ] {
            assert!(resolve_profile(
                ProviderSecretProfile::AmplifierOnecliLunarouteGlm53,
                raw,
            )
            .is_err());
        }
    }

    #[test]
    fn onecli_profile_rejects_credentialed_or_non_https_upstream_and_missing_proxy() {
        for raw in [
            "ONECLI_GATEWAY=1\nLUNAROUTE_API_KEY=key\nLUNAROUTE_BASE_URL=https://user:secret@lunaroute.example/v1\nHTTPS_PROXY=http://user:credential@192.0.2.10:10255\n",
            "ONECLI_GATEWAY=1\nLUNAROUTE_API_KEY=key\nLUNAROUTE_BASE_URL=http://lunaroute.example/v1\nHTTPS_PROXY=http://user:credential@192.0.2.10:10255\n",
            "ONECLI_GATEWAY=1\nLUNAROUTE_API_KEY=key\nLUNAROUTE_BASE_URL=https://lunaroute.example/v1\n",
        ] {
            assert!(resolve_profile(
                ProviderSecretProfile::AmplifierOnecliLunarouteGlm53,
                raw,
            )
            .is_err());
        }
    }

    #[test]
    fn legacy_anthropic_profile_is_readable_but_fails_closed() {
        let error = resolve_profile(
            ProviderSecretProfile::LegacyAmplifierOnecliAnthropicHaikuLow,
            "ANTHROPIC_API_KEY=obsolete\n",
        )
        .unwrap_err();
        assert!(error.contains("no longer supported"));
    }

    #[test]
    fn serialised_launch_contains_references_but_never_resolved_secret_bytes() {
        let reference = freshell_runtime_protocol::ProviderSecretReference {
            provider_relative_path: None,
            source_path: "/private/keys.env".into(),
            profile: ProviderSecretProfile::AmplifierOnecliLunarouteGlm53,
        };
        let json = serde_json::to_string(&reference).unwrap();
        assert!(json.contains("/private/keys.env"));
        assert!(!json.contains("test-secret-not-real"));
    }
}
