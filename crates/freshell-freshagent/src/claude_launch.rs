//! How a claude sidecar is launched (core-runtime design §3.2, §4.2 and §5.1,
//! protocol v2).
//!
//! Every launch (a create, an attach that resumes an untracked session, a
//! handoff resume, a rollback respawn) describes itself as one
//! [`ClaudeLaunchSpec`], and [`ClaudeLaunchSpec::create_request`] is the only
//! builder of the sidecar's `create` line. So no launch can drop a field another
//! carries: the pane's plugins and the hosted Freshell MCP reach the CLI on every
//! launch (G15).
//!
//! The line names its stdio protocol ([`SIDECAR_PROTOCOL`]) and a [`ClaudeBoot`]:
//! a fresh conversation, a resume, or a fork of a parent conversation at a point.
//! The sidecar maps the boot onto the SDK's `query()` options
//! (`crates/freshell-claude-sidecar/boot.mjs`) and answers `created` only once
//! the CLI has booted it (`claude_handshake`). [`decide_boot`] picks the boot of
//! a session that has a durable id from where its transcript is.

use std::path::Path;

use serde_json::{json, Map, Value};

use crate::claude_snapshot::{LocateError, TranscriptLocation};
use crate::identity_sink::FreshAgentSettings;

/// The claude sidecar stdio protocol this server speaks: `create.protocol` and
/// `created.protocol` (`crates/freshell-claude-sidecar/boot.mjs`).
pub(crate) const SIDECAR_PROTOCOL: u64 = 2;

/// The conversation a sidecar boots.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ClaudeBoot {
    /// A new conversation.
    Fresh,
    /// An existing conversation: its id, or its transcript path when the
    /// conversation's original directory is gone.
    Resume { resume: String },
    /// A new conversation holding `resume`'s transcript through `at` (all of it
    /// when `None`). `drops_turn` arms the SDK's guard that the discarded part
    /// starts with that turn's prompt.
    Fork {
        resume: String,
        at: Option<String>,
        drops_turn: Option<String>,
    },
}

impl ClaudeBoot {
    /// `Resume` of `resume` when there is one, else `Fresh`.
    pub(crate) fn resume_or_fresh(resume: Option<&str>) -> Self {
        match resume {
            Some(resume) => Self::Resume {
                resume: resume.to_string(),
            },
            None => Self::Fresh,
        }
    }

    /// The boot's kind as the protocol and the logs name it.
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::Fresh => "fresh",
            Self::Resume { .. } => "resume",
            Self::Fork { .. } => "fork",
        }
    }

    /// The `create.boot` value.
    pub(crate) fn wire(&self) -> Value {
        match self {
            Self::Fresh => json!({ "kind": "fresh" }),
            Self::Resume { resume } => json!({ "kind": "resume", "resume": resume }),
            Self::Fork {
                resume,
                at,
                drops_turn,
            } => {
                let mut boot = Map::new();
                boot.insert("kind".into(), json!("fork"));
                boot.insert("resume".into(), json!(resume));
                if let Some(at) = at {
                    boot.insert("resumeSessionAt".into(), json!(at));
                }
                if let Some(drops_turn) = drops_turn {
                    boot.insert("dropsTurn".into(), json!(drops_turn));
                }
                Value::Object(boot)
            }
        }
    }
}

/// Everything one sidecar launch hands the sidecar: the one input of every
/// `create` line (design §4.9). Built by each launch from the session's settings,
/// so the plugins and the hosted MCP selection travel with every launch.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ClaudeLaunchSpec {
    /// The create request's id (the sidecar answers `created` with it).
    pub(crate) request_id: String,
    /// `freshclaude` or `kilroy`.
    pub(crate) session_type: String,
    pub(crate) boot: ClaudeBoot,
    /// Where the CLI runs.
    pub(crate) cwd: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) permission_mode: Option<String>,
    pub(crate) effort: Option<String>,
    /// The pane's local plugin directories.
    pub(crate) plugins: Option<Vec<String>>,
    /// The lane selects the hosted Freshell MCP (a hosted session host's lane).
    pub(crate) hosted_mcp: bool,
    /// The client's `modelSelection` on a create, passed through as sent.
    pub(crate) model_selection: Option<Value>,
}

impl ClaudeLaunchSpec {
    /// A launch of `boot` for a `session_type` session running in `cwd`, with
    /// the session's `settings` (model, permission mode, effort, plugins) and
    /// the lane's hosted MCP selection. The settings' own `cwd` is the session's
    /// recorded one; the launch says where this CLI runs.
    pub(crate) fn new(
        request_id: impl Into<String>,
        session_type: &str,
        boot: ClaudeBoot,
        cwd: Option<String>,
        settings: &FreshAgentSettings,
        hosted_mcp: bool,
    ) -> Self {
        Self {
            request_id: request_id.into(),
            session_type: session_type.to_string(),
            boot,
            cwd,
            model: settings.model.clone(),
            permission_mode: settings.permission_mode.clone(),
            effort: settings.effort.clone(),
            plugins: settings.plugins.clone(),
            hosted_mcp,
            model_selection: None,
        }
    }

    /// This launch carrying the client's `modelSelection` (a create's).
    pub(crate) fn with_model_selection(mut self, model_selection: Option<Value>) -> Self {
        self.model_selection = model_selection.filter(|selection| !selection.is_null());
        self
    }

    /// The sidecar `create` line. Every line carries the same keys, whatever
    /// the launch: `type`, `protocol`, `requestId`, `sessionType`, `boot`, and
    /// `cwd`, `model`, `permissionMode`, `effort`, `plugins` (each `null` when
    /// unset) and `hostedMcp`; `modelSelection` only when the launch has one.
    pub(crate) fn create_request(&self) -> Value {
        let mut line = Map::new();
        line.insert("type".into(), json!("create"));
        line.insert("protocol".into(), json!(SIDECAR_PROTOCOL));
        line.insert("requestId".into(), json!(self.request_id));
        line.insert("sessionType".into(), json!(self.session_type));
        line.insert("boot".into(), self.boot.wire());
        line.insert("cwd".into(), json!(self.cwd));
        line.insert("model".into(), json!(self.model));
        line.insert("permissionMode".into(), json!(self.permission_mode));
        line.insert("effort".into(), json!(self.effort));
        line.insert("plugins".into(), json!(self.plugins));
        line.insert("hostedMcp".into(), json!(self.hosted_mcp));
        if let Some(selection) = &self.model_selection {
            line.insert("modelSelection".into(), selection.clone());
        }
        Value::Object(line)
    }
}

/// What [`decide_boot`] found for a session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BootDecision {
    /// Boot this. `cwd` is the directory the conversation was recorded in, when
    /// it still exists: the CLI finds a conversation by id only from the
    /// directory it ran in (ledger A15), so a resume runs there.
    Boot {
        boot: ClaudeBoot,
        cwd: Option<String>,
    },
    /// The store holds no transcript for the session: it is gone.
    Lost,
    /// The store could not be checked. Never lost: the caller answers a
    /// retryable failure.
    Transient(LocateError),
}

/// Which conversation a session boots, from where its transcript is (design
/// §4.2): a found transcript resumes, an absent one is lost, and a store that
/// could not be checked is transient. The genesis rows of §4.2 (a session with
/// no transcript yet that may still boot) arrive with the binding row's genesis
/// (C12).
pub(crate) fn decide_boot(session_id: &str, location: TranscriptLocation) -> BootDecision {
    match location {
        TranscriptLocation::Found(path) => {
            let (resume, cwd) = resume_target(session_id, &path);
            BootDecision::Boot {
                boot: ClaudeBoot::Resume { resume },
                cwd,
            }
        }
        TranscriptLocation::Absent => BootDecision::Lost,
        TranscriptLocation::Unreadable(error) => BootDecision::Transient(error),
    }
}

/// How to name the conversation `session_id`, whose transcript is at `path`, to
/// a resume (or a fork of it), and the directory to run that CLI in: the id and
/// the recorded directory while that directory exists. Once it is gone, the
/// transcript's path (the CLI resumes a path without the directory scoping,
/// verified cli.js 2.1.220), unless the transcript is empty: an empty one has
/// nothing to resume by path, and a path there would make the CLI write a
/// second, path-named conversation.
pub(crate) fn resume_target(session_id: &str, path: &Path) -> (String, Option<String>) {
    let recorded_cwd =
        crate::claude_snapshot::transcript_cwd(path).filter(|cwd| Path::new(cwd).is_dir());
    if recorded_cwd.is_some() {
        return (session_id.to_string(), recorded_cwd);
    }
    let has_records = std::fs::metadata(path)
        .map(|meta| meta.len() > 0)
        .unwrap_or(false);
    let resume = if has_records {
        path.to_string_lossy().to_string()
    } else {
        session_id.to_string()
    };
    (resume, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_boot_has_its_protocol_v2_wire_shape() {
        assert_eq!(ClaudeBoot::Fresh.wire(), json!({ "kind": "fresh" }));
        assert_eq!(
            ClaudeBoot::Resume { resume: "P".into() }.wire(),
            json!({ "kind": "resume", "resume": "P" })
        );
        assert_eq!(
            ClaudeBoot::Fork {
                resume: "P".into(),
                at: Some("a1".into()),
                drops_turn: Some("u2".into()),
            }
            .wire(),
            json!({ "kind": "fork", "resume": "P", "resumeSessionAt": "a1", "dropsTurn": "u2" })
        );
        // A fork of the whole parent with no guard names neither.
        assert_eq!(
            ClaudeBoot::Fork {
                resume: "P".into(),
                at: None,
                drops_turn: None,
            }
            .wire(),
            json!({ "kind": "fork", "resume": "P" })
        );
    }

    fn settings_with_plugins() -> FreshAgentSettings {
        FreshAgentSettings {
            model: Some("opus".into()),
            permission_mode: Some("plan".into()),
            effort: Some("high".into()),
            cwd: Some("/recorded".into()),
            ..FreshAgentSettings::default()
        }
        .with_plugins(Some(vec!["/w/.claude/plugins/review".into()]))
    }

    #[test]
    fn a_create_line_carries_the_protocol_session_type_boot_and_the_launch() {
        let line = ClaudeLaunchSpec::new(
            "req-1",
            "kilroy",
            ClaudeBoot::Resume { resume: "P".into() },
            Some("/w".into()),
            &settings_with_plugins(),
            true,
        )
        .create_request();
        assert_eq!(
            line,
            json!({
                "type": "create",
                "protocol": SIDECAR_PROTOCOL,
                "requestId": "req-1",
                "sessionType": "kilroy",
                "boot": { "kind": "resume", "resume": "P" },
                "cwd": "/w",
                "model": "opus",
                "permissionMode": "plan",
                "effort": "high",
                "plugins": ["/w/.claude/plugins/review"],
                "hostedMcp": true,
            })
        );
    }

    /// G15: whatever the boot, the line hands the sidecar the session's plugins
    /// and the lane's hosted MCP selection, and names both keys when unset.
    #[test]
    fn every_boot_carries_the_plugins_and_the_hosted_mcp_selection() {
        let boots = [
            ClaudeBoot::Fresh,
            ClaudeBoot::Resume { resume: "P".into() },
            ClaudeBoot::Fork {
                resume: "P".into(),
                at: Some("a1".into()),
                drops_turn: Some("u2".into()),
            },
        ];
        for boot in boots {
            let kind = boot.kind();
            let line = ClaudeLaunchSpec::new(
                "req",
                "freshclaude",
                boot.clone(),
                None,
                &settings_with_plugins(),
                true,
            )
            .create_request();
            assert_eq!(
                line["plugins"],
                json!(["/w/.claude/plugins/review"]),
                "{kind}"
            );
            assert_eq!(line["hostedMcp"], json!(true), "{kind}");
            assert_eq!(line["boot"], boot.wire(), "{kind}");

            let bare = ClaudeLaunchSpec::new(
                "req",
                "freshclaude",
                boot,
                None,
                &FreshAgentSettings::default(),
                false,
            )
            .create_request();
            assert_eq!(bare.get("plugins"), Some(&Value::Null), "{kind}");
            assert_eq!(bare.get("hostedMcp"), Some(&json!(false)), "{kind}");
        }
    }

    #[test]
    fn a_model_selection_rides_the_line_only_when_the_launch_has_one() {
        let spec = ClaudeLaunchSpec::new(
            "req",
            "freshclaude",
            ClaudeBoot::Fresh,
            None,
            &FreshAgentSettings::default(),
            false,
        );
        assert!(spec.create_request().get("modelSelection").is_none());
        let selection = json!({ "kind": "exact", "modelId": "opus" });
        assert_eq!(
            spec.clone()
                .with_model_selection(Some(selection.clone()))
                .create_request()["modelSelection"],
            selection
        );
        assert!(spec
            .with_model_selection(Some(Value::Null))
            .create_request()
            .get("modelSelection")
            .is_none());
    }

    fn transcript(dir: &Path, name: &str, body: &str) -> std::path::PathBuf {
        let path = dir.join(format!("{name}.jsonl"));
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn a_found_transcript_resumes_by_id_from_its_recorded_directory() {
        let store = tempfile::tempdir().unwrap();
        let recorded = tempfile::tempdir().unwrap();
        let cwd = recorded.path().to_str().unwrap().to_string();
        let path = transcript(
            store.path(),
            "S",
            &format!("{{\"type\":\"user\",\"cwd\":{}}}\n", json!(cwd)),
        );
        assert_eq!(
            decide_boot("S", TranscriptLocation::Found(path)),
            BootDecision::Boot {
                boot: ClaudeBoot::Resume { resume: "S".into() },
                cwd: Some(cwd),
            }
        );
    }

    #[test]
    fn a_found_transcript_whose_directory_is_gone_resumes_by_its_path() {
        let store = tempfile::tempdir().unwrap();
        let path = transcript(
            store.path(),
            "S",
            "{\"type\":\"user\",\"cwd\":\"/no/such/directory/anymore\"}\n",
        );
        assert_eq!(
            decide_boot("S", TranscriptLocation::Found(path.clone())),
            BootDecision::Boot {
                boot: ClaudeBoot::Resume {
                    resume: path.to_string_lossy().to_string()
                },
                cwd: None,
            }
        );
    }

    #[test]
    fn an_empty_found_transcript_resumes_by_id() {
        let store = tempfile::tempdir().unwrap();
        let path = transcript(store.path(), "S", "");
        assert_eq!(
            decide_boot("S", TranscriptLocation::Found(path)),
            BootDecision::Boot {
                boot: ClaudeBoot::Resume { resume: "S".into() },
                cwd: None,
            }
        );
    }

    #[test]
    fn an_absent_transcript_is_lost_and_an_unreadable_store_is_transient() {
        assert_eq!(
            decide_boot("S", TranscriptLocation::Absent),
            BootDecision::Lost
        );
        let error = LocateError::Io {
            root: "/store".into(),
            kind: std::io::ErrorKind::PermissionDenied,
            message: "denied".into(),
        };
        assert_eq!(
            decide_boot("S", TranscriptLocation::Unreadable(error.clone())),
            BootDecision::Transient(error)
        );
        assert_eq!(
            decide_boot(
                "S",
                TranscriptLocation::Unreadable(LocateError::NoStoreRoot)
            ),
            BootDecision::Transient(LocateError::NoStoreRoot)
        );
    }

    #[test]
    fn a_resume_id_makes_a_resume_boot_and_none_a_fresh_one() {
        assert_eq!(ClaudeBoot::resume_or_fresh(None), ClaudeBoot::Fresh);
        assert_eq!(
            ClaudeBoot::resume_or_fresh(Some("P")),
            ClaudeBoot::Resume { resume: "P".into() }
        );
        assert_eq!(ClaudeBoot::resume_or_fresh(Some("P")).kind(), "resume");
    }
}
