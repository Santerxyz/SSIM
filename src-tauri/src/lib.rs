// ════════════════════════════════════════════════════════════════════════════
//  SSIM — Tauri desktop shell.
//
//  Responsibilities (everything else lives in the Node backend, unchanged):
//   1. Spawn the SSIM Node backend as a HIDDEN sidecar (env SSIM_SIDECAR=1).
//   2. Learn the dashboard port from the sidecar's stdout line `SSIM_PORT=<n>`.
//   3. Wait until that port actually accepts connections, THEN open the native
//      window onto http://127.0.0.1:<port> — so there is no flash and no
//      "can't reach" error page.
//   4. On window close, ask the backend to shut down gracefully by writing
//      "quit" to its stdin (clean Steam logout); only exit once it has
//      terminated (watchdog force-kills if it hangs) so we never orphan it.
//   5. ON CRASH (owner directive — NO auto-restart band-aid): if the backend dies
//      UNEXPECTEDLY (anything that is NOT the user closing the window), the shell does
//      NOT respawn it. It records the exit code/signal + the backend's stderr to
//      logs/shell.log and shows a clear, persistent "SSIM crashed — relaunch" screen.
//      A crash must be FIXED, not hidden. Only an intentional window-close quits the shell.
//   6. Single instance: a second launch focuses the existing window.
// ════════════════════════════════════════════════════════════════════════════

use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, window::Color, webview::PageLoadEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// Boot splash is a BUNDLED asset (public/splash.html) loaded via the Tauri asset protocol in
// setup() below — WebView2 renders that reliably, whereas a top-level data: URL renders blank
// WHITE (that was the "white window before the password screen"). Shown the instant SSIM launches
// so a double-click never looks dead while the backend boots; replaced once the app is ready.

/// Shared state: the running sidecar (for the stdin "quit" + force-kill), the live
/// dashboard port, and an intentional-quit flag (so a user-initiated close is told
/// apart from an unexpected backend death — a crash).
struct AppState {
    sidecar: Mutex<Option<CommandChild>>,
    port: AtomicU16,
    /// True once the user has asked to close the app → distinguishes a clean quit from a crash.
    quitting: AtomicBool,
    /// True once the backend signaled `SSIM_UPDATING` on stdout → the next backend exit is an
    /// auto-update (swap both exes), so the shell must quit cleanly (free SSIM.exe), NOT crash-screen.
    updating: AtomicBool,
    /// The per-run capability token the backend prints as `SSIM_CAP=<token>`. Injected into the
    /// dashboard webview (window.__SSIM_CAP__) so the dashboard can authenticate its money/vault
    /// calls to the backend — delivered ONLY over this stdout pipe, never over HTTP (B26/P5).
    capability: Mutex<Option<String>>,
}

/// Byte cap for logs/shell.log before it rolls to shell.log.1 (one generation of history). Mirrors
/// the backend JS sinks' 5 MB roll (src/utils/rollLog.ts `rollIfLarge`, S47) — the shell's shell.log
/// had the identical unbounded-growth exposure on chatty/long-lived installs and was left uncapped.
const SHELL_LOG_MAX_BYTES: u64 = 5_000_000;

/// Append a timestamped line to <ssim_home>/logs/shell.log. This is the SHELL-side death record:
/// the backend's exit code/signal and any stderr it emitted before dying — captured here because
/// the backend's own JS handlers cannot see an external kill, and tauri-plugin-shell was previously
/// throwing this evidence away. Best-effort; never panics.
fn log_shell(msg: &str) {
    let dir = ssim_home().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    // S47-parity roll: bound shell.log's disk footprint. Before appending, if it has grown past the
    // cap, best-effort rename it to shell.log.1 (one generation). Ignore the Result — a raced rename
    // just means another line lands in the fresh file. shell_log_tail reads whatever the live file holds.
    let log_path = dir.join("shell.log");
    if let Ok(meta) = std::fs::metadata(&log_path) {
        if meta.len() > SHELL_LOG_MAX_BYTES {
            let _ = std::fs::rename(&log_path, dir.join("shell.log.1"));
        }
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
        use std::io::Write;
        let _ = f.write_all(format!("[{ts}] {msg}\n").as_bytes());
    }
}

/// Read the last `max_bytes` of logs/shell.log (the backend's captured stderr / last words) for the
/// crash marker banner + the optional webhook. Best-effort; returns "" on any error.
fn shell_log_tail(max_bytes: usize) -> String {
    let f = ssim_home().join("logs").join("shell.log");
    match std::fs::read(&f) {
        Ok(data) => {
            let start = data.len().saturating_sub(max_bytes);
            String::from_utf8_lossy(&data[start..]).to_string()
        }
        Err(_) => String::new(),
    }
}

/// B1: record an UNEXPECTED backend death to logs/last-crash.json so the NEXT launch can classify the
/// prior exit (C4 telemetry) and show a dismissible "SSIM crashed last run" banner. VISIBILITY ONLY —
/// the shell NEVER respawns (owner directive: a crash must be fixed, not hidden). Best-effort; no panic.
fn write_crash_marker(version: &str, code: Option<i32>, signal: Option<i32>, log_tail: &str) {
    let dir = ssim_home().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let at_ms: u64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let marker = serde_json::json!({
        "at": at_ms,
        "code": code,
        "signal": signal,
        "version": version,
        "logTail": log_tail,
    });
    let _ = std::fs::write(dir.join("last-crash.json"), marker.to_string());
}

/// B1 (optional): if SSIM_CRASH_WEBHOOK is set, POST a minimal crash notice so an UNATTENDED operator
/// machine can phone home instead of silently sitting on a crash screen (BACKEND_RELIABILITY.md F2). OFF
/// by default. Fired via the built-in curl.exe (Win10+/11 — no new crate); the body is written to a temp
/// file so the log tail is never shell-escaped. Detached + best-effort: a webhook failure never blocks
/// the crash UI, and this NEVER respawns anything — it only notifies (owner directive).
fn maybe_post_crash_webhook(version: &str, code: Option<i32>, log_tail: &str) {
    let url = match std::env::var("SSIM_CRASH_WEBHOOK") {
        Ok(u) if !u.is_empty() => u,
        _ => return,
    };
    // Keep the notice short (Discord-compatible `content`); the full tail stays in logs/shell.log.
    let short: String = {
        let s: Vec<char> = log_tail.chars().collect();
        let start = s.len().saturating_sub(1500);
        s[start..].iter().collect()
    };
    let content = format!(
        "\u{26a0}\u{fe0f} SSIM backend crashed (v{version}, exit code {}). Machine stayed DOWN — no auto-restart. Last shell.log:\n```\n{short}\n```",
        code.map(|c| c.to_string()).unwrap_or_else(|| "?".into())
    );
    let body = serde_json::json!({ "content": content }).to_string();
    let tmp = std::env::temp_dir().join(format!("ssim-crash-webhook-{}.json", std::process::id()));
    if std::fs::write(&tmp, body).is_err() {
        return;
    }
    let _ = std::process::Command::new("curl")
        .args(["-s", "-m", "10", "-X", "POST", "-H", "Content-Type: application/json", "--data-binary"])
        .arg(format!("@{}", tmp.display()))
        .arg(&url)
        .spawn();
    log_shell("posted crash webhook (SSIM_CRASH_WEBHOOK set)");
}

/// Pull the port out of a `SSIM_PORT=<n>` stdout line (ignores all other backend log lines).
fn parse_port(chunk: &str) -> Option<u16> {
    chunk.lines().find_map(|l| {
        l.trim()
            .strip_prefix("SSIM_PORT=")
            .and_then(|p| p.trim().parse::<u16>().ok())
    })
}

/// Pull the capability token out of a `SSIM_CAP=<token>` stdout line (B26/P5).
fn parse_capability(chunk: &str) -> Option<String> {
    chunk.lines().find_map(|l| {
        l.trim().strip_prefix("SSIM_CAP=").map(|t| t.trim().to_string())
    })
}

/// The JS that seeds the dashboard's capability token. The token is our own hex; JSON-ish
/// quoting is still applied so an unexpected value can't break out of the string literal.
fn capability_inject_js(token: &str) -> String {
    let safe: String = token.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    format!("window.__SSIM_CAP__='{safe}';")
}

/// The unauthenticated marker every SSIM server (dashboard + activation/unlock portals) serves at
/// GET /__ssim/health. The shell requires this in the response body before it adopts a port, so it
/// never navigates onto a DIFFERENT app that merely accepts TCP on the desired port. (BUG 2.)
const SSIM_HEALTH_PATH: &str = "/__ssim/health";
const SSIM_HEALTH_MARKER: &str = "SSIM-DASHBOARD-OK";

/// One HTTP/1.0 GET of the SSIM health marker over 127.0.0.1:<port>. Returns true ONLY if the
/// responder answers 200 AND the body contains the SSIM marker — a foreign app on the port fails.
fn probe_ssim_once(port: u16) -> bool {
    use std::io::{Read, Write};
    let sockaddr = match format!("127.0.0.1:{port}").parse() {
        Ok(s) => s,
        Err(_) => return false,
    };
    let mut stream = match std::net::TcpStream::connect_timeout(&sockaddr, Duration::from_millis(500)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1500)));
    let req = format!(
        "GET {SSIM_HEALTH_PATH} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut resp = String::new();
    // Cap the read so a chatty/foreign responder can't stream forever.
    let mut buf = [0u8; 4096];
    let mut total = 0usize;
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                resp.push_str(&String::from_utf8_lossy(&buf[..n]));
                total += n;
                if total >= 64 * 1024 { break; }
            }
            Err(_) => break,
        }
    }
    // Require a 200 status line AND the marker in the body — both must be SSIM's.
    let ok_status = resp.lines().next().map(|l| l.contains(" 200 ")).unwrap_or(false);
    ok_status && resp.contains(SSIM_HEALTH_MARKER)
}

/// Block until the port answers as SSIM (health marker verified), or time out. A bare TCP accept is
/// NOT enough — the responder must prove it is SSIM before the shell navigates to it. (BUG 2.)
fn wait_for_ssim(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if probe_ssim_once(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

/// The folder where the backend's runtime data (data/, Vault/, logs/) AND the self-extracted backend
/// (runtime/) live — the single writable base, passed to the backend as SSIM_HOME. An explicit
/// SSIM_HOME env wins (mirrors the backend's paths.ts; used by the build self-test to redirect to a
/// temp dir). Otherwise: packaged → the folder containing the shell exe (the portable folder); dev →
/// the repo root. A normal production launch never sets SSIM_HOME, so behavior is unchanged there.
fn ssim_home() -> std::path::PathBuf {
    if let Ok(h) = std::env::var("SSIM_HOME") {
        if !h.is_empty() {
            return std::path::PathBuf::from(h);
        }
    }
    if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
    } else {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_else(|| std::path::PathBuf::from("."))
    }
}

/// The SSIM Node backend, embedded INTO this shell at build time (build/make-tauri.js stages it →
/// build.rs copies it into OUT_DIR). Shipping it inside the shell is what makes SSIM ONE .exe.
static BACKEND_BYTES: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/ssim-backend.exe"));
/// Content stamp (len + FNV-1a) of BACKEND_BYTES, from build.rs. The extraction marker: we re-write
/// the 171 MB backend only when this changed (post-update) or the file is missing — never otherwise.
const BACKEND_STAMP: &str = env!("SSIM_BACKEND_STAMP");

/// S57: best-effort removal of stale `ssim-backend.exe.tmp*` fragments — a prior extraction that died
/// between the write and the rename left a ~171 MB file. Never fails the caller (cleanup is advisory).
fn sweep_stale_backend_tmp(dir: &std::path::Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with("ssim-backend.exe.tmp") {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}

/// Marker-guarded + atomic (temp + rename) extraction of the embedded backend into `dir`. A normal
/// launch returns near-instantly; only a CHANGED backend (new stamp) or a missing file triggers the
/// one-time 171 MB write. A failure is a HARD error reported to the caller — never silently retried
/// (owner directive: no band-aids). The target base varies by caller (see the two wrappers below).
fn ensure_backend_extracted_to(dir: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    if BACKEND_BYTES.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "this SSIM.exe was built with NO embedded backend — rebuild via build/make-tauri.js",
        ));
    }
    std::fs::create_dir_all(dir)?;
    let target = dir.join("ssim-backend.exe");
    let marker = dir.join(".backend-stamp");
    let current = std::fs::read_to_string(&marker).unwrap_or_default();
    if target.exists() && current == BACKEND_STAMP {
        return Ok(target); // this exact backend is already extracted
    }
    // S57: sweep any stale `ssim-backend.exe.tmp*` fragments a prior extraction left behind (each is ~171 MB)
    // before writing a fresh one, so a failed rename can't let them accumulate. Best-effort.
    sweep_stale_backend_tmp(dir);
    // Write to a temp file in the same dir, then atomically rename over the target. (The backend is
    // never running at this point — the shell always extracts BEFORE it spawns the child.)
    let tmp = dir.join(format!("ssim-backend.exe.tmp{}", std::process::id()));
    if let Err(e) = std::fs::write(&tmp, BACKEND_BYTES) {
        let _ = std::fs::remove_file(&tmp); // S57: don't strand a partial 171 MB fragment
        return Err(e);
    }
    let _ = std::fs::remove_file(&target);
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp); // S57: rename failed → sweep our own tmp, never strand 171 MB
        return Err(e);
    }
    std::fs::write(&marker, BACKEND_STAMP)?;
    log_shell(&format!("extracted embedded backend → {} (stamp {})", target.display(), BACKEND_STAMP));
    Ok(target)
}

/// The RUNTIME extraction: to <ssim_home>/runtime/ssim-backend.exe — the SAME writable base data/ uses,
/// so storage stays ONE location and the install stays fully portable (the runtime/ copy regenerates
/// from the exe on any machine).
fn ensure_backend_extracted() -> std::io::Result<std::path::PathBuf> {
    ensure_backend_extracted_to(&ssim_home().join("runtime"))
}

/// A STABLE cache dir for the SELF-TEST's extracted backend (C6). The updater runs the self-test with a
/// throwaway per-invocation SSIM_HOME (data isolation), so if the backend extracted THERE it would be
/// re-written 171 MB EVERY self-test and land on a fresh path AV has never scanned — a large part of why
/// a slow/AV-heavy machine blew its self-test budget (UPDATE_RELIABILITY.md §3.3). Extracting the exe to
/// ONE stable path instead means a repeated self-test (the C2 timeout escalation, the C1 cross-boot
/// reuse, the C3 per-boot re-check) SKIPS re-extraction and reuses AV's already-warm scan of that path.
/// Only the exe is shared (content-addressed by stamp); the child's DATA still uses the isolated SSIM_HOME.
fn selftest_runtime_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("ssim-selftest-runtime")
}

/// Remove a stray ssim-backend.exe sitting NEXT TO SSIM.exe — a leftover from the old two-file
/// layout after a single-exe migration. Best-effort; the embedded backend in runtime/ is authoritative.
fn cleanup_orphan_sidecar() {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let orphan = parent.join("ssim-backend.exe");
            if orphan.exists() {
                match std::fs::remove_file(&orphan) {
                    Ok(_) => log_shell("removed orphan ssim-backend.exe (migrated from the old two-file layout)"),
                    Err(e) => log_shell(&format!("could not remove orphan ssim-backend.exe: {e}")),
                }
            }
        }
    }
}

/// Replace the window contents with a clear, persistent fatal notice (same look as the crash screen).
/// Used when the backend can't even be PREPARED (extract/spawn failed) — a real error, never hidden.
fn show_fatal(handle: &tauri::AppHandle, title: &str, detail: &str) {
    let esc = |s: &str| s.replace('\\', "\\\\").replace('\'', "\\'").replace('\n', " ").replace('\r', " ");
    if let Some(w) = handle.get_webview_window("main") {
        let _ = w.eval(&format!(
            "document.documentElement.innerHTML='<div style=\"font:15px system-ui;color:#e5e7eb;background:#0a0a0f;height:100vh;margin:0;display:flex;flex-direction:column;gap:.6rem;align-items:center;justify-content:center;text-align:center;padding:2rem\"><div style=\"font-size:18px;font-weight:600\">{}</div><div style=\"opacity:.7\">{}</div><div style=\"opacity:.5;font-size:12px;margin-top:.6rem\">Details in logs/shell.log. Please relaunch SSIM.</div></div>';",
            esc(title), esc(detail)
        ));
        let _ = w.show();
    }
}

/// Anti-brick self-test passthrough: the updater runs `SSIM.exe` with SSIM_SELFTEST=1 before trusting
/// a downloaded build. We extract the embedded backend and run ITS self-test (the GC + steam stack
/// load check in src/index.ts), returning its exit code (0 ok / 2 fail) — no window, no Tauri. The
/// backend's report is also persisted to <home>/.ssim-selftest.out so the build/updater can read it
/// reliably even if a GUI-subsystem exe's inherited stdout doesn't survive the pipe.
fn run_backend_selftest() -> i32 {
    use std::io::Write;
    let t0 = Instant::now();
    // C6: extract to a STABLE cache (not the throwaway SSIM_HOME) so a repeated self-test skips the
    // 171 MB re-extraction and reuses AV's already-warm scan of that path.
    let path = match ensure_backend_extracted_to(&selftest_runtime_dir()) {
        Ok(p) => p,
        Err(e) => { eprintln!("SSIM_SELFTEST_FAIL extract: {e}"); return 2; }
    };
    let extract_ms = t0.elapsed().as_millis();
    let t1 = Instant::now();
    // S56: spawn + a BOUNDED wait instead of .output(). `.output()` blocks until the child's stdout pipe
    // hits EOF — i.e. until EVERY writer closes, INCLUDING a grandchild that inherited the handle. A
    // grandchild orphan that never exits would pin us (and the shared self-test cache exe) forever. We (a)
    // wait on the CHILD via try_wait (so once IT exits we proceed regardless of a lingering pipe writer),
    // and (b) hard-timeout as a backstop, killing the whole process tree on expiry. The updater's outer
    // execFileSync timeout is still the real budget; this is defence-in-depth.
    const SELFTEST_CHILD_TIMEOUT_SECS: u64 = 600;
    let mut child = match std::process::Command::new(&path)
        .env("SSIM_SIDECAR", "1")
        .env("SSIM_HOME", ssim_home().to_string_lossy().to_string())
        .env("SSIM_SELFTEST", "1")
        .stdout(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => { eprintln!("SSIM_SELFTEST_FAIL spawn: {e}"); return 2; }
    };
    // Drain stdout on a thread so a full pipe can never block the child; it delivers the bytes once the
    // pipe reaches EOF. If a grandchild holds the pipe open we simply won't receive them (empty stdout).
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    if let Some(mut so) = child.stdout.take() {
        std::thread::spawn(move || {
            use std::io::Read;
            let mut buf = Vec::new();
            let _ = so.read_to_end(&mut buf);
            let _ = tx.send(buf);
        });
    }
    let child_pid = child.id();
    let deadline = Instant::now() + std::time::Duration::from_secs(SELFTEST_CHILD_TIMEOUT_SECS);
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(2),
            Ok(None) => {
                if Instant::now() >= deadline {
                    eprintln!("SSIM_SELFTEST_FAIL timeout after {SELFTEST_CHILD_TIMEOUT_SECS}s — killing the self-test process tree");
                    let _ = child.kill();
                    // Best-effort TREE kill so a grandchild orphan can't keep the cache exe pinned.
                    let _ = std::process::Command::new("taskkill")
                        .args(["/F", "/T", "/PID", &child_pid.to_string()])
                        .output();
                    let _ = child.wait();
                    break 2;
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(e) => { eprintln!("SSIM_SELFTEST_FAIL wait: {e}"); break 2; }
        }
    };
    let boot_ms = t1.elapsed().as_millis();
    // Collect whatever stdout the child produced (a short grace after exit; empty if a grandchild pins the pipe).
    let stdout_bytes = rx.recv_timeout(std::time::Duration::from_millis(1000)).unwrap_or_default();
    // C6 PROFILE: the extract-vs-boot split, so a slow/AV-heavy machine's budget can be reasoned about from
    // REAL numbers rather than guessed. Emitted to shell.log + the file report + stdout.
    let profile = format!(
        "SSIM_SELFTEST_PROFILE extract={extract_ms}ms boot={boot_ms}ms total={}ms path={}",
        t0.elapsed().as_millis(), path.display()
    );
    log_shell(&profile);
    // Persist the backend's report AND the profile to <home>/.ssim-selftest.out (the file channel the
    // ≥1.2.4 updater reads).
    let mut report = stdout_bytes.clone();
    report.extend_from_slice(format!("\n{profile}\n").as_bytes());
    let _ = std::fs::write(ssim_home().join(".ssim-selftest.out"), &report);
    // C7: ALSO write the backend's stdout (which carries SSIM_SELFTEST_OK) to OUR inherited stdout handle,
    // so a v1.2.0–1.2.2 stdout-ONLY updater can still see the marker (Windows handle semantics).
    let _ = std::io::stdout().write_all(&stdout_bytes);
    let _ = std::io::stdout().write_all(format!("\n{profile}\n").as_bytes());
    let _ = std::io::stdout().flush();
    code
}

/// Open (or focus) the live-logs window. Triggered by the backend writing "SSIM_OPEN_LOGS" to its
/// stdout: the dashboard's "Live Logs" button POSTs /api/app/open-logs, the backend emits that line,
/// and the shell (already reading the sidecar's stdout) opens this window — no Tauri IPC needed in
/// the http://-loaded dashboard (Tauri withholds the IPC bridge from remote content).
fn open_logs_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("logs") {
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    let port = app.state::<AppState>().port.load(Ordering::SeqCst);
    if port == 0 {
        return;
    }
    let url = format!("http://127.0.0.1:{port}/logs.html");
    if let Ok(u) = url.parse() {
        let _ = WebviewWindowBuilder::new(app, "logs", WebviewUrl::External(u))
            .title("SSIM — Live Logs")
            .inner_size(1040.0, 660.0)
            .min_inner_size(640.0, 400.0)
            .build();
    }
}

/// Prepare + spawn the SSIM backend and wire up its stdout → window, its stderr → logs/shell.log, and
/// its termination → clean-quit-or-crash-notice (NO auto-restart). The backend is EMBEDDED in this exe
/// (BACKEND_BYTES) and self-extracted to <home>/runtime first; we then spawn THAT path. Everything
/// downstream (the stdout drain, port handshake, update + crash handling) is unchanged from the
/// two-binary build — embedding changed the backend's DELIVERY, not the runtime supervision contract.
fn spawn_backend(handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Prepare the embedded backend OFF the UI thread (first run / post-update writes ~171 MB while
        // the splash keeps painting). Marker-guarded → near-instant on every normal launch. A failure
        // here is a HARD, reported error — never a silent retry (owner directive: no band-aids).
        let prepared = tauri::async_runtime::spawn_blocking(ensure_backend_extracted).await;
        let backend_path = match prepared {
            Ok(Ok(p)) => p,
            err => {
                let msg = format!("{err:?}");
                log_shell(&format!("FATAL: could not prepare embedded backend: {msg}"));
                show_fatal(&handle, "SSIM could not prepare its backend.", &msg);
                return;
            }
        };
        // Drop a stray ssim-backend.exe left beside us by a migrated two-file install.
        cleanup_orphan_sidecar();

        // SSIM_SHELL_EXE tells the updater which OUTER exe to swap; SSIM_HOME is the single data/runtime
        // base; SSIM_SIDECAR keeps the backend in shell-managed (no-console) mode for the handshake.
        let shell_exe = std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let (mut rx, child) = match handle
            .shell()
            .command(backend_path.to_string_lossy().to_string())
            .env("SSIM_SIDECAR", "1")
            .env("SSIM_HOME", ssim_home().to_string_lossy().to_string())
            .env("SSIM_SHELL_EXE", shell_exe)
            .spawn()
        {
            Ok(v) => v,
            Err(e) => {
                log_shell(&format!("FATAL: failed to spawn backend: {e}"));
                show_fatal(&handle, "SSIM could not start its backend.", &e.to_string());
                return;
            }
        };
        *handle.state::<AppState>().sidecar.lock().unwrap() = Some(child);

        // One-shot per spawn: only the FIRST SSIM_PORT line of this backend instance opens/points the window.
        let mut handled_port = false;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let chunk = String::from_utf8_lossy(&bytes);
                    if chunk.contains("SSIM_OPEN_LOGS") {
                        open_logs_window(&handle);
                    }
                    // Capture the capability token the instant the backend prints it, so it is
                    // ready to inject the moment we open/point the window at the dashboard (B26/P5).
                    if let Some(cap) = parse_capability(&chunk) {
                        if !cap.is_empty() {
                            *handle.state::<AppState>().capability.lock().unwrap() = Some(cap);
                        }
                    }
                    // Auto-update lifecycle. The whole update (download → verify → install) runs BEFORE
                    // the backend's server/port exists, so without narration the splash looks frozen for
                    // minutes. Parse per-line so we can read the download percentage and reflect each
                    // phase on the splash via window.__ssimUpd (defined in splash.html). Token spellings
                    // mirror src/licensing/Updater.ts — keep them in sync.
                    for line in chunk.lines() {
                        let line = line.trim();
                        if let Some(rest) = line.strip_prefix("SSIM_UPDATE_PROGRESS::") {
                            // pct::haveMB::totalMB
                            let mut it = rest.split("::");
                            let pct = it.next().unwrap_or("0");
                            let have = it.next().unwrap_or("?");
                            let total = it.next().unwrap_or("?");
                            if let Some(w) = handle.get_webview_window("main") {
                                let _ = w.eval(&format!(
                                    "window.__ssimUpd&&window.__ssimUpd('Downloading update\\u2026 {pct}%','{have} / {total} MB downloaded',{pct});"
                                ));
                            }
                        } else if let Some(rest) = line.strip_prefix("SSIM_UPDATE_DOWNLOADING") {
                            let ver = rest.trim_start_matches("::").trim();
                            let head = if ver.is_empty() {
                                "Downloading update\\u2026".to_string()
                            } else {
                                format!("Downloading update v{ver}\\u2026")
                            };
                            if let Some(w) = handle.get_webview_window("main") {
                                let _ = w.eval(&format!(
                                    "window.__ssimUpd&&window.__ssimUpd('{head}','Getting the latest version \\u2014 please keep SSIM open.',0);"
                                ));
                            }
                        } else if line.contains("SSIM_UPDATE_VERIFYING") {
                            if let Some(w) = handle.get_webview_window("main") {
                                let _ = w.eval("window.__ssimUpd&&window.__ssimUpd('Verifying update\\u2026','Checking the new version is genuine \\u2014 almost there.',100);");
                            }
                        } else if line.contains("SSIM_UPDATING") {
                            // Auto-update is being applied: the backend will exit so its bat can swap BOTH
                            // exes. Mark it so the upcoming Terminated is a clean quit, not a crash.
                            handle.state::<AppState>().updating.store(true, Ordering::SeqCst);
                            log_shell("backend signaled SSIM_UPDATING — quitting cleanly for the swap (not a crash)");
                            if let Some(w) = handle.get_webview_window("main") {
                                let _ = w.eval("window.__ssimUpd&&window.__ssimUpd('Installing update\\u2026','SSIM will restart automatically in a moment.',100);");
                            }
                        }
                    }
                    if let Some(port) = parse_port(&chunk) {
                        if handled_port {
                            continue;
                        }
                        handled_port = true;
                        // Do the (blocking) port-probe + window open/point on a SEPARATE task so THIS
                        // reader keeps draining the sidecar's stdout. A 40s inline probe would stop
                        // draining the bounded stdout channel, and a backend that then writes to stdout
                        // would block on a full pipe → its event loop stalls (heartbeat + ssim.log
                        // freeze together). Never let window setup hold up the drain.
                        let h2 = handle.clone();
                        tauri::async_runtime::spawn(async move {
                            // Verify the responder is SSIM (health marker), not just "something accepts
                            // TCP" — never navigate onto a foreign app holding the port. (BUG 2.)
                            let ready = tauri::async_runtime::spawn_blocking(move || {
                                wait_for_ssim(port, Duration::from_secs(40))
                            })
                            .await
                            .unwrap_or(false);
                            if !ready {
                                eprintln!("[ssim] port {port} did not answer as SSIM (health marker) – not navigating");
                                return; // a never-listening / non-SSIM backend will hit Terminated → crash notice
                            }
                            h2.state::<AppState>().port.store(port, Ordering::SeqCst);
                            let url = format!("http://127.0.0.1:{port}");
                            // The capability token to seed into the dashboard (B26/P5). It arrived on
                            // stdout at/just before the port; poll briefly in the rare race where the
                            // port line was read first, so window.__SSIM_CAP__ is set before the user
                            // can trigger a money/vault action.
                            let cap = {
                                let mut c = h2.state::<AppState>().capability.lock().unwrap().clone();
                                let mut tries = 0;
                                while c.is_none() && tries < 40 {
                                    std::thread::sleep(Duration::from_millis(25));
                                    c = h2.state::<AppState>().capability.lock().unwrap().clone();
                                    tries += 1;
                                }
                                c
                            };
                            let inject = cap.as_deref().map(capability_inject_js);
                            if let Some(w) = h2.get_webview_window("main") {
                                // Existing window already present → point it at the backend URL.
                                if let Ok(u) = url.parse() {
                                    let _ = w.navigate(u);
                                }
                                // Seed the token once navigated. The immediate eval can land in the
                                // still-live splash document (pre-commit) and be discarded on navigation
                                // — the S1b race. Re-seed a couple of times AFTER the navigation commits
                                // so window.__SSIM_CAP__ reliably reaches the DASHBOARD document; the
                                // dashboard persists it to sessionStorage on receipt (S1), so a single
                                // landed eval survives every later in-webview reload for the process life.
                                if let Some(js) = &inject {
                                    let _ = w.eval(js);
                                    let h3 = h2.clone();
                                    let js2 = js.clone();
                                    tauri::async_runtime::spawn(async move {
                                        for delay_ms in [600u64, 1800u64] {
                                            let _ = tauri::async_runtime::spawn_blocking(move || {
                                                std::thread::sleep(Duration::from_millis(delay_ms))
                                            }).await;
                                            if let Some(w2) = h3.get_webview_window("main") {
                                                let _ = w2.eval(&js2);
                                            }
                                        }
                                    });
                                }
                                let _ = w.show();
                                let _ = w.set_focus();
                            } else if let Ok(u) = url.parse() {
                                // First start: build the window with the token as an initialization
                                // script so it is present BEFORE the dashboard's own scripts run.
                                let mut builder = WebviewWindowBuilder::new(&h2, "main", WebviewUrl::External(u))
                                    .title("SSIM")
                                    .inner_size(1280.0, 860.0)
                                    .min_inner_size(1024.0, 700.0)
                                    .center()
                                    .resizable(true);
                                if let Some(js) = &inject {
                                    builder = builder.initialization_script(js);
                                }
                                if let Err(e) = builder.build() {
                                    eprintln!("[ssim] failed to open window: {e}");
                                    std::process::exit(1);
                                }
                            }
                        });
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    // The backend's dying last-words (a native/V8 fatal line, or a vendor library
                    // writing to stderr) were previously DROPPED here. Capture them — for a death
                    // that bypasses the JS handlers this is often the only trace of what happened.
                    let chunk = String::from_utf8_lossy(&bytes);
                    let line = chunk.trim_end();
                    if !line.is_empty() {
                        log_shell(&format!("backend stderr: {line}"));
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let state = handle.state::<AppState>();
                    // Intentional quit (user closed the window) → follow the backend out cleanly.
                    if state.quitting.load(Ordering::SeqCst) {
                        log_shell("backend terminated after user close (clean quit)");
                        std::process::exit(0);
                    }
                    // AUTO-UPDATE: the backend exited so its bat can swap BOTH exes. Quit cleanly (NO
                    // crash screen) so SSIM.exe is freed; the bat relaunches a fresh SSIM.exe after the swap.
                    if state.updating.load(Ordering::SeqCst) {
                        log_shell("backend terminated for UPDATE — quitting so the swap can replace SSIM.exe");
                        std::process::exit(0);
                    }
                    // UNEXPECTED death = a CRASH. Per owner directive the auto-restart band-aid is
                    // GONE: a crash must be FIXED, not silently relaunched. Record the exit
                    // code/signal (the first time SSIM has ever captured it — the key diagnostic)
                    // and show a clear, persistent "crashed" screen. The shell stays alive so the
                    // notice + the on-disk evidence remain; NOTHING is respawned.
                    log_shell(&format!(
                        "BACKEND CRASH — terminated unexpectedly: code={:?} signal={:?} (auto-restart removed; no respawn)",
                        payload.code, payload.signal
                    ));
                    // B1: persist a crash marker so the NEXT launch shows a "crashed last run" banner +
                    // telemetry (C4), and — if SSIM_CRASH_WEBHOOK is configured — phone home so an
                    // unattended machine isn't silently down. NOTHING is respawned (owner directive).
                    let tail = shell_log_tail(4096);
                    let version = handle.package_info().version.to_string();
                    write_crash_marker(&version, payload.code, payload.signal, &tail);
                    maybe_post_crash_webhook(&version, payload.code, &tail);
                    if let Some(w) = handle.get_webview_window("main") {
                        let _ = w.eval(&format!(
                            "document.documentElement.innerHTML='<div style=\"font:15px system-ui;color:#e5e7eb;background:#0a0a0f;height:100vh;margin:0;display:flex;flex-direction:column;gap:.6rem;align-items:center;justify-content:center;text-align:center;padding:2rem\"><div style=\"font-size:18px;font-weight:600\">SSIM backend crashed (exit code {:?}).</div><div style=\"opacity:.75\">Your saved data is safe. Please relaunch SSIM.</div><div style=\"opacity:.5;font-size:12px;margin-top:.6rem\">Crash details saved to the logs folder (exit-trace.log / stderr-trace.log / shell.log).</div></div>';",
                            payload.code
                        ));
                    }
                    return; // window stays with the crash notice; NO auto-restart
                }
                _ => {}
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Anti-brick self-test passthrough: the updater runs `SSIM.exe` with SSIM_SELFTEST=1 before it
    // trusts a downloaded build. Extract + run the EMBEDDED backend's self-test and exit with its code
    // (0 ok / 2 fail) — no window, no Tauri. This is what keeps the update anti-brick gate working now
    // that the backend ships inside the shell. Must be the very first thing run() does.
    if std::env::var("SSIM_SELFTEST").as_deref() == Ok("1") {
        std::process::exit(run_backend_selftest());
    }
    // Kill the WebView2 white flash at the source. WebView2 paints its DefaultBackgroundColor
    // for the instant BEFORE the first HTML frame, and that default is WHITE — the window's own
    // dark background_color sits BEHIND the webview, so it can't cover this. This env var is read
    // by the WebView2 runtime when its environment is created (which Tauri does lazily on the first
    // window), so it MUST be set before the builder runs. Value is ARGB hex → FF0A0A0F = opaque
    // #0a0a0f (our canvas), so the pre-paint frame is already dark instead of white.
    std::env::set_var("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "FF0A0A0F");
    tauri::Builder::default()
        // Second launch → focus the existing window instead of starting a 2nd backend.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            sidecar: Mutex::new(None),
            port: AtomicU16::new(0),
            quitting: AtomicBool::new(false),
            updating: AtomicBool::new(false),
            capability: Mutex::new(None),
        })
        .setup(|app| {
            // Show a window IMMEDIATELY with a loading splash. The backend's boot + any 163 MB
            // auto-update happen BEFORE its server/port exists, so without this the window would only
            // appear much later (or never, during an update) and a launch looks like nothing happened.
            {
                // The updater's swap bat relaunches us with --ssim-updated after applying an update, so
                // this first boot is a post-update start: confirm it on the splash (the fresh exe re-
                // extracts its 171 MB backend, which would otherwise look like a generic slow launch).
                let just_updated = std::env::args().any(|a| a == "--ssim-updated");
                let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("splash.html".into()))
                    .title("SSIM")
                    .inner_size(1280.0, 860.0)
                    .min_inner_size(1024.0, 700.0)
                    .center()
                    .resizable(true)
                    // Paint the native window dark (#0a0a0f) so any sliver behind the webview is dark.
                    .background_color(Color(10, 10, 15, 255))
                    // The real white-flash killer: create the window HIDDEN and reveal it only once the
                    // (dark) page has actually PAINTED — a white pre-paint frame can never reach the
                    // screen. Fires for the splash first (≈instant), so the instant-splash UX is kept.
                    .visible(false)
                    .on_page_load(move |window, payload| {
                        if matches!(payload.event(), PageLoadEvent::Finished) {
                            if just_updated {
                                // No-op once navigated to the real app page (the ids/helper won't exist there).
                                let _ = window.eval("window.__ssimUpd&&window.__ssimUpd('Update installed \\u2014 starting SSIM\\u2026','You\\u2019re now on the latest version.');");
                            }
                            let _ = window.show();
                        }
                    })
                    .build();
            }
            // Prepare + spawn the EMBEDDED SSIM backend (hidden). On a crash it does NOT restart (owner directive).
            spawn_backend(app.handle().clone());
            // Safety net: reveal the window after a short delay even if the page-load event is missed,
            // so a launch never looks dead. Normally on_page_load shows it within ~tens of ms.
            let reveal = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                std::thread::sleep(Duration::from_millis(1500));
                if let Some(w) = reveal.get_webview_window("main") { let _ = w.show(); }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Only the MAIN window controls app lifetime; closing the logs window just closes it.
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let app = window.app_handle().clone();
                // INTENTIONAL quit: mark it so the backend's Terminated does NOT trigger an auto-restart.
                app.state::<AppState>().quitting.store(true, Ordering::SeqCst);
                // Ask the backend to shut down gracefully (clean Steam logout) via stdin.
                if let Some(child) = app.state::<AppState>().sidecar.lock().unwrap().as_mut() {
                    let _ = child.write(b"quit\n");
                }
                // Watchdog: if the backend hasn't terminated shortly, force-kill + exit so we
                // never orphan it. The normal path exits earlier via CommandEvent::Terminated.
                // 12s strictly exceeds the backend's bounded money-op quiesce budget (6s drain +
                // 3s hard-exit fallback) so a graceful drain completes before this backstop fires
                // (H-XCT-005). The backstop stays — a genuinely wedged backend is still killed.
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(12));
                    if let Some(child) = app.state::<AppState>().sidecar.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                    std::process::exit(0);
                });
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the SSIM shell")
        .run(|_app_handle, event| {
            // The shell's lifetime is tied to the SIDECAR, not the window: we exit via
            // std::process::exit when the backend terminates intentionally (or the close
            // watchdog fires), so block Tauri's default "last window closed → exit" from
            // cutting the backend's graceful shutdown short.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    // S57: the sweep removes ONLY stale `ssim-backend.exe.tmp*` fragments (a ~171 MB leftover from an
    // extraction that died before the rename), never the real backend or unrelated files.
    #[test]
    fn sweep_removes_only_backend_tmp_fragments() {
        let dir = std::env::temp_dir().join(format!("ssim-sweep-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("ssim-backend.exe.tmp123"), b"stale").unwrap();
        std::fs::write(dir.join("ssim-backend.exe.tmp456"), b"stale").unwrap();
        std::fs::write(dir.join("ssim-backend.exe"), b"real backend").unwrap();
        std::fs::write(dir.join("keep.txt"), b"unrelated").unwrap();

        sweep_stale_backend_tmp(&dir);

        assert!(!dir.join("ssim-backend.exe.tmp123").exists(), "a stale tmp fragment is swept");
        assert!(!dir.join("ssim-backend.exe.tmp456").exists(), "ALL stale tmp fragments are swept");
        assert!(dir.join("ssim-backend.exe").exists(), "the real extracted backend is kept");
        assert!(dir.join("keep.txt").exists(), "unrelated files are kept");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Sweeping a non-existent dir must never panic (best-effort).
    #[test]
    fn sweep_missing_dir_is_noop() {
        let dir = std::env::temp_dir().join(format!("ssim-sweep-none-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        sweep_stale_backend_tmp(&dir); // must not panic
    }

    // H-SHL-001: log_shell rolls shell.log to shell.log.1 once it grows past SHELL_LOG_MAX_BYTES
    // (S47-parity, one generation), so a chatty backend cannot grow it without bound.
    #[test]
    fn shell_log_rolls_past_cap() {
        let home = std::env::temp_dir().join(format!("ssim-shelllog-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let logs = home.join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        // Pre-seed shell.log just over the cap so the NEXT log_shell triggers the roll.
        let log_path = logs.join("shell.log");
        std::fs::write(&log_path, vec![b'x'; (SHELL_LOG_MAX_BYTES + 1) as usize]).unwrap();

        std::env::set_var("SSIM_HOME", &home);
        log_shell("post-cap line");
        std::env::remove_var("SSIM_HOME");

        assert!(logs.join("shell.log.1").exists(), "the over-cap log is rolled to shell.log.1");
        let fresh = std::fs::metadata(&log_path).unwrap().len();
        assert!(fresh < SHELL_LOG_MAX_BYTES, "shell.log is fresh (below the cap) after the roll");
        assert!(fresh > 0, "the new line still landed in the fresh shell.log");

        let _ = std::fs::remove_dir_all(&home);
    }
}
