# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CharlotteDe

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$etCode = @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class EtForm : Form {
  public EtForm() {
    SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint, true);
    UpdateStyles();
  }
}

public static class EtGui {
  [DllImport("user32.dll")] public static extern bool ReleaseCapture();
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int m, int w, int l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int val, int size);

  public static void Drag(Form f) { ReleaseCapture(); SendMessage(f.Handle, 0xA1, 2, 0); }
  public static void Round(Form f) { int p = 2; try { DwmSetWindowAttribute(f.Handle, 33, ref p, 4); } catch {} }

  public static GraphicsPath RoundedRect(Rectangle b, int r) {
    var p = new GraphicsPath();
    r = Math.Min(r, b.Width / 2);
    r = Math.Min(r, b.Height / 2);
    if (r <= 0) { p.AddRectangle(b); return p; }
    p.AddArc(b.X, b.Y, r, r, 180, 90);
    p.AddArc(b.X + b.Width - r, b.Y, r, r, 270, 90);
    p.AddArc(b.X + b.Width - r, b.Y + b.Height - r, r, r, 0, 90);
    p.AddArc(b.X, b.Y + b.Height - r, r, r, 90, 90);
    p.CloseFigure();
    return p;
  }
}
"@

Add-Type -TypeDefinition $etCode -ReferencedAssemblies System.Drawing, System.Windows.Forms

[void][EtGui]::SetProcessDPIAware()
[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)

$cfg = $env:ET_CFG_PATH
$stat = $env:ET_STATUS_PATH
$server = [string]$env:ET_DEFAULT_SERVER
$token = [string]$env:ET_DEFAULT_TOKEN
if (Test-Path -LiteralPath $cfg) {
  try {
    $j = Get-Content -LiteralPath $cfg -Raw -Encoding UTF8 | ConvertFrom-Json
    $server = [string]$j.server
    $token = [string]$j.token
  } catch {}
}
if (-not $server) { $server = '127.0.0.1:9001' }

# 配色与管理页一致：深蓝底 + 橙色主色
$bg = [System.Drawing.Color]::FromArgb(7, 13, 23)
$panelC = [System.Drawing.Color]::FromArgb(18, 27, 42)
$panel2C = [System.Drawing.Color]::FromArgb(24, 36, 55)
$inputC = [System.Drawing.Color]::FromArgb(10, 18, 30)
$lineC = [System.Drawing.Color]::FromArgb(34, 49, 72)
$txtC = [System.Drawing.Color]::FromArgb(233, 240, 249)
$dimC = [System.Drawing.Color]::FromArgb(143, 162, 186)
$dim2C = [System.Drawing.Color]::FromArgb(99, 117, 140)
$accentC = [System.Drawing.Color]::FromArgb(255, 138, 61)
$accent2C = [System.Drawing.Color]::FromArgb(255, 106, 31)
$okC = [System.Drawing.Color]::FromArgb(63, 212, 139)
$errC = [System.Drawing.Color]::FromArgb(255, 107, 107)
$warnC = [System.Drawing.Color]::FromArgb(242, 179, 75)
$blueC = [System.Drawing.Color]::FromArgb(79, 157, 255)

$f = [EtForm]::new()
$f.Text = 'EasyTunnel 客户端'
$f.FormBorderStyle = 'None'
$f.StartPosition = 'CenterScreen'
$f.BackColor = $bg
$f.ShowInTaskbar = $true
$f.MaximizeBox = $false
$f.MinimizeBox = $false
$f.AutoScaleMode = 'None'
$f.Font = [System.Drawing.Font]::new('Microsoft YaHei', 9.5)

$script:sc = 1.0
try { $script:sc = [double]$f.DeviceDpi / 96.0 } catch {}
if ($script:sc -le 0 -or $script:sc -gt 4) { $script:sc = 1.0 }
function S([double]$v) { return [int][Math]::Round($v * $script:sc) }

$f.ClientSize = [System.Drawing.Size]::new((S 700), (S 640))

# 字体（点数不随 DPI 缩放；布局像素随 DPI 缩放）
$fTitle = [System.Drawing.Font]::new('Microsoft YaHei', 13, [System.Drawing.FontStyle]::Bold)
$fSub = [System.Drawing.Font]::new('Microsoft YaHei', 8.5)
$fBody = [System.Drawing.Font]::new('Microsoft YaHei', 9.5)
$fLabel = [System.Drawing.Font]::new('Microsoft YaHei', 9)
$fSmall = [System.Drawing.Font]::new('Microsoft YaHei', 8.5)
$fCard = [System.Drawing.Font]::new('Microsoft YaHei', 10.5, [System.Drawing.FontStyle]::Bold)
$fValue = [System.Drawing.Font]::new('Microsoft YaHei', 14, [System.Drawing.FontStyle]::Bold)

# 画刷 / 画笔 / 图标：脚本级创建一次，关闭时统一释放
$script:bgBrush = [System.Drawing.SolidBrush]::new($bg)
$script:cardBrush = [System.Drawing.SolidBrush]::new($panelC)
$script:inputBrush = [System.Drawing.SolidBrush]::new($inputC)
$script:brushText = [System.Drawing.SolidBrush]::new($txtC)
$script:brushDim = [System.Drawing.SolidBrush]::new($dimC)
$script:brushDim2 = [System.Drawing.SolidBrush]::new($dim2C)
$script:brushOk = [System.Drawing.SolidBrush]::new($okC)
$script:brushErr = [System.Drawing.SolidBrush]::new($errC)
$script:brushWarn = [System.Drawing.SolidBrush]::new($warnC)
$script:brushAccent = [System.Drawing.SolidBrush]::new($accentC)
$script:brushBlue = [System.Drawing.SolidBrush]::new($blueC)
$script:brushWhite = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
$script:brushSub = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(196, 214, 232))
$script:cardPen = [System.Drawing.Pen]::new($lineC, 1)
$script:accentPen = [System.Drawing.Pen]::new($accentC, 1.4)
$script:borderPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(30, 42, 60), 1)
$script:gridPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(26, 36, 52), 1)
$script:chartOutPen = [System.Drawing.Pen]::new($accentC, 2)
$script:chartInPen = [System.Drawing.Pen]::new($blueC, 2)
$script:chartOutFill = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(42, 255, 138, 61))
$script:chartInFill = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(36, 79, 157, 255))
$script:hdrLinePen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(40, 54, 74), 1)
$script:hdrGlyphPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(230, 240, 250), 1.6)
$script:hdrHoverBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(34, 255, 255, 255))
$script:glowBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(30, 255, 106, 31))
$script:hdrBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  [System.Drawing.Rectangle]::new(0, 0, $f.ClientSize.Width, (S 64)),
  [System.Drawing.Color]::FromArgb(13, 21, 34),
  [System.Drawing.Color]::FromArgb(38, 29, 30),
  [System.Drawing.Drawing2D.LinearGradientMode]::Horizontal)

$script:logoBmp = $null
$script:appIcon = $null
$iconPath = [string]$env:ET_ICON_PATH
$logoPath = [string]$env:ET_LOGO_PATH
if ($logoPath -and (Test-Path -LiteralPath $logoPath)) {
  try {
    $img = [System.Drawing.Image]::FromFile($logoPath)
    $script:logoBmp = [System.Drawing.Bitmap]::new($img)
    $img.Dispose()
  } catch {}
}
if ($script:logoBmp) {
  try {
    $hicon = $script:logoBmp.GetHicon()
    $tmpIcon = [System.Drawing.Icon]::FromHandle($hicon)
    $script:appIcon = $tmpIcon.Clone()
    $tmpIcon.Dispose()
    [void][EtGui]::DestroyIcon($hicon)
  } catch {}
}
if (-not $script:appIcon -and $iconPath -and (Test-Path -LiteralPath $iconPath)) {
  try { $script:appIcon = [System.Drawing.Icon]::new($iconPath, 32, 32) } catch {}
}
if ($script:appIcon) { $f.Icon = $script:appIcon } else { $f.Icon = [System.Drawing.SystemIcons]::Application }

$script:sfEllipsis = [System.Drawing.StringFormat]::new()
$script:sfEllipsis.Trimming = [System.Drawing.StringTrimming]::EllipsisCharacter
$script:sfEllipsis.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap

$script:snap = $null
$script:lastRaw = ''
$script:hdrHit = ''
$script:focusField = $null
$script:hint = '改完自动重连'
$script:hintErr = $false
$script:adminPort = 9000
try {
  $ap = [int]$env:ET_ADMIN_PORT
  if ($ap -ge 1 -and $ap -le 65535) { $script:adminPort = $ap }
} catch {}

$script:rServer = [System.Drawing.Rectangle]::new((S 32), (S 134), (S 636), (S 36))
$script:rToken = [System.Drawing.Rectangle]::new((S 32), (S 196), (S 636), (S 36))

function Fmt-Bytes([double]$n) {
  if ($n -lt 0) { $n = 0 }
  if ($n -lt 1024) { return ([int]$n).ToString() + ' B' }
  if ($n -lt 1048576) { return ($n / 1024).ToString('0.0') + ' KB' }
  if ($n -lt 1073741824) { return ($n / 1048576).ToString('0.0') + ' MB' }
  return ($n / 1073741824).ToString('0.00') + ' GB'
}
function Fmt-Rate([double]$n) { return (Fmt-Bytes $n) + '/s' }
function Fmt-Uptime([int]$sec) {
  if ($sec -lt 60) { return [string]$sec + ' 秒' }
  $d = [Math]::Floor($sec / 86400)
  $h = [Math]::Floor(($sec % 86400) / 3600)
  $m = [Math]::Floor(($sec % 3600) / 60)
  if ($d -gt 0) { return ([string]$d + ' 天 ' + [string]$h + ' 时') }
  if ($h -gt 0) { return ([string]$h + ' 时 ' + [string]$m + ' 分') }
  return ([string]$m + ' 分 ' + [string]($sec % 60) + ' 秒')
}

function Draw-Card($g, [int]$x, [int]$y, [int]$w, [int]$h) {
  $p = [EtGui]::RoundedRect([System.Drawing.Rectangle]::new($x, $y, $w, $h), (S 14))
  $g.FillPath($script:cardBrush, $p)
  $g.DrawPath($script:cardPen, $p)
  $p.Dispose()
}

function Draw-Field($g, [System.Drawing.Rectangle]$r, [bool]$focus) {
  $p = [EtGui]::RoundedRect($r, (S 9))
  $g.FillPath($script:inputBrush, $p)
  $pen = $script:cardPen
  if ($focus) { $pen = $script:accentPen }
  $g.DrawPath($pen, $p)
  $p.Dispose()
}

function Draw-Metric($g, [int]$x, [string]$label, [string]$value, $brush) {
  $g.DrawString($label, $script:fSmall, $script:brushDim2, [float]$x, [float](S 372))
  $g.DrawString($value, $script:fValue, $brush, [float]$x, [float](S 386))
}

function New-Points($arr, [double]$x, [double]$y, [double]$w, [double]$h, [double]$max) {
  $n = @($arr).Count
  $pts = New-Object 'System.Drawing.PointF[]' $n
  for ($i = 0; $i -lt $n; $i++) {
    $v = [double]$arr[$i]
    $px = $x + $w * ($i / [Math]::Max(1, $n - 1))
    $py = $y + $h * (1.0 - [Math]::Min(1.0, ($v / $max)))
    $pts[$i] = [System.Drawing.PointF]::new([float]$px, [float]$py)
  }
  return $pts
}

function Draw-Chart($g, [System.Drawing.Rectangle]$r) {
  $g.DrawString('近 60 秒流量', $script:fSmall, $script:brushDim2, [float]$r.X, [float]$r.Y)
  $top = $r.Y + (S 20)
  $h = $r.Height - (S 24)
  $w = $r.Width
  for ($i = 0; $i -le 3; $i++) {
    $gy = $top + $h * $i / 3
    $g.DrawLine($script:gridPen, $r.X, [int]$gy, $r.Right, [int]$gy)
  }

  $snap = $script:snap
  $aIn = @()
  $aOut = @()
  $rawMax = 1024.0
  if ($snap -and $snap.series) {
    $aIn = @($snap.series.in)
    $aOut = @($snap.series.out)
  }
  foreach ($v in $aIn) { if ([double]$v -gt $rawMax) { $rawMax = [double]$v } }
  foreach ($v in $aOut) { if ([double]$v -gt $rawMax) { $rawMax = [double]$v } }
  $max = $rawMax * 1.15

  if ($aOut.Count -gt 1) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $pts = New-Points $aOut $r.X $top $w $h $max
    $p.AddLines($pts)
    $p.AddLine($r.Right, [float]($top + $h), [float]$r.X, [float]($top + $h))
    $p.CloseFigure()
    $g.FillPath($script:chartOutFill, $p)
    $p.Dispose()
    $g.DrawLines($script:chartOutPen, $pts)
  }
  if ($aIn.Count -gt 1) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $pts = New-Points $aIn $r.X $top $w $h $max
    $p.AddLines($pts)
    $p.AddLine($r.Right, [float]($top + $h), [float]$r.X, [float]($top + $h))
    $p.CloseFigure()
    $g.FillPath($script:chartInFill, $p)
    $p.Dispose()
    $g.DrawLines($script:chartInPen, $pts)
  }

  $peak = '峰值 ' + (Fmt-Rate $rawMax)
  $g.DrawString($peak, $script:fSmall, $script:brushDim2, [float]($r.Right - (S 100)), [float]$r.Y)
}

function Draw-All($g) {
  $W = $f.ClientSize.Width
  $H = $f.ClientSize.Height
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

  $g.FillRectangle($script:bgBrush, 0, 0, $W, $H)

  # 标题栏
  $hr = [System.Drawing.Rectangle]::new(0, 0, $W, (S 64))
  $g.FillRectangle($script:hdrBrush, $hr)
  $g.FillEllipse($script:glowBrush, (S -70), (S -90), (S 270), (S 220))
  $g.DrawLine($script:hdrLinePen, 0, (S 63), $W, (S 63))
  if ($script:logoBmp) {
    $ir = [System.Drawing.Rectangle]::new((S 18), (S 13), (S 38), (S 38))
    $ip = [EtGui]::RoundedRect($ir, (S 10))
    $g.SetClip($ip)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($script:logoBmp, $ir)
    $g.ResetClip()
    $ip.Dispose()
  } else {
    $ir = [System.Drawing.Rectangle]::new((S 18), (S 13), (S 38), (S 38))
    $ip = [EtGui]::RoundedRect($ir, (S 10))
    $g.FillPath($script:brushAccent, $ip)
    $ip.Dispose()
    $g.DrawString('E', $script:fTitle, $script:brushWhite, (S 30), (S 18))
  }
  $g.DrawString('EasyTunnel', $script:fTitle, $script:brushWhite, (S 66), (S 8))
  $g.DrawString('内网穿透客户端', $script:fSub, $script:brushSub, (S 66), (S 34))

  # 标题栏按钮
  if ($script:hdrHit -eq 'min') {
    $hp = [EtGui]::RoundedRect([System.Drawing.Rectangle]::new((S 596), (S 14), (S 36), (S 32)), (S 8))
    $g.FillPath($script:hdrHoverBrush, $hp); $hp.Dispose()
  }
  $g.DrawLine($script:hdrGlyphPen, (S 607), (S 30), (S 621), (S 30))
  if ($script:hdrHit -eq 'close') {
    $hp = [EtGui]::RoundedRect([System.Drawing.Rectangle]::new((S 648), (S 14), (S 36), (S 32)), (S 8))
    $g.FillPath($script:hdrHoverBrush, $hp); $hp.Dispose()
  }
  $g.DrawLine($script:hdrGlyphPen, (S 659), (S 23), (S 673), (S 37))
  $g.DrawLine($script:hdrGlyphPen, (S 673), (S 23), (S 659), (S 37))

  # 连接配置卡片
  Draw-Card $g (S 16) (S 80) (S 668) (S 212)
  $g.DrawString('连接配置', $script:fCard, $script:brushText, (S 34), (S 90))
  $g.DrawString('服务端地址 (IP:端口)', $script:fLabel, $script:brushDim, (S 34), (S 116))
  Draw-Field $g $script:rServer ($script:focusField -eq $script:tbServer)
  $g.DrawString('客户端令牌 (服务端管理页可复制)', $script:fLabel, $script:brushDim, (S 34), (S 178))
  Draw-Field $g $script:rToken ($script:focusField -eq $script:tbToken)
  $hintBrush = $script:brushDim2
  if ($script:hintErr) { $hintBrush = $script:brushErr }
  $g.DrawString($script:hint, $script:fSmall, $hintBrush, (S 392), (S 254))

  # 状态卡片
  Draw-Card $g (S 16) (S 304) (S 668) (S 244)
  $g.DrawString('运行状态', $script:fCard, $script:brushText, (S 34), (S 314))

  $snap = $script:snap
  $state = 'starting'
  $text = '正在启动…'
  if ($snap) {
    if ($snap.state) { $state = [string]$snap.state }
    if ($snap.text) { $text = [string]$snap.text }
  }
  $dotBrush = $script:brushWarn
  if ($state -eq 'online') { $dotBrush = $script:brushOk }
  elseif ($state -eq 'error' -or $state -eq 'offline') { $dotBrush = $script:brushErr }
  $g.FillEllipse($dotBrush, (S 34), (S 346), (S 10), (S 10))
  $g.DrawString($text, $script:fBody, $script:brushText,
    [System.Drawing.RectangleF]::new((S 52), (S 338), (S 600), (S 24)), $script:sfEllipsis)

  $lat = '—'; $upTime = '—'; $down = '—'; $up = '—'; $cum = '累计 ↓ — · ↑ —'
  if ($snap) {
    if ($snap.state -eq 'online' -and [double]$snap.latency -gt 0) {
      $lat = [string]([int]$snap.latency) + ' ms'
    }
    if ([double]$snap.uptimeSec -gt 0) { $upTime = Fmt-Uptime ([int]$snap.uptimeSec) }
    if ($snap.series) {
      $aIn = @($snap.series.in)
      $aOut = @($snap.series.out)
      if ($aOut.Count -gt 0) { $down = Fmt-Rate ([double]$aOut[$aOut.Count - 1]) }
      if ($aIn.Count -gt 0) { $up = Fmt-Rate ([double]$aIn[$aIn.Count - 1]) }
    }
    $cum = '累计 ↓ ' + (Fmt-Bytes ([double]$snap.inBytes)) + ' · ↑ ' + (Fmt-Bytes ([double]$snap.outBytes)) +
           ' · 通道 ' + [string]([int]$snap.channels)
  }
  Draw-Metric $g (S 34) '延迟' $lat $script:brushOk
  Draw-Metric $g (S 190) '在线时长' $upTime $script:brushText
  Draw-Metric $g (S 346) '下行' $down $script:brushAccent
  Draw-Metric $g (S 502) '上行' $up $script:brushBlue

  Draw-Chart $g ([System.Drawing.Rectangle]::new((S 32), (S 422), (S 636), (S 92)))
  $g.DrawString($cum, $script:fSmall, $script:brushDim2, (S 34), (S 518))

  # 底部
  $g.DrawString('关闭窗口会彻底退出', $script:fSmall, $script:brushDim2, (S 460), (S 576))
  $g.DrawString('v2.2', $script:fSmall, $script:brushDim2, (S 660), (S 576))

  $g.DrawRectangle($script:borderPen, 0, 0, $W - 1, $H - 1)
}

# 输入框（无边框，聚焦由窗口 Paint 描边）
function New-Field([System.Drawing.Rectangle]$r, [string]$text) {
  $tb = New-Object System.Windows.Forms.TextBox
  $tb.BorderStyle = 'None'
  $tb.BackColor = $inputC
  $tb.ForeColor = $txtC
  $tb.Font = $fBody
  $tb.Left = $r.X + (S 12)
  $tb.Top = $r.Y + (S 9)
  $tb.Width = $r.Width - (S 24)
  $tb.Height = (S 20)
  $tb.Text = $text
  $tb.Add_Enter({ $script:focusField = $this; $f.Invalidate() })
  $tb.Add_Leave({ $script:focusField = $null; $f.Invalidate() })
  $f.Controls.Add($tb)
  return $tb
}

function New-Button([string]$text, [int]$x, [int]$y, [int]$w, [int]$h, $bgC, $bgHover, $fgC, [bool]$bold) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.FlatStyle = 'Flat'
  $b.FlatAppearance.BorderSize = 0
  $b.BackColor = $bgC
  $b.ForeColor = $fgC
  $b.FlatAppearance.MouseOverBackColor = $bgHover
  $b.FlatAppearance.MouseDownBackColor = $bgHover
  $style = [System.Drawing.FontStyle]::Regular
  if ($bold) { $style = [System.Drawing.FontStyle]::Bold }
  $b.Font = [System.Drawing.Font]::new('Microsoft YaHei', 10, $style)
  $b.Left = $x; $b.Top = $y; $b.Width = $w; $b.Height = $h
  $b.TabStop = $false
  $b.Cursor = [System.Windows.Forms.Cursors]::Hand
  $f.Controls.Add($b)
  return $b
}

$script:tbServer = New-Field $script:rServer $server
$script:tbToken = New-Field $script:rToken $token

$bs = New-Button '保存并连接' (S 32) (S 244) (S 176) (S 40) $accent2C $accentC ([System.Drawing.Color]::White) $true
$bi = New-Button '从剪贴板导入' (S 216) (S 244) (S 158) (S 40) $panel2C $lineC $txtC $false
$bx = New-Button '退出' (S 16) (S 564) (S 110) (S 42) $panel2C ([System.Drawing.Color]::FromArgb(60, 34, 38)) $txtC $false
$bm = New-Button '最小化到托盘' (S 138) (S 564) (S 170) (S 42) $panel2C $lineC $txtC $false
$bo = New-Button '打开服务端' (S 316) (S 564) (S 130) (S 42) $panel2C $lineC $txtC $false

function Save-Config([string]$srv, [string]$tk) {
  $json = @{ server = $srv; token = $tk; name = '' } | ConvertTo-Json
  [System.IO.File]::WriteAllText($cfg, $json, (New-Object System.Text.UTF8Encoding($false)))
}

$script:hintTimer = New-Object System.Windows.Forms.Timer
$script:hintTimer.Interval = 3600
$script:hintTimer.Add_Tick({
  $script:hintTimer.Stop()
  $script:hint = '改完自动重连'
  $script:hintErr = $false
  $f.Invalidate()
})

function Set-Hint([string]$text, [bool]$bad) {
  $script:hint = $text
  $script:hintErr = $bad
  $f.Invalidate()
  $script:hintTimer.Stop()
  $script:hintTimer.Start()
}

$bs.Add_Click({
  $s = $script:tbServer.Text.Trim()
  $t = $script:tbToken.Text.Trim()
  if (-not $s -or -not $t) { Set-Hint '请填写服务端地址和令牌' $true; return }
  try {
    Save-Config $s $t
    Set-Hint '配置已保存，正在连接…' $false
  } catch {
    Set-Hint ('保存失败：' + $_.Exception.Message) $true
  }
})

$bi.Add_Click({
  $raw = $null
  try { $raw = Get-Clipboard -Raw } catch {}
  if (-not $raw) { try { $raw = [System.Windows.Forms.Clipboard]::GetText() } catch {} }
  if (-not $raw) { Set-Hint '剪贴板是空的' $true; return }
  try {
    $j = $raw | ConvertFrom-Json
    $s = [string]$j.server
    $t = [string]$j.token
    if (-not $s -or -not $t) { Set-Hint '剪贴板里不是有效的 client.json' $true; return }
    $script:tbServer.Text = $s
    $script:tbToken.Text = $t
    Save-Config $s $t
    Set-Hint '已导入并保存，正在连接…' $false
  } catch {
    Set-Hint '剪贴板里不是有效的 JSON' $true
  }
})

# 托盘
$ni = New-Object System.Windows.Forms.NotifyIcon
if ($script:appIcon) { $ni.Icon = $script:appIcon } else { $ni.Icon = [System.Drawing.SystemIcons]::Application }
$ni.Text = 'EasyTunnel 客户端'
$ni.Visible = $false
$cm = New-Object System.Windows.Forms.ContextMenuStrip
$miShow = $cm.Items.Add('显示窗口')
$miShow.Add_Click({ ShowForm })
$miAdmin = $cm.Items.Add('打开服务端')
$miAdmin.Add_Click({ Open-Admin })
$miExit = $cm.Items.Add('退出')
$miExit.Add_Click({ $f.Close() })
$ni.ContextMenuStrip = $cm
$ni.Add_DoubleClick({ ShowForm })

function ShowForm {
  $f.ShowInTaskbar = $true
  $f.WindowState = 'Normal'
  if (-not $f.Visible) { $f.Show() }
  $f.Activate()
  $f.BringToFront()
  $f.TopMost = $true
  $f.TopMost = $false
  $ni.Visible = $false
}

function HideToTray {
  $ni.Visible = $true
  $f.ShowInTaskbar = $false
  $f.Hide()
}

function Open-Admin {
  $s = $script:tbServer.Text.Trim()
  if (-not $s) { Set-Hint '请先填写服务端地址' $true; return }
  $idx = $s.LastIndexOf(':')
  $h = $s
  if ($idx -gt 0) { $h = $s.Substring(0, $idx) }
  $p = [int]$script:adminPort
  if ($p -lt 1) { $p = 9000 }
  $url = 'http://' + $h + ':' + [string]$p + '/'
  try {
    [void][System.Diagnostics.Process]::Start($url)
    Set-Hint '已在浏览器打开管理页' $false
  } catch {
    Set-Hint '无法打开浏览器' $true
  }
}

$bx.Add_Click({ $f.Close() })
$bm.Add_Click({ HideToTray })
$bo.Add_Click({ Open-Admin })

# 标题栏拖动 + 最小化 / 关闭
$f.Add_MouseMove({
  param($s, $e)
  $hit = ''
  if ($e.Y -le (S 64)) {
    if ($e.X -ge (S 648) -and $e.X -le (S 684)) { $hit = 'close' }
    elseif ($e.X -ge (S 596) -and $e.X -le (S 632)) { $hit = 'min' }
  }
  if ($hit -ne $script:hdrHit) {
    $script:hdrHit = $hit
    $f.Invalidate()
  }
  if ($hit) { $f.Cursor = [System.Windows.Forms.Cursors]::Hand }
  elseif ($e.Y -le (S 64)) { $f.Cursor = [System.Windows.Forms.Cursors]::SizeAll }
  else { $f.Cursor = [System.Windows.Forms.Cursors]::Default }
})
$f.Add_MouseLeave({
  if ($script:hdrHit) { $script:hdrHit = ''; $f.Invalidate() }
  $f.Cursor = [System.Windows.Forms.Cursors]::Default
})
$f.Add_MouseDown({
  param($s, $e)
  if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
  $x = $e.X; $y = $e.Y
  if ($y -gt (S 64)) { return }
  if ($x -ge (S 648)) { $f.Close(); return }
  if ($x -ge (S 596) -and $x -le (S 632)) { HideToTray; return }
  [EtGui]::Drag($f)
})

$f.Add_Paint({ param($s, $e) Draw-All $e.Graphics })

function Update-Snapshot {
  if (-not (Test-Path -LiteralPath $stat)) { return }
  $raw = $null
  try { $raw = [System.IO.File]::ReadAllText($stat) } catch { return }
  if (-not $raw -or $raw -eq $script:lastRaw) { return }
  $j = $null
  try { $j = $raw | ConvertFrom-Json } catch { return }
  if (-not $j) { return }
  $script:lastRaw = $raw
  $script:snap = $j

  $tip = 'EasyTunnel 客户端'
  if ($j.state -eq 'online') { $tip = 'EasyTunnel · 在线 · 延迟 ' + [string]([int]$j.latency) + 'ms' }
  elseif ($j.state -eq 'connecting') { $tip = 'EasyTunnel · 连接中…' }
  elseif ($j.state -eq 'error' -or $j.state -eq 'offline') { $tip = 'EasyTunnel · 已断开' }
  if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }
  $ni.Text = $tip

  $f.Invalidate()
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
  if ($env:ET_CLIENT_PID) {
    try { [void][System.Diagnostics.Process]::GetProcessById([int]$env:ET_CLIENT_PID) }
    catch { try { $f.Close() } catch {}; return }
  }
  Update-Snapshot
})

$f.Add_Shown({
  try { [System.IO.File]::WriteAllText($env:ET_GUI_READY, '1') } catch {}
  try {
    $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $f.Location = [System.Drawing.Point]::new(
      [int]($wa.X + ($wa.Width - $f.Width) / 2),
      [int]($wa.Y + ($wa.Height - $f.Height) / 2))
  } catch {}
  $f.Activate()
  $f.BringToFront()
  $f.TopMost = $true
  $f.TopMost = $false
  Update-Snapshot
  $timer.Start()
})

$f.Add_FormClosing({
  $timer.Stop()
  $script:hintTimer.Stop()
  $ni.Visible = $false
  $ni.Icon = $null
  $ni.Dispose()
  if ($script:appIcon) { $script:appIcon.Dispose() }
  if ($script:logoBmp) { $script:logoBmp.Dispose() }
  $fTitle.Dispose(); $fSub.Dispose(); $fBody.Dispose(); $fLabel.Dispose(); $fSmall.Dispose(); $fCard.Dispose(); $fValue.Dispose()
  $script:bgBrush.Dispose(); $script:cardBrush.Dispose(); $script:inputBrush.Dispose()
  $script:brushText.Dispose(); $script:brushDim.Dispose(); $script:brushDim2.Dispose()
  $script:brushOk.Dispose(); $script:brushErr.Dispose(); $script:brushWarn.Dispose()
  $script:brushAccent.Dispose(); $script:brushBlue.Dispose(); $script:brushWhite.Dispose(); $script:brushSub.Dispose()
  $script:cardPen.Dispose(); $script:accentPen.Dispose(); $script:borderPen.Dispose(); $script:gridPen.Dispose()
  $script:chartOutPen.Dispose(); $script:chartInPen.Dispose(); $script:chartOutFill.Dispose(); $script:chartInFill.Dispose()
  $script:hdrLinePen.Dispose(); $script:hdrGlyphPen.Dispose(); $script:hdrHoverBrush.Dispose(); $script:glowBrush.Dispose()
  $script:hdrBrush.Dispose(); $script:sfEllipsis.Dispose()
})

[void][EtGui]::Round($f)
[System.Windows.Forms.Application]::Run($f)
