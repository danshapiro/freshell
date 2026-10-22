//! Why a claude sidecar ended when nobody asked it to (core-runtime design §5.7,
//! C08; G02, G23).
//!
//! Each sidecar hosts one session. When the session's SDK stream ends, the sidecar
//! reports how in `sdk.stream.ended {reason, message}` (its last stdout line) and
//! exits with code 3 (`crates/freshell-claude-sidecar/stream-end.mjs`). If the Node
//! process itself dies, stdout just ends and only its exit status tells why. Either
//! way the consumer's end-of-output path ends the session: it reports the
//! [`SidecarExitCause`] to the user in `freshAgent.error{SIDECAR_EXITED}`, logs it
//! as `freshagent.claude.sidecar_exit`, and decides whether the lost turn rings
//! ([`death_rings`]).

use std::process::ExitStatus;
use std::time::Duration;

use serde_json::{json, Map, Value};

/// How long the end-of-output path waits for an ended sidecar's exit status. Its
/// stdout has closed, so the process is exiting or gone.
const EXIT_STATUS_BUDGET: Duration = Duration::from_secs(2);

/// The sidecar's last line when its SDK stream ended unrequested.
pub(crate) const STREAM_ENDED_TYPE: &str = "sdk.stream.ended";

/// The reason a [`SidecarExitCause::ProcessEnded`] reports.
pub(crate) const PROCESS_ENDED_REASON: &str = "sidecar_exited";

/// `sdk.stream.ended`: how the session's SDK stream ended (`reason` is
/// `cli_exited`, `stream_error` or `stream_eof`; `message` explains it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StreamEnded {
    pub(crate) reason: String,
    pub(crate) message: String,
}

impl StreamEnded {
    /// The stream end a sidecar stdout line reports, if it is `sdk.stream.ended`.
    pub(crate) fn from_line(line: &Value) -> Option<Self> {
        if line.get("type").and_then(Value::as_str) != Some(STREAM_ENDED_TYPE) {
            return None;
        }
        let text = |key: &str| line.get(key).and_then(Value::as_str).unwrap_or("").trim();
        let reason = match text("reason") {
            "" => "stream_error",
            reason => reason,
        };
        Some(Self {
            reason: reason.to_string(),
            message: text("message").to_string(),
        })
    }
}

/// Why an unrequested sidecar end happened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SidecarExitCause {
    /// The sidecar reported its SDK stream's end, then exited.
    StreamEnded(StreamEnded),
    /// The sidecar process ended without reporting a stream end (Node itself died).
    /// `None` when its exit status could not be read.
    ProcessEnded(Option<ExitStatus>),
}

impl SidecarExitCause {
    /// The cause: the reported stream end when there is one, else the exit status.
    pub(crate) fn new(stream_ended: Option<StreamEnded>, status: Option<ExitStatus>) -> Self {
        match stream_ended {
            Some(ended) => Self::StreamEnded(ended),
            None => Self::ProcessEnded(status),
        }
    }

    pub(crate) fn reason(&self) -> &str {
        match self {
            Self::StreamEnded(ended) => &ended.reason,
            Self::ProcessEnded(_) => PROCESS_ENDED_REASON,
        }
    }

    /// What happened, in a phrase for the banner and the log.
    pub(crate) fn detail(&self) -> String {
        match self {
            Self::StreamEnded(ended) if !ended.message.is_empty() => {
                ended.message.trim_end_matches('.').to_string()
            }
            Self::StreamEnded(ended) => format!("the session's stream ended ({})", ended.reason),
            Self::ProcessEnded(status) => match (exit_code(*status), exit_signal(*status)) {
                (Some(code), _) => format!("the agent process exited with code {code}"),
                (None, Some(signal)) => format!("the agent process was stopped by {signal}"),
                (None, None) => "the agent process ended".to_string(),
            },
        }
    }

    /// The user-facing `freshAgent.error{SIDECAR_EXITED}` message.
    pub(crate) fn user_message(&self) -> String {
        format!(
            "The Claude agent process exited unexpectedly: {}. Reopen the pane or create a new agent to continue.",
            self.detail()
        )
    }

    /// The `cause` object of the error frame: `{reason, message}`, plus
    /// `exitCode`/`signal` for a process end.
    pub(crate) fn to_json(&self) -> Value {
        let mut cause = Map::new();
        cause.insert("reason".into(), json!(self.reason()));
        cause.insert("message".into(), json!(self.detail()));
        if let Self::ProcessEnded(status) = self {
            if let Some(code) = exit_code(*status) {
                cause.insert("exitCode".into(), json!(code));
            }
            if let Some(signal) = exit_signal(*status) {
                cause.insert("signal".into(), json!(signal));
            }
        }
        Value::Object(cause)
    }
}

/// Reap an ended sidecar: its exit status, or `None` if it cannot be read within
/// [`EXIT_STATUS_BUDGET`]. Waiting also leaves no zombie behind.
pub(crate) async fn reap(child: &mut tokio::process::Child) -> Option<ExitStatus> {
    match tokio::time::timeout(EXIT_STATUS_BUDGET, child.wait()).await {
        Ok(Ok(status)) => Some(status),
        Ok(Err(error)) => {
            tracing::warn!(target: "freshell_freshagent::claude", provider = "claude",
                error = %error, "freshagent.claude.sidecar_exit_status_unreadable");
            None
        }
        Err(_) => {
            tracing::warn!(target: "freshell_freshagent::claude", provider = "claude",
                budget_ms = EXIT_STATUS_BUDGET.as_millis() as u64,
                "freshagent.claude.sidecar_exit_status_timeout");
            None
        }
    }
}

/// An exit status for the log: `code 3`, `SIGKILL`, or `unknown`.
pub(crate) fn describe_status(status: Option<ExitStatus>) -> String {
    match (exit_code(status), exit_signal(status)) {
        (Some(code), _) => format!("code {code}"),
        (None, Some(signal)) => signal,
        (None, None) => "unknown".to_string(),
    }
}

/// Whether the end-of-output path rings for a lost turn. Interim (C08 until Rust
/// mints every edge, C18): the sidecar rings a turn that ends with no result before
/// it reports the stream end, so the server rings only when there was no report —
/// a Node death — and a turn was running.
pub(crate) fn death_rings(turn_was_in_flight: bool, cause: &SidecarExitCause) -> bool {
    turn_was_in_flight && matches!(cause, SidecarExitCause::ProcessEnded(_))
}

/// The `freshAgent.error{SIDECAR_EXITED}` event for `session_id`.
pub(crate) fn sidecar_exited_event(session_id: &str, cause: &SidecarExitCause) -> Value {
    json!({
        "type": "freshAgent.error",
        "sessionId": session_id,
        "code": "SIDECAR_EXITED",
        "message": cause.user_message(),
        "cause": cause.to_json(),
    })
}

fn exit_code(status: Option<ExitStatus>) -> Option<i32> {
    status.and_then(|status| status.code())
}

#[cfg(unix)]
fn exit_signal(status: Option<ExitStatus>) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    status.and_then(|status| status.signal()).map(signal_name)
}

#[cfg(not(unix))]
fn exit_signal(_status: Option<ExitStatus>) -> Option<String> {
    None
}

#[cfg(unix)]
fn signal_name(signal: i32) -> String {
    match signal {
        libc::SIGHUP => "SIGHUP".into(),
        libc::SIGINT => "SIGINT".into(),
        libc::SIGQUIT => "SIGQUIT".into(),
        libc::SIGABRT => "SIGABRT".into(),
        libc::SIGKILL => "SIGKILL".into(),
        libc::SIGSEGV => "SIGSEGV".into(),
        libc::SIGPIPE => "SIGPIPE".into(),
        libc::SIGTERM => "SIGTERM".into(),
        other => format!("signal {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ended(reason: &str, message: &str) -> SidecarExitCause {
        SidecarExitCause::StreamEnded(StreamEnded {
            reason: reason.into(),
            message: message.into(),
        })
    }

    #[test]
    fn a_stream_ended_line_is_read_and_other_lines_are_not() {
        assert_eq!(
            StreamEnded::from_line(&json!({
                "type": "sdk.stream.ended", "sessionId": "s",
                "reason": "cli_exited", "message": "Claude Code process terminated by signal SIGKILL",
            })),
            Some(StreamEnded {
                reason: "cli_exited".into(),
                message: "Claude Code process terminated by signal SIGKILL".into(),
            })
        );
        assert_eq!(
            StreamEnded::from_line(&json!({ "type": "sdk.stream.ended", "sessionId": "s" })),
            Some(StreamEnded {
                reason: "stream_error".into(),
                message: String::new()
            }),
            "a malformed report still counts as a reported end"
        );
        assert_eq!(
            StreamEnded::from_line(&json!({ "type": "sdk.status", "status": "idle" })),
            None
        );
    }

    #[test]
    fn a_reported_stream_end_is_the_cause_whatever_the_exit_status() {
        let report = StreamEnded {
            reason: "stream_eof".into(),
            message: "The Claude CLI ended the session without reporting an error.".into(),
        };
        #[cfg(unix)]
        let status = {
            use std::os::unix::process::ExitStatusExt;
            Some(ExitStatus::from_raw(3 << 8))
        };
        #[cfg(not(unix))]
        let status = None;
        let cause = SidecarExitCause::new(Some(report.clone()), status);
        assert_eq!(cause, SidecarExitCause::StreamEnded(report));
        assert_eq!(cause.reason(), "stream_eof");
        assert_eq!(cause.to_json().get("exitCode"), None);
        assert_eq!(
            cause.to_json(),
            json!({ "reason": "stream_eof", "message": "The Claude CLI ended the session without reporting an error" }),
            "the sidecar's own message is the cause (its closing period dropped)"
        );
        assert!(cause.user_message().contains(&cause.detail()));
    }

    #[test]
    fn an_unreported_end_is_named_by_its_exit_status() {
        let unknown = SidecarExitCause::new(None, None);
        assert_eq!(unknown.reason(), PROCESS_ENDED_REASON);
        let cause = unknown.to_json();
        assert_eq!(cause["reason"], "sidecar_exited");
        assert!(cause["message"].as_str().is_some_and(|m| !m.is_empty()));
        assert_eq!(cause.get("exitCode"), None);
        assert_eq!(cause.get("signal"), None);
    }

    #[cfg(unix)]
    #[test]
    fn an_exit_code_and_a_signal_are_both_reported() {
        use std::os::unix::process::ExitStatusExt;
        let exited = SidecarExitCause::new(None, Some(ExitStatus::from_raw(1 << 8)));
        let cause = exited.to_json();
        assert_eq!(cause["reason"], "sidecar_exited");
        assert_eq!(cause["exitCode"], 1);
        assert_eq!(cause.get("signal"), None);
        assert_eq!(
            describe_status(Some(ExitStatus::from_raw(1 << 8))),
            "code 1"
        );
        assert_eq!(
            describe_status(Some(ExitStatus::from_raw(libc::SIGKILL))),
            "SIGKILL"
        );
        assert_eq!(describe_status(None), "unknown");
        assert!(exited.user_message().contains(&exited.detail()));

        let killed = SidecarExitCause::new(None, Some(ExitStatus::from_raw(libc::SIGKILL)));
        let cause = killed.to_json();
        assert_eq!(cause["signal"], "SIGKILL");
        assert_eq!(cause.get("exitCode"), None);
        assert!(killed.detail().contains("SIGKILL"));

        let other = SidecarExitCause::new(None, Some(ExitStatus::from_raw(libc::SIGUSR1)));
        assert_eq!(
            other.to_json()["signal"],
            format!("signal {}", libc::SIGUSR1)
        );
    }

    #[test]
    fn only_an_unreported_death_mid_turn_rings() {
        let node_death = SidecarExitCause::new(None, None);
        assert!(death_rings(true, &node_death));
        assert!(!death_rings(false, &node_death), "an idle death is silent");
        // The sidecar already rang the turn before it reported the end (interim).
        assert!(!death_rings(true, &ended("cli_exited", "x")));
        assert!(!death_rings(true, &ended("stream_eof", "")));
        assert!(!death_rings(false, &ended("stream_error", "x")));
    }

    #[test]
    fn the_exited_event_carries_the_code_the_message_and_the_cause() {
        let cause = ended(
            "cli_exited",
            "Claude Code process terminated by signal SIGKILL",
        );
        let event = sidecar_exited_event("sess-1", &cause);
        assert_eq!(event["type"], "freshAgent.error");
        assert_eq!(event["sessionId"], "sess-1");
        assert_eq!(event["code"], "SIDECAR_EXITED");
        assert_eq!(
            event["cause"],
            json!({ "reason": "cli_exited", "message": "Claude Code process terminated by signal SIGKILL" })
        );
        assert!(
            event["message"]
                .as_str()
                .is_some_and(|m| m.contains("Claude Code process terminated by signal SIGKILL")),
            "the banner names the cause: {event}"
        );
    }
}
