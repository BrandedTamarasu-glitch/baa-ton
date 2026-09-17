# Baa-ton uninstaller — Windows PowerShell.
# Removes only the Baa-ton checkout, its Pi extension junction, and its Herdr
# controller registration. Workflow data and shared Herdr configuration remain.
param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$BaaTonDir = if ($env:BAA_TON_DIR) { $env:BAA_TON_DIR } else { Join-Path $HOME ".baa-ton" }
$PiExtDir = if ($env:PI_EXTENSIONS_DIR) { $env:PI_EXTENSIONS_DIR } else { Join-Path $HOME ".pi\agent\extensions" }
$ControllerPluginId = "herdr-orchestrator-controller"
$PiLink = Join-Path $PiExtDir "herdr-orchestrator"

function Say($msg) { Write-Host "==>" $msg -ForegroundColor Blue }
function Die($msg) { Write-Host "error: $msg" -ForegroundColor Red; exit 1 }

if ([string]::IsNullOrWhiteSpace($BaaTonDir) -or $BaaTonDir.TrimEnd('\', '/') -eq $HOME.TrimEnd('\', '/')) {
  Die "refusing to remove an unsafe BAA_TON_DIR: $BaaTonDir"
}

if (-not $Force) {
  $answer = Read-Host "Remove Baa-ton from $BaaTonDir and unlink its Herdr controller? [y/N]"
  if ($answer -notmatch '^(?i:y|yes)$') {
    Say "Uninstall cancelled."
    exit 0
  }
}

$checkoutPath = Join-Path $BaaTonDir ".git"
$packagePath = Join-Path $BaaTonDir "package.json"
$controllerPath = Join-Path $BaaTonDir "packages\controller"
$controllerResolved = $null
if (Test-Path -LiteralPath $controllerPath -PathType Container) {
  $controllerResolved = (Resolve-Path -LiteralPath $controllerPath).Path
}

if (Get-Command herdr -ErrorAction SilentlyContinue) {
  $pluginListing = herdr plugin list --plugin $ControllerPluginId --json 2>$null | Out-String
  $plugin = $null
  try {
    $payload = $pluginListing | ConvertFrom-Json
    $plugin = @($payload.result.plugins) | Where-Object { $_.plugin_id -eq $ControllerPluginId } | Select-Object -First 1
  } catch {
    $plugin = $null
  }

  $pluginRoot = if ($plugin) { [string]$plugin.plugin_root } else { "" }
  $pluginOwned = $controllerResolved -and (
    $pluginRoot.Equals($controllerResolved, [System.StringComparison]::OrdinalIgnoreCase) -or
    $pluginRoot.Replace('/', '\').Equals($controllerResolved.Replace('/', '\'), [System.StringComparison]::OrdinalIgnoreCase)
  )
  if ($pluginOwned) {
    Say "Unlinking the Herdr controller plugin"
    & herdr plugin unlink $ControllerPluginId | Out-Host
    if ($LASTEXITCODE -ne 0) { Die "Herdr controller unlink failed with exit code $LASTEXITCODE" }
  } elseif ($plugin) {
    Say "A Herdr controller with the same ID is linked elsewhere; leaving it alone."
  } else {
    Say "Herdr controller plugin is not registered from this checkout."
  }
} else {
  Say "Herdr CLI not found; skipping controller unlink."
}

$piItem = Get-Item -Force -LiteralPath $PiLink -ErrorAction SilentlyContinue
if ($piItem) {
  if ($piItem.LinkType -eq "Junction" -or $piItem.LinkType -eq "SymbolicLink") {
    $linkTarget = @($piItem.Target) | Select-Object -First 1
    $targetMatches = $false
    if ($controllerResolved -and $linkTarget) {
      $toolsPath = Join-Path $BaaTonDir "packages\herdr-tools"
      $toolsResolved = (Resolve-Path -LiteralPath $toolsPath).Path
      $linkResolved = (Resolve-Path -LiteralPath $linkTarget -ErrorAction SilentlyContinue).Path
      $targetMatches = $linkResolved -and $linkResolved.Replace('/', '\').Equals($toolsResolved.Replace('/', '\'), [System.StringComparison]::OrdinalIgnoreCase)
    }
    if ($targetMatches) {
      Say "Removing the Pi extension junction"
      Remove-Item -Force -LiteralPath $PiLink
    } else {
      Say "Pi extension link points elsewhere; leaving it alone: $PiLink"
    }
  } else {
    Say "Pi extension path is not a junction or symbolic link; leaving it alone: $PiLink"
  }
} else {
  Say "Pi extension link is not installed."
}

$checkoutItem = Get-Item -Force -LiteralPath $BaaTonDir -ErrorAction SilentlyContinue
$isReparsePoint = $checkoutItem -and (($checkoutItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
if ((Test-Path -LiteralPath $checkoutPath -PathType Container) -and (Test-Path -LiteralPath $packagePath -PathType Leaf) -and -not $isReparsePoint) {
  Say "Removing the Baa-ton checkout: $BaaTonDir"
  Remove-Item -Recurse -Force -LiteralPath $BaaTonDir
} elseif (Test-Path -LiteralPath $BaaTonDir) {
  Say "Checkout does not match an installed Baa-ton tree; leaving it alone: $BaaTonDir"
} else {
  Say "Baa-ton checkout is not installed."
}

Say "Baa-ton uninstall complete. Shared Herdr and project state was preserved."
