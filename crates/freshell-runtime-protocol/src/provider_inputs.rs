//! Prepared provider input metadata. Payloads and unexpanded source documents
//! remain on private stage filesystems; the control plane carries descriptors.
use crate::{McpCapabilityReference, RuntimeError, RuntimeErrorCode, SoulId};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// One immutable preparation result for every launch and replacement route.
/// Source documents and selected payloads stay in their private filesystem.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedProviderContext {
    pub provider_launch_context: crate::ProviderLaunchContext,
    pub provider_secret_references: Vec<crate::ProviderSecretReference>,
}
impl PreparedProviderContext {
    pub fn validate(&self, provider: &str) -> Result<(), RuntimeError> {
        crate::bounded_json_bytes(self, crate::MAX_CONTROL_FRAME_BYTES).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "prepared provider context exceeds control metadata profile",
            )
        })?;
        self.provider_launch_context.validate(provider)?;
        crate::validate_provider_secrets(provider, &self.provider_secret_references)?;
        if let Some(inputs) = &self.provider_launch_context.prepared_inputs {
            inputs.validate_references(&self.provider_secret_references)?;
        }
        Ok(())
    }
}

/// Transient frozen path inputs travel only through authenticated process IPC.
/// This type must never be embedded in a durable launch specification.
#[derive(Clone, Default, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct ProviderPathInputs(std::collections::BTreeMap<String, String>);
impl std::fmt::Debug for ProviderPathInputs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderPathInputs")
            .field("selected_count", &self.0.len())
            .finish()
    }
}
impl ProviderPathInputs {
    pub fn new(values: std::collections::BTreeMap<String, String>) -> Result<Self, RuntimeError> {
        let mut result = Self::default();
        for (name, value) in values {
            result.insert(name, value)?;
        }
        Ok(result)
    }
    pub fn insert(&mut self, name: String, value: String) -> Result<(), RuntimeError> {
        let invalid = || {
            RuntimeError::new(RuntimeErrorCode::InvalidRequest,"selected provider path inputs have invalid names, controls, collisions or exceeded profile")
        };
        if name.is_empty()
            || name.len() > 128
            || name.contains('=')
            || name.chars().any(char::is_control)
            || value.len() > 64 * 1024
            || value.contains('\0')
            || self.0.contains_key(&name)
            || self.0.len() >= 128
        {
            return Err(invalid());
        }
        let used = self
            .0
            .iter()
            .fold(
                name.len().checked_add(value.len()),
                |size, (name, value)| {
                    size.and_then(|size| size.checked_add(name.len()))
                        .and_then(|size| size.checked_add(value.len()))
                },
            )
            .ok_or_else(invalid)?;
        if used > 256 * 1024 {
            return Err(invalid());
        }
        self.0.insert(name, value);
        Ok(())
    }
    pub fn get(&self, name: &str) -> Option<&str> {
        self.0.get(name).map(String::as_str)
    }
    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}
impl<'de> Deserialize<'de> for ProviderPathInputs {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = ProviderPathInputs;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("bounded transient provider path inputs")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Self::Value, A::Error> {
                let mut inputs = ProviderPathInputs::default();
                while let Some(name) = map.next_key::<String>()? {
                    if inputs.0.len() >= 128 || name.len() > 128 {
                        return Err(serde::de::Error::custom(
                            "selected input name profile exceeded",
                        ));
                    }
                    let value = map.next_value::<String>()?;
                    inputs
                        .insert(name, value)
                        .map_err(|_| serde::de::Error::custom("selected input profile exceeded"))?;
                }
                Ok(inputs)
            }
        }
        deserializer.deserialize_map(Visitor)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindProviderPathInputsRequest {
    pub expected_control_epoch: Option<u64>,
    pub soul_id: SoulId,
    pub generation_id: String,
    pub inputs: ProviderPathInputs,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedProviderInputs {
    pub generation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_auth_reservation: Option<String>,
    pub manifest: ProviderInputManifestReference,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub config_binds: Vec<ProviderConfigBind>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resource_mounts: Vec<ProviderResourceMount>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub indexed_files: Option<IndexedProviderFiles>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInputManifestReference {
    pub relative_path: String,
    pub sha256: String,
    pub source_count: u16,
    pub alias_count: u16,
    pub recipe_count: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderConfigBind {
    pub source_relative_path: String,
    pub logical_destination: String,
    pub effective_destination: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderResourceMount {
    pub stage_relative_path: String,
    pub provider_relative_path: String,
    pub logical_destination: String,
    pub effective_destination: String,
    pub kind: ProviderResourceKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderResourceKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndexedProviderFiles {
    pub volume_name: String,
    #[serde(default)]
    pub aliases: Vec<IndexedProviderFileAlias>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndexedProviderFileAlias {
    pub source_id: u16,
    pub logical_destination: String,
    pub effective_destination: String,
}

pub fn indexed_provider_volume_name(soul: &SoulId, generation: &str) -> String {
    let digest = Sha256::digest(format!("{}\0{generation}", soul.as_str()).as_bytes());
    format!("freshell-inputs-{}", &format!("{digest:x}")[..24])
}

impl PreparedProviderInputs {
    pub fn validate_references(
        &self,
        references: &[crate::ProviderSecretReference],
    ) -> Result<(), RuntimeError> {
        let invalid = || {
            RuntimeError::new(crate::RuntimeErrorCode::InvalidRequest,"prepared provider file indexes do not match approved configuration grants; reprepare before launch")
        };
        let configurations = references
            .iter()
            .filter(|reference| reference.profile.is_configuration_file())
            .collect::<Vec<_>>();
        if configurations.len() != self.manifest.source_count as usize {
            return Err(invalid());
        }
        for (source_id, reference) in configurations.into_iter().enumerate() {
            if reference.provider_relative_path.as_deref()
                != Some(format!(".freshell/references/{source_id}").as_str())
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
    pub fn validate(
        &self,
        capability: Option<&McpCapabilityReference>,
    ) -> Result<(), RuntimeError> {
        use std::collections::BTreeMap;
        let invalid = |field: &str| {
            RuntimeError::new(RuntimeErrorCode::InvalidRequest,format!("prepared provider inputs {field}: invalid, conflicting or over-bound metadata; reprepare before launch"))
        };
        crate::bounded_json_bytes(self, crate::MAX_CONTROL_FRAME_BYTES)
            .map_err(|_| invalid("control byte limit"))?;
        if self
            .initial_auth_reservation
            .as_ref()
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_err())
        {
            return Err(invalid("initial auth reservation"));
        }
        if capability.map(|value| value.grant_id.as_str()) != Some(self.generation_id.as_str())
            || !self.generation_id.starts_with("grant-")
            || !identifier(&self.generation_id)
        {
            return Err(invalid("generation"));
        }
        if self.manifest.relative_path != ".freshell/input-manifest.json"
            || self.manifest.sha256.len() != 64
            || !self.manifest.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            || self.manifest.source_count > 128
            || self.manifest.alias_count > 256
            || self.manifest.recipe_count > 128
        {
            return Err(invalid("manifest"));
        }
        if self
            .config_binds
            .len()
            .checked_add(self.resource_mounts.len())
            .is_none_or(|n| n > 100_000)
        {
            return Err(invalid("resource entries"));
        }
        let mut destinations: BTreeMap<String, (String, ProviderResourceKind)> = BTreeMap::new();
        let mut logical = BTreeMap::<String, String>::new();
        let mut add = |original: &str,
                       effective: &str,
                       identity: String,
                       kind: ProviderResourceKind|
         -> Result<(), RuntimeError> {
            if !mount_destination(original) || !mount_destination(effective) {
                return Err(invalid("mount destination"));
            }
            if logical
                .insert(original.to_owned(), identity.clone())
                .is_some_and(|prior| prior != identity)
            {
                return Err(invalid("logical destination"));
            }
            if destinations
                .insert(effective.to_owned(), (identity.clone(), kind))
                .is_some_and(|prior| prior != (identity, kind))
            {
                return Err(invalid("effective destination"));
            }
            Ok(())
        };
        for bind in &self.config_binds {
            if !unit_path(&bind.source_relative_path, ".freshell/templates", false) {
                return Err(invalid("configuration source"));
            }
            add(
                &bind.logical_destination,
                &bind.effective_destination,
                format!("configuration:{}", bind.source_relative_path),
                ProviderResourceKind::File,
            )?;
        }
        for mount in &self.resource_mounts {
            let file = mount.kind == ProviderResourceKind::File;
            if !unit_path(&mount.stage_relative_path, ".freshell/resource-units", file)
                || !unit_path(
                    &mount.provider_relative_path,
                    ".freshell/provider-roots",
                    file,
                )
                || mount
                    .stage_relative_path
                    .strip_prefix(".freshell/resource-units/")
                    != mount
                        .provider_relative_path
                        .strip_prefix(".freshell/provider-roots/")
            {
                return Err(invalid("resource source"));
            }
            add(
                &mount.logical_destination,
                &mount.effective_destination,
                format!("resource:{}", mount.provider_relative_path),
                mount.kind,
            )?;
        }
        if let Some(files) = &self.indexed_files {
            if !files
                .volume_name
                .strip_prefix("freshell-inputs-")
                .is_some_and(|suffix| {
                    suffix.len() == 24 && suffix.bytes().all(|b| b.is_ascii_hexdigit())
                })
                || files.aliases.len() > 256
                || files.aliases.len() != self.manifest.alias_count as usize
            {
                return Err(invalid("indexed file publication"));
            }
            for alias in &files.aliases {
                if alias.source_id >= self.manifest.source_count {
                    return Err(invalid("indexed source ID"));
                }
                add(
                    &alias.logical_destination,
                    &alias.effective_destination,
                    format!("indexed:{}", alias.source_id),
                    ProviderResourceKind::File,
                )?;
            }
        } else if self.manifest.source_count != 0 || self.manifest.alias_count != 0 {
            return Err(invalid("indexed file publication"));
        }
        for (path, (_, kind)) in &destinations {
            let mut cursor = path.as_str();
            while let Some((parent, _)) = cursor.rsplit_once('/') {
                if parent.is_empty() {
                    break;
                }
                if destinations.get(parent).is_some_and(|(_, parent_kind)| {
                    *parent_kind == ProviderResourceKind::File
                        || *kind == ProviderResourceKind::Directory
                }) {
                    return Err(invalid("ancestor destination"));
                }
                cursor = parent;
            }
        }
        Ok(())
    }
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
fn unit_path(value: &str, prefix: &str, file: bool) -> bool {
    let Some(tail) = value
        .strip_prefix(prefix)
        .and_then(|tail| tail.strip_prefix('/'))
    else {
        return false;
    };
    let (id, leaf) = tail
        .split_once('/')
        .map_or((tail, None), |(id, leaf)| (id, Some(leaf)));
    identifier(id) && leaf == if file { Some("source") } else { None }
}
fn mount_destination(value: &str) -> bool {
    if !value.starts_with('/')
        || value.len() > 64 * 1024
        || value.chars().any(char::is_control)
        || value[1..]
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        return false;
    }
    for reserved in [
        "/runtime",
        "/run/freshell",
        "/run/freshell-private",
        "/run/freshell-secrets",
        "/run/freshell-bootstrap",
        "/home/freshell/provider/.freshell/provider-roots",
        "/home/freshell/provider/.freshell/mcp-capability.json",
    ] {
        if value == reserved
            || value.starts_with(&format!("{reserved}/"))
            || reserved.starts_with(&format!("{value}/"))
        {
            return false;
        }
    }
    value != "/home/freshell/provider"
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_frozen_path_inputs_use_private_binding_rpc() {
        let request = serde_json::json!({"method":"bind_provider_path_inputs","params":{
            "expectedControlEpoch":1,"soulId":crate::SoulId::new(),
            "generationId":"grant-synthetic-input-generation",
            "inputs":{"PUBLIC_RULE_ROOT":"/synthetic/original/rules"}
        }});
        assert!(serde_json::from_value::<crate::AdminCommand>(request).is_ok(),
            "frozen path inputs need a private process-only delivery separate from durable LaunchRequest");
    }

    #[test]
    fn provider_frozen_path_inputs_enforce_shared_profile_and_redact_diagnostics() {
        let mut inputs = ProviderPathInputs::default();
        for name in ["A", "B", "C", "D"] {
            inputs
                .insert(name.into(), "x".repeat(64 * 1024 - 1))
                .unwrap();
        }
        assert!(inputs.insert("E".into(), "x".into()).is_err());
        assert!(ProviderPathInputs::new(std::collections::BTreeMap::from([(
            "A".into(),
            "x".repeat(64 * 1024 + 1)
        )]))
        .is_err());
        let mut inputs = ProviderPathInputs::default();
        for id in 0..128 {
            inputs
                .insert(format!("PATH_{id}"), "/synthetic".into())
                .unwrap();
        }
        assert!(inputs
            .insert("PATH_128".into(), "/synthetic".into())
            .is_err());
        for raw in [
            r#"{"PATH":"/first","PATH":"/second"}"#,
            r#"{"PATH":"bad\u0000value"}"#,
        ] {
            assert!(serde_json::from_str::<ProviderPathInputs>(raw).is_err());
        }
        let inputs: ProviderPathInputs =
            serde_json::from_str(r#"{"PATH":"PRIVATE_PATH_INPUT_SENTINEL"}"#).unwrap();
        let wire = serde_json::to_vec(&inputs).unwrap();
        let received: ProviderPathInputs = serde_json::from_slice(&wire).unwrap();
        assert_eq!(received.get("PATH"), Some("PRIVATE_PATH_INPUT_SENTINEL"));
        assert!(!format!("{received:?}").contains("PRIVATE_PATH_INPUT_SENTINEL"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn provider_frozen_inputs_actual_maximum_profile_reaches_guarded_child() {
        const MAXIMUM_VALUE_NAME: &str = "FRESHELL_TEST_MAXIMUM_PROVIDER_VALUE";
        let marker = format!("N{:0127}", 0);
        if std::env::var_os(&marker).is_some() || std::env::var_os(MAXIMUM_VALUE_NAME).is_some() {
            let variables = std::env::vars().collect::<std::collections::BTreeMap<_, _>>();
            let maximum_value_case = variables.contains_key(MAXIMUM_VALUE_NAME);
            let names = if maximum_value_case { 1 } else { 128 };
            let value_bytes = if maximum_value_case { 64 * 1024 } else { 1920 };
            assert_eq!(variables.len(), names);
            assert!(variables
                .values()
                .all(|value| value.len() == value_bytes && value.bytes().all(|byte| byte == b'x')));
            if !maximum_value_case {
                assert!(variables.keys().all(|name| name.len() == 128));
            }
            let total = variables
                .iter()
                .map(|(name, value)| name.len() + value.len())
                .sum::<usize>();
            assert_eq!(
                total,
                if maximum_value_case {
                    MAXIMUM_VALUE_NAME.len() + 64 * 1024
                } else {
                    256 * 1024
                }
            );
            assert!(ProviderPathInputs::new(variables).is_ok());
            println!(
                "frozen_input_actual_environment {}",
                serde_json::json!({"names":names,"valueBytes":value_bytes,"totalBytes":total})
            );
            return;
        }

        let exact = (0..128)
            .map(|id| (format!("N{id:0127}"), "x".repeat(1920)))
            .collect::<std::collections::BTreeMap<_, _>>();
        let full = ProviderPathInputs::new(exact.clone()).unwrap();
        let mut over = exact;
        over.get_mut(&marker).unwrap().push('x');
        assert!(
            ProviderPathInputs::new(over).is_err(),
            "one extra shared byte must fail before dispatch"
        );
        assert!(ProviderPathInputs::new(std::collections::BTreeMap::from([(
            format!("N{}", "0".repeat(128)),
            "x".into()
        )]))
        .is_err());
        let maximum_value = ProviderPathInputs::new(std::collections::BTreeMap::from([(
            MAXIMUM_VALUE_NAME.into(),
            "x".repeat(64 * 1024),
        )]))
        .unwrap();
        assert!(ProviderPathInputs::new(std::collections::BTreeMap::from([(
            MAXIMUM_VALUE_NAME.into(),
            "x".repeat(64 * 1024 + 1)
        )]))
        .is_err());

        for inputs in [full, maximum_value] {
            let encoded =
                crate::bounded_json_bytes(&inputs, crate::MAX_CONTROL_FRAME_BYTES).unwrap();
            let received: ProviderPathInputs = serde_json::from_slice(&encoded).unwrap();
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command.env_clear().envs(received.iter()).args([
                "--exact",
                "provider_inputs::tests::provider_frozen_inputs_actual_maximum_profile_reaches_guarded_child",
                "--nocapture",
            ]);
            freshell_platform::provider_exec::check_command(&command, false, &[]).unwrap();
            let output = command.output().unwrap();
            assert!(
                output.status.success(),
                "isolated exact-profile child failed"
            );
            let diagnostic = String::from_utf8(output.stdout).unwrap();
            let receipt = diagnostic
                .lines()
                .find_map(|line| {
                    line.split_once("frozen_input_actual_environment ")
                        .map(|(_, receipt)| receipt)
                })
                .expect("exact selected profile must be consumed in the actual child");
            let value: serde_json::Value = serde_json::from_str(receipt).unwrap();
            assert_eq!(value["names"], received.iter().count());
            assert_eq!(
                value["valueBytes"],
                received.iter().map(|(_, value)| value.len()).max().unwrap()
            );
            assert_eq!(
                value.as_object().unwrap().len(),
                3,
                "child diagnostics carry numbers only"
            );
            assert_eq!(
                value["totalBytes"],
                received
                    .iter()
                    .map(|(name, value)| name.len() + value.len())
                    .sum::<usize>()
            );
            println!("frozen_input_actual_environment {value}");
        }
    }

    fn prepared() -> PreparedProviderInputs {
        PreparedProviderInputs {
            generation_id: "grant-synthetic".into(),
            initial_auth_reservation: None,
            manifest: ProviderInputManifestReference {
                relative_path: ".freshell/input-manifest.json".into(),
                sha256: "a".repeat(64),
                source_count: 2,
                alias_count: 2,
                recipe_count: 0,
            },
            config_binds: vec![],
            resource_mounts: vec![],
            indexed_files: Some(IndexedProviderFiles {
                volume_name: indexed_provider_volume_name(&SoulId::new(), "grant-synthetic"),
                aliases: vec![
                    IndexedProviderFileAlias {
                        source_id: 0,
                        logical_destination: "/fixture/rules".into(),
                        effective_destination: "/fixture/rules".into(),
                    },
                    IndexedProviderFileAlias {
                        source_id: 1,
                        logical_destination: "/fixture/other".into(),
                        effective_destination: "/fixture/other".into(),
                    },
                ],
            }),
        }
    }
    fn capability() -> McpCapabilityReference {
        McpCapabilityReference {
            grant_id: "grant-synthetic".into(),
            endpoint: "http://host.docker.internal:3344".into(),
            provider_relative_path: ".freshell/mcp-capability.json".into(),
            host_gateway_address: None,
        }
    }
    #[test]
    fn provider_prepared_complete_context_rejects_mixed_generation_and_reference_vectors() {
        let value = PreparedProviderContext {
            provider_launch_context: crate::ProviderLaunchContext {
                prepared_inputs: Some(prepared()),
                preparation: crate::ProviderPreparation::Codex {
                    tui_args: vec![],
                    sidecar_args: vec![],
                },
                mcp_capability: Some(capability()),
                config: vec![],
            },
            provider_secret_references: (0..2)
                .map(|index| crate::ProviderSecretReference {
                    source_path: format!("/private/source-{index}"),
                    profile: crate::ProviderSecretProfile::CodexConfigurationFile,
                    provider_relative_path: Some(format!(".freshell/references/{index}")),
                })
                .collect(),
        };
        let wire = crate::bounded_json_bytes(&value, crate::MAX_CONTROL_FRAME_BYTES).unwrap();
        let mut received: PreparedProviderContext = serde_json::from_slice(&wire).unwrap();
        received.validate("codex").unwrap();
        assert!(received.validate("opencode").is_err());
        received.provider_secret_references.swap(0, 1);
        assert!(
            received.validate("codex").is_err(),
            "stale/new indexed reference vectors cannot accompany a prepared generation"
        );
        received = value;
        received
            .provider_launch_context
            .mcp_capability
            .as_mut()
            .unwrap()
            .grant_id = "grant-different".into();
        assert!(
            received.validate("codex").is_err(),
            "one complete reply must retain its exact generation authority"
        );
    }

    #[test]
    fn provider_prepared_mounts_reject_different_sources_over_one_effective_inode() {
        let mut value = prepared();
        value.indexed_files.as_mut().unwrap().aliases[1].effective_destination =
            "/fixture/rules".into();
        assert!(
            value.validate(Some(&capability())).is_err(),
            "different approved sources must never win by mount order"
        );
    }
    #[test]
    fn provider_prepared_mounts_preserve_home_and_control_parents() {
        for destination in [
            "/home/freshell/provider",
            "/run/freshell/secret",
            "/runtime/freshell-session-host",
        ] {
            let mut value = prepared();
            value.resource_mounts.push(ProviderResourceMount {
                stage_relative_path: ".freshell/resource-units/unit-0".into(),
                provider_relative_path: ".freshell/provider-roots/unit-0".into(),
                logical_destination: destination.into(),
                effective_destination: destination.into(),
                kind: ProviderResourceKind::Directory,
            });
            assert!(
                value.validate(Some(&capability())).is_err(),
                "reserved destination accepted"
            );
        }
    }
    #[test]
    fn provider_prepared_manifest_belongs_to_the_same_generation() {
        let mut value = prepared();
        value.generation_id = "grant-other".into();
        assert!(
            value.validate(Some(&capability())).is_err(),
            "stale generation must fail before mount construction"
        );
    }
    #[test]
    fn provider_prepared_mounts_allow_one_source_through_multiple_original_aliases() {
        let mut value = prepared();
        value.indexed_files.as_mut().unwrap().aliases[1].source_id = 0;
        value.indexed_files.as_mut().unwrap().aliases[1].effective_destination =
            "/fixture/rules".into();
        value.validate(Some(&capability())).unwrap();
        let bytes = crate::bounded_json_bytes(&value, crate::MAX_CONTROL_FRAME_BYTES).unwrap();
        let restored: PreparedProviderInputs = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(restored, value);
    }

    #[test]
    fn provider_prepared_file_indexes_must_name_real_configuration_grants_in_both_routes() {
        let context = crate::ProviderLaunchContext {
            prepared_inputs: Some(prepared()),
            preparation: crate::ProviderPreparation::Codex {
                tui_args: vec![],
                sidecar_args: vec![],
            },
            mcp_capability: Some(capability()),
            config: vec![],
        };
        let mut terminal:crate::TerminalLaunchSpec=serde_json::from_value(serde_json::json!({
            "terminalId":"terminal-index","streamId":"stream-index","mode":"codex","program":"codex",
            "cwd":"/fixture/workspace","workspacePath":"/fixture/workspace","runAsUid":65534,"runAsGid":0,
            "cols":80,"rows":24,"projectKey":"project-index","providerLaunchContext":context
        })).unwrap();
        let mut fresh:crate::FreshAgentLaunchSpec=serde_json::from_value(serde_json::json!({
            "sessionId":"session-index","provider":"codex","sessionType":"freshcodex","runtimeVariant":"codex-app-server",
            "providerStoreId":"store-index","cwd":"/fixture/workspace","workspacePath":"/fixture/workspace","runAsUid":65534,"runAsGid":0,
            "providerLaunchContext":context
        })).unwrap();
        assert!(
            terminal.validate().is_err(),
            "file subpaths without approved input grants must fail before Docker"
        );
        assert!(
            fresh.validate().is_err(),
            "fresh route requires the same source identity proof"
        );
        let references = (0..2)
            .map(|source_id| crate::ProviderSecretReference {
                source_path: format!("/private/source-{source_id}"),
                profile: crate::ProviderSecretProfile::CodexConfigurationFile,
                provider_relative_path: Some(format!(".freshell/references/{source_id}")),
            })
            .collect::<Vec<_>>();
        terminal.provider_secret_references = references.clone();
        fresh.provider_secret_references = references;
        terminal.validate().unwrap();
        fresh.validate().unwrap();
        terminal.provider_secret_references.swap(0, 1);
        fresh.provider_secret_references.swap(0, 1);
        assert!(terminal.validate().is_err());
        assert!(fresh.validate().is_err());
    }
}
