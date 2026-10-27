Write-Host "==== ShipTrack environment check ====" -ForegroundColor Cyan
$ok = @{}
function Show($k, $v, $good) {
  $c = if ($good -eq $null) { "Gray" } elseif ($good) { "Green" } else { "Red" }
  Write-Host ("{0,-22} {1}" -f $k, $v) -ForegroundColor $c
}

# --- OS ---
try {
  $os = Get-CimInstance Win32_OperatingSystem
  Show "Windows" ("{0} {1}" -f $os.Caption, $os.Version) $null
  Show "User" $env:USERNAME $null
} catch { Show "Windows" "unknown" $false }

# --- WPS install ---
$roots = @()
foreach ($p in @($env:LOCALAPPDATA, $env:APPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)}, "C:\Program Files", "C:\Program Files (x86)")) {
  if ($p) { $roots += (Join-Path $p "Kingsoft\WPS Office"); $roots += (Join-Path $p "WPS Office") }
}
$exes = @()
foreach ($r in $roots) {
  if (Test-Path $r) { $exes += Get-ChildItem -Path $r -Recurse -Filter "wps.exe" -ErrorAction SilentlyContinue | Select-Object -First 3 }
}

# registry first: WPS may live on another drive (seen: D:\Users\...), dir scan alone misses it
$rk = @("HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*")
$regApps = Get-ItemProperty $rk -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match "WPS|Kingsoft" }
foreach ($a in $regApps) {
  foreach ($cand in @($a.DisplayIcon, $a.UninstallString)) {
    if (-not $cand) { continue }
    $path = [string]$cand
    if ($path.StartsWith('"')) { $path = ($path -split '"')[1] }
    $dir = Split-Path -Parent $path
    if (-not $dir) { $dir = $path }
    # walk up two levels: wps.exe sits under office6\ or a version folder
    foreach ($d in @($dir, (Split-Path -Parent $dir), (Split-Path -Parent (Split-Path -Parent $dir)))) {
      if ($d -and (Test-Path $d)) {
        $exes += Get-ChildItem -Path $d -Recurse -Filter "wps.exe" -ErrorAction SilentlyContinue | Select-Object -First 2
      }
    }
  }
}
$exes = $exes | Where-Object { $_ -ne $null } | Sort-Object FullName -Unique
if ($exes.Count -gt 0) {
  foreach ($e in $exes) {
    $ver = $e.VersionInfo.FileVersion
    if (-not $ver) { $ver = $e.VersionInfo.ProductVersion }
    Show "WPS" ("{0}  (ver {1})" -f $e.FullName, $ver) $true
  }
  $ok.wps = $true
} else {
  Show "WPS" "NOT FOUND - install WPS Office first" $false
  $ok.wps = $false
}

# --- jsaddons dir ---
$jsd = Join-Path $env:APPDATA "kingsoft\wps\jsaddons"
Show "jsaddons dir" $jsd (Test-Path $jsd)
if (Test-Path $jsd) {
  $entries = Get-ChildItem $jsd -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
  Show "  contents" ($(if ($entries) { $entries -join ", " } else { "(empty)" })) $null
  $pub = Join-Path $jsd "publish.xml"
  if (Test-Path $pub) {
    Write-Host "  publish.xml:" -ForegroundColor DarkGray
    Get-Content $pub -Encoding UTF8 | ForEach-Object { Write-Host ("    " + $_) -ForegroundColor DarkGray }
  } else {
    Show "  publish.xml" "missing (will be created)" $null
  }
} else {
  Show "  note" "WPS may not have been started yet - start WPS once, then re-run" $false
}

# --- Node ---
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $nv = (& node -v) 2>$null
  Show "node" ("{0} ({1})" -f $nv, $node.Source) $true
  $ok.node = $true
} else {
  Show "node" "NOT FOUND - local bridge needs Node.js LTS" $false
  $ok.node = $false
}

# --- port 8791 ---
try {
  $used = Get-NetTCPConnection -LocalPort 8791 -ErrorAction SilentlyContinue
  if ($used) { Show "port 8791" ("IN USE by pid " + ($used | Select-Object -First 1).OwningProcess) $false }
  else { Show "port 8791" "free" $true }
} catch { Show "port 8791" "cannot query" $null }

# --- bridge alive? ---
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:8791/health" -TimeoutSec 3 -UseBasicParsing
  Show "bridge /health" ("HTTP " + $r.StatusCode + " " + $r.Content) $true
} catch {
  Show "bridge /health" "not running" $false
}

Write-Host ""
if ($ok.wps -and $ok.node) {
  Write-Host "RESULT: OK - ready to install the add-in (run install-win.ps1)" -ForegroundColor Green
} elseif ($ok.wps -and -not $ok.node) {
  Write-Host "RESULT: WPS found, Node missing - the add-in UI will work but tracking needs Node.js LTS" -ForegroundColor Yellow
} else {
  Write-Host "RESULT: WPS missing - install WPS Office first" -ForegroundColor Red
}
