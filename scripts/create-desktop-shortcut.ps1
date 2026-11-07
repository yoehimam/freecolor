# Membuat shortcut "FreeColor Underwater" di Desktop dan di folder proyek (D:\free)
# yang menjalankan scripts\start-freecolor.bat.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$bat = Join-Path $root 'scripts\start-freecolor.bat'
if (-not (Test-Path -LiteralPath $bat)) { throw "launcher tidak ditemukan: $bat" }

# cmd membaca batch paling aman dengan akhir baris CRLF.
$text = (Get-Content -Raw -LiteralPath $bat) -replace "`r`n", "`n" -replace "`n", "`r`n"
[System.IO.File]::WriteAllText($bat, $text, (New-Object System.Text.UTF8Encoding($false)))

$rootBat = Join-Path $root 'Jalankan FreeColor.bat'
if (Test-Path -LiteralPath $rootBat) {
  $rText = (Get-Content -Raw -LiteralPath $rootBat) -replace "`r`n", "`n" -replace "`n", "`r`n"
  [System.IO.File]::WriteAllText($rootBat, $rText, (New-Object System.Text.UTF8Encoding($false)))
}

$ico = Get-ChildItem (Join-Path $root 'public') -Filter *.ico -ErrorAction SilentlyContinue | Select-Object -First 1
$shell = New-Object -ComObject WScript.Shell

$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'FreeColor Underwater.lnk'),
  (Join-Path $root 'FreeColor Underwater.lnk')
)

foreach ($lnk in $targets) {
  $sc = $shell.CreateShortcut($lnk)
  $sc.TargetPath = $bat
  $sc.WorkingDirectory = $root
  $sc.WindowStyle = 1
  $sc.Description = 'Jalankan FreeColor Underwater Studio (4K + AI + Spektral) lalu buka browser'
  if ($null -ne $ico) {
    $sc.IconLocation = $ico.FullName + ',0'
  } else {
    $sc.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"
  }
  $sc.Save()
  Write-Host "OK  shortcut : $lnk (exists: $(Test-Path -LiteralPath $lnk))"
}
