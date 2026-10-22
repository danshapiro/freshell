//! The view a managed launch asks the supervisor to keep discoverable.

use freshell_runtime_protocol::{ViewIntentKind, ViewIntentRequest, ViewVisibilityIntent};

/// The automatic primary view a managed launch (terminal or fresh agent)
/// requests for `workspace_id`.
///
/// It never carries a title: names belong to the user and the saved-name
/// document, never to the runtime. A provider label here ("Shell agent",
/// "OpenCode agent") used to be written over tab names by every browser
/// refresh (name reliability, Task 8).
pub(crate) fn automatic_primary_view_request(
    workspace_id: String,
    preferred_tab_id: Option<String>,
    preferred_pane_id: Option<String>,
) -> ViewIntentRequest {
    ViewIntentRequest {
        owner_id: String::new(),
        workspace_id,
        kind: ViewIntentKind::AutomaticPrimary,
        preferred_tab_id,
        preferred_pane_id,
        title: None,
        placement_group: None,
        visibility: ViewVisibilityIntent::Visible,
    }
}
