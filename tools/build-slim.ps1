param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$OutputRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) 'out-mark-slim'),
    [string]$NodePath = ''
)

$ErrorActionPreference = 'Stop'
$runtimeId = 'electron-43.3.0-win32-x64-r2'
$electronVersion = '43.3.0'
$project = [IO.Path]::GetFullPath($ProjectRoot)
$packageMetadata = Get-Content -Raw (Join-Path $project 'package.json') | ConvertFrom-Json
$version = $packageMetadata.productVersion
if ([string]::IsNullOrWhiteSpace($version)) { $version = $packageMetadata.version }
$folderName = "ZhelongX-Mark-$version-Slim-Windows11-x64"
$output = [IO.Path]::GetFullPath($OutputRoot)
$package = Join-Path $output $folderName
$stage = Join-Path $output 'app-stage'
$zip = Join-Path $output ($folderName + '.zip')
$reportPath = Join-Path $output 'BUILD-REPORT.json'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) { $NodePath = $nodeCommand.Source }
}
foreach ($required in @($project,$csc,$NodePath,(Join-Path $project 'tools\pack-asar.js'),(Join-Path $project 'native\windows\ZhelongXMarkThinLauncher.cs'))) {
    if ([string]::IsNullOrWhiteSpace($required) -or -not (Test-Path -LiteralPath $required)) { throw "Required build input missing: $required" }
}
if ([IO.Directory]::Exists($output)) { throw "Refusing to overwrite existing output: $output" }

function Copy-File([string]$Source,[string]$Target) {
    [IO.Directory]::CreateDirectory((Split-Path -Parent $Target)) | Out-Null
    [IO.File]::Copy($Source,$Target,$false)
}
function Write-Utf8([string]$Path,[string[]]$Lines) {
    [IO.File]::WriteAllLines($Path,$Lines,(New-Object Text.UTF8Encoding($false)))
}

[IO.Directory]::CreateDirectory($stage) | Out-Null
[IO.Directory]::CreateDirectory($package) | Out-Null
[IO.File]::Copy((Join-Path $project 'package.json'),(Join-Path $stage 'package.json'),$false)
# The source repository retains experiments and retired renderer prototypes.
# The slim package is a curated runtime graph: only files loaded by main.js,
# preload.js, toolbar.html, and overlay.html are staged.
$runtimeSources = @(
    'src\main.js', 'src\preload.js',
    'src\renderer\toolbar.html', 'src\renderer\toolbar.css', 'src\renderer\toolbar-fixes.css', 'src\renderer\toolbar.js',
    'src\renderer\overlay.html', 'src\renderer\overlay.css', 'src\renderer\overlay-fixes.css', 'src\renderer\overlay.js'
)
foreach ($runtimeSource in $runtimeSources) {
    $sourceFile = Join-Path $project $runtimeSource
    if (-not (Test-Path -LiteralPath $sourceFile)) { throw "Required runtime source missing: $runtimeSource" }
    Copy-File $sourceFile (Join-Path $stage $runtimeSource)
}
# Only the exact rasters referenced by the live renderer and main process ship.
$runtimeIcons = @(
    'camera.png', 'carrot-purple.png', 'eraser-alpha-fixed.png',
    'gear-alpha-fixed-v2.png', 'highlighter.png', 'palette.png',
    'pencil.png', 'undo.png'
)
foreach ($icon in $runtimeIcons) {
    $sourceIcon = Join-Path $project (Join-Path 'assets\icons' $icon)
    if (-not (Test-Path -LiteralPath $sourceIcon)) { throw "Required runtime icon missing: $icon" }
    Copy-File $sourceIcon (Join-Path $stage (Join-Path 'assets\icons' $icon))
}
foreach ($texture in @('handle-leather-walnut.png', 'rack-paper-ivory.png', 'leather-paper-seam.png')) {
    Copy-File (Join-Path $project (Join-Path 'assets\textures' $texture)) (Join-Path $stage (Join-Path 'assets\textures' $texture))
}

$appAsar = Join-Path $package 'app.asar'
& $NodePath (Join-Path $project 'tools\pack-asar.js') $stage $appAsar
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $appAsar)) { throw "ASAR packaging failed: $LASTEXITCODE" }

$launcher = Join-Path $package 'ZhelongX-Mark.exe'
& $csc /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 "/out:$launcher" /reference:System.dll /reference:System.Windows.Forms.dll (Join-Path $project 'native\windows\ZhelongXMarkThinLauncher.cs')
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcher)) { throw "Launcher compilation failed: $LASTEXITCODE" }

$asarInfo = Get-Item -LiteralPath $appAsar
$asarHash = (Get-FileHash -LiteralPath $appAsar -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Utf8 (Join-Path $package 'mark-package.ini') @(
    "RuntimeId=$runtimeId", "ElectronVersion=$electronVersion", 'Architecture=x64', 'MinimumWindows=11',
    "AppAsarBytes=$($asarInfo.Length)", "AppAsarSha256=$asarHash", 'LaunchMode=explicit-app-asar', 'UserData=%APPDATA%\ZhelongX Mark'
)
Write-Utf8 (Join-Path $package 'README.txt') @(
    'ZhelongX / Mark — Slim Windows package', '',
    'This package deliberately does not include Electron.',
    "It requires the shared ZhelongX Electron $electronVersion runtime ($runtimeId).",
    'Run ZhelongX-Mark.exe after installing or repairing that shared runtime.'
)

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [IO.File]::Open($zip,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
    $archive = New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Create,$true)
    try {
        foreach ($file in Get-ChildItem -LiteralPath $package -File -Recurse | Sort-Object FullName) {
            $relative = $file.FullName.Substring($package.Length).TrimStart('\','/').Replace('\','/')
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$file.FullName,($folderName + '/' + $relative),[IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally { $archive.Dispose() }
} finally { $stream.Dispose() }

$entries = [IO.Compression.ZipFile]::OpenRead($zip).Entries.FullName
if ($entries | Where-Object { $_ -match '(^|/)(node_modules|electron\.exe|resources/electron)(/|$)' }) { throw 'Slim zip unexpectedly contains a runtime or node_modules.' }
$report = [ordered]@{
    GeneratedAt = [DateTimeOffset]::Now.ToString('o'); Product = 'ZhelongX/Mark'; ProductVersion = $version
    RuntimeId = $runtimeId; ElectronVersion = $electronVersion; RuntimeIncluded = $false
    Zip = [ordered]@{ Path = $zip; Bytes = (Get-Item -LiteralPath $zip).Length; Sha256 = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() }
    AppAsar = [ordered]@{ Bytes = $asarInfo.Length; Sha256 = $asarHash }
}
[IO.File]::WriteAllText($reportPath,($report | ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding($false)))
$report | ConvertTo-Json -Depth 5
