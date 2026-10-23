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
//!
//! C18: the ledger also holds the session's Stop latch ([`StopLatch`], design
//! §5.4) and decides each result's [`ResultVerdict`] (§5.3): a Stop that landed
//! on what it targeted is silent, every other turn end rings, and a failed turn
//! also shows why. The server mints every attention edge from these verdicts
//! (`claude_edges.rs`); the sidecar mints none.

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
    /// Work in a turn that is not its content: a model request (a legacy
    /// fake's `sdk.status running`). The fallback for a CLI that announces no
    /// session state.
    TurnEvidence,
    /// The turn's own content: assistant text or a stream event (a subagent's
    /// output is its parent's tool call, not the turn's content). Turn evidence
    /// too, and the "first content" a cold Stop waits for (§5.4 case B).
    Content,
    /// A compaction started (`sdk.status compacting`).
    CompactStarted,
    /// A compaction ended (`sdk.status null`, `sdk.compact_boundary`).
    CompactEnded,
    /// A turn's result (`sdk.result`), with the facts its verdict reads.
    Result(ResultFacts),
    /// The CLI's receipt for an interrupt (`sdk.interrupt_settled`): `stop_id`
    /// echoes the interrupt's (absent from a protocol fake), and `still_queued`
    /// lists the sent commands the CLI says will still run (T12, T13; absent
    /// when the CLI sends no receipt).
    InterruptSettled {
        stop_id: Option<String>,
        ok: bool,
        still_queued: Option<Vec<String>>,
    },
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
            "sdk.assistant" | "sdk.stream" if !subagent() => Some(Self::Content),
            "sdk.compact_boundary" => Some(Self::CompactEnded),
            "sdk.result" => Some(Self::Result(ResultFacts::from_line(line))),
            "sdk.interrupt_settled" => Some(Self::InterruptSettled {
                stop_id: line
                    .get("stopId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                ok: line.get("ok").and_then(Value::as_bool) == Some(true),
                still_queued: line
                    .get("stillQueued")
                    .and_then(Value::as_array)
                    .map(|uuids| {
                        uuids
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    }),
            }),
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
    /// Whether the result rings, and whether it failed (§5.3).
    pub(crate) verdict: ResultVerdict,
    /// The Stop latched when the result arrived, if any.
    pub(crate) stop_id: Option<String>,
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
    /// The fact was applied, and a Stop that missed a command the CLI was
    /// still starting must be sent again now (§5.4).
    Reissue(StopReissue),
    /// The CLI refused the latched Stop's interrupt (`ok: false`): the latch is
    /// disarmed, and the turn it targeted keeps running.
    StopRefused {
        stop_id: String,
        request_id: Option<String>,
    },
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
    /// The Stop in force (§5.4), until every command it targeted has ended.
    stop: Option<StopLatch>,
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
        let command = self.commands.remove(at);
        self.stop_targets_ended(&[uuid]);
        self.clear_stop_if_spent();
        command
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
                let ended: Vec<String> = self
                    .commands
                    .iter()
                    .filter(|command| command.phase == CommandPhase::Started)
                    .map(|command| command.uuid.clone())
                    .collect();
                self.commands
                    .retain(|command| command.phase != CommandPhase::Started);
                let ended: Vec<&str> = ended.iter().map(String::as_str).collect();
                self.stop_targets_ended(&ended);
                if let Some(stop) = self.stop.as_mut() {
                    stop.cli_turn = false;
                }
                self.clear_stop_if_spent();
            }
            TurnFact::Init { lifecycle_capable } => {
                // Not turn evidence: every real turn has opened by its init (its
                // command started, or the session state said running), and the
                // protocol fakes announce an init at create, when no turn runs.
                self.lifecycle_capable |= lifecycle_capable;
            }
            TurnFact::TurnEvidence => self.turn_open = true,
            TurnFact::Content => {
                self.turn_open = true;
                let only_started = self.only_started_command().map(str::to_string);
                if let Some(stop) = self.stop.as_mut() {
                    if stop.awaiting_start.is_some()
                        && only_started.as_deref() == stop.awaiting_start.as_deref()
                    {
                        stop.target_content = true;
                    }
                }
                return self.evaluate_stop();
            }
            TurnFact::CompactStarted => self.compacting = true,
            TurnFact::CompactEnded => self.compacting = false,
            TurnFact::Result(facts) => return Folded::Settled(self.settle(facts)),
            TurnFact::InterruptSettled {
                stop_id,
                ok,
                still_queued,
            } => return self.fold_receipt(stop_id.as_deref(), *ok, still_queued.as_deref()),
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
                self.stop_targets_ended(&[uuid]);
                self.clear_stop_if_spent();
                return Folded::Applied;
            }
        }
        if let Some(stop) = self.stop.as_mut() {
            if stop.awaiting_start.as_deref() == Some(uuid) {
                if stop.receipt == StopReceipt::Pending {
                    stop.target_lifecycle_before_receipt = true;
                }
                if matches!(state, CommandState::Started | CommandState::Replayed) {
                    stop.target_started = true;
                }
                if state == CommandState::Replayed {
                    stop.target_content = true;
                }
            }
        }
        self.evaluate_stop()
    }

    /// A result ends the turn: it retires every started command (one turn runs
    /// at a time, and absorbed commands start inside it, T10), so it rings at
    /// most once and its trailers (the lifecycle's end, the idle) find nothing.
    /// Its verdict is decided against the Stop latched when it arrived.
    fn settle(&mut self, facts: &ResultFacts) -> Settlement {
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
        let verdict = ResultVerdict::decide(facts, &retired, self.stop.as_ref());
        let stop_id = self.stop.as_ref().map(|stop| stop.stop_id.clone());
        let ended: Vec<&str> = retired
            .iter()
            .map(|command| command.uuid.as_str())
            .collect();
        self.stop_targets_ended(&ended);
        if let Some(stop) = self.stop.as_mut() {
            stop.cli_turn = false;
        }
        self.clear_stop_if_spent();
        Settlement {
            retired,
            head_retired,
            verdict,
            stop_id,
        }
    }

    /// The sidecar's output ended: whether anything was owed, and the ledger
    /// is cleared (the CLI and its queue are gone, and so is any Stop).
    pub(crate) fn eof(&mut self) -> bool {
        let owed = self.busy();
        self.clear();
        owed
    }

    fn clear(&mut self) {
        self.commands.clear();
        self.turn_open = false;
        self.compacting = false;
        self.stop = None;
    }

    // ── the Stop latch (C18, design §5.4) ────────────────────────────────────

    /// The user's Stop. A session with nothing owed has nothing to stop: `None`,
    /// and nothing is sent. Otherwise the Stop targets one thing: the running
    /// turn's commands; else the oldest command the CLI has not started (it may
    /// still be starting, T13: the latch waits for it); else the turn the CLI
    /// runs by itself. Commands queued behind the running turn are not targets
    /// (decision 1): they run and ring. A Stop while another is latched keeps
    /// the earlier one's targets, so everything the user stopped stays silent.
    pub(crate) fn stop(
        &mut self,
        stop_id: String,
        request_id: Option<String>,
    ) -> Option<StopArmed> {
        if !self.busy() {
            return None;
        }
        let started: Vec<String> = self
            .commands
            .iter()
            .filter(|command| command.phase == CommandPhase::Started)
            .map(|command| command.uuid.clone())
            .collect();
        let (target, commands, awaiting_start) = if !started.is_empty() {
            (StopTargetKind::Running, started, None)
        } else if let Some(head) = self.commands.front() {
            (
                StopTargetKind::NotStarted,
                vec![head.uuid.clone()],
                Some(head.uuid.clone()),
            )
        } else {
            (StopTargetKind::CliTurn, Vec::new(), None)
        };
        let earlier = self.stop.take();
        let mut latch = StopLatch {
            stop_id: stop_id.clone(),
            request_id,
            commands: Vec::new(),
            cli_turn: target == StopTargetKind::CliTurn,
            awaiting_start: awaiting_start.clone(),
            receipt: StopReceipt::Pending,
            target_lifecycle_before_receipt: false,
            target_started: false,
            target_content: false,
            reissues: 0,
        };
        if let Some(earlier) = earlier {
            latch.commands = earlier.commands;
            latch.cli_turn |= earlier.cli_turn;
            latch.reissues = earlier.reissues;
        }
        for uuid in &commands {
            if !latch.commands.contains(uuid) {
                latch.commands.push(uuid.clone());
            }
        }
        let armed = StopArmed {
            stop_id,
            target,
            commands: latch.commands.clone(),
        };
        self.stop = Some(latch);
        Some(armed)
    }

    /// The interrupt for `stop_id` could not be written: the Stop never reached
    /// the CLI, so the latch is disarmed (a later Stop's latch is kept).
    pub(crate) fn stop_unsent(&mut self, stop_id: &str) {
        if self
            .stop
            .as_ref()
            .is_some_and(|stop| stop.stop_id == stop_id)
        {
            self.stop = None;
        }
    }

    /// A Stop is latched.
    #[cfg(test)]
    pub(crate) fn stop_latched(&self) -> bool {
        self.stop.is_some()
    }

    /// The original receipt advances the latch's targeting rules. A failed
    /// reissue cancels that same Stop and reports its original user request;
    /// a successful reissue leaves the targeting rules unchanged. Earlier
    /// Stops are ignored. An id-less legacy receipt belongs to the pending latch.
    fn fold_receipt(
        &mut self,
        stop_id: Option<&str>,
        ok: bool,
        still_queued: Option<&[String]>,
    ) -> Folded {
        let Some(stop) = self.stop.as_mut() else {
            return Folded::Applied;
        };
        let reissued = stop_id.is_some_and(|id| {
            stop.reissues > 0 && id == format!("{}:{}", stop.stop_id, stop.reissues)
        });
        let ours = match stop_id {
            Some(id) => id == stop.stop_id,
            None => stop.receipt == StopReceipt::Pending,
        };
        if !reissued && (!ours || stop.receipt != StopReceipt::Pending) {
            return Folded::Applied;
        }
        if !ok {
            let stop_id = stop.stop_id.clone();
            let request_id = stop.request_id.clone();
            self.stop = None;
            return Folded::StopRefused {
                stop_id,
                request_id,
            };
        }
        if reissued {
            return Folded::Applied;
        }
        let lists_target = stop.awaiting_start.as_ref().is_some_and(|target| {
            still_queued.is_some_and(|queued| queued.iter().any(|uuid| uuid == target))
        });
        stop.receipt = StopReceipt::Received { lists_target };
        self.evaluate_stop()
    }

    /// Whether the latched Stop must be sent again now (§5.4): it waits for a
    /// command the CLI had not started, the command is still owed, and:
    /// - case A (the receipt lists the command, or came before any of its
    ///   lifecycle): both the receipt and the command's start have been seen;
    /// - case B (an empty receipt after its lifecycle: the interrupt may have
    ///   landed on it): its first content has been seen.
    fn evaluate_stop(&mut self) -> Folded {
        let owed = |uuid: &str| self.commands.iter().any(|command| command.uuid == uuid);
        let Some(stop) = self.stop.as_ref() else {
            return Folded::Applied;
        };
        let Some(target) = stop.awaiting_start.clone() else {
            return Folded::Applied;
        };
        if !owed(&target) || stop.reissues >= MAX_STOP_REISSUES {
            return Folded::Applied;
        }
        let StopReceipt::Received { lists_target } = stop.receipt else {
            return Folded::Applied;
        };
        let case = if lists_target || !stop.target_lifecycle_before_receipt {
            ReissueCase::A
        } else {
            ReissueCase::B
        };
        let due = match case {
            ReissueCase::A => stop.target_started,
            ReissueCase::B => stop.target_content,
        };
        if !due {
            return Folded::Applied;
        }
        let stop = self.stop.as_mut().expect("checked above");
        stop.reissues += 1;
        stop.awaiting_start = None;
        Folded::Reissue(StopReissue {
            stop_id: stop.stop_id.clone(),
            request_id: stop.request_id.clone(),
            reissue_id: format!("{}:{}", stop.stop_id, stop.reissues),
            case,
            target,
            reissues: stop.reissues,
        })
    }

    /// `ended` commands are no longer owed: they leave the latch's targets.
    fn stop_targets_ended(&mut self, ended: &[&str]) {
        let Some(stop) = self.stop.as_mut() else {
            return;
        };
        stop.commands.retain(|uuid| !ended.contains(&uuid.as_str()));
        if stop
            .awaiting_start
            .as_deref()
            .is_some_and(|target| ended.contains(&target))
        {
            stop.awaiting_start = None;
        }
    }

    /// The latch clears once nothing it targeted is left.
    fn clear_stop_if_spent(&mut self) {
        if self
            .stop
            .as_ref()
            .is_some_and(|stop| stop.commands.is_empty() && !stop.cli_turn)
        {
            self.stop = None;
        }
    }

    /// The one started command, when exactly one has started.
    fn only_started_command(&self) -> Option<&str> {
        let mut started = self
            .commands
            .iter()
            .filter(|command| command.phase == CommandPhase::Started);
        let first = started.next()?;
        started.next().is_none().then_some(first.uuid.as_str())
    }

    /// The outstanding commands' uuids, in acceptance order.
    #[cfg(test)]
    pub(crate) fn outstanding(&self) -> impl Iterator<Item = &str> {
        self.commands.iter().map(|command| command.uuid.as_str())
    }
}

// ── the Stop latch and the result verdict (C18, design §5.3, §5.4) ──────────

/// A Stop re-sends its interrupt at most this many times in all (a re-send
/// ends the wait for its command, so one Stop re-sends at most once; the cap
/// bounds a run of Stops that keep one latch).
pub(crate) const MAX_STOP_REISSUES: u8 = 2;

/// What a Stop targets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StopTargetKind {
    /// The running turn's commands.
    Running,
    /// The oldest command the CLI had not started (it may still be starting).
    NotStarted,
    /// A turn the CLI runs by itself (no command of the server's runs).
    CliTurn,
}

impl StopTargetKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::NotStarted => "not_started",
            Self::CliTurn => "cli_turn",
        }
    }
}

/// A Stop the ledger latched: what the interrupt is written for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StopArmed {
    pub(crate) stop_id: String,
    pub(crate) target: StopTargetKind,
    /// Every command the latch now targets (an earlier latched Stop's too).
    pub(crate) commands: Vec<String>,
}

/// The interrupt's receipt, as far as the latch has seen it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StopReceipt {
    Pending,
    /// `lists_target`: the receipt lists the command the latch waits for among
    /// the ones that will still run.
    Received {
        lists_target: bool,
    },
}

/// Which re-send rule fired (§5.4).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReissueCase {
    /// The receipt lists the command, or came before its lifecycle: re-sent at
    /// its start.
    A,
    /// An empty receipt after its lifecycle: re-sent on its first content.
    B,
}

impl ReissueCase {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::A => "A",
            Self::B => "B",
        }
    }
}

/// A Stop to send again: the command it missed now runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StopReissue {
    /// The latched Stop.
    pub(crate) stop_id: String,
    pub(crate) request_id: Option<String>,
    /// The re-sent interrupt's own id (its receipt is not the latch's).
    pub(crate) reissue_id: String,
    pub(crate) case: ReissueCase,
    /// The command the Stop missed.
    pub(crate) target: String,
    /// How many times the latch has re-sent, this one included.
    pub(crate) reissues: u8,
}

/// The Stop in force for a session (§5.4).
#[derive(Clone, Debug, PartialEq, Eq)]
struct StopLatch {
    stop_id: String,
    request_id: Option<String>,
    /// The commands it targets; a result that retires only these is silent.
    commands: Vec<String>,
    /// It targets a turn the CLI runs by itself (a result retiring nothing).
    cli_turn: bool,
    /// The command the CLI had not started at the Stop, while the latch still
    /// waits to see whether the interrupt missed it.
    awaiting_start: Option<String>,
    receipt: StopReceipt,
    /// That command's queued, started or replay came before the receipt.
    target_lifecycle_before_receipt: bool,
    /// That command started (or was replayed).
    target_started: bool,
    /// That command's first content was seen (its replay, or the turn's own
    /// assistant or stream frame while it is the only started command).
    target_content: bool,
    reissues: u8,
}

/// The banner of a turn a Stop did not end but that the CLI aborted.
pub(crate) const ABORTED_TURN_MESSAGE: &str = "Claude stopped the turn before it finished.";
/// The banner of a failed turn whose kind has no copy of its own.
pub(crate) const DEFAULT_TURN_FAILURE_MESSAGE: &str =
    "Claude could not complete this turn. Try sending your message again.";

/// The banner for a failed result of `subtype` that says nothing itself.
fn subtype_failure_message(subtype: &str) -> &'static str {
    match subtype {
        "error_max_turns" => "Claude reached its turn limit. Send a message to continue.",
        "error_max_budget_usd" => "Claude reached the configured spending limit.",
        "error_max_structured_output_retries" => {
            "Claude could not produce the requested response format."
        }
        _ => DEFAULT_TURN_FAILURE_MESSAGE,
    }
}

/// The `terminal_reason`s of a turn that was aborted (T11).
const ABORTED_TERMINAL_REASONS: [&str; 2] = ["aborted_streaming", "aborted_tools"];

/// What a result says about its turn (`sdk.result`, design §5.1).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ResultFacts {
    /// The result's subtype (`success`, `error_during_execution`, ...). A
    /// protocol fake names it in `result` instead.
    pub(crate) subtype: String,
    pub(crate) is_error: bool,
    pub(crate) terminal_reason: Option<String>,
    pub(crate) num_turns: Option<u64>,
    /// The CLI's own error text, without its diagnostics.
    pub(crate) error_text: Option<String>,
}

impl ResultFacts {
    pub(crate) fn from_line(line: &Value) -> Self {
        let text = |key: &str| {
            line.get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        };
        let subtype = text("subtype")
            .or_else(|| text("result"))
            .unwrap_or_else(|| "success".to_string());
        Self {
            is_error: line
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(subtype != "success"),
            terminal_reason: text("terminalReason"),
            num_turns: line.get("numTurns").and_then(Value::as_u64),
            error_text: text("errorText"),
            subtype,
        }
    }

    /// The CLI aborted the turn: its terminal reason says so, or (an older CLI
    /// that reports none) it ended `error_during_execution` after running a turn
    /// while a Stop was latched. A boot refusal ran no turn (T5), so it is never
    /// a stopped turn.
    fn aborted(&self, stop_latched: bool) -> bool {
        match self.terminal_reason.as_deref() {
            Some(reason) => ABORTED_TERMINAL_REASONS.contains(&reason),
            None => {
                stop_latched
                    && self.subtype == "error_during_execution"
                    && self.num_turns.is_some_and(|turns| turns > 0)
            }
        }
    }
}

/// How a turn ended, for in-process observers (design §9.3 I3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnOutcome {
    /// It ran to a successful result.
    Completed,
    /// It ended with an error (a failed subtype, or an API error).
    Failed,
    /// The user's Stop ended it.
    Interrupted,
}

/// What a result means for the user (§5.3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ResultVerdict {
    /// The user's Stop landed on what it targeted: no edge, no banner.
    Silent,
    /// The turn failed: it rings, and the banner says why.
    Failed { message: String },
    /// The turn ended (an API error too, which the transcript shows): it rings.
    Completed { is_error: bool },
}

impl ResultVerdict {
    /// Silent only for an aborted result that retired nothing but what the
    /// latched Stop targeted (or, retiring nothing, ended the CLI's own turn it
    /// targeted). A command that started after the Stop, or another device's
    /// that a mistaken re-send aborted, rings.
    fn decide(facts: &ResultFacts, retired: &[LedgerCommand], stop: Option<&StopLatch>) -> Self {
        let aborted = facts.aborted(stop.is_some());
        let landed = stop.is_some_and(|stop| {
            if retired.is_empty() {
                stop.cli_turn
            } else {
                retired
                    .iter()
                    .all(|command| stop.commands.contains(&command.uuid))
            }
        });
        if aborted && landed {
            Self::Silent
        } else if facts.subtype != "success" {
            let message = facts.error_text.clone().unwrap_or_else(|| {
                if aborted {
                    ABORTED_TURN_MESSAGE.to_string()
                } else {
                    subtype_failure_message(&facts.subtype).to_string()
                }
            });
            Self::Failed { message }
        } else {
            Self::Completed {
                is_error: facts.is_error,
            }
        }
    }

    /// The result rings the attention edge.
    pub(crate) fn rings(&self) -> bool {
        !matches!(self, Self::Silent)
    }

    /// The failure banner the result shows, if any.
    pub(crate) fn banner(&self) -> Option<&str> {
        match self {
            Self::Failed { message } => Some(message),
            _ => None,
        }
    }

    pub(crate) fn outcome(&self) -> TurnOutcome {
        match self {
            Self::Silent => TurnOutcome::Interrupted,
            Self::Failed { .. } | Self::Completed { is_error: true } => TurnOutcome::Failed,
            Self::Completed { is_error: false } => TurnOutcome::Completed,
        }
    }

    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Silent => "silent",
            Self::Failed { .. } => "failed",
            Self::Completed { is_error: true } => "completed_with_error",
            Self::Completed { is_error: false } => "completed",
        }
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

#[cfg(test)]
#[path = "claude_turns_stop_tests.rs"]
mod stop_tests;
