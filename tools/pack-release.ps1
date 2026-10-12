# Builds the portable release: release\witty-<version>-win-x64.zip, which runs
# on any 64-bit Windows with Node.js 22.18+ on PATH and needs no build there.
#
# Contents: dist\ (compiled), package.json, the production node_modules
# (node-pty with its prebuilt conpty.node, conpty.dll and OpenConsole.exe;
# pngjs), README, LICENSE, SECURITY.md, witty.cmd and install.ps1.
#
#   pwsh tools\pack-release.ps1          # builds, tests, packs
#   pwsh tools\pack-release.ps1 -SkipTests
param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$name = "witty-$version-win-x64"
$release = Join-Path $root 'release'
$stage = Join-Path $release $name
$zip = Join-Path $release "$name.zip"

npm run build
if ($LASTEXITCODE -ne 0) { throw 'build failed' }
if (-not $SkipTests) {
  npm test
  if ($LASTEXITCODE -ne 0) { throw 'tests failed' }
}

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
if (Test-Path $zip) { Remove-Item -Force $zip }
New-Item -ItemType Directory -Force $stage | Out-Null

# Production dependencies, resolved from the lock file into the stage.
# node-pty ships prebuilt binaries under prebuilds\win32-x64 and loads them
# from there, so its install scripts are not needed.
Copy-Item package.json, package-lock.json $stage
Push-Location $stage
try {
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
} finally {
  Pop-Location
}
Remove-Item (Join-Path $stage 'package-lock.json')

# Trim what the prebuilt node-pty never reads at runtime.
$pty = Join-Path $stage 'node_modules\node-pty'
foreach ($dir in 'src', 'deps', 'third_party', 'scripts', 'typings', 'build') {
  $p = Join-Path $pty $dir
  if (Test-Path $p) { Remove-Item -Recurse -Force $p }
}
Get-ChildItem -Recurse -Path (Join-Path $pty 'prebuilds') -Filter '*.pdb' | Remove-Item -Force
Get-ChildItem -Recurse -Path (Join-Path $pty 'prebuilds') -Directory | Where-Object { $_.Name -ne 'win32-x64' -and $_.Parent.Name -eq 'prebuilds' } | Remove-Item -Recurse -Force

Copy-Item -Recurse dist (Join-Path $stage 'dist')
Copy-Item README.md, LICENSE, SECURITY.md $stage
Copy-Item (Join-Path $root 'tools\portable\witty.cmd'), (Join-Path $root 'tools\portable\install.ps1') $stage

Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "packed $zip ($size MB)"
