import { openBrowser } from './utils/openBrowser';
import { IS_PACKAGED } from './utils/paths';

// ════════════════════════════════════════════════════════════════════════════
//  appWindow.ts — surface the dashboard UI.
//
//  In a PACKAGED run SSIM shows itself: the Tauri desktop shell owns the window (sidecar
//  mode), and a headless deployment has no window by design — so this is a no-op there.
//  A DEV run delegates to openBrowser(), which itself opens the tab ONLY when SSIM_OPEN_BROWSER=1 (a plain `npm run dev` opens nothing by design — see openBrowser.ts).
//  (The old chromeless Edge "--app" window + its page-heartbeat were retired once the Tauri
//  shell reached parity — see git history / appAlive.ts removal.)
// ════════════════════════════════════════════════════════════════════════════

/** The single entry point boot code uses to surface the UI (see file header). */
export function openUiWindow(url: string): void {
  if (IS_PACKAGED) return; // packaged: the Tauri shell (or headless) handles the window
  openBrowser(url); // dev: opens the tab only if SSIM_OPEN_BROWSER=1 (opt-in); otherwise a no-op
}
