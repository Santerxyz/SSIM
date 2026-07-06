import fs from 'fs';
import path from 'path';
import type { MaFile } from '../types/account';
import { maFilesDir } from '../utils/paths';
import { logger } from '../utils/logger';

// ════════════════════════════════════════════════════════════════════════════
//  Shared "drop-zone" helpers for the mafiles/ folder (the import source).
//  Used by the boot migration, the "Import bots" route, and the login flow's
//  disk fallback. These touch ONLY the plaintext source files and NEVER delete
//  them — the vault is the runtime source of truth once unlocked.
// ════════════════════════════════════════════════════════════════════════════

const MA_FILES_DIR = maFilesDir();

/**
 * Reads a text file, tolerating the BOM/UTF-16 encodings Windows tooling emits by default:
 * PowerShell 5.1's `>` / `Out-File` writes UTF-16 LE (BOM), Notepad "Unicode" the same,
 * "Unicode big endian" UTF-16 BE. Decoded as UTF-8 those become NUL-interleaved garbage that
 * fails `JSON.parse` or never string-matches — a maFile then reports "not valid JSON" (it IS
 * valid) and accounts.txt usernames silently match nothing. Plain UTF-8 is byte-identical to
 * `readFileSync(path, 'utf-8')`; a leading UTF-8 BOM is stripped so it never leaks into a field.
 */
export function readTextFileTolerant(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2)); // drop BE BOM, then byte-swap pairs → LE
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf-8');
  const text = buf.toString('utf-8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

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
  const raw = readTextFileTolerant(filePath);
  let mf: MaFile;
  try { mf = JSON.parse(raw) as MaFile; } catch { throw new Error(`maFile is not valid JSON: ${filePath}`); }
  if (!mf || typeof mf !== 'object' || Array.isArray(mf)) throw new Error(`maFile is not a JSON object: ${filePath}`);
  if (typeof mf.shared_secret !== 'string' || !mf.shared_secret) throw new Error(`maFile missing shared_secret: ${filePath}`);
  // Normalize a non-string identity_secret to the documented "no identity_secret → confirmations
  // unavailable" state (LoginFlow warns on empty); a non-string would detonate deep in steam-totp.
  if (mf.identity_secret !== undefined && typeof mf.identity_secret !== 'string') mf.identity_secret = '' as never;
  return normalizeMaFile(mf, raw);
}

/**
 * Sanitizes a parsed maFile before anything persists it into the vault. SDA writes
 * `Session.SteamID` as a raw JSON NUMBER > 2^53, so JSON.parse silently ROUNDS it to a
 * different id — persisting that under a type that claims `string` is a wrong-partner
 * landmine (the exact bug BanService fights at read time). We recover the precision-safe
 * SteamID64 from the RAW text (never the parsed number) into the string `steamid`, and drop
 * the whole `Session` block: its number is lossy and its web cookies are long-dead and read
 * by nothing in src/. The on-disk source file is never rewritten, so SDA compat is untouched.
 */
function normalizeMaFile(mf: MaFile, raw: string): MaFile {
  if (typeof mf.steamid !== 'string' || !/^7656\d{13}$/.test(mf.steamid)) {
    const m = raw.match(/"(?:SteamID|steamid)"\s*:\s*"?(7656\d{13})"?/);
    if (m) mf.steamid = m[1];
    else if (typeof mf.steamid !== 'string') delete mf.steamid; // never persist a rounded number as a string id
  }
  delete mf.Session; // lossy number + dead cookies; the source file on disk is left intact
  return mf;
}

/**
 * Parses mafiles/accounts.txt → Map<lowercaseUsername, password>.
 * `existsSync` can pass and the read still throw EBUSY/EPERM when the file is transiently
 * locked (AV scanning a freshly-edited file, an editor holding it exclusive) — the S54/S58
 * transient-lock class. Classify that (and the ENOENT existsSync race) as ACCOUNTS_TXT_LOCKED
 * so the import routes name the locked file instead of answering a generic 500. NEVER return an
 * empty map on read failure — that would fabricate the false per-file "no password" reason for
 * every account; the failure must abort the import before any mutation.
 */
export function readCredentialsFile(): Map<string, string> {
  const map = new Map<string, string>();
  const file = path.join(MA_FILES_DIR, 'accounts.txt');
  if (!fs.existsSync(file)) return map;
  let text: string;
  try {
    text = readTextFileTolerant(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EBUSY' || code === 'EPERM' || code === 'ENOENT') {
      throw Object.assign(new Error('mafiles/accounts.txt is unreadable (locked by another program?) — close it and retry'), { code: 'ACCOUNTS_TXT_LOCKED' });
    }
    throw err;
  }
  for (const raw of text.split(/\r?\n/)) {
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

export interface CsvRejected { line: number; reason: 'too few columns' | 'missing username/password/shared_secret'; }

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
    } else if (c === '"' && cur === '') { inQuotes = true; }
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
export function parseAccountsCsv(text: string): { rows: CsvAccount[]; rejected: CsvRejected[] } {
  const rows: CsvAccount[] = [];
  const rejected: CsvRejected[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;             // blank / comment → not a data row
    const cells = parseCsvLine(line).map((c) => c.trim());
    if (cells.length < 3) { rejected.push({ line: i + 1, reason: 'too few columns' }); continue; }
    const [username, password, shared_secret, identity_secret] = cells;
    if (username.toLowerCase() === 'username') continue;      // header row → not a data row
    if (!username || !password || !shared_secret) { rejected.push({ line: i + 1, reason: 'missing username/password/shared_secret' }); continue; }
    rows.push({ username, password, shared_secret, identity_secret: identity_secret || '' });
  }
  return { rows, rejected };
}

export interface DropZoneEntry { file: string; accountName: string; maFile: MaFile; }
export interface DropZoneUnreadable { file: string; reason: string; }

/**
 * Lists every USABLE *.maFile in ./mafiles/ with its parsed contents + account_name, AND every
 * file that was dropped for being unparseable/AV-locked or missing account_name/shared_secret.
 * Nothing is ever silently swallowed: a whole folder of encrypted SDA blobs (base64, not JSON)
 * surfaces as `unreadable` entries instead of an empty list. Filenames only are logged — never
 * file contents, which may carry secrets. (H-ACC-078.)
 */
export function listDropZoneMaFiles(): { entries: DropZoneEntry[]; unreadable: DropZoneUnreadable[] } {
  if (!fs.existsSync(MA_FILES_DIR)) return { entries: [], unreadable: [] };
  const entries: DropZoneEntry[] = [];
  const unreadable: DropZoneUnreadable[] = [];
  for (const file of fs.readdirSync(MA_FILES_DIR)) {
    if (!file.toLowerCase().endsWith('.mafile')) continue;
    try {
      const raw = readTextFileTolerant(path.join(MA_FILES_DIR, file));
      const maFile = normalizeMaFile(JSON.parse(raw) as MaFile, raw);
      const accountName = typeof maFile.account_name === 'string' ? maFile.account_name : '';
      // Require a USABLE maFile (account_name + shared_secret) — mirror loadMaFileFromDisk so a
      // maFile that fails the strict disk loader is never imported via this looser path.
      if (!accountName) { unreadable.push({ file, reason: 'no account_name' }); continue; }
      if (!(typeof maFile.shared_secret === 'string' && maFile.shared_secret)) { unreadable.push({ file, reason: 'no shared_secret' }); continue; }
      entries.push({ file, accountName, maFile });
    } catch (err) { unreadable.push({ file, reason: 'unreadable: ' + (err as Error).message }); }
  }
  if (unreadable.length) {
    logger.warn(`[mafiles] ${unreadable.length} drop-zone file(s) skipped: ${unreadable.map((u) => u.file).join(', ')}`);
  }
  return { entries, unreadable };
}
