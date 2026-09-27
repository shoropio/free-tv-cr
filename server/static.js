import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PATHS } from './config.js';
import { fetchFollow } from './http-client.js';
import { log } from './log.js';

/** Las imágenes se sirven con CORS abierto: el <img> del navegador va directo. */
const CORS_IMAGES = { 'Access-Control-Allow-Origin': '*' };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

const ETagCache = new Map();

function sendFile(req, res, filePath, { cache = 'public, max-age=300' } = {}) {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  ETagCache.set(filePath, etag);

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cache });
    res.end();
    return true;
  }

  res.writeHead(200, {
    'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cache,
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString(),
  });

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  pipeline(createReadStream(filePath), res).catch((err) => {
    if (!res.headersSent) res.writeHead(500);
    log.debug(`Static: error enviando ${filePath}: ${err.message}`);
    res.end();
  });
  return true;
}

/** Resolves a URL path inside `public/`, rejecting traversal attempts. */
function safeResolve(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const target = resolve(PATHS.public, `.${normalize(decoded)}`);
  if (target !== PATHS.public && !target.startsWith(PATHS.public + sep)) return null;
  return target;
}

/** Serves files from public/ with an index.html fallback for unknown routes. */
export function serveStatic(req, res, urlPath) {
  const target = safeResolve(urlPath);
  if (!target) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Prohibido');
    return;
  }

  if (urlPath === '/' || urlPath === '') {
    if (sendFile(req, res, join(PATHS.public, 'index.html'), { cache: 'no-cache' })) return;
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Falta public/index.html');
    return;
  }

  if (sendFile(req, res, target)) return;

  // SPA fallback: unknown non-asset routes render the app shell.
  if (!extname(urlPath)) {
    if (sendFile(req, res, join(PATHS.public, 'index.html'), { cache: 'no-cache' })) return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 No encontrado');
}

/** Streams a remote image through the server (some logo hosts block hotlinking). */
export async function proxyImage(req, res, upstream, guard) {
  const verdict = await guard.check(upstream);
  if (!verdict.ok) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_IMAGES });
    res.end('Logo no permitido');
    return;
  }

  // Referer del propio host: varios CDN de logos (imgur, cloudinary) rechazan
  // el hotlinking si no llega uno. `fetchFollow` valida cada salto del redirect.
  const { protocol, host } = new URL(upstream);
  let response;
  try {
    ({ response } = await fetchFollow(upstream, {
      timeoutMs: 12000,
      validate: (u) => guard.check(u),
      headers: { Referer: `${protocol}//${host}/` },
    }));
  } catch (err) {
    res.writeHead(err.code === 'EHOSTBLOCKED' ? 403 : 504, {
      'Content-Type': 'text/plain; charset=utf-8',
      ...CORS_IMAGES,
    });
    res.end('Logo no disponible');
    return;
  }
  if (!response.ok || !response.body) {
    res.writeHead(response.ok ? 415 : response.status, {
      'Content-Type': 'text/plain; charset=utf-8',
      ...CORS_IMAGES,
    });
    res.end('Logo no disponible');
    return;
  }
  res.writeHead(200, {
    'Content-Type': response.headers.get('content-type') ?? 'image/jpeg',
    'Cache-Control': 'public, max-age=86400',
    ...CORS_IMAGES,
  });
  await pipeline(Readable.fromWeb(response.body), res).catch(() => res.destroy());
}
