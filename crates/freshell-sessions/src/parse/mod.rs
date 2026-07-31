//! Read-only transcript parsers for the three coding-CLI providers.
//!
//! Each is a faithful port of the corresponding reference parser and is corruption-safe
//! by construction: a malformed line is skipped, never panicking the process (mirroring
//! the reference's `try { JSON.parse } catch { continue }`).

pub mod claude;
pub mod codex;
pub mod opencode;

pub use claude::{parse_session_content, ParseSessionOptions};
pub use codex::parse_codex_session_content;
pub use opencode::{
    default_opencode_data_home, opencode_session_row_by_id, run_opencode_listing_query,
    session_exists_by_id, OpencodeByIdError, OpencodeByIdRow, OpencodeDegrade, OpencodeListing,
    OpencodeListingResult, OpencodeProvider, OpencodeReadError, OpencodeSession,
    OpencodeSessionRow, THREE_VIEWS_MARKER_SQL_PATTERN,
};
