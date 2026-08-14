@echo off
REM ============================================================================
REM  SSIM - development launcher.
REM
REM  This runs SSIM from compiled source, for working ON SSIM. If you just want
REM  to USE it, download SSIM.exe from the releases page instead - you do not
REM  need this file, Node, or a checkout.
REM
REM  No secrets, keys or config are required. If this ever asks you for one,
REM  that is a bug - please open an issue.
REM ============================================================================
title SSIM - development
cd /d "%~dp0"

REM --- Local web UI -----------------------------------------------------------
set "PORT=3000"
set "HOST=127.0.0.1"
REM  The app opens the browser itself once the vault is unlocked and the server
REM  is listening. (node runs skip auto-open by default, so enable it here.)
set "SSIM_OPEN_BROWSER=1"

REM --- Memory ceiling (diagnostic + safety net; see src/bootflags.ts) ---------
REM  Caps V8's old-space heap so a JS-heap leak dies as a CLEAN, logged V8 OOM
REM  (with a diagnostic report in logs/) instead of a silent OS memory-kill.
if not defined SSIM_HEAP_MB set "SSIM_HEAP_MB=3072"

REM --- Build once if dist is missing ------------------------------------------
if not exist "dist\index.js" (
  echo [SSIM] dist not found - building...
  call npm run build
  if errorlevel 1 (
    echo [SSIM] Build failed. Aborting.
    pause
    exit /b 1
  )
)

REM --- Port + single-instance are handled by the app itself (lockfile +
REM     dynamic port). No taskkill here - it would kill an unrelated app on 3000.

echo.
echo   Web UI : http://%HOST%:%PORT%  ^(if %PORT% is busy the app picks the next free port^)
echo.

node --max-old-space-size=%SSIM_HEAP_MB% dist\index.js

echo.
echo [SSIM] Server stopped.
pause
