@echo off
setlocal
title FreeColor Underwater Studio (4K + AI + Spektral) - tutup jendela ini untuk berhenti
cd /d "%~dp0.."

set "URL=http://localhost:8787"
set "HEALTH=http://127.0.0.1:8787/api/health"
set "SPEC_HEALTH=http://127.0.0.1:8799/health"

echo.
echo   ====================================================
echo   FREECOLOR UNDERWATER STUDIO (4K UHD + AI + SPEKTRAL)
echo   ====================================================
echo.

rem --- 1. Pastikan Mesin Spektral Python menyala (port 8799) ------------------
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri '%SPEC_HEALTH%' -ErrorAction Stop | Out-Null; exit 0 } catch { exit 1 }"
if not %errorlevel%==0 (
  if exist "service\.venv\Scripts\python.exe" (
    echo   [1/3] Menyalakan Mesin AI Spektral ^(udcp-retinex-lab-v2^)...
    start "" /b "service\.venv\Scripts\python.exe" "service\main.py"
  )
) else (
  echo   [1/3] Mesin AI Spektral sudah aktif.
)

rem --- 2. Sudah berjalan di port 8787? Langsung buka browser. -----------------
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri '%HEALTH%' -ErrorAction Stop | Out-Null; exit 0 } catch { exit 1 }"
if %errorlevel%==0 (
  echo   [2/3] Server utama sudah berjalan, membuka browser...
  start "" "%URL%"
  exit /b 0
)

rem --- 3. Dependensi + build otomatis bila belum ada / kode berubah -----------
if not exist "node_modules\" (
  echo   Memasang dependensi, sekali saja. Mohon tunggu...
  call npm install
  if errorlevel 1 goto :gagal
)

powershell -NoProfile -Command "$dist = 'dist\index.html'; if (-not (Test-Path $dist)) { exit 1 }; $dTime = (Get-Item $dist).LastWriteTime; $newer = Get-ChildItem -Path 'src' -Recurse -File | Where-Object { $_.LastWriteTime -gt $dTime }; if ($newer) { exit 1 } else { exit 0 }"
if not %errorlevel%==0 (
  echo   [2/3] Memperbarui tampilan antarmuka ^(build terbaru^)...
  call npm run build
  if errorlevel 1 goto :gagal
) else (
  echo   [2/3] Build antarmuka sudah versi terbaru.
)

rem --- 4. Buka browser setelah server siap, lalu jalankan server. -------------
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process '%URL%'"

echo   [3/3] Menjalankan Server Utama di %URL%
echo   Tutup jendela ini kapan saja untuk menghentikan aplikasi.
echo.
call npm start
exit /b 0

:gagal
echo.
echo   Gagal menjalankan FreeColor. Periksa pesan error di atas.
pause
exit /b 1
