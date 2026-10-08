<#
.SYNOPSIS
  One-time configuration of the PokeVerse Discord bot (DEVELOPMENT profile).

.DESCRIPTION
  Writes .env.development next to this script and the bridge settings into the local
  game server's config.local.lua, using one randomly generated shared secret.
  Existing values are kept unless you type new ones. Nothing is sent anywhere.

  Non-interactive use (CI, scripting): pass -NonInteractive and the values as parameters.
  The token can also come from the POKEVERSE_DISCORD_TOKEN environment variable.
#>
param(
  [string]$Token = $env:POKEVERSE_DISCORD_TOKEN,
  [string]$ApplicationId,
  [string]$GuildId,
  [string]$ProductionGuildId,
  [string]$AdminUserId,
  [string]$GameDir,
  [switch]$NonInteractive,
  [switch]$SkipBridgeCheck
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $here ".env.development"
$example = Join-Path $here ".env.development.example"
$node = Join-Path $here "node\node.exe"
$bot = Join-Path $here "bot\bot.cjs"
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Fail([string]$message) {
  Write-Host ""
  Write-Host "ERROR: $message" -ForegroundColor Red
  exit 1
}

function Read-EnvFile([string]$path) {
  $values = @{}
  if (Test-Path $path) {
    foreach ($line in [System.IO.File]::ReadAllLines($path)) {
      if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
        $values[$Matches[1]] = $Matches[2].Trim()
      }
    }
  }
  return $values
}

function Ask([string]$label, [string]$current, [string]$pattern, [string]$help, [switch]$Optional) {
  if ($NonInteractive) { return $current }
  if ($help) { Write-Host $help -ForegroundColor DarkGray }
  while ($true) {
    $suffix = if ($current) { " [$current]" } elseif ($Optional) { " (optional, Enter to skip)" } else { "" }
    $value = (Read-Host "$label$suffix").Trim()
    if ($value -eq "") { $value = $current }
    if ($value -eq "" -and $Optional) { return "" }
    if ($value -match $pattern) { return $value }
    Write-Host "  That does not look right. Please try again." -ForegroundColor Yellow
  }
}

function Ask-Secret([string]$label, [string]$current, [string]$help) {
  if ($NonInteractive) { return $current }
  Write-Host $help -ForegroundColor DarkGray
  while ($true) {
    $hint = if ($current) { " [press Enter to keep the current token]" } else { "" }
    $secure = Read-Host "$label$hint" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    if ($value -eq "") { $value = $current }
    if ($value -match '^[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{20,}$') { return $value }
    Write-Host "  That is not a bot token (Developer Portal > Bot > Reset Token)." -ForegroundColor Yellow
  }
}

function New-Secret {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

function Find-GameServer([string]$hint) {
  $candidates = @()
  $roots = @()
  if ($hint) { $roots += $hint }
  if ($env:POKEVERSE_GAME_DIR) { $roots += $env:POKEVERSE_GAME_DIR }
  $roots += @(Get-ChildItem -Path (Split-Path -Parent $here) -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
  foreach ($root in $roots) {
    $candidates += $root
    $candidates += (Join-Path $root "server-windows")
    $candidates += (Join-Path $root "server")
  }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path (Join-Path $candidate "config.lua"))) {
      return (Resolve-Path $candidate).Path
    }
  }
  return $null
}

function Set-LuaLocalConfig([string]$serverDir, [string]$secret, [string]$port) {
  $file = Join-Path $serverDir "config.local.lua"
  $kept = @()
  if (Test-Path $file) {
    $kept = @([System.IO.File]::ReadAllLines($file) | Where-Object {
      $_ -notmatch '^\s*discordBridge(Enabled|Secret|Port|Host)\s*=' -and $_ -notmatch '^-- PokeVerse Discord bot \(written by configure-discord-dev\)'
    })
  }
  $lines = $kept + @(
    "-- PokeVerse Discord bot (written by configure-discord-dev)",
    "discordBridgeEnabled = true",
    "discordBridgeHost = `"127.0.0.1`"",
    "discordBridgePort = $port",
    "discordBridgeSecret = `"$secret`""
  )
  [System.IO.File]::WriteAllText($file, (($lines -join "`r`n") + "`r`n"), (New-Object System.Text.ASCIIEncoding))
  return $file
}

function Protect-File([string]$path) {
  try {
    & icacls.exe $path /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
  } catch {
    Write-Host "  (Could not restrict file permissions on $path)" -ForegroundColor DarkGray
  }
}

if (-not (Test-Path $node) -or -not (Test-Path $bot)) { Fail "Run this script from the extracted bot package (node\node.exe and bot\bot.cjs are missing)." }
if (-not (Test-Path $example)) { Fail ".env.development.example is missing from the package." }

Write-Host ""
Write-Host "PokeVerse Discord bot - development configuration" -ForegroundColor Cyan
Write-Host "Use your DEVELOPMENT bot application and DEVELOPMENT Discord server, never production."
Write-Host ""

$existing = Read-EnvFile $envFile
$current = Read-EnvFile $example
foreach ($key in $existing.Keys) { $current[$key] = $existing[$key] }
if ($current["DISCORD_TOKEN"] -like "paste-*") { $current["DISCORD_TOKEN"] = "" }

$token = if ($Token) { $Token } else { $current["DISCORD_TOKEN"] }
$token = Ask-Secret "Development bot token" $token "Developer Portal > your dev application > Bot > Reset Token, then copy it."
if (-not $token) { Fail "A bot token is required." }

$appId = if ($ApplicationId) { $ApplicationId } else { $current["DISCORD_APPLICATION_ID"] }
$appId = Ask "Application ID" $appId '^\d{17,20}$' "Developer Portal > General Information > Application ID." -Optional

$guild = if ($GuildId) { $GuildId } else { $current["DISCORD_GUILD_ID"] }
$guild = Ask "Development server (guild) ID" $guild '^\d{17,20}$' "Discord: User Settings > Advanced > Developer Mode on, then right-click your dev server > Copy Server ID."
if (-not $guild) { Fail "DISCORD_GUILD_ID is required." }

$prodGuild = if ($ProductionGuildId) { $ProductionGuildId } else { $current["PRODUCTION_GUILD_ID"] }
$prodGuild = Ask "Production server ID (safety check, the dev bot refuses to run there)" $prodGuild '^\d{17,20}$' "" -Optional
if ($prodGuild -and $prodGuild -eq $guild) { Fail "The development server ID must not be the production server ID." }

$admin = if ($AdminUserId) { $AdminUserId } else { $current["DISCORD_ADMIN_USER_IDS"] }
$admin = Ask "Your Discord user ID for /pokeverse admin commands" $admin '^\d{17,20}(,\d{17,20})*$' "Right-click your name > Copy User ID. Leave empty to allow anyone with Manage Server." -Optional

$serverDir = Find-GameServer $GameDir
if (-not $serverDir -and -not $NonInteractive) {
  $typed = Ask "Game server folder (contains config.lua, e.g. C:\PokeVerse-Windows-Dev\server-windows)" "" '.+' "" -Optional
  if ($typed) { $serverDir = Find-GameServer $typed }
}

$secret = $current["BRIDGE_SECRET"]
if (-not $secret -or $secret.Length -lt 16) { $secret = New-Secret }
$port = if ($current["BRIDGE_PORT"]) { $current["BRIDGE_PORT"] } else { "7199" }

$artwork = $current["POKEMON_ARTWORK_DIR"]
if ($serverDir) {
  $config = [System.IO.File]::ReadAllText((Join-Path $serverDir "config.lua"))
  if ($config -notmatch 'discordBridgeEnabled') {
    Write-Host "WARNING: this game server build has no Discord bridge settings in config.lua." -ForegroundColor Yellow
    Write-Host "         Use a game build that includes the Discord bridge (see docs/GAME_INTEGRATION.md)." -ForegroundColor Yellow
  }
  $luaFile = Set-LuaLocalConfig $serverDir $secret $port
  Protect-File $luaFile
  Write-Host "Wrote the bridge settings to $luaFile" -ForegroundColor Green
  if (-not $artwork) {
    foreach ($client in @("client-legacy-windows", "client-legacy")) {
      $pictures = Join-Path (Split-Path -Parent $serverDir) "$client\data\images\pictures"
      if (Test-Path $pictures) { $artwork = $pictures; break }
    }
  }
} else {
  Write-Host "Game server folder not found. Add these lines to config.local.lua next to the game's config.lua:" -ForegroundColor Yellow
  Write-Host "  discordBridgeEnabled = true"
  Write-Host "  discordBridgeSecret = `"$secret`""
}

$values = [ordered]@{
  POKEVERSE_PROFILE      = "development"
  DISCORD_TOKEN          = $token
  DISCORD_APPLICATION_ID = $appId
  DISCORD_GUILD_ID       = $guild
  DISCORD_ADMIN_USER_IDS = $admin
  PRODUCTION_GUILD_ID    = $prodGuild
  BRIDGE_HOST            = "127.0.0.1"
  BRIDGE_PORT            = $port
  BRIDGE_SECRET          = $secret
  POKEMON_ARTWORK_DIR    = $artwork
}

$output = New-Object System.Collections.Generic.List[string]
$written = @{}
$source = if (Test-Path $envFile) { $envFile } else { $example }
foreach ($line in [System.IO.File]::ReadAllLines($source)) {
  if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=' -and $values.Contains($Matches[1])) {
    $key = $Matches[1]
    $output.Add("$key=$($values[$key])")
    $written[$key] = $true
  } else {
    $output.Add($line)
  }
}
foreach ($key in $values.Keys) {
  if (-not $written.ContainsKey($key)) { $output.Add("$key=$($values[$key])") }
}
[System.IO.File]::WriteAllText($envFile, (($output -join "`r`n") + "`r`n"), $utf8)
Protect-File $envFile
Write-Host "Wrote $envFile" -ForegroundColor Green

Write-Host ""
Write-Host "Checking the configuration..." -ForegroundColor Cyan
& $node $bot check-config --profile development --config-dir $here
if ($LASTEXITCODE -ne 0) { Fail "The configuration is not valid (see above)." }

if ($appId) {
  Write-Host ""
  Write-Host "Invite the development bot to your development server with this link:" -ForegroundColor Cyan
  & $node $bot invite --profile development --config-dir $here
}

if (-not $SkipBridgeCheck) {
  Write-Host ""
  Write-Host "Checking the connection to the local game server..." -ForegroundColor Cyan
  & $node $bot check-bridge --profile development --config-dir $here
  if ($LASTEXITCODE -ne 0) {
    Write-Host "The game server is not running or was started before this configuration." -ForegroundColor Yellow
    Write-Host "Restart the game server so it reads config.local.lua, then run start-discord-dev.bat." -ForegroundColor Yellow
  }
}

Write-Host ""
Write-Host "Done. Run start-discord-dev.bat to start the bot. It creates the Discord channels on first start." -ForegroundColor Green
exit 0
