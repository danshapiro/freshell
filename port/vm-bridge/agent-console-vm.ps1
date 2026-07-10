# agent-console-vm.ps1 -- file-driven PowerShell bridge for a write-sandboxed Amplifier agent.
#
# WHY THIS EXISTS: the 2026-07-08 agent session runs on the TauriDebugVM (Windows),
# where the amplifier `bash` tool is dead (System32 bash.exe = WSL launcher, no distro
# installed) and the agent may only WRITE inside this worktree, so it cannot reach
# C:\Scripts\console-inbox. This watcher is the same pattern as C:\Scripts\console-host.ps1
# but watches a folder INSIDE the worktree, which the agent can write to.
#
# START (on the TauriDebugVM):
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\TauriVmShares\rust-tauri-port\port\vm-bridge\agent-console-vm.ps1
# STOP: Ctrl-C / close the window. Stop it whenever the agent session is over.
#
# SECURITY NOTE: this executes arbitrary PowerShell dropped into inbox-vm/.
# Run it only while deliberately supervising an agent session on this repo.
#
# Protocol:
#   request : inbox-vm/<id>.cmd   (plain text, executed with Invoke-Expression)
#   response: outbox-vm/<id>.out  (echoed command, merged output, ---RC=n--- trailer)
#   liveness: alive-vm.txt        (ISO timestamp, rewritten every loop)

$ErrorActionPreference = 'Continue'
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$inbox = Join-Path $base 'inbox-vm'
$outbox = Join-Path $base 'outbox-vm'
New-Item -ItemType Directory -Force -Path $inbox, $outbox | Out-Null
# SECURITY (F1, 2026-07-10 review): NEVER execute inbox files that predate this
# watcher (they could have arrived via git or an earlier session). Quarantine
# them un-executed; a human may inspect and re-drop them deliberately.
$stale = @(Get-ChildItem $inbox -File -ErrorAction SilentlyContinue)
if ($stale.Count -gt 0) {
    $qdir = Join-Path $base ("quarantine-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Force -Path $qdir | Out-Null
    $stale | Move-Item -Destination $qdir -Force
    Write-Host "agent-console-vm: quarantined $($stale.Count) pre-existing inbox file(s) to $qdir (NOT executed)" -ForegroundColor Red
}
Write-Host "agent-console-vm: watching $inbox (Ctrl-C to stop)" -ForegroundColor Cyan
while ($true) {
    Get-Date -Format o | Set-Content -Path (Join-Path $base 'alive-vm.txt') -Encoding ASCII
    Get-ChildItem $inbox -Filter '*.cmd' -ErrorAction SilentlyContinue | Sort-Object Name | ForEach-Object {
        $id = $_.BaseName
        $cmd = (Get-Content $_.FullName -Raw)
        Remove-Item $_.FullName -Force
        Write-Host ("PS {0}> {1}" -f (Get-Location), $cmd) -ForegroundColor Yellow
        $global:LASTEXITCODE = 0
        $output = try { (Invoke-Expression $cmd) 2>&1 | Out-String } catch { $_ | Out-String }
        $rc = $global:LASTEXITCODE
        $body = "PS> " + $cmd.Trim() + "`r`n" + $output + "`r`n---RC=$rc---"
        Set-Content -Path (Join-Path $outbox "$id.out") -Value $body -Encoding UTF8
    }
    Start-Sleep -Milliseconds 700
}
