// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // Route any shell panic (e.g. a boot-time `.build(...).expect(...)` under the console-less
  // `windows` subsystem, whose stderr is otherwise discarded) into logs/shell.log — the file the
  // crash banner tells users to check. Diagnostics only; no respawn (owner no-band-aid directive).
  app_lib::install_panic_hook();
  app_lib::run();
}
