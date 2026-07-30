//! SYNC-06: the resume-resolve claude fallback needs the transcript's
//! original cwd (`claude-transcript-locator.ts` parity: first line carrying a
//! non-empty string `cwd`, malformed lines skipped). This pins the crate-root
//! export and the first-non-empty-cwd semantics.

use std::io::Write;

fn temp_transcript(lines: &[&str]) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "freshell-transcript-cwd-{}-{}.jsonl",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut file = std::fs::File::create(&path).expect("create fixture transcript");
    for line in lines {
        writeln!(file, "{line}").expect("write fixture line");
    }
    path
}

#[test]
fn first_non_empty_cwd_wins_and_malformed_lines_are_skipped() {
    let path = temp_transcript(&[
        "not json at all {",
        r#"{"type":"summary","cwd":""}"#,
        r#"{"type":"user","cwd":"/repo/gamma","message":{}}"#,
        r#"{"type":"assistant","cwd":"/repo/other"}"#,
    ]);
    assert_eq!(
        freshell_freshagent::transcript_cwd(&path),
        Some("/repo/gamma".to_string())
    );
}

#[test]
fn transcript_without_cwd_yields_none() {
    let path = temp_transcript(&[r#"{"type":"summary"}"#, r#"{"leafUuid":"x"}"#]);
    assert_eq!(freshell_freshagent::transcript_cwd(&path), None);
}
