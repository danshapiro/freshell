//! Streaming UTF-8 decoder — the `portable-pty` analogue of node-pty's role.
//!
//! ## Why this exists (spec `terminal-core.md §9.1`, top risk #1)
//!
//! node-pty's `onData` delivers **JS strings** (it decodes PTY bytes to UTF-16 with
//! its own internal `StringDecoder`, buffering incomplete multi-byte sequences across
//! read boundaries). `portable-pty` yields raw `Vec<u8>`. To feed the framing layer
//! the same *string content* the reference frames, we decode the raw byte stream to
//! UTF-8 the same way: emit the maximal valid prefix on each read and hold back an
//! incomplete trailing sequence until the bytes that complete it arrive.
//!
//! The *chunk boundaries* this produces need not match node-pty's — they are
//! timing-dependent on both sides. What must hold (and does) is that the **total
//! concatenated decoded bytes are identical** to the PTY's byte stream, so the
//! seq-ordered reassembly of `terminal.output` frames is byte-exact (the T1 thesis).
//!
//! Genuinely invalid bytes (never present in the ASCII T1 goldens) are replaced with
//! U+FFFD, matching a lossy `StringDecoder`.

/// A resumable UTF-8 decoder that never splits a multi-byte scalar across `push`es.
#[derive(Debug, Default)]
pub struct Utf8StreamDecoder {
    /// Bytes read but not yet forming a complete scalar (a partial tail).
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    pub fn new() -> Self {
        Self { pending: Vec::new() }
    }

    /// Feed the next raw read; returns the decoded text now available. An incomplete
    /// trailing sequence is retained internally and completed by a later `push`.
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();

        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(valid) => {
                    out.push_str(valid);
                    self.pending.clear();
                    break;
                }
                Err(err) => {
                    let valid_up_to = err.valid_up_to();
                    if valid_up_to > 0 {
                        // SAFETY: `valid_up_to` bytes are guaranteed valid UTF-8.
                        out.push_str(
                            std::str::from_utf8(&self.pending[..valid_up_to])
                                .expect("valid_up_to prefix is valid UTF-8"),
                        );
                    }
                    match err.error_len() {
                        // Incomplete trailing sequence: keep it for the next push.
                        None => {
                            self.pending.drain(..valid_up_to);
                            break;
                        }
                        // Genuine invalid bytes: emit one replacement, skip, continue.
                        Some(bad_len) => {
                            out.push('\u{FFFD}');
                            self.pending.drain(..valid_up_to + bad_len);
                        }
                    }
                }
            }
        }

        out
    }

    /// Flush any residual bytes at stream end (lossy — a dangling partial sequence
    /// becomes U+FFFD). Returns "" when nothing is pending.
    pub fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            return String::new();
        }
        let out = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_is_pass_through_with_no_pending() {
        let mut d = Utf8StreamDecoder::new();
        assert_eq!(d.push(b"hello\r\n"), "hello\r\n");
        assert_eq!(d.finish(), "");
    }

    #[test]
    fn two_byte_scalar_split_across_pushes() {
        // "é" = 0xC3 0xA9. First push has only the lead byte.
        let mut d = Utf8StreamDecoder::new();
        assert_eq!(d.push(&[0xC3]), "", "incomplete lead byte held back");
        assert_eq!(d.push(&[0xA9]), "é", "completed on the next push");
        assert_eq!(d.finish(), "");
    }

    #[test]
    fn four_byte_emoji_split_every_which_way() {
        // "😀" = F0 9F 98 80, delivered one byte at a time.
        let bytes = "😀".as_bytes().to_vec();
        let mut d = Utf8StreamDecoder::new();
        let mut out = String::new();
        for b in &bytes {
            out.push_str(&d.push(&[*b]));
        }
        out.push_str(&d.finish());
        assert_eq!(out, "😀");
    }

    #[test]
    fn arbitrary_byte_splits_reassemble_to_the_original() {
        let text = "aéb😀c\r\n漢字";
        let bytes = text.as_bytes();
        for split in 0..=bytes.len() {
            let mut d = Utf8StreamDecoder::new();
            let mut out = d.push(&bytes[..split]);
            out.push_str(&d.push(&bytes[split..]));
            out.push_str(&d.finish());
            assert_eq!(out, text, "split at {split}");
        }
    }

    #[test]
    fn invalid_byte_becomes_replacement_and_stream_continues() {
        let mut d = Utf8StreamDecoder::new();
        // 0xFF is never valid UTF-8; surrounding ASCII must survive.
        assert_eq!(d.push(&[b'a', 0xFF, b'b']), "a\u{FFFD}b");
        assert_eq!(d.finish(), "");
    }
}
