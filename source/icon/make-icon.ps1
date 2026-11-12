# 由 icon-1024.png 生成 icon-128.png / icon-64.png / icon.ico（多尺寸 PNG 压缩 ICO）
# 用法： powershell -NoProfile -ExecutionPolicy Bypass -File make-icon.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$src = Join-Path $PSScriptRoot 'icon-1024.png'
if (-not (Test-Path -LiteralPath $src)) { throw "缺少 $src" }
$img = [System.Drawing.Image]::FromFile($src)

function Save-Resized([int]$w, [int]$h, [string]$path) {
  $bmp = [System.Drawing.Bitmap]::new($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.DrawImage($img, [System.Drawing.Rectangle]::new(0, 0, $w, $h))
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

function Get-ResizedPng([int]$w, [int]$h) {
  $tmp = Join-Path $env:TEMP ("et-ico-" + $w + "-" + [Guid]::NewGuid().ToString('N') + ".png")
  Save-Resized $w $h $tmp
  $bytes = [System.IO.File]::ReadAllBytes($tmp)
  Remove-Item -LiteralPath $tmp -Force
  return $bytes
}

Save-Resized 128 128 (Join-Path $PSScriptRoot 'icon-128.png')
Save-Resized 64 64 (Join-Path $PSScriptRoot 'icon-64.png')

$sizes = @(16, 24, 32, 48, 64, 128, 256)

# 生成标准 BMP 帧的 ICO（不用 PNG 压缩帧，兼容 System.Drawing / 老工具）
function Get-IconFrame([int]$size) {
  $bmp = [System.Drawing.Bitmap]::new($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.DrawImage($img, [System.Drawing.Rectangle]::new(0, 0, $size, $size))
  $g.Dispose()

  $rect = [System.Drawing.Rectangle]::new(0, 0, $size, $size)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $data.Stride
  $pixels = New-Object byte[] ($stride * $size)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pixels, 0, $pixels.Length)
  $bmp.UnlockBits($data)
  $bmp.Dispose()

  $maskRow = [int]([Math]::Ceiling($size / 32.0)) * 4
  $maskSize = $maskRow * $size
  $xorSize = $size * $size * 4

  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  $bw.Write([UInt32]40)
  $bw.Write([Int32]$size)
  $bw.Write([Int32]($size * 2))
  $bw.Write([UInt16]1)
  $bw.Write([UInt16]32)
  $bw.Write([UInt32]0)
  $bw.Write([UInt32]($xorSize + $maskSize))
  $bw.Write([Int32]0); $bw.Write([Int32]0)
  $bw.Write([UInt32]0); $bw.Write([UInt32]0)
  for ($y = $size - 1; $y -ge 0; $y--) {
    $bw.Write($pixels, ($y * $stride), ($size * 4))
  }
  $bw.Write((New-Object byte[] $maskSize))
  $bw.Flush()
  $bytes = $ms.ToArray()
  $bw.Close(); $ms.Dispose()
  return $bytes
}

$frames = New-Object System.Collections.ArrayList
foreach ($s in $sizes) { [void]$frames.Add([byte[]](Get-IconFrame $s)) }
Write-Output ("debug: count={0} lens={1}" -f $frames.Count, (($frames | ForEach-Object { $_.Length }) -join ','))

$icoPath = Join-Path $PSScriptRoot 'icon.ico'
$fs = [System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create)
$bw = [System.IO.BinaryWriter]::new($fs)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $data = $frames[$i]
  $dim = if ($s -ge 256) { 0 } else { $s }
  $bw.Write([Byte]$dim); $bw.Write([Byte]$dim)
  $bw.Write([Byte]0); $bw.Write([Byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]$data.Length); $bw.Write([UInt32]$offset)
  $offset += $data.Length
}
foreach ($data in $frames) { $bw.Write($data) }
$bw.Flush(); $bw.Close(); $fs.Dispose()
$img.Dispose()

$ico = [System.Drawing.Icon]::new($icoPath)
Write-Output ("ICO OK: {0} x {1}, {2} bytes" -f $ico.Width, $ico.Height, (Get-Item $icoPath).Length)
$ico.Dispose()
