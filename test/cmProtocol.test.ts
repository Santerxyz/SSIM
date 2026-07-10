import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  chooseCmProtocol, noteCmOutcome, resetCmProtocolLearning, loadPersisted,
  envCmProtocolOverride, TCP_FAILURES_TO_DEMOTE,
} from '../src/network/CmProtocol';

const tmpCmFile = () => path.join(os.tmpdir(), `cm-proto-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

// The 2026-07-09 regression: the tank's forced protocol:TCP tunnels the CM via HTTP CONNECT to
// ports 27017-27050, which many providers block (443-only CONNECT policy) — those proxies must
// demote to WebSocket (wss:443) instead of timing out every login forever.

const P1 = 'proxy-a.example:8080';
const P2 = 'proxy-b.example:8080';

beforeEach(() => resetCmProtocolLearning());

test('default is TCP-first (the tank anti-crash choice)', () => {
  assert.equal(chooseCmProtocol(P1, false, ''), 'tcp');
  assert.equal(chooseCmProtocol(null, false, ''), 'tcp', 'local IP has no CONNECT in the path → TCP always safe');
});

test('SOCKS always chooses WebSocket (steam-user hard-forces that combination anyway)', () => {
  assert.equal(chooseCmProtocol(P1, true, ''), 'ws');
  assert.equal(chooseCmProtocol(P1, true, 'tcp'), 'ws', 'even a tcp env override cannot put SOCKS on TCP');
});

test(`${TCP_FAILURES_TO_DEMOTE} consecutive TCP connect failures demote THAT proxy only`, () => {
  for (let i = 0; i < TCP_FAILURES_TO_DEMOTE - 1; i++) {
    assert.equal(noteCmOutcome(P1, 'tcp', false), null, 'below the threshold → no demotion yet');
    assert.equal(chooseCmProtocol(P1, false, ''), 'tcp', 'a single blip does not flip the proxy');
  }
  assert.equal(noteCmOutcome(P1, 'tcp', false), 'demoted', 'threshold reached → demoted exactly once');
  assert.equal(noteCmOutcome(P1, 'tcp', false), null, 'no duplicate demotion signal (single log line)');
  assert.equal(chooseCmProtocol(P1, false, ''), 'ws', 'demoted proxy now runs WebSocket');
  assert.equal(chooseCmProtocol(P2, false, ''), 'tcp', 'other proxies unaffected');
});

test('a TCP success resets the failure streak (transient blips never accumulate to a demotion)', () => {
  noteCmOutcome(P1, 'tcp', false);
  noteCmOutcome(P1, 'tcp', true);
  for (let i = 0; i < TCP_FAILURES_TO_DEMOTE - 1; i++) assert.equal(noteCmOutcome(P1, 'tcp', false), null);
  assert.equal(chooseCmProtocol(P1, false, ''), 'tcp', 'streak restarted after the success');
});

test('WebSocket failures never count toward demotion and null pkey never demotes', () => {
  noteCmOutcome(P1, 'ws', false); noteCmOutcome(P1, 'ws', false); noteCmOutcome(P1, 'ws', false);
  assert.equal(chooseCmProtocol(P1, false, ''), 'tcp');
  noteCmOutcome(null, 'tcp', false); noteCmOutcome(null, 'tcp', false);
  assert.equal(chooseCmProtocol(null, false, ''), 'tcp');
});

test('SSIM_CM_PROTOCOL override wins over learning (both directions)', () => {
  noteCmOutcome(P1, 'tcp', false); noteCmOutcome(P1, 'tcp', false); // demoted
  assert.equal(chooseCmProtocol(P1, false, 'tcp'), 'tcp', 'forced tcp ignores the demotion');
  assert.equal(chooseCmProtocol(P2, false, 'ws'), 'ws', 'forced ws skips the 2-failure probe entirely');
  assert.equal(chooseCmProtocol(P2, false, 'websocket'), 'ws');
  assert.equal(chooseCmProtocol(P2, false, 'auto'), 'auto');
});

test('envCmProtocolOverride parses leniently and rejects junk', () => {
  assert.equal(envCmProtocolOverride(' WS '), 'ws');
  assert.equal(envCmProtocolOverride('TCP'), 'tcp');
  assert.equal(envCmProtocolOverride('WebSocket'), 'ws');
  assert.equal(envCmProtocolOverride(''), null);
  assert.equal(envCmProtocolOverride(undefined), null);
  assert.equal(envCmProtocolOverride('yes'), null);
});

test('demotion is keyed by PROVIDER HOST — all ports of one provider share the verdict', () => {
  // Two different ports on the SAME host converge after 2 TOTAL failures (a rotating pool), not 2 per port.
  assert.equal(noteCmOutcome('flame.example:8989', 'tcp', false), null);
  assert.equal(noteCmOutcome('flame.example:9001', 'tcp', false), 'demoted', 'host-wide streak → demoted on the 2nd failure across ports');
  assert.equal(chooseCmProtocol('flame.example:7777', false, ''), 'ws', 'a THIRD port on the same host is already WebSocket');
});

test('persistence: a demotion survives a "restart" (re-seeded from disk — no re-learning each run)', () => {
  const file = tmpCmFile();
  try {
    loadPersisted(file);                                   // enable persistence (file absent → empty)
    noteCmOutcome(P1, 'tcp', false);
    assert.equal(noteCmOutcome(P1, 'tcp', false), 'demoted');
    assert.ok(fs.existsSync(file), 'the demotion was written to disk');
    resetCmProtocolLearning();                             // simulate a process exit (forget in-memory)
    loadPersisted(file);                                   // simulate the next boot
    assert.equal(chooseCmProtocol(P1, false, ''), 'ws', 'the fresh persisted demotion is trusted — no 2-failure re-learning');
  } finally { try { fs.rmSync(file, { force: true }); } catch { /* ignore */ } }
});

test('re-probe: a demotion older than 24h is re-probed on TCP, and a SUCCESS promotes + un-persists it', () => {
  const file = tmpCmFile();
  try {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify({ version: 1, demoted: { [P1.replace(/:\d+$/, '')]: { demotedAt: old } } }));
    loadPersisted(file);
    assert.equal(chooseCmProtocol(P1, false, ''), 'tcp', 'a stale demotion re-probes TCP instead of sticking on WebSocket forever');
    assert.equal(noteCmOutcome(P1, 'tcp', true), 'promoted', 'the re-probe worked → the provider now allows the CM ports');
    assert.equal(chooseCmProtocol(P1, false, ''), 'tcp', 'stays on TCP');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.demoted[P1.replace(/:\d+$/, '')], undefined, 'the demotion was removed from persistence');
  } finally { try { fs.rmSync(file, { force: true }); } catch { /* ignore */ } }
});

test('re-probe FAILURE refreshes the demotion clock (stays WebSocket ~24h, not re-probed every run)', () => {
  const file = tmpCmFile();
  try {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify({ version: 1, demoted: { [P1.replace(/:\d+$/, '')]: { demotedAt: old } } }));
    loadPersisted(file);
    assert.equal(chooseCmProtocol(P1, false, ''), 'tcp', 'stale → re-probe');
    assert.equal(noteCmOutcome(P1, 'tcp', false), null, 'a failed re-probe does NOT re-signal demotion (already demoted)');
    assert.equal(chooseCmProtocol(P1, false, ''), 'ws', 'clock refreshed → trusted WebSocket again for another 24h (no re-probe next run)');
  } finally { try { fs.rmSync(file, { force: true }); } catch { /* ignore */ } }
});
