use freshell_runtime_protocol::{ProviderSecretProfile, ProviderSecretReference};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

const MAX_KEYS_BYTES: u64 = 128 * 1024;
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
            if raw.is_empty() {
                return Err("OneCLI provider-file grant is empty".into());
            }
            resolved.provider_files.push((relative, raw));
        } else {
            let text =
                std::str::from_utf8(&raw).map_err(|_| "OneCLI environment grant is not UTF-8")?;
            for (name, value) in resolve_profile(reference.profile, text)? {
                if resolved.environment.insert(name, value).is_some() {
                    return Err("OneCLI grants set the same child environment key".into());
                }
            }
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
fn resolve_profile(
    profile: ProviderSecretProfile,
    raw: &str,
) -> Result<BTreeMap<String, String>, String> {
    freshell_platform::provider_environment_grants::resolve_environment_profile(
        environment_profile(profile)?,
        raw,
    )
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_runtime_protocol::ProviderSecretReference;

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

        let resolved = resolve_child_secrets("opencode", &[reference], root.path()).unwrap();

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
            fs::write(&mount, "fake-OneCLI-auth-file").unwrap();
            let references = [ProviderSecretReference {
                provider_relative_path: None,
                source_path: mount.to_string_lossy().into_owned(),
                profile,
            }];
            let resolved = resolve_child_secrets(provider, &references, root.path()).unwrap();
            assert!(resolved.environment.is_empty());
            assert_eq!(
                resolved.provider_files,
                vec![(expected, b"fake-OneCLI-auth-file".to_vec())]
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
