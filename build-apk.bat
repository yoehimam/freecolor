@echo off
echo ========================================================
echo   FreeColor Underwater - Build Android APK (Offline)
echo ========================================================

echo 1. Membangun bundle Vite (Offline Engine)...
call npm run build
if %errorlevel% neq 0 (
    echo Error saat build Vite!
    pause
    exit /b %errorlevel%
)

echo 2. Sinkronisasi aset web ke project Android Capacitor...
call npx cap sync android
if %errorlevel% neq 0 (
    echo Error saat sync Capacitor!
    pause
    exit /b %errorlevel%
)

echo 3. Membangun file APK Android...
cd android
if exist gradlew.bat (
    call gradlew.bat assembleDebug
    if %errorlevel% equ 0 (
        echo.
        echo ========================================================
        echo   SUKSES! APK berhasil dibuat:
        echo   android\app\build\outputs\apk\debug\app-debug.apk
        echo ========================================================
    ) else (
        echo.
        echo Gradle build membutuhkan Android SDK dan JDK terpasang di PC.
        echo Alternatif mudah: Buka folder "android" menggunakan Android Studio,
        echo lalu klik menu "Build" -^> "Build Bundle(s) / APK(s)" -^> "Build APK(s)".
    )
) else (
    echo File gradlew.bat tidak ditemukan.
)
cd ..
pause
