# 시험용 가짜 한글·워드 COM 객체 (New-Object -ComObject 를 대신한다). test/convert.test.js 에서 변환 스크립트 앞에 붙여 쓴다.
function New-Object {
  param([string]$ComObject)
  $log = $env:DM_MOCKLOG
  if ($ComObject -eq 'HWPFrame.HwpObject') {
    $win = [pscustomobject]@{ Visible = $true }
    $wins = [pscustomobject]@{ W = $win }
    $wins | Add-Member ScriptMethod Item { param($i) $this.W }
    $o = [pscustomobject]@{ XHwpWindows = $wins }
    $o | Add-Member ScriptMethod RegisterModule { param($a, $b) $true }
    $o | Add-Member ScriptMethod Open { param($p, $f, $a) Add-Content -Encoding UTF8 $env:DM_MOCKLOG "open $p [$f] [$a]"; return ($env:DM_MOCKFAIL -ne 'open') }
    $o | Add-Member ScriptMethod SaveAs { param($p, $f, $a) Add-Content -Encoding UTF8 $env:DM_MOCKLOG "saveas $p [$f]"; if ($env:DM_MOCKFAIL -eq 'save') { return $false }; Set-Content -Path $p -Value 'converted'; return $true }
    $o | Add-Member ScriptMethod Clear { param($x) Add-Content -Encoding UTF8 $env:DM_MOCKLOG "clear $x" }
    $o | Add-Member ScriptMethod Quit { Add-Content -Encoding UTF8 $env:DM_MOCKLOG "quit" }
    return $o
  }
  if ($ComObject -eq 'Word.Application') {
    $docs = [pscustomobject]@{}
    $docs | Add-Member ScriptMethod Open { param($p, $c, $r, $a) Add-Content -Encoding UTF8 $env:DM_MOCKLOG "word open $p ro=$r"; $d = [pscustomobject]@{}; $d | Add-Member ScriptMethod SaveAs2 { param($p, $f) Add-Content -Encoding UTF8 $env:DM_MOCKLOG "word saveas $p fmt=$f"; Set-Content -Path $p -Value 'pdf' }; $d | Add-Member ScriptMethod Close { param($s) Add-Content -Encoding UTF8 $env:DM_MOCKLOG "word close $s" }; return $d }
    $o = [pscustomobject]@{ Visible = $true; DisplayAlerts = 1; Documents = $docs }
    $o | Add-Member ScriptMethod Quit { Add-Content -Encoding UTF8 $env:DM_MOCKLOG "word quit" }
    return $o
  }
  throw "no com"
}
