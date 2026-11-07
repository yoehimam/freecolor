@echo off
title Upload FreeColor ke GitHub
echo =======================================================
echo   MENGUNGGAH PROYEK KE GITHUB:
echo   https://github.com/yoehimam/freecolor.git
echo =======================================================
echo.
cd /d d:\free
echo Menjalankan git push ke branch main...
git push -u origin main
echo.
if %errorlevel% equ 0 (
    echo =======================================================
    echo   SUKSES! KODE BERHASIL TERUNGGAH!
    echo.
    echo   Silakan buka browser Anda di:
    echo   https://github.com/yoehimam/freecolor/actions
    echo.
    echo   GitHub sedang otomatis merakit file FreeColor APK.
    echo =======================================================
) else (
    echo.
    echo Gagal. Jika muncul browser meminta izin, silakan klik Authorize/Login.
)
echo.
pause
