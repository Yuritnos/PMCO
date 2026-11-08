# A workspace can inherit a Low mandatory label from its parent. Executables
# downloaded there then run at Low integrity and NSIS cannot write normal TEMP.
# Apply only to the two verified packages being delivered, never their folders.
param(
  [Parameter(Mandatory=$true)][string]$NsisPath,
  [Parameter(Mandatory=$true)][string]$MsiPath
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Installer integrity labels require Windows' }
$packages = @(
  @{ Path=$NsisPath; Name='PMCO_0.3.0_x64-setup.exe' },
  @{ Path=$MsiPath; Name='PMCO_0.3.0_x64_en-US.msi' }
)
# Validate both destinations before changing either.
foreach ($package in $packages) {
  $file = Get-Item -LiteralPath $package.Path
  if ($file.PSIsContainer -or $file.Name -ne $package.Name -or
      ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Expected a regular, verified PMCO installer file'
  }
  $package.Path = $file.FullName
  $package.Hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
}
foreach ($package in $packages) {
  & icacls.exe $package.Path /setintegritylevel M | Out-Null
  if ($LASTEXITCODE -ne 0) { throw ('Cannot set Medium integrity: ' + $package.Path) }
  if ((Get-FileHash -LiteralPath $package.Path -Algorithm SHA256).Hash -ne $package.Hash) {
    throw 'Installer bytes changed while setting the integrity label'
  }
  [pscustomobject]@{ Path=$package.Path; SHA256=$package.Hash; Integrity='Medium' }
}
