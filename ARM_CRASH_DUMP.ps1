# ARM_CRASH_DUMP.ps1 — capture a FULL native crash dump for the SSIM 0xC0000409 fast-fail.
#
# WHY: the crash you just hit (exit code -1073740791 = 0xC0000409 = STATUS_STACK_BUFFER_OVERRUN)
# is a NATIVE fast-fail below the JS layer, during a large fleet refresh through the flaky
# veritasproxy. None of SSIM's own recorders can see it — only a Windows WER LocalDump names the
# faulting native frame. This has been the missing piece since June; arm it and the NEXT crash
# writes a .dmp we can finally read.
#
# HOW: RIGHT-CLICK this file → "Run with PowerShell", OR open an ELEVATED PowerShell (Run as
# administrator) and run it. It only writes registry keys (reversible) — nothing about SSIM changes.
# No reboot/relaunch needed; WER reads the keys at crash time. Then just use SSIM normally.

$ErrorActionPreference = 'Stop'

# Must be elevated (HKLM write).
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
          ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Not elevated — relaunching as administrator..." -ForegroundColor Yellow
  Start-Process powershell -Verb RunAs -ArgumentList "-NoExit","-ExecutionPolicy","Bypass","-File","`"$PSCommandPath`""
  return
}

$dumpFolder = "$env:LOCALAPPDATA\CrashDumps"
New-Item -ItemType Directory -Force -Path $dumpFolder | Out-Null
$base = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps'
foreach ($exe in 'SSIM.exe','ssim-backend.exe') {
  $key = Join-Path $base $exe
  New-Item -Path $key -Force | Out-Null
  New-ItemProperty -Path $key -Name 'DumpType'   -PropertyType DWord        -Value 2  -Force | Out-Null  # 2 = FULL dump (names the native frame)
  New-ItemProperty -Path $key -Name 'DumpCount'  -PropertyType DWord        -Value 10 -Force | Out-Null
  New-ItemProperty -Path $key -Name 'DumpFolder' -PropertyType ExpandString -Value $dumpFolder -Force | Out-Null
}
Write-Host ""
Write-Host "  WER LocalDumps ARMED for SSIM.exe + ssim-backend.exe" -ForegroundColor Green
Write-Host "  Dumps will land in: $dumpFolder" -ForegroundColor Green
Write-Host ""
Write-Host "  Now reproduce the crash (run a full-fleet refresh). After it crashes, send me the newest"
Write-Host "  ssim-backend.exe.<pid>.dmp from that folder (zip it — full dumps are large) plus the logs\ tail."
