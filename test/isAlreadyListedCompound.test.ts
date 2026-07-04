import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAlreadyListed } from '../src/trading/MarketService';

// ════════════════════════════════════════════════════════════════════════════
//  S63 — isAlreadyListed used bare tokens (already|bereits|aktiv|vorhanden|listed),
//  so an unrelated localized error could be mis-classified as a phantom listing and
//  bucket an Owned item as Listed. It now requires a COMPOUND match — a listing noun
//  AND an "already/exists" qualifier must BOTH be present.
// ════════════════════════════════════════════════════════════════════════════

const err = (m: string) => new Error(m);

test('S63: genuine "already listed" phantoms are still detected (EN + DE)', () => {
  assert.equal(isAlreadyListed(err('You already have a listing for this item')), true);
  assert.equal(isAlreadyListed(err('There is a pending listing for this asset')), true);
  assert.equal(isAlreadyListed(err('Es existiert bereits ein aktives Angebot')), true, 'German: bereits + Angebot');
  assert.equal(isAlreadyListed(err('Angebot bereits vorhanden')), true);
});

test('S63: unrelated errors are NOT mis-classified as a phantom listing (the false-positive fix)', () => {
  assert.equal(isAlreadyListed(err('You have already been rate limited, try again later')), false, 'bare "already", no listing noun');
  assert.equal(isAlreadyListed(err('This item is listed as untradable')), false, 'bare "listed", no "already"');
  assert.equal(isAlreadyListed(err('Der Account ist aktiv')), false, 'bare "aktiv", no listing noun');
  assert.equal(isAlreadyListed(err('The market is temporarily unavailable')), false);
  assert.equal(isAlreadyListed(err('')), false);
});
