param([string]$RuntimeDirectory = '')

$ErrorActionPreference = 'Stop'
$runtimeExecutable = if ($RuntimeDirectory) { Join-Path $RuntimeDirectory 'ollama.exe' } else { (Get-Command ollama.exe -ErrorAction Stop).Source }
$runtimeLogs = Join-Path (Split-Path -Parent $PSScriptRoot) 'logs/ollama'
if (-not (Test-Path -LiteralPath $runtimeExecutable -PathType Leaf)) {
  throw ('Portable Ollama was not found: ' + $runtimeExecutable)
}
New-Item -ItemType Directory -Path $runtimeLogs -Force | Out-Null
try {
  $version = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 2
  Write-Output ('Ollama is already running: ' + $version.version)
  return
} catch {}

$signature = Get-AuthenticodeSignature -LiteralPath $runtimeExecutable
if ($signature.Status -ne 'Valid') {
  throw ('Ollama executable signature is not valid: ' + $signature.Status)
}

# Process-local settings: no PATH, registry, user or system environment changes.
$env:OLLAMA_HOST = '127.0.0.1:11434'
if ($RuntimeDirectory) { $env:OLLAMA_MODELS = Join-Path $RuntimeDirectory 'models' }
$env:OLLAMA_NUM_PARALLEL = '1'
$env:OLLAMA_MAX_LOADED_MODELS = '1'
$env:OLLAMA_CONTEXT_LENGTH = '2048'
$env:OLLAMA_KEEP_ALIVE = '1m'
$env:OLLAMA_NO_CLOUD = '1'
$env:OLLAMA_VULKAN = '0'

$runtimeProcess = Start-Process -FilePath $runtimeExecutable -ArgumentList 'serve' -WorkingDirectory (Split-Path -Parent $runtimeExecutable) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeLogs 'stdout.log') -RedirectStandardError (Join-Path $runtimeLogs 'stderr.log')
Set-Content -LiteralPath (Join-Path $runtimeLogs 'server.pid') -Value $runtimeProcess.Id
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  try {
    $version = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 2
    Write-Output ('Ollama ready: ' + $version.version + ' at http://127.0.0.1:11434')
    return
  } catch { Start-Sleep -Milliseconds 500 }
}
throw ('Ollama did not become ready. Check ' + (Join-Path $runtimeLogs 'stderr.log'))
