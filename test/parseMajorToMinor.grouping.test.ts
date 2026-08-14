import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// ─────────────────────────────────────────────────────────────────────────────
//  H-FE-002 — market-buy price parse mis-read thousands-grouped input.
//
//  `.replace(',', '.')` was non-global, so a European "1.500,00" (€1500) became
//  parseFloat("1.500.00") = 1.5 → €1.50, a ~1000× under-parse on the live
//  buy-order path. The shipped fix disambiguates decimal-vs-grouping ONLY when
//  unambiguous (both separators present, or 2+ of the same), and keeps a LONE
//  separator as the decimal point — so no input ever parses HIGHER than typed
//  (no overspend direction).
//
//  Extracts the SHIPPED normalizeMajor + parseMajorToMinor (and the currency
//  table they read) from public/app.js — no jsdom, no new dependency.
// ─────────────────────────────────────────────────────────────────────────────

function extractFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found in app.js`);
  const bodyOpen = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyOpen; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

function extractConst(src: string, name: string): string {
  const start = src.indexOf(`const ${name} = {`);
  assert.ok(start >= 0, `const ${name} not found in app.js`);
  const bodyOpen = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyOpen; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) + ';'; }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const APP_JS = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const ctx: any = vm.createContext({});
vm.runInContext(
  `${extractConst(APP_JS, 'STEAM_CURRENCIES')}\n` +
  `${extractFunction(APP_JS, 'curInfo')}\n` +
  `${extractFunction(APP_JS, 'normalizeMajor')}\n` +
  `${extractFunction(APP_JS, 'parseMajorToMinor')}\n` +
  `this.__parse = parseMajorToMinor;`, ctx);
// code 2 = GBP (d=2), so minor = round(major * 100) for every case below.
const parse: (str: unknown, code: number) => number | null = ctx.__parse;

test('H-FE-002: grouped European price is no longer under-parsed ~1000×', () => {
  assert.equal(parse('1.500,00', 2), 150000);   // €1500.00 (was 150 → €1.50)
  assert.equal(parse('1,234.56', 2), 123456);   // €1234.56
  assert.equal(parse('1.000.000,50', 2), 100000050);
});

test('H-FE-002: simple decimal inputs are unchanged (both separators)', () => {
  assert.equal(parse('2,15', 2), 215);
  assert.equal(parse('2.15', 2), 215);
  assert.equal(parse('0,50', 2), 50);
  assert.equal(parse('0.50', 2), 50);
});

test('H-FE-002: an ambiguous LONE separator stays the decimal (safe under-parse, never overspend)', () => {
  assert.equal(parse('1.234', 2), 123);   // NOT 123400 — no overspend direction
  assert.equal(parse('1,234', 2), 123);   // NOT 123400
});

test('H-FE-002: 2+ of the SAME separator with no decimal part are all grouping', () => {
  assert.equal(parse('1.000.000', 2), 100000000);
  assert.equal(parse('1,000,000', 2), 100000000);
});

test('H-FE-002: whitespace / apostrophe (Swiss) group marks are stripped', () => {
  assert.equal(parse("1'500.00", 2), 150000);
  assert.equal(parse(' 2,15 ', 2), 215);
});

test('H-FE-002: empty / non-positive / non-numeric input yields null', () => {
  assert.equal(parse('', 2), null);
  assert.equal(parse('0', 2), null);
  assert.equal(parse('abc', 2), null);
  assert.equal(parse(null, 2), null);
});
