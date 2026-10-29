param(
  [string]$RepoPath = "",
  [int]$Port = 8791,
  [string]$UpdateUrl = "",
  [string]$UpdateManifest = "wps-version.json",
  [string]$UpdateRepo = "",
  [string]$GhToken = "",
  [switch]$Stop,
  [switch]$Status,
  [switch]$Foreground,
  [switch]$InstallAutostart,
  [switch]$RemoveAutostart
)

# ShipTrack local bridge (Windows): start / stop / status, window fully hidden.
# ASCII only on purpose: Windows PowerShell 5.1 reads UTF-8 without BOM as ANSI and
# non-ASCII bytes can break parsing when the script is copied between machines.
#   powershell -ExecutionPolicy Bypass -File start-win.ps1 -RepoPath "D:\code\ShipScheduleHub"
#   powershell -ExecutionPolicy Bypass -File start-win.ps1 -Status
#   powershell -ExecutionPolicy Bypass -File start-win.ps1 -Stop
$ErrorActionPreference = "Continue"
function Say($m, $c = "Gray") { Write-Host $m -ForegroundColor $c }

$Here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$CfgDir   = Join-Path $env:USERPROFILE ".hermes\wps-shiptrack"
$PidFile  = Join-Path $CfgDir "bridge.pid"
$LogFile  = Join-Path $CfgDir "bridge.log"
$RepoFile = Join-Path $CfgDir "repo.txt"
$Bridge   = Join-Path $Here "server.mjs"

New-Item -ItemType Directory -Path $CfgDir -Force | Out-Null

function Get-Health {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3 -UseBasicParsing
    return $r.Content
  } catch { return $null }
}

# --- autostart at logon (current user, no admin needed) ---
# Registered through the ScheduledTasks cmdlets, not `schtasks /SC ONLOGON`, so that
# RestartOnFailure is available: if the bridge dies (crash, killed, sleep/resume),
# the task service starts it again. `schtasks /SC ONLOGON` only ever fires once.
$TaskName = "ShipTrackBridge"
if ($InstallAutostart) {
  if (-not $RepoPath -and (Test-Path $RepoFile)) { $RepoPath = (Get-Content $RepoFile | Select-Object -First 1).Trim() }
  if (-not $RepoPath) { Say "Run once with -RepoPath first, then add -InstallAutostart" "Red"; exit 1 }
  if (-not (Test-Path (Join-Path $RepoPath "engine\tracking\cli.mjs"))) { Say "No engine\tracking\cli.mjs under: $RepoPath" "Red"; exit 1 }
  Set-Content -Path $RepoFile -Value $RepoPath -Encoding UTF8
  $ps = (Get-Command powershell).Source
  # -Foreground: the task process IS the bridge (no detached child), so the task stays
  # "Running" while the bridge lives and RestartOnFailure actually means something.
  $argLine = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -RepoPath `"$RepoPath`" -Port $Port -Foreground"
  try {
    $action = New-ScheduledTaskAction -Execute $ps -Argument $argLine -WorkingDirectory $RepoPath
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
      -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Say "OK: autostart registered (task: $TaskName, restart-on-failure every 1 min)" "Green"
  } catch {
    Say ("Failed to register autostart: " + $_.Exception.Message) "Red"
    Say "Fallback (no restart-on-failure): schtasks /Create /TN $TaskName /SC ONLOGON /TR `"`"$ps`" $argLine`" /F" "Yellow"
    exit 1
  }
  # start it right now instead of waiting for the next logon
  try { Start-ScheduledTask -TaskName $TaskName; Say "Task started now." "Green" } catch { Say "Task registered; will start at next logon." "Yellow" }
  exit 0
}
if ($RemoveAutostart) {
  schtasks /Delete /TN $TaskName /F | Out-Null
  Say "Autostart task removed: $TaskName" "Green"
  exit 0
}

if ($Status) {
  $h = Get-Health
  if ($h) { Say "Bridge is up: $h" "Green" } else { Say "Bridge is NOT running (port $Port)" "Yellow" }
  exit 0
}

if ($Stop) {
  $stopped = $false
  if (Test-Path $PidFile) {
    $oldPid = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($oldPid) {
      try { Stop-Process -Id ([int]$oldPid) -Force -ErrorAction Stop; $stopped = $true } catch {}
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  }
  # fallback: whoever owns the port
  try {
    $conn = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue; $stopped = $true }
  } catch {}
  if ($stopped) { Say "Stopped" "Green" } else { Say "Was not running" "Yellow" }
  exit 0
}

# 1) resolve repo path: param > remembered > error
if (-not $RepoPath -and (Test-Path $RepoFile)) { $RepoPath = (Get-Content $RepoFile | Select-Object -First 1).Trim() }
if (-not $RepoPath) { Say "Missing -RepoPath (ShipScheduleHub folder containing engine\tracking\cli.mjs)" "Red"; exit 1 }
if (-not (Test-Path (Join-Path $RepoPath "engine\tracking\cli.mjs"))) { Say "No engine\tracking\cli.mjs under: $RepoPath" "Red"; exit 1 }
Set-Content -Path $RepoFile -Value $RepoPath -Encoding UTF8

# 2) already running?
$h = Get-Health
if ($h) { Say "Already running: $h" "Green"; exit 0 }

# 3) Node
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Say "Node.js (LTS) not found - install it, then re-run this script." "Red"; exit 1 }
Say "Node: $(& node -v)  ->  $($node.Source)"

# --- Foreground mode: this process IS the bridge (used by the logon task) ---
# Blocking on purpose: the scheduled task then stays "Running" exactly as long as the
# bridge lives, so Task Scheduler's RestartOnFailure can bring it back after a crash.
if ($Foreground) {
  $env:SSH_REPO = $RepoPath
  $env:WPS_TRACK_PORT = "$Port"
  if ($UpdateUrl -ne "") { $env:WPS_UPDATE_URL = $UpdateUrl; $env:WPS_UPDATE_MANIFEST = $UpdateManifest }
  if ($UpdateRepo -ne "") { $env:WPS_UPDATE_REPO = $UpdateRepo }
  if ($GhToken -ne "") { $env:GH_TOKEN = $GhToken }
  Set-Location $RepoPath
  Say "Foreground bridge: $Bridge  repo=$RepoPath  port=$Port"
  # go through cmd.exe so the log stays plain UTF-8 text (PowerShell redirection writes UTF-16)
  $cmdLine = '"' + $node.Source + '" "' + $Bridge + '" >> "' + $LogFile + '" 2>&1'
  & cmd /c $cmdLine
  exit $LASTEXITCODE
}

# 4) start the bridge, hidden window, detached from this session
#    Over SSH, Start-Process children die with the session -> use a scheduled task
#    so the bridge keeps running after the terminal closes.
Say "Starting bridge: $Bridge  repo=$RepoPath"
$nodePath = $node.Source
$runner = Join-Path $CfgDir "run-bridge.cmd"
$lines = @(
  '@echo off',
  ('set SSH_REPO=' + $RepoPath),
  ('set WPS_TRACK_PORT=' + $Port))
if ($UpdateUrl -ne "") {
  $lines += ('set WPS_UPDATE_URL=' + $UpdateUrl)
  $lines += ('set WPS_UPDATE_MANIFEST=' + $UpdateManifest)
}
if ($UpdateRepo -ne "") { $lines += ('set WPS_UPDATE_REPO=' + $UpdateRepo) }
if ($GhToken -ne "") { $lines += ('set GH_TOKEN=' + $GhToken) }
$lines += ('cd /d "' + $RepoPath + '"')
$lines += ('"' + $nodePath + '" "' + $Bridge + '" >> "' + $LogFile + '" 2>> "' + $LogFile + '.err"')
Set-Content -Path $runner -Value $lines -Encoding ASCII
$RunTask = "ShipTrackBridgeRun"
schtasks /Create /TN $RunTask /SC ONCE /ST 00:00 /TR "`"$runner`"" /F /RL HIGHEST | Out-Null
schtasks /Run /TN $RunTask | Out-Null
Start-Sleep -Seconds 4

# 5) verify
$h = Get-Health
if ($h) {
  Say "OK: bridge ready -> $h" "Green"
  Say "Config dir: $CfgDir" "DarkGray"
  Say "Log: $LogFile" "DarkGray"
  exit 0
} else {
  Say "FAILED: bridge did not answer. Logs: $LogFile / $LogFile.err" "Red"
  if (Test-Path "$LogFile.err") { Get-Content "$LogFile.err" -Tail 15 | ForEach-Object { Say "  $_" "DarkGray" } }
  exit 1
}
