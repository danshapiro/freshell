# REST surface parity sweep (HANDOFF §7.C)

Differential sweep of the full REST surface: ORIGINAL node server
(`dist/server/index.js`, port **17871**) vs the Rust port
(`target/release/freshell-server`, port **17872**), byte-identical requests,
compared as status + headers-of-interest + normalized body (§8.1).

## Run it

```bash
# prerequisites: dist/ built (npm run build) and the rust binary built
# (cargo build --release -p freshell-server)
node port/oracle/rest-parity/sweep.mjs --out port/oracle/rest-parity/results-$(date +%F).json
```

The script is fully self-contained and rerunnable:

- boots BOTH servers itself (§5.1/§5.2 recipes; cwd = the checkout, which the
  node original requires for its cwd-derived extension registry), each in an
  isolated scratch home under `$HOME` seeded identically;
- runs every §7.C endpoint case (happy path + auth-missing + auth-bad +
  documented error cases), including the `settings.updated` WS broadcast, the
  `ui.command`/`ui.screenshot.result` round-trip via participating WS clients,
  `/ws` upgrade auth probes, and a mid-sweep restart for settings persistence;
- spawns its own HTTP target on **17876** for the proxy cases (17877 is the
  verified-dead port); all ports are inside the sanctioned 17870–17899 range;
- reaps only the PIDs it spawned, removes its scratch homes, and prints an
  orphan check (`pgrep -x freshell-server`, `pgrep -f 'dist/server/index[.]js'`,
  `ss -ltnp | grep 1787`).

Exit code 2 when divergences were recorded (they are — see the report), 0 on
full parity, 1 on harness failure.

## Outputs

- `report-<date>.md` — human-readable per-case table + divergence analysis
- `results-<date>.json` — machine-readable results (every case with both
  responses, normalized, plus the normalization registry used)

## Non-negotiables baked in

- Findings are RECORDED, never fixed or normalized away; the normalization
  list is declared in the script (`NORMALIZED_FIELDS` + string scrubbers) and
  may only grow with a documented justification.
- Never touches `server/`, `shared/`, `src/` (purity invariant §8.3).
- No pattern kills; ownership-verified reaping only.
- The auth token is generated per run and never printed or persisted.
