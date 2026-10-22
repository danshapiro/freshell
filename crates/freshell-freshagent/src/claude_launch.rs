//! Which conversation a claude sidecar boots (core-runtime design §4.2 and §5.1,
//! protocol v2).
//!
//! Every `create` line Rust writes to a claude sidecar names its stdio protocol
//! ([`SIDECAR_PROTOCOL`]) and a [`ClaudeBoot`]: a fresh conversation, a resume, or a
//! fork of a parent conversation at a point. The sidecar maps the boot onto the SDK's
//! `query()` options (`crates/freshell-claude-sidecar/boot.mjs`) and answers
//! `created` only once the CLI has booted it (`claude_handshake`).

use serde_json::{json, Map, Value};

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
