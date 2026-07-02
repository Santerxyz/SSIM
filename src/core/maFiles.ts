import fs from 'fs';
import path from 'path';
import type { MaFile } from '../types/account';
import { maFilesDir } from '../utils/paths';

// ════════════════════════════════════════════════════════════════════════════
//  Shared "drop-zone" helpers for the mafiles/ folder (the import source).
//  Used by the boot migration, the "Import bots" route, and the login flow's
//  disk fallback. These touch ONLY the plaintext source files and NEVER delete
//  them — the vault is the runtime source of truth once unlocked.
// ════════════════════════════════════════════════════════════════════════════

const MA_FILES_DIR = maFilesDir();

/**
 * Resolves a maFile reference to a path INSIDE the ./mafiles/ drop zone. Containment
 * (B23): a client-supplied maFilePath reaches this from POST/PATCH /api/accounts and
 * attach-mafile; an absolute path (C:/Windows/win.ini) or a `../` traversal must never
 * read outside the drop zone (arbitrary file existence/JSON probing + importing any file
 * bearing a shared_secret). We strip ALL directory components with path.basename, so the
 * result is always mafiles/<name> — the same rule the plaintext bulk-import path uses.
 * The drop zone is flat (listDropZoneMaFiles doesn't recurse), so no legit reference is
 * broken. An empty/dot basename resolves to the dir itself and fails the existsSync below.
 */
export function resolveMaFilePath(maFilePath: string): string {
  const base = path.basename(String(maFilePath ?? ''));
  // basename('..') is still '..' (and '' / '.' are non-files) — map every dot/empty name to a
  // literal, contained, non-existent filename so no input can ever resolve to the dir or above it.
  if (!base || base === '.' || base === '..') return path.join(MA_FILES_DIR, '__invalid__.maFile');
  return path.join(MA_FILES_DIR, base);
}

/** Reads + parses a maFile from DISK (plaintext source). Throws on missing/invalid. */
export function loadMaFileFromDisk(maFilePath: string): MaFile {
  const filePath = resolveMaFilePath(maFilePath);
  if (!fs.existsSync(filePath)) throw new Error(`maFile not found: ${filePath}`);
  const raw = fs.readFileSync(filePath, 'utf-8');
  let mf: MaFile;
  try { mf = JSON.parse(raw) as MaFile; } catch { throw new Error(`maFile is not valid JSON: ${filePath}`); }
  if (!mf.shared_secret) throw new Error(`maFile missing shared_secret: ${filePath}`);
  return mf;
}

/** Parses mafiles/accounts.txt → Map<lowercaseUsername, password>. */
export function readCredentialsFile(): Map<string, string> {
  const map = new Map<string, string>();
  const file = path.join(MA_FILES_DIR, 'accounts.txt');
  if (!fs.existsSync(file)) return map;
  for (const raw of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const user = line.slice(0, idx).trim();
    const pass = line.slice(idx + 1); // passwords may legitimately contain ':'
    if (user) map.set(user.toLowerCase(), pass);
  }
  return map;
}

// ── CSV import (username,password,shared_secret,identity_secret) ────────────────

export interface CsvAccount { username: string; password: string; shared_secret: string; identity_secret: string; }

/** Splits one CSV line, honouring double-quoted fields (so a password may contain commas). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false; }
      else cur += c;
    } else if (c === '"') { inQuotes = true; }
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Parses a CSV of `username,password,shared_secret,identity_secret` rows. Skips blank/`#`
 * lines and an optional header row. Requires username+password+shared_secret; identity_secret
 * may be empty (trade confirmations then won't work for that bot, same as a maFile without it).
 */
export function parseAccountsCsv(text: string): CsvAccount[] {
  const rows: CsvAccount[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cells = parseCsvLine(line).map((c) => c.trim());
    if (cells.length < 3) continue;
    const [username, password, shared_secret, identity_secret] = cells;
    if (username.toLowerCase() === 'username') continue;     // header row
    if (!username || !password || !shared_secret) continue;  // unusable row
    rows.push({ username, password, shared_secret, identity_secret: identity_secret || '' });
  }
  return rows;
}

export interface DropZoneEntry { file: string; accountName: string; maFile: MaFile; }

/** Lists every readable *.maFile in ./mafiles/ with its parsed contents + account_name. */
export function listDropZoneMaFiles(): DropZoneEntry[] {
  if (!fs.existsSync(MA_FILES_DIR)) return [];
  const out: DropZoneEntry[] = [];
  for (const file of fs.readdirSync(MA_FILES_DIR)) {
    if (!file.toLowerCase().endsWith('.mafile')) continue;
    try {
      const maFile = JSON.parse(fs.readFileSync(path.join(MA_FILES_DIR, file), 'utf-8')) as MaFile;
      const accountName = (maFile.account_name as string) || '';
      // Require a USABLE maFile (account_name + shared_secret) — mirror loadMaFileFromDisk so a
      // maFile that fails the strict disk loader is never imported via this looser path.
      if (accountName && maFile.shared_secret) out.push({ file, accountName, maFile });
    } catch { /* skip unparseable */ }
  }
  return out;
}
