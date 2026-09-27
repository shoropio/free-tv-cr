import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { log } from './log.js';
import { BUILTIN_HOSTS, getConfig, saveConfigPatch } from './config.js';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Parses an absolute http(s) URL, returning null when it is not usable.
 * Prevents `file:`, `data:` and other protocol smuggling tricks.
 */
export function parseHttpUrl(value) {
  if (typeof value !== 'string' || value === '') return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
  return url;
}

/** `URL.hostname` keeps IPv6 brackets; strip them so isIP() works. */
export const normalizeHost = (hostname) => {
  const host = String(hostname ?? '').toLowerCase();
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
};

export const hostOf = (url) => {
  const parsed = parseHttpUrl(url);
  return parsed ? normalizeHost(parsed.hostname) : null;
};

/* ------------------------------------------------------------------ *
 * Private / reserved address ranges (SSRF protection)
 * ------------------------------------------------------------------ */

const V4_BLOCKED = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local + cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24],
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

const toV4Int = (ip) => ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;

/** True when `ip` is a public, routable address. Literal IPs skip DNS entirely. */
export function isPublicAddress(ip) {
  const version = isIP(ip);
  if (version === 4) {
    const value = toV4Int(ip);
    return !V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (value & mask) === (toV4Int(base) & mask);
    });
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicAddress(mapped[1]);
    const head = parseInt(lower.split(':')[0] || '0', 16);
    if ((head & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
    if ((head & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
    if ((head & 0xff00) === 0xff00) return false; // ff00::/8 multicast
    return true;
  }
  return false;
}

const DNS_TTL = 10 * 60_000;
const dnsCache = new Map();

/**
 * Resolves a hostname and reports whether every address it maps to is public.
 * Cached for 10 minutes so segment requests do not re-resolve on every call.
 */
export async function resolvesToPublicAddress(host) {
  if (isIP(host)) return isPublicAddress(host);

  const cached = dnsCache.get(host);
  if (cached && Date.now() - cached.at < DNS_TTL) return cached.ok;

  let ok = true;
  try {
    const { address } = await lookup(host);
    ok = isPublicAddress(address);
  } catch (err) {
    // A name that does not resolve is not a target we can protect; let the
    // request proceed and fail at the socket level if it really is invalid.
    log.debug(`DNS: ${host} no resuelve (${err.code ?? err.message})`);
    ok = true;
  }
  dnsCache.set(host, { ok, at: Date.now() });
  return ok;
}

/**
 * Guards the /hls and /img proxies.
 *
 * Two policies:
 *  - "public"   (default) any public host may be fetched, but anything that
 *               resolves to a private, loopback or link-local address is
 *               refused. This keeps the LAN exposure safe while still
 *               following the CDN redirects that public IPTV streams use.
 *  - "playlist" only hosts present in the playlist, plus approved extras.
 */
export class HostGuard {
  constructor() {
    this.allowed = new Set(BUILTIN_HOSTS);
    this.blocked = new Map();
  }

  get policy() {
    return getConfig().proxy.policy ?? 'public';
  }

  addHost(host) {
    if (!host) return;
    this.allowed.add(host.toLowerCase());
  }

  addHosts(hosts) {
    for (const h of hosts ?? []) this.addHost(h);
  }

  /** Persisted extras from config.json. */
  loadConfigured() {
    const { proxy } = getConfig();
    this.addHosts(proxy.extraAllowedHosts);
    if (proxy.allowAnyHost) {
      log.warn('proxy.allowAnyHost = true: el proxy ya no restringe hosts. Úsalo solo en redes de confianza.');
    }
  }

  /** Approve a host discovered at runtime (e.g. a CDN redirect hop) and remember it. */
  approveHost(host, { persist = true } = {}) {
    if (!host) return;
    this.addHost(host);
    this.blocked.delete(host);
    if (persist) {
      const { proxy } = getConfig();
      const extra = new Set(proxy.extraAllowedHosts ?? []);
      extra.add(host);
      saveConfigPatch({ proxy: { extraAllowedHosts: [...extra] } });
      log.info(`Host aprobado para el proxy: ${host}`);
    }
  }

  /** @returns {Promise<{ok: boolean, host?: string, reason?: string}>} */
  async check(url) {
    const parsed = parseHttpUrl(url);
    if (!parsed) return { ok: false, reason: 'URL no válida o con protocolo no permitido' };

    const host = normalizeHost(parsed.hostname);
    if (isIP(host) && !isPublicAddress(host)) {
      return { ok: false, host, reason: `Dirección privada o reservada no permitida: ${host}` };
    }

    const { proxy } = getConfig();
    if (proxy.allowAnyHost) return { ok: true, host };
    if (this.policy === 'playlist' && !this.allowed.has(host)) {
      this.blocked.set(host, 'Host fuera de la lista de reproducción');
      return {
        ok: false,
        host,
        reason: `Host no permitido: ${host}. El stream redirigió fuera de la lista de la playlist.`,
      };
    }

    if (!(await resolvesToPublicAddress(host))) {
      return { ok: false, host, reason: `${host} resuelve a una dirección privada o reservada` };
    }

    return { ok: true, host };
  }
}

/** Builds browser-ish headers; many CDNs reject requests without a matching Referer/Origin. */
export function browserHeaders(targetUrl, extra = {}) {
  const url = parseHttpUrl(targetUrl);
  const { userAgent } = getConfig().proxy;
  const headers = {
    'User-Agent': userAgent,
    Accept: '*/*',
    'Accept-Language': 'es-CR,es;q=0.9,en;q=0.8',
    // Ask for the payload as-is: a transparent gunzip here would make the
    // upstream Content-Length wrong for the client we forward it to.
    'Accept-Encoding': 'identity',
    ...extra,
  };
  if (url) {
    const origin = `${url.protocol}//${url.host}`;
    if (!headers.Referer) headers.Referer = `${origin}/`;
    if (!headers.Origin) headers.Origin = origin;
  }
  return headers;
}

/**
 * Fetch following redirects manually so every hop can be validated by the
 * caller-supplied `validate` callback.
 *
 * @returns {Promise<{ response: Response, finalUrl: string, redirects: string[] }>}
 */
export async function fetchFollow(url, options = {}) {
  const {
    timeoutMs = 15000,
    maxRedirects = 5,
    validate = () => ({ ok: true }),
    headers: extraHeaders = {},
    ...rest
  } = options;

  let current = url;
  const redirects = [];

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // `validate` may be async because the host guard resolves DNS.
    const verdict = await validate(current);
    if (!verdict.ok) {
      const err = new Error(verdict.reason || 'Petición bloqueada por la política de hosts');
      err.code = 'EHOSTBLOCKED';
      err.host = verdict.host;
      err.url = current;
      throw err;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    for (const signal of [rest.signal].filter(Boolean)) signal.addEventListener('abort', onAbort, { once: true });

    let response;
    try {
      response = await fetch(current, {
        ...rest,
        headers: browserHeaders(current, extraHeaders),
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      for (const signal of [rest.signal].filter(Boolean)) signal.removeEventListener('abort', onAbort);
    }

    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      const next = new URL(response.headers.get('location'), current).href;
      // Drain so the socket can be reused.
      await response.body?.cancel().catch(() => {});
      redirects.push(next);
      log.debug(`redirect ${response.status} ${current} -> ${next}`);
      current = next;
      continue;
    }

    return { response, finalUrl: current, redirects };
  }

  const err = new Error(`Demasiadas redirecciones (${maxRedirects}) desde ${url}`);
  err.code = 'EMAXREDIRECT';
  throw err;
}

/** Read a response body as text with a hard size cap. */
export async function readTextCapped(response, maxBytes = 12 * 1024 * 1024) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/** Read at most `maxBytes` of a response body; used by the channel health check. */
export async function readPrefix(response, maxBytes) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      total += value.byteLength;
      if (total >= maxBytes) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

export const isAbortError = (err) => err?.name === 'AbortError' || err?.name === 'TimeoutError';
