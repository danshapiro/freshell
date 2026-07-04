# WebSocket wire contract — frozen

This directory is the **immutable source of truth for the freshell WebSocket wire
protocol**, expressed in a language-neutral form. It is the first oracle
deliverable of the Rust/Tauri port: everything downstream — the Rust
`freshell-protocol` crate, the TypeScript server/client, and the equivalence
oracle — is measured against these files.

## Files

| File | What it is |
|------|------------|
| `ws-protocol.schema.json` | JSON Schema bundle (draft 2020-12) covering **every exported Zod schema** in `shared/ws-protocol.ts`, keyed by export name, plus `wsProtocolVersion`. |
| `ws-message-inventory.json` | The **T0 conformance surface**: the `type` discriminants of every client→server and server→client message. |
| `generate-ws-contract.ts` | The generator. Reads `shared/ws-protocol.ts` and emits the two JSON files deterministically. |
| `nondeterministic-fields.md` | Enumeration of runtime-nondeterministic fields (ids, timestamps, ports, paths, blobs) — the input to the oracle's normalization layer. |

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

`test/unit/port/ws-contract-freeze.test.ts` regenerates both files in-memory and
asserts they are **byte-identical** to what is committed here (and that the
committed `wsProtocolVersion` equals `WS_PROTOCOL_VERSION`). If anyone edits
`shared/ws-protocol.ts` (or a sibling schema module) without regenerating, that
test fails. That is the "frozen contract": the wire format cannot drift silently.

The guard has been validated by mutation — tampering with either committed file,
or changing a schema without regenerating, makes the test fail.

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
- **Determinism:** object keys are recursively sorted and output uses two-space
  indentation with a trailing newline. Array order (`oneOf`, `enum`, `required`,
  …) is preserved because it is semantically meaningful and already emitted
  deterministically.

## Out of scope

**Changing the wire contract is out of scope for the port.** The Rust port must
speak protocol version **7** exactly as defined here. If a wire change is ever
required, it is a separate, deliberate protocol revision (bump
`WS_PROTOCOL_VERSION`, regenerate, and review the diff) — never an incidental
side effect of porting. The bug-fix directive for the port applies to *behavior*,
not to the wire format frozen in these files.
