# Skill Conductor bootstrap installer for Windows PowerShell 5.1+.
# Installs a project-owned app under .skill-conductor/app and a local Node runtime
# under .skill-conductor/runtime when no supported Node is already available.
# No admin, PATH, profile, TEMP, pip or global npm changes are made.
[CmdletBinding()]
param(
  [string]$ProjectPath = (Get-Location).Path,
  [ValidateSet('', 'cursor', 'workbuddy', 'qoder', 'deepseek-harness', 'opencode', 'generic')]
  [string]$HostName = '',
  [string]$ArchivePath = '',
  [string]$Ref = 'main',
  [string]$HomePath = '',
  [string]$NodeArchivePath = '',
  [string]$NodeSha256 = '',
  [switch]$ForcePortableNode,
  [switch]$NoSetup,
  [switch]$VerifyHost
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

$NodeVersionPin = '24.22.3'
# Keys are full official archive names; the lookup below uses the same name.
$NodeHashes = @{
  'node-v24.22.3-win-x64.zip'   = 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f'
  'node-v24.22.3-win-arm64.zip' = 'b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14'
}

function Write-Step([string]$Message) {
  Write-Host "[skill-conductor] $Message"
}

function Get-Sha256Hex([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $bytes = $sha.ComputeHash($stream)
    return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
  } finally {
    $stream.Dispose()
    $sha.Dispose()
  }
}

function Assert-Inside([string]$Parent, [string]$Child, [string]$Label) {
  $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  $childFull = [IO.Path]::GetFullPath($Child)
  if (-not $childFull.StartsWith($parentFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label escapes its allowed directory: $childFull"
  }
}

function Assert-NoReparse([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label is a symlink/reparse point and is not followed: $Path"
  }
}

function Assert-TreeContained([string]$Root, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Root)) { return }
  foreach ($item in Get-ChildItem -LiteralPath $Root -Recurse -Force) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label contains a symlink/reparse point: $($item.FullName)"
    }
    Assert-Inside $Root $item.FullName $Label
  }
}

function Test-ArchiveEntries([string]$Archive, [string]$Label) {
  $extension = [IO.Path]::GetExtension($Archive).ToLowerInvariant()
  if ($extension -eq '.zip') {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
    try {
      foreach ($entry in $zip.Entries) {
        $name = $entry.FullName
        if ($name -match '^[\\/]' -or $name -match '^[A-Za-z]:' -or (($name -replace '\\', '/') -split '/') -contains '..') {
          throw "$Label contains an unsafe absolute/traversal entry: $name"
        }
        $mode = ($entry.ExternalAttributes -shr 16) -band 0xF000
        if ($mode -eq 0xA000) { throw "$Label contains a symlink entry: $name" }
      }
    } finally {
      $zip.Dispose()
    }
    return
  }
  if ($Archive.ToLowerInvariant().EndsWith('.tar.gz') -or $extension -eq '.tgz') {
    $tar = Get-Command tar -ErrorAction SilentlyContinue
    if (-not $tar) { throw 'tar.exe is required to inspect this archive on Windows 10+' }
    $names = @(& $tar.Source -tzf $Archive)
    if ($names.Count -eq 0) { throw "$Label could not be listed or is empty" }
    foreach ($name in $names) {
      if ($name -match '^[\\/]' -or $name -match '^[A-Za-z]:' -or (($name -replace '\\', '/') -split '/') -contains '..') {
        throw "$Label contains an unsafe absolute/traversal entry: $name"
      }
    }
    $verbose = @(& $tar.Source -tvzf $Archive)
    foreach ($line in $verbose) {
      if ($line -match '^[lh]') { throw "$Label contains a symlink/hardlink entry: $line" }
    }
    return
  }
  throw 'Archive must be .zip, .tar.gz or .tgz'
}

function Get-NodeVersion([string]$Path) {
  try {
    $value = (& $Path --version 2>$null | Select-Object -First 1)
    if (-not $value -or $value -notmatch '^v?\d+\.\d+\.\d+') { return $null }
    return [version]($value.TrimStart('v'))
  } catch {
    return $null
  }
}

function Test-SupportedNode([string]$Path) {
  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $false }
  $version = Get-NodeVersion $Path
  if (-not $version) { return $false }
  return ($version -ge [version]'20.11.0')
}

function Resolve-ProjectNode {
  $scDir = Join-Path $ProjectPath '.skill-conductor'
  $runtime = Join-Path $scDir 'runtime'
  if (-not $ForcePortableNode) {
    if ($env:SKILL_CONDUCTOR_NODE -and (Test-SupportedNode $env:SKILL_CONDUCTOR_NODE)) {
      return (Resolve-Path -LiteralPath $env:SKILL_CONDUCTOR_NODE).Path
    }
    if (Test-Path -LiteralPath $runtime) {
      Assert-NoReparse $runtime 'Runtime directory'
      foreach ($candidate in Get-ChildItem -LiteralPath $runtime -Directory -Filter 'node-v*' -ErrorAction SilentlyContinue) {
        Assert-NoReparse $candidate.FullName 'Runtime candidate'
        foreach ($name in @('node.exe', 'bin\node.exe')) {
          $exe = Join-Path $candidate.FullName $name
          if (Test-SupportedNode $exe) { return $exe }
        }
      }
    }
    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($command -and (Test-SupportedNode $command.Source)) { return $command.Source }
  }
  return $null
}

function Install-PortableNode {
  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($arch -eq 'AMD64') { $nodeArch = 'x64' }
  elseif ($arch -eq 'ARM64') { $nodeArch = 'arm64' }
  else { throw "Unsupported Windows architecture: $arch" }

  # The product has no npm dependencies. Use the official standalone executable
  # for online installation to avoid PowerShell 5.1 MAX_PATH failures while
  # expanding the much deeper, unnecessary npm archive tree.
  if (-not $NodeArchivePath) {
    # Official win-x64/node.exe and win-arm64/node.exe digests from Node's
    # published SHASUMS256.txt for the pinned version.
    $exeHashes = @{
      'x64' = '86fc4785327db5f5c7558dc6156c543b433c313e813a222e088086222ab4afa6'
      'arm64' = '172e320db179ce416fc012b96b9917dacfb442beb081de57c4deaed7b5a24644'
    }
    $expectedExe = $exeHashes[$nodeArch]
    $scDir = Join-Path $ProjectPath '.skill-conductor'
    $stage = Join-Path $scDir ('.node-stage-' + [guid]::NewGuid().ToString('N'))
    Assert-Inside $ProjectPath $stage 'Node staging directory'
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    try {
      $nodeExePath = Join-Path $stage 'node.exe'
      $url = "https://nodejs.org/dist/v$NodeVersionPin/win-$nodeArch/node.exe"
      Write-Step "downloading official standalone Node $NodeVersionPin ($nodeArch) from nodejs.org"
      Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $nodeExePath -TimeoutSec 120
      $actualExe = Get-Sha256Hex $nodeExePath
      if ($actualExe -ne $expectedExe) { throw "Node executable SHA256 mismatch: expected $expectedExe, got $actualExe" }
      if (-not (Test-SupportedNode $nodeExePath)) { throw 'Verified Node executable cannot run on this Windows installation' }
      $runtimeRoot = Join-Path $scDir 'runtime'
      Assert-Inside $ProjectPath $runtimeRoot 'Node runtime directory'
      Assert-NoReparse $runtimeRoot 'Node runtime directory'
      New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
      $final = Join-Path $runtimeRoot "node-v$NodeVersionPin-win-$nodeArch"
      Assert-Inside $runtimeRoot $final 'Node runtime target'
      Assert-NoReparse $final 'Node runtime target'
      if (Test-SupportedNode (Join-Path $final 'node.exe')) { return (Join-Path $final 'node.exe') }
      if (Test-Path -LiteralPath $final) { throw "Portable Node target already exists but is unusable: $final" }
      New-Item -ItemType Directory -Path $final -Force | Out-Null
      Assert-Inside $stage $nodeExePath 'Verified Node executable source'
      Move-Item -LiteralPath $nodeExePath -Destination (Join-Path $final 'node.exe')
      return (Join-Path $final 'node.exe')
    } finally {
      if (Test-Path -LiteralPath $stage) {
        Assert-Inside $ProjectPath $stage 'Node staging cleanup'
        Assert-NoReparse $stage 'Node staging cleanup'
        Assert-TreeContained $stage 'Node staging cleanup'
        Remove-Item -LiteralPath $stage -Recurse -Force
      }
    }
  }

  $archiveName = "node-v$NodeVersionPin-win-$nodeArch.zip"
  $expected = $NodeHashes[$archiveName]
  if (-not $expected) { throw "No pinned hash for $archiveName" }

  $scDir = Join-Path $ProjectPath '.skill-conductor'
  $stage = Join-Path $scDir ('.node-stage-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  Assert-Inside $ProjectPath $stage 'Node staging directory'
  try {
    $nodeZip = Join-Path $stage $archiveName
    if ($NodeArchivePath) {
      $local = [IO.Path]::GetFullPath($NodeArchivePath)
      if (-not (Test-Path -LiteralPath $local -PathType Leaf)) { throw "Node archive not found: $local" }
      Copy-Item -LiteralPath $local -Destination $nodeZip
      if ($NodeSha256) { $expected = $NodeSha256.ToLowerInvariant() }
    } else {
      $url = "https://nodejs.org/dist/v$NodeVersionPin/$archiveName"
      Write-Step "downloading official Node $NodeVersionPin ($nodeArch) from nodejs.org"
      Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $nodeZip
    }
    $actual = Get-Sha256Hex $nodeZip
    if ($actual -ne $expected.ToLowerInvariant()) {
      throw "Node archive SHA256 mismatch: expected $expected, got $actual"
    }
    Test-ArchiveEntries $nodeZip 'Node archive'
    $extract = Join-Path $stage 'extract'
    Expand-Archive -LiteralPath $nodeZip -DestinationPath $extract -Force
    Assert-TreeContained $extract 'Extracted Node archive'
    $nodeExe = Get-ChildItem -LiteralPath $extract -Recurse -Filter 'node.exe' -File | Select-Object -First 1
    if (-not $nodeExe) { throw 'Downloaded Node archive did not contain node.exe' }
    Assert-Inside $stage $nodeExe.FullName 'Node executable'
    $version = Get-NodeVersion $nodeExe.FullName
    if (-not $version -or $version -lt [version]'20.11.0') { throw 'Downloaded Node is not supported' }
    $runtimeRoot = Join-Path $scDir 'runtime'
    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    Assert-NoReparse $runtimeRoot 'Runtime directory'
    $final = Join-Path $runtimeRoot "node-v$NodeVersionPin-win-$nodeArch"
    Assert-Inside $runtimeRoot $final 'Portable Node target'
    if (Test-Path -LiteralPath $final) { Assert-NoReparse $final 'Portable Node target' }
    if (Test-SupportedNode (Join-Path $final 'node.exe')) { return (Join-Path $final 'node.exe') }
    if (Test-Path -LiteralPath $final) { throw "Portable Node target already exists but is not usable: $final" }
    Move-Item -LiteralPath $nodeExe.Directory.FullName -Destination $final
    return (Join-Path $final 'node.exe')
  } finally {
    if (Test-Path -LiteralPath $stage) {
      Assert-Inside $ProjectPath $stage 'Node staging directory'
      Remove-Item -LiteralPath $stage -Recurse -Force
    }
  }
}

function Expand-AppArchive([string]$Archive, [string]$Stage) {
  Test-ArchiveEntries $Archive 'Source archive'
  $extension = [IO.Path]::GetExtension($Archive).ToLowerInvariant()
  if ($extension -eq '.zip') {
    Expand-Archive -LiteralPath $Archive -DestinationPath $Stage -Force
    Assert-TreeContained $Stage 'Extracted source archive'
    return
  }
  if ($Archive.ToLowerInvariant().EndsWith('.tar.gz') -or $extension -eq '.tgz') {
    $tar = Get-Command tar -ErrorAction SilentlyContinue
    if (-not $tar) { throw 'tar.exe is required to extract this archive on Windows 10+' }
    & $tar.Source -xzf $Archive -C $Stage
    Assert-TreeContained $Stage 'Extracted source archive'
    return
  }
  throw 'Archive must be .zip, .tar.gz or .tgz'
}

try {
  $ProjectPath = [IO.Path]::GetFullPath($ProjectPath)
  if (-not (Test-Path -LiteralPath $ProjectPath -PathType Container)) {
    throw "Project path is not a directory: $ProjectPath"
  }
  if ($Ref -notmatch '^[A-Za-z0-9._-]+$') {
    throw 'Ref may contain only letters, digits, dot, underscore and hyphen'
  }
  $scDir = Join-Path $ProjectPath '.skill-conductor'
  New-Item -ItemType Directory -Path $scDir -Force | Out-Null
  Assert-Inside $ProjectPath $scDir 'Project state directory'
  Assert-NoReparse $scDir 'Project state directory'

  Write-Step "installing app into $scDir"
  $stage = Join-Path $scDir ('.install-stage-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  Assert-Inside $ProjectPath $stage 'App staging directory'
  try {
    $download = $null
    if ($ArchivePath) {
      $download = [IO.Path]::GetFullPath($ArchivePath)
      if (-not (Test-Path -LiteralPath $download -PathType Leaf)) { throw "Archive not found: $download" }
    } else {
      $download = Join-Path $stage 'skill-conductor.zip'
      $url = "https://github.com/ok888laity/skill-conductor/archive/refs/heads/$Ref.zip"
      Write-Step "downloading $url"
      Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $download
    }
    Expand-AppArchive $download $stage
    $stageArtifacts = @('skill-conductor.zip', 'archive-entries.txt', 'archive-types.txt')
    $entries = @(Get-ChildItem -LiteralPath $stage -Force | Where-Object { $stageArtifacts -notcontains $_.Name })
    $source = if ($entries.Count -eq 1 -and $entries[0].PSIsContainer) { $entries[0].FullName } else { $stage }
    $manifest = Join-Path $source 'package.json'
    $cli = Join-Path $source 'bin\skill-conductor.mjs'
    if (-not (Test-Path -LiteralPath $manifest) -or -not (Test-Path -LiteralPath $cli)) {
      throw 'Archive does not look like a Skill Conductor source tree'
    }
    $package = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    if ($package.name -ne 'skill-conductor') { throw "Unexpected package name: $($package.name)" }
    Write-Step "archive version $($package.version)"

    $app = Join-Path $scDir 'app'
    Assert-Inside $scDir $app 'App target'
    if (Test-Path -LiteralPath $app) { Assert-NoReparse $app 'Existing app directory' }
    $backup = $null
    if (Test-Path -LiteralPath $app) {
      $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmss')
      $backup = Join-Path $scDir "app.backup-$stamp"
      $suffix = 1
      while (Test-Path -LiteralPath $backup) {
        $backup = Join-Path $scDir "app.backup-$stamp-$suffix"
        $suffix += 1
      }
      Assert-Inside $scDir $backup 'App backup directory'
      Assert-NoReparse $backup 'App backup directory'
      Move-Item -LiteralPath $app -Destination $backup
      Write-Step "preserved previous app at $backup"
    }
    try {
      if ($source -eq $stage) {
        New-Item -ItemType Directory -Path $app -Force | Out-Null
        Get-ChildItem -LiteralPath $stage -Force | Where-Object { $stageArtifacts -notcontains $_.Name } | ForEach-Object {
          Copy-Item -LiteralPath $_.FullName -Destination $app -Recurse -Force
        }
      } else {
        Move-Item -LiteralPath $source -Destination $app
      }
    } catch {
      if (-not (Test-Path -LiteralPath $app) -and $backup -and (Test-Path -LiteralPath $backup)) {
        Move-Item -LiteralPath $backup -Destination $app
      }
      throw
    }
  } finally {
    if (Test-Path -LiteralPath $stage) {
      Assert-Inside $ProjectPath $stage 'App staging directory'
      Remove-Item -LiteralPath $stage -Recurse -Force
    }
  }

  $nodeExe = Resolve-ProjectNode
  $nodeSource = 'existing'
  if (-not $nodeExe) {
    $nodeExe = Install-PortableNode
    $nodeSource = 'portable-24.22.3-pinned-sha256'
  }
  if (-not $nodeExe) { throw 'Could not resolve a Node runtime' }
  if (-not (Test-SupportedNode $nodeExe)) { throw "No supported Node runtime available: $nodeExe" }
  $nodeVersion = (Get-NodeVersion $nodeExe).ToString()
  Write-Step "node $nodeVersion at $nodeExe ($nodeSource)"

  $setupRan = $false
  if (-not $NoSetup) {
    $setupArgs = @()
    if ($HostName) { $setupArgs += @('--host', $HostName) }
    if ($HomePath) { $setupArgs += @('--home', [IO.Path]::GetFullPath($HomePath)) }
    if ($VerifyHost) { $setupArgs += '--verify-host' }
    Push-Location -LiteralPath $ProjectPath
    try {
      $setupOutput = @(& $nodeExe (Join-Path $app 'bin\skill-conductor.mjs') 'setup' @setupArgs)
      $setupOutput | Write-Output
      $setupText = ($setupOutput | Out-String)
      if ($setupText -notmatch '"ok"\s*:\s*true') {
        throw "setup did not report success (exit $LASTEXITCODE)"
      }
      $setupRan = $true
    } finally {
      Pop-Location
    }
  }

  $next = if ($setupRan) {
    'Ask your agent to use the generated MCP/host config; reload the host if required.'
  } else {
    "Run: `"$nodeExe`" `"$(Join-Path $app 'bin\skill-conductor.mjs')`" setup"
  }
  [ordered]@{
    ok = $true
    appPath = (Join-Path $scDir 'app')
    nodePath = $nodeExe
    nodeVersion = $nodeVersion
    nodeSource = $nodeSource
    configPath = (Join-Path $scDir 'config.json')
    host = if ($HostName) { $HostName } else { $null }
    setupRan = $setupRan
    nextAction = $next
  } | ConvertTo-Json -Depth 5
} catch {
  Write-Error ("install.ps1 failed: " + $_.Exception.Message)
  exit 1
}
