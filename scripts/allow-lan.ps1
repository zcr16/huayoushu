$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Administrator is required. Right-click the CMD launcher and choose Run as administrator.'
}
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'Node.js was not found.' }
$ruleName = 'Huayoushu-AI-LAN-4173'
if (-not (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name $ruleName -DisplayName 'Huayoushu AI local network 4173' -Direction Inbound -Action Allow -Enabled True -Protocol TCP -LocalPort 4173 -RemoteAddress LocalSubnet -Program $nodeCommand.Source -Profile Any | Out-Null
}
Write-Host 'Allowed only local-subnet TCP 4173 access to the Node.js app.'
Write-Host 'The AI gateway still requires its pairing code.'
Write-Host 'No other firewall rules or protection settings were changed.'
Get-NetFirewallRule -Name $ruleName | Select-Object Name,Enabled,Direction,Action
Read-Host 'Press Enter to close'
