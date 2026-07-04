import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { listenAndAnnounce, clearOwnPortFile, boundUiPort, _resetForTest } from '../src/utils/serverPort';
import { dataDir } from '../src/utils/paths';

// ════════════════════════════════════════════════════════════════════════════
//  S52 — every exit ran clearStalePortFile(), so a REFUSED second instance deleted
//  the LIVE instance's data/ssim.port on its way out (the shell then couldn't find
//  the running app). Exit/shutdown now call clearOwnPortFile(), which removes the
//  file ONLY when it names the port THIS process announced.
// ════════════════════════════════════════════════════════════════════════════

const PORT_FILE = (): string => dataDir('ssim.port');

test('S52: clearOwnPortFile does NOTHING when this process never announced a port (refused 2nd instance)', () => {
  _resetForTest(); // announcedPort = undefined, as in an instance rejected by the single-instance lock
  fs.writeFileSync(PORT_FILE(), '3000'); // the LIVE instance's port file
  try {
    clearOwnPortFile();
    assert.equal(fs.existsSync(PORT_FILE()), true, 'a non-announcing instance must NOT delete the live port file');
  } finally { fs.rmSync(PORT_FILE(), { force: true }); }
});

test('S52: clearOwnPortFile removes the file when it names OUR announced port', async () => {
  _resetForTest();
  const srv = http.createServer((_req, res) => res.end());
  try {
    const port = await listenAndAnnounce(srv, '127.0.0.1', 0); // ephemeral bind → announcedPort set
    assert.equal(boundUiPort(), port);
    fs.writeFileSync(PORT_FILE(), String(port)); // our own announced file
    clearOwnPortFile();
    assert.equal(fs.existsSync(PORT_FILE()), false, 'our own port file is cleaned up on exit');
  } finally { srv.close(); _resetForTest(); fs.rmSync(PORT_FILE(), { force: true }); }
});

test('S52: clearOwnPortFile leaves a file that names a DIFFERENT (live) port', async () => {
  _resetForTest();
  const srv = http.createServer((_req, res) => res.end());
  try {
    const port = await listenAndAnnounce(srv, '127.0.0.1', 0);
    fs.writeFileSync(PORT_FILE(), String(port + 1)); // a different instance's live port
    clearOwnPortFile();
    assert.equal(fs.existsSync(PORT_FILE()), true, 'never delete a file pointing at another live port');
  } finally { srv.close(); _resetForTest(); fs.rmSync(PORT_FILE(), { force: true }); }
});
