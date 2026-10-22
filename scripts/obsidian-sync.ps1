<#
.SYNOPSIS
  Personal AI OS — Obsidian Vault Sync Script
  Pulls approved workflow recipes from the Worker API and writes them as
  Markdown files into the configured local Obsidian vault.

.DESCRIPTION
  - Reads vault path from scripts\obsidian-vault.conf (local, gitignored)
  - Calls GET /api/v1/obsidian/workflows (auth-protected with session token)
  - Writes one .md file per approved recipe into <vault>\Workflows\
  - Never reads back from the vault; D1 remains the source of truth
  - No secrets are written to Markdown files
  - Safe to re-run: existing files are overwritten cleanly

.USAGE
  From the project root:
    .\scripts\obsidian-sync.ps1

  With a custom session token:
    .\scripts\obsidian-sync.ps1 -Token "your_session_token_here"

  With a custom API base (e.g., local dev):
    .\scripts\obsidian-sync.ps1 -ApiBase "http://localhost:8787"

.NOTES
  Your session token can be retrieved from the browser DevTools:
    Application > Cookies > __session
  Or from your .dev.vars during local dev.

  Set the PAIOS_SESSION environment variable to avoid passing -Token every run:
    $env:PAIOS_SESSION = "your_token"
#>

[CmdletBinding()]
param(
    # Session token (Bearer). Falls back to PAIOS_SESSION env var.
    [string]$Token = $env:PAIOS_SESSION,

    # API base URL. Defaults to production.
    [string]$ApiBase = "https://personal-ai-os.jatin-personal-ai.workers.dev"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ─────────────────────────────────────────────────────────────
# 1. Load vault configuration
# ─────────────────────────────────────────────────────────────
$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$confFile    = Join-Path $scriptDir "obsidian-vault.conf"

if (-not (Test-Path $confFile)) {
    Write-Error "Config not found: $confFile`nCreate it with VAULT_PATH=<path to your vault>"
    exit 1
}

$conf = @{}
Get-Content $confFile | Where-Object { $_ -match '^\s*[^#]' -and $_ -match '=' } | ForEach-Object {
    $parts = $_ -split '=', 2
    $conf[$parts[0].Trim()] = $parts[1].Trim()
}

$vaultRoot = $conf['VAULT_PATH']
$subfolder = $conf['SUBFOLDER'] ?? 'Workflows'

if (-not $vaultRoot) {
    Write-Error "VAULT_PATH is not set in $confFile"
    exit 1
}

if (-not (Test-Path $vaultRoot)) {
    Write-Error "Vault directory not found: $vaultRoot`nCheck your obsidian-vault.conf"
    exit 1
}

$workflowsDir = Join-Path $vaultRoot $subfolder

# ─────────────────────────────────────────────────────────────
# 2. Ensure Workflows subfolder exists
# ─────────────────────────────────────────────────────────────
if (-not (Test-Path $workflowsDir)) {
    New-Item -ItemType Directory -Path $workflowsDir | Out-Null
    Write-Host "Created subfolder: $workflowsDir"
}

# ─────────────────────────────────────────────────────────────
# 3. Authenticate
# ─────────────────────────────────────────────────────────────
if (-not $Token) {
    Write-Error @"
No session token found.
Provide one via:
  -Token <token>
  `$env:PAIOS_SESSION = '<token>'

To get your token: open the dashboard in a browser, open DevTools,
go to Application > Cookies and copy the value of __session.
"@
    exit 1
}

$headers = @{
    "Authorization" = "Bearer $Token"
    "Accept"        = "application/json"
}

# ─────────────────────────────────────────────────────────────
# 4. Fetch approved workflows from the API
# ─────────────────────────────────────────────────────────────
$endpoint = "$ApiBase/api/v1/obsidian/workflows"
Write-Host "`nFetching approved workflows from: $endpoint"

try {
    $response = Invoke-RestMethod -Uri $endpoint -Method GET -Headers $headers
} catch {
    $statusCode = $_.Exception.Response?.StatusCode?.value__
    if ($statusCode -eq 401) {
        Write-Error "Authentication failed (401). Your session token may be expired. Re-pair via Telegram /pair."
    } elseif ($statusCode -eq 403) {
        Write-Error "Forbidden (403). This endpoint requires owner authentication."
    } else {
        Write-Error "API request failed: $_"
    }
    exit 1
}

if (-not $response.ok) {
    Write-Error "API returned error: $($response.error | ConvertTo-Json)"
    exit 1
}

$workflows = $response.data.workflows
$count     = $response.data.count

Write-Host "Found $count approved workflow(s)."

if ($count -eq 0) {
    Write-Host "`nNothing to export. Approve at least one teach recipe first."
    Write-Host "Use: POST /api/v1/teach/approve/{id} or the dashboard Teach tab."
    exit 0
}

# ─────────────────────────────────────────────────────────────
# 5. Write each workflow as a Markdown file
# ─────────────────────────────────────────────────────────────
$written  = 0
$skipped  = 0
$errors   = 0

foreach ($note in $workflows) {
    # Guard: filename must be a simple relative path, no traversal
    $filename = $note.filename
    if ($filename -match '\.\.' -or $filename -match '[/\\]') {
        Write-Warning "Skipped unsafe filename: $filename"
        $skipped++
        continue
    }

    $filePath = Join-Path $workflowsDir $filename

    try {
        # Write with UTF-8 BOM for Obsidian compatibility on Windows
        [System.IO.File]::WriteAllText($filePath, $note.markdown, [System.Text.UTF8Encoding]::new($true))
        Write-Host "  Wrote: $filename  (recipe: $($note.recipeId))"
        $written++
    } catch {
        Write-Warning "  Failed to write $filename`: $_"
        $errors++
    }
}

# ─────────────────────────────────────────────────────────────
# 6. Summary
# ─────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "─────────────────────────────────────────────"
Write-Host "Obsidian Sync Complete"
Write-Host "  Vault   : $vaultRoot"
Write-Host "  Folder  : $workflowsDir"
Write-Host "  Written : $written"
if ($skipped -gt 0) { Write-Host "  Skipped : $skipped (unsafe filenames)" }
if ($errors  -gt 0) { Write-Host "  Errors  : $errors" }
Write-Host "─────────────────────────────────────────────"
Write-Host ""
Write-Host "D1 is the source of truth. These files are a human-readable mirror only."
Write-Host "To update, re-run this script after approving new recipes."

if ($errors -gt 0) { exit 1 }
