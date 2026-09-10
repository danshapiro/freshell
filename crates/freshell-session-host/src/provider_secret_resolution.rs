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
    "LUNAROUTE_API_KEY",
    "LUNAROUTE_BASE_URL",
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
const CERTIFICATE_CHILD_NAMES: &[&str] = &[
    "CURL_CA_BUNDLE",
    "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
    "SSL_CERT_FILE",
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
    resolve_profile(reference.profile, &raw)
}

fn resolve_profile(
    profile: ProviderSecretProfile,
    raw: &str,
) -> Result<BTreeMap<String, String>, String> {
    let parsed = parse_keys_env(raw)?;
    match profile {
        ProviderSecretProfile::AmplifierOnecliLunarouteGlm53 => {
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
        ProviderSecretProfile::LegacyAmplifierOnecliAnthropicHaikuLow => Err(
            "legacy Amplifier Anthropic/Haiku secret profile is no longer supported; recreate the managed runtime with the approved OneCLI/LunaRoute profile".into(),
        ),
    }
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
        .map_err(|_| "HTTPS_PROXY must be a valid HTTP(S) URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("HTTPS_PROXY must be a valid HTTP(S) URL".into());
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if host == "localhost" || host == "::1" || host.starts_with("127.") {
        return Err(
            "HTTPS_PROXY cannot use container loopback; use the approved OneCLI proxy address reachable from the managed bridge"
                .into(),
        );
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("HTTPS_PROXY cannot contain query or fragment data".into());
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
    fn resolves_actual_onecli_lunaroute_profile_to_vllm_child_environment() {
        let raw = "ONECLI_GATEWAY=1\nONECLI_URL=http://127.0.0.1:10254\nLUNAROUTE_API_KEY='proxy-managed-placeholder'\nLUNAROUTE_BASE_URL=https://lunaroute.example/v1\nHTTPS_PROXY=http://user:credential@192.0.2.10:10255\nNO_PROXY=localhost,127.0.0.1\nSSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt\nREQUESTS_CA_BUNDLE=$SSL_CERT_FILE\n";
        let child =
            resolve_profile(ProviderSecretProfile::AmplifierOnecliLunarouteGlm53, raw).unwrap();
        assert_eq!(
            child.get("VLLM_API_KEY").unwrap(),
            "proxy-managed-placeholder"
        );
        assert_eq!(
            child.get("VLLM_BASE_URL").unwrap(),
            "https://lunaroute.example/v1"
        );
        assert_eq!(
            child.get("HTTPS_PROXY").unwrap(),
            "http://user:credential@192.0.2.10:10255"
        );
        assert_eq!(child.get("REQUESTS_CA_BUNDLE"), child.get("SSL_CERT_FILE"));
        assert_eq!(child.get("HTTPS_PROXY"), child.get("https_proxy"));
        assert!(!child.contains_key("LUNAROUTE_API_KEY"));
        assert!(!child.contains_key("ONECLI_URL"));
        assert!(!child.contains_key("NO_PROXY"));
        assert!(!child.contains_key("no_proxy"));
        assert!(!child.contains_key("ANTHROPIC_API_KEY"));
    }

    #[test]
    fn onecli_profile_rejects_shell_syntax_unknown_names_duplicates_and_unreachable_proxy() {
        for raw in [
            "ONECLI_GATEWAY=1\nLUNAROUTE_API_KEY=$(cat /secret)\nLUNAROUTE_BASE_URL=https://lunaroute.example/v1\nHTTPS_PROXY=http://user:credential@192.0.2.10:10255\n",
            "ONECLI_GATEWAY=1\nEVIL=value\nLUNAROUTE_API_KEY=key\nLUNAROUTE_BASE_URL=https://lunaroute.example/v1\nHTTPS_PROXY=http://user:credential@192.0.2.10:10255\n",
            "ONECLI_GATEWAY=1\nLUNAROUTE_API_KEY=one\nLUNAROUTE_API_KEY=two\nLUNAROUTE_BASE_URL=https://lunaroute.example/v1\nHTTPS_PROXY=http://user:credential@192.0.2.10:10255\n",
            "ONECLI_GATEWAY=1\nLUNAROUTE_API_KEY=key\nLUNAROUTE_BASE_URL=https://lunaroute.example/v1\nHTTPS_PROXY=http://user:credential@127.0.0.1:10255\n",
            "ONECLI_GATEWAY=1\nLUNAROUTE_API_KEY=proxy-managed-placeholder\nLUNAROUTE_BASE_URL=https://lunaroute.example/v1\nHTTPS_PROXY=http://<AGENT_TOKEN>@192.0.2.10:10255\n",
            "ONECLI_GATEWAY=1\nLUNAROUTE_API_KEY=key\nLUNAROUTE_BASE_URL=https://lunaroute.example/v1\nHTTPS_PROXY=http://user:one@192.0.2.10:10255\nhttps_proxy=http://user:two@192.0.2.10:10255\n",
        ] {
            assert!(resolve_profile(
                ProviderSecretProfile::AmplifierOnecliLunarouteGlm53,
                raw,
            )
            .is_err());
        }
    }

    #[test]
    fn onecli_profile_rejects_credentialed_or_non_https_upstream_and_missing_proxy() {
        for raw in [
            "ONECLI_GATEWAY=1\nLUNAROUTE_API_KEY=key\nLUNAROUTE_BASE_URL=https://user:secret@lunaroute.example/v1\nHTTPS_PROXY=http://user:credential@192.0.2.10:10255\n",
            "ONECLI_GATEWAY=1\nLUNAROUTE_API_KEY=key\nLUNAROUTE_BASE_URL=http://lunaroute.example/v1\nHTTPS_PROXY=http://user:credential@192.0.2.10:10255\n",
            "ONECLI_GATEWAY=1\nLUNAROUTE_API_KEY=key\nLUNAROUTE_BASE_URL=https://lunaroute.example/v1\n",
        ] {
            assert!(resolve_profile(
                ProviderSecretProfile::AmplifierOnecliLunarouteGlm53,
                raw,
            )
            .is_err());
        }
    }

    #[test]
    fn legacy_anthropic_profile_is_readable_but_fails_closed() {
        let error = resolve_profile(
            ProviderSecretProfile::LegacyAmplifierOnecliAnthropicHaikuLow,
            "ANTHROPIC_API_KEY=obsolete\n",
        )
        .unwrap_err();
        assert!(error.contains("no longer supported"));
    }

    #[test]
    fn serialised_launch_contains_references_but_never_resolved_secret_bytes() {
        let reference = freshell_runtime_protocol::ProviderSecretReference {
            source_path: "/private/keys.env".into(),
            profile: ProviderSecretProfile::AmplifierOnecliLunarouteGlm53,
        };
        let json = serde_json::to_string(&reference).unwrap();
        assert!(json.contains("/private/keys.env"));
        assert!(!json.contains("test-secret-not-real"));
    }
}
