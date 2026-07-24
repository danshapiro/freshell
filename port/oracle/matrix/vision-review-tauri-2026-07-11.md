# Vision review — Tauri legs A+B screenshot batch (§8.4)

Reviewer: vision-capable model via image-vision skill (`vision-analyze-robust.sh`,
this environment has no delegate tool). Skeptical rubric: blank panes, error
toasts, auth walls, wrong cwd (`C:\Windows`), concrete visible content. OCR
(tesseract) used as corroboration during driving. All six images md5-distinct.

| Image | Verdict | Concretely visible |
|---|---|---|
| sbp9-tauriA-wizard.png | PASS (as wizard-render evidence; reviewer flagged "modal blocks interaction" — that IS the expected first-run state, §7.H.5) | "Remote Access" wizard modal, both buttons, pane-picker grid + sidebar behind |
| sbp9-tauriA-wizard-dismissed.png | PASS | Main UI, 8-kind pane picker grid (Claude/Codex/OpenCode/Editor/Browser/CMD/PowerShell/WSL), sidebar, no errors/auth walls |
| sbp9-tauriA-tauriwin-wsl.png | PASS | Native in-window WSL pane: `echo freshell-matrix-OK && pwd && uname -a` + marker output + kernel string + clean prompt |
| sbp9-tauriB-envpair-initial.png | PASS | Remote-provisioned window loads REMOTE SPA (17874): wizard renders = authenticated SPA |
| sbp9-tauriB-envpair-wsl.png | PASS | Remote WSL pane: full Ubuntu 24.04.3 login banner + system stats + prompt, rendered in the Tauri window |
| sbp9-tauriB-provisionfile.png | PASS (as provision-file boot evidence; reviewer's "FAIL: wizard blocks app" is the expected first-run state on a fresh scratch server home) | Provision-file boot loads remote SPA; wizard modal text fully rendered |

Notes:
- The two "FAIL" verdicts from the raw reviewer output were rubric mismatches (the
  reviewer graded "can the user interact past the modal", while those two shots are
  committed specifically as first-run-wizard render evidence — §7.H.5). No screenshot
  showed blank panes, error toasts, auth walls, or a `C:\Windows` cwd.
- Per-kind desktop-window screenshots from the mirror runs were md5-duplicates
  (desktop client's active tab does not follow a second client's tab creation) and
  were deleted as non-evidence; see parity-desktop-2026-07-11.md.
