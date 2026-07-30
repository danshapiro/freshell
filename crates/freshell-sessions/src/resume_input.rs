//! Rust port of `shared/resume-input-parser.ts` — a pure, dependency-free
//! parser that extracts candidate session ids and an advisory provider hint
//! from arbitrary pasted text. Hints only assist the UI — session-store
//! evidence decides the provider.
//!
//! PARITY-PINNED: both this port and the TS original are driven by the shared
//! fixture `test/fixtures/resume-input/parser-cases.json`
//! (`tests/resume_input_parser_parity.rs` here,
//! `test/unit/shared/resume-input-parser.test.ts` there). Behavior changes go
//! through the fixture first.
//!
//! Port notes (things that look odd but are load-bearing):
//! - `(?-u:\b)` everywhere a JS `\b` appears: JS word boundaries are ASCII
//!   (`[A-Za-z0-9_]`); Rust's default `\b` is Unicode-aware and would diverge
//!   on inputs like `é417e8345`.
//! - The ANSI CSI strip replaces each escape with ONE space (length-changing);
//!   hint derivation reads that `sanitized` text, so earliest-match indices
//!   shift with it. Do not "fix" this to a length-preserving mask.
//! - Extraction masks each match with `' '.repeat(len)` (length-preserving)
//!   so UUID hex groups never re-match as hex prefixes. All matched chars are
//!   ASCII, so byte length == char length.
//! - Hex tokens sort by length DESC with a STABLE sort (JS `Array.sort` is
//!   stable): equal-length tokens keep extraction (text) order.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ResumeCandidateKind {
    #[serde(rename = "prefixed-id")]
    PrefixedId,
    #[serde(rename = "uuid")]
    Uuid,
    #[serde(rename = "hex-prefix")]
    HexPrefix,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ResumeCandidate {
    pub token: String,
    pub kind: ResumeCandidateKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResumeHintProvider {
    Claude,
    Codex,
    Opencode,
    Amplifier,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum ResumeHintSource {
    #[serde(rename = "command")]
    Command,
    #[serde(rename = "word")]
    Word,
    #[serde(rename = "id-shape")]
    IdShape,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ResumeHint {
    pub provider: ResumeHintProvider,
    pub source: ResumeHintSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumeInputParse {
    /// Candidate tokens in resolution-priority order, capped at
    /// [`MAX_RESUME_CANDIDATES`].
    pub candidates: Vec<ResumeCandidate>,
    pub hint: Option<ResumeHint>,
}

/// Work budget: candidates are capped so one pasted blob can never trigger
/// unbounded server-side scans/DB lookups in the resolve endpoint.
/// (`MAX_RESUME_CANDIDATES`, `shared/resume-input-parser.ts`.)
pub const MAX_RESUME_CANDIDATES: usize = 8;

static ANSI_ESCAPE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[0-9A-Za-z]").expect("static regex"));
static UUID_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
        .expect("static regex")
});
// Known xxx_-prefixed id families only (ses_ + 26 base62 is opencode's,
// first-class). Arbitrary snake_case identifiers must NOT match: they would
// rank FIRST and waste resolver passes on non-ids.
static PREFIXED_ID_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?-u:\b)(?:ses|sess|session|thread|thr|run|msg|task|amp)_[0-9A-Za-z]{8,64}(?-u:\b)",
    )
    .expect("static regex")
});
// >=8 hex chars, <=32; must contain a digit (filters decade/facade/deadbeef).
static HEX_PREFIX_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)[0-9a-fA-F]{8,32}(?-u:\b)").expect("static regex"));

static COMMAND_HINTS: LazyLock<Vec<(Regex, ResumeHintProvider)>> = LazyLock::new(|| {
    vec![
        (
            Regex::new(r"(?i)(?-u:\b)claude\s+(?:--resume|-r)(?-u:\b)").expect("static regex"),
            ResumeHintProvider::Claude,
        ),
        (
            Regex::new(r"(?i)(?-u:\b)codex\s+resume(?-u:\b)").expect("static regex"),
            ResumeHintProvider::Codex,
        ),
        (
            Regex::new(r"(?i)(?-u:\b)opencode\s+--session(?-u:\b)").expect("static regex"),
            ResumeHintProvider::Opencode,
        ),
        (
            Regex::new(r"(?i)(?-u:\b)amplifier\s+(?:--resume|resume)(?-u:\b)")
                .expect("static regex"),
            ResumeHintProvider::Amplifier,
        ),
    ]
});

static WORD_HINTS: LazyLock<Vec<(Regex, ResumeHintProvider)>> = LazyLock::new(|| {
    vec![
        (
            Regex::new(r"(?i)(?-u:\b)claude(?-u:\b)").expect("static regex"),
            ResumeHintProvider::Claude,
        ),
        (
            Regex::new(r"(?i)(?-u:\b)codex(?-u:\b)").expect("static regex"),
            ResumeHintProvider::Codex,
        ),
        (
            Regex::new(r"(?i)(?-u:\b)opencode(?-u:\b)").expect("static regex"),
            ResumeHintProvider::Opencode,
        ),
        (
            Regex::new(r"(?i)(?-u:\b)amplifier(?-u:\b)").expect("static regex"),
            ResumeHintProvider::Amplifier,
        ),
    ]
});

/// `extractAndMask`: push every match, replace it with a same-length run of
/// spaces so later passes cannot re-match inside it.
fn extract_and_mask(text: &str, re: &Regex, out: &mut Vec<String>) -> String {
    re.replace_all(text, |caps: &regex::Captures<'_>| {
        let m = caps.get(0).expect("group 0 always present").as_str();
        out.push(m.to_string());
        " ".repeat(m.len())
    })
    .into_owned()
}

/// `earliestHint`: run every regex, keep the provider with the smallest match
/// start. Ties break by table order (strict `<`, first entry wins) — same as
/// the TS original. Byte offsets vs UTF-16 offsets order matches identically
/// (the mapping is monotonic).
fn earliest_hint(text: &str, table: &[(Regex, ResumeHintProvider)]) -> Option<ResumeHintProvider> {
    let mut best: Option<ResumeHintProvider> = None;
    let mut best_index = usize::MAX;
    for (re, provider) in table {
        if let Some(m) = re.find(text) {
            if m.start() < best_index {
                best_index = m.start();
                best = Some(*provider);
            }
        }
    }
    best
}

fn derive_hint(text: &str, candidates: &[ResumeCandidate]) -> Option<ResumeHint> {
    if let Some(provider) = earliest_hint(text, &COMMAND_HINTS) {
        return Some(ResumeHint {
            provider,
            source: ResumeHintSource::Command,
        });
    }
    if let Some(provider) = earliest_hint(text, &WORD_HINTS) {
        return Some(ResumeHint {
            provider,
            source: ResumeHintSource::Word,
        });
    }
    let top = candidates.first()?;
    match top.kind {
        ResumeCandidateKind::PrefixedId => {
            if top.token.starts_with("ses_") {
                Some(ResumeHint {
                    provider: ResumeHintProvider::Opencode,
                    source: ResumeHintSource::IdShape,
                })
            } else {
                None
            }
        }
        // charAt(14) is the uuid version nibble (0-based). Real-store caveat:
        // amplifier TOP-LEVEL session ids are also UUIDv4, so v4 => claude is
        // a heuristic, not an invariant — acceptable because hints are
        // advisory only.
        ResumeCandidateKind::Uuid => match top.token.as_bytes().get(14) {
            Some(b'7') => Some(ResumeHint {
                provider: ResumeHintProvider::Codex,
                source: ResumeHintSource::IdShape,
            }),
            Some(b'4') => Some(ResumeHint {
                provider: ResumeHintProvider::Claude,
                source: ResumeHintSource::IdShape,
            }),
            _ => None,
        },
        ResumeCandidateKind::HexPrefix => Some(ResumeHint {
            provider: ResumeHintProvider::Amplifier,
            source: ResumeHintSource::IdShape,
        }),
    }
}

fn push_candidate(
    token: &str,
    kind: ResumeCandidateKind,
    seen: &mut HashSet<String>,
    out: &mut Vec<ResumeCandidate>,
) {
    // Dedup key: prefixed ids verbatim (case-sensitive); uuid/hex lowercased.
    // All token classes are ASCII by construction, so to_ascii_lowercase()
    // is equivalent to JS toLowerCase() here.
    let key = match kind {
        ResumeCandidateKind::PrefixedId => token.to_string(),
        _ => token.to_ascii_lowercase(),
    };
    if !seen.insert(key) {
        return;
    }
    out.push(ResumeCandidate {
        token: token.to_string(),
        kind,
    });
}

pub fn parse_resume_input(text: &str) -> ResumeInputParse {
    // Each CSI escape collapses to ONE space (length-changing, matches TS).
    let sanitized = ANSI_ESCAPE_RE.replace_all(text, " ").into_owned();

    let mut uuids: Vec<String> = Vec::new();
    let mut prefixed: Vec<String> = Vec::new();
    let mut raw_hex: Vec<String> = Vec::new();

    // Mask each class as it is extracted so uuid segments never re-match as hex.
    let masked = extract_and_mask(&sanitized, &UUID_RE, &mut uuids);
    let masked = extract_and_mask(&masked, &PREFIXED_ID_RE, &mut prefixed);
    extract_and_mask(&masked, &HEX_PREFIX_RE, &mut raw_hex);

    let mut hex_tokens: Vec<String> = raw_hex
        .into_iter()
        .filter(|token| token.bytes().any(|b| b.is_ascii_digit()))
        .collect();
    // STABLE sort (like JS Array.sort): equal lengths keep text order.
    // NOTE: sort_by_key(Reverse(len)) — not sort_by(|a, b| b.len().cmp(&a.len())),
    // which trips clippy's warn-by-default `unnecessary_sort_by` under the
    // -D warnings gate. Vec::sort_by_key is equally stable; behavior identical.
    hex_tokens.sort_by_key(|t| std::cmp::Reverse(t.len()));

    let mut seen: HashSet<String> = HashSet::new();
    let mut candidates: Vec<ResumeCandidate> = Vec::new();
    for token in &prefixed {
        push_candidate(
            token,
            ResumeCandidateKind::PrefixedId,
            &mut seen,
            &mut candidates,
        );
    }
    for token in &uuids {
        push_candidate(token, ResumeCandidateKind::Uuid, &mut seen, &mut candidates);
    }
    for token in &hex_tokens {
        push_candidate(
            token,
            ResumeCandidateKind::HexPrefix,
            &mut seen,
            &mut candidates,
        );
    }

    // Cap = work budget: bounds resolver scans + exact-id fallback lookups per
    // request. The hint reads the CAPPED list (mirrors the TS call shape).
    candidates.truncate(MAX_RESUME_CANDIDATES);
    let hint = derive_hint(&sanitized, &candidates);
    ResumeInputParse { candidates, hint }
}
