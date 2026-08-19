param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$OutputRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) 'out-mark-portable'),
    [string]$NodePath = ''
)

$ErrorActionPreference = 'Stop'
$electronVersion = '43.3.0'
$project = [IO.Path]::GetFullPath($ProjectRoot)
$output = [IO.Path]::GetFullPath($OutputRoot)
$metadata = Get-Content -Raw (Join-Path $project 'package.json') | ConvertFrom-Json
$version = $metadata.productVersion
if ([string]::IsNullOrWhiteSpace($version)) { $version = $metadata.version }
$folderName = "ZhelongX-Mark-$version-Portable-Windows11-x64"
$package = Join-Path $output $folderName
$stage = Join-Path $output 'app-stage'
$zip = Join-Path $output ($folderName + '.zip')
$reportPath = Join-Path $output 'BUILD-REPORT.json'
$electronDist = Join-Path $project 'node_modules\.pnpm\electron@43.3.0\node_modules\electron\dist'

if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) { $NodePath = $nodeCommand.Source }
}
foreach ($required in @($project, $NodePath, $electronDist, (Join-Path $electronDist 'electron.exe'), (Join-Path $project 'tools\pack-asar.js'))) {
    if ([string]::IsNullOrWhiteSpace($required) -or -not (Test-Path -LiteralPath $required)) { throw "Required build input missing: $required" }
}
if ([IO.Directory]::Exists($output)) { throw "Refusing to overwrite existing output: $output" }

function Copy-File([string]$Source, [string]$Target) {
    [IO.Directory]::CreateDirectory((Split-Path -Parent $Target)) | Out-Null
    [IO.File]::Copy($Source, $Target, $false)
}
function Copy-Tree([string]$SourceRoot, [string]$TargetRoot) {
    foreach ($file in Get-ChildItem -LiteralPath $SourceRoot -File -Recurse) {
        $relative = $file.FullName.Substring($SourceRoot.Length).TrimStart([char[]]@('\','/'))
        Copy-File $file.FullName (Join-Path $TargetRoot $relative)
    }
}
function Write-Utf8([string]$Path, [string[]]$Lines) {
    [IO.File]::WriteAllLines($Path, $Lines, (New-Object Text.UTF8Encoding($false)))
}

[IO.Directory]::CreateDirectory($stage) | Out-Null
[IO.Directory]::CreateDirectory($package) | Out-Null
[IO.File]::Copy((Join-Path $project 'package.json'), (Join-Path $stage 'package.json'), $false)
# Retain the complete application source tree. The portable build deliberately
# excludes only development dependencies and art sources; it never curates
# JavaScript, HTML, or CSS by a hand-maintained filename list.
Copy-Tree (Join-Path $project 'src') (Join-Path $stage 'src')
foreach ($icon in @('camera.png', 'carrot-purple.png', 'eraser-alpha-fixed.png', 'gear-alpha-fixed-v2.png', 'highlighter.png', 'palette.png', 'pencil.png', 'undo.png')) {
    Copy-File (Join-Path $project (Join-Path 'assets\icons' $icon)) (Join-Path $stage (Join-Path 'assets\icons' $icon))
}
foreach ($texture in @('handle-leather-walnut.png', 'rack-paper-ivory.png', 'leather-paper-seam.png')) {
    Copy-File (Join-Path $project (Join-Path 'assets\textures' $texture)) (Join-Path $stage (Join-Path 'assets\textures' $texture))
}

$appAsar = Join-Path $stage 'app.asar'
& $NodePath (Join-Path $project 'tools\pack-asar.js') $stage $appAsar
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $appAsar)) { throw "ASAR packaging failed: $LASTEXITCODE" }

# Standard Electron distribution: copy every runtime file, place the app in
# resources, then rename the launcher. The result runs after a plain unzip.
Copy-Tree $electronDist $package
$runtimeExe = Join-Path $package 'electron.exe'
$productExe = Join-Path $package 'ZhelongX-Mark.exe'
Move-Item -LiteralPath $runtimeExe -Destination $productExe
Copy-File $appAsar (Join-Path $package 'resources\app.asar')
Write-Utf8 (Join-Path $package 'README.txt') @(
    'ZhelongX / Mark — Portable Windows package', '',
    'This package includes its Electron 43.3.0 runtime.',
    'Unzip the complete folder, then run ZhelongX-Mark.exe.',
    'No shared runtime or separate installation is required.'
)

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [IO.File]::Open($zip, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
    $archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
    try {
        foreach ($file in Get-ChildItem -LiteralPath $package -File -Recurse | Sort-Object FullName) {
            $relative = $file.FullName.Substring($package.Length).TrimStart([char[]]@('\','/')).Replace('\','/')
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, ($folderName + '/' + $relative), [IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally { $archive.Dispose() }
} finally { $stream.Dispose() }

$asarInfo = Get-Item -LiteralPath (Join-Path $package 'resources\app.asar')
$exeInfo = Get-Item -LiteralPath $productExe
$report = [ordered]@{
    GeneratedAt = [DateTimeOffset]::Now.ToString('o'); Product = 'ZhelongX/Mark'; ProductVersion = $version
    ElectronVersion = $electronVersion; RuntimeIncluded = $true; LaunchExecutable = $productExe
    Zip = [ordered]@{ Path = $zip; Bytes = (Get-Item -LiteralPath $zip).Length; Sha256 = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() }
    AppAsar = [ordered]@{ Bytes = $asarInfo.Length; Sha256 = (Get-FileHash -LiteralPath $asarInfo -Algorithm SHA256).Hash.ToLowerInvariant() }
    Executable = [ordered]@{ Bytes = $exeInfo.Length; Sha256 = (Get-FileHash -LiteralPath $productExe -Algorithm SHA256).Hash.ToLowerInvariant() }
}
[IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
$report | ConvertTo-Json -Depth 5
