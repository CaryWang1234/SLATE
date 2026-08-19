$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$hookSource = Join-Path $repoRoot ".githooks\pre-commit"
$hookTarget = Join-Path $repoRoot ".git\hooks\pre-commit"

if (!(Test-Path $hookSource)) {
  throw "Hook source not found: $hookSource"
}

if (!(Test-Path (Split-Path $hookTarget))) {
  throw "Git hooks directory not found. Run this from an initialized Git checkout."
}

Copy-Item -LiteralPath $hookSource -Destination $hookTarget -Force
Write-Host "[SLATE] Installed pre-commit hook: $hookTarget"
Write-Host "[SLATE] It will run: node scripts/check_frontend_integrity.mjs"
