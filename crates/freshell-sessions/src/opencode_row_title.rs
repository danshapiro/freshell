//! The title an OpenCode session row presents (name-reliability plan,
//! Task 4).
//!
//! opencode stores a temporary placeholder title (`New session - <ISO>`,
//! see [`crate::name_evidence::is_provider_placeholder_title`]) until it
//! names a session itself after the first exchange. A placeholder — or a
//! blank title — is not a name: the sidebar and the history page render a
//! row's `title` whenever no saved name is known yet, so presenting it put
//! the placeholder on screen. Such a row presents the title derived from its
//! first user message instead (the convention Claude and Codex rows already
//! follow when their transcript carries no provider title), else no title.
//! The derived title is never a provider name: the row's `title_source`
//! stays unset, so the naming ladder still treats the session as unnamed.
//!
//! Pure functions, no IO.

use crate::name_evidence::is_provider_placeholder_title;
use crate::text::extract_title_from_message;

/// Character cap of a title derived from a first user message (the Claude
/// and Codex parse layers use the same cap).
const DERIVED_TITLE_MAX_CHARS: usize = 200;

/// Whether opencode's stored session title is opencode's own name for the
/// session: present, not blank and not one of its placeholders.
pub(crate) fn is_opencode_session_name(stored_title: Option<&str>) -> bool {
    stored_title.is_some_and(|title| {
        !title.trim().is_empty() && !is_provider_placeholder_title("opencode", title)
    })
}

/// The title an opencode row presents: opencode's own name when it has
/// one, else the title derived from the first user message, else none.
pub(crate) fn opencode_row_title(
    stored_title: Option<String>,
    first_user_message: Option<&str>,
) -> Option<String> {
    if is_opencode_session_name(stored_title.as_deref()) {
        return stored_title;
    }
    first_user_message
        .map(|message| extract_title_from_message(message, DERIVED_TITLE_MAX_CHARS))
        .filter(|title| !title.is_empty())
}
