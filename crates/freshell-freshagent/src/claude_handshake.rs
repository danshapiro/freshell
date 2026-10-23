//! The claude sidecar's answer to `create` (core-runtime design §4.2 and §5.1,
//! protocol v2).
//!
//! After Rust writes the `create` line, the sidecar answers exactly once:
//! - `created {requestId, sessionId, protocol, cliPid}` once the CLI has booted
//!   the conversation (`initializationResult()` resolved, no prompt needed), or
//! - `create.failed {requestId, code, message}` when the CLI refused the boot (the
//!   codes are the sidecar's, `crates/freshell-claude-sidecar/boot.mjs`); the
//!   sidecar then exits.
//!
//! [`read_created`] reads that answer. It forwards nothing that comes before it:
//! any earlier line is logged at debug and dropped, so a refused boot can never
//! reach the turn machinery. A `created` that speaks another protocol is refused
//! as [`CreateFailure::ProtocolMismatch`]: a packaged app pairing a stale sidecar
//! with this server must fail loudly, not misread every later frame.

use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::io::{AsyncBufRead, Lines};

use crate::claude_launch::{ClaudeBoot, SIDECAR_PROTOCOL};

/// The client-visible code of a create the sidecar never answered (it died, its
/// stdout failed, or the budget ran out) or answered without a code.
pub(crate) const CREATE_FAILED_CODE: &str = "CLAUDE_CREATE_FAILED";

/// The code of a `created` that speaks another protocol.
pub(crate) const PROTOCOL_MISMATCH_CODE: &str = "SIDECAR_PROTOCOL_MISMATCH";

/// The sidecar's `created`: the CLI booted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SidecarCreated {
    /// The sidecar's id for the session (`created.sessionId`).
    pub(crate) session_id: String,
    /// The booted CLI's pid (`initializationResult().pid`), when reported.
    pub(crate) cli_pid: Option<u32>,
}

/// Why a create got no `created`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CreateFailure {
    /// The sidecar answered `create.failed`: the CLI refused the boot, or the
    /// request was invalid. `code` is the sidecar's (`None` when it sent none).
    Refused {
        code: Option<String>,
        message: String,
    },
    /// The sidecar answered `created` in another protocol.
    ProtocolMismatch { message: String },
    /// No answer: the sidecar's stdout ended or failed, or the budget ran out.
    NoAnswer(String),
}

impl CreateFailure {
    /// The `freshAgent.create.failed` code a client gets for this failure.
    pub(crate) fn code(&self) -> &str {
        match self {
            Self::Refused {
                code: Some(code), ..
            } => code,
            Self::Refused { code: None, .. } | Self::NoAnswer(_) => CREATE_FAILED_CODE,
            Self::ProtocolMismatch { .. } => PROTOCOL_MISMATCH_CODE,
        }
    }

    /// What went wrong, in words.
    pub(crate) fn message(&self) -> &str {
        match self {
            Self::Refused { message, .. }
            | Self::ProtocolMismatch { message }
            | Self::NoAnswer(message) => message,
        }
    }

    /// Whether the sidecar named this refusal `code`.
    pub(crate) fn is_refusal(&self, code: &str) -> bool {
        matches!(self, Self::Refused { code: Some(refused), .. } if refused == code)
    }
}

/// What a boot is, for its log record.
pub(crate) struct BootContext<'a> {
    pub(crate) request_id: &'a str,
    pub(crate) session_type: &'a str,
    pub(crate) boot: &'a ClaudeBoot,
}

/// Read the sidecar's stdout until its answer to `create`, bounded by `budget`, and
/// log the boot (`freshagent.claude.boot`, with how long it took). Lines before the
/// answer are dropped; the reader is left on the line after it.
pub(crate) async fn read_created<R>(
    reader: &mut Lines<R>,
    budget: Duration,
    context: &BootContext<'_>,
) -> Result<SidecarCreated, CreateFailure>
where
    R: AsyncBufRead + Unpin,
{
    let started = Instant::now();
    let answer = match tokio::time::timeout(budget, read_answer(reader, context)).await {
        Ok(answer) => answer,
        Err(_) => Err(CreateFailure::NoAnswer(format!(
            "sidecar did not answer `create` within {}s",
            budget.as_secs()
        ))),
    };
    log_boot(context, &answer, started.elapsed());
    answer
}

async fn read_answer<R>(
    reader: &mut Lines<R>,
    context: &BootContext<'_>,
) -> Result<SidecarCreated, CreateFailure>
where
    R: AsyncBufRead + Unpin,
{
    loop {
        let line = match reader.next_line().await {
            Ok(Some(line)) => line,
            // EOF before an answer: the sidecar died at startup (bad node, missing SDK).
            Ok(None) => {
                return Err(CreateFailure::NoAnswer(
                    "sidecar stdout closed before `created`".to_string(),
                ))
            }
            Err(error) => {
                return Err(CreateFailure::NoAnswer(format!(
                    "sidecar stdout read error: {error}"
                )))
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value = serde_json::from_str::<Value>(trimmed).ok();
        let line_type = value
            .as_ref()
            .and_then(|value| value.get("type"))
            .and_then(Value::as_str);
        match (line_type, value.as_ref()) {
            (Some("created"), Some(value)) => return created(value),
            (Some("create.failed"), Some(value)) => return Err(refused(value)),
            _ => {
                // Nothing before the answer is forwarded (design §4.2).
                tracing::debug!(
                    target: "freshell_freshagent::claude",
                    event = "freshagent.claude.handshake_line_dropped",
                    request_id = context.request_id,
                    line_type = line_type.unwrap_or("<not json>"),
                    bytes = trimmed.len(),
                    "a sidecar line before its answer to create was dropped"
                );
            }
        }
    }
}

fn created(value: &Value) -> Result<SidecarCreated, CreateFailure> {
    let protocol = value.get("protocol").and_then(Value::as_u64);
    if protocol != Some(SIDECAR_PROTOCOL) {
        let spoken = protocol.map_or_else(|| "1".to_string(), |p| p.to_string());
        return Err(CreateFailure::ProtocolMismatch {
            message: format!(
                "The Claude sidecar speaks protocol {spoken}; this server speaks protocol \
                 {SIDECAR_PROTOCOL}. The sidecar and the server come from different builds."
            ),
        });
    }
    let session_id = value
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| CreateFailure::NoAnswer("created carried no sessionId".to_string()))?;
    let cli_pid = value
        .get("cliPid")
        .and_then(Value::as_u64)
        .and_then(|pid| u32::try_from(pid).ok());
    Ok(SidecarCreated {
        session_id: session_id.to_string(),
        cli_pid,
    })
}

fn refused(value: &Value) -> CreateFailure {
    CreateFailure::Refused {
        code: value
            .get("code")
            .and_then(Value::as_str)
            .filter(|code| !code.is_empty())
            .map(str::to_string),
        message: value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown sidecar create failure")
            .to_string(),
    }
}

fn log_boot(
    context: &BootContext<'_>,
    answer: &Result<SidecarCreated, CreateFailure>,
    elapsed: Duration,
) {
    let elapsed_ms = u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX);
    let boot = context.boot.kind();
    match answer {
        Ok(created) => tracing::info!(
            target: "freshell_freshagent::claude",
            event = "freshagent.claude.boot",
            request_id = context.request_id,
            session_type = context.session_type,
            boot,
            session_id = %created.session_id,
            cli_pid = created.cli_pid,
            elapsed_ms,
            "the claude CLI booted"
        ),
        Err(failure @ CreateFailure::ProtocolMismatch { .. }) => tracing::error!(
            target: "freshell_freshagent::claude",
            event = "freshagent.claude.boot",
            request_id = context.request_id,
            session_type = context.session_type,
            boot,
            code = failure.code(),
            error = failure.message(),
            elapsed_ms,
            "the claude sidecar speaks another protocol"
        ),
        Err(failure) => tracing::warn!(
            target: "freshell_freshagent::claude",
            event = "freshagent.claude.boot",
            request_id = context.request_id,
            session_type = context.session_type,
            boot,
            code = failure.code(),
            error = failure.message(),
            elapsed_ms,
            "the claude CLI did not boot"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, BufReader};

    const BUDGET: Duration = Duration::from_secs(5);

    fn context() -> BootContext<'static> {
        BootContext {
            request_id: "req-1",
            session_type: "freshclaude",
            boot: &ClaudeBoot::Fresh,
        }
    }

    fn lines(text: &'static str) -> Lines<BufReader<&'static [u8]>> {
        BufReader::new(text.as_bytes()).lines()
    }

    #[tokio::test]
    async fn a_protocol_v2_created_is_the_boot() {
        let mut reader =
            lines("{\"type\":\"created\",\"requestId\":\"req-1\",\"sessionId\":\"s1\",\"protocol\":2,\"cliPid\":4242}\n");
        assert_eq!(
            read_created(&mut reader, BUDGET, &context()).await,
            Ok(SidecarCreated {
                session_id: "s1".into(),
                cli_pid: Some(4242),
            })
        );
    }

    #[tokio::test]
    async fn a_created_in_another_protocol_is_refused_as_a_mismatch() {
        for line in [
            "{\"type\":\"created\",\"requestId\":\"req-1\",\"sessionId\":\"s1\"}\n",
            "{\"type\":\"created\",\"requestId\":\"req-1\",\"sessionId\":\"s1\",\"protocol\":3}\n",
        ] {
            let mut reader = BufReader::new(line.as_bytes()).lines();
            let failure = read_created(&mut reader, BUDGET, &context())
                .await
                .expect_err(line);
            assert!(
                matches!(failure, CreateFailure::ProtocolMismatch { .. }),
                "{failure:?}"
            );
            assert_eq!(failure.code(), "SIDECAR_PROTOCOL_MISMATCH");
        }
    }

    #[tokio::test]
    async fn a_refused_boot_keeps_the_sidecar_code_and_message() {
        let mut reader = lines(
            "{\"type\":\"create.failed\",\"requestId\":\"req-1\",\"code\":\"CONVERSATION_NOT_FOUND\",\"message\":\"No conversation found with session ID: X\"}\n",
        );
        let failure = read_created(&mut reader, BUDGET, &context())
            .await
            .expect_err("refused");
        assert_eq!(failure.code(), "CONVERSATION_NOT_FOUND");
        assert_eq!(
            failure.message(),
            "No conversation found with session ID: X"
        );
        assert!(failure.is_refusal("CONVERSATION_NOT_FOUND"));
        // An answer with no code still fails the create, under the generic code.
        let mut reader = lines("{\"type\":\"create.failed\",\"message\":\"boom\"}\n");
        let failure = read_created(&mut reader, BUDGET, &context())
            .await
            .expect_err("refused");
        assert_eq!(failure.code(), "CLAUDE_CREATE_FAILED");
        assert_eq!(failure.message(), "boom");
    }

    #[tokio::test]
    async fn nothing_before_the_answer_is_forwarded_and_the_reader_stops_after_it() {
        let mut reader = lines(concat!(
            "{\"type\":\"sdk.result\",\"sessionId\":\"s1\",\"result\":\"error_during_execution\"}\n",
            "not json\n",
            "\n",
            "{\"type\":\"sdk.error\",\"sessionId\":\"s1\",\"message\":\"boom\"}\n",
            "{\"type\":\"created\",\"requestId\":\"req-1\",\"sessionId\":\"s1\",\"protocol\":2}\n",
            "{\"type\":\"sdk.session.changed\",\"sessionId\":\"s1\"}\n",
        ));
        let created = read_created(&mut reader, BUDGET, &context())
            .await
            .expect("created");
        assert_eq!(created.session_id, "s1");
        // The consumer that takes the reader over starts at the line after created.
        let next = reader.next_line().await.unwrap().unwrap();
        assert!(next.contains("sdk.session.changed"), "{next}");
    }

    #[tokio::test]
    async fn a_sidecar_that_ends_without_answering_fails_the_create() {
        let mut reader = lines("{\"type\":\"sdk.status\",\"sessionId\":\"s1\"}\n");
        let failure = read_created(&mut reader, BUDGET, &context())
            .await
            .expect_err("no answer");
        assert!(matches!(failure, CreateFailure::NoAnswer(_)), "{failure:?}");
        assert_eq!(failure.code(), "CLAUDE_CREATE_FAILED");
    }

    #[tokio::test]
    async fn a_sidecar_that_never_answers_fails_the_create_at_the_budget() {
        let (_writer, read_half) = tokio::io::duplex(64);
        let mut reader = BufReader::new(read_half).lines();
        let failure = read_created(&mut reader, Duration::from_millis(50), &context())
            .await
            .expect_err("timed out");
        assert!(matches!(failure, CreateFailure::NoAnswer(_)), "{failure:?}");
    }
}
