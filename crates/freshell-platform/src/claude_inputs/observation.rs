//! Finite Claude source observations made by the actual reader process.
//! The caller owns namespace/attempt qualification; this reader accepts no
//! claimed uid and never reads settings payloads or credentials.
use super::{git, ClaudeSettingSource, NativeSourceRuntime};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

pub const MAX_REQUEST_BYTES: usize = 256 * 1024;
pub const MAX_REPLY_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservationRequest {
    pub version: u8,
    pub request_id: String,
    pub native_source_runtime: NativeSourceRuntime,
    pub cwd: PathBuf,
    pub home: PathBuf,
    pub setting_sources: Vec<ClaudeSettingSource>,
    pub selector_manifest_sha256: String,
    pub plan_revision: u8,
}

impl ObservationRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1
            || self.plan_revision > 2
            || self.request_id.len() != 36
            || !self.request_id.bytes().enumerate().all(|(index, byte)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            })
            || self.selector_manifest_sha256.len() != 64
            || !self
                .selector_manifest_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(
                "Claude observation request binding is invalid; retain inputs and reprepare".into(),
            );
        }
        validate_sources(&self.setting_sources)?;
        validate_path(&self.cwd)?;
        validate_path(&self.home)?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservationReply {
    pub request_sha256: String,
    pub observation: NativeObservation,
}

impl ObservationReply {
    pub fn validate_for_request(
        &self,
        request: &ObservationRequest,
        request_sha256: &str,
    ) -> Result<(), String> {
        request.validate()?;
        self.observation.validate()?;
        let observed = &self.observation;
        if request_sha256.len() != 64
            || !request_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || self.request_sha256 != request_sha256
            || observed.native_source_runtime != request.native_source_runtime
            || observed.setting_sources != request.setting_sources
            || observed.cwd != request.cwd
            || observed.home.as_ref() != Some(&request.home)
            || observed.uid != observed.euid
            || observed.gid != observed.egid
        {
            return Err("Claude source observation does not match the selected native request; retain inputs and reprepare".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeObservation {
    pub version: u8,
    pub native_source_runtime: NativeSourceRuntime,
    pub setting_sources: Vec<ClaudeSettingSource>,
    pub uid: u32,
    pub euid: u32,
    pub gid: u32,
    pub egid: u32,
    pub cwd: PathBuf,
    pub home: Option<PathBuf>,
    pub roots: Option<git::Roots>,
    pub local_decision: LocalDecision,
    pub root_uid: Option<u32>,
    pub git_uid: Option<u32>,
    pub claude_uid: Option<u32>,
    pub local_settings: Vec<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalDecision {
    Disabled,
    NoRoot,
    CwdRoot,
    HomeUnavailable,
    HomeRoot,
    RootUnavailable,
    RootOwnerMismatch,
    GitUnavailable,
    GitOwnerMismatch,
    ClaudeUnavailable,
    ClaudeOwnerMismatch,
    QualifiedCanonical,
}

#[cfg(unix)]
pub fn observe(
    cwd: &Path,
    home: &Path,
    runtime: NativeSourceRuntime,
    setting_sources: &[ClaudeSettingSource],
) -> Result<NativeObservation, String> {
    validate_sources(setting_sources)?;
    validate_path(cwd)?;
    validate_path(home)?;
    let cwd = std::fs::canonicalize(cwd)
        .map_err(|_| "Claude native launch cwd is unavailable; retain inputs and repair it")?;
    if !std::fs::metadata(&cwd).is_ok_and(|metadata| metadata.is_dir()) {
        return Err(
            "Claude native launch cwd is not a directory; retain inputs and repair it".into(),
        );
    }
    let local_enabled = setting_sources.contains(&ClaudeSettingSource::Local);
    let roots = if local_enabled || setting_sources.contains(&ClaudeSettingSource::Project) {
        git::roots(&cwd, runtime)?
    } else {
        None
    };
    let home = std::fs::canonicalize(home).ok();
    let mut observation = NativeObservation {
        version: 1,
        native_source_runtime: runtime,
        setting_sources: setting_sources.to_vec(),
        uid: unsafe { libc::getuid() },
        euid: unsafe { libc::geteuid() },
        gid: unsafe { libc::getgid() },
        egid: unsafe { libc::getegid() },
        local_decision: LocalDecision::Disabled,
        root_uid: None,
        git_uid: None,
        claude_uid: None,
        local_settings: if local_enabled {
            vec![cwd.join(".claude/settings.local.json")]
        } else {
            Vec::new()
        },
        cwd,
        home,
        roots,
    };
    if local_enabled {
        observation.local_decision = select_local(&mut observation);
    }
    if observation.local_decision == LocalDecision::QualifiedCanonical {
        observation.local_settings.push(
            observation
                .roots
                .as_ref()
                .unwrap()
                .canonical
                .join(".claude/settings.local.json"),
        );
    }
    observation.validate()?;
    Ok(observation)
}

fn validate_sources(sources: &[ClaudeSettingSource]) -> Result<(), String> {
    if sources.len() > 3
        || sources
            .iter()
            .enumerate()
            .any(|(index, source)| sources[..index].contains(source))
    {
        return Err(
            "Claude source observation flags are invalid; retain inputs and reprepare".into(),
        );
    }
    Ok(())
}

fn validate_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path.as_os_str().len() > 64 * 1024
        || path
            .to_str()
            .is_none_or(|raw| raw.chars().any(char::is_control))
    {
        return Err("Claude source observation path profile exceeded; retain inputs and repair the selected path".into());
    }
    Ok(())
}

impl NativeObservation {
    pub fn validate(&self) -> Result<(), String> {
        validate_sources(&self.setting_sources)?;
        let local_enabled = self.setting_sources.contains(&ClaudeSettingSource::Local);
        if self.version != 1
            || self.local_settings.len() > 2
            || local_enabled != (self.local_decision != LocalDecision::Disabled)
            || local_enabled != !self.local_settings.is_empty()
            || (!self.local_settings.is_empty()
                && self.local_settings[0] != self.cwd.join(".claude/settings.local.json"))
            || (!local_enabled
                && (self.root_uid.is_some() || self.git_uid.is_some() || self.claude_uid.is_some()))
            || (!local_enabled
                && !self.setting_sources.contains(&ClaudeSettingSource::Project)
                && self.roots.is_some())
            || !self.decision_evidence_matches()
            || (self.local_decision == LocalDecision::QualifiedCanonical)
                != (self.local_settings.len() == 2)
            || (self.local_settings.len() == 2
                && self.roots.as_ref().is_none_or(|roots| {
                    roots.canonical == self.cwd
                        || self.local_settings[1]
                            != roots.canonical.join(".claude/settings.local.json")
                }))
        {
            return Err(
                "Claude source observation metadata is invalid; retain inputs and reprepare".into(),
            );
        }
        for path in std::iter::once(&self.cwd)
            .chain(self.home.iter())
            .chain(
                self.roots
                    .iter()
                    .flat_map(|roots| [&roots.checkout, &roots.canonical]),
            )
            .chain(&self.local_settings)
        {
            validate_path(path)?;
        }
        Ok(())
    }

    fn decision_evidence_matches(&self) -> bool {
        let ownership_absent =
            self.root_uid.is_none() && self.git_uid.is_none() && self.claude_uid.is_none();
        match self.local_decision {
            LocalDecision::Disabled => ownership_absent,
            LocalDecision::NoRoot => self.roots.is_none() && ownership_absent,
            LocalDecision::CwdRoot => {
                self.roots
                    .as_ref()
                    .is_some_and(|roots| roots.canonical == self.cwd)
                    && ownership_absent
            }
            decision => {
                let Some(roots) = &self.roots else {
                    return false;
                };
                if roots.canonical == self.cwd {
                    return false;
                }
                match decision {
                    LocalDecision::HomeUnavailable => self.home.is_none() && ownership_absent,
                    LocalDecision::HomeRoot => {
                        self.home.as_ref() == Some(&roots.canonical) && ownership_absent
                    }
                    _ => {
                        if self
                            .home
                            .as_ref()
                            .is_none_or(|home| home == &roots.canonical)
                        {
                            return false;
                        }
                        match decision {
                            LocalDecision::RootUnavailable => ownership_absent,
                            LocalDecision::RootOwnerMismatch => {
                                self.root_uid.is_some_and(|uid| uid != self.uid)
                                    && self.git_uid.is_none()
                                    && self.claude_uid.is_none()
                            }
                            LocalDecision::GitUnavailable => {
                                self.root_uid == Some(self.uid)
                                    && self.git_uid.is_none()
                                    && self.claude_uid.is_none()
                            }
                            LocalDecision::GitOwnerMismatch => {
                                self.root_uid == Some(self.uid)
                                    && self.git_uid.is_some_and(|uid| uid != self.uid)
                                    && self.claude_uid.is_none()
                            }
                            LocalDecision::ClaudeUnavailable => {
                                self.root_uid == Some(self.uid)
                                    && self.git_uid == Some(self.uid)
                                    && self.claude_uid.is_none()
                            }
                            LocalDecision::ClaudeOwnerMismatch => {
                                self.root_uid == Some(self.uid)
                                    && self.git_uid == Some(self.uid)
                                    && self.claude_uid.is_some_and(|uid| uid != self.uid)
                            }
                            LocalDecision::QualifiedCanonical => {
                                self.root_uid == Some(self.uid)
                                    && self.git_uid == Some(self.uid)
                                    && self.claude_uid.is_none_or(|uid| uid == self.uid)
                            }
                            _ => false,
                        }
                    }
                }
            }
        }
    }
}

#[cfg(unix)]
fn select_local(observation: &mut NativeObservation) -> LocalDecision {
    let Some(roots) = &observation.roots else {
        return LocalDecision::NoRoot;
    };
    let root = &roots.canonical;
    if root == &observation.cwd {
        return LocalDecision::CwdRoot;
    }
    let Some(home) = &observation.home else {
        return LocalDecision::HomeUnavailable;
    };
    if root == home {
        return LocalDecision::HomeRoot;
    }
    let Ok(metadata) = std::fs::metadata(root) else {
        return LocalDecision::RootUnavailable;
    };
    observation.root_uid = Some(metadata.uid());
    if metadata.uid() != observation.uid {
        return LocalDecision::RootOwnerMismatch;
    }
    let Ok(metadata) = std::fs::symlink_metadata(root.join(".git")) else {
        return LocalDecision::GitUnavailable;
    };
    observation.git_uid = Some(metadata.uid());
    if metadata.uid() != observation.uid {
        return LocalDecision::GitOwnerMismatch;
    }
    match std::fs::symlink_metadata(root.join(".claude")) {
        Ok(metadata) => {
            observation.claude_uid = Some(metadata.uid());
            if metadata.uid() != observation.uid {
                return LocalDecision::ClaudeOwnerMismatch;
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return LocalDecision::ClaudeUnavailable,
    }
    LocalDecision::QualifiedCanonical
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn claude_native_observation_reply_cannot_be_reused_for_another_selection() {
        let owned = tempfile::tempdir().unwrap();
        let request = ObservationRequest {
            version: 1,
            request_id: "01234567-89ab-4cde-8fab-0123456789ab".into(),
            native_source_runtime: NativeSourceRuntime::Terminal,
            cwd: owned.path().into(),
            home: owned.path().into(),
            setting_sources: vec![ClaudeSettingSource::Local],
            selector_manifest_sha256: "a".repeat(64),
            plan_revision: 0,
        };
        let reply = ObservationReply {
            request_sha256: "b".repeat(64),
            observation: observe(
                &request.cwd,
                &request.home,
                request.native_source_runtime,
                &request.setting_sources,
            )
            .unwrap(),
        };
        reply
            .validate_for_request(&request, &"b".repeat(64))
            .unwrap();
        for field in [
            "request_digest",
            "runtime",
            "cwd",
            "home",
            "sources",
            "identity",
        ] {
            let mut changed = reply.clone();
            match field {
                "request_digest" => changed.request_sha256 = "c".repeat(64),
                "runtime" => changed.observation.native_source_runtime = NativeSourceRuntime::Sdk,
                "cwd" => {
                    changed.observation.cwd = owned.path().join("other");
                    changed.observation.local_settings =
                        vec![changed.observation.cwd.join(".claude/settings.local.json")];
                }
                "home" => changed.observation.home = Some(owned.path().join("other-home")),
                "sources" => {
                    changed.observation.setting_sources.clear();
                    changed.observation.local_settings.clear();
                    changed.observation.local_decision = LocalDecision::Disabled;
                }
                "identity" => changed.observation.euid = changed.observation.uid.wrapping_add(1),
                _ => unreachable!(),
            }
            assert!(
                changed
                    .validate_for_request(&request, &"b".repeat(64))
                    .is_err(),
                "different {field} must not qualify the selected native source request"
            );
        }
    }

    #[test]
    fn claude_native_observation_rejects_non_directory_cwd_without_changing_prior_inputs() {
        let owned = tempfile::tempdir().unwrap();
        let prior = owned.path().join("prior-accepted-inputs");
        std::fs::write(&prior, b"prior-accepted-inputs").unwrap();
        let error = observe(
            &prior,
            owned.path(),
            NativeSourceRuntime::Terminal,
            &super::super::default_setting_sources(),
        )
        .expect_err("a file cannot be accepted as the native launch cwd");
        assert!(error.contains("launch cwd is not a directory"));
        assert_eq!(std::fs::read(&prior).unwrap(), b"prior-accepted-inputs");
    }

    #[test]
    fn claude_native_observation_consumes_cwd_then_qualified_canonical_local_settings() {
        for runtime in [NativeSourceRuntime::Terminal, NativeSourceRuntime::Sdk] {
            let owned = tempfile::tempdir().unwrap();
            let home = owned.path().join("home");
            let main = owned.path().join("canonical");
            let checkout = owned.path().join("checkout");
            let cwd = checkout.join("nested");
            let gitdir = main.join(".git/worktrees/fixture");
            for path in [&home, &gitdir, &cwd.join(".claude"), &main.join(".claude")] {
                std::fs::create_dir_all(path).unwrap();
            }
            std::fs::write(
                checkout.join(".git"),
                format!("gitdir: {}\n", gitdir.display()),
            )
            .unwrap();
            std::fs::write(gitdir.join("commondir"), "../..\n").unwrap();
            std::fs::write(
                gitdir.join("gitdir"),
                format!("{}\n", checkout.join(".git").display()),
            )
            .unwrap();
            std::fs::write(
                cwd.join(".claude/settings.local.json"),
                br#"{"env":{"SELECTED":"cwd","CWD_ONLY":"retained"}}"#,
            )
            .unwrap();
            std::fs::write(
                main.join(".claude/settings.local.json"),
                br#"{"env":{"SELECTED":"canonical"}}"#,
            )
            .unwrap();
            let observed = observe(
                &cwd,
                &home,
                runtime,
                &super::super::default_setting_sources(),
            )
            .unwrap();
            assert_eq!(observed.uid, unsafe { libc::getuid() });
            assert_eq!(observed.euid, unsafe { libc::geteuid() });
            assert_eq!(observed.roots.as_ref().unwrap().canonical, main);
            let mut consumed = serde_json::Map::new();
            for path in &observed.local_settings {
                let settings: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
                consumed.extend(settings["env"].as_object().unwrap().clone());
            }
            assert_eq!(
                consumed["SELECTED"], "canonical",
                "canonical local settings override cwd local settings"
            );
            assert_eq!(consumed["CWD_ONLY"], "retained");
            assert_eq!(
                observed.local_settings,
                [
                    cwd.join(".claude/settings.local.json"),
                    main.join(".claude/settings.local.json")
                ]
            );
        }
    }

    #[test]
    fn claude_native_observation_disabled_sources_leave_unselected_git_metadata_untouched() {
        let owned = tempfile::tempdir().unwrap();
        let marker = owned.path().join(".git");
        let file = std::fs::File::create(&marker).unwrap();
        let bytes = crate::provider_input_profiles::MAX_SOURCE_VIEW_BYTES + 1;
        file.set_len(bytes).unwrap();
        let observed = observe(owned.path(), owned.path(), NativeSourceRuntime::Sdk, &[])
            .expect("disabled project/local sources cannot select oversized Git metadata");
        assert!(observed.roots.is_none());
        assert!(observed.local_settings.is_empty());
        assert_eq!(std::fs::metadata(&marker).unwrap().len(), bytes);
    }

    #[test]
    fn claude_native_observation_rejects_incomplete_or_contradictory_qualified_metadata() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let root = owned.path().join("root");
        let cwd = root.join("nested");
        for path in [&home, &root.join(".git"), &cwd] {
            std::fs::create_dir_all(path).unwrap();
        }
        let accepted = observe(
            &cwd,
            &home,
            NativeSourceRuntime::Terminal,
            &[ClaudeSettingSource::Local],
        )
        .unwrap();
        assert_eq!(accepted.local_decision, LocalDecision::QualifiedCanonical);
        for field in ["rootUid", "gitUid", "uid", "home", "roots"] {
            let mut transport = serde_json::to_value(&accepted).unwrap();
            if field == "uid" {
                transport[field] = serde_json::json!(accepted.uid.wrapping_add(1));
            } else {
                transport[field] = serde_json::Value::Null;
            }
            let reply: NativeObservation = serde_json::from_value(transport).unwrap();
            assert!(reply.validate().is_err(), "incomplete or contradictory {field} must block instead of qualifying a canonical source");
        }
        assert!(accepted.validate().is_ok());
        assert_eq!(
            std::fs::metadata(root.join(".git")).unwrap().uid(),
            unsafe { libc::getuid() }
        );
    }
}
