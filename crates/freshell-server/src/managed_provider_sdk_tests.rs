//! Genuine default SDK startup qualification in the closed provider sandbox.
use sha2::{Digest, Sha256};

#[test]
fn managed_provider_claude_default_sdk_initializes_fixed_mcp_without_a_prompt() {
    let root = std::env::var_os("FRESHELL_TEST_EXECUTABLE_TMP_DIR")
        .expect("native SDK qualification requires its owned executable sandbox");
    let fixture = tempfile::Builder::new()
        .prefix("claude-sdk-")
        .tempdir_in(root)
        .unwrap();
    for (name, source) in [
        (
            "hosted-mcp.mjs",
            include_str!("../../freshell-claude-sidecar/hosted-mcp.mjs"),
        ),
        (
            "exec-profile.mjs",
            include_str!("../../freshell-claude-sidecar/exec-profile.mjs"),
        ),
        ("probe.mjs", include_str!("managed_provider_sdk_probe.mjs")),
    ] {
        std::fs::write(fixture.path().join(name), source).unwrap();
    }
    let output = std::process::Command::new("node")
        .arg(fixture.path().join("probe.mjs"))
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("HOME", "/home/freshell/provider")
        .env("FRESHELL_HOSTED_FRESH_AGENT", "claude")
        .current_dir(fixture.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "native SDK failed its classified model-free startup: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    let receipt: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["sdkVersion"], "0.3.237");
    assert_eq!(receipt["nativeVersion"], "2.1.237");
    for field in [
        "defaultChild",
        "connected",
        "fixedRecipe",
        "scopedEnvironment",
        "zeroPrompts",
        "nativeExit",
        "mcpExit",
    ] {
        assert_eq!(receipt[field], true, "genuine SDK startup receipt {field}");
    }
    println!(
        "provider_source_consumer {}",
        serde_json::json!({
            "provider":"claude", "case":"default-sdk-fixed-mcp",
            "digest":format!("{:x}",Sha256::digest(serde_json::to_vec(&receipt).unwrap())),
        })
    );
}
