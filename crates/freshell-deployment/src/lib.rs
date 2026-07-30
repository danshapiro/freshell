use std::collections::HashSet;
use std::fmt;

use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompatibilityError {
    code: &'static str,
    message: String,
}

impl CompatibilityError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }
}

impl fmt::Display for CompatibilityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CompatibilityError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Component {
    Client,
    Server,
}

impl Component {
    fn as_str(self) -> &'static str {
        match self {
            Self::Client => "client",
            Self::Server => "server",
        }
    }

    fn peer(self) -> &'static str {
        match self {
            Self::Client => "server",
            Self::Server => "client",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionBounds {
    pub min_inclusive: String,
    pub max_exclusive: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComponentContract {
    pub version: String,
    pub supports: VersionBounds,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Contract {
    pub schema_version: String,
    pub client: ComponentContract,
    pub server: ComponentContract,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Supports {
    Client(VersionBounds),
    Server(VersionBounds),
}

impl Supports {
    fn peer(&self) -> &'static str {
        match self {
            Self::Client(_) => "client",
            Self::Server(_) => "server",
        }
    }

    fn bounds(&self) -> &VersionBounds {
        match self {
            Self::Client(bounds) | Self::Server(bounds) => bounds,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Declaration {
    pub schema_version: String,
    pub component: Component,
    pub version: String,
    pub supports: Supports,
}

const MAX_JSON_NESTING_DEPTH: usize = 64;

#[derive(Clone, Copy)]
enum ObjectState {
    KeyOrEnd,
    Key,
    Colon,
    Value,
    CommaOrEnd,
}

#[derive(Clone, Copy)]
enum ArrayState {
    ValueOrEnd,
    Value,
    CommaOrEnd,
}

enum ContainerFrame {
    Object {
        keys: HashSet<String>,
        state: ObjectState,
    },
    Array {
        state: ArrayState,
    },
}

#[derive(Clone, Copy)]
enum FrameState {
    Object(ObjectState),
    Array(ArrayState),
}

impl ContainerFrame {
    fn state(&self) -> FrameState {
        match self {
            Self::Object { state, .. } => FrameState::Object(*state),
            Self::Array { state } => FrameState::Array(*state),
        }
    }
}

struct DuplicateKeyScanner<'a> {
    raw: &'a str,
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> DuplicateKeyScanner<'a> {
    fn new(raw: &'a str) -> Self {
        Self {
            raw,
            bytes: raw.as_bytes(),
            offset: 0,
        }
    }

    fn scan(mut self) -> Result<(), CompatibilityError> {
        let mut frames = Vec::new();
        let mut root_complete = false;

        loop {
            self.whitespace();
            let Some(state) = frames.last().map(ContainerFrame::state) else {
                if root_complete {
                    if self.offset != self.bytes.len() {
                        return Err(invalid_json("unexpected content after JSON value"));
                    }
                    return Ok(());
                }
                self.begin_value(&mut frames, &mut root_complete)?;
                continue;
            };

            match state {
                FrameState::Object(ObjectState::KeyOrEnd) => {
                    if self.bytes.get(self.offset) == Some(&b'}') {
                        self.offset += 1;
                        frames.pop();
                        Self::finish_value(&mut frames, &mut root_complete)?;
                    } else {
                        self.object_key(&mut frames)?;
                    }
                }
                FrameState::Object(ObjectState::Key) => self.object_key(&mut frames)?,
                FrameState::Object(ObjectState::Colon) => {
                    if self.bytes.get(self.offset) != Some(&b':') {
                        return Err(invalid_json("expected colon after JSON object key"));
                    }
                    self.offset += 1;
                    let Some(ContainerFrame::Object { state, .. }) = frames.last_mut() else {
                        unreachable!("current frame is an object");
                    };
                    *state = ObjectState::Value;
                }
                FrameState::Object(ObjectState::Value) => {
                    self.begin_value(&mut frames, &mut root_complete)?;
                }
                FrameState::Object(ObjectState::CommaOrEnd) => match self.bytes.get(self.offset) {
                    Some(b'}') => {
                        self.offset += 1;
                        frames.pop();
                        Self::finish_value(&mut frames, &mut root_complete)?;
                    }
                    Some(b',') => {
                        self.offset += 1;
                        let Some(ContainerFrame::Object { state, .. }) = frames.last_mut() else {
                            unreachable!("current frame is an object");
                        };
                        *state = ObjectState::Key;
                    }
                    _ => return Err(invalid_json("expected comma in JSON object")),
                },
                FrameState::Array(ArrayState::ValueOrEnd) => {
                    if self.bytes.get(self.offset) == Some(&b']') {
                        self.offset += 1;
                        frames.pop();
                        Self::finish_value(&mut frames, &mut root_complete)?;
                    } else {
                        self.begin_value(&mut frames, &mut root_complete)?;
                    }
                }
                FrameState::Array(ArrayState::Value) => {
                    self.begin_value(&mut frames, &mut root_complete)?;
                }
                FrameState::Array(ArrayState::CommaOrEnd) => match self.bytes.get(self.offset) {
                    Some(b']') => {
                        self.offset += 1;
                        frames.pop();
                        Self::finish_value(&mut frames, &mut root_complete)?;
                    }
                    Some(b',') => {
                        self.offset += 1;
                        let Some(ContainerFrame::Array { state }) = frames.last_mut() else {
                            unreachable!("current frame is an array");
                        };
                        *state = ArrayState::Value;
                    }
                    _ => return Err(invalid_json("expected comma in JSON array")),
                },
            }
        }
    }

    fn whitespace(&mut self) {
        while self
            .bytes
            .get(self.offset)
            .is_some_and(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
        {
            self.offset += 1;
        }
    }

    fn begin_value(
        &mut self,
        frames: &mut Vec<ContainerFrame>,
        root_complete: &mut bool,
    ) -> Result<(), CompatibilityError> {
        self.whitespace();
        match self.bytes.get(self.offset) {
            Some(b'{') => {
                self.check_depth(frames.len())?;
                self.offset += 1;
                frames.push(ContainerFrame::Object {
                    keys: HashSet::new(),
                    state: ObjectState::KeyOrEnd,
                });
                Ok(())
            }
            Some(b'[') => {
                self.check_depth(frames.len())?;
                self.offset += 1;
                frames.push(ContainerFrame::Array {
                    state: ArrayState::ValueOrEnd,
                });
                Ok(())
            }
            Some(b'"') => {
                self.string_token()?;
                Self::finish_value(frames, root_complete)
            }
            Some(_) => {
                self.primitive()?;
                Self::finish_value(frames, root_complete)
            }
            None => Err(invalid_json("expected JSON value")),
        }
    }

    fn check_depth(&self, current_depth: usize) -> Result<(), CompatibilityError> {
        if current_depth >= MAX_JSON_NESTING_DEPTH {
            return Err(CompatibilityError::new(
                "JSON_NESTING_TOO_DEEP",
                format!("JSON nesting exceeds {MAX_JSON_NESTING_DEPTH}"),
            ));
        }
        Ok(())
    }

    fn finish_value(
        frames: &mut [ContainerFrame],
        root_complete: &mut bool,
    ) -> Result<(), CompatibilityError> {
        match frames.last_mut() {
            Some(ContainerFrame::Object { state, .. }) if matches!(state, ObjectState::Value) => {
                *state = ObjectState::CommaOrEnd;
            }
            Some(ContainerFrame::Array { state })
                if matches!(state, ArrayState::ValueOrEnd | ArrayState::Value) =>
            {
                *state = ArrayState::CommaOrEnd;
            }
            Some(_) => return Err(invalid_json("unexpected JSON value")),
            None => *root_complete = true,
        }
        Ok(())
    }

    fn object_key(&mut self, frames: &mut [ContainerFrame]) -> Result<(), CompatibilityError> {
        if self.bytes.get(self.offset) != Some(&b'"') {
            return Err(invalid_json("expected JSON object key"));
        }
        let key = self.string_token()?;
        let Some(ContainerFrame::Object { keys, state }) = frames.last_mut() else {
            unreachable!("current frame is an object");
        };
        if !keys.insert(key) {
            return Err(CompatibilityError::new(
                "DUPLICATE_KEY",
                "duplicate JSON object key",
            ));
        }
        *state = ObjectState::Colon;
        Ok(())
    }

    fn string_token(&mut self) -> Result<String, CompatibilityError> {
        let start = self.offset;
        self.offset += 1;
        while let Some(byte) = self.bytes.get(self.offset) {
            match byte {
                b'\\' => {
                    self.offset += 2;
                }
                b'"' => {
                    self.offset += 1;
                    return serde_json::from_str(&self.raw[start..self.offset])
                        .map_err(|_| invalid_json("invalid JSON string"));
                }
                _ => self.offset += 1,
            }
        }
        Err(invalid_json("unterminated JSON string"))
    }

    fn primitive(&mut self) -> Result<(), CompatibilityError> {
        let start = self.offset;
        while self
            .bytes
            .get(self.offset)
            .is_some_and(|byte| !matches!(byte, b' ' | b'\t' | b'\r' | b'\n' | b',' | b']' | b'}'))
        {
            self.offset += 1;
        }
        if self.offset == start {
            return Err(invalid_json("expected JSON value"));
        }
        serde_json::from_str::<Value>(&self.raw[start..self.offset])
            .map(|_| ())
            .map_err(|_| invalid_json("invalid JSON primitive"))
    }
}

fn invalid_json(message: &'static str) -> CompatibilityError {
    CompatibilityError::new("INVALID_JSON", message)
}

fn parse_json(raw: &str) -> Result<Value, CompatibilityError> {
    DuplicateKeyScanner::new(raw).scan()?;
    serde_json::from_str(raw).map_err(|_| invalid_json("invalid JSON"))
}

fn exact_object<'a>(
    value: &'a Value,
    expected: &[&str],
    context: &str,
) -> Result<&'a Map<String, Value>, CompatibilityError> {
    let object = value.as_object().ok_or_else(|| {
        CompatibilityError::new("INVALID_SHAPE", format!("{context} must be an object"))
    })?;
    if let Some(unknown) = object.keys().find(|key| !expected.contains(&key.as_str())) {
        return Err(CompatibilityError::new(
            "UNKNOWN_KEY",
            format!("unknown {context} key: {unknown}"),
        ));
    }
    if let Some(missing) = expected.iter().find(|key| !object.contains_key(**key)) {
        return Err(CompatibilityError::new(
            "MISSING_KEY",
            format!("missing {context} key: {missing}"),
        ));
    }
    Ok(object)
}

fn schema_version(value: &Value) -> Result<String, CompatibilityError> {
    if value.as_str() != Some("1") {
        return Err(CompatibilityError::new(
            "UNSUPPORTED_SCHEMA_VERSION",
            "schemaVersion must be \"1\"",
        ));
    }
    Ok("1".to_owned())
}

fn parse_version(value: &Value) -> Result<(String, [u32; 3]), CompatibilityError> {
    let raw = value
        .as_str()
        .ok_or_else(|| CompatibilityError::new("INVALID_VERSION", "version must be a string"))?;
    let parts = raw.split('.').collect::<Vec<_>>();
    if parts.len() != 3
        || parts.iter().any(|part| {
            part.is_empty()
                || !part.bytes().all(|byte| byte.is_ascii_digit())
                || (part.len() > 1 && part.starts_with('0'))
        })
    {
        return Err(CompatibilityError::new(
            "INVALID_VERSION",
            format!("invalid version: {raw}"),
        ));
    }
    let mut components = [0_u32; 3];
    for (index, part) in parts.iter().enumerate() {
        let parsed = part.parse::<u64>().map_err(|_| {
            CompatibilityError::new(
                "VERSION_COMPONENT_OVERFLOW",
                "version component exceeds u32",
            )
        })?;
        components[index] = u32::try_from(parsed).map_err(|_| {
            CompatibilityError::new(
                "VERSION_COMPONENT_OVERFLOW",
                "version component exceeds u32",
            )
        })?;
    }
    Ok((raw.to_owned(), components))
}

fn parse_bounds(value: &Value, context: &str) -> Result<VersionBounds, CompatibilityError> {
    let object = exact_object(value, &["minInclusive", "maxExclusive"], context)?;
    let (min_inclusive, minimum) = parse_version(&object["minInclusive"])?;
    let (max_exclusive, maximum) = parse_version(&object["maxExclusive"])?;
    if minimum >= maximum {
        return Err(CompatibilityError::new(
            "INVALID_VERSION_RANGE",
            format!("{context} must be a non-empty half-open range"),
        ));
    }
    Ok(VersionBounds {
        min_inclusive,
        max_exclusive,
    })
}

fn parse_component_contract(
    value: &Value,
    component: Component,
) -> Result<ComponentContract, CompatibilityError> {
    let supports_key = match component {
        Component::Client => "supportsServer",
        Component::Server => "supportsClient",
    };
    let object = exact_object(value, &["version", supports_key], component.as_str())?;
    Ok(ComponentContract {
        version: parse_version(&object["version"])?.0,
        supports: parse_bounds(
            &object[supports_key],
            &format!("{}.{}", component.as_str(), supports_key),
        )?,
    })
}

pub fn parse_contract(raw: &str) -> Result<Contract, CompatibilityError> {
    let value = parse_json(raw)?;
    let object = exact_object(&value, &["schemaVersion", "client", "server"], "contract")?;
    let contract = Contract {
        schema_version: schema_version(&object["schemaVersion"])?,
        client: parse_component_contract(&object["client"], Component::Client)?,
        server: parse_component_contract(&object["server"], Component::Server)?,
    };
    assert_mutually_compatible(
        &project_declaration(&contract, Component::Client),
        &project_declaration(&contract, Component::Server),
    )?;
    Ok(contract)
}

pub fn parse_declaration(
    raw: &str,
    supplied_digest: Option<&str>,
) -> Result<Declaration, CompatibilityError> {
    let value = parse_json(raw)?;
    let object = exact_object(
        &value,
        &["schemaVersion", "component", "version", "supports"],
        "declaration",
    )?;
    let schema_version = schema_version(&object["schemaVersion"])?;
    let component = match object["component"].as_str() {
        Some("client") => Component::Client,
        Some("server") => Component::Server,
        _ => {
            return Err(CompatibilityError::new(
                "INVALID_COMPONENT",
                "component must be \"client\" or \"server\"",
            ));
        }
    };
    let supports_object = object["supports"]
        .as_object()
        .ok_or_else(|| CompatibilityError::new("INVALID_SHAPE", "supports must be an object"))?;
    if !supports_object.contains_key(component.peer())
        && supports_object.contains_key(component.as_str())
    {
        return Err(CompatibilityError::new(
            "RECIPROCAL_KEY_MISMATCH",
            format!("supports must contain the {} range", component.peer()),
        ));
    }
    let supports_object = exact_object(&object["supports"], &[component.peer()], "supports")?;
    let parsed_bounds = parse_bounds(
        &supports_object[component.peer()],
        &format!("supports.{}", component.peer()),
    )?;
    let declaration = Declaration {
        schema_version,
        component,
        version: parse_version(&object["version"])?.0,
        supports: match component {
            Component::Client => Supports::Server(parsed_bounds),
            Component::Server => Supports::Client(parsed_bounds),
        },
    };
    if supplied_digest.is_some_and(|digest| digest != declaration_digest(&declaration)) {
        return Err(CompatibilityError::new(
            "DIGEST_MISMATCH",
            "supplied declaration digest does not match canonical bytes",
        ));
    }
    Ok(declaration)
}

pub fn project_declaration(contract: &Contract, component: Component) -> Declaration {
    match component {
        Component::Client => Declaration {
            schema_version: "1".to_owned(),
            component,
            version: contract.client.version.clone(),
            supports: Supports::Server(contract.client.supports.clone()),
        },
        Component::Server => Declaration {
            schema_version: "1".to_owned(),
            component,
            version: contract.server.version.clone(),
            supports: Supports::Client(contract.server.supports.clone()),
        },
    }
}

pub fn canonical_declaration_bytes(declaration: &Declaration) -> Vec<u8> {
    let bounds = declaration.supports.bounds();
    format!(
        r#"{{"schemaVersion":"1","component":"{}","version":"{}","supports":{{"{}":{{"minInclusive":"{}","maxExclusive":"{}"}}}}}}"#,
        declaration.component.as_str(),
        declaration.version,
        declaration.supports.peer(),
        bounds.min_inclusive,
        bounds.max_exclusive,
    )
    .into_bytes()
}

pub fn declaration_digest(declaration: &Declaration) -> String {
    let mut hasher = Sha256::new();
    hasher.update(canonical_declaration_bytes(declaration));
    format!("{:x}", hasher.finalize())
}

fn range_contains(bounds: &VersionBounds, candidate: &str) -> Result<bool, CompatibilityError> {
    let (_, minimum) = parse_version(&Value::String(bounds.min_inclusive.clone()))?;
    let (_, maximum) = parse_version(&Value::String(bounds.max_exclusive.clone()))?;
    let (_, candidate) = parse_version(&Value::String(candidate.to_owned()))?;
    Ok(minimum <= candidate && candidate < maximum)
}

pub fn assert_mutually_compatible(
    client: &Declaration,
    server: &Declaration,
) -> Result<(), CompatibilityError> {
    if client.component != Component::Client {
        return Err(CompatibilityError::new(
            "EXPECTED_CLIENT_DECLARATION",
            "first declaration must describe the client",
        ));
    }
    if server.component != Component::Server {
        return Err(CompatibilityError::new(
            "EXPECTED_SERVER_DECLARATION",
            "second declaration must describe the server",
        ));
    }
    let Supports::Server(client_range) = &client.supports else {
        return Err(CompatibilityError::new(
            "RECIPROCAL_KEY_MISMATCH",
            "client declaration must support server",
        ));
    };
    let Supports::Client(server_range) = &server.supports else {
        return Err(CompatibilityError::new(
            "RECIPROCAL_KEY_MISMATCH",
            "server declaration must support client",
        ));
    };
    if !range_contains(client_range, &server.version)? {
        return Err(CompatibilityError::new(
            "CLIENT_DOES_NOT_SUPPORT_SERVER",
            "client does not support the server version",
        ));
    }
    if !range_contains(server_range, &client.version)? {
        return Err(CompatibilityError::new(
            "SERVER_DOES_NOT_SUPPORT_CLIENT",
            "server does not support the client version",
        ));
    }
    Ok(())
}

pub fn serialize_event(event: &Value) -> String {
    format!(
        "{}\n",
        serde_json::to_string(event).expect("serde_json::Value is always serializable")
    )
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CorpusCase {
        name: String,
        raw: String,
        expected_code: String,
        expected_canonical: Option<String>,
        expected_sha256: Option<String>,
    }

    fn corpus() -> Vec<CorpusCase> {
        include_str!("../../../test/fixtures/deployment-compatibility/cases.jsonl")
            .lines()
            .map(|line| serde_json::from_str(line).expect("valid corpus line"))
            .collect()
    }

    fn seeded_pair() -> (Declaration, Declaration) {
        let contract = parse_contract(include_str!(
            "../../../config/deployment-compatibility.json"
        ))
        .expect("valid seeded contract");
        (
            project_declaration(&contract, Component::Client),
            project_declaration(&contract, Component::Server),
        )
    }

    #[test]
    fn declaration_corpus_matches_codes_canonical_bytes_and_digests() {
        let (seeded_client, seeded_server) = seeded_pair();
        for vector in corpus() {
            let result = parse_declaration(&vector.raw, None).and_then(|declaration| {
                match vector.expected_code.as_str() {
                    "CLIENT_DOES_NOT_SUPPORT_SERVER" => {
                        assert_mutually_compatible(&declaration, &seeded_server)?;
                    }
                    "SERVER_DOES_NOT_SUPPORT_CLIENT" => {
                        assert_mutually_compatible(&seeded_client, &declaration)?;
                    }
                    _ => {}
                }
                Ok(declaration)
            });
            let actual_code = result
                .as_ref()
                .map(|_| "OK")
                .unwrap_or_else(|error| error.code());
            assert_eq!(actual_code, vector.expected_code, "{}", vector.name);

            if let (Ok(declaration), Some(expected)) = (&result, vector.expected_canonical) {
                assert_eq!(
                    String::from_utf8(canonical_declaration_bytes(declaration)).unwrap(),
                    expected,
                    "{}",
                    vector.name
                );
                assert_eq!(
                    declaration_digest(declaration),
                    vector.expected_sha256.unwrap(),
                    "{}",
                    vector.name
                );
            }
        }
    }

    #[test]
    fn source_contract_projects_a_mutually_compatible_seeded_pair() {
        let (client, server) = seeded_pair();
        assert_eq!(client.version, "0.7.5");
        assert_eq!(server.version, "0.7.0");
        assert_mutually_compatible(&client, &server).unwrap();
    }

    #[test]
    fn supplied_digest_is_only_a_recomputed_assertion() {
        let (client, _) = seeded_pair();
        let raw = String::from_utf8(canonical_declaration_bytes(&client)).unwrap();
        parse_declaration(
            &raw,
            Some("43c554165e167d8d5b33b22b84ce63c8aa5940cc1ba9effb29d62c85aee1c6bb"),
        )
        .unwrap();
        assert_eq!(
            parse_declaration(&raw, Some(&"0".repeat(64)))
                .unwrap_err()
                .code(),
            "DIGEST_MISMATCH"
        );
    }

    #[test]
    fn serializes_one_compact_jsonl_event() {
        let event = serde_json::json!({"phase": "prepared", "generationId": "abc"});
        assert_eq!(
            serialize_event(&event),
            "{\"phase\":\"prepared\",\"generationId\":\"abc\"}\n"
        );
    }

    #[test]
    fn rejects_very_deep_json_without_overflowing_the_call_stack() {
        let raw = format!("{}null{}", "[".repeat(20_000), "]".repeat(20_000));
        assert_eq!(
            parse_declaration(&raw, None).unwrap_err().code(),
            "JSON_NESTING_TOO_DEEP"
        );
    }
}
