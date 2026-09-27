import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { getConfig, loadConfig, ensureDirs, PATHS } from './config.js';
import { log } from './log.js';
import { Playlist } from './playlist.js';
import { categoryLabel } from './m3u.js';
import { Guide } from './epg.js';
import { ChannelChecker, decodeTarget, looksLikeManifest, proxyPath, rewriteManifest } from './proxy.js';
import { HostGuard, fetchFollow, parseHttpUrl, readTextCapped, hostOf } from './http-client.js';
import { proxyImage, serveStatic } from './static.js';

loadConfig();
ensureDirs();

const config = getConfig();
const playlist = new Playlist();
const guide = new Guide();
const guard = new HostGuard();
const checker = new ChannelChecker(playlist, guard);
guard.loadConfigured();

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...CORS,
  });
  res.end(body);
}

function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { ok: false, error: message, ...extra });
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error('cuerpo demasiado grande');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const proxyUrlFor = (upstream) => proxyPath(upstream);

/** Shape sent to the browser: stream URLs point at the proxy, never upstream. */
function presentChannel(channel) {
  return {
    id: channel.id,
    number: channel.number,
    tvgId: channel.tvgId,
    name: channel.name,
    logo: channel.logo,
    groups: channel.groups,
    groupLabels: channel.groups.map(categoryLabel),
    is24x7: channel.is24x7,
    geoBlocked: channel.geoBlocked,
    resolution: channel.resolution,
    qualityTag: channel.qualityTag,
    language: channel.language,
    url: proxyUrlFor(channel.url),
    upstreamHost: hostOf(channel.url),
  };
}

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

let ready = false;

async function bootstrap() {
  try {
    await playlist.load();
  } catch (err) {
    log.error(`Arranque sin lista de canales: ${err.message}`);
  }

  if (playlist.channels.length) {
    guard.addHosts(playlist.streamHosts());
    log.info(`Proxy habilitado para ${guard.allowed.size} host(s) de la lista.`);
  }

  // La guía no bloquea el arranque: si falla, la app sigue sin EPG.
  guide
    .load()
    .then(() => guide.matchChannels(playlist.channels))
    .catch((err) => log.error(`EPG no disponible: ${err.message}`));

  ready = true;
  checker.start();
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

async function handleChannels(req, res) {
  if (!playlist.channels.length) await playlist.load();
  sendJson(res, 200, {
    ok: true,
    country: 'Costa Rica',
    playlistUrl: config.playlist.url,
    groups: playlist.groups,
    channels: playlist.channels.map(presentChannel),
    status: checker.cached(),
    updatedAt: playlist.loadedAt,
  });
}

async function handleEpgOverview(req, res) {
  if (!ready) await bootstrapGuard;
  const ids = playlist.channels.map((c) => c.id);
  const requested = new URL(req.url, 'http://x').searchParams.get('ids');
  const filter = requested ? new Set(requested.split(',').map((s) => s.trim())) : null;
  const targets = filter ? ids.filter((id) => filter.has(id)) : ids;

  if (!guide.loaded) {
    sendJson(res, 200, { ok: true, status: guide.status, guides: {} });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    status: guide.status,
    now: Date.now(),
    guides: guide.snapshot(targets),
  });
}

async function handleEpgTimeline(req, res, channelId) {
  if (!guide.loaded) {
    sendJson(res, 200, { ok: true, matched: false, channel: channelId, programmes: [] });
    return;
  }
  const data = guide.timeline(channelId);
  sendJson(res, 200, { ok: true, channel: channelId, now: Date.now(), ...data });
}

async function handleCheck(req, res, body) {
  if (!playlist.channels.length) await playlist.load();
  const ids = body?.ids ?? null;
  const deep = body?.deep ?? undefined;
  if (deep !== undefined) config.probe.deep = Boolean(deep);
  const result = await checker.run({ ids, force: true });
  sendJson(res, 200, { ok: true, at: Date.now(), status: result });
}

async function handleEpgRefresh(req, res) {
  const status = await guide.load({ force: true });
  guide.matchChannels(playlist.channels);
  sendJson(res, 200, { ok: true, status });
}

async function handlePlaylistRefresh(req, res) {
  await playlist.load({ force: true });
  guard.addHosts(playlist.streamHosts());
  guide.matchChannels(playlist.channels);
  sendJson(res, 200, {
    ok: true,
    channels: playlist.channels.map(presentChannel),
    groups: playlist.groups,
    updatedAt: playlist.loadedAt,
  });
}

/** Main HLS proxy: rewrites manifests and streams media segments. */
async function handleProxy(req, res, target) {
  const upstream = decodeTarget(target);
  if (!upstream) {
    sendError(res, 400, 'Parámetro "u" no válido');
    return;
  }

  const verdict = await guard.check(upstream);
  if (!verdict.ok) {
    sendError(res, 403, verdict.reason, { host: verdict.host, canApprove: true });
    return;
  }

  // Abort the upstream request as soon as the viewer closes the tab.
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClose);

  const { proxy } = config;
  let result;
  try {
    result = await fetchFollow(upstream, {
      timeoutMs: proxy.timeoutMs,
      validate: (u) => guard.check(u),
      headers: req.headers.range ? { Range: req.headers.range } : {},
      signal: controller.signal,
    });
  } catch (err) {
    res.off('close', onClose);
    if (res.destroyed) return;
    const status = err.code === 'EHOSTBLOCKED' ? 403 : 504;
    sendError(res, status, err.message, { host: err.host ?? null, canApprove: err.code === 'EHOSTBLOCKED' });
    return;
  }

  const { response, finalUrl } = result;
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    res.off('close', onClose);
    if (!res.destroyed) sendError(res, response.status, `El stream respondió HTTP ${response.status}`);
    return;
  }

  const contentType = response.headers.get('content-type') ?? '';
  const contentEncoding = response.headers.get('content-encoding');
  const upstreamLength = response.headers.get('content-length');

  // Decide from the URL and MIME type whether this is a playlist: doing it in a
  // single pass avoids re-downloading the body just to peek at it.
  if (looksLikeManifest(finalUrl, contentType)) {
    const body = await readTextCapped(response, 8 * 1024 * 1024);
    res.off('close', onClose);
    if (!/^\s*#EXTM3U/.test(body)) {
      sendError(res, 502, 'El servidor devolvió un contenido que no es una lista HLS');
      return;
    }
    const rewritten = Buffer.from(rewriteManifest(body, finalUrl), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Content-Length': rewritten.byteLength,
      'Cache-Control': 'no-store',
      ...CORS,
    });
    res.end(req.method === 'HEAD' ? undefined : rewritten);
    return;
  }

  // Media segment (or an already-labelled manifest): stream it through untouched.
  const headers = {
    'Content-Type': contentType || 'video/mp2t',
    'Cache-Control': 'no-store',
    ...CORS,
  };
  const acceptRanges = response.headers.get('accept-ranges');
  if (acceptRanges) headers['Accept-Ranges'] = acceptRanges;
  const contentRange = response.headers.get('content-range');
  if (contentRange) headers['Content-Range'] = contentRange;
  // undici transparently decodes gzip, so the upstream length no longer applies.
  if (upstreamLength && !contentEncoding) headers['Content-Length'] = upstreamLength;

  res.writeHead(200, headers);
  if (req.method === 'HEAD' || !response.body) {
    await response.body?.cancel().catch(() => {});
    res.off('close', onClose);
    res.end();
    return;
  }
  try {
    await pipeline(Readable.fromWeb(response.body), res);
  } catch (err) {
    log.debug(`Proxy: corte de stream en ${finalUrl}: ${err.message}`);
  } finally {
    res.off('close', onClose);
  }
}

/* ------------------------------------------------------------------ *
 * Request dispatch
 * ------------------------------------------------------------------ */

let bootstrapGuard = Promise.resolve();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  try {
    if (path === '/api/health') {
      sendJson(res, 200, { ok: true, uptime: process.uptime(), channels: playlist.channels.length, epg: guide.status.state });
      return;
    }

    if (path === '/api/channels') {
      await handleChannels(req, res);
      return;
    }

    if (path === '/api/epg') {
      if (!ready) await (bootstrapGuard = bootstrap());
      await handleEpgOverview(req, res);
      return;
    }

    if (path.startsWith('/api/epg/')) {
      if (!ready) await (bootstrapGuard = bootstrap());
      await handleEpgTimeline(req, res, decodeURIComponent(path.slice('/api/epg/'.length)));
      return;
    }

    if (path === '/api/epg/refresh') {
      await handleEpgRefresh(req, res);
      return;
    }

    if (path === '/api/playlist/refresh') {
      await handlePlaylistRefresh(req, res);
      return;
    }

    if (path === '/api/check') {
      const ids = url.searchParams.get('ids');
      const deep = url.searchParams.get('deep');
      await handleCheck(req, res, {
        ids: ids ? ids.split(',').filter(Boolean) : null,
        deep: deep === null ? undefined : deep === '1' || deep === 'true',
      });
      return;
    }

    if (path === '/api/allow-host' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const host = String(body.host ?? '').toLowerCase().trim();
      if (!/^[a-z0-9.-]+$/.test(host)) {
        sendError(res, 400, 'Host no válido');
        return;
      }
      guard.approveHost(host, { persist: body.persist !== false });
      sendJson(res, 200, { ok: true, host, allowed: [...guard.allowed].sort() });
      return;
    }

    if (path === '/hls') {
      await handleProxy(req, res, url.searchParams.get('u'));
      return;
    }

    if (path === '/img') {
      const raw = url.searchParams.get('u');
      const upstream = parseHttpUrl(raw);
      if (!upstream) {
        sendError(res, 400, 'URL de logo no válida');
        return;
      }
      await proxyImage(req, res, upstream.href, guard);
      return;
    }

    if (path.startsWith('/api/')) {
      sendError(res, 404, `Endpoint desconocido: ${path}`);
      return;
    }

    serveStatic(req, res, path);
  } catch (err) {
    log.error(`${req.method} ${path} → ${err.message}`);
    if (!res.headersSent) sendError(res, 500, err.message);
    else res.destroy();
  }
});

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

function localAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

server.listen(config.server.port, config.server.host, () => {
  const shown = config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host;
  log.info(`IPTV Costa Rica escuchando en http://${shown}:${config.server.port}`);
  for (const address of localAddresses()) {
    log.info(`  también disponible en http://${address}:${config.server.port}`);
  }
  bootstrapGuard = bootstrap();
});

const shutdown = (signal) => {
  log.info(`\n${signal} recibido, cerrando…`);
  checker.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('Promesa rechazada sin manejar:', err));

export { server, playlist, guide, guard, checker, PATHS };
