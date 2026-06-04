// The source-mode real-worker integration tests spawn a worker that loads the
// `.ts` query module via Node's native TypeScript type-stripping. Whether that is
// active depends on the Node version AND flags (default on v22.18+ and v23.6+, but
// NOT v23.0–23.5, and off on v22.5–22.17). Rather than encode that version matrix
// (easy to get wrong), probe the actual capability: `process.features.typescript`
// reports the active mode ("strip"/"transform") when type-stripping is enabled and
// `false`/`undefined` otherwise. The spawned worker shares this process's Node
// binary and flags, so this exactly predicts whether it can load the `.ts` module.
//
// When unavailable we skip ONLY these source-mode `.ts` spawn tests — the product
// still works there (prod runs the COMPILED `.js` worker, dev runs under tsx).
// Worker spawn is additionally proven on EVERY supported Node by the unguarded
// compiled-worker test (opencode-listing-compiled-worker.test.ts), and orchestration
// by the fake-spawn unit tests.
export function supportsNativeTsWorker(): boolean {
  // `process.features.typescript` may not be in the installed @types/node yet.
  return Boolean((process.features as { typescript?: unknown }).typescript)
}
