//! Bounded native MCP elicitation projection. No provider RPC or UI schema interpreter.
use super::*;

pub(super) fn normalize(params: &Value) -> Option<Value> {
    let mode = params.get("mode")?.as_str()?;
    let mut public = json!({"mode":mode,"serverName":params.get("serverName")?.as_str()?,"message":params.get("message").and_then(Value::as_str).unwrap_or("")});
    if let Some(title) = params.get("title").and_then(Value::as_str) {
        public["title"] = json!(title);
    }
    if mode == "url" {
        public["url"] = json!(params.get("url")?.as_str()?);
        public["elicitationId"] = json!(params.get("elicitationId")?.as_str()?);
        return Some(public);
    }
    if !matches!(mode, "form" | "openai/form" | "openaiForm") {
        return None;
    }
    let schema = params.get("requestedSchema")?;
    if schema.get("type")?.as_str()? != "object" {
        return None;
    }
    let object = schema.as_object()?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "$schema"
                | "type"
                | "properties"
                | "required"
                | "title"
                | "description"
                | "additionalProperties"
        )
    }) || schema
        .get("additionalProperties")
        .is_some_and(|value| !value.is_boolean())
    {
        return None;
    }
    let properties = schema.get("properties")?.as_object()?;
    if properties.len() > 32 {
        return None;
    }
    if schema
        .get("required")
        .is_some_and(|value| !value.is_null() && !value.is_array())
    {
        return None;
    }
    let required = schema.get("required").and_then(Value::as_array);
    if required.is_some_and(|ids| {
        ids.iter()
            .any(|id| id.as_str().is_none_or(|id| !properties.contains_key(id)))
    }) {
        return None;
    }
    let mut fields = Vec::new();
    for (id, raw) in properties {
        let kind = raw.get("type")?.as_str()?;
        if !matches!(kind, "string" | "number" | "integer" | "boolean" | "array") {
            return None;
        }
        if !representable_field(raw, kind) {
            return None;
        }
        if let Some(default) = raw.get("default").filter(|value| !value.is_null()) {
            let valid = match kind {
                "string" => default.is_string(),
                "boolean" => default.is_boolean(),
                "number" => default.is_number(),
                "integer" => default.as_f64().is_some_and(|value| value.fract() == 0.0),
                "array" => default
                    .as_array()
                    .is_some_and(|values| values.iter().all(Value::is_string)),
                _ => false,
            };
            if !valid {
                return None;
            }
        }
        let mut field = json!({"id":id,"type":kind,"title":raw.get("title").and_then(Value::as_str).unwrap_or(id),"required":required.is_some_and(|ids| ids.iter().any(|value|value.as_str()==Some(id))),"secret":raw["writeOnly"]==true || raw["isSecret"]==true});
        let choices = if kind == "array" { &raw["items"] } else { raw };
        if let Some(values) = choices.get("enum").and_then(Value::as_array) {
            if values.iter().any(|v| !v.is_string()) {
                return None;
            }
            field["choices"] = json!(values.iter().enumerate().map(|(index,value)| json!({"value":value,"label":choices.get("enumNames").and_then(Value::as_array).and_then(|names|names.get(index)).and_then(Value::as_str).map(Value::from).unwrap_or_else(||value.clone())})).collect::<Vec<_>>());
        } else if let Some(values) = choices
            .get(if kind == "array" { "anyOf" } else { "oneOf" })
            .and_then(Value::as_array)
        {
            let values = values.iter().map(|value| Some(json!({"value":value.get("const")?.as_str()?,"label":value.get("title")?.as_str()?}))).collect::<Option<Vec<_>>>()?;
            field["choices"] = json!(values);
        } else if kind == "array" {
            return None;
        }
        for key in [
            "description",
            "default",
            "minimum",
            "maximum",
            "minLength",
            "maxLength",
            "minItems",
            "maxItems",
            "format",
        ] {
            if key == "default" && field["secret"] == true {
                continue;
            }
            if let Some(value) = raw.get(key).filter(|v| !v.is_null()) {
                field[key] = value.clone();
            }
        }
        if raw.get("pattern").is_some() {
            return None;
        }
        fields.push(field);
    }
    public["fields"] = json!(fields);
    Some(public)
}

fn representable_field(raw: &Value, kind: &str) -> bool {
    let Some(object) = raw.as_object() else {
        return false;
    };
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "type"
                | "title"
                | "description"
                | "default"
                | "writeOnly"
                | "isSecret"
                | "enum"
                | "enumNames"
                | "oneOf"
                | "items"
                | "minimum"
                | "maximum"
                | "minLength"
                | "maxLength"
                | "minItems"
                | "maxItems"
                | "format"
        )
    }) {
        return false;
    }
    for key in ["title", "description"] {
        if raw
            .get(key)
            .is_some_and(|value| !value.is_null() && !value.is_string())
        {
            return false;
        }
    }
    for key in ["writeOnly", "isSecret"] {
        if raw
            .get(key)
            .is_some_and(|value| !value.is_null() && !value.is_boolean())
        {
            return false;
        }
    }
    for key in ["minimum", "maximum"] {
        if raw
            .get(key)
            .is_some_and(|value| !value.is_null() && !value.is_number())
        {
            return false;
        }
    }
    for key in ["minLength", "maxLength", "minItems", "maxItems"] {
        if raw
            .get(key)
            .is_some_and(|value| !value.is_null() && value.as_u64().is_none())
        {
            return false;
        }
    }
    if raw.get("format").is_some_and(|value| {
        !value.is_null() && !matches!(value.as_str(), Some("email" | "uri" | "date" | "date-time"))
    }) {
        return false;
    }
    if kind == "array" {
        let Some(items) = raw["items"].as_object() else {
            return false;
        };
        if items
            .keys()
            .any(|key| !matches!(key.as_str(), "type" | "enum" | "anyOf"))
            || items
                .get("type")
                .is_some_and(|value| value.as_str() != Some("string"))
        {
            return false;
        }
    }
    let choices = if kind == "array" { &raw["items"] } else { raw };
    for key in ["enum", "enumNames"] {
        if choices.get(key).is_some_and(|value| {
            !value.is_null()
                && value
                    .as_array()
                    .is_none_or(|values| values.iter().any(|value| !value.is_string()))
        }) {
            return false;
        }
    }
    let choice_key = if kind == "array" { "anyOf" } else { "oneOf" };
    if choices
        .get(choice_key)
        .is_some_and(|value| !value.is_null() && !value.is_array())
    {
        return false;
    }

    if let Some(options) = choices
        .get(if kind == "array" { "anyOf" } else { "oneOf" })
        .and_then(Value::as_array)
    {
        if options.iter().any(|value| {
            value.as_object().is_none_or(|object| {
                object
                    .keys()
                    .any(|key| !matches!(key.as_str(), "const" | "title"))
            })
        }) {
            return false;
        }
    }
    true
}

pub(super) fn response(
    params: &Value,
    action: &freshell_protocol::ElicitationAction,
    content: &Option<std::collections::BTreeMap<String, freshell_protocol::ElicitationValue>>,
) -> Result<Value, &'static str> {
    use freshell_protocol::ElicitationAction;
    if *action != ElicitationAction::Accept || params["mode"] == "url" {
        if content.is_some() {
            return Err("This elicitation action requires empty content.");
        }
        return Ok(json!({"action":action,"content":null}));
    }
    let public = normalize(params).ok_or("This elicitation form is no longer supported.")?;
    let fields = public["fields"]
        .as_array()
        .ok_or("This request has no form fields.")?;
    let content = content
        .as_ref()
        .ok_or("Complete the required form fields before continuing.")?;
    if content
        .keys()
        .any(|key| !fields.iter().any(|field| field["id"].as_str() == Some(key)))
    {
        return Err("The answer contains a field not requested by the server.");
    }
    for field in fields {
        let id = field["id"].as_str().expect("normalized id");
        let Some(value) = content.get(id) else {
            if field["required"] == true {
                return Err("Complete every required form field.");
            }
            continue;
        };
        let value = serde_json::to_value(value).map_err(|_| "The answer could not be encoded.")?;
        let kind = field["type"].as_str().expect("normalized type");
        let valid = match kind {
            "string" => value.as_str().is_some_and(|s| {
                within(
                    s.chars().count() as f64,
                    &field["minLength"],
                    &field["maxLength"],
                ) && allowed(&value, field)
                    && format_matches(s, field["format"].as_str())
            }),
            "number" | "integer" => value.as_f64().is_some_and(|n| {
                n.is_finite()
                    && (kind != "integer" || n.fract() == 0.0)
                    && within(n, &field["minimum"], &field["maximum"])
            }),
            "boolean" => value.is_boolean(),
            "array" => value.as_array().is_some_and(|values| {
                within(values.len() as f64, &field["minItems"], &field["maxItems"])
                    && values.iter().all(|v| v.is_string() && allowed(v, field))
            }),
            _ => false,
        };
        if !valid {
            return Err("An answer does not match its requested type, range or choices.");
        }
    }
    Ok(json!({"action":action,"content":content}))
}

fn within(value: f64, minimum: &Value, maximum: &Value) -> bool {
    minimum.as_f64().is_none_or(|min| value >= min)
        && maximum.as_f64().is_none_or(|max| value <= max)
}
fn allowed(value: &Value, field: &Value) -> bool {
    field["choices"]
        .as_array()
        .is_none_or(|choices| choices.iter().any(|choice| choice["value"] == *value))
}
fn format_matches(text: &str, format: Option<&str>) -> bool {
    match format {
        Some("email") => text.split_once('@').is_some_and(|(local, host)| {
            !local.is_empty() && !host.is_empty() && !text.contains(char::is_whitespace)
        }),
        Some("uri") => text.split_once(':').is_some_and(|(scheme, rest)| {
            !scheme.is_empty() && !rest.is_empty() && !text.contains(char::is_whitespace)
        }),
        // Native date formats are displayed as input hints; their string bounds
        // remain enforced here. No locale-dependent date coercion takes place.
        _ => true,
    }
}
