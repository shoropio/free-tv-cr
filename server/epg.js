import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig, PATHS } from './config.js';
import { log } from './log.js';
import { fetchFollow } from './http-client.js';

const MAX_CACHE_ENTRIES = 12;

const cacheKey = (url) => createHash('sha1').update(url).digest('hex').slice(0, 16);

/* ------------------------------------------------------------------ *
 * XMLTV parsing
 * ------------------------------------------------------------------ */

const decodeEntities = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

const stripTags = (s) => s.replace(/<[^>]*>/g, '');

/** Extracts the text of the first `<tag ...>...</tag>` (or self-closed) occurrence. */
function tagText(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(xml);
  if (m) return decodeEntities(stripTags(m[1])).replace(/\s+/g, ' ').trim();
  const empty = new RegExp(`<${tag}(?:\\s[^>]*)?/>`, 'i').exec(xml);
  return empty ? '' : '';
}

const attr = (raw, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(raw);
  return m ? m[1] : '';
};

/** `20260926013500 +0000` -> epoch ms (also accepts 12-digit and missing offsets). */
export function parseXmltvTime(value) {
  if (!value) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(Z|UTC|([+-])(\d{2}):?(\d{2}))?/i.exec(value.trim());
  if (!m) {
    const fallback = Date.parse(value);
    return Number.isNaN(fallback) ? null : fallback;
  }
  const [, y, mo, d, h, mi, s, , sign, oh, om] = m;
  const base = Date.UTC(+y, +mo - 1, +d, +h, +mi, s ? +s : 0);
  if (!sign) return base;
  const offset = (+oh * 60 + +om) * 60000 * (sign === '+' ? 1 : -1);
  return base - offset;
}

const PLACEHOLDER_TITLE = /^\s*no data\s*$/i;

/**
 * Parses an XMLTV document into a channel map and a programme map.
 * @returns {{channels: Map<string, {id:string,name:string,icon?:string}>, programmes: Map<string, object[]>}}
 */
export function parseXmltv(xml) {
  const channels = new Map();
  for (const block of xml.match(/<channel\b[\s\S]*?<\/channel>/g) ?? []) {
    const id = decodeEntities(attr(block.slice(0, block.indexOf('>')), 'id'));
    if (!id) continue;
    // display-name is an element, not an attribute: <display-name>CR - Canal 1</display-name>
    const name = decodeEntities(stripTags(tagText(block, 'display-name'))).replace(/\s+/g, ' ').trim();
    const iconMatch = /<icon\b[^>]*\bsrc="([^"]*)"/i.exec(block);
    channels.set(id, { id, name, icon: iconMatch ? decodeEntities(iconMatch[1]) : '' });
  }

  const programmes = new Map();
  for (const block of xml.match(/<programme\b[\s\S]*?<\/programme>/g) ?? []) {
    const head = block.slice(0, block.indexOf('>'));
    const channelId = decodeEntities(attr(head, 'channel'));
    const start = parseXmltvTime(attr(head, 'start'));
    if (!channelId || start === null) continue;

    const title = tagText(block, 'title');
    // Some providers emit "No Data" placeholders covering the whole day.
    if (!title || PLACEHOLDER_TITLE.test(title)) continue;

    const stop = parseXmltvTime(attr(head, 'stop'));
    const entry = {
      start,
      stop: stop ?? start,
      title,
      desc: tagText(block, 'desc'),
      category: tagText(block, 'category'),
      episode: tagText(block, 'episode-num'),
    };
    if (!programmes.has(channelId)) programmes.set(channelId, []);
    programmes.get(channelId).push(entry);
  }

  // Channels left without a single real programme are not usable.
  for (const channelId of [...programmes.keys()]) {
    if (!programmes.get(channelId).length) programmes.delete(channelId);
  }

  for (const list of programmes.values()) list.sort((a, b) => a.start - b.start);
  return { channels, programmes };
}

/* ------------------------------------------------------------------ *
 * Channel matching
 * ------------------------------------------------------------------ */

/** Words that carry no identity, dropped before comparing channel names. */
const STOP_WORDS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'e', 'en', 'con', 'para', 'por',
  'costa', 'rica', 'centroamerica', 'latino', 'america', 'the', 'of', 'y', 'and',
  'television', 'televisions', 'channel', 'tv', 'hd', 'sd', 'uhd', 'fhd', 'oficial', 'live',
]);

const COUNTRY_SUFFIX = /\.(cr|gl|ar|co|ve|pe|cl|ec|bo|uy|py|br|pa|ni|hn|gt|sv|mx|do|pr|es|us)$/i;
const LEAD_LABEL = /^\s*(cr|gt|hn|sv|ni|pa|mx|do|pr|es|us|la)\s*[-–—:]\s*/i;

/**
 * Canonical form of a channel identifier or display name, used for matching.
 *   "Canal 1 (Costa Rica)"  -> "canal1"
 *   "CR - Canal 1"          -> "canal1"
 *   "Canal1.cr@HD"          -> "canal1"
 */
export function normalizeId(value) {
  let s = String(value ?? '');
  s = s.split('@')[0]; // tvg quality tag
  s = s.replace(COUNTRY_SUFFIX, '');
  s = s.replace(/\([^()]*\)/g, ' '); // (Costa Rica), (720p), (Not 24/7)
  s = s.replace(LEAD_LABEL, '');
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !STOP_WORDS.has(word))
    .join('');
}

/** Splits a normalized key into alpha/digit segments: "canal11" -> ["canal","11"]. */
const segments = (key) => key.match(/[a-z]+|\d+/g) ?? [];

/** Blended similarity in [0,1] combining key identity and token overlap. */
export function similarity(a, b) {
  const ka = normalizeId(a);
  const kb = normalizeId(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;

  const segmentScore = (() => {
    const sa = segments(ka);
    const sb = segments(kb);
    if (sa.length !== sb.length) return 0;
    // A difference in a numeric part means a different channel number:
    // "canal1" must never match "canal11".
    if (sa.some((part, i) => /^\d/.test(part) && part !== sb[i])) return 0;
    const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
    // Only a trailing-letter difference counts, and only when the shorter key
    // covers most of the longer one: "tigosport" ~ "tigosports" (0.90) but
    // "enlace" vs "enlacejuvenil" (46%) must not match.
    if (short.length >= 5 && long.startsWith(short) && short.length / long.length >= 0.8) return 0.9;
    return 0;
  })();

  const tokensA = new Set(ka.match(/[a-z]+|\d+/g) ?? []);
  const tokensB = new Set(kb.match(/[a-z]+|\d+/g) ?? []);
  let tokenScore = 0;
  if (tokensA.size && tokensB.size) {
    let shared = 0;
    for (const t of tokensA) if (tokensB.has(t)) shared += 1;
    const jaccard = shared / (tokensA.size + tokensB.size - shared);
    const [small, large] = tokensA.size <= tokensB.size ? [tokensA, tokensB] : [tokensB, tokensA];
    let smallShared = 0;
    for (const t of small) if (large.has(t)) smallShared += 1;
    tokenScore = Math.max(jaccard, (smallShared / small.size) * 0.9);
  }

  return Math.max(segmentScore, tokenScore);
}

/* ------------------------------------------------------------------ *
 * Source fetching + cache
 * ------------------------------------------------------------------ */

function cachePaths(url) {
  const key = cacheKey(url);
  return { data: join(PATHS.epgCache, `${key}.xml`), meta: join(PATHS.epgCache, `${key}.meta.json`) };
}

function readCache(url, maxAgeMs) {
  const { data, meta } = cachePaths(url);
  if (!existsSync(data) || !existsSync(meta)) return null;
  try {
    const info = JSON.parse(readFileSync(meta, 'utf8'));
    if (Date.now() - info.fetchedAt > maxAgeMs) return null;
    return { xml: readFileSync(data, 'utf8'), fetchedAt: info.fetchedAt, url: info.url, fromCache: true };
  } catch (err) {
    log.warn(`Caché EPG ilegible para ${url}: ${err.message}`);
    return null;
  }
}

function writeCache(url, xml, fetchedAt) {
  try {
    mkdirSync(PATHS.epgCache, { recursive: true });
    const { data, meta } = cachePaths(url);
    writeFileSync(data, xml, 'utf8');
    writeFileSync(meta, JSON.stringify({ url, fetchedAt, bytes: xml.length }, null, 2), 'utf8');
    pruneCache();
  } catch (err) {
    log.warn(`No se pudo escribir la caché EPG: ${err.message}`);
  }
}

function pruneCache() {
  try {
    const metas = readdirSync(PATHS.epgCache)
      .filter((f) => f.endsWith('.meta.json'))
      .map((f) => ({ f, at: JSON.parse(readFileSync(join(PATHS.epgCache, f), 'utf8')).fetchedAt ?? 0 }))
      .sort((a, b) => b.at - a.at);
    for (const { f } of metas.slice(MAX_CACHE_ENTRIES)) {
      unlinkSync(join(PATHS.epgCache, f));
      unlinkSync(join(PATHS.epgCache, f.replace('.meta.json', '.xml')));
    }
  } catch {
    /* pruning is best-effort */
  }
}

async function loadSource(source, maxAgeMs) {
  const cached = readCache(source.url, maxAgeMs);
  if (cached) {
    log.debug(`EPG "${source.name}" servido desde caché`);
    return cached;
  }
  log.info(`Descargando EPG "${source.name}"…`);
  const { response } = await fetchFollow(source.url, { timeoutMs: 30000, headers: { Accept: '*/*' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  // Read raw bytes: the source is gzip-compressed, and decoding to text first
  // would destroy the gzip magic number.
  const buffer = Buffer.from(await response.arrayBuffer());
  const looksGzipped = buffer[0] === 0x1f && buffer[1] === 0x8b;
  const xml = (looksGzipped ? gunzipSync(buffer) : buffer).toString('utf8');
  if (!xml.includes('<tv')) throw new Error('la respuesta no parece un XMLTV válido');
  const fetchedAt = Date.now();
  writeCache(source.url, xml, fetchedAt);
  return { xml, fetchedAt, url: source.url, fromCache: false };
}

/* ------------------------------------------------------------------ *
 * Guide service
 * ------------------------------------------------------------------ */

export class Guide {
  constructor() {
    this.sources = [];
    this.matches = new Map(); // channelId -> { epgId, name, source, score }
    this.ready = false;
    this.loading = null;
    this.status = { state: 'idle', message: '', updatedAt: null, sources: [] };
  }

  get loaded() {
    return this.ready && this.sources.length > 0;
  }

  /** Loads every configured source, tolerating individual failures. */
  async load({ force = false } = {}) {
    if (this.loading) return this.loading;
    const { epg } = getConfig();
    const maxAge = force ? 0 : epg.cacheHours * 3600_000;
    const sources = epg.sources.filter((s) => s && s.url);

    this.loading = (async () => {
      this.status = { ...this.status, state: 'loading', message: 'Actualizando guía…' };
      const loaded = [];
      const errors = [];

      for (const source of sources) {
        try {
          const data = await loadSource(source, maxAge);
          const parsed = parseXmltv(data.xml);
          const total = [...parsed.programmes.values()].reduce((n, l) => n + l.length, 0);
          const window = windowOf(parsed.programmes);
          if (total === 0) throw new Error('la guía no contiene programas');
          loaded.push({ ...source, ...parsed, fetchedAt: data.fetchedAt, fromCache: data.fromCache, total, window });
          log.info(
            `EPG "${source.name}": ${parsed.channels.size} canales, ${total} programas, ` +
              `${window ? `${new Date(window.from).toISOString().slice(0, 10)} → ${new Date(window.to).toISOString().slice(0, 10)}` : 'sin fechas'}`,
          );
        } catch (err) {
          errors.push(`${source.name}: ${err.message}`);
          log.error(`EPG "${source.name}" falló: ${err.message}`);
        }
      }

      this.sources = loaded;
      this.ready = true;
      this.status = {
        state: loaded.length ? 'ready' : 'error',
        message: loaded.length
          ? errors.length
            ? `Carga parcial: ${errors.join('; ')}`
            : 'Guía lista'
          : `Sin guía disponible: ${errors.join('; ')}`,
        updatedAt: loaded[0]?.fetchedAt ?? null,
        sources: loaded.map((s) => ({
          name: s.name,
          url: s.url,
          channels: s.channels.size,
          programmes: s.total,
          fromCache: s.fromCache,
          window: s.window,
        })),
      };
      return this.status;
    })().finally(() => {
      this.loading = null;
    });

    return this.loading;
  }

  /** Links playlist channels to EPG channels: exact id → normalised id → name → fuzzy. */
  matchChannels(channels) {
    const { epg } = getConfig();
    this.matches = new Map();
    if (!this.sources.length) return this.matches;

    const byNormId = new Map();
    const byNormName = new Map();
    for (const source of this.sources) {
      for (const channel of source.channels.values()) {
        // Only channels that actually have listings can be matched usefully.
        if (!source.programmes.get(channel.id)?.length) continue;
        for (const key of [normalizeId(channel.id), normalizeId(channel.name)]) {
          if (!key) continue;
          if (!byNormId.has(key)) byNormId.set(key, channel);
          if (!byNormName.has(key)) byNormName.set(key, channel);
        }
      }
    }

    for (const channel of channels) {
      const direct = this.sources
        .map((s) => s.channels.get(channel.tvgId) ?? s.channels.get(channel.id))
        .find(Boolean);
      if (direct) {
        this.matches.set(channel.id, { epgId: direct.id, name: direct.name, source: 'id', score: 1 });
        continue;
      }

      const normalized = normalizeId(channel.tvgId || channel.name);
      const candidate = byNormId.get(normalized) ?? byNormName.get(normalized) ?? byNormName.get(normalizeId(channel.name));
      if (candidate) {
        this.matches.set(channel.id, { epgId: candidate.id, name: candidate.name, source: 'normalized', score: 1 });
        continue;
      }

      if (!epg.fuzzyMatch) continue;

      // Rank every candidate, then accept only a clear winner. Without this
      // guard "Canal 1" would happily bind to "Canal 4" just because both start
      // with the same word.
      const ranked = [];
      for (const source of this.sources) {
        for (const epgChannel of source.channels.values()) {
          if (!source.programmes.get(epgChannel.id)?.length) continue;
          const score = Math.max(
            similarity(channel.name, epgChannel.name),
            similarity(channel.tvgId, epgChannel.id),
          );
          if (score >= epg.minFuzzyScore) ranked.push({ channel: epgChannel, score });
        }
      }
      if (!ranked.length) continue;

      ranked.sort((a, b) => b.score - a.score);
      const [top, runnerUp] = ranked;
      if (runnerUp && top.score - runnerUp.score < 0.05) {
        log.debug(`Guía: "${channel.name}" es ambiguo entre ${top.channel.id} y ${runnerUp.channel.id}; se omite.`);
        continue;
      }
      this.matches.set(channel.id, {
        epgId: top.channel.id,
        name: top.channel.name,
        source: 'fuzzy',
        score: Number(top.score.toFixed(3)),
      });
    }

    const matched = this.matches.size;
    log.info(`Guía enlazada con ${matched}/${channels.length} canales`);
    return this.matches;
  }

  find(source, epgId, now) {
    const list = source.programmes.get(epgId);
    if (!list?.length) return { now: null, next: null, upcoming: [] };
    let index = -1;
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].start <= now) {
        index = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const current = index >= 0 ? list[index] : null;
    const next = index >= 0 ? list[index + 1] : list[0];
    const upcoming = list.slice(Math.max(index, 0), Math.max(index, 0) + 24);
    return { now: current, next, upcoming };
  }

  /** Now/next snapshot for every requested channel id. */
  snapshot(channelIds, now = Date.now()) {
    const out = {};
    for (const id of channelIds) {
      const match = this.matches.get(id);
      if (!match) {
        out[id] = { matched: false };
        continue;
      }
      const source = this.sources.find((s) => s.channels.has(match.epgId));
      if (!source) {
        out[id] = { matched: false };
        continue;
      }
      const { now: current, next } = this.find(source, match.epgId, now);
      out[id] = {
        matched: true,
        epgId: match.epgId,
        epgName: match.name,
        matchSource: match.source,
        now: current,
        next,
      };
    }
    return out;
  }

  /** Full programme timeline for one playlist channel. */
  timeline(channelId) {
    const match = this.matches.get(channelId);
    if (!match) return { matched: false, programmes: [] };
    const source = this.sources.find((s) => s.channels.has(match.epgId));
    if (!source) return { matched: false, programmes: [] };
    return { matched: true, epgName: match.name, programmes: source.programmes.get(match.epgId) ?? [] };
  }
}

function windowOf(programmes) {
  let min = Infinity;
  let max = -Infinity;
  for (const list of programmes.values()) {
    for (const p of list) {
      if (p.start < min) min = p.start;
      if (p.stop > max) max = p.stop;
    }
  }
  return Number.isFinite(min) ? { from: min, to: max } : null;
}
