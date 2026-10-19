//! Shared typed native-auth shape validation for selected provider grants.
//! Credential values are transient and must never be logged.
use std::collections::BTreeSet;

pub fn validate_native_auth(provider: &str, raw: &[u8]) -> Result<BTreeSet<String>, String> {
    let invalid = || "OneCLI typed native auth has an unsupported provider shape".to_owned();
    if provider == "amplifier" {
        let parsed = crate::provider_environment_grants::parse_environment_values(
            crate::provider_environment_grants::EnvironmentProfile::Amplifier,
            std::str::from_utf8(raw).map_err(|_| invalid())?,
        )
        .map_err(|_| invalid())?;
        if parsed.keys().any(|name| name.ends_with("_API_KEY")) {
            return Ok(BTreeSet::new());
        }
        return Err(invalid());
    }
    let native: serde_json::Value = serde_json::from_slice(raw).map_err(|_| invalid())?;
    let string = |value: &serde_json::Value, name: &str| {
        value
            .get(name)
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| !value.is_empty())
    };
    match provider {
        "codex" => {
            // Codex 0.147 infers the mode for older auth files. Account identity
            // is optional, but native bearer-token extraction needs last_refresh.
            // Externally managed tokens may have an empty refresh token.
            let mode = if native["auth_mode"].is_null() {
                if native["OPENAI_API_KEY"].is_null() {
                    "chatgpt"
                } else {
                    "apikey"
                }
            } else {
                native["auth_mode"].as_str().unwrap_or_default()
            };
            match mode {
                "chatgpt" | "chatgptAuthTokens"
                    if native["OPENAI_API_KEY"].is_null()
                        && ["access_token", "id_token"]
                            .iter()
                            .all(|name| string(&native["tokens"], name))
                        && native["tokens"]["refresh_token"].is_string()
                        && (native["tokens"]["account_id"].is_null()
                            || native["tokens"]["account_id"].is_string())
                        && string(&native, "last_refresh") =>
                {
                    Ok(BTreeSet::from(["openai".into()]))
                }
                "apikey" if string(&native, "OPENAI_API_KEY") => Ok(BTreeSet::new()),
                _ => Err(invalid()),
            }
        }
        "claude"
            if string(&native["claudeAiOauth"], "accessToken")
                && string(&native["claudeAiOauth"], "refreshToken") =>
        {
            Ok(BTreeSet::from(["anthropic".into()]))
        }
        "opencode" => {
            let Some(entries) = native.as_object().filter(|entries| !entries.is_empty()) else {
                return Err(invalid());
            };
            let mut oauth_providers = BTreeSet::new();
            let mut has_credential = false;
            for (model_provider, entry) in entries {
                match entry["type"].as_str() {
                    Some("oauth")
                        if string(entry, "access")
                            && string(entry, "refresh")
                            && entry["expires"].as_i64().is_some_and(|expiry| expiry > 0) =>
                    {
                        oauth_providers.insert(model_provider.clone());
                        has_credential = true;
                    }
                    Some("api") if string(entry, "key") => has_credential = true,
                    // Native OpenCode keeps organization environment/config
                    // overlays in this same file, beside model credentials.
                    // They are supported input, but do not authorize egress.
                    Some("wellknown") if entry["key"].is_string() && entry["token"].is_string() => {
                    }
                    _ => return Err(invalid()),
                }
            }
            if has_credential {
                Ok(oauth_providers)
            } else {
                Err(invalid())
            }
        }
        _ => Err(invalid()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencode_native_auth_admits_supported_wellknown_entries_beside_real_credentials() {
        for credential in [
            serde_json::json!({"type":"api","key":"synthetic-api"}),
            serde_json::json!({"type":"oauth","access":"synthetic-access","refresh":"synthetic-refresh","expires":1}),
        ] {
            let raw = serde_json::to_vec(&serde_json::json!({
                "openai":credential,
                "https://organization.invalid":{"type":"wellknown","key":"RULE_ROOT","token":"/synthetic/rules"}
            })).unwrap();
            let providers = validate_native_auth("opencode", &raw).unwrap();
            assert_eq!(providers.contains("openai"), credential["type"] == "oauth");
            assert!(!providers.contains("https://organization.invalid"));
        }
    }

    #[test]
    fn opencode_wellknown_only_or_malformed_overlay_does_not_authorize_model_transport() {
        for value in [
            serde_json::json!({"organization":{"type":"wellknown","key":"RULE_ROOT","token":"/synthetic/rules"}}),
            serde_json::json!({"openai":{"type":"api","key":"synthetic-api"},"organization":{"type":"wellknown","key":"RULE_ROOT"}}),
        ] {
            assert!(
                validate_native_auth("opencode", &serde_json::to_vec(&value).unwrap()).is_err()
            );
        }
    }
}
