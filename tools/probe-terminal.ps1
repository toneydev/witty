# probe-terminal.ps1 -- what does this terminal answer to graphics queries?
# Run it in a plain tab (not inside Claude Code):  pwsh -File tools\probe-terminal.ps1
# It prints what the terminal replies to each query, then draws a small sixel
# square. A terminal that supports sixel shows a red square after "sixel test:".

$ESC = [char]27
$BEL = [char]7

function Read-Reply([int]$TimeoutMs = 600) {
  $sb = New-Object System.Text.StringBuilder
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
    while ([Console]::KeyAvailable) {
      $k = [Console]::ReadKey($true)
      [void]$sb.Append($k.KeyChar)
      $sw.Restart()
    }
    Start-Sleep -Milliseconds 20
  }
  $s = $sb.ToString()
  if ($s.Length -eq 0) { return '(no reply)' }
  return ($s -replace $ESC, '<ESC>') -replace $BEL, '<BEL>'
}

function Probe([string]$Name, [string]$Query) {
  [Console]::Out.Write($Query)
  [Console]::Out.Flush()
  $r = Read-Reply
  Write-Host ("{0,-34} {1}" -f $Name, $r)
}

Write-Host "Terminal env: WT_SESSION=$($env:WT_SESSION -ne $null) TERM_PROGRAM=$env:TERM_PROGRAM TERM=$env:TERM KITTY_WINDOW_ID=$env:KITTY_WINDOW_ID WEZTERM_PANE=$env:WEZTERM_PANE"
Write-Host ""

# DA1: a ";4" in the list means sixel. Windows Terminal 1.22+ answers with 4 in it.
Probe 'DA1 (CSI c)'                       "$ESC[c"
# XTSMGRAPHICS: sixel geometry. Reply CSI ? 2 ; 0 ; W ; H S when supported.
Probe 'XTSMGRAPHICS sixel geometry'       "$ESC[?2;1;0S"
# Cell size in pixels: CSI 16 t -> CSI 6 ; height ; width t. Kitty graphics needs it.
Probe 'cell pixel size (CSI 16 t)'        "$ESC[16t"
# Window size in pixels: CSI 14 t -> CSI 4 ; height ; width t.
Probe 'window pixel size (CSI 14 t)'      "$ESC[14t"
# Window size in cells: CSI 18 t -> CSI 8 ; rows ; cols t. Pixel size / cells = exact cell size.
Probe 'window size in cells (CSI 18 t)'   "$ESC[18t"
Write-Host ("{0,-34} {1}x{2}" -f 'PowerShell says cols x rows', $Host.UI.RawUI.WindowSize.Width, $Host.UI.RawUI.WindowSize.Height)
# kitty graphics query: a terminal with the protocol answers  <ESC>_Gi=31;OK<ESC>\
# (1x1 RGB pixel, direct transport). Windows Terminal answers nothing.
Probe 'kitty graphics query (APC _G)'     "${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ESC}\"
# Same query the way Claude Code's readiness check phrases it (PNG, direct, quiet=2 never answers; shown for completeness).
Probe 'kitty keyboard query (CSI ? u)'    "$ESC[?u"

Write-Host ""
Write-Host -NoNewline "sixel test: "
# 24x12 red square: 2 bands of 6 rows; '~' = all six pixels set; '!24' repeats 24 times.
$six = "${ESC}Pq`"1;1;24;12#0;2;100;0;0#0!24~-!24~${ESC}\"
[Console]::Out.Write($six)
[Console]::Out.Flush()
Write-Host ""
Write-Host "(a red block above means sixel reached the terminal and was drawn)"
