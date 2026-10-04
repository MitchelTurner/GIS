#!/usr/bin/env node
/**
 * Landing page for the parcel-extract browser extension.
 * Serves the install site and a zip of extension/.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipDirectory } from './lib/zip.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const extensionDir = path.join(root, 'extension');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

function leafletFile(urlPath) {
  const prefix = '/vendor/leaflet/';
  if (!urlPath.startsWith(prefix)) return null;
  const base = path.join(extensionDir, 'vendor/leaflet');
  const abs = path.resolve(base, urlPath.slice(prefix.length));
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

function safePublicPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const abs = path.resolve(publicDir, relative);
  if (!abs.startsWith(publicDir + path.sep) && abs !== path.join(publicDir, 'index.html')) return null;
  return abs;
}

function send(res, status, body, headers, method) {
  res.writeHead(status, headers);
  if (method === 'HEAD') res.end();
  else res.end(body);
}

export async function createApp() {
  const zip = await zipDirectory(extensionDir, 'ketchikan-parcel-extract');

  return http.createServer(async (req, res) => {
    try {
      const method = req.method || 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        send(res, 405, 'Method not allowed\n', { 'Content-Type': 'text/plain; charset=utf-8' }, method);
        return;
      }

      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname === '/health') {
        send(res, 200, 'ok\n', { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, method);
        return;
      }

      if (url.pathname === '/extension.zip') {
        send(res, 200, zip, {
          'Content-Type': 'application/zip',
          'Content-Length': String(zip.length),
          'Content-Disposition': 'attachment; filename="ketchikan-parcel-extract.zip"',
          'Cache-Control': 'no-cache',
        }, method);
        return;
      }

      const leafletPath = leafletFile(url.pathname);
      if (leafletPath) {
        const body = await readFile(leafletPath);
        const type = TYPES[path.extname(leafletPath)] || 'application/octet-stream';
        send(res, 200, body, {
          'Content-Type': type,
          'Content-Length': String(body.length),
          'Cache-Control': 'public, max-age=300',
        }, method);
        return;
      }

      const filePath = safePublicPath(url.pathname);
      if (!filePath) {
        send(res, 404, 'Not found\n', { 'Content-Type': 'text/plain; charset=utf-8' }, method);
        return;
      }
      const body = await readFile(filePath);
      const type = TYPES[path.extname(filePath)] || 'application/octet-stream';
      send(res, 200, body, {
        'Content-Type': type,
        'Content-Length': String(body.length),
        'Cache-Control': path.extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=300',
      }, method);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        send(res, 404, 'Not found\n', { 'Content-Type': 'text/plain; charset=utf-8' }, req.method);
        return;
      }
      console.error(err);
      send(res, 500, 'Something went wrong.\n', { 'Content-Type': 'text/plain; charset=utf-8' }, req.method);
    }
  });
}

export async function start(port = Number(process.env.PORT) || 3000) {
  const server = await createApp();
  await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));
  console.log(`Parcel extract install page listening on ${port}`);
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
