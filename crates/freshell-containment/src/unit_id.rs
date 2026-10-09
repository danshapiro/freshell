//! Unit identity and the environment tags that carry it.

/// The environment tag every contained process carries (degraded backends
/// find members by it; full backends set it too, for diagnostics).
pub const UNIT_ENV: &str = "FRESHELL_UNIT_ID";

/// The v1 Codex sidecar tag (`freshell_codex::durability::CODEX_SIDECAR_OWNERSHIP_ENV`;
/// this leaf crate cannot import it). Read only for legacy sidecar records,
/// and stripped from the server's own environment at start so a server
/// started inside a pane never hands that pane's tag to what it starts.
pub const LEGACY_CODEX_TAG_ENV: &str = "FRESHELL_CODEX_SIDECAR_ID";

/// `u` + 32 lowercase hex: dash-free, so it is a valid systemd unit-name
/// component and a Windows job-name component.
#[derive(
    Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(transparent)]
pub struct UnitId(String);

impl UnitId {
    pub fn mint() -> Self {
        Self(format!("u{}", uuid::Uuid::new_v4().simple()))
    }

    /// Accepts exactly the minted shape; anything else is `None`.
    pub fn parse(raw: &str) -> Option<Self> {
        let hex = raw.strip_prefix('u')?;
        (hex.len() == 32
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        .then(|| Self(raw.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for UnitId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
