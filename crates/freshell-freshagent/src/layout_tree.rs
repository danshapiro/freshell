//! Server-side pane layout tree (pure model).
//!
//! Port of the pane-node shape `server/agent-api/layout-schema.ts:28-78` accepts
//! and the tree walkers `server/agent-api/layout-store.ts:219-315` implement
//! (collectLeaves / findParentSplitId / findSplitById / findAndReplace-style
//! mutation). Parsing is TOLERANT like the Node side's runtime walkers: an
//! unknown shape yields `None` rather than an error.

use serde_json::{json, Map, Value};

/// A pane layout node: binary tree of `split`s over `leaf` panes
/// (`layout-schema.ts:28-78`).
#[derive(Clone, Debug, PartialEq)]
pub enum PaneNode {
    /// `{ type: 'leaf', id, content }` — `content` is the opaque pane-content
    /// snapshot (terminal/browser/editor/fresh-agent/extension/…).
    Leaf { id: String, content: Value },
    /// `{ type: 'split', id, direction, sizes: [a, b], children: [l, r] }`.
    Split {
        id: String,
        direction: String,
        sizes: [f64; 2],
        children: Box<[PaneNode; 2]>,
    },
}

impl PaneNode {
    /// Tolerant parse: anything that is not a well-formed leaf/split -> `None`
    /// (the Node walkers simply skip such nodes).
    pub fn parse(v: &Value) -> Option<PaneNode> {
        let obj = v.as_object()?;
        match obj.get("type").and_then(Value::as_str)? {
            "leaf" => Some(PaneNode::Leaf {
                id: obj.get("id").and_then(Value::as_str)?.to_string(),
                content: obj.get("content").cloned().unwrap_or(Value::Null),
            }),
            "split" => {
                let sizes_raw = obj.get("sizes").and_then(Value::as_array)?;
                if sizes_raw.len() != 2 {
                    return None;
                }
                let first = sizes_raw[0].as_f64().filter(|n| n.is_finite())?;
                let second = sizes_raw[1].as_f64().filter(|n| n.is_finite())?;
                let children_raw = obj.get("children").and_then(Value::as_array)?;
                if children_raw.len() != 2 {
                    return None;
                }
                let left = PaneNode::parse(&children_raw[0])?;
                let right = PaneNode::parse(&children_raw[1])?;
                Some(PaneNode::Split {
                    id: obj.get("id").and_then(Value::as_str)?.to_string(),
                    direction: obj.get("direction").and_then(Value::as_str)?.to_string(),
                    sizes: [first, second],
                    children: Box::new([left, right]),
                })
            }
            _ => None,
        }
    }

    /// Serialize back to the exact Node JSON shape. Integral sizes are emitted
    /// as JSON integers (what `JSON.stringify` produces for `50`).
    pub fn to_value(&self) -> Value {
        match self {
            PaneNode::Leaf { id, content } => json!({
                "type": "leaf",
                "id": id,
                "content": content,
            }),
            PaneNode::Split {
                id,
                direction,
                sizes,
                children,
            } => {
                let mut map = Map::new();
                map.insert("type".to_string(), json!("split"));
                map.insert("id".to_string(), json!(id));
                map.insert("direction".to_string(), json!(direction));
                map.insert(
                    "sizes".to_string(),
                    Value::Array(sizes.iter().map(|s| number_value(*s)).collect()),
                );
                map.insert(
                    "children".to_string(),
                    Value::Array(vec![children[0].to_value(), children[1].to_value()]),
                );
                Value::Object(map)
            }
        }
    }

    /// Depth-first, left-to-right leaf collection (`layout-store.ts:219-230`).
    /// The resulting order IS the Node-side leaf `index`.
    pub fn collect_leaves<'a>(&'a self, out: &mut Vec<&'a PaneNode>) {
        match self {
            PaneNode::Leaf { .. } => out.push(self),
            PaneNode::Split { children, .. } => {
                children[0].collect_leaves(out);
                children[1].collect_leaves(out);
            }
        }
    }

    /// Find the leaf with `pane_id` anywhere in this subtree.
    pub fn find_leaf(&self, pane_id: &str) -> Option<&PaneNode> {
        match self {
            PaneNode::Leaf { id, .. } => (id == pane_id).then_some(self),
            PaneNode::Split { children, .. } => children[0]
                .find_leaf(pane_id)
                .or_else(|| children[1].find_leaf(pane_id)),
        }
    }

    /// Find the split with `split_id` anywhere in this subtree
    /// (`findSplitById`, `layout-store.ts:241-245`).
    pub fn find_split(&self, split_id: &str) -> Option<&PaneNode> {
        match self {
            PaneNode::Leaf { .. } => None,
            PaneNode::Split { id, children, .. } => {
                if id == split_id {
                    return Some(self);
                }
                children[0]
                    .find_split(split_id)
                    .or_else(|| children[1].find_split(split_id))
            }
        }
    }

    /// The id of the split whose DIRECT child is the leaf `pane_id`
    /// (`findParentSplitId`, `layout-store.ts:232-239`).
    pub fn find_parent_split_id(&self, pane_id: &str) -> Option<String> {
        match self {
            PaneNode::Leaf { .. } => None,
            PaneNode::Split { id, children, .. } => {
                let direct = children
                    .iter()
                    .any(|child| matches!(child, PaneNode::Leaf { id, .. } if id == pane_id));
                if direct {
                    return Some(id.clone());
                }
                children[0]
                    .find_parent_split_id(pane_id)
                    .or_else(|| children[1].find_parent_split_id(pane_id))
            }
        }
    }

    /// Replace the content of the leaf `pane_id`; `false` when absent
    /// (`attachPaneContent`'s recursive update, `layout-store.ts:684-690`).
    pub fn replace_leaf_content(&mut self, pane_id: &str, content: Value) -> bool {
        match self {
            PaneNode::Leaf { id, content: slot } => {
                if id == pane_id {
                    *slot = content;
                    true
                } else {
                    false
                }
            }
            PaneNode::Split { children, .. } => {
                if children[0].replace_leaf_content(pane_id, content.clone()) {
                    return true;
                }
                children[1].replace_leaf_content(pane_id, content)
            }
        }
    }

    /// Set the sizes of the split `split_id`; `false` when absent
    /// (`resizePane`'s recursive update, `layout-store.ts:670-676`).
    pub fn set_split_sizes(&mut self, split_id: &str, sizes: [f64; 2]) -> bool {
        match self {
            PaneNode::Leaf { .. } => false,
            PaneNode::Split {
                id,
                sizes: slot,
                children,
                ..
            } => {
                if id == split_id {
                    *slot = sizes;
                    return true;
                }
                if children[0].set_split_sizes(split_id, sizes) {
                    return true;
                }
                children[1].set_split_sizes(split_id, sizes)
            }
        }
    }
}

/// `findAndReplace` (`layout-store.ts:299-315`): replace the node with
/// `target_id` (leaf OR split) by `replacement`.
pub(crate) fn replace_node(node: &mut PaneNode, target_id: &str, replacement: &PaneNode) -> bool {
    let id = match node {
        PaneNode::Leaf { id, .. } => id,
        PaneNode::Split { id, .. } => id,
    };
    if id == target_id {
        *node = replacement.clone();
        return true;
    }
    if let PaneNode::Split { children, .. } = node {
        if replace_node(&mut children[0], target_id, replacement) {
            return true;
        }
        return replace_node(&mut children[1], target_id, replacement);
    }
    false
}

fn split50(direction: &str, left: PaneNode, right: PaneNode) -> PaneNode {
    PaneNode::Split {
        id: uuid::Uuid::new_v4().to_string(),
        direction: direction.to_string(),
        sizes: [50.0, 50.0],
        children: Box::new([left, right]),
    }
}

/// `buildHorizontalRow` (`layout-store.ts:253-274`).
fn build_horizontal_row(mut leaves: Vec<PaneNode>) -> PaneNode {
    if leaves.len() == 1 {
        return leaves.pop().expect("len checked");
    }
    if leaves.len() == 2 {
        let right = leaves.pop().expect("len checked");
        let left = leaves.pop().expect("len checked");
        return split50("horizontal", left, right);
    }
    let mid = leaves.len().div_ceil(2);
    let right = leaves.split_off(mid);
    split50(
        "horizontal",
        build_horizontal_row(leaves),
        build_horizontal_row(right),
    )
}

/// `buildGridLayout` (`layout-store.ts:276-297`). Callers guarantee
/// `leaves` is non-empty.
pub(crate) fn build_grid_layout(mut leaves: Vec<PaneNode>) -> PaneNode {
    if leaves.len() == 1 {
        return leaves.pop().expect("len checked");
    }
    if leaves.len() == 2 {
        let right = leaves.pop().expect("len checked");
        let left = leaves.pop().expect("len checked");
        return split50("horizontal", left, right);
    }
    let top_count = leaves.len().div_ceil(2);
    let bottom = leaves.split_off(top_count);
    split50(
        "vertical",
        build_horizontal_row(leaves),
        build_horizontal_row(bottom),
    )
}

/// `JSON.stringify(50)` is `50`, not `50.0` — emit integral floats as integers.
fn number_value(n: f64) -> Value {
    if n.fract() == 0.0 && n.is_finite() && n.abs() <= i64::MAX as f64 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn leaf(id: &str, content: serde_json::Value) -> serde_json::Value {
        json!({ "type": "leaf", "id": id, "content": content })
    }

    fn three_pane_tree() -> PaneNode {
        // s1( p1, s2( p2, p3 ) )
        let v = json!({
            "type": "split",
            "id": "s1",
            "direction": "horizontal",
            "sizes": [50, 50],
            "children": [
                leaf("p1", json!({ "kind": "terminal", "terminalId": "term-1" })),
                {
                    "type": "split",
                    "id": "s2",
                    "direction": "vertical",
                    "sizes": [30, 70],
                    "children": [
                        leaf("p2", json!({ "kind": "picker" })),
                        leaf("p3", json!({ "kind": "browser", "url": "https://example.com", "devToolsOpen": false })),
                    ],
                },
            ],
        });
        PaneNode::parse(&v).expect("three-pane tree parses")
    }

    #[test]
    fn parse_and_reserialize_leaf_and_split_roundtrip() {
        let leaf_json = leaf("p1", json!({ "kind": "terminal", "terminalId": "term-1" }));
        let parsed = PaneNode::parse(&leaf_json).expect("leaf parses");
        assert_eq!(parsed.to_value(), leaf_json, "leaf round-trips exactly");

        let split_json = json!({
            "type": "split",
            "id": "s1",
            "direction": "horizontal",
            "sizes": [30, 70],
            "children": [
                leaf("p1", json!({ "kind": "terminal" })),
                leaf("p2", json!({ "kind": "browser", "url": "https://example.com", "devToolsOpen": false })),
            ],
        });
        let parsed = PaneNode::parse(&split_json).expect("split parses");
        assert_eq!(parsed.to_value(), split_json, "split round-trips exactly");

        // Tolerant parsing: unknown shapes -> None.
        assert!(PaneNode::parse(&json!({ "type": "grid", "id": "x" })).is_none());
        assert!(PaneNode::parse(&json!("nope")).is_none());
        assert!(PaneNode::parse(&json!(null)).is_none());
        assert!(
            PaneNode::parse(&json!({
                "type": "split",
                "id": "s",
                "direction": "horizontal",
                "sizes": [50, 50],
                "children": [leaf("a", json!({}))],
            }))
            .is_none(),
            "split with one child is not a valid binary split"
        );
    }

    #[test]
    fn collect_leaves_is_depth_first_left_to_right() {
        let tree = three_pane_tree();
        let mut leaves = Vec::new();
        tree.collect_leaves(&mut leaves);
        let ids: Vec<&str> = leaves
            .iter()
            .map(|node| match node {
                PaneNode::Leaf { id, .. } => id.as_str(),
                PaneNode::Split { .. } => panic!("collect_leaves must only yield leaves"),
            })
            .collect();
        assert_eq!(
            ids,
            vec!["p1", "p2", "p3"],
            "depth-first order == Node leaf `index`"
        );

        assert!(matches!(tree.find_leaf("p3"), Some(PaneNode::Leaf { id, .. }) if id == "p3"));
        assert!(
            tree.find_leaf("s2").is_none(),
            "find_leaf never returns splits"
        );
        assert!(tree.find_leaf("missing").is_none());
    }

    #[test]
    fn find_parent_split_and_set_sizes() {
        let mut tree = three_pane_tree();

        assert_eq!(tree.find_parent_split_id("p1").as_deref(), Some("s1"));
        assert_eq!(tree.find_parent_split_id("p3").as_deref(), Some("s2"));
        assert_eq!(tree.find_parent_split_id("missing"), None);

        assert!(matches!(
            tree.find_split("s2"),
            Some(PaneNode::Split { id, .. }) if id == "s2"
        ));
        assert!(
            tree.find_split("p1").is_none(),
            "find_split never returns leaves"
        );

        assert!(tree.set_split_sizes("s2", [25.0, 75.0]));
        assert!(!tree.set_split_sizes("missing", [10.0, 90.0]));
        match tree.find_split("s2") {
            Some(PaneNode::Split { sizes, .. }) => assert_eq!(*sizes, [25.0, 75.0]),
            other => panic!("expected updated split, got {other:?}"),
        }
        // Integral sizes re-serialize as integers (Node JSON shape).
        assert_eq!(
            tree.find_split("s2").unwrap().to_value()["sizes"],
            json!([25, 75])
        );

        assert!(
            tree.replace_leaf_content("p2", json!({ "kind": "editor", "filePath": "/tmp/x.md" }))
        );
        assert!(!tree.replace_leaf_content("missing", json!({})));
        match tree.find_leaf("p2") {
            Some(PaneNode::Leaf { content, .. }) => {
                assert_eq!(content["kind"], json!("editor"));
            }
            other => panic!("expected replaced leaf, got {other:?}"),
        }
    }
}
