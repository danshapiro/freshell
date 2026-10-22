//! Read-only transcript parsers for the three coding-CLI providers.
//!
//! Each is a faithful port of the corresponding reference parser and is corruption-safe
//! by construction: a malformed line is skipped, never panicking the process (mirroring
//! the reference's `try { JSON.parse } catch { continue }`).

pub mod claude;
pub mod codex;
pub mod opencode;

pub use claude::{parse_session_content, ClaudeUsageAccumulator, ParseSessionOptions};
pub use codex::parse_codex_session_content;
pub use opencode::{
    default_opencode_data_home, is_opencode_placeholder_title, opencode_compact_percent,
    opencode_context_count, opencode_first_user_message_by_id, opencode_max_output_tokens,
    opencode_session_row_by_id, opencode_usable_context, run_opencode_listing_query,
    session_exists_by_id, session_is_subagent_by_id, OpencodeByIdError, OpencodeByIdRow,
    OpencodeDegrade, OpencodeListing, OpencodeListingResult, OpencodeModelLimits, OpencodeProvider,
    OpencodeReadError, OpencodeSession, OpencodeSessionRow, OpencodeStepUsage,
    OPENCODE_COMPACTION_BUFFER_TOKENS, OPENCODE_OUTPUT_TOKEN_MAX, THREE_VIEWS_MARKER_SQL_PATTERN,
};
