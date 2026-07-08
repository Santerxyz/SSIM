import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStickers } from '../src/core/InventoryManager';

// Steam embeds sticker info as HTML in a description whose value matches /sticker/i.
// parseStickers reads the "Sticker: ..." line and the <img> URLs in the same fragment.
const descWith = (value: string): any => ({ descriptions: [{ type: 'html', value }] });

test('parseStickers: a comma-bearing name with 1 image → exactly 1 sticker (H-INV-016)', () => {
  const html = `<img src="https://img/a.png"><br>Sticker: Don't Worry, I'm Pro`;
  const out = parseStickers(descWith(html));
  assert.ok(out, 'a sticker line is present');
  assert.equal(out!.length, 1, 'the <img> count is authoritative → one sticker, not two');
  assert.equal(out![0].name, "Don't Worry, I'm Pro", 'comma fragments re-joined');
  assert.equal(out![0].imageUrl, 'https://img/a.png');
});

test('parseStickers: two plain names with two images → unchanged two stickers', () => {
  const html = `<img src="https://img/a.png"><img src="https://img/b.png"><br>Sticker: A, B`;
  const out = parseStickers(descWith(html));
  assert.ok(out);
  assert.equal(out!.length, 2, 'counts already agree → no merge');
  assert.deepEqual(out!.map(s => s.name), ['A', 'B']);
  assert.equal(out![0].imageUrl, 'https://img/a.png');
  assert.equal(out![1].imageUrl, 'https://img/b.png');
});

test('parseStickers: no images present → comma split preserved (behavior unchanged)', () => {
  const html = `Sticker: Alpha, Beta`;
  const out = parseStickers(descWith(html));
  assert.ok(out);
  assert.equal(out!.length, 2, 'without an <img> constraint the split is left as-is');
  assert.deepEqual(out!.map(s => s.name), ['Alpha', 'Beta']);
});
