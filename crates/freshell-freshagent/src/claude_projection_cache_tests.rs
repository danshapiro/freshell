//! The incremental transcript projection (C4) over REAL pinned-CLI
//! transcripts (`test/fixtures/fresh-agent/claude/real-cli-2.1.237/`): every
//! read equals a full parse of the file as it stands, and appends are parsed
//! incrementally.

use std::io::Write as _;

use serde_json::{json, Value};

use super::*;
use crate::claude_projection::{FsSubagents, NoSubagents};
use crate::claude_snapshot::real_cli_tests::{all_items, real_cli_fixture};

const THREAD: &str = "s";

/// A projection as one comparable value.
fn summary(projection: ClaudeProjection) -> Value {
    json!({
        "turns": projection.turns,
        "diffs": projection.diffs,
        "tokenUsage": projection.token_usage,
        "transcriptLineUuids": projection.transcript_line_uuids,
    })
}

/// A full parse of `content`, the way the snapshot projected before the cache.
fn full_parse(content: &str, subagents: &dyn SubagentSource) -> Value {
    summary(ClaudeTranscriptProjector::project_with(
        THREAD, content, subagents,
    ))
}

fn read(cache: &ProjectionCache, path: &Path) -> (Value, ReadOutcome) {
    let read = cache
        .read(path, THREAD, &NoSubagents)
        .expect("the transcript reads");
    (summary(read.projection), read.outcome)
}

fn append(path: &Path, bytes: &str) {
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("open the transcript")
        .write_all(bytes.as_bytes())
        .expect("append to the transcript");
}

#[test]
fn invalid_utf8_without_any_native_record_is_unreadable_but_a_torn_tail_keeps_valid_history() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("t.jsonl");
    let cache = ProjectionCache::new(4);
    for bytes in [vec![0xff], vec![b' ', b'\n', 0xff]] {
        std::fs::write(&path, bytes).unwrap();
        let error = match cache.read(&path, THREAD, &NoSubagents) {
            Ok(_) => panic!("an unreadable transcript must not look like an empty conversation"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }

    // A native session may exist before it has any messages. Empty and valid
    // metadata-only transcripts remain valid empty histories.
    for content in ["", "{\"type\":\"system\",\"sessionId\":\"s\"}\n"] {
        std::fs::write(&path, content).unwrap();
        let (projection, _) = read(&cache, &path);
        assert_eq!(projection, full_parse(content, &NoSubagents));
    }

    let prefix = real_cli_fixture!("tools-sync");
    let mut bytes = prefix.as_bytes().to_vec();
    bytes.push(0xff);
    std::fs::write(&path, &bytes).unwrap();
    let (projection, _) = read(&cache, &path);
    assert_eq!(projection, full_parse(prefix, &NoSubagents));
    // The same partial UTF-8 write is also harmless on a cached read.
    let (projection, outcome) = read(&cache, &path);
    assert_eq!(projection, full_parse(prefix, &NoSubagents));
    assert_eq!(outcome, ReadOutcome::Unchanged);
}

/// Every split point: each line boundary and the middle of each line.
fn split_points(content: &str) -> Vec<usize> {
    let mut points = Vec::new();
    let mut start = 0;
    for (index, byte) in content.bytes().enumerate() {
        if byte == b'\n' {
            let mut middle = start + (index - start) / 2;
            while !content.is_char_boundary(middle) {
                middle -= 1;
            }
            points.push(middle);
            points.push(index + 1);
            start = index + 1;
        }
    }
    points
}

#[test]
fn a_transcript_read_as_it_grows_projects_like_a_full_parse_and_parses_only_what_was_appended() {
    for content in [
        real_cli_fixture!("tools-sync"),
        real_cli_fixture!("agent-async"),
        real_cli_fixture!("compact-ok"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let cache = ProjectionCache::new(4);
        let mut written = 0;
        let mut consumed = 0;
        for (step, point) in split_points(content).into_iter().enumerate() {
            append(&path, &content[written..point]);
            written = point;
            let (projection, outcome) = read(&cache, &path);
            assert_eq!(
                projection,
                full_parse(&content[..point], &NoSubagents),
                "after {point} bytes"
            );
            let complete = content[..point].rfind('\n').map_or(0, |at| at + 1);
            let expected = if step == 0 {
                ReadOutcome::Full {
                    reason: FullReason::Uncached,
                    bytes: complete as u64,
                }
            } else if complete == consumed {
                ReadOutcome::Unchanged
            } else {
                ReadOutcome::Appended {
                    bytes: (complete - consumed) as u64,
                }
            };
            assert_eq!(outcome, expected, "after {point} bytes");
            consumed = complete;
        }
    }
}

#[test]
fn an_unterminated_last_line_is_never_consumed_until_its_newline_lands() {
    let content = real_cli_fixture!("tools-sync");
    let lines: Vec<&str> = content.lines().collect();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.jsonl");
    let cache = ProjectionCache::new(4);

    // A complete JSON line still missing its newline counts for this read...
    let head = format!("{}\n{}", lines[..7].join("\n"), lines[7]);
    append(&path, &head);
    let (projection, _) = read(&cache, &path);
    assert_eq!(projection, full_parse(&head, &NoSubagents));
    // ...but is not consumed: once its newline and the next line land, the
    // read parses it with them, exactly once.
    let more = format!("\n{}\n", lines[8]);
    append(&path, &more);
    let (projection, outcome) = read(&cache, &path);
    let so_far = format!("{head}{more}");
    assert_eq!(projection, full_parse(&so_far, &NoSubagents));
    assert_eq!(
        outcome,
        ReadOutcome::Appended {
            bytes: (lines[7].len() + more.len()) as u64,
        }
    );

    // A torn line (a write in progress) is invisible until complete.
    let torn = &lines[9][..lines[9].len() / 2];
    append(&path, torn);
    let (projection, outcome) = read(&cache, &path);
    assert_eq!(projection, full_parse(&so_far, &NoSubagents));
    assert_eq!(outcome, ReadOutcome::Unchanged);
    let rest = format!("{}\n", &lines[9][lines[9].len() / 2..]);
    append(&path, &rest);
    let (projection, outcome) = read(&cache, &path);
    assert_eq!(
        projection,
        full_parse(&format!("{so_far}{torn}{rest}"), &NoSubagents)
    );
    assert_eq!(
        outcome,
        ReadOutcome::Appended {
            bytes: (lines[9].len() + 1) as u64,
        }
    );
}

#[test]
fn a_rewritten_or_shrunk_transcript_is_parsed_in_full() {
    let content = real_cli_fixture!("tools-sync");
    let lines: Vec<&str> = content.lines().collect();
    let joined = |lines: &[&str]| {
        lines
            .iter()
            .map(|line| format!("{line}\n"))
            .collect::<String>()
    };
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.jsonl");
    let cache = ProjectionCache::new(4);
    std::fs::write(&path, joined(&lines[..20])).unwrap();
    read(&cache, &path);

    // Rewritten in place: the last consumed line changed and the file grew,
    // so the new bytes alone would leave the old line in the projection.
    let mut rewritten: Vec<&str> = lines[..19].to_vec();
    rewritten.push(lines[21]);
    rewritten.push(lines[22]);
    rewritten.push(lines[23]);
    let rewritten = joined(&rewritten);
    std::fs::write(&path, &rewritten).unwrap();
    let (projection, outcome) = read(&cache, &path);
    assert_eq!(projection, full_parse(&rewritten, &NoSubagents));
    assert!(
        matches!(
            outcome,
            ReadOutcome::Full {
                reason: FullReason::Rewritten,
                ..
            }
        ),
        "{outcome:?}"
    );

    // Shrunk (a rollback truncation, say).
    let shrunk = joined(&lines[..5]);
    std::fs::write(&path, &shrunk).unwrap();
    let (projection, outcome) = read(&cache, &path);
    assert_eq!(projection, full_parse(&shrunk, &NoSubagents));
    assert!(
        matches!(
            outcome,
            ReadOutcome::Full {
                reason: FullReason::Shrunk,
                ..
            }
        ),
        "{outcome:?}"
    );
}

/// Another file renamed over the path is a different transcript, even when
/// it starts with the same bytes.
#[cfg(unix)]
#[test]
fn a_transcript_replaced_by_another_file_is_parsed_in_full() {
    let content = real_cli_fixture!("tools-sync");
    let lines: Vec<&str> = content.lines().collect();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.jsonl");
    let cache = ProjectionCache::new(4);
    std::fs::write(&path, format!("{}\n", lines[..10].join("\n"))).unwrap();
    read(&cache, &path);

    let replacement = dir.path().join("next.jsonl");
    std::fs::write(&replacement, content).unwrap();
    std::fs::rename(&replacement, &path).unwrap();
    let (projection, outcome) = read(&cache, &path);
    assert_eq!(projection, full_parse(content, &NoSubagents));
    assert!(
        matches!(
            outcome,
            ReadOutcome::Full {
                reason: FullReason::Replaced,
                ..
            }
        ),
        "{outcome:?}"
    );
}

/// The main transcript is unchanged while the subagent works: its file grows,
/// and the delegation's activity follows.
#[test]
fn a_growing_subagent_transcript_is_reflected_while_the_main_one_is_unchanged() {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/fresh-agent/claude/real-cli-2.1.237/tools-sync");
    let main = real_cli_fixture!("tools-sync");
    let main_lines: Vec<&str> = main.lines().collect();
    // Up to the Agent call (the delegation is running).
    let agent_call = main_lines
        .iter()
        .position(|line| line.contains("\"name\":\"Agent\""))
        .expect("the Agent call");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.jsonl");
    std::fs::write(&path, format!("{}\n", main_lines[..=agent_call].join("\n"))).unwrap();
    let subagents_dir = dir.path().join("t").join("subagents");
    std::fs::create_dir_all(&subagents_dir).unwrap();
    let recorded = fixture.join("session").join("subagents");
    let agent = "agent-a2645ac0e225b257e";
    std::fs::copy(
        recorded.join(format!("{agent}.meta.json")),
        subagents_dir.join(format!("{agent}.meta.json")),
    )
    .unwrap();
    let subagent = std::fs::read_to_string(recorded.join(format!("{agent}.jsonl"))).unwrap();
    let subagent_lines: Vec<&str> = subagent.lines().collect();
    let read_call = subagent_lines
        .iter()
        .position(|line| line.contains("\"type\":\"tool_use\""))
        .expect("the subagent's Read call");
    let subagent_path = subagents_dir.join(format!("{agent}.jsonl"));
    std::fs::write(
        &subagent_path,
        format!("{}\n", subagent_lines[..=read_call].join("\n")),
    )
    .unwrap();

    let cache = ProjectionCache::new(4);
    let activity = |cache: &ProjectionCache| {
        let read = cache
            .read(&path, THREAD, &FsSubagents::for_transcript(&path))
            .expect("the transcript reads");
        let delegation = all_items(&read.projection.turns)
            .into_iter()
            .find(|item| item["kind"] == "task_delegation")
            .cloned()
            .expect("the delegation");
        (delegation["activity"].clone(), read.outcome)
    };
    let (running, _) = activity(&cache);
    assert_eq!(running[0]["status"], "running", "{running}");

    append(
        &subagent_path,
        &format!("{}\n", subagent_lines[read_call + 1..].join("\n")),
    );
    let (completed, outcome) = activity(&cache);
    assert_eq!(outcome, ReadOutcome::Unchanged);
    assert_eq!(completed[0]["status"], "completed", "{completed}");
}

/// Reads of more transcripts than the capacity drop the least recently used
/// projector (its next read is a full one again), not the busy ones.
#[test]
fn past_its_capacity_the_cache_drops_the_least_recently_read_transcript() {
    let content = real_cli_fixture!("tools-sync");
    let dir = tempfile::tempdir().unwrap();
    let paths: Vec<PathBuf> = (0..3)
        .map(|n| {
            let path = dir.path().join(format!("t{n}.jsonl"));
            std::fs::write(&path, content).unwrap();
            path
        })
        .collect();
    let cache = ProjectionCache::new(2);
    read(&cache, &paths[0]);
    read(&cache, &paths[1]);
    assert_eq!(read(&cache, &paths[0]).1, ReadOutcome::Unchanged);
    read(&cache, &paths[2]);
    assert_eq!(read(&cache, &paths[0]).1, ReadOutcome::Unchanged);
    assert!(matches!(
        read(&cache, &paths[1]).1,
        ReadOutcome::Full {
            reason: FullReason::Uncached,
            ..
        }
    ));
}
