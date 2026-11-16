param([string]$CompanyDefaults)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
$tools=Join-Path $env:USERPROFILE 'opt\tuda-build-tools'
$nodeDir=Join-Path $tools 'node-v22.23.5-win-x64'
$env:PATH=$nodeDir+';'+(Join-Path $tools 'node_modules\.bin')+';'+(Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd')+';'+$env:PATH
$env:TUDA_COMPANY_DEFAULTS_FILE=$CompanyDefaults
function Run-Pnpm { & pnpm.cmd @args; if($LASTEXITCODE -ne 0){throw "pnpm failed: $args"} }
& node.exe --version
Run-Pnpm --version
Run-Pnpm install --frozen-lockfile
& npm.cmd ci --prefix cli
if($LASTEXITCODE -ne 0){throw 'CLI dependencies failed'}
& node.exe node_modules/electron/install.js
if($LASTEXITCODE -ne 0){throw 'Electron installation failed'}
Run-Pnpm exec vitest run test/npm-update.test.ts test/npm-payload.test.ts test/update-service.test.ts test/company-account.test.ts test/company-desktop.test.ts test/company-guest-login.test.ts test/company-login-policy.test.ts test/company-toapis.test.ts test/company-direct-models.test.ts test/tuda-agent-home.test.ts test/cli-runtime.test.ts
& node.exe --test test/desktop-release.test.mjs
if($LASTEXITCODE -ne 0){throw 'Desktop release contracts failed'}
Run-Pnpm release --arch x64
& node.exe scripts/prepare-release-manifest.mjs --platform win32 --arch x64
if($LASTEXITCODE -ne 0){throw 'Manifest preparation failed'}
