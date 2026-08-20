param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$OutputRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) 'out-mark-slim'),
    [string]$NodePath = '',
    [string]$Revision = ''
)

$ErrorActionPreference = 'Stop'
$runtimeId = 'electron-43.3.0-win32-x64-r2'
$electronVersion = '43.3.0'
$project = [IO.Path]::GetFullPath($ProjectRoot)
$packageMetadata = Get-Content -Raw (Join-Path $project 'package.json') | ConvertFrom-Json
$version = $packageMetadata.productVersion
if ([string]::IsNullOrWhiteSpace($version)) { $version = $packageMetadata.version }
$Revision = $Revision.Trim()
if (-not [string]::IsNullOrWhiteSpace($Revision) -and $Revision -notmatch '^R\d+$') { throw "Revision must use the R<number> form, for example R2. Received: $Revision" }
$releaseSuffix = if ([string]::IsNullOrWhiteSpace($Revision)) { '' } else { "-$Revision" }
$folderName = "ZhelongX-Mark-$version$releaseSuffix-Slim-Windows11-x64"
$output = [IO.Path]::GetFullPath($OutputRoot)
$package = Join-Path $output $folderName
$stage = Join-Path $output 'app-stage'
$zip = Join-Path $output ($folderName + '.zip')
$reportPath = Join-Path $output 'BUILD-REPORT.json'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$appIcon = Join-Path $project 'assets\icons\carrot-purple.ico'
if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) { $NodePath = $nodeCommand.Source }
}
foreach ($required in @($project,$csc,$NodePath,$appIcon,(Join-Path $project 'tools\pack-asar.js'),(Join-Path $project 'native\windows\ZhelongXMarkThinLauncher.cs'))) {
    if ([string]::IsNullOrWhiteSpace($required) -or -not (Test-Path -LiteralPath $required)) { throw "Required build input missing: $required" }
}
if ([IO.Directory]::Exists($output)) { throw "Refusing to overwrite existing output: $output" }

function Copy-File([string]$Source,[string]$Target) {
    [IO.Directory]::CreateDirectory((Split-Path -Parent $Target)) | Out-Null
    [IO.File]::Copy($Source,$Target,$false)
}
function Copy-Tree([string]$SourceRoot,[string]$TargetRoot) {
    foreach ($file in Get-ChildItem -LiteralPath $SourceRoot -File -Recurse) {
        $relative = $file.FullName.Substring($SourceRoot.Length).TrimStart([char[]]@('\','/'))
        Copy-File $file.FullName (Join-Path $TargetRoot $relative)
    }
}
function Write-Utf8([string]$Path,[string[]]$Lines) {
    [IO.File]::WriteAllLines($Path,$Lines,(New-Object Text.UTF8Encoding($false)))
}

[IO.Directory]::CreateDirectory($stage) | Out-Null
[IO.Directory]::CreateDirectory($package) | Out-Null
[IO.File]::Copy((Join-Path $project 'package.json'),(Join-Path $stage 'package.json'),$false)
# Keep the delivery compact by excluding Electron, dependencies, source art,
# and development tools—but never curate application code by filename.  A
# complete `src` tree prevents a newer renderer import or fallback path from
# working on the build machine yet disappearing on another computer.
Copy-Tree (Join-Path $project 'src') (Join-Path $stage 'src')
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
foreach ($icon in @('carrot-flat.png', 'pencil-flat.png', 'highlighter-flat.png', 'eraser-flat.png', 'clear-flat.png', 'camera-flat.png', 'palette-flat.png', 'gear-flat.png')) {
    $sourceIcon = Join-Path $project (Join-Path 'assets\icons\flat' $icon)
    if (-not (Test-Path -LiteralPath $sourceIcon)) { throw "Required flat runtime icon missing: $icon" }
    Copy-File $sourceIcon (Join-Path $stage (Join-Path 'assets\icons\flat' $icon))
}
foreach ($texture in @('handle-leather-walnut.png', 'rack-paper-ivory.png', 'leather-paper-seam.png')) {
    Copy-File (Join-Path $project (Join-Path 'assets\textures' $texture)) (Join-Path $stage (Join-Path 'assets\textures' $texture))
}

$appAsar = Join-Path $package 'app.asar'
& $NodePath (Join-Path $project 'tools\pack-asar.js') $stage $appAsar
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $appAsar)) { throw "ASAR packaging failed: $LASTEXITCODE" }

$launcher = Join-Path $package 'ZhelongX-Mark.exe'
& $csc /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 "/out:$launcher" "/win32icon:$appIcon" /reference:System.dll /reference:System.Windows.Forms.dll (Join-Path $project 'native\windows\ZhelongXMarkThinLauncher.cs')
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcher)) { throw "Launcher compilation failed: $LASTEXITCODE" }

$asarInfo = Get-Item -LiteralPath $appAsar
$asarHash = (Get-FileHash -LiteralPath $appAsar -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Utf8 (Join-Path $package 'mark-package.ini') @(
    "RuntimeId=$runtimeId", "ElectronVersion=$electronVersion", 'Architecture=x64', 'MinimumWindows=11',
    "ReleaseRevision=$Revision", "AppAsarBytes=$($asarInfo.Length)", "AppAsarSha256=$asarHash", 'LaunchMode=explicit-app-asar', 'UserData=%APPDATA%\ZhelongX Mark'
)
Write-Utf8 (Join-Path $package 'README.txt') @(
    'ZhelongX / Mark — Slim Windows package', '',
    "Release revision: $Revision",
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
    ReleaseRevision = $Revision
    RuntimeId = $runtimeId; ElectronVersion = $electronVersion; RuntimeIncluded = $false
    Zip = [ordered]@{ Path = $zip; Bytes = (Get-Item -LiteralPath $zip).Length; Sha256 = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() }
    AppAsar = [ordered]@{ Bytes = $asarInfo.Length; Sha256 = $asarHash }
}
[IO.File]::WriteAllText($reportPath,($report | ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding($false)))
$report | ConvertTo-Json -Depth 5
