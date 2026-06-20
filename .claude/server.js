const http = require('http');
const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const MIME = {
  html: 'text/html', css: 'text/css', js: 'application/javascript',
  json: 'application/json', png: 'image/png', svg: 'image/svg+xml',
  ico: 'image/x-icon', webmanifest: 'application/manifest+json',
};
http.createServer((req, res) => {
  let pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  // serve directory index.html
  if (!pathname.includes('.') && !pathname.endsWith('/')) pathname += '/';
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.join(ROOT, pathname);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  try {
    const data = fs.readFileSync(file);
    const ext  = file.split('.').pop();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(4200, () => console.log('ChurchOS dev server on :4200'));
