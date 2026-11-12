param([Parameter(Mandatory=$true)][string]$NodeDirectory, [Parameter(Mandatory=$true)][string]$PnpmEntry)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$pnpmBin = [System.IO.Path]::GetFullPath((Join-Path (Split-Path $PnpmEntry) '..\..\.bin'))
$userGit = Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd'
$env:PATH = $NodeDirectory + ';' + $pnpmBin + ';' + $userGit + ';' + $env:PATH
$node = Join-Path $NodeDirectory 'node.exe'
function Invoke-Pnpm {
  & $node $PnpmEntry @args
  if ($LASTEXITCODE -ne 0) { throw "pnpm failed ($LASTEXITCODE): $args" }
}
& $node --version
Invoke-Pnpm --version
Invoke-Pnpm install --frozen-lockfile
& (Join-Path $NodeDirectory 'npm.cmd') ci --prefix cli
if ($LASTEXITCODE -ne 0) { throw 'CLI dependency installation failed' }
Invoke-Pnpm exec install-electron
Invoke-Pnpm exec vitest run test/npm-update.test.ts test/npm-payload.test.ts test/update-service.test.ts test/tuda-agent-home.test.ts
Invoke-Pnpm release --arch x64
& $node scripts/prepare-release-manifest.mjs --arch x64
if ($LASTEXITCODE -ne 0) { throw 'Release manifest preparation failed' }
Invoke-Pnpm build:cli
& $node desktop-package/validate.mjs
if ($LASTEXITCODE -ne 0) { throw 'Package validation failed' }
& (Join-Path $NodeDirectory 'npm.cmd') pack ./desktop-package --pack-destination release
if ($LASTEXITCODE -ne 0) { throw 'npm pack failed' }
& $node scripts/playwright-electron-smoke.mjs
if ($LASTEXITCODE -ne 0) { throw 'Windows desktop smoke failed' }
