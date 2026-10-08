<#
.SYNOPSIS
  Downloads the latest Windows development build of the PokeVerse Discord bot from
  GitHub Actions and installs (or updates) it.

.DESCRIPTION
  GitHub requires a token to download Actions artifacts, even for public repositories.
  Create a fine-grained personal access token with read access to "Actions" for the
  repository, or a classic token with the "repo" scope (private) / no scope (public).
  The token is only used for this download and is not saved.

  Your .env.development, data\ and logs\ folders are never overwritten.
#>
param(
  [string]$Repository = "GIToez/PokeVerse-Discord",
  [string]$Branch = "",
  [string]$Destination = "",
  [string]$Token = $env:GITHUB_TOKEN,
  [string]$ArtifactName = "PokeVerse-Discord-Dev-Windows",
  [switch]$NoConfigure
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Fail([string]$message) {
  Write-Host ""
  Write-Host "ERROR: $message" -ForegroundColor Red
  exit 1
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Destination) {
  # Inside an installed package: update it in place. Otherwise install next to this script.
  $Destination = if (Test-Path (Join-Path $here "bot\bot.cjs")) { $here } else { Join-Path $here "pokeverse-discord-dev" }
}

if (-not $Token) {
  Write-Host "A GitHub token is needed to download Actions artifacts (read access to Actions)." -ForegroundColor Cyan
  $secure = Read-Host "GitHub token" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $Token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
if (-not $Token) { Fail "No GitHub token given." }

$headers = @{
  Authorization          = "Bearer $Token"
  Accept                 = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent"           = "pokeverse-discord-downloader"
}

Write-Host "Looking for the latest '$ArtifactName' build in $Repository..." -ForegroundColor Cyan
try {
  $list = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$Repository/actions/artifacts?name=$ArtifactName&per_page=50"
} catch {
  Fail "GitHub API request failed: $($_.Exception.Message). Check the token and its permissions."
}
$artifacts = @($list.artifacts | Where-Object { -not $_.expired })
if ($Branch) { $artifacts = @($artifacts | Where-Object { $_.workflow_run.head_branch -eq $Branch }) }
$artifact = $artifacts | Sort-Object -Property created_at -Descending | Select-Object -First 1
if (-not $artifact) { Fail "No build found$(if ($Branch) { " for branch $Branch" }). Check that the CI workflow ran successfully." }
Write-Host "Found build from $($artifact.created_at) (branch $($artifact.workflow_run.head_branch), commit $($artifact.workflow_run.head_sha.Substring(0,7)))."

$temp = Join-Path ([IO.Path]::GetTempPath()) ("pokeverse-discord-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  $zip = Join-Path $temp "artifact.zip"
  Write-Host "Downloading ($([Math]::Round($artifact.size_in_bytes / 1MB, 1)) MB)..."
  Invoke-WebRequest -Headers $headers -Uri $artifact.archive_download_url -OutFile $zip
  $extract = Join-Path $temp "files"
  Expand-Archive -Path $zip -DestinationPath $extract
  $root = $extract
  if (-not (Test-Path (Join-Path $root "bot\bot.cjs"))) {
    $inner = Get-ChildItem -Path $extract -Directory | Where-Object { Test-Path (Join-Path $_.FullName "bot\bot.cjs") } | Select-Object -First 1
    if (-not $inner) { Fail "The downloaded build does not contain bot\bot.cjs." }
    $root = $inner.FullName
  }
  foreach ($forbidden in @(".env.development", ".env.production", ".env")) {
    if (Test-Path (Join-Path $root $forbidden)) { Fail "The download contains $forbidden; refusing to install it." }
  }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Copy-Item -Path (Join-Path $root "*") -Destination $Destination -Recurse -Force
  Get-ChildItem -Path $root -Force -Filter ".env*.example" | Copy-Item -Destination $Destination -Force
  Write-Host "Installed to $Destination" -ForegroundColor Green
} finally {
  Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
}

if (-not $NoConfigure -and -not (Test-Path (Join-Path $Destination ".env.development"))) {
  Write-Host ""
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Destination "configure-discord-dev.ps1")
  if ($LASTEXITCODE -ne 0) { Fail "Configuration did not finish." }
}

Write-Host ""
Write-Host "Start the bot with: $(Join-Path $Destination 'start-discord-dev.bat')" -ForegroundColor Green
exit 0
