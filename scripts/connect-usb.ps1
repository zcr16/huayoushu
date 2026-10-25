param([Parameter(Mandatory=$true)][string]$HdcPath)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $HdcPath)) { throw 'HDC was not found. Pass -HdcPath with your DevEco HDC executable.' }
Write-Host 'Connect one authorized HarmonyOS phone by USB before continuing.'
& $HdcPath rport tcp:4173 tcp:4173
if ($LASTEXITCODE -ne 0) { throw 'USB forwarding failed. Check the USB cable and phone debugging authorization.' }
Write-Host 'On this USB connection, set the app AI server to http://127.0.0.1:4173'
Write-Host 'Keep the app gateway and Ollama running on the computer. Pairing code is still required.'
Write-Host 'This forwarding stops working when the USB connection is unavailable.'
