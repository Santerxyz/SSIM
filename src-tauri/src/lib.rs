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
//   5. Single instance: a second launch focuses the existing window.
// ════════════════════════════════════════════════════════════════════════════

use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Shared state: the running sidecar (for the stdin "quit" + force-kill) and a
/// one-shot guard so we only ever open the window once.
struct AppState {
    sidecar: Mutex<Option<CommandChild>>,
    opened: AtomicBool,
    port: AtomicU16,
}

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
            opened: AtomicBool::new(false),
            port: AtomicU16::new(0),
        })
        .setup(|app| {
            let handle = app.handle().clone();

            // Spawn the SSIM backend sidecar (hidden), piping stdio for the handshake + quit.
            let (mut rx, child) = app
                .shell()
                .sidecar("ssim-backend")
                .expect("ssim-backend sidecar binary not found")
                .env("SSIM_SIDECAR", "1")
                .env("SSIM_HOME", ssim_home().to_string_lossy().to_string())
                .spawn()
                .expect("failed to spawn ssim-backend sidecar");
            app.state::<AppState>().sidecar.lock().unwrap().replace(child);

            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            let chunk = String::from_utf8_lossy(&bytes);
                            if chunk.contains("SSIM_OPEN_LOGS") {
                                open_logs_window(&handle);
                            }
                            if let Some(port) = parse_port(&chunk) {
                                let state = handle.state::<AppState>();
                                if !state.opened.swap(true, Ordering::SeqCst) {
                                    let h = handle.clone();
                                    // Wait for the port off the async executor, then build the window.
                                    let ready = tauri::async_runtime::spawn_blocking(move || {
                                        wait_for_port(port, Duration::from_secs(40))
                                    })
                                    .await
                                    .unwrap_or(false);
                                    if !ready {
                                        eprintln!("[ssim] backend never opened port {port}");
                                        std::process::exit(1);
                                    }
                                    h.state::<AppState>().port.store(port, Ordering::SeqCst);
                                    let url = format!("http://127.0.0.1:{port}");
                                    if let Err(e) = WebviewWindowBuilder::new(
                                        &h,
                                        "main",
                                        WebviewUrl::External(url.parse().unwrap()),
                                    )
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
                            }
                        }
                        CommandEvent::Terminated(_) => {
                            // Backend exited (graceful quit finished, or it died) → shell follows.
                            std::process::exit(0);
                        }
                        _ => {}
                    }
                }
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
            // std::process::exit when the backend terminates (or the close watchdog fires),
            // so block Tauri's default "last window closed → exit" from cutting the backend's
            // graceful shutdown short.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
            }
        });
}
