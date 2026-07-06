import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import winston from 'winston';
import { logger, fileFormat } from '../src/utils/logger';

// ════════════════════════════════════════════════════════════════════════════
//  H-BOOT-015 — redactFormat used to scrub only info.message + info.stack, but the
//  File transports' format.json() serializes EVERY enumerable own property. Any
//  metadata a caller attaches (`logger.warn('x', { proxy })`, or a custom Error
//  carrying an enumerable own field) reached ssim.log/error.log unredacted. The
//  format now walks all string-valued own keys, so proxy creds in metadata are
//  masked at rest too.
// ════════════════════════════════════════════════════════════════════════════

/** Attach a Stream transport with the shipped fileFormat, capture one JSON line. */
function captureFileLine(emit: () => void): string {
  let captured = '';
  const stream = new Writable({
    write(chunk, _enc, cb): void { captured += chunk.toString(); cb(); },
  });
  const transport = new winston.transports.Stream({ stream, format: fileFormat });
  logger.add(transport);
  try {
    emit();
  } finally {
    logger.remove(transport);
  }
  return captured;
}

test('H-BOOT-015: a proxy URL in a plain metadata object is masked at rest', () => {
  const line = captureFileLine(() =>
    logger.error('boom', { proxy: 'http://u:p@1.2.3.4:8080' }));
  assert.ok(line.includes('***:***@'), `metadata proxy creds not masked: ${line}`);
  assert.ok(!line.includes('u:p@1.2.3.4'), `raw metadata creds leaked to the file sink: ${line}`);
});

test('H-BOOT-015: an enumerable own field on a custom Error is masked', () => {
  const e = new Error('login failed');
  (e as Error & { proxyUrl?: string }).proxyUrl = 'http://bob:hunter2@10.0.0.1:1080';
  const line = captureFileLine(() => logger.error('API error', e));
  assert.ok(!line.includes('hunter2'), `custom-Error proxy password leaked: ${line}`);
  assert.ok(line.includes('***:***@'), `custom-Error proxy creds not masked: ${line}`);
});

test('H-BOOT-015: a credential-free record is left byte-for-byte intact', () => {
  const line = captureFileLine(() => logger.info('heapUsed=123MB heapTotal=456MB'));
  assert.ok(line.includes('heapUsed=123MB heapTotal=456MB'),
    `redaction must be identity on credential-free text: ${line}`);
  assert.ok(!line.includes('***'), `nothing to mask, but the record was altered: ${line}`);
});
