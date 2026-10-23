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

use serde::{Deserialize, Serialize};
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

/// How a session that has no transcript yet came to be (design §4.1). The
/// session's binding row records it (`BindingRow.genesis`, opaque to the
/// ledger) until the transcript has been observed on disk, so a launch before
/// then boots the same conversation again, a snapshot shows what the session
/// holds, and reconcile restarts the session instead of declaring it dead.
///
/// Wire shape: `{"kind":"fresh"}`, or
/// `{"kind":"fork","parent":P,"at":U?,"dropsTurn":D?}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClaudeGenesis {
    /// A new conversation, booted under the session's own id (T3).
    Fresh,
    /// A lazy fork of `parent` holding its conversation through `at` (all of
    /// it when `None`), booted under the session's own id (T6). `drops_turn`
    /// arms the SDK's guard that the discarded part starts with that turn's
    /// prompt.
    Fork {
        parent: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        drops_turn: Option<String>,
    },
}

impl ClaudeGenesis {
    /// The genesis as the binding row stores it.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("a claude genesis always serializes")
    }

    /// The genesis a binding row stores, or `None` for a shape this server does
    /// not know (a newer server's kind): the caller then treats the session as
    /// having no genesis, which is what an older server does.
    pub fn from_value(value: &Value) -> Option<Self> {
        serde_json::from_value(value.clone()).ok()
    }

    /// The genesis's kind as the logs name it.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Fresh => "fresh",
            Self::Fork { .. } => "fork",
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
    /// The id a fresh or forked boot writes the conversation under (the
    /// session's own id when it boots from its genesis, design §4.2).
    pub(crate) session_id: Option<String>,
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
            session_id: None,
        }
    }

    /// This launch writing a fresh or forked conversation under `session_id`.
    pub(crate) fn with_session_id(mut self, session_id: Option<String>) -> Self {
        self.session_id = session_id;
        self
    }

    /// This launch carrying the client's `modelSelection` (a create's).
    pub(crate) fn with_model_selection(mut self, model_selection: Option<Value>) -> Self {
        self.model_selection = model_selection.filter(|selection| !selection.is_null());
        self
    }

    /// The sidecar `create` line. Every line carries the same keys, whatever
    /// the launch: `type`, `protocol`, `requestId`, `sessionType`, `boot`, and
    /// `sessionId`, `cwd`, `model`, `permissionMode`, `effort`, `plugins` (each
    /// `null` when unset) and `hostedMcp`; `modelSelection` only when the
    /// launch has one.
    pub(crate) fn create_request(&self) -> Value {
        let mut line = Map::new();
        line.insert("type".into(), json!("create"));
        line.insert("protocol".into(), json!(SIDECAR_PROTOCOL));
        line.insert("requestId".into(), json!(self.request_id));
        line.insert("sessionType".into(), json!(self.session_type));
        line.insert("boot".into(), self.boot.wire());
        line.insert("sessionId".into(), json!(self.session_id));
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
        /// The id a fresh or forked boot writes the conversation under: the
        /// session's own id when it boots from its genesis. `None` for a
        /// resume (the conversation already has its id).
        session_id: Option<String>,
    },
    /// The store holds no transcript for the session: it is gone.
    Lost,
    /// The store could not be checked. Never lost: the caller answers a
    /// retryable failure.
    Transient(LocateError),
}

/// Which conversation a session boots (design §4.2), from where its transcript
/// is and the genesis its binding row records:
///
/// | transcript | genesis | boot |
/// |---|---|---|
/// | found | any (cleared lazily) | resume it |
/// | absent | `Fresh` | a fresh conversation under the session's id |
/// | absent | `Fork` | the lazy fork of the parent, under the session's id, from the parent's recorded directory; lost when the parent is gone |
/// | absent | none | lost |
/// | unreadable | any | transient, never lost |
///
/// `locate` finds a fork genesis's parent transcript.
pub(crate) fn decide_boot(
    session_id: &str,
    location: TranscriptLocation,
    genesis: Option<&ClaudeGenesis>,
    locate: impl Fn(&str) -> TranscriptLocation,
) -> BootDecision {
    match (location, genesis) {
        (TranscriptLocation::Found(path), _) => {
            let (resume, cwd) = resume_target(session_id, &path);
            BootDecision::Boot {
                boot: ClaudeBoot::Resume { resume },
                cwd,
                session_id: None,
            }
        }
        (TranscriptLocation::Unreadable(error), _) => BootDecision::Transient(error),
        (TranscriptLocation::Absent, None) => BootDecision::Lost,
        (TranscriptLocation::Absent, Some(ClaudeGenesis::Fresh)) => BootDecision::Boot {
            boot: ClaudeBoot::Fresh,
            cwd: None,
            session_id: Some(session_id.to_string()),
        },
        (
            TranscriptLocation::Absent,
            Some(ClaudeGenesis::Fork {
                parent,
                at,
                drops_turn,
            }),
        ) => match locate(parent) {
            TranscriptLocation::Found(parent_path) => {
                let (resume, cwd) = resume_target(parent, &parent_path);
                BootDecision::Boot {
                    boot: ClaudeBoot::Fork {
                        resume,
                        at: at.clone(),
                        drops_turn: drops_turn.clone(),
                    },
                    cwd,
                    session_id: Some(session_id.to_string()),
                }
            }
            TranscriptLocation::Absent => BootDecision::Lost,
            TranscriptLocation::Unreadable(error) => BootDecision::Transient(error),
        },
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

    /// The stored genesis is the one the binding row keeps: it reads back as
    /// written, and the ledger rows other crates seed (`{"kind":"fresh"}`,
    /// `{"kind":"fork",...}`) read as the genesis they name.
    #[test]
    fn a_genesis_reads_back_from_the_shape_the_binding_row_stores() {
        let fork = ClaudeGenesis::Fork {
            parent: "P".into(),
            at: Some("a1".into()),
            drops_turn: Some("u2".into()),
        };
        for genesis in [
            ClaudeGenesis::Fresh,
            fork.clone(),
            ClaudeGenesis::Fork {
                parent: "P".into(),
                at: None,
                drops_turn: None,
            },
        ] {
            assert_eq!(
                ClaudeGenesis::from_value(&genesis.to_value()),
                Some(genesis)
            );
        }
        assert_eq!(
            ClaudeGenesis::from_value(&json!({ "kind": "fresh" })),
            Some(ClaudeGenesis::Fresh)
        );
        assert_eq!(
            ClaudeGenesis::from_value(
                &json!({ "kind": "fork", "parent": "P", "at": "a1", "dropsTurn": "u2" })
            ),
            Some(fork)
        );
        // A kind this server does not know reads as no genesis.
        assert_eq!(
            ClaudeGenesis::from_value(&json!({ "kind": "clone", "parent": "P" })),
            None
        );
        assert_eq!(
            crate::identity_sink::RecordedGenesis::from_row(
                "claude",
                "S",
                Some(&json!({ "kind": "clone" })),
                1
            ),
            None
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
                "sessionId": null,
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
            decide_boot("S", TranscriptLocation::Found(path), None, no_parent),
            BootDecision::Boot {
                boot: ClaudeBoot::Resume { resume: "S".into() },
                cwd: Some(cwd),
                session_id: None,
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
            decide_boot(
                "S",
                TranscriptLocation::Found(path.clone()),
                None,
                no_parent
            ),
            BootDecision::Boot {
                boot: ClaudeBoot::Resume {
                    resume: path.to_string_lossy().to_string()
                },
                cwd: None,
                session_id: None,
            }
        );
    }

    #[test]
    fn an_empty_found_transcript_resumes_by_id() {
        let store = tempfile::tempdir().unwrap();
        let path = transcript(store.path(), "S", "");
        assert_eq!(
            decide_boot("S", TranscriptLocation::Found(path), None, no_parent),
            BootDecision::Boot {
                boot: ClaudeBoot::Resume { resume: "S".into() },
                cwd: None,
                session_id: None,
            }
        );
    }

    #[test]
    fn an_absent_transcript_is_lost_and_an_unreadable_store_is_transient() {
        assert_eq!(
            decide_boot("S", TranscriptLocation::Absent, None, no_parent),
            BootDecision::Lost
        );
        let error = LocateError::Io {
            root: "/store".into(),
            kind: std::io::ErrorKind::PermissionDenied,
            message: "denied".into(),
        };
        assert_eq!(
            decide_boot(
                "S",
                TranscriptLocation::Unreadable(error.clone()),
                None,
                no_parent
            ),
            BootDecision::Transient(error)
        );
        assert_eq!(
            decide_boot(
                "S",
                TranscriptLocation::Unreadable(LocateError::NoStoreRoot),
                None,
                no_parent
            ),
            BootDecision::Transient(LocateError::NoStoreRoot)
        );
    }

    /// A session with no genesis has no parent to look up.
    fn no_parent(id: &str) -> TranscriptLocation {
        panic!("decide_boot looked up {id} for a session with no fork genesis")
    }

    fn fork_genesis(parent: &str) -> ClaudeGenesis {
        ClaudeGenesis::Fork {
            parent: parent.into(),
            at: Some("a1".into()),
            drops_turn: Some("u2".into()),
        }
    }

    /// §4.2: the transcript is the truth once it exists. A genesis not yet
    /// cleared (the lazy clear runs after the first result) never makes a
    /// conversation boot again from scratch.
    #[test]
    fn a_found_transcript_resumes_whatever_the_genesis_says() {
        let store = tempfile::tempdir().unwrap();
        let path = transcript(store.path(), "S", "");
        for genesis in [ClaudeGenesis::Fresh, fork_genesis("P")] {
            assert_eq!(
                decide_boot(
                    "S",
                    TranscriptLocation::Found(path.clone()),
                    Some(&genesis),
                    no_parent
                ),
                BootDecision::Boot {
                    boot: ClaudeBoot::Resume { resume: "S".into() },
                    cwd: None,
                    session_id: None,
                },
                "{genesis:?}"
            );
        }
    }

    /// §4.2/§4.3: a zero-turn session (create, no send, then a restart or a
    /// crash) boots a fresh conversation under its own id again (T3: nothing is
    /// on disk, so the id cannot collide).
    #[test]
    fn an_absent_transcript_with_a_fresh_genesis_boots_fresh_under_its_own_id() {
        assert_eq!(
            decide_boot(
                "S",
                TranscriptLocation::Absent,
                Some(&ClaudeGenesis::Fresh),
                no_parent
            ),
            BootDecision::Boot {
                boot: ClaudeBoot::Fresh,
                cwd: None,
                session_id: Some("S".into()),
            }
        );
    }

    /// §4.2/§4.3: a pending fork (undo, then a restart before sending) boots
    /// the same lazy fork of its parent again under its own id (T6), from the
    /// parent's recorded directory, where the CLI finds the parent by id.
    #[test]
    fn an_absent_transcript_with_a_fork_genesis_boots_the_fork_under_its_own_id() {
        let store = tempfile::tempdir().unwrap();
        let recorded = tempfile::tempdir().unwrap();
        let cwd = recorded.path().to_str().unwrap().to_string();
        let parent = transcript(
            store.path(),
            "P",
            &format!("{{\"type\":\"user\",\"cwd\":{}}}\n", json!(cwd)),
        );
        let locate = |id: &str| {
            assert_eq!(id, "P", "only the parent is looked up");
            TranscriptLocation::Found(parent.clone())
        };
        assert_eq!(
            decide_boot(
                "S",
                TranscriptLocation::Absent,
                Some(&fork_genesis("P")),
                locate
            ),
            BootDecision::Boot {
                boot: ClaudeBoot::Fork {
                    resume: "P".into(),
                    at: Some("a1".into()),
                    drops_turn: Some("u2".into()),
                },
                cwd: Some(cwd),
                session_id: Some("S".into()),
            }
        );
    }

    /// A pending fork whose parent is gone cannot boot (the CLI refuses it), so
    /// the session is lost; a parent store that cannot be checked is transient.
    #[test]
    fn a_fork_genesis_whose_parent_is_gone_is_lost_and_an_unreadable_parent_transient() {
        assert_eq!(
            decide_boot(
                "S",
                TranscriptLocation::Absent,
                Some(&fork_genesis("P")),
                |_: &str| TranscriptLocation::Absent
            ),
            BootDecision::Lost
        );
        let error = LocateError::Io {
            root: "/store".into(),
            kind: std::io::ErrorKind::PermissionDenied,
            message: "denied".into(),
        };
        assert_eq!(
            decide_boot(
                "S",
                TranscriptLocation::Absent,
                Some(&fork_genesis("P")),
                |_: &str| TranscriptLocation::Unreadable(error.clone())
            ),
            BootDecision::Transient(error)
        );
    }

    /// G28 holds with a genesis too: a store that cannot be checked may hold
    /// the transcript, so nothing boots from the genesis.
    #[test]
    fn an_unreadable_store_is_transient_whatever_the_genesis_says() {
        assert_eq!(
            decide_boot(
                "S",
                TranscriptLocation::Unreadable(LocateError::NoStoreRoot),
                Some(&ClaudeGenesis::Fresh),
                no_parent
            ),
            BootDecision::Transient(LocateError::NoStoreRoot)
        );
    }

    /// The create line names the id a fresh or forked boot writes under
    /// (`sessionId`, the sidecar's `bootOptions` input), null when the launch
    /// has none.
    #[test]
    fn a_create_line_names_the_id_a_genesis_boot_writes_under() {
        let spec = ClaudeLaunchSpec::new(
            "req",
            "freshclaude",
            ClaudeBoot::Fresh,
            None,
            &FreshAgentSettings::default(),
            false,
        );
        assert_eq!(spec.create_request().get("sessionId"), Some(&Value::Null));
        assert_eq!(
            spec.with_session_id(Some("S".into())).create_request()["sessionId"],
            json!("S")
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
