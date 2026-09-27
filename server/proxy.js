import { getConfig } from './config.js';
import { log } from './log.js';
import { fetchFollow, readTextCapped, readPrefix, hostOf, isAbortError } from './http-client.js';

const MANIFEST_HINT = /\.m3u8?($|\?)/i;

export const looksLikeManifest = (url, contentType = '', head = '') =>
  /mpegurl/i.test(contentType) || MANIFEST_HINT.test(url) || /^\s*#EXTM3U/.test(head);

export const encodeTarget = (url) => Buffer.from(url, 'utf8').toString('base64url');

export function decodeTarget(encoded) {
  if (typeof encoded !== 'string' || !encoded) return null;
  let url;
  try {
    url = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!/^https?:\/\//i.test(url)) return null;
  return url;
}

const ATTR_URI_RE = /URI="([^"]*)"/gi;

/** Public path a browser must call to reach `upstream` through the proxy. */
export const proxyPath = (upstream) => `/hls?u=${encodeTarget(upstream)}`;

/**
 * Rewrites every URI reference in an HLS manifest so the browser only ever
 * talks to this server. Covers media segments, variant playlists, encryption
 * keys, init segments (EXT-X-MAP), alternate renditions, I-frame playlists and
 * low-latency parts.
 */
export function rewriteManifest(text, baseUrl) {
  const encode = (relative) => {
    try {
      return proxyPath(new URL(relative, baseUrl).href);
    } catch {
      return null;
    }
  };

  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        if (!trimmed.startsWith('#EXT-X-')) return line;
        return line.replace(ATTR_URI_RE, (match, uri) => {
          if (!uri) return match;
          const encoded = encode(uri);
          return encoded ? `URI="${encoded}"` : match;
        });
      }
      const encoded = encode(trimmed);
      return encoded ?? line;
    })
    .join('\n');
}

/** Fetches a manifest and returns its rewritten text, following a few redirects. */
export async function loadManifest(url, { guard, timeoutMs, refererFrom }) {
  const { response, finalUrl } = await fetchFollow(url, {
    timeoutMs,
    validate: (u) => guard.check(u),
    headers: refererFrom ? { Referer: refererFrom, Origin: new URL(refererFrom).origin } : {},
  });
  if (!response.ok) {
    const err = new Error(`HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  const body = await readTextCapped(response, 8 * 1024 * 1024);
  const contentType = response.headers.get('content-type') ?? '';
  if (!looksLikeManifest(finalUrl, contentType, body)) {
    const err = new Error('la respuesta no es una lista HLS');
    err.status = 502;
    throw err;
  }
  return { text: body, finalUrl, contentType };
}

/* ------------------------------------------------------------------ *
 * Health check
 * ------------------------------------------------------------------ */

/**
 * Verifies a channel end-to-end: manifest → (first variant) → first segment.
 * A manifest that answers 200 while every segment 404s is reported as dead.
 */
export async function checkChannel(url, { guard, timeoutMs, deep = true } = {}) {
  const started = Date.now();
  const result = { ok: false, status: 0, latencyMs: 0, variants: 0, checkedSegment: false, reason: '' };

  const firstVariant = (manifest) => {
    const lines = manifest.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        const uriLine = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith('#'));
        if (!uriLine) return null;
        try {
          return new URL(uriLine.trim(), url).href;
        } catch {
          return null;
        }
      }
    }
    return null;
  };

  const firstSegment = (manifest, base) => {
    for (const line of manifest.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      try {
        return new URL(trimmed, base).href;
      } catch {
        return null;
      }
    }
    return null;
  };

  try {
    const { response, finalUrl } = await fetchFollow(url, {
      timeoutMs,
      validate: (u) => guard.check(u),
    });
    result.status = response.status;
    await response.body?.cancel().catch(() => {});

    if (!response.ok) {
      result.reason = `HTTP ${response.status}`;
      return result;
    }

    if (deep) {
      const mediaUrl = firstVariant(finalUrl) ?? finalUrl;
      const { response: mediaRes, finalUrl: mediaFinal } = await fetchFollow(mediaUrl, {
        timeoutMs,
        validate: (u) => guard.check(u),
      });
      if (!mediaRes.ok) {
        await mediaRes.body?.cancel().catch(() => {});
        result.reason = `variante HTTP ${mediaRes.status}`;
        return result;
      }

      const manifest = await readTextCapped(mediaRes, 4 * 1024 * 1024);
      result.variants = (manifest.match(/#EXT-X-STREAM-INF/g) ?? []).length;

      const segment = firstSegment(manifest, mediaFinal);
      if (segment) {
        const seg = await fetchFollow(segment, {
          timeoutMs,
          validate: (u) => guard.check(u),
          headers: { Range: 'bytes=0-65535' },
        });
        const bytes = await readPrefix(seg.response, 65536);
        if (!seg.response.ok) {
          result.reason = `segmento HTTP ${seg.response.status}`;
          return result;
        }
        result.checkedSegment = bytes.byteLength > 0;
        if (!result.checkedSegment) {
          result.reason = 'segmento vacío';
          return result;
        }
      }
    }

    result.ok = true;
    result.latencyMs = Date.now() - started;
    return result;
  } catch (err) {
    result.latencyMs = Date.now() - started;
    result.reason =
      err.code === 'EHOSTBLOCKED' ? err.message : isAbortError(err) ? 'tiempo de espera agotado' : err.message;
    return result;
  }
}

/** Runs `worker` over `items` with bounded concurrency, preserving order. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Periodically re-checks every channel so the UI can flag dead ones. */
export class ChannelChecker {
  constructor(playlist, guard) {
    this.playlist = playlist;
    this.guard = guard;
    this.status = new Map();
    this.timer = null;
    this.running = false;
  }

  cached() {
    return Object.fromEntries(this.status);
  }

  async run({ ids = null, force = false } = {}) {
    const { probe } = getConfig();
    const channels = this.playlist.channels;
    const targets = ids?.length ? channels.filter((c) => ids.includes(c.id)) : channels;
    const ttl = force ? 0 : probe.cacheMinutes * 60_000;
    const now = Date.now();

    const stale = targets.filter((c) => {
      const entry = this.status.get(c.id);
      return !entry || now - entry.at > ttl;
    });

    if (stale.length) {
      log.info(`Comprobando ${stale.length} canal(es)…`);
      await mapLimit(stale, probe.concurrency, async (channel) => {
        const result = await checkChannel(channel.url, {
          guard: this.guard,
          timeoutMs: probe.timeoutMs,
          deep: probe.deep,
        });
        log.debug(`  ${result.ok ? 'OK  ' : 'FAIL'} ${channel.name} (${result.latencyMs}ms) ${result.reason || ''}`);
        this.status.set(channel.id, {
          ok: result.ok,
          status: result.status,
          latencyMs: result.latencyMs,
          reason: result.reason,
          host: hostOf(channel.url),
          at: Date.now(),
        });
      });
    }

    const out = {};
    for (const channel of targets) {
      const entry = this.status.get(channel.id);
      if (entry) out[channel.id] = entry;
    }
    return out;
  }

  /** Kick off a background sweep on start and on the configured interval. */
  start() {
    const { probe } = getConfig();
    const tick = () => {
      if (this.running) return;
      this.running = true;
      this.run()
        .then((result) => {
          const dead = Object.values(result).filter((r) => !r.ok).length;
          log.info(`Comprobación terminada: ${dead} canal(es) con problemas de ${Object.keys(result).length}`);
        })
        .catch((err) => log.error(`Fallo en la comprobación: ${err.message}`))
        .finally(() => {
          this.running = false;
        });
    };
    tick();
    this.timer = setInterval(tick, Math.max(probe.cacheMinutes, 5) * 60_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
