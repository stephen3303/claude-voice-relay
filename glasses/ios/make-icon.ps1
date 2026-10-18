# Regenerates the app icon: powershell -File make-icon.ps1 -Out GlassesRelayAssets.xcassetsAppIcon.appiconsetAppIcon-1024.png
﻿param([string]$Out)
Add-Type -AssemblyName System.Drawing
$S = 1024
$bmp = New-Object System.Drawing.Bitmap $S, $S, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)  # iOS icons must be opaque
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'; $g.PixelOffsetMode = 'HighQuality'

# Background: deep navy to indigo, top-left to bottom-right.
$rect = New-Object System.Drawing.Rectangle 0, 0, $S, $S
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(14, 23, 48)), ([System.Drawing.Color]::FromArgb(52, 38, 120)), 45.0
$g.FillRectangle($bg, $rect)

# One lens: a wayfarer shape, wider at the top.
function Lens([float]$cx, [float]$cy) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $w = 268; $h = 200
  $pts = @(
    (New-Object System.Drawing.PointF ($cx - $w/2), ($cy - $h/2)),
    (New-Object System.Drawing.PointF ($cx + $w/2), ($cy - $h/2)),
    (New-Object System.Drawing.PointF ($cx + $w/2 - 28), ($cy + $h/2)),
    (New-Object System.Drawing.PointF ($cx - $w/2 + 28), ($cy + $h/2))
  )
  $p.AddClosedCurve($pts, 0.28)
  return $p
}
$cy = 660
$left = Lens 330 $cy
$right = Lens 694 $cy

$white = [System.Drawing.Color]::FromArgb(248, 248, 252)
$frame = New-Object System.Drawing.Pen $white, 46
$frame.LineJoin = 'Round'
$tint = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(70, 140, 170, 255))
$g.FillPath($tint, $left); $g.FillPath($tint, $right)
$g.DrawPath($frame, $left); $g.DrawPath($frame, $right)

# Bridge between the lenses.
$bridge = New-Object System.Drawing.Pen $white, 40
$bridge.StartCap = 'Round'; $bridge.EndCap = 'Round'
$g.DrawArc($bridge, 466, ($cy - 108), 92, 70, 205, 130)

# Sound waves rising from the bridge: the voice.
$accent = [System.Drawing.Color]::FromArgb(255, 160, 90)
foreach ($i in 0..2) {
  $r = 90 + $i * 85
  $a = 255 - $i * 60
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb($a, $accent)), 34
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
  $g.DrawArc($pen, (512 - $r), (490 - $r), (2 * $r), (2 * $r), 235, 70)
}

$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"saved $Out"


