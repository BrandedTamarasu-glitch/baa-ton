# Baa-ton installer — Windows PowerShell.
# Clones the repo, installs dependencies, links the Pi extension (junction)
# and the Herdr controller plugin. Idempotent: safe to re-run to update.
$ErrorActionPreference = "Stop"

$BaaTonDir = if ($env:BAA_TON_DIR) { $env:BAA_TON_DIR } else { Join-Path $HOME ".baa-ton" }
$PiExtDir = if ($env:PI_EXTENSIONS_DIR) { $env:PI_EXTENSIONS_DIR } else { Join-Path $HOME ".pi\agent\extensions" }
$Repo = "https://github.com/zachristmas/baa-ton"

function Say($msg) { Write-Host "==>" $msg -ForegroundColor Blue }
function Die($msg) { Write-Host "error: $msg" -ForegroundColor Red; exit 1 }

foreach ($tool in @("git", "node")) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Die "$tool is required"
  }
}
$nodeMajor = [int]((node -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 20) { Die "Node.js 20+ required, found $(node --version)" }

if (-not (Test-Path (Join-Path $BaaTonDir ".git"))) {
  Say "Cloning Baa-ton to $BaaTonDir"
  git clone --depth 1 $Repo $BaaTonDir
} else {
  Say "Updating existing checkout at $BaaTonDir"
  git -C $BaaTonDir pull --ff-only
}

Say "Installing dependencies"
Push-Location $BaaTonDir
try {
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    throw "npm install failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Force -Path $PiExtDir | Out-Null
$target = Join-Path $PiExtDir "herdr-orchestrator"
if (Test-Path $target) {
  Say "Replacing existing extension link"
  if ((Get-Item $target).LinkType -eq "Junction" -or (Get-Item $target).LinkType -eq "SymbolicLink") {
    (Get-Item $target).Delete()
  } else {
    Remove-Item -Recurse -Force $target
  }
}
New-Item -ItemType Junction -Path $target -Target (Join-Path $BaaTonDir "packages\herdr-tools") | Out-Null
Say "Pi extension linked: $target"

if (Get-Command herdr -ErrorAction SilentlyContinue) {
  $controllerPath = Join-Path $BaaTonDir "packages\controller"
  $existing = herdr plugin list 2>$null | Select-String "herdr-orchestrator-controller"
  if ($existing -and -not ($existing -match [regex]::Escape((Resolve-Path $controllerPath).Path))) {
    Say "Controller plugin already linked elsewhere; leaving it alone:"
    Say "  $existing"
    Say "To re-point it here instead, run: herdr plugin link `"$controllerPath`""
  } else {
    Say "Linking the Herdr event controller plugin"
    herdr plugin link $controllerPath
  }
} else {
  Say "Herdr CLI not found. Install Herdr 0.9+ (https://github.com/herdrdev/herdr), then run:"
  Say "  herdr plugin link `"$(Join-Path $BaaTonDir 'packages\controller')`""
}

Say "Done. Next: run pi inside a Herdr pane, call herdr_bootstrap_root once,"
Say "then herdr_plan -> herdr_dispatch."
