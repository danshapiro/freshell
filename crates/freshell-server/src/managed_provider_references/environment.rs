//! One bounded controller read of selected child grants and original inputs.
use super::sources::{PlannedSourceOccurrence, SourceLane};
use freshell_runtime_protocol::{ProviderPathInputs, ProviderSecretReference};
use std::collections::BTreeMap;

pub(super) struct SourceEnvironment {
    ambient: BTreeMap<String, String>,
    onecli: BTreeMap<String, String>,
    auth: Option<BTreeMap<String, String>>,
    names: Vec<String>,
    relocated_files: BTreeMap<std::path::PathBuf, std::path::PathBuf>,
}
impl SourceEnvironment {
    pub fn read(
        names: Vec<String>,
        references: &[ProviderSecretReference],
        original: &dyn Fn(&str) -> Option<String>,
    ) -> Result<Self, String> {
        use freshell_platform::provider_environment_grants::{
            read_environment_grant, read_opencode_auth_environment, EnvironmentProfile,
        };
        use freshell_runtime_protocol::ProviderSecretProfile;
        freshell_runtime_protocol::validate_provider_secrets("opencode", references)
            .map_err(|error| error.message)?;
        freshell_platform::native_auth_exchange::validate_keys(&names).map_err(str::to_string)?;
        // Probe only the finite internal names. Retain neither the unrelated
        // original/request values nor an ambient environment snapshot.
        for ordinal in 0..freshell_platform::opencode_config::MAX_GENERATED_CONFIG_REFERENCES {
            let name = freshell_platform::opencode_config::generated_config_reference_name(ordinal);
            if original(&name).is_some() {
                return Err("original/request input occupies the reserved generated configuration namespace".into());
            }
        }
        let mut ambient = BTreeMap::new();
        let mut ambient_bytes = 0usize;
        for name in &names {
            if let Some(value) = original(name) {
                ambient_bytes = ambient_bytes
                    .checked_add(value.len())
                    .ok_or("source input size overflow")?;
                if value.len() > 16 * 1024 * 1024 || ambient_bytes > 64 * 1024 * 1024 {
                    return Err("source input view profile exceeded".into());
                }
                ambient.insert(name.clone(), value);
            }
        }
        let mut onecli = BTreeMap::new();
        let mut auth = None;
        let mut relocated_files = BTreeMap::new();
        for reference in references {
            match reference.profile {
                ProviderSecretProfile::OpencodeOnecliEnvironment => {
                    let values = read_environment_grant(
                        std::path::Path::new(&reference.source_path),
                        EnvironmentProfile::Opencode,
                    )
                    .map_err(|error| error.to_string())?;
                    onecli.extend(values.into_iter().filter(|(name, _)| names.contains(name)));
                }
                ProviderSecretProfile::OpencodeOnecliAuthFile => {
                    auth = Some(
                        read_opencode_auth_environment(
                            std::path::Path::new(&reference.source_path),
                            &names,
                        )
                        .map_err(|error| error.to_string())?,
                    );
                }
                ProviderSecretProfile::OpencodeOnecliCaFile => {
                    let destination = reference
                        .profile
                        .provider_file_relative_path()
                        .ok_or("CA grant destination unavailable")?;
                    relocated_files.insert(
                        std::path::Path::new("/home/freshell/provider").join(destination),
                        std::path::PathBuf::from(&reference.source_path),
                    );
                }
                _ => {}
            }
        }
        Ok(Self {
            ambient,
            onecli,
            auth,
            names,
            relocated_files,
        })
    }

    pub fn lookup(&self, lane: SourceLane, name: &str) -> Option<String> {
        if lane == SourceLane::Main {
            if let Some(value) = self.auth.as_ref().and_then(|auth| auth.get(name)) {
                return Some(value.clone());
            }
        }
        self.onecli
            .get(name)
            .or_else(|| self.ambient.get(name))
            .cloned()
    }
    pub fn needs_native_auth(&self) -> bool {
        self.auth.is_none() && !self.names.is_empty()
    }
    pub fn names(&self) -> &[String] {
        &self.names
    }
    pub fn set_native_auth(&mut self, values: BTreeMap<String, String>) -> Result<(), String> {
        freshell_platform::native_auth_exchange::validate_selected(&self.names, &values)
            .map_err(str::to_string)?;
        if self.auth.is_some() {
            return Err("selected typed auth must not be replaced by native auth fallback".into());
        }
        self.auth = Some(values);
        Ok(())
    }
    pub fn plan_sources(
        &self,
        sources: Vec<super::sources::LoadedSourceOccurrence>,
        cwd: &std::path::Path,
        home: &std::path::Path,
    ) -> Result<Vec<PlannedSourceOccurrence>, super::ReferenceError> {
        if self.needs_native_auth()
            && sources
                .iter()
                .any(|source| source.source.lane == SourceLane::Main)
        {
            return Err(super::ReferenceError {
                operation: "prepare",
                field: "OpenCode native auth source",
                source_ordinal: 0,
                declaring_source: cwd.into(),
                variables: vec![],
                cause: "native auth selection requires the current provider preparation attempt",
            });
        }
        super::sources::plan_loaded_opencode_sources_relocated(
            sources,
            cwd,
            home,
            &|lane, _, name| self.lookup(lane, name),
            &self.relocated_files,
        )
    }
    pub fn frozen_inputs(
        &self,
        plan: &[PlannedSourceOccurrence],
    ) -> Result<ProviderPathInputs, String> {
        let mut selected = std::collections::BTreeSet::new();
        for source in plan {
            // A whole-document recipe does not grant unrelated ambient keys
            // new forwarding authority. Auth and OneCLI remain host-resolved;
            // freeze only original inputs that select accepted file paths.
            for name in &source.references.path_variables {
                if self.onecli.contains_key(name)
                    || (source.source.lane == SourceLane::Main
                        && self
                            .auth
                            .as_ref()
                            .is_some_and(|auth| auth.contains_key(name)))
                {
                    continue;
                }
                if self.ambient.contains_key(name) {
                    selected.insert(name.clone());
                }
            }
        }
        let generated_count = plan
            .iter()
            .map(|source| {
                source.references.recipes.len()
                    + usize::from(source.source.lane == SourceLane::Inline)
            })
            .try_fold(0usize, usize::checked_add)
            .ok_or("selected/generated source name count overflow")?;
        if selected
            .len()
            .checked_add(generated_count)
            .is_none_or(|count| count > 128)
        {
            return Err(
                "selected and generated source inputs exceed shared 128-name profile".into(),
            );
        }
        let mut result = ProviderPathInputs::default();
        for name in selected {
            if matches!(
                name.as_str(),
                "AUTH_TOKEN" | "FRESHELL_TOKEN" | "FRESHELL_URL"
            ) || name
                .starts_with(freshell_platform::opencode_config::GENERATED_CONFIG_REFERENCE_PREFIX)
            {
                return Err("selected original source input collides with controller authentication or generated names".into());
            }
            result
                .insert(name.clone(), self.ambient[&name].clone())
                .map_err(|error| error.message)?;
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn managed_provider_source_environment_rejects_unselected_typed_auth_generated_key() {
        let owned = tempfile::tempdir().unwrap();
        let path = owned.path().join("auth.json");
        let raw = r#"{"shadow":{"type":"wellknown","key":"FRESHELL_CONFIG_REFERENCE_0","token":"PRIVATE_TYPED_SHADOW_SENTINEL"},"selected":{"type":"wellknown","key":"RULE_ROOT","token":"/synthetic/selected"}}"#;
        std::fs::write(&path, raw).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let references = [ProviderSecretReference {
            source_path: path.to_str().unwrap().into(),
            profile: ProviderSecretProfile::OpencodeOnecliAuthFile,
            provider_relative_path: None,
        }];
        let error = SourceEnvironment::read(vec!["RULE_ROOT".into()], &references, &|_| None)
            .err()
            .expect(
                "typed auth must check native generated-name overlays before source publication",
            );
        assert!(!error.contains("PRIVATE_TYPED_SHADOW_SENTINEL"));
        assert_eq!(std::fs::read_to_string(path).unwrap(), raw);
    }

    #[test]
    fn managed_provider_source_environment_rejects_unselected_request_generated_namespace() {
        let original = |name: &str| match name {
            "FRESHELL_CONFIG_REFERENCE_0" => Some("PRIVATE_REQUEST_SHADOW_SENTINEL".into()),
            _ => None,
        };
        let error=SourceEnvironment::read(vec!["RULE_ROOT".into()],&[],&original).err()
            .expect("an unselected original/request value must not occupy the generated configuration namespace");
        assert!(!error.contains("PRIVATE_REQUEST_SHADOW_SENTINEL"));
    }
    use freshell_runtime_protocol::ProviderSecretProfile;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn managed_provider_source_environment_freezes_only_selected_original_inputs() {
        use super::super::sources::{LoadedSourceOccurrence, SourceOccurrence};
        let owned = tempfile::tempdir().unwrap();
        let rules = owned.path().join("rules");
        std::fs::write(&rules, "synthetic-rule-nonce").unwrap();
        let raw = r#"{"instructions":["{env:INSERT}"],"model":"{env:UNRELATED}"}"#;
        let config = owned.path().join("opencode.json");
        std::fs::write(&config, raw).unwrap();
        let input = format!("PRIVATE_PREFIX{{file:{}}}PRIVATE_SUFFIX", rules.display());
        let mut environment =
            SourceEnvironment::read(vec!["INSERT".into(), "UNRELATED".into()], &[], &|name| {
                match name {
                    "INSERT" => Some(input.clone()),
                    "UNRELATED" => Some("PRIVATE_UNRELATED_AMBIENT_SECRET".into()),
                    _ => None,
                }
            })
            .unwrap();
        let loaded = || {
            vec![LoadedSourceOccurrence {
                requires_config_bind: false,
                source: SourceOccurrence {
                    logical_path: config.clone(),
                    canonical_source: config.clone(),
                    lane: SourceLane::Main,
                    role: freshell_platform::opencode_recipe::DiscoveryRole::Workspace,
                },
                view: std::sync::Arc::new(raw.into()),
            }]
        };
        assert!(
            environment
                .plan_sources(loaded(), owned.path(), owned.path())
                .is_err(),
            "absent metadata must not stand in for a selected native auth source"
        );
        environment.set_native_auth(BTreeMap::new()).unwrap();
        let plan = environment
            .plan_sources(loaded(), owned.path(), owned.path())
            .unwrap();
        let frozen = environment.frozen_inputs(&plan).unwrap();
        assert_eq!(frozen.get("INSERT"), Some(input.as_str()));
        assert!(frozen.get("UNRELATED").is_none());
        let handoff = serde_json::to_vec(&frozen).unwrap();
        assert!(
            !handoff
                .windows(b"PRIVATE_UNRELATED_AMBIENT_SECRET".len())
                .any(|bytes| bytes == b"PRIVATE_UNRELATED_AMBIENT_SECRET"),
            "private IPC serialization must not gain unrelated ambient credentials"
        );
        assert!(!plan[0].references.template.contains("PRIVATE_PREFIX"));
        assert!(!plan[0]
            .references
            .unexpanded_source()
            .contains("PRIVATE_PREFIX"));
    }
    #[test]
    fn managed_provider_source_environment_combines_selected_and_generated_name_budget() {
        use super::super::sources::{LoadedSourceOccurrence, SourceOccurrence};
        let owned = tempfile::tempdir().unwrap();
        let rules = owned.path().join("rules");
        std::fs::write(&rules, "synthetic-budget-rule-nonce").unwrap();
        let names = (0..127)
            .map(|index| format!("ROOT_{index}"))
            .chain(std::iter::once("INSERT".into()))
            .collect::<Vec<_>>();
        let input = format!("{{file:{}}}", rules.display());
        let original = |name: &str| {
            if name == "INSERT" {
                Some(input.clone())
            } else if name.starts_with("ROOT_") {
                Some(rules.to_str().unwrap().into())
            } else {
                None
            }
        };
        let mut environment = SourceEnvironment::read(names, &[], &original).unwrap();
        environment.set_native_auth(BTreeMap::new()).unwrap();
        for selected_names in [127, 128] {
            let mut fields = (0..selected_names - 1)
                .map(|index| format!("{{file:{{env:ROOT_{index}}}}}"))
                .collect::<Vec<_>>();
            fields.push("{env:INSERT}".into());
            let raw = serde_json::json!({"instructions": fields}).to_string();
            let config = owned.path().join("opencode.json");
            let plan = environment
                .plan_sources(
                    vec![LoadedSourceOccurrence {
                        requires_config_bind: false,
                        source: SourceOccurrence {
                            logical_path: config.clone(),
                            canonical_source: config,
                            lane: SourceLane::Main,
                            role: freshell_platform::opencode_recipe::DiscoveryRole::Workspace,
                        },
                        view: std::sync::Arc::new(raw),
                    }],
                    owned.path(),
                    owned.path(),
                )
                .unwrap();
            assert_eq!(plan[0].references.recipes.len(), 1);
            let frozen = environment.frozen_inputs(&plan);
            if selected_names == 127 {
                assert_eq!(
                    frozen.unwrap().iter().count(),
                    127,
                    "the shared profile must allow exactly 128 selected plus generated names"
                );
            } else {
                assert!(frozen.is_err(),
                    "128 selected names plus a generated name must fail before capability publication");
            }
        }
    }

    #[test]
    fn managed_provider_source_environment_maps_known_runtime_ca_to_its_typed_source() {
        use super::super::sources::{LoadedSourceOccurrence, SourceOccurrence};
        let owned = tempfile::tempdir().unwrap();
        let grant = owned.path().join("environment.env");
        let auth = owned.path().join("auth.json");
        let ca = owned.path().join("ca.pem");
        let config = owned.path().join("opencode.json");
        std::fs::write(&grant,"OPENAI_API_KEY=synthetic-key\nNODE_EXTRA_CA_CERTS=/home/freshell/provider/.config/onecli/gateway-ca.pem\n").unwrap();
        std::fs::write(&auth, "{}").unwrap();
        std::fs::write(&ca, "synthetic-ca-nonce").unwrap();
        for path in [&grant, &auth, &ca] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let refs = [
            (grant, ProviderSecretProfile::OpencodeOnecliEnvironment),
            (auth, ProviderSecretProfile::OpencodeOnecliAuthFile),
            (ca.clone(), ProviderSecretProfile::OpencodeOnecliCaFile),
        ]
        .map(|(path, profile)| ProviderSecretReference {
            source_path: path.to_str().unwrap().into(),
            profile,
            provider_relative_path: None,
        });
        let environment =
            SourceEnvironment::read(vec!["NODE_EXTRA_CA_CERTS".into()], &refs, &|_| None).unwrap();
        let raw = r#"{"instructions":["{file:{env:NODE_EXTRA_CA_CERTS}}","{file:/home/freshell/provider/.config/onecli/gateway-ca.pem}"]}"#;
        std::fs::write(&config, raw).unwrap();
        let plan = environment
            .plan_sources(
                vec![LoadedSourceOccurrence {
                    requires_config_bind: false,
                    source: SourceOccurrence {
                        logical_path: config.clone(),
                        canonical_source: config,
                        lane: SourceLane::Main,
                        role: freshell_platform::opencode_recipe::DiscoveryRole::Workspace,
                    },
                    view: std::sync::Arc::new(raw.into()),
                }],
                owned.path(),
                owned.path(),
            )
            .unwrap();
        assert_eq!(plan[0].references.selections.len(), 1);
        assert_eq!(plan[0].references.selections[0].canonical_source, ca);
        assert!(environment.frozen_inputs(&plan).unwrap().is_empty(),"typed child grant inputs must be refreshed from the host's actual read, not frozen as ambient paths");
    }
    #[test]
    fn managed_provider_source_environment_reads_typed_grants_and_keeps_auth_source_specific() {
        let owned = tempfile::tempdir().unwrap();
        let grant = owned.path().join("environment.env");
        let auth = owned.path().join("auth.json");
        std::fs::write(
            &grant,
            "OPENAI_API_KEY=synthetic-key\nNODE_EXTRA_CA_CERTS=/synthetic/onecli-ca\n",
        )
        .unwrap();
        std::fs::write(&auth,r#"{"first":{"type":"wellknown","key":"PATH_INPUT","token":"/synthetic/first"},"last":{"type":"wellknown","key":"PATH_INPUT","token":"/synthetic/typed-auth"}}"#).unwrap();
        for path in [&grant, &auth] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let references = [
            ProviderSecretReference {
                source_path: grant.to_str().unwrap().into(),
                profile: ProviderSecretProfile::OpencodeOnecliEnvironment,
                provider_relative_path: None,
            },
            ProviderSecretReference {
                source_path: auth.to_str().unwrap().into(),
                profile: ProviderSecretProfile::OpencodeOnecliAuthFile,
                provider_relative_path: None,
            },
        ];
        let environment = SourceEnvironment::read(
            vec!["NODE_EXTRA_CA_CERTS".into(), "PATH_INPUT".into()],
            &references,
            &|name| {
                matches!(name, "PATH_INPUT" | "NODE_EXTRA_CA_CERTS")
                    .then(|| "/synthetic/ambient".into())
            },
        )
        .unwrap();
        assert_eq!(
            environment
                .lookup(SourceLane::Main, "NODE_EXTRA_CA_CERTS")
                .as_deref(),
            Some("/synthetic/onecli-ca"),
            "approved OneCLI child overlay must win over original ambient input"
        );
        assert_eq!(
            environment
                .lookup(SourceLane::Main, "PATH_INPUT")
                .as_deref(),
            Some("/synthetic/typed-auth")
        );
        assert_eq!(
            environment.lookup(SourceLane::Tui, "PATH_INPUT").as_deref(),
            Some("/synthetic/ambient"),
            "TUI must not receive main loader's authEnv"
        );
        assert!(
            !environment.needs_native_auth(),
            "selected typed auth grant has precedence over native fallback"
        );
        std::fs::write(&grant, "NODE_EXTRA_CA_CERTS=/synthetic/changed\n").unwrap();
        assert_eq!(
            environment
                .lookup(SourceLane::Main, "NODE_EXTRA_CA_CERTS")
                .as_deref(),
            Some("/synthetic/onecli-ca"),
            "one bounded read must remain the preparation's actual grant generation"
        );
    }
}
