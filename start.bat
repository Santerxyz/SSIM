@echo off
REM ============================================================================
REM  SSIM – Santer Steam Inventory Manager  (the only launcher you need)
REM  Double-click to start. Opens the dashboard / license page in your browser.
REM ============================================================================
title SSIM - Santer Steam Inventory Manager
cd /d "%~dp0"

REM --- License backend secrets (kept OUT of this launcher) ---------------------
REM  Values live in secrets.local.bat (gitignored, never shipped). The packaged
REM  ssim.exe does not need them – they are baked in at build time.
if exist "secrets.local.bat" (
  call secrets.local.bat
) else (
  echo [SSIM] WARNING: secrets.local.bat missing - license environment not set.
  echo [SSIM] Cannot start without license secrets. Create secrets.local.bat ^(set LICENSE_API_URL / LICENSE_PUBLIC_KEY / LICENSE_PEPPER^) and retry.
  pause
  exit /b 1
)

REM --- Local web UI -----------------------------------------------------------
set "PORT=3000"
set "HOST=127.0.0.1"
REM  The app opens the browser ITSELF after the license + vault password succeed and the
REM  server is listening. (dev/node runs skip auto-open by default, so enable it here.)
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

REM --- Port + single-instance are handled by the app itself now (lockfile +
REM     dynamic port). No taskkill here - it would kill an unrelated app on 3000.

echo.
echo   License server : %LICENSE_API_URL%
echo   Web UI         : http://localhost:3000
echo.

REM --- Run the server as a clean monitor in this window -----------------------
REM  The app opens the browser ITSELF, but only AFTER the license check + the vault
REM  master-password prompt succeed and the server is listening. (No early timer
REM  open here — it would just show a blank page while the console waits for input.)
node --max-old-space-size=%SSIM_HEAP_MB% dist\index.js

echo.
echo [SSIM] Server stopped.
pause
