# Baa-ton installer — Windows PowerShell.
# Clones the repo, installs dependencies, links the Pi extension (junction)
# and the Herdr controller plugin. Any qualified harness can host the root;
# non-Pi harnesses use root-setup.mjs for MCP configuration.
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
& cmd.exe /d /c ('cd /d "' + $BaaTonDir + '" && npm install --no-audit --no-fund')
if ($LASTEXITCODE -ne 0) {
  throw "npm install failed with exit code $LASTEXITCODE"
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

$ProjectRoot = $PWD.Path
Say "Running the Baa-ton project wizard in $ProjectRoot"
& node (Join-Path $BaaTonDir "packages\herdr-tools\setup.mjs") --project-root $ProjectRoot --prompt-project
if ($LASTEXITCODE -ne 0) {
  throw "Baa-ton project setup failed with exit code $LASTEXITCODE"
}

Say "Project wizard complete. Selected harnesses have the project-local baa-ton-setup skill."

$rootPrompt = @"
Finish Baa-ton root setup in this Herdr pane.

The installer already configured the selected project and installed the
project-local baa-ton-setup skill for the selected harnesses. Invoke that skill
now. It must read BAA.md, complete the harness-specific connection, restart in
this same Herdr pane only if required, call herdr_bootstrap_root, verify the root
identity, and wait for my task.

Do not ask me to run setup.mjs, initialize a goal, or provide an objective during
setup. If the skill is unavailable, use the installed root-setup helper as the
fallback. Never reset an existing root unless the pane and checkout are
intentionally being replaced.
"@

$clipboardCopied = $false
try {
  Set-Clipboard -Value $rootPrompt
  $clipboardCopied = $true
} catch {
  $clipboardCopied = $false
}

if ($clipboardCopied) {
  Say "A short fallback prompt was copied to the clipboard; normally invoke baa-ton-setup from the harness."
} else {
  Say "Clipboard unavailable; use this fallback prompt if the harness cannot invoke baa-ton-setup:"
}
Write-Host $rootPrompt
