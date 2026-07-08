import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { AccountTrader } from '../src/trading/AccountTrader';
import { logger } from '../src/utils/logger';

// ─── H-TRD-002: the MAX_PAGES cap (30 × 100 = 3000 listings) must be SIGNALLED ────────
// getListedAssetIds and getMarketOrders both stop after 3000 listings. When total_count
// exceeds the cap the loop just exits at page 30 with no marker — the listed-set is
// silently incomplete (items past 3000 render as Owned, mass-sell re-lists get rejected,
// the phantom probe can't see them). One warn per call makes it visible the day it happens.

function fakeTrader(): AccountTrader {
  const t = Object.create(AccountTrader.prototype) as AccountTrader;
  Object.assign(t, {
    username: 'whalebot',
    session: { webSession: { cookies: ['sessionid=abc', 'steamLoginSecure=xyz'] }, httpsAgent: {} },
  });
  return t;
}

/** A FULL page of PAGE (100) well-formed sell listings with `total_count` kept above the
 *  pages read so far, so neither break fires and the loop runs to the MAX_PAGES cap. */
function fullListingsPage(start: number, total: number): { total_count: number; listings: unknown[]; assets: unknown } {
  const listings = Array.from({ length: 100 }, (_, i) => {
    const id = String(start + i + 1);
    return { listingid: `L${id}`, asset: { id, appid: 730, contextid: '2', amount: 1 }, price: 1000, fee: 150, currencyid: 2003 };
  });
  return { total_count: total, listings, assets: {} };
}

/** Swap in a spy for logger.warn, capturing every message, and restore afterwards. */
async function withWarnSpy<T>(body: (calls: string[]) => Promise<T>): Promise<T> {
  const calls: string[] = [];
  const orig = logger.warn;
  (logger as { warn: unknown }).warn = ((msg?: unknown) => { calls.push(String(msg)); return logger; }) as typeof logger.warn;
  try {
    return await body(calls);
  } finally {
    (logger as { warn: unknown }).warn = orig;
  }
}

test('H-TRD-002: getListedAssetIds warns exactly once when total_count exceeds the 3000 cap', async () => {
  const origGet = axios.get;
  (axios as { get: unknown }).get = async (url: string) => {
    const m = /start=(\d+)&/.exec(url);
    const start = m ? Number(m[1]) : 0;
    return { status: 200, data: fullListingsPage(start, 3500) };
  };
  try {
    await withWarnSpy(async (calls) => {
      await fakeTrader().getListedAssetIds();
      const truncWarns = calls.filter((c) => c.includes('truncated') && c.includes('INCOMPLETE'));
      assert.equal(truncWarns.length, 1, 'the truncation warn must fire exactly once per call');
      assert.match(truncWarns[0], /3500 listings/, 'the warn reports the real total_count');
    });
  } finally {
    (axios as { get: unknown }).get = origGet;
  }
});

test('H-TRD-002: getMarketOrders warns exactly once when total_count exceeds the 3000 cap', async () => {
  const origGet = axios.get;
  (axios as { get: unknown }).get = async (url: string) => {
    if (!url.includes('start=')) return { status: 200, data: { total_count: 0, listings: [], assets: {}, buy_orders: [] } }; // landing fallback
    const m = /start=(\d+)&/.exec(url);
    const start = m ? Number(m[1]) : 0;
    return { status: 200, data: fullListingsPage(start, 3500) };
  };
  try {
    await withWarnSpy(async (calls) => {
      await fakeTrader().getMarketOrders();
      const truncWarns = calls.filter((c) => c.includes('truncated') && c.includes('INCOMPLETE'));
      assert.equal(truncWarns.length, 1, 'the truncation warn must fire exactly once per call');
    });
  } finally {
    (axios as { get: unknown }).get = origGet;
  }
});

test('H-TRD-002: a below-cap account never warns (getListedAssetIds)', async () => {
  const origGet = axios.get;
  (axios as { get: unknown }).get = async (url: string) => {
    if (url.includes('start=0')) return { status: 200, data: fullListingsPage(0, 100) }; // one full-but-final page, total 100
    return { status: 200, data: { total_count: 100, listings: [], assets: {} } };
  };
  try {
    await withWarnSpy(async (calls) => {
      await fakeTrader().getListedAssetIds();
      const truncWarns = calls.filter((c) => c.includes('truncated') && c.includes('INCOMPLETE'));
      assert.equal(truncWarns.length, 0, 'an under-cap account must not warn');
    });
  } finally {
    (axios as { get: unknown }).get = origGet;
  }
});
