# WER_LOCALDUMPS.md — capture a full crash dump for the SSIM native fast-fail

**Purpose:** the June `0xC0000409` (STATUS_STACK_BUFFER_OVERRUN / `__fastfail`) death happens BELOW the
JS layer, so none of SSIM's own recorders (crash-log, exit-trace, WER defaults, `--report-on-fatalerror`)
capture it (`BACKEND_RELIABILITY.md` F1). A **WER LocalDump** is the one thing that names the faulting
native frame. This enables it for both SSIM executables so the NEXT recurrence writes a `.dmp` you can
send back.

> **Owner-run.** Do NOT let the assistant apply this to the build machine. Run it yourself, as an
> administrator, on the machine that crashes. It is a diagnostic capture — nothing about SSIM changes.

## Which executables

- **`SSIM.exe`** — the outer Tauri shell (the single-exe product).
- **`ssim-backend.exe`** — the Node backend the shell extracts to `…\SSIM\runtime\ssim-backend.exe` and
  runs as its child. **This is the process that fast-failed in the field** — the most important one.

WER LocalDumps keys are matched by the **image file name only** (not the path), so `ssim-backend.exe`
is covered wherever it self-extracts.

## Option A — `.reg` file (double-click, then "Yes" to the UAC/merge prompt)

Save as `ssim-localdumps.reg` and merge (needs admin). `DumpType=2` = **full** dump (required — a mini
dump often omits the native frame that fast-failed). Dumps land in `%LOCALAPPDATA%\CrashDumps`.

```reg
Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\SSIM.exe]
"DumpType"=dword:00000002
"DumpCount"=dword:0000000a
"DumpFolder"=hex(2):25,00,4c,00,4f,00,43,00,41,00,4c,00,41,00,50,00,50,00,44,00,41,00,54,00,41,00,25,00,5c,00,43,00,72,00,61,00,73,00,68,00,44,00,75,00,6d,00,70,00,73,00,00,00

[HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\ssim-backend.exe]
"DumpType"=dword:00000002
"DumpCount"=dword:0000000a
"DumpFolder"=hex(2):25,00,4c,00,4f,00,43,00,41,00,4c,00,41,00,50,00,50,00,44,00,41,00,54,00,41,00,25,00,5c,00,43,00,72,00,61,00,73,00,68,00,44,00,75,00,6d,00,70,00,73,00,00,00
```

(The `hex(2):…` blob is `%LOCALAPPDATA%\CrashDumps` as a `REG_EXPAND_SZ`.)

## Option B — PowerShell (run in an **elevated** PowerShell)

Equivalent to Option A, and easier to point at a custom folder. Paste the whole block:

```powershell
$dumpFolder = "$env:LOCALAPPDATA\CrashDumps"   # change if you want the dumps elsewhere
New-Item -ItemType Directory -Force -Path $dumpFolder | Out-Null
$base = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps'
foreach ($exe in 'SSIM.exe','ssim-backend.exe') {
  $key = Join-Path $base $exe
  New-Item -Path $key -Force | Out-Null
  New-ItemProperty -Path $key -Name 'DumpType'   -PropertyType DWord  -Value 2  -Force | Out-Null  # 2 = full dump
  New-ItemProperty -Path $key -Name 'DumpCount'  -PropertyType DWord  -Value 10 -Force | Out-Null
  New-ItemProperty -Path $key -Name 'DumpFolder' -PropertyType ExpandString -Value $dumpFolder -Force | Out-Null
}
Write-Host "WER LocalDumps enabled for SSIM.exe + ssim-backend.exe -> $dumpFolder"
```

No reboot or relaunch is needed — WER reads these keys at crash time. Leave it in place and keep using
SSIM normally.

## Where the dumps land

`%LOCALAPPDATA%\CrashDumps\` (e.g. `C:\Users\<you>\AppData\Local\CrashDumps\`). On the next crash you'll
see a file like `ssim-backend.exe.<pid>.dmp` (often 200–600 MB for a full dump of a big process — that
is expected and correct; `DumpCount=10` caps how many are kept).

## What to send back after a crash

1. The newest **`.dmp`** from `%LOCALAPPDATA%\CrashDumps\` (zip it — full dumps are large).
2. From the SSIM folder's **`logs\`** (next to the exe), the tail of: `shell.log`, `exit-trace.log`,
   `crash-log.txt`, `error.log`, `mem-heartbeat.log` — the timestamps around the crash. The
   `exit-trace.log` discriminator (present line = internal exit / absent = external kill) plus the dump
   is what pins the cause.
3. Roughly **what was happening** (e.g. "≈24 s into a full-fleet refresh through a flaky proxy") and the
   **exit code** the shell's crash screen showed.

## Turning it off later

```powershell
$base = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps'
Remove-Item -Path (Join-Path $base 'SSIM.exe') -Force -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path $base 'ssim-backend.exe') -Force -ErrorAction SilentlyContinue
```
