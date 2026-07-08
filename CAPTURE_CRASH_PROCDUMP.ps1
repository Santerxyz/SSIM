# CAPTURE_CRASH_PROCDUMP.ps1 — capture a REAL dump of the SSIM 0xC0000409 native fast-fail.
#
# WHY (not WER): the crash is a __fastfail / STATUS_STACK_BUFFER_OVERRUN that BYPASSES Windows Error
# Reporting — I confirmed your LocalDumps keys were correctly armed yet no dump appeared, because this
# class of abort skips the WER trigger (and WerSvc was stopped). ProcDump, run as a NATIVE DEBUGGER
# (-g), sits underneath and catches the fast-fail that WER never sees.
#
# HOW: 1) CLOSE SSIM completely first.  2) Right-click this file -> "Run with PowerShell" (it self-
#      elevates).  3) It downloads ProcDump (Microsoft Sysinternals) and starts WAITING for the SSIM
#      backend.  4) THEN launch SSIM normally and run a full-fleet refresh to reproduce the crash.
#      When it fast-fails, ProcDump writes a full .dmp and prints the path. Send me that .dmp (zipped).
#
# Nothing about SSIM changes. ProcDump just watches the backend process.

$ErrorActionPreference = 'Stop'
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
          ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Relaunching as administrator..." -ForegroundColor Yellow
  Start-Process powershell -Verb RunAs -ArgumentList "-NoExit","-ExecutionPolicy","Bypass","-File","`"$PSCommandPath`""
  return
}

$work = Join-Path $env:LOCALAPPDATA 'ssim-procdump'
$dumpDir = Join-Path $env:LOCALAPPDATA 'CrashDumps'
New-Item -ItemType Directory -Force -Path $work, $dumpDir | Out-Null
$pd = Join-Path $work 'procdump64.exe'

if (-not (Test-Path $pd)) {
  Write-Host "Downloading ProcDump (Sysinternals)..." -ForegroundColor Cyan
  $zip = Join-Path $work 'Procdump.zip'
  try {
    Invoke-WebRequest -Uri 'https://download.sysinternals.com/files/Procdump.zip' -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $work -Force
  } catch {
    Write-Host "Could not download ProcDump automatically: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Get it manually from https://learn.microsoft.com/sysinternals/downloads/procdump, put procdump64.exe in:`n  $work`nthen re-run this script." -ForegroundColor Yellow
    return
  }
}

if (-not (Test-Path $pd)) { $pd = Join-Path $work 'procdump.exe' }

Write-Host ""
Write-Host "  ProcDump is now WAITING for ssim-backend.exe." -ForegroundColor Green
Write-Host "  >>> Make sure SSIM is CLOSED, then LAUNCH SSIM and run a full-fleet refresh. <<<" -ForegroundColor Green
Write-Host "  On the fast-fail it will write a full dump into: $dumpDir" -ForegroundColor Green
Write-Host "  (Leave this window open. Ctrl+C to stop watching.)" -ForegroundColor DarkGray
Write-Host ""

# -ma full dump · -e unhandled exception (2nd chance) · -g run as a native debugger (catches the
# __fastfail WER misses) · -w wait for the not-yet-running backend the shell spawns after launch.
& $pd -accepteula -ma -e -g -w 'ssim-backend.exe' $dumpDir
