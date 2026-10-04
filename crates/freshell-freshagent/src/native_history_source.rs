//! Bounded display strings over an exact, read-only native JSON source.
//!
//! This adapter leaves JSON structure, native identities and small values intact.
//! Large bodies are consumed through EOF without materializing them. Their digest
//! remains available to the native message mirror matcher until display projection.
use serde::de::{DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::io::{self, BufRead, Read};
use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    rc::Rc,
};

const STRING_BYTES: usize = super::RETAINED_TURN_BYTES;

/// Only tokens created by this read are interpreted as omissions. Source text
/// cannot accidentally acquire the meaning of an internal display marker.
#[derive(Clone)]
pub(crate) struct Retention {
    prefix: String,
    pub(crate) index_key: String,
    pub(crate) fingerprint_key: String,
}
impl Retention {
    pub(crate) fn new() -> Self {
        let prefix = format!("FRESHELL_NATIVE_HISTORY_{}:", uuid::Uuid::new_v4());
        Self {
            index_key: format!("{prefix}index"),
            fingerprint_key: format!("{prefix}fingerprint"),
            prefix,
        }
    }
    pub(crate) fn marker(&self, reason: &str) -> String {
        format!("{}{};", self.prefix, reason)
    }
    pub(crate) fn finish(&self, value: &mut Value) -> usize {
        match value {
            Value::String(text) => {
                if !text.contains(&self.prefix) {
                    return 0;
                }
                let mut output = String::with_capacity(text.len());
                let mut count = 0;
                let mut start = 0;
                while let Some(relative) = text[start..].find(&self.prefix) {
                    let begin = start + relative;
                    let Some(end) = text[begin..].find(';').map(|end| begin + end + 1) else {
                        break;
                    };
                    output.push_str(&text[start..begin]);
                    let reason = &text[begin + self.prefix.len()..end - 1];
                    if reason == "body"
                        || reason == "collection"
                        || reason.len() == 64 && reason.bytes().all(|byte| byte.is_ascii_hexdigit())
                    {
                        output.push_str("[Content omitted from retained history]");
                        count += 1;
                    } else {
                        output.push_str(&text[begin..end]);
                    }
                    start = end;
                }
                output.push_str(&text[start..]);
                *text = output;
                count
            }
            Value::Array(values) => values.iter_mut().map(|value| self.finish(value)).sum(),
            Value::Object(values) => {
                values.remove(&self.index_key);
                values.remove(&self.fingerprint_key);
                values
                    .iter_mut()
                    .map(|(key, value)| {
                        let count = self.finish(value);
                        if key == "summary" {
                            0
                        } else {
                            count
                        }
                    })
                    .sum()
            }
            _ => 0,
        }
    }
}

// Hash original decoded Codex message text as it streams, before array or
// body retention. Event copies join the same text into one string; display
// previews alone cannot establish whether those records mirror one message.
#[derive(Default)]
struct MessageCapture {
    hash: RefCell<Sha256>,
    active: Cell<bool>,
    part: Cell<bool>,
    started: Cell<bool>,
    parts: Cell<usize>,
}
impl MessageCapture {
    fn append(&self, bytes: &[u8]) {
        if !self.started.replace(true) {
            if self.part.get() && self.parts.get() > 0 {
                self.hash.borrow_mut().update(b"\n");
            }
            self.parts.set(self.parts.get() + 1);
        }
        self.hash.borrow_mut().update(bytes);
    }
}

pub(crate) struct DisplaySource<R> {
    input: R,
    pending: Vec<u8>,
    offset: usize,
    key: String,
    retention: Retention,
    capture: Rc<MessageCapture>,
}

impl<R: BufRead> DisplaySource<R> {
    fn new(input: R, retention: Retention, capture: Rc<MessageCapture>) -> Self {
        Self {
            input,
            pending: Vec::new(),
            offset: 0,
            key: String::new(),
            retention,
            capture,
        }
    }

    fn byte(&mut self) -> io::Result<Option<u8>> {
        let byte = self.input.fill_buf()?.first().copied();
        if byte.is_some() {
            self.input.consume(1);
        }
        Ok(byte)
    }

    fn token(&mut self) -> io::Result<()> {
        self.pending.clear();
        self.offset = 0;
        let Some(first) = self.byte()? else {
            return Ok(());
        };
        self.pending.push(first);
        if first != b'"' {
            return Ok(());
        }
        let mut escaped = false;
        let mut large = false;
        let mut hash = StringDigest::new(self.capture.clone());
        loop {
            let Some(byte) = self.byte()? else {
                // A partial final JSONL record remains malformed for the parser.
                return Ok(());
            };
            if byte == b'"' && !escaped {
                break;
            }
            if !large && self.pending.len() < STRING_BYTES {
                self.pending.push(byte);
            } else {
                if !large {
                    for byte in &self.pending[1..] {
                        hash.byte(*byte)?;
                    }
                    large = true;
                }
                hash.byte(byte)?;
            }
            escaped = byte == b'\\' && !escaped;
        }
        while self
            .input
            .fill_buf()?
            .first()
            .is_some_and(u8::is_ascii_whitespace)
        {
            self.input.consume(1);
        }
        let is_key = self.input.fill_buf()?.first() == Some(&b':');
        if large {
            if is_key
                || matches!(
                    self.key.as_str(),
                    "id" | "uuid"
                        | "parentUuid"
                        | "turn_id"
                        | "call_id"
                        | "tool_use_id"
                        | "sessionId"
                        | "threadId"
                        | "session_id"
                )
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "native history identity is oversized",
                ));
            }
            let (digest, tail) = hash.finish()?;
            self.pending =
                serde_json::to_vec(&format!("{}\n{tail}", self.retention.marker(&digest)))
                    .map_err(io::Error::other)?;
        } else {
            self.pending.push(b'"');
            if !is_key && self.capture.active.get() {
                let text: String =
                    serde_json::from_slice(&self.pending).map_err(io::Error::other)?;
                self.capture.append(text.as_bytes());
            }
            if is_key {
                self.key = serde_json::from_slice(&self.pending).map_err(io::Error::other)?;
            }
        }
        Ok(())
    }
}

// Compare decoded body text even when mirrors use different JSON escaping.
struct StringDigest {
    hash: Sha256,
    bytes: Vec<u8>,
    escape: Vec<u8>,
    high_surrogate: Option<u32>,
    tail: Vec<u8>,
    capture: Rc<MessageCapture>,
}
impl StringDigest {
    fn new(capture: Rc<MessageCapture>) -> Self {
        Self {
            hash: Sha256::new(),
            bytes: Vec::with_capacity(8192),
            escape: Vec::new(),
            high_surrogate: None,
            tail: Vec::new(),
            capture,
        }
    }
    fn byte(&mut self, byte: u8) -> io::Result<()> {
        if self.escape.is_empty() {
            if byte == b'\\' {
                self.escape.push(byte);
            } else {
                self.bytes.push(byte);
            }
        } else if self.escape.len() == 1 {
            if byte == b'u' {
                self.escape.push(byte);
            } else {
                let decoded = match byte {
                    b'"' | b'\\' | b'/' => byte,
                    b'b' => 8,
                    b'f' => 12,
                    b'n' => b'\n',
                    b'r' => b'\r',
                    b't' => b'\t',
                    _ => {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "invalid native JSON escape",
                        ))
                    }
                };
                self.bytes.push(decoded);
                self.escape.clear();
            }
        } else {
            self.escape.push(byte);
            if self.escape.len() == 6 {
                let hex = std::str::from_utf8(&self.escape[2..]).map_err(io::Error::other)?;
                let code = u32::from_str_radix(hex, 16).map_err(io::Error::other)?;
                self.escape.clear();
                if (0xd800..=0xdbff).contains(&code) {
                    self.high_surrogate = Some(code);
                } else {
                    let code = if let Some(high) = self.high_surrogate.take() {
                        if !(0xdc00..=0xdfff).contains(&code) {
                            return Err(io::Error::new(
                                io::ErrorKind::InvalidData,
                                "invalid native Unicode surrogate",
                            ));
                        }
                        0x10000 + ((high - 0xd800) << 10) + code - 0xdc00
                    } else {
                        code
                    };
                    let character = char::from_u32(code).ok_or_else(|| {
                        io::Error::new(io::ErrorKind::InvalidData, "invalid native Unicode escape")
                    })?;
                    let mut encoded = [0; 4];
                    self.bytes
                        .extend_from_slice(character.encode_utf8(&mut encoded).as_bytes());
                }
            }
        }
        if self.bytes.len() >= 8192 {
            self.flush();
        }
        Ok(())
    }
    fn flush(&mut self) {
        self.hash.update(&self.bytes);
        if self.capture.active.get() {
            self.capture.append(&self.bytes);
        }
        self.tail.extend_from_slice(&self.bytes);
        if self.tail.len() > super::RETAINED_TURN_BYTES / 1024 {
            self.tail
                .drain(..self.tail.len() - super::RETAINED_TURN_BYTES / 1024);
        }
        self.bytes.clear();
    }
    fn finish(mut self) -> io::Result<(String, String)> {
        if !self.escape.is_empty() || self.high_surrogate.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "incomplete native JSON escape",
            ));
        }
        self.flush();
        while self.tail.first().is_some_and(|byte| byte & 0xc0 == 0x80) {
            self.tail.remove(0);
        }
        Ok((
            format!("{:x}", self.hash.finalize()),
            String::from_utf8(self.tail).map_err(io::Error::other)?,
        ))
    }
}

impl<R: BufRead> Read for DisplaySource<R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        let mut written = 0;
        while written < output.len() {
            if self.offset == self.pending.len() {
                self.token()?;
                if self.pending.is_empty() {
                    break;
                }
            }
            let count = (output.len() - written).min(self.pending.len() - self.offset);
            output[written..written + count]
                .copy_from_slice(&self.pending[self.offset..self.offset + count]);
            written += count;
            self.offset += count;
        }
        Ok(written)
    }
}

/// Scan JSONL one captured record at a time. Malformed native records do not
/// prevent earlier or subsequent complete durable records from being displayed.
pub(crate) struct Records<R> {
    input: R,
    retention: Retention,
}
impl<R: BufRead> Records<R> {
    pub(crate) fn new(input: R, retention: &Retention) -> Self {
        Self {
            input,
            retention: retention.clone(),
        }
    }
}
struct Line<'a, R> {
    input: &'a mut R,
    complete: &'a Cell<bool>,
}
impl<R: BufRead> Read for Line<'_, R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if self.complete.get() || output.is_empty() {
            return Ok(0);
        }
        let input = self.input.fill_buf()?;
        let count = input
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|end| end + 1)
            .unwrap_or(input.len())
            .min(output.len());
        output[..count].copy_from_slice(&input[..count]);
        if count > 0 && input[count - 1] == b'\n' {
            self.complete.set(true);
        }
        self.input.consume(count);
        Ok(count)
    }
}
impl<R: BufRead> Iterator for Records<R> {
    type Item = io::Result<Option<(Value, usize)>>;
    fn next(&mut self) -> Option<Self::Item> {
        match self.input.fill_buf() {
            Ok([]) => return None,
            Err(error) => return Some(Err(error)),
            _ => {}
        }
        let complete = Cell::new(false);
        let line = Line {
            input: &mut self.input,
            complete: &complete,
        };
        let result = bounded_value(std::io::BufReader::new(line), &self.retention);
        if !complete.get() {
            if let Err(error) = self.input.skip_until(b'\n') {
                return Some(Err(error));
            }
        }
        Some(match result {
            Ok(record) => Ok(Some(record)),
            Err(error)
                if error.is_io() && error.io_error_kind() != Some(io::ErrorKind::InvalidData) =>
            {
                Err(io::Error::other(error))
            }
            Err(_) => Ok(None),
        })
    }
}

pub(crate) fn bounded_value(
    reader: impl BufRead,
    retention: &Retention,
) -> Result<(Value, usize), serde_json::Error> {
    let omitted = Rc::new(Cell::new(0));
    let capture = Rc::new(MessageCapture::default());
    let mut deserializer = serde_json::Deserializer::from_reader(DisplaySource::new(
        reader,
        retention.clone(),
        capture.clone(),
    ));
    let mut value = BoundedValue {
        omitted: omitted.clone(),
        retention: retention.clone(),
        capture: capture.clone(),
        path: Vec::new(),
    }
    .deserialize(&mut deserializer)?;
    deserializer.end()?;
    if capture.parts.get() > 0 {
        if let Some(payload) = value.get_mut("payload").and_then(Value::as_object_mut) {
            payload.insert(
                retention.fingerprint_key.clone(),
                Value::String(format!("{:x}", capture.hash.borrow().clone().finalize())),
            );
        }
    }
    Ok((value, omitted.get()))
}

/// serde's visitor bounds collections as they are decoded, before a large
/// array or arbitrary tool result can allocate the complete source tree.
struct BoundedValue {
    omitted: Rc<Cell<usize>>,
    retention: Retention,
    capture: Rc<MessageCapture>,
    path: Vec<String>,
}
impl BoundedValue {
    fn child(&self, key: String) -> Self {
        let mut path = self.path.clone();
        path.push(key);
        Self {
            omitted: self.omitted.clone(),
            retention: self.retention.clone(),
            capture: self.capture.clone(),
            path,
        }
    }
}
impl<'de> DeserializeSeed<'de> for BoundedValue {
    type Value = Value;
    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        let message = self.path.len() == 2
            && self.path[0] == "payload"
            && matches!(self.path[1].as_str(), "message" | "last_agent_message");
        let part = self.path.len() == 4
            && self.path[0] == "payload"
            && self.path[1] == "content"
            && self.path[3] == "text";
        self.capture.active.set(message || part);
        self.capture.part.set(part);
        self.capture.started.set(false);
        let capture = self.capture.clone();
        let result = deserializer.deserialize_any(self);
        capture.active.set(false);
        result
    }
}
impl<'de> Visitor<'de> for BoundedValue {
    type Value = Value;
    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a native JSON value")
    }
    fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }
    fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Value, E> {
        Ok(Value::from(value))
    }
    fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Value, E> {
        Ok(Value::from(value))
    }
    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Value, E> {
        Ok(Value::from(value))
    }
    fn visit_unit<E: serde::de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Value, E> {
        Ok(Value::String(value.into()))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Value, A::Error> {
        let mut values = VecDeque::new();
        let mut bytes = 0;
        let mut index = 0;
        loop {
            let Some(mut value) = sequence.next_element_seed(self.child(index.to_string()))? else {
                break;
            };
            if self.path == ["message", "content"] || self.path == ["payload", "content"] {
                if let Some(object) = value.as_object_mut() {
                    object.insert(self.retention.index_key.clone(), Value::from(index));
                }
            }
            index += 1;
            if serde_json::to_vec(&value)
                .map_err(serde::de::Error::custom)?
                .len()
                > super::RETAINED_TURN_BYTES
            {
                super::omit_large_bodies(&mut value, &self.retention);
            }
            let size = serde_json::to_vec(&value)
                .map_err(serde::de::Error::custom)?
                .len();
            bytes += size;
            values.push_back((value, size));
            while bytes > super::RETAINED_TURN_BYTES && values.len() > 1 {
                bytes -= values.pop_front().unwrap().1;
                self.omitted.set(self.omitted.get() + 1);
            }
        }
        Ok(Value::Array(
            values.into_iter().map(|(value, _)| value).collect(),
        ))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut object: A) -> Result<Value, A::Error> {
        let mut values = Map::new();
        let mut bytes = 0;
        while let Some(key) = object.next_key::<String>()? {
            // Control/identity containers are kept even when an arbitrary body
            // filled the preview. Do not lose a task_complete or tool link.
            let control = matches!(
                key.as_str(),
                "payload"
                    | "content"
                    | "text"
                    | "last_agent_message"
                    | "message"
                    | "item"
                    | "info"
                    | "state"
                    | "id"
                    | "uuid"
                    | "parentUuid"
                    | "type"
                    | "role"
                    | "status"
                    | "turn_id"
                    | "call_id"
                    | "tool_use_id"
                    | "sessionId"
                    | "threadId"
                    | "session_id"
                    | "name"
                    | "tool"
                    | "server"
            );
            if bytes > super::RETAINED_TURN_BYTES * 2 && !control {
                object.next_value::<IgnoredAny>()?;
                self.omitted.set(self.omitted.get() + 1);
                values.insert(key, Value::String(self.retention.marker("collection")));
            } else {
                let value = object.next_value_seed(self.child(key.clone()))?;
                bytes += key.len()
                    + serde_json::to_vec(&value)
                        .map_err(serde::de::Error::custom)?
                        .len();
                values.insert(key, value);
            }
        }
        Ok(Value::Object(values))
    }
}
