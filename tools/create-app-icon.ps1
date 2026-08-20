param(
    [string]$Source = (Join-Path (Split-Path -Parent $PSScriptRoot) 'assets\icons\carrot-purple.png'),
    [string]$Destination = (Join-Path (Split-Path -Parent $PSScriptRoot) 'assets\icons\carrot-purple.ico')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path -LiteralPath $Source)) { throw "Source image is missing: $Source" }
[IO.Directory]::CreateDirectory((Split-Path -Parent $Destination)) | Out-Null

$sourceImage = [Drawing.Image]::FromFile($Source)
$bitmap = New-Object Drawing.Bitmap 256,256
$graphics = [Drawing.Graphics]::FromImage($bitmap)
try {
    $graphics.Clear([Drawing.Color]::Transparent)
    $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
    $scale = [Math]::Min(256 / $sourceImage.Width, 256 / $sourceImage.Height)
    $width = [Math]::Round($sourceImage.Width * $scale)
    $height = [Math]::Round($sourceImage.Height * $scale)
    $left = [Math]::Round((256 - $width) / 2)
    $top = [Math]::Round((256 - $height) / 2)
    $graphics.DrawImage($sourceImage,$left,$top,$width,$height)

    $pngStream = New-Object IO.MemoryStream
    try {
        $bitmap.Save($pngStream,[Drawing.Imaging.ImageFormat]::Png)
        $png = $pngStream.ToArray()
    } finally { $pngStream.Dispose() }

    $fileStream = [IO.File]::Open($Destination,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {
        $writer = New-Object IO.BinaryWriter($fileStream)
        try {
            # ICO header plus one 256px PNG image. Zero width/height denotes 256.
            $writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]1)
            $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
            $writer.Write([UInt16]1); $writer.Write([UInt16]32)
            $writer.Write([UInt32]$png.Length); $writer.Write([UInt32]22)
            $writer.Write($png)
        } finally { $writer.Dispose() }
    } finally { $fileStream.Dispose() }
} finally {
    $graphics.Dispose()
    $bitmap.Dispose()
    $sourceImage.Dispose()
}
