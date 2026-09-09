use freshell_runtime_protocol::{ProviderSecretProfile, TerminalLaunchSpec};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

const MAX_KEYS_BYTES: u64 = 128 * 1024;
const MAX_VALUE_BYTES: usize = 16 * 1024;
const ALLOWED_NAMES: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "CURL_CA_BUNDLE",
    "GLM_RUNPOD_API_KEY",
    "GLM_RUNPOD_BASE_URL",
    "HTTPS_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "NO_PROXY",
    "ONECLI_GATEWAY",
    "ONECLI_URL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "REQUESTS_CA_BUNDLE",
    "SSL_CERT_FILE",
    "https_proxy",
    "no_proxy",
];
const ANTHROPIC_CHILD_NAMES: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "CURL_CA_BUNDLE",
    "HTTPS_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "NO_PROXY",
    "ONECLI_GATEWAY",
    "ONECLI_URL",
    "REQUESTS_CA_BUNDLE",
    "SSL_CERT_FILE",
    "https_proxy",
    "no_proxy",
];

pub fn resolve_child_environment(
    terminal: &TerminalLaunchSpec,
) -> Result<BTreeMap<String, String>, String> {
    if terminal.provider_secret_references.is_empty() {
        return Ok(BTreeMap::new());
    }
    if terminal.mode != "amplifier" || terminal.provider_secret_references.len() != 1 {
        return Err(
            "provider secret references are supported only for one Amplifier OneCLI profile".into(),
        );
    }
    let reference = &terminal.provider_secret_references[0];
    let mount = Path::new("/run/freshell-secrets/provider-0");
    let metadata = fs::symlink_metadata(mount)
        .map_err(|error| format!("Amplifier OneCLI keys reference is unavailable: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_KEYS_BYTES {
        return Err("Amplifier OneCLI keys reference must be a bounded regular file".into());
    }
    let raw = fs::read_to_string(mount)
        .map_err(|error| format!("read Amplifier OneCLI keys reference: {error}"))?;
    resolve_profile(reference.profile, &reference.approved_endpoint, &raw)
}

fn resolve_profile(
    profile: ProviderSecretProfile,
    approved_endpoint: &str,
    raw: &str,
) -> Result<BTreeMap<String, String>, String> {
    let parsed = parse_keys_env(raw)?;
    match profile {
        ProviderSecretProfile::AmplifierOnecliAnthropicHaikuLow => {
            let api_key = required(&parsed, "ANTHROPIC_API_KEY")?;
            reject_placeholder("ANTHROPIC_API_KEY", api_key)?;
            required(&parsed, "ONECLI_GATEWAY")?;
            let endpoint = parsed
                .get("ONECLI_URL")
                .or_else(|| parsed.get("ANTHROPIC_BASE_URL"))
                .map(String::as_str)
                .ok_or_else(|| {
                    "Amplifier OneCLI profile requires ONECLI_URL or ANTHROPIC_BASE_URL in keys.env"
                        .to_string()
                })?;
            if endpoint != approved_endpoint {
                return Err("OneCLI URL does not match the explicitly approved endpoint".into());
            }
            if parsed
                .get("ANTHROPIC_BASE_URL")
                .is_some_and(|value| value != approved_endpoint)
            {
                return Err(
                    "ANTHROPIC_BASE_URL conflicts with the explicitly approved OneCLI endpoint"
                        .into(),
                );
            }
            let mut child = BTreeMap::new();
            for name in ANTHROPIC_CHILD_NAMES {
                if let Some(value) = parsed.get(*name) {
                    child.insert((*name).to_string(), value.clone());
                }
            }
            child.insert("ANTHROPIC_BASE_URL".into(), approved_endpoint.into());
            Ok(child)
        }
    }
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
        let (name, encoded) = line
            .split_once('=')
            .ok_or_else(|| format!("Amplifier keys.env line {line_number} must be NAME=VALUE"))?;
        if !ALLOWED_NAMES.contains(&name) {
            return Err(format!(
                "Amplifier keys.env line {line_number} uses unsupported name {name:?}"
            ));
        }
        if values.contains_key(name) {
            return Err(format!(
                "Amplifier keys.env line {line_number} duplicates {name}"
            ));
        }
        let value = decode_value(encoded, &values, line_number)?;
        if value.is_empty() || value.len() > MAX_VALUE_BYTES {
            return Err(format!(
                "Amplifier keys.env line {line_number} has an empty or oversized value"
            ));
        }
        reject_placeholder(name, &value)?;
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
            "Amplifier keys.env line {line_number} contains unsupported encoding or shell execution syntax"
        ));
    }
    if encoded.starts_with('\'') {
        if encoded.len() < 2 || !encoded.ends_with('\'') {
            return Err(format!(
                "Amplifier keys.env line {line_number} has malformed single quotes"
            ));
        }
        return Ok(encoded[1..encoded.len() - 1].to_string());
    }
    let value = if encoded.starts_with('"') {
        if encoded.len() < 2 || !encoded.ends_with('"') {
            return Err(format!(
                "Amplifier keys.env line {line_number} has malformed double quotes"
            ));
        }
        &encoded[1..encoded.len() - 1]
    } else {
        if encoded.chars().any(char::is_whitespace) {
            return Err(format!(
                "Amplifier keys.env line {line_number} must quote whitespace"
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
                format!("Amplifier keys.env line {line_number} has an unterminated reference")
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
                "Amplifier keys.env line {line_number} has unsupported reference {name:?}"
            ));
        }
        let resolved = prior.get(name).ok_or_else(|| {
            format!("Amplifier keys.env line {line_number} references {name} before it is defined")
        })?;
        out.push_str(resolved);
        index = next;
    }
    Ok(out)
}

fn required<'a>(values: &'a BTreeMap<String, String>, name: &str) -> Result<&'a str, String> {
    values
        .get(name)
        .map(String::as_str)
        .ok_or_else(|| format!("Amplifier OneCLI profile requires {name} in keys.env"))
}

fn reject_placeholder(name: &str, value: &str) -> Result<(), String> {
    let lower = value.to_ascii_lowercase();
    if (value.starts_with('<') && value.ends_with('>'))
        || lower.contains("placeholder")
        || lower.contains("changeme")
    {
        return Err(format!(
            "Amplifier OneCLI value {name} is still a placeholder"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_only_the_selected_profile_environment() {
        let raw = "ONECLI_GATEWAY=enabled\nONECLI_URL=https://onecli.example/v1\nANTHROPIC_API_KEY='test-secret-not-real'\nOPENAI_API_KEY=must-not-leak\nSSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt\nREQUESTS_CA_BUNDLE=$SSL_CERT_FILE\n";
        let child = resolve_profile(
            ProviderSecretProfile::AmplifierOnecliAnthropicHaikuLow,
            "https://onecli.example/v1",
            raw,
        )
        .unwrap();
        assert_eq!(
            child.get("ANTHROPIC_API_KEY").unwrap(),
            "test-secret-not-real"
        );
        assert_eq!(child.get("REQUESTS_CA_BUNDLE"), child.get("SSL_CERT_FILE"));
        assert!(!child.contains_key("OPENAI_API_KEY"));
    }

    #[test]
    fn rejects_shell_syntax_unknown_names_duplicates_and_placeholders() {
        for raw in [
            "ONECLI_GATEWAY=enabled\nONECLI_URL=https://onecli.example/v1\nANTHROPIC_API_KEY=$(cat /secret)\n",
            "ONECLI_GATEWAY=enabled\nONECLI_URL=https://onecli.example/v1\nEVIL=value\nANTHROPIC_API_KEY=key\n",
            "ONECLI_GATEWAY=enabled\nONECLI_URL=https://onecli.example/v1\nANTHROPIC_API_KEY=one\nANTHROPIC_API_KEY=two\n",
            "ONECLI_GATEWAY=enabled\nONECLI_URL=https://onecli.example/v1\nANTHROPIC_API_KEY=<AGENT_TOKEN>\n",
        ] {
            assert!(resolve_profile(
                ProviderSecretProfile::AmplifierOnecliAnthropicHaikuLow,
                "https://onecli.example/v1",
                raw,
            )
            .is_err());
        }
    }

    #[test]
    fn endpoint_mismatch_and_missing_required_values_are_actionable() {
        let mismatch = resolve_profile(
            ProviderSecretProfile::AmplifierOnecliAnthropicHaikuLow,
            "https://approved.example/v1",
            "ONECLI_GATEWAY=enabled\nONECLI_URL=https://different.example/v1\nANTHROPIC_API_KEY=key\n",
        )
        .unwrap_err();
        assert!(mismatch.contains("does not match"));
        let missing = resolve_profile(
            ProviderSecretProfile::AmplifierOnecliAnthropicHaikuLow,
            "https://approved.example/v1",
            "ONECLI_GATEWAY=enabled\nONECLI_URL=https://approved.example/v1\n",
        )
        .unwrap_err();
        assert!(missing.contains("ANTHROPIC_API_KEY"));
    }

    #[test]
    fn serialised_launch_contains_references_but_never_resolved_secret_bytes() {
        let reference = freshell_runtime_protocol::ProviderSecretReference {
            source_path: "/private/keys.env".into(),
            profile: ProviderSecretProfile::AmplifierOnecliAnthropicHaikuLow,
            approved_endpoint: "https://onecli.example/v1".into(),
        };
        let json = serde_json::to_string(&reference).unwrap();
        assert!(json.contains("/private/keys.env"));
        assert!(!json.contains("test-secret-not-real"));
    }
}
