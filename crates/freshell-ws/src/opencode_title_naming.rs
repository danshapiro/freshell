//! The CLI opencode lane's native-title fold (unified-agent-names Task 3;
//! name-reliability Task 4): the `NativeTitleObserver` `main.rs` installs on
//! the lane, built here so it is testable against the real lane.
//!
//! The lane calls the observer synchronously for every `session.updated`
//! title, in stream order. The observer resolves the naming target (the
//! durable opencode session's record, else the terminal's own pending ref),
//! drops provider placeholders, RESERVES the observation's sequence right
//! away — so the folds keep stream order even though each runs on its own
//! task — and spawns the fold. The lane never waits on the naming store.

use std::sync::Arc;

use freshell_freshagent::naming::{is_placeholder_for_target, NativeNameOrigin, SessionNaming};

use crate::identity::TerminalIdentityRegistry;
use crate::opencode_lane::NativeTitleObserver;

/// The observer for a lane: folds through `names` (`None` — a degraded boot
/// without a store — drops every observation).
pub fn naming_title_observer(
    identity: TerminalIdentityRegistry,
    names: Option<Arc<dyn SessionNaming>>,
) -> NativeTitleObserver {
    Arc::new(move |terminal_id: &str, session_id: &str, title: &str| {
        let Some(names) = names.as_ref() else {
            return;
        };
        let Some(target) = identity
            .named_session_ref_of("opencode", session_id)
            .or_else(|| identity.name_ref_for(terminal_id))
        else {
            return;
        };
        if is_placeholder_for_target(&target, title) {
            return;
        }
        let ticket = freshell_freshagent::native_observation_retry::reserve(names, &target);
        let title = title.to_string();
        tokio::spawn(async move {
            let _ = freshell_freshagent::native_observation_retry::submit(
                ticket,
                title,
                NativeNameOrigin::Snapshot,
                None,
            )
            .await;
        });
    })
}
