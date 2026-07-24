# WebSocket wire contract — frozen

This directory is the **immutable source of truth for the freshell WebSocket wire
protocol**, expressed in a language-neutral form. It is the first oracle
deliverable of the Rust/Tauri port: everything downstream — the Rust
`freshell-protocol` crate, the TypeScript server/client, and the equivalence
oracle — is measured against these files.

## Files

| File | What it is |
|------|------------|
| `ws-protocol.schema.json` | JSON Schema bundle (draft 2020-12) covering **every exported Zod schema** in `shared/ws-protocol.ts`, keyed by export name, plus `wsProtocolVersion`. This is the **inbound (client→server) runtime authority**. |
| `ws-server-messages.schema.json` | JSON Schema for **every server→client message shape** (all 52), keyed by `type` discriminant, plus `wsProtocolVersion`. Synthesized from the `ServerMessage` union via the TypeScript type checker — the **outbound shape contract** for the oracle. |
| `ws-message-inventory.json` | The **T0 conformance surface**: the `type` discriminants of every client→server and server→client message. |
| `generate-ws-contract.ts` | The generator. Reads `shared/ws-protocol.ts` and emits the three JSON files deterministically. |
| `nondeterministic-fields.md` | Enumeration of runtime-nondeterministic fields (ids, timestamps, ports, paths, blobs) — the input to the oracle's normalization layer. |

## Inbound vs outbound authority

The wire is asymmetric, and so is this contract:

- **Client→Server** messages are **Zod-validated at runtime** by the server.
  `ws-protocol.schema.json` is their frozen projection and the authority for
  what the server *accepts*.
- **Server→Client** messages are **TypeScript types only** — the client trusts
  the server and does not runtime-validate. That left the *emitted* wire without
  a machine-checkable schema. `ws-server-messages.schema.json` closes that gap:
  it is a JSON Schema for every outbound shape, derived from the same source of
  truth so the oracle can validate real emitted traffic. Zod remains the inbound
  authority; this file is the outbound **shape** contract.

## Who consumes this, and why it is shared

- **TypeScript side (today):** `shared/ws-protocol.ts` is the *authoring* source.
  These artifacts are its frozen projection — a build output, not hand-authored.
- **Rust `freshell-protocol` crate (future):** its wire types will be **generated
  from `ws-protocol.schema.json`**, so the Rust and TS ends are provably the same
  shapes. No hand-transcribed structs.
- **Equivalence oracle:** validates real captured traffic (old server *and* new
  Rust server) against these schemas, and uses `ws-message-inventory.json` as the
  checklist of message types every implementation must speak. The nondeterministic
  field list drives payload normalization before differential comparison.

## The freeze guarantee

`test/unit/port/ws-contract-freeze.test.ts` regenerates all three files
in-memory and asserts they are **byte-identical** to what is committed here (and
that the committed `wsProtocolVersion` equals `WS_PROTOCOL_VERSION`). If anyone
edits `shared/ws-protocol.ts` (or a sibling schema module) without regenerating,
that test fails. That is the "frozen contract": the wire format cannot drift
silently.

The server→client shapes carry two extra guards:

- **Full outbound coverage** — every `serverToClient` discriminant in the
  inventory must have a schema entry in `ws-server-messages.schema.json` (and no
  extra). No outbound message may go unschematized.
- **Zod cross-check** — for the 8 server→client messages that *also* have a
  runtime Zod schema (`terminal.meta.updated`, the `*.activity.*` pair, the
  `*.activity.list.response` trio, `terminal.turn.complete`), the TS-derived and
  Zod-derived schemas must agree on **required field names**. Any mismatch is
  reported, never silently reconciled.

The guards have been validated by mutation — tampering with any committed file
(a shape value, or an inventory entry that leaves an outbound message
unschematized), or changing a schema without regenerating, makes the tests fail.

## Regenerating

The contract regenerates only when the **authoring** source
(`shared/ws-protocol.ts` and its imports) legitimately changes:

```bash
npm run contract:generate      # tsx port/contract/generate-ws-contract.ts
```

Run the drift guard:

```bash
npx vitest run --config config/vitest/vitest.port.config.ts
```

## How it is generated

- **Schema bundle:** each exported Zod schema is converted with zod 4's native
  `z.toJSONSchema()` (draft 2020-12), falling back per-schema to
  `zod-to-json-schema` only if native conversion ever throws. Schemas are detected
  *structurally* (every exported `ZodType`), not by a `*Schema` name pattern, so
  first-class wire enums that break the convention — notably `ErrorCode` — are not
  dropped. As of this writing all 55 exported schemas convert natively.
- **Message inventory:** discriminants are resolved from the two canonical union
  types, `ClientMessage` and `ServerMessage`, via the **TypeScript type checker**.
  This is authoritative for both the Zod-validated client surface and the
  TypeScript-only server surface, and it fails loudly if any union member lacks a
  string-literal `type`.
- **Server→client shapes:** each member of the `ServerMessage` union (including
  the nested `FreshAgentServerMessage` union) is walked with the **TypeScript
  type checker** and synthesized into a JSON Schema. The walk handles primitives,
  string/number-literal discriminants, optionality (`k?:` → dropped from
  `required`), nested objects, arrays, and unions (literal unions → `enum`,
  object unions → `anyOf`). Imported types (`ServerSettings`,
  `ClientExtensionEntry`, `SessionLocator`, `CodexDurabilityRef`, …) resolve
  structurally, so the shapes are complete without hand-transcription. Opaque
  values are treated permissively — `unknown`/`any` → schema `true`, and a
  string index signature / `Record<…>` → `additionalProperties` = the index
  type's schema (`true` for `Record<string, unknown>`). A closed object gets
  `additionalProperties: false`. Enum member order follows the type checker's
  resolution (deterministic for a fixed toolchain), which can differ from the
  source declaration order; only the value *set* is contractually meaningful.
- **Determinism:** object keys are recursively sorted and output uses two-space
  indentation with a trailing newline. `required` is sorted; other array order
  (`anyOf`, `enum`, …) is preserved because it is semantically meaningful and
  already emitted deterministically.

## Out of scope

**Changing the wire contract is out of scope for the port.** The Rust port must
speak protocol version **7** exactly as defined here. If a wire change is ever
required, it is a separate, deliberate protocol revision (bump
`WS_PROTOCOL_VERSION`, regenerate, and review the diff) — never an incidental
side effect of porting. The bug-fix directive for the port applies to *behavior*,
not to the wire format frozen in these files.
