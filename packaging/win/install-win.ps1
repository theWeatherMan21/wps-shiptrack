param(
  [string]$Name = "ShipTrack",
  [string]$SourceDir = "",
  [string]$RepoPath = "",
  [switch]$NoBridge,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
function Say($m, $c = "Gray") { Write-Host $m -ForegroundColor $c }

Say "==== ShipTrack add-in installer (Windows) ====" "Cyan"

if (-not $SourceDir) {
  $SourceDir = Join-Path $PSScriptRoot $Name
}
$jsd = Join-Path $env:APPDATA "kingsoft\wps\jsaddons"
$dest = Join-Path $jsd ($Name + "_")
$pub = Join-Path $jsd "publish.xml"

if ($Uninstall) {
  Say "Removing $dest ..."
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  if (Test-Path $pub) {
    $x = [xml](Get-Content $pub -Encoding UTF8)
    $n = $x.jsplugins.jsplugin | Where-Object { $_.name -eq $Name }
    if ($n) {
      foreach ($item in @($n)) { [void]$x.jsplugins.RemoveChild($item) }
      $x.Save($pub)
      Say "Removed <jsplugin name=""$Name""> from publish.xml" "Green"
    }
  }
  Say "Done. Restart WPS." "Green"
  exit 0
}

if (-not (Test-Path $SourceDir)) { Say "Source not found: $SourceDir" "Red"; exit 1 }
if (-not (Test-Path (Join-Path $SourceDir "index.html"))) { Say "SourceDir has no index.html - wrong folder?" "Red"; exit 1 }

# 1) jsaddons dir (create if WPS never ran)
if (-not (Test-Path $jsd)) {
  Say "Creating $jsd"
  New-Item -ItemType Directory -Path $jsd -Force | Out-Null
}

# 2) mirror add-in files
# robocopy /MIR, not Copy-Item: copy-into-existing leaves stale hashed chunks behind,
# and then WPS keeps loading an old TaskPane chunk (same trap we hit on macOS).
Say "Copying files -> $dest"
New-Item -ItemType Directory -Path $dest -Force | Out-Null
$srcCount = (Get-ChildItem $SourceDir -Recurse -File).Count
# absolute path: on some locked-down boxes PATH has no System32 at all
$robocopy = Join-Path $env:SystemRoot "System32\robocopy.exe"
if (Test-Path $robocopy) {
  & $robocopy $SourceDir $dest /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
} else {
  Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  Copy-Item -Path (Join-Path $SourceDir "*") -Destination $dest -Recurse -Force
}
$count = (Get-ChildItem $dest -Recurse -File -ErrorAction SilentlyContinue).Count
Say "  $count files copied (source has $srcCount)" "Green"
# version stamp for the bridge's online-update check
$verFile = Join-Path $SourceDir "version.json"
$ver = "unknown"
if (Test-Path $verFile) { try { $ver = (Get-Content $verFile -Raw | ConvertFrom-Json).version } catch {} }
if ($ver -eq "unknown") {
  $mf = Join-Path $SourceDir "manifest.xml"
  if (Test-Path $mf) { try { $m = [xml](Get-Content $mf -Raw); if ($m.Application.Version) { $ver = $m.Application.Version } } catch {} }
}
$stamp = @{ version = $ver; installedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"); from = "install-win.ps1" } | ConvertTo-Json -Compress
Set-Content -Path (Join-Path $dest "version.json") -Value $stamp -Encoding UTF8
Say "  version.json -> $ver" "Green"
if ($count -ne $srcCount) { Say "  WARN: count mismatch - stale files left in $dest" "Yellow" }
# Self-heal: drop hashed chunks that the entry page no longer references.
# (Extracting an update over an old folder leaves old index-*.js / TaskPane-*.js behind;
#  WPS may then keep loading a stale chunk - the exact trap we hit on macOS.)
$assetsDir = Join-Path $dest "assets"
$idxPath = Join-Path $dest "index.html"
if ((Test-Path $assetsDir) -and (Test-Path $idxPath)) {
  $refs = @()
  $html = Get-Content $idxPath -Raw
  foreach ($m in [regex]::Matches($html, 'assets/[A-Za-z0-9_.\-]+')) { $refs += (Split-Path $m.Value -Leaf) }
  foreach ($r in @($refs)) {
    $p = Join-Path $assetsDir $r
    if ((Test-Path $p) -and ($r -like "*.js")) {
      $js = Get-Content $p -Raw
      # chunks referenced from the entry js: both TaskPane-*.js AND its .css
      foreach ($m2 in [regex]::Matches($js, '[A-Za-z0-9_.\-]+\.(js|css)')) { $refs += $m2.Value }
    }
  }
  $extra = Get-ChildItem $assetsDir -File | Where-Object { $refs -notcontains $_.Name }
  if ($extra) {
    foreach ($e in $extra) { Remove-Item $e.FullName -Force -ErrorAction SilentlyContinue }
    Say ("  cleaned " + $extra.Count + " stale asset(s)") "Yellow"
  }
}

# 3) merge publish.xml (keep other add-ins)
if (Test-Path $pub) {
  Copy-Item $pub "$pub.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" -Force
  $xml = [xml](Get-Content $pub -Raw -Encoding UTF8)
} else {
  $xml = New-Object System.Xml.XmlDocument
  $decl = $xml.CreateXmlDeclaration("1.0", "UTF-8", $null)
  [void]$xml.AppendChild($decl)
}

# Always talk to the root ELEMENT (the PS XML adapter can return a string for
# $xml.jsplugins, which has no AppendChild - seen on Windows PowerShell 5.1)
$rootEl = $xml.SelectSingleNode("/jsplugins")
if (-not $rootEl) {
  $rootEl = $xml.CreateElement("jsplugins")
  [void]$xml.AppendChild($rootEl)
}
foreach ($e in @($rootEl.SelectNodes("jsplugin"))) {
  if ($e.GetAttribute("name") -eq $Name) { [void]$rootEl.RemoveChild($e) }
}

$node = $xml.CreateElement("jsplugin")
$node.SetAttribute("name", $Name)
$node.SetAttribute("type", "et")
$node.SetAttribute("url", ($Name + "_/"))
$node.SetAttribute("enable", "enable_dev")
[void]$rootEl.AppendChild($node)
$xml.Save($pub)
Say "publish.xml updated:" "Green"
Get-Content $pub -Encoding UTF8 | ForEach-Object { Say ("  " + $_) "DarkGray" }

# 4) bridge
Say ""
$cfgDir = Join-Path $env:USERPROFILE ".hermes\wps-shiptrack"
New-Item -ItemType Directory -Path $cfgDir -Force | Out-Null
Say "Config dir (column memory): $cfgDir" "DarkGray"

if ($NoBridge) {
  Say "Skipped bridge start (-NoBridge). Start later with:" "Yellow"
  Say "  powershell -ExecutionPolicy Bypass -File start-win.ps1 -RepoPath <ShipScheduleHub>" "DarkGray"
} else {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) {
    Say "Node NOT found - live tracking needs Node.js LTS. Add-in still opens (shows 'bridge not connected')." "Yellow"
  } else {
    if (-not $RepoPath) { $RepoPath = Read-Host "ShipScheduleHub path (contains engine\tracking\cli.mjs)" }
    $starter = Join-Path $PSScriptRoot "start-win.ps1"
    if ((Test-Path $starter) -and $RepoPath) {
      & powershell -ExecutionPolicy Bypass -File $starter -RepoPath $RepoPath
    } else {
      Say "start-win.ps1 not found next to this script - start the bridge manually." "Yellow"
    }
  }
}
Say ""
Say "IMPORTANT: fully quit WPS (tray icon too) and start it again." "Cyan"
Say "Then: WPS Spreadsheet -> ribbon 'ShipTrack' tab -> Open panel" "Cyan"
