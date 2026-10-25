param([string]$NodePath = 'node')
$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path $projectPath 'server.cjs'
$zipPath = Join-Path $PSScriptRoot '花有数-云端AI网关.zip'
$temporaryZipPath = Join-Path $PSScriptRoot ('.gateway-' + [Guid]::NewGuid().ToString('N') + '.zip')
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw 'server.cjs is missing.' }
& $NodePath --check $serverPath
if ($LASTEXITCODE -ne 0) { throw 'JavaScript syntax check failed.' }

# Explicit allowlist: do not package .env, browser storage, local configuration,
# developer certificates, model weights, or the contents of the project folder.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = $null
try {
  $archive = [System.IO.Compression.ZipFile]::Open($temporaryZipPath, [System.IO.Compression.ZipArchiveMode]::Create)
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $serverPath, 'server.cjs', [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  $archive.Dispose()
  $archive = $null
  Move-Item -LiteralPath $temporaryZipPath -Destination $zipPath -Force
  $verifyArchive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $entries = @($verifyArchive.Entries | ForEach-Object { $_.FullName })
    if ($entries.Count -ne 1 -or $entries[0] -ne 'server.cjs') { throw 'Unexpected ZIP contents.' }
  } finally { $verifyArchive.Dispose() }
  Write-Output ('Prepared only; not deployed: ' + $zipPath)
  Write-Output ('SHA256: ' + (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash)
} finally {
  if ($null -ne $archive) { $archive.Dispose() }
  if (Test-Path -LiteralPath $temporaryZipPath -PathType Leaf) { Remove-Item -LiteralPath $temporaryZipPath }
}
