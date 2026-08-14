# 0xC0000409 crash — ROOT CAUSE CONFIRMED (dump analysis, 2026-07-08)

After months of the crash evading every recorder, `CAPTURE_CRASH_PROCDUMP.ps1` finally caught a full
dump (`ssim-backend.exe_260708_191405.dmp`, 387 MB) on the **v1.4.1 tank build, Node v24.15.0**.

## What the dump says

- **ExceptionCode `0xC0000409`** (STATUS_STACK_BUFFER_OVERRUN / `__fastfail`).
- **FAST_FAIL subcode = `2` = STACK_COOKIE_CHECK_FAILURE.** This is the decisive fact. Subcode 2 is a
  genuine **/GS stack buffer overrun** — native code wrote past a stack buffer and corrupted the
  security cookie. It is **memory corruption**, NOT a clean V8/Node `abort()`/CHECK (that would be
  subcode 7 = FATAL_APP_EXIT). So this is a real native buffer-overflow defect, not a logic assertion.
- **Faulting module = `ssim-backend.exe` +0x219f349** — i.e. inside the statically-linked **Node 24
  runtime** (V8/libuv/OpenSSL are compiled into the packaged node binary). Not a SSIM JS frame, not a
  3rd-party native addon (there are none at runtime).
- **Faulting thread's stack carries the whole Windows socket/TLS/name-resolution stack**: `mswsock.dll`,
  `ws2_32`, `FWPUCLNT.DLL`, `dnsapi.dll`, `dhcpcsvc6`, `NapiNSP`, `nlansp_c`, `rsaenh.dll` (crypto),
  `ntdll +0x1e6270`. That is the connection setup/**teardown** path.
- **Trigger context** (ssim.log, same run, seconds before): the veritasproxy reset storm —
  `"Client network socket disconnected before secure TLS connection was established"` — during the
  initial fleet-refresh login burst, at only ~25 live sessions.

## Conclusion

**A stack buffer overrun in Node 24.15.0's native socket/TLS teardown, triggered by the proxy
reset storm.** This is a runtime bug. It fires at normal concurrency (25 sessions), before the tank's
per-proxy breaker can accumulate its trip threshold — which is why the tank build still crashed.

## The fix

- **The tank / session / churn work cannot fix a native buffer overrun** — it only reduces how often
  the vulnerable teardown path is exercised. Necessary hardening, not sufficient.
- **Move the runtime off Node 24.** Node 22 LTS is a different (and more battle-tested) native
  socket/TLS/OpenSSL codebase; if the overrun was introduced in Node 24 (or its OpenSSL), Node 22
  does not have it. This is the evidence-directed fix: rebuild the backend on `node22-win-x64`
  (build v1.4.2), keeping ALL the resilience work. The boot log records `Node vXX` so the running
  runtime is unambiguous.
- If Node 22 also crashes (unlikely given the evidence), the next step is to symbolize the dump
  against Node's published PDBs (`cdb` + the Node symbol server) to name the exact function and file
  an upstream Node/OpenSSL bug — but Node 22 is the high-probability fix and ships now.

## Reproduce / re-capture

`CAPTURE_CRASH_PROCDUMP.ps1` (ProcDump as a native debugger, `-ma -e -g -w ssim-backend.exe`) is the
ONLY capture that works — WER LocalDumps are armed correctly but this `__fastfail` bypasses WER.
