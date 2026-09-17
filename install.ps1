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

$rootPrompt = @"
Set up Baa-ton as the root for this Herdr pane.

The Baa-ton checkout is at:
$BaaTonDir

Do this in order:
1. Confirm this is a Herdr pane and identify the current harness: Pi, Claude Code, Codex, or OpenCode.
2. Run the matching command from this pane:
     node "$BaaTonDir\packages\herdr-tools\root-setup.mjs" --harness claude
   Use codex, opencode, or pi for the other harnesses.
3. Follow the helper's one-time integration instructions. If it asks for a
   restart, restart the harness in this same Herdr pane and continue.
4. Call herdr_bootstrap_root and verify the returned root identity and briefing.
5. Report exactly: "Baa-ton root ready: <harness>, <workspace>, <pane>." Then
   wait for my task. Do not initialize a parent goal or ask for an objective yet.

Read BAA.md in the checkout for the operating contract. Keep the harness in this
pane so its Herdr identity is preserved. Never reset an existing root unless the
pane and checkout are intentionally being replaced.
"@

$clipboardCopied = $false
try {
  Set-Clipboard -Value $rootPrompt
  $clipboardCopied = $true
} catch {
  $clipboardCopied = $false
}

if ($clipboardCopied) {
  Say "Done. A ready-to-paste root setup instruction was copied to the clipboard."
} else {
  Say "Done. Clipboard copy was unavailable; use this root setup instruction:"
}
Write-Host $rootPrompt
