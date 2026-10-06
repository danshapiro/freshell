//! Pure finite OneCLI environment decoding shared by controller and session host.
//! Resolved values are transient child-process data and must never be logged.
use std::{collections::BTreeMap, path::Path};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnvironmentProfile {
    Claude,
    Codex,
    Opencode,
    Amplifier,
    AmplifierLunarouteGlm53,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrantOperation {
    Read,
    Decode,
}

#[derive(Debug)]
pub struct GrantError {
    pub operation: GrantOperation,
    pub profile: EnvironmentProfile,
    pub field: Option<&'static str>,
    pub source_ordinal: Option<usize>,
    reason: String,
}
impl std::fmt::Display for GrantError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{:?} {:?} environment grant: {}",
            self.operation, self.profile, self.reason
        )
    }
}
impl std::error::Error for GrantError {}

fn error(profile: EnvironmentProfile, operation: GrantOperation, reason: String) -> GrantError {
    let source_ordinal = reason
        .strip_prefix("OneCLI environment grant line ")
        .and_then(|tail| tail.split_whitespace().next())
        .and_then(|number| number.parse().ok());
    let field = ALLOWED_NAMES
        .iter()
        .copied()
        .find(|name| reason.contains(name));
    GrantError {
        operation,
        profile,
        field,
        source_ordinal,
        reason,
    }
}

pub fn resolve_environment_profile(
    profile: EnvironmentProfile,
    raw: &str,
) -> Result<BTreeMap<String, String>, GrantError> {
    if raw.len() > MAX_KEYS_BYTES as usize {
        return Err(error(
            profile,
            GrantOperation::Decode,
            "grant exceeds 128 KiB".into(),
        ));
    }
    decode_profile(profile, raw).map_err(|reason| error(profile, GrantOperation::Decode, reason))
}

/// Charge actual bytes, including source growth after metadata inspection.
fn read_bounded(
    reader: impl std::io::Read,
    profile: EnvironmentProfile,
) -> Result<String, GrantError> {
    use std::io::Read;
    let mut bytes = Vec::new();
    reader
        .take(MAX_KEYS_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error(profile, GrantOperation::Read, "grant read failed".into()))?;
    if bytes.len() > MAX_KEYS_BYTES as usize {
        return Err(error(
            profile,
            GrantOperation::Read,
            "grant exceeds 128 KiB".into(),
        ));
    }
    String::from_utf8(bytes)
        .map_err(|_| error(profile, GrantOperation::Decode, "grant is not UTF-8".into()))
}

pub fn read_environment_grant(
    path: &Path,
    profile: EnvironmentProfile,
) -> Result<BTreeMap<String, String>, GrantError> {
    let fail = |reason: &str| error(profile, GrantOperation::Read, reason.into());
    let canonical = std::fs::canonicalize(path).map_err(|_| fail("grant is unavailable"))?;
    let metadata = std::fs::symlink_metadata(path).map_err(|_| fail("grant is unavailable"))?;
    if canonical != path || !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(fail("grant must be a canonical regular private file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(fail("grant must be a canonical regular private file"));
        }
    }
    let file = std::fs::File::open(path).map_err(|_| fail("grant is unavailable"))?;
    let raw = read_bounded(file, profile)?;
    resolve_environment_profile(profile, &raw)
}

const MAX_KEYS_BYTES: u64 = 128 * 1024;
const MAX_VALUE_BYTES: usize = 16 * 1024;
const ALLOWED_NAMES: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CURL_CA_BUNDLE",
    "GLM_RUNPOD_API_KEY",
    "GLM_RUNPOD_BASE_URL",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "LUNAROUTE_API_KEY",
    "LUNAROUTE_BASE_URL",
    "NODE_EXTRA_CA_CERTS",
    "NODE_USE_ENV_PROXY",
    "NO_PROXY",
    "ONECLI_GATEWAY",
    "ONECLI_URL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENCODE_API_KEY",
    "OPENROUTER_API_KEY",
    "REQUESTS_CA_BUNDLE",
    "SSL_CERT_FILE",
    "http_proxy",
    "https_proxy",
    "no_proxy",
];
const CERTIFICATE_CHILD_NAMES: &[&str] = &[
    "CURL_CA_BUNDLE",
    "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
    "SSL_CERT_FILE",
];

fn decode_profile(
    profile: EnvironmentProfile,
    raw: &str,
) -> Result<BTreeMap<String, String>, String> {
    let parsed = parse_keys_env(raw)?;
    match profile {
        EnvironmentProfile::Claude => resolve_provider_environment(
            &parsed,
            &[
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_BASE_URL",
                "CLAUDE_CODE_OAUTH_TOKEN",
            ],
            false,
        ),
        EnvironmentProfile::Codex => {
            resolve_provider_environment(&parsed, &["OPENAI_API_KEY", "OPENAI_BASE_URL"], false)
        }
        EnvironmentProfile::Opencode => resolve_provider_environment(
            &parsed,
            &[
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_BASE_URL",
                "OPENAI_API_KEY",
                "OPENAI_BASE_URL",
                "GOOGLE_GENERATIVE_AI_API_KEY",
                "GOOGLE_API_KEY",
                "GEMINI_API_KEY",
                "OPENROUTER_API_KEY",
                "OPENCODE_API_KEY",
            ],
            true,
        ),
        EnvironmentProfile::Amplifier => resolve_provider_environment(
            &parsed,
            &[
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_BASE_URL",
                "OPENAI_API_KEY",
                "OPENAI_BASE_URL",
                "LUNAROUTE_API_KEY",
                "LUNAROUTE_BASE_URL",
                "GLM_RUNPOD_API_KEY",
                "GLM_RUNPOD_BASE_URL",
                "GOOGLE_API_KEY",
                "GEMINI_API_KEY",
                "OPENROUTER_API_KEY",
            ],
            false,
        ),
        EnvironmentProfile::AmplifierLunarouteGlm53 => {
            // The approved proxy may replace a provider placeholder key, so
            // only non-emptiness is required here. The credentialed gateway
            // URL itself must never retain its operator placeholder.
            let api_key = required(&parsed, "LUNAROUTE_API_KEY")?;
            let upstream = required(&parsed, "LUNAROUTE_BASE_URL")?;
            validate_https_upstream(upstream)?;
            let gateway = required(&parsed, "ONECLI_GATEWAY")?;
            if gateway != "1" && !gateway.eq_ignore_ascii_case("enabled") {
                return Err(
                    "Amplifier OneCLI profile requires ONECLI_GATEWAY to be enabled".into(),
                );
            }
            let upper_proxy = parsed.get("HTTPS_PROXY").map(String::as_str);
            let lower_proxy = parsed.get("https_proxy").map(String::as_str);
            if matches!((upper_proxy, lower_proxy), (Some(upper), Some(lower)) if upper != lower) {
                return Err("Amplifier OneCLI HTTPS_PROXY and https_proxy values conflict".into());
            }
            let proxy = upper_proxy.or(lower_proxy).ok_or_else(|| {
                "Amplifier OneCLI profile requires a container-reachable HTTPS proxy".to_string()
            })?;
            reject_proxy_placeholder(proxy)?;
            validate_container_proxy(proxy)?;

            // ONECLI_URL is a host-local control endpoint in the approved
            // setup. Do not forward it into the container: 127.0.0.1 there is
            // the soul, not the host gateway. NO_PROXY is also deliberately
            // omitted so the approved upstream cannot bypass the gateway.
            // Provider-vllm needs only its upstream/API-key pair plus the
            // canonical proxy and certificate transport.
            let mut child = BTreeMap::new();
            child.insert("VLLM_API_KEY".into(), api_key.to_string());
            child.insert("VLLM_BASE_URL".into(), upstream.to_string());
            child.insert("HTTPS_PROXY".into(), proxy.to_string());
            child.insert("https_proxy".into(), proxy.to_string());
            for name in CERTIFICATE_CHILD_NAMES {
                if let Some(value) = parsed.get(*name) {
                    child.insert((*name).to_string(), value.clone());
                }
            }
            Ok(child)
        }
    }
}

fn resolve_provider_environment(
    parsed: &BTreeMap<String, String>,
    provider_names: &[&str],
    allow_opencode_proxy_settings: bool,
) -> Result<BTreeMap<String, String>, String> {
    let mut child = BTreeMap::new();
    for (name, value) in parsed {
        if provider_names.contains(&name.as_str())
            || CERTIFICATE_CHILD_NAMES.contains(&name.as_str())
        {
            child.insert(name.clone(), value.clone());
        } else if matches!(name.as_str(), "HTTPS_PROXY" | "https_proxy") {
            reject_proxy_placeholder(value)?;
            validate_container_proxy(value)?;
            child.insert(name.clone(), value.clone());
        } else if matches!(name.as_str(), "HTTP_PROXY" | "http_proxy") {
            if allow_opencode_proxy_settings {
                reject_proxy_placeholder(value)?;
                validate_container_proxy(value)?;
                child.insert(name.clone(), value.clone());
            }
        } else if name == "NODE_USE_ENV_PROXY" {
            if allow_opencode_proxy_settings {
                if value != "1" {
                    return Err("NODE_USE_ENV_PROXY must be set to 1".into());
                }
                child.insert(name.clone(), value.clone());
            }
        } else if matches!(name.as_str(), "NO_PROXY" | "no_proxy") {
            if allow_opencode_proxy_settings {
                validate_loopback_no_proxy(value)?;
                child.insert(name.clone(), value.clone());
            }
        } else if !matches!(name.as_str(), "ONECLI_URL" | "ONECLI_GATEWAY") {
            return Err(format!("OneCLI environment profile does not allow {name}"));
        }
    }
    if child.is_empty()
        || !child
            .keys()
            .any(|name| provider_names.contains(&name.as_str()))
    {
        return Err("OneCLI environment profile has no provider values".into());
    }
    for (upper_name, lower_name, display_name) in [
        ("HTTPS_PROXY", "https_proxy", "HTTPS_PROXY"),
        ("HTTP_PROXY", "http_proxy", "HTTP_PROXY"),
        ("NO_PROXY", "no_proxy", "NO_PROXY"),
    ] {
        if let (Some(upper), Some(lower)) = (child.get(upper_name), child.get(lower_name)) {
            if upper != lower {
                return Err(format!("OneCLI {display_name} values conflict"));
            }
        }
    }
    Ok(child)
}

fn validate_loopback_no_proxy(value: &str) -> Result<(), String> {
    let entries = value
        .split(',')
        .map(|entry| entry.trim().to_ascii_lowercase())
        .collect::<Vec<_>>();
    if entries.is_empty()
        || entries
            .iter()
            .any(|entry| !matches!(entry.as_str(), "localhost" | "127.0.0.1" | "::1" | "[::1]"))
    {
        return Err("OneCLI NO_PROXY may bypass only loopback hosts".into());
    }
    Ok(())
}

fn validate_https_upstream(value: &str) -> Result<(), String> {
    let url = url::Url::parse(value)
        .map_err(|_| "LUNAROUTE_BASE_URL must be a valid credential-free HTTPS URL".to_string())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("LUNAROUTE_BASE_URL must be a credential-free HTTPS URL".into());
    }
    Ok(())
}

fn validate_container_proxy(value: &str) -> Result<(), String> {
    let url = url::Url::parse(value)
        .map_err(|_| "OneCLI proxy value must be a valid HTTP(S) URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("HTTPS_PROXY must be a valid HTTP(S) URL".into());
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if host == "localhost" || host == "::1" || host.starts_with("127.") {
        return Err(
            "OneCLI proxy cannot use container loopback; use the approved proxy address reachable from the managed bridge"
                .into(),
        );
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("OneCLI proxy cannot contain query or fragment data".into());
    }
    Ok(())
}

fn parse_keys_env(raw: &str) -> Result<BTreeMap<String, String>, String> {
    let mut values = BTreeMap::new();
    for (offset, original) in raw.lines().enumerate() {
        let line_number = offset + 1;
        let mut line = original.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("export ") {
            line = rest.trim_start();
        }
        let (name, encoded) = line.split_once('=').ok_or_else(|| {
            format!("OneCLI environment grant line {line_number} must be NAME=VALUE")
        })?;
        if !ALLOWED_NAMES.contains(&name) {
            return Err(format!(
                "OneCLI environment grant line {line_number} uses an unsupported name"
            ));
        }
        if values.contains_key(name) {
            return Err(format!(
                "OneCLI environment grant line {line_number} duplicates {name}"
            ));
        }
        let value = decode_value(encoded, &values, line_number)?;
        if value.is_empty() || value.len() > MAX_VALUE_BYTES {
            return Err(format!(
                "OneCLI environment grant line {line_number} has an empty or oversized value"
            ));
        }
        values.insert(name.to_string(), value);
    }
    Ok(values)
}

fn decode_value(
    encoded: &str,
    prior: &BTreeMap<String, String>,
    line_number: usize,
) -> Result<String, String> {
    if !encoded.is_ascii()
        || encoded.contains('`')
        || encoded.contains("$(")
        || encoded.contains('\0')
    {
        return Err(format!(
            "OneCLI environment grant line {line_number} contains unsupported encoding or shell execution syntax"
        ));
    }
    if encoded.starts_with('\'') {
        if encoded.len() < 2 || !encoded.ends_with('\'') {
            return Err(format!(
                "OneCLI environment grant line {line_number} has malformed single quotes"
            ));
        }
        return Ok(encoded[1..encoded.len() - 1].to_string());
    }
    let value = if encoded.starts_with('"') {
        if encoded.len() < 2 || !encoded.ends_with('"') {
            return Err(format!(
                "OneCLI environment grant line {line_number} has malformed double quotes"
            ));
        }
        &encoded[1..encoded.len() - 1]
    } else {
        if encoded.chars().any(char::is_whitespace) {
            return Err(format!(
                "OneCLI environment grant line {line_number} must quote whitespace"
            ));
        }
        encoded
    };
    expand_references(value, prior, line_number)
}

fn expand_references(
    value: &str,
    prior: &BTreeMap<String, String>,
    line_number: usize,
) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut out = String::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'$' {
            out.push(bytes[index] as char);
            index += 1;
            continue;
        }
        let (name, next) = if bytes.get(index + 1) == Some(&b'{') {
            let close = value[index + 2..].find('}').ok_or_else(|| {
                format!("OneCLI environment grant line {line_number} has an unterminated reference")
            })? + index
                + 2;
            (&value[index + 2..close], close + 1)
        } else {
            let start = index + 1;
            let mut end = start;
            while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
                end += 1;
            }
            (&value[start..end], end)
        };
        if name.is_empty() || !ALLOWED_NAMES.contains(&name) {
            return Err(format!(
                "OneCLI environment grant line {line_number} has an unsupported reference"
            ));
        }
        let resolved = prior.get(name).ok_or_else(|| {
            format!("OneCLI environment grant line {line_number} references {name} before it is defined")
        })?;
        if out
            .len()
            .checked_add(resolved.len())
            .is_none_or(|size| size > MAX_VALUE_BYTES)
        {
            return Err(format!(
                "OneCLI environment grant line {line_number} has an oversized value"
            ));
        }
        out.push_str(resolved);
        index = next;
    }
    Ok(out)
}

fn reject_proxy_placeholder(value: &str) -> Result<(), String> {
    let lower = value.to_ascii_lowercase();
    if lower.contains("<agent_token>")
        || lower.contains("placeholder")
        || lower.contains("changeme")
    {
        return Err("Amplifier OneCLI HTTPS proxy still contains an operator placeholder".into());
    }
    Ok(())
}

fn required<'a>(values: &'a BTreeMap<String, String>, name: &str) -> Result<&'a str, String> {
    values
        .get(name)
        .map(String::as_str)
        .ok_or_else(|| format!("Amplifier OneCLI profile requires {name} in keys.env"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oversized_grant_is_rejected_before_decode_even_when_comments_are_valid() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("grant.env");
        let mut raw = "OPENAI_API_KEY=synthetic-only\n#".to_string();
        raw.push_str(&"x".repeat(128 * 1024));
        std::fs::write(&file, raw).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert!(read_environment_grant(&file, EnvironmentProfile::Codex).is_err());
    }
    #[test]
    fn reader_charges_actual_growth_beyond_metadata_size() {
        let reader = std::io::Cursor::new(vec![b'#'; 128 * 1024 + 1]);
        let err = read_bounded(reader, EnvironmentProfile::Codex).unwrap_err();
        assert_eq!(err.operation, GrantOperation::Read);
    }
    #[test]
    fn ordered_interpolation_and_provider_rules_remain_identical() {
        let env=resolve_environment_profile(EnvironmentProfile::Codex,
            "OPENAI_API_KEY='fixture'\nOPENAI_BASE_URL=https://example.invalid\nSSL_CERT_FILE=/runtime/ca\nREQUESTS_CA_BUNDLE=$SSL_CERT_FILE\n").unwrap();
        assert_eq!(env["REQUESTS_CA_BUNDLE"], "/runtime/ca");
        for raw in [
            "ANTHROPIC_API_KEY=fixture",
            "OPENAI_API_KEY=$(synthetic)",
            "OPENAI_API_KEY=one\nOPENAI_API_KEY=two",
            "OPENAI_API_KEY=fixture\nHTTPS_PROXY=http://127.0.0.1:9",
        ] {
            assert!(resolve_environment_profile(EnvironmentProfile::Codex, raw).is_err());
        }
    }
    #[test]
    fn unsupported_name_cannot_echo_private_input() {
        let err = resolve_environment_profile(
            EnvironmentProfile::Codex,
            "sentinel-private-candidate=sentinel-private-value",
        )
        .unwrap_err();
        assert!(!format!("{err:?} {err}").contains("sentinel-private"));
    }
}
