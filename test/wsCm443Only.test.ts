import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

// A WebSocket CM is not implicitly wss:443 — most of Steam's websockets CMs listen on 27018-27036.
// Through a proxy that only allows CONNECT to :443 (the case CmProtocol demotes to WebSocket for),
// steam-user must be told to pick a :443 CM, or most logins die on "Proxy CONNECT 590 UPSTREAM501".

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'SessionManager.ts'), 'utf8');

test('proxied WebSocket logins restrict the CM pick to :443 (webCompatibilityMode)', () => {
  assert.match(src, /network\.type === 'proxy' && cmProto === 'ws' \? \{ webCompatibilityMode: true \}/);
});

test('steam-user webCompatibilityMode still filters the CM list to :443 endpoints', () => {
  const logon = fs.readFileSync(require.resolve('steam-user/components/09-logon.js'), 'utf8');
  assert.match(logon, /webCompatibilityMode[\s\S]{0,200}s\.endpoint\.endsWith\(':443'\)/);
});
