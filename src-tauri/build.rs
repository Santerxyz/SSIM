// ════════════════════════════════════════════════════════════════════════════
//  build.rs — embed the SSIM Node backend INTO the shell so the product is ONE .exe.
//
//  build/make-tauri.js stages ssim-backend.exe at src-tauri/binaries/ssim-backend-<triple>.exe
//  BEFORE `tauri build`. Here we copy it into OUT_DIR (where lib.rs include_bytes!() reads it) and
//  expose a content STAMP (len + FNV-1a hash) as SSIM_BACKEND_STAMP, so the shell only re-extracts
//  the 171 MB backend when it actually changed (i.e. after an auto-update), not on every launch.
//
//  No staged backend (a bare `cargo build` / IDE check) → embed an EMPTY stub so include_bytes!
//  still compiles; the shell then reports a CLEAR runtime error instead of misbehaving silently.
//  A real release always goes through build/make-tauri.js, which stages the backend first.
// ════════════════════════════════════════════════════════════════════════════
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

/// Fast, dependency-free content hash for CHANGE DETECTION only (not security — update authenticity
/// is the Ed25519 signature in the updater). FNV-1a, 64-bit.
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Locate the staged backend: the target-triple name make-tauri.js writes, then a couple of fallbacks.
fn find_backend(manifest_dir: &Path) -> Option<PathBuf> {
    let triple = env::var("TARGET").unwrap_or_default();
    let candidates = [
        manifest_dir.join("binaries").join(format!("ssim-backend-{triple}.exe")),
        manifest_dir.join("binaries").join("ssim-backend.exe"),
        manifest_dir.join("..").join("ssim-backend.exe"), // repo-root output of build/pack.js
    ];
    candidates.into_iter().find(|p| p.exists())
}

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let dest = out_dir.join("ssim-backend.exe");

    let (bytes, present) = match find_backend(&manifest_dir) {
        Some(src) => {
            println!("cargo:rerun-if-changed={}", src.display());
            let data = fs::read(&src).expect("build.rs: failed to read staged ssim-backend.exe");
            (data, true)
        }
        None => {
            println!("cargo:warning=ssim-backend.exe not staged — building a shell with NO embedded backend. Run build/make-tauri.js for a real build.");
            (Vec::new(), false)
        }
    };

    fs::write(&dest, &bytes).expect("build.rs: failed to write embedded backend into OUT_DIR");
    let stamp = format!("{}-{:016x}", bytes.len(), fnv1a64(&bytes));
    println!("cargo:rustc-env=SSIM_BACKEND_STAMP={stamp}");
    println!("cargo:rustc-env=SSIM_BACKEND_PRESENT={}", if present { "1" } else { "0" });
    println!("cargo:rerun-if-changed={}", manifest_dir.join("binaries").display());

    tauri_build::build()
}
