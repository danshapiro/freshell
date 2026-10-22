//! Name-reliability Task 5 (V2, LB-B11): which persisted parse-cache entries
//! must be re-derived because the first-message rules changed.
//!
//! The session index keeps every parsed transcript in a persistent cache
//! (`rust-session-cache.json`) keyed by the file's `(mtime, size)`, so an
//! unchanged file is never re-parsed. When the rules that extract a
//! session's first user message change (Task 5 taught
//! [`crate::text::extract_user_authored_text`] the tool wrapper tags), cached
//! entries keep the message the OLD rules derived. Bumping the cache's
//! schema version would re-parse every transcript at boot (17.6 GB on the
//! live host), so instead each entry carries the rules version it was
//! derived under, and only an entry that is below the current version AND
//! whose cached first message opens with a wrapper tag is dropped and
//! re-parsed — once: every entry the parser writes, and every older entry
//! that is kept, is stamped current, and a stamped entry is never
//! content-retested (even one whose re-derived message still opens with a
//! tag, so no message can cause a re-parse on every boot).

use crate::text::starts_with_context_tag;

/// The current first-message rules. Bump it whenever the extraction of a
/// Claude or Codex first user message changes so that cached rows must be
/// re-derived, and widen [`cached_first_message_is_stale`] to recognize what
/// the older rules got wrong.
///
/// - `1`: the tool wrapper tags (`<recommended_plugins>`,
///   `<local-command-caveat>`, ...) are system context.
pub(crate) const FIRST_MESSAGE_RULES_VERSION: u32 = 1;

/// Whether a cached entry derived under rules version `stamp` must be
/// re-parsed: only Claude and Codex rows (the providers whose first message
/// the wrapper tags reach), only below the current version, and only when
/// the cached first message opens with a context tag.
pub(crate) fn cached_first_message_is_stale(
    stamp: u32,
    provider: &str,
    first_user_message: Option<&str>,
) -> bool {
    stamp < FIRST_MESSAGE_RULES_VERSION
        && matches!(provider, "claude" | "codex")
        && first_user_message.is_some_and(starts_with_context_tag)
}

#[cfg(test)]
mod tests {
    use super::*;

    const WRAPPER: &str = "<recommended_plugins>\n- github: review pull requests";

    #[test]
    fn only_unstamped_tag_led_claude_and_codex_messages_are_stale() {
        assert!(cached_first_message_is_stale(0, "codex", Some(WRAPPER)));
        assert!(cached_first_message_is_stale(
            0,
            "claude",
            Some("<local-command-caveat>Caveat: The messages below")
        ));
        // Stamped: never retested, whatever the message.
        assert!(!cached_first_message_is_stale(
            FIRST_MESSAGE_RULES_VERSION,
            "codex",
            Some(WRAPPER)
        ));
        // A real message, no message, or another provider stays cached.
        assert!(!cached_first_message_is_stale(
            0,
            "codex",
            Some("Fix the sardine importer")
        ));
        assert!(!cached_first_message_is_stale(0, "codex", None));
        assert!(!cached_first_message_is_stale(0, "opencode", Some(WRAPPER)));
        assert!(!cached_first_message_is_stale(
            0,
            "amplifier",
            Some(WRAPPER)
        ));
    }
}
