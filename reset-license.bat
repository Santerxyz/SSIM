@echo off
REM ============================================================================
REM  SSIM – Reset license (removes the stored key + token on THIS machine)
REM  Use this if you want to see the activation page again.
REM ============================================================================
cd /d "%~dp0"
title SSIM - Reset License

del /q "data\license.key" 2>nul
del /q "data\license.token" 2>nul
del /q "data\license.token.json" 2>nul

echo.
echo   License reset done.
echo   The next start (start.bat / ssim.exe) will show the activation page again.
echo.
pause
