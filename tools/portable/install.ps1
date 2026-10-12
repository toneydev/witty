# Installs this portable witty release for the current user: copies the
# folder next to this script to %LOCALAPPDATA%\Programs\witty and puts that on
# the user PATH. No build, no npm, no admin. -Uninstall removes both again.
#
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $env:LOCALAPPDATA 'Programs\witty'

# The user PATH is edited in the registry as stored (REG_EXPAND_SZ, %VAR%
# entries kept unexpanded; .NET's GetEnvironmentVariable would expand them)
# and the change is broadcast so new terminals pick it up.
$envKey = 'HKCU:\Environment'
function Get-UserPath {
  $raw = (Get-Item $envKey).GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  @($raw -split ';' | Where-Object { $_ -ne '' })
}
function Set-UserPath([string[]]$entries) {
  Set-ItemProperty -Path $envKey -Name Path -Value ($entries -join ';') -Type ExpandString
  if (-not ('WittyEnv' -as [type])) {
    Add-Type -Namespace '' -Name WittyEnv -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
  }
  [UIntPtr]$result = [UIntPtr]::Zero
  [WittyEnv]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) | Out-Null
}
function Test-SamePath([string]$a, [string]$b) { $a.TrimEnd('\') -ieq $b.TrimEnd('\') }

if ($Uninstall) {
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  $entries = Get-UserPath
  $kept = @($entries | Where-Object { -not (Test-SamePath $_ $target) })
  if ($kept.Count -ne $entries.Count) { Set-UserPath $kept }
  Write-Host "witty removed from $target and from the user PATH."
  exit 0
}

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
  Write-Warning 'Node.js was not found on PATH. witty needs Node.js 22.18 or later: winget install OpenJS.NodeJS.LTS'
} else {
  $version = (& $node.Source --version) -replace '^v', ''
  if ([version]$version -lt [version]'22.18') {
    Write-Warning "Node.js $version found; witty needs 22.18 or later: winget install OpenJS.NodeJS.LTS"
  }
}

if (-not (Test-Path (Join-Path $source 'dist\cli.js'))) {
  throw "install.ps1 must run from the extracted release folder (dist\cli.js not found next to it)."
}
if (Test-SamePath $target $source) { throw "The release is already extracted at $target; nothing to copy." }

if (Test-Path $target) { Remove-Item -Recurse -Force $target }
New-Item -ItemType Directory -Force $target | Out-Null
Copy-Item -Recurse -Force (Join-Path $source '*') $target

$entries = Get-UserPath
if (-not ($entries | Where-Object { Test-SamePath $_ $target })) {
  Set-UserPath ($entries + $target)
  Write-Host "Added $target to the user PATH (open a new terminal to pick it up)."
}
Write-Host "witty installed to $target. Run: witty"
