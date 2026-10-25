param(
  [Parameter(Mandatory=$true)][string]$DevEcoHome,
  [switch]$SkipWebPackaging
)
$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
$nodePath = Join-Path $DevEcoHome 'tools\node\node.exe'
$hvigorPath = Join-Path $DevEcoHome 'tools\hvigor\bin\hvigorw.js'
if (-not (Test-Path -LiteralPath $nodePath)) { throw "DevEco Studio not found: $DevEcoHome. Pass -DevEcoHome with your installation path." }
$env:DEVECO_SDK_HOME = Join-Path $DevEcoHome 'sdk'
$env:JAVA_HOME = Join-Path $DevEcoHome 'jbr'
$env:NODE_HOME = Join-Path $DevEcoHome 'tools\node'
$env:HVIGOR_USER_HOME = Join-Path $projectPath '.hvigor-user'
$env:NPM_CONFIG_CACHE = Join-Path $env:HVIGOR_USER_HOME 'npm-cache'
$env:PATH = "$($env:NODE_HOME);$($env:JAVA_HOME)\bin;$($env:PATH)"
Push-Location -LiteralPath $projectPath
try {
  if (-not $SkipWebPackaging) {
    & $nodePath (Join-Path $PSScriptRoot 'package-web.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Web packaging failed.' }
  }
  & $nodePath $hvigorPath --mode module -p product=default -p module=entry@default -p buildMode=debug assembleHap --no-daemon
  if ($LASTEXITCODE -ne 0) { throw 'HarmonyOS build failed.' }
  Write-Output 'HAP output: entry\build\default\outputs\default\'
  $signedPath = Join-Path $projectPath 'entry\build\default\outputs\default\entry-default-signed.hap'
  if (Test-Path -LiteralPath $signedPath) {
    Write-Output 'Signed HAP produced. Device installation is limited by the configured debug profile.'
  } else {
    Write-Output 'Unsigned HAP produced. Configure automatic signing in DevEco Studio before device installation.'
  }
} finally {
  Pop-Location
}
