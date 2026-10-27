//! Name reliability (plan Task 9, D7): the names a rebuilt window restores.
//!
//! A new window (or any inventory rebuild) rebuilds its workspace from the
//! recovery inventory, so each inventory tab and pane carries the title its
//! registry snapshot recorded together with the "user renamed" flags: the
//! pane's `titleSetByUser` and the tab's `titleSetByUser`. Without the flags
//! a restored shell, browser or editor name would lose its protection and
//! the next automatic title (a terminal's OSC title, for example) would
//! replace it.
//!
//! These fields are display data, never offer substance: they are NOT part
//! of the dismissal digest (`contentId`), so renaming a tab or a pane never
//! re-keys an offer the user already declined. Only well-typed values
//! forward (a title is a string, a flag is a boolean); a malformed value is
//! left out rather than passed on. Scoped agent panes are named by their
//! saved session record; the client drops their titles when it rebuilds.

use serde_json::{Map, Value};

/// Copy a registry pane snapshot's `title` (a string) and `titleSetByUser`
/// (a boolean) into its inventory pane projection.
pub(super) fn forward_pane_names(snapshot: &Value, projection: &mut Value) {
    let Some(projection) = projection.as_object_mut() else {
        return;
    };
    if let Some(title) = snapshot.get("title").filter(|value| value.is_string()) {
        projection.insert("title".to_string(), title.clone());
    }
    if let Some(flag) = snapshot
        .get("titleSetByUser")
        .filter(|value| value.is_boolean())
    {
        projection.insert("titleSetByUser".to_string(), flag.clone());
    }
}

/// Copy a registry record's tab-level `titleSetByUser` (a boolean) into its
/// inventory tab projection.
pub(super) fn forward_tab_user_flag(record: &Value, projection: &mut Map<String, Value>) {
    if let Some(flag) = record
        .get("titleSetByUser")
        .filter(|value| value.is_boolean())
    {
        projection.insert("titleSetByUser".to_string(), flag.clone());
    }
}
