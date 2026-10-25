param([string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$runtimeScript = Join-Path $PSScriptRoot 'start-ollama.ps1'
if (Get-Command ollama.exe -ErrorAction SilentlyContinue) {
  try { & $runtimeScript } catch { Write-Warning $_.Exception.Message }
}
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'Node.js is required. Install it before starting this app.' }
$existing = $null
try { $existing = Invoke-RestMethod -Uri 'http://127.0.0.1:4173/api/health' -TimeoutSec 3 } catch {}
if ($null -ne $existing) {
  Write-Host 'Huayoushu is already running: http://127.0.0.1:4173'
  try { $pairing = Invoke-RestMethod -Uri 'http://127.0.0.1:4173/api/pairing' -TimeoutSec 3; Write-Host ('Phone pairing code: ' + $pairing.token) } catch {}
  Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -match '^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)' } | ForEach-Object { Write-Host ('Phone server URL: http://' + $_.IPAddress + ':4173') }
  Write-Host 'Keep the computer and model running while using AI on the phone.'
  Start-Process 'http://127.0.0.1:4173'
  Read-Host 'Press Enter to close this information window'
  return
}
$env:OLLAMA_URL = 'http://127.0.0.1:11434'
$env:OLLAMA_MODEL = 'qwen2.5:1.5b'
$env:PORT = '4173'
$localConfig = Join-Path $ProjectDirectory 'config'
$localTokenPath = Join-Path $localConfig 'ai-token.txt'
New-Item -ItemType Directory -Path $localConfig -Force | Out-Null
if (-not (Test-Path -LiteralPath $localTokenPath)) {
  $randomBytes = New-Object byte[] 24
  $randomGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $randomGenerator.GetBytes($randomBytes) } finally { $randomGenerator.Dispose() }
  [Convert]::ToBase64String($randomBytes) | Set-Content -LiteralPath $localTokenPath -Encoding ascii
}
$env:HYS_AI_TOKEN = (Get-Content -LiteralPath $localTokenPath -Raw).Trim()
Write-Host 'Open http://127.0.0.1:4173 after the service reports ready.'
Write-Host 'Keep this window open for phone AI. Ctrl+C stops the gateway.'
Push-Location -LiteralPath $ProjectDirectory
try { & $nodeCommand.Source (Join-Path $ProjectDirectory 'server.cjs') } finally { Pop-Location }
