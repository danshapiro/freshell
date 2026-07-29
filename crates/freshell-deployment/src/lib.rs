use std::collections::HashSet;
use std::fmt;

use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Number, Value};
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

#[derive(Debug)]
enum CheckedValue {
    Null,
    Bool(bool),
    Number(Number),
    String(String),
    Array(Vec<CheckedValue>),
    Object(Vec<(String, CheckedValue)>),
}

impl CheckedValue {
    fn into_value(self) -> Value {
        match self {
            Self::Null => Value::Null,
            Self::Bool(value) => Value::Bool(value),
            Self::Number(value) => Value::Number(value),
            Self::String(value) => Value::String(value),
            Self::Array(values) => {
                Value::Array(values.into_iter().map(CheckedValue::into_value).collect())
            }
            Self::Object(values) => Value::Object(
                values
                    .into_iter()
                    .map(|(key, value)| (key, value.into_value()))
                    .collect(),
            ),
        }
    }
}

impl<'de> Deserialize<'de> for CheckedValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(CheckedValueVisitor)
    }
}

struct CheckedValueVisitor;

impl<'de> Visitor<'de> for CheckedValueVisitor {
    type Value = CheckedValue;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(CheckedValue::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(CheckedValue::Number(Number::from(value)))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(CheckedValue::Number(Number::from(value)))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Number::from_f64(value)
            .map(CheckedValue::Number)
            .ok_or_else(|| E::custom("non-finite JSON number"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(CheckedValue::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(CheckedValue::String(value))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(CheckedValue::Null)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(CheckedValue::Null)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element()? {
            values.push(value);
        }
        Ok(CheckedValue::Array(values))
    }

    fn visit_map<A>(self, mut object: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut keys = HashSet::new();
        let mut values = Vec::new();
        while let Some(key) = object.next_key::<String>()? {
            if !keys.insert(key.clone()) {
                return Err(de::Error::custom(format!("DUPLICATE_KEY:{key}")));
            }
            values.push((key, object.next_value()?));
        }
        Ok(CheckedValue::Object(values))
    }
}

fn parse_json(raw: &str) -> Result<Value, CompatibilityError> {
    serde_json::from_str::<CheckedValue>(raw)
        .map(CheckedValue::into_value)
        .map_err(|error| {
            if error.to_string().contains("DUPLICATE_KEY:") {
                CompatibilityError::new("DUPLICATE_KEY", "duplicate JSON object key")
            } else {
                CompatibilityError::new("INVALID_JSON", "invalid JSON")
            }
        })
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
}
