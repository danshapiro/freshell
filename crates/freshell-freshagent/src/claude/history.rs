//! A claude session's history as undo, redo and fork read it (core-runtime
//! design §4.5): the conversation the session holds, and the real transcript a
//! fork of it reads. Before the CLI writes a session's transcript, its genesis
//! says what it holds: a pending fork holds its parent's chain through the fork
//! point, a fresh session nothing.

use super::*;

use crate::claude_launch::ClaudeGenesis;
use crate::claude_snapshot as snap;

/// A session's effective transcript (design §4.5): what it holds now, and the
/// real transcript a fork of it reads.
pub(super) struct EffectiveTranscript {
    /// The conversation as the session holds it.
    pub(super) text: String,
    /// The session a fork of it reads: itself, or, for a pending fork, its
    /// parent (source collapse).
    pub(super) source: String,
    /// That source's own transcript text and path (empty / `None` for a
    /// `Fresh` session, which has none).
    pub(super) source_text: String,
    pub(super) source_path: Option<PathBuf>,
}

/// Why a session's effective transcript could not be read.
pub(super) enum EffectiveTranscriptError {
    /// No transcript and no genesis: nothing the store knows.
    Missing,
    /// The store could not be checked (G28: never "empty").
    Unreadable(snap::LocateError),
    /// A located transcript (or a pending fork's parent) could not be read.
    Read(String),
}

impl FreshClaudeState {
    /// The session's effective transcript (design §4.5): its transcript when
    /// the CLI wrote one; before that, what its genesis holds (a pending fork
    /// holds its parent's chain through the fork point, a fresh session
    /// nothing). The genesis is the binding row's, or the live runtime's own
    /// on a lane with no ledger.
    pub(super) async fn effective_transcript(
        &self,
        session_id: &str,
    ) -> Result<EffectiveTranscript, EffectiveTranscriptError> {
        match self.locate_transcript(session_id) {
            snap::TranscriptLocation::Found(path) => {
                let text = std::fs::read_to_string(&path)
                    .map_err(|e| EffectiveTranscriptError::Read(e.to_string()))?;
                Ok(EffectiveTranscript {
                    source_text: text.clone(),
                    text,
                    source: session_id.to_string(),
                    source_path: Some(path),
                })
            }
            snap::TranscriptLocation::Unreadable(error) => {
                Err(EffectiveTranscriptError::Unreadable(error))
            }
            snap::TranscriptLocation::Absent => {
                // The binding row's genesis, else the one the live runtime was
                // launched from (a lane with no ledger records none).
                let genesis = self
                    .load_genesis(session_id)
                    .await
                    .map(|recorded| recorded.genesis);
                match genesis {
                    None => Err(EffectiveTranscriptError::Missing),
                    Some(ClaudeGenesis::Fresh) => Ok(EffectiveTranscript {
                        text: String::new(),
                        source: session_id.to_string(),
                        source_text: String::new(),
                        source_path: None,
                    }),
                    Some(ClaudeGenesis::Fork { parent, at, .. }) => {
                        let path = match self.locate_transcript(&parent) {
                            snap::TranscriptLocation::Found(path) => path,
                            snap::TranscriptLocation::Absent => {
                                return Err(EffectiveTranscriptError::Read(format!(
                                    "the conversation this one was forked from ({parent}) is gone"
                                )))
                            }
                            snap::TranscriptLocation::Unreadable(error) => {
                                return Err(EffectiveTranscriptError::Unreadable(error))
                            }
                        };
                        let parent_text = std::fs::read_to_string(&path)
                            .map_err(|e| EffectiveTranscriptError::Read(e.to_string()))?;
                        let text = snap::fork_prefix_transcript(&parent_text, at.as_deref())
                            .ok_or_else(|| {
                                EffectiveTranscriptError::Read(format!(
                                    "the point this conversation was forked at is no longer in {parent}"
                                ))
                            })?;
                        Ok(EffectiveTranscript {
                            text,
                            source: parent,
                            source_text: parent_text,
                            source_path: Some(path),
                        })
                    }
                }
            }
        }
    }

    /// `session_id`'s transcript text, when the store has one (`Ok(None)`
    /// when it has none).
    pub(super) fn read_located_transcript(
        &self,
        session_id: &str,
    ) -> Result<Option<String>, EffectiveTranscriptError> {
        match self.locate_transcript(session_id) {
            snap::TranscriptLocation::Found(path) => std::fs::read_to_string(&path)
                .map(Some)
                .map_err(|e| EffectiveTranscriptError::Read(e.to_string())),
            snap::TranscriptLocation::Absent => Ok(None),
            snap::TranscriptLocation::Unreadable(error) => {
                Err(EffectiveTranscriptError::Unreadable(error))
            }
        }
    }
}
