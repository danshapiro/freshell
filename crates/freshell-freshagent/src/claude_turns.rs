//! freshclaude turn accounting (docs/plans/2026-10-22-freshclaude-core-runtime.md
//! §3.2, §5.1, §5.2).
//!
//! C16: every send the server writes to the sidecar carries a uuid the server
//! minted ([`mint_send_uuid`]). The sidecar puts it on the SDKUserMessage, so the
//! CLI reports the command's lifecycle under it and writes the user line with it:
//! it is the turn id the snapshot shows and the `submittedTurnId` of
//! `freshAgent.send.accepted`. The sidecar forwards the CLI's lifecycle facts
//! ([`SidecarFact`]); they are never client content.
//!
//! C17: the facts feed one pure [`ClaudeTurnLedger`] per session, the busy truth
//! (G08, G23): every command the server sent and the CLI has not ended, the
//! turns the CLI runs (including its own, T19) and its compactions. A result
//! retires every started command, so an absorbed send (T10) ends with the turn
//! that absorbed it, and a send queued behind a turn stays owed until its own
//! result. The session's effective status is derived from it.

use std::collections::VecDeque;

use serde_json::Value;

/// A fresh uuid for one send: the id the CLI keeps for the command and its user
/// line (the canonical lowercase v4 form, as the CLI writes it).
pub(crate) fn mint_send_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// What a send asks the CLI to do: run a turn, or compact (`/compact`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SendKind {
    Turn,
    Compact,
}

impl SendKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Turn => "turn",
            Self::Compact => "compact",
        }
    }
}

/// A sent command's lifecycle state (`sdk.command`, T8). `Replayed` is the
/// sidecar's: the CLI took the command as a user message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CommandState {
    Queued,
    Started,
    Completed,
    Cancelled,
    Discarded,
    Replayed,
}

impl CommandState {
    fn parse(state: &str) -> Option<Self> {
        Some(match state {
            "queued" => Self::Queued,
            "started" => Self::Started,
            "completed" => Self::Completed,
            "cancelled" => Self::Cancelled,
            "discarded" => Self::Discarded,
            "replayed" => Self::Replayed,
            _ => return None,
        })
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Started => "started",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Discarded => "discarded",
            Self::Replayed => "replayed",
        }
    }
}

/// Whether the CLI is working (`sdk.session.state`, T9).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SessionState {
    Running,
    Idle,
    RequiresAction,
}

impl SessionState {
    fn parse(state: &str) -> Option<Self> {
        Some(match state {
            "running" => Self::Running,
            "idle" => Self::Idle,
            "requires_action" => Self::RequiresAction,
            _ => return None,
        })
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Idle => "idle",
            Self::RequiresAction => "requires_action",
        }
    }
}

/// What a heartbeat reports progress on (`sdk.heartbeat`, T17).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HeartbeatKind {
    Tool,
    Task,
    Retry,
}

impl HeartbeatKind {
    fn parse(kind: &str) -> Option<Self> {
        Some(match kind {
            "tool" => Self::Tool,
            "task" => Self::Task,
            "retry" => Self::Retry,
            _ => return None,
        })
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Tool => "tool",
            Self::Task => "task",
            Self::Retry => "retry",
        }
    }
}

/// A send the sidecar refused before the CLI saw it (`sdk.send.rejected`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SendRejection {
    /// The uuid of the refused send (`None` when the send had no valid one).
    pub(crate) uuid: Option<String>,
    /// The sidecar's reason code (`INVALID_IMAGE`, `INVALID_SEND`).
    pub(crate) code: String,
    /// Why, in words the sender can read.
    pub(crate) message: String,
}

/// The reason a rejected send gives when the sidecar named none.
pub(crate) const REJECTED_SEND_FALLBACK_MESSAGE: &str =
    "Claude could not take this message. Send it again.";

/// A fact the sidecar forwards for the server's turn accounting (design §5.1).
/// None of these is client content: they are never broadcast.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SidecarFact {
    /// A sent command's lifecycle (`sdk.command`).
    Command { uuid: String, state: CommandState },
    /// The CLI started or stopped working (`sdk.session.state`).
    SessionState(SessionState),
    /// A model request started (`sdk.status requesting`): turn evidence.
    Requesting,
    /// A compaction started (`sdk.status compacting`, T15).
    Compacting,
    /// A legacy protocol fake's turn status (`sdk.status running|idle`). Only
    /// the protocol fakes send it (until C30 retires them); the real sidecar
    /// reports the CLI's session state instead.
    LegacyStatus(SessionState),
    /// A status ended (`sdk.status null`, T15): a compaction's outcome, or the
    /// permission mode the CLI is in now.
    StatusEnded {
        compact_result: Option<String>,
        compact_error: Option<String>,
        permission_mode: Option<String>,
    },
    /// Liveness (`sdk.heartbeat`).
    Heartbeat {
        kind: HeartbeatKind,
        tool_use_id: Option<String>,
        elapsed_ms: Option<u64>,
    },
    /// The sidecar refused a send before the CLI saw it (`sdk.send.rejected`).
    SendRejected(SendRejection),
}

impl SidecarFact {
    /// The fact a sidecar stdout line carries, if it carries one. Every status
    /// the sidecar reports is a fact: the server publishes the session's status
    /// itself (design §5.2), so no `sdk.status` reaches a client as it came.
    pub(crate) fn from_line(line: &Value) -> Option<Self> {
        let text = |key: &str| line.get(key).and_then(Value::as_str).map(str::to_string);
        match line.get("type")?.as_str()? {
            "sdk.command" => Some(Self::Command {
                uuid: text("uuid")?,
                state: CommandState::parse(line.get("state")?.as_str()?)?,
            }),
            "sdk.session.state" => Some(Self::SessionState(SessionState::parse(
                line.get("state")?.as_str()?,
            )?)),
            "sdk.status" => match line.get("status")? {
                Value::Null => Some(Self::StatusEnded {
                    compact_result: text("compactResult"),
                    compact_error: text("compactError"),
                    permission_mode: text("permissionMode"),
                }),
                Value::String(status) => match status.as_str() {
                    "requesting" => Some(Self::Requesting),
                    "compacting" => Some(Self::Compacting),
                    "running" => Some(Self::LegacyStatus(SessionState::Running)),
                    "idle" => Some(Self::LegacyStatus(SessionState::Idle)),
                    _ => None,
                },
                _ => None,
            },
            "sdk.heartbeat" => Some(Self::Heartbeat {
                kind: HeartbeatKind::parse(line.get("kind")?.as_str()?)?,
                tool_use_id: text("toolUseId"),
                elapsed_ms: line
                    .get("elapsedMs")
                    .and_then(Value::as_f64)
                    .filter(|ms| ms.is_finite() && *ms >= 0.0)
                    .map(|ms| ms.round() as u64),
            }),
            "sdk.send.rejected" => Some(Self::SendRejected(SendRejection {
                uuid: text("uuid"),
                code: text("code").unwrap_or_else(|| "INVALID_SEND".to_string()),
                message: text("message")
                    .unwrap_or_else(|| REJECTED_SEND_FALLBACK_MESSAGE.to_string()),
            })),
            _ => None,
        }
    }

    /// Log a lifecycle fact at debug (ids and states only). A rejected send is
    /// logged where it is handled, with the request it takes back.
    pub(crate) fn log(&self, session_id: &str, session_type: &str) {
        const TARGET: &str = "freshell_freshagent::claude";
        match self {
            Self::Command { uuid, state } => tracing::debug!(target: TARGET,
                provider = "claude", session_id, session_type, uuid = %uuid,
                state = state.as_str(), "freshagent.claude.command"),
            Self::SessionState(state) => tracing::debug!(target: TARGET,
                provider = "claude", session_id, session_type, state = state.as_str(),
                "freshagent.claude.session_state"),
            Self::Requesting => tracing::debug!(target: TARGET,
                provider = "claude", session_id, session_type, status = "requesting",
                "freshagent.claude.status_fact"),
            Self::Compacting => tracing::debug!(target: TARGET,
                provider = "claude", session_id, session_type, status = "compacting",
                "freshagent.claude.status_fact"),
            Self::LegacyStatus(state) => tracing::debug!(target: TARGET,
                provider = "claude", session_id, session_type, status = state.as_str(),
                legacy = true, "freshagent.claude.status_fact"),
            Self::StatusEnded {
                compact_result,
                compact_error,
                permission_mode,
            } => tracing::debug!(target: TARGET,
                provider = "claude", session_id, session_type, status = "ended",
                compact_result = compact_result.as_deref(),
                compact_error = compact_error.as_deref(),
                permission_mode = permission_mode.as_deref(),
                "freshagent.claude.status_fact"),
            Self::Heartbeat {
                kind,
                tool_use_id,
                elapsed_ms,
            } => tracing::debug!(target: TARGET,
                provider = "claude", session_id, session_type, kind = kind.as_str(),
                tool_use_id = tool_use_id.as_deref(), elapsed_ms = *elapsed_ms,
                "freshagent.claude.heartbeat"),
            Self::SendRejected(_) => {}
        }
    }
}

// ── the turn ledger (C17) ────────────────────────────────────────────────────

/// What the server is shown for a session: the one value status pushes, attach
/// acknowledgements and snapshot overlays all speak (design §5.2).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum EffectiveStatus {
    #[default]
    Idle,
    Running,
    Compacting,
    Stuck,
    Exited,
}

impl EffectiveStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Running => "running",
            Self::Compacting => "compacting",
            Self::Stuck => "stuck",
            Self::Exited => "exited",
        }
    }
}

/// How far the CLI has taken a command the server sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CommandPhase {
    /// Armed and written; the CLI has said nothing about it yet.
    Accepted,
    /// The CLI read it and holds it for later (`queued`).
    Queued,
    /// The CLI runs it (`started`, or its replay).
    Started,
}

/// One command the CLI owes an end for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LedgerCommand {
    /// The uuid the server minted for it ([`mint_send_uuid`]).
    pub(crate) uuid: String,
    /// The client request that sent it (`None` for a compact, which has no ack).
    pub(crate) request_id: Option<String>,
    pub(crate) kind: SendKind,
    pub(crate) phase: CommandPhase,
}

/// What one sidecar line tells the ledger (design §5.2's inputs).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TurnFact {
    /// A sent command's lifecycle (`sdk.command`).
    Command { uuid: String, state: CommandState },
    /// The CLI started or stopped working (`sdk.session.state`; a legacy
    /// protocol fake's `sdk.status idle` is its idle).
    SessionState(SessionState),
    /// The per-turn init; `lifecycle_capable` when it advertises
    /// `msg_lifecycle_v1` (T8). It opens no turn (see [`ClaudeTurnLedger::fold`]).
    Init { lifecycle_capable: bool },
    /// Work in a turn: a model request, assistant text, a stream event (a legacy
    /// fake's `sdk.status running`). The fallback for a CLI that announces no
    /// session state. A subagent's own output is its parent's tool call.
    TurnEvidence,
    /// A compaction started (`sdk.status compacting`).
    CompactStarted,
    /// A compaction ended (`sdk.status null`, `sdk.compact_boundary`).
    CompactEnded,
    /// A turn's result (`sdk.result`).
    Result,
    /// The sidecar does not host the session (`sdk.error{sessionNotFound}`):
    /// nothing it owed can end any more.
    SessionLost,
}

impl TurnFact {
    /// The fact a sidecar stdout line carries for the ledger, if any.
    pub(crate) fn from_line(line: &Value) -> Option<Self> {
        if let Some(fact) = SidecarFact::from_line(line) {
            return match fact {
                SidecarFact::Command { uuid, state } => Some(Self::Command { uuid, state }),
                SidecarFact::SessionState(state)
                | SidecarFact::LegacyStatus(state @ SessionState::Idle) => {
                    Some(Self::SessionState(state))
                }
                SidecarFact::LegacyStatus(_) | SidecarFact::Requesting => Some(Self::TurnEvidence),
                SidecarFact::StatusEnded { .. } => Some(Self::CompactEnded),
                SidecarFact::Compacting => Some(Self::CompactStarted),
                SidecarFact::Heartbeat { .. } | SidecarFact::SendRejected(_) => None,
            };
        }
        let subagent = || {
            ["parentToolUseId", "parent_tool_use_id"]
                .iter()
                .any(|key| line.get(*key).is_some_and(|parent| parent.is_string()))
        };
        match line.get("type")?.as_str()? {
            "sdk.session.init" => Some(Self::Init {
                lifecycle_capable: line
                    .get("capabilities")
                    .and_then(Value::as_array)
                    .is_some_and(|caps| {
                        caps.iter()
                            .any(|cap| cap.as_str() == Some(LIFECYCLE_CAPABILITY))
                    }),
            }),
            "sdk.assistant" | "sdk.stream" if !subagent() => Some(Self::TurnEvidence),
            "sdk.compact_boundary" => Some(Self::CompactEnded),
            "sdk.result" => Some(Self::Result),
            "sdk.error" if line.get("sessionNotFound").and_then(Value::as_bool) == Some(true) => {
                Some(Self::SessionLost)
            }
            _ => None,
        }
    }
}

/// One session's ledger, shared by its handlers and its stdout consumer. Every
/// critical section is synchronous (no await under the lock).
pub(crate) type SharedLedger = std::sync::Arc<std::sync::Mutex<ClaudeTurnLedger>>;

/// The init capability that says the CLI reports every sent command's
/// lifecycle (T8).
const LIFECYCLE_CAPABILITY: &str = "msg_lifecycle_v1";

/// What a result retired (design §5.2, §5.3): exactly one per result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Settlement {
    /// The commands the result ended, in acceptance order.
    pub(crate) retired: Vec<LedgerCommand>,
    /// No command had started on a CLI that reports no lifecycle, so the oldest
    /// armed one was taken for the result's (T8's unknown slash command).
    pub(crate) head_retired: bool,
}

/// What folding one fact did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Folded {
    /// The fact was applied (it may have changed nothing).
    Applied,
    /// A lifecycle for a uuid the ledger does not hold: ignored.
    UnknownCommand,
    /// A result, and what it retired.
    Settled(Settlement),
}

/// The busy truth of one claude session (design §5.2): every command the
/// server sent and the CLI has not ended, whether the CLI is working on a turn
/// (any origin, including its own, T19), and whether a compaction runs. Pure
/// and synchronous: the handlers arm and take back commands under the
/// session's turn lock, the stdout consumer folds the sidecar's lines, and the
/// rollback, fork and configure gates read [`Self::busy`].
#[derive(Debug, Default)]
pub(crate) struct ClaudeTurnLedger {
    /// Acceptance order.
    commands: VecDeque<LedgerCommand>,
    /// The CLI is working on a turn.
    turn_open: bool,
    compacting: bool,
    /// The CLI reports each sent command's lifecycle (a lifecycle frame, or the
    /// init's capability): a result that started no command is then not one of
    /// the server's.
    lifecycle_capable: bool,
    /// The status last published for the session.
    published: EffectiveStatus,
}

impl ClaudeTurnLedger {
    /// The session owes the client an end: a command is outstanding, a turn is
    /// open or a compaction runs.
    pub(crate) fn busy(&self) -> bool {
        !self.commands.is_empty() || self.turn_open || self.compacting
    }

    /// The status the session shows: `exited` for a dead session, else `stuck`,
    /// else `compacting`, else `running` while busy, else `idle`.
    pub(crate) fn effective_status(&self, dead: bool, stuck: bool) -> EffectiveStatus {
        if dead {
            EffectiveStatus::Exited
        } else if stuck {
            EffectiveStatus::Stuck
        } else if self.compacting {
            EffectiveStatus::Compacting
        } else if self.busy() {
            EffectiveStatus::Running
        } else {
            EffectiveStatus::Idle
        }
    }

    /// The status to publish, when it differs from the last one published (a
    /// new ledger has published `idle`); it is then the published one.
    pub(crate) fn take_status_change(&mut self, stuck: bool) -> Option<EffectiveStatus> {
        let status = self.effective_status(false, stuck);
        (status != self.published).then(|| {
            self.published = status;
            status
        })
    }

    /// The status last published.
    pub(crate) fn published_status(&self) -> EffectiveStatus {
        self.published
    }

    /// A send the server is about to write (under the turn lock, before the
    /// write: the CLI's answer can come before the writer runs again).
    pub(crate) fn arm(&mut self, uuid: String, request_id: Option<String>, kind: SendKind) {
        self.commands.retain(|command| command.uuid != uuid);
        self.commands.push_back(LedgerCommand {
            uuid,
            request_id,
            kind,
            phase: CommandPhase::Accepted,
        });
    }

    /// Take back a send whose write failed or that the sidecar refused
    /// (`sdk.send.rejected`): exactly that command leaves.
    pub(crate) fn undo_arm(&mut self, uuid: &str) -> Option<LedgerCommand> {
        let at = self
            .commands
            .iter()
            .position(|command| command.uuid == uuid)?;
        self.commands.remove(at)
    }

    /// Fold one fact from the sidecar.
    pub(crate) fn fold(&mut self, fact: &TurnFact) -> Folded {
        match fact {
            TurnFact::Command { uuid, state } => return self.fold_command(uuid, *state),
            TurnFact::SessionState(SessionState::Running | SessionState::RequiresAction) => {
                self.turn_open = true;
            }
            TurnFact::SessionState(SessionState::Idle) => {
                // A started command cannot outlive an idle; one the CLI has not
                // reported may have been pushed just as the CLI went idle (T9).
                self.turn_open = false;
                self.compacting = false;
                self.commands
                    .retain(|command| command.phase != CommandPhase::Started);
            }
            TurnFact::Init { lifecycle_capable } => {
                // Not turn evidence: every real turn has opened by its init (its
                // command started, or the session state said running), and the
                // protocol fakes announce an init at create, when no turn runs.
                self.lifecycle_capable |= lifecycle_capable;
            }
            TurnFact::TurnEvidence => self.turn_open = true,
            TurnFact::CompactStarted => self.compacting = true,
            TurnFact::CompactEnded => self.compacting = false,
            TurnFact::Result => return Folded::Settled(self.settle()),
            TurnFact::SessionLost => {
                self.clear();
            }
        }
        Folded::Applied
    }

    fn fold_command(&mut self, uuid: &str, state: CommandState) -> Folded {
        if state != CommandState::Replayed {
            self.lifecycle_capable = true;
        }
        let Some(at) = self
            .commands
            .iter()
            .position(|command| command.uuid == uuid)
        else {
            return Folded::UnknownCommand;
        };
        match state {
            CommandState::Queued => {
                let command = &mut self.commands[at];
                if command.phase == CommandPhase::Accepted {
                    command.phase = CommandPhase::Queued;
                }
            }
            CommandState::Started | CommandState::Replayed => {
                self.commands[at].phase = CommandPhase::Started;
                self.turn_open = true;
            }
            CommandState::Completed | CommandState::Cancelled | CommandState::Discarded => {
                self.commands.remove(at);
            }
        }
        Folded::Applied
    }

    /// A result ends the turn: it retires every started command (one turn runs
    /// at a time, and absorbed commands start inside it, T10), so it rings at
    /// most once and its trailers (the lifecycle's end, the idle) find nothing.
    fn settle(&mut self) -> Settlement {
        let (retired, kept): (VecDeque<_>, VecDeque<_>) = std::mem::take(&mut self.commands)
            .into_iter()
            .partition(|command| command.phase == CommandPhase::Started);
        self.commands = kept;
        let mut retired: Vec<LedgerCommand> = retired.into();
        let mut head_retired = false;
        if retired.is_empty() && !self.lifecycle_capable {
            if let Some(head) = self.commands.pop_front() {
                retired.push(head);
                head_retired = true;
            }
        }
        self.turn_open = false;
        self.compacting = false;
        Settlement {
            retired,
            head_retired,
        }
    }

    /// The sidecar's output ended: whether anything was owed, and the ledger
    /// is cleared (the CLI and its queue are gone).
    pub(crate) fn eof(&mut self) -> bool {
        let owed = self.busy();
        self.clear();
        owed
    }

    fn clear(&mut self) {
        self.commands.clear();
        self.turn_open = false;
        self.compacting = false;
    }

    /// The outstanding commands' uuids, in acceptance order.
    #[cfg(test)]
    pub(crate) fn outstanding(&self) -> impl Iterator<Item = &str> {
        self.commands.iter().map(|command| command.uuid.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_send_uuid_is_a_fresh_v4_uuid() {
        let first = mint_send_uuid();
        let parsed = uuid::Uuid::parse_str(&first).expect("a uuid");
        assert_eq!(parsed.get_version_num(), 4);
        assert_eq!(
            first,
            parsed.hyphenated().to_string(),
            "the canonical lowercase form"
        );
        assert_ne!(first, mint_send_uuid());
    }

    #[test]
    fn command_lifecycle_facts_parse() {
        for (state, expected) in [
            ("queued", CommandState::Queued),
            ("started", CommandState::Started),
            ("completed", CommandState::Completed),
            ("cancelled", CommandState::Cancelled),
            ("discarded", CommandState::Discarded),
            ("replayed", CommandState::Replayed),
        ] {
            assert_eq!(
                SidecarFact::from_line(&json!({
                    "type": "sdk.command", "sessionId": "s", "uuid": "u", "state": state,
                })),
                Some(SidecarFact::Command {
                    uuid: "u".into(),
                    state: expected,
                }),
            );
        }
        // A state this server does not know is not a fact it can fold.
        assert_eq!(
            SidecarFact::from_line(
                &json!({ "type": "sdk.command", "uuid": "u", "state": "paused" })
            ),
            None
        );
        assert_eq!(
            SidecarFact::from_line(&json!({ "type": "sdk.command", "state": "queued" })),
            None
        );
    }

    #[test]
    fn session_state_facts_parse() {
        for (state, expected) in [
            ("running", SessionState::Running),
            ("idle", SessionState::Idle),
            ("requires_action", SessionState::RequiresAction),
        ] {
            assert_eq!(
                SidecarFact::from_line(&json!({ "type": "sdk.session.state", "state": state })),
                Some(SidecarFact::SessionState(expected)),
            );
        }
        assert_eq!(
            SidecarFact::from_line(&json!({ "type": "sdk.session.state", "state": "asleep" })),
            None
        );
    }

    #[test]
    fn every_status_the_sidecar_reports_is_a_fact() {
        assert_eq!(
            SidecarFact::from_line(&json!({
                "type": "sdk.status", "status": null, "compactResult": "failed",
                "compactError": "Not enough messages to compact.", "permissionMode": "plan",
            })),
            Some(SidecarFact::StatusEnded {
                compact_result: Some("failed".into()),
                compact_error: Some("Not enough messages to compact.".into()),
                permission_mode: Some("plan".into()),
            }),
        );
        assert_eq!(
            SidecarFact::from_line(&json!({ "type": "sdk.status", "status": null })),
            Some(SidecarFact::StatusEnded {
                compact_result: None,
                compact_error: None,
                permission_mode: None,
            }),
        );
        assert_eq!(
            SidecarFact::from_line(&json!({ "type": "sdk.status", "status": "requesting" })),
            Some(SidecarFact::Requesting),
        );
        // C17: the server publishes the session's status itself, so the
        // statuses the sidecar reports are facts too, never client content.
        assert_eq!(
            SidecarFact::from_line(&json!({ "type": "sdk.status", "status": "compacting" })),
            Some(SidecarFact::Compacting),
        );
        assert_eq!(
            SidecarFact::from_line(&json!({ "type": "sdk.status", "status": "running" })),
            Some(SidecarFact::LegacyStatus(SessionState::Running)),
        );
        assert_eq!(
            SidecarFact::from_line(&json!({ "type": "sdk.status", "status": "idle" })),
            Some(SidecarFact::LegacyStatus(SessionState::Idle)),
        );
        assert_eq!(
            SidecarFact::from_line(&json!({ "type": "sdk.status" })),
            None
        );
    }

    #[test]
    fn heartbeat_facts_parse() {
        assert_eq!(
            SidecarFact::from_line(&json!({
                "type": "sdk.heartbeat", "kind": "tool", "toolUseId": "toolu_1", "elapsedMs": 30000,
            })),
            Some(SidecarFact::Heartbeat {
                kind: HeartbeatKind::Tool,
                tool_use_id: Some("toolu_1".into()),
                elapsed_ms: Some(30_000),
            }),
        );
        assert_eq!(
            SidecarFact::from_line(&json!({ "type": "sdk.heartbeat", "kind": "retry" })),
            Some(SidecarFact::Heartbeat {
                kind: HeartbeatKind::Retry,
                tool_use_id: None,
                elapsed_ms: None,
            }),
        );
        assert_eq!(
            SidecarFact::from_line(&json!({ "type": "sdk.heartbeat", "kind": "task" })),
            Some(SidecarFact::Heartbeat {
                kind: HeartbeatKind::Task,
                tool_use_id: None,
                elapsed_ms: None,
            }),
        );
        assert_eq!(
            SidecarFact::from_line(&json!({ "type": "sdk.heartbeat", "kind": "pulse" })),
            None
        );
    }

    #[test]
    fn a_rejected_send_parses_with_or_without_its_uuid() {
        assert_eq!(
            SidecarFact::from_line(&json!({
                "type": "sdk.send.rejected", "sessionId": "s", "uuid": "u",
                "code": "INVALID_IMAGE", "message": "Claude cannot read image/svg+xml as an image.",
            })),
            Some(SidecarFact::SendRejected(SendRejection {
                uuid: Some("u".into()),
                code: "INVALID_IMAGE".into(),
                message: "Claude cannot read image/svg+xml as an image.".into(),
            })),
        );
        assert_eq!(
            SidecarFact::from_line(&json!({ "type": "sdk.send.rejected", "uuid": null })),
            Some(SidecarFact::SendRejected(SendRejection {
                uuid: None,
                code: "INVALID_SEND".into(),
                message: REJECTED_SEND_FALLBACK_MESSAGE.into(),
            })),
        );
    }

    #[test]
    fn content_and_control_lines_are_not_facts() {
        for line in [
            json!({ "type": "sdk.result", "subtype": "success" }),
            json!({ "type": "sdk.assistant", "content": [] }),
            json!({ "type": "sdk.turn.complete", "at": 1 }),
            json!({ "type": "sdk.interrupt_settled", "ok": true, "stillQueued": [] }),
            json!({ "type": "created", "requestId": "r" }),
        ] {
            assert_eq!(SidecarFact::from_line(&line), None, "{line}");
        }
    }
}

#[cfg(test)]
#[path = "claude_turns_ledger_tests.rs"]
mod ledger_tests;
