// Dev helper: dependency-free static file server for previewing public/
// (the real app serves public/ itself, but sits behind the license gate).
// Usage: node build/preview-static.js [port]
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'public');
const PORT = Number(process.argv[2] ?? 8123);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
  '.woff2': 'font/woff2',
};

http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]); }
  catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad request'); return; }
  let file = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`static preview on http://127.0.0.1:${PORT}`));
