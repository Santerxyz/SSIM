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
//   5. RESILIENCE: if the backend dies UNEXPECTEDLY (an external kill, a fatal,
//      anything that is NOT the user closing the window), AUTOMATICALLY RESPAWN it
//      and point the window back at it — so a refresh/trade/sell can never leave
//      the app dead with its state "wiped". Only an intentional window-close quits.
//   6. Single instance: a second launch focuses the existing window.
// ════════════════════════════════════════════════════════════════════════════

use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Shared state: the running sidecar (for the stdin "quit" + force-kill), the live
/// dashboard port, an intentional-quit flag (so an unexpected death auto-restarts but
/// a user close does not), and a sliding window of recent restart times (crash-loop guard).
struct AppState {
    sidecar: Mutex<Option<CommandChild>>,
    port: AtomicU16,
    /// True once the user has asked to close the app → a subsequent backend exit must NOT restart.
    quitting: AtomicBool,
    /// Timestamps of recent auto-restarts, pruned to a 120s window (crash-loop backstop).
    restarts: Mutex<Vec<Instant>>,
}

/// How many unexpected backend deaths we will auto-restart within RESTART_WINDOW before giving up.
const MAX_RESTARTS: usize = 8;
const RESTART_WINDOW: Duration = Duration::from_secs(120);
const RESTART_BACKOFF: Duration = Duration::from_millis(800);

/// Pull the port out of a `SSIM_PORT=<n>` stdout line (ignores all other backend log lines).
fn parse_port(chunk: &str) -> Option<u16> {
    chunk.lines().find_map(|l| {
        l.trim()
            .strip_prefix("SSIM_PORT=")
            .and_then(|p| p.trim().parse::<u16>().ok())
    })
}

/// Block until 127.0.0.1:<port> accepts a TCP connection (the server is listening) or time out.
fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let sockaddr = match format!("127.0.0.1:{port}").parse() {
        Ok(s) => s,
        Err(_) => return false,
    };
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if std::net::TcpStream::connect_timeout(&sockaddr, Duration::from_millis(500)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

/// The folder where the backend's runtime data (data/, Vault/, logs/) should live, passed to the
/// sidecar as SSIM_HOME. Packaged → the folder containing the shell exe (the portable folder);
/// dev → the repo root (so the sidecar uses the real local data/ + Vault/).
fn ssim_home() -> std::path::PathBuf {
    if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
    } else {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_else(|| std::path::PathBuf::from("."))
    }
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

/// Spawn (or RESPAWN) the SSIM backend sidecar and wire up its stdout → window + its termination →
/// graceful-quit-or-auto-restart. `forced_port` re-uses the previous port across a restart so the
/// existing window can simply be re-pointed at the new backend (seamless reconnect, no new window).
fn spawn_backend(handle: tauri::AppHandle, forced_port: Option<u16>) {
    let mut cmd = handle
        .shell()
        .sidecar("ssim-backend")
        .expect("ssim-backend sidecar binary not found")
        .env("SSIM_SIDECAR", "1")
        .env("SSIM_HOME", ssim_home().to_string_lossy().to_string());
    // On a restart, bias the backend to the SAME port it used before (it is free now that the old
    // process has exited), so the window can be re-pointed at an unchanged URL.
    if let Some(p) = forced_port {
        cmd = cmd.env("PORT", p.to_string());
    }
    let (mut rx, child) = cmd.spawn().expect("failed to spawn ssim-backend sidecar");
    *handle.state::<AppState>().sidecar.lock().unwrap() = Some(child);

    tauri::async_runtime::spawn(async move {
        // One-shot per spawn: only the FIRST SSIM_PORT line of this backend instance opens/points the window.
        let mut handled_port = false;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let chunk = String::from_utf8_lossy(&bytes);
                    if chunk.contains("SSIM_OPEN_LOGS") {
                        open_logs_window(&handle);
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
                            let ready = tauri::async_runtime::spawn_blocking(move || {
                                wait_for_port(port, Duration::from_secs(40))
                            })
                            .await
                            .unwrap_or(false);
                            if !ready {
                                eprintln!("[ssim] backend never opened port {port} — will restart on exit");
                                return; // a never-listening backend exits → Terminated handles the restart
                            }
                            h2.state::<AppState>().port.store(port, Ordering::SeqCst);
                            let url = format!("http://127.0.0.1:{port}");
                            if let Some(w) = h2.get_webview_window("main") {
                                // RESTART path: re-point the existing window at the respawned backend.
                                if let Ok(u) = url.parse() {
                                    let _ = w.navigate(u);
                                }
                                let _ = w.show();
                                let _ = w.set_focus();
                            } else if let Ok(u) = url.parse() {
                                // First start: build the window.
                                if let Err(e) = WebviewWindowBuilder::new(&h2, "main", WebviewUrl::External(u))
                                    .title("SSIM")
                                    .inner_size(1280.0, 860.0)
                                    .min_inner_size(1024.0, 700.0)
                                    .center()
                                    .resizable(true)
                                    .build()
                                {
                                    eprintln!("[ssim] failed to open window: {e}");
                                    std::process::exit(1);
                                }
                            }
                        });
                    }
                }
                CommandEvent::Terminated(_) => {
                    let state = handle.state::<AppState>();
                    // Intentional quit (user closed the window) → follow the backend out cleanly.
                    if state.quitting.load(Ordering::SeqCst) {
                        std::process::exit(0);
                    }
                    // UNEXPECTED death (external kill / fatal) → auto-restart so the app + state survive.
                    let port = {
                        let p = state.port.load(Ordering::SeqCst);
                        if p == 0 { None } else { Some(p) }
                    };
                    let too_many = {
                        let mut times = state.restarts.lock().unwrap();
                        let now = Instant::now();
                        times.retain(|t| now.duration_since(*t) < RESTART_WINDOW);
                        times.push(now);
                        times.len() > MAX_RESTARTS
                    };
                    if too_many {
                        eprintln!("[ssim] backend died repeatedly (>{MAX_RESTARTS} in {}s) — giving up", RESTART_WINDOW.as_secs());
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.eval(
                                "document.documentElement.innerHTML='<div style=\"font:16px system-ui;color:#e5e7eb;background:#0a0a0f;height:100vh;margin:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:2rem\">SSIM stopped unexpectedly and could not be restarted.<br>Please relaunch SSIM — your saved data is safe.</div>';",
                            );
                        }
                        return; // leave the window with the message; the user relaunches
                    }
                    eprintln!("[ssim] backend exited unexpectedly — restarting…");
                    std::thread::sleep(RESTART_BACKOFF);
                    spawn_backend(handle.clone(), port);
                    return; // this reader task ends; the respawned backend has its own
                }
                _ => {}
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            restarts: Mutex::new(Vec::new()),
        })
        .setup(|app| {
            // Spawn the SSIM backend sidecar (hidden); it auto-restarts on an unexpected exit.
            spawn_backend(app.handle().clone(), None);
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
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(8));
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
