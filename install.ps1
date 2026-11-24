# Install the latest opengate release for Windows into %LOCALAPPDATA%\opengate\bin and add it to your PATH.
#   irm https://raw.githubusercontent.com/Emmanuek5/opengate/main/install.ps1 | iex
# Forks: set $env:OPENGATE_REPO = "you/opengate" first.
$ErrorActionPreference = "Stop"
$repo = if ($env:OPENGATE_REPO) { $env:OPENGATE_REPO } else { "Emmanuek5/opengate" }
$binDir = if ($env:OPENGATE_BIN) { $env:OPENGATE_BIN } else { Join-Path $env:LOCALAPPDATA "opengate\bin" }
$asset = "opengate-windows-x64.exe"
$url = "https://github.com/$repo/releases/latest/download/$asset"
$sums = "https://github.com/$repo/releases/latest/download/SHA256SUMS"

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) $asset
Write-Host "Downloading $asset from $repo..."
Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
try {
  $line = (Invoke-WebRequest -Uri $sums -UseBasicParsing).Content -split "`n" | Where-Object { $_ -match " $([regex]::Escape($asset))$" }
  if ($line) {
    $expected = ($line -split " ")[0].Trim().ToLower()
    $actual = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) { Remove-Item $tmp; throw "checksum mismatch, not installing" }
  }
} catch [System.Net.WebException] { }
$dest = Join-Path $binDir "opengate.exe"
Move-Item -Force $tmp $dest

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not ($userPath -split ";" | Where-Object { $_ -eq $binDir })) {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$binDir", "User")
  Write-Host "Added $binDir to your PATH (open a new terminal to use it)."
}
Write-Host "Installed $dest ($(& $dest --version))"
Write-Host "Next: opengate login"
